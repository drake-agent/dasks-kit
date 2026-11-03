// Project profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import YAML from 'yaml';
import { check } from '../src/lib/check.ts';
import { loadBoard } from '../src/lib/load.ts';
import { cleanProfileInput, MAX_PROFILE_ITEMS } from '../src/lib/profile.ts';
import { updateNode } from '../src/lib/write.ts';
import { validateView } from '../src/lib/view-config.ts';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const P = {
  features: [{ area: 'Contact', text: 'The contact form sends a mail to the team', ref: 'docs/contact.md' }],
  gaps: [{ text: 'No spam filter on the form', must: true, why: 'bots fill the inbox' }, { text: 'Dark mode', must: false }],
};
const goalFile = (root: string, id: string) => path.join(root, `data/goals/${id}.yaml`);
const goalOf = (root: string, id: string) => loadBoard(root).goals.find((x) => x.id === id)!;

test('profile input: shapes, caps and unknown keys', () => {
  assert.deepEqual(cleanProfileInput({ features: [{ area: ' a ', text: ' b ', ref: '' }], gaps: [] }), { features: [{ area: 'a', text: 'b' }], gaps: [] });
  const bad: [unknown, RegExp][] = [
    [null, /features, gaps/],
    [{ features: [], gaps: [] }, /at least one/],
    [{ features: 'x' }, /must be a list/],
    [{ features: [{ area: 'a' }] }, /text is missing/],
    [{ features: [{ area: 'x'.repeat(41), text: 'b' }] }, /at most 40/],
    [{ features: [{ area: 'a', text: 'b\nc' }] }, /one line/],
    [{ features: [{ area: 'a', text: 'b', extra: 1 }] }, /not a feature field/],
    [{ gaps: [{ text: 'a', must: 'yes' }] }, /true or false/],
    [{ gaps: [{ text: 'a' }] }, /true or false/],
    [{ features: Array.from({ length: MAX_PROFILE_ITEMS + 1 }, () => ({ area: 'a', text: 'b' })) }, /at most 10/],
    [{ features: [], gaps: [], vision: 'x' }, /not a profile field/],
  ];
  for (const [v, re] of bad) assert.throws(() => cleanProfileInput(v), re, JSON.stringify(v));
});

test('node update: the server stamps as_of and by, replaces the whole block, null removes it, bad input is a 400', () => {
  const { root, cleanup } = tempRepo();
  try {
    updateNode(root, 'beta', { profile: { ...P, as_of: '1999-01-01', by: 'forged' }, why: 'the company website' }, 'claude-code@desktop');
    let g = goalOf(root, 'beta');
    assert.equal(g.why, 'the company website');
    assert.equal(g.profile!.by, 'claude-code@desktop', 'by is the writer, not what it sent');
    assert.notEqual(g.profile!.as_of, '1999-01-01');
    assert.deepEqual(g.profile!.gaps, P.gaps);
    assert.deepEqual(check(loadBoard(root)).errors.filter((i) => i.file.includes('beta')), [], 'a written profile passes the board check');
    assert.match(execFileSync('git', ['-C', root, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /^claude-code@desktop: beta (why, profile|profile, why)/, 'one commit for both');

    updateNode(root, 'beta', { profile: { features: [], gaps: [{ text: 'only this', must: false }] } }, 'codex@desktop');
    g = goalOf(root, 'beta');
    assert.deepEqual([g.profile!.features, g.profile!.gaps.length, g.profile!.by], [[], 1, 'codex@desktop'], 'replaced, not merged');

    assert.throws(() => updateNode(root, 'beta', { profile: { features: [{ area: 'a' }] } }, 'x'), (e: any) => e.status === 400 && /text is missing/.test(e.message));
    assert.throws(() => updateNode(root, 'beta.m1', { profile: P }, 'x'), (e: any) => e.status === 400, 'milestones have no profile');
    assert.throws(() => updateNode(root, 'north', { profile: P }, 'x'), (e: any) => e.status === 400, 'nor has the north star');

    updateNode(root, 'beta', { profile: null }, 'x');
    assert.equal(goalOf(root, 'beta').profile, undefined);
    assert.ok(!fs.readFileSync(goalFile(root, 'beta'), 'utf8').includes('profile'));
  } finally { cleanup(); }
});

test('board check reports a hand-edited bad profile', () => {
  const { root, cleanup } = tempRepo();
  try {
    const f = goalFile(root, 'gamma');
    const doc = YAML.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, YAML.stringify({ ...doc, profile: { as_of: '2026-11-02', by: 'x', features: [{ area: 'a' }], gaps: [] } }));
    assert.ok(check(loadBoard(root)).errors.some((i) => i.file === 'data/goals/gamma.yaml' && /text is missing/.test(i.message)));
    fs.writeFileSync(f, YAML.stringify({ ...doc, profile: { features: [{ area: 'a', text: 'b' }], gaps: [] } }));
    assert.ok(check(loadBoard(root)).errors.some((i) => i.file === 'data/goals/gamma.yaml' && /as_of is missing/.test(i.message)), 'stamps are required on disk');
  } finally { cleanup(); }
});

test('a project page view may place the profile widget; the page shows it after the stat cards otherwise', () => {
  assert.equal(validateView('beta', { widgets: [{ type: 'profile' }] }, new Set()).widgets[0].type, 'profile');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.match(app, /g\?\.profile && !widgets\.some\(\(w\) => w\.type === 'profile'\)/);
  assert.match(app, /^ {2}profile\(w, g\) \{/m, 'the widget renders');
  const dict = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
  for (const k of ['profile', 'profile.features', 'profile.gaps', 'profile.must', 'profile.later', 'profile.none', 'profile.meta']) assert.equal(dict.split(`'${k}'`).length - 1, 2, `${k} in en and ko`);
});

function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on('error', rej); });
}
const stopped = (p: ChildProcess) => new Promise<void>((res) => { if (p.exitCode !== null || p.signalCode !== null) return res(); p.once('exit', () => res()); p.kill(); });

test('HTTP, CLI and MCP: profile set writes profile and why in one commit; profile, get_profile and list_goals read it back', async () => {
  const { root, cleanup } = tempRepo();
  const port = await freePort();
  const cfgFile = path.join(root, 'test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { hosts: ['127.0.0.1'], port } }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-home-'));
  const clean = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DASKS?_/.test(k))), HOME: home };
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/server.ts')], { env: { ...clean, DASKS_ROOT: root, DASKS_CONFIG: cfgFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  // Agent tokens are on by default: issue one in the throwaway HOME, as install.sh does.
  const token = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'bin/dasks-tokens.ts'), 'issue', '*'], { env: { ...clean, DASKS_ROOT: root }, encoding: 'utf8' }).trim();
  const env = { ...clean, DASKS_URL: url, DASKS_ACTOR: 'claude-code@desktop', DASKS_TOKEN: token };
  const m = spawn(process.execPath, [path.join(ROOT, 'mcp/dasks-mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    let buf = ''; let next = 1; const waiting = new Map<number, (v: any) => void>();
    m.stdout!.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const x = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(x.id)?.(x); waiting.delete(x.id); } });
    const rpc = (method: string, params: any = {}) => new Promise<any>((res) => { const id = next++; waiting.set(id, res); m.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const call = async (name: string, args: any) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { err: !!r.isError, text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() }; };
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const cli = (args: string[], input?: string) => {
      try { return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'mcp/board-cli.mjs'), ...args], { env, encoding: 'utf8', stdio: 'pipe', input }) }; }
      catch (e: any) { return { code: e.status as number, out: String(e.stdout) + String(e.stderr) }; }
    };
    assert.equal(JSON.parse(cli(['profile', 'beta']).out).profile, null);
    const s = cli(['profile', 'set', 'beta', '-'], JSON.stringify({ profile: P, why: 'the company website' }));
    assert.equal(s.code, 0, s.out);
    assert.match(s.out, /beta profile 1 feature\(s\), 2 gap\(s\) \(claude-code@desktop/);
    const gp = JSON.parse(cli(['profile', 'beta']).out);
    assert.equal(gp.why, 'the company website');
    assert.equal(gp.profile.by, 'claude-code@desktop');
    assert.deepEqual(gp.profile.features, P.features);
    assert.match((await call('list_goals', {})).json.goals.find((g: any) => g.app === 'beta').profile_as_of, /^\d{4}-\d{2}-\d{2}/);
    assert.notEqual(cli(['profile', 'set', 'beta', '-'], JSON.stringify({ profile: { features: [{ area: 'a' }] } })).code, 0, 'a bad profile is refused');
    assert.notEqual(cli(['profile', 'set', 'beta', '-'], JSON.stringify({ why: 'x' })).code, 0, 'the file must say profile');

    // MCP: set_profile replaces it and answers with the new profile; get_profile reads it.
    const set = await call('set_profile', { app: 'gamma', profile: { features: [], gaps: [{ text: 'tests for the importer', must: true }] }, why: 'import everything' });
    assert.equal(set.err, false, set.text);
    assert.equal(set.json.profile.gaps[0].text, 'tests for the importer');
    const got = await call('get_profile', { app: 'gamma' });
    assert.deepEqual([got.json.why, got.json.profile.by], ['import everything', 'claude-code@desktop']);
    const refused = await call('set_profile', { app: 'gamma', profile: { features: [{ area: 'a' }] } });
    assert.equal(refused.err, true);
    assert.match(refused.text, /text is missing/);
    assert.equal((await call('set_profile', { app: 'gamma', profile: null })).json.profile, null);
    assert.equal(cli(['profile', 'set', 'beta', '-'], JSON.stringify({ profile: null })).code, 0);
    assert.equal(JSON.parse(cli(['profile', 'beta']).out).profile, null);
  } finally { await stopped(m); await stopped(srv); cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});
