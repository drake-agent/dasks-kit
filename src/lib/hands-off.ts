// Hands-off mode (config.json `hands_off.enabled`, docs/captain.md "Hands-off mode"): the board stops asking the person
// about build-stage things. Off by default; off = the board behaves as without this file.
//   merge OK      GET /api/merge-ok answers 410; `dask captain-merge` lands a clean card on green CI and a clean
//                 cross-model review at its head (as with captain.auto_merge) and never asks for a merge OK
//   build stops   a machine's write that would put a doing or review card on the person (blocked-on-user, a new
//                 needs_user, an ask, a needs-user outcome or a retry cap) is kept as a card note instead: a review card
//                 stays in review for the captain, any other card goes back to its spec stage (todo, lane spec-rework)
//   person-only   money, deleting data, a secret, a physical device or a taste / UI pick still reaches the person
// The switch is read from config.json on each request, so `dasks hands-off on|off` needs no server restart.
import fs from 'node:fs';
import { configFile } from './config.ts';
import type { Task } from './schema.ts';

let cache: { key: string; on: boolean } | null = null;
/** Is hands-off mode on? Read from config.json when the file changed (mtime and size); an unreadable or broken file keeps
 *  the last value read (false before any), since the startup check already refused a bad one. */
export function handsOffOn(root: string): boolean {
  const file = configFile(root);
  let key = `${file}|none`;
  try { const s = fs.statSync(file); key = `${file}|${s.mtimeMs}|${s.size}`; } catch { /* no config.json: the default */ }
  if (cache?.key === key) return cache.on;
  let on = cache?.on ?? false;
  try { on = JSON.parse(fs.readFileSync(file, 'utf8'))?.hands_off?.enabled === true; }
  catch (e: any) { if (e.code === 'ENOENT') on = false; }
  cache = { key, on };
  return on;
}

/** Things only a person can do or decide: money, deleting data, a secret or credential, a physical device, a taste or UI
 *  pick. Matching fails toward asking: a word here keeps the ask with the person. */
const PERSON_ONLY = new RegExp([
  '결제|billing|비용|요금|유료|구독|subscri|\\bpaid\\b|\\bpay(?:ment|ing)?\\b|money|price|\\$\\d',
  '삭제|지우|\\bdelet|\\bwipe|\\berase|\\bpurge',
  '비밀|secret|password|passphrase|passcode|credential|\\btokens?\\b|토큰|\\brotat|키체인|keychain|(?:api|ssh|signing|access|private|deploy) ?(?:키|key)|(?<![가-힣])키(?![가-힣])|certificate|인증서|\\blog ?in\\b|\\blogin|sign ?in|로그인|\\b2fa\\b|\\botp\\b',
  '기기|device|아이폰|iphone|ipad|touch ?id|physical',
  '취향|디자인|taste|look and feel|usability|\\bui\\b|colou?r|layout',
].join('|'), 'i');
export const personOnly = (text: string): boolean => PERSON_ONLY.test(text);

/** Build stage: the card is being built or its PR waits in review. A spec-stage card's asks still reach the person. */
export const buildStage = (t: Pick<Task, 'status'>): boolean => t.status === 'doing' || t.status === 'review';

/** The note a rerouted build-stage ask leaves on the card. */
export function handsOffNote(t: Pick<Task, 'status'>, text: string): string {
  if (!text.trim()) text = 'no reason given';
  const where = t.status === 'review' ? 'it stays in review for the captain' : "it goes back to the card's spec stage";
  return `hands-off: not asked of the person, ${where} (${text.replace(/\s+/g, ' ').trim().slice(0, 300)})`;
}

/** Where a rerouted build-stage card goes: a review card stays in review (no field changes but the cleared question), any
 *  other card goes back to its spec stage for its owner. */
export function handsOffMove(cur: Pick<Task, 'status'>, owner: string): Record<string, string> {
  return cur.status === 'review' ? { needs_user: '' } : { status: 'todo', lane: 'spec-rework', next_owner: owner, needs_user: '' };
}

/** A machine's task write in hands-off mode: when it would put a build-stage card on the person for something not
 *  person-only, the field changes that keep it off the person's list (undefined = drop that field from the write) and the
 *  note to add. null = let the write through as sent. `text`: everything else the write says (note, result, context
 *  block); a person-only word anywhere in it keeps the ask with the person. */
export function handsOffWrite(cur: Task, fields: Record<string, unknown>, text: string, o: { actor: string; hasAsk: boolean; owner: string }): { fields: Record<string, string | undefined>; note: string } | null {
  if (o.actor === 'user' || o.hasAsk || !buildStage(cur)) return null;
  const standing = (cur.needs_user ?? '').trim();
  const asked = typeof fields.needs_user === 'string' ? fields.needs_user.trim() : '';
  const fresh = !!asked && asked !== standing;
  const parks = fields.status === 'blocked-on-user';
  if (!fresh && !parks) return null;
  const said = [asked, text, standing].map((x) => x.trim()).filter(Boolean).join(' ');
  if (personOnly(said)) return null;
  const out: Record<string, string | undefined> = handsOffMove(cur, o.owner);
  if (parks && cur.status === 'review') out.status = undefined;
  return { fields: out, note: handsOffNote(cur, said) };
}
