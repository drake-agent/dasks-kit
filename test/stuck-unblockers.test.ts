import { test } from 'node:test';
import assert from 'node:assert/strict';
import { task, tempRepo } from './helpers.ts';
import { stuckReport } from '../src/lib/stuck.ts';
import { digestText } from '../src/lib/digest.ts';
import type { Task } from '../src/lib/schema.ts';

const NOW = new Date('2026-10-22T14:22:00Z');
const card = (id: string, over: Partial<Task> = {}) => task({ id: `beta.t-${id}`, title: id, updated: NOW.toISOString(), ...over });

test('unblockers and digest suggest independent roots beside a 22-level chain', () => {
  const tasks = [
    ...Array.from({ length: 23 }, (_, i) => card(`c${i}`, i ? { depends_on: `beta.t-c${i - 1}` } : {})),
    card('fan'),
    ...Array.from({ length: 10 }, (_, i) => card(`fan-${i}`, { depends_on: 'beta.t-fan' })),
  ];
  const expected = [
    { id: 'beta.t-c0', title: 'c0', unblocks: 22 },
    { id: 'beta.t-fan', title: 'fan', unblocks: 10 },
  ];
  assert.deepEqual(stuckReport({ tasks }, NOW).unblockers, expected);
  assert.deepEqual(stuckReport({ tasks: [...tasks].reverse() }, NOW).unblockers, expected);
  const tmp = tempRepo(tasks);
  try {
    const lines = digestText(tmp.root, NOW.toISOString()).split('\n').filter((line) => line.startsWith('- Unblock '));
    assert.deepEqual(lines, [
      '- Unblock beta.t-c0: c0 (22 dependants)',
      '- Unblock beta.t-fan: fan (10 dependants)',
    ]);
  } finally { tmp.cleanup(); }
});

test('missing and cyclic dependencies exclude candidates while closed dependencies allow them', () => {
  const tasks = [
    card('msng', { depends_on: 'beta.t-absnt', updated: '2026-10-01T00:00:00Z' }),
    card('afmsg', { depends_on: 'beta.t-msng' }),
    card('cyc-a', { depends_on: 'beta.t-cyc-b' }),
    card('cyc-b', { depends_on: 'beta.t-cyc-a' }),
    card('afcyc', { depends_on: 'beta.t-cyc-a' }),
    card('done', { status: 'done', depends_on: 'beta.t-absnt' }),
    card('cncld', { status: 'cancelled' }),
    card('root', { depends_on: 'beta.t-done, beta.t-cncld' }),
    card('leaf', { depends_on: 'beta.t-root' }),
  ];
  assert.deepEqual(stuckReport({ tasks }, NOW).unblockers, [
    { id: 'beta.t-root', title: 'root', unblocks: 1 },
  ]);
});
