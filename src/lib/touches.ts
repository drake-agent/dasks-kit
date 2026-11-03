// The one reader of a card's `touches:` header (docs/cards.md "touches"). Lenient for the runners: a prose word is dropped, so it can never hold the whole repo or add caps. Strict for the board:
// a new or changed line with prose is refused. Both judge a token with the same rule, so they never disagree.

/** `src/lib/**`, `./src/lib/*.ts`, `src/../src/lib/` → `src/lib`; `.`, `*.json`, `package*.json` → '' (repo root).
 *  `.` and `..` are resolved; a path is cut at its first segment with a glob. */
export function normPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.trim().split('/')) {
    if (/[*?[{]/.test(seg)) break;
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');   // '' = repo root
}

const NONE = /^(none|-|\[\])$/i;
const WHOLE_REPO = new Set(['.', './', '**']);
const PATH_CHARS = /^[A-Za-z0-9_.\/*?\[\]{}@+-]+$/;
// Real globs that normPath sends to the root: `**/*.test.ts`, `*/x`, `*.json`, `package*.json`.
const ROOT_GLOB = /^(\*\*?\/.+|[A-Za-z0-9_.@+-]*\*[A-Za-z0-9_.@+-]*\.[A-Za-z0-9]{1,10})$/;

/** The value of the first `touches:` line above the first `## ` heading, up to a `#` comment; '' when there is none. */
export function touchesValue(text: string): string {
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) break;
    const m = /^touches[ \t]*:([^#]*)/.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

/** The path a token names (repo prefix stripped), or null when it is not a path. */
function keptToken(raw: string): string | null {
  const t = raw.match(/^[A-Za-z0-9_.-]+:(.+)$/)?.[1] ?? raw;
  const bare = t.replace(/^(\.\/)+/, '');   // `./**` and `./**/*.ts` mean what `**` and `**/*.ts` mean
  if (WHOLE_REPO.has(t) || WHOLE_REPO.has(bare)) return t;
  if (!PATH_CHARS.test(t) || t.startsWith('/') || t.startsWith('~')) return null;
  if (!t.includes('/') && !/^.+\.[A-Za-z0-9]{1,10}$/.test(t) && !/^\.[A-Za-z0-9]/.test(t)) return null;
  return normPath(t) !== '' || ROOT_GLOB.test(bare) ? t : null;
}

/** Lenient, for the runners: the path tokens of a touches value in order, without duplicates. `[]` = overlaps nothing. */
export function parseTouches(value: string): string[] {
  const out = new Set<string>();
  for (const raw of value.split(/[,\s]+/)) {
    if (!raw || NONE.test(raw)) continue;
    const t = keptToken(raw);
    if (t !== null) out.add(t);
  }
  return [...out];
}

/** Do two touches lists share a path? '' (the repo root, from `.` or a root glob) overlaps every path; [] overlaps nothing. */
export function touchesOverlap(a: string[], b: string[]): boolean {
  const na = a.map(normPath), nb = b.map(normPath);
  return na.some((x) => nb.some((y) => x === '' || y === '' || x === y || x.startsWith(y + '/') || y.startsWith(x + '/')));
}

/** Strict, for the board: one message per comma-separated entry that is not exactly one path. */
export function touchesErrors(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(',')) {
    const entry = part.trim();
    if (!entry || NONE.test(entry)) continue;
    if (/\s/.test(entry) || keptToken(entry) === null)
      out.push(`touches: "${entry.slice(0, 80)}" is not a repo path; list only comma-separated paths or globs (write a root file without extension as ./Name; move prose into the card body)`);
  }
  return out;
}
