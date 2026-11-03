// Progress roll-up: milestone % = done / non-cancelled tasks; goal % = mean of milestones;
// north star = mean of goals. A milestone past `due` and < 100% is late.
import { type Board, type Goal, type Milestone, type Task } from './schema.ts';

export interface MilestoneRoll { id: string; pct: number; done: number; total: number; late: boolean; needsDate: boolean }
export interface GoalRoll { id: string; pct: number; milestones: MilestoneRoll[] }
export interface Rollup { pct: number; goals: GoalRoll[] }

export function localDate(now: Date): string {
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function rollMilestone(m: Milestone, tasks: Task[], today: string): MilestoneRoll {
  const mine = tasks.filter((t) => t.milestone === m.id && t.status !== 'cancelled');
  const done = mine.filter((t) => t.status === 'done').length;
  // No tasks: a milestone counts as complete only if it is itself marked done.
  const pct = mine.length ? Math.round((done / mine.length) * 1000) / 10 : m.status === 'done' ? 100 : 0;
  const late = !!m.due && m.due < today && pct < 100;
  const needsDate = !m.due && m.status !== 'done' && pct < 100;
  return { id: m.id, pct, done, total: mine.length, late, needsDate };
}

const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

export function rollGoal(g: Goal, tasks: Task[], today: string): GoalRoll {
  const milestones = g.milestones.map((m) => rollMilestone(m, tasks, today));
  return { id: g.id, pct: mean(milestones.map((m) => m.pct)), milestones };
}

export function rollup(b: Board, now = new Date()): Rollup {
  const today = localDate(now);
  const goals = b.goals.map((g) => rollGoal(g, b.tasks, today));
  return { pct: mean(goals.map((g) => g.pct)), goals };
}
