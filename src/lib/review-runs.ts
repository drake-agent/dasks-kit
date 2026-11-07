// Review run records: one row per cross-model review pass (`dask review-record`, the runner), kept on the board so the
// pass limit (two passes per PR) and the clean-review proof survive a new clone or another Mac. Rows stored under an
// older limit (a pass 3, mode `narrow`) stay readable as they are; new ones are refused.
// Append-only audit log:
//   data/review-runs/<goal>/<slug>.jsonl   one JSON row per line, in append order
// Each accepted append is one commit of the whole new file under the repo lock; a refusal writes nothing.
// The board vouches for who sent a row (actor), when (ts) and that answer matches log_sha256; nothing else. Next to
// the row it records what it knows itself, at the time of the append: the sender's model family (reviewer_family) and
// every actor that ever claimed the card with theirs (builders, builder_families, from the claim history), and the
// machine whose token sent it (reviewer_machine; '' = not a fleet machine token, i.e. the board's own Mac). Declared
// `reviewer` and `impl` are the reviewer's own words; `dask captain-merge` trusts only the board's fields.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError, commitFiles, withRepoLock } from './write.ts';
import { TASK_ID_RE, isTaskId } from './schema.ts';
import { isoNow } from './specs.ts';
import { familyOf, readClaimHistory } from './spec-state.ts';

/** Review passes per card (one card, one PR): pass 1 reads the whole change, pass 2 re-checks its findings and the fixes. */
export const REVIEW_PASSES = 2;
export const REVIEW_ANSWER_MAX_BYTES = 262_144;   // answer text, UTF-8
export const REVIEW_RUN_MAX_BODY = 2_097_152;     // raw JSON body (an answer at the cap written as \uXXXX is ~1.5 MiB)

const FIELDS = ['pass', 'head', 'base', 'merge_base', 'tier', 'mode', 'reviewer', 'impl', 'verdict', 'open', 'noted', 'at', 'log_sha256', 'answer'] as const;
const TIERS = ['normal'];
const MODES = ['simple'];
const IMPLS = ['claude', 'codex'];
const VERDICTS = ['clean', 'open'];
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type ReviewRow = Record<string, unknown> & { pass: number };

/** Repo-relative path of one task's review-run file. */
export function reviewRunPath(id: string): string {
  const m = TASK_ID_RE.exec(id);
  if (!m || !isTaskId(id)) throw new HttpError(400, `bad task id "${id}"`);
  return path.join('data', 'review-runs', m[1], `${m[2]}.jsonl`);
}

const bad = (msg: string) => new HttpError(400, msg);

function text(body: Record<string, unknown>, k: string, max: number): string {
  const v = body[k];
  if (typeof v !== 'string' || v.length < 1 || v.length > max) throw bad(`${k} must be a string of 1-${max} characters`);
  if (CONTROL_RE.test(v)) throw bad(`${k} must not contain control characters`);
  if (!v.isWellFormed()) throw bad(`${k} is not valid Unicode (lone surrogate)`);
  return v;
}
function int(body: Record<string, unknown>, k: string, max: number): number {
  const v = body[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw bad(`${k} must be an integer 0-${max}`);
  return v;
}
function oneOf(body: Record<string, unknown>, k: string, allowed: string[]): string {
  const v = body[k];
  if (typeof v !== 'string' || !allowed.includes(v)) throw bad(`${k} must be ${allowed.join(' | ')}`);
  return v;
}

/** Request shape of POST /review-runs (400, 413 for an answer over the cap): the row without actor/ts, in field order. */
export function parseReviewRun(body: Record<string, unknown>): ReviewRow {
  const extra = Object.keys(body).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length) throw bad(`unknown field(s) for a review run: ${extra.join(', ')} (takes ${FIELDS.join(', ')})`);
  const pass = int(body, 'pass', 999);
  if (pass < 1 || pass > REVIEW_PASSES) throw bad(`pass must be 1 or 2: a PR gets at most ${REVIEW_PASSES} review passes`);
  const head = body.head;
  if (typeof head !== 'string' || !SHA1_RE.test(head)) throw bad('head must be 40 lowercase hex (a commit sha)');
  const base = text(body, 'base', 200);
  const mb = body.merge_base;
  if (typeof mb !== 'string' || (mb !== '' && !SHA1_RE.test(mb))) throw bad('merge_base must be 40 lowercase hex or ""');
  const tier = oneOf(body, 'tier', TIERS);
  const mode = oneOf(body, 'mode', MODES);
  const reviewer = text(body, 'reviewer', 200);
  const verdict = oneOf(body, 'verdict', VERDICTS);
  const open = int(body, 'open', 999);
  const noted = body.noted === undefined ? 0 : int(body, 'noted', 999);
  const at = text(body, 'at', 40);
  const absent = (k: string) => body[k] === undefined || body[k] === null;
  let impl: string, log: string, answer: string;
  if (absent('impl')) throw bad('impl is required');
  impl = oneOf(body, 'impl', IMPLS);
  if (absent('log_sha256')) throw bad('log_sha256 is required');
  log = body.log_sha256 as string;
  if (typeof log !== 'string' || !SHA256_RE.test(log)) throw bad('log_sha256 must be 64 lowercase hex');
  if (absent('answer')) throw bad('answer is required');
  answer = body.answer as string;
  if (typeof answer !== 'string') throw bad('answer must be a string');
  if (!answer.isWellFormed()) throw bad('answer is not valid Unicode (lone surrogate)');
  if (verdict === 'clean' && open !== 0) throw bad('verdict clean needs open = 0');
  {
    const buf = Buffer.from(answer, 'utf8');
    if (buf.length > REVIEW_ANSWER_MAX_BYTES)
      throw new HttpError(413, `answer is ${buf.length} bytes; the cap is ${REVIEW_ANSWER_MAX_BYTES}`, { bytes: buf.length, max_bytes: REVIEW_ANSWER_MAX_BYTES });
    if (createHash('sha256').update(buf).digest('hex') !== log) throw bad('log_sha256 is not the sha256 of the UTF-8 bytes of answer');
  }
  return {
    pass, head, base, merge_base: mb, tier, mode, reviewer, impl, verdict, open, noted, at, log_sha256: log, answer,
  };
}

/** The stored rows and their exact lines. Blank lines are ignored; a bad last line (torn write) is skipped; a bad line
 *  before it is a 500 naming its line number. */
function readLines(root: string, id: string): { rows: ReviewRow[]; lines: string[] } {
  let raw: string;
  try { raw = fs.readFileSync(path.join(root, reviewRunPath(id)), 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return { rows: [], lines: [] }; throw e; }
  const all = raw.split('\n');
  const nonBlank = all.map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.trim() !== '');
  const rows: ReviewRow[] = [], lines: string[] = [];
  nonBlank.forEach(({ l, n }, i) => {
    let v: unknown;
    try { v = JSON.parse(l); } catch { v = undefined; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      if (i === nonBlank.length - 1) return; // torn last line: skipped now, dropped by the next append
      throw new HttpError(500, `${reviewRunPath(id)} line ${n} is not a JSON object; repair the file by hand`, { line: n });
    }
    rows.push(v as ReviewRow); lines.push(l);
  });
  return { rows, lines };
}

const withoutAnswer = (r: ReviewRow) => { const { answer, ...rest } = r; return rest; };

/** GET: every stored row in append order, answers included. */
export function readReviewRuns(root: string, id: string): ReviewRow[] {
  // Under the repo lock: another process may be between writing the file and its commit (which can still roll back).
  return withRepoLock(root, () => readLines(root, id).rows);
}

/** POST after the shape and task checks: 409 on a taken pass, a gap before pass n, or a repeat of the last row;
 *  else one commit of the file with the new row appended. Returns the stored row without its answer. */
export function appendReviewRun(root: string, id: string, input: ReviewRow, actor: string, now = new Date(),
  board: { families?: Record<string, string>; claimedBy?: string; machine?: string } = {}): Record<string, unknown> {
  return withRepoLock(root, () => {
    const { rows, lines } = readLines(root, id);
    const conflict = (msg: string) => new HttpError(409, msg, { passes: rows.map(withoutAnswer) });
    const n = input.pass;
    if (rows.some((r) => r.pass === n)) throw conflict(`${id} already has a review pass ${n}; each pass number is used once per card`);
    const missing = [];
    for (let k = 1; k < n; k++) if (!rows.some((r) => r.pass === k)) missing.push(k);
    if (missing.length) throw conflict(`${id} has no review pass ${missing.join(', ')} yet; pass ${n} comes after it`);
    const last = rows[rows.length - 1];
    if (last && (['pass', 'head', 'base', 'merge_base', 'tier'] as const).every((k) => last[k] === input[k]))
      throw conflict(`${id}: this row repeats the last stored row (same pass, head, base, merge_base and tier)`);
    const fam = (a: string) => familyOf(a, board.families) ?? '';
    const builders = [...new Set([...(readClaimHistory(root, id)?.who ?? []), ...(board.claimedBy ? [board.claimedBy] : [])])];
    const row: ReviewRow = { ...input, actor, ts: isoNow(now), reviewer_family: fam(actor), reviewer_machine: board.machine ?? '', builders, builder_families: builders.map(fam) };
    const content = [...lines, JSON.stringify(row)].join('\n') + '\n';
    commitFiles(root, [{ rel: reviewRunPath(id), content }], `${actor}: review-run ${id} pass ${n}`);
    return withoutAnswer(row);
  });
}
