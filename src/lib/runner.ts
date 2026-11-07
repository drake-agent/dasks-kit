// Card runner, the pure parts: settings, which cards to start, how to read an agent's output, prompts and the state
// file's shape. The run itself is src/lib/run-flow.ts; the loop is src/cli/runner.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseTouches, touchesOverlap, touchesValue } from './touches.ts';
import { toolIdentity } from './spec-state.ts';

export type Tool = 'claude' | 'codex';

/** `runner` in config.json. Off unless install.sh --with-runner (or the user) turns it on. */
export interface RunnerConfig {
  enabled: boolean;
  /** Cards built at the same time. */
  max_parallel: number;
  /** Cards started per local day (rate-limited starts do not count). */
  daily_cap: number;
  /** Minutes between looks in the loop mode. */
  poll_minutes: number;
  /** Claude model for builds, fixes and Claude reviews; '' = the claude CLI's own default. */
  model: string;
  /** Card time limits, minutes: before timeout_min a run is never stopped; past it, a run still writing (new log output
   *  or a change in its worktree) is kept and one quiet for idle_min is stopped (0 = stop at timeout_min); every run
   *  stops at max_min. */
  timeout_min: number;
  idle_min: number;
  max_min: number;
  /** Minutes to wait after a usage / rate-limit failure before that tool builds again. */
  backoff_min: number;
  /** One "continue" to a Claude build that exited 0 without a RESULT line (it ended its turn mid-work), in the same
   *  session. Codex builds get none: `codex exec` runs here have no session to resume. */
  nudge: boolean;
  /** PR-first: a repo with more open PRs than this (every open PR, counted with gh) gets no new cards until some merge
   *  or close. 0 = no limit. */
  pr_limit: number;
  /** The spec pass (docs/specs.md): when no ready card starts, free slots draft and review specs of cards without a
   *  ready spec. Only while the runner is enabled. */
  spec: boolean;
  /** This runner's name on the board (runner@<machine>); default: the machine name of the stored connection. */
  machine?: string;
  /** Between cards, fast-forward the kit checkout to its remote's default branch and restart (src/lib/self-update.ts).
   *  Unset = on for a Mac that joined a fleet (settings in ~/.dasks/runner.json), off on the board's own Mac. */
  update?: boolean;
}

export const RUNNER_DEFAULTS: RunnerConfig = {
  enabled: false, max_parallel: 1, daily_cap: 10, poll_minutes: 10, model: '',
  timeout_min: 180, idle_min: 150, max_min: 720, backoff_min: 60, nudge: true, pr_limit: 10, spec: true,
};

/** The runner settings from a parsed config.json (missing keys take the defaults); throws one message per bad value. */
export function runnerConfig(doc: unknown): RunnerConfig {
  const raw = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>).runner : undefined;
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('config: runner must be an object');
  const c = { ...RUNNER_DEFAULTS, ...(raw as Partial<RunnerConfig> | undefined ?? {}) };
  const errs: string[] = [];
  const int = (k: keyof RunnerConfig, min: number) => { if (!Number.isSafeInteger(c[k]) || (c[k] as number) < min) errs.push(`runner.${k} must be a whole number >= ${min}`); };
  const num = (k: keyof RunnerConfig, min: number, strict: boolean) => { const v = c[k] as number; if (typeof v !== 'number' || !Number.isFinite(v) || (strict ? v <= min : v < min)) errs.push(`runner.${k} must be a number ${strict ? '>' : '>='} ${min}`); };
  if (typeof c.enabled !== 'boolean') errs.push('runner.enabled must be true or false');
  if (typeof c.nudge !== 'boolean') errs.push('runner.nudge must be true or false');
  if (typeof c.spec !== 'boolean') errs.push('runner.spec must be true or false');
  if (c.update !== undefined && typeof c.update !== 'boolean') errs.push('runner.update must be true or false');
  int('max_parallel', 1); int('daily_cap', 1); int('pr_limit', 0);
  num('poll_minutes', 0, true); num('timeout_min', 0, true); num('idle_min', 0, false); num('max_min', 0, true); num('backoff_min', 0, false);
  if (typeof c.model !== 'string' || !/^[A-Za-z0-9._:\[\]-]{0,80}$/.test(c.model)) errs.push('runner.model must be a model name, or empty for the CLI default');
  if (c.machine !== undefined && (typeof c.machine !== 'string' || !/^[a-z0-9-]{1,16}$/.test(c.machine))) errs.push('runner.machine must be 1-16 lowercase letters, digits or -');
  if (errs.length) throw new Error('config: ' + errs.join('; '));
  return { ...c, max_min: Math.max(c.timeout_min, c.max_min) };
}

/** The local repo path each project's cards build in (`projects[].repo`, `~/` expanded); projects without one are absent. */
export function projectRepos(doc: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = doc && typeof doc === 'object' ? (doc as { projects?: unknown }).projects : undefined;
  if (!Array.isArray(list)) return out;
  for (const p of list) {
    if (p && typeof p === 'object' && typeof p.id === 'string' && typeof p.repo === 'string' && p.repo.trim())
      out.set(p.id, p.repo.startsWith('~/') ? path.join(os.homedir(), p.repo.slice(2)) : p.repo.trim());
  }
  return out;
}

// ---------- picking ----------

/** Paths of a card's `touches:` line (spec text, else board body); [] overlaps nothing. */
export function cardTouches(text: string): string[] { return parseTouches(touchesValue(text)); }


export interface Candidate {
  id: string; goal: string; lane: string; priority: string; spec_state?: string; touches: string[];
  /** the current spec version's writer */
  spec_by?: string | null;
  /** the authors of the current Acceptance tests and Oracle sections: the answer key, what the board checks */
  answer_key_by?: string[];
  /** the card's kind (bug fixes start first) and whether the user pushed it */
  kind?: string; pushed?: boolean;
}
export interface Running { card: string; tool: Tool; repo: string; touches: string[] }
export interface PickInput {
  ready: Candidate[];
  running: Running[];
  cfg: Pick<RunnerConfig, 'max_parallel' | 'daily_cap'>;
  startedToday: number;
  /** Tools on PATH. */
  tools: Set<Tool>;
  /** Tool -> ISO time its backoff ends (absent = none). */
  backoff: Partial<Record<Tool, string>>;
  repos: Map<string, string>;
  now: Date;
  /** Repos that get no new cards now, with the reason (prHolds). */
  held?: Map<string, string>;
  /** This runner's machine: a card whose current spec was written by <tool>@<machine> is not built by that tool. */
  machine?: string;
}
export interface Picked { card: string; tool: Tool; repo: string; touches: string[] }

const PRIO = (p: string) => { const m = /^p(\d)$/.exec(p); return m ? Number(m[1]) : 9; };

/** The cards to start now, and why the others wait. Order: the user's pushes, then bug fixes (kind bug), then priority;
 *  the board's ready order within each. Ready means what `dask ready` shows: open, unclaimed, deps done, spec ready
 *  (the caller passes that list). */
export function pickCards(x: PickInput): { picked: Picked[]; skipped: { card: string; why: string }[] } {
  const picked: Picked[] = [], skipped: { card: string; why: string }[] = [];
  const busy = new Set(x.running.map((r) => r.card));
  // Touches only conflict inside one repo: `src/` in two projects' checkouts is two different folders.
  const holding = x.running.map((r) => ({ repo: r.repo, touches: r.touches }));
  let slots = Math.min(x.cfg.max_parallel - x.running.length, x.cfg.daily_cap - x.startedToday - x.running.length);
  const first = (c: Candidate) => (c.pushed ? 0 : c.kind === 'bug' ? 1 : 2);
  const order = x.ready.map((c, i) => ({ c, i })).sort((a, b) => first(a.c) - first(b.c) || PRIO(a.c.priority) - PRIO(b.c.priority) || a.i - b.i).map((o) => o.c);
  for (const c of order) {
    if (busy.has(c.id)) continue;
    if (c.spec_state !== undefined && c.spec_state !== 'ready') { skipped.push({ card: c.id, why: `spec is ${c.spec_state || 'none'}, not ready` }); continue; }
    const tool = c.lane === 'claude' || c.lane === 'codex' ? c.lane : null;
    if (!tool) { skipped.push({ card: c.id, why: `lane ${c.lane || 'none'} is not claude or codex` }); continue; }
    if (!x.tools.has(tool)) { skipped.push({ card: c.id, why: `${tool} is not installed` }); continue; }
    // The answer key's authors, as the board checks them; the version's writer only when no section has an author.
    const authors = c.answer_key_by?.length ? c.answer_key_by : c.spec_by ? [c.spec_by] : [];
    if (x.machine && authors.some((a) => toolIdentity(a) === `${tool}@${x.machine}`)) { skipped.push({ card: c.id, why: `${tool} wrote its spec's answer key, and the spec author cannot build it` }); continue; }
    const until = x.backoff[tool];
    if (until && Date.parse(until) > x.now.getTime()) { skipped.push({ card: c.id, why: `${tool} backs off until ${until}` }); continue; }
    const repo = x.repos.get(c.goal);
    if (!repo) { skipped.push({ card: c.id, why: `project ${c.goal} has no repo in config.json (projects[].repo)` }); continue; }
    const held = x.held?.get(repo);
    if (held) { skipped.push({ card: c.id, why: held }); continue; }
    if (holding.some((h) => h.repo === repo && touchesOverlap(h.touches, c.touches))) { skipped.push({ card: c.id, why: 'touches overlap a card being built' }); continue; }
    if (slots <= 0) { skipped.push({ card: c.id, why: x.startedToday + x.running.length >= x.cfg.daily_cap ? `daily cap ${x.cfg.daily_cap} reached` : `all ${x.cfg.max_parallel} slots busy` }); continue; }
    picked.push({ card: c.id, tool, repo, touches: c.touches });
    holding.push({ repo, touches: c.touches });
    slots--;
  }
  return { picked, skipped };
}

// ---------- the spec pass ----------

/** Failed spec runs (nothing stored and nothing reviewed) on one card text before the runner stops trying it. */
export const SPEC_RETRIES = 2;

export interface SpecCandidate {
  id: string; goal: string; lane: string; priority: string; spec_state: string;
  /** a draft whose current version has a review already */
  reviewed?: boolean;
  /** the model family that wrote the current draft's answer key (its Acceptance tests, else the version's writer) */
  authorFamily?: string | null;
  /** failed spec runs on this card's current text (runner state, by content hash) */
  failures?: number;
  /** the card's content hash (src/lib/spec-flow.ts cardHash) */
  hash?: string;
}
export interface SpecPickInput {
  cands: SpecCandidate[];
  running: { card: string }[];
  cfg: Pick<RunnerConfig, 'max_parallel' | 'daily_cap'>;
  startedToday: number;
  tools: Set<Tool>;
  backoff: Partial<Record<Tool, string>>;
  /** Projects whose code can be read (projects[].repo: a checkout or a GitHub owner/name). */
  repos: Map<string, string>;
  now: Date;
  held?: Map<string, string>;
  /** Each tool's model family on this board (config families can map both to one). */
  toolFamily: Record<Tool, string | null>;
}
export interface SpecPicked { card: string; goal: string; lane: Tool; repo: string; drafter: Tool; reviewer: Tool | null; mode: 'none' | 'draft'; hash?: string }

/** Cards whose spec the runner writes now: open cards (the board's full ready queue: unclaimed, deps done, not blocked
 *  for Spec) with no spec, or a draft nobody has reviewed yet.
 *  - No spec: the drafter is the tool that will not build the card (its lane's other tool) when installed, so the
 *    builder never wrote its answer key; the reviewer is the other tool when it is another family.
 *  - A draft: the reviewer is the tool whose family did not write it (whoever wrote it, whatever the lane); the other
 *    tool revises. No such reviewer here: left for a Mac that has one.
 *  A card whose last SPEC_RETRIES runs on the same text failed waits until the card changes; cards with fewer failures
 *  go first. */
export function pickSpecCards(x: SpecPickInput): { picked: SpecPicked[]; skipped: { card: string; why: string }[] } {
  const picked: SpecPicked[] = [], skipped: { card: string; why: string }[] = [];
  const busy = new Set(x.running.map((r) => r.card));
  let slots = Math.min(x.cfg.max_parallel - x.running.length, x.cfg.daily_cap - x.startedToday - x.running.length);
  const order = x.cands.map((c, i) => ({ c, i })).sort((a, b) => (a.c.failures ?? 0) - (b.c.failures ?? 0) || PRIO(a.c.priority) - PRIO(b.c.priority) || a.i - b.i).map((o) => o.c);
  const free = (t: Tool) => x.tools.has(t) && !(x.backoff[t] && Date.parse(x.backoff[t]!) > x.now.getTime());
  const twoFamilies = !!x.toolFamily.claude && !!x.toolFamily.codex && x.toolFamily.claude !== x.toolFamily.codex;
  for (const c of order) {
    if (busy.has(c.id) || (c.spec_state !== 'none' && c.spec_state !== 'draft')) continue;
    if (c.lane !== 'claude' && c.lane !== 'codex') continue;
    if (c.spec_state === 'draft' && c.reviewed) continue;   // reviewed and not passed: waits for a new version
    const lane = c.lane as Tool;
    const repo = x.repos.get(c.goal);
    if (!repo) continue;
    const held = x.held?.get(repo);
    if (held) { skipped.push({ card: c.id, why: `spec: ${held}` }); continue; }
    if ((c.failures ?? 0) >= SPEC_RETRIES) { skipped.push({ card: c.id, why: `spec: ${c.failures} spec runs on this card text failed; it waits until the card changes` }); continue; }
    let drafter: Tool | null, reviewer: Tool | null;
    if (c.spec_state === 'draft') {
      reviewer = (['claude', 'codex'] as Tool[]).find((t) => free(t) && free(otherOf(t)) && twoFamilies && x.toolFamily[t] !== c.authorFamily) ?? null;
      if (!reviewer) { skipped.push({ card: c.id, why: `spec: the draft was written by the ${c.authorFamily ?? 'unknown'} family; no reviewer of another family (with the other tool to revise) is free here` }); continue; }
      drafter = otherOf(reviewer);
    } else {
      drafter = free(otherOf(lane)) ? otherOf(lane) : free(lane) ? lane : null;
      if (!drafter) { skipped.push({ card: c.id, why: 'spec: no harness free to draft (not installed or backing off)' }); continue; }
      reviewer = twoFamilies && free(otherOf(drafter)) ? otherOf(drafter) : null;
    }
    if (slots <= 0) { skipped.push({ card: c.id, why: x.startedToday + x.running.length >= x.cfg.daily_cap ? `daily cap ${x.cfg.daily_cap} reached` : `all ${x.cfg.max_parallel} slots busy` }); continue; }
    picked.push({ card: c.id, goal: c.goal, lane, repo, drafter, reviewer, mode: c.spec_state as 'none' | 'draft', ...(c.hash ? { hash: c.hash } : {}) });
    slots--;
  }
  return { picked, skipped };
}
const otherOf = (t: Tool): Tool => (t === 'claude' ? 'codex' : 'claude');

// ---------- PR-first ----------

/** The runner opens draft PRs and never merges, so they pile up. Open PRs in a repo, or why they could not be counted. */
export type PrCount = { ok: true; open: number } | { ok: false; why: string };

/** Seconds one `gh pr list` may take before the count is given up (fails open). */
export const PR_COUNT_TIMEOUT_MS = 20_000;
/** Repos counted at the same time. */
export const PR_COUNT_PARALLEL = 4;

/** Every open PR of the repo checked out at `repo`, via `gh pr list` (its own GitHub remote). Async, so the runner's
 *  kill timers and heartbeats keep running while gh is slow; given up after timeoutMs. Never throws. */
export function countOpenPrs(repo: string, gh: string | null, timeoutMs = PR_COUNT_TIMEOUT_MS): Promise<PrCount> {
  if (!gh) return Promise.resolve({ ok: false, why: 'gh is not installed' });
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const end = (r: PrCount) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child: ReturnType<typeof spawn>;
    // Its own process group, so a timeout ends gh and anything it started, and the answer does not wait for them.
    try { child = spawn(gh, ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number', '--jq', 'length'], { cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e: any) { return resolve({ ok: false, why: `gh pr list failed (${e.message})` }); }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      end({ ok: false, why: `gh pr list timed out after ${Math.round(timeoutMs / 100) / 10} s` });
    }, timeoutMs);
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { err += d; });
    child.on('error', (e) => end({ ok: false, why: `gh pr list failed (${e.message})` }));
    child.on('close', (code) => {
      const n = out.trim();
      if (code !== 0 || !/^\d+$/.test(n)) end({ ok: false, why: `gh pr list failed (${(err || n || `exit ${code}`).replace(/\s+/g, ' ').trim().slice(0, 200)})` });
      else end({ ok: true, open: Number(n) });
    });
  });
}

/** Open PRs of each repo, at most `parallel` gh calls at a time. */
export async function countAllOpenPrs(repos: string[], gh: string | null, o: { parallel?: number; timeoutMs?: number } = {}): Promise<Map<string, PrCount>> {
  const out = new Map<string, PrCount>();
  const queue = [...repos];
  const worker = async () => { for (let r = queue.shift(); r !== undefined; r = queue.shift()) out.set(r, await countOpenPrs(r, gh, o.timeoutMs)); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel ?? PR_COUNT_PARALLEL, queue.length)) }, worker));
  return new Map(repos.filter((r) => out.has(r)).map((r) => [r, out.get(r)!]));
}

/** Repos over the PR limit, with the line the runner logs for each card it holds. A count that failed holds nothing
 *  (fails open): the limit is a brake, not a gate. limit 0 = off. */
export function prHolds(counts: Map<string, PrCount>, limit: number): Map<string, string> {
  const out = new Map<string, string>();
  if (limit <= 0) return out;
  for (const [repo, c] of counts) if (c.ok && c.open > limit) out.set(repo, `PR-first: ${c.open} open PRs in ${repo}, over runner.pr_limit ${limit}; no new cards until some merge or close`);
  return out;
}

// ---------- run output ----------

/** Usage or rate-limit text from Claude Code or Codex: the run failed for the account, not for the work. */
export const RATE_LIMITED = /rate[ _-]?limit|usage limit|hit your (?:weekly |session |5-hour |daily )?limit|limit reached|out of (?:extra )?usage|too many requests|\b429\b|quota exceeded|insufficient_quota/i;

/** What the agent said: the `result` text of `--output-format stream-json` lines, else the raw output. */
export function agentText(log: string): string {
  const results: string[] = [];
  for (const line of log.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { const j = JSON.parse(line); if (j && j.type === 'result' && typeof j.result === 'string') results.push(j.result); } catch { /* not JSON */ }
  }
  return results.length ? results.join('\n') : log;
}

/** The last `RESULT:` line of a run ('' when there is none). */
export function resultLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('RESULT:'));
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

/** Spec review findings by severity: lines like `- [P1] section ...`, `P0: ...` or `**P1** ...`. Code reviews are read
 *  by readCodeReview. */
export function reviewFindings(text: string): { severity: string; line: string }[] {
  const out: { severity: string; line: string }[] = [];
  for (const l of text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?(?:\*\*)?\[?(P[0-3])\]?(?:\*\*)?\s*[:\-–]?\s+\S/.exec(l);
    if (m) out.push({ severity: m[1], line: l.trim().slice(0, 400) });
  }
  return out;
}
export const blocking = <F extends { severity: string }>(f: F[]): F[] => f.filter((x) => x.severity === 'P0' || x.severity === 'P1');

/** Tags that block a code review finding with or without a repro. */
const ALWAYS_BLOCK = new Set(['security', 'data-loss', 'approval', 'money']);
const FINDING_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:R\d+\s+)?\[?(P[0-3])\]?(?:\*\*)?(?:\s*\[([A-Za-z -]+)\])?\s*[:\-–]?\s+\S/;
const REPRO_RE = /^\s*(?:[-*]\s*)?repro:\s*\S.*?\s(?:->|→)\s+\S/i;

export interface CodeFinding { severity: string; tag: string; line: string; blocks: boolean }
export interface CodeReview { findings: CodeFinding[]; blockers: CodeFinding[]; followUps: CodeFinding[]; verdict: string; clean: boolean }

/** One code review answer. A finding blocks when a `repro:` line right under it gives a command or input and the wrong
 *  result, or when it is tagged security, data-loss, approval or money. The P level only orders the list. Clean needs
 *  the reviewer's own `VERDICT: clean` and nothing blocking; the last verdict line counts. */
export function readCodeReview(text: string): CodeReview {
  const lines = text.split('\n');
  const findings: CodeFinding[] = [];
  lines.forEach((l, i) => {
    const m = FINDING_RE.exec(l);
    if (!m) return;
    const tag = (m[2] ?? '').trim().toLowerCase().replace(/ /g, '-').replace(/^approval-gate$/, 'approval');
    const repro = REPRO_RE.test(lines[i + 1] ?? '') ? lines[i + 1].trim().replace(/^[-*]\s*/, '').slice(0, 400) : '';
    findings.push({ severity: m[1], tag, line: l.trim().slice(0, 400) + (repro ? `\n  ${repro}` : ''), blocks: !!repro || ALWAYS_BLOCK.has(tag) });
  });
  const verdict = [...text.matchAll(/VERDICT:\s*(clean|changes)\b/g)].at(-1)?.[1] ?? '';
  const blockers = findings.filter((f) => f.blocks);
  return { findings, blockers, followUps: findings.filter((f) => !f.blocks), verdict, clean: !blockers.length && verdict === 'clean' };
}

/** The `## Follow-ups` section of a PR body, one list item per finding. */
export function followUpSection(lines: string[]): string {
  return ['## Follow-ups', '', ...lines.map((l) => `- ${l.replace(/^[-*]\s+/, '').replace(/\n\s*/g, ' ')}`)].join('\n');
}

/** A PR body with its `## Follow-ups` section replaced, or added at the end. */
export function withFollowUps(body: string, lines: string[]): string {
  const section = followUpSection(lines);
  const at = body.search(/^## Follow-ups[ \t]*$/m);
  if (at < 0) return `${body.trimEnd()}\n\n${section}\n`;
  const rest = body.slice(at + 1);
  const next = rest.search(/^## /m);
  return `${body.slice(0, at)}${section}\n${next < 0 ? '' : `\n${rest.slice(next)}`}`;
}

/** A runner PR's body: open findings first when any are left, follow-ups in their own section. */
export function prBody(o: { summary: string; card: string; note: string; open: string[]; blocked: boolean; followUps: string[]; actor: string }): string {
  const open = o.open.length ? [o.blocked ? 'Not clean after the last review pass; this PR stays a draft. Open findings:' : 'Findings still to check:', ...o.open.map((l) => '  ' + l), ''] : [];
  return [...open, o.summary, '', `Card: ${o.card} (Dasks)`, `Review: ${o.note}.`, '',
    ...(o.followUps.length ? [followUpSection(o.followUps), ''] : []),
    `Opened by the Dasks runner (${o.actor}) as a draft. Merging is the user's call.`].join('\n');
}

// ---------- prompts ----------

/** In `claude -p` the turn is the process: ending the turn on a background wait kills the work half done. */
export const HEADLESS_WAIT_RULE = 'Headless run: this is an unattended `claude -p` / `codex exec` process, so ending your turn ends the process and kills everything you started. Never end a turn while background work (a run_in_background command, a background agent, a Monitor) is running or while you wait on one. Wait in the foreground instead: a bounded loop with a timeout that fits one tool call (under 10 min, e.g. `for i in $(seq 1 18); do test -s <file> && break; sleep 30; done`), repeated as needed. Always finish with the RESULT line, also when you give up.';

/** Every helper a run starts gets this word for word: prompts are the only control the runner has over helpers. */
export function helperRule(card: string): string {
  return `Helpers stay read-only on the board: any helper process you start for card ${card} (codex exec, claude -p, a subagent) never runs the \`dask\` subcommands begin, claim, release, block, submit or merge, nor the board API calls behind them, and never records a spec review of a spec it wrote itself; a reviewer helper only records its own review. Copy this rule word for word into every helper's prompt.`;
}

/** The runner's part of a build prompt, after the `dask start` text. */
export function runnerRules(card: string, branch: string, base: string): string {
  return [
    '----- runner rules (these override the claim and submit steps above) -----',
    `The card runner on this Mac already claimed ${card} and checked out branch ${branch} (from ${base}) in this worktree, your working directory.`,
    `Do not run \`dask begin\`, \`dask claim\`, \`dask submit\`, \`dask release\` or \`dask block\`, do not push, do not open a PR and never merge: the runner gets a cross-model review, pushes the branch and opens a draft PR after you stop.`,
    `Do the card's work here and commit it on ${branch}; every commit message starts with "${card}: ". Commit often: if this run is stopped, the runner tries to save uncommitted changes as a WIP commit, but that can fail.`,
    'If the card cannot be done as written (a missing decision, a wrong spec), make no commits and say why in the RESULT line.',
    HEADLESS_WAIT_RULE,
    helperRule(card),
    'End your final message with exactly one line: `RESULT: built <one-line summary>` or `RESULT: stopped <why>`.',
  ].join('\n');
}

/** How a code reviewer writes findings, for both passes. Examples stay inside sentences: the reader only takes whole lines. */
const FINDING_RULES = [
  'Write each finding on its own line, in this order: an id that runs on across passes (R1, R2, ...), a priority ([P0] to [P3]; it only orders the list and never blocks), a block tag if one applies, `<file>:<line>`, what is wrong, then `Expected: <the right result>`.',
  'Block tags: [repro] when you can show it, with the very next line reading `repro: <exact command, input or failing test> -> <the wrong result it shows>`. [security], [data-loss], [approval] (a human approval gate is skipped) and [money] block with or without a repro.',
  'Any other finding gets no tag: it is a follow-up, listed in the PR and not blocking. No style nits.',
].join('\n');
const VERDICT_RULE = 'End with exactly one line: `VERDICT: clean` (nothing blocks; follow-ups may remain) or `VERDICT: changes` (a finding blocks).';

/** Pass 1: the whole change. */
export function reviewPrompt(card: string, base: string, builder: Tool): string {
  return [
    `Review the commits of Dasks card ${card} on the current branch (\`git log ${base}..HEAD\`, \`git diff ${base}...HEAD\`). ${builder === 'claude' ? 'Claude' : 'Codex'} wrote them; you are the cross-model reviewer. Pass 1 of 2: review the whole change.`,
    'Read-only: do not edit files, commit, push or touch the board. Look for bugs, regressions, missing tests and anything the card asked for that is not done.',
    FINDING_RULES,
    helperRule(card),
    VERDICT_RULE,
  ].join('\n');
}

/** Pass 2: only the pass-1 findings and what the fixes broke. They are quoted with `> ` so an echoed prompt reads as no finding. */
export function recheckPrompt(card: string, base: string, builder: Tool, previous: string[], since: string): string {
  return [
    `Re-check the commits of Dasks card ${card} on the current branch (\`git diff ${since ? `${since}..HEAD` : `${base}...HEAD`}\` shows the fixes). ${builder === 'claude' ? 'Claude' : 'Codex'} wrote them; you are the cross-model reviewer. Pass 2 of 2, the last one: check only the findings below and regressions the fixes caused. Raise nothing else.`,
    'Read-only: do not edit files, commit, push or touch the board.',
    ...(previous.length ? ['Pass 1 findings:', ...previous.flatMap((f) => f.split('\n').map((l) => `> ${l.trim()}`))] : []),
    'Answer each one on its own line: `<id> resolved`, or repeat its finding line, with its tag and a new `repro:` line, as it shows on this head.',
    FINDING_RULES,
    helperRule(card),
    VERDICT_RULE,
  ].join('\n');
}

export function fixPrompt(card: string, branch: string, findings: string[]): string {
  return [
    `The cross-model review of ${card} found these blocking problems. Fix them on ${branch} with the smallest change and commit (messages start with "${card}: "). Do not push, open a PR or touch the board.`,
    ...findings.map((f) => '  ' + f),
    'If a finding is wrong, leave the code and say why in your final message.',
    HEADLESS_WAIT_RULE,
    helperRule(card),
    'End with exactly one line: `RESULT: fixed <summary>` or `RESULT: stopped <why>`.',
  ].join('\n');
}

/** The one nudge to a build that stopped without a RESULT line, sent into the same Claude session. */
export function continuePrompt(card: string, branch: string): string {
  return [
    `Your run for ${card} ended without a RESULT line, so the runner cannot tell whether the work is done. Continue where you stopped: finish the card's work on ${branch} and commit it (messages start with "${card}: "). Do not push, open a PR or touch the board.`,
    HEADLESS_WAIT_RULE,
    'End your final message with exactly one line: `RESULT: built <one-line summary>` or `RESULT: stopped <why>`.',
  ].join('\n');
}

/** The prompt line of a build that starts from an earlier run's saved branch. */
export function resumeLine(branch: string, from: 'origin' | 'local', sha: string, base: string): string {
  const where = from === 'origin' ? `origin's ${branch} @ ${sha.slice(0, 7)}` : `the local ${branch} @ ${sha.slice(0, 7)}`;
  return [
    `You are continuing: an earlier run of this card stopped before it finished and this worktree starts from its work (${where}).`,
    `Read \`git log ${base}..HEAD\` and \`git diff ${base}...HEAD\` first and carry on from there; do not start over. Commits with "wip:" in the title are unfinished saves, so check them before you rely on them. If ${base} has moved, merge it; never rebase or force.`,
    'If nothing is left to do, make one empty commit that says so (`git commit --allow-empty`): the runner counts a run as built only by its new commits.',
  ].join('\n');
}

/** The only tools a Claude spec run has, and the ones it is refused outright. */
export const SPEC_TOOLS = 'Read,Grep,Glob';
export const SPEC_DENIED_TOOLS = 'Bash Edit Write MultiEdit NotebookEdit WebFetch WebSearch Task';

/** A Claude spec run, confined to its view: only the built-in Read, Grep and Glob exist (--tools); no MCP server
 *  (--strict-mcp-config with an empty config); no user, project or local settings (--setting-sources ""), so no allow
 *  rule from elsewhere applies; the only allow rules are those three tools under the view, and dontAsk refuses every
 *  other use (a path outside the view included) instead of asking. The run's cwd is the view. Variadic flags come
 *  before --model so none of them swallows the prompt. */
export function specClaudeArgs(model: string, view: string, prompt: string): string[] {
  const roots = [...new Set([view, (() => { try { return fs.realpathSync(view); } catch { return view; } })()])].map((d) => d.replace(/\/+$/, ''));
  const allow = roots.flatMap((d) => ['Read', 'Grep', 'Glob'].map((t) => `${t}(/${d}/**)`));
  return ['-p', '--tools', SPEC_TOOLS, '--disallowedTools', SPEC_DENIED_TOOLS, '--permission-mode', 'dontAsk', '--setting-sources', '',
    '--settings', JSON.stringify({ permissions: { allow, defaultMode: 'dontAsk' } }), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ...(model ? ['--model', model] : []), '--output-format', 'stream-json', '--verbose', prompt];
}

/** The agent command for a phase. Claude: `claude -p` with auto permissions in the worktree; Codex: `codex exec`. */
export function agentCommand(tool: Tool, phase: 'build' | 'fix' | 'review' | 'spec', o: { model: string; prompt: string; dir: string; session: string; resume?: boolean }): { cmd: string; args: string[] } {
  // A spec run (draft or review) only reads: Claude gets the file-read tools and no shell at all (a git subcommand can
  // still write, e.g. `git show --output=`), Codex its read-only sandbox; the git facts it needs are in the prompt.
  if (phase === 'spec') {
    if (tool === 'claude') return { cmd: 'claude', args: specClaudeArgs(o.model, o.dir, o.prompt) };
    return { cmd: 'codex', args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', o.dir, o.prompt] };
  }
  if (tool === 'claude') {
    const out = ['--output-format', 'stream-json', '--verbose'];
    const model = o.model ? ['--model', o.model] : [];
    if (phase === 'review') return { cmd: 'claude', args: ['-p', ...model, ...out, '--allowedTools', 'Read Grep Glob Bash(git log:*) Bash(git diff:*) Bash(git show:*)', o.prompt] };
    return { cmd: 'claude', args: ['-p', ...(o.resume ? ['--resume', o.session] : ['--session-id', o.session]), ...model, '--permission-mode', 'auto', ...out, o.prompt] };
  }
  if (phase === 'review') return { cmd: 'codex', args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', o.dir, o.prompt] };
  return { cmd: 'codex', args: ['exec', '--full-auto', '--skip-git-repo-check', '-C', o.dir, o.prompt] };
}

// ---------- state ----------

export type Phase = 'claimed' | 'worktree' | 'building' | 'reviewing' | 'fixing' | 'pushing' | 'handing-back' | 'releasing' | 'speccing';

/** One card being worked, saved right after the claim and kept until the board confirms the card was handed back or
 *  released. A runner that starts and finds one recovers it (src/cli/runner.ts recover). */
export interface RunRecord {
  /** 'spec' = a spec run (no branch, no PR; dir is its read-only view of repo). Absent = a build. */
  kind?: 'spec';
  tool: Tool;
  /** The board's run for this claim: a release or outcome names it, so it never touches a later run of the card. */
  run_id: string;
  attempt: number;
  /** Unique per card run (a UUID): the outcome store refuses one job shared by two cards. */
  job: string;
  machine: string;
  since: string;
  /** since + max_min: one absolute limit for build, review and fix together. */
  deadline: string;
  log: string;
  touches: string[];
  repo: string;
  dir: string;
  branch: string;
  base: string;
  /** The branch tip before this attempt: success is judged on commits after it, not ones an earlier attempt left. */
  start_sha: string;
  pid: number;
  phase: Phase;
  /** Where this run's work is, as the card's note says it. Set once the save ran, so a retried release says the same. */
  saved?: string;
  /** Set when a release or hand-back failed: what the next look (or a restart) must still tell the board. */
  pending?: { reason: string; count: boolean };
  /** Set once the draft PR is open: what the hand-back needs if it has to be retried. */
  handback?: { pr: string; title: string; summary: string; review_note: string; open: string[]; blocked?: boolean };
}

export interface HistoryRow { card: string; tool: Tool; started: string; ended: string; outcome: 'review' | 'released' | 'rate-limited' | 'error' | 'spec-ready' | 'spec-draft'; detail: string; log: string; pr?: string }
export interface RunnerState {
  backoff: Partial<Record<Tool, string>>;
  running: Record<string, RunRecord>;
  /** The last 50 results, for `--status`. */
  history: HistoryRow[];
  /** Cards started on one local day; kept apart from history so the cap holds whatever history keeps. */
  daily: { day: string; count: number };
  /** Repos held at the last look (PR-first), with the reason, for `--status`. */
  held?: Record<string, string>;
  /** Failed spec runs per card: the card text's hash and how many runs on it stored nothing and recorded no review. */
  spec_failures?: Record<string, { hash: string; count: number; at: string }>;
  /** Why the last self-update check held (src/lib/self-update.ts), for `--status`. */
  update?: { at: string; note: string };
}
export const emptyState = (): RunnerState => ({ backoff: {}, running: {}, history: [], daily: { day: '', count: 0 } });

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Cards started today (local day) that count toward daily_cap. */
export function startedToday(s: RunnerState, now: Date): number {
  return s.daily?.day === localDay(now) ? s.daily.count : 0;
}
/** Count one start today (delta 1) or take back a start that hit a usage limit (delta -1). */
export function countStart(s: RunnerState, now: Date, delta: 1 | -1): void {
  const day = localDay(now);
  const n = s.daily?.day === day ? s.daily.count : 0;
  s.daily = { day, count: Math.max(0, n + delta) };
}

// ---------- one attempt ----------

export type Verdict =
  | { ok: true }
  | { ok: false; kind: 'stopped' | 'rate-limited' | 'failed'; reason: string };

/** Did this attempt build the card? Only an agent that exited 0, was not stopped, ended with `RESULT: built …` and made
 *  commits after start_sha did. Commits of a failed attempt are kept for the next one but do not make it a success. */
export function attemptVerdict(a: { code: number | null; stopped: string; result: string; newCommits: number; raw: string }): Verdict {
  if (a.stopped) return { ok: false, kind: 'stopped', reason: `timeout: ${a.stopped}` };
  if (a.newCommits === 0 && RATE_LIMITED.test(a.raw)) return { ok: false, kind: 'rate-limited', reason: 'usage or rate limit' };
  const said = a.result ? ` (${a.result})` : ' and no RESULT line';
  if (a.code !== 0) return { ok: false, kind: 'failed', reason: `the agent exited ${a.code} with ${a.newCommits} new commit(s)${said}` };
  if (a.newCommits === 0) return { ok: false, kind: 'failed', reason: `no commits${said}` };
  if (!/^RESULT:\s*built\b/.test(a.result)) return { ok: false, kind: 'failed', reason: `${a.newCommits} new commit(s) but no "RESULT: built" line${said}` };
  return { ok: true };
}
