// Dasks schema constants and types.
import type { Profile } from './profile.ts';

/** The projects of this board (config.json `projects`, set by loadConfig): each must have its goal file. Other goals are
 *  data-driven: every data/goals/<id>.yaml whose id matches GOAL_ID_RE and whose parent is the north star is a goal too.
 *  Use goalIdsOf(board). No project id is built in. */
export let REQUIRED_GOAL_IDS: readonly string[] = [];
/** Project id → owner actor (config.json `projects[].owner`). */
let PROJECT_OWNERS: Record<string, string> = {};
/** Extra lanes from config.json `lanes`. */
export let CONFIG_LANES: readonly string[] = [];
/** Called by loadConfig: the project list and extra lanes of this board. */
export function setProjects(projects: readonly { id: string; owner?: string }[], lanes: readonly string[] = []): void {
  REQUIRED_GOAL_IDS = projects.map((p) => p.id);
  PROJECT_OWNERS = Object.fromEntries(projects.filter((p) => p.owner).map((p) => [p.id, p.owner!]));
  CONFIG_LANES = [...lanes];
}
export const NORTHSTAR_ID = 'north';

/** Built-in lanes: who should pick a card up (claude, codex), nobody yet (none), and the two server-managed lanes. */
export const LANES = ['claude', 'codex', 'none', 'spec-rework', 'failed-terminal', 'live-check'] as const;
export const LANE_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const KINDS = ['impl', 'bug', 'review', 'ui-test', 'computer-use', 'research', 'decision'] as const;
// `cancelled` is not a board column; it exists so roll-up can exclude cancelled work.
export const STATUSES = ['todo', 'doing', 'review', 'done', 'blocked-on-user'] as const;
export const ALL_STATUSES = [...STATUSES, 'cancelled'] as const;
export const ALLOWED_TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  todo: ['doing', 'review', 'cancelled', 'blocked-on-user', 'done'],
  doing: ['todo', 'review', 'done', 'blocked-on-user', 'cancelled'],
  review: ['doing', 'todo', 'done', 'blocked-on-user', 'cancelled'],
  'blocked-on-user': ['todo', 'doing', 'review', 'cancelled', 'done'],
  done: ['todo', 'doing', 'cancelled', 'review'],
  cancelled: ['todo', 'doing', 'review', 'done'],
};
export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export const APPROVALS = ['merge', 'deploy', 'none'] as const;
export const STARTED_BY = ['bot', 'user'] as const;
export const MILESTONE_STATUSES = ['planned', 'active', 'done', 'blocked'] as const;
export const LINK_TYPES = ['feeds', 'blocks', 'shares'] as const;

// Frontmatter key order (also the canonical serialization order).
export const TASK_FIELDS = [
  'id', 'title', 'goal', 'milestone', 'owner', 'lane', 'kind', 'status', 'priority',
  'pr', 'pr_summary', 'result', 'needs_user', 'approvals', 'created', 'updated', 'started_by',
] as const;
// Spec state and Spec blocks: server-only, never client-editable. `spec_review` is a
// mapping and `blocked_spec_version` an integer (kept raw by the loader); the rest are strings.
export const SPEC_TASK_FIELDS = ['spec_state', 'blocked_by', 'blocked_at', 'block_note', 'blocked_spec_version', 'spec_review'] as const;
export const SPEC_STATES = ['none', 'draft', 'ready', 'blocked'] as const;
/** A model family name (`anthropic`, `openai`, or any other vendor a board's config maps actors to). */
export const FAMILY_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const isFamily = (v: unknown): v is string => typeof v === 'string' && FAMILY_RE.test(v);
/** Default model families by name prefix, for actor names (`claude-code@m`, `codex@m`) and for the model names on a card's
 *  impl / review lines (`claude`, `codex`, `gpt-…`). A board's config `families` maps any other actor. */
export const DEFAULT_FAMILY_PREFIXES: [string, string][] = [['claude', 'anthropic'], ['human-claude', 'anthropic'], ['codex', 'openai'], ['human-codex', 'openai'], ['gpt', 'openai']];
/** The family of a name by the longest matching default prefix, or null. */
export function defaultFamily(name: string): string | null {
  return DEFAULT_FAMILY_PREFIXES.filter(([p]) => name.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? null;
}
/** The family of an actor or model name: config `families` exact id → longest configured `prefix*` → longest default
 *  prefix → null (no rule names it). */
export function familyFor(name: string, configured: Record<string, string> = {}): string | null {
  const id = name.trim();
  if (Object.hasOwn(configured, id) && !id.endsWith('*')) return configured[id];
  const cfg = Object.entries(configured).filter(([k]) => k.endsWith('*')).map(([k, v]) => [k.slice(0, -1), v])
    .filter(([p]) => id.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  return cfg ?? defaultFamily(id);
}
export const VERDICTS = ['pass', 'fail'] as const;
export type SpecState = typeof SPEC_STATES[number];
export type Family = string;
export interface SpecReview { spec_version: number; by: string; family: Family; verdict: typeof VERDICTS[number]; at: string }
export const MAX_BLOCK_NOTE_BYTES = 1024;

// Side-by-side fields (all optional, omitted when empty): optimistic `version` (bumped by every server write),
// claim lock `claimed_by` + `claimed_at`. Files without them are version 0 and unclaimed.
// Display titles per language (title_ko / title_en; the UI falls back to `title`) and `idea` (the idea a task was
// promoted from) are optional too.
// `claim_seen`: the claim holder's last own write (the claim lease heartbeat).
// `now` + `now_by` / `now_at` / `now_lint`: the now line, what the agent is doing right now.
const TASK_EXTRA_FIELDS = ['started_at', 'version', 'claimed_by', 'claimed_at', 'claim_seen', 'title_ko', 'title_en', 'idea', 'depends_on', 'next_owner', 'run_id', 'attempt', 'reset_epoch', 'pushed', 'secrets', 'summary', 'summary_by', 'summary_at', 'now', 'now_by', 'now_at', 'now_lint', ...SPEC_TASK_FIELDS] as const;
export const TASK_OPTIONAL_FIELDS = ['pr', ...TASK_EXTRA_FIELDS] as const;
export const TASK_ALL_FIELDS = [...TASK_FIELDS, ...TASK_EXTRA_FIELDS] as const;
/** Languages with their own display title (title_ko, title_en). */
export const LANGS = ['ko', 'en'] as const;
export const MAX_TITLE_LEN = 200;

export const MAX_TASK_BYTES = 4096;
export const MAX_RESULT_LINES = 10;
/** Handoff summary: what the next agent needs, rewritten at every handoff (lib/write.ts normSummary). */
export const MAX_SUMMARY_LINES = 5;
export const MAX_SUMMARY_LINE = 200;
export const MAX_SUMMARY_CHARS = 1000;
/** Now line: one plain line, what the card's agent is doing right now (lib/now-line.ts normNow). */
export const MAX_NOW_CHARS = 120;

// Ids: lowercase, global, stable. `<goal>` | `<goal>.m…` (milestone) | `<goal>.t-…` (task).
export const GOAL_ID_RE = /^[a-z][a-z0-9]{0,23}$/;
export const MILESTONE_ID_RE = /^([a-z][a-z0-9]{0,23})\.(m[a-z0-9]*(?:-[a-z0-9]+)*)$/;
export const TASK_ID_RE = /^([a-z][a-z0-9]{0,23})\.(t-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
export const MAX_ID_LEN = 80;
// Secret labels a card's work needs (names only, never values).
export const SECRET_LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,88}$/;
export const MAX_SECRETS = 8;
// Actor names: automations (`demo-lead`), people (`user`) and agent sessions (`claude-code@my-mac`, `codex@my-mac`).
export const ACTOR_RE = /^[A-Za-z0-9._@-]{1,40}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Lane = typeof LANES[number];
export type Kind = typeof KINDS[number];
export type Status = typeof ALL_STATUSES[number];

export interface Task {
  id: string;
  title: string;
  goal: string;
  milestone: string;
  owner: string;
  lane: Lane;
  kind: Kind;
  status: Status;
  priority: string;
  pr?: string;
  pr_summary: string;
  result: string;
  needs_user: string;
  approvals: string;
  created: string;
  updated: string;
  started_by: string;
  started_at?: string;
  version?: string;
  claimed_by?: string;
  claimed_at?: string;
  claim_seen?: string;
  title_ko?: string;
  title_en?: string;
  idea?: string;
  /** Comma-separated task ids this task waits on (optional; see lib/ready.ts). */
  depends_on?: string;
  next_owner?: string;
  run_id?: string;
  attempt?: string;
  reset_epoch?: string;
  /** The user's push: `<ISO time> <actor> <lane>` (lib/push.ts); readyQueue ranks it first. */
  pushed?: string;
  /** Comma-separated secret labels this card's work needs (names only, never values); see lib/write.ts normSecrets. */
  secrets?: string;
  /** Handoff summary, ≤5 lines; the next agent reads it instead of the whole history. */
  summary?: string;
  /** Who and when the summary was last changed (the server stamps them; not client-writable). */
  summary_by?: string;
  summary_at?: string;
  /** Now line: one line (≤120 chars), what the agent is doing right now; cleared when the card is done or cancelled. */
  now?: string;
  /** Who and when the now line was last changed, and 'log' when it reads like a log line (the server sets all three). */
  now_by?: string;
  now_at?: string;
  now_lint?: string;
  /** Spec state (stored when a spec write, review or block changed it; absent = derived on read, lib/spec-state.ts). */
  spec_state?: string;
  blocked_by?: string;
  blocked_at?: string;
  block_note?: string;
  /** The spec version a block was set at (a number; unknown types stay as found so check() can report them). */
  blocked_spec_version?: unknown;
  /** null or {spec_version, by, family, verdict, at}: the text review (any size) of one spec version. */
  spec_review?: unknown;
  body: string;
  file: string; // repo-relative path
  bytes: number;
}

export interface Milestone {
  id: string;
  title: string;
  title_ko?: string;
  title_en?: string;
  done_criteria: string[];
  due: string;
  status: string;
}

export interface Goal {
  id: string;
  parent: string;
  title: string;
  title_ko?: string;
  title_en?: string;
  why: string;
  owner: string;
  /** GitHub repo URL (https://github.com/owner/name), shown on the project page and in the CLI and MCP. */
  repo?: string;
  /** What the project can do today and what it lacks (lib/profile.ts). Raw as read; `dasks check` validates it. */
  profile?: Profile;
  milestones: Milestone[];
  file: string;
}

export interface NorthStar {
  id: string;
  title: string;
  title_ko?: string;
  title_en?: string;
  why: string;
  horizon: string;
}

export interface Link {
  from: string;
  to: string;
  type: string;
  note: string;
}

export interface Board {
  northstar: NorthStar | null;
  goals: Goal[];
  tasks: Task[];
  links: Link[];
  loadErrors: Issue[];
}

export interface Issue {
  file: string;
  message: string;
}

export function isTaskId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_ID_LEN && TASK_ID_RE.test(id);
}
export function isMilestoneId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_ID_LEN && MILESTONE_ID_RE.test(id);
}
export function goalOf(id: string): string {
  return id.split('.')[0];
}

/** Goal ids of a loaded board: every goal whose id is well-formed and whose parent is the north star. */
export function goalIdsOf(b: Pick<Board, 'goals'>): string[] {
  const ids = [...new Set(b.goals.filter((g) => GOAL_ID_RE.test(g.id) && g.parent === NORTHSTAR_ID).map((g) => g.id))];
  // The configured projects first, in config order; any other goal after them, by id.
  const rank = (id: string) => (REQUIRED_GOAL_IDS.includes(id) ? REQUIRED_GOAL_IDS.indexOf(id) : REQUIRED_GOAL_IDS.length);
  return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Who owns a card: its own owner, else its project's configured owner, else the board's human. */
export function cardOwner(t: Pick<Task, 'owner' | 'goal'>): string {
  return t.owner || PROJECT_OWNERS[t.goal] || 'user';
}
