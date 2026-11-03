// dasks-digest: append state changes since the last run to data/digest/YYYY-MM-DD.md (committed).
//   dasks-digest            run and commit
//   dasks-digest --since <iso>   print changes since a time (no write), same text as GET /api/digest
import { boardRoot, loadConfig } from '../lib/config.ts';
import { digestText, runDigest } from '../lib/digest.ts';

const root = boardRoot();
loadConfig(root); // the project list (config.json) is part of what check() checks
const i = process.argv.indexOf('--since');
if (i >= 0) {
  const since = process.argv[i + 1];
  if (!since || Number.isNaN(Date.parse(since))) { console.error('usage: dasks-digest --since <iso>'); process.exit(2); }
  process.stdout.write(digestText(root, since));
} else {
  const r = runDigest(root);
  console.log(r.skipped ? `dasks-digest: no state changes since last run` : `dasks-digest: ${r.count} change(s) -> ${r.file}`);
}
