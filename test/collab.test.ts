import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createTask, updateTask, readTask, git, HttpError } from '../src/lib/write.ts';
import { applyContext, contextErrors, parseContext, readActivity } from '../src/lib/collab.ts';
import { loadBoard } from '../src/lib/load.ts';
import { check } from '../src/lib/check.ts';
import { task, tempRepo } from './helpers.ts';

const CTX = { what: '문의 폼을 추가했어요.', why: '메일을 보낼 곳이 없었어요.', do: 'PR 머지 OK 여부만 정해 주세요.', rec: '머지 추천.', after: 'OK하시면 머지해요.' };
const status = (e: any) => e instanceof HttpError ? e.status : -1;

test('context: render, parse, merge keeps foreign lines, any-language rule', () => {
  const body = applyContext('\n## Context\nRef: 12\nWhat: old\n\n## Notes\n- a\n', CTX, '공용 토스트를 추가했어요.');
  const c = parseContext(body)!;
  assert.equal(c.what, CTX.what); assert.equal(c.do, CTX.do); assert.equal(c.pr_summary, '공용 토스트를 추가했어요.');
  assert.match(body, /^\n## Context\nWhat: /); assert.match(body, /Ref: 12/); assert.match(body, /## Notes\n- a/);
  assert.deepEqual(contextErrors({ status: 'review', body, pr: '', pr_summary: '' }), []);
  assert.deepEqual(contextErrors({ status: 'review', body: applyContext('', { ...CTX, rec: 'merge it' }, ''), pr: '', pr_summary: '' }), [], 'any language counts');
  assert.match(contextErrors({ status: 'review', body: applyContext('', { ...CTX, rec: '' }, ''), pr: '', pr_summary: '' })[0], /rec/);
  assert.match(contextErrors({ status: 'review', body, pr: 'https://x/pr/1', pr_summary: '' }).join(), /pr_summary/);
  assert.deepEqual(contextErrors({ status: 'review', body, pr: 'https://x/pr/1', pr_summary: 'english is fine' }), []);
  assert.deepEqual(contextErrors({ status: 'doing', body: '', pr: '', pr_summary: '' }), []);
});

test('validation: review/blocked-on-user need context for agents; the user and configured actors are exempt', () => {
  const { root, cleanup } = tempRepo([task({ status: 'doing' })]);
  try {
    assert.throws(() => updateTask(root, 'beta.t-smpl', { status: 'review' }, 'claude-code@desktop'), /needs context/);
    assert.throws(() => updateTask(root, 'beta.t-smpl', { status: 'blocked-on-user', needs_user: 'x' }, 'dasks'), /needs context/);
    assert.throws(() => updateTask(root, 'beta.t-smpl', { status: 'review' }, 'codex@laptop', { context: { ...CTX, why: '' } }), /why/);
    updateTask(root, 'beta.t-smpl', { status: 'blocked-on-user', needs_user: 'done (merged)' }, 'bot', { exempt: ['bot'] });
    updateTask(root, 'beta.t-smpl', { status: 'doing' }, 'user');
    // with context: block written, needs_user defaults to Do
    const t = updateTask(root, 'beta.t-smpl', { status: 'blocked-on-user', needs_user: '' }, 'claude-code@desktop', { context: CTX });
    assert.equal(t.needs_user, CTX.do);
    assert.equal(parseContext(t.body)!.after, CTX.after);
    assert.throws(() => createTask(root, { goal: 'beta', title: 'x', status: 'review' }, 'helper'), /needs context/);
    const c = createTask(root, { goal: 'beta', title: 'y', status: 'review', pr: 'https://x/pr/2', pr_summary: '요약이에요.' }, 'helper', new Date(), { context: CTX });
    assert.equal(c.status, 'review'); assert.equal(c.milestone, 'beta.m1', 'milestone defaults to the active one');
    // same-status edits that drop the block, or set a PR without a summary, are refused
    assert.throws(() => updateTask(root, 'beta.t-smpl', {}, 'codex@desktop', { body: '\n## Notes\n- x\n' }), /needs context/);
    assert.throws(() => updateTask(root, 'beta.t-smpl', { pr: 'https://x/pr/9', pr_summary: '' }, 'codex@desktop'), /pr_summary/);
    updateTask(root, 'beta.t-smpl', {}, 'codex@desktop', { appendNote: 'a note is fine' });
    updateTask(root, 'beta.t-smpl', { pr: 'https://x/pr/9' }, 'bot', { exempt: ['bot'] });
    // a new pr_summary rewrites the block's PR summary line too
    updateTask(root, 'beta.t-smpl', { pr_summary: '첫 요약.' }, 'codex@desktop');
    assert.equal(parseContext(updateTask(root, 'beta.t-smpl', { pr_summary: '두 번째 요약.' }, 'codex@desktop').body)!.pr_summary, '두 번째 요약.');
    assert.deepEqual(check(loadBoard(root)).errors, []);
  } finally { cleanup(); }
});

test('version: bumped on every write, stale expected_version → 409 with current version, omitted = unconditional', () => {
  const { root, cleanup } = tempRepo([task()]);
  try {
    assert.equal(readTask(root, 'beta.t-smpl').version, undefined, 'a file without a version reads as 0');
    const a = updateTask(root, 'beta.t-smpl', { priority: 'p1' }, 'claude-code@desktop', { expectedVersion: 0 });
    assert.equal(a.version, '1');
    updateTask(root, 'beta.t-smpl', {}, 'bot', { appendNote: 'no version' });
    try { updateTask(root, 'beta.t-smpl', { priority: 'p0' }, 'codex@desktop', { expectedVersion: 1 }); assert.fail('no conflict'); }
    catch (e: any) { assert.equal(status(e), 409); assert.equal(e.data.current_version, 2); }
    assert.equal(readTask(root, 'beta.t-smpl').priority, 'p1', 'stale write did not land');
    assert.equal(updateTask(root, 'beta.t-smpl', { priority: 'p0' }, 'codex@desktop', { expectedVersion: 2 }).version, '3');
    assert.match(fs.readFileSync(path.join(root, 'data/tasks/beta/t-smpl.md'), 'utf8'), /^version: 3$/m, 'stored as a YAML number');
  } finally { cleanup(); }
});

test('claims: lock, 409 for another actor, force takeover, release, cleared on done', () => {
  const { root, cleanup } = tempRepo([task(), task({ id: 'beta.t-runng', status: 'doing', owner: 'beta-lead' })]);
  try {
    const t = updateTask(root, 'beta.t-smpl', {}, 'claude-code@laptop', { claim: { op: 'claim', who: 'claude-code@laptop' } });
    assert.equal(t.claimed_by, 'claude-code@laptop'); assert.equal(t.status, 'doing'); assert.ok(t.claimed_at && t.started_at);
    try { updateTask(root, 'beta.t-smpl', {}, 'codex@desktop', { claim: { op: 'claim', who: 'codex@desktop' } }); assert.fail('no 409'); }
    catch (e: any) { assert.equal(status(e), 409); assert.equal(e.data.claimed_by, 'claude-code@laptop'); }
    // re-claim by the holder is fine; a running bot task counts as held by its owner
    updateTask(root, 'beta.t-smpl', {}, 'claude-code@laptop', { claim: { op: 'claim', who: 'claude-code@laptop' } });
    assert.throws(() => updateTask(root, 'beta.t-runng', {}, 'helper', { claim: { op: 'claim', who: 'helper' } }), /held by beta-lead/);
    assert.throws(() => updateTask(root, 'beta.t-runng', {}, 'helper', { claim: { op: 'release', who: 'helper' } }), /held by beta-lead/);
    assert.equal(readTask(root, 'beta.t-runng').status, 'doing');
    // others may still write, with a warning
    const warnings: string[] = [];
    updateTask(root, 'beta.t-smpl', {}, 'codex@desktop', { appendNote: 'looked at it', warnings });
    assert.match(warnings[0], /claimed by claude-code@laptop/);
    // release by non-holder needs force
    assert.throws(() => updateTask(root, 'beta.t-smpl', {}, 'codex@desktop', { claim: { op: 'release', who: 'codex@desktop' } }), /pass force/);
    const w2: string[] = [];
    const f = updateTask(root, 'beta.t-smpl', {}, 'codex@desktop', { claim: { op: 'claim', who: 'codex@desktop', force: true }, warnings: w2 });
    assert.equal(f.claimed_by, 'codex@desktop'); assert.match(w2[0], /took over from claude-code@laptop/);
    // release by the holder: back to todo, and nobody holds it any more
    const rel = updateTask(root, 'beta.t-smpl', {}, 'codex@desktop', { claim: { op: 'release', who: 'codex@desktop' } });
    assert.equal(rel.status, 'todo'); assert.ok(!rel.claimed_by);
    updateTask(root, 'beta.t-smpl', {}, 'codex@desktop', { claim: { op: 'claim', who: 'codex@desktop' } });
    const d = updateTask(root, 'beta.t-smpl', { status: 'done', result: 'run/test.log' }, 'codex@desktop', { action: 'finish' });
    assert.ok(!d.claimed_by); assert.ok(!/claimed_by/.test(fs.readFileSync(path.join(root, d.file), 'utf8')));
    assert.throws(() => updateTask(root, 'beta.t-smpl', {}, 'helper', { claim: { op: 'claim', who: 'helper' } }), /is done/);
    assert.deepEqual(check(loadBoard(root)).errors, []);
  } finally { cleanup(); }
});

test('started_at (run identity) is never reused within the same second', () => {
  const { root, cleanup } = tempRepo([task()]);
  try {
    const now = new Date('2026-10-11T12:00:00.100+09:00');
    const a = updateTask(root, 'beta.t-smpl', {}, 'w', { claim: { op: 'claim', who: 'claude-code@desktop' }, now });
    updateTask(root, 'beta.t-smpl', {}, 'claude-code@desktop', { claim: { op: 'release', who: 'claude-code@desktop' }, now });
    const b = updateTask(root, 'beta.t-smpl', { status: 'doing' }, 'worker@desktop', { ifStatus: 'todo', now });
    assert.notEqual(b.started_at, a.started_at);
    updateTask(root, 'beta.t-smpl', { status: 'todo' }, 'user', { now });
    const c = updateTask(root, 'beta.t-smpl', { status: 'doing' }, 'worker@desktop', { ifStatus: 'todo', now });
    assert.ok(Date.parse(c.started_at!) > Date.parse(b.started_at!), 'third run is later than the second');
  } finally { cleanup(); }
});

test('activity: every write logged (actor, time, action, from→to, note), committed with the task, capped', () => {
  const { root, cleanup } = tempRepo([]);
  try {
    createTask(root, { goal: 'beta', title: 'Logme', milestone: 'beta.m1' }, 'helper');
    updateTask(root, 'beta.t-logme', {}, 'claude-code@desktop', { claim: { op: 'claim', who: 'claude-code@desktop' }, action: 'claim', appendNote: 'starting' });
    updateTask(root, 'beta.t-logme', { title: 'Log me 2' }, 'user');
    updateTask(root, 'beta.t-logme', { status: 'done', result: 'run/test.log' }, 'claude-code@desktop', { action: 'finish' });
    const a = readActivity(root, 'beta.t-logme');
    assert.deepEqual(a.map((x) => [x.actor, x.action, x.from ?? '', x.to ?? '']), [
      ['helper', 'create', '', 'todo'], ['claude-code@desktop', 'claim', 'todo', 'doing'], ['user', 'edit', '', ''], ['claude-code@desktop', 'finish', 'doing', 'done'],
    ]);
    assert.equal(a[1].note, 'starting'); assert.match(a[2].note!, /title/); assert.ok(a.every((x) => !Number.isNaN(Date.parse(x.at))));
    const files = git(root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
    assert.deepEqual(files, ['data/activity/beta/t-logme.jsonl', 'data/tasks/beta/t-logme.md']);
    assert.match(git(root, ['log', '-1', '--format=%s']), /^claude-code@desktop: beta\.t-logme status doing -> done/);
    for (let i = 0; i < 205; i++) updateTask(root, 'beta.t-logme', { priority: i % 2 ? 'p1' : 'p2' }, 'bot');
    assert.equal(readActivity(root, 'beta.t-logme').length, 200);
  } finally { cleanup(); }
});

// ---------- live server + MCP over stdio ----------
async function startServer(root: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port }, context_exempt_actors: ['bot'] }));
  const proc = spawn(process.execPath, [path.resolve(import.meta.dirname, '../src/server.ts')], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
}

function mcp(url: string, actor: string) {
  const proc = spawn(process.execPath, [path.resolve(import.meta.dirname, '../mcp/dasks-mcp.mjs')], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; let next = 1;
  const waiting = new Map<number, (v: any) => void>();
  proc.stdout!.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  const rpc = (method: string, params: any = {}) => new Promise<any>((res) => { const id = next++; waiting.set(id, res); proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name: string, args: any) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { err: !!r.isError, text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() }; };
  return { proc, rpc, call };
}

test('live: HTTP API + MCP server — claim warning, version 409, context rule, activity, clients without version or actor', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-old', status: 'doing' })]);
  const { url, proc } = await startServer(root);
  const a = mcp(url, 'claude-code@desktop');
  const b = mcp(url, 'codex@laptop');
  try {
    const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'dasks'); assert.equal(init.result.protocolVersion, '2025-06-18');
    const tools = (await a.rpc('tools/list')).result.tools.map((t: any) => t.name);
    for (const n of ['list_goals', 'list_tasks', 'get_task', 'create_task', 'update_task', 'claim_task', 'finish_task']) assert.ok(tools.includes(n), n);

    const goals = await a.call('list_goals', {});
    assert.ok(goals.json.goals.some((g: any) => g.app === 'beta'));
    const created = await a.call('create_task', { app: 'beta', title: 'TEST dasks-mcp desktop' });
    assert.equal(created.err, false, created.text); assert.equal(created.json.owner, 'claude-code@desktop');
    const id = created.json.id;
    const claim = await a.call('claim_task', { id, note: 'on it' });
    assert.equal(claim.json.claimed_by, 'claude-code@desktop'); assert.equal(claim.json.status, 'doing');
    const other = await b.call('claim_task', { id });
    assert.equal(other.err, true); assert.match(other.text, /"http_status":409/); assert.match(other.text, /claude-code@desktop/);
    const stale = await b.call('update_task', { id, note: 'x', expected_version: 1 });
    assert.equal(stale.err, true); assert.match(stale.text, /"current_version":2/);
    const warn = await b.call('update_task', { id, note: 'reading along', expected_version: 2 });
    assert.equal(warn.err, false); assert.match(warn.json.warnings.join(), /claimed by claude-code@desktop/);
    const noCtx = await a.call('update_task', { id, status: 'review' });
    assert.equal(noCtx.err, true); assert.match(noCtx.text, /needs context/);
    const fin = await a.call('finish_task', { id, result: 'Did the thing.', pr: 'https://github.com/x/y/pull/1', pr_summary: '테스트 PR이에요.', ...CTX });
    assert.equal(fin.err, false, fin.text); assert.equal(fin.json.status, 'review');
    const got = await a.call('get_task', { id });
    assert.deepEqual(got.json.activity.map((x: any) => `${x.actor} ${x.action}`), ['claude-code@desktop create', 'claude-code@desktop claim', 'codex@laptop note', 'claude-code@desktop finish']);
    const list = await b.call('list_tasks', { app: 'beta', status: 'review' });
    assert.deepEqual(list.json.map((t: any) => t.id), [id]);

    // MCP without an actor is read-only
    const ro = mcp(url, '');
    assert.match((await ro.call('create_task', { app: 'beta', title: 'nope' })).text, /DASKS_ACTOR/);
    ro.proc.kill();

    // no version and no actor header: written as "dasks", unconditionally
    let r = await fetch(`${url}/api/tasks/beta.t-old`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'old client' }) });
    assert.equal(r.status, 200);
    assert.match(git(root, ['log', '-1', '--format=%s']), /^dasks: beta\.t-old/);
    r = await fetch(`${url}/api/tasks/beta.t-old`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'bot' }, body: JSON.stringify({ status: 'blocked-on-user', needs_user: '병합된 걸로 볼까요? 승인하면 완료로 넘어가요.' }) });
    assert.equal(r.status, 200, 'a configured exempt actor sets blocked-on-user without context');

  } finally {
    a.proc.kill(); b.proc.kill(); proc.kill(); cleanup();
  }
});

test('dasks CLI: create, claim conflict exit code, finish', async () => {
  const { root, cleanup } = tempRepo([]);
  const { url, proc } = await startServer(root);
  const gbBin = path.resolve(import.meta.dirname, '../mcp/board-cli.mjs');
  const run = (actor: string, ...args: string[]) => {
    try { return { code: 0, out: execFileSync(process.execPath, [gbBin, ...args], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, encoding: 'utf8', stdio: 'pipe' }) }; }
    catch (e: any) { return { code: e.status, out: String(e.stderr) }; }
  };
  try {
    // execFileSync blocks the event loop, so the server must be a separate process (it is).
    assert.match(run('cli@desktop', 'new', 'shared', 'CLI').out, /shared\.t-cli\b/);
    assert.match(run('cli@desktop', 'claim', 'shared.t-cli').out, /claimed by cli@desktop/);
    const c = run('codex@desktop', 'claim', 'shared.t-cli');
    assert.equal(c.code, 1); assert.match(c.out, /409/);
    assert.match(run('cli@desktop', 'finish', 'shared.t-cli', '--result', 'RESULT.md').out, /status done/);
    assert.match(run('cli@desktop', 'tasks', '--app', 'shared', '--json').out, /"status": "done"/);
  } finally { proc.kill(); cleanup(); }
});
