// What a stopped build leaves for the next attempt. saveWork runs before the card goes back: it turns uncommitted changes
// into a WIP commit, scans, pushes the card branch and answers with the sentence the card's note carries. pickStart runs
// before the next build, on any Mac: it finds the saved branch and says where the worktree starts. Neither ever throws
// (a failed save must not hold up the hand-back), every git step has a deadline, and nothing here blocks the runner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBounded, why, type ProcResult } from './proc.ts';
import { redact } from './redact.ts';

/** Names a WIP commit never takes, wherever they are: a scanner cannot tell a weak password from a config value. */
const NEVER_COMMIT = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.mobileprovision', 'id_rsa*', 'id_ed25519*'];
/** Past these the worktree holds build output, not work: the WIP commit is refused. */
const MAX_PATHS = 1000, MAX_FILE_BYTES = 50 * 1024 * 1024;
const SCAN_MS = 180_000, PUSH_MS = 120_000, GIT_MS = 60_000;

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = GIT_MS): Promise<ProcResult> =>
  runBounded('git', args, { cwd, env: env ?? process.env, timeoutMs, maxOut: 16 << 20 });
const tipOf = async (repo: string, ref: string) => { const r = await git(repo, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]); return r.code === 0 ? r.out.trim() : ''; };
const countAfter = async (repo: string, from: string, to: string) => { const r = await git(repo, ['rev-list', '--count', `${from}..${to}`]); return r.code === 0 ? Number(r.out) : 0; };
const contains = async (repo: string, tip: string, sha: string) => (await git(repo, ['merge-base', '--is-ancestor', sha, tip])).code === 0;
const said = (s: string, n = 200) => redact(s.replace(/\s+/g, ' ').trim()).slice(0, n);

/** The only branches the runner pushes: dasks/<card>, never the default branch. */
export const pushableBranch = (branch: string, base: string) => branch.startsWith('dasks/') && branch !== base.replace(/^origin\//, '');
/** A local ref outside refs/heads: never pushed, not in anyone's branch list, gone only when you delete it. */
const keptRef = (card: string, sha: string) => `refs/dasks/kept/${card}/${sha.slice(0, 7)}`;
export const originRef = (branch: string) => `refs/remotes/origin/${branch}`;

interface Wip { sha?: string; leftOut: number; refused?: string }

/** The worktree's uncommitted changes as a commit on top of `head`, built in a temporary index so the branch does not
 *  move here and nothing but a finished commit object exists afterwards. No hooks run (commit-tree). */
async function wipCommit(dir: string, branch: string, card: string, reason: string, head: string): Promise<Wip> {
  const on = await git(dir, ['symbolic-ref', '-q', 'HEAD']);
  if (on.out.trim() !== `refs/heads/${branch}`) return { leftOut: 0, refused: `the worktree is not on ${branch}` };
  const conflicts = await git(dir, ['ls-files', '-u']);
  if (conflicts.code !== 0) return { leftOut: 0, refused: why(conflicts) };
  if (conflicts.out.trim()) return { leftOut: 0, refused: 'the worktree has unresolved merge conflicts' };
  const st = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (st.code !== 0) return { leftOut: 0, refused: why(st) };
  const paths = st.out.split('\0').filter(Boolean).map((e) => e.slice(3));
  if (!paths.length) return { leftOut: 0 };
  if (paths.length > MAX_PATHS) return { leftOut: 0, refused: `${paths.length} changed paths, over the limit of ${MAX_PATHS}` };
  for (const p of paths) {
    let size = 0;
    try { size = fs.lstatSync(path.join(dir, p)).size; } catch { continue; }   // a deleted path
    if (size > MAX_FILE_BYTES) return { leftOut: 0, refused: `${p} is over ${MAX_FILE_BYTES >> 20} MiB` };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-wip-'));
  try {
    const own = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    const step = async (args: string[]) => { const r = await git(dir, args, own); if (r.code !== 0) throw new Error(why(r)); return r.out.trim(); };
    await step(['read-tree', head]);
    await step(['add', '-A', '--', '.', ...NEVER_COMMIT.map((g) => `:(glob,exclude)**/${g}`)]);
    const tree = await step(['write-tree']);
    const taken = new Set((await step(['diff-tree', '-r', '--name-only', '--no-renames', head, tree])).split('\n').filter(Boolean));
    const leftOut = paths.filter((p) => !taken.has(p)).length;
    if (!taken.size) return { leftOut };
    return { sha: await step(['commit-tree', tree, '-p', head, '-m', `${card}: wip: unfinished work saved by the runner (${said(reason, 120)})`]), leftOut };
  } catch (e: any) {
    return { leftOut: 0, refused: said(e.message) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export interface SaveInput { repo: string; dir: string; branch: string; base: string; card: string; machine: string; reason: string; gitleaks: string | null }

/** Save what the stopped run left and say where it is, for the card's note. The branch moves to a WIP commit only after
 *  the scan says it may leave this Mac or when there is no scanner to ask; a flagged WIP commit stays off the branch, so
 *  the next run does not build on it. Safe to run twice. '' = there was nothing to save, so the note needs no line. */
export async function saveWork(o: SaveInput): Promise<string> {
  try { return await save(o); } catch (e: any) { return `Work not saved: ${said(e.message)}.`; }
}

async function save({ repo, dir, branch, base, card, machine, reason, gitleaks }: SaveInput): Promise<string> {
  const ref = `refs/heads/${branch}`;
  const head = await tipOf(repo, ref);
  if (!head) return '';
  const wip: Wip = fs.existsSync(dir) ? await wipCommit(dir, branch, card, reason, head) : { leftOut: 0 };
  const tip = wip.sha ?? head;
  const extras = [
    wip.refused ? `Uncommitted changes not saved: ${said(wip.refused)}.` : '',
    wip.leftOut ? `${wip.leftOut} changed file(s) left out of the WIP commit (secret-shaped names or no change from the branch).` : '',
  ].filter(Boolean).join(' ');
  const tell = (s: string) => (extras ? `${s} ${extras}` : s);
  const commits = await countAfter(repo, base, tip);
  if (!commits) return extras ? `No commits to save. ${extras}` : '';

  const onOrigin = await git(repo, ['ls-remote', '--heads', 'origin', ref]);
  if (!wip.sha && onOrigin.code === 0 && onOrigin.out.split(/\s/)[0] === tip) return tell(`Work saved: branch ${branch} on origin @ ${tip.slice(0, 7)}.`);
  const here = (n: number) => (n ? `${n} commit(s) stay on local branch ${branch} on ${machine}` : 'The branch has no other commits');
  const before = wip.sha ? await countAfter(repo, base, head) : commits;
  const moveBranch = async () => wip.sha ? (await git(repo, ['update-ref', '-m', 'dasks runner: wip', ref, wip.sha, head])) : null;

  if (!pushableBranch(branch, base)) return tell(`Work not pushed: refusing to push ${branch}; the runner pushes only its dasks/ branches. ${here(before)}.`);
  if (!gitleaks) {
    const moved = await moveBranch();
    if (moved && moved.code !== 0) return tell(`Work not pushed: gitleaks is not installed, and the WIP commit could not be kept (${why(moved, 120)}). ${here(before)}.`);
    return tell(`Work not pushed: gitleaks is not installed. ${here(commits)}${wip.sha ? ', the last one a WIP commit' : ''}.`);
  }
  const scan = await runBounded(gitleaks, ['git', '--no-banner', '--redact', '--log-opts', `${base}..${tip}`, repo], { cwd: repo, timeoutMs: SCAN_MS });
  if (scan.code !== 0) {
    let kept = '';
    if (wip.sha) {
      const aside = keptRef(card, wip.sha);
      kept = (await git(repo, ['update-ref', aside, wip.sha])).code === 0
        ? ` The uncommitted changes are kept only on ${machine}, at ${aside}, off the branch.`
        : ' The uncommitted changes were not kept.';
    }
    return tell(`Work not pushed: gitleaks flagged the new commits (or failed), so nothing left this Mac. ${here(before)}.${kept}`);
  }
  const moved = await moveBranch();
  if (moved && moved.code !== 0) return tell(`Work not pushed: the WIP commit could not go on ${branch} (${why(moved, 120)}). ${here(before)}.`);
  const push = await git(repo, ['push', '-q', 'origin', `${ref}:${ref}`], undefined, PUSH_MS);
  if (push.code !== 0) return tell(`Work not pushed: git push failed (${said(why(push), 160)}). ${here(commits)}.`);
  return tell(`Work saved: branch ${branch} on origin @ ${tip.slice(0, 7)}${wip.sha ? ', with a WIP commit of the uncommitted changes' : ''}.`);
}

/** Can a build continue from this commit? It needs commits beyond base on a shared history, and something base does not
 *  already have (a squash-merged branch has commits but merges to base's own tree). A branch that conflicts with base is
 *  still usable: the build merges it. An old git without `merge-tree --write-tree` skips that last check. */
async function usable(repo: string, sha: string, base: string): Promise<boolean> {
  if (!await countAfter(repo, base, sha)) return false;
  if ((await git(repo, ['merge-base', base, sha])).code !== 0) return false;
  const merged = await git(repo, ['merge-tree', '--write-tree', base, sha]);
  return !(merged.code === 0 && merged.out.split('\n')[0].trim() === await tipTree(repo, base));
}
const tipTree = async (repo: string, ref: string) => (await git(repo, ['rev-parse', `${ref}^{tree}`])).out.trim();

export interface Start {
  /** origin: origin's branch is the start (local fast-forwarded to it). local: this Mac's branch. base: the default branch. */
  from: 'origin' | 'local' | 'base';
  sha: string;
  /** A local tip the start would have dropped, kept under this ref. */
  aside?: string;
}

/** Where the card's next build starts. origin's branch wins when this Mac's holds nothing beyond it; when the two have
 *  split, origin's is what every Mac can see, so it wins and the local tip goes aside. A fetch that fails means origin's
 *  branch is unknown (a remote-tracking ref alone may be a branch deleted long ago): the local branch decides, as if
 *  origin had none. */
export async function pickStart(repo: string, branch: string, base: string, card: string): Promise<Start> {
  const fetched = await git(repo, ['fetch', '-q', 'origin', `+refs/heads/${branch}:${originRef(branch)}`], undefined, PUSH_MS);
  const remote = fetched.code === 0 ? await tipOf(repo, originRef(branch)) : '';
  const local = await tipOf(repo, `refs/heads/${branch}`);
  const remoteOk = !!remote && await usable(repo, remote, base);
  const localOk = !!local && await usable(repo, local, base);
  if (remoteOk && localOk && await contains(repo, local, remote) && local !== remote) return { from: 'local', sha: local };
  const setAside = async (): Promise<string | undefined> => {
    if (!local || !await countAfter(repo, base, local)) return undefined;
    const ref = keptRef(card, local);
    return (await git(repo, ['update-ref', ref, local])).code === 0 ? ref : undefined;
  };
  if (remoteOk) return { from: 'origin', sha: remote, ...(local && !await contains(repo, remote, local) ? { aside: await setAside() } : {}) };
  if (localOk) return { from: 'local', sha: local };
  return { from: 'base', sha: await tipOf(repo, base), aside: await setAside() };
}
