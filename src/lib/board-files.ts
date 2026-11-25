// Board files (docs/storage.md): the one door to the board's git-tracked data/ files. Every read, list, stat and write
// of a file under <root>/data/ (not the gitignored data/decisions/) goes through here, so the store behind the board can
// change in one place. The calls mirror node:fs: same arguments, same return values, same ENOENT/ENOTDIR errors, so a
// caller changes `fs.readFileSync(p)` to `boardFiles.readFileSync(p)` and nothing else. A path that is not a board file
// (run/, config.json, a log) passes straight through to node:fs.
//
// Today there is one store, git: plain node:fs for reads. Writes go through write.ts commitFiles inside withRepoLock.
import fs from 'node:fs';

// Each call is typed as its node:fs twin (`typeof fs.X`), so every overload and return type carries over unchanged.
/** fs.readFileSync of a board file. */
export const readFileSync: typeof fs.readFileSync = ((p: any, o?: any) => fs.readFileSync(p, o)) as any;
/** fs.readdirSync of a board folder (names, or Dirents with withFileTypes). */
export const readdirSync: typeof fs.readdirSync = ((p: any, o?: any) => fs.readdirSync(p, o)) as any;
/** fs.existsSync of a board path. */
export const existsSync: typeof fs.existsSync = (p) => fs.existsSync(p);
/** fs.statSync of a board path (size, mtime, isDirectory, isFile). */
export const statSync: typeof fs.statSync = ((p: any, o?: any) => fs.statSync(p, o)) as any;

