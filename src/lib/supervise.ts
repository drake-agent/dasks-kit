// Process supervision for the runner's agents: each agent runs detached in its own process group with its output in a
// log file. It is stopped when the card's limits say so, and on every way out (normal exit, limit, runner stop) the
// whole group gets SIGTERM, then SIGKILL after a grace period, and the call returns only once the group is gone, so
// the caller can remove the worktree knowing nothing still writes in it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';

export interface Limits { timeout_min: number; idle_min: number; max_min: number }

/** Why a run of ageMin minutes, idleMin of them without new output or a change in its worktree, is stopped now ('' = it
 *  keeps running). Past the card timeout a run that is still writing is kept; a quiet one is stopped. */
export function overrun(ageMin: number, idleMin: number, c: Limits): string {
  if (ageMin < c.timeout_min) return '';
  if (ageMin >= c.max_min) return `hard limit ${c.max_min} min`;
  if (c.idle_min === 0) return `card timeout ${c.timeout_min} min`;
  return idleMin >= c.idle_min ? `no output for ${Math.floor(idleMin)} min` : '';
}

export interface ProcResult { code: number | null; stopped: string; raw: string }

export interface ProcSpec {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  /** When the card started (ms): ages count from here, so the limits hold for the whole card, not per phase. */
  cardStart: number;
  limits: Limits;
  tickMs?: number;
  /** Grace between SIGTERM and SIGKILL. */
  graceMs?: number;
  onStart?: (pid: number) => void;
  /** A fingerprint of the run's work besides the log (worktreeStamp of its worktree): when it changes, the run counts as
   *  writing, as when its log grows. Read every activityMs, never blocking the timer; null (or a throw) = unknown, which
   *  counts as activity: a run is never stopped as idle because its worktree could not be read. */
  activity?: () => string | null | Promise<string | null>;
  activityMs?: number;
  /** Called once when the run passes timeout_min and is kept because it is still writing (idle minutes so far). */
  onKept?: (idleMin: number) => void;
}

const run = (cmd: string, args: string[], timeout: number) => new Promise<string | null>((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 << 20 }, (err, out) => resolve(err ? null : out));
});

/** What a worktree holds right now, as one hash: HEAD, the full `git status` (every changed and untracked path), and the
 *  size and mtime of every one of those paths, so a second edit of an already-changed file counts too. A commit, a new
 *  file or an edit changes it; ignored files (build output, node_modules) do not. Async and bounded: git gets timeoutMs,
 *  and the stats must finish inside budgetMs. null = unknown (git failed or timed out, or the budget ran out). */
export async function worktreeStamp(dir: string, o: { timeoutMs?: number; budgetMs?: number } = {}): Promise<string | null> {
  const t0 = Date.now();
  const timeout = o.timeoutMs ?? 20_000, budget = o.budgetMs ?? 10_000;
  const [head, st] = await Promise.all([
    run('git', ['-C', dir, 'rev-parse', '-q', '--verify', 'HEAD'], timeout).then((x) => x ?? ''),   // '' in a repo with no commit yet
    // No index refresh: a status that writes index.lock would fail the agent's own commit running at the same moment.
    run('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], timeout),
  ]);
  if (st === null) return null;
  const h = createHash('sha1').update(head).update('\0').update(st);
  // Entries are "XY path"; a rename is followed by its old path as its own field.
  const paths = st.split('\0').map((f) => (f.length > 3 && f[2] === ' ' ? f.slice(3) : f)).filter(Boolean);
  for (let k = 0; k < paths.length; k += 256) {
    if (Date.now() - t0 > budget) return null;
    const batch = paths.slice(k, k + 256);
    const stats = await Promise.all(batch.map((p) => fs.promises.stat(path.join(dir, p)).then((s) => `${s.size}:${s.mtimeMs}`, () => '-')));
    batch.forEach((p, n) => h.update(`${p}:${stats[n]}\0`));
  }
  return h.digest('hex');
}

const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };
function signalGroup(pid: number, sig: NodeJS.Signals) {
  try { process.kill(-pid, sig); } catch { /* gone */ }
  try { process.kill(pid, sig); } catch { /* gone */ }
}

/** SIGTERM the group, wait up to graceMs for it to go, then SIGKILL and wait for that too. */
export async function endGroup(pid: number, graceMs = 3000): Promise<void> {
  if (!pid || !groupAlive(pid)) return;
  signalGroup(pid, 'SIGTERM');
  for (const end = Date.now() + graceMs; Date.now() < end && groupAlive(pid);) await new Promise((r) => setTimeout(r, 100));
  if (!groupAlive(pid)) return;
  signalGroup(pid, 'SIGKILL');
  for (const end = Date.now() + 5000; Date.now() < end && groupAlive(pid);) await new Promise((r) => setTimeout(r, 50));
}

/** A running agent; stop() ends it early with a reason (the runner stopping, a limit). */
export interface Supervised { pid: number; stop: (why: string) => void; done: Promise<ProcResult> }

export function supervise(s: ProcSpec): Supervised {
  const fd = fs.openSync(s.logFile, 'a');
  let stopped = '';
  let child;
  try {
    child = spawn(s.cmd, s.args, { cwd: s.cwd, detached: true, stdio: ['ignore', fd, fd], env: s.env });
  } catch (e: any) {
    fs.closeSync(fd);
    return { pid: 0, stop: () => {}, done: Promise.resolve({ code: 127, stopped: '', raw: `could not start ${s.cmd}: ${e.message}` }) };
  }
  const pid = child.pid ?? 0;
  if (pid) s.onStart?.(pid);
  let killer: NodeJS.Timeout | null = null;
  // A leader that ignores SIGTERM never exits, so the SIGKILL cannot wait for the exit event.
  const stop = (why: string) => {
    if (stopped) return;
    stopped = why;
    signalGroup(pid, 'SIGTERM');
    killer = setTimeout(() => signalGroup(pid, 'SIGKILL'), s.graceMs ?? 3000);
  };
  let changed = s.cardStart, stamp: string | null = null, stampAt = 0, reading = false, kept = false;
  // A stamp that differs from the last one, or one that could not be read, counts as activity at the time it was asked.
  const saw = (fp: string | null, at: number) => {
    if (!fp) { changed = Math.max(changed, at); return; }
    if (stamp !== null && fp !== stamp) changed = Math.max(changed, at);
    stamp = fp;
  };
  const timer = setInterval(() => {
    const now = Date.now();
    // A read still running after a whole interval has not answered: unknown, so it counts as activity.
    if (reading && now - stampAt >= (s.activityMs ?? 30_000)) changed = Math.max(changed, now);
    if (s.activity && !reading && now - stampAt >= (s.activityMs ?? 30_000)) {
      stampAt = now;
      reading = true;
      Promise.resolve().then(() => s.activity!()).then((fp) => saw(fp, now), () => saw(null, now)).finally(() => { reading = false; });
    }
    let mtime = Math.max(s.cardStart, changed);
    try { mtime = Math.max(mtime, fs.statSync(s.logFile).mtimeMs); } catch { /* no output yet */ }
    const age = (now - s.cardStart) / 60000, idle = (now - mtime) / 60000;
    const why = overrun(age, idle, s.limits);
    if (why) stop(why);
    else if (!kept && age >= s.limits.timeout_min) { kept = true; s.onKept?.(idle); }
  }, s.tickMs ?? 1000);
  const done = new Promise<ProcResult>((resolve) => {
    let finished = false;
    const finish = async (code: number | null, err?: string) => {
      if (finished) return; finished = true;
      clearInterval(timer);
      if (killer) clearTimeout(killer);
      await endGroup(pid, s.graceMs);
      fs.closeSync(fd);
      let raw = '';
      try { raw = fs.readFileSync(s.logFile, 'utf8'); } catch { /* none */ }
      resolve({ code, stopped, raw: raw + (err ? `\n${err}` : '') });
    };
    child.on('error', (e) => finish(127, `could not start ${s.cmd}: ${e.message}`));
    child.on('exit', (code) => finish(code));
  });
  return { pid, stop, done };
}
