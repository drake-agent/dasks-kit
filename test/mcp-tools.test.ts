// MCP tool listing snapshot and size budget. Refresh after a deliberate change: UPDATE_MCP_SNAPSHOT=1 node --test test/mcp-tools.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const MCP = path.join(ROOT, 'mcp/dasks-mcp.mjs');
const SNAPSHOT = path.join(ROOT, 'test/fixtures/mcp-tools.snapshot.json');
export const BUDGET = { total: 33_000, perTool: 3_300, specTools: 3_000 };

/** tools/list from a fresh MCP process (no board needed: the listing is static). */
export function listTools(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [MCP], { env: { ...process.env, DASKS_URL: 'http://127.0.0.1:9', DASKS_ACTOR: 'claude-code@laptop' }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += d; const i = buf.indexOf('\n');
      if (i < 0) return;
      const m = JSON.parse(buf.slice(0, i));
      proc.kill();
      m.result ? resolve(m.result.tools) : reject(new Error(JSON.stringify(m.error)));
    });
    proc.on('error', reject);
    proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  });
}
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** The budget check on its own, so the test can show it fails on an oversized listing. */
export function budgetProblems(tools: any[]): string[] {
  const out: string[] = [];
  const total = bytes(tools);
  if (total > BUDGET.total) out.push(`tools/list is ${total} bytes (budget ${BUDGET.total})`);
  for (const t of tools) if (bytes(t) > BUDGET.perTool) out.push(`${t.name} is ${bytes(t)} bytes (budget ${BUDGET.perTool} per tool)`);
  const spec = tools.filter((t) => t.name === 'get_spec' || t.name === 'put_spec');
  const sb = spec.reduce((n, t) => n + bytes(t), 0);
  if (sb > BUDGET.specTools) out.push(`get_spec + put_spec are ${sb} bytes (budget ${BUDGET.specTools})`);
  return out;
}

test('mcp tools: the listing matches the committed snapshot', async () => {
  const tools = await listTools();
  if (process.env.UPDATE_MCP_SNAPSHOT === '1') fs.writeFileSync(SNAPSHOT, JSON.stringify(tools, null, 1) + '\n');
  assert.deepEqual(tools, JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')), 'tools/list changed: review it, then UPDATE_MCP_SNAPSHOT=1');
});

test('mcp tools: the live listing is inside the byte budget (total, per tool, the two spec tools)', async () => {
  const tools = await listTools();
  for (const n of ['get_spec', 'put_spec']) assert.ok(tools.some((t) => t.name === n), `${n} is listed`);
  assert.deepEqual(budgetProblems(tools), []);
});

test('mcp tools: a description grown past the budget fails the budget check, whatever the snapshot says', async () => {
  const tools = await listTools();
  const grown = tools.map((t) => (t.name === 'put_spec' ? { ...t, description: t.description + ' x'.repeat(1_700) } : t));
  const problems = budgetProblems(grown);
  assert.ok(problems.some((p) => p.startsWith('put_spec is')), problems.join('; '));
  assert.ok(problems.some((p) => p.startsWith('get_spec + put_spec')), problems.join('; '));
  const fat = tools.map((t, i) => (i === 0 ? { ...t, description: t.description + 'y'.repeat(4_000) } : t));
  assert.ok(budgetProblems(fat).some((p) => p.startsWith('tools/list is')));
});
