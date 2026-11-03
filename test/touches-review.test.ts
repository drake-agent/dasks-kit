import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTouches, touchesErrors } from '../src/lib/touches.ts';


test('a leading ./ keeps a root glob or whole-repo marker, and it still overlaps', () => {
  for (const t of ['./**/*.ts', './*.json', './*/x', './**', '././**/*.ts']) {
    assert.deepEqual(parseTouches(t), [t], t);
    assert.deepEqual(touchesErrors(t), [], t);
  }
});

test('a leading ./ does not let prose reach the root', () => {
  for (const t of ['./**note**', './*', './why?', './**/', './../', './[src/a.ts']) {
    assert.deepEqual(parseTouches(t), [], t);
    assert.ok(touchesErrors(t).length > 0, t);
  }
});
