// Code map: import extraction per language, the bounded map build from a git tree, the runner's cache, and the
// warn-only "one import apart" check between two cards' touch lists (docs/runner.md "Code map").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stripComments, swiftTargets } from '../src/lib/codemap/imports.ts';
import { buildMap, codemapCache, LIMITS, mapFromTree, type CodeMap } from '../src/lib/codemap/map.ts';
import { claimWarnings, importPairs, importWarning } from '../src/lib/codemap/overlap.ts';
import { assertTouchesFree } from '../src/lib/claim-guard.ts';
import type { Task } from '../src/lib/schema.ts';

const mapOf = (files: Record<string, string>) => mapFromTree('r', 'abcdef1234', Object.keys(files), (f) => files[f], 'now');
const edges = (m: CodeMap) => m.edges.map(([a, b]) => `${a} -> ${b}`).sort();

test('TS/JS: relative imports, exports, require, dynamic import; extensions, index, .js naming a .ts; packages dropped', () => {
  const m = mapOf({
    'src/a.ts': "import { b } from './b';\nexport * from \"./d\";\nimport './side.js';\nconst c = require('../lib/c');\nimport x from 'left-pad';\n// import { gone } from './gone';\n/* import './gone' */\nawait import('./b.ts');\n",
    'src/b.ts': '', 'src/d/index.ts': '', 'src/side.ts': '', 'lib/c.cjs': '', 'src/gone.ts': '',
  });
  assert.deepEqual(edges(m), ['src/a.ts -> lib/c.cjs', 'src/a.ts -> src/b.ts', 'src/a.ts -> src/d/index.ts', 'src/a.ts -> src/side.ts']);
});

test('comments: a /* inside a // comment does not hide the imports after it; strings are kept', () => {
  assert.equal(stripComments("a // x /* y\nb '//not' /* c */ d"), "a \nb '//not'   d");
  const m = mapOf({ 'a.ts': "// see /* here\nimport { b } from './b';\n", 'b.ts': '' });
  assert.deepEqual(edges(m), ['a.ts -> b.ts']);
});

test('Python: absolute from the top package dir or the root, from-import of a submodule, relative imports', () => {
  const m = mapOf({
    'pkg/__init__.py': '',
    'pkg/main.py': 'import pkg.mod\nfrom pkg import mod2\nfrom . import sib\nfrom .sub.deep import (\n  thing,\n)\nimport os, json\n',
    'pkg/mod.py': '', 'pkg/mod2.py': '', 'pkg/sib.py': '', 'pkg/sub/__init__.py': '', 'pkg/sub/deep.py': '',
    'tools/run.py': 'from pkg.mod import f\n',
  });
  assert.deepEqual(edges(m), ['pkg/main.py -> pkg/mod.py', 'pkg/main.py -> pkg/mod2.py', 'pkg/main.py -> pkg/sib.py', 'pkg/main.py -> pkg/sub/deep.py', 'tools/run.py -> pkg/mod.py']);
});

test('Rust: mod declarations, crate/self/super paths to the longest module file; other crates dropped', () => {
  const m = mapOf({
    'Cargo.toml': '[package]\nname = "x"\n',
    'src/lib.rs': 'mod x;\npub mod y;\nuse serde::Serialize;\n',
    'src/x.rs': 'use crate::y::z::Thing;\nuse crate::{y};\n',
    'src/y/mod.rs': 'mod z;\nuse super::x;\n',
    'src/y/z.rs': 'use self::inner;\n',
  });
  assert.deepEqual(edges(m), ['src/lib.rs -> src/x.rs', 'src/lib.rs -> src/y/mod.rs', 'src/x.rs -> src/y/mod.rs', 'src/x.rs -> src/y/z.rs', 'src/y/mod.rs -> src/x.rs', 'src/y/mod.rs -> src/y/z.rs']);
});

test('Swift: import of a SwiftPM target is an edge to its dir; a .target() inside dependencies is not a target', () => {
  const pkg = 'let package = Package(name: "P", targets: [\n  .executableTarget(name: "App", dependencies: [.target(name: "Core"), .target(name: "Ghost")]),\n  .target(name: "Core", path: "Lib/Core"),\n  .testTarget(name: "AppTests", dependencies: ["App"]),\n])\n';
  assert.deepEqual(swiftTargets('Package.swift', pkg).map((t) => `${t.name}:${t.dir}`), ['App:Sources/App/', 'Core:Lib/Core/', 'AppTests:Tests/AppTests/']);
  const m = mapOf({ 'Package.swift': pkg, 'Sources/App/main.swift': 'import Foundation\nimport Core\nimport Ghost\n', 'Lib/Core/Core.swift': 'import Core\n', 'Tests/AppTests/T.swift': '@testable import App\n' });
  assert.deepEqual(edges(m), ['Sources/App/main.swift -> Lib/Core/', 'Tests/AppTests/T.swift -> Sources/App/']);
});

test('one import apart: either direction, file entries only, nothing when the touches overlap, a new file has no edges', () => {
  const m = mapOf({ 'src/a.ts': "import './b';\n", 'src/b.ts': '', 'Package.swift': '.target(name: "Core")', 'Sources/Core/C.swift': '', 'Sources/App/m.swift': 'import Core\n' });
  assert.deepEqual(importPairs(['src/a.ts'], ['src/b.ts'], m), [['src/a.ts', 'src/b.ts']]);
  assert.deepEqual(importPairs(['src/b.ts', 'docs/x.md'], ['./src/a.ts'], m), [['src/a.ts', 'src/b.ts']]);
  assert.deepEqual(importPairs(['src/'], ['src/b.ts'], m), [], 'a dir entry overlaps: the lock covers it');
  assert.deepEqual(importPairs(['src/*.ts'], ['lib/x.ts'], m), []);
  assert.deepEqual(importPairs(['Sources/App/m.swift'], ['Sources/Core/C.swift'], m), [['Sources/App/m.swift', 'Sources/Core/C.swift']]);
  assert.deepEqual(importPairs(['Sources/App/m.swift'], ['Sources/Core/New.swift'], m), [], 'a file new in the card is not in the map');
  const view = { map: m, stale: true };
  assert.equal(importWarning('my-app.t-one', ['src/b.ts'], 'my-app.t-two', ['src/a.ts'], view), 'warning: my-app.t-one is one import from my-app.t-two: src/a.ts imports src/b.ts (map abcdef1, stale), not held');
  assert.equal(importWarning('x', ['src/b.ts'], 'y', ['src/a.ts'], null), '', 'no map, no warning');
  assert.deepEqual(claimWarnings('x', ['src/b.ts'], [{ id: 'y', touches: ['src/a.ts'] }, { id: 'z', touches: ['README.md'] }, null, 'junk'], view).length, 1);
  assert.deepEqual(claimWarnings('x', ['src/b.ts'], undefined, view), [], 'an older board sends no beside list');
});

test('claim guard: returns the claimed doing cards beside the card (with touches), still refuses an overlap', () => {
  const t = (id: string, touches: string, extra: Partial<Task> = {}) => ({ id, goal: 'my-app', status: 'doing', claimed_by: 'runner@m', body: `touches: ${touches}\n`, ...extra }) as Task;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-guard-'));
  const me = t('my-app.t-me', 'src/b.ts', { status: 'todo', claimed_by: '' });
  assert.deepEqual(assertTouchesFree(root, me, [t('my-app.t-a', 'src/a.ts'), t('my-app.t-free', 'src/c.ts', { claimed_by: '' }), t('my-app.t-none', 'none')], []),
    [{ id: 'my-app.t-a', touches: ['src/a.ts'] }]);
  assert.throws(() => assertTouchesFree(root, me, [t('my-app.t-b', 'src/')], []), /touches overlap my-app\.t-b/);
  fs.rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string>): { dir: string; sha: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-repo-'));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  g('add', '-A'); g('commit', '-qm', 'x');
  const sha = g('rev-parse', 'HEAD');
  g('update-ref', 'refs/remotes/origin/main', sha);
  fs.writeFileSync(path.join(dir, 'src/b.ts'), "import './a';\n");   // the working tree is never read
  return { dir, sha };
}

test('buildMap: reads the git tree at the commit, not the working tree; past the limits it is truncated, not failed', async () => {
  const { dir, sha } = repo({ 'src/a.ts': "import { b } from './b';\n", 'src/b.ts': 'export const b = 1;\n', 'big.ts': `import './src/a';\n${'x'.repeat(200)}` });
  const m = await buildMap(dir, sha);
  assert.equal(m.sha, sha);
  assert.deepEqual(edges(m), ['big.ts -> src/a.ts', 'src/a.ts -> src/b.ts']);
  assert.equal(m.truncated, false);
  const small = await buildMap(dir, sha, { ...LIMITS, blobBytes: 100 });
  assert.deepEqual(edges(small), ['src/a.ts -> src/b.ts'], 'a blob over blobBytes is not read');
  const few = await buildMap(dir, sha, { ...LIMITS, files: 1 });
  assert.equal(few.truncated, true);
  assert.equal(few.files.length, 3);
  await assert.rejects(buildMap(dir, '0'.repeat(40)), /git ls-tree/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runner cache: builds once per head, saves to disk, a failed build keeps the last map (stale) and logs one line', async () => {
  const { dir, sha } = repo({ 'src/a.ts': "import './b';\n", 'src/b.ts': '' });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-state-'));
  const lines: string[] = [];
  let builds = 0;
  const c = codemapCache(state, (l) => lines.push(l), (d, s) => { builds++; return buildMap(d, s); });
  assert.equal(c.view(dir), null);
  await c.refresh([dir]); await c.refresh([dir]);
  assert.equal(builds, 1);
  assert.equal(c.view(dir)?.map.sha, sha);
  assert.equal(c.view(dir)?.stale, false);
  assert.match(lines[0], /^code map: .* at [0-9a-f]{7}: 2 files, 1 imports$/);
  assert.equal(codemapCache(state, () => {}).view(dir)?.map.sha, sha, 'a restarted runner reads the saved map');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'y'], { cwd: dir });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
  const failing = codemapCache(state, (l) => lines.push(l), async () => { throw new Error('boom'); });
  await failing.refresh([dir]);
  assert.equal(failing.view(dir)?.stale, true);
  assert.match(lines.at(-1)!, /not built at [0-9a-f]{7} \(boom\); map [0-9a-f]{7} stays, stale/);
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true });
});
