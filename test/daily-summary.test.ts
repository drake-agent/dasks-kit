// Daily summary (src/lib/summary.ts): once a day at summary.at the board writes what finished since the last summary,
// what waits on the human, what is stuck and what failed. Read with GET /api/summary, MCP get_summary, `dasks summary`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSummary, summaryDue, type SummaryInput } from '../src/lib/summary.ts';
import { task, tempRepo } from './helpers.ts';
import { serve, until } from './state-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('schedule: once per local day, at or after summary.at; a board that was off at that time writes it when it starts', () => {
  const at = (h: number, m: number, d = 3) => new Date(2026, 10, d, h, m);
  assert.equal(summaryDue(at(8, 29), '08:30', null), false, 'before the time');
  assert.equal(summaryDue(at(8, 30), '08:30', null), true);
  assert.equal(summaryDue(at(8, 30), '08:30', '2026-11-03'), false, 'already written today');
  assert.equal(summaryDue(at(14, 0), '08:30', '2026-11-02'), true, 'late start: written then');
  assert.equal(summaryDue(at(0, 5, 4), '08:30', '2026-11-03'), false, 'a new day, but not yet the time');
  assert.equal(summaryDue(at(0, 0, 4), '00:00', '2026-11-03'), true);
});

test('content: finished in the window, what waits on the human, stuck machines and cards, failures', () => {
  const now = new Date('2026-11-03T08:30:00Z'), since = new Date('2026-11-02T08:30:00Z');
  const x: SummaryInput = {
    now, since,
    tasks: [
      { id: 'web.t-done', title: 'Done in window', goal: 'web', status: 'done', pr: 'https://github.com/o/r/pull/1', done_at: '2026-11-02T20:00:00Z' },
      { id: 'web.t-old', title: 'Done before', goal: 'web', status: 'done', done_at: '2026-11-01T20:00:00Z' },
      { id: 'web.t-ask', title: 'Ask', goal: 'web', status: 'blocked-on-user', live_ask: true },
      { id: 'web.t-ok', title: 'Merge OK', goal: 'web', status: 'review', needs_user: 'OK to merge at abc' },
      { id: 'web.t-agent', title: 'Agent review', goal: 'web', status: 'review', needs_user: '' },
      { id: 'web.t-block', title: 'Blocked', goal: 'web', status: 'blocked-on-user', needs_user: 'run this' },
    ],
    machines: [{ machine: 'mini', state: 'quiet', last_seen: '2026-11-03T01:00:00Z' }, { machine: 'big', state: 'busy', last_seen: '2026-11-03T08:29:00Z' }],
    stale: [{ id: 'web.t-slow', title: 'Slow', goal: 'web', age_hours: 30.4 }],
    outcomes: [{ id: 'web.t-x', state: 'failed', at: '2026-11-03T01:00:00Z', note: 'tests failed\nmore', cause: 'infra' }, { id: 'web.t-y', state: 'failed', at: '2026-11-01T01:00:00Z', note: 'old' }, { id: 'web.t-z', state: 'done', at: '2026-11-03T01:00:00Z', note: 'fine' }],
    warnings: ['board backup: 3 pushes in a row failed'],
  };
  const s = buildSummary(x);
  assert.deepEqual(s.finished.map((c) => c.id), ['web.t-done']);
  assert.equal(s.finished[0].pr, 'https://github.com/o/r/pull/1');
  assert.deepEqual(s.waiting.asks.map((c) => c.id), ['web.t-ask']);
  assert.deepEqual(s.waiting.approve.map((c) => c.id), ['web.t-ok'], 'review without a question for the human is not waiting on them');
  assert.deepEqual(s.waiting.blocked.map((c) => c.id), ['web.t-block'], 'an asked card is listed once, as a decision');
  assert.deepEqual(s.stuck.machines, [{ machine: 'mini', last_seen: '2026-11-03T01:00:00Z' }]);
  assert.deepEqual(s.stuck.cards.map((c) => [c.id, c.hours]), [['web.t-slow', 30]]);
  assert.deepEqual(s.failures, [{ id: 'web.t-x', at: '2026-11-03T01:00:00Z', note: 'tests failed', cause: 'infra' }]);
  assert.deepEqual([s.day, s.since, s.until], [s.day, since.toISOString(), now.toISOString()]);
  assert.match(s.text, /Finished: 1\n {2}web\.t-done {2}Done in window/);
  assert.match(s.text, /Failures: 2\n.*\[infra\] tests failed\n {2}board backup/);
});

test('server: a due summary is written on its own and read by the API and the CLI', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-wait', status: 'blocked-on-user', needs_user: 'Pick a name', body: '\n## Context\nx\n' })]);
  const srv = await serve(root, { DASKS_SUMMARY_TICK_MS: '300' }, undefined, { summary: { at: '00:00' } });
  try {
    let r: any;
    await until(async () => { r = await (await fetch(srv.url + '/api/summary')).json(); return !!r.summary; }, 10000);
    assert.equal(r.at, '00:00');
    assert.deepEqual(r.summary.waiting.blocked.map((c: any) => c.id), ['beta.t-wait']);
    assert.ok(fs.existsSync(path.join(root, 'run/summary.json')), 'kept in run/: never committed');
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'mcp/board-cli.mjs'), 'summary'], { encoding: 'utf8', env: { ...process.env, DASKS_URL: srv.url, DASKS_TOKEN: '' } });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Waiting on you: blocked: 1\n {2}beta\.t-wait/);
  } finally { await srv.stop(); cleanup(); }
});
