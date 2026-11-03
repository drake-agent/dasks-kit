import { test } from 'node:test';
import net from 'node:net';

test('fixture leaves a handle', () => {
  net.createServer().listen(0);
});
