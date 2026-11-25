// Which store holds the board's data/ files (config store, docs/storage.md), opened once per process.
import { type Config, loadConfig, storeDbPath } from './config.ts';
import { setBoardBackend } from './board-files.ts';
import { fileCount, openSqliteBoard } from './board-sqlite.ts';

/** Open the configured store and point board-files at it; returns the mode. sqlite mode opens without creating: a store
 *  that is missing, empty, unimported or another checkout's throws (nothing created). */
export function useBoardStore(root: string, cfg: Pick<Config, 'store'> = loadConfig(root)): 'git' | 'sqlite' {
  if (cfg.store.mode !== 'sqlite') { setBoardBackend('git'); return 'git'; }
  openSqliteBoard(root, storeDbPath(cfg), { create: false });
  setBoardBackend('sqlite');
  return 'sqlite';
}

/** Server and CLI start: as useBoardStore, but a store that cannot serve the board prints why and the import command
 *  and exits 2, so nothing runs on the stale git files. */
export function openBoardStore(root: string, cfg: Pick<Config, 'store'> = loadConfig(root), quiet = false): 'git' | 'sqlite' {
  try {
    const mode = useBoardStore(root, cfg);
    if (mode === 'sqlite' && !quiet) console.error(`board store: sqlite ${storeDbPath(cfg)} (${fileCount()} files)`);
    return mode;
  } catch (e: any) {
    console.error(`store.mode is sqlite but the store cannot serve this board: ${e?.message ?? e}\nFill a new store once from the data repo:\n  node bin/board-store.ts import --root ${root}`);
    process.exit(2);
  }
}
