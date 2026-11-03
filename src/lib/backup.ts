// Board data backup (docs/upgrade.md "Backup and restore"). The board's data is a git repo on one disk; with
// backup.remote set, the server pushes its commits to that remote every backup.every_min minutes, on one branch named
// for this board (backup.branch, default dasks-board-<machine>). A push is fast-forward only: never --force, never a
// `+` refspec, so a remote that moved elsewhere is reported, not overwritten. A failing push never stops the board: it
// is a warning on /api/health and a `dasks check` line once BACKUP_WARN_AFTER pushes in a row failed.
// Only commits leave the Mac. run/ (live state), the token store, the passphrase and the login secrets are not in the
// data repo; before each push the paths of every new commit are checked anyway and a push that carries one is refused.
import fs from 'node:fs';
import path from 'node:path';
import { runBounded, why } from './proc.ts';

export interface BackupConfig { remote: string; every_min: number; branch?: string }
export const DEFAULT_BACKUP: BackupConfig = { remote: '', every_min: 10 };
/** Pushes in a row that failed before the board warns. */
export const BACKUP_WARN_AFTER = 3;
const PUSH_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 30_000;

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

const SCP_RE = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)([A-Za-z0-9._~/-]+)$/;

/** backup.remote problems. Only these forms are taken: https://host/path (no user, no password: use a credential helper),
 *  ssh://[user@]host/path, [user@]host:path (scp form, ssh) and an absolute local path. Anything else is refused, among
 *  it every `<transport>::` form (a remote helper can run commands or carry a URL past this check) and every https URL
 *  with userinfo (a token there would be stored in config.json and pushed with the board). */
export function remoteProblem(remote: string): string | null {
  if (!remote || /[\s\u0000-\u001f\u007f]/.test(remote)) return 'must be a git URL or path without spaces';
  if (remote.startsWith('-')) return 'must not start with -';
  if (/^[A-Za-z0-9+.-]+::/.test(remote)) return 'must not use a <transport>:: remote helper';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    let u: URL;
    try { u = new URL(remote); } catch { return 'is not a valid URL'; }
    if (u.protocol === 'https:') {
      if (u.username || u.password) return 'must not carry a user, password or token (it would be stored in config.json and pushed with the board); use a credential helper or an ssh key';
    } else if (u.protocol === 'ssh:') {
      if (u.password) return 'must not carry a password; use an ssh key';
    } else return 'must be https://, ssh://, user@host:path or an absolute local path';
    if (!u.hostname || u.pathname.length < 2) return 'must name a host and a repository path';
    return null;
  }
  if (remote.startsWith('/')) return null;
  return SCP_RE.test(remote) ? null : 'must be https://, ssh://, user@host:path or an absolute local path';
}

/** The remote as /api/backup and the CLI show it: host and path only, never a user name. */
export function remoteShown(remote: string): string {
  if (!remote) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) { try { const u = new URL(remote); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return ''; } }
  const m = SCP_RE.exec(remote);
  return m ? `${m[2]}:${m[3]}` : remote;
}

export function backupConfigErrors(b: unknown): string[] {
  if (b === undefined) return [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['backup must be {"remote": "<git URL>", "every_min"?: N, "branch"?: "<name>"}'];
  const c = b as Record<string, unknown>;
  const e: string[] = [];
  const extra = Object.keys(c).filter((k) => !['remote', 'every_min', 'branch'].includes(k));
  if (extra.length) e.push(`backup: unknown key(s) ${extra.join(', ')}`);
  if (typeof c.remote !== 'string') e.push('backup.remote must be a string ("" = off)');
  else if (c.remote !== '') { const p = remoteProblem(c.remote); if (p) e.push(`backup.remote ${p}`); }
  if (c.every_min !== undefined && !(typeof c.every_min === 'number' && Number.isFinite(c.every_min) && c.every_min >= 1 && c.every_min <= 1440)) e.push('backup.every_min must be a number of minutes, 1-1440');
  if (c.branch !== undefined && (typeof c.branch !== 'string' || !BRANCH_RE.test(c.branch) || c.branch.includes('..') || c.branch.endsWith('.lock') || c.branch.endsWith('/'))) e.push('backup.branch must be a branch name (letters, digits, . _ / -)');
  return e;
}

/** The branch this board's commits go to. */
export const backupBranch = (c: BackupConfig, machine: string) => c.branch || `dasks-board-${machine}`;

/** git push arguments for exactly one commit to one branch: no `+`, no --force, no other refs. */
export function pushArgs(remote: string, sha: string, branch: string): string[] {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('push: the commit must be a 40-hex sha');
  if (!BRANCH_RE.test(branch)) throw new Error('push: bad branch name');
  const p = remoteProblem(remote);
  if (p) throw new Error(`push: backup.remote ${p}`);
  return ['-c', 'protocol.ext.allow=never', 'push', '--porcelain', remote, `${sha}:refs/heads/${branch}`];
}

/** Paths that must never leave the Mac, should one ever be committed: live state and anything that holds a secret. */
export function forbiddenPaths(paths: string[]): string[] {
  const SECRET_NAMES = new Set(['agent-tokens.json', 'client.json', 'passphrase']);
  return paths.filter((p) => {
    // A path with a control character (a newline included) is refused outright: no name check can be trusted on it.
    if (/[\u0000-\u001f\u007f]/.test(p)) return true;
    const parts = p.split('/');
    const base = parts[parts.length - 1];
    return parts[0] === 'run' || parts.slice(0, -1).includes('secrets') || SECRET_NAMES.has(base)
      || base.endsWith('.key') || base.endsWith('.pem') || base === '.env' || base.startsWith('.env.');
  });
}

export interface BackupStatus {
  branch: string;
  /** The last push the remote took (or found already there), and its commit. */
  last_ok_at: string | null;
  last_ok_sha: string | null;
  last_try_at: string | null;
  last_error: string | null;
  /** Pushes in a row that failed (0 after a success). */
  failures: number;
}

export type BackupState = 'off' | 'never' | 'ok' | 'failing';
/** What /api/health, `dasks backup status` and `dasks check` say about the backup. The warning names no remote and no
 *  git output: /api/health is open to the network. */
export function backupView(c: BackupConfig, s: BackupStatus | null, now = new Date()) {
  if (!c.remote) return { state: 'off' as BackupState, warning: null };
  const age = s?.last_ok_at ? Math.round((now.getTime() - Date.parse(s.last_ok_at)) / 60_000) : null;
  if (s && s.failures >= BACKUP_WARN_AFTER)
    return { state: 'failing' as BackupState, age_min: age, warning: `board backup: ${s.failures} pushes in a row failed; last good push ${s.last_ok_at ?? 'never'} (dasks backup status says why)` };
  return { state: (s?.last_ok_at ? 'ok' : 'never') as BackupState, age_min: age, warning: null };
}

export const statusFile = (root: string) => path.join(root, 'run', 'backup.json');

export function readBackupStatus(root: string): BackupStatus | null {
  try {
    const j = JSON.parse(fs.readFileSync(statusFile(root), 'utf8'));
    return j && typeof j === 'object' && Number.isInteger(j.failures) ? j : null;
  } catch { return null; }
}
/** Write the status file; a failure (full disk, no permission) is returned, never thrown: it must not stop the board. */
function saveStatus(root: string, s: BackupStatus): string | null {
  const f = statusFile(root);
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n');
    fs.renameSync(tmp, f);
    return null;
  } catch (e: any) { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to tidy */ } return `${e.code || e.message}`; }
}

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' });

/** One push at a time. tick() pushes HEAD when it moved since the last good push (force: always tries). It never
 *  rejects: any error, a status file that cannot be written included, is a failed push with its reason. */
export class Backup {
  private busy: Promise<BackupStatus> | null = null;
  private root: string; private cfg: BackupConfig; private machine: string;
  /** The last status, kept in memory too: when the file cannot be written the count still goes on. */
  private last: BackupStatus | null = null;
  constructor(root: string, cfg: BackupConfig, machine: string) { this.root = root; this.cfg = cfg; this.machine = machine; }

  status(): BackupStatus {
    const branch = backupBranch(this.cfg, this.machine);
    if (this.last?.branch === branch) return this.last;
    const s = readBackupStatus(this.root);
    return s && s.branch === branch ? s : { branch, last_ok_at: null, last_ok_sha: null, last_try_at: null, last_error: null, failures: 0 };
  }

  tick(force = false): Promise<BackupStatus> {
    if (!this.cfg.remote) return Promise.resolve(this.status());
    if (!this.busy) {
      this.busy = this.run(force)
        .catch((e: any) => { const s = this.status(); return this.keep({ ...s, last_try_at: new Date().toISOString(), last_error: `backup failed: ${e?.message ?? e}`, failures: s.failures + 1 }); })
        .finally(() => { this.busy = null; });
    }
    return this.busy;
  }

  private keep(s: BackupStatus): BackupStatus {
    const err = saveStatus(this.root, s);
    this.last = err ? { ...s, last_error: `${s.last_error ? `${s.last_error}; ` : ''}status file not written (${err})` } : s;
    return this.last;
  }

  private async run(force: boolean): Promise<BackupStatus> {
    const s = this.status();
    const now = () => new Date().toISOString();
    const fail = (msg: string) => this.keep({ ...s, last_try_at: now(), last_error: msg, failures: s.failures + 1 });
    const head = await runBounded('git', ['-C', this.root, 'rev-parse', 'HEAD'], { timeoutMs: LOCAL_TIMEOUT_MS });
    const sha = head.out.trim();
    if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return fail(`no HEAD commit (${why(head)})`);
    if (!force && sha === s.last_ok_sha && !s.failures && !s.last_error) return s;
    // Every path any commit about to leave touches (all history on the first push). -z: raw paths, NUL-separated, never
    // quoted (git quotes a path with non-ASCII bytes, which no pattern would match).
    const log = (r: string[]) => runBounded('git', ['-C', this.root, 'log', '-z', '--name-only', '--format=', ...r], { timeoutMs: LOCAL_TIMEOUT_MS, maxOut: 64 * 1024 * 1024 });
    const names = await log(s.last_ok_sha ? [`${s.last_ok_sha}..${sha}`] : [sha]);
    // A last good commit that history no longer has (the repo was replaced): check everything.
    const all = names.code !== 0 && s.last_ok_sha ? await log([sha]) : names;
    if (all.code !== 0) return fail(`could not list the commits to push (${why(all)})`);
    const bad = [...new Set(forbiddenPaths(all.out.split('\0').map((p) => p.replace(/^\n+/, '')).filter(Boolean)))];
    if (bad.length) return fail(`refused: the commits to push carry ${bad.slice(0, 5).join(', ')}, which must never leave this Mac; take them out of the board's history first`);
    const r = await runBounded('git', ['-C', this.root, ...pushArgs(this.cfg.remote, sha, s.branch)], { env: gitEnv(), timeoutMs: PUSH_TIMEOUT_MS });
    if (r.code !== 0) return fail(/\[rejected\]|non-fast-forward|fetch first/.test(r.out + r.err)
      ? `the remote branch ${s.branch} has commits this board does not (rejected; never forced): ${why(r, 200)}` : `git push failed: ${why(r, 300)}`);
    const t = now();
    return this.keep({ branch: s.branch, last_ok_at: t, last_ok_sha: sha, last_try_at: t, last_error: null, failures: 0 });
  }
}
