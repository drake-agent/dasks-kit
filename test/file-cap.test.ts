import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capFile } from '../src/lib/file-cap.ts';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'file-cap-')), 'x.log');
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i).padStart(4, '0')}`).join('\n') + '\n';

test('under the cap nothing changes; a missing file is no error', () => {
  const f = tmp();
  assert.equal(capFile(f, 100, 50), false);
  fs.writeFileSync(f, 'a\nb\n');
  assert.equal(capFile(f, 100, 50), false);
  assert.equal(fs.readFileSync(f, 'utf8'), 'a\nb\n');
});

test('over the cap only the newest whole lines stay, within the keep size', () => {
  const f = tmp();
  fs.writeFileSync(f, lines(1000));
  assert.equal(capFile(f, 1000, 200), true);
  const out = fs.readFileSync(f, 'utf8');
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith('line 0999\n'));
  for (const l of out.trimEnd().split('\n')) assert.match(l, /^line \d{4}$/);
});

test('a process holding the file open for append (launchd stdout) keeps writing after the kept lines, same inode', () => {
  const f = tmp();
  const fd = fs.openSync(f, 'a');
  fs.writeSync(fd, lines(1000));
  const ino = fs.statSync(f).ino;
  assert.equal(capFile(f, 1000, 200), true);
  fs.writeSync(fd, 'after the cut\n');
  fs.closeSync(fd);
  assert.equal(fs.statSync(f).ino, ino);
  const out = fs.readFileSync(f, 'utf8');
  assert.ok(out.endsWith('line 0999\nafter the cut\n'), out.slice(-40));
  assert.ok(!out.includes('\0'));
});

test('a window with no line break leaves the file as it is', () => {
  const f = tmp();
  fs.writeFileSync(f, 'x'.repeat(5000));
  assert.equal(capFile(f, 1000, 200), false);
  assert.equal(fs.statSync(f).size, 5000);
});
