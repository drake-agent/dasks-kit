// The spec word cap (docs/specs.md "How long a spec is"): a spec write over 1,500 words is a 422 contract reason; a spec
// stored over the cap before it existed stays readable and still takes shorter or auto-ok-only writes. Plus the prompt
// lines that go with it: the spec writer never writes how to build, the builder looks before it changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTask, HttpError } from '../src/lib/write.ts';
import { readSpec, specPaths, specWordErrors, specWords, SPEC_MAX_WORDS, writeSpec } from '../src/lib/specs.ts';
import { SPEC_METHOD } from '../src/lib/spec-flow.ts';
import { BUILD_METHOD_RULE, runnerRules } from '../src/lib/runner.ts';
import { setAutoOk } from '../public/user-ask.js';
import { tempRepo } from './helpers.ts';

const BASE = 'id: alpha.t-x\ngoal: alpha\nrole: builder\ntier: 1\nrepo: example-org/my-app\n'
  + 'branch: human/alpha.t-x\nlane: none\ndeadline: 2026-11-01\nsize: small\ndepends_on: none\nimpl: claude\nreview: codex\n'
  + 'done_when: the board shows the spec\ndone_at: pr\npass_checks:\n  - npm test is green\n  - GET returns the text\n  - over the cap is 422\n'
  + '\n## Background\nBackground text.\n\n## Why\nBecause.\n\n## Tests\n- test/x.test.ts\n\n## Notes\n';
/** A valid card of exactly `n` words. */
const cardOfWords = (n: number) => { const s = BASE + 'w '.repeat(n - specWords(BASE)); assert.equal(specWords(s), n); return s; };

const refusal = (fn: () => unknown): { status: number; reasons: string[] } => {
  try { fn(); return { status: 200, reasons: [] }; } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return { status: e.status, reasons: (e.data?.reasons as string[]) ?? [] };
  }
};

test('word count: runs of non-whitespace, any script, any line break', () => {
  assert.equal(specWords(''), 0);
  assert.equal(specWords('  one\ttwo\r\nthree\n\n 한국어 four '), 5);
  assert.equal(SPEC_MAX_WORDS, 1500);
});

test('word cap: exactly 1,500 words is stored, 1,501 is 422 with a fix message; an edit may not take a spec over it', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'alpha', title: 'Word cap' }, 'helper');
    const over = refusal(() => writeSpec(root, t.id, { text: cardOfWords(SPEC_MAX_WORDS + 1), expected: 0, note: '' }, 'helper'));
    assert.equal(over.status, 422);
    assert.equal(over.reasons.length, 1, JSON.stringify(over.reasons));
    assert.match(over.reasons[0], /^spec is 1501 words; the cap is 1500\. /);
    assert.match(over.reasons[0], /leave out how to build it/);
    assert.equal(writeSpec(root, t.id, { text: cardOfWords(SPEC_MAX_WORDS), expected: 0, note: '' }, 'helper').metadata.version, 1);
    assert.equal(refusal(() => writeSpec(root, t.id, { text: cardOfWords(SPEC_MAX_WORDS + 5), expected: 1, note: '' }, 'helper')).status, 422);
    assert.equal(readSpec(root, t.id).metadata.version, 1, 'the refusal stored nothing');
  } finally { cleanup(); }
});

test('word cap: a spec stored over the cap before it stays readable, takes a shorter or auto-ok-only write, and may not grow', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'alpha', title: 'Old long spec' }, 'helper');
    writeSpec(root, t.id, { text: cardOfWords(100), expected: 0, note: '' }, 'helper');
    // A spec written by an older kit, before the cap: put its text in place as committed.
    const long = cardOfWords(SPEC_MAX_WORDS + 100);
    const p = specPaths(t.id);
    for (const rel of [p.current, p.text(1)]) fs.writeFileSync(path.join(root, rel), long);
    execFileSync('git', ['-C', root, 'commit', '-qam', 'older spec']);
    assert.equal(readSpec(root, t.id).text, long, 'still readable');

    const ok = setAutoOk(long, 'the user chose A');
    assert.ok(specWords(ok) > specWords(long));
    assert.equal(writeSpec(root, t.id, { text: ok, expected: 1, note: '' }, 'user').metadata.version, 2, "the user's auto-ok answer goes through");
    const shorter = ok.replace('w w ', '');
    assert.equal(writeSpec(root, t.id, { text: shorter, expected: 2, note: '' }, 'helper').metadata.version, 3, 'a shorter edit goes through');
    assert.equal(refusal(() => writeSpec(root, t.id, { text: shorter + 'more words\n', expected: 3, note: '' }, 'helper')).status, 422, 'it may not grow');
    assert.deepEqual(specWordErrors(cardOfWords(SPEC_MAX_WORDS), long), [], 'under the cap is always fine');
  } finally { cleanup(); }
});

test('prompts: the spec method says never how to build and names the cap; every build prompt carries the build method', () => {
  assert.match(SPEC_METHOD, /never how to build it: no file-by-file plan, no step list, no code to paste/);
  assert.match(SPEC_METHOD, /under 1,500 words: the board refuses a longer one/);
  assert.match(BUILD_METHOD_RULE, /for a feature, first read the code around the change/);
  assert.match(BUILD_METHOD_RULE, /For a bug, reproduce it first/);
  assert.match(BUILD_METHOD_RULE, /quick throwaway prototype \(never committed\)/);
  const lines = runnerRules('web.t-a', 'dasks/web.t-a', 'origin/main').split('\n');
  assert.equal(lines.filter((l) => l === BUILD_METHOD_RULE).length, 1);
  const skill = fs.readFileSync(path.join(import.meta.dirname, '..', 'skills/spec-writer/SKILL.md'), 'utf8');
  assert.match(skill, /1,500 words/);
});
