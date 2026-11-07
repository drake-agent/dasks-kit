// Read the data/ tree into memory. Never throws on bad content: problems become loadErrors for `check`.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ALL_STATUSES, type Board, type Goal, type Issue, isTaskId, KINDS, type Link, type NorthStar, type Task, TASK_ALL_FIELDS, TASK_OPTIONAL_FIELDS, SPEC_TASK_FIELDS } from './schema.ts';

export function readYaml(file: string): unknown {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

export interface ParsedMd { fm: Record<string, unknown>; body: string }

export function parseFrontmatter(text: string): ParsedMd {
  const t = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(t);
  if (!m) throw new Error('missing YAML frontmatter (--- … ---)');
  const fm = YAML.parse(m[1]);
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) throw new Error('frontmatter is not a mapping');
  return { fm: fm as Record<string, unknown>, body: m[2] };
}

const RAW_FIELDS = SPEC_TASK_FIELDS; // spec state fields are never string-coerced
const str = (v: unknown): string => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v));

/** A task file whose frontmatter is not a Task: a load error (the card is not on the board), never a coerced object. */
export class TaskShapeError extends Error {}

const scalar = (v: unknown) => v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date;

/** What the Task type promises, checked before a parsed file becomes one: every string field is one value (a list or a
 *  mapping would be stringified into "[object Object]"), and the id, status and kind the code switches on are real
 *  values. Everything else (titles, references, timestamps, …) stays check()'s job: those are strings either way. */
export function taskShapeErrors(fm: Record<string, unknown>): string[] {
  const e: string[] = [];
  for (const k of TASK_ALL_FIELDS) if (!(RAW_FIELDS as readonly string[]).includes(k) && !scalar(fm[k])) e.push(`"${k}" must be one value, not a list or mapping`);
  if (!isTaskId(fm.id)) e.push(`bad id ${JSON.stringify(scalar(fm.id) ? str(fm.id) : '?').slice(0, 80)}`);
  if (!(ALL_STATUSES as readonly unknown[]).includes(fm.status)) e.push(`bad status ${JSON.stringify(scalar(fm.status) ? str(fm.status) : '?').slice(0, 40)}`);
  if (!(KINDS as readonly unknown[]).includes(fm.kind)) e.push(`bad kind ${JSON.stringify(scalar(fm.kind) ? str(fm.kind) : '?').slice(0, 40)}`);
  return e;
}

export function taskFromParsed(p: ParsedMd, file: string, bytes: number): Task {
  const fm = p.fm;
  const shape = taskShapeErrors(fm);
  if (shape.length) throw new TaskShapeError(`not a task: ${shape.join('; ')}`);
  const t: Record<string, unknown> = { body: p.body, file, bytes };
  // Every field is a string (missing → '') so validation reports problems instead of crashing on them.
  for (const k of TASK_ALL_FIELDS) t[k] = k in fm ? str(fm[k]) : (TASK_OPTIONAL_FIELDS as readonly string[]).includes(k) ? undefined : '';
  // The spec state fields stay as parsed (a mapping, a number, a string): check() judges them, nothing coerces them.
  for (const k of RAW_FIELDS) if (k in fm) t[k] = fm[k];
  // Keep unknown keys visible to check() via a marker.
  const unknown = Object.keys(fm).filter((k) => !(TASK_ALL_FIELDS as readonly string[]).includes(k));
  if (unknown.length) t.__unknown = unknown;
  t.__present = Object.keys(fm);
  return t as unknown as Task;
}

export function dataDir(root: string): string {
  return path.join(root, 'data');
}

/** Only the north star and the goal files (cheap: what writers need to check goal and milestone references). */
export function loadGoals(root: string): Pick<Board, 'northstar' | 'goals' | 'loadErrors'> {
  const b = loadBoard(root, false);
  return { northstar: b.northstar, goals: b.goals, loadErrors: b.loadErrors };
}

/** Task files parsed since start (reported on /api/health as reload.task_parses). */
export const loadStats = { task_parses: 0 };

/** Parse one task file (repo-relative path). Read and parse errors are thrown unchanged. */
export function readTaskFile(root: string, rel: string): Task {
  const buf = fs.readFileSync(path.join(root, rel));
  const t = taskFromParsed(parseFrontmatter(buf.toString('utf8')), rel, buf.length);
  loadStats.task_parses++;
  return t;
}

const TASK_REL = /^data\/tasks\/[^/]+\/[^/]+\.md$/;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The board after the given repo-relative files changed, re-reading only task files: equal to loadBoard(root) while the
 *  rest of data/ is unchanged. null = a full loadBoard is needed: no files, a board file (north star, goals, links), a
 *  directory or a stray file under data/tasks, or a task file that fails to read for any reason but a missing file.
 *  Files outside the board (activity, lessons, …) are ignored. */
export function reloadTaskFiles(root: string, board: Board, rels: string[]): Board | null {
  if (!rels.length) return null;
  const changed = new Set<string>();
  for (const r of rels) {
    const f = r.split(path.sep).join('/');
    if (f === 'data' || f === 'data/northstar.yaml' || f === 'data/links.yaml' || f === 'data/goals' || f.startsWith('data/goals/')) return null;
    if (f === 'data/tasks' || f.startsWith('data/tasks/')) {
      if (!TASK_REL.test(f)) return null;
      changed.add(f);
    }
  }
  const tasks = board.tasks.filter((t) => !changed.has(t.file));
  for (const f of changed) {
    try { tasks.push(readTaskFile(root, f)); } catch (e: any) { if (e?.code !== 'ENOENT') return null; }
  }
  // loadBoard's order: app directory, then file name
  tasks.sort((a, b) => { const x = a.file.split('/'), y = b.file.split('/'); return cmp(x[2], y[2]) || cmp(x[3], y[3]); });
  return { northstar: board.northstar, goals: board.goals, tasks, links: board.links, loadErrors: board.loadErrors.filter((e) => !changed.has(e.file)) };
}

export function loadBoard(root: string, withTasks = true): Board {
  const dir = dataDir(root);
  const loadErrors: Issue[] = [];
  const rel = (f: string) => path.relative(root, f);

  let northstar: NorthStar | null = null;
  const nsFile = path.join(dir, 'northstar.yaml');
  try {
    const ns = readYaml(nsFile) as any;
    northstar = { id: str(ns?.id), title: str(ns?.title), why: str(ns?.why), horizon: str(ns?.horizon), ...i18nTitles(ns) };
  } catch (e: any) {
    loadErrors.push({ file: rel(nsFile), message: e.code === 'ENOENT' ? 'missing' : `parse error: ${e.message}` });
  }

  const goals: Goal[] = [];
  const goalsDir = path.join(dir, 'goals');
  for (const f of safeList(goalsDir).filter((f) => f.endsWith('.yaml')).sort()) {
    const file = path.join(goalsDir, f);
    try {
      const g = readYaml(file) as any;
      goals.push({
        id: str(g?.id), parent: str(g?.parent), title: str(g?.title), ...i18nTitles(g), why: str(g?.why), owner: str(g?.owner),
        ...(g?.repo ? { repo: str(g.repo) } : {}),
        ...(g?.version_target ? { version_target: str(g.version_target) } : {}),
        ...(g?.profile != null ? { profile: g.profile } : {}),
        milestones: Array.isArray(g?.milestones)
          ? g.milestones.map((m: any) => ({
              id: str(m?.id), title: str(m?.title), ...i18nTitles(m), due: str(m?.due), status: str(m?.status),
              done_criteria: Array.isArray(m?.done_criteria) ? m.done_criteria.map(str) : m?.done_criteria == null ? [] : (null as any),
            }))
          : [],
        file: rel(file),
      });
    } catch (e: any) {
      loadErrors.push({ file: rel(file), message: `parse error: ${e.message}` });
    }
  }

  const tasks: Task[] = [];
  const tasksDir = path.join(dir, 'tasks');
  for (const app of withTasks ? safeList(tasksDir).sort() : []) {
    const appDir = path.join(tasksDir, app);
    if (!isDir(appDir)) continue;
    for (const f of safeList(appDir).filter((f) => f.endsWith('.md')).sort()) {
      const file = path.join(appDir, f);
      try {
        tasks.push(readTaskFile(root, rel(file)));
      } catch (e: any) {
        loadErrors.push({ file: rel(file), message: e instanceof TaskShapeError ? e.message : `parse error: ${e.message}` });
      }
    }
  }

  let links: Link[] = [];
  const linksFile = path.join(dir, 'links.yaml');
  try {
    const l = readYaml(linksFile);
    if (l == null) links = [];
    else if (!Array.isArray(l)) loadErrors.push({ file: rel(linksFile), message: 'must be a YAML list' });
    else links = l.map((x: any) => ({ from: str(x?.from), to: str(x?.to), type: str(x?.type), note: str(x?.note) }));
  } catch (e: any) {
    if (e.code !== 'ENOENT') loadErrors.push({ file: rel(linksFile), message: `parse error: ${e.message}` });
  }

  return { northstar, goals, tasks, links, loadErrors };
}

/** Optional per-language titles of a north star, goal or milestone (omitted when empty). */
function i18nTitles(o: any): { title_ko?: string; title_en?: string } {
  const out: { title_ko?: string; title_en?: string } = {};
  if (o?.title_ko) out.title_ko = str(o.title_ko);
  if (o?.title_en) out.title_en = str(o.title_en);
  return out;
}

function safeList(d: string): string[] {
  try { return fs.readdirSync(d); } catch { return []; }
}
function isDir(d: string): boolean {
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
}
