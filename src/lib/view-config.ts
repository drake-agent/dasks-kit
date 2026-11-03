import { isValidDate } from './check.ts';

export const MAX_VIEW_BYTES = 16 * 1024;
export const MAX_WIDGETS = 12;

/** Stat cards. countdown = days to the stats widget's own date (needs `date`); stage = the first open milestone. */
export const STAT_ITEMS = ['progress', 'needs_you', 'running', 'todo', 'done', 'done_24h', 'countdown', 'stage'] as const;

/** How a project's tasks are laid out on its page (the `work` section). */
export const STRUCTURES = ['kanban', 'threads', 'list', 'tree'] as const;
export type Structure = typeof STRUCTURES[number];
/** Every project starts as kanban; agents change it with set_structure. */
export const DEFAULT_STRUCTURE: Structure = 'kanban';
export const defaultStructure = (_app: string): Structure => DEFAULT_STRUCTURE;

type Kind = 'str' | 'int' | 'date' | 'time' | 'tz' | 'strs' | 'milestones' | 'stats' | 'nodes' | 'span';
interface Param { kind: Kind; required?: boolean }
/** Widget catalog: type -> allowed params (plus the common `title` and `span`). */
export const WIDGETS: Record<string, Record<string, Param>> = {
  countdown: { date: { kind: 'date', required: true }, time: { kind: 'time' }, tz: { kind: 'tz' }, label: { kind: 'str' } },
  stats: { items: { kind: 'stats' }, date: { kind: 'date' }, time: { kind: 'time' }, tz: { kind: 'tz' }, label: { kind: 'str' } },
  needs_you: { limit: { kind: 'int' } },
  running: { limit: { kind: 'int' } },
  recent: { days: { kind: 'int' }, limit: { kind: 'int' } },
  stages: { milestones: { kind: 'milestones' } },
  timeline: { milestones: { kind: 'milestones' } },
  map: { nodes: { kind: 'nodes' } },
  track: { match: { kind: 'strs', required: true }, milestones: { kind: 'milestones' }, limit: { kind: 'int' } },
  apps: {},
  /** The project's tasks in its structure (kanban / threads / list / tree). */
  work: { limit: { kind: 'int' } },
  /** "Ideas for later": the project's idea backlog (data/ideas/<app>.json), apart from tasks. */
  ideas: { limit: { kind: 'int' } },
  /** Dependency graph from depends_on: open cards, the longest open chain highlighted, unknown ids as their own node. */
  deps: {},
  /** The goal's why and its profile (lib/profile.ts): what works today, what is missing. */
  profile: {},
};
// Every text a human reads can come per language (title_ko / title_en); the plain field is the fallback.
const COMMON: Record<string, Param> = { title: { kind: 'str' }, title_ko: { kind: 'str' }, title_en: { kind: 'str' }, span: { kind: 'span' } };
for (const w of [WIDGETS.countdown, WIDGETS.stats]) { w.label_ko = { kind: 'str' }; w.label_en = { kind: 'str' }; }

export interface MapNode { label: string; label_ko?: string; label_en?: string; milestone?: string; match?: string[]; rest?: boolean }
export interface Widget { type: string; title?: string; span?: 'full' | 'half'; [k: string]: unknown }
export interface View {
  app: string; title: string; tagline: string; title_ko?: string; title_en?: string; tagline_ko?: string; tagline_en?: string;
  structure: Structure; widgets: Widget[];
  version: number; updated: string; updated_by: string; default?: boolean;
}

// ---------- defaults ----------
// Titles come in both languages (title_ko / title_en). A widget without a title gets the UI's own name for its type.
const T = (ko: string, en: string) => ({ title_ko: ko, title_en: en });
const NEEDS = { type: 'needs_you', ...T('내 차례', 'Your turn'), span: 'half' } as Widget;
const RUNNING = { type: 'running', ...T('지금 도는 일', 'Running now'), span: 'half' } as Widget;
const WORK = { type: 'work' } as Widget;
const IDEAS = { type: 'ideas' } as Widget;
// Layout: stat cards first, then the project's work in its structure, then the rest.
const DEFAULT_WIDGETS: Widget[] = [
  { type: 'stats', items: ['stage', 'needs_you', 'running', 'progress'] },
  { type: 'timeline', ...T('단계', 'Stages') },
  NEEDS, RUNNING, WORK, IDEAS,
];

/** The built-in view (it names no milestone, so it passes validation on any project). */
export function defaultView(app: string): View {
  const widgets: Widget[] = structuredClone(DEFAULT_WIDGETS);
  return { app, title: '', tagline: '', structure: defaultStructure(app), widgets, version: 0, updated: '', updated_by: '', default: true };
}

// ---------- validation ----------
const str = (v: unknown, max: number, where: string): string => {
  if (typeof v !== 'string') throw new Error(`${where} must be a string`);
  const s = v.replace(/[\r\n\t]+/g, ' ').trim();
  if (s.length > max) throw new Error(`${where} is over ${max} characters`);
  return s;
};

/** Milestone ids of this app's goal, for reference checks (omit to skip them). */
export type MilestoneIndex = Set<string> | undefined;

function param(kind: Kind, v: unknown, where: string, ms: MilestoneIndex): unknown {
  switch (kind) {
    case 'str': return str(v, 80, where);
    case 'int':
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 50) throw new Error(`${where} must be an integer 1-50`);
      return v;
    case 'date':
      if (typeof v !== 'string' || !isValidDate(v)) throw new Error(`${where} must be a date YYYY-MM-DD`);
      return v;
    case 'time':
      if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(`${where} must be HH:MM (24h)`);
      return v;
    case 'tz':
      if (typeof v !== 'string' || !/^[+-](0\d|1[0-4]):[0-5]\d$/.test(v)) throw new Error(`${where} must be a UTC offset like +09:00`);
      return v;
    case 'span':
      if (v !== 'full' && v !== 'half') throw new Error(`${where} must be "full" or "half"`);
      return v;
    case 'strs': {
      if (!Array.isArray(v) || !v.length || v.length > 20) throw new Error(`${where} must be a list of 1-20 strings`);
      return v.map((x, i) => { const s = str(x, 60, `${where}[${i}]`); if (!s) throw new Error(`${where}[${i}] is empty`); return s; });
    }
    case 'stats': {
      if (!Array.isArray(v) || !v.length || v.length > STAT_ITEMS.length) throw new Error(`${where} must be a list of ${STAT_ITEMS.join(', ')}`);
      for (const x of v) if (!(STAT_ITEMS as readonly string[]).includes(x)) throw new Error(`${where}: unknown item "${x}" (allowed: ${STAT_ITEMS.join(', ')})`);
      if (new Set(v).size !== v.length) throw new Error(`${where} has duplicates`);
      return v;
    }
    case 'milestones': {
      if (!Array.isArray(v) || !v.length || v.length > 30) throw new Error(`${where} must be a list of 1-30 milestone ids`);
      for (const x of v) {
        if (typeof x !== 'string') throw new Error(`${where} must be milestone id strings`);
        if (ms && !ms.has(x)) throw new Error(`${where}: unknown milestone "${x}" for this project`);
      }
      return v;
    }
    case 'nodes': {
      if (!Array.isArray(v) || !v.length || v.length > 24) throw new Error(`${where} must be a list of 1-24 nodes`);
      return v.map((n, i) => {
        const w = `${where}[${i}]`;
        if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error(`${w} must be an object {label, milestone?, match?, rest?}`);
        const bad = Object.keys(n).filter((k) => !['label', 'label_ko', 'label_en', 'milestone', 'match', 'rest'].includes(k));
        if (bad.length) throw new Error(`${w}: unknown field(s) ${bad.join(', ')}`);
        const out: MapNode = { label: str((n as any).label, 40, `${w}.label`) };
        if (!out.label) throw new Error(`${w}.label is empty`);
        for (const k of ['label_ko', 'label_en'] as const) if ((n as any)[k] !== undefined) { const l = str((n as any)[k], 40, `${w}.${k}`); if (l) out[k] = l; }
        if ((n as any).milestone !== undefined) {
          const m = (n as any).milestone;
          if (typeof m !== 'string' || (ms && !ms.has(m))) throw new Error(`${w}.milestone: unknown milestone "${m}" for this project`);
          out.milestone = m;
        }
        if ((n as any).match !== undefined) out.match = param('strs', (n as any).match, `${w}.match`, ms) as string[];
        if ((n as any).rest !== undefined) {
          if (typeof (n as any).rest !== 'boolean') throw new Error(`${w}.rest must be true or false`);
          out.rest = (n as any).rest;
        }
        if (!out.milestone && !out.match) throw new Error(`${w} needs a milestone or match`);
        if (out.rest && out.match) throw new Error(`${w}: rest collects the unmatched tasks, so it takes no match`);
        return out;
      });
    }
  }
}

export function validateWidget(w: unknown, i: number, ms: MilestoneIndex): Widget {
  const where = `widgets[${i}]`;
  if (!w || typeof w !== 'object' || Array.isArray(w)) throw new Error(`${where} must be an object with a "type"`);
  const type = (w as any).type;
  if (typeof type !== 'string' || !Object.hasOwn(WIDGETS, type)) throw new Error(`${where}: unknown type "${type}" (allowed: ${Object.keys(WIDGETS).join(', ')})`);
  const spec = { ...COMMON, ...WIDGETS[type] };
  const out: Widget = { type };
  for (const [k, v] of Object.entries(w)) {
    if (k === 'type') continue;
    if (!Object.hasOwn(spec, k)) throw new Error(`${where} (${type}): unknown field "${k}" (allowed: ${Object.keys(spec).join(', ')})`);
    out[k] = param(spec[k].kind, v, `${where}.${k}`, ms);
  }
  for (const [k, p] of Object.entries(spec)) if (p.required && out[k] === undefined) throw new Error(`${where} (${type}): "${k}" is required`);
  if (type === 'stats' && (out.items as string[] | undefined)?.includes('countdown') && out.date === undefined) throw new Error(`${where} (stats): the countdown item needs "date"`);
  return out;
}

export type ViewBody = Pick<View, 'title' | 'tagline' | 'title_ko' | 'title_en' | 'tagline_ko' | 'tagline_en' | 'widgets'> & { structure?: Structure };
const VIEW_FIELDS = ['app', 'title', 'tagline', 'title_ko', 'title_en', 'tagline_ko', 'tagline_en', 'structure', 'widgets', 'version', 'updated', 'updated_by', 'default'];

export function validateStructure(v: unknown): Structure {
  if (typeof v !== 'string' || !(STRUCTURES as readonly string[]).includes(v)) throw new Error(`structure must be one of ${STRUCTURES.join(', ')}`);
  return v as Structure;
}

/** Validate the editable part of a view. `app`, `version`, `updated`, `updated_by`, `default` may be echoed back from GET.
 *  `structure` is optional: a view sent without it keeps the project's current structure. */
export function validateView(app: string, input: unknown, ms: MilestoneIndex): ViewBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('view must be a JSON object');
  const o = input as Record<string, unknown>;
  const bad = Object.keys(o).filter((k) => !VIEW_FIELDS.includes(k));
  if (bad.length) throw new Error(`unknown field(s): ${bad.join(', ')} (a view has title, tagline, structure, widgets; title/tagline also as _ko/_en)`);
  if (o.app !== undefined && o.app !== app) throw new Error(`app "${String(o.app)}" does not match the URL (${app})`);
  if (!Array.isArray(o.widgets) || !o.widgets.length) throw new Error('widgets must be a non-empty list');
  if (o.widgets.length > MAX_WIDGETS) throw new Error(`at most ${MAX_WIDGETS} widgets`);
  const out: ViewBody = {
    title: o.title === undefined ? '' : str(o.title, 40, 'title'),
    tagline: o.tagline === undefined ? '' : str(o.tagline, 120, 'tagline'),
    widgets: o.widgets.map((w, i) => validateWidget(w, i, ms)),
  };
  for (const [k, max] of [['title_ko', 40], ['title_en', 40], ['tagline_ko', 120], ['tagline_en', 120]] as const) {
    if (o[k] === undefined) continue;
    const v = str(o[k], max, k);
    if (v) out[k] = v;
  }
  if (o.structure !== undefined) out.structure = validateStructure(o.structure);
  return out;
}

