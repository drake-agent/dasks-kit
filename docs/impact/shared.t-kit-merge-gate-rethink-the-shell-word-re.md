# Impact map: shared.t-kit-merge-gate-rethink-the-shell-word-re

Builds on #8's reader (launch base f5a9bfc). #8's impact file stays: it maps the reader this card changes.

## Files and functions
- `bin/dask-merge-gate`
  - `Reader.braced(open_, close, dq)`: now knows whether the `${…}` / `$[…]` stands inside `"…"`.
    - outside `"…"`: a `'…'` quotes; it is skipped (nothing in it runs); an unclosed one is unreadable.
    - inside `"…"`: bash 3.2 pairs the quotes but runs the substitutions inside (R2), so the text in the pair is read
      for substitutions; a `"` in the pair is unreadable (where the `"…"` ends depends on the bash version); a lone `'`
      is plain text.
    - a bare open bracket: bash 3.2 does not nest `{` in `${…}` but nests `[` in `$[…]`. Both readings are taken; the
      text between the two possible ends must be plain (no blank, separator, quote, `$`, backtick, backslash or `#`),
      else unreadable. With no nested close, the expansion ends at the first close.
    - `<(…)` / `>(…)` inside `${…}` / `$[…]` are read as commands (review R1).
    - in `$[…]` a `'…'` never hides a substitution (review R2).
  - `Reader.quoted_runs(body)`: reads the substitutions of a `'…'` that bash still runs.
  - `Reader.word(cmd, arith)`: in `((…))` / `$((…))` a `'…'` is read for substitutions, not skipped (review R2).
  - `Reader.expansion(dq)`: passes the context on; `dquote()` calls it with `dq=True`, `word()` with `False`.
  - `fail_closed()`: a read-only command (`READ_ONLY`, by basename) skips the "gh run through a wrapper" check
    (review R3); its substitutions are still judged as commands of their own.
  - Unchanged: `commands()`, `backtick()`, `ansi_c()`, `heredoc_bodies()`, `decide()`, `target()`, the board check.
- `test/kit.test.ts`, test 3: new must-pass and must-refuse rows; tests 1 and 2 unchanged.
- `CHANGELOG.md`: the Unreleased gate line.

## Call sites and data flow
`main()` → `decide(cmd)` → `read(cmd)` → `Reader.commands()` → `word()` / `dquote()` → `expansion(dq)` → `braced(dq)`.
`braced()` only sets `Parsed.broken` or appends commands read from substitutions to `Parsed.cmds`; `decide()` reads
those as before.

## Risks
- Under-refusal: a reading where bash runs a merge the gate skipped. Mitigation: every case where the bash versions
  could split the command differently stays unreadable (refused); text inside a `'…'` pair in `"${…}"` is read for
  substitutions even when a bash version would not run them (refuse more, never less).
- Over-refusal stays for exotic shapes: a `"` inside `'…'` in `"${…}"`, a nested bracket with blanks between the two
  possible ends.
- The fleet-lanes copy of the gate (`human/bin/dask-merge-gate`) is out of scope and unchanged.
