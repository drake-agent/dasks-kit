// Bugs first: cards of kind bug come right after the user's pushes, before every other card, in the ready queue
// (GET /api/ready: `dask ready`, MCP ready_tasks) and in the order the runner starts cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyQueue } from '../src/lib/ready.ts';
import { pickCards, type Candidate } from '../src/lib/runner.ts';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { boardSchema, migrateBoard, SCHEMA_REL, schemaContent } from '../src/lib/migrate.ts';
import { loadBoard } from '../src/lib/load.ts';
import { task, tempRepo } from './helpers.ts';

test('ready queue: pushes, then bug fixes, then the rest (whatever their priority or how much they unblock)', () => {
  const pushed = task({ id: 'beta.t-push', priority: 'p3', lane: 'claude', pushed: '2026-10-10T09:00:00+09:00 user claude' } as any);
  const tasks = [
    task({ id: 'beta.t-feat', priority: 'p0' }),
    task({ id: 'beta.t-root', priority: 'p1' }),
    task({ id: 'beta.t-dep', priority: 'p1', depends_on: 'beta.t-root' }),
    task({ id: 'beta.t-bug', priority: 'p3', kind: 'bug' }),
    pushed,
  ];
  const ids = readyQueue({ tasks }).ready.map((r) => r.id);
  assert.deepEqual(ids, ['beta.t-push', 'beta.t-bug', 'beta.t-root', 'beta.t-feat']);
  assert.equal(readyQueue({ tasks }).ready.find((r) => r.id === 'beta.t-bug')!.kind, 'bug', 'the kind travels with the item');
  const noBug = readyQueue({ tasks: tasks.map((t) => (t.id === 'beta.t-bug' ? { ...t, kind: 'impl' as const } : t)) }).ready.map((r) => r.id);
  assert.notEqual(noBug.indexOf('beta.t-bug'), ids.indexOf('beta.t-bug'), 'without kind bug it is ordered like any card');
});

test('runner: a pushed card, then bugs, then priority', () => {
  const c = (id: string, priority: string, more: Partial<Candidate> = {}): Candidate => ({ id, goal: 'web', lane: 'claude', priority, touches: [], ...more });
  const { picked } = pickCards({
    ready: [c('web.t-p0', 'p0'), c('web.t-bug3', 'p3', { kind: 'bug' }), c('web.t-p1', 'p1'), c('web.t-bug1', 'p1', { kind: 'bug' }), c('web.t-push', 'p3', { pushed: true })],
    running: [], cfg: { max_parallel: 9, daily_cap: 99 }, startedToday: 0, tools: new Set(['claude']), backoff: {}, repos: new Map([['web', '/r/web']]), now: new Date(),
  });
  assert.deepEqual(picked.map((p) => p.card), ['web.t-push', 'web.t-bug1', 'web.t-bug3', 'web.t-p0', 'web.t-p1']);
  const one = pickCards({ ready: [c('web.t-p0', 'p0'), c('web.t-bug3', 'p3', { kind: 'bug' })], running: [], cfg: { max_parallel: 1, daily_cap: 99 }, startedToday: 0,
    tools: new Set(['claude']), backoff: {}, repos: new Map([['web', '/r/web']]), now: new Date() });
  assert.deepEqual(one.picked.map((p) => p.card), ['web.t-bug3'], 'one slot: the bug fix takes it');
});

test('schema 3: a board at schema 2 moves to 3 with no file but the stamp changed, and its bug cards load', () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-bug', kind: 'bug' })]);
  try {
    fs.writeFileSync(path.join(root, SCHEMA_REL), schemaContent(2));
    execFileSync('git', ['-C', root, 'commit', '-qam', 'schema 2']);
    const m = migrateBoard(root);
    assert.deepEqual([m.from, m.to], [2, 3]);
    assert.equal(boardSchema(root), 3);
    assert.deepEqual(execFileSync('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim().split('\n'), [SCHEMA_REL]);
    const b = loadBoard(root);
    assert.deepEqual(b.loadErrors, []);
    assert.equal(b.tasks.find((t) => t.id === 'beta.t-bug')!.kind, 'bug');
  } finally { cleanup(); }
});
