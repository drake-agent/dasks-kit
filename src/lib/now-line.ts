// Now line (docs/cards.md "Now line"): one plain line on a card saying what its agent is doing right now.
// Pure helpers: normNow (the write rule), lintNow (a log pasted in the line), ago (its age).
import { MAX_NOW_CHARS } from './schema.ts';
import { HttpError } from './write.ts';

/** One line, whitespace runs collapsed, ≤120 characters after that. Refused, never cut. '' (or only spaces) clears. */
export function normNow(v: string): string {
  if (/[\r\n]/.test(v)) throw new HttpError(400, 'now is one line', { rule: 'now' });
  const out = v.replace(/\s+/g, ' ').trim();
  if (out.length > MAX_NOW_CHARS) throw new HttpError(400, `now is over ${MAX_NOW_CHARS} characters`, { rule: 'now' });
  return out;
}

// A path token: starts with / ~/ ./ ../ and goes on, or has a / and ends with a file extension (src/lib/write.ts).
// URLs are not; a lone "/" separator is not; trailing punctuation (write.ts,) is ignored.
const isPath = (raw: string) => {
  const w = raw.replace(/[),;:!?]+$/, '').replace(/\.$/, '');
  return !/^https?:\/\//.test(w) && (/^(\/|~\/|\.\.?\/)./.test(w) || /\/.*\.[A-Za-z0-9]{1,5}$/.test(w));
};

/** 'log' when the line reads like a log or a runner stamp (RESULT, a path); '' otherwise. The write
 *  still lands: the mark only lets the screens fold it. */
export function lintNow(line: string): '' | 'log' {
  if (/RESULT/.test(line)) return 'log';
  return line.split(/\s+/).some((w) => w && isPath(w)) ? 'log' : '';
}

/** Age of an ISO time: <60 min "N min ago", <48 h "N h ago", else "N d ago". Future = "0 min ago".
 *  Missing or not a time (a hand-edited card) gives ''. */
export function ago(iso: string | undefined, now = new Date()): string {
  const t = Date.parse(iso ?? '');
  if (!iso || !Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
