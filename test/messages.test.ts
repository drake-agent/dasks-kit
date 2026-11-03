// Card messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { filterMessages, looksSecret, parseText, postMessage, readMessages, _resetPresence } from '../src/lib/messages.ts';
import { task, tempRepo } from './helpers.ts';

const CARD = 'shared.t-msgd';
const MCP = path.resolve(import.meta.dirname, '../mcp/dasks-mcp.mjs');

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

function mcp(url: string, actor: string) {
  const proc = spawn(process.execPath, [MCP], { env: { ...process.env, DASKS_URL: url, DASKS_ACTOR: actor }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; let next = 1;
  const waiting = new Map<number, (v: any) => void>();
  proc.stdout!.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  const rpc = (method: string, params: any = {}) => new Promise<any>((res) => { const id = next++; waiting.set(id, res); proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name: string, args: any) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { err: !!r.isError, text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() }; };
  return { proc, rpc, call };
}

const demo = () => tempRepo([task({ id: CARD, status: 'doing', owner: 'shared-lead', claimed_by: 'human-claude@laptop', claimed_at: '2026-10-21T01:00:00Z' } as any)]);

test('lib: append-only seq, idempotent request_id, validation', () => {
  const { root, cleanup } = demo();
  _resetPresence();
  try {
    const a = postMessage(root, CARD, { text: 'is the API shape fixed?', kind: 'question', to: 'spec', request_id: 'req-00000001' }, 'job-j1-impl');
    assert.equal(a.message.seq, 1); assert.equal(a.duplicate, false);
    const again = postMessage(root, CARD, { text: 'different text, same id', request_id: 'req-00000001' }, 'job-j1-impl');
    assert.equal(again.duplicate, true); assert.equal(again.message.seq, 1); assert.equal(again.message.text, 'is the API shape fixed?');
    const b = postMessage(root, CARD, { text: 'yes, as in the design doc', kind: 'answer', to: 'job-j1-impl', reply_to: 1 }, 'spec');
    assert.equal(b.message.seq, 2); assert.equal(b.message.reply_to, 1); assert.equal(b.message.to, 'job-j1-impl');
    assert.equal(readMessages(root, CARD).length, 2);
    // a torn last line (crash mid-append) is skipped, the next seq still follows the last good one
    fs.appendFileSync(path.join(root, 'run/messages/shared/t-msgd.jsonl'), '{"seq":3,"te');
    assert.equal(readMessages(root, CARD).length, 2);
    const bad = (body: any, re: RegExp, status = 400, from = 'x@y') => assert.throws(() => postMessage(root, CARD, body, from), (e: any) => e.status === status && re.test(e.message));
    bad({ text: '' }, /text is required/);
    bad({ text: 'x'.repeat(2049) }, /at most 2048/, 413);
    bad({ text: '한'.repeat(700) }, /at most 2048/, 413); // bytes, not characters
    bad({ text: 'a\u0000b' }, /plain text/);
    bad({ text: 'hi', kind: 'approve' }, /never approve/);
    bad({ text: 'hi', kind: 'LGTM' }, /never approve/);
    bad({ text: 'hi', kind: 'merge' }, /never approve/);
    bad({ text: 'hi', kind: 'shout' }, /kind must be/);
    bad({ text: 'hi', to: 'not a name!' }, /to must be/);
    bad({ text: 'hi', reply_to: 99 }, /reply_to must be/);
    bad({ text: 'hi', reply_to: 0 }, /reply_to must be/);
    bad({ text: 'hi', request_id: 'short' }, /request_id/);
    bad({ text: 'hi', status: 'done' }, /takes only/);
    bad({ text: 'hi' }, /sender/, 400, '');
    bad({ text: 'key is ghp_' + 'a'.repeat(36) }, /secret/);
    bad({ text: 'password: hunter2' }, /secret/);
    bad({ text: '-----BEGIN RSA ' + 'PRIVATE KEY-----' }, /secret/);
    // what only the shared redactor recognises is refused too, never masked and stored
    bad({ text: '{"password": "' + 'hun' + 'ter2"}' }, /secret/);
    bad({ text: 'clone https://bob:' + 'hun' + 'ter2' + '@' + 'github.com/x/y' }, /secret/);
    bad({ text: 'Cookie: sid=' + 'abc' + 'def' }, /secret/);
    assert.equal(looksSecret('author: test-user device-b'), false);
    assert.equal(looksSecret('Pass 1: clean, no findings.'), false);
    assert.equal(looksSecret('This is the basic flow, the token budget is 4000.'), false);
    assert.equal(parseText('see /tmp/x.log line 4\nthanks'), 'see /tmp/x.log line 4\nthanks');
    assert.equal(readMessages(root, CARD).length, 2); // nothing stored by any refusal
    const all = readMessages(root, CARD);
    assert.deepEqual(filterMessages(all, { since: 0, to: ['spec'] }).map((m) => m.seq), [1]);
    assert.deepEqual(filterMessages(all, { since: 1 }).map((m) => m.seq), [2]);
    assert.deepEqual(filterMessages(all, { since: 0, kind: ['answer'], reply_to: 1 }).map((m) => m.seq), [2]);
    assert.deepEqual(filterMessages(all, { since: 0, not_from: 'spec' }).map((m) => m.seq), [1]);
  } finally { cleanup(); }
});

test('lib: per-card cap', () => {
  const { root, cleanup } = demo();
  try {
    const file = path.join(root, 'run/messages/shared/t-msgd.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => JSON.stringify({ seq: i + 1, card: CARD, from: 'a', to: '*', kind: 'fyi', reply_to: null, text: 't', job_id: null, ts: '2026-10-21T00:00:00Z', request_id: `r-${String(i).padStart(8, '0')}` })).join('\n') + '\n');
    assert.throws(() => postMessage(root, CARD, { text: 'one more' }, 'a@b'), (e: any) => e.status === 429);
  } finally { cleanup(); }
});

test('HTTP: post, list, wait (wakes and times out), participants, negatives; messages never touch git', async () => {
  const { root, cleanup } = demo();
  const { url, proc } = await startServer(root);
  const H = (actor?: string) => ({ 'Content-Type': 'application/json', ...(actor ? { 'X-Dasks-Actor': actor } : {}) });
  const post = (card: string, body: unknown, actor: string | undefined = 'job-j1-impl') => fetch(`${url}/api/tasks/${card}/messages`, { method: 'POST', headers: H(actor), body: JSON.stringify(body) });
  const get = (p: string, actor = 'human-claude@laptop') => fetch(url + p, { headers: { 'X-Dasks-Actor': actor } });
  try {
    const headBefore = fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8') + String(fs.readdirSync(path.join(root, '.git/refs/heads')));
    const r1 = await post(CARD, { text: 'which endpoint do I call?', kind: 'question', to: 'human', request_id: 'req-http-0001' });
    assert.equal(r1.status, 201);
    const m1 = await r1.json();
    assert.equal(m1.seq, 1); assert.equal(m1.from, 'job-j1-impl'); assert.equal(m1.duplicate, false);
    // idempotent retry: 200, same seq
    const r1b = await post(CARD, { text: 'which endpoint do I call?', kind: 'question', to: 'human', request_id: 'req-http-0001' });
    assert.equal(r1b.status, 200); assert.equal((await r1b.json()).seq, 1);

    let l = await (await get(`/api/tasks/${CARD}/messages?since=0`)).json();
    assert.equal(l.last_seq, 1); assert.equal(l.messages.length, 1);
    l = await (await get(`/api/tasks/${CARD}/messages?since=1`)).json();
    assert.equal(l.messages.length, 0);

    // wait: timeout with nothing new
    const t0 = Date.now();
    const w0 = await (await get(`/api/tasks/${CARD}/messages/wait?since=1&timeout=1`)).json();
    assert.equal(w0.timed_out, true); assert.equal(w0.task_correlated, false); assert.deepEqual(w0.messages, []);
    assert.ok(Date.now() - t0 >= 900, 'waited about a second');

    // wait: a parked waiter wakes on a matching post only (to filter), and shows as "waiting" in participants
    const waiting = get(`/api/tasks/${CARD}/messages/wait?since=1&timeout=20&to=job-j1-impl,*,impl&not_from=job-j1-impl`, 'job-j1-impl').then((r) => r.json());
    await new Promise((r) => setTimeout(r, 300));
    const who = await (await get(`/api/tasks/${CARD}/participants`)).json();
    const row = (a: string) => who.participants.find((p: any) => p.actor === a);
    assert.equal(row('job-j1-impl').state, 'waiting');
    assert.equal(row('human-claude@laptop').source.includes('claim'), true);
    assert.equal(row('shared-lead').role, 'owner');
    assert.match(who.note, /labels, not identities/);
    assert.equal((await post(CARD, { text: 'note to spec only', to: 'spec' }, 'human-claude@laptop')).status, 201); // does not match
    assert.equal((await post(CARD, { text: 'call /api/x', kind: 'answer', to: 'job-j1-impl', reply_to: 1 }, 'human-claude@laptop')).status, 201);
    const w1 = await waiting;
    assert.equal(w1.timed_out, false); assert.equal(w1.task_correlated, false);
    assert.deepEqual(w1.messages.map((m: any) => m.seq), [3]);

    assert.equal((await post('shared.t-nope', { text: 'hi' })).status, 404);
    assert.equal((await get('/api/tasks/shared.t-nope/messages')).status, 404);
    assert.equal((await get('/api/tasks/shared.t-nope/messages/wait?since=0&timeout=1')).status, 404);
    assert.equal((await get('/api/tasks/shared.t-nope/participants')).status, 404);
    assert.equal((await post('NOT_AN_ID', { text: 'hi' })).status, 400);
    assert.equal((await post(CARD, { text: 'x'.repeat(3000) })).status, 413);
    assert.equal((await post(CARD, { text: 'hi', kind: 'approve' })).status, 400);
    assert.equal((await post(CARD, { text: 'tok' + 'en=' + 'abc'.repeat(4) })).status, 400);
    assert.equal((await post(CARD, { text: 'hi' }, '')).status, 400); // no actor header: never a default name
    assert.equal((await post(CARD, { text: 'hi' }, 'user')).status, 401); // "user" needs the human login
    assert.equal((await get(`/api/tasks/${CARD}/messages?since=abc`)).status, 400);
    assert.equal((await get(`/api/tasks/${CARD}/messages/wait?since=0&timeout=x`)).status, 400);
    assert.equal((await get(`/api/tasks/${CARD}/messages?kind=approve`)).status, 400);

    // nothing committed: the card file, activity log and git history are untouched
    const headAfter = fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8') + String(fs.readdirSync(path.join(root, '.git/refs/heads')));
    assert.equal(headAfter, headBefore);
    const { execFileSync } = await import('node:child_process');
    assert.equal(execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '1');
    assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'data'], { encoding: 'utf8' }).trim(), '');
    // the card itself did not move
    const card = await (await get(`/api/tasks/${CARD}`)).json();
    assert.equal(card.status, 'doing');
  } finally { proc.kill(); cleanup(); }
});

test('MCP: card_who, card_msg, card_inbox, card_wait', async () => {
  const { root, cleanup } = demo();
  const { url, proc } = await startServer(root);
  const a = mcp(url, 'claude-code@laptop');
  const b = mcp(url, 'codex@desktop');
  try {
    await a.rpc('initialize', { protocolVersion: '2025-06-18' });
    await b.rpc('initialize', { protocolVersion: '2025-06-18' });
    const names = (await a.rpc('tools/list')).result.tools.map((t: any) => t.name);
    for (const n of ['card_who', 'card_msg', 'card_inbox', 'card_wait']) assert.ok(names.includes(n), n);

    const sent = await b.call('card_msg', { id: CARD, text: 'can you check the schema?', kind: 'question', to: 'human', request_id: 'mcp-req-0001' });
    assert.equal(sent.err, false); assert.equal(sent.json.seq, 1);
    const dup = await b.call('card_msg', { id: CARD, text: 'can you check the schema?', kind: 'question', to: 'human', request_id: 'mcp-req-0001' });
    assert.equal(dup.json.duplicate, true);

    // claude-code@ answers to "human", so to_me shows it the message sent to that role.
    const inbox = await a.call('card_inbox', { id: CARD, since: 0, to_me: true });
    assert.deepEqual(inbox.json.messages.map((m: any) => m.seq), [1]);
    const own = await b.call('card_inbox', { id: CARD, since: 0, to_me: true });
    assert.deepEqual(own.json.messages, []); // its own message is never "to me"

    // card_wait: timeout, then a reply wakes it
    const to = await b.call('card_wait', { id: CARD, since: 1, to_me: true, timeout: 1 });
    assert.equal(to.json.timed_out, true);
    const pending = b.call('card_wait', { id: CARD, since: 1, to_me: true, reply_to: 1, timeout: 30 });
    await new Promise((r) => setTimeout(r, 300));
    const who = await a.call('card_who', { id: CARD });
    assert.equal(who.json.participants.find((p: any) => p.actor === 'codex@desktop').state, 'waiting');
    const ans = await a.call('card_msg', { id: CARD, text: 'checked, looks fine', kind: 'answer', to: 'codex@desktop', reply_to: 1 });
    assert.equal(ans.err, false);
    const got = await pending;
    assert.equal(got.json.timed_out, false); assert.equal(got.json.messages[0].seq, 2); assert.equal(got.json.task_correlated, false);

    // one session, two names: claude-code@laptop (MCP) and human-claude@laptop (dask CLI, hook) are both "me"
    const post = (from: string, body: any) => fetch(`${url}/api/tasks/${CARD}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': from }, body: JSON.stringify(body) });
    assert.equal((await post('human-claude@laptop', { text: 'sent through the dask name' })).status, 201); // seq 3
    assert.equal((await post('codex@desktop', { text: 'to the dask name', to: 'human-claude@laptop' })).status, 201); // seq 4
    const both = await a.call('card_inbox', { id: CARD, since: 2, to_me: true });
    assert.deepEqual(both.json.messages.map((m: any) => m.seq), [4]);
    const pendingA = a.call('card_wait', { id: CARD, since: 4, to_me: true, timeout: 30 });
    await new Promise((r) => setTimeout(r, 300));
    await post('human-claude@laptop', { text: 'my other name again' }); // seq 5: must not wake me
    await post('codex@desktop', { text: 'for you', to: '*' }); // seq 6
    const woke = await pendingA;
    assert.deepEqual(woke.json.messages.map((m: any) => m.seq), [6]);

    const unk = await a.call('card_msg', { id: 'shared.t-nope', text: 'hi' });
    assert.equal(unk.err, true); assert.match(unk.text, /404/);
    const big = await a.call('card_msg', { id: CARD, text: 'x'.repeat(2100) });
    assert.equal(big.err, true); assert.match(big.text, /413/);
    const appr = await a.call('card_msg', { id: CARD, text: 'ship it', kind: 'approve' });
    assert.equal(appr.err, true);
    const miss = await a.call('card_wait', { id: CARD });
    assert.equal(miss.err, true); assert.match(miss.text, /since/);
  } finally { a.proc.kill(); b.proc.kill(); proc.kill(); cleanup(); }
});

test('no gate reads messages: gate modules and the write path never import or call them', () => {
  const lib = path.resolve(import.meta.dirname, '../src/lib');
  // Every module that decides a status, a claim, a launch, a review, a merge or a human decision.
  const GATES = ['transitions.ts', 'write.ts', 'decisions.ts', 'outcome.ts', 'job-outcome.ts', 'ready.ts', 'auth.ts', 'collab.ts', 'check.ts', 'lanes.ts'];
  for (const f of GATES) {
    const src = fs.readFileSync(path.join(lib, f), 'utf8');
    assert.doesNotMatch(src, /messages\.ts|\/messages\b|readMessages|filterMessages|waitMessages/, `${f} must not read card messages`);
  }
  // and nothing else in src/lib imports it either (only the server routes do)
  for (const f of fs.readdirSync(lib)) if (f !== 'messages.ts') assert.doesNotMatch(fs.readFileSync(path.join(lib, f), 'utf8'), /from '\.\/messages\.ts'/, f);
});
