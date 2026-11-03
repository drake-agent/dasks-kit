// Dependency-aware "ready" queue. A task lists the tasks it waits on in `depends_on` (comma-separated task ids).
// Ready = status todo, unclaimed, and every dependency is done. A cancelled dependency blocks (BlockedItem.cancelled):
// its work may have landed elsewhere or been abandoned, and the dependant cannot tell, so someone relinks depends_on to
// the successor or drops it. CLOSED (done or cancelled) still means "not open" everywhere else.
// Missing ids stop blocking after stuck.missing_hours (24 h by default), using this card's updated/created age.
// Ranked by how many open tasks it unblocks (transitively), then priority, then age. A task without depends_on is ready
// whenever it is todo.
// The user's push (lib/push.ts) goes above all of that: pushed cards first, oldest push first. Then bug fixes (kind bug)
// before every other card, so a found bug is fixed before new work starts on top of it.
import type { Board, Task } from './schema.ts';
import { DEFAULT_STUCK } from './config.ts';
import { livePush, pushMarker, type Push } from './push.ts';

export function depsOf(t: Pick<Task, 'depends_on'>): string[] {
  return String(t.depends_on ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

export interface ReadyItem { id: string; title: string; goal: string; priority: string; lane: string; kind: string; owner: string; unblocks: number; unblocks_direct: number; depends_on: string[]; missing_ignored?: string[]; pushed?: Push; push_note?: string; spec_state?: string; spec_by?: string | null; milestone?: string }
/** Spec state and the current spec's writer of one task (lib/spec-state.ts). */
export type SpecInfo = (t: Task) => { spec_state: string; spec_by: string | null };
export interface BlockedItem { id: string; title: string; waiting_on: string[]; missing: string[]; cancelled: string[] }

export const CLOSED: ReadonlySet<string> = new Set(['done', 'cancelled']);

export function taskAgeHours(t: Pick<Task, 'updated' | 'created'>, now: Date): number {
  const updated = Date.parse(t.updated);
  const at = Number.isFinite(updated) ? updated : Date.parse(t.created);
  return Number.isFinite(at) ? Math.max(0, (now.getTime() - at) / 3600_000) : 0;
}

export function doingAgeHours(t: Pick<Task, 'started_at' | 'claimed_at' | 'claim_seen' | 'updated' | 'created'>, now: Date): number {
  const at = Math.max(...[t.started_at, t.claimed_at, t.claim_seen].map((s) => Date.parse(s ?? '')).filter(Number.isFinite));
  return Number.isFinite(at) ? Math.max(0, (now.getTime() - at) / 3600_000) : taskAgeHours(t, now);
}

export function readyQueue(board: Pick<Board, 'tasks'>, opts: { goal?: string[] | null; limit?: number; now?: Date; missing_hours?: number; spec?: SpecInfo; requireSpecReady?: boolean } = {}): { ready: ReadyItem[]; blocked: BlockedItem[]; cycles: string[] } {
  const now = opts.now ?? new Date();
  const missingHours = opts.missing_hours ?? DEFAULT_STUCK.missing_hours;
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const open = board.tasks.filter((t) => !CLOSED.has(t.status));
  // reverse edges: dep -> open tasks waiting on it
  const rev = new Map<string, string[]>();
  for (const t of open) for (const d of depsOf(t)) { if (!rev.has(d)) rev.set(d, []); rev.get(d)!.push(t.id); }
  const reach = (id: string): Set<string> => {
    const seen = new Set<string>(); const st = [...(rev.get(id) ?? [])];
    while (st.length) { const x = st.pop()!; if (seen.has(x) || x === id) continue; seen.add(x); st.push(...(rev.get(x) ?? [])); }
    return seen;
  };
  // cycle detection (DFS over open tasks)
  const cycles: string[] = []; const color = new Map<string, number>();
  const dfs = (id: string, pathIds: string[]) => {
    color.set(id, 1);
    for (const d of depsOf(byId.get(id) ?? {} as Task)) {
      const dt = byId.get(d); if (!dt || CLOSED.has(dt.status)) continue;
      if (color.get(d) === 1) cycles.push([...pathIds.slice(pathIds.indexOf(d)), d].join(' -> '));
      else if (!color.get(d)) dfs(d, [...pathIds, d]);
    }
    color.set(id, 2);
  };
  for (const t of open) if (!color.get(t.id)) dfs(t.id, [t.id]);
  const goalOk = (t: Task) => !opts.goal || opts.goal.includes(t.goal);
  const ready: ReadyItem[] = []; const blocked: BlockedItem[] = [];
  for (const t of open) {
    if (!goalOk(t)) continue;
    const deps = depsOf(t);
    const absent = deps.filter((d) => !byId.has(d));
    const missingIgnored = taskAgeHours(t, now) >= missingHours ? absent : [];
    const missing = missingIgnored.length ? [] : absent;
    const waiting = deps.filter((d) => byId.has(d) && !CLOSED.has(byId.get(d)!.status));
    const cancelled = deps.filter((d) => byId.get(d)?.status === 'cancelled');
    if (missing.length || waiting.length || cancelled.length) { if (t.status === 'todo') blocked.push({ id: t.id, title: t.title, waiting_on: waiting, missing, cancelled }); continue; }
    // spec-rework: the card's owner fixes the card first (src/lib/park.ts); a spec that turns ready or a reset puts it back.
    if (t.status !== 'todo' || t.claimed_by || t.lane === 'spec-rework') continue;
    const push = livePush(t);
    const spec = opts.spec?.(t);
    ready.push({ id: t.id, title: t.title, goal: t.goal, priority: t.priority, lane: t.lane, kind: t.kind, owner: t.owner, unblocks: reach(t.id).size, unblocks_direct: (rev.get(t.id) ?? []).length, depends_on: deps,
      ...(missingIgnored.length ? { missing_ignored: missingIgnored } : {}),
      ...(push ? { pushed: push, push_note: pushMarker(push) } : {}), ...(spec ?? {}),
      milestone: t.milestone });
  }
  const created = (id: string) => byId.get(id)?.created ?? '';
  const pushAt = (r: ReadyItem) => (r.pushed ? Date.parse(r.pushed.at) : Infinity);
  const bug = (r: ReadyItem) => Number(r.kind === 'bug');
  ready.sort((a, b) => Number(!!b.pushed) - Number(!!a.pushed) || (a.pushed && b.pushed ? pushAt(a) - pushAt(b) : 0) || bug(b) - bug(a) || b.unblocks - a.unblocks || a.priority.localeCompare(b.priority) || created(a.id).localeCompare(created(b.id)));
  // Strict mode: only specs in state ready, filtered before the limit. Opt-in here (/api/start); GET /api/ready turns it on
  // unless ?all=1 or ?require_spec_ready=0.
  const shown = opts.requireSpecReady ? ready.filter((r) => r.spec_state === 'ready') : ready;
  return { ready: opts.limit ? shown.slice(0, opts.limit) : shown, blocked, cycles };
}
