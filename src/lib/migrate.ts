// Board schema versions (docs/upgrade.md). data/schema.json says which version a board's files follow; dasks-init starts
// a board at SCHEMA_VERSION (a board created before versioning has no file: 0). The server brings a board up to SCHEMA_VERSION at start, one migration
// at a time and in order, after a backup of the whole repo; each migration is one commit, so `git log` shows it and a
// rollback is a git operation. A board newer than this kit is refused: older code must not write a format it does not know.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { commitFiles, git, gitCommonDir, withRepoLock } from './write.ts';

export const SCHEMA_REL = 'data/schema.json';

interface Migration {
  /** The version a board has after this migration. */
  to: number;
  what: string;
  /** The files it writes (repo-relative, under data/), from the board as it is before it. The schema stamp is added. */
  files(root: string): { rel: string; content: string }[];
}

/** In order; never edit one that shipped, add the next. */
export const MIGRATIONS: Migration[] = [
  { to: 1, what: 'stamp the schema version on a board without one', files: () => [] },
  { to: 2, what: 'drop the retired review_verdict, review_pass and review_cap task fields', files: (root) => dropTaskFields(root, ['review_verdict', 'review_pass', 'review_cap']) },
  // No file changes: a card may now have kind bug, which an older kit would not load, so the version moves and an older
  // kit refuses the whole board (and a runner does not update past the board) instead of losing bug cards one by one.
  { to: 3, what: 'cards may have kind bug', files: () => [] },
];

/** Task files under data/tasks/ with these top-level frontmatter keys removed. The frontmatter is edited as a YAML
 *  document (any key quoting or value style, CRLF kept), the body is untouched; a file that does not parse is left as is
 *  for `dasks check` to report. */
export function dropTaskFields(root: string, keys: string[]): { rel: string; content: string }[] {
  const out: { rel: string; content: string }[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith('.md')) {
        const next = withoutKeys(fs.readFileSync(path.join(root, r), 'utf8'), keys);
        if (next !== null) out.push({ rel: r, content: next });
      }
    }
  };
  if (fs.existsSync(path.join(root, 'data/tasks'))) walk('data/tasks');
  return out;
}

/** The file with those frontmatter keys gone, or null when it has none of them, has no readable frontmatter, or the edit
 *  would change any other value (then the file is left as it is and `dasks check` names the field: data is never altered). */
export function withoutKeys(text: string, keys: string[]): string | null {
  const m = /^(﻿?---)(\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$)[\s\S]*)$/.exec(text);
  if (!m) return null;
  try {
    const doc = YAML.parseDocument(m[3]);
    if (doc.errors.length || !YAML.isMap(doc.contents)) return null;
    const original = doc.toJS() as Record<string, unknown>;
    const map = doc.contents;
    const before = map.items.length;
    map.items = map.items.filter((p) => !keys.includes(String(YAML.isScalar(p.key) ? p.key.value : p.key)));
    if (map.items.length === before) return null;
    let fm = doc.toString({ lineWidth: 0 }).replace(/\n$/, '');
    if (m[2] === '\r\n') fm = fm.replace(/\r?\n/g, '\r\n');
    const out = `${m[1]}${m[2]}${fm}${m[4]}`;
    const after = YAML.parse(/^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(out)?.[1] ?? '');
    const expected = Object.fromEntries(Object.entries(original).filter(([k]) => !keys.includes(k)));
    return isDeepStrictEqual(after, expected) && out.endsWith(m[4]) ? out : null;
  } catch { return null; } // e.g. an alias to a removed value: leave the file for a person
}
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].to;

export const schemaContent = (v: number) => JSON.stringify({ schema: v }) + '\n';

/** The board's schema version: 0 without the file. An unreadable file throws: guessing could migrate a board twice. */
export function boardSchema(root: string): number {
  let text: string;
  try { text = fs.readFileSync(path.join(root, SCHEMA_REL), 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return 0; throw e; }
  let v: unknown;
  try { v = JSON.parse(text)?.schema; } catch { v = undefined; }
  if (!Number.isInteger(v) || (v as number) < 1) throw new Error(`${SCHEMA_REL} is unreadable (want {"schema": <version>}); fix it by hand from git history`);
  return v as number;
}

export class SchemaTooNew extends Error {}

export interface MigrateResult { from: number; to: number; backup: string; applied: string[] }

/** Bring the board up to SCHEMA_VERSION. Nothing to do: from === to, no backup. Throws when the board is newer than this
 *  kit, its schema file is unreadable, or a step fails (the steps before it stay committed; the backup has the start). */
export function migrateBoard(root: string, now = new Date()): MigrateResult {
  const from = boardSchema(root);
  if (from > SCHEMA_VERSION) throw new SchemaTooNew(`this board has schema ${from}, newer than this kit (${SCHEMA_VERSION}): upgrade the kit, or restore the board from the backup made before it was migrated (docs/upgrade.md)`);
  if (from === SCHEMA_VERSION) return { from, to: from, backup: '', applied: [] };
  return withRepoLock(root, () => {
    const dir = path.join(gitCommonDir(root), 'dasks-backups');
    fs.mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, `${now.toISOString().replace(/[:.]/g, '-')}-schema-${from}.bundle`);
    // Every ref and all history: `git clone <bundle>` gives the board back as it was before the first step.
    git(root, ['bundle', 'create', '-q', backup, '--all']);
    const applied: string[] = [];
    for (const m of MIGRATIONS.filter((x) => x.to > from)) {
      const files = [...m.files(root).filter((f) => f.rel !== SCHEMA_REL), { rel: SCHEMA_REL, content: schemaContent(m.to) }];
      commitFiles(root, files, `dasks: board schema ${m.to - 1} -> ${m.to} (${m.what})`);
      applied.push(`${m.to}: ${m.what}`);
    }
    return { from, to: SCHEMA_VERSION, backup, applied };
  });
}
