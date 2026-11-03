// Card intake limits (throwaway repos and servers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { task, tempRepo } from './helpers.ts';
import { asHuman, humanSecrets, unusedPort, until } from './state-support.ts';
import { type Task } from '../src/lib/schema.ts';

const SERVER = path.resolve(import.meta.dirname, '../src/server.ts');

/** A board server on a temp repo with its own `intake` config, plus the human login (actor user). */
async function board(tasks: Task[], intake: Record<string, unknown>) {
  const { root, cleanup } = tempRepo(tasks);
  const human = humanSecrets();
  const port = await unusedPort();
  const cfg = path.join(root, 'test-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, intake }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, ...human.env, DASKS_ROOT: root, DASKS_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; proc.stdout.on('data', (x) => { logs += x; }); proc.stderr.on('data', (x) => { logs += x; });
  const url = `http://127.0.0.1:${port}`;
  try { await until(async () => (await fetch(url + '/api/health')).ok, 15000); } catch (e) { proc.kill(); cleanup(); human.cleanup(); throw new Error(`server did not start: ${logs}`); }
  const call = async (method: string, route: string, body?: unknown, actor = 'beta-lead') => {
    const r = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text(); let json: any = text; try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, headers: r.headers, json };
  };
  const commits = () => Number(execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
  const stop = async () => { const closed = new Promise<void>((r) => proc.once('exit', () => r())); proc.kill(); await closed; cleanup(); human.cleanup(); };
  return { root, url, call, commits, stop, logs: () => logs };
}
const todo = (id: string, over: Partial<Task> = {}) => task({ id, title: `Card ${id}`, ...over });
const post = (title: string, over: Record<string, unknown> = {}) => ({ goal: 'beta', milestone: 'beta.m1', title, body: '## Context\nthe reason for this card', ...over });

test('bot create at the limit → 202 + idea with the note, no task file, no task commit (and a retry gets the same idea)', async () => {
  const b = await board([todo('beta.t-a'), todo('beta.t-b')], { todo_limit: 2 });
  try {
    const before = b.commits();
    const r = await b.call('POST', '/api/tasks', post('Over the limit'));
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.equal(r.json.intake, 'idea');
    assert.equal(r.json.goal, 'beta');
    assert.equal(r.json.open_todo, 2);
    assert.equal(r.json.limit, 2);
    assert.match(r.json.idea.id, /^beta\.i-/);
    assert.equal(r.headers.get('x-dasks-intake'), `idea:${r.json.idea.id}`);
    const ideas = JSON.parse(fs.readFileSync(path.join(b.root, 'data/ideas/beta.json'), 'utf8')).ideas;
    const idea = ideas.find((i: any) => i.id === r.json.idea.id);
    assert.equal(idea.title, 'Over the limit');
    assert.equal(idea.source, 'intake-limit: beta-lead');
    assert.match(idea.note, /^intake limit: beta has 2 todo \(limit 2\); created by beta-lead \d{4}-\d{2}-\d{2} \d{2}:\d{2}; promote it when there is room/);
    assert.match(idea.note, /the reason for this card/);
    assert.ok(!fs.existsSync(path.join(b.root, 'data/tasks/beta/t-over-the-limit.md')), 'no task file');
    assert.equal(b.commits() - before, 1, 'one commit: the idea');
    const touched = execFileSync('git', ['-C', b.root, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' });
    assert.doesNotMatch(touched, /data\/tasks\//);
    assert.doesNotMatch(touched, /data\/activity\/(?!ideas)/);
    // Idempotent: the same create again within 15 minutes returns that idea and writes nothing.
    const again = await b.call('POST', '/api/tasks', post('Over the limit'));
    assert.equal(again.status, 202);
    assert.equal(again.json.idea.id, r.json.idea.id);
    assert.equal(b.commits() - before, 1, 'the retry wrote nothing');
  } finally { await b.stop(); }
});

test('actor user, and an actor named in intake.exempt_actors, at the limit → 201 task', async () => {
  const b = await board([todo('beta.t-a'), todo('beta.t-b')], { todo_limit: 2, exempt_actors: ['user', 'spec'] });
  try {
    const u = await asHuman(b.url, '/api/tasks', post('Mine'));
    assert.equal(u.status, 201, JSON.stringify(u.json));
    assert.equal(u.json.id, 'beta.t-mine');
    const s = await b.call('POST', '/api/tasks', post('Specs'), 'spec');
    assert.equal(s.status, 201, JSON.stringify(s.json));
    assert.equal(s.json.id, 'beta.t-specs');
  } finally { await b.stop(); }
});

test('idea promotion at the limit → task', async () => {
  const b = await board([todo('beta.t-a')], { todo_limit: 1 });
  try {
    const add = await b.call('POST', '/api/ideas/beta', { title: 'Later', note: 'n' });
    assert.equal(add.status, 201, JSON.stringify(add.json));
    const pr = await b.call('POST', `/api/ideas/beta/${add.json.id}/promote`, {});
    assert.equal(pr.status, 201, JSON.stringify(pr.json));
    assert.equal(pr.json.task.id, 'beta.t-later');
    assert.ok(fs.existsSync(path.join(b.root, 'data/tasks/beta/t-later.md')));
  } finally { await b.stop(); }
});

test('per-goal override and todo_limit 0 (off)', async () => {
  const b = await board([todo('beta.t-a'), todo('beta.t-b'), todo('gamma.t-a', { goal: 'gamma', milestone: 'gamma.m1' })], { todo_limit: 0, goal_limits: { gamma: 1 } });
  try {
    const off = await b.call('POST', '/api/tasks', post('No limit here'));
    assert.equal(off.status, 201, JSON.stringify(off.json));
    const lim = await b.call('POST', '/api/tasks', post('Gamma over', { goal: 'gamma', milestone: 'gamma.m1' }), 'gamma-lead');
    assert.equal(lim.status, 202, JSON.stringify(lim.json));
    assert.equal(lim.json.limit, 1);
    assert.equal(lim.json.open_todo, 1);
  } finally { await b.stop(); }
  // goal_limits raises one goal above todo_limit.
  const c = await board([todo('beta.t-a'), todo('beta.t-b')], { todo_limit: 2, goal_limits: { beta: 5 } });
  try { assert.equal((await c.call('POST', '/api/tasks', post('Beta has room'))).status, 201); } finally { await c.stop(); }
});

test('near-duplicate by normalized title and by slug base / -N → 409 with existing (oldest match)', async () => {
  const b = await board([
    todo('beta.t-arc', { title: 'Archive Script', created: '2026-10-20T10:00:00+09:00' }),
    todo('beta.t-oarc', { title: 'ARCHIVE  script', status: 'doing', created: '2026-10-19T10:00:00+09:00' }),
    todo('beta.t-fix', { title: 'Something different' }),
    todo('beta.t-csv-3', { title: 'Other words' }),
  ], { todo_limit: 100 });
  try {
    const t = await b.call('POST', '/api/tasks', post('archive — script!'));
    assert.equal(t.status, 409, JSON.stringify(t.json));
    assert.equal(t.json.rule, 'near-duplicate');
    assert.equal(t.json.existing, 'beta.t-oarc', 'the oldest match');
    assert.equal(t.json.error, 'near-duplicate of beta.t-oarc');
    const s = await b.call('POST', '/api/tasks', post('Fix'));
    assert.equal(s.status, 409); assert.equal(s.json.existing, 'beta.t-fix');
    const n = await b.call('POST', '/api/tasks', post('CSV'));
    assert.equal(n.status, 409); assert.equal(n.json.existing, 'beta.t-csv-3');
    // A title that normalizes to nothing never matches by title.
    assert.equal((await b.call('POST', '/api/tasks', post('!!!'))).status, 201);
  } finally { await b.stop(); }
});

test('force true → 201 and no force field stored; a non-boolean force → 400', async () => {
  const b = await board([todo('beta.t-arc', { title: 'Arc' })], { todo_limit: 100 });
  try {
    const f = await b.call('POST', '/api/tasks', post('Arc', { force: true }));
    assert.equal(f.status, 201, JSON.stringify(f.json));
    assert.equal(f.json.id, 'beta.t-arc-2');
    assert.equal(f.json.force, undefined);
    const file = fs.readFileSync(path.join(b.root, 'data/tasks/beta/t-arc-2.md'), 'utf8');
    assert.doesNotMatch(file, /^force:/m);
    assert.equal((await b.call('POST', '/api/tasks', post('Another one', { force: 'yes' }))).status, 400);
  } finally { await b.stop(); }
});

test('exact replay within 15 min still → 200 + X-Dasks-Replayed (not 409, not 202)', async () => {
  const b = await board([todo('beta.t-a')], { todo_limit: 2 });
  try {
    const first = await b.call('POST', '/api/tasks', post('Retry me'));
    assert.equal(first.status, 201, JSON.stringify(first.json));
    // Now beta has 2 todo (= the limit) and an open card with this title: the retry is still a replay.
    const again = await b.call('POST', '/api/tasks', post('Retry me'));
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.headers.get('x-dasks-replayed'), first.json.id);
    assert.equal(again.json.id, first.json.id);
  } finally { await b.stop(); }
});

test('a done or cancelled task with the same title → no 409', async () => {
  const b = await board([
    todo('beta.t-oldth', { title: 'Old thing', status: 'done', result: 'done, log /tmp/x.log' }),
    todo('beta.t-gonet', { title: 'Gone thing', status: 'cancelled' }),
  ], { todo_limit: 100 });
  try {
    const a = await b.call('POST', '/api/tasks', post('Old thing'));
    assert.equal(a.status, 201, JSON.stringify(a.json));
    const c = await b.call('POST', '/api/tasks', post('gone thing'));
    assert.equal(c.status, 201, JSON.stringify(c.json));
  } finally { await b.stop(); }
});

test('/api/ready is strict by default; ?all=1 and ?require_spec_ready=0 give the full list; ?all=x → 400', async () => {
  const b = await board([todo('beta.t-nospc', { title: 'No spec yet' })], { todo_limit: 100 });
  try {
    const ids = (r: any) => r.json.ready.map((i: any) => i.id);
    const def = await b.call('GET', '/api/ready');
    assert.equal(def.status, 200);
    assert.ok(!ids(def).includes('beta.t-nospc'), 'default leaves out a card with no spec');
    for (const i of def.json.ready) assert.equal(i.spec_state, 'ready');
    assert.ok(Array.isArray(def.json.blocked) && Array.isArray(def.json.cycles));
    for (const q of ['?all=1', '?all=true', '?require_spec_ready=0', '?require_spec_ready=false', '?all=1&require_spec_ready=1']) {
      const r = await b.call('GET', `/api/ready${q}`);
      assert.equal(r.status, 200, q);
      assert.ok(ids(r).includes('beta.t-nospc'), `${q} lists the full queue`);
      assert.equal(r.json.ready.find((i: any) => i.id === 'beta.t-nospc').spec_state, 'none');
    }
    for (const q of ['?all=0', '?require_spec_ready=1', '?all=false&require_spec_ready=1']) assert.ok(!ids(await b.call('GET', `/api/ready${q}`)).includes('beta.t-nospc'), q);
    assert.equal((await b.call('GET', '/api/ready?all=x')).status, 400);
    assert.equal((await b.call('GET', '/api/ready?require_spec_ready=x')).status, 400);
  } finally { await b.stop(); }
});

test('/api/intake counts todo by goal, owner, id_family and spec_state', async () => {
  const { intakeReport } = await import('../src/lib/intake.ts');
  const now = new Date('2026-10-29T12:00:00+09:00');
  const t = (id: string, o: Record<string, unknown> = {}) => ({ id, goal: id.split('.')[0], status: 'todo', owner: 'delta-lead', created: '2026-10-29T08:00:00+09:00', ...o });
  const r = intakeReport({ tasks: [
    t('delta.t-f-u-l'), t('delta.t-f-u-g'), t('delta.t-solo', { created: '2026-10-20T08:00:00+09:00' }),
    t('shared.t-revx', { owner: 'shared-lead' }), t('shared.t-noown', { owner: '', created: 'garbage' }),
    t('shared.t-done1', { status: 'done' }), t('beta.t-doin1', { status: 'doing' }),
  ] } as any, new Map([['delta.t-f-u-g', { spec_state: 'ready' }], ['shared.t-revx', { spec_state: 'draft' }]]) as any, now);
  assert.equal(r.total, 5);
  assert.deepEqual(r.by_goal, { delta: 3, shared: 2 });
  assert.deepEqual(r.by_creator, { 'delta-lead': 3, 'shared-lead': 1, '(none)': 1 });
  assert.deepEqual(r.by_id_family, { 'f-u': 2, solo: 1, revx: 1, noown: 1 });
  assert.deepEqual(Object.keys(r.by_id_family).slice(0, 1), ['f-u'], 'sorted by count');
  assert.deepEqual(r.by_spec_state, { none: 3, ready: 1, draft: 1 });
  assert.equal(r.created_last_24h, 3);
  // Over HTTP, on a real board, with ?goal=.
  const b = await board([todo('beta.t-fix-a'), todo('beta.t-fix-b', { owner: 'user', started_by: 'user' }), todo('shared.t-x', { goal: 'shared', milestone: 'shared.m1' })], { todo_limit: 100 });
  try {
    const all = await b.call('GET', '/api/intake');
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.equal(all.json.total, 3);
    assert.deepEqual(all.json.by_goal, { beta: 2, shared: 1 });
    assert.deepEqual(all.json.by_creator, { 'beta-lead': 2, user: 1 });
    assert.deepEqual(all.json.by_id_family, { 'fix-a': 1, 'fix-b': 1, x: 1 });
    assert.deepEqual(all.json.by_spec_state, { none: 3 });
    assert.equal(typeof all.json.created_last_24h, 'number');
    const beta = await b.call('GET', '/api/intake?goal=beta');
    assert.equal(beta.json.total, 2);
    assert.deepEqual(beta.json.by_goal, { beta: 2 });
  } finally { await b.stop(); }
});


