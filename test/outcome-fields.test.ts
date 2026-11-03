import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { statusMoves, task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';
import { jobEndRel } from '../src/lib/outcome.ts';

// Outcome decisions[]/learned[], the review-only job endpoint, and one status change per job end.
const card = '/api/tasks/beta.t-smpl';
const head = (root: string) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const wakes = (root: string) => statusMoves(root, 'beta.t-smpl');
const review = { state: 'needs-review', note: '구현 검토 요청', evidence: ['RESULT.md'] };
const ctx = { what: '작업 완료', why: '리뷰 필요', do: 'PR 확인', rec: '머지 검토', after: '다음 단계', pr_summary: '작업 PR 요약' };
// Token-shaped strings are built at run time so the repo itself holds no scanner hits.
const fakeTokens = [
  'gh' + 'p_' + 'A1b2C3d4'.repeat(5),
  'github' + '_pat_' + '11ABCDEFG0'.repeat(3),
  's' + 'k-' + 'proj-' + 'Ab12Cd34Ef56'.repeat(3),
  'xo' + 'xb-' + '123456789012-abcdefABCDEF',
  'AK' + 'IA' + 'ABCDEFGHIJ234567',
  'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXBhcnQtaGVyZQ',
  '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
  'api_key=' + 'Zx9Yw8Vu7Ts6',
  'Q2xh' + 'dWRlU2VjcmV0VmFsdWUxMjM0NTY3ODkwQUJDRA',
];

async function claimRun(s: Awaited<ReturnType<typeof serve>>) {
  const r = await s.post(card, { status: 'doing', lane: 'none', note: 'claim: #job-a open (beta, codex)' }, 'beta-lead');
  assert.equal(r.status, 200); const t = await r.json(); assert.ok(t.run_id); return t;
}

test('decisions[] and learned[] are stored with the outcome, returned, and part of the replay payload', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const run = await claimRun(s);
    const input = { ...review, run_id: run.run_id, decisions: ['Decision: 폼 검증은 서버에서', 'keep 4f1c2a9e8b7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b as base'], learned: ['설정 파일은 0600'] };
    const first = await s.post(card + '/outcome', input); assert.equal(first.status, 200, await first.clone().text());
    const got = await (await fetch(s.url + card)).json();
    assert.equal(got.outcomes.length, 1);
    assert.deepEqual(got.outcomes[0].decisions, input.decisions); assert.deepEqual(got.outcomes[0].learned, input.learned);
    const before = head(root);
    const replay = await s.post(card + '/outcome', input); assert.equal(replay.status, 200); assert.equal(head(root), before);
    for (const patch of [{ decisions: ['다른 결정'] }, { learned: [] }, { decisions: undefined }]) {
      const conflict = await s.post(card + '/outcome', { ...input, ...patch });
      assert.equal(conflict.status, 409); assert.equal((await conflict.json()).rule, 'outcome-conflict'); assert.equal(head(root), before);
    }
  } finally { await s.stop(); cleanup(); }
});

test('an outcome without the new fields replays as before, and empty arrays equal absent ones', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const run = await claimRun(s);
    assert.equal((await s.post(card + '/outcome', { ...review, run_id: run.run_id })).status, 200);
    const before = head(root);
    const replay = await s.post(card + '/outcome', { ...review, run_id: run.run_id, decisions: [], learned: [] });
    assert.equal(replay.status, 200); assert.equal(head(root), before);
    const got = await (await fetch(s.url + card)).json();
    assert.equal(got.outcomes[0].decisions, undefined); assert.equal(got.outcomes[0].learned, undefined);
  } finally { await s.stop(); cleanup(); }
});

test('unknown fields, caps and bad shapes are refused with nothing written', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const run = await claimRun(s); const base = { ...review, run_id: run.run_id }; const before = head(root);
    const bad: Record<string, unknown>[] = [
      { decision: ['x'] }, { learnings: ['x'] }, { extra: 1 },
      { decisions: 'one line' }, { decisions: [1] }, { decisions: [''] }, { decisions: ['   '] },
      { decisions: ['two\nlines'] }, { learned: ['nul\0byte'] }, { learned: ['tab\u0007bell'] },
      { decisions: Array.from({ length: 13 }, (_, i) => `결정 ${i}`) }, { learned: Array.from({ length: 13 }, (_, i) => `배움 ${i}`) },
      { decisions: ['가'.repeat(241)] }, { learned: ['a'.repeat(241)] },
    ];
    for (const patch of bad) {
      const r = await s.post(card + '/outcome', { ...base, ...patch });
      assert.equal(r.status, 400, JSON.stringify(patch)); assert.equal(head(root), before);
    }
    assert.equal((await s.post(card + '/outcome', { ...base, decisions: ['가'.repeat(240)], learned: Array.from({ length: 12 }, (_, i) => `배움 ${i}`) })).status, 200);
  } finally { await s.stop(); cleanup(); }
});

test('token-like strings are refused in decisions[] and learned[] without echoing them', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const run = await claimRun(s); const base = { ...review, run_id: run.run_id }; const before = head(root);
    for (const tok of fakeTokens) for (const field of ['decisions', 'learned']) {
      const r = await s.post(card + '/outcome', { ...base, [field]: [`Decision: use ${tok} for the job`] });
      const text = await r.text();
      assert.equal(r.status, 400, `${field}: ${tok.slice(0, 6)}…`); assert.ok(!text.includes(tok), 'error must not echo the token');
      assert.equal(head(root), before);
    }
  } finally { await s.stop(); cleanup(); }
});

const jobUrl = (job: string) => `/api/jobs/${encodeURIComponent(job)}/outcome`;
const verdict = { run_id: 'run-review-1', state: 'done', note: '리뷰 통과', evidence: ['https://github.com/example-org/dasks/pull/14'], about: ['beta.t-smpl'], decisions: ['Decision: 리뷰 통과'] };

test('a review-only job result is accepted once per (job, run_id) and touches no card', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const cardBefore = fs.readFileSync(path.join(root, 'data/tasks/beta/t-smpl.md'), 'utf8');
    const first = await s.post(jobUrl('review-dasks-pr14'), verdict, 'job-runner'); assert.equal(first.status, 200, await first.clone().text());
    const stored = await first.json(); assert.equal(stored.job, 'review-dasks-pr14'); assert.equal(stored.run_id, 'run-review-1');
    const before = head(root);
    const replay = await s.post(jobUrl('review-dasks-pr14'), verdict, 'job-runner'); assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), stored); assert.equal(head(root), before);
    for (const patch of [{ note: '리뷰 실패' }, { state: 'failed', evidence: ['run/review.log'] }, { decisions: [] }, { about: [] }, { handoff: '다음' }]) {
      const conflict = await s.post(jobUrl('review-dasks-pr14'), { ...verdict, ...patch }, 'job-runner');
      assert.equal(conflict.status, 409); assert.equal((await conflict.json()).rule, 'outcome-conflict'); assert.equal(head(root), before);
    }
    const second = await s.post(jobUrl('review-dasks-pr14'), { ...verdict, run_id: 'run-review-2' }, 'job-runner'); assert.equal(second.status, 200);
    const list = await (await fetch(s.url + `/api/jobs/review-dasks-pr14/outcomes`)).json();
    assert.deepEqual(list.map((o: { run_id: string }) => o.run_id), ['run-review-1', 'run-review-2']);
    assert.equal(fs.readFileSync(path.join(root, 'data/tasks/beta/t-smpl.md'), 'utf8'), cardBefore);
    assert.equal(wakes(root), 0);
    assert.deepEqual(await (await fetch(s.url + `/api/jobs/other-job/outcomes`)).json(), []);
  } finally { await s.stop(); cleanup(); }
});

test('the job endpoint validates the job id, run_id, fields and tokens', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const before = head(root);
    for (const job of ['../etc', 'a/b', '.hidden', 'x'.repeat(241), 'new\nline', 'sp ace'])
      assert.ok([400, 404].includes((await s.post(jobUrl(job), verdict, 'job-runner')).status), JSON.stringify(job));
    const { run_id: _r, ...noRun } = verdict;
    for (const body of [noRun, { ...verdict, run_id: '' }, { ...verdict, run_id: 'a\nb' }, { ...verdict, extra: 1 }, { ...verdict, about: ['not a card id'] },
      { ...verdict, about: Array.from({ length: 11 }, () => 'beta.t-smpl') }, { ...verdict, state: 'queued' },
      { ...verdict, evidence: [] }, { ...verdict, learned: [fakeTokens[0]] }, { ...verdict, handoff: 'x\n'.repeat(41) }])
      assert.equal((await s.post(jobUrl('review-x'), body, 'job-runner')).status, 400, JSON.stringify(Object.keys(body)));
    assert.equal(head(root), before);
  } finally { await s.stop(); cleanup(); }
});

test('outcome first: a job_end write for the same run keeps the outcome status (one status change)', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const run = await claimRun(s); assert.equal(wakes(root), 1);
    const out = await s.post(card + '/outcome', { ...review, run_id: run.run_id }); assert.equal(out.status, 200);
    assert.equal((await out.json()).status, 'review'); assert.equal(wakes(root), 2);
    const fin = await s.post(card, { status: 'done', result: 'run/job.log', note: 'claim: #job-a closed (done)', job_end: run.run_id }, 'job-runner');
    assert.equal(fin.status, 200, await fin.clone().text()); const t = await fin.json();
    assert.equal(t.status, 'review'); assert.ok(String(t.body).includes('claim: #job-a closed'));
    assert.ok((t.warnings ?? []).some((w: string) => /outcome/.test(w)));
    assert.equal(wakes(root), 2);
  } finally { await s.stop(); cleanup(); }
});

test('job_end first: a late outcome for the same run is recorded but does not move the card again', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const run = await claimRun(s);
    const fin = await s.post(card, { status: 'review', pr: 'https://github.com/example-org/dasks/pull/14', note: 'claim: #job-a closed (done)', job_end: run.run_id, ...ctx }, 'job-runner');
    assert.equal(fin.status, 200, await fin.clone().text()); assert.equal((await fin.json()).status, 'review'); assert.equal(wakes(root), 2);
    const late = await s.post(card + '/outcome', { state: 'done', note: '완료', evidence: ['run/job.log'], run_id: run.run_id });
    assert.equal(late.status, 200, await late.clone().text()); assert.equal((await late.json()).status, 'review');
    const got = await (await fetch(s.url + card)).json(); assert.equal(got.outcomes.length, 1); assert.equal(got.status, 'review');
    assert.equal(wakes(root), 2);
    const before = head(root);
    assert.equal((await s.post(card + '/outcome', { state: 'done', note: '완료', evidence: ['run/job.log'], run_id: run.run_id })).status, 200);
    assert.equal(head(root), before);
  } finally { await s.stop(); cleanup(); }
});

test('job_end for another run keeps the status (the rest lands); absent keeps the old status behaviour', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const run = await claimRun(s);
    const other = await s.post(card, { status: 'review', pr: 'https://github.com/example-org/dasks/pull/14', note: 'x', job_end: 'some-older-run', ...ctx }, 'job-runner');
    assert.equal(other.status, 200); const kept = await other.json();
    assert.equal(kept.status, 'doing'); assert.equal(kept.pr, 'https://github.com/example-org/dasks/pull/14');
    const merged = await s.post(card, { status: 'done', note: 'merged' }, 'job-runner'); assert.equal((await merged.json()).status, 'done');
    for (const bad of [5, '', 'a\nb', 'x'.repeat(241)])
      assert.equal((await s.post(card, { note: 'n', job_end: bad }, 'job-runner')).status, 400, JSON.stringify(bad));
    assert.ok(run.run_id);
  } finally { await s.stop(); cleanup(); }
});

test('a replayed close after the owner moved the card keeps that status', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const run = await claimRun(s);
    const close = { status: 'review', result: 'RESULT.md', note: 'claim: #job-a closed (done)', job_end: run.run_id, ...ctx };
    assert.equal((await (await s.post(card, close, 'job-runner')).json()).status, 'review');
    assert.equal((await (await s.post(card, { status: 'done', note: 'merged' }, 'beta-lead')).json()).status, 'done');
    const w = wakes(root);
    const replay = await s.post(card, close, 'job-runner'); assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal((await replay.json()).status, 'done'); assert.equal(wakes(root), w);
  } finally { await s.stop(); cleanup(); }
});

test('Bearer header values are refused; paths and hyphenated ids are not', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const run = await claimRun(s); const base = { ...review, run_id: run.run_id };
    const bearer = 'Authorization: Bear' + 'er ' + 'abcdefghijklmnopqrstuvwx';
    assert.equal((await s.post(card + '/outcome', { ...base, decisions: ['Decision: use ' + 'Ab1cDe2fGh3iJk4l' + '+' + 'Mn5oPq6rSt7uVw8x'] })).status, 400);
    const r = await s.post(card + '/outcome', { ...base, decisions: [bearer] }); assert.equal(r.status, 400); assert.ok(!(await r.text()).includes('abcdefghijklmnopqrstuvwx'));
    const ok = await s.post(card + '/outcome', { ...base, decisions: ['use data/job-outcomes/2026-10-18/RESULT.md', 'keep Web-Contact-Form-2026-01-15-Run-AbC123 as the branch', 'see /home/me/notes/example_1e9d7cc6/w1.md'] });
    assert.equal(ok.status, 200, await ok.clone().text());
  } finally { await s.stop(); cleanup(); }
});

test('a late outcome after a close that wrote no context is still recorded', async () => {
  const t = task({ status: 'review', run_id: '0f0e0d0c-0b0a-4908-8706-050403020100', attempt: '1', started_at: '2026-10-18T09:00:00+09:00' } as any);
  const { root, cleanup } = tempRepo([t]);
  const rel = jobEndRel('beta.t-smpl', '0f0e0d0c-0b0a-4908-8706-050403020100', 1); fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), '{}\n'); execFileSync('git', ['-C', root, 'add', '-A']); execFileSync('git', ['-C', root, 'commit', '-qm', 'marker']);
  const s = await serve(root);
  try {
    const late = await s.post(card + '/outcome', { ...review, handoff: '다음 검토', run_id: '0f0e0d0c-0b0a-4908-8706-050403020100', attempt: 1 }, 'job-runner');
    assert.equal(late.status, 200, await late.clone().text());
    const got = await (await fetch(s.url + card)).json();
    assert.equal(got.status, 'review'); assert.equal(got.outcomes.length, 1); assert.equal(got.handoff, '다음 검토');
  } finally { await s.stop(); cleanup(); }
});

test('a failed outcome after a done close at the retry cap is recorded and the card stays done', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root, { DASKS_GATES: 'enforce' });
  try {
    const cfg = path.join(root, 'test-config.json');
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), retry_cap: 1 }));
    const run = await claimRun(s);
    assert.equal((await (await s.post(card, { status: 'done', result: 'run/job.log', note: 'closed', job_end: run.run_id }, 'job-runner')).json()).status, 'done');
    // On a closed card only an exact (run_id, attempt) outcome is recorded.
    const stale = await s.post(card + '/outcome', { state: 'failed', note: '실패', evidence: ['run/job.log'], run_id: run.run_id }, 'job-runner');
    assert.equal(stale.status, 409); assert.equal((await stale.json()).rule, 'stale-outcome');
    const late = await s.post(card + '/outcome', { state: 'failed', note: '실패', evidence: ['run/job.log'], run_id: run.run_id, attempt: Number(run.attempt) }, 'job-runner');
    assert.equal(late.status, 200, await late.clone().text());
    const got = await (await fetch(s.url + card)).json(); assert.equal(got.status, 'done'); assert.equal(got.outcomes.length, 1);
  } finally { await s.stop(); cleanup(); }
});

test('closed card: run-less outcome-or-fail returns the current run\'s stored response, not an older run with the same job', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const r1 = await (await s.post(card + '/claim', { who: 'sync' })).json();
    assert.equal((await (await s.post(card + '/outcome-or-fail', { job: 'job-x', log: 'run/job.log', run_id: r1.run_id, attempt: Number(r1.attempt) }, 'job-runner')).json()).status, 'todo');
    const r2 = await (await s.post(card + '/claim', { who: 'sync' })).json(); assert.equal(Number(r2.attempt), 2);
    const done = await s.post(card + '/outcome', { state: 'done', note: '완료', evidence: ['run/job.log'], job: 'job-x', run_id: r2.run_id, attempt: 2 }, 'job-runner');
    assert.equal(done.status, 200, await done.clone().text()); assert.equal((await done.json()).status, 'done');
    const before = head(root);
    const oof = await s.post(card + '/outcome-or-fail', { job: 'job-x', log: 'run/job.log' }, 'job-runner');
    assert.equal(oof.status, 200, await oof.clone().text());
    const got = await oof.json(); assert.equal(got.status, 'done'); assert.equal(Number(got.attempt), 2); assert.equal(head(root), before);
  } finally { await s.stop(); cleanup(); }
});
