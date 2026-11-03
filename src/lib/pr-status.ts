// PR status for the review triage page, read with `gh` by the server and cached in run/pr-status.json. The browser never
// calls GitHub. Calls are bounded: at most PR_PARALLEL at a time, PR_TIMEOUT_MS each, PR_SWEEP_MAX per sweep, and a PR
// read within PR_TTL_MS is not read again. Without gh (or not logged in) every PR reads as unknown; nothing fails.
import fs from 'node:fs';
import path from 'node:path';
import { runBounded, why } from './proc.ts';

export type PrStatus =
  | { ok: true; at: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; head: string; ci: 'green' | 'red' | 'pending' | 'none'; updated_at: string }
  | { ok: false; at: string; error: string };

export const PR_TTL_MS = 5 * 60_000;
export const PR_TIMEOUT_MS = 20_000;
export const PR_PARALLEL = 4;
export const PR_SWEEP_MAX = 60;
export const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

const RED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
/** The only conclusions that count as passed; anything else (STALE: expired, run it again) keeps the PR waiting. */
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** The checks of `gh pr view --json statusCheckRollup` as one word. */
export function ciOf(rollup: unknown): 'green' | 'red' | 'pending' | 'none' {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (!checks.length) return 'none';
  let pending = false;
  for (const c of checks) {
    const conclusion = String(c?.conclusion ?? '').toUpperCase(), state = String(c?.state ?? '').toUpperCase(), status = String(c?.status ?? '').toUpperCase();
    if (RED.has(conclusion) || RED.has(state)) return 'red';
    if (c?.__typename === 'StatusContext' ? state !== 'SUCCESS' : status !== 'COMPLETED' || !PASSED.has(conclusion)) pending = true;
  }
  return pending ? 'pending' : 'green';
}

/** One `gh pr view` answer as a status (pure). */
export function parsePrView(json: string, at: string): PrStatus {
  let j: any;
  try { j = JSON.parse(json); } catch { return { ok: false, at, error: 'gh answered something that is not JSON' }; }
  const state = String(j?.state ?? '').toUpperCase();
  if (!['OPEN', 'MERGED', 'CLOSED'].includes(state) || typeof j?.headRefOid !== 'string') return { ok: false, at, error: 'gh answered without state or head' };
  return { ok: true, at, state: state as 'OPEN', head: j.headRefOid, ci: ciOf(j.statusCheckRollup), updated_at: String(j.updatedAt ?? '') };
}

export class PrStatusCache {
  private map = new Map<string, PrStatus>();
  private file: string;
  private sweeping: Promise<void> | null = null;
  private gh: () => string | null;
  constructor(root: string, gh: () => string | null) {
    this.gh = gh;
    this.file = path.join(root, 'run', 'pr-status.json');
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); for (const [k, v] of Object.entries(j ?? {})) if (PR_URL_RE.test(k) && v && typeof v === 'object') this.map.set(k, v as PrStatus); } catch { /* none yet */ }
  }
  get(pr: string): PrStatus | undefined { return this.map.get(pr); }

  /** Read the PRs whose status is missing or older than the TTL, bounded as above. One sweep at a time; a sweep asked
   *  for while one runs returns that one. */
  refresh(prs: string[], now = Date.now()): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const want = new Set(prs);
    for (const k of [...this.map.keys()]) if (!want.has(k)) this.map.delete(k); // PRs no longer in review are forgotten
    const due = [...want].filter((p) => PR_URL_RE.test(p) && !(now - Date.parse(this.map.get(p)?.at ?? '') < PR_TTL_MS))
      .sort((a, b) => Date.parse(this.map.get(a)?.at ?? '') - Date.parse(this.map.get(b)?.at ?? '') || 0).slice(0, PR_SWEEP_MAX);
    if (!due.length) return Promise.resolve();
    this.sweeping = this.sweep(due).finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async sweep(due: string[]) {
    const gh = this.gh();
    const queue = [...due];
    const one = async (pr: string) => {
      const at = new Date().toISOString();
      if (!gh) { this.map.set(pr, { ok: false, at, error: 'gh is not installed' }); return; }
      const r = await runBounded(gh, ['pr', 'view', pr, '--json', 'state,headRefOid,statusCheckRollup,updatedAt'], { timeoutMs: PR_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
      this.map.set(pr, r.code === 0 ? parsePrView(r.out, at) : { ok: false, at, error: `gh pr view failed (${why(r, 160)})` });
    };
    await Promise.all(Array.from({ length: Math.min(PR_PARALLEL, queue.length) }, async () => { for (let p = queue.shift(); p; p = queue.shift()) await one(p); }));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (e: any) { console.error(`pr status: could not save ${this.file} (${e.code || e.message})`); }
  }
}
