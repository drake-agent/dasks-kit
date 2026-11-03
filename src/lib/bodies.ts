// Request bodies of the write routes, checked: each parser takes the JSON object readJson gave and returns a typed value
// or throws HttpError (400, except where a route's contract says 403 or 409). The pattern is parseHeartbeat's (fleet.ts):
// a fixed field list, every field's type and bounds, nothing passed on unchecked. Fields a domain function validates
// itself (a task patch's fields, an idea, a spec) pass through as Record<string, unknown> to that function.
import { HttpError } from './write.ts';
import { commentOk } from './decisions.ts';
import { ALL_STATUSES, isTaskId, type Status } from './schema.ts';

export type Body = Record<string, unknown>;

const bad = (m: string, status = 400) => new HttpError(status, m);
const optString = (v: unknown, name: string): string | undefined => {
  if (v !== undefined && typeof v !== 'string') throw bad(`${name} must be a string`);
  return v;
};
const isPlainObject = (v: unknown): v is Body => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Optional expected_version: undefined when absent, 400 unless a non-negative integer (a digit string counts). */
export function versionOf(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) throw bad('expected_version must be a non-negative integer');
  return n;
}

/** The human's answer to a card decision (POST /api/decisions) or to an ask (POST /api/asks/<card>/answer, with `ask`).
 *  Anything extra is 409, not 400: it is not the decision the inbox showed. Types that cannot match what was shown
 *  (a scope that is not text, a revision that is not a number: NaN, equal to none) are 409 as well; only a malformed
 *  card id or comment is a client error. */
export interface AnswerBody { card?: string; ask?: string; revision: number; scope: string; choice: string; comment: string }
export function parseAnswer(body: Body, kind: 'decision' | 'ask'): AnswerBody {
  const keys = kind === 'decision' ? ['card', 'revision', 'scope', 'choice', 'comment'] : ['ask', 'revision', 'scope', 'choice', 'comment'];
  const extra = Object.keys(body).filter((k) => !keys.includes(k));
  if (extra.length) throw bad(`${kind === 'decision' ? 'a decision' : 'an answer'} carries only ${keys.slice(0, -1).join(', ')}, comment (got ${extra.join(', ')})`, 409);
  const { card, ask, revision, scope, choice, comment } = body;
  if (kind === 'decision' && !isTaskId(card)) throw bad('card must be a task id');
  if (comment !== undefined && comment !== '' && !commentOk(comment)) throw bad('comment must be plain one-line text (no < > or control characters, at most 500)', 403);
  if (kind === 'ask' && (typeof scope !== 'string' || typeof ask !== 'string')) throw bad('ask and scope must be what the queue showed', 409);
  return {
    ...(kind === 'decision' ? { card: card as string } : { ask: ask as string }),
    revision: typeof revision === 'number' ? revision : NaN, scope: typeof scope === 'string' ? scope : '', choice: typeof choice === 'string' ? choice : '', comment: typeof comment === 'string' ? comment : '',
  };
}

/** POST /api/tasks/<id>/claim | release | finish, after writeOpts took the shared fields. */
export interface CardActionBody {
  who?: unknown; force: unknown; note?: string; result?: string; pr?: string; pr_summary?: string; status?: string;
  summary?: unknown; run_id?: string; exclusive_touches?: boolean;
}
export function parseCardAction(op: 'claim' | 'release' | 'finish', rest: Body): CardActionBody {
  const { who, force, note, result, pr, pr_summary, status, summary, run_id, exclusive_touches, ...extra } = rest;
  if (run_id !== undefined && (op !== 'release' || typeof run_id !== 'string' || !run_id.trim())) throw bad('run_id (release only) must be the run_id the claim returned');
  if (exclusive_touches !== undefined && (op !== 'claim' || typeof exclusive_touches !== 'boolean')) throw bad('exclusive_touches (claim only) must be true or false');
  if (Object.keys(extra).length) throw bad(`unknown field(s) for ${op}: ${Object.keys(extra).join(', ')}`);
  if (op === 'finish') {
    if (typeof result !== 'string' || !result.trim()) throw bad('result is required (≤10 lines)');
    if (status !== undefined && !['done', 'review', 'blocked-on-user'].includes(status as string)) throw bad('finish status must be done, review or blocked-on-user');
  } else if (result !== undefined || pr !== undefined || pr_summary !== undefined || status !== undefined) {
    throw bad(`${op} takes who, force, note, ${op === 'release' ? 'summary, ' : ''}expected_version`);
  }
  if (summary !== undefined && op === 'claim') throw bad('claim takes who, force, note, exclusive_touches, expected_version');
  return {
    who, force, note: optString(note, 'note'), result: optString(result, 'result'), pr: optString(pr, 'pr'), pr_summary: optString(pr_summary, 'pr_summary'),
    status: status as string | undefined, summary, run_id: run_id as string | undefined, exclusive_touches: exclusive_touches as boolean | undefined,
  };
}

/** POST /api/tasks/<id> after writeOpts: the write's own controls, checked; `fields` is the patch (updateTask checks it). */
export interface TaskPatchBody {
  if_status?: Status[]; body?: string; note?: string; append_block?: { heading: string; lines: string[] };
  housekeeping: unknown; reopen: unknown; job_end?: string; push: boolean; sweep: boolean; fields: Body;
}
export function parseTaskPatch(rest: Body): TaskPatchBody {
  const { if_status, body, note, append_block, housekeeping, reopen, job_end, push, sweep, ...fields } = rest;
  if (push !== undefined && typeof push !== 'boolean') throw bad('push must be true or false');
  if (sweep !== undefined && typeof sweep !== 'boolean') throw bad('sweep must be true or false');
  if (job_end !== undefined && (typeof job_end !== 'string' || !job_end.trim() || job_end.length > 240 || /[\r\n\0]/.test(job_end)))
    throw bad('job_end must be the run_id of the job that ended');
  if (append_block !== undefined && (!isPlainObject(append_block) || typeof append_block.heading !== 'string' || !Array.isArray(append_block.lines) || !append_block.lines.every((l) => typeof l === 'string')))
    throw bad('append_block must be {heading: string, lines: string[]}');
  if (if_status !== undefined && (typeof if_status !== 'string' || !if_status.split(',').every((s) => (ALL_STATUSES as readonly string[]).includes(s))))
    throw bad('bad if_status');
  if (body !== undefined && typeof body !== 'string') throw bad('body must be a string');
  return {
    if_status: if_status === undefined ? undefined : (if_status as string).split(',') as Status[], body, note: optString(note, 'note'),
    append_block: append_block as TaskPatchBody['append_block'], housekeeping, reopen, job_end: job_end as string | undefined, push: push === true, sweep: sweep === true, fields,
  };
}

/** POST /api/captain/lease and …/release: {holder?, ttl_sec?, lease_id?}. */
export function parseLease(body: Body): { holder?: unknown; ttl_sec?: unknown; lease_id?: string } {
  const { holder, ttl_sec, lease_id, ...extra } = body;
  if (Object.keys(extra).length) throw bad(`unknown field(s) ${Object.keys(extra).join(', ')}`);
  if (lease_id !== undefined && (typeof lease_id !== 'string' || !lease_id)) throw bad('lease_id must be the id the lease was given');
  return { holder, ttl_sec, lease_id };
}

/** POST /api/captain/lease/check: {lease_id}. */
export function parseLeaseCheck(body: Body): { lease_id: string } {
  if (Object.keys(body).some((k) => k !== 'lease_id')) throw bad('the lease check takes only lease_id');
  return { lease_id: typeof body.lease_id === 'string' ? body.lease_id : '' };
}

/** POST /api/captain/chat: {text, lease_id?}; lease_id only from an agent (the captain). */
export function parseChat(body: Body, human: boolean): { text: string; lease_id: string } {
  if (Object.keys(body).some((k) => k !== 'text' && (k !== 'lease_id' || human))) throw bad('a chat message takes only text (and the captain\'s lease_id)');
  if (typeof body.text !== 'string') throw bad('text must be a string');
  return { text: body.text, lease_id: typeof body.lease_id === 'string' ? body.lease_id : '' };
}

/** POST /api/tasks/<id>/reset-attempts after writeOpts: {reason?}. */
export function parseResetAttempts(rest: Body): { reason?: string } {
  if (Object.keys(rest).some((k) => k !== 'reason')) throw bad('reset-attempts takes reason and expected_version');
  return { reason: optString(rest.reason, 'reason') };
}

/** POST /api/tasks/<id>/outcome-or-fail: a job that ended with no outcome of its own; the failed outcome it records. */
export function parseOutcomeOrFail(body: Body): Body {
  const { job, log, run_id, attempt, cause } = body;
  if (typeof job !== 'string' || !job.trim() || typeof log !== 'string') throw bad('job and log are required');
  return {
    state: 'failed', note: 'ended without a result', evidence: [log], job,
    ...(run_id !== undefined ? { run_id } : {}), ...(attempt !== undefined ? { attempt } : {}), ...(cause !== undefined ? { cause } : {}),
  };
}

/** POST /api/nodes/<id>: the patch plus its guards {expected_title?, if_missing?, expected?}. */
export function parseNodePatch(body: Body): { expected_title?: string; if_missing: unknown; expected?: Record<string, string>; patch: Body } {
  const { expected_title, if_missing, expected, ...patch } = body;
  if (expected_title !== undefined && typeof expected_title !== 'string') throw bad('expected_title must be a string');
  if (expected !== undefined && (!isPlainObject(expected) || Object.values(expected).some((x) => typeof x !== 'string')))
    throw bad('expected must be {field: value-you-saw}');
  return { expected_title, if_missing, expected: expected as Record<string, string> | undefined, patch };
}
