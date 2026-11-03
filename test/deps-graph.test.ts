// Dependency graph on project pages (public/app.js in a vm with a stub DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { task } from './helpers.ts';
import { validateView } from '../src/lib/views.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const DICT_SRC = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');

/** app.js on /p/beta in a sandbox; #main reports `mainWidth` px with 12px padding a side. */
function loadApp(mainWidth: number) {
  const el = (): any => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, {
    get(t: any, k) { if (k in t) return t[k]; if (k === 'querySelectorAll') return () => []; if (k === 'querySelector' || k === 'closest') return () => null; return typeof k === 'string' && /^(add|remove|set|get|focus|blur|scroll|contains|matches|append)/.test(k) ? () => null : undefined; },
    set(t, k, v) { t[k] = v; return true; },
  });
  const main = Object.assign(el(), { clientWidth: mainWidth });
  const document = { documentElement: el(), body: el(), hidden: false, activeElement: null, querySelector: (s: string) => (s === '#main' ? main : el()), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const ctx: any = {
    document, window: { innerWidth: mainWidth, scrollY: 0, scrollTo() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), getComputedStyle: () => ({ paddingLeft: '12px', paddingRight: '12px' }) },
    location: { pathname: '/p/beta', search: '?lang=ko', hash: '', href: 'http://x/p/beta' }, history: { ['replace' + 'State']() {} },
    localStorage: { getItem: () => null, setItem() {} }, CSS: { escape: (s: string) => s }, URLSearchParams, URL, console,
    fetch: () => new Promise(() => {}), EventSource: class {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ transitionDuration: '0s', transitionDelay: '0s' }), Date,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(DICT_SRC, ctx);
  const names = ['S', 'depGraph', 'depLayout', 'depView', 'viewProject'];
  return vm.runInContext(`${APP}\n;({ ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? () => { throw new Error('${n} is not defined in app.js'); } : ${n}`).join(', ')} })`, ctx);
}
const setBoard = (app: any, tasks: any[]) => {
  app.S.data = { tasks, goals: [{ id: 'beta', title: 'Beta', milestones: [{ id: 'beta.m1', title: 'M1', done_criteria: [] }] }, { id: 'delta', title: 'Delta', milestones: [] }], rollup: { goals: [], pct: 0 }, links: [], northstar: { title: 'North Star' } };
  app.S.pview = { widgets: [{ type: 'work' }], structure: 'list', version: 0, default: true };
};
const T = (id: string, status: string, depends_on = '', priority = 'p2') => ({ ...task({ id, status: status as any, priority: priority as any }), depends_on });

// a → b → c → d is the long chain; e waits on a done card, a missing id and a; f waits on another project's open card.
const BOARD = [
  T('beta.t-a', 'doing'), T('beta.t-b', 'todo', 'beta.t-a'), T('beta.t-c', 'todo', 'beta.t-b'), T('beta.t-d', 'review', 'beta.t-c # note'),
  T('beta.t-old', 'done'), T('beta.t-e', 'todo', 'beta.t-old, beta.t-ghost, beta.t-a'), T('beta.t-f', 'todo', 'delta.t-x'),
  T('delta.t-x', 'todo'), T('beta.t-lone', 'todo', 'none'), T('beta.t-shut', 'done', 'beta.t-a'),
];

test('graph: open cards that wait, what they wait on, the longest open chain first-to-last', () => {
  const app = loadApp(1200); setBoard(app, BOARD);
  const g = app.depGraph(app.S.data.tasks.filter((x: any) => x.goal === 'beta'));
  assert.deepEqual([...g.chain], ['beta.t-a', 'beta.t-b', 'beta.t-c', 'beta.t-d']);
  const ids = [...g.nodes.keys()].sort();
  // done cards appear only as something an open card waits on; cards with no deps and no open dependents stay out.
  assert.deepEqual(ids, ['beta.t-a', 'beta.t-b', 'beta.t-c', 'beta.t-d', 'beta.t-e', 'beta.t-f', 'beta.t-ghost', 'beta.t-old', 'delta.t-x']);
  assert.equal(g.nodes.get('beta.t-ghost').task, null);
  assert.equal(g.nodes.get('beta.t-d').layer, 3);
  assert.equal(g.nodes.get('beta.t-e').layer, 1);
  assert.equal(g.cut.size, 0);
});

test('graph: a cycle is cut (dashed), never a crash; a self-dep is ignored; no open chain = none highlighted', () => {
  const app = loadApp(1200);
  setBoard(app, [T('beta.t-p', 'todo', 'beta.t-q'), T('beta.t-q', 'todo', 'beta.t-r'), T('beta.t-r', 'todo', 'beta.t-p, beta.t-r')]);
  const g = app.depGraph(app.S.data.tasks);
  assert.equal(g.cut.size, 1);
  assert.equal(g.chain.length, 3);
  assert.ok(app.depView(g, {}).includes('class="cut'));
  setBoard(app, [T('beta.t-u', 'todo', 'beta.t-gone'), T('beta.t-v', 'todo', 'beta.t-done'), T('beta.t-done', 'done')]);
  const g2 = app.depGraph(app.S.data.tasks);
  assert.equal(g2.chain.length, 0);
  const html = app.depView(g2, {});
  assert.ok(!html.includes(' crit'), 'nothing on a chain');
  assert.match(html, /dg-node missing[^>]*title="beta\.t-gone"/);
  assert.match(html, /dg-node st-done finished/);
});

test('view: missing node is not clickable, open nodes open their card, chain marked, tab order follows the picture', () => {
  const app = loadApp(1200); setBoard(app, BOARD);
  const html = app.depView(app.depGraph(app.S.data.tasks.filter((x: any) => x.goal === 'beta')), {});
  assert.match(html, /<div class="dg-node missing"/);
  assert.ok(!/dg-node missing[^>]*data-action/.test(html));
  for (const id of ['beta.t-a', 'beta.t-b', 'beta.t-c', 'beta.t-d']) assert.match(html, new RegExp(`class="dg-node st-[a-z-]+ open crit"[^>]*data-id="${id}"`));
  assert.match(html, /class="dg-node st-todo other"[^>]*data-id="delta\.t-x"/);
  assert.match(html, /가장 긴 남은 사슬 4개/);
  const order = [...html.matchAll(/class="dg-node[^"]*"[^>]*?(?:data-id|title)="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(order[0], 'beta.t-a'); // first band, the chain first
  assert.equal(order.at(-1), 'beta.t-d');
});

test('layout: no two nodes overlap and the canvas fits its frame, at 430px and at desktop', () => {
  const many = [T('beta.t-root', 'todo'), ...Array.from({ length: 9 }, (_, i) => T(`beta.t-n${i}`, 'todo', 'beta.t-root'))];
  for (const width of [390, 430, 1440]) {
    const app = loadApp(width); setBoard(app, many);
    const g = app.depGraph(app.S.data.tasks);
    const avail = width - 24 - 42;
    const L = app.depLayout(g, avail);
    assert.ok(L.width <= avail, `${width}: ${L.width} <= ${avail}`);
    const boxes = [...L.pos.values()];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      assert.ok(a.x + L.w <= b.x || b.x + L.w <= a.x || a.y + L.h <= b.y || b.y + L.h <= a.y, `${width}: overlap`);
    }
    if (width < 560) assert.ok(L.w >= 140, 'phone nodes stay readable');
    // depView uses #main's width the same way.
    assert.match(app.depView(g, {}), new RegExp(`class="dg-canvas"[^>]*style="width:${L.width}px`));
  }
});

test('edges never pass behind a card: one root, 6 and 9 waiting cards at 390px and 1440px', () => {
  for (const [width, n] of [[390, 6], [390, 9], [1440, 9]] as const) {
    const many = [T('beta.t-root', 'todo'), ...Array.from({ length: n }, (_, i) => T(`beta.t-n${i}`, 'todo', 'beta.t-root')), T('beta.t-leaf', 'todo', `beta.t-n${n - 1}`)];
    const app = loadApp(width); setBoard(app, many);
    const g = app.depGraph(app.S.data.tasks);
    const L = app.depLayout(g, width - 24 - 42);
    const html = app.depView(g, {});
    // Each edge path is M x y then C (one hop between neighbouring rows) or V/H steps; sample it and test every node rectangle.
    const paths = [...html.matchAll(/<path class="[^"]*" d="(M[^"]+)"\/>(?=<path class="tip)/g)].map((m) => m[1]);
    assert.equal(paths.length, g.edges.length);
    const boxes = [...L.pos.entries()].map(([id, p]: any) => ({ id, ...p }));
    for (const d of paths) {
      const pts: [number, number][] = [];
      let [x, y] = d.slice(1).split(/[CVH]/)[0].trim().split(/\s+/).map(Number);
      pts.push([x, y]);
      for (const m of d.matchAll(/([VHC])([^VHC]+)/g)) {
        const v = m[2].trim().split(/\s+/).map(Number);
        if (m[1] === 'V') y = v[0]; else if (m[1] === 'H') x = v[0]; else { x = v[4]; y = v[5]; }
        const [px, py] = pts.at(-1)!;
        for (let k = 1; k <= 20; k++) pts.push([px + ((x - px) * k) / 20, py + ((y - py) * k) / 20]);
      }
      for (const b of boxes) for (const [px, py] of pts) {
        const inside = px > b.x + 1 && px < b.x + L.w - 1 && py > b.y + 1 && py < b.y + L.h - 1;
        assert.ok(!inside, `${width}/${n}: ${d} passes behind ${b.id}`);
      }
    }
  }
});

test('half-width widget sizes the graph to its column above 760px', () => {
  const many = [T('beta.t-root', 'todo'), ...Array.from({ length: 6 }, (_, i) => T(`beta.t-n${i}`, 'todo', 'beta.t-root'))];
  const app = loadApp(1440); setBoard(app, many);
  const g = app.depGraph(app.S.data.tasks);
  const width = (w: any) => Number(/class="dg-canvas"[^>]*style="width:(\d+)px/.exec(app.depView(g, w))![1]);
  const column = (1440 - 24 - 16) / 2 - 42;
  assert.ok(width({ span: 'half' }) <= column, `${width({ span: 'half' })} <= ${column}`);
  assert.ok(width({}) > column);
});

test('project page: the graph comes right after the tasks; hidden when no card links; a placed one says so', () => {
  const app = loadApp(1200); setBoard(app, BOARD);
  const page = app.viewProject();
  const work = page.indexOf('pw-work'), deps = page.indexOf('pw-deps'), ideas = page.indexOf('pw-ideas');
  assert.ok(work >= 0 && work < deps && deps < ideas, 'work, deps, ideas');
  setBoard(app, [T('beta.t-a', 'todo'), T('beta.t-b', 'todo', 'none')]);
  assert.ok(!app.viewProject().includes('pw-deps'), 'auto graph hidden');
  app.S.pview = { widgets: [{ type: 'deps' }], structure: 'list', version: 1 };
  assert.match(app.viewProject(), /pw-deps[\s\S]*카드 사이 의존이 없어요/);
});

test('deps is a widget agents can place; CSS keeps the graph inside its widget', () => {
  validateView('beta', { widgets: [{ type: 'deps', title: '의존' }] }, new Set(['beta.m1']));
  assert.throws(() => validateView('beta', { widgets: [{ type: 'deps', limit: 3 }] }, new Set(['beta.m1'])), /unknown field "limit"/);
  assert.match(CSS, /\.dg-wrap \{ overflow-x: auto;/);
  assert.match(CSS, /\.dg-node\.missing \{[^}]*dashed/);
});
