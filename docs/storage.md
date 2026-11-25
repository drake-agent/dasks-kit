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
