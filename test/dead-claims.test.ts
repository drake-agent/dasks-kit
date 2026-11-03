// Dead claims and forced release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createTask, updateTask } from '../src/lib/write.ts';
import { tempRepo, task } from './helpers.ts';

const SERVER = path.resolve(import.meta.dirname, '../src/server.ts');
const H = 3600_000;
const CTX = { what: '문의 폼을 추가했어요.', why: '메일을 보낼 곳이 없었어요.', do: 'PR 머지 OK 여부만 정해 주세요.', rec: '머지 추천.', after: 'OK하시면 머지해요.' };

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
const get = async (url: string) => { const r = await fetch(url); return { status: r.status, json: await r.json().catch(() => null) as any }; };
const post = async (url: string, actor: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};

/** A card claimed by `who` at `at` (doing). */
function claimedDoing(root: string, title: string, who: string, at: Date): string {
  const t = createTask(root, { goal: 'beta', title }, 'helper', at);
  updateTask(root, t.id, {}, who, { claim: { op: 'claim', who }, now: at });
  return t.id;
}
/** A card claimed by `who` at `at`, moved to review by its holder at the same time. */
function claimedReview(root: string, title: string, who: string, at: Date): string {
  const id = claimedDoing(root, title, who, at);
  updateTask(root, id, { status: 'review', pr: 'https://github.com/example-org/dasks/pull/1', pr_summary: '공용 토스트를 추가했어요.' }, who, { context: CTX, now: at });
  return id;
}

test('holderSeenAt matches the lease', async () => {
  const { holderSeenAt } = await import('../src/lib/lease.ts');
  const T = Date.parse('2026-10-30T10:00:00+09:00');
  const iso = (ms: number) => new Date(ms).toISOString();
  const t = { claimed_by: 'a@x', claimed_at: iso(T), claim_seen: iso(T + H) };
  const activity = [
    { actor: 'a@x', action: 'note', at: iso(T + 2 * H) },
    { actor: 'b@x', action: 'note', at: iso(T + 5 * H) },
    { actor: 'a@x', action: 'rename', at: iso(T + 6 * H) },
  ];
  assert.equal(holderSeenAt(t, activity), T + 2 * H);
  assert.equal(holderSeenAt({ claimed_by: '', claimed_at: iso(T), claim_seen: '' }, activity), 0);
});

test('dead endpoint lists a silent holder', async () => {
  const T0 = Date.now();
  const { root, cleanup } = tempRepo();
  let proc: ChildProcess | undefined;
  try {
    const id = claimedDoing(root, 'Silent', 'a@x', new Date(T0 - 13 * H));
    const s = await startServer(root); proc = s.proc;
    const r = await get(`${s.url}/api/claims/dead?hours=12`);
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].id, id);
    assert.equal(r.json[0].status, 'doing');
    assert.equal(r.json[0].claimed_by, 'a@x');
    assert.equal(r.json[0].idle_hours, 13);
    assert.equal(Date.parse(r.json[0].last_seen), Math.floor((T0 - 13 * H) / 1000) * 1000);
    assert.equal(typeof r.json[0].version, 'number');
  } finally { proc?.kill(); cleanup(); }
});

test('a holder that wrote recently is not listed', async () => {
  const T0 = Date.now();
  const { root, cleanup } = tempRepo();
  let proc: ChildProcess | undefined;
  try {
    const id = claimedDoing(root, 'Busy', 'a@x', new Date(T0 - 13 * H));
    updateTask(root, id, {}, 'a@x', { appendNote: 'still on it', now: new Date(T0 - H) });
    const s = await startServer(root); proc = s.proc;
    const r = await get(`${s.url}/api/claims/dead?hours=12`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, []);
  } finally { proc?.kill(); cleanup(); }
});

test('review card is listed, todo is not', async () => {
  const T0 = Date.now();
  const at = new Date(T0 - 13 * H).toISOString();
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-lftov', status: 'todo', claimed_by: 'z@x', claimed_at: at } as any)]);
  let proc: ChildProcess | undefined;
  try {
    const id = claimedReview(root, 'Waiting', 'b@x', new Date(T0 - 13 * H));
    const s = await startServer(root); proc = s.proc;
    const r = await get(`${s.url}/api/claims/dead?hours=12`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((x: any) => [x.id, x.status]), [[id, 'review']]);
  } finally { proc?.kill(); cleanup(); }
});

test('bad hours is 400', async () => {
  const { root, cleanup } = tempRepo();
  let proc: ChildProcess | undefined;
  try {
    const s = await startServer(root); proc = s.proc;
    for (const q of ['', '?hours=', '?hours=0', '?hours=x', '?hours=1&hours=2', '?hours=%201', '?hours=-1', '?hours=1e3']) {
      const r = await get(`${s.url}/api/claims/dead${q}`);
      assert.equal(r.status, 400, q);
      assert.deepEqual(r.json, { error: 'hours must be a number > 0' }, q);
    }
    assert.equal((await get(`${s.url}/api/claims/dead?hours=0.5`)).status, 200);
  } finally { proc?.kill(); cleanup(); }
});

/** Force-release a doing and a review card over HTTP: doing goes back to todo, review keeps its status. */
async function releaseBoth(url: string, doing: string, review: string) {
  for (const [id, want] of [[doing, 'todo'], [review, 'review']] as const) {
    const cur = await get(`${url}/api/tasks/${id}`);
    const r = await post(`${url}/api/tasks/${id}/release`, 'ops@desktop', { force: true, expected_version: Number(cur.json.version) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const after = await get(`${url}/api/tasks/${id}`);
    assert.equal(after.json.status, want);
    assert.equal(after.json.claimed_by || '', '');
  }
}

test('release over HTTP frees doing to todo and keeps review', async () => {
  const T0 = Date.now();
  const { root, cleanup } = tempRepo();
  let proc: ChildProcess | undefined;
  try {
    const doing = claimedDoing(root, 'Doing', 'a@x', new Date(T0 - 13 * H));
    const review = claimedReview(root, 'Review', 'b@x', new Date(T0 - 13 * H));
    const s = await startServer(root); proc = s.proc;
    await releaseBoth(s.url, doing, review);
  } finally { proc?.kill(); cleanup(); }
});
