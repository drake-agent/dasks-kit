// Transition gates in warn and enforce mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTask, updateTask, HttpError } from '../src/lib/write.ts';
import { loadConfig } from '../src/lib/config.ts';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

process.env.DASKS_GATES = 'warn';
const log = (root: string) => { try { return fs.readFileSync(path.join(root, 'run/gate-warnings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };

test('warn: done without evidence and a plain reopen go through, each with a warning and a log line', () => {
  const { root, cleanup } = tempRepo([task(), task({ id: 'beta.t-done', status: 'done', result: 'RESULT.md' })]);
  try {
    const w1: string[] = [];
    assert.equal(updateTask(root, 'beta.t-smpl', { status: 'done', result: 'finished' }, 'job-runner', { warnings: w1 }).status, 'done');
    assert.match(w1.join(), /not enforced yet \(gates: warn\): transition todo -> done/);
    const w2: string[] = [];
    assert.equal(updateTask(root, 'beta.t-done', { status: 'todo' }, 'sync', { warnings: w2 }).status, 'todo');
    assert.match(w2.join(), /reopen/);
    const w3: string[] = [];
    assert.equal(createTask(root, { goal: 'beta', title: 'Created done', status: 'done' }, 'sync', new Date(), { warnings: w3 }).status, 'done');
    assert.equal(w3.filter((w) => /not enforced yet/.test(w)).length, 1);
    const lines = log(root);
    assert.deepEqual(lines.map((l) => [l.actor, l.from, l.to]), [['job-runner', 'todo', 'done'], ['sync', 'done', 'todo'], ['sync', null, 'done']]);
    assert.ok(lines.every((l) => l.id && l.reason && !Number.isNaN(Date.parse(l.at))));
  } finally { cleanup(); }
});

test('warn: other errors still refuse (bad status, version conflict); allowed moves log nothing', () => {
  const { root, cleanup } = tempRepo([task()]);
  try {
    assert.throws(() => updateTask(root, 'beta.t-smpl', { status: 'nope' }, 'sync'), (e: unknown) => e instanceof HttpError && e.status === 400);
    assert.throws(() => updateTask(root, 'beta.t-smpl', { status: 'doing' }, 'sync', { expectedVersion: 99 }), /version conflict/);
    updateTask(root, 'beta.t-smpl', { status: 'doing' }, 'sync');
    assert.deepEqual(log(root), []);
  } finally { cleanup(); }
});

test('enforce via env refuses the same move; config validates the value', () => {
  const { root, cleanup } = tempRepo([task()]);
  try {
    process.env.DASKS_GATES = 'enforce';
    assert.throws(() => updateTask(root, 'beta.t-smpl', { status: 'done', result: 'finished' }, 'job-runner'), (e: unknown) => e instanceof HttpError && e.status === 409);
    process.env.DASKS_GATES = 'bogus';
    assert.throws(() => loadConfig(root), /gates must be "warn" or "enforce"/);
    delete process.env.DASKS_GATES;
    assert.equal(loadConfig(root).gates, 'warn', 'default');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ gates: 'enforce' }));
    assert.equal(loadConfig(root).gates, 'enforce', 'config.json');
  } finally { process.env.DASKS_GATES = 'warn'; cleanup(); }
});

test('warn over HTTP: a finish with a plain result is done, with the warning header', async () => {
  const { root, cleanup } = tempRepo([task()]);
  const s = await serve(root);
  try {
    const r = await s.post('/api/tasks/beta.t-smpl/finish', { result: 'Did the thing.' }, 'job-runner');
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json();
    assert.equal(body.status, 'done');
    assert.ok((body.warnings ?? []).some((w: string) => /not enforced yet/.test(w)));
  } finally { await s.stop(); cleanup(); }
});

test('warn: a finish on a failed-terminal card closes it (lane none, logged); outcome responses carry warnings', async () => {
  const { root, cleanup } = tempRepo([task(), task({ id: 'beta.t-done', status: 'done', result: 'RESULT.md' }), task({ id: 'beta.t-late' })]);
  const s = await serve(root);
  try {
    const cfg = path.join(root, 'test-config.json');
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), retry_cap: 1 }));
    const run = await (await s.post('/api/tasks/beta.t-smpl/claim', { who: 'sync' })).json();
    const capped = await (await s.post('/api/tasks/beta.t-smpl/outcome', { state: 'failed', note: '실행 실패', evidence: ['run/test.log'], run_id: run.run_id, attempt: 1 })).json();
    assert.equal(capped.lane, 'failed-terminal');
    const fin = await s.post('/api/tasks/beta.t-smpl/finish', { result: 'Completed', force: true }, 'job-runner');
    assert.equal(fin.status, 200, await fin.clone().text());
    const got = await fin.json(); assert.equal(got.status, 'done'); assert.equal(got.lane, 'none');
    assert.ok(log(root).some((l) => l.actor === 'job-runner' && /retry cap/.test(l.reason)));
    // a run-less failed outcome on a done card is a stale outcome, refused even in warn
    const out = await s.post('/api/tasks/beta.t-done/outcome', { state: 'failed', note: '실행 실패', evidence: [] , job: 'j-reopen' }, 'job-runner');
    assert.equal(out.status, 409, await out.clone().text());
    assert.equal((await out.json()).rule, 'stale-outcome');
    // an exact-match outcome on a closed card is recorded with the status kept; the warning comes back in body and header
    const late = await (await s.post('/api/tasks/beta.t-late/claim', { who: 'sync' })).json();
    assert.equal((await (await s.post('/api/tasks/beta.t-late', { status: 'done', result: 'run/job.log' }, 'beta-lead')).json()).status, 'done');
    const kept = await s.post('/api/tasks/beta.t-late/outcome', { state: 'failed', note: '실행 실패', evidence: [], run_id: late.run_id, attempt: Number(late.attempt) }, 'job-runner');
    assert.equal(kept.status, 200, await kept.clone().text());
    const keptBody = await kept.json(); assert.equal(keptBody.status, 'done');
    assert.ok((keptBody.warnings ?? []).some((w: string) => /status kept/.test(w)));
    assert.match(decodeURIComponent(kept.headers.get('x-dasks-warning') ?? ''), /status kept/);
  } finally { await s.stop(); cleanup(); }
});

test('warn: cancelled -> done without reopen goes through with a warning and one log line', () => {
  const { root, cleanup } = tempRepo([task({ status: 'cancelled' })]);
  try {
    const w: string[] = [];
    assert.equal(updateTask(root, 'beta.t-smpl', { status: 'done', result: 'run/job.log' }, 'claude-code@laptop', { warnings: w }).status, 'done');
    assert.match(w.join(), /not enforced yet \(gates: warn\): transition cancelled -> done: cancelled reopen requires reopen=true/);
    assert.deepEqual(log(root).map((l) => [l.actor, l.from, l.to]), [['claude-code@laptop', 'cancelled', 'done']]);
  } finally { cleanup(); }
});
