// The needs_user wording rule (cases in test/fixtures/ask-rule.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkAsk } from '../src/lib/ask-rule.ts';
import { loadConfig } from '../src/lib/config.ts';
import { task, tempRepo } from './helpers.ts';
import { asHuman, humanSecrets, serve } from './state-support.ts';

const FX: { bad: { text: string; reasons: string[] }[]; good: string[] } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/ask-rule.json'), 'utf8'));
const NOOP1 = '지금은 할 일 없어요. 다시 보고 싶을 때 채택이나 반려를 말해 주세요.';
const NOOP2 = '할 일 없음. 러너가 CI 통과 확인 후 머지합니다.';
const GOOD = FX.good[0];
const CTX = { what: '머지 승인 요청', why: '교차 리뷰가 깨끗해요', rec: '승인', after: '승인하면 바로 병합돼요' };

test('checkAsk: every bad fixture gives its reason codes (in order), every good one []', () => {
  assert.ok(FX.bad.some((b) => b.text === NOOP1) && FX.bad.some((b) => b.text === NOOP2), 'both no-op asks are fixtures');
  for (const b of FX.bad) assert.deepEqual(checkAsk(b.text), b.reasons, b.text);
  for (const g of FX.good) assert.deepEqual(checkAsk(g), [], g);
  const long = FX.bad.find((b) => b.reasons.includes('too-long'))!;
  assert.equal([...long.text].length, 301, 'too-long counts code points');
  assert.deepEqual(checkAsk(long.text), ['too-long']);
  assert.deepEqual(checkAsk([...long.text].slice(0, 300).join('')), [], '300 code points is the limit');
  assert.deepEqual(checkAsk(''), ['not-a-question', 'no-effect']);
  assert.deepEqual(checkAsk('바꿀까요？ if you approve it ships.'), [], 'full-width ？ and English effect (any case)');
});

test('config: ask_rule defaults to enforce, DASKS_ASK_RULE overrides, anything else throws', () => {
  const { root, cleanup } = tempRepo();
  const prevEnv = process.env.DASKS_ASK_RULE; const prevCfg = process.env.DASKS_CONFIG;
  try {
    delete process.env.DASKS_ASK_RULE; delete process.env.DASKS_CONFIG;
    assert.equal(loadConfig(root).ask_rule, 'enforce');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ask_rule: 'warn' }));
    assert.equal(loadConfig(root).ask_rule, 'warn');
    process.env.DASKS_ASK_RULE = 'enforce';
    assert.equal(loadConfig(root).ask_rule, 'enforce');
    process.env.DASKS_ASK_RULE = 'off';
    assert.throws(() => loadConfig(root), /ask_rule/);
    delete process.env.DASKS_ASK_RULE;
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ask_rule: true }));
    assert.throws(() => loadConfig(root), /ask_rule/);
  } finally {
    if (prevEnv === undefined) delete process.env.DASKS_ASK_RULE; else process.env.DASKS_ASK_RULE = prevEnv;
    if (prevCfg === undefined) delete process.env.DASKS_CONFIG; else process.env.DASKS_CONFIG = prevCfg;
    cleanup();
  }
});

test('POST /api/tasks/:id: a bot ask that fails the rule is refused (400 + reasons, card file unchanged)', async () => {
  const id = 'delta.t-omega';
  const { root, cleanup } = tempRepo([task({ id, owner: 'delta-lead', status: 'doing' })]);
  const file = path.join(root, task({ id }).file);
  const s = await serve(root);
  try {
    const before = fs.readFileSync(file);
    let r = await s.post(`/api/tasks/${id}`, { status: 'blocked-on-user', needs_user: NOOP1 }, 'delta-lead');
    assert.equal(r.status, 400);
    let j = await r.json();
    assert.ok(j.reasons.includes('no-op') && j.reasons.includes('not-a-question'), JSON.stringify(j));
    assert.match(j.error, /^needs_user is not a yes\/no ask the user can approve: not-a-question, no-effect, no-op$/);
    assert.ok(fs.readFileSync(file).equals(before), 'the card file is unchanged');

    // No needs_user field: what updateTask would store is context.do (src/lib/write.ts), so that is checked.
    r = await s.post(`/api/tasks/${id}`, { status: 'blocked-on-user', ...CTX, do: NOOP2 }, 'delta-lead');
    assert.equal(r.status, 400);
    j = await r.json();
    assert.ok(j.reasons.includes('no-op'), JSON.stringify(j));
    assert.ok(fs.readFileSync(file).equals(before), 'the card file is unchanged (context.do path)');

    r = await s.post(`/api/tasks/${id}`, { status: 'blocked-on-user', needs_user: GOOD, ...CTX, do: GOOD }, 'delta-lead');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await (await fetch(`${s.url}/api/tasks/${id}`)).json()).needs_user, GOOD);
  } finally { await s.stop(); cleanup(); }
});

test('POST /api/tasks/:id: the user (user), an unchanged re-send, an empty value and ask_rule "warn" all get 200', async () => {
  const standing = 'delta.t-stand';
  const { root, cleanup } = tempRepo([task({ id: 'delta.t-human', owner: 'delta-lead', status: 'doing' }),
    task({ id: standing, owner: 'delta-lead', status: 'blocked-on-user', needs_user: NOOP1 }), task({ id: 'delta.t-empty', owner: 'delta-lead', status: 'doing' })]);
  const h = humanSecrets();
  const s = await serve(root, h.env);
  try {
    let r = await asHuman(s.url, '/api/tasks/delta.t-human', { needs_user: NOOP1 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.needs_user, NOOP1, "the user's own text is never checked");
    r = await s.post(`/api/tasks/${standing}`, { status: 'blocked-on-user', needs_user: `  ${NOOP1} `, ...CTX, do: GOOD }, 'delta-lead') as any;
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await s.post(`/api/tasks/${standing}`, { result: '확인했어요' }, 'delta-lead') as any;
    assert.equal(r.status, 200, 'a write that leaves the standing needs_user alone');
    r = await s.post('/api/tasks/delta.t-empty', { needs_user: '' }, 'delta-lead') as any;
    assert.equal(r.status, 200, JSON.stringify(r.json));
  } finally { await s.stop(); cleanup(); h.cleanup(); }

  const w = tempRepo([task({ id: 'delta.t-warn', owner: 'delta-lead', status: 'doing' })]);
  const sw = await serve(w.root, { DASKS_ASK_RULE: 'warn' });
  try {
    const r = await sw.post('/api/tasks/delta.t-warn', { status: 'blocked-on-user', needs_user: NOOP1, ...CTX, do: GOOD }, 'delta-lead');
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json();
    assert.ok(j.warnings.includes('ask rule: not-a-question, no-effect, no-op'), JSON.stringify(j.warnings));
    assert.match(decodeURIComponent(r.headers.get('x-dasks-warning') ?? ''), /ask rule: not-a-question, no-effect, no-op/);
    assert.equal(j.needs_user, NOOP1);
  } finally { await sw.stop(); w.cleanup(); }
});

test('needs_user null on a card with a standing ask still checks the context.do that would be stored', async () => {
  const id = 'delta.t-nulla';
  const { root, cleanup } = tempRepo([task({ id, owner: 'delta-lead', status: 'blocked-on-user', needs_user: GOOD })]);
  const file = path.join(root, task({ id }).file);
  const s = await serve(root);
  try {
    const before = fs.readFileSync(file);
    const r = await s.post(`/api/tasks/${id}`, { status: 'blocked-on-user', needs_user: null, ...CTX, do: NOOP2 }, 'delta-lead');
    assert.equal(r.status, 400, await r.clone().text());
    assert.ok((await r.json()).reasons.includes('no-op'));
    assert.ok(fs.readFileSync(file).equals(before), 'the card file is unchanged');
  } finally { await s.stop(); cleanup(); }
});
