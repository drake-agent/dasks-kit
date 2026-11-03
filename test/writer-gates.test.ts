import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTask, updateTask, HttpError } from '../src/lib/write.ts';
import { taskEvidence } from '../src/lib/transitions.ts';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

const CTX = { what: 'Did it.', why: 'Needs a look.', do: 'Check it.', rec: 'Accept.', after: 'It closes.' };
const refused = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === 409 && e.data?.rule === 'transition');

test('the user can mark done from the board without evidence; other actors still need it', () => {
  const { root, cleanup } = tempRepo([
    task(), task({ id: 'beta.t-blckd', status: 'blocked-on-user', needs_user: '결정 필요' }), task({ id: 'beta.t-revw', status: 'review' }),
  ]);
  try {
    refused(() => updateTask(root, 'beta.t-smpl', { status: 'done' }, 'claude-code@desktop'));
    assert.equal(updateTask(root, 'beta.t-smpl', { status: 'done' }, 'user').status, 'done');
    assert.equal(updateTask(root, 'beta.t-blckd', { status: 'done' }, 'user', { ifStatus: ['review', 'blocked-on-user'] }).status, 'done');
    assert.equal(updateTask(root, 'beta.t-revw', { status: 'done' }, 'user', { ifStatus: ['review'] }).status, 'done');
    assert.equal(createTask(root, { goal: 'beta', title: 'Done on the board', status: 'done' }, 'user').status, 'done');
    refused(() => createTask(root, { goal: 'beta', title: 'Agent done', status: 'done' }, 'claude-code@desktop'));
  } finally { cleanup(); }
});

test('the user still needs reopen to move a done card back', () => {
  const { root, cleanup } = tempRepo([task({ status: 'done', result: 'RESULT.md' })]);
  try {
    refused(() => updateTask(root, 'beta.t-smpl', { status: 'todo' }, 'user'));
    assert.equal(updateTask(root, 'beta.t-smpl', { status: 'todo' }, 'user', { reopen: true }).status, 'todo');
  } finally { cleanup(); }
});

test('todo -> review is allowed', () => {
  const { root, cleanup } = tempRepo([task()]);
  try { assert.equal(updateTask(root, 'beta.t-smpl', { status: 'review' }, 'claude-code@desktop', { context: CTX }).status, 'review'); }
  finally { cleanup(); }
});

test('a .log word in free text is evidence only as a path', () => {
  assert.equal(taskEvidence({ pr: '', result: 'removed console.log calls' }), false);
  assert.equal(taskEvidence({ pr: '', result: 'tests pass, see run/test.log' }), true);
  assert.equal(taskEvidence({ pr: '', result: 'RESULT.md' }), true);
  // An outcome writes "<note>\n<first evidence>": a bare log file on its own line still counts.
  assert.equal(taskEvidence({ pr: '', result: '완료\nbuild.log' }), true);
});

test('outcome done with bare log evidence still completes the card', async () => {
  const { root, cleanup } = tempRepo([task({ status: 'doing', started_at: '2026-10-10T10:00:00+09:00' } as any)]);
  const s = await serve(root);
  try {
    const r = await s.post('/api/tasks/beta.t-smpl/outcome', { state: 'done', note: '완료', evidence: ['build.log'], job: 'job-bare-log' });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await (await fetch(s.url + '/api/tasks/beta.t-smpl')).json()).status, 'done');
  } finally { await s.stop(); cleanup(); }
});

test('finish without status: plain result -> review, log path -> done, PR -> review', async () => {
  const { root, cleanup } = tempRepo([task(), task({ id: 'beta.t-logd' }), task({ id: 'beta.t-pr' })]);
  const s = await serve(root);
  try {
    const plain = await s.post('/api/tasks/beta.t-smpl/finish', { result: 'Did the thing.', ...CTX });
    assert.equal(plain.status, 200, await plain.clone().text());
    assert.equal((await plain.json()).status, 'review');
    const logged = await s.post('/api/tasks/beta.t-logd/finish', { result: 'Did it, run/test.log' });
    assert.equal((await logged.json()).status, 'done');
    const pr = await s.post('/api/tasks/beta.t-pr/finish', { result: 'Opened it.', pr: 'https://github.com/x/y/pull/1', pr_summary: 'Adds it.', ...CTX });
    assert.equal((await pr.json()).status, 'review');
  } finally { await s.stop(); cleanup(); }
});

test('board UI: reopen on done -> todo/doing and cancelled -> anything, and a refused move shows the server reason', () => {
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const setStatus = app.slice(app.indexOf('async function setStatus'), app.indexOf('document.addEventListener(\'click\''));
  // every move out of cancelled is a reopen
  assert.match(setStatus, /if \(x\.status === 'cancelled' \|\| \(x\.status === 'done' && \['todo', 'doing'\]\.includes\(status\)\)\) body\.reopen = true/);
  assert.match(app, /err\.rule = data && data\.rule/);
  assert.match(app, /e\.status === 409 && e\.rule !== 'transition' \? t\('toast\.changed'\) : e\.message/);
});
