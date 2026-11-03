import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTask } from '../src/lib/check.ts';
import { createTask, updateTask } from '../src/lib/write.ts';
import { loadBoard } from '../src/lib/load.ts';
import { task, tempRepo } from './helpers.ts';

test('a card can declare secret labels; they are deduped and round-trip through the file', () => {
  const { root, cleanup } = tempRepo([task({ id: 'delta.t-keys' })]);
  try {
    const t = updateTask(root, 'delta.t-keys', { secrets: 'google-places-api-key, throwaway-probe google-places-api-key' }, 'claude-code@laptop');
    assert.equal(t.secrets, 'google-places-api-key, throwaway-probe');
    const again = loadBoard(root).tasks.find((x) => x.id === 'delta.t-keys');
    assert.equal(again?.secrets, 'google-places-api-key, throwaway-probe');
    const cleared = updateTask(root, 'delta.t-keys', { secrets: '' }, 'claude-code@laptop');
    assert.ok(!cleared.secrets);
  } finally { cleanup(); }
});

test('create accepts secrets as a list', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    const t = createTask(root, { goal: 'delta', title: 'needs a key', secrets: ['elevenlabs-api-key'] } as any, 'claude-code@laptop');
    assert.equal(t.secrets, 'elevenlabs-api-key');
  } finally { cleanup(); }
});

test('bad labels and too many labels are refused; values never look like labels', () => {
  const bad = checkTask({ ...task({ id: 'delta.t-k' }), secrets: 'Bad_Label, sk-live/abc' } as any);
  assert.equal(bad.filter((e) => /^secrets: item \d+ is not a secret label name$/.test(e)).length, 2);
  assert.ok(!bad.join(' ').includes('sk-live'));
  const many = checkTask({ ...task({ id: 'delta.t-k' }), secrets: Array.from({ length: 9 }, (_, i) => `k${i}`).join(', ') } as any);
  assert.ok(many.some((e) => e.includes('at most 8')));
  assert.deepEqual(checkTask({ ...task({ id: 'delta.t-k' }), secrets: 'throwaway-probe' } as any).filter((e) => e.startsWith('secrets')), []);
});
