---
name: review-loop
description: "How to run, answer and record a cross-model code review of a Dasks card: one reviewer from the other model family, numbered findings with a severity, a ledger per pass, two full passes then at most one narrow pass, small fixes only. Use when you review a card's PR or answer a review of your own work."
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

Every finding gets an id, a severity, a place and a reason:

```text
R1 P1 src/contact/send.ts:42  the mail is sent before the form is validated; an empty form sends a blank mail
R2 P3 public/contact.html     button label says "Submit"; the card asks for "Send"
```

| Severity | Means | Blocks |
|---|---|---|
| P0 | wrong in a way that loses data, leaks a secret, breaks the build or the main path | yes |
| P1 | the card's ask or a listed check is not met, or a real bug a user will hit | yes |
| P2 | worth fixing, but the card is done without it | no |
| P3 | a nit: naming, wording, style | no |

- Ids run on across passes (pass 2 starts after the last id of pass 1), so a finding keeps its id until it is closed.
- Only report what is in the card's scope or what the diff itself breaks. An idea for later is not a finding: put it
  under a separate "Out of scope" line, without an id, or propose it as an idea on the board.
- No finding without a place and a reason someone else can check. "Could be cleaner" is not a finding.
- End with a verdict: `clean` when no P0 or P1 is open, else `open` with the count.

## The ledger

Keep one table per card in the review text and carry it forward on every pass:

```text
| id | sev | status | pass | note |
| R1 | P1  | fixed  | 1→2  | validated before send (abc1234) |
| R2 | P3  | noted  | 1    | left as is |
| R3 | P1  | open   | 2    | retry loop still unbounded |
```

`status` is one of `open`, `fixed` (the reviewer saw the fix), `noted` (P2/P3 the implementer chose not to do) or
`disputed` (the implementer disagrees; the reviewer decides on the next pass, and a P0/P1 stays open until it does).

## Implementer: answering

- Fix every open P0 and P1 with the smallest change that does it. No refactors, renames or extras on the way.
- P2 and P3: fix them when it is a line or two, else mark them `noted`. Never let them grow the PR.
- If a finding asks for more than the card does, say so and leave it: scope belongs to the card, and a change of scope
  goes to its spec, not into this PR.
- Disagree with a reason when the reviewer is wrong; don't fix something you believe is correct just to close it.
- Push the fixes, then hand the new head back for the next pass.

## How many passes

1. **Pass 1:** a full review of the head.
2. **Pass 2:** a full review of the new head, starting from the ledger: are the fixes right, did they break anything?
3. **Pass 3 (only if needed):** a narrow look at the fixes made after pass 2 and nothing else.

A card with a P0 or P1 still open after that is not reviewed again: block it with the open findings,
`dask block <card> --note "<ids and one line each>"`, so the spec gets fixed first.

## Recording it

Record each pass on the board from the reviewing session, for the exact head you read, so the board sees which family
sent it:

```bash
dask review-record <card> --head <sha> --impl claude --reviewer codex --verdict open --open 1 --noted 1 --answer-file review.md
```

A pass is about one head: any push after it needs a new pass before a merge can rely on it. Never record a review of
your own work, and never call a review clean to get past a gate.
