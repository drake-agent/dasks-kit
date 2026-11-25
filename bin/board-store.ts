#!/usr/bin/env node
// board-store (docs/storage.md): the SQLite board store next to its data repo.
//   node bin/board-store.ts import  --root R [--db F]             fill an empty store from R's committed data/ files and
//                                                                 clone R bare into the store's export repo
//   node bin/board-store.ts compare --root R [--db F] [--export]  store vs R's data/ files (or, --export, the export
//                                                                 branch's tree), byte for byte; exit 1 on any difference
//   node bin/board-store.ts export  --root R [--db F]             replay pending writes as commits, oldest first, onto the
//                                                                 export branch of the store's own repo (never into R)
//   node bin/board-store.ts status  --root R [--db F]             mode, files, pending writes, export repo
//   node bin/board-store.ts restore --root R [--db F] --from S    put a db copy (a migration's snapshot) back as the store
//                                                                 and the export branch back where that copy left it
// The db is --db, else R's config store.sqlite_path. Every command but import refuses a store that cannot stand for R.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadConfig, storeDbPath } from '../src/lib/config.ts';
import * as store from '../src/lib/board-sqlite.ts';
import * as boardFiles from '../src/lib/board-files.ts';
import { loadBoard } from '../src/lib/load.ts';
import { check } from '../src/lib/check.ts';

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
/** rel -> blob id of the data/ files (or just `rels`) in a commit's tree. */
function treeBlobs(repo: string, rev: string, rels: string[] = ['data/']): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of git(repo, ['ls-tree', '-r', '-z', rev, '--', ...rels]).split('\0')) {
    const tab = e.indexOf('\t'); if (tab < 0) continue;
    const [, type, sha] = e.slice(0, tab).split(' ');
    if (type === 'blob' && !e.slice(tab + 1).startsWith('data/decisions/')) out.set(e.slice(tab + 1), sha);
  }
  return out;
}
/** The store against the export branch's tree (blob ids, nothing checked out). */
export function compareExport(): Diff {
  const repo = store.exportRepo()!; const id = blobIds(repo);
  return diff(store.allFiles(), treeBlobs(repo, store.exportRef()), (b, o) => id(b) === o);
}

const TRAILER = 'Board-Change';
/** What `git commit -m <message> -m <trailer>` stores: trailing spaces cut, blank lines collapsed, none at the ends. */
function commitText(message: string, trailer: string): string {
  const lines = `${message}\n\n${trailer}`.split('\n').map((l) => l.trimEnd());
  return lines.filter((l, i) => l || (i > 0 && lines[i - 1])).join('\n').replace(/^\n+|\n+$/g, '') + '\n';
}
interface Run { repo: string; ref: string; tip: string; index: string; id: (b: Buffer) => string }
/** Commit exactly `files` on the tip through a private index, then move the branch with a compare-and-swap
 *  (`update-ref <ref> <new> <tip>`), so a branch moved by anything else refuses. */
function commitTo(x: Run, files: { rel: string; content: Buffer }[], text: string, env: Record<string, string>): void {
  const idx = { GIT_INDEX_FILE: x.index };
  const entries = files.map((f) => `100644 blob ${git(x.repo, ['hash-object', '-w', '--stdin'], {}, f.content).trim()}\t${f.rel}\0`).join('');
  if (entries) git(x.repo, ['update-index', '-z', '--index-info'], idx, entries);
  const tree = git(x.repo, ['write-tree'], idx).trim();
  const sha = git(x.repo, ['commit-tree', tree, '-p', x.tip], env, text).trim();
  git(x.repo, ['update-ref', '-m', 'board-store export', x.ref, sha, x.tip]);
  x.tip = sha;
}
/** The branch must be where the store left it (meta export_head). One commit past it is accepted only when it is exactly
 *  what this store writes for its next pending change (an export that stopped after moving the branch and before the
 *  store recorded it): same parent, message and trailer, paths and bytes. Anything else refuses, nothing marked. */
function settleTip(x: Run, dbId: string, log: (s: string) => void): void {
  const want = store.meta('export_head')!;
  if (x.tip === want) return;
  const moved = `the export branch ${x.ref} is at ${x.tip}, but this store last exported ${want}`;
  const next = store.pendingChanges(1)[0];
  let parent = ''; try { parent = git(x.repo, ['rev-parse', `${x.tip}^`]).trim(); } catch { /* a root commit */ }
  const raw = git(x.repo, ['cat-file', 'commit', x.tip]);
  const ok = next && parent === want && raw.slice(raw.indexOf('\n\n') + 2) === commitText(next.message, `${TRAILER}: ${dbId}:${next.seq}`)
    && git(x.repo, ['diff-tree', '-r', '-z', '--no-commit-id', '--name-only', want, x.tip]).split('\0').filter(Boolean).every((r) => next.files.some((f) => f.rel === r))
    && (() => { const t = treeBlobs(x.repo, x.tip, next.files.map((f) => f.rel)); return next.files.every((f) => t.get(f.rel) === x.id(f.content)); })();
  if (!ok) throw new Error(`${moved}, and that commit is not this store's next change: something else moved it; nothing exported, every change stays pending`);
  store.markExported(next.seq, x.tip);
  log(`the export branch held change ${next.seq} already (an export stopped after its commit): marked exported`);
}
/** Replay pending changes as commits on the export branch (subject = the change's message, its time as author and
 *  committer date, a `Board-Change: <db-id>:<seq>` trailer), oldest first, until none is pending. First the board check
 *  on the store itself (any error exports nothing). One export at a time (the store's export lock). */
/** A ref lock a git killed mid-update left in the export repo would fail every export (and backup) from then on. Only
 *  this store writes that repo, and the caller holds the export lock, so a lock older than a few seconds is no live
 *  git's: removed. */
function clearStaleRefLocks(x: Run, log: (s: string) => void): void {
  for (const f of [path.join(x.repo, `${x.ref}.lock`), path.join(x.repo, 'packed-refs.lock')]) {
    let age = -1; try { age = Date.now() - fs.statSync(f).mtimeMs; } catch { continue; } // not-board: export repo ref lock
    if (age > 10_000) { fs.rmSync(f, { force: true }); log(`removed a stale ${f} (${Math.round(age / 1000)} s old)`); } // not-board: export repo ref lock
  }
}
export function exportCmd(root: string, log: (s: string) => void = console.log): number {
  const alive = (pid: number) => { try { process.kill(pid, 0); return pid > 0; } catch (k: any) { return k?.code === 'EPERM'; } };
  const held = store.takeExportLock(process.pid, alive);
  if (held) throw new Error(`another export (pid ${held}) is running on this store; nothing written`);
  const repo = store.exportRepo()!;
  const x: Run = { repo, ref: store.exportRef(), tip: '', index: path.join(repo, `board-export.${process.pid}.index`), id: blobIds(repo) };
  const was = boardFiles.boardBackend();
  try {
    boardFiles.setBoardBackend('sqlite');
    const errors = check(loadBoard(root)).errors.map((e) => `${e.file}: ${e.message}`);
    if (errors.length) throw new Error(`the store fails the board check (${errors.length} error(s)); nothing exported, every change stays pending:\n${errors.slice(0, 10).join('\n')}`);
    const dbId = store.meta('db_id')!;
    clearStaleRefLocks(x, log);
    x.tip = git(repo, ['rev-parse', '--verify', x.ref]).trim();
    settleTip(x, dbId, log);
    git(repo, ['read-tree', x.tip], { GIT_INDEX_FILE: x.index });
    let done = 0;
    for (let batch = store.pendingChanges(); batch.length; batch = store.pendingChanges()) for (const c of batch) {
      try { commitTo(x, c.files, commitText(c.message, `${TRAILER}: ${dbId}:${c.seq}`), { GIT_AUTHOR_DATE: c.at, GIT_COMMITTER_DATE: c.at }); }
      catch (e: any) { throw new Error(`change ${c.seq} (${c.message}) could not be committed; it and the later changes stay pending: ${String(e?.stderr || e?.message || e).trim().split('\n').slice(-3).join(' ')}`); }
      store.markExported(c.seq, x.tip);
      done++;
    }
    if (done) try { git(repo, ['-c', 'gc.autoDetach=false', 'gc', '--auto', '--quiet']); } catch { /* the next export tries again */ }
    log(done ? `exported ${done} change(s) to ${repo} ${x.ref}` : 'nothing to export');
    return done;
  } finally { boardFiles.setBoardBackend(was); fs.rmSync(x.index, { force: true }); store.releaseExportLock(process.pid); } // not-board: the export's private index
}

/** Put a db copy back as the store (the board stopped): the copy must be this data repo's store with this export repo,
 *  and the commit it last exported must be on the export branch. The branch goes back to that commit (the old tip is
 *  kept as refs/board-store/before-restore-<time>), so the export resumes from the copy; what was exported after the
 *  copy was made leaves the branch, as it left the db. */
export function restoreCmd(root: string, db: string, from: string): string {
  const tmp = `${db}.restore-${process.pid}`;
  fs.copyFileSync(from, tmp); // not-board: the db copy
  let repo = ''; let ref = ''; let want = '';
  try {
    store.openSqliteBoard(root, tmp);
    repo = store.exportRepo()!; ref = store.exportRef(); want = store.meta('export_head')!;
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; } // not-board: the db copy
  finally { store.closeSqliteBoard(); }
  const tip = git(repo, ['rev-parse', '--verify', ref]).trim();
  try { git(repo, ['merge-base', '--is-ancestor', want, tip]); }
  catch { fs.rmSync(tmp, { force: true }); throw new Error(`the copy last exported ${want}, which is not on ${ref} (${tip}); nothing restored`); } // not-board: the db copy
  const kept = `refs/board-store/before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  git(repo, ['update-ref', kept, tip]);
  for (const f of [`${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true }); // not-board: the replaced db's journal
  fs.renameSync(tmp, db); // not-board: the db
  if (tip !== want) git(repo, ['update-ref', '-m', 'board-store restore', ref, want, tip]);
  return `restored ${from} as ${db}; ${ref} back at ${want.slice(0, 12)} (was ${tip.slice(0, 12)}, kept as ${kept})`;
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, options: { root: { type: 'string' }, db: { type: 'string' }, export: { type: 'boolean' }, from: { type: 'string' } }, allowPositionals: true });
  const cmd = positionals[0];
  if (!['import', 'compare', 'export', 'status', 'restore'].includes(cmd ?? '') || !values.root || (cmd === 'restore' && !values.from)) {
    console.error('usage: board-store.ts import|compare|export|status --root DIR [--db FILE] [--export] | restore --root DIR [--db FILE] --from COPY'); return 2;
  }
  const root = path.resolve(values.root);
  const cfg = loadConfig(root);
  const db = values.db ? path.resolve(values.db) : storeDbPath(cfg);
  if (cmd === 'restore') {
    try { console.log(restoreCmd(root, db, path.resolve(values.from!))); return 0; }
    catch (e: any) { console.error(`board-store restore: ${String(e?.stderr || e?.message || e).trim()}`); return 1; }
  }
  try { store.openSqliteBoard(root, db, { create: cmd === 'import' }); }
  catch (e: any) { console.error(`board-store ${cmd}: ${e?.message ?? e}; nothing written`); return 2; }
  try {
    if (cmd === 'import') { console.log(importCmd(root)); return 0; }
    if (cmd === 'status') { console.log(`mode: ${cfg.store.mode}\ndb: ${db}\nfiles: ${store.fileCount()}\nhead: sqlite:${store.headSeq()}\npending changes: ${store.pendingCount()}\nexport repo: ${store.exportRepo()} ${store.exportRef()} at ${store.meta('export_head')}`); return 0; }
    if (cmd === 'export') { exportCmd(root); return 0; }
    const where = values.export ? 'export branch' : 'data repo';
    const c = values.export ? compareExport() : compare(root);
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
