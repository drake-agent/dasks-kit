// Agent token store path checks (DASKS_UNSAFE_OWN_TOKENS_FILE / DASKS_TEST_TOKENS_OWNER_UID point it at a temp dir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { SYSTEM_CFG, task, tempRepo } from './helpers.ts';
import { freePort, stopServer } from './spec-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin/dasks-tokens.ts');
const run = promisify(execFile);
const A = 'codex@laptop';
const ME = String(process.getuid!());
const darwin = process.platform === 'darwin';
// A temp dir with no symlink on its path (macOS /var is a link to /private/var).
const tmp = (p: string) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), p));
const rm = (d: string) => { try { execFileSync('chmod', ['-R', 'u+rwx', d]); } catch { /* gone */ } fs.rmSync(d, { recursive: true, force: true }); };
const testEnv = (store: string, extra: Record<string, string> = {}) =>
  ({ ...process.env, DASKS_AGENT_TOKENS_FILE: store, DASKS_UNSAFE_OWN_TOKENS_FILE: '1', DASKS_CONFIG: SYSTEM_CFG, DASKS_TEST_TOKENS_OWNER_UID: ME, ...extra });

async function start(root: string, dir: string, env: Record<string, string | undefined>, mode: string): Promise<{ url: string; proc: ChildProcess; log: () => string }> {
  const port = await freePort();
  const cfg = path.join(root, 'test-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, auth: { store: 'system' } }));
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/server.ts')], {
    env: { ...env, DASKS_ROOT: root, DASKS_CONFIG: cfg, DASKS_PORT: '', DASKS_SECRETS_DIR: path.join(dir, 's'), DASKS_AUTH_MODE: mode },
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
const post = (url: string, tok: string) => fetch(url + '/api/tasks/shared.t-tok/messages', { method: 'POST', signal: AbortSignal.timeout(10_000),
  headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': A, Authorization: `Bearer ${tok}` }, body: JSON.stringify({ text: 'hi' }) });

test('an ACL write grant on the store (or a folder above it) makes the store unavailable', { skip: !darwin && 'macOS ACLs' }, async () => {
  const repo = tempRepo([task({ id: 'shared.t-tok', goal: 'shared' })]);
  const dir = tmp('dasks-acl-');
  const store = path.join(dir, 'agent-tokens.json');
  const env = testEnv(store);
  const tok = execFileSync(process.execPath, [CLI, 'issue', A], { env, encoding: 'utf8' }).trim();
  fs.chmodSync(store, 0o644);
  const s = await start(repo.root, dir, env, 'enforce');
  try {
    assert.equal((await post(s.url, tok)).status, 201, `clean store works: ${s.log()}`);
    execFileSync('chmod', ['+a', 'group:everyone allow write,append', store]);
    assert.equal((await post(s.url, tok)).status, 503, 'ACL write grant on the file refused');
    assert.match(s.log(), /ACL/);
    execFileSync('chmod', ['-a', 'group:everyone allow write,append', store]);
    assert.equal((await post(s.url, tok)).status, 201, 'ACL removed: works again');
    execFileSync('chmod', ['+a', 'group:everyone allow add_file,delete_child', dir]);
    assert.equal((await post(s.url, tok)).status, 503, 'ACL write grant on the folder refused');
  } finally { await stopServer(s.proc); repo.cleanup(); rm(dir); }
});

test('the CLI refuses a store path through a symlink and creates nothing', async () => {
  const t = tmp('dasks-link2-');
  try {
    fs.mkdirSync(path.join(t, 'real'), { mode: 0o755 });
    fs.symlinkSync(path.join(t, 'real'), path.join(t, 'link'));
    const store = path.join(t, 'link', 'Dasks', 'agent-tokens.json');
    await assert.rejects(run(process.execPath, [CLI, 'issue', A], { env: testEnv(store), timeout: 15_000 }), /symlink|link/);
    assert.equal(fs.existsSync(path.join(t, 'real', 'Dasks')), false, 'nothing created through the link');
    // A missing folder above the store folder is not created either: refused, not repaired.
    const deep = path.join(t, 'missing', 'Dasks', 'agent-tokens.json');
    await assert.rejects(run(process.execPath, [CLI, 'issue', A], { env: testEnv(deep), timeout: 15_000 }));
    assert.equal(fs.existsSync(path.join(t, 'missing')), false);
    // The store folder itself is the one thing it makes, under a parent that passes the checks.
    const ok = path.join(t, 'real', 'Dasks', 'agent-tokens.json');
    const { stdout } = await run(process.execPath, [CLI, 'issue', A], { env: testEnv(ok), timeout: 15_000 });
    assert.match(stdout.trim(), /^dsk_[0-9a-f]{8}_/);
    assert.equal(fs.statSync(path.dirname(ok)).mode & 0o777, 0o755);
  } finally { rm(t); }
});

test('the server reports at start that it cannot search the store folder', async () => {
  const repo = tempRepo([task({ id: 'shared.t-tok', goal: 'shared' })]);
  const dir = tmp('dasks-search-');
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked, { mode: 0o755 });
  const store = path.join(locked, 'agent-tokens.json');
  execFileSync(process.execPath, [CLI, 'issue', A], { env: testEnv(store), encoding: 'utf8' });
  fs.chmodSync(locked, 0o644); // no search (x) for anyone, the server's account included
  const s = await start(repo.root, dir, testEnv(store), 'warn');
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.match(s.log(), new RegExp(`auth: token store .*${locked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.* not searchable by this account`));
  } finally { await stopServer(s.proc); repo.cleanup(); rm(dir); }
  // ...and a reachable store is reported as fine, once.
  const repo2 = tempRepo([task({ id: 'shared.t-tok', goal: 'shared' })]);
  const dir2 = tmp('dasks-search-ok-');
  const store2 = path.join(dir2, 'agent-tokens.json');
  execFileSync(process.execPath, [CLI, 'issue', A], { env: testEnv(store2), encoding: 'utf8' });
  const s2 = await start(repo2.root, dir2, testEnv(store2), 'warn');
  try { assert.match(s2.log(), /auth: token store .* reachable/); } finally { await stopServer(s2.proc); repo2.cleanup(); rm(dir2); }
});

test('DASKS_AGENT_TOKENS_FILE moves the store only under the test switch', async () => {
  const fixed = darwin ? '/Library/Application Support/Dasks/agent-tokens.json' : '/etc/dasks/agent-tokens.json';
  const probe = (extra: Record<string, string>) => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import('${path.join(ROOT, 'src/lib/auth.ts')}').then((m) => console.log(m.tokenStoreConfig('system').file))`], { env: { ...process.env, DASKS_UNSAFE_OWN_TOKENS_FILE: '', ...extra }, encoding: 'utf8' }).trim();
  assert.equal(probe({ DASKS_AGENT_TOKENS_FILE: '/tmp/elsewhere.json' }), fixed);
  assert.equal(probe({ DASKS_AGENT_TOKENS_FILE: '/tmp/elsewhere.json', DASKS_UNSAFE_OWN_TOKENS_FILE: '1' }), '/tmp/elsewhere.json');
  assert.throws(() => probe({ DASKS_AGENT_TOKENS_FILE: 'relative.json', DASKS_UNSAFE_OWN_TOKENS_FILE: '1' }));
});
