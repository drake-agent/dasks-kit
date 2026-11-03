// When a doing card counts as stale (public/app.js in a vm with a stub DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { task } from './helpers.ts';
import { stuckReport } from '../src/lib/stuck.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const DICT_SRC = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
const NOW = Date.parse('2026-10-23T12:00:00+09:00');
const H = 3600000;
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
  const names = ['S', 't', 'ago', 'isStale', 'isRunnerCard', 'missionCard', 'runningOrder', 'WORK'];
  // A missing helper becomes a function that fails by assertion, so each test fails on its own instead of the whole file.
  const app = vm.runInContext(`${APP}\n;({ ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? () => __missing('${n}') : ${n}`).join(', ')} })`, ctx);
  return { app, writes, DICT: vm.runInContext('DICT', ctx) };
}

const doing = (id: string, over: any = {}) => task({ id: `beta.t-${id}`, status: 'doing', updated: iso(NOW - H), ...over });
const RN = { claimed_by: 'runner@mini' };
const HUMAN = { claimed_by: 'human-claude@laptop' };

test('an edit-only bump does not un-stale a doing card', () => {
  const { app } = loadApp();
  assert.equal(app.isStale(doing('a', { started_at: iso(NOW - 30 * H), updated: iso(NOW - H) })), true, 'started 30 h ago, edited 1 h ago');
  assert.equal(app.isStale(doing('b', { started_at: iso(NOW - 147 * H), claimed_at: iso(NOW - 100 * H), updated: iso(NOW - 2 * 60000) })), true, '147 h card bumped 2 min ago');
});

test('a recent start claim or heartbeat keeps a doing card live', () => {
  const { app } = loadApp();
  assert.equal(app.isStale(doing('a', { started_at: iso(NOW - 2 * H), updated: iso(NOW - 2 * H) })), false, 'started 2 h ago');
  assert.equal(app.isStale(doing('b', { started_at: iso(NOW - 50 * H), claim_seen: iso(NOW - H), updated: iso(NOW - 50 * H) })), false, 'claim heartbeat 1 h ago');
  assert.equal(app.isStale(doing('c', { started_at: iso(NOW - 50 * H), claimed_at: iso(NOW - 3 * H), updated: iso(NOW - 50 * H) })), false, 'claimed 3 h ago');
});

test('a doing card without start or claim times falls back to updated', () => {
  const { app } = loadApp();
  assert.equal(app.isStale(doing('a', { updated: iso(NOW - 25 * H) })), true);
  assert.equal(app.isStale(doing('b', { updated: iso(NOW - 23 * H) })), false);
  assert.equal(app.isStale(task({ id: 'beta.t-r', status: 'review', updated: iso(NOW - 99 * H) })), false, 'only doing cards are stale');
});

test('the stalled mission card counts from the last sign of life', () => {
  const { app } = loadApp();
  const x = doing('a', { started_at: iso(NOW - 72 * H), claim_seen: iso(NOW - 30 * H), updated: iso(NOW - 60000) });
  const html = app.missionCard(x, true);
  assert.match(html, /data-stale="true"/);
  assert.ok(html.includes(app.t('stalled.since', { t: app.ago(iso(NOW - 30 * H)) })), 'stalled since the claim heartbeat (30 h)');
  assert.ok(!html.includes(app.t('stalled.since', { t: app.ago(iso(NOW - 60000)) })), 'never since the last field edit');
});

test('isRunnerCard reads the claim holder', () => {
  const { app } = loadApp();
  assert.equal(app.isRunnerCard(doing('a', RN)), true, 'the runner holds it');
  assert.equal(app.isRunnerCard(doing('c', HUMAN)), false, 'a human session holds it');
  assert.equal(app.isRunnerCard(doing('d')), false, 'no claim');
});

test('a runner card shows the runner working on its mission card', () => {
  const { app } = loadApp();
  const html = app.missionCard(doing('a', { ...RN, started_at: iso(NOW - 46 * H) }), true);
  assert.ok(html.includes(app.t('runner.running')), 'runner label');
  assert.match(html, /data-state="running"/);
  assert.ok(!html.includes('data-stale="true"'), 'not dimmed as stalled');
  assert.ok(!html.includes(app.t('doing.for', { t: app.ago(iso(NOW - 46 * H)) })), 'not shown as running');
});

test('a runner card shows the runner working on the kanban', () => {
  const { app } = loadApp();
  app.S.data = { tasks: [], goals: [], links: [], northstar: { title: '', why: '', horizon: '' }, rollup: { pct: 0, goals: [] } };
  const html = app.WORK.kanban([doing('rn', { ...RN, started_at: iso(NOW - 46 * H) }), doing('old', { started_at: iso(NOW - 46 * H) })], 6);
  const card = (id: string) => (html.match(new RegExp(`<div class="ds-kanban-card[^"]*" data-action="select" data-id="beta.t-${id}"[^>]*>[\\s\\S]*?</div>`)) || [''])[0];
  assert.ok(card('rn').includes(app.t('runner.running')), 'runner card meta');
  assert.ok(!card('rn').includes(' stale"'), 'runner card not dimmed');
  assert.ok(card('old').includes(app.t('stalled')), 'the other 46 h card is stalled');
});

test('runner label exists in both languages', () => {
  const { DICT } = loadApp();
  assert.equal(typeof DICT.ko['runner.running'], 'string');
  assert.equal(typeof DICT.en['runner.running'], 'string');
  assert.notEqual(DICT.ko['runner.running'], DICT.en['runner.running']);
});

test('stuck doing-stale age ignores field edits', () => {
  const r = stuckReport({ tasks: [doing('a', { started_at: iso(NOW - 30 * H), updated: iso(NOW - H) }), doing('b', { started_at: iso(NOW - 30 * H), claim_seen: iso(NOW - H), updated: iso(NOW - 30 * H) })] }, new Date(NOW));
  const a = r.items.find((x) => x.id === 'beta.t-a');
  assert.equal(a?.reason, 'doing-stale');
  assert.equal(a?.age_hours, 30);
  assert.equal(r.items.find((x) => x.id === 'beta.t-b'), undefined, 'heartbeat 1 h ago: not stuck');
});

test('stuck keeps updated age for doing cards without start or claim times and for review', () => {
  const r = stuckReport({ tasks: [doing('a', { updated: iso(NOW - 7 * H) }), task({ id: 'beta.t-r', status: 'review', started_at: iso(NOW - H), updated: iso(NOW - 30 * H) })] }, new Date(NOW));
  assert.equal(r.items.find((x) => x.id === 'beta.t-a')?.age_hours, 7);
  const rv = r.items.find((x) => x.id === 'beta.t-r');
  assert.equal(rv?.reason, 'review-stale'); assert.equal(rv?.age_hours, 30);
});

test('running order puts stale cards last by their real age', () => {
  const { app } = loadApp();
  const xs = [doing('stale', { started_at: iso(NOW - 40 * H), updated: iso(NOW - 60000) }), doing('fresh', { started_at: iso(NOW - 3 * H), updated: iso(NOW - 3 * H) })];
  assert.deepEqual(JSON.parse(JSON.stringify([...xs].sort(app.runningOrder).map((x: any) => x.id))), ['beta.t-fresh', 'beta.t-stale']);
});
