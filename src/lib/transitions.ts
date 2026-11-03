import { ALLOWED_TRANSITIONS, type Status, type Task } from './schema.ts';
import { HttpError } from './write.ts';

export function isEvidence(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2000 && !/[\r\n]/.test(value) &&
    (/^https:\/\/[^\s/]+\/[^\s]+\/pull\/\d+(?:[/?#][^\s]*)?$/.test(value) || /^(?:[^\s]*\/)?RESULT\.md$/.test(value) || /^(?:[^\s]*\/)?[^\s]*\.log(?:\.[\w-]+)?$/.test(value));
}
// A line that is only evidence counts as written (outcomes put their first evidence item on its own line).
// Inside prose, a .log word counts only as a path (has a "/"), so "removed console.log calls" is not evidence.
export function taskEvidence(t: Pick<Task, 'pr' | 'result'>): boolean {
  if (isEvidence(t.pr ?? '')) return true;
  return t.result.split('\n').some((line) => isEvidence(line.trim())
    || line.split(/\s+/).some((w) => isEvidence(w) && (!/\.log(?:\.[\w-]+)?$/.test(w) || w.includes('/'))));
}
export function assertTransition(from: Status | null, next: Pick<Task, 'status' | 'pr' | 'result'>, opts: { reopen?: boolean; forcedClaim?: boolean; humanDone?: boolean } = {}): void {
  const reject = (reason: string): never => { throw new HttpError(409, `transition ${from ?? 'create'} -> ${next.status}: ${reason}`, { rule: 'transition', from, to: next.status }); };
  if (!Object.hasOwn(ALLOWED_TRANSITIONS, next.status)) throw new HttpError(400, `bad status "${next.status}"`);
  if (next.status === 'done' && from !== 'done' && !opts.humanDone && !taskEvidence(next)) reject('done requires a PR URL, log path or RESULT.md path');
  if (from === null || from === next.status) return;
  if (!ALLOWED_TRANSITIONS[from].includes(next.status)) reject('move is not allowed');
  if (from === 'done' && ['todo', 'doing'].includes(next.status) && !opts.reopen && !(opts.forcedClaim && next.status === 'doing')) reject('terminal reopen requires reopen=true (or a forced claim)');
  // Any move out of cancelled is a reopen (review and done too): a stale writer must not revive a card the user cancelled.
  if (from === 'cancelled' && !opts.reopen && !(opts.forcedClaim && next.status === 'doing')) reject('cancelled reopen requires reopen=true (or a forced claim)');
}
