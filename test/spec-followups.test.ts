// Spec index recovery and the MCP 409 error text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createTask } from '../src/lib/write.ts';
import { tempRepo } from './helpers.ts';
import { freePort, stopServer } from './spec-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const MCP = path.join(ROOT, 'mcp/dasks-mcp.mjs');
const A = 'human-claude@laptop-a', E = 'human-claude@laptop-e', H = 'codex@laptop-h';
const FAMILIES = { 'human-claude@laptop-x': 'openai' };

/** A small card with Acceptance tests: a spec PUT and a pass review make it ready. */
const card = () => 'id: shared.t-spec\ngoal: shared\nrole: builder\ntier: 1\nrepo: example-org/dasks\nbranch: human/shared.t-spec\nlane: none\n'
  + 'deadline: 2026-11-01\nsize: small\ndepends_on: none\nimpl: claude\nreview: codex\n'
  + 'done_when: the board shows the spec\ndone_at: pr\n' + 'pass_checks:\n  - npm test is green\n  - GET returns the text\n  - over the cap is 413\n'
  + '\n## Background\nBackground text.\n\n## Why\nBecause.\n\n## Context pack\n- docs/x.md\n\n## Tests\n- test/x.test.ts\n'
  + '\n## Acceptance tests\n1. GET returns the text.\n2. PUT stores a version.\n\n## Notes\nend\n';

interface Srv { url: string; proc: ChildProcess }
interface Res { status: number; body: any }
interface Ctx { root: string; s: Srv; call: (m: string, p: string, body?: unknown, actor?: string) => Promise<Res>; ready: (title: string) => Promise<string> }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startServer(root: string, secrets: string): Promise<Srv> {
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, families: FAMILIES }));
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '',
      DASKS_RELOAD_GATE: path.join(root, '.reload-gate'),
      DASKS_SECRETS_DIR: secrets, DASKS_PASSPHRASE_FILE: path.join(secrets, 'passphrase'), DASKS_UNSAFE_OWN_PASSPHRASE_FILE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc }; } catch { /* starting */ }
    await sleep(100);
  }
  proc.kill(); throw new Error('server did not start');
}

async function withBoard(fn: (c: Ctx) => Promise<void>) {
  const { root, cleanup } = tempRepo();
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-secrets-'));
  fs.chmodSync(secrets, 0o700);
  const salt = randomBytes(16);
  const hash = scryptSync('spec followups passphrase'.normalize('NFC'), salt, 32, { N: 1024, r: 8, p: 1 });
  fs.writeFileSync(path.join(secrets, 'passphrase'), `scrypt$1024$8$1$${salt.toString('base64')}$${hash.toString('base64')}\n`, { mode: 0o600 });
  const s = await startServer(root, secrets);
  const call = async (method: string, p: string, body?: unknown, actor?: string): Promise<Res> => {
    const r = await fetch(s.url + p, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Dasks-Actor': actor } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  };
  /** A card the server has loaded, with a committed small spec (ready). */
  const ready = async (title: string) => {
    const id = createTask(root, { goal: 'shared', title }, 'helper').id;
    let r: Res | null = null;
    for (let i = 0; i < 100 && (r = await call('GET', `/api/tasks/${id}`)).status !== 200; i++) await sleep(100);
    assert.equal(r!.status, 200, `the server never loaded ${id}`);
    const put = await call('PUT', `/api/tasks/${id}/spec`, { text: card(), expected_spec_version: 0 }, A);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    // A small spec is ready only after another family's pass on its version.
    const rv = await call('POST', `/api/tasks/${id}/spec/review`, { spec_version: 1, verdict: 'pass' }, H);
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.equal((await call('GET', `/api/tasks/${id}`)).body.spec_state, 'ready');
    return id;
  };
  try { await fn({ root, s, call, ready }); } finally { await stopServer(s.proc); cleanup(); fs.rmSync(secrets, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

const health = async (c: Ctx) => {
  const r = await c.call('GET', '/api/health');
  assert.equal(r.status, r.body.spec_index?.ok ? 200 : 503);
  assert.equal(r.body.ready, r.body.spec_index?.ok);
  assert.equal(typeof r.body.spec_index?.attempts, 'number', `/api/health has spec_index.attempts: ${JSON.stringify(r.body)}`);
  return r.body as { ok: boolean; version: number; spec_index: { ok: boolean; attempts: number } };
};

/** Another process commits a block on `id` with plumbing (no data/ file event, HEAD moves once),
 *  then that commit's task blob goes missing. Returns restore(). */
function breakBlob(root: string, id: string): () => void {
  const [g, slug] = id.split(/\.(.*)/s);
  const rel = `data/tasks/${g}/${slug}.md`;
  const blocked = fs.readFileSync(path.join(root, rel), 'utf8').replace(/^spec_state: ready$/m, 'spec_state: blocked\nblocked_by: bot@host-d\nblocked_at: 2026-10-25T00:00:00+09:00\nblock_note: elsewhere\nblocked_spec_version: 1');
  assert.match(blocked, /spec_state: blocked/);
  const oid = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: blocked, encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', root, 'update-index', '--cacheinfo', `100644,${oid},${rel}`]);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'other process: block']);
  const obj = path.join(root, '.git/objects', oid.slice(0, 2), oid.slice(2));
  const saved = fs.readFileSync(obj);
  fs.rmSync(obj);
  return () => { fs.mkdirSync(path.dirname(obj), { recursive: true }); fs.writeFileSync(obj, saved); };
}

/** 100 GET /api/tasks, 10 at a time, as fast as the machine allows. Returns the elapsed ms (first start → last end). */
async function burst(c: Ctx, id: string, want: string): Promise<number> {
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    const rs = await Promise.all(Array.from({ length: 10 }, () => c.call('GET', '/api/tasks')));
    for (const r of rs) {
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.equal(r.body.find((x: any) => x.id === id).spec_state, want, 'the last good index');
    }
  }
  return Date.now() - t0;
}

test('back-off: while a rebuild fails (missing object, HEAD unchanged), 100 reads cost at most one attempt per second', () => withBoard(async (c) => {
  const id = await c.ready('Backoff card'); await c.ready('Backoff other');
  breakBlob(c.root, id);
  const h0 = await health(c);
  assert.equal(h0.spec_index.ok, false, 'the rebuild fails');
  const E = await burst(c, id, 'ready');
  const h1 = await health(c);
  assert.ok(h1.spec_index.attempts - h0.spec_index.attempts <= 2 + Math.floor(E / 1000),
    `attempts ${h1.spec_index.attempts - h0.spec_index.attempts} in ${E} ms (bound ${2 + Math.floor(E / 1000)})`);
}));

test('writes recover at once: a claim answers 503 spec-index while broken, the very next claim after the repair answers 200', () => withBoard(async (c) => {
  const id = await c.ready('Recover card'); const other = await c.ready('Recover other');
  const restore = breakBlob(c.root, id);
  await burst(c, id, 'ready'); // the back-off window is armed
  let r = await c.call('POST', `/api/tasks/${other}/claim`, {}, E);
  assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.rule, 'spec-index');
  restore();
  r = await c.call('POST', `/api/tasks/${other}/claim`, {}, E);
  assert.equal(r.status, 200, `no wait after the repair: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.claimed_by, E);
}));

test('one rebuild after recovery: once healthy, 20 more reads make no attempt', () => withBoard(async (c) => {
  const id = await c.ready('Steady card'); const other = await c.ready('Steady other');
  const restore = breakBlob(c.root, id);
  await burst(c, id, 'ready');
  assert.equal((await c.call('POST', `/api/tasks/${other}/claim`, {}, E)).status, 503);
  restore();
  assert.equal((await c.call('POST', `/api/tasks/${other}/claim`, {}, E)).status, 200);
  const a1 = (await health(c)).spec_index.attempts;
  for (let i = 0; i < 20; i++) assert.equal((await c.call('GET', '/api/tasks')).status, 200);
  const h = await health(c);
  assert.equal(h.spec_index.attempts - a1, 0, 'no rebuild while HEAD stays');
  assert.equal(h.spec_index.ok, true);
}));

test('a broken HEAD (ref cycle, headSha empty) also backs off; restoring HEAD rebuilds on the next read', () => withBoard(async (c) => {
  const id = await c.ready('Cycle card');
  const gd = path.join(c.root, '.git');
  const headBefore = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8');
  fs.writeFileSync(path.join(gd, 'refs/heads/cyc-a'), 'ref: refs/heads/cyc-b\n'); fs.writeFileSync(path.join(gd, 'refs/heads/cyc-b'), 'ref: refs/heads/cyc-a\n');
  fs.writeFileSync(path.join(gd, 'HEAD'), 'ref: refs/heads/cyc-a\n');
  let a2 = 0;
  try {
    const h0 = await health(c);
    assert.equal(h0.spec_index.ok, false);
    const E = await burst(c, id, 'ready');
    const h1 = await health(c);
    assert.ok(h1.spec_index.attempts - h0.spec_index.attempts <= 2 + Math.floor(E / 1000),
      `attempts ${h1.spec_index.attempts - h0.spec_index.attempts} in ${E} ms (bound ${2 + Math.floor(E / 1000)})`);
    a2 = h1.spec_index.attempts;
  } finally {
    fs.writeFileSync(path.join(gd, 'HEAD'), headBefore); fs.rmSync(path.join(gd, 'refs/heads/cyc-a')); fs.rmSync(path.join(gd, 'refs/heads/cyc-b'));
  }
  const t = await c.call('GET', `/api/tasks/${id}`);
  assert.equal(t.status, 200); assert.equal(t.body.spec_state, 'ready');
  const h2 = await health(c);
  assert.equal(h2.spec_index.attempts, a2 + 1, 'the next read rebuilt once');
  assert.equal(h2.spec_index.ok, true);
}));

function mcp(url: string, actor: string) {
  const proc = spawn(process.execPath, [MCP], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; let next = 1;
  const waiting = new Map<number, (v: any) => void>();
  proc.stdout!.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); } });
  const rpc = (method: string, params: any = {}) => { const id = next++; return new Promise<any>((res) => { waiting.set(id, res); proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); };
  const call = async (name: string, args: any) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { err: !!r.isError, text: r.content[0].text as string }; };
  return { proc, rpc, call };
}

test('MCP: a 409 error text is JSON as a whole, the hint is a field; a 404 has no hint', () => withBoard(async (c) => {
  const id = await c.ready('Mcp stale'); const held = await c.ready('Mcp held');
  assert.equal((await c.call('POST', `/api/tasks/${held}/claim`, {}, E)).status, 200);
  const m = mcp(c.s.url, H);
  try {
    await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const cur = (await c.call('GET', `/api/tasks/${id}`)).body.version;
    let r = await m.call('update_task', { id, note: 'stale write', expected_version: cur - 1 });
    assert.equal(r.err, true);
    let j = JSON.parse(r.text);
    assert.equal(j.http_status, 409); assert.equal(typeof j.current_version, 'number');
    assert.equal(j.hint, 're-read the task and retry with the current version');
    r = await m.call('claim_task', { id: held });
    assert.equal(r.err, true);
    j = JSON.parse(r.text);
    assert.equal(j.http_status, 409); assert.equal(j.claimed_by, E);
    assert.equal(j.hint, "held by another actor: coordinate, or use force only with the user's OK");
    r = await m.call('get_task', { id: 'shared.t-nonex' });
    assert.equal(r.err, true);
    j = JSON.parse(r.text);
    assert.equal(j.http_status, 404); assert.equal('hint' in j, false);
  } finally { m.proc.kill(); }
}));
