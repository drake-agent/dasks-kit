// A card's real file list (docs/cards.md "touches"): the files its PR head changes, kept on the task as `touches_actual`
// with that head's commit in `touches_sha`. The runner writes both after it opens or updates the card's PR. The board's
// claim check then holds a doing card on this list instead of its planned `touches:` line. Pure: no I/O.
import { literalTouch, normPath } from './touches.ts';

/** The longest stored list, in characters of the joined `a, b` value. A longer PR is shortened to folder entries. */
export const TOUCHES_CAP = 3000;
export const SHA_RE = /^[0-9a-f]{40}$/;

/** One path as stored: trimmed, `./` and repeated slashes gone, a folder entry (`src/lib/`) keeps its slash. A path with a
 *  comma (the list separator) becomes its nearest comma-free parent folder; with none but the repo root it is dropped. */
function onePath(raw: string): string {
  const t = raw.trim();
  const segs = t.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length || segs.includes('..')) return '';
  const cut = segs.findIndex((s) => s.includes(','));
  if (cut < 0) return segs.join('/') + (t.endsWith('/') ? '/' : '');
  return cut === 0 ? '' : segs.slice(0, cut).join('/') + '/';
}

const fits = (list: string[], cap: number) => list.join(', ').length <= cap;

/** A PR's file list → the stored list: cleaned, deduped, sorted. Over `cap` it is shortened to folder entries (`dir/`,
 *  which hold their whole folder), deepest level first; files in the repo root stay as they are. Never the whole repo:
 *  a list even the top-level folders cannot fit becomes [] (the planned `touches:` line holds instead). */
export function storedTouches(files: readonly string[], cap = TOUCHES_CAP): string[] {
  const exact = [...new Set(files.map(onePath).filter(Boolean))].sort();
  if (fits(exact, cap)) return exact;
  const segs = exact.map((p) => p.replace(/\/$/, '').split('/'));
  for (let d = Math.max(...segs.map((s) => s.length)) - 1; d >= 1; d--) {
    const short = [...new Set(segs.map((s, i) => (s.length > d ? s.slice(0, d).join('/') + '/' : exact[i])))].sort();
    if (fits(short, cap)) return short;
  }
  return [];
}

/** A touches_actual value as a write sends it (a string `a, b` or a list of paths) → the stored string; null when it is
 *  neither (the write is refused). '' and null clear it. */
export function normTouchesValue(v: unknown): string | null {
  if (v === null || v === undefined) return '';
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!arr || !arr.every((x) => typeof x === 'string')) return null;
  return storedTouches(arr as string[]).join(', ');
}

/** The stored list back as paths. */
export const touchesList = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** The paths a doing card holds: its PR's real files when the runner stored them, else its planned `touches:` paths.
 *  [] holds nothing (a card without touches overlaps nothing). */
export function lockTouches(t: { touches_actual?: string }, planned: string[]): string[] {
  const actual = touchesList(t.touches_actual).map(literalTouch).filter((p) => normPath(p) !== '');
  return actual.length ? actual : planned;
}

/** `https://github.com/<owner>/<repo>/pull/<n>` → the REST route of its file list; null for any other link. */
export function prFilesRoute(pr: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(pr.trim());
  return m ? `repos/${m[1]}/${m[2]}/pulls/${m[3]}/files?per_page=100` : null;
}
