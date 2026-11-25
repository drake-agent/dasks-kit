// Hands-off mode (src/lib/hands-off.ts): off keeps every person ask; on, a build-stage card never reaches the person
// except for a person-only matter. Each behaviour runs both ways on one board, flipped in config.json while it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { task, tempRepo } from './helpers.ts';
import { asHuman, humanSecrets, serve } from './state-support.ts';
import { handsOffWrite, personOnly } from '../src/lib/hands-off.ts';
import { loadConfig } from '../src/lib/config.ts';

const CONFLICT = {
  kind: 'conflict', before: { quote: 'Exports are CSV only', date: '1999-10-23', ref: 'decisions#3' }, wants: 'Add a JSON export next to CSV',
  code: { behavior: 'only CSV is written', at: 'src/export.ts:9' }, options: [{ key: 'A', text: 'Add JSON', effect: 'proceed' }, { key: 'B', text: 'Keep CSV only', effect: 'cancel' }],
  rec: { key: 'A', why: 'the code already has a writer per format' },
};
const TASTE = { kind: 'taste', wants: 'Badge colour: navy or grey', options: [{ key: 'A', text: 'Navy', effect: 'proceed' }, { key: 'B', text: 'Grey', effect: 'proceed' }], rec: { key: 'B', why: 'matches the other screens' } };

async function board(ids: [string, string][], env: Record<string, string> = {}) {
  const { root, cleanup } = tempRepo(ids.map(([id, status]) => task({ id, status: status as any, pr: status === 'review' ? 'https://github.com/example/proj/pull/7' : '' } as any)));
  const s = await serve(root, env);
  const cfg = path.join(root, 'test-config.json');
  const set = (on: boolean) => fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), hands_off: { enabled: on } }));
  const get = async (id: string) => (await fetch(`${s.url}/api/tasks/${id}`)).json();
  return { s, set, get, stop: async () => { await s.stop(); cleanup(); } };
}

test('person-only words and the write rule', () => {
  for (const t of ['Pay for the larger plan?', '결제가 필요합니다', 'Delete the old exports folder?', 'Store the API key in the keychain', 'Plug in the iPhone', 'Pick the colour of the badge', '디자인 취향 고르기'])
    assert.ok(personOnly(t), t);
  // Credentials of any kind are the person's (review R6).
  for (const t of ['Rotate the GitHub token for the deploy job', 'Add a credential for the registry', 'Log in to the store account', 'Sign in again on the build Mac', 'New SSH key for the runner', 'API 키 교체', 'The signing certificate expired'])
    assert.ok(personOnly(t), t);
  for (const t of ['merge approval needed', 'review limit reached with R1 open', 'waiting on another card', 'deploy to staging?']) assert.ok(!personOnly(t), t);
  const cur = task({ id: 'beta.t-w', status: 'review' });
  assert.deepEqual(handsOffWrite(cur, { status: 'blocked-on-user' }, 'merge it?', { actor: 'job-runner', hasAsk: false, owner: 'beta-lead' })?.fields, { status: undefined, needs_user: '' });
  assert.equal(handsOffWrite(cur, { status: 'blocked-on-user' }, 'merge it?', { actor: 'user', hasAsk: false, owner: 'beta-lead' }), null, "the person's own write");
  assert.equal(handsOffWrite(task({ id: 'beta.t-s', status: 'todo' }), { needs_user: 'Split the card?' }, '', { actor: 'spec', hasAsk: false, owner: 'beta-lead' }), null, 'spec stage asks');
  assert.equal(handsOffWrite(cur, { needs_user: 'Delete the old table? If approved, it is dropped.' }, '', { actor: 'job-runner', hasAsk: false, owner: 'x' }), null, 'person-only');
  // A new question alone on a doing card moves it like a park, so the note and the move agree (review R2).
  assert.deepEqual(handsOffWrite(task({ id: 'beta.t-q', status: 'doing' }), { needs_user: 'Split this card in two?' }, '', { actor: 'job-runner', hasAsk: false, owner: 'beta-lead' })?.fields,
    { status: 'todo', lane: 'spec-rework', next_owner: 'beta-lead', needs_user: '' });
  // A person-only word in the rest of the write (the context block) keeps the ask (review R5).
  assert.equal(handsOffWrite(task({ id: 'beta.t-q', status: 'doing' }), { status: 'blocked-on-user' }, 'w y Delete the old exports folder? r a', { actor: 'job-runner', hasAsk: false, owner: 'x' }), null);
  assert.throws(() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-ho-')); fs.writeFileSync(path.join(d, 'config.json'), '{"hands_off":{"enabled":"yes"}}'); try { loadConfig(d); } finally { fs.rmSync(d, { recursive: true }); } }, /hands_off.enabled must be true or false/);
});

test('review and doing cards: a park or a build-stage question reaches the person only when hands-off is off', async () => {
  const b = await board([['beta.t-r1', 'review'], ['beta.t-r2', 'review'], ['beta.t-d1', 'doing'], ['beta.t-d2', 'doing'], ['beta.t-r3', 'review'], ['beta.t-d3', 'doing'], ['beta.t-d4', 'doing'], ['beta.t-d5', 'doing']]);
  const ask = 'head ' + 'a'.repeat(40) + ' Merge this PR? If approved, the captain merges exactly this head.';
  try {
    // Off (the default): unchanged.
    assert.equal((await (await fetch(`${b.s.url}/api/status`)).json()).hands_off, false);
    assert.equal((await b.s.post('/api/tasks/beta.t-r1', { needs_user: ask }, 'captain@one')).status, 200);
    assert.equal((await b.get('beta.t-r1')).needs_user, ask);
    const decides = async () => ((await (await fetch(`${b.s.url}/api/board`)).json()).tasks as any[]).filter((t) => t.decision_request).map((t) => t.id).sort();
    assert.deepEqual(await decides(), ['beta.t-r1', 'beta.t-r2', 'beta.t-r3'], 'off: review cards ask approve/reject');
    const off = await b.s.post('/api/tasks/beta.t-d1', { status: 'blocked-on-user', needs_user: 'Merge approval needed: approve it? If approved, it merges.', what: 'w', why: 'y', do: 'd', rec: 'r', after: 'a' }, 'job-runner');
    assert.equal(off.status, 200, await off.text());
    assert.equal((await b.get('beta.t-d1')).status, 'blocked-on-user');
    // On, with no restart.
    b.set(true);
    assert.equal((await (await fetch(`${b.s.url}/api/status`)).json()).hands_off, true);
    assert.equal((await (await fetch(`${b.s.url}/api/health`)).json()).hands_off, true);
    assert.deepEqual(await decides(), ['beta.t-d1'], 'on: review cards ask nothing; a card already on the person stays');
    assert.equal((await b.s.post('/api/tasks/beta.t-r2', { needs_user: ask }, 'captain@one')).status, 200);
    let t = await b.get('beta.t-r2');
    assert.equal(t.status, 'review'); assert.equal(t.needs_user ?? '', ''); assert.match(t.body, /hands-off: not asked of the person, it stays in review for the captain/);
    const on = await b.s.post('/api/tasks/beta.t-d2', { status: 'blocked-on-user', needs_user: 'Merge approval needed: approve it? If approved, it merges.', what: 'w', why: 'y', do: 'd', rec: 'r', after: 'a' }, 'job-runner');
    assert.equal(on.status, 200, await on.text());
    t = await b.get('beta.t-d2');
    assert.deepEqual([t.status, t.lane, t.needs_user ?? ''], ['todo', 'spec-rework', '']); assert.match(t.body, /goes back to the card's spec stage/);
    // A review-limit block on a review card stays in review.
    assert.equal((await b.s.post('/api/tasks/beta.t-r3', { status: 'blocked-on-user', note: 'review limit reached with R1 open', what: 'w', why: 'y', do: 'd', rec: 'r', after: 'a' }, 'job-runner')).status, 200);
    assert.equal((await b.get('beta.t-r3')).status, 'review');
    // A person-only matter still parks.
    const money = await b.s.post('/api/tasks/beta.t-d3', { status: 'blocked-on-user', needs_user: 'Pay for the larger CI plan? If approved, the build runs there.', what: 'w', why: 'y', do: 'd', rec: 'r', after: 'a' }, 'job-runner');
    assert.equal(money.status, 200, await money.text());
    assert.equal((await b.get('beta.t-d3')).status, 'blocked-on-user');
    // Review R2: a new question alone on a doing card goes back to the spec stage, as its note says.
    assert.equal((await b.s.post('/api/tasks/beta.t-d4', { needs_user: 'Split this card in two? If approved, two cards are made.' }, 'job-runner')).status, 200);
    t = await b.get('beta.t-d4');
    assert.deepEqual([t.status, t.lane, t.needs_user ?? ''], ['todo', 'spec-rework', '']); assert.match(t.body, /goes back to the card's spec stage/);
    // Review R5: the ask can sit in the context block only; a deletion there still reaches the person.
    const del = await b.s.post('/api/tasks/beta.t-d5', { status: 'blocked-on-user', what: 'Old exports fill the disk', why: 'the job cannot write', do: 'Delete the old exports folder? If approved, the job deletes it.', rec: 'delete it', after: 'the job runs again' }, 'job-runner');
    assert.equal(del.status, 200, await del.text());
    t = await b.get('beta.t-d5');
    assert.equal(t.status, 'blocked-on-user'); assert.doesNotMatch(t.body, /hands-off: not asked/);
  } finally { await b.stop(); }
});

test('asks and needs-user outcomes: build-stage ones become card notes when on; spec stage and person-only ones still ask', async () => {
  const b = await board([['beta.t-a1', 'doing'], ['beta.t-a2', 'doing'], ['beta.t-a3', 'doing'], ['beta.t-a4', 'todo'], ['beta.t-a5', 'review'], ['beta.t-o1', 'doing'], ['beta.t-o2', 'doing'], ['beta.t-o3', 'doing'], ['beta.t-o4', 'review'], ['beta.t-c1', 'doing'], ['beta.t-c2', 'doing']]);
  const out = (id: string, body: Record<string, unknown>) => b.s.post(`/api/tasks/${id}/outcome`, body, 'job-runner');
  const fail = (id: string, j: string) => out(id, { state: 'failed', note: 'tests failed', job: j });
  try {
    // Off: a build-stage conflict ask parks, a merge-shaped outcome parks, a retry cap parks.
    assert.equal((await b.s.post('/api/asks/beta.t-a1', CONFLICT, 'job-runner')).status, 201);
    assert.equal((await b.get('beta.t-a1')).status, 'blocked-on-user');
    assert.equal((await out('beta.t-o1', { state: 'needs-user', note: 'merge approval needed', job: 'o1' })).status, 200);
    assert.equal((await b.get('beta.t-o1')).status, 'blocked-on-user');
    for (const j of ['c1a', 'c1b']) { await b.s.post('/api/tasks/beta.t-c1', { status: 'doing' }, 'job-runner'); assert.equal((await fail('beta.t-c1', j)).status, 200); }
    assert.deepEqual([(await b.get('beta.t-c1')).status, (await b.get('beta.t-c1')).lane], ['blocked-on-user', 'failed-terminal']);
    b.set(true);
    let r = await b.s.post('/api/asks/beta.t-a2', CONFLICT, 'job-runner');
    assert.equal(r.status, 200, await r.clone().text()); assert.equal((await r.json()).routed, 'note');
    let t = await b.get('beta.t-a2');
    // Review R3: the doing card goes back to its spec stage, like every other build-stage route.
    assert.deepEqual([t.status, t.lane, t.next_owner, t.needs_user ?? ''], ['todo', 'spec-rework', 'beta-lead', '']); assert.match(t.body, /hands-off: not asked of the person, it goes back to the card's spec stage.*Add a JSON export/);
    r = await b.s.post('/api/asks/beta.t-a5', CONFLICT, 'job-runner');
    assert.equal(r.status, 200); t = await b.get('beta.t-a5');
    assert.equal(t.status, 'review'); assert.match(t.body, /it stays in review for the captain/);
    assert.equal((await b.s.post('/api/asks/beta.t-a3', TASTE, 'job-runner')).status, 201, 'a taste pick still asks');
    assert.equal((await b.s.post('/api/asks/beta.t-a4', CONFLICT, 'spec')).status, 201, 'the spec stage still asks');
    assert.equal((await out('beta.t-o2', { state: 'needs-user', note: 'merge approval needed', job: 'o2' })).status, 200);
    t = await b.get('beta.t-o2');
    assert.deepEqual([t.status, t.lane, t.needs_user ?? ''], ['todo', 'spec-rework', '']); assert.match(t.body, /hands-off: not asked of the person/);
    assert.equal((await out('beta.t-o3', { state: 'needs-user', note: 'pay for the larger CI plan', job: 'o3' })).status, 200);
    assert.equal((await b.get('beta.t-o3')).status, 'blocked-on-user', 'money still asks');
    // Review R4: a needs-user outcome on a review card keeps it in review, as its note says.
    const o4 = await out('beta.t-o4', { state: 'needs-user', note: 'merge approval needed', job: 'o4' }); assert.equal(o4.status, 200, await o4.clone().text());
    t = await b.get('beta.t-o4');
    assert.deepEqual([t.status, t.needs_user ?? ''], ['review', '']); assert.match(t.body, /it stays in review for the captain/);
    for (const j of ['c2a', 'c2b']) { await b.s.post('/api/tasks/beta.t-c2', { status: 'doing' }, 'job-runner'); assert.equal((await fail('beta.t-c2', j)).status, 200); }
    t = await b.get('beta.t-c2');
    assert.deepEqual([t.status, t.lane, t.needs_user ?? ''], ['todo', 'spec-rework', '']);
    assert.equal((await b.s.post('/api/tasks/beta.t-c2/claim', { who: 'job-runner' }, 'job-runner')).status, 409, 'the capped card is not claimed again before a reset');
  } finally { await b.stop(); }
});

test('dasks hands-off on|off|status writes config.json and keeps its other keys', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-ho-'));
  try {
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ retry_cap: 3 }));
    const run = (a: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli/hands-off.ts', a], { env: { ...process.env, DASKS_ROOT: d, DASKS_CONFIG: '' }, encoding: 'utf8' });
    assert.match(run('status').stdout, /hands-off: off/);
    const on = run('on');
    assert.equal(on.status, 0, on.stderr); assert.match(on.stdout, /hands-off: on .*No server restart needed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')), { retry_cap: 3, hands_off: { enabled: true } });
    assert.match(run('on').stdout, /unchanged/);
    run('off');
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')).hands_off.enabled, false);
    assert.equal(run('maybe').status, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a quiet review card: no decision request to read, and the person\'s own status change goes through (review R7)', async () => {
  const sec = humanSecrets();
  const b = await board([['beta.t-q1', 'review'], ['beta.t-q2', 'review']], sec.env);
  try {
    assert.equal((await asHuman(b.s.url, '/api/decisions/request/beta.t-q1')).status, 200, 'off: the review card asks');
    assert.equal((await asHuman(b.s.url, '/api/tasks/beta.t-q1', { status: 'done' })).status, 409, 'off: a decision first');
    b.set(true);
    assert.equal((await asHuman(b.s.url, '/api/decisions/request/beta.t-q2')).status, 409, 'on: nothing is asked');
    const r = await asHuman(b.s.url, '/api/tasks/beta.t-q2', { status: 'done' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await b.get('beta.t-q2')).status, 'done');
  } finally { await b.stop(); sec.cleanup(); }
});

test('dasks hands-off runs from an install path with a space in it (review R8)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-ho-'));
  const kit = path.join(d, 'Kit With Spaces');
  try {
    fs.mkdirSync(kit);
    for (const x of ['bin', 'mcp', 'src', 'public', 'package.json']) fs.cpSync(x, path.join(kit, x), { recursive: true });
    fs.symlinkSync(path.resolve('node_modules'), path.join(kit, 'node_modules'));
    const data = path.join(d, 'data'); fs.mkdirSync(data);
    const r = spawnSync(path.join(kit, 'bin/dasks'), ['hands-off', 'on'], { env: { ...process.env, DASKS_ROOT: data, DASKS_CONFIG: '' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /hands-off: on/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).hands_off.enabled, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
