// Fast board reads (docs/api.md): the pure parts of GET /api/tasks ?status=open|all, fields=, limit/cursor, the
// If-None-Match check, and the Accept-Encoding test send() uses for gzip. Without these parameters the reply is the
// plain full task list.
import { type Task, isTaskId } from './schema.ts';

/** status=open: every status a card can still move from. */
export const OPEN_STATUSES = ['todo', 'doing', 'review', 'blocked-on-user'];
/** fields=slim: what a list view needs; never body. */
export const SLIM_FIELDS = ['id', 'title', 'title_ko', 'title_en', 'goal', 'milestone', 'status', 'priority', 'owner', 'lane', 'kind', 'claimed_by', 'version', 'updated', 'pr', 'depends_on', 'spec_state'];
export const MAX_LIMIT = 1000;

/** A comma list: trimmed tokens, empty ones dropped. */
const tokens = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** The task filter (status, lane, goal, milestone, kind, owner; first value wins; `status=` = no filter, only empty
 *  tokens = nothing), plus the status keywords: open = OPEN_STATUSES, all = no status filter. */
export function filterTaskList(tasks: Task[], q: URLSearchParams): Task[] {
  const multi = (k: string) => (q.get(k) ? q.get(k)!.split(',').map((s) => s.trim()).filter(Boolean) : null);
  let status = multi('status');
  if (status?.includes('all')) status = null;
  else if (status?.includes('open')) status = [...new Set(status.flatMap((s) => (s === 'open' ? OPEN_STATUSES : [s])))];
  const f: Record<string, string[] | null> = { status, lane: multi('lane'), goal: multi('goal'), milestone: multi('milestone'), kind: multi('kind'), owner: multi('owner') };
  return tasks.filter((t) => Object.entries(f).every(([k, v]) => !v || v.includes((t as any)[k])));
}

export interface TaskQuery { fields: Set<string> | null; limit: number | null; cursor: string | null }

/** fields (null = full objects), limit and cursor, or {error} for a 400. A cursor is checked even without limit. */
export function parseTaskQuery(q: URLSearchParams): TaskQuery | { error: string } {
  let fields: Set<string> | null = null;
  if (q.has('fields')) {
    fields = new Set(['id']);
    for (const k of tokens(q.get('fields')!)) for (const x of k === 'slim' ? SLIM_FIELDS : [k]) fields.add(x);
  }
  let limit: number | null = null;
  if (q.has('limit')) {
    const s = q.get('limit')!;
    if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > MAX_LIMIT) return { error: `limit must be a whole number from 1 to ${MAX_LIMIT}` };
    limit = Number(s);
  }
  let cursor: string | null = null;
  if (q.has('cursor')) {
    cursor = q.get('cursor')!;
    if (!isTaskId(cursor)) return { error: 'cursor must be a task id (the X-Next-Cursor of the previous page)' };
  }
  return { fields, limit, cursor };
}

/** Only the named keys (id always); keys the object lacks stay out. fields = null: the object as is. */
export function projectTask<T extends Record<string, unknown>>(o: T, fields: Set<string> | null): Partial<T> {
  if (!fields) return o;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) if (fields.has(k)) out[k] = o[k];
  return out as Partial<T>;
}

/** One page: sorted by id (plain string order), the first `limit` ids after `cursor`; next = this page's last id when
 *  more remain, else null. */
export function pageTasks<T extends { id: string }>(list: T[], limit: number, cursor: string | null): { page: T[]; next: string | null } {
  const rest = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).filter((t) => cursor === null || t.id > cursor);
  const page = rest.slice(0, limit);
  return { page, next: rest.length > limit ? page[page.length - 1].id : null };
}

/** RFC 9110 §12.5.3, for gzip only: gzip (any case) or * with a q-value absent or > 0. An explicit gzip;q=0 wins over
 *  everything else; a q-value that is not a number counts as 1. */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  let gzip: boolean | null = null, star = false;
  for (const part of String(header ?? '').split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    const coding = name.toLowerCase();
    if (coding !== 'gzip' && coding !== '*') continue;
    const qp = params.find((p) => /^q\s*=/i.test(p));
    const raw = qp ? qp.replace(/^q\s*=\s*/i, '') : '';
    const v = /^\d*\.?\d+$|^\d+\.$/.test(raw) ? Number(raw) : 1;
    if (coding === 'gzip') { if (v <= 0) return false; gzip = true; } else if (v > 0) star = true;
  }
  return gzip ?? star;
}

/** If-None-Match (a list or *) against our tag, weak comparison (RFC 9110 §13.1.2: W/ prefixes ignored). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const opaque = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => /^"[^"]*"$/.test(opaque(t)) && opaque(t) === opaque(etag));
}
