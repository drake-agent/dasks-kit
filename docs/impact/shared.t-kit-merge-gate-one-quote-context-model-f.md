# Impact map: shared.t-kit-merge-gate-one-quote-context-model-f

Builds on #13's branch (launch base 2233ec8). The earlier impact files stay: they map the reader this card reshapes.

## Files and functions
- `bin/dask-merge-gate`
  - New table `QUOTES[context][opener]` with `CONTEXTS` and `OPENERS`: the one place that says what `'`, `"`, `$'`,
    `$"`, `\`, `` ` ``, `$(`, `${`, `$[`, `<(`, `>(` mean in each context. Contexts: top, dq, heredoc, brace,
    brace_dq, bracket, arith (`$((…))` and `((…))`), backtick, cmdsub, and two that bash 3.2 needed (found by the
    grid and a nested fuzz): cmdsub_dq (`$(…)`, `<(…)`, `${…}` inside `"${…}"`, `$[…]` or arithmetic, where bash 3.2
    decodes `$'…'` and runs the result) and procsub (the body of `<(…)`, where bash 3.2 does not pair `$[…]`).
    A tuple cell lists every reading; all are read, and readings that end at different places make the command
    unreadable.
  - `Reader.opener(ctx, at)`: the opener at a place and its meaning; `Reader.apply(op, meaning, ctx, cmd)`: what each
    meaning does. `commands`, `word`, `dquote`, `braced`, `backtick` ask these and hold no opener literals.
  - Removed: `Reader.expansion` (its `$(`, `${`, `$[` parts are table cells now; `$name` is `Reader.parameter`) and the
    `arith`/`dq` flags of `commands`, `word`, `braced`; the context name carries them.
  - `ansi_c` became module functions `ansi_c_end` and `ansi_c_decode` (same decoding as before).
  - `main()`: `dask-merge-gate --table` prints the table as JSON for the grid test. Hook mode (stdin JSON) unchanged.
  - Review pass 1 (R1-R4): `Reader.delimiter(raw)` removes only quotes from a here-document delimiter (bash expands
    nothing there), replacing the value-or-raw guess; `read()` finds `let`-like builtins behind `command`/`builtin`
    like it finds shells; new `shell_code()`: `eval` runs its words joined by spaces, `sh -c code args` runs only the
    code word, its arguments are read as data the code may eval (a quote error in data does not refuse).
  - Unchanged: `target`, the board `merge-ok` check, `refuse`, `gh`, `fail_closed`, `decide`.
- `test/kit.test.ts`: new grid test after test 3; tests 1-3 unchanged (only the `spawn` import was added).
- `CHANGELOG.md`: the one Unreleased gate line gets the table.

## Call sites and data flow
`main()` → `decide(cmd)` → `read(cmd)` → `Reader.commands(…, "top")` → `word()` / `dquote()` / `braced()` →
`opener()` → `QUOTES` → `apply()`, which enters the next context (`commands`, `dquote`, `braced`, `backtick`).
Readers only add commands to `Parsed.cmds`, set `compound` or `broken`; `decide()` judges them as before.

## Behavior changes (all checked against /bin/bash 3.2)
- Newly refused (bash runs the merge; the launch base let them through, found by a nested fuzz): `$'…'` inside a
  `$(…)` in `"${…}"`, and `$'\x24(…)'` there or in a `$(…)` inside `$[…]` / `$((…))` under quotes; `<(…)` in `${…}`
  inside `((…))`; a `$[` in `<(…)` that hides a `)`.
- Newly refused, bash does not run them (fail closed): a `$'…'` whose escapes decode to shell syntax in those
  places, e.g. `"${x:-$'a\nb'}"`.
- Newly passing: a merge spelled inside `$[ <(…) ]` (bash reads `<(` as text in `$[…]`; nothing runs). Plain
  `$[ <(…) ]` passed before too.

## Tests
- Test 3 rows, tests 1 and 2: unchanged, pass.
- Grid: every (context, opener) cell from `--table`, 4 rows per place (inside the opener, past the context's end,
  past it behind a backslash, plain), each run by the system bash with a printing gh and by the gate.

## Risks
- Over-refusal in rare spellings (escapes in `$'…'` inside quoted defaults or arithmetic). Fail closed by design.
- The oracle is bash 3.2 (macOS, also CI). Bash 5 readings are covered by the tuple cells, not by a bash 5 run.
