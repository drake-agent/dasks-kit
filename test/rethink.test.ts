// Rethink at the review limit: ids, the line cap, a retried create, and the close pass's guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeMarker, closeSuperseded, fileRethink, rethinkGen, rethinkId, rethinkOf, type PrIo } from '../src/lib/rethink.ts';
import { BoardError } from '../src/lib/run-flow.ts';
import { MAX_ID_LEN, isTaskId } from '../src/lib/schema.ts';

test('ids: one line of cards counts up from its first card; a long id is cut to fit', () => {
  assert.equal(rethinkId('web.t-login', 1), 'web.t-login-rethink-1');
  assert.equal(rethinkId('web.t-login-rethink-1', 2), 'web.t-login-rethink-2');
  const long = `web.t-${'a'.repeat(MAX_ID_LEN - 6)}`;
  const id = rethinkId(long, 3);
  assert.ok(isTaskId(id) && id.endsWith('-rethink-3') && id.length <= MAX_ID_LEN, id);
  assert.equal(rethinkGen('web.t-login-rethink-2', 'rethink: web.t-login-rethink-1\n'), 2);
  assert.equal(rethinkGen('web.t-login-rethink-2', 'no line'), 0, 'a look-alike id without the line is a first card');
  assert.equal(rethinkGen('web.t-login', 'rethink: web.t-x'), 0);
  assert.equal(rethinkOf('\nrethink: web.t-login\n\n## Why'), 'web.t-login');
  assert.equal(rethinkOf('- note: rethink: web.t-login'), null, 'only a line of its own');
});

function fakeApi(tasks: Record<string, any>, over: (m: string, r: string, b: any) => any = () => undefined) {
  const calls: [string, string, any][] = [];
  const api = async (m: string, r: string, b?: any) => {
    calls.push([m, r, b]);
    const o = over(m, r, b); if (o !== undefined) { if (o instanceof Error) throw o; return o; }
    const id = /^\/api\/tasks\/([^/?]+)/.exec(r)?.[1];
    if (m === 'GET' && r.endsWith('/spec')) throw new BoardError(404, 'no spec');
    if (m === 'GET' && id) { if (!tasks[id]) throw new BoardError(404, 'not found'); return tasks[id]; }
    if (m === 'POST' && r === '/api/tasks') { if (tasks[b.id]) throw new BoardError(409, `task "${b.id}" already exists`); tasks[b.id] = b; return b; }
    return {};
  };
  return { api, calls };
}

test('file: the third rethink is the last one; off at 0; a retried create finds its card; an over-limit goal and a 5xx', async () => {
  const old = { id: 'web.t-login-rethink-3', goal: 'web', title: 'Rethink: Login', lane: 'claude', priority: 'p1', body: 'rethink: web.t-login-rethink-2\n' };
  let f = fakeApi({ [old.id]: old });
  assert.match((await fileRethink(f, old.id, 'pr', ['R1'], 3)).why, /already had 3 rethink/);
  assert.ok(!f.calls.some(([m]) => m === 'POST'), 'nothing written');
  f = fakeApi({ 'web.t-login': { ...old, id: 'web.t-login', body: 'touches: src\n' } });
  assert.match((await fileRethink(f, 'web.t-login', 'pr', [], 0)).why, /off/);
  const first = await fileRethink(f, 'web.t-login', 'https://github.com/o/r/pull/1', ['- R1 [security] x'], 3);
  assert.deepEqual([first.id, first.fresh], ['web.t-login-rethink-1', true]);
  const made = f.calls.find(([m, r]) => m === 'POST' && r === '/api/tasks')![2];
  assert.equal(made.force, true, 'the title repeats the old one, so the near-duplicate check is skipped');
  assert.deepEqual([made.goal, made.lane, made.priority], ['web', 'claude', 'p1']);
  const again = await fileRethink(f, 'web.t-login', 'https://github.com/o/r/pull/1', [], 3);
  assert.deepEqual([again.id, again.fresh], ['web.t-login-rethink-1', false]);
  const idea = fakeApi({ 'web.t-login': { ...old, id: 'web.t-login' } }, (m, r) => (m === 'POST' && r === '/api/tasks' ? { intake: true, idea: { id: 'idea-7' } } : undefined));
  assert.match((await fileRethink(idea, 'web.t-login', '', [], 3)).why, /todo limit.*idea-7/);
  const down = fakeApi({ 'web.t-login': { ...old, id: 'web.t-login' } }, (m, r) => (m === 'POST' && r === '/api/tasks' ? new BoardError(503, 'down') : undefined));
  await assert.rejects(fileRethink(down, 'web.t-login', '', [], 3), /down/);
});

function closeWorld(old: any, pr: { state: string; comments?: string[] } | null, extra: any[] = []) {
  const r = { id: 'web.t-login-rethink-1', status: 'done', body: 'rethink: web.t-login\n', pr: 'https://github.com/o/r/pull/2' };
  const all = [{ ...r }, old, ...extra];
  const gh: string[] = [];
  const io: PrIo = {
    view: async (u) => { gh.push(`view ${u}`); return pr ? { state: pr.state, comments: pr.comments ?? [] } : null; },
    comment: async (u, b) => { gh.push(`comment ${u} ${b.includes(closeMarker(r.id))}`); return true; },
    close: async (u) => { gh.push(`close ${u}`); if (pr) pr.state = 'CLOSED'; return true; },
  };
  const { api, calls } = fakeApi({}, (m, route) => {
    if (m === 'GET' && route.startsWith('/api/tasks?status=done')) return [r];
    if (m === 'GET' && route.startsWith('/api/tasks?status=all')) return all;
    if (m === 'POST') return {};
    return undefined;
  });
  return { env: { api }, io, gh, writes: () => calls.filter(([m]) => m === 'POST') };
}

test('close: an open PR is commented once and closed, the old card cancelled, its dependents moved', async () => {
  const old = { id: 'web.t-login', status: 'review', spec_state: 'blocked', pr: 'https://github.com/o/r/pull/1', version: '7' };
  const dep = { id: 'web.t-next', status: 'todo', depends_on: 'web.t-a, web.t-login', version: '2' };
  const w = closeWorld(old, { state: 'OPEN' }, [dep]);
  const lines = await closeSuperseded(w.env, w.io);
  assert.deepEqual(w.gh, ['view https://github.com/o/r/pull/1', 'comment https://github.com/o/r/pull/1 true', 'close https://github.com/o/r/pull/1', 'view https://github.com/o/r/pull/1']);
  const [cancel, relink] = w.writes();
  assert.equal(cancel[1], '/api/tasks/web.t-login');
  assert.deepEqual([cancel[2].status, cancel[2].expected_version], ['cancelled', 7]);
  assert.match(cancel[2].result, /^superseded by web\.t-login-rethink-1 \(closed https/);
  assert.deepEqual([relink[1], relink[2].depends_on, relink[2].expected_version], ['/api/tasks/web.t-next', 'web.t-a, web.t-login-rethink-1', 2]);
  assert.equal(lines.length, 2, lines.join('\n'));
  // A comment left by an earlier try is not repeated.
  const again = closeWorld(old, { state: 'OPEN', comments: [`x ${closeMarker('web.t-login-rethink-1')}`] });
  await closeSuperseded(again.env, again.io);
  assert.ok(!again.gh.some((l) => l.startsWith('comment')));
});

test('close: nothing is written for a merged PR, an unreadable PR, an unblocked or held old card, or a pr field that is not a GitHub PR', async () => {
  const base = { id: 'web.t-login', status: 'review', spec_state: 'blocked', pr: 'https://github.com/o/r/pull/1', version: '7' };
  for (const [old, pr, why] of [
    [base, { state: 'MERGED' }, /was merged/],
    [base, null, /could not be read/],
    [{ ...base, spec_state: 'ready' }, { state: 'OPEN' }, /no longer blocked/],
    [{ ...base, claimed_by: 'claude@one' }, { state: 'OPEN' }, /someone holds it/],
    [{ ...base, pr: 'see the PR' }, { state: 'OPEN' }, /not a GitHub PR/],
  ] as const) {
    const w = closeWorld(old, pr ? { ...pr } : null);
    const lines = await closeSuperseded(w.env, w.io);
    assert.deepEqual(w.writes(), [], lines.join('\n'));
    assert.ok(!w.gh.some((l) => /^(comment|close)/.test(l)));
    assert.match(lines.join('\n'), why);
  }
  // A closed old PR: nothing on GitHub, the card is still cancelled. Already cancelled by this pass: only the relink is left.
  const closed = closeWorld(base, { state: 'CLOSED' });
  await closeSuperseded(closed.env, closed.io);
  assert.deepEqual(closed.writes().map(([, r, b]) => [r, b.status]), [['/api/tasks/web.t-login', 'cancelled']]);
  const left = closeWorld({ ...base, status: 'cancelled', result: 'superseded by web.t-login-rethink-1' }, null, [{ id: 'web.t-next', status: 'todo', depends_on: 'web.t-login', version: '1' }]);
  await closeSuperseded(left.env, left.io);
  assert.deepEqual(left.gh, []);
  assert.deepEqual(left.writes().map(([, r, b]) => [r, b.depends_on]), [['/api/tasks/web.t-next', 'web.t-login-rethink-1']]);
  const other = closeWorld({ ...base, status: 'cancelled', result: 'not wanted' }, null);
  await closeSuperseded(other.env, other.io);
  assert.deepEqual(other.writes(), [], 'a card cancelled for another reason is left alone');
});
