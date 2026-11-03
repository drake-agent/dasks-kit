import type { Board } from './schema.ts';
import { DEFAULT_STUCK, type StuckConfig } from './config.ts';
import { CLOSED, depsOf, doingAgeHours, taskAgeHours } from './ready.ts';

export const STUCK_REASONS = ['dep-open', 'doing-stale', 'review-stale', 'ready-idle', 'dep-missing', 'cycle', 'blocked-user'] as const;
export type StuckReason = typeof STUCK_REASONS[number];
type Cause = { reason: 'dep-open'; root_blocker: string }
  | { reason: 'dep-missing'; missing: string[]; missing_ignored: string[] }
  | { reason: 'cycle'; cycle: string[] }
  | { reason: 'doing-stale' | 'review-stale' | 'ready-idle' | 'blocked-user' };
export type StuckItem = { id: string; title: string; goal: string; status: string; age_hours: number } & Cause;
export interface StuckReport {
  now: string;
  thresholds: StuckConfig;
  total: number;
  items: StuckItem[];
  counts: Record<StuckReason, number>;
  top: Record<StuckReason, StuckItem[]>;
  unblockers: { id: string; title: string; unblocks: number }[];
}
interface Dependencies { depth: number; root: string; missing: string[]; cycle: string[] }

/** Read-only snapshot. Healthy open cards are omitted. Precedence: user, cycle (including its dependants), missing,
 * open dependency, then stale/idle. Closed dependencies end a chain. Old missing dependencies remain visible warnings
 * even after readyQueue stops treating them as blockers. Doing-stale age uses the latest start, claim or heartbeat;
 * other causes use updated, falling back to created. */
export function stuckReport(board: Pick<Board, 'tasks'>, now = new Date(), opts: Partial<StuckConfig> = {}): StuckReport {
  const thresholds = { ...DEFAULT_STUCK, ...opts };
  const open = board.tasks.filter((t) => !CLOSED.has(t.status));
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const memo = new Map<string, Dependencies>();
  const active = new Set<string>();
  const path: string[] = [];
  const inspect = (id: string): Dependencies => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (active.has(id)) return { depth: 0, root: id, missing: [], cycle: [...path.slice(path.indexOf(id)), id] };
    const t = byId.get(id);
    const result: Dependencies = { depth: 0, root: id, missing: [], cycle: [] };
    if (!t) return result;
    active.add(id); path.push(id);
    for (const d of [...new Set(depsOf(t))].sort()) {
      const dep = byId.get(d);
      if (!dep) { result.missing.push(d); continue; }
      if (CLOSED.has(dep.status)) continue;
      const next = inspect(d);
      result.missing.push(...next.missing);
      if (!result.cycle.length && next.cycle.length) result.cycle = next.cycle;
      if (next.depth + 1 > result.depth || (next.depth + 1 === result.depth && next.root < result.root)) {
        result.depth = next.depth + 1; result.root = next.root;
      }
    }
    path.pop(); active.delete(id);
    result.missing = [...new Set(result.missing)].sort();
    memo.set(id, result);
    return result;
  };
  const items: StuckItem[] = [];
  for (const t of [...open].sort((a, b) => a.id.localeCompare(b.id))) {
    let age_hours = taskAgeHours(t, now);
    const deps = inspect(t.id);
    let cause: Cause | undefined;
    if (t.status === 'blocked-on-user' || t.needs_user.trim()) cause = { reason: 'blocked-user' };
    else if (deps.cycle.length) cause = { reason: 'cycle', cycle: deps.cycle };
    else if (deps.missing.length) {
      // Only direct missing edges can be ignored for this card; each ancestor still waits on its open dependency.
      const missing_ignored = age_hours >= thresholds.missing_hours ? depsOf(t).filter((d) => !byId.has(d)) : [];
      cause = { reason: 'dep-missing', missing: deps.missing, missing_ignored };
    } else if (deps.depth) cause = { reason: 'dep-open', root_blocker: deps.root };
    else if (t.status === 'doing' && doingAgeHours(t, now) > thresholds.doing_hours) {
      cause = { reason: 'doing-stale' }; age_hours = doingAgeHours(t, now);
    }
    else if (t.status === 'review' && age_hours > thresholds.review_hours) cause = { reason: 'review-stale' };
    else if (t.status === 'todo' && !t.claimed_by && age_hours > thresholds.ready_idle_hours) cause = { reason: 'ready-idle' };
    if (cause) items.push({ id: t.id, title: t.title, goal: t.goal, status: t.status, age_hours, ...cause });
  }
  const counts: Record<StuckReason, number> = { 'dep-open': 0, 'doing-stale': 0, 'review-stale': 0, 'ready-idle': 0, 'dep-missing': 0, cycle: 0, 'blocked-user': 0 };
  const top: Record<StuckReason, StuckItem[]> = { 'dep-open': [], 'doing-stale': [], 'review-stale': [], 'ready-idle': [], 'dep-missing': [], cycle: [], 'blocked-user': [] };
  for (const item of items) { counts[item.reason]++; top[item.reason].push(item); }
  for (const reason of STUCK_REASONS) top[reason] = top[reason].sort((a, b) => b.age_hours - a.age_hours || a.id.localeCompare(b.id)).slice(0, thresholds.top_n);

  const reverse = new Map<string, Set<string>>();
  for (const t of open) for (const d of depsOf(t)) {
    const dep = byId.get(d);
    if (!dep || CLOSED.has(dep.status)) continue;
    const dependants = reverse.get(d) ?? new Set<string>();
    dependants.add(t.id);
    reverse.set(d, dependants);
  }
  const unblockers = open.filter((t) => depsOf(t).every((d) => {
    const dep = byId.get(d);
    return dep !== undefined && CLOSED.has(dep.status);
  })).map((t) => {
    const seen = new Set([t.id]); const stack = [...(reverse.get(t.id) ?? [])];
    while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); stack.push(...(reverse.get(id) ?? [])); }
    return { id: t.id, title: t.title, unblocks: seen.size - 1 };
  }).filter((t) => t.unblocks > 0).sort((a, b) => b.unblocks - a.unblocks || a.id.localeCompare(b.id)).slice(0, 3);
  return { now: now.toISOString(), thresholds, total: items.length, items, counts, top, unblockers };
}
