// The code map of one repo at one commit (docs/runner.md "Code map"): which repo file imports which, read from the git
// tree (`git ls-tree`, `git cat-file --batch`), never the working tree, with no model and no network. It is a cache: a
// lost or broken map file is built again. A build is bounded (files, bytes, time) so a huge repo cannot stall a runner.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runBounded, why } from '../proc.ts';
import { importsOf, isPackageSwift, SOURCE, swiftTargets, type Tree } from './imports.ts';

/** `edges` are `[from, to]`: `from` imports `to`, a repo file or a SwiftPM target dir ending in `/`. */
export interface CodeMap { repo: string; sha: string; built_at: string; files: string[]; edges: [string, string][]; truncated: boolean }
/** A map as the runner holds it: stale = built at another commit than the clone's default branch has now. */
export interface MapView { map: CodeMap; stale: boolean }

export const LIMITS = { files: 20_000, blobBytes: 512 * 1024, totalBytes: 64 * 1024 * 1024, timeoutMs: 60_000 };

type Read = (file: string) => string | undefined;

/** The map's edges, one source file per step (a step yields nothing; the return value is the edge list). */
function* edgeSteps(sorted: string[], read: Read): Generator<void, [string, string][]> {
  const tree: Tree = { files: new Set(sorted), swift: [] };
  for (const f of sorted) if (isPackageSwift(f)) tree.swift.push(...swiftTargets(f, read(f) ?? ''));
  const edges: [string, string][] = [];
  for (const f of sorted) {
    if (!SOURCE.test(f) || isPackageSwift(f)) continue;
    const text = read(f);
    if (text) for (const to of importsOf(f, text, tree)) edges.push([f, to]);
    yield;
  }
  return edges;
}

/** The map from a tree's file list and a reader of its files. Pure. */
export function mapFromTree(repo: string, sha: string, files: string[], read: Read, builtAt: string, truncated = false): CodeMap {
  const sorted = [...files].sort(), steps = edgeSteps(sorted, read);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return { repo, sha, built_at: builtAt, files: sorted, edges: r.value, truncated };
}

/** mapFromTree that gives the event loop a turn every 20 ms (heartbeats, kill timers) and throws past `until`. */
async function mapFromTreeBounded(repo: string, sha: string, files: string[], read: Read, truncated: boolean, until: number): Promise<CodeMap> {
  const sorted = [...files].sort(), steps = edgeSteps(sorted, read);
  let r = steps.next(), slice = Date.now();
  while (!r.done) {
    if (Date.now() - slice > 20) {
      await new Promise((ok) => setImmediate(ok));
      if (Date.now() > until) throw new Error('timed out reading imports');
      slice = Date.now();
    }
    r = steps.next();
  }
  return { repo, sha, built_at: new Date().toISOString(), files: sorted, edges: r.value, truncated };
}

/** The texts of `paths` at `sha` through one `git cat-file --batch`. Rejects on timeout or past `maxBytes`. */
function readBlobs(dir: string, sha: string, paths: string[], timeoutMs: number, maxBytes: number): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['cat-file', '--batch'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs);
    const chunks: Buffer[] = [];
    let size = 0;
    p.stdout.on('data', (c: Buffer) => {
      chunks.push(c); size += c.length;
      if (size > maxBytes + paths.length * 128) { clearTimeout(timer); p.kill('SIGKILL'); reject(new Error('blobs over the byte limit')); }
    });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.stdin.on('error', () => { /* the process died: 'close' says how */ });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`));
      const buf = Buffer.concat(chunks), out = new Map<string, string>();
      let at = 0;
      for (const f of paths) {
        const nl = buf.indexOf(10, at);
        if (nl < 0) break;
        const head = buf.subarray(at, nl).toString().split(' ');
        at = nl + 1;
        if (head[1] !== 'blob') continue;   // "<spec> missing"
        const n = Number(head[2]);
        out.set(f, buf.subarray(at, at + n).toString('utf8'));
        at += n + 1;
      }
      resolve(out);
    });
    p.stdin.end(paths.map((f) => `${sha}:${f}`).join('\n') + '\n');
  });
}

/** The clone's default-branch head: `origin/main`, else `origin/HEAD`; '' when it has neither. */
export async function defaultHead(dir: string): Promise<string> {
  for (const ref of ['origin/main', 'origin/HEAD']) {
    const r = await runBounded('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir, timeoutMs: 10_000 });
    if (r.code === 0 && r.out.trim()) return r.out.trim();
  }
  return '';
}

/** Build the map of the clone at `dir` at commit `sha`, within `limits`. Only source files and Package.swift up to
 *  limits.blobBytes are read; past limits.files or limits.totalBytes the rest are listed but not read (`truncated`). */
export async function buildMap(dir: string, sha: string, limits = LIMITS): Promise<CodeMap> {
  const until = Date.now() + limits.timeoutMs;
  const ls = await runBounded('git', ['ls-tree', '-r', '-z', '-l', sha], { cwd: dir, timeoutMs: limits.timeoutMs, maxOut: 256 << 20 });
  if (ls.code !== 0 || ls.timedOut) throw new Error(`git ls-tree: ${why(ls)}`);
  const files: string[] = [], read: string[] = [];
  let bytes = 0, truncated = false;
  for (const row of ls.out.split('\0')) {
    const m = /^\d+ (\w+) \w+ +(\d+|-)\t(.+)$/s.exec(row);
    if (!m || m[1] !== 'blob') continue;
    files.push(m[3]);
    const n = Number(m[2]);
    if (!(SOURCE.test(m[3]) || isPackageSwift(m[3])) || n > limits.blobBytes) continue;
    if (read.length >= limits.files || bytes + n > limits.totalBytes) { truncated = true; continue; }
    read.push(m[3]); bytes += n;
  }
  const blobs = await readBlobs(dir, sha, read, Math.max(1, until - Date.now()), limits.totalBytes);
  return mapFromTreeBounded(dir, sha, files, (f) => blobs.get(f), truncated, until);
}

/** The runner's maps, one JSON file per clone in `stateDir`. refresh() looks at each clone's default-branch head and
 *  rebuilds a map that is behind, one clone at a time and once per head, in the background; a failed build logs one
 *  line and the last good map stays (stale). Nothing here throws or holds up a start. */
export function codemapCache(stateDir: string, log: (line: string) => void, build = buildMap) {
  const maps = new Map<string, CodeMap>(), heads = new Map<string, string>(), tried = new Map<string, string>();
  const fileFor = (repo: string) => path.join(stateDir, crypto.createHash('sha1').update(path.resolve(repo)).digest('hex').slice(0, 16) + '.json');
  let busy: Promise<void> | null = null;
  const load = (repo: string) => {
    if (maps.has(repo)) return maps.get(repo);
    try {
      const m = JSON.parse(fs.readFileSync(fileFor(repo), 'utf8')); // not-board: code map state
      if (m && m.repo === repo && typeof m.sha === 'string' && Array.isArray(m.files) && Array.isArray(m.edges)) { maps.set(repo, m); return m as CodeMap; }
    } catch { /* none yet, or broken: built again */ }
    return undefined;
  };
  async function refreshAll(repos: string[]) {
    for (const repo of repos) {
      const head = await defaultHead(repo).catch(() => '');
      if (!head) continue;
      heads.set(repo, head);
      if (load(repo)?.sha === head || tried.get(repo) === head) continue;
      tried.set(repo, head);
      try {
        const m = await build(repo, head);
        fs.mkdirSync(stateDir, { recursive: true }); // not-board: code map state
        const f = fileFor(repo), tmp = `${f}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, f); // not-board: code map state
        maps.set(repo, m);
        log(`code map: ${repo} at ${head.slice(0, 7)}: ${m.files.length} files, ${m.edges.length} imports${m.truncated ? ` (truncated: past the file or byte limit)` : ''}`);
      } catch (e: any) {
        const last = maps.get(repo);
        log(`code map: ${repo} not built at ${head.slice(0, 7)} (${String(e?.message ?? e).slice(0, 160)}); ${last ? `map ${last.sha.slice(0, 7)} stays, stale` : 'no import warnings for it'}`);
      }
    }
  }
  return {
    /** The map for one clone; null when there is none yet. */
    view(repo: string): MapView | null {
      const m = load(repo);
      return m ? { map: m, stale: heads.get(repo) !== m.sha } : null;
    },
    /** Bring the maps of these clones up to date; a call while one runs returns that run. */
    refresh(repos: string[]): Promise<void> {
      busy ??= refreshAll(repos).catch((e) => log(`code map: refresh failed (${e?.message ?? e})`)).finally(() => { busy = null; });
      return busy;
    },
  };
}
