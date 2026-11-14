# Impact map: shared.t-kit-merge-gate-decides-a-merge-from-deco

## Files and functions
- `bin/dask-merge-gate`
  - `main()`: no longer exits early on the raw text (`MERGE_TEXT` and the substring `gh`); every command goes through
    `decide()`. A crash in the reader refuses (exit 2) instead of exiting 1, which Claude Code would let run.
  - new `Reader` (`commands`, `word`, `dquote`, `expansion`, `braced`, `backtick`, `ansi_c`, `heredoc_bodies`) and
    `read()`: split the text into simple commands, decode words like bash's quote removal, mark unknowable words.
  - new `fail_closed()` and `decide()`: the rules of the card's Handoff (unreadable gh words, gh-like unreadable command
    words, wrappers, compound commands, the read-only list, NAME=value prefixes, redirects, line continuations).
  - `target()`: now takes the decoded words instead of re-reading the text; its repo and PR-selector reading is unchanged.
  - removed `words_of()` (shlex) and the `shlex` import.
  - unchanged: `refuse()`, `gh()`, the board `merge-ok` call, `MERGE_TEXT`, `INDIRECT` (now only picks the refusal reason).
- `test/kit.test.ts`: new test `merge gate: a merge is decided from decoded shell words of each simple command`; the two
  existing merge-gate tests are unchanged.
- `CHANGELOG.md`: one line under Unreleased.

## Call sites and data flow
- The one caller is Claude Code's PreToolUse hook on Bash, added to `~/.claude/settings.json` by
  `install.sh --with-merge-gate` (`helper gate add`). Hook JSON on stdin → `decide()` → not a merge: exit 0 silent;
  a merge: `target()` → `gh pr view … --json` → board `GET /api/merge-ok` → exit 0 or exit 2 with the reason.
- install.sh, the board API and the fleet-lanes copy of the gate are not touched.

## Tests
- `node --test --test-name-pattern='merge gate' test/kit.test.ts` (3 tests), `npm run verify`.
- Built by hand, not in CI: a bash differential of the decoded words and a random-input run (no reader crash).

## Risks
- Approval hole: a spelling the reader decodes differently from bash. Mitigated by failing closed on anything it does
  not fully know (expansions, globs, `$"…"`, unknown or version-dependent escapes, non-ASCII bytes) and the differential.
- Agents stalled: a new refusal on ordinary commands. New refusals need gh-like words next to unreadable ones (a
  variable or glob as the command word followed by `pr`/`api`/merge text, `gh $X …`, a wrapper with such words), or a
  compound command whose parts mention a merge (as on main).
- Every Bash call now runs the reader (pure Python, no subprocess for non-merges).
