// Goals from data files, per-project structure, ideas for later and per-language titles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import YAML from 'yaml';
import { check } from '../src/lib/check.ts';
import { loadBoard } from '../src/lib/load.ts';
import { rollup } from '../src/lib/rollup.ts';
import { commitFiles, createTask, git, gitCommonDir, HttpError, journalPath, readTask, recoverJournal, recoverRepo, updateNode, updateTask, withRepoLock } from '../src/lib/write.ts';
import { defaultStructure, projectIds, readView, writeView } from '../src/lib/views.ts';
import { addIdea, checkIdeas, promoteIdea, readIdeas, updateIdea } from '../src/lib/ideas.ts';
import { readActivity } from '../src/lib/collab.ts';
import { tempRepo } from './helpers.ts';
import { setProjects } from '../src/lib/schema.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const GB = path.join(ROOT, 'mcp/board-cli.mjs');
const MCP = path.join(ROOT, 'mcp/dasks-mcp.mjs');
const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return e instanceof HttpError ? e.status : -1; } };

/** A temp board plus an extra goal "ops" (parent north) with one milestone. */
function withOps() {
  const r = tempRepo();
  fs.writeFileSync(path.join(r.root, 'data/goals/ops.yaml'), YAML.stringify({ id: 'ops', parent: 'north', title: 'ops — 서버 이전', why: 'w', owner: 'user',
    milestones: [{ id: 'ops.m0-backups', title: '0단계 백업', done_criteria: [], due: '', status: 'active' }] }));
  git(r.root, ['add', '-A']); git(r.root, ['commit', '-qm', 'ops']);
  return r;
}

// ---------- goals ----------
test('goals: any goal file under the north star is a goal; configured projects stay required; unknown goal rejected', () => {
  const { root, cleanup } = withOps();
  setProjects(['alpha', 'beta', 'gamma', 'delta', 'shared'].map((id) => ({ id }))); // what config.json `projects` does
  try {
    const b = loadBoard(root);
    assert.deepEqual(projectIds(b), ['alpha', 'beta', 'gamma', 'delta', 'shared', 'ops'], 'apps first, then the others');
    assert.equal(check(b).errors.length, 0, JSON.stringify(check(b).errors));
    // a new goal id round-trips: create, list, roll-up
    const t = createTask(root, { goal: 'ops', title: 'Repos', title_ko: '저장소', title_en: 'Repos' }, 'claude-code@laptop');
    assert.equal(t.id, 'ops.t-repos'); assert.equal(t.milestone, 'ops.m0-backups');
    updateTask(root, t.id, { status: 'done', result: 'RESULT.md' }, 'sync');
    const b2 = loadBoard(root);
    assert.ok(b2.tasks.some((x) => x.id === t.id && x.goal === 'ops'));
    assert.equal(rollup(b2).goals.find((g) => g.id === 'ops')!.pct, 100);
    assert.equal(check(b2).errors.length, 0);
    // unknown goal still rejected; a goal file with another parent is not a goal
    assert.equal(status(() => createTask(root, { goal: 'nope', title: 'x' }, 'helper')), 400);
    fs.writeFileSync(path.join(root, 'data/goals/stray.yaml'), YAML.stringify({ id: 'stray', parent: 'elsewhere', title: 'S', why: '', owner: 'u', milestones: [] }));
    assert.equal(status(() => createTask(root, { goal: 'stray', title: 'x' }, 'helper')), 400);
    assert.ok(check(loadBoard(root)).errors.some((e) => /parent must be "north"/.test(e.message)));
    fs.rmSync(path.join(root, 'data/goals/stray.yaml'));
    // a required app goal missing is still an error
    fs.rmSync(path.join(root, 'data/goals/shared.yaml'));
    assert.ok(check(loadBoard(root)).errors.some((e) => /exactly one goal for app "shared"/.test(e.message)));
  } finally { setProjects([]); cleanup(); }
});

// ---------- per-language titles ----------
test('i18n fields: tasks and nodes take title_ko/title_en, versioned with the actor; translation-only edits keep `updated`', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Ship it', title_ko: '출시', title_en: 'Ship it' }, 'claude-code@desktop', new Date('2026-10-11T10:00:00+09:00'));
    assert.equal(t.title_ko, '출시'); assert.equal(t.version, '1');
    const u = updateTask(root, t.id, { title_ko: '앱 출시' }, 'dasks-i18n', { expectedVersion: 1, now: new Date('2026-10-12T10:00:00+09:00') });
    assert.equal(u.version, '2'); assert.equal(u.title, 'Ship it', 'original title untouched'); assert.equal(u.title_ko, '앱 출시');
    assert.equal(u.updated, t.updated, 'a translation is not progress: updated stays');
    const act = readActivity(root, t.id).at(-1)!;
    assert.equal(act.actor, 'dasks-i18n'); assert.equal(act.action, 'i18n');
    assert.match(git(root, ['log', '-1', '--format=%s']), /^dasks-i18n: beta\.t-ship-it edit title_ko/);
    // a real edit moves `updated`
    assert.notEqual(updateTask(root, t.id, { title_en: 'Ship the app', priority: 'p1' }, 'helper').updated, t.updated);
    assert.equal(status(() => updateTask(root, t.id, { title_en: 'x'.repeat(201) }, 'helper')), 400);
    assert.equal(status(() => updateTask(root, t.id, { title_ko: 5 as any }, 'helper')), 400);
    assert.equal(status(() => updateTask(root, t.id, { title_ko: 'y' }, 'helper', { expectedVersion: 1 })), 409);
    // nodes: goal and milestone titles per language; empty removes; same value = no commit
    updateNode(root, 'beta', { title_en: 'Beta: ship it' }, 'dasks-i18n');
    updateNode(root, 'beta.m1', { title_ko: '1단계' }, 'dasks-i18n');
    const g = loadBoard(root).goals.find((x) => x.id === 'beta')!;
    assert.equal(g.title_en, 'Beta: ship it'); assert.equal(g.title, 'beta'); assert.equal(g.milestones[0].title_ko, '1단계');
    const head = git(root, ['rev-parse', 'HEAD']);
    updateNode(root, 'beta', { title_en: 'Beta: ship it' }, 'dasks-i18n');
    assert.equal(git(root, ['rev-parse', 'HEAD']), head, 'no empty commit');
    updateNode(root, 'beta', { title_en: '' }, 'dasks-i18n');
    assert.equal(loadBoard(root).goals.find((x) => x.id === 'beta')!.title_en, undefined);
    assert.equal(check(loadBoard(root)).errors.length, 0);
  } finally { cleanup(); }
});

// ---------- structure ----------
test('structure: a default per project, change it alone (versioned), a full view without it keeps it', () => {
  const { root, cleanup } = withOps();
  try {
    assert.deepEqual(['beta', 'gamma', 'alpha', 'delta', 'shared', 'ops'].map((a) => readView(root, a).structure), ['kanban', 'kanban', 'kanban', 'kanban', 'kanban', 'kanban']);
    assert.equal(defaultStructure('notes'), 'kanban');
    assert.ok(readView(root, 'ops').widgets.some((w) => w.type === 'work') && readView(root, 'ops').widgets.some((w) => w.type === 'ideas'));
    const v1 = writeView(root, 'beta', { structure: 'threads' }, 'codex@desktop', { structureOnly: true, expectedVersion: 0 });
    assert.equal(v1.structure, 'threads'); assert.equal(v1.version, 1); assert.equal(v1.updated_by, 'codex@desktop');
    assert.ok(v1.widgets.some((w) => w.type === 'stats' && (w.items as string[]).includes('stage')), 'the rest of the (default) view is kept');
    assert.equal(status(() => writeView(root, 'beta', { structure: 'list' }, 'helper', { structureOnly: true, expectedVersion: 0 })), 409);
    assert.equal(status(() => writeView(root, 'beta', { structure: 'gantt' }, 'helper', { structureOnly: true })), 400);
    const v2 = writeView(root, 'beta', { widgets: [{ type: 'stats' }] }, 'helper');
    assert.equal(v2.structure, 'threads', 'no structure in the body: kept'); assert.equal(v2.version, 2);
    assert.equal(writeView(root, 'beta', { widgets: [{ type: 'stats' }], structure: 'tree' }, 'helper').structure, 'tree');
    assert.equal(writeView(root, 'beta', { structure: 'tree' }, 'helper', { structureOnly: true }).version, 3, 'same structure: no new version');
    assert.equal(status(() => writeView(root, 'nope', { structure: 'list' }, 'helper', { structureOnly: true })), 404);
    // a stored view without a structure reads with the project default
    fs.writeFileSync(path.join(root, 'data/views/delta.json'), JSON.stringify({ app: 'delta', version: 4, widgets: [{ type: 'timeline' }] }));
    assert.equal(readView(root, 'delta').structure, 'kanban');
  } finally { cleanup(); }
});

// ---------- ideas ----------
test('ideas: add, edit with versions, drop/reopen, promote = task + links both ways in one commit', () => {
  const { root, cleanup } = tempRepo();
  try {
    assert.deepEqual(readIdeas(root, 'beta'), { app: 'beta', version: 0, updated: '', updated_by: '', ideas: [] });
    const a = addIdea(root, 'beta', { title: 'Group boards', title_ko: '같이 쓰는 보드', note: 'friends share one', source: 'notes.md' }, 'claude-code@desktop');
    assert.equal(a.id, 'beta.i-group-boards'); assert.equal(a.status, 'open'); assert.equal(a.version, 1); assert.equal(a.added_by, 'claude-code@desktop');
    assert.equal(addIdea(root, 'beta', { title: 'Group boards' }, 'helper').id, 'beta.i-group-boards-2', 'ids stay unique');
    assert.equal(readIdeas(root, 'beta').version, 2);
    assert.equal(status(() => addIdea(root, 'beta', { title: '' }, 'helper')), 400);
    assert.equal(status(() => addIdea(root, 'beta', { title: 'x', color: 'red' }, 'helper')), 400);
    assert.equal(status(() => addIdea(root, 'nope', { title: 'x' }, 'helper')), 404);
    // edit: translation, stale version, drop and reopen
    const e = updateIdea(root, 'beta', a.id, { title_en: 'Group boards', note_ko: '친구가 같이 써요' }, 'dasks-i18n', { expectedVersion: 1 });
    assert.equal(e.version, 2); assert.equal(e.updated_by, 'dasks-i18n'); assert.equal(e.title, 'Group boards');
    assert.equal(status(() => updateIdea(root, 'beta', a.id, { note: 'x' }, 'helper', { expectedVersion: 1 })), 409);
    assert.equal(updateIdea(root, 'beta', 'beta.i-group-boards-2', { status: 'dropped' }, 'helper').status, 'dropped');
    assert.equal(status(() => promoteIdea(root, 'beta', 'beta.i-group-boards-2', {}, 'helper')), 409, 'dropped ideas are not promoted');
    assert.equal(updateIdea(root, 'beta', 'beta.i-group-boards-2', { status: 'open' }, 'helper').status, 'open');
    assert.equal(status(() => updateIdea(root, 'beta', a.id, { status: 'promoted' }, 'helper')), 400);
    // promote: one commit with the task, its activity, its (empty) claim history, the ideas file and the idea activity
    const before = Number(git(root, ['rev-list', '--count', 'HEAD']));
    const { idea, task } = promoteIdea(root, 'beta', a.id, { priority: 'p3' }, 'codex@desktop', { expectedVersion: 2 });
    assert.equal(Number(git(root, ['rev-list', '--count', 'HEAD'])), before + 1, 'one commit');
    assert.deepEqual(git(root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort(),
      ['data/activity/beta/t-group-boards.jsonl', 'data/activity/ideas/beta.jsonl', 'data/claims/beta/t-group-boards.json', 'data/ideas/beta.json', 'data/tasks/beta/t-group-boards.md']);
    assert.match(git(root, ['log', '-1', '--format=%s']), /^codex@desktop: create beta\.t-group-boards \(todo\) from idea beta\.i-group-boards/);
    assert.equal(idea.status, 'promoted'); assert.equal(idea.promoted_task_id, task.id); assert.equal(idea.promoted_by, 'codex@desktop');
    const t = readTask(root, task.id);
    assert.equal(t.idea, a.id); assert.equal(t.title_ko, '같이 쓰는 보드'); assert.equal(t.title_en, 'Group boards'); assert.equal(t.priority, 'p3'); assert.equal(t.status, 'todo');
    assert.match(t.body, /friends share one/); assert.match(t.body, /Source: notes\.md/);
    assert.equal(status(() => promoteIdea(root, 'beta', a.id, {}, 'helper')), 409, 'promoted once');
    assert.equal(status(() => updateIdea(root, 'beta', a.id, { status: 'dropped' }, 'helper')), 409);
    assert.equal(status(() => promoteIdea(root, 'beta', 'beta.i-nope', {}, 'helper')), 404);
    // the board stays valid, the hook check is clean, the nested lock did not deadlock
    const b = loadBoard(root);
    assert.equal(check(b).errors.length, 0); assert.deepEqual(checkIdeas(root, b), []);
    // a failed promote (bad milestone) leaves nothing behind
    const head = git(root, ['rev-parse', 'HEAD']);
    assert.equal(status(() => promoteIdea(root, 'beta', 'beta.i-group-boards-2', { milestone: 'alpha.m1' }, 'helper')), 400);
    assert.equal(git(root, ['rev-parse', 'HEAD']), head);
    assert.equal(readIdeas(root, 'beta').ideas.find((i) => i.id === 'beta.i-group-boards-2')!.status, 'open');
    assert.equal(git(root, ['status', '--porcelain', 'data']).trim(), '');
    // a hand-broken ideas file is a warning for the hook, a 409 for readers
    fs.writeFileSync(path.join(root, 'data/ideas/beta.json'), '{oops');
    assert.equal(status(() => readIdeas(root, 'beta')), 409);
    assert.equal(checkIdeas(root, loadBoard(root)).length, 1);
  } finally { cleanup(); }
});

test('lock: nested withRepoLock in the same process runs inside the outer one', () => {
  const { root, cleanup } = tempRepo();
  try {
    const lock = path.join(root, '.git', 'dasks.lock');
    const r = withRepoLock(root, () => withRepoLock(root, () => fs.existsSync(lock) ? 'inner' : 'no lock', 200), 200);
    assert.equal(r, 'inner'); assert.equal(fs.existsSync(lock), false, 'released after the outer call');
  } finally { cleanup(); }
});

// ---------- UI dictionary ----------
const DICT_SRC = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const DICT: Record<string, Record<string, string>> = vm.runInNewContext(`${DICT_SRC}; DICT`);

test('dictionary: ko and en have the same keys, none empty, every key the UI asks for exists', () => {
  assert.deepEqual(Object.keys(DICT.ko).sort(), Object.keys(DICT.en).sort());
  for (const l of ['ko', 'en']) for (const [k, v] of Object.entries(DICT[l])) assert.ok(v.trim(), `${l}.${k} is empty`);
  for (const l of ['ko', 'en']) for (const k of Object.keys(DICT.ko)) assert.deepEqual((DICT[l][k].match(/\{\w+\}/g) || []).sort(), (DICT.ko[k].match(/\{\w+\}/g) || []).sort(), `placeholders of ${k}`);
  const used = new Set([...APP_SRC.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]));
  for (const m of HTML_SRC.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)) used.add(m[1]);
  for (const k of used) assert.ok(Object.hasOwn(DICT.ko, k), `missing key "${k}"`);
  // keys built from data: statuses, milestone statuses, link types, stats, structures
  for (const s of ['todo', 'doing', 'review', 'done', 'blocked-on-user', 'cancelled']) assert.ok(DICT.ko[`st.${s}`]);
  for (const s of ['planned', 'active', 'done', 'blocked']) assert.ok(DICT.ko[`ms.${s}`]);
  for (const s of ['kanban', 'threads', 'list', 'tree']) assert.ok(DICT.ko[`work.${s}`]);
  for (const s of ['progress', 'needs_you', 'running', 'todo', 'done', 'done_24h']) assert.ok(DICT.ko[`stat.${s}`]);
  for (const s of ['feeds', 'blocks', 'shares']) assert.ok(DICT.ko[`link.${s}`]);
});

/** The literal text of every template literal in `src` (interpolations cut out), plus quoted strings holding markup. */
function templateText(src: string): string[] {
  // stack: 'tpl' = inside a template (its text in bufs), number = inside ${…} (the brace depth to return to).
  const out: string[] = []; const stack: ('tpl' | number)[] = []; const bufs: string[] = []; let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]; const top = stack[stack.length - 1];
    if (top === 'tpl') {
      if (c === '\\') { bufs[bufs.length - 1] += src[++i] ?? ''; continue; }
      if (c === '`') { stack.pop(); out.push(bufs.pop()!); continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push(depth); depth = 0; i++; bufs[bufs.length - 1] += '\u0000'; continue; }
      bufs[bufs.length - 1] += c; continue;
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"') { // skip a quoted string
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/') { // skip a regex literal (a slash where an operand starts)
      const prev = src.slice(0, i).trimEnd().slice(-1);
      if (!prev || '(,=:[!&|?{};+'.includes(prev)) {
        let cls = false;
        for (i++; i < src.length; i++) {
          if (src[i] === '\\') { i++; continue; }
          if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
          else if (src[i] === '/' && !cls) break;
        }
        continue;
      }
    }
    if (c === '`') { stack.push('tpl'); bufs.push(''); continue; }
    if (c === '{') depth++;
    if (c === '}') { if (depth === 0 && typeof top === 'number') { depth = top; stack.pop(); continue; } depth--; }
  }
  for (const m of src.matchAll(/'(<[^'\n]*>)'/g)) out.push(m[1]);
  return out;
}

test('no hard-coded UI copy in app.js or index.html', () => {
  // Words a person reads: text between tags, readable attributes, toasts and prompts. Proper nouns live in PROPER.
  const words = /[A-Za-z가-힣]{2,}/;
  const found: string[] = [];
  for (const tpl of templateText(APP_SRC)) {
    for (const m of tpl.matchAll(/>([^<>]*)</g)) { const txt = m[1].replace(/\u0000/g, ''); if (words.test(txt)) found.push(`text: ${txt.trim()}`); }
    for (const m of tpl.matchAll(/(?<![-\w])(aria-label|title|placeholder|alt)="([^"]*)"/g)) { const txt = m[2].replace(/\u0000/g, ''); if (words.test(txt)) found.push(`${m[1]}: ${txt}`); }
  }
  for (const m of APP_SRC.matchAll(/\b(toast|prompt|confirm|alert)\(\s*['"`]([^'"`]*)/g)) if (words.test(m[2])) found.push(`${m[1]}: ${m[2]}`);
  assert.deepEqual(found, []);
  assert.ok(templateText(APP_SRC).length > 50, 'the scanner sees the templates');
  assert.deepEqual(templateText('const a = `<b>Hi ${x ? `<i>${y}</i>` : ""}</b>`;').flatMap((t) => [...t.matchAll(/>([^<>]*)</g)].map((m) => m[1].replace(/\u0000/g, '')).filter((x) => /[A-Za-z]{2,}/.test(x))), ['Hi '], 'the scanner finds planted copy');
  const html = HTML_SRC.replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, '').replace(/<title>Dasks<\/title>/, '');
  const htmlFound: string[] = [];
  for (const m of html.matchAll(/>([^<>]+)</g)) if (words.test(m[1]) && m[1].trim() !== 'Dasks') htmlFound.push(m[1].trim());
  for (const m of html.matchAll(/(?<![-\w])(aria-label|title|placeholder)="([^"]*)"/g)) if (words.test(m[2])) htmlFound.push(`${m[1]}: ${m[2]}`);
  assert.deepEqual(htmlFound, []);
});

test('fallback: a card shows the current language title, else the original; the UI defaults to English', () => {
  const ttSrc = /const readable = [\s\S]*?\nconst tt = .*;/.exec(APP_SRC)![0];
  const tt = (lang: string, o: any) => vm.runInNewContext(`let LANG = ${JSON.stringify(lang)}; ${ttSrc} tt(o)`, { o });
  assert.equal(tt('ko', { title: 'Ship', title_ko: '출시', title_en: 'Ship it' }), '출시');
  assert.equal(tt('en', { title: 'Ship', title_ko: '출시', title_en: 'Ship it' }), 'Ship it');
  assert.equal(tt('en', { title: '출시', title_ko: '출시' }), '출시', 'missing English: original');
  assert.equal(tt('ko', { title: 'Ship', title_ko: '' }), 'Ship');
  assert.match(APP_SRC, /return s === 'en' \|\| s === 'ko' \? s : 'en';/, 'default en');
  assert.match(APP_SRC, /get\('lang'\)/, '?lang= override');
  assert.match(APP_SRC, /function stored\(k\) \{ try \{ return localStorage\.getItem\(k\); \} catch/, 'localStorage wrapped in try/catch');
  assert.doesNotMatch(APP_SRC.replace(/function (stored|store|forget)\(k[^\n]*/g, ''), /localStorage\./, 'every localStorage use goes through the wrappers');
});

// ---------- live: HTTP + MCP + CLI ----------
async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
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
function cli(url: string, actor: string, args: string[], env: Record<string, string> = {}) {
  try { return { code: 0, out: execFileSync(process.execPath, [GB, ...args], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor, DASKS_PROG: 'dasks', ...env }, encoding: 'utf8', stdio: 'pipe' }) }; }
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

test('live: new goal pages, structure + ideas over HTTP, MCP tools, CLI, i18n fill', async () => {
  const { root, cleanup } = withOps();
  const { url, proc } = await startServer(root);
  const m = mcp(url, 'claude-code@desktop');
  const post = (p: string, body: any, actor = 'codex@desktop') => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url + '/p/ops')).status, 200);
    assert.equal((await fetch(url + '/i18n.js')).status, 200);
    assert.equal((await fetch(url + '/p/notes')).status, 404, 'no goal file yet');
    const views = await (await fetch(url + '/api/views')).json();
    assert.deepEqual(views.map((v: any) => [v.app, v.structure]), [['alpha', 'kanban'], ['beta', 'kanban'], ['delta', 'kanban'], ['gamma', 'kanban'], ['ops', 'kanban'], ['shared', 'kanban']]);
    let r = await post('/api/views/ops/structure', { structure: 'tree', expected_version: 0 });
    assert.equal(r.status, 200); assert.equal((await r.json()).structure, 'tree');
    assert.equal((await post('/api/views/ops/structure', { structure: 'tree', widgets: [] })).status, 400);
    assert.equal((await post('/api/views/ops/structure', { structure: 'list', expected_version: 0 })).status, 409);
    r = await post('/api/ideas/ops', { title: 'Status page', note: 'later' });
    assert.equal(r.status, 201); const idea = await r.json(); assert.equal(idea.id, 'ops.i-status-page'); assert.equal(idea.added_by, 'codex@desktop');
    assert.equal((await post('/api/ideas/ops', { title: 'x', expected_version: 1 })).status, 400);
    const list = await (await fetch(url + '/api/ideas/ops?status=open')).json();
    assert.equal(list.ideas.length, 1); assert.equal(list.activity.at(-1).action, 'add');
    assert.equal((await fetch(url + '/api/ideas/ops?status=maybe')).status, 400);
    assert.equal((await fetch(url + '/api/ideas/nope')).status, 404);
    r = await post(`/api/ideas/ops/${idea.id}/promote`, { expected_version: 1 });
    assert.equal(r.status, 201); const pr = await r.json(); assert.equal(pr.task.idea, idea.id); assert.equal(pr.idea.promoted_task_id, pr.task.id);
    assert.deepEqual((await (await fetch(url + '/api/ideas')).json()).find((x: any) => x.app === 'ops'), { app: 'ops', version: 2, open: 0, promoted: 1, dropped: 0 });
    // create/update with titles over HTTP
    r = await post('/api/tasks', { goal: 'ops', title: 'Key setup', title_ko: '키 설정', title_en: 'Key setup' }, 'claude-code@laptop');
    assert.equal(r.status, 201); assert.equal((await r.json()).title_ko, '키 설정');
    assert.equal((await post('/api/tasks', { goal: 'ops', title: 'Help', title_en: 'Help' }, 'helper')).status, 201);
    assert.equal((await post('/api/tasks', { goal: 'unknown', title: 'x' })).status, 400, 'unknown goal');

    // MCP: the board tools are listed, the language and idea tools work
    await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const tools = (await m.rpc('tools/list')).result.tools;
    const names = tools.map((t: any) => t.name);
    for (const n of ['list_goals', 'list_tasks', 'get_task', 'create_task', 'update_task', 'claim_task', 'finish_task', 'release_task', 'get_view', 'set_view', 'set_structure', 'list_ideas', 'add_idea', 'update_idea', 'promote_idea']) assert.ok(names.includes(n), n);
    const create = tools.find((t: any) => t.name === 'create_task');
    assert.ok(create.inputSchema.properties.title_ko && create.inputSchema.properties.title_en); assert.match(create.description, /title_ko \/ title_en/);
    assert.match(create.inputSchema.properties.app.description, /project/);
    assert.ok(tools.find((t: any) => t.name === 'update_task').inputSchema.properties.title_en);
    const c = await m.call('create_task', { app: 'ops', title: 'MCP', title_ko: 'MCP로', title_en: 'MCP' });
    assert.equal(c.err, false, c.text); assert.equal(c.json.title_ko, 'MCP로');
    const lt = await m.call('list_tasks', { app: 'ops' });
    assert.ok(lt.json.some((x: any) => x.id === 'ops.t-mcp' && x.title_ko === 'MCP로'));
    assert.ok((await m.call('list_goals', {})).json.goals.some((g: any) => g.app === 'ops'));
    const ai = await m.call('add_idea', { app: 'ops', title: 'Spare server', title_ko: '예비 서버', title_en: 'Spare server' });
    assert.equal(ai.err, false, ai.text); assert.equal(ai.json.added_by, 'claude-code@desktop');
    assert.equal((await m.call('update_idea', { id: ai.json.id, status: 'dropped', expected_version: 1 })).json.status, 'dropped');
    assert.equal((await m.call('list_ideas', { app: 'ops', status: 'dropped' })).json.ideas.length, 1);
    const ss = await m.call('set_structure', { app: 'ops', structure: 'kanban', expected_version: 1 });
    assert.equal(ss.err, false, ss.text); assert.equal(ss.json.structure, 'kanban');
    assert.equal((await m.call('set_structure', { app: 'ops', structure: 'kanban', expected_version: 0 })).err, true);

    assert.match(cli(url, 'cli@desktop', ['structure', 'ops', 'threads']).out, /ops structure threads/);
    assert.equal(cli(url, 'cli@desktop', ['structure', 'ops', 'gantt']).code, 2);
    assert.match(cli(url, 'cli@desktop', ['idea', 'add', 'ops', 'Label', 'alerts', '--note', 'n', '--title-ko', '알림 라벨']).out, /open\s+ops\.i-label-alerts/);
    assert.match(cli(url, 'cli@desktop', ['ideas']).out, /^ops\s+1 open\s+1 promoted\s+1 dropped/m);
    assert.match(cli(url, 'cli@desktop', ['idea', 'promote', 'ops.i-label-alerts', '--priority', 'p3']).out, /ops\.i-label-alerts promoted -> ops\.t-label-alerts/);
    assert.match(cli(url, 'cli@desktop', ['new', 'ops', 'Both', '--title-ko', '두 제목', '--title-en', 'Both']).out, /ops\.t-both\b/);
    assert.match(cli(url, 'cli@desktop', ['update', 'ops.t-both', '--title-ko', '두 개의 제목']).out, /\(v2\)/);

    // i18n fill: dry run lists what is missing; a real run writes through the API as dasks-i18n, keeps titles
    const dry = cli(url, 'x', ['i18n', 'fill', '--dry-run', '--app', 'ops']);
    assert.equal(dry.code, 0, dry.out); assert.match(dry.out, /^missing: \d+/);
    const fake = path.join(root, 'fake-translator.mjs');
    fs.writeFileSync(fake, `const p = process.argv.at(-1); const list = JSON.parse(p.slice(p.lastIndexOf('\\n') + 1)); const o = {};
for (const x of list) o[x.k] = x.to === 'Korean' ? '번역 ' + x.k : 'Translated ' + x.k; console.log('Here:\\n' + JSON.stringify(o));`);
    const before = loadBoard(root).tasks.find((x) => x.id === 'ops.t-help')!;
    const fill = cli(url, 'x', ['i18n', 'fill', '--app', 'ops', '--batch', '5'], { DASKS_I18N_CMD: JSON.stringify([process.execPath, fake]) });
    assert.equal(fill.code, 0, fill.out); assert.match(fill.out, /written: [1-9]/); assert.match(fill.out, /failed: 0/);
    const after = loadBoard(root);
    const fe = after.tasks.find((x) => x.id === 'ops.t-help')!;
    assert.match(fe.title_ko!, /^번역 k\d+$/); assert.equal(fe.title, 'Help'); assert.equal(fe.updated, before.updated, 'updated kept');
    assert.match(after.goals.find((g) => g.id === 'ops')!.title_en!, /^Translated/, 'Korean goal title got an English one');
    assert.match(git(root, ['log', '-1', '--format=%s']), /^dasks-i18n: /);
    assert.match(cli(url, 'x', ['i18n', 'fill', '--dry-run', '--app', 'ops']).out, /^missing: 0/);
    // a translator that fails: nothing written, exit 1
    const bad = cli(url, 'x', ['i18n', 'fill', '--app', 'beta'], { DASKS_I18N_CMD: JSON.stringify([process.execPath, '-e', 'process.exit(3)']) });
    if (!/^missing: 0/.test(bad.out)) assert.equal(bad.code, 1, bad.out);

    assert.equal(check(loadBoard(root)).errors.length, 0);
  } finally { m.proc.kill(); proc.kill(); cleanup(); }
});

test('notes overflow: oldest notes move to data/notes/, so claims, finishes and notes never get stuck at 413', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Busy thread' }, 'helper');
    for (let i = 0; i < 30; i++) updateTask(root, t.id, {}, 'codex@desktop', { appendNote: `round ${i} ${'x'.repeat(300)}` });
    const cur = readTask(root, t.id);
    assert.ok(cur.bytes <= 8192, `file stays writable (${cur.bytes} B)`);
    assert.match(cur.body, /- \(\d+ older notes: data\/notes\/beta\/t-busy-thread\.md\)/);
    assert.match(cur.body, /round 29 /); assert.match(cur.body, /round 27 /, 'the newest notes stay');
    const archive = fs.readFileSync(path.join(root, 'data/notes/beta/t-busy-thread.md'), 'utf8');
    assert.match(archive, /round 0 /); assert.doesNotMatch(cur.body, /round 0 /);
    const moved = Number(/\((\d+) older notes/.exec(cur.body)![1]);
    assert.equal((archive.match(/^- /gm) || []).length, moved, 'every moved note is in the archive exactly once');
    assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'archive committed with the task');
    // finish and claim still land
    updateTask(root, t.id, { status: 'done', result: 'run/test.log' }, 'codex@desktop', { appendNote: 'y'.repeat(400) });
    assert.equal(readTask(root, t.id).status, 'done');
    // a whole-body replace that is too big is still refused
    assert.equal(status(() => updateTask(root, t.id, {}, 'helper', { body: 'z'.repeat(9000) })), 413);
  } finally { cleanup(); }
});

test('rename without translations clears the stale ones (tasks, goals, ideas); node translation preconditions', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Old', title_ko: '옛', title_en: 'Old' }, 'helper');
    let u = updateTask(root, t.id, { title: 'New' }, 'sync');
    assert.equal(u.title_ko, undefined); assert.equal(u.title_en, undefined); assert.equal(u.title, 'New');
    u = updateTask(root, t.id, { title: 'Newer', title_ko: '새' }, 'helper');
    assert.equal(u.title_ko, '새', 'sent with the rename: kept');
    updateNode(root, 'beta', { title_ko: '베타' }, 'helper');
    updateNode(root, 'beta', { title: 'Beta renamed' }, 'sync');
    assert.equal(loadBoard(root).goals.find((g) => g.id === 'beta')!.title_ko, undefined);
    assert.equal(status(() => updateNode(root, 'beta', { title_en: 'x' }, 'dasks-i18n', { expectedTitle: 'beta' })), 409, 'title changed since');
    updateNode(root, 'beta', { title_ko: '베타' }, 'dasks-i18n', { expectedTitle: 'Beta renamed', ifMissing: true });
    assert.equal(status(() => updateNode(root, 'beta', { title_ko: '다른' }, 'dasks-i18n', { ifMissing: true })), 409, 'already set');
    const i = addIdea(root, 'beta', { title: 'A', title_ko: '가', note: 'n', note_en: 'n' }, 'helper');
    const e = updateIdea(root, 'beta', i.id, { title: 'B', note: 'm' }, 'sync');
    assert.equal(e.title_ko, undefined); assert.equal(e.note_en, undefined); assert.equal(e.title, 'B');
  } finally { cleanup(); }
});

test('ideas: the cap counts open ideas only; finished ideas move to the archive to make room', async () => {
  const { root, cleanup } = tempRepo();
  try {
    const { MAX_IDEAS } = await import('../src/lib/ideas.ts');
    // build a full file directly (fast), then go through the API functions
    const at = '2026-10-11T10:00:00+09:00';
    const ideas = Array.from({ length: MAX_IDEAS }, (_, n) => ({ id: `beta.i-n${n}`, title: `n${n}`, note: '', source: '', added_by: 'helper', added_at: at, status: n < 5 ? 'dropped' : 'open', version: 1, updated: at, updated_by: 'helper' }));
    fs.mkdirSync(path.join(root, 'data/ideas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/ideas/beta.json'), JSON.stringify({ app: 'beta', version: 1, updated: at, updated_by: 'helper', ideas }));
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'full']);
    const added = addIdea(root, 'beta', { title: 'One more' }, 'helper');
    assert.equal(added.status, 'open');
    const f = readIdeas(root, 'beta');
    assert.ok(f.ideas.length <= MAX_IDEAS); assert.ok(!f.ideas.some((x) => x.id === 'beta.i-n0'), 'oldest dropped idea archived');
    assert.match(fs.readFileSync(path.join(root, 'data/ideas/archive/beta.jsonl'), 'utf8'), /"beta\.i-n0"/);
    assert.deepEqual(checkIdeas(root, loadBoard(root)), [], 'the archive folder is not a stray file');
    // all open: refused
    const open = Array.from({ length: MAX_IDEAS }, (_, n) => ({ ...ideas[n], id: `beta.i-o${n}`, status: 'open' }));
    fs.writeFileSync(path.join(root, 'data/ideas/beta.json'), JSON.stringify({ app: 'beta', version: 9, updated: at, updated_by: 'helper', ideas: open }));
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'all open']);
    assert.equal(status(() => addIdea(root, 'beta', { title: 'Too many' }, 'helper')), 413);
  } finally { cleanup(); }
});

test('lock: an owner from an earlier boot, or this process without holding it, is stale; worktrees share the lock', () => {
  const { root, cleanup } = tempRepo();
  try {
    const lock = path.join(root, '.git', 'dasks.lock');
    const plant = (owner: string) => { fs.mkdirSync(lock, { recursive: true }); fs.writeFileSync(path.join(lock, 'owner'), owner); };
    const bootMin = Math.round((Date.now() - os.uptime() * 1000) / 60000);
    plant(`${process.ppid} ${bootMin - 600}`); // a live pid, but written ten hours before this boot
    assert.equal(withRepoLock(root, () => 'got it', 1000), 'got it');
    plant(`${process.pid} ${bootMin}`); // us, but nobody in this process holds it
    assert.equal(withRepoLock(root, () => 'got it', 1000), 'got it');
    plant(`${process.ppid} ${bootMin}`); // a live pid from this boot: respected
    assert.equal(status(() => withRepoLock(root, () => 'no', 300)), 503);
    fs.rmSync(lock, { recursive: true });
    // a linked worktree uses the main repo's lock
    const wt = path.join(root, '..', path.basename(root) + '-wt');
    git(root, ['worktree', 'add', '-q', wt]);
    try {
      assert.equal(fs.realpathSync(gitCommonDir(wt)), fs.realpathSync(path.join(root, '.git')));
      withRepoLock(wt, () => assert.ok(fs.existsSync(lock)));
    } finally { git(root, ['worktree', 'remove', '--force', wt]); }
  } finally { cleanup(); }
});

test('recovery: an unfinished write (journal) goes back to HEAD with a copy kept; other staged paths are left alone', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Crash' }, 'helper');
    const other = createTask(root, { goal: 'beta', title: 'Someone else' }, 'helper');
    const good = fs.readFileSync(path.join(root, t.file), 'utf8');
    // a crash after writing the task file and staging it, before the commit
    fs.writeFileSync(path.join(root, t.file), good + '\nhalf-written\n');
    git(root, ['add', '--', t.file]);
    fs.writeFileSync(journalPath(root), JSON.stringify({ pid: 1, message: 'helper: beta.t-crash edit', rels: [t.file, 'data/notes/beta/t-crash.md'] }));
    fs.mkdirSync(path.join(root, 'data/notes/beta'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/notes/beta/t-crash.md'), 'moved notes');
    // someone else's staged edit (not ours): must survive
    fs.appendFileSync(path.join(root, other.file), '\nhand edit\n');
    git(root, ['add', '--', other.file]);
    const log = recoverRepo(root);
    assert.ok(log.some((l) => /undid an unfinished write/.test(l)), log.join('\n'));
    assert.equal(fs.readFileSync(path.join(root, t.file), 'utf8'), good, 'back to HEAD');
    assert.equal(fs.existsSync(path.join(root, 'data/notes/beta/t-crash.md')), false, 'a file the write created is gone');
    const kept = fs.readdirSync(path.join(root, '.git/dasks-recovered'));
    assert.match(fs.readFileSync(path.join(root, '.git/dasks-recovered', kept[0], t.file), 'utf8'), /half-written/, 'what was on disk is kept');
    assert.equal(fs.existsSync(journalPath(root)), false);
    assert.match(git(root, ['diff', '--cached', '--name-only']), /t-someone-else/, 'the other staged path is untouched');
    assert.equal(updateTask(root, t.id, { priority: 'p1' }, 'helper').priority, 'p1');
  } finally { cleanup(); }
});

test('digest: notes still reach the digest when old notes move to the archive in the same commit', async () => {
  const { collectChanges } = await import('../src/lib/digest.ts');
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Long' }, 'helper');
    const start = git(root, ['rev-parse', 'HEAD']).trim();
    for (let i = 0; i < 40; i++) updateTask(root, t.id, {}, 'codex@desktop', { appendNote: `n${i} ${'x'.repeat(300)}` });
    assert.ok(fs.existsSync(path.join(root, 'data/notes/beta/t-long.md')), 'compaction happened');
    const { lines } = collectChanges(root, { rev: start });
    const notes = lines.filter((l) => / note: /.test(l.text));
    assert.equal(notes.length, 40, 'every note once');
    assert.ok(!lines.some((l) => /older notes/.test(l.text)), 'the archive marker is not a note');
  } finally { cleanup(); }
});

test('nodes: edits are checked like dasks check (the commit skips the hook)', () => {
  const { root, cleanup } = tempRepo();
  try {
    assert.equal(status(() => updateNode(root, 'beta', { owner: ' ' }, 'helper')), 400);
    assert.equal(status(() => updateNode(root, 'north', { why: '' }, 'helper')), 400);
    assert.equal(status(() => updateNode(root, 'north', { horizon: '' }, 'helper')), 400);
    assert.equal(status(() => updateNode(root, 'beta.m1', { due: '2026-02-31' }, 'helper')), 400);
    updateNode(root, 'beta.m1', { due: '2026-02-28' }, 'helper');
    assert.equal(check(loadBoard(root)).errors.length, 0);
  } finally { cleanup(); }
});

test('claims: a claim with no update for 6 h can be taken without force; a fresh one cannot', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Held' }, 'helper');
    updateTask(root, t.id, {}, 'codex@laptop', { claim: { op: 'claim', who: 'codex@laptop' }, now: new Date(Date.now() - 7 * 3600_000) });
    assert.equal(status(() => updateTask(root, t.id, {}, 'claude-code@desktop', { claim: { op: 'claim', who: 'claude-code@desktop' }, now: new Date(Date.now() - 6.5 * 3600_000), staleHours: 6 })), 409, 'not stale yet at that time');
    const warnings: string[] = [];
    const u = updateTask(root, t.id, {}, 'claude-code@desktop', { claim: { op: 'claim', who: 'claude-code@desktop' }, warnings });
    assert.equal(u.claimed_by, 'claude-code@desktop'); assert.match(warnings.join(), /stale claim/);
    assert.equal(status(() => updateTask(root, t.id, {}, 'helper', { claim: { op: 'claim', who: 'helper' } })), 409, 'fresh claim respected');
  } finally { cleanup(); }
});

test('writes: a hand commit that lands between read and write is not overwritten (409)', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Hand' }, 'helper');
    const raw = fs.readFileSync(path.join(root, t.file));
    fs.appendFileSync(path.join(root, t.file), '\nhand\n');
    assert.equal(status(() => commitFiles(root, [{ rel: t.file, content: 'x' }], 'helper: x', { [t.file]: raw })), 409);
    assert.match(fs.readFileSync(path.join(root, t.file), 'utf8'), /hand/);
  } finally { cleanup(); }
});

test('ideas: ids are never reused after archiving; a promote with a new title does not inherit the old translations', () => {
  const { root, cleanup } = tempRepo();
  try {
    fs.mkdirSync(path.join(root, 'data/ideas/archive'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/ideas/archive/beta.jsonl'), JSON.stringify({ id: 'beta.i-foo', title: 'Foo', status: 'promoted' }) + '\n');
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'archive']);
    assert.equal(addIdea(root, 'beta', { title: 'Foo' }, 'helper').id, 'beta.i-foo-2');
    const i = addIdea(root, 'beta', { title: 'Old', title_ko: '옛', title_en: 'Old' }, 'helper');
    const { task } = promoteIdea(root, 'beta', i.id, { title: 'New' }, 'helper');
    assert.equal(task.title, 'New'); assert.equal(task.title_ko, undefined); assert.equal(task.title_en, undefined);
    const j = addIdea(root, 'beta', { title: 'Same', title_ko: '같음' }, 'helper');
    assert.equal(promoteIdea(root, 'beta', j.id, {}, 'helper').task.title_ko, '같음');
  } finally { cleanup(); }
});

test('live: actor "user" only from the board page, 503 carries Retry-After and clients retry it, SSE hello has a boot id, digest window capped', async () => {
  const { root, cleanup } = tempRepo();
  createTask(root, { goal: 'beta', title: 'X' }, 'helper');
  const { url, proc } = await startServer(root);
  try {
    const w = (headers: Record<string, string>) => fetch(`${url}/api/tasks/beta.t-x`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'user', ...headers }, body: JSON.stringify({ note: 'hi' }) });
    assert.equal((await w({})).status, 401, 'a script cannot write as user');
    assert.equal((await w({ Origin: url })).status, 401, 'nor with a forged Origin: "user" needs the login session (decision-security.test.ts)');
    const { client } = await import('../mcp/board-client.mjs');
    assert.throws(() => client({ url, actor: 'user' }), /reserved/);
    const ctl = new AbortController();
    const r = await fetch(url + '/api/events', { signal: ctl.signal });
    const reader = r.body!.getReader(); const { value } = await reader.read(); ctl.abort();
    assert.match(new TextDecoder().decode(value), /event: hello\ndata: \{"version":\d+,"boot":"[0-9a-f]{8}"\}/);
    const d = await fetch(url + '/api/digest?since=2000-01-01');
    assert.equal(d.status, 200); assert.match(decodeURIComponent(d.headers.get('x-dasks-warning') || ''), /7 days/);
  } finally { proc.kill(); cleanup(); }
  // a 503 (nothing written) is retried by the client after Retry-After
  let hits = 0;
  const srv = (await import('node:http')).createServer((req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' }); res.end('{"error":"busy"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  try {
    const { client } = await import('../mcp/board-client.mjs');
    const c = client({ url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, actor: 'helper' });
    assert.deepEqual(await c.update('beta.t-x', { note: 'n' }), { ok: true }); assert.equal(hits, 2);
  } finally { srv.close(); }
});

test('notes land inside ## Notes; field caps; node expected values; a real goal beats an alias; journal per checkout, kept when rollback fails', async () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Job', body: '\n## Context\nx\n\n## Notes\n- 2026-10-11 10:00 helper: first\n\n## Job failure 2026-10-11\n```\nboom\n```\n' }, 'helper');
    const u = updateTask(root, t.id, {}, 'user', { appendNote: 'approved: retry with flag X' });
    const notes = /## Notes\n([\s\S]*?)(?=\n## )/.exec(u.body)![1];
    assert.match(notes, /first[\s\S]*approved: retry with flag X/, 'the note is in the Notes section');
    assert.match(u.body, /## Job failure[\s\S]*boom/, 'the later section is intact');
    assert.equal(status(() => updateTask(root, t.id, { result: 'r'.repeat(4001) }, 'helper')), 400);
    assert.equal(status(() => createTask(root, { goal: 'beta', title: 't'.repeat(201) }, 'helper')), 400);
    assert.equal(status(() => updateNode(root, 'beta.m1', { due: '2026-12-01' }, 'user', { expected: { status: 'planned' } })), 409, 'status is active, not planned');
    updateNode(root, 'beta.m1', { due: '2026-12-01' }, 'user', { expected: { status: 'active', done_criteria: 'a' } });
    // a rollback that fails keeps the journal; the next write puts the files back first
    const before = fs.readFileSync(path.join(root, t.file), 'utf8');
    const j = journalPath(root);
    assert.equal(path.dirname(j), path.join(root, '.git'));
    fs.writeFileSync(j, JSON.stringify({ root: fs.realpathSync(root), message: 'x', rels: [t.file] }));
    fs.writeFileSync(path.join(root, t.file), 'half');
    updateTask(root, createTask(root, { goal: 'beta', title: 'Other' }, 'helper').id, { priority: 'p1' }, 'helper');
    assert.equal(fs.readFileSync(path.join(root, t.file), 'utf8'), before, 'recovered before the next write');
    assert.equal(fs.existsSync(j), false);
    // a journal written by another checkout is left alone
    fs.writeFileSync(j, JSON.stringify({ root: '/somewhere/else', rels: [t.file] }));
    assert.match(recoverJournal(root), /not this checkout/);
    assert.ok(fs.existsSync(j)); fs.rmSync(j);
  } finally { cleanup(); }
});

test('live: a hand edit right after a server write still reaches readers (no lost reload)', async () => {
  const { root, cleanup } = tempRepo();
  const a = createTask(root, { goal: 'beta', title: 'A' }, 'helper');
  const b = createTask(root, { goal: 'beta', title: 'B' }, 'helper');
  const { url, proc } = await startServer(root);
  try {
    const r = await fetch(`${url}/api/tasks/${a.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'helper' }, body: JSON.stringify({ priority: 'p1' }) });
    assert.equal(r.status, 200);
    fs.writeFileSync(path.join(root, b.file), fs.readFileSync(path.join(root, b.file), 'utf8').replace('title: B', 'title: B edited by hand'));
    let title = '';
    for (let i = 0; i < 30 && title !== 'B edited by hand'; i++) { await new Promise((x) => setTimeout(x, 100)); title = (await (await fetch(`${url}/api/tasks/${b.id}`)).json()).title; }
    assert.equal(title, 'B edited by hand');
  } finally { proc.kill(); cleanup(); }
});

test('a leftover journal is undone before the next write reads anything (staged or not); a stale index.lock is cleared', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Same file' }, 'helper');
    for (const staged of [false, true]) {
      fs.writeFileSync(path.join(root, t.file), fs.readFileSync(path.join(root, t.file), 'utf8').replace('title: Same file', 'title: HALF'));
      if (staged) git(root, ['add', '--', t.file]);
      fs.writeFileSync(journalPath(root), JSON.stringify({ root: fs.realpathSync(root), message: 'x', rels: [t.file] }));
      const u = updateTask(root, t.id, { priority: staged ? 'p1' : 'p3' }, 'helper');
      assert.equal(u.title, 'Same file', `recovered before the read (staged=${staged})`);
      assert.equal(git(root, ['status', '--porcelain', '--', 'data']).trim(), '');
    }
    const idx = path.join(root, '.git', 'index.lock');
    fs.writeFileSync(idx, ''); const old = new Date(Date.now() - 120_000); fs.utimesSync(idx, old, old);
    assert.equal(updateTask(root, t.id, { priority: 'p2' }, 'helper').priority, 'p2', 'a stale index.lock does not block writes');
    assert.equal(fs.existsSync(idx), false);
  } finally { cleanup(); }
});

test('the claim lease follows the holder (others\' notes do not renew it); finish by a non-holder needs force', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Lease' }, 'helper');
    const h = (ago: number) => new Date(Date.now() - ago * 3600_000);
    updateTask(root, t.id, {}, 'codex@laptop', { claim: { op: 'claim', who: 'codex@laptop' }, now: h(8) });
    updateTask(root, t.id, {}, 'beta-lead', { appendNote: 'status?', now: h(1) }); // someone else's note: no renewal
    assert.equal(updateTask(root, t.id, {}, 'claude-code@desktop', { claim: { op: 'claim', who: 'claude-code@desktop' } }).claimed_by, 'claude-code@desktop');
    // the holder's own write renews it
    updateTask(root, t.id, {}, 'claude-code@desktop', { appendNote: 'still on it', now: h(7) });
    updateTask(root, t.id, {}, 'claude-code@desktop', { appendNote: 'still on it', now: h(1) });
    assert.equal(status(() => updateTask(root, t.id, {}, 'helper', { claim: { op: 'claim', who: 'helper' } })), 409);
    // finish by someone else: refused, unless forced
    assert.equal(status(() => updateTask(root, t.id, { result: 'run/test.log', status: 'done' }, 'codex@laptop', { action: 'finish', holderOnly: {} })), 409);
    assert.equal(updateTask(root, t.id, { result: 'run/test.log', status: 'done' }, 'codex@laptop', { action: 'finish', holderOnly: { force: true } }).status, 'done');
  } finally { cleanup(); }
});

test('live: an edit of the SAME file right after a server write still reaches readers', async () => {
  const { root, cleanup } = tempRepo();
  const a = createTask(root, { goal: 'beta', title: 'A' }, 'helper');
  const { url, proc } = await startServer(root);
  try {
    assert.equal((await fetch(`${url}/api/tasks/${a.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'helper' }, body: JSON.stringify({ priority: 'p1' }) })).status, 200);
    fs.writeFileSync(path.join(root, a.file), fs.readFileSync(path.join(root, a.file), 'utf8').replace('title: A', 'title: A by hand'));
    let title = '';
    for (let i = 0; i < 30 && title !== 'A by hand'; i++) { await new Promise((x) => setTimeout(x, 100)); title = (await (await fetch(`${url}/api/tasks/${a.id}`)).json()).title; }
    assert.equal(title, 'A by hand');
    const g = await fetch(`${url}/api/board`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(g.status, 200); assert.ok((await g.json()).tasks.length, 'gzip board decodes');
  } finally { proc.kill(); cleanup(); }
});

test('recovery restores the bytes from before the write (an unstaged edit survives); a blocked rollback keeps its journal', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Before' }, 'helper');
    // someone's unstaged edit is on disk; then a server write to the same file crashes before committing
    const edited = fs.readFileSync(path.join(root, t.file), 'utf8').replace('title: Before', 'title: Before (unstaged edit)');
    fs.writeFileSync(path.join(root, t.file), edited);
    fs.writeFileSync(journalPath(root), JSON.stringify({ root: fs.realpathSync(root), message: 'x', rels: [t.file], before: { [t.file]: Buffer.from(edited).toString('base64') } }));
    fs.writeFileSync(path.join(root, t.file), 'half-written');
    recoverRepo(root);
    assert.equal(fs.readFileSync(path.join(root, t.file), 'utf8'), edited, 'the unstaged edit is back, not HEAD');
    // a git index.lock held by someone (fresh, so not cleared) makes the commit and the index reset fail: journal stays
    git(root, ['checkout', '-q', 'HEAD', '--', t.file]);
    const idx = path.join(root, '.git', 'index.lock');
    fs.writeFileSync(idx, '');
    assert.equal(status(() => updateTask(root, t.id, { priority: 'p1' }, 'helper')), 503);
    assert.ok(fs.existsSync(journalPath(root)), 'journal kept: the rollback could not reset the index');
    fs.rmSync(idx);
    assert.equal(updateTask(root, t.id, { priority: 'p3' }, 'helper').priority, 'p3', 'the next write recovers first, then lands');
    assert.equal(fs.existsSync(journalPath(root)), false);
  } finally { cleanup(); }
});

test('a lock whose live pid started after the owner wrote it is a reused pid: taken over', () => {
  const { root, cleanup } = tempRepo();
  const live = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    const lock = path.join(gitCommonDir(root), 'dasks.lock');
    const boot = Math.round((Date.now() - os.uptime() * 1000) / 60000);
    const old = new Date(Date.now() - 60_000);
    // a live process that started just now holds the pid of an "owner" that wrote the lock a minute ago
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), `${live.pid} ${boot} ${Math.round(Date.now() / 1000) - 60}`);
    fs.utimesSync(lock, old, old);
    assert.equal(withRepoLock(root, () => 'ran', 3000), 'ran');
    // without a recorded start, the same live pid still holds it
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), `${live.pid} ${boot}`);
    fs.utimesSync(lock, old, old);
    assert.equal(status(() => withRepoLock(root, () => 'ran', 300)), 503);
  } finally { live.kill(); cleanup(); }
});

test('a journal left after its commit landed is dropped, never undone (the committed write survives)', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Landed' }, 'helper');
    const old = fs.readFileSync(path.join(root, t.file));
    const parent = git(root, ['rev-parse', 'HEAD']).trim();
    updateTask(root, t.id, { priority: 'p1' }, 'helper');
    const blob = git(root, ['rev-parse', `HEAD:${t.file}`]).trim();
    // and a later commit (a hand edit in another checkout) changed the same file again
    fs.writeFileSync(path.join(root, t.file), fs.readFileSync(path.join(root, t.file), 'utf8').replace('title: Landed', 'title: Landed later'));
    git(root, ['commit', '-qam', 'later edit']);
    const now = fs.readFileSync(path.join(root, t.file));
    // the process died after `git commit` and before the journal was removed
    fs.writeFileSync(journalPath(root), JSON.stringify({ root: fs.realpathSync(root), message: 'x', rels: [t.file], head: parent,
      written: { [t.file]: blob }, before: { [t.file]: old.toString('base64') } }));
    assert.match(recoverJournal(root), /already committed/);
    assert.deepEqual(fs.readFileSync(path.join(root, t.file)), now, 'the committed bytes stay');
    assert.equal(fs.existsSync(journalPath(root)), false);
    assert.equal(updateTask(root, t.id, { title: 'Landed 2' }, 'helper').priority, 'p1', 'the next write builds on the landed one');
    // a journal whose write did not land (HEAD still at its parent) is still undone
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    const cur = fs.readFileSync(path.join(root, t.file));
    fs.writeFileSync(journalPath(root), JSON.stringify({ root: fs.realpathSync(root), message: 'y', rels: [t.file], head, written: { [t.file]: 'f'.repeat(40) }, before: { [t.file]: cur.toString('base64') } }));
    fs.writeFileSync(path.join(root, t.file), 'half-written');
    assert.match(recoverJournal(root), /undid an unfinished write/);
    assert.deepEqual(fs.readFileSync(path.join(root, t.file)), cur);
  } finally { cleanup(); }
});

test('the claim heartbeat lives in the task (claim_seen), so a full activity log cannot make a live claim stale', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: 'Beat' }, 'helper');
    const h = (ago: number) => new Date(Date.now() - ago * 3600_000);
    updateTask(root, t.id, {}, 'codex@laptop', { claim: { op: 'claim', who: 'codex@laptop' }, now: h(12) });
    const u = updateTask(root, t.id, {}, 'codex@laptop', { appendNote: 'working', now: h(1) });
    assert.ok(u.claim_seen);
    // the activity log rolled over: no entry by the holder left
    fs.writeFileSync(path.join(root, 'data/activity/beta/t-beat.jsonl'), JSON.stringify({ at: h(0.5).toISOString(), actor: 'beta-lead', action: 'note' }) + '\n');
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'rolled']);
    assert.equal(status(() => updateTask(root, t.id, {}, 'helper', { claim: { op: 'claim', who: 'helper' } })), 409, 'still held');
    assert.equal(check(loadBoard(root)).errors.length, 0);
  } finally { cleanup(); }
});
