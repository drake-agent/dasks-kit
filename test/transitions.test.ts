import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TRANSITIONS, type Status } from '../src/lib/schema.ts';
import { updateTask, createTask, HttpError } from '../src/lib/write.ts';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

const CTX = { what: 'w', why: 'y', do: 'd', rec: 'r', after: 'a' };
const refused = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === 409 && e.data?.rule === 'transition');
for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) for (const to of targets) {
  test(`allowed ${from} -> ${to}`, () => {
    const { root, cleanup } = tempRepo([task({ status: from as Status })]);
    try { assert.equal(updateTask(root, 'beta.t-smpl', { status: to, result: 'run/RESULT.md', needs_user: '결정 필요' }, 'sync', { reopen: true, context: CTX }).status, to); }
    finally { cleanup(); }
  });
}
test('refused evidence, terminal and force scopes', () => {
  const { root, cleanup } = tempRepo([task(), task({ id: 'beta.t-done', status: 'done' }), task({ id: 'beta.t-cncld', status: 'cancelled' })]);
  try {
    refused(() => updateTask(root, 'beta.t-smpl', { status: 'done' }, 'sync'));
    refused(() => updateTask(root, 'beta.t-smpl', { status: 'done', result: 'finished' }, 'sync', { holderOnly: { force: true } }));
    refused(() => updateTask(root, 'beta.t-done', { status: 'todo' }, 'sync'));
    refused(() => updateTask(root, 'beta.t-done', { status: 'doing' }, 'sync', { holderOnly: { force: true } }));
    refused(() => updateTask(root, 'beta.t-cncld', { status: 'doing' }, 'sync'));
    refused(() => updateTask(root, 'beta.t-cncld', { status: 'blocked-on-user' }, 'sync', { reopen: true }));
    refused(() => updateTask(root, 'beta.t-done', { status: 'blocked-on-user' }, 'sync', { reopen: true }));
    refused(() => createTask(root, { goal: 'beta', title: 'invalid done', status: 'done' }, 'sync'));
    assert.throws(() => updateTask(root, 'beta.t-done', { status: 'todo' }, 'sync', { reopen: true, expectedVersion: 99 }), /version conflict/);
    assert.equal(updateTask(root, 'beta.t-cncld', {}, 'sync', { claim: { op: 'claim', who: 'sync', force: true } }).status, 'doing');
    assert.equal(updateTask(root, 'beta.t-cncld', {}, 'sync', { claim: { op: 'release', who: 'sync' } }).status, 'todo');
  } finally { cleanup(); }
});

test('claim takeover force is not a general terminal override; same-status edits on a closed card still work', () => {
  const { root, cleanup } = tempRepo([task({ status: 'done' })]);
  try {
    refused(() => updateTask(root, 'beta.t-smpl', { status: 'todo' }, 'sync', { claim: { op: 'claim', who: 'sync', force: true } }));
    assert.equal(updateTask(root, 'beta.t-smpl', { title: 'Renamed' }, 'sync').status, 'done');
    assert.equal(createTask(root, { goal: 'beta', title: 'Evidence backed creation', status: 'done', result: 'RESULT.md' }, 'sync').status, 'done');
  } finally { cleanup(); }
});

test('HTTP edits to the result and pr of a done card do not require new completion evidence', async () => {
  const { root, cleanup } = tempRepo([task({ status: 'done', result: 'merged' }), task({ id: 'beta.t-doing', status: 'doing' })]); const s = await serve(root);
  try {
    for (const patch of [{ result: 'merged; follow-up noted' }, { pr: '' }, { status: 'done', result: 'merged; next step recorded', pr: '' }]) {
      const response = await s.post('/api/tasks/beta.t-smpl', patch);
      assert.equal(response.status, 200, await response.text());
    }
    const got = await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json();
    assert.equal(got.status, 'done');
    assert.equal(got.result, 'merged; next step recorded');
    assert.equal(got.pr ?? '', '');
    const refused = await s.post('/api/tasks/beta.t-doing', { status: 'done', result: 'merged' });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).rule, 'transition');
    assert.equal((await s.post('/api/tasks', { goal: 'beta', title: 'No evidence', status: 'done', result: 'merged' })).status, 409);
  } finally { await s.stop(); cleanup(); }
});
