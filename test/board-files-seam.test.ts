// Board files seam (docs/storage.md): only src/lib/board-files.ts and the store behind it touch the board's git-tracked
// data/ files with node:fs. Any other src/ or bin/ file that names a data/ path and calls a node:fs file function must
// use board-files, or mark that line `// not-board: <why>` (it touches run/, config.json, a log, .git or the
// gitignored data/decisions/ ledger). A reader left on node:fs would read stale disk files once the store is not git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['src/lib/board-files.ts', 'src/lib/board-sqlite.ts']);
/** A board data path literal: 'data', "data/…", `data/…`. data/decisions/ is gitignored, not a board file. */
const DATA_PATH = /['"`]data(?:['"`]|\/(?!decisions\b))/;
const FS_CALL = /\bfs\.(readFileSync|readdirSync|existsSync|statSync|lstatSync|realpathSync|writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|mkdirSync|openSync|copyFileSync)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|mjs)$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

test('only board-files.ts calls node:fs on board data paths; other lines say why they are not board files', () => {
  const bad: string[] = [];
  for (const abs of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin'))]) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    if (!lines.some((l) => DATA_PATH.test(l))) continue;
    lines.forEach((l, i) => { if (FS_CALL.test(l) && !/\/\/ not-board:/.test(l)) bad.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(bad, [], `use src/lib/board-files.ts (or mark the line "// not-board: <why>"):\n${bad.join('\n')}`);
});
