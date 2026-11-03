// The user decision queue over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { task, tempRepo } from './helpers.ts';
import { asHuman, humanSecrets, serve } from './state-support.ts';

const SPEC_BY = 'human-claude@laptop-spec';
const REVIEWER = 'codex@laptop-review';
const AGENT = 'human-claude@laptop-spec';

function card(id: string, size: string): string {
  return `id: ${id}\ngoal: shared\nrole: builder\ntier: 1\nrepo: example-org/dasks\nbranch: human/${id}\nlane: none\n`
    + `deadline: 2026-11-01\nsize: ${size}\ndepends_on: none\nimpl: claude\nreview: codex\n`
    + 'done_when: the board shows the spec\ndone_at: pr\n' + 'pass_checks:\n  - npm test is green\n  - GET returns the text\n  - over the cap is 413\n'
    + '\n## Background\nBackground text.\n\n## Why\nBecause.\n\n## Context pack\n- docs/x.md\n\n## Tests\n- test/x.test.ts\n'
    + '\n## Acceptance tests\n1. GET returns the text.\n2. PUT stores a version.\n\n## Notes\nend\n';
}

const ASK = {
  kind: 'conflict',
  before: { quote: 'Contact form mails go to one shared inbox', date: '1999-10-23', ref: 'decisions#12' },
  wants: '문의 메일을 팀별로 나눠 보내기',
  code: { behavior: '폼이 고정 주소 한 곳으로 보냄', at: 'src/contact/send.ts:12' },
  options: [{ key: 'A', text: '그대로 만들기', effect: 'proceed' }, { key: 'B', text: '취소', effect: 'cancel' }],
  rec: { key: 'A', why: '전에 정한 것과 맞음' },
};

async function setup() {
  const ids = ['shared.t-big', 'shared.t-small', 'shared.t-nospc', 'shared.t-done', 'shared.t-rspec'];
  const repo = tempRepo(ids.map((id) => task({ id, title: `Card ${id}`, owner: 'ops-lead', status: id.endsWith('done') ? 'done' : 'todo' })));
  const secrets = humanSecrets();
  const s = await serve(repo.root, secrets.env);
  const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });
  const as = (actor: string, route: string, body: unknown, method = 'POST') =>
    fetch(s.url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) }).then(json);
  const get = (route: string) => fetch(s.url + route).then(json);
  for (const [id, size] of [['shared.t-big', 'big'], ['shared.t-small', 'small'], ['shared.t-rspec', 'small']]) {
    assert.equal((await as(SPEC_BY, `/api/tasks/${id}/spec`, { text: card(id, size), expected_spec_version: 0 }, 'PUT')).status, 200);
  }
  assert.equal((await as(REVIEWER, '/api/tasks/shared.t-big/spec/review', { spec_version: 1, verdict: 'pass' })).status, 200);
  return { ...s, root: repo.root, as, get, cleanup: async () => { await s.stop(); repo.cleanup(); secrets.cleanup(); } };
}

test('flag → queue → answer: one decision, one answer, the card moves on', async () => {
  const s = await setup();
  try {
    assert.equal((await s.get('/api/tasks/shared.t-big')).body.spec_state, 'ready');
    // preview: the shape as text and as the spec section, nothing written
    const pv = await s.as(AGENT, '/api/asks/preview', ASK);
    assert.equal(pv.status, 200);
    assert.match(pv.body.text, /^Decided before: "Contact form mails go to one shared inbox" \(1999-10-23 \/ decisions#12\)\n/);
    assert.match(pv.body.section, /^## Conflicts\n\n### 1\nDecided before/);
    assert.equal((await s.get('/api/asks')).body.count, 0);

    // bad shape, unknown card, terminal card, the human asking itself
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-big', { ...ASK, wants: '' })).status, 400);
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-nope', ASK)).status, 404);
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-done', ASK)).status, 409);
    assert.equal((await s.as('user', '/api/asks/shared.t-big', ASK)).status, 401, 'user needs a session, and the human never asks itself');

    const made = await s.as(AGENT, '/api/asks/shared.t-big', ASK);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.ask.id, 'k1');
    assert.equal(made.body.text, pv.body.text);
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-big', ASK)).status, 409, 'one open decision per card');

    const t = (await s.get('/api/tasks/shared.t-big')).body;
    assert.equal(t.status, 'blocked-on-user');
    assert.match(t.needs_user, /^Decision needed: /);
    assert.equal(t.decision_request, undefined, 'the board does not offer approve/reject for it');
    assert.deepEqual(t.user_ask, { id: 'k1', kind: 'conflict' });
    assert.equal((await s.get('/api/decisions/request/shared.t-big')).status, 409);

    // the queue
    const q = (await s.get('/api/asks')).body;
    assert.equal(q.format, 'dasks-asks/1');
    assert.equal(q.count, 1);
    const it = q.items[0];
    assert.equal(it.card, 'shared.t-big'); assert.equal(it.title, 'Card shared.t-big'); assert.equal(it.app, 'shared');
    assert.equal(it.text, pv.body.text);
    assert.deepEqual(it.lines.map((l: any) => l.label), ['Decided before', 'Wanted now', 'Code now', 'Choices', 'Recommended']);
    assert.deepEqual(it.request.choices, ['A', 'B', 'none']);
    assert.equal(it.request.ask, 'k1');
    assert.match((await fetch(s.url + '/asks.md').then((r) => r.text())), /## shared\.t-big\n/);

    // the approve/reject decision path refuses it: an ask has one answer path
    const old = await asHuman(s.url, '/api/decisions', { card: 'shared.t-big', revision: it.request.revision, scope: it.request.scope, choice: 'approve' });
    assert.equal(old.status, 409);

    // answering: no session, a stale scope, a choice not offered
    const r = it.request;
    const anon = await fetch(s.url + '/api/asks/shared.t-big/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'user' }, body: JSON.stringify({ ask: r.ask, revision: r.revision, scope: r.scope, choice: 'A' }) });
    assert.equal(anon.status, 401);
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-big/answer', { ask: r.ask, revision: r.revision, scope: r.scope, choice: 'A' })).status, 403, 'only the human answers');
    assert.equal((await asHuman(s.url, '/api/asks/shared.t-big/answer', { ask: r.ask, revision: r.revision, scope: r.scope + 'x', choice: 'A' })).status, 409);
    assert.equal((await asHuman(s.url, '/api/asks/shared.t-big/answer', { ask: r.ask, revision: r.revision, scope: r.scope, choice: 'C' })).status, 409);
    assert.equal((await asHuman(s.url, '/api/asks/shared.t-big/answer', { ask: r.ask, revision: r.revision, scope: r.scope, choice: 'A', actor: 'x' })).status, 409);

    const ok = await asHuman(s.url, '/api/asks/shared.t-big/answer', { ask: r.ask, revision: r.revision, scope: r.scope, choice: 'A', comment: '좋아' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.effect, 'proceed');
    const after = (await s.get('/api/tasks/shared.t-big')).body;
    assert.equal(after.status, 'todo');
    assert.equal(after.needs_user, '');
    assert.equal(after.user_ask, undefined);
    const spec = (await s.get('/api/tasks/shared.t-big/spec')).body;
    assert.equal(spec.metadata.version, 2);
    assert.equal(spec.metadata.by, 'user');
    assert.match(spec.text, /^auto-ok: true {2}# the user \d{4}-\d{2}-\d{2}: decision k1 chose A/m);
    assert.equal(after.spec_state, 'ready', 'the big card keeps its text review: only the auto-ok line changed');
    assert.equal(after.spec_review.spec_version, 2);
    assert.match(after.body, /text review of v1 kept for v2/, 'the carry is said on the card (spec_review keeps its fixed shape)');
    assert.equal((await s.get('/api/asks')).body.count, 0, 'answered = off the queue');

    // a replay is refused with the first answer; the ledger holds exactly one signed line
    const again = await asHuman(s.url, '/api/asks/shared.t-big/answer', { ask: r.ask, revision: r.revision, scope: r.scope, choice: 'B' });
    assert.equal(again.status, 409);
    const ledger = fs.readFileSync(path.join(s.root, 'data/decisions/asks.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledger.length, 1);
    assert.equal(JSON.parse(ledger[0]).choice, 'A');
    assert.ok(!fs.existsSync(path.join(s.root, 'data/decisions/ledger.jsonl')), 'the approve/reject ledger is untouched');
    const file = JSON.parse(fs.readFileSync(path.join(s.root, 'data/asks/shared/t-big.json'), 'utf8'));
    assert.equal(file.open, null);
    assert.equal(file.answered[0].answer.choice, 'A');
    assert.equal(file.answered[0].answer.comment, '좋아');
  } finally { await s.cleanup(); }
});

test('the other effects: respec blocks for Spec, cancel cancels, none = respec; newest first; taste picks listed', async () => {
  const s = await setup();
  try {
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-small', ASK)).status, 201);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-nospc', { kind: 'taste', wants: '버튼 색 고르기', options: [{ key: 'A', text: '남색', effect: 'proceed' }, { key: 'B', text: '회색', effect: 'proceed' }], rec: { key: 'B', why: '다른 화면과 같음' } })).status, 201);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-rspec', { ...ASK, options: [{ key: 'A', text: '다시 써 오기', effect: 'respec' }] })).status, 201);
    const q = (await s.get('/api/asks')).body;
    assert.deepEqual(q.items.map((i: any) => i.card), ['shared.t-rspec', 'shared.t-nospc', 'shared.t-small']);
    assert.equal(q.items[1].kind, 'taste');
    assert.deepEqual(q.items[1].lines.map((l: any) => l.label), ['Pick', 'Choices', 'Recommended']);
    const answer = (i: number, choice: string) => { const r = q.items[i].request; return asHuman(s.url, `/api/asks/${q.items[i].card}/answer`, { ask: r.ask, revision: r.revision, scope: r.scope, choice }); };

    assert.equal((await answer(0, 'A')).json.effect, 'respec');
    const rs = (await s.get('/api/tasks/shared.t-rspec')).body;
    assert.equal(rs.status, 'todo'); assert.equal(rs.spec_state, 'blocked'); assert.equal(rs.blocked_by, 'user');
    assert.match(rs.block_note, /다시 써 오기/);

    assert.equal((await answer(2, 'B')).json.effect, 'cancel');
    assert.equal((await s.get('/api/tasks/shared.t-small')).body.status, 'cancelled');

    // a taste pick on a card with no spec: proceed records the pick; there is no spec to put auto-ok on
    const tp = await answer(1, 'B');
    assert.equal(tp.status, 200); assert.equal(tp.json.effect, 'proceed'); assert.equal(tp.json.auto_ok, false);
    const ns = (await s.get('/api/tasks/shared.t-nospc')).body;
    assert.equal(ns.status, 'todo');
    assert.match(ns.body, /user answer: B/);
    assert.equal((await s.get('/api/asks')).body.count, 0);
  } finally { await s.cleanup(); }
});

test('the fixed "none" choice sends any card back to Spec; a card moved on meanwhile is not answerable', async () => {
  const s = await setup();
  try {
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-small', ASK)).status, 201);
    const r = (await s.get('/api/asks')).body.items[0].request;
    const out = await asHuman(s.url, '/api/asks/shared.t-small/answer', { ask: r.ask, revision: r.revision, scope: r.scope, choice: 'none' });
    assert.equal(out.json.effect, 'respec');
    assert.equal((await s.get('/api/tasks/shared.t-small')).body.spec_state, 'blocked');

    assert.equal((await s.as(AGENT, '/api/asks/shared.t-big', ASK)).status, 201);
    const r2 = (await s.get('/api/asks')).body.items[0].request;
    // an agent edits the card after the ask (its version moves): the shown question is stale
    assert.equal((await s.as(AGENT, '/api/tasks/shared.t-big', { priority: 'p1' })).status, 200);
    const stale = await asHuman(s.url, '/api/asks/shared.t-big/answer', { ask: r2.ask, revision: r2.revision, scope: r2.scope, choice: 'A' });
    assert.equal(stale.status, 409);
    assert.equal((await s.get('/api/asks')).body.items[0].request.revision, r2.revision + 1, 'the queue shows the new revision');
  } finally { await s.cleanup(); }
});

test('the page: /asks is served, builds its DOM without innerHTML, and the board links to it', async () => {
  const s = await setup();
  try {
    const page = await fetch(s.url + '/asks');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /user-ask\.js|asks\.js/);
    const js = await fetch(s.url + '/asks.js').then((r) => r.text());
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(js));
    assert.equal((await fetch(s.url + '/user-ask.js')).status, 200);
    // reached from the board's top bar
    assert.match(fs.readFileSync(path.resolve(import.meta.dirname, '../public/index.html'), 'utf8'), /href="\/asks"/);
  } finally { await s.cleanup(); }
});

test('an old receipt never answers a new ask; a spec changed after it was shown is a new question', async () => {
  const s = await setup();
  try {
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-rspec', ASK)).status, 201);
    const r1 = (await s.get('/api/asks')).body.items[0].request;
    assert.equal((await asHuman(s.url, '/api/asks/shared.t-rspec/answer', { ask: r1.ask, revision: r1.revision, scope: r1.scope, choice: 'none' })).status, 200);
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-rspec', ASK)).status, 201);
    const replay = await asHuman(s.url, '/api/asks/shared.t-rspec/answer', { ask: 'k2', revision: r1.revision, scope: r1.scope, choice: 'none' });
    assert.equal(replay.status, 409);
    assert.equal((await s.get('/api/asks')).body.items[0].request.ask, 'k2', 'k2 still waits');

    // the spec of a small card changes after the ask was shown: the shown scope no longer answers
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-small', ASK)).status, 201);
    const shown = (await s.get('/api/asks')).body.items.find((i: any) => i.card === 'shared.t-small').request;
    assert.match(shown.scope, /^spec: v1$/m);
    const v1 = (await s.get('/api/tasks/shared.t-small/spec')).body.text;
    assert.equal((await s.as(SPEC_BY, '/api/tasks/shared.t-small/spec', { text: v1.replace('Background text.', 'Changed background.'), expected_spec_version: 1 }, 'PUT')).status, 200);
    const stale = await asHuman(s.url, '/api/asks/shared.t-small/answer', { ask: shown.ask, revision: shown.revision, scope: shown.scope, choice: 'A' });
    assert.equal(stale.status, 409);
    assert.equal((await s.get('/api/tasks/shared.t-small/spec')).body.metadata.version, 2, 'no auto-ok version was written');
  } finally { await s.cleanup(); }
});

test('respec without a spec blocks for Spec; a card that left blocked-on-user drops its old ask; shown title is signed', async () => {
  const s = await setup();
  try {
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-nospc', ASK)).status, 201);
    const r = (await s.get('/api/asks')).body.items[0].request;
    assert.equal((await asHuman(s.url, '/api/asks/shared.t-nospc/answer', { ask: r.ask, revision: r.revision, scope: r.scope, choice: 'none' })).status, 200);
    const ns = (await s.get('/api/tasks/shared.t-nospc')).body;
    assert.equal(ns.spec_state, 'blocked');
    assert.equal((await s.as(AGENT, '/api/tasks/shared.t-nospc/claim', {})).status, 409, 'no build before a new spec (Spec block)');

    // k1 left unanswered; the card is moved on by hand, then blocked again for something else
    assert.equal((await s.as(AGENT, '/api/tasks/shared.t-big', { title: 'Big card', title_ko: '큰 카드' })).status, 200);
    assert.equal((await s.as(AGENT, '/api/asks/shared.t-big', ASK)).status, 201);
    const it = (await s.get('/api/asks')).body.items[0];
    assert.equal(it.title, 'Big card', 'the original title, whatever the display titles');
    assert.match(it.request.scope, /^title: Big card$/m);
    assert.equal((await s.as(AGENT, '/api/tasks/shared.t-big', { status: 'todo' })).status, 200);
    await new Promise((res) => setTimeout(res, 1100));
    assert.equal((await s.as(AGENT, '/api/tasks/shared.t-big', { status: 'blocked-on-user', needs_user: '다른 것으로 갈까요? OK하면 다른 것으로 진행해요.', what: '다른 것', why: '이유', do: '할 일', rec: '추천', after: '답하면' })).status, 200);
    assert.equal((await s.get('/api/asks')).body.count, 0, 'the old ask does not come back');
    assert.ok((await s.get('/api/tasks/shared.t-big')).body.decision_request, 'the card asks approve/reject on the board again');
    const again = await s.as(AGENT, '/api/asks/shared.t-big', ASK);
    assert.equal(again.status, 201); assert.equal(again.body.ask.id, 'k2');
  } finally { await s.cleanup(); }
});
