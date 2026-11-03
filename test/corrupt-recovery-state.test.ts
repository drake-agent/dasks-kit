// Unreadable recovery state is moved aside, never deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { task, tempRepo } from './helpers.ts';
import { corruptJournals, journalPath, recoverRepo, updateTask } from '../src/lib/write.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('journal: an unreadable journal is kept aside byte for byte, writes answer 503 until it is removed, dasks check says how', () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' })]);
  try {
    const garbage = '{"pid": 1, "rels": ["data/tasks/beta/t-one.md"], "before": {"data/tasks/be'; // cut off mid-write
    fs.writeFileSync(journalPath(root), garbage);
    const log = recoverRepo(root);
    assert.ok(log.some((l) => /unreadable.*kept as .*dasks-txn\.json\.corrupt-/.test(l)), log.join('\n'));
    const kept = corruptJournals(root);
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(kept[0], 'utf8'), garbage, 'the bytes are kept as found');
    assert.equal(fs.existsSync(journalPath(root)), false);

    for (let i = 0; i < 2; i++) {
      assert.throws(() => updateTask(root, 'beta.t-one', { title: 'New' }, 'claude-code@test'),
        (e: any) => e.status === 503 && /kept at .*corrupt-.*writes are stopped/.test(e.message));
    }
    const chk = spawnSync(path.join(ROOT, 'bin/dasks-check'), ['check'], { env: { ...process.env, DASKS_ROOT: root }, encoding: 'utf8' });
    assert.equal(chk.status, 1, chk.stdout + chk.stderr);
    assert.match(chk.stdout, /ERROR .*corrupt-.*git -C .* status -- data.*delete the kept journal/);

    fs.rmSync(kept[0]);
    assert.equal(updateTask(root, 'beta.t-one', { title: 'New' }, 'claude-code@test').title, 'New');
  } finally { cleanup(); }
});
