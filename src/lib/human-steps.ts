// Steps only the human can do. An unattended run skips such a step and says so in one line form, the same text in the
// agent's last message and in the card note the runner writes from it; the daily summary lists those notes:
//   HUMAN-STEP: <what is left undone> -- <why only the human can do it>
import { redact } from './redact.ts';

export const HUMAN_STEP_MARK = 'HUMAN-STEP:';
const STEP_MAX = 80, WHY_MAX = 100;
/** Steps taken from one run: a run that lists more is not a list anyone reads. */
const RUN_MAX = 10;

export interface HumanStep { step: string; why: string }

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…'; };

/** The step of one line or note, or null when it is not in the form. The first ` -- ` (or ` — `) splits step and why;
 *  the why may be missing. Secrets are redacted and both parts capped, so the note fits the card's 200-character log. */
export function parseHumanStep(line: unknown): HumanStep | null {
  const s = String(line ?? '').trim();
  if (!s.startsWith(HUMAN_STEP_MARK)) return null;
  const rest = redact(s.slice(HUMAN_STEP_MARK.length));
  const cut = /\s(?:--|—)\s/.exec(rest);
  const step = clip(cut ? rest.slice(0, cut.index) : rest, STEP_MAX);
  return step ? { step, why: clip(cut ? rest.slice(cut.index + cut[0].length) : '', WHY_MAX) } : null;
}

export const humanStepLine = (s: HumanStep) => `${HUMAN_STEP_MARK} ${s.step}${s.why ? ` -- ${s.why}` : ''}`;

/** One entry per step, in first-seen order, at most RUN_MAX. */
export function mergeHumanSteps(steps: HumanStep[]): HumanStep[] {
  return [...new Map(steps.map((s) => [s.step, s])).values()].slice(0, RUN_MAX);
}

/** The steps a run reported: the form's lines directly above its last RESULT line, so a line the agent only quoted, or
 *  the prompt echoed in a log, does not count. */
export function humanStepsOf(text: string): HumanStep[] {
  const lines = text.split('\n').map((l) => l.trim());
  const out: HumanStep[] = [];
  for (let i = lines.findLastIndex((l) => l.startsWith('RESULT:')) - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    const s = parseHumanStep(lines[i]);
    if (!s) break;
    out.unshift(s);
  }
  return mergeHumanSteps(out);
}

/** In every prompt of a run that can change the card's code. */
export const HUMAN_STEP_RULE = [
  'Steps only the human can do: a login, signing, a paid purchase, a physical device, an approval or a Touch ID prompt.',
  `Nobody is here to do one, so when the work needs one, do not try it, wait for it, fake it or get around it (no made-up credentials, no stub passed off as the real thing, no check turned off). Leave that one step undone and finish the rest of the card. For each such step write one line directly above your RESULT line, in exactly this form: \`${HUMAN_STEP_MARK} <what is left undone> -- <why only the human can do it>\`. Use the card's language, keep it on one line and put no secret in it.`,
  'Never report a skipped step as done, passed or waived, in the code, the docs, a test result or the RESULT line.',
  'If a check the card requires cannot run without the skipped step, or nothing useful is left without it, the card is not built: end with `RESULT: stopped needs the human: <the step>`.',
].join(' ');
