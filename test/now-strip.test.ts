// Project page Now strip and new-since-last-look marks (public/app.js in a vm with a stub DOM).
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

function loadApp(storage: { getItem(k: string): string | null; setItem(k: string, v: string): void }) {
  const el = (): any => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, {
    get(t: any, k) { if (k in t) return t[k]; if (k === 'querySelectorAll') return () => []; if (k === 'querySelector' || k === 'closest') return () => null; return typeof k === 'string' && /^(add|remove|set|get|focus|blur|scroll|contains|matches|append)/.test(k) ? () => null : undefined; },
    set(t, k, v) { t[k] = v; return true; },
  });
  const document = { documentElement: el(), body: el(), hidden: false, activeElement: null, querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const ctx: any = {
    document, window: { innerWidth: 1440, scrollY: 0, scrollTo() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { pathname: '/p/beta', search: '', hash: '', href: 'http://x/p/beta' }, history: { ['replace' + 'State']() {} },
    localStorage: storage, CSS: { escape: (s: string) => s }, URLSearchParams, URL, console,
    fetch: () => new Promise(() => {}), EventSource: class {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ transitionDuration: '0s', transitionDelay: '0s' }),
    Date: Object.assign(function (...a: any[]) { return a.length ? new (Date as any)(...a) : new Date(NOW); }, { now: () => NOW, parse: Date.parse, UTC: Date.UTC }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(DICT_SRC, ctx);
  const names = ['S', 'nowItems', 'nowStrip', 'isNewSince', 'newMark', 'seenCard', 'SEEN'];
  return vm.runInContext(`${APP}\n;({ ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? () => { throw new Error('${n} is not defined in app.js'); } : ${n}`).join(', ')} })`, ctx);
}
const mem = (init: Record<string, string> = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m }; };
const iso = (ms: number) => new Date(ms).toISOString();
const goal = { id: 'beta', milestones: [
  { id: 'beta.m1', due: '2026-10-22', status: 'active' }, { id: 'beta.m2', due: '2026-10-24', status: 'active' },
  { id: 'beta.m3', due: '2026-11-30', status: 'planned' }, { id: 'beta.m4', due: '2026-10-01', status: 'done' },
] };
const T = (id: string, status: string, milestone: string, updatedMs = NOW - 48 * HOUR, priority = 'p2') =>
  task({ id: `beta.t-${id}`, goal: 'beta', status, milestone, priority, updated: iso(updatedMs) } as any);

test('Now strip: blocked first, then overdue (oldest due first), then due today; done, cancelled and later cards stay out', () => {
  const app = loadApp(mem());
  const tasks = [
    T('later', 'todo', 'beta.m3'), T('today', 'review', 'beta.m2'), T('late-p2', 'todo', 'beta.m1'), T('late-p0', 'doing', 'beta.m1', undefined, 'p0'),
    T('blocked', 'blocked-on-user', 'beta.m3'), T('done', 'done', 'beta.m1'), T('cancel', 'cancelled', 'beta.m2'), T('old-ms-done', 'todo', 'beta.m4'),
  ];
  const got = app.nowItems(tasks, goal).map((i: any) => `${i.why}:${i.x.id.replace('beta.t-', '')}`);
  assert.equal(got.join(' '), 'blocked:blocked overdue:late-p0 overdue:late-p2 today:today');
});

test('Now strip: a blocked card in a late milestone counts once, as blocked', () => {
  const app = loadApp(mem());
  const got = app.nowItems([T('b', 'blocked-on-user', 'beta.m1')], goal);
  assert.equal(got.length, 1); assert.equal(got[0].why, 'blocked');
});

test('Now strip: nothing urgent draws a quiet one-line strip; each item opens its card', () => {
  const app = loadApp(mem());
  assert.match(app.nowStrip([T('later', 'todo', 'beta.m3')], goal), /class="pnow quiet"/);
  const html = app.nowStrip([T('today', 'review', 'beta.m2')], goal);
  assert.match(html, /data-action="select" data-id="beta\.t-today"/);
});

test('new marks: only cards updated after the stored last look; a first visit marks nothing and stores a baseline', () => {
  const seen = NOW - 2 * HOUR;
  const app = loadApp(mem({ 'dasks.seen.beta': String(seen) }));
  assert.equal(app.isNewSince(T('moved', 'doing', 'beta.m3', NOW - HOUR)), true);
  assert.equal(app.isNewSince(T('still', 'doing', 'beta.m3', NOW - 3 * HOUR)), false);
  assert.match(app.newMark(T('moved', 'doing', 'beta.m3', NOW - HOUR)), /class="newmark"/);
  // Opening a card is looking at it, until it moves again.
  app.S.data = { tasks: [T('moved', 'doing', 'beta.m3', NOW - HOUR)] };
  app.seenCard('beta.t-moved');
  assert.equal(app.isNewSince(T('moved', 'doing', 'beta.m3', NOW - HOUR)), false);
  assert.equal(app.isNewSince(T('moved', 'review', 'beta.m3', NOW - HOUR / 2)), true);

  const store = mem();
  const fresh = loadApp(store);
  assert.equal(fresh.isNewSince(T('moved', 'doing', 'beta.m3', NOW - HOUR)), false);
  assert.equal(store.m.get('dasks.seen.beta'), String(NOW));
});

test('new marks: a localStorage that throws loads the page and marks nothing', () => {
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const app = loadApp(boom);
  assert.equal(app.isNewSince(T('moved', 'doing', 'beta.m3', NOW - HOUR)), false);
  assert.ok(app.nowStrip([T('b', 'blocked-on-user', 'beta.m3')], goal).includes('nowrow'));
});

test('no new server writes: the Now strip / marks block calls no api() and writes no task', () => {
  const start = APP.indexOf('// ---------- project page: the Now strip');
  const end = APP.indexOf('// Default headings for widgets that always appear');
  assert.ok(start > 0 && end > start);
  const block = APP.slice(start, end);
  assert.doesNotMatch(block, /\bapi\(|writeTask\(|fetch\(|method:/);
});
