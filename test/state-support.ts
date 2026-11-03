import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

export async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
export async function serve(root: string, env: Record<string, string> = {}, serverSource = path.resolve('src/server.ts'), cfgExtra: Record<string, unknown> = {}) {
  const port = await unusedPort();
  const cfg = path.join(root, 'test-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, ...cfgExtra }));
  // Board features are tested without agent tokens unless the test sets an auth mode (env or the test process).
  const proc = spawn(process.execPath, [serverSource], { env: { ...process.env, DASKS_AUTH_MODE: process.env.DASKS_AUTH_MODE ?? 'off', ...env, DASKS_ROOT: root, DASKS_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (x) => { logs += x; }); proc.stderr.on('data', (x) => { logs += x; });
  const url = `http://127.0.0.1:${port}`;
  try { await until(async () => (await fetch(url + '/api/health')).ok); }
  catch (e) { proc.kill(); throw e; }
  const post = (route: string, body: unknown, actor = 'sync') => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });
  return { url, proc, post, logs: () => logs, stop: async () => { const closed = new Promise<void>((r) => proc.once('exit', () => r())); proc.kill(); await closed; } };
}
export async function until(predicate: () => boolean | Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await predicate()) return; } catch { /* not there yet */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('artifact did not reach expected state');
}

// ---------- the human (board login) for tests that write as "user" ----------
import os from 'node:os';
import http from 'node:http';
import { randomBytes, scryptSync } from 'node:crypto';
export const HUMAN_PASS = 'dasks test login phrase 7';
/** Env for serve(): a passphrase file in a temp secrets dir (cheap scrypt params; the root-owned file check is off). */
export function humanSecrets(): { env: Record<string, string>; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-secrets-'));
  fs.chmodSync(dir, 0o700);
  const salt = randomBytes(16);
  const hash = scryptSync(HUMAN_PASS.normalize('NFC'), salt, 32, { N: 1024, r: 8, p: 1 });
  fs.writeFileSync(path.join(dir, 'passphrase'), `scrypt$1024$8$1$${salt.toString('base64')}$${hash.toString('base64')}\n`, { mode: 0o600 });
  return { env: { DASKS_SECRETS_DIR: dir, DASKS_PASSPHRASE_FILE: path.join(dir, 'passphrase'), DASKS_UNSAFE_OWN_PASSPHRASE_FILE: '1' }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function raw(url: string, method: string, route: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(url + route, { method, headers }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => { let json: any = t; try { json = JSON.parse(t); } catch { /* text */ } resolve({ status: res.statusCode!, headers: res.headers, json }); });
    });
    r.on('error', reject); if (body !== undefined) r.write(JSON.stringify(body)); r.end();
  });
}
const sessions = new Map<string, { cookie: string; csrf: string }>();
/** POST (or GET) as the logged-in human: session cookie + CSRF + same-origin Origin + actor user. Logs in once per server. */
export async function asHuman(url: string, route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  let s = sessions.get(url);
  if (!s) {
    const r = await raw(url, 'POST', '/api/session', { 'Content-Type': 'application/json', Origin: url }, { method: 'passphrase', passphrase: HUMAN_PASS });
    if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.json)}`);
    const sc = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith('dasks_session='))!;
    s = { cookie: sc.split(';')[0], csrf: r.json.csrf }; sessions.set(url, s);
  }
  return raw(url, method, route, { 'Content-Type': 'application/json', Origin: url, Cookie: s.cookie, 'X-Dasks-CSRF': s.csrf, 'X-Dasks-Actor': 'user' }, body);
}
/** The human answers what the card asks now (the decision_request), then the caller may move the card. */
export async function humanDecides(url: string, card: string, choice: 'approve' | 'reject') {
  const want = (await asHuman(url, `/api/decisions/request/${card}`)).json;
  return asHuman(url, '/api/decisions', { card, revision: want.revision, scope: want.scope, choice });
}
