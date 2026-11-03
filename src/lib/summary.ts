// The daily summary: once a day at summary.at (HH:MM, this Mac's time zone) the board writes what happened since the
// last one and what waits on the human. It stays in run/summary.json (live state, never committed), is shown at the top
// of the board until dismissed, and is read with GET /api/summary, MCP get_summary and `dasks summary`. It is never
// sent anywhere. The content is a pure function of the board's state; the server only gathers the inputs.
import fs from 'node:fs';
import path from 'node:path';
import { localDate } from './rollup.ts';

export interface SummaryCard { id: string; title: string; goal: string; pr?: string }
export interface Summary {
  /** When it was written, and the window it covers: [since, until). */
  at: string;
  day: string;
  since: string;
  until: string;
  finished: SummaryCard[];
  waiting: { asks: SummaryCard[]; approve: SummaryCard[]; blocked: SummaryCard[] };
  stuck: { machines: { machine: string; last_seen: string }[]; cards: (SummaryCard & { hours: number })[] };
  failures: { id: string; at: string; note: string; cause?: string }[];
  /** Board-level problems (a failing backup) at the time of writing. */
  warnings: string[];
  /** The same content as plain lines, for a terminal or an agent. */
  text: string;
}

export interface SummaryInput {
  now: Date;
  since: Date;
  /** Every card; done_at only where the card moved to done (from its activity). live_ask: an open user decision. */
  tasks: { id: string; title: string; goal: string; status: string; pr?: string; needs_user?: string; done_at?: string | null; live_ask?: boolean }[];
  machines: { machine: string; state: string; last_seen: string }[];
  /** Cards in doing with no news past the stuck threshold. */
  stale: { id: string; title: string; goal: string; age_hours: number }[];
  outcomes: { id: string; state: string; at: string; note: string; cause?: string }[];
  warnings: string[];
}

const card = (t: { id: string; title: string; goal: string; pr?: string }): SummaryCard => ({ id: t.id, title: t.title, goal: t.goal, ...(t.pr ? { pr: t.pr } : {}) });
const inWindow = (at: string | null | undefined, a: number, b: number) => { const ms = Date.parse(at ?? ''); return Number.isFinite(ms) && ms >= a && ms < b; };

export function buildSummary(x: SummaryInput): Summary {
  const a = x.since.getTime(), b = x.now.getTime();
  const open = x.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const finished = x.tasks.filter((t) => t.status === 'done' && inWindow(t.done_at, a, b)).sort((p, q) => Date.parse(p.done_at!) - Date.parse(q.done_at!)).map(card);
  const asks = open.filter((t) => t.live_ask).map(card);
  const approve = open.filter((t) => !t.live_ask && t.status === 'review' && !!t.needs_user?.trim()).map(card);
  const blocked = open.filter((t) => !t.live_ask && t.status === 'blocked-on-user').map(card);
  const machines = x.machines.filter((m) => m.state === 'quiet').map((m) => ({ machine: m.machine, last_seen: m.last_seen }));
  const cards = x.stale.map((s) => ({ ...card(s), hours: Math.round(s.age_hours) }));
  const failures = x.outcomes.filter((o) => o.state === 'failed' && inWindow(o.at, a, b)).map((o) => ({ id: o.id, at: o.at, note: o.note.split('\n')[0].slice(0, 200), ...(o.cause ? { cause: o.cause } : {}) }));
  const s = { at: x.now.toISOString(), day: localDate(x.now), since: x.since.toISOString(), until: x.now.toISOString(), finished,
    waiting: { asks, approve, blocked }, stuck: { machines, cards }, failures, warnings: x.warnings };
  return { ...s, text: summaryText(s) };
}

function summaryText(s: Omit<Summary, 'text'>): string {
  const out = [`Dasks summary ${s.day} (since ${s.since})`];
  const list = (head: string, xs: SummaryCard[]) => { out.push(`${head}: ${xs.length}`); for (const c of xs.slice(0, 10)) out.push(`  ${c.id}  ${c.title}${c.pr ? `  ${c.pr}` : ''}`); if (xs.length > 10) out.push(`  … ${xs.length - 10} more`); };
  list('Finished', s.finished);
  list('Waiting on you: decisions', s.waiting.asks);
  list('Waiting on you: approvals', s.waiting.approve);
  list('Waiting on you: blocked', s.waiting.blocked);
  out.push(`Stuck: ${s.stuck.machines.length} machine(s), ${s.stuck.cards.length} card(s)`);
  for (const m of s.stuck.machines) out.push(`  ${m.machine}  quiet since ${m.last_seen}`);
  for (const c of s.stuck.cards.slice(0, 10)) out.push(`  ${c.id}  no news for ${c.hours} h  ${c.title}`);
  out.push(`Failures: ${s.failures.length + s.warnings.length}`);
  for (const f of s.failures.slice(0, 10)) out.push(`  ${f.id}  ${f.cause ? `[${f.cause}] ` : ''}${f.note}`);
  for (const w of s.warnings) out.push(`  ${w}`);
  return out.join('\n');
}

/** Is a summary due now? Once per local day, at or after `at` (a board that was off at that time writes it at its first check after starting). */
export function summaryDue(now: Date, at: string, lastDay: string | null): boolean {
  const [h, m] = at.split(':').map(Number);
  return localDate(now) !== lastDay && now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

export const summaryFile = (root: string) => path.join(root, 'run', 'summary.json');

export function readSummary(root: string): Summary | null {
  try { const j = JSON.parse(fs.readFileSync(summaryFile(root), 'utf8')); return j && typeof j.day === 'string' && typeof j.until === 'string' ? j : null; } catch { return null; }
}
export function saveSummary(root: string, s: Summary): void {
  const f = summaryFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n');
  fs.renameSync(tmp, f);
}
