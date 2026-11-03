// Runner heartbeats (docs/fleet.md). Each runner posts one every look and every minute between; the board keeps the last
// one per machine in run/fleet.json (not committed: it is live state, not history). A machine whose last heartbeat is
// older than fleet.dead_min is quiet, and the cards its runner holds go back to the pool so another machine can take them.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './write.ts';
import { MACHINE_RE } from './auth.ts';

export interface Heartbeat {
  machine: string;
  /** Harness CLIs found on that machine's PATH (claude, codex). */
  harnesses: string[];
  /** Cards it may build at once (runner.max_parallel). */
  slots: number;
  /** Cards its runner is working now. */
  cards: string[];
  /** The kit version, `<semver>+<commit>` from a git clone. */
  version: string;
  enabled: boolean;
  /** Why the runner's last self-update check held ('' = nothing held it). */
  update?: string;
  /** Set by the board. */
  last_seen: string;
  actor: string;
}

const HARNESS_RE = /^[a-z0-9._-]{1,32}$/;
const CARD_RE = /^[a-z][a-z0-9]{0,23}\.t-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The heartbeat a runner sent, checked: 400 on anything malformed. */
export function parseHeartbeat(body: Record<string, unknown>): Omit<Heartbeat, 'last_seen' | 'actor'> {
  const bad = (m: string) => new HttpError(400, `heartbeat: ${m}`);
  const extra = Object.keys(body).filter((k) => !['machine', 'harnesses', 'slots', 'cards', 'version', 'enabled', 'update'].includes(k));
  if (extra.length) throw bad(`unknown field(s) ${extra.join(', ')}`);
  const { machine, harnesses = [], slots = 0, cards = [], version = '', enabled = true, update = '' } = body as any;
  if (typeof machine !== 'string' || !MACHINE_RE.test(machine)) throw bad('machine must be 1-16 lowercase letters, digits or -');
  if (!Array.isArray(harnesses) || harnesses.length > 16 || !harnesses.every((h) => typeof h === 'string' && HARNESS_RE.test(h))) throw bad('harnesses must be a list of names');
  if (!Number.isInteger(slots) || slots < 0 || slots > 64) throw bad('slots must be 0-64');
  if (!Array.isArray(cards) || cards.length > 64 || !cards.every((c) => typeof c === 'string' && CARD_RE.test(c))) throw bad('cards must be a list of card ids');
  if (typeof version !== 'string' || version.length > 40 || /[\u0000-\u001f]/.test(version)) throw bad('version must be a short string');
  if (typeof enabled !== 'boolean') throw bad('enabled must be true or false');
  if (typeof update !== 'string' || update.length > 300 || /[\u0000-\u001f]/.test(update)) throw bad('update must be one line of at most 300 characters');
  return { machine, harnesses, slots, cards, version, enabled, ...(update ? { update } : {}) };
}

export class Fleet {
  private file: string;
  private beats = new Map<string, Heartbeat>();
  constructor(root: string) {
    this.file = path.join(root, 'run', 'fleet.json');
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const h of Array.isArray(j?.machines) ? j.machines : []) if (h && MACHINE_RE.test(h.machine) && !Number.isNaN(Date.parse(h.last_seen))) this.beats.set(h.machine, h);
    } catch { /* none yet */ }
  }
  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ machines: [...this.beats.values()] }, null, 1) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (e: any) { console.error(`fleet: could not save ${this.file} (${e.code || e.message})`); }
  }
  beat(h: Omit<Heartbeat, 'last_seen' | 'actor'>, actor: string, now = new Date()): Heartbeat {
    const row = { ...h, last_seen: now.toISOString(), actor };
    this.beats.set(h.machine, row);
    this.save();
    return row;
  }
  get(machine: string): Heartbeat | undefined { return this.beats.get(machine); }
  /** Every machine with its state: quiet (no heartbeat for deadMin), busy (cards) or idle. */
  list(deadMin: number, now = new Date()) {
    return [...this.beats.values()].sort((a, b) => a.machine.localeCompare(b.machine)).map((h) => {
      const quiet = now.getTime() - Date.parse(h.last_seen) > deadMin * 60_000;
      return { ...h, quiet, state: quiet ? 'quiet' : !h.enabled ? 'off' : h.cards.length ? 'busy' : 'idle' };
    });
  }
}

/** The kit commit in a heartbeat's version (`1.0.0+<hex>`), or ''. */
export const kitCommitOf = (version: string) => /\+([0-9a-f]{7,40})$/.exec(version)?.[1] ?? '';

/** Claimed doing cards held by the runner of a quiet machine: what the board gives back. */
export function deadRunnerCards(tasks: { id: string; status: string; claimed_by?: string }[], quiet: Set<string>): { id: string; machine: string }[] {
  const out: { id: string; machine: string }[] = [];
  for (const t of tasks) {
    const m = /^runner@([a-z0-9-]{1,16})$/.exec(t.claimed_by ?? '');
    if (t.status === 'doing' && m && quiet.has(m[1])) out.push({ id: t.id, machine: m[1] });
  }
  return out;
}
