// User decisions: a card that needs the user for one precise conflict (or a taste pick) carries one open ask; the queue
// lists them; the user's signed answer moves the card on. The shape lives in public/user-ask.js.
//   data/asks/<goal>/<slug>.json   {v, card, open: Ask | null, answered: Ask[]}   (tracked, committed with the task write)
//   data/decisions/asks.jsonl      the signed answers (same format and key as the approve/reject ledger, its own file)
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, readTask, updateTask, withRepoLock } from './write.ts';
import { TASK_ID_RE, type SpecReview, type Task } from './schema.ts';
import { readActivity, TERMINAL } from './collab.ts';
import { currentSpec, fieldsAfterSpecWrite, isBlocked, stateOf } from './spec-state.ts';
import { currentSpecVersion, isoNow, prepareSpecWrite } from './specs.ts';
import { askScope, askText, choiceOf, choicesOf, EFFECT_LABEL, hasHeader, pickAsk, sameExceptAutoOk, setAutoOk, validateAsk } from '../../public/user-ask.js';

export interface AskOption { key: string; text: string; effect: 'proceed' | 'respec' | 'cancel' }
export interface Ask {
  id: string; kind: 'conflict' | 'taste';
  before: { quote: string; date: string; ref?: string } | null; wants: string; code: { behavior: string; at: string } | null;
  options: AskOption[]; rec: { key: string; why: string };
  asked_by: string; asked_at: string;
  answer?: { choice: string; text: string; effect: string; comment: string; at: string; entry: string; auto_ok: boolean };
}
export interface AskFile { v: 1; card: string; open: Ask | null; answered: Ask[] }

export const ASKS_DIR = 'data/asks';
export const asksLedgerPath = (root: string) => path.join(root, 'data', 'decisions', 'asks.jsonl');
export function asksRelPath(id: string): string {
  const m = TASK_ID_RE.exec(id);
  if (!m) throw new HttpError(400, 'bad task id');
  return `${ASKS_DIR}/${m[1]}/${m[2]}.json`;
}
export function readAsks(root: string, id: string): AskFile | null {
  try { return JSON.parse(fs.readFileSync(path.join(root, asksRelPath(id)), 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
}
const content = (f: AskFile) => JSON.stringify(f, null, 1) + '\n';

/** The open ask of every card that has one (small files, read on demand). */
export function openAsks(root: string): Map<string, Ask> {
  const out = new Map<string, Ask>();
  let goals: string[] = [];
  try { goals = fs.readdirSync(path.join(root, ASKS_DIR)); } catch { return out; }
  for (const g of goals) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(root, ASKS_DIR, g)).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      try { const a: AskFile = JSON.parse(fs.readFileSync(path.join(root, ASKS_DIR, g, f), 'utf8')); if (a?.open && a.card === `${g}.${f.slice(0, -5)}`) out.set(a.card, a.open); }
      catch { /* a broken file asks nothing; the check reports it */ }
    }
  }
  return out;
}

/** An ask is live while its card waits on the user and has not left blocked-on-user since it was asked: a card moved on by
 *  hand (even if it comes back to blocked-on-user for another question later) no longer asks it. */
export function askLive(root: string, t: Task | undefined, a: Ask | null | undefined): boolean {
  if (!t || !a || t.status !== 'blocked-on-user') return false;
  // After the ask's own activity entry (timestamps have whole seconds, so order, not time, says what came after it).
  const log = readActivity(root, t.id);
  // An outcome that carried its ask opens it in the outcome's own write (src/lib/outcome.ts).
  const own = log.findLastIndex((e: any) => (e.action === 'ask' || e.action === 'outcome') && String(e.note ?? '').startsWith(`user decision ${a.id} `));
  // Its own entry fell out of the capped log: what happened since can no longer be read, so the ask counts as closed
  // (fail closed: it leaves the queue; the agent asks again if it still matters).
  if (own < 0) return false;
  return !log.slice(own + 1).some((e: any) => typeof e.to === 'string' && e.to !== 'blocked-on-user');
}

/** The context block a decision card carries (blocked-on-user needs what/why/do/rec/after). */
function contextOf(a: Ask) {
  const rec = a.options.find((o) => o.key === a.rec.key)!;
  return {
    what: `Decision needed: ${a.wants}`,
    why: a.kind === 'conflict' ? `Conflicts with an earlier decision: "${a.before!.quote}" (${a.before!.ref ?? a.before!.date})` : "A taste pick is the user's call",
    do: `Pick ${choicesOf(a).join(' / ')} in the decision queue (/asks)`,
    rec: `${a.rec.key} — ${a.rec.why}`,
    after: `${a.rec.key}: ${EFFECT_LABEL[rec.effect]}`,
  };
}

/** POST /api/asks/<card>: an agent flags one decision for the user. The card goes to blocked-on-user in the same commit. */
export function createAsk(root: string, id: string, input: unknown, actor: string, now = new Date()): { ask: Ask; task: Task; text: string } {
  const errs = validateAsk(input);
  if (errs.length) throw new HttpError(400, `not the decision shape: ${errs.join('; ')}`, { reasons: errs });
  return withRepoLock(root, () => {
    const p = planAsk(root, readTask(root, id), input, actor, now);
    const task = updateTask(root, id, { status: 'blocked-on-user', needs_user: p.needs_user }, actor, {
      context: p.context, appendNote: p.note, action: 'ask', extraFiles: [p.file], now, warnings: [],
    });
    return { ask: p.ask, task, text: askText(p.ask) };
  });
}

/** Everything opening an ask writes, for a writer that holds the repo lock and commits it with its own task write (an
 *  outcome that carries its ask: src/lib/outcome.ts). `note` must start the write's activity note (askLive finds it). */
export function planAsk(root: string, t: Task, input: unknown, actor: string, now = new Date()) {
  const id = t.id;
  if (TERMINAL.includes(t.status)) throw new HttpError(409, `${id} is ${t.status}: nothing to decide`);
  let file: AskFile = readAsks(root, id) ?? { v: 1, card: id, open: null, answered: [] };
  // An ask whose card was moved on by hand (no longer waiting on the user) was never answered: it is closed as superseded.
  if (file.open && !askLive(root, t, file.open))
    file = { ...file, open: null, answered: [...file.answered, { ...file.open, answer: { choice: '', text: 'the card moved on without an answer', effect: 'superseded', comment: '', at: isoNow(now), entry: '', auto_ok: false } }] };
  if (file.open) throw new HttpError(409, `${id} already waits on the user (${file.open.id}); one decision per card at a time`, { open: file.open });
  const ask: Ask = { id: `k${file.answered.length + 1}`, ...pickAsk(input), asked_by: actor, asked_at: isoNow(now) } as Ask;
  return { ask, needs_user: `Decision needed: ${ask.wants}`, context: contextOf(ask), note: `user decision ${ask.id} (${ask.kind})`,
    file: { rel: asksRelPath(id), content: content({ ...file, open: ask }) } };
}

/** What the queue shows for one ask and what an answer signs: the card revision and its current spec version are both in
 *  the scope, so a card or a spec changed after it was shown is a new question (409 on the old answer). */
export function askRequest(root: string, t: Task, a: Ask) {
  const scope = askScope(t, a, currentSpecVersion(root, t.id));
  return { card: t.id, ask: a.id, revision: Number(t.version || 0), scope, choices: choicesOf(a) };
}

/** Everything the answer would write, computed and checked without writing (the caller holds the repo lock). Called once
 *  before the answer is signed, so an answer that cannot be applied is refused instead of recorded. */
function planAnswer(root: string, id: string, choice: string, comment: string, entry: string, now: Date) {
  const t = readTask(root, id);
  const file = readAsks(root, id);
  const a = file?.open;
  if (!file || !a) throw new HttpError(409, `${id} has no open decision`);
  const opt = choiceOf(a, choice);
  if (!opt) throw new HttpError(409, `choice must be ${choicesOf(a).join(' | ')}`);
  const sp = currentSpec(root, id);
  const extra: { rel: string; content: string }[] = [];
  let specFields: Record<string, unknown> | undefined;
  let autoOk = false;
  let carried = '';
  if (opt.effect === 'proceed' && sp) {
    if (!hasHeader(sp.text)) throw new HttpError(409, `the spec of ${id} has no header block for auto-ok: fix the spec, then ask again`);
    const note = `the user ${isoNow(now).slice(0, 10)}: decision ${a.id} chose ${choice}${entry ? ` (${entry})` : ''}`;
    const w = prepareSpecWrite(root, id, { text: setAutoOk(sp.text, note), expected: sp.metadata.version, note: `user answer ${a.id}: ${choice}` }, 'user', now);
    extra.push(...w.files);
    const prev = (t.spec_review && typeof t.spec_review === 'object' ? t.spec_review : null) as SpecReview | null;
    const spec = { text: w.text, version: w.rec.version };
    if (prev && prev.verdict === 'pass' && prev.spec_version === sp.metadata.version && sameExceptAutoOk(sp.text, w.text)) {
      const review = { ...prev, spec_version: w.rec.version }; // spec_review has a fixed shape: the carry is said in the note
      carried = ` · text review of v${sp.metadata.version} kept for v${w.rec.version} (only the auto-ok line changed)`;
      specFields = { spec_review: review, spec_state: isBlocked(t) ? 'blocked' : stateOf(spec, review) };
    } else specFields = fieldsAfterSpecWrite(t, spec);
    autoOk = true;
  } else if (opt.effect === 'respec') {
    // Back to Spec, spec or not: nobody but the user claims it until a newer spec version than this one exists.
    specFields = { spec_state: 'blocked', blocked_by: 'user', blocked_at: isoNow(now), block_note: `the user: ${opt.text} — write it again`.slice(0, 300), blocked_spec_version: sp?.metadata.version ?? 0 };
  }
  const answered: Ask = { ...a, answer: { choice, text: opt.text, effect: opt.effect, comment, at: isoNow(now), entry, auto_ok: autoOk } };
  extra.push({ rel: asksRelPath(id), content: content({ ...file, open: null, answered: [...file.answered, answered] }) });
  const status = opt.effect === 'cancel' ? 'cancelled' : 'todo';
  const note = `user answer: ${choice} — ${opt.text}${comment ? ` (${comment})` : ''}${entry ? ` · ${entry}` : ''}${carried}`.slice(0, 400);
  return { patch: { status, needs_user: '' }, opts: { ...(specFields ? { specFields } : {}), appendNote: note, action: 'answer', extraFiles: extra, now, warnings: [] as string[] }, effect: opt.effect, autoOk, answered };
}

/** Refuses (409) an answer that could not be applied, before anything is signed. */
export function checkAnswer(root: string, id: string, choice: string, comment: string, now = new Date()): void {
  withRepoLock(root, () => { planAnswer(root, id, choice, comment, '', now); });
}

/** Apply the answer's effect (the signed entry is already in the ledger). One commit: task, ask file, and for proceed the
 *  new spec version with `auto-ok: true`. The card's text review (any size) moves to that version when the auto-ok line
 *  is the only change (the reviewed text is the same). Respec blocks the card for Spec, with or without a spec. */
export function applyAnswer(root: string, id: string, choice: string, comment: string, entry: string, now = new Date()) {
  return withRepoLock(root, () => {
    const p = planAnswer(root, id, choice, comment, entry, now);
    const task = updateTask(root, id, p.patch, 'user', p.opts);
    return { task, effect: p.effect, auto_ok: p.autoOk, ask: p.answered };
  });
}
