// Version mode: a goal's version_target, who starts, version status, launch_gate and the one gate card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import YAML from 'yaml';
import { loadBoard } from '../src/lib/load.ts';
import { check } from '../src/lib/check.ts';
import { readyQueue } from '../src/lib/ready.ts';
import { rollup } from '../src/lib/rollup.ts';
import { checkAsk } from '../src/lib/ask-rule.ts';
import { pickCards, pickSpecCards, type Candidate, type PickInput, type SpecPickInput } from '../src/lib/runner.ts';
import { createTask, createTaskOrIdea, HttpError, updateNode, updateTask } from '../src/lib/write.ts';
import { gateCard, gateCardId, gateOf, versionHolds, versionRows, versionStatus, versionTargets, type VersionStatus } from '../src/lib/version-mode.ts';
import { gatesDue, makeGate } from '../src/lib/version-gate.ts';
import { DEFAULT_INTAKE } from '../src/lib/config.ts';
import { task, tempRepo } from './helpers.ts';
import { serve, until } from './state-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = new Date('2026-11-02T12:00:00Z');
const V = 'beta.m2';
const goal = { id: 'beta', version_target: V, milestones: [{ id: 'beta.m1' }, { id: V }] } as any;
const inV = (name: string, over: Record<string, unknown> = {}) => task({ id: `beta.t-${name}`, milestone: V, ...over } as any);
const done = (name: string, over: Record<string, unknown> = {}) => inV(name, { status: 'done', result: 'RESULT.md', ...over });
const setTarget = (root: string, v: string) => updateNode(root, 'beta', { version_target: v }, 'beta-lead');
const onDisk = (root: string) => loadBoard(root).tasks;
const gates = (root: string) => onDisk(root).filter((t) => gateOf(t.body) === V);

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({ id, goal: id.split('.')[0], lane: 'claude', priority: 'p2', spec_state: 'ready', touches: [], ...over });
const pick = (ready: Candidate[]) => pickCards({ ready, running: [], cfg: { max_parallel: 5, daily_cap: 10 }, startedToday: 0, tools: new Set(['claude', 'codex']), backoff: {}, repos: new Map([['web', '/r/web'], ['api', '/r/api']]), now: NOW } as PickInput);

// ---------- setting the target ----------

test('target: the node route sets it, only to a milestone of that goal; empty turns it off', async () => {
  const { root, cleanup } = tempRepo([]); const s = await serve(root);
  const set = (v: unknown, id = 'beta') => s.post(`/api/nodes/${id}`, { version_target: v });
  const target = async () => (await (await fetch(s.url + '/api/board')).json()).goals.find((g: any) => g.id === 'beta').version_target;
  try {
    assert.equal((await set(V)).status, 200);
    assert.equal(await target(), V);
    assert.equal(YAML.parse(fs.readFileSync(path.join(root, 'data/goals/beta.yaml'), 'utf8')).version_target, V);
    const other = await set('alpha.m1');
    assert.equal(other.status, 400);
    assert.match((await other.json()).error, /not a milestone of beta/);
    assert.equal((await set('beta.m9')).status, 400);
    assert.equal((await set(7)).status, 400);
    assert.equal(await target(), V, 'a refused write changes nothing');
    assert.equal((await set('beta.m1', 'beta.m2')).status, 400, 'a milestone has no target of its own');
    assert.equal((await set('')).status, 200);
    assert.equal(await target(), undefined);
    assert.ok(!('version_target' in YAML.parse(fs.readFileSync(path.join(root, 'data/goals/beta.yaml'), 'utf8'))));
  } finally { await s.stop(); cleanup(); }
});

test('target: dasks check reports one that is not a milestone of the goal, and it then holds nothing', () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-any' })]);
  try {
    const f = path.join(root, 'data/goals/beta.yaml');
    fs.writeFileSync(f, YAML.stringify({ ...YAML.parse(fs.readFileSync(f, 'utf8')), version_target: 'beta.m9' }));
    const b = loadBoard(root);
    assert.equal(b.goals.find((g) => g.id === 'beta')!.version_target, 'beta.m9');
    assert.ok(check(b).errors.some((e) => /version_target "beta\.m9" is not a milestone/.test(e.message)));
    assert.equal(versionTargets(b.goals).size, 0);
    assert.deepEqual(versionRows(b), []);
    assert.ok(!('version_target' in readyQueue(b, { versionTargets: versionTargets(b.goals) }).ready[0]));
    assert.equal(createTask(root, { goal: 'beta', title: 'New one', body: 'x' }, 'beta-lead').milestone, 'beta.m1');
  } finally { cleanup(); }
});

test('no target: nothing changes (ready, picking, roll-up, new cards, gate cards)', () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-open' }), task({ id: 'beta.t-fin', milestone: 'beta.m2', status: 'done', result: 'RESULT.md' })]);
  try {
    const b = loadBoard(root);
    const targets = versionTargets(b.goals);
    assert.equal(targets.size, 0);
    assert.deepEqual(readyQueue(b, { now: NOW, versionTargets: targets }), readyQueue(b, { now: NOW }));
    assert.ok(!('version' in rollup(b, NOW).goals.find((g) => g.id === 'beta')!));
    assert.deepEqual(versionRows(b), []);
    assert.deepEqual(gatesDue(b), []);
    assert.equal(makeGate(root, 'beta'), null);
    assert.deepEqual(pick([cand('web.t-a', { milestone: 'web.m1' }), cand('web.t-b', { milestone: 'web.m2' })]).skipped, []);
    assert.equal(createTask(root, { goal: 'beta', title: 'Follow-up', body: 'x' }, 'beta-lead').milestone, 'beta.m1');
  } finally { cleanup(); }
});

// ---------- new cards ----------

test('a card created without a milestone goes to the target; a named milestone stays', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    setTarget(root, V);
    assert.equal(createTask(root, { goal: 'beta', title: 'Review follow-up', body: 'x' }, 'beta-lead').milestone, V);
    assert.equal(createTask(root, { goal: 'beta', milestone: 'beta.m1', title: 'Elsewhere', body: 'x' }, 'beta-lead').milestone, 'beta.m1');
    assert.equal(createTask(root, { goal: 'alpha', title: 'Other goal', body: 'x' }, 'alpha-lead').milestone, 'alpha.m1');
  } finally { cleanup(); }
});

// ---------- who starts ----------

test('runner: only the target\'s cards start in that goal; p0 starts anyway; the skip names the version', () => {
  const t = { version_target: 'web.m2' };
  const x = pick([
    cand('web.t-in', { milestone: 'web.m2', ...t }),
    cand('web.t-out', { milestone: 'web.m1', ...t }),
    cand('web.t-none', { milestone: '', ...t }),
    cand('web.t-urgent', { milestone: 'web.m1', priority: 'p0', ...t }),
    cand('api.t-free', { milestone: 'api.m1' }),
  ]);
  assert.deepEqual(x.picked.map((p) => p.card).sort(), ['api.t-free', 'web.t-in', 'web.t-urgent']);
  assert.deepEqual(x.skipped, [{ card: 'web.t-out', why: 'not in version web.m2' }, { card: 'web.t-none', why: 'not in version web.m2' }]);
});

test('runner: a held card takes no spec slot, and status gets one line per goal', () => {
  const base = { goal: 'web', lane: 'claude', priority: 'p2', spec_state: 'none', version_target: 'web.m2' };
  const x = pickSpecCards({
    cands: [{ ...base, id: 'web.t-out', milestone: 'web.m1' }, { ...base, id: 'web.t-in', milestone: 'web.m2' }], running: [], cfg: { max_parallel: 1, daily_cap: 10 }, startedToday: 0,
    tools: new Set(['claude', 'codex']), backoff: {}, repos: new Map([['web', '/r/web']]), now: NOW, toolFamily: { claude: 'anthropic', codex: 'openai' },
  } as SpecPickInput);
  assert.deepEqual(x.picked.map((p) => p.card), ['web.t-in']);
  assert.deepEqual(x.skipped, [{ card: 'web.t-out', why: 'spec: not in version web.m2' }]);
  const held = versionHolds([{ goal: 'web', priority: 'p2', milestone: 'web.m1', version_target: 'web.m2' }, { goal: 'web', priority: 'p3', milestone: '', version_target: 'web.m2' }, { goal: 'web', priority: 'p0', milestone: 'web.m1', version_target: 'web.m2' }, { goal: 'api', priority: 'p2', milestone: 'api.m1' }]);
  assert.deepEqual([...held], [['web', 'version: web starts only web.m2; 2 other card(s) wait']]);
});

// ---------- version status ----------

test('status: ready needs one done card and none open; every open status holds it back', () => {
  assert.deepEqual(versionStatus(goal, [done('a'), inV('b')]), { goal: 'beta', milestone: V, total: 2, done: 1, open: 1, ready: false, gate_card: null });
  assert.equal(versionStatus(goal, [done('a'), done('b')])!.ready, true);
  assert.equal(versionStatus(goal, [])!.ready, false, 'no cards: nothing to judge');
  assert.equal(versionStatus(goal, [inV('a')])!.ready, false);
  for (const status of ['doing', 'review', 'blocked-on-user'] as const) assert.equal(versionStatus(goal, [done('a'), inV('b', { status })])!.ready, false, status);
  assert.equal(versionStatus(goal, [done('a'), task({ id: 'beta.t-x', milestone: 'beta.m1' })])!.ready, true, 'other milestones do not count');
  assert.equal(versionStatus({ ...goal, version_target: undefined }, [done('a')]), null);
});

test('status: cancelled cards do not count, in the total or towards ready', () => {
  const s = versionStatus(goal, [done('a'), done('b'), inV('gone', { status: 'cancelled' })])!;
  assert.deepEqual([s.total, s.done, s.open, s.ready], [2, 2, 0, true]);
  const all = versionStatus(goal, [inV('gone', { status: 'cancelled' })])!;
  assert.deepEqual([all.total, all.ready], [0, false], 'only cancelled cards: not ready');
});

test('launch_gate: a body line or a whole board note leaves the card out of the count; a sentence or another milestone does not', () => {
  const ready = (body: string, over = {}) => versionStatus(goal, [done('a'), inV('last', { body, ...over })])!;
  assert.deepEqual([ready(`launch_gate: ${V}\n\n## Context\nx\n`).total, ready(`launch_gate: ${V}\n`).ready], [1, true]);
  assert.equal(ready(`## Context\nx\n\n## Notes\n- 2026-11-02 12:00 beta-lead: launch_gate: ${V}\n`).ready, true);
  assert.equal(ready(`## Notes\n- 2026-11-02 12:00 beta-lead: we keep launch_gate: ${V} for later\n`).ready, false);
  assert.equal(ready(`We mention launch_gate: ${V} in a sentence.\n`).ready, false);
  assert.equal(ready('launch_gate: beta.m1\n').ready, false, 'it must name the card\'s own milestone');
  const closed = ready(`launch_gate: ${V}\n`, { status: 'done', result: 'RESULT.md' });
  assert.deepEqual([closed.total, closed.done], [1, 1], 'a closed one is left out too');
  assert.equal(versionStatus(goal, [inV('only', { body: `launch_gate: ${V}\n` })])!.ready, false, 'launch-gate cards alone are no version');
});

test('launch_gate: the note route sets it, and archiving old notes keeps it', () => {
  const { root, cleanup } = tempRepo([inV('big', { status: 'doing' })]);
  try {
    const id = 'beta.t-big';
    const note = (text: string) => updateTask(root, id, {}, 'beta-lead', { appendNote: text, warnings: [], staleHours: 24 } as any);
    note(`launch_gate: ${V}`);
    for (let i = 0; i < 24; i++) note(`long note ${i} ${'x'.repeat(480)}`);
    const t = onDisk(root).find((x) => x.id === id)!;
    assert.match(t.body, /older notes:/, 'the old notes were archived');
    assert.match(t.body, new RegExp(`^- \\S+ \\S+ beta-lead: launch_gate: ${V.replace('.', '\\.')}$`, 'm'));
  } finally { cleanup(); }
});

// ---------- the gate card ----------

test('gate: a ready version gets one card in that milestone, marked on its first line, waiting on you; it does not count as a card', () => {
  const { root, cleanup } = tempRepo([done('a'), done('b'), inV('gone', { status: 'cancelled' })]);
  try {
    setTarget(root, V);
    const b = loadBoard(root);
    assert.deepEqual(gatesDue(b).map((s) => s.milestone), [V]);
    const t = makeGate(root, 'beta')!;
    assert.equal(t.id, gateCardId('beta', V));
    assert.equal(t.milestone, V);
    assert.equal(t.status, 'blocked-on-user');
    assert.equal(t.lane, 'none', 'no runner picks it up');
    assert.equal(t.owner, 'beta-lead');
    assert.equal(t.body.trimStart().split('\n')[0], `version_gate: ${V}`);
    assert.match(t.body, /e2e/); assert.match(t.body, /batch review/);
    assert.deepEqual(checkAsk(t.needs_user), [], 'the question fits the board\'s ask rule');
    const after = loadBoard(root);
    assert.deepEqual(check(after).errors, []);
    const s = versionRows(after)[0];
    assert.deepEqual([s.total, s.done, s.ready, s.gate_card], [2, 2, true, t.id]);
    assert.deepEqual(gatesDue(after), []);
    assert.equal(makeGate(root, 'beta'), null);
  } finally { cleanup(); }
});

test('gate: never made twice, also after it was closed or cancelled, and a context write does not unmark it', () => {
  const { root, cleanup } = tempRepo([done('a')]);
  try {
    setTarget(root, V);
    const id = makeGate(root, 'beta')!.id;
    // A context write puts its block on top of the body: the card is still the gate card.
    updateTask(root, id, { status: 'review' }, 'beta-lead', { context: { what: 'Ran the e2e', why: 'Asked', do: 'Read it', rec: 'Accept', after: 'Close' }, warnings: [], staleHours: 24 } as any);
    let b = loadBoard(root);
    assert.match(b.tasks.find((t) => t.id === id)!.body.trimStart(), /^## Context/);
    assert.deepEqual([versionRows(b)[0].total, versionRows(b)[0].gate_card], [1, id]);
    updateTask(root, id, { status: 'cancelled' }, 'beta-lead', { warnings: [], staleHours: 24 } as any);
    b = loadBoard(root);
    assert.equal(versionRows(b)[0].gate_card, id, 'cancelled: once means once');
    assert.deepEqual(gatesDue(b), []);
    assert.equal(makeGate(root, 'beta'), null);
    assert.equal(gates(root).length, 1);
  } finally { cleanup(); }
});

test('gate: a card marked by hand under another id counts, and the marker only works on the first line', () => {
  const { root, cleanup } = tempRepo([done('a'), inV('mine', { status: 'cancelled', body: `version_gate: ${V}\n` })]);
  try {
    setTarget(root, V);
    assert.equal(makeGate(root, 'beta'), null);
    assert.equal(gateOf(`\n## Context\nx\n\nversion_gate: ${V}\n`), V);
    assert.equal(gateOf(`Some text\n\nversion_gate: ${V}\n`), '');
    assert.equal(versionStatus(goal, [done('a'), inV('talk', { body: `Some text\n\nversion_gate: ${V}\n` })])!.open, 1);
  } finally { cleanup(); }
});

test('gate: two callers at once make one card; a client posting the same id gets the first card or a refusal', async () => {
  const { root, cleanup } = tempRepo([done('a')]);
  try {
    setTarget(root, V);
    const script = `import { makeGate } from ${JSON.stringify(path.join(ROOT, 'src/lib/version-gate.ts'))}; console.log(makeGate(process.argv[1], 'beta')?.id ?? 'none');`;
    const run = () => new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, root], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; p.stdout.on('data', (d) => { out += d; });
      p.on('exit', () => resolve(out.trim()));
    });
    const said = await Promise.all([run(), run()]);
    assert.deepEqual(said.sort(), [gateCardId('beta', V), 'none'].sort());
    assert.equal(gates(root).length, 1);
    const late = new Date(Date.now() + 3600_000);   // past the retry window, so this is a plain second create
    const v: VersionStatus = { goal: 'beta', milestone: V, total: 1, done: 1, open: 0, ready: true, gate_card: null };
    assert.throws(() => createTask(root, gateCard(v, 'beta-lead'), 'runner@one', late), (e: HttpError) => e.status === 409);
    assert.equal(gates(root).length, 1);
    assert.equal(Number(execFileSync('git', ['-C', root, 'log', '--oneline', '--', `data/tasks/beta/t-version-gate-m2.md`], { encoding: 'utf8' }).trim().split('\n').length), 1);
  } finally { cleanup(); }
});

test('gate: the intake limit never turns it into an idea, and a milestone with a very long id still fits', () => {
  const { root, cleanup } = tempRepo([done('a')]);
  try {
    setTarget(root, V);
    const full = { ...DEFAULT_INTAKE, todo_limit: 1 };
    createTaskOrIdea(root, { goal: 'beta', milestone: 'beta.m1', title: 'Fills the limit', body: 'x' }, 'beta-lead', new Date(), { intake: full });
    assert.ok('intake' in createTaskOrIdea(root, { goal: 'beta', milestone: 'beta.m1', title: 'Over the limit', body: 'x' }, 'beta-lead', new Date(), { intake: full }));
    assert.ok(makeGate(root, 'beta'), 'the limit does not apply');
    const long = `beta.m${'x'.repeat(70)}`;
    assert.ok(gateCardId('beta', long).length <= 80);
    assert.notEqual(gateCardId('beta', long), gateCardId('beta', `${long}y`));
  } finally { cleanup(); }
});

// ---------- over HTTP ----------

test('server: /api/ready and /api/versions, then the tick makes one gate card when the last card closes', async () => {
  const { root, cleanup } = tempRepo([done('a'), inV('b', { status: 'doing' }), task({ id: 'beta.t-out' }), task({ id: 'alpha.t-free' })]);
  const s = await serve(root, { DASKS_VERSION_TICK_MS: '50' });
  const read = async (p: string) => (await fetch(s.url + p)).json();
  try {
    assert.deepEqual(await read('/api/versions'), []);
    assert.ok((await read('/api/ready?all=1')).ready.every((r: any) => !('version_target' in r)));
    assert.equal((await s.post('/api/nodes/beta', { version_target: V })).status, 200);
    const ready = (await read('/api/ready?all=1')).ready;
    assert.equal(ready.find((r: any) => r.id === 'beta.t-out').version_target, V);
    assert.ok(!('version_target' in ready.find((r: any) => r.id === 'alpha.t-free')));
    assert.deepEqual((await read('/api/versions')).map((r: any) => [r.milestone, r.done, r.total, r.ready]), [[V, 1, 2, false]]);
    assert.deepEqual((await read('/api/board')).rollup.goals.find((g: any) => g.id === 'beta').version.total, 2);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(gates(root).length, 0, 'an open card: no gate card');

    assert.equal((await s.post('/api/tasks/beta.t-b', { status: 'done', result: 'RESULT.md' })).status, 200);
    await until(async () => (await read('/api/versions'))[0]?.gate_card);
    const row = (await read('/api/versions'))[0];
    assert.deepEqual([row.ready, row.done, row.total, row.gate_card], [true, 2, 2, gateCardId('beta', V)]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(gates(root).length, 1, 'later ticks add nothing');
    assert.equal((await read('/api/tasks?status=all')).filter((t: any) => t.goal === 'alpha' && t.id.includes('version-gate')).length, 0);
    assert.match(s.logs(), new RegExp(`version: ${V.replace('.', '\\.')} is ready; made`));
  } finally { await s.stop(); cleanup(); }
});

test('web: the Goals page shows the version, in English and Korean', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
  assert.match(app, /gr\.version\.ready \? 'version\.ready' : 'version\.progress'/);
  assert.equal(i18n.match(/'version\.ready': /g)!.length, 2);
  assert.match(i18n, /'version\.progress': '\{m\}: \{d\}\/\{n\}'/);
  assert.match(i18n, /'version\.ready': '\{m\}: 판단 준비됨'/);
});
