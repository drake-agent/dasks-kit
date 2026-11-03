import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError, isoLocal, readTask, updateTask, withRepoLock, type UpdateOpts, atomicWrite } from './write.ts';
import { loadConfig } from './config.ts';
import { isEvidence } from './transitions.ts';
import { cardOwner, type Task, type Status } from './schema.ts';
import { parseContext } from './collab.ts';
import { askLive, planAsk, readAsks } from './asks.ts';
import { parkNote, parkRoute } from './park.ts';
import { validateAsk } from '../../public/user-ask.js';

function isLogPath(value: string): boolean { return !!value.trim() && value.length <= 2000 && !/[\r\n\0]/.test(value); }

// needs-spec: the card itself must change (spec, scope, a review cap): todo in the spec-rework lane, for the card's owner.
const OUTCOME_STATES = ['done', 'failed', 'needs-review', 'needs-user', 'needs-spec'] as const;
export type OutcomeKind = typeof OUTCOME_STATES[number];
/** Why a run failed, when it was not the work's fault: model quota or rate limits. Such failures are recorded but do not
 *  count toward retry_cap (a quota outage must not lock healthy cards); quota_retry_cap bounds them instead. */
export const OUTCOME_CAUSES = ['quota', 'rate-limit', 'infra'] as const;
export type OutcomeCause = typeof OUTCOME_CAUSES[number];
/** ask: a needs-user outcome's decision for the user, in the /api/asks shape (options and a recommendation). */
export interface OutcomeInput { state: OutcomeKind; note: string; evidence: string[]; job?: string; handoff?: string; run_id?: string; attempt?: number; cause?: OutcomeCause; decisions?: string[]; learned?: string[]; ask?: Record<string, unknown> }
/** as_state / as_cause: what the board did with a needs-user outcome that carried no real decision (src/lib/park.ts). The
 *  record keeps the job's own state, so a replay of the same outcome still matches it. */
/** status_kept: the card was done/cancelled when this outcome landed; it was recorded but moved nothing (no route, no ask). */
export interface OutcomeRecord extends OutcomeInput { id: string; job: string; at: string; actor: string; version: number; route?: Route; reset_epoch?: number; response?: Task; as_state?: OutcomeKind; as_cause?: OutcomeCause; status_kept?: 'done' | 'cancelled' }
interface Route { kind: 'reviewer' | 'fix' | 'retry' | 'failed-terminal' | 'needs-user' | 'spec-rework'; job: string; next_owner: string; at: string }

// `Decision:` and `Learned:` lines from a job's RESULT.md. Short single lines, capped, and never anything shaped like a
// credential: they are stored on the board and shown to other agents.
const LINES_MAX = 12, LINE_MAX = 240;
const TOKEN_LIKE: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:bearer|token|secret|password|passwd|api[_-]?key|access[_-]?key)\s*[:=]\s*\S{8,}/i, /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  // Opaque runs with upper, lower and digits (base64-ish keys, `+` included). Slashes, dots and hyphens split a run, so paths such as
  // data/job-outcomes/2026-10-18/RESULT.md and hyphenated ids pass; lowercase hex such as a git SHA is not one either.
  /(?=[A-Za-z0-9_+]*[A-Z])(?=[A-Za-z0-9_+]*[a-z])(?=[A-Za-z0-9_+]*\d)[A-Za-z0-9_+]{32,}/,
];
export function looksLikeToken(text: string): boolean { return TOKEN_LIKE.some((re) => re.test(text)); }
export function parseLines(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > LINES_MAX) throw new HttpError(400, `${field} must be an array of at most ${LINES_MAX} lines`);
  const lines = value.map((line, i) => {
    if (typeof line !== 'string' || !line.trim() || line.length > LINE_MAX || /[\u0000-\u001f\u007f]/.test(line)) throw new HttpError(400, `${field}[${i}] must be one nonempty line of at most ${LINE_MAX} characters`);
    if (looksLikeToken(line)) throw new HttpError(400, `${field}[${i}] looks like a credential; remove it`, { rule: 'token-like' });
    return line.trim();
  });
  return lines.length ? lines : undefined;
}

export function parseOutcome(body: Record<string, unknown>): OutcomeInput {
  const allowed = ['state', 'note', 'evidence', 'job', 'handoff', 'expected_version', 'run_id', 'attempt', 'cause', 'decisions', 'learned', 'ask'];
  if (Object.keys(body).some((k) => !allowed.includes(k))) throw new HttpError(400, 'unknown outcome field');
  const state = OUTCOME_STATES.find((x) => x === body.state);
  if (!state) throw new HttpError(400, 'state must be done, failed, needs-review, needs-user or needs-spec');
  if (typeof body.note !== 'string' || !body.note.trim() || body.note.length > 1500 || /[\r\n]/.test(body.note)) throw new HttpError(400, 'note must be one line');
  const evidence = body.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 20 || !evidence.every((e) => typeof e === 'string' && (state === 'failed' || state === 'needs-spec' ? isLogPath(e) : isEvidence(e)))) throw new HttpError(400, 'evidence must contain PR URLs, log paths or RESULT.md paths');
  if (['done', 'needs-review'].includes(state) && !evidence.length) throw new HttpError(400, 'done/needs-review requires evidence');
  if (body.job !== undefined && (typeof body.job !== 'string' || !body.job.trim() || body.job.length > 240 || /[\r\n]/.test(body.job))) throw new HttpError(400, 'job must be a nonempty single-line id');
  if (body.handoff !== undefined && (typeof body.handoff !== 'string' || body.handoff.replace(/\r\n/g, '\n').trimEnd().split('\n').length > 40 || body.handoff.length > 8000 || body.handoff.includes('dasks-handoff'))) throw new HttpError(400, 'handoff must be markdown of at most 40 lines and 8000 characters');
  if (body.run_id !== undefined && (typeof body.run_id !== 'string' || !body.run_id.trim() || body.run_id.length > 240 || /[\r\n\0]/.test(body.run_id))) throw new HttpError(400, 'run_id must be a nonempty single-line id');
  if (body.attempt !== undefined && (!Number.isSafeInteger(body.attempt) || Number(body.attempt) < 1 || body.run_id === undefined)) throw new HttpError(400, 'attempt must be a positive integer paired with run_id');
  const cause = body.cause === undefined ? undefined : OUTCOME_CAUSES.find((c) => c === body.cause);
  if (body.cause !== undefined && (!cause || state !== 'failed')) throw new HttpError(400, `cause must be ${OUTCOME_CAUSES.join(' or ')}, and only on a failed outcome`);
  const decisions = parseLines(body.decisions, 'decisions'), learned = parseLines(body.learned, 'learned');
  if (body.ask !== undefined) {
    if (state !== 'needs-user') throw new HttpError(400, 'ask is only for a needs-user outcome');
    const errs = validateAsk(body.ask);
    if (errs.length) throw new HttpError(400, `ask is not the decision shape: ${errs.join('; ')}`, { reasons: errs });
  }
  return { ...(body.ask !== undefined ? { ask: body.ask as Record<string, unknown> } : {}), ...(decisions ? { decisions } : {}), ...(learned ? { learned } : {}), ...(typeof body.run_id === 'string' ? { run_id: body.run_id.trim() } : {}), ...(typeof body.attempt === 'number' ? { attempt: body.attempt } : {}), state, note: body.note.trim(), evidence: evidence.map(String), ...(typeof body.job === 'string' ? { job: body.job.trim() } : {}), ...(typeof body.handoff === 'string' ? { handoff: body.handoff.trimEnd() } : {}), ...(cause ? { cause } : {}) };
}
const ledgerRel = (job: string) => `data/outcomes/${createHash('sha256').update(job).digest('hex')}.json`;
export function allOutcomes(root: string): OutcomeRecord[] {
  const dir = path.join(root, 'data/outcomes');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).sort((a: OutcomeRecord, b: OutcomeRecord) => a.at.localeCompare(b.at) || a.version - b.version);
}
export function taskOutcomes(root: string, id: string) { return allOutcomes(root).filter((o) => o.id === id); }
const HANDOFF_BLOCK = /(?:^|\n)## Handoff[ \t]*\n<!-- dasks-handoff -->\n([\s\S]*?)\n<!-- \/dasks-handoff -->/;
export function handoffOf(body: string): string {
  return HANDOFF_BLOCK.exec(body)?.[1] ?? /(?:^|\n)## Handoff[ \t]*\n([\s\S]*?)(?=\n## (?!#)|$)/.exec(body)?.[1].trimEnd() ?? '';
}
function withHandoff(body: string, handoff: string): string {
  const rest = body.replace(HANDOFF_BLOCK, '').replace(/(?:^|\n)## Handoff[ \t]*\n[\s\S]*?(?=\n## (?!#)|$)/g, '');
  return `${rest.trimEnd()}\n\n## Handoff\n<!-- dasks-handoff -->\n${handoff}\n<!-- /dasks-handoff -->\n`;
}
/** Failed runs that count toward retry_cap in the current reset epoch: quota / rate-limit / infra failures do not. */
export function failedRuns(root: string, t: Task): number {
  return countFailedRuns(root, t, (c) => !c);
}
/** Quota / rate-limit failed runs in the current reset epoch (bounded by quota_retry_cap). */
export function causedRuns(root: string, t: Task): number {
  return countFailedRuns(root, t, (c) => !!c && c !== 'infra');
}
/** Infra failed runs in the current reset epoch (bounded by infra_retry_cap), rerouted needs-user outcomes included. */
export function infraRuns(root: string, t: Task): number {
  return countFailedRuns(root, t, (c) => c === 'infra');
}
function countFailedRuns(root: string, t: Task, which: (cause: OutcomeCause | undefined) => boolean): number {
  const epoch = Number(t.reset_epoch || 0);
  // An infra run that hit infra_retry_cap is stored as needs-spec (as_cause infra): it still counts, so the cap holds.
  const failed = (o: OutcomeRecord) => (o.as_state ?? o.state) === 'failed' || (o.as_state === 'needs-spec' && o.as_cause === 'infra');
  return new Set(taskOutcomes(root, t.id).filter((o) => failed(o) && which(o.as_cause ?? o.cause) && (o.reset_epoch ?? 0) === epoch).map((o) => o.run_id ?? o.job)).size;
}
export function assertRetryAllowed(root: string, t: Task): void {
  const cfg = loadConfig(root);
  if (t.lane === 'failed-terminal' || failedRuns(root, t) >= cfg.retry_cap || causedRuns(root, t) >= cfg.quota_retry_cap || infraRuns(root, t) >= cfg.infra_retry_cap)
    throw new HttpError(409, 'retry cap reached: the user or the card\'s owner must reset the attempts', { rule: 'retry-cap' });
}
export function resetAttempts(root: string, id: string, reason: unknown, actor: string, opts: UpdateOpts = {}): Task {
  return withRepoLock(root, () => {
    const cur = readTask(root, id);
    if (!['user', cardOwner(cur)].includes(actor)) throw new HttpError(403, 'only the user or the card\'s owner can reset attempts');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1500 || /[\r\n]/.test(reason)) throw new HttpError(400, 'reason must be one line');
    return updateTask(root, id, { status: 'todo', lane: cur.lane === 'failed-terminal' || cur.lane === 'spec-rework' ? 'none' : cur.lane, next_owner: '', needs_user: '' }, actor,
      { ...opts, reopen: true, resetAttempts: { reason }, action: 'reset-attempts', appendNote: reason.trim() });
  });
}
function payload(input: OutcomeInput, job: string): string {
  return JSON.stringify({ state: input.state, note: input.note, evidence: input.evidence, job, handoff: input.handoff ?? null, cause: input.cause ?? null, decisions: input.decisions ?? [], learned: input.learned ?? [], ask: input.ask ?? null });
}
// One status change per job end: the run's outcome is the mover. A launcher close (`job_end: <run_id>` on a status write)
// that lands first leaves this marker, and a later outcome for that run then keeps the status.
export const jobEndRel = (id: string, runId: string, attempt: number) => `data/job-ends/${createHash('sha256').update(JSON.stringify([id, runId, attempt])).digest('hex')}.json`;
export function runOutcome(root: string, t: Task): OutcomeRecord | undefined {
  return t.run_id ? taskOutcomes(root, t.id).find((o) => o.run_id === t.run_id && o.attempt === Number(t.attempt)) : undefined;
}
export function recordOutcome(root: string, id: string, body: Record<string, unknown>, actor: string, opts: UpdateOpts = {}, missingOnly = false): Task {
  const input = parseOutcome(body);
  return withRepoLock(root, () => {
    const cur = readTask(root, id);
    const outcomes = taskOutcomes(root, id);
    const epoch = Number(cur.reset_epoch || 0);
    // A done or cancelled card is closed: outcome-or-fail (every launcher job end calls it) never writes there, stale ids
    // included, and answers with the stored response for its key or the card as it is.
    const terminal = cur.status === 'done' || cur.status === 'cancelled' ? cur.status : undefined;
    if (terminal && missingOnly) {
      const stored = input.run_id !== undefined
        ? outcomes.find((o) => o.run_id === input.run_id && (input.attempt === undefined || o.attempt === input.attempt))
        // run-less binds to the current run (as everywhere else); only a card that never had a run keys on the job
        : cur.run_id ? outcomes.find((o) => o.run_id === cur.run_id && o.attempt === Number(cur.attempt)) : outcomes.find((o) => o.job === input.job);
      return stored?.response ?? cur;
    }
    if (input.run_id !== undefined ? input.run_id !== cur.run_id || input.attempt !== undefined && input.attempt !== Number(cur.attempt) : epoch > 0 && !cur.run_id)
      throw new HttpError(409, 'this outcome is not for the current run', { rule: 'stale-outcome' });
    // A run-less outcome binds to the current run, so it must come from the job the card's open claim names: a late write
    // from an older job would otherwise close the newer run.
    const claim = openClaim(cur.body);
    if (input.run_id === undefined && cur.run_id && input.job !== undefined && claim && claim !== input.job)
      throw new HttpError(409, 'this outcome is not for the current run', { rule: 'stale-outcome' });
    // A card that never started keys its outcome on the version. Reuse the last implicit job only while that outcome is still
    // the card's latest write and the retry carries the same payload (a lost reply); anything else is a new outcome.
    const anyImplicit = cur.started_at ? undefined : outcomes.findLast((o) => o.job === `${id}:version-${o.version - 1}`);
    const lastImplicit = anyImplicit && anyImplicit.version === Number(cur.version || 0) ? anyImplicit : undefined;
    const implicit = cur.started_at ? `${id}:${cur.started_at}`
      : lastImplicit && payload(lastImplicit, lastImplicit.job) === payload(input, lastImplicit.job) ? lastImplicit.job : `${id}:version-${cur.version || 0}`;
    const job = input.job ?? (cur.run_id ? `${id}:${cur.run_id}` : implicit);
    const runId = cur.run_id ?? `implicit:${job}`;
    const attempt = cur.run_id ? Number(cur.attempt) : outcomes.find((o) => o.job === job)?.attempt ?? outcomes.length + 1;
    const rel = ledgerRel(cur.run_id ? JSON.stringify([id, runId, attempt]) : job);
    let previous = outcomes.find((o) => cur.run_id ? o.run_id === runId && o.attempt === attempt : o.job === job);
    const global = allOutcomes(root).find((o) => o.job === job);
    if (global && global.id !== id) throw new HttpError(409, 'job belongs to another card', { rule: 'outcome-job' });
    // outcome-or-fail only asks whether this never-started card already has an outcome, so later edits do not matter here.
    if (missingOnly && !previous && !cur.run_id) previous = outcomes.find((o) => o.job === implicit) ?? anyImplicit;
    if (previous) {
      if (missingOnly || payload(previous, previous.job) === payload(input, job)) return previous.response ?? cur;
      throw new HttpError(409, 'a different outcome for this run is already recorded', { rule: 'outcome-conflict' });
    }
    // A new outcome on a closed card is acted on only when it names the card's current run exactly (run_id and attempt):
    // then it is recorded and the status kept. Anything else is a stale message (fencing): refused, nothing written. This is
    // the outcome API's own rule, so it holds under gates "warn" too.
    if (terminal && (input.run_id === undefined || input.attempt === undefined || input.run_id !== cur.run_id || input.attempt !== Number(cur.attempt)))
      throw new HttpError(409, `the card is already ${terminal}; only an outcome naming its current run (run_id and attempt) is recorded`, { rule: 'stale-outcome' });
    if (cur.lane === 'failed-terminal' && !terminal) assertRetryAllowed(root, cur);
    // needs-user parks the card on the user only for a real decision (src/lib/park.ts): an ask in the /api/asks shape (this
    // outcome's, or one the card already has open) or a note about something only the user can do. An infra-shaped note
    // is a failed run (cause infra, run again); anything else goes back to the card's owner (needs-spec).
    let state: OutcomeKind = input.state, cause = input.cause, rerouted: 'retry' | 'rework' | undefined;
    if (input.state === 'needs-user' && !terminal) {
      const open = readAsks(root, id)?.open;
      if (input.ask && open && askLive(root, cur, open)) throw new HttpError(409, `${id} already waits on the user (${open.id}); one decision per card at a time`, { open });
      const r = parkRoute([input.note, ...(input.decisions ?? [])].join(' '), !!input.ask || askLive(root, cur, open));
      if (r === 'retry') { state = 'failed'; cause = 'infra'; rerouted = r; }
      else if (r === 'rework') { state = 'needs-spec'; rerouted = r; }
    }
    // A quota / rate-limit / infra failure is not the work's fault: it does not use up retry_cap and the card simply waits to
    // be run again (route "retry"). quota_retry_cap / infra_retry_cap still stop a card whose runs keep failing that way.
    const cfg = loadConfig(root);
    const caused = state === 'failed' && !!cause;
    const infra = caused && cause === 'infra';
    const failures = failedRuns(root, cur) + (state === 'failed' && !caused ? 1 : 0);
    const causedCount = causedRuns(root, cur) + (caused && !infra ? 1 : 0);
    const infraCount = infraRuns(root, cur) + (infra ? 1 : 0);
    // The runner's job_end write already moved the card for this run: record the outcome but keep the status. The caps
    // are not applied as a move here either (done -> blocked-on-user is not a legal move); the failed run still counts,
    // so the next claim is refused at the cap (assertRetryAllowed).
    // A closed card keeps its status the same way (terminal), with no route, ask or cap at all.
    const ended = !!terminal || !!cur.run_id && fs.existsSync(path.join(root, jobEndRel(id, runId, attempt)));
    // Either limit caps the card, whichever this run reports: dispatch (assertRetryAllowed) checks both, so a card is
    // never sent back to todo while it can no longer be claimed (e.g. retry_cap lowered between runs).
    const capByQuota = causedCount >= cfg.quota_retry_cap;
    const capByFailures = failures >= cfg.retry_cap;
    // Infra runs that keep failing are a card for its owner to fix (lane spec-rework), never a wait on the user.
    const capByInfra = !ended && infra && infraCount >= cfg.infra_retry_cap;
    if (capByInfra) state = 'needs-spec';
    const capped = !ended && state === 'failed' && (capByFailures || capByQuota);
    const statuses: Record<OutcomeKind, Status> = { done: 'done', failed: 'todo', 'needs-review': 'review', 'needs-user': 'blocked-on-user', 'needs-spec': 'todo' };
    const status = ended ? cur.status : capped ? 'blocked-on-user' : statuses[state];
    const owner = cardOwner(cur);
    const nextOwner = capped || state === 'needs-spec' ? owner : caused ? 'retry' : { done: '', failed: 'fix', 'needs-review': 'reviewer', 'needs-user': owner }[state];
    const at = isoLocal();
    const kinds: Record<OutcomeKind, Route['kind'] | null> = { done: null, failed: 'fix', 'needs-review': 'reviewer', 'needs-user': 'needs-user', 'needs-spec': 'spec-rework' };
    const kind = capped ? 'failed-terminal' : state === 'needs-spec' ? 'spec-rework' : caused ? 'retry' : kinds[state];
    const route: Route | undefined = kind && !terminal ? { kind, job: `${job}:${kind}`, next_owner: nextOwner, at } : undefined;
    const reason = capped
      ? (capByFailures ? `retry cap reached after ${failures} failed runs; the card's owner to check. ${input.note}` : `retry cap reached after ${causedCount} quota or rate-limit failures; the card's owner to check. ${input.note}`).slice(0, 1500)
      : input.note;
    const patch: Record<string, string> = ended ? { result: [input.note, ...input.evidence.slice(0, 1)].join('\n') }
      : { status, next_owner: nextOwner, result: [input.note, ...input.evidence.slice(0, 1)].join('\n') };
    if (capped) patch.lane = 'failed-terminal';
    if (!ended && state === 'needs-spec') { patch.lane = 'spec-rework'; patch.needs_user = ''; }
    if (!ended && status === 'blocked-on-user') patch.needs_user = reason;
    // The outcome's own ask opens in this same write (one commit: a replay returns exactly this response).
    const asked = input.ask && !ended && status === 'blocked-on-user' ? planAsk(root, cur, input.ask, actor) : undefined;
    if (asked) patch.needs_user = asked.needs_user;
    const note = rerouted && !ended ? `${input.note} · ${capByInfra ? `infra failed ${infraCount} times: back to the card's owner` : parkNote(rerouted, input.note).split(' (')[0]}`.slice(0, 1500)
      : capByInfra ? `${input.note} · infra failed ${infraCount} times: back to the card's owner`.slice(0, 1500) : input.note;
    const pr = input.evidence.find((e) => e.startsWith('https://')); if (pr) { patch.pr = pr; patch.pr_summary = input.note; }
    if (ended && !pr && cur.pr && !/[\p{L}\p{N}]/u.test(cur.pr_summary || '')) patch.pr_summary = input.note;
    if (terminal) opts.warnings?.push(`status kept: card is ${terminal}`);
    else if (ended) opts.warnings?.push('status kept: this run\'s job end already moved the card');
    // A late outcome keeps whatever context block the close wrote and only fills fields that are missing (an exempt closer
    // may have written none), so its handoff and ledger record are never refused for context.
    const have: Record<string, string | undefined> = ended ? (parseContext(cur.body) ?? {}) : {};
    const fill = (k: string) => (ended && have[k] && /[\p{L}\p{N}]/u.test(have[k]!) ? '' : reason);
    const context = asked ? asked.context : ['review', 'blocked-on-user'].includes(status) ? { what: fill('what'), why: fill('why'), do: fill('do'), rec: fill('rec'), after: fill('after') } : undefined;
    const as = state !== input.state || cause !== input.cause ? { as_state: state, ...(cause ? { as_cause: cause } : {}) } : {};
    const next = updateTask(root, id, patch, actor, { ...opts, context, body: input.handoff !== undefined ? withHandoff(cur.body, input.handoff) : undefined, action: 'outcome', outcome: state, appendNote: asked ? `${asked.note} · ${note}` : note,
      extraFiles: (response) => [...(asked ? [asked.file] : []), { rel, content: JSON.stringify({ ...input, job, id, run_id: runId, attempt, reset_epoch: epoch, actor, at, version: Number(response.version), ...(route ? { route } : {}), ...as, ...(terminal ? { status_kept: terminal } : {}), response } satisfies OutcomeRecord) + '\n' }] });
    if (input.state === 'needs-user') {
      try { decisionsToday(root, at.slice(0, 10)); } catch { /* GET rebuilds the projection from the committed ledger */ }
    }
    return next;
  });
}
export function recordRunEnd(root: string, run: { id: string; run_id: string; attempt: number }, reason: 'expired', actor = 'server'): Task {
  return recordOutcome(root, run.id, { state: 'failed', note: 'run expired', evidence: [], run_id: run.run_id, attempt: run.attempt, job: `${run.run_id}:${reason}` }, actor);
}
export function decisionsToday(root: string, day = isoLocal().slice(0, 10)) {
  const rows = allOutcomes(root).filter((o) => o.state === 'needs-user' && !o.as_state && !o.status_kept && o.at.slice(0, 10) === day);
  const dir = loadConfig(root).decisions_dir;
  const file = path.resolve(root, dir, `${day}.jsonl`);
  atomicWrite(file, rows.map((o) => JSON.stringify(o)).join('\n') + (rows.length ? '\n' : ''));
  return rows;
}

/** The open lock id in a card body (`claim: #<id> open`, the last claim line wins), or null. */
export function openClaim(body: string | undefined): string | null {
  const m = [...String(body || '').matchAll(/claim: #([\w.-]+) (open|closed)/g)];
  const last = m[m.length - 1];
  return last && last[2] === 'open' ? last[1] : null;
}
