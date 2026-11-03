// The spec finish line (docs/specs.md "Finish line"). A spec says where its card ends:
//   done_when: <the user-visible end state, one checkable line, at most 200 characters>
//   done_at: pr | live      pr = done when the PR merges; live = done only after someone checks the end state after it
// A card's first spec, and any spec whose previous version had either line, must carry both (422 otherwise); an older
// spec without them is written as before, with a warning. A `live` card never moves to done without a check line:
//   checked: <what was checked, where> @ <the commit checked, 7-40 hex>
// A write that would close it without one parks it in review on the lane live-check instead (src/lib/write.ts).
import { checkCard } from './contract.ts';

export const DONE_AT = ['pr', 'live'] as const;
export type DoneAt = typeof DONE_AT[number];
export const DONE_WHEN_MAX = 200;
export const LIVE_CHECK_LANE = 'live-check';

export interface DoneLine { done_at: string; done_when: string }

/** The two header lines of a spec text ('' when absent). */
export function doneLine(text: string): DoneLine {
  const f = checkCard(text).fields;
  return { done_at: (f.done_at ?? '').trim(), done_when: (f.done_when ?? '').trim() };
}
const hasAny = (d: DoneLine) => !!(d.done_at || d.done_when);

/** Problems with a spec's finish line: errors refuse the write, warnings do not. prevText = the version it replaces
 *  (undefined for a card's first spec). */
export function doneLineCheck(text: string, prevText: string | undefined): { errors: string[]; warnings: string[] } {
  const d = doneLine(text);
  const required = prevText === undefined || hasAny(doneLine(prevText));
  const problems: string[] = [];
  if (!d.done_when || d.done_when.startsWith('<')) problems.push('done_when: missing (one line: what the user sees when the card is done, checkable)');
  else if (d.done_when.length > DONE_WHEN_MAX) problems.push(`done_when: over ${DONE_WHEN_MAX} characters`);
  if (!(DONE_AT as readonly string[]).includes(d.done_at)) problems.push(`done_at: must be ${DONE_AT.join(' or ')} (pr = done when the PR merges, live = done after a check after the merge)`);
  if (!problems.length) return { errors: [], warnings: [] };
  return required ? { errors: problems, warnings: [] } : { errors: [], warnings: problems.map((p) => `older spec without a finish line: ${p}`) };
}

const CHECK_RE = /^\s*checked:\s*(\S.*?)\s+@\s*([0-9a-f]{7,40})\s*$/im;
/** The check line of a result or note: what was checked and the commit, or null. */
export function checkLine(text: string): { what: string; commit: string } | null {
  const m = CHECK_RE.exec(text ?? '');
  return m ? { what: m[1], commit: m[2] } : null;
}
export const formatCheckLine = (evidence: string, commit: string) => `checked: ${evidence.replace(/\s+/g, ' ').trim()} @ ${commit}`;
