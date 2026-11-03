// One-call agent start (GET /api/start and MCP dask_start).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { startText, budgetProblems, START_BUDGET } from '../src/lib/start.ts';
import { postMessage } from '../src/lib/messages.ts';
import { task, tempRepo } from './helpers.ts';
import { stopServer } from './spec-support.ts';
import type { Message } from '../src/lib/start.ts';

const ME = 'claude-code@laptop';
const DASKS = 'repo: example-org/dasks · size: small';
const DELTA = 'repo: example-org/delta';
const body = (...lines: string[]) => `\n## Context\n${lines.join('\n')}\nx\n\n## Notes\n`;

const TASKS = [
  task({ id: 'shared.t-mndo', status: 'doing', claimed_by: 'human-claude@laptop', body: body(DASKS), summary: 'tests committed\nroute left' } as any),
  task({ id: 'beta.t-mnrv', status: 'review', claimed_by: ME, pr: 'https://github.com/example-org/beta/pull/9' } as any),
  task({ id: 'shared.t-mndn', status: 'done', claimed_by: ME } as any),
  task({ id: 'shared.t-rdyd', status: 'todo', body: body(DASKS) }),
  task({ id: 'shared.t-rdynr', status: 'todo' }),
  task({ id: 'delta.t-rdyo', status: 'todo', body: body(DELTA) }),
  task({ id: 'shared.t-rdydp', status: 'todo', depends_on: 'shared.t-rdyd', body: body(DASKS) } as any),
  task({ id: 'shared.t-cltdo', status: 'todo', claimed_by: 'codex@desktop', body: body(DASKS) } as any),
  task({ id: 'shared.t-revcx', status: 'review', claimed_by: 'codex@desktop', body: body(DASKS), pr: 'https://github.com/example-org/dasks/pull/60' } as any),
  task({ id: 'shared.t-rvcl', status: 'review', claimed_by: 'claude-code@desktop', body: body(DASKS) } as any),
  task({ id: 'delta.t-rvoth', status: 'review', claimed_by: 'codex@desktop', body: body(DELTA) } as any),
];
const GOALS = ['shared', 'beta', 'delta'].map((id) => ({ id, title: id, milestones: [] })) as any[];

let seqs: Record<string, number> = {};
const msg = (card: string, from: string, to: string, text: string, kind = 'fyi'): Message => {
  const seq = (seqs[card] = (seqs[card] ?? 0) + 1);
  return { seq, card, from, to, kind, text, ts: `2026-10-25T01:0${seq}:00Z` };
};
function messages(): Map<string, Message[]> {
  seqs = {};
  const all = [
    msg('shared.t-mndo', 'codex@desktop', '*', 'read before my reply'),
    msg('shared.t-mndo', 'human-claude@laptop', '*', 'my reply marks the ones before it read'),
    msg('shared.t-mndo', 'codex@desktop', 'human', 'is the route shape fixed?', 'question'),
    msg('shared.t-revcx', 'codex@desktop', ME, 'please review the PR', 'question'),
    msg('shared.t-revcx', 'codex@desktop', '*', 'a broadcast on a card I do not hold'),
    msg('delta.t-rdyo', 'delta-lead', 'spec', 'not for me'),
  ];
  const m = new Map<string, Message[]>();
  for (const x of all) m.set(x.card, [...(m.get(x.card) ?? []), x]);
  return m;
}
const LESSONS = [{ app: 'shared', proposed: 4, confirmed: 2 }, { app: 'beta', proposed: 1, confirmed: 0 }];

const input = (over: Record<string, unknown> = {}) => ({
  board: { tasks: TASKS, goals: GOALS }, actor: ME, version: 7, now: new Date('2026-10-25T01:30:00Z'),
  messages: messages(), cursor: {}, lessons: LESSONS, ...over,
}) as any;

/** The ids under each group header (messages lines carry `<card> #<seq>`). */
function groups(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur = '';
  for (const line of text.split('\n')) {
    const h = /^(messages|mine|ready|review)\b/.exec(line);
    if (h) { cur = h[1]; out[cur] = []; continue; }
    if (!/^\s/.test(line)) { cur = ''; continue; }
    const item = /^\s+(\S+)(?: (#\d+))?/.exec(line);
    if (cur && item) out[cur].push(item[2] ? `${item[1]} ${item[2]}` : item[1]);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

test('the fixture board lists exactly the expected cards in each group', () => {
  const { text } = startText(input());
  assert.deepEqual(groups(text), {
    messages: ['shared.t-mndo #3', 'shared.t-revcx #1'],
    mine: ['beta.t-mnrv', 'shared.t-mndo'],
    ready: ['delta.t-rdyo', 'shared.t-rdyd', 'shared.t-rdynr'],
    review: ['delta.t-rvoth', 'shared.t-revcx'],
  }, text);
  // line 1 names the caller and the board version; lessons are pointed at (counts), never printed
  assert.match(text.split('\n')[0], /^claude-code@laptop · dasks v7 /);
  assert.match(text, /^lessons: .*shared 6 \(2 confirmed\)/m);
  assert.doesNotMatch(text, /^\s+.*lesson text/m);
  // a cursor at seq 3 marks that message read
  assert.deepEqual(groups(startText(input({ cursor: { 'shared.t-mndo': 3 } })).text).messages, ['shared.t-revcx #1']);
});

test('the repo filter drops cards of other repos (cards naming no repo stay)', () => {
  const { text } = startText(input({ repo: 'example-org/dasks' }));
  const g = groups(text);
  assert.deepEqual(g.ready, ['shared.t-rdyd', 'shared.t-rdynr'], text);
  assert.deepEqual(g.review, ['shared.t-revcx'], text);
  assert.deepEqual(g.mine, ['beta.t-mnrv', 'shared.t-mndo'], 'my own cards are listed whatever their repo');
  assert.match(text, /^ready: .* · 1 in other repos$/m);
  // a GitHub URL or a .git suffix names the same repo
  assert.deepEqual(groups(startText(input({ repo: 'https://github.com/example-org/dasks.git' })).text).ready, g.ready);
});

test('rules:false is shorter by the rules block only', () => {
  const full = startText(input()).text.split('\n');
  const lean = startText(input({ rules: false })).text.split('\n');
  const start = full.findIndex((l) => /^rules\b/.test(l));
  assert.ok(start > 0, 'the full output has a rules block');
  let end = start + 1;
  while (end < full.length && /^- /.test(full[end])) end++;
  assert.ok(end - start - 1 >= 3 && end - start - 1 <= 10, `rules block is ${end - start - 1} lines (≤ ~10)`);
  assert.deepEqual(lean, [...full.slice(0, start), ...full.slice(end)]);
});

test('the fixture output stays under the budget; growing a line past it fails', () => {
  const { text } = startText(input());
  assert.deepEqual(budgetProblems(text), []);
  assert.ok(text.length <= START_BUDGET.chars);
  const lines = text.split('\n');
  const grown = lines.map((l, i) => (i === 2 ? l + 'x'.repeat(START_BUDGET.line) : l)).join('\n');
  assert.ok(budgetProblems(grown).some((p) => /line 3/.test(p)), budgetProblems(grown).join('; '));
  const fat = text + ('\n' + 'y'.repeat(START_BUDGET.line - 1)).repeat(Math.ceil(START_BUDGET.chars / START_BUDGET.line) + 1);
  assert.ok(budgetProblems(fat).some((p) => /chars/.test(p)), budgetProblems(fat).join('; '));
  // a huge title or message is cut to the line budget, never passed through
  const huge = startText(input({ board: { tasks: [...TASKS, task({ id: 'shared.t-huge', status: 'todo', title: 'T'.repeat(500) })], goals: GOALS } })).text;
  assert.deepEqual(budgetProblems(huge), []);
});

// ---------- the same over HTTP and MCP ----------
async function startServer(root: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [path.resolve(import.meta.dirname, '../src/server.ts')], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, proc }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
}
function mcpCall(url: string, actor: string, name: string, args: any): Promise<{ err: boolean; text: string }> {
  const proc = spawn(process.execPath, [path.resolve(import.meta.dirname, '../mcp/dasks-mcp.mjs')], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve) => {
    let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += d; const i = buf.indexOf('\n'); if (i < 0) return;
      const r = JSON.parse(buf.slice(0, i)).result; proc.kill();
      resolve({ err: !!r.isError, text: r.content[0].text });
    });
    proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

test('http + mcp: /api/start needs the actor, moves the read cursor unless peek, and dask_start returns the text', async () => {
  const { root, cleanup } = tempRepo(TASKS);
  let srv: { url: string; proc: ChildProcess } | undefined;
  try {
    postMessage(root, 'shared.t-revcx', { text: 'please review the PR', to: ME, kind: 'question' }, 'codex@desktop');
    srv = await startServer(root);
    const get = (q: string, actor = ME) => fetch(`${srv!.url}/api/start${q}`, { headers: actor ? { 'X-Dasks-Actor': actor } : {} });
    assert.equal((await get('', '')).status, 400);
    assert.equal((await get('?ready=abc')).status, 400);
    const peek = await get('?peek=1&repo=example-org/dasks');
    assert.equal(peek.status, 200);
    assert.match(peek.headers.get('content-type') ?? '', /^text\/plain/);
    const t1 = await peek.text();
    assert.deepEqual(groups(t1).messages, ['shared.t-revcx #1'], t1);
    assert.deepEqual(groups(t1).ready, ['shared.t-rdyd', 'shared.t-rdynr']);
    assert.deepEqual(budgetProblems(t1), []);
    // peek left the message unread; a normal call shows it and marks it read for the next call (either of my names)
    assert.deepEqual(groups(await (await get('')).text()).messages, ['shared.t-revcx #1']);
    assert.deepEqual(groups(await (await get('', 'human-claude@laptop')).text()).messages, []);
    const lean = await (await get('?rules=0')).text();
    assert.doesNotMatch(lean, /^rules\b/m);
    const viaMcp = await mcpCall(srv.url, ME, 'dask_start', { repo: 'example-org/dasks', rules: false, peek: true });
    assert.equal(viaMcp.err, false, viaMcp.text);
    assert.match(viaMcp.text, /^claude-code@laptop · dasks v\d+ /);
    assert.deepEqual(groups(viaMcp.text).review, ['shared.t-revcx']);
  } finally { if (srv) await stopServer(srv.proc); cleanup(); } // wait for the exit before removing the folder
});
