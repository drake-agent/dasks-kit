// Claim-time touches check: a claim that asks for it (`exclusive_touches: true`, which the runner sends) is refused when
// a card already being worked in the same repo touches an overlapping path. It runs on the board, under the repo lock,
// so two runners on different machines cannot both start overlapping cards.
import path from 'node:path';
import { expandHome } from './config.ts';
import { HttpError } from './write.ts';
import { readSpecUnlocked } from './specs.ts';
import { parseTouches, touchesOverlap, touchesValue } from './touches.ts';
import type { Project } from './config.ts';
import type { Task } from './schema.ts';

/** The repo a project's cards change: its configured checkout, else the project itself. */
export function repoKey(goal: string, projects: Project[]): string {
  const repo = projects.find((p) => p.id === goal)?.repo?.trim();
  return repo ? 'repo:' + path.resolve(expandHome(repo)) : 'project:' + goal;
}

/** The `touches:` paths of a card: its current spec, else its board body. */
export function touchesOf(root: string, t: Pick<Task, 'id' | 'body'>): string[] {
  let text = t.body || '';
  try { text = readSpecUnlocked(root, t.id).text; } catch { /* no spec: the body */ }
  return parseTouches(touchesValue(text));
}

/** Throws 409 when `card` overlaps a claimed doing card in the same repo. Call it under the repo lock. */
export function assertTouchesFree(root: string, card: Task, tasks: Task[], projects: Project[]): void {
  const mine = touchesOf(root, card);
  if (!mine.length) return;
  const key = repoKey(card.goal, projects);
  for (const o of tasks) {
    if (o.id === card.id || o.status !== 'doing' || !o.claimed_by || repoKey(o.goal, projects) !== key) continue;
    if (touchesOverlap(mine, touchesOf(root, o)))
      throw new HttpError(409, `touches overlap ${o.id}, which ${o.claimed_by} is working in the same repo`, { rule: 'touches', with: o.id, claimed_by: o.claimed_by });
  }
}
