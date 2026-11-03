// Per-agent tokens against spawned servers (every token is made by the test in a temp store).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { SYSTEM_CFG, task, tempRepo } from './helpers.ts';
import { freePort, stopServer } from './spec-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const CLI = path.join(ROOT, 'bin/dasks-tokens.ts');
const CARD = 'shared.t-tok';

const A = 'codex@laptop', B = 'claude-code@laptop', L = 'human-claude@laptop';

interface Env { root: string; dir: string; store: string; cleanup: () => void }
function setup(): Env {
  const repo = tempRepo([task({ id: CARD, goal: 'shared' })]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-tokens-test-'));
  return { root: repo.root, dir, store: path.join(dir, 'agent-tokens.json'), cleanup: () => { repo.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function cli(e: Env, args: string[], extra: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, DASKS_ROOT: e.root, DASKS_AGENT_TOKENS_FILE: e.store, DASKS_UNSAFE_OWN_TOKENS_FILE: '1', DASKS_CONFIG: SYSTEM_CFG, ...extra },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const issue = (e: Env, actors: string, ...flags: string[]) => cli(e, ['issue', actors, ...flags]).trim();
const idOf = (tok: string) => tok.split('_')[1];
const secretOf = (tok: string) => tok.split('_').slice(2).join('_');

interface Srv { url: string; port: number; proc: ChildProcess; log: () => string }
async function start(e: Env, mode: string | null, extraEnv: Record<string, string> = {}): Promise<Srv> {
  const port = await freePort();
  const cfgFile = path.join(e.root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, auth: { store: 'system' } }));
  const env: Record<string, string | undefined> = { ...process.env, DASKS_ROOT: e.root, DASKS_CONFIG: cfgFile, DASKS_PORT: '',
    DASKS_SECRETS_DIR: path.join(e.dir, 'secrets'), DASKS_AGENT_TOKENS_FILE: e.store, DASKS_UNSAFE_OWN_TOKENS_FILE: '1', ...extraEnv };
  if (mode === null) delete env.DASKS_AUTH_MODE; else env.DASKS_AUTH_MODE = mode;
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d) => { out += d; });
  proc.stderr!.on('data', (d) => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, port, proc, log: () => out }; } catch { /* starting */ }
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error(`server did not start: ${out}`);
}

interface Res { status: number; body: any }
async function call(s: Srv, method: string, p: string, h: Record<string, string> = {}, body?: unknown): Promise<Res> {
  const r = await fetch(s.url + p, { method, headers: { 'Content-Type': 'application/json', ...h }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  let json: any = text; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json };
}
const hdr = (actor: string | null, tok: string | null) => ({ ...(actor ? { 'X-Dasks-Actor': actor } : {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) });
const post = (s: Srv, actor: string | null, tok: string | null, text = 'hello') => call(s, 'POST', `/api/tasks/${CARD}/messages`, hdr(actor, tok), { text });
const warnFile = (e: Env) => path.join(e.root, 'run', 'auth-warnings.jsonl');
const warnings = (e: Env): any[] => fs.existsSync(warnFile(e)) ? fs.readFileSync(warnFile(e), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
/** A token whose id is real but whose secret is wrong (same length, last char changed). */
const wrong = (tok: string) => tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A');

test('enforce: 401 no token, 401 wrong token, 403 mismatch, 401 revoked on the next request; reads open', async () => {
  const e = setup();
  const tokA = issue(e, A, '--note', 'test A');
  const s = await start(e, 'enforce');
  try {
    const none = await post(s, A, null);
    assert.equal(none.status, 401); assert.equal(none.body.rule, 'auth');
    const bad = await post(s, A, wrong(tokA));
    assert.equal(bad.status, 401); assert.equal(bad.body.rule, 'auth');
    const mismatch = await post(s, B, tokA);
    assert.equal(mismatch.status, 403); assert.equal(mismatch.body.rule, 'auth');
    const ok = await post(s, A, tokA);
    assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(ok.body.from, A);
    cli(e, ['revoke', idOf(tokA)]);
    const revoked = await post(s, A, tokA, 'after revoke');
    assert.equal(revoked.status, 401); assert.equal(revoked.body.rule, 'auth');
    for (const r of [none, bad, mismatch, revoked]) assert.ok(!JSON.stringify(r.body).includes(secretOf(tokA)), 'no token in the answer');
    assert.equal((await call(s, 'GET', `/api/tasks/${CARD}`)).status, 200);
    assert.equal((await call(s, 'GET', `/api/tasks/${CARD}`, hdr(null, 'dsk_00000000_garbage'))).status, 200);
    assert.equal(warnings(e).length, 0, 'enforce writes no warning lines');
  } finally { await stopServer(s.proc); e.cleanup(); }
});

test('warn: the four requests succeed, each appends one line with actor and reason (+ stderr)', async () => {
  const e = setup();
  const tokA = issue(e, A);
  const s = await start(e, 'warn');
  try {
    const r1 = await post(s, A, null, 'one');
    const r2 = await post(s, A, wrong(tokA), 'two');
    const r3 = await post(s, B, tokA, 'three');
    cli(e, ['revoke', idOf(tokA)]);
    const r4 = await post(s, A, tokA, 'four');
    for (const r of [r1, r2, r3, r4]) assert.equal(r.status, 201, JSON.stringify(r.body));
    // Failing tokens keep the header's actor.
    assert.deepEqual([r1, r2, r3, r4].map((r) => r.body.from), [A, A, B, A]);
    const w = warnings(e);
    assert.deepEqual(w.map((l) => [l.actor, l.reason]), [[A, 'no-token'], [A, 'bad-token'], [B, 'mismatch'], [A, 'revoked']]);
    for (const l of w) { assert.equal(l.method, 'POST'); assert.equal(l.path, `/api/tasks/${CARD}/messages`); assert.ok(l.at); }
    assert.equal(w[2].token_id, idOf(tokA)); assert.equal(w[3].token_id, idOf(tokA));
    for (const reason of ['no-token', 'bad-token', 'mismatch', 'revoked']) assert.match(s.log(), new RegExp(`auth: ${reason} \\S+ POST /api/tasks/${CARD}/messages`));
    // No header: still works as dasks, one line.
    const bot = await call(s, 'POST', `/api/tasks/${CARD}/claim`, {}, {});
    assert.notEqual(bot.status, 401); assert.notEqual(bot.status, 403);
    assert.equal(warnings(e).at(-1).actor, 'dasks');
  } finally { await stopServer(s.proc); e.cleanup(); }
});


test('a valid token with no header writes as actors[0]; labels only with --labels', async () => {
  const e = setup();
  const tokAB = issue(e, `${A},${B}`);
  const tokL = issue(e, L, '--labels');
  const tokPlain = issue(e, L);
  const s = await start(e, 'enforce');
  try {
    const first = await post(s, null, tokAB);
    assert.equal(first.status, 201, JSON.stringify(first.body)); assert.equal(first.body.from, A);
    const second = await post(s, B, tokAB);
    assert.equal(second.status, 201); assert.equal(second.body.from, B);
    const lab = await post(s, `${L}-ab12`, tokL);
    assert.equal(lab.status, 201, JSON.stringify(lab.body)); assert.equal(lab.body.from, `${L}-ab12`);
    assert.equal((await post(s, `${L}-ab12`, tokPlain)).status, 403, 'labels need --labels');
    assert.equal((await post(s, `${L}-AB12`, tokL)).status, 403, 'label is [a-z0-9]{1,8}');
    assert.equal((await post(s, `${L}-abcdefghi`, tokL)).status, 403, 'label is at most 8');
    assert.equal((await post(s, `${L}x`, tokL)).status, 403, 'a label needs the beta');
  } finally { await stopServer(s.proc); e.cleanup(); }
});

test('"user" stays the login path: a token never yields user, and issue refuses it', async () => {
  const e = setup();
  const tokA = issue(e, A);
  assert.throws(() => issue(e, 'user'));
  assert.throws(() => issue(e, `${A},User`));
  assert.throws(() => issue(e, 'bad name!'));
  const s = await start(e, 'enforce');
  try {
    const r = await post(s, 'user', tokA);
    assert.equal(r.status, 401); assert.equal(r.body.login, true, 'requireHuman answered, not the token');
    const r2 = await post(s, 'user', null);
    assert.equal(r2.status, 401); assert.equal(r2.body.login, true);
  } finally { await stopServer(s.proc); e.cleanup(); }
});

test('off: no token parsing, no lines, the header is trusted', async () => {
  const e = setup();
  const tokA = issue(e, A);
  const s = await start(e, 'off');
  try {
    const r1 = await post(s, A, null);
    assert.equal(r1.status, 201); assert.equal(r1.body.from, A);
    const r2 = await post(s, B, tokA);
    assert.equal(r2.status, 201); assert.equal(r2.body.from, B);
    const r3 = await post(s, null, tokA);
    assert.equal(r3.status, 400, 'off ignores the token: no header, no sender');
    assert.equal(fs.existsSync(warnFile(e)), false);
    assert.doesNotMatch(s.log(), /auth: /);
    assert.equal(fs.existsSync(path.join(e.root, 'run', 'agent-token-usage.json')), false, 'off never updates last-used');
  } finally { await stopServer(s.proc); e.cleanup(); }
});

test('store unavailable: missing, writable by us without the switch, or invalid -> 503 in enforce', async () => {
  const e = setup();
  // Missing store: the server still starts.
  let s = await start(e, 'enforce');
  try {
    const r = await post(s, A, 'dsk_0123abcd_' + 'A'.repeat(43));
    assert.equal(r.status, 503); assert.equal(r.body.rule, 'auth');
    assert.equal((await post(s, A, null)).status, 401, 'no token comes first');
  } finally { await stopServer(s.proc); }
  const tokA = issue(e, A);
  // A store this account owns is refused unless the unsafe test switch is on.
  s = await start(e, 'enforce', { DASKS_UNSAFE_OWN_TOKENS_FILE: '' });
  try { assert.equal((await post(s, A, tokA)).status, 503); } finally { await stopServer(s.proc); }
  s = await start(e, 'enforce');
  try {
    assert.equal((await post(s, A, tokA)).status, 201);
    const good = fs.readFileSync(e.store, 'utf8');
    const j = JSON.parse(good); j.tokens.push({ ...j.tokens[0] }); // repeated id
    fs.writeFileSync(e.store, JSON.stringify(j));
    assert.equal((await post(s, A, tokA)).status, 503);
    assert.match(s.log(), /auth: token store invalid: /);
    fs.writeFileSync(e.store, good);
    assert.equal((await post(s, A, tokA)).status, 201, 'a fixed store is read again without restart');
  } finally { await stopServer(s.proc); e.cleanup(); }
});

test('bad auth mode stops the server at start', async () => {
  const e = setup();
  try { await assert.rejects(start(e, 'loud')); } finally { e.cleanup(); }
});

test('CLI: issue prints the token once, list never shows a hash or secret, revoke marks it', async () => {
  const e = setup();
  try {
    const tok = issue(e, A, '--note', 'n1');
    assert.match(tok, /^dsk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    const store = JSON.parse(fs.readFileSync(e.store, 'utf8'));
    assert.equal(store.tokens.length, 1);
    assert.deepEqual(Object.keys(store.tokens[0]).sort(), ['actors', 'created', 'id', 'labels', 'note', 'revoked', 'sha256']);
    assert.match(store.tokens[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(store.tokens[0].revoked, null);
    assert.equal(fs.statSync(e.store).mode & 0o777, 0o600);
    const list = cli(e, ['list']);
    assert.ok(list.includes(idOf(tok)) && list.includes(A));
    assert.ok(!list.includes(store.tokens[0].sha256) && !list.includes(secretOf(tok)));
    cli(e, ['revoke', idOf(tok)]);
    assert.ok(JSON.parse(fs.readFileSync(e.store, 'utf8')).tokens[0].revoked);
    assert.throws(() => cli(e, ['revoke', 'ffffffff']));
    // Without sudo and without the switch: refused, nothing written.
    const before = fs.readFileSync(e.store, 'utf8');
    if (process.getuid!() !== 0) assert.throws(() => cli(e, ['issue', B], { DASKS_UNSAFE_OWN_TOKENS_FILE: '' }));
    assert.equal(fs.readFileSync(e.store, 'utf8'), before);
  } finally { e.cleanup(); }
});

test('no raw token anywhere on disk or in the server log', async () => {
  const e = setup();
  const tokA = issue(e, A);
  const s = await start(e, 'warn');
  let log = '';
  try {
    assert.equal((await post(s, A, tokA)).status, 201);
    assert.equal((await post(s, B, tokA)).status, 201); // mismatch line names the id only
    assert.equal((await post(s, A, wrong(tokA))).status, 201);
    cli(e, ['revoke', idOf(tokA)]);
    assert.equal((await post(s, A, tokA)).status, 201);
    assert.ok(fs.existsSync(path.join(e.root, 'run', 'agent-token-usage.json')), 'last-used was written');
    assert.ok(cli(e, ['list']).includes(idOf(tokA)));
  } finally { await stopServer(s.proc); log = s.log(); }
  try {
    const secret = Buffer.from(secretOf(tokA)), wrongSecret = Buffer.from(secretOf(wrong(tokA)));
    const hits: string[] = [];
    const walk = (p: string) => {
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); return; }
      if (!st.isFile()) return;
      const b = fs.readFileSync(p);
      if (b.includes(secret) || b.includes(wrongSecret)) hits.push(p);
    };
    walk(e.root); walk(e.dir);
    assert.deepEqual(hits, []);
    assert.ok(!log.includes(secretOf(tokA)) && !log.includes(secretOf(wrong(tokA))), 'server log has no secret');
    assert.ok(log.length > 0);
  } finally { e.cleanup(); }
});
