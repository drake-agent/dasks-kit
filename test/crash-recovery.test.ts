// Crash recovery with real SIGKILLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { asHuman, humanSecrets, serve } from './state-support.ts';
import { createTask, git, journalPath } from '../src/lib/write.ts';

/** Wait for the server process to be gone; resolves with the signal that ended it. */
function exited(proc: ChildProcess): Promise<NodeJS.Signals | null> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(proc.signalCode);
  return new Promise((resolve) => proc.once('exit', (_code, signal) => resolve(signal)));
}
/** Stop a server unless it is already dead (stop() waits for an exit event that a killed process already sent). */
async function stop(s?: Awaited<ReturnType<typeof serve>>) {
  if (s && s.proc.exitCode === null && s.proc.signalCode === null) await s.stop();
}
/** A request to a server that SIGKILLs itself mid-write: the socket drops, fetch rejects. */
async function failsWithKill(s: Awaited<ReturnType<typeof serve>>, route: string, body: unknown) {
  const gone = exited(s.proc);
  let replied: number | null = null;
  try { replied = (await s.post(route, body)).status; } catch { /* socket closed by the kill */ }
  assert.equal(replied, null, `${route} must not get a reply: the server dies mid-write`);
  assert.equal(await gone, 'SIGKILL');
}

test('crash after `git commit`, before the journal is removed: the landed write is kept, and the next write builds on it', async () => {
  const { root, cleanup } = tempRepo();
  let s: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const t = createTask(root, { goal: 'beta', title: 'Crash after' }, 'helper');
    s = await serve(root, { DASKS_TEST_CRASH_AT: 'after-commit' });
    await failsWithKill(s, `/api/tasks/${t.id}`, { priority: 'p1' });
    assert.equal(fs.existsSync(journalPath(root)), true, 'the journal is still there');
    assert.match(git(root, ['show', `HEAD:${t.file}`]), /priority: p1/, 'the commit landed');
    s = await serve(root);
    assert.equal(fs.existsSync(journalPath(root)), false, 'recovery dropped the journal');
    assert.match(fs.readFileSync(path.join(root, t.file), 'utf8'), /priority: p1/);
    assert.match(s.logs(), /already committed/);
    const r = await s.post(`/api/tasks/${t.id}`, { title: 'after crash' });
    assert.equal(r.status, 200, await r.text());
    const head = git(root, ['show', `HEAD:${t.file}`]);
    assert.match(head, /priority: p1/, 'the next write keeps the landed change');
    assert.match(head, /title: after crash/);
  } finally { await stop(s); cleanup(); }
});

test('crash before `git commit` (files written and staged): restart puts back the exact pre-write bytes', async () => {
  const { root, cleanup } = tempRepo();
  let s: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const t = createTask(root, { goal: 'beta', title: 'Crash before' }, 'helper');
    const abs = path.join(root, t.file);
    const old = fs.readFileSync(abs);
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();
    s = await serve(root, { DASKS_TEST_CRASH_AT: 'before-commit' });
    await failsWithKill(s, `/api/tasks/${t.id}`, { priority: 'p1' });
    assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), headBefore, 'nothing committed');
    assert.deepEqual(Buffer.from(git(root, ['show', `HEAD:${t.file}`])), old, "HEAD's task file is unchanged");
    s = await serve(root);
    assert.deepEqual(fs.readFileSync(abs), old, 'the task file holds its pre-write bytes');
    assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.equal(git(root, ['status', '--porcelain', '--', 'data']), '', 'nothing left staged or modified');
    assert.match(s.logs(), /undid an unfinished write/);
  } finally { await stop(s); cleanup(); }
});

