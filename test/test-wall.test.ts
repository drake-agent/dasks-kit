// scripts/test-wall.ts, the wall clock npm test runs under.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const F = 'test/fixtures/test-wall/';
const INNER = ['node', '--test', '--test-timeout=900000', '--test-force-exit'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Result = { code: number | null; signal: NodeJS.Signals | null; out: string; err: string; ms: number; pgid: number; marks: string[] };
type Run = { pid: number; marks: () => string[]; result: Promise<Result>; cleanup: () => void };

function kill(target: number, signal: NodeJS.Signals = 'SIGKILL') {
  // A negative target is a process group; 0, ±1 or NaN would hit this process's group or every process.
  if (!(Math.abs(target) > 1)) return;
  try { process.kill(target, signal); } catch (e: any) { if (e.code !== 'ESRCH' && e.code !== 'EPERM') throw e; }
}
function readMarks(file: string): string[] {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^\w+ \d+$/.test(l)); } catch { return []; }
}
function markPids(marks: string[]): number[] {
  return marks.map((l) => Number(l.split(' ')[1]));
}

function wall(args: string[], env: Record<string, string> = {}, wallMs = 30000): Run {
  const mark = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'test-wall-')), 'marks');
  fs.writeFileSync(mark, '');
  const base: NodeJS.ProcessEnv = { ...process.env };
  // A nested `node --test` that inherits NODE_TEST_CONTEXT reports to the outer runner.
  delete base.NODE_TEST_CONTEXT;
  delete base.DASKS_TEST_WALL_MS;
  const childEnv: NodeJS.ProcessEnv = { ...base, TEST_WALL_MARK: mark, ...env };
  const t0 = Date.now();
  const child = spawn(process.execPath, ['scripts/test-wall.ts', ...args], { cwd: ROOT, env: childEnv, detached: true });
  const pid = child.pid!;
  let pgid = 0;
  let out = '';
  let err = '';
  const killAll = () => {
    kill(-pid);
    if (pgid) kill(-pgid);
    for (const p of markPids(readMarks(mark))) kill(p);
  };
  const result = new Promise<Result>((resolve, reject) => {
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => {
      err += d;
      const m = /^test-wall: pgid=(\d+) /m.exec(err);
      if (m && !pgid) pgid = Number(m[1]);
    });
    const safety = setTimeout(() => {
      killAll();
      reject(new Error(`hung: ${wallMs} ms\n${err}`));
    }, wallMs);
    child.on('error', (e) => { clearTimeout(safety); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(safety);
      resolve({ code, signal, out, err, ms: Date.now() - t0, pgid, marks: readMarks(mark) });
    });
  });
  result.catch(() => {});
  return {
    pid,
    marks: () => readMarks(mark),
    result,
    cleanup: () => { killAll(); fs.rmSync(path.dirname(mark), { recursive: true, force: true }); },
  };
}

/** Waits until no process has one of `pgids` or `pids`, up to 5 s. */
async function gone(pgids: number[], pids: number[]) {
  let rows: string[] = [];
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await sleep(100)) {
    const table = execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' });
    rows = table.split('\n').filter((l) => {
      const [p, g] = l.trim().split(/\s+/).map(Number);
      return pids.includes(p) || pgids.includes(g);
    });
    if (rows.length === 0) return;
  }
  assert.fail(`still present after 5 s:\n${rows.join('\n')}`);
}

const lines = (s: string) => s.split('\n').filter(Boolean);
const lastLine = (s: string) => lines(s).at(-1) ?? '';

test('the test script runs the suite through the wall cap', { timeout: 60_000 }, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/test-wall.ts node --test --test-timeout=900000 --test-force-exit --import=./test/file-limit-preload.ts test/*.test.ts');
});

test('a busy loop is stopped at the wall cap and its file is named', { timeout: 60_000 }, async () => {
  const run = wall([...INNER, F + 'busy.fixture.ts', F + 'ok.fixture.ts'], { DASKS_TEST_WALL_MS: '5000' });
  try {
    const r = await run.result;
    assert.equal(r.code, 124, r.err);
    assert.ok(r.ms < 20000, `took ${r.ms} ms`);
    assert.match(r.err, /^test-wall: WALL CAP 5\.0s pgid=\d+$/m);
    assert.ok(lines(r.err).includes('test-wall: still running test/fixtures/test-wall/busy.fixture.ts'), r.err);
    assert.ok(!lines(r.err).includes('test-wall: still running test/fixtures/test-wall/ok.fixture.ts'), r.err);
    assert.match(lastLine(r.err), /^test-wall: exit 124 after /);
    const busy = r.marks.filter((l) => l.startsWith('busy '));
    assert.equal(busy.length, 1, r.marks.join('\n'));
    await gone([r.pgid], markPids(busy));
  } finally {
    run.cleanup();
  }
});

test('the exit code passes through', { timeout: 60_000 }, async () => {
  const ok = wall([...INNER, F + 'ok.fixture.ts']);
  try {
    const r = await ok.result;
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^(# |ℹ )pass 1$/m, r.out);
    assert.ok(!r.err.includes('WALL CAP'), r.err);
    assert.match(r.err, /^test-wall: pgid=\d+ cap=1080000ms$/m);
  } finally {
    ok.cleanup();
  }
  const fail = wall([...INNER, F + 'fail.fixture.ts']);
  try {
    const r = await fail.result;
    assert.equal(r.code, 1, r.err);
    assert.ok(r.out.includes('test-wall fixture failure'), r.out);
  } finally {
    fail.cleanup();
  }
});

test('leftovers in the group are killed when the run ends', { timeout: 60_000 }, async () => {
  const run = wall([...INNER, F + 'leak.fixture.ts']);
  try {
    const r = await run.result;
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /^test-wall: killed [1-9]\d* leftover process\(es\) pgid=\d+$/m);
    const sleeps = r.marks.filter((l) => l.startsWith('sleep '));
    assert.equal(sleeps.length, 1, r.marks.join('\n'));
    await gone([r.pgid], markPids(sleeps));
  } finally {
    run.cleanup();
  }
});

test('TERM and INT stop the whole group', { timeout: 60_000 }, async () => {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    const run = wall([...INNER, F + 'busy.fixture.ts'], { DASKS_TEST_WALL_MS: '60000' });
    try {
      let settled = false;
      run.result.then(() => (settled = true), () => (settled = true));
      let busy: string[] = [];
      for (const deadline = Date.now() + 10000; ; await sleep(100)) {
        if (settled) assert.fail(`${signal}: the wrapper ended before the busy fixture started`);
        busy = run.marks().filter((l) => l.startsWith('busy '));
        if (busy.length) break;
        if (Date.now() > deadline) assert.fail(`${signal}: no busy mark after 10 s`);
      }
      const sent = Date.now();
      process.kill(run.pid, signal);
      const r = await run.result;
      assert.equal(r.code, code, `${signal}\n${r.err}`);
      assert.ok(Date.now() - sent < 10000, `${signal}: took ${Date.now() - sent} ms`);
      assert.ok(lines(r.err).includes('test-wall: still running test/fixtures/test-wall/busy.fixture.ts'), r.err);
      await gone([r.pgid], markPids(busy));
    } finally {
      run.cleanup();
    }
  }
});

test('bad input exits 2', { timeout: 60_000 }, async () => {
  for (const env of [{ DASKS_TEST_WALL_MS: 'abc' }, { DASKS_TEST_WALL_MS: '0' }]) {
    const run = wall([...INNER, F + 'ok.fixture.ts'], env);
    try {
      const r = await run.result;
      assert.equal(r.code, 2, `${env.DASKS_TEST_WALL_MS}\n${r.err}`);
    } finally {
      run.cleanup();
    }
  }
  const none = wall([]);
  try {
    const r = await none.result;
    assert.equal(r.code, 2, r.err);
  } finally {
    none.cleanup();
  }
});
