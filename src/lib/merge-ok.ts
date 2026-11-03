// A merge OK is the card's own signed decision whose needs line starts with `head <sha40>`: the human
// approved merging exactly that head on the board. The optional merge gate hook reads it through GET /api/merge-ok.
export const SHA40_RE = /^[0-9a-f]{40}$/;
export const HEAD_TOKEN = /(?<![0-9A-Za-z])head [0-9a-f]{40}(?![0-9A-Za-z])/g;
/** needs_user as the signed scope holds it (decisionRequest folds every run of whitespace into one space), so a tab or
 *  newline between `head` and the sha reads the same here as in the ledger. */
const signedNeeds = (needs: unknown) => String(needs ?? '').replace(/\s+/g, ' ').trim();
const headsIn = (needs: unknown) => signedNeeds(needs).match(HEAD_TOKEN) ?? [];
/** Does this needs line ask to merge at any head? */
export const asksAnyMerge = (needs: unknown) => headsIn(needs).length > 0;
/** Does this needs line ask to merge at exactly this head: one head token, at its very start? */
export function asksMergeAt(needs: unknown, sha: string): boolean {
  const n = signedNeeds(needs); const heads = headsIn(n);
  return heads.length === 1 && n.startsWith(heads[0]) && heads[0] === `head ${sha}`;
}
/** The rule the merge gate reads: among the user's entries for this card whose signed needs line asks to merge at this
 *  exact head, the highest seq; it counts only when its choice is approve. `entries` come from a verified ledger. */
export function mergeOkAt<E extends { seq: number; card: string; who: string; choice: string; scope: string }>(entries: E[], card: string, sha: string): E | null {
  let last: E | null = null;
  for (const e of entries) {
    if (e.card !== card || e.who !== 'user') continue;
    const needs = /^needs: (.*)$/m.exec(String(e.scope ?? ''))?.[1];
    if (asksMergeAt(needs, sha) && (!last || e.seq > last.seq)) last = e;
  }
  return last?.choice === 'approve' ? last : null;
}
