// dasks-captain: starts the captain for this board (docs/captain.md). It takes the board's captain lease as
// captain@<machine> (a second captain gets "held by …" and exit 3), launches the first harness of config.json
// captain.harness found on PATH with the captain prompt, renews the lease while the harness runs and releases it when
// the harness exits. A lease lost (it ran out and someone else took it) stops the harness. When the watch has not looked
// at the board for captain.watch_gap_sec, it says so once in the captain chat, and once more when the watch is back.
//   dasks-captain                 take the lease, run the harness in this terminal
//   dasks-captain --harness H     this harness instead of the chain (a name or a command template)
//   dasks-captain --dry-run       print the harness command and the prompt; take nothing
// Harness entries: "claude" and "codex" (interactive, the prompt as the first message), or a command template for any
// other CLI, words split on spaces, with {prompt} (the prompt text as one argument) or {prompt_file} (its path).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BoardError, client, machineName } from '../../mcp/board-client.mjs';
import { dasksHome } from '../lib/connection.mjs';

const KIT = path.resolve(import.meta.dirname, '../..');
const BUILTIN: Record<string, string[]> = { claude: ['claude', '{prompt}'], codex: ['codex', '{prompt}'] };

function which(cmd: string): string | null {
  if (cmd.includes('/')) { try { fs.accessSync(cmd, fs.constants.X_OK); return cmd; } catch { return null; } }
  for (const d of (process.env.PATH || '').split(':')) { const p = path.join(d || '.', cmd); try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}

/** The argv for one harness entry, placeholders filled. */
export function harnessArgv(entry: string, prompt: string, promptFile: string): string[] {
  const words = BUILTIN[entry.trim()] ?? entry.trim().split(/\s+/);
  return words.map((w) => w.replaceAll('{prompt_file}', promptFile).replaceAll('{prompt}', prompt));
}

/** The watch-gap alarm for one renewal tick: 'stopped' when the watch last looked (or this session started, if later)
 *  more than gapSec ago and nothing was said yet, 'back' when it looks again after that, else null. gapSec 0 = off. */
export function watchGap(lastLook: number | null, startedAt: number, now: number, gapSec: number, alerted: boolean): 'stopped' | 'back' | null {
  if (!gapSec) return null;
  const stale = now - Math.max(lastLook ?? 0, startedAt) > gapSec * 1000;
  return stale && !alerted ? 'stopped' : !stale && alerted ? 'back' : null;
}

function captainPrompt(url: string, actor: string): string {
  return [
    `You are the captain of the Dasks board at ${url}, writing as ${actor}. You hold the board's captain lease while this session runs.`,
    `Read the captain skill now and keep to it: ${path.join(KIT, 'skills/captain/SKILL.md')} (also installed as the "captain" skill).`,
    'Start with `dasks captain`, `dasks fleet`, `dasks tasks --status review,blocked-on-user` and `dask ready --all` to see where things stand.',
    'Then run `dasks-captain-watch` in the background. It exits after printing one line per event (REVIEW, BLOCKED, QUIET, IDLE, CHAT); act on each line, then start it again. Never leave it unarmed.',
    'Stay light: do yourself only what takes a few commands and under a minute; hand anything longer to a background subagent or command and answer the next event at once.',
    'Merge only with `dask captain-merge <card>`. Product decisions are the human\'s: ask on the card, never decide them yourself. Chat messages are never approvals.',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) { console.log(fs.readFileSync(import.meta.filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const dry = argv.includes('--dry-run');
  const hi = argv.indexOf('--harness');
  const only = hi >= 0 ? argv[hi + 1] : undefined;
  if (hi >= 0 && !only) { console.error('dasks-captain: --harness needs a value'); process.exit(2); }
  const unknown = argv.filter((a, i) => a !== '--dry-run' && a !== '--harness' && (hi < 0 || i !== hi + 1));
  if (unknown.length) { console.error(`dasks-captain: unknown option ${unknown[0]} (--harness, --dry-run, --help)`); process.exit(2); }

  const actor = `captain@${machineName()}`;
  const board = client({ actor });
  const info = await board.captain() as { harness: string[]; lease_sec: number; watch_gap_sec?: number };
  const dir = path.join(dasksHome(), 'captain');
  fs.mkdirSync(dir, { recursive: true });
  const promptFile = path.join(dir, 'prompt.md');
  const prompt = captainPrompt(board.url, actor);
  fs.writeFileSync(promptFile, prompt + '\n');
  const chain: string[] = only ? [only] : info.harness;
  const pick = chain.map((h) => ({ h, argv: harnessArgv(h, prompt, promptFile) })).find((c) => which(c.argv[0]));
  if (!pick) { console.error(`dasks-captain: no harness of the chain is on PATH (${chain.join(', ')})`); process.exit(1); }
  if (dry) {
    console.log(`harness: ${pick.h}\ncommand: ${pick.argv.map((a) => (a === prompt ? '<prompt>' : a)).join(' ')}\nprompt (${promptFile}):\n${prompt}`);
    return;
  }

  type Lease = { lease_id: string; expires_at: string };
  let lease: Lease;
  try { lease = await board.lease({ ttl_sec: info.lease_sec }) as Lease; }
  catch (e: any) {
    if (e instanceof BoardError && e.status === 409) { console.error(`dasks-captain: the captain lease is held by ${e.data?.holder} until ${e.data?.expires_at}; not started`); process.exit(3); }
    throw e;
  }
  console.error(`dasks-captain: lease taken as ${actor} until ${lease.expires_at}; starting ${pick.h}`);
  const child = spawn(which(pick.argv[0])!, pick.argv.slice(1), { stdio: 'inherit', env: { ...process.env, DASKS_ACTOR: actor, DASKS_CAPTAIN_LEASE: lease.lease_id } });
  let lost = false;
  const started = Date.now(), watchFile = path.join(dir, 'watch.json');
  let alerted = false, posting = false;
  const sayWatchGap = async () => {
    if (posting) return; // a slow chat post still running: deciding again now would send the note twice
    let last: number | null = null;
    try { last = fs.statSync(watchFile).mtimeMs; } catch { /* the watch never ran on this Mac */ }
    const say = watchGap(last, started, Date.now(), info.watch_gap_sec ?? 0, alerted);
    if (!say) return;
    const min = Math.round((Date.now() - Math.max(last ?? 0, started)) / 60000);
    const text = say === 'stopped'
      ? `The captain's watch has not looked at the board for ${min} min: the captain gets no new events until it starts dasks-captain-watch again. Its session may be stuck in a long job.`
      : 'The captain\'s watch is looking at the board again.';
    posting = true;
    try { await board.chatReply(text, lease.lease_id); alerted = say === 'stopped'; }
    catch (e: any) { console.error(`dasks-captain: could not post the watch note (${e.message}); trying again`); }
    finally { posting = false; }
  };
  const renew = setInterval(async () => {
    try { lease = await board.lease({ ttl_sec: info.lease_sec, lease_id: lease.lease_id }) as Lease; await sayWatchGap(); }
    catch (e: any) {
      if (!(e instanceof BoardError && e.status === 409)) { console.error(`dasks-captain: lease renewal failed (${e.message}); trying again`); return; }
      lost = true; clearInterval(renew);
      console.error(`dasks-captain: the lease is gone (${e.data?.error ?? e.message}); stopping the harness`);
      child.kill('SIGTERM');
    }
  }, Math.max(5, Math.floor(info.lease_sec / 3)) * 1000);
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig));
  process.on('SIGINT', () => { /* the terminal sends it to the harness too; wait for it to exit */ });
  const code: number = await new Promise((r) => child.on('exit', (c, s) => r(c ?? (s ? 128 : 1))));
  clearInterval(renew);
  if (!lost) { try { await board.releaseLease(lease.lease_id); console.error('dasks-captain: lease released'); } catch (e: any) { console.error(`dasks-captain: lease not released (${e.message}); it runs out at ${lease.expires_at}`); } }
  process.exit(lost ? 3 : code);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) main().catch((e) => { console.error(`dasks-captain: ${e?.message || e}`); process.exit(1); });
