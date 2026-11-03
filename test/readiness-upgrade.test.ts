// Readiness on /api/health and board schema upgrades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { task, tempRepo } from './helpers.ts';
import { boardSchema, migrateBoard, MIGRATIONS, SCHEMA_REL, SCHEMA_VERSION, SchemaTooNew, withoutKeys } from '../src/lib/migrate.ts';
import { journalPath } from '../src/lib/write.ts';
import { check } from '../src/lib/check.ts';
import { loadBoard, parseFrontmatter } from '../src/lib/load.ts';

const checkBoard = (root: string) => check(loadBoard(root)).errors.map((e) => `${e.file}: ${e.message}`);

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
}
async function start(root: string): Promise<{ url: string; proc: ChildProcess; log: () => string }> {
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout!.on('data', (d) => { out += d; }); proc.stderr!.on('data', (d) => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break;
    try { await fetch(url + '/api/health'); return { url, proc, log: () => out }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error(`server did not start: ${out}`);
}
const git = (root: string, ...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
const unstamp = (root: string) => { fs.rmSync(path.join(root, SCHEMA_REL)); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'a board from before schema versions'); };

test('health: 200 and ready on a sound board; 503, ok and ready false, naming the part, for a broken file or a kept journal', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  let s = await start(root);
  try {
    let r = await fetch(s.url + '/api/health'); let j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.ready, true);
    assert.deepEqual([j.spec_index.ok, j.journal.ok, j.schema.ok, j.files.ok], [true, true, true, true]);

    fs.writeFileSync(path.join(root, 'data/tasks/beta/t-one.md'), 'no frontmatter\n'); // the watcher reloads it
    for (let i = 0; i < 50 && r.status === 200; i++) { await new Promise((x) => setTimeout(x, 100)); r = await fetch(s.url + '/api/health'); }
    j = await r.json();
    assert.equal(r.status, 503); assert.equal(j.ok, false); assert.equal(j.ready, false);
    assert.equal(j.files.ok, false); assert.equal(j.files.first[0].file, 'data/tasks/beta/t-one.md');
    git(root, 'checkout', '--', 'data');
    s.proc.kill(); await new Promise((x) => s.proc.once('exit', x));

    fs.writeFileSync(journalPath(root), '{"rels": [');
    s = await start(root);
    r = await fetch(s.url + '/api/health'); j = await r.json();
    assert.equal(r.status, 503); assert.equal(j.journal.ok, false); assert.match(j.journal.error, /kept at .*corrupt-/);
    assert.equal(j.files.ok, true);
  } finally { s.proc.kill(); cleanup(); }
});

test('migrate: a board without a schema file gets a backup bundle, then one commit per step; a second run does nothing', () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-restore-'));
  try {
    unstamp(root);
    const before = git(root, 'rev-parse', 'HEAD');
    assert.equal(boardSchema(root), 0);
    const m = migrateBoard(root);
    assert.deepEqual([m.from, m.to, m.applied.length], [0, SCHEMA_VERSION, MIGRATIONS.length]);
    assert.equal(boardSchema(root), SCHEMA_VERSION);
    assert.equal(git(root, 'rev-list', '--count', `${before}..HEAD`), String(MIGRATIONS.length));
    assert.match(git(root, 'log', `-${MIGRATIONS.length}`, '--format=%s'), /^dasks: board schema 0 -> 1 \(stamp the schema version/m);
    assert.equal(git(root, 'status', '--porcelain'), '');
    execFileSync('git', ['clone', '-q', m.backup, path.join(clone, 'b')]);
    assert.equal(git(path.join(clone, 'b'), 'rev-parse', 'HEAD'), before);
    const again = migrateBoard(root);
    assert.deepEqual([again.from, again.to, again.backup, again.applied], [SCHEMA_VERSION, SCHEMA_VERSION, '', []]);
  } finally { cleanup(); fs.rmSync(clone, { recursive: true, force: true }); }
});

test('migrate 1 -> 2: retired review fields on a 1.0.0 card are dropped, so the card loads and checks clean', () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  try {
    const rel = 'data/tasks/beta/t-one.md';
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace(/^---\n/, '---\nreview_verdict: CHANGES\nreview_pass: "2"\nreview_cap: "2"\n'));
    fs.writeFileSync(path.join(root, SCHEMA_REL), JSON.stringify({ schema: 1 }) + '\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'a 1.0.0 board');
    assert.ok(checkBoard(root).some((e) => /review_verdict|review_pass|review_cap/.test(e)), 'the old fields are errors before the migration');
    const m = migrateBoard(root);
    assert.deepEqual([m.from, m.to], [1, SCHEMA_VERSION]);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'only those three lines go');
    assert.deepEqual(checkBoard(root).filter((e) => /review_/.test(e)), []);
  } finally { cleanup(); }
});

test('migrate 1 -> 2 edits YAML, not lines: quoted keys, block values and CRLF; neighbours and the body unchanged', () => {
  const KEYS = ['review_verdict', 'review_pass', 'review_cap'];
  const body = '\n## Context\nreview_pass: in the body stays\n---\nmore\n';
  const cases = [
    '---\nid: beta.t-a\n"review_verdict": CHANGES\ntitle: A\n---' + body,
    '---\nid: beta.t-a\nstarted_by: bot\nreview_verdict: |\n  CHANGES\n  more\ntitle: A\n---' + body,
    '---\nid: beta.t-a\nreview_pass: "2\n  still 2"\nnote: >-\n  folded\n  text\nreview_cap: \'2\'\ntitle: A\n---' + body,
  ];
  for (const text of cases) for (const eol of ['\n', '\r\n']) {
    const input = text.replace(/\n/g, eol);
    const out = withoutKeys(input, KEYS);
    assert.ok(out !== null, input);
    const before = parseFrontmatter(input).fm, after = parseFrontmatter(out).fm;
    for (const k of KEYS) assert.equal(k in after, false, `${k} gone`);
    const rest = Object.fromEntries(Object.entries(before).filter(([k]) => !KEYS.includes(k)));
    assert.deepEqual(after, rest, 'every other field keeps its value');
    assert.equal(parseFrontmatter(out).body, parseFrontmatter(input).body, 'body untouched');
    if (eol === '\r\n') assert.ok(!/[^\r]\n/.test(out), 'CRLF kept');
  }
  assert.equal(withoutKeys('---\nid: beta.t-a\ntitle: A\n---\nbody\n', KEYS), null, 'nothing to drop: untouched');
  // An edit that would change another value, or cannot be made, leaves the file as it is.
  const keep = '---\nid: beta.t-a\nreview_verdict: CHANGES\ntitle: |+\n  hello\n\n\n---\nbody';
  const kept = withoutKeys(keep, KEYS);
  assert.ok(kept === null || parseFrontmatter(kept).fm.title === parseFrontmatter(keep).fm.title, 'a kept-newline value is never shortened');
  assert.equal(withoutKeys('---\nid: beta.t-a\nreview_verdict: &v CHANGES\ntitle: *v\n---\nbody', KEYS), null, 'an alias to a removed value: untouched');
});

test('migrate at server start; a board newer than the kit is refused (no start), an unreadable stamp is not ready', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  try {
    unstamp(root);
    let s = await start(root);
    try {
      assert.equal((await fetch(s.url + '/api/health')).status, 200);
      assert.match(s.log(), new RegExp(`migrate: board schema 0 -> ${SCHEMA_VERSION} .*backup before it: .*dasks-backups/.*-schema-0\\.bundle`));
      assert.equal(boardSchema(root), SCHEMA_VERSION);
    } finally { s.proc.kill(); await new Promise((x) => s.proc.once('exit', x)); }

    fs.writeFileSync(path.join(root, SCHEMA_REL), JSON.stringify({ schema: SCHEMA_VERSION + 1 }) + '\n');
    assert.throws(() => migrateBoard(root), (e: any) => e instanceof SchemaTooNew && /newer than this kit/.test(e.message));
    await assert.rejects(start(root), /server did not start: .*newer than this kit/s);

    fs.writeFileSync(path.join(root, SCHEMA_REL), 'schema one\n');
    s = await start(root);
    try {
      const r = await fetch(s.url + '/api/health'); const j = await r.json();
      assert.equal(r.status, 503); assert.equal(j.schema.ok, false); assert.match(j.schema.error, /schema\.json is unreadable/);
    } finally { s.proc.kill(); }
  } finally { cleanup(); }
});
