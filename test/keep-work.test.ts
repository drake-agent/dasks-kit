// Saving a stopped build and finding it again, on real git repos with a bare remote. The whole flow is in runner.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pickStart, saveWork, type SaveInput } from '../src/lib/keep-work.ts';
import { BoardError, settle, storedPasses, type FlowEnv } from '../src/lib/run-flow.ts';
import { emptyState, type RunRecord } from '../src/lib/runner.ts';

const BRANCH = 'dasks/web.t-one', CARD = 'web.t-one', BASE = 'origin/main';
const id = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

function world() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-keep-'));
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  const bare = path.join(tmp, 'remote.git'), repo = path.join(tmp, 'repo'), other = path.join(tmp, 'other'), dir = path.join(tmp, 'wt');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(tmp, 'clone', '-q', bare, repo);
  g(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'one\n');
  g(repo, 'add', '-A'); g(repo, ...id, 'commit', '-qm', 'init'); g(repo, 'push', '-q', 'origin', 'main');
  g(tmp, 'clone', '-q', bare, other);
  const commit = (cwd: string, file: string, text: string, msg = 'work') => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
    g(cwd, 'add', '-A'); g(cwd, ...id, 'commit', '-qm', msg);
    return g(cwd, 'rev-parse', 'HEAD');
  };
  const input = (over: Partial<SaveInput> = {}): SaveInput => ({ repo, dir, branch: BRANCH, base: BASE, card: CARD, machine: 'box', reason: 'timeout: card timeout', gitleaks: path.join(tmp, 'gitleaks'), ...over });
  fs.writeFileSync(path.join(tmp, 'gitleaks'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  // the card worktree, as the run sets it up
  const worktree = () => g(repo, 'worktree', 'add', '-q', '-b', BRANCH, dir, BASE);
  const onOrigin = () => { const r = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/heads/${BRANCH}`], { cwd: bare, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
  return { tmp, g, bare, repo, other, dir, commit, input, worktree, onOrigin, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('pickStart: no saved branch starts from the default branch', async () => {
  const w = world();
  try {
    const s = await pickStart(w.repo, BRANCH, BASE, CARD);
    assert.deepEqual([s.from, s.sha, s.aside], ['base', w.g(w.repo, 'rev-parse', BASE), undefined]);
  } finally { w.done(); }
});

test('pickStart: a branch only origin has is found from another clone', async () => {
  const w = world();
  try {
    w.worktree();
    const tip = w.commit(w.dir, 'a.txt', 'a');
    w.g(w.repo, 'push', '-q', 'origin', BRANCH);
    assert.deepEqual(await pickStart(w.other, BRANCH, BASE, CARD), { from: 'origin', sha: tip });
  } finally { w.done(); }
});

test('pickStart: a local branch ahead of origin stays; one behind origin moves up to it', async () => {
  const w = world();
  try {
    w.worktree();
    w.commit(w.dir, 'a.txt', 'a');
    w.g(w.repo, 'push', '-q', 'origin', BRANCH);
    const ahead = w.commit(w.dir, 'b.txt', 'b');
    assert.deepEqual(await pickStart(w.repo, BRANCH, BASE, CARD), { from: 'local', sha: ahead });
    w.g(w.other, 'fetch', '-q', 'origin');
    w.g(w.other, 'branch', '-q', BRANCH, `origin/${BRANCH}`);
    w.g(w.repo, 'push', '-q', 'origin', BRANCH);
    assert.deepEqual(await pickStart(w.other, BRANCH, BASE, CARD), { from: 'origin', sha: ahead });
  } finally { w.done(); }
});

test('pickStart: split from origin, origin wins and the local tip is kept under its own ref', async () => {
  const w = world();
  try {
    w.worktree();
    w.commit(w.dir, 'a.txt', 'a');
    w.g(w.repo, 'push', '-q', 'origin', BRANCH);
    const mine = w.commit(w.dir, 'mine.txt', 'mine');
    w.g(w.other, 'fetch', '-q', 'origin');
    w.g(w.other, 'checkout', '-q', '-b', BRANCH, `origin/${BRANCH}`);
    const theirs = w.commit(w.other, 'theirs.txt', 'theirs');
    w.g(w.other, 'push', '-q', 'origin', BRANCH);
    const s = await pickStart(w.repo, BRANCH, BASE, CARD);
    assert.deepEqual([s.from, s.sha], ['origin', theirs]);
    assert.equal(w.g(w.repo, 'rev-parse', s.aside!), mine);
  } finally { w.done(); }
});

test('pickStart: a squash-merged branch is not usable, here or on origin', async () => {
  const w = world();
  try {
    w.worktree();
    w.commit(w.dir, 'a.txt', 'a');
    w.g(w.repo, 'push', '-q', 'origin', BRANCH);
    w.commit(w.repo, 'a.txt', 'a', 'squashed');
    w.g(w.repo, 'push', '-q', 'origin', 'main');
    w.g(w.repo, 'fetch', '-q', 'origin');
    const s = await pickStart(w.repo, BRANCH, BASE, CARD);
    assert.equal(s.from, 'base');
    assert.equal(s.sha, w.g(w.repo, 'rev-parse', 'main'));
  } finally { w.done(); }
});

test('pickStart: a branch deleted on origin is not revived from a stale tracking ref; a failed fetch falls back to local', async () => {
  const w = world();
  try {
    w.worktree();
    const tip = w.commit(w.dir, 'a.txt', 'a');
    w.g(w.repo, 'push', '-q', 'origin', BRANCH);
    w.g(w.other, 'fetch', '-q', 'origin');
    w.g(w.bare, 'update-ref', '-d', `refs/heads/${BRANCH}`);
    assert.equal((await pickStart(w.other, BRANCH, BASE, CARD)).from, 'base', 'origin no longer has it');
    w.g(w.repo, 'remote', 'set-url', 'origin', '/nonexistent/remote.git');
    assert.deepEqual(await pickStart(w.repo, BRANCH, BASE, CARD), { from: 'local', sha: tip });
  } finally { w.done(); }
});

test('saveWork: staged, changed and new paths all go in; a second run names the same place; files stay on disk', async () => {
  const w = world();
  try {
    w.worktree();
    fs.writeFileSync(path.join(w.dir, 'staged.txt'), 's'); w.g(w.dir, 'add', 'staged.txt');
    fs.appendFileSync(path.join(w.dir, 'README.md'), 'two\n');
    fs.writeFileSync(path.join(w.dir, 'new.txt'), 'n');
    const first = await saveWork(w.input());
    const tip = w.onOrigin();
    assert.equal(first, `Work saved: branch ${BRANCH} on origin @ ${tip.slice(0, 7)}, with a WIP commit of the uncommitted changes.`);
    assert.deepEqual(w.g(w.bare, 'ls-tree', '-r', '--name-only', tip).split('\n'), ['README.md', 'new.txt', 'staged.txt']);
    assert.match(w.g(w.bare, 'show', `${tip}:README.md`), /two/);
    assert.ok(fs.existsSync(path.join(w.dir, 'new.txt')));
    assert.match(await saveWork(w.input()), new RegExp(`^Work saved: branch ${BRANCH} on origin @ ${tip.slice(0, 7)}\\.`));
    assert.equal(w.onOrigin(), tip);
  } finally { w.done(); }
});

test('saveWork: nothing to save adds nothing to the note and pushes nothing', async () => {
  const w = world();
  try {
    w.worktree();
    assert.equal(await saveWork(w.input()), '');
    assert.equal(w.onOrigin(), '');
    assert.equal(await saveWork(w.input({ branch: 'dasks/web.t-none' })), '', 'nor does a run with no branch');
  } finally { w.done(); }
});

test('saveWork: secret-shaped names stay out, also when staged, and the note counts them', async () => {
  const w = world();
  try {
    w.worktree();
    fs.mkdirSync(path.join(w.dir, 'conf'));
    for (const f of ['.env', 'conf/.env.local', 'conf/tls.pem', 'conf/id_rsa']) fs.writeFileSync(path.join(w.dir, f), 'x');
    w.g(w.dir, 'add', '-A');
    fs.writeFileSync(path.join(w.dir, 'ok.txt'), 'ok');
    assert.match(await saveWork(w.input()), /4 changed file\(s\) left out of the WIP commit/);
    assert.deepEqual(w.g(w.bare, 'ls-tree', '-r', '--name-only', w.onOrigin()).split('\n'), ['README.md', 'ok.txt']);
  } finally { w.done(); }
});

test('saveWork: a detached worktree and an oversized change are refused, and earlier commits still go', async () => {
  const w = world();
  try {
    w.worktree();
    const tip = w.commit(w.dir, 'a.txt', 'a');
    w.g(w.dir, 'checkout', '-q', '--detach');
    fs.writeFileSync(path.join(w.dir, 'b.txt'), 'b');
    const note = await saveWork(w.input());
    assert.ok(note.startsWith(`Work saved: branch ${BRANCH} on origin @ ${tip.slice(0, 7)}. Uncommitted changes not saved: the worktree is not on ${BRANCH}. The uncommitted files stay on box at `), note);
    w.g(w.repo, 'worktree', 'add', '-q', w.dir, BRANCH);
    for (let i = 0; i < 1001; i++) fs.writeFileSync(path.join(w.dir, `f${i}`), 'x');
    assert.match(await saveWork(w.input()), /Uncommitted changes not saved: 1001 changed paths, over the limit of 1000/);
    assert.equal(w.onOrigin(), tip);
  } finally { w.done(); }
});

test('saveWork: unresolved conflicts are not committed', async () => {
  const w = world();
  try {
    w.worktree();
    w.commit(w.dir, 'a.txt', 'mine');
    w.g(w.repo, 'checkout', '-q', '-b', 'side', 'main');
    w.commit(w.repo, 'a.txt', 'theirs');
    spawnSync('git', ['merge', 'side'], { cwd: w.dir });
    const note = await saveWork(w.input());
    assert.match(note, /Uncommitted changes not saved: the worktree has unresolved merge conflicts/);
    assert.doesNotMatch(w.g(w.bare, 'log', '--format=%s', w.onOrigin()), /wip:/);
    const aside = /stay on box at (\S+)\./.exec(note)?.[1] ?? '';
    assert.ok(aside && fs.existsSync(path.join(aside, 'a.txt')), note);
    assert.match(fs.readFileSync(path.join(aside, 'a.txt'), 'utf8'), /<<<<<<</, 'the conflict is kept as it was');
    assert.equal(fs.existsSync(w.dir), false);
    w.g(w.repo, 'worktree', 'add', '-q', w.dir, BRANCH);   // the next run can still take the branch
  } finally { w.done(); }
});

test('storedPasses: an unreadable answer is null, so no pass starts; a card with none is an empty list', async () => {
  const log = () => {};
  const failing = (status: number) => ({ log, api: async () => { throw new BoardError(status, 'nope'); } });
  assert.equal(await storedPasses(failing(503), 'web.t-one'), null);
  assert.deepEqual(await storedPasses(failing(404), 'web.t-one'), []);
  assert.deepEqual(await storedPasses({ log, api: async () => ({ passes: [{ pass: 1 }] }) }, 'web.t-one'), [{ pass: 1 }]);
});

test('saveWork: never the default branch, never a force-push', async () => {
  const w = world();
  try {
    w.worktree();
    w.g(w.dir, 'checkout', '-q', '-b', 'other-branch', BRANCH);
    w.commit(w.dir, 'x.txt', 'x');
    assert.match(await saveWork(w.input({ branch: 'other-branch' })), /Work not pushed: refusing to push other-branch/);
    w.g(w.dir, 'checkout', '-q', BRANCH);
    w.commit(w.dir, 'a.txt', 'a');
    w.g(w.other, 'fetch', '-q', 'origin');
    w.g(w.other, 'checkout', '-q', '-b', BRANCH, 'origin/main');
    const theirs = w.commit(w.other, 'z.txt', 'z');
    w.g(w.other, 'push', '-q', 'origin', BRANCH);
    assert.match(await saveWork(w.input()), /Work not pushed: git push failed .*1 commit\(s\) stay on local branch/);
    assert.equal(w.onOrigin(), theirs, 'a split branch is left as it is');
  } finally { w.done(); }
});

test('settle: a run that lost the card to a later run pushes nothing; a run that still holds it saves, and a board that fails stops neither', async () => {
  const w = world();
  try {
    w.worktree();
    fs.writeFileSync(path.join(w.dir, 'a.txt'), 'a');
    const record = (): RunRecord => ({ tool: 'claude', run_id: 'run-1', attempt: 1, job: 'j', machine: 'box', since: '', deadline: '', log: 'l', touches: [], repo: w.repo, dir: w.dir, branch: BRANCH, base: BASE, start_sha: '', pid: 0, phase: 'building' });
    const notes: string[] = [];
    const flow = (current: () => any): FlowEnv => {
      const state = emptyState();
      return {
        update: (fn: (x: typeof state) => void) => { fn(state); return state; }, log: () => {}, which: () => path.join(w.tmp, 'gitleaks'),
        api: async (method: string, _route: string, body: any) => { if (method === 'GET') return current(); notes.push(body?.note ?? ''); return {}; },
      } as unknown as FlowEnv;
    };
    const keep = { ...record(), dir: path.join(w.tmp, 'gone') };
    assert.equal(await settle(flow(() => ({ run_id: 'run-2' })), CARD, keep, 'the runner restarted mid-run', false), true);
    assert.equal(w.onOrigin(), '', 'the later run owns the branch');
    assert.equal(keep.saved, '');
    assert.doesNotMatch(notes.join(), /Work (saved|not)/);
    const mine = record();
    assert.equal(await settle(flow(() => { throw new Error('board down'); }), CARD, mine, 'timeout: card timeout', false), true);
    assert.match(notes.at(-1)!, /Work saved: branch /);
    assert.ok(w.onOrigin());
  } finally { w.done(); }
});

const realGitleaks = spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout.trim();
test('saveWork with the real gitleaks: a token in an uncommitted file is caught before the branch moves', { skip: !realGitleaks && 'gitleaks is not installed' }, async () => {
  const w = world();
  try {
    w.worktree();
    const token = 'ghp_' + 'aB3dE6gH9kL2nP5qR8tU1wX4zC7fJ0mS3vY6';
    fs.writeFileSync(path.join(w.dir, 'conf.txt'), `github_token = "${token}"\n`);
    assert.match(await saveWork(w.input({ gitleaks: realGitleaks })), /gitleaks flagged/);
    assert.equal(w.onOrigin(), '');
    fs.writeFileSync(path.join(w.dir, 'conf.txt'), 'harmless\n');
    assert.match(await saveWork(w.input({ gitleaks: realGitleaks })), /^Work saved: /);
  } finally { w.done(); }
});
