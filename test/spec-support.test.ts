// Test helpers: stopServer returns for a server that already died.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stopServer } from './spec-support.ts';

test('stopServer returns at once for a child already killed by a signal (a crashed server never hangs teardown)', async () => {
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((r) => proc.once('spawn', r));
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGKILL'); await exited;
  assert.equal(proc.exitCode, null); assert.equal(proc.signalCode, 'SIGKILL');
  const out = await Promise.race([stopServer(proc).then(() => 'returned'), new Promise((r) => setTimeout(() => r('hung'), 2000))]);
  assert.equal(out, 'returned');
});
