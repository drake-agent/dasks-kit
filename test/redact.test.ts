// Secret masking (shared vectors in contract/secret-redaction/vectors.json; fake values are joined at run time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

interface Vector { id: string; template: string; secret_parts: string[] | null; keep: string[] }
const VECTORS: Vector[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'contract/secret-redaction/vectors.json'), 'utf8')).cases;

const tsRedact = async (): Promise<(t: string, mark?: string) => string> => (await import('../src/lib/redact.ts')).redact;

function checkVector(c: Vector, out: string, who: string) {
  if (c.secret_parts === null) { assert.equal(out, c.template, `${who} ${c.id}: a negative case comes out unchanged`); return; }
  assert.ok(!out.includes(c.secret_parts.join('')), `${who} ${c.id}: value survived`);
  for (const k of c.keep) assert.ok(out.includes(k), `${who} ${c.id}: lost ${JSON.stringify(k)} in ${JSON.stringify(out)}`);
}
// {AT} in a template stands for @, so the file never holds a whole credential URL.
const vectorInput = (c: Vector) => (c.secret_parts === null ? c.template : c.template.replace('{S}', () => c.secret_parts!.join('')).replaceAll('{AT}', '@'));

const PW = 'fk' + 'zq' + 'pw1';
const AGENT = 'dsk_' + '0123abcd' + '_' + 'abcdefghij' + 'klmnopqrst';

test('vectors: the file holds the required cases', () => {
  const ids = VECTORS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['json-password', 'authorization-bearer', 'basic-scheme', 'url-credential-percent-encoded', 'pem-unterminated', 'xai-key', 'stripe-key', 'gitlab-token', 'npm-token', 'huggingface-token', 'groq-key', 'prose-basic-flow', 'prose-pass-1-clean']) assert.ok(ids.includes(id), id);
});

for (const c of VECTORS) test(`vectors: ${c.id}, src/lib/redact.ts`, async () => checkVector(c, (await tsRedact())(vectorInput(c)), 'ts'));

test('redact: the dsk_ agent token, the mark, empty input', async () => {
  const redact = await tsRedact();
  assert.equal(redact(`token was ${AGENT}.`, '[x]'), 'token was [x].');
  assert.equal(redact(`glued${AGENT}`, '[x]'), 'glued[x]');
  assert.equal(redact(''), '');
  assert.equal(redact(`password: ${PW}`), 'password: <redacted>');
  assert.equal(redact(`password: ${PW}`, '$&'), 'password: $&', 'a mark is plain text, never a replacement pattern');
});

test('redact: Basic needs a credential look or base64 of user:password', async () => {
  const redact = await tsRedact();
  const b64 = (s: string) => Buffer.from(s).toString('base64').replace(/=+$/, '');
  assert.equal(redact('Basic YWJjOmRlZmdo', 'M'), 'Basic M');                 // abc:defgh
  assert.equal(redact('Basic abcdefgh', 'M'), 'Basic abcdefgh');              // decodes, no colon
  assert.equal(redact('Basic hello!', 'M'), 'Basic hello!', 'Buffer.from would accept this, the alphabet check does not');
  assert.equal(redact(`Basic ${b64('a:\x01bc')}`, 'M'), `Basic ${b64('a:\x01bc')}`, 'a control character in the decoded text');
  assert.equal(redact('Basic YWJjOmRlZmdo|PASS', 'M'), 'Basic M');
  assert.equal(redact('This is the basic flow of the app', 'M'), 'This is the basic flow of the app');
});
