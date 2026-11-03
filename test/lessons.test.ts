// Lessons for the next card on a project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { addLesson, checkLessons, readLessons, relevantLessons, taskFiles, updateLesson, looksSecret, lessonsArchiveRelPath, lessonsRelPath, DEFAULT_RELEVANT, MAX_LESSONS, MAX_LESSONS_BYTES, MAX_TEXT, type Lesson, type LessonStatus } from '../src/lib/lessons.ts';
import { git, HttpError, createTask, isoLocal } from '../src/lib/write.ts';
import { loadBoard } from '../src/lib/load.ts';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const GB = path.join(ROOT, 'mcp/board-cli.mjs');
const MCP = path.join(ROOT, 'mcp/dasks-mcp.mjs');
const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return e instanceof HttpError ? e.status : -1; } };

test('lessons: add as proposal, dedupe, edit, retire; only the user confirms; one commit each', () => {
  const { root, cleanup } = tempRepo();
  try {
    assert.deepEqual(readLessons(root, 'beta'), { app: 'beta', version: 0, updated: '', updated_by: '', lessons: [] });
    const a = addLesson(root, 'beta', { text: '  Review finds stale state\n after a restart. ', files: ['src/server.ts', './public/app.js'], task: 'beta.t-login' }, 'codex@desktop');
    assert.equal(a.id, 'beta.l-review-finds-stale-state-after-a-restart');
    assert.equal(a.text, 'Review finds stale state after a restart.');
    assert.deepEqual(a.files, ['src/server.ts', 'public/app.js']);
    assert.equal(a.status, 'proposed'); assert.equal(a.added_by, 'codex@desktop'); assert.equal(a.task, 'beta.t-login');
    assert.match(git(root, ['log', '-1', '--format=%s']), /^codex@desktop: lesson beta\.l-review-finds-stale-state-after-a-restart add \(from beta\.t-login\)/);
    const commits = () => Number(git(root, ['rev-list', '--count', 'HEAD']).trim());
    const n = commits();
    // same text (any case) = the existing lesson, no new commit
    assert.equal(addLesson(root, 'beta', { text: 'review finds stale state after a restart.' }, 'helper').id, a.id);
    assert.equal(commits(), n);
    // agents cannot confirm; the user can
    assert.equal(status(() => updateLesson(root, 'beta', a.id, { status: 'confirmed' }, 'codex@desktop')), 403);
    const c = updateLesson(root, 'beta', a.id, { status: 'confirmed' }, 'user', { expectedVersion: 1 });
    assert.equal(c.status, 'confirmed'); assert.equal(c.version, 2);
    assert.equal(status(() => updateLesson(root, 'beta', a.id, { text: 'x' }, 'helper', { expectedVersion: 1 })), 409);
    // an agent rewording a confirmed lesson makes it a proposal again
    const e = updateLesson(root, 'beta', a.id, { text: 'Review finds stale state after a server restart.' }, 'helper');
    assert.equal(e.status, 'proposed'); assert.equal(e.updated_by, 'helper');
    // the user's own lesson starts confirmed; retire works for anyone; unchanged edit is a no-op
    const u = addLesson(root, 'beta', { text: 'Keep the 390px layout in every screenshot set.' }, 'user');
    assert.equal(u.status, 'confirmed');
    assert.equal(updateLesson(root, 'beta', u.id, { status: 'retired' }, 'helper').status, 'retired');
    const before = commits();
    assert.equal(updateLesson(root, 'beta', u.id, { status: 'retired' }, 'helper').version, 2);
    assert.equal(commits(), before);
    assert.equal(status(() => addLesson(root, 'beta', { text: '' }, 'helper')), 400);
    assert.equal(status(() => addLesson(root, 'beta', { text: 'x'.repeat(MAX_TEXT + 1) }, 'helper')), 400);
    assert.equal(status(() => addLesson(root, 'beta', { text: 'ok', files: ['../etc/passwd'] }, 'helper')), 400);
    assert.equal(status(() => addLesson(root, 'beta', { text: 'ok', files: ['/abs/path'] }, 'helper')), 400);
    assert.equal(status(() => addLesson(root, 'beta', { text: 'ok', task: 'alpha.t-other' }, 'helper')), 400, 'task must be on the same project');
    assert.equal(status(() => addLesson(root, 'beta', { text: 'ok', note: 'x' }, 'helper')), 400);
    assert.equal(status(() => addLesson(root, 'nope', { text: 'ok' }, 'helper')), 404);
    assert.equal(status(() => updateLesson(root, 'beta', 'beta.l-missing', { status: 'retired' }, 'helper')), 404);
    assert.equal(checkLessons(root, loadBoard(root)).length, 0);
  } finally { cleanup(); }
});

test('lessons: never store something that looks like a credential', () => {
  // Fake values, assembled at run time so the push secret scanner does not see a key-shaped literal.
  const dashes = '-'.repeat(5);
  for (const s of ['use key ' + 'sk-' + 'ant-abc123def456ghi789', 'token: ' + 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123', 'pass' + 'word = hunter2hunter2', `${'AK' + 'IA'}ABCDEFGHIJKLMNOP is the key`, `${dashes}BEGIN OPENSSH PRIVATE KEY${dashes}`])
    assert.ok(looksSecret(s), s);
  for (const s of ['Run the token count after each batch.', 'The passphrase lives in the root-owned hash file.', 'Use sk- prefixes in docs only as placeholders.'])
    assert.ok(!looksSecret(s), s);
  const { root, cleanup } = tempRepo();
  try {
    assert.equal(status(() => addLesson(root, 'beta', { text: 'login with pass' + 'word: s3cretpass' }, 'helper')), 400);
    // a key in files is refused too, not only in text
    assert.equal(status(() => addLesson(root, 'beta', { text: 'Use this path.', files: ['sk-proj-' + 'A'.repeat(30)] }, 'helper')), 400);
    const ok = addLesson(root, 'beta', { text: 'Fine.' }, 'helper');
    assert.equal(status(() => updateLesson(root, 'beta', ok.id, { files: ['ghp_' + 'a'.repeat(30)] }, 'helper')), 400);
  } finally { cleanup(); }
});

test('lessons: a non-string status is refused and the file stays readable', () => {
  const { root, cleanup } = tempRepo();
  try {
    const a = addLesson(root, 'shared', { text: 'Use the repo lock.' }, 'helper');
    const head = git(root, ['rev-parse', 'HEAD']);
    assert.equal(status(() => updateLesson(root, 'shared', a.id, { status: ['confirmed'] }, 'helper')), 400);
    assert.equal(status(() => updateLesson(root, 'shared', a.id, { status: ['confirmed'] }, 'user')), 400);
    assert.equal(git(root, ['rev-parse', 'HEAD']), head, 'nothing committed');
    assert.equal(readLessons(root, 'shared').lessons[0].status, 'proposed');
  } finally { cleanup(); }
});

test('lessons: relevance = closest files, then confirmed, then newest; retired never comes back', () => {
  const { root, cleanup } = tempRepo();
  try {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 18, 0, m));
    addLesson(root, 'beta', { text: 'Old general lesson.' }, 'helper', { now: at(1) });
    addLesson(root, 'beta', { text: 'Same dir lesson.', files: ['src/lib/other.ts'] }, 'helper', { now: at(2) });
    addLesson(root, 'beta', { text: 'Exact file lesson.', files: ['src/lib/write.ts'] }, 'helper', { now: at(3) });
    addLesson(root, 'beta', { text: 'Whole dir lesson.', files: ['public/'] }, 'helper', { now: at(4) });
    const conf = addLesson(root, 'beta', { text: 'Confirmed general lesson.' }, 'user', { now: at(5) });
    const gone = addLesson(root, 'beta', { text: 'Retired exact lesson.', files: ['src/lib/write.ts'] }, 'helper', { now: at(6) });
    updateLesson(root, 'beta', gone.id, { status: 'retired' }, 'helper');
    const f = readLessons(root, 'beta');
    assert.deepEqual(relevantLessons(f, ['src/lib/write.ts', 'public/app.js'], 10).map((l) => l.text),
      ['Whole dir lesson.', 'Exact file lesson.', 'Same dir lesson.', 'Confirmed general lesson.', 'Old general lesson.']);
    assert.deepEqual(relevantLessons(f, [], 2).map((l) => l.id), [conf.id, 'beta.l-whole-dir-lesson']);
    assert.equal(relevantLessons(f, [], 0).length, 0);
  } finally { cleanup(); }
});

test('taskFiles reads the Handoff files: line (comma list or bullets) and drops unsafe paths', () => {
  assert.deepEqual(taskFiles('requirements: x\nfiles: src/a.ts, `public/app.js`, ../up.ts, /abs.ts\nacceptance: y'), ['src/a.ts', 'public/app.js']);
  assert.deepEqual(taskFiles('- files:\n  - src/lib/lessons.ts\n  - test/lessons.test.ts\n- tests: npm test'), ['src/lib/lessons.ts', 'test/lessons.test.ts']);
  assert.deepEqual(taskFiles('no files here'), []);
});


test('lessons: a hand-broken file is a check warning and a 409 for readers', () => {
  const { root, cleanup } = tempRepo();
  try {
    fs.mkdirSync(path.join(root, 'data/lessons'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/lessons/beta.json'), '{oops');
    fs.writeFileSync(path.join(root, 'data/lessons/stray.json'), '{"lessons":[]}');
    const w = checkLessons(root, loadBoard(root));
    assert.ok(w.some((x) => x.file === 'data/lessons/beta.json' && /parse error/.test(x.message)));
    assert.ok(w.some((x) => x.file === 'data/lessons/stray.json'));
    assert.equal(status(() => readLessons(root, 'beta')), 409);
  } finally { cleanup(); }
});

// ---------- live: HTTP, task reads, MCP, CLI ----------
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
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
function cli(url: string, actor: string, args: string[]) {
  try { return { code: 0, out: execFileSync(process.execPath, [GB, ...args], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor, DASKS_PROG: 'dasks' }, encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (e: any) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
}
function mcp(url: string, actor: string) {
  const proc = spawn(process.execPath, [MCP], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, stdio: ['pipe', 'pipe', 'inherit'] });
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

test('live: lessons over HTTP, carried by task reads, MCP tools and CLI', async () => {
  const { root, cleanup } = tempRepo();
  const t = createTask(root, { goal: 'shared', title: 'Next card', body: '\n## Context\nx\n\n## Handoff\nfiles: src/lib/write.ts\n' }, 'helper');
  const { url, proc } = await startServer(root);
  const m = mcp(url, 'claude-code@desktop');
  const post = (p: string, body: any, actor = 'codex@desktop') => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });
  try {
    let r = await post('/api/lessons/shared', { text: 'commitFiles needs the repo lock held.', files: ['src/lib/write.ts'] });
    assert.equal(r.status, 201); const a = await r.json(); assert.equal(a.status, 'proposed'); assert.equal(a.added_by, 'codex@desktop');
    assert.equal((await post('/api/lessons/shared', { text: 'x', expected_version: 1 })).status, 400);
    assert.equal((await post('/api/lessons/shared', { text: `${'api' + '_key'}: ${'abcdef' + '123456'}` })).status, 400);
    assert.equal((await post(`/api/lessons/shared/${a.id}`, { status: 'confirmed' })).status, 403);
    await post('/api/lessons/shared', { text: 'Unrelated general lesson.' });
    // the next card's read carries the lesson on its Handoff file first
    const task = await (await fetch(`${url}/api/tasks/${t.id}`)).json();
    assert.deepEqual(task.lessons.map((l: any) => l.id), [a.id, 'shared.l-unrelated-general-lesson']);
    assert.equal((await (await fetch(url + '/api/lessons/shared?status=proposed')).json()).lessons.length, 2);
    assert.equal((await (await fetch(url + '/api/lessons/shared?limit=1&files=src/lib/write.ts')).json()).lessons[0].id, a.id);
    assert.equal((await fetch(url + '/api/lessons/shared?status=nope')).status, 400);
    assert.equal((await fetch(url + '/api/lessons/shared?limit=0')).status, 400);
    // a task with 11+ Handoff files gets the same lessons over the lessons endpoint as its task read
    const many = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`).concat('src/lib/write.ts').join(',');
    r = await fetch(`${url}/api/lessons/shared?limit=5&files=${encodeURIComponent(many)}`);
    assert.equal(r.status, 200); assert.equal((await r.json()).lessons[0].id, a.id);
    assert.equal((await (await fetch(url + '/api/lessons')).json()).find((x: any) => x.app === 'shared').proposed, 2);
    await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const names = (await m.rpc('tools/list')).result.tools.map((x: any) => x.name);
    for (const n of ['list_lessons', 'add_lesson', 'update_lesson', 'get_task', 'add_idea']) assert.ok(names.includes(n), n);
    const added = await m.call('add_lesson', { app: 'shared', text: 'Screenshots need both 390 and 1440.', task: t.id });
    assert.ok(!added.err, added.text); assert.equal(added.json.added_by, 'claude-code@desktop'); assert.equal(added.json.task, t.id);
    assert.ok((await m.call('update_lesson', { id: added.json.id, status: 'confirmed' })).err, 'MCP has no confirm');
    assert.equal((await m.call('update_lesson', { id: added.json.id, status: 'retired', expected_version: 1 })).json.status, 'retired');
    assert.equal((await m.call('list_lessons', { app: 'shared', files: ['src/lib/write.ts'], limit: 1 })).json.lessons[0].id, a.id);
    assert.ok((await m.call('get_task', { id: t.id })).json.lessons.length >= 1);
    let c = cli(url, 'cli@laptop', ['lesson', 'add', 'shared', 'Run dasks check before every commit.', '--files', 'bin/dasks-check']);
    assert.equal(c.code, 0, c.out); assert.match(c.out, /^proposed\s+shared\.l-run-dasks-check/m);
    c = cli(url, 'cli@laptop', ['lessons', 'shared', '--status', 'proposed']);
    assert.equal(c.code, 0, c.out); assert.match(c.out, /by cli@laptop · bin\/dasks/);
    c = cli(url, 'cli@laptop', ['show', t.id]);
    assert.match(c.out, /Lessons from earlier cards:\n {2}\? commitFiles needs the repo lock held\. \(src\/lib\/write\.ts\)/);
    assert.equal(cli(url, 'cli@laptop', ['lessons', 'shared', '--status', 'nope']).code, 2);
  } finally { m.proc.kill(); proc.kill(); cleanup(); }
});

// ---------- lessons full: a project's file at a cap ----------
const fullAt = (i: number) => isoLocal(new Date(Date.UTC(2026, 8, 1, 0, 0, i)));
const sized = (tag: string, n: number) => `${tag} ` + 'x'.repeat(n - tag.length - 1);
const fileBytes = (lessons: Lesson[], app = 'shared') => Buffer.byteLength(JSON.stringify({ app, version: 1, updated: fullAt(0), updated_by: 'codex@desktop', lessons }, null, 2) + '\n');
type RowPick = (i: number) => { status?: LessonStatus; len?: number };
/** Writes and commits data/lessons/<app>.json: rows valid under lessonErrors() with rising added_at. With `count`, that
 *  many rows of short text; otherwise rows of long text until no 21-character row fits with 50 B to spare, which leaves
 *  under 400 B under MAX_LESSONS_BYTES. `lastFiles` links the newest row to those files. */
function writeFull(root: string, { app = 'shared', count, pick = () => ({}), lastFiles }: { app?: string; count?: number; pick?: RowPick; lastFiles?: string[] } = {}): Lesson[] {
  const row = (i: number, n: number, files: string[] = []): Lesson => {
    const at = fullAt(i + 1);
    const text = count !== undefined ? `Short row ${String(i).padStart(4, '0')} ok.` : sized(`Filler ${i}`, n);
    return { id: `${app}.l-full-${String(i).padStart(4, '0')}`, text, files, task: '', added_by: 'codex@desktop', added_at: at, status: pick(i).status ?? 'proposed', version: 1, updated: at, updated_by: 'codex@desktop' };
  };
  const fits = (rs: Lesson[]) => MAX_LESSONS_BYTES - fileBytes(rs, app) >= 50;
  const rows: Lesson[] = [];
  if (count !== undefined) for (let i = 0; i < count; i++) rows.push(row(i, 0));
  else for (let i = 0; fits([...rows, row(i, 21)]); i++) {
    let n = pick(i).len ?? MAX_TEXT - 20;
    while (n > 21 && !fits([...rows, row(i, n)])) n--;
    rows.push(row(i, n));
  }
  if (lastFiles) {
    const i = rows.length - 1;
    let n = rows[i].text.length;
    do rows[i] = row(i, n--, lastFiles); while (n > 21 && !fits(rows));
  }
  assert.ok(fileBytes(rows, app) <= MAX_LESSONS_BYTES && rows.length <= MAX_LESSONS);
  fs.mkdirSync(path.join(root, 'data/lessons'), { recursive: true });
  fs.writeFileSync(path.join(root, lessonsRelPath(app)), JSON.stringify({ app, version: 1, updated: fullAt(0), updated_by: 'codex@desktop', lessons: rows }, null, 2) + '\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', `fill ${app} lessons`]);
  return rows;
}
const archiveLines = (root: string, app = 'shared'): any[] => {
  try { return fs.readFileSync(path.join(root, lessonsArchiveRelPath(app)), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const postLesson = (url: string, app: string, body: any, actor = 'codex@desktop') => fetch(`${url}/api/lessons/${app}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });

test('lessons full: a new lesson at the byte cap is saved over HTTP', async () => {
  const { root, cleanup } = tempRepo();
  const rows = writeFull(root);
  const rel = lessonsRelPath('shared');
  const room = MAX_LESSONS_BYTES - fs.statSync(path.join(root, rel)).size;
  assert.ok(room >= 0 && room < 400, `room ${room}`);
  assert.ok(rows.every((l) => l.status === 'proposed'));
  const { url, proc } = await startServer(root);
  try {
    const text = sized('New lesson at the cap', 300);
    const r = await postLesson(url, 'shared', { text });
    const body = await r.text();
    assert.equal(r.status, 201, body);
    const added = JSON.parse(body);
    assert.ok(fs.statSync(path.join(root, rel)).size <= MAX_LESSONS_BYTES);
    const ids = readLessons(root, 'shared').lessons.map((l) => l.id);
    assert.ok(ids.includes(added.id));
    assert.ok(!ids.includes(rows[0].id), 'the oldest proposed lesson left the file');
    const line = archiveLines(root).find((l) => l.id === rows[0].id);
    assert.ok(line, 'the oldest proposed lesson is in the archive');
    assert.equal(line.status, 'retired'); assert.equal(line.archived_reason, 'overflow'); assert.equal(line.text, rows[0].text);
    const changed = git(root, ['log', '-1', '--name-only', '--format=']).trim().split('\n');
    assert.ok(changed.includes(rel) && changed.includes(lessonsArchiveRelPath('shared')), changed.join(','));
    assert.ok(git(root, ['log', '-1', '--format=%B']).includes(rows[0].id));
  } finally { proc.kill(); cleanup(); }
});

test('lessons full: the count cap makes room too', () => {
  const { root, cleanup } = tempRepo();
  try {
    const rows = writeFull(root, { count: MAX_LESSONS });
    assert.ok(fileBytes(rows) < MAX_LESSONS_BYTES - 10_000, 'well under the byte cap');
    const a = addLesson(root, 'shared', { text: 'One more short lesson.' }, 'codex@desktop');
    const f = readLessons(root, 'shared');
    assert.equal(f.lessons.length, MAX_LESSONS);
    assert.ok(f.lessons.some((l) => l.id === a.id));
    assert.deepEqual(archiveLines(root).map((l) => l.id), [rows[0].id]);
  } finally { cleanup(); }
});

test('lessons full: confirmed lessons never go', () => {
  let { root, cleanup } = tempRepo();
  try {
    const rows = writeFull(root, { pick: (i) => ({ status: i < 3 ? 'confirmed' : 'proposed' }) });
    addLesson(root, 'shared', { text: sized('After three confirmed', 300) }, 'codex@desktop');
    const ids = readLessons(root, 'shared').lessons.map((l) => l.id);
    for (const l of rows.slice(0, 3)) assert.ok(ids.includes(l.id), l.id);
    const archived = archiveLines(root);
    assert.ok(archived.some((l) => l.id === rows[3].id), 'the oldest proposed row went');
    assert.ok(!archived.some((l) => rows.slice(0, 3).some((c) => c.id === l.id)));
  } finally { cleanup(); }
  ({ root, cleanup } = tempRepo());
  try {
    writeFull(root, { pick: () => ({ status: 'confirmed' }) });
    const abs = path.join(root, lessonsRelPath('shared'));
    const bytes = fs.readFileSync(abs);
    const head = git(root, ['rev-parse', 'HEAD']);
    let err: unknown;
    try { addLesson(root, 'shared', { text: sized('No room left', 300) }, 'codex@desktop'); } catch (e) { err = e; }
    assert.ok(err instanceof HttpError && err.status === 413, String(err));
    assert.match((err as Error).message, /confirmed/);
    assert.ok(fs.readFileSync(abs).equals(bytes), 'file unchanged');
    assert.equal(git(root, ['rev-parse', 'HEAD']), head, 'nothing committed');
    assert.ok(!fs.existsSync(path.join(root, lessonsArchiveRelPath('shared'))), 'no archive file');
  } finally { cleanup(); }
});

test('lessons full: edits and retired rows', () => {
  let { root, cleanup } = tempRepo();
  try {
    const rows = writeFull(root, { pick: (i) => ({ status: i === 5 ? 'retired' : 'proposed' }) });
    addLesson(root, 'shared', { text: sized('Fits once the retired row is gone', 300) }, 'codex@desktop');
    const archived = archiveLines(root);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].id, rows[5].id);
    assert.ok(!('archived_reason' in archived[0]));
    assert.deepEqual(archived[0], rows[5], 'a retired row is archived as stored');
    const ids = readLessons(root, 'shared').lessons.map((l) => l.id);
    for (const l of rows.filter((x) => x.status === 'proposed')) assert.ok(ids.includes(l.id), l.id);
  } finally { cleanup(); }
  ({ root, cleanup } = tempRepo());
  try {
    const rows = writeFull(root, { pick: (i) => ({ len: i === 0 ? 21 : undefined }) });
    const room = MAX_LESSONS_BYTES - fileBytes(rows);
    assert.ok(room < MAX_TEXT - rows[0].text.length, `room ${room} is less than the edit adds`);
    const text = sized('Grown oldest lesson', MAX_TEXT);
    const e = updateLesson(root, 'shared', rows[0].id, { text }, 'codex@desktop');
    assert.equal(e.text, text);
    const live = readLessons(root, 'shared').lessons;
    assert.equal(live.find((l) => l.id === rows[0].id)?.text, text, 'the edit is saved and the row kept');
    assert.ok(!live.some((l) => l.id === rows[1].id));
    const line = archiveLines(root).find((l) => l.id === rows[1].id);
    assert.ok(line); assert.equal(line.archived_reason, 'overflow');
    assert.ok(git(root, ['log', '-1', '--format=%B']).includes(`archived (over cap): ${rows[1].id}`));
  } finally { cleanup(); }
});

test('lessons full: a removed lesson comes back', async () => {
  const { root, cleanup } = tempRepo();
  const rows = writeFull(root);
  const { url, proc } = await startServer(root);
  try {
    assert.equal((await postLesson(url, 'shared', { text: sized('Pushes the oldest out', 300) })).status, 201);
    assert.ok(archiveLines(root).some((l) => l.id === rows[0].id));
    const r = await postLesson(url, 'shared', { text: rows[0].text });
    const back = await r.json();
    assert.equal(r.status, 201, JSON.stringify(back));
    assert.notEqual(back.id, rows[0].id);
    assert.equal(back.text, rows[0].text);
    assert.equal(back.status, 'proposed');
    assert.equal(archiveLines(root).filter((l) => l.id === rows[0].id).length, 1);
    assert.ok(readLessons(root, 'shared').lessons.some((l) => l.id === back.id));
  } finally { proc.kill(); cleanup(); }
});

test('lessons full: task reads stay at 5', async () => {
  const { root, cleanup } = tempRepo();
  const t = createTask(root, { goal: 'shared', title: 'Next card', body: '\n## Context\nx\n\n## Handoff\nfiles: src/lib/write.ts\n' }, 'helper');
  const rows = writeFull(root, { lastFiles: ['src/lib/write.ts'] });
  const linked = rows[rows.length - 1];
  const { url, proc } = await startServer(root);
  try {
    const r = await postLesson(url, 'shared', { text: sized('Saved through the overflow', 300) });
    assert.equal(r.status, 201);
    const added = await r.json();
    const archived = new Set(archiveLines(root).map((l) => l.id));
    assert.ok(archived.size >= 1);
    const task = await (await fetch(`${url}/api/tasks/${t.id}`)).json();
    assert.equal(task.lessons.length, DEFAULT_RELEVANT);
    assert.equal(task.lessons[0].id, linked.id);
    assert.ok(!task.lessons.some((l: any) => archived.has(l.id)));
    assert.ok(task.lessons.some((l: any) => l.id === added.id));
  } finally { proc.kill(); cleanup(); }
});
