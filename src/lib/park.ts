// Who may park a card on the user (blocked-on-user): a machine writer parks a card on the user only for a real decision.
// Infra failures and board sweeps never leave a card waiting on a person.
//   park    a real ask (the /api/asks shape: options + a recommendation), or a note about something only the user can do
//           or allow (money, keys, deletes, merges, deploys, devices, outward messages): blocked-on-user
//   retry   an infra-shaped note (re-run, missing file or refs, install failed, claim, ssh, network, timeout): not the
//           work's fault, so the run is recorded as failed with cause `infra` and run again
//   rework  anything else: back to todo in the spec-rework lane for the card's owner, who asks the user with /api/asks
//           when it really is the user's call
// The floor check runs first, so a note that names a delete or a merge always reaches the user, whatever else it says.

/** Things only the user can do or allow. A match keeps the card with the user (fail safe toward asking). */
// Not bare "token" or "account": "no token" is a common infra note.
// Any approval (approve, 승인) is the user's: a note asking for one is a decision, not infra, whatever else it says.
const FLOOR = /승인|approv|삭제|지우|delete|결제|billing|비용|요금|유료|구독|subscri|paid|money|price|(?<![가-힣])키(?![가-힣])|\$\d|키체인|keychain|비밀|secret|password|토큰.{0,40}(?:권한|추가|발급|교체|넣)|token (?:scope|permission)|(?:add|new|rotate|grant)\w* .{0,12}token|api ?(?:키|key)|권한|scope|로그인|log ?in|sign ?in|머지|merge|병합|합치|합쳐|배포|deploy|출시|testflight|app store|기기|device|아이폰|iphone|touch ?id|이메일|email|메시지 보내|send (?:a |the )?(?:mail|message|dm)|게시|publish|outward/i;

/** Infra-shaped notes: the job could not run, not a question for anyone. */
const INFRA = /재실행|다시 실행|re-?run|rerun|누락|missing|not found|없어서|찾을 수 없|no such file|refs?\/|refs 없|설치 실패|설치 오류|install(?:ation)? fail|pip install|npm (?:ci|install) fail|claim|클레임|\bssh\b|publickey|unreachable|연결 실패|timed? ?out|타임아웃|disk full|디스크|no space left|fetch failed|network/i;

export type ParkRoute = 'park' | 'retry' | 'rework';

export const floorShaped = (text: string): boolean => FLOOR.test(text);
export const infraShaped = (text: string): boolean => !FLOOR.test(text) && INFRA.test(text);

/** Where a machine's "needs the user" goes. `hasAsk`: the card has a live open ask, or the write carries one. */
export function parkRoute(text: string, hasAsk: boolean): ParkRoute {
  if (hasAsk || floorShaped(text)) return 'park';
  return INFRA.test(text) ? 'retry' : 'rework';
}

/** The note the board adds when it did not park a card on the user. */
export function parkNote(route: Exclude<ParkRoute, 'park'>, text: string): string {
  const why = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  return route === 'retry'
    ? `not parked on the user, run again: this looks like an infra problem (${why})`
    : `not parked on the user, sent back to the card's owner: not a decision with options and a recommendation (/api/asks); if it really is the user's call, the owner asks with /api/asks (${why})`;
}

/** A machine's write that would park a card on the user without a real decision, sent back to the card's owner instead: the
 *  fields and the note to write, or null to let the write park the card. `sweep`: the write says it tidies the board (`sweep: true`
 *  on POST /api/tasks/<id>), so anything that is not a floor matter goes to the owner; any other writer is turned only when the wait
 *  is infra-shaped. The card goes to todo in the spec-rework lane (out of the ready queue) for its owner. */
export function unpark(text: string, o: { actor: string; hasAsk: boolean; sweep: boolean; owner: string }): { fields: Record<string, string>; note: string } | null {
  if (o.actor === 'user' || o.hasAsk) return null;
  const route = parkRoute(text, false);
  if (route === 'park' || !o.sweep && route !== 'retry') return null;
  const note = route === 'retry' ? `not parked on the user, sent back to the card's owner: this looks like an infra problem (${text.replace(/\s+/g, ' ').trim().slice(0, 300)})` : parkNote(route, text);
  return { fields: { status: 'todo', lane: 'spec-rework', next_owner: o.owner, needs_user: '' }, note };
}
