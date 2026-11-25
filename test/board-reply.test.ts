// GET /api/board reuses one built reply per data version: a reply whose gzip was still running when a write finished is
// never sent older than that write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { task, tempRepo } from './helpers.ts';
import { freePort, stopServer } from './spec-support.ts';

test('/api/board: a gzip reply held past a write is rebuilt, never older than that write', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one', title: 'One' })]);
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [path.resolve(import.meta.dirname, '../src/server.ts')],
    { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '', DASKS_TEST_BOARD_GZIP_DELAY_MS: '1500' }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    const plain = { 'Accept-Encoding': 'identity' };
    const before = (await (await fetch(url + '/api/board', { headers: plain })).json()).version;
    const held = fetch(url + '/api/board', { headers: { 'Accept-Encoding': 'gzip' } }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 300));   // the gzip is running (held 1.5 s)
    const w = await fetch(url + '/api/tasks/beta.t-one', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'helper' }, body: JSON.stringify({ title: 'One, renamed' }) });
    assert.equal(w.status, 200, await w.text());
    const after = await (await fetch(url + '/api/board', { headers: plain })).json();
    assert.ok(after.version > before, 'the write moved the version');
    const late = await held;
    assert.ok(late.version >= after.version, `the held reply is version ${late.version}, older than the write's ${after.version}`);
    assert.equal(late.tasks.find((t: any) => t.id === 'beta.t-one').title, 'One, renamed');
  } finally { await stopServer(proc); cleanup(); }
});
