import { test } from 'node:test';
import fs from 'node:fs';

test('fixture busy-loops', () => {
  fs.appendFileSync(String(process.env.TEST_WALL_MARK), `busy ${process.pid}\n`);
  for (;;) {}
});
