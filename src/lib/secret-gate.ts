// The runner's secrets pre-check (docs/secrets.md). A card can name the secrets its work needs (`secrets: a, b`, names
// only). Before the runner starts such a card it asks `dasks-secret check` whether every label is stored and allowed for
// the agent that would build it. If not, the card is not started: one message on the card tells the human the exact
// commands to run (labels and commands, never values), and the runner moves on. The check never prompts and never
// reads a value; `dasks-secret run` is what asks the human, later, inside the agent's session.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export type SecretTool = 'claude' | 'codex';

/** The agent name dasks-secret knows for a runner tool. */
export const secretAgent = (tool: SecretTool): string => (tool === 'claude' ? 'claude-code' : 'codex');

export function secretLabels(v: unknown): string[] {
  return String(v ?? '').split(/[\s,]+/).filter(Boolean);
}

export interface SecretCheck { ready: boolean; missing: string[]; notAllowed: string[]; problem?: string }

/** Runs `dasks-secret check --labels … --json --agent …` (no prompt). A missing binary or a bad answer is not ready. */
export function checkSecrets(bin: string | null, labels: string[], agent: string): SecretCheck {
  if (!bin) return { ready: false, missing: [], notAllowed: [], problem: 'dasks-secret is not installed on this Mac (./install.sh --with-secrets)' };
  const r = spawnSync(bin, ['check', '--labels', labels.join(','), '--json', '--agent', agent], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0 && r.status !== 10) return { ready: false, missing: [], notAllowed: [], problem: `dasks-secret check failed (${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 200)})` };
  try {
    const j = JSON.parse(r.stdout);
    const rows: any[] = Array.isArray(j.labels) ? j.labels : [];
    const missing = rows.filter((x) => !x.stored).map((x) => String(x.label));
    const notAllowed = rows.filter((x) => x.stored && x.allowed !== true).map((x) => String(x.label));
    const seen = new Set(rows.map((x) => String(x.label)));
    for (const l of labels) if (!seen.has(l)) missing.push(l);
    return { ready: j.ready === true && !missing.length && !notAllowed.length, missing, notAllowed };
  } catch { return { ready: false, missing: [], notAllowed: [], problem: 'dasks-secret check gave no JSON' }; }
}

/** What the human must run, one command per line: store what is missing, then allow the agent. */
export function humanCommands(c: SecretCheck, agent: string): string[] {
  return [
    ...c.missing.map((l) => `dasks-secret store --label ${l}`),
    ...[...c.missing, ...c.notAllowed].map((l) => `dasks-secret allow --label ${l} --agent ${agent}`),
  ];
}

export function secretNote(c: SecretCheck, agent: string, labels: string[], machine: string): string {
  const lines = [`The runner on ${machine} did not start this card: it needs the secrets ${labels.join(', ')} and ${agent} cannot use them yet.`];
  if (c.problem) lines.push(c.problem + '.');
  if (c.missing.length) lines.push(`Not stored: ${c.missing.join(', ')}.`);
  if (c.notAllowed.length) lines.push(`Not allowed for ${agent}: ${c.notAllowed.join(', ')}.`);
  const cmds = humanCommands(c.problem ? { ...c, missing: labels } : c, agent);
  lines.push('The human runs, in their own terminal on that Mac (values go only into the native window, never into chat):', ...cmds.map((x) => '  ' + x));
  lines.push('The runner tries again on its next look.');
  return lines.join('\n');
}

export interface GateEnv {
  api: (method: string, route: string, body?: unknown, as?: string) => Promise<any>;
  which: (cmd: string) => string | null;
  machine: string;
}

/** null = start the card; otherwise the one-line reason it was not started (the card got a message saying what to do). */
export async function secretGate(env: GateEnv, card: string, tool: SecretTool): Promise<string | null> {
  let labels: string[];
  // A lookup that fails is never "no secrets": skip the card this look and try again on the next one.
  try { labels = secretLabels((await env.api('GET', `/api/tasks/${card}?log=0`))?.secrets); }
  catch (e: any) { return `could not read the card's secrets (${String(e?.message ?? e).slice(0, 200)}); skipped this look`; }
  if (!labels.length) return null;
  const agent = secretAgent(tool);
  const c = checkSecrets(env.which('dasks-secret'), labels, agent);
  if (c.ready) return null;
  const text = secretNote(c, agent, labels, env.machine);
  // The same note twice is one message: the request id is a hash of the card and the text.
  const request_id = 'secrets-' + createHash('sha256').update(card + '\n' + text).digest('hex').slice(0, 24);
  try { await env.api('POST', `/api/tasks/${card}/messages`, { request_id, to: 'human', kind: 'blocked-on', text }); } catch { /* the log line still says it */ }
  return c.problem ? c.problem : `secrets not ready for ${agent} (${[...c.missing.map((l) => `${l} not stored`), ...c.notAllowed.map((l) => `${l} not allowed`)].join(', ')})`;
}
