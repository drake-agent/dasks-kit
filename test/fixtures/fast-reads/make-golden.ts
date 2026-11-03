// Writes tasks.golden.json (see SOURCE): node test/fixtures/fast-reads/make-golden.ts
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tempRepo } from '../../helpers.ts';
import { FAST_READS_TASKS } from './tasks.ts';

const { root, cleanup } = tempRepo(FAST_READS_TASKS);
const port = 20000 + Math.floor(Math.random() * 20000);
const cfgFile = path.join(root, 'test-config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
const proc = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../../src/server.ts')], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: 'ignore' });
try {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(url + '/api/health')).ok) break; } catch { /* starting */ }
    if (i > 100) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  // node:http, not fetch: no Accept-Encoding, the bytes exactly as sent.
  const http = await import('node:http');
  const bytes: Buffer = await new Promise((ok, no) => http.get(url + '/api/tasks', (r) => { const c: Buffer[] = []; r.on('data', (d) => c.push(d)); r.on('end', () => ok(Buffer.concat(c))); }).on('error', no));
  fs.writeFileSync(path.join(import.meta.dirname, 'tasks.golden.json'), bytes);
  console.log(`wrote ${bytes.length} bytes`);
} finally { proc.kill(); cleanup(); }
