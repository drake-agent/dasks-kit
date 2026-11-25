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
  the 10-minute full reload stays).

The data repo itself is never written in sqlite mode: its `data/` stays as it was at the import.

### Commands

Each takes `--root R` (the data repo) and the db from `--db F`, else R's `store.sqlite_path`. Only `import` creates
the db file; every other command refuses a store that cannot stand for R (as the server does) and exits 2.

| Command | What it does |
|---|---|
| `node bin/board-store.ts import --root R` | Clone R bare into `<folder of the db>/export.git` (its branch at R's HEAD, marked with the store's id), then fill the empty store with the bytes HEAD holds for R's tracked `data/` files (not `data/decisions/`; git's bytes, so working-tree line-ending filters change nothing) in one transaction with the import's record (R's real path, branch and HEAD). Runs under an import lock. Refuses a store that has files, another import of the same db, an `export.git` already in the folder (never removed), a link or submodule on a board path, and uncommitted or untracked files under `data/`. |
| `node bin/board-store.ts compare --root R` | The store against R's `data/` files on disk, hashed through the repo's filters as git would store them: counts, files only in one side, files whose bytes differ. Exit 1 on any difference. |
| `node bin/board-store.ts status --root R` | Mode, db, files, head, pending changes and the export repo. |

### Switching on

1. Stop the board.
2. `node bin/board-store.ts import --root ~/.dasks/data`, then `compare` (`differing files: 0`).
3. Set `store.mode` to `sqlite` in `config.json` and start the board.
