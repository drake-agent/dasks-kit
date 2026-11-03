import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';

export function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function snapshotFiles(root: string, directories: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : []) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(root, file)] = sha256(fs.readFileSync(file));
    }
  };
  for (const directory of directories) walk(path.join(root, directory));
  return files;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  const done = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill(); await done;
}
