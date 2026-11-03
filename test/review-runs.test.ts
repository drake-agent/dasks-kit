// Cross-model review run records on the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createTask } from '../src/lib/write.ts';
import { tempRepo } from './helpers.ts';
import { freePort, sha256 as sha, stopServer } from './spec-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const CAP = 262_144;
const ACTOR = 'claude-code@laptop';

const HEAD_A = 'a'.repeat(40), HEAD_B = 'b'.repeat(40), MB = 'c'.repeat(40);

/** A review row (pass 1-3) with its answer and the answer's sha256. */
function passRow(pass: number, over: Record<string, unknown> = {}) {
  const answer = (over.answer as string | undefined) ?? `## Review pass ${pass}\nNo findings.\n`;
  return { pass, head: HEAD_A, base: 'main', merge_base: MB, tier: 'normal', mode: pass === 3 ? 'narrow' : 'simple', reviewer: 'codex example-model', impl: 'claude',
    verdict: 'clean', open: 0, noted: 0, at: '2026-10-28 08:20:00', log_sha256: sha(Buffer.from(answer, 'utf8')), answer, ...over };
}

async function startServer(root: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
}

interface Board { root: string; url: string; id: string; post: (body: unknown, o?: { actor?: string | null; raw?: string; id?: string }) => Promise<Response>; get: (id?: string) => Promise<Response>; restart: () => Promise<void> }
async function withBoard(fn: (b: Board) => Promise<void>) {
  const { root, cleanup } = tempRepo();
  const t = createTask(root, { goal: 'shared', title: 'Review card' }, 'helper');
  let srv = await startServer(root);
  const b: Board = {
    root, id: t.id, get url() { return srv.url; },
    post: (body, o = {}) => fetch(`${srv.url}/api/tasks/${o.id ?? t.id}/review-runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(o.actor === null ? {} : { 'X-Dasks-Actor': o.actor ?? ACTOR }) }, body: o.raw ?? JSON.stringify(body),
    }),
    get: (id = t.id) => fetch(`${srv.url}/api/tasks/${id}/review-runs`),
    restart: async () => { await stopServer(srv.proc); srv = await startServer(root); },
  };
  try { await fn(b); } finally { await stopServer(srv.proc); cleanup(); }
}

const git = (root: string, ...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
const commits = (root: string) => Number(git(root, 'rev-list', '--count', 'HEAD'));
const fileOf = (root: string, id: string) => path.join(root, 'data/review-runs', id.replace('.', '/') + '.jsonl');
/** What a refused write must leave alone: the record file and the git HEAD. */
function snap(root: string, id: string) {
  const f = fileOf(root, id);
  return { file: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null, head: git(root, 'rev-parse', 'HEAD') };
}
async function expectStatus(r: Response, status: number): Promise<any> {
  const text = await r.text();
  assert.equal(r.status, status, text);
  return text ? JSON.parse(text) : null;
}

test('1 append: pass 1, 2 and a narrow 3 -> 201 each; GET returns the 3 rows in order with answers, actor and ts; 3 commits', () => withBoard(async ({ root, id, post, get }) => {
  const before = commits(root);
  const r1 = await expectStatus(await post(passRow(1)), 201);
  assert.equal(r1.card, id);
  assert.equal(r1.row.pass, 1);
  assert.equal(r1.row.actor, ACTOR);
  assert.match(r1.row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/);
  assert.equal('answer' in r1.row, false, 'the 201 row leaves the answer out');
  await expectStatus(await post(passRow(2, { verdict: 'open', open: 2, noted: 1, answer: 'two findings\n' })), 201);
  const { noted: _n, ...three } = passRow(3);
  await expectStatus(await post(three), 201);
  const g = await expectStatus(await get(), 200);
  assert.equal(g.card, id);
  assert.deepEqual(g.passes.map((p: any) => p.pass), [1, 2, 3]);
  assert.equal(g.passes[2].noted, 0, 'noted defaults to 0');
  assert.equal(g.passes[2].mode, 'narrow');
  assert.equal(g.passes[0].answer, passRow(1).answer);
  assert.equal(g.passes[1].answer, 'two findings\n');
  assert.equal(g.passes[1].log_sha256, sha(Buffer.from('two findings\n')));
  for (const p of g.passes) { assert.equal(p.actor, ACTOR); assert.match(p.ts, /([+-]\d{2}:\d{2}|Z)$/); }
  assert.equal(commits(root), before + 3);
  assert.match(git(root, 'log', '-1', '--format=%s'), new RegExp(`^${ACTOR}: review-run ${id.replace('.', '\\.')} pass 3$`));
  const lines = fs.readFileSync(fileOf(root, id), 'utf8').split('\n');
  assert.equal(lines.length, 4); assert.equal(lines[3], '');
  assert.deepEqual(lines.slice(0, 3).map((l) => JSON.parse(l).pass), [1, 2, 3]);
}));

test('2 409 replay: same pass-1 body, pass 1 with another head -> 409 with passes; nothing committed', () => withBoard(async ({ root, id, post }) => {
  await expectStatus(await post(passRow(1)), 201);
  const s = snap(root, id);
  let j = await expectStatus(await post(passRow(1)), 409);
  assert.ok(j.error);
  assert.equal(j.passes.length, 1);
  assert.equal(j.passes[0].pass, 1);
  assert.equal('answer' in j.passes[0], false, 'passes in a 409 leave the answer out');
  j = await expectStatus(await post(passRow(1, { head: HEAD_B })), 409);
  assert.equal(j.passes.length, 1);
  assert.deepEqual(snap(root, id), s);
}));

test('3 pass order: pass 2 without pass 1 -> 409; narrow pass 3 after 1 and 2 -> 201; mode narrow with pass 2 -> 400', () => withBoard(async ({ root, id, post }) => {
  const s = snap(root, id);
  const j = await expectStatus(await post(passRow(2)), 409);
  assert.deepEqual(j.passes, []);
  assert.deepEqual(snap(root, id), s);
  await expectStatus(await post(passRow(2, { mode: 'narrow' })), 400);
  await expectStatus(await post(passRow(3, { mode: 'simple' })), 400);
  await expectStatus(await post(passRow(1)), 201);
  await expectStatus(await post(passRow(3)), 409);
  await expectStatus(await post(passRow(2, { verdict: 'open', open: 1 })), 201);
  const r = await expectStatus(await post(passRow(3, { head: HEAD_B })), 201);
  assert.equal(r.row.mode, 'narrow');
}));

test('4 sha mismatch: log_sha256 that is not the sha256 of answer -> 400; nothing stored', () => withBoard(async ({ root, id, post, get }) => {
  const s = snap(root, id);
  const j = await expectStatus(await post(passRow(1, { log_sha256: sha('something else') })), 400);
  assert.match(j.error, /log_sha256/);
  // upper-case hex of the right hash is not 64 lowercase hex
  await expectStatus(await post(passRow(1, { log_sha256: sha(Buffer.from(passRow(1).answer)).toUpperCase() })), 400);
  assert.deepEqual(snap(root, id), s);
  assert.deepEqual((await expectStatus(await get(), 200)).passes, []);
}));

test('5 shape: unknown field -> 400 naming it; bad values -> 400 each', () => withBoard(async ({ root, id, post }) => {
  const s = snap(root, id);
  const j = await expectStatus(await post({ ...passRow(1), foo: 1 }), 400);
  assert.match(j.error, /\bfoo\b/);
  const bad: Record<string, unknown>[] = [
    { pass: '1' }, { open: -1 }, { open: 1000 }, { tier: 'high' }, { head: 'a'.repeat(39) }, { base: 'ma\nin' },
    { pass: 4 }, { pass: 0 }, { pass: 1.5 }, { noted: 1000 }, { merge_base: 'x'.repeat(40) }, { mode: 'none' }, { tier: 'safe' }, { impl: 'bot' }, { verdict: 'clean', open: 1 },
    { base: '' }, { base: 'x'.repeat(201) }, { reviewer: '' }, { reviewer: 'a\u007fb' }, { at: '' }, { at: 'x'.repeat(41) }, { head: 'A'.repeat(40) },
    { impl: undefined }, { log_sha256: undefined }, { answer: undefined }, { answer: 5 },
  ];
  for (const over of bad) {
    const body: Record<string, unknown> = { ...passRow(1), ...over };
    for (const k of Object.keys(over)) if (over[k] === undefined) delete body[k];
    const r = await post(body);
    assert.equal(r.status, 400, `${JSON.stringify(over)} -> ${r.status} ${await r.text()}`);
  }
  // lone surrogate in the answer (raw JSON so it reaches the server as one)
  const lone = JSON.stringify(passRow(1, { answer: 'x', log_sha256: sha('x') })).replace('"answer":"x"', '"answer":"\\ud800"');
  assert.equal((await post(null, { raw: lone })).status, 400);
  assert.deepEqual(snap(root, id), s);
}));

test('6 sizes: answer of exactly 262,144 UTF-8 bytes -> 201; one byte more -> 413; raw body over 2 MiB -> 413 as a response', () => withBoard(async ({ root, id, post, get }) => {
  const unit = '한'; // 3 bytes
  const answer = unit.repeat(Math.floor(CAP / 3)) + 'x'.repeat(CAP % 3);
  assert.equal(Buffer.byteLength(answer, 'utf8'), CAP);
  // Every character \u-escaped: far over the default 64 KiB body limit (~1.5 MiB for an all-ASCII answer at the cap).
  const escaped = (b: Record<string, unknown>) => {
    let esc = ''; const a = String(b.answer);
    for (let i = 0; i < a.length; i++) esc += '\\u' + a.charCodeAt(i).toString(16).padStart(4, '0');
    return JSON.stringify({ ...b, answer: '@@' }).replace('"@@"', `"${esc}"`);
  };
  const raw = escaped(passRow(1, { answer }));
  assert.ok(raw.length > 65_536 && raw.length < 2_097_152);
  await expectStatus(await post(null, { raw }), 201);
  const ascii = 'y'.repeat(CAP);
  const rawAscii = escaped(passRow(2, { answer: ascii }));
  assert.ok(rawAscii.length > 1_500_000 && rawAscii.length < 2_097_152);
  await expectStatus(await post(null, { raw: rawAscii }), 201);
  const g = await expectStatus(await get(), 200);
  assert.equal(g.passes[0].answer, answer);
  assert.equal(g.passes[1].answer, ascii);
  const s = snap(root, id);
  const over = answer + 'x';
  const j = await expectStatus(await post(passRow(3, { answer: over })), 413);
  assert.match(j.error, /262,?144|bytes/);
  const big = JSON.stringify({ ...passRow(3), answer: 'x'.repeat(2_097_152) });
  await expectStatus(await post(null, { raw: big }), 413);
  assert.deepEqual(snap(root, id), s);
}));

test('7 unknown task -> 404 on POST and GET; a task with no rows -> GET 200 {card, passes: []}; bad id -> 400', () => withBoard(async ({ id, post, get }) => {
  await expectStatus(await post(passRow(1), { id: 'shared.t-nonex' }), 404);
  await expectStatus(await get('shared.t-nonex'), 404);
  assert.deepEqual(await expectStatus(await get(), 200), { card: id, passes: [] });
  await expectStatus(await get('not-a-task'), 400);
  await expectStatus(await post(passRow(1), { id: 'not-a-task' }), 400);
}));

test('8 race: two concurrent pass-1 POSTs -> one 201, one 409; GET shows one pass-1 row', () => withBoard(async ({ root, post, get }) => {
  const before = commits(root);
  const [a, b] = await Promise.all([post(passRow(1)), post(passRow(1, { head: HEAD_B }))]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const g = await expectStatus(await get(), 200);
  assert.equal(g.passes.filter((p: any) => p.pass === 1).length, 1);
  assert.equal(commits(root), before + 1);
}));

test('9 restart keeps rows; a torn last line is skipped and dropped by the next append; a bad earlier line is a 500', () => withBoard(async ({ root, id, post, get, restart }) => {
  await expectStatus(await post(passRow(1)), 201);
  const before = await expectStatus(await get(), 200);
  await restart();
  assert.deepEqual(await expectStatus(await get(), 200), before);
  const f = fileOf(root, id);
  const good = fs.readFileSync(f, 'utf8');
  fs.appendFileSync(f, '{"pass":2,"torn":"x');
  assert.deepEqual(await expectStatus(await get(), 200), before, 'GET skips the torn last line');
  await expectStatus(await post(passRow(2, { head: HEAD_B })), 201);
  const after = fs.readFileSync(f, 'utf8');
  assert.ok(after.startsWith(good), 'the good lines are kept byte for byte');
  assert.equal(after.includes('"torn"'), false, 'the torn line is gone');
  for (const l of after.split('\n').filter(Boolean)) JSON.parse(l);
  assert.equal(after.split('\n').length, 3);
  await expectStatus(await post(passRow(3)), 201);
  await restart();
  const g = await expectStatus(await get(), 200);
  assert.deepEqual(g.passes.map((p: any) => [p.pass, p.head]), [[1, HEAD_A], [2, HEAD_B], [3, HEAD_A]]);
  // A bad line before the last one: GET and POST answer 500 naming its line, nothing stored.
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines[1] = '[1]';
  fs.writeFileSync(f, lines.join('\n'));
  const headBefore = git(root, 'rev-parse', 'HEAD');
  assert.match((await expectStatus(await get(), 500)).error, /line 2/);
  assert.match((await expectStatus(await post(passRow(1)), 500)).error, /line 2/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), headBefore);
}));

test('10 write rules: no X-Dasks-Actor -> 400; PUT and DELETE -> 405', () => withBoard(async ({ root, id, url, post }) => {
  const s = snap(root, id);
  await expectStatus(await post(passRow(1), { actor: null }), 400);
  const put = await fetch(`${url}/api/tasks/${id}/review-runs`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': ACTOR }, body: JSON.stringify(passRow(1)) });
  await expectStatus(put, 405);
  const del = await fetch(`${url}/api/tasks/${id}/review-runs`, { method: 'DELETE', headers: { 'X-Dasks-Actor': ACTOR } });
  await expectStatus(del, 405);
  assert.deepEqual(snap(root, id), s);
}));
