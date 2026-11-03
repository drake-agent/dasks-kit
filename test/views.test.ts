// Per-project views, the CLI, the MCP tool list, /p/<app> pages and client retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { defaultView, readView, validateView, writeView, checkViews, projectIds } from '../src/lib/views.ts';
import { git, HttpError, createTask, updateTask } from '../src/lib/write.ts';
import { loadBoard } from '../src/lib/load.ts';
import { tempRepo } from './helpers.ts';

const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return e instanceof HttpError ? e.status : -1; } };
const SERVER = path.resolve(import.meta.dirname, '../src/server.ts');
const GB = path.resolve(import.meta.dirname, '../mcp/board-cli.mjs');
const MCP = path.resolve(import.meta.dirname, '../mcp/dasks-mcp.mjs');

test('views: defaults for every project, nothing written', () => {
  const { root, cleanup } = tempRepo();
  try {
    for (const app of ['alpha', 'beta', 'gamma', 'delta', 'shared']) {
      const v = readView(root, app);
      assert.equal(v.default, true); assert.equal(v.version, 0); assert.ok(v.widgets.length);
      validateView(app, v, undefined); // defaults pass their own validation
    }
    assert.deepEqual(projectIds(loadBoard(root)).sort(), ['alpha', 'beta', 'delta', 'gamma', 'shared']);
    const beta = defaultView('beta');
    // every project starts the same: stat cards, a stage timeline, then the work in its structure
    assert.equal(beta.widgets[0].type, 'stats'); assert.deepEqual(beta.widgets[0].items, ['stage', 'needs_you', 'running', 'progress']);
    assert.ok(beta.widgets.some((w) => w.type === 'work'));
    assert.ok(defaultView('delta').widgets.some((w) => w.type === 'timeline'));
    assert.deepEqual(defaultView('shared'), { ...defaultView('beta'), app: 'shared' }, 'no project has its own built-in layout');
    assert.equal(fs.existsSync(path.join(root, 'data/views')), false);
    assert.throws(() => readView(root, 'nope'), /no project/);
  } finally { cleanup(); }
});

test('views: validation refuses bad widgets and fields', () => {
  const ms = new Set(['beta.m1', 'beta.m2']);
  const bad: [unknown, RegExp][] = [
    [{ widgets: [] }, /non-empty/],
    [{ widgets: [{ type: 'pie' }] }, /unknown type "pie"/],
    [{ widgets: [{ type: 'countdown' }] }, /"date" is required/],
    [{ widgets: [{ type: 'countdown', date: '2026-02-30' }] }, /YYYY-MM-DD/],
    [{ widgets: [{ type: 'countdown', date: '2026-10-17', tz: 'KST' }] }, /UTC offset/],
    [{ widgets: [{ type: 'stats', items: ['speed'] }] }, /unknown item "speed"/],
    [{ widgets: [{ type: 'needs_you', limit: 0 }] }, /1-50/],
    [{ widgets: [{ type: 'needs_you', color: 'red' }] }, /unknown field "color"/],
    [{ widgets: [{ type: 'stages', milestones: ['alpha.m1'] }] }, /unknown milestone "alpha.m1"/],
    [{ widgets: [{ type: 'map', nodes: [{ label: 'x' }] }] }, /milestone or match/],
    [{ widgets: [{ type: 'map', nodes: [{ label: 'x', milestone: 'beta.m1', rest: true, match: ['a'] }] }] }, /takes no match/],
    [{ widgets: [{ type: 'track' }] }, /"match" is required/],
    [{ widgets: [{ type: 'apps', span: 'third' }] }, /full" or "half/],
    [{ widgets: Array(13).fill({ type: 'apps' }) }, /at most 12/],
    [{ widgets: [{ type: 'apps' }], layout: 'x' }, /unknown field/],
    [{ app: 'alpha', widgets: [{ type: 'apps' }] }, /does not match/],
    [[], /JSON object/],
    [{ widgets: [{ type: 'constructor' }] }, /unknown type/],
    [{ widgets: [{ type: '__proto__' }] }, /unknown type/],
    [{ widgets: [{ type: 'apps', toString: 'x' }] }, /unknown field "toString"/],
  ];
  for (const [v, re] of bad) assert.throws(() => validateView('beta', v, ms), re, JSON.stringify(v));
  const ok = validateView('beta', { title: ' Beta ', widgets: [{ type: 'countdown', date: '2026-10-17', time: '09:30', tz: '+09:00', label: 'Ship', span: 'half' }, { type: 'map', nodes: [{ label: 'A', milestone: 'beta.m1', match: ['x'] }, { label: 'B', milestone: 'beta.m1', rest: true }] }] }, ms);
  assert.equal(ok.title, 'Beta'); assert.equal(ok.widgets.length, 2);
});

test('views: write bumps version, records the actor, 409 on stale expected_version, no-op keeps version', () => {
  const { root, cleanup } = tempRepo();
  const board = () => loadBoard(root);
  const view = { widgets: [{ type: 'stats' }, { type: 'stages', milestones: ['beta.m1'] }] };
  try {
    assert.equal(status(() => writeView(root, 'beta', view, 'codex@desktop', { expectedVersion: 3 })), 409);
    const v1 = writeView(root, 'beta', view, 'codex@desktop', { expectedVersion: 0, now: new Date('2026-10-11T12:00:00Z') });
    assert.equal(v1.version, 1); assert.equal(v1.updated_by, 'codex@desktop'); assert.equal(v1.default, undefined);
    assert.equal(git(root, ['log', '-1', '--format=%s']).trim(), 'codex@desktop: view beta v1');
    assert.deepEqual(git(root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort(), ['data/activity/views/beta.jsonl', 'data/views/beta.json']);
    const stale = (() => { try { writeView(root, 'beta', { widgets: [{ type: 'apps' }] }, 'helper', { expectedVersion: 0 }); } catch (e: any) { return e; } })();
    assert.equal(stale.status, 409); assert.equal(stale.data.current_version, 1);
    assert.equal(writeView(root, 'beta', view, 'helper', { expectedVersion: 1 }).version, 1, 'same content: no new version');
    const v2 = writeView(root, 'beta', { title: 'Ship', widgets: [{ type: 'apps' }] }, 'claude-code@laptop');
    assert.equal(v2.version, 2, 'no expected_version = unconditional'); assert.equal(v2.title, 'Ship');
    assert.equal(status(() => writeView(root, 'beta', { widgets: [{ type: 'stages', milestones: ['beta.m9'] }] }, 'helper')), 400);
    assert.equal(status(() => writeView(root, 'nope', view, 'helper')), 404);
    assert.equal(readView(root, 'beta').version, 2);
    const acts = fs.readFileSync(path.join(root, 'data/activity/views/beta.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(acts.map((a) => `${a.actor} ${a.action}`), ['codex@desktop create', 'claude-code@laptop edit']);
    // dasks check (pre-commit hook) accepts the stored views; a stale milestone is only a warning
    assert.deepEqual(checkViews(root, board()), []);
    fs.writeFileSync(path.join(root, 'data/views/delta.json'), JSON.stringify({ version: 1, widgets: [{ type: 'timeline', milestones: ['delta.m-gone'] }] }));
    assert.match(checkViews(root, board())[0].message, /unknown milestone/);
    // a broken file keeps its version: a stale writer still gets 409, the right version can repair it
    fs.writeFileSync(path.join(root, 'data/views/delta.json'), '{"version":7,"widgets":[{"type":"pie"}]}');
    assert.match(checkViews(root, board())[0].message, /unknown type/);
    assert.equal(status(() => readView(root, 'delta')), 409);
    assert.equal(status(() => writeView(root, 'delta', { widgets: [{ type: 'timeline' }] }, 'helper', { expectedVersion: 0 })), 409);
    // repairing it with exactly the default layout still writes (no "nothing changed" shortcut for a broken file)
    assert.equal(writeView(root, 'delta', defaultView('delta'), 'helper', { expectedVersion: 7 }).version, 8);
    assert.equal(readView(root, 'delta').version, 8);
    // unparseable: version 0
    fs.writeFileSync(path.join(root, 'data/views/delta.json'), '{oops');
    assert.equal(writeView(root, 'delta', { widgets: [{ type: 'timeline' }] }, 'helper', { expectedVersion: 0 }).version, 1);
    // milestone references are checked against the board on disk at write time
    fs.writeFileSync(path.join(root, 'data/goals/beta.yaml'), fs.readFileSync(path.join(root, 'data/goals/beta.yaml'), 'utf8').replace('id: beta.m1\n', 'id: beta.m1x\n'));
    assert.equal(status(() => writeView(root, 'beta', { widgets: [{ type: 'stages', milestones: ['beta.m1'] }] }, 'helper')), 400);
  } finally { cleanup(); }
});

// ---------- live server ----------
async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}
async function startServer(root: string, port?: number): Promise<{ url: string; proc: ChildProcess }> {
  port ??= await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
}
const exited = (p: ChildProcess) => new Promise<number | null>((r) => (p.exitCode !== null ? r(p.exitCode) : p.once('exit', (c) => r(c))));

function cli(url: string, actor: string, prog: 'gb' | 'dasks', args: string[], input?: string) {
  const env: Record<string, string | undefined> = { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor, DASKS_PROG: prog };
  try { return { code: 0, out: execFileSync(process.execPath, [GB, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', stdio: 'pipe', input }) }; }
  catch (e: any) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
}

function mcp(url: string, actor: string) {
  const proc = spawn(process.execPath, [MCP], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; let next = 1;
  const waiting = new Map<number, (v: any) => void>();
  proc.stdout!.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  const rpc = (method: string, params: any = {}) => new Promise<any>((res) => { const id = next++; waiting.set(id, res); proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name: string, args: any) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { err: !!r.isError, text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() }; };
  return { proc, rpc, call };
}

test('live: view API, pages, MCP view and task tools', async () => {
  const { root, cleanup } = tempRepo();
  createTask(root, { goal: 'beta', title: 'Needs a key', status: 'blocked-on-user', needs_user: 'key' }, 'user');
  createTask(root, { goal: 'beta', title: 'Run' }, 'user');
  updateTask(root, 'beta.t-run', { status: 'doing' }, 'user');
  createTask(root, { goal: 'beta', title: 'Done' }, 'user');
  updateTask(root, 'beta.t-done', { status: 'done', result: 'run/test.log' }, 'user');
  const { url, proc } = await startServer(root);
  const m = mcp(url, 'claude-code@desktop');
  try {
    for (const p of ['/', '/p/beta', '/p/gamma', '/p/alpha', '/p/delta', '/p/shared', '/p/beta/']) {
      const r = await fetch(url + p); assert.equal(r.status, 200, p); assert.match(await r.text(), /<title>Dasks<\/title>/);
    }
    let r: Response;
    assert.equal((await fetch(url + '/p/nope')).status, 404);
    for (const p of ['/p/constructor', '/p/tostring', '/api/views/constructor', '/api/views/__proto__']) assert.equal((await fetch(url + p, { redirect: 'manual' })).status, 404, p);

    const list = await (await fetch(url + '/api/views')).json();
    assert.deepEqual(list.map((v: any) => [v.app, v.version, v.default]), [['alpha', 0, true], ['beta', 0, true], ['delta', 0, true], ['gamma', 0, true], ['shared', 0, true]]);
    const d0 = await (await fetch(url + '/api/views/beta')).json();
    assert.equal(d0.default, true); assert.equal(d0.url, '/p/beta'); assert.deepEqual(d0.activity, []);
    assert.equal((await (await fetch(url + '/api/views/alpha')).json()).app, 'alpha');
    assert.equal((await fetch(url + '/api/views/nope')).status, 404);
    const put = (app: string, body: any, actor = 'codex@desktop', method = 'PUT', headers: Record<string, string> = {}) =>
      fetch(`${url}/api/views/${app}`, { method, headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor, ...headers }, body: JSON.stringify(body) });
    r = await put('beta', { widgets: [{ type: 'pie' }] });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /unknown type/);
    r = await put('beta', { widgets: [{ type: 'stats' }], expected_version: 5 });
    assert.equal(r.status, 409); assert.equal((await r.json()).current_version, 0);
    r = await put('beta', { ...d0, widgets: [{ type: 'countdown', date: '2026-10-17' }, { type: 'needs_you' }], expected_version: 0, url: undefined, activity: undefined });
    assert.equal(r.status, 200); const d1 = await r.json(); assert.equal(d1.version, 1); assert.equal(d1.updated_by, 'codex@desktop');
    r = await put('beta', { widgets: [{ type: 'stats' }] }, 'x', 'PUT', { Origin: 'http://evil.example' });
    assert.equal(r.status, 403, 'cross-origin view write refused');
    r = await put('beta', { widgets: [{ type: 'stats' }], expected_version: 1 }, 'helper', 'POST');
    assert.equal(r.status, 200, 'POST works too'); assert.equal((await r.json()).version, 2);
    r = await fetch(`${url}/api/views/beta`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'dasks-agent' }, body: JSON.stringify({ widgets: [{ type: 'apps' }] }) });
    assert.equal((await r.json()).updated_by, 'dasks-agent', 'X-Dasks-Actor works as an actor header alias');
    assert.equal((await fetch(`${url}/api/tasks/beta.t-done`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 405);

    // MCP: task and view tools are listed and work
    const init = await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'dasks'); assert.match(init.result.instructions, /Dasks/);
    const tools = (await m.rpc('tools/list')).result.tools.map((t: any) => t.name);
    for (const n of ['list_goals', 'list_tasks', 'get_task', 'create_task', 'update_task', 'claim_task', 'finish_task', 'release_task', 'get_view', 'set_view']) assert.ok(tools.includes(n), n);
    assert.ok((await m.call('list_goals', {})).json.goals.some((g: any) => g.app === 'beta'));
    const gv = await m.call('get_view', { app: 'delta' });
    assert.equal(gv.json.default, true); assert.match(gv.json.widget_catalog, /timeline/);
    assert.equal((await m.call('get_view', {})).json.length, 5);
    const sv = await m.call('set_view', { app: 'delta', view: gv.json, expected_version: 0 });
    assert.equal(sv.err, false, sv.text); assert.equal(sv.json.version, 1); assert.equal(sv.json.updated_by, 'claude-code@desktop');
    const conflict = await m.call('set_view', { app: 'delta', view: { widgets: [{ type: 'apps' }] }, expected_version: 0 });
    assert.equal(conflict.err, true); assert.match(conflict.text, /"current_version":1/);

  } finally { m.proc.kill(); proc.kill(); cleanup(); }
});

test('CLI: gb and dasks are the same tool; DASKS_* env; view get/set', async () => {
  const { root, cleanup } = tempRepo();
  const { url, proc } = await startServer(root);
  try {
    assert.match(cli(url, 'cli@desktop', 'gb', ['help']).out, /^gb — Dasks/);
    assert.match(cli(url, 'cli@desktop', 'dasks', ['help']).out, /^dasks — Dasks[\s\S]*dasks view set <app>/);
    assert.match(cli(url, 'cli@desktop', 'gb', ['new', 'shared', 'Gb']).out, /shared\.t-gb\b/);
    assert.match(cli(url, 'cli@desktop', 'dasks', ['new', 'shared', 'Dasks']).out, /shared\.t-dasks\b/);
    const gbList = cli(url, 'x', 'gb', ['tasks', '--app', 'shared']).out;
    assert.equal(gbList, cli(url, 'x', 'dasks', ['tasks', '--app', 'shared']).out, 'same output under both names');
    assert.match(gbList, /shared\.t-dasks\b/);
    assert.match(git(root, ['log', '-1', '--format=%s']), /^cli@desktop: create shared\.t-dasks\b/, 'DASKS_ACTOR is the actor');
    assert.match(cli(url, 'x', 'dasks', ['views']).out, /^alpha\s+default\s+\/p\/alpha/m);
    const v = JSON.parse(cli(url, 'x', 'gb', ['view', 'gamma']).out);
    assert.equal(v.version, 0); assert.equal(v.activity, undefined);
    const file = path.join(root, 'view.json');
    fs.writeFileSync(file, JSON.stringify({ ...v, title: 'Gamma' }));
    assert.match(cli(url, 'cli@desktop', 'dasks', ['view', 'set', 'gamma', file]).out, /gamma view v1 saved by cli@desktop/);
    const again = cli(url, 'cli@desktop', 'dasks', ['view', 'set', 'gamma', file]);
    assert.equal(again.code, 1, 'the file still says version 0: conflict'); assert.match(again.out, /409/);
    assert.match(cli(url, 'cli@desktop', 'gb', ['view', 'set', 'gamma', '-', '--version', '1'], JSON.stringify({ widgets: [{ type: 'apps' }] })).out, /v2/);
    assert.equal(cli(url, 'cli@desktop', 'gb', ['view', 'set', 'gamma', '-'], 'not json').code, 2);
  } finally { proc.kill(); await exited(proc); cleanup(); } // wait for the exit before removing the folder
});

test('restart: SIGTERM drains and exits 0; clients retry while the board is down', async () => {
  const { root, cleanup } = tempRepo();
  const port = await freePort();
  let { url, proc } = await startServer(root, port);
  try {
    proc.kill('SIGTERM');
    assert.equal(await exited(proc), 0);
    // start a client while nothing listens, bring the server back 600 ms later: the client must succeed
    const env = { ...process.env, DASKS_URL: url, DASKS_ACTOR: 'cli@desktop', DASKS_PROG: 'dasks' };
    const child = spawn(process.execPath, [GB, 'new', 'shared', 'Down'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout!.on('data', (d) => { out += d; }); child.stderr!.on('data', (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 600));
    ({ url, proc } = await startServer(root, port));
    assert.equal(await exited(child), 0, out);
    assert.match(out, /shared\.t-down\b/);
  } finally { proc.kill(); await exited(proc); cleanup(); } // wait for the exit before removing the folder
});
