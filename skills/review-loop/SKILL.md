---
name: review-loop
description: "How to run, answer and record a cross-model code review of a Dasks card: one reviewer from the other model family, numbered findings, a ledger, at most two passes, and a finding blocks only with a repro or a security, data-loss, approval or money tag; small fixes only. Use when you review a card's PR or answer a review of your own work."
---

# review-loop

A review here is a short, bounded conversation between two sessions: the one that built the card (the implementer)
and one from the other model family (the reviewer: Claude reviews Codex's work, Codex reviews Claude's). It ends
either clean or with the card going back to its spec. It never turns into a second round of building.

## Reviewer: what to read

- The card (`dask card <card>`): its spec, `pass_checks:`, acceptance tests and `touches:`. The card is the yardstick;
  your own taste is not.
- The diff of the PR head you were given (`git diff <merge-base>...<head>`), and enough of the code around it to judge
  it. Note the exact 40-character head sha: your verdict is about that commit only.
- The evidence the implementer kept under `.dask/logs/<card>/`. Re-run a check yourself when the claim looks weak.

## Reviewer: what to write

Every finding gets an id, a priority, a place, what is wrong and the right result. A finding that should block also
gets a block tag. Tools read these lines, so keep the shape:

```text
R1 [P1] [repro] src/contact/send.ts:42 an empty form sends a blank mail. Expected: refused with an error
repro: curl -X POST localhost:3000/contact -d '' -> 200, and a blank mail in the outbox
R2 [P1] [security] src/contact/log.ts:9 the API token is written to the log. Expected: redacted
R3 [P3] public/contact.html:12 the button says "Submit"; the card asks for "Send". Expected: "Send"
```

**What blocks the merge:**

| Finding | Blocks |
|---|---|
| carries a repro: `[repro]`, and the very next line is `repro: <exact command, input or failing test> -> <the wrong result it shows>` | yes |
| tagged `[security]`, `[data-loss]`, `[approval]` (a human approval gate is skipped) or `[money]` | always, with or without a repro |
| anything else, including `[repro]` with no `repro:` line | no: it is a follow-up |

The priority (`P0` the main path is wrong, `P1` a real bug inside the change, `P2` a wrong result on an unusual input,
`P3` a nit) orders the list. It never blocks by itself. If you cannot show a bug and it touches none of the four tags,
it is a follow-up, however sure you are.

- Ids run on across passes, so a finding keeps its id until it is closed.
- Only report what is in the card's scope or what the diff itself breaks. An idea for later is not a finding: put it
  under a separate "Out of scope" line, without an id, or propose it as an idea on the board.
- No finding without a place and a reason someone else can check. "Could be cleaner" is not a finding.
- The last line is `VERDICT: clean` (nothing blocks; follow-ups may remain) or `VERDICT: changes` (a finding blocks).

## The ledger

Keep one table per card in the review text and carry it to pass 2:

```text
| id | block  | status    | pass | note |
| R1 | repro  | fixed     | 1→2  | refused before send (abc1234) |
| R2 | secur. | open      | 2    | one log line still has the token |
| R3 | -      | follow-up | 1    | in the PR body |
```

`status` is one of `open`, `fixed` (the reviewer saw the fix), `follow-up` (does not block) or `disputed` (the
implementer disagrees; the reviewer decides on pass 2, and a blocking finding stays open until it does).

## Implementer: answering

- Fix every blocking finding with the smallest change that does it. No refactors, renames or extras on the way.
- Do not fix follow-ups in this PR. List each one in the PR body under `## Follow-ups`.
- If a finding asks for more than the card does, say so and leave it: scope belongs to the card, and a change of scope
  goes to its spec, not into this PR.
- Disagree with a reason when the reviewer is wrong; don't fix something you believe is correct just to close it.
- Push the fixes, then hand the new head back for pass 2.

## How many passes

At most two per PR. Card size changes nothing.

1. **Pass 1:** reviews the whole change.
2. **Pass 2:** only re-checks the pass-1 findings and regressions the fixes caused. Each pass-1 finding gets a line:
   `R1 resolved`, or its finding line again, with its tag and a new `repro:` line, as it shows on the new head. Nothing
   else is raised.

There is no third pass of any kind. Not clean after pass 2: keep the PR draft (put a ready one back with
`gh pr ready --undo`), block the card with the open findings, `dask block <card> --note "<ids and one line each>"`, and
tell the human. The spec or the design gets fixed first.

## Recording it

Record each pass on the board from the reviewing session, for the exact head you read, so the board sees which family
sent it:

```bash
dask review-record <card> --head <sha> --impl claude --reviewer codex --verdict open --open 1 --noted 1 --answer-file review.md
```

`--open` counts blocking findings, `--noted` follow-ups. The board takes pass 1 and pass 2 and refuses a third.

A pass is about one head: any push after it needs a new pass before a merge can rely on it. Never record a review of
your own work, and never call a review clean to get past a gate.
