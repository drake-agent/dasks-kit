// A read cursor moves only after the reply left in full (src/lib/commit-after-send.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { commitAfterSend } from '../src/lib/commit-after-send.ts';

/** A response stand-in: its socket (or, pipelined, only the request's) and the events http.ServerResponse emits. */
function fakeRes(pipelined = false) {
  const sock = new EventEmitter();
  const res = Object.assign(new EventEmitter(), { socket: pipelined ? null : sock, req: { socket: sock }, writableFinished: false });
  return { res: res as unknown as http.ServerResponse & { writableFinished: boolean }, sock };
}
const tick = () => new Promise((r) => setImmediate(r));

test('commit runs after finish, on the next turn', async () => {
  const { res } = fakeRes(); let n = 0;
  commitAfterSend(res, () => {}, () => { n++; });
  assert.equal(n, 0, 'not before the reply is out');
  (res as any).writableFinished = true; res.emit('finish');
  assert.equal(n, 0, 'not in the finish turn itself');
  await tick(); assert.equal(n, 1);
});

test('no commit when the socket errors after finish, when the connection closes early, or when the write throws', async () => {
  const a = fakeRes(true); let n = 0;
  commitAfterSend(a.res, () => {}, () => { n++; });
  a.res.emit('finish'); a.sock.emit('error', new Error('ECONNRESET')); await tick();
  assert.equal(n, 0, 'a reset on the request socket of a pipelined reply');
  const b = fakeRes();
  commitAfterSend(b.res, () => {}, () => { n++; });
  b.res.emit('close'); b.res.emit('finish'); await tick();
  assert.equal(n, 0, 'closed before the body was written');
  const c = fakeRes();
  assert.throws(() => commitAfterSend(c.res, () => { throw new Error('write failed'); }, () => { n++; }), /write failed/);
  c.res.emit('finish'); await tick();
  assert.equal(n, 0, 'a failed write');
});

test('a commit that throws is logged, not thrown out of the board', async () => {
  const { res } = fakeRes();
  const logged: string[] = []; const was = console.error; console.error = (m: string) => { logged.push(m); };
  try {
    commitAfterSend(res, () => {}, () => { throw new Error('disk full'); });
    (res as any).writableFinished = true; res.emit('finish'); await tick();
  } finally { console.error = was; }
  assert.match(logged.join('\n'), /read cursor was not moved \(disk full\)/);
});
