// Board settings: <root>/config.json (DASKS_CONFIG overrides the path) over the defaults below. The installer writes the
// first config.json; edit it and restart the server to change projects, lanes or limits.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ACTOR_RE, isFamily, GOAL_ID_RE, LANE_RE, setProjects } from './schema.ts';
import { dasksHome } from './connection.mjs';
import { backupConfigErrors, DEFAULT_BACKUP, type BackupConfig } from './backup.ts';

export interface StuckConfig {
  doing_hours: number;
  review_hours: number;
  ready_idle_hours: number;
  missing_hours: number;
  top_n: number;
}

export const DEFAULT_STUCK: StuckConfig = { doing_hours: 6, review_hours: 24, ready_idle_hours: 24, missing_hours: 24, top_n: 5 };

/** One project of this board: a goal file data/goals/<id>.yaml must exist for it (`dasks-check`). `owner` is the actor
 *  who owns its cards when a card names no owner (default: the board's human, "user"). */
export interface Project { id: string; name: string; owner?: string; /** Local git checkout the card runner builds this project's cards in (bin/dasks-runner). */ repo?: string }

export interface Config {
  /** listen: one more address to serve on besides 127.0.0.1, for a fleet of Macs (docs/fleet.md). Not loopback = auth
   *  must be enforce, and requests on it need a machine token or the human's login. */
  server: {
    hosts: string[]; port: number; extra_allowed_hosts: string[]; listen: string;
    /** PEM files: when set, every listener serves HTTPS (docs/fleet.md). A listen address beyond this Mac needs it. */
    tls?: { cert: string; key: string };
    /** Serve a non-loopback listen address over plain HTTP anyway. Unsafe: tokens and the passphrase travel in clear. */
    allow_plain_http: boolean;
  };
  /** The projects this board tracks, in display order. A fresh install has one: demo. */
  projects: Project[];
  /** Extra lanes cards may name, beyond the built-in ones (claude, codex, none, spec-rework, failed-terminal). */
  lanes: string[];
  stuck: StuckConfig;
  stale_hours: number;
  /** Extra actors allowed to move tasks to review/blocked-on-user without the context block (built in: user). */
  context_exempt_actors: string[];
  decisions_dir: string;
  retry_cap: number;
  /** Failed runs with cause quota / rate-limit do not count toward retry_cap; this many of them in one reset epoch cap the card. */
  quota_retry_cap: number;
  /** Failed runs with cause infra (the job could not run: src/lib/park.ts) do not count toward retry_cap either; this many of
   *  them in one reset epoch send the card back to its spec (lane spec-rework). */
  infra_retry_cap: number;
  /** Model family per actor for the text review of any card (docs/cards.md "Spec review"): exact id or `prefix*`. */
  families: Record<string, string>;
  /** Transition/evidence gates (src/lib/transitions.ts): "warn" lets the write through with a warning and logs it to
   *  run/gate-warnings.jsonl; "enforce" refuses it (409). Env DASKS_GATES overrides. */
  gates: 'warn' | 'enforce';
  /** needs_user wording rule (src/lib/ask-rule.ts) on POST /api/tasks/:id by any actor but the human: "enforce" refuses a
   *  bad ask (400 + reasons), "warn" lets it through with a warning. Env DASKS_ASK_RULE overrides. */
  ask_rule: 'warn' | 'enforce';
  /** Agent tokens (docs/auth.md). mode: "enforce" (default) refuses an agent write without a valid token (401/403/503);
   *  "warn" lets it through and logs it to run/auth-warnings.jsonl; "off" ignores tokens. Env DASKS_AUTH_MODE overrides.
   *  store: "user" (~/.dasks/agent-tokens.json, made by install.sh) or "system" (root-owned, sudo bin/dasks-tokens.ts). */
  auth: { mode: 'off' | 'warn' | 'enforce'; store: 'user' | 'system' };
  /** Card intake brake. todo_limit: open todo cards per
   *  goal at most (0 = off); goal_limits: per-goal override; exempt_actors: never limited nor near-duplicate checked;
   *  dup_check: refuse (409) a create that repeats an open card's title or slug. */
  intake: IntakeConfig;
  /** Runner heartbeats (docs/fleet.md): a machine quiet for dead_min loses the cards its runner holds. */
  fleet: FleetConfig;
  /** The captain session (docs/captain.md): the harness chain, first one on PATH wins; the lease length. */
  captain: CaptainConfig;
  /** Push the data repo's commits to a remote the owner provides (src/lib/backup.ts); remote "" = off. */
  backup: BackupConfig;
  /** The daily summary (src/lib/summary.ts): written once a day at `at` (HH:MM, this Mac's time zone). */
  summary: SummaryConfig;
  /** The review triage page (src/lib/triage.ts): a card in review with no activity for stale_days is stale. */
  review: ReviewConfig;
}

export interface SummaryConfig { at: string }
export interface ReviewConfig { stale_days: number }
export const DEFAULT_SUMMARY: SummaryConfig = { at: '08:30' };
export const DEFAULT_REVIEW: ReviewConfig = { stale_days: 3 };

export interface FleetConfig { dead_min: number }
/** auto_merge: captain-merge merges on its own (else a clean card waits for the human's merge OK at its head);
 *  same_machine_review: with auto_merge, a review sent from a builder's machine counts too. Both off by default: one OS
 *  account can write as any of its models, so the board cannot tell which model wrote a review on that machine. */
export interface CaptainConfig { harness: string[]; lease_sec: number; auto_merge: boolean; same_machine_review: boolean }
export const DEFAULT_FLEET: FleetConfig = { dead_min: 15 };
export const DEFAULT_CAPTAIN: CaptainConfig = { harness: ['claude', 'codex'], lease_sec: 300, auto_merge: false, same_machine_review: false };

export interface IntakeConfig { todo_limit: number; goal_limits: Record<string, number>; exempt_actors: string[]; dup_check: boolean }
export const DEFAULT_INTAKE: IntakeConfig = { todo_limit: 100, goal_limits: {}, exempt_actors: ['user'], dup_check: true };

/** Config `intake` problems; with goalIds, goal_limits keys must be known goals (the server checks at startup). */
export function intakeConfigErrors(i: IntakeConfig, goalIds?: readonly string[]): string[] {
  const e: string[] = [];
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  if (!count(i.todo_limit)) e.push('intake.todo_limit must be a non-negative integer');
  if (!i.goal_limits || typeof i.goal_limits !== 'object' || Array.isArray(i.goal_limits)) e.push('intake.goal_limits must map goal ids to non-negative integers');
  else for (const [g, n] of Object.entries(i.goal_limits)) {
    if (!GOAL_ID_RE.test(g) || (goalIds && !goalIds.includes(g))) e.push(`intake.goal_limits: "${g}" is not a known goal id`);
    if (!count(n)) e.push(`intake.goal_limits.${g} must be a non-negative integer`);
  }
  if (!Array.isArray(i.exempt_actors) || !i.exempt_actors.every((a) => typeof a === 'string' && ACTOR_RE.test(a))) e.push('intake.exempt_actors must be a list of actor ids');
  if (typeof i.dup_check !== 'boolean') e.push('intake.dup_check must be true or false');
  return e;
}

/** Config `projects` problems: a list of {id, name, owner?} with unique goal ids. */
export function projectsConfigErrors(list: unknown): string[] {
  if (!Array.isArray(list)) return ['projects must be a list of {id, name, owner?}'];
  const e: string[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) { e.push('projects: every entry must be {id, name, owner?}'); continue; }
    if (typeof p.id !== 'string' || !GOAL_ID_RE.test(p.id)) e.push(`projects: "${String(p.id)}" is not a project id (lowercase letters and digits, starting with a letter, ≤24)`);
    else if (seen.has(p.id)) e.push(`projects: "${p.id}" is listed twice`);
    else seen.add(p.id);
    if (typeof p.name !== 'string' || !p.name.trim()) e.push(`projects.${String(p.id)}: name must be a non-empty string`);
    if (p.owner !== undefined && (typeof p.owner !== 'string' || !ACTOR_RE.test(p.owner))) e.push(`projects.${String(p.id)}: owner must be an actor name`);
    if (p.repo !== undefined && (typeof p.repo !== 'string' || !p.repo.trim() || /[\r\n\0]/.test(p.repo))) e.push(`projects.${String(p.id)}: repo must be the path of a local git checkout`);
  }
  return e;
}

export const DEFAULT_CONFIG: Config = {
  server: { hosts: ['127.0.0.1'], port: 4747, extra_allowed_hosts: [], listen: '127.0.0.1', allow_plain_http: false },
  projects: [],
  lanes: [],
  stuck: DEFAULT_STUCK,
  stale_hours: 6,
  families: {},
  context_exempt_actors: [],
  decisions_dir: 'run/decisions',
  retry_cap: 2,
  quota_retry_cap: 10,
  infra_retry_cap: 3,
  gates: 'warn',
  ask_rule: 'enforce',
  auth: { mode: 'enforce', store: 'user' },
  intake: DEFAULT_INTAKE,
  fleet: DEFAULT_FLEET,
  captain: DEFAULT_CAPTAIN,
  backup: DEFAULT_BACKUP,
  summary: DEFAULT_SUMMARY,
  review: DEFAULT_REVIEW,
};

export function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** The board data repo: DASKS_ROOT, else <Dasks home>/data (where install.sh puts it). */
export const boardRoot = (): string => process.env.DASKS_ROOT || path.join(dasksHome(), 'data');

/** The config.json path of a board root. */
export const configFile = (root: string) => process.env.DASKS_CONFIG || path.join(root, 'config.json');

export function loadConfig(root: string): Config {
  const file = configFile(root);
  let user: any = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw new Error(`config ${file}: ${e.message}`); }
  const cfg: Config = {
    ...DEFAULT_CONFIG, ...user,
    server: { ...DEFAULT_CONFIG.server, ...(user.server ?? {}) },
    auth: { ...DEFAULT_CONFIG.auth, ...(user.auth ?? {}) },
    intake: { ...DEFAULT_INTAKE, ...(user.intake ?? {}) },
    stuck: { ...DEFAULT_STUCK, ...(user.stuck ?? {}) },
    fleet: { ...DEFAULT_FLEET, ...(user.fleet ?? {}) },
    captain: { ...DEFAULT_CAPTAIN, ...(user.captain ?? {}) },
    backup: { ...DEFAULT_BACKUP, ...(user.backup ?? {}) },
    summary: { ...DEFAULT_SUMMARY, ...(user.summary ?? {}) },
    review: { ...DEFAULT_REVIEW, ...(user.review ?? {}) },
  };
  for (const e of backupConfigErrors(user.backup)) throw new Error(`config: ${e}`);
  validateConfig(cfg);
  // The projects' owners decide who owns a card that names none (schema.ts cardOwner); config lanes are valid lanes.
  setProjects(cfg.projects, cfg.lanes);
  if (process.env.DASKS_GATES) cfg.gates = process.env.DASKS_GATES as Config['gates'];
  if (cfg.gates !== 'warn' && cfg.gates !== 'enforce') throw new Error('config: gates must be "warn" or "enforce" (also DASKS_GATES)');
  if (process.env.DASKS_ASK_RULE) cfg.ask_rule = process.env.DASKS_ASK_RULE as Config['ask_rule'];
  if (cfg.ask_rule !== 'warn' && cfg.ask_rule !== 'enforce') throw new Error('config: ask_rule must be "warn" or "enforce" (also DASKS_ASK_RULE)');
  if (process.env.DASKS_AUTH_MODE) cfg.auth = { ...cfg.auth, mode: process.env.DASKS_AUTH_MODE as Config['auth']['mode'] };
  if (!['off', 'warn', 'enforce'].includes(cfg.auth.mode)) throw new Error('config: auth.mode must be "off", "warn" or "enforce" (also DASKS_AUTH_MODE)');
  if (cfg.auth.store !== 'user' && cfg.auth.store !== 'system') throw new Error('config: auth.store must be "user" or "system"');
  return cfg;
}

function validateConfig(cfg: Config): void {
  for (const k of ['doing_hours', 'review_hours', 'ready_idle_hours', 'missing_hours', 'top_n'] as const)
    if (!(Number.isFinite(cfg.stuck[k]) && cfg.stuck[k] > 0) || (k === 'top_n' && !Number.isInteger(cfg.stuck[k]))) throw new Error(`config: stuck.${k} must be positive${k === 'top_n' ? ' integer' : ''}`);
  for (const e of projectsConfigErrors(cfg.projects)) throw new Error(`config: ${e}`);
  if (!Array.isArray(cfg.lanes) || !cfg.lanes.every((l) => typeof l === 'string' && LANE_RE.test(l))) throw new Error('config: lanes must be a list of lane names (lowercase letters, digits, -)');
  for (const e of intakeConfigErrors(cfg.intake)) throw new Error(`config: ${e}`);
  for (const e of familiesConfigErrors(cfg.families)) throw new Error(`config: ${e}`);
  for (const h of cfg.server.hosts) if (!isAllowedBindHost(h)) throw new Error(`config: refusing to bind "${h}" (only ${ALLOWED_BIND_HOSTS.join(' and ')})`);
  if (typeof cfg.server.listen !== 'string' || !net.isIP(cfg.server.listen)) throw new Error('config: server.listen must be an IP address (127.0.0.1 = this Mac only)');
  const tls = cfg.server.tls;
  if (tls !== undefined && (typeof tls !== 'object' || tls === null || Object.keys(tls).some((k) => k !== 'cert' && k !== 'key') || ![tls.cert, tls.key].every((f) => typeof f === 'string' && f.trim() !== '')))
    throw new Error('config: server.tls must be {"cert": "<PEM file>", "key": "<PEM file>"}');
  if (typeof cfg.server.allow_plain_http !== 'boolean') throw new Error('config: server.allow_plain_http must be true or false');
  if (!Array.isArray(cfg.server.extra_allowed_hosts) || !cfg.server.extra_allowed_hosts.every((h) => typeof h === 'string' && /^[A-Za-z0-9.:\[\]-]{1,253}$/.test(h))) throw new Error('config: server.extra_allowed_hosts must be a list of host names');
  if (!(typeof cfg.fleet.dead_min === 'number' && cfg.fleet.dead_min > 0)) throw new Error('config: fleet.dead_min must be a number > 0');
  if (!Array.isArray(cfg.captain.harness) || !cfg.captain.harness.length || !cfg.captain.harness.every((h) => typeof h === 'string' && h.trim() && !/[\r\n\0]/.test(h))) throw new Error('config: captain.harness must be a non-empty list of harness names or command templates');
  if (!Number.isInteger(cfg.captain.lease_sec) || cfg.captain.lease_sec < 30 || cfg.captain.lease_sec > 3600) throw new Error('config: captain.lease_sec must be 30-3600');
  for (const k of ['auto_merge', 'same_machine_review'] as const) if (typeof cfg.captain[k] !== 'boolean') throw new Error(`config: captain.${k} must be true or false`);
  if (typeof cfg.summary.at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.summary.at)) throw new Error('config: summary.at must be HH:MM (24 h, this Mac\'s time zone)');
  if (!(Number.isFinite(cfg.review.stale_days) && cfg.review.stale_days > 0)) throw new Error('config: review.stale_days must be a number > 0');
  if (!Number.isInteger(cfg.server.port) || cfg.server.port < 1024 || cfg.server.port > 65535) throw new Error('config: bad server.port');
  if (!Number.isSafeInteger(cfg.retry_cap) || cfg.retry_cap < 1) throw new Error('config: retry_cap must be a positive integer');
  if (!Number.isSafeInteger(cfg.quota_retry_cap) || cfg.quota_retry_cap < 1) throw new Error('config: quota_retry_cap must be a positive integer');
  if (!Number.isSafeInteger(cfg.infra_retry_cap) || cfg.infra_retry_cap < 1) throw new Error('config: infra_retry_cap must be a positive integer');
}

/** server.hosts: loopback only. A fleet adds one more address with server.listen (or --listen), never through hosts. */
export const ALLOWED_BIND_HOSTS = ['127.0.0.1'];
export function isAllowedBindHost(h: string): boolean {
  return ALLOWED_BIND_HOSTS.includes(h);
}

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopback(addr: string): boolean {
  const a = String(addr ?? '').toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}
export const isWildcard = (addr: string) => addr === '0.0.0.0' || addr === '::';

/** Config `families` problems: keys are an exact actor id or `prefix*`; values a family name (lowercase letters, digits, `-`). Refused at startup. */
export function familiesConfigErrors(m: unknown): string[] {
  if (m === undefined) return [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['families must be a mapping of actor id or prefix* to a family'];
  const out: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    const id = k.endsWith('*') ? k.slice(0, -1) : k;
    if (!id || id.includes('*') || !ACTOR_RE.test(id)) out.push(`families: "${k}" is not an actor id or prefix* pattern`);
    if (!isFamily(v)) out.push(`families: "${k}" maps to "${String(v)}" (want a family name such as anthropic or openai)`);
  }
  return out;
}
