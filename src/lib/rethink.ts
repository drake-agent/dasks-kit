// Rethink at the review limit (docs/runner.md "Rethink at the review limit"). A card whose code review is not clean
// after its 2 passes is blocked with its draft PR; its passes stay used, so it can never be reviewed again. The runner
// then files a rethink card: a new card id (so a fresh review budget) whose body carries `rethink: <old card>`, the open
// findings and the old card's text, and asks to re-check the design and change the approach. A rethink card stopped at
// the limit gets its own rethink, up to `runner.rethinks` in one line of cards; past that the line waits for a human.
// When a rethink card is done, a later look closes the old card's open PR with a comment (the branch is kept), cancels
// the old card as superseded and points its dependents at the rethink card.
import { BoardError, type FlowEnv } from './run-flow.ts';
import { depsOf } from './ready.ts';
import { runBounded, why } from './proc.ts';
import { MAX_ID_LEN, MAX_TITLE_LEN } from './schema.ts';

const LINE = /^rethink:[ \t]*([a-z][a-z0-9]*\.t-[a-z0-9-]+)[ \t]*$/m;
const SUFFIX = /-rethink-(\d+)$/;
const BODY_BYTES = 2800;      // the rethink card's body: task files are kept small (MAX_TASK_BYTES)
const FINDINGS_BYTES = 900;
const oneLine = (s: string, n = 300) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…'; };

/** The old card a card's `rethink: <id>` line names (a line of its own), or null. */
export const rethinkOf = (body: string | null | undefined): string | null => LINE.exec(body ?? '')?.[1] ?? null;

/** How many rethinks are behind a card: N for a rethink card `…-rethink-N` that carries its line, else 0. */
export function rethinkGen(id: string, body: string | null | undefined): number {
  const m = SUFFIX.exec(id);
  return m && rethinkOf(body) ? Number(m[1]) : 0;
}

/** The id of rethink number `gen` in the line of `card`, cut so it fits, then `-rethink-<gen>`. A later rethink (gen > 1)
 *  replaces the previous one's suffix; a first one keeps the whole slug, so a card whose own id ends like a rethink id
 *  still gets a new one. The same card and number always give the same id, so a retried create finds the card it made. */
export function rethinkId(card: string, gen: number): string {
  const [goal, slug] = card.split('.t-');
  const tail = `-rethink-${gen}`;
  let root = (gen > 1 ? slug.replace(SUFFIX, '') : slug).slice(0, MAX_ID_LEN - goal.length - 3 - tail.length).replace(/-+$/, '');
  if (`${goal}.t-${root}${tail}` === card) root = root.slice(0, -1).replace(/-+$/, '');   // a cut look-alike: never its own id
  return `${goal}.t-${root || 'card'}${tail}`;
}

/** The marker on the comment that closes an old PR, so a retry does not comment twice. */
export const closeMarker = (r: string) => `<!-- dasks-runner: superseded-by ${r} -->`;

/** At most `n` UTF-8 bytes of `s`, cut on a character boundary. */
function fitBytes(s: string, n: number): string {
  if (Buffer.byteLength(s) <= n) return s;
  let out = '', size = 0;
  for (const ch of s) { const k = Buffer.byteLength(ch); if (size + k > n - 3) break; out += ch; size += k; }
  return out + '…';
}

/** The new card's fields for POST /api/tasks. `old`: the board's task; `text`: its spec text, else its body. The body
 *  stays under BODY_BYTES (task files are kept small): the findings and the old text are cut to fit, and it says where
 *  the whole old card is. */
export function rethinkCard(old: any, text: string, pr: string, open: string[], gen: number, max: number): Record<string, unknown> {
  const id = rethinkId(old.id, gen);
  const findings = fitBytes((open.length ? open.map((l) => `- ${oneLine(l.replace(/^\s*[-*]\s*/, ''), 400)}`) : ['- (none listed)']).join('\n'), FINDINGS_BYTES);
  const head = [
    `rethink: ${old.id}`, '',
    '## Why this card',
    `${old.id} stopped at the code review limit: 2 review passes, and blocking findings are still open. Its draft PR ${pr || '(none)'} stays open and its branch dasks/${old.id} is kept. This card does the same job with a changed approach and gets its own 2 review passes. It is rethink ${gen} of at most ${max} in this line of cards.`, '',
    '## Open findings', findings, '',
    '## What to do',
    `1. Read the findings above, the old PR${pr ? ` (gh pr view ${pr}, gh pr diff ${pr})` : ''} and the old card (dask card ${old.id}).`,
    '2. Work out why two review passes did not end it: a wrong spec, a wrong design, or a case nobody decided (a security or data-loss case the spec does not cover fails closed). Change the design so these findings cannot come back; do not repeat the same fix.',
    `3. Build it from the default branch. Take code from dasks/${old.id} only where it fits the new design.`,
    `When this card is done, the runner cancels ${old.id} as superseded, closes ${pr || 'its open PR'} with a comment (the branch is kept) and moves the cards waiting on it to this one.`, '',
    `## The old card: ${oneLine(old.title ?? '', 200)} (its start; all of it: dask card ${old.id})`,
  ].join('\n');
  const body = `${head}\n${fitBytes(text.trim() || '(empty)', Math.max(0, BODY_BYTES - Buffer.byteLength(head) - 1))}`;
  const title = oneLine(`Rethink: ${old.title ?? old.id}`, MAX_TITLE_LEN);
  const copy = Object.fromEntries(['lane', 'priority', 'kind', 'milestone', 'depends_on', 'secrets'].filter((k) => typeof old[k] === 'string' && old[k]).map((k) => [k, old[k]]));
  return { id, goal: old.goal, title, ...copy, body, force: true };
}

export interface Filed { id: string; why: string; fresh: boolean }

/** File the rethink of a card blocked at the review limit. `{id}` when the card exists (made now or by an earlier try),
 *  else `{why}` not. Throws only when the board did not answer (5xx, network), so the caller tries again. */
export async function fileRethink(env: Pick<FlowEnv, 'api'>, card: string, pr: string, open: string[], max: number): Promise<Filed> {
  if (max <= 0) return { id: '', why: 'rethinks are off (runner.rethinks is 0)', fresh: false };
  const old = await env.api('GET', `/api/tasks/${card}?log=0`);
  const gen = rethinkGen(card, old?.body) + 1;
  if (gen > max) return { id: '', why: `this line of cards already had ${max} rethink(s)`, fresh: false };
  let text = '';
  try { text = (await env.api('GET', `/api/tasks/${card}/spec`))?.text ?? ''; } catch (e: any) { if (!(e instanceof BoardError) || e.status >= 500) throw e; }
  const body = String(old?.body ?? '').replace(/(^|\n)## Notes[ \t]*(\n[\s\S]*?)?(?=\n## |$)/, '$1');   // its notes are the old run's log
  const fields = rethinkCard(old, text || body, pr, open, gen, max);
  const id = String(fields.id);
  try {
    const made = await env.api('POST', '/api/tasks', fields);
    if (made?.intake) return { id: '', why: `the goal is over its todo limit, so the rethink became idea ${made.idea?.id ?? ''}`.trim(), fresh: false };
    return { id: made?.id ?? id, why: '', fresh: true };
  } catch (e: any) {
    if (!(e instanceof BoardError) || e.status >= 500) throw e;
    if (e.status === 409) {
      const there = await env.api('GET', `/api/tasks/${id}?log=0`).catch(() => null);
      if (rethinkOf(there?.body) === card) return { id, why: '', fresh: false };
    }
    return { id: '', why: `the board refused the rethink card: ${oneLine(e.message, 200)}`, fresh: false };
  }
}

// ---------- closing the old card once its rethink is done ----------

export interface PrView { state: string; comments: string[] }
/** GitHub calls of the close step; null from view = could not be read. close never deletes the branch. */
export interface PrIo { view(pr: string): Promise<PrView | null>; comment(pr: string, body: string): Promise<boolean>; close(pr: string): Promise<boolean> }

const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

/** The `gh` CLI as PrIo, bounded so a slow gh never holds up a heartbeat. */
export function ghIo(gh: string | null): PrIo {
  const run = (args: string[]) => gh ? runBounded(gh, args, { timeoutMs: 60_000 }) : Promise.resolve({ code: -1, out: '', err: 'gh is not installed', timedOut: false });
  return {
    async view(pr) {
      const r = await run(['pr', 'view', pr, '--json', 'state,comments']);
      if (r.code !== 0) return null;
      try { const j = JSON.parse(r.out); return { state: String(j.state ?? ''), comments: (j.comments ?? []).map((c: any) => String(c?.body ?? '')) }; } catch { return null; }
    },
    async comment(pr, body) { return (await run(['pr', 'comment', pr, '--body', body])).code === 0; },
    async close(pr) { const r = await run(['pr', 'close', pr]); return r.code === 0 || /already closed/i.test(why(r)); },
  };
}

/** One look's close pass. For each done rethink card it walks up its line of cards (`rethink:` lines) and finishes every
 *  card above it still waiting at the review limit: cancel it as superseded (version-checked, so a card someone took
 *  meanwhile is left alone), then comment on and close its open PR, then move its dependents. `finished`: rethink cards
 *  whose line needs nothing more, skipped from then on. Returns a line per card that did something or was held. */
export async function closeSuperseded(env: Pick<FlowEnv, 'api'>, io: PrIo, finished = new Set<string>()): Promise<string[]> {
  const done: any[] = await env.api('GET', '/api/tasks?status=done&fields=id,body,pr');
  const carriers = done.filter((r) => SUFFIX.test(r.id) && rethinkOf(r.body) && !finished.has(r.id));
  if (!carriers.length) return [];
  const all: any[] = await env.api('GET', '/api/tasks?status=all&fields=id,status,pr,depends_on,version,spec_state,claimed_by,result,body');
  const byId = new Map(all.map((t) => [t.id, t]));
  const lines: string[] = [];
  for (const r of carriers) {
    const seen = new Set([r.id]);
    let complete = true;
    for (let cur = rethinkOf(r.body); cur && !seen.has(cur); cur = rethinkOf(byId.get(cur)?.body)) {
      seen.add(cur);
      const b = byId.get(cur);
      if (!b || b.status === 'done') break;
      const step = await supersede(env, io, b, r, all, (s) => lines.push(`${b.id}: ${s}`));
      if (step === 'retry') complete = false;
      if (step !== 'ok') break;
    }
    if (complete) finished.add(r.id);
  }
  return lines;
}

/** Finish one old card `b` for the done rethink card `r`. ok: done, walk on; held: for good (cancelled for another
 *  reason, PR merged), leave it and the cards above it; retry: not now (a step failed, or the card is held or was
 *  unblocked), the next look looks again. */
async function supersede(env: Pick<FlowEnv, 'api'>, io: PrIo, b: any, r: any, all: any[], say: (s: string) => void): Promise<'ok' | 'held' | 'retry'> {
  const pr = String(b.pr ?? '').trim();
  try {
    if (b.status === 'cancelled') {
      if (!String(b.result ?? '').startsWith(`superseded by ${r.id}`)) return 'held';   // cancelled for another reason
    } else {
      if (b.spec_state !== 'blocked' || b.claimed_by || b.status === 'doing') { say(`left alone for done rethink ${r.id}: no longer blocked at the review limit, or someone holds it`); return 'retry'; }
      if (pr && !PR_URL.test(pr)) { say(`left alone for done rethink ${r.id}: its pr field is not a GitHub PR (${oneLine(pr, 100)})`); return 'retry'; }
      if (pr) {
        const v = await io.view(pr);
        if (!v) { say(`not finished yet: ${pr} could not be read`); return 'retry'; }
        if (v.state === 'MERGED') { say(`left alone for done rethink ${r.id}: ${pr} was merged`); return 'held'; }
      }
      await env.api('POST', `/api/tasks/${b.id}`, {
        status: 'cancelled', result: `superseded by ${r.id}`, expected_version: Number(b.version ?? 0),
        note: `runner: rethink card ${r.id} is done, so this card is cancelled as superseded.${pr ? ` Its PR ${pr} is closed with a comment; the branch is kept.` : ''} Cards waiting on it now wait on ${r.id}.`,
      });
      say(`cancelled as superseded by ${r.id}`);
    }
    if (pr && PR_URL.test(pr)) {
      const v = await io.view(pr);
      if (!v) { say(`${pr} not closed yet: it could not be read`); return 'retry'; }
      if (v.state === 'OPEN') {
        if (!v.comments.some((c) => c.includes(closeMarker(r.id)))
          && !await io.comment(pr, `Superseded by ${r.id}${r.pr ? ` (${r.pr})` : ''}, a rethink card that is done. The Dasks runner closes this PR; the branch is kept.\n\n${closeMarker(r.id)}`)) { say(`${pr} not closed yet: the comment failed`); return 'retry'; }
        if (!await io.close(pr) || (await io.view(pr))?.state !== 'CLOSED') { say(`${pr} not closed yet: the close failed`); return 'retry'; }
        say(`${pr} closed, branch kept`);
      }
    }
    return await relink(env, b.id, r.id, all, say) ? 'ok' : 'retry';
  } catch (e: any) { say(`not finished yet: ${oneLine(e.message, 200)}`); return 'retry'; }
}

/** Open cards that wait on `b` wait on `r` instead (a cancelled dependency blocks on purpose: src/lib/ready.ts). False
 *  when one of them could not be moved. */
async function relink(env: Pick<FlowEnv, 'api'>, b: string, r: string, all: any[], say: (s: string) => void): Promise<boolean> {
  let ok = true;
  for (const t of all) {
    if (t.status === 'done' || t.status === 'cancelled' || !depsOf(t).includes(b)) continue;
    const deps = [...new Set(depsOf(t).map((d) => (d === b ? r : d)))].join(', ');
    try {
      const res = await env.api('POST', `/api/tasks/${t.id}`, { depends_on: deps, expected_version: Number(t.version ?? 0), note: `runner: ${b} was superseded by its rethink card ${r}; this card now waits on ${r}.` });
      Object.assign(t, { depends_on: deps, version: res?.version ?? t.version });   // a card above may need it again
      say(`${t.id} now waits on ${r}`);
    } catch (e: any) { ok = false; say(`${t.id} still waits on it (${oneLine(e.message, 150)}); next look tries again`); }
  }
  return ok;
}
