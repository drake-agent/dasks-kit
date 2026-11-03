import { test } from 'node:test';
import assert from 'node:assert/strict';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

test('review, fix, second-failure terminal cap and decision pull feed', async () => {
  const { root, cleanup } = tempRepo([task({ status: 'doing' }), task({ id: 'beta.t-user', status: 'doing' })]); const s = await serve(root);
  try {
    const outcome = (state: string, job: string) => s.post('/api/tasks/beta.t-smpl/outcome', { state, note: '검토 및 수정 필요', evidence: ['RESULT.md'], job });
    assert.equal((await outcome('needs-review', 'review')).status, 200);
    let got = await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json();
    assert.equal(got.next_owner, 'reviewer'); assert.equal(got.routes[0].kind, 'reviewer');
    assert.equal((await outcome('failed', 'fail1')).status, 200);
    got = await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json(); assert.equal(got.status, 'todo'); assert.equal(got.next_owner, 'fix');
    assert.equal((await outcome('failed', 'fail2')).status, 200);
    got = await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json(); assert.equal(got.status, 'blocked-on-user'); assert.equal(got.lane, 'failed-terminal'); assert.equal(got.next_owner, 'beta-lead');
    const terminal = await s.post('/api/tasks/beta.t-smpl/outcome', { state: 'needs-user', note: '후속 판단', job: 'third-job' });
    assert.equal(terminal.status, 409); assert.equal((await terminal.json()).rule, 'retry-cap');
    assert.equal((await s.post('/api/tasks/beta.t-user/outcome', { state: 'needs-user', note: '키 결정 필요', job: 'decision' })).status, 200);
    const decisions = await (await fetch(s.url + '/api/decisions/today')).json();
    assert.equal(decisions.filter((x: { job: string }) => x.job === 'decision').length, 1);
    assert.equal(decisions.find((x: { job: string }) => x.job === 'decision').note, '키 결정 필요');
  } finally { await s.stop(); cleanup(); }
});
test('last dependency done emits unblocked once and appears in ready', async () => {
  const { root, cleanup } = tempRepo([task({ status: 'doing' }), task({ id: 'beta.t-other', status: 'doing' }), task({ id: 'beta.t-dpnd', depends_on: 'beta.t-smpl, beta.t-other' })]); const s = await serve(root);
  try {
    for (const id of ['smpl', 'other']) assert.equal((await s.post(`/api/tasks/beta.t-${id}`, { status: 'done', result: 'RESULT.md' })).status, 200);
    assert.equal((await s.post('/api/tasks/beta.t-other', { result: 'run/test.log' })).status, 200);
    const got = await (await fetch(s.url + '/api/tasks/beta.t-dpnd')).json(); assert.equal(got.activity.filter((a: { action: string }) => a.action === 'unblocked').length, 1);
    const ready = await (await fetch(s.url + '/api/ready?all=1')).json(); assert.ok(ready.ready.some((x: { id: string }) => x.id === 'beta.t-dpnd'));
  } finally { await s.stop(); cleanup(); }
});

test('creating a completed dependency unblocks its waiting card', async () => {
  const { root, cleanup } = tempRepo([task({ depends_on: 'beta.t-crtd' })]); const s = await serve(root);
  try {
    assert.equal((await s.post('/api/tasks', { goal: 'beta', id: 'beta.t-crtd', title: 'Created complete', status: 'done', result: 'RESULT.md' })).status, 201);
    const got = await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json(); assert.equal(got.activity[0].action, 'unblocked');
  } finally { await s.stop(); cleanup(); }
});
