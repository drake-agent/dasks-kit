// Card header fields as agents and the spec state read them: the first `key:` line at a line start, up to a `#` comment.
import { parseTouches, touchesValue } from './touches.ts';
import { TASK_ID_RE } from './schema.ts';

export const field = (text: string, key: string) => (text.match(new RegExp(`^${key}[ \\t]*:[ \\t]*([^\\n#]*)`, 'm'))?.[1] ?? '').trim();
const list = (v: string) => v.split(/[,\s]+/).map((x) => x.trim()).filter((x) => x && !/^(none|-|\[\])$/i.test(x));

/** A card's `depends_on:` ids (comments after the value are ignored). */
export const cardDeps = (text: string) => list(field(text, 'depends_on')).filter((d) => TASK_ID_RE.test(d));

/** A card's `touches:` paths without the repo prefix a spec may write (`app:public/**` → `public/**`), prose dropped
 *  (docs/cards.md "touches"). None = overlaps nothing, not the whole repo; `.` or `**` hold the whole repo. */
export const cardTouches = (text: string) => parseTouches(touchesValue(text));

/** `small` or `big` from a card's `size:` line; anything else is unknown. */
export function cardSize(text: string): 'small' | 'big' | undefined {
  const v = field(text, 'size').toLowerCase().split(/\s/)[0];
  return v === 'small' || v === 'big' ? v : undefined;
}

/** `owner/name` from a card's `repo:` line (comments after the value are ignored). */
export function cardRepo(cardText: string): string {
  const m = cardText.match(/^repo:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/m);
  return m ? m[1].replace(/\.git$/, '') : '';
}
