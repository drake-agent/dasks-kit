// Card messages (docs/cards.md "Card messages"): short notes between the agents working one card, so a worker can ask and
// wait for an answer mid-job. Append-only, per-card monotonic seq, idempotent on request_id.
// Kept in run/messages/<goal>/<t-…>.jsonl (not git data: no commit, no board reload per message).
// INFORMATIONAL ONLY: no gate (claim, spec, review, merge, human decision) may read this. test/messages.test.ts
// fails when a gate module imports it. There is no approval kind; the server refuses approve-like kinds.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './write.ts';
import { ACTOR_RE } from './schema.ts';
import { redact } from './redact.ts';

export const KINDS = ['question', 'answer', 'fyi', 'blocked-on', 'heads-up'] as const;
export const ROLES = ['spec', 'owner', 'impl', 'review', 'human'] as const;
/** Kinds that would read as a go-ahead. Refused with a message that says why (a note never opens a gate). */
const APPROVAL_KINDS = /^(approve|approved|approval|ok|okay|lgtm|merge|pass|launch|go|accept|done)$/i;
export const MAX_TEXT_BYTES = 2048;
export const MAX_PER_CARD = 500;
export const MAX_WAIT_S = 60;
export const MAX_WAITERS = 64;
const REQ_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const JOB_ID_RE = /^[A-Za-z0-9._:#-]{1,80}$/;
/** Common credential shapes. A message that matches is refused, not redacted: the sender should send a path or a label
 *  instead. */
const SECRET_RES = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /(?<![A-Za-z0-9.-])sk-[A-Za-z0-9_-]{20,}/, /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, /AIza[0-9A-Za-z_-]{30,}/,
  /(token|secret|password|passwd|api[_-]?key|authorization)\s*[:=]\s*\S+/i, /-----BEGIN [A-Z ]*PRIVATE[ ]KEY-----/, /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/,
  /dsk_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}/i, // Dasks agent identity token, anywhere in the text (also inside _..._ or glued to a word)
];
/** True when text looks like it carries a secret: one of the shapes above, or anything the redactor (lib/redact.ts)
 *  would mask. Still a refusal, never a mask. */
export const looksSecret = (v: string) => SECRET_RES.some((r) => r.test(v)) || redact(v) !== v;

export interface Message {
  seq: number; card: string; from: string; to: string; kind: string; reply_to: number | null;
  text: string; job_id: string | null; ts: string; request_id: string;
}

export const messagesFile = (root: string, card: string) => {
  const [goal, name] = card.split('.');
  return path.join(root, 'run', 'messages', goal, `${name}.jsonl`);
};

/** All messages of a card, in seq order. A torn last line (crash mid-append) is skipped. */
export function readMessages(root: string, card: string): Message[] {
  let raw = '';
  try { raw = fs.readFileSync(messagesFile(root, card), 'utf8'); } catch { return []; }
  const out: Message[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (Number.isInteger(m?.seq)) out.push(m); } catch { /* torn line */ }
  }
  return out;
}

/** to: an actor name, a role, or '*' (everyone on the card). */
export function validTo(v: string): boolean {
  return v === '*' || (ROLES as readonly string[]).includes(v) || ACTOR_RE.test(v);
}

function parseTo(v: unknown): string {
  if (v === undefined || v === null || v === '') return '*';
  if (typeof v !== 'string' || !validTo(v.trim())) throw new HttpError(400, `to must be an actor name, a role (${ROLES.join('|')}) or *`);
  return v.trim();
}

function parseKind(v: unknown): string {
  if (v === undefined || v === null || v === '') return 'fyi';
  if (typeof v === 'string' && APPROVAL_KINDS.test(v.trim()))
    throw new HttpError(400, `kind "${v}" refused: messages are information only and never approve, pass, merge or launch anything (use the card's own gates)`);
  if (typeof v !== 'string' || !(KINDS as readonly string[]).includes(v)) throw new HttpError(400, `kind must be ${KINDS.join(' | ')}`);
  return v;
}

export function parseText(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'text is required');
  // Plain text: newlines and tabs only.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) throw new HttpError(400, 'text must be plain text (no control characters)');
  const bytes = Buffer.byteLength(v, 'utf8');
  if (bytes > MAX_TEXT_BYTES) throw new HttpError(413, `text is ${bytes} bytes; at most ${MAX_TEXT_BYTES}. Send a path or URL for long material`);
  if (looksSecret(v)) throw new HttpError(400, 'text looks like it carries a secret (token, key, password); messages never carry secrets: name the label or path instead');
  return v;
}

/** Waiters parked on a card (long-poll). Woken on every append to that card. */
const waiters = new Map<string, Set<() => void>>();
let waiterCount = 0;
/** Who is waiting on which card right now (for participants). */
const waiting = new Map<string, Map<string, number>>();
/** Last time an actor read or wrote a card's messages (in memory; posts also live in the file). */
const seen = new Map<string, Map<string, string>>();

export function touch(card: string, actor: string, at = new Date()) {
  if (!actor) return;
  let m = seen.get(card); if (!m) { m = new Map(); seen.set(card, m); }
  m.set(actor, at.toISOString());
}

export interface PostInput { request_id?: unknown; to?: unknown; kind?: unknown; reply_to?: unknown; text?: unknown; job_id?: unknown }

/** Append one message. Same request_id again: the original comes back with duplicate=true and nothing is stored. */
export function postMessage(root: string, card: string, body: PostInput & Record<string, unknown>, from: string, now = new Date()): { message: Message; duplicate: boolean } {
  const extra = Object.keys(body).filter((k) => !['request_id', 'to', 'kind', 'reply_to', 'text', 'job_id'].includes(k));
  if (extra.length) throw new HttpError(400, `a message takes only request_id, to, kind, reply_to, text, job_id (got ${extra.join(', ')})`);
  if (!from || !ACTOR_RE.test(from)) throw new HttpError(400, 'messages need the sender: set the X-Dasks-Actor header (DASKS_ACTOR)');
  const rid = body.request_id === undefined || body.request_id === '' ? '' : body.request_id;
  if (rid !== '' && (typeof rid !== 'string' || !REQ_ID_RE.test(rid))) throw new HttpError(400, 'request_id must be 8-64 of letters, digits . _ : -');
  const all = readMessages(root, card);
  if (rid) { const dup = all.find((m) => m.request_id === rid); if (dup) return { message: dup, duplicate: true }; }
  const to = parseTo(body.to), kind = parseKind(body.kind), text = parseText(body.text);
  const last = all.length ? all[all.length - 1].seq : 0;
  let reply_to: number | null = null;
  if (body.reply_to !== undefined && body.reply_to !== null && body.reply_to !== '') {
    const n = typeof body.reply_to === 'number' ? body.reply_to : /^\d+$/.test(String(body.reply_to)) ? Number(body.reply_to) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > last) throw new HttpError(400, `reply_to must be the seq of an earlier message on this card (1..${last})`);
    reply_to = n;
  }
  let job_id: string | null = null;
  if (body.job_id !== undefined && body.job_id !== null && body.job_id !== '') {
    if (typeof body.job_id !== 'string' || !JOB_ID_RE.test(body.job_id)) throw new HttpError(400, 'job_id must be a job id');
    job_id = body.job_id;
  }
  if (all.length >= MAX_PER_CARD) throw new HttpError(429, `this card already has ${MAX_PER_CARD} messages; write a note or split the card`);
  const message: Message = { seq: last + 1, card, from, to, kind, reply_to, text, job_id, ts: now.toISOString(), request_id: rid || `srv-${card}-${last + 1}-${now.getTime()}` };
  const file = messagesFile(root, card);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // One synchronous append per message: Node runs it to completion, so two posts on one server never share a seq.
  // A torn last line (a crash mid-append) has no newline: start on a fresh line, or this message would join it and be
  // dropped by every read after a 201.
  let torn = false;
  try { const fd = fs.openSync(file, 'r'); try { const size = fs.fstatSync(fd).size; if (size) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); torn = b[0] !== 0x0a; } } finally { fs.closeSync(fd); } } catch { /* no file yet */ }
  fs.appendFileSync(file, (torn ? '\n' : '') + JSON.stringify(message) + '\n', { mode: 0o600 });
  touch(card, from, now);
  for (const wake of waiters.get(card) ?? []) wake();
  return { message, duplicate: false };
}

export interface Filter { since: number; to?: string[]; kind?: string[]; reply_to?: number; not_from?: string; limit?: number }

export function parseFilter(q: URLSearchParams): Filter {
  const since = q.get('since') ?? '0';
  if (!/^\d+$/.test(since)) throw new HttpError(400, 'since must be a seq (0 or more)');
  const list = (k: string) => { const v = q.get(k); return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined; };
  const to = list('to'), kind = list('kind');
  if (to && !to.every(validTo)) throw new HttpError(400, 'bad to filter');
  if (kind && !kind.every((k) => (KINDS as readonly string[]).includes(k))) throw new HttpError(400, `kind filter must be ${KINDS.join('|')}`);
  const rt = q.get('reply_to');
  if (rt !== null && !/^\d+$/.test(rt)) throw new HttpError(400, 'reply_to must be a seq');
  const nf = q.get('not_from') ?? undefined;
  if (nf !== undefined && !ACTOR_RE.test(nf)) throw new HttpError(400, 'bad not_from');
  const lim = q.get('limit');
  if (lim !== null && (!/^\d+$/.test(lim) || Number(lim) < 1 || Number(lim) > 200)) throw new HttpError(400, 'limit must be 1..200');
  return { since: Number(since), to, kind, reply_to: rt === null ? undefined : Number(rt), not_from: nf, limit: lim === null ? 100 : Number(lim) };
}

export function filterMessages(all: Message[], f: Filter): Message[] {
  return all.filter((m) => m.seq > f.since && (!f.to || f.to.includes(m.to)) && (!f.kind || f.kind.includes(m.kind))
    && (f.reply_to === undefined || m.reply_to === f.reply_to) && (!f.not_from || m.from !== f.not_from)).slice(0, f.limit ?? 100);
}

/** Long-poll: resolves with the matching messages as soon as one exists after `since`, or [] after timeoutS.
 *  "A message arrived" is all this ever says; it never says the work is done (task_correlated: false). */
export function waitMessages(root: string, card: string, f: Filter, timeoutS: number, actor: string, onClose: (fn: () => void) => void): Promise<Message[]> {
  const now = filterMessages(readMessages(root, card), f);
  if (now.length || timeoutS <= 0) return Promise.resolve(now);
  if (waiterCount >= MAX_WAITERS) throw new HttpError(503, 'too many waiters; try again shortly', { retry_after: 5 });
  return new Promise((resolve) => {
    let set = waiters.get(card); if (!set) { set = new Set(); waiters.set(card, set); }
    let w = waiting.get(card); if (!w) { w = new Map(); waiting.set(card, w); }
    if (actor) w.set(actor, (w.get(actor) ?? 0) + 1);
    waiterCount++;
    let done = false;
    const finish = (out: Message[]) => {
      if (done) return; done = true;
      clearTimeout(timer); set!.delete(wake); waiterCount--;
      if (actor) { const n = (w!.get(actor) ?? 1) - 1; if (n > 0) w!.set(actor, n); else w!.delete(actor); }
      if (actor) touch(card, actor);
      resolve(out);
    };
    const wake = () => { const got = filterMessages(readMessages(root, card), f); if (got.length) finish(got); };
    const timer = setTimeout(() => finish([]), timeoutS * 1000);
    set.add(wake);
    onClose(() => finish([]));
  });
}

export function parseTimeout(v: string | null): number {
  if (v === null || v === '') return 55;
  if (!/^\d+$/.test(v)) throw new HttpError(400, 'timeout must be whole seconds');
  return Math.min(Number(v), MAX_WAIT_S);
}

export interface Participant { actor: string; role: string; lane: string | null; state: string; last_seen: string | null; source: string[] }

/** Who is on this card: claim holder, owner, spec writer, message senders/readers and waiters.
 *  Names are labels, not identities: anyone who can reach the board can claim any name. */
export function participants(card: string, t: { claimed_by?: string; claimed_at?: string; owner?: string; spec_by?: string; lane?: string; status?: string; updated?: string },
  msgs: Message[]): Participant[] {
  const out = new Map<string, Participant>();
  const add = (actor: string, role: string, src: string, p: Partial<Participant> = {}) => {
    if (!actor) return;
    const cur = out.get(actor) ?? { actor, role, lane: null, state: 'known', last_seen: null, source: [] };
    if (cur.role === 'other' && role !== 'other') cur.role = role;
    if (!cur.source.includes(src)) cur.source.push(src);
    if (p.lane && !cur.lane) cur.lane = p.lane;
    if (p.state && rank(p.state) > rank(cur.state)) cur.state = p.state;
    if (p.last_seen && (!cur.last_seen || p.last_seen > cur.last_seen)) cur.last_seen = p.last_seen;
    out.set(actor, cur);
  };
  if (t.claimed_by) add(t.claimed_by, t.claimed_by.startsWith('human') || /^(claude-code|codex)@/.test(t.claimed_by) ? 'human' : 'impl', 'claim',
    { lane: t.lane && t.lane !== 'none' ? t.lane : null, state: t.status === 'doing' ? 'working' : 'known', last_seen: t.claimed_at || null });
  if (t.owner) add(t.owner, 'owner', 'owner');
  if (t.spec_by) add(t.spec_by, 'spec', 'spec_by');
  for (const m of msgs) add(m.from, roleOf(m.from), 'messages', { last_seen: m.ts });
  for (const [a, at] of seen.get(card) ?? []) add(a, roleOf(a), 'messages', { last_seen: at });
  for (const [a] of waiting.get(card) ?? []) add(a, roleOf(a), 'wait', { state: 'waiting' });
  return [...out.values()].sort((a, b) => (b.last_seen ?? '').localeCompare(a.last_seen ?? ''));
}
const rank = (s: string) => ['known', 'idle', 'working', 'waiting'].indexOf(s);
/** The role of a message writer the card itself does not name (claim, owner, spec writer come first). */
function roleOf(actor: string): string {
  if (actor === 'user' || actor.startsWith('human') || /^(claude-code|codex)@/.test(actor)) return 'human';
  if (actor.startsWith('runner@')) return 'impl';
  return 'other';
}

/** Tests only: forget in-memory presence. */
export function _resetPresence() { waiters.clear(); waiting.clear(); seen.clear(); waiterCount = 0; }
