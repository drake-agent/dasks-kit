// Check items (docs/cards.md "Check items"): a card's `## Done criteria` (or its spec's `pass_checks:`) split into items,
// each with a state, a one-line result and evidence references, in data/items/<goal>/<slug>.json. The file holds the
// current view (`items`) and an append-only audit trail (`events`): every seed or report appends one event and is one
// git commit under the repo lock. References only, never file bytes. Optional and warn-only: a report never changes the
// task's status, claim or spec state.
import fs from 'node:fs';
import path from 'node:path';
import { ACTOR_RE, TASK_ID_RE, isTaskId } from './schema.ts';
import { HttpError, commitFiles, isoLocal, readTask, taskRelPath, withRepoLock } from './write.ts';
import { looksLikeToken } from './outcome.ts';
import { isEvidence } from './transitions.ts';
import { readSpecUnlocked } from './specs.ts';

export const ITEM_STATES = ['open', 'done', 'failed'] as const;
export type ItemState = typeof ITEM_STATES[number];
export const EVIDENCE_KINDS = ['pr', 'commit', 'log', 'screenshot', 'video', 'tests'] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
export const MAX_ITEMS = 30;
export const MAX_ITEM_TEXT = 300;
export const MAX_RESULT = 200;
export const MAX_EVIDENCE = 10;
export const MAX_REF = 500;

export interface Evidence { kind: EvidenceKind; ref: string }
export interface Item { n: number; text: string; state: ItemState; result: string; evidence: Evidence[]; by: string; at: string; host: string }
export type ItemEvent =
  | { type: 'seed'; version: number; by: string; at: string; source: 'body' | 'spec'; items: string[]; kept: { n: number; from_n: number }[]; retired: string[] }
  | { type: 'report'; version: number; by: string; at: string; n: number; text: string; state: ItemState; result: string; evidence: Evidence[]; host: string };
export interface ItemsFile { task: string; version: number; source: 'body' | 'spec'; seeded_at: string; items: Item[]; events: ItemEvent[] }

/** Repo-relative store path: data/items/<goal>/<t-slug>.json (the id split like specs.ts specPaths). */
export function itemsRelPath(id: string): string {
  const m = TASK_ID_RE.exec(id);
  if (!m || !isTaskId(id)) throw new HttpError(400, `bad task id "${id}"`);
  return path.join('data', 'items', m[1], `${m[2]}.json`);
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const tokenErr = (what: string) => new HttpError(400, `${what} looks like a credential; remove it (items never store secrets)`, { rule: 'token-like' });

// ---------- seed sources ----------
/** Lines outside Markdown code fences, with their 1-based line numbers. A fence opens with ≤3 spaces and ≥3 backticks or
 *  tildes and closes with the same character, at least as many, and nothing after it. */
function unfenced(text: string): { line: string; no: number }[] {
  const out: { line: string; no: number }[] = [];
  let fence: { ch: string; len: number } | null = null;
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) { fence = { ch: m[1][0], len: m[1].length }; return; }
      out.push({ line, no: i + 1 });
    } else if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) fence = null;
  });
  return out;
}

/** The numbered lines (`1. …` at column 0) of the first `## Done criteria` section, or null when there are none. */
export function doneCriteria(body: string): string[] | null {
  const lines = unfenced(body);
  const start = lines.findIndex((l) => /^## Done criteria\s*$/.test(l.line));
  if (start < 0) return null;
  const out: string[] = [];
  for (const { line } of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    // `<digits>. ` at column 0; a bare `<digits>.` (trailing space trimmed by an editor) is an empty item, refused later.
    const m = /^\d+\.(?: (.*))?$/.exec(line);
    if (m) out.push(m[1] ?? '');
  }
  return out.length ? out : null;
}

/** The `- ` lines right after the first `pass_checks:` line at column 0 (outside fences), or null when there are none. */
export function passChecks(spec: string): string[] | null {
  const lines = unfenced(spec);
  const start = lines.findIndex((l) => /^pass_checks:/.test(l.line));
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && lines[i].no === lines[i - 1].no + 1 && lines[i].line.startsWith('- '); i++) out.push(lines[i].line.slice(2));
  return out.length ? out : null;
}

function seedTexts(root: string, id: string, body: string): { source: 'body' | 'spec'; texts: string[] } {
  let source: 'body' | 'spec' = 'body';
  let raw = doneCriteria(body);
  if (!raw) {
    let spec: string | null = null;
    try { spec = readSpecUnlocked(root, id).text; } catch (e) { if (!(e instanceof HttpError && e.status === 404)) throw e; }
    raw = spec === null ? null : passChecks(spec);
    source = 'spec';
  }
  if (!raw) throw new HttpError(409, `no done criteria: ${id} has no numbered "## Done criteria" list and no spec pass_checks`);
  const where = source === 'body' ? 'Done criteria' : 'pass_checks';
  if (raw.length > MAX_ITEMS) throw new HttpError(400, `${where} has ${raw.length} items; at most ${MAX_ITEMS}`);
  const texts = raw.map((r, i) => {
    const t = norm(r);
    if (!t) throw new HttpError(400, `${where} line ${i + 1} is empty`);
    if (t.length > MAX_ITEM_TEXT) throw new HttpError(400, `${where} line ${i + 1} is over ${MAX_ITEM_TEXT} characters (${t.length})`);
    if (looksLikeToken(t)) throw tokenErr(`${where} line ${i + 1}`);
    return t;
  });
  return { source, texts };
}

// ---------- evidence ----------
const URL_RE = /^https:\/\/([^/?#\s]+)(\/[^?#\s]*)?$/;
const GH = String.raw`^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+`;
const PR_RE = new RegExp(`${GH}\\/pull\\/[1-9]\\d*$`);
const COMMIT_RE = new RegExp(`${GH}\\/commit\\/[0-9a-f]{7,40}$`);
const IMAGE_RE = /\.(?:png|jpe?g|webp)$/i;
const VIDEO_RE = /\.(?:mp4|mov|webm)$/i;

const isUrl = (ref: string) => /^[a-z][a-z0-9+.-]*:/i.test(ref);
/** An https URL with no userinfo, query or fragment that also parses as a URL (a bad port such as `https://x:abc/` does
 *  not). */
const goodUrl = (ref: string) => {
  const m = URL_RE.exec(ref);
  if (!m || m[1].includes('@')) return false;
  try { const u = new URL(ref); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password; } catch { return false; }
};
/** Absolute or under .dask/logs/, no whitespace, control chars or `..` segment. */
const goodPath = (ref: string) => (ref.startsWith('/') || ref.startsWith('.dask/logs/')) && !/\s/.test(ref) && !CONTROL.test(ref) && !/(^|\/)\.\.(\/|$)/.test(ref);

/** Shape-check an evidence list (the server cannot see the reporting host's files). Paths for log/screenshot/video need
 *  a host. 400 naming the bad index. */
export function checkEvidence(v: unknown, host: string): Evidence[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, 'evidence must be a list of {kind, ref}');
  if (v.length > MAX_EVIDENCE) throw new HttpError(400, `evidence: at most ${MAX_EVIDENCE} entries`);
  return v.map((e, i) => {
    const bad = (why: string) => new HttpError(400, `evidence[${i}]: ${why}`);
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw bad('must be {kind, ref}');
    const extra = Object.keys(e).filter((k) => k !== 'kind' && k !== 'ref');
    if (extra.length) throw bad(`unknown field(s) ${extra.join(', ')} (evidence is {kind, ref})`);
    const { kind, ref } = e as Record<string, unknown>;
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind as string)) throw bad(`kind must be one of ${EVIDENCE_KINDS.join('|')}`);
    if (typeof ref !== 'string' || !ref) throw bad('ref must be a nonempty string');
    if (ref.length > MAX_REF) throw bad(`ref is over ${MAX_REF} characters`);
    if (CONTROL.test(ref) || /\s/.test(ref)) throw bad('ref has whitespace or control characters');
    let decoded: string;
    try { decoded = decodeURIComponent(ref); } catch { throw bad('ref has a malformed %-escape'); }
    if (CONTROL.test(decoded) || /\s/.test(decoded) || /(^|\/)\.\.(\/|$)/.test(decoded)) throw bad('ref (decoded) has whitespace, control characters or a .. segment');
    if (looksLikeToken(ref) || looksLikeToken(decoded)) throw tokenErr(`evidence[${i}]`);
    const url = isUrl(ref);
    if (url && !goodUrl(ref)) throw bad('a URL must be https with no user@, query or fragment');
    if (!url && /(^|\/)\.\.(\/|$)/.test(ref)) throw bad('a path may not have a .. segment');
    const needPath = () => { if (!goodPath(ref)) throw bad('a path must be absolute (/…) or start with .dask/logs/, with no whitespace or .. segment'); if (!host) throw bad(`a ${kind} path needs the report's host (the machine that has the file)`); };
    switch (kind as EvidenceKind) {
      case 'pr': if (!PR_RE.test(ref) || !isEvidence(ref)) throw bad('pr must be https://github.com/<owner>/<repo>/pull/<n>'); break;
      case 'commit': if (!COMMIT_RE.test(ref)) throw bad('commit must be https://github.com/<owner>/<repo>/commit/<7-40 hex>'); break;
      case 'log': if (url) throw bad('log is a path, not a URL'); if (!isEvidence(ref)) throw bad('log must be a RESULT.md or .log path'); needPath(); break;
      case 'screenshot': if (!IMAGE_RE.test(ref)) throw bad('screenshot must end .png, .jpg, .jpeg or .webp'); if (!url) needPath(); break;
      case 'video': if (!VIDEO_RE.test(ref)) throw bad('video must end .mp4, .mov or .webm'); if (!url) needPath(); break;
      case 'tests': {
        const m = /^(\d{1,9})\/(\d{1,9})$/.exec(ref);
        if (!m || Number(m[1]) > Number(m[2])) throw bad('tests must be <passed>/<total> with passed ≤ total');
        break;
      }
    }
    return { kind: kind as EvidenceKind, ref };
  });
}

// ---------- store ----------
function validStore(o: any): o is ItemsFile {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (!Number.isInteger(o.version) || o.version < 1 || !Array.isArray(o.items) || !Array.isArray(o.events)) return false;
  const evOk = (e: any) => e && typeof e === 'object' && typeof e.kind === 'string' && typeof e.ref === 'string';
  if (!o.items.every((i: any) => i && typeof i === 'object' && Number.isInteger(i.n) && typeof i.text === 'string'
    && (ITEM_STATES as readonly string[]).includes(i.state) && typeof i.result === 'string' && Array.isArray(i.evidence) && i.evidence.every(evOk))) return false;
  return o.events.every((e: any) => e && typeof e === 'object' && (e.type === 'seed' || e.type === 'report') && Number.isInteger(e.version));
}

/** The stored file, null when never seeded; 500 `items store unreadable` when it does not parse or has the wrong shape. */
function readStore(root: string, id: string): ItemsFile | null {
  let raw: string;
  try { raw = fs.readFileSync(path.join(root, itemsRelPath(id)), 'utf8'); } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw new HttpError(500, `items store unreadable (${e.code ?? 'error'})`);
  }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { throw new HttpError(500, 'items store unreadable (not JSON)'); }
  if (!validStore(o)) throw new HttpError(500, 'items store unreadable (wrong shape)');
  return o;
}

export interface ItemsView {
  task: string; version: number; source?: 'body' | 'spec'; seeded_at?: string; progress: { done: number; total: number };
  items: Item[]; events?: ItemEvent[]; warnings?: string[];
}
function view(id: string, f: ItemsFile | null, history = false): ItemsView {
  if (!f) return { task: id, version: 0, progress: { done: 0, total: 0 }, items: [], ...(history ? { events: [] } : {}) };
  return {
    task: id, version: f.version, source: f.source, seeded_at: f.seeded_at,
    progress: { done: f.items.filter((i) => i.state === 'done').length, total: f.items.length },
    items: f.items,
    ...(history ? { events: f.events } : {}),
  };
}

function assertTask(root: string, id: string): void {
  if (!isTaskId(id)) throw new HttpError(400, 'bad task id');
  if (!fs.existsSync(path.join(root, taskRelPath(id)))) throw new HttpError(404, `no task "${id}"`);
}

/** GET …/items: no lock (commitFiles writes atomically, so a read sees the old or the new file). */
export function itemsView(root: string, id: string, opts: { history?: boolean } = {}): ItemsView {
  assertTask(root, id);
  return view(id, readStore(root, id), !!opts.history);
}

/** "<done>/<total>" for the single-task GET; undefined when the card has no items or the store is unreadable. */
export function itemsProgress(root: string, id: string): string | undefined {
  try {
    const abs = path.join(root, itemsRelPath(id));
    if (!fs.existsSync(abs)) return undefined;
    const f = readStore(root, id);
    if (!f || !f.items.length) return undefined;
    return `${f.items.filter((i) => i.state === 'done').length}/${f.items.length}`;
  } catch { return undefined; }
}

function checkActor(actor: string): void {
  if (!ACTOR_RE.test(actor)) throw new HttpError(400, 'bad actor');
  if (looksLikeToken(actor)) throw tokenErr('the actor (X-Dasks-Actor)');
}
function checkVersion(f: ItemsFile | null, expected: number | undefined): void {
  const cur = f?.version ?? 0;
  if (expected !== undefined && expected !== cur)
    throw new HttpError(409, `version conflict: items of this card are at version ${cur}, you sent ${expected}; re-read them and retry`, { current_version: cur });
}
function parseExpected(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new HttpError(400, 'expected_version must be a non-negative integer');
  return v;
}
function write(root: string, id: string, f: ItemsFile, actor: string, what: 'seed' | 'report'): void {
  commitFiles(root, [{ rel: itemsRelPath(id), content: JSON.stringify(f, null, 1) + '\n' }], `${actor}: items ${id} ${what}`);
}

export interface ItemsOpts { now?: Date }

/** POST …/items/seed {expected_version?}: (re)build the items from the card. An existing item whose text equals a new
 *  item's text keeps its result (one to one, in order); new texts start open; unmatched old texts are retired. */
export function seedItems(root: string, id: string, body: Record<string, unknown>, actor: string, opts: ItemsOpts = {}): ItemsView {
  const extra = Object.keys(body).filter((k) => k !== 'expected_version');
  if (extra.length) throw new HttpError(400, `unknown field(s): ${extra.join(', ')} (a seed takes only expected_version)`);
  const expected = parseExpected(body.expected_version);
  if (!isTaskId(id)) throw new HttpError(400, 'bad task id');
  checkActor(actor);
  return withRepoLock(root, () => {
    const task = readTask(root, id);
    const cur = readStore(root, id);
    checkVersion(cur, expected);
    const { source, texts } = seedTexts(root, id, task.body);
    const old = cur?.items ?? [];
    const used = new Set<number>();
    const kept: { n: number; from_n: number }[] = [];
    const items: Item[] = texts.map((text, k) => {
      const j = old.findIndex((o, x) => !used.has(x) && o.text === text);
      if (j < 0) return { n: k + 1, text, state: 'open', result: '', evidence: [], by: '', at: '', host: '' };
      used.add(j);
      kept.push({ n: k + 1, from_n: old[j].n });
      return { ...old[j], n: k + 1, host: old[j].host ?? '' };
    });
    const retired = old.filter((_, x) => !used.has(x)).map((o) => o.text);
    const version = (cur?.version ?? 0) + 1;
    const at = isoLocal(opts.now);
    const next: ItemsFile = { task: id, version, source, seeded_at: at, items, events: [...(cur?.events ?? []), { type: 'seed', version, by: actor, at, source, items: texts, kept, retired }] };
    write(root, id, next, actor, 'seed');
    return { ...view(id, next), warnings: [] };
  });
}

/** POST …/items/:n {state, result?, evidence?, host?, expected_version?}: the item's full current result. by/at are
 *  stamped here. Never touches the task. `done` without evidence is allowed and warned about. */
export function reportItem(root: string, id: string, nRaw: string, body: Record<string, unknown>, actor: string, opts: ItemsOpts = {}): ItemsView {
  const extra = Object.keys(body).filter((k) => !['state', 'result', 'evidence', 'host', 'expected_version'].includes(k));
  if (extra.length) throw new HttpError(400, `unknown field(s): ${extra.join(', ')} (a report takes state, result, evidence, host, expected_version)`);
  if (!/^[1-9]\d{0,2}$/.test(nRaw)) throw new HttpError(400, 'item number must be a positive integer');
  const n = Number(nRaw);
  const state = ITEM_STATES.find((s) => s === body.state);
  if (!state) throw new HttpError(400, `state must be ${ITEM_STATES.join('|')}`);
  if (body.result !== undefined && body.result !== null && typeof body.result !== 'string') throw new HttpError(400, 'result must be a string');
  const rawResult = typeof body.result === 'string' ? body.result : '';
  if (CONTROL.test(rawResult)) throw new HttpError(400, 'result must be one line with no control characters');
  const result = rawResult.trim();
  if (result.length > MAX_RESULT) throw new HttpError(400, `result is over ${MAX_RESULT} characters`);
  if (body.host !== undefined && body.host !== null && (typeof body.host !== 'string' || !ACTOR_RE.test(body.host))) throw new HttpError(400, 'host must be a short machine label such as laptop');
  const host = typeof body.host === 'string' ? body.host : '';
  if (looksLikeToken(result)) throw tokenErr('result');
  if (host && looksLikeToken(host)) throw tokenErr('host');
  const evidence = checkEvidence(body.evidence, host);
  const expected = parseExpected(body.expected_version);
  if (!isTaskId(id)) throw new HttpError(400, 'bad task id');
  checkActor(actor);
  return withRepoLock(root, () => {
    assertTask(root, id);
    const cur = readStore(root, id);
    const old = cur?.items.find((i) => i.n === n);
    if (!cur || !old) throw new HttpError(404, `no item ${n} on ${id}${cur ? ` (it has ${cur.items.length})` : ' (not seeded yet)'}`);
    checkVersion(cur, expected);
    const version = cur.version + 1;
    const at = isoLocal(opts.now);
    const item: Item = { n, text: old.text, state, result, evidence, by: actor, at, host };
    const next: ItemsFile = { ...cur, version, items: cur.items.map((i) => (i.n === n ? item : i)), events: [...cur.events, { type: 'report', version, by: actor, at, n, text: old.text, state, result, evidence, host }] };
    write(root, id, next, actor, 'report');
    return { ...view(id, next), warnings: state === 'done' && !evidence.length ? ['done without evidence'] : [] };
  });
}
