// Day / night / auto theme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PUB = path.resolve(import.meta.dirname, '../public');
const BOOT = path.join(PUB, 'theme-boot.js');

type Opts = { stored?: string | null; hash?: string; osDark?: boolean; getThrows?: boolean; setThrows?: boolean };

/** Runs theme-boot.js once in a fresh fake browser and hands back the pieces a test looks at. */
function boot(o: Opts = {}) {
  const store = new Map<string, string>();
  if (o.stored != null) store.set('dasks-theme', o.stored);
  const localStorage = {
    getItem(k: string) { if (o.getThrows) throw new Error('SecurityError'); return store.has(k) ? store.get(k)! : null; },
    setItem(k: string, v: string) { if (o.setThrows) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem(k: string) { store.delete(k); },
  };
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const mql = {
    media: '(prefers-color-scheme: dark)',
    matches: !!o.osDark,
    addEventListener(type: string, fn: (e: { matches: boolean }) => void) { if (type === 'change') listeners.push(fn); },
    removeEventListener() {},
    addListener(fn: (e: { matches: boolean }) => void) { listeners.push(fn); },
    removeListener() {},
  };
  const events: Array<{ type: string; detail: unknown }> = [];
  const dataset: Record<string, string> = {};
  const document = {
    body: { dataset },
    documentElement: { dataset: {} },
    addEventListener() {},
    dispatchEvent(e: { type: string; detail: unknown }) { events.push({ type: e.type, detail: e.detail }); return true; },
  };
  class CustomEvent { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } }
  const queries: string[] = [];
  const ctx: Record<string, unknown> = {
    document, localStorage, CustomEvent, Event: CustomEvent,
    location: { hash: o.hash ?? '', search: '', pathname: '/' },
    matchMedia(q: string) { queries.push(q); return mql; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BOOT, 'utf8'), ctx, { filename: 'theme-boot.js' });
  const fire = (dark: boolean) => { mql.matches = dark; for (const fn of listeners) fn({ matches: dark }); };
  const api = (ctx.window as any).dasksTheme as { get(): { choice: string; mode: string }; set(c: unknown): boolean };
  return { api, dataset, store, events, fire, listeners, queries };
}

test('no choice means dark', () => {
  const b = boot({ osDark: false });
  assert.equal(b.dataset.mode, 'dark');
  assert.equal(b.dataset.themeChoice, 'dark');
  assert.deepEqual({ ...b.api.get() }, { choice: 'dark', mode: 'dark' });
  assert.equal(b.store.has('dasks-theme'), false, 'boot never writes storage');
  assert.equal(b.events.length, 0, 'no event at boot');
});

test('stored light and dark apply', () => {
  const l = boot({ stored: 'light', osDark: true });
  assert.equal(l.dataset.mode, 'light'); assert.equal(l.dataset.themeChoice, 'light');
  const d = boot({ stored: 'dark', osDark: false });
  assert.equal(d.dataset.mode, 'dark'); assert.equal(d.dataset.themeChoice, 'dark');
});

test('bad stored value means dark', () => {
  const b = boot({ stored: 'blue', osDark: false });
  assert.equal(b.dataset.themeChoice, 'dark');
  assert.equal(b.dataset.mode, 'dark');
  assert.equal(b.store.get('dasks-theme'), 'blue', 'boot leaves an invalid value as it is');
});

test('storage that throws means dark', () => {
  const b = boot({ getThrows: true, osDark: false });
  assert.equal(b.dataset.themeChoice, 'dark');
  assert.equal(b.dataset.mode, 'dark');
  const s = boot({ stored: 'light', setThrows: true, osDark: false });
  assert.equal(s.dataset.mode, 'light');
  assert.equal(s.api.set('dark'), true);
  assert.equal(s.dataset.mode, 'dark');
  assert.equal(s.api.get().choice, 'dark');
});

test('hash #light and #dark override and are not saved', () => {
  const b = boot({ stored: 'light', hash: '#dark', osDark: false });
  assert.equal(b.dataset.mode, 'dark');
  assert.equal(b.store.get('dasks-theme'), 'light');
  const c = boot({ stored: 'dark', hash: '#light', osDark: true });
  assert.equal(c.dataset.mode, 'light');
  assert.equal(c.store.get('dasks-theme'), 'dark');
  const e = boot({ hash: '#light', osDark: true });
  assert.equal(e.dataset.mode, 'light');
  assert.equal(e.store.has('dasks-theme'), false);
});

test('SPA hash is ignored', () => {
  const b = boot({ stored: 'dark', hash: '#/control', osDark: false });
  assert.equal(b.dataset.mode, 'dark');
  assert.equal(b.dataset.themeChoice, 'dark');
  const l = boot({ stored: 'light', hash: '#lightx', osDark: true });
  assert.equal(l.dataset.mode, 'light');
});

test('auto follows the media query change', () => {
  const a = boot({ stored: 'auto', osDark: false });
  assert.ok(a.queries.includes('(prefers-color-scheme: dark)'));
  assert.equal(a.dataset.themeChoice, 'auto');
  assert.equal(a.dataset.mode, 'light');
  a.fire(true);
  assert.equal(a.dataset.mode, 'dark');
  a.fire(false);
  assert.equal(a.dataset.mode, 'light');
  assert.equal(a.events.length, 0, 'an OS change sends no event');
  const l = boot({ stored: 'light', osDark: false });
  l.fire(true);
  assert.equal(l.dataset.mode, 'light');
  assert.equal(l.listeners.length, 1, 'one change listener');
});

test('set validates, saves, applies and emits', () => {
  const b = boot({ osDark: false });
  for (const bad of ['x', '', 'Light', null, undefined, 1]) assert.equal(b.api.set(bad), false, String(bad));
  assert.equal(b.store.has('dasks-theme'), false);
  assert.equal(b.dataset.mode, 'dark');
  assert.equal(b.events.length, 0);
  assert.equal(b.api.set('light'), true);
  assert.equal(b.store.get('dasks-theme'), 'light');
  assert.equal(b.dataset.mode, 'light');
  assert.equal(b.dataset.themeChoice, 'light');
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].type, 'dasks-theme');
  assert.deepEqual({ ...(b.events[0].detail as object) }, { choice: 'light', mode: 'light' });
  // set wins over a hash override for the rest of the page's life
  const h = boot({ hash: '#dark', osDark: true });
  assert.equal(h.api.set('auto'), true);
  assert.deepEqual({ ...h.api.get() }, { choice: 'auto', mode: 'dark' });
  h.fire(false);
  assert.equal(h.dataset.mode, 'light');
});

test('boot script is the first body child on both pages', () => {
  for (const f of ['index.html', 'asks.html']) {
    const html = fs.readFileSync(path.join(PUB, f), 'utf8');
    const m = html.match(/<body([^>]*)>\s*(<[^>]+>(?:<\/script>)?)/);
    assert.ok(m, `${f}: <body>`);
    assert.equal(m![2], '<script src="/theme-boot.js"></script>', `${f}: first body child`);
    assert.doesNotMatch(m![1], /data-mode/, `${f}: body has no data-mode`);
    assert.match(m![1], /data-theme="dasks" data-variant="metal"/, `${f}: theme kept`);
  }
});
