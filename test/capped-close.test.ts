import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { task, tempRepo } from './helpers.ts';
import { asHuman, humanDecides, humanSecrets, serve } from './state-support.ts';

const card = '/api/tasks/beta.t-smpl';
const get = async (s: { url: string }) => (await fetch(s.url + card)).json();

test('never-started card: a second, different outcome is recorded; an identical retry replays', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const first = { state: 'needs-user', note: '첫 결정 필요' };
    const r1 = await s.post(card + '/outcome', { ...first, evidence: [] }); assert.equal(r1.status, 200, await r1.clone().text());
    const stored = await r1.json();
    const again = await s.post(card + '/outcome', { ...first, evidence: [] }); assert.equal(again.status, 200); assert.deepEqual(await again.json(), stored);
    const second = await s.post(card + '/outcome', { state: 'needs-user', note: '두 번째 결정 필요', evidence: [] });
    assert.equal(second.status, 200, await second.clone().text());
    assert.equal((await get(s)).outcomes.length, 2);
  } finally { await s.stop(); cleanup(); }
});

test('never-started card: an outcome after other writes is not matched to an old implicit job', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    const input = { state: 'needs-user', note: '결정 필요', evidence: [] };
    assert.equal((await s.post(card + '/outcome', input)).status, 200);
    assert.equal((await s.post(card, { title: 'Renamed in between' })).status, 200);
    const later = await s.post(card + '/outcome', input);
    assert.equal(later.status, 200, await later.clone().text());
    assert.equal((await get(s)).outcomes.length, 2);
  } finally { await s.stop(); cleanup(); }
});

async function capped(root: string, s: Awaited<ReturnType<typeof serve>>) {
  const cfg = path.join(root, 'test-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), retry_cap: 1 }));
  const run = await (await s.post(card + '/claim', { who: 'sync' })).json();
  const got = await (await s.post(card + '/outcome', { state: 'failed', note: '실행 실패', evidence: ['run/test.log'], run_id: run.run_id, attempt: 1 })).json();
  assert.equal(got.lane, 'failed-terminal');
}

test('a capped card can be cancelled by anyone and leaves the terminal lane', async () => {
  const { root, cleanup } = tempRepo([task()]); const s = await serve(root);
  try {
    await capped(root, s);
    // A client echoing the current lane still closes it (the lane always becomes none).
    const r = await s.post(card, { status: 'cancelled', lane: 'failed-terminal' }); assert.equal(r.status, 200, await r.clone().text());
    const got = await r.json(); assert.equal(got.status, 'cancelled'); assert.equal(got.lane, 'none');
  } finally { await s.stop(); cleanup(); }
});

test('the user can mark a capped card done from Today; an agent still cannot', async () => {
  const { root, cleanup } = tempRepo([task()]); const h = humanSecrets(); const s = await serve(root, h.env);
  try {
    await capped(root, s);
    const agent = await s.post(card, { status: 'done', result: 'RESULT.md' }, 'claude-code@desktop');
    assert.equal(agent.status, 409); assert.equal((await agent.json()).rule, 'retry-cap');
    // The capped card asks the user (blocked-on-user): the human signs the answer first, then Done moves it.
    assert.equal((await humanDecides(s.url, 'beta.t-smpl', 'approve')).status, 201);
    const user = await asHuman(s.url, card, { status: 'done', if_status: 'review,blocked-on-user', note: '오늘 화면에서 완료' });
    assert.equal(user.status, 200, JSON.stringify(user.json));
    assert.equal(user.json.status, 'done'); assert.equal(user.json.lane, 'none');
  } finally { await s.stop(); cleanup(); h.cleanup(); }
});

test('board UI and MCP expose reset-attempts for a capped card', () => {
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  assert.match(app, /x\.lane === 'failed-terminal' \? btn\('reset', 'btn\.reset'\)/);
  assert.match(app, /\/reset-attempts`/);
  const i18n = fs.readFileSync(path.resolve('public/i18n.js'), 'utf8');
  for (const k of ['btn.reset', 'prompt.reset', 'toast.reset']) assert.equal(i18n.split(`'${k}'`).length - 1, 2, k);
  const mcp = fs.readFileSync(path.resolve('mcp/dasks-mcp.mjs'), 'utf8');
  assert.match(mcp, /name: 'reset_attempts'/);
  assert.match(fs.readFileSync(path.resolve('mcp/board-client.mjs'), 'utf8'), /resetAttempts: \(id, o = \{\}\) => req\('POST', `\/api\/tasks\/\$\{enc\(id\)\}\/reset-attempts`/);
});
