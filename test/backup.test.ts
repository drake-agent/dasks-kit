// Board data backup (src/lib/backup.ts, docs/upgrade.md): the server pushes the data repo's commits to backup.remote on
// one branch, fast-forward only, fails soft (a health warning and a `dasks check` line, never a 503) and never sends
// run/ or a secret. The remote in these tests is a local bare repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';
import { Backup, BACKUP_WARN_AFTER, backupConfigErrors, backupView, forbiddenPaths, pushArgs, remoteProblem, remoteShown } from '../src/lib/backup.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const bare = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-backup-remote-')); git(d, 'init', '-q', '--bare'); return d; };
const tip = (remote: string, branch: string) => { try { return git(remote, 'rev-parse', `refs/heads/${branch}`); } catch { return ''; } };
const commit = (root: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); git(root, 'add', '-f', rel); git(root, 'commit', '-qm', `edit ${rel}`); return git(root, 'rev-parse', 'HEAD'); };

test('config: a remote with a password, an ext:: remote or a bad branch is refused; push args are one fast-forward refspec', () => {
  assert.equal(remoteProblem('git@github.com:me/board-backup.git'), null);
  assert.equal(remoteProblem('/srv/backups/board.git'), null);
  assert.equal(remoteProblem('https://github.com/me/board-backup.git'), null);
  assert.match(remoteProblem(['https://me', 'p'.repeat(8)].join(':') + '@github.com/me/b.git')!, /password or token/);
  assert.match(remoteProblem('ext::sh -c touch% /tmp/x')!, /spaces|ext::/);
  assert.match(remoteProblem('ext::ssh')!, /remote helper/);
  assert.match(remoteProblem('--upload-pack=x')!, /must not start with -/);
  // Credentials in any spelling, and any remote helper, are refused (built from parts: no credential-shaped literal here).
  const tok = 'x'.repeat(12);
  assert.match(remoteProblem(`https://${tok}@github.com/me/b.git`)!, /user, password or token/, 'a token as the user name');
  assert.match(remoteProblem(['https::https://u', `${tok}@github.com/me/b.git`].join(':'))!, /remote helper/);
  assert.match(remoteProblem('https::https://github.com/me/b.git')!, /remote helper/);
  assert.match(remoteProblem('http://github.com/me/b.git')!, /must be https/);
  assert.match(remoteProblem('file:///srv/b.git')!, /must be https/);
  assert.match(remoteProblem('relative/path')!, /must be https/);
  assert.equal(remoteProblem('ssh://git@example.com/me/b.git'), null);
  assert.equal(remoteShown('ssh://git@example.com/me/b.git'), 'ssh://example.com/me/b.git');
  assert.equal(remoteShown('git@github.com:me/board-backup.git'), 'github.com:me/board-backup.git');
  assert.equal(remoteShown('https://github.com/me/b.git'), 'https://github.com/me/b.git');
  assert.deepEqual(backupConfigErrors({ remote: '' }), []);
  assert.deepEqual(backupConfigErrors({ remote: '/srv/b.git', every_min: 5, branch: 'boards/home' }), []);
  assert.equal(backupConfigErrors({ remote: '/srv/b.git', every_min: 0 }).length, 1);
  assert.equal(backupConfigErrors({ remote: '/srv/b.git', branch: 'a..b' }).length, 1);
  assert.equal(backupConfigErrors({ remote: '/srv/b.git', force: true }).length, 1);
  const sha = 'a'.repeat(40);
  const args = pushArgs('/srv/b.git', sha, 'dasks-board-mini');
  assert.deepEqual(args.slice(-2), ['/srv/b.git', `${sha}:refs/heads/dasks-board-mini`]);
  assert.ok(!args.some((a) => a.startsWith('+') || /force/.test(a)), 'never forced');
  assert.throws(() => pushArgs('/srv/b.git', 'HEAD', 'x'), /40-hex/);
  assert.deepEqual(forbiddenPaths(['data/tasks/a/t-x.md', 'run/fleet.json', 'secrets/ledger.key', 'agent-tokens.json', 'data/x/client.json', 'config.json']),
    ['run/fleet.json', 'secrets/ledger.key', 'agent-tokens.json', 'data/x/client.json']);
  // Raw paths (git log -z) can hold a newline or another control character: refused whatever the name.
  assert.deepEqual(forbiddenPaths(['secrets/a\nb.txt', 'run/x\ny', 'data/a\tb.md', 'data/secrets/x.txt', 'data/x/.env.local', 'data/secretsfile.md', 'data/ok.md']),
    ['secrets/a\nb.txt', 'run/x\ny', 'data/a\tb.md', 'data/secrets/x.txt', 'data/x/.env.local']);
});

test('push: HEAD goes to the board branch; a moved HEAD is pushed again; nothing new = no push', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  const remote = bare();
  try {
    const b = new Backup(root, { remote, every_min: 10 }, 'mini');
    const s1 = await b.tick();
    assert.equal(s1.failures, 0, s1.last_error ?? '');
    assert.equal(s1.branch, 'dasks-board-mini');
    assert.equal(tip(remote, 'dasks-board-mini'), git(root, 'rev-parse', 'HEAD'));
    const s2 = await b.tick();
    assert.equal(s2.last_try_at, s1.last_try_at, 'HEAD did not move: no push');
    const next = commit(root, 'data/tasks/beta/t-two.md', 'x');
    await b.tick();
    assert.equal(tip(remote, 'dasks-board-mini'), next);
    assert.deepEqual(git(remote, 'for-each-ref', '--format=%(refname)').split('\n'), ['refs/heads/dasks-board-mini'], 'one branch, nothing else');
  } finally { cleanup(); fs.rmSync(remote, { recursive: true, force: true }); }
});

test('push: a remote branch that moved elsewhere is never forced; failures count up to a warning; a success clears it', async () => {
  const { root, cleanup } = tempRepo();
  const remote = bare();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-backup-other-'));
  try {
    git(other, 'init', '-q', '-b', 'main'); git(other, 'config', 'user.name', 't'); git(other, 'config', 'user.email', 't@example.invalid');
    const foreign = commit(other, 'x.txt', 'not the board');
    git(other, 'push', '-q', remote, `${foreign}:refs/heads/dasks-board-mini`);
    const b = new Backup(root, { remote, every_min: 10 }, 'mini');
    for (let i = 1; i <= BACKUP_WARN_AFTER; i++) {
      const s = await b.tick();
      assert.equal(s.failures, i);
      assert.match(s.last_error!, /has commits this board does not \(rejected; never forced\)/);
      assert.equal(backupView({ remote, every_min: 10 }, s).warning === null, i < BACKUP_WARN_AFTER, `warning only from ${BACKUP_WARN_AFTER} failures`);
    }
    assert.equal(tip(remote, 'dasks-board-mini'), foreign, 'the remote branch is untouched');
    assert.equal(backupView({ remote, every_min: 10 }, b.status()).state, 'failing');
    git(remote, 'update-ref', '-d', 'refs/heads/dasks-board-mini');
    const ok = await b.tick();
    assert.equal(ok.failures, 0);
    assert.equal(ok.last_error, null);
    assert.equal(backupView({ remote, every_min: 10 }, ok).warning, null);
  } finally { cleanup(); for (const d of [remote, other]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('secrets: a new board repo leaves run/ and every secret out of git; a commit that carries one is refused, not pushed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-backup-home-'));
  const root = path.join(home, 'data');
  const remote = bare();
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'src/cli/init.ts'), '--root', root], { encoding: 'utf8', env: { ...process.env, HOME: home, DASKS_HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')[0], 'run/');
    for (const f of ['run/fleet.json', 'run/backup.json', 'run/agent-token-usage.json', 'run/summary.json']) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), '{}'); }
    assert.equal(git(root, 'status', '--porcelain', '--', 'run'), '', 'run/ is ignored');
    git(root, 'add', '-A');
    assert.deepEqual(forbiddenPaths(git(root, 'ls-files').split('\n')), [], 'nothing secret or live is tracked');
    // The token store, passphrase and login secrets live beside the data repo, never in it.
    assert.ok(!git(root, 'ls-files').split('\n').some((f) => /agent-tokens|passphrase|secrets\/|client\.json/.test(f)));
    const b = new Backup(root, { remote, every_min: 10 }, 'mini');
    assert.equal((await b.tick()).failures, 0);
    const clean = tip(remote, 'dasks-board-mini');
    commit(root, 'run/leak.json', '{"token":"x"}');
    const s = await b.tick();
    assert.match(s.last_error!, /refused: the commits to push carry run\/leak\.json/);
    assert.equal(tip(remote, 'dasks-board-mini'), clean, 'the leaking commit never left');
    // A non-ASCII name: git quotes it ("run/\355…") unless the paths are read raw.
    git(root, 'reset', '-q', '--hard', 'HEAD~1');
    commit(root, 'run/한글.json', '{}');
    const k = await b.tick();
    assert.match(k.last_error!, /refused: the commits to push carry run\/한글\.json/);
    git(root, 'reset', '-q', '--hard', 'HEAD~1');
    commit(root, 'secrets/키.key', 'x');
    assert.match((await b.tick()).last_error!, /secrets\/키\.key/);
    git(root, 'reset', '-q', '--hard', 'HEAD~1');
    commit(root, 'secrets/a\nb.txt', 'x');
    assert.match((await b.tick()).last_error!, /refused: the commits to push carry secrets\/a\nb\.txt/);
    assert.equal(tip(remote, 'dasks-board-mini'), clean, 'neither left');
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(remote, { recursive: true, force: true }); }
});

test('a status file that cannot be written (full disk, no permission) is a failed push, never a thrown error', async () => {
  const { root, cleanup } = tempRepo();
  const remote = bare();
  const run = path.join(root, 'run');
  try {
    fs.mkdirSync(run, { recursive: true });
    fs.chmodSync(run, 0o555);
    const b = new Backup(root, { remote, every_min: 10 }, 'mini');
    const s = await b.tick();
    assert.equal(s.failures, 0, 'the push itself went through');
    assert.match(s.last_error!, /status file not written \(EACCES\)/);
    assert.equal(tip(remote, 'dasks-board-mini'), git(root, 'rev-parse', 'HEAD'));
    fs.rmSync(remote, { recursive: true, force: true });
    const f = await b.tick(true);
    assert.equal(f.failures, 1, 'counted in memory although the file cannot be written');
    assert.match(f.last_error!, /git push failed.*status file not written/);
  } finally { fs.chmodSync(run, 0o755); cleanup(); fs.rmSync(remote, { recursive: true, force: true }); }
});

test('server: backup now and status; a failing remote is a health warning (200, never 503) and a dasks check line', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  const remote = bare();
  const env = { DASKS_MACHINE: 'mini' };
  const srv = await serve(root, env, undefined, { backup: { remote, every_min: 600 } });
  try {
    const now = await fetch(srv.url + '/api/backup/now', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'cli@mini' }, body: '{}' });
    const body = await now.json() as any;
    assert.equal(now.status, 200, JSON.stringify(body));
    assert.equal(body.state, 'ok');
    assert.equal(tip(remote, 'dasks-board-mini'), git(root, 'rev-parse', 'HEAD'));
    const st = await (await fetch(srv.url + '/api/backup')).json() as any;
    assert.equal(st.remote, remote);
    assert.equal(st.branch, 'dasks-board-mini');
    fs.rmSync(remote, { recursive: true, force: true }); // the remote is gone
    for (let i = 0; i < BACKUP_WARN_AFTER; i++) {
      const r = await fetch(srv.url + '/api/backup/now', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'cli@mini' }, body: '{}' });
      assert.equal(r.status, 502);
    }
    const h = await fetch(srv.url + '/api/health');
    const hj = await h.json() as any;
    assert.equal(h.status, 200, 'a failing backup never makes the board unready');
    assert.equal(hj.ready, true);
    assert.equal(hj.backup.state, 'failing');
    assert.match(hj.warnings[0], /board backup: 3 pushes in a row failed/);
    assert.ok(!hj.warnings[0].includes(remote), 'health (open to the network) does not name the remote');
    const cfg = path.join(root, 'test-config.json');
    const chk = spawnSync(process.execPath, [path.join(ROOT, 'src/cli/check.ts'), 'check'], { encoding: 'utf8', env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfg } });
    assert.match(chk.stdout, /warn {2}run\/backup\.json: board backup: 3 pushes in a row failed.*git push failed/);
  } finally { await srv.stop(); cleanup(); fs.rmSync(remote, { recursive: true, force: true }); }
});
