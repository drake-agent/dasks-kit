// User decisions: what a card asks the human (its decision request: revision + the exact
// scope text shown), and the append-only signed ledger data/decisions/ledger.jsonl where every accepted answer lands.
// Each ledger line is one JSON object; prev = sha256 of the previous line (GENESIS for the first), hmac = HMAC-SHA256
// (ledger.key) over the line without hmac. The file is only ever opened with O_APPEND; nothing here rewrites it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Task } from './schema.ts';
import { CONTEXT_FIELDS, CONTEXT_LABEL, parseContext } from './collab.ts';
import { type Head, headProblem, readHead, writeHead } from './ledger-head.ts';
import { git } from './write.ts';

export const GENESIS = '0'.repeat(64);
// retry asks the card's owner to run the job again. An entry is verified against the scope text stored with it.
export const CHOICES = ['approve', 'reject', 'retry'] as const;
export type Choice = (typeof CHOICES)[number];
/** Statuses in which a card asks the human something. */
export const ASKING = ['review', 'blocked-on-user'];
export const MAX_COMMENT = 500;

export const ledgerPath = (root: string) => path.join(root, 'data', 'decisions', 'ledger.jsonl');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------- decision request ----------
export interface DecisionRequest { card: string; revision: number; scope: string; scope_hash: string; choices: readonly string[] }

const one = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim() || '—';

/** What the card asks right now, or null when it asks nothing. The scope text is what the inbox shows word for word,
 *  the context block (What / Why / Do / Recommend / After) included: it names the action the human is asked to allow.
 *  Any change to the card (a server write bumps its version) gives a new revision, and a direct file edit changes the
 *  scope hash; either way an old approval cannot carry over. */
export function decisionRequest(t: Task): DecisionRequest | null {
  if (!ASKING.includes(t.status)) return null;
  const revision = Number(t.version || 0);
  const ctx = parseContext(t.body) ?? {};
  const scope = [
    `card: ${t.id}`,
    `revision: ${revision}`,
    `status: ${t.status}`,
    `title: ${one(t.title)}`,
    `asks: approve, reject or retry${t.approvals && t.approvals !== 'none' ? ` (${t.approvals})` : ''}`,
    `pr: ${one(t.pr)}`,
    `summary: ${one(t.pr_summary)}`,
    `needs: ${one(t.needs_user)}`,
    ...CONTEXT_FIELDS.map((k) => `${CONTEXT_LABEL[k]}: ${one(ctx[k])}`),
  ].join('\n');
  return { card: t.id, revision, scope, scope_hash: sha256(scope), choices: CHOICES };
}

/** Plain one-line text only: no markup characters, no control characters. */
export function commentOk(c: unknown): c is string {
  return typeof c === 'string' && c.length <= MAX_COMMENT && !/[<>\u0000-\u001f\u007f\u2028\u2029]/.test(c);
}

/** A ledger entry's id outside the ledger (in responses): d<seq>-<first 12 hex of its hmac>. A client checks it against
 *  GET /api/decisions?card=<card> (same seq, same hmac prefix). */
export const entryId = (e: Pick<Decision, 'seq' | 'hmac'>) => `d${e.seq}-${String(e.hmac).slice(0, 12)}`;

/** Every entry of a ledger that verifies (chain, HMACs, head, git witness); null when it does not, or is unreadable. */
export function verifiedEntries(root: string, file: string, key: Buffer, headFile: string): Decision[] | null {
  try {
    const text = readText(file);
    if (!verifyLedger(text, key, readHead(headFile)).ok || witnessProblem(root, file)) return null;
    return parseLedgerEntries(text);
  } catch { return null; }
}

// ---------- ledger ----------
export interface DecisionInput { who: string; session: string; card: string; revision: number; choice: string; scope: string; comment: string }
export interface Decision extends DecisionInput { v: 1; seq: number; at: string; scope_hash: string; prev: string; hmac: string }
const KEYS = ['v', 'seq', 'at', 'who', 'session', 'card', 'revision', 'choice', 'comment', 'scope', 'scope_hash', 'prev'] as const;

/** The signed part of an entry, keys in a fixed order. */
function body(e: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, e[k]])));
}
const sign = (key: Buffer, e: Record<string, unknown>) => createHmac('sha256', key).update(body(e)).digest('hex');

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return ''; throw e; }
}

function parseLedgerEntries(text: string): Decision[] {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** All entries as written (not verified: use verifyLedger for that). */
export function readLedger(file: string): Decision[] {
  return parseLedgerEntries(readText(file));
}

/** The answer to one exact question: (card, revision, scope hash). A scope changed by a direct file edit keeps the
 *  revision (only server writes bump the version) but is a new question, so the hash is part of the key.
 *  Only a ledger that verifies (chain, every HMAC, the signed head) answers: a line anyone wrote without the key is no
 *  receipt. A ledger that fails throws, naming the line; nothing then counts as decided until it is repaired. */
export function findDecision(file: string, key: Buffer, headFile: string, card: string, revision: number, scopeHash: string): Decision | null {
  const text = readText(file);
  const v = verifyLedger(text, key, readHead(headFile));
  if (!v.ok) throw new Error(`${file}: line ${v.line}: ${v.error}; run bin/verify-decisions.ts`);
  return parseLedgerEntries(text).find((e) => e.card === card && e.revision === revision && e.scope_hash === scopeHash) ?? null;
}

/** Append one signed entry. Synchronous on purpose: the caller's check-then-append cannot interleave with another request.
 *  With headFile (the server always passes it), refuses to write onto a ledger that lost lines, then moves the head.
 *  A torn write leaves an incomplete last line, which fails verification (bin/verify-decisions.ts names it), so nothing
 *  after it counts until a human repairs the ledger. */
export function appendDecision(file: string, key: Buffer, input: DecisionInput, now = new Date(), headFile?: string): Decision {
  return appendEntries(file, key, [input], now, headFile)[0];
}

function appendEntries(file: string, key: Buffer, inputs: DecisionInput[], now: Date, headFile?: string): Decision[] {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = readText(file);
  if (text && !text.endsWith('\n')) throw new Error(`${file}: last line is incomplete; run bin/verify-decisions.ts before writing more`);
  const lines = text.split('\n').filter(Boolean);
  if (headFile) {
    const problem = headProblem(readHead(headFile), key, lines);
    if (problem) throw new Error(`${file}: ${problem}; run bin/verify-decisions.ts before writing more`);
  }
  const out: Record<string, unknown>[] = [];
  let last = lines.length ? lines[lines.length - 1] : '';
  for (const input of inputs) {
    const e: Record<string, unknown> = {
      v: 1, seq: lines.length + out.length + 1, at: now.toISOString(), who: input.who, session: input.session, card: input.card,
      revision: input.revision, choice: input.choice, comment: input.comment, scope: input.scope, scope_hash: sha256(input.scope),
      prev: last ? sha256(last) : GENESIS,
    };
    e.hmac = sign(key, e);
    out.push(e);
    last = JSON.stringify(e);
  }
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, out.map((e) => JSON.stringify(e) + '\n').join('')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (headFile) writeHead(headFile, key, lines.length + out.length, last);
  return out as unknown as Decision[];
}

/** Recompute the chain and every HMAC. Any edit, deletion, reorder, insertion or reformatting fails, naming the line.
 *  With a head (null = its file is missing), lines cut off the end or an emptied ledger fail too. */
export function verifyLedger(text: string, key: Buffer, head?: Head | null): { ok: boolean; count: number; error?: string; line?: number } {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  else if (text) return { ok: false, count: 0, error: 'last line is incomplete (no newline)', line: lines.length };
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    let e: any;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, count: i, error: 'not JSON', line: n }; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, count: i, error: 'not an object', line: n };
    const keys = Object.keys(e);
    if (keys.length !== KEYS.length + 1 || ![...KEYS, 'hmac'].every((k, j) => keys[j] === k)) return { ok: false, count: i, error: 'unexpected fields', line: n };
    if (JSON.stringify(e) !== lines[i]) return { ok: false, count: i, error: 'not in canonical form', line: n };
    if (e.seq !== n) return { ok: false, count: i, error: `seq ${e.seq}, expected ${n}`, line: n };
    if (e.prev !== prev) return { ok: false, count: i, error: 'prev hash does not match the previous line', line: n };
    if (e.scope_hash !== sha256(String(e.scope))) return { ok: false, count: i, error: 'scope_hash does not match scope', line: n };
    const want = Buffer.from(sign(key, e), 'hex'); const got = Buffer.from(String(e.hmac), 'hex');
    if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, count: i, error: 'HMAC mismatch', line: n };
    prev = sha256(lines[i]);
  }
  if (head !== undefined) {
    const problem = headProblem(head, key, lines);
    if (problem) return { ok: false, count: lines.length, error: problem, line: Math.min(head?.seq ?? 1, lines.length + 1) };
  }
  return { ok: true, count: lines.length };
}

// ---------- git witness: a deleted ledger + head is still noticed ----------
// The ledger and its head live outside git and are writable by the server's account (so by its agents too): deleting both
// leaves nothing to compare. Every decision therefore also commits {seq, last} to a tracked file. Removing that file is
// itself a commit (or a dirty tree) anyone can see; the server compares the committed seq with the ledger.
export const WITNESS_REL = 'data/decisions.witness.json';
// A witness names the checkout (its real path) whose ledger it vouches for: the ledger is gitignored and lives only in the
// live board's checkout, so other clones, worktrees and CI (which carry the tracked witness) must not compare against it.
// The path alone, not the host name: renaming the Mac must not lapse the protection.
const here = (root: string) => { let r = root; try { r = fs.realpathSync(root); } catch { /* as given */ } return { root: r }; };
export const witnessContent = (seq: number, lastLine: string, root: string) => JSON.stringify({ v: 1, seq, last: sha256(lastLine), ...here(root) }) + '\n';
/** seq of a witness written for this checkout; null when unreadable; 'other' when it is another checkout's. */
const parseWitness = (text: string, root: string): number | null | 'other' => {
  let w: any; try { w = JSON.parse(text); } catch { return null; }
  if (!Number.isInteger(w?.seq) || w.seq <= 0) return null;
  const h = here(root);
  return w.root === h.root ? w.seq : 'other';
};
/** The highest seq any commit's witness for this checkout ever vouched for (0 when there is none): a later commit that
 *  removes, breaks or lowers the witness does not lower this. A reset that drops those commits from history does
 *  (reflog only); see the doc's residual risks. */
export function witnessSeq(root: string): number {
  let max = 0;
  let shas: string[] = [];
  try { shas = git(root, ['log', '--format=%H', '--', WITNESS_REL]).split('\n').filter(Boolean); } catch { return 0; }
  for (const sha of shas) {
    let text = ''; try { text = git(root, ['show', `${sha}:${WITNESS_REL}`]); } catch { continue; } // the removing commit
    const n = parseWitness(text, root); if (typeof n === 'number' && n > max) max = n;
  }
  return max;
}
/** Error text when the ledger holds fewer decisions than git ever vouched for, or the witness in HEAD was removed,
 *  broken or lowered after decisions existed. */
export function witnessProblem(root: string, ledgerFile: string): string | null {
  const want = witnessSeq(root);
  if (!want) return null;
  let head: number | null | 'other' = null;
  try { head = parseWitness(git(root, ['show', `HEAD:${WITNESS_REL}`]), root); } catch { head = null; }
  if (head === null || head === 'other' || head < want) return `git witness (${WITNESS_REL}) was removed, broken or lowered after it vouched for ${want} decision(s)`;
  const have = readText(ledgerFile).split('\n').filter(Boolean).length;
  return have < want ? `git witness (${WITNESS_REL}) vouches for ${want} decision(s) but the ledger has ${have}: entries or the whole ledger were removed` : null;
}
