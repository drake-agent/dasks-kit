// The card contract check: hard errors refuse a card, soft ones are warnings. Includes the implementer/reviewer pair
// check: the two must be of different model families. Whitespace, digits and line breaks follow Python's rules (\s and
// str.strip(), Unicode \d, universal newlines, first-line-only pair errors), so the reference reader in
// test/fixtures/contract/contract.py gives the same verdict (test/contract.test.ts).
import { familyFor } from './schema.ts';

const ROLES = ['builder', 'reviewer', 'designer', 'marketer', 'qa', 'ops', 'research'];
const CODE_ROLES = ['builder', 'reviewer'];
const REQ = ['id', 'goal', 'role', 'tier', 'repo', 'branch', 'lane', 'deadline'];
const SOFT_SECTIONS = ['Background', 'Why', 'Context pack', 'Tests'];

/** Python's whitespace (str.isspace / re \s on str): JS \s lacks \x1c-\x1f and \x85, and adds \ufeff. */
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const S = `[${WS}]`;
const IS_WS = new RegExp(`^${S}$`);
const isWs = (c: string) => IS_WS.test(c);
// Hand-written scans, not regexes: a long whitespace run inside a value makes `\s+$` and the key regex backtrack (seconds
// of blocked server for one 20 KB line). Same results as Python's strip() and re.match.
function pyStrip(s: string): string {
  let a = 0, b = s.length;
  while (a < b && isWs(s[a])) a++;
  while (b > a && isWs(s[b - 1])) b--;
  return s.slice(a, b);
}
function pyLstrip(s: string): string { let a = 0; while (a < s.length && isWs(s[a])) a++; return s.slice(a); }
function pyRstrip(s: string): string { let b = s.length; while (b > 0 && isWs(s[b - 1])) b--; return s.slice(0, b); }
/** `re.match(r"^([a-z_]+):\s*(.*?)\s*(#.*)?$", line)`: the lazy value ends where only whitespace and an optional `#…`
 *  comment remain, i.e. at the first `#`, minus the whitespace before it. */
function keyLine(line: string): [string, string] | null {
  const m = /^[a-z_]+:/.exec(line);
  if (!m) return null;
  const rest = pyLstrip(line.slice(m[0].length));
  const h = rest.indexOf('#');
  return [m[0].slice(0, -1), pyRstrip(h < 0 ? rest : rest.slice(0, h))];
}
const ITEM_RE = new RegExp(`^${S}*-${S}+`);
/** Only the first line of a pair error is kept: a value with \v, \f, \x1c-\x1e, \x85 or \u2028 cuts there. */
const firstLine = (s: string) => pyStrip(s).split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)[0];
const DEADLINE_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;

export interface CardVerdict { errors: string[]; warnings: string[]; fields: Record<string, string>; pass_checks: string[] }

/** Header lines up to the first `## ` heading: `key: value  # comment` and the pass_checks list. */
function parseCard(text: string): { d: Record<string, string>; checks: string[] } {
  const d: Record<string, string> = Object.create(null); const checks: string[] = []; // keys like __proto__ stay plain
  let inlist = false;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith('## ')) break;
    if (!pyStrip(line) || pyLstrip(line).startsWith('#')) continue;
    if (inlist && ITEM_RE.test(line)) { checks.push(pyStrip(line.replace(ITEM_RE, ''))); continue; }
    const kv = keyLine(line);
    if (!kv) continue;
    inlist = kv[0] === 'pass_checks';
    if (!inlist) d[kv[0]] = kv[1];
  }
  return { d, checks };
}

/** The implementer/reviewer pair check: null when both name a known model family and the families differ, else the
 *  refusal. A name's family: the board's config `families` (exact id or `prefix*`), else the default prefixes
 *  (schema.ts DEFAULT_FAMILY_PREFIXES) on the lowercased name without spaces. */
export function pairGuard(impl: string, review: string, families: Record<string, string> = {}): string | null {
  const a1 = impl, a2 = review;
  const canon = (s: string) => familyFor(s, families) ?? familyFor(s.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/ /g, ''), families) ?? '?';
  const die = (s: string) => `PAIR REFUSED: ${s}`;
  if (!a1) return die('implementer model not specified');
  if (!a2) return die('reviewer model not specified');
  const a = canon(a1), b = canon(a2);
  if (a === '?') return die(`unknown implementer model '${a1}'`);
  if (b === '?') return die(`unknown reviewer model '${a2}'`);
  if (a === b) return die(`same model family reviewing itself (${a1} -> ${a2})`);
  return null;
}

/** The contract check on a card's text: `errors` refuse it, `warnings` do not. */
export function checkCard(text: string, families: Record<string, string> = {}): CardVerdict {
  const errors: string[] = [];
  const { d, checks } = parseCard(text);
  for (const k of REQ) { const v = d[k] ?? ''; if (!v || v.startsWith('<')) errors.push(`missing field: ${k}`); }
  if (d.role && !ROLES.includes(d.role)) errors.push(`role must be one of ${[...ROLES].sort().join('|')}`);
  if (d.tier && !['1', '2', '3'].includes(d.tier)) errors.push('tier must be 1, 2 or 3');
  if (d.deadline && !DEADLINE_RE.test(d.deadline)) errors.push('deadline must be YYYY-MM-DD');
  const pc = checks.filter((c) => c && !c.startsWith('<'));
  if (pc.length < 3 || pc.length > 5) errors.push(`pass_checks: need 3-5 concrete checks, got ${pc.length}`);
  if (CODE_ROLES.includes(d.role) || d.impl || d.review) {
    const e = pairGuard(d.impl ?? '', d.review ?? '', families);
    if (e) errors.push(firstLine(e));
  }
  // Soft checks read the whole text with universal newlines, as open() does in Python.
  const txt = text.replace(/\r\n?/g, '\n');
  const warnings: string[] = [];
  for (const sec of SOFT_SECTIONS) {
    // Python's re.M ^ is after \n only (JS's m flag also breaks at \u2028/\u2029), so the line starts are spelled out.
    const m = new RegExp(`(?:^|(?<=\\n))## ${sec}[^\\n]*\\n([\\s\\S]*?)(?=(?<=\\n)## |(?![\\s\\S]))`).exec(txt);
    const body = m ? pyStrip(m[1]) : '';
    if (!m || !body || body.startsWith('<')) warnings.push(`self-contained card: section '## ${sec}' missing or empty`);
  }
  if (!d.depends_on || d.depends_on.startsWith('<')) warnings.push("depends_on missing (write 'none' if nothing)");
  if (d.size !== 'small' && d.size !== 'big') warnings.push("size missing: write 'small' or 'big' (big = a deeper review; unsure = big)");
  return { errors, warnings, fields: d, pass_checks: checks };
}
