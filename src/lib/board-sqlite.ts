// The SQLite board store (docs/storage.md): the board's data/ files as rows of one SQLite file, so a write is one
// transaction instead of lock folder + journal + git add + commit. A row holds the file's exact bytes, so import, compare
// and export are byte copies. Every write is also kept as a change row (message, time, files); bin/board-store.ts export
// replays those as git commits into the store's own export repo (a bare clone of the checkout that only this store
// writes), so git history, the digest, the decisions witness and the backup push keep working, a little later.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

// files.seq: the change that last wrote the row (0 = imported). stat() reports it as the inode, so a cache keyed on
// ino:mtime:size sees every rewrite, even two in the same millisecond.
const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS files (rel TEXT PRIMARY KEY, content BLOB NOT NULL, mtime_ms INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, message TEXT NOT NULL, exported INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS change_files (seq INTEGER NOT NULL, rel TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY (seq, rel));
CREATE INDEX IF NOT EXISTS changes_pending ON changes (exported, seq);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;
const TABLES = ['files', 'changes', 'change_files', 'meta'];
// meta: db_id (random, set at creation; the export's Board-Change trailer and the export repo's marker name it), root
// (real path of the checkout the import read: the only one the store serves), branch and head (the checkout's branch and
// HEAD at the import), export_repo, export_branch, export_head (the commit the store made last there, or the imported
// HEAD before any).
const IMPORT_META = ['root', 'branch', 'head', 'export_repo', 'export_branch', 'export_head'];

interface Stmts { row: StatementSync; gt: StatementSync; ge: StatementSync; dirStat: StatementSync; under: StatementSync; put: StatementSync; keep: StatementSync; change: StatementSync; head: StatementSync }
export interface SqliteBoard { root: string; realRoot: string; dbPath: string; db: DatabaseSync; q: Stmts }
let open: SqliteBoard | null = null;

const gitIn = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

/** Open the store for the board at `root` (one per process: opening another closes the first). `create: true` (only
 *  `board-store import`) makes the file and its tables. `create: false` (every other reader) never creates or writes the
 *  file and throws when it is missing, is not a board store, or cannot stand for this checkout (storeProblem). */
export function openSqliteBoard(root: string, dbPath: string, { create = false }: { create?: boolean } = {}): SqliteBoard {
  closeSqliteBoard();
  if (!create && !fs.existsSync(dbPath)) throw new Error(`no board store at ${dbPath} (only board-store import creates one)`); // not-board: the db file
  if (create) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    if (create) { db.exec(SCHEMA); db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('db_id', ?)").run(randomUUID()); }
    else {
      const have = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(', ')})`).get(...TABLES) as { n: number };
      if (Number(have.n) !== TABLES.length) throw new Error(`${dbPath} is not a board store (no board tables)`);
    }
    db.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 15000;');
  } catch (e) { db.close(); throw e; }
  const q: Stmts = {
    row: db.prepare('SELECT content, mtime_ms, seq FROM files WHERE rel = ?'),
    gt: db.prepare('SELECT rel FROM files WHERE rel > ? AND rel < ? ORDER BY rel LIMIT 1'),
    ge: db.prepare('SELECT rel FROM files WHERE rel >= ? AND rel < ? ORDER BY rel LIMIT 1'),
    dirStat: db.prepare('SELECT MAX(mtime_ms) AS m, MAX(seq) AS s, COUNT(*) AS n FROM files WHERE rel > ? AND rel < ?'),
    under: db.prepare('SELECT rel, seq FROM files WHERE rel > ? AND rel < ? ORDER BY rel'),
    put: db.prepare('INSERT INTO files (rel, content, mtime_ms, seq) VALUES (?, ?, ?, ?) ON CONFLICT(rel) DO UPDATE SET content = excluded.content, mtime_ms = excluded.mtime_ms, seq = excluded.seq'),
    keep: db.prepare('INSERT INTO change_files (seq, rel, content) VALUES (?, ?, ?)'),
    change: db.prepare('INSERT INTO changes (at, message) VALUES (?, ?)'),
    head: db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM changes'),
  };
  open = { root: path.resolve(root), realRoot: fs.realpathSync(root), dbPath, db, q };
  const why = create ? '' : storeProblem();
  if (why) { closeSqliteBoard(); throw new Error(`${dbPath}: ${why}`); }
  return open;
}
/** Why the open store cannot stand for the board at its root, or '': no files, no recorded import, another checkout's,
 *  the checkout on another branch or off the imported history, or no export repo of its own. */
export function storeProblem(): string {
  if (fileCount() === 0) return 'the store holds no board files (fill it once with board-store import)';
  const missing = IMPORT_META.filter((k) => !meta(k));
  if (missing.length) return `the store has no recorded import (${missing.join(', ')} missing)`;
  if (meta('root') !== open!.realRoot) return `the store was imported from ${meta('root')}, not ${open!.realRoot}`;
  let branch = ''; try { branch = gitIn(open!.realRoot, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return 'the checkout has no readable HEAD'; }
  if (meta('branch') !== branch) return `the store was imported on branch ${meta('branch')}, the checkout is on ${branch}`;
  try { gitIn(open!.realRoot, ['merge-base', '--is-ancestor', meta('head')!, 'HEAD']); } catch { return `the checkout's HEAD does not descend from the imported commit ${meta('head')}`; }
  const dir = meta('export_repo')!;
  let bare = '', gitDir = '';
  try { bare = gitIn(dir, ['rev-parse', '--is-bare-repository']); gitDir = fs.realpathSync(gitIn(dir, ['rev-parse', '--absolute-git-dir'])); } // not-board: export repo
  catch { return `the export repo ${dir} is missing or not a git repo`; }
  if (bare !== 'true' || gitDir !== dir) return `the export repo ${dir} is not a bare git repo`;
  const id = readMarker(dir);
  if (id !== meta('db_id')) return `the export repo ${dir} belongs to ${id ? `store ${id}` : 'no store'}, not this one (${meta('db_id')})`;
  let headRef = ''; try { headRef = gitIn(dir, ['symbolic-ref', 'HEAD']); } catch { /* detached */ }
  return headRef === exportRef() ? '' : `the export repo's HEAD is ${headRef || 'detached'}, not ${exportRef()}`;
}
const markerFile = (dir: string) => path.join(dir, 'board-store-db');
function readMarker(dir: string): string { try { return fs.readFileSync(markerFile(dir), 'utf8').trim(); } catch { return ''; } } // not-board: export repo marker
export function closeSqliteBoard(): void { open?.db.close(); open = null; }
export function sqliteBoard(): SqliteBoard | null { return open; }
/** Is the open store the one for this board root? (A process may touch other checkouts, tests do: those stay on git.) */
export function storeFor(root: string): boolean {
  if (!open) return false;
  const r = path.resolve(root);
  return r === open.root || r === open.realRoot;
}

/** Repo-relative path of a board path under the open root's data/ (not data/decisions/), or null (node:fs answers). */
export function relOf(p: fs.PathLike): string | null {
  if (!open) return null;
  const abs = path.resolve(p instanceof URL ? p.pathname : String(p));
  for (const base of [open.root, open.realRoot]) {
    const r = path.relative(base, abs).split(path.sep).join('/');
    if (r === 'data' || (r.startsWith('data/') && r !== 'data/decisions' && !r.startsWith('data/decisions/'))) return r;
  }
  return null;
}

const sysErr = (code: string, errno: number, msg: string, syscall: string, p: string) =>
  Object.assign(new Error(`${code}: ${msg}, ${syscall} '${p}'`), { code, errno, syscall, path: p });
type Row = { content: Uint8Array; mtime_ms: number; seq: number };
const row = (rel: string): Row | undefined => open!.q.row.get(rel) as Row | undefined;
/** `rel/` < every descendant < `rel0` ('0' is the byte after '/'). */
const range = (rel: string): [string, string] => [`${rel}/`, `${rel}0`];
const isDirRel = (rel: string): boolean => rel === 'data' || !!open!.q.gt.get(...range(rel));
/** node:fs says ENOTDIR when an ancestor is a file (`card.md/x`), ENOENT otherwise. */
function missing(syscall: string, rel: string, p: string): Error {
  for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) if (row(rel.slice(0, i))) return sysErr('ENOTDIR', -20, 'not a directory', syscall, p);
  return sysErr('ENOENT', -2, 'no such file or directory', syscall, p);
}

export function readFile(rel: string, p: string): Buffer {
  const r = row(rel);
  if (r) return Buffer.from(r.content);
  if (isDirRel(rel)) throw sysErr('EISDIR', -21, 'illegal operation on a directory', 'read', p);
  throw missing('open', rel, p);
}
/** The names directly in a folder, sorted: one indexed lookup per name, not one per file below it. */
export function readDir(rel: string, p: string): { name: string; dir: boolean }[] {
  if (row(rel)) throw sysErr('ENOTDIR', -20, 'not a directory', 'scandir', p);
  const [lo, hi] = range(rel);
  const out: { name: string; dir: boolean }[] = [];
  let r = open!.q.gt.get(lo, hi) as { rel: string } | undefined;
  while (r) {
    const rest = r.rel.slice(lo.length); const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    out.push({ name, dir: slash >= 0 });
    // past a file: the next row; past a folder: from `name0` on, after every `name/…`
    r = (slash < 0 ? open!.q.gt.get(r.rel, hi) : open!.q.ge.get(`${lo}${name}0`, hi)) as { rel: string } | undefined;
  }
  if (!out.length && rel !== 'data') throw missing('scandir', rel, p);
  return out;
}
export function exists(rel: string): boolean { return !!row(rel) || isDirRel(rel); }
/** A node:fs Stats look-alike (isFile, isDirectory, size, mtime(Ms), ino). A folder's mtime and ino are the newest of
 *  its files', so a cache keyed on a folder's stat sees every write under it. */
export function stat(rel: string, p: string): fs.Stats {
  const r = row(rel);
  let dir = false; let mtimeMs = 0; let ino = 0;
  if (r) { mtimeMs = Number(r.mtime_ms); ino = Number(r.seq); }
  else {
    const d = open!.q.dirStat.get(...range(rel)) as { m: number | null; s: number | null; n: number };
    if (!Number(d.n) && rel !== 'data') throw missing('stat', rel, p);
    dir = true; mtimeMs = Number(d.m ?? 0); ino = Number(d.s ?? 0);
  }
  const t = new Date(mtimeMs);
  return {
    isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false, isFIFO: () => false, isSocket: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, size: r ? r.content.byteLength : 0,
    mtimeMs, mtime: t, ctimeMs: mtimeMs, ctime: t, atimeMs: mtimeMs, atime: t, birthtimeMs: mtimeMs, birthtime: t,
    dev: 0, ino, mode: dir ? 0o40755 : 0o100644, nlink: 1, uid: 0, gid: 0, rdev: 0, blksize: 4096, blocks: 0,
  } as unknown as fs.Stats;
}

/** The newest change number (0 before any write). */
export function headSeq(): number { return Number((open!.q.head.get() as { s: number }).s); }
/** Every file under a folder (`data/tasks`), sorted, with the change that last wrote it (0 = imported). */
export function listUnder(rel: string): { rel: string; seq: number }[] {
  return (open!.q.under.all(...range(rel)) as { rel: string; seq: number }[]).map((r) => ({ rel: r.rel, seq: Number(r.seq) }));
}

/** A write whose `expect` bytes no longer match (write.ts answers 409). */
export class StoreConflict extends Error {}
/** Write board files in one transaction and keep the change for the export. `expect`: rel -> bytes the caller based its
 *  change on; a mismatch throws StoreConflict and writes nothing. Returns the new change number. */
export function commit(files: { rel: string; content: string | Buffer }[], message: string, expect: Record<string, Buffer | string> = {}): number {
  const { db, q } = open!;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const f of files) if (Object.hasOwn(expect, f.rel)) {
      const r = row(f.rel);
      if (!r || !Buffer.from(r.content).equals(Buffer.from(expect[f.rel]))) throw new StoreConflict(`${f.rel} changed while this write was prepared; re-read it and retry`);
    }
    const now = Date.now();
    const seq = Number(q.change.run(new Date(now).toISOString(), message).lastInsertRowid);
    // the last content of a rel named twice wins, as on disk
    for (const [rel, b] of new Map(files.map((f) => [f.rel, Buffer.from(f.content)]))) { q.put.run(rel, b, now, seq); q.keep.run(seq, rel, b); }
    db.exec('COMMIT');
    return seq;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function meta(k: string): string | null { return (open!.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v ?? null; }
const setMeta = (k: string, v: string) => open!.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, v);
export function fileCount(): number { return Number((open!.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n); }

/** Fill an empty store from the checkout's committed data/ files (`rels`, all clean: bin/board-store.ts checks), after
 *  making the store's export repo (`<db folder>/export.git`). The files and the import's meta are one transaction: an
 *  import either completed or left an empty store (and maybe its own clone, which the next import of this db redoes).
 *  A symlink anywhere on a board path would pull outside bytes into the store and, on export, into git: refused. */
export function importFromDisk(rels: string[], at: { branch: string; head: string }): number {
  const { db, realRoot } = open!;
  if (fileCount() > 0) throw new Error('the store already has files; import refused');
  const linked = rels.filter((rel) => rel.split('/').some((_, i, parts) => {
    try { return fs.lstatSync(path.join(realRoot, ...parts.slice(0, i + 1))).isSymbolicLink(); } catch { return false; } // not-board: import reads the checkout
  }));
  if (linked.length) throw new Error(`board paths through a symlink: ${linked.slice(0, 5).join(', ')}; import refused, nothing made`);
  const exportDir = makeExportRepo(path.join(path.dirname(path.resolve(open!.dbPath)), 'export.git'), at);
  db.exec('BEGIN IMMEDIATE');
  try {
    const put = db.prepare('INSERT INTO files (rel, content, mtime_ms, seq) VALUES (?, ?, ?, 0)');
    for (const rel of rels) {
      const fd = fs.openSync(path.join(realRoot, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); // not-board: import reads the checkout
      try { put.run(rel, fs.readFileSync(fd), Math.floor(fs.fstatSync(fd).mtimeMs)); } finally { fs.closeSync(fd); }
    }
    setMeta('root', realRoot); setMeta('branch', at.branch); setMeta('head', at.head);
    setMeta('export_repo', exportDir); setMeta('export_branch', at.branch); setMeta('export_head', at.head);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return fileCount();
}
/** Clone the checkout bare into `dir`, its export branch at the checkout's HEAD and HEAD naming it, marked with this
 *  db_id: built in a temp folder and renamed into place, so `dir` is a whole clone or absent. An existing `dir` is
 *  refused unless it is this store's own (an import that stopped before its transaction). Returns the real path. */
function makeExportRepo(dir: string, at: { branch: string; head: string }): string {
  const dbId = meta('db_id')!;
  if (fs.existsSync(dir)) { // not-board: export repo
    const id = readMarker(dir);
    if (id !== dbId) throw new Error(`${dir} already exists and is not this store's export repo; give each db its own folder; nothing imported`);
    fs.rmSync(dir, { recursive: true, force: true }); // not-board: this store's own clone, left by an import that stopped
  }
  const tmp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true }); // not-board: export repo
  try {
    gitIn(path.dirname(tmp), ['clone', '--quiet', '--bare', open!.realRoot, tmp]);
    for (const k of ['user.name', 'user.email']) {
      let v = ''; try { v = gitIn(open!.realRoot, ['config', '--get', k]); } catch { continue; }
      if (v) gitIn(tmp, ['config', k, v]);
    }
    gitIn(tmp, ['update-ref', `refs/heads/${at.branch}`, at.head]);
    gitIn(tmp, ['symbolic-ref', 'HEAD', `refs/heads/${at.branch}`]);
    fs.writeFileSync(markerFile(tmp), dbId + '\n'); // not-board: export repo marker
    fs.renameSync(tmp, dir); // not-board: export repo
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; } // not-board: export repo
  return fs.realpathSync(dir);
}
/** The store's export repo (real path), or null before an import. */
export const exportRepo = (): string | null => meta('export_repo');
/** The ref the export moves in the export repo. */
export const exportRef = (): string => `refs/heads/${meta('export_branch')}`;

export function pendingCount(): number { return Number((open!.db.prepare('SELECT COUNT(*) AS n FROM changes WHERE exported = 0').get() as { n: number }).n); }
/** Every rel and its bytes (compare). */
export function allFiles(): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const r of open!.db.prepare('SELECT rel, content FROM files ORDER BY rel').all() as { rel: string; content: Uint8Array }[]) out.set(r.rel, Buffer.from(r.content));
  return out;
}
