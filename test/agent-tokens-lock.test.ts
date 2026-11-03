// Agent token CLI lock under races and signals, and token masking (fixture tokens in temp dirs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { SYSTEM_CFG, task, tempRepo } from './helpers.ts';
import { freePort, stopServer } from './spec-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin/dasks-tokens.ts');
const A = 'codex@laptop';
const ME = String(process.getuid!());
const SECRET = 'S'.repeat(20) + 'e'.repeat(23); // 43 chars, fixture only
const tmp = (p: string) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), p));
const rm = (d: string) => fs.rmSync(d, { recursive: true, force: true });
const testEnv = (store: string, extra: Record<string, string> = {}) =>
  ({ ...process.env, DASKS_AGENT_TOKENS_FILE: store, DASKS_UNSAFE_OWN_TOKENS_FILE: '1', DASKS_CONFIG: SYSTEM_CFG, DASKS_TEST_TOKENS_OWNER_UID: ME, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cli(args: string[], env: NodeJS.ProcessEnv): { proc: ChildProcess; done: Promise<{ code: number | null; err: string }>; err: () => string } {
  const proc = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr!.on('data', (d) => { err += d; });
  proc.stdout!.resume();
  const done = new Promise<{ code: number | null; err: string }>((r) => proc.once('exit', (code) => r({ code, err })));
  return { proc, done, err: () => err };
}

// Two runs clear the same dead pid's lock: A decides the lock is stale and pauses before removing it; B clears it too and
// takes a fresh lock. A's remove must not delete B's live lock.
test('two runs clearing the same stale lock never hold the lock at the same time', async () => {
  const t = tmp('dasks-reap-');
  try {
    const store = path.join(t, 'agent-tokens.json');
    const log = path.join(t, 'lock.log');
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => dead.once('exit', r));
    fs.writeFileSync(`${store}.lock`, `${dead.pid}\n`, { mode: 0o600 });
    const a = cli(['issue', 'a@agent'], testEnv(store, { DASKS_TOKENS_TEST_REAP_PAUSE_MS: '1500', DASKS_TOKENS_TEST_LOCK_LOG: log }));
    for (let i = 0; i < 100 && !a.err().includes('test: reap pause'); i++) await sleep(50);
    assert.match(a.err(), /test: reap pause/, 'A paused while clearing the stale lock');
    const b = cli(['issue', 'b@agent'], testEnv(store, { DASKS_TOKENS_TEST_HOLD_MS: '2500', DASKS_TOKENS_TEST_LOCK_LOG: log }));
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0, ra.err);
    assert.equal(rb.code, 0, rb.err);
    const ev = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '));
    const spans = new Map<string, number[]>();
    for (const [pid, what, ms] of ev) { const s = spans.get(pid) ?? []; s[what === 'got' ? 0 : 1] = Number(ms); spans.set(pid, s); }
    assert.equal(spans.size, 2, `two holders logged: ${JSON.stringify(ev)}`);
    const [x, y] = [...spans.values()].sort((p, q) => p[0] - q[0]);
    assert.ok(x[1] <= y[0], `lock held by both at once: ${JSON.stringify(ev)}`);
    const records = JSON.parse(fs.readFileSync(store, 'utf8')).tokens;
    assert.deepEqual(records.map((r: any) => r.actors[0]).sort(), ['a@agent', 'b@agent']);
  } finally { rm(t); }
});

// A stop signal that arrives after the lock file is made but before any await must still remove the lock, so the
// handlers have to be installed before the lock is taken.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  test(`${sig} right after the lock is made (before any await) still removes it`, async () => {
    const t = tmp('dasks-early-');
    try {
      const store = path.join(t, 'agent-tokens.json');
      const c = cli(['issue', A], testEnv(store, { DASKS_TOKENS_TEST_GOT_PAUSE_MS: '1500' }));
      for (let i = 0; i < 100 && !c.err().includes('test: got pause'); i++) await sleep(50);
      assert.match(c.err(), /test: got pause/, 'the CLI holds the lock, synchronously');
      c.proc.kill(sig);
      await c.done;
      assert.equal(fs.existsSync(`${store}.lock`), false, 'lock removed');
      // the signal waits for the synchronous change: the store is untouched or whole, never half written
      if (fs.existsSync(store)) assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).tokens.length, 1);
    } finally { rm(t); }
  });
}

// The warning path is decoded a bounded number of times; a path still changing after the bound is masked whole, so a
// token percent-encoded more often than the bound never leaks.
test('a token percent-encoded many times never reaches the warning file or the log', async () => {
  const repo = tempRepo([task({ id: 'shared.t-tok', goal: 'shared' })]);
  const dir = tmp('dasks-enc-');
  const port = await freePort();
  const cfg = path.join(repo.root, 'test-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, auth: { store: 'system' } }));
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/server.ts')], {
    env: { ...process.env, DASKS_ROOT: repo.root, DASKS_CONFIG: cfg, DASKS_PORT: '', DASKS_SECRETS_DIR: path.join(dir, 's'),
      DASKS_AGENT_TOKENS_FILE: path.join(dir, 'none.json'), DASKS_UNSAFE_OWN_TOKENS_FILE: '1', DASKS_AUTH_MODE: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; proc.stdout!.on('data', (d) => { out += d; }); proc.stderr!.on('data', (d) => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/health')).ok) break; } catch { /* starting */ } await sleep(100); }
    const once = `dsk_0123abcd_${SECRET}`.replace(/./g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    const sent: string[] = [];
    for (const extra of [4, 5, 8, 12]) {
      let p = once;
      for (let i = 0; i < extra; i++) p = encodeURIComponent(p);
      sent.push(p);
      await fetch(`${url}/invalid/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': A }, body: '{}' });
    }
    const w = fs.readFileSync(path.join(repo.root, 'run', 'auth-warnings.jsonl'), 'utf8');
    assert.equal(w.split('\n').filter(Boolean).length, sent.length);
    const fully = (s: string) => { for (let i = 0; i < 64; i++) { const n = s.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))); if (n === s) return s; s = n; } return s; };
    for (const line of w.split('\n').filter(Boolean)) {
      const p = JSON.parse(line).path as string;
      assert.ok(!fully(p).includes(SECRET.slice(0, 20)), `warning path decodes to the secret: ${p}`);
    }
  } finally { await stopServer(proc); }
  try { assert.ok(!fully2(out).includes(SECRET.slice(0, 20)), 'server log has no secret'); } finally { repo.cleanup(); rm(dir); }
});

function fully2(s: string) {
  for (let i = 0; i < 64; i++) { const n = s.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))); if (n === s) return s; s = n; }
  return s;
}

// A stop signal while waiting for another run's lock must end the run at once: a signal queued behind a synchronous wait
// loop would let the cancelled command take the lock and run once the lock went.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  test(`${sig} while waiting for the lock ends the run without taking it or running the command`, async () => {
    const t = tmp('dasks-wait-');
    try {
      const store = path.join(t, 'agent-tokens.json');
      const lock = `${store}.lock`;
      const log = path.join(t, 'lock.log');
      fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 }); // another run's lock (a live pid: this test)
      const c = cli(['issue', A], testEnv(store, { DASKS_TOKENS_TEST_LOCK_WAIT_MS: '8000', DASKS_TOKENS_TEST_LOCK_LOG: log }));
      await sleep(1500); // started and waiting on the held lock
      c.proc.kill(sig);
      await sleep(300);
      fs.rmSync(lock, { force: true }); // the other run finishes
      const r = await Promise.race([c.done, sleep(6000).then(() => ({ code: -1, err: 'still running' }))]);
      assert.notEqual(r.code, 0, `non-zero exit: ${r.err}`);
      assert.notEqual(r.code, -1, 'ended at the signal, not after the wait');
      assert.equal(fs.existsSync(store), false, 'the cancelled issue did not run');
      assert.equal(fs.existsSync(lock), false, 'no lock left by this run');
      assert.ok(!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes('got'), 'the lock was never taken');
    } finally { rm(t); }
  });
}
