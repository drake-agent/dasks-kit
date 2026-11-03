---
name: spec-writer
description: Turn a rough Dasks card into a spec that passes the card contract and a hostile review, read against the project's real code. Use when asked to write, draft, fix or review a card's spec, when a card's spec_state is none or draft, or when running `dask spec <card>`. Not for building a card (the dasks skill covers that) and never for a card you will build yourself.
---

# Writing a card spec

A spec is the card's answer key: what to build, how anyone can tell it is done, and the tests that prove it. The runner
builds only cards whose spec is `ready`, and a spec becomes ready only after a reviewer of the other model family passes
the exact version. You are the drafter. Write the spec so that review finds nothing to block.

## Rules that never bend

- **You never build a card you specced.** The board refuses the author of the Acceptance tests as its builder. Do not
  claim the card either: a claim makes you an implementer, and an implementer cannot write the answer key.
- **Read the real code, read-only.** Read the project's default branch as it is on the remote: `git fetch`, then a
  temporary worktree or `git show origin/<default>:<path>` / `git ls-tree -r origin/<default>`, never the user's working
  tree (it may be dirty or on another branch). A project with no local checkout: `gh api repos/<owner>/<name>/contents/…`
  or a shallow clone into `~/.dasks/cache`. Never edit, commit or push in the project. You write only the spec (board)
  and notes on the card.
- **No secrets** in a spec: name what a card needs as `secrets:` labels, never values.

## Steps

1. **Read the card** (`dask card <card>`, MCP `get_spec` / `get_task`) and note the spec version you read (0 when there
   is none). Read the card's lessons and its project profile if it has one.
2. **Read the code** the card is about: the files, functions, routes and tests. Every file or function the spec names
   must exist on the default branch, or be marked as new.
3. **Attack the premise** before writing a word: is the problem real in this code? Already solved? Aimed at the wrong
   place? Would the change break something the card does not mention? If the card is wrong, narrow it to what holds and
   say why in `## Background`.
4. **Write the spec.** Header lines before the first `## ` heading (the card contract):
   - `id`, `goal`, `role: builder`, `tier: 1|2|3`, `repo`, `branch`, `lane`, `deadline: YYYY-MM-DD`, `size: small|big`,
     `depends_on` (card ids or `none`), `impl` / `review` (the two tools, never the same: `impl: claude` + `review: codex`
     or the reverse), `touches` (paths the build changes), `secrets` (labels, only when needed).
   - `done_when:` one line, what the user sees when the card is done, checkable by someone who did not build it ("the
     Save button stores the note and it is still there after a restart", not "works" or "is improved").
   - `done_at: pr` (done when the PR merges: code, docs, tests) or `done_at: live` (done only after someone checks the
     end state after the merge: an installed app, a deployed service, a running job). `dask verify <card> --evidence …
     --commit <sha>` records that check.
   - `pass_checks:` 3 to 5 checks that can actually fail: a command and the result it must give ("`npm test -- x` passes
     and prints 4 tests"), never "is clean" or "looks right".
   Sections: `## Background` (what the code does today, with file references), `## Why`, `## Scope`, `## Non-goals`,
   `## Files likely touched`, `## Context pack`, `## Acceptance tests` (name, setup, action, expected result; each one
   fails on today's code), `## Tests`, `## Done criteria` (a list), `## Open questions`.
5. **Score open questions** as `- [Q] often=<1-10> bad=<1-10> kind=<security|data-loss|approval|what|where|done|other>
   <question>`. Often = how often a builder would hit it; bad = how bad a wrong guess is.
   - Security, data-loss and approval questions **always block**, whatever the score: ask the user.
   - A plain what / where / done question with often × bad **under 30** does not block: write it as
     `implementer decides (score N): <question>` and let the builder choose.
   - Any other question at 30 or more blocks.
6. **Store it:** `dask card-write <card> --file F --expected-version <the version you read>` or MCP `put_spec` with
   `expected_spec_version`. A 409 means someone wrote a newer version: read it and merge, don't overwrite. A 422 lists
   the contract reasons: fix them and store again.
7. **Get it reviewed by the other model family.** `dask spec <card> --file F` stores your draft and runs the other tool
   as an adversarial reviewer from a read-only view of the default branch; it revises on P0/P1 findings: two full
   review passes, then at most one narrow pass on the fixes. Never record a review of a spec you wrote (`review_spec` refuses an author's family).

## What the reviewer attacks (fix these before it does)

- a wrong premise, or files and functions that do not exist on the default branch;
- acceptance tests missing, not testing the goal, or passing on today's code;
- pass checks that cannot fail; a `done_when` nobody can check, or `done_at: pr` for a change that only shows once it is
  live;
- scope or non-goals left unstated; hidden dependencies (other cards, migrations, secrets, services, data formats);
- blocking questions left as assumptions.

P0/P1 findings or a blocking question leave the spec in draft with the findings in a card note; a clean review makes it
ready.
