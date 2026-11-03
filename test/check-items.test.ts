// Check items: store, HTTP and MCP.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { checkEvidence, itemsRelPath, itemsView, reportItem, seedItems } from '../src/lib/items.ts';
import { createTask, git, HttpError, updateTask } from '../src/lib/write.ts';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const MCP = path.join(ROOT, 'mcp/dasks-mcp.mjs');
const A = 'claude-code@desktop';
const err = (fn: () => unknown): HttpError | null => { try { fn(); return null; } catch (e) { if (e instanceof HttpError) return e; throw e; } };
const status = (fn: () => unknown) => err(fn)?.status ?? 0;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
// Fake credential, assembled at run time so the push secret scanner does not see a key-shaped literal.
const TOKEN = 'gh' + 'p_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3hJ5';

// Full card bodies: a Context section, numbered Done criteria, a Notes section after them.
const CARD_A = `
## Context
- \`scripts/build.sh\` packs the site into \`dist/\` and copies the images.

## Done criteria
1. \`bash scripts/build.sh\` exits 0 on main and \`dist/\` has the same file list as a local build.
2. The local build is unchanged.
3. The README says how to build on a second machine.
4. Build log path in the PR or card result.
`;
const CARD_B = `
## Context
- The contact form sends one field at a time; nothing is sent until "보내기" (Korean label kept on purpose).

## Done criteria
1. The form steps through its three sections (1/3, 2/3, 3/3) with Back; each step keeps what was typed.
2. Nothing is sent until the last step's Send; a summary shows every answer first.
3. The form works on a phone-sized screen.
4. Tests: back and forward keep answers, a partial form is never sent.
5. Real run: start the site locally, fill the form in a browser, and put the run log path and a screenshot path in the PR. The log shows every step, every answer and the final send, and the screenshot shows the summary before sending, so a reviewer can follow the whole run from start to end without starting it again.

## Notes
- 2026-01-15 09:00 agent@desktop: claim: #run-202601150900 open
`;
const THREE = (a = 'First check passes.', b = 'Second check   passes\twith tabs.', c = 'Third check passes.') =>
  `\n## Context\nx\n\n## Done criteria\n1. ${a}\n2. ${b}\n   indented continuation is ignored\n  3. indented numbered line is ignored\n\`\`\`\n9. inside a fence is ignored\n## Not a heading inside a fence\n\`\`\`\n3. ${c}\n\n## Notes\n4. after the next heading is ignored\n`;

const newCard = (root: string, body: string, title = 'Check items sample') => createTask(root, { goal: 'shared', title, body }, 'helper');
const storeFile = (root: string, id: string) => path.join(root, itemsRelPath(id));
const readStore = (root: string, id: string) => JSON.parse(fs.readFileSync(storeFile(root, id), 'utf8'));
/** A stored spec version (as the spec store writes it), committed, for the pass_checks fallback. */
function putSpec(root: string, id: string, text: string) {
  const [goal, slug] = [id.slice(0, id.indexOf('.')), id.slice(id.indexOf('.') + 1)];
  const dir = path.join(root, 'data', 'specs', goal, slug);
  fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'versions', '1.md'), text);
  fs.writeFileSync(path.join(dir, 'versions', '1.json'), JSON.stringify({ version: 1, by: 'spec', at: '2026-10-29T10:00:00+09:00', note: '', sha256: 'x', section_authors: { acceptance_tests: null, oracle: null }, warnings: [] }));
  fs.writeFileSync(`${dir}.md`, text);
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'spec fixture']);
}

test('seed from Done criteria', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = newCard(root, THREE());
    const v = seedItems(root, t.id, {}, A);
    assert.equal(v.task, t.id); assert.equal(v.version, 1); assert.equal(v.source, 'body'); assert.match(String(v.seeded_at), AT_RE);
    assert.deepEqual(v.items.map((i: any) => [i.n, i.text, i.state, i.result, i.evidence.length]), [
      [1, 'First check passes.', 'open', '', 0],
      [2, 'Second check passes with tabs.', 'open', '', 0],
      [3, 'Third check passes.', 'open', '', 0],
    ]);
    assert.deepEqual(v.progress, { done: 0, total: 3 });
    assert.deepEqual(v.warnings, []);
    assert.match(git(root, ['log', '-1', '--format=%s']).trim(), new RegExp(`^${A}: items ${t.id.replace(/\./g, '\\.')} seed$`));
    const f = readStore(root, t.id);
    assert.deepEqual(Object.keys(f).sort(), ['events', 'items', 'seeded_at', 'source', 'task', 'version']);
    assert.equal(f.events.length, 1);
    assert.deepEqual(f.events[0].items, ['First check passes.', 'Second check passes with tabs.', 'Third check passes.']);
    assert.equal(f.events[0].type, 'seed'); assert.equal(f.events[0].by, A); assert.equal(f.events[0].version, 1);
    const a = newCard(root, CARD_A, 'Card A');
    const b = newCard(root, CARD_B, 'Card B');
    const va = seedItems(root, a.id, {}, A);
    assert.equal(va.items.length, 4); assert.equal(va.items[3].text, 'Build log path in the PR or card result.');
    // a criterion over the 300-character cap refuses the seed and names the line
    const eb = err(() => seedItems(root, b.id, {}, A));
    assert.equal(eb?.status, 400); assert.match(eb!.message, /Done criteria line 5 is over 300 characters \(\d+\)/);
    // indented and longer fences hide their numbered lines too
    const fenced = newCard(root, '\n## Done criteria\n   ```md\n9. example output\n   ```\n1. Real check.\n````\n```\n8. still inside\n````\n~~~\n7. tilde fence\n~~~\n2. Second real check.\n', 'Fenced');
    assert.deepEqual(seedItems(root, fenced.id, {}, A).items.map((i: any) => i.text), ['Real check.', 'Second real check.']);
  } finally { cleanup(); }
});

test('seed falls back to spec pass_checks', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = newCard(root, '\n## Context\nno criteria here\n\n## Done criteria\n- a bullet is not a numbered item\n');
    putSpec(root, t.id, [
      'id: x', '```', 'pass_checks:', '- decoy inside a fence', '```', 'pass_checks:',
      '- `node --test test/check-items.test.ts` passes', '- docs: the README section added in the same PR',
      '  - indented, not counted', '- after an indented line, not consecutive', 'pass_checks:', '- a second pass_checks line is ignored', '',
    ].join('\n'));
    const v = seedItems(root, t.id, {}, A);
    assert.equal(v.source, 'spec');
    assert.deepEqual(v.items.map((i: any) => i.text), ['`node --test test/check-items.test.ts` passes', 'docs: the README section added in the same PR']);
  } finally { cleanup(); }
});

test('no criteria is 409', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = newCard(root, '\n## Context\nnothing numbered\n');
    const e = err(() => seedItems(root, t.id, {}, A));
    assert.equal(e?.status, 409); assert.match(e!.message, /no done criteria/);
    assert.ok(!fs.existsSync(storeFile(root, t.id)), 'nothing written');
    // a Done criteria heading with no numbered lines and no spec: the same
    const h = newCard(root, '\n## Done criteria\n- bullets only\n', 'Bullets');
    assert.equal(status(() => seedItems(root, h.id, {}, A)), 409);
    // bad sources: 400 for the whole request, nothing written
    const long = newCard(root, `\n## Done criteria\n1. ok\n2. ${'x'.repeat(301)}\n`, 'Long');
    const le = err(() => seedItems(root, long.id, {}, A));
    assert.equal(le?.status, 400); assert.match(le!.message, /line 2/);
    const many = newCard(root, '\n## Done criteria\n' + Array.from({ length: 31 }, (_, i) => `${i + 1}. item ${i + 1}`).join('\n') + '\n', 'Many');
    assert.equal(status(() => seedItems(root, many.id, {}, A)), 400);
    const empty = newCard(root, '\n## Done criteria\n1. fine\n2. \n', 'Empty');
    assert.equal(status(() => seedItems(root, empty.id, {}, A)), 400);
    for (const c of [long, many, empty]) assert.ok(!fs.existsSync(storeFile(root, c.id)));
    assert.equal(status(() => seedItems(root, 'shared.t-msng', {}, A)), 404);
    assert.equal(status(() => seedItems(root, t.id, { items: [] }, A)), 400);
  } finally { cleanup(); }
});

test('re-seed keeps matching results and retires the rest', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = newCard(root, THREE('Old first.', 'Keeps its result.', 'Third.'));
    seedItems(root, t.id, {}, A);
    const ev = [{ kind: 'pr', ref: 'https://github.com/example-org/dasks/pull/150' }];
    const r = reportItem(root, t.id, '2', { state: 'done', result: 'passed on main', evidence: ev }, 'codex@desktop');
    const reported = r.items[1];
    // body edited: item 1 text changed, item 2 moved to position 1, a new item added
    updateTask(root, t.id, {}, 'helper', { body: '\n## Done criteria\n1. Keeps its result.\n2. New first.\n3. Third.\n4. Brand new.\n' });
    const v = seedItems(root, t.id, { expected_version: 2 }, A);
    assert.equal(v.version, 3);
    assert.deepEqual(v.items.map((i: any) => [i.n, i.text, i.state]), [[1, 'Keeps its result.', 'done'], [2, 'New first.', 'open'], [3, 'Third.', 'open'], [4, 'Brand new.', 'open']]);
    assert.equal(v.items[0].result, 'passed on main'); assert.deepEqual(v.items[0].evidence, ev);
    assert.equal(v.items[0].by, 'codex@desktop'); assert.equal(v.items[0].at, reported.at);
    assert.deepEqual(v.progress, { done: 1, total: 4 });
    const seed = readStore(root, t.id).events.at(-1);
    assert.equal(seed.type, 'seed');
    assert.deepEqual(seed.kept, [{ n: 1, from_n: 2 }, { n: 3, from_n: 3 }]);
    assert.deepEqual(seed.retired, ['Old first.']);
    // duplicates match one to one, in order; a text retired earlier and added again starts open
    updateTask(root, t.id, {}, 'helper', { body: '\n## Done criteria\n1. Third.\n2. Keeps its result.\n3. Keeps its result.\n4. Old first.\n' });
    const d = seedItems(root, t.id, {}, A);
    assert.deepEqual(d.items.map((i: any) => i.state), ['open', 'done', 'open', 'open']);
    assert.deepEqual(readStore(root, t.id).events.at(-1).kept, [{ n: 1, from_n: 3 }, { n: 2, from_n: 1 }]);
  } finally { cleanup(); }
});

test('report sets state result evidence by at', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = newCard(root, THREE());
    seedItems(root, t.id, {}, A);
    const ev = [{ kind: 'pr', ref: 'https://github.com/example-org/dasks/pull/150' }, { kind: 'tests', ref: '41/42' }];
    const v = reportItem(root, t.id, '1', { state: 'failed', result: '  one test still fails  ', evidence: ev }, 'codex@desktop');
    const i = v.items[0];
    assert.deepEqual([i.state, i.result, i.by, i.host], ['failed', 'one test still fails', 'codex@desktop', '']);
    assert.deepEqual(i.evidence, ev); assert.match(i.at, AT_RE);
    assert.deepEqual(v.warnings, []);
    assert.match(git(root, ['log', '-1', '--format=%s']).trim(), /^codex@desktop: items shared\.t-\S+ report$/);
    const e = readStore(root, t.id).events.at(-1);
    assert.deepEqual({ ...e, at: '' }, { type: 'report', version: 2, by: 'codex@desktop', at: '', n: 1, text: 'First check passes.', state: 'failed', result: 'one test still fails', evidence: ev, host: '' });
    // a report is the full current result: omitted result/evidence are empty; done without evidence only warns
    const d = reportItem(root, t.id, '1', { state: 'done' }, A);
    assert.deepEqual([d.items[0].state, d.items[0].result, d.items[0].evidence], ['done', '', []]);
    assert.deepEqual(d.warnings, ['done without evidence']);
    assert.deepEqual(reportItem(root, t.id, '2', { state: 'done', evidence: [{ kind: 'tests', ref: '3/3' }] }, A).warnings, []);
    for (const body of [{ state: 'bad' }, {}, { state: 'done', by: 'helper' }, { state: 'done', at: 'x' }, { state: 'done', result: 'two\nlines' },
      { state: 'done', result: 'x'.repeat(201) }, { state: 'done', result: 7 }, { state: 'done', evidence: 'x' }, { state: 'done', host: 'bad host' }])
      assert.equal(status(() => reportItem(root, t.id, '1', body, A)), 400, JSON.stringify(body));
    assert.equal(status(() => reportItem(root, t.id, 'x', { state: 'done' }, A)), 400);
    assert.equal(status(() => reportItem(root, t.id, '0', { state: 'done' }, A)), 400);
    assert.equal(status(() => reportItem(root, t.id, '9', { state: 'done' }, A)), 404);
    assert.equal(status(() => reportItem(root, 'shared.t-msng', '1', { state: 'done' }, A)), 404);
  } finally { cleanup(); }
});

test('events file only grows', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = newCard(root, THREE());
    seedItems(root, t.id, {}, A);
    const writes: (() => unknown)[] = [
      () => reportItem(root, t.id, '1', { state: 'done', evidence: [{ kind: 'tests', ref: '1/1' }] }, A),
      () => seedItems(root, t.id, {}, A), // nothing changed: still recorded, still a new version
      () => reportItem(root, t.id, '1', { state: 'open' }, A),
    ];
    for (const w of writes) {
      const before = readStore(root, t.id);
      const commits = Number(git(root, ['rev-list', '--count', 'HEAD']).trim());
      w();
      const after = readStore(root, t.id);
      assert.deepEqual(after.events.slice(0, before.events.length), before.events, 'old events are a prefix of the new ones');
      assert.equal(after.events.length, before.events.length + 1);
      assert.equal(after.version, before.version + 1); assert.equal(after.events.at(-1).version, after.version);
      assert.equal(Number(git(root, ['rev-list', '--count', 'HEAD']).trim()), commits + 1, 'one commit per write');
    }
    assert.deepEqual(itemsView(root, t.id, { history: true }).events!.map((e: any) => e.type), ['seed', 'report', 'seed', 'report']);
  } finally { cleanup(); }
});

test('evidence shapes', () => {
  const ok: [string, string][] = [
    ['pr', 'https://github.com/example-org/dasks/pull/150'],
    ['commit', 'https://github.com/example-org/dasks/commit/45cb2cfa'],
    ['commit', 'https://github.com/example-org/dasks/commit/' + 'a'.repeat(40)],
    ['log', '.dask/logs/shared.t-chki/test.log'],
    ['log', '/tmp/example-work/jobs/x/RESULT.md'],
    ['screenshot', '/tmp/shot.png'], ['screenshot', 'https://example.com/a/b.webp'], ['screenshot', '.dask/logs/c/raw/s.JPG'],
    ['video', '/tmp/run.mp4'], ['video', 'https://example.com/v.webm'],
    ['tests', '41/42'], ['tests', '0/0'],
  ];
  for (const [kind, ref] of ok) assert.deepEqual(checkEvidence([{ kind, ref }], 'laptop'), [{ kind, ref }], `${kind} ${ref}`);
  const bad: [string, string][] = [
    ['log', 'logs/test.log'],                                   // relative path
    ['log', '/tmp/../etc/test.log'],                            // ..
    ['log', '.dask/logs/%2e%2e/x.log'],                         // .. once decoded
    ['screenshot', 'http://example.com/a.png'],                 // http URL
    ['screenshot', 'https://example.com/a.png?x=1'],            // query
    ['screenshot', 'https://example.com/a.png#f'],              // fragment
    ['screenshot', 'https://user:pass' + '@' + 'example.com/a.png'], // userinfo
    ['screenshot', 'https://x:abc/a.png'],                      // does not parse (bad port)
    ['tests', '5/3'], ['tests', 'five/3'],
    ['log', 'https://example.com/test.log'],                    // log is a path only
    ['log', '/tmp/notes.txt'],
    ['pr', 'https://gitlab.com/a/b/pull/1'], ['pr', 'https://github.com/a/b/pull/1?x=1'],
    ['commit', 'https://github.com/a/b/commit/xyz1234'], ['commit', 'https://github.com/a/b/commit/abc12'],
    ['video', '/tmp/run.gif'], ['screenshot', '/tmp/my shot.png'], ['screenshot', '/tmp/%zz.png'], ['nope', '/tmp/a.png'],
    ['screenshot', '/' + 'a'.repeat(500) + '.png'],
  ];
  for (const [kind, ref] of bad) {
    let e: HttpError | null = null;
    try { checkEvidence([{ kind: 'tests', ref: '1/1' }, { kind, ref }], 'laptop'); } catch (x) { e = x as HttpError; }
    assert.equal(e?.status, 400, `${kind} ${ref} should be refused`);
    assert.match(e!.message, /evidence\[1\]/, 'names the bad index');
  }
  assert.throws(() => checkEvidence(Array.from({ length: 11 }, () => ({ kind: 'tests', ref: '1/1' })), ''), /at most 10/);
  assert.throws(() => checkEvidence([{ kind: 'tests', ref: '1/1', note: 'x' }], ''), HttpError);
});

test('path evidence needs host', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = newCard(root, THREE());
    seedItems(root, t.id, {}, A);
    for (const ev of [{ kind: 'log', ref: '/tmp/a.log' }, { kind: 'screenshot', ref: '.dask/logs/c/raw/a.png' }, { kind: 'video', ref: '/tmp/a.mov' }]) {
      const e = err(() => reportItem(root, t.id, '1', { state: 'done', evidence: [ev] }, A));
      assert.equal(e?.status, 400); assert.match(e!.message, /host/);
    }
    // URLs and tests/pr/commit need no host
    assert.equal(reportItem(root, t.id, '1', { state: 'done', evidence: [{ kind: 'screenshot', ref: 'https://example.com/a.png' }, { kind: 'tests', ref: '1/1' }] }, A).items[0].host, '');
    const v = reportItem(root, t.id, '2', { state: 'done', evidence: [{ kind: 'log', ref: '/tmp/a.log' }], host: 'laptop' }, A);
    assert.equal(v.items[1].host, 'laptop');
    assert.equal(readStore(root, t.id).events.at(-1).host, 'laptop');
  } finally { cleanup(); }
});

test('expected_version mismatch is 409', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = newCard(root, THREE());
    const e = err(() => seedItems(root, t.id, { expected_version: 5 }, A));
    assert.equal(e?.status, 409); assert.equal(e?.data?.current_version, 0);
    seedItems(root, t.id, { expected_version: 0 }, A);
    assert.equal(status(() => reportItem(root, t.id, '1', { state: 'done', expected_version: 0 }, A)), 409);
    assert.equal(reportItem(root, t.id, '1', { state: 'done', expected_version: 1 }, A).version, 2);
    assert.equal(status(() => seedItems(root, t.id, { expected_version: 1 }, A)), 409);
    // order: shape 400 → task 404 → item 404 → version 409
    assert.equal(status(() => reportItem(root, t.id, '9', { state: 'done', expected_version: 0 }, A)), 404);
    assert.equal(status(() => reportItem(root, 'shared.t-msng', '9', { state: 'done', expected_version: 0 }, A)), 404);
    assert.equal(status(() => reportItem(root, 'shared.t-msng', '1', { state: 'bad', expected_version: 0 }, A)), 400);
    assert.equal(readStore(root, t.id).version, 2, 'refused writes write nothing');
  } finally { cleanup(); }
});

test('report does not change task status', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = newCard(root, THREE());
    seedItems(root, t.id, {}, A);
    const taskFile = path.join(root, t.file);
    const before = fs.readFileSync(taskFile);
    for (const n of ['1', '2', '3']) reportItem(root, t.id, n, { state: 'done', evidence: [{ kind: 'tests', ref: '1/1' }] }, A);
    assert.ok(fs.readFileSync(taskFile).equals(before), 'the task file is untouched');
    assert.equal(itemsView(root, t.id).progress.done, 3);
    assert.deepEqual(git(root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n'), [itemsRelPath(t.id)]);
  } finally { cleanup(); }
});

// ---------- live: HTTP and MCP ----------
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
}
async function startServer(root: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
}
function mcp(url: string, actor: string, cwd: string) {
  const proc = spawn(process.execPath, [MCP], { cwd, env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; let next = 1;
  const waiting = new Map<number, (v: any) => void>();
  proc.stdout!.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  const rpc = (method: string, params: any = {}) => new Promise<any>((res) => { const id = next++; waiting.set(id, res); proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name: string, args: any) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { err: !!r.isError, text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() }; };
  return { proc, rpc, call };
}
// Each live test writes its cards first, then starts its own board on that repo (the board loads them at start; a
// card written to disk under a running board waits on the file watcher, which can miss events on a busy host).
const boards: { proc: ChildProcess; cleanup: () => void }[] = [];
async function board<T>(make: (root: string) => T) {
  const { root, cleanup } = tempRepo(); const cards = make(root); const s = await startServer(root);
  boards.push({ proc: s.proc, cleanup }); return { root, url: s.url, cards };
}
after(() => { for (const b of boards) { b.proc.kill(); b.cleanup(); } });
async function waitTask(url: string, id: string) {
  for (let i = 0; i < 100; i++) { if ((await fetch(`${url}/api/tasks/${id}`)).ok) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`board never saw ${id}`);
}
const post = (url: string, p: string, body: any, actor = A) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });

test('progress N/M on task GET', async () => {
  const { root, url, cards: t } = await board((r) => newCard(r, THREE(), 'Progress'));
  await waitTask(url, t.id);
  let task = await (await fetch(`${url}/api/tasks/${t.id}`)).json();
  assert.equal(task.id, t.id); assert.ok(!('items_progress' in task), 'absent before seeding');
  let r = await fetch(`${url}/api/tasks/${t.id}/items`);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { task: t.id, version: 0, progress: { done: 0, total: 0 }, items: [] });
  r = await post(url, `/api/tasks/${t.id}/items/seed`, {});
  assert.equal(r.status, 200); const seeded = await r.json();
  assert.equal(seeded.version, 1); assert.deepEqual(seeded.warnings, []); assert.equal(seeded.items[0].state, 'open');
  r = await post(url, `/api/tasks/${t.id}/items/1`, { state: 'done', result: 'ok', evidence: [{ kind: 'log', ref: '/tmp/x.log' }, { kind: 'pr', ref: 'https://github.com/example-org/dasks/pull/150' }], host: 'laptop' });
  assert.equal(r.status, 200, await r.clone().text());
  task = await (await fetch(`${url}/api/tasks/${t.id}`)).json();
  assert.equal(task.items_progress, '1/3');
  const list = await (await fetch(`${url}/api/tasks`)).json();
  assert.ok(!('items_progress' in list.find((x: any) => x.id === t.id)), 'list endpoints unchanged');
  const v = await (await fetch(`${url}/api/tasks/${t.id}/items`)).json();
  assert.deepEqual(v.progress, { done: 1, total: 3 }); assert.equal(v.source, 'body'); assert.ok(!('events' in v));
  const h = await (await fetch(`${url}/api/tasks/${t.id}/items?history=1`)).json();
  assert.deepEqual(h.events.map((e: any) => e.type), ['seed', 'report']);
  // routes: unknown task 404, bad n 400, unknown n 404, unknown field 400
  assert.equal((await fetch(`${url}/api/tasks/shared.t-msng/items`)).status, 404);
  assert.equal((await post(url, '/api/tasks/shared.t-msng/items/1', { state: 'done' })).status, 404);
  assert.equal((await post(url, `/api/tasks/${t.id}/items/x`, { state: 'done' })).status, 400);
  assert.equal((await post(url, `/api/tasks/${t.id}/items/9`, { state: 'done' })).status, 404);
  assert.equal((await post(url, `/api/tasks/${t.id}/items/1`, { state: 'done', by: 'x' })).status, 400);
  assert.equal((await post(url, `/api/tasks/${t.id}/items/1`, { state: 'done', expected_version: 1 })).status, 409);
  // a broken store: the task GET drops items_progress, the items routes answer 500 and write nothing
  fs.writeFileSync(storeFile(root, t.id), '{"version": 2, "items": "nope"}');
  task = await (await fetch(`${url}/api/tasks/${t.id}`)).json();
  assert.equal(task.id, t.id); assert.ok(!('items_progress' in task));
  r = await fetch(`${url}/api/tasks/${t.id}/items`);
  assert.equal(r.status, 500); assert.match((await r.json()).error, /items store unreadable/);
  assert.equal((await post(url, `/api/tasks/${t.id}/items/1`, { state: 'done' })).status, 500);
  assert.equal((await post(url, `/api/tasks/${t.id}/items/seed`, {})).status, 500);
});

test('token in result or evidence is rejected and never stored', async () => {
  const { root, url, cards: [t, s] } = await board((r) => [newCard(r, THREE(), 'Tokens'), newCard(r, `\n## Done criteria\n1. use ${TOKEN} to log in\n`, 'Token text')]);
  await waitTask(url, t.id);
  assert.equal((await post(url, `/api/tasks/${t.id}/items/seed`, {})).status, 200);
  const bodies = [
    { state: 'done', result: `pushed with ${TOKEN}` },
    { state: 'done', evidence: [{ kind: 'log', ref: `/tmp/${TOKEN}.log` }], host: 'laptop' },
    // every character percent-encoded: only the decoded ref looks like a token
    { state: 'done', evidence: [{ kind: 'screenshot', ref: `https://example.com/${[...TOKEN].map((c) => '%' + c.charCodeAt(0).toString(16)).join('')}.png` }] },
    { state: 'done', result: 'fine', host: 'A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6S7t8' },
  ];
  for (const b of bodies) {
    const r = await post(url, `/api/tasks/${t.id}/items/1`, b);
    assert.equal(r.status, 400, JSON.stringify(b)); assert.equal((await r.json()).rule, 'token-like');
  }
  // the actor becomes `by` and the commit subject: checked too
  const ra = await post(url, `/api/tasks/${t.id}/items/1`, { state: 'done' }, 'A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6S7t8');
  assert.equal(ra.status, 400); assert.equal((await ra.json()).rule, 'token-like');
  // a token-shaped item text in the card: the seed is refused
  await waitTask(url, s.id);
  const rs = await post(url, `/api/tasks/${s.id}/items/seed`, {});
  assert.equal(rs.status, 400); assert.equal((await rs.json()).rule, 'token-like');
  // byte search of every file under data/items/ and of the git history
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
  walk(path.join(root, 'data', 'items'));
  assert.ok(files.length >= 1);
  for (const f of files) { const b = fs.readFileSync(f); assert.ok(!b.includes('ghp_') && !b.includes(TOKEN.slice(4)), f); }
  assert.ok(!git(root, ['log', '-p', '--all', '--', 'data/items']).includes(TOKEN.slice(4)));
  assert.equal(readStore(root, t.id).version, 1, 'nothing written');
});

test('MCP report_item refuses a missing local path', async () => {
  const { url, cards: t } = await board((r) => newCard(r, THREE(), 'MCP'));
  await waitTask(url, t.id);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'items-mcp-'));
  const logRel = `.dask/logs/${t.id}/test.log`;
  fs.mkdirSync(path.join(cwd, path.dirname(logRel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, logRel), 'ok\n');
  const m = mcp(url, 'claude-code@desktop', cwd);
  try {
    await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const tools = (await m.rpc('tools/list')).result.tools;
    for (const n of ['report_item', 'get_items']) assert.ok(tools.find((x: any) => x.name === n), n);
    assert.match(tools.find((x: any) => x.name === 'report_item').description, /optional/i);
    const g = await m.call('get_items', { id: t.id, seed: true });
    assert.ok(!g.err, g.text); assert.equal(g.json.items.length, 3);
    // a path that does not exist on this host: refused before the board is called
    const missing = path.join(cwd, 'nope', 'missing.log');
    const bad = await m.call('report_item', { id: t.id, n: 1, state: 'done', evidence: [{ kind: 'log', ref: missing }] });
    assert.ok(bad.err); assert.match(bad.text, /does not exist/); assert.match(bad.text, /missing\.log/);
    assert.equal((await m.call('get_items', { id: t.id, history: true })).json.events.length, 1, 'the board was not called');
    // existing relative .dask/logs path: sent absolute, host filled in; tests/pr refs are never checked
    const ok = await m.call('report_item', { id: t.id, n: 1, state: 'done', result: 'green', evidence: [{ kind: 'log', ref: logRel }, { kind: 'tests', ref: '3/3' }, { kind: 'pr', ref: 'https://github.com/example-org/dasks/pull/150' }] });
    assert.ok(!ok.err, ok.text);
    const item = ok.json.items[0];
    assert.ok(path.isAbsolute(item.evidence[0].ref) && item.evidence[0].ref.endsWith(logRel), item.evidence[0].ref);
    assert.equal(item.host, os.hostname().split('.')[0].replace(/[^A-Za-z0-9._@-]/g, '-').slice(0, 40));
    const h = await m.call('get_items', { id: t.id, seed: true, history: true, expected_version: 2 });
    assert.ok(!h.err, h.text); assert.equal(h.json.version, 3); assert.equal(h.json.events.length, 3);
    assert.equal(h.json.items[0].state, 'done', 're-seed kept the result');
  } finally { m.proc.kill(); fs.rmSync(cwd, { recursive: true, force: true }); }
});
