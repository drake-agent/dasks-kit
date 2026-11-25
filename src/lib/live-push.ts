// The runner's side of a card's live window (docs/runner.md "Live window"): while an agent phase runs, every interval
// it reads the new part of the phase's log and the worktree's changes since the run started, sanitizes both here, before
// anything leaves the machine, and posts them to POST /api/tasks/<card>/live. Fails open: a board error never touches
// the run, and a board without the route (404) turns it off for the phase.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { cleanText, MAX_FILES, MAX_STEP_CHARS, sanitizeDiff, type LiveFile } from './live-window.ts';

const GIT_TIMEOUT_MS = 10_000;
/** New log bytes read per tick at most: a burst beyond it is skipped, only the newest part is read. */
const LOG_READ_BYTES = 256 * 1024;
const STEPS_PER_TICK = 10;

export interface LivePushOptions {
  api: (method: string, route: string, body: unknown) => Promise<unknown>;
  card: string; runId: string; phase: string;
  /** The worktree, and the commit the run started from: the diff shows every change since, committed or not. */
  dir: string; base: string;
  logFile: string;
  intervalMs: number;
}
type StepIn = { kind: 'tool' | 'note'; text: string };

/** What a tool call is about: the description the agent gave it, else its command, file or pattern. */
function toolText(name: string, input: any): string {
  const d = input && typeof input === 'object' ? input.description ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? '' : '';
  return d ? `${name}: ${String(d)}` : name;
}

/** Steps from log lines: Claude's stream-json gives tool calls and text, any other line (Codex) is a note. */
export function stepsOf(lines: string[]): StepIn[] {
  const out: StepIn[] = [];
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (!l.startsWith('{')) { out.push({ kind: 'note', text: l }); continue; }
    let j: any; try { j = JSON.parse(l); } catch { continue; }
    if (j?.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
    for (const c of j.message.content) {
      if (c?.type === 'tool_use' && typeof c.name === 'string') out.push({ kind: 'tool', text: toolText(c.name, c.input) });
      else if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) out.push({ kind: 'note', text: c.text.trim().split('\n')[0] });
    }
  }
  return out.slice(-STEPS_PER_TICK).map((s) => ({ kind: s.kind, text: cleanText(s.text, MAX_STEP_CHARS) })).filter((s) => s.text);
}

const git = (dir: string, args: string[]) => new Promise<string | null>((resolve) => {
  execFile('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out)));
});

/** Changed files and the sanitized diff of a worktree against base (untracked files listed, without content). Null when
 *  git cannot read the worktree. */
export async function worktreeSnapshot(dir: string, base: string): Promise<{ files: LiveFile[]; diff: string } | null> {
  const [status, numstat, diff] = await Promise.all([
    git(dir, ['status', '--porcelain', '-uall']), git(dir, ['diff', '--numstat', '--no-renames', base]), git(dir, ['diff', '--no-color', '--no-renames', base]),
  ]);
  if (status === null || numstat === null) return null;
  const files = new Map<string, LiveFile>();
  for (const line of numstat.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m) files.set(m[3], { path: m[3], status: 'M', added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]) });
  }
  for (const line of status.split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2), p = line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '');
    const st: LiveFile['status'] = xy === '??' || xy.includes('A') ? 'A' : xy.includes('D') ? 'D' : xy.includes('R') ? 'R' : 'M';
    files.set(p, { ...(files.get(p) ?? { path: p, added: 0, deleted: 0 }), status: st });
  }
  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_FILES)
    .map((f) => ({ ...f, path: cleanText(f.path, 260) }));
  return { files: list, diff: diff === null ? '' : sanitizeDiff(diff).diff };
}

export interface LivePusher { tick(): Promise<boolean>; stop(): Promise<boolean> }

/** Starts posting at once (one tick per interval) until stop(), which posts the last state with ended: true. */
export function livePusher(o: LivePushOptions): LivePusher {
  let offset = (() => { try { return fs.statSync(o.logFile).size; } catch { return 0; } })();
  let off = false, stopped = false, last = '', busy: Promise<boolean> = Promise.resolve(false);
  const route = `/api/tasks/${encodeURIComponent(o.card)}/live`;

  function newLines(): string[] {
    let fd: number | null = null;
    try {
      const size = fs.statSync(o.logFile).size;
      if (size < offset) offset = 0; // the log was replaced
      const skip = size - offset > LOG_READ_BYTES, from = skip ? size - LOG_READ_BYTES : offset, buf = Buffer.alloc(size - from);
      fd = fs.openSync(o.logFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, from);
      const cut = buf.lastIndexOf(0x0a) + 1; // a line still being written waits for the next tick
      offset = from + cut;
      const lines = buf.subarray(0, cut).toString('utf8').split('\n');
      return skip ? lines.slice(1) : lines; // a cut-off first line is not shown
    } catch { return []; } finally { if (fd !== null) fs.closeSync(fd); }
  }

  async function send(ended: boolean): Promise<boolean> {
    if (off) return false;
    const steps = stepsOf(newLines());
    const wt = await worktreeSnapshot(o.dir, o.base);
    const body = { run_id: o.runId, phase: o.phase, ...(steps.length ? { steps } : {}), ...(wt ?? {}), ...(ended ? { ended } : {}) };
    const key = JSON.stringify({ ...body, steps: undefined });
    if (!ended && !steps.length && key === last) return false;
    try { await o.api('POST', route, body); last = key; return true; }
    catch (e: any) { if (e?.status === 404) off = true; return false; }
  }
  const run = (ended: boolean) => (busy = busy.then(() => send(ended), () => send(ended)));
  const timer = o.intervalMs > 0 ? setInterval(() => { if (!stopped) void run(false); }, o.intervalMs) : null;
  timer?.unref();
  if (o.intervalMs <= 0) off = true;
  return {
    tick: () => run(false),
    stop: () => { if (stopped) return Promise.resolve(false); stopped = true; if (timer) clearInterval(timer); return run(true); },
  };
}
