// dasks-ci with fake gh, ssh, sysctl and a fake runner tarball; a temp HOME for this Mac and another for the ssh host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { HOOK, planJobs, releaseAsset, remoteCommand, runnerNames } from '../src/lib/ci-runners.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin/dasks-ci');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exe = (file: string, body: string) => fs.writeFileSync(file, body, { mode: 0o755 });

// ---------- unit ----------

test('plan: the smaller of cores and RAM after the reserve, at least 1', () => {
  assert.deepEqual(planJobs({ cores: 10, ram_gb: 32 }), { by_cpu: 5, by_ram: 9, jobs: 5 });
  assert.deepEqual(planJobs({ cores: 24, ram_gb: 16 }), { by_cpu: 12, by_ram: 4, jobs: 4 });
  assert.equal(planJobs({ cores: 1, ram_gb: 4 }).jobs, 1, 'a small Mac still runs one job');
  assert.equal(planJobs({ cores: 10, ram_gb: 32 }, { cpu_per_job: 1, ram_per_job_gb: 2, reserve_gb: 8 }).jobs, 10);
});

test('names, release asset and checksum, remote command quoting', () => {
  assert.deepEqual(runnerNames('Mac2.local', 'you/My_App', 2), ['mac2-local-you-my-app-1', 'mac2-local-you-my-app-2']);
  const sha = 'a'.repeat(64);
  const rel = { tag_name: 'v9', body: `x\n<!-- BEGIN SHA osx-arm64 -->${sha}<!-- END SHA osx-arm64 -->\n`, assets: [{ id: 7, name: 'actions-runner-osx-arm64-9.1.0.tar.gz' }, { id: 8, name: 'actions-runner-osx-x64-9.1.0.tar.gz', digest: `sha256:${'b'.repeat(64)}` }] };
  assert.deepEqual(releaseAsset(rel, 'arm64'), { id: 7, name: 'actions-runner-osx-arm64-9.1.0.tar.gz', sha });
  assert.equal(releaseAsset(rel, 'x64').sha, 'b'.repeat(64), 'the asset digest when the notes have none');
  assert.throws(() => releaseAsset({ ...rel, body: '', assets: [rel.assets[0]] }, 'arm64'), /no SHA-256/);
  const r = spawnSync('/bin/sh', ['-c', remoteCommand('printf "%s|" "$@"', ["it's", 'a b', '$HOME'])], { encoding: 'utf8' });
  assert.equal(r.stdout, "it's|a b|$HOME|");
});

// ---------- the CLI against fakes ----------

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-ci-'));
  const d = { base, home: path.join(base, 'home'), remote: path.join(base, 'remote'), state: path.join(base, 'state'), bin: path.join(base, 'bin'), pkg: path.join(base, 'pkg') };
  for (const p of [d.home, d.remote, d.state, d.bin, d.pkg]) fs.mkdirSync(p);
  const token = 'REGTOKEN' + crypto.randomBytes(8).toString('hex');
  const removeToken = 'RMTOKEN' + crypto.randomBytes(8).toString('hex');
  // The runner package: config.sh checks the token arrived in its env and records its argv; svc.sh records calls.
  exe(path.join(d.pkg, 'config.sh'), `#!/bin/bash
S="$FAKE_STATE"; printf '%s\\n' "$*" >> "$S/config.args"
if [ "$1" = remove ]; then
  [ "$ACTIONS_RUNNER_INPUT_TOKEN" = "$FAKE_REMOVE_TOKEN" ] || { echo "wrong removal token" >&2; exit 1; }
  n=$(cat .name); grep -vx "$n" "$S/registered" > "$S/registered.tmp"; mv "$S/registered.tmp" "$S/registered"; rm -f .runner; exit 0
fi
[ "$ACTIONS_RUNNER_INPUT_TOKEN" = "$FAKE_TOKEN" ] || { echo "wrong registration token" >&2; exit 1; }
while [ $# -gt 0 ]; do case $1 in --name) n=$2; shift ;; --labels) l=$2; shift ;; esac; shift; done
echo "$n" >> "$S/registered"; echo "$n $l" >> "$S/labels"; echo "$n" > .name; echo '{}' > .runner; echo LANG=en_US.UTF-8 > .env
`);
  exe(path.join(d.pkg, 'svc.sh'), `#!/bin/bash
echo "$(basename "$PWD") $1" >> "$FAKE_STATE/svc.log"
p="$HOME/Library/LaunchAgents/actions.runner.$(basename "$PWD").plist"
case $1 in
  install) mkdir -p "$(dirname "$p")"; touch "$p"; echo "$p" > .service ;;
  uninstall) [ -n "$FAKE_SVC_FAIL" ] && exit 1; rm -f "$p" .service ;;
esac
`);
  exe(path.join(d.pkg, 'run.sh'), '#!/bin/bash\n');
  const tgz = path.join(d.state, 'runner.tgz');
  spawnSync('tar', ['-czf', tgz, '-C', d.pkg, '.']);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  const assets = ['arm64', 'x64'].map((a, i) => ({ id: i + 1, name: `actions-runner-osx-${a}-9.1.0.tar.gz` }));
  const body = ['arm64', 'x64'].map((a) => `<!-- BEGIN SHA osx-${a} -->${sha}<!-- END SHA osx-${a} -->`).join('\n');
  fs.writeFileSync(path.join(d.state, 'release.json'), JSON.stringify({ tag_name: 'v9.1.0', body, assets }));
  fs.writeFileSync(path.join(d.state, 'registered'), '');
  exe(path.join(d.bin, 'gh'), `#!/bin/bash
S="$FAKE_STATE"; printf '%s\\n' "$*" >> "$S/gh.args"
case "$*" in
  "api repos/you/site") echo '{"private":false,"visibility":"public"}' ;;
  "api repos/actions/runner/releases/latest") cat "$S/release.json" ;;
  *releases/assets/*) cat "$S/runner.tgz" ;;
  *registration-token) printf '{"token":"%s"}\\n' "$FAKE_TOKEN" ;;
  *remove-token) printf '{"token":"%s"}\\n' "$FAKE_REMOVE_TOKEN" ;;
  *actions/runners\\?*)
    printf '{"runners":['; sep=
    while read -r n; do [ -n "$n" ] && printf '%s{"id":1,"name":"%s","status":"online","busy":false,"labels":[{"name":"self-hosted"}]}' "$sep" "$n" && sep=,; done < "$S/registered"
    echo ']}' ;;
  "api repos/"*) echo '{"private":true,"visibility":"private"}' ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`);
  exe(path.join(d.bin, 'ssh'), `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_STATE/ssh.args"
while [ $# -gt 0 ]; do case $1 in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
export HOME="$FAKE_REMOTE_HOME"
# FAKE_REMOTE_SHELLOPTS: the host's login shell traces commands
exec env \${FAKE_REMOTE_SHELLOPTS:+SHELLOPTS=$FAKE_REMOTE_SHELLOPTS} /bin/sh -c "$*"
`);
  // launchd: FAKE_NO_GUI = nobody logged in at the screen; FAKE_BOOTSTRAP_NOOP = bootstrap says yes but loads nothing.
  exe(path.join(d.bin, 'launchctl'), `#!/bin/bash
S="$FAKE_STATE"; L="$S/launchd"
loaded() { [ -f "$L" ] && grep -qx "$1" "$L"; }
case $1 in
  print)
    [ -n "$FAKE_NO_GUI" ] && { echo "Could not print domain: 125: Domain does not support specified action" >&2; exit 125; }
    case $2 in "gui/$(id -u)") exit 0 ;; "gui/$(id -u)/"*) loaded "\${2##*/}"; exit ;; *) exit 1 ;; esac ;;
  bootstrap)
    echo "$*" >> "$S/launchctl.log"
    [ "$2" = "gui/$(id -u)" ] && [ -f "$3" ] || exit 5
    l=$(basename "$3" .plist); loaded "$l" && exit 5
    [ -n "$FAKE_BOOTSTRAP_NOOP" ] || echo "$l" >> "$L" ;;
  bootout)
    echo "$*" >> "$S/launchctl.log"
    loaded "\${2##*/}" || exit 3
    grep -vx "\${2##*/}" "$L" > "$L.tmp"; mv "$L.tmp" "$L" ;;
  *) echo "$*" >> "$S/launchctl.log" ;;
esac
`);
  exe(path.join(d.bin, 'sysctl'), '#!/bin/bash\necho "${FAKE_NCPU:-10}"; echo "${FAKE_MEM:-34359738368}"\n');
  const env = {
    ...process.env, HOME: d.home, PATH: `${d.bin}:${process.env.PATH}`, FAKE_STATE: d.state, FAKE_REMOTE_HOME: d.remote,
    FAKE_TOKEN: token, FAKE_REMOVE_TOKEN: removeToken, DASKS_CI_POLL_SEC: '0.2', DASKS_CI_ONLINE_WAIT_SEC: '10',
  };
  const runEnv = (extra: Record<string, string>, ...args: string[]) => {
    const r = spawnSync(CLI, args, { env: { ...env, ...extra }, encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const run = (...args: string[]) => runEnv({}, ...args);
  const read = (f: string) => { try { return fs.readFileSync(path.join(d.state, f), 'utf8'); } catch { return ''; } };
  return { d, run, runEnv, read, token, removeToken, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** Every file under dir with its contents (to prove nothing changed, or to look for a string). */
function tree(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f); else m.set(f, e.isFile() ? fs.readFileSync(f, 'latin1') : '');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return m;
}

test('plan over ssh reads the host, not this Mac', () => {
  const s = setup();
  try {
    const r = s.run('plan', '--host', 'mac2');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /host mac2: 10 cores, 32 GB RAM/);
    assert.match(r.out, /jobs at once: 5/);
    assert.match(s.read('ssh.args'), /^-o BatchMode=yes mac2 /m);
  } finally { s.cleanup(); }
});

test('add over ssh: runners installed with hooks and the cap; the token never shows in argv, output or files', () => {
  const s = setup();
  try {
    const r = s.run('add', '--repo', 'you/app', '--host', 'mac2', '--count', '2', '--labels', 'big,fast');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /online: mac2-you-app-1, mac2-you-app-2/);
    const R = path.join(s.d.remote, '.dasks/ci-runners');
    for (const n of ['mac2-you-app-1', 'mac2-you-app-2']) {
      assert.ok(fs.existsSync(path.join(R, n, '.runner')));
      assert.ok(fs.existsSync(path.join(R, n, '.service')), 'service installed');
      const env = fs.readFileSync(path.join(R, n, '.env'), 'utf8');
      assert.match(env, /^LANG=en_US.UTF-8$/m, 'the runner\'s own .env lines stay');
      assert.match(env, /^ACTIONS_RUNNER_HOOK_JOB_STARTED=.*\/\.dasks\/ci-slots\/hooks\/job-started\.sh$/m);
      assert.match(env, /^ACTIONS_RUNNER_HOOK_JOB_COMPLETED=.*\/\.dasks\/ci-slots\/hooks\/job-completed\.sh$/m);
    }
    assert.equal(s.read('labels'), 'mac2-you-app-1 mac2,big,fast\nmac2-you-app-2 mac2,big,fast\n');
    assert.equal(fs.readFileSync(path.join(s.d.remote, '.dasks/ci-slots/max'), 'utf8').trim(), '5', 'cap defaults to the plan');
    assert.ok(fs.existsSync(path.join(s.d.home, '.dasks/ci-runners/.cache/actions-runner-osx-arm64-9.1.0.tar.gz')) || fs.existsSync(path.join(s.d.home, '.dasks/ci-runners/.cache/actions-runner-osx-x64-9.1.0.tar.gz')));
    assert.match(s.read('svc.log'), /mac2-you-app-1 install/);
    assert.doesNotMatch(s.read('svc.log'), / start$/m, 'started through launchctl in the login session, not svc.sh start');
    const uid = String(process.getuid!());
    assert.match(s.read('launchctl.log'), new RegExp(`^bootstrap gui/${uid} .*/Library/LaunchAgents/actions\\.runner\\.mac2-you-app-1\\.plist$`, 'm'));
    assert.match(s.read('launchctl.log'), new RegExp(`^kickstart gui/${uid}/actions\\.runner\\.mac2-you-app-1$`, 'm'));
    assert.equal(s.read('launchd'), 'actions.runner.mac2-you-app-1\nactions.runner.mac2-you-app-2\n');
    assert.match(r.out, /\(loaded in the login session\)/);
    // The token reached config.sh (it checks), and nowhere else.
    for (const t of [s.token]) {
      assert.ok(!r.out.includes(t), 'not in output');
      for (const f of ['ssh.args', 'gh.args', 'config.args']) assert.ok(!s.read(f).includes(t), `not in ${f}`);
      for (const [f, c] of [...tree(s.d.home), ...tree(s.d.remote), ...tree(s.d.state)]) assert.ok(!c.includes(t), `not in ${f}`);
    }
  } finally { s.cleanup(); }
});

test('add again: configured runners are skipped without a new token; a half-made dir is finished', () => {
  const s = setup();
  try {
    assert.equal(s.run('add', '--repo', 'you/app', '--count', '2').status, 0);
    const R = path.join(s.d.home, '.dasks/ci-runners');
    const [n1, n2, n3] = runnerNames(os.hostname().split('.')[0], 'you/app', 3);
    // A dir unpacked but never registered, as an interrupted run leaves it.
    fs.mkdirSync(path.join(R, n3));
    spawnSync('tar', ['-xzf', path.join(s.d.state, 'runner.tgz'), '-C', path.join(R, n3)]);
    fs.rmSync(path.join(R, n3, 'run.sh')); // cut short: part of the package is missing
    fs.writeFileSync(path.join(s.d.state, 'config.args'), '');
    fs.writeFileSync(path.join(s.d.state, 'gh.args'), '');
    const r = s.run('add', '--repo', 'you/app', '--count', '3');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`${n1}: already configured`));
    assert.match(r.out, new RegExp(`${n2}: already configured`));
    const cfg = s.read('config.args').trim().split('\n');
    assert.equal(cfg.length, 1, 'only the half-made runner registered');
    assert.match(cfg[0], new RegExp(`--name ${n3} `));
    assert.ok(fs.existsSync(path.join(R, n3, '.runner')));
    assert.ok(fs.existsSync(path.join(R, n3, 'run.sh')) && fs.existsSync(path.join(R, n3, '.dasks-unpacked')), 'an incomplete unpack is redone');

    fs.writeFileSync(path.join(s.d.state, 'gh.args'), '');
    assert.equal(s.run('add', '--repo', 'you/app', '--count', '3').status, 0);
    assert.doesNotMatch(s.read('gh.args'), /registration-token|releases/, 'nothing to register: no token, no download');
  } finally { s.cleanup(); }
});

test('a public repo is refused unless --allow-public-repo; dry runs change nothing', () => {
  const s = setup();
  try {
    const before = tree(s.d.base);
    const r = s.run('add', '--repo', 'you/site', '--host', 'mac2');
    assert.equal(r.status, 2);
    assert.match(r.out, /public repo/);
    assert.match(r.out, /fork/);
    assert.match(r.out, /--allow-public-repo/);
    const dry = s.run('add', '--repo', 'you/site', '--host', 'mac2', '--allow-public-repo', '--dry-run', '--max-jobs', '3');
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /mac2-you-site-1: new/);
    assert.match(dry.out, /Dry run: nothing was changed/);
    const after = tree(s.d.base);
    for (const f of ['gh.args', 'ssh.args']) { before.delete(path.join(s.d.state, f)); after.delete(path.join(s.d.state, f)); }
    assert.deepEqual(after, before);
    assert.doesNotMatch(s.read('gh.args'), /-X POST|releases/);

    assert.equal(s.run('add', '--repo', 'you/app', '--host', 'mac2', '--count', '1').status, 0);
    const mid = tree(s.d.base);
    const rd = s.run('remove', '--repo', 'you/app', '--host', 'mac2', '--dry-run');
    assert.equal(rd.status, 0, rd.out);
    assert.match(rd.out, /removing mac2-you-app-1/);
    const end = tree(s.d.base);
    for (const f of ['gh.args', 'ssh.args']) { mid.delete(path.join(s.d.state, f)); end.delete(path.join(s.d.state, f)); }
    assert.deepEqual(end, mid);
  } finally { s.cleanup(); }
});

test('no login session on the host: add stops before registering anything', () => {
  const s = setup();
  try {
    const r = s.runEnv({ FAKE_NO_GUI: '1' }, 'add', '--repo', 'you/app', '--host', 'mac2', '--count', '1');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no login session for this user/);
    assert.match(r.out, /automatic login works/);
    assert.equal(s.read('registered'), '');
    assert.doesNotMatch(s.read('gh.args'), /registration-token|releases/);
    assert.equal(s.read('launchctl.log'), '');
    assert.ok(!fs.existsSync(path.join(s.d.remote, '.dasks/ci-runners')));
  } finally { s.cleanup(); }
});

test('online but not loaded in the login session is a failure; labels are kept once', () => {
  const s = setup();
  try {
    const r = s.runEnv({ FAKE_BOOTSTRAP_NOOP: '1' }, 'add', '--repo', 'you/app', '--host', 'mac2', '--count', '1', '--labels', 'macOS,x,X,mac2,self-hosted,arm64,x64');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /online, but not loaded in the login session.*: mac2-you-app-1/);
    assert.match(r.out, /labels self-hosted, macOS, (ARM64, mac2, x, x64|X64, mac2, x, arm64)\n/);
    // Only this Mac's own architecture label is GitHub's; the other one stays a label of yours.
    assert.equal(s.read('labels'), `mac2-you-app-1 mac2,x,${process.arch === 'arm64' ? 'x64' : 'arm64'}\n`);
  } finally { s.cleanup(); }
});

test('remove: service uninstalled, unregistered with a removal token on stdin, dir deleted', () => {
  const s = setup();
  try {
    assert.equal(s.run('add', '--repo', 'you/app', '--host', 'mac2', '--count', '2').status, 0);
    const r = s.run('remove', '--repo', 'you/app', '--host', 'mac2', '--name', 'mac2-you-app-2');
    assert.equal(r.status, 0, r.out);
    const R = path.join(s.d.remote, '.dasks/ci-runners');
    assert.ok(!fs.existsSync(path.join(R, 'mac2-you-app-2')));
    assert.ok(fs.existsSync(path.join(R, 'mac2-you-app-1')), 'only the named runner');
    assert.match(s.read('svc.log'), /mac2-you-app-2 stop\nmac2-you-app-2 uninstall/);
    assert.match(s.read('launchctl.log'), new RegExp(`^bootout gui/${process.getuid!()}/actions\\.runner\\.mac2-you-app-2$`, 'm'));
    assert.equal(s.read('launchd'), 'actions.runner.mac2-you-app-1\n', 'only the removed one unloaded');
    assert.equal(s.read('registered').trim(), 'mac2-you-app-1');
    assert.ok(!r.out.includes(s.removeToken) && !s.read('ssh.args').includes(s.removeToken));
    const l = s.run('list', '--host', 'mac2');
    assert.match(l.out, /you\/app: 1 runner\(s\)\n {2}mac2-you-app-1 +online +idle/);
  } finally { s.cleanup(); }
});

test('a shell that traces commands (SHELLOPTS=xtrace) never shows the tokens, here or on the ssh host', () => {
  for (const host of [[], ['--host', 'mac2']]) {
    const s = setup();
    try {
      const traced = { SHELLOPTS: 'xtrace', FAKE_REMOTE_SHELLOPTS: 'xtrace' };
      const add = s.runEnv(traced, 'add', '--repo', 'you/app', ...host, '--count', '1');
      assert.equal(add.status, 0, add.out);
      const rm = s.runEnv(traced, 'remove', '--repo', 'you/app', ...host);
      assert.equal(rm.status, 0, rm.out);
      assert.equal(s.read('registered').trim(), '', 'registered and removed, so both tokens were used');
      for (const t of [s.token, s.removeToken]) {
        assert.ok(!add.out.includes(t) && !rm.out.includes(t), `not in output (${host.join(' ') || 'local'})`);
        for (const [f, c] of [...tree(s.d.home), ...tree(s.d.remote), ...tree(s.d.state)]) assert.ok(!c.includes(t), `not in ${f}`);
      }
    } finally { s.cleanup(); }
  }
});

test('same repo name under two owners: separate runners; a dir of another repo is never taken over', () => {
  const s = setup();
  try {
    assert.equal(s.run('add', '--repo', 'alice/app', '--host', 'mac2', '--count', '1').status, 0);
    const r = s.run('add', '--repo', 'bob/app', '--host', 'mac2', '--count', '1');
    assert.equal(r.status, 0, r.out);
    assert.equal(s.read('registered'), 'mac2-alice-app-1\nmac2-bob-app-1\n');
    const R = path.join(s.d.remote, '.dasks/ci-runners');
    assert.equal(fs.readFileSync(path.join(R, 'mac2-bob-app-1/.dasks-repo'), 'utf8').trim(), 'bob/app');
    // A dir under the name this repo would use, made for another repo (by hand, or by an older version).
    fs.mkdirSync(path.join(R, 'mac2-carol-app-1'));
    fs.writeFileSync(path.join(R, 'mac2-carol-app-1/.dasks-repo'), 'someone/else\n');
    const bad = s.run('add', '--repo', 'carol/app', '--host', 'mac2', '--count', '1');
    assert.equal(bad.status, 2);
    assert.match(bad.out, /mac2-carol-app-1 belongs to someone\/else; not touching it/);
    assert.ok(!fs.existsSync(path.join(R, 'mac2-carol-app-1/.runner')));
    const long = runnerNames('a-very-long-host-name-for-a-mac', 'some-organization-name/a-repository-with-a-long-name', 12);
    assert.ok(long.every((n) => n.length <= 64), long[11]);
    const cut = (repo: string) => runnerNames('h', `some-organization-name/${repo}`, 1)[0];
    assert.notEqual(cut('a-repository-with-a-very-long-name-x'), cut('a-repository-with-a-very-long-name-y'), 'a cut name keeps repos apart');
  } finally { s.cleanup(); }
});

test('remove keeps a runner whose service would not uninstall', () => {
  const s = setup();
  try {
    assert.equal(s.run('add', '--repo', 'you/app', '--host', 'mac2', '--count', '1').status, 0);
    fs.writeFileSync(path.join(s.d.state, 'config.args'), '');
    const r = s.runEnv({ FAKE_SVC_FAIL: '1' }, 'remove', '--repo', 'you/app', '--host', 'mac2');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /did not remove the service; runner kept/);
    const d = path.join(s.d.remote, '.dasks/ci-runners/mac2-you-app-1');
    assert.ok(fs.existsSync(path.join(d, '.service')) && fs.existsSync(path.join(d, '.runner')), 'dir and service left');
    assert.equal(s.read('config.args'), '', 'not unregistered either');
    assert.equal(s.run('remove', '--repo', 'you/app', '--host', 'mac2').status, 0);
    assert.ok(!fs.existsSync(d));
  } finally { s.cleanup(); }
});

// ---------- the machine-wide slot hook ----------

test('slot hook: max jobs at once, a waiting job runs after the wait limit, a dead worker\'s slot is freed', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-ci-slot-'));
  try {
    const slots = path.join(base, '.dasks/ci-slots');
    fs.mkdirSync(slots, { recursive: true });
    fs.writeFileSync(path.join(slots, 'max'), '1\n');
    const hook = path.join(base, 'job-hook.sh');
    exe(hook, HOOK);
    // Stands in for the runner's Runner.Worker: runs the started hook, holds until told, runs the completed hook.
    const worker = path.join(base, 'Runner.Worker');
    exe(worker, `#!/bin/bash
"$HOOK" started; echo "$JOB started" >> "$OUT"
while [ -n "$HOLD" ] && [ ! -e "$HOLD" ]; do sleep 0.05; done
[ "$DONE" = 1 ] && "$HOOK" completed
exit 0
`);
    const out = path.join(base, 'out');
    const start = (job: string, extra: Record<string, string>) => {
      const p = spawn(worker, [], { env: { ...process.env, HOME: base, HOOK: hook, OUT: out, JOB: job, RUNNER_NAME: job, DASKS_CI_SLOT_POLL_SEC: '0.1', DASKS_CI_SLOT_WAIT_SEC: '30', DONE: '1', ...extra }, stdio: 'ignore' });
      return new Promise<void>((r) => p.on('exit', () => r()));
    };
    const started = () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '');
    const until = async (f: () => boolean, ms = 10_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(50); } };

    const a = start('a', { HOLD: path.join(base, 'go-a') });
    await until(() => started().includes('a started'));
    const b = start('b', { HOLD: path.join(base, 'go-b') });
    await sleep(800);
    assert.ok(!started().includes('b started'), 'b waits while a holds the only slot');
    assert.match(fs.readFileSync(path.join(slots, 'hook.log'), 'utf8'), /b waiting for a slot \(1\/1 busy/);
    fs.writeFileSync(path.join(base, 'go-a'), '');
    await a;
    await until(() => started().includes('b started'));

    // b holds the slot; c may wait 1 s, then runs anyway.
    await start('c', { DASKS_CI_SLOT_WAIT_SEC: '1' });
    assert.match(fs.readFileSync(path.join(slots, 'hook.log'), 'utf8'), /c no free slot after 1s \(1\/1 busy\); running anyway/);
    fs.writeFileSync(path.join(base, 'go-b'), '');
    await b;
    assert.deepEqual(fs.readdirSync(slots).filter((f) => f.startsWith('slot.')), [], 'every slot given back');

    // d dies without its completed hook: its slot is stale and e takes it at once.
    await start('d', { DONE: '0' });
    assert.equal(fs.readdirSync(slots).filter((f) => f.startsWith('slot.')).length, 1);
    const t0 = Date.now();
    await start('e', {});
    assert.ok(Date.now() - t0 < 5000);
    const log = fs.readFileSync(path.join(slots, 'hook.log'), 'utf8');
    assert.match(log, /e freed the stale slot of d/);
    assert.doesNotMatch(log, /e no free slot/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
