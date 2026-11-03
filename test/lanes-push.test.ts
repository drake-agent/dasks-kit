// The user's push on a todo card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { isoLocal, updateTask } from '../src/lib/write.ts';
import { checkTask } from '../src/lib/check.ts';
import { loadBoard } from '../src/lib/load.ts';
import { readyQueue } from '../src/lib/ready.ts';
import { livePush, parsePush } from '../src/lib/push.ts';
import { asHuman, humanSecrets, serve } from './state-support.ts';
import { task, tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = new Date('2026-10-19T12:00:00+09:00');
const get = (root: string, id: string) => loadBoard(root).tasks.find((t) => t.id === id)!;

test('push: set by the user with lane (+p0); cleared on claim, on leaving todo, on another lane, on back to none; toggle off sets none', () => {
  const { root, cleanup } = tempRepo([
    task({ id: 'beta.t-a' }), task({ id: 'beta.t-b' }), task({ id: 'beta.t-c' }), task({ id: 'gamma.t-d' }), task({ id: 'beta.t-e' }),
  ]);
  try {
    const push = (id: string, lane: string) => updateTask(root, id, { lane, priority: 'p0' }, 'user', { push: true, now: NOW, appendNote: '사용자 지시: 먼저' });
    const a = push('beta.t-a', 'claude');
    assert.equal(a.pushed, `${isoLocal(NOW)} user claude`);
    assert.deepEqual(checkTask(get(root, 'beta.t-a')), [], 'a pushed card passes dasks check');
    assert.ok(fs.readFileSync(path.join(root, a.file), 'utf8').includes(`\npushed: ${isoLocal(NOW)} user claude\n`));
    assert.match(execFileSync('git', ['-C', root, 'log', '-1', '--format=%s']).toString(), /lane, priority, pushed, note/);
    const claimed = updateTask(root, 'beta.t-a', {}, 'beta-lead', { claim: { op: 'claim', who: 'beta-lead' } });
    assert.deepEqual([claimed.status, claimed.pushed ?? ''], ['doing', '']);
    assert.doesNotMatch(fs.readFileSync(path.join(root, claimed.file), 'utf8'), /^pushed:/m);
    push('beta.t-b', 'codex');
    assert.equal(updateTask(root, 'beta.t-b', { status: 'cancelled' }, 'user', {}).pushed ?? '', '');
    // moved to another lane without a push (an agent re-routes it): the old push does not follow
    push('beta.t-c', 'codex');
    assert.equal(updateTask(root, 'beta.t-c', { lane: 'claude' }, 'beta-lead', {}).pushed ?? '', '');
    push('gamma.t-d', 'claude');
    const back = updateTask(root, 'gamma.t-d', { lane: 'none' }, 'user', {});
    assert.deepEqual([back.lane, back.pushed ?? '', back.priority], ['none', '', 'p0']);
    // other edits keep it (a note, a title)
    push('gamma.t-d', 'claude');
    assert.ok(updateTask(root, 'gamma.t-d', { title_ko: '새 제목' }, 'gamma-lead', {}).pushed);
    // toggle off: the panel sends lane only
    const off = updateTask(root, 'beta.t-e', { lane: 'claude' }, 'user', {});
    assert.deepEqual([off.pushed ?? '', off.priority], ['', 'p2']);
    assert.throws(() => updateTask(root, 'beta.t-e', {}, 'beta-lead', { push: true }), /only the user/);
    assert.throws(() => updateTask(root, 'beta.t-e', { lane: 'none' }, 'user', { push: true }), /push needs a todo, unclaimed card on a lane/);
    assert.equal(get(root, 'beta.t-e').lane, 'claude', 'a refused push writes nothing');
  } finally { cleanup(); }
});

test('pushed field: the check accepts "<ISO time> <actor> <lane>" and rejects anything else', () => {
  const ok = ['2026-10-19T12:00:00+09:00 user claude', '2026-10-19T03:00:00Z user codex', '2026-10-19T12:00+09:00 claude-code@laptop claude'];
  for (const v of ok) {
    assert.ok(parsePush(v), v);
    assert.deepEqual(checkTask(task({ lane: v.split(' ')[2], pushed: v } as any)), [], v);
  }
  const bad = ['yes', '2026-10-19 user claude', '2026-10-19T12:00:00+09:00 user', '2026-10-19T12:00:00+09:00 user claude extra',
    '2026-13-45T12:00:00+09:00 user claude', '2026-10-19T12:00:00+09:00 us er claude', '2026-10-19T12:00:00+09:00 user none', '2026-10-19T12:00:00+09:00 user Bad_Lane'];
  for (const v of bad) {
    assert.equal(parsePush(v), null, v);
    assert.ok(checkTask(task({ pushed: v } as any)).some((e) => /bad pushed/.test(e)), v);
  }
  assert.equal(livePush({ pushed: ok[0], status: 'todo', lane: 'claude' })?.lane, 'claude');
  assert.equal(livePush({ pushed: ok[0], status: 'todo', lane: 'codex' }), null, 'another lane');
  assert.equal(livePush({ pushed: ok[0], status: 'doing', lane: 'claude' }), null);
  assert.equal(livePush({ pushed: ok[0], status: 'todo', lane: 'claude', claimed_by: 'x' }), null);
});

test('readyQueue: pushed cards first (oldest push first), above more-unblocking cards; stale pushes ignored; rest unchanged', () => {
  const p = (at: string, lane = 'claude') => `2026-10-19T${at}:00+09:00 user ${lane}`;
  const tasks = [
    task({ id: 'beta.t-hub', priority: 'p0', created: '2026-10-01T00:00:00+09:00' }), // unblocks two
    task({ id: 'beta.t-w1', depends_on: 'beta.t-hub' } as any), task({ id: 'beta.t-w2', depends_on: 'beta.t-hub' } as any),
    task({ id: 'beta.t-lpush', priority: 'p3', lane: 'claude', pushed: p('11:00') } as any),
    task({ id: 'beta.t-epush', priority: 'p2', lane: 'claude', pushed: p('09:00') } as any),
    task({ id: 'beta.t-stale', priority: 'p1', lane: 'codex', pushed: p('08:00', 'claude') } as any), // moved by hand
    task({ id: 'beta.t-plain', priority: 'p1', created: '2026-10-02T00:00:00+09:00' }),
  ];
  const r = readyQueue({ tasks });
  assert.deepEqual(r.ready.map((x) => x.id), ['beta.t-epush', 'beta.t-lpush', 'beta.t-hub', 'beta.t-plain', 'beta.t-stale']);
  assert.deepEqual(r.ready[0].pushed, { at: '2026-10-19T09:00:00+09:00', by: 'user', lane: 'claude' });
  assert.equal(r.ready[0].push_note, '★ user first · claude');
  assert.equal(r.ready.find((x) => x.id === 'beta.t-stale')!.pushed, undefined);
  // without pushes the queue keeps its usual order
  const old = readyQueue({ tasks: tasks.map((t) => ({ ...t, pushed: undefined })) as any }).ready.map((x) => x.id);
  assert.deepEqual(old, ['beta.t-hub', 'beta.t-plain', 'beta.t-stale', 'beta.t-epush', 'beta.t-lpush']);
});

function mcp(url: string, actor: string) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'mcp/dasks-mcp.mjs')], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; let next = 1;
  const waiting = new Map<number, (v: any) => void>();
  proc.stdout!.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  const rpc = (method: string, params: any = {}) => new Promise<any>((res) => { const id = next++; waiting.set(id, res); proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { proc, rpc };
}

test('live: a panel push shows on dasks ready (CLI) and MCP ready_tasks, top of the list, with the ★ marker', async () => {
  const { root, cleanup } = tempRepo([
    task({ id: 'beta.t-hub', priority: 'p0' }), task({ id: 'beta.t-w', depends_on: 'beta.t-hub' } as any), task({ id: 'beta.t-mine', priority: 'p3' }),
  ]);
  const human = humanSecrets();
  const s = await serve(root, human.env);
  const m = mcp(s.url, 'beta-lead');
  try {
    const t = (await (await fetch(`${s.url}/api/tasks/beta.t-mine`)).json()) as any;
    const r = await asHuman(s.url, '/api/tasks/beta.t-mine', { lane: 'claude', priority: 'p0', push: true, note: '사용자 지시: Claude에서 먼저', if_status: 'todo', expected_version: t.version });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // The fixtures have no specs: the full queue (?all=1; the default lists ready specs only).
    const api = (await (await fetch(`${s.url}/api/ready?goal=beta&all=1`)).json()) as any;
    assert.deepEqual([api.ready[0].id, api.ready[0].push_note], ['beta.t-mine', '★ user first · claude']);
    const out = execFileSync(process.execPath, [path.join(ROOT, 'mcp/board-cli.mjs'), 'ready', '--app', 'beta', '--all'], { env: { ...process.env, DASKS_URL: s.url, DASKS_ACTOR: 'beta-lead' }, encoding: 'utf8' });
    const first = out.split('\n')[0];
    assert.match(first, /beta\.t-mine .*★ user first · claude$/, out);
    const res = (await m.rpc('tools/call', { name: 'ready_tasks', arguments: { app: 'beta', all: true } })).result;
    assert.ok(!res.isError);
    assert.match(res.content[0].text, /★ user first · claude/);
    assert.equal(JSON.parse(res.content[0].text).ready[0].id, 'beta.t-mine');
    // the owner claims it: the push is gone, the queue is back to normal
    const c = await s.post('/api/tasks/beta.t-mine/claim', { who: 'beta-lead' }, 'beta-lead');
    assert.equal(c.status, 200);
    const after = (await (await fetch(`${s.url}/api/tasks/beta.t-mine`)).json()) as any;
    assert.equal(after.pushed ?? '', '');
  } finally { m.proc.kill(); await s.stop(); human.cleanup(); cleanup(); }
});
