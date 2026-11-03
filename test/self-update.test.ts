// Runner self-update (src/lib/self-update.ts): a kit clone fast-forwards to its remote's default branch and installs
// dependencies when the lockfile changed; it holds, and says why, on a dirty, diverged or off-branch checkout and when the
// new kit needs a board schema newer than the board's. The heartbeat carries the kit commit, and the board says which
// machines are behind its own kit. Temp repos stand in for the kit and its GitHub remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyUpdate, mayUpdate, planUpdate, schemaOfSource } from '../src/lib/self-update.ts';
import { kitCommitOf, parseHeartbeat } from '../src/lib/fleet.ts';
import { SCHEMA_VERSION } from '../src/lib/migrate.ts';
import { tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

const KIT_ROOT = path.resolve(import.meta.dirname, '..');
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const migrate = (n: number) => `export const MIGRATIONS = [\n${Array.from({ length: n }, (_, i) => `  { to: ${i + 1}, what: 'step', files: () => [] },`).join('\n')}\n];\n`;

/** upstream (a working repo that "lands PRs"), remote (bare, like GitHub) and kit (the runner's clone). */
function repos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-selfupdate-'));
  const up = path.join(base, 'up'), remote = path.join(base, 'remote.git'), kit = path.join(base, 'kit');
  fs.mkdirSync(up);
  git(up, 'init', '-q', '-b', 'main'); git(up, 'config', 'user.name', 't'); git(up, 'config', 'user.email', 't@example.invalid');
  const write = (dir: string, rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s); };
  write(up, 'src/lib/migrate.ts', migrate(1)); write(up, 'package-lock.json', '{"v":1}\n'); write(up, 'README.md', 'one\n'); write(up, '.gitignore', 'node_modules/\n'); write(up, 'package.json', '{"name":"k"}\n');
  git(up, 'add', '-A'); git(up, 'commit', '-qm', 'one');
  execFileSync('git', ['clone', '-q', '--bare', up, remote]);
  git(up, 'remote', 'add', 'origin', remote);
  execFileSync('git', ['clone', '-q', remote, kit]);
  git(kit, 'config', 'user.name', 't'); git(kit, 'config', 'user.email', 't@example.invalid');
  const land = (files: Record<string, string>) => { for (const [k, v] of Object.entries(files)) write(up, k, v); git(up, 'add', '-A'); git(up, 'commit', '-qm', 'land'); git(up, 'push', '-q', 'origin', 'main'); return git(up, 'rev-parse', 'HEAD'); };
  // A fake npm: like npm ci it empties node_modules where it runs, then installs (a marker) or fails when NPM_FAIL is set;
  // it records its arguments and folder.
  const npm = path.join(base, 'npm');
  fs.writeFileSync(npm, `#!/bin/sh\nrm -rf node_modules\n[ -n "$NPM_FAIL" ] && { echo boom >&2; exit 1; }\nmkdir node_modules && echo new > node_modules/new.txt\necho "$@ in $(pwd)" >> "${path.join(base, 'npm.log')}"\n`, { mode: 0o755 });
  // The runner's installed dependencies.
  fs.mkdirSync(path.join(kit, 'node_modules')); fs.writeFileSync(path.join(kit, 'node_modules/old.txt'), 'old');
  return { base, up, remote, kit, land, npm, npmLog: () => { try { return fs.readFileSync(path.join(base, 'npm.log'), 'utf8'); } catch { return ''; } }, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('gate: on by default only on a joined Mac, never while a card runs or the runner stops', () => {
  assert.equal(mayUpdate({ joined: true, busy: 0, stopping: false }), true);
  assert.equal(mayUpdate({ joined: false, busy: 0, stopping: false }), false, 'the board\'s own Mac: off unless asked');
  assert.equal(mayUpdate({ update: true, joined: false, busy: 0, stopping: false }), true);
  assert.equal(mayUpdate({ update: false, joined: true, busy: 0, stopping: false }), false);
  assert.equal(mayUpdate({ joined: true, busy: 1, stopping: false }), false, 'a card is running');
  assert.equal(mayUpdate({ joined: true, busy: 0, stopping: true }), false);
});

test('schemaOfSource reads the board schema a kit migrates to (this kit included)', () => {
  assert.equal(schemaOfSource(migrate(3)), 3);
  assert.equal(schemaOfSource(fs.readFileSync(path.join(KIT_ROOT, 'src/lib/migrate.ts'), 'utf8')), SCHEMA_VERSION);
  assert.equal(schemaOfSource('nothing here'), null);
});

test('update: up to date is nothing; a moved main fast-forwards; npm ci runs only when the lockfile changed', async () => {
  const r = repos();
  try {
    assert.equal((await planUpdate(r.kit, 1)).action, 'none');
    const a = r.land({ 'README.md': 'two\n' });
    const p1 = await planUpdate(r.kit, 1);
    assert.equal(p1.action, 'update', p1.reason);
    const out1 = await applyUpdate(r.kit, p1 as any, r.npm);
    assert.ok(out1.ok, out1.reason);
    assert.equal(git(r.kit, 'rev-parse', 'HEAD'), a);
    assert.equal(r.npmLog(), '', 'same lockfile: no npm ci');
    const b = r.land({ 'package-lock.json': '{"v":2}\n' });
    const p2 = await planUpdate(r.kit, 1);
    const out2 = await applyUpdate(r.kit, p2 as any, r.npm);
    assert.ok(out2.ok && out2.deps, out2.reason);
    assert.equal(git(r.kit, 'rev-parse', 'HEAD'), b);
    assert.match(r.npmLog(), /^ci --omit=dev/);
    assert.ok(!r.npmLog().includes(` in ${fs.realpathSync(r.kit)}\n`), 'npm ci never runs in the kit itself');
    assert.ok(fs.existsSync(path.join(r.kit, 'node_modules/new.txt')) && !fs.existsSync(path.join(r.kit, 'node_modules/old.txt')), 'the new node_modules is swapped in');
    assert.deepEqual(fs.readdirSync(r.base).filter((f) => f.includes('-deps-')), [], 'the staging folder is gone');
    assert.equal(git(r.kit, 'status', '--porcelain'), '');
  } finally { r.cleanup(); }
});

test('update: a failed npm ci (offline) leaves the checkout and the runner\'s node_modules untouched', async () => {
  const r = repos();
  try {
    const from = git(r.kit, 'rev-parse', 'HEAD');
    r.land({ 'package-lock.json': '{"v":3}\n' });
    const p = await planUpdate(r.kit, 1);
    process.env.NPM_FAIL = '1';
    const out = await applyUpdate(r.kit, p as any, r.npm).finally(() => { delete process.env.NPM_FAIL; });
    assert.equal(out.ok, false);
    assert.match(out.reason, /npm ci for .* failed .*not updated, the runner keeps its dependencies/);
    assert.equal(git(r.kit, 'rev-parse', 'HEAD'), from);
    assert.equal(fs.readFileSync(path.join(r.kit, 'node_modules/old.txt'), 'utf8'), 'old', 'the old dependencies are still there');
    assert.deepEqual(fs.readdirSync(r.base).filter((f) => f.includes('-deps-')), [], 'the staging folder is gone');
  } finally { r.cleanup(); }
});

test('update: a node_modules swap that fails and cannot be undone keeps the old dependencies and says where', async () => {
  const r = repos();
  try {
    r.land({ 'package-lock.json': '{"v":4}\n' });
    const p = await planUpdate(r.kit, 1);
    // The first rename (old node_modules aside) works; the install rename and the restore fail.
    let n = 0;
    const rename = (a: string, b: string) => { if (n++ === 0) return fs.renameSync(a, b); throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
    const out = await applyUpdate(r.kit, p as any, r.npm, rename);
    assert.equal(out.ok, false);
    assert.equal(out.stuck, true);
    const kept = /restore by hand from (\S+) /.exec(out.reason)?.[1];
    assert.ok(kept, out.reason);
    assert.equal(fs.readFileSync(path.join(kept!, 'old.txt'), 'utf8'), 'old', 'the only copy of the old dependencies is kept');
    assert.doesNotMatch(out.reason, /with its dependencies/);
    // Only the install rename fails: the old node_modules goes back and the checkout with it.
    fs.renameSync(kept!, path.join(r.kit, 'node_modules'));
    fs.rmSync(path.dirname(kept!), { recursive: true, force: true });
    const from = git(r.kit, 'rev-parse', 'HEAD');
    r.land({ 'package-lock.json': '{"v":5}\n' });
    let m = 0;
    const once = (a: string, b: string) => { if (m++ === 1) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); fs.renameSync(a, b); };
    const back = await applyUpdate(r.kit, await planUpdate(r.kit, 1) as any, r.npm, once);
    assert.equal(back.ok, false);
    assert.match(back.reason, /back on .* with its dependencies/);
    assert.equal(git(r.kit, 'rev-parse', 'HEAD'), from);
    assert.equal(fs.readFileSync(path.join(r.kit, 'node_modules/old.txt'), 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(r.base).filter((f) => f.includes('-deps-')), []);
  } finally { r.cleanup(); }
});

test('hold: a dirty checkout, a checkout on another branch, a diverged one, and a kit that needs a newer board schema', async () => {
  const r = repos();
  try {
    const head = git(r.kit, 'rev-parse', 'HEAD');
    r.land({ 'README.md': 'two\n' });
    fs.writeFileSync(path.join(r.kit, 'README.md'), 'my edit\n');
    const dirty = await planUpdate(r.kit, 1);
    assert.equal(dirty.action, 'hold');
    assert.match(dirty.reason, /local changes/);
    git(r.kit, 'checkout', '-q', '--', 'README.md');
    git(r.kit, 'checkout', '-q', '-b', 'mine');
    assert.match((await planUpdate(r.kit, 1)).reason, /on mine, not main/);
    git(r.kit, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(r.kit, 'local.txt'), 'x'); git(r.kit, 'add', 'local.txt'); git(r.kit, 'commit', '-qm', 'local');
    assert.match((await planUpdate(r.kit, 1)).reason, /diverged/);
    git(r.kit, 'reset', '-q', '--hard', head);
    r.land({ 'src/lib/migrate.ts': migrate(2) });
    const newer = await planUpdate(r.kit, 1);
    assert.equal(newer.action, 'hold');
    assert.match(newer.reason, /needs board schema 2, the board is at 1/);
    assert.equal((await planUpdate(r.kit, null)).action, 'hold', 'unknown board schema: hold');
    assert.equal((await planUpdate(r.kit, 2)).action, 'update');
    assert.equal(git(r.kit, 'rev-parse', 'HEAD'), head, 'no hold moved the checkout');
  } finally { r.cleanup(); }
});

test('hold: a kit folder that is not a git clone', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-selfupdate-plain-'));
  try { assert.match((await planUpdate(d, 1)).reason, /not a git clone/); } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('heartbeat: the kit commit and an update hold travel to the board; /api/fleet says who is behind its kit', async () => {
  assert.equal(kitCommitOf('1.0.0+0123456789ab'), '0123456789ab');
  assert.equal(kitCommitOf('1.0.0'), '');
  assert.equal(parseHeartbeat({ machine: 'mini', update: 'the kit checkout has local changes' }).update, 'the kit checkout has local changes');
  assert.throws(() => parseHeartbeat({ machine: 'mini', update: 'a\nb' }), /update must be one line/);
  // The board's kit: a git copy of this kit with two commits (CI checks out one commit, without history).
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-selfupdate-boardkit-'));
  for (const d of ['src', 'public', 'package.json']) fs.cpSync(path.join(KIT_ROOT, d), path.join(kit, d), { recursive: true });
  fs.symlinkSync(path.join(KIT_ROOT, 'node_modules'), path.join(kit, 'node_modules'));
  git(kit, 'init', '-q', '-b', 'main'); git(kit, 'config', 'user.name', 't'); git(kit, 'config', 'user.email', 't@example.invalid');
  git(kit, 'add', '-A'); git(kit, 'commit', '-qm', 'one');
  fs.writeFileSync(path.join(kit, 'NEXT'), 'x'); git(kit, 'add', 'NEXT'); git(kit, 'commit', '-qm', 'two');
  const { root, cleanup } = tempRepo();
  const srv = await serve(root, {}, path.join(kit, 'src/server.ts'));
  try {
    const head = git(kit, 'rev-parse', 'HEAD');
    const parent = git(kit, 'rev-parse', 'HEAD~1');
    const beat = (machine: string, version: string, update?: string) => fetch(srv.url + '/api/fleet/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': `runner@${machine}` }, body: JSON.stringify({ machine, version, ...(update ? { update } : {}) }) });
    for (const r of [await beat('same', `1.0.0+${head.slice(0, 12)}`), await beat('old', `1.0.0+${parent.slice(0, 12)}`, 'the kit checkout has local changes'), await beat('odd', '1.0.0+abcdefabcdef'), await beat('plain', '1.0.0')]) assert.equal(r.status, 200, await r.text());
    const f = await (await fetch(srv.url + '/api/fleet')).json() as any;
    const by = Object.fromEntries(f.machines.map((m: any) => [m.machine, m]));
    assert.equal(f.kit, head);
    assert.equal(by.same.behind, false);
    assert.equal(by.old.behind, true);
    assert.equal(by.old.update, 'the kit checkout has local changes');
    assert.equal(by.odd.behind, null, 'a commit this kit does not know: not judged');
    assert.equal(by.plain.behind, null);
  } finally { await srv.stop(); cleanup(); fs.rmSync(kit, { recursive: true, force: true }); }
});
