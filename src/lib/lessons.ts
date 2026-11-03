// Lessons (Dasks): what an agent learned on a card, one lesson per row, in data/lessons/<app>.json, so the next card
// on the same project (and the same files) starts with it.
// Agents add lessons as proposals; only the user (a logged-in human session, actor "user") confirms one. Anyone may
// retire a lesson that no longer holds. Every write runs under the repo lock, records the actor and is one git commit.
import fs from 'node:fs';
import path from 'node:path';
import { ACTOR_RE, GOAL_ID_RE, isTaskId, type Board, type Issue } from './schema.ts';
import { loadGoals } from './load.ts';
import { HttpError, commitFiles, isoLocal, slugify, withRepoLock } from './write.ts';
import { assertProject, projectIds } from './views.ts';

export const LESSON_STATUSES = ['proposed', 'confirmed', 'retired'] as const;
export type LessonStatus = typeof LESSON_STATUSES[number];
export const LESSON_ID_RE = /^([a-z][a-z0-9]{0,23})\.(l-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
export const MAX_LESSONS = 300;
export const MAX_LESSONS_BYTES = 128 * 1024;
export const MAX_TEXT = 400;
export const MAX_FILES = 10;
/** How many Handoff files a task read looks at (a lookup, not a lesson: more than one lesson may hold). */
export const MAX_TASK_FILES = 20;
const MAX_PATH = 200;
/** How many lessons a task read or a worker prompt carries. */
export const DEFAULT_RELEVANT = 5;

export interface Lesson {
  id: string; text: string; files: string[]; task: string;
  added_by: string; added_at: string; status: LessonStatus;
  version: number; updated: string; updated_by: string;
}
/** A row in data/lessons/archive/<app>.jsonl. `archived_reason: "overflow"` marks a proposed row moved out to make
 *  room; a row that was already retired is archived as stored, without it. */
export type ArchivedLesson = Lesson & { archived_reason?: 'overflow' };
export interface LessonFile { app: string; version: number; updated: string; updated_by: string; lessons: Lesson[] }

export const lessonsRelPath = (app: string): string => {
  if (!GOAL_ID_RE.test(app)) throw new HttpError(404, `no project "${app}"`);
  return path.join('data', 'lessons', `${app}.json`);
};
export const lessonsArchiveRelPath = (app: string) => path.join('data', 'lessons', 'archive', `${app}.jsonl`);

// A lesson is read by other agents and lands in their prompts: never let a credential ride along.
const SECRET_RES = [
  /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, /\bsk-ant-[A-Za-z0-9_-]{8,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
  /dsk_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}/i, // Dasks agent identity token, anywhere in the text (also inside _..._ or glued to a word)
];
export const looksSecret = (s: string): boolean => SECRET_RES.some((r) => r.test(s));

function lessonText(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError(400, 'text must be a string');
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) throw new HttpError(400, 'text is required');
  if (s.length > MAX_TEXT) throw new HttpError(400, `text is over ${MAX_TEXT} characters (one lesson per row)`);
  if (looksSecret(s)) throw new HttpError(400, 'text looks like it holds a credential; lessons never store secrets');
  return s;
}

/** Repo-relative paths (or directories ending in /). No absolute paths, no "..", no duplicates. */
export function lessonFiles(v: unknown, max = MAX_FILES): string[] {
  if (v === undefined || v === null || v === '') return [];
  const list = typeof v === 'string' ? v.split(',') : v;
  if (!Array.isArray(list)) throw new HttpError(400, 'files must be a list of repo-relative paths');
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw new HttpError(400, 'files must be strings');
    const f = raw.trim().replace(/^\.\//, '');
    if (!f) continue;
    if (f.length > MAX_PATH || f.startsWith('/') || f.startsWith('~') || /(^|\/)\.\.(\/|$)/.test(f) || /[\0\n\r\\]/.test(f))
      throw new HttpError(400, `bad file path "${f.slice(0, 60)}" (want a repo-relative path)`);
    // Paths ride into prompts and reads like the text does.
    if (looksSecret(f)) throw new HttpError(400, 'a file path looks like it holds a credential; lessons never store secrets');
    if (!out.includes(f)) out.push(f);
  }
  if (out.length > max) throw new HttpError(400, `at most ${max} files`);
  return out;
}

/** Shape check for one stored lesson (used on read and by `dasks check`). */
export function lessonErrors(l: any, app: string): string[] {
  const e: string[] = [];
  if (!l || typeof l !== 'object' || Array.isArray(l)) return ['lesson must be an object'];
  const m = LESSON_ID_RE.exec(String(l.id ?? ''));
  if (!m) e.push(`bad lesson id "${l.id}" (want ${app}.l-<slug>)`);
  else if (m[1] !== app) e.push(`lesson "${l.id}" does not start with "${app}."`);
  if (typeof l.text !== 'string' || !l.text.trim() || l.text.length > MAX_TEXT) e.push(`${l.id}: bad text`);
  if (!Array.isArray(l.files) || l.files.length > MAX_FILES || l.files.some((f: unknown) => typeof f !== 'string')) e.push(`${l.id}: bad files`);
  if (typeof l.task !== 'string' || (l.task && !isTaskId(l.task))) e.push(`${l.id}: bad task`);
  if (!(LESSON_STATUSES as readonly string[]).includes(l.status)) e.push(`${l.id}: bad status "${l.status}"`);
  if (!ACTOR_RE.test(String(l.added_by ?? ''))) e.push(`${l.id}: bad added_by`);
  if (!Number.isInteger(l.version) || l.version < 1) e.push(`${l.id}: version must be a positive integer`);
  return e;
}

/** The project's lessons (empty, version 0, when the file does not exist yet). 409 for a file that cannot be read. */
export function readLessons(root: string, app: string): LessonFile {
  const rel = lessonsRelPath(app);
  let raw: string;
  try { raw = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e: any) {
    if (e.code === 'ENOENT') return { app, version: 0, updated: '', updated_by: '', lessons: [] };
    throw e;
  }
  let o: any;
  try { o = JSON.parse(raw); } catch (e: any) { throw new HttpError(409, `${rel} is not valid JSON: ${e.message}`); }
  if (!o || !Array.isArray(o.lessons)) throw new HttpError(409, `${rel} has no lessons list`);
  const errs = o.lessons.flatMap((l: any) => lessonErrors(l, app));
  if (errs.length) throw new HttpError(409, `${rel} is invalid: ${errs.slice(0, 3).join('; ')}`);
  return { app, version: Number.isInteger(o.version) ? o.version : 0, updated: String(o.updated ?? ''), updated_by: String(o.updated_by ?? ''), lessons: o.lessons };
}

/** How close a lesson's files are to the files at hand: 2 = same file (or a lesson directory holding it), 1 = same directory. */
function closeness(lesson: string[], files: string[]): number {
  let best = 0;
  for (const a of lesson) for (const b of files) {
    if (a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b))) return 2;
    const da = a.includes('/') ? a.slice(0, a.lastIndexOf('/') + 1) : '';
    const db = b.includes('/') ? b.slice(0, b.lastIndexOf('/') + 1) : '';
    if (da && da === db) best = 1;
  }
  return best;
}

/** Lessons worth carrying into the next card: not retired, closest files first, confirmed before
 *  proposed, newest first. */
export function relevantLessons(f: LessonFile, files: string[] = [], limit = DEFAULT_RELEVANT): Lesson[] {
  return f.lessons
    .map((l, i) => ({ l, i, c: files.length ? closeness(l.files, files) : 0 }))
    .filter((x) => x.l.status !== 'retired')
    .sort((a, b) => b.c - a.c || Number(b.l.status === 'confirmed') - Number(a.l.status === 'confirmed') || b.l.added_at.localeCompare(a.l.added_at) || b.i - a.i)
    .slice(0, Math.max(0, limit))
    .map((x) => x.l);
}

/** The files a task names: its Handoff `files:` entries (comma list or bullets). */
export function taskFiles(handoff: string): string[] {
  const m = /(?:^|\n)\s*-?\s*files:[ \t]*(.*)((?:\n[ \t]+-[^\n]*)*)/i.exec(handoff);
  if (!m) return [];
  const items = [...m[1].split(','), ...m[2].split('\n').map((l) => l.replace(/^\s*-\s*/, ''))];
  const out: string[] = [];
  for (const raw of items) {
    const f = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/^\.\//, '');
    // Same rules as lessonFiles, so a lesson saved with these files is never refused for them.
    if (f && f.length <= MAX_PATH && !/^[/~]/.test(f) && !/(^|\/)\.\.(\/|$)/.test(f) && !/[\s\0\\]/.test(f) && !out.includes(f)) out.push(f);
  }
  return out.slice(0, MAX_TASK_FILES);
}

/** Counts per project for GET /api/lessons. */
export function lessonSummaries(root: string, b: Pick<Board, 'goals'>) {
  return projectIds(b).map((app) => {
    try {
      const f = readLessons(root, app);
      const n = (s: LessonStatus) => f.lessons.filter((l) => l.status === s).length;
      return { app, version: f.version, proposed: n('proposed'), confirmed: n('confirmed'), retired: n('retired') };
    } catch (e: any) { return { app, version: 0, proposed: 0, confirmed: 0, retired: 0, error: e.message }; }
  });
}

function archivedIds(root: string, app: string): string[] {
  let raw = '';
  try { raw = fs.readFileSync(path.join(root, lessonsArchiveRelPath(app)), 'utf8'); } catch { return []; }
  return raw.split('\n').flatMap((l) => { try { const id = JSON.parse(l)?.id; return typeof id === 'string' ? [id] : []; } catch { return []; } });
}

/** The row a write adds or edits, and who writes it when: that row is never moved out to make room. */
interface Writing { id: string; at: string; actor: string }

/** The files of one lessons write. While the file is over a cap it makes room, oldest first: retired rows (archived as
 *  stored), then proposed rows (archived as retired, reason overflow), never the row being written and never a
 *  confirmed one. 413, with nothing written, when only those are left. `archived` names the moved rows. */
function filesFor(root: string, app: string, file: LessonFile, w: Writing): { files: { rel: string; content: string }[]; archived: string[] } {
  const over = () => file.lessons.length > MAX_LESSONS || Buffer.byteLength(JSON.stringify(file, null, 2) + '\n') > MAX_LESSONS_BYTES;
  const moved: ArchivedLesson[] = [];
  while (over()) {
    let k = file.lessons.findIndex((l) => l.status === 'retired' && l.id !== w.id);
    if (k < 0) {
      // lowest added_at, file order on a tie (the order relevantLessons uses)
      file.lessons.forEach((l, j) => { if (l.status === 'proposed' && l.id !== w.id && (k < 0 || l.added_at.localeCompare(file.lessons[k].added_at) < 0)) k = j; });
      if (k < 0) throw new HttpError(413, `${app} lessons are full of confirmed lessons (max ${MAX_LESSONS} lessons, ${MAX_LESSONS_BYTES} B); retire some first`);
      const l = file.lessons[k];
      moved.push({ ...l, status: 'retired', version: l.version + 1, updated: w.at, updated_by: w.actor, archived_reason: 'overflow' });
    } else moved.push(file.lessons[k]);
    file = { ...file, lessons: file.lessons.filter((_, j) => j !== k) };
  }
  const files = [{ rel: lessonsRelPath(app), content: JSON.stringify(file, null, 2) + '\n' }];
  if (moved.length) {
    let prev = '';
    try { prev = fs.readFileSync(path.join(root, lessonsArchiveRelPath(app)), 'utf8'); } catch { /* first archive */ }
    files.push({ rel: lessonsArchiveRelPath(app), content: prev + moved.map((l) => JSON.stringify(l)).join('\n') + '\n' });
  }
  return { files, archived: moved.map((l) => l.id) };
}

/** One lessons commit: the subject cut at 160 characters, then a body line naming every row moved to the archive. */
function commitLessons(root: string, w: { files: { rel: string; content: string }[]; archived: string[] }, subject: string): void {
  commitFiles(root, w.files, subject.slice(0, 160) + (w.archived.length ? `\n\narchived (over cap): ${w.archived.join(', ')}` : ''));
}

function locked<T>(root: string, app: string, actor: string, fn: (f: LessonFile) => T): T {
  if (!ACTOR_RE.test(actor)) throw new HttpError(400, 'bad actor');
  lessonsRelPath(app);
  return withRepoLock(root, () => { assertProject(loadGoals(root), app); return fn(readLessons(root, app)); });
}

export interface LessonOpts { now?: Date; expectedVersion?: number }

/** Append a lesson ({text, files?, task?}). Agents' lessons start as proposed; one from the user starts confirmed.
 *  The same text on the same project again is not a second row: the existing lesson comes back unchanged. */
export function addLesson(root: string, app: string, input: Record<string, unknown>, actor: string, opts: LessonOpts = {}): Lesson {
  const bad = Object.keys(input).filter((k) => !['text', 'files', 'task'].includes(k));
  if (bad.length) throw new HttpError(400, `unknown field(s): ${bad.join(', ')} (a lesson has text, files, task)`);
  const text = lessonText(input.text);
  const files = lessonFiles(input.files);
  const task = input.task === undefined || input.task === null ? '' : String(input.task).trim();
  if (task && !isTaskId(task)) throw new HttpError(400, `bad task id "${String(task).slice(0, 60)}"`);
  if (task && !task.startsWith(`${app}.`)) throw new HttpError(400, `task ${task} is not on ${app}`);
  return locked(root, app, actor, (f) => {
    const same = f.lessons.find((l) => l.status !== 'retired' && l.text.toLowerCase() === text.toLowerCase());
    if (same) return same;
    const base = `${app}.l-${slugify(text.split(' ').slice(0, 8).join(' '))}`.slice(0, 80).replace(/-+$/, '');
    let id = LESSON_ID_RE.test(base) ? base : `${app}.l-lesson`;
    const taken = new Set([...f.lessons.map((l) => l.id), ...archivedIds(root, app)]);
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const at = isoLocal(opts.now);
    const lesson: Lesson = { id, text, files, task, added_by: actor, added_at: at, status: actor === 'user' ? 'confirmed' : 'proposed', version: 1, updated: at, updated_by: actor };
    const next: LessonFile = { app, version: f.version + 1, updated: at, updated_by: actor, lessons: [...f.lessons, lesson] };
    commitLessons(root, filesFor(root, app, next, { id, at, actor }), `${actor}: lesson ${id} add${task ? ` (from ${task})` : ''}`);
    return lesson;
  });
}

/** Edit a lesson's text or files, or change its status. Only the user confirms; editing a confirmed lesson's text
 *  as an agent turns it back into a proposal (the user confirmed the old words, not the new ones). */
export function updateLesson(root: string, app: string, id: string, patch: Record<string, unknown>, actor: string, opts: LessonOpts = {}): Lesson {
  const bad = Object.keys(patch).filter((k) => !['text', 'files', 'status'].includes(k));
  if (bad.length) throw new HttpError(400, `unknown field(s): ${bad.join(', ')} (editable: text, files, status)`);
  if (patch.status !== undefined && (typeof patch.status !== 'string' || !(LESSON_STATUSES as readonly string[]).includes(patch.status))) throw new HttpError(400, `status must be ${LESSON_STATUSES.join('|')}`);
  if (patch.status === 'confirmed' && actor !== 'user') throw new HttpError(403, 'only the user confirms a lesson (agents propose; retire one that no longer holds)');
  const text = patch.text !== undefined ? lessonText(patch.text) : undefined;
  const files = patch.files !== undefined ? lessonFiles(patch.files) : undefined;
  return locked(root, app, actor, (f) => {
    const cur = f.lessons.find((l) => l.id === id);
    if (!cur) throw new HttpError(404, `no lesson "${id}"`);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== cur.version)
      throw new HttpError(409, `version conflict: lesson ${id} is at version ${cur.version}, you sent ${opts.expectedVersion}; re-read it and retry`, { current_version: cur.version, status: cur.status });
    const next: Lesson = { ...cur };
    const changed: string[] = [];
    if (text !== undefined && text !== cur.text) { next.text = text; changed.push('text'); }
    if (files !== undefined && JSON.stringify(files) !== JSON.stringify(cur.files)) { next.files = files; changed.push('files'); }
    if (patch.status !== undefined && patch.status !== cur.status) { next.status = patch.status as LessonStatus; changed.push(`status ${cur.status} -> ${patch.status}`); }
    if (!changed.length) return cur;
    if (changed.includes('text') && next.status === 'confirmed' && actor !== 'user') { next.status = 'proposed'; changed.push('back to proposed'); }
    const at = isoLocal(opts.now);
    Object.assign(next, { version: cur.version + 1, updated: at, updated_by: actor });
    const file: LessonFile = { app, version: f.version + 1, updated: at, updated_by: actor, lessons: f.lessons.map((l) => (l.id === id ? next : l)) };
    commitLessons(root, filesFor(root, app, file, { id, at, actor }), `${actor}: lesson ${id} ${changed.join(', ')}`);
    return next;
  });
}

/** For `dasks check`: lesson problems are warnings (only the API writes these files). */
export function checkLessons(root: string, b: Board): Issue[] {
  const dir = path.join(root, 'data', 'lessons');
  const out: Issue[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  const projects = projectIds(b);
  for (const f of files.sort()) {
    if (f.startsWith('.') || f === 'archive') continue;
    const file = `data/lessons/${f}`;
    const app = f.replace(/\.json$/, '');
    if (!f.endsWith('.json') || !projects.includes(app)) { out.push({ file, message: `unexpected file (want <project>.json, projects: ${projects.join(', ')})` }); continue; }
    let o: any;
    try { o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e: any) { out.push({ file, message: `parse error: ${e.message}` }); continue; }
    if (!Array.isArray(o?.lessons)) { out.push({ file, message: 'no lessons list' }); continue; }
    const seen = new Set<string>();
    for (const l of o.lessons) {
      for (const m of lessonErrors(l, app)) out.push({ file, message: m });
      if (seen.has(l?.id)) out.push({ file, message: `duplicate lesson id "${l.id}"` });
      seen.add(l?.id);
      if (typeof l?.text === 'string' && looksSecret(l.text)) out.push({ file, message: `${l.id}: text looks like a credential` });
    }
  }
  return out;
}
