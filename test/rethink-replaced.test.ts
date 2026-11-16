// A card an open rethink card replaces asks the user nothing (src/lib/rethink.ts replacedByRethink): no decision request
// on the board or the card, not on the review triage page. Every other case keeps asking as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitNote, openRethinkTargets, replacedByRethink } from '../src/lib/rethink.ts';
import { task, tempRepo } from './helpers.ts';
import { serve, until } from './state-support.ts';

const NOTE = limitNote('runner@mac-1', 2, 'R1 [P1] src/a.ts:10 a race');
const AT_LIMIT = { spec_state: 'blocked', fields: { block_note: NOTE } };
const old = (over: Record<string, unknown> = {}) => ({ id: 'web.t-login', status: 'review', needs_user: '', approvals: 'none', ...over });
const rethink = (status = 'todo', target = 'web.t-login') => ({ id: `${target}-rethink-1`, status, body: `rethink: ${target}\n\n## Why this card\nx\n` });

test('replacedByRethink: a review card at the review limit that an open rethink card names', () => {
  for (const status of ['todo', 'doing', 'review', 'blocked-on-user'])
    assert.equal(replacedByRethink(old(), AT_LIMIT, openRethinkTargets([old(), rethink(status)])), true, `rethink card ${status}`);
});

test('replacedByRethink: every other case still asks', () => {
  const open = openRethinkTargets([old(), rethink()]);
  const cases: [string, boolean][] = [
    ['needs_user set', replacedByRethink(old({ needs_user: 'Approve the merge' }), AT_LIMIT, open)],
    ['a user gate (approvals)', replacedByRethink(old({ approvals: 'merge' }), AT_LIMIT, open)],
    ['blocked-on-user', replacedByRethink(old({ status: 'blocked-on-user' }), AT_LIMIT, open)],
    ['rethink card done', replacedByRethink(old(), AT_LIMIT, openRethinkTargets([old(), rethink('done')]))],
    ['rethink card cancelled', replacedByRethink(old(), AT_LIMIT, openRethinkTargets([old(), rethink('cancelled')]))],
    ['no rethink card', replacedByRethink(old(), AT_LIMIT, openRethinkTargets([old()]))],
    ['the line names another card', replacedByRethink(old(), AT_LIMIT, openRethinkTargets([old(), rethink('todo', 'web.t-other')]))],
    ['a card naming itself', replacedByRethink(old(), AT_LIMIT, openRethinkTargets([{ ...old(), body: 'rethink: web.t-login\n' }]))],
    ['unblocked (taken back)', replacedByRethink(old(), { spec_state: 'ready', fields: {} }, open)],
    ['blocked for another reason', replacedByRethink(old(), { spec_state: 'blocked', fields: { block_note: 'NEEDS-SPEC (someone): the spec is stale' } }, open)],
    ['tasks unreadable', replacedByRethink(old(), AT_LIMIT, openRethinkTargets(null))],
    ['spec facts unreadable', replacedByRethink(old(), undefined, open)],
  ];
  for (const [name, got] of cases) assert.equal(got, false, name);
});

test('server: the replaced card drops out of /api/board, /api/tasks/<card> and /api/review-triage; the exceptions stay', async () => {
  const blocked = { spec_state: 'blocked', blocked_by: 'runner@mac-1', blocked_at: '2026-11-10T10:00:00+09:00', block_note: NOTE };
  const now = new Date().toISOString();
  const card = (id: string, n: number, over: Record<string, unknown> = {}) => task({ id, status: 'review', pr: `https://github.com/o/r/pull/${n}`, pr_summary: `Draft PR for ${id}: x`, updated: now, ...blocked, ...over } as any);
  const re = (target: string, status: 'todo' | 'done' | 'cancelled' = 'todo') => task({ id: `${target}-rethink-1`, status, updated: now, body: `rethink: ${target}\n\n## Why this card\nx\n` });
  const { root, cleanup } = tempRepo([
    card('beta.t-gone', 1), re('beta.t-gone'),
    card('beta.t-needs', 2, { needs_user: 'Approve the merge' }), re('beta.t-needs'),
    card('beta.t-gate', 3, { approvals: 'merge' }), re('beta.t-gate'),
    card('beta.t-cancelled', 4), re('beta.t-cancelled', 'cancelled'),
    card('beta.t-done', 5), re('beta.t-done', 'done'),
    card('beta.t-other', 6, { block_note: 'NEEDS-SPEC (someone): the spec is stale' }), re('beta.t-other'),
    card('beta.t-alone', 7),
  ]);
  const srv = await serve(root, { DASKS_GH: '/nonexistent/gh' });
  try {
    const asking = ['beta.t-needs', 'beta.t-gate', 'beta.t-cancelled', 'beta.t-done', 'beta.t-other', 'beta.t-alone'];
    const b = await (await fetch(srv.url + '/api/board')).json();
    const asks = new Set(b.tasks.filter((t: any) => t.decision_request).map((t: any) => t.id));
    assert.ok(!asks.has('beta.t-gone'), 'replaced: no decision request on the board');
    for (const id of asking) assert.ok(asks.has(id), `${id} still asks on the board`);
    assert.equal((await (await fetch(srv.url + '/api/tasks/beta.t-gone')).json()).decision_request, undefined);
    assert.ok((await (await fetch(srv.url + '/api/tasks/beta.t-alone')).json()).decision_request);
    let tri: any;
    await until(async () => { tri = await (await fetch(srv.url + '/api/review-triage')).json(); return tri.total > 0; });
    const listed = Object.values(tri.buckets).flat().map((x: any) => x.id).sort();
    assert.deepEqual(listed, [...asking].sort(), 'triage leaves out only the replaced card');
  } finally { await srv.stop(); cleanup(); }
});
