// Shared page chrome (public/chrome.js and chrome.css).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PUB = path.resolve(import.meta.dirname, '../public');
const read = (f: string) => fs.readFileSync(path.join(PUB, f), 'utf8');



test('every page script parses (a broken line blanks a whole page)', () => {
  for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(PUB, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
