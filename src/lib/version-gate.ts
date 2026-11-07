// Makes the gate card of a ready version (docs/versions.md). The server's tick calls this; it holds the board's write
// lock, reads the files as they are now and uses a fixed card id, so any number of callers make the card once.
import { loadBoard } from './load.ts';
import type { Task } from './schema.ts';
import { gateCard, versionRows, versionStatus, type VersionStatus } from './version-mode.ts';
import { createTask, withRepoLock, type CreateOpts } from './write.ts';

/** Goals whose version is ready and has no gate card yet: a cheap read of the loaded board, before any lock. */
export const gatesDue = (b: Parameters<typeof versionRows>[0]): VersionStatus[] => versionRows(b).filter((s) => s.ready && !s.gate_card);

/** The new gate card, or null when none was due. Without intake options, so the limit never turns it into an idea. */
export function makeGate(root: string, goal: string, now = new Date()): Task | null {
  return withRepoLock(root, () => {
    const b = loadBoard(root);
    const g = b.goals.find((x) => x.id === goal);
    const s = g ? versionStatus(g, b.tasks) : null;
    if (!g || !s?.ready || s.gate_card) return null;
    const opts: CreateOpts = {};
    const t = createTask(root, gateCard(s, g.owner), 'board', now, opts);
    return opts.replayed ? null : t;
  });
}
