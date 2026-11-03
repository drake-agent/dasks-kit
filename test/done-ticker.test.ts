// Done ticker (public/done-ticker.js, a pure module kept out of agent surfaces).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: a browser module without types
import { doneTime, prRef, tickerItems, tickerShown, sinceOf, markAfter, TOP, FIRST_MS, WINDOW_MS } from '../public/done-ticker.js';
import { STATIC } from '../src/lib/server-static.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUB = path.join(ROOT, 'public');
const NOW = Date.parse('2026-11-02T12:00:00Z');
const H = 3600_000, D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();
const card = (id: string, status: string, doneAgo: number | null, over: Record<string, unknown> = {}) =>
  ({ id, title: id, status, updated: iso(NOW - (doneAgo ?? 0)), ...(doneAgo == null ? {} : { done_at: iso(NOW - doneAgo) }), ...over });
const ids = (items: { x: { id: string } }[]) => items.map((i) => i.x.id);

test('done time: done_at (the move to done), else updated', () => {
  assert.equal(doneTime({ done_at: iso(NOW - H), updated: iso(NOW) }), NOW - H);
  assert.equal(doneTime({ done_at: 'not a time', updated: iso(NOW - 2 * H) }), NOW - 2 * H);
  assert.equal(doneTime({ updated: iso(NOW - 3 * H) }), NOW - 3 * H);
  assert.ok(Number.isNaN(doneTime({})));
});

test('PR ref: a pull request URL or #N becomes #N; anything else none', () => {
  assert.equal(prRef('https://github.com/example/proj/pull/12'), '#12');
  assert.equal(prRef('https://github.com/example/proj/pull/230/files'), '#230');
  assert.equal(prRef('#7'), '#7');
  assert.equal(prRef('42'), '#42');
  assert.equal(prRef(''), '');
  assert.equal(prRef(undefined), '');
  assert.equal(prRef('https://example.com/x'), '');
});

test('first visit (no mark): only done cards from the last 24 h, newest first', () => {
  const tasks = [
    card('a', 'done', 2 * H), card('b', 'done', 30 * 60_000), card('c', 'done', 23 * H), card('old', 'done', 25 * H),
    card('rev', 'review', H), card('doing', 'doing', H), card('x', 'cancelled', H),
  ];
  assert.deepEqual(ids(tickerItems(tasks, NOW, 0)), ['b', 'a', 'c']);
  assert.equal(sinceOf(NOW, 0), NOW - FIRST_MS);
  assert.equal(sinceOf(NOW, NaN), NOW - FIRST_MS);
});

test('a mark shows only cards done after it; capped at 7 days however old the mark is', () => {
  const tasks = [card('new', 'done', H), card('at-mark', 'done', 5 * H), card('before', 'done', 6 * H), card('d6', 'done', 6 * D), card('d8', 'done', 8 * D)];
  assert.deepEqual(ids(tickerItems(tasks, NOW, NOW - 5 * H)), ['new'], 'strictly after the mark');
  assert.deepEqual(ids(tickerItems(tasks, NOW, NOW - 30 * D)), ['new', 'at-mark', 'before', 'd6'], '7-day cap');
  assert.equal(sinceOf(NOW, NOW - 30 * D), NOW - WINDOW_MS);
  assert.equal(sinceOf(NOW, NOW - 2 * D), NOW - 2 * D);
});

test('order: newest done first; same time by id; a later note (updated) does not reorder', () => {
  const tasks = [card('z', 'done', 2 * H), card('y', 'done', 2 * H), card('old-but-touched', 'done', 10 * H, { updated: iso(NOW) }), card('n', 'done', H)];
  assert.deepEqual(ids(tickerItems(tasks, NOW, 0)), ['n', 'y', 'z', 'old-but-touched']);
});

test('cap: 3 shown, the rest behind "+N more" until expanded', () => {
  const items = tickerItems(Array.from({ length: 5 }, (_, i) => card(`c${i}`, 'done', (i + 1) * H)), NOW, 0);
  assert.equal(TOP, 3);
  const folded = tickerShown(items, false);
  assert.deepEqual(ids(folded.shown), ['c0', 'c1', 'c2']);
  assert.equal(folded.more, 2);
  const open = tickerShown(items, true);
  assert.equal(open.shown.length, 5);
  assert.equal(open.more, 0);
  assert.deepEqual(tickerShown(items.slice(0, 3), false), { shown: items.slice(0, 3), more: 0 });
});

test('"Got it" moves the mark to the newest done time, so the line clears and only later cards come back', () => {
  const tasks = [card('a', 'done', H), card('b', 'done', 3 * H)];
  const mark = markAfter(tickerItems(tasks, NOW, 0), 0);
  assert.equal(mark, NOW - H);
  assert.deepEqual(tickerItems(tasks, NOW, mark), []);
  assert.deepEqual(ids(tickerItems([...tasks, card('c', 'done', 10 * 60_000)], NOW, mark)), ['c']);
  assert.equal(markAfter([], NOW - H), NOW - H, 'the mark never moves back');
});

test('one line per card; garbage rows are skipped without throwing', () => {
  const items = tickerItems([card('twice', 'done', 5 * H, { title: 'first' }), card('other', 'done', 2 * H), card('twice', 'done', H, { title: 'again' })], NOW, 0);
  assert.deepEqual(ids(items), ['twice', 'other']);
  assert.equal(items[0].x.title, 'again');
  assert.deepEqual(tickerItems(undefined, NOW, 0), []);
  assert.deepEqual(tickerItems([{ id: 'q', status: 'done', updated: 'nope' }], NOW, 0), []);
  assert.deepEqual(ids(tickerItems([null, card('ok', 'done', H)], NOW, 0)), ['ok']);
});

test('done-ticker.js: pure and colourless; served, loaded before app.js, with English and Korean strings', async () => {
  const src = fs.readFileSync(path.join(PUB, 'done-ticker.js'), 'utf8');
  assert.doesNotMatch(src, /\bdocument\b|\bwindow\.(?!DoneTicker)|querySelector|innerHTML|localStorage|Date\.now/, 'pure');
  assert.deepEqual(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], []);
  assert.equal(STATIC['/done-ticker.js'], 'done-ticker.js');
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const ti = html.indexOf('<script type="module" src="/done-ticker.js"></script>'), ai = html.indexOf('<script src="/app.js"');
  assert.ok(ti > 0 && ti < ai, 'done-ticker.js is loaded before app.js');
  assert.match(html, /id="done-ticker"/);
  const dict = fs.readFileSync(path.join(PUB, 'i18n.js'), 'utf8');
  for (const k of ['done.tick.label', 'done.tick.more', 'done.tick.less', 'done.tick.ok', 'done.tick.ok.title']) assert.equal(dict.split(`'${k}'`).length - 1, 2, `${k} in en and ko`);
});

test('agents never see it: no MCP tool, CLI, prompt builder, captain watch or runner reads or serves it', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (/\.(m?[jt]s|sh|py)$/.test(e.name) || !e.name.includes('.')) files.push(f);
    }
  };
  for (const d of ['mcp', 'bin', 'src', 'scripts', 'contract', 'skills']) walk(path.join(ROOT, d));
  for (const must of ['src/cli/captain-watch.ts', 'src/lib/start.ts', 'mcp/dasks-mcp.mjs', 'mcp/board-cli.mjs', 'bin/dask']) assert.ok(files.includes(path.join(ROOT, must)), `${must} is scanned`);
  // The one allowed mention: the static file map that hands the module to the board page in a browser.
  const allowed = path.join(ROOT, 'src/lib/server-static.ts');
  for (const f of files) {
    if (f === allowed) continue;
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /done[-_. ]?ticker|DoneTicker|doneSeen|done\.tick/i, path.relative(ROOT, f));
  }
});
