// MCP agent reads (ready_tasks deltas, claim_task) through a real server and MCP process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createTask } from '../src/lib/write.ts';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const MCP = path.join(ROOT, 'mcp/dasks-mcp.mjs');
const ACTOR = 'claude-code@desktop';
const SLIM_KEYS = new Set(['rank', 'id', 'title', 'goal', 'priority', 'kind', 'unblocks', 'depends_on', 'spec_state', 'pushed', 'push_note']);

function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
}
async function startServer(root: string, port?: number): Promise<{ url: string; proc: ChildProcess; port: number }> {
  port ??= await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc, port }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
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

// ---------- fixture: R1 (p1), R2 (p2) ready; B1 waits on R1 ----------
const stopped = (p: ChildProcess) => new Promise<void>((res) => { if (p.exitCode !== null || p.signalCode !== null) return res(); p.once('exit', () => res()); p.kill(); });

async function fixture() {
  const { root, cleanup } = tempRepo();
  const R1 = createTask(root, { goal: 'shared', title: 'R1', priority: 'p1' }, 'helper').id;
  const R2 = createTask(root, { goal: 'shared', title: 'R2', priority: 'p2' }, 'helper').id;
  const B1 = createTask(root, { goal: 'shared', title: 'B1', priority: 'p2', depends_on: [R1] } as any, 'helper').id;
  const procs: ChildProcess[] = [];
  let srv = await startServer(root);
  procs.push(srv.proc);
  const f = {
    root, R1, R2, B1,
    get url() { return srv.url; },
    mcp() { const m = mcp(srv.url, ACTOR); procs.push(m.proc); return m; },
    async stopServer() { await stopped(srv.proc); },
    async restartServer() { srv = await startServer(root, srv.port); procs.push(srv.proc); },
    post: (p: string, body: any, actor: string) => fetch(srv.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) }),
    async done() { for (const p of procs) await stopped(p); cleanup(); },
  };
  return f;
}

test('ready_tasks first call lists every ready card slim with blocked count', async () => {
  const f = await fixture();
  try {
    const m = f.mcp();
    const r = await m.call('ready_tasks', { all: true });
    assert.equal(r.err, false, r.text);
    assert.deepEqual(r.json.ready.map((x: any) => x.id), [f.R1, f.R2]);
    assert.deepEqual(r.json.ready.map((x: any) => x.rank), [1, 2]);
    for (const it of r.json.ready) for (const k of Object.keys(it)) assert.ok(SLIM_KEYS.has(k), `unexpected key ${k}`);
    assert.equal(r.json.unchanged, 0);
    assert.deepEqual(r.json.gone, []);
    assert.deepEqual(r.json.blocked, { count: 1 });
  } finally { await f.done(); }
});

test('second call with no change lists nothing', async () => {
  const f = await fixture();
  try {
    const m = f.mcp();
    await m.call('ready_tasks', { all: true });
    const r = await m.call('ready_tasks', { all: true });
    assert.equal(r.err, false, r.text);
    assert.deepEqual(r.json.ready, []);
    assert.equal(r.json.unchanged, 2);
    assert.deepEqual(r.json.gone, []);
  } finally { await f.done(); }
});

test('a changed card is listed again', async () => {
  const f = await fixture();
  try {
    const m = f.mcp();
    await m.call('ready_tasks', { all: true });
    const u = await f.post(`/api/tasks/${f.R2}`, { title: 'R2 renamed' }, 'helper');
    assert.equal(u.status, 200, await u.text());
    const r = await m.call('ready_tasks', { all: true });
    assert.equal(r.err, false, r.text);
    assert.deepEqual(r.json.ready.map((x: any) => x.id), [f.R2]);
    assert.equal(r.json.ready[0].title, 'R2 renamed');
    assert.equal(r.json.unchanged, 1);
  } finally { await f.done(); }
});

test('a claimed card is gone', async () => {
  const f = await fixture();
  try {
    const m = f.mcp();
    await m.call('ready_tasks', { all: true });
    const c = await f.post(`/api/tasks/${f.R1}/claim`, {}, 'helper@desktop');
    assert.equal(c.status, 200, await c.text());
    const r = await m.call('ready_tasks', { all: true });
    assert.equal(r.err, false, r.text);
    assert.deepEqual(r.json.gone, [f.R1]);
    assert.deepEqual(r.json.ready, []);
    assert.equal(r.json.unchanged, 1);
  } finally { await f.done(); }
});

test('all:true and the default keep separate seen lists', async () => {
  const f = await fixture();
  try {
    const m = f.mcp();
    await m.call('ready_tasks', { all: true });
    // The fixture has no ready specs: the default reply is empty, and must not report the all:true cards as gone.
    const r = await m.call('ready_tasks', {});
    assert.equal(r.err, false, r.text);
    assert.deepEqual(r.json.ready, []);
    assert.deepEqual(r.json.gone, []);
  } finally { await f.done(); }
});

test('full:true returns the server reply unchanged', async () => {
  const f = await fixture();
  try {
    const m = f.mcp();
    const r = await m.call('ready_tasks', { full: true, all: true });
    assert.equal(r.err, false, r.text);
    const server = await (await fetch(f.url + '/api/ready?all=1')).json();
    assert.deepEqual(r.json, server);
  } finally { await f.done(); }
});

test('a new MCP process starts full', async () => {
  const f = await fixture();
  try {
    const m1 = f.mcp();
    await m1.call('ready_tasks', { all: true });
    const m2 = f.mcp();
    const r = await m2.call('ready_tasks', { all: true });
    assert.equal(r.err, false, r.text);
    assert.deepEqual(r.json.ready.map((x: any) => x.id), [f.R1, f.R2]);
    assert.equal(r.json.unchanged, 0);
  } finally { await f.done(); }
});

test('claim_task default reply is four fields', async () => {
  const f = await fixture();
  try {
    const m = f.mcp();
    const r = await m.call('claim_task', { id: f.R1 });
    assert.equal(r.err, false, r.text);
    assert.deepEqual(Object.keys(r.json), ['id', 'version', 'status', 'claimed_by']);
    assert.equal(r.json.status, 'doing');
    assert.ok(r.text.length / 4 <= 100, `claim reply ${r.text.length} chars`);
  } finally { await f.done(); }
});

test('claim_task body:true gives the whole task', async () => {
  const f = await fixture();
  try {
    const m = f.mcp();
    const r = await m.call('claim_task', { id: f.R2, body: true });
    assert.equal(r.err, false, r.text);
    assert.ok('body' in r.json, 'reply has body');
    assert.ok('title' in r.json, 'reply has title');
  } finally { await f.done(); }
});

test('ready_tasks error leaves memory', async () => {
  const f = await fixture();
  try {
    const m = f.mcp();
    const first = await m.call('ready_tasks', { all: true });
    assert.equal(first.json.ready.length, 2);
    await f.stopServer();
    const e = await m.call('ready_tasks', { all: true });
    assert.equal(e.err, true);
    await f.restartServer();
    const r = await m.call('ready_tasks', { all: true });
    assert.equal(r.err, false, r.text);
    assert.deepEqual(r.json.ready, []);
    assert.equal(r.json.unchanged, 2);
  } finally { await f.done(); }
});
