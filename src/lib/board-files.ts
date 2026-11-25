// Board files (docs/storage.md): the one door to the board's git-tracked data/ files. Every read, list, stat and write
// of a file under <root>/data/ (not the gitignored data/decisions/) goes through here, so the store behind the board can
// change in one place. The calls mirror node:fs: same arguments, same return values, same ENOENT/ENOTDIR errors, so a
// caller changes `fs.readFileSync(p)` to `boardFiles.readFileSync(p)` and nothing else. A path that is not a board file
// (run/, config.json, a log) passes straight through to node:fs.
//
// Store `git` (the default): plain node:fs for reads. Writes go through write.ts commitFiles inside withRepoLock.
// Store `sqlite` (config store.mode): a path under the opened board's data/ is answered from src/lib/board-sqlite.ts;
// commitFiles and withRepoLock switch themselves for that root.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './board-sqlite.ts';

export type BoardBackend = 'git' | 'sqlite';
let backend: BoardBackend = 'git';
/** Which store answers (set once at start from config store.mode; `sqlite` needs openSqliteBoard first). */
export function setBoardBackend(b: BoardBackend): void {
  if (b === 'sqlite' && !store.sqliteBoard()) throw new Error('sqlite store: open it first (openSqliteBoard)');
  backend = b;
}
export function boardBackend(): BoardBackend { return backend; }
/** The store's rel for a board path in sqlite mode, else null (node:fs answers). */
const rel = (p: unknown): string | null => backend === 'sqlite' && (typeof p === 'string' || p instanceof URL) ? store.relOf(p) : null;
const encodingOf = (o: unknown): BufferEncoding | null => (typeof o === 'string' ? o : (o as { encoding?: BufferEncoding } | undefined)?.encoding ?? null) as BufferEncoding | null;
const dirent = (name: string, dir: boolean, parent: string) => ({
  name, parentPath: parent, path: parent, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false,
  isFIFO: () => false, isSocket: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
}) as unknown as fs.Dirent;

// Each call is typed as its node:fs twin (`typeof fs.X`), so every overload and return type carries over unchanged.
/** fs.readFileSync of a board file. */
export const readFileSync: typeof fs.readFileSync = ((p: any, o?: any) => {
  const r = rel(p); if (r === null) return fs.readFileSync(p, o);
  const b = store.readFile(r, String(p)); const enc = encodingOf(o);
  return enc && enc !== ('buffer' as BufferEncoding) ? b.toString(enc) : b;
}) as any;
/** fs.readdirSync of a board folder (names, or Dirents with withFileTypes). */
export const readdirSync: typeof fs.readdirSync = ((p: any, o?: any) => {
  const r = rel(p); if (r === null) return fs.readdirSync(p, o);
  const ents = store.readDir(r, String(p));
  return (o as { withFileTypes?: boolean } | undefined)?.withFileTypes ? ents.map((e) => dirent(e.name, e.dir, path.resolve(String(p)))) : ents.map((e) => e.name);
}) as any;
/** fs.existsSync of a board path. */
export const existsSync: typeof fs.existsSync = (p) => { const r = rel(p); return r === null ? fs.existsSync(p) : store.exists(r); };
/** fs.statSync of a board path (size, mtime, isDirectory, isFile; `throwIfNoEntry: false` honoured). */
export const statSync: typeof fs.statSync = ((p: any, o?: any) => {
  const r = rel(p); if (r === null) return fs.statSync(p, o);
  try { return store.stat(r, String(p)); } catch (e: any) { if (e.code === 'ENOENT' && o?.throwIfNoEntry === false) return undefined; throw e; }
}) as any;

/** sqlite mode for this root: the store's head (`sqlite:<seq>`, moves on every write), else null (read git as before).
 *  For the readers that read committed board files from git (spec-state.ts) and the decisions witness. */
export function storeHead(root: string): string | null { return backend === 'sqlite' && store.storeFor(root) ? `sqlite:${store.headSeq()}` : null; }
/** Where the board's git history is: in sqlite mode the store's export repo (the checkout's data/ commits stop at the
 *  import), else `root`. For the git-history readers (digest.ts, the decisions witness). */
export function historyRoot(root: string): string { return storeHead(root) === null ? root : store.exportRepo() ?? root; }
/** sqlite mode: files under a folder (`data/tasks`) with the change that last wrote each. */
export const storeList = (relDir: string) => store.listUnder(relDir);
