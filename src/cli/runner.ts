// dasks-runner: works ready cards on this machine without you. Each look takes the board's ready cards (open, unclaimed,
// deps done, spec ready), keeps those in lane claude or codex whose project has a local repo (config.json
// projects[].repo), and works each one (src/lib/run-flow.ts): claim, worktree on branch dasks/<card>, a headless build,
// a review by the other model (at most 2 passes, one fix between them), a gitleaks scan, a push and a DRAFT PR, then the card goes back
// to you in review. It never merges, never pushes the default branch and never force-pushes.
//   dasks-runner            loop: look every runner.poll_minutes
//   dasks-runner --once     one look, work at most runner.max_parallel cards, then exit
//   dasks-runner --status   on/off, current cards, today's count, backoff, last 5 results
// Settings and project checkouts come from the board's config.json on the board's Mac; on a Mac that joined a fleet
// (install.sh --join) from ~/.dasks/runner.json, which has the same `runner` and `projects` keys (DASKS_RUNNER_CONFIG
// names another file). Every look, and every minute between, it posts a heartbeat to the board (docs/fleet.md).
import fs from 'node:fs';
import path from 'node:path';
import { boardRoot, configFile } from '../lib/config.ts';
import { authHeader, boardUrl, dasksHome, machineName } from '../lib/connection.mjs';
import { cardTouches, countAllOpenPrs, emptyState, pickCards, pickSpecCards, prHolds, projectRepos, runnerConfig, startedToday, type Candidate, type PrCount, type RunnerConfig, type RunnerState, type SpecCandidate, type Tool } from '../lib/runner.ts';
import { BoardError, handBack, runCard, runSpecCard, settle, type FlowEnv, type SpecRunEnv } from '../lib/run-flow.ts';
import { familyOf } from '../lib/spec-state.ts';
import { cardHash, specCacheDir, specViewsDir } from '../lib/spec-flow.ts';
import { endGroup, type Supervised } from '../lib/supervise.ts';
import { secretGate } from '../lib/secret-gate.ts';
import { applyUpdate, mayUpdate, planUpdate } from '../lib/self-update.ts';
import { execFileSync, spawn } from 'node:child_process';

const KIT = path.resolve(import.meta.dirname, '../..');
const HOME = dasksHome();
const STATE_DIR = path.join(HOME, 'runner');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK_FILE = path.join(STATE_DIR, 'lock');
const BOARD_TIMEOUT_MS = Number(process.env.DASKS_RUNNER_BOARD_TIMEOUT_MS) || 60_000;
const ROOT = boardRoot();

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const oneLine = (s: string, n = 300) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…'; };

function runnerConfigFile(): string {
  if (process.env.DASKS_RUNNER_CONFIG) return process.env.DASKS_RUNNER_CONFIG;
  const local = path.join(HOME, 'runner.json');
  return fs.existsSync(local) ? local : configFile(ROOT);
}
function configDoc(): Record<string, unknown> {
  const f = runnerConfigFile();
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return {}; throw new Error(`config ${f}: ${e.message}`); }
}
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8')).version as string; } catch { return ''; } })();
/** The kit's commit, so `dasks fleet` can tell who is behind ('' outside a git clone). */
const COMMIT = (() => { try { return execFileSync('git', ['-C', KIT, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } })();
/** Why the last update check held, for the heartbeat and --status ('' = nothing held it). */
let updateNote = '';

/** One heartbeat: who this runner is, what it can run and what it is working now. A failure is logged once per kind. */
let beatSaid = '';
async function heartbeat(): Promise<void> {
  let cfg: RunnerConfig;
  try { cfg = runnerConfig(configDoc()); } catch { return; }
  const env = flowEnv(cfg);
  try {
    await env.api('POST', '/api/fleet/heartbeat', { machine: env.machine, harnesses: (['claude', 'codex'] as Tool[]).filter((t) => which(t)), slots: cfg.max_parallel,
      cards: Object.keys(loadState().running).sort(), version: COMMIT ? `${VERSION}+${COMMIT}` : VERSION, enabled: cfg.enabled, ...(updateNote ? { update: updateNote } : {}) });
    beatSaid = '';
  } catch (e: any) {
    const why = e instanceof BoardError ? `${e.status}` : 'unreachable';
    if (beatSaid !== why) log(`heartbeat not taken (${oneLine(e.message, 200)})`);
    beatSaid = why;
  }
}

// ---------- state + lock ----------
/** The runner's records. Missing = a fresh start. Unreadable = moved aside to state.json.corrupt-<time>, never dropped:
 *  it may name agents still running and cards still claimed. While such a file is there the runner starts no card
 *  (stateHold) until a human has looked at it and removed it. */
function loadState(): RunnerState {
  let text: string;
  try { text = fs.readFileSync(STATE_FILE, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return emptyState(); throw e; }
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object' || Array.isArray(j) || (j.running !== undefined && (typeof j.running !== 'object' || j.running === null || Array.isArray(j.running)))) throw new Error('not a state object');
    return { ...emptyState(), ...j };
  } catch (e: any) {
    const aside = `${STATE_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.renameSync(STATE_FILE, aside); log(`runner state ${STATE_FILE} is unreadable (${oneLine(e.message, 120)}): kept as ${aside}; no new cards until it is resolved`); }
    catch (r: any) { if (r.code !== 'ENOENT') throw r; } // another reader moved it a moment ago
    return emptyState();
  }
}
/** Corrupt state files kept aside, and what to do about them ('' = none: the runner may start cards). */
function stateHold(): string {
  let kept: string[] = [];
  try { kept = fs.readdirSync(STATE_DIR).filter((f) => /^state\.json\.corrupt-/.test(f)).map((f) => path.join(STATE_DIR, f)); } catch { /* no dir yet */ }
  return kept.length ? `runner state was unreadable and is kept at ${kept.join(', ')}: no new cards until a human resolves it. `
    + 'Read it, stop any agent it names that still runs, give back on the board any card it claimed (dask release <card>), then delete the file.' : '';
}
function update(fn: (s: RunnerState) => void): RunnerState {
  const s = loadState();
  fn(s);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n');
  fs.renameSync(tmp, STATE_FILE);
  return s;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };
function lockHolder(): number | null {
  try { const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()); return pid > 0 && alive(pid) ? pid : null; } catch { return null; }
}
function takeLock(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { const fd = fs.openSync(LOCK_FILE, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return; }
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      const pid = lockHolder();
      if (pid) { console.error(`dasks-runner: another runner is running on this machine (pid ${pid}); stop it first`); process.exit(1); }
      fs.rmSync(LOCK_FILE, { force: true });
    }
  }
  console.error('dasks-runner: could not take the lock ' + LOCK_FILE); process.exit(1);
}
const dropLock = () => { try { if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) fs.rmSync(LOCK_FILE); } catch { /* gone */ } };

function which(cmd: string): string | null {
  for (const d of (process.env.PATH || '').split(':')) { const p = path.join(d || '.', cmd); try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}

// ---------- board ----------
function flowEnv(cfg: RunnerConfig): FlowEnv {
  const machine = cfg.machine || machineName();
  const actor = `runner@${machine}`;
  const url = boardUrl();
  return {
    kit: KIT, runsDir: path.join(HOME, 'runs'), worktreesDir: path.join(HOME, 'worktrees'), machine, actor, boardUrl: url,
    agentEnv: { DASKS_URL: url, DASKS_MACHINE: machine },
    api: async (method, route, body, as) => {
      // A board that stops answering must not hold up the look or the heartbeat forever.
      const r = await fetch(url + route, { method, signal: AbortSignal.timeout(BOARD_TIMEOUT_MS), headers: { 'X-Dasks-Actor': as ?? actor, ...authHeader(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let j: any = text; try { j = JSON.parse(text); } catch { /* text */ }
      if (!r.ok) throw new BoardError(r.status, `${method} ${route} -> ${r.status} ${oneLine(j?.error ?? text, 300)}${j?.reasons ? ': ' + oneLine(j.reasons.join('; '), 500) : ''}`, j);
      return j;
    },
    update, log, which,
    tickMs: Number(process.env.DASKS_RUNNER_TICK_MS || 1000),
    graceMs: Number(process.env.DASKS_RUNNER_GRACE_MS || 3000),
    activityMs: Number(process.env.DASKS_RUNNER_ACTIVITY_MS || 30_000),
    stopping: () => stopping,
    track: (card, agent) => { if (agent) active.set(card, agent); else active.delete(card); },
  };
}

/** A card's text (its spec, else the board body) and its answer key's authors (Acceptance tests, Oracle). */
async function cardInfo(env: FlowEnv, id: string): Promise<{ text: string; authors: string[] }> {
  try {
    const sp = await env.api('GET', `/api/tasks/${id}/spec`);
    if (sp && typeof sp.text === 'string') return { text: sp.text, authors: [sp.section_authors?.acceptance_tests?.by, sp.section_authors?.oracle?.by].filter((x): x is string => typeof x === 'string' && !!x) };
  } catch { /* no spec */ }
  return { text: await cardText(env, id), authors: [] };
}
async function cardText(env: FlowEnv, id: string): Promise<string> {
  try { const sp = await env.api('GET', `/api/tasks/${id}/spec`); if (sp && typeof sp.text === 'string') return sp.text; } catch { /* no spec */ }
  try { return (await env.api('GET', `/api/tasks/${id}?log=0`))?.body ?? ''; } catch { return ''; }
}

// ---------- the loop ----------
const active = new Map<string, Supervised>();
const working = new Map<string, Promise<void>>();
const lastSkip = new Map<string, string>();
let stopping = false;
let disabledSaid = false;
let holdSaid = '';

/** Records whose release or hand-back the board has not confirmed yet (and no run of ours is working them). */
async function retryPending(env: FlowEnv): Promise<void> {
  for (const [card, r] of Object.entries(loadState().running)) {
    if (working.has(card) || (!r.pending && !r.handback)) continue;
    if (r.handback) await handBack(env, card, r, r.handback.pr, r.handback.title, r.handback.summary, r.handback.review_note, r.handback.open, r.handback.blocked, r.handback.skipped);
    else await settle(env, card, r, r.pending!.reason, r.pending!.count);
  }
}

/** PR-first: count the open PRs of each repo that has a card to start; a repo over runner.pr_limit is held. A count that
 *  fails (no gh, not logged in, no GitHub remote) holds nothing; it is logged once until the reason changes. */
const prSaid = new Map<string, string>();
async function prFirst(cfg: RunnerConfig, cands: Candidate[], repos: Map<string, string>): Promise<Map<string, string>> {
  if (cfg.pr_limit <= 0) return new Map();
  const want = [...new Set(cands.filter((c) => c.lane === 'claude' || c.lane === 'codex').map((c) => repos.get(c.goal)).filter((r): r is string => !!r))];
  // Async and a few at a time: kill timers and heartbeats keep running while gh is slow.
  const counts: Map<string, PrCount> = await countAllOpenPrs(want, which('gh'), { timeoutMs: Number(process.env.DASKS_PR_COUNT_TIMEOUT_MS) || undefined });
  for (const [repo, c] of counts) {
    const said = c.ok ? (c.open > cfg.pr_limit ? `over ${c.open}` : 'under') : `fail ${c.why}`;
    if (prSaid.get(repo) === said) continue;
    if (!c.ok) log(`${repo}: open PRs not counted (${c.why}); PR-first limit not applied`);
    else if (c.open > cfg.pr_limit) log(`${repo}: ${c.open} open PRs, over runner.pr_limit ${cfg.pr_limit}: no new cards for this repo until some merge or close`);
    else if (prSaid.get(repo)?.startsWith('over')) log(`${repo}: ${c.open} open PRs, within runner.pr_limit ${cfg.pr_limit} again: new cards start`);
    prSaid.set(repo, said);
  }
  return prHolds(counts, cfg.pr_limit);
}

async function look(): Promise<void> {
  await heartbeat();
  const doc = configDoc();
  const cfg = runnerConfig(doc);
  const env = flowEnv(cfg);
  await retryPending(env);
  const hold = stateHold();
  if (hold) { if (holdSaid !== hold) log(hold); holdSaid = hold; return; }
  holdSaid = '';
  if (!cfg.enabled) { if (!disabledSaid) log('runner is off (config.json runner.enabled is false); nothing to do'); disabledSaid = true; return; }
  disabledSaid = false;
  const repos = projectRepos(doc);
  // The whole queue (open, unclaimed, deps done): ready specs are built, the rest may get a spec (runner.spec).
  const queue: any[] = (await env.api('GET', '/api/ready?all=1')).ready ?? [];
  const ready = queue.filter((r) => r.spec_state === 'ready');
  const tools = new Set<Tool>((['claude', 'codex'] as Tool[]).filter((t) => which(t)));
  const cands: Candidate[] = [];
  const titles = new Map<string, string>();
  for (const r of ready) {
    titles.set(r.id, r.title ?? '');
    const eligible = (r.lane === 'claude' || r.lane === 'codex') && repos.has(r.goal);
    const info = eligible ? await cardInfo(env, r.id) : { text: '', authors: [] };
    cands.push({ id: r.id, goal: r.goal, lane: r.lane, priority: r.priority, spec_state: r.spec_state, spec_by: r.spec_by ?? null, answer_key_by: info.authors, kind: r.kind, pushed: !!r.pushed, touches: eligible ? cardTouches(info.text) : [] });
  }
  const specQueue = cfg.spec ? queue.filter((r) => (r.spec_state === 'none' || r.spec_state === 'draft') && (r.lane === 'claude' || r.lane === 'codex') && repos.has(r.goal)) : [];
  const held = await prFirst(cfg, [...cands, ...specQueue.map((r) => ({ id: r.id, goal: r.goal, lane: r.lane, priority: r.priority, touches: [] }))], repos);
  update((s) => { s.held = Object.fromEntries(held); });
  // Read after the PR counts: a card may have finished while gh answered.
  const state = loadState();
  const now = new Date();
  for (const [tool, until] of Object.entries(state.backoff)) if (until && Date.parse(until) <= now.getTime()) delete state.backoff[tool as Tool];
  const running = Object.entries(state.running).map(([card, r]) => ({ card, tool: r.tool, repo: r.repo, touches: r.touches }));
  const { picked, skipped } = pickCards({ ready: cands, running, cfg, startedToday: startedToday(state, now), tools, backoff: state.backoff, repos, now, held, machine: env.machine });
  for (const s of skipped) if (lastSkip.get(s.card) !== s.why) { lastSkip.set(s.card, s.why); log(`${s.card}: skipped: ${s.why}`); }
  let started = 0;
  for (const p of picked) {
    if (!fs.existsSync(path.join(p.repo, '.git'))) { const why = `repo ${p.repo} is not a git checkout`; if (lastSkip.get(p.card) !== why) { lastSkip.set(p.card, why); log(`${p.card}: skipped: ${why}`); } continue; }
    const secrets = await secretGate(env, p.card, p.tool);   // a card whose secrets are not ready is not started (docs/secrets.md)
    if (secrets) { if (lastSkip.get(p.card) !== secrets) { lastSkip.set(p.card, secrets); log(`${p.card}: skipped: ${secrets}`); } continue; }
    lastSkip.delete(p.card);
    started++;
    const job = runCard(env, p, cfg, titles.get(p.card) ?? '').catch((e) => log(`${p.card}: run failed: ${e?.stack || e}`)).finally(() => working.delete(p.card));
    working.set(p.card, job);
  }
  // The spec pass: only when no ready card started this look (docs/specs.md).
  if (!cfg.spec || started > 0 || !specQueue.length) return;
  const families = familiesOf(doc);
  const specCands: SpecCandidate[] = [];
  for (const r of specQueue) {
    let reviewed = false, authorFamily: string | null = null, hash = '';
    try {
      const t = await env.api('GET', `/api/tasks/${r.id}?log=0`);
      const sp = r.spec_state === 'draft' ? await env.api('GET', `/api/tasks/${r.id}/spec`) : null;
      if (sp) {
        reviewed = !!t?.spec_review && Number(t.spec_review.spec_version) === Number(sp?.metadata?.version);
        const by = sp.section_authors?.acceptance_tests?.by ?? sp.metadata?.by ?? '';
        authorFamily = by ? familyOf(by, families) : null;
      }
      hash = cardHash(t?.title ?? '', t?.body ?? '', Number(sp?.metadata?.version ?? 0));
    } catch { continue; }
    const failed = state.spec_failures?.[r.id];
    titles.set(r.id, r.title ?? '');
    specCands.push({ id: r.id, goal: r.goal, lane: r.lane, priority: r.priority, spec_state: r.spec_state, reviewed, authorFamily, hash, failures: failed && failed.hash === hash ? failed.count : 0 });
  }
  const after = loadState();
  const toolFamily = { claude: familyOf(`claude@${env.machine}`, families), codex: familyOf(`codex@${env.machine}`, families) };
  const sp = pickSpecCards({ cands: specCands, running: Object.keys(after.running).map((card) => ({ card })), cfg, startedToday: startedToday(after, now), tools, backoff: after.backoff, repos, now, held, toolFamily });
  for (const s of sp.skipped) if (lastSkip.get(s.card) !== s.why) { lastSkip.set(s.card, s.why); log(`${s.card}: skipped: ${s.why}`); }
  const senv: SpecRunEnv = { ...env, viewsDir: specViewsDir(HOME), cacheDir: specCacheDir(HOME), families };
  for (const p of sp.picked) {
    lastSkip.delete(p.card);
    const job = runSpecCard(senv, p, cfg, titles.get(p.card) ?? '').catch((e) => log(`${p.card}: spec run failed: ${e?.stack || e}`)).finally(() => working.delete(p.card));
    working.set(p.card, job);
  }
}

/** config.json `families` (actor or prefix* → model family), {} when absent or malformed (the board checks it). */
function familiesOf(doc: Record<string, unknown>): Record<string, string> {
  const f = doc.families;
  return f && typeof f === 'object' && !Array.isArray(f) ? Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
}

// ---------- self-update ----------
const joined = () => runnerConfigFile() === path.join(HOME, 'runner.json');
const updateOn = (cfg: RunnerConfig) => cfg.update ?? joined();
const busy = () => working.size + active.size + Object.keys(loadState().running).length;
let updateSaid = '';
/** An update left the kit without its dependencies: no further update tries until a human restored them (a restart). */
let updateStuck = '';
/** Between cards: is the kit behind its remote, and may it move? true = updated, the caller restarts. Never while a card
 *  runs. A hold is logged once per reason, kept in the state file (dask runner status) and sent with the heartbeat. */
async function selfUpdate(cfg: RunnerConfig): Promise<boolean> {
  if (!mayUpdate({ update: cfg.update, joined: joined(), busy: busy(), stopping })) return false;
  if (updateStuck) return false;
  let schema: number | null = null;
  try { const r = await fetch(boardUrl() + '/api/health', { signal: AbortSignal.timeout(BOARD_TIMEOUT_MS) }); schema = Number(((await r.json()) as any)?.schema?.version); if (!Number.isInteger(schema)) schema = null; } catch { schema = null; }
  const plan = await planUpdate(KIT, schema);
  const note = (n: string) => {
    updateNote = n.slice(0, 280);
    if (updateSaid !== n && n) log(`self-update: ${n}`);
    updateSaid = n;
    update((s) => { if (n) s.update = { at: new Date().toISOString(), note: n }; else delete s.update; });
  };
  if (plan.action === 'none') { note(''); return false; }
  if (plan.action === 'hold') { note(plan.reason); return false; }
  if (!mayUpdate({ update: cfg.update, joined: joined(), busy: busy(), stopping })) return false; // a card started while git fetched
  log(`self-update: ${plan.reason}; updating`);
  const npm = [path.join(path.dirname(process.execPath), 'npm'), which('npm')].find((p) => p && fs.existsSync(p)) ?? 'npm';
  const r = await applyUpdate(KIT, plan, npm);
  if (!r.ok) { if (r.stuck) updateStuck = r.reason; note(`update failed: ${r.reason}`); return false; }
  note('');
  log(`self-update: ${r.reason}; restarting`);
  return true;
}
/** Start the new code: under the LaunchAgent (KeepAlive starts it again) by exiting; run by hand, by starting a copy of
 *  this process first. */
function restart(): never {
  dropLock();
  if (process.env.XPC_SERVICE_NAME !== 'dev.dasks.runner') {
    spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { detached: true, stdio: 'inherit' }).unref();
  }
  process.exit(0);
}

/** A previous runner that died left records: stop what it started and give those cards back (or finish the hand-back). */
async function recover(): Promise<void> {
  const cfg = runnerConfig(configDoc());
  const env = flowEnv(cfg);
  for (const [card, r] of Object.entries(loadState().running)) {
    if (r.pid > 0) await endGroup(r.pid, env.graceMs);
    const ok = r.handback
      ? await handBack(env, card, r, r.handback.pr, r.handback.title, r.handback.summary, r.handback.review_note, r.handback.open, r.handback.blocked, r.handback.skipped)
      : await settle(env, card, r, r.pending?.reason ?? 'the runner restarted mid-run', r.pending?.count ?? false);
    if (ok) log(`${card}: recovered after a runner restart`);
  }
}

function status(): void {
  let cfg: RunnerConfig | null = null, err = '';
  try { cfg = runnerConfig(configDoc()); } catch (e: any) { err = e.message; }
  const s = loadState(), pid = lockHolder(), now = new Date();
  console.log(`runner: ${cfg ? (cfg.enabled ? 'on' : 'off') : `config error: ${err}`}; process: ${pid ? `running (pid ${pid})` : 'not running'}; acts as runner@${cfg?.machine || machineName()}; board ${boardUrl()}; settings ${runnerConfigFile()}`);
  const run = Object.entries(s.running);
  console.log(`current: ${run.length ? run.map(([c, r]) => `${c} (${r.tool}, ${r.phase}${r.pending ? ', release pending' : ''}, since ${r.since}, log ${r.log})`).join('; ') : 'none'}`);
  console.log(`today: ${startedToday(s, now)} card(s) started${cfg ? ` of ${cfg.daily_cap}` : ''}`);
  const bo = Object.entries(s.backoff).filter(([, u]) => u && Date.parse(u) > now.getTime());
  console.log(`backoff: ${bo.length ? bo.map(([t, u]) => `${t} until ${u}`).join('; ') : 'none'}`);
  const held = Object.values(s.held ?? {});
  console.log(`held: ${held.length ? held.join('; ') : 'none'}`);
  const hold = stateHold();
  if (hold) console.log(`STOPPED: ${hold}`);
  console.log(`kit: ${VERSION}${COMMIT ? ` (${COMMIT})` : ''}; self-update ${cfg ? (updateOn(cfg) ? 'on' : 'off') : '?'}${s.update?.note ? `; held: ${s.update.note} (${s.update.at})` : ''}`);
  console.log('last results:');
  const last = s.history.slice(-5).reverse();
  for (const h of last) console.log(`  ${h.ended}  ${h.card}  ${h.tool}  ${h.outcome}  ${h.detail}${h.pr ? `  ${h.pr}` : ''}`);
  if (!last.length) console.log('  (none)');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) { console.log(fs.readFileSync(import.meta.filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  if (argv.includes('--status')) { status(); return; }
  const unknown = argv.filter((a) => a !== '--once');
  if (unknown.length) { console.error(`dasks-runner: unknown option ${unknown[0]} (--once, --status, --help)`); process.exit(2); }
  runnerConfig(configDoc());   // a bad config stops here, before the lock
  takeLock();
  process.on('exit', dropLock);
  let wake: (() => void) | null = null;
  const onSignal = (sig: string) => {
    if (stopping) return; stopping = true;
    log(`${sig}: stopping; ${active.size} agent(s) to stop, their cards are given back`);
    for (const a of active.values()) a.stop('runner stopped');
    wake?.();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  await recover();
  // Heartbeats in both modes, until every card is done: a --once build longer than fleet.dead_min is still alive.
  const beats = setInterval(() => { void heartbeat(); }, Number(process.env.DASKS_HEARTBEAT_MS) || 60_000);
  beats.unref();
  if (argv.includes('--once')) {
    await look();
    await Promise.all([...working.values()]);
    clearInterval(beats);
    return;
  }
  log(`runner started; board ${boardUrl()}; settings ${runnerConfigFile()}`);
  while (!stopping) {
    try { await look(); } catch (e: any) { log(`look failed: ${e.message}`); }
    const cfg = (() => { try { return runnerConfig(configDoc()); } catch { return null; } })();
    if (cfg && await selfUpdate(cfg).catch((e) => { log(`self-update failed: ${e?.message || e}`); return false; })) { clearInterval(beats); restart(); }
    // A referenced timer: an idle runner must stay alive until its next look (a SIGTERM wakes it early).
    await new Promise<void>((r) => { wake = r; setTimeout(r, (cfg?.poll_minutes ?? 10) * 60000); });
    wake = null;
  }
  clearInterval(beats);
  await Promise.all([...working.values()]);
}

main().then(() => process.exit(0), (e) => { console.error(`dasks-runner: ${e?.message || e}`); process.exit(1); });
