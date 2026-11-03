// Todo intake report: who and what fills the todo column. Read-only,
// over status todo tasks: counts by goal, creator (the task's owner), id family (first two slug tokens) and spec state,
// plus how many were created in the last 24 hours. GET /api/intake, `dasks intake`.
import type { Board, Task } from './schema.ts';

export interface IntakeReport {
  total: number;
  by_goal: Record<string, number>;
  by_creator: Record<string, number>;
  by_id_family: Record<string, number>;
  by_spec_state: Record<string, number>;
  created_last_24h: number;
}

/** `demo.t-ui-a` → `ui-a`; a one-token slug → that token; no `.t-` → `(other)`. */
export function idFamily(id: string): string {
  const k = id.indexOf('.t-');
  if (k < 0) return '(other)';
  return id.slice(k + 3).split('-').filter(Boolean).slice(0, 2).join('-') || '(other)';
}

/** Counts as an object sorted by count, highest first (then name). */
function counted(names: string[]): Record<string, number> {
  const m = new Map<string, number>();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function intakeReport(board: Pick<Board, 'tasks'>, specFacts: ReadonlyMap<string, { spec_state?: string }>, now: Date): IntakeReport {
  const todo: Task[] = board.tasks.filter((t) => t.status === 'todo');
  const since = now.getTime() - 24 * 3600_000;
  return {
    total: todo.length,
    by_goal: counted(todo.map((t) => t.goal)),
    by_creator: counted(todo.map((t) => String(t.owner ?? '').trim() || '(none)')),
    by_id_family: counted(todo.map((t) => idFamily(t.id))),
    by_spec_state: counted(todo.map((t) => specFacts.get(t.id)?.spec_state || 'none')),
    created_last_24h: todo.filter((t) => { const at = Date.parse(t.created); return Number.isFinite(at) && at >= since && at <= now.getTime(); }).length,
  };
}
