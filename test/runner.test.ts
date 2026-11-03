// The card runner, with fake claude, codex, gh and gitleaks on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  RUNNER_DEFAULTS, agentText, attemptVerdict, blocking, cardTouches, countAllOpenPrs, countOpenPrs, countStart, emptyState, pickCards, prHolds, projectRepos, RATE_LIMITED, resultLine,
  reviewFindings, runnerConfig, startedToday, type Candidate, type PickInput,
} from '../src/lib/runner.ts';
import { touchesOverlap } from '../src/lib/touches.ts';
import { overrun, supervise, worktreeStamp } from '../src/lib/supervise.ts';
import { task, tempRepo } from './helpers.ts';
import { unusedPort, until } from './state-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = new Date('2026-11-02T12:00:00Z');
const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({ id, goal: id.split('.')[0], lane: 'claude', priority: 'p2', spec_state: 'ready', touches: [], ...over });
const input = (over: Partial<PickInput> = {}): PickInput => ({
  ready: [], running: [], cfg: { max_parallel: 2, daily_cap: 10 }, startedToday: 0, tools: new Set(['claude', 'codex']), backoff: {},
  repos: new Map([['web', '/r/web'], ['api', '/r/api']]), now: NOW, ...over,
});
const ids = (x: { picked: { card: string }[] }) => x.picked.map((p) => p.card);

// ---------- unit ----------

test('config: defaults, validation, max below timeout; repos per project', () => {
  assert.deepEqual(runnerConfig({}), RUNNER_DEFAULTS);
  assert.equal(runnerConfig({}).enabled, false, 'off by default');
  assert.equal(runnerConfig({ runner: { timeout_min: 30, max_min: 10 } }).max_min, 30);
  assert.throws(() => runnerConfig({ runner: { max_parallel: 0 } }), /max_parallel/);
  assert.throws(() => runnerConfig({ runner: { enabled: 'yes' } }), /enabled/);
  assert.throws(() => runnerConfig({ runner: { poll_minutes: 0 } }), /poll_minutes/);
  assert.throws(() => runnerConfig({ runner: 3 }), /runner must be an object/);
  const r = projectRepos({ projects: [{ id: 'web', name: 'W', repo: '/x/web' }, { id: 'api', name: 'A' }, { id: 'h', name: 'H', repo: '~/code/h' }] });
  assert.equal(r.get('web'), '/x/web');
  assert.ok(!r.has('api'));
  assert.equal(r.get('h'), path.join(os.homedir(), 'code/h'));
});

test('pick: ready rule, lanes, missing repo, missing tool', () => {
  const x = pickCards(input({ ready: [
    cand('web.t-a'), cand('web.t-draft', { spec_state: 'draft' }), cand('web.t-none', { lane: 'none' }), cand('web.t-cx', { lane: 'codex' }),
    cand('norepo.t-b'),
  ], cfg: { max_parallel: 5, daily_cap: 10 } }));
  assert.deepEqual(ids(x), ['web.t-a', 'web.t-cx']);
  assert.deepEqual(x.picked.map((p) => p.tool), ['claude', 'codex']);
  const why = Object.fromEntries(x.skipped.map((s) => [s.card, s.why]));
  assert.match(why['web.t-draft'], /spec is draft/);
  assert.match(why['web.t-none'], /lane none/);
  assert.match(why['norepo.t-b'], /no repo/);
  const nocodex = pickCards(input({ ready: [cand('web.t-cx', { lane: 'codex' })], tools: new Set(['claude']) }));
  assert.deepEqual(ids(nocodex), []);
  assert.match(nocodex.skipped[0].why, /codex is not installed/);
});

test('pick: priority order, board order within a priority, max_parallel and running cards', () => {
  const ready = [cand('web.t-p2a'), cand('web.t-p0', { priority: 'p0' }), cand('web.t-p2b'), cand('web.t-p1', { priority: 'p1' })];
  assert.deepEqual(ids(pickCards(input({ ready, cfg: { max_parallel: 3, daily_cap: 10 } }))), ['web.t-p0', 'web.t-p1', 'web.t-p2a']);
  const busy = pickCards(input({ ready, running: [{ card: 'api.t-x', tool: 'claude', repo: '/r/api', touches: [] }] }));
  assert.deepEqual(ids(busy), ['web.t-p0']);
  assert.match(busy.skipped.find((s) => s.card === 'web.t-p1')!.why, /slots busy/);
  assert.deepEqual(ids(pickCards(input({ ready: [cand('web.t-p0')], running: [{ card: 'web.t-p0', tool: 'claude', repo: '/r/web', touches: [] }] }))), []);
});

test('pick: never two cards that share touches; no touches overlaps nothing; the root overlaps all', () => {
  assert.ok(touchesOverlap(['src/lib'], ['src/lib/x.ts']));
  assert.ok(touchesOverlap(['src/lib/**'], ['src/lib/a/b.ts']));
  assert.ok(!touchesOverlap(['src/lib'], ['src/libs']));
  assert.ok(!touchesOverlap([], ['src']));
  assert.ok(touchesOverlap(['.'], ['docs/a.md']));
  assert.deepEqual(cardTouches('touches: src/a, docs/b.md\n## Context\ntouches: other\n'), ['src/a', 'docs/b.md']);
  const ready = [cand('web.t-1', { touches: ['src/a'] }), cand('web.t-2', { touches: ['src/a/b.ts'] }), cand('web.t-3', { touches: ['src/c'] }), cand('web.t-4')];
  const x = pickCards(input({ ready, cfg: { max_parallel: 4, daily_cap: 10 } }));
  assert.deepEqual(ids(x), ['web.t-1', 'web.t-3', 'web.t-4']);
  assert.match(x.skipped[0].why, /touches overlap/);
  const vsRunning = pickCards(input({ ready: [cand('web.t-2', { touches: ['src/a/b.ts'] })], running: [{ card: 'web.t-9', tool: 'codex', repo: '/r/web', touches: ['src'] }] }));
  assert.deepEqual(ids(vsRunning), []);
});

test('pick: touches only conflict inside one repo', () => {
  const otherRepo = pickCards(input({ ready: [cand('web.t-2', { touches: ['src/a/b.ts'] })], running: [{ card: 'api.t-9', tool: 'codex', repo: '/r/api', touches: ['src'] }] }));
  assert.deepEqual(ids(otherRepo), ['web.t-2']);
  const twoNew = pickCards(input({ ready: [cand('web.t-1', { touches: ['src'] }), cand('api.t-1', { touches: ['src'] })] }));
  assert.deepEqual(ids(twoNew), ['web.t-1', 'api.t-1']);
});

test('pick: daily cap counts started cards (not rate-limited ones) and running ones; backoff skips that tool only', () => {
  const ready = [cand('web.t-1'), cand('web.t-2', { lane: 'codex' })];
  const capped = pickCards(input({ ready, cfg: { max_parallel: 2, daily_cap: 3 }, startedToday: 2, running: [{ card: 'api.t-x', tool: 'claude', repo: '/r/api', touches: [] }] }));
  assert.deepEqual(ids(capped), []);
  assert.match(capped.skipped[0].why, /daily cap 3/);
  assert.deepEqual(ids(pickCards(input({ ready, cfg: { max_parallel: 2, daily_cap: 3 }, startedToday: 2 }))), ['web.t-1']);
  const later = new Date(NOW.getTime() + 3600_000).toISOString();
  const bo = pickCards(input({ ready, backoff: { claude: later } }));
  assert.deepEqual(ids(bo), ['web.t-2']);
  assert.match(bo.skipped[0].why, /claude backs off until/);
  const over = pickCards(input({ ready, backoff: { claude: new Date(NOW.getTime() - 1000).toISOString() } }));
  assert.deepEqual(ids(over), ['web.t-1', 'web.t-2'], 'a backoff in the past is over');
});

test('limits: never stopped before timeout; idle and hard limit after it', () => {
  const c = { timeout_min: 180, idle_min: 150, max_min: 720 };
  assert.equal(overrun(100, 100, c), '');
  assert.equal(overrun(200, 10, c), '');
  assert.match(overrun(200, 151, c), /no output for 151 min/);
  assert.match(overrun(720, 0, c), /hard limit 720/);
  assert.match(overrun(181, 0, { ...c, idle_min: 0 }), /card timeout 180/);
});

test('PR-first: a repo with more open PRs than runner.pr_limit is held; a failed count holds nothing; 0 is off', () => {
  assert.equal(RUNNER_DEFAULTS.pr_limit, 10);
  assert.throws(() => runnerConfig({ runner: { pr_limit: -1 } }), /pr_limit/);
  const counts = new Map<string, any>([['/r/web', { ok: true, open: 11 }], ['/r/api', { ok: true, open: 10 }], ['/r/x', { ok: false, why: 'gh is not installed' }]]);
  const held = prHolds(counts, 10);
  assert.deepEqual([...held.keys()], ['/r/web'], 'at the limit is not over it; a failed count fails open');
  assert.match(held.get('/r/web')!, /11 open PRs in \/r\/web, over runner\.pr_limit 10/);
  assert.equal(prHolds(counts, 0).size, 0);
  const x = pickCards(input({ ready: [cand('web.t-1'), cand('api.t-1')], held }));
  assert.deepEqual(ids(x), ['api.t-1']);
  assert.match(x.skipped[0].why, /^PR-first: 11 open PRs/);
});

test('PR-first: open PRs are counted with gh in the repo; no gh or a gh error is a failed count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-gh-'));
  try {
    const gh = path.join(dir, 'gh');
    fs.writeFileSync(gh, `#!/bin/bash\nprintf '%s\\n' "$PWD $*" >> ${dir}/args\n[ -f ${dir}/fail ] && { echo 'gh: not logged in' >&2; exit 4; }\necho 12\n`, { mode: 0o755 });
    assert.deepEqual(await countOpenPrs(dir, gh), { ok: true, open: 12 });
    assert.match(fs.readFileSync(path.join(dir, 'args'), 'utf8'), /pr list --state open --limit 1000 --json number --jq length/);
    fs.writeFileSync(path.join(dir, 'fail'), '');
    const bad = await countOpenPrs(dir, gh);
    assert.equal(bad.ok, false);
    assert.match((bad as any).why, /gh pr list failed \(gh: not logged in\)/);
    assert.deepEqual(await countOpenPrs(dir, null), { ok: false, why: 'gh is not installed' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('output: RESULT line, stream-json result text, rate-limit text, review findings', () => {
  assert.equal(resultLine('x\nRESULT: built one\nmore\nRESULT: built two\n'), 'RESULT: built two');
  assert.equal(resultLine('nothing'), '');
  const sj = [JSON.stringify({ type: 'system' }), JSON.stringify({ type: 'result', result: 'done\nRESULT: built it' })].join('\n');
  assert.equal(resultLine(agentText(sj)), 'RESULT: built it');
  assert.ok(RATE_LIMITED.test('Claude AI usage limit reached|1730000000'));
  assert.ok(RATE_LIMITED.test('API Error: 429 {"type":"rate_limit_error"}'));
  assert.ok(!RATE_LIMITED.test('RESULT: built the limiter'));
  const f = reviewFindings('Findings:\n- [P1] src/a.ts:3 off by one\n- [P3] naming\n**P0** data loss in save\nP2: slow loop\nnot a P1 line\nVERDICT: changes');
  assert.deepEqual(f.map((x) => x.severity), ['P1', 'P3', 'P0', 'P2']);
  assert.equal(blocking(f).length, 2);
});

test('daily cap: a day counter apart from the 50-row history, a rate-limited start taken back', () => {
  const s = emptyState();
  s.history = Array.from({ length: 50 }, (_, i) => ({ card: `web.t-${i}`, tool: 'claude' as const, started: NOW.toISOString(), ended: '', outcome: 'released' as const, detail: '', log: '' }));
  for (let i = 0; i < 55; i++) countStart(s, NOW, 1);
  assert.equal(startedToday(s, NOW), 55, 'more starts than history keeps');
  countStart(s, NOW, -1);
  assert.equal(startedToday(s, NOW), 54);
  assert.equal(startedToday(s, new Date(NOW.getTime() + 86400_000)), 0, 'a new day starts at 0');
  const capped = pickCards(input({ ready: [cand('web.t-1')], cfg: { max_parallel: 2, daily_cap: 60 }, startedToday: startedToday(s, NOW) }));
  assert.deepEqual(ids(capped), ['web.t-1'], 'a cap above 50 is reachable');
});

test('attempt verdict: exit code, RESULT and commits after the start tip all count', () => {
  const ok = { code: 0, stopped: '', result: 'RESULT: built x', newCommits: 1, raw: '' };
  assert.deepEqual(attemptVerdict(ok), { ok: true });
  assert.equal(attemptVerdict({ ...ok, code: 1 }).ok, false, 'a crash with commits is a failure');
  assert.match((attemptVerdict({ ...ok, result: 'RESULT: stopped the spec is wrong' }) as any).reason, /no "RESULT: built"/);
  assert.match((attemptVerdict({ ...ok, newCommits: 0 }) as any).reason, /no commits/, 'commits of an earlier attempt do not count');
  assert.equal((attemptVerdict({ ...ok, stopped: 'hard limit 5 min' }) as any).kind, 'stopped');
  assert.equal((attemptVerdict({ ...ok, code: 1, newCommits: 0, raw: '429 rate limit' }) as any).kind, 'rate-limited');
});

test('supervise: one deadline from the card start, not from each phase', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-sup-'));
  try {
    const t0 = Date.now();
    const s = supervise({ cmd: 'sleep', args: ['30'], cwd: dir, env: process.env, logFile: path.join(dir, 'log'), cardStart: Date.now() - 6 * 60000,
      limits: { timeout_min: 1, idle_min: 0, max_min: 5 }, tickMs: 50, graceMs: 500 });
    const r = await s.done;
    assert.match(r.stopped, /hard limit 5 min/);
    assert.ok(Date.now() - t0 < 5000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('supervise: helpers that ignore SIGTERM are killed on every exit path before it returns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-sup-'));
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const limits = { timeout_min: 60, idle_min: 0, max_min: 60 };
  try {
    // The leader exits at once and leaves a helper that ignores SIGTERM.
    const leftover = path.join(dir, 'left.pid');
    const a = supervise({ cmd: 'bash', args: ['-c', `(trap '' TERM; sleep 30) & echo $! > ${leftover}; exit 0`], cwd: dir, env: process.env, logFile: path.join(dir, 'a.log'), cardStart: Date.now(), limits, tickMs: 50, graceMs: 300 });
    assert.equal((await a.done).code, 0);
    assert.ok(gone(Number(fs.readFileSync(leftover, 'utf8'))), 'the helper is gone when done resolves');
    // A leader that ignores SIGTERM itself, stopped early.
    const b = supervise({ cmd: 'bash', args: ['-c', "trap '' TERM; while true; do sleep 1; done"], cwd: dir, env: process.env, logFile: path.join(dir, 'b.log'), cardStart: Date.now(), limits, tickMs: 50, graceMs: 300 });
    setTimeout(() => b.stop('runner stopped'), 200);
    const rb = await b.done;
    assert.equal(rb.stopped, 'runner stopped');
    assert.ok(gone(b.pid));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Past the card timeout: a run still writing is kept, a quiet one is stopped, every run stops at the hard limit. These
// runs print nothing, so only the worktree tells the runner whether they still work.
function gitDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-sup-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
const SHORT = { timeout_min: 0.005, idle_min: 0.02, max_min: 5 };   // 0.3 s, then stopped after 1.2 s without a change

test('worktree stamp takes no git lock, so it never fails the agent\'s own commit in that worktree', async () => {
  const dir = gitDir();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-gitlog-'));
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${bin}/args"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    process.env.PATH = `${bin}:${PATH}`;
    assert.notEqual(await worktreeStamp(dir), null);
    const calls = fs.readFileSync(path.join(bin, 'args'), 'utf8').trim().split('\n');
    const status = calls.filter((c) => / status /.test(` ${c} `));
    assert.ok(status.length > 0, calls.join('\n'));
    for (const c of status) assert.match(c, /--no-optional-locks/, 'a status that may refresh the index takes index.lock');
  } finally { process.env.PATH = PATH; fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('limits: a run still changing its worktree past the card timeout is kept and ends on its own', async () => {
  const dir = gitDir();
  try {
    let kept = -1;
    // 3 s of silent work (no log output), one file edit every 0.2 s: longer than idle_min, so only the worktree keeps it.
    const s = supervise({ cmd: 'bash', args: ['-c', 'for i in $(seq 1 15); do echo $i > work.txt; sleep 0.2; done; exit 0'], cwd: dir, env: process.env,
      logFile: path.join(dir, '.git', 'run.log'), cardStart: Date.now(), limits: SHORT, tickMs: 50, graceMs: 300,
      activity: () => worktreeStamp(dir), activityMs: 100, onKept: (idle) => { kept = idle; } });
    const r = await s.done;
    assert.equal(r.stopped, '', 'kept while writing');
    assert.equal(r.code, 0);
    assert.ok(kept >= 0, 'the keep was reported once');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limits: a quiet run past the card timeout is stopped once idle_min passes without a change', async () => {
  const dir = gitDir();
  try {
    const t0 = Date.now();
    const s = supervise({ cmd: 'sleep', args: ['30'], cwd: dir, env: process.env, logFile: path.join(dir, '.git', 'run.log'), cardStart: Date.now(),
      limits: SHORT, tickMs: 50, graceMs: 300, activity: () => worktreeStamp(dir), activityMs: 100 });
    const r = await s.done;
    assert.match(r.stopped, /^no output for \d+ min$/);
    assert.ok(Date.now() - t0 < 10_000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limits: the hard limit stops a run that is still writing', async () => {
  const dir = gitDir();
  try {
    const s = supervise({ cmd: 'bash', args: ['-c', 'while true; do date +%s%N > work.txt; echo tick; sleep 0.1; done'], cwd: dir, env: process.env,
      logFile: path.join(dir, '.git', 'run.log'), cardStart: Date.now(), limits: { ...SHORT, max_min: 0.03 }, tickMs: 50, graceMs: 300,
      activity: () => worktreeStamp(dir), activityMs: 100 });
    const r = await s.done;
    assert.match(r.stopped, /^hard limit 0\.03 min$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worktree stamp: an edit, a new file and a commit change it; nothing else does', async () => {
  const dir = gitDir();
  try {
    const a = await worktreeStamp(dir);
    assert.equal(await worktreeStamp(dir), a);
    fs.writeFileSync(path.join(dir, 'x.txt'), '1');
    const b = await worktreeStamp(dir);
    assert.notEqual(b, a);
    fs.writeFileSync(path.join(dir, 'x.txt'), '22');
    const c = await worktreeStamp(dir);
    assert.notEqual(c, b, 'a second edit of a changed file counts');
    execFileSync('git', ['-C', dir, 'add', '-A']); execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x']);
    assert.notEqual(await worktreeStamp(dir), c);
    assert.equal(await worktreeStamp(path.join(dir, 'nope')), null, 'unreadable: unknown');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worktree stamp: an edit to any changed file counts, also past the first 5,000; a spent budget is unknown', async () => {
  const dir = gitDir();
  try {
    for (let i = 0; i <= 5000; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(5, '0')}.txt`), 'x');
    const before = await worktreeStamp(dir);
    assert.ok(before);
    fs.writeFileSync(path.join(dir, 'f05000.txt'), 'xy');   // the 5,001st changed path in git's order
    assert.notEqual(await worktreeStamp(dir), before, 'an edit of the 5,001st changed file is seen');
    assert.equal(await worktreeStamp(dir, { budgetMs: 0 }), null, 'out of budget: unknown, not "no change"');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limits: a worktree that cannot be read counts as activity, so the run is not stopped as idle (the hard limit still holds)', async () => {
  const dir = gitDir();
  try {
    const s = supervise({ cmd: 'sleep', args: ['2'], cwd: dir, env: process.env, logFile: path.join(dir, '.git', 'run.log'), cardStart: Date.now(),
      limits: SHORT, tickMs: 50, graceMs: 300, activity: () => null, activityMs: 100 });
    const r = await s.done;
    assert.equal(r.stopped, '', 'unknown is not idle');
    assert.equal(r.code, 0);
    const h = supervise({ cmd: 'sleep', args: ['30'], cwd: dir, env: process.env, logFile: path.join(dir, '.git', 'run2.log'), cardStart: Date.now(),
      limits: { ...SHORT, max_min: 0.02 }, tickMs: 50, graceMs: 300, activity: () => { throw new Error('git broke'); }, activityMs: 100 });
    assert.match((await h.done).stopped, /^hard limit/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limits: a slow worktree read does not hold up the stop timer', async () => {
  const dir = gitDir();
  try {
    const t0 = Date.now();
    // The read never answers; the hard limit (1.2 s) must still stop the run on time.
    const s = supervise({ cmd: 'sleep', args: ['30'], cwd: dir, env: process.env, logFile: path.join(dir, '.git', 'run.log'), cardStart: Date.now(),
      limits: { ...SHORT, max_min: 0.02 }, tickMs: 50, graceMs: 300, activity: () => new Promise<string | null>(() => {}), activityMs: 100 });
    assert.match((await s.done).stopped, /^hard limit/);
    assert.ok(Date.now() - t0 < 5000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PR-first: a slow gh does not delay a heartbeat or a timer; repos are counted a few at a time; a hung gh is given up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-gh-'));
  try {
    const gh = path.join(dir, 'gh');
    fs.writeFileSync(gh, `#!/bin/bash\nsleep "\${FAKE_GH_SLEEP:-1}"\necho 3\n`, { mode: 0o755 });
    // A 20 ms timer (the heartbeat and the kill timers are timers like it) keeps firing while gh takes 1 s.
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    const t0 = Date.now();
    const c = await countOpenPrs(dir, gh);
    clearInterval(timer);
    assert.deepEqual(c, { ok: true, open: 3 });
    assert.ok(ticks >= 20, `timer ticks while gh ran ${Date.now() - t0} ms: ${ticks}`);
    // Four repos, 1 s each, four at a time: about 1 s, not 4.
    const repos = [0, 1, 2, 3].map((i) => { const r = path.join(dir, `r${i}`); fs.mkdirSync(r); return r; });
    const t1 = Date.now();
    const all = await countAllOpenPrs(repos, gh, { parallel: 4 });
    assert.ok(Date.now() - t1 < 2500, `in parallel: ${Date.now() - t1} ms`);
    assert.deepEqual([...all.keys()], repos);
    assert.ok([...all.values()].every((x) => x.ok && x.open === 3));
    // A gh that hangs is given up after the timeout: fails open.
    process.env.FAKE_GH_SLEEP = '30';
    const t2 = Date.now();
    const hung = await countOpenPrs(dir, gh, 300);
    assert.equal(hung.ok, false);
    assert.match((hung as any).why, /timed out/);
    assert.ok(Date.now() - t2 < 3000);
  } finally { delete process.env.FAKE_GH_SLEEP; fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- end to end: temp board, temp repo + bare remote, fake agents ----------

const FAKE_AGENT = `#!/bin/bash
# fake claude / codex: records its args; FAKE_AGENT picks the build behaviour, FAKE_REVIEW the review
me=$(basename "$0")
printf '%s\\n' "$*" >> "$FAKE_DIR/$me.args"
prompt="\${@: -1}"
case "$prompt" in
  *"cross-model reviewer"*)
    if [ "\${FAKE_REVIEW:-clean}" = p1 ]; then echo "- [P1] src/a/built.txt:1 says hi, should say hello"; echo "VERDICT: changes"; else echo "- [P3] fine"; echo "VERDICT: clean"; fi
    exit 0 ;;
  *"review of "*"found these P0/P1"*)
    echo hello > src/a/built.txt && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm "fix" && echo "RESULT: fixed"
    exit 0 ;;
  *"ended without a RESULT line"*)
    mkdir -p src/a && echo hi > src/a/built.txt && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm "card: add built.txt" && echo "RESULT: built after a nudge"
    exit 0 ;;
esac
case "\${FAKE_AGENT:-success}" in
  success) mkdir -p src/a && echo hi > src/a/built.txt && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm "card: add built.txt" && echo "RESULT: built src/a/built.txt" ;;
  nocommit) echo "thinking"; echo "RESULT: stopped the spec does not say which file" ;;
  stall) echo "waiting on a background job" ;;
  hang) sleep 300 & echo $! > "$FAKE_DIR/grandchild.pid"; wait ;;
  ratelimit) echo "API Error: 429 rate_limit_error: you have hit your usage limit" >&2; exit 1 ;;
  crash) mkdir -p src/a && echo half > src/a/built.txt && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm "card: half" && exit 3 ;;
  slowclaim) sleep 300 ;;
esac
`;
const FAKE_GH = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIR/gh.args"
case "$1 $2" in
  "pr view") exit 1 ;;
  "pr list") case "\${FAKE_PRS:-0}" in fail) echo "HTTP 401: Bad credentials" >&2; exit 1 ;; *) echo "\${FAKE_PRS:-0}" ;; esac ;;
  "pr create") echo "Creating draft pull request"; echo "https://github.com/example/proj/pull/7" ;;
  *) exit 1 ;;
esac
`;

async function world(env: Record<string, string> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-runner-'));
  const home = path.join(tmp, 'home'), fake = path.join(tmp, 'fake'), bare = path.join(tmp, 'remote.git'), proj = path.join(tmp, 'proj');
  for (const d of [home, fake, proj]) fs.mkdirSync(d, { recursive: true });
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, HOME: home } });
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(proj, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(proj, 'README.md'), '# proj\n');
  g(proj, 'add', '-A'); g(proj, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  g(proj, 'remote', 'add', 'origin', bare); g(proj, 'push', '-q', '-u', 'origin', 'main');
  const mainBefore = g(bare, 'rev-parse', 'main').trim();
  for (const t of ['claude', 'codex']) fs.writeFileSync(path.join(fake, t), FAKE_AGENT, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'gh'), FAKE_GH, { mode: 0o755 });
  if (env.NO_GITLEAKS !== '1') fs.writeFileSync(path.join(fake, 'gitleaks'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$FAKE_DIR/gitleaks.args"\nexit 0\n', { mode: 0o755 });

  const card = 'beta.t-build';
  const board = tempRepo([task({ id: card, title: 'Build me', lane: 'claude', priority: 'p1', spec_state: 'ready', body: 'touches: src/a\n\n## Context\nAdd src/a/built.txt.\n' } as any)]);
  const port = await unusedPort();
  fs.writeFileSync(path.join(board.root, 'config.json'), JSON.stringify({
    server: { hosts: ['127.0.0.1'], port }, projects: [{ id: 'beta', name: 'Beta', repo: proj }],
    runner: { enabled: true, ...(env.FAKE_AGENT === 'hang' ? { timeout_min: 0.1, max_min: 0.1 } : { timeout_min: 1, max_min: 1 }), idle_min: 0, backoff_min: 60 },
  }, null, 2));
  execFileSync('git', ['-C', board.root, 'add', '-A']); execFileSync('git', ['-C', board.root, 'commit', '-qm', 'config']);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DASKS?_|CLAUDE|CODEX)/.test(k)));
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.ts')], { env: { ...clean, HOME: home, DASKS_ROOT: board.root, DASKS_GATES: 'enforce' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout!.on('data', (d) => { srvLog += d; }); srv.stderr!.on('data', (d) => { srvLog += d; });
  const url = `http://127.0.0.1:${port}`;
  try { await until(async () => (await fetch(url + '/api/health')).ok, 15000); } catch (e) { srv.kill(); throw new Error(`board did not start: ${srvLog}`); }
  // Auth is on by default: the runner uses the stored connection, as install.sh writes it.
  const token = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'bin/dasks-tokens.ts'), 'issue', '*'], { env: { ...clean, HOME: home, DASKS_ROOT: board.root }, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(home, '.dasks/client.json'), JSON.stringify({ url, token, machine: 'testbox' }), { mode: 0o600 });
  const runEnv = { ...clean, HOME: home, PATH: `${fake}:${path.dirname(process.execPath)}:/usr/bin:/bin`, DASKS_ROOT: board.root, DASKS_RUNNER_TICK_MS: '200', FAKE_DIR: fake, ...env };
  const runner = (...args: string[]) => new Promise<{ status: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli/runner.ts'), ...args], { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout!.on('data', (d) => { out += d; }); p.stderr!.on('data', (d) => { out += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 90_000);
    p.on('exit', (status) => { clearTimeout(kill); resolve({ status, out }); });
  });
  const get = async (id = card) => (await fetch(`${url}/api/tasks/${id}`)).json();
  const read = (f: string) => { try { return fs.readFileSync(path.join(fake, f), 'utf8'); } catch { return ''; } };
  const runnerProc = (...args: string[]) => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli/runner.ts'), ...args], { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.dasks/runner/state.json'), 'utf8')); } catch { return null; } };
  return {
    card, home, proj, bare, mainBefore, runner, runnerProc, state, url, token, get, read, g,
    config: (fn: (c: any) => void) => { const f = path.join(board.root, 'config.json'); const c = JSON.parse(fs.readFileSync(f, 'utf8')); fn(c); fs.writeFileSync(f, JSON.stringify(c)); },
    stop: async () => { const done = new Promise((r) => srv.once('exit', r)); srv.kill(); await done; board.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

test('e2e success: Claude builds, Codex reviews (P1), one fix pass, branch pushed, draft PR, card in review; main untouched', async () => {
  const w = await world({ FAKE_AGENT: 'success', FAKE_REVIEW: 'p1' });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const t = await w.get();
    assert.equal(t.status, 'review', r.out);
    assert.equal(t.pr, 'https://github.com/example/proj/pull/7');
    assert.equal(t.claimed_by, '', 'handed back: nobody holds the card');
    assert.match(t.body, /claim: #runner-[0-9a-f-]{36} closed \(runner: review/);
    assert.match(w.read('gitleaks.args'), /^git --no-banner --redact --log-opts/m, 'scanned before the push');
    const gh = w.read('gh.args');
    assert.match(gh, /^pr create --draft --base main --head dasks\/beta\.t-build --title beta\.t-build: Build me --body /m);
    assert.match(gh, /P1/);
    assert.ok(!/merge/.test(gh), 'never merges');
    // The review is sent by the reviewer's own name and the claim by the builder's, so the board knows both families.
    const rows = (await (await fetch(`${w.url}/api/tasks/${w.card}/review-runs`)).json()).passes;
    assert.deepEqual([rows[0].actor, rows[0].reviewer_family, rows[0].builders, rows[0].builder_families],
      ['codex@testbox', 'openai', ['runner@testbox', 'claude@testbox'], ['', 'anthropic']]);
    const claude = w.read('claude.args');
    assert.match(claude, /^-p --session-id [0-9a-f-]{36} --permission-mode auto --output-format stream-json --verbose /m);
    assert.match(claude, /--resume/, 'the builder got one fix pass');
    assert.match(w.read('codex.args'), /^exec --sandbox read-only/m);
    assert.match(claude, /Headless run/);
    assert.match(claude, /Helpers stay read-only on the board/);
    assert.equal(w.g(w.bare, 'rev-parse', 'main').trim(), w.mainBefore, 'the default branch is never pushed');
    assert.equal(w.g(w.bare, 'show', 'dasks/beta.t-build:src/a/built.txt').trim(), 'hello');
    assert.ok(!fs.existsSync(path.join(w.home, '.dasks/worktrees/beta.t-build')), 'worktree removed after the PR');
    const st = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli/runner.ts'), '--status'], { env: { ...process.env, HOME: w.home }, encoding: 'utf8' });
    assert.match(st.stdout, /beta\.t-build {2}claude {2}review/);
    assert.match(st.stdout, /today: 1 card/);
  } finally { await w.stop(); }
});

test('e2e --once: heartbeats go on while a card builds, so a long build is never released as dead', async () => {
  const w = await world({ FAKE_AGENT: 'hang', DASKS_HEARTBEAT_MS: '300' });
  try {
    const seen = new Set<string>();
    let done = false;
    const run = w.runner('--once').finally(() => { done = true; });
    while (!done) {
      const m = (await (await fetch(`${w.url}/api/fleet`)).json()).machines[0];
      if (m && (await w.get()).claimed_by === 'runner@testbox') seen.add(m.last_seen);
      await new Promise((r) => setTimeout(r, 200));
    }
    const r = await run;
    assert.equal(r.status, 0, r.out);
    assert.ok(seen.size >= 3, `heartbeats while the card was held: ${seen.size}`);
  } finally { await w.stop(); }
});

test('e2e no commits: card released with a note naming the reason and the log, one attempt counted', async () => {
  const w = await world({ FAKE_AGENT: 'nocommit' });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const t = await w.get();
    assert.equal(t.status, 'todo', r.out);
    assert.equal(t.claimed_by, '');
    assert.match(t.body, /The runner gave the card back: no commits \(RESULT: stopped the spec does not say which file\)\. Log: .*\.dasks\/runs\/beta\.t-build-.*\.log/);
    assert.equal(t.outcomes.length, 1);
    assert.equal(t.outcomes[0].state, 'failed');
    assert.doesNotMatch(w.read('gh.args'), /^pr (create|view)/m, 'no PR');
    assert.equal(w.g(w.proj, 'branch', '--list', 'dasks/*').trim(), '', 'the empty branch is deleted');
  } finally { await w.stop(); }
});

test('e2e corrupt state: an unreadable state file is kept aside, no card starts, --status says what to do', async () => {
  const w = await world();
  try {
    const dir = path.join(w.home, '.dasks/runner');
    fs.mkdirSync(dir, { recursive: true });
    const garbage = '{"running": {"beta.t-build": {"pid": 4242, "tool": "claude"'; // cut off mid-write
    fs.writeFileSync(path.join(dir, 'state.json'), garbage);
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'));
    assert.equal(kept.length, 1, r.out);
    assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), garbage, 'kept as found');
    assert.match(r.out, /no new cards until a human resolves it/);
    const t = await w.get();
    assert.equal(t.status, 'todo'); assert.equal(t.claimed_by, '');
    assert.equal(w.read('claude.args'), '', 'no agent started');
    const st = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli/runner.ts'), '--status'], { env: { ...process.env, HOME: w.home }, encoding: 'utf8' });
    assert.match(st.stdout, /STOPPED: runner state was unreadable and is kept at .*state\.json\.corrupt-.*then delete the file/);
  } finally { await w.stop(); }
});

test('e2e nudge: a Claude build that exits 0 without a RESULT line gets one continue in its session, then goes on', async () => {
  const w = await world({ FAKE_AGENT: 'stall' });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /beta\.t-build: claude exited without a RESULT line; one nudge to continue in session [0-9a-f-]{36}/);
    const calls = w.read('claude.args').split('\n').filter((l) => l.startsWith('-p '));
    assert.equal(calls.length, 2, 'the build and one nudge');
    const session = /--session-id ([0-9a-f-]{36})/.exec(calls[0])![1];
    assert.match(calls[1], new RegExp(`^-p --resume ${session} .*ended without a RESULT line`), 'the nudge resumes the same session');
    assert.equal((await w.get()).status, 'review', r.out);
  } finally { await w.stop(); }
});

test('e2e nudge: runner.nudge false gives the card back without one', async () => {
  const w = await world({ FAKE_AGENT: 'stall' });
  w.config((c) => { c.runner.nudge = false; });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /nudge/);
    assert.equal(w.read('claude.args').split('\n').filter((l) => l.startsWith('-p ')).length, 1);
    assert.equal((await w.get()).status, 'todo');
  } finally { await w.stop(); }
});

test('e2e PR-first: a repo over runner.pr_limit starts no new card and says why; --status shows it', async () => {
  const w = await world({ FAKE_PRS: '11' });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /proj: 11 open PRs, over runner\.pr_limit 10: no new cards for this repo until some merge or close/);
    assert.match(r.out, /beta\.t-build: skipped: PR-first: 11 open PRs/);
    assert.equal(w.read('claude.args'), '', 'no build started');
    const t = await w.get();
    assert.equal(t.status, 'todo');
    assert.equal(t.claimed_by, '');
    assert.match(w.read('gh.args'), /^pr list --state open/m);
    const st = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli/runner.ts'), '--status'], { env: { ...process.env, HOME: w.home }, encoding: 'utf8' });
    assert.match(st.stdout, /held: PR-first: 11 open PRs/);
  } finally { await w.stop(); }
});

test('e2e PR-first fails open: a gh error is logged once and the card is built', async () => {
  const w = await world({ FAKE_PRS: 'fail' });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /proj: open PRs not counted \(gh pr list failed \(HTTP 401: Bad credentials\)\); PR-first limit not applied/);
    assert.equal((await w.get()).status, 'review', r.out);
  } finally { await w.stop(); }
});

test('e2e timeout: the agent and its child processes are killed, the card released, an attempt counted', async () => {
  const w = await world({ FAKE_AGENT: 'hang' });
  try {
    const t0 = Date.now();
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    assert.ok(Date.now() - t0 < 45_000, 'stopped at the limit');
    const pid = Number(w.read('grandchild.pid'));
    assert.ok(pid > 0);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
    const t = await w.get();
    assert.equal(t.status, 'todo');
    assert.equal(t.claimed_by, '');
    assert.match(t.body, /gave the card back: timeout: (card timeout|hard limit)/);
    assert.equal(t.outcomes.length, 1);
  } finally { await w.stop(); }
});

test('e2e rate limit: backoff recorded, card released, no attempt counted, the next look skips the tool', async () => {
  const w = await world({ FAKE_AGENT: 'ratelimit' });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const t = await w.get();
    assert.equal(t.status, 'todo');
    assert.equal(t.claimed_by, '');
    assert.equal(t.outcomes.length, 0, 'no attempt counted');
    assert.match(t.body, /usage or rate limit/);
    const state = JSON.parse(fs.readFileSync(path.join(w.home, '.dasks/runner/state.json'), 'utf8'));
    assert.ok(Date.parse(state.backoff.claude) > Date.now() + 50 * 60_000);
    const again = await w.runner('--once');
    assert.match(again.out, /skipped: claude backs off until/);
    assert.equal(w.read('claude.args').split('\n').filter((l) => l.startsWith('-p ')).length, 1, 'claude was not started again');
  } finally { await w.stop(); }
});

test('e2e: off unless enabled; a project without a repo is skipped with one line; one runner per Mac', async () => {
  const w = await world({ FAKE_AGENT: 'success' });
  try {
    w.config((c) => { delete c.runner.enabled; });
    const off = await w.runner('--once');
    assert.equal(off.status, 0, off.out);
    assert.match(off.out, /runner is off/);
    w.config((c) => { c.runner.enabled = true; delete c.projects[0].repo; });
    const norepo = await w.runner('--once');
    assert.equal(norepo.out.split('\n').filter((l) => l.includes('skipped: project beta has no repo')).length, 1, norepo.out);
    assert.equal(w.read('claude.args'), '', 'no agent ran');
    assert.equal((await w.get()).status, 'todo');
    fs.mkdirSync(path.join(w.home, '.dasks/runner'), { recursive: true });
    fs.writeFileSync(path.join(w.home, '.dasks/runner/lock'), String(process.pid));
    const locked = await w.runner('--once');
    assert.equal(locked.status, 1);
    assert.match(locked.out, /another runner is running on this machine \(pid \d+\)/);
  } finally { await w.stop(); }
});

test('e2e crash with commits: the attempt fails, no PR, the commits stay on the branch for the next attempt', async () => {
  const w = await world({ FAKE_AGENT: 'crash' });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const t = await w.get();
    assert.equal(t.status, 'todo', r.out);
    assert.match(t.body, /gave the card back: the agent exited 3 with 1 new commit\(s\)/);
    assert.equal(t.outcomes.length, 1);
    assert.ok(t.outcomes[0].run_id, 'the outcome names its run');
    assert.doesNotMatch(w.read('gh.args'), /^pr (create|view)/m, 'no PR for a failed attempt');
    assert.equal(w.g(w.proj, 'branch', '--list', 'dasks/*').trim(), 'dasks/beta.t-build', 'commits kept for the next attempt');
  } finally { await w.stop(); }
});

test('e2e without gitleaks: the card is built but nothing is pushed', async () => {
  const w = await world({ FAKE_AGENT: 'success', NO_GITLEAKS: '1' });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const t = await w.get();
    assert.equal(t.status, 'todo');
    assert.match(t.body, /gitleaks is not installed/);
    assert.doesNotMatch(w.read('gh.args'), /^pr (create|view)/m, 'no PR');
    assert.throws(() => w.g(w.bare, 'rev-parse', '--verify', 'dasks/beta.t-build'), 'nothing pushed');
  } finally { await w.stop(); }
});

test('e2e: the recovery record is saved right after the claim and a restart gives the card back', async () => {
  const w = await world({ FAKE_AGENT: 'slowclaim' });
  try {
    const p = w.runnerProc('--once');
    await until(() => Boolean(w.state()?.running?.['beta.t-build']?.run_id), 15000);
    const rec = w.state().running['beta.t-build'];
    assert.match(rec.job, /^runner-[0-9a-f-]{36}$/, 'a UUID job id');
    assert.equal(rec.machine, 'testbox', 'the machine name comes from the stored connection');
    assert.equal(rec.run_id, (await w.get()).run_id, 'the claim\'s run is recorded');
    p.kill('SIGKILL');
    await new Promise((r) => p.once('exit', r));
    assert.equal((await w.get()).claimed_by, 'runner@testbox');
    const again = await w.runner('--once');
    assert.match(again.out, /recovered after a runner restart/, again.out);
    const t = await w.get();
    assert.equal(t.claimed_by, '');
    assert.deepEqual(w.state().running, {});
  } finally { await w.stop(); }
});

test('e2e loop: an idle runner keeps polling until it is stopped', async () => {
  const w = await world({ FAKE_AGENT: 'success' });
  try {
    w.config((c) => { c.runner.enabled = false; });
    const p = w.runnerProc();
    let exited = false; p.once('exit', () => { exited = true; });
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(exited, false, 'still running between looks');
    p.kill('SIGTERM');
    const code = await new Promise((r) => { if (exited) r(p.exitCode); else p.once('exit', (c) => r(c)); });
    assert.equal(code, 0);
  } finally { await w.stop(); }
});

test('board: a release names its run; an older run cannot release a newer claim', async () => {
  const w = await world({ FAKE_AGENT: 'success' });
  try {
    const call = async (route: string, body: unknown, actor = 'runner@testbox') => {
      const r = await fetch(w.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor, Authorization: `Bearer ${w.token}` }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const first = await call('/api/tasks/beta.t-build/claim', { who: 'runner@testbox' });
    assert.equal(first.status, 200);
    const second = await call('/api/tasks/beta.t-build/claim', { who: 'runner@other', force: true }, 'runner@other');
    assert.notEqual(second.body.run_id, first.body.run_id);
    const stale = await call('/api/tasks/beta.t-build/release', { run_id: first.body.run_id });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.rule, 'run');
    assert.equal((await w.get()).claimed_by, 'runner@other', 'the newer claim stays');
    assert.equal((await call('/api/tasks/beta.t-build/release', { run_id: second.body.run_id }, 'runner@other')).status, 200);
  } finally { await w.stop(); }
});

test('board: an exclusive claim is refused while a card with overlapping touches is worked in the same repo', async () => {
  const w = await world({ FAKE_AGENT: 'success' });
  try {
    const call = async (route: string, body: unknown, actor: string) => {
      const r = await fetch(w.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor, Authorization: `Bearer ${w.token}` }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const made = await call('/api/tasks', { id: 'beta.t-other', goal: 'beta', title: 'Other', milestone: 'beta.m1', lane: 'claude', body: 'touches: src/a/x.ts\n' }, 'claude-code@testbox');
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await call('/api/tasks/beta.t-other/claim', { who: 'runner@two' }, 'runner@two')).status, 200);
    const refused = await call('/api/tasks/beta.t-build/claim', { who: 'runner@one', exclusive_touches: true }, 'runner@one');
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.rule, 'touches');
    assert.equal(refused.body.with, 'beta.t-other');
    assert.equal((await call('/api/tasks/beta.t-build/claim', { who: 'runner@one' }, 'runner@one')).status, 200, 'a plain claim is not checked');
  } finally { await w.stop(); }
});

test('install.sh: the runner only with --with-runner (dry run, temp HOME); uninstall names it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-inst-'));
  try {
    const env = { ...process.env, HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const sh = (script: string, ...args: string[]) => spawnSync('bash', [path.join(ROOT, script), ...args], { env, encoding: 'utf8' });
    const plain = sh('install.sh', '--dry-run', '--no-claude-mcp', '--no-codex-mcp');
    assert.equal(plain.status, 0, plain.stderr);
    // The checkout and the home folders left out (on a CI host whose user is named runner they hold the word); file names stay
    const bare = [ROOT, fs.realpathSync(home), home, os.homedir()].reduce((s, p) => s.split(p).join('<dir>'), plain.stdout);
    assert.ok(!/runner/i.test(bare), plain.stdout);
    const withRunner = sh('install.sh', '--dry-run', '--no-claude-mcp', '--no-codex-mcp', '--with-runner');
    assert.equal(withRunner.status, 0, withRunner.stderr);
    assert.match(withRunner.stdout, /dev\.dasks\.runner/);
    assert.match(withRunner.stdout, /runner\.enabled=true/);
    assert.ok(!fs.existsSync(path.join(home, 'Library')), 'a dry run writes nothing');
    const agents = path.join(home, 'Library/LaunchAgents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'dev.dasks.runner.plist'), '<plist/>');
    spawnSync('python3', [path.join(ROOT, 'scripts/installer.py'), 'record', path.join(home, '.dasks/install.json'), 'add', 'plists', path.join(agents, 'dev.dasks.runner.plist')]);
    const un = sh('uninstall.sh', '--dry-run', '--no-claude-mcp');
    assert.equal(un.status, 0, un.stderr);
    assert.match(un.stdout, /Card runner \(stopped first[\s\S]*\[dry-run\] rm -f .*dev\.dasks\.runner\.plist[\s\S]*LaunchAgent dev\.dasks\.server/, 'the runner goes before the board');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
