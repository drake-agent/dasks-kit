// Project status (docs/api.md#project-status): where each project stands, read-only. Counts by status, what is in
// progress, what is blocked and on whom, what finished lately, and the version's progress when version mode is on.
// Pure: the server hands in the board, the stuck report and when each done card closed. No file read, no write.
import type { Board, Goal, Task } from './schema.ts';
import { CLOSED, doingAgeHours, taskAgeHours } from './ready.ts';
import type { StuckItem, StuckReason, StuckReport } from './stuck.ts';
import { versionStatus } from './version-mode.ts';

/** List caps: a longer list is cut and its `*_rest` says how many were left out. */
export const STATUS_CAPS = { in_progress: 10, blocked: 10, recent_done: 5 };
/** "Recent done" looks back this many days. */
export const RECENT_DAYS = 7;
const COUNTED = ['todo', 'doing', 'review', 'blocked-on-user', 'done', 'cancelled'] as const;
/** Stuck reasons that mean "blocked". An idle todo card is waiting for a builder, not blocked. */
const BLOCKING: ReadonlySet<StuckReason> = new Set(['blocked-user', 'cycle', 'dep-missing', 'dep-open', 'doing-stale', 'review-stale']);

export interface StatusCard { id: string; title: string; status: string }
export interface ProjectStatus {
  app: string; title: string; why: string; as_of: string;
  counts: Record<typeof COUNTED[number], number> & { open: number };
  /** Only when the goal has a valid `version_target` (docs/versions.md). */
  version: { milestone: string; title: string; done: number; total: number; open: number; pct: number; ready: boolean; gate_card: string | null } | null;
  in_progress: (StatusCard & { claimed_by: string; now: string; age_hours: number })[];
  in_progress_rest: number;
  /** `on`: who or what the card waits on: a person for `blocked-user`, the card ids for dependencies, the claim holder
   *  (else the owner) for a stale card. `ask` is the first line of needs_user. */
  blocked: (StatusCard & { reason: StuckReason; on: string[]; ask?: string; age_hours: number })[];
  blocked_rest: number;
  blocked_counts: Partial<Record<StuckReason, number>>;
  recent_done: (StatusCard & { done_at: string })[];
  recent_done_rest: number;
}
export interface StatusInput {
  board: Pick<Board, 'goals' | 'tasks'>;
  stuck: Pick<StuckReport, 'items'>;
  now: Date;
  /** When a done card moved to done (ISO), else null; defaults to its `updated`. */
  doneAt?: (t: Task) => string | null;
}

const hours = (h: number) => Math.round(h * 10) / 10;
const firstLine = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').trim();

function waitsOn(i: StuckItem, t: Task): string[] {
  switch (i.reason) {
    case 'blocked-user': return [t.next_owner?.trim() || 'user'];
    case 'dep-open': return [i.root_blocker];
    case 'dep-missing': return i.missing;
    case 'cycle': return i.cycle;
    default: return [t.claimed_by || t.owner].filter(Boolean);
  }
}

/** One project's status. Throws on an unknown project. */
export function projectStatus(app: string, inp: StatusInput): ProjectStatus {
  const g = inp.board.goals.find((x) => x.id === app);
  if (!g) throw new Error(`no project "${app}"`);
  const tasks = inp.board.tasks.filter((t) => t.goal === app);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const card = (t: Task): StatusCard => ({ id: t.id, title: t.title, status: t.status });

  const counts = { todo: 0, doing: 0, review: 0, 'blocked-on-user': 0, done: 0, cancelled: 0, open: 0 };
  for (const t of tasks) {
    if (t.status in counts) counts[t.status as typeof COUNTED[number]]++;
    if (!CLOSED.has(t.status)) counts.open++;
  }

  const vs = versionStatus(g, inp.board.tasks);
  const version = vs ? {
    milestone: vs.milestone, title: g.milestones.find((m) => m.id === vs.milestone)?.title || vs.milestone,
    done: vs.done, total: vs.total, open: vs.open, pct: vs.total ? Math.round((vs.done / vs.total) * 100) : 0, ready: vs.ready, gate_card: vs.gate_card,
  } : null;

  const active = tasks.filter((t) => t.status === 'doing' || t.status === 'review')
    .map((t) => ({ ...card(t), claimed_by: t.claimed_by ?? '', now: t.now ?? '', age_hours: hours(t.status === 'doing' ? doingAgeHours(t, inp.now) : taskAgeHours(t, inp.now)) }))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'doing' ? -1 : 1) || b.age_hours - a.age_hours || a.id.localeCompare(b.id));

  const stuck = inp.stuck.items.filter((i) => i.goal === app && BLOCKING.has(i.reason) && byId.has(i.id));
  const blocked_counts: Partial<Record<StuckReason, number>> = {};
  for (const i of stuck) blocked_counts[i.reason] = (blocked_counts[i.reason] ?? 0) + 1;
  const blocked = stuck.map((i) => {
    const t = byId.get(i.id)!;
    const ask = i.reason === 'blocked-user' ? firstLine(t.needs_user) : '';
    return { ...card(t), reason: i.reason, on: waitsOn(i, t), ...(ask ? { ask } : {}), age_hours: hours(i.age_hours) };
  }).sort((a, b) => Number(b.reason === 'blocked-user') - Number(a.reason === 'blocked-user') || b.age_hours - a.age_hours || a.id.localeCompare(b.id));

  const since = inp.now.getTime() - RECENT_DAYS * 86_400_000;
  // `updated` moves with every write, so a card not updated in the window cannot have closed in it.
  const done = tasks.filter((t) => t.status === 'done' && Date.parse(t.updated) >= since)
    .map((t) => ({ ...card(t), done_at: (inp.doneAt ? inp.doneAt(t) : null) ?? t.updated }))
    .filter((d) => Date.parse(d.done_at) >= since)
    .sort((a, b) => Date.parse(b.done_at) - Date.parse(a.done_at) || a.id.localeCompare(b.id));

  const C = STATUS_CAPS;
  return {
    app, title: g.title, why: firstLine(g.why ?? ''), as_of: inp.now.toISOString(), counts, version,
    in_progress: active.slice(0, C.in_progress), in_progress_rest: Math.max(0, active.length - C.in_progress),
    blocked: blocked.slice(0, C.blocked), blocked_rest: Math.max(0, blocked.length - C.blocked), blocked_counts,
    recent_done: done.slice(0, C.recent_done), recent_done_rest: Math.max(0, done.length - C.recent_done),
  };
}

export interface StatusRow { app: string; title: string; open: number; doing: number; review: number; waiting: number; todo: number; blocked: number; done_recent: number; version: string | null; version_done: number; version_total: number }
/** One compact row per project, in goal order. */
export function statusRows(inp: StatusInput): StatusRow[] {
  return inp.board.goals.map((g: Goal) => {
    const s = projectStatus(g.id, inp);
    return {
      app: s.app, title: s.title, open: s.counts.open, doing: s.counts.doing, review: s.counts.review, waiting: s.counts['blocked-on-user'], todo: s.counts.todo,
      blocked: s.blocked.length + s.blocked_rest, done_recent: s.recent_done.length + s.recent_done_rest,
      version: s.version?.milestone ?? null, version_done: s.version?.done ?? 0, version_total: s.version?.total ?? 0,
    };
  });
}

const more = (n: number) => (n ? [`  … ${n} more`] : []);
const who = (on: string[]) => (on.length ? ` (on ${on.join(', ')})` : '');

/** The plain-text form of one project, for agents and the CLI. */
export function statusText(s: ProjectStatus): string {
  const c = s.counts, v = s.version;
  return [
    `${s.title} (${s.app}) as of ${s.as_of.slice(0, 16).replace('T', ' ')} UTC`,
    ...(s.why ? [`Why: ${s.why}`] : []),
    `Cards: ${c.open} open · todo ${c.todo} · doing ${c.doing} · review ${c.review} · waiting on a person ${c['blocked-on-user']} · done ${c.done} · cancelled ${c.cancelled}`,
    v ? `Version ${v.title} (${v.milestone}): ${v.done}/${v.total} done (${v.pct}%)${v.ready ? ', ready to judge' : ''}${v.gate_card ? `, gate card ${v.gate_card}` : ''}` : 'Version: no version_target',
    `In progress: ${s.in_progress.length + s.in_progress_rest}`,
    ...s.in_progress.map((t) => `  ${t.status} ${t.id} ${t.title}${t.claimed_by ? ` [${t.claimed_by}]` : ''}${t.now ? ` now: ${t.now}` : ''}`), ...more(s.in_progress_rest),
    `Blocked: ${s.blocked.length + s.blocked_rest}`,
    ...s.blocked.map((b) => `  ${b.reason} ${b.id}${who(b.on)}${b.ask ? `: ${b.ask}` : ` ${b.title}`}`), ...more(s.blocked_rest),
    `Done in the last ${RECENT_DAYS} days: ${s.recent_done.length + s.recent_done_rest}`,
    ...s.recent_done.map((d) => `  ${d.done_at.slice(0, 10)} ${d.id} ${d.title}`), ...more(s.recent_done_rest),
  ].join('\n');
}

/** The plain-text overview of every project. */
export function overviewText(rows: StatusRow[], now: Date): string {
  return [
    `Projects as of ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC (one project: status <app>)`,
    ...rows.map((r) => `  ${r.app}: ${r.open} open · doing ${r.doing} · review ${r.review} · waiting ${r.waiting} · todo ${r.todo} · blocked ${r.blocked} · done ${r.done_recent} in ${RECENT_DAYS}d${r.version ? ` · ${r.version} ${r.version_done}/${r.version_total}` : ''}`),
  ].join('\n');
}

const TEXT = 'text/plain; charset=utf-8';
/** GET /api/status and /api/status/<app> (?format=json|text). A status and a body out; the server sends it. */
export function statusRoute(path: string, q: URLSearchParams, inp: StatusInput): { status: number; body: unknown; type?: string } {
  const format = q.get('format') ?? 'json';
  if (format !== 'json' && format !== 'text') return { status: 400, body: { error: 'format must be json or text' } };
  if (path === '/api/status' || path === '/api/status/') {
    const rows = statusRows(inp);
    return format === 'text' ? { status: 200, body: `${overviewText(rows, inp.now)}\n`, type: TEXT } : { status: 200, body: { as_of: inp.now.toISOString(), projects: rows } };
  }
  const m = /^\/api\/status\/([^/]+)$/.exec(path);
  let app = '';
  try { app = decodeURIComponent(m?.[1] ?? ''); } catch { /* a bad escape: no such project */ }
  const ids = inp.board.goals.map((g) => g.id);
  if (!ids.includes(app)) return { status: 404, body: { error: `no project "${app}" (projects: ${ids.join(', ')})` } };
  const s = projectStatus(app, inp);
  return format === 'text' ? { status: 200, body: `${statusText(s)}\n`, type: TEXT } : { status: 200, body: s };
}
