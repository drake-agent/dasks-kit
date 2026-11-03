// Runs a test command in its own process group with a wall clock kept outside it. A test file that blocks its event
// loop cannot fire its own --test-timeout, so this process owns the clock, names the files still running, and reaps the whole group on every exit path: cap (124), TERM (143), INT (130), normal end.
// Usage: node scripts/test-wall.ts <command> [args...]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const t0 = Date.now();

// Wrapper lines are written synchronously so they all land before process.exit; fd 2 may be a non-blocking pipe.
function say(line: string) {
  const buf = Buffer.from(`test-wall: ${line}\n`);
  for (let off = 0; off < buf.length; ) {
    try {
      off += fs.writeSync(2, buf, off);
    } catch (e: any) {
      if (e.code !== 'EAGAIN') return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
function finish(code: number): never {
  say(`exit ${code} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(code);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const [command, ...args] = process.argv.slice(2);
if (!command) {
  fs.writeSync(2, 'usage: node scripts/test-wall.ts <command> [args...]\n');
  process.exit(2);
}
const capRaw = process.env.DASKS_TEST_WALL_MS ?? '1080000';
const capMs = Number(capRaw);
if (!/^[1-9][0-9]*$/.test(capRaw) || capMs > 86_400_000) {
  say('DASKS_TEST_WALL_MS must be a whole number of ms from 1 to 86400000');
  process.exit(2);
}

// Its stdin is 'ignore': the group is not the terminal's foreground group, so a read there would stop it with SIGTTIN.
const child = spawn(command === 'node' ? process.execPath : command, args, {
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit'],
});
if (child.pid === undefined) {
  const message = await new Promise<string>((resolve) => child.once('error', (e) => resolve(e.message)));
  say(`cannot start ${command}: ${message}`);
  finish(127);
}
const pgid = child.pid;
say(`pgid=${pgid} cap=${capMs}ms`);

let ownPgid = 'unknown';
try {
  ownPgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
} catch {}
if (!/^\d+$/.test(ownPgid) || Number(ownPgid) === pgid) {
  say(`unsafe process group (own=${ownPgid} child=${pgid})`);
  try { process.kill(pgid, 'SIGKILL'); } catch {}
  finish(70);
}

const testFiles = args.filter((a) => {
  if (a.startsWith('-')) return false;
  try { return fs.statSync(a).isFile(); } catch { return false; }
});

type Row = { pid: number; pgid: number; command: string };
let psFailed = false;
/** The group's rows in the process table, or null when `ps` fails. */
function groupRows(): Row[] | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-ww', '-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e: any) {
    if (!psFailed) say(`ps failed: ${e.message}`);
    psFailed = true;
    return null;
  }
  const rows: Row[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (m && Number(m[2]) === pgid) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] });
  }
  return rows;
}
function signalGroup(signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch (e: any) {
    if (e.code !== 'ESRCH') say(`kill failed: ${e.message}`);
  }
}
/** Polls every 100 ms until the group is empty or `ms` pass; returns the last count, or null when that read failed. */
async function pollEmpty(ms: number): Promise<number | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = groupRows();
    if (rows && rows.length === 0) return 0;
    if (Date.now() >= deadline) return rows ? rows.length : null;
    await sleep(100);
  }
}
function nameRunning() {
  const rows = groupRows();
  const workers = rows ? rows.filter((r) => r.pid !== pgid) : [];
  let named = 0;
  for (const f of testFiles) {
    const abs = path.resolve(f);
    if (workers.some((r) => r.command.includes(abs) || r.command.split(' ').includes(f))) {
      say(`still running ${f}`);
      named++;
    }
  }
  if (named === 0) say(`still running (no test file named): ${rows ? workers.length : 'unknown'} process(es) in pgid=${pgid}`);
}
function reportLeft(left: number | null) {
  if (left !== 0) say(`${left ?? 'unknown'} process(es) still in pgid=${pgid} after the stop sequence`);
}
/** TERM, up to 1.5 s, then KILL, up to 1 s: ends within 3 s, well inside a 5 s grace period. */
async function stopGroup() {
  signalGroup('SIGTERM');
  if ((await pollEmpty(1500)) === 0) return;
  signalGroup('SIGKILL');
  reportLeft(await pollEmpty(1000));
}

// The first of cap, signal or leader exit picks the path; later events are ignored.
let ending = false;
async function stopAndExit(reason: string, code: number) {
  if (ending) return;
  ending = true;
  clearTimeout(cap);
  say(reason);
  nameRunning();
  await stopGroup();
  finish(code);
}
const cap = setTimeout(() => {
  if (child.exitCode === null && child.signalCode === null) {
    void stopAndExit(`WALL CAP ${(capMs / 1000).toFixed(1)}s pgid=${pgid}`, 124);
  }
}, capMs);
process.on('SIGTERM', () => void stopAndExit(`SIGTERM: stopping pgid=${pgid}`, 143));
process.on('SIGINT', () => void stopAndExit(`SIGINT: stopping pgid=${pgid}`, 130));

child.on('exit', async (code, signal) => {
  if (ending) return;
  ending = true;
  clearTimeout(cap);
  const exitCode = code ?? 128 + (os.constants.signals[signal as NodeJS.Signals] ?? 0);
  const rows = groupRows();
  if (rows === null || rows.length > 0) {
    signalGroup('SIGKILL');
    const left = await pollEmpty(1000);
    say(`killed ${rows ? rows.length : 'unknown'} leftover process(es) pgid=${pgid}`);
    reportLeft(left);
  }
  finish(exitCode);
});
