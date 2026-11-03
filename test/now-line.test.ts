// The now line card field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createTask, HttpError, updateTask } from '../src/lib/write.ts';
import { ago, lintNow, normNow } from '../src/lib/now-line.ts';
import { readActivity } from '../src/lib/collab.ts';
import { loadBoard } from '../src/lib/load.ts';
import { startText, START_BUDGET } from '../src/lib/start.ts';
import { task, tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const MCP = path.join(ROOT, 'mcp/dasks-mcp.mjs');
const ME = 'claude-code@laptop';
const err = (fn: () => unknown): HttpError | null => { try { fn(); return null; } catch (e) { if (e instanceof HttpError) return e; throw e; } };
const rule = (e: HttpError | null) => e?.data?.rule;
const read = (root: string, id: string) => loadBoard(root).tasks.find((x) => x.id === id)!;

test('normNow: one line, whitespace collapsed, ≤120 characters after the collapse, refused never cut, "" clears', () => {
  assert.equal(normNow('  리뷰 지적 2개   고치는 중 '), '리뷰 지적 2개 고치는 중');
  assert.equal(normNow('a  ' + ' '.repeat(118) + 'b'), 'a b');
  assert.equal(normNow('x'.repeat(120)), 'x'.repeat(120));
  assert.equal(normNow(''), '');
  assert.equal(normNow('   \t '), '');
  let e = err(() => normNow('x'.repeat(121)));
  assert.equal(e?.status, 400); assert.match(e!.message, /now is over 120 characters/); assert.equal(rule(e), 'now');
  for (const v of ['a\nb', 'a\rb', 'a\r\nb', 'x'.repeat(130) + '\n']) {
    e = err(() => normNow(v));
    assert.equal(e?.status, 400, JSON.stringify(v)); assert.match(e!.message, /now is one line/); assert.equal(rule(e), 'now');
  }
});

test('lintNow: log-like lines are flagged, plain lines are not', () => {
  const table: [string, string][] = [
    ['RESULT: ok', 'log'],
    ['editing src/lib/write.ts', 'log'],
    ['fixing src/lib/write.ts, then tests', 'log'],
    ['리뷰 / 수정 중', ''],
    ['~/example-work/x', 'log'],
    ['running ./bin/dasks-check check', 'log'],
    ['see ../other/thing', 'log'],
    ['tail /tmp/run.log', 'log'],
    ['see https://github.com/a/b', ''],
    ['see http://localhost:4747/api/board', ''],
    ['리뷰 지적 2개 고치는 중', ''],
    ['120/120 tests', ''],
    ['result: fine', ''],
    ['and/or both', ''],
    ['', ''],
  ];
  for (const [line, want] of table) assert.equal(lintNow(line), want, line);
});

test('ago: minutes, hours, days; future clamps to 0; missing or bad time gives ""', () => {
  const now = new Date('2026-10-29T12:00:00+09:00');
  const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  assert.equal(ago(at(0), now), '0 min ago');
  assert.equal(ago(at(3), now), '3 min ago');
  assert.equal(ago(at(59), now), '59 min ago');
  assert.equal(ago(at(90), now), '2 h ago');
  assert.equal(ago(at(47 * 60), now), '47 h ago');
  assert.equal(ago(at(72 * 60), now), '3 d ago');
  assert.equal(ago(at(-30), now), '0 min ago');
  assert.equal(ago('', now), '');
  assert.equal(ago(undefined, now), '');
  assert.equal(ago('yesterday', now), '');
});

test('now: set and stamped; same line is a no-op; "" clears; long or multi-line refused; stamps not writable', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'shared', title: 'Card' }, 'helper');
    const t0 = new Date('2026-10-29T10:00:00+09:00');
    const a = updateTask(root, t.id, { now: ' 리뷰 지적 2개  고치는 중 ' }, ME, { now: t0 });
    assert.equal(a.now, '리뷰 지적 2개 고치는 중');
    assert.equal(a.now_by, ME);
    assert.equal(Date.parse(a.now_at!), t0.getTime());
    assert.equal(a.now_lint ?? '', '');
    let act = readActivity(root, t.id).at(-1)!;
    assert.equal(act.action, 'now'); assert.equal(act.note, '리뷰 지적 2개 고치는 중');
    const log0 = readActivity(root, t.id).length;
    const head0 = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    // same line again (after the collapse), from someone else, later: nothing changes
    const b = updateTask(root, t.id, { now: '리뷰 지적 2개 고치는 중' }, 'helper', { now: new Date('2026-10-29T11:00:00+09:00') });
    assert.equal(b.version, a.version); assert.equal(b.now_at, a.now_at); assert.equal(b.now_by, ME);
    assert.equal(readActivity(root, t.id).length, log0);
    assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), head0);
    // refused writes change nothing
    for (const v of ['x'.repeat(121), 'a\nb']) {
      const e = err(() => updateTask(root, t.id, { now: v }, ME));
      assert.equal(e?.status, 400); assert.equal(rule(e), 'now');
    }
    assert.equal(read(root, t.id).now, a.now);
    // clients never write the stamps or the lint mark
    for (const k of ['now_by', 'now_at', 'now_lint']) {
      const e = err(() => updateTask(root, t.id, { [k]: k === 'now_at' ? '2026-10-29T10:00:00+09:00' : 'user' }, ME));
      assert.equal(e?.status, 400, k); assert.match(e!.message, /not editable/);
    }
    // a pasted log line still lands, marked now_lint=log; a plain line drops the mark
    const c = updateTask(root, t.id, { now: 'RESULT: tests pass in src/lib/write.ts' }, ME);
    assert.equal(c.now, 'RESULT: tests pass in src/lib/write.ts'); assert.equal(c.now_lint, 'log');
    const d = updateTask(root, t.id, { now: '테스트 돌리는 중' }, ME);
    assert.equal(d.now_lint ?? '', '');
    assert.doesNotMatch(fs.readFileSync(path.join(root, d.file), 'utf8'), /^now_lint/m);
    // a write with other fields keeps its usual action name
    updateTask(root, t.id, { now: '우선순위 올림', priority: 'p1' }, ME);
    assert.equal(readActivity(root, t.id).at(-1)!.action, 'edit');
    // clear: the field and its stamps go away
    const e = updateTask(root, t.id, { now: '  ' }, ME);
    assert.equal(e.now ?? '', ''); assert.equal(e.now_by ?? '', ''); assert.equal(e.now_at ?? '', ''); assert.equal(e.now_lint ?? '', '');
    assert.doesNotMatch(fs.readFileSync(path.join(root, e.file), 'utf8'), /^now/m);
    act = readActivity(root, t.id).at(-1)!;
    assert.equal(act.action, 'now'); assert.equal(act.note, 'now cleared');
    // clearing an empty line is a no-op
    const f = updateTask(root, t.id, { now: '' }, ME);
    assert.equal(f.version, e.version);
  } finally { cleanup(); }
});

test('now: done and cancelled clear it in the same write; a finished card refuses a new line (409) but takes ""', () => {
  const { root, cleanup } = tempRepo();
  try {
    for (const [status, actor] of [['done', 'user'], ['cancelled', ME]] as const) {
      const t = createTask(root, { goal: 'shared', title: `Card ${status}` }, 'helper');
      updateTask(root, t.id, { now: '마무리 중' }, ME);
      const x = updateTask(root, t.id, { status, now: '끝났음' }, actor);
      assert.equal(x.status, status);
      assert.equal(x.now ?? '', ''); assert.equal(x.now_by ?? '', ''); assert.equal(x.now_at ?? '', ''); assert.equal(x.now_lint ?? '', '');
      assert.doesNotMatch(fs.readFileSync(path.join(root, x.file), 'utf8'), /^now/m);
      const e = err(() => updateTask(root, t.id, { now: '아직 하는 중' }, ME));
      assert.equal(e?.status, 409); assert.equal(rule(e), 'now');
      assert.match(e!.message, new RegExp(`card is ${status}; a finished card has no now line`));
      assert.equal(updateTask(root, t.id, { now: '' }, ME).version, x.version);
    }
  } finally { cleanup(); }
});


test('start mine line: a long title gives way to the now line and its age; no age without a valid now_at', () => {
  const now = new Date('2026-10-29T12:00:00+09:00');
  const at = new Date(now.getTime() - 3 * 60_000).toISOString();
  const long = task({ id: 'shared.t-' + 'n'.repeat(71), status: 'doing', claimed_by: ME, title: '작업'.repeat(30), now: '리뷰 지적 2개 고치는 중', now_at: at } as any);
  const longPr = task({ id: 'shared.t-' + 'p'.repeat(71), status: 'doing', claimed_by: ME, title: '작업'.repeat(30), pr: 'https://github.com/example-org/' + 'r'.repeat(45) + '/pull/1', now: 'x'.repeat(120), now_at: at } as any);
  const bad = task({ id: 'shared.t-bada', status: 'doing', claimed_by: ME, title: 'Bad at', now: '고치는 중', now_at: 'not-a-time' } as any);
  const text = startText({ board: { tasks: [long, longPr, bad], goals: [{ id: 'shared', title: 'shared', milestones: [] }] as any }, actor: ME, version: 1, now, rules: false, messages: new Map() }).text;
  const l1 = text.split('\n').find((l) => l.includes(long.id))!;
  assert.ok(l1.length <= START_BUDGET.line, l1);
  assert.match(l1, / · now: 리뷰 지적 2개 고치는 중 \(3 min ago\)$/);
  // a long PR ref and a 120-character line: the now part and its age still show whole
  const lp = text.split('\n').find((l) => l.includes('shared.t-ppp'))!;
  assert.ok(lp.length <= START_BUDGET.line, lp);
  assert.ok(lp.endsWith(` · now: ${'x'.repeat(120)} (3 min ago)`), lp);
  const l2 = text.split('\n').find((l) => l.includes(bad.id))!;
  assert.match(l2, / · now: 고치는 중$/);
  // with a summary too, the summary gives way: the now part and its age still end the line whole
  const withSum = { ...longPr, id: 'shared.t-' + 'q'.repeat(71), summary: '요약 '.repeat(40) } as any;
  const ts = startText({ board: { tasks: [withSum], goals: [{ id: 'shared', title: 'shared', milestones: [] }] as any }, actor: ME, version: 1, now, rules: false, messages: new Map() }).text;
  const lq = ts.split('\n').find((l) => l.includes('shared.t-qqq'))!;
  assert.ok(lq.length <= START_BUDGET.line, lq);
  assert.ok(lq.endsWith(` · now: ${'x'.repeat(120)} (3 min ago)`), lq);
  // a short now line keeps room for a cut summary after it
  const roomy = task({ id: 'shared.t-roomy', status: 'doing', claimed_by: ME, title: 'Roomy', now: '고치는 중', now_at: at, summary: '요약 '.repeat(80) } as any);
  const lr = startText({ board: { tasks: [roomy], goals: [{ id: 'shared', title: 'shared', milestones: [] }] as any }, actor: ME, version: 1, now, rules: false, messages: new Map() }).text.split('\n').find((l) => l.includes('shared.t-roomy'))!;
  assert.ok(lr.length <= START_BUDGET.line, lr);
  assert.match(lr, / · now: 고치는 중 \(3 min ago\) · summary: 요약.*…$/);
});

test('dasks check flags a hand-edited now over 120 characters and a bad now_by', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'shared', title: 'Card' }, 'helper');
    const abs = path.join(root, t.file);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(/^---\n/, `---\nnow: ${'x'.repeat(121)}\nnow_by: "bad actor!"\nnow_at: not-a-time\n`));
    let out = '';
    try {
      execFileSync(path.join(ROOT, 'bin/dasks-check'), ['check'], { env: { ...process.env, DASKS_ROOT: root }, encoding: 'utf8', stdio: 'pipe' });
      assert.fail('check passed a bad card');
    } catch (e: any) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
    assert.match(out, /now is over 120 characters/);
    assert.match(out, /bad now_by "bad actor!"/);
    assert.match(out, /bad now_at "not-a-time"/);
  } finally { cleanup(); }
});

// ---------- live: HTTP + MCP + /api/start ----------
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
}
async function startServer(root: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
}
function mcp(url: string, actor: string) {
  const proc = spawn(process.execPath, [MCP], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, stdio: ['pipe', 'pipe', 'inherit'] });
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

test('live: POST sets now; GET /api/tasks/:id and the list return it; MCP update_task/list_tasks; /api/start mine line', async () => {
  const { root, cleanup } = tempRepo();
  const t = createTask(root, { goal: 'shared', title: 'Live card' }, 'helper');
  const { url, proc } = await startServer(root);
  const m = mcp(url, ME);
  const post = (p: string, body: any, actor = ME) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(`/api/tasks/${t.id}/claim`, {})).status, 200);
    let r = await post(`/api/tasks/${t.id}`, { now: '리뷰 지적 2개 고치는 중' });
    assert.equal(r.status, 200);
    let x = await r.json();
    assert.equal(x.now, '리뷰 지적 2개 고치는 중'); assert.equal(x.now_by, ME); assert.ok(x.now_at);
    // refusals over HTTP carry rule now
    r = await post(`/api/tasks/${t.id}`, { now: 'x'.repeat(121) });
    assert.equal(r.status, 400); assert.equal((await r.json()).rule, 'now');
    assert.equal((await post(`/api/tasks/${t.id}`, { now_by: 'user' })).status, 400);
    // claim / finish / release do not take now
    assert.equal((await post(`/api/tasks/${t.id}/claim`, { now: 'x' })).status, 400);
    const one = await (await fetch(`${url}/api/tasks/${t.id}`)).json();
    assert.equal(one.now, '리뷰 지적 2개 고치는 중'); assert.equal(one.now_by, ME); assert.equal(one.now_at, x.now_at);
    const list = await (await fetch(`${url}/api/tasks?goal=shared`)).json();
    const li = list.find((y: any) => y.id === t.id);
    assert.equal(li.now, '리뷰 지적 2개 고치는 중'); assert.equal(li.now_by, ME); assert.equal(li.now_at, x.now_at);
    // /api/start: the caller's mine line shows the line and its age
    const start = await (await fetch(`${url}/api/start?peek=1&rules=0`, { headers: { 'X-Dasks-Actor': ME } })).text();
    const line = start.split('\n').find((l) => l.includes(t.id))!;
    assert.match(line, / · now: 리뷰 지적 2개 고치는 중 \(\d+ min ago\)/);
    // MCP: update_task takes now (short description), list_tasks shows it, get_task mentions it
    await m.rpc('initialize', { protocolVersion: '2025-06-18' });
    const tools = (await m.rpc('tools/list')).result.tools;
    const nowProp = tools.find((y: any) => y.name === 'update_task').inputSchema.properties.now;
    assert.ok(nowProp); assert.ok(nowProp.description.length <= 160, nowProp.description);
    assert.match(tools.find((y: any) => y.name === 'get_task').description, /\bnow\b/);
    for (const n of ['claim_task', 'finish_task', 'release_task']) assert.equal(tools.find((y: any) => y.name === n)?.inputSchema.properties.now, undefined, n);
    const u = await m.call('update_task', { id: t.id, now: '테스트 돌리는 중' });
    assert.equal(u.err, false, u.text);
    const lt = await m.call('list_tasks', { app: 'shared' });
    const mi = (Array.isArray(lt.json) ? lt.json : lt.json.tasks).find((y: any) => y.id === t.id);
    assert.equal(mi.now, '테스트 돌리는 중'); assert.ok(mi.now_at);
    const g = await m.call('get_task', { id: t.id });
    assert.equal(g.json.now, '테스트 돌리는 중'); assert.equal(g.json.now_by, ME);
  } finally { m.proc.kill(); proc.kill(); cleanup(); }
});
