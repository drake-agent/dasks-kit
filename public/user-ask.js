// The user decision shape: the one place the fixed lines live. The server (API, /asks.md, the signed scope), the /asks
// page and the spec step (POST /api/asks/preview → the `## Conflicts` section) all render from here, so the text the
// user reads, the text the user signs and the text in the spec are the same bytes.
// Pure ESM, no DOM: imported by src/server.ts and by public/asks.js.

export const KINDS = ['conflict', 'taste'];
/** What an answer does to the card: proceed = auto-ok on its spec; respec = back to its spec; cancel = cancelled. */
export const EFFECTS = ['proceed', 'respec', 'cancel'];
/** Always offered besides the card's own options: neither fits, write it again. */
export const FIXED_CHOICE = { key: 'none', text: 'Neither — write it again', effect: 'respec' };
export const KEYS = ['A', 'B'];
/** What each effect does, shown next to every choice and signed with it: the text alone never decides what runs. */
export const EFFECT_LABEL = { proceed: 'build it', respec: 'rewrite the card', cancel: 'cancel the card' };
const FIELDS = ['kind', 'before', 'wants', 'code', 'options', 'rec'];
const MAX = { quote: 300, wants: 200, behavior: 200, at: 160, option: 120, why: 160 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** before.ref: a short reference to where it was decided (a decision id, an issue, a doc anchor). */
const REF = /^[A-Za-z0-9][A-Za-z0-9._#\/:-]{0,79}$/;
const AT = /^[^\s:]+:\d+(-\d+)?$/;

const plainErr = (v, name, max) => {
  if (typeof v !== 'string' || !v.trim()) return `${name} is required (text)`;
  if (v.length > max) return `${name} is at most ${max} characters`;
  if (/[<>\u0000-\u001f\u007f\u2028\u2029]/.test(v)) return `${name} must be plain one-line text (no < > or line breaks)`;
  return '';
};
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const extra = (o, keys) => Object.keys(o).filter((k) => !keys.includes(k));

/** Every way the input misses the shape ([] = it fits). */
export function validateAsk(a) {
  if (!isObj(a)) return ['an ask is an object {kind, before, wants, code, options, rec}'];
  const errs = [];
  const push = (e) => { if (e) errs.push(e); };
  const x = extra(a, FIELDS); if (x.length) errs.push(`unknown field(s): ${x.join(', ')}`);
  if (!KINDS.includes(a.kind)) errs.push(`kind must be ${KINDS.join(' | ')}`);
  const conflict = a.kind === 'conflict';
  if (a.before === undefined || a.before === null) { if (conflict) errs.push('before is required for a conflict: {quote, date, ref?}'); }
  else if (!isObj(a.before)) errs.push('before must be {quote, date, ref?}');
  else {
    const bx = extra(a.before, ['quote', 'date', 'ref']); if (bx.length) errs.push(`before: unknown field(s): ${bx.join(', ')}`);
    push(plainErr(a.before.quote, 'before.quote', MAX.quote));
    if (typeof a.before.date !== 'string' || !DATE.test(a.before.date)) errs.push('before.date must be YYYY-MM-DD');
    if (a.before.ref !== undefined && a.before.ref !== '' && (typeof a.before.ref !== 'string' || !REF.test(a.before.ref))) errs.push('before.ref must be a short reference (letters, digits and . _ # / : -, at most 80)');
  }
  push(plainErr(a.wants, 'wants', MAX.wants));
  if (a.code !== undefined && a.code !== null) {
    if (!isObj(a.code)) errs.push('code must be {behavior, at} or null');
    else {
      const cx = extra(a.code, ['behavior', 'at']); if (cx.length) errs.push(`code: unknown field(s): ${cx.join(', ')}`);
      push(plainErr(a.code.behavior, 'code.behavior', MAX.behavior));
      if (typeof a.code.at !== 'string' || a.code.at.length > MAX.at || !AT.test(a.code.at)) errs.push('code.at must be file:line');
    }
  }
  if (!Array.isArray(a.options) || a.options.length < 1 || a.options.length > 2) errs.push('options: 1 or 2 choices');
  else a.options.forEach((o, i) => {
    if (!isObj(o)) { errs.push(`options[${i}] must be {key, text, effect}`); return; }
    const ox = extra(o, ['key', 'text', 'effect']); if (ox.length) errs.push(`options[${i}]: unknown field(s): ${ox.join(', ')}`);
    if (o.key !== KEYS[i]) errs.push(`options[${i}].key must be ${KEYS[i]}`);
    push(plainErr(o.text, `options[${i}].text`, MAX.option));
    if (!EFFECTS.includes(o.effect)) errs.push(`options[${i}].effect must be ${EFFECTS.join(' | ')}`);
  });
  if (!isObj(a.rec)) errs.push('rec must be {key, why}');
  else {
    const rx = extra(a.rec, ['key', 'why']); if (rx.length) errs.push(`rec: unknown field(s): ${rx.join(', ')}`);
    if (!Array.isArray(a.options) || !a.options.some((o) => o && o.key === a.rec.key)) errs.push('rec.key must be one of the options');
    push(plainErr(a.rec.why, 'rec.why', MAX.why));
  }
  return errs;
}

/** Only the shape's fields, in order (what the server stores). */
export function pickAsk(a) {
  const before = a.before ? { quote: a.before.quote, date: a.before.date, ...(a.before.ref ? { ref: a.before.ref } : {}) } : null;
  const code = a.code ? { behavior: a.code.behavior, at: a.code.at } : null;
  return { kind: a.kind, before, wants: a.wants, code, options: a.options.map((o) => ({ key: o.key, text: o.text, effect: o.effect })), rec: { key: a.rec.key, why: a.rec.why } };
}

/** The labelled lines, in order. Conflict: Decided before · Wanted now · Code now · Choices · Recommended. Taste: Pick · Choices · Recommended. */
export function askLines(a) {
  const choices = { label: 'Choices', value: a.options.map((o) => `${o.key} ${o.text} (→ ${EFFECT_LABEL[o.effect]})`).join(' / ') };
  const rec = { label: 'Recommended', value: `${a.rec.key} — ${a.rec.why}` };
  if (a.kind === 'taste') return [{ label: 'Pick', value: a.wants }, choices, rec];
  const b = a.before;
  return [
    { label: 'Decided before', value: `"${b.quote}" (${b.ref ? `${b.date} / ${b.ref}` : b.date})` },
    { label: 'Wanted now', value: a.wants },
    { label: 'Code now', value: a.code ? `${a.code.behavior} (${a.code.at})` : 'no such code' },
    choices,
    rec,
  ];
}

export const askText = (a) => askLines(a).map((l) => `${l.label}: ${l.value}`).join('\n');

/** The spec's `## Conflicts` section: `none`, or one numbered block per conflict. */
export function conflictsSection(asks) {
  if (!asks.length) return '## Conflicts\nnone\n';
  return `## Conflicts\n${asks.map((a, i) => `\n### ${i + 1}\n${askText(a)}\n`).join('')}`;
}

/** The choices one ask offers: its options, then the fixed "none". */
export const choicesOf = (a) => [...a.options.map((o) => o.key), FIXED_CHOICE.key];
export const choiceOf = (a, key) => a.options.find((o) => o.key === key) ?? (key === FIXED_CHOICE.key ? FIXED_CHOICE : null);

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim() || '—';
/** The title the queue shows (and the scope signs). */
export const askTitle = (t) => one(t.title);
/** What the human signs: the card, its revision, the spec version it would change, the ask id, the shown title, the shape
 *  word for word, and every choice with its effect. */
export function askScope(t, a, specVersion = 0) {
  const choices = [...a.options, FIXED_CHOICE].map((o) => `${o.key}=${o.effect}`).join(' / ');
  return [`card: ${t.id}`, `revision: ${Number(t.version || 0)}`, `spec: v${Number(specVersion) || 0}`, `ask: ${a.id}`, `kind: ${a.kind}`, `title: ${askTitle(t)}`, askText(a), `choices: ${choices}`].join('\n');
}

// ---------- spec text: the one auto-ok header line ----------
const HEADER_LINE = /^[A-Za-z_][A-Za-z0-9_-]*[ \t]*:/;
const AUTO_OK = /^[ \t]*auto-ok[ \t]*:/i;
/** Lines and the break after each one, as written (CRLF, CR and LF may be mixed; the spec store keeps the bytes). */
function splitLines(text) {
  const parts = text.split(/(\r\n|\r|\n)/);
  const lines = [], seps = [];
  for (let i = 0; i < parts.length; i += 2) { lines.push(parts[i]); seps.push(parts[i + 1] ?? ''); }
  return { lines, seps };
}
const joinLines = (lines, seps) => lines.map((l, i) => l + seps[i]).join('');
/** Index range [start, end) of the card's header block: after leading blank lines, `# ` title/comment lines and one-line
 *  HTML comments, the `key: value` lines (and their indented continuations) up to the first blank line or heading. */
function headerRange(lines) {
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || /^# /.test(lines[i]) || /^<!--.*-->\s*$/.test(lines[i]))) i++;
  const start = i;
  while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#') && (HEADER_LINE.test(lines[i]) || /^[ \t]+\S/.test(lines[i]))) i++;
  return [start, i];
}

/** True when the spec has a header block setAutoOk can write into. */
export const hasHeader = (text) => { const { lines } = splitLines(text); const [s, e] = headerRange(lines); return e > s && HEADER_LINE.test(lines[s]); };

/** The spec with exactly one `auto-ok: true  # <note>` header line (every existing auto-ok header line is replaced by the
 *  first one; any others are removed). Throws when the text has no header block: the server checks hasHeader first. */
export function setAutoOk(text, note) {
  const { lines, seps } = splitLines(text);
  const [start, end] = headerRange(lines);
  if (end === start || !HEADER_LINE.test(lines[start])) throw new Error('the spec has no header block (key: value lines) to put auto-ok in');
  const line = `auto-ok: true  # ${String(note).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim()}`;
  const hits = [];
  for (let i = start; i < end; i++) if (AUTO_OK.test(lines[i])) hits.push(i);
  if (hits.length) {
    lines[hits[0]] = line;
    for (const i of hits.slice(1).reverse()) { lines.splice(i, 1); seps.splice(i, 1); }
  } else {
    // after the last header line, with that line's break (or the text's first break when it had none)
    const sep = seps[end - 1] || seps.find(Boolean) || '\n';
    if (!seps[end - 1]) seps[end - 1] = sep;
    lines.splice(end, 0, line); seps.splice(end, 0, sep);
  }
  return joinLines(lines, seps);
}

/** True when two spec texts differ only in their auto-ok header line(s) (every other line and line break the same). */
export function sameExceptAutoOk(a, b) {
  const strip = (t) => {
    const { lines, seps } = splitLines(t); const [s, e] = headerRange(lines);
    const keep = lines.map((l, i) => i).filter((i) => !(i >= s && i < e && AUTO_OK.test(lines[i])));
    return JSON.stringify(keep.map((i) => [lines[i], seps[i] === '' ? '' : seps[i]]));
  };
  return strip(a) === strip(b);
}
