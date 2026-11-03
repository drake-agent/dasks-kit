// Design system files, theme attributes, ordering, the title check and stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createTask, updateTask, titleWarnings, HttpError } from '../src/lib/write.ts';
import { validateView, defaultView } from '../src/lib/views.ts';
import { readActivity } from '../src/lib/collab.ts';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUB = path.join(ROOT, 'public');
const HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const SERVER = path.join(ROOT, 'src/server.ts');
const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return e instanceof HttpError ? e.status : -1; } };

/** Every /ds/ file the page asks for, plus the fonts its fonts.css points at. */
function dsFiles(): string[] {
  const files = [...HTML.matchAll(/href="\/ds\/([^"]+)"/g)].map((m) => m[1]);
  const fonts = fs.readFileSync(path.join(PUB, 'ds/fonts.css'), 'utf8');
  for (const m of fonts.matchAll(/url\('\.\/([^']+)'\)/g)) files.push(m[1]);
  return [...new Set(files)];
}

test('bundled design system: every file the page links exists, small, metal/dark only; body carries the theme', () => {
  const files = dsFiles();
  assert.deepEqual(files.slice(0, 3), ['fonts.css', 'tokens.css', 'components.css']);
  assert.ok(files.some((f) => f.endsWith('.woff2')));
  for (const f of files) assert.ok(fs.existsSync(path.join(PUB, 'ds', f)), `public/ds/${f}`);
  let total = 0;
  const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else total += fs.statSync(p).size; } };
  walk(path.join(PUB, 'ds'));
  assert.ok(total < 600_000, `design system size ${total} B (budget 600 KB)`);
  const tokens = fs.readFileSync(path.join(PUB, 'ds/tokens.css'), 'utf8');
  assert.match(tokens, /\[data-theme="dasks"\]\[data-variant="metal"\]\[data-mode="dark"\]/);
  assert.doesNotMatch(tokens, /data-variant="(cloud|base|phone-metal)"|data-mode="light"/);
  assert.match(HTML, /<body data-theme="dasks" data-variant="metal">\s*<script src="\/theme-boot.js"><\/script>/);
  // 한/EN stays a ds-segmented control at the top right
  assert.match(HTML, /<div class="ds-segmented lang"[^>]*><button type="button" class="ds-segment" data-lang="ko"/);
  // no colour of its own in style.css: only tokens (the comment line aside)
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], []);
});

async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}
async function startServer(root: string) {
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
}

test('live: /ds/ assets load (no 404) with the right types; nothing outside public/ds; title warnings over HTTP', async () => {
  const { root, cleanup } = tempRepo();
  const { url, proc } = await startServer(root);
  try {
    const type = { css: 'text/css', woff2: 'font/woff2', txt: 'text/plain' } as Record<string, string>;
    for (const f of dsFiles()) {
      const r = await fetch(`${url}/ds/${f}`);
      assert.equal(r.status, 200, f);
      assert.ok(r.headers.get('content-type')!.startsWith(type[f.split('.').pop()!]), `${f}: ${r.headers.get('content-type')}`);
    }
    // raw paths (fetch would normalize the dots away; the server's URL parser resolves them, so they never leave public/)
    const raw = (p: string) => new Promise<number>((res, rej) => http.get({ host: '127.0.0.1', port: Number(new URL(url).port), path: p }, (r) => { r.resume(); res(r.statusCode!); }).on('error', rej));
    for (const bad of ['/ds/../server.ts', '/ds/../../config.json', '/ds/fonts/../../src/server.ts', '/ds/%2e%2e/%2e%2e/src/server.ts', '/ds/fonts/x.js', '/ds/nope.css', '/ds/sub/dir/a.css']) assert.equal(await raw(bad), 404, bad);
    const page = await (await fetch(url + '/p/beta')).text();
    assert.match(page, /data-theme="dasks" data-variant="metal">/);
    // soft check: a slug title is accepted, with a warning (header + body)
    const H = { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'codex@desktop' };
    const r = await fetch(url + '/api/tasks', { method: 'POST', headers: H, body: JSON.stringify({ goal: 'beta', title: '#site-v9 Beta site (user OK 18:22) PR #31' }) });
    assert.equal(r.status, 201);
    const t = await r.json();
    assert.match(decodeURIComponent(r.headers.get('x-dasks-warning')!), /#slug.*PR number.*time or date.*approval stamp/);
    assert.ok(!t.warnings.some((w: string) => /title_ko and title_en/.test(w)), 'translations are optional');
    const ok = await fetch(url + '/api/tasks', { method: 'POST', headers: H, body: JSON.stringify({ goal: 'beta', title: 'Beta site', title_ko: 'Beta 사이트', title_en: 'Beta site' }) });
    assert.equal(ok.status, 201); assert.equal(ok.headers.get('x-dasks-warning'), null); assert.equal((await ok.json()).warnings, undefined);
    const u = await fetch(`${url}/api/tasks/${t.id}`, { method: 'POST', headers: H, body: JSON.stringify({ title_en: 'Merge #12 at 10:30' }) });
    assert.equal(u.status, 200); assert.ok((await u.json()).warnings.length);
    for (const k of ['title_ko', 'title_en']) {
      const m = await fetch(`${url}/api/tasks/${t.id}`, { method: 'POST', headers: H, body: JSON.stringify({ [k]: 'First line\nSecond line' }) });
      assert.equal(m.status, 200, k); assert.ok((await m.json()).warnings.some((w: string) => w.startsWith(`${k} has more than one line`)), k);
    }
  } finally { proc.kill(); cleanup(); }
});

test('title soft check: flags slugs, PR numbers, times, approval stamps, length; plain titles pass', () => {
  const bad = ['#testflight-b3b Beta build 3', 'Merge PR #14 and install', 'Fix #1120 P1', 'pr22-merge: verify the rebase', 'Redo site (user feedback 19:24)',
    'merge #19 (user OK 13:21)', '#19 머지 (사용자 승인 13:21)', '출시 (사용자 승인)', 'PR 14를 머지', 'PR14의 충돌 해결', 'PR 14번 수정', 'PR 14 개선', 'PR14 개발', 'Ship (user)', 'First line\nSecond line', 'Ship on 2026-10-17', 'Ship on 10/17', 'x'.repeat(61)];
  for (const b of bad) assert.equal(titleWarnings({ title: b }).length, 1, b);
  for (const g of ['Check Beta build 3 and upload to TestFlight', 'Beta 빌드 3 확인과 TestFlight 업로드', 'S1.0: a finished upload opens the share sheet', 'Plan 5 / Lite', 'Cache ideas 5-8', 'E1 scroll-to-top button', '6-theme design system, stage 2', '문서 정리 PR 4개 합치기', 'PR 4개를 합치기', 'PR 4건의 충돌 해결', 'Pull Beta ideas (user-pulled only)', '아이디어 가져오기 (사용자가 고른 것만)'])
    assert.deepEqual(titleWarnings({ title: g, title_ko: g, title_en: g }), [], g);
  assert.deepEqual(titleWarnings({ title: 'a', title_ko: '가', title_en: 'a' }), []);
  assert.deepEqual(titleWarnings({ title: 'a' }), [], 'title_ko / title_en are optional');
});

test('housekeeping rename: keeps `updated` and status, logs "rename"; refused with any other field', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'beta', title: '#x-1 Ship (user OK 10:00)', status: 'doing' }, 'beta-lead', new Date('2026-10-10T09:00:00+09:00'));
    const r = updateTask(root, t.id, { title: 'Ship it', title_ko: '출시', title_en: 'Ship it' }, 'dasks-design', { housekeeping: true, appendNote: 'old title: #x-1 Ship (user OK 10:00)', expectedVersion: 1, now: new Date('2026-10-12T09:00:00+09:00') });
    assert.equal(r.updated, t.updated, 'a rename is not progress');
    assert.equal(r.status, 'doing'); assert.equal(r.title, 'Ship it'); assert.equal(r.title_ko, '출시'); assert.equal(r.version, '2');
    assert.match(r.body, /dasks-design: old title: #x-1 Ship \(user OK 10:00\)/);
    assert.equal(readActivity(root, t.id).at(-1)!.action, 'rename');
    assert.equal(status(() => updateTask(root, t.id, { title: 'x', priority: 'p0' }, 'dasks-design', { housekeeping: true })), 400);
    assert.equal(status(() => updateTask(root, t.id, { status: 'done' }, 'dasks-design', { housekeeping: true })), 400);
    assert.equal(status(() => updateTask(root, t.id, {}, 'dasks-design', { housekeeping: true, appendNote: 'hi' })), 400);
    // the holder's own rename does not keep a dead claim alive
    const c = createTask(root, { goal: 'beta', title: 'Claimed' }, 'codex@desktop', new Date('2026-10-10T08:00:00+09:00'));
    updateTask(root, c.id, {}, 'codex@desktop', { claim: { op: 'claim', who: 'codex@desktop' }, now: new Date('2026-10-10T08:00:00+09:00') });
    const rc = updateTask(root, c.id, { title: 'Claimed card' }, 'codex@desktop', { housekeeping: true, now: new Date('2026-10-12T08:00:00+09:00') });
    assert.equal(rc.claim_seen || '', '', 'no heartbeat from a rename');
    const took = updateTask(root, c.id, {}, 'claude-code@desktop', { claim: { op: 'claim', who: 'claude-code@desktop' }, warnings: [], now: new Date('2026-10-12T08:01:00+09:00') });
    assert.equal(took.claimed_by, 'claude-code@desktop', 'the 6 h lease still lapsed: no force needed');
    // a normal rename still counts as progress
    const n = updateTask(root, t.id, { title: 'Ship', title_ko: '출시', title_en: 'Ship' }, 'beta-lead', { now: new Date('2026-10-12T10:00:00+09:00') });
    assert.notEqual(n.updated, t.updated);
  } finally { cleanup(); }
});

/** The ordering and staleness helpers, read from public/app.js. */
function appHelpers(now: number) {
  const pick = (re: RegExp) => { const m = re.exec(APP); assert.ok(m, String(re)); return m![0]; };
  const src = [
    pick(/const waitsOnUser = [\s\S]*?const isTurn = [\s\S]*?;/),
    pick(/const waitFrom = [^\n]+/), pick(/function byTurn\(a, b\) \{[\s\S]*?\n\}/), pick(/const TURN_TOP = [^\n]+/), pick(/const turnOf = [^\n]+/),
    pick(/const STALE_MS = [^\n]+/), pick(/const isStale = [^\n]+/),
  ].join('\n');
  return vm.runInNewContext(`${src}; ({ byTurn, turnOf, isStale, TURN_TOP })`, { Date: { now: () => now, parse: Date.parse } });
}

test('your turn: top 5 = p0 first, then the oldest; only blocked/review count', () => {
  const now = Date.parse('2026-10-12T12:00:00+09:00');
  const h = appHelpers(now);
  const T = (id: string, priority: string, goal: string, milestone: string, updated: string, status = 'blocked-on-user') => ({ id, priority, goal, milestone, updated: `2026-10-${updated}+09:00`, status, ...(status === 'review' ? { pr: 'https://github.com/x/y/pull/1', needs_user: '승인 필요' } : {}) });
  const tasks = [
    T('alpha.t-old', 'p2', 'alpha', 'alpha.m1', '01T10:00:00'),
    T('beta.t-lnew', 'p2', 'beta', 'beta.m4-iap', '11T10:00:00'),
    { ...T('beta.t-lold', 'p3', 'beta', 'beta.m1-testflight', '09T10:00:00', 'review'), pr: 'https://github.com/x/y/pull/1', needs_user: '합칠까?' },
    T('beta.t-gtm', 'p1', 'beta', 'beta.m-gtm', '05T10:00:00'),
    T('notes.t-p0', 'p0', 'notes', 'notes.m1', '11T11:00:00'),
    T('alpha.t-p0old', 'p0', 'alpha', 'alpha.m1', '10T11:00:00'),
    T('gamma.t-newer', 'p1', 'gamma', 'gamma.m1', '11T09:00:00'),
    T('gamma.t-doing', 'p0', 'gamma', 'gamma.m1', '01T09:00:00', 'doing'),
  ];
  const order = h.turnOf(tasks).map((x: any) => x.id);
  assert.deepEqual(order, ['alpha.t-p0old', 'notes.t-p0', 'alpha.t-old', 'beta.t-gtm', 'beta.t-lold', 'gamma.t-newer', 'beta.t-lnew']);
  assert.equal(h.TURN_TOP, 5);
  assert.equal(h.turnOf([{ ...tasks[2], pr: '' }, { ...tasks[2], needs_user: '' }, { ...tasks[2], pr_summary: 'Draft PR: not ready' }]).length, 0);
  // oldest by time, not by text: 09:00+09:00 (00:00Z) is older than 01:00Z
  const mixed = [T('a.t-z', 'p2', 'alpha', 'alpha.m1', '12T01:00:00'), T('a.t-k', 'p2', 'alpha', 'alpha.m1', '12T09:00:00')];
  mixed[0].updated = '2026-10-12T01:00:00Z';
  assert.deepEqual(h.turnOf(mixed).map((x: any) => x.id), ['a.t-k', 'a.t-z']);
  // the home list and the needs_you widget both render turnList (top 5 + "more") from turnOf
  assert.match(APP, /turnList\(turn, 'home-turn', true\)/);
  assert.match(APP, /function turnList\(items, key, select, top = TURN_TOP\)[\s\S]*?limited\(items, key, top\)[\s\S]*?moreBtn\(key, items\.length - top\)/);
  assert.match(APP, /turnList\(turnOf\(appTasks\(PAGE\)\), `w\$\{i\}`, true, w\.limit \|\| TURN_TOP\)/, 'on /p/<app> the rows open the quick view');
});

test('stale flag: a doing card with no update for more than 24h; others never', () => {
  const now = Date.parse('2026-10-12T12:00:00+09:00');
  const h = appHelpers(now);
  assert.equal(h.isStale({ status: 'doing', updated: '2026-10-11T11:59:00+09:00' }), true);
  assert.equal(h.isStale({ status: 'doing', updated: '2026-10-11T12:01:00+09:00' }), false);
  assert.equal(h.isStale({ status: 'review', updated: '2026-10-01T12:00:00+09:00' }), false);
  // shown dimmed with "stalled?" on the home, Today, project running lists and kanban cards
  assert.match(APP, /class="ds-mission\$\{stale \? ' stale' : ''\}"/);
  assert.match(APP, /t\('stalled'\)/);
});

test('views: stats takes countdown (needs a date) and stage; workspace & co get stat cards + a stage timeline', () => {
  validateView('beta', defaultView('beta'), undefined);
  assert.throws(() => validateView('beta', { title: '', tagline: '', widgets: [{ type: 'stats', items: ['countdown'] }] } as any, undefined), /countdown item needs "date"/);
  validateView('beta', { title: '', tagline: '', widgets: [{ type: 'stats', items: ['countdown', 'stage'], date: '2026-10-17', label_ko: '출시까지' }] } as any, undefined);
  const est = defaultView('ops');
  assert.deepEqual(est.widgets.slice(0, 2).map((w) => w.type), ['stats', 'timeline']);
  assert.deepEqual(est.widgets[0].items, ['stage', 'needs_you', 'running', 'progress']);
});
