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
const OLD_TEXT_MAX = 6000;
const oneLine = (s: string, n = 300) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…'; };

/** The old card a card's `rethink: <id>` line names (a line of its own), or null. */
export const rethinkOf = (body: string | null | undefined): string | null => LINE.exec(body ?? '')?.[1] ?? null;

/** How many rethinks are behind a card: N for a rethink card `…-rethink-N` that carries its line, else 0. */
export function rethinkGen(id: string, body: string | null | undefined): number {
  const m = SUFFIX.exec(id);
  return m && rethinkOf(body) ? Number(m[1]) : 0;
}

/** The id of rethink number `gen` in the line of `card`: the line's first slug, cut so the id fits, then `-rethink-<gen>`.
 *  The same card and number always give the same id, so a retried create finds the card it made. */
export function rethinkId(card: string, gen: number): string {
  const [goal, slug] = card.split('.t-');
  const tail = `-rethink-${gen}`;
  const root = slug.replace(SUFFIX, '').slice(0, MAX_ID_LEN - goal.length - 3 - tail.length).replace(/-+$/, '');
  return `${goal}.t-${root || 'card'}${tail}`;
}

/** The marker on the comment that closes an old PR, so a retry does not comment twice. */
export const closeMarker = (r: string) => `<!-- dasks-runner: superseded-by ${r} -->`;

/** The new card's fields for POST /api/tasks. `old`: the board's task; `text`: its spec text, else its body. */
export function rethinkCard(old: any, text: string, pr: string, open: string[], gen: number, max: number): Record<string, unknown> {
  const id = rethinkId(old.id, gen);
  const oldText = text.length > OLD_TEXT_MAX ? text.slice(0, OLD_TEXT_MAX) + '\n…(cut; read the whole card on the board)' : text;
  const body = [
    `rethink: ${old.id}`, '',
    '## Why this card',
    `${old.id} stopped at the code review limit: 2 review passes, and blocking findings are still open. Its draft PR ${pr || '(none)'} stays open and its branch dasks/${old.id} is kept. This card does the same job with a changed approach and gets its own 2 review passes. It is rethink ${gen} of at most ${max} in this line of cards.`, '',
    '## Open findings',
    ...(open.length ? open.map((l) => `- ${l.replace(/^\s*[-*]\s*/, '')}`) : ['- (none listed)']), '',
    '## What to do',
    `1. Read the findings above, the old PR${pr ? ` (gh pr view ${pr}, gh pr diff ${pr})` : ''} and the old card below.`,
    '2. Work out why two review passes did not end it: a wrong spec, a wrong design, or a case nobody decided (a security or data-loss case the spec does not cover fails closed). Change the design so these findings cannot come back; do not repeat the same fix.',
    `3. Build it from the default branch. Take code from dasks/${old.id} only where it fits the new design.`,
    `When this card is done, the runner closes ${pr || 'the old PR'} with a comment (the branch is kept), cancels ${old.id} as superseded and moves the cards waiting on it to this one.`, '',
    `## The old card: ${old.title ?? ''}`,
    oldText.trim() || '(empty)',
  ].join('\n');
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

/** One look's close pass: every done rethink card whose old card is still open (or cancelled by this pass with
 *  dependents left). Returns a line per card that did something or was held; nothing is written when a step fails. */
export async function closeSuperseded(env: Pick<FlowEnv, 'api'>, io: PrIo): Promise<string[]> {
  const done: any[] = await env.api('GET', '/api/tasks?status=done&fields=id,body,pr');
  const carriers = done.filter((r) => SUFFIX.test(r.id) && rethinkOf(r.body));
  if (!carriers.length) return [];
  const all: any[] = await env.api('GET', '/api/tasks?status=all&fields=id,status,pr,depends_on,version,spec_state,claimed_by,result');
  const byId = new Map(all.map((t) => [t.id, t]));
  const lines: string[] = [];
  for (const r of carriers) {
    const b = byId.get(rethinkOf(r.body)!);
    if (!b || b.status === 'done') continue;
    const say = (s: string) => lines.push(`${b.id}: ${s}`);
    try {
      if (b.status === 'cancelled') {
        if (String(b.result ?? '').startsWith(`superseded by ${r.id}`)) await relink(env, b.id, r.id, all, say);
        continue;
      }
      if (b.spec_state !== 'blocked' || b.claimed_by || b.status === 'doing') { say(`not closed for done rethink ${r.id}: the old card is no longer blocked at the review limit or someone holds it`); continue; }
      const pr = String(b.pr ?? '').trim();
      if (pr && !PR_URL.test(pr)) { say(`not closed for done rethink ${r.id}: its pr field is not a GitHub PR (${oneLine(pr, 100)})`); continue; }
      if (pr) {
        const v = await io.view(pr);
        if (!v) { say(`not closed yet: ${pr} could not be read`); continue; }
        if (v.state === 'MERGED') { say(`not closed for done rethink ${r.id}: ${pr} was merged`); continue; }
        if (v.state === 'OPEN') {
          if (!v.comments.some((c) => c.includes(closeMarker(r.id)))
            && !await io.comment(pr, `Superseded by ${r.id}${r.pr ? ` (${r.pr})` : ''}, its rethink card, which is done. The Dasks runner closes this PR; the branch is kept.\n\n${closeMarker(r.id)}`)) { say(`not closed yet: could not comment on ${pr}`); continue; }
          if (!await io.close(pr) || (await io.view(pr))?.state !== 'CLOSED') { say(`not closed yet: ${pr} did not close`); continue; }
        }
      }
      await env.api('POST', `/api/tasks/${b.id}`, {
        status: 'cancelled', result: `superseded by ${r.id}${pr ? ` (closed ${pr})` : ''}`, expected_version: Number(b.version ?? 0),
        note: `runner: rethink card ${r.id} is done, so this card is cancelled as superseded.${pr ? ` ${pr} was closed with a comment; its branch is kept.` : ''} Cards waiting on it now wait on ${r.id}.`,
      });
      say(`cancelled as superseded by ${r.id}${pr ? `, ${pr} closed` : ''}`);
      await relink(env, b.id, r.id, all, say);
    } catch (e: any) { say(`not closed yet: ${oneLine(e.message, 200)}`); }
  }
  return lines;
}

/** Open cards that wait on `b` wait on `r` instead (a cancelled dependency blocks on purpose: src/lib/ready.ts). */
async function relink(env: Pick<FlowEnv, 'api'>, b: string, r: string, all: any[], say: (s: string) => void): Promise<void> {
  for (const t of all) {
    if (t.status === 'done' || t.status === 'cancelled' || !depsOf(t).includes(b)) continue;
    const deps = [...new Set(depsOf(t).map((d) => (d === b ? r : d)))].join(', ');
    try {
      await env.api('POST', `/api/tasks/${t.id}`, { depends_on: deps, expected_version: Number(t.version ?? 0), note: `runner: ${b} was superseded by its rethink card ${r}; this card now waits on ${r}.` });
      say(`${t.id} now waits on ${r}`);
    } catch (e: any) { say(`${t.id} still waits on it (${oneLine(e.message, 150)}); next look tries again`); }
  }
}
