// The one rule for reading a gitleaks run that exited 0 (the runner's push scan and its saved-work scan; bin/dask submit
// keeps the same rule in Python).

/** An exit 0 is clean only when gitleaks says it scanned at least one commit and logged no error: gitleaks also exits 0
 *  when its own `git log` fails (it logs `ERR [git] …` and `0 commits scanned.`), e.g. for a range base the clone lacks,
 *  and then nothing was scanned. `output` is stdout and stderr together; it is only matched, never logged. */
export function scannedClean(output: string): boolean {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (/(^|\s)(ERR|FTL)\s|\[git\]/m.test(text)) return false;
  const n = /(\d+) commits scanned/.exec(text);
  return !!n && Number(n[1]) > 0;
}
