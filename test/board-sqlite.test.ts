// SQLite board store (docs/storage.md): import, a write through the server, compare; the same board from the store as
// from git; the server refusing a missing or foreign store; the default git store unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { task, tempRepo } from './helpers.ts';

const SERVER = path.resolve(import.meta.dirname, '../src/server.ts');
const CLI = path.resolve(import.meta.dirname, '../bin/board-store.ts');
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];
const git = (root: string, ...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-store-'));
const cli = (root: string, cfg: string, ...a: string[]) => spawnSync(NODE[0], [...NODE.slice(1), CLI, ...a, '--root', root], { encoding: 'utf8', env: { ...process.env, DASKS_CONFIG: cfg } });
/** A config.json outside the board (the import needs data/ clean) with a free port and, optionally, a store block. */
function config(store?: { mode: string; sqlite_path: string }): string {
  const f = path.join(tmpDir(), 'config.json');
  fs.writeFileSync(f, JSON.stringify({ server: { hosts: ['127.0.0.1'], port: 20000 + Math.floor(Math.random() * 20000) }, ...(store ? { store } : {}) }));
  return f;
}
const portOf = (cfg: string) => JSON.parse(fs.readFileSync(cfg, 'utf8')).server.port as number;

async function startServer(root: string, cfg: string): Promise<{ url: string; proc: ChildProcess; stop: () => Promise<void> }> {
  const proc = spawn(NODE[0], [...NODE.slice(1), SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfg, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; proc.stderr!.on('data', (d) => { err += d; });
  const url = `http://127.0.0.1:${portOf(cfg)}`;
  const stop = () => new Promise<void>((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', () => r()); proc.kill(); });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc, stop }; } catch { /* starting */ }
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await stop(); throw new Error(`server did not start: ${err}`);
}
const post = (url: string, p: string, body: unknown) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'claude-code@test' }, body: JSON.stringify(body) });
/** The board as the server serves it, without the fields that move with the clock (now, age_hours). */
const boardOf = async (url: string) => JSON.parse(await (await fetch(url + '/api/board')).text(), (k, v) => (k === 'now' || k === 'age_hours' ? undefined : v));

test('import, then a write through the server lands in the store only; compare sees it', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  const db = path.join(tmpDir(), 'board.db');
  const cfg = config({ mode: 'sqlite', sqlite_path: db });
  const headBefore = git(root, 'rev-parse', 'HEAD');
  try {
    let r = cli(root, cfg, 'import');
    assert.equal(r.status, 0, r.stderr);
    r = cli(root, cfg, 'compare');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /differing files: 0/);

    let s = await startServer(root, cfg);
    let id = '';
    try {
      const w = await post(s.url, '/api/tasks', { goal: 'beta', title: 'Written into the store', title_en: 'Written into the store' });
      assert.equal(w.status, 201, await w.clone().text());
      id = (await w.json()).id;
      assert.equal((await post(s.url, `/api/tasks/${id}`, { note: 'a second write' })).status, 200);
      assert.ok((await boardOf(s.url)).tasks.some((t: any) => t.id === id), 'the new card is on the board');
    } finally { await s.stop(); }
    // a restart reads it back from the store
    s = await startServer(root, cfg);
    try { assert.match((await (await fetch(`${s.url}/api/tasks/${id}`)).json()).body, /a second write/); } finally { await s.stop(); }

    // the data repo is untouched: same HEAD, clean data/
    assert.equal(git(root, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(git(root, 'status', '--porcelain', '--', 'data/'), '');
    r = cli(root, cfg, 'compare');
    assert.equal(r.status, 1, 'the store moved past the data repo');
    assert.match(r.stdout, /only in store: [1-9]/);
    r = cli(root, cfg, 'status');
    assert.match(r.stdout, /pending changes: [1-9]/);
  } finally { cleanup(); }
});

test('the server answers the same board from the store as from git', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' }), task({ id: 'alpha.t-two', goal: 'alpha', status: 'doing' })]);
  const db = path.join(tmpDir(), 'board.db');
  try {
    const g = await startServer(root, config());
    let fromGit: any; try { fromGit = await boardOf(g.url); } finally { await g.stop(); }
    const cfg = config({ mode: 'sqlite', sqlite_path: db });
    assert.equal(cli(root, cfg, 'import').status, 0);
    const s = await startServer(root, cfg);
    let fromStore: any; try { fromStore = await boardOf(s.url); } finally { await s.stop(); }
    assert.deepEqual(fromStore, fromGit);
  } finally { cleanup(); }
});

test('the server refuses to start on a missing store, and on another board\'s store; nothing is created', async () => {
  const a = tempRepo([task()]); const b = tempRepo([task()]);
  try {
    const db = path.join(tmpDir(), 'board.db');
    const missing = spawnSync(NODE[0], [...NODE.slice(1), SERVER], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, DASKS_ROOT: a.root, DASKS_CONFIG: config({ mode: 'sqlite', sqlite_path: db }), DASKS_PORT: '' } });
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /no board store at .*board-store\.ts import/s);
    assert.ok(!fs.existsSync(db), 'no db file was created');

    // a store imported from board b does not serve board a
    assert.equal(cli(b.root, config({ mode: 'sqlite', sqlite_path: db }), 'import').status, 0);
    const foreign = spawnSync(NODE[0], [...NODE.slice(1), SERVER], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, DASKS_ROOT: a.root, DASKS_CONFIG: config({ mode: 'sqlite', sqlite_path: db }), DASKS_PORT: '' } });
    assert.equal(foreign.status, 2, foreign.stderr);
    assert.match(foreign.stderr, /imported from/);
    // the CLI refuses it too, and a second import of the same store
    const cfgA = config({ mode: 'sqlite', sqlite_path: db });
    assert.equal(cli(a.root, cfgA, 'compare').status, 2);
    assert.equal(cli(b.root, config({ mode: 'sqlite', sqlite_path: db }), 'import').status, 1);
  } finally { a.cleanup(); b.cleanup(); }
});

test('import refuses a data repo with uncommitted board files', () => {
  const { root, cleanup } = tempRepo([task()]);
  try {
    const db = path.join(tmpDir(), 'board.db');
    const cfg = config({ mode: 'sqlite', sqlite_path: db });
    fs.writeFileSync(path.join(root, 'data/links.yaml'), '[]\n');
    let r = cli(root, cfg, 'import');
    assert.equal(r.status, 1); assert.match(r.stderr, /uncommitted or untracked/);
    git(root, 'checkout', '-q', '--', 'data/links.yaml');
    assert.equal(cli(root, cfg, 'import').status, 0, 'the same db imports once the data repo is clean');
  } finally { cleanup(); }
});

test('git mode (the default) is unchanged: a write is a git commit and no store file is made', async () => {
  const { root, cleanup } = tempRepo([task()]);
  const db = path.join(tmpDir(), 'unused', 'board.db');
  try {
    const before = git(root, 'rev-list', '--count', 'HEAD');
    const s = await startServer(root, config({ mode: 'git', sqlite_path: db }));
    try { assert.equal((await post(s.url, '/api/tasks/beta.t-smpl', { note: 'hello' })).status, 200); } finally { await s.stop(); }
    assert.equal(Number(git(root, 'rev-list', '--count', 'HEAD')), Number(before) + 1);
    assert.match(fs.readFileSync(path.join(root, 'data/tasks/beta/t-smpl.md'), 'utf8'), /hello/);
    assert.ok(!fs.existsSync(path.dirname(db)), 'git mode never touches the sqlite path');
  } finally { cleanup(); }
});
