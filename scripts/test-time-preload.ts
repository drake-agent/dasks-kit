// Preloaded by scripts/test-run.ts into each test file process: on exit it writes how long the process lived (ms since
// process start: boot, module load, tests and after hooks) to $DASKS_TEST_TIMES_DIR/<pid>.json, so the runner records
// whole-file times the same way on every Node version (the runner's own events start a file's clock too late on Node 22).
// A process killed by a signal writes nothing; the runner falls back to the sum of that file's test times.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.DASKS_TEST_TIMES_DIR;
if (dir) {
  process.on('exit', () => {
    try {
      fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ file: process.argv[1], ms: Math.round(performance.now()) }));
    } catch {}
  });
}
