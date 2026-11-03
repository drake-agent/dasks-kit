// Card spec store (the contract check is in test/contract.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createTask } from '../src/lib/write.ts';
import { tempRepo } from './helpers.ts';
import { freePort, sha256 as sha, snapshotFiles, stopServer } from './spec-support.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src/server.ts');
const MCP = path.join(ROOT, 'mcp/dasks-mcp.mjs');
const CAP = 262_144;

// ---------- a valid card (no contract errors, no warnings) ----------
function card(o: { acceptance?: string | null; oracle?: string | null; other?: string; pad?: string } = {}): string {
  const acc = o.acceptance === undefined ? '1. GET returns the text.\n2. PUT stores a version.\n' : o.acceptance;
  const ora = o.oracle === undefined ? 'sha256 of fixture A = abc\n' : o.oracle;
  return 'id: shared.t-spec\ngoal: shared\nrole: builder\ntier: 1\nrepo: example-org/dasks\nbranch: human/shared.t-spec\nlane: none\n'
    + 'deadline: 2026-11-01\nsize: big\ndepends_on: none\nimpl: claude\nreview: codex\ndone_when: the board shows the spec\ndone_at: pr\npass_checks:\n  - npm test is green\n  - GET returns the text\n  - over the cap is 413\n'
    + `\n## Background\n${o.other ?? 'Background text.'}\n\n## Why\nBecause.\n\n## Context pack\n- docs/x.md\n\n## Tests\n- test/x.test.ts\n`
    + (acc === null ? '' : `\n## Acceptance tests\n${acc}`)
    + (ora === null ? '' : `\n## Oracle\n${ora}`)
    + (o.pad ? `\n## Notes\n${o.pad}` : '');
}
/** A valid card of exactly `n` UTF-8 bytes, padded with `unit` (a 1- or 3-byte character) then ASCII. */
function cardOfBytes(n: number, unit = 'x'): string {
  const base = card({ pad: '' });
  let left = n - Buffer.byteLength(base, 'utf8');
  const ub = Buffer.byteLength(unit, 'utf8');
  const pad = unit.repeat(Math.floor(left / ub)); left -= Buffer.byteLength(pad, 'utf8');
  const s = base + pad + 'x'.repeat(left);
  assert.equal(Buffer.byteLength(s, 'utf8'), n);
  return s;
}
/** JSON with every character of `text` written as \uXXXX (surrogate pairs as two escapes). */
function escapedJson(body: Record<string, unknown>, textKey = 'text'): string {
  const text = String(body[textKey]);
  let esc = '';
  for (let i = 0; i < text.length; i++) esc += '\\u' + text.charCodeAt(i).toString(16).padStart(4, '0');
  const rest = JSON.stringify({ ...body, [textKey]: undefined });
  return `{"${textKey}":"${esc}"${rest === '{}' ? '' : ',' + rest.slice(1, -1)}}`;
}

// ---------- server + MCP ----------
async function startServer(root: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const send = (line: string, id: number) => new Promise<any>((res) => { waiting.set(id, res); proc.stdin!.write(line + '\n'); });
  const rpc = (method: string, params: any = {}) => { const id = next++; return send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), id); };
  const parse = (r: any) => ({ err: !!r.isError, text: r.content[0].text as string, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() });
  const call = async (name: string, args: any) => parse((await rpc('tools/call', { name, arguments: args })).result);
  /** tools/call with the arguments object given as raw JSON text (e.g. every character \u-escaped). */
  const callRaw = async (name: string, argsJson: string) => { const id = next++; return parse((await send(`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"${name}","arguments":${argsJson}}}`, id)).result); };
  return { proc, rpc, call, callRaw };
}
function api(url: string) {
  const put = (id: string, body: unknown, actor = 'agent-a@laptop', raw?: string) => fetch(`${url}/api/tasks/${id}/spec`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: raw ?? JSON.stringify(body),
  });
  const get = (id: string, q = '') => fetch(`${url}/api/tasks/${id}/spec${q}`);
  return { put, get };
}
/** Everything a refused write must leave alone: the spec tree, the task file and the git HEAD. */
function snapshot(root: string, taskFile: string) {
  const files = snapshotFiles(root, ['data/specs']);
  return { files, task: fs.readFileSync(path.join(root, taskFile), 'utf8'), head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
}
async function withBoard(fn: (b: { root: string; url: string; id: string; file: string; put: ReturnType<typeof api>['put']; get: ReturnType<typeof api>['get'] }) => Promise<void>) {
  const { root, cleanup } = tempRepo();
  const t = createTask(root, { goal: 'shared', title: 'Spec card' }, 'helper');
  const { url, proc } = await startServer(root);
  try { await fn({ root, url, id: t.id, file: t.file, ...api(url) }); } finally { await stopServer(proc); cleanup(); }
}

// ---------- impl / review pair ----------
test('pair: PUT and MCP store impl/review as written; a pair of one model family is refused', () => withBoard(async ({ root, url, id, put, get }) => {
  const base = card();
  assert.match(base, /^impl: claude\nreview: codex$/m);
  let version = 0;
  for (const input of [base, base.replace('impl: claude\nreview: codex', 'impl: codex\nreview: claude')]) {
    const r = await put(id, { text: input, expected_spec_version: version++ });
    assert.equal(r.status, 200, await r.clone().text());
    const stored = await r.json();
    assert.equal(stored.text, input, 'stored as written');
    assert.equal(stored.metadata.sha256, sha(input));
    assert.deepEqual(await (await get(id)).json(), stored);
    assert.equal(fs.readFileSync(path.join(root, 'data/specs', id.replace('.', '/') + '.md'), 'utf8'), input);
  }
  const same = await put(id, { text: base.replace('review: codex', 'review: claude-example'), expected_spec_version: version });
  assert.equal(same.status, 422);
  assert.deepEqual((await same.json()).reasons, ['PAIR REFUSED: same model family reviewing itself (claude -> claude-example)']);
  const m = mcp(url, 'claude-code@laptop');
  try {
    await m.rpc('initialize', { protocolVersion: '2025-06-18' });
    const r = await m.call('put_spec', { id, text: base, expected_spec_version: version++ });
    assert.equal(r.err, false, r.text);
    assert.equal(r.json.text, base);
  } finally { m.proc.kill(); }
}));

// ---------- versions ----------
test('versions: v1 needs expected 0, every next PUT exactly the current version, anything else 409; concurrent PUTs: one wins', () => withBoard(async ({ id, put, get }) => {
  let r = await put(id, { text: card(), expected_spec_version: 1 });
  assert.equal(r.status, 409); assert.equal((await r.json()).current_spec_version, 0);
  r = await put(id, { text: card(), expected_spec_version: 0 });
  assert.equal(r.status, 200); assert.equal((await r.json()).metadata.version, 1);
  for (const ev of [0, 2, 5]) {
    r = await put(id, { text: card({ other: 'x' }), expected_spec_version: ev });
    assert.equal(r.status, 409, `expected ${ev}`); assert.equal((await r.json()).current_spec_version, 1);
  }
  const [a, b] = await Promise.all([put(id, { text: card({ other: 'from A' }), expected_spec_version: 1 }), put(id, { text: card({ other: 'from B' }), expected_spec_version: 1 }, 'agent-b@laptop')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const latest = await (await get(id)).json();
  assert.equal(latest.metadata.version, 2);
  assert.equal((await get(id, '?version=3')).status, 404);
  const winner = a.status === 200 ? 'from A' : 'from B';
  assert.ok(latest.text.includes(winner));
}));

// ---------- input and status codes ----------
test('status codes: bad expected_spec_version 400, unknown task 404, no spec 404 with version 0, bad ?version 400, missing version 404', () => withBoard(async ({ url, id, put, get }) => {
  for (const ev of [undefined, null, -1, 1.5, '0', true, [0]]) {
    const body: any = { text: card() }; if (ev !== undefined) body.expected_spec_version = ev;
    assert.equal((await put(id, body)).status, 400, `expected_spec_version ${JSON.stringify(ev)}`);
  }
  assert.equal((await put('shared.t-nonex', { text: card(), expected_spec_version: 0 })).status, 404);
  assert.equal((await get('shared.t-nonex')).status, 404);
  let r = await get(id);
  assert.equal(r.status, 404); assert.equal((await r.json()).current_spec_version, 0);
  assert.equal((await put(id, { text: card(), expected_spec_version: 0 })).status, 200);
  assert.equal((await put(id, { text: card({ other: 'two' }), expected_spec_version: 1 })).status, 200);
  for (const q of ['?version=0', '?version=-1', '?version=1.5', '?version=abc', '?version=']) assert.equal((await get(id, q)).status, 400, q);
  assert.equal((await get(id, '?version=3')).status, 404);
  r = await get(id);
  assert.equal(r.status, 200); assert.equal((await r.json()).metadata.version, 2);
  assert.equal((await (await get(id, '?version=1')).json()).metadata.version, 1);
  // other shape errors: text missing or not a string, unknown field, bad task id
  assert.equal((await put(id, { expected_spec_version: 2 })).status, 400);
  assert.equal((await put(id, { text: 5, expected_spec_version: 2 })).status, 400);
  assert.equal((await put(id, { text: card(), expected_spec_version: 2, extra: 1 })).status, 400);
  assert.equal((await put('NOT-AN-ID', { text: card(), expected_spec_version: 0 })).status, 400);
  assert.equal((await fetch(`${url}/api/tasks/NOT-AN-ID/spec`)).status, 400);
}));

// ---------- check order ----------
test('check order: raw 413 → shape 400 → task 404 → size 413 → version 409 → contract 422', () => withBoard(async ({ id, put }) => {
  assert.equal((await put(id, { text: card(), expected_spec_version: 0 })).status, 200);
  const invalid = 'not a card at all\n';
  const big = cardOfBytes(CAP + 1), bigInvalid = invalid + 'x'.repeat(CAP);
  // stale + invalid → 409; oversized + invalid → 413; oversized + stale → 413
  assert.equal((await put(id, { text: invalid, expected_spec_version: 0 })).status, 409);
  assert.equal((await put(id, { text: bigInvalid, expected_spec_version: 1 })).status, 413);
  assert.equal((await put(id, { text: big, expected_spec_version: 0 })).status, 413);
  // invalid alone → 422; shape beats task and size; task beats size
  assert.equal((await put(id, { text: invalid, expected_spec_version: 1 })).status, 422);
  assert.equal((await put('shared.t-nonex', { text: bigInvalid, expected_spec_version: 'x' })).status, 400);
  assert.equal((await put('shared.t-nonex', { text: bigInvalid, expected_spec_version: 0 })).status, 404);
  // raw overflow on an unknown task (and with a broken body) → 413
  const raw = '{"text":"' + 'x'.repeat(2_097_152) + '"}';
  assert.equal((await put('shared.t-nonex', null, 'agent-a@laptop', raw)).status, 413);
  assert.equal((await put('shared.t-nonex', null, 'agent-a@laptop', 'x'.repeat(2_097_153))).status, 413);
}));

// ---------- nothing written on a refusal ----------
test('refusals write nothing: text, versions, metadata, authors, task file and git HEAD unchanged; no version gaps', () => withBoard(async ({ root, id, file, put, get }) => {
  const refuse = async (body: any, want: number, target = id, raw?: string) => {
    const before = snapshot(root, file);
    assert.equal((await put(target, body, 'agent-a@laptop', raw)).status, want);
    assert.deepEqual(snapshot(root, file), before, `refused ${want} changed something`);
  };
  // a refused first write leaves no version at all
  await refuse({ text: card(), expected_spec_version: 1 }, 409);
  await refuse({ text: 'not a card\n', expected_spec_version: 0 }, 422);
  await refuse({ text: cardOfBytes(CAP + 1), expected_spec_version: 0 }, 413);
  await refuse({ text: card() }, 400);
  await refuse({ text: card(), expected_spec_version: 0 }, 404, 'shared.t-nonex');
  await refuse(null, 413, id, '{"text":"' + 'x'.repeat(2_097_152) + '"}');
  assert.deepEqual(snapshot(root, file).files, {});
  let r = await put(id, { text: card(), expected_spec_version: 0 });
  assert.equal((await r.json()).metadata.version, 1);
  // and after v1 exists
  await refuse({ text: card({ other: 'b' }), expected_spec_version: 0 }, 409);
  await refuse({ text: 'still not a card\n', expected_spec_version: 1 }, 422);
  await refuse({ text: cardOfBytes(CAP + 1), expected_spec_version: 1 }, 413);
  await refuse({ text: card(), expected_spec_version: 1, note: 'n'.repeat(4097) }, 400);
  r = await put(id, { text: card({ other: 'b' }), expected_spec_version: 1 });
  assert.equal((await r.json()).metadata.version, 2);
  assert.equal((await (await get(id)).json()).metadata.version, 2);
}));

// ---------- metadata ----------
test('metadata: v1 and v2 come back byte for byte with version, by, at (local time with its offset), note and the sha256 of those bytes', () => withBoard(async ({ id, put, get }) => {
  const v1 = card({ other: 'First text, 한국어 포함.\r\nCRLF kept.' }), v2 = card({ other: 'Second text.' });
  assert.equal((await put(id, { text: v1, expected_spec_version: 0, note: 'first draft' }, 'agent-a@laptop')).status, 200);
  assert.equal((await put(id, { text: v2, expected_spec_version: 1 }, 'agent-b@desktop')).status, 200);
  for (const [n, text, by, note] of [[1, v1, 'agent-a@laptop', 'first draft'], [2, v2, 'agent-b@desktop', '']] as const) {
    const r = await (await get(id, `?version=${n}`)).json();
    assert.equal(r.text, text);
    assert.deepEqual(Object.keys(r.metadata).sort(), ['at', 'by', 'note', 'sha256', 'version']);
    assert.equal(r.metadata.version, n); assert.equal(r.metadata.by, by); assert.equal(r.metadata.note, note);
    assert.match(r.metadata.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.ok(Math.abs(Date.parse(r.metadata.at) - Date.now()) < 120_000);
    assert.equal(r.metadata.sha256, sha(Buffer.from(text, 'utf8')));
  }
  assert.equal((await (await get(id)).json()).text, v2);
}));

// ---------- section authors ----------
test('section authors: per section hash, kept on other edits, new writer on change, cleared on removal, never handed back', () => withBoard(async ({ id, put, get }) => {
  const accA = '1. original acceptance.\n', oraA = 'original oracle\n';
  let ver = 0;
  const write = async (who: string, o: Parameters<typeof card>[0]) => {
    const r = await put(id, { text: card(o), expected_spec_version: ver }, who);
    assert.equal(r.status, 200, await r.clone().text()); ver++;
    return (await r.json()).section_authors;
  };
  const sec = (name: string, body: string) => sha(Buffer.from(`## ${name}\n${body}`, 'utf8'));
  // A writes both sections (Oracle is the last section: it runs to the end of the text)
  let s = await write('agent-a@m', { acceptance: accA, oracle: oraA });
  assert.deepEqual(s, { acceptance_tests: { by: 'agent-a@m', sha256: sha(Buffer.from(`## Acceptance tests\n${accA}\n`, 'utf8')) }, oracle: { by: 'agent-a@m', sha256: sec('Oracle', oraA) } });
  const v1 = s;
  // B changes only other text → both stay A
  s = await write('agent-b@m', { acceptance: accA, oracle: oraA, other: 'B edits the background' });
  assert.deepEqual(s, v1);
  // B changes only Acceptance → Acceptance B, Oracle A
  s = await write('agent-b@m', { acceptance: '1. B acceptance.\n', oracle: oraA });
  assert.equal(s.acceptance_tests.by, 'agent-b@m'); assert.equal(s.oracle.by, 'agent-a@m');
  // C changes only Oracle → Oracle C
  s = await write('agent-c@m', { acceptance: '1. B acceptance.\n', oracle: 'C oracle\n' });
  assert.equal(s.acceptance_tests.by, 'agent-b@m'); assert.equal(s.oracle.by, 'agent-c@m');
  // removing Oracle → null; D re-adds text identical to A's original → author D
  s = await write('agent-c@m', { acceptance: '1. B acceptance.\n', oracle: null });
  assert.equal(s.oracle, null);
  s = await write('agent-d@m', { acceptance: '1. B acceptance.\n', oracle: oraA });
  assert.deepEqual(s.oracle, { by: 'agent-d@m', sha256: sec('Oracle', oraA) });
  // restoring A's earlier Acceptance without a removal → the restoring writer
  s = await write('agent-e@m', { acceptance: accA, oracle: oraA });
  assert.deepEqual(s.acceptance_tests, { by: 'agent-e@m', sha256: v1.acceptance_tests.sha256 });
  // old versions keep their original hashes and authors
  assert.deepEqual((await (await get(id, '?version=1')).json()).section_authors, v1);
  assert.equal((await (await get(id, '?version=5')).json()).section_authors.oracle, null);
  assert.deepEqual((await (await get(id, '?version=3')).json()).section_authors.acceptance_tests.by, 'agent-b@m');
}));

// ---------- size ----------
test('size: 128 KiB and exactly 262,144 bytes stored over HTTP and MCP (Korean, all \\u-escaped); +1 byte 413; raw > 2 MiB 413; note > 4096 400', () => withBoard(async ({ url, id, put, get }) => {
  let ver = 0;
  const ok = async (r: Response, text: string) => { assert.equal(r.status, 200, (await r.clone().text()).slice(0, 300)); ver++; assert.equal((await (await get(id)).json()).text, text); };
  const k128 = cardOfBytes(128 * 1024);
  await ok(await put(id, { text: k128, expected_spec_version: ver }), k128);
  const atCapKo = cardOfBytes(CAP, '한');
  await ok(await put(id, { text: atCapKo, expected_spec_version: ver }), atCapKo);
  const atCap = cardOfBytes(CAP);
  const raw = escapedJson({ text: atCap, expected_spec_version: ver });
  assert.ok(raw.length > 1_500_000 && raw.length <= 2_097_152, `escaped body ${raw.length}`);
  await ok(await put(id, null, 'agent-a@laptop', raw), atCap);
  assert.equal((await put(id, { text: cardOfBytes(CAP + 1), expected_spec_version: ver })).status, 413);
  assert.equal((await put(id, { text: cardOfBytes(CAP + 1, '한').slice(0, -1) + '한', expected_spec_version: ver })).status, 413);
  assert.equal((await put(id, null, 'agent-a@laptop', '{"text":"' + 'x'.repeat(2_097_200) + '","expected_spec_version":' + ver + '}')).status, 413);
  assert.equal((await put(id, { text: atCap, expected_spec_version: ver, note: 'n'.repeat(4097) })).status, 400);
  assert.equal((await put(id, { text: atCap, expected_spec_version: ver, note: '한'.repeat(1366) })).status, 400); // 4,098 bytes
  await ok(await put(id, { text: k128, expected_spec_version: ver, note: 'n'.repeat(4096) }), k128);
  // MCP: the same sizes, one call written entirely as \u escapes
  const m = mcp(url, 'claude-code@laptop');
  try {
    await m.rpc('initialize', { protocolVersion: '2025-06-18' });
    let c = await m.call('put_spec', { id, text: atCapKo, expected_spec_version: ver });
    assert.equal(c.err, false, c.text.slice(0, 300)); ver++;
    c = await m.callRaw('put_spec', escapedJson({ text: atCap, id, expected_spec_version: ver }));
    assert.equal(c.err, false, c.text.slice(0, 300)); ver++;
    assert.equal((await m.call('get_spec', { id })).json.text, atCap);
    c = await m.call('put_spec', { id, text: cardOfBytes(CAP + 1), expected_spec_version: ver });
    assert.equal(c.err, true); assert.equal(c.json.http_status, 413);
  } finally { m.proc.kill(); }
  // other routes keep 64 KiB
  const r = await fetch(`${url}/api/tasks/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'agent-a@laptop' }, body: JSON.stringify({ note: 'x'.repeat(70 * 1024) }) }).catch(() => null);
  assert.ok(!r || r.status === 413, `task route took a body over 64 KiB (${r?.status})`);
}));

// ---------- MCP ----------
test('MCP: HTTP write → MCP read (current and old), MCP write → HTTP read; server errors come back as isError with http_status and detail', () => withBoard(async ({ url, id, put, get }) => {
  const m = mcp(url, 'claude-code@laptop');
  try {
    await m.rpc('initialize', { protocolVersion: '2025-06-18' });
    const t1 = card({ other: 'over HTTP' }), t2 = card({ other: 'over MCP' });
    assert.equal((await put(id, { text: t1, expected_spec_version: 0, note: 'http' })).status, 200);
    const h1 = await (await get(id)).json();
    let c = await m.call('get_spec', { id });
    assert.equal(c.err, false); assert.deepEqual(c.json, h1);
    c = await m.call('put_spec', { id, text: t2, expected_spec_version: 1, note: 'mcp' });
    assert.equal(c.err, false, c.text);
    const h2 = await (await get(id)).json();
    assert.deepEqual(c.json, h2);
    assert.equal(h2.text, t2); assert.equal(h2.metadata.by, 'claude-code@laptop'); assert.equal(h2.metadata.note, 'mcp');
    assert.deepEqual((await m.call('get_spec', { id, version: 1 })).json, await (await get(id, '?version=1')).json());
    // errors: same status and detail as HTTP
    const same = async (args: any, httpRes: Promise<Response>, want: number) => {
      const r = await httpRes; const body = await r.json();
      assert.equal(r.status, want);
      const c = args.text === undefined && args.expected_spec_version === undefined ? await m.call('get_spec', args) : await m.call('put_spec', args);
      assert.equal(c.err, true); assert.equal(c.json.http_status, want);
      assert.deepEqual({ ...c.json, http_status: undefined }, { ...body, http_status: undefined });
    };
    await same({ id, text: t2, expected_spec_version: -1 }, put(id, { text: t2, expected_spec_version: -1 }), 400);
    await same({ id: 'shared.t-nonex' }, get('shared.t-nonex'), 404);
    await same({ id, text: t2, expected_spec_version: 0 }, put(id, { text: t2, expected_spec_version: 0 }), 409);
    await same({ id, text: cardOfBytes(CAP + 1), expected_spec_version: 2 }, put(id, { text: cardOfBytes(CAP + 1), expected_spec_version: 2 }), 413);
    await same({ id, text: 'not a card\n', expected_spec_version: 2 }, put(id, { text: 'not a card\n', expected_spec_version: 2 }), 422);
    const tools = (await m.rpc('tools/list')).result.tools;
    assert.deepEqual(tools.find((t: any) => t.name === 'put_spec').inputSchema.required.sort(), ['expected_spec_version', 'id', 'text']);
    assert.deepEqual(tools.find((t: any) => t.name === 'get_spec').inputSchema.required, ['id']);
  } finally { m.proc.kill(); }
}));

// ---------- tasks without a spec, spec fields on the task ----------
// A spec write that changes the task's spec fields bumps the task version once and moves `updated`; one that changes
// none leaves both; the body never changes.
test('a task without a spec claims normally; saving a spec leaves the task body unchanged', () => withBoard(async ({ root, url, id, file, put }) => {
  const other = createTask(root, { goal: 'shared', title: 'No spec here' }, 'helper');
  const post = (p: string, body: any) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'agent-a@laptop' }, body: JSON.stringify(body) });
  // The watcher picks up the task created behind the server's back: wait until the server shows it (a fixed wait loses
  // on a loaded machine).
  for (let i = 0; ; i++) {
    if ((await fetch(`${url}/api/tasks/${other.id}`)).status === 200) break;
    if (i >= 100) assert.fail(`the server never loaded ${other.id} within 10 s`);
    await new Promise((r) => setTimeout(r, 100));
  }
  let r = await post(`/api/tasks/${other.id}/claim`, {});
  assert.equal(r.status, 200); const claimed = await r.json();
  assert.equal(claimed.status, 'doing'); assert.equal(claimed.claimed_by, 'agent-a@laptop');
  const t0 = await (await fetch(`${url}/api/tasks/${id}`)).json();
  await new Promise((r) => setTimeout(r, 1100)); // `updated` has 1 s resolution
  assert.equal((await put(id, { text: card(), expected_spec_version: 0 })).status, 200);
  const t1 = await (await fetch(`${url}/api/tasks/${id}`)).json();
  assert.equal(t1.spec_state, 'draft'); // a big card with Acceptance and no review yet
  assert.equal(t1.version, t0.version + 1); assert.notEqual(t1.updated, t0.updated); assert.equal(t1.body, t0.body);
  const between = fs.readFileSync(path.join(root, file), 'utf8');
  assert.equal((await put(id, { text: card({ other: 'v2' }), expected_spec_version: 1 })).status, 200);
  assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), between); // still draft: no spec field changed
  const t2 = await (await fetch(`${url}/api/tasks/${id}`)).json();
  assert.equal(t2.version, t1.version); assert.equal(t2.body, t0.body); assert.equal(t2.updated, t1.updated);
}));

// ---------- store layout ----------
test('store layout: two tasks in one goal keep separate v1/v2 texts, metadata and authors, also after a restart', async () => {
  const { root, cleanup } = tempRepo();
  const a = createTask(root, { goal: 'shared', title: 'Card one' }, 'helper');
  const b = createTask(root, { goal: 'shared', title: 'Card two' }, 'helper');
  let { url, proc } = await startServer(root);
  try {
    let { put, get } = api(url);
    const texts: Record<string, string[]> = { [a.id]: [card({ other: 'a1', oracle: 'oa\n' }), card({ other: 'a2', acceptance: '1. a2\n', oracle: 'oa\n' })], [b.id]: [card({ other: 'b1', oracle: 'ob\n' }), card({ other: 'b2', oracle: null })] };
    const who: Record<string, string[]> = { [a.id]: ['a-one@m', 'a-two@m'], [b.id]: ['b-one@m', 'b-two@m'] };
    for (const n of [0, 1]) for (const id of [a.id, b.id]) assert.equal((await put(id, { text: texts[id][n], expected_spec_version: n, note: `${id} v${n + 1}` }, who[id][n])).status, 200);
    const read = async () => Object.fromEntries(await Promise.all([a.id, b.id].flatMap((id) => [1, 2].map(async (v) => [`${id}@${v}`, await (await get(id, `?version=${v}`)).json()]))));
    const before = await read();
    await stopServer(proc);
    ({ url, proc } = await startServer(root));
    ({ put, get } = api(url));
    const after = await read();
    assert.deepEqual(after, before);
    for (const id of [a.id, b.id]) for (const v of [1, 2]) {
      const r = after[`${id}@${v}`];
      assert.equal(r.text, texts[id][v - 1]); assert.equal(r.metadata.by, who[id][v - 1]); assert.equal(r.metadata.note, `${id} v${v}`);
    }
    assert.equal(after[`${a.id}@2`].section_authors.acceptance_tests.by, 'a-two@m');
    assert.equal(after[`${a.id}@2`].section_authors.oracle.by, 'a-one@m');
    assert.equal(after[`${b.id}@2`].section_authors.oracle, null);
    assert.equal(after[`${b.id}@1`].section_authors.oracle.by, 'b-one@m');
    // on disk: one folder per task
    const slug = (id: string) => id.split('.')[1];
    for (const id of [a.id, b.id]) {
      assert.equal(fs.readFileSync(path.join(root, `data/specs/shared/${slug(id)}.md`), 'utf8'), texts[id][1]);
      for (const v of [1, 2]) assert.equal(fs.readFileSync(path.join(root, `data/specs/shared/${slug(id)}/versions/${v}.md`), 'utf8'), texts[id][v - 1]);
    }
  } finally { await stopServer(proc); cleanup(); }
});

// ---------- line endings and oversized bodies ----------
test('section authors on CR-only and CRLF text; sectionOf keeps the exact bytes', async () => {
  const { sectionOf, nextSectionAuthors } = await import('../src/lib/specs.ts');
  for (const eol of ['\r', '\r\n', '\n']) {
    const t = card().replace(/\n/g, eol);
    const acc = sectionOf(t, 'Acceptance tests'), ora = sectionOf(t, 'Oracle');
    assert.equal(acc, `## Acceptance tests${eol}1. GET returns the text.${eol}2. PUT stores a version.${eol}${eol}`, JSON.stringify(eol));
    assert.equal(ora, `## Oracle${eol}sha256 of fixture A = abc${eol}`);
    const s = nextSectionAuthors({ acceptance_tests: null, oracle: null }, t, 'a@m');
    assert.equal(s.acceptance_tests!.sha256, sha(acc!)); assert.equal(s.oracle!.by, 'a@m');
  }
  assert.equal(sectionOf('## Acceptance testsuite\nx\n', 'Acceptance tests'), null);
  assert.equal(sectionOf('## Oracle (pinned)\nx\n### sub\ny\n## Next\n', 'Oracle'), '## Oracle (pinned)\nx\n### sub\ny\n');
});

test('raw bodies far over the limit still get a 413 response, not a dropped connection', () => withBoard(async ({ id, put }) => {
  for (const n of [8 * 1024 * 1024 + 1, 40 * 1024 * 1024]) {
    const r = await put(id, null, 'agent-a@laptop', 'x'.repeat(n));
    assert.equal(r.status, 413, `${n} bytes`);
    assert.match((await r.json()).error, /body too large/);
  }
  assert.equal((await put(id, { text: card(), expected_spec_version: 0 })).status, 200); // the server is fine afterwards
}));

test('over HTTP: warnings are stored and read back; 422 lists every reason checkCard gives', () => withBoard(async ({ id, put, get }) => {
  const { checkCard } = await import('../src/lib/contract.ts');
  const warn = card().replace('size: big\n', '').replace('depends_on: none\n', '');
  let r = await put(id, { text: warn, expected_spec_version: 0 });
  assert.equal(r.status, 200);
  const want = checkCard(warn).warnings;
  assert.equal(want.length, 2);
  assert.deepEqual((await r.json()).warnings, want);
  assert.deepEqual((await (await get(id)).json()).warnings, want);
  assert.equal((await (await put(id, { text: card(), expected_spec_version: 1 })).json()).warnings, undefined);
  const bad = card().replace('tier: 1', 'tier: 9').replace('role: builder', 'role: wizard').replace('deadline: 2026-11-01', 'deadline: soon');
  r = await put(id, { text: bad, expected_spec_version: 2 });
  assert.equal(r.status, 422);
  const body = await r.json();
  assert.deepEqual(body.reasons, checkCard(bad).errors);
  assert.ok(body.reasons.length >= 3);
}));
