// dasks-init: create a fresh board data repo (install.sh runs it). Never overwrites: a root that already holds a board
// (data/northstar.yaml) is left alone, except that an explicit --port updates config.json's server.port; any other
// non-empty folder is refused. The board is built and committed in a temp folder next to the root, then moved in.
//   node src/cli/init.ts --root ~/.dasks/data [--port 4747]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { serializeTask } from '../lib/write.ts';
import { loadBoard } from '../lib/load.ts';
import { check, formatIssues } from '../lib/check.ts';
import { loadConfig } from '../lib/config.ts';
import { schemaContent, SCHEMA_REL, SCHEMA_VERSION } from '../lib/migrate.ts';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const root = arg('--root');
const portArg = arg('--port');
if (!root) { console.error('usage: node src/cli/init.ts --root DIR [--port N]'); process.exit(2); }
const port = portArg === undefined ? 4747 : Number(portArg);
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('--port must be 1024-65535'); process.exit(2); }

const cfgFile = path.join(root, 'config.json');
if (fs.existsSync(path.join(root, 'data', 'northstar.yaml'))) {
  if (portArg !== undefined) {
    const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
    if (cfg.server?.port !== port) {
      cfg.server = { ...(cfg.server ?? {}), port };
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
      console.log(`board exists at ${root}; server.port set to ${port}`);
    } else console.log(`board exists at ${root}; left as it is`);
  } else console.log(`board exists at ${root}; left as it is`);
  process.exit(0);
}
if (fs.existsSync(root) && (!fs.statSync(root).isDirectory() || fs.readdirSync(root).length)) {
  console.error(`init: ${root} exists and is not a Dasks board (no data/northstar.yaml); nothing changed. Pick an empty or new folder.`);
  process.exit(1);
}
const build = `${root.replace(/\/+$/, '')}.init-${process.pid}`;
fs.rmSync(build, { recursive: true, force: true });

const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const off = -now.getTimezoneOffset();
const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
const files: Record<string, string> = {
  'config.json': JSON.stringify({
    server: { hosts: ['127.0.0.1'], port },
    projects: [{ id: 'demo', name: 'Demo' }],
    lanes: [],
  }, null, 2) + '\n',
  '.gitignore': 'run/\n',
  'data/northstar.yaml': YAML.stringify({ id: 'north', title: 'Our north star (edit me)', why: 'Why all of this work matters, in one line.', horizon: 'This year' }),
  'data/goals/demo.yaml': YAML.stringify({
    id: 'demo', parent: 'north', title: 'Demo', why: 'A sample project to try the board. Rename it or add your own in config.json.', owner: 'user',
    milestones: [{ id: 'demo.m1', title: 'First steps', done_criteria: ['The first card is done'], due: '', status: 'active' }],
  }),
  'data/links.yaml': '[]\n',
  [SCHEMA_REL]: schemaContent(SCHEMA_VERSION),
  'data/tasks/demo/t-hello.md': serializeTask({
    id: 'demo.t-hello', title: 'Try the board: claim this card and finish it', goal: 'demo', milestone: 'demo.m1', owner: 'user', lane: 'none',
    kind: 'impl', status: 'todo', priority: 'p2', pr_summary: '', result: '', needs_user: '', approvals: 'none', created: iso, updated: iso, started_by: 'user',
    body: '\n## About\nA sample card. Ask an agent: "claim demo.t-hello on Dasks, say hello in a card message, then finish it".\n\n## Done criteria\n- The card has a message and is done.\n',
  }),
};
try {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(build, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  loadConfig(build);
  const r = check(loadBoard(build));
  if (r.errors.length) throw new Error(formatIssues(r));
  const git = (...a: string[]) => execFileSync('git', ['-C', build, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  // The board commits as itself; the user's global git identity is not needed (or changed).
  git('config', 'user.name', 'Dasks board'); git('config', 'user.email', 'board@dasks.invalid');
  git('add', '--', ...Object.keys(files)); git('commit', '-qm', 'dasks: new board');
  if (fs.existsSync(root)) fs.rmdirSync(root);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.renameSync(build, root);
} catch (e: any) {
  fs.rmSync(build, { recursive: true, force: true });
  console.error(`init: ${e.message}`);
  process.exit(1);
}
console.log(`board created at ${root} (project demo, one example card)`);
