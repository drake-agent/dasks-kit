// One card run of the runner, as one state flow: claim -> recovery record -> worktree -> build -> review -> fix -> scan,
// push, draft PR -> hand back. Every way out goes through settle(): the outcome (when the attempt counts) is recorded
// for this run before the claim is released, the release names the run so it cannot touch a later one, and the
// recovery record stays until the board has confirmed it. Nothing here assumes one machine: the board URL, the machine
// name and the token come from the caller (the stored connection).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  agentCommand, agentText, attemptVerdict, blocking, continuePrompt, countStart, fixPrompt, RATE_LIMITED, resultLine, reviewFindings, reviewPrompt, runnerRules,
  type HistoryRow, type Picked, type RunnerConfig, type RunnerState, type RunRecord, type Tool,
} from './runner.ts';
import { supervise, worktreeStamp, type Supervised } from './supervise.ts';
import { closeRepoView, openRepoView, repoSource, specLoop, TOOL_NAME as SPEC_TOOL_NAME, type AgentRun } from './spec-flow.ts';
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

/** Give the card back for one failed or stopped attempt. Order matters: the outcome of THIS run first (it counts toward
 *  the retry cap only when `count`), then a release that names the run. If the board cannot be reached, the record stays
 *  with `pending` and the next look or a restart tries again. Returns true when the board confirmed. */
export async function settle(env: FlowEnv, card: string, r: RunRecord, reason: string, count: boolean, outcome: HistoryRow['outcome'] = count ? 'released' : 'error'): Promise<boolean> {
  env.update((s) => { if (s.running[card]) Object.assign(s.running[card], { phase: 'releasing', pending: { reason, count } }); });
  if (count) {
    try {
      await env.api('POST', `/api/tasks/${card}/outcome`, { state: 'failed', note: oneLine(`runner: ${reason}`, 1000), evidence: [r.log], job: r.job, run_id: r.run_id, attempt: r.attempt });
    } catch (e: any) {
      if (!(e instanceof BoardError) || e.status >= 500) { env.log(`${card}: outcome not recorded yet (${e.message}); will retry`); return false; }
      env.log(`${card}: outcome refused: ${e.message}`);
    }
  }
  try {
    await env.api('POST', `/api/tasks/${card}/release`, { run_id: r.run_id, note: `claim: #${r.job} closed (runner: ${oneLine(reason, 200)}). The runner gave the card back: ${oneLine(reason, 400)}. Log: ${r.log}` });
  } catch (e: any) {
    if (e instanceof BoardError && e.status === 409 && e.body?.rule === 'run') env.log(`${card}: already on another run; nothing to release`);
    else if (e instanceof BoardError && e.status < 500) env.log(`${card}: release refused: ${e.message}`);
    else { env.log(`${card}: release failed (${e.message}); will retry`); return false; }
  }
  // Commits stay on the branch for the next attempt; only a branch with nothing beyond its base is deleted.
  if (r.kind === 'spec') { if (r.dir) closeRepoView(r.repo, r.dir); }
  else if (r.repo && r.dir) {
    removeWorktree(r.repo, r.dir);
    if (r.base && commitsAfter(r.repo, r.base, r.branch) === 0) gitOk(r.repo, 'branch', '-D', r.branch);
  }
  env.log(`${card}: released (${reason})${count ? '; attempt counted' : ''}`);
  history(env, card, r, outcome, reason);
  return true;
}

/** The hand-back after the draft PR is open: card to review with its context, claim closed, released. */
export async function handBack(env: FlowEnv, card: string, r: RunRecord, pr: string, title: string, summary: string, reviewNote: string, open: string[]): Promise<boolean> {
  env.update((s) => { if (s.running[card]) Object.assign(s.running[card], { phase: 'handing-back', handback: { pr, title, summary, review_note: reviewNote, open } }); });
  const tool = TOOL_NAME[r.tool];
  try {
    await env.api('POST', `/api/tasks/${card}/finish`, {
      status: 'review', pr, pr_summary: `Draft PR for ${card}: ${summary}`, result: `runner (${r.tool}): PR ${pr}`, note: reviewNote,
      summary: [`Runner build by ${tool}: ${summary}`, `Review: ${oneLine(reviewNote, 200)}`, `Draft PR: ${pr}`].join('\n'),
      what: `A draft PR for this card is open: ${title}`,
      why: `The runner built the card with ${tool}; ${oneLine(reviewNote, 200)}`,
      do: 'Read the PR and its checks; merge it or ask for changes',
      rec: open.length ? 'Check the P0/P1 findings listed in the PR body before merging' : 'Merge when the checks are green and the diff looks right',
      after: `After the merge, mark the card done (dask done ${card} --pr <url>)`,
    });
  } catch (e: any) {
    if (!(e instanceof BoardError) || e.status >= 500) { env.log(`${card}: PR ${pr} is open but the board move failed (${e.message}); will retry`); return false; }
    env.log(`${card}: PR ${pr} is open but the board refused the move: ${e.message}`);
    history(env, card, r, 'error', `board: ${e.message}`, pr);
    return true;
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

/** The cross-model review as a board review-run row for the head it read, sent as <reviewer>@<machine> so the board
 *  records the reviewer's family itself (docs/captain.md: the captain merges only a head with a clean row whose reviewer
 *  is not a builder and of another family). The next free pass 1-3; past 3 nothing is recorded. Best effort: a failure
 *  is logged and the run goes on. */
export async function recordReview(env: FlowEnv, card: string, r: RunRecord, builder: Tool, reviewer: Tool, model: string, text: string, open: number, noted: number, clean: boolean): Promise<void> {
  try {
    const passes: any[] = (await env.api('GET', `/api/tasks/${card}/review-runs`))?.passes ?? [];
    const used = new Set(passes.map((x) => x.pass));
    const pass = [1, 2, 3].find((n) => !used.has(n) && [1, 2, 3].filter((k) => k < n).every((k) => used.has(k)));
    if (!pass) { env.log(`${card}: review not recorded (passes 1-3 are used)`); return; }
    const answer = text.length > 200_000 ? text.slice(-200_000) : text;
    await env.api('POST', `/api/tasks/${card}/review-runs`, {
      pass, head: git(r.dir, 'rev-parse', 'HEAD'), base: r.base, merge_base: git(r.dir, 'merge-base', r.base, 'HEAD'), tier: 'normal', mode: pass === 3 ? 'narrow' : 'simple',
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

  try {
    gitOk(repo, 'fetch', '-q', 'origin');
    const base = defaultBase(repo);
    fs.mkdirSync(env.worktreesDir, { recursive: true });
    removeWorktree(repo, dir);
    if (gitOk(repo, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`)) git(repo, 'worktree', 'add', dir, branch);
    else git(repo, 'worktree', 'add', '-b', branch, dir, base);
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
  const prompt = `${ds.stdout.trim()}\n\n${runnerRules(card, branch, r.base)}`;
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
    await settle(env, card, r, verdict.reason, true); return;
  }

  // cross-model review, one fix pass for P0/P1
  const reviewer: Tool = tool === 'claude' ? 'codex' : 'claude';
  let reviewNote = `no cross-model review (${reviewer} is not installed)`;
  let open: string[] = [];
  if (env.which(reviewer)) {
    save({ phase: 'reviewing' });
    const rlog = logFile.replace(/\.log$/, '.review.log');
    const rv = await phase(env, card, r, cfg, reviewer, agentCommand(reviewer, 'review', { model: cfg.model, prompt: reviewPrompt(card, r.base, tool), dir, session: randomUUID() }), rlog);
    if (rv.stopped) { await settle(env, card, r, env.stopping() ? 'the runner was stopped' : `timeout during the review: ${rv.stopped}`, !env.stopping()); return; }
    const findings = reviewFindings(rv.text);
    const bad = blocking(findings);
    reviewNote = rv.code !== 0 && !findings.length && !/VERDICT:/.test(rv.text)
      ? `the ${TOOL_NAME[reviewer]} review did not finish (exit ${rv.code}; log ${rlog})`
      : `${TOOL_NAME[reviewer]} review: ${findings.length} finding(s), ${bad.length} P0/P1`;
    env.log(`${card}: ${reviewNote}`);
    const finished = rv.code === 0 || findings.length > 0 || /VERDICT:/.test(rv.text);
    if (finished) await recordReview(env, card, r, tool, reviewer, cfg.model, rv.text, bad.length, findings.length - bad.length, !bad.length && /VERDICT:\s*clean\b/.test(rv.text));
    if (bad.length) {
      save({ phase: 'fixing' });
      const before = commitsAfter(repo, r.start_sha, branch);
      const fx = await phase(env, card, r, cfg, tool, agentCommand(tool, 'fix', { model: cfg.model, prompt: fixPrompt(card, branch, bad.map((x) => x.line)), dir, session, resume: true }), logFile.replace(/\.log$/, '.fix.log'));
      if (fx.stopped) { await settle(env, card, r, env.stopping() ? 'the runner was stopped' : `timeout during the fix pass: ${fx.stopped}`, !env.stopping()); return; }
      const added = commitsAfter(repo, r.start_sha, branch) - before;
      reviewNote += `; one fix pass by ${TOOL_NAME[tool]} (exit ${fx.code}, ${added} new commit(s), not re-reviewed)`;
      open = bad.map((x) => x.line);
    }
  }
  if (env.stopping()) { await settle(env, card, r, 'the runner was stopped', false); return; }

  // secret scan, push, draft PR
  save({ phase: 'pushing' });
  const baseName = r.base.replace(/^origin\//, '');
  if (branch === baseName || !branch.startsWith('dasks/')) { await settle(env, card, r, 'refusing to push a default branch', false); return; }
  const gl = env.which('gitleaks');
  if (!gl) { await settle(env, card, r, 'gitleaks is not installed (brew install gitleaks); nothing was pushed', false); return; }
  const scan = spawnSync(gl, ['git', '--no-banner', '--redact', '--log-opts', `${r.base}..${branch}`, dir], { encoding: 'utf8', timeout: 180_000 });
  if (scan.status !== 0) { await settle(env, card, r, 'gitleaks flagged the new commits (or failed); nothing was pushed', true); return; }
  let pr = '';
  try {
    git(dir, 'push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
    const have = spawnSync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    pr = have.status === 0 ? have.stdout.trim() : '';
    if (!pr) {
      const body = [result.replace(/^RESULT:\s*/, '') || `Built by ${TOOL_NAME[tool]} for ${card}.`, '', `Card: ${card} (Dasks)`, `Review: ${reviewNote}.`,
        ...(open.length ? ['P0/P1 findings the fix pass was asked to address:', ...open.map((l) => '  ' + l)] : []), '',
        `Opened by the Dasks runner (${env.actor}) as a draft. Merging is the user's call.`].join('\n');
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
  await handBack(env, card, r, pr, title, summary, reviewNote, open);
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
