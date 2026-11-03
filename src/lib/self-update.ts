// Runner self-update (docs/runner.md "Staying current"). Between cards the runner fetches the kit checkout's remote; when
// the remote's default branch moved past this checkout it fast-forwards, runs `npm ci --omit=dev` if the lockfile
// changed, and restarts. It holds instead, and says why, when the checkout is not a clean clone on that branch, when
// it has commits the remote does not (diverged), or when the new kit wants a board schema newer than the board's:
// a runner must not run code the board cannot serve. It never resets, stashes or forces anything of the user's.
import fs from 'node:fs';
import path from 'node:path';
import { runBounded, why } from './proc.ts';

export type UpdatePlan =
  | { action: 'none'; reason: string }
  | { action: 'hold'; reason: string }
  | { action: 'update'; reason: string; from: string; to: string };

const GIT_MS = 60_000;

/** May the runner look for an update now? Only with runner.update on (unset: on a Mac that joined a fleet, whose
 *  settings are ~/.dasks/runner.json) and only between cards: no card running or still being handed back. */
export function mayUpdate(o: { update?: boolean; joined: boolean; busy: number; stopping: boolean }): boolean {
  return (o.update ?? o.joined) && o.busy === 0 && !o.stopping;
}
const NPM_MS = 15 * 60_000;

/** The highest board schema a kit's src/lib/migrate.ts migrates to (its SCHEMA_VERSION), or null. */
export function schemaOfSource(src: string): number | null {
  const tos = [...src.matchAll(/\{\s*to:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
  return tos.length ? Math.max(...tos) : null;
}

const git = (kit: string, args: string[], ms = GIT_MS) => runBounded('git', ['-C', kit, ...args], { timeoutMs: ms, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

/** What an update would do now. boardSchema: the board's schema version from /api/health (null = not known). */
export async function planUpdate(kit: string, boardSchema: number | null): Promise<UpdatePlan> {
  const hold = (reason: string): UpdatePlan => ({ action: 'hold', reason });
  const inside = await git(kit, ['rev-parse', '--show-toplevel']);
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  if (inside.code !== 0 || real(inside.out.trim()) !== real(kit)) return hold('the kit folder is not a git clone; update it by hand (docs/upgrade.md)');
  const upstream = await git(kit, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const remote = upstream.code === 0 ? upstream.out.trim().split('/')[0] : 'origin';
  const fetched = await git(kit, ['fetch', '--quiet', '--no-tags', remote]);
  if (fetched.code !== 0) return hold(`git fetch ${remote} failed (${why(fetched, 160)})`);
  const def = await git(kit, ['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`]);
  const target = def.code === 0 && def.out.trim() ? def.out.trim() : `${remote}/main`;
  const branch = target.slice(remote.length + 1);
  const [head, to] = await Promise.all([git(kit, ['rev-parse', 'HEAD']), git(kit, ['rev-parse', '--verify', '-q', `${target}^{commit}`])]);
  if (to.code !== 0) return hold(`${target} does not exist in the kit checkout`);
  const from = head.out.trim(), next = to.out.trim();
  if (from === next) return { action: 'none', reason: `up to date with ${target}` };
  const cur = await git(kit, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (cur.out.trim() !== branch) return hold(`the kit checkout is on ${cur.out.trim() || 'a detached HEAD'}, not ${branch}; ${target} moved`);
  const dirty = await git(kit, ['--no-optional-locks', 'status', '--porcelain']);
  if (dirty.code !== 0 || dirty.out.trim()) return hold(`the kit checkout has local changes; ${target} moved (commit or remove them to get updates)`);
  const ff = await git(kit, ['merge-base', '--is-ancestor', 'HEAD', next]);
  if (ff.code !== 0) return hold(`the kit checkout has commits ${target} does not (diverged); not updated`);
  const src = await git(kit, ['show', `${next}:src/lib/migrate.ts`]);
  const want = src.code === 0 ? schemaOfSource(src.out) : null;
  if (want === null) return hold(`cannot read the board schema the new kit needs (${target})`);
  if (boardSchema === null) return hold('the board did not say its schema version (/api/health); not updated');
  if (want > boardSchema) return hold(`the new kit needs board schema ${want}, the board is at ${boardSchema}: update the board first`);
  return { action: 'update', reason: `${target} moved to ${next.slice(0, 12)}`, from, to: next };
}

/** Install plan.to's dependencies when its lockfile differs, then fast-forward. The install runs first, in a staging
 *  folder beside the kit with that commit's package.json and package-lock.json: `npm ci` empties node_modules before it
 *  installs, so it never runs on the runner's own. Only after it succeeded does the kit move and its node_modules get
 *  swapped for the new one; a failed install leaves the checkout and node_modules as they were, and the update held. */
export async function applyUpdate(kit: string, plan: Extract<UpdatePlan, { action: 'update' }>, npm: string, rename: (a: string, b: string) => void = fs.renameSync): Promise<{ ok: boolean; reason: string; deps: boolean; stuck?: boolean }> {
  const lock = async (rev: string) => (await git(kit, ['rev-parse', `${rev}:package-lock.json`])).out.trim();
  const deps = (await lock(plan.from)) !== (await lock(plan.to));
  let stage = '';
  /** Set when the staging folder holds the runner's only copy of its old dependencies: then it is never deleted. */
  let keep = false;
  try {
    if (deps) {
      stage = fs.mkdtempSync(path.join(path.dirname(path.resolve(kit)), `.${path.basename(path.resolve(kit))}-deps-`));
      for (const f of ['package.json', 'package-lock.json']) {
        const r = await git(kit, ['show', `${plan.to}:${f}`]);
        if (r.code !== 0) return { ok: false, deps, reason: `cannot read ${f} of ${plan.to.slice(0, 12)} (${why(r, 120)}); not updated` };
        fs.writeFileSync(path.join(stage, f), r.out);
      }
      const r = await runBounded(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, timeoutMs: NPM_MS, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
      if (r.code !== 0 || !fs.existsSync(path.join(stage, 'node_modules'))) return { ok: false, deps, reason: `npm ci for ${plan.to.slice(0, 12)} failed (${why(r, 160)}); not updated, the runner keeps its dependencies` };
    }
    const ff = await git(kit, ['merge', '--ff-only', '-q', plan.to]);
    if (ff.code !== 0) return { ok: false, reason: `fast-forward failed (${why(ff, 160)}); not updated`, deps };
    if (!deps) return { ok: true, reason: `fast-forwarded to ${plan.to.slice(0, 12)}`, deps };
    const mods = path.join(kit, 'node_modules'), old = path.join(stage, 'node_modules.old');
    const had = fs.existsSync(mods);
    try {
      if (had) rename(mods, old);
      rename(path.join(stage, 'node_modules'), mods);
    } catch (e: any) {
      const why1 = e.code || e.message;
      if (had && !fs.existsSync(mods)) {
        try { rename(old, mods); } catch (r: any) {
          keep = true;
          return { ok: false, deps, stuck: true, reason: `could not swap node_modules (${why1}) nor put the old one back (${r.code || r.message}): dependencies missing: restore by hand from ${old} (mv it to ${mods}); updates held until then` };
        }
      }
      const back = await git(kit, ['reset', '--keep', '-q', plan.from]);
      return { ok: false, deps, reason: `could not swap node_modules (${why1}); ${back.code === 0 ? `back on ${plan.from.slice(0, 12)} with its dependencies` : 'look at the kit checkout'}` };
    }
    if (!fs.existsSync(mods)) { keep = true; return { ok: false, deps, stuck: true, reason: `node_modules is missing after the swap: dependencies missing: restore by hand from ${had ? old : path.join(stage, 'node_modules')}; updates held until then` }; }
    return { ok: true, reason: `fast-forwarded to ${plan.to.slice(0, 12)}; dependencies installed`, deps };
  } finally { if (stage && !keep) fs.rmSync(stage, { recursive: true, force: true }); }
}
