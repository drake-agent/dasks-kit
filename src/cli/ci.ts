// dasks-ci: runs your GitHub Actions jobs on your own Macs as self-hosted runners (docs/ci-runners.md). Several runners
// per Mac, sized to its cores and RAM, with a machine-wide cap on jobs at once. macOS only; runners run as you through
// the official actions/runner and its svc.sh LaunchAgent. No containers, no isolation.
//   dasks-ci plan [--host H] [--cpu-per-job N] [--ram-per-job GB] [--reserve GB]
//   dasks-ci add --repo OWNER/NAME [--host H] [--count N|auto] [--labels a,b] [--max-jobs N] [--allow-public-repo] [--dry-run]
//   dasks-ci list [--repo OWNER/NAME] [--host H]
//   dasks-ci remove --repo OWNER/NAME [--host H] [--name RUNNER] [--dry-run]
// --host is an ssh host alias (ssh -o BatchMode=yes); without it the command works on this Mac. Needs gh, logged in
// with admin rights on the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import {
  DELETE_DIRS, INSTALL, LABEL_RE, NAME_RE, PLAN_DEFAULTS, REMOVE, REPO_RE, SURVEY, parseFacts, planJobs, releaseAsset, remoteCommand,
  runnerArch, runnerNames, type PlanOptions,
} from '../lib/ci-runners.ts';

const ONLINE_WAIT_SEC = Number(process.env.DASKS_CI_ONLINE_WAIT_SEC) || 180;
const POLL_SEC = Number(process.env.DASKS_CI_POLL_SEC) || 5;

class Refusal extends Error { code: number; constructor(msg: string, code = 2) { super(msg); this.code = code; } }

// ---------- arguments ----------

type Args = { cmd: string; flags: Record<string, string | true> };
const VALUED = new Set(['--host', '--repo', '--count', '--labels', '--max-jobs', '--name', '--cpu-per-job', '--ram-per-job', '--reserve']);
const BOOL = new Set(['--dry-run', '--allow-public-repo']);
const ALLOWED: Record<string, string[]> = {
  plan: ['--host', '--cpu-per-job', '--ram-per-job', '--reserve'],
  add: ['--host', '--repo', '--count', '--labels', '--max-jobs', '--allow-public-repo', '--dry-run', '--cpu-per-job', '--ram-per-job', '--reserve'],
  list: ['--repo', '--host'],
  remove: ['--host', '--repo', '--name', '--dry-run'],
};

export function parseArgs(argv: string[]): Args {
  const [cmd = '', ...rest] = argv;
  if (!ALLOWED[cmd]) throw new Refusal(`unknown command "${cmd}" (plan, add, list, remove; --help)`);
  const flags: Args['flags'] = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!ALLOWED[cmd].includes(a)) throw new Refusal(`${cmd}: unknown option ${a} (${ALLOWED[cmd].join(', ')})`);
    if (BOOL.has(a)) flags[a] = true;
    else if (VALUED.has(a)) { const v = rest[++i]; if (v === undefined || v.startsWith('--')) throw new Refusal(`${a} needs a value`); flags[a] = v; }
  }
  return { cmd, flags };
}
const str = (a: Args, k: string) => (typeof a.flags[k] === 'string' ? a.flags[k] as string : undefined);
function posInt(a: Args, k: string): number | undefined {
  const v = str(a, k); if (v === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(v)) throw new Refusal(`${k} must be a whole number of 1 or more`);
  return Number(v);
}
function planOptions(a: Args): PlanOptions {
  return { cpu_per_job: posInt(a, '--cpu-per-job') ?? PLAN_DEFAULTS.cpu_per_job, ram_per_job_gb: posInt(a, '--ram-per-job') ?? PLAN_DEFAULTS.ram_per_job_gb, reserve_gb: reserveArg(a) };
}
function reserveArg(a: Args): number {
  const v = str(a, '--reserve'); if (v === undefined) return PLAN_DEFAULTS.reserve_gb;
  if (!/^[0-9]+$/.test(v)) throw new Refusal('--reserve must be a whole number of GB');
  return Number(v);
}
function repoArg(a: Args, required: boolean): string | undefined {
  const r = str(a, '--repo');
  if (!r) { if (required) throw new Refusal('--repo OWNER/NAME is required'); return undefined; }
  if (!REPO_RE.test(r)) throw new Refusal(`--repo must look like owner/name (got ${r})`);
  return r;
}
function hostArg(a: Args): string | undefined {
  const h = str(a, '--host');
  if (h !== undefined && !/^[A-Za-z0-9_.@-]+$/.test(h)) throw new Refusal(`--host must be an ssh host alias (got ${h})`);
  return h;
}

// ---------- running on a host ----------

/** This process's env without what would make a shell trace commands or read startup files. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['SHELLOPTS', 'BASHOPTS', 'BASH_ENV', 'ENV', 'PS4']) delete env[k];
  return env;
}

/**
 * A script on the host: locally with bash, else over ssh. A secret goes to its stdin as the first line; its output is
 * always captured and the secret blanked out before anything is printed (`show` prints it after the run).
 */
function onHost(host: string | undefined, script: string, args: string[], opt: { secret?: string; show?: boolean } = {}) {
  const o: SpawnSyncOptions = { encoding: 'utf8', input: opt.secret ? opt.secret + '\n' : '', stdio: 'pipe', maxBuffer: 64 << 20, env: cleanEnv() };
  const r = host
    ? spawnSync('ssh', ['-o', 'BatchMode=yes', host, remoteCommand(script, args)], o)
    : spawnSync('bash', ['--noprofile', '--norc', '-c', script, 'dasks-ci', ...args], o);
  if (r.error) throw new Error(`${host ? 'ssh' : 'bash'}: ${r.error.message}`);
  const blank = (s: unknown) => (opt.secret ? String(s ?? '').replaceAll(opt.secret, '[token]') : String(s ?? ''));
  const out = { status: r.status ?? 1, stdout: blank(r.stdout), stderr: blank(r.stderr) };
  if (opt.show) { process.stdout.write(out.stdout); process.stderr.write(out.stderr); }
  return out;
}

type Survey = { facts: ReturnType<typeof parseFacts>; dirs: { name: string; state: string; repo: string }[]; cacheSha?: string; max?: number };
function survey(host: string | undefined, tarball = ''): Survey {
  const r = onHost(host, SURVEY, tarball ? [tarball] : []);
  if (r.status !== 0) throw new Error(`could not read ${where(host)}: ${(r.stderr || r.stdout).trim()}`);
  const out: Partial<Survey> = { dirs: [] };
  for (const line of r.stdout.split('\n')) {
    const [kind, ...f] = line.split('\t');
    if (kind === 'facts') out.facts = parseFacts(f[0], f[1] ?? '');
    else if (kind === 'dir') out.dirs!.push({ name: f[0], state: f[1], repo: f[2] ?? '' });
    else if (kind === 'cache') out.cacheSha = f[0];
    else if (kind === 'max') out.max = Number(f[0]) || undefined;
  }
  if (!out.facts) throw new Error(`could not read cores and RAM of ${where(host)}`);
  return out as Survey;
}
const where = (host?: string) => (host ? `host ${host}` : 'this Mac');
const hostLabel = (host?: string) => host ?? os.hostname().split('.')[0];

// ---------- GitHub ----------

function gh(args: string[], what: string): string {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`gh is needed (${r.error.message}); install it and run gh auth login`);
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}
const ghJson = (args: string[], what: string) => JSON.parse(gh(args, what));

/** A token for config.sh. It stays in memory and travels only on the host script's stdin. */
function runnerToken(repo: string, kind: 'registration-token' | 'remove-token'): string {
  const t = ghJson(['api', '-X', 'POST', `repos/${repo}/actions/runners/${kind}`], `getting a ${kind.replace('-', ' ')}`).token;
  if (typeof t !== 'string' || !t) throw new Error(`GitHub returned no ${kind.replace('-', ' ')}`);
  return t;
}

type ApiRunner = { id: number; name: string; status: string; busy: boolean; labels: { name: string }[] };
function apiRunners(repo: string): ApiRunner[] {
  const all: ApiRunner[] = [];
  for (let page = 1; ; page++) {
    const r = ghJson(['api', `repos/${repo}/actions/runners?per_page=100&page=${page}`], `listing the runners of ${repo}`);
    const rs: ApiRunner[] = r.runners ?? [];
    all.push(...rs);
    if (rs.length < 100) return all;
  }
}

const PUBLIC_WHY = [
  'GitHub warns against self-hosted runners on public repos: anyone can open a pull request from a fork, and a workflow',
  'it triggers can run that code on your Mac, as you, with your files and logins. Use a private repo, or pass',
  '--allow-public-repo if you have locked down which events and forks may run workflows.',
].join('\n');

function checkRepo(repo: string, allowPublic: boolean) {
  const r = ghJson(['api', `repos/${repo}`], `reading ${repo}`);
  const isPublic = r.visibility === 'public' || r.private === false;
  if (isPublic && !allowPublic) throw new Refusal(`${repo} is a public repo; not adding runners.\n${PUBLIC_WHY}`);
  if (isPublic) console.log(`note: ${repo} is public; runners added because of --allow-public-repo`);
}

const CACHE = () => path.join(os.homedir(), '.dasks', 'ci-runners', '.cache');
const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The tarball in this Mac's cache, downloaded and checked against the release's published SHA-256 when missing. */
function fetchTarball(asset: { id: number; name: string; sha: string }): string {
  const dir = CACHE();
  const file = path.join(dir, asset.name);
  if (fs.existsSync(file) && sha256(file) === asset.sha) return file;
  fs.mkdirSync(dir, { recursive: true });
  const part = file + '.part';
  const fd = fs.openSync(part, 'w');
  try {
    console.log(`downloading ${asset.name}`);
    const r = spawnSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/actions/runner/releases/assets/${asset.id}`], { stdio: ['ignore', fd, 'pipe'] });
    if (r.status !== 0) throw new Error(`downloading ${asset.name} failed: ${String(r.stderr ?? r.error ?? '').trim()}`);
  } finally { fs.closeSync(fd); }
  const got = sha256(part);
  if (got !== asset.sha) { fs.rmSync(part, { force: true }); throw new Error(`${asset.name}: SHA-256 ${got} does not match the published ${asset.sha}; deleted, nothing installed`); }
  fs.renameSync(part, file);
  return file;
}

/** Copy the tarball into the host's cache over ssh stdin (only when its copy differs). */
function shipTarball(host: string, file: string, name: string) {
  const dst = `"$HOME/.dasks/ci-runners/.cache/${name}"`;
  const fd = fs.openSync(file, 'r');
  try {
    console.log(`copying ${name} to ${host}`);
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', host, `mkdir -p "$HOME/.dasks/ci-runners/.cache" && cat > ${dst}.part && mv ${dst}.part ${dst}`], { stdio: [fd, 'inherit', 'inherit'], env: cleanEnv() });
    if (r.status !== 0) throw new Error(`copying ${name} to ${host} failed`);
  } finally { fs.closeSync(fd); }
}

// ---------- commands ----------

function cmdPlan(a: Args) {
  const host = hostArg(a);
  const o = planOptions(a);
  const f = survey(host).facts;
  const p = planJobs(f, o);
  console.log(`${where(host)}: ${f.cores} cores, ${f.ram_gb} GB RAM (${f.arch})`);
  console.log(`cpu: ${f.cores} / ${o.cpu_per_job} per job = ${p.by_cpu}; ram: (${f.ram_gb} - ${o.reserve_gb} reserve) / ${o.ram_per_job_gb} per job = ${p.by_ram}`);
  console.log(`jobs at once: ${p.jobs}`);
}

async function cmdAdd(a: Args) {
  const repo = repoArg(a, true)!;
  const host = hostArg(a);
  const dry = a.flags['--dry-run'] === true;
  const labelsIn = (str(a, '--labels') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const l of labelsIn) if (!LABEL_RE.test(l)) throw new Refusal(`label "${l}" may hold only letters, digits, . _ -`);
  const countIn = str(a, '--count') ?? 'auto';
  if (countIn !== 'auto' && !/^[1-9][0-9]*$/.test(countIn)) throw new Refusal('--count must be a number of 1 or more, or auto');
  const maxJobs = posInt(a, '--max-jobs');
  checkRepo(repo, a.flags['--allow-public-repo'] === true);

  const s = survey(host);
  const plan = planJobs(s.facts, planOptions(a));
  const count = countIn === 'auto' ? plan.jobs : Number(countIn);
  const label = hostLabel(host);
  const names = runnerNames(label, repo, count);
  const labels = [...new Set([label, ...labelsIn])].join(',');
  const max = maxJobs ?? plan.jobs;
  const dirs = new Map(s.dirs.map((d) => [d.name, d]));
  const foreign = names.filter((n) => { const r = dirs.get(n)?.repo; return r && r !== repo; });
  if (foreign.length) throw new Refusal(`${foreign.map((n) => `${n} belongs to ${dirs.get(n)!.repo}`).join(', ')}; not touching it. Remove it first, or pick another --host.`);

  console.log(`${where(host)}: ${count} runner(s) for ${repo}, labels self-hosted, macOS, ${labels}`);
  for (const n of names) {
    const d = dirs.get(n);
    console.log(`  ${n}: ${d?.state === 'configured' ? 'configured already: skipped (service checked)' : d ? 'half made: finished' : 'new'}`);
  }
  const maxNote = maxJobs ? `set to ${max}` : s.max ? `kept at ${s.max}` : `set to ${max} (plan)`;
  console.log(`machine-wide job cap (~/.dasks/ci-slots/max): ${maxNote}`);
  if (dry) { console.log('Dry run: nothing was changed.'); return; }

  const todo = names.filter((n) => dirs.get(n)?.state !== 'configured');
  let tarball = '', sha = '';
  if (todo.length) {
    const rel = ghJson(['api', 'repos/actions/runner/releases/latest'], 'reading the latest actions/runner release');
    const asset = releaseAsset(rel, runnerArch(s.facts.arch));
    const file = fetchTarball(asset);
    tarball = asset.name; sha = asset.sha;
    if (host && survey(host, asset.name).cacheSha !== asset.sha) shipTarball(host, file, asset.name);
  }
  const token = todo.length ? runnerToken(repo, 'registration-token') : '';
  const r = onHost(host, INSTALL, [repo, tarball, sha, labels, String(max), maxJobs ? '1' : '0', ...names], { secret: token, show: true });
  if (r.status !== 0) throw new Refusal('some runners were not installed (see above); run the same command again to finish them', 1);

  console.log(`waiting for ${names.length} runner(s) to come online`);
  const t0 = Date.now();
  for (;;) {
    const online = new Set(apiRunners(repo).filter((x) => x.status === 'online').map((x) => x.name));
    const left = names.filter((n) => !online.has(n));
    if (!left.length) { console.log(`online: ${names.join(', ')}`); return; }
    if (Date.now() - t0 > ONLINE_WAIT_SEC * 1000) throw new Refusal(`not online after ${ONLINE_WAIT_SEC}s: ${left.join(', ')} (is the Mac's user logged in? LaunchAgents run in the login session)`, 1);
    await new Promise((res) => setTimeout(res, POLL_SEC * 1000));
  }
}

function cmdList(a: Args) {
  let repos: string[];
  const repo = repoArg(a, false);
  if (repo) repos = [repo];
  else {
    repos = [...new Set(survey(hostArg(a)).dirs.map((d) => d.repo).filter((r) => REPO_RE.test(r)))];
    if (!repos.length) { console.log(`no runners on ${where(hostArg(a))}; pass --repo to list a repo's runners`); return; }
  }
  for (const r of repos) {
    const rs = apiRunners(r);
    console.log(`${r}: ${rs.length} runner(s)`);
    for (const x of rs) console.log(`  ${x.name.padEnd(32)} ${x.status.padEnd(8)} ${(x.busy ? 'busy' : 'idle').padEnd(5)} ${x.labels.map((l) => l.name).join(',')}`);
  }
}

function cmdRemove(a: Args) {
  const repo = repoArg(a, true)!;
  const host = hostArg(a);
  const only = str(a, '--name');
  if (only !== undefined && !NAME_RE.test(only)) throw new Refusal(`--name must be a runner name (got ${only})`);
  const dirs = survey(host).dirs.filter((d) => d.repo === repo && (!only || d.name === only));
  if (!dirs.length) throw new Refusal(`no runners of ${repo}${only ? ` named ${only}` : ''} on ${where(host)}`, 1);
  console.log(`${where(host)}: removing ${dirs.map((d) => d.name).join(', ')} (stop and uninstall the service, unregister, delete the dir)`);
  if (a.flags['--dry-run'] === true) { console.log('Dry run: nothing was changed.'); return; }
  const names = dirs.map((d) => d.name);
  const token = runnerToken(repo, 'remove-token');
  const r = onHost(host, REMOVE, [repo, ...names], { secret: token });
  process.stdout.write(r.stdout.split('\n').filter((l) => !l.startsWith('DASKS-CI-KEPT ')).join('\n'));
  process.stderr.write(r.stderr);
  const kept = r.stdout.split('\n').filter((l) => l.startsWith('DASKS-CI-KEPT ')).map((l) => l.slice(14).trim());
  if (!kept.length) { if (r.status !== 0) throw new Refusal('remove did not finish (see above)', 1); return; }
  // config.sh remove failed (often: the runner was already deleted on GitHub). Delete it by API, then the dirs.
  const byName = new Map(apiRunners(repo).map((x) => [x.name, x]));
  const gone: string[] = [];
  for (const n of kept) {
    const x = byName.get(n);
    if (x) {
      const d = spawnSync('gh', ['api', '-X', 'DELETE', `repos/${repo}/actions/runners/${x.id}`], { encoding: 'utf8' });
      if (d.status !== 0) { console.error(`${n}: could not unregister it (${(d.stderr || '').trim()}); its dir is kept`); continue; }
    }
    gone.push(n);
  }
  if (gone.length) process.stdout.write(onHost(host, DELETE_DIRS, gone).stdout);
  if (gone.length < kept.length) throw new Refusal('some runners were kept (see above)', 1);
  if (/runner kept/.test(r.stderr)) throw new Refusal('some runners were kept (see above)', 1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    const lines = fs.readFileSync(import.meta.filename, 'utf8').split('\n');
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const a = parseArgs(argv);
  if (a.cmd === 'plan') cmdPlan(a);
  else if (a.cmd === 'add') await cmdAdd(a);
  else if (a.cmd === 'list') cmdList(a);
  else cmdRemove(a);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().catch((e) => { console.error(`dasks-ci: ${e?.message || e}`); process.exit(e instanceof Refusal ? e.code : 1); });
}
