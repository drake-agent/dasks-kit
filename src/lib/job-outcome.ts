import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { commitFiles, HttpError, isoLocal, withRepoLock } from './write.ts';
import { isEvidence } from './transitions.ts';
import { isTaskId } from './schema.ts';
import { parseOutcome, type OutcomeKind } from './outcome.ts';

// Results of jobs that have no card of their own (a review-only job, for example).
// POST /api/jobs/<job>/outcome stores one immutable record per (job, run_id) in data/job-outcomes/; it never moves a card.
export const JOB_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
export interface JobOutcome {
  job: string; run_id: string; state: OutcomeKind; note: string; evidence: string[]; handoff?: string;
  decisions?: string[]; learned?: string[]; about?: string[]; actor: string; at: string;
}
const DIR = 'data/job-outcomes';
const relOf = (job: string, runId: string) => `${DIR}/${createHash('sha256').update(JSON.stringify([job, runId])).digest('hex')}.json`;
const payload = (o: Omit<JobOutcome, 'actor' | 'at'>) => JSON.stringify({ job: o.job, run_id: o.run_id, state: o.state, note: o.note, evidence: o.evidence,
  handoff: o.handoff ?? null, decisions: o.decisions ?? [], learned: o.learned ?? [], about: o.about ?? [] });

export function parseJobOutcome(job: string, body: Record<string, unknown>): Omit<JobOutcome, 'actor' | 'at'> {
  if (!JOB_RE.test(job)) throw new HttpError(400, 'job must be an id of letters, digits and ._:- (at most 240)');
  const allowed = ['run_id', 'state', 'note', 'evidence', 'handoff', 'decisions', 'learned', 'about'];
  if (Object.keys(body).some((k) => !allowed.includes(k))) throw new HttpError(400, 'unknown job outcome field');
  if (body.run_id === undefined) throw new HttpError(400, 'run_id is required (one result per job run)');
  const { about: rawAbout, ...rest } = body;
  const input = parseOutcome(rest);
  const about = rawAbout ?? [];
  if (!Array.isArray(about) || about.length > 10 || !about.every((a) => isTaskId(a) || (typeof a === 'string' && /^https:\/\//.test(a) && isEvidence(a))))
    throw new HttpError(400, 'about must list at most 10 card ids or PR URLs');
  return { job, run_id: input.run_id!, state: input.state, note: input.note, evidence: input.evidence,
    ...(input.handoff !== undefined ? { handoff: input.handoff } : {}), ...(input.decisions ? { decisions: input.decisions } : {}),
    ...(input.learned ? { learned: input.learned } : {}), ...(about.length ? { about: about.map(String) } : {}) };
}

/** Accept a job result once per (job, run_id): the same payload replays the stored record, a different one is 409. */
export function recordJobOutcome(root: string, job: string, body: Record<string, unknown>, actor: string): JobOutcome {
  const input = parseJobOutcome(job, body);
  return withRepoLock(root, () => {
    const rel = relOf(job, input.run_id);
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) {
      const previous = JSON.parse(fs.readFileSync(abs, 'utf8')) as JobOutcome;
      if (payload(previous) === payload(input)) return previous;
      throw new HttpError(409, 'a different outcome for this run is already recorded', { rule: 'outcome-conflict' });
    }
    const record: JobOutcome = { ...input, actor, at: isoLocal() };
    commitFiles(root, [{ rel, content: JSON.stringify(record) + '\n' }], `${actor}: job outcome ${job} ${input.state}`.slice(0, 160));
    return record;
  });
}

export function jobOutcomes(root: string, job: string): JobOutcome[] {
  const dir = path.join(root, DIR);
  if (!JOB_RE.test(job) || !fs.existsSync(dir)) return [];
  return readJobOutcomes(dir)
    .filter((o) => o.job === job).sort((a, b) => a.at.localeCompare(b.at) || a.run_id.localeCompare(b.run_id));
}

function readJobOutcomes(dir: string): JobOutcome[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as JobOutcome);
}
