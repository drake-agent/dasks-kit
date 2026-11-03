import { test } from 'node:test';

test('fixture hangs', async () => {
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
});
