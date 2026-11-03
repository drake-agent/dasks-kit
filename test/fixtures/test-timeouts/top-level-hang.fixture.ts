import { test } from 'node:test';

setInterval(() => {}, 1000);
await new Promise(() => {});
test('fixture never gets here', () => {});
