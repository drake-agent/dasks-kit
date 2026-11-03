import { test } from 'node:test';
import assert from 'node:assert/strict';

test('fixture fails', () => {
  assert.fail('test-wall fixture failure');
});
