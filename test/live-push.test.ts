// The runner's live window pusher against a fake board: steps from the log, the worktree diff since the run's start,
// sanitized before it is sent; a board without the route turns it off; stop() sends the last state once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { livePusher, stepsOf, worktreeSnapshot } from '../src/lib/live-push.ts';

const KEY = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-live-push-'));
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 't'); g('config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'one\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  const logFile = path.join(dir, '..', `${path.basename(dir)}.log`);
  fs.writeFileSync(logFile, '# header before the phase\n');
  const calls: { method: string; route: string; body: any }[] = [];
  let answer: (() => unknown) = () => ({});
  const api = async (method: string, route: string, body: unknown) => { calls.push({ method, route, body }); return answer(); };
  return { dir, g, base, logFile, calls, api, setAnswer: (f: () => unknown) => { answer = f; }, cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(logFile, { force: true }); } };
}
const jl = (o: unknown) => JSON.stringify(o) + '\n';
const toolUse = (name: string, input: unknown) => jl({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('stepsOf: tool calls and text from stream-json, plain lines as notes, other events skipped', () => {
  const lines = [toolUse('Bash', { command: 'npm test', description: 'Run the tests' }), toolUse('Edit', { file_path: 'src/a.ts' }),
    jl({ type: 'assistant', message: { content: [{ type: 'text', text: 'Now the docs.\nMore detail' }] } }), jl({ type: 'user', message: {} }), '{broken\n', 'codex says hi\n'].join('').split('\n');
  assert.deepEqual(stepsOf(lines), [
    { kind: 'tool', text: 'Bash: Run the tests' }, { kind: 'tool', text: 'Edit: src/a.ts' }, { kind: 'note', text: 'Now the docs.' }, { kind: 'note', text: 'codex says hi' },
  ]);
  assert.equal(stepsOf([toolUse('Bash', { command: `export TOKEN=${KEY}` })])[0].text.includes(KEY), false);
  // Secret flags in a plain log line or a tool command never leave the runner.
  const flags = stepsOf(['redis-cli -a fixtureRedisOnly ping', toolUse('Bash', { command: 'mysql -pfixtureMysqlPw -e "select 1"' }).trim()]);
  assert.ok(!JSON.stringify(flags).includes('fixtureRedisOnly') && !JSON.stringify(flags).includes('fixtureMysqlPw'), JSON.stringify(flags));
});

test('worktreeSnapshot: a renamed env-style file and diff.noprefix', async () => {
  const e = setup();
  try {
    fs.writeFileSync(path.join(e.dir, 'vars.txt'), 'DB_PASS=fixtureRenamedPw\nDB_HOST=x\nDB_USER=y\n');
    e.g('add', '-A'); e.g('commit', '-qm', 'vars');
    const base = e.g('rev-parse', 'HEAD');
    e.g('mv', 'vars.txt', 'notes.md');
    fs.appendFileSync(path.join(e.dir, 'notes.md'), 'DB_PORT=1\n');
    fs.appendFileSync(path.join(e.dir, 'a.ts'), 'shown line\n');
    e.g('config', 'diff.noprefix', 'true');
    const snap = (await worktreeSnapshot(e.dir, base))!;
    assert.ok(!snap.diff.includes('fixtureRenamedPw'), snap.diff);
    assert.match(snap.diff, /^diff --git a\/notes\.md b\/notes\.md$|^diff --git a\/vars\.txt b\/notes\.md$/m);
    assert.match(snap.diff, /^\+shown line$/m, 'noprefix config: an ordinary file is still shown');
  } finally { e.cleanup(); }
});

test('pusher: one POST at a time, each waited for briefly; stop() is bounded on a board that never answers', async () => {
  const e = setup();
  try {
    let calls = 0;
    const hang = async () => { calls++; return new Promise(() => {}); };
    const p = livePusher({ api: hang, card: 'shared.t-live', runId: 'r', phase: 'building', dir: e.dir, base: e.base, logFile: e.logFile, intervalMs: 60_000, postWaitMs: 100, stopWaitMs: 300 });
    fs.appendFileSync(e.logFile, 'one\n');
    const t0 = Date.now();
    assert.equal(await p.tick(), false);
    assert.ok(Date.now() - t0 < 2_000, 'the caller waited only briefly');
    // The git snapshot may outlast the 100 ms wait on a busy machine: let the first POST start before the next tick.
    for (let i = 0; i < 200 && !calls; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1);
    fs.appendFileSync(e.logFile, 'two\n');
    assert.equal(await p.tick(), false);
    assert.equal(calls, 1, 'no second POST while the first is unanswered');
    const t1 = Date.now();
    assert.equal(await p.stop(), false);
    assert.ok(Date.now() - t1 < 2_000, 'stop() did not wait for the board');
    assert.equal(calls, 1);
  } finally { e.cleanup(); }
});

test('pusher: posts new steps and the sanitized diff since base (committed, uncommitted, untracked), then the ended state', async () => {
  const e = setup();
  try {
    const p = livePusher({ api: e.api, card: 'shared.t-live', runId: 'run-1', phase: 'building', dir: e.dir, base: e.base, logFile: e.logFile, intervalMs: 60_000 });
    fs.writeFileSync(path.join(e.dir, 'a.ts'), 'one\ntwo\n'); e.g('commit', '-qam', 'work');
    fs.appendFileSync(path.join(e.dir, 'a.ts'), `const token = "${KEY}"\n`);
    fs.writeFileSync(path.join(e.dir, '.env'), 'SECRET=plain-env-value\n'); e.g('add', '.env');
    fs.writeFileSync(path.join(e.dir, 'new.md'), 'untracked\n');
    fs.appendFileSync(e.logFile, toolUse('Edit', { file_path: 'a.ts' }) + '{"type":"assistant","message":{"content":[{"type":"text","text":"half a li');
    assert.equal(await p.tick(), true);
    const first = e.calls[0];
    assert.equal(first.route, '/api/tasks/shared.t-live/live');
    assert.equal(first.body.run_id, 'run-1');
    assert.equal(first.body.phase, 'building');
    assert.deepEqual(first.body.steps, [{ kind: 'tool', text: 'Edit: a.ts' }], 'the header and the unfinished line are not steps');
    assert.deepEqual(first.body.files.map((f: any) => `${f.status} ${f.path} +${f.added}`), ['A .env +1', 'M a.ts +2', 'A new.md +0']);
    assert.match(first.body.diff, /^\+two$/m, 'a committed change since base shows');
    assert.ok(!JSON.stringify(first.body).includes(KEY), 'token redacted before sending');
    assert.ok(!first.body.diff.includes('plain-env-value'), 'sensitive file content not sent');
    assert.equal(await p.tick(), false, 'nothing new: no post');
    fs.appendFileSync(e.logFile, 'ne"}]}}\n');
    assert.equal(await p.tick(), true);
    assert.deepEqual(e.calls[1].body.steps, [{ kind: 'note', text: 'half a line' }]);
    assert.equal(await p.stop(), true);
    assert.equal(e.calls.at(-1)!.body.ended, true);
    assert.equal(await p.stop(), false, 'stop sends once');
    assert.equal(e.calls.length, 3);
  } finally { e.cleanup(); }
});

test('pusher: a board without the route (404) turns it off; other errors never throw; interval 0 posts nothing', async () => {
  const e = setup();
  try {
    e.setAnswer(() => { throw Object.assign(new Error('boom'), { status: 500 }); });
    const p = livePusher({ api: e.api, card: 'shared.t-live', runId: 'r', phase: 'fixing', dir: e.dir, base: e.base, logFile: e.logFile, intervalMs: 60_000 });
    fs.appendFileSync(e.logFile, 'step one\n');
    assert.equal(await p.tick(), false);
    e.setAnswer(() => { throw Object.assign(new Error('not found'), { status: 404 }); });
    fs.appendFileSync(e.logFile, 'step two\n');
    assert.equal(await p.tick(), false);
    const n = e.calls.length;
    fs.appendFileSync(e.logFile, 'step three\n');
    assert.equal(await p.tick(), false);
    assert.equal(await p.stop(), false);
    assert.equal(e.calls.length, n, 'no call after a 404');
    const quiet = livePusher({ api: e.api, card: 'shared.t-live', runId: 'r', phase: 'fixing', dir: e.dir, base: e.base, logFile: e.logFile, intervalMs: 0 });
    assert.equal(await quiet.tick(), false);
    assert.equal(await quiet.stop(), false);
    assert.equal(e.calls.length, n);
  } finally { e.cleanup(); }
});

test('pusher: posts on its own every interval while the phase runs', async () => {
  const e = setup();
  try {
    const p = livePusher({ api: e.api, card: 'shared.t-live', runId: 'r', phase: 'building', dir: e.dir, base: e.base, logFile: e.logFile, intervalMs: 30 });
    fs.appendFileSync(e.logFile, 'working\n');
    for (let i = 0; i < 100 && !e.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
    await p.stop();
    assert.ok(e.calls.length >= 2);
    assert.deepEqual(e.calls[0].body.steps, [{ kind: 'note', text: 'working' }]);
  } finally { e.cleanup(); }
});
