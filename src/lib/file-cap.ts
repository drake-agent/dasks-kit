// Keeps an append-only log from growing forever: over maxBytes, the file keeps only its newest whole lines (at most keepBytes).
// In place on purpose. launchd holds runner.log open as the runner's stdout (O_APPEND), so a rename would leave it writing to
// the old file; with the same inode its next write lands right after the kept lines. A failure leaves the file as it is.
import fs from 'node:fs';

/** Returns true when the file was cut. Never throws: a log that cannot be cut must not stop the caller. */
export function capFile(file: string, maxBytes: number, keepBytes: number): boolean {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    if (size <= maxBytes) return false;
    fd = fs.openSync(file, 'r+');
    const n = Math.min(keepBytes, size);
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, size - n);
    const nl = buf.subarray(0, got).indexOf(0x0a);
    if (nl < 0) return false;   // no whole line in the window: leave it rather than lose everything
    const tail = buf.subarray(nl + 1, got);
    fs.writeSync(fd, tail, 0, tail.length, 0);
    fs.ftruncateSync(fd, tail.length);
    return true;
  } catch { return false; }
  finally { if (fd != null) try { fs.closeSync(fd); } catch { /* nothing to do */ } }
}
