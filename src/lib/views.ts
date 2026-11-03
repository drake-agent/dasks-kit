// Per-project views (Dasks): one page per app goal at /p/<app>, laid out by data/views/<app>.json.
// Agents write the config through the API (PUT /api/views/<app>), humans only look. Missing file = built-in default.
// Every write is validated, bumps `version`, records the actor (`updated_by`, commit message, activity line).
import fs from 'node:fs';
import path from 'node:path';
import { type Board, type Issue, ACTOR_RE, GOAL_ID_RE, goalIdsOf } from './schema.ts';
import { loadGoals } from './load.ts';
import { HttpError, commitFiles, isoLocal, withRepoLock } from './write.ts';
import { type Activity, MAX_ACTIVITY } from './collab.ts';
import {
  MAX_VIEW_BYTES, defaultStructure, defaultView, validateStructure, validateView,
  type Structure, type View, type ViewBody,
} from './view-config.ts';

export {
  MAX_VIEW_BYTES, MAX_WIDGETS, STAT_ITEMS, STRUCTURES, DEFAULT_STRUCTURE, defaultStructure,
  WIDGETS, defaultView, validateWidget, validateStructure, validateView,
  type Structure, type MapNode, type Widget, type View, type MilestoneIndex, type ViewBody,
} from './view-config.ts';

/** Projects = goals (data-driven: every data/goals/<id>.yaml under the north star). */
export function projectIds(b: Pick<Board, 'goals'>): string[] { return goalIdsOf(b); }
// ---------- files ----------
export function viewRelPath(app: string): string {
  if (!GOAL_ID_RE.test(app)) throw new HttpError(404, `no project "${app}"`);
  return path.join('data', 'views', `${app}.json`);
}

/** 404 unless `app` is a project (a goal) right now. */
export function assertProject(b: Pick<Board, 'goals'>, app: string): void {
  const ids = projectIds(b);
  if (!ids.includes(app)) throw new HttpError(404, `no project "${app}" (projects: ${ids.join(', ')})`);
}
export function viewActivityRelPath(app: string): string {
  return path.join('data', 'activity', 'views', `${app}.jsonl`);
}

/** Version of a view file that fails validation: its own integer `version` if it still parses, else 0. */
function brokenVersion(root: string, app: string): number {
  try { const o = JSON.parse(fs.readFileSync(path.join(root, viewRelPath(app)), 'utf8')); return Number.isInteger(o?.version) && o.version >= 0 ? o.version : 0; }
  catch { return 0; }
}

/** Stored view or the default. Throws HttpError 409 for a file that exists but cannot be read as a view. */
export function readView(root: string, app: string): View {
  const rel = viewRelPath(app);
  // Cheap guard for callers without a loaded board: a project is a goal file (the server also checks the parent).
  if (!fs.existsSync(path.join(root, 'data', 'goals', `${app}.yaml`))) throw new HttpError(404, `no project "${app}"`);
  let text: string;
  try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e: any) {
    if (e.code === 'ENOENT') return defaultView(app);
    throw e;
  }
  let o: any;
  try { o = JSON.parse(text); } catch (e: any) { throw new HttpError(409, `${rel} is not valid JSON: ${e.message}`); }
  try {
    const v = validateView(app, o, undefined);
    const version = Number.isInteger(o.version) && o.version >= 0 ? o.version : 0;
    // A view without a structure gets the default one.
    return { app, ...v, structure: v.structure ?? defaultStructure(app), version, updated: typeof o.updated === 'string' ? o.updated : '', updated_by: typeof o.updated_by === 'string' ? o.updated_by : '' };
  } catch (e: any) { throw new HttpError(409, `${rel} is invalid: ${e.message}`); }
}

export function viewSummaries(root: string, b: Pick<Board, 'goals'>): { app: string; url: string; version: number; default: boolean; structure: string; updated: string; updated_by: string; error?: string }[] {
  return projectIds(b).map((app) => {
    try { const v = readView(root, app); return { app, url: `/p/${app}`, version: v.version, default: !!v.default, structure: v.structure, updated: v.updated, updated_by: v.updated_by }; }
    catch (e: any) { return { app, url: `/p/${app}`, version: 0, default: false, structure: defaultStructure(app), updated: '', updated_by: '', error: e.message }; }
  });
}

export function milestonesOf(b: Pick<Board, 'goals'>, app: string): Set<string> {
  return new Set(b.goals.find((g) => g.id === app)?.milestones.map((m) => m.id) ?? []);
}

export interface WriteViewOpts {
  expectedVersion?: number; now?: Date;
  /** Change only the structure, keep the rest of the current view (POST /api/views/<app>/structure). */
  structureOnly?: boolean;
}

/** Validate and write a project's view; commit "<actor>: view <app> v<N>". Returns the stored view. */
export function writeView(root: string, app: string, input: unknown, actor: string, opts: WriteViewOpts = {}): View {
  const rel = viewRelPath(app);
  if (!ACTOR_RE.test(actor)) throw new HttpError(400, 'bad actor');
  let structure: Structure | undefined;
  if (opts.structureOnly) { try { structure = validateStructure((input as any)?.structure); } catch (e: any) { throw new HttpError(400, e.message); } }
  else try { validateView(app, input, undefined); } catch (e: any) { throw new HttpError(400, e.message); }
  return withRepoLock(root, () => {
    // Project and milestone references are checked against the board as it is now, under the lock (not a cached copy).
    const board = loadGoals(root);
    assertProject(board, app);
    let clean: ViewBody;
    if (opts.structureOnly) {
      let base: View;
      try { base = readView(root, app); } catch (e: any) { throw new HttpError(409, `${e.message}; repair the view with a full PUT first`); }
      const { title, tagline, title_ko, title_en, tagline_ko, tagline_en, widgets } = base;
      clean = { title, tagline, widgets, structure, ...Object.fromEntries(Object.entries({ title_ko, title_en, tagline_ko, tagline_en }).filter(([, v]) => v)) };
    } else {
      try { clean = validateView(app, input, milestonesOf(board, app)); } catch (e: any) { throw new HttpError(400, e.message); }
    }
    let cur: View;
    let broken = false;
    try { cur = readView(root, app); } catch {
      // A file that fails validation keeps its version (if it still parses), so a stale writer still gets a 409.
      cur = { ...defaultView(app), default: false, version: brokenVersion(root, app) };
      broken = true;
    }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== cur.version)
      throw new HttpError(409, `version conflict: view ${app} is at version ${cur.version}, you sent ${opts.expectedVersion}; re-read it and retry`, { current_version: cur.version });
    // A view sent without a structure keeps the current one.
    const structureNext: Structure = clean.structure ?? cur.structure ?? defaultStructure(app);
    const body = (v: Partial<View>) => JSON.stringify([v.title, v.tagline, v.title_ko ?? '', v.title_en ?? '', v.tagline_ko ?? '', v.tagline_en ?? '', v.widgets]);
    const same = !cur.default && !broken && cur.structure === structureNext && body(cur) === body(clean);
    if (same) return cur;
    const at = isoLocal(opts.now);
    const next: View = { app, title: clean.title, tagline: clean.tagline, ...Object.fromEntries(Object.entries({ title_ko: clean.title_ko, title_en: clean.title_en, tagline_ko: clean.tagline_ko, tagline_en: clean.tagline_en }).filter(([, v]) => v)),
      structure: structureNext, widgets: clean.widgets, version: cur.version + 1, updated: at, updated_by: actor };
    const content = JSON.stringify(next, null, 2) + '\n';
    if (Buffer.byteLength(content) > MAX_VIEW_BYTES) throw new HttpError(413, `view would be ${Buffer.byteLength(content)} B (max ${MAX_VIEW_BYTES} B)`);
    const what = cur.structure !== structureNext ? `structure ${cur.structure} -> ${structureNext}` : '';
    const entry: Activity = { at, actor, action: cur.default ? 'create' : opts.structureOnly ? 'structure' : 'edit', note: `v${next.version}: ${what || next.widgets.map((w) => w.type).join(' ')}` };
    commitFiles(root, [
      { rel, content },
      { rel: viewActivityRelPath(app), content: viewActivityContent(root, app, entry) },
    ], `${actor}: view ${app} v${next.version}`);
    return readView(root, app);
  });
}

export function readViewActivity(root: string, app: string, limit = 20): Activity[] {
  let text = '';
  try { text = fs.readFileSync(path.join(root, viewActivityRelPath(app)), 'utf8'); } catch { return []; }
  const out: Activity[] = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out.slice(-limit);
}

function viewActivityContent(root: string, app: string, entry: Activity): string {
  const all = [...readViewActivity(root, app, MAX_ACTIVITY - 1), { ...entry, note: entry.note?.slice(0, 200) }];
  return all.map((a) => JSON.stringify(a)).join('\n') + '\n';
}

/** For `dasks check` (the pre-commit hook). Views are written only through the validated API, and a bad view must
 *  never block an ordinary task commit, so every view problem is a warning here, never an error. */
export function checkViews(root: string, b: Board): Issue[] {
  const dir = path.join(root, 'data', 'views');
  const warnings: Issue[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return warnings; }
  for (const f of files.sort()) {
    if (f.startsWith('.')) continue;
    const file = `data/views/${f}`;
    const app = f.replace(/\.json$/, '');
    const projects = projectIds(b);
    if (!f.endsWith('.json') || !projects.includes(app)) { warnings.push({ file, message: `unexpected file (want <project>.json, projects: ${projects.join(', ')})` }); continue; }
    let o: any;
    try { o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e: any) { warnings.push({ file, message: `parse error: ${e.message} (page falls back to an error; fix it with PUT /api/views/${app})` }); continue; }
    try { validateView(app, o, milestonesOf(b, app)); } catch (e: any) { warnings.push({ file, message: e.message }); }
    if (!Number.isInteger(o?.version) || o.version < 1) warnings.push({ file, message: 'version must be a positive integer' });
  }
  return warnings;
}
