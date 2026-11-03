// Dasks server: thin HTTP API + static UI over data/, SSE live reload.
// Per-project pages at /p/<project> (one per goal), laid out by data/views/<project>.json (agents write it via
// /api/views/<project>), with the project's "Ideas for later" from data/ideas/<project>.json (/api/ideas/<project>) and its
// lessons from data/lessons/<project>.json (/api/lessons/<project>; a task read carries the relevant ones).
// Binds 127.0.0.1, plus one network address only when server.listen (or --listen) names one (docs/fleet.md): then agent
// tokens must be enforced and every request on that address needs a machine token or the human's login.
import { allOutcomes, recordOutcome, resetAttempts, taskOutcomes, handoffOf, decisionsToday, jobEndRel, runOutcome } from './lib/outcome.ts';
import { jobOutcomes, recordJobOutcome } from './lib/job-outcome.ts';
import { readyQueue } from './lib/ready.ts';
import { stuckReport } from './lib/stuck.ts';
import { laneList, lanesKey } from './lib/lanes.ts';
import { taskEvidence } from './lib/transitions.ts';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, loadGoals, loadStats, reloadTaskFiles } from './lib/load.ts';
import { check } from './lib/check.ts';
import { rollup } from './lib/rollup.ts';
import { boardRoot, expandHome, intakeConfigErrors, isAllowedBindHost, isLoopback, isWildcard, loadConfig } from './lib/config.ts';
import { deadRunnerCards, Fleet, kitCommitOf, parseHeartbeat } from './lib/fleet.ts';
import { Backup, backupView, remoteShown } from './lib/backup.ts';
import { buildSummary, readSummary, saveSummary, summaryDue } from './lib/summary.ts';
import { buildTriage } from './lib/triage.ts';
import { PrStatusCache } from './lib/pr-status.ts';
import { machineName } from './lib/connection.mjs';
import { execFileSync } from 'node:child_process';
import { CaptainChat, CaptainLease } from './lib/captain.ts';
import { intakeReport } from './lib/intake.ts';
import { digestText } from './lib/digest.ts';
import { capFile } from './lib/file-cap.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { acceptsGzip, etagMatches, filterTaskList, pageTasks, parseTaskQuery, projectTask } from './lib/task-reads.ts';
import { corruptJournalHelp, corruptJournals, createTaskOrIdea, type CreateOpts, git, HttpError, isOwnEcho, lastCommitted, committedSinceReload, readTask, recoverRepo, sanitizeActor, updateNode, updateTask, type UpdateOpts, commitFiles, withRepoLock } from './lib/write.ts';
import { localDate } from './lib/rollup.ts';
import { pickContext, readActivity } from './lib/collab.ts';
import { holderSeenAt } from './lib/lease.ts';
import { type Board, type Task, ACTOR_RE, goalIdsOf, isTaskId, cardOwner } from './lib/schema.ts';
import { assertProject, projectIds, milestonesOf, readView, readViewActivity, viewSummaries, writeView } from './lib/views.ts';
import { filterMessages, parseFilter, parseTimeout, participants, postMessage, readMessages, ROLES as MSG_ROLES, touch, waitMessages } from './lib/messages.ts'; // card messages (informational; no gate reads them)
import { addLesson, DEFAULT_RELEVANT, LESSON_STATUSES, lessonFiles, MAX_TASK_FILES, lessonSummaries, readLessons, relevantLessons, taskFiles, updateLesson } from './lib/lessons.ts';
import { addIdea, ideaSummaries, IDEA_STATUSES, promoteIdea, readIdeaActivity, readIdeas, updateIdea } from './lib/ideas.ts';
import { type Authenticator, cookieHeader, LoginLimiter, loadKey, PassphraseAuth, passphraseFile, requireHuman, sameOrigin, secretsDir, sessionCookie, Sessions, sessionTtlMs, UNSAFE_OWN_PASSPHRASE } from './lib/auth.ts';
import { type AuthReason, bearerOf, checkToken, TokenStore, tokenStoreConfig, tokenStoreReport } from './lib/auth.ts';
import { appendDecision, CHOICES, type Decision, decisionRequest, entryId, findDecision, ledgerPath, readLedger, sha256, verifiedEntries, WITNESS_REL, witnessContent, witnessProblem } from './lib/decisions.ts';
import { mergeOkAt, SHA40_RE } from './lib/merge-ok.ts';
import { assertSpecSize, parseSpecPut, parseVersionParam, readSpec, SPEC_MAX_BODY, writeSpec } from './lib/specs.ts';
import { appendReviewRun, parseReviewRun, readReviewRuns, REVIEW_RUN_MAX_BODY } from './lib/review-runs.ts';
import { cardsWithMessages, moveCursor, readCursor, startText } from './lib/start.ts';
import { blockSpec, committedSpecIndex, headSha, reviewSpec, type SpecIndex, unblockSpec } from './lib/spec-state.ts';
import { DS_FILE_RE, MIME, STATIC } from './lib/server-static.ts';
import { applyAnswer, type Ask, askLive, askRequest, asksLedgerPath, checkAnswer, createAsk, openAsks, readAsks } from './lib/asks.ts';
import { unpark } from './lib/park.ts';
import { checkAsk } from './lib/ask-rule.ts';
import { askLines, askText, askTitle, conflictsSection, pickAsk, validateAsk } from '../public/user-ask.js';
import { itemsProgress, itemsView, reportItem, seedItems } from './lib/items.ts';
import { assertTouchesFree, repoKey } from './lib/claim-guard.ts';
import { migrateBoard, SchemaTooNew, SCHEMA_VERSION } from './lib/migrate.ts';
import { type Body, parseAnswer, parseCardAction, parseChat, parseLease, parseLeaseCheck, parseNodePatch, parseOutcomeOrFail, parseResetAttempts, parseTaskPatch, versionOf } from './lib/bodies.ts';

const ROOT = boardRoot();
const cfg = loadConfig(ROOT);
{
  const i = process.argv.indexOf('--listen');
  const listen = i > 0 ? process.argv[i + 1] : process.env.DASKS_LISTEN;
  if (listen !== undefined && listen !== '') {
    if (!net.isIP(listen)) { console.error(`--listen must be an IP address (got ${JSON.stringify(listen)})`); process.exit(2); }
    cfg.server.listen = listen;
  }
}
/** Test only: serve server.listen as a network address even when it is loopback (::1), so tests never open a real port. */
const LISTEN_AS_NETWORK = process.env.DASKS_TEST_LISTEN_AS_NETWORK === '1';
const NETWORK = LISTEN_AS_NETWORK || !isLoopback(cfg.server.listen);
if (NETWORK && cfg.auth.mode !== 'enforce') {
  console.error(`refusing to start: serving ${cfg.server.listen} (beyond this Mac) needs auth.mode "enforce" (it is "${cfg.auth.mode}"). Every machine then writes with its own token (dasks machine add <name>).`);
  process.exit(1);
}
// Beyond this Mac, tokens, the passphrase and every card cross the network: TLS, unless the owner said plainly not to.
if (!isLoopback(cfg.server.listen) && !cfg.server.tls && !cfg.server.allow_plain_http) {
  console.error(`refusing to start: serving ${cfg.server.listen} (beyond this Mac) needs TLS: set server.tls {"cert", "key"} in config.json (install.sh --tls-cert F --tls-key F). To send tokens and the passphrase in clear anyway (unsafe), set server.allow_plain_http: true.`);
  process.exit(1);
}
/** Certificate and key when server.tls is set: every listener is HTTPS then (loopback too). Read once, at start. */
const TLS = (() => {
  if (!cfg.server.tls) return null;
  try { return { cert: fs.readFileSync(expandHome(cfg.server.tls.cert)), key: fs.readFileSync(expandHome(cfg.server.tls.key)) }; }
  catch (e: any) { console.error(`refusing to start: server.tls: ${e.code === 'ENOENT' ? `no file ${e.path}` : e.message}`); process.exit(1); }
})();
const SCHEME = TLS ? 'https' : 'http';
// intake.goal_limits keys must be goals of this board (data/goals): refused at startup like any other config error.
for (const e of intakeConfigErrors(cfg.intake, goalIdsOf(loadGoals(ROOT)))) throw new Error(`config: ${e}`);
// Code (UI, client files) comes from this checkout; data comes from DASKS_ROOT (a test copy can point elsewhere).
const CODE = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(CODE, 'public');
const MAX_BODY = 64 * 1024;
let boardCache: { key: string; body: Record<string, any> } | null = null;
let digestCache: { key: string; text: string } | null = null;
const headOf = () => { try { return git(ROOT, ['rev-parse', 'HEAD']).trim(); } catch { return ''; } };

// ---------- human login + decision ledger (docs/auth.md) ----------
// Sessions live only in this process's memory (auth.ts). The ledger key lives outside the repo, loaded on first use by a
// human route, so a board that only serves agents (and every test server) never creates key files. If it cannot be read
// the board keeps serving agents, but every human route (login, "user" writes, decisions) answers 503 instead of opening up.
let secrets: { sessions: Sessions; ledgerKey: Buffer } | null = null;
function humanSecrets(): { sessions: Sessions; ledgerKey: Buffer } | null {
  if (secrets) return secrets;
  try {
    secrets = { sessions: new Sessions(sessionTtlMs()), ledgerKey: loadKey(secretsDir(), 'ledger.key') };
  } catch (e: any) { console.error(`human login unavailable: ${e.message}`); }
  return secrets;
}
const sessionsOrNull = () => humanSecrets()?.sessions ?? null;
const authenticators: Authenticator[] = [new PassphraseAuth(passphraseFile())];
if (process.env[UNSAFE_OWN_PASSPHRASE] === '1') console.error(`WARNING: ${UNSAFE_OWN_PASSPHRASE}=1: login trusts a passphrase file this account can write (tests only)`);
// SIGUSR1 would open the Node inspector: any process of this account could then run code inside the server and act as
// the human without a passphrase. A listener turns that off.
process.on('SIGUSR1', () => console.error('SIGUSR1 ignored (the inspector stays off)'));
const loginLimiter = new LoginLimiter();
const LEDGER = ledgerPath(ROOT);

// ---------- board cache + live reload ----------
// A crash between writing a file and committing it leaves staged paths, stray temp files or a stale index.lock that would
// make every later write fail: tidy that up (and say so loudly) before serving.
for (const line of recoverRepo(ROOT)) console.error(`recovery: ${line}`);
/** '' = the board's files follow this kit's schema. A board newer than the kit is not served at all. */
let schemaProblem = '';
try {
  const m = migrateBoard(ROOT);
  if (m.applied.length) console.error(`migrate: board schema ${m.from} -> ${m.to} (${m.applied.join('; ')}); backup before it: ${m.backup}`);
} catch (e: any) {
  if (e instanceof SchemaTooNew) { console.error(`dasks: ${e.message}`); process.exit(1); }
  schemaProblem = String(e.message).split('\n')[0]; console.error(`migrate: the board was not migrated (${schemaProblem}); /api/health is not ready until it is`); }
let board: Board = loadBoard(ROOT);
/** Spec state per task for the read routes, from one pinned commit (lib/spec-state.ts committedSpecIndex). */
let specIndex: SpecIndex = { head: '', facts: new Map() };
/** Why the last rebuild failed ('' = the index is current). Read routes keep serving the last good index meanwhile;
 *  claims and spec writes answer 503 until a rebuild succeeds. */
let specIndexFailed = '';
/** Back-off while a rebuild fails: the HEAD last TRIED (with a broken
 *  HEAD `headSha` is '' every time, so the last GOOD head can't tell a change), the earliest next try, and every
 *  committedSpecIndex call (reported on /api/health, so the back-off is measured from outside). */
let lastTriedHead = '';
let nextRetryAt = 0;
let specIndexAttempts = 0;
/** Rebuild it when HEAD moved (a ref-file read, no git process): an external commit touches no data/ file. While a
 *  rebuild fails, try again only when forced (the write guard), when HEAD moved since the last try, or after 1 s. */
function refreshSpecIndex(force = false): boolean {
  const head = headSha(ROOT);
  if (!specIndexFailed) { if (head && head === specIndex.head) return false; }
  else if (!force && head === lastTriedHead && Date.now() < nextRetryAt) return false;
  lastTriedHead = head; specIndexAttempts++;
  try { specIndex = committedSpecIndex(ROOT, head); specIndexFailed = ''; nextRetryAt = 0; return true; }
  catch (e: any) {
    const why = String(e?.message ?? e).split('\n')[0];
    if (why !== specIndexFailed) console.error(`spec index rebuild failed (serving the last good index for reads): ${why}`);
    specIndexFailed = why; nextRetryAt = Date.now() + 1000; return false;
  }
}
/** Claims and spec writes wait for a spec index that matches HEAD: 503 with Retry-After, after the route's own 400/404.
 *  While failed, one forced rebuild first, so a write recovers on the first request after the repo is healthy again. */
function specIndexGuard(res: http.ServerResponse): () => void {
  return () => {
    if (!specIndexFailed) return;
    if (refreshSpecIndex(true)) { version++; announce(); return; }
    void res; // the error handler sets Retry-After from retry_after
    throw new HttpError(503, `the board can't read its committed spec state right now (${specIndexFailed}); retry in a moment`, { retry_after: 5, rule: 'spec-index' });
  };
}
refreshSpecIndex(); // the first build (a failure leaves an empty index: reads show none, writes wait)
let version = 1;
/** Changes with every start: a client that sees a new boot id after reconnecting reloads (it may have missed changes). */
const BOOT = randomBytes(4).toString('hex');
const clients = new Set<http.ServerResponse>();
const MAX_LISTENERS = 128;

/** Full and incremental reloads since start (the startup load is not counted); reported on /api/health. */
const reloadStats = { full: 0, incremental: 0 };
function reload() {
  try {
    board = loadBoard(ROOT); committedSinceReload.clear(); reloadStats.full++;
    refreshSpecIndex(); version++;
  } catch (e) { console.error('reload failed', e); return; }
  announce();
}
/** Re-read only these repo-relative files (lib/load.ts reloadTaskFiles). false = they need a full reload, not done here;
 *  true = the board is current (incrementally, or by a full reload after an unexpected error). */
function reloadFiles(rels: string[]): boolean {
  let next: Board | null = null;
  try { next = reloadTaskFiles(ROOT, board, rels); } catch { next = null; }
  if (!next) return false;
  try {
    board = next;
    for (const f of rels) committedSinceReload.delete(f);
    reloadStats.incremental++;
    refreshSpecIndex(); version++; announce();
  } catch (e) { console.error('incremental reload failed; reloading the whole board', e); reload(); }
  return true;
}
/** Tell the open pages something changed (a reload, or a commit that moved HEAD: the spec facts changed). */
function announce() {
  const msg = `event: change\ndata: ${JSON.stringify({ version, boot: BOOT })}\n\n`;
  for (const c of clients) c.write(msg);
}
let reloadTimer: NodeJS.Timeout | null = null;
/** Files the watcher reported since the last reload (relative to data/; null = unknown, e.g. the platform gave no name). */
let pending: Set<string> | null = new Set();
/** After a write: re-read the files this server committed. The watcher's queue is left alone there, so a hand edit it
 *  already reported still arrives; a full reload covers the queue too. */
function reloadAfterWrite() { if (!reloadFiles([...committedSinceReload])) { reload(); pending = new Set(); } }
/** Test-only (DASKS_RELOAD_GATE names a file): while that file exists the watcher holds its reload, keeping the reported
 *  files, so a test can read the board while it still holds a working-tree write. No effect when unset or absent. */
const RELOAD_GATE = process.env.DASKS_RELOAD_GATE || '';
function scheduleReload(file: string | null) {
  if (pending) { if (file) pending.add(`data/${file.split(path.sep).join('/')}`); else pending = null; }
  armReload(150);
}
/** The debounce restarts on every event, but never past this: constant events (an append every 100 ms) would otherwise
 *  hold a hand edit back until the 10-minute full reload. */
const RELOAD_MAX_WAIT_MS = 1000;
let reloadArmedAt = 0;
function armReload(delay: number) {
  if (reloadTimer && Date.now() - reloadArmedAt >= RELOAD_MAX_WAIT_MS) return;
  if (reloadTimer) clearTimeout(reloadTimer); else reloadArmedAt = Date.now();
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (RELOAD_GATE && fs.existsSync(RELOAD_GATE)) return armReload(50);
    const files = pending; pending = new Set();
    // The watcher also reports our own writes, already reloaded: skip that echo only when every reported file is one this
    // server just committed. Anything else (a hand edit, another process's commit) reloads.
    if (files && files.size && Date.now() - lastCommitted.at < 2000 && [...files].every((f) => isOwnEcho(ROOT, f))) return;
    if (files && files.size && reloadFiles([...files])) return;
    reload(); // no file names (files null), or a file that needs the whole board
  }, delay);
}
// A full reload every 10 minutes too: a lost file event must not leave a card stale until the next restart.
setInterval(reload, 10 * 60_000).unref();
try {
  fs.watch(path.join(ROOT, 'data'), { recursive: true }, (_e, f) => {
    if (f && (String(f).endsWith('.tmp') || String(f).includes('/.') || String(f).startsWith(`decisions${path.sep}`))) return;
    scheduleReload(f ? String(f) : null);
  });
} catch (e) { console.error('file watcher unavailable; falling back to polling', e); setInterval(reload, 5000); }
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000).unref();

// ---------- fleet and captain (docs/fleet.md, docs/captain.md) ----------
const fleet = new Fleet(ROOT);
const lease = new CaptainLease(ROOT);
const chat = new CaptainChat(ROOT);
/** Cards a quiet runner holds go back to the pool, with a note, so another machine can take them. A runner that comes
 *  back finds its card on no run of its own and gives up on it (its release names the old run). */
function releaseDeadRunners() {
  const quiet = new Set(fleet.list(cfg.fleet.dead_min).filter((m) => m.quiet).map((m) => m.machine));
  if (!quiet.size) return;
  let changed = false;
  for (const { id, machine } of deadRunnerCards(board.tasks, quiet)) {
    try {
      const seen = fleet.get(machine)?.last_seen ?? '';
      withRepoLock(ROOT, () => updateTask(ROOT, id, {}, 'board', { claim: { op: 'release', who: 'board', force: true }, action: 'release',
        appendNote: `claim: released by the board: runner@${machine} sent no heartbeat for ${cfg.fleet.dead_min} min (last seen ${seen}); the card is free for another machine`, warnings: [], staleHours: cfg.stale_hours }));
      console.error(`fleet: ${machine} is quiet; released ${id}`);
      changed = true;
    } catch (e: any) { console.error(`fleet: could not release ${id} of quiet ${machine}: ${e.message}`); }
  }
  if (changed) reloadAfterWrite();
}
setInterval(releaseDeadRunners, Math.max(1000, Math.min(60_000, cfg.fleet.dead_min * 60_000 / 3))).unref();

/** This board's kit commit, and whether a runner's kit commit is behind it (an ancestor of it): true, false, or null
 *  when this kit does not know that commit (the runner is ahead, or not on a git clone). Read once per commit. */
const kitGit = (args: string[]) => execFileSync('git', ['-C', CODE, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const KIT_COMMIT = (() => { try { return kitGit(['rev-parse', 'HEAD']); } catch { return ''; } })();
const behindCache = new Map<string, boolean | null>();
function behindOf(version: string): boolean | null {
  const c = kitCommitOf(version);
  if (!c || !KIT_COMMIT) return null;
  if (KIT_COMMIT.startsWith(c)) return false;
  if (!behindCache.has(c)) {
    let v: boolean | null = null;
    try { kitGit(['cat-file', '-e', `${c}^{commit}`]); try { kitGit(['merge-base', '--is-ancestor', c, KIT_COMMIT]); v = true; } catch { v = false; } } catch { v = null; }
    if (behindCache.size > 500) behindCache.clear();
    behindCache.set(c, v);
  }
  return behindCache.get(c)!;
}

// ---------- backup, review triage, daily summary ----------
const backup = new Backup(ROOT, cfg.backup, machineName());
if (cfg.backup.remote) {
  const tick = () => { if (!stopping) backup.tick().catch((e) => console.error(`backup: ${e?.message ?? e}`)); };
  setTimeout(tick, 5000).unref();
  setInterval(tick, cfg.backup.every_min * 60_000).unref();
}
const backupNow = () => backupView(cfg.backup, backup.status());

/** PR status for the triage page: gh on this Mac (DASKS_GH names another binary), cached, refreshed every 5 minutes. */
const ghBin = () => {
  if (process.env.DASKS_GH) return process.env.DASKS_GH;
  for (const d of (process.env.PATH || '').split(':')) { const f = path.join(d || '.', 'gh'); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ } }
  return null;
};
const prStatus = new PrStatusCache(ROOT, ghBin);
const reviewPrs = () => board.tasks.flatMap((t) => (t.status === 'review' && t.pr ? [t.pr] : []));
setInterval(() => { if (!stopping) void prStatus.refresh(reviewPrs()); }, 5 * 60_000).unref();
setTimeout(() => { if (!stopping) void prStatus.refresh(reviewPrs()); }, 2000).unref();
function reviewTriage() {
  return buildTriage(board.tasks.filter((t) => t.status === 'review').map((t) => ({ id: t.id, title: t.title, goal: t.goal, priority: t.priority, updated: t.updated, pr: t.pr ?? '' })),
    (pr) => prStatus.get(pr), (id) => { try { return readReviewRuns(ROOT, id) as any[]; } catch { return []; } }, new Date(), cfg.review.stale_days);
}

/** Write the daily summary when it is due (checked every minute and at start). */
function summaryTick(now = new Date()) {
  if (stopping) return; // a board shutting down writes nothing more
  const last = readSummary(ROOT);
  if (!summaryDue(now, cfg.summary.at, last?.day ?? null)) return;
  const since = last ? new Date(last.until) : new Date(now.getTime() - 24 * 3600_000);
  try {
    const s = buildSummary({ now, since,
      tasks: board.tasks.map((t) => ({ id: t.id, title: t.title, goal: t.goal, status: t.status, pr: t.pr, needs_user: t.needs_user,
        done_at: t.status === 'done' && Date.parse(t.updated) >= since.getTime() ? (() => { const ms = lastDone(t.id); return ms === null ? null : new Date(ms).toISOString(); })() : null,
        live_ask: !!liveAsk(t) })),
      machines: fleet.list(cfg.fleet.dead_min, now), stale: stuckReport(board, now, cfg.stuck).items.filter((i) => i.reason === 'doing-stale'),
      outcomes: allOutcomes(ROOT), warnings: [backupNow().warning].filter((w): w is string => !!w) });
    saveSummary(ROOT, s);
    version++; announce();
  } catch (e: any) { console.error(`summary: not written (${e.message})`); }
}
const SUMMARY_TICK_MS = Number(process.env.DASKS_SUMMARY_TICK_MS) || 60_000;
setInterval(() => summaryTick(), SUMMARY_TICK_MS).unref(); // the first check a tick after start: a board that was off writes it then

// ---------- helpers ----------
/** When the card last moved to done (its activity log), or null. */
function lastDone(id: string): number | null {
  const acts = readActivity(ROOT, id);
  for (let i = acts.length - 1; i >= 0; i--) if (acts[i].to === 'done') { const ms = Date.parse(acts[i].at); return Number.isFinite(ms) ? ms : null; }
  return null;
}

/** The lessons a task read carries: its project's live lessons, the ones on the Handoff `files:` first.
 *  A broken lessons file must not break task reads: it reads as none (`dasks check` reports the file). */
function lessonsForTask(app: string, handoff: string) {
  try { return relevantLessons(readLessons(ROOT, app), taskFiles(handoff)); } catch { return []; }
}


const SPEC_FIELDS = ['spec_state', 'blocked_by', 'blocked_at', 'block_note', 'blocked_spec_version', 'spec_review'];
function publicTask(t: Task) {
  const { file, bytes, ...rest } = t as any;
  delete rest.__present; delete rest.__unknown;
  // Spec fields as committed (specIndex), never a value another process wrote and may still roll back.
  const facts = specIndex.facts.get(t.id);
  for (const k of SPEC_FIELDS) delete rest[k];
  Object.assign(rest, facts?.fields ?? {});
  // A card that asks the human carries its question (revision + exact scope text): the board UI signs this snapshot,
  // the one it displays, never a newer one fetched at tap time (the server then refuses a scope that moved on).
  // A card waiting on a user decision (an open ask) is answered only in the decision queue (/asks): no approve/reject.
  const live = liveAsk(t);
  const asks = live ? null : decisionRequest(t);
  return { ...rest, version: Number(t.version || 0), claimed_by: t.claimed_by || '', claimed_at: t.claimed_at || '', spec_state: facts?.spec_state ?? 'none', file, ...(asks ? { decision_request: asks } : {}), ...(live ? { user_ask: { id: live.id, kind: live.kind } } : {}) };
}

// ---------- user decisions ----------
let askCache: { key: number; map: Map<string, Ask> } | null = null;
/** The open asks as committed now (cached per board version; every ask write is a board write). */
const askMap = () => { if (askCache?.key !== version) askCache = { key: version, map: openAsks(ROOT) }; return askCache.map; };
/** The card's live ask (open, and the card still waits on the user), or null. fresh = from disk, not the cache. */
function liveAsk(t: Task, fresh = false): Ask | null {
  const a = fresh ? readAsks(ROOT, t.id)?.open ?? null : askMap().get(t.id) ?? null;
  return askLive(ROOT, t, a) ? a : null;
}
/** The approve/reject question a card asks on the board, unless it waits on a user decision instead. */
const boardDecision = (t: Task, fresh = false) => (liveAsk(t, fresh) ? null : decisionRequest(t));

/** GET /api/asks: the open user decisions, newest first. */
function asksDoc() {
  const tasks = new Map(board.tasks.map((t) => [t.id, t]));
  const items = [...askMap()].flatMap(([card, a]) => {
    const t = tasks.get(card);
    if (!t || !askLive(ROOT, t, a)) return [];
    return [{ card, title: askTitle(t), app: t.goal, kind: a.kind, asked_at: a.asked_at, asked_by: a.asked_by, text: askText(a), lines: askLines(a),
      options: a.options, rec: a.rec, request: askRequest(ROOT, t, a) }];
  }).sort((x, y) => (x.asked_at < y.asked_at ? 1 : x.asked_at > y.asked_at ? -1 : x.card.localeCompare(y.card)));
  return { format: 'dasks-asks/1', now: new Date().toISOString(), count: items.length, items };
}
function asksMarkdown(d: ReturnType<typeof asksDoc>): string {
  const out = ['# Decisions', `now: ${d.now}`, `count: ${d.count}`, ''];
  if (!d.items.length) out.push('_none_', '');
  for (const i of d.items) out.push(`## ${i.card}`, `- title: ${i.title}`, `- kind: ${i.kind}`, `- asked: ${i.asked_at} by ${i.asked_by}`, '', i.text, `choices: ${i.request.choices.join(' / ')}`, '');
  return out.join('\n');
}

const ASKS_LEDGER = asksLedgerPath(ROOT);
const asksHead = () => path.join(secretsDir(), 'asks.head');
/** POST /api/asks/<card>/answer {ask, revision, scope, choice, comment?}: the human answers exactly what the queue shows.
 *  The signed entry goes to its own ledger (data/decisions/asks.jsonl), then the answer's effect moves the card. A replay
 *  gets 409 with the first answer; an answer recorded whose effect did not land (a crash between) is applied again. */
async function answerAsk(req: http.IncomingMessage, res: http.ServerResponse, card: string, actor: string) {
  if (actor !== 'user') return send(res, 403, { error: 'only the human answers a decision (log in on the board)' });
  requireHuman(req, sessionsOrNull);
  const key = humanSecrets()!.ledgerKey;
  const raw = await readJson(req);
  const human = requireHuman(req, sessionsOrNull);
  if (!isTaskId(card)) return send(res, 400, { error: 'card must be a task id' });
  const { ask, revision, scope, choice, comment } = parseAnswer(raw, 'ask');
  const out = withRepoLock(ROOT, () => {
    const t = readTask(ROOT, card);
    const a = readAsks(ROOT, card)?.open ?? null;
    let first: Decision | null;
    try { first = findDecision(ASKS_LEDGER, key, asksHead(), card, revision, sha256(scope)); }
    catch (e: any) { console.error(`asks: ${e.message}`); throw new HttpError(503, 'the decision ledger fails verification: nothing counts as answered until it is repaired (see server log)'); }
    const live = askLive(ROOT, t, a) ? a : null;
    const want = live ? askRequest(ROOT, t, live) : null;
    if (first) {
      // Recorded but its effect did not land (a crash between): only when the receipt is for exactly the question open now.
      if (live && want && live.id === ask && first.revision === want.revision && first.scope_hash === sha256(want.scope)) return applyAnswer(ROOT, card, first.choice, first.comment, entryId(first));
      throw new HttpError(409, 'already answered', { decision: first });
    }
    if (!live || !want || live.id !== ask) throw new HttpError(409, `${card} is not waiting on this decision`);
    if (revision !== want.revision) throw new HttpError(409, 'the card changed since it was shown; reload it', { current: want });
    if (!timingSafeEqual(Buffer.from(sha256(scope)), Buffer.from(sha256(want.scope)))) throw new HttpError(409, 'scope differs from what the card asks now', { current: want });
    if (!want.choices.includes(choice)) throw new HttpError(409, `choice must be ${want.choices.join(' | ')}`);
    checkAnswer(ROOT, card, choice, comment); // an answer that could not be applied is refused, not signed
    const e = appendDecision(ASKS_LEDGER, key, { who: 'user', session: human.sidHash, card, revision, choice, scope, comment }, new Date(), asksHead());
    return applyAnswer(ROOT, card, choice, comment, entryId(e));
  });
  reloadAfterWrite();
  return send(res, 200, { effect: out.effect, auto_ok: out.auto_ok, ask: out.ask, task: publicTask(out.task) });
}

/** GET /api/health: 200 and ready only when every part works; 503 with ok/ready false and the failing part otherwise
 *  (the installer and monitors wait on the status). Parts: the spec index (claims and spec writes need it), the write
 *  journal (a kept unreadable one stops every write) and the board's files (a file that does not load is a card or goal
 *  missing from the board). */
function health(res: http.ServerResponse) {
  const kept = corruptJournals(ROOT);
  const parts = {
    spec_index: { ok: !specIndexFailed, attempts: specIndexAttempts, ...(specIndexFailed ? { error: specIndexFailed } : {}) },
    journal: { ok: !kept.length, ...(kept.length ? { error: corruptJournalHelp(ROOT, kept) } : {}) },
    schema: { ok: !schemaProblem, version: SCHEMA_VERSION, ...(schemaProblem ? { error: schemaProblem } : {}) },
    files: { ok: !board.loadErrors.length, ...(board.loadErrors.length ? { errors: board.loadErrors.length, first: board.loadErrors.slice(0, 5) } : {}) },
  };
  const ready = Object.values(parts).every((x) => x.ok);
  // The backup is not a part: a failing push is a warning, never a reason to stop serving.
  const b = backupNow();
  return send(res, ready ? 200 : 503, { ok: ready, ready, version, ...parts, backup: { state: b.state }, warnings: b.warning ? [b.warning] : [], reload: { ...reloadStats, task_parses: loadStats.task_parses } });
}

function setWarningHeader(warnings: string[], res: http.ServerResponse) {
  if (warnings.length) res.setHeader('X-Dasks-Warning', encodeURIComponent(warnings.join('; ')));
}

/** Split the side-by-side options off a write body; what is left is the field patch. */
function writeOpts(body: Body): { opts: UpdateOpts; rest: Body } {
  const { expected_version, what, why, do: doField, rec, after, ...rest } = body;
  const opts: UpdateOpts = { exempt: cfg.context_exempt_actors, warnings: [], staleHours: cfg.stale_hours };
  if (expected_version !== undefined && expected_version !== null && expected_version !== '') {
    const v = typeof expected_version === 'number' ? expected_version : /^\d+$/.test(String(expected_version)) ? Number(expected_version) : NaN;
    if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'expected_version must be a non-negative integer');
    opts.expectedVersion = v;
  }
  try { opts.context = pickContext({ what, why, do: doField, rec, after }); } catch (e: any) { throw new HttpError(400, e.message); }
  return { opts, rest };
}

function bool(v: unknown): boolean { return v === true || v === 'true' || v === 1 || v === '1'; }

function whoOf(v: unknown, actor: string): string {
  if (v === undefined || v === null || v === '') return actor;
  if (typeof v !== 'string' || !ACTOR_RE.test(v.trim())) throw new HttpError(400, 'who must be an actor name like claude-code@my-mac');
  if (v.trim().toLowerCase() === 'user' && actor !== 'user') throw new HttpError(403, 'only the logged-in human acts as "user"');
  return v.trim();
}

/** The actor header as sent ('' when missing or malformed): messages never fall back to a default name. Once a token
 *  passed (docs/auth.md), the token's identity instead, header or not. */
function rawActor(req: http.IncomingMessage): string {
  const t = tokenActor.get(req);
  if (t !== undefined) return t;
  const s = sanitizeActor(req.headers['x-dasks-actor'], '');
  return s;
}

// ---------- agent tokens (docs/auth.md) ----------
/** Requests whose token passed every check → the token's identity. Set once at the top of handle(). */
const tokenActor = new WeakMap<http.IncomingMessage, string>();
const tokenStoreCfg = tokenStoreConfig(cfg.auth.store);
const tokenStore = new TokenStore(tokenStoreCfg);
const AUTH_STATUS: Record<AuthReason, number> = { 'no-token': 401, 'bad-token': 401, revoked: 401, mismatch: 403, 'store-unavailable': 503, 'not-machine': 403 };
const AUTH_ERROR: Record<AuthReason, string> = {
  'no-token': 'this board needs an agent token for writes: send Authorization: Bearer <token> (env DASKS_TOKEN)',
  'bad-token': 'the agent token is not valid',
  revoked: 'the agent token was revoked',
  mismatch: 'the agent token may not write under this actor name',
  'store-unavailable': 'agent tokens cannot be checked right now (token store unavailable; see server log)',
  'not-machine': 'from the network the board takes only machine tokens (dasks machine add <name> on the board\'s Mac)',
};
/** Requests that came in on the network address (not this Mac's loopback): set by the listener, before handle(). */
const remoteReq = new WeakSet<http.IncomingMessage>();
/** The machine a request's token belongs to ('' for a local token, absent without a valid token). */
const tokenMachine = new WeakMap<http.IncomingMessage, string>();
/** What anyone may fetch from the network without a token or login: the UI's files, health, the login itself. */
function remotePublic(method: string, p: string): boolean {
  if (method === 'GET' || method === 'HEAD') return !!STATIC[p] || DS_FILE_RE.test(p) || /^\/p\/[a-z0-9-]{1,24}\/?$/.test(p) || p === '/fleet' || p === '/api/health' || p === '/api/session';
  return method === 'POST' && (p === '/api/session' || p === '/api/session/logout');
}
/** A request from the network: public routes, the human's session (writes still go through requireHuman), or a valid
 *  machine token. Returns the refusal to send, or null. */
function remoteGate(req: http.IncomingMessage, p: string): { status: number; body: Record<string, unknown> } | null {
  if (!remoteReq.has(req) || remotePublic(req.method || '', p)) return null;
  const sid = sessionCookie(req);
  if (sid && sessionsOrNull()?.valid(sid)) return null;
  const raw = req.headers['x-dasks-actor'];
  const r = checkToken(bearerOf(req), typeof raw === 'string' && raw.trim() ? raw.trim() : undefined, tokenStore);
  if (!r.ok) return { status: AUTH_STATUS[r.reason], body: { error: r.reason === 'no-token' ? 'log in on the board, or send a machine token (Authorization: Bearer <token>)' : AUTH_ERROR[r.reason], rule: 'auth', reason: r.reason, login: true } };
  if (!r.machine) return { status: 403, body: { error: AUTH_ERROR['not-machine'], rule: 'auth', reason: 'not-machine' } };
  tokenActor.set(req, r.actor); tokenMachine.set(req, r.machine); noteTokenUse(r.id);
  return null;
}
/** Routes that authenticate with their own credential in the same Authorization header, so the token check must not
 *  read it. Exact method + path; add here only with that
 *  route's own check in place. */
const OWN_AUTH_ROUTES: ReadonlyArray<readonly [string, string, string]> = [
  ['POST', '/api/session', 'human login (passphrase, then session cookie)'],
  ['POST', '/api/session/logout', 'human session (cookie + CSRF)'],
];
/** Written requests the token check covers: not GET/HEAD/OPTIONS, not OWN_AUTH_ROUTES. ("user" is left out by the caller.) */
function authChecked(method: string, p: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return !OWN_AUTH_ROUTES.some(([m, r]) => m === method && r === p);
}
/** Last used per token id: in memory, written to run/agent-token-usage.json at most once per id per 10 minutes. */
const tokenUsed = new Map<string, string>();
const tokenUsageWritten = new Map<string, number>();
function noteTokenUse(id: string) {
  const now = Date.now();
  tokenUsed.set(id, new Date(now).toISOString());
  if (now - (tokenUsageWritten.get(id) ?? 0) < 10 * 60_000) return;
  tokenUsageWritten.set(id, now);
  const f = path.join(ROOT, 'run', 'agent-token-usage.json');
  try {
    let old: Record<string, string> = {};
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) old = j; } catch { /* none yet */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...old, ...Object.fromEntries(tokenUsed) }, null, 1) + '\n');
    fs.renameSync(tmp, f);
  } catch { console.error('auth: token usage log failed'); }
}
/** The path as logged: decoded, token-shaped text and the sent bearer value (or its secret part) masked, capped. A token
 *  pasted into a URL by mistake never reaches the warning file or the log. */
function logPath(p: string, token: string): string {
  // Decode %XX one escape at a time (a bad escape like %zz never stops the rest), again until nothing changes (%2564…).
  // A path still changing after 8 rounds is no real request path: it is masked whole, so no layer of encoding hides a token.
  let s = p;
  for (let i = 0; ; i++) {
    const next = s.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    if (next === s) break;
    if (i === 8) return '<redacted: path encoded too many times>';
    s = next;
  }
  for (const t of [token, token.split('_').slice(2).join('_')]) if (t.length >= 8) s = s.split(t).join('<redacted>');
  // Anything token-shaped, and any long run of token characters (a 43-char secret without its prefix included).
  s = s.replace(/dsk_[0-9a-f]{0,8}_?[A-Za-z0-9_-]*/gi, 'dsk_<redacted>').replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>').replace(/[^\x21-\x7e]/g, '_');
  return s.length > 200 ? s.slice(0, 199) + '…' : s;
}
/** run/auth-warnings.jsonl keeps only its newest rows. */
const AUTH_WARNINGS_MAX_BYTES = 16 * 1048576, AUTH_WARNINGS_KEEP_BYTES = 8 * 1048576;
function authWarn(line: Record<string, string>) {
  console.error(`auth: ${line.reason} ${line.actor} ${line.method} ${line.path}`);
  try {
    const f = path.join(ROOT, 'run', 'auth-warnings.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(line) + '\n');
    capFile(f, AUTH_WARNINGS_MAX_BYTES, AUTH_WARNINGS_KEEP_BYTES);
  } catch { console.error('auth: warning log failed'); }
}
/** Resolve the request's identity from its token (warn and enforce). Returns the refusal to send in enforce, or null.
 *  A failing token never changes the actor: it stays the header (or dasks). */
function resolveToken(req: http.IncomingMessage, p: string, actor: string): { status: number; reason: AuthReason } | null {
  const mode = cfg.auth.mode;
  const method = req.method || '';
  if (mode === 'off' || !authChecked(method, p)) return null;
  const raw = req.headers['x-dasks-actor'];
  const header = typeof raw === 'string' && raw.trim() ? raw.trim() : Array.isArray(raw) ? raw.join(', ') : undefined;
  const bearer = bearerOf(req);
  const r = checkToken(bearer, header, tokenStore);
  if (r.ok && remoteReq.has(req) && !r.machine) return { status: AUTH_STATUS['not-machine'], reason: 'not-machine' };
  if (r.ok) { tokenActor.set(req, r.actor); tokenMachine.set(req, r.machine); noteTokenUse(r.id); return null; }
  if (mode === 'enforce') {
    console.error(`auth: refused ${r.reason} ${actor} ${method} ${logPath(p, bearer)}`);
    return { status: AUTH_STATUS[r.reason], reason: r.reason };
  }
  authWarn({ at: new Date().toISOString(), method, path: logPath(p, bearer), actor, reason: r.reason, ...(r.id ? { token_id: r.id } : {}) });
  return null;
}

function taskOrThrow(id: string): void {
  if (!isTaskId(id)) throw new HttpError(400, 'bad task id');
}

// ---------- verified ledger (merge OK reads, decisions) ----------
/** The ledger's entries when it verifies (chain, HMACs, head, git witness), else null. No ledger file = no decisions yet,
 *  without touching the key (a board that only serves agents never creates key files). Recomputed when the ledger, its
 *  head or the witness file changes, and at least once a minute. */
let verifiedCache: { key: string; entries: Decision[] | null } | null = null;
function verifiedLedger(fresh = false): Decision[] | null {
  if (!fs.existsSync(LEDGER)) return [];
  const k = [statKey(LEDGER), statKey(ledgerHead()), statKey(path.join(ROOT, WITNESS_REL)), Math.floor(Date.now() / 60_000)].join('|');
  if (fresh || verifiedCache?.key !== k) {
    const key = humanSecrets()?.ledgerKey;
    verifiedCache = { key: k, entries: key ? verifiedEntries(ROOT, LEDGER, key, ledgerHead()) : null };
  }
  return verifiedCache.entries;
}

const statKey = (f: string) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return 'none'; } };
/** src/lib/park.ts: a machine's blocked-on-user write without a real decision goes back to the card's owner. Called under the repo
 *  lock; changes `fields` and returns the note to append (or the note unchanged). */
function unparkWrite(id: string, fields: Record<string, unknown>, actor: string, note: string | undefined, text: string, opts: { context?: unknown; warnings?: string[] }, sweep = false): string | undefined {
  if (fields.status !== 'blocked-on-user') return note;
  const cur = readTask(ROOT, id);
  const hasAsk = cur.status === 'blocked-on-user' && askLive(ROOT, cur, readAsks(ROOT, id)?.open);
  // The card's standing question counts too: a sweep that re-sends the status without needs_user must not drop it.
  const u = unpark(`${text} ${cur.needs_user ?? ''}`, { actor, hasAsk, sweep, owner: cardOwner(cur) });
  if (!u) return note;
  Object.assign(fields, u.fields);
  opts.context = undefined;
  opts.warnings?.push(`not parked on the user: ${u.note}`);
  return note ? `${note} · ${u.note}` : u.note;
}
/** The needs_user wording rule (src/lib/ask-rule.ts) on a task write, after unparkWrite (it may have cleared the ask), on
 *  what updateTask would store: the needs_user field, else the card's, else context.do when the card ends up
 *  blocked-on-user with no question (src/lib/write.ts). The user's own writes, an empty ask and the card's standing ask
 *  (sweeps re-send it) are never checked. enforce: 400 with the reason codes, nothing written; warn: a warning. */
function askRuleWrite(id: string, fields: Record<string, unknown>, actor: string, opts: { context?: { do?: string }; warnings?: string[] }): void {
  if (actor === 'user') return;
  const cur = readTask(ROOT, id);
  const standing = (cur.needs_user ?? '').trim();
  // An explicit null clears the field like '' (updateTask's strPatch), so context.do may then be what is stored.
  const field = fields.needs_user === null ? '' : fields.needs_user;
  let text = typeof field === 'string' ? field : cur.needs_user ?? '';
  if ((fields.status ?? cur.status) === 'blocked-on-user' && !text.trim() && opts.context?.do) text = opts.context.do;
  text = text.trim();
  if (!text || text === standing) return;
  const reasons = checkAsk(text);
  if (!reasons.length) return;
  if (cfg.ask_rule === 'enforce') throw new HttpError(400, `needs_user is not a yes/no ask the user can approve: ${reasons.join(', ')}`, { reasons });
  opts.warnings?.push(`ask rule: ${reasons.join(', ')}`);
}
/** Responses whose request accepts gzip (set at the top of handle(); send() has no req). */
const wantsGzip = new WeakMap<http.ServerResponse, boolean>();
/** JSON replies of 1 KB or more are gzipped for clients that accept it; every JSON reply carries Vary: Accept-Encoding.
 *  Other types (text, HTML) are sent as they are. */
const GZIP_MIN = 1024;
function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const isJson = /^application\/json/i.test(type);
  const gz = isJson && wantsGzip.get(res) === true && Buffer.byteLength(data) >= GZIP_MIN;
  res.writeHead(status, { 'Content-Type': type, ...(gz ? { 'Content-Encoding': 'gzip' } : {}), ...(isJson ? { Vary: 'Accept-Encoding' } : {}), 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(gz ? gzipSync(data) : data);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

/** Hard stop for a drained body: past this the socket is dropped (a client that never stops sending). */
const DRAIN_CAP = 256 * 1024 * 1024;
/** `drain` (PUT /spec, POST /review-runs): over `limit`, read and drop the rest and answer 413 once the body has ended, so
 *  the client gets the 413 as a response; answering (or closing) mid-upload resets the connection.
 *  Without it: drop the socket at once. */
function readJson(req: http.IncomingMessage, limit = MAX_BODY, drain = false): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(ct)) return reject(new HttpError(415, 'Content-Type must be application/json'));
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) { chunks.push(c); return; }
      chunks.length = 0;
      if (!drain || size > DRAIN_CAP) { reject(new HttpError(413, 'body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (size > limit) return reject(new HttpError(413, `body too large (max ${limit} bytes)`));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch { reject(new HttpError(400, 'invalid JSON object')); }
    });
    req.on('error', reject);
  });
}

let allowedHosts = new Set<string>();
function setAllowedHosts(port: number) {
  allowedHosts = new Set([...cfg.server.hosts, 'localhost', ...cfg.server.extra_allowed_hosts].map((h) => `${h}:${port}`.toLowerCase()));
}
function hostOk(req: http.IncomingMessage): boolean {
  // Blocks DNS-rebinding: the Host header must be one of our own addresses.
  return allowedHosts.has(String(req.headers.host || '').toLowerCase());
}
function originOk(req: http.IncomingMessage): boolean {
  const o = req.headers.origin;
  if (!o) return true; // non-browser clients (curl, workers)
  try { return allowedHosts.has(new URL(o).host.toLowerCase()); } catch { return false; }
}

/** GET /api/tasks (docs/api.md). No query = every task in full; ?status=open|all, fields=, limit/cursor are opt-in. The tag names the data exactly: publicTask reads only the board, the spec index and the open
 *  asks, and every change to those bumps `version` (BOOT: version restarts at 1 with the process). */
function getTasks(req: http.IncomingMessage, res: http.ServerResponse, q: URLSearchParams) {
  const opts = parseTaskQuery(q);
  if ('error' in opts) return send(res, 400, { error: opts.error });
  const etag = `W/"${BOOT}-${version}"`;
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, { ETag: etag, Vary: 'Accept-Encoding', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    return res.end();
  }
  res.setHeader('ETag', etag);
  let list = filterTaskList(board.tasks, q);
  if (opts.limit !== null) {
    const { page, next } = pageTasks(list, opts.limit, opts.cursor);
    if (next) res.setHeader('X-Next-Cursor', next);
    list = page;
  }
  return send(res, 200, list.map((t) => projectTask(publicTask(t), opts.fields)));
}

/** GET /api/claims/dead?hours=<h>: claimed doing/review cards whose holder shows no sign of life (holderSeenAt, the
 *  lease's rule) for more than h hours, by id. Read-only. */
function deadClaims(res: http.ServerResponse, q: URLSearchParams) {
  const all = q.getAll('hours'), h = all[0] ?? '';
  if (all.length !== 1 || !/^\d+(\.\d+)?$/.test(h) || /\s/.test(h) || !(Number.isFinite(Number(h)) && Number(h) > 0)) return send(res, 400, { error: 'hours must be a number > 0' });
  const now = Date.now(), limit = Number(h) * 3600_000;
  const out = [];
  for (const t of board.tasks) {
    if ((t.status !== 'doing' && t.status !== 'review') || !t.claimed_by) continue;
    const seen = holderSeenAt(t, readActivity(ROOT, t.id));
    if (!(now - seen > limit)) continue;
    out.push({ id: t.id, status: t.status, claimed_by: t.claimed_by, claimed_at: t.claimed_at ?? '', last_seen: seen ? new Date(seen).toISOString() : '',
      idle_hours: seen ? Math.floor((now - seen) / 3600_000) : null, version: Number(t.version || 0) });
  }
  return send(res, 200, out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { throw new HttpError(400, 'bad URL encoding'); }
}

// ---------- login + decisions ----------
/** POST /api/session {method: "passphrase", passphrase}: only from a page of this board; a new session id every time. */
async function login(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'log in from the board page' });
  const sessions = sessionsOrNull();
  if (!sessions) return send(res, 503, { error: 'login is unavailable (secrets dir unreadable; see server log)' });
  const body = await readJson(req);
  const auth = authenticators.find((a) => a.method === (body.method ?? 'passphrase'));
  if (!auth) return send(res, 400, { error: `method must be ${authenticators.map((a) => a.method).join(' | ')}` });
  if (!auth.available()) return send(res, 503, { error: 'no passphrase set: run bin/dasks-passphrase (or ./install.sh) on this Mac' });
  const client = req.socket.remoteAddress ?? '';
  if (loginLimiter.locked(client)) return send(res, 429, { error: 'too many failed logins from this device; try again in 15 minutes' });
  let ok = false;
  try { ok = auth.verify(body); } catch (e: any) { console.error(`login: ${e.message}`); return send(res, 503, { error: 'login is misconfigured (see server log)' }); }
  if (!ok) { loginLimiter.miss(client); return send(res, 401, { error: 'wrong passphrase' }); }
  const old = sessionCookie(req);
  if (old) sessions.revoke(old); // rotate: the cookie a browser had before this login is dead from now on
  const s = sessions.create();
  res.setHeader('Set-Cookie', cookieHeader(req, s.sid, sessions.ttlSeconds));
  return send(res, 200, { ok: true, csrf: s.csrf, expires_at: new Date(s.exp).toISOString() });
}

/** POST /api/decisions {card, revision, scope, choice, comment?}: the human answers exactly what the card shows.
 *  One entry per (card, revision, scope hash): a replay or a second click gets 409 with the first decision. */
async function decide(req: http.IncomingMessage, res: http.ServerResponse) {
  requireHuman(req, sessionsOrNull);
  const ledgerKey = humanSecrets()!.ledgerKey; // requireHuman passed, so the secrets loaded
  const raw = await readJson(req);
  // Again once the body is in: a session logged out (or expired) while the body was still arriving is dead now.
  const human = requireHuman(req, sessionsOrNull);
  // Anything beyond what the inbox shows (scope_hash instead of the text, actor, session…) is not that decision (409).
  const { card: id, revision, scope, choice, comment } = parseAnswer(raw, 'decision');
  const card = id!;
  const want = boardDecision(readTask(ROOT, card), true); // from disk, not the board cache: a change a moment ago counts
  // Everything from here to the append is synchronous: two requests cannot both pass the check.
  const first = receipt(card, revision, sha256(scope)); // also: never append onto a ledger that fails
  if (first) return send(res, 409, { error: 'already decided', decision: first });
  if (!want) return send(res, 409, { error: `${card} is not asking for a decision` });
  if (revision !== want.revision) return send(res, 409, { error: 'the card changed since it was shown; reload it', current: want });
  if (!timingSafeEqual(Buffer.from(sha256(scope)), Buffer.from(want.scope_hash))) return send(res, 409, { error: 'scope differs from what the card asks now', current: want });
  if (!(CHOICES as readonly string[]).includes(choice)) return send(res, 409, { error: `choice must be ${CHOICES.join(' | ')}` });
  // The baseline is fixed from a fresh verification (a repair committed without touching the witness file leaves a cached
  // failure): it never swallows this decision. No baseline = the ledger does not verify now: refuse, append nothing.
  const e = appendDecision(LEDGER, ledgerKey, { who: 'user', session: human.sidHash, card, revision, choice, scope, comment }, new Date(), ledgerHead());
  // The git witness: a later deletion of ledger + head together is still noticed. Best effort: a busy repo
  // leaves the witness one behind, which never raises a false alarm (it only ever vouches for fewer lines).
  try { withRepoLock(ROOT, () => commitFiles(ROOT, [{ rel: WITNESS_REL, content: witnessContent(e.seq, JSON.stringify(e), ROOT) }], `user: decision #${e.seq} ${card} ${choice}`)); }
  catch (err: any) { console.error(`decisions: witness not committed (${String(err.message).split('\n')[0]})`); }
  return send(res, 201, e);
}

/** GET /api/merge-ok?card=&sha=: is there a merge OK for this card at exactly this head (mergeOkAt)?
 *  Read fresh from a verified ledger: one that does not verify answers 503, and nobody merges on it. */
function mergeOkRead(res: http.ServerResponse, url: URL) {
  const card = url.searchParams.get('card'), sha = url.searchParams.get('sha');
  if (!card || !isTaskId(card)) return send(res, 400, { error: 'card must be a task id' });
  if (!sha || !SHA40_RE.test(sha)) return send(res, 400, { error: 'sha must be 40 lowercase hex' });
  const entries = verifiedLedger(true);
  if (!entries) return send(res, 503, { error: 'the decision ledger fails verification: nothing counts as decided until it is repaired (see server log)' });
  const decision = mergeOkAt(entries, card, sha);
  return send(res, 200, decision ? { ok: true, decision } : { ok: false });
}

const ledgerHead = () => path.join(secretsDir(), 'ledger.head');
/** The signed receipt for one exact question, read from a ledger that verifies. A ledger that does not (a line written
 *  without the key, a cut, a reorder) answers 503: nothing counts as decided, and nothing is appended, until it is fixed. */
function receipt(card: string, revision: unknown, scopeHash: string) {
  const key = humanSecrets()?.ledgerKey;
  if (!key) throw new HttpError(503, 'the decision ledger is unavailable (secrets dir unreadable; see server log)');
  const gone = witnessProblem(ROOT, LEDGER);
  if (gone) { console.error(`decisions: ${gone}`); throw new HttpError(503, 'the decision ledger fails verification: nothing counts as decided until it is repaired (see server log)'); }
  try { return findDecision(LEDGER, key, ledgerHead(), card, Number(revision), scopeHash); }
  catch (e: any) { console.error(`decisions: ${e.message}`); throw new HttpError(503, 'the decision ledger fails verification: nothing counts as decided until it is repaired (see server log)'); }
}

/** The human answers a card that asks (review, blocked-on-user) only through POST /api/decisions. A "user" write that
 *  moves such a card on (Approve, Done, the status menu, a claim) needs the signed receipt for the exact question on
 *  disk right now: approve to reach done, either choice for any other status. The same write cannot also change what
 *  was asked (PR, summary, title, approvals, the context block): the receipt covers the card as it was answered, not as
 *  it would end up. Only needs_user may change, when the card goes (back) to blocked-on-user: that is the next question.
 *  Runs under the repo lock (updateTask), after every field and body change of the write is applied to `next`. */
/** reset-attempts by the human on a card that asks: the answer must be on record first (either choice). Reset itself
 *  clears the question (needs_user) by design, so only the receipt is checked, not the scope. */
function receiptFirst(cur: Task) {
  const want = boardDecision(cur, true);
  if (want && !receipt(want.card, want.revision, want.scope_hash))
    throw new HttpError(409, `${want.card} is asking for a decision: record it with POST /api/decisions first`, { decision_request: want });
}
function needsReceipt(cur: Task, next: Task) {
  const want = boardDecision(cur, true);
  if (!want) return;
  const d = receipt(want.card, want.revision, want.scope_hash);
  if (!d || (next.status === 'done' && d.choice !== 'approve'))
    throw new HttpError(409, `${want.card} is asking for a decision: record it with POST /api/decisions first${d ? ' (it was rejected, so it cannot become done)' : ''}`, { decision_request: want, ...(d ? { decision: d } : {}) });
  const asked = decisionRequest({ ...next, status: cur.status, version: cur.version, ...(next.status === 'blocked-on-user' ? { needs_user: cur.needs_user } : {}) } as Task);
  if (asked?.scope_hash !== want.scope_hash)
    throw new HttpError(409, `${want.card}: this write also changes what was answered (PR, summary, title, approvals or the context block); move the card on first, then change it`, { decision_request: want, decision: d });
}

// ---------- routes ----------
async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  wantsGzip.set(res, acceptsGzip(req.headers['accept-encoding']));
  if (!hostOk(req)) return send(res, 421, { error: 'unknown Host' });
  const url = new URL(req.url || '/', 'http://local');
  const p = url.pathname;
  const gate = remoteGate(req, p);
  if (gate) return send(res, gate.status, gate.body);
  if (refreshSpecIndex()) { version++; announce(); } // every route answers from the current HEAD's spec facts
  let actor = sanitizeActor(req.headers['x-dasks-actor']);
  // Agent identity tokens (docs/auth.md), once, before any route: a valid token sets the actor; in
  // enforce a write without one is refused here. "user" is never a token identity: it keeps the login path below.
  if (actor.toLowerCase() !== 'user') {
    const refused = resolveToken(req, p, actor);
    if (refused) return send(res, refused.status, { error: AUTH_ERROR[refused.reason], rule: 'auth', reason: refused.reason });
    const t = tokenActor.get(req);
    if (t !== undefined) actor = t;
  }
  // "user" is the human in the board UI: it skips the context rule and its "approved" notes gate merges. A header
  // alone never makes a request "user": a write naming it (any case) must carry the login session, that session's CSRF
  // token and a same-origin Origin (requireHuman: 401/403 otherwise). Agents write under their own name.
  if (actor.toLowerCase() === 'user' && req.method !== 'GET' && req.method !== 'HEAD') { requireHuman(req, sessionsOrNull); actor = 'user'; }
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (STATIC[p]) {
      const file = path.join(PUBLIC, STATIC[p]);
      try {
        const data = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': MIME[file.split('.').pop()!] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
        return res.end(req.method === 'HEAD' ? undefined : data);
      } catch { return send(res, 404, { error: 'not found' }); }
    }
    const ds = DS_FILE_RE.exec(p);
    if (ds && !ds[1].includes('..')) {
      const file = path.join(PUBLIC, 'ds', ds[1]);
      try {
        const data = fs.readFileSync(file);
        // Fonts never change under the same name (a font file changes only with a new kit version): a day.
        const cache = file.endsWith('.woff2') ? 'public, max-age=86400' : 'no-cache';
        res.writeHead(200, { 'Content-Type': MIME[file.split('.').pop()!], 'Cache-Control': cache, ...SECURITY_HEADERS });
        return res.end(req.method === 'HEAD' ? undefined : data);
      } catch { return send(res, 404, { error: 'not found' }); }
    }
    const pp = /^\/p\/([a-z0-9-]{1,24})\/?$/.exec(p);
    if (pp) {
      const projects = projectIds(board);
      if (!projects.includes(pp[1])) return send(res, 404, `no project "${pp[1]}" — try ${projects.map((a) => `/p/${a}`).join(' ')}\n`, 'text/plain; charset=utf-8');
      try {
        const data = fs.readFileSync(path.join(PUBLIC, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME.html, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
        return res.end(req.method === 'HEAD' ? undefined : data);
      } catch { return send(res, 404, { error: 'not found' }); }
    }
    if (p === '/api/fleet') return send(res, 200, { now: new Date().toISOString(), dead_min: cfg.fleet.dead_min, kit: KIT_COMMIT, machines: fleet.list(cfg.fleet.dead_min).map((m) => ({ ...m, behind: behindOf(m.version) })) });
    if (p === '/api/backup') return send(res, 200, { remote: remoteShown(cfg.backup.remote), every_min: cfg.backup.every_min, ...backup.status(), ...backupNow() });
    if (p === '/api/review-triage') { void prStatus.refresh(reviewPrs()); return send(res, 200, reviewTriage()); }
    if (p === '/api/summary') return send(res, 200, { at: cfg.summary.at, summary: readSummary(ROOT) });
    // Who the sent token says you are (install.sh --join checks its token with it).
    if (p === '/api/whoami') {
      if (!tokenActor.has(req) && bearerOf(req)) {
        const raw = req.headers['x-dasks-actor'];
        const r = checkToken(bearerOf(req), typeof raw === 'string' && raw.trim() ? raw.trim() : undefined, tokenStore);
        if (!r.ok) return send(res, AUTH_STATUS[r.reason], { error: AUTH_ERROR[r.reason], rule: 'auth', reason: r.reason });
        tokenActor.set(req, r.actor); tokenMachine.set(req, r.machine);
      }
      return send(res, 200, { actor: tokenActor.get(req) ?? rawActor(req), machine: tokenMachine.get(req) ?? '', network: remoteReq.has(req) });
    }
    if (p === '/api/captain') {
      const l = lease.current();
      return send(res, 200, { lease: l ? { holder: l.holder, since: l.since, expires_at: l.expires_at } : null, harness: cfg.captain.harness, lease_sec: cfg.captain.lease_sec,
        auto_merge: cfg.captain.auto_merge, same_machine_review: cfg.captain.same_machine_review, chat_seq: chat.lastSeq });
    }
    if (p === '/api/captain/chat') {
      const q = url.searchParams.get('since') ?? '0';
      if (!/^\d{1,9}$/.test(q)) return send(res, 400, { error: 'since must be a message number' });
      return send(res, 200, { last_seq: chat.lastSeq, messages: chat.since(Number(q)) });
    }
    if (p === '/api/health') return health(res);
    if (p === '/api/session') {
      const sid = sessionCookie(req);
      const sessions = sid ? sessionsOrNull() : null;
      if (!sessions || !sessions.valid(sid)) return send(res, 401, { logged_in: false, login: true });
      return send(res, 200, { logged_in: true, csrf: sessions.csrf(sid), expires_at: new Date(sessions.expiry(sid)).toISOString() });
    }
    const dr = /^\/api\/decisions\/request\/([^/]+)$/.exec(p);
    if (dr) {
      const id = safeDecode(dr[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      const want = boardDecision(readTask(ROOT, id), true);
      return want ? send(res, 200, want) : send(res, 409, { error: `${id} is not asking for a decision` });
    }
    if (p === '/api/decisions') {
      const card = url.searchParams.get('card');
      return send(res, 200, readLedger(LEDGER).filter((e) => !card || e.card === card));
    }
    if (p === '/api/merge-ok') return mergeOkRead(res, url);
    if (p === '/api/board') {
      // check() and the roll-up only change with the data (or the date, for "late"): computed once per version and day,
      // and with the config that decides which lanes are valid.
      const key = `${version}|${localDate(new Date())}|${lanesKey()}`;
      if (boardCache?.key !== key) {
        const r = check(board);
        boardCache = { key, body: {
          version, northstar: board.northstar, goals: board.goals,
          // done_at: the move to done (activity), for "done in 24h"; `updated` moves with any note. Only recent cards are read.
          tasks: board.tasks.map((t) => { const o = publicTask(t); if (t.status !== 'done' || !(Date.now() - Date.parse(t.updated) < 7 * 86_400_000)) return o; const ms = lastDone(t.id); return ms === null ? o : { ...o, done_at: new Date(ms).toISOString() }; }),
          links: board.links, rollup: rollup(board),
          check: { errors: r.errors.length, warnings: r.warnings.length, issues: [...r.errors, ...r.warnings].slice(0, 20) },
          lanes: laneList(),
        } };
      }
      const { version: v0, ...rest } = boardCache.body;
      const now = new Date();
      const json = JSON.stringify({ version: v0, now: now.toISOString(), ...rest, projects: cfg.projects, stuck: stuckReport(board, now, cfg.stuck) });
      // Every open tab reads every task on each reload: gzip it for clients that accept it (browsers, fetch).
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
        return res.end(req.method === 'HEAD' ? undefined : gzipSync(json));
      }
      return send(res, 200, json);
    }
    if (p === '/api/decisions/today') return send(res, 200, decisionsToday(ROOT));
    if (p === '/api/tasks') return getTasks(req, res, url.searchParams);
    if (p === '/api/claims/dead') return deadClaims(res, url.searchParams);
    if (p === '/api/stuck') return send(res, 200, stuckReport(board, new Date(), cfg.stuck));
    if (p === '/api/ready') {
      const g = url.searchParams.get('goal'); const lim = Number(url.searchParams.get('limit') || 0);
      // Every item carries spec_state and spec_by. Only ready specs by default; ?all=1 (or ?require_spec_ready=0) is the
      // full queue. all=1 wins over require_spec_ready.
      const flag = (k: string) => { const v = url.searchParams.get(k); if (v !== null && !['0', '1', 'true', 'false'].includes(v)) throw new HttpError(400, `${k} must be 1 or 0`); return v === null ? null : v === '1' || v === 'true'; };
      const all = flag('all'), strict = flag('require_spec_ready');
      return send(res, 200, readyQueue(board, { missing_hours: cfg.stuck.missing_hours, goal: g ? g.split(',').map((s) => s.trim()).filter(Boolean) : null, limit: lim > 0 ? lim : undefined,
        spec: (t) => ({ spec_state: specIndex.facts.get(t.id)?.spec_state ?? 'none', spec_by: specIndex.facts.get(t.id)?.spec_by ?? null }), requireSpecReady: !(all === true || strict === false) }));
    }
    if (p === '/api/intake') {
      // Todo intake report: counts by goal, creator, id family, spec state; ?goal=a,b.
      const g = url.searchParams.get('goal'); const goals = g ? g.split(',').map((s) => s.trim()).filter(Boolean) : null;
      return send(res, 200, intakeReport(goals ? { tasks: board.tasks.filter((t) => goals.includes(t.goal)) } : board, specIndex.facts, new Date()));
    }
    // One-call agent start: rules, unread messages, mine, ready, review, as text lines.
    // Moves the caller's message read cursor (run/start-cursors/, not git data) unless ?peek=1.
    if (p === '/api/start') {
      const who = rawActor(req);
      if (!who) return send(res, 400, { error: 'start needs the caller (X-Dasks-Actor)' });
      const q = url.searchParams;
      const flag = (k: string) => { const v = q.get(k); if (v !== null && !['0', '1', 'true', 'false'].includes(v)) throw new HttpError(400, `${k} must be 1 or 0`); return v === null ? null : v === '1' || v === 'true'; };
      const readyQ = q.get('ready');
      if (readyQ !== null && !(/^\d{1,2}$/.test(readyQ) && Number(readyQ) >= 1 && Number(readyQ) <= 20)) return send(res, 400, { error: 'ready must be 1..20' });
      const list = (k: string) => { const v = q.get(k); return v === null ? null : v.split(',').map((s) => s.trim()).filter(Boolean); };
      const roles = list('roles');
      if (roles && !roles.every((r) => (MSG_ROLES as readonly string[]).includes(r))) return send(res, 400, { error: `roles must be from ${MSG_ROLES.join('|')}` });
      const rules = flag('rules'), peek = flag('peek'), strict = flag('spec_ready');
      const known = new Set(board.tasks.map((t) => t.id));
      const messages = new Map(cardsWithMessages(ROOT).filter((c) => known.has(c)).map((c) => [c, readMessages(ROOT, c)]));
      const out = startText({ board, actor: who, version, app: list('app')?.length ? list('app') : null, repo: q.get('repo') ?? '', rules: rules !== false, ready: readyQ === null ? undefined : Number(readyQ),
        roles: roles ?? undefined, requireSpecReady: !!strict, missingHours: cfg.stuck.missing_hours, messages, cursor: readCursor(ROOT, who), lessons: lessonSummaries(ROOT, board), families: cfg.families,
        spec: (t) => ({ spec_state: specIndex.facts.get(t.id)?.spec_state ?? 'none', spec_by: specIndex.facts.get(t.id)?.spec_by ?? null }) });
      if (!peek) moveCursor(ROOT, who, out.read);
      return send(res, 200, out.text + '\n', 'text/plain; charset=utf-8');
    }
    // Check items: the card's items, ?history=1 adds the append-only events.
    const ig = /^\/api\/tasks\/([^/]+)\/items$/.exec(p);
    if (ig) {
      const id = safeDecode(ig[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      const hq = url.searchParams.get('history');
      if (hq !== null && !['0', '1', 'true', 'false'].includes(hq)) return send(res, 400, { error: 'history must be 1 or 0' });
      if (!board.tasks.some((t) => t.id === id)) return send(res, 404, { error: 'not found' });
      return send(res, 200, itemsView(ROOT, id, { history: hq === '1' || hq === 'true' }));
    }
    // Card messages: list, long-poll wait, participants. Information only.
    const mr = /^\/api\/tasks\/([^/]+)\/(messages|messages\/wait|participants)$/.exec(p);
    if (mr) {
      const id = safeDecode(mr[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      const t = board.tasks.find((t) => t.id === id);
      if (!t) return send(res, 404, { error: 'not found' });
      const who = rawActor(req);
      if (mr[2] === 'participants') {
        return send(res, 200, { card: id, note: 'names are labels, not identities', participants: participants(id, t as any, readMessages(ROOT, id)) });
      }
      const f = parseFilter(url.searchParams);
      if (mr[2] === 'messages') {
        if (who) touch(id, who);
        const all = readMessages(ROOT, id);
        return send(res, 200, { card: id, last_seq: all.length ? all[all.length - 1].seq : 0, messages: filterMessages(all, f) });
      }
      const timeout = parseTimeout(url.searchParams.get('timeout'));
      const got = await waitMessages(ROOT, id, f, timeout, who, (fn) => res.on('close', fn));
      if (res.destroyed) return;
      const all = readMessages(ROOT, id);
      return send(res, 200, { card: id, last_seq: all.length ? all[all.length - 1].seq : 0, timed_out: got.length === 0, task_correlated: false, messages: got });
    }
    // Card spec store: the current spec or ?version=N.
    const sg = /^\/api\/tasks\/([^/]+)\/spec$/.exec(p);
    if (sg) {
      const id = safeDecode(sg[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      const version = parseVersionParam(url.searchParams.get('version'));
      if (!board.tasks.some((t) => t.id === id)) return send(res, 404, { error: 'not found' });
      return send(res, 200, readSpec(ROOT, id, version));
    }
    // Review run records: every stored pass in append order, answers included.
    const rg = /^\/api\/tasks\/([^/]+)\/review-runs$/.exec(p);
    if (rg) {
      const id = safeDecode(rg[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      if (!board.tasks.some((t) => t.id === id)) return send(res, 404, { error: 'not found' });
      return send(res, 200, { card: id, passes: readReviewRuns(ROOT, id) });
    }
    const m = /^\/api\/tasks\/([^/]+)$/.exec(p);
    if (m) {
      const id = safeDecode(m[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      const t = board.tasks.find((t) => t.id === id);
      if (!t) return send(res, 404, { error: 'not found' });
      const handoff = handoffOf(t.body);
      // ?log=N: only the newest N activity entries (agents read the summary plus these; MCP get_task asks for 8).
      const logQ = url.searchParams.get('log');
      if (logQ !== null && !/^\d{1,2}$/.test(logQ)) return send(res, 400, { error: 'log must be 0..50' });
      const all = readActivity(ROOT, id);
      const n = logQ === null ? 50 : Math.min(Number(logQ), 50);
      const activity = n ? all.slice(-n) : [];
      const items_progress = itemsProgress(ROOT, id); // only when the card has items
      return send(res, 200, { ...publicTask(t), activity, activity_total: all.length, activity_omitted: all.length - activity.length, outcomes: taskOutcomes(ROOT, id), routes: taskOutcomes(ROOT, id).flatMap((o) => o.route ? [o.route] : []), handoff, lessons: lessonsForTask(t.goal, handoff), ...(items_progress ? { items_progress } : {}) });
    }
    const jo = /^\/api\/jobs\/([^/]+)\/outcomes$/.exec(p);
    if (jo) return send(res, 200, jobOutcomes(ROOT, safeDecode(jo[1])));
    if (p === '/api/asks') return send(res, 200, asksDoc());
    if (p === '/asks.md') return send(res, 200, asksMarkdown(asksDoc()), 'text/markdown; charset=utf-8');
    if (p === '/api/views') return send(res, 200, viewSummaries(ROOT, board));
    const v = /^\/api\/views\/([^/]+)$/.exec(p);
    if (v) {
      const app = safeDecode(v[1]);
      assertProject(board, app);
      return send(res, 200, { ...readView(ROOT, app), url: `/p/${app}`, activity: readViewActivity(ROOT, app, 10) });
    }
    if (p === '/api/ideas') return send(res, 200, ideaSummaries(ROOT, board));
    const iv = /^\/api\/ideas\/([^/]+)$/.exec(p);
    if (iv) {
      const app = safeDecode(iv[1]);
      assertProject(board, app);
      const st = url.searchParams.get('status');
      const want = st ? st.split(',').map((s) => s.trim()).filter(Boolean) : null;
      if (want && !want.every((s) => (IDEA_STATUSES as readonly string[]).includes(s))) return send(res, 400, { error: `status must be ${IDEA_STATUSES.join('|')}` });
      const f = readIdeas(ROOT, app);
      return send(res, 200, { ...f, ideas: want ? f.ideas.filter((i) => want.includes(i.status)) : f.ideas, url: `/p/${app}`, activity: readIdeaActivity(ROOT, app, 10) });
    }
    if (p === '/api/lessons') return send(res, 200, lessonSummaries(ROOT, board));
    const lv = /^\/api\/lessons\/([^/]+)$/.exec(p);
    if (lv) {
      const app = safeDecode(lv[1]);
      assertProject(board, app);
      const st = url.searchParams.get('status');
      const want = st ? st.split(',').map((s) => s.trim()).filter(Boolean) : null;
      if (want && !want.every((s) => (LESSON_STATUSES as readonly string[]).includes(s))) return send(res, 400, { error: `status must be ${LESSON_STATUSES.join('|')}` });
      const f = readLessons(ROOT, app);
      // ?files=a,b and/or ?limit=N: the relevant live lessons (closest files first), as a task read gets them.
      const files = url.searchParams.get('files');
      const lim = url.searchParams.get('limit');
      if (files !== null || lim !== null) {
        const n = lim === null ? DEFAULT_RELEVANT : Number(lim);
        if (!Number.isInteger(n) || n < 1 || n > 50) return send(res, 400, { error: 'limit must be 1..50' });
        // status filters before ranking, so `limit` counts only lessons of the asked status
        return send(res, 200, { ...f, lessons: relevantLessons(want ? { ...f, lessons: f.lessons.filter((l) => want.includes(l.status)) } : f, lessonFiles(files ?? '', MAX_TASK_FILES), n) });
      }
      return send(res, 200, { ...f, lessons: want ? f.lessons.filter((l) => want.includes(l.status)) : f.lessons });
    }
    if (p === '/api/links') return send(res, 200, board.links);
    if (p === '/api/digest') {
      let since = url.searchParams.get('since') || new Date(Date.now() - 24 * 3600_000).toISOString();
      if (Number.isNaN(Date.parse(since))) return send(res, 400, { error: 'since must be an ISO date/time' });
      // Walking git history runs on the request thread: at most the last 7 days.
      const floor = Date.now() - 7 * 24 * 3600_000;
      if (Date.parse(since) < floor) { since = new Date(floor).toISOString(); res.setHeader('X-Dasks-Warning', encodeURIComponent('since clamped to the last 7 days')); }
      // Same HEAD and window (to the minute) = same text: cache it, so repeated calls do not walk history again.
      const dkey = `${headOf()}|${Date.parse(since)}|${Math.floor(Date.now() / 60_000)}`;
      if (digestCache?.key !== dkey) digestCache = { key: dkey, text: digestText(ROOT, since) };
      return send(res, 200, digestCache.text, 'text/plain; charset=utf-8');
    }
    if (p === '/api/events') {
      if (clients.size >= MAX_LISTENERS) return send(res, 503, { error: 'too many listeners' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...SECURITY_HEADERS });
      res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ version, boot: BOOT })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    return send(res, 404, { error: 'not found' });
  }

  // Human routes: checked before any body is read. Nothing else under /api/session or /api/decisions writes.
  if (req.method === 'POST' && p === '/api/session') return login(req, res);
  if (req.method === 'POST' && p === '/api/session/logout') {
    const h = requireHuman(req, sessionsOrNull);
    sessionsOrNull()!.revoke(h.sid);
    res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/decisions') return decide(req, res);
  const aa = req.method === 'POST' ? /^\/api\/asks\/([^/]+)\/answer$/.exec(p) : null;
  if (aa) return answerAsk(req, res, safeDecode(aa[1]), actor);
  if (/^\/api\/(session|decisions)(\/|$)/.test(p)) return send(res, 405, { error: 'method not allowed' });

  if (req.method === 'PUT' || req.method === 'POST') {
    if (!originOk(req)) return send(res, 403, { error: 'cross-origin write refused' });
    // PUT /spec takes a spec up to 256 KB, which JSON escapes can blow up to ~1.5 MiB: its own raw limit, checked first.
    const sp = req.method === 'PUT' ? /^\/api\/tasks\/([^/]+)\/spec$/.exec(p) : null;
    // POST /review-runs takes an answer up to 256 KB: the same 2 MiB raw limit, for this route only.
    const rr = req.method === 'POST' ? /^\/api\/tasks\/([^/]+)\/review-runs$/.exec(p) : null;
    const body = await readJson(req, sp ? SPEC_MAX_BODY : rr ? REVIEW_RUN_MAX_BODY : MAX_BODY, !!(sp || rr));
    if (actor === 'user') requireHuman(req, sessionsOrNull); // again: the session may have been logged out mid-body
    // PUT /api/tasks/:id/spec {text, expected_spec_version, note?}: shape 400 → task 404 → size 413 → version 409 →
    // contract 422 → a new version.
    if (sp) {
      const id = safeDecode(sp[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      if (!rawActor(req)) return send(res, 400, { error: 'a spec write must name its writer (X-Dasks-Actor)' });
      const put = parseSpecPut(body);
      if (!board.tasks.some((t) => t.id === id)) return send(res, 404, { error: 'not found' });
      assertSpecSize(put.text);
      specIndexGuard(res)();
      const out = writeSpec(ROOT, id, put, actor);
      reloadAfterWrite(); // the task's spec fields may have changed in the same commit
      return send(res, 200, out);
    }
    // POST /api/tasks/:id/review-runs: id/actor 400 → shape 400/413 → task 404 → pass rules 409 (under the lock) → one
    // commit appending the row. No claim check: the reviewing session may not be the claimant.
    if (rr) {
      const id = safeDecode(rr[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      if (!rawActor(req)) return send(res, 400, { error: 'a review run must name its writer (X-Dasks-Actor)' });
      const row = parseReviewRun(body);
      if (!board.tasks.some((t) => t.id === id)) return send(res, 404, { error: 'not found' });
      return send(res, 201, { card: id, row: appendReviewRun(ROOT, id, row, actor, new Date(), { families: cfg.families, claimedBy: board.tasks.find((t) => t.id === id)?.claimed_by, machine: tokenMachine.get(req) ?? '' }) });
    }
    // Check items: POST …/items/seed {expected_version?} and POST …/items/<n> {state, result?,
    // evidence?, host?, expected_version?}. Shape 400 → task 404 → store 500 → item 404 → version 409. Never touches the task.
    const iw = req.method === 'POST' ? /^\/api\/tasks\/([^/]+)\/items\/([^/]+)$/.exec(p) : null;
    if (iw) {
      const id = safeDecode(iw[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      const which = safeDecode(iw[2]);
      return send(res, 200, which === 'seed' ? seedItems(ROOT, id, body, actor) : reportItem(ROOT, id, which, body, actor));
    }
    // PUT (or POST, for clients that only POST) /api/views/<app>: the whole view {title?, tagline?, structure?, widgets},
    // optional expected_version. POST /api/views/<app>/structure {structure, expected_version?} changes only the structure.
    const v = /^\/api\/views\/([^/]+?)(\/structure)?$/.exec(p);
    if (v) {
      const app = safeDecode(v[1]);
      const { expected_version, ...view } = body;
      const ev = versionOf(expected_version);
      if (v[2] && Object.keys(view).some((k) => k !== 'structure')) return send(res, 400, { error: 'structure takes {structure, expected_version?}' });
      const out = writeView(ROOT, app, view, actor, { expectedVersion: ev, structureOnly: !!v[2] });
      reloadAfterWrite();
      return send(res, 200, { ...out, url: `/p/${app}` });
    }
    if (req.method === 'PUT') return send(res, 405, { error: 'PUT is only for /api/views/<app> and /api/tasks/<id>/spec' });
    // Ideas: POST /api/ideas/<app> adds one; POST /api/ideas/<app>/<id> edits it; POST …/<id>/promote makes it a task.
    const ia = /^\/api\/ideas\/([^/]+)(?:\/([^/]+)(\/promote)?)?$/.exec(p);
    if (ia) {
      const app = safeDecode(ia[1]);
      const { expected_version, ...fields } = body;
      const ev = versionOf(expected_version);
      if (!ia[2]) {
        if (ev !== undefined) return send(res, 400, { error: 'adding an idea takes no expected_version' });
        const idea = addIdea(ROOT, app, fields, actor);
        reloadAfterWrite();
        return send(res, 201, idea);
      }
      const id = safeDecode(ia[2]);
      const out = ia[3] ? promoteIdea(ROOT, app, id, fields, actor, { expectedVersion: ev }) : updateIdea(ROOT, app, id, fields, actor, { expectedVersion: ev });
      reloadAfterWrite();
      return send(res, ia[3] ? 201 : 200, ia[3] ? { ...out, task: publicTask((out as any).task) } : out);
    }
    // Lessons: POST /api/lessons/<app> {text, files?, task?} adds one; POST /api/lessons/<app>/<id> {text?, files?, status?} edits it.
    const la = /^\/api\/lessons\/([^/]+)(?:\/([^/]+))?$/.exec(p);
    if (la) {
      const app = safeDecode(la[1]);
      const { expected_version, ...fields } = body;
      const ev = versionOf(expected_version);
      if (!la[2]) {
        if (ev !== undefined) return send(res, 400, { error: 'adding a lesson takes no expected_version' });
        const lesson = addLesson(ROOT, app, fields, actor);
        reloadAfterWrite();
        return send(res, 201, lesson);
      }
      const out = updateLesson(ROOT, app, safeDecode(la[2]), fields, actor, { expectedVersion: ev });
      reloadAfterWrite();
      return send(res, 200, out);
    }
    if (p === '/api/backup/now') {
      if (!cfg.backup.remote) return send(res, 409, { error: 'backup.remote is not set in config.json (docs/upgrade.md)' });
      const st = await backup.tick(true);
      return send(res, st.failures ? 502 : 200, { remote: remoteShown(cfg.backup.remote), every_min: cfg.backup.every_min, ...st, ...backupNow() });
    }
    if (p === '/api/fleet/heartbeat') {
      const h = parseHeartbeat(body);
      const m = tokenMachine.get(req);
      if (m && m !== h.machine) return send(res, 403, { error: `this token belongs to machine ${m}, not ${h.machine}` });
      if (!/^runner@/.test(actor) || actor !== `runner@${h.machine}`) return send(res, 400, { error: `a heartbeat comes from runner@${h.machine}` });
      return send(res, 200, fleet.beat(h, actor));
    }
    // Does the caller hold the live lease under this id? `dask captain-merge` asks before it checks and again right
    // before it merges.
    if (p === '/api/captain/lease/check') {
      const { lease_id } = parseLeaseCheck(body);
      const l = lease.current();
      if (!lease.holds(actor, lease_id)) return send(res, 409, { error: `${actor} does not hold the live captain lease under that id${l ? ` (held by ${l.holder})` : ' (none now)'}`, rule: 'captain-lease', holder: l?.holder ?? '' });
      return send(res, 200, { ok: true, holder: l!.holder, expires_at: l!.expires_at });
    }
    if (p === '/api/captain/lease' || p === '/api/captain/lease/release') {
      if (actor === 'user' || !rawActor(req)) return send(res, 400, { error: 'the captain lease is taken by an agent (X-Dasks-Actor)' });
      const { holder, ttl_sec, lease_id } = parseLease(body);
      if (p.endsWith('/release')) { lease.release(String(lease_id ?? '')); return send(res, 200, { ok: true }); }
      if (holder !== undefined && holder !== actor) return send(res, 403, { error: `holder must be the caller (${actor})` });
      const ttl = ttl_sec === undefined ? cfg.captain.lease_sec : Number(ttl_sec);
      if (!Number.isInteger(ttl) || ttl < 10 || ttl > 3600) return send(res, 400, { error: 'ttl_sec must be 10-3600' });
      return send(res, 200, { ...lease.take(actor, ttl, lease_id), now: new Date().toISOString() }); // now: the board's clock, for the time left
    }
    if (p === '/api/captain/chat') {
      const msg = parseChat(body, actor === 'user');
      // An agent writes only as the lease holder and with the live lease id: the holder's name alone is not enough,
      // since every session on that machine may use it.
      if (actor !== 'user' && !lease.holds(actor, msg.lease_id)) {
        const l = lease.current();
        return send(res, 403, { error: `only the captain (the lease holder${l ? `: ${l.holder}` : ', none now'}, with its lease_id) and the logged-in human write here`, rule: 'captain-lease' });
      }
      return send(res, 201, chat.post(actor, msg.text));
    }
    if (p === '/api/tasks') {
      const { opts, rest } = writeOpts(body);
      // force: true skips the near-duplicate check (never the limit); it is not stored on the task.
      const { force, ...fields } = rest;
      if (force !== undefined && typeof force !== 'boolean') return send(res, 400, { error: 'force must be true or false' });
      const copts: CreateOpts = { context: opts.context, exempt: opts.exempt, warnings: opts.warnings, intake: cfg.intake, force: force === true };
      const made = createTaskOrIdea(ROOT, fields, actor, new Date(), copts);
      // Over the goal's todo limit: no task, the create is an idea of the goal (202).
      if ('intake' in made) {
        res.setHeader('X-Dasks-Intake', `idea:${made.idea.id}`);
        reloadAfterWrite();
        return send(res, 202, made);
      }
      const t = made;
      // A retry of a recent identical create: 200 with the first task.
      if (copts.replayed) res.setHeader('X-Dasks-Replayed', t.id);
      else reloadAfterWrite();
      setWarningHeader(opts.warnings!, res);
      return send(res, copts.replayed ? 200 : 201, opts.warnings!.length ? { ...publicTask(t), warnings: opts.warnings } : publicTask(t));
    }
    // User decisions: POST /api/asks/preview {ask} renders the shape (and the spec's ## Conflicts section), writes nothing;
    // POST /api/asks/<card> {ask} flags one decision (agents only; the card goes to blocked-on-user).
    if (req.method === 'POST' && p === '/api/asks/preview') {
      const errs = validateAsk(body);
      if (errs.length) return send(res, 400, { error: `not the decision shape: ${errs.join('; ')}`, reasons: errs });
      return send(res, 200, { text: askText(pickAsk(body)), section: conflictsSection([pickAsk(body)]) });
    }
    const ak = req.method === 'POST' ? /^\/api\/asks\/([^/]+)$/.exec(p) : null;
    if (ak) {
      const id = safeDecode(ak[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      if (actor === 'user') return send(res, 403, { error: 'agents ask the user; the human answers in the queue (/asks)' });
      const who = rawActor(req);
      if (!who) return send(res, 400, { error: 'a decision request must name its writer (X-Dasks-Actor)' });
      if (!board.tasks.some((t) => t.id === id)) return send(res, 404, { error: 'not found' });
      const out = createAsk(ROOT, id, body, who);
      reloadAfterWrite();
      return send(res, 201, { ask: out.ask, text: out.text, section: conflictsSection([out.ask]), task: publicTask(out.task) });
    }
    const mp = /^\/api\/tasks\/([^/]+)\/messages$/.exec(p);
    if (mp) {
      const id = safeDecode(mp[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      if (!board.tasks.some((t) => t.id === id)) return send(res, 404, { error: 'not found' });
      const who = actor === 'user' ? 'user' : rawActor(req);
      const out = postMessage(ROOT, id, body, who);
      return send(res, out.duplicate ? 200 : 201, { ...out.message, duplicate: out.duplicate });
    }
    const resetRoute = /^\/api\/tasks\/([^/]+)\/reset-attempts$/.exec(p);
    if (resetRoute) {
      const { opts, rest } = writeOpts(body);
      const { reason } = parseResetAttempts(rest);
      const rid = safeDecode(resetRoute[1]);
      const t = withRepoLock(ROOT, () => resetAttempts(ROOT, rid, reason, actor, { ...opts, ...(actor === 'user' ? { statusGate: (cur: Task) => receiptFirst(cur) } : {}) }));
      reloadAfterWrite();
      return send(res, 200, publicTask(t));
    }
    const jobRoute = /^\/api\/jobs\/([^/]+)\/outcome$/.exec(p);
    if (jobRoute) {
      const out = recordJobOutcome(ROOT, safeDecode(jobRoute[1]), body, actor);
      reloadAfterWrite();
      return send(res, 200, out);
    }
    const outcomeRoute = /^\/api\/tasks\/([^/]+)\/(outcome|outcome-or-fail)$/.exec(p);
    if (outcomeRoute) {
      const id = safeDecode(outcomeRoute[1]);
      const missing = outcomeRoute[2] === 'outcome-or-fail';
      const input = missing ? parseOutcomeOrFail(body) : body;
      const { opts } = writeOpts(body);
      const t = recordOutcome(ROOT, id, input, actor, opts, missing);
      reloadAfterWrite();
      setWarningHeader(opts.warnings!, res);
      return send(res, 200, opts.warnings!.length ? { ...publicTask(t), warnings: opts.warnings } : publicTask(t));
    }
    // Spec review, block and unblock: a named writer, exact bodies, the updated task back.
    const ss = /^\/api\/tasks\/([^/]+)\/spec\/(review|block|unblock)$/.exec(p);
    if (ss) {
      const id = safeDecode(ss[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      if (!rawActor(req)) return send(res, 400, { error: `a spec ${ss[2]} must name its writer (X-Dasks-Actor)` });
      const gate = specIndexGuard(res);
      const t = ss[2] === 'review' ? reviewSpec(ROOT, id, body, actor, cfg.families, new Date(), gate) : ss[2] === 'block' ? blockSpec(ROOT, id, body, actor, new Date(), gate) : unblockSpec(ROOT, id, body, actor, new Date(), gate);
      reloadAfterWrite();
      return send(res, 200, publicTask(t));
    }
    const c = /^\/api\/tasks\/([^/]+)\/(claim|release|finish)$/.exec(p);
    if (c) {
      const id = safeDecode(c[1]); taskOrThrow(id);
      const { opts, rest } = writeOpts(body);
      const op = c[2] as 'claim' | 'release' | 'finish';
      const { who, force, note, result, pr, pr_summary, status, summary, run_id, exclusive_touches } = parseCardAction(op, rest);
      let fields: Record<string, unknown> = {};
      if (op === 'finish') {
        // No status given: a PR goes to review; a result with a log or RESULT.md path is done; anything else needs a reviewer.
        // (gates: warn keeps done as the default, so a finish without a PR is not pushed into review and its context rule.)
        const st = status ?? (pr ? 'review' : taskEvidence({ pr: '', result: result! }) || loadConfig(ROOT).gates !== 'enforce' ? 'done' : 'review');
        fields = { result, status: st };
        if (pr !== undefined) fields.pr = pr;
        if (pr_summary !== undefined) fields.pr_summary = pr_summary;
        opts.action = 'finish';
        opts.holderOnly = { force: bool(force) };
      } else {
        opts.claim = { op, who: whoOf(who, actor), force: bool(force), ...(run_id ? { runId: run_id.trim() } : {}) };
        opts.action = c[2];
      }
      // The handoff summary (≤5 lines) rides along with a finish or a release: the next agent reads it first.
      if (summary !== undefined) fields.summary = summary;
      opts.appendNote = note;
      if (actor === 'user') opts.statusGate = needsReceipt;
      opts.specGate = specIndexGuard(res); // updateTask calls it under the lock, after the task is read (claims only)
      const t = withRepoLock(ROOT, () => {
        if (c[2] === 'finish') opts.appendNote = unparkWrite(id, fields, actor, note, `${result ?? ''} ${note ?? ''}`, opts);
        if (exclusive_touches === true) {
          const key = repoKey(readTask(ROOT, id).goal, cfg.projects);
          const peers = board.tasks.filter((t) => t.id !== id && repoKey(t.goal, cfg.projects) === key).map((t) => readTask(ROOT, t.id));
          assertTouchesFree(ROOT, readTask(ROOT, id), peers, cfg.projects);
        }
        return updateTask(ROOT, id, fields, actor, opts);
      });
      reloadAfterWrite();
      setWarningHeader(opts.warnings!, res);
      return send(res, 200, { ...publicTask(t), warnings: opts.warnings });
    }
    if (/^\/api\/tasks\/[^/]+\/spec$/.test(p)) return send(res, 405, { error: `${req.method} is not allowed on a spec: GET reads it, PUT stores a new version` });
    const m = /^\/api\/tasks\/([^/]+)$/.exec(p);
    if (m) {
      const id = safeDecode(m[1]);
      if (!isTaskId(id)) return send(res, 400, { error: 'bad task id' });
      const { opts, rest } = writeOpts(body);
      const { if_status, body: newBody, note, append_block, housekeeping, reopen, job_end, push, sweep, fields } = parseTaskPatch(rest);
      // status → doing takes the card like a claim: updateTask runs the same spec-index guard under the lock.
      opts.specGate = specIndexGuard(res);
      // job_end (a runner's finish): the run's outcome is the one status change of a job end. If it is already
      // recorded the close keeps the status; otherwise this write moves the card and leaves a marker so a late outcome
      // for the same run does not move it again.
      const t = withRepoLock(ROOT, () => {
        if (job_end !== undefined) {
          const cur = readTask(ROOT, id);
          if (cur.run_id === job_end.trim()) {
            const marker = jobEndRel(id, cur.run_id!, Number(cur.attempt));
            if (runOutcome(ROOT, cur) || fs.existsSync(path.join(ROOT, marker))) {
              // The run's job end already moved the card (its outcome, or an earlier close): a replayed close keeps the status.
              delete fields.status; opts.context = undefined;
              opts.warnings!.push('status kept: this run\'s outcome or an earlier close already moved the card');
            } else if (fields.status !== undefined && fields.status !== cur.status) {
              opts.extraFiles = [{ rel: marker, content: JSON.stringify({ id, run_id: cur.run_id, attempt: Number(cur.attempt), from: cur.status, to: fields.status, actor }) + '\n' }];
            }
          } else {
            // An older run's close (or one for a card with no run): it must not move the current run's card. The note,
            // result and PR still land; the status and its context block do not.
            delete fields.status; opts.context = undefined;
            opts.warnings!.push('status kept: job_end is for an older run');
          }
        }
        const appendNote = unparkWrite(id, fields, actor, note, `${String(fields.needs_user ?? '')} ${note ?? ''}`, opts, sweep);
        askRuleWrite(id, fields, actor, opts);
        return updateTask(ROOT, id, fields, actor, { ...opts, ifStatus: if_status, body: newBody, appendNote, appendBlock: append_block, housekeeping: bool(housekeeping), reopen: bool(reopen), push, ...(actor === 'user' ? { statusGate: needsReceipt } : {}) });
      });
      reloadAfterWrite();
      setWarningHeader(opts.warnings!, res);
      return send(res, 200, opts.warnings!.length ? { ...publicTask(t), warnings: opts.warnings } : publicTask(t));
    }
    const n = /^\/api\/nodes\/([^/]+)$/.exec(p);
    if (n) {
      const { expected_title, if_missing, expected, patch } = parseNodePatch(body);
      updateNode(ROOT, safeDecode(n[1]), patch, actor, { expectedTitle: expected_title, ifMissing: bool(if_missing), expected });
      reloadAfterWrite();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }
  return send(res, 405, { error: 'method not allowed' });
}

function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  handle(req, res).catch((e) => {
    if (res.headersSent) { res.end(); return; }
    if (e instanceof HttpError) {
      // 503 = nothing was written (repo busy, git failing): tell clients when to try again.
      if (e.status === 503) res.setHeader('Retry-After', String((e.data as any)?.retry_after ?? 1));
      return send(res, e.status, { error: e.message, ...(e.data ?? {}) });
    }
    console.error(e);
    send(res, 500, { error: 'internal error' });
  });
}

// ---------- listen ----------
const servers: http.Server[] = [];
let stopping = false;
/** SIGTERM/SIGINT (launchctl kickstart -k, kill): stop accepting, let in-flight requests finish (max 5 s), then exit.
 *  Clients (MCP, dasks CLI) retry refused connections, so a restart costs them a short wait, not an error. */
function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${sig}: draining`);
  for (const c of clients) c.end();
  let open = servers.length;
  const done = () => { if (--open <= 0) process.exit(0); };
  for (const s of servers) { s.close(done); s.closeIdleConnections(); }
  if (!servers.length) process.exit(0);
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function listenOn(host: string, port: number, network = false): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    if (!network && !isAllowedBindHost(host)) return reject(new Error(`refusing to bind ${host}`));
    // On the network address every request is remote, except (on a wildcard) one from this Mac's own loopback.
    const handler: http.RequestListener = network ? (req, res) => { if (!(isWildcard(host) && isLoopback(req.socket.remoteAddress ?? ''))) remoteReq.add(req); onRequest(req, res); } : onRequest;
    const s: http.Server = TLS ? https.createServer({ ...TLS, minVersion: 'TLSv1.2' }, handler) : http.createServer(handler);
    s.requestTimeout = 30_000;
    s.headersTimeout = 15_000;
    s.once('error', reject);
    s.listen(port, host, () => { s.off('error', reject); servers.push(s); resolve(s); });
  });
}

async function main() {
  const loopback = cfg.server.hosts.find((h) => h === '127.0.0.1') ?? cfg.server.hosts[0];
  // No silent port fallback: workers and the LaunchAgent are configured for server.port. If it is taken, fail loudly;
  // pick another port by setting server.port in config.json (the worker URL follows it).
  const port = Number(process.env.DASKS_PORT) || cfg.server.port;
  const listen = cfg.server.listen;
  if (NETWORK && !isWildcard(listen)) cfg.server.extra_allowed_hosts = [...cfg.server.extra_allowed_hosts, listen.includes(':') ? `[${listen}]` : listen];
  const wire = TLS ? '; TLS' : isLoopback(listen) ? '' : '; PLAIN HTTP: server.allow_plain_http is set, tokens and the passphrase travel in clear';
  if (NETWORK && isWildcard(listen)) await listenOn(listen, port, true);
  else await listenOn(loopback, port);
  setAllowedHosts(port);
  if (!(NETWORK && isWildcard(listen))) console.log(`dasks listening on ${SCHEME}://${loopback}:${port}`);
  if (cfg.auth.mode !== 'off') console.error(tokenStoreReport(tokenStoreCfg));
  for (const host of cfg.server.hosts.filter((h) => h !== loopback)) {
    const attempt = () => listenOn(host, port)
      .then(() => console.log(`dasks listening on ${SCHEME}://${host}:${port}`))
      .catch((e) => { console.error(`bind ${host}:${port} failed (${e.code || e.message}); retrying in 15s`); setTimeout(attempt, 15_000); });
    attempt();
  }
  if (NETWORK && !isWildcard(listen)) {
    await listenOn(listen, port, true);
    console.log(`dasks listening on ${SCHEME}://${listen.includes(':') ? `[${listen}]` : listen}:${port} (network: machine tokens or the board login${wire})`);
  } else if (NETWORK) console.log(`dasks listening on every address, port ${port}, ${SCHEME} (network: machine tokens or the board login${wire})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
