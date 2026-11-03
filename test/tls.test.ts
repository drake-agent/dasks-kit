// TLS for the board (certificates made here with openssl, never committed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { task, tempRepo } from './helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src/server.ts');
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
}
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DASKS?_|^NODE_EXTRA_CA_CERTS$/.test(k)));

/** A throwaway CA and a server certificate it signed for 127.0.0.1 and localhost. */
function makeCerts(dir: string) {
  const ssl = (...a: string[]) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=dasks test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'subjectKeyIdentifier=hash', '-addext', 'authorityKeyIdentifier=keyid:always', '-addext', 'keyUsage=critical,keyCertSign');
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'board.key', '-out', 'board.csr', '-subj', '/CN=localhost');
  // Python's OpenSSL 3 checks strictly: key ids on both, a CA marked as one (LibreSSL's openssl adds none by itself).
  fs.writeFileSync(path.join(dir, 'ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nauthorityKeyIdentifier=keyid,issuer\nbasicConstraints=CA:FALSE\n');
  ssl('x509', '-req', '-in', 'board.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'board.pem', '-days', '1', '-extfile', 'ext');
  return { ca: path.join(dir, 'ca.pem'), cert: path.join(dir, 'board.pem'), key: path.join(dir, 'board.key') };
}

test('a listen address beyond this Mac without TLS refuses to start, naming server.tls and allow_plain_http', async () => {
  const { root, cleanup } = tempRepo();
  try {
    const cfgFile = path.join(root, 'test-config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port: await freePort(), listen: '10.11.12.13' } }));
    const r = spawnSync(process.execPath, [SERVER], { env: { ...clean(), DASKS_ROOT: root, DASKS_CONFIG: cfgFile }, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /refusing to start: serving 10\.11\.12\.13 \(beyond this Mac\) needs TLS: set server\.tls .*allow_plain_http: true/);
    // Saying so explicitly passes this check (the bind then fails: the address is not on this Mac).
    fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port: await freePort(), listen: '10.11.12.13', allow_plain_http: true } }));
    const p = spawnSync(process.execPath, [SERVER], { env: { ...clean(), DASKS_ROOT: root, DASKS_CONFIG: cfgFile }, encoding: 'utf8', timeout: 20000 });
    assert.doesNotMatch(p.stderr, /needs TLS/);
    fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port: await freePort(), tls: { cert: 'x' } } }));
    const bad = spawnSync(process.execPath, [SERVER], { env: { ...clean(), DASKS_ROOT: root, DASKS_CONFIG: cfgFile }, encoding: 'utf8', timeout: 20000 });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /server\.tls must be/);
  } finally { cleanup(); }
});

test('server.tls: the board serves https; the CLIs reach it with the CA file and refuse it without', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one', title: 'Over TLS' })]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-tls-'));
  const c = makeCerts(dir);
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port, tls: { cert: c.cert, key: c.key } } }));
  const env = { ...clean(), HOME: dir, DASKS_HOME: path.join(dir, '.dasks'), DASKS_AUTH_MODE: 'off' };
  const proc = spawn(process.execPath, [SERVER], { env: { ...env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout!.on('data', (d) => { log += d; }); proc.stderr!.on('data', (d) => { log += d; });
  const url = `https://127.0.0.1:${port}`;
  try {
    for (let i = 0; !/dasks listening on https:\/\/127\.0\.0\.1/.test(log); i++) { if (i > 100) throw new Error(log); await new Promise((r) => setTimeout(r, 100)); }
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) }));
    const curl = (...a: string[]) => spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', ...a, url + '/api/health'], { encoding: 'utf8' });
    assert.equal(curl('--cacert', c.ca).stdout, '200');
    assert.notEqual(curl().status, 0, 'an unknown CA is refused');

    const cli = (extra: Record<string, string>) => spawnSync(process.execPath, [path.join(ROOT, 'mcp/board-cli.mjs'), 'show', 'beta.t-one'], { env: { ...env, DASKS_URL: url, ...extra }, encoding: 'utf8', timeout: 30000 });
    const ok = cli({ DASKS_CA_FILE: c.ca });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /Over TLS/);
    const no = cli({});
    assert.notEqual(no.status, 0); assert.match(no.stderr + no.stdout, /unreachable|certificate|UNABLE_TO_VERIFY/i);

    // client.json `ca` (what install.sh --ca-file stores) works the same, for Node and the Python dask CLI.
    fs.mkdirSync(env.DASKS_HOME, { recursive: true });
    fs.writeFileSync(path.join(env.DASKS_HOME, 'client.json'), JSON.stringify({ url, machine: 'tlsbox', ca: c.ca }), { mode: 0o600 });
    const viaFile = spawnSync(process.execPath, [path.join(ROOT, 'mcp/board-cli.mjs'), 'show', 'beta.t-one'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(viaFile.status, 0, viaFile.stdout + viaFile.stderr);
    const py = spawnSync('python3', [path.join(ROOT, 'bin/dask'), 'ready', '--all'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(py.status, 0, py.stdout + py.stderr);
    assert.match(py.stdout, /beta\.t-one/);
  } finally { proc.kill(); cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});
