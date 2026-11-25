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

/** app.js in a sandbox, page language ko; `fetched` lists every fetch URL, `sources` every EventSource. */
function loadApp(answer: (u: string) => Promise<unknown> = () => new Promise(() => {})) {
  const fetched: string[] = [], sources: any[] = [];
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
    fetch: (u: string) => { fetched.push(String(u)); return answer(String(u)); },
    EventSource: class { on: Record<string, (e: any) => void> = {}; constructor() { sources.push(this); } addEventListener(k: string, f: (e: any) => void) { this.on[k] = f; } },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ transitionDuration: '0s', transitionDelay: '0s' }),
    Date: Object.assign(function (...a: any[]) { return a.length ? new (Date as any)(...a) : new Date(NOW); }, { now: () => NOW, parse: Date.parse, UTC: Date.UTC }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(DICT_SRC, ctx);
  vm.runInContext(`${APP}\n;globalThis.__live = liveHtml; globalThis.__connect = connect; globalThis.__S = S; globalThis.__fill = fillLive; globalThis.__LIVES = LIVES;`, ctx);
  return { liveHtml: ctx.__live as (v: unknown) => string, DICT: vm.runInContext('DICT', ctx), connect: ctx.__connect as () => void, S: ctx.__S, fetched, sources, fillLive: ctx.__fill as (id: string) => Promise<void>, LIVES: ctx.__LIVES as Map<string, any> };
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

test('a reconnect reads the open card live window again (a live update does not move the board version)', () => {
  const { connect, S, fetched, sources } = loadApp();
  S.data = { version: 3, tasks: [{ id: 'beta.t-a', goal: 'beta', status: 'doing' }], goals: [] };
  S.selected = 'beta.t-a';
  connect();
  const es = sources.at(-1);
  es.on.hello({ data: JSON.stringify({ boot: 'b1', version: 3 }) });
  assert.ok(fetched.includes('/api/tasks/beta.t-a/live'), fetched.join(' '));
  fetched.length = 0;
  S.selected = 'beta';
  es.on.hello({ data: JSON.stringify({ boot: 'b1', version: 3 }) });
  assert.ok(!fetched.some((u) => u.endsWith('/live')), 'a goal panel reads no live window');
});

test('a slower, older read never paints over a newer one', async () => {
  const waits: ((v: unknown) => void)[] = [];
  const reply = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
  const { fillLive, LIVES } = loadApp((u) => new Promise((r) => { if (u.endsWith('/live')) waits.push(r); }));
  const older = fillLive('beta.t-a');   // e.g. the read after a reconnect
  const newer = fillLive('beta.t-a');   // the read after a live event
  waits[1](reply({ ...WIN, seq: 9, phase: 'reviewing', ended: true }));
  await newer;
  waits[0](reply({ ...WIN, seq: 5, phase: 'building' }));
  await older;
  assert.equal(LIVES.get('beta.t-a').seq, 9);
  assert.equal(LIVES.get('beta.t-a').ended, true);
  // A new run after the shown one ended is taken even with a lower seq (another machine's clock).
  const next = fillLive('beta.t-a');
  waits[2](reply({ ...WIN, run_id: 'r2', seq: 3 }));
  await next;
  assert.equal(LIVES.get('beta.t-a').run_id, 'r2');
});
