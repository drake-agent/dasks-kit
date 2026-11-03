// dask spec <card>: the runner's spec loop from your own session (docs/specs.md). The current tool drafts (or your own
// draft with --file is stored as the first version), the other tool reviews it adversarially from the same read-only
// view of the project's default branch, the drafter revises on P0/P1 findings or blocking questions: two full review
// passes, then at most one narrow pass on the fixes. The spec ends ready or draft with a card note. It never claims the card (a claim would bar you from
// writing its answer key), never writes the project's checkout and never builds.
//   node src/cli/spec.ts <card> --tool claude|codex --author <board name> [--file F] [--repo PATH|owner/name]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { boardRoot, configFile } from '../lib/config.ts';
import { authHeader, boardUrl, dasksHome, machineName } from '../lib/connection.mjs';
import { agentCommand, agentText, runnerConfig, type Tool } from '../lib/runner.ts';
import { supervise, type Supervised } from '../lib/supervise.ts';
import { cleanStaleCliViews, closeRepoView, openRepoView, otherTool, repoSource, specCacheDir, specLoop, specViewsDir, TOOL_NAME } from '../lib/spec-flow.ts';
import { familyOf } from '../lib/spec-state.ts';

class BoardError extends Error { status: number; body: any; constructor(s: number, m: string, b: any) { super(m); this.status = s; this.body = b; } }
const die = (m: string, code = 1): never => { console.error(`dask spec: ${m}`); process.exit(code); };

function which(cmd: string): string | null {
  for (const d of (process.env.PATH || '').split(':')) { const p = path.join(d || '.', cmd); try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };
function configDoc(): Record<string, any> {
  const local = path.join(dasksHome(), 'runner.json');
  const f = process.env.DASKS_RUNNER_CONFIG || (fs.existsSync(local) ? local : configFile(boardRoot()));
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const card = argv[0];
  if (!card || card.startsWith('-')) die('usage: dask spec <card> [--tool claude|codex] [--file F] [--repo PATH|owner/name]', 2);
  const tool = opt('--tool') as Tool;
  if (tool !== 'claude' && tool !== 'codex') die('run it from a Claude Code or Codex session, or pass --tool claude|codex', 2);
  const machine = machineName();
  const author = opt('--author') || `human-${tool}@${machine}`;
  const file = opt('--file');
  const preset = file !== undefined ? fs.readFileSync(file, 'utf8') : undefined;
  const url = boardUrl();
  const api = async (method: string, route: string, body?: unknown, as?: string) => {
    const r = await fetch(url + route, { method, signal: AbortSignal.timeout(60_000), headers: { 'X-Dasks-Actor': as ?? author, ...authHeader(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j: any = text; try { j = JSON.parse(text); } catch { /* text */ }
    if (!r.ok) throw new BoardError(r.status, `${method} ${route} -> ${r.status} ${j?.error ?? text}${j?.reasons ? ': ' + j.reasons.join('; ') : ''}`, j);
    return j;
  };

  const t = await api('GET', `/api/tasks/${card}?log=0`).catch((e) => die(e.message));
  if (t.claimed_by) die(`${card} is claimed by ${t.claimed_by}; a spec run waits until it is given back`);
  if (t.spec_state === 'blocked') die(`${card} is blocked for Spec (${t.block_note || 'no note'}); only the user lifts that`);
  if (t.status !== 'todo') die(`${card} is ${t.status}, not todo`);
  const doc = configDoc();
  const cfg = runnerConfig({ ...doc, runner: { ...(doc.runner ?? {}), enabled: true } });
  const project = Array.isArray(doc.projects) ? doc.projects.find((p: any) => p?.id === t.goal) : undefined;
  let repo = opt('--repo') || project?.repo;
  if (!repo) {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (top.status === 0) repo = top.stdout.trim();
  }
  const src = repoSource(repo);
  if (!src) die(`no repo for project ${t.goal}: pass --repo, run it inside the project's checkout, or set projects[].repo`);
  const families: Record<string, string> = doc.families && typeof doc.families === 'object' ? doc.families : {};
  const other = otherTool(tool);
  const reviewerActor = `${other}@${machine}`;
  const noReviewer = !which(other) ? `${TOOL_NAME[other]} is not installed here` : familyOf(reviewerActor, families) === familyOf(author, families) ? `${reviewerActor} is the same model family as ${author}` : '';
  const viewsDir = specViewsDir(dasksHome());
  for (const d of cleanStaleCliViews(viewsDir, alive)) console.log(`dask spec: removed a view a stopped run left: ${d}`);
  const view = openRepoView(src!, viewsDir, specCacheDir(dasksHome()), card, which('gh'), `cli-${process.pid}-`);
  // A stop (Ctrl-C, SIGTERM) ends the running agent's whole process group, waits for it, then removes the view.
  let agent: Supervised | null = null, stopping = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (stopping) return; stopping = true;
    console.error(`dask spec: ${sig}: stopping the agent and removing the view`);
    void (async () => {
      if (agent) { agent.stop(`dask spec ${sig}`); await agent.done.catch(() => {}); }
      closeRepoView(view.repo, view.dir);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    })();
  };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  console.log(`dask spec: read-only view of ${view.label} at ${view.base} (${view.sha.slice(0, 12)})${view.note ? `; ${view.note}` : ''}`);
  const logDir = path.join(dasksHome(), 'runs'); fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  try {
    const out = await specLoop({
      card, title: t.title ?? '', goal: t.goal, lane: t.lane, cardText: t.body ?? '', view, drafter: tool, author,
      reviewer: noReviewer ? null : { tool: other, actor: reviewerActor }, noReviewer, families, preset,
      api, log: (l) => console.log(l),
      run: async (who, prompt, label) => {
        const c = agentCommand(who, 'spec', { model: cfg.model, prompt, dir: view.dir, session: '' });
        console.log(`dask spec: ${TOOL_NAME[who]} ${label}…`);
        if (stopping) return { code: null, stopped: 'dask spec was stopped', raw: '', text: '' };
        const s = supervise({ cmd: c.cmd, args: c.args, cwd: view.dir, env: { ...process.env, DASK_TOOL: who, DASK_SESSION: 'spec' }, logFile: path.join(logDir, `${card}-spec-${stamp}.${label}.log`), cardStart: Date.now(), limits: cfg });
        agent = s;
        const res = await s.done;
        agent = null;
        return { ...res, text: agentText(res.raw) };
      },
    });
    await api('POST', `/api/tasks/${card}`, { note: out.note }).catch((e) => console.error(`dask spec: note not written (${e.message})`));
    console.log(out.note);
    process.exitCode = out.state === 'ready' ? 0 : 3;
  } finally { closeRepoView(view.repo, view.dir); }
}

main().catch((e) => die(e?.message || String(e)));
