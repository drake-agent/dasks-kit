// A read cursor is a consume: move it only once the reply has really left. `res.end` returns before the body is written,
// and `finish` can fire before the socket reports ECONNRESET from a peer that read only part of it. So the commit runs on
// the next turn after `finish`, and only when no socket of this response has errored. A pipelined response has
// `res.socket === null` until it is its turn: the connection is `req.socket` and the later `'socket'` event. A throw from
// the commit is logged here and never ends the board.
import type http from 'node:http';
import type net from 'node:net';

function watchSockets(res: http.ServerResponse, onErr: () => void): () => void {
  const socks = new Set<net.Socket>();
  const arm = (sock: net.Socket | null | undefined) => {
    if (!sock || socks.has(sock)) return;
    socks.add(sock);
    sock.on('error', onErr);
  };
  arm(res.socket);
  arm(res.req?.socket);
  const onSocket = (sock: net.Socket) => arm(sock);
  res.on('socket', onSocket);
  return () => {
    res.off('socket', onSocket);
    for (const sock of socks) sock.off('error', onErr);
  };
}

/** Send with `write`, then run `commit` only after the reply was handed to the socket in full. */
export function commitAfterSend(res: http.ServerResponse, write: () => void, commit: () => void): void {
  let failed = false;
  let settled = false;
  const onErr = () => { failed = true; };
  const drop = watchSockets(res, onErr);
  const settle = () => {
    if (settled) return;
    settled = true;
    drop();
    if (failed) return;
    try { commit(); } catch (e) { console.error(`read cursor was not moved (${String((e as Error).message || e).split('\n')[0]})`); }
  };
  res.once('error', onErr);
  res.once('close', () => { if (!res.writableFinished) failed = true; });
  res.once('finish', () => { setImmediate(settle); });
  try { write(); } catch (e) {
    failed = true;
    settled = true;
    drop();
    throw e;
  }
}
