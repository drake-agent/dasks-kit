// One child process with a deadline, without blocking the event loop: the server and the runner keep answering (and
// sending heartbeats) while git or gh is slow. The child gets its own process group, so a timeout ends it and anything
// it started. Never throws: a missing binary is code -1 with the reason in err.
import { spawn } from 'node:child_process';

export interface ProcResult { code: number; out: string; err: string; timedOut: boolean }

export function runBounded(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxOut?: number }): Promise<ProcResult> {
  const max = o.maxOut ?? 1024 * 1024;
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timedOut = false;
    let child: ReturnType<typeof spawn>;
    const end = (code: number) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err, timedOut }); } };
    try { child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e: any) { resolve({ code: -1, out: '', err: e.message, timedOut: false }); return; }
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      end(-1);
    }, o.timeoutMs);
    child.stdout!.on('data', (d) => { if (out.length < max) out += d; });
    child.stderr!.on('data', (d) => { if (err.length < max) err += d; });
    child.on('error', (e) => { err += e.message; end(-1); });
    child.on('close', (code) => end(code ?? -1));
  });
}

/** stderr (else stdout) on one line, at most n characters: what a log line or a status field says about a failure. */
export function why(r: ProcResult, n = 300): string {
  if (r.timedOut) return 'timed out';
  const s = (r.err || r.out || `exit ${r.code}`).replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
