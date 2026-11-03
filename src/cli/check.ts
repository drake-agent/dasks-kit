// Dasks board check CLI: `dasks check [--json]` (also the git pre-commit hook).
import { boardRoot, loadConfig } from '../lib/config.ts';
import { loadBoard } from '../lib/load.ts';
import { check, formatIssues } from '../lib/check.ts';
import { checkViews } from '../lib/views.ts';
import { checkIdeas } from '../lib/ideas.ts';
import { checkLessons } from '../lib/lessons.ts';
import { corruptJournalHelp, corruptJournals } from '../lib/write.ts';
import { backupView, readBackupStatus } from '../lib/backup.ts';

const root = boardRoot();
const cfg = loadConfig(root); // the project list (config.json) is part of what check() checks
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'check') {
  const b = loadBoard(root);
  const r = check(b);
  r.warnings.push(...checkViews(root, b), ...checkIdeas(root, b), ...checkLessons(root, b)); // never errors: a bad view, ideas or lessons file must not block task commits
  const kept = corruptJournals(root);
  if (kept.length) r.errors.push({ file: kept[0], message: corruptJournalHelp(root, kept) });
  const st = readBackupStatus(root);
  const bv = backupView(cfg.backup, st);
  if (bv.warning) r.warnings.push({ file: 'run/backup.json', message: `${bv.warning}: ${st?.last_error ?? ''}` });
  if (rest.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    const s = formatIssues(r);
    if (s) console.log(s);
    console.log(`dasks check: ${r.errors.length} error(s), ${r.warnings.length} warning(s) — ${b.goals.length} goals, ${b.goals.reduce((n, g) => n + g.milestones.length, 0)} milestones, ${b.tasks.length} tasks, ${b.links.length} links`);
  }
  process.exit(r.errors.length ? 1 : 0);
} else {
  console.error('usage: dasks check [--json]');
  process.exit(2);
}
