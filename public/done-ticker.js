// Done ticker: which finished cards the one line at the top of the board lists. Pure: no DOM, no fetch, no clock, no
// storage; app.js passes now and this browser's mark and draws what this returns. test/done-ticker.test.ts imports it.
// Only people read the line: no MCP tool, CLI command or server route carries it.
//   cards with status done whose done time is after max(mark, now - 7 days); no mark yet = the last 24 hours
//   done time = done_at from /api/board (the move to done), else `updated`

export const TOP = 3; // lines before "+N more"
/** First visit (no mark in this browser): the last 24 hours. */
export const FIRST_MS = 24 * 3600_000;
/** However old the mark, nothing older than 7 days (the board sends done_at for that window only). */
export const WINDOW_MS = 7 * 24 * 3600_000;

/** When the card reached done (ms): `done_at` when it is a time, else `updated`. */
export function doneTime(x) {
  const d = Date.parse(x && x.done_at);
  return Number.isFinite(d) ? d : Date.parse(x && x.updated);
}

/** "#12" from a pull request URL, "#12" or "12"; '' for anything else. */
export function prRef(pr) {
  const s = typeof pr === 'string' ? pr.trim() : '';
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(s) || /^#?(\d+)$/.exec(s);
  return m ? `#${m[1]}` : '';
}

/** Lower bound (exclusive) of the window: the mark, but never more than 7 days back; no mark = 24 hours back. */
export function sinceOf(now, mark) {
  return Number.isFinite(mark) && mark > 0 ? Math.max(mark, now - WINDOW_MS) : now - FIRST_MS;
}

/** Done cards after the window start, newest first (same time: by id), as {x, at}. One line per card: an id that comes
 *  twice keeps only its newest done time. */
export function tickerItems(tasks, now, mark) {
  const since = sinceOf(now, mark);
  const byId = new Map();
  for (const x of Array.isArray(tasks) ? tasks : []) {
    if (!x || x.status !== 'done') continue;
    const at = doneTime(x);
    if (!Number.isFinite(at) || at <= since) continue;
    const prev = byId.get(x.id);
    if (!prev || at > prev.at) byId.set(x.id, { x, at });
  }
  return [...byId.values()].sort((a, b) => b.at - a.at || String(a.x.id).localeCompare(String(b.x.id)));
}

/** The lines to draw: the first TOP unless expanded, and how many wait behind "+N more". */
export function tickerShown(items, expanded) {
  const list = Array.isArray(items) ? items : [];
  if (expanded || list.length <= TOP) return { shown: list, more: 0 };
  return { shown: list.slice(0, TOP), more: list.length - TOP };
}

/** The mark after "Got it": the newest done time on the line; it never moves back. */
export function markAfter(items, mark) {
  const prev = Number.isFinite(mark) ? mark : 0;
  return Math.max(prev, ...(Array.isArray(items) ? items : []).map((i) => i.at));
}

if (typeof window !== 'undefined') {
  window.DoneTicker = { TOP, FIRST_MS, WINDOW_MS, doneTime, prRef, sinceOf, tickerItems, tickerShown, markAfter };
}
