import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { statusMoves, task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

const card = '/api/tasks/beta.t-smpl';
const review = { state: 'needs-review', note: '구현 검토 요청', evidence: ['RESULT.md'], handoff: '다음 검토' };
const head = (root: string) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

test('same run and payload replays stored result across metadata edits and restart; conflict changes nothing', async () => {
  const { root, cleanup } = tempRepo([task()]); let s = await serve(root);
  try {
    const run = await (await s.post(card + '/claim', { who: 'sync' })).json(); assert.ok(run.run_id);
    const input = { ...review, run_id: run.run_id, attempt: Number(run.attempt), job: 'job-a' };
    const first = await s.post(card + '/outcome', input); assert.equal(first.status, 200); const stored = await first.json();
    assert.equal((await s.post(card, { title: 'Metadata after outcome' })).status, 200);
    const before = head(root);
    await s.stop(); s = await serve(root);
    const duplicate = await s.post(card + '/outcome', { ...input, expected_version: 0 });
    assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), stored); assert.equal(head(root), before);
    for (const patch of [{ note: '다른 결과' }, { state: 'failed' }, { evidence: ['run/other.log'] }, { handoff: '다른 인계' }]) {
      const conflict = await s.post(card + '/outcome', { ...input, ...patch });
      assert.equal(conflict.status, 409); assert.equal((await conflict.json()).rule, 'outcome-conflict'); assert.equal(head(root), before);
    }
    const got = await (await fetch(s.url + card)).json(); assert.equal(got.outcomes.length, 1); assert.equal(got.routes.length, 1);
    assert.equal(got.activity.filter((a: { action: string }) => a.action === 'outcome').length, 1);
    assert.equal(statusMoves(root, 'beta.t-smpl'), 2);
  } finally { await s.stop(); cleanup(); }
});

test('late, forged and out-of-order identities cannot overwrite a newer run', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const first = await (await s.post(card + '/claim', { who: 'sync' })).json();
    const second = await (await s.post(card + '/claim', { who: 'job-runner', force: true })).json();
    assert.ok(first.run_id); assert.notEqual(first.run_id, second.run_id); assert.equal(Number(second.attempt), 2);
    assert.ok(Date.parse(second.started_at) > Date.parse(first.started_at));
    const before = head(root);
    for (const key of [{ run_id: first.run_id, attempt: 1 }, { run_id: second.run_id, attempt: 1 }, { run_id: 'invented', attempt: 2 }]) {
      const refused = await s.post(card + '/outcome', { ...review, ...key });
      assert.equal(refused.status, 409); assert.equal((await refused.json()).rule, 'stale-outcome'); assert.equal(head(root), before);
    }
    assert.equal((await s.post(card + '/outcome', { ...review, run_id: second.run_id, attempt: 2 })).status, 200);
    assert.equal((await s.post(card + '/outcome', { ...review, run_id: first.run_id, attempt: 1 })).status, 409);
    assert.equal((await s.post(card, { run_id: 'forged' })).status, 400);
    assert.equal((await s.post(card + '/claim', { who: 'sync', attempt: 90 })).status, 400);
  } finally { await s.stop(); cleanup(); }
});

test('run-less outcomes bind to each claimed run, replay once and reject changed payloads', async () => {
  for (const key of [{}, { job: 'claimed-job' }]) {
    const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const claim = await s.post(card + '/claim', { who: 'sync' }); assert.equal(claim.status, 200);
        const run = await claim.json(); assert.ok(run.run_id); assert.equal(Number(run.attempt), attempt);
        const input = { ...review, ...key };
        const first = await s.post(card + '/outcome', input); assert.equal(first.status, 200);
        const stored = await first.json(); assert.equal(stored.status, 'review');
        const before = head(root);
        const replay = await s.post(card + '/outcome', input); assert.equal(replay.status, 200);
        assert.deepEqual(await replay.json(), stored); assert.equal(head(root), before);
        const conflict = await s.post(card + '/outcome', { ...input, note: '다른 결과' });
        assert.equal(conflict.status, 409); assert.equal((await conflict.json()).rule, 'outcome-conflict'); assert.equal(head(root), before);
        const got = await (await fetch(s.url + card)).json();
        assert.equal(got.outcomes.length, attempt); assert.equal(got.routes.length, attempt);
        assert.ok(got.outcomes.some((o: { run_id: string; attempt: number }) => o.run_id === run.run_id && o.attempt === attempt));
        assert.equal(got.activity.filter((a: { action: string }) => a.action === 'outcome').length, attempt);
        assert.equal(statusMoves(root, 'beta.t-smpl'), attempt * 2);
      }
      assert.equal((await s.post(card + '/reset-attempts', { reason: '새 실행 승인' }, 'beta-lead')).status, 200);
      const before = head(root);
      const stale = await s.post(card + '/outcome', review);
      assert.equal(stale.status, 409); assert.equal((await stale.json()).rule, 'stale-outcome'); assert.equal(head(root), before);
      assert.equal((await s.post(card + '/claim', { who: 'sync' })).status, 200);
      assert.equal((await s.post(card + '/outcome', review)).status, 200);
    } finally { await s.stop(); cleanup(); }
  }
});

test('same-holder doing reclaims preserve the launched run, including forced retries', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const first = await (await s.post(card + '/claim', { who: 'sync' })).json(); assert.ok(first.run_id);
    for (const force of [false, true]) {
      const response = await s.post(card + '/claim', { who: 'sync', force }); assert.equal(response.status, 200);
      const retried = await response.json();
      assert.equal(retried.run_id, first.run_id); assert.equal(retried.attempt, first.attempt); assert.equal(retried.started_at, first.started_at);
    }
    const outcome = await s.post(card + '/outcome', { ...review, run_id: first.run_id, attempt: Number(first.attempt) });
    assert.equal(outcome.status, 200); assert.equal((await outcome.json()).status, 'review');
  } finally { await s.stop(); cleanup(); }
});

test('two independent server processes race through the repo file lock with exactly one transition', async () => {
  const { root, cleanup } = tempRepo([task()]); const a = await serve(root); const b = await serve(root);
  try {
    const run = await (await a.post(card + '/claim', { who: 'sync' })).json(); assert.ok(run.run_id);
    const input = { ...review, run_id: run.run_id, attempt: Number(run.attempt) };
    const replies = await Promise.all([a.post(card + '/outcome', input), b.post(card + '/outcome', input)]);
    assert.deepEqual(replies.map((r) => r.status), [200, 200]); assert.deepEqual(await replies[0].json(), await replies[1].json());
    const got = await (await fetch(a.url + card)).json(); assert.equal(got.outcomes.length, 1); assert.equal(got.routes.length, 1);
    assert.equal(got.activity.filter((x: { action: string }) => x.action === 'outcome').length, 1);
    assert.equal(statusMoves(root, 'beta.t-smpl'), 2);
  } finally { await a.stop(); await b.stop(); cleanup(); }
});

test('a card started without a server-issued run replays its outcome, with an implicit key or an explicit job', async () => {
  for (const key of [{}, { job: 'plain-job' }]) {
    const { root, cleanup } = tempRepo([task({ status: 'doing', started_at: '2026-10-15T12:00:00+09:00' })]); const s = await serve(root);
    try {
      const input = { ...review, ...key };
      const first = await s.post(card + '/outcome', input); assert.equal(first.status, 200); const stored = await first.json(); const before = head(root);
      const duplicate = await s.post(card + '/outcome', input); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), stored); assert.equal(head(root), before);
    } finally { await s.stop(); cleanup(); }
  }
});

test('CLI flags and environment carry server-issued identity to outcomes and fallback', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  const cli = (env: Record<string, string>, ...args: string[]) => execFileSync(process.execPath, [path.resolve('bin/dasks-outcome'), ...args], { encoding: 'utf8', env: { ...process.env, DASKS_URL: s.url, DASKS_RUN_ID: '', DASKS_ATTEMPT: '', ...env } });
  try {
    let run = await (await s.post(card + '/claim', { who: 'sync' })).json(); assert.ok(run.run_id);
    cli({}, 'outcome', 'beta.t-smpl', 'needs-review', '--note', '검토 요청', '--evidence', 'RESULT.md', '--run-id', run.run_id, '--attempt', String(run.attempt));
    run = await (await s.post(card + '/claim', { who: 'sync', force: true })).json();
    cli({ DASKS_RUN_ID: run.run_id, DASKS_ATTEMPT: String(run.attempt) }, 'outcome-or-fail', 'beta.t-smpl', '--job', 'env-job', '--log', 'run/error.log');
    cli({ DASKS_RUN_ID: run.run_id, DASKS_ATTEMPT: String(run.attempt) }, 'outcome-or-fail', 'beta.t-smpl', '--job', 'env-job', '--log', 'run/error.log');
    const got = await (await fetch(s.url + card)).json(); assert.equal(got.outcomes.length, 2); assert.equal(got.outcomes.at(-1).run_id, run.run_id); assert.equal(got.outcomes.at(-1).attempt, 2);
  } finally { await s.stop(); cleanup(); }
});
