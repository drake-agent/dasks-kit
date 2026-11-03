// Shared rules for many writers on one card: the "## Context" block (what/why/do/rec/after, any language), the
// review/blocked-on-user context rule, claim holders and the activity log.
import fs from 'node:fs';
import path from 'node:path';
import { type Task, TASK_ID_RE } from './schema.ts';

// ---------- context block ----------
// API field -> body label. The UI (public/app.js ctxOf) reads the same labels.
export const CONTEXT_FIELDS = ['what', 'why', 'do', 'rec', 'after'] as const;
export type ContextField = typeof CONTEXT_FIELDS[number];
export const CONTEXT_LABEL: Record<ContextField | 'pr_summary', string> = {
  what: 'What', why: 'Why', do: 'Do', rec: 'Recommend', after: 'After', pr_summary: 'PR summary',
};
export type Context = Partial<Record<ContextField, string>>;

/** A context field counts when it has real text (any language). */
const TEXT = /[\p{L}\p{N}]/u;
const BLOCK_RE = /(^|\n)## Context[ \t]*\n([\s\S]*?)(?=\n## |$)/;

/** Parse the "## Context" block of a body into API fields (unknown labels are ignored). */
export function parseContext(body: string): (Context & { pr_summary?: string }) | null {
  const m = BLOCK_RE.exec(body || '');
  if (!m) return null;
  const byLabel = new Map(Object.entries(CONTEXT_LABEL).map(([k, v]) => [v, k]));
  const out: Record<string, string> = {};
  let last = '';
  for (const raw of m[2].split('\n')) {
    const line = raw.trim();
    const k = /^([^:]{1,10}):\s*(.*)$/.exec(line);
    if (k) { last = byLabel.get(k[1].trim()) ?? ''; if (last) out[last] = k[2].trim(); continue; }
    if (line && last) out[last] += ' ' + line; // wrapped continuation line
  }
  return out;
}

/** Pick context fields out of a request body. Throws a message for non-string values. */
export function pickContext(input: Record<string, unknown>): Context | undefined {
  let found = false;
  const out: Context = {};
  for (const k of CONTEXT_FIELDS) {
    const v = input[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new Error(`context field "${k}" must be a string`);
    out[k] = v.replace(/\s+/g, ' ').trim().slice(0, 600);
    found = true;
  }
  return found ? out : undefined;
}

/** Write the context into the body's "## Context" block (merged with what is already there), placed first.
 *  prSummary: undefined = keep the block's PR summary, '' = remove it, text = set it (mirrors the pr_summary field). */
export function applyContext(body: string, ctx: Context, prSummary?: string): string {
  const cur = parseContext(body) ?? {};
  const merged: Record<string, string> = { ...cur, ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => v)) };
  if (prSummary !== undefined) {
    const p = prSummary.replace(/\s+/g, ' ').trim();
    if (p) merged.pr_summary = p; else delete merged.pr_summary;
  }
  const lines = [...CONTEXT_FIELDS, 'pr_summary' as const].filter((k) => merged[k]).map((k) => `${CONTEXT_LABEL[k]}: ${merged[k]}`);
  // Keep lines of the old block that are not context fields (e.g. a "Ref: 12" line someone added).
  const old = BLOCK_RE.exec(body || '');
  if (old) {
    const own = new Set(Object.values(CONTEXT_LABEL));
    for (const l of old[2].split('\n')) { const k = /^([^:]{1,10}):/.exec(l.trim()); if (k && !own.has(k[1].trim())) lines.push(l.trim()); }
  }
  const block = `## Context\n${lines.join('\n')}\n`;
  const rest = (old ? body.replace(BLOCK_RE, '$1') : body || '').replace(/^\s+/, '');
  return `\n${block}${rest ? '\n' + rest.replace(/\s+$/, '') + '\n' : ''}`;
}

export const NEEDS_CONTEXT = ['review', 'blocked-on-user'];

/** Enforced on the server: review / blocked-on-user need the context what/why/do/rec/after (+ a PR summary with a PR),
 *  in any language. */
export function contextErrors(t: Pick<Task, 'status' | 'body' | 'pr' | 'pr_summary'>): string[] {
  if (!NEEDS_CONTEXT.includes(t.status)) return [];
  const c = parseContext(t.body) ?? {};
  const missing = CONTEXT_FIELDS.filter((k) => !c[k] || !TEXT.test(c[k]!));
  const errs: string[] = [];
  if (missing.length)
    errs.push(`status ${t.status} needs context: ${missing.join(', ')} (${missing.map((k) => CONTEXT_LABEL[k]).join(', ')}) — pass them as fields what/why/do/rec/after`);
  if (t.pr && !TEXT.test(t.pr_summary || '')) errs.push(`status ${t.status} with a PR needs a pr_summary`);
  return errs;
}

/** Writers the context rule does not apply to: the human in the UI, plus config `context_exempt_actors`. */
export function contextExempt(actor: string, extra: string[] = []): boolean {
  return ['user', ...extra].includes(actor);
}

// ---------- claims ----------
export const TERMINAL = ['done', 'cancelled'];

/** Who currently holds the task: an explicit claim, else the owner of a running task. */
export function holderOf(t: Pick<Task, 'status' | 'owner' | 'claimed_by'>): string {
  if (TERMINAL.includes(t.status)) return '';
  return t.claimed_by || (t.status === 'doing' ? t.owner : '');
}

// ---------- activity log ----------
// One JSON line per write, in data/activity/<app>/<t-…>.jsonl, committed together with the task file.
export interface Activity { at: string; actor: string; action: string; from?: string; to?: string; note?: string }
export const MAX_ACTIVITY = 200;

export function activityRelPath(id: string): string {
  const m = TASK_ID_RE.exec(id);
  if (!m) throw new Error(`bad task id "${id}"`);
  return path.join('data', 'activity', m[1], `${m[2]}.jsonl`);
}

export function readActivity(root: string, id: string, limit = MAX_ACTIVITY): Activity[] {
  let text = '';
  try { text = fs.readFileSync(path.join(root, activityRelPath(id)), 'utf8'); } catch { return []; }
  const out: Activity[] = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* skip bad line */ } }
  return out.slice(-limit);
}

export function activityContent(root: string, id: string, entry: Activity): string {
  const clean: Activity = { at: entry.at, actor: entry.actor, action: entry.action };
  if (entry.from) clean.from = entry.from;
  if (entry.to) clean.to = entry.to;
  if (entry.note) clean.note = entry.note.replace(/\s+/g, ' ').trim().slice(0, 200);
  const all = [...readActivity(root, id, MAX_ACTIVITY - 1), clean];
  return all.map((a) => JSON.stringify(a)).join('\n') + '\n';
}
