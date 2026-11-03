import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { task, tempRepo } from './helpers.ts';
import { committedSpecIndex } from '../src/lib/spec-state.ts';

const ID = 'shared.t-stc';
const TEXT = 'id: x\n\n## Background\nb\n\n## Acceptance tests\n1. GET returns the text.\n';

test('a committed edit to version 1 text that drops Acceptance tests is no longer ready', (t) => {
  const review = { spec_version: 1, by: 'codex@desktop', family: 'openai', verdict: 'pass', at: '2026-11-01T10:00:00+09:00' };
  const { root, cleanup } = tempRepo([task({ id: ID, goal: 'shared', spec_review: review } as any)]);
  t.after(cleanup);
  const dir = path.join(root, 'data/specs/shared/t-stc/versions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ version: 1, by: 'spec', sha256: 'fixed' }) + '\n');
  fs.writeFileSync(path.join(dir, '1.md'), TEXT);
  const g = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  g('add', '-A'); g('commit', '-qm', 'spec v1');
  assert.equal(committedSpecIndex(root).facts.get(ID)!.spec_state, 'ready');
  fs.writeFileSync(path.join(dir, '1.md'), 'id: x\n\n## Background\nb\n');
  g('add', '-A'); g('commit', '-qm', 'edit v1 text');
  assert.notEqual(committedSpecIndex(root).facts.get(ID)!.spec_state, 'ready');
});
