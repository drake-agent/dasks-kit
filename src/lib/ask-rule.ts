// The wording rule for a needs_user ask: it sits above the user's Approve/Reject buttons, so it must be one yes/no
// question that Approve answers, say what approving does, never say "nothing to do", carry no card ids or job slugs, and
// fit the board's 300 characters. English is the default wording; the Korean phrases are accepted too. JS's \b, \w and
// \d are ASCII only: the word edges and digits below are spelled out with Unicode classes so they hold next to any script.
// test/fixtures/ask-rule.json holds the cases.

export const ASK_MAX = 300;
export const ASK_REASONS = ['not-a-question', 'no-effect', 'no-op', 'raw-id', 'too-long'] as const;
export type AskReason = (typeof ASK_REASONS)[number];

const W = '[\\p{L}\\p{N}_]';
const EFFECT = /if approved|if you approve|approving (?:it|this|will)|approve to|on approval|승인하면|OK하면/iu;
const NO_OP = /nothing (?:left )?to do|no action (?:is )?needed|할 일 없|할 게 없|할 것 없|다시 보고 싶을 때/iu;
const RAW_ID = new RegExp(`(?<!${W})[a-z]+\\.t-[a-z0-9-]+|-\\p{Nd}{12}(?!${W})|(?<!${W})(?:review|bughunt|auto)-[a-z0-9-]+-(?:pr)?\\p{Nd}+`, 'u');

/** Reason codes the ask fails, in ASK_REASONS order; [] = ok. Length is in code points. */
export function checkAsk(text: string): AskReason[] {
  const s = typeof text === 'string' ? text : '';
  const out: AskReason[] = [];
  if (!s.includes('?') && !s.includes('？')) out.push('not-a-question');
  if (!EFFECT.test(s)) out.push('no-effect');
  if (NO_OP.test(s)) out.push('no-op');
  if (RAW_ID.test(s)) out.push('raw-id');
  if ([...s].length > ASK_MAX) out.push('too-long');
  return out;
}
