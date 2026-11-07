// Spec writing (docs/specs.md): one harness drafts a card's spec from the card and the real code, the other harness
// attacks it, and the drafter revises on P0/P1 findings or blocking questions. A spec gets two full review
// passes, then at most one narrow pass on the fixes made after pass 2. The spec ends ready (a pass recorded under the reviewer's own name) or draft with the findings in a
// card note. Both harnesses see the project only through a read-only view of its default branch (openRepoView): a spec
// run writes the spec to the board and notes on the card, never the repo. Used by the runner's spec pass
// (src/lib/run-flow.ts runSpecCard) and by `dask spec` (src/cli/spec.ts).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { blocking, helperRule, HEADLESS_WAIT_RULE, reviewFindings, type Tool } from './runner.ts';
import { familyOf } from './spec-state.ts';

export const TOOL_NAME: Record<Tool, string> = { claude: 'Claude', codex: 'Codex' };
export const otherTool = (t: Tool): Tool => (t === 'claude' ? 'codex' : 'claude');
const oneLine = (s: string, n = 300) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…'; };

// ---------- the read-only view of the project ----------

/** Where a project's code is read from: a local checkout, or a GitHub `owner/name` (read with gh into a cache clone). */
export type RepoSource = { kind: 'local'; path: string } | { kind: 'github'; name: string };
const GITHUB_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `projects[].repo` as a source: an existing folder is a local checkout; `owner/name` that is no folder is GitHub. */
export function repoSource(repo: string | undefined): RepoSource | null {
  const r = (repo ?? '').trim();
  if (!r) return null;
  if (fs.existsSync(r)) return { kind: 'local', path: r };
  if (!path.isAbsolute(r) && GITHUB_RE.test(r) && !r.startsWith('.')) return { kind: 'github', name: r };
  return { kind: 'local', path: r };
}

export interface RepoView { dir: string; repo: string; base: string; sha: string; label: string; note: string; /** git facts read ahead (the agents get no shell) */ facts: string }

function git(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 180_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr || String(r.error ?? '')).trim() };
}

/** The remote default branch (origin/HEAD, else origin/main or origin/master), else a local main/master. */
export function defaultBranch(repo: string): string {
  const h = git(repo, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD');
  if (h.ok && h.out) return h.out;
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) if (git(repo, 'rev-parse', '-q', '--verify', b).ok) return b;
  throw new Error(`no default branch (origin/HEAD, main or master) in ${repo}`);
}

/** Every file and folder of the view without write permission (and back, before it is removed). */
const setWritable = (dir: string, on: boolean) => { if (fs.existsSync(dir)) spawnSync('chmod', ['-R', on ? 'u+w' : 'a-w', dir], { timeout: 120_000 }); };

/** A read-only view of the project at its default branch: `git fetch`, then a detached worktree of origin/<default> under
 *  viewsDir with every file read-only. Never the user's working tree (which may be dirty or on another branch). A GitHub
 *  project is cloned shallow with gh into cacheDir first (fetched again on later runs). */
export function openRepoView(src: RepoSource, viewsDir: string, cacheDir: string, card: string, gh: string | null, prefix = ''): RepoView {
  let repo: string, note = '';
  if (src.kind === 'github') {
    repo = path.join(cacheDir, ...src.name.split('/'));
    if (fs.existsSync(path.join(repo, '.git'))) {
      const f = git(repo, 'fetch', '-q', '--depth', '1', 'origin');
      if (!f.ok) note = `fetch failed (${oneLine(f.err, 120)}); read the cached copy`;
    } else {
      if (!gh) throw new Error(`project repo ${src.name} has no local checkout and gh is not installed`);
      fs.mkdirSync(path.dirname(repo), { recursive: true });
      const c = spawnSync(gh, ['repo', 'clone', src.name, repo, '--', '--depth', '1', '-q'], { encoding: 'utf8', timeout: 600_000 });
      if (c.status !== 0) throw new Error(`gh repo clone ${src.name}: ${oneLine(c.stderr || c.stdout || String(c.error), 200)}`);
    }
  } else {
    repo = src.path;
    if (!fs.existsSync(path.join(repo, '.git'))) throw new Error(`repo ${repo} is not a git checkout`);
    const f = git(repo, 'fetch', '-q', 'origin');
    if (!f.ok) note = `git fetch failed (${oneLine(f.err, 120)}); read the last fetched ${'origin'} state`;
  }
  const base = defaultBranch(repo);
  const sha = git(repo, 'rev-parse', base).out;
  fs.mkdirSync(viewsDir, { recursive: true });
  const dir = path.join(viewsDir, `${prefix}${card}-${randomUUID().slice(0, 8)}`);
  const w = git(repo, 'worktree', 'add', '-q', '--detach', dir, sha);
  if (!w.ok) throw new Error(`could not make the read-only view: ${oneLine(w.err, 200)}`);
  setWritable(dir, false);
  return { dir, repo, base, sha, label: src.kind === 'github' ? src.name : repo, note, facts: repoFacts(dir) };
}

const FACT_FILES = 400;
/** What a spec agent would ask git for, read ahead: it has file-read tools only, no shell. */
export function repoFacts(dir: string): string {
  const files = git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').out.split('\n').filter(Boolean);
  const log = git(dir, 'log', '--oneline', '-15').out;
  return [`Files at this commit (${files.length}${files.length > FACT_FILES ? `, first ${FACT_FILES}` : ''}):`, ...files.slice(0, FACT_FILES).map((f) => '  ' + f),
    'Recent commits:', ...log.split('\n').filter(Boolean).map((l) => '  ' + l)].join('\n');
}

/** Remove a view (also one a crashed run left behind). */
export function closeRepoView(repo: string, dir: string): void {
  setWritable(dir, true);
  if (repo && fs.existsSync(dir)) git(repo, 'worktree', 'remove', '--force', dir);
  fs.rmSync(dir, { recursive: true, force: true });
  if (repo) git(repo, 'worktree', 'prune');
}

/** Views a `dask spec` process left when it was killed hard (named cli-<pid>-…): removed when that pid is gone. The
 *  runner's own views are recovered from its state file, never here. */
export function cleanStaleCliViews(viewsDir: string, alive: (pid: number) => boolean): string[] {
  const gone: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(viewsDir); } catch { return gone; }
  for (const n of names) {
    const m = /^cli-(\d+)-/.exec(n);
    if (!m || alive(Number(m[1]))) continue;
    const dir = path.join(viewsDir, n);
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    closeRepoView(common.ok ? path.dirname(common.out) : '', dir);
    gone.push(dir);
  }
  return gone;
}

// ---------- prompts ----------

/** How a spec is written: the same method as skills/spec-writer, for headless runs that may not load skills. */
export const SPEC_METHOD = [
  'Method:',
  '1. Read the card, then the code in your working directory (a read-only copy of the project at its default branch). Find the files, functions, routes and tests the card is really about. Name only files and functions that exist here (or say they are new).',
  '2. Attack the premise before writing: is the problem real in this code, already solved, or aimed at the wrong place? If the card is wrong, say so in ## Background and narrow it to what holds.',
  '3. Write the spec as one Markdown card. Header lines before the first `## ` heading (the card contract): id, goal, role (builder), tier (1-3), repo, branch, lane, deadline (YYYY-MM-DD), size (small|big), depends_on (card ids or none), impl and review (the two tools, e.g. `impl: claude` / `review: codex`, never the same), touches (the paths the build changes, comma separated), secrets (labels only, never values; omit when none), done_when (one line: what the user sees when the card is done, checkable by someone who did not build it), done_at (pr = done when the PR merges; live = done only after someone checks the end state after the merge), and pass_checks: a list of 3-5 checks that can actually fail (a command and the result it must give, not "works" or "is clean").',
  '4. Sections: ## Background (what the code does today, with file references), ## Why, ## Scope, ## Non-goals, ## Files likely touched, ## Context pack (files and docs to read first), ## Acceptance tests (concrete tests: name, setup, action, expected result; each must fail on today\'s code), ## Tests, ## Done criteria (a list), ## Open questions.',
  '5. Open questions: one line each, `- [Q] often=<1-10> bad=<1-10> kind=<security|data-loss|approval|what|where|done|other> <question>`. Security, data loss and approval questions always block. A plain what/where/done question whose often x bad is under 30 is not a blocker: write it as `implementer decides (score N): <question>` instead.',
  '6. No secrets, tokens or personal data in the spec.',
].join('\n');

const SPEC_START = '<<<SPEC', SPEC_END = 'SPEC>>>';

export interface DraftInput {
  card: string; title: string; goal: string; lane: string; cardText: string; view: RepoView;
  /** The current spec when one exists (revise it rather than start over). */
  current?: string;
  /** What the last review found, for a revision. */
  findings?: string[];
  /** The board's contract refusal of the last text. */
  refused?: string[];
}

export function draftPrompt(x: DraftInput): string {
  const revising = !!(x.findings?.length || x.refused?.length);
  return [
    `You are writing the spec for Dasks card ${x.card} (${x.title || 'untitled'}), project ${x.goal}, lane ${x.lane}.`,
    `Read-only: your working directory is a read-only copy of ${x.view.label} at ${x.view.base} (${x.view.sha.slice(0, 12)}). Do not edit or create files, do not commit, do not touch the board and do not build anything: print the spec only. The runner stores it.`,
    'You have file-read tools only (no shell); the git facts below were read for you.', x.view.facts,
    SPEC_METHOD,
    `Header values to use: id: ${x.card} · goal: ${x.goal} · lane: ${x.lane} · branch: dasks/${x.card} · repo: ${x.view.label}.`,
    'The card as it stands:', '-----', x.cardText.trim() || '(empty)', '-----',
    ...(x.current ? ['The current spec text (revise it; keep what holds):', '-----', x.current.trim(), '-----'] : []),
    ...(revising ? ['Revise the spec. Fix every point below; keep what was fine.', ...(x.findings ?? []).map((f) => '  ' + f), ...(x.refused?.length ? ['The board refused the last text (card contract):', ...x.refused.map((r) => '  ' + r)] : [])] : []),
    HEADLESS_WAIT_RULE,
    helperRule(x.card),
    `Print the whole spec between a line \`${SPEC_START}\` and a line \`${SPEC_END}\`, then end with exactly one line: \`RESULT: drafted <one-line summary>\` or \`RESULT: stopped <why>\`.`,
  ].join('\n');
}

/** The narrow third pass: only whether the pass-2 findings are fixed, and whether those fixes broke anything. */
export function narrowPassRule(previous: string[]): string {
  return ['Narrow pass (pass 3 of 3): check only whether these findings from pass 2 are fixed in this version, and whether the text changed for them broke anything. Raise nothing about parts of the spec those fixes did not touch.', ...previous.map((f) => '  ' + f)].join('\n');
}

export function reviewSpecPrompt(card: string, spec: string, author: Tool, view: RepoView, narrow?: string[]): string {
  return [
    `You are the adversarial reviewer of the spec for Dasks card ${card}. ${TOOL_NAME[author]} wrote it; you are the other model family.`,
    `Read-only: your working directory is the same read-only copy of ${view.label} at ${view.base} (${view.sha.slice(0, 12)}). Check every claim of the spec against this code. Do not edit files, commit or touch the board.`,
    'You have file-read tools only (no shell); the git facts below were read for you.', view.facts,
    'Attack it: a wrong premise (the problem is not there, already solved, or aimed at the wrong code); files, functions or routes named that do not exist; acceptance tests missing, not testing the goal, or that would pass on today\'s code; pass checks that cannot fail; a done_when nobody can check ("works", "is better"), or done_at: pr for a change that only shows once it is live; scope or non-goals left unstated; hidden dependencies (other cards, migrations, secrets, services, data formats); done criteria nobody can check.',
    'List each finding on its own line: `- [P0|P1|P2|P3] <section>: <what is wrong and the fix>`. P0/P1 = the spec must change before anyone builds it; P2/P3 = notes.',
    'List each open question on its own line: `- [Q] often=<1-10> bad=<1-10> kind=<security|data-loss|approval|what|where|done|other> <question>` (often = how often a builder would hit it, bad = how bad a wrong guess is). Security, data-loss and approval questions always block; other questions block at often x bad >= 30.',
    helperRule(card),
    ...(narrow ? [narrowPassRule(narrow)] : []),
    'The spec:', '-----', spec.trim(), '-----',
    'End with exactly one line: `VERDICT: pass` (no P0/P1 finding and no blocking question) or `VERDICT: fail`.',
  ].join('\n');
}

/** Review passes per spec run: two full passes, then at most one narrow pass. */
export const SPEC_REVIEW_PASSES = 3;

/** The spec text an agent printed between the markers ('' when there is none). The last pair wins. */
export function extractSpec(text: string): string {
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() === SPEC_END) { end = i; break; }
  if (end < 0) return '';
  for (let i = end - 1; i >= 0; i--) if (lines[i].trim() === SPEC_START) return lines.slice(i + 1, end).join('\n').trim() + '\n';
  return '';
}

// ---------- reading a review ----------

export interface SpecQuestion { often: number; bad: number; score: number; kind: string; text: string; blocks: boolean; line: string }
export interface SpecReviewRead {
  findings: { severity: string; line: string }[];
  questions: SpecQuestion[];
  /** P0/P1 findings and blocking questions: what the drafter must fix. */
  blockers: string[];
  /** Non-blocking questions, as "implementer decides (score N): …". */
  implementerDecides: string[];
  /** The reviewer ended with a VERDICT line. */
  finished: boolean;
  /** pass: finished, no P0/P1, no blocking question and the reviewer did not say fail. */
  pass: boolean;
}

const ALWAYS_BLOCK = new Set(['security', 'data-loss', 'approval']);
/** The often x bad rule: security, data-loss and approval questions always block; any other blocks at 30 or more. */
export const questionBlocks = (kind: string, score: number) => ALWAYS_BLOCK.has(kind) || score >= 30;

export function readSpecReview(text: string): SpecReviewRead {
  const findings = reviewFindings(text);
  const questions: SpecQuestion[] = [];
  for (const l of text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?\[Q\]\s*often\s*=\s*(\d+)\s+bad\s*=\s*(\d+)\s+kind\s*=\s*([a-z-]+)\s+(.+)$/i.exec(l);
    if (!m) continue;
    const often = Math.min(10, Math.max(1, Number(m[1]))), bad = Math.min(10, Math.max(1, Number(m[2])));
    const kind = m[3].toLowerCase(), score = often * bad;
    questions.push({ often, bad, score, kind, text: m[4].trim(), blocks: questionBlocks(kind, score), line: l.trim().slice(0, 400) });
  }
  // Finished only when the last non-empty line is exactly `VERDICT: pass` or `VERDICT: fail`: a verdict quoted earlier,
  // or followed by more text ("I could not finish"), is no verdict.
  const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const said = /^VERDICT: (pass|fail)$/.exec(last)?.[1] ?? '';
  const blockers = [...blocking(findings).map((f) => f.line), ...questions.filter((q) => q.blocks).map((q) => `blocking question (${q.kind}, score ${q.score}): ${q.text}`)];
  const implementerDecides = questions.filter((q) => !q.blocks).map((q) => `implementer decides (score ${q.score}): ${q.text}`);
  if (said === 'fail' && !blockers.length) blockers.push('the reviewer said VERDICT: fail without a P0/P1 finding or blocking question');
  return { findings, questions, blockers, implementerDecides, finished: !!said, pass: !!said && said === 'pass' && !blockers.length };
}

// ---------- the loop ----------

export interface AgentRun { code: number | null; stopped: string; text: string; raw: string }
export interface SpecLoopEnv {
  card: string; title: string; goal: string; lane: string; cardText: string; view: RepoView;
  drafter: Tool;
  /** The board name the spec is written as (the drafter). */
  author: string;
  /** The reviewing tool and its board name; null = no reviewer of another family here (draft only). */
  reviewer: { tool: Tool; actor: string } | null;
  /** Why there is no reviewer (said in the note). */
  noReviewer?: string;
  families: Record<string, string>;
  /** A spec the session already wrote (dask spec --file): stored as the first draft instead of a headless one. */
  preset?: string;
  maxRounds?: number;
  run: (tool: Tool, prompt: string, label: string) => Promise<AgentRun>;
  api: (method: string, route: string, body?: unknown, as?: string) => Promise<any>;
  log: (line: string) => void;
}
export interface SpecOutcome { state: 'ready' | 'draft' | 'unchanged'; version: number; rounds: number; note: string; why: string; /** a version was stored or a review recorded */ progressed: boolean }

/** A board refusal with its status and body (thrown by the env's api). */
const status = (e: any): number => Number(e?.status ?? 0);

export async function specLoop(x: SpecLoopEnv): Promise<SpecOutcome> {
  const maxRounds = x.maxRounds ?? SPEC_REVIEW_PASSES;
  let previous: string[] = [];
  const lines: string[] = [];
  let progressed = false;
  let current: { text: string; version: number; authors: any } | null = null;
  try {
    const sp = await x.api('GET', `/api/tasks/${x.card}/spec`);
    if (sp && typeof sp.text === 'string') current = { text: sp.text, version: Number(sp.metadata?.version ?? 0), authors: sp.section_authors };
  } catch (e: any) { if (status(e) !== 404) throw e; }
  const done = (state: SpecOutcome['state'], rounds: number, why: string): SpecOutcome => {
    const note = oneLine([`spec ${state === 'ready' ? 'ready' : state === 'draft' ? 'left as draft' : 'not changed'}: ${why}`, ...lines].join(' | '), 1800);
    return { state, version: current?.version ?? 0, rounds, note, why, progressed };
  };

  /** Draft or revise with the drafter, then store it; a contract refusal gets one fix. null = nothing stored. */
  const write = async (findings: string[] | undefined, preset?: string): Promise<string> => {
    let refused: string[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let text = attempt === 0 ? preset ?? '' : '';
      if (!text) {
        const prompt = draftPrompt({ card: x.card, title: x.title, goal: x.goal, lane: x.lane, cardText: x.cardText, view: x.view, current: current?.text, findings, refused });
        const r = await x.run(x.drafter, prompt, current ? 'revise' : 'draft');
        if (r.stopped) return `the ${TOOL_NAME[x.drafter]} draft was stopped: ${r.stopped}`;
        text = extractSpec(r.text);
        if (!text) return `${TOOL_NAME[x.drafter]} printed no spec (exit ${r.code}${/RESULT:/.test(r.text) ? `, ${oneLine(r.text.split('\n').filter((l) => l.startsWith('RESULT:')).pop() ?? '', 200)}` : ''})`;
      }
      try {
        const put = await x.api('PUT', `/api/tasks/${x.card}/spec`, { text, expected_spec_version: current?.version ?? 0, note: findings?.length || refused?.length ? `revised after review (${x.drafter})` : `drafted by ${x.drafter}` }, x.author);
        current = { text, version: Number(put?.metadata?.version ?? (current?.version ?? 0) + 1), authors: put?.section_authors };
        progressed = true;
        x.log(`${x.card}: spec v${current.version} stored by ${x.author}`);
        return '';
      } catch (e: any) {
        if (status(e) === 422 && attempt === 0) { refused = Array.isArray(e.body?.reasons) ? e.body.reasons.map(String) : [oneLine(e.message, 300)]; findings = undefined; continue; }
        return `the board refused the spec: ${oneLine(e.body?.reasons?.join('; ') || e.message, 400)}`;
      }
    }
    return 'the board refused the spec twice';
  };

  if (x.preset !== undefined || !current) {
    const why = await write(undefined, x.preset);
    if (why) return done(current ? 'draft' : 'unchanged', 0, why);
  }
  if (!x.reviewer) return done('draft', 0, `v${current!.version} drafted by ${x.author}; not reviewed: ${x.noReviewer || 'no reviewer of another model family'}`);

  for (let round = 1; round <= maxRounds; round++) {
    // The board refuses a reviewer of an answer-key author's family; say it before running anyone.
    const authors = [current!.authors?.acceptance_tests?.by, current!.authors?.oracle?.by].filter(Boolean) as string[];
    const fam = familyOf(x.reviewer.actor, x.families);
    const clash = authors.find((a) => !fam || familyOf(a, x.families) === fam);
    if (clash) return done('draft', round - 1, `v${current!.version} not reviewed: ${x.reviewer.actor} is the same model family as the answer-key author ${clash}`);
    // Passes 1 and 2 are full; pass 3 is narrow, on the pass-2 findings only.
    const rv = await x.run(x.reviewer.tool, reviewSpecPrompt(x.card, current!.text, x.drafter, x.view, round === 3 ? previous : undefined), `review${round}`);
    if (rv.stopped) return done('draft', round - 1, `the review was stopped: ${rv.stopped}`);
    const read = readSpecReview(rv.text);
    if (rv.code !== 0 || !read.finished) return done('draft', round - 1, `the ${TOOL_NAME[x.reviewer.tool]} review did not finish (exit ${rv.code}${read.finished ? '' : ', its last line is not VERDICT: pass|fail'}); nothing recorded`);
    try {
      await x.api('POST', `/api/tasks/${x.card}/spec/review`, { spec_version: current!.version, verdict: read.pass ? 'pass' : 'fail' }, x.reviewer.actor);
    } catch (e: any) { return done('draft', round, `the board refused the review: ${oneLine(e.message, 300)}`); }
    progressed = true;
    x.log(`${x.card}: spec v${current!.version} review ${round} by ${x.reviewer.actor}: ${read.pass ? 'pass' : `${read.blockers.length} blocker(s)`}`);
    lines.splice(0, lines.length, ...read.implementerDecides);
    if (read.pass) return done('ready', round, `v${current!.version} passed review round ${round} by ${x.reviewer.actor}`);
    if (round === maxRounds) { lines.unshift(...read.blockers.map((b) => 'open: ' + b)); return done('draft', round, `v${current!.version} still has ${read.blockers.length} blocker(s) after ${round} review passes`); }
    previous = read.blockers;
    const why = await write(read.blockers);
    if (why) { lines.unshift(...read.blockers.map((b) => 'open: ' + b)); return done('draft', round, why); }
  }
  return done('draft', maxRounds, 'review rounds used up');
}

/** A card's content for the spec pass's failure memory: title, body without its Notes section (notes change on every
 *  run) and the spec version. */
export function cardHash(title: string, body: string, specVersion: number): string {
  const text = String(body ?? '').replace(/(^|\n)## Notes[ \t]*(\n[\s\S]*?)?(?=\n## |$)/, '$1').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(JSON.stringify([title ?? '', text, specVersion])).digest('hex').slice(0, 16);
}

/** The default cache of GitHub projects read for specs. */
export const specCacheDir = (home: string) => path.join(home, 'cache');
export const specViewsDir = (home: string) => path.join(home, 'spec-views');
