// Test timeout flags as npm test passes them (fixtures sit outside the test/*.test.ts glob).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = 'test/fixtures/test-timeouts';
const scriptArgs: string[] = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  .scripts.test.split(' ')
  .slice(1);

function run(fixture: string, timeoutArg?: string): Promise<{ code: number | null; out: string; killed: boolean }> {
  const args = scriptArgs
    .map((a) => (a === 'test/*.test.ts' ? `${fixtures}/${fixture}.fixture.ts` : a))
    .map((a) => (timeoutArg && a.startsWith('--test-timeout=') ? timeoutArg : a));
  // A nested `node --test` that inherits NODE_TEST_CONTEXT reports to the outer runner.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, detached: true });
    let out = '';
    let killed = false;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // Detached, so the whole group (the runner and its file process) goes when the limit fails to fire.
    const safety = setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
    }, 30_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(safety);
      resolve({ code, out, killed });
    });
  });
}

test('the test script sets both flags', { timeout: 60_000 }, () => {
  assert.ok(scriptArgs.includes('--test-timeout=900000'), scriptArgs.join(' '));
  assert.ok(scriptArgs.includes('--test-force-exit'), scriptArgs.join(' '));
});

test('an idle hang fails at the timeout', { timeout: 60_000 }, async () => {
  const r = await run('hang', '--test-timeout=2000');
  assert.equal(r.killed, false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('test timed out after 2000ms'), r.out);
});

test('a finished file with an open handle exits', { timeout: 60_000 }, async () => {
  const r = await run('handle');
  assert.equal(r.killed, false, r.out);
  assert.equal(r.code, 0, r.out);
});

test('a passing file passes', { timeout: 60_000 }, async () => {
  const r = await run('ok');
  assert.equal(r.killed, false, r.out);
  assert.equal(r.code, 0, r.out);
});

test("the limit caps a whole file, past a test's own timeout", { timeout: 60_000 }, async () => {
  const r = await run('slow', '--test-timeout=2000');
  assert.equal(r.killed, false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('test timed out after 2000ms'), r.out);
});

test('a file that hangs before any test starts fails at the timeout', { timeout: 60_000 }, async () => {
  const r = await run('top-level-hang', '--test-timeout=2000');
  assert.equal(r.killed, false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('test timed out after 2000ms'), r.out);
});
