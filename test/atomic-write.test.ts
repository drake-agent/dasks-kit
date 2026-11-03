// atomicWrite durability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../src/lib/write.ts';

test('atomicWrite: fsync of the temp file before the rename, of the directory after it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-atomic-'));
  const target = path.join(dir, 'sub', 'file.json');
  const opened = new Map<number, string>();
  const events: string[] = [];
  const { openSync, fsyncSync, renameSync } = fs;
  (fs as any).openSync = (p: fs.PathLike, ...rest: any[]) => { const fd = (openSync as any)(p, ...rest); opened.set(fd, String(p)); return fd; };
  (fs as any).fsyncSync = (fd: number) => { events.push(`fsync ${opened.get(fd)}`); return fsyncSync(fd); };
  (fs as any).renameSync = (a: fs.PathLike, b: fs.PathLike) => { events.push(`rename ${b}`); return renameSync(a, b); };
  try {
    atomicWrite(target, '{"a":1}\n');
  } finally { Object.assign(fs, { openSync, fsyncSync, renameSync }); }
  try {
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}\n');
    assert.equal(events.length, 3, events.join('\n'));
    assert.match(events[0], /^fsync .*\/sub\/\.file\.json\.\d+\.[0-9a-f]{12}\.tmp$/);
    assert.equal(events[1], `rename ${target}`);
    assert.equal(events[2], `fsync ${path.dirname(target)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
