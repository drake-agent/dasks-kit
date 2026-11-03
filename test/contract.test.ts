// src/lib/contract.ts against the Python reference (expected.json = test/fixtures/contract/golden.py output).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkCard, pairGuard } from '../src/lib/contract.ts';

const DIR = path.resolve(import.meta.dirname, 'fixtures/contract');
const expected: Record<string, { ok: boolean; errors: string[]; warnings: string[] }> = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));
const cards = fs.readdirSync(path.join(DIR, 'cards')).sort();
const verdict = (name: string) => {
  const r = checkCard(fs.readFileSync(path.join(DIR, 'cards', name), 'utf8'));
  return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings };
};

test('contract: every fixture card has a golden verdict, and the set covers clean, warnings-only, hard errors and pair cases', () => {
  assert.deepEqual(Object.keys(expected).sort(), cards);
  assert.ok(expected['clean.md'].ok && !expected['clean.md'].warnings.length);
  assert.ok(expected['warnings-only.md'].ok && expected['warnings-only.md'].warnings.length > 0);
  assert.ok(!expected['hard-errors.md'].ok && expected['hard-errors.md'].errors.length > 1);
  for (const n of ['pair-reversed.md', 'pair-alias.md', 'pair-alias-spaces.md']) assert.ok(expected[n].ok, n);
  for (const n of ['pair-missing.md', 'pair-unknown.md', 'pair-same.md']) assert.match(expected[n].errors.join(), /^PAIR REFUSED/, n);
});

for (const name of cards) {
  test(`contract: ${name} matches contract.py card`, () => {
    assert.deepEqual(verdict(name), expected[name]);
  });
}

test('contract: live parity with contract.py when python3 is present', (t) => {
  let out = '';
  try { out = execFileSync('python3', [path.join(DIR, 'golden.py')], { encoding: 'utf8' }); }
  catch { t.skip('python3 not available'); return; }
  const live = JSON.parse(out);
  for (const name of cards) assert.deepEqual(verdict(name), live[name], name);
});

test('pairGuard: families by name prefix, both directions, missing / unknown / same family', () => {
  assert.equal(pairGuard('claude', 'codex'), null);
  assert.equal(pairGuard('GPT-Example-Model', 'Claude-Example-Model'), null, 'case and the model after the prefix do not matter');
  assert.equal(pairGuard('Claude Code', 'codex'), null, 'spaces are dropped');
  assert.equal(pairGuard('', 'codex'), 'PAIR REFUSED: implementer model not specified');
  assert.equal(pairGuard('claude', ''), 'PAIR REFUSED: reviewer model not specified');
  assert.equal(pairGuard('bot', 'codex'), "PAIR REFUSED: unknown implementer model 'bot'");
  assert.equal(pairGuard('claude', 'mystery'), "PAIR REFUSED: unknown reviewer model 'mystery'");
  assert.equal(pairGuard('codex', 'gpt-example'), 'PAIR REFUSED: same model family reviewing itself (codex -> gpt-example)');
  assert.equal(pairGuard('claude', 'claude-example'), 'PAIR REFUSED: same model family reviewing itself (claude -> claude-example)');
  assert.equal(pairGuard('claude', 'claude'), 'PAIR REFUSED: same model family reviewing itself (claude -> claude)');
});

test('checkCard: impl claude + review codex passes; claude + claude is refused; config families name other models', () => {
  const clean = fs.readFileSync(path.join(DIR, 'cards', 'clean.md'), 'utf8');
  assert.match(clean, /^impl: claude\nreview: codex$/m);
  assert.deepEqual(checkCard(clean).errors, []);
  assert.deepEqual(checkCard(clean.replace('review: codex', 'review: claude')).errors, ['PAIR REFUSED: same model family reviewing itself (claude -> claude)']);
  const gemini = clean.replace('review: codex', 'review: gemini');
  assert.deepEqual(checkCard(gemini).errors, ["PAIR REFUSED: unknown reviewer model 'gemini'"]);
  assert.deepEqual(checkCard(gemini, { 'gemini*': 'google' }).errors, [], 'a family from config');
  assert.deepEqual(checkCard(gemini, { 'gemini*': 'anthropic' }).errors, ['PAIR REFUSED: same model family reviewing itself (claude -> gemini)']);
});

// A long whitespace run inside a value must not make the key/strip regexes backtrack.
test('contract: a 200 KB whitespace run in a value is checked in linear time, same value as Python', () => {
  const c = fs.readFileSync(path.join(DIR, 'cards', 'clean.md'), 'utf8').replace('repo: example-org/dasks', `repo: a${' '.repeat(200_000)}b  # c`);
  const t0 = Date.now();
  const r = checkCard(c);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.equal(r.fields.repo, `a${' '.repeat(200_000)}b`);
  assert.deepEqual(r.errors, []);
});
