// A closed card stays closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { statusMoves, task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';
import { updateTask, HttpError } from '../src/lib/write.ts';
import { allOutcomes, decisionsToday } from '../src/lib/outcome.ts';

const head = (root: string) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const wakes = (root: string, id: string) => statusMoves(root, id);
const gateLog = (root: string) => { try { return fs.readFileSync(path.join(root, 'run/gate-warnings.jsonl'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const ctx = { what: '작업 완료', why: '리뷰 필요', do: 'PR 확인', rec: '머지 검토', after: '다음 단계', pr_summary: '작업 PR 요약' };
const PAYLOADS: Record<string, Record<string, unknown>> = {
  done: { state: 'done', note: '늦게 온 완료', evidence: ['run/job.log'] },
  failed: { state: 'failed', note: '늦게 온 실패', evidence: [] },
  'needs-review': { state: 'needs-review', note: '늦게 온 검토 요청', evidence: ['RESULT.md'] },
  'needs-user': { state: 'needs-user', note: '사용자가 배포 승인을 결정해야 해요', evidence: [] },
  'needs-spec': { state: 'needs-spec', note: '카드 범위를 다시 써야 해요', evidence: [] },
};
const TERMINALS = ['done', 'cancelled'] as const;
const cardId = (status: string, state: string) => `beta.t-${status}-${state}`;
type Server = Awaited<ReturnType<typeof serve>>;

async function claim(s: Server, id: string) {
  const r = await s.post(`/api/tasks/${id}/claim`, { who: 'sync' }); assert.equal(r.status, 200, await r.clone().text());
  const run = await r.json(); assert.ok(run.run_id); return run as { run_id: string; attempt: string };
}
async function close(s: Server, id: string, status: 'done' | 'cancelled') {
  const r = await s.post(`/api/tasks/${id}`, status === 'done' ? { status: 'done', result: 'run/job.log' } : { status: 'cancelled' }, 'beta-lead');
  assert.equal(r.status, 200, await r.clone().text()); assert.equal((await r.json()).status, status);
}
const get = async (s: Server, id: string) => (await fetch(`${s.url}/api/tasks/${id}`)).json();

test('a new outcome on a done or cancelled card never moves it: run-less / non-matching is 409 stale-outcome and writes nothing; an exact match is recorded with the status kept', async () => {
  const ids = TERMINALS.flatMap((st) => Object.keys(PAYLOADS).map((state) => cardId(st, state)));
  const { root, cleanup } = tempRepo(ids.map((id) => task({ id })));
  const s = await serve(root);
  try {
    for (const status of TERMINALS) for (const state of Object.keys(PAYLOADS)) {
      const id = cardId(status, state), url = `/api/tasks/${id}/outcome`, label = `${status} x ${state}`;
      const run = await claim(s, id);
      await close(s, id, status);
      const before = await get(s, id), sha = head(root), w = wakes(root, id);
      for (const key of [{}, { run_id: run.run_id }, { run_id: run.run_id, attempt: 2 }, { run_id: 'older-run', attempt: 1 }, { job: 'other-job' }]) {
        const r = await s.post(url, { ...PAYLOADS[state], ...key }, 'job-runner');
        assert.equal(r.status, 409, `${label} ${JSON.stringify(key)}: ${await r.clone().text()}`);
        assert.equal((await r.json()).rule, 'stale-outcome', label);
        assert.equal(head(root), sha, `${label}: nothing written`);
      }
      assert.equal(allOutcomes(root).filter((o) => o.id === id).length, 0, `${label}: no ledger file`);
      const exact = await s.post(url, { ...PAYLOADS[state], run_id: run.run_id, attempt: Number(run.attempt) }, 'job-runner');
      assert.equal(exact.status, 200, `${label}: ${await exact.clone().text()}`);
      const got = await exact.json();
      assert.equal(got.status, status, `${label}: status kept`);
      assert.ok((got.warnings ?? []).includes(`status kept: card is ${status}`), `${label}: ${JSON.stringify(got.warnings)}`);
      assert.match(decodeURIComponent(exact.headers.get('x-dasks-warning') ?? ''), new RegExp(`status kept: card is ${status}`));
      for (const k of ['lane', 'needs_user', 'next_owner']) assert.equal(got[k] ?? '', before[k] ?? '', `${label}: ${k} kept`);
      assert.equal(wakes(root, id), w, `${label}: no wake event`);
      const recs = allOutcomes(root).filter((o) => o.id === id);
      assert.equal(recs.length, 1, label);
      assert.equal(recs[0].state, state, label);
      assert.equal((recs[0] as any).status_kept, status, label);
      assert.equal(recs[0].route, undefined, `${label}: no route`);
      assert.equal(recs[0].as_state, undefined, `${label}: not rerouted`);
      assert.equal(String(got.result).split('\n')[0], PAYLOADS[state].note, `${label}: result recorded`);
      // replay of the same exact outcome: stored response, nothing written
      const sha2 = head(root);
      const replay = await s.post(url, { ...PAYLOADS[state], run_id: run.run_id, attempt: Number(run.attempt) }, 'job-runner');
      assert.equal(replay.status, 200, label); assert.equal((await replay.json()).status, status); assert.equal(head(root), sha2, `${label}: replay writes nothing`);
    }
    // a needs-user outcome on a closed card never reaches the user's decision list
    const today = allOutcomes(root).find((o) => o.state === 'needs-user')!.at.slice(0, 10);
    assert.deepEqual(decisionsToday(root, today).map((o) => o.id), []);
  } finally { await s.stop(); cleanup(); }
});

test('replay of the outcome that closed the card still returns its stored response; a changed payload is outcome-conflict', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const id = 'beta.t-smpl', url = `/api/tasks/${id}/outcome`;
    const run = await claim(s, id);
    const closing = { ...PAYLOADS.done, run_id: run.run_id, attempt: Number(run.attempt) };
    const first = await s.post(url, closing, 'job-runner'); assert.equal(first.status, 200, await first.clone().text());
    const { warnings: _w, ...stored } = await first.json(); assert.equal(stored.status, 'done');
    const sha = head(root);
    const again = await s.post(url, closing, 'job-runner'); assert.equal(again.status, 200);
    const { warnings: _w2, ...replayed } = await again.json(); assert.deepEqual(replayed, stored); assert.equal(head(root), sha);
    const runless = await s.post(url, PAYLOADS.done, 'job-runner'); assert.equal(runless.status, 200, 'run-less replay binds to the run that closed it');
    assert.equal(head(root), sha);
    const conflict = await s.post(url, { ...closing, note: '다른 결과' }, 'job-runner');
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).rule, 'outcome-conflict'); assert.equal(head(root), sha);
    // outcome-or-fail for that run: the stored response, nothing written
    const oof = await s.post(`/api/tasks/${id}/outcome-or-fail`, { job: 'launcher-job', log: 'run/job.log', run_id: run.run_id, attempt: Number(run.attempt) }, 'job-runner');
    assert.equal(oof.status, 200, await oof.clone().text());
    const body = await oof.json(); assert.equal(body.status, 'done'); assert.equal(body.version, stored.version); assert.equal(head(root), sha);
  } finally { await s.stop(); cleanup(); }
});

test('outcome-or-fail on a terminal card is always a no-op 200, stale ids included', async () => {
  const ids = TERMINALS.map((st) => `beta.t-oof-${st}`);
  const { root, cleanup } = tempRepo(ids.map((id) => task({ id }))); const s = await serve(root);
  try {
    for (const status of TERMINALS) {
      const id = `beta.t-oof-${status}`;
      const run = await claim(s, id); await close(s, id, status);
      const sha = head(root);
      for (const key of [{}, { run_id: run.run_id, attempt: Number(run.attempt) }, { run_id: 'older-run', attempt: 1 }, { run_id: run.run_id, attempt: 7 }, { run_id: run.run_id }]) {
        const r = await s.post(`/api/tasks/${id}/outcome-or-fail`, { job: 'launcher-job', log: 'run/job.log', ...key }, 'job-runner');
        assert.equal(r.status, 200, `${status} ${JSON.stringify(key)}: ${await r.clone().text()}`);
        assert.equal((await r.json()).status, status);
        assert.equal(head(root), sha, `${status} ${JSON.stringify(key)}: nothing written`);
      }
      assert.equal(allOutcomes(root).filter((o) => o.id === id).length, 0);
    }
  } finally { await s.stop(); cleanup(); }
});

test('a status write whose job_end is not the current run keeps the status; the current run\'s job_end still moves the card', async () => {
  const { root, cleanup } = tempRepo([task(), task({ id: 'beta.t-never' })]); const s = await serve(root);
  try {
    const card = '/api/tasks/beta.t-smpl';
    const run = await claim(s, 'beta.t-smpl');
    const older = await s.post(card, { status: 'review', pr: 'https://github.com/example-org/dasks/pull/14', note: 'claim: #old-job closed (done)', job_end: 'some-older-run', ...ctx }, 'job-runner');
    assert.equal(older.status, 200, await older.clone().text());
    const t = await older.json();
    assert.equal(t.status, 'doing', 'status kept');
    assert.ok((t.warnings ?? []).includes('status kept: job_end is for an older run'), JSON.stringify(t.warnings));
    assert.match(decodeURIComponent(older.headers.get('x-dasks-warning') ?? ''), /status kept: job_end is for an older run/);
    assert.equal(t.pr, 'https://github.com/example-org/dasks/pull/14', 'rest of the write kept');
    assert.ok(String(t.body).includes('claim: #old-job closed'), 'note kept');
    assert.ok(!String(t.body).includes('머지 검토'), 'no Context block from the stale close');
    // no run at all (empty run_id): any job_end is an older run's
    const never = await s.post('/api/tasks/beta.t-never', { status: 'review', result: 'RESULT.md', note: 'closed', job_end: 'ghost-run', ...ctx }, 'job-runner');
    assert.equal(never.status, 200, await never.clone().text()); assert.equal((await never.json()).status, 'todo');
    // a closed card stays closed against a stale job_end too
    assert.equal((await (await s.post(card, { status: 'done', result: 'run/job.log' }, 'beta-lead')).json()).status, 'done');
    const late = await s.post(card, { status: 'todo', note: 'reopened for #old-job', job_end: 'some-older-run', reopen: true }, 'job-runner');
    assert.equal(late.status, 200, await late.clone().text()); assert.equal((await late.json()).status, 'done');
    // the current run's close still moves it
    const run2 = await (await s.post(`${card}/claim`, { who: 'sync', force: true })).json();
    assert.notEqual(run2.run_id, run.run_id);
    const cur = await s.post(card, { status: 'review', pr: 'https://github.com/example-org/dasks/pull/15', note: 'claim: #job-b closed (done)', job_end: run2.run_id, ...ctx }, 'job-runner');
    assert.equal(cur.status, 200, await cur.clone().text()); assert.equal((await cur.json()).status, 'review');
  } finally { await s.stop(); cleanup(); }
});

test('cancelled -> review/done needs reopen=true under enforce; warn lets it through with one log line each', () => {
  const ids = ['beta.t-c1', 'beta.t-c2', 'beta.t-c3', 'beta.t-c4', 'beta.t-c5', 'beta.t-c6'];
  const { root, cleanup } = tempRepo(ids.map((id) => task({ id, status: 'cancelled' })));
  const prev = process.env.DASKS_GATES;
  const moves: [string, Record<string, string>, { context?: typeof ctx }][] = [
    ['review', { status: 'review', pr: 'https://github.com/example-org/dasks/pull/14', pr_summary: ctx.pr_summary }, { context: ctx }],
    ['done', { status: 'done', result: 'run/job.log' }, {}],
  ];
  try {
    process.env.DASKS_GATES = 'enforce';
    moves.forEach(([to, fields, o], i) => {
      assert.throws(() => updateTask(root, ids[i], fields, 'claude-code@laptop', { ...o }),
        (e: unknown) => e instanceof HttpError && e.status === 409 && e.data?.rule === 'transition', `cancelled -> ${to} without reopen`);
      assert.equal(updateTask(root, ids[i], fields, 'claude-code@laptop', { ...o, reopen: true }).status, to, `cancelled -> ${to} with reopen`);
    });
    assert.deepEqual(gateLog(root), []);
    process.env.DASKS_GATES = 'warn';
    moves.forEach(([to, fields, o], i) => {
      const n = gateLog(root).length, warnings: string[] = [];
      assert.equal(updateTask(root, ids[i + 2], fields, 'claude-code@laptop', { ...o, warnings }).status, to, `warn: cancelled -> ${to}`);
      assert.ok(warnings.some((w) => /not enforced yet/.test(w)), JSON.stringify(warnings));
      const lines = gateLog(root); assert.equal(lines.length, n + 1);
      const l = JSON.parse(lines.at(-1)!); assert.deepEqual([l.id, l.from, l.to], [ids[i + 2], 'cancelled', to]);
    });
    // a forced claim still takes a cancelled card to doing; cancelled -> todo/doing still need reopen
    process.env.DASKS_GATES = 'enforce';
    assert.throws(() => updateTask(root, ids[4], { status: 'todo' }, 'sync'), (e: unknown) => e instanceof HttpError && e.data?.rule === 'transition');
    assert.equal(updateTask(root, ids[4], { status: 'todo' }, 'sync', { reopen: true }).status, 'todo');
    assert.equal(updateTask(root, ids[5], {}, 'sync', { claim: { op: 'claim', who: 'sync', force: true } }).status, 'doing');
  } finally { process.env.DASKS_GATES = prev; cleanup(); }
});
