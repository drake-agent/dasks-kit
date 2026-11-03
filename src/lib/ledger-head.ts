// The decision ledger's signed head: {seq, last} = how many lines the ledger had after the last append and the sha256 of
// that line, HMAC'd with ledger.key. It lives next to the keys (not in data/), so cutting lines off the end of the ledger
// (or emptying it) is caught: the chain alone cannot see a missing tail. Rewritten (tmp + rename) after every append.
import fs from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface Head { v: 1; seq: number; last: string; hmac: string }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sign = (key: Buffer, seq: number, last: string) => createHmac('sha256', key).update(`dasks-ledger-head\0${seq}\0${last}`).digest('hex');

/** null when there is no head file yet. */
export function readHead(file: string): Head | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  const h = JSON.parse(text);
  if (!h || h.v !== 1 || !Number.isInteger(h.seq) || typeof h.last !== 'string' || typeof h.hmac !== 'string') throw new Error(`${file}: not a ledger head`);
  return h;
}

export function writeHead(file: string, key: Buffer, seq: number, lastLine: string) {
  const last = sha256(lastLine);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, seq, last, hmac: sign(key, seq, last) }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Error text, or null when the ledger lines still contain everything the head vouches for. Lines after the head are
 *  allowed (a crash between append and head update leaves the head one behind); each line is verified on its own. */
export function headProblem(head: Head | null, key: Buffer, lines: string[]): string | null {
  if (!head) return lines.length ? 'ledger head is missing (deleted?) while the ledger has entries' : null;
  const want = Buffer.from(sign(key, head.seq, head.last), 'hex'); const got = Buffer.from(head.hmac, 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'ledger head HMAC mismatch';
  if (lines.length < head.seq) return `ledger has ${lines.length} line(s) but its head vouches for ${head.seq}: entries were removed`;
  if (head.seq > 0 && sha256(lines[head.seq - 1]) !== head.last) return `line ${head.seq} is not the line the head vouches for`;
  return null;
}
