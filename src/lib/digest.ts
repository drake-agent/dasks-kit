// State-change digest from git history: only status changes, grouped by app, one line each.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { loadBoard, parseFrontmatter } from './load.ts';
import { loadConfig } from './config.ts';
import { stuckReport, STUCK_REASONS } from './stuck.ts';
import { commitFiles, git, GIT_BOUND, isoLocal, withRepoLock } from './write.ts';

export interface DigestLine { app: string; ts: string; text: string }

/** Many `<rev>:<path>` blobs in ONE git process (`cat-file --batch`), not one process per file. Missing blobs (added/deleted files, the root commit's parent) map to null. */
function showFiles(root: string, specs: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const uniq = [...new Set(specs)].filter((x) => !/[\r\n]/.test(x));
  if (!uniq.length) return out;
  const buf = execFileSync('git', ['-C', root, 'cat-file', '--batch'], { input: uniq.join('\n') + '\n', maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...GIT_BOUND });
  let pos = 0;
  for (const spec of uniq) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) { out.set(spec, null); continue; } // "<spec> missing"
    const size = Number(m[2]);
    out.set(spec, m[1] === 'blob' ? buf.subarray(pos, pos + size).toString('utf8') : null);
    pos += size + 1;
  }
  return out;
}

/** The "- (N older notes: …)" line a task keeps when old notes move to data/notes/: not a note itself. */
const ARCHIVE_MARKER = /^- \(\d+ older notes: /;

function taskState(text: string | null): { status: string; title: string; notes: string[] } | null {
  if (text === null) return null;
  try {
    const { fm, body } = parseFrontmatter(text);
    const notes = (/^## Notes\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)?.[1] ?? '').split('\n').filter((l) => l.startsWith('- ') && !ARCHIVE_MARKER.test(l));
    return { status: String(fm.status ?? ''), title: String(fm.title ?? ''), notes };
  } catch { return null; }
}

function milestoneStatusMap(text: string | null): Map<string, { status: string; title: string }> {
  const out = new Map<string, { status: string; title: string }>();
  if (text === null) return out;
  try {
    const g = YAML.parse(text) as any;
    for (const m of g?.milestones ?? []) out.set(String(m?.id), { status: String(m?.status ?? ''), title: String(m?.title ?? '') });
  } catch { /* unparseable revision: skip */ }
  return out;
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Collect status changes after `since` (a commit sha, or an ISO time). */
export function collectChanges(root: string, since: { rev?: string; iso?: string }): { lines: DigestLine[]; head: string } {
  let head = '';
  try { head = git(root, ['rev-parse', 'HEAD']).trim(); } catch { return { lines: [], head }; }
  // The walk ends at the HEAD captured above (not "HEAD"), so a commit landing meanwhile is left for the next run.
  const args = ['log', '--reverse', '--no-renames', '--format=%x1e%H%x1f%aI%x1f%s', '--name-status'];
  if (since.rev) {
    if (!/^[0-9a-f]{7,40}$/.test(since.rev)) throw new Error('bad rev');
    args.push(`${since.rev}..${head}`);
  } else {
    if (since.iso) {
      if (Number.isNaN(Date.parse(since.iso))) throw new Error('bad since');
      args.push(`--since=${new Date(since.iso).toISOString()}`);
    }
    args.push(head);
  }
  args.push('--', 'data/tasks', 'data/goals');
  const out = git(root, args);
  const changes: { sha: string; ts: string; actor: string; op: string; file: string }[] = [];
  for (const rec of out.split('\x1e').slice(1)) {
    const [hdr, ...rest] = rec.split('\n');
    const [sha, ts, subject] = hdr.split('\x1f');
    const actor = /^([A-Za-z0-9._@-]{1,40}):/.exec(subject ?? '')?.[1] ?? 'unknown';
    for (const l of rest) {
      const m = /^([AMD])\t(.+)$/.exec(l.trim());
      if (m && ((m[2].startsWith('data/tasks/') && m[2].endsWith('.md')) || (m[2].startsWith('data/goals/') && m[2].endsWith('.yaml'))))
        changes.push({ sha, ts, actor, op: m[1], file: m[2] });
    }
  }
  const blobs = showFiles(root, changes.flatMap((c) => [...(c.op === 'A' ? [] : [`${c.sha}^:${c.file}`]), ...(c.op === 'D' ? [] : [`${c.sha}:${c.file}`])]));
  const blob = (spec: string) => blobs.get(spec) ?? null;
  const lines: DigestLine[] = [];
  for (const { sha, ts, actor, op, file } of changes) {
    if (file.startsWith('data/tasks/')) {
      const before = op === 'A' ? null : taskState(blob(`${sha}^:${file}`));
      const after = op === 'D' ? null : taskState(blob(`${sha}:${file}`));
      const app = file.split('/')[2];
      const id = `${app}.${path.basename(file, '.md')}`;
      if (!before && after) lines.push({ app, ts, text: `${hhmm(ts)} ${id} new (${after.status}) "${short(after.title)}" (${actor})` });
      else if (before && !after) lines.push({ app, ts, text: `${hhmm(ts)} ${id} removed (was ${before.status}) (${actor})` });
      else if (before && after && before.status !== after.status)
        lines.push({ app, ts, text: `${hhmm(ts)} ${id} ${before.status} -> ${after.status} "${short(after.title)}" (${actor})` });
      // Notes added (comments, "approved (merge)", agent refusals): a digest reader sees them without opening the card.
      // New = not among the notes before (old notes may have moved to data/notes/ in the same commit).
      if (before && after) {
        const had = new Set(before.notes);
        for (const n of after.notes.filter((x) => !had.has(x)))
          lines.push({ app, ts, text: `${hhmm(ts)} ${id} note: ${short(n.slice(2).replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /, ''), 200)}` });
      }
    } else {
      const app = path.basename(file, '.yaml');
      const b = milestoneStatusMap(op === 'A' ? null : blob(`${sha}^:${file}`));
      const a = milestoneStatusMap(op === 'D' ? null : blob(`${sha}:${file}`));
      for (const [id, st] of a) {
        const p = b.get(id);
        if (p && p.status !== st.status) lines.push({ app, ts, text: `${hhmm(ts)} ${id} milestone ${p.status} -> ${st.status} "${short(st.title)}" (${actor})` });
        else if (!p && op !== 'A') lines.push({ app, ts, text: `${hhmm(ts)} ${id} milestone new (${st.status}) (${actor})` });
      }
    }
  }
  return { lines, head };
}

export function formatDigest(lines: DigestLine[], header: string): string {
  const byApp = new Map<string, string[]>();
  for (const l of lines) byApp.set(l.app, [...(byApp.get(l.app) ?? []), l.text]);
  const out = [`## ${header}`];
  if (!lines.length) out.push('', '(no state changes)');
  for (const app of [...byApp.keys()].sort()) {
    out.push('', `### ${app}`);
    for (const t of byApp.get(app)!) out.push(`- ${t}`);
  }
  return out.join('\n') + '\n';
}

function stuckDigest(root: string, now: Date): string {
  const r = stuckReport(loadBoard(root), now, loadConfig(root).stuck);
  return `Stuck: ${r.total} (${STUCK_REASONS.map((reason) => `${reason} ${r.counts[reason]}`).join(', ')})\n`
    + r.unblockers.map((t) => `- Unblock ${t.id}: ${short(t.title.replace(/[\r\n]/g, ' '))} (${t.unblocks} dependants)\n`).join('');
}

export function digestText(root: string, sinceIso: string): string {
  const { lines } = collectChanges(root, { iso: sinceIso });
  return formatDigest(lines, `changes since ${sinceIso}`) + '\n' + stuckDigest(root, new Date());
}

export const LAST_RUN_FILE = 'data/digest/.last-run';

/** dasks-digest: append changes since the last run to data/digest/YYYY-MM-DD.md and commit. */
export function runDigest(root: string, now = new Date()): { file: string; count: number; skipped: boolean } {
  // Walking the history takes a while and the history it reads never changes: do it before
  // taking the repo lock, so writers are not held up. Under the lock, check no other digest ran meanwhile.
  const lastFile = path.join(root, LAST_RUN_FILE);
  const readLast = () => (fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8').trim() : '');
  const last = readLast();
  const since = last ? { rev: last } : { iso: new Date(now.getTime() - 24 * 3600_000).toISOString() };
  const { lines, head } = collectChanges(root, since);
  return withRepoLock(root, () => {
    if (readLast() !== last) return { file: `data/digest/${isoLocal(now).slice(0, 10)}.md`, count: 0, skipped: true };
    const day = isoLocal(now).slice(0, 10);
    const rel = `data/digest/${day}.md`;
    const abs = path.join(root, rel);
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : `# Dasks digest ${day}\n`;
    const attention = stuckDigest(root, now);
    const previousAttention = prev.slice(prev.lastIndexOf('\nStuck:') + 1).trim();
    if (!lines.length && (process.env.DASKS_STUCK_DIGEST_REFRESH !== '1' || previousAttention === attention.trim())) return { file: rel, count: 0, skipped: true };
    const header = `${isoLocal(now).slice(0, 16).replace('T', ' ')} — ${lines.length} change(s) since ${last ? last.slice(0, 8) : since.iso}`;
    const content = prev.replace(/\s*$/, '\n\n') + formatDigest(lines, header) + '\n' + attention;
    commitFiles(root, [{ rel, content }, { rel: LAST_RUN_FILE, content: head + '\n' }], `digest: ${lines.length} change(s) -> ${rel}`);
    return { file: rel, count: lines.length, skipped: false };
  }, 30000);
}
