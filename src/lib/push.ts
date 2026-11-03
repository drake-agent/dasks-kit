// The user's push on a todo card ("work this one first"): a task write with `push: true` by the logged-in user.
// Stored as one optional frontmatter line `pushed: "<ISO time> <actor> <lane>"`. readyQueue (`dasks ready`) puts pushed
// cards first, oldest push first. The push lives only while the card waits: it clears when the card leaves
// todo, is claimed, or moves to another lane (src/lib/write.ts updateTask).
import { ACTOR_RE } from './schema.ts';

export interface Push { at: string; by: string; lane: string }

const LANE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function formatPush(p: Push): string { return `${p.at} ${p.by} ${p.lane}`; }

/** The push in a `pushed` value, or null when the value is empty or malformed. */
export function parsePush(v: unknown): Push | null {
  if (typeof v !== 'string' || !v) return null;
  const parts = v.split(' ');
  if (parts.length !== 3) return null;
  const [at, by, lane] = parts;
  if (!TS_RE.test(at) || Number.isNaN(Date.parse(at)) || !ACTOR_RE.test(by) || !LANE_RE.test(lane) || lane === 'none') return null;
  return { at, by, lane };
}

/** The push that still counts for this card: well-formed, the card still todo, unclaimed and on the pushed lane. */
export function livePush(t: { pushed?: string; status: string; lane: string; claimed_by?: string }): Push | null {
  const p = parsePush(t.pushed);
  return p && t.status === 'todo' && !t.claimed_by && t.lane === p.lane ? p : null;
}

/** What `dasks ready` and the MCP ready_tasks text show for a pushed card. */
export const pushMarker = (p: Push): string => `★ user first · ${p.lane}`;
