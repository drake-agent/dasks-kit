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
  /** true once the runner said the agent stopped: the window then shows its last state. */
  ended: boolean;
  steps: LiveStep[]; files: LiveFile[]; diff: string; diff_truncated: boolean;
}

export const emptyWindow = (card: string): LiveWindow => ({ card, run_id: null, actor: null, phase: null, updated_at: null, ended: false, steps: [], files: [], diff: '', diff_truncated: false });

/** One line, control characters dropped, redacted, then cut to max characters. */
export function cleanText(v: string, max: number): string {
  const flat = redact(v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim());
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Files whose content is never shown, only their name: env files, key stores, configuration formats, and names that say
// secret, token, password or credential.
const SENSITIVE = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|\.pypirc|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*(?:secret|credential|password|passwd|token|private)[^/]*)$|\.(?:ya?ml|toml|ini|conf|cfg|properties|plist|pem|key|p12|pfx|jks|keystore|crt|cer)$/i;
export const isSensitivePath = (p: string): boolean => SENSITIVE.test(p.trim());

/** A unified diff made safe to show: a file section whose old or new name is sensitive keeps only its header line, text
 *  before the first `diff --git` header is dropped (no file to judge it by), and the rest is redacted (key blocks
 *  across lines included). Then cut on a line boundary to MAX_DIFF_BYTES. */
export function sanitizeDiff(raw: string): { diff: string; truncated: boolean } {
  const text = raw.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const parts = text.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '));
  const safe = parts.map((sec) => {
    const head = sec.slice(0, sec.indexOf('\n') < 0 ? sec.length : sec.indexOf('\n'));
    const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(head);
    const names = [m?.[1], m?.[2], ...[...sec.matchAll(/^(?:rename (?:from|to)|[-+]{3} [ab]\/) ?(.+)$/gm)].map((x) => x[1])];
    if (!m || names.some((n) => n && isSensitivePath(n))) return `${redact(head)}\n[diff omitted: sensitive file]\n`;
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

const KEYS = new Set(['run_id', 'phase', 'steps', 'files', 'diff', 'ended']);

/** The live windows of this server process, at most maxCards of them. */
export class LiveStore {
  private windows = new Map<string, LiveWindow>();
  private maxCards: number;
  constructor(maxCards = MAX_CARDS) { this.maxCards = maxCards; }

  get(card: string): LiveWindow { return this.windows.get(card) ?? emptyWindow(card); }

  /** POST body {run_id, phase?, steps?, files?, diff?, ended?}: steps are added (the newest MAX_STEPS kept), files and
   *  diff replace what was there, and a new run_id starts the window over. */
  update(card: string, body: unknown, actor: string, now = new Date()): LiveWindow {
    if (!isObj(body)) throw bad('body must be a JSON object');
    const extra = Object.keys(body).filter((k) => !KEYS.has(k));
    if (extra.length) throw bad(`unknown field(s): ${extra.join(', ')}`);
    if (typeof body.run_id !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(body.run_id)) throw bad('run_id must be 1-80 letters, digits or ._:-');
    if (body.phase !== undefined && !(PHASES as readonly unknown[]).includes(body.phase)) throw bad(`phase must be ${PHASES.join(' | ')}`);
    if (body.ended !== undefined && typeof body.ended !== 'boolean') throw bad('ended must be true or false');
    if (body.diff !== undefined && typeof body.diff !== 'string') throw bad('diff must be a string');
    const at = now.toISOString();
    const steps = body.steps === undefined ? [] : parseSteps(body.steps, at);
    const files = body.files === undefined ? null : parseFiles(body.files);
    const diff = typeof body.diff === 'string' ? sanitizeDiff(body.diff) : null;

    const old = this.windows.get(card);
    const prev = old && old.run_id === body.run_id ? old : emptyWindow(card);
    const next: LiveWindow = {
      card, run_id: body.run_id, actor, phase: (body.phase as string | undefined) ?? prev.phase, updated_at: at, ended: body.ended === true,
      steps: [...prev.steps, ...steps].slice(-MAX_STEPS), files: files ?? prev.files,
      diff: diff ? diff.diff : prev.diff, diff_truncated: diff ? diff.truncated : prev.diff_truncated,
    };
    this.windows.delete(card);
    this.windows.set(card, next);
    while (this.windows.size > this.maxCards) this.windows.delete(this.windows.keys().next().value!);
    return next;
  }
}
