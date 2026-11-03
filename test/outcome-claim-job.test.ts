// A run-less outcome binds to the card's current run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

const card = '/api/tasks/beta.t-smpl';
const review = { state: 'needs-review', note: '구현 검토 요청', evidence: ['RESULT.md'] };
const claimed = (job: string) => `\n## Context\nx\n\n## Notes\n- 2026-11-02 20:00 lanes: claim: #${job} open (beta-lead, desktop)\n`;
const head = (root: string) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

for (const route of ['/outcome', '/outcome-or-fail']) {
  test(`run-less ${route} from a job other than the open claim is stale and writes nothing`, async () => {
    const { root, cleanup } = tempRepo([task({ body: claimed('new-job') })]); const s = await serve(root);
    try {
      assert.equal((await s.post(card + '/claim', { who: 'job-runner' })).status, 200);
      const body = route === '/outcome' ? { ...review, job: 'old-job' } : { job: 'old-job', log: 'run/old.log' };
      const before = head(root);
      const stale = await s.post(card + route, body);
      assert.equal(stale.status, 409); assert.equal((await stale.json()).rule, 'stale-outcome'); assert.equal(head(root), before);
      const got = await (await fetch(s.url + card)).json(); assert.equal(got.status, 'doing'); assert.equal(got.outcomes.length, 0);
      const own = await s.post(card + route, { ...body, job: 'new-job' });
      assert.equal(own.status, 200); assert.equal((await own.json()).status, route === '/outcome' ? 'review' : 'todo');
    } finally { await s.stop(); cleanup(); }
  });
}

test('run-less outcome with no job, or on a card with no open claim, still binds to the current run', async () => {
  for (const [body, input] of [[claimed('new-job'), review], ['\n## Context\nx\n', { ...review, job: 'any-job' }]] as const) {
    const { root, cleanup } = tempRepo([task({ body })]); const s = await serve(root);
    try {
      assert.equal((await s.post(card + '/claim', { who: 'job-runner' })).status, 200);
      const r = await s.post(card + '/outcome', input); assert.equal(r.status, 200); assert.equal((await r.json()).status, 'review');
    } finally { await s.stop(); cleanup(); }
  }
});
