// Incremental reload after writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as load from '../src/lib/load.ts';
import { serializeTask } from '../src/lib/write.ts';
import { tempRepo, task } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const ACTOR = 'test@scratch';

const mk = (id: string, over: Record<string, unknown> = {}) => task({ id, goal: 'shared', milestone: 'shared.m1', ...over } as any);
const fileOf = (root: string, id: string) => path.join(root, 'data/tasks/shared', `${id.slice('shared.'.length)}.md`);
const retitle = (root: string, id: string, title: string) => {
  const f = fileOf(root, id);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^title: .*$/m, `title: ${title}`));
};
const parses = () => (load as any).loadStats.task_parses as number;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assertExports() {
  assert.equal(typeof (load as any).reloadTaskFiles, 'function', 'load.ts exports reloadTaskFiles');
  assert.equal(typeof (load as any).loadStats?.task_parses, 'number', 'load.ts exports loadStats.task_parses');
}

// ---------- reloadTaskFiles, with loadBoard as the oracle ----------
test('reloadTaskFiles replaces one changed file', () => {
  assertExports();
  const { root, cleanup } = tempRepo(['shared.t-a', 'shared.t-b', 'shared.t-c'].map((id) => mk(id)));
  try {
    const board = load.loadBoard(root);
    retitle(root, 'shared.t-b', 'Changed');
    const before = parses();
    const next = (load as any).reloadTaskFiles(root, board, ['data/tasks/shared/t-b.md']);
    assert.equal(parses() - before, 1);
    assert.deepEqual(next, load.loadBoard(root));
    assert.equal(next.tasks.find((t: any) => t.id === 'shared.t-b')!.title, 'Changed');
  } finally { cleanup(); }
});

test('a new file is inserted in loadBoard order', () => {
  assertExports();
  const { root, cleanup } = tempRepo([mk('shared.t-a'), mk('shared.t-c')]);
  try {
    const board = load.loadBoard(root);
    const b = mk('shared.t-b');
    fs.writeFileSync(path.join(root, b.file), serializeTask(b));
    const next = (load as any).reloadTaskFiles(root, board, ['data/tasks/shared/t-b.md']);
    assert.deepEqual(next, load.loadBoard(root));
    assert.deepEqual(next.tasks.map((t: any) => t.id), ['shared.t-a', 'shared.t-b', 'shared.t-c']);
  } finally { cleanup(); }
});

test('a deleted file removes the task', () => {
  assertExports();
  const { root, cleanup } = tempRepo(['shared.t-a', 'shared.t-b', 'shared.t-c'].map((id) => mk(id)));
  try {
    const board = load.loadBoard(root);
    fs.unlinkSync(fileOf(root, 'shared.t-b'));
    const next = (load as any).reloadTaskFiles(root, board, ['data/tasks/shared/t-b.md']);
    assert.deepEqual(next, load.loadBoard(root));
    assert.equal(next.tasks.length, 2);
  } finally { cleanup(); }
});

test('board files, directories or nothing give null; other data files are ignored', () => {
  assertExports();
  const { root, cleanup } = tempRepo([mk('shared.t-a')]);
  try {
    const board = load.loadBoard(root);
    for (const rels of [[], ['data/goals/shared.yaml'], ['data/goals'], ['data/links.yaml'], ['data/northstar.yaml'], ['data'], ['data/tasks'], ['data/tasks/shared'], ['data/tasks/shared/x.txt']])
      assert.equal((load as any).reloadTaskFiles(root, board, rels), null, JSON.stringify(rels));
    const before = parses();
    const next = (load as any).reloadTaskFiles(root, board, ['data/activity/shared/t-x.jsonl']);
    assert.deepEqual(next, board);
    assert.equal(parses() - before, 0);
  } finally { cleanup(); }
});

test('a parse error gives null; fixing the file clears its load error', () => {
  assertExports();
  const { root, cleanup } = tempRepo([mk('shared.t-a'), mk('shared.t-b')]);
  try {
    const board = load.loadBoard(root);
    const f = fileOf(root, 'shared.t-b');
    const good = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, 'no frontmatter here\n');
    assert.equal((load as any).reloadTaskFiles(root, board, ['data/tasks/shared/t-b.md']), null);
    const broken = load.loadBoard(root);
    assert.equal(broken.loadErrors.length, 1);
    fs.writeFileSync(f, good);
    const next = (load as any).reloadTaskFiles(root, broken, ['data/tasks/shared/t-b.md']);
    assert.deepEqual(next, load.loadBoard(root));
    assert.equal(next.loadErrors.length, 0);
  } finally { cleanup(); }
});

// ---------- a real server ----------
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
}
async function startServer(root: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.resume(); proc.stderr!.resume();
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc }; } catch { /* starting */ }
    await sleep(100);
  }
  proc.kill(); throw new Error('server did not start');
}
async function stopServer(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const gone = new Promise((r) => proc.once('exit', r));
  proc.kill(); await gone;
}
async function withServer(root: string, fn: (url: string) => Promise<void>) {
  const { url, proc } = await startServer(root);
  try { await fn(url); } finally { await stopServer(proc); }
}
const headers = { 'content-type': 'application/json', 'X-Dasks-Actor': ACTOR };
async function post(url: string, p: string, body: unknown) {
  const r = await fetch(url + p, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
}
async function getJson(url: string, p: string) {
  const r = await fetch(url + p, { headers: { 'X-Dasks-Actor': ACTOR } });
  assert.equal(r.status, 200, `GET ${p}`);
  return r.json() as Promise<any>;
}
/** The health reload counters; the key must be there. */
async function counters(url: string): Promise<{ full: number; incremental: number; task_parses: number }> {
  const h = await getJson(url, '/api/health');
  assert.ok(h.reload && typeof h.reload === 'object', '/api/health has a reload key');
  return h.reload;
}
async function waitFor(fn: () => Promise<boolean>, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  assert.fail(`timed out waiting for: ${what}`);
}
const note = (url: string, id: string, text: string) => post(url, `/api/tasks/${id}`, { note: text });

test('server: one note write parses one file', async () => {
  const { root, cleanup } = tempRepo([mk('shared.t-a'), mk('shared.t-b')]);
  try {
    await withServer(root, async (url) => {
      const c0 = await counters(url);
      const r = await note(url, 'shared.t-a', 'hello');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const c1 = await counters(url);
      assert.equal(c1.incremental - c0.incremental, 1);
      assert.equal(c1.full - c0.full, 0);
      assert.equal(c1.task_parses - c0.task_parses, 1);
    });
  } finally { cleanup(); }
});

test('server: a burst of writes causes no full reload', async () => {
  const ids = [1, 2, 3, 4, 5, 6].map((i) => `shared.t-b${i}`);
  const { root, cleanup } = tempRepo(ids.map((id) => mk(id)));
  try {
    await withServer(root, async (url) => {
      const c0 = await counters(url);
      for (let i = 0; i < 12; i++) {
        const r = await note(url, ids[i % 6], `burst ${i}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      await sleep(600);
      const c1 = await counters(url);
      assert.equal(c1.full - c0.full, 0);
    });
  } finally { cleanup(); }
});

test('server: a hand edit still shows, also with a write in between; no full reload', async () => {
  const { root, cleanup } = tempRepo([mk('shared.t-x'), mk('shared.t-y')]);
  try {
    await withServer(root, async (url) => {
      const c0 = await counters(url);
      retitle(root, 'shared.t-x', 'Hand edited');
      execFileSync('git', ['-C', root, 'commit', '-qam', 'hand edit'], { stdio: 'pipe' });
      const r = await note(url, 'shared.t-y', 'between');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await waitFor(async () => (await getJson(url, '/api/tasks/shared.t-x')).title === 'Hand edited', 'the hand edit shows');
      assert.match((await getJson(url, '/api/tasks/shared.t-y')).body, /between/);
      const c1 = await counters(url);
      assert.equal(c1.full - c0.full, 0);
    });
  } finally { cleanup(); }
});

test('server: a hand edit shows while file events keep coming', async () => {
  const { root, cleanup } = tempRepo([mk('shared.t-x')]);
  try {
    await withServer(root, async (url) => {
      await counters(url);
      const noise = path.join(root, 'data/activity/shared/noise.jsonl');
      fs.mkdirSync(path.dirname(noise), { recursive: true });
      const timer = setInterval(() => fs.appendFileSync(noise, '{"n":1}\n'), 100);
      try {
        await sleep(300);
        retitle(root, 'shared.t-x', 'Edited under noise');
        await waitFor(async () => (await getJson(url, '/api/tasks/shared.t-x')).title === 'Edited under noise', 'the hand edit shows under constant events');
      } finally { clearInterval(timer); }
    });
  } finally { cleanup(); }
});

test('server: a goal file edit still reloads the whole board', async () => {
  const { root, cleanup } = tempRepo([mk('shared.t-a')]);
  try {
    await withServer(root, async (url) => {
      const c0 = await counters(url);
      fs.appendFileSync(path.join(root, 'data/goals/shared.yaml'), '\n');
      await waitFor(async () => (await counters(url)).full - c0.full >= 1, 'a full reload');
    });
  } finally { cleanup(); }
});

/** A seeded linear congruential generator, so the write sequence is the same every run. */
function seeded(seed: number) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

test('server: 100 random writes equal a fresh start', async () => {
  const pool = Array.from({ length: 20 }, (_, i) => `shared.t-r${i}`);
  const { root, cleanup } = tempRepo(pool.map((id) => mk(id)));
  try {
    const rnd = seeded(42);
    let a: any;
    await withServer(root, async (url) => {
      const c0 = await counters(url);
      for (let i = 0; i < 100; i++) {
        if (rnd() < 0.7) {
          const id = pool[Math.floor(rnd() * pool.length)];
          const r = await note(url, id, `rand note ${i}`);
          assert.ok(r.status >= 200 && r.status < 300, `note ${i}: ${r.status} ${JSON.stringify(r.body)}`);
        } else {
          const r = await post(url, '/api/tasks', { goal: 'shared', title: `rand ${i}`, title_ko: `무작위 ${i}`, title_en: `rand ${i}`, milestone: 'shared.m1' });
          assert.ok(r.status >= 200 && r.status < 300, `create ${i}: ${r.status} ${JSON.stringify(r.body)}`);
          if (r.body?.id && !r.body.intake) pool.push(r.body.id);
        }
      }
      await sleep(1000);
      a = await getJson(url, '/api/tasks');
      assert.ok((await counters(url)).incremental - c0.incremental >= 1);
    });
    await withServer(root, async (url) => {
      const b = await getJson(url, '/api/tasks');
      assert.deepEqual(a, b);
    });
  } finally { cleanup(); }
});
