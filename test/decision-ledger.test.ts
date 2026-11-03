// The decision ledger and its verifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendDecision, GENESIS, verifyLedger } from '../src/lib/decisions.ts';
import { readHead } from '../src/lib/ledger-head.ts';

const VERIFY = path.resolve(import.meta.dirname, '../bin/verify-decisions.ts');
const FIX = path.resolve(import.meta.dirname, 'fixtures/decisions');
const KEY = Buffer.from('fixture-only-ledger-key-not-a-secret-0123456789abcdef');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-ledger-')); }
const input = (card: string, revision = 1) => ({ who: 'user', session: 'a'.repeat(64), card, revision, choice: 'approve', scope: `card: ${card}\nrevision: ${revision}`, comment: '' });
function verifyCli(ledger: string, keyFile: string, extra: string[] = ['--head', path.join(FIX, 'ledger.head')]) {
  try { return { code: 0, out: execFileSync(process.execPath, [VERIFY, '--key', keyFile, ...extra, ledger], { encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (e: any) { return { code: e.status as number, out: String(e.stdout) + String(e.stderr) }; }
}

test('append: chain starts at genesis, each prev = sha256 of the previous line, HMAC over the rest', () => {
  const d = tmp(); const f = path.join(d, 'decisions/ledger.jsonl');
  try {
    const a = appendDecision(f, KEY, input('shared.t-a'));
    const b = appendDecision(f, KEY, input('shared.t-b', 2));
    assert.equal(a.prev, GENESIS); assert.notEqual(b.prev, GENESIS);
    assert.equal(a.seq, 1); assert.equal(b.seq, 2);
    assert.match(a.scope_hash, /^[0-9a-f]{64}$/);
    const r = verifyLedger(fs.readFileSync(f, 'utf8'), KEY);
    assert.equal(r.ok, true, r.error); assert.equal(r.count, 2);
    assert.equal(verifyLedger(fs.readFileSync(f, 'utf8'), Buffer.from('other key')).ok, false, 'wrong key fails');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('append-only: the file is opened O_APPEND; earlier bytes are never rewritten', () => {
  const d = tmp(); const f = path.join(d, 'ledger.jsonl');
  try {
    appendDecision(f, KEY, input('shared.t-a'));
    const first = fs.readFileSync(f);
    const ino = fs.statSync(f).ino;
    appendDecision(f, KEY, input('shared.t-b'));
    const both = fs.readFileSync(f);
    assert.ok(both.subarray(0, first.length).equals(first), 'prefix unchanged');
    assert.equal(fs.statSync(f).ino, ino, 'same file, not replaced by rename');
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/lib/decisions.ts'), 'utf8');
    assert.match(src, /openSync\([^)]*'a'[,)]/, "opened with flag 'a' (O_APPEND)");
    assert.doesNotMatch(src, /writeFileSync|renameSync|truncate/, 'no rewrite primitives in the ledger module');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('verifier: every kind of tamper fails', () => {
  const d = tmp(); const f = path.join(d, 'ledger.jsonl');
  try {
    for (const c of ['shared.t-a', 'shared.t-b', 'shared.t-c']) appendDecision(f, KEY, input(c));
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const j = (ls: string[]) => ls.join('\n') + '\n';
    const edit = (i: number, fn: (e: any) => void) => { const ls = [...lines]; const e = JSON.parse(ls[i]); fn(e); ls[i] = JSON.stringify(e); return j(ls); };
    const cases: Record<string, string> = {
      'choice flipped': edit(1, (e) => { e.choice = 'reject'; }),
      'scope edited': edit(0, (e) => { e.scope = e.scope + ' and deploy'; }),
      'scope_hash recomputed but hmac kept': edit(0, (e) => { e.scope = 'x'; e.scope_hash = 'b'.repeat(64); }),
      'line deleted': j([lines[0], lines[2]]),
      'lines reordered': j([lines[1], lines[0], lines[2]]),
      'forged appended line': j([...lines, JSON.stringify({ ...JSON.parse(lines[2]), seq: 4, card: 'shared.t-z' })]),
      'not json': j([lines[0], '{oops']),
      'whitespace changed': j([lines[0].replace('{', '{ '), lines[1], lines[2]]),
    };
    assert.equal(verifyLedger(j(lines), KEY).ok, true);
    for (const [name, text] of Object.entries(cases)) assert.equal(verifyLedger(text, KEY).ok, false, name);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('head: lines cut off the end, an emptied ledger or a deleted head are caught; append refuses to continue', () => {
  const d = tmp(); const f = path.join(d, 'ledger.jsonl'); const hf = path.join(d, 'ledger.head');
  try {
    for (const c of ['shared.t-a', 'shared.t-b', 'shared.t-c']) appendDecision(f, KEY, input(c), new Date(), hf);
    const text = fs.readFileSync(f, 'utf8'); const lines = text.split('\n').filter(Boolean);
    const head = readHead(hf);
    assert.equal(head!.seq, 3);
    assert.equal(verifyLedger(text, KEY, head).ok, true);
    const cut = lines.slice(0, 2).join('\n') + '\n';
    assert.equal(verifyLedger(cut, KEY).ok, true, 'the chain alone cannot see a missing tail');
    assert.equal(verifyLedger(cut, KEY, head).ok, false, 'last line removed');
    assert.equal(verifyLedger('', KEY, head).ok, false, 'ledger emptied');
    assert.equal(verifyLedger(text, KEY, null).ok, false, 'head deleted');
    assert.equal(verifyLedger(text, KEY, { ...head!, seq: 2 }).ok, false, 'head edited without the key');
    assert.equal(verifyLedger('', KEY, null).ok, true, 'fresh install: no head, no entries');
    fs.truncateSync(f, Buffer.byteLength(cut));
    assert.throws(() => appendDecision(f, KEY, input('shared.t-d'), new Date(), hf), /removed/);
    assert.equal(fs.readFileSync(f, 'utf8'), cut, 'nothing appended onto a truncated ledger');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('bin/verify-decisions.ts: passes the good fixture, fails the tamper fixture (exit 1, names the line)', () => {
  const key = path.join(FIX, 'fixture.key');
  const ok = verifyCli(path.join(FIX, 'ledger-ok.jsonl'), key);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /OK/);
  const bad = verifyCli(path.join(FIX, 'ledger-tampered.jsonl'), key);
  assert.equal(bad.code, 1, bad.out); assert.match(bad.out, /FAIL.*line 2/);
  assert.equal(verifyCli(path.join(FIX, 'missing.jsonl'), key).code, 2, 'unreadable input is its own exit code');
  const d = tmp();
  try {
    const lines = fs.readFileSync(path.join(FIX, 'ledger-ok.jsonl'), 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(path.join(d, 'cut.jsonl'), lines.slice(0, 2).join('\n') + '\n');
    const cut = verifyCli(path.join(d, 'cut.jsonl'), key);
    assert.equal(cut.code, 1, cut.out); assert.match(cut.out, /FAIL.*removed/);
    assert.equal(verifyCli(path.join(d, 'cut.jsonl'), key, ['--no-head']).code, 0, '--no-head checks the chain only');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
