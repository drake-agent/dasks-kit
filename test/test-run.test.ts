// scripts/test-run.ts: npm test hands node:test run() the files longest-first by test/file-times.json
// (README.md "Test order"). Fixtures are written to a temp dir, outside the test/*.test.ts glob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { concurrencyFor, orderFiles } from '../scripts/test-run.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts', 'test-run.ts');

test('order: unknown files first by name, then known longest first, ties by name', () => {
  const times = { 'test/a.test.ts': 10, 'test/b.test.ts': 300, 'test/c.test.ts': 10, 'test/d.test.ts': 50, 'test/bad.test.ts': -1 };
  const files = ['test/a.test.ts', 'test/z-new.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts', 'test/bad.test.ts', 'test/m-new.test.ts'];
  assert.deepEqual(orderFiles(files, times), [
    'test/bad.test.ts', 'test/m-new.test.ts', 'test/z-new.test.ts',
    'test/b.test.ts', 'test/d.test.ts', 'test/a.test.ts', 'test/c.test.ts',
  ]);
});

test('concurrency: cores minus one, raised to the floor, never below 1', () => {
  assert.equal(concurrencyFor(10, 4), 9);
  assert.equal(concurrencyFor(3, 4), 4);
  assert.equal(concurrencyFor(3, 1), 2);
  assert.equal(concurrencyFor(1, 1), 1);
});

test('--min-concurrency=N runs N files at once on any machine; the run says how many', { timeout: 60_000 }, () => {
  const { dir, write } = rig();
  try {
    // Each file waits until all of them have started (a marker per file), so the run only ends when N ran together.
    const n = Math.max(os.availableParallelism() + 2, 4);
    const names = Array.from({ length: n }, (_, i) => `f${i}.test.mjs`);
    for (const f of names) write(f, `import fs from 'node:fs';\nfs.writeFileSync('started-${f}', '');\ntest('${f}', async () => { const t = Date.now(); while (fs.readdirSync('.').filter((x) => x.startsWith('started-')).length < ${n}) { if (Date.now() - t > 20000) throw new Error('not all files ran at once'); await new Promise((r) => setTimeout(r, 50)); } });`);
    const r = spawnSync(process.execPath, [RUNNER, `--min-concurrency=${n}`, ...names], { cwd: dir, env: env(), encoding: 'utf8', timeout: 50_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`^test-run: ${n} files, ${n} at once$`, 'm'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every test file in the times file still exists, and the times are whole ms', () => {
  const times = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'file-times.json'), 'utf8'));
  for (const [f, ms] of Object.entries(times)) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is gone: rerun with --write-times or drop it`);
    assert.ok(Number.isInteger(ms) && (ms as number) >= 0, `${f}: ${ms}`);
  }
});

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-run-'));
  fs.mkdirSync(path.join(dir, 'test'));
  const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), `import { test } from 'node:test';\nimport assert from 'node:assert';\n${body}\n`);
  return { dir, write };
}
const env = () => {
  const e = { ...process.env };
  delete e.NODE_TEST_CONTEXT; // a nested runner that inherits it reports to the outer one
  return e;
};

test('the run starts files in recorded order, passes --test-timeout and --import to each file, exit 0', { timeout: 60_000 }, () => {
  const { dir, write } = rig();
  try {
    for (const n of ['a', 'b', 'c']) write(`${n}.test.mjs`, `test('${n}', () => { console.error('START ${n} ' + process.execArgv.filter((a) => a.startsWith('--test-timeout=') || a.startsWith('--import=')).join(' ')); });`);
    fs.writeFileSync(path.join(dir, 'test', 'file-times.json'), JSON.stringify({ 'a.test.mjs': 1, 'b.test.mjs': 30, 'c.test.mjs': 20 }));
    fs.writeFileSync(path.join(dir, 'pre.mjs'), '');
    const r = spawnSync(process.execPath, [RUNNER, '--test-timeout=7000', '--test-force-exit', '--import=./pre.mjs', 'a.test.mjs', 'b.test.mjs', 'c.test.mjs'], { cwd: dir, env: env(), encoding: 'utf8', timeout: 50_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^TAP version/m);
    const starts = [...(r.stdout + r.stderr).matchAll(/START (\w) (.*)/g)];
    assert.deepEqual(starts.map((m) => m[1]), ['b', 'c', 'a']);
    for (const m of starts) {
      assert.match(m[2], /--test-timeout=7000/);
      assert.match(m[2], /--import=\.\/pre\.mjs/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing test exits 1; --write-times records the files that ran and keeps the others', { timeout: 60_000 }, () => {
  const { dir, write } = rig();
  try {
    write('ok.test.mjs', `test('ok', () => {});`);
    write('bad.test.mjs', `test('bad', () => { assert.equal(1, 2); });`);
    write('kept.test.mjs', '');
    fs.writeFileSync(path.join(dir, 'test', 'file-times.json'), JSON.stringify({ 'ok.test.mjs': 5, 'gone.test.mjs': 9, 'kept.test.mjs': 4 }));
    const r = spawnSync(process.execPath, [RUNNER, '--write-times', 'ok.test.mjs', 'bad.test.mjs'], { cwd: dir, env: env(), encoding: 'utf8', timeout: 50_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const times = JSON.parse(fs.readFileSync(path.join(dir, 'test', 'file-times.json'), 'utf8'));
    assert.deepEqual(Object.keys(times), ['bad.test.mjs', 'kept.test.mjs', 'ok.test.mjs']);
    assert.equal(times['kept.test.mjs'], 4);
    assert.ok(Number.isInteger(times['ok.test.mjs']));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bad input exits 2 with a reason', { timeout: 30_000 }, () => {
  for (const args of [[], ['--test-timeout=abc', 'x.test.ts'], ['--min-concurrency=0', 'x.test.ts'], ['--min-concurrency=2.5', 'x.test.ts'], ['--nope', 'x.test.ts'], ['missing.test.ts']]) {
    const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT, env: env(), encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^test-run: /m);
  }
});

// Review pass 1 (Codex sol): R1 a path with a space or Korean name ran nothing and exited 0; R2 `todo: ''` failed the
// run; R3 the recorded time left out module load and after hooks.
test('R1: from a folder named with a space and Korean, a failing test still runs and exits 1', { timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test run 리뷰 '));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(RUNNER, path.join(dir, 'scripts', 'test-run.ts'));
    fs.copyFileSync(path.join(ROOT, 'scripts', 'test-time-preload.ts'), path.join(dir, 'scripts', 'test-time-preload.ts'));
    fs.writeFileSync(path.join(dir, 'bad.test.mjs'), `import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('bad', () => { assert.equal(1, 2); });\n`);
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'test-run.ts'), 'bad.test.mjs'], { cwd: dir, env: env(), encoding: 'utf8', timeout: 50_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /not ok \d+ - bad/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: a failing test marked todo: '' does not fail the run", { timeout: 60_000 }, () => {
  const { dir, write } = rig();
  try {
    write('todo.test.mjs', `test('todo', { todo: '' }, () => { throw new Error('expected todo'); });\ntest('ok', () => {});`);
    const r = spawnSync(process.execPath, [RUNNER, 'todo.test.mjs'], { cwd: dir, env: env(), encoding: 'utf8', timeout: 50_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Review pass 1 (Codex sol, dasks-kit PR 24): P1 a todo test whose late async error fails its file still exited 0.
test('P1: a late uncaught error after a failing todo test fails the run, as node --test does', { timeout: 60_000 }, () => {
  const { dir, write } = rig();
  try {
    write('late.test.mjs', `test('todo', { todo: true }, () => { setTimeout(() => { throw new Error('late'); }, 10); throw new Error('todo'); });\ntest('wait', () => new Promise((r) => setTimeout(r, 100)));`);
    const r = spawnSync(process.execPath, [RUNNER, '--test-force-exit', 'late.test.mjs'], { cwd: dir, env: env(), encoding: 'utf8', timeout: 50_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R3: a file time counts its load and after hooks, not only its test bodies', { timeout: 60_000 }, () => {
  const { dir, write } = rig();
  try {
    write('slow.test.mjs', `import { after } from 'node:test';\nawait new Promise((r) => setTimeout(r, 1200));\nafter(() => new Promise((r) => setTimeout(r, 800)));\ntest('quick', () => {});`);
    const r = spawnSync(process.execPath, [RUNNER, '--write-times', 'slow.test.mjs'], { cwd: dir, env: env(), encoding: 'utf8', timeout: 50_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const ms = JSON.parse(fs.readFileSync(path.join(dir, 'test', 'file-times.json'), 'utf8'))['slow.test.mjs'];
    assert.ok(ms >= 2000, `recorded ${ms} ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
