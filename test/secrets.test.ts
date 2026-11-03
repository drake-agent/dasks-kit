// dask secrets and the runner pre-check, with a fake dasks-secret on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { checkSecrets, humanCommands, secretGate, secretNote } from '../src/lib/secret-gate.ts';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CARD = 'beta.t-keys';

/** A fake dasks-secret: `check` prints $FAKE_DIR/answer.json and exits with $FAKE_DIR/answer.rc (default 0). */
const FAKE_SECRET = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIR/dasks-secret.args"
[ "$1" = check ] || exit 2
cat "$FAKE_DIR/answer.json"
exit "$(cat "$FAKE_DIR/answer.rc" 2>/dev/null || echo 0)"
`;
const FAKE_AGENT = '#!/bin/bash\nprintf "%s\\n" "$*" >> "$FAKE_DIR/$(basename "$0").args"\nexit 0\n';

function fakeDir(withSecret = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-secret-fake-'));
  if (withSecret) fs.writeFileSync(path.join(dir, 'dasks-secret'), FAKE_SECRET, { mode: 0o755 });
  for (const t of ['claude', 'codex']) fs.writeFileSync(path.join(dir, t), FAKE_AGENT, { mode: 0o755 });
  const answer = (j: unknown, rc = 0) => { fs.writeFileSync(path.join(dir, 'answer.json'), JSON.stringify(j)); fs.writeFileSync(path.join(dir, 'answer.rc'), String(rc)); };
  const read = (f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  return { dir, answer, read };
}

const notReady = { agent: 'claude-code', ready: false, labels: [
  { label: 'places-key', stored: true, allowed: true, agents: ['claude-code'] },
  { label: 'maps-key', stored: true, allowed: false, agents: [] },
  { label: 'voice-key', stored: false, allowed: false, agents: [] },
] };

async function board(secrets = 'places-key, maps-key, voice-key') {
  const repo = tempRepo([task({ id: CARD, title: 'Needs keys', lane: 'claude', priority: 'p1', spec_state: 'ready', secrets, body: '\n## Context\nCall the places API.\n' } as any),
    task({ id: 'beta.t-plain', title: 'No keys' })]);
  const s = await serve(repo.root);
  const messages = async () => (await (await fetch(`${s.url}/api/tasks/${CARD}/messages`)).json()).messages as any[];
  return { ...repo, s, messages, stop: async () => { await s.stop(); repo.cleanup(); } };
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DASKS?_|CLAUDE|CODEX)/.test(k)));

test('check parsing: stored, allowed, missing; commands for the human name labels only', () => {
  const f = fakeDir();
  try {
    process.env.FAKE_DIR = f.dir;
    f.answer(notReady, 10);
    const c = checkSecrets(path.join(f.dir, 'dasks-secret'), ['places-key', 'maps-key', 'voice-key'], 'claude-code');
    assert.deepEqual(c, { ready: false, missing: ['voice-key'], notAllowed: ['maps-key'] });
    assert.equal(f.read('dasks-secret.args').trim(), 'check --labels places-key,maps-key,voice-key --json --agent claude-code');
    assert.deepEqual(humanCommands(c, 'claude-code'), [
      'dasks-secret store --label voice-key', 'dasks-secret allow --label voice-key --agent claude-code', 'dasks-secret allow --label maps-key --agent claude-code',
    ]);
    f.answer({ ready: true, labels: [{ label: 'places-key', stored: true, allowed: true }] });
    assert.equal(checkSecrets(path.join(f.dir, 'dasks-secret'), ['places-key'], 'claude-code').ready, true);
    f.answer({ ready: true, labels: [] });
    assert.deepEqual(checkSecrets(path.join(f.dir, 'dasks-secret'), ['places-key'], 'claude-code').missing, ['places-key'], 'a label the answer leaves out is missing');
    const none = checkSecrets(null, ['places-key'], 'codex');
    assert.equal(none.ready, false);
    assert.match(secretNote(none, 'codex', ['places-key'], 'test-machine'), /not installed[\s\S]*dasks-secret store --label places-key\n {2}dasks-secret allow --label places-key --agent codex/);
  } finally { delete process.env.FAKE_DIR; fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('dask secrets <card>: what is missing and the exact human commands; exit 0 only when ready', async () => {
  const b = await board();
  const f = fakeDir();
  try {
    const env = { ...cleanEnv(), DASKS_URL: b.s.url, HOME: f.dir, FAKE_DIR: f.dir, PATH: `${f.dir}:/usr/bin:/bin` };
    const dask = (...a: string[]) => spawnSync('python3', [path.join(ROOT, 'bin/dask'), ...a], { env, encoding: 'utf8' });
    f.answer(notReady, 10);
    const r = dask('secrets', CARD, '--tool', 'claude');
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /beta\.t-keys needs 3 secret\(s\) for claude-code/);
    assert.match(r.stdout, /places-key\s+ok/);
    assert.match(r.stdout, /maps-key\s+not allowed for claude-code/);
    assert.match(r.stdout, /voice-key\s+missing \(not stored\)/);
    assert.match(r.stdout, /an agent never runs allow and never asks for a value in chat/);
    assert.match(r.stdout, /^ {2}dasks-secret store --label voice-key\n {2}dasks-secret allow --label voice-key --agent claude-code\n {2}dasks-secret allow --label maps-key --agent claude-code$/m);
    assert.match(f.read('dasks-secret.args'), /^check --labels places-key,maps-key,voice-key --json --agent claude-code$/m);
    f.answer({ agent: 'codex', ready: true, labels: notReady.labels.map((x) => ({ ...x, stored: true, allowed: true })) });
    const ok = dask('secrets', CARD, '--tool', 'codex');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /ready: use them with {2}dasks-secret run --labels places-key,maps-key,voice-key -- <command>/);
    assert.match(f.read('dasks-secret.args'), /--agent codex$/m, 'codex sessions check as codex');
    fs.rmSync(path.join(f.dir, 'dasks-secret'));
    const missing = dask('secrets', CARD, '--tool', 'claude');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /dasks-secret is not installed on this Mac: the human runs \.\/install\.sh --with-secrets/);
  } finally { await b.stop(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('runner gate: a card whose secrets are not ready gets one message with the commands; a ready card starts', async () => {
  const b = await board('places-key, maps-key, voice-key');
  const f = fakeDir();
  try {
    process.env.FAKE_DIR = f.dir;
    const api = async (method: string, route: string, body?: unknown) => {
      const r = await fetch(b.s.url + route, { method, headers: { 'X-Dasks-Actor': 'runner@test-machine', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (!r.ok) throw new Error(`${method} ${route} -> ${r.status} ${await r.text()}`);
      return r.json();
    };
    const env = { api, which: (c: string) => (c === 'dasks-secret' ? path.join(f.dir, c) : null), machine: 'test-machine' };
    f.answer(notReady, 10);
    const why = await secretGate(env, CARD, 'claude');
    assert.equal(why, 'secrets not ready for claude-code (voice-key not stored, maps-key not allowed)');
    assert.equal(await secretGate(env, CARD, 'claude'), why, 'the same answer next look');
    const msgs = await b.messages();
    assert.equal(msgs.length, 1, 'the same note twice is one message');
    assert.equal(msgs[0].kind, 'blocked-on');
    assert.equal(msgs[0].to, 'human');
    assert.match(msgs[0].text, /dasks-secret store --label voice-key\n {2}dasks-secret allow --label voice-key --agent claude-code\n {2}dasks-secret allow --label maps-key --agent claude-code/);
    f.answer({ ready: true, labels: notReady.labels.map((x) => ({ ...x, stored: true, allowed: true })) });
    assert.equal(await secretGate(env, CARD, 'claude'), null);
    assert.equal(await secretGate({ ...env, which: () => null }, 'beta.t-plain', 'claude'), null, 'a card without secrets is never held');
  } finally { delete process.env.FAKE_DIR; await b.stop(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('runner e2e: --once does not claim or build a card whose secrets are not ready; it says why', async () => {
  const b = await board('voice-key');
  const f = fakeDir();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-secret-proj-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', proj]);
    const cfg = path.join(f.dir, 'runner.json');
    fs.writeFileSync(cfg, JSON.stringify({ runner: { enabled: true, timeout_min: 1, max_min: 1, idle_min: 0 }, projects: [{ id: 'beta', name: 'Beta', repo: proj }] }));
    f.answer({ agent: 'claude-code', ready: false, labels: [{ label: 'voice-key', stored: false, allowed: false, agents: [] }] }, 10);
    const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
    const env = { ...cleanEnv(), HOME: home, DASKS_URL: b.s.url, DASKS_MACHINE: 'test-machine', DASKS_RUNNER_CONFIG: cfg, FAKE_DIR: f.dir, PATH: `${f.dir}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const out = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli/runner.ts'), '--once'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = ''; p.stdout!.on('data', (d) => { o += d; }); p.stderr!.on('data', (d) => { o += d; });
      const kill = setTimeout(() => p.kill('SIGKILL'), 60_000);
      p.on('exit', (status) => { clearTimeout(kill); resolve({ status, out: o }); });
    });
    assert.equal(out.status, 0, out.out);
    assert.match(out.out, /beta\.t-keys: skipped: secrets not ready for claude-code \(voice-key not stored\)/);
    const t = await (await fetch(`${b.s.url}/api/tasks/${CARD}`)).json();
    assert.equal(t.status, 'todo');
    assert.ok(!t.claimed_by, 'never claimed');
    assert.equal(f.read('claude.args'), '', 'no agent started');
    const msgs = await b.messages();
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].text, /The runner on test-machine did not start this card/);
    assert.match(msgs[0].text, /dasks-secret store --label voice-key/);
  } finally { await b.stop(); fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true }); }
});

test('install.sh --with-secrets: builds only when asked; without the Command Line Tools it says so and goes on (dry run, temp HOME)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-sc-inst-'));
  const fake = path.join(home, 'fake');
  try {
    fs.mkdirSync(fake);
    const sh = (pathDirs: string, ...args: string[]) => spawnSync('bash', [path.join(ROOT, 'install.sh'), '--dry-run', '--no-claude-mcp', '--no-codex-mcp', ...args],
      { env: { ...process.env, HOME: home, PATH: `${pathDirs}${path.dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8' });
    const plain = sh('');
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(!/dasks-secret|Secrets for agents/.test(plain.stdout), 'off unless asked');
    const asked = sh('', '--with-secrets');
    assert.equal(asked.status, 0, asked.stderr);
    if (spawnSync('xcrun', ['--find', 'swift']).status === 0) assert.match(asked.stdout, /\[dry-run\] swift build -c release in .*\/secret, then link dasks-secret into/);
    fs.writeFileSync(path.join(fake, 'xcrun'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const noTools = sh(`${fake}:`, '--with-secrets');
    assert.equal(noTools.status, 0, noTools.stderr);
    assert.match(noTools.stdout, /skipped: the Xcode Command Line Tools are missing \(swift\)\. Fix: xcode-select --install/);
    assert.ok(!fs.existsSync(path.join(home, '.local')), 'a dry run writes nothing');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('runner gate: a card the board cannot read this look is skipped, not started', async () => {
  const failing = { api: async () => { throw new Error('GET /api/tasks/beta.t-keys?log=0 -> 503 busy'); }, which: () => null, machine: 'test-machine' };
  const why = await secretGate(failing, CARD, 'claude');
  assert.ok(why, 'a lookup error never means "no secrets"');
  assert.match(why!, /could not read the card's secrets/);
});
