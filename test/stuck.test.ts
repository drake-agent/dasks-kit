import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';
import { readyQueue } from '../src/lib/ready.ts';
import { digestText, runDigest } from '../src/lib/digest.ts';
import { loadConfig } from '../src/lib/config.ts';
import type { Task } from '../src/lib/schema.ts';

const NOW = new Date('2026-10-22T14:22:00Z');
const ago = (h: number) => new Date(+NOW - h * 3600_000).toISOString();
const card = (id: string, over: Partial<Task> = {}) => task({ id: `beta.t-${id}`, updated: ago(1), ...over });
const report = async (tasks: Task[], opts = {}) => (await import('../src/lib/stuck.ts')).stuckReport({ tasks }, NOW, opts);

test('stuck: every reason, one reason per flagged open card, deepest open blocker; pure and deterministic', async () => {
  const tasks = [card('root'), card('midl', { depends_on: 'beta.t-root' }), card('leaf', { depends_on: 'beta.t-midl' }),
    card('msng', { depends_on: 'beta.t-gone' }), card('doing', { status: 'doing', updated: ago(7) }),
    card('revw', { status: 'review', updated: ago(25) }), card('idle', { updated: ago(25), depends_on: 'beta.t-done, beta.t-cncld' }),
    card('user', { status: 'blocked-on-user', depends_on: 'beta.t-root' }), card('ask', { needs_user: 'Choose one' }),
    card('a', { depends_on: 'beta.t-b' }), card('b', { depends_on: 'beta.t-a' }), card('abvc', { depends_on: 'beta.t-a' }),
    card('done', { status: 'done' }), card('cncld', { status: 'cancelled' }), card('clmd', { updated: ago(25), claimed_by: 'helper' })];
  const before = JSON.stringify(tasks);
  const r = await report(tasks, { top_n: 1 });
  const by = new Map(r.items.map((x) => [x.id, x]));
  const leaf = by.get('beta.t-leaf');
  assert.ok(leaf?.reason === 'dep-open');
  assert.equal(leaf.root_blocker, 'beta.t-root');
  assert.equal(by.get('beta.t-msng')?.reason, 'dep-missing');
  assert.equal(by.get('beta.t-doing')?.reason, 'doing-stale');
  assert.equal(by.get('beta.t-doing')?.age_hours, 7);
  assert.equal(by.get('beta.t-revw')?.reason, 'review-stale');
  assert.equal(by.get('beta.t-idle')?.reason, 'ready-idle');
  for (const id of ['user', 'ask']) assert.equal(by.get(`beta.t-${id}`)?.reason, 'blocked-user');
  for (const id of ['a', 'b', 'abvc']) assert.equal(by.get(`beta.t-${id}`)?.reason, 'cycle');
  for (const id of ['root', 'done', 'cncld', 'clmd']) assert.equal(by.has(`beta.t-${id}`), false);
  assert.equal(r.total, 11);
  assert.equal(r.counts['dep-open'], 2);
  assert.equal(r.counts.cycle, 3);
  assert.equal(r.top['dep-open'].length, 1);
  assert.equal(r.unblockers[0].id, 'beta.t-root');
  assert.equal(r.unblockers[0].unblocks, 3);
  assert.equal(new Set(r.items.map((x) => x.id)).size, r.total);
  assert.equal(JSON.stringify(tasks), before);
  assert.deepEqual(await report(tasks, { top_n: 1 }), r);
});

test('stuck: strict stale thresholds, created fallback, configurable thresholds and missing warnings', async () => {
  const tasks = [card('doing', { status: 'doing', updated: ago(6) }), card('revw', { status: 'review', updated: ago(24) }),
    card('idle', { updated: ago(24) }), card('fback', { updated: '', created: ago(25) }),
    card('oldms', { updated: ago(25), depends_on: 'beta.t-gone' })];
  const r = await report(tasks);
  assert.deepEqual(r.items.map((x) => [x.id, x.reason]).sort(), [['beta.t-fback', 'ready-idle'], ['beta.t-oldms', 'dep-missing']]);
  assert.equal((await report(tasks, { doing_hours: 5, review_hours: 23, ready_idle_hours: 23 })).total, 5);
});

test('stuck: shared dependency DAG chooses deepest branch and terminates on self cycles', async () => {
  const r = await report([card('leaf', { depends_on: 'beta.t-short, beta.t-midl' }), card('short'),
    card('midl', { depends_on: 'beta.t-deep' }), card('deep'), card('self', { depends_on: 'beta.t-self' })]);
  const leaf = r.items.find((x) => x.id === 'beta.t-leaf');
  assert.ok(leaf?.reason === 'dep-open');
  assert.equal(leaf.root_blocker, 'beta.t-deep');
  assert.equal(r.items.find((x) => x.id === 'beta.t-self')?.reason, 'cycle');
});

test('ready: missing dependencies stop blocking at 24h; updated wins, created fallback; done satisfies, cancelled blocks', () => {
  const tasks = [card('old', { updated: ago(25), depends_on: 'beta.t-gone' }), card('edge', { updated: ago(24), depends_on: 'beta.t-gone' }),
    card('new', { updated: ago(23.99), created: ago(99), depends_on: 'beta.t-gone' }),
    card('fback', { updated: '', created: ago(25), depends_on: 'beta.t-gone' }),
    card('mixed', { updated: ago(25), depends_on: 'beta.t-gone, beta.t-open' }), card('open'),
    card('done', { status: 'done' }), card('cncld', { status: 'cancelled' }), card('stsfd', { depends_on: 'beta.t-done' }),
    card('oncnc', { depends_on: 'beta.t-done, beta.t-cncld' })];
  const r = readyQueue({ tasks }, { now: NOW });
  for (const id of ['old', 'edge', 'fback']) assert.deepEqual(r.ready.find((x) => x.id === `beta.t-${id}`)?.missing_ignored, ['beta.t-gone']);
  assert.deepEqual(r.blocked.find((x) => x.id === 'beta.t-new')?.missing, ['beta.t-gone']);
  assert.deepEqual(r.blocked.find((x) => x.id === 'beta.t-mixed')?.waiting_on, ['beta.t-open']);
  assert.ok(r.ready.some((x) => x.id === 'beta.t-stsfd'));
  assert.deepEqual(r.blocked.find((x) => x.id === 'beta.t-oncnc')?.cancelled, ['beta.t-cncld']);
  assert.ok(!readyQueue({ tasks }, { now: NOW, missing_hours: 48 }).ready.some((x) => x.id === 'beta.t-old'));
});

test('config: stuck defaults, partial overrides and invalid thresholds', () => {
  const tmp = tempRepo();
  try {
    assert.deepEqual(loadConfig(tmp.root).stuck, { doing_hours: 6, review_hours: 24, ready_idle_hours: 24, missing_hours: 24, top_n: 5 });
    fs.writeFileSync(path.join(tmp.root, 'config.json'), JSON.stringify({ stuck: { doing_hours: 2 } }));
    assert.equal(loadConfig(tmp.root).stuck.review_hours, 24);
    assert.equal(loadConfig(tmp.root).stuck.doing_hours, 2);
    fs.writeFileSync(path.join(tmp.root, 'config.json'), JSON.stringify({ stuck: { missing_hours: -1 } }));
    assert.throws(() => loadConfig(tmp.root), /stuck.missing_hours/);
  } finally { tmp.cleanup(); }
});

test('API: read report and board badges, CLI JSON, no writes; POST refused', async () => {
  const tmp = tempRepo([card('stale', { status: 'doing', updated: ago(9999) }), card('ready', { updated: ago(9999), depends_on: 'beta.t-gone' })]);
  const s = await serve(tmp.root);
  const head = () => execFileSync('git', ['-C', tmp.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  try {
    const before = head();
    const res = await fetch(s.url + '/api/stuck');
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.counts['doing-stale'], 1);
    assert.equal(r.counts['dep-missing'], 1);
    const b = await (await fetch(s.url + '/api/board')).json();
    assert.deepEqual(b.stuck.counts, r.counts);
    const ready = await (await fetch(s.url + '/api/ready?all=1')).json();
    assert.deepEqual(ready.ready[0].missing_ignored, ['beta.t-gone']);
    const cli = JSON.parse(execFileSync(process.execPath, ['mcp/board-cli.mjs', 'stuck', '--json'], { encoding: 'utf8', env: { ...process.env, DASKS_URL: s.url } }));
    assert.deepEqual(cli.counts, r.counts);
    const localCli = JSON.parse(execFileSync(process.execPath, ['bin/dasks-outcome', 'stuck', '--json'], { encoding: 'utf8', env: { ...process.env, DASKS_URL: s.url } }));
    assert.deepEqual(localCli.counts, r.counts);
    assert.equal((await s.post('/api/stuck', {})).status, 404);
    assert.equal(head(), before);
  } finally { await s.stop(); tmp.cleanup(); }
});

test('digest: summary and top three unblockers, including scheduled digest; no extra decisions', () => {
  const tasks = ['a', 'b', 'c', 'd'].flatMap((id, n) => [card(id), ...Array.from({ length: n + 1 }, (_, i) => card(`${id}-${i}`, { depends_on: `beta.t-${id}` }))]);
  const tmp = tempRepo(tasks);
  try {
    const text = digestText(tmp.root, '2000-01-01T00:00:00Z');
    assert.match(text, /Stuck: \d+ \(dep-open 10, doing-stale 0, review-stale 0, ready-idle \d+/);
    const decisions = text.split('\n').filter((l) => l.startsWith('- Unblock '));
    assert.equal(decisions.length, 3);
    assert.match(decisions[0], /beta.t-d.*4/);
    assert.match(decisions[1], /beta.t-c.*3/);
    assert.match(decisions[2], /beta.t-b.*2/);
    const run = runDigest(tmp.root);
    assert.match(fs.readFileSync(path.join(tmp.root, run.file), 'utf8'), /Stuck:/);
    assert.equal(runDigest(tmp.root).skipped, true, 'no extra writes by default');
    // No new commits: opt in to refreshing the attention snapshot as cards age.
    const saved = process.env.DASKS_STUCK_DIGEST_REFRESH;
    process.env.DASKS_STUCK_DIGEST_REFRESH = '1';
    let again;
    try { again = runDigest(tmp.root, new Date(Date.now() + 86400_000)); } finally {
      if (saved === undefined) delete process.env.DASKS_STUCK_DIGEST_REFRESH; else process.env.DASKS_STUCK_DIGEST_REFRESH = saved;
    }
    assert.equal(again.skipped, false);
    assert.match(fs.readFileSync(path.join(tmp.root, again.file), 'utf8'), /Stuck:/);
  } finally { tmp.cleanup(); }
});


test('stuck: 22-level chains, closed edges stop traversal, reversed input has the same report', async () => {
  const tasks = Array.from({ length: 23 }, (_, i) => card(`lv-${i}`, i ? { depends_on: `beta.t-lv-${i - 1}` } : {}));
  tasks.push(card('clsdp', { status: 'done', depends_on: 'beta.t-absnt' }), card('aftcl', { depends_on: 'beta.t-clsdp', updated: ago(25) }));
  const r = await report(tasks);
  const deep = r.items.find((x) => x.id === 'beta.t-lv-22');
  assert.ok(deep?.reason === 'dep-open');
  assert.equal(deep.root_blocker, 'beta.t-lv-0');
  assert.equal(r.unblockers[0].unblocks, 22);
  assert.equal(r.items.find((x) => x.id === 'beta.t-aftcl')?.reason, 'ready-idle');
  assert.deepEqual(await report([...tasks].reverse()), r);
});

test('UI: badges name the reason and age, escape dependency ids, and render nothing without a stuck report', async () => {
  const dictSource = fs.readFileSync(path.resolve('public/i18n.js'), 'utf8');
  const dict = vm.runInNewContext(dictSource + '\nDICT');
  for (const reason of (await import('../src/lib/stuck.ts')).STUCK_REASONS) {
    assert.ok(dict.ko[`stuck.${reason}`]);
    assert.ok(dict.en[`stuck.${reason}`]);
  }
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const esc = app.split('\n').find((l) => l.startsWith('const esc = '));
  assert.ok(esc);
  const badge = app.slice(app.indexOf('function stuckBadge('), app.indexOf('function taskRow('));
  const S: { data: { stuck?: unknown } } = { data: { stuck: { items: [{ id: 'beta.t-x', reason: 'dep-open', root_blocker: '<img src=x onerror=alert(1)>', age_hours: 25.9 }] } } };
  // the age reads in the board's own units (ago(): 시간 / 일), like every other age on the board
  const ago = app.slice(app.indexOf('function ago('), app.indexOf('const agoText'));
  const t = (key: string, v?: { n?: number }) => (v && v.n !== undefined ? `${key}:${v.n}` : key);
  // the blocking card by title when the board knows it; an unknown id is shown (escaped) as it is
  const render = vm.runInNewContext(`${esc}\n${ago}\n${badge}\nstuckBadge`, { S, t, Date, D: { task: () => undefined }, tt: (x: { title: string }) => x.title });
  const html = render({ id: 'beta.t-x' });
  assert.match(html, /data-reason="dep-open"/);
  assert.match(html, /stuck.dep-open · unit\.h:26/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(render({ id: 'beta.t-hlthy' }), '');
  delete S.data.stuck;
  assert.equal(render({ id: 'beta.t-x' }), '');
});
