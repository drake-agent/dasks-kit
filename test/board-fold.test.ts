// The folding kanban board page (public/app.js in a vm with a stub DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { task } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
const DICT_SRC = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
const NOW = Date.parse('2026-10-23T12:00:00+09:00');
const HOUR = 3600000;
const DAY = 86400000;
const iso = (ms: number) => new Date(ms).toISOString();

/** app.js in a sandbox; `saved` answers localStorage.getItem. */
function loadApp(saved: Record<string, string> = {}) {
  const el = (): any => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, {
    get(t: any, k) { if (k in t) return t[k]; if (k === 'querySelectorAll') return () => []; if (k === 'querySelector' || k === 'closest') return () => null; return typeof k === 'string' && /^(add|remove|set|get|focus|blur|scroll|contains|matches|append)/.test(k) ? () => null : undefined; },
    set(t, k, v) { t[k] = v; return true; },
  });
  const document = { documentElement: el(), body: el(), hidden: false, activeElement: null, querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const ctx: any = {
    document, window: { innerWidth: 1440, scrollY: 0, scrollTo() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { pathname: '/', search: '?lang=ko', hash: '#/board', href: 'http://x/#/board' }, history: { ['replace' + 'State']() {} },
    localStorage: {
      getItem: (k: string) => (Object.hasOwn(saved, k) ? saved[k] : null),
      setItem: (k: string, v: string) => { saved[k] = String(v); },
      removeItem: (k: string) => { delete saved[k]; },
    },
    CSS: { escape: (s: string) => s }, URLSearchParams, URL, console,
    fetch: () => new Promise(() => {}), EventSource: class {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ transitionDuration: '0s', transitionDelay: '0s' }),
    Date: Object.assign(function (...a: any[]) { return a.length ? new (Date as any)(...a) : new Date(NOW); }, { now: () => NOW, parse: Date.parse, UTC: Date.UTC }),
  };
  ctx.globalThis = ctx;
  ctx.__missing = (n: string) => assert.fail(`${n} is not defined in app.js`);
  vm.createContext(ctx);
  vm.runInContext(DICT_SRC, ctx);
  const names = ['S', 't', 'viewBoard', 'enumLabel', 'stLabel'];
  const app = vm.runInContext(`${APP}\n;({ ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? () => __missing('${n}') : ${n}`).join(', ')} })`, ctx);
  return { app, DICT: vm.runInContext('DICT', ctx) };
}

const G = (id: string, ms: string[]) => ({ id, title: id, owner: `${id}-lead`, milestones: ms.map((m) => ({ id: m, title: `MS ${m}`, done_criteria: [] })) });
const GOALS = [G('beta', ['beta.m1', 'beta.m2']), G('alpha', ['alpha.m1']), G('gamma', ['gamma.m1'])];
/** The board payload around `tasks`; `stuck` is the server's stuck report (items only), left out when undefined. */
function board(app: any, tasks: any[], stuck?: string[]) {
  app.S.data = {
    tasks, goals: GOALS, links: [], northstar: { title: 'North Star', why: '', horizon: '' },
    rollup: { pct: 0, goals: GOALS.map((g) => ({ id: g.id, pct: 0, milestones: g.milestones.map((m) => ({ id: m.id, pct: 0, done: 0, total: 0 })) })) },
    ...(stuck ? { stuck: { items: stuck.map((id) => ({ id, title: id, goal: id.split('.')[0], status: 'todo', age_hours: 30, reason: 'dep-open', root_blocker: 'beta.t-root' })) } } : {}),
  };
  app.S.mode = 'board'; app.S.selected = null; app.S.q = ''; app.S.archive = false;
  return tasks;
}
const BASE = () => [
  task({ id: 'beta.t-a', status: 'todo', milestone: 'beta.m1' }),
  task({ id: 'beta.t-b', status: 'review', milestone: 'beta.m2' }),
  task({ id: 'beta.t-done', status: 'done', updated: iso(NOW - HOUR) }),
  task({ id: 'beta.t-cx', status: 'cancelled' }),
  task({ id: 'alpha.t-a', status: 'todo', milestone: 'alpha.m1' }),
  task({ id: 'gamma.t-done', status: 'done', updated: iso(NOW - HOUR) }),
];

const has = (html: string, id: string) => html.includes(`data-id="${id}"`) || html.includes(`data-drag="${id}"`);
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** Every board column: its opening tag and its inner html up to the next column. */
function columns(html: string) {
  const re = /<(?:div|section)\b[^>]*\bclass="col\b[^"]*"[^>]*>/g;
  const starts = [...html.matchAll(re)];
  return starts.map((m, i) => ({ tag: m[0], drop: /data-drop="([^"]+)"/.exec(m[0])?.[1] || '', body: html.slice(m.index! + m[0].length, i + 1 < starts.length ? starts[i + 1].index : html.length) }));
}
const col = (html: string, st: string) => columns(html).find((c) => c.drop === st)!;
const cardIds = (s: string) => [...s.matchAll(/data-drag="([^"]+)"/g)].map((m) => m[1]);
/** Each kanban card's html by id (from its class="kcard" to the next card). */
function cards(html: string) {
  const out: Record<string, string> = {};
  for (const c of columns(html)) for (const part of c.body.split(/(?=<div class="kcard)/).slice(1)) { const id = /data-drag="([^"]+)"/.exec(part)?.[1]; if (id) out[id] = part; }
  return out;
}
const button = (html: string, action: string) => new RegExp(`<button\\b[^>]*data-action="${action}"[^>]*>[\\s\\S]*?</button>`).exec(html)?.[0] || '';
const chips = (html: string) => [...html.matchAll(/<button\b[^>]*data-action="scope-chip"[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ html: m[0], scope: /data-scope="([^"]+)"/.exec(m[0])?.[1] || '', pressed: /aria-pressed="true"/.test(m[0]), text: text(m[0]) }));
const doneList = (html: string) => /<section\b[^>]*class="done-list"[\s\S]*?<\/section>/.exec(html)?.[0] || '';

test('fold 1 default scope is all; a saved scope stays; an unknown one renders as all', () => {
  const a = loadApp(); board(a.app, BASE());
  assert.equal(a.app.S.scope, 'all');
  const html = a.app.viewBoard();
  assert.ok(has(html, 'beta.t-a') && has(html, 'alpha.t-a'), 'cards from two goals');
  const b = loadApp({ 'dasks.scope': 'beta' }); board(b.app, BASE());
  assert.equal(b.app.S.scope, 'beta');
  const bh = b.app.viewBoard();
  assert.equal(b.app.S.scope, 'beta');
  assert.ok(has(bh, 'beta.t-a') && !has(bh, 'alpha.t-a'), 'beta only');
  const c = loadApp({ 'dasks.scope': 'nope.zzz' }); board(c.app, BASE());
  const ch = c.app.viewBoard();
  assert.equal(c.app.S.scope, 'all');
  assert.ok(has(ch, 'beta.t-a') && has(ch, 'alpha.t-a'));
});

test('fold 2 app chips: all plus each goal with open cards, counts, one pressed, milestone presses its goal', () => {
  const { app } = loadApp(); board(app, BASE());
  let cs = chips(app.viewBoard());
  // D.goals() order (APP_ORDER: alpha before beta)
  assert.deepEqual(cs.map((c) => c.scope), ['all', 'alpha', 'beta'], 'gamma has no open card: no chip');
  assert.match(cs[0].text, /^전체\s*3$/);
  assert.match(cs.find((c) => c.scope === 'beta')!.text, /\b2$/);
  assert.match(cs.find((c) => c.scope === 'alpha')!.text, /\b1$/);
  assert.equal(cs.filter((c) => c.pressed).length, 1);
  assert.equal(cs.find((c) => c.pressed)!.scope, 'all');
  app.S.q = 'alpha.t-a';
  assert.match(chips(app.viewBoard())[0].text, /\b3$/, 'counts ignore the search');
  app.S.q = '';
  app.S.scope = 'gamma';
  cs = chips(app.viewBoard());
  assert.ok(cs.some((c) => c.scope === 'gamma'), 'a selected goal with 0 open cards keeps its chip');
  assert.equal(cs.find((c) => c.pressed)!.scope, 'gamma');
  app.S.scope = 'beta.m2';
  cs = chips(app.viewBoard());
  assert.equal(cs.filter((c) => c.pressed).length, 1);
  assert.equal(cs.find((c) => c.pressed)!.scope, 'beta', 'a milestone scope presses its goal');
});

test('fold 3 milestone select lists only the picked goal; none with all', () => {
  const { app } = loadApp(); board(app, BASE());
  app.S.scope = 'beta';
  const html = app.viewBoard();
  const sel = /<select\b[^>]*data-action="scope"[\s\S]*?<\/select>/.exec(html)?.[0] || '';
  assert.ok(sel, 'select shown for a goal');
  const vals = [...sel.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(vals, ['beta', 'beta.m1', 'beta.m2']);
  app.S.scope = 'all';
  assert.ok(!/data-action="scope"/.test(app.viewBoard()), 'no select with 전체');
});

test('fold 4 empty columns fold and keep their drop target', () => {
  const { app } = loadApp();
  board(app, [task({ id: 'beta.t-a', status: 'todo' }), task({ id: 'beta.t-d', status: 'doing' }), task({ id: 'beta.t-s', status: 'todo' })], ['beta.t-s']);
  let html = app.viewBoard();
  const rev = col(html, 'review');
  assert.match(rev.tag, /class="col folded"/);
  assert.ok(text(rev.body).includes(app.stLabel('review')), 'label present');
  assert.match(text(rev.body), /\b0\b/, 'count 0');
  assert.ok(!/col-empty/.test(html), 'no empty-column text');
  assert.ok(!/folded/.test(col(html, 'todo').tag) && !/folded/.test(col(html, 'doing').tag));
  app.S.boardStuck = true;
  html = app.viewBoard();
  assert.match(col(html, 'doing').tag, /class="col folded"/, 'doing folds after the 멈춤 filter');
  assert.equal(col(html, 'doing').drop, 'doing');
  app.S.boardStuck = false;
  board(app, []);
  assert.ok(app.viewBoard().includes(app.t('board.empty')), 'no card at all: the empty line');
});

test('fold 5 no done column and no done card in an open column', () => {
  const { app } = loadApp(); board(app, BASE());
  for (const open of [false, true]) {
    app.S.boardDone = open;
    const html = app.viewBoard();
    const cs = columns(html);
    assert.deepEqual(cs.map((c) => c.drop), ['blocked-on-user', 'todo', 'doing', 'review']);
    for (const c of cs) assert.ok(!cardIds(c.body).includes('beta.t-done'), `${c.drop} holds no done card`);
  }
});

test('fold 6 top 6 per column in priority then oldest order, with +N and 접기', () => {
  const { app } = loadApp();
  const spec: [string, string, number][] = [['p2', 'a', 1], ['p0', 'b', 5], ['p1', 'c', 3], ['p3', 'd', 9], ['p1', 'e', 2], ['p2', 'f', 8], ['p0', 'g', 7], ['p3', 'h', 4], ['p2', 'i', 6]];
  const ts = spec.map(([p, n, age]) => task({ id: `beta.t-${n}`, title: `card ${n}`, status: 'todo', priority: p as any, created: iso(NOW - age * DAY), updated: iso(NOW - (10 - age) * HOUR) }));
  board(app, ts);
  let todo = col(app.viewBoard(), 'todo');
  assert.deepEqual(cardIds(todo.body), ['beta.t-g', 'beta.t-b', 'beta.t-c', 'beta.t-e', 'beta.t-f', 'beta.t-i']);
  const more = button(todo.body, 'more');
  assert.match(more, /data-key="board:todo"/);
  assert.ok(text(more).includes('+3 더 보기'), text(more));
  app.S.more.add('board:todo');
  todo = col(app.viewBoard(), 'todo');
  assert.equal(cardIds(todo.body).length, 9);
  assert.ok(text(button(todo.body, 'more')).includes('접기'));
  app.S.more.delete('board:todo');
  board(app, ts.slice(0, 6));
  todo = col(app.viewBoard(), 'todo');
  assert.equal(cardIds(todo.body).length, 6);
  assert.ok(!/data-action="more"/.test(todo.body), 'exactly 6: no more link');
  board(app, ts); app.S.q = 'card ';
  assert.equal(cardIds(col(app.viewBoard(), 'todo').body).length, 9, 'a search shows every hit');
});

const DONE = () => [
  task({ id: 'beta.t-open', status: 'todo' }),
  task({ id: 'beta.t-d1', status: 'done', updated: iso(NOW - HOUR) }),
  task({ id: 'beta.t-d2', status: 'done', updated: iso(NOW - 2 * HOUR) }),
  task({ id: 'beta.t-dy', status: 'done', updated: iso(NOW - DAY) }),
  task({ id: 'beta.t-d10', status: 'done', updated: iso(NOW - 10 * DAY) }),
  task({ id: 'alpha.t-d1', status: 'done', updated: iso(NOW - HOUR) }),
];
test('fold 7 오늘 끝남 pill counts today in scope; the done list opens newest first and follows the archive toggle', () => {
  const { app } = loadApp(); board(app, DONE());
  app.S.scope = 'beta';
  let html = app.viewBoard();
  let pill = button(html, 'board-done');
  assert.ok(pill, 'pill');
  assert.equal(text(pill), '오늘 끝남 2');
  assert.match(pill, /data-drop="done"/);
  assert.match(pill, /aria-pressed="false"/);
  assert.ok(!doneList(html), 'closed: no list');
  for (const id of ['beta.t-d1', 'beta.t-d2', 'beta.t-dy', 'beta.t-d10']) assert.ok(!has(html, id), `${id} not on the page`);
  app.S.scope = 'all';
  assert.equal(text(button(app.viewBoard(), 'board-done')), '오늘 끝남 3');
  app.S.scope = 'beta'; app.S.boardDone = true;
  html = app.viewBoard();
  assert.match(button(html, 'board-done'), /aria-pressed="true"/);
  const list = doneList(html);
  const order = [...list.matchAll(/data-action="select" data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['beta.t-d1', 'beta.t-d2', 'beta.t-dy']);
  app.S.archive = true;
  assert.ok(has(doneList(app.viewBoard()), 'beta.t-d10'), 'archive on: the 10-day card too');
});

test('fold 8 a search with a done hit opens the done list', () => {
  const { app } = loadApp(); board(app, DONE());
  app.S.scope = 'beta'; app.S.q = 'beta.t-dy';
  const html = app.viewBoard();
  assert.equal(app.S.boardDone ?? false, false);
  assert.ok(has(doneList(html), 'beta.t-dy'));
});

test('fold 9 멈춤 pill: count, filter, disabled at 0, absent without stuck data', () => {
  const { app } = loadApp();
  const ts = ['a', 'b', 'c', 'd', 'e'].map((n) => task({ id: `beta.t-${n}`, status: n === 'e' ? 'review' : 'todo' }));
  board(app, ts, ['beta.t-b', 'beta.t-e']);
  let html = app.viewBoard();
  const pill = button(html, 'board-stuck');
  assert.equal(text(pill), '멈춤 2');
  assert.match(pill, /aria-pressed="false"/);
  assert.ok(pill.includes(`title="${app.t('stuck.note')}"`), 'note as title');
  assert.ok(!html.includes('에서 멈춘 카드'), 'no per-project stuck line');
  app.S.boardStuck = true;
  html = app.viewBoard();
  assert.deepEqual(columns(html).flatMap((c) => cardIds(c.body)).sort(), ['beta.t-b', 'beta.t-e']);
  app.S.mode = 'list';
  const ids = [...app.viewBoard().matchAll(/data-action="select" data-id="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, ['beta.t-b', 'beta.t-e']);
  app.S.mode = 'board'; app.S.boardStuck = false;
  board(app, ts, []);
  assert.match(button(app.viewBoard(), 'board-stuck'), /\bdisabled\b/);
  board(app, ts);
  assert.ok(!/data-action="board-stuck"/.test(app.viewBoard()), 'no stuck data: no pill');
});

test('fold 10 card meta row: stuck edge and badge, lane, priority, age, decision; no owner or claim', () => {
  const { app } = loadApp();
  board(app, [
    task({ id: 'beta.t-stuck', status: 'todo', lane: 'claude' as any, owner: 'owner-zz9', claimed_by: 'claude-code@desktop', claimed_at: iso(NOW - HOUR) } as any),
    task({ id: 'beta.t-ok', status: 'todo', lane: 'claude' as any, owner: 'owner-zz9', claimed_by: 'claude-code@desktop' } as any),
    task({ id: 'beta.t-dec', status: 'todo', kind: 'decision' as any, owner: 'owner-zz9' }),
    { ...task({ id: 'beta.t-ask', status: 'todo', owner: 'owner-zz9' }), user_ask: true },
    task({ id: 'beta.t-p0', status: 'todo', priority: 'p0' as any, owner: 'owner-zz9', created: '' as any }),
  ], ['beta.t-stuck']);
  const cs = cards(app.viewBoard());
  assert.deepEqual(Object.keys(cs).sort(), ['beta.t-ask', 'beta.t-dec', 'beta.t-ok', 'beta.t-p0', 'beta.t-stuck']);
  const lane = app.enumLabel('lane', 'claude');
  assert.match(cs['beta.t-stuck'], /^<div class="kcard[^>]*\bdata-stuck\b/);
  assert.ok(cs['beta.t-stuck'].includes('stuck-badge'));
  assert.ok(!cs['beta.t-stuck'].includes(`>${lane}<`), 'stuck: badge, not the lane');
  assert.ok(!/data-stuck/.test(cs['beta.t-ok']) && !cs['beta.t-ok'].includes('stuck-badge'));
  assert.ok(cs['beta.t-ok'].includes(`>${lane}<`), 'healthy: lane chip');
  for (const [id, h] of Object.entries(cs)) {
    assert.ok(h.includes('class="ds-priority"'), `${id} priority`);
    assert.match(h, /class="chip age"/, `${id} age`);
    assert.ok(!/chip owner|chip claim/.test(h) && !h.includes('owner-zz9'), `${id} no owner or claim`);
    assert.match(h, /draggable="true"/);
    assert.match(h, /data-action="set-status"/);
  }
  assert.ok(cs['beta.t-dec'].includes('decision-tag') && text(cs['beta.t-dec']).includes('결정'));
  assert.ok(cs['beta.t-ask'].includes('decision-tag'));
  assert.ok(!cs['beta.t-ok'].includes('decision-tag'), 'impl card: no 결정');
  assert.ok(!/<div class="t"[^>]*>\s*<span class="ds-priority"/.test(cs['beta.t-p0']), 'no p0 icon in the title');
});

test('fold 11 list layout: no checkbox at desktop width, rows select, no done group, cancelled with the archive', () => {
  const { app } = loadApp(); board(app, BASE());
  app.S.mode = 'list';
  let html = app.viewBoard();
  assert.ok(!html.includes('data-action="check"') && !html.includes('type="checkbox"') && !html.includes('<label class="check'));
  const rows = [...html.matchAll(/<div class="check\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(rows.length >= 3, `rows ${rows.length}`);
  for (const r of rows) assert.match(r, /data-action="select"/);
  assert.ok(!/class="dot st-done"/.test(html), 'no done group');
  app.S.archive = true;
  html = app.viewBoard();
  assert.ok(has(html, 'beta.t-cx'), 'cancelled listed with the archive on');
  assert.ok(!/class="dot st-done"/.test(html), 'still no done group');
});

test('fold 11b list layout keeps the byPrio order: urgent first, then newest update', () => {
  const { app } = loadApp();
  board(app, [
    task({ id: 'beta.t-a', status: 'todo', priority: 'p3' as any, updated: iso(NOW - HOUR) }),
    task({ id: 'beta.t-b', status: 'todo', priority: 'p0' as any, updated: iso(NOW - 3 * HOUR) }),
    task({ id: 'beta.t-c', status: 'todo', priority: 'p0' as any, updated: iso(NOW - 2 * HOUR) }),
  ]);
  app.S.mode = 'list';
  const ids = [...app.viewBoard().matchAll(/data-action="select" data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['beta.t-c', 'beta.t-b', 'beta.t-a']);
});

test('fold 12 no check handler; the board copy has ko and en keys', () => {
  const { DICT } = loadApp();
  assert.ok(!/dataset\.action === 'check'/.test(APP), 'no check handler');
  const want: [string, RegExp][] = [['board.scope.all', /전체/], ['board.done.today', /오늘 끝남 \{n\}/], ['board.stuck', /멈춤 \{n\}/], ['board.more', /\+\{n\} 더 보기/], ['board.less', /접기/], ['board.decision', /결정/]];
  for (const [k, ko] of want) {
    assert.match(String(DICT.ko[k] || ''), ko, `ko ${k}`);
    assert.ok(String(DICT.en[k] || '').trim(), `en ${k}`);
    assert.ok(!/[가-힣]/.test(String(DICT.en[k])), `en ${k} is English`);
  }
});

test('fold 13 board CSS uses tokens only', () => {
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  for (const sel of ['.board-chip', '.board-pill', '.done-list', '.folded', '.kcard[data-stuck]']) {
    const mine = rules.filter((r) => r.sel.includes(sel));
    assert.ok(mine.length, `rules for ${sel}`);
    for (const r of mine) assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(r.body), `${r.sel}: ${r.body.trim()}`);
  }
});

test('saved view state under the old gb.* keys moves to dasks.* once; a dasks.* value wins', () => {
  const saved: Record<string, string> = { 'gb.scope': 'beta', 'gb.mode': 'list', 'dasks.mode': 'board' };
  const { app } = loadApp(saved);
  assert.equal(app.S.scope, 'beta', 'the old scope is used');
  assert.equal(app.S.mode, 'board', 'a value already under the new key wins');
  assert.deepEqual(Object.keys(saved).filter((k) => k.startsWith('gb.')), [], 'the old keys are gone');
  assert.equal(saved['dasks.scope'], 'beta');
});
