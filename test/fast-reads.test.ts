// Pure helpers behind fast GET /api/tasks reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { task } from './helpers.ts';
import { acceptsGzip, etagMatches, filterTaskList, OPEN_STATUSES, pageTasks, parseTaskQuery, projectTask, SLIM_FIELDS } from '../src/lib/task-reads.ts';

const q = (s: string) => new URLSearchParams(s);
const tasks = [
  task({ id: 'shared.t-zeta', status: 'todo', lane: 'none' }),
  task({ id: 'beta.t-alpha', status: 'doing' }),
  task({ id: 'alpha.t-mid', status: 'review' }),
  task({ id: 'gamma.t-done', status: 'done' }),
  task({ id: 'delta.t-cncl', status: 'cancelled' }),
  task({ id: 'beta.t-wait', status: 'blocked-on-user', owner: 'other-lead' }),
];
const ids = (l: { id: string }[]) => l.map((t) => t.id);

test('status: open and all keywords, mixed with names; plain names filter as before', () => {
  assert.deepEqual([...OPEN_STATUSES].sort(), ['blocked-on-user', 'doing', 'review', 'todo']);
  assert.deepEqual(ids(filterTaskList(tasks, q('status=open'))), ['shared.t-zeta', 'beta.t-alpha', 'alpha.t-mid', 'beta.t-wait']);
  assert.deepEqual(ids(filterTaskList(tasks, q('status=open,done'))), ['shared.t-zeta', 'beta.t-alpha', 'alpha.t-mid', 'gamma.t-done', 'beta.t-wait']);
  assert.deepEqual(ids(filterTaskList(tasks, q('status=all'))), ids(tasks));
  assert.deepEqual(ids(filterTaskList(tasks, q('status=all,done'))), ids(tasks), 'all = no status filter');
  assert.deepEqual(ids(filterTaskList(tasks, q('status= open , ,cancelled'))), ['shared.t-zeta', 'beta.t-alpha', 'alpha.t-mid', 'delta.t-cncl', 'beta.t-wait']);
  assert.deepEqual(ids(filterTaskList(tasks, q('status=done'))), ['gamma.t-done']);
  assert.deepEqual(ids(filterTaskList(tasks, q('status=nope'))), [], 'unknown names match nothing');
  assert.deepEqual(ids(filterTaskList(tasks, q('status='))), ids(tasks), 'empty = no filter');
  assert.deepEqual(ids(filterTaskList(tasks, q('status=, ,'))), [], 'only empty tokens = matches nothing');
  assert.deepEqual(ids(filterTaskList(tasks, q('status=done&status=todo'))), ['gamma.t-done'], 'first value wins');
  assert.deepEqual(ids(filterTaskList(tasks, q('status=open&owner=other-lead'))), ['beta.t-wait'], 'other filters still apply');
  assert.deepEqual(ids(filterTaskList(tasks, q(''))), ids(tasks));
});

test('parseTaskQuery: fields, limit and cursor rules', () => {
  assert.deepEqual(parseTaskQuery(q('')), { fields: null, limit: null, cursor: null });
  const f = (s: string) => { const r = parseTaskQuery(q(s)); assert.ok(!('error' in r), s); return [...(r as any).fields].sort(); };
  assert.deepEqual(f('fields='), ['id']);
  assert.deepEqual(f('fields=id,body'), ['body', 'id']);
  assert.deepEqual(f('fields=title'), ['id', 'title']);
  assert.deepEqual(f('fields=slim'), [...SLIM_FIELDS].sort());
  assert.deepEqual(f('fields=slim, body'), [...SLIM_FIELDS, 'body'].sort());
  assert.deepEqual(f('fields=title&fields=body'), ['id', 'title'], 'first value wins');
  assert.ok(!SLIM_FIELDS.includes('body'));
  for (const k of ['id', 'title', 'title_ko', 'title_en', 'goal', 'milestone', 'status', 'priority', 'owner', 'lane', 'kind', 'claimed_by', 'version', 'updated', 'pr', 'depends_on', 'spec_state'])
    assert.ok(SLIM_FIELDS.includes(k), k);
  assert.equal(SLIM_FIELDS.length, 17);

  assert.deepEqual(parseTaskQuery(q('limit=1')), { fields: null, limit: 1, cursor: null });
  assert.deepEqual(parseTaskQuery(q('limit=1000&cursor=beta.t-a')), { fields: null, limit: 1000, cursor: 'beta.t-a' });
  assert.deepEqual(parseTaskQuery(q('cursor=beta.t-a')), { fields: null, limit: null, cursor: 'beta.t-a' }, 'cursor without limit is checked, then ignored');
  for (const bad of ['limit=0', 'limit=1001', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=', 'limit= 5', 'cursor=../x', 'cursor=', 'limit=5&cursor=../x', 'cursor=BETA'])
    assert.ok('error' in parseTaskQuery(q(bad)), bad);
});

test('projectTask: id always, only named keys, missing keys left out, no fields = full object', () => {
  const o = { id: 'beta.t-a', title: 'A', body: 'b', status: 'todo', version: 2 };
  assert.deepEqual(projectTask(o, null), o);
  assert.deepEqual(projectTask(o, new Set(['id'])), { id: 'beta.t-a' });
  assert.deepEqual(projectTask(o, new Set(['id', 'body', 'nope', 'pr'])), { id: 'beta.t-a', body: 'b' });
  assert.deepEqual(projectTask(o, new Set(SLIM_FIELDS)), { id: 'beta.t-a', title: 'A', status: 'todo', version: 2 });
});

test('pageTasks: sorted by id, ids after the cursor, next = last id when more remain', () => {
  const all = ids(tasks).sort();
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const r: ReturnType<typeof pageTasks> = pageTasks(tasks, 1, cursor);
    seen.push(...ids(r.page));
    if (!r.next) break;
    assert.equal(r.next, r.page.at(-1)!.id);
    cursor = r.next;
  }
  assert.deepEqual(seen, all);
  assert.deepEqual(ids(pageTasks(tasks, 1000, null).page), all);
  assert.equal(pageTasks(tasks, 1000, null).next, null);
  assert.equal(pageTasks(tasks, 6, null).next, null, 'exactly full: no more remain');
  assert.equal(pageTasks(tasks, 5, null).next, all[4]);
  assert.deepEqual(ids(pageTasks(tasks, 2, 'beta.t-b').page), all.filter((x) => x > 'beta.t-b').slice(0, 2), 'cursor need not exist');
  assert.deepEqual(pageTasks(tasks, 3, 'zz.t-z'), { page: [], next: null });
});

test('acceptsGzip: names, q-values, star, explicit gzip;q=0 wins', () => {
  const yes = ['gzip', 'GZIP', 'gzip, deflate, br', 'br;q=1, gzip;q=0.5', 'gzip;q=abc', 'gzip; q=1.0', '*', '*;q=0.1', 'deflate, *', 'x-gzip, gzip'];
  const no = [undefined, '', 'deflate', 'br', 'identity', 'gzip;q=0', 'gzip;q=0.0', '*;q=0', '*, gzip;q=0', 'gzip, gzip;q=0', 'gzip;q=0, *', 'x-gzip', 'gzipx'];
  for (const h of yes) assert.equal(acceptsGzip(h), true, String(h));
  for (const h of no) assert.equal(acceptsGzip(h), false, String(h));
});

test('etagMatches: list, star, weak comparison', () => {
  const e = 'W/"ab12cd34-7"';
  assert.equal(etagMatches(undefined, e), false);
  assert.equal(etagMatches('', e), false);
  assert.equal(etagMatches(e, e), true);
  assert.equal(etagMatches('"ab12cd34-7"', e), true);
  assert.equal(etagMatches('*', e), true);
  assert.equal(etagMatches('W/"x-1", W/"ab12cd34-7"', e), true);
  assert.equal(etagMatches('W/"ab12cd34-8"', e), false);
  assert.equal(etagMatches('ab12cd34-7', e), false, 'an unquoted tag is not the same tag');
});
