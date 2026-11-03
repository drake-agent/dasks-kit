// The captain (docs/captain.md): one long-lived agent session that steers the board. The board hands out one lease at a
// time (run/captain.json): a second captain gets 409 with the holder until the lease is released or runs out. Renewing
// needs the lease id, so a second session under the same name cannot take over a live lease either.
// Captain chat (run/captain-chat.jsonl): the logged-in human and the lease holder talk. Chat is information only: it
// never approves anything; approvals stay the passphrase-gated board actions.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './write.ts';

export interface Lease { holder: string; lease_id: string; since: string; expires_at: string }

export class CaptainLease {
  private file: string;
  private lease: Lease | null = null;
  constructor(root: string) {
    this.file = path.join(root, 'run', 'captain.json');
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && typeof j.holder === 'string' && typeof j.lease_id === 'string' && !Number.isNaN(Date.parse(j.expires_at))) this.lease = j;
    } catch { /* none */ }
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.lease) + '\n');
    fs.renameSync(tmp, this.file);
  }
  /** The live lease, or null (none, or run out). */
  current(now = new Date()): Lease | null {
    return this.lease && Date.parse(this.lease.expires_at) > now.getTime() ? this.lease : null;
  }
  /** Take the lease (no lease_id) or renew it (the lease_id it was given). 409 while someone else holds it. */
  take(holder: string, ttlSec: number, leaseId: string | undefined, now = new Date()): Lease {
    const cur = this.current(now);
    if (cur && !(leaseId && cur.lease_id === leaseId && cur.holder === holder))
      throw new HttpError(409, `the captain lease is held by ${cur.holder} until ${cur.expires_at}`, { rule: 'captain-lease', holder: cur.holder, expires_at: cur.expires_at });
    if (!cur && leaseId) throw new HttpError(409, 'that lease ran out or was released; take a new one', { rule: 'captain-lease', holder: '' });
    // A renewal never shortens the lease: a long hold taken for a merge outlives a shorter heartbeat renewal.
    const want = now.getTime() + ttlSec * 1000;
    const expires_at = new Date(cur ? Math.max(want, Date.parse(cur.expires_at)) : want).toISOString();
    this.lease = cur ? { ...cur, expires_at } : { holder, lease_id: randomUUID(), since: now.toISOString(), expires_at };
    this.save();
    return this.lease;
  }
  /** Does `holder` hold the live lease under exactly this lease id? */
  holds(holder: string, leaseId: unknown, now = new Date()): boolean {
    const cur = this.current(now);
    return !!cur && typeof leaseId === 'string' && cur.lease_id === leaseId && cur.holder === holder;
  }
  release(leaseId: string, now = new Date()): void {
    const cur = this.current(now);
    if (!cur || cur.lease_id !== leaseId) throw new HttpError(409, 'not the live lease; nothing released', { rule: 'captain-lease', holder: cur?.holder ?? '' });
    this.lease = null;
    this.save();
  }
}

export interface ChatMessage { seq: number; at: string; from: string; text: string }
export const CHAT_MAX = 2000;

export class CaptainChat {
  private file: string;
  private rows: ChatMessage[] = [];
  constructor(root: string) {
    this.file = path.join(root, 'run', 'captain-chat.jsonl');
    try {
      for (const l of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { const m = JSON.parse(l); if (Number.isInteger(m?.seq) && typeof m.text === 'string') this.rows.push(m); } catch { /* torn line */ }
      }
    } catch { /* none yet */ }
  }
  get lastSeq(): number { return this.rows.length ? this.rows[this.rows.length - 1].seq : 0; }
  post(from: string, text: unknown, now = new Date()): ChatMessage {
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
    const t = text.replace(/\r\n?/g, '\n').trim();
    if (t.length > CHAT_MAX) throw new HttpError(400, `text is at most ${CHAT_MAX} characters`);
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) throw new HttpError(400, 'text must not contain control characters');
    const m: ChatMessage = { seq: this.lastSeq + 1, at: now.toISOString(), from, text: t };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(m) + '\n');
    this.rows.push(m);
    return m;
  }
  /** Messages after seq, oldest first (at most limit); from the start, the newest limit. */
  since(seq: number, limit = 200): ChatMessage[] {
    const r = this.rows.filter((m) => m.seq > seq);
    return seq > 0 ? r.slice(0, limit) : r.slice(-limit);
  }
}
