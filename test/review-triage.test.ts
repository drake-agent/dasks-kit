// Review triage (src/lib/triage.ts, src/lib/pr-status.ts, GET /api/review-triage): every card in review with a PR in
// one bucket, in the order a person clears them. PR status is read by the server with gh (a fake gh here), never by the
// browser; reviews come from the board's review-run records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildTriage, triageItem, type TriageCard } from '../src/lib/triage.ts';
import { ciOf, parsePrView, type PrStatus } from '../src/lib/pr-status.ts';
import { task, tempRepo } from './helpers.ts';
import { serve, until } from './state-support.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const card = (id: string, over: Partial<TriageCard> = {}): TriageCard => ({ id, title: id, goal: 'web', priority: 'p2', updated: '2026-11-03T10:00:00Z', pr: `https://github.com/o/r/pull/${id.length}`, ...over });
const pr = (over: Partial<Extract<PrStatus, { ok: true }>> = {}): PrStatus => ({ ok: true, at: NOW.toISOString(), state: 'OPEN', head: HEAD, ci: 'green', updated_at: '2026-11-03T09:00:00Z', ...over });
const clean = { head: HEAD, verdict: 'clean', open: 0, ts: '2026-11-03T10:00:00Z' };

test('buckets: each rule, first match wins', () => {
  const b = (st: PrStatus | undefined, reviews: any[], c = card('web.t-a')) => triageItem(c, st, reviews, NOW, 3).bucket;
  assert.equal(b(pr(), [clean]), 'ready');
  assert.equal(b(pr({ ci: 'none' }), [clean]), 'ready', 'no checks + clean review');
  assert.equal(b(pr({ state: 'MERGED', ci: 'red' }), []), 'ready', 'merged: only the card is left to close');
  assert.equal(b(pr({ ci: 'red' }), [clean]), 'fix');
  assert.equal(b(pr(), [{ ...clean, verdict: 'open', open: 2 }]), 'fix');
  assert.equal(b(pr({ state: 'CLOSED' }), [clean]), 'fix');
  assert.equal(b(pr({ ci: 'pending' }), [clean]), 'ci');
  assert.equal(b(undefined, [clean]), 'ci', 'status not read yet');
  assert.equal(b({ ok: false, at: '', error: 'gh is not installed' }, []), 'ci');
  assert.equal(b(pr(), []), 'review');
  assert.equal(b(pr(), [{ ...clean, head: OLD }]), 'review', 'a clean review of an older head does not count');
  assert.equal(b(pr(), [{ ...clean, head: OLD, verdict: 'open', open: 1 }]), 'review', 'findings on an older head: the new head needs its review');
  const old = card('web.t-a', { updated: '2026-10-20T00:00:00Z' });
  assert.equal(b(pr({ updated_at: '2026-10-20T00:00:00Z' }), [], old), 'stale');
  assert.equal(b(pr({ updated_at: '2026-10-20T00:00:00Z', ci: 'red' }), [], old), 'fix', 'a fix outranks stale');
  assert.equal(b(pr({ updated_at: '2026-10-20T00:00:00Z' }), [{ ...clean, ts: '2026-11-03T08:00:00Z' }].map((r) => ({ ...r, head: OLD })), old), 'review', 'a recent review is activity');
});

test('buildTriage: clearing order, priority then longest wait inside a bucket; cards without a GitHub PR left out', () => {
  const cards = [card('web.t-late', { priority: 'p2', updated: '2026-11-02T00:00:00Z' }), card('web.t-urgent', { priority: 'p0' }), card('web.t-early', { priority: 'p2', updated: '2026-11-01T00:00:00Z' }), card('web.t-nopr', { pr: '' })];
  const t = buildTriage(cards, () => pr(), () => [], NOW, 3);
  assert.deepEqual(t.order, ['ready', 'fix', 'ci', 'review', 'stale']);
  assert.equal(t.total, 3);
  assert.deepEqual(t.buckets.review.map((x) => x.id), ['web.t-urgent', 'web.t-early', 'web.t-late']);
});

test('gh answers: checks to one word, a pr view to a status', () => {
  assert.equal(ciOf([]), 'none');
  assert.equal(ciOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', state: 'SUCCESS' }]), 'green');
  assert.equal(ciOf([{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'pending');
  assert.equal(ciOf([{ __typename: 'CheckRun', status: 'IN_PROGRESS' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }]), 'red');
  assert.equal(ciOf([{ __typename: 'StatusContext', state: 'PENDING' }]), 'pending');
  assert.equal(ciOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STALE' }]), 'pending', 'an expired check is not a pass');
  assert.equal(ciOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'green');
  const ok = parsePrView(JSON.stringify({ state: 'OPEN', headRefOid: HEAD, statusCheckRollup: [], updatedAt: 'x' }), 'now');
  assert.deepEqual(ok, { ok: true, at: 'now', state: 'OPEN', head: HEAD, ci: 'none', updated_at: 'x' });
  assert.equal(parsePrView('nope', 'now').ok, false);
});

test('server: GET /api/review-triage buckets review cards from gh (server side, cached) and the review records', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-triage-gh-'));
  const calls = path.join(bin, 'calls');
  // A fake gh: PR 1 green, PR 2 red, anything else running. Each call is counted.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$3" >> "${calls}"\ncase "$3" in\n  */pull/1) c='[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]';;\n  */pull/2) c='[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}]';;\n  *) c='[{"__typename":"CheckRun","status":"QUEUED"}]';;\nesac\nprintf '{"state":"OPEN","headRefOid":"${HEAD}","updatedAt":"2026-11-03T09:00:00Z","statusCheckRollup":%s}' "$c"\n`, { mode: 0o755 });
  const now = new Date().toISOString();
  const rv = (id: string, pr: number) => task({ id, status: 'review', pr: `https://github.com/o/r/pull/${pr}`, updated: now, body: '\n## Context\nx\n' });
  const { root, cleanup } = tempRepo([rv('beta.t-green', 1), rv('beta.t-red', 2), rv('beta.t-wait', 3), rv('beta.t-norev', 1), task({ id: 'beta.t-todo', pr: 'https://github.com/o/r/pull/9' })]);
  fs.mkdirSync(path.join(root, 'data/review-runs/beta'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/review-runs/beta/t-green.jsonl'), JSON.stringify({ pass: 1, head: HEAD, verdict: 'clean', open: 0, ts: now }) + '\n');
  execFileSync('git', ['-C', root, 'add', '-A']); execFileSync('git', ['-C', root, 'commit', '-qm', 'reviews']);
  const srv = await serve(root, { DASKS_GH: path.join(bin, 'gh') });
  try {
    let t: any;
    await until(async () => { t = await (await fetch(srv.url + '/api/review-triage')).json(); return t.buckets.ci.length === 1; }, 15000);
    assert.deepEqual(t.buckets.ready.map((x: any) => x.id), ['beta.t-green']);
    assert.deepEqual(t.buckets.fix.map((x: any) => x.id), ['beta.t-red']);
    assert.deepEqual(t.buckets.ci.map((x: any) => x.id), ['beta.t-wait']);
    assert.deepEqual(t.buckets.review.map((x: any) => x.id), ['beta.t-norev']);
    assert.equal(t.total, 4, 'a todo card with a PR is not in review');
    const n = fs.readFileSync(calls, 'utf8').trim().split('\n').length;
    await fetch(srv.url + '/api/review-triage');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, n, 'cached: no new gh call within the TTL');
    assert.equal(n, 3, 'one gh call per distinct PR');
  } finally { await srv.stop(); cleanup(); fs.rmSync(bin, { recursive: true, force: true }); }
});
