// The captain: lease, dasks-captain, watch, chat and dask captain-merge (fake gh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { task, tempRepo } from './helpers.ts';
import { asHuman, humanDecides, humanSecrets, serve, unusedPort, until } from './state-support.ts';
import { CaptainChat, CaptainLease } from '../src/lib/captain.ts';
import { events } from '../src/cli/captain-watch.ts';
import { harnessArgv, watchGap } from '../src/cli/captain.ts';
import { loadConfig } from '../src/lib/config.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DASKS?_|CLAUDE|CODEX)/.test(k)));
const post = async (url: string, route: string, actor: string, body: unknown) => {
  const r = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('lease: a renewal never shortens it, so a long hold for a merge outlives a short heartbeat renewal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-lease-'));
  try {
    const t0 = new Date('2026-11-03T10:00:00Z'), at = (s: number) => new Date(t0.getTime() + s * 1000);
    const l = new CaptainLease(dir);
    const a = l.take('captain@one', 30, undefined, t0);
    assert.equal(l.take('captain@one', 180, a.lease_id, at(5)).expires_at, at(185).toISOString());
    assert.equal(l.take('captain@one', 30, a.lease_id, at(15)).expires_at, at(185).toISOString(), 'the heartbeat does not cut it back');
    assert.throws(() => l.take('captain@two', 30, undefined, at(60)), (e: any) => e.status === 409);
    assert.equal(l.take('captain@one', 30, a.lease_id, at(170)).expires_at, at(200).toISOString(), 'a later renewal extends it again');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lease: one holder; a second gets 409 with the holder; renew needs the lease id; it runs out; release', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-lease-'));
  try {
    const t0 = new Date('2026-11-03T10:00:00Z'), at = (s: number) => new Date(t0.getTime() + s * 1000);
    const l = new CaptainLease(dir);
    const a = l.take('captain@one', 60, undefined, t0);
    assert.throws(() => l.take('captain@two', 60, undefined, at(1)), (e: any) => e.status === 409 && e.data.holder === 'captain@one');
    assert.throws(() => l.take('captain@one', 60, undefined, at(1)), (e: any) => e.status === 409, 'the same name without the lease id is a second session');
    const renewed = l.take('captain@one', 60, a.lease_id, at(30));
    assert.equal(renewed.lease_id, a.lease_id);
    assert.equal(renewed.expires_at, at(90).toISOString());
    assert.equal(new CaptainLease(dir).current(at(31))?.holder, 'captain@one', 'kept across a restart');
    assert.equal(l.current(at(91)), null, 'runs out');
    assert.throws(() => l.take('captain@one', 60, a.lease_id, at(91)), (e: any) => e.status === 409, 'a lease that ran out is not renewed');
    const b = l.take('captain@two', 60, undefined, at(92));
    assert.throws(() => l.release(a.lease_id, at(93)), (e: any) => e.status === 409);
    l.release(b.lease_id, at(93));
    assert.equal(l.current(at(93)), null);
    const c = new CaptainChat(dir);
    assert.throws(() => c.post('user', ''), /text is required/);
    assert.throws(() => c.post('user', 'x'.repeat(2001)), /at most/);
    c.post('user', 'one'); c.post('captain@two', 'two');
    assert.deepEqual(new CaptainChat(dir).since(1).map((m) => m.text), ['two']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(harnessArgv('claude', 'P', '/f'), ['claude', 'P']);
  assert.deepEqual(harnessArgv('my-cli --system {prompt_file} --go', 'P', '/f'), ['my-cli', '--system', '/f', '--go']);
});

test('watch gap: one "stopped" after watch_gap_sec without a look, one "back" when it looks again, nothing when off', () => {
  const start = 1_000_000, min = 60_000;
  assert.equal(watchGap(null, start, start + 9 * min, 600, false), null, 'a new session gets watch_gap_sec to arm the watch');
  assert.equal(watchGap(null, start, start + 11 * min, 600, false), 'stopped', 'never armed in this session');
  assert.equal(watchGap(start - 60 * min, start, start + 5 * min, 600, false), null, 'a look from an earlier session is not held against this one');
  assert.equal(watchGap(start + 1 * min, start, start + 12 * min, 600, false), 'stopped', '11 min since the last look');
  assert.equal(watchGap(start + 1 * min, start, start + 30 * min, 600, true), null, 'said once, not again');
  assert.equal(watchGap(start + 29 * min, start, start + 30 * min, 600, true), 'back');
  assert.equal(watchGap(start + 29 * min, start, start + 30 * min, 600, false), null, 'nothing to clear');
  assert.equal(watchGap(null, start, start + 999 * min, 0, false), null, '0 = off');
});

test('config: captain.watch_gap_sec defaults to 600; 0 turns it off; anything else under 60 throws', () => {
  const { root, cleanup } = tempRepo();
  const prev = process.env.DASKS_CONFIG;
  try {
    delete process.env.DASKS_CONFIG;
    assert.equal(loadConfig(root).captain.watch_gap_sec, 600);
    for (const ok of [0, 60, 86400]) {
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ captain: { watch_gap_sec: ok } }));
      assert.equal(loadConfig(root).captain.watch_gap_sec, ok);
    }
    for (const bad of [30, -1, 1.5, '600', 86401]) {
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ captain: { watch_gap_sec: bad } }));
      assert.throws(() => loadConfig(root), /watch_gap_sec/);
    }
  } finally { if (prev === undefined) delete process.env.DASKS_CONFIG; else process.env.DASKS_CONFIG = prev; cleanup(); }
});

test('lease over HTTP and the chat round trip: human writes, only the lease holder answers, the watch says CHAT', async () => {
  const { root, cleanup } = tempRepo();
  const sec = humanSecrets();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-cap-'));
  const s = await serve(root, { ...sec.env, HOME: home });
  try {
    const one = await post(s.url, '/api/captain/lease', 'captain@one', { ttl_sec: 60 });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const two = await post(s.url, '/api/captain/lease', 'captain@two', {});
    assert.equal(two.status, 409);
    assert.equal(two.body.holder, 'captain@one');
    assert.equal((await post(s.url, '/api/captain/lease', 'captain@two', { holder: 'captain@one' })).status, 403, 'nobody takes it in another name');
    assert.equal((await (await fetch(`${s.url}/api/captain`)).json()).lease.holder, 'captain@one');
    const env = { ...clean(), HOME: home, DASKS_URL: s.url };
    const watch = (...a: string[]) => spawnSync(NODE[0], [...NODE.slice(1), path.join(ROOT, 'src/cli/captain-watch.ts'), ...a], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(watch('--once').stdout, '', 'the first look is the baseline');
    const asked = await asHuman(s.url, '/api/captain/chat', { text: 'Is the web runner stuck?' });
    assert.equal(asked.status, 201, JSON.stringify(asked.json));
    assert.equal(asked.json.from, 'user');
    assert.equal(watch('--once').stdout, 'CHAT 1\n');
    assert.equal((await post(s.url, '/api/captain/chat', 'claude-code@one', { text: 'me too' })).status, 403, 'only the lease holder answers');
    // The holder's name is not enough: another session on that machine can use it. It takes the live lease id.
    assert.equal((await post(s.url, '/api/captain/chat', 'captain@one', { text: 'second captain' })).status, 403, 'no lease id');
    assert.equal((await post(s.url, '/api/captain/chat', 'captain@one', { text: 'second captain', lease_id: 'not-it' })).status, 403, 'a wrong lease id');
    assert.equal((await post(s.url, '/api/captain/chat', 'captain@two', { text: 'x', lease_id: one.body.lease_id })).status, 403, 'the id with another name');
    const noLease = spawnSync(path.join(ROOT, 'bin/dasks'), ['captain', 'chat', 'reply', 'hi'], { env: { ...env, DASKS_MACHINE: 'one' }, encoding: 'utf8' });
    assert.notEqual(noLease.status, 0);
    assert.match(noLease.stderr, /needs the captain lease/);
    const reply = spawnSync(path.join(ROOT, 'bin/dasks'), ['captain', 'chat', 'reply', 'No: it is building web.t-form.'], { env: { ...env, DASKS_MACHINE: 'one', DASKS_CAPTAIN_LEASE: one.body.lease_id }, encoding: 'utf8' });
    assert.equal(reply.status, 0, reply.stderr);
    assert.match(reply.stdout, /sent #2 as captain@one/);
    const read = spawnSync(path.join(ROOT, 'bin/dasks'), ['captain', 'chat', 'read', '--since', '1'], { env, encoding: 'utf8' });
    assert.match(read.stdout, /#2 .* captain@one\n {4}No: it is building web\.t-form\./);
    assert.equal(watch('--once').stdout, '', 'the captain\'s own reply is no event');
    assert.equal(watch('--timeout', '1', '--interval', '0.2').status, 124);
    assert.equal((await post(s.url, '/api/captain/lease/release', 'captain@one', { lease_id: 'nope' })).status, 409);
    assert.equal((await post(s.url, '/api/captain/lease/release', 'captain@one', { lease_id: one.body.lease_id })).status, 200);
    assert.equal((await post(s.url, '/api/captain/lease', 'captain@two', {})).status, 200, 'free again');
  } finally { await s.stop(); cleanup(); sec.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('watch lines: REVIEW, BLOCKED, QUIET, IDLE from what changed since the last look', () => {
  const prev = { tasks: { 'a.t-x': 'doing', 'a.t-y': 'doing', 'a.t-z': 'review' }, quiet: { m1: false, m2: false }, busy: { m1: true, m2: true }, chat: 3 };
  const { lines, next } = events(prev,
    [{ id: 'a.t-x', status: 'review', pr: 'https://github.com/o/r/pull/1' }, { id: 'a.t-y', status: 'blocked-on-user' }, { id: 'a.t-z', status: 'review' }],
    [{ machine: 'm1', quiet: true, cards: ['a.t-q'], last_seen: '2026-11-03T10:00:00Z' }, { machine: 'm2', quiet: false, cards: [], last_seen: '2026-11-03T10:05:00Z' }],
    [{ seq: 3, from: 'user' }, { seq: 4, from: 'captain@m' }, { seq: 5, from: 'user' }]);
  assert.deepEqual(lines, ['REVIEW a.t-x https://github.com/o/r/pull/1', 'BLOCKED a.t-y', 'QUIET m1 2026-11-03T10:00:00Z', 'IDLE m2', 'CHAT 5']);
  assert.equal(next.chat, 5);
  assert.deepEqual(events(next, [{ id: 'a.t-x', status: 'review' }], [], []).lines, [], 'nothing twice');
});

test('dasks-captain: first harness of the chain on PATH, lease held while it runs, a second captain refused, released at exit', async () => {
  const { root, cleanup } = tempRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-cap-'));
  const fake = path.join(home, 'my-harness');
  fs.writeFileSync(fake, `#!/bin/bash\nprintf '%s %s %s\\n' "$DASKS_ACTOR" "$DASKS_CAPTAIN_LEASE" "$1" > "${home}/harness.log"\nfor i in $(seq 1 1200); do [ -e "${home}/stop" ] && exit 0; sleep 0.1; done\nexit 1\n`, { mode: 0o755 });
  const port = await unusedPort();
  fs.writeFileSync(path.join(root, 'cap-config.json'), JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, captain: { harness: ['no-such-harness {prompt}', `${fake} {prompt_file}`], lease_sec: 30 } }));
  const srv = spawn(NODE[0], [...NODE.slice(1), path.join(ROOT, 'src/server.ts')], { env: { ...clean(), HOME: home, DASKS_ROOT: root, DASKS_CONFIG: path.join(root, 'cap-config.json'), DASKS_AUTH_MODE: 'off' }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const s = { url, stop: async () => { const done = new Promise((r) => srv.once('exit', r)); srv.kill(); await done; } };
  try {
    await until(async () => (await fetch(url + '/api/health')).ok, 15000);
    const env = { ...clean(), HOME: home, DASKS_URL: s.url };
    const harness: string[] = [];
    const dry = spawnSync(path.join(ROOT, 'bin/dasks-captain'), ['--dry-run'], { env: { ...env, DASKS_MACHINE: 'one' }, encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.stdout.split('\n')[0], `harness: ${fake} {prompt_file}`, 'the first harness of the chain that is on PATH');
    assert.match(dry.stdout, /captain skill/);
    assert.equal((await (await fetch(`${s.url}/api/captain`)).json()).lease, null, 'a dry run takes nothing');
    const first = spawn(path.join(ROOT, 'bin/dasks-captain'), harness, { env: { ...env, DASKS_MACHINE: 'one' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; first.stderr!.on('data', (d) => { out += d; });
    await until(() => fs.existsSync(path.join(home, 'harness.log')), 15000);
    const [actor, leaseId, promptFile] = fs.readFileSync(path.join(home, 'harness.log'), 'utf8').trim().split(' ');
    assert.equal(actor, 'captain@one');
    assert.match(leaseId, /^[0-9a-f-]{36}$/);
    assert.match(fs.readFileSync(promptFile, 'utf8'), /dasks-captain-watch/);
    assert.equal((await (await fetch(`${s.url}/api/captain`)).json()).lease.holder, 'captain@one');
    for (const m of ['two', 'one']) {
      const second = spawnSync(path.join(ROOT, 'bin/dasks-captain'), harness, { env: { ...env, DASKS_MACHINE: m }, encoding: 'utf8', timeout: 20000 });
      assert.equal(second.status, 3, second.stderr);
      assert.match(second.stderr, /held by captain@one/);
    }
    fs.writeFileSync(path.join(home, 'stop'), '');
    const code = await new Promise((r) => first.on('exit', r));
    assert.equal(code, 0, out);
    assert.match(out, /lease released/);
    assert.equal((await (await fetch(`${s.url}/api/captain`)).json()).lease, null);
  } finally { await s.stop(); cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

// ---------- dask captain-merge ----------
const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const PR = 'https://github.com/example/proj/pull/7';
const FAKE_GH = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIR/gh.args"
case "$1 $2" in
  "pr view") cat "$FAKE_DIR/view.json" ;;
  "pr ready") if [ -x "$FAKE_DIR/on-ready" ]; then "$FAKE_DIR/on-ready"; fi; exit 0 ;;
  "pr merge") if [ -f "$FAKE_DIR/slow" ]; then sleep 30; fi; exit 0 ;;
  "api repos/example/proj/pulls/7/files") cat "$FAKE_DIR/files.jsonl" ;;
  "api -H") if [ -f "$FAKE_DIR/risk-paths.txt" ]; then cat "$FAKE_DIR/risk-paths.txt"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi ;;
  *) exit 1 ;;
esac
`;
/** A board with this captain config (auth off unless env says otherwise), its own HOME, a port of its own. */
async function captainBoard(root: string, captain: Record<string, unknown>, env: Record<string, string>) {
  const port = await unusedPort();
  const cfgFile = path.join(root, 'cap-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, captain }));
  const full = { ...clean(), DASKS_AUTH_MODE: 'off', ...env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile };
  const srv = spawn(NODE[0], [...NODE.slice(1), path.join(ROOT, 'src/server.ts')], { env: full, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  await until(async () => (await fetch(url + '/api/health')).ok, 15000);
  const token = (...a: string[]) => { const r = spawnSync(NODE[0], [...NODE.slice(1), path.join(ROOT, 'bin/dasks-tokens.ts'), ...a], { env: full, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  return { url, token, stop: async () => { const done = new Promise((r) => srv.once('exit', r)); srv.kill(); await done; } };
}
/** Review cards whose claim history says runner@one built them with claude@one. */
function claimedCards(root: string, cards: string[]) {
  for (const c of cards) {
    const f = path.join(root, 'data/claims/beta', `${c.split('.')[1]}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ partial: false, who: ['runner@one', 'claude@one'] }));
  }
  spawnSync('git', ['-C', root, 'add', '-A']); spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'claims']);
}
const check = (over: Record<string, unknown> = {}) => ({ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', ...over });
const row = (pass: number, o: Record<string, unknown> = {}) => {
  const answer = `review ${pass}`;
  return { pass, head: HEAD, base: 'origin/main', merge_base: '', tier: 'normal', mode: 'simple', reviewer: 'codex', impl: 'claude', verdict: 'clean', open: 0, noted: 0,
    at: '2026-11-03T10:00:00Z', log_sha256: createHash('sha256').update(answer).digest('hex'), answer, ...o };
};

test('captain-merge: CI green on the head, a clean cross-family review of that head and no risk path, or the human decides', async () => {
  const review = (id: string) => task({ id, title: id, status: 'review', pr: PR } as any);
  const cards = ['beta.t-ci', 'beta.t-same', 'beta.t-forged', 'beta.t-self', 'beta.t-nofam', 'beta.t-open', 'beta.t-cap', 'beta.t-ok'];
  const { root, cleanup } = tempRepo([...cards.map(review), task({ id: 'beta.t-todo', title: 'todo', pr: PR } as any)]);
  // The board's own claim records: claude@one built every card (the runner claims beside its build tool's name).
  claimedCards(root, cards);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-merge-'));
  fs.writeFileSync(path.join(dir, 'gh'), FAKE_GH, { mode: 0o755 });
  // Merging on its own, reviews from any machine: the checks below are the ones that still apply then.
  const s = await captainBoard(root, { auto_merge: true, same_machine_review: true }, { HOME: dir });
  const lease = await post(s.url, '/api/captain/lease', 'captain@one', { ttl_sec: 600 });
  assert.equal(lease.status, 200);
  const view = (checks: unknown[], head = HEAD, changedFiles = 1) => fs.writeFileSync(path.join(dir, 'view.json'), JSON.stringify({ url: PR, state: 'OPEN', isDraft: true, headRefOid: head, baseRefName: 'main', statusCheckRollup: checks, changedFiles }));
  const files = (...f: [string, string?][]) => fs.writeFileSync(path.join(dir, 'files.jsonl'), f.map(([a, b]) => JSON.stringify([a, b ?? ''])).join('\n') + '\n');
  const env = { ...clean(), HOME: dir, DASKS_URL: s.url, DASKS_MACHINE: 'one', FAKE_DIR: dir, PATH: `${dir}:/usr/bin:/bin`, DASKS_CAPTAIN_LEASE: lease.body.lease_id };
  const merge = (card: string, ...a: string[]) => spawnSync('python3', [path.join(ROOT, 'bin/dask'), 'captain-merge', card, ...a], { env, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'gh.args'), '');
  const merged = () => /^pr merge/m.test(fs.readFileSync(path.join(dir, 'gh.args'), 'utf8'));
  const refused = async (card: string, why: RegExp) => {
    const r = merge(card);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, why);
    const t = await (await fetch(`${s.url}/api/tasks/${card}`)).json();
    if (t.status === 'review') assert.match(t.body, /captain-merge refused: /);
    assert.ok(!merged(), 'nothing merged');
  };
  try {
    files(['src/app.ts'], ['src/auth/login.ts']);
    view([check()], HEAD, 2);
    await refused('beta.t-todo', /the card is todo, not review/);
    view([]); await refused('beta.t-ci', /no CI checks ran on the head/);
    view([check({ status: 'IN_PROGRESS', conclusion: '' })]); await refused('beta.t-ci', /CI has not finished/);
    view([check(), check({ name: 'lint', conclusion: 'FAILURE' })]); await refused('beta.t-ci', /CI failed on the head: lint \(failure\)/);
    view([{ __typename: 'StatusContext', context: 'ci/old', state: 'PENDING' }]); await refused('beta.t-ci', /not finished on the head: ci\/old/);
    view([check()], HEAD, 2);
    await refused('beta.t-ci', /no cross-model review is recorded for the head/);
    assert.equal((await post(s.url, '/api/tasks/beta.t-same/review-runs', 'claude-code@two', row(1, { reviewer: 'claude example-model', impl: 'claude' }))).status, 201);
    await refused('beta.t-same', /same model family that built it \(anthropic\)/);
    // Declared fields prove nothing: a Claude session that writes "reviewer codex, impl claude" is still a Claude review.
    const forged = await post(s.url, '/api/tasks/beta.t-forged/review-runs', 'claude@two', row(1, { reviewer: 'codex example-model', impl: 'codex' }));
    assert.equal(forged.status, 201);
    assert.equal(forged.body.row.reviewer_family, 'anthropic');
    assert.deepEqual(forged.body.row.builders, ['runner@one', 'claude@one']);
    await refused('beta.t-forged', /same model family that built it \(anthropic\)/);
    await post(s.url, '/api/tasks/beta.t-self/review-runs', 'claude@one', row(1));
    await refused('beta.t-self', /sent by claude@one, who also built the card/);
    await post(s.url, '/api/tasks/beta.t-nofam/review-runs', 'runner@one', row(1));
    await refused('beta.t-nofam', /reviewer at the head \(runner@one\) has no known model family/);
    await post(s.url, '/api/tasks/beta.t-open/review-runs', 'codex@one', row(1, { verdict: 'open', open: 2 }));
    await refused('beta.t-open', /not clean \(2 open\)/);
    await post(s.url, '/api/tasks/beta.t-cap/review-runs', 'captain@one', row(1));
    await refused('beta.t-cap', /no cross-model review is recorded/);
    await post(s.url, '/api/tasks/beta.t-ok/review-runs', 'codex@one', row(1, { head: OLD }));
    await refused('beta.t-ok', /no cross-model review is recorded for the head aaaaaaaaaaaa \(a fix after the review/);
    await post(s.url, '/api/tasks/beta.t-ok/review-runs', 'codex@one', row(2, { mode: 'simple' }));
    fs.writeFileSync(path.join(dir, 'risk-paths.txt'), '# never without a human\nsrc/auth/**\n*.sql\n');
    await refused('beta.t-ok', /the diff touches risk paths: src\/auth\/login\.ts/);
    const msgs = await (await fetch(`${s.url}/api/tasks/beta.t-ok/messages`)).json();
    assert.match(msgs.messages.at(-1).text, /Not merged by the captain: the diff touches risk paths/);
    // A rename out of a risk folder counts its old path; a Unicode name is matched as itself, not as git quotes it.
    files(['src/session.ts', 'src/auth/session.ts']); view([check()], HEAD, 1);
    await refused('beta.t-ok', /risk paths: src\/auth\/session\.ts/);
    files(['src/auth/café.ts']);
    await refused('beta.t-ok', /risk paths: src\/auth\/café\.ts/);
    files(['src/app.ts']); view([check()], HEAD, 3001);
    await refused('beta.t-ok', /GitHub listed 1 of the PR's 3001 changed files/);
    view([check()], HEAD, 1);
    const dry = merge('beta.t-ok', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would merge .* at aaaaaaaaaaaa/);
    // Only the session holding the captain lease merges, and it must still hold it right before the merge.
    for (const [lid, why] of [['', /no captain lease/], ['not-the-lease', /refused the captain lease \(409/]] as const) {
      const r = spawnSync('python3', [path.join(ROOT, 'bin/dask'), 'captain-merge', 'beta.t-ok'], { env: { ...env, DASKS_CAPTAIN_LEASE: lid }, encoding: 'utf8' });
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.match(r.stderr, why);
    }
    const asOther = spawnSync('python3', [path.join(ROOT, 'bin/dask'), 'captain-merge', 'beta.t-ok'], { env: { ...env, DASKS_MACHINE: 'two' }, encoding: 'utf8' });
    assert.equal(asOther.status, 3);
    assert.match(asOther.stderr, /captain@two does not hold the live captain lease/);
    fs.writeFileSync(path.join(dir, 'on-ready'), `#!/bin/bash\ncurl -s -o /dev/null -X POST -H 'Content-Type: application/json' -H 'X-Dasks-Actor: captain@one' -d '{"lease_id":"${lease.body.lease_id}"}' ${s.url}/api/captain/lease/release\n`, { mode: 0o755 });
    const lost = merge('beta.t-ok');
    assert.equal(lost.status, 3, lost.stdout + lost.stderr);
    assert.match(lost.stderr, /captain lease could not be renewed \(409/);
    assert.ok(!merged(), 'a lease lost during the checks merges nothing');
    fs.rmSync(path.join(dir, 'on-ready'));
    const again = await post(s.url, '/api/captain/lease', 'captain@one', { ttl_sec: 600 });
    env.DASKS_CAPTAIN_LEASE = again.body.lease_id;
    // A merge call that hangs is cut off and reported; the card stays in review.
    fs.writeFileSync(path.join(dir, 'slow'), '');
    const t0 = Date.now();
    const slow = spawnSync('python3', [path.join(ROOT, 'bin/dask'), 'captain-merge', 'beta.t-ok'], { env: { ...env, DASKS_MERGE_TIMEOUT_SEC: '1' }, encoding: 'utf8' });
    assert.equal(slow.status, 3, slow.stdout + slow.stderr);
    assert.match(slow.stderr, /the merge call did not finish in 1 s and was stopped/);
    assert.ok(!/merged/.test(slow.stdout) && Date.now() - t0 < 20_000);
    assert.equal((await (await fetch(`${s.url}/api/tasks/beta.t-ok`)).json()).status, 'review');
    fs.rmSync(path.join(dir, 'slow'));
    const ok = merge('beta.t-ok');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const args = fs.readFileSync(path.join(dir, 'gh.args'), 'utf8');
    assert.match(args, new RegExp(`^pr ready ${PR}$`, 'm'), 'a draft is marked ready first');
    assert.match(args, new RegExp(`^pr merge ${PR} --squash --match-head-commit ${HEAD}$`, 'm'), 'merged at exactly the checked head');
    assert.match(args, /^api -H Accept: application\/vnd\.github\.raw repos\/example\/proj\/contents\/risk-paths\.txt\?ref=main$/m, 'risk paths come from the base branch');
    assert.match(args, /^api repos\/example\/proj\/pulls\/7\/files --paginate --jq /m, 'the file list is GitHub\'s structured one');
    const t = await (await fetch(`${s.url}/api/tasks/beta.t-ok`)).json();
    assert.equal(t.status, 'done');
    assert.match(t.body, /merged by the captain at aaaaaaaaaaaa/);
  } finally { await s.stop(); cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('risk-paths.txt globs: ** across folders, * within a name, a folder, a bare name anywhere, a leading / at the root', () => {
  const py = `import importlib.machinery as m, importlib.util as u, json, sys
d = u.module_from_spec(u.spec_from_loader("dask", m.SourceFileLoader("dask", sys.argv[1])))
d.__spec__.loader.exec_module(d)
files = ["src/auth/a/b.ts", "src/authx/a.ts", "db/x.sql", "x.sql", "infra/a.tf", "infra2/a.tf", "web/package.json", "Makefile", "tools/Makefile"]
print(json.dumps({p: d.risk_hits(files, p) for p in ["src/auth/**", "*.sql", "infra/", "package.json", "/Makefile"]}))`;
  const r = spawnSync('python3', ['-c', py, path.join(ROOT, 'bin/dask')], { encoding: 'utf8', env: { ...clean(), DASKS_URL: 'http://127.0.0.1:9' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    'src/auth/**': ['src/auth/a/b.ts'], '*.sql': ['db/x.sql', 'x.sql'], 'infra/': ['infra/a.tf'], 'package.json': ['web/package.json'], '/Makefile': ['Makefile'],
  });
});

test('captain-merge by default: a clean card goes to the human, whose merge OK at that head lets it merge', async () => {
  const card = 'beta.t-ready';
  const { root, cleanup } = tempRepo([task({ id: card, title: 'Ready', status: 'review', pr: PR } as any)]);
  claimedCards(root, [card]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-merge-'));
  fs.writeFileSync(path.join(dir, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'view.json'), JSON.stringify({ url: PR, state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefName: 'main', statusCheckRollup: [check()], changedFiles: 1 }));
  fs.writeFileSync(path.join(dir, 'files.jsonl'), JSON.stringify(['src/app.ts', '']) + '\n');
  fs.writeFileSync(path.join(dir, 'gh.args'), '');
  const sec = humanSecrets();
  const s = await captainBoard(root, {}, { HOME: dir, ...sec.env });
  try {
    const lease = await post(s.url, '/api/captain/lease', 'captain@one', { ttl_sec: 600 });
    await post(s.url, `/api/tasks/${card}/review-runs`, 'codex@two', row(1));
    const env = { ...clean(), HOME: dir, DASKS_URL: s.url, DASKS_MACHINE: 'one', FAKE_DIR: dir, PATH: `${dir}:/usr/bin:/bin`, DASKS_CAPTAIN_LEASE: lease.body.lease_id };
    const merge = () => spawnSync('python3', [path.join(ROOT, 'bin/dask'), 'captain-merge', card], { env, encoding: 'utf8' });
    const first = merge();
    assert.equal(first.status, 3, first.stdout + first.stderr);
    assert.match(first.stderr, /ready to merge: CI green, review clean at aaaaaaaaaaaa, no risk paths/);
    assert.ok(!/^pr merge/m.test(fs.readFileSync(path.join(dir, 'gh.args'), 'utf8')), 'not merged on its own');
    const t = await (await fetch(`${s.url}/api/tasks/${card}`)).json();
    assert.equal(t.status, 'review');
    assert.ok(t.needs_user.startsWith(`head ${HEAD} `), t.needs_user);
    const msgs = await (await fetch(`${s.url}/api/tasks/${card}/messages`)).json();
    assert.match(msgs.messages.at(-1).text, /ready to merge/);
    const ok = await humanDecides(s.url, card, 'approve');
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    const second = merge();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /the human approved this head on the board/);
    assert.match(fs.readFileSync(path.join(dir, 'gh.args'), 'utf8'), new RegExp(`^pr merge ${PR} --squash --match-head-commit ${HEAD}$`, 'm'));
  } finally { await s.stop(); cleanup(); sec.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('captain-merge with auto_merge: a review from the builder\'s machine is refused, one from another machine merges', async () => {
  const card = 'beta.t-auto';
  const { root, cleanup } = tempRepo([task({ id: card, title: 'Auto', status: 'review', pr: PR } as any)]);
  claimedCards(root, [card]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-merge-'));
  fs.writeFileSync(path.join(dir, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'view.json'), JSON.stringify({ url: PR, state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefName: 'main', statusCheckRollup: [check()], changedFiles: 1 }));
  fs.writeFileSync(path.join(dir, 'files.jsonl'), JSON.stringify(['src/app.ts', '']) + '\n');
  fs.writeFileSync(path.join(dir, 'gh.args'), '');
  const s = await captainBoard(root, { auto_merge: true }, { HOME: dir, DASKS_AUTH_MODE: 'enforce' });
  try {
    const one = s.token('machine', 'add', 'one'), two = s.token('machine', 'add', 'two');
    const as = async (actor: string, tok: string, route: string, body: unknown) => {
      const r = await fetch(s.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor, Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const lease = await as('captain@one', one, '/api/captain/lease', { ttl_sec: 600 });
    assert.equal(lease.status, 200, JSON.stringify(lease.body));
    const env = { ...clean(), HOME: dir, DASKS_URL: s.url, DASKS_MACHINE: 'one', DASKS_TOKEN: one, FAKE_DIR: dir, PATH: `${dir}:/usr/bin:/bin`, DASKS_CAPTAIN_LEASE: lease.body.lease_id };
    const merge = () => spawnSync('python3', [path.join(ROOT, 'bin/dask'), 'captain-merge', card], { env, encoding: 'utf8' });
    // The builder's machine token can write as codex@one too: a Codex-looking review from there proves nothing.
    const same = await as('codex@one', one, `/api/tasks/${card}/review-runs`, row(1));
    assert.equal(same.status, 201, JSON.stringify(same.body));
    assert.equal(same.body.row.reviewer_machine, 'one');
    const r1 = merge();
    assert.equal(r1.status, 3, r1.stdout + r1.stderr);
    assert.match(r1.stderr, /sent from one, the machine that built it/);
    assert.equal((await as('codex@two', two, `/api/tasks/${card}/review-runs`, row(2))).status, 201);
    const r2 = merge();
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(fs.readFileSync(path.join(dir, 'gh.args'), 'utf8'), new RegExp(`^pr merge ${PR} --squash --match-head-commit ${HEAD}$`, 'm'));
    assert.equal((await (await fetch(`${s.url}/api/tasks/${card}`)).json()).status, 'done');
  } finally { await s.stop(); cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});
