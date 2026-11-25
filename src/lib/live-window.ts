// A card's live window (docs/runner.md "Live window"): the latest steps of the agent working the card and the diff of its
// worktree, as the runner last sent them. Kept only in the server's memory, never in data/ and never committed: a
// restart empties it. Informational only: nothing decides anything from it. Every text is redacted before it is kept,
// and the runner runs the same sanitizer before it sends (sanitizeDiff, cleanText).
import { redact } from './redact.ts';
import { HttpError } from './write.ts';

export const MAX_STEPS = 40;
export const MAX_STEP_CHARS = 240;
export const MAX_FILES = 30;
export const MAX_PATH_CHARS = 260;
export const MAX_DIFF_BYTES = 16_384;
/** Cards kept at once: the one updated longest ago goes first. */
export const MAX_CARDS = 64;
export const PHASES = ['building', 'reviewing', 'fixing'] as const;
export const STEP_KINDS = ['tool', 'note'] as const;
export const FILE_STATUSES = ['M', 'A', 'D', 'R'] as const;

export interface LiveStep { at: string; kind: (typeof STEP_KINDS)[number]; text: string }
export interface LiveFile { path: string; status: (typeof FILE_STATUSES)[number]; added: number; deleted: number }
export interface LiveWindow {
  card: string; run_id: string | null; actor: string | null; phase: string | null; updated_at: string | null;
  /** The runner's ordering number of the update shown (0 = none): an update with a lower one arrived late. */
  seq: number;
  /** true once the runner said the agent stopped: the window then shows its last state. */
  ended: boolean;
  steps: LiveStep[]; files: LiveFile[]; diff: string; diff_truncated: boolean;
}

export const emptyWindow = (card: string): LiveWindow => ({ card, run_id: null, actor: null, phase: null, updated_at: null, seq: 0, ended: false, steps: [], files: [], diff: '', diff_truncated: false });

// Secrets passed as command-line flags, which the shared redactor does not know: `-a <pw>` (redis-cli), `-p<pw>` (mysql),
// `--password x` / `--token=x` and the like, `-u user:pass` (curl). The value is replaced, the flag kept.
const FLAG_VALUE = /(^|\s)(-a|--(?:[Pp]assword|passwd|pass|pwd|token|auth-token|access-token|api-?key|apikey|secret|client-secret|private-key))(=|\s+)("[^"]*"|'[^']*'|\S+)/g;
const P_JOINED = /(^|\s)-p(?=[^\s-])\S+/g;
const USER_PASS = /(^|\s)(-u|--user)(=|\s+)([^\s:]+):\S+/g;
export function redactFlags(s: string, mark = '<redacted>'): string {
  return s.replace(FLAG_VALUE, (_m, pre, flag, sep) => `${pre}${flag}${sep}${mark}`).replace(P_JOINED, (_m, pre) => `${pre}-p${mark}`)
    .replace(USER_PASS, (_m, pre, flag, sep, user) => `${pre}${flag}${sep}${user}:${mark}`);
}

/** One line, control characters dropped, redacted (secret flags included), then cut to max characters. */
export function cleanText(v: string, max: number): string {
  const flat = redact(redactFlags(v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()));
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Files whose content is never shown, only their name: env files, credential and key files, cluster and registry logins,
// configuration formats, and names that say secret, token, password or credential.
const SENSITIVE = new RegExp([
  String.raw`(?:^|/)(?:\.env[^/]*|[^/]*\.envrc|\.npmrc|\.netrc|_netrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd|\.s3cfg|\.boto|\.dockercfg|kubeconfig[^/]*|id_[^/]*)$`,
  String.raw`(?:^|/)(?:\.docker/config\.json|\.kube/config|\.aws/(?:credentials|config)|\.ssh/[^/]+|\.gnupg/[^/]+)$`,
  String.raw`(?:^|/)[^/]*(?:secret|credential|password|passwd|token|private|apikey|api_key)[^/]*$`,
  String.raw`\.(?:ya?ml|toml|ini|conf|cfg|properties|plist|json5|pem|key|p8|p12|pfx|jks|keystore|crt|cer|der|kdbx|asc|gpg|ovpn|mobileprovision)$`,
].join('|'), 'i');
export const isSensitivePath = (p: string): boolean => SENSITIVE.test(p.trim());

/** A unified diff made safe to show: a file section whose old or new name is sensitive keeps only its header line, text
 *  before the first `diff --git` header is dropped (no file to judge it by), and the rest is redacted (key blocks
 *  across lines included). Then cut on a line boundary to MAX_DIFF_BYTES. */
export function sanitizeDiff(raw: string): { diff: string; truncated: boolean } {
  const text = raw.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const parts = text.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '));
  const safe = parts.map((sec) => {
    const head = sec.slice(0, sec.indexOf('\n') < 0 ? sec.length : sec.indexOf('\n'));
    // a/ and b/ are optional: a repo may set diff.noprefix.
    const m = /^diff --git "?(?:a\/)?(.+?)"? "?(?:b\/)?(.+?)"?$/.exec(head);
    const names = [m?.[1], m?.[2], ...[...sec.matchAll(/^(?:rename (?:from|to) |copy (?:from|to) |[-+]{3} (?:[ab]\/)?)(.+)$/gm)].map((x) => x[1].split('\t')[0])];
    // A new, renamed or copied file holding env-style KEY=value lines is a secrets file whatever its name.
    const envLike = /^(?:new file mode|rename from|copy from)/m.test(sec) && /^\+\s*(?:export\s+)?[A-Z][A-Z0-9_]*=\S/m.test(sec);
    if (!m || envLike || names.some((n) => n && isSensitivePath(n))) return `${redact(head)}\n[diff omitted: sensitive file]\n`;
    return redact(sec);
  }).join('').replace(/\n$/, '');
  if (Buffer.byteLength(safe, 'utf8') <= MAX_DIFF_BYTES) return { diff: safe, truncated: false };
  let kept = '';
  for (const ln of safe.split('\n')) {
    const next = kept ? `${kept}\n${ln}` : ln;
    if (Buffer.byteLength(next, 'utf8') > MAX_DIFF_BYTES) break;
    kept = next;
  }
  return { diff: kept, truncated: true };
}

const bad = (msg: string) => new HttpError(400, msg);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown, k: string) => {
  if (v === undefined) return 0;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 10_000_000) throw bad(`${k} must be a whole number >= 0`);
  return v as number;
};

function parseSteps(v: unknown, at: string): LiveStep[] {
  if (!Array.isArray(v)) throw bad('steps must be a list');
  return v.slice(-MAX_STEPS).flatMap((s) => {
    if (!isObj(s) || typeof s.text !== 'string') throw bad('each step is {kind?, text}');
    const kind = s.kind ?? 'note';
    if (!(STEP_KINDS as readonly unknown[]).includes(kind)) throw bad(`step kind must be ${STEP_KINDS.join(' | ')}`);
    const text = cleanText(s.text, MAX_STEP_CHARS);
    return text ? [{ at, kind: kind as LiveStep['kind'], text }] : [];
  });
}

function parseFiles(v: unknown): LiveFile[] {
  if (!Array.isArray(v)) throw bad('files must be a list');
  return v.slice(0, MAX_FILES).map((f) => {
    if (!isObj(f) || typeof f.path !== 'string' || !f.path.trim()) throw bad('each file is {path, status?, added?, deleted?}');
    const status = f.status ?? 'M';
    if (!(FILE_STATUSES as readonly unknown[]).includes(status)) throw bad(`file status must be ${FILE_STATUSES.join(' | ')}`);
    return { path: cleanText(f.path, MAX_PATH_CHARS), status: status as LiveFile['status'], added: count(f.added, 'added'), deleted: count(f.deleted, 'deleted') };
  });
}

const KEYS = new Set(['run_id', 'seq', 'phase', 'steps', 'files', 'diff', 'ended']);

/** The live windows of this server process, at most maxCards of them. */
export class LiveStore {
  private windows = new Map<string, LiveWindow>();
  private maxCards: number;
  constructor(maxCards = MAX_CARDS) { this.maxCards = maxCards; }

  get(card: string): LiveWindow { return this.windows.get(card) ?? emptyWindow(card); }

  /** POST body {run_id, seq, phase?, steps?, files?, diff?, ended?}: steps are added (the newest MAX_STEPS kept), files
   *  and diff replace what was there, and a new run_id starts the window over. `seq` orders the runner's updates (its
   *  clock in ms, made strictly increasing): one not newer than the window's arrived late and is ignored (`stale: true` in
   *  the answer, nothing changes), so a slow update of an earlier phase never replaces a later one or reopens an ended
   *  window. A new run is taken whatever its seq once the shown run has ended (another machine's clock may be behind). */
  update(card: string, body: unknown, actor: string, now = new Date()): LiveWindow & { stale?: true } {
    if (!isObj(body)) throw bad('body must be a JSON object');
    const extra = Object.keys(body).filter((k) => !KEYS.has(k));
    if (extra.length) throw bad(`unknown field(s): ${extra.join(', ')}`);
    if (typeof body.run_id !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(body.run_id)) throw bad('run_id must be 1-80 letters, digits or ._:-');
    if (!Number.isSafeInteger(body.seq) || (body.seq as number) < 1) throw bad('seq must be a whole number >= 1');
    const seq = body.seq as number;
    if (body.phase !== undefined && !(PHASES as readonly unknown[]).includes(body.phase)) throw bad(`phase must be ${PHASES.join(' | ')}`);
    if (body.ended !== undefined && typeof body.ended !== 'boolean') throw bad('ended must be true or false');
    if (body.diff !== undefined && typeof body.diff !== 'string') throw bad('diff must be a string');
    const at = now.toISOString();
    const steps = body.steps === undefined ? [] : parseSteps(body.steps, at);
    const files = body.files === undefined ? null : parseFiles(body.files);
    const diff = typeof body.diff === 'string' ? sanitizeDiff(body.diff) : null;

    const old = this.windows.get(card);
    if (old && seq <= old.seq && !(old.ended && old.run_id !== body.run_id)) return { ...old, stale: true };
    const prev = old && old.run_id === body.run_id ? old : emptyWindow(card);
    const next: LiveWindow = {
      card, run_id: body.run_id, actor, seq, phase: (body.phase as string | undefined) ?? prev.phase, updated_at: at, ended: body.ended === true,
      steps: [...prev.steps, ...steps].slice(-MAX_STEPS), files: files ?? prev.files,
      diff: diff ? diff.diff : prev.diff, diff_truncated: diff ? diff.truncated : prev.diff_truncated,
    };
    this.windows.delete(card);
    this.windows.set(card, next);
    while (this.windows.size > this.maxCards) this.windows.delete(this.windows.keys().next().value!);
    return next;
  }
}
