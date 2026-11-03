import { test } from 'node:test';

test('fixture outlasts the file limit', { timeout: 10000 }, () => new Promise((r) => setTimeout(r, 4000)));
