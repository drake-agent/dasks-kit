// Version mode (docs/versions.md): a goal may name one milestone as its active version (`version_target`). The runner then
// starts only that milestone's cards in the goal, and a finished version gets one card that asks you to judge it. A goal
// without a target, or with one that is not its own milestone, behaves as if this file did not exist.
import { createHash } from 'node:crypto';
import { MAX_ID_LEN, type Board, type Goal, type Task } from './schema.ts';

type Targeted = Pick<Goal, 'id' | 'version_target' | 'milestones'>;

/** The goal's target when it really is one of its milestones, else ''. `dasks check` reports the other case. */
export function versionTarget(g: Targeted): string {
  return g.version_target && g.milestones.some((m) => m.id === g.version_target) ? g.version_target : '';
}
/** Goal id → its valid target; goals without one are absent. */
export function versionTargets(goals: Targeted[]): Map<string, string> {
  return new Map(goals.filter(versionTarget).map((g) => [g.id, versionTarget(g)]));
}

/** Why the runner leaves a card alone, or ''. p0 cards always start; the kit has no card that "unblocks a PR". */
export function versionHold(c: { priority: string; milestone?: string; version_target?: string }): string {
  return c.version_target && c.milestone !== c.version_target && c.priority !== 'p0' ? `not in version ${c.version_target}` : '';
}
/** One `dask runner status` line per goal that has cards held for its version, keyed by goal. */
export function versionHolds(items: { goal: string; priority: string; milestone?: string; version_target?: string }[]): Map<string, string> {
  const held = new Map<string, { target: string; n: number }>();
  for (const c of items) if (versionHold(c)) held.set(c.goal, { target: c.version_target!, n: (held.get(c.goal)?.n ?? 0) + 1 });
  return new Map([...held].map(([goal, h]) => [goal, `version: ${goal} starts only ${h.target}; ${h.n} other card(s) wait`]));
}

// A context write puts the "## Context" block on top of the body, so the marker's "first line" is read past that block.
const CONTEXT_ON_TOP = /^## Context[ \t]*\n[\s\S]*?(?:\n[ \t]*\n|$)/;
const GATE_LINE = /^version_gate:[ \t]*(\S+)[ \t]*$/;
// On a line of its own, or as a whole board note: `- <date> <time> <actor>: launch_gate: <milestone>`.
const LAUNCH_LINE = /^(?:- \S+ \S+ \S+: )?launch_gate:[ \t]*(\S+)[ \t]*$/;

/** The milestone a gate card marks, or ''. */
export function gateOf(body: string | undefined): string {
  const first = (body ?? '').trimStart().replace(CONTEXT_ON_TOP, '').trimStart().split('\n')[0];
  return GATE_LINE.exec(first)?.[1] ?? '';
}
/** The milestone one body line names as its launch gate, or ''. */
export function launchGateOf(line: string): string { return LAUNCH_LINE.exec(line)?.[1] ?? ''; }
const closesAfterGate = (t: Pick<Task, 'body' | 'milestone'>) => (t.body ?? '').split('\n').some((l) => launchGateOf(l) === t.milestone);

export interface VersionStatus { goal: string; milestone: string; total: number; done: number; open: number; ready: boolean; gate_card: string | null }

/** Where a goal's version stands, or null without a valid target. Cancelled cards, launch-gate cards and the gate card are
 *  not counted. Ready: at least one card done and none open. A gate card counts in any status: once made, never again. */
export function versionStatus(g: Targeted, tasks: Pick<Task, 'id' | 'goal' | 'milestone' | 'status' | 'body'>[]): VersionStatus | null {
  const milestone = versionTarget(g);
  if (!milestone) return null;
  const own = tasks.filter((t) => t.goal === g.id);
  const cards = own.filter((t) => t.milestone === milestone && t.status !== 'cancelled' && gateOf(t.body) !== milestone && !closesAfterGate(t));
  const done = cards.filter((t) => t.status === 'done').length;
  const gate = own.find((t) => gateOf(t.body) === milestone);
  return { goal: g.id, milestone, total: cards.length, done, open: cards.length - done, ready: done > 0 && done === cards.length, gate_card: gate?.id ?? null };
}

/** Every goal's version, in goal order. */
export function versionRows(b: Pick<Board, 'goals' | 'tasks'>): VersionStatus[] {
  return b.goals.flatMap((g) => versionStatus(g, b.tasks) ?? []);
}

/** The fixed id of a milestone's gate card: a second create of it can only fail. Very long ids fall back to a hash. */
export function gateCardId(goal: string, milestone: string): string {
  const id = `${goal}.t-version-gate-${milestone.slice(goal.length + 1)}`;
  return id.length <= MAX_ID_LEN ? id : `${goal}.t-version-gate-${createHash('sha256').update(milestone).digest('hex').slice(0, 16)}`;
}

/** The create body of a ready version's gate card: it waits on you, and no runner picks it up (lane none). */
export function gateCard(s: VersionStatus, owner: string): Record<string, string> {
  const m = s.milestone;
  return {
    id: gateCardId(s.goal, m), goal: s.goal, milestone: m, owner, priority: 'p1', kind: 'review', lane: 'none', status: 'blocked-on-user',
    title: `Judge version ${m}: e2e and batch review`, title_en: `Judge version ${m}: e2e and batch review`, title_ko: `버전 ${m} 판단: e2e와 묶음 리뷰`,
    needs_user: `Do the e2e run and the batch review of version ${m} look good to you? If approved, the version counts as accepted and you can name the next one.`,
    body: [`version_gate: ${m}`, '',
      '## Context',
      `What: All ${s.done} card(s) of ${m} are done`,
      'Why: Single cards were reviewed one by one; nobody has yet tried the version as a whole',
      'Do: Run the end-to-end flow on the default branch and review the whole version diff in one pass',
      'Recommend: Add a card to this milestone for each problem before you accept the version',
      'After: Close this card, finish the cards marked launch_gate, and set the next version_target', '',
      '## Done when',
      '- The e2e result is saved and linked here.',
      '- The batch review over the whole version is read, with a card for each problem.',
      '- You have judged the version.', ''].join('\n'),
  };
}
