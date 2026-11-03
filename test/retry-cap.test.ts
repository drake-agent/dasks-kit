import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { task, tempRepo } from './helpers.ts';
import { asHuman, humanSecrets, serve } from './state-support.ts';

const card = '/api/tasks/beta.t-smpl';
const failure = { state: 'failed', note: '실행 실패', evidence: ['run/test.log'] };

for (const cap of [1, 2, 3]) {
  test(`retry cap fires exactly at ${cap} failed claim runs, and refuses nine dispatches`, async () => {
    const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
    try {
      const cfg = path.join(root, 'test-config.json');
      fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), retry_cap: cap }));
      for (let n = 1; n <= cap; n++) {
        const claim = await s.post(card + '/claim', { who: 'sync' }); assert.equal(claim.status, 200);
        const run = await claim.json(); assert.ok(run.run_id); assert.equal(Number(run.attempt), n);
        const response = await s.post(card + '/outcome', { ...failure, run_id: run.run_id, attempt: n });
        assert.equal(response.status, 200); const got = await response.json();
        assert.equal(got.status, n === cap ? 'blocked-on-user' : 'todo');
        assert.equal(got.lane, n === cap ? 'failed-terminal' : 'none');
        if (n === cap) { assert.equal(got.next_owner, 'beta-lead'); assert.match(got.needs_user, /^retry cap reached after /); }
      }
      const before = await (await fetch(s.url + card)).json();
      for (let n = cap; n < 9; n++) {
        const refused = await s.post(card + '/claim', { who: 'sync', force: true });
        assert.equal(refused.status, 409); assert.equal((await refused.json()).rule, 'retry-cap');
      }
      for (const patch of [{ status: 'todo', reopen: true }, { status: 'doing' }, { lane: 'none' }, { status: 'done', result: 'RESULT.md' }]) {
        const refused = await s.post(card, patch); assert.equal(refused.status, 409); assert.equal((await refused.json()).rule, 'retry-cap');
      }
      for (const [suffix, body] of [['/release', { who: 'sync', force: true }], ['/finish', { result: 'RESULT.md', force: true }]] as const) {
        const refused = await s.post(card + suffix, body); assert.equal(refused.status, 409); assert.equal((await refused.json()).rule, 'retry-cap');
      }
      const after = await (await fetch(s.url + card)).json(); assert.equal(after.version, before.version); assert.equal(after.lane, 'failed-terminal');
      assert.equal(after.outcomes.length, cap); assert.equal(after.routes.at(-1).kind, 'failed-terminal');
    } finally { await s.stop(); cleanup(); }
  });
}

for (const cap of [1, 2, 3]) {
  test(`run-less outcome-or-fail reaches cap ${cap} and refuses later dispatches`, async () => {
    const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
    try {
      const cfg = path.join(root, 'test-config.json');
      fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), retry_cap: cap }));
      for (let n = 1; n <= cap; n++) {
        const claim = await s.post(card + '/claim', { who: 'sync' }); assert.equal(claim.status, 200);
        const run = await claim.json(); assert.ok(run.run_id); assert.equal(Number(run.attempt), n);
        const input = { job: `run-${n}`, log: 'run/job.log' };
        const response = await s.post(card + '/outcome-or-fail', input); assert.equal(response.status, 200);
        const stored = await response.json();
        assert.equal(stored.status, n === cap ? 'blocked-on-user' : 'todo');
        assert.equal(stored.lane, n === cap ? 'failed-terminal' : 'none');
        const replay = await s.post(card + '/outcome-or-fail', input); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), stored);
        if (n === cap) { assert.equal(stored.next_owner, 'beta-lead'); assert.match(stored.needs_user, /^retry cap reached after /); }
      }
      const before = await (await fetch(s.url + card)).json();
      for (let n = cap; n < 9; n++) {
        const refused = await s.post(card + '/claim', { who: 'sync', force: true });
        assert.equal(refused.status, 409); assert.equal((await refused.json()).rule, 'retry-cap');
      }
      const after = await (await fetch(s.url + card)).json();
      assert.equal(after.version, before.version); assert.equal(after.outcomes.length, cap); assert.equal(after.routes.length, cap);
      assert.equal(after.activity.filter((a: { action: string }) => a.action === 'outcome').length, cap);
    } finally { await s.stop(); cleanup(); }
  });
}

test('reset requires authorized actor and a one-line reason, logs activity, and fences the previous epoch', async () => {
  const { root, cleanup } = tempRepo([task()]); const h = humanSecrets(); const s = await serve(root, h.env);
  try {
    let old;
    for (let n = 1; n <= 2; n++) {
      old = await (await s.post(card + '/claim', { who: 'sync' })).json();
      assert.equal((await s.post(card + '/outcome', { ...failure, run_id: old.run_id, attempt: n })).status, 200);
    }
    assert.equal((await s.post(card + '/reset-attempts', { reason: '재시도 승인' }, 'sync')).status, 403);
    assert.equal((await s.post(card + '/reset-attempts', { reason: 'two\nlines' }, 'beta-lead')).status, 400);
    assert.equal((await s.post(card + '/reset-attempts', { reason: '다른 담당자' }, 'alpha-lead')).status, 403);
    const reset = await s.post(card + '/reset-attempts', { reason: '원인 수정 후 재시도 승인' }, 'beta-lead');
    assert.equal(reset.status, 200); const cleared = await reset.json();
    assert.equal(cleared.status, 'todo'); assert.notEqual(cleared.lane, 'failed-terminal'); assert.equal(Number(cleared.reset_epoch), 1); assert.equal(Number(cleared.attempt || 0), 0);
    const run = await (await s.post(card + '/claim', { who: 'sync' })).json();
    assert.equal(Number(run.attempt), 1); assert.notEqual(run.run_id, old.run_id);
    const stale = await s.post(card + '/outcome', { ...failure, run_id: old.run_id, attempt: 2 });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).rule, 'stale-outcome');
    assert.equal((await s.post(card + '/outcome', { ...failure, run_id: run.run_id, attempt: 1 })).status, 200);
    const got = await (await fetch(s.url + card)).json(); assert.equal(got.status, 'todo'); assert.equal(got.outcomes.length, 3);
    assert.equal(got.activity.filter((a: { action: string }) => a.action === 'reset-attempts').length, 1);
    assert.ok(got.activity.some((a: { note?: string }) => a.note?.includes('원인 수정 후 재시도 승인')));
    assert.equal((await s.post(card + '/reset-attempts', { reason: '담당자 승인' }, 'beta-lead')).status, 200);
    // "user" is the logged-in human (session + CSRF); an unauthenticated "user" header is refused.
    const anon = await fetch(s.url + card + '/reset-attempts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'user', Origin: s.url }, body: JSON.stringify({ reason: '사용자 재시도 승인' }) });
    assert.equal(anon.status, 401);
    const human = await asHuman(s.url, card + '/reset-attempts', { reason: '사용자 재시도 승인' });
    assert.equal(human.status, 200, JSON.stringify(human.json));
  } finally { await s.stop(); cleanup(); h.cleanup(); }
});

test('successful runs increase attempt but do not consume the failure cap', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    for (let n = 1; n <= 3; n++) {
      const run = await (await s.post(card + '/claim', { who: 'sync', force: true })).json(); assert.equal(Number(run.attempt), n);
      assert.equal((await s.post(card + '/outcome', { state: 'done', note: '완료 확인', evidence: ['RESULT.md'], run_id: run.run_id, attempt: n })).status, 200);
    }
    assert.equal((await s.post(card + '/claim', { who: 'sync', force: true })).status, 200);
  } finally { await s.stop(); cleanup(); }
});

test('run expiry uses the same ledger and cap, and a duplicate expiry replays', async () => {
  const { updateTask, readTask } = await import('../src/lib/write.ts');
  const { recordRunEnd, taskOutcomes } = await import('../src/lib/outcome.ts');
  const { root, cleanup } = tempRepo([task()]);
  try {
    for (let n = 1; n <= 2; n++) {
      const claimed = updateTask(root, 'beta.t-smpl', {}, 'sync', { claim: { op: 'claim', who: 'sync' } });
      if (!claimed.run_id) assert.fail('claim must issue a run_id');
      const run = { id: claimed.id, run_id: claimed.run_id, attempt: Number(claimed.attempt) };
      const first = recordRunEnd(root, run, 'expired');
      const replay = recordRunEnd(root, run, 'expired');
      assert.equal(replay.version, first.version); assert.equal(first.status, n === 2 ? 'blocked-on-user' : 'todo');
    }
    assert.equal(taskOutcomes(root, 'beta.t-smpl').length, 2);
    assert.equal(readTask(root, 'beta.t-smpl').lane, 'failed-terminal');
  } finally { cleanup(); }
});

for (const entry of ['patch', 'create']) {
  test(`clients cannot enter the server-owned failed-terminal lane through ${entry}`, async () => {
    const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
    try {
      const before = await (await fetch(s.url + card)).json();
      const response = entry === 'patch'
        ? await s.post(card, { lane: 'failed-terminal', status: 'blocked-on-user', needs_user: '직접 설정할까요? OK하면 설정돼요.' })
        : await s.post('/api/tasks', { goal: 'beta', id: 'beta.t-forgd', title: 'Forged terminal', lane: 'failed-terminal', status: 'blocked-on-user', needs_user: '직접 생성 시도' });
      assert.equal(response.status, 409); assert.equal((await response.json()).rule, 'retry-cap');
      const after = await (await fetch(s.url + card)).json();
      assert.equal(after.version, before.version); assert.equal(after.lane, 'none'); assert.equal(after.outcomes.length, 0);
      assert.equal((await fetch(s.url + '/api/tasks/beta.t-forgd')).status, 404);
    } finally { await s.stop(); cleanup(); }
  });
}
