// Agent start text: output budget, the review group's model families and the merge rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startText, budgetProblems, BOARD_RULES, START_BUDGET } from '../src/lib/start.ts';
import { task } from './helpers.ts';

const ME = 'claude-code@laptop';
const GOALS = [{ id: 'shared', title: 'shared', milestones: [] }] as any[];
const base = (tasks: any[], over: Record<string, unknown> = {}) => ({ board: { tasks, goals: GOALS }, actor: ME, version: 1, now: new Date('2026-10-25T01:30:00Z'), messages: new Map(), ...over }) as any;

test('the whole text stays inside the budget at ready=20 with long titles and many messages; a cut message stays unread', () => {
  const tasks: any[] = [];
  for (let i = 0; i < 20; i++) tasks.push(task({ id: `shared.t-r${i}`, status: 'todo', title: 'R'.repeat(200) }));
  for (let i = 0; i < 10; i++) tasks.push(task({ id: `shared.t-m${i}`, status: 'doing', claimed_by: ME, title: 'M'.repeat(200) } as any));
  for (let i = 0; i < 8; i++) tasks.push(task({ id: `shared.t-v${i}`, status: 'review', claimed_by: 'codex@desktop', title: 'V'.repeat(200) } as any));
  const msgs = new Map([['shared.t-m0', Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, card: 'shared.t-m0', from: 'codex@desktop', to: ME, kind: 'fyi', text: 'x'.repeat(300), ts: `2026-10-25T01:${String(i).padStart(2, '0')}:00Z` }))]]);
  const { text, read } = startText(base(tasks, { ready: 20, messages: msgs }));
  assert.deepEqual(budgetProblems(text), [], `${text.length} chars`);
  const shown = text.split('\n').filter((l) => /^  shared\.t-m0 #\d+/.test(l)).map((l) => Number(/#(\d+)/.exec(l)![1]));
  assert.ok(shown.length >= 1, 'some messages still shown');
  assert.equal(read['shared.t-m0'], Math.max(...shown), 'the cursor moves only over the messages printed');
  assert.match(text, /^ready: 20, showing \d+$/m, 'the header keeps the full count');
  assert.ok(text.length <= START_BUDGET.chars);
});

test('review: same family by the board rules (default prefixes, config families) is left out', () => {
  const tasks = [
    task({ id: 'shared.t-vlpm', status: 'review', claimed_by: 'ops-lead@desktop' } as any),
    task({ id: 'shared.t-v-lead', status: 'review', claimed_by: 'shared-lead' } as any),
    task({ id: 'shared.t-vgam', status: 'review', claimed_by: 'gamma' } as any),
    task({ id: 'shared.t-vcdx', status: 'review', claimed_by: 'codex@desktop' } as any),
  ];
  const ids = (actor: string, families?: Record<string, string>) => startText(base(tasks, { actor, families })).text.split('\n').filter((l) => /^  shared\.t-v/.test(l)).map((l) => l.trim().split(' ')[0]).sort();
  assert.deepEqual(ids('gemini@laptop', { 'gemini*': 'google', 'ops-lead*': 'google', 'shared-lead': 'google' }), ['shared.t-vcdx', 'shared.t-vgam'], 'config maps the ops and shared leads to the reviewer\'s family');
  assert.deepEqual(ids('bot@laptop'), ['shared.t-v-lead', 'shared.t-vcdx', 'shared.t-vgam', 'shared.t-vlpm'], 'bot and the leads have no default family');
  assert.deepEqual(ids(ME, { gamma: 'anthropic' }), ['shared.t-v-lead', 'shared.t-vcdx', 'shared.t-vlpm'], 'config families map gamma to anthropic');
});

test('rules: agents never merge; the user or the captain does', () => {
  const merge = BOARD_RULES.find((r) => /never merge yourself/i.test(r))!;
  assert.ok(merge, BOARD_RULES.join('\n'));
  assert.match(merge, /captain-merge/);
  assert.doesNotMatch(BOARD_RULES.join('\n'), /tier 1|self-merge/i);
});

test('client: an explicitly empty DASKS_ROLES is sent as roles= (no roles), an unset one as the default list', async () => {
  const { client } = await import('../mcp/board-client.mjs');
  const seen: string[] = [];
  const real = globalThis.fetch; const env = process.env.DASKS_ROLES;
  globalThis.fetch = (async (u: string) => { seen.push(String(u)); return new Response('ok', { headers: { 'content-type': 'text/plain' } }); }) as any;
  try {
    process.env.DASKS_ROLES = '';
    await client({ url: 'http://board.invalid', actor: ME }).start({ repo: 'example-org/dasks' });
    delete process.env.DASKS_ROLES;
    await client({ url: 'http://board.invalid', actor: ME }).start({});
  } finally { globalThis.fetch = real; if (env === undefined) delete process.env.DASKS_ROLES; else process.env.DASKS_ROLES = env; }
  assert.equal(seen[0], 'http://board.invalid/api/start?repo=example-org%2Fdasks&roles=');
  assert.equal(seen[1], 'http://board.invalid/api/start?roles=human');
});
