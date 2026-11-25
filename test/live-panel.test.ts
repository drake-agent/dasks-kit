// The card panel's live window (public/app.js liveHtml in a vm with a stub DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const DICT_SRC = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
const NOW = Date.parse('2026-10-23T12:00:00+09:00');

/** app.js in a sandbox, page language ko. */
function loadApp() {
  const el = (): any => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, {
    get(t: any, k) { if (k in t) return t[k]; if (k === 'querySelectorAll') return () => []; if (k === 'querySelector' || k === 'closest') return () => null; return typeof k === 'string' && /^(add|remove|set|get|focus|blur|scroll|contains|matches|append)/.test(k) ? () => null : undefined; },
    set(t, k, v) { t[k] = v; return true; },
  });
  const document = { documentElement: el(), body: el(), hidden: false, activeElement: null, querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const ctx: any = {
    document, window: { innerWidth: 1440, scrollY: 0, scrollTo() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { pathname: '/', search: '?lang=ko', hash: '', href: 'http://x/' }, history: { ['replace' + 'State']() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CSS: { escape: (s: string) => s }, URLSearchParams, URL, console,
    fetch: () => new Promise(() => {}), EventSource: class {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ transitionDuration: '0s', transitionDelay: '0s' }),
    Date: Object.assign(function (...a: any[]) { return a.length ? new (Date as any)(...a) : new Date(NOW); }, { now: () => NOW, parse: Date.parse, UTC: Date.UTC }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(DICT_SRC, ctx);
  vm.runInContext(`${APP}\n;globalThis.__live = liveHtml;`, ctx);
  return { liveHtml: ctx.__live as (v: unknown) => string, DICT: vm.runInContext('DICT', ctx) };
}

const WIN = {
  card: 'beta.t-a', run_id: 'r1', actor: 'runner@m', phase: 'building', updated_at: new Date(NOW - 60_000).toISOString(), ended: false,
  steps: Array.from({ length: 10 }, (_, i) => ({ at: `2026-10-23T03:0${i}:00Z`, kind: 'tool', text: `step ${i} <b>` })),
  files: [{ path: 'src/a.ts', status: 'M', added: 2, deleted: 1 }],
  diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new', diff_truncated: true,
};

test('nothing is drawn without live data', () => {
  const { liveHtml } = loadApp();
  assert.equal(liveHtml(undefined), '');
  assert.equal(liveHtml({ ...WIN, run_id: null, steps: [] }), '');
});

test('steps newest first (8 at most, escaped), phase, files, a coloured diff and the cut note', () => {
  const { liveHtml } = loadApp();
  const h = liveHtml(WIN);
  assert.match(h, /data-qv="live"/);
  assert.ok(h.includes('만드는 중'), 'phase in the page language (ko)');
  assert.ok(h.indexOf('step 9') < h.indexOf('step 8'), 'newest first');
  assert.ok(!h.includes('step 1 '), 'only the newest 8');
  assert.ok(h.includes('step 9 &lt;b&gt;') && !h.includes('step 9 <b>'), 'escaped');
  assert.match(h, /바뀐 파일 \(1\)/);
  assert.match(h, /<span class="lv-add">\+new<\/span>/);
  assert.match(h, /<span class="lv-del">-old<\/span>/);
  assert.match(h, /<span>--- a\/src\/a\.ts<\/span>/, 'file header lines are not coloured as removals');
  assert.ok(h.includes('변경 내용 일부만 보여요'));
  assert.ok(liveHtml({ ...WIN, ended: true }).includes('마지막 상태'), 'an ended run says it shows the last state');
});

test('every live string exists in both languages', () => {
  const { DICT } = loadApp();
  const keys = (l: string) => Object.keys(DICT[l]).filter((k) => k.startsWith('qv.live')).sort();
  assert.deepEqual(keys('ko'), keys('en'));
  assert.equal(keys('en').length, 7);
});
