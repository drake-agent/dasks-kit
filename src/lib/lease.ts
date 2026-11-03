// The claim lease's "last sign of life": one rule for the lazy 6 h lease in updateTask (src/lib/write.ts) and for
// GET /api/claims/dead, the report a dead claim sweep reads to release claims whose holder is gone.
import { type Task } from './schema.ts';

/** When the holder of a claim was last seen: its claim, its last claim_seen heartbeat, or its own last write in the
 *  activity log (a rename is housekeeping, not a sign of life). Other actors' writes never count. 0 = no claim. */
export function holderSeenAt(t: Pick<Task, 'claimed_by' | 'claimed_at' | 'claim_seen'>, activity: { actor: string; action: string; at: string }[]): number {
  return t.claimed_by ? Math.max(Date.parse(t.claimed_at || '') || 0, Date.parse(t.claim_seen || '') || 0,
    ...activity.filter((a) => a.actor === t.claimed_by && a.action !== 'rename').map((a) => Date.parse(a.at) || 0)) : 0;
}
