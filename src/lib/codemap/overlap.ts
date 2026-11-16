// "One import apart" (docs/runner.md "Code map"): two cards in one repo whose touches do not overlap, where a file one
// card changes imports (or is imported by) a file the other changes. Only a warning: it never holds a claim or a start.
// The touch lists can be the planned `touches:` or any other list of repo paths. Pure.
import { normPath, touchesOverlap } from '../touches.ts';
import type { CodeMap, MapView } from './map.ts';

/** File entries only: a directory (`src/lib/`) or glob (`**`, `*.ts`) entry never makes an import warning. */
const fileEntries = (t: string[]) => [...new Set(t.filter((raw) => !raw.trim().endsWith('/') && !/[*?[{]/.test(raw)).map(normPath).filter(Boolean))];

const index = new WeakMap<CodeMap, { edges: Set<string>; dirs: Map<string, string[]>; files: Set<string> }>();
function indexOf(m: CodeMap) {
  let ix = index.get(m);
  if (!ix) {
    ix = { edges: new Set(), dirs: new Map(), files: new Set(m.files) };
    for (const [a, b] of m.edges) if (b.endsWith('/')) ix.dirs.set(a, [...(ix.dirs.get(a) ?? []), b]); else ix.edges.add(`${a}\n${b}`);
    index.set(m, ix);
  }
  return ix;
}

/** `[from, to]` pairs (a file of each list, `from` imports `to`) joined by one map edge; [] when the lists overlap. */
export function importPairs(a: string[], b: string[], map: CodeMap): [string, string][] {
  if (touchesOverlap(a, b)) return [];   // the touches lock already covers these
  const ix = indexOf(map), out: [string, string][] = [];
  // a target-dir edge reaches only files the map has: a file new in the card has no edges
  const joins = (x: string, y: string) => ix.edges.has(`${x}\n${y}`) || (ix.files.has(y) && (ix.dirs.get(x) ?? []).some((d) => y.startsWith(d)));
  for (const x of fileEntries(a)) for (const y of fileEntries(b)) {
    if (joins(x, y)) out.push([x, y]); else if (joins(y, x)) out.push([y, x]);
  }
  return out;
}

/** The log line for `card` one import from `other`; '' when there is none or no map. */
export function importWarning(card: string, mine: string[], other: string, theirs: string[], view: MapView | null): string {
  if (!view) return '';
  const pairs = importPairs(mine, theirs, view.map);
  if (!pairs.length) return '';
  const more = pairs.length > 1 ? `, +${pairs.length - 1} more` : '';
  return `warning: ${card} is one import from ${other}: ${pairs[0][0]} imports ${pairs[0][1]}${more} (map ${view.map.sha.slice(0, 7)}${view.stale ? ', stale' : ''}), not held`;
}

/** The warnings for a card just claimed, against the claim reply's `beside` list (doing cards in the same repo). */
export function claimWarnings(card: string, mine: string[], beside: unknown, view: MapView | null): string[] {
  if (!view || !Array.isArray(beside)) return [];
  return beside.filter((o): o is { id: string; touches: string[] } => typeof o?.id === 'string' && Array.isArray(o?.touches))
    .map((o) => importWarning(card, mine, o.id, o.touches.filter((t) => typeof t === 'string'), view)).filter(Boolean);
}
