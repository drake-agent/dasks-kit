// Steps only the human can do: the line form, the prompts that carry the rule, and the daily summary's list (the data,
// the text and the page in English and Korean). The run itself is in test/runner.test.ts (e2e human step).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { HUMAN_STEP_RULE, humanStepLine, humanStepsOf, mergeHumanSteps, parseHumanStep } from '../src/lib/human-steps.ts';
import { continuePrompt, fixPrompt, reviewPrompt, runnerRules } from '../src/lib/runner.ts';
import { buildSummary, type SummaryInput } from '../src/lib/summary.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = new Date('2026-11-03T08:30:00Z'), SINCE = new Date('2026-11-02T08:30:00Z');
const IN_WINDOW = '2026-11-03T01:00:00Z', BEFORE = '2026-10-20T01:00:00Z', AFTER = '2026-11-03T09:00:00Z';
const NOTE = 'HUMAN-STEP: Sign the release build -- needs your signing certificate';
const summary = (tasks: SummaryInput['tasks']) => buildSummary({ now: NOW, since: SINCE, tasks, machines: [], stale: [], outcomes: [], warnings: [] });
const card = (id: string, status: string, notes: { at: string; note?: string }[]) => ({ id, title: `Title of ${id}`, goal: 'web', status, notes });

test('line form: step and why; the why may be missing; anything else is not a step', () => {
  assert.deepEqual(parseHumanStep(NOTE), { step: 'Sign the release build', why: 'needs your signing certificate' });
  assert.deepEqual(parseHumanStep('HUMAN-STEP: Plug in the phone — only you can reach it -- today'), { step: 'Plug in the phone', why: 'only you can reach it -- today' });
  assert.deepEqual(parseHumanStep('  HUMAN-STEP: Log in  '), { step: 'Log in', why: '' });
  for (const no of ['HUMAN-STEP:', 'HUMAN-STEP:   ', 'human-step: x', 'see HUMAN-STEP: x', 'claim: #1 closed', '', null, undefined]) assert.equal(parseHumanStep(no), null, String(no));
  assert.equal(humanStepLine(parseHumanStep(NOTE)!), NOTE, 'a note reads back as it was written');
  assert.equal(humanStepLine({ step: 'Log in', why: '' }), 'HUMAN-STEP: Log in');
});

test('line form: fits the card log, carries no secret', () => {
  const long = humanStepLine(parseHumanStep(`HUMAN-STEP: ${'s'.repeat(500)} -- ${'w'.repeat(500)}`)!);
  assert.ok(long.length <= 200, `${long.length} characters: the card log keeps 200`);
  const s = parseHumanStep(`HUMAN-STEP: Log in with password=hunter2hunter2 -- token ${'ghp_' + '0123456789abcdefghijklmnopqrstuvwxyz'} is old`)!;
  assert.doesNotMatch(JSON.stringify(s), /hunter2|ghp_/);
});

test('a run reports only the lines directly above its last RESULT line', () => {
  assert.deepEqual(humanStepsOf('work\nHUMAN-STEP: Log in -- yours\n\nHUMAN-STEP: Buy the domain -- costs money\nRESULT: built it').map((s) => s.step), ['Log in', 'Buy the domain']);
  assert.deepEqual(humanStepsOf('RESULT: built it'), [], 'no line, no step');
  assert.deepEqual(humanStepsOf('HUMAN-STEP: quoted from a doc\nnow something else\nRESULT: built it'), [], 'a quoted line further up does not count');
  assert.deepEqual(humanStepsOf('HUMAN-STEP: no result line'), [], 'no RESULT line: the run said nothing');
  assert.deepEqual(humanStepsOf('RESULT: stopped once\nHUMAN-STEP: Log in\nRESULT: built'), [{ step: 'Log in', why: '' }], 'the last RESULT line');
  assert.deepEqual(humanStepsOf(`${runnerRules('web.t-a', 'dasks/web.t-a', 'origin/main')}\nRESULT: built`), [], 'the prompt echoed in a Codex log is not a report');
  assert.equal(mergeHumanSteps(Array.from({ length: 30 }, (_, i) => ({ step: `s${i % 15}`, why: '' }))).length, 10, 'at most 10, no repeats');
});

test('prompts: every prompt that can change code carries the rule; the review does not act on it', () => {
  assert.match(HUMAN_STEP_RULE, /login, signing, a paid purchase, a physical device, an approval/);
  assert.match(HUMAN_STEP_RULE, /fake it/);
  assert.match(HUMAN_STEP_RULE, /Never report a skipped step as done/);
  assert.match(HUMAN_STEP_RULE, /`HUMAN-STEP: <what is left undone> -- <why only the human can do it>`/);
  assert.match(HUMAN_STEP_RULE, /RESULT: stopped needs the human/);
  for (const p of [runnerRules('web.t-a', 'dasks/web.t-a', 'origin/main'), fixPrompt('web.t-a', 'dasks/web.t-a', ['- [P1] x']), continuePrompt('web.t-a', 'dasks/web.t-a')]) assert.ok(p.includes(HUMAN_STEP_RULE));
  assert.match(continuePrompt('web.t-a', 'dasks/web.t-a'), /Repeat any such line/);
  assert.ok(!reviewPrompt('web.t-a', 'origin/main', 'claude').includes('HUMAN-STEP'));
});

test('summary: a skip note reaches the list, oldest first, with its card', () => {
  const s = summary([
    card('web.t-late', 'review', [{ at: IN_WINDOW, note: 'plain note' }, { at: IN_WINDOW, note: NOTE }]),
    card('web.t-early', 'todo', [{ at: BEFORE, note: 'HUMAN-STEP: Log in' }]),
  ]);
  assert.deepEqual(s.skipped.map((k) => [k.id, k.title, k.step, k.why, k.at]), [
    ['web.t-early', 'Title of web.t-early', 'Log in', '', BEFORE],
    ['web.t-late', 'Title of web.t-late', 'Sign the release build', 'needs your signing certificate', IN_WINDOW],
  ]);
  assert.match(s.text, /Skipped, left for you: 2\n {2}web\.t-early {2}Log in\n {2}web\.t-late {2}Sign the release build -- needs your signing certificate\n/);
});

test('summary: no notes, no section', () => {
  const s = summary([card('web.t-a', 'review', [{ at: IN_WINDOW, note: 'plain note' }, { at: IN_WINDOW }]), { id: 'web.t-b', title: 'B', goal: 'web', status: 'todo' }]);
  assert.deepEqual(s.skipped, []);
  assert.doesNotMatch(s.text, /Skipped/);
});

test('summary: a done card closes its step once it has been listed; cancelled closes it at once; open keeps it', () => {
  const notes = (at: string) => [{ at, note: NOTE }];
  const ids = (tasks: SummaryInput['tasks']) => summary(tasks).skipped.map((k) => k.id);
  assert.deepEqual(ids([card('web.t-open', 'review', notes(BEFORE))]), ['web.t-open'], 'still open: listed every day until the card ends');
  assert.deepEqual(ids([card('web.t-done', 'done', notes(BEFORE))]), [], 'done, step older than this window: closed');
  assert.deepEqual(ids([card('web.t-fresh', 'done', notes(IN_WINDOW))]), ['web.t-fresh'], 'done in the same window as the skip: seen once');
  assert.deepEqual(ids([card('web.t-gone', 'cancelled', notes(IN_WINDOW))]), []);
  assert.deepEqual(ids([card('web.t-next', 'todo', notes(AFTER))]), [], 'after the window: the next summary has it');
});

test('summary: a retry that notes the same step again is one entry, the latest', () => {
  const s = summary([card('web.t-a', 'todo', [{ at: BEFORE, note: NOTE }, { at: IN_WINDOW, note: NOTE }]), card('web.t-b', 'todo', [{ at: IN_WINDOW, note: NOTE }])]);
  assert.deepEqual(s.skipped.map((k) => [k.id, k.at]), [['web.t-a', IN_WINDOW], ['web.t-b', IN_WINDOW]], 'one per card and step');
});

test('summary text: more than 10 steps are cut with a count', () => {
  const s = summary([card('web.t-a', 'todo', Array.from({ length: 12 }, (_, i) => ({ at: IN_WINDOW, note: `HUMAN-STEP: step ${i}` })))]);
  assert.match(s.text, /Skipped, left for you: 12/);
  assert.match(s.text, / {2}… 2 more/);
});

/** public/app.js in a vm with a stub DOM: renderSummary into #day-summary in one language. */
function page(lang: string) {
  const el = (): any => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, {
    get(o: any, k) { if (k in o) return o[k]; if (k === 'querySelectorAll') return () => []; if (k === 'querySelector' || k === 'closest') return () => null; return typeof k === 'string' && /^(add|remove|set|get|focus|blur|scroll|contains|matches|append)/.test(k) ? () => null : undefined; },
    set(o, k, v) { o[k] = v; return true; },
  });
  const box = el();
  const document = { documentElement: el(), body: el(), hidden: false, activeElement: null, querySelector: (q: string) => (q === '#day-summary' ? box : el()), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const ctx: any = {
    document, window: { innerWidth: 1440, scrollY: 0, scrollTo() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { pathname: '/', search: '', hash: '', href: 'http://x/' }, history: { ['replace' + 'State']() {} },
    localStorage: { getItem: (k: string) => (k === 'dasks.lang' ? lang : null), setItem() {} }, CSS: { escape: (s: string) => s }, URLSearchParams, URL, console,
    fetch: () => new Promise(() => {}), EventSource: class {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ transitionDuration: '0s', transitionDelay: '0s' }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8'), ctx);
  const app = vm.runInContext(`${fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')}\n;({ S, SUM, renderSummary })`, ctx);
  return (s: unknown) => { app.S.summary = s; app.SUM.open = true; app.renderSummary(); return String(box.innerHTML); };
}

test('page: the list and its count in English and Korean; a row opens its card; text is escaped', () => {
  const s = summary([card('web.t-a', 'review', [{ at: IN_WINDOW, note: 'HUMAN-STEP: Sign <b>it</b> -- needs your certificate' }])]);
  const en = page('en')(s), ko = page('ko')(s);
  assert.match(en, /1 skipped for you/);
  assert.match(en, /<h3>Skipped steps, left for you · 1<\/h3>/);
  assert.match(ko, /1개 건너뜀/);
  assert.match(ko, /<h3>건너뛴 단계, 직접 해 주세요 · 1<\/h3>/);
  for (const html of [en, ko]) {
    assert.match(html, /data-action="select" data-id="web\.t-a"/);
    assert.match(html, /Sign &lt;b&gt;it&lt;\/b&gt; · needs your certificate/);
  }
});

test('page: no steps, or a summary written before this field, shows no section', () => {
  const s = summary([card('web.t-a', 'review', [])]);
  const { skipped: _skipped, ...old } = s;
  for (const lang of ['en', 'ko']) for (const x of [s, old]) assert.doesNotMatch(page(lang)(x), /sum-skip|skipped|건너/);
});
