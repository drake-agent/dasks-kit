// Human login for the board UI (docs/auth.md). One user. A login proves something only the human has
// (today a passphrase; a passkey plugs in as another Authenticator) and yields a session: an HttpOnly SameSite=Strict
// cookie plus a per-session CSRF token. Only requests carrying both, from a same-origin page, act as "user".
// Sessions and the key that signs session ids and CSRF tokens live only in the server's memory (a new key every start, so
// a restart logs the human out): agents run under the same macOS account as the server, and anything on disk that
// account can read or write an agent could use to make its own session. The ledger key lives outside the repo in
// DASKS_SECRETS_DIR (default ~/.dasks/secrets, 0700, files 0600), created on first run and never logged. The passphrase
// hash lives at DASKS_PASSPHRASE_FILE (default ~/.dasks/passphrase, 0600, written by install.sh or bin/dasks-passphrase.ts).
// Login refuses it when group or others can read or write it. Trade-off: a file this account can write is a file an agent
// running as this account could replace. DASKS_STRICT_PASSPHRASE=1 closes that: login then refuses the file unless
// neither it nor any folder above it is writable by this account (put it in a root-owned folder with
// `sudo DASKS_STRICT_PASSPHRASE=1 DASKS_PASSPHRASE_FILE=… node bin/dasks-passphrase.ts`).
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { expandHome } from './config.ts';
import { dasksHome } from './connection.mjs';
import { HttpError } from './write.ts';

export const SESSION_COOKIE = 'dasks_session';
export const CSRF_HEADER = 'x-dasks-csrf';
const SID_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const DEFAULT_TTL_S = 14 * 24 * 3600;

export function secretsDir(): string {
  return expandHome(process.env.DASKS_SECRETS_DIR || '~/.dasks/secrets');
}

export function passphraseFile(): string {
  return expandHome(process.env.DASKS_PASSPHRASE_FILE || '~/.dasks/passphrase');
}

/** Tests only: trust any passphrase file, whatever its mode or owner. Never set it on a real board. */
export const UNSAFE_OWN_PASSPHRASE = 'DASKS_UNSAFE_OWN_PASSPHRASE_FILE';
/** Strict mode: the passphrase file must not be replaceable by this account at all (a root-owned file and folders). */
export const STRICT_PASSPHRASE = 'DASKS_STRICT_PASSPHRASE';

/** Why a passphrase file in the default (non-strict) mode is not private (group or others can read or write it), or null. */
export function notPrivate(file: string): string | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch (e: any) { return `${file}: ${e.code || e.message}`; }
  if (!st.isFile()) return `${file} is not a regular file`;
  if (st.mode & 0o077) return `${file} is readable or writable by group or others (chmod 600 it)`;
  return null;
}

/** Why the account `uid` (default: this process's) could replace `file` (it, or a folder above it, is that account's
 *  or writable by it), or null. */
export function writableByUs(file: string, uid = process.getuid!(), gids = process.getgroups!()): string | null {
  const groups = new Set(gids);
  let p: string;
  try { p = fs.realpathSync(file); } catch (e: any) { return `${file}: ${e.code || e.message}`; }
  if (!fs.lstatSync(p).isFile()) return `${p} is not a regular file`;
  for (;;) {
    const st = fs.lstatSync(p);
    if (st.uid === uid) return `${p} is owned by the account (uid ${uid})`;
    if (st.mode & 0o002) return `${p} is world-writable`;
    if (st.mode & 0o020 && groups.has(st.gid)) return `${p} is writable by group ${st.gid}, which the account is in`;
    const up = path.dirname(p);
    if (up === p) return null;
    p = up;
  }
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.statSync(dir).mode & 0o077) fs.chmodSync(dir, 0o700);
}

/** A 32-byte hex key file, created on first use (O_EXCL, 0600). Errors never include the key. */
export function loadKey(dir: string, name: string): Buffer {
  ensureDir(dir);
  const f = path.join(dir, name);
  try {
    const fd = fs.openSync(f, 'wx', 0o600);
    try { fs.writeSync(fd, randomBytes(32).toString('hex') + '\n'); } finally { fs.closeSync(fd); }
  } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  if (fs.statSync(f).mode & 0o077) fs.chmodSync(f, 0o600);
  const hex = fs.readFileSync(f, 'utf8').trim();
  if (!/^[0-9a-f]{64,}$/.test(hex)) throw new Error(`${f}: not a hex key (delete it to make a new one)`);
  return Buffer.from(hex, 'hex');
}

const eq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const hmac = (key: Buffer, s: string) => createHmac('sha256', key).update(s).digest();

// ---------- authenticators ----------
/** One way to prove the human is there. available() false = this method is not set up (login answers 503). */
export interface Authenticator {
  readonly method: string;
  available(): boolean;
  verify(proof: Record<string, unknown>): boolean;
}

/** scrypt$N$r$p$<salt base64>$<hash base64>, one line. */
export function hashPassphrase(pass: string, N = 32768, r = 8, p = 1): string {
  const salt = randomBytes(16);
  const h = scryptSync(pass.normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export class PassphraseAuth implements Authenticator {
  readonly method = 'passphrase';
  private file: string;
  constructor(file: string) { this.file = file; }
  available() { return fs.existsSync(this.file); }
  verify(proof: Record<string, unknown>): boolean {
    const pass = proof.passphrase;
    if (typeof pass !== 'string' || !pass || pass.length > 1024) return false;
    if (process.env[UNSAFE_OWN_PASSPHRASE] !== '1') {
      const why = process.env[STRICT_PASSPHRASE] === '1' ? writableByUs(this.file) : notPrivate(this.file);
      if (why) throw new Error(`${why}: set the passphrase again with bin/dasks-passphrase.ts`);
    }
    // Read on every login: setting or changing the passphrase needs no restart.
    const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(fs.readFileSync(this.file, 'utf8').trim());
    if (!m) throw new Error(`${this.file}: unreadable passphrase hash (run bin/dasks-passphrase.ts again)`);
    const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) throw new Error(`${this.file}: scrypt parameters out of range`);
    const want = Buffer.from(m[5], 'base64');
    const got = scryptSync(pass.normalize('NFC'), Buffer.from(m[4], 'base64'), want.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
    return eq(got, want);
  }
}

// ---------- sessions ----------
export interface Human { sid: string; sidHash: string }

/** In memory only: nothing on disk is read, so a file an agent plants (or a key it reads) never makes a session. */
export class Sessions {
  /** sid hash → expiry (ms). Only hashes are kept, never the cookie value. */
  private live = new Map<string, number>();
  private key: Buffer;
  private ttlMs: number;
  constructor(ttlMs: number, key = randomBytes(32)) { this.key = key; this.ttlMs = ttlMs; }
  hash(sid: string): string { return hmac(this.key, `sid\0${sid}`).toString('hex'); }
  csrf(sid: string): string { return hmac(this.key, `csrf\0${sid}`).toString('base64url'); }
  get ttlSeconds() { return Math.floor(this.ttlMs / 1000); }
  create(): { sid: string; csrf: string; exp: number } {
    const sid = randomBytes(32).toString('base64url');
    const exp = Date.now() + this.ttlMs;
    const now = Date.now();
    for (const [h, e] of this.live) if (e <= now) this.live.delete(h);
    this.live.set(this.hash(sid), exp);
    return { sid, csrf: this.csrf(sid), exp };
  }
  valid(sid: string): boolean {
    if (!SID_RE.test(sid)) return false;
    const exp = this.live.get(this.hash(sid));
    if (exp === undefined) return false;
    if (exp <= Date.now()) { this.revoke(sid); return false; }
    return true;
  }
  expiry(sid: string): number { return this.live.get(this.hash(sid)) ?? 0; }
  revoke(sid: string) { this.live.delete(this.hash(sid)); }
}

export function sessionTtlMs(): number {
  const s = Number(process.env.DASKS_SESSION_TTL_S);
  return (Number.isFinite(s) && s > 0 ? s : DEFAULT_TTL_S) * 1000;
}

// ---------- request checks ----------
/** The session cookie, or '' when absent or ambiguous (two cookies of that name = someone planted one: refuse). */
export function sessionCookie(req: http.IncomingMessage): string {
  const found: string[] = [];
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) found.push(part.slice(i + 1).trim());
  }
  return found.length === 1 ? found[0] : '';
}

/** The scheme the browser used: https when this socket is TLS, or when a TLS proxy in front sends X-Forwarded-Proto: https. */
export function isHttps(req: http.IncomingMessage): boolean {
  return Boolean((req.socket as any).encrypted) || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

/** A browser page of this very board: Origin present and exactly scheme://Host; Sec-Fetch-Site, when sent, same-origin. */
export function sameOrigin(req: http.IncomingMessage): boolean {
  const o = req.headers.origin; const host = String(req.headers.host || '').toLowerCase();
  if (typeof o !== 'string' || !host) return false;
  if (o.toLowerCase() !== `${isHttps(req) ? 'https' : 'http'}://${host}`) return false;
  const sfs = req.headers['sec-fetch-site'];
  return sfs === undefined || sfs === 'same-origin';
}

export function cookieHeader(req: http.IncomingMessage, sid: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

/** The only way a request acts as the human: valid session (401) + same-origin page (403) + this session's CSRF (403). */
/** getSessions is called only when a session cookie is present (no cookie: 401 without touching the secrets dir). */
export function requireHuman(req: http.IncomingMessage, getSessions: () => Sessions | null): Human {
  const sid = sessionCookie(req);
  const sessions = sid ? getSessions() : null;
  if (sid && !sessions) throw new HttpError(503, 'login is unavailable (secrets dir unreadable; see server log)');
  if (!sessions || !sessions.valid(sid)) throw new HttpError(401, 'login required: only the human in the board UI acts as "user"', { login: true });
  if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin request refused');
  const sent = req.headers[CSRF_HEADER];
  if (typeof sent !== 'string' || !eq(Buffer.from(sent), Buffer.from(sessions.csrf(sid)))) throw new HttpError(403, 'missing or wrong CSRF token');
  return { sid, sidHash: sessions.hash(sid) };
}

/** Failed logins counted per client address: one client guessing (or locking on purpose) locks only itself, so an agent
 *  on one machine cannot lock the human out from another device. Guessing speed stays bounded per address. */
export class LoginLimiter {
  private misses = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max = 5, windowMs = 15 * 60_000) { this.max = max; this.windowMs = windowMs; }
  private live(key: string): number[] {
    const floor = Date.now() - this.windowMs;
    const l = (this.misses.get(key) ?? []).filter((t) => t > floor);
    if (l.length) this.misses.set(key, l); else this.misses.delete(key);
    return l;
  }
  locked(key = ''): boolean { return this.live(key).length >= this.max; }
  miss(key = '') { this.misses.set(key, [...this.live(key), Date.now()]); }
}

// ---------- agent tokens (docs/auth.md) ----------
// A bearer token `dsk_<id>_<secret>`: id = 8 random lowercase hex (lookup), secret = 32 random bytes base64url (43
// chars). The store keeps only sha256(secret) per id. Two stores (config auth.store):
// - "user" (default): ~/.dasks/agent-tokens.json, mode 600, written by the installer. It keeps out every caller that does
//   not hold a token (other accounts, web pages, stray scripts); an agent of this account could still add itself one.
// - "system": a root-owned file the server only reads, written by `sudo bin/dasks-tokens.ts`, so no process of this
//   account can add itself a token.
// Either way a process of the same account can read another process's token (env or file); tokens do not stop that.
// Nothing here ever prints or logs a secret.

export const UNSAFE_OWN_TOKENS = 'DASKS_UNSAFE_OWN_TOKENS_FILE';
export const TOKEN_RE = /^dsk_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const TOKEN_ID_RE = /^[0-9a-f]{8}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const LABEL_RE = /^[a-z0-9]{1,8}$/;
const NAME_RE = /^[A-Za-z0-9._@-]{1,40}$/; // = schema ACTOR_RE (kept here so the sudo CLI imports nothing else)

/** The system store's one path. Not configurable: a path the server's account could name is a path it could point at a
 *  store of its own. Tests move it only with the explicit test switch (tokenStoreConfig). */
export const STORE_PATH = process.platform === 'darwin' ? '/Library/Application Support/Dasks/agent-tokens.json' : '/etc/dasks/agent-tokens.json';
/** Tests only, and only together with DASKS_UNSAFE_OWN_TOKENS_FILE=1: keep every store-path check on, but accept this
 *  uid as an owner next to root (a test's temp folders are its own). */
export const TEST_OWNER_UID = 'DASKS_TEST_TOKENS_OWNER_UID';

/** Where the store is and who may own its path. owners null = root path checks off (the user store, the plain test
 *  switch). user: the file must belong to this account and be private to it (mode 600). */
export interface StoreConfig { file: string; owners: number[] | null; user?: boolean }
export type StoreKind = 'user' | 'system';
export function userStoreFile(): string { return path.join(dasksHome(), 'agent-tokens.json'); }
export function tokenStoreConfig(kind: StoreKind = 'user'): StoreConfig {
  if (process.env[UNSAFE_OWN_TOKENS] !== '1') return kind === 'user' ? { file: userStoreFile(), owners: null, user: true } : { file: STORE_PATH, owners: [0] };
  const file = process.env.DASKS_AGENT_TOKENS_FILE || STORE_PATH;
  if (!path.isAbsolute(file)) throw new Error('DASKS_AGENT_TOKENS_FILE (test switch) must be an absolute path');
  const u = process.env[TEST_OWNER_UID];
  if (u === undefined || u === '') return { file, owners: null };
  if (!/^\d{1,10}$/.test(u)) throw new Error(`${TEST_OWNER_UID} must be a uid`);
  return { file, owners: [0, Number(u)] };
}

/** machine: a fleet machine's token (`dasks machine add <name>`), actors ["*@<name>"]: any name on that machine. Only
 *  machine tokens are accepted on the network address (server.listen). */
export interface TokenRecord { id: string; actors: string[]; labels: boolean; sha256: string; created: string; revoked: string | null; note: string; machine?: string }
export type AuthReason = 'no-token' | 'store-unavailable' | 'bad-token' | 'revoked' | 'mismatch' | 'not-machine';

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** A fleet machine's name: the part after @ in its actors (runner@<name>). */
export const MACHINE_RE = /^[a-z0-9-]{1,16}$/;

/** A name a token may carry in `actors`: a valid board actor, never "user" (any case), "*" (any name but user), or
 *  "*@<machine>" (any name on that machine). */
export function tokenActorOk(a: unknown): a is string {
  if (typeof a === 'string' && a.startsWith('*@')) return MACHINE_RE.test(a.slice(2));
  return a === '*' || typeof a === 'string' && NAME_RE.test(a) && a.toLowerCase() !== 'user';
}

/** A new token and its store record. The token is returned once; only the record is kept. */
export function newToken(actors: string[], labels: boolean, note: string, now = new Date()): { token: string; record: TokenRecord } {
  if (!actors.length || !actors.every(tokenActorOk)) throw new Error('actors must be valid board actor names (letters, digits, . _ @ -, at most 40), never "user"');
  const id = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { token: `dsk_${id}_${secret}`, record: { id, actors: [...actors], labels, sha256: sha256Hex(secret), created: now.toISOString(), revoked: null, note } };
}

/** An ISO 8601 date-time that names a real instant: the calendar day exists (no 2026-02-30), hours < 24, minutes and
 *  seconds < 60, offset within ±23:59. Date.parse alone rolls impossible dates over, so the fields are checked. */
function isoDate(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  if (m[9] && (Number(m[10]) > 23 || Number(m[11]) > 59)) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate(); // days in that month
}

const WRITE_PERMS = new Set(['write', 'append', 'add_file', 'add_subdirectory', 'delete', 'delete_child', 'writeattr', 'writeextattr', 'writesecurity', 'chown']);
/** Every permission and inheritance word macOS chmod(1) knows: any other word means we do not understand the entry. */
const ACL_WORDS = new Set([...WRITE_PERMS, 'read', 'execute', 'readattr', 'readextattr', 'readsecurity', 'list', 'search',
  'file_inherit', 'directory_inherit', 'limit_inherit', 'only_inherit']);
export interface AclEntry { principal: string; inherited: boolean; kind: 'allow' | 'deny'; perms: string[] }
/** The ACL entries of one `ls -led <path>` output, or null when any entry line does not have the fixed shape
 *  ` <n>: <principal> [inherited ]allow|deny <word>[,<word>…]` with known words. The principal is everything between
 *  `<n>: ` and the first ` [inherited ]allow|deny ` that ends the line with known words, so names with spaces (`group:Domain Users`) are whole. */
export function parseAclLs(out: string): AclEntry[] | null {
  const entries: AclEntry[] = [];
  for (const line of out.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const m = /^ *\d+: (.+?) (inherited )?(allow|deny) ([a-z_]+(?:,[a-z_]+)*)$/.exec(line);
    if (!m || !m[1].trim()) return null;
    const perms = m[4].split(',');
    if (!perms.every((w) => ACL_WORDS.has(w))) return null;
    entries.push({ principal: m[1], inherited: !!m[2], kind: m[3] as 'allow' | 'deny', perms });
  }
  return entries;
}
/** Who, other than root, the ACL in this `ls -led` output lets write or change the entry; '' when the output cannot be
 *  parsed (refuse); null when nobody. */
export function aclWriterFromLs(out: string): string | null {
  const entries = parseAclLs(out);
  if (!entries) return '';
  const e = entries.find((x) => x.kind === 'allow' && x.principal !== 'user:root' && x.perms.some((w) => WRITE_PERMS.has(w)));
  return e ? e.principal : null;
}
const aclCache = new Map<string, { key: string; out: string | null }>();
/** macOS: the `ls -led` output for `p` (null = could not run it), cached until the entry's ctime changes (an ACL change
 *  bumps ctime). Elsewhere: '' (no ACLs read; POSIX modes only). */
export function aclLs(p: string, st: fs.Stats): string | null {
  if (process.platform !== 'darwin') return '';
  const key = `${st.dev}:${st.ino}:${st.ctimeMs}`;
  const hit = aclCache.get(p);
  if (hit && hit.key === key) return hit.out;
  let out: string | null;
  try { out = execFileSync('/bin/ls', ['-led', p], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { out = null; }
  aclCache.set(p, { key, out });
  return out;
}
/** Who, other than root, an ACL entry on `p` lets write or change it ('' = the ACL could not be read or parsed:
 *  refuse), or null. */
export function aclWriter(p: string, st: fs.Stats): string | null {
  const out = aclLs(p, st);
  return out === null ? '' : aclWriterFromLs(out);
}

/** Why the store path is not trusted, or null. Every component from / down to `p` is lstat'ed, never resolved: none may
 *  be a symlink, each must belong to one of `owners` (root; in tests also the test's uid), none may be group- or
 *  world-writable, and no ACL entry may let anyone but root write it. `want` is what `p` itself must be. */
export function storePathProblem(p: string, owners: number[], want: 'file' | 'dir'): string | null {
  if (!path.isAbsolute(p)) return `${p} is not an absolute path`;
  const parts = p.split('/').filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    const cur = '/' + parts.slice(0, i).join('/');
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch (e: any) { return `${cur}: ${e.code === 'ENOENT' ? 'missing' : e.code || e.message}`; }
    if (st.isSymbolicLink()) return `${cur} is a symlink (the store path takes none)`;
    if (!owners.includes(st.uid)) return `${cur} is owned by uid ${st.uid}, not root`;
    if (st.mode & 0o022) return `${cur} is ${st.mode & 0o002 ? 'world' : 'group'}-writable`;
    const who = aclWriter(cur, st);
    if (who !== null) return who ? `${cur} has an ACL that lets ${who} write it` : `${cur}: its ACL could not be read`;
    const last = i === parts.length;
    if (!last && !st.isDirectory()) return `${cur} is not a folder`;
    if (last && (want === 'file' ? !st.isFile() : !st.isDirectory())) return `${cur} is not a regular ${want === 'file' ? 'file' : 'folder'}`;
  }
  return null;
}

/** Can this process reach the store (search every folder above it, read the file)? Why not, or null. */
export function storeReachProblem(file: string): string | null {
  const parts = file.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const dir = '/' + parts.slice(0, i).join('/');
    try { fs.accessSync(dir, fs.constants.X_OK); } catch { return `${dir} is not searchable by this account (uid ${process.getuid!()})`; }
  }
  try { fs.accessSync(file, fs.constants.R_OK); }
  catch (e: any) { return e.code === 'ENOENT' ? `${file} is missing (issue a token with sudo bin/dasks-tokens.ts)` : `${file} is not readable by this account (uid ${process.getuid!()})`; }
  return null;
}

/** The one startup line about the store: where it is, whether this account can reach it, whether its path is trusted. */
export function tokenStoreReport(c: StoreConfig = tokenStoreConfig()): string {
  const reach = storeReachProblem(c.file);
  if (!reach && c.user) {
    const st = fs.statSync(c.file);
    if (st.uid !== process.getuid!() || st.mode & 0o077) return `auth: token store ${c.file} refused: it must belong to this account with mode 600`;
  }
  if (reach) return `auth: token store ${c.file} not reachable: ${reach}; every token check is store-unavailable (503 under enforce) until it is`;
  const why = c.owners ? storePathProblem(c.file, c.owners, 'file') : null;
  if (why) return `auth: token store ${c.file} refused: ${why}; every token check is store-unavailable until it is fixed`;
  return `auth: token store ${c.file} reachable${c.owners ? '' : c.user ? ' (user store)' : ' (test switch: path checks off)'}`;
}

/** The store's records, or why the whole store is invalid. */
export function parseTokenStore(text: string): { records: TokenRecord[] } | { invalid: string } {
  let j: any;
  try { j = JSON.parse(text); } catch { return { invalid: 'not JSON' }; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.tokens)) return { invalid: 'no "tokens" list' };
  const seen = new Set<string>();
  for (const [i, r] of j.tokens.entries()) {
    const where = `record ${i}`;
    if (!r || typeof r !== 'object') return { invalid: `${where} is not an object` };
    for (const k of ['id', 'actors', 'labels', 'sha256', 'created', 'revoked', 'note']) if (!(k in r)) return { invalid: `${where} has no ${k}` };
    if (typeof r.id !== 'string' || !TOKEN_ID_RE.test(r.id)) return { invalid: `${where} has a bad id` };
    if (seen.has(r.id)) return { invalid: `id ${r.id} repeats` };
    seen.add(r.id);
    if (!Array.isArray(r.actors) || !r.actors.length || !r.actors.every(tokenActorOk)) return { invalid: `${r.id} has empty or bad actors` };
    if (typeof r.labels !== 'boolean') return { invalid: `${r.id} labels is not true/false` };
    if (typeof r.sha256 !== 'string' || !SHA_RE.test(r.sha256)) return { invalid: `${r.id} sha256 is not 64 hex` };
    if (!isoDate(r.created)) return { invalid: `${r.id} created is not an ISO date` };
    if (r.revoked !== null && !isoDate(r.revoked)) return { invalid: `${r.id} revoked is not null or an ISO date` };
    if (typeof r.note !== 'string') return { invalid: `${r.id} note is not text` };
    if (r.machine !== undefined && (typeof r.machine !== 'string' || !MACHINE_RE.test(r.machine) || r.actors.join() !== `*@${r.machine}`)) return { invalid: `${r.id} machine must be a machine name with actors ["*@<machine>"]` };
  }
  return { records: j.tokens as TokenRecord[] };
}

/** May this token act as `name`? Exact names in `actors`; with labels also `<actor>-<label>` or the label before the @
 *  (`human-claude-ab12@mini` for `human-claude@mini`). A machine token: any name whose part after the last @ is exactly
 *  that machine (`mini` never reaches `runner@mini-build`, itself a valid machine name). Never "user". */
export function tokenMayActAs(rec: TokenRecord, name: string): boolean {
  if (!NAME_RE.test(name) || name.toLowerCase() === 'user') return false;
  if (rec.actors.includes(name) || rec.actors.includes('*')) return true;
  const at = name.lastIndexOf('@');
  if (at > 0 && rec.actors.some((a) => a.startsWith('*@') && name.slice(at + 1) === a.slice(2))) return true;
  return rec.labels && rec.actors.some((a) => {
    if (a.startsWith('*')) return false;
    if (name.startsWith(a + '-') && LABEL_RE.test(name.slice(a.length + 1))) return true;
    const i = a.lastIndexOf('@'), pre = a.slice(0, i), host = a.slice(i);
    return i > 0 && name.startsWith(pre + '-') && name.endsWith(host) && LABEL_RE.test(name.slice(pre.length + 1, name.length - host.length));
  });
}

/** The bearer token sent, '' when there is no `Authorization: Bearer <x>` header. */
export function bearerOf(req: http.IncomingMessage): string {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer +(\S+) *$/i.exec(h) : null;
  return m ? m[1] : '';
}

/** Read-only view of the token store, checked and opened on every call and parsed again whenever the opened file's
 *  identity, size, times, mode or owner changes (a revoke or chmod is live on the next request). The system store's path
 *  must pass storePathProblem (no symlink, root-owned, no group/world write, no ACL write grant on any component); the
 *  user store's file must belong to this account with mode 600. The bytes parsed come from the descriptor that was
 *  opened. */
export class TokenStore {
  private cfg: StoreConfig;
  private key = '';
  private state: { records: Map<string, TokenRecord> } | { why: string } = { why: 'not read yet' };
  private warn: (line: string) => void;
  private noted = '';
  constructor(cfg: StoreConfig, warn: (line: string) => void = (l) => console.error(l)) { this.cfg = cfg; this.warn = warn; }
  /** The records by id, or why the store is unavailable. */
  current(): Map<string, TokenRecord> | string {
    const { file, owners } = this.cfg;
    if (owners) {
      const why = storePathProblem(file, owners, 'file');
      if (why) return this.unavailable(`refused:${why}`, `auth: token store refused: ${why}: an agent of this account could swap or edit it; it must be at ${STORE_PATH} as written by sudo bin/dasks-tokens.ts`, 'refused');
    }
    let fd: number;
    // O_NOFOLLOW: no link at the end; O_NONBLOCK: a FIFO or device must not block the server's event loop.
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (e: any) { return this.unavailable(`open:${e.code}`, `auth: token store unavailable: ${file}: ${e.code || 'unreadable'}`, 'missing or unreadable'); }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return this.unavailable('notfile', `auth: token store unavailable: ${file} is not a regular file`, 'not a file');
      if (this.cfg.user && (st.uid !== process.getuid!() || st.mode & 0o077))
        return this.unavailable('notprivate', `auth: token store refused: ${file} must belong to this account with mode 600`, 'not private');
      if (owners) {
        let now: fs.Stats;
        try { now = fs.lstatSync(file); } catch (e: any) { return this.unavailable(`open:${e.code}`, `auth: token store unavailable: ${file}: ${e.code || 'unreadable'}`, 'missing'); }
        if (now.ino !== st.ino || now.dev !== st.dev) return this.unavailable('swapped', `auth: token store unavailable: ${file} changed while it was read`, 'changed while read');
      }
      const key = `${st.dev}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.mode}:${st.uid}:${st.gid}`;
      if (key !== this.key) {
        let text: string;
        try { text = fs.readFileSync(fd, 'utf8'); } catch (e: any) { return this.unavailable(`read:${e.code}`, `auth: token store unavailable: ${file}: ${e.code || 'unreadable'}`, 'unreadable'); }
        this.key = key;
        this.noted = '';
        const parsed = parseTokenStore(text);
        if ('invalid' in parsed) { this.state = { why: parsed.invalid }; this.warn(`auth: token store invalid: ${parsed.invalid}`); }
        else this.state = { records: new Map(parsed.records.map((r) => [r.id, r])) };
      }
      return 'records' in this.state ? this.state.records : this.state.why;
    } finally { fs.closeSync(fd); }
  }
  /** One stderr line per change of an unavailable state, not one per request; the next good read parses again. */
  private unavailable(k: string, line: string, why: string): string {
    this.key = '';
    if (this.noted !== k) { this.noted = k; this.warn(line); }
    return why;
  }
}

/** Check a request's token. ok = a valid, non-revoked token whose identity matches; then `actor` is that identity
 *  (the header when sent, else actors[0]). Else the first failing reason (no-token, store-unavailable, bad-token,
 *  revoked, mismatch) and, once the token parsed to a known id, that id. */
export function checkToken(token: string, header: string | undefined, store: TokenStore):
  { ok: true; actor: string; id: string; machine: string } | { ok: false; reason: AuthReason; id?: string } {
  if (!token) return { ok: false, reason: 'no-token' };
  const recs = store.current();
  if (typeof recs === 'string') return { ok: false, reason: 'store-unavailable' };
  const m = TOKEN_RE.exec(token);
  const rec = m ? recs.get(m[1]) : undefined;
  if (!m || !rec) return { ok: false, reason: 'bad-token' };
  if (!eq(Buffer.from(sha256Hex(m[2]), 'hex'), Buffer.from(rec.sha256, 'hex'))) return { ok: false, reason: 'bad-token', id: rec.id };
  if (rec.revoked) return { ok: false, reason: 'revoked', id: rec.id };
  const first = rec.actors[0];
  const name = header === undefined ? (first === '*' ? 'agent' : first.startsWith('*@') ? `agent${first.slice(1)}` : first) : header;
  if (!tokenMayActAs(rec, name)) return { ok: false, reason: 'mismatch', id: rec.id };
  return { ok: true, actor: name, id: rec.id, machine: rec.machine ?? '' };
}
