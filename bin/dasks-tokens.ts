#!/usr/bin/env node
// Agent tokens for board writes (docs/auth.md). The store keeps only sha256 of each secret. With config auth.store
// "user" (the default) it is ~/.dasks/agent-tokens.json, mode 600, and this tool runs as you. With "system" it is
// /Library/Application Support/Dasks/agent-tokens.json (/etc/dasks/agent-tokens.json elsewhere), owned by root and
// readable by the server's account, so no process of that account can add itself a token: run this tool with sudo.
// The server re-reads the store on its next write request (no restart).
//   node bin/dasks-tokens.ts issue <actor>[,<actor>...] [--labels] [--note T]   prints the token once ("*" = any name)
//   node bin/dasks-tokens.ts list
//   node bin/dasks-tokens.ts revoke <id>
//   node bin/dasks-tokens.ts machine add <name> | list | revoke <name>   fleet machine tokens (docs/fleet.md): one per
//                                                                       Mac, any actor name ending in @<name>
// issue prints the full token to stdout and nothing else; nothing else here ever prints a secret or a hash.
// It never repairs a path: everything above the store folder must already pass the checks, and the store folder is the
// only thing it creates.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { aclLs, MACHINE_RE, newToken, parseAclLs, parseTokenStore, storePathProblem, tokenActorOk, tokenStoreConfig, UNSAFE_OWN_TOKENS, type StoreKind, type TokenRecord } from '../src/lib/auth.ts';
import { boardRoot, loadConfig } from '../src/lib/config.ts';

const usage = 'usage: dasks-tokens.ts issue <actor>[,<actor>...] [--labels] [--note T] | list | revoke <id> | machine add <name> | machine list | machine revoke <name>';
const fail = (msg: string): never => { console.error(msg); process.exit(1); };
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

let kind: StoreKind = 'user';
try { kind = loadConfig(boardRoot()).auth.store; } catch { /* no board config yet: the installer's default */ }
let store: ReturnType<typeof tokenStoreConfig>;
try { store = tokenStoreConfig(kind); } catch (e: any) { fail(`${e.message}; nothing changed`); }
// The user store and the test switch are written as the current account, without sudo.
const unsafe = process.env[UNSAFE_OWN_TOKENS] === '1' || store!.user === true;
const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h') { console.error(usage); process.exit(cmd ? 0 : 1); }
const writes = cmd === 'issue' || cmd === 'revoke' || (cmd === 'machine' && (args[0] === 'add' || args[0] === 'revoke'));
if (writes && !unsafe && process.getuid!() !== 0) fail('run it with sudo: the system token store must belong to root (docs/auth.md); nothing changed');
// The account the board server runs as: the one that called sudo.
const serverUid = unsafe ? process.getuid!() : Number(process.env.SUDO_UID);
const serverGid = unsafe ? process.getgid!() : Number(process.env.SUDO_GID);
if (writes && (!Number.isInteger(serverUid) || !Number.isInteger(serverGid) || serverUid === 0)) fail('run it with sudo from the account the board server runs as; nothing changed');

const { file, owners } = store!;
const dir = path.dirname(file);
const refused = (why: string) => fail(`refused: ${why}. The store path must have no symlink, belong to root, not be group- or world-writable and carry no ACL write grant; this tool does not repair it. Nothing changed.`);

/** The records of the existing store ([] when there is none). An existing store is checked BEFORE it is read: its own
 *  owner, mode and ACL must pass the path rule, so records someone else could have planted in it are never read, let
 *  alone copied into a fresh root-owned store; an unsafe one is refused and left as it is. */
function load(): TokenRecord[] {
  let text: string;
  let fd: number;
  let pre: fs.Stats | null = null;
  try { pre = fs.lstatSync(file); } catch (e: any) { if (e.code !== 'ENOENT') return fail(`${file}: ${e.code || 'unreadable'}`); }
  if (!pre) return [];
  if (owners) { const why = storePathProblem(file, owners, 'file'); if (why) refused(why); }
  // No link at the end, never blocks on a FIFO or device; must be a regular file, the one just checked.
  try { fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); } catch (e: any) { return fail(`${file}: ${e.code || 'unreadable'}`); }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return fail(`${file} is not a regular file; nothing changed`);
    if (st.ino !== pre.ino || st.dev !== pre.dev) return fail(`${file} changed while it was read; nothing changed`);
    text = fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
  const p = parseTokenStore(text);
  if ('invalid' in p) return fail(`${file}: token store invalid: ${p.invalid}; fix it by hand first, nothing changed`);
  return p.records;
}

/** Can the server account really read `f` (every folder searchable, the file readable, ACL denies included)? A real
 *  access check as that account: under the test switch this process is the server account (access(2)); as root,
 *  `sudo -n -u #<uid> /bin/test -r` (sudo sets that account's groups). Only if that cannot run at all: the POSIX bits
 *  plus any ACL deny entry on the path that could block reading or searching. Why not, or null. */
function serverCannotRead(f: string): string | null {
  const no = `${f} is not readable by the server account (uid ${serverUid})`;
  if (unsafe) { try { fs.accessSync(f, fs.constants.R_OK); return null; } catch { return no; } }
  const r = spawnSync('/usr/bin/sudo', ['-n', '-u', `#${serverUid}`, '/bin/test', '-r', f], { stdio: 'ignore', timeout: 10_000 });
  if (r.status === 0) return null;
  if (r.status === 1) return no;
  // Fallback (no sudo): mode bits for the account, and refuse on any deny entry that names read, search or list.
  const groups = new Set(execFileSync('id', ['-G', String(serverUid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number));
  const can = (st: fs.Stats, bits: number) => ((st.uid === serverUid ? st.mode >> 6 : groups.has(st.gid) ? st.mode >> 3 : st.mode) & bits) === bits;
  const parts = f.split('/').filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    const p = '/' + parts.slice(0, i).join('/');
    const st = fs.lstatSync(p);
    const last = i === parts.length;
    if (!can(st, last ? 4 : 1)) return last ? no : `${p} is not searchable by the server account (uid ${serverUid})`;
    const out = aclLs(p, st);
    const entries = out === null ? null : parseAclLs(out);
    if (!entries) return `${p}: its ACL could not be read; the server account may not reach the store`;
    if (entries.some((e) => e.kind === 'deny' && e.perms.some((w) => w === 'read' || w === 'search' || w === 'list' || w === 'execute')))
      return `${p} has an ACL deny entry that may keep the server account from reading the store`;
  }
  return null;
}

/** The store folder, checked before anything is made: the folder above it must exist and pass every check (nothing
 *  above the store folder is ever created or changed); the store folder is then made if missing (0755, the umask set
 *  aside) and checked itself. Under the plain test switch (no owner uid) the checks are off but nothing above the store
 *  folder is created either. */
function prepareFolder() {
  const parent = path.dirname(dir);
  if (owners) { const why = storePathProblem(parent, owners, 'dir'); if (why) refused(why); }
  else if (!fs.existsSync(parent)) fail(`${parent}: missing; nothing changed`);
  let made = false;
  const mode = store!.user ? 0o700 : 0o755;
  try { fs.mkdirSync(dir, { mode }); made = true; } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  if (made) fs.chmodSync(dir, mode); // only a folder this run just made, in a parent no one else can write
  if (owners) { const why = storePathProblem(dir, owners, 'dir'); if (why) refused(why); }
}

/** The pid a lock file names, or null (empty, garbage, unreadable). */
function lockOwner(lock: string): { pid: number | null; ino: number } | null {
  let fd: number;
  try { fd = fs.openSync(lock, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    const m = /^(\d{1,10})\n?$/.exec(fs.readFileSync(fd, 'utf8'));
    return { pid: m ? Number(m[1]) : null, ino: st.ino };
  } catch { return null; } finally { fs.closeSync(fd); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };

/** Tests only (the unsafe switch): pause while clearing a stale lock; log when the lock is taken and dropped. */
function testReapPause() {
  const ms = unsafe ? Number(process.env.DASKS_TOKENS_TEST_REAP_PAUSE_MS) : 0;
  if (ms > 0) { console.error('test: reap pause'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
}
function testLockLog(what: string) {
  const f = unsafe ? process.env.DASKS_TOKENS_TEST_LOCK_LOG : '';
  if (f) fs.appendFileSync(f, `${process.pid} ${what} ${Date.now()}\n`);
  // A synchronous pause right after the lock is taken, before anything awaits (a signal must not leave the lock behind).
  const ms = unsafe && what === 'got' ? Number(process.env.DASKS_TOKENS_TEST_GOT_PAUSE_MS) : 0;
  if (ms > 0) { console.error('test: got pause'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
}

/** Remove a dead pid's lock, one run at a time: under `<lock>.clear` (O_EXCL, held only for this check-and-remove) the
 *  lock is read again and removed only if it still names a pid that is not running. Without the guard two runs could both
 *  judge the same dead lock, one take a fresh lock, and the other delete it. -> true when this run removed it, false when
 *  the guard is busy or the lock changed (the caller waits and tries again). Only a run killed inside this short window
 *  leaves the guard behind; then the next run waits out its limit and says so. */
function clearStale(lock: string): boolean {
  const guard = `${lock}.clear`;
  let g: number;
  try { g = fs.openSync(guard, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600); }
  catch (e: any) { if (e.code === 'EEXIST') return false; throw e; }
  try {
    const owner = lockOwner(lock);
    if (!owner?.pid || alive(owner.pid)) return false;
    testReapPause();
    let same = false;
    try { same = fs.lstatSync(lock).ino === owner.ino; } catch { /* gone already */ }
    if (!same) return false;
    fs.rmSync(lock, { force: true });
    console.error(`removed stale lock ${lock} of pid ${owner.pid} (not running)`);
    return true;
  } finally {
    fs.closeSync(g);
    fs.rmSync(guard, { force: true });
  }
}

/** The whole read-change-write under one lock (an O_EXCL lock file next to the store holding this run's pid), so two
 *  runs never lose a change. The lock goes on normal exit, on fail(), and on SIGTERM / SIGINT / SIGHUP. A lock whose pid
 *  is no longer running is reported and removed (only if it is still that same file); a live owner's lock never is. */
async function withLock<T>(fn: () => T): Promise<T> {
  prepareFolder();
  const lock = `${file}.lock`;
  const waitMs = unsafe && Number(process.env.DASKS_TOKENS_TEST_LOCK_WAIT_MS) > 0 ? Number(process.env.DASKS_TOKENS_TEST_LOCK_WAIT_MS) : 10_000;
  let fd = -1, held = false;
  const drop = () => { if (!held) return; held = false; testLockLog('drop'); try { fs.closeSync(fd); } catch { /* closed */ } fs.rmSync(lock, { force: true }); };
  const onSignal = (sig: NodeJS.Signals) => { drop(); process.exit(128 + (os.constants.signals[sig] ?? 1)); };
  // Installed before the lock (or its .clear guard) exists: a stop signal is then queued for these handlers, which run
  // after the synchronous part, never the default action that would end the run with the lock left on disk.
  // fail() exits the process, which skips finally: the exit hook drops the lock on that path too.
  process.once('exit', drop);
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(s, onSignal);
  try {
    for (const start = Date.now(); fd < 0;) {
      try { fd = fs.openSync(lock, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600); held = true; }
      catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        const owner = lockOwner(lock);
        if (owner?.pid && !alive(owner.pid) && clearStale(lock)) continue;
        if (Date.now() - start >= waitMs) {
          if (fs.existsSync(`${lock}.clear`)) fail(`${lock}.clear is held (a run clearing a stale lock); if no dasks-tokens is running, remove it and try again. Nothing changed.`);
          fail(owner?.pid ? `${lock} is held by pid ${owner.pid}, which is still running; nothing changed`
            : `${lock} is held and names no running pid; if no dasks-tokens is running, remove it and try again. Nothing changed.`);
        }
        // Waits on the event loop, not a blocking sleep: a stop signal while another run holds the lock runs onSignal
        // here (nothing held yet), so the run ends without taking the lock or running the command.
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    fs.writeSync(fd, `${process.pid}\n`);
    testLockLog('got');
    // Tests only: hold the lock a while so a signal can arrive while it is held.
    const hold = unsafe ? Number(process.env.DASKS_TOKENS_TEST_HOLD_MS) : 0;
    if (hold > 0) await new Promise((r) => setTimeout(r, hold));
    return fn();
  } finally {
    process.off('exit', drop);
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(s, onSignal);
    drop();
  }
}

/** Atomic replace: a fresh random temp name, created exclusively and never through a link, then rename. */
function save(records: TokenRecord[]) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ tokens: records }, null, 1) + '\n');
    // 0644 root-owned: the server reads it, nobody but root writes it. Under the test switch: 0600, this account's.
    if (!unsafe) fs.fchownSync(fd, 0, 0);
    fs.fchmodSync(fd, unsafe ? 0o600 : 0o644);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (e) { try { fs.closeSync(fd); } catch { /* closed */ } fs.rmSync(tmp, { force: true }); throw e; }
  if (owners) {
    // Checked on the new file before it replaces the store (same folder, so the same inherited ACLs): on a problem the
    // old store stays as it was.
    const why = storePathProblem(tmp, owners, 'file') ?? serverCannotRead(tmp);
    if (why) { fs.rmSync(tmp, { force: true }); fail(`${why}: the board would refuse or not reach this store (fix the path by hand; this tool does not repair it). Nothing changed.`); }
  }
  fs.renameSync(tmp, file);
  if (owners) {
    const why = storePathProblem(file, owners, 'file');
    if (why) fail(`${why}: the board would refuse this store (fix the path by hand; this tool does not repair it)`);
  }
}

function lastUsed(): Record<string, string> {
  const root = boardRoot();
  try { const j = JSON.parse(fs.readFileSync(path.join(root, 'run', 'agent-token-usage.json'), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

if (cmd === 'issue') {
  const list = args[0];
  if (!list || list.startsWith('--')) fail(usage);
  let labels = false, note = '';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--labels') labels = true;
    else if (args[i] === '--note' && args[i + 1] !== undefined) note = args[++i];
    else fail(`unknown option ${args[i]}; ${usage}`);
  }
  const actors = list.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = actors.filter((a) => !tokenActorOk(a));
  if (!actors.length || bad.length) fail(`refused: ${bad.length ? bad.map((a) => JSON.stringify(a)).join(', ') : 'no actor'} (actors are board names: letters, digits, . _ @ -, at most 40; never "user"); nothing changed`);
  if (note.length > 200 || /[\u0000-\u001f\u007f]/.test(note)) fail('note: one line, at most 200 characters; nothing changed');
  const made = await withLock(() => {
    const records = load();
    let m = newToken(actors, labels, note);
    while (records.some((r) => r.id === m.record.id)) m = newToken(actors, labels, note);
    save([...records, m.record]);
    return m;
  });
  process.stdout.write(made.token + '\n');
  console.error(`issued token ${made.record.id} for ${actors.join(', ')}${labels ? ' (+ session labels)' : ''}; it is shown only this once`);
} else if (cmd === 'list') {
  const used = lastUsed();
  const rows = load().map((r) => [r.id, r.actors.join(','), r.labels ? 'labels' : '-', r.created, r.revoked ?? '-', used[r.id] ?? '-', r.note]);
  process.stdout.write(['id\tactors\tlabels\tcreated\trevoked\tlast_used\tnote', ...rows.map((r) => r.join('\t'))].join('\n') + '\n');
} else if (cmd === 'revoke') {
  const id = args[0];
  if (!id || !/^[0-9a-f]{8}$/.test(id)) fail(usage);
  await withLock(() => {
    const records = load();
    const r = records.find((x) => x.id === id);
    if (!r) return fail(`no token ${id}; nothing changed`);
    if (r.revoked) { console.error(`token ${id} was already revoked at ${r.revoked}`); return; }
    r.revoked = new Date().toISOString();
    save(records);
    console.error(`revoked token ${id} (${r.actors.join(', ')}); the board refuses it from its next write request`);
  });
} else if (cmd === 'machine') {
  const [sub, name] = args;
  const live = (r: TokenRecord) => r.machine && !r.revoked;
  if (sub === 'list') {
    const used = lastUsed();
    const rows = load().filter((r) => r.machine).map((r) => [r.machine, r.id, r.created, r.revoked ?? '-', used[r.id] ?? '-']);
    process.stdout.write(['machine\tid\tcreated\trevoked\tlast_used', ...rows.map((r) => r.join('\t'))].join('\n') + '\n');
  } else if ((sub === 'add' || sub === 'revoke') && name && MACHINE_RE.test(name) && args.length === 2) {
    if (sub === 'add') {
      const made = await withLock(() => {
        const records = load();
        if (records.some((r) => live(r) && r.machine === name)) return fail(`machine ${name} already has a token; revoke it first (machine revoke ${name}); nothing changed`);
        let m = newToken([`*@${name}`], true, `machine ${name}`);
        while (records.some((r) => r.id === m.record.id)) m = newToken([`*@${name}`], true, `machine ${name}`);
        m.record.machine = name;
        save([...records, m.record]);
        return m;
      });
      process.stdout.write(made.token + '\n');
      console.error(`issued machine token ${made.record.id} for ${name} (any actor name @${name}); it is shown only this once. Give it to that Mac: ./install.sh --join <board-url> --token-file <file>`);
    } else {
      await withLock(() => {
        const records = load();
        const hit = records.filter((r) => live(r) && r.machine === name);
        if (!hit.length) return fail(`machine ${name} has no live token; nothing changed`);
        const at = new Date().toISOString();
        for (const r of hit) r.revoked = at;
        save(records);
        console.error(`revoked ${hit.length} token(s) of machine ${name}; the board refuses them from its next request`);
      });
    }
  } else fail(`usage: dasks-tokens.ts machine add <name> | list | revoke <name> (name: 1-16 lowercase letters, digits, -)`);
} else fail(usage);
