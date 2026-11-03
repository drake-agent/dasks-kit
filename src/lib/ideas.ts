// "Ideas for later" (Dasks): one idea backlog per project, kept apart from tasks, in data/ideas/<app>.json.
// Agents append ideas and promote one to a task through the API; humans only read them on /p/<app>.
// Every write runs under the repo lock, bumps the idea's version and the file's version, records the actor
// (`added_by` / `updated_by`, the commit message, data/activity/ideas/<app>.jsonl) and is one git commit.
// Promoting creates the task and links both ways (idea.promoted_task_id <-> task.idea) in that same commit.
import fs from 'node:fs';
import path from 'node:path';
import { ACTOR_RE, GOAL_ID_RE, type Issue, type Board, type Task } from './schema.ts';
import { loadGoals } from './load.ts';
import { HttpError, commitFiles, createTask, isoLocal, slugify, withRepoLock } from './write.ts';
import { type Activity, MAX_ACTIVITY } from './collab.ts';
import { assertProject, projectIds } from './views.ts';

export const IDEA_STATUSES = ['open', 'promoted', 'dropped'] as const;
export type IdeaStatus = typeof IDEA_STATUSES[number];
export const IDEA_ID_RE = /^([a-z][a-z0-9]{0,23})\.(i-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
export const MAX_IDEAS = 300;
export const MAX_IDEAS_BYTES = 128 * 1024;
const LIMITS = { title: 120, title_ko: 120, title_en: 120, note: 600, note_ko: 600, note_en: 600, source: 300 } as const;
/** Fields an agent may set when adding an idea, and may change later. */
export const IDEA_TEXT = Object.keys(LIMITS) as (keyof typeof LIMITS)[];

export interface Idea {
  id: string; title: string; title_ko?: string; title_en?: string;
  note: string; note_ko?: string; note_en?: string; source: string;
  added_by: string; added_at: string; status: IdeaStatus;
  promoted_task_id?: string; promoted_at?: string; promoted_by?: string;
  version: number; updated: string; updated_by: string;
}
export interface IdeaFile { app: string; version: number; updated: string; updated_by: string; ideas: Idea[] }

export const ideasRelPath = (app: string): string => {
  if (!GOAL_ID_RE.test(app)) throw new HttpError(404, `no project "${app}"`);
  return path.join('data', 'ideas', `${app}.json`);
};
const activityRel = (app: string) => path.join('data', 'activity', 'ideas', `${app}.jsonl`);

function text(v: unknown, k: keyof typeof LIMITS): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${k} must be a string`);
  // Titles are one line; notes keep their words but not their layout.
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > LIMITS[k]) throw new HttpError(400, `${k} is over ${LIMITS[k]} characters`);
  return s;
}

/** Shape check for one stored idea (used on read and by `dasks check`). */
export function ideaErrors(i: any, app: string): string[] {
  const e: string[] = [];
  if (!i || typeof i !== 'object' || Array.isArray(i)) return ['idea must be an object'];
  const m = IDEA_ID_RE.exec(String(i.id ?? ''));
  if (!m) e.push(`bad idea id "${i.id}" (want ${app}.i-<slug>)`);
  else if (m[1] !== app) e.push(`idea "${i.id}" does not start with "${app}."`);
  if (typeof i.title !== 'string' || !i.title.trim()) e.push(`${i.id}: title is empty`);
  for (const k of IDEA_TEXT) if (i[k] !== undefined && (typeof i[k] !== 'string' || i[k].length > LIMITS[k])) e.push(`${i.id}: bad ${k}`);
  if (!(IDEA_STATUSES as readonly string[]).includes(i.status)) e.push(`${i.id}: bad status "${i.status}"`);
  if (i.status === 'promoted' && !/^[a-z][a-z0-9]{0,23}\.t-/.test(String(i.promoted_task_id ?? ''))) e.push(`${i.id}: promoted without promoted_task_id`);
  if (!ACTOR_RE.test(String(i.added_by ?? ''))) e.push(`${i.id}: bad added_by`);
  if (!Number.isInteger(i.version) || i.version < 1) e.push(`${i.id}: version must be a positive integer`);
  return e;
}

/** The project's ideas (empty, version 0, when the file does not exist yet). 409 for a file that cannot be read. */
export function readIdeas(root: string, app: string): IdeaFile {
  const rel = ideasRelPath(app);
  let raw: string;
  try { raw = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e: any) {
    if (e.code === 'ENOENT') return { app, version: 0, updated: '', updated_by: '', ideas: [] };
    throw e;
  }
  let o: any;
  try { o = JSON.parse(raw); } catch (e: any) { throw new HttpError(409, `${rel} is not valid JSON: ${e.message}`); }
  if (!o || !Array.isArray(o.ideas)) throw new HttpError(409, `${rel} has no ideas list`);
  const errs = o.ideas.flatMap((i: any) => ideaErrors(i, app));
  if (errs.length) throw new HttpError(409, `${rel} is invalid: ${errs.slice(0, 3).join('; ')}`);
  return { app, version: Number.isInteger(o.version) ? o.version : 0, updated: String(o.updated ?? ''), updated_by: String(o.updated_by ?? ''), ideas: o.ideas };
}

export function readIdeaActivity(root: string, app: string, limit = 20): Activity[] {
  let raw = '';
  try { raw = fs.readFileSync(path.join(root, activityRel(app)), 'utf8'); } catch { return []; }
  const out: Activity[] = [];
  for (const l of raw.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out.slice(-limit);
}

/** Counts per project for GET /api/ideas. */
export function ideaSummaries(root: string, b: Pick<Board, 'goals'>) {
  return projectIds(b).map((app) => {
    try {
      const f = readIdeas(root, app);
      const n = (s: IdeaStatus) => f.ideas.filter((i) => i.status === s).length;
      return { app, version: f.version, open: n('open'), promoted: n('promoted'), dropped: n('dropped') };
    } catch (e: any) { return { app, version: 0, open: 0, promoted: 0, dropped: 0, error: e.message }; }
  });
}

/** Promoted and dropped ideas that no longer fit move here, oldest first, one JSON line each (history and links kept). */
export const ideasArchiveRelPath = (app: string) => path.join('data', 'ideas', 'archive', `${app}.jsonl`);

function archivedIds(root: string, app: string): string[] {
  let raw = '';
  try { raw = fs.readFileSync(path.join(root, ideasArchiveRelPath(app)), 'utf8'); } catch { return []; }
  return raw.split('\n').flatMap((l) => { try { const id = JSON.parse(l)?.id; return typeof id === 'string' ? [id] : []; } catch { return []; } });
}

function filesFor(root: string, app: string, file: IdeaFile, entry: Activity): { rel: string; content: string }[] {
  const size = () => Buffer.byteLength(JSON.stringify(file, null, 2) + '\n');
  // Make room by archiving finished ideas (promoted / dropped), oldest first; open ideas always stay.
  const moved: Idea[] = [];
  while ((size() > MAX_IDEAS_BYTES || file.ideas.length > MAX_IDEAS) && file.ideas.some((i) => i.status !== 'open')) {
    const k = file.ideas.findIndex((i) => i.status !== 'open');
    moved.push(file.ideas[k]);
    file = { ...file, ideas: file.ideas.filter((_, j) => j !== k) };
  }
  const content = JSON.stringify(file, null, 2) + '\n';
  if (Buffer.byteLength(content) > MAX_IDEAS_BYTES) throw new HttpError(413, `ideas file would be ${Buffer.byteLength(content)} B (max ${MAX_IDEAS_BYTES} B) with only open ideas; drop or promote some first`);
  const all = [...readIdeaActivity(root, app, MAX_ACTIVITY - 1), { ...entry, note: entry.note?.replace(/\s+/g, ' ').slice(0, 200) }];
  const out = [{ rel: ideasRelPath(app), content }, { rel: activityRel(app), content: all.map((a) => JSON.stringify(a)).join('\n') + '\n' }];
  if (moved.length) {
    let prev = '';
    try { prev = fs.readFileSync(path.join(root, ideasArchiveRelPath(app)), 'utf8'); } catch { /* first archive */ }
    out.push({ rel: ideasArchiveRelPath(app), content: prev + moved.map((i) => JSON.stringify(i)).join('\n') + '\n' });
  }
  return out;
}

function locked<T>(root: string, app: string, actor: string, fn: (f: IdeaFile) => T): T {
  if (!ACTOR_RE.test(actor)) throw new HttpError(400, 'bad actor');
  ideasRelPath(app);
  return withRepoLock(root, () => { assertProject(loadGoals(root), app); return fn(readIdeas(root, app)); });
}

function findIdea(f: IdeaFile, id: string, expected?: number): Idea {
  const i = f.ideas.find((x) => x.id === id);
  if (!i) throw new HttpError(404, `no idea "${id}"`);
  if (expected !== undefined && expected !== i.version)
    throw new HttpError(409, `version conflict: idea ${id} is at version ${i.version}, you sent ${expected}; re-read it and retry`, { current_version: i.version, status: i.status });
  return i;
}

export interface IdeaOpts { now?: Date; expectedVersion?: number }

/** Append an idea. Its id is <app>.i-<slug of the title>, made unique. */
export function addIdea(root: string, app: string, input: Record<string, unknown>, actor: string, opts: IdeaOpts = {}): Idea {
  const bad = Object.keys(input).filter((k) => !(IDEA_TEXT as string[]).includes(k));
  if (bad.length) throw new HttpError(400, `unknown field(s): ${bad.join(', ')} (an idea has ${IDEA_TEXT.join(', ')})`);
  const fields = Object.fromEntries(IDEA_TEXT.map((k) => [k, text(input[k], k)])) as Record<keyof typeof LIMITS, string>;
  if (!fields.title) throw new HttpError(400, 'title is required');
  return locked(root, app, actor, (f) => {
    if (f.ideas.filter((i) => i.status === 'open').length >= MAX_IDEAS) throw new HttpError(413, `${app} already has ${MAX_IDEAS} open ideas; drop or promote some first`);
    const base = `${app}.i-${slugify(fields.title_en || fields.title)}`.slice(0, 80).replace(/-+$/, '');
    let id = IDEA_ID_RE.test(base) ? base : `${app}.i-idea`;
    // Ids are never reused, not even after an idea moved to the archive (a task's `idea` must keep meaning one idea).
    const taken = new Set([...f.ideas.map((i) => i.id), ...archivedIds(root, app)]);
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const at = isoLocal(opts.now);
    const idea: Idea = {
      id, title: fields.title, ...opt(fields, ['title_ko', 'title_en']), note: fields.note, ...opt(fields, ['note_ko', 'note_en']), source: fields.source,
      added_by: actor, added_at: at, status: 'open', version: 1, updated: at, updated_by: actor,
    };
    const next: IdeaFile = { app, version: f.version + 1, updated: at, updated_by: actor, ideas: [...f.ideas, idea] };
    commitFiles(root, filesFor(root, app, next, { at, actor, action: 'add', note: `${id}: ${idea.title}` }), `${actor}: idea ${id} add`);
    return idea;
  });
}

const opt = (o: Record<string, string>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, o[k]]));

/** Change an idea's text (translations included) or drop / reopen it. Promoting goes through promoteIdea. */
export function updateIdea(root: string, app: string, id: string, patch: Record<string, unknown>, actor: string, opts: IdeaOpts = {}): Idea {
  const allowed = [...IDEA_TEXT, 'status'];
  const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
  if (bad.length) throw new HttpError(400, `unknown field(s): ${bad.join(', ')} (editable: ${allowed.join(', ')})`);
  if (patch.status !== undefined && patch.status !== 'open' && patch.status !== 'dropped') throw new HttpError(400, 'status must be open or dropped (promote with /promote)');
  if (patch.title !== undefined && !text(patch.title, 'title')) throw new HttpError(400, 'title cannot be empty');
  return locked(root, app, actor, (f) => {
    const cur = findIdea(f, id, opts.expectedVersion);
    if (patch.status !== undefined && cur.status === 'promoted') throw new HttpError(409, `idea ${id} was promoted to ${cur.promoted_task_id}; change the task instead`);
    const next: any = { ...cur };
    const changed: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const val = k === 'status' ? String(v) : text(v, k as keyof typeof LIMITS);
      if ((cur as any)[k] === val || ((cur as any)[k] === undefined && val === '')) continue;
      if (val === '' && ['title_ko', 'title_en', 'note_ko', 'note_en'].includes(k)) delete next[k]; else next[k] = val;
      changed.push(k === 'status' ? `status ${cur.status} -> ${val}` : k);
    }
    // A new title or note without new translations: the old translations no longer match, drop them.
    for (const [src, tr] of [['title', ['title_ko', 'title_en']], ['note', ['note_ko', 'note_en']]] as const)
      if (changed.includes(src)) for (const k of tr) if (patch[k] === undefined && next[k] !== undefined) { delete next[k]; changed.push(`${k} cleared`); }
    if (!changed.length) return cur;
    const at = isoLocal(opts.now);
    const i18nOnly = changed.every((c) => ['title_ko', 'title_en', 'note_ko', 'note_en'].includes(c));
    Object.assign(next, { version: cur.version + 1, updated: at, updated_by: actor });
    const file: IdeaFile = { app, version: f.version + 1, updated: at, updated_by: actor, ideas: f.ideas.map((i) => (i.id === id ? next : i)) };
    const action = patch.status === 'dropped' ? 'drop' : patch.status === 'open' && cur.status !== 'open' ? 'reopen' : i18nOnly ? 'i18n' : 'edit';
    commitFiles(root, filesFor(root, app, file, { at, actor, action, note: `${id}: ${changed.join(', ')}` }), `${actor}: idea ${id} ${changed.join(', ')}`.slice(0, 160));
    return next;
  });
}

/** Turn an open idea into a task. The task gets the idea's titles and note, and `idea: <id>`; the idea becomes
 *  promoted with promoted_task_id. Both files, both activity logs: one commit. Returns both. */
export function promoteIdea(root: string, app: string, id: string, input: Record<string, unknown>, actor: string, opts: IdeaOpts = {}): { idea: Idea; task: Task } {
  const allowed = ['title', 'title_ko', 'title_en', 'milestone', 'kind', 'priority', 'lane', 'owner', 'body'];
  const bad = Object.keys(input).filter((k) => !allowed.includes(k));
  if (bad.length) throw new HttpError(400, `unknown field(s): ${bad.join(', ')} (promote takes ${allowed.join(', ')}, expected_version)`);
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null && typeof v !== 'string') throw new HttpError(400, `${k} must be a string`);
  return locked(root, app, actor, (f) => {
    const cur = findIdea(f, id, opts.expectedVersion);
    if (cur.status !== 'open') throw new HttpError(409, `idea ${id} is ${cur.status}${cur.promoted_task_id ? ` (task ${cur.promoted_task_id})` : ''}`, { status: cur.status, promoted_task_id: cur.promoted_task_id ?? '' });
    const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
    const noteLines = [cur.note || cur.note_ko || cur.note_en, cur.source ? `Source: ${cur.source}` : '', `Idea: ${id} (added by ${cur.added_by})`].filter(Boolean);
    const at = isoLocal(opts.now);
    let promoted: Idea | undefined;
    const task = createTask(root, {
      // The idea's translations only come along when the task keeps the idea's title.
      goal: app, title: s('title') || cur.title,
      title_ko: s('title_ko') ?? (!s('title') || s('title') === cur.title ? cur.title_ko : undefined),
      title_en: s('title_en') ?? (!s('title') || s('title') === cur.title ? cur.title_en : undefined),
      milestone: s('milestone'), kind: s('kind'), priority: s('priority'), lane: s('lane'), owner: s('owner'), status: 'todo',
      body: s('body') ?? `\n## Context\n${noteLines.map((l) => `- ${l}`).join('\n')}\n`,
    }, actor, opts.now ?? new Date(), {
      idea: id, note: `from idea ${id}`,
      extraFiles: (t) => {
        promoted = { ...cur, status: 'promoted', promoted_task_id: t.id, promoted_at: at, promoted_by: actor, version: cur.version + 1, updated: at, updated_by: actor };
        const file: IdeaFile = { app, version: f.version + 1, updated: at, updated_by: actor, ideas: f.ideas.map((i) => (i.id === id ? promoted! : i)) };
        return filesFor(root, app, file, { at, actor, action: 'promote', note: `${id} -> ${t.id}` });
      },
    });
    return { idea: promoted!, task };
  });
}

/** For `dasks check`: like views, idea problems are warnings (only the API writes these files). */
export function checkIdeas(root: string, b: Board): Issue[] {
  const dir = path.join(root, 'data', 'ideas');
  const out: Issue[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  const projects = projectIds(b);
  const taskIds = new Set(b.tasks.map((t) => t.id));
  for (const f of files.sort()) {
    if (f.startsWith('.') || f === 'archive') continue;
    const file = `data/ideas/${f}`;
    const app = f.replace(/\.json$/, '');
    if (!f.endsWith('.json') || !projects.includes(app)) { out.push({ file, message: `unexpected file (want <project>.json, projects: ${projects.join(', ')})` }); continue; }
    let o: any;
    try { o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e: any) { out.push({ file, message: `parse error: ${e.message}` }); continue; }
    if (!Array.isArray(o?.ideas)) { out.push({ file, message: 'no ideas list' }); continue; }
    const seen = new Set<string>();
    for (const i of o.ideas) {
      for (const m of ideaErrors(i, app)) out.push({ file, message: m });
      if (seen.has(i?.id)) out.push({ file, message: `duplicate idea id "${i.id}"` });
      seen.add(i?.id);
      if (i?.promoted_task_id && !taskIds.has(i.promoted_task_id)) out.push({ file, message: `${i.id}: promoted task ${i.promoted_task_id} does not exist` });
    }
  }
  return out;
}
