// All writes go through here: validate → atomic file write → `git commit -m "<actor>: <change>"`.
// A repo-wide lock (.git/dasks.lock) serializes writers across processes (server, seed, digest).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { assertRetryAllowed } from './outcome.ts';
import { assertTransition } from './transitions.ts';
import { loadConfig, type IntakeConfig } from './config.ts';
import { addIdea, readIdeas, type Idea } from './ideas.ts';
import { depsOf } from './ready.ts';
import { formatPush, parsePush } from './push.ts';
import { loadBoard, loadGoals, parseFrontmatter, taskFromParsed } from './load.ts';
import { checkTask, isValidDate } from './check.ts';
import { ALL_STATUSES, goalIdsOf, isMilestoneId, MAX_TITLE_LEN, isTaskId, MAX_TASK_BYTES, MAX_SUMMARY_LINES, MAX_SUMMARY_LINE, MAX_SUMMARY_CHARS, MILESTONE_STATUSES, NORTHSTAR_ID, type Task, TASK_ALL_FIELDS, TASK_ID_RE, TASK_OPTIONAL_FIELDS, goalOf, ACTOR_RE, SPEC_TASK_FIELDS } from './schema.ts';
import { assertClaimAllowed, currentSpec, historyAfterClaim, newClaimHistory, type SpecFields } from './spec-state.ts';
import { checkLine, doneLine, LIVE_CHECK_LANE } from './done-line.ts';
import { lintNow, normNow } from './now-line.ts';
import { type Activity, type Context, activityContent, activityRelPath, applyContext, contextErrors, contextExempt, holderOf, parseContext, readActivity, TERMINAL } from './collab.ts';
import { holderSeenAt } from './lease.ts';
import { cleanProfileInput } from './profile.ts';

export class HttpError extends Error {
  status: number;
  data?: Record<string, unknown>;
  constructor(status: number, message: string, data?: Record<string, unknown>) { super(message); this.status = status; this.data = data; }
}

export function isoLocal(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(off / 60)}:${p(off % 60)}`;
}

/** Actor for commits and the activity log. A client that sends no (or a bad) X-Dasks-Actor is labelled "dasks", an
 *  unattributed caller. Known callers send a real actor. */
export function sanitizeActor(a: unknown, fallback = 'dasks'): string {
  const s = typeof a === 'string' ? a.trim() : '';
  return ACTOR_RE.test(s) ? s : fallback;
}

/** One-line, length-capped text for commit messages. */
function oneLine(s: string, max = 72): string {
  const t = s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---------- lock ----------
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Remove an abandoned lock dir, but only while holding a breaker mutex and only if isAbandoned() still says so, so a
 *  successor's fresh lock is never removed. */
export function breakIfOwner(target: string, isAbandoned: () => boolean): boolean {
  const breaker = `${target}.dasks-break`;
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(breaker); break; } catch (e: any) {
      if (e.code !== 'EEXIST') return false;
      try { if (Date.now() - fs.statSync(breaker).mtimeMs > 30_000) { fs.rmSync(breaker, { recursive: true, force: true }); continue; } } catch { continue; }
      if (i > 100) return false;
      sleep(20);
    }
  }
  try {
    if (!isAbandoned()) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } finally { try { fs.rmdirSync(breaker); } catch { /* gone */ } }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}

/** Run a transition/evidence check. gates "enforce": a refusal is thrown (409). gates "warn": the write goes through, the
 *  writer gets the reason as a warning, and the refusal is logged to run/gate-warnings.jsonl so a switch to enforce can be
 *  checked against real traffic first. Other errors always throw. */
export function gate(root: string, id: string, actor: string, warnings: string[] | undefined, check: () => void): void {
  try { check(); } catch (e) {
    if (!(e instanceof HttpError) || e.data?.rule !== 'transition' || loadConfig(root).gates === 'enforce') throw e;
    warnings?.push(`not enforced yet (gates: warn): ${e.message}`);
    try {
      const f = path.join(root, 'run', 'gate-warnings.jsonl');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), id, actor, from: e.data.from ?? null, to: e.data.to ?? null, reason: e.message }) + '\n');
    } catch { /* the log is best effort; the write itself must not fail on it */ }
  }
}
/** The repo lock is a directory with an `owner` file ("<pid> <boot minute> <start second>"). It is only broken if that
 *  owner is gone: the pid is dead, it is from an earlier boot (pids are reused after a reboot), its pid now belongs to a
 *  later process, or it is this very process without holding it. */
export function withRepoLock<T>(root: string, fn: () => T, timeoutMs = 15000): T {
  const lock = path.join(gitCommonDir(root), 'dasks.lock');
  const outer = !held.has(lock);
  return withDirLock(lock, () => {
    // First thing after taking the lock, before anything is read: put back an earlier write that could not be rolled
    // back (its journal is still here). If that fails (git busy), nothing is written now: 503, try again.
    if (outer && fs.existsSync(journalPath(root))) {
      try { const r = recoverJournal(root); if (r) console.error(`recovery: ${r}`); }
      catch (e: any) { throw new HttpError(503, `an earlier unfinished write could not be undone yet (${String(e.message).split('\n')[0]}); try again`, { retry_after: 2 }); }
    }
    if (outer) { const kept = corruptJournals(root); if (kept.length) throw new HttpError(503, corruptJournalHelp(root, kept), { rule: 'corrupt-journal' }); }
    return fn();
  }, timeoutMs);
}

/** A git index.lock older than maxAgeMs while we hold the repo lock was left by a killed git (a live commit holds it for
 *  far less): remove it. Returns true when one was removed. */
export function clearStaleIndexLock(root: string, maxAgeMs = 30_000): boolean {
  let idx = '';
  try { idx = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index.lock']).trim()); } catch { return false; }
  try { if (Date.now() - fs.statSync(idx).mtimeMs > maxAgeMs) { fs.rmSync(idx, { force: true }); console.error(`recovery: removed a stale ${idx}`); return true; } } catch { /* none */ }
  return false;
}

/** The repo's shared git dir: <root>/.git, or for a linked worktree (where .git is a file) the main repo's git dir. */
export function gitCommonDir(root: string): string {
  const dotgit = path.join(root, '.git');
  try {
    if (fs.statSync(dotgit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
      if (m) {
        const gd = path.resolve(root, m[1].trim());
        try { return path.resolve(gd, fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim()); } catch { return gd; }
      }
    }
  } catch { /* no .git yet: fall through */ }
  return dotgit;
}

/** This boot, to the minute (os.uptime drifts by well under a minute). */
const bootMinute = (): number => Math.round((Date.now() - os.uptime() * 1000) / 60000);
/** This process's start, to the second: with the pid it tells the owner from a later process that got the same pid. */
const ownStart = Math.round((Date.now() - process.uptime() * 1000) / 1000);
const ownerLine = (): string => `${process.pid} ${bootMinute()} ${ownStart}`;
/** Parse an owner file: pid, boot minute (0 = not written, pid only) and the owner's start in seconds (0 = not written). */
function parseOwner(s: string): { pid: number; boot: number; start: number } {
  const [p, b, st] = s.trim().split(/\s+/);
  return { pid: Number(p) || 0, boot: Number(b) || 0, start: Number(st) || 0 };
}
/** When a process started (epoch seconds, from `ps`), or 0 when unknown. */
function procStartSec(pid: number): number {
  try { const t = Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim()); return Number.isNaN(t) ? 0 : Math.round(t / 1000); } catch { return 0; }
}
/** A lock owner that cannot be holding it any more. */
function ownerGone(o: { pid: number; boot: number }, lock: string): boolean {
  if (o.pid <= 0) return false;
  if (o.boot && Math.abs(o.boot - bootMinute()) > 2) return true; // written before this boot
  if (o.pid === process.pid) return !held.has(lock);          // ours, but no call of ours holds it (left by a crash path)
  return !pidAlive(o.pid);
}

/** A live pid that is not the owner: the holder crashed and the OS gave its pid to a process that started later. Asked
 *  only of a lock older than 30 s (one `ps`); a lock without a recorded start is never judged this way. */
const reusedSeen = new Map<string, { at: number; reused: boolean }>(); // pid + start → answer, asked again after 10 s
const pidReused = (o: { pid: number; start: number }, age: number) => {
  if (o.pid <= 0 || o.pid === process.pid || !o.start || age < 30_000) return false;
  const k = `${o.pid} ${o.start}`; const c = reusedSeen.get(k);
  if (c && Date.now() - c.at < 10_000) return c.reused;
  const now = procStartSec(o.pid); const reused = now > 0 && Math.abs(now - o.start) > 5;
  reusedSeen.set(k, { at: Date.now(), reused });
  return reused;
};

/** Locks this process holds right now. Writes are synchronous, so a nested withDirLock on the same lock (e.g. promoting
 *  an idea creates a task) simply runs inside the outer one instead of waiting for itself. */
const held = new Map<string, number>();

export function withDirLock<T>(lock: string, fn: () => T, timeoutMs = 15000): T {
  const depth = held.get(lock) ?? 0;
  if (depth > 0) {
    held.set(lock, depth + 1);
    try { return fn(); } finally { held.set(lock, held.get(lock)! - 1); }
  }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const owner = path.join(lock, 'owner');
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); fs.writeFileSync(owner, ownerLine()); break; } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        let raw = ''; try { raw = fs.readFileSync(owner, 'utf8'); } catch { /* being created */ }
        const o = parseOwner(raw);
        // Reclaim only when the owner is verifiably gone, or the lock never got an owner (crash during creation).
        // Re-verified under a breaker mutex so a successor's fresh lock is never removed.
        const abandoned = () => {
          let now = ''; try { now = fs.readFileSync(owner, 'utf8'); } catch { /* none */ }
          let a = 0; try { a = Date.now() - fs.statSync(lock).mtimeMs; } catch { return false; }
          const c = parseOwner(now);
          return now.trim() === raw.trim() && (ownerGone(c, lock) || (c.pid === 0 && a > 5000) || pidReused(c, a));
        };
        if ((ownerGone(o, lock) || (o.pid === 0 && age > 5000) || pidReused(o, age)) && breakIfOwner(lock, abandoned)) continue;
      } catch { continue; }
      if (Date.now() - start > timeoutMs) throw new HttpError(503, 'repo is busy (lock held), try again', { retry_after: 1 });
      sleep(50);
    }
  }
  held.set(lock, 1);
  try { return fn(); } finally {
    held.delete(lock);
    try { if (parseOwner(fs.readFileSync(owner, 'utf8')).pid === process.pid) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

// ---------- recovery ----------
/** The git blob id of these bytes (what `git hash-object` prints), without running git. */
const blobId = (content: string | Buffer): string => { const b = Buffer.isBuffer(content) ? content : Buffer.from(content); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };
/** A timed-out lookup is not "no HEAD": it throws, so no caller undoes a write it cannot see. */
const hasHead = (root: string) => { try { git(root, ['rev-parse', '-q', '--verify', 'HEAD']); return true; } catch (e: any) { if (e?.code === 'ETIMEDOUT') throw e; return false; } };
const realRoot = (root: string) => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } };

/** Put the files of this checkout's unfinished write back to HEAD (copy of what was found kept in the git dir).
 *  Caller holds the repo lock. Returns a log line, or '' when there was nothing to do. */
export function recoverJournal(root: string): string {
  const journal = journalPath(root);
  let txn: { rels?: string[]; message?: string; root?: string; head?: string; written?: Record<string, string> } | null = null;
  let text: string;
  try { text = fs.readFileSync(journal, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return ''; throw e; }
  try {
    txn = JSON.parse(text);
    if (!txn || typeof txn !== 'object' || Array.isArray(txn) || !Array.isArray(txn.rels)) throw new Error('not a write journal');
  } catch (e: any) {
    // It names files a write left half done; without it nobody knows which. Kept, never deleted: writes stop until a
    // human has looked (corruptJournals, `dasks check`).
    const aside = `${journal}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(journal, aside);
    return `the write journal is unreadable (${String(e.message).split('\n')[0].slice(0, 120)}): kept as ${aside}; writes are stopped until it is resolved (dasks check)`;
  }
  if (txn?.root && txn.root !== realRoot(root)) return `journal belongs to ${txn.root}, not this checkout: left alone`;
  const rels = (txn?.rels ?? []).filter((r) => typeof r === 'string' && /^data\//.test(r) && !r.includes('..'));
  clearStaleIndexLock(root);
  // The commit may have landed after all (the process died, or the journal could not be removed, after `git commit`):
  // a commit after the journal's parent (head; '' = the repo had none) holds exactly the bytes this write wrote, even if a
  // later commit changed them again. Then there is nothing to undo; putting the before-images back would revert it.
  if (typeof txn?.head === 'string' && txn.written && rels.length && hasHead(root)) {
    const landed = writeLanded(root, txn.head, rels, txn.written);
    if (landed === null) throw new Error('git could not tell whether that write was committed; the journal stays');
    if (landed) {
      fs.rmSync(journal, { force: true });
      return `a finished write left its journal ("${String(txn.message ?? '').slice(0, 80)}"): already committed, nothing undone`;
    }
  }
  const keep = path.join(path.dirname(journal), 'dasks-recovered', new Date().toISOString().replace(/[:.]/g, '-'));
  const before: Record<string, string | null> | undefined = (txn as any)?.before;
  for (const rel of rels) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) { fs.mkdirSync(path.dirname(path.join(keep, rel)), { recursive: true }); fs.copyFileSync(abs, path.join(keep, rel)); }
    // Index back to HEAD (git errors propagate: the journal then stays and the next lock taker tries again).
    if (hasHead(root)) git(root, ['reset', '-q', '--', rel]);
    if (before && Object.hasOwn(before, rel)) {
      // Exactly what was there before the write (including someone's unstaged edit), or nothing.
      if (before[rel] === null) fs.rmSync(abs, { force: true }); else atomicWrite(abs, Buffer.from(before[rel]!, 'base64'));
    } else {
      // No before-image for this path (only a damaged journal lacks one): HEAD is the safe state.
      let inHead = true;
      try { git(root, ['cat-file', '-e', `HEAD:${rel}`]); } catch { inHead = false; }
      if (inHead) git(root, ['checkout', '-q', 'HEAD', '--', rel]); else fs.rmSync(abs, { force: true });
    }
  }
  fs.rmSync(journal, { force: true });
  return rels.length ? `undid an unfinished write ("${String(txn?.message ?? '').slice(0, 80)}"): ${rels.join(', ')}; the files as found are in ${keep}` : '';
}

/** Did a commit after `head` ('' = the repo had none) land exactly these blobs (rel -> git blob id)? A later commit may
 *  have changed the files again; one commit holding all of them is enough. null = git could not tell. */
function writeLanded(root: string, head: string, rels: string[], written: Record<string, string>): boolean | null {
  try {
    if (!hasHead(root)) return false;
    let commits: string[];
    try { commits = git(root, ['log', '--format=%H', head ? `${head}..HEAD` : 'HEAD', '--', ...rels]).split('\n').filter(Boolean); }
    catch (e: any) { if (e?.code === 'ETIMEDOUT') return null; return false; } // a parent that is gone: nothing of ours landed
    return commits.some((c) => rels.every((rel) => {
      let blob = ''; try { blob = git(root, ['rev-parse', '-q', '--verify', `${c}:${rel}`]).trim(); } catch (e: any) { if (e?.code === 'ETIMEDOUT') throw e; }
      return written[rel] === blob;
    }));
  } catch { return null; }
}

/** Unreadable write journals kept aside by recoverJournal (absolute paths). While one is there, no write runs. */
export function corruptJournals(root: string): string[] {
  const j = journalPath(root), dir = path.dirname(j), base = path.basename(j) + '.corrupt-';
  try { return fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort().map((f) => path.join(dir, f)); } catch { return []; }
}
/** What a human does about a kept journal (shared by the write refusal, /api/health and `dasks check`). */
export function corruptJournalHelp(root: string, kept: string[]): string {
  return `a write journal could not be read and is kept at ${kept.join(', ')}; writes are stopped until a human resolves it: `
    + `look at \`git -C ${root} status -- data\` and restore or commit any half-written file, then delete the kept journal`;
}

/** Startup tidy-up after a crash mid-write (server start, before serving), under the repo lock:
 *  - the files of this checkout's unfinished write (journal) go back to HEAD; what was on disk is kept next to the journal
 *    in dasks-recovered/<time>/ (half a multi-file write must not be committed later by someone else);
 *  - a git index.lock older than 30 seconds is removed; our stray temp files are deleted.
 *  Paths staged by anyone else are left alone. Returns what it did, for the log. */
export function recoverRepo(root: string): string[] {
  const done: string[] = [];
  try {
    // The plain lock (not withRepoLock): recovery is done here, step by step, so the log can say what happened.
    withDirLock(path.join(gitCommonDir(root), 'dasks.lock'), () => {
      if (clearStaleIndexLock(root)) done.push('removed a stale index.lock');
      const r = recoverJournal(root);
      if (r) done.push(r);
      const dirty = git(root, ['status', '--porcelain', '--', 'data']).split('\n').filter(Boolean);
      if (dirty.length) done.push(`uncommitted data not written by the server (left alone): ${dirty.slice(0, 10).join(' | ')}`);
      const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/^\..+\.\d+\.[0-9a-f]{12}\.tmp$/.test(e.name) && Date.now() - fs.statSync(f).mtimeMs > 60_000) { fs.rmSync(f, { force: true }); done.push(`removed temp file ${path.relative(root, f)}`); }
      } };
      try { walk(path.join(root, 'data')); } catch { /* no data dir */ }
    }, 30_000);
  } catch (e: any) { done.push(`skipped (${e.message})`); }
  return done;
}

// ---------- git ----------
/** Every git the board runs is bounded. Writes stay synchronous (the repo lock, the journal and "nothing else runs between
 *  the check and the append" all rest on that), so a hung git would stop the whole server: it is killed after this long
 *  instead (SIGKILL: a git stuck in I/O may ignore SIGTERM, and execFileSync waits for the exit). To the write that ran
 *  it, that is one more git failure: rolled back, or its journal left for recovery, and a 503. DASKS_GIT_TIMEOUT_MS. */
export const GIT_TIMEOUT_MS = Number(process.env.DASKS_GIT_TIMEOUT_MS) || 15_000;
export const GIT_BOUND = { timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' } as const;
/** A git killed by GIT_BOUND says so (its own stderr is empty): the 503 then names the cause. */
export function gitTimeoutNamed(e: any, args: readonly string[]): never {
  if (e?.code === 'ETIMEDOUT') { e.message = `git ${args.find((a) => !a.startsWith('-') && a !== '-C') ?? ''} did not finish in ${GIT_TIMEOUT_MS / 1000} s and was stopped`; e.stderr = e.message; }
  throw e;
}

export function git(root: string, args: string[], input?: string): string {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...GIT_BOUND }); }
  catch (e) { return gitTimeoutNamed(e, args); }
}

/** The paths of this process's latest commit (the server uses it to tell its own file events from anyone else's). */
export let lastCommitted: { files: Map<string, string>; at: number } = { files: new Map(), at: 0 };
/** Every path this process committed since the server's last reload (it re-reads just these after a write). */
export const committedSinceReload = new Set<string>();
/** Is this file (repo-relative) exactly what this process last committed? Then a watcher event for it is our own echo. */
export function isOwnEcho(root: string, rel: string): boolean {
  const h = lastCommitted.files.get(rel);
  if (!h) return false;
  try { return createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex') === h; } catch { return false; }
}

/** The files of the write in progress, so a restart after a crash mid-write knows exactly which paths were ours. */
/** Per worktree (git's own dir for this checkout, not the shared one): recovery must only ever touch this checkout. */
export const journalPath = (root: string) => {
  const dotgit = path.join(root, '.git');
  try { if (fs.statSync(dotgit).isDirectory()) return path.join(dotgit, 'dasks-txn.json'); } catch { /* worktree or no repo */ }
  try { return path.resolve(root, git(root, ['rev-parse', '--git-path', 'dasks-txn.json']).trim()); } catch { return path.join(dotgit, 'dasks-txn.json'); }
};

/** Test-only fault injection (test/crash-recovery.test.ts): DASKS_TEST_CRASH_AT=<point> SIGKILLs the process there; inert otherwise. */
function crashPoint(point: 'before-commit' | 'after-commit'): void {
  if (process.env.DASKS_TEST_CRASH_AT === point) process.kill(process.pid, 'SIGKILL');
}

/** `expect`: repo-relative path -> the bytes the caller read and based its change on. If the file differs now (e.g. a
 *  hand commit landed meanwhile), nothing is written: 409. */
/** Atomically write files and commit exactly those paths. Rolls back on any failure before the commit lands. */
export function commitFiles(root: string, files: { rel: string; content: string }[], message: string, expect: Record<string, Buffer | string> = {}): string {
  const backups = files.map((f) => {
    const abs = safeAbs(root, f.rel);
    return { ...f, abs, old: fs.existsSync(abs) ? fs.readFileSync(abs) : null };
  });
  const rels = backups.map((f) => f.rel);
  for (const f of backups) if (Object.hasOwn(expect, f.rel) && !(f.old && f.old.equals(Buffer.from(expect[f.rel]))))
    throw new HttpError(409, `${f.rel} changed on disk while this write was prepared; re-read it and retry`);
  // Refuse rather than clobber someone else's staged-but-uncommitted edits to the same paths.
  try { git(root, ['diff', '--cached', '--quiet', '--', ...rels]); }
  catch (e: any) { if (e.status === 1) throw new HttpError(409, `staged changes pending on ${rels.join(', ')}; commit or unstage them first`); }
  let committed = false;
  const journal = journalPath(root);
  // (A journal left by an earlier failed rollback was already undone when the repo lock was taken, before any read.)
  if (fs.existsSync(journal)) throw new HttpError(503, 'an earlier unfinished write is still being undone; try again', { retry_after: 2 });
  const kept = corruptJournals(root);
  if (kept.length) throw new HttpError(503, corruptJournalHelp(root, kept), { rule: 'corrupt-journal' });
  let consistent = false; // committed, or fully rolled back
  let head = '';
  let written: Record<string, string> = {};
  try {
    // The journal keeps each file's bytes from before this write (null = did not exist): recovery restores exactly
    // those, so an unrelated unstaged edit that was there is not lost either.
    const before = Object.fromEntries(backups.map((f) => [f.rel, f.old === null ? null : f.old.toString('base64')]));
    // head + written (git blob ids): recovery can tell a commit that landed from one that did not
    try { head = git(root, ['rev-parse', '-q', '--verify', 'HEAD']).trim(); } catch { /* first commit */ }
    written = Object.fromEntries(backups.map((f) => [f.rel, blobId(f.content)]));
    atomicWrite(journal, JSON.stringify({ pid: process.pid, root: realRoot(root), at: new Date().toISOString(), message, rels, before, head, written }) + '\n');
    for (const f of backups) atomicWrite(f.abs, f.content);
    try { git(root, ['add', '--', ...rels]); }
    catch (e: any) { if (/index\.lock/.test(String(e.stderr)) && clearStaleIndexLock(root)) git(root, ['add', '--', ...rels]); else throw e; }
    // Every server write is validated in-process first (task schema + references, views, ideas, nodes), so the commit
    // skips the whole-board pre-commit hook: one bad file elsewhere must not block every writer. The hook still guards
    // commits made by hand.
    crashPoint('before-commit');
    try { git(root, ['commit', '-q', '--no-verify', '-m', message, '--', ...rels]); }
    catch (e) {
      // git can fail after the commit landed: a post-commit hook (it runs despite --no-verify) that is slow and gets the
      // git killed by the timeout, or fails. Then the write is done; putting the old files back would leave HEAD and the
      // files apart. Undecidable: the journal stays and writes stop until recovery can tell.
      const landed = writeLanded(root, head, rels, written);
      if (landed === null) { consistent = false; throw Object.assign(new HttpError(503, 'commit state unknown: the journal is kept and the next write recovers it first', { retry_after: 2 }), { undecided: true }); }
      if (!landed) throw e;
      console.error(`commit of "${message}" landed although git failed after it (${String((e as any).message).split('\n')[0]})`);
    }
    crashPoint('after-commit');
    committed = true; consistent = true;
    lastCommitted = { files: new Map(backups.map((f) => [f.rel.split(path.sep).join('/'), createHash('sha1').update(f.content).digest('hex')])), at: Date.now() };
    for (const rel of lastCommitted.files.keys()) committedSinceReload.add(rel);
  } catch (e: any) {
    if (!committed && !e.undecided) {
      try {
        for (const f of backups) {
          if (f.old === null) { try { fs.unlinkSync(f.abs); } catch (u: any) { if (u.code !== 'ENOENT') throw u; } } else atomicWrite(f.abs, f.old);
        }
        if (hasHead(root)) git(root, ['reset', '-q', '--', ...rels]); // index back to HEAD (it was clean for these paths)
        consistent = true; // files and index put back; otherwise the journal stays for recovery
      } catch (r: any) { console.error(`rollback of "${message}" incomplete (${String(r.message).split('\n')[0]}); the journal stays for recovery`); }
    }
    if (e instanceof HttpError) throw e;
    // Not a conflict with another writer but git itself failing (index.lock, disk, …): 503, so clients do not
    // "re-read and retry" a version conflict that is not there.
    const detail = String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-8).join('\n');
    throw new HttpError(503, `commit failed: ${detail}`, { retry_after: 2 });
  } finally {
    // Committed or fully rolled back: consistent again. Otherwise the journal stays, and the next write (or a restart)
    // puts those files back to HEAD before anything else happens.
    if (consistent) try { fs.rmSync(journal, { force: true }); } catch { /* gone */ }
  }
  try { return git(root, ['rev-parse', 'HEAD']).trim(); } catch { return ''; }
}

/** Resolve a repo-relative path and make sure it (and every existing ancestor, symlinks resolved) stays inside data/. */
function safeAbs(root: string, rel: string): string {
  const dataReal = fs.realpathSync(path.resolve(root, 'data'));
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root, 'data') + path.sep)) throw new HttpError(400, 'path outside data/');
  try { if (fs.lstatSync(abs).isSymbolicLink()) throw new HttpError(400, 'refusing to write through a symlink'); } catch (e) { if (e instanceof HttpError) throw e; }
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const real = fs.realpathSync(dir);
  if (real !== dataReal && !real.startsWith(dataReal + path.sep)) throw new HttpError(400, 'path escapes data/ via a symlink');
  return abs;
}

/** Write via a temp file and rename, durable across a power loss, not only a process crash: the temp file's bytes are
 *  fsynced before the rename (else the new name can point at an empty file), and the directory after it (else the rename
 *  itself can be lost). */
export function atomicWrite(abs: string, content: string | Buffer): void {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd = -1;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = -1;
    fs.renameSync(tmp, abs);
    fsyncDir(dir);
  } catch (e) {
    if (fd >= 0) try { fs.closeSync(fd); } catch { /* closed */ }
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    throw e;
  }
}

export function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// ---------- tasks ----------
export function taskRelPath(id: string): string {
  const m = TASK_ID_RE.exec(id);
  if (!m || !isTaskId(id)) throw new HttpError(400, `bad task id "${id}"`);
  return path.join('data', 'tasks', m[1], `${m[2]}.md`);
}

export function serializeTask(t: Partial<Task>): string {
  const fm: Record<string, unknown> = {};
  for (const k of TASK_ALL_FIELDS) {
    const v = (t as any)[k];
    // blocked_spec_version 0 is a real baseline (a block set before any spec); empty = no block.
    if (k === 'blocked_spec_version' ? v === undefined || v === null || v === '' : (TASK_OPTIONAL_FIELDS as readonly string[]).includes(k) && !v) continue;
    fm[k] = k === 'version' ? Number(v) : v ?? '';
  }
  const y = YAML.stringify(fm, { lineWidth: 0, blockQuote: 'literal' });
  let body = t.body ?? '';
  if (body && !body.startsWith('\n')) body = '\n' + body;
  if (body && !body.endsWith('\n')) body += '\n';
  return `---\n${y}---\n${body}`;
}

const EDITABLE = ['title', 'title_ko', 'title_en', 'milestone', 'owner', 'lane', 'kind', 'status', 'priority', 'pr', 'pr_summary', 'result', 'needs_user', 'approvals', 'started_at', 'depends_on', 'next_owner', 'secrets', 'summary', 'now'] as const;

export interface TaskPatch { [k: string]: unknown }

export interface UpdateOpts {
  reopen?: boolean;
  outcome?: string;
  extraFiles?: { rel: string; content: string }[] | ((next: Task) => { rel: string; content: string }[]);
  resetAttempts?: { reason: string };
  ifStatus?: string | string[]; body?: string; appendNote?: string; appendBlock?: { heading: string; lines: string[] }; now?: Date;
  /** Optimistic lock: refuse with 409 unless the task is still at this version. Omitted = unconditional. */
  expectedVersion?: number;
  /** Context fields what/why/do/rec/after, written into the body's ## Context block. */
  context?: Context;
  /** claim: take the lock (409 if someone else holds it, unless force). release: drop it. */
  claim?: { op: 'claim' | 'release'; who: string; force?: boolean; /** release: only while the card is still on this run. */ runId?: string };
  /** Activity action name (default derived: create/status/note/edit). */
  action?: string;
  /** Extra actors exempt from the context rule (config). */
  exempt?: string[];
  /** Filled with human-readable warnings (e.g. "claimed by X"). */
  warnings?: string[];
  /** Claim lease: a claim with no sign of life from its holder for this many hours can be taken without force
   *  (default 6, config stale_hours). */
  staleHours?: number;
  /** finish: refuse (409) when someone else holds a live claim, unless force. */
  holderOnly?: { force?: boolean };
  /** A housekeeping rename (title fields, optionally with a note saying why): not progress, so it keeps `updated` like a
   *  translation does. Refused (400) with any other field, a status change or a claim. */
  housekeeping?: boolean;
  /** Called under the repo lock when the write changes the status (cur = the task on disk, next = the task as this write
   *  would leave it: fields, body and context applied); throw to refuse. */
  statusGate?: (cur: Task, next: Task) => void;
  /** Server-only spec fields (lib/spec-state.ts: review, block, unblock, a spec write): set as given (undefined = remove). */
  specFields?: SpecFields;
  /** Called under the repo lock, after the field checks and once the task file is read from disk, when this write takes
   *  the card (a claim, or status → doing): the server's spec-index guard (503 while it can't be rebuilt). */
  specGate?: () => void;
  /** The user's push (lib/push.ts): record it for the card's lane as this write leaves it. Only the user; the card must
   *  stay todo, unclaimed, on a lane. */
  push?: boolean;
}

/** Milestone -> goal and the known goal ids, read from disk (callers hold the repo lock). */
function boardIndex(root: string): { milestones: Map<string, string>; goals: Set<string> } {
  const b = loadGoals(root);
  const milestones = new Map<string, string>();
  for (const g of b.goals) for (const m of g.milestones) milestones.set(m.id, g.id);
  return { milestones, goals: new Set(goalIdsOf(b)) };
}

/** Is `id` a goal right now (data/goals/<id>.yaml under the north star)? */
export function isGoal(root: string, id: string): boolean {
  return goalIdsOf(loadGoals(root)).includes(id);
}

/** Display titles must be one short line. Empty string = remove. */
export function cleanTitle(v: string, k: string): string {
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_TITLE_LEN) throw new HttpError(400, `${k} is over ${MAX_TITLE_LEN} characters`);
  return s;
}
/** Title rule: one short plain line per language (title_ko, title_en). Job slugs (#site-v2), PR numbers (#17, PR 10),
 *  timestamps (18:03, 10/11, 2026-10-11) and approval stamps ("user OK …") belong in the card's notes, not its title.
 *  A soft check: it only returns warnings (shown to the writer), it never rejects a write. */
export const TITLE_SOFT_MAX = 60;
const TITLE_SMELLS: [RegExp, string][] = [
  [/(^|[\s(])#[A-Za-z][\w-]*/, 'a #slug'],
  // "PR 4개", "PR 4건의" (a count, with or without a particle) is not a PR number; "PR 14 개선" is
  [/(^|[\s(])#\d+|\bPR\s*#?\d+(?!\d|\s*(개|건|장|가지)(으로|[을를이가의은는와과도만로])?(?![가-힣]))/i, 'a PR number'],
  // a slug up front ("fix-login: …", "add-form fixes"); a number first ("3-step signup") is a word
  [/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+:?\s/, 'a job slug'],
  [/\b\d{1,2}:\d{2}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\b/, 'a time or date'],
  // no \b around Hangul: JavaScript word boundaries only know ASCII letters
  [/(?<![A-Za-z])user\s*OK|사용자\s*(OK|승인)|\(\s*(user(?![\w-])|사용자(?![가-힣]))/i, 'an approval stamp'],
  [/[\r\n]/, 'more than one line'],
];
/** Soft warnings about a card's titles (title, title_ko, title_en): slugs, PR numbers, times, approval stamps, length. */
export function titleWarnings(fields: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['title', 'title_ko', 'title_en']) {
    const v = fields[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    const smells = TITLE_SMELLS.filter(([re]) => re.test(v)).map(([, what]) => what);
    if (v.trim().length > TITLE_SOFT_MAX) smells.push(`over ${TITLE_SOFT_MAX} characters`);
    if (smells.length) out.push(`${k} has ${smells.join(', ')}: keep titles one short plain line and put ids, PR numbers, times and approvals in a note`);
  }
  return out;
}

/** Upper bounds per free-text field: every /api/board response carries them. */
const FIELD_CAPS: Record<string, number> = { title: MAX_TITLE_LEN, owner: 80, result: 4000, needs_user: 1500, pr_summary: 1500, pr: 500, depends_on: 1700, secrets: 800 };
function capField(k: string, v: string): void {
  if (Object.hasOwn(FIELD_CAPS, k) && v.length > FIELD_CAPS[k]) throw new HttpError(400, `${k} is over ${FIELD_CAPS[k]} characters`);
}

/** Fields that only change how a title reads in one language: such an edit keeps `updated` (it is not progress). */
export const I18N_ONLY = ['title_ko', 'title_en'];

function readTask(root: string, id: string): Task {
  return readTaskRaw(root, id).task;
}
/** The task and the exact bytes it was parsed from (the hand-commit guard compares against these). */
function readTaskRaw(root: string, id: string): { task: Task; raw: Buffer } {
  const rel = taskRelPath(id);
  const abs = path.join(root, rel);
  let buf: Buffer;
  try { buf = fs.readFileSync(abs); } catch { throw new HttpError(404, `no task "${id}"`); }
  try { return { task: taskFromParsed(parseFrontmatter(buf.toString('utf8')), rel, buf.length), raw: buf }; }
  catch (e: any) { throw new HttpError(409, `task file is unparseable: ${e.message}`); }
}

function validateOrThrow(t: Task, root: string, prevSize = 0, bodyReplace = true): void {
  const errs = checkTask(t, boardIndex(root));
  if (errs.length) throw new HttpError(400, errs.join('; '));
  const size = Buffer.byteLength(serializeTask(t));
  // Refuse growth past the limit, but never block a write that does not make an oversized file bigger. Field writes
  // (status, claim, result, …; notes are compacted first) get 50% slack: every field is capped, so files stay bounded.
  const limit = bodyReplace ? WRITE_LIMIT : WRITE_LIMIT * 1.5;
  if (size > limit && size > prevSize) throw new HttpError(413, `task would be ${size} B; keep files small (<${MAX_TASK_BYTES} B)`);
}

/** Notes that no longer fit in a task file move here (oldest first), in the same commit: data/notes/<app>/<t-…>.md. */
export function notesArchiveRelPath(id: string): string {
  const m = TASK_ID_RE.exec(id);
  if (!m) throw new HttpError(400, `bad task id "${id}"`);
  return path.join('data', 'notes', m[1], `${m[2]}.md`);
}

/** If the task would pass the write limit, move its oldest "## Notes" lines to the archive file (keeping the newest 3).
 *  Returns the archive file to commit with the task, or null when nothing had to move. */
function compactNotes(root: string, t: Task): { rel: string; content: string } | null {
  const size = () => Buffer.byteLength(serializeTask(t));
  if (size() <= WRITE_LIMIT) return null;
  const m = /(^|\n)## Notes[ \t]*\n([\s\S]*?)(?=\n## |$)/.exec(t.body);
  if (!m) return null;
  const rel = notesArchiveRelPath(t.id);
  const marker = /^- \((\d+) older notes: /;
  const lines = m[2].split('\n');
  const earlier = Number(lines.map((l) => marker.exec(l)?.[1]).find(Boolean) ?? 0);
  const notes = lines.map((l, i) => (/^- /.test(l) && !marker.test(l) ? i : -1)).filter((i) => i >= 0);
  const head = t.body.slice(0, m.index + m[1].length);
  const tail = t.body.slice(m.index + m[0].length);
  const orig = t.body;
  const build = (k: number) => {
    const gone = new Set(notes.slice(0, k));
    const rest = lines.filter((l, i) => !gone.has(i) && !marker.test(l));
    return `${head}## Notes\n- (${earlier + k} older notes: ${rel})\n${rest.join('\n')}${tail}`;
  };
  const max = Math.max(0, notes.length - 3); // the newest 3 notes always stay
  let k = 0;
  while (k < max) { k++; t.body = build(k); if (size() <= WRITE_LIMIT) break; }
  if (!k) { t.body = orig; return null; }
  let prev = '';
  try { prev = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { prev = `# ${t.id}: older notes\n`; }
  return { rel, content: prev.replace(/\s*$/, '\n') + notes.slice(0, k).map((i) => lines[i]).join('\n') + '\n' };
}

function strPatch(patch: TaskPatch): Record<string, string> {
  const out: Record<string, string> = {};
  for (let [k, v] of Object.entries(patch)) {
    if (!(EDITABLE as readonly string[]).includes(k)) throw new HttpError(400, `field "${k}" is not editable`);
    if (k === 'depends_on') v = normDeps(v);
    if (k === 'secrets') v = normDeps(v);
    if (v !== null && typeof v !== 'string') throw new HttpError(400, `field "${k}" must be a string`);
    out[k] = (v ?? '') as string;
    if (k === 'title_ko' || k === 'title_en') out[k] = cleanTitle(out[k], k);
    if (k === 'summary') out[k] = normSummary(out[k]);
    if (k === 'now') out[k] = normNow(out[k]);
    capField(k, out[k]);
  }
  return out;
}

/** The handoff summary: lines trimmed, blank lines dropped, at most 5 lines of ≤200 characters (≤1000 in all).
 *  Too long is refused, never cut: the writer decides what the next agent reads. '' clears it. */
export function normSummary(v: string): string {
  const lines = v.split(/\r\n?|\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (lines.length > MAX_SUMMARY_LINES) throw new HttpError(400, `summary is ${lines.length} lines; keep it to ${MAX_SUMMARY_LINES}`, { rule: 'summary' });
  const long = lines.findIndex((l) => l.length > MAX_SUMMARY_LINE);
  if (long >= 0) throw new HttpError(400, `summary line ${long + 1} is over ${MAX_SUMMARY_LINE} characters`, { rule: 'summary' });
  const out = lines.join('\n');
  if (out.length > MAX_SUMMARY_CHARS) throw new HttpError(400, `summary is over ${MAX_SUMMARY_CHARS} characters`, { rule: 'summary' });
  return out;
}

/** depends_on and secrets arrive as "a, b" or ["a","b"]; stored as "a, b" (deduped). */
export function normDeps(v: unknown): string {
  const arr = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[\s,]+/) : v == null ? [] : [String(v)];
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))].join(', ');
}

const TITLE_FIELDS = ['title', ...I18N_ONLY];

export function updateTask(root: string, id: string, patch: TaskPatch, actor: string, opts: UpdateOpts = {}): Task {
  // Soft-check the titles as sent (strPatch folds line breaks in title_ko / title_en away).
  const titleWarns = titleWarnings(patch);
  const fields = strPatch(patch);
  if (opts.housekeeping && (!Object.keys(fields).length || Object.keys(fields).some((k) => !TITLE_FIELDS.includes(k)) || opts.claim || opts.body !== undefined || opts.context || opts.appendBlock))
    throw new HttpError(400, 'housekeeping takes only title, title_ko, title_en (and a note)');
  opts.warnings?.push(...titleWarns);
  return withRepoLock(root, () => {
    const { task: cur, raw: curRaw } = readTaskRaw(root, id);
    if (opts.specGate && (opts.claim?.op === 'claim' || fields.status === 'doing' && cur.status !== 'doing')) opts.specGate();
    if (fields.lane === 'failed-terminal' && cur.lane !== 'failed-terminal' && opts.outcome !== 'failed')
      throw new HttpError(409, 'only the retry cap moves a card to the failed-terminal lane', { rule: 'retry-cap' });
    // A capped card can still be closed: anyone may cancel it, and the user may mark it done. It leaves the terminal lane.
    // In gates: warn any actor may also mark it done, logged like other gate warnings.
    const warnDone = cur.lane === 'failed-terminal' && fields.status === 'done' && actor !== 'user' && loadConfig(root).gates !== 'enforce';
    const closesCapped = cur.lane === 'failed-terminal' && !opts.claim && (fields.status === 'cancelled' || fields.status === 'done' && (actor === 'user' || warnDone));
    if (closesCapped) fields.lane = 'none';
    if (closesCapped && warnDone) gate(root, id, actor, opts.warnings, () => { throw new HttpError(409, `transition ${cur.status} -> done: retry cap reached (failed-terminal); only the user may close it as done`, { rule: 'transition', from: cur.status, to: 'done' }); });
    if (!opts.resetAttempts && !closesCapped && (opts.claim?.op === 'claim' || fields.status === 'doing' && cur.status !== 'doing' || cur.lane === 'failed-terminal' && (opts.claim || fields.status !== undefined && fields.status !== cur.status || fields.lane !== undefined && fields.lane !== cur.lane))) assertRetryAllowed(root, cur);
    const curVersion = Number(cur.version || 0);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== curVersion)
      throw new HttpError(409, `version conflict: task is at version ${curVersion}, you sent ${opts.expectedVersion}; re-read it and retry`, { current_version: curVersion, updated: cur.updated, status: cur.status });
    if (opts.ifStatus !== undefined) {
      const allowed = Array.isArray(opts.ifStatus) ? opts.ifStatus : [opts.ifStatus];
      if (!allowed.includes(cur.status)) throw new HttpError(409, `status is "${cur.status}", expected ${allowed.join('|')}`, { current_version: curVersion, status: cur.status });
    }
    // The finish line (src/lib/done-line.ts): a card whose spec says done_at: live closes only with a check line in its
    // result; without one it waits in review on the live-check lane. Leaving done-ready clears that lane.
    if (fields.status === 'done' && cur.status !== 'done') {
      const sp = currentSpec(root, id);
      const live = !!sp && doneLine(sp.text).done_at === 'live';
      if (live && !checkLine(fields.result ?? cur.result ?? '')) {
        fields.status = 'review'; fields.lane = LIVE_CHECK_LANE;
        // The card enters review here, so it gets the context block review needs (the writer's own fields win).
        const pr = fields.pr ?? cur.pr ?? '';
        if (pr && !(fields.pr_summary ?? cur.pr_summary ?? '').trim()) fields.pr_summary = `PR ${pr} merged; the end state still needs its check after the merge`;
        opts.context = {
          what: `Merged, but its spec says done_at: live: ${doneLine(sp!.text).done_when}`.slice(0, 400),
          why: 'A live card is done only after someone checks the end state where it is used, after the merge',
          do: 'Check the done_when line on the merged commit where it runs',
          rec: `Record the check: dask verify ${id} --evidence "<what you checked, where>" --commit <sha>`,
          after: 'The card moves to done with the check line as its result',
          ...(opts.context ?? {}),
        };
        opts.warnings?.push(`done_at: live: ${id} waits in review (lane ${LIVE_CHECK_LANE}) until someone checks the end state after the merge (dask verify ${id} --evidence "…" --commit <sha>)`);
      } else if (cur.lane === LIVE_CHECK_LANE && fields.lane === undefined) fields.lane = 'none';
    }
    const next: Task = { ...cur, ...fields } as Task;
    const holder = holderOf(cur);
    // A claim lease: a claimed task with no update for staleHours (default 6) is up for grabs without force — its
    // session most likely died. The take-over is recorded as a warning and in the activity log.
    // Measured from the holder's own last sign of life (its claim, or its last write in the activity log), so other
    // actors' notes on the task do not keep a dead session's claim alive.
    const staleMs = (opts.staleHours ?? 6) * 3600_000;
    const holderSeen = holderSeenAt(cur, readActivity(root, id));
    const staleClaim = !!cur.claimed_by && (opts.now ?? new Date()).getTime() - holderSeen > staleMs;
    // finish / release by someone else while a live claim is held: refused unless forced (plain field updates by other
    // writers still land, with a warning).
    if (opts.holderOnly && cur.claimed_by && cur.claimed_by !== actor && !staleClaim && !opts.holderOnly.force)
      throw new HttpError(409, `task is claimed by ${cur.claimed_by} since ${cur.claimed_at}; pass force=true to ${opts.action ?? 'finish'} it anyway`, { claimed_by: cur.claimed_by, claimed_at: cur.claimed_at ?? '', current_version: curVersion, status: cur.status });
    let claimHistory: { rel: string; content: string } | null = null;
    // A write that starts the work without the claim route (status → doing) takes the card too: same rules, same history.
    if (!opts.claim && fields.status === 'doing' && cur.status !== 'doing') { assertClaimAllowed(root, cur, actor, actor); claimHistory = historyAfterClaim(root, cur, actor); }
    if (opts.claim?.op === 'claim') {
      const who = opts.claim.who;
      // Spec rules first: neither force nor an expired lease gets past a Spec block or the answer key's author.
      assertClaimAllowed(root, cur, who, actor);
      // A claim for someone else counts both names (the human's own session is not a name in a history).
      const delegated = who !== actor && actor !== 'user';
      if (delegated) assertClaimAllowed(root, cur, actor, actor);
      claimHistory = historyAfterClaim(root, cur, who, delegated ? actor : undefined);
      if (!opts.claim.force && !staleClaim) {
        if (holder && holder !== who)
          throw new HttpError(409, `task is held by ${holder}${cur.claimed_at ? ` since ${cur.claimed_at}` : ''}; pass force=true to take it over`, { claimed_by: holder, claimed_at: cur.claimed_at ?? '', current_version: curVersion, status: cur.status });
        if (TERMINAL.includes(cur.status))
          throw new HttpError(409, `task is ${cur.status}; pass force=true to reopen and claim it`, { current_version: curVersion, status: cur.status });
      }
      if (holder && holder !== who) opts.warnings?.push(`took over from ${holder}${staleClaim && !opts.claim.force ? ` (stale claim: no update since ${cur.updated})` : ''}`);
      next.claimed_by = who;
      next.claimed_at = isoLocal(opts.now);
      if (fields.status === undefined && cur.status !== 'doing') next.status = 'doing';
    } else if (opts.claim?.op === 'release') {
      if (opts.claim.runId && cur.run_id !== opts.claim.runId)
        throw new HttpError(409, `the card is on another run now (${cur.run_id || 'none'}); nothing released`, { rule: 'run', run_id: cur.run_id ?? '', current_version: curVersion });
      if (holder && holder !== opts.claim.who && !opts.claim.force)
        throw new HttpError(409, `task is held by ${holder}; pass force=true to release it`, { claimed_by: holder, claimed_at: cur.claimed_at ?? '', current_version: curVersion });
      next.claimed_by = ''; next.claimed_at = ''; next.claim_seen = '';
      // A released claim goes back to the pool (otherwise its owner would still "hold" a doing task).
      if (fields.status === undefined && cur.status === 'doing' && cur.claimed_by) next.status = 'todo';
    } else if (holder && holder !== actor && cur.claimed_by) {
      opts.warnings?.push(`task is claimed by ${cur.claimed_by} since ${cur.claimed_at}`);
    }
    // The holder's own write is its heartbeat (claim_seen), kept in the task itself: the activity log is capped.
    // A housekeeping rename is not a sign of life: it neither refreshes nor revives the claim lease.
    if (next.claimed_by && actor === next.claimed_by && !opts.claim && !opts.housekeeping) next.claim_seen = isoLocal(opts.now);
    if (opts.claim) next.claim_seen = '';
    if (['todo', ...TERMINAL].includes(next.status) && next.status !== cur.status) { next.claimed_by = ''; next.claimed_at = ''; next.claim_seen = ''; }
    // A run that parks the card on the user is over: it holds nothing.
    if (opts.action === 'finish' && next.status === 'blocked-on-user') { next.claimed_by = ''; next.claimed_at = ''; next.claim_seen = ''; }
    (next as any).__present = [...new Set([...((cur as any).__present ?? []), ...Object.keys(fields)])];
    for (const [k, v] of Object.entries(opts.specFields ?? {})) {
      (next as any)[k] = v;
      (next as any).__present = v === undefined ? (next as any).__present.filter((x: string) => x !== k) : [...new Set([...(next as any).__present, k])];
    }
    // The handoff summary carries who wrote it and when; only the server sets these. Same text again keeps the stamp.
    if (fields.summary !== undefined && fields.summary !== (cur.summary || '')) {
      next.summary_by = fields.summary ? actor : '';
      next.summary_at = fields.summary ? isoLocal(opts.now) : '';
      (next as any).__present = [...new Set([...(next as any).__present, 'summary_by', 'summary_at'])];
    }
    // The now line: stamped like the summary, plus the log mark; same line again keeps them.
    // A finished card has none: the move into done/cancelled clears it in the same write, and a new line is refused after.
    if (fields.now && TERMINAL.includes(cur.status) && next.status === cur.status)
      throw new HttpError(409, `card is ${cur.status}; a finished card has no now line`, { rule: 'now', status: cur.status });
    if (TERMINAL.includes(next.status) && next.status !== cur.status) next.now = '';
    if (!next.now && !cur.now) next.now = cur.now; // '' on a card with no line is no change
    if ((next.now || '') !== (cur.now || '')) {
      next.now_by = next.now ? actor : '';
      next.now_at = next.now ? isoLocal(opts.now) : '';
      next.now_lint = next.now ? lintNow(next.now) : '';
      (next as any).__present = [...new Set([...(next as any).__present, 'now', 'now_by', 'now_at', 'now_lint'])];
    }
    applyPush(cur, next, actor, opts);
    const startsRun = next.status === 'doing' && cur.status !== 'doing'
      || opts.claim?.op === 'claim' && (holder !== opts.claim.who || !cur.run_id);
    if (startsRun) {
      next.run_id = randomUUID();
      next.attempt = String(Number(cur.attempt || 0) + 1);
    }
    if (opts.resetAttempts) {
      next.reset_epoch = String(Number(cur.reset_epoch || 0) + 1);
      next.attempt = '0'; next.run_id = '';
      next.claimed_by = ''; next.claimed_at = ''; next.claim_seen = '';
    }
    if (startsRun) {
      // started_at is also the run identity job runners check: never reuse the previous run's value (1 s resolution).
      // Strictly later than the previous run's started_at, so repeated restarts within a second never collide.
      let at = opts.now ?? new Date();
      const prev = cur.started_at ? Date.parse(cur.started_at) : NaN;
      if (Number.isFinite(prev) && Math.floor(at.getTime() / 1000) <= Math.floor(prev / 1000)) at = new Date(Math.floor(prev / 1000) * 1000 + 1000);
      next.started_at = isoLocal(at);
    }
    // A translation-only edit is not progress: it keeps `updated`, so "done in 24h" lists and the digest stay true.
    const i18nOnly = Object.keys(fields).length > 0 && Object.keys(fields).every((k) => I18N_ONLY.includes(k)) && !opts.claim
      && opts.body === undefined && !opts.context && !opts.appendNote?.trim() && !opts.appendBlock;
    if (!i18nOnly && !opts.housekeeping) next.updated = isoLocal(opts.now);
    if (typeof opts.body === 'string') next.body = opts.body;
    if (opts.context) next.body = applyContext(next.body, opts.context, fields.pr_summary);
    // Keep the block's "PR summary" line in step with the pr_summary field.
    else if (fields.pr_summary !== undefined && fields.pr_summary !== cur.pr_summary && parseContext(next.body)) next.body = applyContext(next.body, {}, fields.pr_summary);
    if (next.status === 'blocked-on-user' && !next.needs_user?.trim() && opts.context?.do) next.needs_user = opts.context.do;
    if (opts.appendNote?.trim()) next.body = appendNote(next.body, `${isoLocal(opts.now).slice(0, 16).replace('T', ' ')} ${actor}: ${opts.appendNote.trim()}`);
    if (opts.appendBlock) next.body = fitBlock(next, opts.appendBlock);
    // A client renaming the task without new translations: drop the stale ones, so the new title shows everywhere.
    if (fields.title !== undefined && fields.title !== cur.title)
      for (const k of I18N_ONLY) if (fields[k] === undefined && (next as any)[k]) { (next as any)[k] = ''; (next as any).__present = [...(next as any).__present, k]; }
    if (next.status !== cur.status || fields.pr !== undefined || fields.result !== undefined)
      // The user's own Done/Approve/checkbox on the board is the evidence; every other actor needs a PR, log or RESULT.md.
      gate(root, id, actor, opts.warnings, () => assertTransition(cur.status, next, { reopen: opts.reopen, forcedClaim: opts.claim?.op === 'claim' && opts.claim.force, humanDone: actor === 'user' }));
    // After every field and body change: the gate judges the card as this write would leave it.
    if (opts.statusGate && next.status !== cur.status) opts.statusGate(cur, next);
    // Notes that would push the file past the limit move to the notes archive, so status, claim, result and note writes
    // never get stuck on a long-lived task. Only a whole-body replace can still be refused as too big.
    assertNoForgedUserNote(actor, cur.body, next.body); // before notes move to the archive: judge what this write adds
    const archive = opts.specFields ? null : compactNotes(root, next); // a spec-field write leaves the body as it is
    validateOrThrow(next, root, cur.bytes, typeof opts.body === 'string');
    // Entering review/blocked-on-user (or writing a new context) needs the context block; exempt writers skip the check.
    // Same-status edits that replace the body or change the PR fields are re-checked too.
    const touchesCtx = typeof opts.body === 'string' || fields.pr !== undefined || fields.pr_summary !== undefined;
    if (((next.status !== cur.status || touchesCtx) && !contextExempt(actor, opts.exempt)) || opts.context) {
      const ce = contextErrors(next);
      if (ce.length) throw new HttpError(400, ce.join('; '), { rule: 'context' });
    }
    const changes = describeChanges(cur, next, fields, opts);
    if (!changes && !opts.extraFiles && !opts.resetAttempts) return cur;
    next.version = String(curVersion + 1);
    const action = opts.housekeeping ? 'rename' : opts.action ?? (next.status !== cur.status ? 'status' : opts.appendNote?.trim() && Object.keys(fields).length === 0 ? 'note' : i18nOnly ? 'i18n' : changes === 'edit now' ? 'now' : 'edit');
    const entry: Activity = { at: isoLocal(opts.now), actor, action, note: opts.appendNote?.trim() || (action === 'edit' ? changes.replace(/^edit /, '') : action === 'now' ? next.now || 'now cleared' : '') };
    if (next.status !== cur.status) { entry.from = cur.status; entry.to = next.status; }
    const serialized = serializeTask(next);
    const prepared = taskFromParsed(parseFrontmatter(serialized), cur.file, Buffer.byteLength(serialized));
    const extraFiles = typeof opts.extraFiles === 'function' ? opts.extraFiles(prepared) : opts.extraFiles ?? [];
    commitFiles(root, [
      { rel: cur.file, content: serialized },
      { rel: activityRelPath(id), content: activityContent(root, id, entry) },
      ...(archive ? [archive] : []),
      ...(claimHistory ? [claimHistory] : []),
      ...extraFiles,
      ...unblockedFiles(root, cur, next, actor, opts.now),
    ], `${actor}: ${id} ${changes}`, { [cur.file]: curRaw });
    return readTask(root, id);
  });
}

/** Set the user's push (opts.push), or drop one that no longer holds: the card left todo, was claimed, or moved lane. */
function applyPush(cur: Task, next: Task, actor: string, opts: UpdateOpts): void {
  if (opts.push) {
    if (actor !== 'user') throw new HttpError(403, 'only the user can push a card to the front of its lane');
    if (next.status !== 'todo' || next.claimed_by || !next.lane || next.lane === 'none')
      throw new HttpError(409, 'push needs a todo, unclaimed card on a lane', { rule: 'push', status: next.status, lane: next.lane });
    next.pushed = formatPush({ at: isoLocal(opts.now), by: actor, lane: next.lane });
    (next as any).__present = [...new Set([...(next as any).__present, 'pushed'])];
    return;
  }
  const p = parsePush(next.pushed);
  if (next.pushed && (!p || next.status !== 'todo' || next.claimed_by || next.lane !== p.lane)) next.pushed = '';
  void cur;
}

function unblockedFiles(root: string, cur: Task | null, next: Task, actor: string, now?: Date): { rel: string; content: string }[] {
  if (next.status !== 'done' || cur?.status === 'done') return [];
  const tasks = loadBoard(root).tasks;
  const statuses = new Map(tasks.map((t) => [t.id, t.status]));
  statuses.set(next.id, 'done');
  return tasks.filter((t) => t.id !== next.id && t.status === 'todo' && depsOf(t).includes(next.id) && depsOf(t).every((id) => statuses.get(id) === 'done'))
    .map((t) => ({ rel: activityRelPath(t.id), content: activityContent(root, t.id, { at: isoLocal(now), actor, action: 'unblocked', note: `dependencies complete: ${next.id}` }) }));
}

function describeChanges(cur: Task, next: Task, fields: Record<string, string>, opts: UpdateOpts): string {
  const parts: string[] = [];
  if (cur.status !== next.status) parts.push(`status ${cur.status} -> ${next.status}`);
  if (opts.claim?.op === 'claim') parts.push(`claimed by ${next.claimed_by}`);
  else if (opts.claim?.op === 'release' && cur.claimed_by) parts.push('released');
  for (const k of Object.keys(fields)) {
    if (k === 'status' || k === 'started_at') continue;
    if ((cur as any)[k] !== (next as any)[k]) parts.push(k);
  }
  if (opts.context && next.body !== cur.body) parts.push('context');
  const specChanged = Object.keys(opts.specFields ?? {}).filter((k) => JSON.stringify((cur as any)[k] ?? null) !== JSON.stringify((next as any)[k] ?? null));
  if (specChanged.length) parts.push(specChanged.includes('spec_state') ? `spec_state ${next.spec_state}` : specChanged.join(', '));
  if ((cur.pushed || '') !== (next.pushed || '')) parts.push(next.pushed ? 'pushed' : 'push cleared');
  if ((typeof opts.body === 'string' && opts.body !== cur.body) || opts.appendNote?.trim() || opts.appendBlock) parts.push(opts.appendNote ? 'note' : 'body');
  if (!parts.length) return '';
  const s = parts.join(', ');
  return oneLine(s.startsWith('status') ? s : 'edit ' + s, 100);
}

const WRITE_LIMIT = MAX_TASK_BYTES * 2;

/** Append a fenced diagnostic block to the CURRENT body, dropping oldest lines so the task stays writable. */
function fitBlock(t: Task, block: { heading: string; lines: string[] }): string {
  const heading = String(block.heading).replace(/[\r\n]+/g, ' ').slice(0, 120);
  let lines = (Array.isArray(block.lines) ? block.lines : []).map((l) => String(l).replace(/```/g, "'''").slice(0, 300)).slice(-40);
  const build = (ls: string[]) => `${t.body.replace(/\s+$/, '')}\n\n## ${heading}\n\`\`\`\n${ls.join('\n') || '(no log output)'}\n\`\`\`\n`;
  while (lines.length && Buffer.byteLength(serializeTask({ ...t, body: build(lines) })) > WRITE_LIMIT) lines = lines.slice(1);
  const out = build(lines);
  return Buffer.byteLength(serializeTask({ ...t, body: out })) > WRITE_LIMIT ? t.body : out;
}

/** Note lines written as the human ("- YYYY-MM-DD HH:MM user: …"): a reader takes them as the user's own words, so only
 *  the logged-in human (actor "user") may add one; any other writer can only keep or drop them. */
// Any bullet a reader would take as the human's: "- " or "* ", an optional date/time-like prefix (any digits and
// separators: "2026-10-17 9:05", seconds, extra spaces), then "user:" in any case/spacing.
const USER_LINE_RE = /^\s*[-*]\s+(?:[\d\-:./T]+\s+)*user\s*:/i;
const userLines = (body: string) => body.split(/\r?\n|\r/).filter((l) => USER_LINE_RE.test(l)).map((l) => l.trim());
export const userNoteCount = (body: string) => userLines(body).length;
/** A writer other than the human may keep or drop "user:" lines but never add one or change its text (each line of the
 *  result must already be in the card, as often as it is used). */
function assertNoForgedUserNote(actor: string, before: string, after: string): void {
  if (actor === 'user') return;
  const had = new Map<string, number>();
  for (const l of userLines(before)) had.set(l, (had.get(l) ?? 0) + 1);
  for (const l of userLines(after)) {
    const n = had.get(l) ?? 0;
    if (!n) throw new HttpError(403, 'only the human in the board UI writes "user:" notes (adding or editing one); write your note under your own name', { rule: 'user-note' });
    had.set(l, n - 1);
  }
}
/** Add a note at the end of the "## Notes" section (not at the end of the body: a later section, e.g. a job failure
 *  block, must not swallow it, or the digest, the threads view and note compaction would never see it). */
export function appendNote(body: string, line: string): string {
  const b = body.replace(/\s+$/, '');
  const clean = line.replace(/\r?\n/g, ' ').slice(0, 500);
  const m = /(^|\n)## Notes[ \t]*\n([\s\S]*?)(?=\n## |$)/.exec(b);
  if (!m) return `${b}\n\n## Notes\n- ${clean}\n`;
  const end = m.index + m[0].length;
  const section = b.slice(0, end).replace(/\s+$/, '');
  const rest = b.slice(end);
  return `${section}\n- ${clean}${rest ? `\n${rest.replace(/^\n+/, '\n')}` : ''}\n`;
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task';
}

export interface NewTask { [k: string]: unknown }

export interface CreateOpts {
  context?: Context; exempt?: string[];
  /** Filled with human-readable warnings (title rule). */
  warnings?: string[];
  /** The idea this task is promoted from (stored as `idea`), and more files to commit in the same commit (the ideas file). */
  idea?: string;
  extraFiles?: (t: Task) => { rel: string; content: string }[];
  /** Extra words for the commit message. */
  note?: string;
  /** Out: set true when the create was a retry of a recent identical create and the stored task came back. */
  replayed?: boolean;
  /** The intake brake (config `intake`; the server passes it). Without it nothing is limited. */
  intake?: IntakeConfig;
  /** Skip the near-duplicate check (never the limit). */
  force?: boolean;
}

/** A create the intake limit turned into an idea (202): nothing but the idea was written. */
export interface IntakeIdea { intake: 'idea'; goal: string; open_todo: number; limit: number; idea: Idea }

/** Title as compared for a near-duplicate: NFKC, lowercase, each run of non-letters/digits one space, trimmed. */
export const normTitle = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The oldest open task of the goal that this title repeats (same normTitle, or id <goal>.t-<slug> / <slug>-N), or null. */
export function nearDuplicate(tasks: Pick<Task, 'id' | 'goal' | 'status' | 'title' | 'created'>[], goal: string, title: string): string | null {
  const key = normTitle(title), base = `${goal}.t-${slugify(title)}`;
  const slugRe = new RegExp(`^${base.replace(/\./g, '\\.')}(?:-\\d+)?$`); // ids are [a-z0-9.-] only
  const hits = tasks.filter((t) => t.goal === goal && !['done', 'cancelled'].includes(t.status)
    && ((key !== '' && normTitle(String(t.title ?? '')) === key) || slugRe.test(t.id)));
  hits.sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')) || a.id.localeCompare(b.id));
  return hits[0]?.id ?? null;
}

/** The goal's todo limit (goal_limits wins over todo_limit); 0 = off. */
export const intakeLimit = (cfg: IntakeConfig, goal: string): number => (Object.hasOwn(cfg.goal_limits, goal) ? cfg.goal_limits[goal] : cfg.todo_limit);

/** Every task of one goal as its files are now (under the lock); unparseable files are skipped. */
function goalTasks(root: string, goal: string): Task[] {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(root, 'data', 'tasks', goal)); } catch { return []; }
  const out: Task[] = [];
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    try { out.push(readTask(root, `${goal}.${n.slice(0, -3)}`)); } catch { /* not a task: never counted */ }
  }
  return out;
}

const stamp = (d: Date) => isoLocal(d).slice(0, 16).replace('T', ' ');

/** Over the limit: the create lands as an idea of the goal (a retry within CREATE_REPLAY_MS gets the same idea back). */
function intakeIdea(root: string, input: NewTask, actor: string, goal: string, n: number, limit: number, now: Date): IntakeIdea {
  const full = oneLine(String(input.title ?? '') || str(input.title_ko), Infinity);
  const title = oneLine(full, 120);
  const source = `intake-limit: ${actor}`;
  const body = typeof input.body === 'string' ? input.body : '';
  const ROOM = 'promote it when there is room';
  const note = oneLine(`intake limit: ${goal} has ${n} todo (limit ${limit}); created by ${actor} ${stamp(now)}; ${ROOM} ${body.slice(0, 500)}`, 600);
  const tail = (s: string) => { const k = s.indexOf(ROOM); return k < 0 ? null : s.slice(k + ROOM.length); };
  // A retry: same source, the same whole title (a title cut to 120 never matches, so two long titles that share
  // their first 120 characters both land) and the same body excerpt, within the replay window.
  const prev = full === title ? readIdeas(root, goal).ideas.find((i) => {
    const age = now.getTime() - Date.parse(i.added_at);
    return i.status === 'open' && i.source === source && i.title === title && tail(i.note) === tail(note) && age >= 0 && age <= CREATE_REPLAY_MS;
  }) : undefined;
  // The English title too (the idea id is made from it; a Korean-only title would give `<goal>.i-task`).
  const en = oneLine(str(input.title_en) || (str(input.title_ko) ? String(input.title ?? '') : ''), 120);
  const idea = prev ?? addIdea(root, goal, { title, ...(en && en !== title ? { title_en: en } : {}), note, source }, actor, { now });
  return { intake: 'idea', goal, open_todo: n, limit, idea };
}

/** A create equal to one made this recently (goal, title, body) returns that task: a client retry after a timeout. */
export const CREATE_REPLAY_MS = 15 * 60_000;

/** The body as compared for a replay: the file stores it as "\n" + body + "\n" (serializeTask). */
const bodyKey = (b: string) => b.replace(/^[\r\n]+|[\r\n]+$/g, '');

/** Under the repo lock: the task this create repeats, if any. Explicit id: that id
 *  only; else the base id and each existing `<base>-N`, lowest first. */
function findReplay(root: string, base: string, explicit: boolean, goal: string, title: string, body: string, now: Date): Task | null {
  const key = bodyKey(body);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!fs.existsSync(path.join(root, taskRelPath(id)))) return null;
    let t: Task | null = null;
    try { t = readTask(root, id); } catch { /* unparseable: never a replay target */ }
    if (t && t.goal === goal && t.title === title && bodyKey(t.body ?? '') === key) {
      const age = now.getTime() - Date.parse(t.created);
      if (age >= 0 && age <= CREATE_REPLAY_MS) return t;
    }
    if (explicit) return null;
  }
}

/** First active milestone of a goal (else its first one): the default when a client does not pick one. */
function defaultMilestone(root: string, goal: string): string {
  const g = loadGoals(root).goals.find((g) => g.id === goal);
  return (g?.milestones.find((m) => m.status === 'active') ?? g?.milestones[0])?.id ?? '';
}

export function createTask(root: string, input: NewTask, actor: string, now = new Date(), copts: CreateOpts = {}): Task {
  const out = createTaskOrIdea(root, input, actor, now, copts);
  if ('intake' in out) throw new HttpError(500, 'create was turned into an idea where a task was expected');
  return out;
}

/** createTask with the intake brake: a task, or (with copts.intake, over the goal's limit) the idea it became. */
export function createTaskOrIdea(root: string, input: NewTask, actor: string, now = new Date(), copts: CreateOpts = {}): Task | IntakeIdea {
  if (input.lane === 'failed-terminal') throw new HttpError(409, 'only the retry cap moves a card to the failed-terminal lane', { rule: 'retry-cap' });
  const goal = String(input.goal ?? '');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new HttpError(400, 'title is required');
  for (const k of Object.keys(FIELD_CAPS)) if (typeof input[k] === 'string') capField(k, k === 'title' ? title : input[k] as string);
  copts.warnings?.push(...titleWarnings(input));
  const serverOnly = (SPEC_TASK_FIELDS as readonly string[]).filter((k) => Object.hasOwn(input, k));
  if (serverOnly.length) throw new HttpError(400, `field(s) ${serverOnly.join(', ')} are set by the board (spec routes), not on create`);
  return withRepoLock(root, () => {
    // Goals are data-driven (data/goals/*.yaml): checked against the files as they are now, under the lock.
    if (!isGoal(root, goal)) throw new HttpError(400, `unknown goal "${goal}" (goals: ${goalIdsOf(loadGoals(root)).join(', ')})`);
    const explicit = typeof input.id === 'string' && input.id ? input.id : '';
    let id = explicit || `${goal}.t-${slugify(title)}`;
    if (!isTaskId(id) || goalOf(id) !== goal) throw new HttpError(400, `bad task id "${id}" (want ${goal}.t-<slug>)`);
    // A retry of a create seen moments ago (the client timed out) gets the first task back: no write or commit. Idea promotion never replays (its idea file must still be written).
    if (!copts.idea && !copts.extraFiles) {
      let body = typeof input.body === 'string' ? input.body : '';
      if (copts.context) body = applyContext(body, copts.context, str(input.pr_summary));
      const hit = findReplay(root, id, !!explicit, goal, title, body, now);
      if (hit) { copts.replayed = true; return hit; }
    }
    if (!explicit) { let n = 2; const base = id; while (fs.existsSync(path.join(root, taskRelPath(id)))) id = `${base}-${n++}`; }
    else if (fs.existsSync(path.join(root, taskRelPath(id)))) throw new HttpError(409, `task "${id}" already exists`);
    const ts = isoLocal(now);
    const t: any = {
      id, title, goal,
      milestone: str(input.milestone) || defaultMilestone(root, goal), owner: str(input.owner) || actor, lane: str(input.lane) || 'none',
      kind: str(input.kind) || 'impl', status: str(input.status) || 'todo', priority: str(input.priority) || 'p2',
      pr: str(input.pr), pr_summary: str(input.pr_summary), result: str(input.result), needs_user: str(input.needs_user),
      approvals: str(input.approvals) || 'none', created: ts, updated: ts,
      title_ko: cleanTitle(str(input.title_ko), 'title_ko'), title_en: cleanTitle(str(input.title_en), 'title_en'), idea: copts.idea ?? '', depends_on: normDeps(input.depends_on), secrets: normDeps(input.secrets),
      started_by: str(input.started_by) || (actor === 'user' ? 'user' : 'bot'),
      body: typeof input.body === 'string' ? input.body : '',
      file: taskRelPath(id),
    };
    if (t.status === 'doing') t.started_at = ts;
    if (copts.context) t.body = applyContext(t.body, copts.context, t.pr_summary);
    if (t.status === 'blocked-on-user' && !t.needs_user.trim() && copts.context?.do) t.needs_user = copts.context.do;
    t.version = '1';
    t.__present = [...TASK_ALL_FIELDS];
    gate(root, id, actor, copts.warnings, () => assertTransition(null, t, { humanDone: actor === 'user' }));
    assertNoForgedUserNote(actor, '', t.body);
    validateOrThrow(t, root);
    if (copts.context || !contextExempt(actor, copts.exempt)) {
      const ce = contextErrors(t);
      if (ce.length) throw new HttpError(400, ce.join('; '), { rule: 'context' });
    }
    // Intake brake, after the replay check: near-duplicate (409), then the goal's todo
    // limit (the create becomes an idea). Exempt actors and idea promotion (a deliberate create) skip both.
    const ik = copts.intake;
    if (ik && !copts.idea && !copts.extraFiles && !ik.exempt_actors.includes(actor)) {
      const mine = goalTasks(root, goal);
      if (ik.dup_check && !copts.force) {
        const dup = nearDuplicate(mine, goal, title);
        if (dup) throw new HttpError(409, `near-duplicate of ${dup}`, { rule: 'near-duplicate', existing: dup });
      }
      const limit = intakeLimit(ik, goal), n = mine.filter((x) => x.status === 'todo').length;
      if (limit > 0 && n >= limit) return intakeIdea(root, input, actor, goal, n, limit, now);
    }
    const entry: Activity = { at: ts, actor, action: 'create', to: t.status, ...(copts.idea ? { note: `from idea ${copts.idea}` } : {}) };
    commitFiles(root, [
      { rel: t.file, content: serializeTask(t) },
      { rel: activityRelPath(id), content: activityContent(root, id, entry) },
      ...(copts.extraFiles ? copts.extraFiles(t as Task) : []),
      newClaimHistory(id), // a complete, empty claim history (lib/spec-state.ts)
      ...unblockedFiles(root, null, t, actor, now),
    ], `${actor}: create ${id} (${t.status})${copts.note ? ` ${copts.note}` : ''}`);
    return readTask(root, id);
  });
}

function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'all task fields must be strings');
  return v;
}

export { readTask };

// ---------- goals / milestones / north star ----------
const NODE_EDITABLE: Record<string, string[]> = {
  northstar: ['title', 'title_ko', 'title_en', 'why', 'horizon'],
  goal: ['title', 'title_ko', 'title_en', 'why', 'owner', 'repo', 'profile'],
  milestone: ['title', 'title_ko', 'title_en', 'status', 'due', 'done_criteria'],
};

export interface NodeOpts {
  /** Refuse (409) unless the node's title is still this one (a translation of an older title must not land). */
  expectedTitle?: string;
  /** Refuse (409) a title_ko / title_en that is already set (fill only what is missing). */
  ifMissing?: boolean;
  /** field -> the value the writer last saw (done_criteria: lines joined by "\n"); 409 if any changed meanwhile. */
  expected?: Record<string, string>;
}

export function updateNode(root: string, id: string, patch: Record<string, unknown>, actor: string, nopts: NodeOpts = {}): void {
  return withRepoLock(root, () => {
    let rel: string; let kind: 'northstar' | 'goal' | 'milestone';
    if (id === NORTHSTAR_ID) { rel = 'data/northstar.yaml'; kind = 'northstar'; }
    else if (isGoal(root, id)) { rel = `data/goals/${id}.yaml`; kind = 'goal'; }
    else if (isMilestoneId(id) && isGoal(root, goalOf(id))) { rel = `data/goals/${goalOf(id)}.yaml`; kind = 'milestone'; }
    else throw new HttpError(400, `bad node id "${id}" (tasks use /api/tasks/:id)`);
    const abs = safeAbs(root, rel);
    let doc: YAML.Document;
    try { doc = YAML.parseDocument(fs.readFileSync(abs, 'utf8')); } catch { throw new HttpError(404, `no node "${id}"`); }
    let target: YAML.YAMLMap;
    if (kind === 'milestone') {
      const ms = doc.get('milestones') as YAML.YAMLSeq | undefined;
      const node = ms?.items.find((it: any) => it?.get?.('id') === id) as YAML.YAMLMap | undefined;
      if (!node) throw new HttpError(404, `no milestone "${id}"`);
      target = node;
    } else target = doc.contents as YAML.YAMLMap;
    const changed: string[] = [];
    const curTitle = String(target.get('title') ?? '');
    if (nopts.expectedTitle !== undefined && nopts.expectedTitle !== curTitle)
      throw new HttpError(409, `title of ${id} changed since (now "${curTitle}")`, { title: curTitle });
    for (const [k, want] of Object.entries(nopts.expected ?? {})) {
      const v = target.get(k);
      const now = v === undefined || v === null ? '' : YAML.isSeq(v) ? (v as YAML.YAMLSeq).toJSON().map(String).join('\n') : String(v);
      if (now !== String(want)) throw new HttpError(409, `${id}: ${k} changed since you read it`, { field: k, current: now });
    }
    if (nopts.ifMissing) for (const k of ['title_ko', 'title_en']) if (patch[k] !== undefined && target.get(k)) throw new HttpError(409, `${id} already has ${k}`, { [k]: String(target.get(k)) });
    for (const [k, v] of Object.entries(patch)) {
      if (!NODE_EDITABLE[kind].includes(k)) throw new HttpError(400, `field "${k}" is not editable on a ${kind}`);
      if (k === 'profile') {
        // The whole block is replaced; null removes it. as_of and by are the server's (lib/profile.ts).
        if (v === null) { if (target.has('profile')) { target.delete('profile'); changed.push('profile removed'); } continue; }
        let p;
        try { p = cleanProfileInput(v); } catch (e: any) { throw new HttpError(400, e.message); }
        target.set('profile', doc.createNode({ as_of: isoLocal(), by: actor, ...p }));
        changed.push('profile');
        continue;
      }
      if (k === 'done_criteria') {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, 'done_criteria must be a list of strings');
        target.set(k, doc.createNode((v as string[]).map((x) => x.trim()).filter(Boolean)));
      } else {
        if (typeof v !== 'string') throw new HttpError(400, `field "${k}" must be a string`);
        if (k === 'status' && !(MILESTONE_STATUSES as readonly string[]).includes(v)) throw new HttpError(400, `bad milestone status "${v}"`);
        if (k === 'due' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'due must be YYYY-MM-DD or empty');
        if (k === 'title' && !v.trim()) throw new HttpError(400, 'title cannot be empty');
        if (k === 'title_ko' || k === 'title_en') {
          // Per-language display title: one line; empty removes it. The original `title` is never touched by these.
          const c = cleanTitle(v, k);
          if (c) target.set(k, c); else target.delete(k);
          changed.push(k);
          continue;
        }
        if (k === 'title' && v !== curTitle) for (const tk of ['title_ko', 'title_en']) if (patch[tk] === undefined) target.delete(tk); // stale translations go
        target.set(k, v);
      }
      changed.push(k === 'status' ? `status -> ${v}` : k);
    }
    // The commit skips the whole-board hook, so check the edited node against the same rules `dasks check` uses.
    const o = target.toJSON() as Record<string, unknown>;
    const bad = (m: string) => { throw new HttpError(400, `${id}: ${m}`); };
    const strOf = (k: string) => (o[k] === undefined || o[k] === null ? '' : String(o[k]));
    if (!strOf('title').trim()) bad('title is empty');
    if (kind === 'northstar') { for (const k of ['why', 'horizon']) if (!strOf(k).trim()) bad(`${k} is empty`); }
    if (kind === 'goal' && !strOf('owner').trim()) bad('owner is empty');
    if (kind === 'milestone') {
      if (!(MILESTONE_STATUSES as readonly string[]).includes(strOf('status'))) bad(`bad status "${strOf('status')}"`);
      if (strOf('due') && !isValidDate(strOf('due'))) bad(`bad due "${strOf('due')}" (a real date YYYY-MM-DD, or empty)`);
      if (o.done_criteria !== undefined && o.done_criteria !== null && !Array.isArray(o.done_criteria)) bad('done_criteria must be a list');
    }
    const content = doc.toString({ lineWidth: 0 });
    // Nothing really changed (same values sent again): no empty commit.
    if (!changed.length || content === fs.readFileSync(abs, 'utf8')) return;
    commitFiles(root, [{ rel, content }], `${actor}: ${id} ${oneLine(changed.join(', '), 100)}`);
  });
}

export const STATUS_LIST = ALL_STATUSES;
