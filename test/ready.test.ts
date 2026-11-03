import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyQueue, depsOf } from '../src/lib/ready.ts';
import { checkTask } from '../src/lib/check.ts';
import { normDeps } from '../src/lib/write.ts';
const T = (id: string, o: any = {}) => ({ id, title: id, goal: 'delta', status: 'todo', priority: 'p2', lane: 'none', owner: 'x', created: '2026-10-01', ...o });
test('no depends_on: every unclaimed todo card is ready', () => {
  const r = readyQueue({ tasks: [T('delta.t-a'), T('delta.t-b', { status: 'doing' })] as any });
  assert.deepEqual(r.ready.map((x) => x.id), ['delta.t-a']);
});
test('blocked until deps done; ranked by unblocks', () => {
  const tasks = [T('delta.t-a'), T('delta.t-b', { depends_on: 'delta.t-a' }), T('delta.t-c', { depends_on: 'delta.t-b' }), T('delta.t-z', { priority: 'p0' })] as any;
  const r = readyQueue({ tasks });
  assert.deepEqual(r.ready.map((x) => [x.id, x.unblocks]), [['delta.t-a', 2], ['delta.t-z', 0]]);
  assert.deepEqual(r.blocked.map((b) => b.id).sort(), ['delta.t-b', 'delta.t-c']);
  tasks[0].status = 'done';
  assert.deepEqual(readyQueue({ tasks }).ready.map((x) => x.id), ['delta.t-b', 'delta.t-z']);
});
test('claimed excluded, missing dep blocks, cycles reported, goal filter', () => {
  const r = readyQueue({ tasks: [T('delta.t-a', { claimed_by: 'q' }), T('delta.t-m', { depends_on: 'delta.t-nope', updated: new Date().toISOString() }), T('delta.t-x', { depends_on: 'delta.t-y' }), T('delta.t-y', { depends_on: 'delta.t-x' }), T('beta.t-d', { goal: 'beta' })] as any }, { goal: ['delta'] });
  assert.equal(r.ready.length, 0);
  assert.deepEqual(r.blocked.find((b) => b.id === 'delta.t-m')!.missing, ['delta.t-nope']);
  assert.ok(r.cycles.length >= 1);
});
test('normDeps and check', () => {
  assert.equal(normDeps(['delta.t-a', ' delta.t-b', 'delta.t-a']), 'delta.t-a, delta.t-b');
  assert.deepEqual(depsOf({ depends_on: 'a, b c' }), ['a', 'b', 'c']);
  const errs = checkTask({ ...T('delta.t-a'), depends_on: 'delta.t-a, BAD' } as any);
  assert.ok(errs.some((e) => e.includes('itself')) && errs.some((e) => e.includes('bad task id')));
});

test('a cancelled dependency blocks (cancelled: [id]); done frees; mixed done+cancelled blocks; missing unchanged', () => {
  const now = new Date('2026-11-02T03:00:00Z');
  const fresh = '2026-11-02T02:00:00Z';
  const tasks = [
    T('shared.t-prnt', { status: 'cancelled' }), T('shared.t-ok', { status: 'done' }),
    T('shared.t-child', { depends_on: 'shared.t-prnt' }),
    T('shared.t-free', { depends_on: 'shared.t-ok' }),
    T('shared.t-mixed', { depends_on: 'shared.t-ok, shared.t-prnt' }),
    T('shared.t-miss', { depends_on: 'shared.t-nope', updated: fresh }),
  ] as any;
  const r = readyQueue({ tasks }, { now });
  assert.deepEqual(r.ready.map((x) => x.id), ['shared.t-free']);
  const b = (id: string) => r.blocked.find((x) => x.id === id)!;
  assert.deepEqual(b('shared.t-child'), { id: 'shared.t-child', title: 'shared.t-child', waiting_on: [], missing: [], cancelled: ['shared.t-prnt'] });
  assert.deepEqual(b('shared.t-mixed').cancelled, ['shared.t-prnt']);
  assert.deepEqual(b('shared.t-mixed').waiting_on, []);
  assert.deepEqual(b('shared.t-miss'), { id: 'shared.t-miss', title: 'shared.t-miss', waiting_on: [], missing: ['shared.t-nope'], cancelled: [] });
  // relinking to the successor (done) frees the child
  tasks[2].depends_on = 'shared.t-ok';
  assert.ok(readyQueue({ tasks }, { now }).ready.some((x) => x.id === 'shared.t-child'));
});
