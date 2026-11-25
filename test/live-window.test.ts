// A card's live window: the in-memory store (caps, redaction, sensitive files) and its routes on a spawned server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { LiveStore, MAX_DIFF_BYTES, MAX_FILES, MAX_STEP_CHARS, MAX_STEPS, sanitizeDiff } from '../src/lib/live-window.ts';
import { SYSTEM_CFG, task, tempRepo } from './helpers.ts';
import { freePort, stopServer } from './spec-support.ts';

const CARD = 'shared.t-live';
const KEY = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
// Built at run time, so the file itself holds no key block header.
const PK = ['RSA', 'PRIVATE', 'KEY-----'].join(' ');
const diffOf = (file: string, ...lines: string[]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;

test('store: steps add up to the cap, files and diff replace, a new run starts over', () => {
  const s = new LiveStore();
  assert.equal(s.get(CARD).run_id, null);
  assert.deepEqual(s.get(CARD).steps, []);
  for (let i = 0; i < 5; i++) s.update(CARD, { run_id: 'r1', phase: 'building', steps: Array.from({ length: 10 }, (_, j) => ({ kind: 'tool', text: `step ${i}-${j}` })) }, 'runner@m');
  let w = s.get(CARD);
  assert.equal(w.steps.length, MAX_STEPS);
  assert.equal(w.steps.at(-1)!.text, 'step 4-9');
  s.update(CARD, { run_id: 'r1', files: [{ path: 'a.ts', status: 'A', added: 3 }], diff: diffOf('a.ts', 'x') }, 'runner@m');
  w = s.get(CARD);
  assert.equal(w.phase, 'building', 'phase kept when not sent');
  assert.deepEqual(w.files, [{ path: 'a.ts', status: 'A', added: 3, deleted: 0 }]);
  assert.match(w.diff, /^\+x$/m);
  s.update(CARD, { run_id: 'r1', ended: true }, 'runner@m');
  assert.equal(s.get(CARD).ended, true);
  assert.equal(s.get(CARD).diff, w.diff, 'a post without a diff keeps the last one');
  s.update(CARD, { run_id: 'r2', steps: [{ text: 'fresh' }] }, 'runner@m');
  w = s.get(CARD);
  assert.deepEqual(w.steps.map((x) => x.text), ['fresh']);
  assert.deepEqual(w.files, []);
  assert.equal(w.diff, '');
  assert.equal(w.ended, false);
});

test('store: caps on step length, files, diff bytes and cards', () => {
  const s = new LiveStore(3);
  const w = s.update(CARD, { run_id: 'r', steps: [{ text: 'y'.repeat(1000) }], files: Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts` })),
    diff: diffOf('big.ts', ...Array.from({ length: 2000 }, (_, i) => `line ${i} ${'z'.repeat(20)}`)) }, 'runner@m');
  assert.equal(w.steps[0].text.length, MAX_STEP_CHARS);
  assert.equal(w.files.length, MAX_FILES);
  assert.ok(Buffer.byteLength(w.diff) <= MAX_DIFF_BYTES);
  assert.equal(w.diff_truncated, true);
  assert.ok(!w.diff.endsWith('\n') && /^\+line \d+ z+$/.test(w.diff.split('\n').at(-1)!), 'cut on a line boundary');
  for (const id of ['a.t-1', 'a.t-2', 'a.t-3']) s.update(id, { run_id: 'r' }, 'runner@m');
  assert.equal(s.get(CARD).run_id, null, 'the oldest card was dropped');
  assert.equal(s.get('a.t-3').run_id, 'r');
});

test('store: secrets are redacted in steps, paths and diffs; sensitive and headerless sections are not shown', () => {
  const s = new LiveStore();
  const w = s.update(CARD, { run_id: 'r', steps: [{ text: `Bash: curl -H "Authorization: Bearer ${KEY}"` }, { text: `export API_KEY=${KEY}` }], files: [{ path: `${KEY}.txt` }],
    diff: `stray ${KEY}\n` + diffOf('src/a.ts', `const token = "${KEY}"`, `-----BEGIN ${PK}`, 'MIIEowIBAAKCAQEAx', `-----END ${PK}`, 'ok line')
      + diffOf('config/app.yaml', 'password: |', '  hunter2-plain') + diffOf('.env', 'X=plain-secret') }, 'runner@m');
  const all = JSON.stringify(w);
  assert.ok(!all.includes(KEY), all);
  for (const leak of ['MIIEowIBAAKCAQEAx', 'hunter2-plain', 'plain-secret', 'stray']) assert.ok(!all.includes(leak), leak);
  assert.match(w.diff, /^\+ok line$/m);
  assert.match(w.diff, /^diff --git a\/config\/app\.yaml b\/config\/app\.yaml\n\[diff omitted: sensitive file\]$/m);
  // A rename from a sensitive name hides the content too.
  const ren = sanitizeDiff('diff --git a/secrets.json b/notes.txt\nsimilarity index 90%\nrename from secrets.json\nrename to notes.txt\n@@ -1 +1 @@\n+plain-value\n').diff;
  assert.ok(!ren.includes('plain-value'), ren);
});

test('sanitizeDiff: credential files by name, env-style new or renamed files, and noprefix headers', () => {
  for (const f of ['.pgpass', 'home/.netrc', '.npmrc', '.pypirc', '.git-credentials', '.htpasswd', 'deploy/kubeconfig', '.docker/config.json', '.kube/config',
    '.aws/credentials', '.ssh/id_ed25519', 'id_rsa', 'certs/site.pem', 'a.p12', 'tls.key', 'local.envrc', '.env.production']) {
    assert.doesNotMatch(sanitizeDiff(diffOf(f, 'pw-old-value-1')).diff, /pw-old-value-1/, f);
  }
  // A secrets file renamed to an innocent name, and a new file of KEY=value lines, show no content.
  const renamed = 'diff --git a/notes.txt b/later.txt\nsimilarity index 80%\nrename from notes.txt\nrename to later.txt\n@@ -1 +1,2 @@\n DB_PASS=hunter2\n+API_HOST=xyz-plain\n';
  assert.doesNotMatch(sanitizeDiff(renamed).diff, /hunter2|xyz-plain/);
  const added = 'diff --git a/seed.txt b/seed.txt\nnew file mode 100644\n--- /dev/null\n+++ b/seed.txt\n@@ -0,0 +1 @@\n+DB_PASS=plainpw\n';
  assert.doesNotMatch(sanitizeDiff(added).diff, /plainpw/);
  // An ordinary new code file still shows.
  assert.match(sanitizeDiff('diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+const x = 1;\n').diff, /^\+const x = 1;$/m);
  // diff.noprefix: headers without a/ b/ are read, not hidden; a sensitive one still is.
  const np = (f: string, l: string) => `diff --git ${f} ${f}\n--- ${f}\n+++ ${f}\n@@ -1 +1 @@\n+${l}\n`;
  assert.match(sanitizeDiff(np('src/a.ts', 'shown')).diff, /^\+shown$/m);
  assert.doesNotMatch(sanitizeDiff(np('.pgpass', 'hidden-pw')).diff, /hidden-pw/);
});

test('steps: secret command-line flags are redacted, ordinary flags kept', () => {
  const s = new LiveStore();
  const texts = ['Bash: redis-cli -a fixtureRedisOnly ping', 'Bash: mysql -uroot -pfixtureMysqlPw db', 'Bash: tool --password fixturePw1 --token=fixtureTok2',
    'Bash: curl -u bob:fixtureCurlPw https://x.test', "Bash: app --api-key 'fixture key3'", 'Bash: git add -A src && mkdir -p out'];
  const w = s.update(CARD, { run_id: 'r', steps: texts.map((text) => ({ text })) }, 'runner@m');
  const all = w.steps.map((x) => x.text).join('\n');
  for (const leak of ['fixtureRedisOnly', 'fixtureMysqlPw', 'fixturePw1', 'fixtureTok2', 'fixtureCurlPw', 'fixture key3']) assert.ok(!all.includes(leak), leak);
  assert.match(all, /curl -u bob:<redacted>/);
  assert.match(all, /git add -A src && mkdir -p out/);
});

test('store: bad bodies are refused with 400', () => {
  const s = new LiveStore();
  for (const body of [null, [], {}, { run_id: 'bad id!' }, { run_id: 'r', extra: 1 }, { run_id: 'r', phase: 'dancing' }, { run_id: 'r', steps: 'x' },
    { run_id: 'r', steps: [{ kind: 'shout', text: 'x' }] }, { run_id: 'r', files: [{ path: 'a', status: 'Z' }] }, { run_id: 'r', files: [{ path: 'a', added: -1 }] },
    { run_id: 'r', diff: 5 }, { run_id: 'r', ended: 'yes' }]) {
    assert.throws(() => s.update(CARD, body, 'runner@m'), (e: any) => e.status === 400, JSON.stringify(body));
  }
});

// ---------- routes ----------
const SERVER = path.resolve(import.meta.dirname, '../src/server.ts');
const TOKENS = path.resolve(import.meta.dirname, '../bin/dasks-tokens.ts');

async function withServer(mode: 'off' | 'enforce', fn: (url: string, root: string, token: string) => Promise<void>) {
  const { root, cleanup } = tempRepo([task({ id: CARD, goal: 'shared' })]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-live-test-'));
  const store = path.join(dir, 'agent-tokens.json');
  const tokEnv = { DASKS_AGENT_TOKENS_FILE: store, DASKS_UNSAFE_OWN_TOKENS_FILE: '1' };
  const token = execFileSync(process.execPath, [TOKENS, 'issue', 'runner@m'], { env: { ...process.env, ...tokEnv, DASKS_ROOT: root, DASKS_CONFIG: SYSTEM_CFG }, encoding: 'utf8' }).trim();
  const port = await freePort();
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, auth: { store: 'system' } }));
  const proc: ChildProcess = spawn(process.execPath, [SERVER], { env: { ...process.env, ...tokEnv, DASKS_ROOT: root, DASKS_CONFIG: cfg, DASKS_PORT: '', DASKS_AUTH_MODE: mode, DASKS_SECRETS_DIR: path.join(dir, 'secrets') }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    await fn(url, root, token);
  } finally { await stopServer(proc); cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const post = (url: string, body: unknown, h: Record<string, string> = { 'X-Dasks-Actor': 'runner@m' }, id = CARD) =>
  fetch(`${url}/api/tasks/${id}/live`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });

test('routes: GET answers an empty window, POST stores it, SSE says live, nothing lands in data/', async () => {
  await withServer('off', async (url, root) => {
    assert.equal((await fetch(`${url}/api/tasks/shared.t-nope/live`)).status, 404);
    assert.equal((await fetch(`${url}/api/tasks/bad/live`)).status, 400);
    const empty = await (await fetch(`${url}/api/tasks/${CARD}/live`)).json();
    assert.equal(empty.run_id, null);
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const events = new AbortController();
    const es = await fetch(`${url}/api/events`, { signal: events.signal });
    const reader = es.body!.getReader();
    assert.equal((await post(url, { run_id: 'r1' }, {})).status, 400, 'a writer must be named');
    assert.equal((await post(url, { run_id: 'r1' }, undefined, 'shared.t-nope')).status, 404);
    const r = await post(url, { run_id: 'r1', phase: 'building', steps: [{ kind: 'tool', text: `Read: src/a.ts ${KEY}` }], diff: diffOf('a.ts', 'hello') });
    assert.equal(r.status, 200);
    let seen = '';
    while (!seen.includes('event: live')) seen += new TextDecoder().decode((await reader.read()).value);
    assert.match(seen, /event: live\ndata: \{"card":"shared\.t-live"\}/);
    events.abort();
    const got = await (await fetch(`${url}/api/tasks/${CARD}/live`)).json();
    assert.equal(got.actor, 'runner@m');
    assert.equal(got.steps[0].text, 'Read: src/a.ts <redacted>');
    assert.match(got.diff, /^\+hello$/m);
    assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), head, 'no commit');
    assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain', 'data'], { encoding: 'utf8' }), '', 'data/ untouched');
  });
});

test('routes: with auth enforced a live write needs the agent token; reads stay open locally', async () => {
  await withServer('enforce', async (url, _root, token) => {
    assert.equal((await post(url, { run_id: 'r1' })).status, 401);
    assert.equal((await post(url, { run_id: 'r1' }, { 'X-Dasks-Actor': 'runner@m', Authorization: 'Bearer dsk_00000000_nottherealsecretatall' })).status, 401);
    const ok = await post(url, { run_id: 'r1', steps: [{ text: 'hi' }] }, { 'X-Dasks-Actor': 'runner@m', Authorization: `Bearer ${token}` });
    assert.equal(ok.status, 200);
    assert.equal((await (await fetch(`${url}/api/tasks/${CARD}/live`)).json()).steps[0].text, 'hi');
  });
});
