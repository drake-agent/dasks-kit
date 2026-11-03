#!/usr/bin/env node
// Set (or change) the board login passphrase: stores only its scrypt hash in $DASKS_PASSPHRASE_FILE (default
// ~/.dasks/passphrase, mode 0600). No restart needed. Never echoes or prints the passphrase.
//   node bin/dasks-passphrase.ts                       asks twice (hidden input)
//   printf '%s\n' "$P" | node bin/dasks-passphrase.ts --stdin
// Strict mode (DASKS_STRICT_PASSPHRASE=1, run with sudo): the file belongs to root and is only readable by the server's
// account, so no process of that account (the agents included) can replace it; the server must run with the same setting.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashPassphrase, passphraseFile, STRICT_PASSPHRASE, writableByUs } from '../src/lib/auth.ts';

const MIN = 12;
// The longest passphrase the board accepts at login (PassphraseAuth.verify in src/lib/auth.ts): a longer one could never log in.
const MAX = 1024;
const strict = process.env[STRICT_PASSPHRASE] === '1';
if (strict && process.getuid!() !== 0) { console.error('strict mode: run it with sudo (the passphrase file must belong to root); nothing changed'); process.exit(1); }
// The account the board server runs as: the one that called sudo (strict), else this one.
const serverUid = strict ? Number(process.env.SUDO_UID) : process.getuid!();
const serverGid = strict ? Number(process.env.SUDO_GID) : process.getgid!();
if (!Number.isInteger(serverUid) || !Number.isInteger(serverGid) || (strict && serverUid === 0)) { console.error('run it with sudo from the account the board server runs as; nothing changed'); process.exit(1); }

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let s = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); return resolve(s); }
        if (c === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.split('\n')[0];
}

let pass: string;
if (process.argv.includes('--stdin') || !process.stdin.isTTY) pass = await readStdin();
else {
  pass = await readHidden('New Dasks passphrase: ');
  if ((await readHidden('Again: ')) !== pass) { console.error('the two entries differ; nothing changed'); process.exit(1); }
}
if (pass.length < MIN) { console.error(`use at least ${MIN} characters; nothing changed`); process.exit(1); }
if (pass.length > MAX) { console.error(`use at most ${MAX} characters; nothing changed`); process.exit(1); }

const file = passphraseFile();
const dir = path.dirname(file);
fs.mkdirSync(dir, { recursive: true, mode: strict ? 0o755 : 0o700 });
const tmp = `${file}.${process.pid}.tmp`;
// Default: 0600, this account only. Strict: 0640, group = the server account's group, owned by root.
fs.writeFileSync(tmp, hashPassphrase(pass) + '\n', { mode: strict ? 0o640 : 0o600 });
if (strict) fs.chownSync(tmp, 0, serverGid);
fs.renameSync(tmp, file);
if (strict) {
  const gids = execFileSync('id', ['-G', String(serverUid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  const why = writableByUs(file, serverUid, gids);
  if (why) { console.error(`${why}: the board would refuse this file (an agent could replace it). Move it with DASKS_PASSPHRASE_FILE to a folder only root can write.`); process.exit(1); }
}
console.error(`passphrase hash written to ${file}; log in from the board (existing sessions stay valid until they expire)`);
