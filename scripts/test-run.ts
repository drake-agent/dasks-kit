// Runs test files like `node --test`, but starts the slowest files first (README.md "Test order").
// `node --test <files>` sorts its files by name, so a slow file late in the alphabet started last and the whole run
// waited for it alone. node:test run() keeps the order it is given; this hands it the files longest-first by the times
// recorded in test/file-times.json. A file with no recorded time (new) goes first, since it may be slow.
// Usage: node scripts/test-run.ts [--test-timeout=MS] [--test-force-exit] [--import=MODULE]... [--min-concurrency=N] [--write-times] <file>...
//   --min-concurrency=N  run at least N files at once (default: cores minus one, as `node --test`). The files mostly
//                  wait on child processes, git and HTTP, so a 3-core CI runner idles at 2; this raises the floor only.
//   --write-times  rewrite test/file-times.json from this run (every file that finished; others keep their old time).
//   --times-from=<json file>  instead of running, merge a {file: ms} object (e.g. a CI log's `test-run: file-times`
//                  line) into test/file-times.json the same way, then exit.
// Output: TAP when stdout is not a terminal (as `node --test`), spec on a terminal. Exit 1 when any test fails.
import { run } from 'node:test';
import { spec, tap } from 'node:test/reporters';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIMES_FILE = 'test/file-times.json';

/** Files ordered for the run: unknown first (by name), then known by recorded ms, longest first (ties by name). */
export function orderFiles(files: string[], times: Record<string, number>): string[] {
  const known = (f: string) => Number.isFinite(times[f]) && times[f] >= 0;
  const unknown = files.filter((f) => !known(f)).sort();
  const rest = files.filter(known).sort((a, b) => times[b] - times[a] || (a < b ? -1 : a > b ? 1 : 0));
  return [...unknown, ...rest];
}

/** Files run at once: cores minus one (what `node --test` uses), never below the floor. */
export function concurrencyFor(cores: number, min: number): number {
  return Math.max(cores - 1, min, 1);
}

export function readTimes(file = TIMES_FILE): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch {}
  return {};
}

/** Writes test/file-times.json: fresh times win, old ones stay, files no longer on disk drop out; keys sorted. */
function writeMerged(old: Record<string, number>, fresh: Record<string, number>) {
  const next: Record<string, number> = {};
  for (const f of Object.keys({ ...old, ...fresh }).sort()) {
    const ms = f in fresh ? fresh[f] : old[f];
    if (!fs.existsSync(f) || !Number.isFinite(ms) || ms < 0) continue;
    next[f] = Math.round(ms);
  }
  fs.writeFileSync(TIMES_FILE, JSON.stringify(next, null, 1) + '\n');
  process.stderr.write(`test-run: wrote ${Object.keys(fresh).length} file times to ${TIMES_FILE}\n`);
}

async function main(argv: string[]) {
  let timeout: number | undefined;
  let forceExit = false;
  let writeTimes = false;
  let minConcurrency = 1;
  const imports: string[] = [];
  const files: string[] = [];
  for (const a of argv) {
    if (a.startsWith('--test-timeout=')) {
      timeout = Number(a.slice('--test-timeout='.length));
      if (!Number.isInteger(timeout) || timeout <= 0) throw new Error(`bad ${a}`);
    } else if (a === '--test-force-exit') forceExit = true;
    else if (a === '--write-times') writeTimes = true;
    else if (a.startsWith('--min-concurrency=')) {
      minConcurrency = Number(a.slice('--min-concurrency='.length));
      if (!Number.isInteger(minConcurrency) || minConcurrency < 1 || minConcurrency > 64) throw new Error(`bad ${a}`);
    }
    else if (a.startsWith('--times-from=')) {
      const fresh = JSON.parse(fs.readFileSync(a.slice('--times-from='.length), 'utf8'));
      if (!fresh || typeof fresh !== 'object' || Array.isArray(fresh)) throw new Error(`${a}: not a {file: ms} object`);
      writeMerged(readTimes(), fresh);
      return;
    }
    else if (a.startsWith('--import=')) imports.push(a);
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else files.push(path.relative(process.cwd(), path.resolve(a)));
  }
  if (files.length === 0) throw new Error('no test files');
  for (const f of files) if (!fs.statSync(f).isFile()) throw new Error(`not a file: ${f}`);

  const times = readTimes();
  const ordered = orderFiles([...new Set(files)], times);
  // Each file process gets the same flags `node --test` would hand it; test/file-limit-preload.ts reads --test-timeout.
  // scripts/test-time-preload.ts writes each file process's lifetime into timesDir on exit (whole-file times).
  const timesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-test-times-'));
  process.env.DASKS_TEST_TIMES_DIR = timesDir;
  const timePreload = `--import=${new URL('./test-time-preload.ts', import.meta.url).href}`;
  const execArgv = [timePreload, ...imports, ...(timeout ? [`--test-timeout=${timeout}`] : [])];
  const concurrency = concurrencyFor(os.availableParallelism(), minConcurrency);
  process.stderr.write(`test-run: ${ordered.length} files, ${concurrency} at once\n`);
  const stream = run({
    files: ordered.map((f) => path.resolve(f)),
    concurrency,
    timeout,
    forceExit,
    execArgv,
  });

  let failed = false;
  const fileMs: Record<string, number> = {};
  // A todo or skip mark counts by its presence: `todo: ''` is still a todo to node:test.
  const marked = (v: unknown) => v !== undefined && v !== false;
  stream.on('test:fail', (d: any) => {
    if (!marked(d.todo) && !marked(d.skip)) failed = true;
  });
  // Any summary counts, a file's too: a late uncaught error in a file fails that file's summary while the run's own
  // summary can still say success (review pass 1, P1); `node --test` exits 1 then.
  stream.on('test:summary', (d: any) => {
    if (d.success === false) failed = true;
  });
  // A file's time is how long its process lived (scripts/test-time-preload.ts); the sum of its top-level tests is the
  // floor, and the only number for a file whose process was killed before it could write.
  const summed: Record<string, number> = {};
  const record = (d: any) => {
    if (d.nesting !== 0 || !d.file) return;
    const f = path.relative(process.cwd(), d.file);
    summed[f] = (summed[f] ?? 0) + Math.round(Number(d.details?.duration_ms) || 0);
  };
  stream.on('test:pass', record);
  stream.on('test:fail', record);

  const reporter = process.stdout.isTTY ? new spec() : tap;
  await new Promise<void>((resolve, reject) => {
    const out = stream.compose(reporter as any);
    out.on('error', reject);
    out.on('end', resolve);
    out.pipe(process.stdout, { end: false });
  });
  const lived: Record<string, number> = {};
  const wanted = new Set(ordered);
  try {
    for (const name of fs.readdirSync(timesDir)) {
      try {
        const { file, ms } = JSON.parse(fs.readFileSync(path.join(timesDir, name), 'utf8'));
        const f = path.relative(process.cwd(), String(file));
        // A forked child inherits the preload; only the test file processes themselves count.
        if (wanted.has(f) && Number.isFinite(ms)) lived[f] = Math.max(lived[f] ?? 0, ms);
      } catch {}
    }
  } finally {
    fs.rmSync(timesDir, { recursive: true, force: true });
  }
  for (const f of new Set([...Object.keys(summed), ...Object.keys(lived)])) fileMs[f] = Math.max(lived[f] ?? 0, summed[f] ?? 0);

  if (writeTimes) writeMerged(times, fileMs);
  const slow = Object.entries(fileMs).sort((a, b) => b[1] - a[1]).slice(0, 5);
  process.stderr.write(`test-run: slowest files: ${slow.map(([f, ms]) => `${f} ${(ms / 1000).toFixed(1)}s`).join(', ')}\n`);
  // On GitHub Actions the run's own times go in the log as one line, so test/file-times.json can be refreshed from a
  // green CI run (README.md "Test order").
  if (process.env.GITHUB_ACTIONS === 'true') process.stderr.write(`test-run: file-times ${JSON.stringify(fileMs)}\n`);
  process.exitCode = failed ? 1 : 0;
}

// Run as a script, not when a test imports orderFiles. Compared as real paths: a URL escapes spaces and non-ASCII names.
const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`test-run: ${e.message}\n`);
    process.exitCode = 2;
  });
}
