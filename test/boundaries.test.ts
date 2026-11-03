// Request body and task frontmatter boundary checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { task, tempRepo } from './helpers.ts';
import { loadBoard } from '../src/lib/load.ts';
import { check } from '../src/lib/check.ts';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
}
async function startServer(root: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DASKS_ROOT: root, DASKS_CONFIG: cfgFile, DASKS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(url + '/api/health'); return { url, proc }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('server did not start');
}
const post = async (url: string, body: unknown, actor = 'claude-code@test') => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': actor }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};

test('write routes: a field of the wrong type is a 400 naming it, and nothing is written', async () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-one' }), task({ id: 'beta.t-two', status: 'doing', claimed_by: 'claude-code@test', claimed_at: '2026-10-10T10:00:00+09:00' })]);
  const { url, proc } = await startServer(root);
  try {
    const head = () => fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8') + fs.readdirSync(path.join(root, '.git', 'refs', 'heads')).join();
    const before = head();
    const cases: [string, unknown, RegExp][] = [
      ['/api/tasks/beta.t-one/reset-attempts', { reason: { why: 'x' } }, /reason must be a string/],
      ['/api/tasks/beta.t-one', { append_block: { heading: 'H', lines: [{ x: 1 }] } }, /append_block must be/],
      ['/api/tasks/beta.t-two/finish', { result: 'did it', pr_summary: ['a', 'b'] }, /pr_summary must be a string/],
      ['/api/captain/chat', { text: { html: '<b>' } }, /text must be a string/],
    ];
    for (const [route, body, msg] of cases) {
      const r = await post(url + route, body);
      assert.equal(r.status, 400, `${route} ${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.json)}`);
      assert.match(r.json.error, msg);
    }
    assert.equal(head(), before);
  } finally { proc.kill(); cleanup(); }
});

test('task files: a frontmatter that is not a Task is a load error, not a card with coerced fields', () => {
  const { root, cleanup } = tempRepo([task({ id: 'beta.t-good' })]);
  try {
    const good = fs.readFileSync(path.join(root, 'data/tasks/beta/t-good.md'), 'utf8');
    const swap = (name: string, field: string, value: string) => fs.writeFileSync(path.join(root, 'data/tasks/beta', `${name}.md`),
      good.replace('id: beta.t-good', `id: beta.${name}`).replace(new RegExp(`^${field}: .*$`, 'm'), `${field}: ${value}`));
    swap('t-badstatus', 'status', 'finished');
    swap('t-listtitle', 'title', '[a, b]');
    swap('t-mapowner', 'owner', '{ name: x }');
    swap('t-badkind', 'kind', 'chore');
    const b = loadBoard(root);
    assert.deepEqual(b.tasks.map((t) => t.id), ['beta.t-good']);
    const errs = Object.fromEntries(b.loadErrors.map((e) => [e.file, e.message]));
    assert.match(errs['data/tasks/beta/t-badstatus.md'], /^not a task: bad status "finished"/);
    assert.match(errs['data/tasks/beta/t-listtitle.md'], /"title" must be one value/);
    assert.match(errs['data/tasks/beta/t-mapowner.md'], /"owner" must be one value/);
    assert.match(errs['data/tasks/beta/t-badkind.md'], /bad kind "chore"/);
    assert.equal(check(b).errors.filter((e) => /not a task/.test(e.message)).length, 4, 'dasks check reports each one');
  } finally { cleanup(); }
});
