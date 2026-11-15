// Project status: the read model (counts, in progress, blocked and on whom, recent done, version), the route and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectStatus, statusRoute, statusRows, statusText, STATUS_CAPS, type StatusInput } from '../src/lib/project-status.ts';
import { stuckReport } from '../src/lib/stuck.ts';
import type { Goal, Task } from '../src/lib/schema.ts';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = new Date('2026-11-02T12:00:00Z');
const H = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const goal = (id: string, over: Partial<Goal> = {}): Goal => ({ id, parent: 'north', title: id.toUpperCase(), why: 'Ship it.\nmore', owner: `${id}-lead`, milestones: [{ id: `${id}.m1`, title: 'First', done_criteria: [], due: '', status: 'active' }, { id: `${id}.m2`, title: 'Second', done_criteria: [], due: '', status: 'planned' }], file: `data/goals/${id}.yaml`, ...over });
const t = (name: string, over: Partial<Task> = {}) => task({ id: `beta.t-${name}`, created: H(1), updated: H(1), ...over });
const input = (tasks: Task[], goals = [goal('beta'), goal('alpha')], doneAt?: StatusInput['doneAt']): StatusInput => {
  const board = { goals, tasks };
  return { board, stuck: stuckReport(board, NOW), now: NOW, doneAt };
};

test('status: counts every status, open = not done or cancelled, only the asked project', () => {
  const s = projectStatus('beta', input([t('a'), t('b', { status: 'doing', claimed_by: 'claude-code@m' }), t('c', { status: 'review' }), t('d', { status: 'done' }), t('e', { status: 'cancelled' }), t('f', { status: 'blocked-on-user', needs_user: 'Pick a name' }), task({ id: 'alpha.t-x' })]));
  assert.deepEqual(s.counts, { todo: 1, doing: 1, review: 1, 'blocked-on-user': 1, done: 1, cancelled: 1, open: 4 });
  assert.equal(s.title, 'BETA');
  assert.equal(s.why, 'Ship it.');
  assert.equal(s.version, null, 'no version_target: no version block');
  assert.throws(() => projectStatus('nope', input([])), /no project "nope"/);
});

test('status: in progress lists doing before review, with claim, now line and age', () => {
  const s = projectStatus('beta', input([
    t('r', { status: 'review', updated: H(5) }),
    t('d1', { status: 'doing', claimed_by: 'codex@m', started_at: H(2), now: 'writing tests' }),
    t('d2', { status: 'doing', started_at: H(3) }),
  ]));
  assert.deepEqual(s.in_progress.map((c) => [c.id, c.status, c.age_hours]), [['beta.t-d2', 'doing', 3], ['beta.t-d1', 'doing', 2], ['beta.t-r', 'review', 5]]);
  assert.equal(s.in_progress[1].claimed_by, 'codex@m');
  assert.equal(s.in_progress[1].now, 'writing tests');
  const beat = projectStatus('beta', input([t('hb', { status: 'doing', started_at: H(48), claimed_at: H(48), claim_seen: H(1) })]));
  assert.equal(beat.in_progress[0].age_hours, 48, 'a heartbeat does not reset the time since start');
});

test('status: a cancelled dependency blocks; a missing one old enough to be ignored does not', () => {
  const s = projectStatus('beta', input([
    t('parent', { status: 'cancelled' }), t('child', { depends_on: 'beta.t-parent' }),
    t('ghost', { depends_on: 'beta.t-nowhere', updated: H(30), created: H(30) }),
  ]));
  assert.deepEqual(s.blocked.map((b) => [b.id, b.reason, b.on]), [['beta.t-child', 'dep-cancelled', ['beta.t-parent']]]);
  assert.deepEqual(s.blocked_counts, { 'dep-cancelled': 1 });
});

test('status: blocked says on whom: the person, the dependency, the missing card, the claim holder; idle todo is not blocked', () => {
  const s = projectStatus('beta', input([
    t('ask', { status: 'blocked-on-user', needs_user: '\nWhich colour?\nDetails', next_owner: 'design-lead', updated: H(2) }),
    t('ask2', { needs_user: 'Approve the plan', updated: H(30) }),
    t('root'), t('dep', { depends_on: 'beta.t-root' }),
    t('gone', { depends_on: 'beta.t-missing' }),
    t('stale', { status: 'doing', claimed_by: 'codex@m', started_at: H(48) }),
    t('idle', { updated: H(24 * 30), created: H(24 * 30) }),
  ]));
  const by = Object.fromEntries(s.blocked.map((b) => [b.id, b]));
  assert.deepEqual(by['beta.t-ask'].on, ['design-lead']);
  assert.equal(by['beta.t-ask'].ask, 'Which colour?');
  assert.deepEqual(by['beta.t-ask2'].on, ['user'], 'needs_user without next_owner waits on the user');
  assert.deepEqual([by['beta.t-dep'].reason, by['beta.t-dep'].on], ['dep-open', ['beta.t-root']]);
  assert.deepEqual([by['beta.t-gone'].reason, by['beta.t-gone'].on], ['dep-missing', ['beta.t-missing']]);
  assert.deepEqual([by['beta.t-stale'].reason, by['beta.t-stale'].on], ['doing-stale', ['codex@m']]);
  assert.ok(!by['beta.t-idle'], 'an idle todo card waits for a builder, it is not blocked');
  assert.deepEqual(s.blocked.slice(0, 2).map((b) => b.id), ['beta.t-ask2', 'beta.t-ask'], 'cards waiting on a person first, oldest first');
  assert.equal(s.blocked_counts['blocked-user'], 2);
});

test('status: recent done uses the close time, keeps the last 7 days, newest first, capped', () => {
  const closed = Array.from({ length: STATUS_CAPS.recent_done + 2 }, (_, i) => t(`d${i}`, { status: 'done', updated: H(i + 1) }));
  const old = t('old', { status: 'done', updated: H(24 * 8) });
  const reopenedNote = t('note', { status: 'done', updated: H(1) }); // a note today, but it closed 10 days ago
  const at: Record<string, string> = { 'beta.t-note': H(24 * 10) };
  const s = projectStatus('beta', input([...closed, old, reopenedNote], undefined, (c) => at[c.id] ?? null));
  assert.equal(s.recent_done.length, STATUS_CAPS.recent_done);
  assert.equal(s.recent_done_rest, 2);
  assert.equal(s.recent_done[0].id, 'beta.t-d0');
  assert.ok(![...s.recent_done].some((d) => d.id === 'beta.t-old' || d.id === 'beta.t-note'));
});

test('status: version progress only with a valid version_target, launch-gate and cancelled cards left out', () => {
  const g = goal('beta', { version_target: 'beta.m2' });
  const tasks = [t('v1', { milestone: 'beta.m2', status: 'done' }), t('v2', { milestone: 'beta.m2' }), t('v3', { milestone: 'beta.m2', status: 'cancelled' }),
    t('lg', { milestone: 'beta.m2', body: 'launch_gate: beta.m2\n' }), t('other')];
  const s = projectStatus('beta', input(tasks, [g]));
  assert.deepEqual(s.version, { milestone: 'beta.m2', title: 'Second', done: 1, total: 2, open: 1, pct: 50, ready: false, gate_card: null });
  assert.match(statusText(s), /Version Second \(beta\.m2\): 1\/2 done \(50%\)/);
  assert.equal(projectStatus('beta', input(tasks, [goal('beta', { version_target: 'alpha.m1' })])).version, null, 'a target outside the goal is no target');
});

test('status: rows, one per project; the text form names every list', () => {
  const inp = input([t('a', { status: 'doing' }), t('b', { status: 'done' }), task({ id: 'alpha.t-x', created: H(1), updated: H(1) })]);
  assert.deepEqual(statusRows(inp).map((r) => [r.app, r.open, r.doing, r.done_recent]), [['beta', 1, 1, 1], ['alpha', 1, 0, 0]]);
  const text = statusText(projectStatus('beta', inp));
  for (const head of ['BETA (beta)', 'Why: Ship it.', 'Cards: 1 open', 'Version: no version_target', 'In progress: 1', 'Blocked: 0', 'Done in the last 7 days: 1']) assert.ok(text.includes(head), head);
});

test('route: json and text, one project or all; 404 for an unknown project, 400 for a bad format', () => {
  const inp = input([t('a')]);
  const all = statusRoute('/api/status', new URLSearchParams(), inp);
  assert.equal(all.status, 200);
  assert.deepEqual((all.body as any).projects.map((p: any) => p.app), ['beta', 'alpha']);
  const one = statusRoute('/api/status/beta', new URLSearchParams('format=text'), inp);
  assert.equal(one.type, 'text/plain; charset=utf-8');
  assert.match(String(one.body), /^BETA \(beta\)/);
  assert.equal(statusRoute('/api/status/nope', new URLSearchParams(), inp).status, 404);
  assert.equal(statusRoute('/api/status/%zz', new URLSearchParams(), inp).status, 404);
  assert.equal(statusRoute('/api/status/beta/x', new URLSearchParams(), inp).status, 404);
  assert.equal(statusRoute('/api/status', new URLSearchParams('format=xml'), inp).status, 400);
});

test('server + CLI: GET /api/status over HTTP, recent done from the activity log, and `dasks status <app>`', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-a' }), task({ id: 'beta.t-b', status: 'doing', claimed_by: 'claude-code@m' })]);
  const s = await serve(root);
  try {
    assert.equal((await s.post('/api/tasks/beta.t-a', { status: 'done', result: 'RESULT.md' })).status, 200);
    const one = await (await fetch(s.url + '/api/status/beta')).json();
    assert.equal(one.counts.done, 1);
    assert.deepEqual(one.in_progress.map((c: any) => c.id), ['beta.t-b']);
    assert.deepEqual(one.recent_done.map((c: any) => c.id), ['beta.t-a']);
    const all = await (await fetch(s.url + '/api/status')).json();
    assert.ok(all.projects.some((p: any) => p.app === 'beta' && p.doing === 1));
    assert.equal((await fetch(s.url + '/api/status/nope')).status, 404);
    const cli = execFileSync(process.execPath, [path.join(ROOT, 'mcp/board-cli.mjs'), 'status', 'beta'], { env: { ...process.env, DASKS_URL: s.url, DASKS_ACTOR: 'claude-code@laptop' }, encoding: 'utf8' });
    assert.match(cli, /^beta \(beta\)/);
    assert.match(cli, /doing beta\.t-b/);
  } finally { await s.stop(); cleanup(); }
});
