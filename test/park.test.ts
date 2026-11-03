import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorShaped, infraShaped, parkRoute, unpark } from '../src/lib/park.ts';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

const TASTE = { kind: 'taste', wants: 'Badge colour on the decisions card: navy or grey', options: [{ key: 'A', text: 'Navy', effect: 'proceed' }, { key: 'B', text: 'Grey', effect: 'proceed' }], rec: { key: 'B', why: 'matches the other screens' } };

test('park routes: infra notes retry, user-only steps park, everything else goes back to the owner', () => {
  // infra-shaped: run again, never the user
  for (const n of ['runner: queued: no commit in pass 1 (no token, npm ci failed)', 'fixtures/ 누락으로 수정 차단, 작업 트리 변경 없음', '의존성 설치 실패로 중단',
    'the work folder has no refs/ yet; run the job again once it is there', '다른 세션의 claim을 해제한 뒤 작업을 다시 실행합니다.',
    'build host unreachable, fetch failed', 'board host refuses ssh (publickey)', '디스크 공간 부족(no space left) 후 재실행'])
    assert.equal(parkRoute(n, false), 'retry', n);
  // floor: only the user can do or allow it, whatever else the note says
  for (const n of ['삭제 승인을 받은 뒤 work/ 폴더를 정리하고 재실행합니다.', 'Add a token scope for workflows: read and write', 'Fix the billing limit on the CI account, then run again',
    'Unlock the login keychain on the build Mac and check the signing account', 'TestFlight 빌드를 설치해서 확인해 줘', 'Which email address should the invite go to?', 'PR web#36 머지해도 될까?', 'merge approval needed', '유료 플랜 구독 승인 후 재실행',
    '다른 세션의 claim을 해제하거나 사용자가 강제 인수를 승인한 뒤 다시 실행합니다.', 'API 키 결정 필요'])
    assert.equal(parkRoute(n, false), 'park', n);
  // neither: back to the owner (who asks with /api/asks when it really is the user's call)
  for (const n of ['review pass 2: R1 still open; the review limit is reached', '선행 카드 미완료: 위젯 구현 보류', 'someone should look at this']) assert.equal(parkRoute(n, false), 'rework', n);
  assert.equal(parkRoute('review pass 2: R1 still open; the review limit is reached', true), 'park', 'a real ask always parks');
  assert.ok(!infraShaped('삭제 승인 후 재실행') && floorShaped('삭제 승인 후 재실행'));
  assert.equal(unpark('Move M3 to v2?', { actor: 'cli@desktop', hasAsk: false, sweep: true, owner: 'gamma-lead' })?.fields.lane, 'spec-rework');
  assert.equal(unpark('Move M3 to v2?', { actor: 'cli@desktop', hasAsk: false, sweep: true, owner: 'gamma-lead' })?.fields.next_owner, 'gamma-lead');
  assert.equal(unpark('Move M3 to v2?', { actor: 'beta-lead', hasAsk: false, sweep: false, owner: 'beta-lead' }), null, "an owner's question stays (only infra is turned)");
  assert.equal(unpark('claim failed', { actor: 'user', hasAsk: false, sweep: true, owner: 'x' }), null, "the user's own write is never turned");
  assert.equal(unpark('claim failed', { actor: 'job-runner', hasAsk: true, sweep: true, owner: 'x' }), null);
});

test('needs-user outcome: real ask parks, infra retries without retry_cap, the rest goes back to the owner', async () => {
  const ids = ['beta.t-infra', 'beta.t-plain', 'beta.t-ask', 'beta.t-floor', 'beta.t-spec', 'beta.t-cappd'];
  const { root, cleanup } = tempRepo(ids.map((id) => task({ id, status: 'doing' }))); const s = await serve(root);
  const get = async (id: string) => (await fetch(`${s.url}/api/tasks/${id}`)).json();
  const out = (id: string, body: Record<string, unknown>) => s.post(`/api/tasks/${id}/outcome`, body, 'job-runner');
  try {
    let r = await out('beta.t-infra', { state: 'needs-user', note: 'refs 없음: 작업 폴더에 fixtures 누락, 다시 실행 필요', job: 'j1' });
    assert.equal(r.status, 200, await r.text());
    let t = await get('beta.t-infra');
    assert.equal(t.status, 'todo'); assert.equal(t.next_owner, 'retry'); assert.equal(t.needs_user ?? '', '');
    assert.equal(t.outcomes[0].as_state, 'failed'); assert.equal(t.outcomes[0].as_cause, 'infra'); assert.equal(t.outcomes[0].state, 'needs-user');
    assert.equal((await out('beta.t-infra', { state: 'needs-user', note: 'refs 없음: 작업 폴더에 fixtures 누락, 다시 실행 필요', job: 'j1' })).status, 200, 'a replay matches');
    // retry_cap (2) is not used up: infra runs are bounded by infra_retry_cap (3), then back to the owner, never the user
    for (const j of ['j2', 'j3']) { await s.post('/api/tasks/beta.t-infra', { status: 'doing' }, 'job-runner'); assert.equal((await out('beta.t-infra', { state: 'failed', cause: 'infra', note: 'build host unreachable', job: j })).status, 200); }
    t = await get('beta.t-infra');
    assert.equal(t.status, 'todo'); assert.equal(t.lane, 'spec-rework'); assert.equal(t.next_owner, 'beta-lead');
    assert.ok(!(await (await fetch(`${s.url}/api/ready`)).text()).includes('beta.t-infra'), 'spec-rework is out of the ready queue');

    r = await out('beta.t-plain', { state: 'needs-user', note: 'review limit reached with R1 open', job: 'p1' });
    assert.equal(r.status, 200, await r.text());
    t = await get('beta.t-plain');
    assert.deepEqual([t.status, t.lane], ['todo', 'spec-rework']); assert.match(t.body, /not parked on the user, sent back to the card's owner/);

    r = await out('beta.t-ask', { state: 'needs-user', note: 'pick a colour', job: 'a1', ask: TASTE });
    assert.equal(r.status, 200, await r.text());
    t = await get('beta.t-ask');
    assert.equal(t.status, 'blocked-on-user'); assert.match(t.needs_user, /^Decision needed: /);
    assert.equal((await out('beta.t-ask', { state: 'needs-user', note: 'pick a colour', job: 'a1', ask: TASTE })).status, 200, 'replay: no second ask');
    assert.equal((await out('beta.t-spec', { state: 'needs-review', note: '검토', evidence: ['RESULT.md'], ask: TASTE })).status, 400, 'ask only on needs-user');
    assert.equal((await out('beta.t-spec', { state: 'needs-user', note: '고르기', ask: { kind: 'taste' } })).status, 400, 'ask must be the /api/asks shape');

    assert.equal((await out('beta.t-floor', { state: 'needs-user', note: '토큰에 워크플로 권한 추가 필요', job: 'f1' })).status, 200);
    t = await get('beta.t-floor'); assert.equal(t.status, 'blocked-on-user');

    assert.equal((await out('beta.t-spec', { state: 'needs-spec', note: '범위가 너무 커서 카드 수정 필요', evidence: ['run/x.log'], job: 's1' })).status, 200);
    t = await get('beta.t-spec'); assert.deepEqual([t.status, t.lane], ['todo', 'spec-rework']);
    // a draft spec is not the end of the rework: the lane stays until the spec turns ready (test/spec-rework-lane.test.ts)
    const sp = await s.post('/api/tasks/beta.t-spec/spec', { text: '# x\n', expected: 0 }, 'spec');
    if (sp.status === 200) { t = await get('beta.t-spec'); assert.equal(t.lane, 'spec-rework'); }

    // decisions of the day: only outcomes that really parked on the user
    const dec = await (await fetch(`${s.url}/api/decisions`)).json().catch(() => null);
    if (Array.isArray(dec?.rows ?? dec)) assert.ok(!JSON.stringify(dec).includes('beta.t-plain'));
  } finally { await s.stop(); cleanup(); }
});

test('sweep and infra finishes do not park a card on the user; real ones still do', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-h1', status: 'doing' }), task({ id: 'beta.t-h2', status: 'doing' }), task({ id: 'beta.t-h3', status: 'doing' }), task({ id: 'beta.t-h4', status: 'doing' })]);
  const s = await serve(root);
  const get = async (id: string) => (await fetch(`${s.url}/api/tasks/${id}`)).json();
  const ctx = { what: '결정 필요', why: '이유', do: '고르기', rec: 'A안 추천', after: '진행' };
  try {
    let r = await s.post('/api/tasks/beta.t-h1', { status: 'blocked-on-user', needs_user: 'Move M3 to v2?', note: 'stalled doing>6h; claim paused', sweep: true, ...ctx }, 'ops-lead');
    assert.equal(r.status, 200, await r.text());
    let t = await get('beta.t-h1'); assert.deepEqual([t.status, t.lane, t.needs_user ?? ''], ['todo', 'spec-rework', '']);
    r = await s.post('/api/tasks/beta.t-h2', { status: 'blocked-on-user', needs_user: '토큰에 워크플로 권한을 추가할까요? 승인하면 워크플로가 돌아요.', note: 're-blocked', sweep: true, ...ctx }, 'ops-lead');
    assert.equal(r.status, 200, await r.text()); t = await get('beta.t-h2'); assert.equal(t.status, 'blocked-on-user', 'floor matter stays with the user');
    r = await s.post('/api/tasks/beta.t-h3/finish', { status: 'blocked-on-user', result: 'refs/ missing in the work folder; run the job again once it is there', ...{} }, 'codex@desktop');
    assert.equal(r.status, 200, await r.text()); t = await get('beta.t-h3'); assert.deepEqual([t.status, t.lane], ['todo', 'spec-rework']);
    r = await s.post('/api/tasks/beta.t-h4', { status: 'blocked-on-user', needs_user: 'Use layout A for the settings page? If approved, it is built that way.', ...ctx }, 'claude-code@laptop');
    assert.equal(r.status, 200, await r.text()); t = await get('beta.t-h4'); assert.equal(t.status, 'blocked-on-user', 'a non-sweep, non-infra wait is left as it is');
  } finally { await s.stop(); cleanup(); }
});



