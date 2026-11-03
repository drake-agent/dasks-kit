import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createTask, serializeTask } from '../src/lib/write.ts';
import { loadBoard, parseFrontmatter, taskFromParsed } from '../src/lib/load.ts';
import { checkTask } from '../src/lib/check.ts';
import { readyQueue } from '../src/lib/ready.ts';
import { MAX_ACTIVITY } from '../src/lib/collab.ts';
import { committedSpecIndex, effectiveSpecState, headSha } from '../src/lib/spec-state.ts';
import { task as taskFixture, tempRepo } from './helpers.ts';
import { freePort, sha256 as sha, snapshotFiles, stopServer } from './spec-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const MCP = path.join(ROOT, 'mcp/dasks-mcp.mjs');
const PASS = 'spec state test passphrase 9';

// Actors. Families by the default prefixes (human-claude* anthropic, codex* openai) and the config below (gemini* google).
const A = 'human-claude@laptop-a', B = 'human-claude@laptop-b', C = 'codex@laptop-c', D = 'gemini@host-d';
const E = 'human-claude@laptop-e', F = 'human-claude@laptop-f', G = 'codex@laptop-g';
const UNKNOWN = 'zed@nowhere';
// Config families for test 6: an exact override and two overlapping prefixes.
const FAMILIES = { 'human-claude@laptop-x': 'openai', 'gemini*': 'google', 'zz*': 'google', 'zzz-open*': 'openai' };

// ---------- card texts (contract.py card: no hard errors) ----------
interface CardOpts { size?: string | null; acc?: string | null; oracle?: string | null; bg?: string; head?: string }
function card(o: CardOpts = {}): string {
  const size = o.size === undefined ? 'small' : o.size;
  const acc = o.acc === undefined ? '1. GET returns the text.\n2. PUT stores a version.\n' : o.acc;
  const ora = o.oracle === undefined ? null : o.oracle;
  return 'id: shared.t-spec\ngoal: shared\nrole: builder\ntier: 1\nrepo: example-org/dasks\nbranch: human/shared.t-spec\nlane: none\n'
    + `deadline: 2026-11-01\n${size === null ? '' : `size: ${size}\n`}depends_on: none\nimpl: claude\nreview: codex\n${o.head ?? ''}`
    + 'done_when: the board shows the spec\ndone_at: pr\n' + 'pass_checks:\n  - npm test is green\n  - GET returns the text\n  - over the cap is 413\n'
    + `\n## Background\n${o.bg ?? 'Background text.'}\n\n## Why\nBecause.\n\n## Context pack\n- docs/x.md\n\n## Tests\n- test/x.test.ts\n`
    + (acc === null ? '' : `\n## Acceptance tests\n${acc}`)
    + (ora === null ? '' : `\n## Oracle\n${ora}`)
    // A closing section, so adding or removing the Oracle never changes the Acceptance section's bytes.
    + '\n## Notes\nend\n';
}

// ---------- servers ----------
function writePassphrase(dir: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(PASS.normalize('NFC'), salt, 32, { N: 1024, r: 8, p: 1 });
  fs.writeFileSync(path.join(dir, 'passphrase'), `scrypt$1024$8$1$${salt.toString('base64')}$${hash.toString('base64')}\n`, { mode: 0o600 });
}
interface Srv { url: string; port: number; proc: ChildProcess }
async function startServer(root: string, secrets: string, extraCfg: Record<string, unknown> = {}): Promise<Srv> {
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, families: FAMILIES, ...extraCfg }));
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '',
      DASKS_RELOAD_GATE: path.join(root, '.reload-gate'),
      DASKS_SECRETS_DIR: secrets, DASKS_PASSPHRASE_FILE: path.join(secrets, 'passphrase'), DASKS_UNSAFE_OWN_PASSPHRASE_FILE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, port, proc }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
}

interface Res { status: number; body: any }
function api(s: Srv) {
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const r = await fetch(s.url + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  };
  const as = (actor: string | null): Record<string, string> => (actor === null ? {} : { 'X-Dasks-Actor': actor });
  const o = {
    call, as,
    task: async (id: string) => (await call('GET', `/api/tasks/${id}`)).body,
    spec: async (id: string, q = '') => call('GET', `/api/tasks/${id}/spec${q}`),
    specVersion: async (id: string): Promise<number> => { const r = await o.spec(id); return r.status === 404 ? 0 : r.body.metadata.version; },
    putAt: (id: string, text: string, ev: number, actor: string) => call('PUT', `/api/tasks/${id}/spec`, { text, expected_spec_version: ev }, as(actor)),
    /** PUT at the current spec version. */
    put: async (id: string, text: string, actor: string) => o.putAt(id, text, await o.specVersion(id), actor),
    claim: (id: string, actor: string, body: Record<string, unknown> = {}) => call('POST', `/api/tasks/${id}/claim`, body, as(actor)),
    release: (id: string, actor: string, body: Record<string, unknown> = {}) => call('POST', `/api/tasks/${id}/release`, body, as(actor)),
    review: (id: string, body: unknown, actor: string | null, h: Record<string, string> = {}) => call('POST', `/api/tasks/${id}/spec/review`, body, { ...as(actor), ...h }),
    block: (id: string, body: unknown, actor: string | null, h: Record<string, string> = {}) => call('POST', `/api/tasks/${id}/spec/block`, body, { ...as(actor), ...h }),
    unblock: (id: string, body: unknown, actor: string | null, h: Record<string, string> = {}) => call('POST', `/api/tasks/${id}/spec/unblock`, body, { ...as(actor), ...h }),
    /** Block / unblock / review at the current task and spec versions. */
    blockNow: async (id: string, actor: string, note = 'blocked for Spec: answer key is stale') =>
      o.block(id, { expected_version: (await o.task(id)).version, expected_spec_version: await o.specVersion(id), block_note: note }, actor),
    unblockNow: async (id: string, actor: string | null, h: Record<string, string> = {}) =>
      o.unblock(id, { expected_version: (await o.task(id)).version, expected_spec_version: await o.specVersion(id) }, actor, h),
    reviewNow: async (id: string, verdict: string, actor: string) => o.review(id, { spec_version: await o.specVersion(id), verdict }, actor),
    ready: (q = '') => call('GET', `/api/ready${q}`),
  };
  return o;
}
type Api = ReturnType<typeof api>;

/** The logged-in human: cookie + CSRF + same-origin Origin (requireHuman). */
async function login(s: Srv): Promise<Record<string, string>> {
  const r = await fetch(s.url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${s.port}` }, body: JSON.stringify({ method: 'passphrase', passphrase: PASS }) });
  assert.equal(r.status, 200, 'login');
  const csrf = (await r.json()).csrf;
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('dasks_session='))!.split(';')[0];
  return { Cookie: cookie, 'X-Dasks-CSRF': csrf, Origin: `http://127.0.0.1:${s.port}`, 'X-Dasks-Actor': 'user' };
}

interface Ctx { root: string; secrets: string; s: Srv; g: Api; mk: (title: string, over?: Record<string, unknown>) => string; restart: () => Promise<void> }
async function withBoard(fn: (c: Ctx) => Promise<void>, extraCfg: Record<string, unknown> = {}, fixtures: ReturnType<typeof taskFixture>[] = []) {
  const { root, cleanup } = tempRepo(fixtures);
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-secrets-'));
  fs.chmodSync(secrets, 0o700); writePassphrase(secrets);
  let s = await startServer(root, secrets, extraCfg);
  activeUrl = s.url; unseen.length = 0;
  const c: Ctx = {
    root, secrets, s, g: api(s),
    // Tasks made through createTask get an empty, complete claim history.
    mk: (title, over = {}) => { const id = createTask(root, { goal: 'shared', title, ...over }, 'helper').id; unseen.push(id); return id; },
    restart: async () => { await stopServer(c.s.proc); s = await startServer(root, secrets, extraCfg); c.s = s; c.g = api(s); activeUrl = s.url; },
  };
  try { await fn(c); } finally { await stopServer(c.s.proc); cleanup(); fs.rmSync(secrets, { recursive: true, force: true }); }
}
// Tasks made with mk() that the server may not have loaded yet, and the server they belong to (tests run one at a time).
const unseen: string[] = [];
let activeUrl = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Give the watcher time to reload, then wait until the server shows every task mk() made (a slow watcher can take
 *  longer than any fixed wait). */
const settle = async () => {
  await sleep(400);
  for (const id of unseen.splice(0)) {
    for (let i = 0; i < 100 && !(await fetch(`${activeUrl}/api/tasks/${id}`)).ok; i++) await sleep(100);
  }
};
/** Poll a condition (100 ms steps, at most 10 s), then fail with `what`. */
const waitFor = async (ok: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i++) { if (await ok()) return; await sleep(100); }
  assert.fail(`timed out after 10 s waiting until ${what}`);
};
const head = (root: string) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const claimsRel = (id: string) => { const [g, slug] = id.split(/\.(.*)/s); return `data/claims/${g}/${slug}.json`; };
function history(root: string, id: string): { partial: boolean; who: string[] } | null {
  try { return JSON.parse(fs.readFileSync(path.join(root, claimsRel(id)), 'utf8')); } catch { return null; }
}
/** Everything a refused write must leave alone. */
function snapshot(root: string, id: string) {
  const files = snapshotFiles(root, ['data/specs', 'data/claims']);
  const [g, slug] = id.split(/\.(.*)/s);
  return { files, task: fs.readFileSync(path.join(root, `data/tasks/${g}/${slug}.md`), 'utf8'), head: head(root) };
}
const okStatus = (r: Res, want = 200, what = '') => assert.equal(r.status, want, `${what} ${JSON.stringify(r.body)}`);

// ---------- 1. claims refused to the answer key's authors ----------
test('1 claim: an Acceptance or Oracle author can never claim (who, force, expired lease, user session); others can', () => withBoard(async (c) => {
  const id = c.mk('Answer key card'); await settle();
  okStatus(await c.g.put(id, card(), A), 200, 'A writes Acceptance');
  okStatus(await c.g.claim(id, B), 200, 'B claims');
  okStatus(await c.g.release(id, B), 200, 'B releases');
  const before = { t: await c.g.task(id), h: history(c.root, id) };
  let r = await c.g.claim(id, A);
  okStatus(r, 409); assert.match(r.body.error, /you wrote the answer key/);
  const after = await c.g.task(id);
  assert.equal(after.version, before.t.version); assert.equal(after.claimed_by, ''); assert.equal(after.spec_state, before.t.spec_state);
  assert.deepEqual(history(c.root, id), before.h);
  r = await c.g.claim(id, B, { who: A }); okStatus(r, 409); assert.match(r.body.error, /you wrote the answer key/);
  r = await c.g.claim(id, A, { force: true }); okStatus(r, 409); assert.match(r.body.error, /you wrote the answer key/);
  const human = await login(c.s);
  r = await c.g.call('POST', `/api/tasks/${id}/claim`, { who: A }, human); okStatus(r, 409); assert.match(r.body.error, /you wrote the answer key/);
  // Oracle-only author: D changes only the Oracle.
  okStatus(await c.g.put(id, card({ oracle: 'sha256 of fixture A = abc\n' }), D), 200);
  r = await c.g.claim(id, D); okStatus(r, 409); assert.match(r.body.error, /you wrote the answer key/);
  // C edits only Background: A (Acceptance) and D (Oracle) keep their authorship; C may claim.
  okStatus(await c.g.put(id, card({ oracle: 'sha256 of fixture A = abc\n', bg: 'Background by C.' }), C), 200);
  const sp = (await c.g.spec(id)).body;
  assert.equal(sp.section_authors.acceptance_tests.by, A); assert.equal(sp.section_authors.oracle.by, D);
  r = await c.g.claim(id, A); okStatus(r, 409); assert.match(r.body.error, /you wrote the answer key/);
  okStatus(await c.g.claim(id, C), 200, 'C claims');
}));

test('1 claim: an expired lease does not let the answer key author take the card', () => withBoard(async (c) => {
  const id = c.mk('Lease card'); await settle();
  okStatus(await c.g.put(id, card(), A), 200);
  okStatus(await c.g.claim(id, B), 200);
  await new Promise((r) => setTimeout(r, 1500)); // stale_hours 0.0002 h = 0.72 s
  const r = await c.g.claim(id, A); okStatus(r, 409); assert.match(r.body.error, /you wrote the answer key/);
  assert.equal((await c.g.task(id)).claimed_by, B);
  okStatus(await c.g.claim(id, E), 200, 'a stale claim is still up for grabs for others');
}, { stale_hours: 0.0002 }));

// ---------- 2. implementers cannot touch protected sections ----------
test('2 protected sections: a history member adding, changing, removing or restoring Acceptance or Oracle gets 403; Background passes', () => withBoard(async (c) => {
  const id = c.mk('Protected card'); await settle();
  const acc1 = '1. first answer key\n', acc2 = '1. second answer key\n';
  const or1 = 'oracle one\n', or2 = 'oracle two\n';
  okStatus(await c.g.put(id, card({ acc: acc1 }), A), 200);
  okStatus(await c.g.claim(id, B), 200); okStatus(await c.g.release(id, B), 200);
  const refused = async (text: string, what: string) => { const r = await c.g.put(id, text, B); okStatus(r, 403, what); };
  await refused(card({ acc: acc1, oracle: or1 }), 'B adds Oracle');
  okStatus(await c.g.put(id, card({ acc: acc1, oracle: or1 }), A), 200);
  await refused(card({ acc: acc1, oracle: or2 }), 'B changes Oracle');
  await refused(card({ acc: acc1, oracle: null }), 'B removes Oracle');
  okStatus(await c.g.put(id, card({ acc: acc1, oracle: or2 }), A), 200);
  await refused(card({ acc: acc1, oracle: or1 }), 'B restores the old Oracle');
  await refused(card({ acc: acc2, oracle: or2 }), 'B changes Acceptance');
  await refused(card({ acc: null, oracle: or2 }), 'B removes Acceptance');
  okStatus(await c.g.put(id, card({ acc: null, oracle: or2 }), A), 200);
  await refused(card({ acc: acc2, oracle: or2 }), 'B adds Acceptance');
  okStatus(await c.g.put(id, card({ acc: acc2, oracle: or2 }), A), 200);
  await refused(card({ acc: acc1, oracle: or2 }), 'B restores the old Acceptance');
  // Background only: stored, authors unchanged.
  const authors = (await c.g.spec(id)).body.section_authors;
  okStatus(await c.g.put(id, card({ acc: acc2, oracle: or2, bg: 'B fixes a typo in Background.' }), B), 200);
  const sp = (await c.g.spec(id)).body;
  assert.deepEqual(sp.section_authors, authors); assert.equal(sp.metadata.by, B);
}));

// ---------- 3. claim history ----------
test('3 history: effective who is recorded, survives release, a long activity log and restart; refused claims add nothing', () => withBoard(async (c) => {
  const id = c.mk('History card'); await settle();
  assert.deepEqual(history(c.root, id), { partial: false, who: [] });
  okStatus(await c.g.put(id, card(), A), 200);
  okStatus(await c.g.claim(id, B, { who: C }), 200, 'B claims for C');
  assert.deepEqual(history(c.root, id), { partial: false, who: [C, B] });
  okStatus(await c.g.release(id, B, { who: C }), 200);
  // More than MAX_ACTIVITY activity entries: the claim is long gone from the capped log.
  const [g, slug] = id.split(/\.(.*)/s);
  const act = path.join(c.root, `data/activity/${g}/${slug}.jsonl`);
  const lines = Array.from({ length: MAX_ACTIVITY + 20 }, (_, i) => JSON.stringify({ at: '2026-10-24T10:00:00+09:00', actor: 'helper', action: 'note', note: `n${i}` }));
  fs.mkdirSync(path.dirname(act), { recursive: true }); fs.writeFileSync(act, lines.join('\n') + '\n');
  execFileSync('git', ['-C', c.root, 'add', 'data']); execFileSync('git', ['-C', c.root, 'commit', '-qm', 'long activity']);
  await c.restart();
  let r = await c.g.put(id, card({ acc: '1. C rewrites the key\n' }), C); okStatus(r, 403, 'C changes Acceptance');
  r = await c.g.put(id, card({ oracle: 'C adds an oracle\n' }), C); okStatus(r, 403, 'C adds Oracle');
  // A refused claim records nothing.
  const h0 = history(c.root, id);
  okStatus(await c.g.claim(id, A), 409);
  assert.deepEqual(history(c.root, id), h0);
}));

test('3 history: a task without a claim history is seeded once from claimed_by + activity, marked partial, not reseeded, and refuses nothing', async () => {
  const bare = taskFixture({ id: 'shared.t-bare', goal: 'shared', title: 'Bare card', milestone: 'shared.m1' });
  await withBoard(async (c) => {
    const id = bare.id;
    fs.mkdirSync(path.join(c.root, 'data/activity/shared'), { recursive: true });
    const act = path.join(c.root, 'data/activity/shared/t-bare.jsonl');
    fs.writeFileSync(act, JSON.stringify({ at: '2026-10-01T10:00:00+09:00', actor: 'old-worker@desktop', action: 'claim', note: '' }) + '\n');
    execFileSync('git', ['-C', c.root, 'add', 'data']); execFileSync('git', ['-C', c.root, 'commit', '-qm', 'activity']);
    await settle();
    assert.equal(history(c.root, id), null, 'no history before the first claim');
    okStatus(await c.g.put(id, card(), A), 200);
    okStatus(await c.g.claim(id, B), 200);
    const seeded = history(c.root, id)!;
    assert.equal(seeded.partial, true);
    assert.ok(seeded.who.includes('old-worker@desktop') && seeded.who.includes(B), JSON.stringify(seeded));
    okStatus(await c.g.release(id, B), 200);
    // More activity of that kind, a restart, another claim: no reseed.
    fs.appendFileSync(act, JSON.stringify({ at: '2026-10-24T10:00:00+09:00', actor: 'late-worker@desktop', action: 'claim', note: '' }) + '\n');
    execFileSync('git', ['-C', c.root, 'add', 'data']); execFileSync('git', ['-C', c.root, 'commit', '-qm', 'more activity']);
    await c.restart();
    okStatus(await c.g.claim(id, E), 200); okStatus(await c.g.release(id, E), 200);
    const h = history(c.root, id)!;
    assert.equal(h.partial, true); assert.ok(!h.who.includes('late-worker@desktop')); assert.deepEqual(h.who, [...seeded.who, E]);
    // Partial history refuses nothing: B (a claimant) may still change the Acceptance.
    okStatus(await c.g.put(id, card({ acc: '1. B edits a seeded key\n' }), B), 200, 'partial history: no 403');
  }, {}, [bare]);
});

// ---------- 4. check order ----------
test('4 PUT /spec order: version 409 → contract 422 → protected 403; every refusal leaves everything unchanged', () => withBoard(async (c) => {
  const id = c.mk('Order card'); await settle();
  okStatus(await c.g.put(id, card(), A), 200);
  okStatus(await c.g.claim(id, B), 200); okStatus(await c.g.release(id, B), 200);
  const forbiddenInvalid = card({ acc: '1. B rewrites\n' }).replace(/^role: builder\n/m, '');
  const forbiddenValid = card({ acc: '1. B rewrites\n' });
  const cur = await c.g.specVersion(id);
  for (const [text, ev, want] of [[forbiddenInvalid, cur - 1, 409], [forbiddenInvalid, cur, 422], [forbiddenValid, cur, 403]] as const) {
    const before = snapshot(c.root, id);
    const r = await c.g.putAt(id, text, ev, B);
    okStatus(r, want, `ev ${ev}`);
    assert.deepEqual(snapshot(c.root, id), before, `refusal ${want} changed nothing`);
  }
}));

// ---------- 5. size and state ----------
test('5 state: Acceptance + size decide draft/ready; big needs a pass for the current version; a new version clears it', () => withBoard(async (c) => {
  const state = async (id: string) => (await c.g.task(id)).spec_state;
  const t = c.mk('State card'); await settle();
  assert.equal(await state(t), 'none');
  for (const acc of [null, '', '   \n\t\n']) {
    okStatus(await c.g.put(t, card({ acc }), A), 200);
    assert.equal(await state(t), 'draft', `Acceptance ${JSON.stringify(acc)} → draft`);
  }
  for (const size of ['small', 'big', null, 'medium']) {
    okStatus(await c.g.put(t, card({ size }), A), 200);
    assert.equal(await state(t), 'draft', `size ${size} + Acceptance → draft until reviewed`);
    okStatus(await c.g.reviewNow(t, 'pass', C), 200);
    assert.equal(await state(t), 'ready', `size ${size}: pass for this version → ready`);
  }
  okStatus(await c.g.reviewNow(t, 'fail', C), 200);
  assert.equal(await state(t), 'draft', 'pass then fail → draft');
  okStatus(await c.g.reviewNow(t, 'pass', C), 200); assert.equal(await state(t), 'ready');
  const same = (await c.g.spec(t)).body.text;
  const v = await c.g.specVersion(t);
  okStatus(await c.g.put(t, same, A), 200);
  assert.equal(await c.g.specVersion(t), v + 1, 'identical text is a new version');
  assert.equal((await c.g.task(t)).spec_review ?? null, null); assert.equal(await state(t), 'draft');
  okStatus(await c.g.put(t, card({ size: 'small' }), A), 200); assert.equal(await state(t), 'draft', 'big → small: draft until reviewed');
  okStatus(await c.g.put(t, card({ size: 'big' }), A), 200); assert.equal(await state(t), 'draft', 'small → big: draft');
}));

// ---------- 6. review families ----------
test('6 review: reviewer family must be known and differ from every protected-section author; claimants and authors refused', () => withBoard(async (c) => {
  const big = (o: CardOpts = {}) => card({ size: 'big', ...o });
  const t1 = c.mk('Family one'); const t2 = c.mk('Family two'); const t3 = c.mk('Family three'); const t4 = c.mk('Family four'); await settle();
  okStatus(await c.g.put(t1, big(), A), 200);
  let r = await c.g.reviewNow(t1, 'pass', B); okStatus(r, 403, 'B reviews A (same family)');
  okStatus(await c.g.put(t2, big(), B), 200);
  r = await c.g.reviewNow(t2, 'pass', A); okStatus(r, 403, 'A reviews B (same family)');
  // Acceptance anthropic (A) + Oracle openai (C): only D (google) passes.
  okStatus(await c.g.put(t1, big({ oracle: 'oracle by C\n' }), C), 200);
  for (const who of [A, B, C, G]) { r = await c.g.reviewNow(t1, 'pass', who); okStatus(r, 403, `${who} on anthropic+openai`); }
  r = await c.g.reviewNow(t1, 'pass', D); okStatus(r, 200, 'D (google)');
  assert.equal(r.body.spec_review.family, 'google'); assert.equal(r.body.spec_review.by, D); assert.equal(r.body.spec_review.verdict, 'pass');
  assert.equal(r.body.spec_review.spec_version, await c.g.specVersion(t1)); assert.match(r.body.spec_review.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  // Family lookup: exact config override beats the default prefix; the longest prefix wins; no rule, no family.
  const fam = async (who: string) => { const x = await c.g.reviewNow(t2, 'pass', who); okStatus(x, 200, who); return x.body.spec_review.family; };
  assert.equal(await fam('human-claude@laptop-x'), 'openai', 'exact override');
  assert.equal(await fam('zzz-open@m'), 'openai', 'longest configured prefix');
  assert.equal(await fam('zz-other@m'), 'google', 'shorter configured prefix');
  assert.equal(await fam('codex-helper'), 'openai', 'default codex prefix');
  okStatus(await c.g.reviewNow(t2, 'pass', 'alpha-lead'), 403, 'a name no rule maps has no family');
  okStatus(await c.g.reviewNow(t2, 'pass', 'bot'), 403, 'bot has no default family');
  r = await c.g.reviewNow(t2, 'pass', UNKNOWN); okStatus(r, 403, 'unknown reviewer');
  okStatus(await c.g.put(t3, big(), UNKNOWN), 200);
  r = await c.g.reviewNow(t3, 'pass', D); okStatus(r, 403, 'unknown author');
  okStatus(await c.g.put(t4, big(), A), 200);
  okStatus(await c.g.claim(t4, D), 200); okStatus(await c.g.release(t4, D), 200);
  r = await c.g.reviewNow(t4, 'pass', D); okStatus(r, 403, 'a claimant');
  r = await c.g.review(t4, { spec_version: (await c.g.specVersion(t4)) + 1, verdict: 'pass' }, C); okStatus(r, 409, 'not the current version');
  assert.equal(r.body.current_spec_version, await c.g.specVersion(t4));
}));

// ---------- 7. input shapes, HTTP and MCP ----------
function mcp(url: string, actor: string) {
  const proc = spawn(process.execPath, [MCP], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; let next = 1;
  const waiting = new Map<number, (v: any) => void>();
  proc.stdout!.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); } });
  const rpc = (method: string, params: any = {}) => { const id = next++; return new Promise<any>((res) => { waiting.set(id, res); proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); };
  const call = async (name: string, args: any) => { const r = (await rpc('tools/call', { name, arguments: args })).result; let json: any = null; const tx: string = r.content[0].text;
    try { json = JSON.parse(tx); } catch { /* text */ } return { err: !!r.isError, text: r.content[0].text as string, json }; };
  return { proc, rpc, call };
}

test('7 review/block/unblock input: raw actor, exact field types, 404s, stale versions 409 with nothing changed; MCP = HTTP', () => withBoard(async (c) => {
  const id = c.mk('Input card'); const nospec = c.mk('No spec card'); await settle();
  okStatus(await c.g.put(id, card({ size: 'big' }), A), 200);
  const tv = async () => (await c.g.task(id)).version;
  const sv = 1;
  const good = { review: () => ({ spec_version: sv, verdict: 'pass' }), block: async () => ({ expected_version: await tv(), expected_spec_version: sv, block_note: 'stale key' }), unblock: async () => ({ expected_version: await tv(), expected_spec_version: sv }) };
  for (const op of ['review', 'block', 'unblock'] as const) {
    const send = (body: unknown, actor: string | null) => (c.g as any)[op](id, body, actor);
    okStatus(await send(await good[op](), null), 400, `${op}: no actor header`);
    okStatus(await send(await good[op](), 'bad actor!'), 400, `${op}: malformed actor`);
    const base: any = await good[op]();
    for (const k of Object.keys(base).filter((k) => /version/.test(k))) {
      for (const bad of [String(base[k]), base[k] + 0.5, null, undefined]) {
        const b = { ...base, [k]: bad }; if (bad === undefined) delete b[k];
        okStatus(await send(b, D), 400, `${op}: ${k} = ${JSON.stringify(bad)}`);
      }
    }
    okStatus(await send({ ...base, extra: 1 }, D), 400, `${op}: extra field`);
    okStatus(await (c.g as any)[op]('shared.t-nonex', base, D), 404, `${op}: no task`);
  }
  for (const v of ['ok', 'PASS', 1, null]) okStatus(await c.g.review(id, { spec_version: sv, verdict: v }, D), 400, `verdict ${v}`);
  for (const n of ['', 'two\nlines', 'x'.repeat(1025), 7]) okStatus(await c.g.block(id, { expected_version: await tv(), expected_spec_version: sv, block_note: n }, D), 400, `block_note ${JSON.stringify(n).slice(0, 20)}`);
  okStatus(await c.g.review(nospec, { spec_version: 1, verdict: 'pass' }, D), 404, 'review without spec');
  // Stale versions: 409, nothing changes (also a stale reblock on an active block).
  const staleCheck = async (body: any, what: string) => {
    const before = snapshot(c.root, id);
    const r = await c.g.block(id, body, D); okStatus(r, 409, what);
    assert.deepEqual(snapshot(c.root, id), before, `${what}: nothing changed`);
  };
  await staleCheck({ expected_version: (await tv()) - 1, expected_spec_version: sv, block_note: 'x' }, 'stale expected_version');
  await staleCheck({ expected_version: await tv(), expected_spec_version: sv + 1, block_note: 'x' }, 'stale expected_spec_version');
  okStatus(await c.g.blockNow(id, D, 'first block'), 200);
  const t0 = await c.g.task(id);
  okStatus(await c.g.put(id, card({ size: 'big', bg: 'newer by F' }), F), 200);
  await staleCheck({ expected_version: (await tv()) - 1, expected_spec_version: 2, block_note: 'stale reblock' }, 'stale reblock');
  const t1 = await c.g.task(id);
  assert.equal(t1.blocked_spec_version, t0.blocked_spec_version); assert.equal(t1.block_note, 'first block');
  // Block without a spec: baseline 0. Success returns the updated task.
  const r = await c.g.blockNow(nospec, D);
  okStatus(r, 200); assert.equal(r.body.id, nospec); assert.equal(r.body.spec_state, 'blocked'); assert.equal(r.body.blocked_spec_version, 0);
  assert.equal(r.body.blocked_by, D); assert.match(r.body.blocked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  // MCP: same successes and the same errors (isError + http_status + detail).
  const m = mcp(c.s.url, D);
  try {
    await m.rpc('initialize', { protocolVersion: '2025-06-18' });
    const id2 = c.mk('MCP card'); await settle();
    okStatus(await c.g.put(id2, card({ size: 'big' }), A), 200);
    const same = async (tool: string, args: any, http: () => Promise<Res>) => {
      const h = await http(); const x = await m.call(tool, args);
      if (h.status === 200) { assert.equal(x.err, false, x.text); return; }
      assert.equal(x.err, true, tool); assert.equal(x.json.http_status, h.status, tool);
      // `hint` is MCP-only (dasks-mcp errorText adds it to a 409 as a JSON field).
      assert.deepEqual({ ...x.json, http_status: undefined, hint: undefined }, { ...h.body, http_status: undefined, hint: undefined }, tool);
    };
    await same('review_spec', { id: id2, spec_version: 9, verdict: 'pass' }, () => c.g.review(id2, { spec_version: 9, verdict: 'pass' }, D));
    await same('review_spec', { id: id2, spec_version: '1', verdict: 'pass' }, () => c.g.review(id2, { spec_version: '1', verdict: 'pass' }, D));
    await same('review_spec', { id: 'shared.t-nonex', spec_version: 1, verdict: 'pass' }, () => c.g.review('shared.t-nonex', { spec_version: 1, verdict: 'pass' }, D));
    let x = await m.call('review_spec', { id: id2, spec_version: 1, verdict: 'pass' });
    const pick = (t: any) => ({ id: t.id, version: t.version, spec_state: t.spec_state, spec_review: t.spec_review, blocked_by: t.blocked_by, block_note: t.block_note, blocked_spec_version: t.blocked_spec_version });
    assert.equal(x.err, false, x.text); assert.equal(x.json.spec_state, 'ready'); assert.deepEqual(pick(x.json), pick(await c.g.task(id2)));
    const tv2 = (await c.g.task(id2)).version;
    await same('block_spec', { id: id2, expected_version: tv2 - 1, expected_spec_version: 1, block_note: 'n' }, () => c.g.block(id2, { expected_version: tv2 - 1, expected_spec_version: 1, block_note: 'n' }, D));
    x = await m.call('block_spec', { id: id2, expected_version: tv2, expected_spec_version: 1, block_note: 'mcp block' });
    assert.equal(x.err, false, x.text); assert.equal(x.json.spec_state, 'blocked'); assert.deepEqual(pick(x.json), pick(await c.g.task(id2)));
    const tv3 = (await c.g.task(id2)).version;
    await same('unblock_spec', { id: id2, expected_version: tv3, expected_spec_version: 1 }, () => c.g.unblock(id2, { expected_version: tv3, expected_spec_version: 1 }, D));
    await same('ready_tasks', { require_spec_ready: true }, () => c.g.ready('?require_spec_ready=1'));
    x = await m.call('ready_tasks', { require_spec_ready: true, full: true });
    assert.deepEqual(x.json, (await c.g.ready('?require_spec_ready=1')).body);
  } finally { m.proc.kill(); }
}));

// ---------- 8. blocks ----------
test('8 block: claims refused but for the user; writes and reviews stored while blocked; lift rules; reblock resets the baseline', () => withBoard(async (c) => {
  const state = async (id: string) => (await c.g.task(id)).spec_state;
  const id = c.mk('Block card'); const held = c.mk('Held card'); await settle();
  okStatus(await c.g.put(held, card(), A), 200); okStatus(await c.g.claim(held, E), 200);
  let r = await c.g.blockNow(held, D); okStatus(r, 200);
  assert.equal(r.body.status, 'doing'); assert.equal(r.body.claimed_by, E); assert.equal(r.body.spec_state, 'blocked');
  okStatus(await c.g.put(id, card({ size: 'big' }), A), 200);
  okStatus(await c.g.blockNow(id, D), 200); assert.equal(await state(id), 'blocked');
  r = await c.g.claim(id, B); okStatus(r, 409); assert.match(r.body.error, /blocked/);
  // The global user guard: header "user" without a session 401, bad CSRF / Origin 403.
  okStatus(await c.g.call('POST', `/api/tasks/${id}/claim`, {}, { 'X-Dasks-Actor': 'user' }), 401, 'user header, no session');
  const human = await login(c.s);
  okStatus(await c.g.call('POST', `/api/tasks/${id}/claim`, {}, { ...human, 'X-Dasks-CSRF': 'wrong' }), 403, 'bad CSRF');
  okStatus(await c.g.call('POST', `/api/tasks/${id}/claim`, {}, { ...human, Origin: 'http://evil.example' }), 403, 'bad Origin');
  r = await c.g.call('POST', `/api/tasks/${id}/claim`, {}, human); okStatus(r, 200, 'user claims a blocked card');
  assert.equal(await state(id), 'blocked', 'a user claim does not lift the block');
  okStatus(await c.g.call('POST', `/api/tasks/${id}/release`, {}, human), 200);
  // Writes and reviews while blocked are stored; the state stays blocked.
  okStatus(await c.g.put(id, card({ size: 'big', acc: '1. fixed key\n' }), F), 200);
  assert.equal(await c.g.specVersion(id), 2); assert.equal(await state(id), 'blocked');
  r = await c.g.reviewNow(id, 'pass', C); okStatus(r, 200);
  assert.equal(r.body.spec_review.verdict, 'pass'); assert.equal(r.body.spec_state, 'blocked');
  r = await c.g.unblockNow(id, null, human); okStatus(r, 200, 'user lifts without a newer version');
  assert.equal(r.body.spec_state, 'ready'); assert.equal(r.body.blocked_by ?? '', ''); assert.equal(r.body.block_note ?? '', '');
  // Non-user lifts: history member 403; never-claimant without a newer version 409; newer by someone else 403; author 200.
  okStatus(await c.g.claim(id, B), 200); okStatus(await c.g.release(id, B), 200);
  okStatus(await c.g.blockNow(id, D), 200);
  okStatus(await c.g.unblockNow(id, B), 403, 'history member');
  okStatus(await c.g.unblockNow(id, G), 409, 'no newer version');
  okStatus(await c.g.put(id, card({ size: 'big', acc: '1. G fixes the key\n' }), G), 200);
  okStatus(await c.g.unblockNow(id, F), 403, 'newer version, written by someone else');
  r = await c.g.unblockNow(id, G); okStatus(r, 200, 'the newer version\'s author');
  assert.equal(r.body.spec_state, 'draft', 'recomputed: big, the new version has no review');
  // Reblock resets the baseline.
  okStatus(await c.g.blockNow(id, D), 200);
  okStatus(await c.g.put(id, card({ size: 'big', acc: '1. F again\n' }), F), 200);
  okStatus(await c.g.blockNow(id, D, 'reblock'), 200);
  assert.equal((await c.g.task(id)).blocked_spec_version, await c.g.specVersion(id));
  okStatus(await c.g.unblockNow(id, F), 409, 'reblocked after F\'s version: not newer any more');
  // Two writes in one second keep their order (versions decide, not the clock).
  const t2 = c.mk('Same second'); await settle();
  okStatus(await c.g.put(t2, card(), A), 200);
  okStatus(await c.g.blockNow(t2, D), 200);
  okStatus(await c.g.put(t2, card({ bg: 'same second' }), F), 200);
  okStatus(await c.g.unblockNow(t2, F), 200, 'block then write: the write is newer');
  okStatus(await c.g.put(t2, card({ bg: 'write first' }), F), 200);
  okStatus(await c.g.blockNow(t2, D), 200);
  okStatus(await c.g.unblockNow(t2, F), 409, 'write then block: the write is not newer');
}));

// ---------- 9. fields ----------
function writeSpecFiles(root: string, id: string, text: string, by = A) {
  const [g, slug] = id.split(/\.(.*)/s);
  const dir = path.join(root, 'data/specs', g, slug, 'versions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.md'), text);
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ version: 1, by, at: '2026-10-24T10:00:00+09:00', note: '', sha256: sha(text), section_authors: { acceptance_tests: { by, sha256: 'x' }, oracle: null }, warnings: [] }, null, 1) + '\n');
  fs.writeFileSync(path.join(root, 'data/specs', g, `${slug}.md`), text);
}
test('9 fields: tasks without stored fields derive their state on read without writing; values round-trip; malformed values are errors; clients cannot write them', async () => {
  const fx = ['no', 'sm', 'bg'].map((n) => taskFixture({ id: `shared.t-lg-${n}`, goal: 'shared', title: `Card ${n}`, milestone: 'shared.m1' }));
  await withBoard(async (c) => {
    writeSpecFiles(c.root, 'shared.t-lg-sm', card());
    writeSpecFiles(c.root, 'shared.t-lg-bg', card({ size: 'big' }));
    execFileSync('git', ['-C', c.root, 'add', 'data']); execFileSync('git', ['-C', c.root, 'commit', '-qm', 'specs']);
    await c.restart();
    const h0 = head(c.root); const files0 = fx.map((t) => fs.readFileSync(path.join(c.root, t.file), 'utf8'));
    // a small spec with no stored field and no review derives draft.
    const want = { 'shared.t-lg-no': 'none', 'shared.t-lg-sm': 'draft', 'shared.t-lg-bg': 'draft' } as Record<string, string>;
    const look = async () => {
      for (const [id, st] of Object.entries(want)) assert.equal((await c.g.task(id)).spec_state, st, id);
      const items = (await c.g.ready('?all=1')).body.ready;
      for (const [id, st] of Object.entries(want)) assert.equal(items.find((i: any) => i.id === id)?.spec_state, st, `ready ${id}`);
    };
    await look(); await c.restart(); await look();
    assert.equal(head(c.root), h0, 'reads write nothing');
    assert.deepEqual(fx.map((t) => fs.readFileSync(path.join(c.root, t.file), 'utf8')), files0);
    // Valid values round-trip through a restart.
    const id = c.mk('Round trip'); await settle();
    okStatus(await c.g.put(id, card({ size: 'big' }), A), 200);
    okStatus(await c.g.reviewNow(id, 'pass', D), 200);
    okStatus(await c.g.blockNow(id, C, 'note with ünïcode'), 200);
    const pick = (t: any) => ({ spec_state: t.spec_state, blocked_by: t.blocked_by, blocked_at: t.blocked_at, block_note: t.block_note, blocked_spec_version: t.blocked_spec_version, spec_review: t.spec_review });
    const before = pick(await c.g.task(id));
    assert.equal(typeof before.blocked_spec_version, 'number'); assert.equal(typeof before.spec_review, 'object');
    await c.restart();
    assert.deepEqual(pick(await c.g.task(id)), before);
    // Clients cannot write server fields through the generic task routes.
    for (const k of ['spec_state', 'blocked_by', 'blocked_at', 'block_note', 'blocked_spec_version', 'spec_review']) {
      const v = k === 'blocked_spec_version' ? 3 : k === 'spec_review' ? { spec_version: 1, by: D, family: 'google', verdict: 'pass', at: '2026-10-24T10:00:00+09:00' } : 'ready';
      okStatus(await c.g.call('POST', `/api/tasks/${id}`, { [k]: v }, c.g.as(D)), 400, `edit ${k}`);
      okStatus(await c.g.call('POST', '/api/tasks', { goal: 'shared', title: `Create with ${k}`, [k]: v }, c.g.as(D)), 400, `create with ${k}`);
    }
  }, {}, fx);
  // Malformed values in the file are load/check errors.
  const base = serializeTask(taskFixture({ id: 'shared.t-x', goal: 'shared' }));
  const errs = (yamlLines: string) => {
    const text = base.replace(/^---\n/, `---\n${yamlLines}\n`);
    return checkTask(taskFromParsed(parseFrontmatter(text), 'data/tasks/shared/t-x.md', text.length));
  };
  const review = (o: Record<string, unknown>) => 'spec_review:\n' + Object.entries({ spec_version: 1, by: D, family: 'google', verdict: 'pass', at: '2026-10-24T10:00:00+09:00', ...o }).filter(([, v]) => v !== undefined).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n');
  assert.deepEqual(errs(review({})), [], 'a valid review');
  assert.deepEqual(errs('spec_state: draft\nblocked_spec_version: 0'), [], 'valid scalars');
  const bad: [string, RegExp][] = [
    ['spec_state: maybe', /spec_state/], ['spec_state: [ready]', /spec_state/], ['spec_state: {a: 1}', /spec_state/],
    ['blocked_spec_version: "3"', /blocked_spec_version/], ['blocked_spec_version: -1', /blocked_spec_version/], ['blocked_spec_version: 1.5', /blocked_spec_version/], ['blocked_spec_version: [1]', /blocked_spec_version/],
    ['blocked_by: "bad actor!"', /blocked_by/], ['blocked_at: yesterday', /blocked_at/], ['blocked_at: 2026-10-24T10:00:00Z', /blocked_at/],
    ['block_note: ""', /block_note/], [`block_note: "${'x'.repeat(1025)}"`, /block_note/], ['block_note: "two\\nlines"', /block_note/], ['block_note: [a]', /block_note/],
    ['spec_review: pass', /spec_review/], ['spec_review: [1, 2]', /spec_review/],
    [review({ spec_version: 0 }), /spec_review/], [review({ spec_version: '1' }), /spec_review/], [review({ by: 'bad actor!' }), /spec_review/],
    [review({ family: 'Not A Family' }), /spec_review/], [review({ verdict: 'maybe' }), /spec_review/], [review({ at: 'yesterday' }), /spec_review/],
    [review({ extra: 1 }), /spec_review/], [review({ verdict: undefined }), /spec_review/],
  ];
  for (const [y, re] of bad) { const e = errs(y); assert.ok(e.some((m) => re.test(m)), `${y.slice(0, 60)} → ${JSON.stringify(e)}`); }
});

// ---------- 10. ready ----------
test('10 ready: ?all=1 unchanged for every spec state (the default is strict); strict mode filters before limit; spec_by; dependency done → ready at once', () => withBoard(async (c) => {
  const none = c.mk('Ready none'); const draft = c.mk('Ready draft', { priority: 'p0' }); const ready = c.mk('Ready ready', { priority: 'p2' }); const blocked = c.mk('Ready blocked');
  const claimed = c.mk('Ready claimed'); const closed = c.mk('Ready closed'); const dep = c.mk('Dependency');
  const waitA = c.mk('Waits A', { depends_on: dep }); const waitB = c.mk('Waits B', { depends_on: dep });
  await settle();
  okStatus(await c.g.put(draft, card({ acc: null }), A), 200);
  okStatus(await c.g.put(ready, card(), A), 200);
  okStatus(await c.g.put(blocked, card(), A), 200); okStatus(await c.g.blockNow(blocked, D), 200);
  for (const id of [claimed, closed, waitA]) okStatus(await c.g.put(id, card(), A), 200);
  okStatus(await c.g.put(waitB, card({ acc: null }), A), 200);
  // a small spec is ready only after a pass review.
  for (const id of [ready, waitA]) okStatus(await c.g.reviewNow(id, 'pass', C), 200);
  okStatus(await c.g.claim(claimed, E), 200);
  okStatus(await c.g.call('POST', `/api/tasks/${closed}/finish`, { result: 'done, log /tmp/x.log', status: 'done' }, c.g.as(E)), 200);
  // ?all=1: the same tasks, in the same order, as the queue without spec rules.
  const def = (await c.g.ready('?all=1')).body;
  const old = readyQueue(loadBoard(c.root), { missing_hours: 24 });
  assert.deepEqual(def.ready.map((i: any) => i.id), old.ready.map((i) => i.id));
  for (const id of [none, draft, ready, blocked]) assert.ok(def.ready.some((i: any) => i.id === id), `default lists ${id}`);
  for (const i of def.ready) assert.ok('spec_state' in i && 'spec_by' in i, i.id);
  assert.equal(def.ready.find((i: any) => i.id === none).spec_by, null);
  assert.equal(def.ready.find((i: any) => i.id === ready).spec_by, A);
  // Strict: only ready specs; limit applies after the filter.
  const strict = (await c.g.ready('?require_spec_ready=1')).body.ready.map((i: any) => i.id);
  assert.ok(strict.includes(ready));
  for (const id of [none, draft, blocked, claimed, closed, waitA, waitB]) assert.ok(!strict.includes(id), `strict leaves out ${id}`);
  const draftRank = def.ready.findIndex((i: any) => i.id === draft), readyRank = def.ready.findIndex((i: any) => i.id === ready);
  assert.ok(draftRank < readyRank, 'the draft ranks higher');
  const one = (await c.g.ready('?require_spec_ready=1&limit=1')).body.ready;
  assert.equal(one.length, 1); assert.equal(one[0].spec_state, 'ready');
  // spec_by follows metadata.by (a Background-only edit by C).
  okStatus(await c.g.put(ready, card({ bg: 'C edits Background' }), C), 200);
  assert.equal((await c.g.ready('?all=1')).body.ready.find((i: any) => i.id === ready).spec_by, C);
  // The dependency finishes; strict ready right after: A in, B out; neither spec state changes.
  const states = [(await c.g.task(waitA)).spec_state, (await c.g.task(waitB)).spec_state];
  okStatus(await c.g.call('POST', `/api/tasks/${dep}/finish`, { result: 'done, log /tmp/dep.log', status: 'done' }, c.g.as(E)), 200);
  const after = (await c.g.ready('?require_spec_ready=1')).body.ready.map((i: any) => i.id);
  assert.ok(after.includes(waitA)); assert.ok(!after.includes(waitB));
  assert.deepEqual([(await c.g.task(waitA)).spec_state, (await c.g.task(waitB)).spec_state], states);
}));

// ---------- 11. versions and atomicity ----------
test('11 versions: spec field changes bump the task version once, in one commit with the spec files; a failed commit rolls back; reads are immediate', () => withBoard(async (c) => {
  const id = c.mk('Version card'); await settle();
  const t0 = await c.g.task(id);
  await new Promise((r) => setTimeout(r, 1100)); // `updated` has 1 s resolution
  okStatus(await c.g.put(id, card({ size: 'big' }), A), 200);
  const t1 = await c.g.task(id);
  assert.equal(t1.spec_state, 'draft'); assert.equal(t1.version, t0.version + 1); assert.notEqual(t1.updated, t0.updated); assert.equal(t1.body, t0.body);
  const files = execFileSync('git', ['-C', c.root, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(files.includes(t0.file), 'task file in the spec commit'); assert.ok(files.some((f) => f.endsWith('/versions/1.md')), 'spec files in the same commit');
  okStatus(await c.g.put(id, card({ size: 'big', bg: 'still draft' }), A), 200);
  const t2 = await c.g.task(id);
  assert.equal(t2.version, t1.version, 'no spec field changed: task version kept'); assert.equal(t2.updated, t1.updated); assert.equal(t2.body, t0.body);
  // Immediate reads after a change (no watcher wait).
  okStatus(await c.g.put(id, card({ size: 'small' }), A), 200);
  okStatus(await c.g.reviewNow(id, 'pass', C), 200);
  assert.equal((await c.g.task(id)).spec_state, 'ready');
  assert.ok((await c.g.ready('?require_spec_ready=1')).body.ready.some((i: any) => i.id === id));
  // A failed commit leaves nothing: the reference-transaction hook refuses the commit after the files were written.
  const hook = path.join(c.root, '.git/hooks/reference-transaction');
  fs.writeFileSync(hook, '#!/bin/sh\n[ "$1" = prepared ] && exit 1\nexit 0\n', { mode: 0o755 });
  const before = snapshot(c.root, id); const tb = await c.g.task(id);
  const r = await c.g.put(id, card({ size: 'big' }), A);
  assert.ok(r.status >= 500, `commit failure: ${r.status}`);
  fs.rmSync(hook);
  assert.deepEqual(snapshot(c.root, id), before, 'spec files, task file and HEAD rolled back');
  assert.deepEqual(await c.g.task(id), tb);
}));

// ---------- 12. race ----------
test('12 race: a never-claimant\'s claim vs its own Acceptance write: exactly one wins, in both orders', () => withBoard(async (c) => {
  const fresh = async (title: string) => { const id = c.mk(title); await settle(); okStatus(await c.g.put(id, card(), A), 200); return id; };
  const write = (id: string) => c.g.putAt(id, card({ acc: '1. E rewrites the key\n' }), 1, E);
  let id = await fresh('Race claim first');
  okStatus(await c.g.claim(id, E), 200); okStatus(await write(id), 403);
  assert.deepEqual(history(c.root, id)!.who, [E]); assert.equal((await c.g.spec(id)).body.section_authors.acceptance_tests.by, A);
  id = await fresh('Race write first');
  okStatus(await write(id), 200);
  let r = await c.g.claim(id, E); okStatus(r, 409); assert.match(r.body.error, /you wrote the answer key/);
  assert.deepEqual(history(c.root, id)!.who, []); assert.equal((await c.g.spec(id)).body.section_authors.acceptance_tests.by, E);
  // at the same time, a few rounds: exactly one 200, and the loser's refusal matches the winner.
  for (let i = 0; i < 4; i++) {
    id = await fresh(`Race together ${i}`);
    const [cl, wr] = await Promise.all([c.g.claim(id, E), write(id)]);
    const wins = [cl.status, wr.status].filter((s) => s === 200).length;
    assert.equal(wins, 1, `round ${i}: claim ${cl.status}, write ${wr.status}`);
    const t = await c.g.task(id); const sp = (await c.g.spec(id)).body;
    if (cl.status === 200) { assert.equal(wr.status, 403); assert.equal(t.claimed_by, E); assert.deepEqual(history(c.root, id)!.who, [E]); assert.equal(sp.section_authors.acceptance_tests.by, A); }
    else { assert.equal(cl.status, 409); assert.match(cl.body.error, /you wrote the answer key/); assert.equal(t.claimed_by, ''); assert.deepEqual(history(c.root, id)!.who, []); assert.equal(sp.section_authors.acceptance_tests.by, E); }
  }
}));

test('a status → doing write takes the card like a claim: refused when blocked or by the answer key author, recorded in history', () => withBoard(async (c) => {
  const doing = (id: string, actor: string) => c.g.call('POST', `/api/tasks/${id}`, { status: 'doing' }, c.g.as(actor));
  const blocked = c.mk('Doing blocked'); const authored = c.mk('Doing authored'); const free = c.mk('Doing free'); await settle();
  okStatus(await c.g.put(blocked, card(), A), 200); okStatus(await c.g.blockNow(blocked, D), 200);
  let r = await doing(blocked, E); okStatus(r, 409); assert.match(r.body.error, /blocked/);
  okStatus(await c.g.put(authored, card(), A), 200);
  r = await doing(authored, A); okStatus(r, 409); assert.match(r.body.error, /you wrote the answer key/);
  okStatus(await c.g.put(free, card(), A), 200);
  okStatus(await doing(free, E), 200);
  assert.deepEqual(history(c.root, free), { partial: false, who: [E] });
  okStatus(await c.g.put(free, card({ acc: '1. E rewrites\n' }), E), 403, 'E took the card by status: an implementer now');
}));

test('a spec-field write never moves body notes to the archive', () => withBoard(async (c) => {
  const notes = Array.from({ length: 60 }, (_, i) => `- 2026-10-2${i % 10} 10:00 helper: note ${i} ${'x'.repeat(80)}`).join('\n');
  const id = c.mk('Long notes', { body: `\n## Context\nx\n\n## Notes\n${notes}\n` }); await settle();
  const body0 = (await c.g.task(id)).body;
  okStatus(await c.g.blockNow(id, D, 'n'.repeat(1024)), 200);
  assert.equal((await c.g.task(id)).body, body0);
}));

test('the derived state follows the version\'s bytes, not its number (a rolled-back v1, then another v1)', () => {
  // A pass on v1 (every size needs one); the second v1 has no Acceptance, so it is draft.
  const t = taskFixture({ id: 'shared.t-cache', goal: 'shared', milestone: 'shared.m1', spec_review: { spec_version: 1, by: C, family: 'openai', verdict: 'pass', at: '2026-10-27T10:00:00+09:00' } } as any);
  const { root, cleanup } = tempRepo([t]);
  try {
    writeSpecFiles(root, t.id, card());
    assert.equal(effectiveSpecState(root, t), 'ready');
    writeSpecFiles(root, t.id, card({ acc: null }));
    assert.equal(effectiveSpecState(root, t), 'draft');
  } finally { cleanup(); }
});

test('null is a malformed value for every spec field but spec_review', () => {
  const base = serializeTask(taskFixture({ id: 'shared.t-x', goal: 'shared' }));
  const errs = (y: string) => { const text = base.replace(/^---\n/, `---\n${y}\n`); return checkTask(taskFromParsed(parseFrontmatter(text), 'data/tasks/shared/t-x.md', text.length)); };
  for (const k of ['spec_state', 'blocked_by', 'blocked_at', 'block_note', 'blocked_spec_version']) assert.ok(errs(`${k}: null`).length > 0, k);
  assert.deepEqual(errs('spec_review: null'), []);
});

test('another process writes spec_state ready, its commit is slow and rolls back: no read ever shows ready', () => withBoard(async (c) => {
  const id = c.mk('Slow commit'); await settle();
  okStatus(await c.g.put(id, card({ size: 'big' }), A), 200); // committed: draft
  const [g, slug] = id.split(/\.(.*)/s);
  const file = path.join(c.root, `data/tasks/${g}/${slug}.md`);
  const committed = fs.readFileSync(file, 'utf8');
  const reads = async () => {
    const t = await c.g.task(id);
    const list = (await c.g.call('GET', '/api/tasks')).body.find((x: any) => x.id === id);
    const board = (await c.g.call('GET', '/api/board')).body.tasks.find((x: any) => x.id === id);
    const strict = (await c.g.ready('?require_spec_ready=1')).body.ready.some((x: any) => x.id === id);
    const item = (await c.g.ready('?all=1')).body.ready.find((x: any) => x.id === id);
    return { t: [t.spec_state, t.spec_review ?? null], list: list.spec_state, board: board.spec_state, strict, item: item.spec_state };
  };
  const want = { t: ['draft', null], list: 'draft', board: 'draft', strict: false, item: 'draft' };
  assert.deepEqual(await reads(), want);
  // The other process writes its files (a pass review stored, state ready) and stages them; the commit hasn't happened.
  const review = { spec_version: 1, by: D, family: 'google', verdict: 'pass', at: '2026-10-25T00:00:00+09:00' };
  fs.writeFileSync(file, committed.replace(/^spec_state: draft$/m, `spec_state: ready\nspec_review:\n${Object.entries(review).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')}`));
  assert.match(fs.readFileSync(file, 'utf8'), /spec_state: ready/);
  execFileSync('git', ['-C', c.root, 'add', file]);
  await settle(); // the watcher reloads the board from the working tree
  assert.deepEqual(await reads(), want, 'uncommitted ready is never shown');
  // An uncommitted new spec version (the same slow write) is not read either.
  const vdir = path.join(c.root, `data/specs/${g}/${slug}/versions`);
  fs.writeFileSync(path.join(vdir, '2.md'), card());
  fs.writeFileSync(path.join(vdir, '2.json'), JSON.stringify({ version: 2, by: E, at: '2026-10-25T00:00:00+09:00', note: '', sha256: sha(card()), section_authors: { acceptance_tests: { by: E, sha256: 'x' }, oracle: null }, warnings: [] }));
  await settle();
  assert.deepEqual(await reads(), want, 'uncommitted spec version is never shown');
  assert.equal((await c.g.ready('?all=1')).body.ready.find((x: any) => x.id === id).spec_by, A);
  // The commit fails and rolls back: still the committed state.
  execFileSync('git', ['-C', c.root, 'reset', '-q', '--', file]); fs.writeFileSync(file, committed);
  fs.rmSync(path.join(vdir, '2.md')); fs.rmSync(path.join(vdir, '2.json'));
  await settle();
  assert.deepEqual(await reads(), want);
}));

/** Another process's write of a pass review + state ready into the task file (working tree only). */
function pollute(root: string, id: string): { file: string; committed: string } {
  const [g, slug] = id.split(/\.(.*)/s);
  const file = path.join(root, `data/tasks/${g}/${slug}.md`);
  const committed = fs.readFileSync(file, 'utf8');
  const review = { spec_version: 1, by: D, family: 'google', verdict: 'pass', at: '2026-10-25T00:00:00+09:00' };
  fs.writeFileSync(file, committed.replace(/^spec_state: draft$/m, `spec_state: ready\nspec_review:\n${Object.entries(review).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')}`));
  assert.match(fs.readFileSync(file, 'utf8'), /spec_state: ready/);
  return { file, committed };
}
const stateEverywhere = async (c: Ctx, id: string) => ({
  task: (await c.g.task(id)).spec_state,
  list: (await c.g.call('GET', '/api/tasks')).body.find((x: any) => x.id === id).spec_state,
  board: (await c.g.call('GET', '/api/board')).body.tasks.find((x: any) => x.id === id).spec_state,
  ready: (await c.g.ready('?all=1')).body.ready.find((x: any) => x.id === id).spec_state,
  strict: (await c.g.ready('?require_spec_ready=1')).body.ready.some((x: any) => x.id === id),
});
const everywhere = (st: string) => ({ task: st, list: st, board: st, ready: st, strict: st === 'ready' });

test('a slow external commit that succeeds shows on the next read, with no data/ file event after it', () => withBoard(async (c) => {
  const id = c.mk('Slow but committed'); await settle();
  okStatus(await c.g.put(id, card({ size: 'big' }), A), 200); // committed: draft
  const { file } = pollute(c.root, id);
  execFileSync('git', ['-C', c.root, 'add', file]);
  await settle(); // the watcher reloads; HEAD has not moved
  assert.deepEqual(await stateEverywhere(c, id), everywhere('draft'), 'written and staged, not committed');
  execFileSync('git', ['-C', c.root, 'commit', '-qm', 'other process: review + ready']); // touches .git only
  assert.deepEqual(await stateEverywhere(c, id), everywhere('ready'), 'the next read, no wait');
  assert.equal((await c.g.task(id)).spec_review.by, D);
  // The same for a block committed elsewhere: the next read shows it.
  const committed = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, committed.replace(/^spec_state: ready$/m, 'spec_state: blocked\nblocked_by: bot@host-d\nblocked_at: 2026-10-25T00:00:00+09:00\nblock_note: stale key\nblocked_spec_version: 1'));
  execFileSync('git', ['-C', c.root, 'commit', '-qam', 'other process: block']);
  assert.deepEqual(await stateEverywhere(c, id), everywhere('blocked'));
  assert.equal((await c.g.task(id)).block_note, 'stale key');
}));

test('an uncommitted write rolled back, then the index rebuilt on a clean tree while the board still holds it: never shown', () => withBoard(async (c) => {
  const id = c.mk('Rolled back'); unseen.splice(unseen.indexOf(id), 1);
  await waitFor(async () => (await fetch(`${c.s.url}/api/tasks/${id}`)).ok, `the server loads ${id}`);
  okStatus(await c.g.put(id, card({ size: 'big' }), A), 200);
  const { file, committed } = pollute(c.root, id);
  // The same uncommitted write also stamps a block, and changes the title: a non-spec marker that shows what the loaded
  // board holds (publicTask overlays only the spec fields).
  const polluted = fs.readFileSync(file, 'utf8').replace(/^spec_state: ready$/m, 'spec_state: ready\nblocked_by: bot@host-d\nblocked_at: 2026-10-25T00:00:00+09:00\nblock_note: never committed\nblocked_spec_version: 1')
    .replace(/^title: Rolled back$/m, 'title: Rolled back POLLUTED');
  assert.match(polluted, /^title: Rolled back POLLUTED$/m);
  fs.writeFileSync(file, polluted);
  await waitFor(async () => (await c.g.task(id)).title === 'Rolled back POLLUTED', 'the board loads the uncommitted write');
  // Hold the watcher (DASKS_RELOAD_GATE): the rollback below must not reload the board before the read.
  const gate = path.join(c.root, '.reload-gate');
  fs.writeFileSync(gate, '');
  try {
    // Rollback, then HEAD moves at once (an unrelated commit, no data/ file): the next read rebuilds the index while the
    // working tree is clean and the loaded board still has the rolled-back values.
    fs.writeFileSync(file, committed);
    execFileSync('git', ['-C', c.root, 'commit', '-q', '--allow-empty', '-m', 'unrelated']);
    const t = await c.g.task(id);
    assert.equal(t.title, 'Rolled back POLLUTED', 'the board still holds the rolled-back write at this read');
    assert.equal(t.spec_state, 'draft');
    for (const k of ['spec_review', 'blocked_by', 'blocked_at', 'block_note', 'blocked_spec_version']) assert.equal(t[k], undefined, k);
    assert.deepEqual(await stateEverywhere(c, id), everywhere('draft'));
    assert.equal((await c.g.ready('?all=1')).body.ready.find((x: any) => x.id === id).spec_by, A);
    assert.equal((await c.g.task(id)).title, 'Rolled back POLLUTED', 'still held after every read');
  } finally { fs.rmSync(gate, { force: true }); }
  // The rolled-back bytes are the server's own last commit, and a watcher event for those within 2 s of that commit is
  // skipped as its own echo (scheduleReload): re-write them every 500 ms (slower than the 150 ms debounce, which a write
  // every poll step would keep resetting) until a reload takes them (an event after the 2 s).
  let polls = 0;
  await waitFor(async () => {
    if ((await c.g.task(id)).title === 'Rolled back') return true;
    if (++polls % 5 === 0) fs.writeFileSync(file, committed);
    return false;
  }, 'the board reloads the rolled-back file');
  // In process: the index never reads the working tree or a loaded task.
  pollute(c.root, id);
  assert.equal(committedSpecIndex(c.root).facts.get(id)!.spec_state, 'draft');
  fs.writeFileSync(file, committed);
}));

test('quoted YAML keys are spec fields too: a committed block written as "spec_state": blocked shows blocked', () => withBoard(async (c) => {
  const id = c.mk('Quoted keys'); await settle();
  okStatus(await c.g.put(id, card(), A), 200); okStatus(await c.g.reviewNow(id, 'pass', C), 200);
  const [g, slug] = id.split(/\.(.*)/s);
  const file = path.join(c.root, `data/tasks/${g}/${slug}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^spec_state: ready$/m, '"spec_state": blocked\n"blocked_by": bot@host-d\n"blocked_at": 2026-10-25T00:00:00+09:00\n"block_note": quoted\n"blocked_spec_version": 1'));
  execFileSync('git', ['-C', c.root, 'commit', '-qam', 'other process: block, quoted keys']);
  assert.deepEqual(await stateEverywhere(c, id), everywhere('blocked'));
  assert.equal((await c.g.task(id)).block_note, 'quoted');
  // Keys written with YAML escapes ("spec_state") are the same keys.
  const id2 = c.mk('Escaped keys'); await settle();
  okStatus(await c.g.put(id2, card(), A), 200); okStatus(await c.g.reviewNow(id2, 'pass', C), 200);
  const [g2, slug2] = id2.split(/\.(.*)/s);
  const file2 = path.join(c.root, `data/tasks/${g2}/${slug2}.md`);
  fs.writeFileSync(file2, fs.readFileSync(file2, 'utf8').replace(/^spec_state: ready$/m, '"spec\\u005fstate": blocked\n"blocked\\u005fby": bot@host-d\n"blocked\\u005fat": 2026-10-25T00:00:00+09:00\n"block\\u005fnote": escaped\n"blocked\\u005fspec\\u005fversion": 1'));
  execFileSync('git', ['-C', c.root, 'commit', '-qam', 'other process: block, escaped keys']);
  assert.deepEqual(await stateEverywhere(c, id2), everywhere('blocked'));
  assert.equal((await c.g.task(id2)).block_note, 'escaped');
}));

/** While the spec index can't be rebuilt: claims, status → doing and spec writes answer 503 with Retry-After, but the
 *  routes' own 400 and 404 still come first. */
async function refusedWhileBroken(c: Ctx, other: string) {
  for (const [what, r] of [
    ['claim', await c.g.claim(other, E)],
    ['status doing', await c.g.call('POST', `/api/tasks/${other}`, { status: 'doing' }, c.g.as(E))],
    ['PUT /spec', await c.g.put(other, card({ bg: 'x' }), E)],
    ['review', await c.g.reviewNow(other, 'pass', C)],
    ['block', await c.g.blockNow(other, D)],
    ['unblock', await c.g.unblockNow(other, D)],
  ] as const) { okStatus(r, 503, what); assert.equal(r.body.rule, 'spec-index', what); assert.ok(r.body.retry_after > 0, what); }
  const raw = await fetch(`${c.s.url}/api/tasks/${other}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': E }, body: '{}' });
  assert.equal(raw.status, 503); assert.equal(raw.headers.get('retry-after'), '5');
  const nope = 'shared.t-nonex';
  okStatus(await c.g.putAt('BAD id', card(), 0, E), 400, 'PUT bad id'); okStatus(await c.g.putAt(nope, card(), 0, E), 404, 'PUT unknown task');
  okStatus(await c.g.review(nope, { spec_version: 1, verdict: 'pass' }, C), 404, 'review unknown task');
  okStatus(await c.g.block(other, { expected_version: 1 }, D), 400, 'block bad shape');
  okStatus(await c.g.claim(nope, E), 404, 'claim unknown task');
  okStatus(await c.g.claim(other, E, { bogus: 1 }), 400, 'claim bad field');
}

test('an unresolvable HEAD (a ref cycle) is a failed rebuild: reads keep the last good index, writes 503, then it recovers', () => withBoard(async (c) => {
  const id = c.mk('Ref cycle'); const other = c.mk('Ref cycle other'); await settle();
  okStatus(await c.g.put(id, card(), A), 200); okStatus(await c.g.put(other, card(), A), 200);
  for (const x of [id, other]) okStatus(await c.g.reviewNow(x, 'pass', C), 200);
  const gd = path.join(c.root, '.git');
  const headBefore = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8');
  fs.writeFileSync(path.join(gd, 'refs/heads/cyc-a'), 'ref: refs/heads/cyc-b\n'); fs.writeFileSync(path.join(gd, 'refs/heads/cyc-b'), 'ref: refs/heads/cyc-a\n');
  fs.writeFileSync(path.join(gd, 'HEAD'), 'ref: refs/heads/cyc-a\n');
  try {
    assert.equal(headSha(c.root), '');
    assert.deepEqual(await stateEverywhere(c, id), everywhere('ready'), 'the last good index, 200');
    await refusedWhileBroken(c, other);
  } finally {
    fs.writeFileSync(path.join(gd, 'HEAD'), headBefore); fs.rmSync(path.join(gd, 'refs/heads/cyc-a')); fs.rmSync(path.join(gd, 'refs/heads/cyc-b'));
  }
  assert.deepEqual(await stateEverywhere(c, id), everywhere('ready'));
  okStatus(await c.g.claim(other, E), 200, 'recovered');
}));

test('a missing git object fails the rebuild: reads keep the last good index, claims and spec writes answer 503 until it recovers', () => withBoard(async (c) => {
  const id = c.mk('Missing object'); const other = c.mk('Other card'); await settle();
  okStatus(await c.g.put(id, card(), A), 200); okStatus(await c.g.put(other, card(), A), 200);
  for (const x of [id, other]) okStatus(await c.g.reviewNow(x, 'pass', C), 200);
  // Another process commits a block; then that commit's task blob goes missing from the object store.
  const [g, slug] = id.split(/\.(.*)/s);
  const rel = `data/tasks/${g}/${slug}.md`;
  // Committed with plumbing (no data/ file event), so no rebuild can see the new HEAD before its blob goes missing.
  const blocked = fs.readFileSync(path.join(c.root, rel), 'utf8').replace(/^spec_state: ready$/m, 'spec_state: blocked\nblocked_by: bot@host-d\nblocked_at: 2026-10-25T00:00:00+09:00\nblock_note: elsewhere\nblocked_spec_version: 1');
  const oid = execFileSync('git', ['-C', c.root, 'hash-object', '-w', '--stdin'], { input: blocked, encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', c.root, 'update-index', '--cacheinfo', `100644,${oid},${rel}`]);
  execFileSync('git', ['-C', c.root, 'commit', '-qm', 'other process: block']);
  const obj = path.join(c.root, '.git/objects', oid.slice(0, 2), oid.slice(2));
  const saved = fs.readFileSync(obj);
  fs.rmSync(obj);
  // Reads: the last good index (ready), 200.
  assert.deepEqual(await stateEverywhere(c, id), everywhere('ready'));
  await refusedWhileBroken(c, other);
  // The object comes back: a read within the 1 s back-off window rebuilds (HEAD did not move); nothing wrong was cached.
  fs.mkdirSync(path.dirname(obj), { recursive: true }); fs.writeFileSync(obj, saved);
  await waitFor(async () => (await c.g.task(id)).spec_state === 'blocked', 'a read shows the recovered state');
  assert.deepEqual(await stateEverywhere(c, id), everywhere('blocked'));
  okStatus(await c.g.claim(other, E), 200);
}));

test('the guard runs on the card read from disk: a card another process just committed, not loaded yet, gets 503 for claim and status → doing; bad fields stay 400', () => withBoard(async (c) => {
  const other = c.mk('Loaded card'); await settle();
  // Synchronously, before the watcher's next reload: another process commits two new cards, then one of their objects
  // goes missing, so the next rebuild fails.
  // A loaded machine can let the watcher reload (and rebuild) in between: then try again with new cards.
  let fresh1 = '', fresh2 = '', obj = '', saved = Buffer.alloc(0);
  // Hold the watcher (DASKS_RELOAD_GATE) while the commits land: a quick machine reloads between them otherwise.
  const gate = path.join(c.root, '.reload-gate');
  fs.writeFileSync(gate, '');
  for (let attempt = 0; ; attempt++) {
    fresh1 = createTask(c.root, { goal: 'shared', title: `Fresh unloaded one ${attempt}` }, 'helper').id;
    fresh2 = createTask(c.root, { goal: 'shared', title: `Fresh unloaded two ${attempt}` }, 'helper').id;
    const rel = `data/tasks/shared/${fresh1.split('.')[1]}.md`;
    const oid = execFileSync('git', ['-C', c.root, 'rev-parse', `HEAD:${rel}`], { encoding: 'utf8' }).trim();
    obj = path.join(c.root, '.git/objects', oid.slice(0, 2), oid.slice(2));
    saved = fs.readFileSync(obj); fs.rmSync(obj);
    const r = await c.g.call('GET', `/api/tasks/${fresh2}`);
    // 404 = no reload since the commits (a reload loads the board and rebuilds together): the next rebuild must fail.
    // A reload between the two commits rebuilt (and cached) fresh1 while its blob was still there; then the rebuild on
    // this read succeeds without it: try again unless /api/health says the rebuild failed.
    if (r.status === 404 && (await c.g.call('GET', '/api/health')).body.spec_index.ok === false) break;
    fs.writeFileSync(obj, saved); await settle();
    assert.ok(attempt < 5, 'the watcher always reloaded before the object went missing');
  }
  fs.rmSync(gate, { force: true });
  try {
    let r = await c.g.claim(fresh2, E); okStatus(r, 503, 'claim on an unloaded card'); assert.equal(r.body.rule, 'spec-index');
    r = await c.g.call('POST', `/api/tasks/${fresh1}`, { status: 'doing' }, c.g.as(E)); okStatus(r, 503, 'status doing on an unloaded card');
    okStatus(await c.g.call('POST', `/api/tasks/${other}`, { status: 'doing', bogus: 1 }, c.g.as(E)), 400, 'unknown field first');
    okStatus(await c.g.call('POST', `/api/tasks/${other}`, { status: 'doing', title: 123 }, c.g.as(E)), 400, 'bad field type first');
    assert.equal(history(c.root, fresh2)!.who.length, 0, 'the refused claim recorded nothing');
  } finally { fs.mkdirSync(path.dirname(obj), { recursive: true }); fs.writeFileSync(obj, saved); }
  okStatus(await c.g.claim(fresh2, E), 200, 'recovered');
}));

test('headSha follows symbolic ref chains and packed refs, like git rev-parse', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    const g = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
    const want = g('rev-parse', 'HEAD');
    assert.equal(headSha(root), want);
    g('symbolic-ref', 'refs/heads/alias', 'refs/heads/main'); g('symbolic-ref', 'HEAD', 'refs/heads/alias');
    assert.equal(headSha(root), want, 'HEAD → alias → main');
    g('pack-refs', '--all');
    assert.equal(headSha(root), want, 'packed');
    g('checkout', '-q', '--detach');
    assert.equal(headSha(root), want, 'detached');
  } finally { cleanup(); }
});

test('a repo lock held by another process does not stall the read routes', () => withBoard(async (c) => {
  const id = c.mk('Lock card'); await settle();
  okStatus(await c.g.put(id, card(), A), 200); okStatus(await c.g.reviewNow(id, 'pass', C), 200);
  // Another process takes the repo lock and keeps it for 6 s (a slow git commit).
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import { withRepoLock } from ${JSON.stringify(path.join(ROOT, 'src/lib/write.ts'))};
     withRepoLock(${JSON.stringify(c.root)}, () => { console.log('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000); });`], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((res) => holder.stdout!.on('data', (d) => { if (String(d).includes('held')) res(); }));
    const t0 = Date.now();
    for (const p of ['/api/ready', '/api/ready?require_spec_ready=1', '/api/tasks', '/api/board', `/api/tasks/${id}`]) {
      const r = await c.g.call('GET', p);
      okStatus(r, 200, p);
    }
    assert.ok(Date.now() - t0 < 3000, `reads answered while the lock was held (${Date.now() - t0} ms of its 6,000)`);
    assert.ok((await c.g.ready('?require_spec_ready=1')).body.ready.some((x: any) => x.id === id));
  } finally { holder.kill(); }
}));

// ---------- every size needs a review ----------
const strictIds = async (g: Api): Promise<string[]> => (await g.ready('?require_spec_ready=1')).body.ready.map((i: any) => i.id);
const PASS_V1 = { spec_version: 1, by: C, family: 'openai', verdict: 'pass', at: '2026-10-27T10:00:00+09:00' };

test('12 every size needs a review: small, big and no size are draft until another family passes this exact version', () => withBoard(async (c) => {
  const ss: any = await import('../src/lib/spec-state.ts');
  // Unit: stateOf, every size × no review / pass this version / pass older version / fail.
  for (const size of ['small', 'big', null]) {
    const spec = { text: card({ size }), version: 3 };
    assert.equal(ss.stateOf(spec, null), 'draft', `${size}: no review`);
    assert.equal(ss.stateOf(spec, { ...PASS_V1, spec_version: 3 }), 'ready', `${size}: pass on this version`);
    assert.equal(ss.stateOf(spec, { ...PASS_V1, spec_version: 2 }), 'draft', `${size}: pass on an older version`);
    assert.equal(ss.stateOf(spec, { ...PASS_V1, spec_version: 3, verdict: 'fail' }), 'draft', `${size}: fail`);
    assert.equal(ss.stateOf({ text: card({ size, acc: null }), version: 3 }, { ...PASS_V1, spec_version: 3 }), 'draft', `${size}: no Acceptance`);
  }
  // Board over HTTP.
  const state = async (id: string) => (await c.g.task(id)).spec_state;
  const ids: [string, string | null][] = [[c.mk('Review small'), 'small'], [c.mk('Review big'), 'big'], [c.mk('Review no size'), null]];
  await settle();
  for (const [id, size] of ids) {
    okStatus(await c.g.put(id, card({ size }), A), 200);
    assert.equal(await state(id), 'draft', `${size}: Acceptance, no review → draft`);
    assert.ok(!(await strictIds(c.g)).includes(id), `${size}: strict ready leaves out an unreviewed spec`);
    okStatus(await c.g.reviewNow(id, 'fail', C), 200);
    assert.equal(await state(id), 'draft', `${size}: fail → draft`);
    okStatus(await c.g.reviewNow(id, 'pass', B), 403, `${size}: same family as the author`);
    assert.equal(await state(id), 'draft', `${size}: refused review → draft`);
    // A pass on an older version: refused (409), the state stays draft.
    const v = await c.g.specVersion(id);
    okStatus(await c.g.put(id, card({ size, bg: 'second version' }), A), 200);
    okStatus(await c.g.review(id, { spec_version: v, verdict: 'pass' }, C), 409, `${size}: pass on v${v}`);
    assert.equal(await state(id), 'draft', `${size}: pass on an older version → draft`);
    // A pass on this version → ready; the next version leaves that pass behind → draft.
    okStatus(await c.g.reviewNow(id, 'pass', C), 200);
    assert.equal(await state(id), 'ready', `${size}: pass on this version → ready`);
    assert.ok((await strictIds(c.g)).includes(id), `${size}: strict ready lists it after the pass`);
    okStatus(await c.g.put(id, card({ size, bg: 'third version' }), A), 200);
    assert.equal(await state(id), 'draft', `${size}: a newer version without its own pass → draft`);
    assert.equal((await c.g.task(id)).spec_review ?? null, null);
    assert.ok(!(await strictIds(c.g)).includes(id));
  }
  // MCP review_spec gives the same result as HTTP for a small card.
  const t = c.mk('Review small over MCP'); await settle();
  okStatus(await c.g.put(t, card(), A), 200);
  assert.equal(await state(t), 'draft');
  const m = mcp(c.s.url, C);
  try {
    await m.rpc('initialize', { protocolVersion: '2025-06-18' });
    const x = await m.call('review_spec', { id: t, spec_version: await c.g.specVersion(t), verdict: 'pass' });
    assert.equal(x.err, false, x.text); assert.equal(x.json.spec_state, 'ready');
    assert.equal(await state(t), 'ready');
    assert.ok((await strictIds(c.g)).includes(t));
  } finally { m.proc.kill(); }
}));

test('13 auto-ok header change carries the pass: only an auto-ok header line changed keeps the review; anything else clears it', () => withBoard(async (c) => {
  const ss: any = await import('../src/lib/spec-state.ts');
  const okLine = 'auto-ok: true  # build after a spec-review pass\n';
  const base = card();
  // Unit: fieldsAfterSpecWrite(task, spec, prevText).
  const t1 = { id: 'shared.t-spec', spec_state: 'ready', spec_review: PASS_V1 } as any;
  const v2 = (text: string) => ({ text, version: 2 });
  const carried = (f: any, state = 'ready') => { assert.deepEqual(f.spec_review, { ...PASS_V1, spec_version: 2 }); assert.equal(f.spec_state, state); };
  const cleared = (f: any, what: string) => { assert.equal(f.spec_review, undefined, what); assert.equal(f.spec_state, 'draft', what); };
  carried(ss.fieldsAfterSpecWrite(t1, v2(card({ head: okLine })), base));
  carried(ss.fieldsAfterSpecWrite({ ...t1, spec_review: { ...PASS_V1 } }, v2(card({ head: 'auto-ok: false  # held\n' })), card({ head: okLine })));
  carried(ss.fieldsAfterSpecWrite(t1, v2(base), card({ head: okLine })));
  carried(ss.fieldsAfterSpecWrite({ ...t1, spec_state: 'blocked', blocked_by: D }, v2(card({ head: okLine })), base), 'blocked');
  cleared(ss.fieldsAfterSpecWrite(t1, v2(base), base), 'identical text');
  cleared(ss.fieldsAfterSpecWrite(t1, v2(card({ head: okLine })), undefined), 'no previous text (two-argument call)');
  cleared(ss.fieldsAfterSpecWrite(t1, v2(card({ head: okLine, bg: 'changed' })), base), 'body change');
  cleared(ss.fieldsAfterSpecWrite(t1, v2(card({ head: okLine + 'note_x: none\n' })), base), 'another header line');
  cleared(ss.fieldsAfterSpecWrite(t1, v2(card({ size: 'big', head: okLine })), base), 'size change');
  cleared(ss.fieldsAfterSpecWrite({ ...t1, spec_review: { ...PASS_V1, verdict: 'fail' } }, v2(card({ head: okLine })), base), 'previous review a fail');
  cleared(ss.fieldsAfterSpecWrite({ ...t1, spec_review: undefined, spec_state: 'draft' }, v2(card({ head: okLine })), base), 'no previous review');
  cleared(ss.fieldsAfterSpecWrite(t1, { text: card({ head: okLine }), version: 3 }, base), 'previous review on an older version');
  for (const ch of [' ', ' ', '\u0085', '\u0007', '\u007f', '\u001f'])
    cleared(ss.fieldsAfterSpecWrite(t1, v2(card({ head: `auto-ok: true${ch}repo: example-org/lanes\n` })), base), `auto-ok line with U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  // Board over HTTP.
  const id = c.mk('Carry card'); await settle();
  const task = () => c.g.task(id);
  const pass = async () => { okStatus(await c.g.reviewNow(id, 'pass', C), 200); assert.equal((await task()).spec_state, 'ready'); };
  const keeps = async (text: string, what: string) => {
    const before = (await task()).spec_review; const v = await c.g.specVersion(id);
    assert.equal(before?.verdict, 'pass', `${what}: a pass before`);
    okStatus(await c.g.put(id, text, A), 200, what);
    const t = await task();
    assert.equal(await c.g.specVersion(id), v + 1, `${what}: a new version`);
    assert.deepEqual(t.spec_review, { ...before, spec_version: v + 1 }, `${what}: the pass moves to v${v + 1}, same by/family/verdict`);
    assert.equal(t.spec_state, 'ready', what);
    assert.ok((await strictIds(c.g)).includes(id), `${what}: still strict ready`);
  };
  const clears = async (text: string, what: string) => {
    okStatus(await c.g.put(id, text, A), 200, what);
    const t = await task();
    assert.equal(t.spec_review ?? null, null, `${what}: review cleared`);
    assert.equal(t.spec_state, 'draft', `${what}: draft`);
    assert.ok(!(await strictIds(c.g)).includes(id), `${what}: not strict ready`);
  };
  okStatus(await c.g.put(id, base, A), 200);
  await clears(card({ head: okLine }), 'auto-ok added with no review');
  await clears(base, 'back to the base, still no review');
  await pass();
  await keeps(card({ head: okLine }), 'auto-ok added');
  await keeps(card({ head: 'auto-ok: false  # held for the user: a taste ask\n' }), 'auto-ok changed');
  await keeps(base, 'auto-ok removed');
  await clears(base, 'identical text');
  await pass(); await clears(card({ head: okLine, bg: 'Background changed too.' }), 'auto-ok added with a body change');
  await pass(); await clears(card({ head: okLine + 'note_x: none\n' }), 'auto-ok added with another header line');
  await pass(); await clears(card({ head: okLine, size: 'big' }), 'auto-ok added with a size change');
  for (const [sep, name] of [[' ', 'U+2028'], [' ', 'U+2029'], ['\u0085', 'U+0085']]) {
    for (const smuggled of ['repo: example-org/lanes', 'touches: src/**']) {
      okStatus(await c.g.put(id, base, A), 200); await pass();
      await clears(card({ head: `auto-ok: true${sep}${smuggled}\n` }), `auto-ok line smuggling "${smuggled}" through ${name}`);
    }
  }
}));

test('14 stored ready is not downgraded: a stored spec_state ready stays ready after a restart and an unrelated edit; reads write nothing', async () => {
  const rows: [string, string | null, boolean][] = [['sb', 'small', false], ['sp', 'small', true], ['bb', 'big', false], ['bp', 'big', true], ['nb', null, false]];
  const fx = rows.map(([n, , r]) => taskFixture({ id: `shared.t-st-${n}`, goal: 'shared', title: `Stored ${n}`, milestone: 'shared.m1', spec_state: 'ready', ...(r ? { spec_review: PASS_V1 } : {}) } as any));
  await withBoard(async (c) => {
    for (const [n, size] of rows) writeSpecFiles(c.root, `shared.t-st-${n}`, card({ size }));
    execFileSync('git', ['-C', c.root, 'add', 'data']); execFileSync('git', ['-C', c.root, 'commit', '-qm', 'stored ready specs']);
    await c.restart();
    const h0 = head(c.root); const files0 = fx.map((t) => fs.readFileSync(path.join(c.root, t.file), 'utf8'));
    const look = async (what: string) => {
      const strict = await strictIds(c.g);
      for (const t of fx) {
        assert.equal((await c.g.task(t.id)).spec_state, 'ready', `${what}: ${t.id}`);
        assert.ok(strict.includes(t.id), `${what}: strict ready lists ${t.id}`);
      }
    };
    await look('first read'); await c.restart(); await look('after a restart');
    assert.equal(head(c.root), h0, 'reads write nothing');
    assert.deepEqual(fx.map((t) => fs.readFileSync(path.join(c.root, t.file), 'utf8')), files0, 'task files unchanged');
    // An unrelated task edit keeps a stored ready with a pass review ready.
    okStatus(await c.g.call('POST', '/api/tasks/shared.t-st-sp', { priority: 'p1' }, c.g.as(D)), 200, 'unrelated edit');
    const t = await c.g.task('shared.t-st-sp');
    assert.equal(t.priority, 'p1'); assert.equal(t.spec_state, 'ready'); assert.deepEqual(t.spec_review, PASS_V1);
    assert.ok((await strictIds(c.g)).includes('shared.t-st-sp'));
  }, {}, fx);
});

test('an auto-ok line that splits pass_checks from its items clears the pass; a body example of auto-ok does not block the carry', () => withBoard(async (c) => {
  const ss: any = await import('../src/lib/spec-state.ts');
  const okLine = 'auto-ok: true  # approved\n';
  const t1 = { id: 'shared.t-spec', spec_state: 'ready', spec_review: PASS_V1 } as any;
  const v2 = (text: string) => ({ text, version: 2 });
  for (const size of ['small', 'big']) {
    const base = card({ size });
    // Between `pass_checks:` and its items, a line reader (the dask CLI) sees no checks any more.
    const split = base.replace('pass_checks:\n', `pass_checks:\n${okLine}`);
    assert.notEqual(split, base);
    let f = ss.fieldsAfterSpecWrite(t1, v2(split), base);
    assert.equal(f.spec_review, undefined, `${size}: auto-ok inside pass_checks clears`); assert.equal(f.spec_state, 'draft');
    // ... and removing such a line again is not carried either.
    f = ss.fieldsAfterSpecWrite(t1, v2(base), split);
    assert.equal(f.spec_review, undefined, `${size}: removing an auto-ok line from inside pass_checks clears`);
    // An indented auto-ok line (a continuation for line readers) clears.
    f = ss.fieldsAfterSpecWrite(t1, v2(card({ size, head: `  ${okLine}` })), base);
    assert.equal(f.spec_review, undefined, `${size}: indented auto-ok clears`);
    // An unchanged body example `auto-ok: <true|false>` does not stop a plain header auto-ok line from carrying.
    const ex = { size, bg: 'Example header:\n\n```\nauto-ok: <true|false>\n```' };
    f = ss.fieldsAfterSpecWrite(t1, v2(card({ ...ex, head: okLine })), card(ex));
    assert.deepEqual(f.spec_review, { ...PASS_V1, spec_version: 2 }, `${size}: body example, header auto-ok added → carried`);
    assert.equal(f.spec_state, 'ready');
  }
  // Over HTTP: the body example card gets its auto-ok line after the pass and stays ready.
  const id = c.mk('Body example'); await settle();
  const ex = { bg: 'Example header:\n\n```\nauto-ok: <true|false>\n```' };
  okStatus(await c.g.put(id, card(ex), A), 200);
  okStatus(await c.g.reviewNow(id, 'pass', C), 200);
  okStatus(await c.g.put(id, card({ ...ex, head: okLine }), A), 200);
  assert.equal((await c.g.task(id)).spec_state, 'ready');
  okStatus(await c.g.put(id, card(ex).replace('pass_checks:\n', `pass_checks:\n${okLine}`), A), 200);
  assert.equal((await c.g.task(id)).spec_state, 'draft', 'auto-ok moved inside pass_checks: draft');
}));

test('an auto-ok line before a blank line and the pass_checks items clears the pass; after the last item it carries', async () => {
  const ss: any = await import('../src/lib/spec-state.ts');
  const okLine = 'auto-ok: true  # approved\n';
  const t1 = { id: 'shared.t-spec', spec_state: 'ready', spec_review: PASS_V1 } as any;
  const v2 = (text: string) => ({ text, version: 2 });
  for (const size of ['small', 'big']) {
    const gap = card({ size }).replace('pass_checks:\n', 'pass_checks:\n\n');
    for (const blanks of ['', '\n', '\n\n']) {
      const split = gap.replace('pass_checks:\n', `pass_checks:\n${okLine}${blanks}`);
      assert.notEqual(split, gap);
      const f = ss.fieldsAfterSpecWrite(t1, v2(split), gap);
      assert.equal(f.spec_review, undefined, `${size}: auto-ok, ${blanks.length + 1} blank line(s), then the items → cleared`);
      assert.equal(f.spec_state, 'draft');
    }
    const base = card({ size });
    const after = base.replace('  - over the cap is 413\n', `  - over the cap is 413\n${okLine}`);
    assert.notEqual(after, base);
    const f = ss.fieldsAfterSpecWrite(t1, v2(after), base);
    assert.deepEqual(f.spec_review, { ...PASS_V1, spec_version: 2 }, `${size}: auto-ok after the last item → carried`);
    assert.equal(f.spec_state, 'ready');
  }
});
