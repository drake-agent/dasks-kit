// When a card leaves the spec-rework lane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { task, tempRepo } from './helpers.ts';
import { serve } from './state-support.ts';

// Actor families by the default prefixes: human-claude* anthropic, codex* openai.
const A = 'human-claude@laptop-a', C = 'codex@laptop-c';
const RW = { lane: 'spec-rework', next_owner: 'beta-lead' } as const;

// A contract-valid card (test/spec-state.test.ts card()) with an Acceptance tests section.
function card(id: string, o: { bg?: string; head?: string } = {}): string {
  return `id: ${id}\ngoal: beta\nrole: builder\ntier: 1\nrepo: example-org/dasks\nbranch: human/${id}\nlane: none\n`
    + `deadline: 2026-11-01\nsize: small\ndepends_on: none\nimpl: claude\nreview: codex\n${o.head ?? ''}`
    + 'done_when: the board shows the spec\ndone_at: pr\n' + 'pass_checks:\n  - npm test is green\n  - GET returns the text\n  - over the cap is 413\n'
    + `\n## Background\n${o.bg ?? 'Background text.'}\n\n## Why\nBecause.\n\n## Context pack\n- docs/x.md\n\n## Tests\n- test/x.test.ts\n`
    + '\n## Acceptance tests\n1. GET returns the text.\n2. PUT stores a version.\n'
    + '\n## Notes\nend\n';
}

test('spec-rework lane: left only when the spec turns ready (spec PUT, review, unblock); other lanes untouched', async () => {
  const { root, cleanup } = tempRepo([
    task({ id: 'beta.t-rw', ...RW }), task({ id: 'beta.t-carry', ...RW }),
    task({ id: 'beta.t-other', lane: 'claude', next_owner: 'beta-lead' }), task({ id: 'beta.t-unb', ...RW }),
  ]);
  const s = await serve(root);
  try {
    const call = async (method: string, route: string, body: unknown, actor: string) => {
      const r = await fetch(s.url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, text };
    };
    const put = (id: string, text: string, expected: number) => call('PUT', `/api/tasks/${id}/spec`, { text, expected_spec_version: expected }, A);
    const review = (id: string, spec_version: number, verdict: string) => call('POST', `/api/tasks/${id}/spec/review`, { spec_version, verdict }, C);
    const get = async (id: string) => (await fetch(`${s.url}/api/tasks/${id}`)).json() as Promise<any>;
    const readyAll = async (): Promise<string[]> => ((await (await fetch(`${s.url}/api/ready?all=1`)).json()) as any).ready.map((x: any) => x.id);
    const ok = (r: { status: number; text: string }, what: string) => assert.equal(r.status, 200, `${what}: ${r.text}`);
    const lane = async (id: string, want: [string, string], what: string) => { const t = await get(id); assert.deepEqual([t.lane, t.next_owner ?? ''], want, what); return t; };

    ok(await put('beta.t-rw', card('beta.t-rw'), 0), 'A put');
    let t = await lane('beta.t-rw', ['spec-rework', 'beta-lead'], 'A: draft PUT keeps spec-rework');
    assert.equal(t.spec_state, 'draft');
    assert.ok(!(await readyAll()).includes('beta.t-rw'), 'A: not in ready?all=1');

    ok(await review('beta.t-rw', 1, 'fail'), 'B review');
    await lane('beta.t-rw', ['spec-rework', 'beta-lead'], 'B: fail review keeps spec-rework');

    ok(await put('beta.t-rw', card('beta.t-rw', { bg: 'Background text, v2.' }), 1), 'C put');
    await lane('beta.t-rw', ['spec-rework', 'beta-lead'], 'C: second draft PUT keeps spec-rework');

    ok(await review('beta.t-rw', 2, 'pass'), 'D review');
    t = await lane('beta.t-rw', ['none', ''], 'D: pass review leaves spec-rework');
    assert.equal(t.spec_state, 'ready');
    assert.ok((await readyAll()).includes('beta.t-rw'), 'D: in ready?all=1');

    ok(await put('beta.t-carry', card('beta.t-carry'), 0), 'E put v1');
    ok(await review('beta.t-carry', 1, 'pass'), 'E review v1');
    await lane('beta.t-carry', ['none', ''], 'E: pass review leaves spec-rework');
    ok(await call('POST', '/api/tasks/beta.t-carry', RW, 'spec'), 'E: back to spec-rework');
    await lane('beta.t-carry', ['spec-rework', 'beta-lead'], 'E: back in spec-rework');
    ok(await put('beta.t-carry', card('beta.t-carry', { head: 'auto-ok: true  # test\n' }), 1), 'E put v2 (auto-ok)');
    t = await lane('beta.t-carry', ['none', ''], 'E: auto-ok carry leaves spec-rework');
    assert.equal(t.spec_state, 'ready');

    const other: [string, string] = ['claude', 'beta-lead'];
    ok(await put('beta.t-other', card('beta.t-other'), 0), 'F put v1'); await lane('beta.t-other', other, 'F after PUT v1');
    ok(await review('beta.t-other', 1, 'fail'), 'F fail'); await lane('beta.t-other', other, 'F after fail review');
    ok(await put('beta.t-other', card('beta.t-other', { bg: 'v2' }), 1), 'F put v2'); await lane('beta.t-other', other, 'F after PUT v2');
    ok(await review('beta.t-other', 2, 'pass'), 'F pass'); t = await lane('beta.t-other', other, 'F after pass review');
    assert.equal(t.spec_state, 'ready');

    ok(await put('beta.t-unb', card('beta.t-unb'), 0), 'G put v1');
    ok(await call('POST', '/api/tasks/beta.t-unb/spec/block', { expected_version: (await get('beta.t-unb')).version, expected_spec_version: 1, block_note: 'test block' }, 'spec'), 'G block');
    ok(await put('beta.t-unb', card('beta.t-unb', { bg: 'fixed' }), 1), 'G put v2');
    ok(await review('beta.t-unb', 2, 'pass'), 'G pass');
    t = await lane('beta.t-unb', ['spec-rework', 'beta-lead'], 'G: blocked keeps spec-rework');
    assert.equal(t.spec_state, 'blocked');
    ok(await call('POST', '/api/tasks/beta.t-unb/spec/unblock', { expected_version: (await get('beta.t-unb')).version, expected_spec_version: 2 }, A), 'G unblock');
    t = await lane('beta.t-unb', ['none', ''], 'G: unblock to ready leaves spec-rework');
    assert.equal(t.spec_state, 'ready');
  } finally { await s.stop(); cleanup(); }
});
