// The credential redactor: every case in contract/secret-redaction/vectors.json must pass (test/redact.test.ts). The
// comments below explain the rules that are less obvious than a plain line-by-line regex pass.

const PEM_LABEL = String.raw`[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`;
const PEM = new RegExp(String.raw`-----BEGIN ${PEM_LABEL}.*?(?:-----END ${PEM_LABEL}|$)`, 'gs');
const CRED = String.raw`(?=[^\s"',;}]*[0-9+/=_.~:-]|[^\s"',;}]{20})`;
const CRED_START = new RegExp(`^${CRED}`);
const SCHEME = /\b(bearer|basic)([ \t]+)([^\s"',;}|]+(?:\|(?![\w-]+[ \t]*[:=])[^\s"',;}|]+)*)/gi;
const TOKEN = /\b(token)[ \t]+(?=[A-Za-z0-9._~+/=:-]*[0-9+/=_.~:-]|[A-Za-z0-9._~+/=:-]{20})[A-Za-z0-9._~+/=:-]{6,}/gi;
// An unterminated `='v` / `="v` pair runs to the end of the line.
const PAIR = String.raw`(?<==)"[^"\n]*"?|(?<==)'[^'\n]*'?`;
const HEADER = new RegExp(String.raw`(?<![\w-])(["']?(?:proxy-authorization|authorization|set-cookie|cookie)["']?[ \t]*:[ \t]*)(?!["'])((?:[^'"\n]|${PAIR})*(?:[^'"\s]|${PAIR}))`, 'gi');
const KEYWORD = String.raw`(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|authentication|auth(?:[_-]\w+|key)?|cookie|session[_-]?id|credentials?|pass(?=["']?[ \t]*=))`;
// `\\[^\n]` is the Python `\\.`: a JS `.` also stops at \r, which would end a quoted value early.
// A key and value inside escaped JSON (`{\"password\":\"v\"}`) take their backslash-escaped quotes;
// inside such a value `\\\"` is an escaped quote of the inner JSON, so it does not end the value.
const KV = new RegExp(String.raw`(?<![\w-])(["']?[\w-]*?${KEYWORD}\b(?:\\?["'])?[ \t]*[:=][ \t]*)(\\"(?:[^"\\\n]|\\\\\\"|\\[^"\n])*(?:\\")?|\\'(?:[^'\\\n]|\\\\\\'|\\[^'\n])*(?:\\')?|"(?:[^"\\\n]|\\[^\n])*"?|'(?:[^'\\\n]|\\[^\n])*'?|[^\s,;}'"]+)`, 'gi');
// Scheme names are bounded to 32 characters, so a long run of scheme characters costs linear time, not
// quadratic; the kept group is the same text either way.
const URL_CRED = /([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^/\s:@]*:[^/\s@]+@/g;
const URL_PCT = /([a-z][a-z0-9+.-]{0,31}%3a%2f%2f)(?:%(?!3a|40|2f)[0-9a-f]{2}|[^\s/@%&?=#])*%3a(?:%(?!40|2f)[0-9a-f]{2}|[^\s/@%&?=#])+(?=%40)/gi;
const SHAPES = [
  // Vendor key shapes: GitHub, OpenAI / Anthropic (sk-), xAI, Stripe, GitLab, npm, Hugging Face, Groq, Slack, AWS, JWT,
  // Google, Dasks agent tokens, PEM private keys.
  /gh[pousr]_[A-Za-z0-9_]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /(?<![A-Za-z0-9.-])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9.-])xai-[A-Za-z0-9_-]{16,}/g, /(?<![A-Za-z0-9])[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9.-])glpat-[A-Za-z0-9_-]{20,}/g, /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g, /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{40,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g, /AKIA[0-9A-Z]{16}/g, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g, /dsk_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}/gi, new RegExp(`-----BEGIN ${PEM_LABEL}`, 'g'),
];
// A plain `\b(?=[…]*\d)(?=[…]*[A-Z])[…]{32,}={0,2}` re-scans the run from every word start inside it
// (quadratic on `a-a-a-…`). Same matches: take the run from its first word start, then test digit and uppercase on it
// (a later start inside the run is a suffix, which cannot hold a digit or uppercase letter the whole run lacks).
const LONG_RUN = /\b[A-Za-z0-9+/_-]{32,}={0,2}/g;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const NOT_PRINTABLE = /(?! )[\p{C}\p{Z}]/u;

function value(v: string, mark: string): string {
  const q = v[0];
  if (q === '\\' && (v[1] === '"' || v[1] === "'")) { const e = v.slice(0, 2); return e + mark + (v.length > 2 && v.endsWith(e) ? e : ''); }
  if (q !== "'" && q !== '"') return mark;
  return q + mark + (v.length > 1 && v.endsWith(q) ? q : '');
}

function isBasicCredential(c: string): boolean {
  const padded = c + '='.repeat((4 - (c.length % 4)) % 4);
  if (!BASE64.test(padded)) return false;
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(padded, 'base64'));
    return raw.includes(':') && !NOT_PRINTABLE.test(raw);
  } catch { return false; }
}

function schemeHides(word: string, v: string): boolean {
  if (CRED_START.test(v)) return true;
  if (word.toLowerCase() === 'bearer') return v.length >= 8;
  return isBasicCredential(v) || isBasicCredential(v.split('|')[0]);
}

function line(text: string, mark: string): string {
  let s = text.replace(SCHEME, (_m, word: string, sep: string, v: string) => word + sep + (schemeHides(word, v) ? mark : v));
  s = s.replace(TOKEN, (_m, word: string) => `${word} ${mark}`);
  s = s.replace(HEADER, (_m, key: string) => key + mark);
  s = s.replace(KV, (_m, key: string, v: string) => key + value(v, mark));
  s = s.replace(URL_CRED, (_m, scheme: string) => `${scheme}${mark}@`);
  s = s.replace(URL_PCT, (_m, scheme: string) => scheme + mark);
  for (const shape of SHAPES) s = s.replace(shape, () => mark);
  s = s.replace(LONG_RUN, (m) => (/\d/.test(m) && /[A-Z]/.test(m) ? mark : m));
  return s;
}

/** `text` with every credential the shared rules recognise replaced by `mark`. Key blocks go whole, first; the other
 *  rules run line by line, and cell by cell in a markdown table row, so a value ends at the next `|` there and nowhere else. */
export function redact(text: string, mark = '<redacted>'): string {
  if (!text) return text;
  return text.replace(PEM, () => mark).split('\n')
    .map((ln) => (ln.trimStart().startsWith('|') ? ln.split(/(?<!\\)\|/).map((c) => line(c, mark)).join('|') : line(ln, mark)))
    .join('\n');
}
