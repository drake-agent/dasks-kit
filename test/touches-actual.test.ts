// A card's PR file list (touches_actual / touches_sha): stored on the task, held by the claim check, written by the runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError, updateTask } from '../src/lib/write.ts';
import { assertTouchesFree } from '../src/lib/claim-guard.ts';
import { loadBoard } from '../src/lib/load.ts';
import { lockTouches, normTouchesValue, prFilesRoute, storedTouches, TOUCHES_CAP } from '../src/lib/touches-actual.ts';
import { recordPrFiles } from '../src/lib/run-flow.ts';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

const SHA = 'a'.repeat(40);
const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return e instanceof HttpError ? e.status : -1; } };

test('storedTouches: cleaned, deduped, sorted; a comma path becomes its folder; never the whole repo', () => {
  assert.deepEqual(storedTouches([' src/b.ts', './src//a.ts', 'src/a.ts', 'README.md']), ['README.md', 'src/a.ts', 'src/b.ts']);
  assert.deepEqual(storedTouches(['docs/x/a,b.png', 'a,b.txt', '../up.ts', '.', '']), ['docs/x/']);
  assert.deepEqual(storedTouches(['src/lib/']), ['src/lib/'], 'a folder entry keeps its slash');
});

test('storedTouches: over the cap a list is shortened to folders, deepest first; root files stay; too big is []', () => {
  const many = Array.from({ length: 300 }, (_, i) => `src/lib/deep/file-number-${i}.ts`);
  const short = storedTouches([...many, 'src/other/x.ts', 'package.json']);
  assert.deepEqual(short, ['package.json', 'src/lib/deep/', 'src/other/x.ts']);
  assert.ok(many.join(', ').length > TOUCHES_CAP);
  assert.deepEqual(storedTouches(['aaaa/x.ts', 'bbbb/y.ts'], 5), []);
});

test('normTouchesValue: a string or a list; another type is refused (null); empty clears', () => {
  assert.equal(normTouchesValue('b.ts, a.ts'), 'a.ts, b.ts');
  assert.equal(normTouchesValue(['a.ts', 'a.ts']), 'a.ts');
  assert.equal(normTouchesValue(null), '');
  assert.equal(normTouchesValue(7), null);
  assert.equal(normTouchesValue(['a', 1]), null);
});

test('lockTouches: the stored PR list when there is one, else the plan; a root-only entry never holds the repo', () => {
  assert.deepEqual(lockTouches({ touches_actual: 'src/a.ts, docs/b.md' }, ['src']), ['src/a.ts', 'docs/b.md']);
  assert.deepEqual(lockTouches({ touches_actual: '' }, ['src']), ['src']);
  assert.deepEqual(lockTouches({}, []), []);
  assert.deepEqual(lockTouches({ touches_actual: './' }, ['src']), ['src']);
  // A real root file with a bracket is that one file (escaped), never the whole repo.
  assert.deepEqual(lockTouches({ touches_actual: '[x].md' }, ['src']), ['\\[x\\].md']);
});

test('prFilesRoute: GitHub PR links only', () => {
  assert.equal(prFilesRoute('https://github.com/example-org/my-app/pull/12'), 'repos/example-org/my-app/pulls/12/files?per_page=100');
  assert.equal(prFilesRoute('https://example.invalid/x/y/pull/1'), null);
  assert.equal(prFilesRoute(''), null);
});

test('write: the two fields are stored and checked; a files-only write keeps `updated`; a new PR link or a cleared list drops both', () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one', pr: 'https://github.com/example-org/my-app/pull/1' })]);
  try {
    const a = updateTask(root, 'beta.t-one', { touches_actual: ['src/b.ts', 'src/a.ts'], touches_sha: SHA.toUpperCase() }, 'runner@box');
    assert.equal(a.touches_actual, 'src/a.ts, src/b.ts');
    assert.equal(a.touches_sha, SHA);
    assert.equal(a.updated, '2026-10-10T10:00:00+09:00', 'not progress');
    assert.equal(a.version, '1');
    assert.equal(loadBoard(root).tasks.find((t) => t.id === 'beta.t-one')!.touches_actual, 'src/a.ts, src/b.ts');
    assert.equal(status(() => updateTask(root, 'beta.t-one', { touches_sha: 'abc' }, 'runner@box')), 400);
    assert.equal(status(() => updateTask(root, 'beta.t-one', { touches_actual: 5 }, 'runner@box')), 400);
    const b = updateTask(root, 'beta.t-one', { touches_actual: '' }, 'runner@box');
    assert.equal(b.touches_actual ?? '', ''); assert.equal(b.touches_sha ?? '', '');
    updateTask(root, 'beta.t-one', { touches_actual: 'src/a.ts', touches_sha: SHA }, 'runner@box');
    const c = updateTask(root, 'beta.t-one', { pr: 'https://github.com/example-org/my-app/pull/2' }, 'runner@box');
    assert.equal(c.touches_actual ?? '', ''); assert.equal(c.touches_sha ?? '', '');
    assert.equal(updateTask(root, 'beta.t-one', { touches_actual: '' }, 'runner@box').version, c.version, 'clearing nothing is no write');
  } finally { cleanup(); }
});

test('API: a task write takes the list as an array and the board serves it back', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  const s = await serve(root);
  try {
    const r = await s.post('/api/tasks/beta.t-one', { touches_actual: ['src/b.ts', 'src/a.ts'], touches_sha: SHA }, 'runner@box');
    assert.equal(r.status, 200, await r.text());
    const t = await (await fetch(`${s.url}/api/tasks/beta.t-one`)).json();
    assert.equal(t.touches_actual, 'src/a.ts, src/b.ts');
    assert.equal(t.touches_sha, SHA);
    assert.equal((await s.post('/api/tasks/beta.t-one', { touches_sha: 'nope' }, 'runner@box')).status, 400);
  } finally { await s.stop(); cleanup(); }
});

test('write: a long PR list never makes a write fail on the size limit', () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-big', body: '\n## Context\n' + 'x'.repeat(7000) + '\n' })]);
  try {
    const files = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    const t = updateTask(root, 'beta.t-big', { touches_actual: files, touches_sha: SHA }, 'runner@box', { body: '\n## Context\n' + 'x'.repeat(7000) + '\n' });
    assert.ok(t.touches_actual!.length > 1000);
    // A job's failure block still fits: the list is left out of that size too.
    const u = updateTask(root, 'beta.t-big', {}, 'runner@box', { appendBlock: { heading: 'Job failure', lines: ['build failed: see job log'] } });
    assert.match(u.body, /## Job failure[\s\S]*build failed/);
  } finally { cleanup(); }
});

test('claim check: a doing card holds its PR files, not its plan', () => {
  const projects = [{ id: 'beta', name: 'Beta', repo: '/r/beta' }];
  const other = task({ id: 'beta.t-other', status: 'doing', claimed_by: 'runner@two', body: 'touches: src/\n' } as any);
  const mine = task({ id: 'beta.t-mine', body: 'touches: src/a/x.ts\n' });
  const { root, cleanup } = tempRepo([other, mine]);
  try {
    assert.throws(() => assertTouchesFree(root, mine, [other], projects as any), (e: any) => e.status === 409 && /beta\.t-other/.test(e.message));
    // Each side counts its own PR files (a card worked again has its own list too).
    const reworked = { ...mine, body: 'touches: docs/\n', touches_actual: 'src/shared.ts' };
    assert.throws(() => assertTouchesFree(root, reworked, [{ ...other, body: 'touches: src/shared.ts\n' }], projects as any), (e: any) => e.status === 409);
    const narrowed = { ...other, touches_actual: 'src/b/y.ts' };
    assert.doesNotThrow(() => assertTouchesFree(root, mine, [narrowed], projects as any), 'the PR changes other files');
    assert.throws(() => assertTouchesFree(root, mine, [{ ...other, body: 'touches: docs/\n', touches_actual: 'src/a/x.ts' }], projects as any), (e: any) => e.status === 409);
  } finally { cleanup(); }
});

test('claim check: a PR file whose name holds glob characters locks as that one file, not its whole folder', () => {
  // A real file app/[id]/page.tsx used to read as a pattern cut at `[`: it held all of app/ and blocked unrelated cards.
  const projects = [{ id: 'beta', name: 'Beta', repo: '/r/beta' }];
  const other = task({ id: 'beta.t-other', status: 'doing', claimed_by: 'runner@two', body: 'touches: app/\n', touches_actual: 'app/[id]/page.tsx, [slug].ts' } as any);
  const { root, cleanup } = tempRepo([other]);
  try {
    assert.deepEqual(lockTouches(other, ['app']), ['app/\\[id\\]/page.tsx', '\\[slug\\].ts']);
    const at = (planned: string) => task({ id: 'beta.t-mine', body: `touches: ${planned}\n` });
    assert.doesNotThrow(() => assertTouchesFree(root, at('app/settings.ts'), [other], projects as any), 'another file in app/ is free');
    assert.throws(() => assertTouchesFree(root, at('app/'), [other], projects as any), (e: any) => e.status === 409, 'the folder holding it overlaps');
    assert.throws(() => assertTouchesFree(root, { ...at('docs/'), touches_actual: 'app/[id]/page.tsx' } as any, [other], projects as any), (e: any) => e.status === 409, 'the same real file overlaps');
    assert.throws(() => assertTouchesFree(root, { ...at('docs/'), touches_actual: '[slug].ts' } as any, [other], projects as any), (e: any) => e.status === 409, 'a root file with a bracket is kept, not dropped');
  } finally { cleanup(); }
});

function fakeGh(script: string): { restore: () => void; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-gh-'));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev}`;
  return { dir, restore: () => { process.env.PATH = prev; fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('runner: the PR head file list (renames by both names) is written to the card; a short or failed list writes nothing', async () => {
  const PR = 'https://github.com/example-org/my-app/pull/7';
  const calls: any[] = [], logs: string[] = [];
  const env = { api: async (method: string, route: string, body?: unknown) => { calls.push({ method, route, body }); return {}; }, log: (l: string) => { logs.push(l); } };
  const gh = fakeGh(`case "$1" in
  pr) echo '{"headRefOid":"${SHA}","changedFiles":'"\${FAKE_COUNT:-2}"'}' ;;
  api) printf 'src/new.ts\\tsrc/old.ts\\nREADME.md\\t\\n' ;;
esac`);
  try {
    await recordPrFiles(env, 'beta.t-one', PR);
    assert.deepEqual(calls, [{ method: 'POST', route: '/api/tasks/beta.t-one', body: { touches_actual: ['src/new.ts', 'src/old.ts', 'README.md'], touches_sha: SHA } }]);
    process.env.FAKE_COUNT = '3';
    await recordPrFiles(env, 'beta.t-one', PR);
    assert.equal(calls.length, 2, 'a list shorter than the PR is not stored');
    assert.match(logs.join('\n'), /2 of 3 files listed/);
    assert.deepEqual(calls[1].body, { touches_actual: '' }, 'a list from an older head is dropped, so the plan holds');
    await recordPrFiles(env, 'beta.t-one', 'https://example.invalid/pr/1');
    assert.equal(calls.length, 2, 'not a GitHub PR: nothing read');
  } finally { delete process.env.FAKE_COUNT; gh.restore(); }
});
