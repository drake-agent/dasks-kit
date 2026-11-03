// Fast GET /api/tasks reads on a real server (raw node:http; golden in test/fixtures/fast-reads/SOURCE).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawn, type ChildProcess } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { FAST_READS_TASKS } from './fixtures/fast-reads/tasks.ts';

const GOLDEN = fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/fast-reads/tasks.golden.json'));
const GOLDEN_LIST: any[] = JSON.parse(GOLDEN.toString('utf8'));

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

interface Raw { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
let S: { url: string; proc: ChildProcess; cleanup: () => void };
function raw(p: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<Raw> {
  return new Promise((ok, no) => {
    const r = http.request(S.url + p, { method, headers }, (res) => {
      const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(c) }));
    });
    r.on('error', no); r.end(body);
  });
}
const json = (r: Raw) => JSON.parse((r.headers['content-encoding'] === 'gzip' ? gunzipSync(r.body) : r.body).toString('utf8'));
const ids = (l: { id: string }[]) => l.map((t) => t.id);

before(async () => { const { root, cleanup } = tempRepo(FAST_READS_TASKS); const s = await startServer(root); S = { ...s, cleanup }; });
after(() => { S.proc.kill(); S.cleanup(); });

test('no-query GET /api/tasks: byte-identical to the golden without Accept-Encoding; the status/owner/goal filters too', async () => {
  assert.ok(GOLDEN.length >= 1024, 'the golden is over the gzip line');
  const r = await raw('/api/tasks');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], undefined);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers.vary, 'Accept-Encoding');
  assert.ok(r.body.equals(GOLDEN), 'no-query reply = golden bytes');
  for (const [qs, keep] of [['status=todo', (t: any) => t.status === 'todo'], ['status=done,cancelled', (t: any) => ['done', 'cancelled'].includes(t.status)], ['owner=shared-lead', (t: any) => t.owner === 'shared-lead'], ['goal=beta&status=doing', (t: any) => t.goal === 'beta' && t.status === 'doing']] as const) {
    const f = await raw(`/api/tasks?${qs}`);
    assert.equal(f.body.toString('utf8'), JSON.stringify(GOLDEN_LIST.filter(keep)), qs);
  }
});

test('gzip: a large JSON reply is gzipped for clients that ask, and gunzips to the golden bytes', async () => {
  const r = await raw('/api/tasks', { 'Accept-Encoding': 'gzip' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'gzip', 'the gzip flag must be honoured');
  assert.equal(r.headers.vary, 'Accept-Encoding');
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.ok(r.body.length < GOLDEN.length);
  assert.ok(gunzipSync(r.body).equals(GOLDEN));
  for (const ae of ['gzip, deflate, br', '*', 'GZip;q=0.5']) assert.equal((await raw('/api/tasks', { 'Accept-Encoding': ae })).headers['content-encoding'], 'gzip', ae);
  for (const ae of ['gzip;q=0', '*, gzip;q=0', 'deflate', 'identity']) {
    const n = await raw('/api/tasks', { 'Accept-Encoding': ae });
    assert.equal(n.headers['content-encoding'], undefined, ae);
    assert.ok(n.body.equals(GOLDEN), ae);
  }
  const h = await raw('/api/tasks', { 'Accept-Encoding': 'gzip' }, 'HEAD');
  assert.equal(h.status, 200);
  assert.equal(h.body.length, 0);
});

test('gzip: a small JSON reply is never gzipped but carries Vary; text/plain is untouched', async () => {
  const plain = await raw('/api/health');
  const asked = await raw('/api/health', { 'Accept-Encoding': 'gzip' });
  assert.ok(plain.body.length < 1024);
  for (const r of [plain, asked]) {
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.headers.vary, 'Accept-Encoding');
  }
  assert.ok(plain.body.equals(asked.body));
  const txt = await raw('/api/digest', { 'Accept-Encoding': 'gzip' });
  assert.equal(txt.status, 200);
  assert.match(String(txt.headers['content-type']), /^text\/plain/);
  assert.equal(txt.headers['content-encoding'], undefined);
  assert.equal(txt.headers.vary, undefined);
  assert.ok(txt.body.length > 0 && !txt.body.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])));
});

test('status=open|all and mixes', async () => {
  const open = json(await raw('/api/tasks?status=open'));
  assert.deepEqual(ids(open), ids(GOLDEN_LIST.filter((t) => !['done', 'cancelled'].includes(t.status))));
  assert.ok(open.every((t: any) => !['done', 'cancelled'].includes(t.status)));
  assert.ok(open.some((t: any) => t.status === 'blocked-on-user'));
  const openDone = json(await raw('/api/tasks?status=open,done'));
  assert.deepEqual(ids(openDone), ids(GOLDEN_LIST.filter((t) => t.status !== 'cancelled')));
  assert.deepEqual(json(await raw('/api/tasks?status=all')), GOLDEN_LIST);
  assert.deepEqual(json(await raw('/api/tasks?status=open')), GOLDEN_LIST.filter((t) => !['done', 'cancelled'].includes(t.status)), 'full objects without fields=');
});

test('fields=: slim has no body, named keys only, id always', async () => {
  const slim = json(await raw('/api/tasks?status=open&fields=slim', { 'Accept-Encoding': 'gzip' }));
  const SLIM = ['id', 'title', 'title_ko', 'title_en', 'goal', 'milestone', 'status', 'priority', 'owner', 'lane', 'kind', 'claimed_by', 'version', 'updated', 'pr', 'depends_on', 'spec_state'];
  assert.ok(slim.length > 0);
  for (const t of slim) {
    assert.ok(!('body' in t));
    assert.ok(Object.keys(t).every((k) => SLIM.includes(k)), Object.keys(t).join());
    const full = GOLDEN_LIST.find((g) => g.id === t.id);
    for (const k of SLIM) assert.deepEqual(t[k], full[k], `${t.id}.${k}`);
  }
  const ib = json(await raw('/api/tasks?fields=id,body'));
  assert.deepEqual(ib, GOLDEN_LIST.map((t) => ({ id: t.id, body: t.body })));
  assert.deepEqual(json(await raw('/api/tasks?fields=')), GOLDEN_LIST.map((t) => ({ id: t.id })));
  const sb = json(await raw('/api/tasks?fields=slim,%20body'));
  assert.ok(sb.every((t: any) => typeof t.body === 'string'));
});

test('limit + cursor: limit=1 walks every id once; last page has no X-Next-Cursor; bad values are 400', async () => {
  const seen: string[] = [];
  let cursor = '';
  for (let i = 0; i < 20; i++) {
    const r = await raw(`/api/tasks?limit=1&fields=id${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(r.status, 200);
    const page = json(r);
    assert.equal(page.length, 1);
    seen.push(page[0].id);
    const next = r.headers['x-next-cursor'];
    if (!next) break;
    assert.equal(next, page[0].id);
    cursor = String(next);
  }
  assert.deepEqual(seen, ids(GOLDEN_LIST).sort());
  const open = await raw('/api/tasks?status=open&limit=2');
  assert.deepEqual(ids(json(open)), ids(GOLDEN_LIST.filter((t) => !['done', 'cancelled'].includes(t.status))).sort().slice(0, 2));
  assert.ok(open.headers['x-next-cursor']);
  assert.equal((await raw('/api/tasks?limit=1000')).headers['x-next-cursor'], undefined);
  for (const bad of ['limit=0', 'limit=1001', 'limit=abc', 'cursor=../x', 'limit=2&cursor=../x']) {
    const r = await raw(`/api/tasks?${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(typeof json(r).error, 'string', bad);
  }
});

test('ETag: W/"<boot>-<version>", 304 on If-None-Match, a write gives a new tag', async () => {
  const r = await raw('/api/tasks');
  const tag = String(r.headers.etag);
  assert.match(tag, /^W\/"[0-9a-f]{8}-\d+"$/);
  assert.equal((await raw('/api/tasks?status=open&fields=slim')).headers.etag, tag, 'same data, same tag');
  for (const inm of [tag, tag.slice(2), '*', `W/"other-1", ${tag}`]) {
    const n = await raw('/api/tasks', { 'If-None-Match': inm, 'Accept-Encoding': 'gzip' });
    assert.equal(n.status, 304, inm);
    assert.equal(n.body.length, 0);
    assert.equal(n.headers.etag, tag);
    assert.equal(n.headers['cache-control'], 'no-store');
    assert.equal(n.headers['x-content-type-options'], 'nosniff');
    assert.equal(n.headers['content-encoding'], undefined);
  }
  assert.equal((await raw('/api/tasks', { 'If-None-Match': 'W/"nope-1"' })).status, 200);
  const w = await raw('/api/tasks/shared.t-beta', { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'claude-code@test' }, 'POST', JSON.stringify({ note: 'a note moves the version' }));
  assert.equal(w.status, 200, w.body.toString());
  const after = await raw('/api/tasks', { 'If-None-Match': tag });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.etag, tag);
  assert.match(String(after.headers.etag), /^W\/"[0-9a-f]{8}-\d+"$/);
  assert.equal(String(after.headers.etag).split('-')[0], tag.split('-')[0], 'same boot');
});
