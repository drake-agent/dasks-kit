// Review triage: every card in review with a PR, sorted into the buckets a person clears in this order. Read-only.
//   ready    CI green (or no checks) and a clean review recorded for the PR's head; or the PR is already merged
//   fix      CI red, open findings in the review of the head, or the PR was closed without a merge
//   ci       checks still running, or the PR's status is not known yet
//   review   no review recorded for the PR's head
//   stale    none of the above moved for review.stale_days (card, PR and reviews all quiet)
// PR status comes from the board's own cache (src/lib/pr-status.ts); reviews from the review-run records the runner and
// `dask review-record` store. Pure: the caller passes both.
import type { PrStatus } from './pr-status.ts';

export const BUCKETS = ['ready', 'fix', 'ci', 'review', 'stale'] as const;
export type Bucket = typeof BUCKETS[number];

export interface TriageCard { id: string; title: string; goal: string; priority: string; updated: string; pr: string }
export interface TriageReview { head: string; verdict: string; open: number; at?: string; ts?: string }
export interface TriageItem {
  id: string; title: string; goal: string; priority: string; pr: string; bucket: Bucket;
  ci: Extract<PrStatus, { ok: true }>['ci'] | 'unknown'; pr_state: string; head: string;
  review: 'clean' | 'open' | 'none'; open_findings: number; why: string; idle_days: number;
}

const ms = (s: string | undefined) => { const v = Date.parse(s ?? ''); return Number.isFinite(v) ? v : 0; };

export function triageItem(c: TriageCard, st: PrStatus | undefined, reviews: TriageReview[], now: Date, staleDays: number): TriageItem {
  const head = st?.ok ? st.head : '';
  const atHead = head ? reviews.filter((r) => r.head === head) : [];
  const last = atHead[atHead.length - 1];
  const review = !last ? 'none' : last.verdict === 'clean' && !last.open ? 'clean' : 'open';
  const ci = st?.ok ? st.ci : 'unknown';
  const lastMove = Math.max(ms(c.updated), ms(st?.ok ? st.updated_at : ''), ...reviews.map((r) => ms(r.ts ?? r.at)));
  const idle = lastMove ? Math.max(0, (now.getTime() - lastMove) / 86_400_000) : Infinity;
  const pick = (): [Bucket, string] => {
    if (st?.ok && st.state === 'MERGED') return ['ready', 'PR merged: move the card to done'];
    if (st?.ok && st.state === 'CLOSED') return ['fix', 'PR closed without a merge'];
    if (ci === 'red') return ['fix', 'CI failing on the head'];
    if (review === 'open') return ['fix', `${last!.open} open finding(s) in the review of the head`];
    if ((ci === 'green' || ci === 'none') && review === 'clean') return ['ready', ci === 'none' ? 'clean review at the head; the PR has no checks' : 'CI green and a clean review at the head'];
    if (idle >= staleDays) return ['stale', `no activity for ${Math.floor(idle)} day(s)`];
    if (ci === 'pending') return ['ci', 'checks still running'];
    if (ci === 'unknown') return ['ci', st && !st.ok ? `PR status unknown: ${st.error}` : 'PR status not read yet'];
    return ['review', 'no review recorded for the head'];
  };
  const [bucket, why] = pick();
  return { id: c.id, title: c.title, goal: c.goal, priority: c.priority, pr: c.pr, bucket, ci, pr_state: st?.ok ? st.state : '', head,
    review, open_findings: last?.open ?? 0, why, idle_days: Number.isFinite(idle) ? Math.floor(idle) : -1 };
}

const PRIO = (p: string) => { const m = /^p(\d)$/.exec(p); return m ? Number(m[1]) : 9; };

/** Every bucket in clearing order; inside one, priority first, then the card that waited longest. */
export function buildTriage(cards: TriageCard[], status: (pr: string) => PrStatus | undefined, reviews: (id: string) => TriageReview[], now: Date, staleDays: number) {
  const items = cards.filter((c) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(c.pr)).map((c) => ({ c, i: triageItem(c, status(c.pr), reviews(c.id), now, staleDays) }));
  items.sort((a, b) => PRIO(a.c.priority) - PRIO(b.c.priority) || ms(a.c.updated) - ms(b.c.updated) || a.c.id.localeCompare(b.c.id));
  const buckets = Object.fromEntries(BUCKETS.map((k) => [k, items.filter((x) => x.i.bucket === k).map((x) => x.i)])) as Record<Bucket, TriageItem[]>;
  return { now: now.toISOString(), stale_days: staleDays, order: BUCKETS, total: items.length, buckets };
}
