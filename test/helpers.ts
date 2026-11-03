import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { serializeTask } from '../src/lib/write.ts';
import { type Task } from '../src/lib/schema.ts';
import { schemaContent, SCHEMA_REL, SCHEMA_VERSION } from '../src/lib/migrate.ts';

// The suite tests the gates as they will be enforced; servers spawned by tests inherit this. test/gates-warn.test.ts covers warn.
process.env.DASKS_GATES ??= 'enforce';
// Board features are tested without agent tokens; the auth tests set their own mode.
process.env.DASKS_AUTH_MODE ??= 'off';

export function task(over: Partial<Task> = {}): Task {
  const id = over.id ?? 'beta.t-smpl';
  const goal = over.goal ?? id.split('.')[0];
  const t: any = {
    id, title: 'Sample', goal, milestone: `${goal}.m1`, owner: 'beta-lead', lane: 'none', kind: 'impl', status: 'todo',
    priority: 'p2', pr: '', pr_summary: '', result: '', needs_user: '', approvals: 'none',
    created: '2026-10-10T10:00:00+09:00', updated: '2026-10-10T10:00:00+09:00', started_by: 'bot',
    body: '\n## Context\nx\n', file: `data/tasks/${goal}/${id.slice(goal.length + 1)}.md`, bytes: 100, ...over,
  };
  return t as Task;
}

/** Create a throwaway git repo with a minimal valid board. Caller must call cleanup(). */
export function tempRepo(tasks: Task[] = []): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-test-'));
  const w = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
  w('data/northstar.yaml', YAML.stringify({ id: 'north', title: 'North Star', why: 'w', horizon: 'h' }));
  for (const g of ['alpha', 'beta', 'gamma', 'delta', 'shared']) {
    w(`data/goals/${g}.yaml`, YAML.stringify({ id: g, parent: 'north', title: g, why: '', owner: `${g}-lead`,
      milestones: [{ id: `${g}.m1`, title: 'M1', done_criteria: ['a'], due: '', status: 'active' }, { id: `${g}.m2`, title: 'M2', done_criteria: [], due: '2020-01-01', status: 'planned' }] }));
  }
  w('data/links.yaml', YAML.stringify([{ from: 'beta.m1', to: 'alpha.m1', type: 'feeds', note: 'n' }]));
  w(SCHEMA_REL, schemaContent(SCHEMA_VERSION)); // a current board: a server start migrates nothing
  for (const t of tasks) w(t.file, serializeTask(t));
  const g = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'test'); g('config', 'user.email', 'test@example.invalid');
  g('add', '-A'); g('commit', '-qm', 'init');
  // A server killed a moment ago may still be writing into .git, so removal retries.
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** Status moves the server committed for a card (activity rows with a `to`, a create included): one per transition. */
export function statusMoves(root: string, id: string): number {
  const [goal, name] = id.split('.');
  try { return fs.readFileSync(path.join(root, 'data/activity', goal, `${name}.jsonl`), 'utf8').split('\n').filter((l) => l.trim() && 'to' in JSON.parse(l)).length; } catch { return 0; }
}

/** A board config that selects the root-owned token store, for the token tests that check its path rules. */
export const SYSTEM_CFG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-syscfg-')), 'config.json');
fs.writeFileSync(SYSTEM_CFG, JSON.stringify({ auth: { store: 'system' } }));
