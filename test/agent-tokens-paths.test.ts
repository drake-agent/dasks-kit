// Agent token store paths, token shapes, store dates and masking (fixture tokens in temp dirs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { SYSTEM_CFG, task, tempRepo } from './helpers.ts';
import { freePort, stopServer } from './spec-support.ts';
import * as auth from '../src/lib/auth.ts';
import { looksSecret as messageSecret } from '../src/lib/messages.ts';
import { looksSecret as lessonSecret } from '../src/lib/lessons.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin/dasks-tokens.ts');
const run = promisify(execFile);
const A = 'codex@laptop';
const SECRET = 'S'.repeat(20) + 'e'.repeat(23); // 43 chars, fixture only
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d: string) => fs.rmSync(d, { recursive: true, force: true });

// No link is allowed anywhere on the store path, so a chain of links is refused at its first link.
test('store path: links on the store path, direct or chained, are refused', () => {
  const t = fs.realpathSync(tmp('dasks-chain-'));
  try {
    const trusted = [0, process.getuid!()];
    const d1 = path.join(t, 'd1'), d2 = path.join(t, 'd2');
    fs.mkdirSync(d1, { mode: 0o755 }); fs.mkdirSync(d2); fs.chmodSync(d1, 0o755); fs.chmodSync(d2, 0o777);
    fs.writeFileSync(path.join(d1, 'f'), '{}', { mode: 0o644 });
    fs.symlinkSync(path.join(d1, 'f'), path.join(d2, 'l2'));
    fs.symlinkSync(path.join(d2, 'l2'), path.join(d1, 'l1'));
    assert.equal(auth.storePathProblem(path.join(d1, 'f'), trusted, 'file'), null, 'a plain path passes');
    assert.match(String(auth.storePathProblem(path.join(d1, 'l1'), trusted, 'file')), /l1 is a symlink/);
    assert.match(String(auth.storePathProblem(path.join(d2, 'x'), trusted, 'file')), /d2 is world-writable/);
  } finally { rm(t); }
});

test('a token in Markdown emphasis, _dsk_…_, is refused by the message and lesson secret checks', () => {
  const tok = `_dsk_0123abcd_${SECRET}_`;
  assert.ok(messageSecret(`see ${tok}`));
  assert.ok(lessonSecret(`see ${tok}`));
});

test('store dates: 2026-02-30 and 25:00 make the store invalid', () => {
  const rec = { id: '0123abcd', actors: [A], labels: false, sha256: 'a'.repeat(64), created: '2026-10-26T01:00:00.000Z', revoked: null, note: '' };
  assert.ok('records' in auth.parseTokenStore(JSON.stringify({ tokens: [rec] })));
  assert.ok('records' in auth.parseTokenStore(JSON.stringify({ tokens: [{ ...rec, created: '2028-02-29T23:59:59+09:00' }] })));
  for (const bad of ['2026-02-30T01:00:00Z', '2026-13-01T00:00:00Z', '2026-10-26T25:00:00Z', '2026-10-26T10:61:00Z', '2026-10-26T10:00:00+25:00'])
    assert.ok('invalid' in auth.parseTokenStore(JSON.stringify({ tokens: [{ ...rec, created: bad }] })), bad);
});

test('CLI: the CLI creates nothing when the folder above the store folder is missing', async () => {
  const t = fs.realpathSync(tmp('dasks-mk-'));
  try {
    const store = path.join(t, 'a', 'b', 'agent-tokens.json');
    for (const extra of [{}, { DASKS_TEST_TOKENS_OWNER_UID: String(process.getuid!()) }])
      await assert.rejects(run(process.execPath, [CLI, 'issue', A], { timeout: 15_000, env: { ...process.env, DASKS_AGENT_TOKENS_FILE: store, DASKS_UNSAFE_OWN_TOKENS_FILE: '1', DASKS_CONFIG: SYSTEM_CFG, DASKS_ROOT: t, ...extra } }));
    assert.equal(fs.existsSync(path.join(t, 'a')), false, 'nothing created');
  } finally { rm(t); }
});

// The test switch takes only an absolute path; a relative one is refused at once rather than resolved.
test('CLI: a relative DASKS_AGENT_TOKENS_FILE is refused, never resolved', async () => {
  const t = tmp('dasks-rel-');
  try {
    const old = { f: process.env.DASKS_AGENT_TOKENS_FILE, u: process.env.DASKS_UNSAFE_OWN_TOKENS_FILE };
    process.env.DASKS_AGENT_TOKENS_FILE = 'x/store.json'; process.env.DASKS_UNSAFE_OWN_TOKENS_FILE = '1';
    try { assert.throws(() => auth.tokenStoreConfig(), /absolute/); }
    finally {
      for (const [k, v] of [['DASKS_AGENT_TOKENS_FILE', old.f], ['DASKS_UNSAFE_OWN_TOKENS_FILE', old.u]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await assert.rejects(run(process.execPath, [CLI, 'issue', A], { cwd: t, timeout: 15_000,
      env: { ...process.env, DASKS_AGENT_TOKENS_FILE: 'r/store.json', DASKS_UNSAFE_OWN_TOKENS_FILE: '1', DASKS_CONFIG: SYSTEM_CFG, DASKS_ROOT: t } }), /absolute/);
    assert.equal(fs.existsSync(path.join(t, 'r')), false);
  } finally { rm(t); }
});

async function start(root: string, dir: string, store: string, mode: string): Promise<{ url: string; proc: ChildProcess; log: () => string }> {
  const port = await freePort();
  const cfg = path.join(root, 'test-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, auth: { store: 'system' } }));
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/server.ts')], {
    env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfg, DASKS_PORT: '', DASKS_SECRETS_DIR: path.join(dir, 's'),
      DASKS_AGENT_TOKENS_FILE: store, DASKS_UNSAFE_OWN_TOKENS_FILE: '1', DASKS_AUTH_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; proc.stdout!.on('data', (d) => { out += d; }); proc.stderr!.on('data', (d) => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc, log: () => out }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error(`server did not start: ${out}`);
}

test('server: a token in a path that does not decode is still masked in the warning file and the log', async () => {
  const repo = tempRepo([task({ id: 'shared.t-tok', goal: 'shared' })]);
  const dir = tmp('dasks-pct-');
  const s = await start(repo.root, dir, path.join(dir, 'none.json'), 'warn');
  try {
    for (const p of [`/invalid/%64sk_0123abcd_${SECRET}/%zz`, `/invalid/%2564sk_0123abcd_${SECRET}`, `/invalid/DSK_0123ABCD_${SECRET}/%`, `/invalid/dsk%5f0123abcd%5f${SECRET}%zz`])
      await fetch(s.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': A }, body: '{}' });
    const w = fs.readFileSync(path.join(repo.root, 'run', 'auth-warnings.jsonl'), 'utf8');
    assert.equal(w.split('\n').filter(Boolean).length, 4);
    assert.ok(!w.includes(SECRET) && !w.toLowerCase().includes(SECRET.toLowerCase()), 'warning file has no secret');
  } finally { await stopServer(s.proc); }
  try { assert.ok(!s.log().includes(SECRET), 'server log has no secret'); } finally { repo.cleanup(); rm(dir); }
});

test('a FIFO at the store path never hangs the server or the CLI', async () => {
  const repo = tempRepo([task({ id: 'shared.t-tok', goal: 'shared' })]);
  const dir = tmp('dasks-fifo-');
  const fifo = path.join(dir, 'agent-tokens.json');
  execFileSync('mkfifo', [fifo]);
  const s = await start(repo.root, dir, fifo, 'enforce');
  try {
    const r = await fetch(s.url + '/api/tasks/shared.t-tok/messages', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': A, Authorization: `Bearer dsk_0123abcd_${SECRET}` }, body: JSON.stringify({ text: 'hi' }) });
    assert.equal(r.status, 503);
    assert.equal((await fetch(s.url + '/api/health', { signal: AbortSignal.timeout(3000) })).status, 200, 'server still answers');
  } finally { await stopServer(s.proc); }
  try {
    await assert.rejects(run(process.execPath, [CLI, 'list'], { timeout: 10_000, env: { ...process.env, DASKS_AGENT_TOKENS_FILE: fifo, DASKS_UNSAFE_OWN_TOKENS_FILE: '1', DASKS_CONFIG: SYSTEM_CFG, DASKS_ROOT: repo.root } }), // the store path is fixed outside the test switch
      (e: any) => !e.killed, 'list refuses the FIFO instead of hanging');
  } finally { repo.cleanup(); rm(dir); }
});
