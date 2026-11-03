// Spec state, Spec blocks and the ready rules (docs/cards.md "Spec review"): "blocked for Spec" lives on the board, the
// implementer can't write its own answer key, and every card (any size) needs a cross-family review of the card text.
//   task frontmatter     spec_state, blocked_by, blocked_at, block_note, blocked_spec_version, spec_review
//   data/claims/<goal>/<slug>.json   {partial, who[]}: every successful claim's effective who
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gitCommonDir, GIT_BOUND, gitTimeoutNamed, HttpError, readTask, updateTask, withRepoLock } from './write.ts';
import { parseFrontmatter, taskFromParsed } from './load.ts';
import { familyFor, TASK_ID_RE, type Family, type SpecReview, type SpecState, type Task } from './schema.ts';
import { readActivity } from './collab.ts';
import { checkCard } from './contract.ts';
import { blockNoteError } from './check.ts';
import { currentSpecVersion, isoNow, readSpecUnlocked, sectionOf, SECTIONS, specPaths, type SpecView } from './specs.ts';
import { cardDeps, cardRepo, cardSize, cardTouches, field } from './card-fields.ts';
import { sameExceptAutoOk } from '../../public/user-ask.js';

// ---------- families ----------

// Config `families` (exact id or `prefix*` → family) is validated at startup: lib/config.ts familiesConfigErrors.
/** The model family of an actor: configured exact → longest configured prefix → longest default prefix
 *  (schema.ts DEFAULT_FAMILY_PREFIXES) → null: an actor no rule names has no family. */
export function familyOf(actor: string, configured: Record<string, string> = {}): Family | null {
  return familyFor(actor, configured);
}

/** Who an actor is as a tool on a machine: `human-claude-s1@box`, `human-claude@box` and `claude@box` are all
 *  `claude@box` (one harness, sessions or not); any other actor is itself. The answer-key rule compares these. */
export function toolIdentity(actor: string): string {
  const m = /^(?:human-)?(claude|codex)(?:-[a-z0-9]{1,8})?@(.+)$/.exec(actor.trim());
  return m ? `${m[1]}@${m[2]}` : actor.trim();
}

// ---------- state ----------
/** The Acceptance section (the spec store's extractor) has text after its heading line. */
export function hasAcceptance(text: string): boolean {
  const s = sectionOf(text, SECTIONS.acceptance_tests);
  return s !== null && /\S/.test(s.replace(/^[^\r\n]*(\r\n|\r|\n)?/, ''));
}
export const isBlocked = (t: Pick<Task, 'spec_state' | 'blocked_by'>) => t.spec_state === 'blocked' || !!t.blocked_by;
const reviewOf = (t: Pick<Task, 'spec_review'>): SpecReview | null => (t.spec_review && typeof t.spec_review === 'object' ? t.spec_review as SpecReview : null);

/** When not blocked: the state the spec (and its review) gives. Any size: ready only with a pass on this version. */
export function stateOf(spec: { text: string; version: number } | null, review: SpecReview | null): SpecState {
  if (!spec) return 'none';
  if (!hasAcceptance(spec.text)) return 'draft';
  return review && review.spec_version === spec.version && review.verdict === 'pass' ? 'ready' : 'draft';
}

/** The current spec record, or null (callers hold the repo lock, or accept a read between writes). */
export function currentSpec(root: string, id: string): SpecView | null {
  return currentSpecVersion(root, id) ? readSpecUnlocked(root, id) : null;
}

/** One task's current spec as some reader sees it: the working tree, or the committed tree (git HEAD). */
/** textKey: the text's identity when the reader has one (the committed blob oid): a text edited under an unchanged json
 *  derives its state again. */
interface SpecSource { version: number; meta: () => { sha256?: string; by?: string }; text: () => string; textKey?: string }
function workingSpec(root: string, id: string): SpecSource {
  const v = currentSpecVersion(root, id); const p = specPaths(id);
  return { version: v, meta: () => JSON.parse(fs.readFileSync(path.join(root, p.meta(v)), 'utf8')), text: () => fs.readFileSync(path.join(root, p.text(v)), 'utf8') };
}
const derived = new Map<string, { key: string; state: SpecState }>();
/** The stored field, else blocked, else derived from the spec (cached by the version's hash, not its number: a
 *  rolled-back v1 and the v1 written after it differ). */
function stateFrom(t: Task, src: SpecSource): SpecState {
  if (t.spec_state && t.spec_state !== '') return t.spec_state as SpecState;
  if (isBlocked(t)) return 'blocked';
  if (!src.version) return 'none';
  const key = `${src.version}:${src.meta().sha256 ?? ''}:${src.textKey ?? ''}:${JSON.stringify(t.spec_review ?? null)}`;
  const hit = derived.get(t.id);
  if (hit?.key === key) return hit.state;
  const state = stateOf({ text: src.text(), version: src.version }, reviewOf(t));
  derived.set(t.id, { key, state });
  return state;
}
/** The effective state as the working tree has it. For callers that hold the repo lock, where the working tree is
 *  what is committed; lock-free reads use committedSpecIndex. */
export function effectiveSpecState(root: string, t: Task): SpecState {
  return stateFrom(t, workingSpec(root, t.id));
}

// ---------- lock-free reads: one pinned commit ----------
/** What the read routes show of a task's spec: its state, the current spec's writer and the six task fields. */
export interface SpecFacts { spec_state: SpecState; spec_by: string | null; fields: SpecFields }
export interface SpecIndex { head: string; facts: Map<string, SpecFacts> }
const SPEC_FIELD_NAMES = ['spec_state', 'blocked_by', 'blocked_at', 'block_note', 'blocked_spec_version', 'spec_review'] as const;

const runGit = (root: string, args: string[], input?: Buffer) => {
  try { return execFileSync('git', ['-C', root, '--no-optional-locks', ...args], { input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...GIT_BOUND }); }
  catch (e) { return gitTimeoutNamed(e, args); }
};

const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** The commit HEAD points at, from the ref files (no git process): read on every request, so it must be cheap.
 *  Follows symbolic ref chains (HEAD → refs/heads/alias → refs/heads/main), loose then packed; anything it can't
 *  resolve to an object id falls back to `git rev-parse HEAD`. */
export function headSha(root: string): string {
  try {
    const common = gitCommonDir(root);
    const dotgit = path.join(root, '.git');
    const own = fs.statSync(dotgit).isFile() ? path.resolve(root, /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'))![1].trim()) : dotgit;
    let v = fs.readFileSync(path.join(own, 'HEAD'), 'utf8').trim();
    for (let hop = 0; hop < 8; hop++) {
      if (OID_RE.test(v)) return v;
      const ref = /^ref:\s*(.+)$/.exec(v)?.[1];
      if (!ref) break;
      let next: string | undefined;
      try { next = fs.readFileSync(path.join(common, ref), 'utf8').trim(); } catch { /* packed */ }
      if (next === undefined) {
        let packed = ''; try { packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8'); } catch { /* none */ }
        next = packed.split('\n').find((l) => l.endsWith(' ' + ref))?.split(' ')[0];
      }
      if (next === undefined) break;
      v = next;
    }
  } catch { /* fall back */ }
  try { return runGit(root, ['rev-parse', '--verify', '-q', 'HEAD']).toString('utf8').trim(); } catch { return ''; }
}

/** A git object the commit names is not in the object store: the whole build fails, nothing from it is cached. */
export class MissingObjectError extends Error {}

/** Blobs by object id: one `git cat-file --batch` for many. */
function catBlobs(root: string, ids: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!ids.length) return out;
  const buf = runGit(root, ['cat-file', '--batch'], Buffer.from(ids.join('\n') + '\n'));
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    const [oid, type, size] = buf.subarray(i, nl).toString('utf8').split(' ');
    if (type === 'missing' || size === undefined) throw new MissingObjectError(`git object ${oid} is missing`);
    const n = Number(size);
    out.set(oid, buf.subarray(nl + 1, nl + 1 + n));
    i = nl + 1 + n + 1;
  }
  return out;
}

// Per task, keyed by the blob ids it was built from: a rebuild re-reads only tasks and specs that changed.
const factsCache = new Map<string, { key: string; facts: SpecFacts }>();
/** Spec facts for every task, read from one pinned commit only, never working files or loadBoard objects. A write of another process that is not committed
 *  (or rolls back) is never seen; one that commits is seen once HEAD moves. Lock-free: git reads objects, not the
 *  index or the working tree. Spec text is read only when a state must be derived and is not cached. */
export function committedSpecIndex(root: string, head = headSha(root)): SpecIndex {
  const facts = new Map<string, SpecFacts>();
  if (!head) throw new Error('HEAD does not resolve to a commit');
  const tree = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', head, '--', 'data/tasks', 'data/specs']).toString('utf8').split('\0');
  const taskBlob = new Map<string, string>();                       // id → blob of data/tasks/<g>/<slug>.md
  const specs = new Map<string, { v: number; meta: string; text: string }>(); // id → current version's blobs
  for (const e of tree) {
    const tab = e.indexOf('\t'); if (tab < 0) continue;
    const oid = e.slice(0, tab).split(' ')[2]; const p = e.slice(tab + 1);
    let m = /^data\/tasks\/([a-z][a-z0-9]{0,23})\/(t-[a-z0-9-]+)\.md$/.exec(p);
    if (m) { taskBlob.set(`${m[1]}.${m[2]}`, oid); continue; }
    m = /^data\/specs\/([a-z][a-z0-9]{0,23})\/(t-[a-z0-9-]+)\/versions\/([1-9]\d{0,8})\.(json|md)$/.exec(p);
    if (!m) continue;
    const id = `${m[1]}.${m[2]}`; const v = Number(m[3]);
    const cur = specs.get(id) ?? { v: 0, meta: '', text: '' };
    if (v > cur.v) Object.assign(cur, { v, meta: '', text: '' });
    if (v === cur.v) cur[m[4] === 'json' ? 'meta' : 'text'] = oid;
    specs.set(id, cur);
  }
  // the text oid too: a committed edit of the current version's text with its json unchanged must be read again
  const keyOf = (id: string) => `${taskBlob.get(id)}:${specs.get(id)?.meta ?? ''}:${specs.get(id)?.text ?? ''}`;
  const todo = [...taskBlob.keys()].filter((id) => factsCache.get(id)?.key !== keyOf(id));
  const fresh = new Map<string, { key: string; facts: SpecFacts }>(); // into factsCache only when the whole build succeeds
  const blobs = catBlobs(root, [...new Set(todo.flatMap((id) => [taskBlob.get(id)!, specs.get(id)?.meta].filter((x): x is string => !!x)))]);
  // Every changed task file is parsed as YAML (no text shortcut: a key may be quoted or escaped any valid way).
  const parsed = new Map<string, Task | Error>();
  for (const id of todo) {
    const blob = blobs.get(taskBlob.get(id)!);
    if (!blob) throw new MissingObjectError(`git object ${taskBlob.get(id)} (${id}) is missing`);
    const text = blob.toString('utf8');
    try { parsed.set(id, taskFromParsed(parseFrontmatter(text), '', text.length)); } catch (e: any) { parsed.set(id, e instanceof Error ? e : new Error(String(e))); }
  }
  // A second batch for the spec texts a state has to be derived from (no stored state or block on the task).
  const needText = todo.filter((id) => { const t = parsed.get(id); return specs.get(id)?.text && !(t instanceof Error) && !(t!.spec_state) && !isBlocked(t!); });
  for (const [k, v] of catBlobs(root, needText.map((id) => specs.get(id)!.text))) blobs.set(k, v);
  for (const [id, oid] of taskBlob) {
    const key = keyOf(id);
    const hit = factsCache.get(id);
    if (hit?.key === key) { facts.set(id, hit.facts); continue; }
    let f: SpecFacts = { spec_state: 'none', spec_by: null, fields: {} };
    let cache = true;
    void oid;
    try {
      const p = parsed.get(id)!;
      if (p instanceof Error) throw p;
      const t = p; t.id = id;
      const sp = specs.get(id);
      const metaBlob = sp?.meta ? blobs.get(sp.meta) : undefined;
      if (sp?.meta && !metaBlob) throw new MissingObjectError(`git object ${sp.meta} (${id} spec) is missing`);
      const meta = metaBlob ? JSON.parse(metaBlob.toString('utf8')) : {};
      const src: SpecSource = { version: sp?.meta ? sp.v : 0, meta: () => meta, textKey: sp?.text, text: () => (sp?.text ? (blobs.get(sp.text) ?? catBlobs(root, [sp.text]).get(sp.text)!).toString('utf8') : '') };
      const fields = Object.fromEntries(SPEC_FIELD_NAMES.map((k) => [k, (t as any)[k]]).filter(([, v]) => v !== undefined));
      f = { spec_state: stateFrom(t, src), spec_by: src.version ? meta.by ?? null : null, fields };
    } catch (e: any) {
      if (e instanceof MissingObjectError) throw e;
      // A committed card that doesn't parse shows as none (never ready) and is tried again on the next build.
      console.error(`spec index ${id}: ${String(e?.message ?? e).split('\n')[0]}`); cache = false;
    }
    if (cache) fresh.set(id, { key, facts: f });
    facts.set(id, f);
  }
  for (const [id, v] of fresh) factsCache.set(id, v);
  return { head, facts };
}

// ---------- claim history ----------
export interface ClaimHistory { partial: boolean; who: string[] }
export function claimsRelPath(id: string): string {
  const m = TASK_ID_RE.exec(id);
  if (!m) throw new HttpError(400, `bad task id "${id}"`);
  return path.join('data', 'claims', m[1], `${m[2]}.json`);
}
/** The stored history; null for a task without one (its first claim seeds it). */
export function readClaimHistory(root: string, id: string): ClaimHistory | null {
  try { const h = JSON.parse(fs.readFileSync(path.join(root, claimsRelPath(id)), 'utf8')); return { partial: !!h.partial, who: Array.isArray(h.who) ? h.who.map(String) : [] }; }
  catch (e: any) { if (e.code === 'ENOENT') return null; throw new HttpError(500, `claim history of ${id} is unreadable: ${e.message}`); }
}
const historyContent = (h: ClaimHistory) => JSON.stringify(h, null, 1) + '\n';
/** A new task's empty, complete history (in its create commit). */
export const newClaimHistory = (id: string) => ({ rel: claimsRelPath(id), content: historyContent({ partial: false, who: [] }) });
/** Is `who` an implementer the history may refuse? A partial history refuses nothing. */
export function inHistory(root: string, id: string, who: string): boolean {
  const h = readClaimHistory(root, id);
  return !!h && !h.partial && h.who.includes(who);
}
/** The history file after a successful claim by `who` (and `actor`, when it claimed for them): a task without one is
 *  seeded once (claimed_by + activity claims), as a partial history. */
export function historyAfterClaim(root: string, t: Task, who: string, actor?: string): { rel: string; content: string } {
  let h = readClaimHistory(root, t.id);
  if (!h) {
    const seed = [t.claimed_by || '', ...readActivity(root, t.id).filter((a) => a.action === 'claim').map((a) => a.actor)].filter(Boolean);
    h = { partial: true, who: [...new Set(seed)] };
  }
  for (const name of actor ? [who, actor] : [who]) if (!h.who.includes(name)) h = { ...h, who: [...h.who, name] };
  return { rel: claimsRelPath(t.id), content: historyContent(h) };
}

// ---------- claims ----------
/** Refuse a claim on a blocked card (but for the user) or by an author of the current Acceptance / Oracle. */
export function assertClaimAllowed(root: string, t: Task, who: string, actor: string): void {
  if (isBlocked(t) && actor !== 'user') throw new HttpError(409, `${t.id} is blocked for Spec: ${t.block_note || 'no note'} (blocked by ${t.blocked_by || '?'})`, { rule: 'spec-blocked', blocked_by: t.blocked_by ?? '', block_note: t.block_note ?? '' });
  const sp = currentSpec(root, t.id);
  const a = sp?.section_authors;
  // By tool identity: a session's draft (human-claude-s1@box) bars the same harness on that machine (claude@box) too.
  const me = toolIdentity(who);
  const wrote = (s: { by: string } | null | undefined) => !!s && toolIdentity(s.by) === me;
  if (a && (wrote(a.acceptance_tests) || wrote(a.oracle)))
    throw new HttpError(409, `you wrote the answer key: ${who} is the same author as the current ${wrote(a.acceptance_tests) ? `Acceptance tests (${a.acceptance_tests!.by})` : `Oracle (${a.oracle!.by})`} of ${t.id}, so it can't implement the card`, { rule: 'answer-key-author' });
}

// ---------- spec writes ----------
const sectionsDiffer = (a: string, b: string) => (Object.values(SECTIONS) as string[]).some((n) => sectionOf(a, n) !== sectionOf(b, n));
/** 403 when a history member adds, changes, removes or restores Acceptance or Oracle (after the 409 and 422 checks). */
export function assertProtectedWrite(root: string, id: string, prevText: string, text: string, actor: string): void {
  if (sectionsDiffer(prevText, text) && inHistory(root, id, actor))
    throw new HttpError(403, `${actor} has claimed ${id}: an implementer can't write its Acceptance tests or Oracle (edits elsewhere are fine)`, { rule: 'implementer-answer-key' });
}
// An auto-ok header line the carry accepts: `true` or `false`, then a comment with no control character and no line or
// paragraph separator (sameExceptAutoOk splits on CR/LF only; the runner's `m`-flag parsers also break at U+2028/2029).
const AUTO_OK_ANY = /^[ \t]*auto-ok[ \t]*:/i;
const AUTO_OK_SAFE = /^[ \t]*auto-ok[ \t]*:[ \t]*(true|false)\b[^\u0000-\u001f\u007f\u0085\u2028\u2029]*$/;
/** What the board and the runners read from a card's header, but auto-ok. */
function readFields(text: string) {
  const v = checkCard(text); const f = { ...v.fields }; delete f['auto-ok'];
  return JSON.stringify([f, v.pass_checks, cardRepo(text), cardTouches(text), cardDeps(text), cardSize(text) ?? null, field(text, 'secrets')]);
}
/** Every auto-ok line of the header (the lines before the first `## ` heading, as contract.ts reads it) is a plain
 *  one-line `auto-ok: true|false  # …` at the line start whose next non-blank line is not an indented or list line:
 *  between `pass_checks:` and its items (blank lines between too), or inside a key's continuation, it would end that
 *  list for line-based readers such as the dask CLI. After the last item it is fine.
 *  Lines after the header (a body example) are not judged: they are the same in both texts
 *  (sameExceptAutoOk). */
function headerAutoOkSafe(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length && !lines[i].startsWith('## '); i++) {
    const l = lines[i];
    if (!AUTO_OK_ANY.test(l)) continue;
    if (!AUTO_OK_SAFE.test(l) || /^[ \t]/.test(l)) return false;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j < lines.length && /^([ \t]+\S|[ \t]*-)/.test(lines[j])) return false;
  }
  return true;
}
/** True when `b` differs from `a` only in auto-ok header line(s), each of them a plain one-line `auto-ok: true|false`, and
 *  every field the board and runners read is the same: the reviewed text is unchanged. */
export function autoOkOnlyChange(a: string, b: string): boolean {
  if (!sameExceptAutoOk(a, b)) return false;
  if (!headerAutoOkSafe(a) || !headerAutoOkSafe(b)) return false;
  return readFields(a) === readFields(b);
}
/** The task fields a new spec version leaves: review cleared, state recomputed (blocked stays blocked). One exception: a
 *  pass on the replaced version moves to the new one when the change is confined to auto-ok header lines (`prevText`, the
 *  replaced version's text; an identical re-put is still a new, unreviewed version). */
export function fieldsAfterSpecWrite(t: Task, spec: { text: string; version: number }, prevText?: string): SpecFields {
  const prev = reviewOf(t);
  if (prevText !== undefined && prev && prev.verdict === 'pass' && prev.spec_version === spec.version - 1 && prevText !== spec.text && autoOkOnlyChange(prevText, spec.text)) {
    const review: SpecReview = { ...prev, spec_version: spec.version };
    return { spec_state: isBlocked(t) ? 'blocked' : stateOf(spec, review), spec_review: review };
  }
  return { spec_state: isBlocked(t) ? 'blocked' : stateOf(spec, null), spec_review: undefined };
}

// ---------- review / block / unblock ----------
export type SpecFields = Partial<Record<'spec_state' | 'blocked_by' | 'blocked_at' | 'block_note' | 'blocked_spec_version' | 'spec_review', unknown>>;

/** Exactly these fields; versions JSON safe integers ≥ min. */
function shape(body: Record<string, unknown>, fields: Record<string, 'v0' | 'v1' | 'verdict' | 'note'>): void {
  const extra = Object.keys(body).filter((k) => !Object.hasOwn(fields, k));
  if (extra.length) throw new HttpError(400, `unknown field(s): ${extra.join(', ')} (takes ${Object.keys(fields).join(', ')})`);
  for (const [k, kind] of Object.entries(fields)) {
    const v = body[k];
    if (kind === 'v0' || kind === 'v1') {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < (kind === 'v1' ? 1 : 0)) throw new HttpError(400, `${k} is required: an integer ≥ ${kind === 'v1' ? 1 : 0} (a JSON number)`);
    } else if (kind === 'verdict') {
      if (v !== 'pass' && v !== 'fail') throw new HttpError(400, 'verdict must be "pass" or "fail"');
    } else { const e = blockNoteError(v); if (e) throw new HttpError(400, e); }
  }
}
function assertVersions(t: Task, specVersion: number, body: Record<string, unknown>): void {
  const tv = Number(t.version || 0);
  if (body.expected_version !== tv || body.expected_spec_version !== specVersion)
    throw new HttpError(409, `version conflict: task is at version ${tv} and its spec at ${specVersion}; re-read and retry`, { current_version: tv, current_spec_version: specVersion });
}
/** The lane patch of a spec-rework card whose spec turns ready (it leaves the lane in that same write), else null.
 *  Cards in any other lane, and specs that stay draft, none or blocked, keep lane and next_owner. */
export function reworkDone(t: Task, specState: unknown): { lane: 'none'; next_owner: '' } | null {
  return t.lane === 'spec-rework' && specState === 'ready' ? { lane: 'none', next_owner: '' } : null;
}
/** One task write of server-only spec fields (body untouched; the activity entry says what changed), plus the
 *  spec-rework lane exit when the state turns ready. */
const write = (root: string, id: string, t: Task, f: SpecFields, actor: string, action: string, now?: Date) =>
  updateTask(root, id, reworkDone(t, f.spec_state) ?? {}, actor, { specFields: f, action, now, warnings: [] });

/** POST /spec/review {spec_version, verdict}: the text review of the current version, any size. */
export function reviewSpec(root: string, id: string, body: Record<string, unknown>, actor: string, families: Record<string, string>, now = new Date(), gate: () => void = () => {}): Task {
  shape(body, { spec_version: 'v1', verdict: 'verdict' });
  return withRepoLock(root, () => {
    const t = readTask(root, id);
    const sp = currentSpec(root, id);
    if (!sp) throw new HttpError(404, `${id} has no spec yet`, { current_spec_version: 0 });
    gate(); // after 400 and 404 (the server's spec-index guard)
    if (body.spec_version !== sp.metadata.version) throw new HttpError(409, `spec of ${id} is at version ${sp.metadata.version}, not ${body.spec_version}`, { current_spec_version: sp.metadata.version });
    const fam = familyOf(actor, families);
    const authors = [sp.section_authors.acceptance_tests?.by, sp.section_authors.oracle?.by].filter((x): x is string => !!x);
    const why = !fam ? `the reviewer's model family is unknown (${actor})`
      : authors.includes(actor) ? `${actor} wrote this card's answer key`
      : authors.some((a) => familyOf(a, families) === null) ? 'an answer-key author\'s model family is unknown'
      : authors.some((a) => familyOf(a, families) === fam) ? `the reviewer is ${fam}, the same family as an answer-key author`
      : inHistory(root, id, actor) ? `${actor} has claimed this card`
      : '';
    if (why) throw new HttpError(403, `not an eligible reviewer: ${why}`, { rule: 'spec-review' });
    const review: SpecReview = { spec_version: sp.metadata.version, by: actor, family: fam!, verdict: body.verdict as 'pass' | 'fail', at: isoNow(now) };
    const spec_state = isBlocked(t) ? 'blocked' : stateOf({ text: sp.text, version: sp.metadata.version }, review);
    return write(root, id, t, { spec_review: review, spec_state }, actor, 'spec-review', now);
  });
}

/** POST /spec/block {expected_version, expected_spec_version, block_note}: any named actor; reblocking resets the baseline. */
export function blockSpec(root: string, id: string, body: Record<string, unknown>, actor: string, now = new Date(), gate: () => void = () => {}): Task {
  shape(body, { expected_version: 'v0', expected_spec_version: 'v0', block_note: 'note' });
  return withRepoLock(root, () => {
    const t = readTask(root, id);
    gate(); // after 400 and 404
    const sv = currentSpecVersion(root, id);
    assertVersions(t, sv, body);
    return write(root, id, t, { spec_state: 'blocked', blocked_by: actor, blocked_at: isoNow(now), block_note: body.block_note, blocked_spec_version: sv }, actor, 'spec-block', now);
  });
}

/** POST /spec/unblock {expected_version, expected_spec_version}: the user, or a never-claimant who wrote a newer version. */
export function unblockSpec(root: string, id: string, body: Record<string, unknown>, actor: string, now = new Date(), gate: () => void = () => {}): Task {
  shape(body, { expected_version: 'v0', expected_spec_version: 'v0' });
  return withRepoLock(root, () => {
    const t = readTask(root, id);
    gate(); // after 400 and 404
    const sv = currentSpecVersion(root, id);
    assertVersions(t, sv, body);
    if (!isBlocked(t)) throw new HttpError(409, `${id} is not blocked`, { rule: 'spec-unblock' });
    if (actor !== 'user') {
      const base = Number(t.blocked_spec_version ?? 0);
      if (inHistory(root, id, actor)) throw new HttpError(403, `${actor} has claimed ${id}: an implementer can't lift its Spec block`, { rule: 'spec-unblock' });
      if (sv <= base) throw new HttpError(409, `no newer spec version than the block's (v${base}): write the fix first`, { rule: 'spec-unblock', blocked_spec_version: base, current_spec_version: sv });
      if (currentSpec(root, id)!.metadata.by !== actor) throw new HttpError(403, `only the user or the author of the current spec version (v${sv}) can lift the block`, { rule: 'spec-unblock' });
    }
    const sp = currentSpec(root, id);
    const spec_state = stateOf(sp && { text: sp.text, version: sp.metadata.version }, reviewOf(t));
    return write(root, id, t, { spec_state, blocked_by: undefined, blocked_at: undefined, block_note: undefined, blocked_spec_version: undefined }, actor, 'spec-unblock', now);
  });
}
