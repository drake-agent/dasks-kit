// Git calls of the board are time-bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { task, tempRepo } from './helpers.ts';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');
const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
}

test('a hung git commit is stopped after the timeout: the write is a 503 and rolled back, health answers throughout', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-fakegit-'));
  const hang = path.join(bin, 'hang');
  // git as usual, except `commit` while the hang file exists: then it never finishes (exec: the killed process is it).
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash\nfor a in "$@"; do [ "$a" = commit ] && [ -e "${hang}" ] && exec sleep 25; done\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '', DASKS_GIT_TIMEOUT_MS: '1500' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  const file = path.join(root, 'data/tasks/beta/t-one.md');
  try {
    for (let i = 0; ; i++) { try { if ((await fetch(url + '/api/health')).status) break; } catch { if (i > 100) throw new Error('server did not start'); } await new Promise((r) => setTimeout(r, 100)); }
    const before = fs.readFileSync(file, 'utf8');
    const head = execFileSync(REAL_GIT, ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    fs.writeFileSync(hang, '');
    const t0 = Date.now();
    const write = fetch(url + '/api/tasks/beta.t-one', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'claude-code@test' }, body: JSON.stringify({ title: 'Renamed' }) });
    await new Promise((r) => setTimeout(r, 200));
    const health = await fetch(url + '/api/health', { signal: AbortSignal.timeout(6000) });
    assert.ok(health.status > 0, 'health answered while the git hung');
    const w = await write;
    const took = Date.now() - t0;
    assert.equal(w.status, 503);
    assert.match((await w.json()).error, /git commit did not finish in 1\.5 s and was stopped/);
    assert.ok(took < 6000, `the write waited ${took} ms`);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'rolled back');
    assert.equal(execFileSync(REAL_GIT, ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), head);
    fs.rmSync(hang);
    const ok = await fetch(url + '/api/tasks/beta.t-one', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'claude-code@test' }, body: JSON.stringify({ title: 'Renamed' }) });
    assert.equal(ok.status, 200, await ok.text());
  } finally { proc.kill('SIGKILL'); cleanup(); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('git killed after its commit landed (a slow post-commit hook): the write counts, the files stay as committed', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  // post-commit runs even with --no-verify, after HEAD moved
  fs.writeFileSync(path.join(root, '.git/hooks/post-commit'), '#!/bin/sh\nexec sleep 6\n', { mode: 0o755 });
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '', DASKS_GIT_TIMEOUT_MS: '1500' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  const rel = 'data/tasks/beta/t-one.md';
  try {
    for (let i = 0; ; i++) { try { if ((await fetch(url + '/api/health')).status) break; } catch { if (i > 100) throw new Error('server did not start'); } await new Promise((r) => setTimeout(r, 100)); }
    const before = execFileSync(REAL_GIT, ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const w = await fetch(url + '/api/tasks/beta.t-one', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'claude-code@test' }, body: JSON.stringify({ title: 'Renamed' }) });
    assert.equal(w.status, 200, await w.text());
    assert.notEqual(execFileSync(REAL_GIT, ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), before, 'HEAD moved');
    const committed = execFileSync(REAL_GIT, ['-C', root, 'show', `HEAD:${rel}`], { encoding: 'utf8' });
    assert.match(committed, /^title: Renamed$/m);
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), committed, 'the file on disk is what HEAD holds');
    assert.equal(execFileSync(REAL_GIT, ['-C', root, 'status', '--porcelain', '--', 'data'], { encoding: 'utf8' }), '');
    assert.equal(fs.existsSync(path.join(root, '.git/dasks-txn.json')), false);
  } finally { proc.kill('SIGKILL'); cleanup(); }
});

test('git killed after its commit landed and the check of HEAD times out too: the journal is kept, nothing is undone', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-fakegit-'));
  const slow = path.join(bin, 'slow');
  // The first `commit` lands, then hangs; afterwards `rev-parse --verify HEAD` hangs while the slow file exists.
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash
for a in "$@"; do
  [ "$a" = commit ] && [ ! -e "${slow}.done" ] && { "${REAL_GIT}" "$@"; touch "${slow}" "${slow}.done"; exec sleep 25; }
  [ "$a" = HEAD ] && [ -e "${slow}" ] && exec sleep 25
done
exec "${REAL_GIT}" "$@"
`, { mode: 0o755 });
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '', DASKS_GIT_TIMEOUT_MS: '1500' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  const rel = 'data/tasks/beta/t-one.md';
  const post = (title: string) => fetch(url + '/api/tasks/beta.t-one', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'claude-code@test' }, body: JSON.stringify({ title }) });
  try {
    for (let i = 0; ; i++) { try { if ((await fetch(url + '/api/health')).status) break; } catch { if (i > 100) throw new Error('server did not start'); } await new Promise((r) => setTimeout(r, 100)); }
    const w = await post('Renamed');
    assert.equal(w.status, 503, await w.text());
    const committed = execFileSync(REAL_GIT, ['-C', root, 'show', `HEAD:${rel}`], { encoding: 'utf8' });
    assert.match(committed, /^title: Renamed$/m, 'the commit landed');
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), committed, 'the file was not put back');
    assert.equal(fs.existsSync(path.join(root, '.git/dasks-txn.json')), true, 'the journal is kept for recovery');
    const stuck = await post('Renamed while stuck');
    assert.equal(stuck.status, 503, 'recovery cannot tell either, so it does not run');
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), committed, 'recovery did not put the file back');
    assert.equal(fs.existsSync(path.join(root, '.git/dasks-txn.json')), true);
    fs.rmSync(slow);
    const again = await post('Renamed again');
    assert.equal(again.status, 200, await again.text());
    assert.equal(fs.existsSync(path.join(root, '.git/dasks-txn.json')), false);
  } finally { proc.kill('SIGKILL'); cleanup(); fs.rmSync(bin, { recursive: true, force: true }); }
});
