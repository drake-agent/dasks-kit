import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

test('outcome validates, persists once per job and returns latest handoff through GET', async () => {
  const { root, cleanup } = tempRepo([task({ status: 'doing' })]); const s = await serve(root);
  try {
    const route = '/api/tasks/beta.t-smpl/outcome';
    for (const body of [{ state: 'done', note: '완료' }, { state: 'needs-review', note: '검토' }, { state: 'failed', note: '실패\n다음' }, { state: 'failed', note: '실패', job: {} }, { state: 'failed', note: '실패', handoff: 'x\n'.repeat(41) }]) assert.equal((await s.post(route, body)).status, 400);
    const handoff = 'Done: 구현\nWhere: src\nEvidence: RESULT.md\nNext: 검토\nQuestions: 없음';
    let r = await s.post(route, { state: 'needs-review', note: '구현 검토 필요', evidence: ['RESULT.md'], job: 'job-1', handoff });
    assert.equal(r.status, 200, await r.text());
    assert.equal((await s.post(route, { state: 'failed', note: '중복', job: 'job-1' })).status, 409);
    let got = await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json();
    assert.equal(got.status, 'review'); assert.equal(got.outcomes.length, 1); assert.equal(got.handoff, handoff);
    assert.match(got.body, /## Handoff/);
    r = await s.post(route, { state: 'done', note: '검토 완료', evidence: ['run/build.log'], job: 'job-2', handoff: '다음 단계 없음' });
    assert.equal(r.status, 200);
    got = await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json();
    assert.equal(got.handoff, '다음 단계 없음'); assert.equal(got.body.match(/## Handoff/g).length, 1);
    assert.equal(got.outcomes.length, 2);
  } finally { await s.stop(); cleanup(); }
});
test('real CLI repeated evidence and missing-outcome failure are idempotent', async () => {
  const { root, cleanup } = tempRepo([task({ status: 'doing' }), task({ id: 'beta.t-msng', status: 'doing' })]); const s = await serve(root);
  const cli = (...args: string[]) => execFileSync(process.execPath, [path.resolve('bin/dasks-outcome'), ...args], { env: { ...process.env, DASKS_URL: s.url, DASKS_RUN_ID: '', DASKS_ATTEMPT: '' }, encoding: 'utf8' });
  try {
    const handoff = path.join(root, 'HANDOFF.md'); fs.writeFileSync(handoff, '다음 검토');
    cli('outcome', 'beta.t-smpl', 'done', '--note', '구현 완료', '--evidence', 'RESULT.md', '--evidence', 'run/test.log', '--job', 'cli-job', '--handoff-file', handoff);
    cli('outcome-or-fail', 'beta.t-smpl', '--job', 'cli-job', '--log', 'run/error.log');
    cli('outcome-or-fail', 'beta.t-msng', '--job', 'missing-job', '--log', 'run/error.log');
    cli('outcome-or-fail', 'beta.t-msng', '--job', 'missing-job', '--log', 'run/error.log');
    const got = await (await fetch(s.url + '/api/tasks/beta.t-msng')).json();
    assert.equal(got.status, 'todo'); assert.equal(got.outcomes.length, 1); assert.equal(got.outcomes[0].note, 'ended without a result'); assert.deepEqual(got.outcomes[0].evidence, ['run/error.log']);
    const complete = await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json(); assert.deepEqual(complete.outcomes[0].evidence, ['RESULT.md', 'run/test.log']);
  } finally { await s.stop(); cleanup(); }
});

test('job uniqueness spans cards, concurrent requests and restart; markdown handoff retains headings', async () => {
  const { root, cleanup } = tempRepo([task({ status: 'doing' }), task({ id: 'beta.t-secnd', status: 'doing' })]); let s = await serve(root);
  try {
    const input = { state: 'needs-review', note: '검토 요청', evidence: ['RESULT.md'], job: 'global-job', handoff: '## Done\n완료\n## Next\n검토' };
    const replies = await Promise.all([s.post('/api/tasks/beta.t-smpl/outcome', input), s.post('/api/tasks/beta.t-smpl/outcome', input)]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 200]);
    assert.equal((await s.post('/api/tasks/beta.t-secnd/outcome', input)).status, 409);
    let got = await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json(); assert.equal(got.handoff, input.handoff);
    await s.stop(); s = await serve(root);
    assert.equal((await s.post('/api/tasks/beta.t-smpl/outcome', input)).status, 200);
    assert.equal((await s.post('/api/tasks/beta.t-smpl/outcome', { ...input, job: 'next-job', handoff: '새 인수인계' })).status, 200);
    got = await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json(); assert.equal(got.handoff, '새 인수인계'); assert.ok(!got.body.includes('## Done'));
  } finally { await s.stop(); cleanup(); }
});

test('missing-outcome accepts ordinary log filenames and remains a one-time fallback', async () => {
  const { root, cleanup } = tempRepo([task({ status: 'doing' }), task({ id: 'beta.t-stdo', status: 'doing' })]); const s = await serve(root);
  try {
    for (const [id, log] of [['smpl', 'nohup.out'], ['stdo', 'worker.stdout']]) {
      const route = `/api/tasks/beta.t-${id}/outcome-or-fail`;
      assert.equal((await s.post(route, { job: `log-${id}`, log })).status, 200);
      assert.equal((await s.post(route, { job: `log-${id}`, log })).status, 200);
      const got = await (await fetch(s.url + `/api/tasks/beta.t-${id}`)).json(); assert.equal(got.status, 'todo'); assert.equal(got.outcomes.length, 1); assert.deepEqual(got.outcomes[0].evidence, [log]);
    }
    assert.equal((await s.post('/api/tasks/beta.t-smpl/outcome-or-fail', { job: 'invalid-log', log: 'a\nb' })).status, 400);
  } finally { await s.stop(); cleanup(); }
});

for (const started_at of ['', '2099-01-01T00:00:00+09:00']) {
  test(`wrapper preserves a CLI outcome without --job for ${started_at ? 'a started run' : 'a run with no start time'}`, async () => {
    const { root, cleanup } = tempRepo([task({ status: 'doing', started_at })]); const s = await serve(root);
    const cli = (...args: string[]) => execFileSync(process.execPath, [path.resolve('bin/dasks-outcome'), ...args], { env: { ...process.env, DASKS_URL: s.url, DASKS_RUN_ID: '', DASKS_ATTEMPT: '' }, encoding: 'utf8' });
    const get = async () => (await fetch(s.url + '/api/tasks/beta.t-smpl')).json();
    try {
      cli('outcome', 'beta.t-smpl', 'needs-review', '--note', '구현 검토 필요', '--evidence', 'RESULT.md');
      assert.equal((await s.post('/api/tasks/beta.t-smpl', { title: 'Updated after handoff' })).status, 200);
      const before = await get();
      cli('outcome-or-fail', 'beta.t-smpl', '--job', 'job-123', '--log', 'run/job.log');
      cli('outcome-or-fail', 'beta.t-smpl', '--job', 'job-123', '--log', 'run/job.log');
      const after = await get();
      assert.equal(after.status, 'review');
      assert.equal(after.next_owner, 'reviewer');
      assert.equal(after.version, before.version);
      assert.equal(after.outcomes.length, 1);
      assert.equal(after.routes.length, 1);
      assert.equal(after.outcomes[0].state, 'needs-review');
      assert.equal((await s.post('/api/tasks/beta.t-smpl/outcome', { state: 'failed', note: '중복 결과', job: after.outcomes[0].job })).status, 409);

      assert.equal((await s.post('/api/tasks/beta.t-smpl/claim', { who: 'sync' })).status, 200);
      const claimed = await get();
      assert.ok(claimed.started_at);
      assert.notEqual(claimed.started_at, started_at);
      cli('outcome-or-fail', 'beta.t-smpl', '--job', 'next-job', '--log', 'run/next.log');
      const failed = await get();
      assert.equal(failed.status, 'todo');
      assert.equal(failed.next_owner, 'fix');
      assert.deepEqual(failed.outcomes.map((o: { state: string }) => o.state).sort(), ['failed', 'needs-review']);
    } finally { await s.stop(); cleanup(); }
  });
}
