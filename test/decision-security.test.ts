// Only a logged-in human can record a decision.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import vm from 'node:vm';
import { git, readTask, serializeTask } from '../src/lib/write.ts';
import { applyContext } from '../src/lib/collab.ts';
import { writableByUs } from '../src/lib/auth.ts';
import { task, tempRepo } from './helpers.ts';

const SERVER = path.resolve(import.meta.dirname, '../src/server.ts');
const PASS = 'dasks test login phrase 7';
const DENY = [401, 403, 409];

/** The passphrase file format: scrypt$N$r$p$<salt base64>$<hash base64>. Cheap params: test only. */
function writePassphrase(dir: string, pass: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(pass.normalize('NFC'), salt, 32, { N: 1024, r: 8, p: 1 });
  fs.writeFileSync(path.join(dir, 'passphrase'), `scrypt$1024$8$1$${salt.toString('base64')}$${hash.toString('base64')}\n`, { mode: 0o600 });
}

async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}

interface Srv { url: string; port: number; root: string; secrets: string; proc: ChildProcess; logs: string[]; cleanup: () => void }
async function startServer(env: Record<string, string> = {}): Promise<Srv> {
  const pr = 'https://github.com/example-org/dasks/pull/9';
  const review = (id: string, over: any = {}) => task({ id, goal: 'shared', status: 'review', title: `Review ${id}`, pr, pr_summary: '보안 PR 요약', approvals: 'merge', version: '3' as any, ...over });
  const { root, cleanup } = tempRepo([
    review('shared.t-pr'), review('shared.t-other', { pr: 'https://github.com/example-org/alpha/pull/4' }), review('shared.t-rply'),
    review('shared.t-race'), review('shared.t-scope'), review('shared.t-happy'), review('shared.t-html'), review('shared.t-xss'),
    review('shared.t-lgcy'), review('shared.t-rjct'), review('shared.t-infl'), review('shared.t-infl2'), review('shared.t-drct'),
    review('shared.t-patch'), review('shared.t-ptch2'), review('shared.t-ui'), review('shared.t-ctx'), review('shared.t-forgd'),
    task({ id: 'shared.t-ask2', goal: 'shared', status: 'blocked-on-user', needs_user: 'Pick a name', version: '2' as any }),
    task({ id: 'shared.t-ask', goal: 'shared', status: 'blocked-on-user', needs_user: 'Merge #5 into main?', version: '1' as any }),
    task({ id: 'shared.t-todo', goal: 'shared', status: 'todo' }),
  ]);
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-secrets-'));
  fs.chmodSync(secrets, 0o700);
  writePassphrase(secrets, PASS);
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  // Tests cannot make a root-owned passphrase file, so they opt out of that check.
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '', DASKS_SECRETS_DIR: secrets, DASKS_PASSPHRASE_FILE: path.join(secrets, 'passphrase'), DASKS_UNSAFE_OWN_PASSPHRASE_FILE: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs: string[] = [];
  proc.stdout!.on('data', (d) => logs.push(String(d))); proc.stderr!.on('data', (d) => logs.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, port, root, secrets, proc, logs, cleanup: () => { proc.kill(); cleanup(); fs.rmSync(secrets, { recursive: true, force: true }); } }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
}

interface Res { status: number; headers: http.IncomingHttpHeaders; body: any; text: string }
/** Raw HTTP (fetch would hide Origin/Cookie handling): exactly the headers given, nothing else. */
function req(s: Srv, method: string, p: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers: { Host: `127.0.0.1:${s.port}`, ...(data !== undefined ? { 'Content-Length': String(Buffer.byteLength(data)) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let j: any = null; try { j = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode!, headers: res.headers, body: j, text }); });
    });
    r.on('error', reject);
    if (data !== undefined) r.write(data);
    r.end();
  });
}

const JSONH = { 'Content-Type': 'application/json' };
const origin = (s: Srv) => `http://127.0.0.1:${s.port}`;
const ledgerFile = (s: Srv) => path.join(s.root, 'data/decisions/ledger.jsonl');
const ledgerLines = (s: Srv) => { try { return fs.readFileSync(ledgerFile(s), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

interface Session { cookie: string; csrf: string; setCookie: string }
async function login(s: Srv, extra: Record<string, string> = {}): Promise<Session> {
  const r = await req(s, 'POST', '/api/session', { ...JSONH, Origin: origin(s), ...extra }, { method: 'passphrase', passphrase: PASS });
  assert.equal(r.status, 200, `login: ${r.text}`);
  const sc = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith('dasks_session='));
  assert.ok(sc, 'login sets the dasks_session cookie');
  return { cookie: sc!.split(';')[0], csrf: r.body.csrf, setCookie: sc! };
}
/** What the inbox shows for a card: its revision and the exact scope text. */
async function shown(s: Srv, card: string) {
  const r = await req(s, 'GET', `/api/decisions/request/${card}`);
  assert.equal(r.status, 200, `decision request for ${card}: ${r.text}`);
  return r.body as { card: string; revision: number; scope: string; scope_hash: string; choices: string[] };
}
const human = (s: Srv, ss: Session) => ({ ...JSONH, Origin: origin(s), Cookie: ss.cookie, 'X-Dasks-CSRF': ss.csrf });
async function decide(s: Srv, headers: Record<string, string>, body: unknown, p = '/api/decisions') { return req(s, 'POST', p, headers, body); }

/** Run an attack and require a refusal that wrote nothing. */
async function refused(s: Srv, name: string, attack: () => Promise<Res>, codes = DENY): Promise<Res> {
  const before = ledgerLines(s);
  const r = await attack();
  assert.ok(codes.includes(r.status), `${name}: expected ${codes.join('/')} got ${r.status} ${r.text.slice(0, 200)}`);
  assert.equal(ledgerLines(s), before, `${name}: ledger must not grow`);
  return r;
}

let S: Srv; let A: Session; let B: Session;
before(async () => { S = await startServer(); });
after(() => S?.cleanup());

test('login: HttpOnly + SameSite=Strict cookie, Secure only behind https; CSRF token returned; wrong passphrase refused', async () => {
  A = await login(S);
  B = await login(S);
  assert.match(A.setCookie, /HttpOnly/i); assert.match(A.setCookie, /SameSite=Strict/i); assert.match(A.setCookie, /Path=\//);
  assert.doesNotMatch(A.setCookie, /Secure/i, 'plain http (local network) must still work: no Secure flag');
  const https = await login(S, { 'X-Forwarded-Proto': 'https', Origin: `https://127.0.0.1:${S.port}` });
  assert.match(https.setCookie, /;\s*Secure/i, 'Secure when served over https');
  assert.ok(typeof A.csrf === 'string' && A.csrf.length >= 32 && A.csrf !== B.csrf, 'per-session CSRF token');
  assert.equal((await req(S, 'POST', '/api/session', { ...JSONH, Origin: origin(S) }, { method: 'passphrase', passphrase: 'wrong' })).status, 401);
  assert.equal((await req(S, 'POST', '/api/session', { ...JSONH, Origin: 'http://evil.example' }, { method: 'passphrase', passphrase: PASS })).status, 403, 'login CSRF: cross-site login refused');
  assert.equal((await req(S, 'POST', '/api/session', JSONH, { method: 'passphrase', passphrase: PASS })).status, 403, 'login needs a same-origin browser Origin');
  const me = await req(S, 'GET', '/api/session', { Cookie: A.cookie });
  assert.equal(me.status, 200); assert.equal(me.body.csrf, A.csrf);
  assert.equal((await req(S, 'GET', '/api/session')).status, 401);
});

test('happy path: logged-in human approves exactly what was shown; signed entry appended', async () => {
  const d = await shown(S, 'shared.t-happy');
  assert.equal(d.revision, 3); assert.deepEqual(d.choices, ['approve', 'reject', 'retry']);
  assert.match(d.scope, /example-org\/dasks\/pull\/9/);
  const r = await decide(S, human(S, A), { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve', comment: 'ok, merge it' });
  assert.equal(r.status, 201, r.text);
  const lines = fs.readFileSync(ledgerFile(S), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  for (const k of ['who', 'session', 'at', 'card', 'revision', 'choice', 'scope', 'scope_hash', 'prev', 'hmac']) assert.ok(k in e, `ledger entry has ${k}`);
  assert.equal(e.who, 'user'); assert.equal(e.card, 'shared.t-happy'); assert.equal(e.revision, 3); assert.equal(e.choice, 'approve');
  assert.equal(e.scope, d.scope); assert.equal(e.scope_hash, d.scope_hash);
  assert.ok(!lines[0].includes(A.cookie.split('=')[1]), 'raw session id never stored');
  assert.match(e.hmac, /^[0-9a-f]{64}$/);
});

test('adversarial 01: no cookie', async () => {
  const d = await shown(S, 'shared.t-pr');
  await refused(S, 'no cookie', () => decide(S, { ...JSONH, Origin: origin(S), 'X-Dasks-CSRF': A.csrf }, { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' }));
});

test('adversarial 02: forged same-origin Origin via curl (no session)', async () => {
  const d = await shown(S, 'shared.t-pr');
  await refused(S, 'forged Origin', () => decide(S, { ...JSONH, Origin: origin(S), 'X-Dasks-Actor': 'user', 'User-Agent': 'curl/8.7.1' }, { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' }));
});

test('adversarial 03: X-Dasks-Actor / X-Dasks-Actor: user (any case) without a session', async () => {
  const d = await shown(S, 'shared.t-pr');
  for (const h of [{ 'X-Dasks-Actor': 'user' }, { 'X-Dasks-Actor': 'user' }, { 'X-Dasks-Actor': 'User' }])
    await refused(S, `actor header ${JSON.stringify(h)}`, () => decide(S, { ...JSONH, ...h }, { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' }));
});

test('adversarial 04: agent bearer token / query-string credentials', async () => {
  const d = await shown(S, 'shared.t-pr');
  const body = { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' };
  await refused(S, 'bearer', () => decide(S, { ...JSONH, Origin: origin(S), Authorization: `Bearer ${randomBytes(24).toString('hex')}`, 'X-Dasks-Actor': 'user' }, body));
  const sid = A.cookie.split('=')[1];
  await refused(S, 'query creds', () => decide(S, { ...JSONH, Origin: origin(S) }, body, `/api/decisions?session=${sid}&dasks_session=${sid}&csrf=${A.csrf}&actor=user`));
  await refused(S, 'body creds', () => decide(S, { ...JSONH, Origin: origin(S) }, { ...body, session: sid, csrf: A.csrf, who: 'user', actor: 'user' }));
});

test('adversarial 05: stolen CSRF token from another session', async () => {
  const d = await shown(S, 'shared.t-pr');
  await refused(S, 'stolen csrf', () => decide(S, { ...human(S, A), 'X-Dasks-CSRF': B.csrf }, { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' }));
});

test('adversarial 06: missing CSRF token', async () => {
  const d = await shown(S, 'shared.t-pr');
  const { 'X-Dasks-CSRF': _, ...h } = human(S, A);
  await refused(S, 'missing csrf', () => decide(S, h, { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' }));
});

test('adversarial 07: cross-site form POST and foreign/opaque Origins', async () => {
  const d = await shown(S, 'shared.t-pr');
  const form = `card=${d.card}&revision=${d.revision}&choice=approve&scope=${encodeURIComponent(d.scope)}`;
  await refused(S, 'cross-site form', () => decide(S, { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://evil.example', Cookie: A.cookie, 'Sec-Fetch-Site': 'cross-site' }, form));
  const body = { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' };
  for (const o of ['http://evil.example', 'null', `https://127.0.0.1:${S.port}`, `http://127.0.0.1:${S.port}.evil.example`])
    await refused(S, `origin ${o}`, () => decide(S, { ...human(S, A), Origin: o }, body));
  const { Origin: _, ...noOrigin } = human(S, A);
  await refused(S, 'no Origin', () => decide(S, noOrigin, body));
  await refused(S, 'Sec-Fetch-Site cross-site', () => decide(S, { ...human(S, A), 'Sec-Fetch-Site': 'cross-site' }, body));
});

test('adversarial 08: replay of a captured valid request returns the first result, one ledger entry', async () => {
  const d = await shown(S, 'shared.t-rply');
  const body = { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' };
  const first = await decide(S, human(S, A), body);
  assert.equal(first.status, 201, first.text);
  const n = ledgerLines(S);
  const again = await refused(S, 'replay', () => decide(S, human(S, A), body), [409]);
  assert.equal(again.body.decision.hmac, first.body.hmac, 'replay answers with the first decision');
  const other = await refused(S, 'replay, other choice', () => decide(S, human(S, B), { ...body, choice: 'reject' }), [409]);
  assert.equal(other.body.decision.choice, 'approve');
  assert.equal(ledgerLines(S), n);
  assert.equal(fs.readFileSync(ledgerFile(S), 'utf8').split('\n').filter((l) => l.includes('"shared.t-rply"')).length, 1);
});

test('adversarial 09: double-click race (10 parallel) → exactly one ledger entry', async () => {
  const d = await shown(S, 'shared.t-race');
  const n = ledgerLines(S);
  const body = { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' };
  const rs = await Promise.all(Array.from({ length: 10 }, () => decide(S, human(S, A), body)));
  assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join(','));
  assert.equal(rs.filter((r) => r.status === 409).length, 9);
  assert.equal(ledgerLines(S), n + 1);
  const first = rs.find((r) => r.status === 201)!.body.hmac;
  for (const r of rs.filter((r) => r.status === 409)) assert.equal(r.body.decision.hmac, first);
});

test('adversarial 10: decision for another card id (scope shown for card A, sent for card B)', async () => {
  const a = await shown(S, 'shared.t-pr');
  const b = await shown(S, 'shared.t-other');
  await refused(S, 'other card', () => decide(S, human(S, A), { card: b.card, revision: b.revision, scope: a.scope, choice: 'approve' }));
  await refused(S, 'unknown card', () => decide(S, human(S, A), { card: 'shared.t-nope', revision: 1, scope: a.scope, choice: 'approve' }), [404, ...DENY]);
  const todo = await req(S, 'GET', '/api/decisions/request/shared.t-todo');
  assert.equal(todo.status, 409, 'a todo card asks nothing');
  await refused(S, 'card not asking', () => decide(S, human(S, A), { card: 'shared.t-todo', revision: 0, scope: a.scope, choice: 'approve' }));
});

test('adversarial 11: decision that widens scope (action / revision / repo)', async () => {
  const d = await shown(S, 'shared.t-pr');
  const base = { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' };
  await refused(S, 'other action', () => decide(S, human(S, A), { ...base, choice: 'merge-and-deploy' }));
  await refused(S, 'newer revision', () => decide(S, human(S, A), { ...base, revision: d.revision + 1 }));
  await refused(S, 'older revision', () => decide(S, human(S, A), { ...base, revision: d.revision - 1 }));
  await refused(S, 'other repo', () => decide(S, human(S, A), { ...base, scope: d.scope.replace('example-org/dasks', 'example-org/alpha') }));
  await refused(S, 'scope + extra line', () => decide(S, human(S, A), { ...base, scope: d.scope + '\nalso: deploy to prod' }));
  await refused(S, 'scope_hash only', () => decide(S, human(S, A), { card: d.card, revision: d.revision, scope_hash: d.scope_hash, choice: 'approve' }));
});

test('adversarial 12: the card changed after it was shown (an agent edits the PR) → stale', async () => {
  const d = await shown(S, 'shared.t-scope');
  const w = await req(S, 'POST', '/api/tasks/shared.t-scope', { ...JSONH, 'X-Dasks-Actor': 'claude-code@helper' }, { pr: 'https://github.com/example-org/alpha/pull/99', what: '무엇', why: '왜', do: '할 일', rec: '추천', after: '답하면' });
  assert.equal(w.status, 200, `agent writes keep working: ${w.text}`);
  await refused(S, 'stale scope', () => decide(S, human(S, A), { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' }));
  const now = await shown(S, 'shared.t-scope');
  assert.ok(now.revision > d.revision); assert.notEqual(now.scope_hash, d.scope_hash);
});

test('adversarial 13: rotated and logged-out sessions', async () => {
  const d = await shown(S, 'shared.t-pr');
  const body = { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' };
  const old = await login(S);
  const r = await req(S, 'POST', '/api/session', { ...JSONH, Origin: origin(S), Cookie: old.cookie }, { method: 'passphrase', passphrase: PASS });
  assert.equal(r.status, 200);
  const fresh = ([] as string[]).concat(r.headers['set-cookie'] ?? [])[0].split(';')[0];
  assert.notEqual(fresh, old.cookie, 'login rotates the session id');
  await refused(S, 'rotated', () => decide(S, human(S, old), body));
  const gone = { cookie: fresh, csrf: r.body.csrf, setCookie: '' };
  assert.equal((await req(S, 'POST', '/api/session/logout', human(S, gone), {})).status, 200);
  await refused(S, 'logged out', () => decide(S, human(S, gone), body));
  await refused(S, 'garbage cookie', () => decide(S, { ...human(S, A), Cookie: 'dasks_session=' + 'A'.repeat(43) }, body));
});

test('adversarial 14: HTML/script in comment', async () => {
  const d = await shown(S, 'shared.t-html');
  const base = { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' };
  await refused(S, 'script', () => decide(S, human(S, A), { ...base, comment: '<script>fetch("/api/decisions")</script>' }));
  await refused(S, 'img onerror', () => decide(S, human(S, A), { ...base, comment: 'ok <img src=x onerror=alert(1)>' }));
  await refused(S, 'control chars', () => decide(S, human(S, A), { ...base, comment: 'ok\u0000\u001b[2J' }));
  await refused(S, 'non-string', () => decide(S, human(S, A), { ...base, comment: { html: '<b>' } }));
});

test('adversarial 15: "user" writes need the session too; agents unaffected', async () => {
  const head = git(S.root, ['rev-parse', 'HEAD']).trim();
  const patch = { status: 'done', if_status: 'review', note: 'approved from Today' };
  for (const h of [{ 'X-Dasks-Actor': 'user' }, { 'X-Dasks-Actor': 'user' }, { 'X-Dasks-Actor': 'User' }]) {
    const r = await req(S, 'POST', '/api/tasks/shared.t-xss', { ...JSONH, Origin: origin(S), ...h }, patch);
    assert.equal(r.status, 401, `forged Origin as ${JSON.stringify(h)}: ${r.text}`);
  }
  const noCsrf = await req(S, 'POST', '/api/tasks/shared.t-xss', { ...JSONH, Origin: origin(S), Cookie: A.cookie, 'X-Dasks-Actor': 'user' }, patch);
  assert.equal(noCsrf.status, 403);
  for (const p of ['/api/nodes/shared.m1', '/api/ideas/shared', '/api/views/shared', '/api/tasks', '/api/tasks/shared.t-xss/claim'])
    assert.equal((await req(S, 'POST', p, { ...JSONH, Origin: origin(S), 'X-Dasks-Actor': 'user' }, {})).status, 401, `${p} as user without session`);
  assert.equal(git(S.root, ['rev-parse', 'HEAD']).trim(), head, 'nothing committed');
  const ui = await req(S, 'POST', '/api/tasks/shared.t-xss', { ...human(S, A), 'X-Dasks-Actor': 'user' }, { note: 'from the board' });
  assert.equal(ui.status, 200, `the logged-in board UI still writes: ${ui.text}`);
  const agent = await req(S, 'POST', '/api/tasks/shared.t-todo', { ...JSONH, 'X-Dasks-Actor': 'claude-code@helper' }, { note: 'agent note' });
  assert.equal(agent.status, 200, agent.text);
  const agentAsUser = await req(S, 'POST', '/api/tasks/shared.t-todo/claim', { ...JSONH, 'X-Dasks-Actor': 'claude-code@helper' }, { who: 'user' });
  assert.ok(agentAsUser.status === 400 || agentAsUser.status === 403, `an agent cannot claim as "user": ${agentAsUser.status}`);
});

test('adversarial 16: no other route or method produces a decision', async () => {
  const d = await shown(S, 'shared.t-pr');
  const body = { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' };
  for (const [m, p] of [['PUT', '/api/decisions'], ['POST', '/api/decisions/'], ['POST', '/api/decisions/request/shared.t-pr'], ['POST', '/api/helper/decisions'], ['POST', '/api/tasks/shared.t-pr/decide'], ['DELETE', '/api/decisions'], ['PATCH', '/api/decisions']] as const)
    await refused(S, `${m} ${p}`, () => req(S, m, p, { ...JSONH, Origin: origin(S), 'X-Dasks-Actor': 'user' }, body), [401, 403, 404, 405, 409]);
  await refused(S, 'GET with body', () => req(S, 'GET', `/api/decisions?card=${d.card}&choice=approve&actor=user`, { Cookie: A.cookie }), [200]);
});

test('secrets: ledger key 0600 under the secrets dir, never in the repo, never in the logs; sessions never on disk', async () => {
  for (const f of ['ledger.key']) {
    const st = fs.statSync(path.join(S.secrets, f));
    assert.equal(st.mode & 0o077, 0, `${f} is owner-only`);
  }
  for (const f of ['session.key', 'sessions.json']) assert.ok(!fs.existsSync(path.join(S.secrets, f)), `${f}: sessions live only in the server's memory`);
  const logs = S.logs.join('');
  for (const f of ['ledger.key']) {
    const v = fs.readFileSync(path.join(S.secrets, f), 'utf8').trim();
    assert.ok(!logs.includes(v), `${f} not logged`);
  }
  assert.ok(!logs.includes(PASS) && !logs.includes(A.csrf) && !logs.includes(A.cookie.split('=')[1]));
  assert.equal(git(S.root, ['ls-files', 'data/decisions']).trim(), '', 'ledger is not committed to the board repo');
  const v = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/verify-decisions.ts'), '--key', path.join(S.secrets, 'ledger.key'), ledgerFile(S)], { encoding: 'utf8' });
  assert.equal(v.status, 0, `the server's own ledger verifies, head included: ${v.stdout}${v.stderr}`); assert.match(v.stdout, /head matches/);
});

test('adversarial 17: expired session; login brute force is rate-limited', async () => {
  const s = await startServer({ DASKS_SESSION_TTL_S: '1' });
  try {
    const ss = await login(s);
    const d = await shown(s, 'shared.t-pr');
    await new Promise((r) => setTimeout(r, 1500));
    await refused(s, 'expired', () => decide(s, human(s, ss), { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' }));
    for (let i = 0; i < 5; i++) assert.equal((await req(s, 'POST', '/api/session', { ...JSONH, Origin: origin(s) }, { method: 'passphrase', passphrase: `guess${i}` })).status, 401);
    assert.equal((await req(s, 'POST', '/api/session', { ...JSONH, Origin: origin(s) }, { method: 'passphrase', passphrase: PASS })).status, 429, 'locked out after 5 misses');
  } finally { s.cleanup(); }
});

test('no passphrase set: login is off and every human route stays closed', async () => {
  const s = await startServer();
  try {
    fs.rmSync(path.join(s.secrets, 'passphrase'));
    const r = await req(s, 'POST', '/api/session', { ...JSONH, Origin: origin(s) }, { method: 'passphrase', passphrase: PASS });
    assert.equal(r.status, 503); assert.match(r.body.error, /dasks-passphrase/);
  } finally { s.cleanup(); }
});

test('adversarial 18 (strict mode): a same-account agent replaces the passphrase file → the board refuses any file this account can write', async () => {
  // Agents run as the server's macOS account. In strict mode (DASKS_STRICT_PASSPHRASE=1), a passphrase file that account
  // owns (or could swap through a folder it owns) is not trusted: login answers 503 and no session is issued.
  const s = await startServer({ DASKS_UNSAFE_OWN_PASSPHRASE_FILE: '', DASKS_STRICT_PASSPHRASE: '1' });
  try {
    writePassphrase(s.secrets, 'agent-chosen replacement passphrase');
    for (const pass of [PASS, 'agent-chosen replacement passphrase']) {
      const r = await req(s, 'POST', '/api/session', { ...JSONH, Origin: origin(s) }, { method: 'passphrase', passphrase: pass });
      assert.equal(r.status, 503, r.text);
      assert.equal(r.headers['set-cookie'], undefined, 'no session cookie');
    }
    assert.match(s.logs.join(''), /owned by the account/);
    assert.equal(ledgerLines(s), 0);
  } finally { s.cleanup(); }
  const own = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-own-')), 'passphrase');
  fs.writeFileSync(own, 'x', { mode: 0o600 });
  assert.match(String(writableByUs(own)), /owned by the account/);
  fs.rmSync(path.dirname(own), { recursive: true });
  if (process.getuid!() !== 0 && fs.statSync('/etc/hosts').uid === 0) assert.equal(writableByUs('/etc/hosts'), null, 'a root-owned file in root-owned folders is trusted');
});

test('default mode: the passphrase file must be private (0600); a group- or world-readable one is refused', async () => {
  const s = await startServer({ DASKS_UNSAFE_OWN_PASSPHRASE_FILE: '' });
  try {
    fs.chmodSync(path.join(s.secrets, 'passphrase'), 0o600);
    assert.equal((await req(s, 'POST', '/api/session', { ...JSONH, Origin: origin(s) }, { method: 'passphrase', passphrase: PASS })).status, 200, 'own 0600 file: login works');
    fs.chmodSync(path.join(s.secrets, 'passphrase'), 0o644);
    assert.equal((await req(s, 'POST', '/api/session', { ...JSONH, Origin: origin(s) }, { method: 'passphrase', passphrase: PASS })).status, 503);
    assert.match(s.logs.join(''), /readable or writable by group or others/);
  } finally { s.cleanup(); }
});

test('adversarial 19: the Approve / Done / status menu cannot move an asking card without a signed decision', async () => {
  const head = git(S.root, ['rev-parse', 'HEAD']).trim();
  const ui = { ...human(S, A), 'X-Dasks-Actor': 'user' };
  const approveToday = { status: 'done', if_status: 'review', expected_version: 3, note: 'approved from Today (merge) https://github.com/example-org/dasks/pull/9 v3' };
  const r = await refused(S, 'Today Approve without a decision', () => req(S, 'POST', '/api/tasks/shared.t-lgcy', ui, approveToday), [409]);
  assert.equal(r.body.decision_request.card, 'shared.t-lgcy');
  await refused(S, 'Today Done on blocked-on-user', () => req(S, 'POST', '/api/tasks/shared.t-ask2', ui, { status: 'done', if_status: 'review,blocked-on-user', note: 'marked done from Today' }), [409]);
  await refused(S, 'status menu review → doing', () => req(S, 'POST', '/api/tasks/shared.t-lgcy', ui, { status: 'doing' }), [409]);
  await refused(S, 'claim (would move it to doing)', () => req(S, 'POST', '/api/tasks/shared.t-lgcy/claim', ui, { force: true }), [409]);
  await refused(S, 'finish', () => req(S, 'POST', '/api/tasks/shared.t-lgcy/finish', ui, { result: 'done', status: 'done', force: true }), [409]);
  assert.equal(git(S.root, ['rev-parse', 'HEAD']).trim(), head, 'nothing committed');
  assert.equal(readTask(S.root, 'shared.t-lgcy').status, 'review');
  // With the receipt: approve lets it become done; a reject never does, but sends it back.
  const d = await shown(S, 'shared.t-lgcy');
  assert.equal((await decide(S, human(S, A), { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' })).status, 201);
  const ok = await req(S, 'POST', '/api/tasks/shared.t-lgcy', ui, approveToday);
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.body.status, 'done');
  const j = await shown(S, 'shared.t-rjct');
  assert.equal((await decide(S, human(S, A), { card: j.card, revision: j.revision, scope: j.scope, choice: 'reject' })).status, 201);
  const no = await refused(S, 'done after reject', () => req(S, 'POST', '/api/tasks/shared.t-rjct', ui, { status: 'done' }), [409]);
  assert.match(no.body.error, /rejected/);
  assert.equal((await req(S, 'POST', '/api/tasks/shared.t-rjct', ui, { status: 'doing' })).status, 200, 'rejected → back to doing');
});

/** Send the headers and one byte of the body, run `meanwhile`, then finish the body. */
function slowPost(s: Srv, p: string, headers: Record<string, string>, body: unknown, meanwhile: () => Promise<void>): Promise<Res> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: p, headers: { Host: `127.0.0.1:${s.port}`, 'Content-Length': String(Buffer.byteLength(data)), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let j: any = null; try { j = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode!, headers: res.headers, body: j, text }); });
    });
    r.on('error', reject);
    r.write(data.slice(0, 1));
    setTimeout(() => meanwhile().then(() => r.end(data.slice(1)), reject), 150);
  });
}

test('adversarial 20: a session logged out while its request body is still arriving cannot finish the write', async () => {
  const ss = await login(S);
  const d = await shown(S, 'shared.t-infl');
  const head = git(S.root, ['rev-parse', 'HEAD']).trim();
  const logout = async () => {
    assert.equal((await req(S, 'POST', '/api/session/logout', human(S, ss), {})).status, 200);
    assert.equal((await req(S, 'GET', '/api/session', { Cookie: ss.cookie })).status, 401);
  };
  await refused(S, 'in-flight decision', () => slowPost(S, '/api/decisions', human(S, ss), { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' }, logout), [401]);
  const ss2 = await login(S);
  const logout2 = async () => { assert.equal((await req(S, 'POST', '/api/session/logout', human(S, ss2), {})).status, 200); };
  await refused(S, 'in-flight user note', () => slowPost(S, '/api/tasks/shared.t-infl2', { ...human(S, ss2), 'X-Dasks-Actor': 'user' }, { note: 'late' }, logout2), [401]);
  assert.equal(git(S.root, ['rev-parse', 'HEAD']).trim(), head, 'nothing committed');
});

test('adversarial 21: a scope changed by a direct file edit (same revision) is a new question, answerable once', async () => {
  const old = await shown(S, 'shared.t-drct');
  assert.equal((await decide(S, human(S, A), { card: old.card, revision: old.revision, scope: old.scope, choice: 'approve' })).status, 201);
  const t = readTask(S.root, 'shared.t-drct');
  t.pr = 'https://github.com/example-org/alpha/pull/123';
  fs.writeFileSync(path.join(S.root, t.file), serializeTask(t));
  const now = await shown(S, 'shared.t-drct');
  assert.equal(now.revision, old.revision); assert.notEqual(now.scope_hash, old.scope_hash);
  // The old approval does not carry over to the new PR: moving the card on needs the new answer.
  await refused(S, 'Today Approve on the old receipt', () => req(S, 'POST', '/api/tasks/shared.t-drct', { ...human(S, A), 'X-Dasks-Actor': 'user' }, { status: 'done' }), [409]);
  const replay = await refused(S, 'replay of the old question', () => decide(S, human(S, A), { card: old.card, revision: old.revision, scope: old.scope, choice: 'approve' }), [409]);
  assert.equal(replay.body.decision.scope_hash, old.scope_hash, 'replay gets the first receipt');
  const before = ledgerLines(S);
  const fresh = await decide(S, human(S, A), { card: now.card, revision: now.revision, scope: now.scope, choice: 'approve' });
  assert.equal(fresh.status, 201, fresh.text); assert.equal(fresh.body.scope_hash, now.scope_hash);
  assert.equal(ledgerLines(S), before + 1);
  await refused(S, 'second tap on the new question', () => decide(S, human(S, A), { card: now.card, revision: now.revision, scope: now.scope, choice: 'approve' }), [409]);
});

test('adversarial 22: SIGUSR1 from a same-account process does not open the Node inspector', async () => {
  S.proc.kill('SIGUSR1');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok((await fetch(S.url + '/api/health')).ok, 'still serving');
  const logs = S.logs.join('');
  assert.match(logs, /SIGUSR1 ignored/); assert.doesNotMatch(logs, /Debugger listening/);
});

test('adversarial 23: a same-account agent plants a session in the secrets dir of a running board → no session', async () => {
  // Before the board's first human request it has read nothing from the secrets dir; an agent of the same account can
  // write session.key and sessions.json there, with a cookie + CSRF it computed itself. Sessions live only in the
  // server's memory, so nothing on disk can make one.
  const s = await startServer({ DASKS_UNSAFE_OWN_PASSPHRASE_FILE: '' });
  try {
    fs.rmSync(path.join(s.secrets, 'passphrase'));
    const key = randomBytes(32);
    fs.writeFileSync(path.join(s.secrets, 'session.key'), key.toString('hex') + '\n', { mode: 0o600 });
    const sid = randomBytes(32).toString('base64url');
    const h = (x: string) => createHmac('sha256', key).update(x);
    fs.writeFileSync(path.join(s.secrets, 'sessions.json'), JSON.stringify({ v: 1, sessions: { [h(`sid\0${sid}`).digest('hex')]: Date.now() + 3600_000 } }), { mode: 0o600 });
    const forged = { ...JSONH, Origin: origin(s), Cookie: `dasks_session=${sid}`, 'X-Dasks-CSRF': h(`csrf\0${sid}`).digest('base64url') };
    assert.equal((await req(s, 'GET', '/api/session', { Cookie: forged.Cookie })).status, 401, 'a planted session is no session');
    const d = await shown(s, 'shared.t-pr');
    await refused(s, 'decision with a planted session', () => decide(s, forged, { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' }), [401]);
    await refused(s, 'user write with a planted session', () => req(s, 'POST', '/api/tasks/shared.t-pr', { ...forged, 'X-Dasks-Actor': 'user' }, { status: 'done' }), [401]);
    assert.equal(readTask(s.root, 'shared.t-pr').status, 'review');
  } finally { s.cleanup(); }
});

test('adversarial 24: one user write cannot change what was approved and move the card on with the old receipt', async () => {
  const ui = { ...human(S, A), 'X-Dasks-Actor': 'user' };
  const d = await shown(S, 'shared.t-patch');
  assert.equal((await decide(S, human(S, A), { card: d.card, revision: d.revision, scope: d.scope, choice: 'approve' })).status, 201);
  for (const [name, patch] of [['another PR', { pr: 'https://github.com/example-org/alpha/pull/123' }], ['another summary', { pr_summary: '다른 변경' }],
    ['another title', { title: 'Something else' }], ['wider approvals', { approvals: 'deploy' }], ['another 할 일', { do: 'PR 머지 후 프로덕션에 배포.' }]] as const)
    await refused(S, `done + ${name}`, () => req(S, 'POST', '/api/tasks/shared.t-patch', ui, { status: 'done', expected_version: d.revision, ...patch }), [409]);
  const t = readTask(S.root, 'shared.t-patch');
  assert.equal(t.status, 'review'); assert.equal(t.pr, 'https://github.com/example-org/dasks/pull/9');
  const ok = await req(S, 'POST', '/api/tasks/shared.t-patch', ui, { status: 'done', expected_version: d.revision, note: 'approved from Today' });
  assert.equal(ok.status, 200, ok.text);
  // Sending a card back with the question the human now asks (needs_user) is the next question, not the answered one.
  const j = await shown(S, 'shared.t-ptch2');
  assert.equal((await decide(S, human(S, A), { card: j.card, revision: j.revision, scope: j.scope, choice: 'reject' })).status, 201);
  const back = await req(S, 'POST', '/api/tasks/shared.t-ptch2', ui, { status: 'blocked-on-user', needs_user: 'Split the PR?', expected_version: j.revision });
  assert.equal(back.status, 200, back.text);
});

test('adversarial 25: the board UI signs only the scope it displayed, never a newer one it fetched', async () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function decideFirst(x, choice)'), src.indexOf('async function setStatus(id, status)'));
  const decideFirst = vm.runInNewContext(`(${fn.trim()})`, {
    t: (k: string) => k,
    api: async (route: string, body?: unknown) => {
      const r = await req(S, body === undefined ? 'GET' : 'POST', route, human(S, A), body);
      if (r.status >= 400) throw Object.assign(new Error(r.body?.error ?? r.text), { status: r.status, data: r.body });
      return r.body;
    },
  });
  const board = await req(S, 'GET', '/api/board');
  const x = board.body.tasks.find((t: any) => t.id === 'shared.t-ui'); // what the screen shows
  const t = readTask(S.root, 'shared.t-ui');
  t.pr = 'https://github.com/example-org/alpha/pull/123'; // an agent swaps the PR (direct edit, same revision)
  fs.writeFileSync(path.join(S.root, t.file), serializeTask(t));
  const before = ledgerLines(S);
  await assert.rejects(decideFirst(x, 'approve'), (e: any) => e.status === 409, 'stale screen → 409, nothing signed');
  assert.equal(ledgerLines(S), before, 'no receipt for a scope the human never saw');
});

test('adversarial 26: the requested action (Do: and the rest of the Context block) is part of the scope', async () => {
  const t = readTask(S.root, 'shared.t-ctx');
  t.body = applyContext(t.body, { what: '기능 수정', why: '사용자 검토', do: 'PR만 머지. 프로덕션 배포 금지.', rec: '검토 후 머지', after: '작업 종료' }, t.pr_summary);
  fs.writeFileSync(path.join(S.root, t.file), serializeTask(t));
  const old = await shown(S, 'shared.t-ctx');
  assert.match(old.scope, /PR만 머지\. 프로덕션 배포 금지\./, 'the scope carries the action shown');
  t.body = applyContext(t.body, { do: 'PR 머지 후 프로덕션에 배포.' });
  fs.writeFileSync(path.join(S.root, t.file), serializeTask(t));
  const now = await shown(S, 'shared.t-ctx');
  assert.equal(now.revision, old.revision); assert.notEqual(now.scope_hash, old.scope_hash);
  await refused(S, 'approval of the old action', () => decide(S, human(S, A), { card: old.card, revision: old.revision, scope: old.scope, choice: 'approve' }), [409]);
});

test('adversarial 27: a ledger line with a bad signature is no receipt', async () => {
  const s = await startServer();
  try {
    const ss = await login(s);
    const a = await shown(s, 'shared.t-happy');
    assert.equal((await decide(s, human(s, ss), { card: a.card, revision: a.revision, scope: a.scope, choice: 'approve' })).status, 201);
    // An agent that can write data/ (but has no key) appends an approval for another card: right scope and chain, bad HMAC.
    const q = await shown(s, 'shared.t-forgd');
    const lines = fs.readFileSync(ledgerFile(s), 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    const prev = createHash('sha256').update(lines[lines.length - 1]).digest('hex');
    fs.appendFileSync(ledgerFile(s), JSON.stringify({ ...last, seq: last.seq + 1, card: q.card, revision: q.revision, scope: q.scope, scope_hash: q.scope_hash, prev, hmac: '0'.repeat(64) }) + '\n');
    const n = ledgerLines(s);
    const r = await req(s, 'POST', '/api/tasks/shared.t-forgd', { ...human(s, ss), 'X-Dasks-Actor': 'user' }, { status: 'done', expected_version: q.revision });
    assert.ok([409, 503].includes(r.status), `a forged receipt must not move the card: ${r.status} ${r.text}`);
    assert.equal(readTask(s.root, 'shared.t-forgd').status, 'review');
    const again = await decide(s, human(s, ss), { card: q.card, revision: q.revision, scope: q.scope, choice: 'approve' });
    assert.ok(again.status === 503 || (again.status === 409 && !again.body?.decision), `no "already decided" from a forged line: ${again.status} ${again.text}`);
    assert.equal(ledgerLines(s), n, 'nothing appended onto a ledger that fails verification');
  } finally { s.cleanup(); }
});
