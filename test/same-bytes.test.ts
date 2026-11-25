// Secret compares: one helper that checks the length first, and no other timingSafeEqual call in the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sameBytes } from '../src/lib/same-bytes.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('sameBytes: equal bytes true; other bytes or another length false, never a throw', () => {
  assert.equal(sameBytes(Buffer.from('abc'), Buffer.from('abc')), true);
  assert.equal(sameBytes(Buffer.from('abc'), Buffer.from('abd')), false);
  assert.equal(sameBytes(Buffer.from('abc'), Buffer.from('abcd')), false);
  assert.equal(sameBytes(Buffer.from('é'), Buffer.from('e')), false, 'a multibyte value of another byte length');
  assert.equal(sameBytes(Buffer.alloc(0), Buffer.alloc(0)), true);
});

test('every secret compare goes through sameBytes: timingSafeEqual appears only in src/lib/same-bytes.ts', () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|mjs|js)$/.test(e.name) && fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('timingSafeEqual')) hits.push(rel);
    }
  };
  for (const d of ['src', 'bin', 'mcp', 'scripts']) walk(d);
  assert.deepEqual(hits, [path.join('src', 'lib', 'same-bytes.ts')]);
});
