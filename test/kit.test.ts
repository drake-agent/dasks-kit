// Kit pieces around the board in temp folders, with fake claude / gh where needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { loadConfig, projectsConfigErrors } from '../src/lib/config.ts';
import { loadBoard } from '../src/lib/load.ts';
import { check } from '../src/lib/check.ts';
import { cardOwner, setProjects } from '../src/lib/schema.ts';
import { isAllowedLane, laneList } from '../src/lib/lanes.ts';
import { serve } from './state-support.ts';
import { task, tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const node = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('init: a fresh board passes check, has the demo project and one card; a second run changes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-init-'));
  const root = path.join(dir, 'data');
  try {
    const r = node([path.join(ROOT, 'src/cli/init.ts'), '--root', root, '--port', '4799']);
    assert.equal(r.status, 0, r.stderr);
    const cfg = loadConfig(root);
    assert.deepEqual(cfg.projects.map((p) => p.id), ['demo']);
    assert.equal(cfg.server.port, 4799);
    assert.deepEqual(cfg.server.hosts, ['127.0.0.1']);
    const b = loadBoard(root);
    assert.equal(check(b).errors.length, 0);
    assert.deepEqual(b.tasks.map((t) => t.id), ['demo.t-hello']);
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(root, 'data/goals/demo.yaml'), fs.readFileSync(path.join(root, 'data/goals/demo.yaml'), 'utf8').replace('title: Demo', 'title: Mine'));
    const again = node([path.join(ROOT, 'src/cli/init.ts'), '--root', root]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /left as it is/);
    assert.match(fs.readFileSync(path.join(root, 'data/goals/demo.yaml'), 'utf8'), /title: Mine/, 'existing data is never overwritten');
    assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), head);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('config: projects are validated; a configured project must have its goal file; owners and lanes come from config', () => {
  assert.deepEqual(projectsConfigErrors([{ id: 'web', name: 'Website', owner: 'web-lead' }]), []);
  assert.ok(projectsConfigErrors([{ id: 'Web', name: 'x' }]).length);
  assert.ok(projectsConfigErrors([{ id: 'web', name: '' }]).length);
  assert.ok(projectsConfigErrors([{ id: 'web', name: 'a' }, { id: 'web', name: 'b' }]).length);
  const { root, cleanup } = tempRepo();
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ projects: [{ id: 'beta', name: 'Beta', owner: 'beta-lead' }, { id: 'web', name: 'Web' }], lanes: ['night-claude'] }));
    loadConfig(root);
    assert.match(check(loadBoard(root)).errors.map((e) => e.message).join('\n'), /web/, 'a project without a goal file is an error');
    assert.equal(cardOwner({ owner: '', goal: 'beta' }), 'beta-lead');
    assert.equal(cardOwner({ owner: '', goal: 'web' }), 'user');
    assert.ok(isAllowedLane('night-claude') && isAllowedLane('claude') && isAllowedLane('none'));
    assert.ok(!isAllowedLane('somewhere-else'));
    assert.ok(laneList().includes('night-claude'));
  } finally { setProjects([], []); cleanup(); }
});

test('init: a folder that is not a board is refused and left as it is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-init-'));
  try {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    const r = node([path.join(ROOT, 'src/cli/init.ts'), '--root', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a Dasks board/);
    assert.deepEqual(fs.readdirSync(dir), ['notes.txt'], 'nothing written, no git repo made');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A temp HOME with a stored connection (url, token, machine) as install.sh writes it, and a board using its token store. */
async function homeBoard(tasks = [task({ id: 'beta.t-cli', title: 'CLI flow' })]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-home-'));
  const { root, cleanup } = tempRepo(tasks);
  const env = { HOME: home, DASKS_ROOT: root };
  const tok = node([path.join(ROOT, 'bin/dasks-tokens.ts'), 'issue', '*', '--note', 'test'], env);
  assert.equal(tok.status, 0, tok.stderr);
  assert.equal(fs.statSync(path.join(home, '.dasks/agent-tokens.json')).mode & 0o777, 0o600);
  const s = await serve(root, { HOME: home, DASKS_AUTH_MODE: '' });
  const client = path.join(home, '.dasks/client.json');
  fs.writeFileSync(client, JSON.stringify({ url: s.url, token: tok.stdout.trim(), machine: 'testmac' }), { mode: 0o600 });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DASKS?_|CLAUDE|CODEX)/.test(k)));
  return { home, root, s, client, env: { ...clean, HOME: home }, stop: async () => { await s.stop(); cleanup(); fs.rmSync(home, { recursive: true, force: true }); } };
}

test('auth is on by default: an agent write without the token is refused; the stored token works for every client', async () => {
  const h = await homeBoard();
  try {
    const anon = await fetch(`${h.s.url}/api/tasks/beta.t-cli`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'claude-code@x' }, body: JSON.stringify({ note: 'hi' }) });
    assert.equal(anon.status, 401);
    assert.equal((await fetch(`${h.s.url}/api/tasks/beta.t-cli`)).status, 200, 'reads stay open');
    // dasks CLI (board-cli.mjs) and dask (Python) read the URL and token from ~/.dasks/client.json; no env.
    const cli = spawnSync(path.join(ROOT, 'bin/dasks'), ['update', 'beta.t-cli', '--note', 'from the CLI'], { env: { ...h.env, DASKS_ACTOR: 'claude-code@testmac' }, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const dask = spawnSync('python3', [path.join(ROOT, 'bin/dask'), 'claim', 'beta.t-cli'], { env: { ...h.env, DASK_TOOL: 'claude' }, encoding: 'utf8' });
    assert.equal(dask.status, 0, dask.stderr);
    const t = await (await fetch(`${h.s.url}/api/tasks/beta.t-cli`)).json();
    assert.equal(t.claimed_by, 'human-claude@testmac', 'the machine name comes from the stored connection');
    assert.match(t.body, /from the CLI/);
    // A token file anyone else can read is refused.
    fs.chmodSync(path.join(h.home, '.dasks/agent-tokens.json'), 0o644);
    const loose = spawnSync(path.join(ROOT, 'bin/dasks'), ['update', 'beta.t-cli', '--note', 'again'], { env: { ...h.env, DASKS_ACTOR: 'claude-code@testmac' }, encoding: 'utf8' });
    assert.notEqual(loose.status, 0);
    assert.match(loose.stderr, /503/);
  } finally { await h.stop(); }
});

test('dask CLI: claim, now, status, message and release against a board', async () => {
  const h = await homeBoard();
  const dask = (...args: string[]) => spawnSync('python3', [path.join(ROOT, 'bin/dask'), ...args], { env: { ...h.env, DASK_TOOL: 'claude', DASKS_MACHINE: 'testmac', DASK_SESSION: '' }, encoding: 'utf8' });
  try {
    let r = dask('claim', 'beta.t-cli');
    assert.equal(r.status, 0, r.stderr);
    let t = await (await fetch(`${h.s.url}/api/tasks/beta.t-cli`)).json();
    assert.equal(t.status, 'doing');
    assert.equal(t.claimed_by, 'human-claude@testmac');
    r = dask('now', 'beta.t-cli', 'writing the parser');
    assert.equal(r.status, 0, r.stderr);
    r = dask('status', 'beta.t-cli');
    assert.match(r.stdout, /now: writing the parser/);
    r = dask('msg', 'beta.t-cli', '--kind', 'fyi', 'hello from the CLI');
    assert.equal(r.status, 0, r.stderr);
    r = dask('inbox', 'beta.t-cli');
    assert.match(r.stdout, /hello from the CLI/);
    r = dask('release', 'beta.t-cli', '--note', 'stopping', '--handoff', 'parsed half\nnext: tests');
    assert.equal(r.status, 0, r.stderr);
    t = await (await fetch(`${h.s.url}/api/tasks/beta.t-cli`)).json();
    assert.equal(t.claimed_by, '');
    assert.equal(t.summary, 'parsed half\nnext: tests');
    r = dask('claim', 'not-a-card');
    assert.equal(r.status, 2);
  } finally { await h.stop(); }
});

test('dask begin --worktree keeps .dask/ out of the repo; submit needs gitleaks', async () => {
  const h = await homeBoard();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-repo-'));
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...h.env } });
  try {
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    fs.mkdirSync(path.join(repo, '.git/info'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git/info/exclude'), '*.log');
    const dask = (...args: string[]) => spawnSync('python3', [path.join(ROOT, 'bin/dask'), ...args], { cwd: repo, env: { ...h.env, DASK_TOOL: 'claude', PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    const r = dask('begin', 'beta.t-cli', '--worktree', '--no-copy');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8'), '*.log\n.dask/\n', 'appended, the old line kept');
    assert.equal(g('status', '--porcelain'), '', 'the worktree folder is not seen by git add -A');
    dask('begin', 'beta.t-cli', '--worktree', '--no-copy');
    assert.equal(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8'), '*.log\n.dask/\n', 'added once');
    const wt = path.join(repo, '.dask/worktrees/beta.t-cli');
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    execFileSync('git', ['-C', wt, 'add', '-A']); execFileSync('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'b']);
    const sub = spawnSync('python3', [path.join(ROOT, 'bin/dask'), 'submit', 'beta.t-cli', '--summary', 'b'], { cwd: wt, env: { ...h.env, DASK_TOOL: 'claude', PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(sub.status, 1);
    assert.match(sub.stderr, /gitleaks is not installed, so nothing was pushed/);
  } finally { await h.stop(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('merge gate: no merge passes without any call; indirection, compound commands and DASK_MERGE_GATE=0', () => {
  const gate = (command: string, env: Record<string, string> = {}) => spawnSync('python3', [path.join(ROOT, 'bin/dask-merge-gate')], { input: JSON.stringify({ tool_input: { command } }), env: { ...process.env, PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
  assert.equal(gate('git status && npm test').status, 0);
  assert.equal(gate('gh pr view 12').status, 0);
  const ind = gate('eval "gh pr merge 12"');
  assert.equal(ind.status, 2);
  assert.match(ind.stderr, /indirection/);
  assert.equal(gate('eval "gh pr merge 12"', { DASK_MERGE_GATE: '0' }).status, 0);
  for (const c of ['gh pr merge 1 && gh pr merge 2', 'gh pr merge 1; gh pr merge 2', 'gh pr merge 1 | cat', 'gh pr merge 1 & gh pr merge 2', '(gh pr merge 1)']) {
    const r = gate(c);
    assert.equal(r.status, 2, c);
    assert.match(r.stderr, /single plain command/, c);
  }
  assert.match(gate('gh pr merge 1 2').stderr, /more than one PR/);
  // gh is not on this PATH: a plain merge is refused (fail closed), never let through
  assert.equal(gate('gh pr merge 12 --squash').status, 2);
});

test('merge gate: the PR is looked up in the repo the command names (-R, gh api path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-gate-'));
  try {
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${dir}/gh.args"\necho '{"headRefOid":"${'a'.repeat(40)}","headRefName":"feature","title":"no card","url":"u"}'\n`, { mode: 0o755 });
    const gate = (command: string) => spawnSync('python3', [path.join(ROOT, 'bin/dask-merge-gate')], { input: JSON.stringify({ tool_input: { command } }), env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8' });
    assert.equal(gate('gh pr merge 5 -R other/repo --squash').status, 2);
    assert.equal(gate('gh pr merge --repo=other/two 6').status, 2);
    assert.equal(gate('gh api -X PUT repos/third/repo/pulls/7/merge').status, 2);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'gh.args'), 'utf8').trim().split('\n'), [
      'pr view 5 -R other/repo --json headRefOid,headRefName,title,url',
      'pr view 6 -R other/two --json headRefOid,headRefName,title,url',
      'pr view 7 -R third/repo --json headRefOid,headRefName,title,url',
    ]);
    assert.match(gate('gh pr merge -R other/repo').stderr, /name the PR too/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// One allowed merge shape. A stub gh logs its calls and answers from STUB_* env; a stub board in its own process (spawnSync
// blocks this one) logs its calls and answers /api/merge-ok ok only for GATE_CARD at head A, unless board.no exists.
const GATE_A = '0123456789abcdef0123456789abcdef01234567';
const GATE_B = '1'.repeat(40);
const GATE_CARD = 'shared.t-demo';
const GATE_VIEW = JSON.stringify({ headRefOid: GATE_A, headRefName: `human/${GATE_CARD}`, title: 't', url: 'https://github.com/o/r/pull/12' });
const gateGql = (head: string, queue?: unknown) => JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, ...(queue === undefined ? {} : { isMergeQueueEnabled: queue }) } } } });
const SHAPED = `gh pr merge 12 -R o/r --squash --match-head-commit ${GATE_A}`;

async function gateRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-gate1-'));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$STUB_DIR/gh.args"\ncase "$1 $2" in\n  "pr view") printf '%s\\n' "$STUB_VIEW"; exit "\${STUB_VIEW_EXIT:-0}";;\n  "api graphql") printf '%s\\n' "$STUB_GQL"; exit "\${STUB_GQL_EXIT:-0}";;\nesac\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'board.py'), [
    'import http.server, json, os, sys, urllib.parse',
    'd, card, sha = sys.argv[1:4]',
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    "        with open(os.path.join(d, 'board.log'), 'a') as f: f.write(self.path + '\\n')",
    '        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)',
    "        ok = not os.path.exists(os.path.join(d, 'board.no')) and u.path == '/api/merge-ok' and q.get('card') == [card] and q.get('sha') == [sha]",
    "        body = json.dumps({'ok': ok}).encode()",
    "        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)",
    '    def log_message(self, *a): pass',
    "s = http.server.HTTPServer(('127.0.0.1', 0), H)",
    "p = os.path.join(d, 'board.port')",
    "open(p + '.tmp', 'w').write(str(s.server_address[1])); os.rename(p + '.tmp', p)",
    's.serve_forever()',
  ].join('\n'));
  const board = spawn('python3', [path.join(dir, 'board.py'), dir, GATE_CARD, GATE_A], { stdio: 'ignore' });
  const portFile = path.join(dir, 'board.port');
  for (let i = 0; i < 400 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 25));
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, DASKS_HOME: dir, DASKS_URL: `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8')}`, STUB_DIR: dir, STUB_VIEW: GATE_VIEW, STUB_GQL: gateGql(GATE_A, false) };
  for (const k of ['DASKS_CA_FILE', 'DASK_MERGE_GATE', 'STUB_VIEW_EXIT', 'STUB_GQL_EXIT']) delete env[k];
  const take = (f: string) => { const p = path.join(dir, f); const s = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : ''; fs.rmSync(p, { force: true }); return s ? s.split('\n') : []; };
  const gate = (command: string, extra: Record<string, string> = {}) => {
    take('gh.args'); take('board.log');
    const r = spawnSync('python3', [path.join(ROOT, 'bin/dask-merge-gate')], { input: JSON.stringify({ tool_input: { command } }), env: { ...env, ...extra }, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, gh: take('gh.args'), board: take('board.log') };
  };
  return { dir, gate, stop: () => { board.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('merge gate: the one allowed shape, pinned to the approved head with no merge queue, passes', async () => {
  // Real case: an agent's Bash merge command seen by the Claude Code PreToolUse hook after the user approved head A on the board
  const rig = await gateRig();
  try {
    for (const c of [SHAPED, `gh pr merge 12 --match-head-commit ${GATE_A} --merge -R o/r`, `gh pr merge 12 --rebase -R o/r --match-head-commit ${GATE_A}`]) {
      const r = rig.gate(c);
      assert.equal(r.status, 0, `${c}\n${r.stderr}`);
      assert.equal(r.gh.length, 2, c);
      assert.equal(r.gh[0], 'pr view 12 -R o/r --json headRefOid,headRefName,title,url', c);
      assert.match(r.gh[1], /^api graphql --hostname github\.com /, c);
      for (const part of ['isMergeQueueEnabled', 'headRefOid', 'owner=o', 'name=r', 'number=12']) assert.ok(r.gh[1].split(/\s+/).some((w) => w.includes(part)), `${part} in ${r.gh[1]}`);
      assert.deepEqual(r.board, [`/api/merge-ok?card=${GATE_CARD}&sha=${GATE_A}`], c);
    }
  } finally { rig.stop(); }
});

test('merge gate: other merges are refused with the allowed shape as the hint', async () => {
  // Real case: an agent's Bash merge command seen by the Claude Code PreToolUse hook after the user approved head A on the board
  const rig = await gateRig();
  const P = 'gh pr merge 12 -R o/r';
  try {
    // after today's lookup, which only fills the hint: no queue read, no board call
    for (const c of [
      `${P} --squash`,
      `gh pr merge 12 --squash --match-head-commit ${GATE_A}`,
      `${P} --squash --match-head-commit ${GATE_B}`,
      `${P} --squash --match-head-commit ${GATE_A.toUpperCase()}`,
      `${P} --squash --match-head-commit ${GATE_A.slice(0, 12)}`,
      `${P} --squash --match-head-commit=${GATE_A}`,
      `${P} --auto --squash --match-head-commit ${GATE_A}`,
      `${P} --admin --squash --match-head-commit ${GATE_A}`,
      `${P} -d --squash --match-head-commit ${GATE_A}`,
      `${P} --squash --match-head-commit ${GATE_A} --disable-auto`,
      `${P} --squash --squash --match-head-commit ${GATE_A}`,
      `${P} --squash --rebase --match-head-commit ${GATE_A}`,
      `${P} -s --match-head-commit ${GATE_A}`,
      `${P} --squash --match-head-commit ${GATE_A} --subject Fix`,
      `${P} --squash --match-head-commit ${GATE_A} --body-file notes/msg.txt`,
      `gh api -X PUT repos/o/r/pulls/12/merge -f sha=${GATE_A} -f merge_method=squash`,
    ]) {
      const r = rig.gate(c);
      assert.equal(r.status, 2, c);
      assert.ok(r.stderr.includes('gh pr merge 12') && r.stderr.includes(`--match-head-commit ${GATE_A}`), `${c}\n${r.stderr}`);
      assert.ok(!r.gh.some((l) => l.startsWith('api graphql')), `${c}: ${r.gh}`);
      assert.deepEqual(r.board, [], c);
      if (!c.includes(' -R ') && !c.startsWith('gh api')) assert.ok(r.stderr.includes('<owner>/<repo>'), `${c}\n${r.stderr}`);
    }
    // non-plain text, a first word other than gh, or a bad -R value: refused before any gh or board call
    for (const c of [
      `${P} --squash --match-head-commit ${GATE_A} --subject "Fix [approval]"`,
      `${P} --squash --match-head-commit "${GATE_A}"`,
      `${P} --squash --match-head-commit ${GATE_A} --subject=a\\ b`,
      `${P} --squash --match-head-commit ${GATE_A} --subject *`,
      `gh pr merge 12 -R host.example/o/r --squash --match-head-commit ${GATE_A}`,
      `gh pr merge 12 -R git@host.example:o/r --squash --match-head-commit ${GATE_A}`,
      `/usr/local/bin/gh pr merge 12 -R o/r --squash --match-head-commit ${GATE_A}`,
    ]) {
      const r = rig.gate(c);
      assert.equal(r.status, 2, c);
      assert.ok(r.stderr.includes('gh pr merge') && r.stderr.includes('--match-head-commit <head>'), `${c}\n${r.stderr}`);
      assert.deepEqual(r.gh, [], c);
      assert.deepEqual(r.board, [], c);
    }
  } finally { rig.stop(); }
});

test('merge gate: the allowed shape fails closed when the board, gh or the queue read cannot confirm it', async () => {
  // Real case: an agent's Bash merge command seen by the Claude Code PreToolUse hook after the user approved head A on the board
  const rig = await gateRig();
  try {
    const cases: [string, Record<string, string>][] = [
      ['board unreachable', { DASKS_URL: 'http://127.0.0.1:9' }],
      ['board CA file missing', { DASKS_CA_FILE: path.join(rig.dir, 'no-such-ca.pem') }],
      ['pr view not json', { STUB_VIEW: 'not json' }],
      ['gh exits 1', { STUB_VIEW_EXIT: '1' }],
      ['no head', { STUB_VIEW: JSON.stringify({ headRefName: `human/${GATE_CARD}`, title: 't', url: 'https://github.com/o/r/pull/12' }) }],
      ['queue true', { STUB_GQL: gateGql(GATE_A, true) }],
      ['queue missing', { STUB_GQL: gateGql(GATE_A) }],
      ['graphql head B', { STUB_GQL: gateGql(GATE_B, false) }],
      ['url names another repo', { STUB_VIEW: GATE_VIEW.replace('/o/r/', '/o/other/') }],
      ['url names another PR', { STUB_VIEW: GATE_VIEW.replace('/pull/12', '/pull/13') }],
      ['graphql exits 1', { STUB_GQL_EXIT: '1' }],
      ['graphql not json', { STUB_GQL: 'not json' }],
    ];
    for (const [why, env] of cases) {
      const r = rig.gate(SHAPED, env);
      assert.equal(r.status, 2, `${why}\n${r.stderr}`);
      assert.match(r.stderr, /gh pr merge 12 -R o\/r --squash --match-head-commit /, why);
    }
    assert.match(rig.gate(SHAPED, { STUB_GQL: gateGql(GATE_A, true) }).stderr, /merge queue/);
    assert.equal(rig.gate('git status', { DASKS_CA_FILE: path.join(rig.dir, 'no-such-ca.pem') }).status, 0);
    fs.writeFileSync(path.join(rig.dir, 'board.no'), '');
    const no = rig.gate(SHAPED);
    assert.equal(no.status, 2, 'the board answers not ok');
    assert.equal(no.board.length, 1);
  } finally { rig.stop(); }
});

// ---------- installer ----------

function fakeTools(dir: string, claudeHasForeignMcp: boolean) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${dir}/claude.args"\n[ "$1 $2 $3" = "mcp get dasks" ] && exit ${claudeHasForeignMcp ? 0 : 1}\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'gitleaks'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
}

test('install.sh: never clobbers files, links or MCP entries it did not make; records what it made; uninstall removes only those', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-inst-'));
  const fake = path.join(home, 'fake');
  try {
    fakeTools(fake, true);
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local/bin/dask'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
    fs.symlinkSync('/usr/bin/true', path.join(home, '.local/bin/gb'));
    fs.mkdirSync(path.join(home, '.claude/skills/review-loop'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/skills/review-loop/SKILL.md'), 'my own');
    const pass = path.join(home, 'pass.txt'); fs.writeFileSync(pass, 'a long enough passphrase\n');
    const env = { ...process.env, HOME: home, PATH: `${fake}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const sh = (script: string, ...args: string[]) => spawnSync('bash', [path.join(ROOT, script), ...args], { env, encoding: 'utf8' });
    const r = sh('install.sh', '--no-launchd', '--port', '4793', '--passphrase-file', pass);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(home, '.local/bin/dask'), 'utf8'), '#!/bin/sh\necho mine\n', 'a file it did not make stays');
    assert.equal(fs.readlinkSync(path.join(home, '.local/bin/gb')), '/usr/bin/true', 'a link it did not make stays');
    assert.equal(fs.readlinkSync(path.join(home, '.local/bin/dasks')), path.join(ROOT, 'bin/dasks'));
    assert.equal(fs.readFileSync(path.join(home, '.claude/skills/review-loop/SKILL.md'), 'utf8'), 'my own');
    assert.ok(fs.existsSync(path.join(home, '.claude/skills/dasks/SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, '.codex/skills/dasks/SKILL.md')), 'Codex gets the dasks skill too');
    assert.match(r.stdout, /already has a dasks MCP this installer did not make/);
    assert.ok(!/mcp remove|mcp add/.test(fs.readFileSync(path.join(fake, 'claude.args'), 'utf8')), 'the foreign MCP entry is not touched');
    const client = JSON.parse(fs.readFileSync(path.join(home, '.dasks/client.json'), 'utf8'));
    assert.equal(client.url, 'http://127.0.0.1:4793');
    assert.match(client.token, /^dsk_[0-9a-f]{8}_/);
    assert.equal(fs.statSync(path.join(home, '.dasks/client.json')).mode & 0o777, 0o600);
    const rec = JSON.parse(fs.readFileSync(path.join(home, '.dasks/install.json'), 'utf8'));
    assert.deepEqual(rec.links, ['dasks', 'dasks-captain', 'dasks-captain-watch', 'dasks-ci'].map((c) => path.join(home, '.local/bin', c)));
    assert.match(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), /\[mcp_servers\.dasks\]/);
    // A skill an earlier kit installed (in the record, with the marker) and no longer ships goes on the next install; an
    // unrecorded one with the same shape stays.
    const retired = path.join(home, '.claude/skills/old-review'), foreign = path.join(home, '.claude/skills/old-notes');
    for (const d of [retired, foreign]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.dasks-kit'), ''); }
    spawnSync('python3', [path.join(ROOT, 'scripts/installer.py'), 'record', path.join(home, '.dasks/install.json'), 'add', 'skills', retired], { encoding: 'utf8' });
    const again = sh('install.sh', '--no-launchd', '--port', '4793');
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!fs.existsSync(retired), 'the retired skill this installer made is removed');
    assert.ok(fs.existsSync(foreign), 'a skill folder the record does not list stays');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(home, '.dasks/install.json'), 'utf8')).skills.includes(retired));
    assert.ok(fs.existsSync(path.join(home, '.claude/skills/dasks/SKILL.md')), 'current skills stay');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.dasks/client.json'), 'utf8')).token, client.token, 'an update keeps the token');
    const un = sh('uninstall.sh');
    assert.equal(un.status, 0, un.stderr);
    assert.ok(!fs.existsSync(path.join(home, '.local/bin/dasks')));
    assert.ok(fs.existsSync(path.join(home, '.local/bin/dask')) && fs.existsSync(path.join(home, '.local/bin/gb')));
    assert.equal(fs.readFileSync(path.join(home, '.claude/skills/review-loop/SKILL.md'), 'utf8'), 'my own');
    assert.ok(!fs.existsSync(path.join(home, '.claude/skills/dasks')) && !fs.existsSync(path.join(home, '.codex/skills/dasks')));
    assert.ok(!/mcp_servers\.dasks/.test(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8')));
    assert.ok(fs.existsSync(path.join(home, '.dasks/data/config.json')), 'board data stays');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('installer: plists come from plistlib (paths with & and quotes stay valid); no shell strings are built', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-plist-'));
  try {
    const odd = path.join(dir, `R&D "kit" <x>`);
    const out = path.join(dir, 'a.plist');
    const r = spawnSync('python3', [path.join(ROOT, 'scripts/installer.py'), 'plist', out, 'dev.dasks.server', odd, path.join(odd, 'log'), '/usr/bin:/bin', odd, dir, '--', '/usr/bin/node', path.join(odd, 'src/server.ts')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const lint = spawnSync('plutil', ['-lint', out], { encoding: 'utf8' });
    if (lint.error === undefined) assert.equal(lint.status, 0, lint.stdout);
    const back = spawnSync('python3', ['-c', 'import plistlib,sys,json; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', out], { encoding: 'utf8' });
    assert.equal(JSON.parse(back.stdout).ProgramArguments[1], path.join(odd, 'src/server.ts'));
    for (const f of ['install.sh', 'uninstall.sh']) assert.ok(!/bash -c|sh -c/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
