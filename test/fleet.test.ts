// A board for several Macs (the network address is ::1 under the test switch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { task, tempRepo } from './helpers.ts';
import { asHuman, humanSecrets, unusedPort, until } from './state-support.ts';
import { tokenMayActAs, type TokenRecord } from '../src/lib/auth.ts';
import { deadRunnerCards, parseHeartbeat } from '../src/lib/fleet.ts';
import { isLoopback } from '../src/lib/config.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DASKS?_|CLAUDE|CODEX)/.test(k)));

interface Board { home: string; root: string; url: string; net: string; port: number; proc: ChildProcess; log: () => string; env: Record<string, string>; token: (args: string[]) => string; stop: () => Promise<void> }

/** A board in a temp HOME (its own token store, passphrase and secrets), auth enforced, served on 127.0.0.1 and, under the
 *  test switch, on [::1] as its network address. */
async function board(cfg: Record<string, unknown> = {}, tasks = [task({ id: 'beta.t-one', title: 'One', body: 'touches: src/a\n' }), task({ id: 'beta.t-two', title: 'Two', body: 'touches: src/a/deep\n' })]): Promise<Board> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-fleet-'));
  const { root, cleanup } = tempRepo(tasks);
  const port = await unusedPort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port, listen: '::1' }, projects: [{ id: 'beta', name: 'Beta', repo: '/srv/beta' }], ...cfg }));
  const sec = humanSecrets();
  const env = { ...clean(), HOME: home, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_AUTH_MODE: 'enforce', DASKS_TEST_LISTEN_AS_NETWORK: '1', ...sec.env };
  const proc = spawn(NODE[0], [...NODE.slice(1), path.join(ROOT, 'src/server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout!.on('data', (d) => { out += d; }); proc.stderr!.on('data', (d) => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  try { await until(async () => (await fetch(url + '/api/health')).ok && (await fetch(`http://[::1]:${port}/api/health`)).ok, 15000); }
  catch { proc.kill(); throw new Error(`board did not start: ${out}`); }
  const token = (args: string[]) => {
    const r = spawnSync(NODE[0], [...NODE.slice(1), path.join(ROOT, 'bin/dasks-tokens.ts'), ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  return { home, root, url, net: `http://[::1]:${port}`, port, proc, log: () => out, env, token,
    stop: async () => { const done = new Promise((r) => proc.once('exit', r)); proc.kill(); await done; cleanup(); sec.cleanup(); fs.rmSync(home, { recursive: true, force: true }); } };
}

async function call(base: string, method: string, route: string, o: { actor?: string; token?: string; body?: unknown } = {}) {
  const r = await fetch(base + route, { method, headers: { ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(o.actor ? { 'X-Dasks-Actor': o.actor } : {}), ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text(); let body: any = text; try { body = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body };
}

test('config: a network address without enforced tokens refuses to start; a bad --listen is refused', async () => {
  const { root, cleanup } = tempRepo();
  try {
    const cfgFile = path.join(root, 'test-config.json');
    const port = await unusedPort();
    fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port, listen: '10.11.12.13' } }));
    for (const mode of ['off', 'warn']) {
      const r = spawnSync(NODE[0], [...NODE.slice(1), path.join(ROOT, 'src/server.ts')], { env: { ...clean(), DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_AUTH_MODE: mode }, encoding: 'utf8', timeout: 20000 });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /refusing to start: serving 10\.11\.12\.13 .*needs auth\.mode "enforce"/);
    }
    fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
    const flag = spawnSync(NODE[0], [...NODE.slice(1), path.join(ROOT, 'src/server.ts'), '--listen', '0.0.0.0'], { env: { ...clean(), DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_AUTH_MODE: 'off' }, encoding: 'utf8', timeout: 20000 });
    assert.equal(flag.status, 1, 'the --listen flag gets the same rule');
    assert.match(flag.stderr, /needs auth\.mode "enforce"/);
    const bad = spawnSync(NODE[0], [...NODE.slice(1), path.join(ROOT, 'src/server.ts'), '--listen', 'my-host'], { env: { ...clean(), DASKS_ROOT: root, DASKS_CONFIG: cfgFile }, encoding: 'utf8', timeout: 20000 });
    assert.equal(bad.status, 2);
    fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port, listen: 'everywhere' } }));
    const badCfg = spawnSync(NODE[0], [...NODE.slice(1), path.join(ROOT, 'src/server.ts')], { env: { ...clean(), DASKS_ROOT: root, DASKS_CONFIG: cfgFile }, encoding: 'utf8', timeout: 20000 });
    assert.notEqual(badCfg.status, 0);
    assert.match(badCfg.stderr, /server\.listen must be an IP address/);
  } finally { cleanup(); }
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.9') && !isLoopback('10.0.0.1') && !isLoopback('0.0.0.0'));
});

test('machine tokens: any name on that machine, never another machine; one live token per machine; revoke', async () => {
  const rec = (labels: boolean): TokenRecord => ({ id: 'abcd0123', actors: ['*@mini'], labels, sha256: '0'.repeat(64), created: '', revoked: null, note: '', machine: 'mini' });
  assert.ok(tokenMayActAs(rec(false), 'runner@mini') && tokenMayActAs(rec(false), 'captain@mini'));
  assert.ok(!tokenMayActAs(rec(false), 'runner@other') && !tokenMayActAs(rec(false), 'runner@minix') && !tokenMayActAs(rec(false), 'user'));
  // The machine part is exact: mini-build is a machine name of its own, so mini's token never reaches it, labels or not.
  for (const labels of [false, true]) for (const n of ['runner@mini-build', 'captain@mini-build', 'human-claude@mini-ab12'])
    assert.ok(!tokenMayActAs(rec(labels), n), `${n} (labels ${labels})`);
  assert.ok(tokenMayActAs(rec(false), 'human-claude-ab12@mini'), 'a session label goes before the @');
  const py = 'import importlib.machinery as m, importlib.util as u, sys\nd = u.module_from_spec(u.spec_from_loader("dask", m.SourceFileLoader("dask", sys.argv[1])))\nd.__spec__.loader.exec_module(d)\nprint(d.actor("claude"))';
  const named = spawnSync('python3', ['-c', py, path.join(ROOT, 'bin/dask')], { env: { ...clean(), DASKS_URL: 'http://127.0.0.1:9', DASKS_MACHINE: 'mini', DASK_SESSION: 'ab12' }, encoding: 'utf8' });
  assert.equal(named.stdout.trim(), 'human-claude-ab12@mini', named.stderr);
  const b = await board();
  try {
    const tok = b.token(['machine', 'add', 'mini']);
    assert.match(tok, /^dsk_[0-9a-f]{8}_/);
    const again = spawnSync(NODE[0], [...NODE.slice(1), path.join(ROOT, 'bin/dasks-tokens.ts'), 'machine', 'add', 'mini'], { env: b.env, encoding: 'utf8' });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already has a token/);
    const list = spawnSync(path.join(ROOT, 'bin/dasks'), ['machine', 'list'], { env: b.env, encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^mini\t[0-9a-f]{8}\t/m);
    assert.ok(!list.stdout.includes(tok.split('_')[2]), 'list never prints a secret');
    assert.equal((await call(b.net, 'POST', '/api/tasks/beta.t-one/messages', { actor: 'runner@mini', token: tok, body: { text: 'hi' } })).status, 201);
    const other = await call(b.net, 'POST', '/api/tasks/beta.t-one/messages', { actor: 'runner@other2', token: tok, body: { text: 'hi' } });
    assert.equal(other.status, 403);
    assert.equal(other.body.reason, 'mismatch');
    const who = await call(b.url, 'GET', '/api/whoami', { token: tok });
    assert.equal(who.body.machine, 'mini');
    b.token(['machine', 'revoke', 'mini']);
    assert.equal((await call(b.net, 'GET', '/api/tasks', { token: tok })).status, 401, 'revoked: refused from the next request');
  } finally { await b.stop(); }
});

test('network address: reads and writes need a machine token or the login; the local token and no token are refused', async () => {
  const b = await board();
  try {
    const local = b.token(['issue', '*', '--note', 'local agents']);
    const mini = b.token(['machine', 'add', 'mini']);
    assert.equal((await call(b.url, 'GET', '/api/tasks')).status, 200, 'this Mac reads as before');
    assert.equal((await call(b.net, 'GET', '/api/health')).status, 200);
    assert.equal((await call(b.net, 'GET', '/')).status, 200, 'the page itself loads, so the human can log in');
    const none = await call(b.net, 'GET', '/api/tasks');
    assert.equal(none.status, 401);
    assert.equal(none.body.login, true);
    assert.equal((await call(b.net, 'GET', '/api/board')).status, 401);
    const loc = await call(b.net, 'GET', '/api/tasks', { token: local });
    assert.equal(loc.status, 403);
    assert.equal(loc.body.reason, 'not-machine');
    assert.equal((await call(b.net, 'POST', '/api/tasks/beta.t-one/messages', { actor: 'claude-code@x', token: local, body: { text: 'hi' } })).status, 403);
    assert.equal((await call(b.net, 'GET', '/api/tasks', { token: mini })).status, 200);
    assert.equal((await call(b.url, 'POST', '/api/tasks/beta.t-one/messages', { actor: 'claude-code@x', token: local, body: { text: 'local is fine here' } })).status, 201);
    const human = await asHuman(b.net, '/api/tasks');
    assert.equal(human.status, 200, 'the logged-in human reads from the network');
    assert.equal((await asHuman(b.net, '/api/captain/chat', { text: 'from the browser on another Mac' })).status, 201);
  } finally { await b.stop(); }
});

test('heartbeat: the fleet lists machines with last seen, busy/idle and cards; a token speaks only for its machine', async () => {
  assert.throws(() => parseHeartbeat({ machine: 'Bad Name' }), /machine/);
  assert.throws(() => parseHeartbeat({ machine: 'a', cards: ['nope'] }), /cards/);
  assert.throws(() => parseHeartbeat({ machine: 'a', extra: 1 }), /unknown/);
  const b = await board();
  try {
    const a = b.token(['machine', 'add', 'aaa']);
    const hb = (tok: string, actor: string, body: Record<string, unknown>) => call(b.net, 'POST', '/api/fleet/heartbeat', { actor, token: tok, body });
    assert.equal((await hb(a, 'runner@aaa', { machine: 'aaa', harnesses: ['claude'], slots: 2, cards: ['beta.t-one'], version: '1.0.0' })).status, 200);
    const wrong = await hb(a, 'runner@aaa', { machine: 'bbb', slots: 1 });
    assert.equal(wrong.status, 403, JSON.stringify(wrong.body));
    assert.equal((await hb(a, 'claude-code@aaa', { machine: 'aaa' })).status, 400, 'only the runner sends heartbeats');
    const f = (await call(b.url, 'GET', '/api/fleet')).body;
    assert.equal(f.machines.length, 1);
    assert.equal(f.machines[0].machine, 'aaa');
    assert.equal(f.machines[0].state, 'busy');
    assert.deepEqual(f.machines[0].cards, ['beta.t-one']);
    assert.deepEqual(f.machines[0].harnesses, ['claude']);
    assert.ok(Date.now() - Date.parse(f.machines[0].last_seen) < 10_000);
    await hb(a, 'runner@aaa', { machine: 'aaa', slots: 2, cards: [] });
    assert.equal((await call(b.url, 'GET', '/api/fleet')).body.machines[0].state, 'idle');
    const cli = spawnSync(path.join(ROOT, 'bin/dasks'), ['fleet'], { env: { ...b.env, DASKS_URL: b.url }, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^aaa +idle +last seen /m);
  } finally { await b.stop(); }
});

test('dead runner: no heartbeat for dead_min and the board gives its cards back with a note; others keep theirs', async () => {
  assert.deepEqual(deadRunnerCards([{ id: 'a.t-x', status: 'doing', claimed_by: 'runner@q' }, { id: 'a.t-y', status: 'doing', claimed_by: 'claude-code@q' }, { id: 'a.t-z', status: 'review', claimed_by: 'runner@q' }], new Set(['q'])), [{ id: 'a.t-x', machine: 'q' }]);
  const b = await board({ fleet: { dead_min: 0.05 } });
  try {
    const q = b.token(['machine', 'add', 'quiet']), l = b.token(['machine', 'add', 'live']);
    assert.equal((await call(b.net, 'POST', '/api/tasks/beta.t-one/claim', { actor: 'runner@quiet', token: q, body: {} })).status, 200);
    assert.equal((await call(b.net, 'POST', '/api/tasks/beta.t-two/claim', { actor: 'runner@live', token: l, body: {} })).status, 200);
    await call(b.net, 'POST', '/api/fleet/heartbeat', { actor: 'runner@quiet', token: q, body: { machine: 'quiet', cards: ['beta.t-one'] } });
    const beat = setInterval(() => { void call(b.net, 'POST', '/api/fleet/heartbeat', { actor: 'runner@live', token: l, body: { machine: 'live', cards: ['beta.t-two'] } }).catch(() => { /* the board is busy; the next beat counts */ }); }, 500);
    try {
      await until(async () => (await call(b.url, 'GET', '/api/tasks/beta.t-one')).body.claimed_by === '', 15000);
    } finally { clearInterval(beat); }
    const one = (await call(b.url, 'GET', '/api/tasks/beta.t-one')).body;
    assert.equal(one.status, 'todo');
    assert.match(one.body, /released by the board: runner@quiet sent no heartbeat for 0\.05 min/);
    const two = (await call(b.url, 'GET', '/api/tasks/beta.t-two')).body;
    assert.equal(two.claimed_by, 'runner@live', 'a machine that keeps beating keeps its card');
    const f = (await call(b.url, 'GET', '/api/fleet')).body.machines;
    assert.equal(f.find((m: any) => m.machine === 'quiet').state, 'quiet');
    assert.equal((await call(b.net, 'POST', '/api/tasks/beta.t-one/claim', { actor: 'runner@live', token: l, body: {} })).status, 200, 'another machine takes it');
  } finally { await b.stop(); }
});

test('touches across machines: an exclusive claim is refused while another machine works an overlapping card', async () => {
  const b = await board();
  try {
    const a = b.token(['machine', 'add', 'one']), c = b.token(['machine', 'add', 'two']);
    assert.equal((await call(b.net, 'POST', '/api/tasks/beta.t-one/claim', { actor: 'runner@one', token: a, body: { exclusive_touches: true } })).status, 200);
    const refused = await call(b.net, 'POST', '/api/tasks/beta.t-two/claim', { actor: 'runner@two', token: c, body: { exclusive_touches: true } });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.rule, 'touches');
    assert.equal(refused.body.claimed_by, 'runner@one');
  } finally { await b.stop(); }
});

test('runner: posts a heartbeat on every look, also while it is off; dasks fleet shows it', async () => {
  const b = await board();
  try {
    const tok = b.token(['machine', 'add', 'worker']);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-joined-'));
    fs.mkdirSync(path.join(home, '.dasks'), { recursive: true });
    fs.writeFileSync(path.join(home, '.dasks/client.json'), JSON.stringify({ url: b.net, machine: 'worker', token: tok }), { mode: 0o600 });
    fs.writeFileSync(path.join(home, '.dasks/runner.json'), JSON.stringify({ runner: { enabled: false, max_parallel: 3 }, projects: [] }));
    const env = { ...clean(), HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const r = spawnSync(NODE[0], [...NODE.slice(1), path.join(ROOT, 'src/cli/runner.ts'), '--once'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const m = (await call(b.url, 'GET', '/api/fleet')).body.machines[0];
    assert.equal(m.machine, 'worker');
    assert.equal(m.state, 'off');
    assert.equal(m.slots, 3);
    assert.equal(m.actor, 'runner@worker');
    const st = spawnSync(NODE[0], [...NODE.slice(1), path.join(ROOT, 'src/cli/runner.ts'), '--status'], { env, encoding: 'utf8' });
    assert.match(st.stdout, /settings .*\.dasks\/runner\.json/);
    fs.rmSync(home, { recursive: true, force: true });
  } finally { await b.stop(); }
});

test('install.sh --join: a second HOME gets the clients pointing at the board, no board of its own; bad tokens are refused', async () => {
  const b = await board();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-join-'));
  try {
    const tokFile = path.join(home, 'mini.token');
    fs.writeFileSync(tokFile, b.token(['machine', 'add', 'mini']) + '\n', { mode: 0o600 });
    const localFile = path.join(home, 'local.token');
    fs.writeFileSync(localFile, b.token(['issue', '*']) + '\n', { mode: 0o600 });
    const env = { ...clean(), HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const sh = (...a: string[]) => spawnSync('bash', [path.join(ROOT, 'install.sh'), '--no-launchd', '--no-claude-mcp', '--no-codex-mcp', ...a], { env, encoding: 'utf8' });
    assert.equal(sh('--join', b.net).status, 2, 'a join needs its token file');
    const local = sh('--join', b.net, '--token-file', localFile);
    assert.notEqual(local.status, 0);
    assert.match(local.stderr + local.stdout, /403|not a machine token/);
    const wrong = sh('--join', b.net, '--token-file', tokFile, '--machine', 'other');
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr + wrong.stdout, /for machine mini, not other/);
    const r = sh('--join', b.net, '--token-file', tokFile, '--with-runner');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /joined the fleet as "mini"/);
    const client = JSON.parse(fs.readFileSync(path.join(home, '.dasks/client.json'), 'utf8'));
    assert.deepEqual([client.url, client.machine, client.token], [b.net, 'mini', fs.readFileSync(tokFile, 'utf8').trim()]);
    assert.equal(fs.statSync(path.join(home, '.dasks/client.json')).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(home, '.dasks/data')), 'no board data here');
    assert.ok(!fs.existsSync(path.join(home, '.dasks/passphrase')) && !fs.existsSync(path.join(home, '.dasks/agent-tokens.json')), 'no passphrase, no token store');
    assert.ok(!fs.existsSync(path.join(home, 'Library/LaunchAgents/dev.dasks.server.plist')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.dasks/install.json'), 'utf8')).mode, 'join');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.dasks/runner.json'), 'utf8')).runner.enabled, true);
    for (const c of ['dasks', 'dask', 'dasks-captain', 'dasks-captain-watch']) assert.ok(fs.existsSync(path.join(home, '.local/bin', c)), c);
    assert.ok(fs.existsSync(path.join(home, '.claude/skills/captain/SKILL.md')));
    const ready = spawnSync(path.join(home, '.local/bin/dask'), ['ready', '--all'], { env, encoding: 'utf8' });
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /beta\.t-one/, 'the joined Mac reads the board with its machine token');
    const un = spawnSync('bash', [path.join(ROOT, 'uninstall.sh'), '--no-claude-mcp'], { env, encoding: 'utf8' });
    assert.equal(un.status, 0, un.stderr);
    assert.ok(!fs.existsSync(path.join(home, '.local/bin/dasks-captain')));
  } finally { await b.stop(); fs.rmSync(home, { recursive: true, force: true }); }
});
