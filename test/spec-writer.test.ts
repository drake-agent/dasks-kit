// Spec writing (docs/specs.md): the review reader and the often x bad rule, the spec pass picks, the finish line
// (done_when / done_at, the live check), then whole runs against a temp board with fake claude, codex, gh and gitleaks
// on PATH: the runner's spec pass, `dask spec` and `dask verify`. Nothing outside temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { agentCommand, pickCards, pickSpecCards, runnerConfig, RUNNER_DEFAULTS, SPEC_RETRIES, type SpecPickInput } from '../src/lib/runner.ts';
import { cardHash, extractSpec, questionBlocks, readSpecReview, repoSource, SPEC_REVIEW_PASSES, specLoop, type RepoView } from '../src/lib/spec-flow.ts';
import { toolIdentity } from '../src/lib/spec-state.ts';
import { checkLine, doneLineCheck } from '../src/lib/done-line.ts';
import { pairGuard } from '../src/lib/contract.ts';
import { writeSpec } from '../src/lib/specs.ts';
import { readTask, updateTask, HttpError } from '../src/lib/write.ts';
import { task, tempRepo } from './helpers.ts';
import { unusedPort, until } from './state-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = new Date('2026-11-03T12:00:00Z');

/** A spec that passes the card contract, with its finish line. */
function specText(id: string, o: { doneAt?: string; doneWhen?: string | null; cite?: string } = {}): string {
  return [
    `id: ${id}`, `goal: ${id.split('.')[0]}`, 'role: builder', 'tier: 2', 'repo: example/proj', `branch: dasks/${id}`, 'lane: claude',
    'deadline: 2026-12-01', 'size: small', 'depends_on: none', 'impl: claude', 'review: codex', 'touches: src/a',
    ...(o.doneWhen === null ? [] : [`done_when: ${o.doneWhen ?? 'src/a/built.txt says hello on the default branch'}`]),
    ...(o.doneAt === undefined ? ['done_at: pr'] : o.doneAt ? [`done_at: ${o.doneAt}`] : []),
    'pass_checks:', '  - test -f src/a/built.txt exits 0', '  - grep -c hello src/a/built.txt prints 1', '  - npm test exits 0',
    '', '## Background', `Reads ${o.cite ?? 'README.md'}.`, '', '## Why', 'Because.', '', '## Context pack', `- ${o.cite ?? 'README.md'}`, '',
    '## Acceptance tests', '- built.txt exists and says hello', '', '## Tests', '- test/a.test.ts', '', '## Done criteria', '- the file is there', '',
  ].join('\n');
}

// ---------- unit ----------

test('review reader: P0/P1 and blocking questions block; security/data-loss/approval always; plain questions under 30 are implementer decides', () => {
  assert.equal(questionBlocks('security', 1), true);
  assert.equal(questionBlocks('data-loss', 4), true);
  assert.equal(questionBlocks('approval', 2), true);
  assert.equal(questionBlocks('where', 29), false);
  assert.equal(questionBlocks('done', 30), true);
  assert.equal(questionBlocks('other', 35), true);
  const clean = readSpecReview('- [P3] wording\n- [Q] often=2 bad=3 kind=where Which folder?\nVERDICT: pass');
  assert.equal(clean.pass, true);
  assert.deepEqual(clean.implementerDecides, ['implementer decides (score 6): Which folder?']);
  const sec = readSpecReview('- [Q] often=1 bad=1 kind=security Who may read the export?\nVERDICT: pass');
  assert.equal(sec.pass, false, 'a security question blocks whatever the score and whatever the reviewer said');
  assert.match(sec.blockers[0], /blocking question \(security, score 1\)/);
  const p1 = readSpecReview('- [P1] Acceptance tests: none would fail today\nVERDICT: fail');
  assert.equal(p1.pass, false);
  assert.equal(p1.blockers.length, 1);
  assert.equal(readSpecReview('- [P2] fine').finished, false, 'no VERDICT line: not finished');
  assert.equal(readSpecReview('VERDICT: fail').pass, false, 'fail without findings still fails');
  assert.equal(extractSpec('chat\n<<<SPEC\nid: x\nSPEC>>>\nRESULT: drafted'), 'id: x\n');
  assert.equal(extractSpec('no markers'), '');
});

test('contract: claude and codex are a valid implementer/reviewer pair', () => {
  assert.equal(pairGuard('claude', 'codex'), null);
  assert.equal(pairGuard('codex', 'claude'), null);
  assert.match(pairGuard('claude', 'claude')!, /same model family/);
});

test('config: runner.spec defaults to true and must be a boolean; a repo is a checkout or a GitHub owner/name', () => {
  assert.equal(RUNNER_DEFAULTS.spec, true);
  assert.equal(runnerConfig({ runner: { enabled: true } }).spec, true);
  assert.throws(() => runnerConfig({ runner: { spec: 'yes' } }), /runner\.spec/);
  assert.deepEqual(repoSource('example/proj'), { kind: 'github', name: 'example/proj' });
  assert.deepEqual(repoSource(ROOT), { kind: 'local', path: ROOT });
  assert.equal(repoSource(''), null);
});

const sin = (over: Partial<SpecPickInput> = {}): SpecPickInput => ({
  cands: [], running: [], cfg: { max_parallel: 2, daily_cap: 10 }, startedToday: 0, tools: new Set(['claude', 'codex']), backoff: {},
  repos: new Map([['web', '/r/web']]), now: NOW, toolFamily: { claude: 'anthropic', codex: 'openai' }, ...over,
});
const sc = (id: string, over: any = {}) => ({ id, goal: 'web', lane: 'claude', priority: 'p2', spec_state: 'none', ...over });

test('spec pick: the drafter is the tool that will not build; reviewed drafts, ready, blocked and other lanes are left', () => {
  const x = pickSpecCards(sin({ cands: [sc('web.t-a'), sc('web.t-b', { lane: 'codex' }), sc('web.t-r', { spec_state: 'ready' }), sc('web.t-x', { spec_state: 'blocked' }),
    sc('web.t-d', { spec_state: 'draft', reviewed: true }), sc('web.t-n', { lane: 'none' })], cfg: { max_parallel: 5, daily_cap: 10 } }));
  assert.deepEqual(x.picked.map((p) => [p.card, p.drafter, p.reviewer]), [['web.t-a', 'codex', 'claude'], ['web.t-b', 'claude', 'codex']]);
  const one = pickSpecCards(sin({ cands: [sc('web.t-a'), sc('web.t-d', { spec_state: 'draft' })], tools: new Set(['claude']) }));
  assert.deepEqual(one.picked.map((p) => [p.card, p.drafter, p.reviewer]), [['web.t-a', 'claude', null]], 'one harness: draft only, no reviewer');
  assert.match(one.skipped[0].why, /no reviewer of another family/);
  const fam = pickSpecCards(sin({ cands: [sc('web.t-a')], toolFamily: { claude: 'anthropic', codex: 'anthropic' } }));
  assert.equal(fam.picked[0].reviewer, null, 'one family: no reviewer');
  const capped = pickSpecCards(sin({ cands: [sc('web.t-a')], startedToday: 10 }));
  assert.match(capped.skipped[0].why, /daily cap 10/);
  const held = pickSpecCards(sin({ cands: [sc('web.t-a')], held: new Map([['/r/web', 'PR-first: 12 open PRs']]) }));
  assert.deepEqual(held.picked, []);
  assert.match(held.skipped[0].why, /^spec: PR-first/);
});

test('build pick: the tool that wrote the spec does not build the card', () => {
  const x = pickCards({ ready: [{ id: 'web.t-a', goal: 'web', lane: 'claude', priority: 'p2', spec_state: 'ready', touches: [], spec_by: 'claude@box' }], running: [], cfg: { max_parallel: 1, daily_cap: 10 },
    startedToday: 0, tools: new Set(['claude', 'codex']), backoff: {}, repos: new Map([['web', '/r/web']]), now: NOW, machine: 'box' });
  assert.deepEqual(x.picked, []);
  assert.match(x.skipped[0].why, /spec author cannot build it/);
});

test('finish line: a first spec without done_when or done_at is refused; an older spec without them is written with a warning', () => {
  const r = tempRepo([task({ id: 'beta.t-fin' })]);
  try {
    assert.throws(() => writeSpec(r.root, 'beta.t-fin', { text: specText('beta.t-fin', { doneWhen: null }), expected: 0, note: '' }, 'human-claude@a'),
      (e: any) => e instanceof HttpError && e.status === 422 && (e as any).data.reasons.some((x: string) => x.startsWith('done_when:')));
    assert.throws(() => writeSpec(r.root, 'beta.t-fin', { text: specText('beta.t-fin', { doneAt: 'soon' }), expected: 0, note: '' }, 'human-claude@a'),
      (e: any) => e.status === 422 && e.data.reasons.some((x: string) => x.startsWith('done_at:')));
    assert.equal(writeSpec(r.root, 'beta.t-fin', { text: specText('beta.t-fin'), expected: 0, note: '' }, 'human-claude@a').metadata.version, 1);
    assert.throws(() => writeSpec(r.root, 'beta.t-fin', { text: specText('beta.t-fin', { doneWhen: null }), expected: 1, note: '' }, 'human-claude@a'),
      (e: any) => e.status === 422, 'once a card has a finish line it cannot drop it');
  } finally { r.cleanup(); }
  const old = specText('x.t-old', { doneWhen: null, doneAt: '' });
  assert.deepEqual(doneLineCheck(old, old).errors, [], 'an older spec without the lines is grandfathered');
  assert.match(doneLineCheck(old, old).warnings[0], /older spec without a finish line/);
  assert.deepEqual(checkLine('note\nchecked: the board shows it @ abc1234\n'), { what: 'the board shows it', commit: 'abc1234' });
  assert.equal(checkLine('checked: no commit here'), null);
});

test('finish line: a live card whose PR merged waits in review (live-check); a check line moves it to done; a pr card is done at once', () => {
  const r = tempRepo([task({ id: 'beta.t-live', status: 'review', pr: 'https://github.com/example/proj/pull/3' }), task({ id: 'beta.t-pr', status: 'review', pr: 'https://github.com/example/proj/pull/4' })]);
  try {
    writeSpec(r.root, 'beta.t-live', { text: specText('beta.t-live', { doneAt: 'live' }), expected: 0, note: '' }, 'human-claude@a');
    writeSpec(r.root, 'beta.t-pr', { text: specText('beta.t-pr') , expected: 0, note: '' }, 'human-claude@a');
    const warnings: string[] = [];
    const held = updateTask(r.root, 'beta.t-live', { status: 'done', result: 'merged https://github.com/example/proj/pull/3' }, 'codex@box', { warnings });
    assert.equal(held.status, 'review');
    assert.equal(held.lane, 'live-check');
    assert.match(warnings.join(' '), /dask verify beta\.t-live/);
    const byUser = updateTask(r.root, 'beta.t-live', { status: 'done', result: 'https://github.com/example/proj/pull/3' }, 'user', {});
    assert.equal(byUser.status, 'review', 'the user too needs the check line');
    const checked = updateTask(r.root, 'beta.t-live', { status: 'done', result: 'checked: the installed app shows the new button @ 1a2b3c4d\nhttps://github.com/example/proj/pull/3' }, 'claude@box', {});
    assert.equal(checked.status, 'done');
    assert.equal(checked.lane, 'none', 'leaves the live-check lane');
    assert.equal(readTask(r.root, 'beta.t-live').status, 'done');
    assert.equal(updateTask(r.root, 'beta.t-pr', { status: 'done', result: 'https://github.com/example/proj/pull/4' }, 'codex@box', {}).status, 'done');
  } finally { r.cleanup(); }
});

// ---------- review fixes ----------

test('spec runs read only: Claude gets file-read tools and no shell, Codex the read-only sandbox', () => {
  const c = agentCommand('claude', 'spec', { model: 'm', prompt: 'P', dir: '/v', session: 's' });
  assert.equal(c.cmd, 'claude');
  const arg = (k: string) => c.args[c.args.indexOf(k) + 1];
  assert.equal(arg('--tools'), 'Read,Grep,Glob', 'only these tools exist in the run');
  assert.ok(!c.args.includes('--allowedTools'), 'no unscoped allow rule');
  assert.ok(!c.args.some((a) => a.includes('Bash(')), 'no shell command is allowed, not even git');
  assert.match(arg('--disallowedTools'), /\bBash\b.*\bWrite\b/);
  assert.equal(arg('--permission-mode'), 'dontAsk', 'anything not allowed is refused, not asked');
  assert.equal(arg('--setting-sources'), '', 'no user, project or local settings (no foreign allow rules)');
  assert.ok(c.args.includes('--strict-mcp-config'));
  assert.equal(arg('--mcp-config'), '{"mcpServers":{}}', 'no MCP server');
  assert.deepEqual(JSON.parse(arg('--settings')).permissions.allow, ['Read(//v/**)', 'Grep(//v/**)', 'Glob(//v/**)'], 'reads only under the view');
  assert.equal(c.args[c.args.length - 1], 'P');
  assert.deepEqual(c.args.slice(-6, -1), ['--model', 'm', '--output-format', 'stream-json', '--verbose'], 'no variadic flag right before the prompt');
  // A view under a symlinked temp dir is allowed by both spellings, nothing else.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-view-'));
  try {
    const allow: string[] = JSON.parse(agentCommand('claude', 'spec', { model: 'm', prompt: 'P', dir: tmp, session: 's' }).args.find((a) => a.startsWith('{"permissions"'))!).permissions.allow;
    assert.ok(allow.includes(`Read(/${fs.realpathSync(tmp)}/**)`));
    assert.ok(allow.every((r) => r.includes(`/${tmp}/**`) || r.includes(`/${fs.realpathSync(tmp)}/**`)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.deepEqual(agentCommand('codex', 'spec', { model: 'm', prompt: 'P', dir: '/v', session: 's' }).args, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', '/v', 'P']);
});

test('build pick: the answer key\'s author decides, not the last editor of the spec', () => {
  const base = { id: 'web.t-a', goal: 'web', lane: 'claude', priority: 'p2', spec_state: 'ready', touches: [] as string[] };
  const pick = (c: any) => pickCards({ ready: [c], running: [], cfg: { max_parallel: 1, daily_cap: 10 }, startedToday: 0, tools: new Set(['claude', 'codex']), backoff: {}, repos: new Map([['web', '/r/web']]), now: NOW, machine: 'box' });
  // Codex wrote the Acceptance tests; a Claude session only fixed a Background typo afterwards: Claude may build.
  assert.deepEqual(pick({ ...base, spec_by: 'human-claude-s1@box', answer_key_by: ['codex@box'] }).picked.map((p) => p.tool), ['claude']);
  // A Claude session wrote the answer key and Codex edited it later: Claude may not.
  const barred = pick({ ...base, spec_by: 'codex@box', answer_key_by: ['human-claude-s1@box'] });
  assert.deepEqual(barred.picked, []);
  assert.match(barred.skipped[0].why, /answer key, and the spec author cannot build it/);
  assert.deepEqual(pick({ ...base, spec_by: 'human-claude-s1@box' }).picked, [], 'no section author: the version writer counts');
});

test('answer-key rule by tool identity: a session\'s draft bars the same harness on that machine', () => {
  assert.equal(toolIdentity('human-claude-s1@box'), 'claude@box');
  assert.equal(toolIdentity('human-claude@box'), 'claude@box');
  assert.equal(toolIdentity('claude@box'), 'claude@box');
  assert.equal(toolIdentity('human-codex-ab12cd@box'), 'codex@box');
  assert.equal(toolIdentity('runner@box'), 'runner@box');
  const x = pickCards({ ready: [{ id: 'web.t-a', goal: 'web', lane: 'claude', priority: 'p2', spec_state: 'ready', touches: [], spec_by: 'human-claude-s1@box' }], running: [], cfg: { max_parallel: 1, daily_cap: 10 },
    startedToday: 0, tools: new Set(['claude', 'codex']), backoff: {}, repos: new Map([['web', '/r/web']]), now: NOW, machine: 'box' });
  assert.deepEqual(x.picked, []);
  assert.match(x.skipped[0].why, /spec author cannot build it/);
});

const VIEW: RepoView = { dir: '/v', repo: '/r', base: 'origin/main', sha: 'a'.repeat(40), label: 'r', note: '', facts: 'Files at this commit (1):\n  README.md' };
function loopApi(calls: string[]) {
  let version = 1;
  return async (method: string, route: string, body?: any) => {
    calls.push(`${method} ${route}`);
    if (method === 'GET') return { text: specText('web.t-a'), metadata: { version, by: 'codex@box' }, section_authors: { acceptance_tests: { by: 'codex@box', sha256: 'x' }, oracle: null } };
    if (method === 'PUT') { version++; return { metadata: { version }, section_authors: { acceptance_tests: { by: 'codex@box', sha256: 'y' }, oracle: null } }; }
    return { ok: true, body };
  };
}
test('a review that failed or did not end on a VERDICT line records nothing and leaves the spec draft', async () => {
  for (const [code, text] of [[1, '- [P3] ok\nVERDICT: pass'], [0, 'VERDICT: pass (example only)\nI could not complete the review.'], [0, '- [P3] x\nVERDICT: pass because it looks fine']] as const) {
    const calls: string[] = [];
    const out = await specLoop({ card: 'web.t-a', title: 't', goal: 'web', lane: 'claude', cardText: '', view: VIEW, drafter: 'codex', author: 'codex@box', reviewer: { tool: 'claude', actor: 'claude@box' },
      families: {}, run: async () => ({ code, stopped: '', text, raw: text }), api: loopApi(calls), log: () => {} });
    assert.equal(out.state, 'draft', text);
    assert.ok(!calls.some((c) => c.includes('/spec/review')), `nothing recorded for exit ${code}: ${text}`);
    assert.equal(out.progressed, false);
  }
  assert.equal(readSpecReview('VERDICT: pass (example only)\nI could not complete the review.').finished, false);
  assert.equal(readSpecReview('- [P3] x\nVERDICT: pass\n\n').pass, true);
});

test('spec pick: a draft is reviewed by the family that did not write it, whatever the lane; no such reviewer: skipped', () => {
  const byClaude = pickSpecCards(sin({ cands: [sc('web.t-d', { spec_state: 'draft', authorFamily: 'anthropic' })] }));
  assert.deepEqual(byClaude.picked.map((p) => [p.drafter, p.reviewer]), [['claude', 'codex']], 'lane claude, written by Claude: Codex reviews');
  const byCodex = pickSpecCards(sin({ cands: [sc('web.t-d', { spec_state: 'draft', lane: 'codex', authorFamily: 'openai' })] }));
  assert.deepEqual(byCodex.picked.map((p) => [p.drafter, p.reviewer]), [['codex', 'claude']]);
  const none = pickSpecCards(sin({ cands: [sc('web.t-d', { spec_state: 'draft', authorFamily: 'anthropic' })], tools: new Set(['claude']) }));
  assert.deepEqual(none.picked, []);
  assert.match(none.skipped[0].why, /written by the anthropic family; no reviewer of another family/);
});

test('spec pick: a card whose spec runs failed on the same text goes after the others, and waits after the retry limit', () => {
  assert.equal(SPEC_RETRIES, 2);
  const x = pickSpecCards(sin({ cands: [sc('web.t-fail', { priority: 'p0', failures: 1 }), sc('web.t-ok', { priority: 'p2' })], cfg: { max_parallel: 1, daily_cap: 10 } }));
  assert.deepEqual(x.picked.map((p) => p.card), ['web.t-ok'], 'the failed p0 does not starve the p2');
  const y = pickSpecCards(sin({ cands: [sc('web.t-fail', { failures: 2 })] }));
  assert.deepEqual(y.picked, []);
  assert.match(y.skipped[0].why, /2 spec runs on this card text failed; it waits until the card changes/);
  assert.equal(cardHash('t', '## Context\nx\n## Notes\n- a note\n', 0), cardHash('t', '## Context\nx\n## Notes\n- another note\n- more\n', 0), 'notes do not change the hash');
  assert.notEqual(cardHash('t', '## Context\nx\n', 0), cardHash('t', '## Context\ny\n', 0));
});

// ---------- end to end ----------

const FAKE_AGENT = fs.readFileSync(path.join(ROOT, 'test/fixtures/spec-writer/fake-agent.sh'), 'utf8');
const FAKE_GH = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIR/gh.args"
case "$1 $2" in
  "repo clone") git clone -q "file://$FAKE_BARE" "$4" ;;
  "pr view") exit 1 ;;
  "pr list") echo "\${FAKE_PRS:-0}" ;;
  "pr create") echo "https://github.com/example/proj/pull/7" ;;
  *) exit 1 ;;
esac
`;

async function world(o: { env?: Record<string, string>; tools?: string[]; families?: Record<string, string>; repo?: string; lane?: string; cards?: any[] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-spec-'));
  const home = path.join(tmp, 'home'), fake = path.join(tmp, 'fake'), bare = path.join(tmp, 'remote.git'), proj = path.join(tmp, 'proj'), other = path.join(tmp, 'other');
  for (const d of [home, fake, proj]) fs.mkdirSync(d, { recursive: true });
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, HOME: home } });
  const commit = (cwd: string, m: string) => g(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', m);
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(proj, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(proj, 'README.md'), '# proj\n');
  g(proj, 'add', '-A'); commit(proj, 'init');
  g(proj, 'remote', 'add', 'origin', bare); g(proj, 'push', '-q', '-u', 'origin', 'main');
  // The remote moves on after this checkout was made, and the checkout has uncommitted work: a spec reads the remote.
  g(tmp, 'clone', '-q', bare, other);
  fs.mkdirSync(path.join(other, 'src'));
  fs.writeFileSync(path.join(other, 'src/origin-only.ts'), 'export const x = 1;\n');
  g(other, 'add', '-A'); commit(other, 'remote work'); g(other, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(proj, 'local-dirty.txt'), 'not committed\n');
  const remoteMain = g(bare, 'rev-parse', 'main').trim();
  const projHead = g(proj, 'rev-parse', 'HEAD').trim();
  for (const t of o.tools ?? ['claude', 'codex']) fs.writeFileSync(path.join(fake, t), FAKE_AGENT, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'gitleaks'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

  const card = 'beta.t-spec';
  const board = tempRepo(o.cards ?? [task({ id: card, title: 'Spec me', lane: o.lane ?? 'claude', priority: 'p1', body: 'touches: src/a\n\n## Context\nAdd src/a/built.txt that says hello.\n' } as any)]);
  const port = await unusedPort();
  fs.writeFileSync(path.join(board.root, 'config.json'), JSON.stringify({
    server: { hosts: ['127.0.0.1'], port }, projects: [{ id: 'beta', name: 'Beta', repo: o.repo ?? proj }],
    runner: { enabled: true, timeout_min: 1, max_min: 1, idle_min: 0, backoff_min: 60 }, ...(o.families ? { families: o.families } : {}),
  }, null, 2));
  execFileSync('git', ['-C', board.root, 'add', '-A']); execFileSync('git', ['-C', board.root, 'commit', '-qm', 'config']);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DASKS?_|CLAUDE|CODEX)/.test(k)));
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.ts')], { env: { ...clean, HOME: home, DASKS_ROOT: board.root, DASKS_GATES: 'enforce' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout!.on('data', (d) => { srvLog += d; }); srv.stderr!.on('data', (d) => { srvLog += d; });
  const url = `http://127.0.0.1:${port}`;
  try { await until(async () => (await fetch(url + '/api/health')).ok, 15000); } catch { srv.kill(); throw new Error(`board did not start: ${srvLog}`); }
  const token = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'bin/dasks-tokens.ts'), 'issue', '*'], { env: { ...clean, HOME: home, DASKS_ROOT: board.root }, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(home, '.dasks/client.json'), JSON.stringify({ url, token, machine: 'testbox' }), { mode: 0o600 });
  const runEnv = { ...clean, HOME: home, PATH: `${fake}:${path.dirname(process.execPath)}:/usr/bin:/bin`, DASKS_ROOT: board.root, DASKS_RUNNER_TICK_MS: '200', FAKE_DIR: fake, FAKE_BARE: bare, FAKE_FIXTURES: path.join(ROOT, 'test/fixtures/spec-writer'), ...o.env };
  const proc = (cmd: string, args: string[], extra: Record<string, string> = {}) => new Promise<{ status: number | null; out: string }>((resolve) => {
    const p = spawn(cmd, args, { env: { ...runEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout!.on('data', (d) => { out += d; }); p.stderr!.on('data', (d) => { out += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 120_000);
    p.on('exit', (status) => { clearTimeout(kill); resolve({ status, out }); });
  });
  const runner = (...args: string[]) => proc(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli/runner.ts'), ...args]);
  const dask = (args: string[], extra: Record<string, string> = {}) => proc('python3', [path.join(ROOT, 'bin/dask'), ...args], extra);
  const call = async (method: string, route: string, body?: unknown, actor = 'codex@elsewhere') => {
    const r = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor, Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const get = async (id = card) => (await call('GET', `/api/tasks/${id}`)).body;
  const spec = async (id = card) => (await call('GET', `/api/tasks/${id}/spec`)).body;
  const read = (f: string) => { try { return fs.readFileSync(path.join(fake, f), 'utf8'); } catch { return ''; } };
  const state = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.dasks/runner/state.json'), 'utf8')); } catch { return null; } };
  return {
    card, home, proj, bare, remoteMain, projHead, runner, dask, call, get, spec, read, state, g, fake, env: runEnv,
    config: (fn: (c: any) => void) => { const f = path.join(board.root, 'config.json'); const c = JSON.parse(fs.readFileSync(f, 'utf8')); fn(c); fs.writeFileSync(f, JSON.stringify(c)); },
    stop: async () => { const done = new Promise((r) => srv.once('exit', r)); srv.kill(); await done; board.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

test('e2e spec pass: a spec-less card is drafted by the tool that will not build it, from a read-only view of origin/main; a clean review makes it ready; the next look builds it with the other tool', async () => {
  const w = await world();
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const t = await w.get();
    assert.equal(t.spec_state, 'ready', r.out);
    assert.equal(t.status, 'todo');
    assert.equal(t.claimed_by, '', 'the spec claim is given back');
    assert.match(t.body, /spec ready: v1 passed review round 1 by claude@testbox/);
    assert.match(t.body, /implementer decides \(score 6\): Which folder holds the fixture\?/);
    const sp = await w.spec();
    assert.equal(sp.metadata.by, 'codex@testbox', 'lane claude: Codex drafts');
    assert.equal(sp.section_authors.acceptance_tests.by, 'codex@testbox');
    assert.match(sp.text, /src\/origin-only\.ts/, 'the spec cites a file that exists on origin/main');
    assert.match(sp.text, /^done_when: /m);
    assert.equal(t.spec_review.by, 'claude@testbox', 'the review is recorded under the reviewer\'s own name');
    // The drafter saw origin/main, read-only, never the dirty local checkout.
    const view = w.read('codex.view.1');
    assert.match(view, new RegExp(`head=${w.remoteMain}`));
    assert.match(view, /pwd=.*\.dasks\/spec-views\/beta\.t-spec-/);
    assert.match(view, /^src$/m);
    assert.doesNotMatch(view, /local-dirty\.txt/);
    assert.match(view, /README read-only/);
    assert.match(w.read('claude.review.1'), /spec-views/, 'the reviewer reads the same view');
    assert.match(w.read('codex.args'), /^exec --sandbox read-only/m);
    assert.match(w.read('claude.args'), /--tools Read,Grep,Glob .*--permission-mode dontAsk .*--strict-mcp-config --mcp-config \{"mcpServers":\{\}\}/, 'the Claude reviewer has file reads only, no MCP');
    // The fake reads its own --settings and matches paths against the allow rules as Claude would: inside yes, outside no.
    assert.match(w.read('claude.paths.1'), /^inside .*README\.md: allowed\noutside \/etc\/hosts: denied\noutside .*\.dasks\/client\.json: denied$/m);
    assert.match(w.read('codex.args'), /Files at this commit \(\d+\):\n {2}README\.md\n {2}src\/origin-only\.ts/, 'git facts read ahead into the prompt');
    // The project's checkout is untouched: same HEAD, the same uncommitted file, no branch, no worktree left.
    assert.equal(w.g(w.proj, 'rev-parse', 'HEAD').trim(), w.projHead);
    assert.equal(w.g(w.proj, 'status', '--porcelain').trim(), '?? local-dirty.txt');
    assert.equal(w.g(w.proj, 'branch', '--list').trim(), '* main');
    assert.equal(w.g(w.proj, 'worktree', 'list').trim().split('\n').length, 1);
    assert.deepEqual(w.state().running, {});
    // Next look: the card is ready and Claude (its reviewer, not its author) builds it.
    const b = await w.runner('--once');
    assert.equal(b.status, 0, b.out);
    assert.equal((await w.get()).status, 'review', b.out);
    assert.match(w.read('claude.args'), /--session-id/, 'Claude built it');
    assert.doesNotMatch(w.read('codex.args'), /--full-auto/, 'Codex, the author, did not build');
  } finally { await w.stop(); }
});

test('e2e spec pass: a P1 finding gets one revision and a second review', async () => {
  const w = await world({ env: { FAKE_SPEC_REVIEW: 'p1once' } });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const t = await w.get();
    assert.equal(t.spec_state, 'ready', r.out);
    assert.equal((await w.spec()).metadata.version, 2);
    assert.match((await w.spec()).text, /Revised after review/);
    assert.equal(w.read('codex.drafts').trim(), '2', 'draft + one revision');
    assert.equal(w.read('reviews').trim(), '2');
    assert.match(w.read('codex.args'), /Revise the spec[\s\S]*\[P1\] Acceptance tests/);
  } finally { await w.stop(); }
});

test('e2e spec pass: two full review passes, then one narrow pass; still open stays draft with the findings as a card note, and is not picked again', async () => {
  assert.equal(SPEC_REVIEW_PASSES, 3);
  const w = await world({ env: { FAKE_SPEC_REVIEW: 'p1always' } });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const t = await w.get();
    assert.equal(t.spec_state, 'draft');
    assert.equal(t.spec_review.verdict, 'fail');
    assert.equal(t.spec_review.spec_version, 3);
    assert.match(t.body, /spec left as draft: v3 still has 1 blocker\(s\) after 3 review passes \| open: - \[P1\] Acceptance tests/);
    assert.equal(w.read('reviews').trim(), '3', 'two full passes and one narrow pass, no more');
    // Only the third pass is narrow, and it names the pass-2 findings.
    const reviews = w.read('claude.args').split('\n').filter((l) => l.includes('adversarial reviewer of the spec')).length;
    assert.equal(reviews, 3);
    assert.equal(w.read('claude.args').split('Narrow pass (pass 3 of 3)').length - 1, 1, 'one narrow pass');
    assert.match(w.read('claude.args'), /Narrow pass \(pass 3 of 3\)[^\n]*\n {2}- \[P1\] Acceptance tests/);
    await w.runner('--once');
    assert.equal(w.read('reviews').trim(), '3', 'a reviewed draft waits for a new version');
    assert.equal(w.read('codex.drafts').trim(), '3');
  } finally { await w.stop(); }
});

test('e2e spec pass: one model family (config families) drafts only and says so; the board refuses a same-family review', async () => {
  const w = await world({ families: { 'codex@*': 'anthropic' } });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const t = await w.get();
    assert.equal(t.spec_state, 'draft');
    assert.match(t.body, /not reviewed: Claude and Codex are one model family/);
    assert.equal(w.read('reviews'), '', 'no reviewer ran');
    const refused = await w.call('POST', `/api/tasks/${w.card}/spec/review`, { spec_version: 1, verdict: 'pass' }, 'claude@testbox');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.rule, 'spec-review');
  } finally { await w.stop(); }
});

test('e2e spec pass: a Mac with one harness drafts but does not mark ready; the spec author is never picked to build the card', async () => {
  const w = await world({ tools: ['claude'] });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    let t = await w.get();
    assert.equal(t.spec_state, 'draft');
    assert.match(t.body, /not reviewed: only Claude is installed on testbox/);
    assert.equal((await w.spec()).metadata.by, 'claude@testbox');
    const again = await w.runner('--once');
    assert.match(again.out, /no reviewer of another family/);
    assert.equal(w.read('claude.drafts').trim(), '1', 'not drafted again');
    // Someone of the other family passes it: ready, but its author does not build it.
    assert.equal((await w.call('POST', `/api/tasks/${w.card}/spec/review`, { spec_version: 1, verdict: 'pass' }, 'codex@elsewhere')).status, 200);
    t = await w.get();
    assert.equal(t.spec_state, 'ready');
    const build = await w.runner('--once');
    assert.match(build.out, /claude wrote its spec's answer key, and the spec author cannot build it/);
    assert.doesNotMatch(w.read('claude.args'), /--session-id/, 'no build');
    assert.equal((await w.get()).status, 'todo');
    const claim = await w.call('POST', `/api/tasks/${w.card}/claim`, { who: 'runner@testbox' }, 'claude@testbox');
    assert.equal(claim.status, 409, 'the board refuses the author too');
    assert.equal(claim.body.rule, 'answer-key-author');
  } finally { await w.stop(); }
});

test('e2e spec pass: a card blocked for Spec, runner.spec false and a repo over the PR limit get no spec run', async () => {
  const w = await world();
  try {
    assert.equal((await w.call('POST', `/api/tasks/${w.card}/spec/block`, { expected_version: (await w.get()).version, expected_spec_version: 0, block_note: 'needs the user' })).status, 200);
    await w.runner('--once');
    assert.equal(w.read('codex.args') + w.read('claude.args'), '', 'blocked: nobody ran');
    assert.equal((await w.get()).spec_state, 'blocked');
  } finally { await w.stop(); }
  const off = await world();
  try {
    off.config((c) => { c.runner.spec = false; });
    await off.runner('--once');
    assert.equal(off.read('codex.args') + off.read('claude.args'), '', 'runner.spec false: nobody ran');
    assert.equal((await off.get()).spec_state, 'none');
  } finally { await off.stop(); }
  const prs = await world({ env: { FAKE_PRS: '12' } });
  try {
    const r = await prs.runner('--once');
    assert.match(r.out, /skipped: spec: PR-first: 12 open PRs/);
    assert.equal(prs.read('codex.args') + prs.read('claude.args'), '', 'PR-first: nobody ran');
  } finally { await prs.stop(); }
});

test('e2e spec pass: a project with only a GitHub owner/name is read from a shallow gh clone in the cache', async () => {
  const w = await world({ repo: 'example/proj' });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    assert.equal((await w.get()).spec_state, 'ready', r.out);
    assert.match(w.read('gh.args'), /^repo clone example\/proj .*\.dasks\/cache\/example\/proj -- --depth 1/m);
    assert.match(w.read('codex.view.1'), new RegExp(`head=${w.remoteMain}`));
    assert.match((await w.spec()).text, /src\/origin-only\.ts/);
  } finally { await w.stop(); }
});

test('e2e spec pass: a usage limit backs that tool off and does not count the start', async () => {
  const w = await world({ env: { FAKE_SPEC_RATE: 'codex' } });
  try {
    const r = await w.runner('--once');
    assert.equal(r.status, 0, r.out);
    const t = await w.get();
    assert.equal(t.spec_state, 'none');
    assert.equal(t.claimed_by, '');
    assert.ok(w.state().backoff.codex, r.out);
    assert.equal(w.state().daily.count, 0);
  } finally { await w.stop(); }
});

test('dask spec: the current tool drafts, the other reviews, as the session\'s own names; --file stores your draft; dask verify closes a live card', async () => {
  const w = await world({ cards: [task({ id: 'beta.t-spec', title: 'Spec me', lane: 'claude', body: '## Context\nAdd it.\n' } as any), task({ id: 'beta.t-mine', title: 'Mine', lane: 'codex', body: '## Context\nx\n' } as any)] });
  try {
    const r = await w.dask(['spec', 'beta.t-spec', '--tool', 'claude'], { DASK_SESSION: 's1' });
    assert.equal(r.status, 0, r.out);
    const sp = await w.spec();
    assert.equal(sp.metadata.by, 'human-claude-s1@testbox', 'drafted as this session');
    assert.equal((await w.get()).spec_review.by, 'codex@testbox');
    assert.equal((await w.get()).spec_state, 'ready');
    assert.equal(w.read('claude.drafts').trim(), '1');
    assert.match(w.read('claude.view.1'), new RegExp(`head=${w.remoteMain}`));
    assert.equal(w.g(w.proj, 'status', '--porcelain').trim(), '?? local-dirty.txt');
    // --file: the session's own draft is stored, no headless draft; a live finish line.
    const f = path.join(w.home, 'mine.md');
    fs.writeFileSync(f, specText('beta.t-mine', { doneAt: 'live', cite: 'src/origin-only.ts' }));
    const m = await w.dask(['spec', 'beta.t-mine', '--tool', 'codex', '--file', f], { DASK_SESSION: 's2' });
    assert.equal(m.status, 0, m.out);
    assert.equal((await w.spec('beta.t-mine')).metadata.by, 'human-codex-s2@testbox');
    assert.equal(w.read('codex.drafts'), '', 'nothing drafted headless');
    assert.equal((await w.get('beta.t-mine')).spec_state, 'ready');
    // done_at: live: done with a PR waits in review on live-check; dask verify records the check and closes it.
    const pr = 'https://github.com/example/proj/pull/9';
    const fin = await w.call('POST', '/api/tasks/beta.t-mine', { status: 'done', result: pr, pr }, 'codex@elsewhere');
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.equal((await w.get('beta.t-mine')).status, 'review');
    assert.equal((await w.get('beta.t-mine')).lane, 'live-check');
    const bad = await w.dask(['verify', 'beta.t-mine', '--evidence', 'x', '--commit', 'nothex']);
    assert.equal(bad.status, 2);
    const v = await w.dask(['verify', 'beta.t-mine', '--evidence', 'the live board shows the new column', '--commit', w.remoteMain.slice(0, 12), '--tool', 'claude']);
    assert.equal(v.status, 0, v.out);
    const done = await w.get('beta.t-mine');
    assert.equal(done.status, 'done', v.out);
    assert.match(done.result, /^checked: the live board shows the new column @ [0-9a-f]{12}/);
    // A claimed card is not specced from a session.
    assert.equal((await w.call('POST', '/api/tasks/beta.t-spec/claim', { who: 'someone@else' }, 'someone@else')).status, 200);
    // The board bars the same harness on this machine from building a card its session wrote (tool identity).
    const build = await w.call('POST', '/api/tasks/beta.t-spec/claim', { who: 'runner@testbox' }, 'claude@testbox');
    assert.equal(build.status, 409, JSON.stringify(build.body));
    assert.equal(build.body.rule, 'answer-key-author');
    const claimed = await w.dask(['spec', 'beta.t-spec', '--tool', 'claude']);
    assert.notEqual(claimed.status, 0);
    assert.match(claimed.out, /is claimed by someone@else/);
  } finally { await w.stop(); }
});

test('e2e spec pass: a card whose draft prints no spec is tried twice on the same text, then waits', async () => {
  const w = await world({ env: { FAKE_DRAFT: 'empty' } });
  try {
    for (let i = 0; i < 3; i++) { const r = await w.runner('--once'); assert.equal(r.status, 0, r.out); }
    assert.equal(w.read('codex.drafts').trim(), '2', 'two failed runs, then no more');
    const t = await w.get();
    assert.equal(t.spec_state, 'none');
    assert.match(t.body, /Spec run failed on card text [0-9a-f]{8}/);
    assert.equal(w.state().spec_failures['beta.t-spec'].count, 2);
  } finally { await w.stop(); }
});

test('dask spec: a stop ends the agent group and removes the view; a view a killed run left is cleaned on the next start', async () => {
  const w = await world({ env: { FAKE_DRAFT: 'sleep' } });
  try {
    const views = path.join(w.home, '.dasks/spec-views');
    const p = spawn('python3', [path.join(ROOT, 'bin/dask'), 'spec', w.card, '--tool', 'claude'], { env: { ...w.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout!.on('data', (d) => { out += d; }); p.stderr!.on('data', (d) => { out += d; });
    await until(() => fs.existsSync(path.join(w.fake, 'draft.pid')), 30000);
    const pid = Number(fs.readFileSync(path.join(w.fake, 'draft.pid'), 'utf8'));
    p.kill('SIGTERM');
    const code = await new Promise((r) => p.once('exit', (c) => r(c)));
    assert.equal(code, 143, out);
    assert.throws(() => process.kill(pid, 0), 'the agent is gone');
    assert.deepEqual(fs.readdirSync(views), [], 'the view is removed');
    assert.equal(w.g(w.proj, 'worktree', 'list').trim().split('\n').length, 1);
    // A run killed hard leaves its view: the next dask spec removes it.
    const stale = path.join(views, 'cli-999999-beta.t-spec-dead');
    w.g(w.proj, 'worktree', 'add', '-q', '--detach', stale, 'HEAD');
    const again = await w.dask(['spec', w.card, '--tool', 'claude'], { FAKE_DRAFT: 'empty' });
    assert.match(again.out, /removed a view a stopped run left: .*cli-999999-beta\.t-spec-dead/);
    assert.ok(!fs.existsSync(stale));
    assert.equal(w.g(w.proj, 'worktree', 'list').trim().split('\n').length, 1);
  } finally { await w.stop(); }
});

test('install.sh: the spec-writer skill is installed for Claude Code and Codex (dry run, temp HOME)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-inst-'));
  try {
    fs.mkdirSync(path.join(home, '.codex'));
    const r = spawnSync('bash', [path.join(ROOT, 'install.sh'), '--dry-run', '--no-claude-mcp', '--no-codex-mcp'], { env: { ...process.env, HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /copy .*skills\/spec-writer -> .*\.claude\/skills\/spec-writer/);
    assert.match(r.stdout, /copy .*skills\/spec-writer -> .*\.codex\/skills\/spec-writer/);
    const skill = fs.readFileSync(path.join(ROOT, 'skills/spec-writer/SKILL.md'), 'utf8');
    assert.match(skill, /^name: spec-writer$/m);
    assert.match(skill, /done_when/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
