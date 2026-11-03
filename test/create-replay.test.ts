// A retried create returns the first card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';
import { createTask, HttpError, type CreateOpts } from '../src/lib/write.ts';

const BODY = '## Context\nretry me';
const base = (over: Record<string, unknown> = {}) => ({ goal: 'beta', milestone: 'beta.m1', title: 'Arc', body: BODY, ...over });
const commits = (root: string) => Number(execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
const files = (root: string, re: RegExp) => fs.readdirSync(path.join(root, 'data/tasks/beta')).filter((f) => re.test(f));
const NOW = new Date('2026-10-28T14:00:00+09:00');
const at = (ms: number) => new Date(NOW.getTime() + ms);

test('same create twice within the window returns the first card, one commit', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    const before = commits(root);
    const o1: CreateOpts = {};
    const a = createTask(root, base(), 'beta-lead', NOW, o1);
    const o2: CreateOpts = {};
    const b = createTask(root, base(), 'beta-lead', at(30_000), o2);
    assert.equal(a.id, 'beta.t-arc');
    assert.equal(b.id, 'beta.t-arc');
    assert.ok(!o1.replayed);
    assert.equal(o2.replayed, true);
    assert.equal(commits(root) - before, 1);
    assert.deepEqual(files(root, /^t-arc.*\.md$/), ['t-arc.md']);
  } finally { cleanup(); }
});

test('same title, different body makes a new -2 card', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    createTask(root, base(), 'beta-lead', NOW, {});
    const o: CreateOpts = {};
    const b = createTask(root, base({ body: '## Context\nsomething else' }), 'beta-lead', at(30_000), o);
    assert.equal(b.id, 'beta.t-arc-2');
    assert.ok(!o.replayed);
  } finally { cleanup(); }
});

test('same content after 16 minutes is outside the window', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    createTask(root, base(), 'beta-lead', NOW, {});
    const o: CreateOpts = {};
    const b = createTask(root, base(), 'beta-lead', at(16 * 60_000), o);
    assert.equal(b.id, 'beta.t-arc-2');
    assert.ok(!o.replayed);
  } finally { cleanup(); }
});

test('explicit id replays the same content and still 409s on different content', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    const a = createTask(root, base({ id: 'beta.t-fixed' }), 'beta-lead', NOW, {});
    const o: CreateOpts = {};
    const b = createTask(root, base({ id: 'beta.t-fixed' }), 'beta-lead', at(60_000), o);
    assert.equal(b.id, a.id);
    assert.equal(o.replayed, true);
    assert.throws(() => createTask(root, base({ id: 'beta.t-fixed', body: 'different' }), 'beta-lead', at(90_000), {}),
      (e: any) => e instanceof HttpError && e.status === 409 && /already exists/.test(e.message));
  } finally { cleanup(); }
});

test('a third retry after two numbered copies returns the matching -2', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    const x1 = createTask(root, base({ title: 'X', body: 'A' }), 'beta-lead', at(-20 * 60_000), {});
    assert.equal(x1.id, 'beta.t-x');
    const x2 = createTask(root, base({ title: 'X', body: 'B' }), 'beta-lead', NOW, {});
    assert.equal(x2.id, 'beta.t-x-2');
    const o: CreateOpts = {};
    const x3 = createTask(root, base({ title: 'X', body: 'B' }), 'beta-lead', at(10_000), o);
    assert.equal(x3.id, 'beta.t-x-2');
    assert.equal(o.replayed, true);
    assert.ok(!fs.existsSync(path.join(root, 'data/tasks/beta/t-x-3.md')));
  } finally { cleanup(); }
});

test('idea promotion (extraFiles set) never replays', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    createTask(root, base(), 'beta-lead', NOW, {});
    const o: CreateOpts = { extraFiles: () => [] };
    const b = createTask(root, base(), 'beta-lead', at(30_000), o);
    assert.equal(b.id, 'beta.t-arc-2');
    assert.ok(!o.replayed);
  } finally { cleanup(); }
});

test('server answers 201 then 200 + X-Dasks-Replayed, one task listed', async () => {
  const { root, cleanup } = tempRepo([]);
  const s = await serve(root);
  try {
    const r1 = await s.post('/api/tasks', base());
    const j1 = await r1.json();
    assert.equal(r1.status, 201, JSON.stringify(j1));
    const r2 = await s.post('/api/tasks', base());
    const j2 = await r2.json();
    assert.equal(r2.status, 200, JSON.stringify(j2));
    assert.equal(r2.headers.get('x-dasks-replayed'), j1.id);
    assert.equal(j2.id, j1.id);
    const list = await (await fetch(s.url + '/api/tasks?goal=beta')).json();
    assert.equal(list.filter((t: any) => t.title === 'Arc').length, 1);
  } finally { await s.stop(); cleanup(); }
});

test('two identical POSTs sent together make one task (201 + 200)', async () => {
  const { root, cleanup } = tempRepo([]);
  const s = await serve(root);
  try {
    const rs = await Promise.all([s.post('/api/tasks', base()), s.post('/api/tasks', base())]);
    const js = await Promise.all(rs.map((r) => r.json()));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 201], JSON.stringify(js));
    assert.equal(js[0].id, js[1].id);
    const list = await (await fetch(s.url + '/api/tasks?goal=beta')).json();
    assert.equal(list.filter((t: any) => t.title === 'Arc').length, 1);
  } finally { await s.stop(); cleanup(); }
});

test('a trailing newline in the body does not stop a replay', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    const a = createTask(root, base({ body: BODY + '\n' }), 'beta-lead', NOW, {});
    const o: CreateOpts = {};
    const b = createTask(root, base(), 'beta-lead', at(30_000), o);
    assert.equal(b.id, a.id);
    assert.equal(o.replayed, true);
  } finally { cleanup(); }
});
