// The Node security floor: which versions pass, and the installer refusing one that does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nodeProblem } from '../src/lib/node-floor.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('node floor: each supported line needs its security release; other lines are refused', () => {
  for (const ok of ['22.23.4', 'v22.23.5', '22.24.0', '24.22.1', '24.30.0', '26.12.1', '28.0.0']) assert.equal(nodeProblem(ok), null, ok);
  for (const bad of ['22.23.1', '22.22.9', '24.22.0', '24.9.9', '26.8.1', '23.11.0', '25.5.0', '20.19.0', '27.0.0']) assert.ok(nodeProblem(bad), bad);
  assert.match(nodeProblem('22.23.1')!, /22\.23\.4/);
});

test('install.sh refuses a node without its security fixes unless DASKS_ALLOW_UNPATCHED_NODE=1', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dasks-nodefloor-'));
  const bin = path.join(home, 'bin');
  try {
    fs.mkdirSync(bin);
    // A node that reports an unpatched version but otherwise runs the real one.
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/bash\nexec "${process.execPath}" --import "data:text/javascript,Object.defineProperty(process.versions,'node',{value:'22.23.1'})" "$@"\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
    delete env.DASKS_ALLOW_UNPATCHED_NODE;
    const run = (e: NodeJS.ProcessEnv) => spawnSync('bash', [path.join(ROOT, 'install.sh'), '--dry-run', '--no-claude-mcp', '--no-codex-mcp'], { env: e, encoding: 'utf8' });
    const refused = run(env);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /lacks security fixes in 22\.23\.4/);
    const allowed = run({ ...env, DASKS_ALLOW_UNPATCHED_NODE: '1' });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /without its security fixes/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
