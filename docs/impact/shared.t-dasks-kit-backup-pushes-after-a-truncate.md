# Impact: backup refuses to push on a cut path listing

- Files: src/lib/proc.ts, src/lib/backup.ts, test/backup.test.ts, docs/upgrade.md.
- Functions: `runBounded` (result gains `truncated?: true`; out and err now stop at exactly maxOut characters, before a
  whole chunk could overshoot it), `Backup` constructor (optional `{ listMaxOut }`, default 64 MiB), `Backup.run()`
  (a cut `git log --name-only` listing is a failed backup, no push).
- Call sites of runBounded: backup.ts, keep-work.ts (16 MiB), codemap/map.ts (256 MiB), rethink.ts, self-update and the
  other default-cap callers. None reads a new key; a result that was not cut has no `truncated` key, so their
  behavior is unchanged except that a cut output is now at most maxOut characters (it could run up to one pipe chunk
  past it before).
- Data flow: the failure reason goes to run/backup.json `last_error` and through backupView to /api/health; it names no
  path, no remote and no git output.
- Risks: a board whose path listing really passes 64 MiB can no longer back up until the history is smaller or the
  cap changes (by design: fail closed; the card keeps the cap).
- Tests: test/backup.test.ts (two new tests; the six existing ones unchanged).
