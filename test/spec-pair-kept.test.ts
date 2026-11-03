// A stored spec whose impl / review pair no rule names can still be edited and auto-ok'd; changing the pair is judged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTask, HttpError } from '../src/lib/write.ts';
import { specPaths, writeSpec } from '../src/lib/specs.ts';
import { setAutoOk } from '../public/user-ask.js';
import { tempRepo } from './helpers.ts';

const card = (pair: string, bg = 'Background text.') => 'id: shared.t-x\ngoal: shared\nrole: builder\ntier: 1\nrepo: example-org/dasks\n'
  + `branch: human/shared.t-x\nlane: none\ndeadline: 2026-11-01\nsize: small\ndepends_on: none\n${pair}`
  + 'done_when: the board shows the spec\ndone_at: pr\n' + 'pass_checks:\n  - npm test is green\n  - GET returns the text\n  - over the cap is 413\n'
  + `\n## Background\n${bg}\n\n## Why\nBecause.\n\n## Context pack\n- docs/x.md\n\n## Tests\n- test/x.test.ts\n`;
const OLD = 'impl: old-model\nreview: other-old-model\n';

const status = (fn: () => unknown) => { try { fn(); return 200; } catch (e) { return e instanceof HttpError ? e.status : 500; } };

test('spec pair: an unchanged unknown pair is a warning; a new or changed pair is judged', () => {
  const { root, cleanup } = tempRepo();
  try {
    const t = createTask(root, { goal: 'shared', title: 'Old pair' }, 'helper');
    assert.equal(status(() => writeSpec(root, t.id, { text: card(OLD), expected: 0, note: "" }, 'helper')), 422, 'a new spec with an unknown pair is refused');
    writeSpec(root, t.id, { text: card('impl: claude\nreview: codex\n'), expected: 0, note: "" }, 'helper');
    // A spec stored before the current names (written by an older kit): put its text in place as committed.
    const p = specPaths(t.id);
    for (const rel of [p.current, p.text(1)]) fs.writeFileSync(path.join(root, rel), card(OLD));
    execFileSync('git', ['-C', root, 'commit', '-qam', 'older spec']);

    const edit = writeSpec(root, t.id, { text: card(OLD, 'Edited background.'), expected: 1, note: "" }, 'helper');
    assert.equal(edit.metadata.version, 2, 'a body edit that keeps the pair goes through');
    assert.ok(edit.warnings?.some((w: string) => w.startsWith("PAIR REFUSED: unknown implementer model 'old-model'")), JSON.stringify(edit.warnings));

    const ok = writeSpec(root, t.id, { text: setAutoOk(card(OLD, 'Edited background.'), 'the user chose A'), expected: 2, note: "" }, 'user');
    assert.equal(ok.metadata.version, 3, "the user's auto-ok answer goes through");

    assert.equal(status(() => writeSpec(root, t.id, { text: card('impl: claude\nreview: claude-example\n'), expected: 3, note: "" }, 'helper')), 422,
      'changing the pair to one family is refused');
    assert.equal(status(() => writeSpec(root, t.id, { text: card('impl: old-model\nreview: codex\n'), expected: 3, note: "" }, 'helper')), 422,
      'changing one line still needs a known pair');
    assert.equal(writeSpec(root, t.id, { text: card('impl: claude\nreview: codex\n'), expected: 3, note: "" }, 'helper').metadata.version, 4);
  } finally { cleanup(); }
});
