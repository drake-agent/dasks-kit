// Agent token CLI (fixture tokens in temp dirs; DASKS_UNSAFE_OWN_TOKENS_FILE / DASKS_TEST_TOKENS_OWNER_UID move the store).
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

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin/dasks-tokens.ts');
const run = promisify(execFile);
const A = 'codex@laptop';
const ME = String(process.getuid!());
const ME_NAME = os.userInfo().username;
const darwin = process.platform === 'darwin';
const tmp = (p: string) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), p));
const rm = (d: string) => { try { execFileSync('chmod', ['-R', '-N', d]); } catch { /* no ACLs / not macOS */ } try { execFileSync('chmod', ['-R', 'u+rwx', d]); } catch { /* gone */ } fs.rmSync(d, { recursive: true, force: true }); };
const testEnv = (store: string, extra: Record<string, string> = {}) =>
  ({ ...process.env, DASKS_AGENT_TOKENS_FILE: store, DASKS_UNSAFE_OWN_TOKENS_FILE: '1', DASKS_CONFIG: SYSTEM_CFG, DASKS_TEST_TOKENS_OWNER_UID: ME, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the CLI refuses an unsafe existing store before reading it, and leaves it as it was', async () => {
  const t = tmp('dasks-pre-');
  try {
    const store = path.join(t, 'agent-tokens.json');
    execFileSync(process.execPath, [CLI, 'issue', A], { env: testEnv(store), encoding: 'utf8' });
    const planted = { id: 'deadbeef', actors: ['evil@agent'], labels: false, sha256: 'b'.repeat(64), created: '2026-10-26T01:00:00Z', revoked: null, note: 'planted' };
    const j = JSON.parse(fs.readFileSync(store, 'utf8')); j.tokens.push(planted);
    fs.writeFileSync(store, JSON.stringify(j)); fs.chmodSync(store, 0o666); // anyone could have written this
    const before = fs.readFileSync(store, 'utf8');
    await assert.rejects(run(process.execPath, [CLI, 'issue', 'honest@agent'], { env: testEnv(store), timeout: 15_000 }), /world-writable/);
    assert.equal(fs.readFileSync(store, 'utf8'), before, 'store untouched');
    assert.equal(fs.statSync(store).mode & 0o777, 0o666, 'not repaired either');
    await assert.rejects(run(process.execPath, [CLI, 'revoke', 'deadbeef'], { env: testEnv(store), timeout: 15_000 }), /world-writable/);
  } finally { rm(t); }
});

test('ACL principals with spaces are read, and an unparseable ACL refuses', () => {
  const head = '-rw-r--r--+ 1 root  wheel  2 Oct 26 15:00 /x\n';
  const p = (lines: string) => (auth as any).aclWriterFromLs(head + lines);
  assert.equal(p(' 0: group:Domain Users allow write,append\n'), 'group:Domain Users');
  assert.equal(p(' 0: group:Domain Users inherited allow add_file,file_inherit\n'), 'group:Domain Users');
  assert.equal(p(' 0: user:root allow write\n 1: group:everyone deny write\n'), null, 'root and deny entries do not grant');
  assert.equal(p(' 0: group:staff allow read,search\n'), null, 'read-only grants are fine');
  assert.equal(p(''), null, 'no ACL');
  assert.equal(p(' 0: something we do not know\n'), '', 'unparseable: refuse');
  assert.equal(p(' 0: group:x allow frobnicate\n'), '', 'unknown permission name: refuse');
});

test('a deny-read ACL for the server account makes issue fail instead of reporting success', { skip: !darwin && 'macOS ACLs' }, async () => {
  const t = tmp('dasks-deny-');
  try {
    const store = path.join(t, 'agent-tokens.json');
    execFileSync(process.execPath, [CLI, 'issue', A], { env: testEnv(store), encoding: 'utf8' });
    // New files in the folder inherit "deny read" for this account (the server account in this test).
    execFileSync('chmod', ['+a', `user:${ME_NAME} deny read,file_inherit,only_inherit`, t]);
    await assert.rejects(run(process.execPath, [CLI, 'issue', 'second@agent'], { env: testEnv(store), timeout: 15_000 }), /not readable by the server account/);
  } finally { rm(t); }
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  test(`lock: ${sig} while holding the lock removes it`, async () => {
    const t = tmp('dasks-sig-');
    try {
      const store = path.join(t, 'agent-tokens.json');
      const child = spawn(process.execPath, [CLI, 'issue', A], { env: testEnv(store, { DASKS_TOKENS_TEST_HOLD_MS: '20000' }), stdio: 'ignore' });
      const lock = `${store}.lock`;
      let seen = false;
      for (let i = 0; i < 100 && !seen; i++) { seen = fs.existsSync(lock); if (!seen) await sleep(50); }
      assert.ok(seen, 'the CLI took the lock (test hold)');
      const exited = new Promise((r) => child.once('exit', r));
      child.kill(sig);
      await exited;
      assert.equal(fs.existsSync(lock), false, 'lock removed');
      assert.equal(fs.existsSync(store), false, 'nothing written');
    } finally { rm(t); }
  });
}

test('lock: a stale lock of a dead pid is reported and cleared; a live owner still blocks', async () => {
  const t = tmp('dasks-stale-');
  try {
    const store = path.join(t, 'agent-tokens.json');
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => dead.once('exit', r));
    fs.writeFileSync(`${store}.lock`, `${dead.pid}\n`, { mode: 0o600 });
    const r = await run(process.execPath, [CLI, 'issue', A], { env: testEnv(store), timeout: 15_000 });
    assert.match(r.stderr, new RegExp(`stale lock .*pid ${dead.pid}`));
    assert.match(r.stdout.trim(), /^dsk_/);
    assert.equal(fs.existsSync(`${store}.lock`), false);
    fs.writeFileSync(`${store}.lock`, `${process.pid}\n`, { mode: 0o600 }); // this test process: alive
    await assert.rejects(run(process.execPath, [CLI, 'issue', A], { env: testEnv(store, { DASKS_TOKENS_TEST_LOCK_WAIT_MS: '300' }), timeout: 15_000 }), /is held by pid/);
    assert.ok(fs.existsSync(`${store}.lock`), 'a live lock is never removed');
  } finally { rm(t); }
});
