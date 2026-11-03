import { test } from 'node:test';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

// Not detached, so the sleep stays in the run's process group after this file exits.
test('fixture leaks a child', () => {
  const c = spawn('/bin/sleep', ['3600'], { stdio: 'ignore' });
  c.unref();
  fs.appendFileSync(String(process.env.TEST_WALL_MARK), `sleep ${c.pid}\n`);
});
