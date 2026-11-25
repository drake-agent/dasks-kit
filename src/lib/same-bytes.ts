import { timingSafeEqual } from 'node:crypto';

/** Constant-time compare that never throws: `timingSafeEqual` throws when the lengths differ (a client-sent value of
 *  another length would be a 500). Every secret compare goes through here; this is the one `timingSafeEqual` call. */
export function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
