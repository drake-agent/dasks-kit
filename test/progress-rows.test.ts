// Home project progress rows (public/app.js in a vm with a stub DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { task } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const DICT_SRC = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
const NOW = Date.parse('2026-10-24T12:00:00+09:00');
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function loadApp() {
  const el = (): any => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, {
    get(t: any, k) { if (k in t) return t[k]; if (k === 'querySelectorAll') return () => []; if (k === 'querySelector' || k === 'closest') return () => null; return typeof k === 'string' && /^(add|remove|set|get|focus|blur|scroll|contains|matches|append)/.test(k) ? () => null : undefined; },
    set(t, k, v) { t[k] = v; return true; },
  });
  const document = { documentElement: el(), body: el(), hidden: false, activeElement: null, querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const storage = new Map<string, string>();
  const ctx: any = {
    document, window: { innerWidth: 1440, scrollY: 0, scrollTo() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { pathname: '/', search: '?lang=ko', hash: '#/home', href: 'http://x/#/home' }, history: { ['replace' + 'State']() {} },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } },
    CSS: { escape: (s: string) => s }, URLSearchParams, URL, console, Intl,
    fetch: () => new Promise(() => {}), EventSource: class {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ transitionDuration: '0s', transitionDelay: '0s' }),
    Date: Object.assign(function (...a: any[]) { return a.length ? new (Date as any)(...a) : new Date(NOW); }, { now: () => NOW, parse: Date.parse, UTC: Date.UTC }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(DICT_SRC, ctx);
  const names = ['S', 'DICT', 'progressRow', 'progressRows', 'progressSection', 'folderModel', 'folderColumn', 'reportCard'];
  return vm.runInContext(`${APP}\n;({ ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? () => { throw new Error('${n} is not defined in app.js'); } : ${n}`).join(', ')} })`, ctx);
}

// The oracle board: beta (m1 done, m2 active at 50 % → stage m2) and one (no milestones).
const PR = 'https://github.com/example-org/beta/pull/7';
const T = (id: string, status: string, over: Record<string, unknown> = {}) =>
  task({ id: `${id.split('.')[0]}.t-${id.split('.')[1]}`, status, milestone: id.startsWith('beta') ? 'beta.m2' : '', updated: iso(NOW - 40 * HOUR), ...over } as any);
const CARDS = [
  T('beta.a', 'blocked-on-user', { priority: 'p0', needs_user: 'Pick the launch name\nmore detail', updated: iso(NOW - 100 * HOUR) }),
  T('beta.b', 'review', { pr: PR, needs_user: 'OK the PR', updated: iso(NOW - 2 * HOUR) }),
  T('beta.c', 'review', { pr: PR, needs_user: 'OK the other PR', updated: iso(NOW - 30 * HOUR) }),
  T('beta.d', 'doing', { started_at: iso(NOW - HOUR), updated: iso(NOW - HOUR) }),
  T('beta.e', 'doing', { started_at: iso(NOW - 8 * HOUR), updated: iso(NOW - 8 * HOUR) }),
  T('beta.f', 'todo'),
  T('beta.g', 'todo', { priority: 'p0', updated: iso(NOW - 50 * HOUR) }),
  T('beta.x', 'cancelled', { priority: 'p0' }),
  T('beta.w1', 'done', { priority: 'p0', result: 'Shipped the build\nRESULT: ok' }),
  T('beta.w2', 'done'),
  T('gamma.w3', 'done'),
];
const STUCK = [
  { id: 'beta.t-c', goal: 'beta', reason: 'review-stale', age_hours: 30 },
  { id: 'beta.t-e', goal: 'beta', reason: 'doing-stale', age_hours: 8 },
  { id: 'beta.t-f', goal: 'beta', reason: 'dep-open', age_hours: 40, root_blocker: 'beta.t-a' },
  { id: 'beta.t-g', goal: 'beta', reason: 'ready-idle', age_hours: 50 },
  { id: 'beta.t-a', goal: 'beta', reason: 'blocked-user', age_hours: 100 },
];
function board(app: any, over: { goals?: any[]; rollup?: any; stuck?: any } = {}) {
  app.S.data = {
    tasks: CARDS.map((x) => ({ ...x })),
    goals: over.goals ?? [
      { id: 'beta', title: 'Beta', milestones: [{ id: 'beta.m1', title: 'Alpha', status: 'done', due: '' }, { id: 'beta.m2', title: 'Beta', status: 'active', due: '2026-11-30' }] },
      { id: 'gamma', title: 'Gamma', milestones: [] },
    ],
    rollup: over.rollup ?? { pct: 30, goals: [
      { id: 'beta', pct: 75, milestones: [{ id: 'beta.m1', pct: 100 }, { id: 'beta.m2', pct: 50 }] },
      { id: 'gamma', pct: 0, milestones: [] },
    ] },
    stuck: over.stuck === undefined ? { items: STUCK } : over.stuck,
    links: [], northstar: { title: 'North Star' },
  };
}
const ids = (...short: string[]) => short.map((s) => `${s.split('.')[0]}.t-${s.split('.')[1]}`);
/** The data-ids of the report cards in the open list under `app`'s row, in order. */
function listIds(html: string, app: string): string[] {
  const start = html.indexOf(`id="prog-list-${app}"`);
  assert.ok(start >= 0, `list for ${app} rendered`);
  const end = html.indexOf('id="prog-list-', start + 1);
  const part = html.slice(start, end < 0 ? html.length : end);
  return [...part.matchAll(/data-action="select" data-id="([^"]+)"/g)].map((m) => m[1]);
}

test('row counts per project', () => {
  const app = loadApp(); board(app);
  const rows = app.progressRows();
  assert.deepEqual(rows.map((r: any) => r.app), ['beta', 'gamma']);
  const [beta, one] = rows;
  assert.deepEqual([...beta.turn], ids('beta.a', 'beta.c', 'beta.b'), '내 차례 in turnOf order (p0, then oldest)');
  assert.deepEqual([...beta.doing], ids('beta.e', 'beta.d'), '진행 = runningOf');
  assert.deepEqual([...beta.stalled], ids('beta.e'));
  assert.deepEqual([beta.turn.length, beta.doing.length, beta.stalled.length], [3, 2, 1]);
  assert.deepEqual([one.turn.length, one.doing.length, one.stalled.length], [0, 0, 0]);
  assert.deepEqual(JSON.parse(JSON.stringify(app.progressRow('beta'))), JSON.parse(JSON.stringify(beta)), 'one row alone = the same row in the list');
});

test('current stage is the first milestone not done', () => {
  const app = loadApp(); board(app);
  const beta = app.progressRow('beta');
  assert.deepEqual({ ...beta.stage }, { id: 'beta.m2', title: 'Beta', pct: 50 });
  assert.equal(beta.allDone, false);
  const one = app.progressRow('gamma');
  assert.equal(one.stage, null); assert.equal(one.allDone, false);
  // All milestones done (one by status, one by its 100 %): no stage, all done, a full bar.
  board(app, {
    goals: [{ id: 'beta', title: 'Beta', milestones: [{ id: 'beta.m1', title: 'Alpha', status: 'done', due: '' }, { id: 'beta.m2', title: 'Beta', status: 'active', due: '' }] }, { id: 'gamma', title: 'Gamma', milestones: [] }],
    rollup: { pct: 50, goals: [{ id: 'beta', pct: 100, milestones: [{ id: 'beta.m1', pct: 100 }, { id: 'beta.m2', pct: 100 }] }, { id: 'gamma', pct: 0, milestones: [] }] },
  });
  const done = app.progressRow('beta');
  assert.equal(done.stage, null); assert.equal(done.allDone, true);
  const html = app.progressSection();
  assert.match(html, new RegExp(app.DICT.ko['prog.alldone']));
  assert.match(html, new RegExp(app.DICT.ko['prog.nostage']));
  assert.match(html, /--value:100%/, 'all done draws a full bar');
});

test('stalled excludes your-turn cards and other reasons', () => {
  const app = loadApp(); board(app);
  const beta = app.progressRow('beta');
  assert.ok(beta.turn.includes('beta.t-c'), 'C (review-stale, but 내 차례) is in 내 차례');
  assert.ok(!beta.stalled.includes('beta.t-c'), '…and not in 멈춤');
  for (const id of ids('beta.f', 'beta.g', 'beta.a')) assert.ok(!beta.stalled.includes(id), `${id}: dep-open / ready-idle / blocked-user never count`);
  // Oldest first by updated, ties by id; a board without a stuck report has nothing stalled.
  board(app, { stuck: { items: [...STUCK, { id: 'beta.t-d', goal: 'beta', reason: 'doing-stale', age_hours: 1 }] } });
  assert.deepEqual([...app.progressRow('beta').stalled], ids('beta.e', 'beta.d'));
  board(app, { stuck: null });
  assert.deepEqual([...app.progressRow('beta').stalled], []);
});

test('tap list holds exactly the counted ids', () => {
  const app = loadApp(); board(app);
  for (const r of app.progressRows()) {
    for (const kind of ['turn', 'doing', 'stalled']) {
      if (!r[kind]?.length) continue;
      app.S.prog = { app: r.app, kind };
      const html = app.progressSection();
      assert.match(html, new RegExp(`data-action="prog" data-id="${r.app}" data-key="${kind}"[^>]*aria-expanded="true"`));
      assert.deepEqual(listIds(html, r.app), [...r[kind]], `${r.app} ${kind}`);
    }
  }
  // Only one list is open: the other row's list is empty.
  app.S.prog = { app: 'beta', kind: 'turn' };
  assert.deepEqual(listIds(app.progressSection(), 'gamma'), []);
  // An open list whose project is gone, or that became empty, closes.
  app.S.prog = { app: 'gone', kind: 'turn' }; app.progressSection(); assert.equal(app.S.prog, null);
  app.S.prog = { app: 'gamma', kind: 'turn' }; app.progressSection(); assert.equal(app.S.prog, null);
});

test('zero counts are not buttons', () => {
  const app = loadApp(); board(app);
  const html = app.progressSection();
  for (const kind of ['turn', 'doing', 'stalled']) assert.doesNotMatch(html, new RegExp(`data-action="prog" data-id="one" data-key="${kind}"`), `one ${kind} = 0`);
  for (const kind of ['turn', 'doing', 'stalled']) assert.match(html, new RegExp(`<button type="button" class="pr-n" data-action="prog" data-id="beta" data-key="${kind}" aria-expanded="false" aria-controls="prog-list-beta" aria-label="[^"]+"`));
  // No goals at all: the empty state.
  board(app, { goals: [], rollup: { pct: 0, goals: [] } });
  assert.ok(app.progressSection().includes(app.DICT.ko['prog.none']));
});

test('important folder: open p0 cards in turn order, opened as report cards', () => {
  const app = loadApp(); board(app);
  const f = app.folderModel();
  assert.deepEqual(Object.keys(f), ['important']);
  assert.deepEqual([...f.important.ids], ids('beta.a', 'beta.g'), 'open p0 only (not the done or cancelled p0), turnOf order');
  assert.match(app.folderColumn(), /data-action="fold" data-key="important"/);
  // An open folder lists its cards as report cards that open the card panel.
  app.S.folders = new Set(['important']);
  assert.deepEqual([...app.folderColumn().matchAll(/data-action="select" data-id="([^"]+)"/g)].map((m) => m[1]), ids('beta.a', 'beta.g'));
});

test('report card: project, status, title, one line, quiet id; it opens the card panel', () => {
  const app = loadApp(); board(app);
  const x = app.S.data.tasks.find((y: any) => y.id === 'beta.t-a');
  const html = app.reportCard(x, 'Pick the launch name');
  assert.match(html, /^<button type="button" class="rcard[^"]*" data-action="select" data-id="beta\.t-a"/);
  assert.match(html, /Beta/); assert.match(html, /Pick the launch name/); assert.match(html, /beta\.t-a<\/span>/);
  // The 내 차례 list shows each card's first needs_user line.
  app.S.prog = { app: 'beta', kind: 'turn' };
  assert.match(app.progressSection(), /Pick the launch name</);
});

test('every progress i18n key exists in ko and en and app.js uses it', () => {
  const app = loadApp();
  const keys = ['prog.title', 'prog.turn', 'prog.doing', 'prog.stalled', 'prog.open', 'prog.list', 'prog.alldone', 'prog.nostage', 'prog.none',
    'prog.line.pr', 'prog.line.doing', 'prog.line.stalled', 'prog.line.updated',
    'fold.title', 'fold.important', 'fold.more', 'fold.close'];
  for (const k of keys) {
    assert.ok(app.DICT.ko[k]?.trim(), `ko ${k}`);
    assert.ok(app.DICT.en[k]?.trim(), `en ${k}`);
    assert.ok(APP.includes(`'${k}'`), `app.js uses ${k}`);
  }
});
