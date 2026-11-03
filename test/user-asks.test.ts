// The user decision shape (public/user-ask.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askLines, askScope, askText, conflictsSection, EFFECTS, FIXED_CHOICE, hasHeader, setAutoOk, validateAsk, sameExceptAutoOk } from '../public/user-ask.js';

const CONFLICT = {
  kind: 'conflict',
  before: { quote: 'Contact form mails go to one shared inbox', date: '1999-10-23', ref: 'decisions#12' },
  wants: '문의 메일을 팀별로 나눠 보내기',
  code: { behavior: '폼이 고정 주소 한 곳으로 보냄', at: 'src/contact/send.ts:12' },
  options: [{ key: 'A', text: '받은편지함 하나 유지, 드롭다운은 아이디어로', effect: 'proceed' }, { key: 'B', text: '팀별 전송으로 카드 다시 쓰기', effect: 'respec' }],
  rec: { key: 'A', why: '전에 정한 것과 맞고 지금 코드도 그렇게 돎' },
};

test('the conflict shape is exactly the five labelled lines', () => {
  assert.deepEqual(validateAsk(CONFLICT), []);
  assert.equal(askText(CONFLICT), [
    'Decided before: "Contact form mails go to one shared inbox" (1999-10-23 / decisions#12)',
    'Wanted now: 문의 메일을 팀별로 나눠 보내기',
    'Code now: 폼이 고정 주소 한 곳으로 보냄 (src/contact/send.ts:12)',
    'Choices: A 받은편지함 하나 유지, 드롭다운은 아이디어로 (→ build it) / B 팀별 전송으로 카드 다시 쓰기 (→ rewrite the card)',
    'Recommended: A — 전에 정한 것과 맞고 지금 코드도 그렇게 돎',
  ].join('\n'));
  assert.deepEqual(askLines(CONFLICT).map((l: any) => l.label), ['Decided before', 'Wanted now', 'Code now', 'Choices', 'Recommended']);
});

test('a goal (no D-number) and no code yet still render the same five lines', () => {
  const a = { ...CONFLICT, before: { quote: '모바일에서 읽혀야 함', date: '2026-10-20' }, code: null, options: [CONFLICT.options[0]] };
  assert.deepEqual(validateAsk(a), []);
  const lines = askText(a).split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'Decided before: "모바일에서 읽혀야 함" (2026-10-20)');
  assert.equal(lines[2], 'Code now: no such code');
  assert.equal(lines[3], 'Choices: A 받은편지함 하나 유지, 드롭다운은 아이디어로 (→ build it)');
});

test('a taste pick has its own three lines', () => {
  const t = { kind: 'taste', wants: '결정 카드 색: 진한 남색 vs 회색', options: [{ key: 'A', text: '진한 남색', effect: 'proceed' }, { key: 'B', text: '회색', effect: 'proceed' }], rec: { key: 'B', why: '나머지 화면과 같음' } };
  assert.deepEqual(validateAsk(t), []);
  assert.equal(askText(t), 'Pick: 결정 카드 색: 진한 남색 vs 회색\nChoices: A 진한 남색 (→ build it) / B 회색 (→ build it)\nRecommended: B — 나머지 화면과 같음');
});

test('validation refuses anything outside the shape', () => {
  const bad = (patch: Record<string, unknown>) => validateAsk({ ...CONFLICT, ...patch });
  assert.ok(bad({ kind: 'other' }).length);
  assert.ok(bad({ before: null }).length, 'a conflict quotes what was decided');
  assert.ok(bad({ before: { ...CONFLICT.before, date: '10/23' } }).length);
  assert.ok(bad({ before: { ...CONFLICT.before, ref: 'not a ref!' } }).length);
  assert.deepEqual(bad({ wants: 'English is fine' }), [], 'any language');
  assert.ok(bad({ wants: '<b>굵게</b>' }).length, 'no markup');
  assert.ok(bad({ wants: '두\n줄' }).length, 'one line');
  assert.ok(bad({ code: { behavior: '돎', at: 'src/x.ts' } }).length, 'file:line');
  assert.ok(bad({ options: [] }).length);
  assert.ok(bad({ options: [...CONFLICT.options, { key: 'C', text: '셋째', effect: 'proceed' }] }).length, 'at most 2');
  assert.ok(bad({ options: [CONFLICT.options[1], CONFLICT.options[0]] }).length, 'keys A then B');
  assert.ok(bad({ options: [{ ...CONFLICT.options[0], effect: 'merge' }] }).length);
  assert.ok(bad({ rec: { key: 'C', why: '없음' } }).length);
  assert.ok(bad({ rec: { key: 'A', why: '' } }).length);
  assert.ok(bad({ extra: 1 }).length, 'unknown fields');
  assert.ok(validateAsk(null).length);
  assert.deepEqual([...EFFECTS], ['proceed', 'respec', 'cancel']);
});

test('the spec section: none, or one block per conflict', () => {
  assert.equal(conflictsSection([]), '## Conflicts\nnone\n');
  assert.equal(conflictsSection([CONFLICT, CONFLICT]), `## Conflicts\n\n### 1\n${askText(CONFLICT)}\n\n### 2\n${askText(CONFLICT)}\n`);
});

test('the signed scope names the card, its revision, the ask and every choice', () => {
  const s = askScope({ id: 'shared.t-x', version: 4, title: 'X', title_ko: '엑스' }, { ...CONFLICT, id: 'k1' }, 3);
  assert.equal(s, ['card: shared.t-x', 'revision: 4', 'spec: v3', 'ask: k1', 'kind: conflict', 'title: X', askText(CONFLICT), `choices: A=proceed / B=respec / ${FIXED_CHOICE.key}=respec`].join('\n'));
  // The same text with another effect is another question.
  const other = { ...CONFLICT, id: 'k1', options: [{ ...CONFLICT.options[0], effect: 'cancel' }, CONFLICT.options[1]] };
  assert.notEqual(askScope({ id: 'shared.t-x', version: 4, title: 'X' }, other, 3), askScope({ id: 'shared.t-x', version: 4, title: 'X' }, { ...CONFLICT, id: 'k1' }, 3));
  assert.match(askText(other), /A 받은편지함 하나 유지, 드롭다운은 아이디어로 \(→ cancel the card\)/);
  assert.equal(FIXED_CHOICE.effect, 'respec');
});

test('setAutoOk sets or replaces the one auto-ok header line', () => {
  const card = '# Job card: x\nid: shared.t-x\nsize: small\nspec_by: spec\n\n## Background\nauto-ok: true is not a header here\n';
  const out = setAutoOk(card, 'the user 2026-10-26: decision a1 chose A');
  assert.equal(out, '# Job card: x\nid: shared.t-x\nsize: small\nspec_by: spec\nauto-ok: true  # the user 2026-10-26: decision a1 chose A\n\n## Background\nauto-ok: true is not a header here\n');
  const again = setAutoOk('id: x\nauto-ok: false  # wait\nsize: big\n', 'n');
  assert.equal(again, 'id: x\nauto-ok: true  # n\nsize: big\n');
  assert.ok(sameExceptAutoOk(card, out));
  assert.ok(!sameExceptAutoOk(card, out.replace('size: small', 'size: big')));
  assert.throws(() => setAutoOk('## Background\nno header\n', 'n'), /header/);
});

test('CR / CRLF texts, leading blank lines and comment headers', () => {
  const cr = 'id: x\rsize: big\r\r## Acceptance tests\r1. a\r';
  const out = setAutoOk(cr, 'n');
  assert.equal(out, 'id: x\rsize: big\rauto-ok: true  # n\r\r## Acceptance tests\r1. a\r');
  assert.ok(sameExceptAutoOk(cr, out));
  assert.ok(!sameExceptAutoOk(cr, out.replace('1. a', '1. b')), 'a changed Acceptance section is not "the same"');
  assert.ok(!sameExceptAutoOk(cr, out.replace(/\r/g, '\n')), 'other line breaks: not the same text');
  assert.equal(setAutoOk('\n# Job card: x\n# a comment\nid: x\n\n## B\n', 'n'), '\n# Job card: x\n# a comment\nid: x\nauto-ok: true  # n\n\n## B\n');
  assert.ok(hasHeader('\n\nid: x\n'));
  // Mixed breaks are lines too, and an existing auto-ok: false is replaced, not left above a new true
  const mixed = 'id: x\nauto-ok: false\nsize: small\n\n## B\nend\r\n';
  const m = setAutoOk(mixed, 'n');
  assert.equal(m, 'id: x\nauto-ok: true  # n\nsize: small\n\n## B\nend\r\n');
  assert.ok(sameExceptAutoOk(mixed, m));
  assert.equal(setAutoOk('id: x\nauto-ok: false\nauto-ok: maybe\n', 'n'), 'id: x\nauto-ok: true  # n\n');
  assert.ok(!hasHeader('## Background\nno header\n'));
});
