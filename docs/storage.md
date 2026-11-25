# Board storage

The board keeps its cards, specs, goals, activity and the rest as files under `data/` in the board's data repo
(`~/.dasks/data` by default). `data/decisions/` (the signed decision ledger) is not part of this: it stays a plain file
on disk.

## The one door: src/lib/board-files.ts

Every read, list and stat of a board file in `src/` and `bin/` goes through `src/lib/board-files.ts`. Its calls mirror
node:fs (`readFileSync`, `readdirSync`, `existsSync`, `statSync`): same arguments, same return values, same errors
(`ENOENT`, `ENOTDIR`), so callers catch what they caught before. Writes go through `commitFiles` inside
`withRepoLock` (`src/lib/write.ts`), as before.

`test/board-files-seam.test.ts` keeps it that way. It reads every `src/` and `bin/` file that names a data path
(`'data'`, `"data/…"`, `` `data/…` ``; `data/decisions/` does not count). Each line there that calls a node:fs file
function must either use board-files or end with `// not-board: <why>`: it touches something else, such as `run/`,
`config.json`, a log, `.git`, the ledger, or the git store's own write and recovery steps in `write.ts`.

With the default store (git) board-files is plain node:fs: the board behaves exactly as it did before the door existed.

## The SQLite store (optional)

Every write in git mode takes a lock folder, writes a journal, runs `git add` and `git commit`. On a large board that
is most of a write's time. The SQLite store keeps the same files as rows of one SQLite file instead: a row holds the
file's exact bytes, and a write is one transaction (WAL, `synchronous = FULL`) holding the 409 expect check, the new
rows and one change row with the commit message and the bytes it wrote. It uses `node:sqlite`, built into Node; no
npm dependency.

`config.json`:

```json
{ "store": { "mode": "sqlite", "sqlite_path": "~/.dasks/store/board.db" } }
```

- `store.mode`: `git` (the default; unchanged) or `sqlite`.
- `store.sqlite_path`: the SQLite file, `~` expanded; `""` (the default) = `<Dasks home>/store/board.db`. Its folder
  also holds the store's export repo (`export.git/`), so give each store its own folder.

In sqlite mode the server:

- opens the store at start without creating it, and exits 2 (printing why and the import command) when the file is
  missing, is not a board store, holds no files, has no recorded import, was imported from another data repo, the data
  repo is on another branch or its HEAD does not descend from the imported commit, or the export repo is missing or
  not this store's;
- answers every board read from the store with node:fs semantics (`ENOENT`, `ENOTDIR`, `EISDIR`; a stat's `ino` is the
  change that last wrote the file, a folder's mtime its newest file's);
- writes every `commitFiles` into the store (`sqlite:<seq>`); `withRepoLock` just runs its function (one server
  process, synchronous writes);
- builds the spec index from the store (its head is `sqlite:<seq>`, so the index rebuilds after every write);
- skips the `data/` file watcher, the start-up git recovery and the write journal (nothing edits the store by hand;
  the 10-minute full reload stays);
- reads git history (the digest, the decisions witness history) from the store's export repo; the witness check also
  counts the store's current witness, which may not be exported yet;
- before a schema migration, keeps a copy of the db (`.git/dasks-backups/<time>-schema-<n>.db`) instead of a git
  bundle;
- backs up by exporting first and pushing the export branch (below).

`dasks check`, `dasks-digest` and `bin/verify-decisions.ts` open the configured store the same way (a store that
cannot be used is exit 2, never a pass).

The data repo itself is never written in sqlite mode: its `data/` stays as it was at the import.

### Commands

Each takes `--root R` (the data repo) and the db from `--db F`, else R's `store.sqlite_path`. Only `import` creates
the db file; every other command refuses a store that cannot stand for R (as the server does) and exits 2.

| Command | What it does |
|---|---|
| `node bin/board-store.ts import --root R` | Clone R bare into `<folder of the db>/export.git` (its branch at R's HEAD, marked with the store's id), then fill the empty store with the bytes HEAD holds for R's tracked `data/` files (not `data/decisions/`; git's bytes, so working-tree line-ending filters change nothing) in one transaction with the import's record (R's real path, branch and HEAD). Runs under an import lock. Refuses a store that has files, another import of the same db, an `export.git` already in the folder (never removed), a link or submodule on a board path, and uncommitted or untracked files under `data/`. |
| `node bin/board-store.ts compare --root R [--export]` | The store against R's `data/` files on disk, hashed through the repo's filters as git would store them, or with `--export` the export branch's tree (blob ids, nothing checked out): counts, files only in one side, files whose bytes differ. Exit 1 on any difference. |
| `node bin/board-store.ts export --root R` | Replay pending changes, oldest first, as commits on the export branch (below). Stops at the first failure; that change and the rest stay pending. A ref lock older than 10 s left in the export repo by a killed git is removed first (only this store writes that repo, under its export lock). |
| `node bin/board-store.ts restore --root R --from COPY [--discard-pending]` | With the board stopped: put a db copy (such as the one a schema migration keeps) back as the store, and the export branch back at the commit that copy last exported, so the export resumes. Refuses while the current db holds unexported changes (it says how many) unless `--discard-pending`. The branch moves first, then the current db is kept as `<db>.before-restore-<time>`; a failure at either step leaves the db and the branch as they were. The old branch tip is kept as `refs/board-store/before-restore-<time>`; what was exported after the copy was made leaves the branch, as it left the db (the backup push then refuses until a person decides: it is never forced). Refuses a copy of another store, or one whose last export is not on the branch. |
| `node bin/board-store.ts status --root R` | Mode, db, files, head, pending changes and the export repo. |

### The export

Git sees a sqlite-mode write only after an export. The export writes only the store's export repo
(`<folder of the db>/export.git`, a bare clone the import made: no working tree, no shared index), on its export
branch (the data repo's branch at the import). Under the export lock (one export per store, a dead holder's lock is
taken over):

1. The board check runs on the store itself; any error exports nothing and every change stays pending.
2. The branch must be at the commit the store made last. One commit past it is accepted only when it is exactly the
   commit this store writes for its next pending change (same parent, message, trailer, paths and bytes): an export
   that stopped after moving the branch and before it recorded that. Anything else (a hand commit, another copy of the
   store) refuses, nothing marked.
3. One commit per change, through a private index (`GIT_INDEX_FILE`): `hash-object`, `update-index`, `write-tree`,
   `commit-tree -p <tip>` with the change's message plus `Board-Change: <store id>:<seq>` and the change's time as
   author and committer date, then `update-ref <branch> <new> <tip>` (a compare-and-swap: a branch moved meanwhile
   refuses). The change is marked exported and its kept bytes dropped in one transaction.

With `backup.remote` set, each backup tick runs the export in a child process and then pushes the export branch to the
backup branch, fast-forward only, with the same path checks as in git mode. A failed export is a failed push. The
first push after switching on is a fast-forward of what git mode pushed, since the export branch starts at the data
repo's HEAD.

What lags until the next export: the digest and the witness history (the export repo's), and the backup. Commits made
to the data repo after the import (for example `config.json` changes) are not on the export branch.

### Switching on

1. Stop the board.
2. `node bin/board-store.ts import --root ~/.dasks/data`, then `compare` (`differing files: 0`).
3. Set `store.mode` to `sqlite` in `config.json` and start the board.

### Rollback to git

1. Stop the board, then `node bin/board-store.ts export --root ~/.dasks/data` and `compare --export` (0).
2. Set `store.mode` to `git` (or remove `store`).
3. In the data repo: `git fetch <folder of the db>/export.git <branch>` and `git merge --no-edit FETCH_HEAD`. The export
   commits touch only `data/`, so the merge is clean.
4. `node bin/board-store.ts compare --root ~/.dasks/data`: 0 differing files. Start the board.

### Limits

- One server process writes the store. `dasks-digest` writes through it from its own process (SQLite serializes the
  transactions, and a digest run whose `.last-run` or digest file moved since it read them gives up); nothing else
  should.
- The decisions witness in sqlite mode catches a deleted or cut ledger through the store's witness and the exported
  history. A ledger restored together with an older copy of the db is caught only once the newer witness was exported.
- Losing the db loses the writes since the last export. The export repo (and the backup branch) hold everything up to
  it: merge it into the data repo as in the rollback and import into a new db folder.
