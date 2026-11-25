// The one rule for reading a gitleaks run that exited 0 (the runner's push scan and its saved-work scan; bin/dask submit
// keeps the same rule in Python).

/** `git log` words every scan adds to its range: plain `git log -p` prints no patch for a merge commit, so what a merge
 *  itself brings (a conflict resolution, a file added while merging) went unscanned. First-parent diffs give each merge
 *  its patch against the branch it was made on. gitleaks splits --log-opts on spaces. */
export const MERGE_DIFFS = '--diff-merges=first-parent';

/** An exit 0 is clean only with its `N commits scanned` summary line and no error line: gitleaks also exits 0 when its
 *  own `git log` fails (it logs `ERR [git] …`), e.g. for a range base the clone lacks, and then nothing was scanned. A
 *  count of 0 is fine (a delete-only commit adds no line to scan); the callers only scan a range git says is non-empty.
 *  `output` is stdout and stderr together; it is only matched, never logged. */
export function scannedClean(output: string): boolean {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (/(^|\s)(ERR|FTL)\s|\[git\]/m.test(text)) return false;
  const n = /(\d+) commits scanned/.exec(text);
  return !!n;
}
