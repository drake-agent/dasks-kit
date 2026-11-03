// dasks-captain-watch: what the captain should react to, one line per board event (docs/captain.md):
//   REVIEW <card> <pr>        a card moved to review
//   BLOCKED <card>            a card moved to blocked-on-user
//   QUIET <machine> <seen>    a runner stopped sending heartbeats
//   IDLE <machine>            a runner finished its cards and has room
//   CHAT <seq>                the human wrote in the captain chat
// It compares the board with what it saw last time (~/.dasks/captain/watch.json); the first run only takes that
// baseline. By default it waits until there is at least one event, prints them and exits 0, so a session can run it in
// the background and start it again after each batch.
//   dasks-captain-watch [--interval S] [--timeout S]   wait for events (exit 124 when the timeout passes first)
//   dasks-captain-watch --once                         one look: print what changed (maybe nothing), exit 0
//   dasks-captain-watch --follow                       keep printing until stopped
//   --state FILE                                       another state file (one per watcher)
import fs from 'node:fs';
import path from 'node:path';
import { client } from '../../mcp/board-client.mjs';
import { dasksHome } from '../lib/connection.mjs';

interface WatchState { tasks: Record<string, string>; quiet: Record<string, boolean>; busy: Record<string, boolean>; chat: number }

export function events(prev: WatchState, tasks: { id: string; status: string; pr?: string }[], machines: { machine: string; quiet: boolean; cards: string[]; last_seen: string }[], chat: { seq: number; from: string }[]): { lines: string[]; next: WatchState } {
  const lines: string[] = [];
  const next: WatchState = { tasks: {}, quiet: {}, busy: {}, chat: prev.chat };
  for (const t of tasks) {
    next.tasks[t.id] = t.status;
    if (prev.tasks[t.id] === t.status) continue;
    if (t.status === 'review') lines.push(`REVIEW ${t.id} ${t.pr || '-'}`);
    if (t.status === 'blocked-on-user') lines.push(`BLOCKED ${t.id}`);
  }
  for (const m of machines) {
    next.quiet[m.machine] = m.quiet; next.busy[m.machine] = m.cards.length > 0;
    if (m.quiet && !prev.quiet[m.machine]) lines.push(`QUIET ${m.machine} ${m.last_seen}`);
    else if (!m.quiet && prev.busy[m.machine] && !m.cards.length) lines.push(`IDLE ${m.machine}`);
  }
  for (const c of chat) {
    if (c.seq <= prev.chat) continue;
    if (c.from === 'user') lines.push(`CHAT ${c.seq}`);
    next.chat = Math.max(next.chat, c.seq);
  }
  return { lines, next };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) { console.log(fs.readFileSync(import.meta.filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const val = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] ?? '' : d; };
  const interval = Number(val('--interval', '15')), timeout = Number(val('--timeout', '0'));
  if (!(interval > 0) || !(timeout >= 0)) { console.error('dasks-captain-watch: --interval and --timeout take seconds'); process.exit(2); }
  const once = argv.includes('--once'), follow = argv.includes('--follow');
  const file = val('--state', path.join(dasksHome(), 'captain', 'watch.json'));
  const board = client({});
  let state: WatchState | null = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const end = timeout ? Date.now() + timeout * 1000 : Infinity;
  let said = '';
  for (;;) {
    try {
      const [tasks, fleet, chat] = await Promise.all([board.tasks({}), board.fleet(), board.chat(state?.chat ?? 0)]);
      const base = state ?? { tasks: {}, quiet: {}, busy: {}, chat: chat.last_seq };
      const { lines, next } = events(base, tasks, fleet.machines, state ? chat.messages : []);
      if (!state) { next.tasks = Object.fromEntries(tasks.map((t: any) => [t.id, t.status])); next.chat = chat.last_seq; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(next) + '\n'); fs.renameSync(file + '.tmp', file);
      const first = !state;
      state = next; said = '';
      if (!first && lines.length) { process.stdout.write(lines.join('\n') + '\n'); if (!follow) return; }
      if (once) return;
    } catch (e: any) {
      if (said !== e.message) console.error(`dasks-captain-watch: ${e.message}; trying again`);
      said = e.message;
    }
    if (Date.now() >= end) process.exit(124);
    await new Promise((r) => setTimeout(r, Math.min(interval * 1000, Math.max(0, end - Date.now()))));
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) main().catch((e) => { console.error(`dasks-captain-watch: ${e?.message || e}`); process.exit(1); });
