// Board archive and milestone grouping (public/app.js in a vm with a stub DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { task } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const DICT_SRC = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
const NOW = Date.parse('2026-10-23T12:00:00+09:00');
const DAY = 86400000;
const iso = (ms: number) => new Date(ms).toISOString();

/** app.js in a sandbox; `saved` answers localStorage.getItem, `writes` records setItem calls. */
function loadApp(saved: Record<string, string> = {}) {
  const writes: [string, string][] = [];
  const el = (): any => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, {
    get(t: any, k) { if (k in t) return t[k]; if (k === 'querySelectorAll') return () => []; if (k === 'querySelector' || k === 'closest') return () => null; return typeof k === 'string' && /^(add|remove|set|get|focus|blur|scroll|contains|matches|append)/.test(k) ? () => null : undefined; },
    set(t, k, v) { t[k] = v; return true; },
  });
  const document = { documentElement: el(), body: el(), hidden: false, activeElement: null, querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const ctx: any = {
    document, window: { innerWidth: 1440, scrollY: 0, scrollTo() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { pathname: '/', search: '', hash: '#/board', href: 'http://x/#/board' }, history: { ['replace' + 'State']() {} },
    localStorage: { getItem: (k: string) => (Object.hasOwn(saved, k) ? saved[k] : null), setItem: (k: string, v: string) => { writes.push([k, String(v)]); } },
    CSS: { escape: (s: string) => s }, URLSearchParams, URL, console,
    fetch: () => new Promise(() => {}), EventSource: class {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ transitionDuration: '0s', transitionDelay: '0s' }),
    Date: Object.assign(function (...a: any[]) { return a.length ? new (Date as any)(...a) : new Date(NOW); }, { now: () => NOW, parse: Date.parse, UTC: Date.UTC }),
  };
  ctx.globalThis = ctx;
  ctx.__missing = (n: string) => assert.fail(`${n} is not defined in app.js`);
  vm.createContext(ctx);
  vm.runInContext(DICT_SRC, ctx);
  const names = ['S', 't', 'ago', 'isArchived', 'visibleTasks', 'archiveNote', 'toggleArchive', 'pageTasks', 'viewBoard', 'viewGoals', 'goalCard', 'WORK'];
  // A missing helper becomes a function that fails by assertion, so each test fails on its own instead of the whole file.
  const app = vm.runInContext(`${APP}\n;({ ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? () => __missing('${n}') : ${n}`).join(', ')} })`, ctx);
  return { app, writes, DICT: vm.runInContext('DICT', ctx) };
}

const PR = (n: number) => `https://github.com/example-org/dasks/pull/${n}`;
const TASKS = () => [
  task({ id: 'beta.t-open1', status: 'todo', milestone: 'beta.m2', updated: iso(NOW - 30 * DAY) }),
  task({ id: 'beta.t-open2', status: 'doing', milestone: 'beta.m1', updated: iso(NOW - DAY) }),
  task({ id: 'beta.t-nom', status: 'todo', milestone: '' }),
  task({ id: 'beta.t-odd', status: 'todo', milestone: 'beta.m9' }),
  task({ id: 'beta.t-dnew', status: 'done', milestone: 'beta.m1', pr: PR(5), updated: iso(NOW - 3 * DAY) }),
  task({ id: 'beta.t-dold', status: 'done', milestone: 'beta.m1', pr: PR(4), updated: iso(NOW - 10 * DAY) }),
  task({ id: 'beta.t-cncl', status: 'cancelled', milestone: 'beta.m1' }),
];
const GOAL = { id: 'beta', title: 'Beta — launch the app', owner: 'beta-lead', milestones: [{ id: 'beta.m1', title: 'M1', done_criteria: [] }, { id: 'beta.m2', title: 'M2', done_criteria: [] }] };
function board(app: any, tasks: any[] = TASKS()) {
  app.S.data = {
    tasks, goals: [GOAL], links: [], northstar: { title: 'North Star', why: '', horizon: '' },
    rollup: { pct: 40, goals: [{ id: 'beta', pct: 40, milestones: [{ id: 'beta.m1', pct: 100, done: 2, total: 2 }, { id: 'beta.m2', pct: 25, done: 1, total: 4 }] }] },
  };
  app.S.scope = 'beta'; app.S.mode = 'board'; app.S.selected = null;
  return tasks;
}
const ids = (xs: any[]) => JSON.parse(JSON.stringify(xs.map((x) => x.id)));
const has = (html: string, id: string) => html.includes(`data-id="${id}"`);
const HIDDEN = ['beta.t-dold', 'beta.t-cncl'];

test('isArchived marks cancelled and done older than 7 days', () => {
  const { app } = loadApp(); const ts = board(app);
  for (const id of HIDDEN) assert.equal(app.isArchived(ts.find((x) => x.id === id)), true, id);
  assert.equal(app.isArchived(task({ id: 'beta.t-b1', status: 'done', updated: iso(NOW - 7 * DAY - 60000) })), true, 'done 7 days and 1 minute ago');
});

test('isArchived keeps open cards and recent done', () => {
  const { app } = loadApp(); const ts = board(app);
  for (const id of ['beta.t-open1', 'beta.t-open2', 'beta.t-nom', 'beta.t-odd', 'beta.t-dnew']) assert.equal(app.isArchived(ts.find((x) => x.id === id)), false, id);
  assert.equal(app.isArchived(task({ id: 'beta.t-b3', status: 'done', updated: iso(NOW - 7 * DAY) })), false, 'done exactly 7 days ago');
  assert.equal(app.isArchived(task({ id: 'beta.t-b5', status: 'blocked-on-user', updated: iso(NOW - 60 * DAY) })), false, 'old open card');
});

test('visibleTasks hides archived by default and keeps order', () => {
  const { app } = loadApp(); const ts = board(app);
  assert.equal(app.S.archive, false);
  assert.deepEqual(ids(app.visibleTasks(ts)), ids(ts.filter((x) => !HIDDEN.includes(x.id))));
  app.S.archive = true;
  assert.deepEqual(ids(app.visibleTasks(ts)), ids(ts));
  assert.deepEqual(ids(app.pageTasks('beta')), ids(ts), 'pageTasks with the toggle on: every card of the goal, cancelled included');
  app.S.archive = false;
  assert.deepEqual(ids(app.pageTasks('beta')), ids(ts.filter((x) => !HIDDEN.includes(x.id))));
  assert.deepEqual(ids(app.pageTasks('nope')), []);
});

test('the archive toggle shows everything and is remembered', () => {
  const on = loadApp({ 'dasks.archive': '1' }); board(on.app);
  assert.equal(on.app.S.archive, true, 'saved choice read at load');
  const off = loadApp(); board(off.app);
  try { off.app.toggleArchive(); } catch { /* render() may need a real DOM; the state and the saved choice come first */ }
  assert.equal(off.app.S.archive, true);
  assert.deepEqual(JSON.parse(JSON.stringify(off.writes.filter(([k]) => k === 'dasks.archive'))), [['dasks.archive', '1']]);
  try { off.app.toggleArchive(); } catch { /* as above */ }
  assert.equal(off.app.S.archive, false);
  assert.deepEqual(JSON.parse(JSON.stringify(off.writes.filter(([k]) => k === 'dasks.archive'))), [['dasks.archive', '1'], ['dasks.archive', '0']]);
  assert.match(APP, /\ba === 'archive'\)\s*\{?\s*toggleArchive\(\)/, 'click on data-action="archive" calls toggleArchive');
});

test('archive note counts hidden cards in both languages', () => {
  const { app, DICT } = loadApp(); const ts = board(app);
  for (const lang of ['ko', 'en']) for (const k of ['archive.hidden', 'archive.shown']) assert.match(String(DICT[lang][k] || ''), /\{n\}/, `${lang} ${k}`);
  for (const lang of ['ko', 'en']) assert.ok(String(DICT[lang]['ms.none'] || '').trim(), `${lang} ms.none`);
  const note = app.archiveNote(ts);
  assert.ok(note.includes('data-action="archive"'), 'one toggle button');
  assert.ok(note.includes(app.t('archive.hidden', { n: 2 })), 'hidden count');
  app.S.archive = true;
  assert.ok(app.archiveNote(ts).includes(app.t('archive.shown', { n: 2 })), 'shown count with the toggle on');
  assert.equal(app.archiveNote(ts.filter((x) => !HIDDEN.includes(x.id))), '', 'nothing archived: no note');
});

test('board view hides old done and shows the note', () => {
  const { app } = loadApp(); board(app); app.S.boardDone = true;
  const html = app.viewBoard();
  for (const id of ['beta.t-open1', 'beta.t-open2', 'beta.t-dnew']) assert.ok(has(html, id), id);
  for (const id of HIDDEN) assert.ok(!has(html, id), `${id} hidden`);
  assert.ok(html.includes(app.t('archive.hidden', { n: 2 })), 'count of hidden cards in this scope');
  assert.ok(html.includes('data-action="archive"'));
});

test('board view shows old done with the toggle on', () => {
  const { app } = loadApp(); board(app); app.S.archive = true; app.S.boardDone = true;
  const html = app.viewBoard();
  for (const id of ['beta.t-dold', 'beta.t-dnew']) assert.ok(has(html, id), id);
  assert.ok(html.includes(app.t('archive.shown', { n: 2 })));
  app.S.mode = 'list';
  assert.ok(has(app.viewBoard(), 'beta.t-cncl'), 'list mode with the toggle on lists the cancelled card');
});

test('goals tree hides old done under a milestone', () => {
  const { app } = loadApp(); board(app); app.S.expanded = new Set(['beta', 'beta.m1', 'beta.m2']);
  const html = app.viewGoals();
  assert.ok(has(html, 'beta.t-dnew') && has(html, 'beta.t-open2') && has(html, 'beta.t-open1'));
  for (const id of HIDDEN) assert.ok(!has(html, id), `${id} hidden`);
  app.S.archive = true;
  assert.ok(has(app.viewGoals(), 'beta.t-dold'));
});

test('list groups open cards by milestone in goal order', () => {
  const { app } = loadApp(); const ts = board(app);
  const html = app.WORK.list(app.visibleTasks(ts), 12, GOAL);
  const groups = [...html.matchAll(/data-ms="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ['beta.m1', 'beta.m2', 'none']);
  const at = (s: string) => html.indexOf(s);
  assert.ok(at('data-ms="beta.m1"') < at('beta.t-open2') && at('beta.t-open2') < at('data-ms="beta.m2"'), 'open2 under M1');
  assert.ok(at('data-ms="beta.m2"') < at('beta.t-open1') && at('beta.t-open1') < at('data-ms="none"'), 'open1 under M2');
  assert.match(html, /data-ms="beta\.m1"[\s\S]*?M1 <span class="n">1<\/span>/);
});

test('cards without a milestone go last under no milestone with a count', () => {
  const { app } = loadApp(); const ts = board(app);
  const html = app.WORK.list(app.visibleTasks(ts), 12, GOAL);
  const tail = html.slice(html.indexOf('data-ms="none"'));
  assert.ok(tail.includes(`${app.t('ms.none')} <span class="n">2</span>`), 'no milestone heading with its count');
  assert.ok(tail.includes('beta.t-nom') && tail.includes('beta.t-odd'), 'empty and unknown milestone both land here');
  assert.ok(!html.slice(0, html.indexOf('data-ms="none"')).includes('beta.t-nom'));
});

test('home goal card shows the current milestone and its percent', () => {
  const { app } = loadApp(); board(app);
  const html = app.goalCard('beta');
  const m = /<span class="goal-ms">([\s\S]*?)<\/span>/.exec(html);
  assert.ok(m, 'goal-ms element');
  assert.ok(m![1].includes('M2') && m![1].includes('25%'), `first milestone not done, with its percent: ${m![1]}`);
});

test('home goal card shows the last merge time', () => {
  const { app } = loadApp(); const ts = board(app);
  const want = app.t('home.lastmerge', { t: app.ago(ts.find((x) => x.id === 'beta.t-dnew').updated) });
  assert.ok(want.includes('3'), want);
  assert.ok(app.goalCard('beta').includes(`<span class="goal-merge">${want}</span>`), 'newest done card with a PR');
  board(app, TASKS().map((x) => ({ ...x, pr: '' })));
  assert.ok(!app.goalCard('beta').includes('goal-merge'), 'no merged card: no line');
});

test('the project work widget lists pageTasks and the note', () => {
  const src = /\n  work\(w, g, v\) \{[\s\S]*?\n  \},/.exec(APP)?.[0] || '';
  assert.ok(src, 'WIDGET.work found');
  assert.match(src, /WORK\[s\]\(pageTasks\(PAGE\),/);
  assert.match(src, /archiveNote\(/);
});

test('kanban done column keeps its 7 day window', () => {
  const { app } = loadApp(); const ts = board(app);
  const html = app.WORK.kanban(ts.filter((x) => x.status !== 'cancelled'), 6);
  assert.ok(has(html, 'beta.t-dnew') && !has(html, 'beta.t-dold'));
});

test('goal roll-up percent is unchanged', () => {
  const { app } = loadApp(); board(app);
  const html = app.goalCard('beta');
  assert.ok(html.includes('aria-label="40%"'), 'ring = roll-up pct');
  assert.ok(html.includes('href="/p/beta"'));
});

test('cancelled never shows in board columns', () => {
  const { app } = loadApp(); board(app);
  assert.ok(!has(app.viewBoard(), 'beta.t-cncl'));
});

test('list mode still shows open cards and the done count', () => {
  const { app } = loadApp(); const ts = board(app);
  const html = app.WORK.list(ts.filter((x) => x.status !== 'cancelled'), 12, GOAL);
  for (const id of ['beta.t-open1', 'beta.t-open2', 'beta.t-nom']) assert.ok(html.includes(id), id);
  assert.ok(html.includes(app.t('work.donecount', { n: 2 })));
});
