#!/usr/bin/env node
// board-store (docs/storage.md): the SQLite board store next to its data repo.
//   node bin/board-store.ts import  --root R [--db F]             fill an empty store from R's committed data/ files and
//                                                                 clone R bare into the store's export repo
//   node bin/board-store.ts compare --root R [--db F]             store vs R's data/ files, byte for byte; exit 1 on any
//                                                                 difference
//   node bin/board-store.ts status  --root R [--db F]             mode, files, pending writes, export repo
// The db is --db, else R's config store.sqlite_path. Every command but import refuses a store that cannot stand for R.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadConfig, storeDbPath } from '../src/lib/config.ts';
import * as store from '../src/lib/board-sqlite.ts';

const git = (dir: string, args: string[], env: Record<string, string> = {}, input?: string | Buffer) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], input, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, ...env } });
/** A data repo's board files: git-tracked under data/, without the ledger folder data/decisions/. */
const boardRels = (root: string) => git(root, ['ls-files', '-z', '--', 'data/']).split('\0').filter((r) => r && !r.startsWith('data/decisions/'));
/** Many blobs' bytes by object id, in one `git cat-file --batch`. */
function catBlobs(repo: string, ids: string[]): Buffer[] {
  if (!ids.length) return [];
  const buf = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], { input: ids.join('\n') + '\n', maxBuffer: 2 * 1024 * 1024 * 1024 });
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length;) {
    const nl = buf.indexOf(10, i); const [oid, type, size] = buf.subarray(i, nl).toString('utf8').split(' ');
    if (type !== 'blob') throw new Error(`git object ${oid} is ${type}, not a blob`);
    out.push(Buffer.from(buf.subarray(nl + 1, nl + 1 + Number(size)))); i = nl + 1 + Number(size) + 1;
  }
  return out;
}
/** The git blob id of some bytes in `repo`'s object format (no git process per file). */
function blobIds(repo: string): (b: Buffer) => string {
  const algo = git(repo, ['rev-parse', '--show-object-format']).trim() === 'sha256' ? 'sha256' : 'sha1';
  return (b) => createHash(algo).update(`blob ${b.length}\0`).update(b).digest('hex');
}

/** Fill an empty store with HEAD's bytes of every board file. The data repo must be clean under data/ (ledger aside):
 *  the export branch starts at HEAD. A link or a submodule on a board path is refused (outside bytes into the store). */
export function importCmd(root: string): string {
  const dirty = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', 'data/', ':!data/decisions/']).split('\0').filter(Boolean);
  if (dirty.length) throw new Error(`data/ has uncommitted or untracked files (${dirty.slice(0, 5).map((d) => d.slice(3)).join(', ')}); commit or remove them first; nothing imported`);
  const at = { branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), head: git(root, ['rev-parse', 'HEAD']).trim() };
  const tree = git(root, ['ls-tree', '-r', '-z', at.head, '--', 'data/']).split('\0').filter(Boolean).map((e) => {
    const tab = e.indexOf('\t'); const [mode, , oid] = e.slice(0, tab).split(' '); return { mode, oid, rel: e.slice(tab + 1) };
  }).filter((e) => !e.rel.startsWith('data/decisions/'));
  const odd = tree.filter((e) => e.mode !== '100644' && e.mode !== '100755');
  if (odd.length) throw new Error(`board paths that are links or submodules: ${odd.slice(0, 5).map((e) => e.rel).join(', ')}; import refused, nothing made`);
  const bytes = catBlobs(root, tree.map((e) => e.oid));
  const n = store.importFromDisk(tree.map((e, i) => ({ rel: e.rel, content: bytes[i] })), at);
  return `imported ${n} files from ${root}; export repo ${store.exportRepo()}`;
}

type Diff = { store: number; other: number; onlyStore: string[]; onlyOther: string[]; differ: string[] };
const diff = (rows: Map<string, Buffer>, other: Map<string, string>, same: (b: Buffer, o: string) => boolean): Diff => ({
  store: rows.size, other: other.size,
  onlyStore: [...rows.keys()].filter((r) => !other.has(r)), onlyOther: [...other.keys()].filter((r) => !rows.has(r)),
  differ: [...other.keys()].filter((r) => rows.has(r) && !same(rows.get(r)!, other.get(r)!)),
});
/** The store against the data repo's data/ files on disk, as git would store them (blob ids through the repo's
 *  filters, so line-ending conversion in the working tree is no difference). */
export function compare(root: string): Diff {
  const rels = boardRels(root);
  const here = rels.filter((r) => fs.existsSync(path.join(root, r))); // not-board: the data repo side of the compare
  const ids = here.length ? git(root, ['hash-object', '--stdin-paths'], {}, here.join('\n') + '\n').trim().split('\n') : [];
  const disk = new Map(rels.map((r) => [r, '']));
  here.forEach((r, i) => disk.set(r, ids[i]));
  const id = blobIds(root);
  return diff(store.allFiles(), disk, (b, o) => id(b) === o);
}
function main(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, options: { root: { type: 'string' }, db: { type: 'string' } }, allowPositionals: true });
  const cmd = positionals[0];
  if (!['import', 'compare', 'status'].includes(cmd ?? '') || !values.root) {
    console.error('usage: board-store.ts import|compare|status --root DIR [--db FILE]'); return 2;
  }
  const root = path.resolve(values.root);
  const cfg = loadConfig(root);
  const db = values.db ? path.resolve(values.db) : storeDbPath(cfg);
  try { store.openSqliteBoard(root, db, { create: cmd === 'import' }); }
  catch (e: any) { console.error(`board-store ${cmd}: ${e?.message ?? e}; nothing written`); return 2; }
  try {
    if (cmd === 'import') { console.log(importCmd(root)); return 0; }
    if (cmd === 'status') { console.log(`mode: ${cfg.store.mode}\ndb: ${db}\nfiles: ${store.fileCount()}\nhead: sqlite:${store.headSeq()}\npending changes: ${store.pendingCount()}\nexport repo: ${store.exportRepo()} ${store.exportRef()} at ${store.meta('export_head')}`); return 0; }
    const where = 'data repo';
    const c = compare(root);
    console.log(`store: ${c.store} files\n${where}: ${c.other} data/ files`);
    for (const [label, list] of [['only in store', c.onlyStore], [`only in ${where}`, c.onlyOther], ['bytes differ', c.differ]] as const) {
      console.log(`${label}: ${list.length}`);
      for (const r of list.slice(0, 200)) console.log(`  ${r}`);
    }
    const n = c.onlyStore.length + c.onlyOther.length + c.differ.length;
    console.log(`differing files: ${n}`);
    return n ? 1 : 0;
  } catch (e: any) { console.error(`board-store ${cmd}: ${String(e?.stderr || e?.message || e).trim()}`); return 1; }
  finally { store.closeSqliteBoard(); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv.slice(2)); // not-board: this script
