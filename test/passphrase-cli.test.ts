import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassphraseAuth, UNSAFE_OWN_PASSPHRASE } from '../src/lib/auth.ts';

// bin/dasks-passphrase.ts --stdin, in its non-root test mode, against a temp passphrase file.
const CLI = path.resolve('bin/dasks-passphrase.ts');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-pass-cli-'));
  const file = path.join(dir, 'passphrase');
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function runCli(file: string, pass: string) {
  const r = spawnSync(process.execPath, [CLI, '--stdin'], { input: pass + '\n', encoding: 'utf8',
    env: { ...process.env, DASKS_PASSPHRASE_FILE: file, [UNSAFE_OWN_PASSPHRASE]: '1' } });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const verifies = (file: string, pass: string) => {
  const saved = process.env[UNSAFE_OWN_PASSPHRASE]; process.env[UNSAFE_OWN_PASSPHRASE] = '1';
  try { return new PassphraseAuth(file).verify({ passphrase: pass }); }
  finally { if (saved === undefined) delete process.env[UNSAFE_OWN_PASSPHRASE]; else process.env[UNSAFE_OWN_PASSPHRASE] = saved; }
};
const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => f !== 'passphrase');

test('a passphrase over 1024 characters is refused before anything is written', () => {
  const { dir, file, cleanup } = setup();
  try {
    const old = 'old passphrase 0123';
    assert.equal(runCli(file, old).status, 0);
    const before = fs.readFileSync(file);
    const long = 'L'.repeat(1024) + 'Z';
    const r = runCli(file, long);
    assert.equal(r.status, 1);
    assert.deepEqual(fs.readFileSync(file), before, 'the file bytes are unchanged');
    assert.ok(verifies(file, old), 'the old passphrase still verifies');
    assert.ok(!r.out.includes(long) && !r.out.includes('L'.repeat(64)), 'the value is not printed');
    assert.deepEqual(leftovers(dir), [], 'no temp file is left');
  } finally { cleanup(); }
});

test('create then rotate: the old passphrase stops working, the new one verifies, nothing leaks', () => {
  const { dir, file, cleanup } = setup();
  try {
    const first = 'first passphrase AAA';
    const second = 'second passphrase BBB';
    const a = runCli(file, first);
    assert.equal(a.status, 0);
    assert.ok(verifies(file, first));
    const b = runCli(file, second);
    assert.equal(b.status, 0);
    assert.ok(!verifies(file, first), 'the old one fails');
    assert.ok(verifies(file, second), 'the new one verifies');
    const stored = fs.readFileSync(file, 'utf8');
    for (const p of [first, second]) {
      assert.ok(!a.out.includes(p) && !b.out.includes(p), 'plaintext not in output');
      assert.ok(!stored.includes(p), 'plaintext not in file');
    }
    assert.equal(fs.statSync(file).mode & 0o027, 0, 'no group-write or other bits');
    assert.deepEqual(leftovers(dir), []);
    const before = fs.readFileSync(file);
    const s = runCli(file, 'short');
    assert.equal(s.status, 1);
    assert.deepEqual(fs.readFileSync(file), before, 'a short passphrase keeps the file');
  } finally { cleanup(); }
});
