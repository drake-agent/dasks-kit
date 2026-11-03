// The handoff summary field and short task reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createTask, HttpError, normSummary, updateTask } from '../src/lib/write.ts';
import { checkTask } from '../src/lib/check.ts';
import { loadBoard } from '../src/lib/load.ts';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const MCP = path.join(ROOT, 'mcp/dasks-mcp.mjs');
const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return e instanceof HttpError ? e.status : -1; } };

test('normSummary: trims, drops blank lines, refuses more than 5 lines or long lines, never cuts', () => {
  assert.equal(normSummary('  a  \r\n\n  b   c \r d\n'), 'a\nb c\nd');
  assert.equal(normSummary(' \n '), '');
  assert.equal(normSummary('1\n2\n3\n4\n5'), '1\n2\n3\n4\n5');
  assert.equal(status(() => normSummary('1\n2\n3\n4\n5\n6')), 400);
  assert.equal(status(() => normSummary('x'.repeat(201))), 400);
  assert.equal(normSummary('x'.repeat(200)).length, 200);
});

test('summary: set, stamped with who and when, same text keeps the stamp, "" clears it; stamps are not writable', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'shared', title: 'Card' }, 'helper');
    const now = new Date('2026-10-24T10:00:00+09:00');
    const a = updateTask(root, t.id, { summary: 'Parser done.\nNext: wire the MCP.' }, 'claude-code@laptop', { now });
    assert.equal(a.summary, 'Parser done.\nNext: wire the MCP.');
    assert.equal(a.summary_by, 'claude-code@laptop');
    assert.equal(Date.parse(a.summary_at!), now.getTime()); // isoLocal: the machine's own offset, so compare instants
    const raw = fs.readFileSync(path.join(root, a.file), 'utf8');
    assert.match(raw, /^summary: \|/m);
    assert.equal(loadBoard(root).tasks.find((x) => x.id === t.id)!.summary, a.summary);
    const b = updateTask(root, t.id, { summary: ' Parser done. \n\nNext: wire the MCP.' }, 'helper', { now: new Date('2026-10-24T11:00:00+09:00') });
    assert.equal(b.summary_by, 'claude-code@laptop'); assert.equal(b.version, a.version);
    assert.equal(status(() => updateTask(root, t.id, { summary: '1\n2\n3\n4\n5\n6' }, 'helper')), 400);
    assert.equal(loadBoard(root).tasks.find((x) => x.id === t.id)!.summary, a.summary);
    assert.equal(status(() => updateTask(root, t.id, { summary_by: 'user' }, 'helper')), 400);
    assert.equal(status(() => updateTask(root, t.id, { summary_at: '2026-10-24T10:00:00+09:00' }, 'helper')), 400);
    const c = updateTask(root, t.id, { summary: '' }, 'helper');
    assert.equal(c.summary ?? '', ''); assert.equal(c.summary_by ?? '', ''); assert.equal(c.summary_at ?? '', '');
    assert.doesNotMatch(fs.readFileSync(path.join(root, c.file), 'utf8'), /^summary/m);
  } finally { cleanup(); }
});

test('check: a hand-edited summary over 5 lines or with a bad stamp is an error', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'shared', title: 'Card' }, 'helper');
    const abs = path.join(root, t.file);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(/^---\n/, '---\nsummary: |-\n  1\n  2\n  3\n  4\n  5\n  6\nsummary_by: "bad actor!"\n'));
    const msgs = checkTask(loadBoard(root).tasks.find((x) => x.id === t.id)!).join('; ');
    assert.match(msgs, /summary is over 5 lines/);
    assert.match(msgs, /bad summary_by/);
  } finally { cleanup(); }
});

// ---------- live: HTTP + MCP ----------
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
}
async function startServer(root: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
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

test('live: finish / release / update set the summary; ?log=N trims the activity and counts the rest; MCP get_task reads 8', async () => {
  const { root, cleanup } = tempRepo();
  const t = createTask(root, { goal: 'shared', title: 'Long card' }, 'helper');
  const { url, proc } = await startServer(root);
  const m = mcp(url, 'claude-code@laptop');
  const post = (p: string, body: any, actor = 'claude-code@laptop') => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });
  const get = async (q = '') => (await fetch(`${url}/api/tasks/${t.id}${q}`)).json();
  try {
    for (let i = 0; i < 20; i++) assert.equal((await post(`/api/tasks/${t.id}`, { note: `step ${i}` }, 'helper')).status, 200);
    assert.equal((await post(`/api/tasks/${t.id}/claim`, {})).status, 200);
    assert.equal((await post(`/api/tasks/${t.id}/claim`, { summary: 'x' })).status, 400);
    let r = await post(`/api/tasks/${t.id}/release`, { note: 'stopping', summary: 'Stopped at the parser.\nTests pass.' });
    assert.equal(r.status, 200);
    let x = await r.json();
    assert.equal(x.summary, 'Stopped at the parser.\nTests pass.'); assert.equal(x.summary_by, 'claude-code@laptop'); assert.ok(x.summary_at);
    assert.equal((await post(`/api/tasks/${t.id}/release`, { summary: '1\n2\n3\n4\n5\n6' })).status, 400);
    // a log path in the result counts as done evidence
    r = await post(`/api/tasks/${t.id}/finish`, { result: 'done, see logs/run.log', status: 'done', summary: 'Shipped.' }, 'helper');
    assert.equal(r.status, 200); x = await r.json();
    assert.equal(x.summary, 'Shipped.'); assert.equal(x.summary_by, 'helper');
    // the default read keeps 50 entries because the board UI uses it
    const full = await get();
    assert.equal(full.activity_total, full.activity.length); assert.equal(full.activity_omitted, 0);
    assert.ok(full.activity_total > 20);
    const short = await get('?log=8');
    assert.equal(short.activity.length, 8);
    assert.equal(short.activity_omitted, full.activity_total - 8);
    assert.deepEqual(short.activity, full.activity.slice(-8));
    assert.equal((await get('?log=0')).activity.length, 0);
    assert.equal((await get('?log=99')).activity.length, Math.min(50, full.activity_total));
    assert.equal((await fetch(`${url}/api/tasks/${t.id}?log=-1`)).status, 400);
    assert.equal((await fetch(`${url}/api/tasks/${t.id}?log=abc`)).status, 400);
    await m.rpc('initialize', { protocolVersion: '2025-06-18' });
    let g = await m.call('get_task', { id: t.id });
    assert.equal(g.err, false);
    assert.equal(g.json.summary, 'Shipped.'); assert.equal(g.json.activity.length, 8); assert.equal(g.json.activity_omitted, full.activity_total - 8);
    assert.equal((await m.call('get_task', { id: t.id, log: 3 })).json.activity.length, 3);
    const u = await m.call('update_task', { id: t.id, summary: 'Reopened for a fix.\nSee the PR comment.' });
    assert.equal(u.err, false, u.text);
    g = await m.call('get_task', { id: t.id });
    assert.equal(g.json.summary, 'Reopened for a fix.\nSee the PR comment.'); assert.equal(g.json.summary_by, 'claude-code@laptop');
    const bad = await m.call('update_task', { id: t.id, summary: '1\n2\n3\n4\n5\n6' });
    assert.equal(bad.err, true); assert.match(bad.text, /5/);
    const tools = (await m.rpc('tools/list')).result.tools;
    for (const n of ['update_task', 'finish_task', 'release_task']) assert.ok(tools.find((x: any) => x.name === n).inputSchema.properties.summary, n);
  } finally { m.proc.kill(); proc.kill(); cleanup(); }
});
