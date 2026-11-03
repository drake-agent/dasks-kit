// Card spec store: each card's spec as versioned text next to its task file, which stays lean (8 KB cap).
//   data/specs/<goal>/<slug>.md                 current text (copy of the latest version)
//   data/specs/<goal>/<slug>/versions/<n>.md    the exact text of version n (authoritative)
//   data/specs/<goal>/<slug>/versions/<n>.json  {version, by, at, note, sha256, section_authors, warnings}
// A write commits all three under the repo lock, so a refusal or a failed commit leaves nothing behind.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError, commitFiles, isoLocal, readTask, updateTask, withRepoLock } from './write.ts';
import { assertProtectedWrite, fieldsAfterSpecWrite, reworkDone } from './spec-state.ts';
import { TASK_ID_RE, isTaskId } from './schema.ts';
import { checkCard } from './contract.ts';
import { loadConfig } from './config.ts';
import { touchesErrors, touchesValue } from './touches.ts';
import { doneLineCheck } from './done-line.ts';

export const SPEC_MAX_BYTES = 262_144;      // decoded spec text, UTF-8
export const SPEC_MAX_BODY = 2_097_152;     // raw JSON body of PUT /spec (a spec at the cap written as \uXXXX is ~1.5 MiB)
export const SPEC_NOTE_MAX_BYTES = 4_096;
export const SECTIONS = { acceptance_tests: 'Acceptance tests', oracle: 'Oracle' } as const;

export type SectionAuthor = { by: string; sha256: string } | null;
export type SectionAuthors = { acceptance_tests: SectionAuthor; oracle: SectionAuthor };
export interface SpecMeta { version: number; by: string; at: string; note: string; sha256: string }
export interface SpecView { text: string; metadata: SpecMeta; section_authors: SectionAuthors; warnings?: string[] }
export interface VersionRecord extends SpecMeta { section_authors: SectionAuthors; warnings: string[] }
export interface SpecPut { text: string; expected: number; note: string }

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Server time as ISO-8601 with this machine's offset. */
export const isoNow = (d = new Date()): string => isoLocal(d);

/** Repo-relative paths of one task's spec files. */
export function specPaths(id: string) {
  const m = TASK_ID_RE.exec(id);
  if (!m || !isTaskId(id)) throw new HttpError(400, `bad task id "${id}"`);
  const dir = path.join('data', 'specs', m[1], m[2]);
  return { current: `${dir}.md`, text: (n: number) => path.join(dir, 'versions', `${n}.md`), meta: (n: number) => path.join(dir, 'versions', `${n}.json`), versions: path.join(dir, 'versions') };
}

/** The highest stored version (0 = no spec yet). */
export function currentSpecVersion(root: string, id: string): number {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(root, specPaths(id).versions)); } catch { return 0; }
  return names.reduce((n, f) => { const m = /^([1-9]\d{0,8})\.json$/.exec(f); return m ? Math.max(n, Number(m[1])) : n; }, 0);
}

function view(text: string, r: VersionRecord): SpecView {
  const { section_authors, warnings, ...metadata } = r;
  return { text, metadata: { version: metadata.version, by: metadata.by, at: metadata.at, note: metadata.note, sha256: metadata.sha256 }, section_authors, ...(warnings.length ? { warnings } : {}) };
}

/** GET: the current spec, or version `version`. 404 with current_spec_version when there is none. */
export function readSpec(root: string, id: string, version?: number): SpecView {
  // Under the repo lock: another process sharing the repo may be between writing versions/<n>.* and its commit (which
  // can still roll back), and that version must not be shown yet.
  return withRepoLock(root, () => readSpecUnlocked(root, id, version));
}
/** readSpec without taking the lock: for callers that hold it (or read a committed version). */
export function readSpecUnlocked(root: string, id: string, version?: number): SpecView {
  const cur = currentSpecVersion(root, id);
  if (!cur) throw new HttpError(404, `${id} has no spec yet`, { current_spec_version: 0 });
  const n = version ?? cur;
  if (n > cur) throw new HttpError(404, `${id} has no spec version ${n}`, { current_spec_version: cur });
  const p = specPaths(id);
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(root, p.meta(n)), 'utf8')) as VersionRecord;
    return view(fs.readFileSync(path.join(root, p.text(n)), 'utf8'), rec);
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new HttpError(404, `${id} has no spec version ${n}`, { current_spec_version: cur });
    throw e;
  }
}

/** `?version=`: absent → latest; else a positive integer (400 otherwise). */
export function parseVersionParam(v: string | null): number | undefined {
  if (v === null) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(v)) throw new HttpError(400, 'version must be a positive integer');
  return Number(v);
}

/** Request shape of PUT /spec (400): {text, expected_spec_version, note?}, nothing else. */
export function parseSpecPut(body: Record<string, unknown>): SpecPut {
  const extra = Object.keys(body).filter((k) => !['text', 'expected_spec_version', 'note'].includes(k));
  if (extra.length) throw new HttpError(400, `unknown field(s) for a spec write: ${extra.join(', ')} (takes text, expected_spec_version, note)`);
  const { text, expected_spec_version: ev, note = '' } = body;
  if (typeof text !== 'string') throw new HttpError(400, 'text is required (the whole spec, a string)');
  // A lone surrogate would be stored as U+FFFD: the bytes kept would not be the text sent.
  if (!text.isWellFormed()) throw new HttpError(400, 'text is not valid Unicode (lone surrogate)');
  if (typeof ev !== 'number' || !Number.isSafeInteger(ev) || ev < 0)
    throw new HttpError(400, 'expected_spec_version is required: the spec version you last read (0 for the first write)');
  if (typeof note !== 'string' || !note.isWellFormed()) throw new HttpError(400, 'note must be a string');
  if (utf8Bytes(note) > SPEC_NOTE_MAX_BYTES) throw new HttpError(400, `note is over ${SPEC_NOTE_MAX_BYTES} bytes`);
  return { text, expected: ev, note };
}

/** 413 when the decoded text is over the cap. */
export function assertSpecSize(text: string): void {
  const n = utf8Bytes(text);
  if (n > SPEC_MAX_BYTES) throw new HttpError(413, `spec is ${n} bytes; the cap is ${SPEC_MAX_BYTES}`, { bytes: n, max_bytes: SPEC_MAX_BYTES });
}

/** A `## <name>` section: from its heading line (the first line starting with `## <name>` and no more letters) through
 *  the line before the next `## ` heading, or the end of the text, exact bytes. null when there is none. */
export function sectionOf(text: string, name: string): string | null {
  const head = new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u');
  // Lines end at \r\n, \r or \n, as the contract check reads them (a CR-only card keeps its section authors).
  const eol = /\r\n|\r|\n/g;
  let start = -1, pos = 0;
  for (;;) {
    const m = eol.exec(text);
    const line = text.slice(pos, m ? m.index : text.length);
    if (start < 0) { if (head.test(line)) start = pos; }
    else if (line.startsWith('## ')) return text.slice(start, pos);
    if (!m) break;
    pos = m.index + m[0].length;
  }
  return start < 0 ? null : text.slice(start);
}

/** Each section's author: kept while its hash stays the same as in the previous version, else the writer of this one;
 *  null when the section is gone. An old hash coming back never hands the section back to its old author. */
export function nextSectionAuthors(prev: SectionAuthors, text: string, actor: string): SectionAuthors {
  const out = {} as SectionAuthors;
  for (const k of Object.keys(SECTIONS) as (keyof SectionAuthors)[]) {
    const s = sectionOf(text, SECTIONS[k]);
    if (s === null) { out[k] = null; continue; }
    const h = sha256(s);
    out[k] = prev[k]?.sha256 === h ? prev[k] : { by: actor, sha256: h };
  }
  return out;
}

/** PUT /spec after the shape, task and size checks: version (409) → contract and touches (422) → protected sections (403)
 *  → commit a new version, with the task's spec fields when they change. */
export function writeSpec(root: string, id: string, put: SpecPut, actor: string, now = new Date()): SpecView {
  return withRepoLock(root, () => {
    const w = prepareSpecWrite(root, id, put, actor, now);
    // The task's spec fields (review cleared, or carried over an auto-ok-only change; state recomputed) go in the same
    // commit when they change.
    const task = readTask(root, id);
    const f = fieldsAfterSpecWrite(task, { text: w.text, version: w.rec.version }, w.prevText);
    // A spec-rework card goes back to the pool (src/lib/park.ts) only when its spec turns ready: here only the auto-ok
    // carry of a pass; a draft still waits for its review (reviewSpec / unblockSpec move it then).
    const lane = reworkDone(task, f.spec_state);
    if (lane || f.spec_state !== task.spec_state || task.spec_review != null) updateTask(root, id, lane ?? {}, actor, { specFields: f, action: 'spec', extraFiles: w.files, now, warnings: [] });
    else commitFiles(root, w.files, `${actor}: spec ${id} v${w.rec.version}`);
    return view(w.text, w.rec);
  });
}

/** Every check of a spec write and the three files it would commit, without committing them. The caller holds the repo
 *  lock and commits `files` itself (writeSpec, or a task write that carries the spec in the same commit). */
/** Do two spec texts name the same implementer and reviewer (header impl / review lines, as checkCard reads them)? */
function samePair(a: string, b: string): boolean {
  const fa = checkCard(a).fields, fb = checkCard(b).fields;
  return (fa.impl ?? '') === (fb.impl ?? '') && (fa.review ?? '') === (fb.review ?? '');
}

export function prepareSpecWrite(root: string, id: string, put: SpecPut, actor: string, now = new Date()): { text: string; prevText: string | undefined; rec: VersionRecord; files: { rel: string; content: string }[]; view: () => SpecView } {
  const p = specPaths(id);
  const cur = currentSpecVersion(root, id);
  if (put.expected !== cur)
    throw new HttpError(409, `spec of ${id} is at version ${cur}, not ${put.expected}: re-read it (GET /api/tasks/${id}/spec) and retry`, { current_spec_version: cur });
  const text = put.text;
  const verdict = checkCard(text, loadConfig(root).families);
  const prevText = cur ? fs.readFileSync(path.join(root, p.text(cur)), 'utf8') : undefined;
  // The pair rule judges a new spec, or a write that changes the impl / review lines: a stored pair this write leaves as
  // it is (an older spec's model names, say) is a warning, so a body edit or the user's auto-ok answer still goes through.
  if (prevText !== undefined && samePair(prevText, text)) {
    const pair = verdict.errors.filter((e) => e.startsWith('PAIR REFUSED'));
    verdict.errors = verdict.errors.filter((e) => !pair.includes(e));
    verdict.warnings.push(...pair.map((e) => `${e} (kept: this write does not change impl or review)`));
  }
  // Only a touches line this write changes is judged: a body edit or the user's auto-ok answer on a card whose touches line
  // is prose still goes through.
  const touches = touchesValue(text);
  if (prevText === undefined || touches !== touchesValue(prevText)) verdict.errors.push(...touchesErrors(touches));
  // The finish line (done_when / done_at): required on a first spec and once a card has one; older specs warn.
  const dl = doneLineCheck(text, prevText);
  verdict.errors.push(...dl.errors); verdict.warnings.push(...dl.warnings);
  if (verdict.errors.length)
    throw new HttpError(422, `the spec breaks the card contract (${verdict.errors.length} reason${verdict.errors.length > 1 ? 's' : ''})`, { reasons: verdict.errors, warnings: verdict.warnings });
  const prev: SectionAuthors = cur ? (JSON.parse(fs.readFileSync(path.join(root, p.meta(cur)), 'utf8')) as VersionRecord).section_authors : { acceptance_tests: null, oracle: null };
  // 403 last: a claimant of this card adding, changing, removing or restoring Acceptance / Oracle.
  assertProtectedWrite(root, id, prevText ?? '', text, actor);
  const n = cur + 1;
  const rec: VersionRecord = { version: n, by: actor, at: isoNow(now), note: put.note, sha256: sha256(text), section_authors: nextSectionAuthors(prev, text, actor), warnings: verdict.warnings };
  const files = [
    { rel: p.text(n), content: text },
    { rel: p.meta(n), content: JSON.stringify(rec, null, 1) + '\n' },
    { rel: p.current, content: text },
  ];
  return { text, prevText, rec, files, view: () => view(text, rec) };
}
