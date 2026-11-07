// One card run of the runner, as one state flow: claim -> recovery record -> worktree -> build -> review pass 1 -> fix ->
// review pass 2 -> scan, push, draft PR -> hand back (and a block when pass 2 is not clean). Every way out goes through settle(): the outcome (when the attempt counts) is recorded
// for this run before the claim is released, the release names the run so it cannot touch a later one, and the
// recovery record stays until the board has confirmed it. Nothing here assumes one machine: the board URL, the machine
// name and the token come from the caller (the stored connection).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  agentCommand, agentText, attemptVerdict, continuePrompt, countStart, fixPrompt, prBody, RATE_LIMITED, readCodeReview, recheckPrompt, resumeLine, resultLine, reviewPrompt, runnerRules, withFollowUps,
  type HistoryRow, type Picked, type RunnerConfig, type RunnerState, type RunRecord, type Tool,
} from './runner.ts';
import { REVIEW_PASSES } from './review-runs.ts';
import { supervise, worktreeStamp, type Supervised } from './supervise.ts';
import { humanStepLine, humanStepsOf, mergeHumanSteps } from './human-steps.ts';
import { closeRepoView, openRepoView, repoSource, specLoop, TOOL_NAME as SPEC_TOOL_NAME, type AgentRun } from './spec-flow.ts';
import { originRef, pickStart, pushableBranch, saveWork } from './keep-work.ts';
import { SPEC_RETRIES, type SpecPicked } from './runner.ts';

export class BoardError extends Error {
  status: number; body: any;
  constructor(status: number, msg: string, body?: any) { super(msg); this.status = status; this.body = body; }
}

export interface FlowEnv {
  kit: string;
  runsDir: string;
  worktreesDir: string;
  machine: string;
  actor: string;
  boardUrl: string;
  /** Extra environment for every agent and helper the run starts (board URL, machine). */
  agentEnv: NodeJS.ProcessEnv;
  /** A board call as `actor`, or as `as` (another name on this machine: the build tool when claiming, the reviewer when
   *  recording its review). */
  api: (method: string, route: string, body?: unknown, as?: string) => Promise<any>;
  update: (fn: (s: RunnerState) => void) => RunnerState;
  log: (line: string) => void;
  which: (cmd: string) => string | null;
  tickMs: number;
  graceMs: number;
  stopping: () => boolean;
  /** The agent running for a card right now (null when none), so a stop signal can end it. */
  track: (card: string, agent: Supervised | null) => void;
  /** How often a running card's worktree is checked for changes (ms). */
  activityMs?: number;
}

const TOOL_NAME: Record<Tool, string> = { claude: 'Claude', codex: 'Codex' };
const oneLine = (s: string, n = 300) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…'; };
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${oneLine(r.stderr || r.stdout || String(r.error), 400)}`);
  return r.stdout.trim();
}
const gitOk = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 }).status === 0;

export function defaultBase(repo: string): string {
  const r = spawnSync('git', ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) if (gitOk(repo, 'rev-parse', '-q', '--verify', b)) return b;
  throw new Error('no default branch (origin/HEAD, main or master) in ' + repo);
}

export function removeWorktree(repo: string, dir: string): void {
  if (fs.existsSync(dir)) gitOk(repo, 'worktree', 'remove', '--force', dir);
  fs.rmSync(dir, { recursive: true, force: true });
  gitOk(repo, 'worktree', 'prune');
}

function commitsAfter(repo: string, from: string, branch: string): number {
  try { return Number(git(repo, 'rev-list', '--count', `${from}..refs/heads/${branch}`)); } catch { return 0; }
}

function history(env: FlowEnv, card: string, r: RunRecord, outcome: HistoryRow['outcome'], detail: string, pr?: string) {
  env.update((s) => {
    delete s.running[card];
    s.history.push({ card, tool: r.tool, started: r.since, ended: new Date().toISOString(), outcome, detail: oneLine(detail, 300), log: r.log, ...(pr ? { pr } : {}) });
    s.history = s.history.slice(-50);
  });
}

/** Give the card back for one failed or stopped attempt. Order matters: the build's work is saved first (keep-work.ts;
 *  once per run, and whatever happens to it the card still goes back), then the outcome of THIS run (it counts toward the
 *  retry cap only when `count`), then a release that names the run. Both carry where the work is. If the board cannot be
 *  reached, the record stays with `pending` and the next look or a restart tries again. Returns true when the board
 *  confirmed. */
export async function settle(env: FlowEnv, card: string, r: RunRecord, reason: string, count: boolean, outcome: HistoryRow['outcome'] = count ? 'released' : 'error'): Promise<boolean> {
  env.update((s) => { if (s.running[card]) Object.assign(s.running[card], { phase: 'releasing', pending: { reason, count } }); });
  if (r.saved === undefined && r.kind !== 'spec' && r.repo && r.base) {
    // A run that lost the card (a runner back from the dead, say) leaves the branch to the run that holds it now.
    const now = await env.api('GET', `/api/tasks/${card}?log=0`).catch(() => null);
    const lost = now?.run_id && r.run_id && now.run_id !== r.run_id;
    r.saved = lost ? '' : await saveWork({ repo: r.repo, dir: r.dir, branch: r.branch, base: r.base, card, machine: r.machine, reason, gitleaks: env.which('gitleaks') });
    const saved = r.saved;
    env.update((s) => { if (s.running[card]) s.running[card].saved = saved; });
    if (saved) env.log(`${card}: ${saved}`);
  }
  const where = r.saved ? ` ${r.saved}` : '';
  if (count) {
    try {
      await env.api('POST', `/api/tasks/${card}/outcome`, { state: 'failed', note: `${oneLine(`runner: ${reason}`, 600)}${where}`, evidence: [r.log], job: r.job, run_id: r.run_id, attempt: r.attempt });
    } catch (e: any) {
      if (!(e instanceof BoardError) || e.status >= 500) { env.log(`${card}: outcome not recorded yet (${e.message}); will retry`); return false; }
      env.log(`${card}: outcome refused: ${e.message}`);
    }
  }
  try {
    await env.api('POST', `/api/tasks/${card}/release`, { run_id: r.run_id, note: `claim: #${r.job} closed (runner: ${oneLine(reason, 200)}). The runner gave the card back: ${oneLine(reason, 400)}.${where} Log: ${r.log}` });
  } catch (e: any) {
    if (e instanceof BoardError && e.status === 409 && e.body?.rule === 'run') env.log(`${card}: already on another run; nothing to release`);
    else if (e instanceof BoardError && e.status < 500) env.log(`${card}: release refused: ${e.message}`);
    else { env.log(`${card}: release failed (${e.message}); will retry`); return false; }
  }
  // Commits stay on the local branch too; only a branch with nothing beyond its base is deleted.
  if (r.kind === 'spec') { if (r.dir) closeRepoView(r.repo, r.dir); }
  else if (r.repo && r.dir) {
    removeWorktree(r.repo, r.dir);
    if (r.base && commitsAfter(r.repo, r.base, r.branch) === 0) gitOk(r.repo, 'branch', '-D', r.branch);
  }
  env.log(`${card}: released (${reason})${count ? '; attempt counted' : ''}`);
  history(env, card, r, outcome, `${oneLine(reason, 150)}${where}`);
  return true;
}

/** Not clean after the last pass: Spec block with the open findings and a message to the user. Safe to repeat: a card
 *  already blocked is left as it is, and the message has one request id per run. */
async function blockAtLimit(env: FlowEnv, card: string, r: RunRecord, pr: string, open: string[]): Promise<void> {
  const findings = oneLine(open.join(' | '), 800);
  const t = await env.api('GET', `/api/tasks/${card}?log=0`);
  if (t?.spec_state !== 'blocked') {
    let sp: any = null;
    try { sp = await env.api('GET', `/api/tasks/${card}/spec`); } catch (e: any) { if (!(e instanceof BoardError) || e.status !== 404) throw e; }
    await env.api('POST', `/api/tasks/${card}/spec/block`, {
      expected_version: Number(t?.version ?? 0), expected_spec_version: Number(sp?.metadata?.version ?? 0),
      block_note: oneLine(`NEEDS-SPEC (${env.actor}): not clean after ${REVIEW_PASSES} review passes: ${findings}`, 1000),
    });
  }
  await env.api('POST', `/api/tasks/${card}/messages`, {
    text: oneLine(`Review of ${card} is not clean after ${REVIEW_PASSES} passes; ${pr} stays a draft and the card is blocked. Open: ${findings}`, 1000),
    to: 'user', kind: 'heads-up', request_id: `review-limit-${r.run_id}`.slice(0, 64),
  });
}

/** The hand-back after the draft PR is open: card to review with its context, claim closed, released. Each skipped step
 *  (`skipped`: HUMAN-STEP lines) gets a card note first. `blocked`: the review
 *  stopped at the pass limit, so the card is also blocked and the user told. A retry may note a step twice; the summary
 *  lists it once. */
export async function handBack(env: FlowEnv, card: string, r: RunRecord, pr: string, title: string, summary: string, reviewNote: string, open: string[], blocked = false, skipped: string[] = []): Promise<boolean> {
  env.update((s) => { if (s.running[card]) Object.assign(s.running[card], { phase: 'handing-back', handback: { pr, title, summary, review_note: reviewNote, open, blocked, skipped } }); });
  const tool = TOOL_NAME[r.tool];
  try {
    for (const note of skipped) await env.api('POST', `/api/tasks/${card}`, { note });
  } catch (e: any) {
    if (!(e instanceof BoardError) || e.status >= 500) { env.log(`${card}: PR ${pr} is open but a skipped step was not noted (${e.message}); will retry`); return false; }
    env.log(`${card}: the board refused a skipped-step note: ${e.message}`);
  }
  const left = skipped.length ? `Do the ${skipped.length} step(s) the runner skipped (the card's HUMAN-STEP notes and the PR body). ` : '';
  try {
    await env.api('POST', `/api/tasks/${card}/finish`, {
      status: 'review', pr, pr_summary: `Draft PR for ${card}: ${summary}`, result: `runner (${r.tool}): PR ${pr}`, note: reviewNote,
      summary: [`Runner build by ${tool}: ${summary}`, `Review: ${oneLine(reviewNote, 190)}`, `Draft PR: ${pr}`, ...(left ? [`Not done: ${skipped.length} skipped step(s) wait for you`] : [])].join('\n'),
      what: `A draft PR for this card is open: ${title}`,
      why: `The runner built the card with ${tool}; ${oneLine(reviewNote, 200)}`,
      do: blocked ? 'Read the open findings in the PR body, fix the spec or the design, then unblock the card' : `${left}Read the PR and its checks; merge it or ask for changes`,
      rec: blocked ? `Do not merge: the review is not clean after ${REVIEW_PASSES} passes and gets no third pass` : open.length ? 'Check the findings listed in the PR body before merging' : 'Merge when the checks are green and the diff looks right',
      after: `After the merge, mark the card done (dask done ${card} --pr <url>)`,
    });
  } catch (e: any) {
    if (!(e instanceof BoardError) || e.status >= 500) { env.log(`${card}: PR ${pr} is open but the board move failed (${e.message}); will retry`); return false; }
    env.log(`${card}: PR ${pr} is open but the board refused the move: ${e.message}`);
    history(env, card, r, 'error', `board: ${e.message}`, pr);
    return true;
  }
  if (blocked) {
    try { await blockAtLimit(env, card, r, pr, open); } catch (e: any) {
      if (!(e instanceof BoardError) || e.status >= 500) { env.log(`${card}: blocking at the review limit failed (${e.message}); will retry`); return false; }
      env.log(`${card}: the board refused the block at the review limit: ${e.message}`);
    }
  }
  try {
    await env.api('POST', `/api/tasks/${card}/release`, { run_id: r.run_id, note: `claim: #${r.job} closed (runner: review, ${pr}). The runner opened a draft PR and handed the card back for your review. Log: ${r.log}` });
  } catch (e: any) {
    if (!(e instanceof BoardError) || e.status >= 500) { env.log(`${card}: hand-back release failed (${e.message}); will retry`); return false; }
  }
  if (r.repo && r.dir) removeWorktree(r.repo, r.dir);
  env.log(`${card}: draft PR ${pr}; card moved to review`);
  history(env, card, r, 'review', summary, pr);
  return true;
}

/** The review passes stored for a card, oldest first; null when the board cannot say, so no pass may start. */
export async function storedPasses(env: Pick<FlowEnv, 'api' | 'log'>, card: string): Promise<any[] | null> {
  try { return (await env.api('GET', `/api/tasks/${card}/review-runs`))?.passes ?? []; }
  catch (e: any) {
    if (e instanceof BoardError && e.status === 404) return [];
    env.log(`${card}: review passes not read (${oneLine(e.message, 200)})`);
    return null;
  }
}

/** The cross-model review as a board review-run row for the head it read, sent as <reviewer>@<machine> so the board
 *  records the reviewer's family itself (docs/captain.md: the captain merges only a head with a clean row whose reviewer
 *  is not a builder and of another family). Best effort: a failure is logged and the run goes on. */
export async function recordReview(env: FlowEnv, card: string, r: RunRecord, pass: number, builder: Tool, reviewer: Tool, model: string, text: string, open: number, noted: number, clean: boolean): Promise<void> {
  try {
    const answer = text.length > 200_000 ? text.slice(-200_000) : text;
    await env.api('POST', `/api/tasks/${card}/review-runs`, {
      pass, head: git(r.dir, 'rev-parse', 'HEAD'), base: r.base, merge_base: git(r.dir, 'merge-base', r.base, 'HEAD'), tier: 'normal', mode: 'simple',
      reviewer: reviewer === 'claude' ? `claude ${model}`.trim() : 'codex', impl: builder, verdict: clean ? 'clean' : 'open', open: clean ? 0 : Math.max(open, 1), noted,
      at: new Date().toISOString(), log_sha256: createHash('sha256').update(Buffer.from(answer, 'utf8')).digest('hex'), answer,
    }, `${reviewer}@${env.machine}`);
  } catch (e: any) { env.log(`${card}: review not recorded on the board (${oneLine(e.message, 200)})`); }
}

/** One agent phase under the card's limits; the agent is tracked so a stop signal ends it. Past timeout_min the run is
 *  kept while its log or its worktree still changes (docs/runner.md "Limits"). */
async function phase(env: FlowEnv, card: string, r: RunRecord, cfg: RunnerConfig, tool: Tool, cmd: { cmd: string; args: string[] }, logFile: string) {
  const agent = supervise({
    cmd: cmd.cmd, args: cmd.args, cwd: r.dir, logFile, cardStart: Date.parse(r.since), limits: cfg, tickMs: env.tickMs, graceMs: env.graceMs,
    env: { ...process.env, ...env.agentEnv, DASK_TOOL: tool, DASK_SESSION: 'runner' },
    onStart: (pid) => env.update((s) => { if (s.running[card]) s.running[card].pid = pid; }),
    activity: () => worktreeStamp(r.dir), activityMs: env.activityMs,
    onKept: (idle) => env.log(`${card}: past ${cfg.timeout_min} min and still writing (last change ${Math.floor(idle)} min ago): kept until ${cfg.idle_min} min without a change or ${cfg.max_min} min in all`),
  });
  env.track(card, agent);
  const res = await agent.done;
  env.track(card, null);
  return { ...res, text: agentText(res.raw) };
}

interface ReviewResult { note: string; open: string[]; followUps: string[]; blocked: boolean; fixTexts: string[] }

/** A PR left by an earlier attempt: its follow-ups are brought up to date, and a card stopped at the review limit puts
 *  it back to draft. False when that draft step failed: the card must not be handed back as a draft. A failed edit of the
 *  follow-ups is only logged. */
function updateOpenPr(env: FlowEnv, card: string, dir: string, pr: string, rv: ReviewResult): boolean {
  const gh = (...args: string[]) => spawnSync('gh', args, { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  if (rv.blocked) {
    const undo = gh('pr', 'ready', pr, '--undo');
    if (undo.status !== 0) { env.log(`${card}: ${pr} not put back to draft: ${oneLine(undo.stderr || undo.stdout || String(undo.error), 200)}`); return false; }
  }
  if (!rv.followUps.length) return true;
  const body = gh('pr', 'view', pr, '--json', 'body', '-q', '.body');
  const edit = body.status === 0 ? gh('pr', 'edit', pr, '--body', withFollowUps(body.stdout, rv.followUps)) : body;
  if (edit.status !== 0) env.log(`${card}: follow-ups not added to ${pr}: ${oneLine(edit.stderr || edit.stdout || String(edit.error), 200)}`);
  return true;
}

/** The cross-model review: pass 1 on the whole change, one fix, pass 2 on the findings and the fixes. Passes already on
 *  the board count (an earlier attempt of the card). Not clean after the last pass: `blocked`, and no further review.
 *  Null when the run was settled here. */
async function reviewStage(env: FlowEnv, card: string, r: RunRecord, cfg: RunnerConfig, tool: Tool, session: string, logFile: string, save: (p: Partial<RunRecord>) => void): Promise<ReviewResult | null> {
  const reviewer: Tool = tool === 'claude' ? 'codex' : 'claude';
  const out: ReviewResult = { note: `no cross-model review (${reviewer} is not installed)`, open: [], followUps: [], blocked: false, fixTexts: [] };
  if (!env.which(reviewer)) return out;
  const stored = await storedPasses(env, card);
  if (!stored) { await settle(env, card, r, 'the board did not say which review passes are used, so no review ran', false); return null; }
  const reads = stored.map((p) => readCodeReview(String(p.answer ?? '')));
  const last = stored[stored.length - 1];
  let previous = reads.at(-1)?.blockers.map((f) => f.line) ?? [];
  let since = last ? String(last.head ?? '') : '';
  out.followUps = [...new Set(reads.flatMap((x) => x.followUps.map((f) => f.line)))];
  if (stored.length >= REVIEW_PASSES) {
    if (last.verdict === 'clean' && last.head === git(r.dir, 'rev-parse', 'HEAD')) return { ...out, note: `${TOOL_NAME[reviewer]} review: already clean at this head` };
    return { ...out, note: `no review of this head: its ${REVIEW_PASSES} passes are used`, open: previous.length ? previous : ['this head has no clean review'], blocked: true };
  }
  const notes: string[] = [];
  for (let pass = stored.length + 1; pass <= REVIEW_PASSES; pass++) {
    if (env.stopping()) return out;
    save({ phase: 'reviewing' });
    const prompt = pass === 1 ? reviewPrompt(card, r.base, tool) : recheckPrompt(card, r.base, tool, previous, since);
    const rlog = logFile.replace(/\.log$/, `.review-${pass}.log`);
    const run = await phase(env, card, r, cfg, reviewer, agentCommand(reviewer, 'review', { model: cfg.model, prompt, dir: r.dir, session: randomUUID() }), rlog);
    if (run.stopped) { await settle(env, card, r, env.stopping() ? 'the runner was stopped' : `timeout during the review: ${run.stopped}`, !env.stopping()); return null; }
    const read = readCodeReview(run.text);
    if (run.code !== 0 && !read.findings.length && !read.verdict) {
      out.note = [...notes, `the ${TOOL_NAME[reviewer]} review did not finish (pass ${pass}, exit ${run.code}; log ${rlog})`].join('; ');
      env.log(`${card}: ${out.note}`);
      if (pass < REVIEW_PASSES) return { ...out, open: previous };
      // The last pass gave no answer: it still counts, and the head has no clean review.
      await recordReview(env, card, r, pass, tool, reviewer, cfg.model, run.text, previous.length, 0, false);
      return { ...out, open: previous.length ? previous : [`review pass ${pass} gave no answer`], blocked: true };
    }
    const bad = read.blockers.map((f) => f.line);
    out.followUps = [...new Set([...out.followUps, ...read.followUps.map((f) => f.line)])];
    notes.push(`${TOOL_NAME[reviewer]} review pass ${pass}: ${bad.length} blocking, ${read.followUps.length} follow-up(s)`);
    out.note = notes.join('; ');
    env.log(`${card}: ${out.note}`);
    await recordReview(env, card, r, pass, tool, reviewer, cfg.model, run.text, bad.length, read.followUps.length, read.clean);
    if (read.clean) return { ...out, open: [] };
    const left = bad.length ? bad : ['the reviewer did not say clean and listed nothing that blocks'];
    if (pass === REVIEW_PASSES) return { ...out, open: left, blocked: true };
    if (!bad.length) return { ...out, open: left };   // nothing to fix, so a second pass would read the same head
    previous = bad;
    since = git(r.dir, 'rev-parse', 'HEAD');
    save({ phase: 'fixing' });
    const before = commitsAfter(r.repo, r.start_sha, r.branch);
    const fx = await phase(env, card, r, cfg, tool, agentCommand(tool, 'fix', { model: cfg.model, prompt: fixPrompt(card, r.branch, bad), dir: r.dir, session, resume: true }), logFile.replace(/\.log$/, '.fix.log'));
    if (fx.stopped) { await settle(env, card, r, env.stopping() ? 'the runner was stopped' : `timeout during the fix pass: ${fx.stopped}`, !env.stopping()); return null; }
    out.fixTexts.push(fx.text);
    notes.push(`fix by ${TOOL_NAME[tool]} (exit ${fx.code}, ${commitsAfter(r.repo, r.start_sha, r.branch) - before} new commit(s))`);
    out.open = bad;
  }
  return out;
}

export async function runCard(env: FlowEnv, p: Picked, cfg: RunnerConfig, title: string): Promise<void> {
  const { card, tool, repo } = p;
  const t0 = new Date();
  const job = `runner-${randomUUID()}`;
  fs.mkdirSync(env.runsDir, { recursive: true });
  const logFile = path.join(env.runsDir, `${card}-${stamp(t0)}.log`);
  const branch = `dasks/${card}`;
  const dir = path.join(env.worktreesDir, card);

  let claimed: any;
  try {
    // Claimed for runner@<machine> by <tool>@<machine>: the board's claim history then names the model that builds, which
    // is what a recorded review is checked against (docs/captain.md).
    claimed = await env.api('POST', `/api/tasks/${card}/claim`, { who: env.actor, exclusive_touches: true, note: `claim: #${job} open (runner, ${env.machine}, ${tool})` }, `${tool}@${env.machine}`);
  } catch (e: any) { env.log(`${card}: not claimed: ${e.message}`); return; }
  const r: RunRecord = {
    tool, run_id: String(claimed?.run_id ?? ''), attempt: Number(claimed?.attempt ?? 0), job, machine: env.machine,
    since: t0.toISOString(), deadline: new Date(t0.getTime() + cfg.max_min * 60000).toISOString(), log: logFile,
    touches: p.touches, repo, dir, branch, base: '', start_sha: '', pid: 0, phase: 'claimed',
  };
  // Saved before anything else can fail: a runner that dies from here on leaves a record to give the card back.
  env.update((s) => { s.running[card] = r; countStart(s, t0, 1); });
  env.log(`${card}: claimed as ${env.actor} (run ${r.run_id}, attempt ${r.attempt}); ${tool} builds in ${dir}; log ${logFile}`);
  const save = (patch: Partial<RunRecord>) => { Object.assign(r, patch); env.update((s) => { if (s.running[card]) Object.assign(s.running[card], patch); }); };

  let resume = '';
  try {
    gitOk(repo, 'fetch', '-q', 'origin');
    const base = defaultBase(repo);
    fs.mkdirSync(env.worktreesDir, { recursive: true });
    removeWorktree(repo, dir);
    // An earlier attempt's saved branch, here or on origin, is the start; docs/runner.md "Stopped builds keep their work".
    const start = await pickStart(repo, branch, base, card);
    if (start.aside) env.log(`${card}: an earlier local tip of ${branch} is not part of this run's start; kept at ${start.aside}`);
    if (start.from === 'local') git(repo, 'worktree', 'add', dir, branch);
    else git(repo, 'worktree', 'add', '-B', branch, dir, start.from === 'origin' ? originRef(branch) : base);
    if (start.from !== 'base') {
      resume = resumeLine(branch, start.from, start.sha, base);
      env.log(`${card}: continuing from ${start.from === 'origin' ? 'origin\'s' : 'the local'} ${branch} @ ${start.sha.slice(0, 7)}`);
    }
    save({ base, start_sha: git(dir, 'rev-parse', 'HEAD'), phase: 'worktree' });
  } catch (e: any) {
    fs.appendFileSync(logFile, `worktree: ${e.message}\n`);
    await settle(env, card, r, `could not set up the worktree: ${e.message}`, false); return;
  }

  const ds = spawnSync('python3', [path.join(env.kit, 'bin/dask'), 'start', card, '--no-copy', '--tool', tool], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env.agentEnv, DASK_SESSION: 'runner' } });
  if (ds.status !== 0) {
    const why = `dask start failed: ${oneLine(ds.stderr || String(ds.error), 300)}`;
    fs.appendFileSync(logFile, why + '\n');
    await settle(env, card, r, why, false); return;
  }
  const prompt = `${ds.stdout.trim()}\n\n${runnerRules(card, branch, r.base)}${resume ? `\n\n${resume}` : ''}`;
  const session = randomUUID();

  // build
  save({ phase: 'building' });
  const b = agentCommand(tool, 'build', { model: cfg.model, prompt, dir, session });
  fs.appendFileSync(logFile, `# ${card} build by ${tool} (${b.cmd} ${b.args.slice(0, -1).join(' ')} <prompt>) in ${dir}\n`);
  let build = await phase(env, card, r, cfg, tool, b, logFile);
  // A Claude build that exited 0 without a RESULT line ended its turn mid-work (often on a background wait): one
  // "continue" in the same session, same log and same card limits. Codex runs have no session to resume.
  if (tool === 'claude' && cfg.nudge && build.code === 0 && !build.stopped && !resultLine(build.text) && !RATE_LIMITED.test(build.raw) && !env.stopping()) {
    env.log(`${card}: claude exited without a RESULT line; one nudge to continue in session ${session}`);
    fs.appendFileSync(logFile, `\n# ${card}: nudge (continue in session ${session})\n`);
    build = await phase(env, card, r, cfg, tool, agentCommand(tool, 'build', { model: cfg.model, prompt: continuePrompt(card, branch), dir, session, resume: true }), logFile);
  }
  const result = resultLine(build.text);
  let humanSteps = humanStepsOf(build.text);
  const newCommits = commitsAfter(repo, r.start_sha, branch);
  env.log(`${card}: ${tool} ended (exit ${build.code}${build.stopped ? `, stopped: ${build.stopped}` : ''}); ${newCommits} new commit(s); ${result || 'no RESULT line'}`);

  if (env.stopping() && build.stopped) { await settle(env, card, r, 'the runner was stopped', false); return; }
  const verdict = attemptVerdict({ code: build.code, stopped: build.stopped, result, newCommits, raw: build.raw });
  if (!verdict.ok) {
    if (verdict.kind === 'rate-limited') {
      const until = new Date(Date.now() + cfg.backoff_min * 60000).toISOString();
      env.update((s) => { s.backoff[tool] = until; countStart(s, t0, -1); });
      await settle(env, card, r, `${tool} hit a usage or rate limit; the runner waits ${cfg.backoff_min} min (until ${until})`, false, 'rate-limited');
      return;
    }
    // A reported step is listed for the human even when the run built nothing.
    try { for (const s of humanSteps) await env.api('POST', `/api/tasks/${card}`, { note: humanStepLine(s) }); }
    catch (e: any) { env.log(`${card}: a human step was not noted: ${oneLine(e.message, 200)}`); }
    await settle(env, card, r, verdict.reason, true); return;
  }

  const rv = await reviewStage(env, card, r, cfg, tool, session, logFile, save);
  if (!rv) return;
  humanSteps = mergeHumanSteps([...humanSteps, ...rv.fixTexts.flatMap(humanStepsOf)]);
  if (env.stopping()) { await settle(env, card, r, 'the runner was stopped', false); return; }

  // secret scan, push, draft PR
  save({ phase: 'pushing' });
  const baseName = r.base.replace(/^origin\//, '');
  if (!pushableBranch(branch, r.base)) { await settle(env, card, r, 'refusing to push a default branch', false); return; }
  const gl = env.which('gitleaks');
  if (!gl) { await settle(env, card, r, 'gitleaks is not installed (brew install gitleaks); nothing was pushed', false); return; }
  const scan = spawnSync(gl, ['git', '--no-banner', '--redact', '--log-opts', `${r.base}..${branch}`, dir], { encoding: 'utf8', timeout: 180_000 });
  if (scan.status !== 0) { await settle(env, card, r, 'gitleaks flagged the new commits (or failed); nothing was pushed', true); return; }
  let pr = '';
  try {
    git(dir, 'push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
    const have = spawnSync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    pr = have.status === 0 ? have.stdout.trim() : '';
    if (pr) {
      if (!updateOpenPr(env, card, dir, pr, rv)) { await settle(env, card, r, `${pr} could not be put back to draft`, true); return; }
    } else {
      const body = prBody({ summary: result.replace(/^RESULT:\s*/, '') || `Built by ${TOOL_NAME[tool]} for ${card}.`, card, note: rv.note, open: rv.open, blocked: rv.blocked, followUps: rv.followUps, skipped: humanSteps.map((s) => `${s.step}${s.why ? `: ${s.why}` : ''}`), actor: env.actor });
      const c = spawnSync('gh', ['pr', 'create', '--draft', '--base', baseName, '--head', branch, '--title', `${card}: ${title}`.slice(0, 200), '--body', body], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
      if (c.status !== 0) throw new Error(`gh pr create: ${oneLine(c.stderr || c.stdout || String(c.error), 300)}`);
      pr = c.stdout.trim().split('\n').pop() ?? '';
    }
    if (!/^https:\/\/\S+$/.test(pr)) throw new Error(`gh gave no PR URL (${oneLine(pr, 100)})`);
  } catch (e: any) {
    fs.appendFileSync(logFile, `\n# ${e.message}\n`);
    await settle(env, card, r, `push or PR failed: ${e.message}`, false); return;
  }
  const summary = oneLine(result.replace(/^RESULT:\s*/, '') || `${commitsAfter(repo, r.base, branch)} commit(s) by ${TOOL_NAME[tool]}`, 300);
  await handBack(env, card, r, pr, title, summary, rv.note, rv.open, rv.blocked, humanSteps.map(humanStepLine));
}


// ---------- spec runs ----------

export interface SpecRunEnv extends FlowEnv {
  viewsDir: string;
  cacheDir: string;
  families: Record<string, string>;
}

/** One spec run of the runner (docs/specs.md): claim the card as the runner (not as a tool, so neither tool enters the
 *  claim history and the drafter may write its answer key), open a read-only view of the project's default branch, run
 *  the draft/review loop, then give the card back with what happened as its note. Nothing is pushed, no branch is made
 *  and the project's checkout is never written: the spec goes to the board and the note to the card. */
export async function runSpecCard(env: SpecRunEnv, p: SpecPicked, cfg: RunnerConfig, title: string): Promise<void> {
  const { card, drafter, reviewer } = p;
  const t0 = new Date();
  const job = `spec-${randomUUID()}`;
  fs.mkdirSync(env.runsDir, { recursive: true });
  const logFile = path.join(env.runsDir, `${card}-spec-${stamp(t0)}.log`);
  let claimed: any;
  try {
    claimed = await env.api('POST', `/api/tasks/${card}/claim`, { who: env.actor, note: `claim: #${job} open (runner spec, ${env.machine}, ${drafter} drafts${reviewer ? `, ${reviewer} reviews` : ''})` });
  } catch (e: any) { env.log(`${card}: not claimed for spec: ${e.message}`); return; }
  const r: RunRecord = {
    kind: 'spec', tool: drafter, run_id: String(claimed?.run_id ?? ''), attempt: Number(claimed?.attempt ?? 0), job, machine: env.machine,
    since: t0.toISOString(), deadline: new Date(t0.getTime() + cfg.max_min * 60000).toISOString(), log: logFile,
    touches: [], repo: '', dir: '', branch: '', base: '', start_sha: '', pid: 0, phase: 'speccing',
  };
  env.update((s) => { s.running[card] = r; countStart(s, t0, 1); });
  const save = (patch: Partial<RunRecord>) => { Object.assign(r, patch); env.update((s) => { if (s.running[card]) Object.assign(s.running[card], patch); }); };
  env.log(`${card}: claimed for spec as ${env.actor} (run ${r.run_id}); ${drafter} drafts${reviewer ? `, ${reviewer} reviews` : ', no reviewer here'}; log ${logFile}`);

  const src = repoSource(p.repo);
  let view;
  try {
    if (!src) throw new Error(`project ${p.goal} has no repo`);
    view = openRepoView(src, env.viewsDir, env.cacheDir, card, env.which('gh'));
    save({ repo: view.repo, dir: view.dir, base: view.base, start_sha: view.sha });
    fs.appendFileSync(logFile, `# ${card} spec run: read-only view of ${view.label} at ${view.base} (${view.sha}) in ${view.dir}${view.note ? `; ${view.note}` : ''}\n`);
  } catch (e: any) {
    fs.appendFileSync(logFile, `view: ${e.message}\n`);
    await settle(env, card, r, `spec run: could not read the project's code: ${e.message}`, false); return;
  }
  let body = '';
  try { body = (await env.api('GET', `/api/tasks/${card}?log=0`))?.body ?? ''; } catch { /* the card text stays empty */ }
  const hit: { tool: Tool | null } = { tool: null };
  const run = async (tool: Tool, prompt: string, label: string): Promise<AgentRun> => {
    const res = await phase(env, card, r, cfg, tool, agentCommand(tool, 'spec', { model: cfg.model, prompt, dir: view!.dir, session: randomUUID() }), logFile.replace(/\.log$/, `.${label}.log`));
    if (res.code !== 0 && RATE_LIMITED.test(res.raw)) hit.tool = tool;
    return res;
  };
  let out;
  try {
    out = await specLoop({
      card, title, goal: p.goal, lane: p.lane, cardText: body, view, drafter, author: `${drafter}@${env.machine}`,
      reviewer: reviewer ? { tool: reviewer, actor: `${reviewer}@${env.machine}` } : null,
      noReviewer: env.which(drafter === 'claude' ? 'codex' : 'claude') ? 'Claude and Codex are one model family in this board\'s config (families)' : `only ${SPEC_TOOL_NAME[drafter]} is installed on ${env.machine}; a Mac with the other harness (or a person) must review it`,
      families: env.families, run, api: env.api, log: env.log,
    });
  } catch (e: any) {
    await settle(env, card, r, `spec run failed: ${oneLine(e.message, 300)}`, false); return;
  }
  if (env.stopping()) { await settle(env, card, r, 'the runner was stopped', false); return; }
  if (hit.tool) {
    const until = new Date(Date.now() + cfg.backoff_min * 60000).toISOString();
    const tool: Tool = hit.tool;
    env.update((s) => { s.backoff[tool] = until; countStart(s, t0, -1); });
    env.log(`${card}: ${tool} hit a usage or rate limit during the spec run; it waits ${cfg.backoff_min} min (until ${until})`);
  }
  // Failure memory (by the card text's hash): a run that stored nothing and recorded no review counts; any progress clears.
  if (!out.progressed && !hit.tool) {
    const at = new Date().toISOString();
    env.update((s) => { const f = s.spec_failures ??= {}; const prev = f[card]; f[card] = { hash: p.hash ?? '', count: prev && prev.hash === (p.hash ?? '') ? prev.count + 1 : 1, at }; });
    out.note += ` Spec run failed on card text ${(p.hash ?? '').slice(0, 8)}; after ${SPEC_RETRIES} such runs it waits until the card changes.`;
  } else if (out.progressed) env.update((s) => { if (s.spec_failures) delete s.spec_failures[card]; });
  fs.appendFileSync(logFile, `# ${out.note}\n`);
  save({ phase: 'releasing', pending: { reason: out.note, count: false } });
  try {
    await env.api('POST', `/api/tasks/${card}/release`, { run_id: r.run_id, note: `claim: #${job} closed (runner spec). ${out.note} Log: ${logFile}` });
  } catch (e: any) {
    if (!(e instanceof BoardError) || e.status >= 500) { env.log(`${card}: spec release failed (${e.message}); will retry`); return; }
    env.log(`${card}: spec release refused: ${e.message}`);
  }
  closeRepoView(r.repo, r.dir);
  env.log(`${card}: ${out.note}`);
  history(env, card, r, out.state === 'ready' ? 'spec-ready' : 'spec-draft', out.note);
}
