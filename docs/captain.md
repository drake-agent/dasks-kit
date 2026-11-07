# The captain

The captain is one long-lived agent session that steers the board: it keeps the runners fed, reads review results,
merges what the rules allow, releases stuck claims and answers you in the captain chat. It never builds cards and never
makes product decisions: those it asks you on the card.

## Start it

```bash
dasks-captain
```

It takes the board's captain lease as `captain@<machine>`, starts the first harness of `captain.harness` (config.json)
that is on this Mac's PATH, renews the lease while the harness runs and releases it when the harness exits. Run it in a
terminal you keep open, on any Mac of the fleet.

```json
"captain": { "harness": ["claude", "codex"], "lease_sec": 300, "auto_merge": false, "same_machine_review": false, "watch_gap_sec": 600 }
```

`auto_merge` and `same_machine_review` are explained under [Merging](#merging), `watch_gap_sec` under
[The watch](#the-watch).

| Harness entry | What runs |
|---|---|
| `claude` | `claude "<captain prompt>"`, interactive |
| `codex` | `codex "<captain prompt>"`, interactive |
| any other text | a command template for another CLI: words split on spaces, `{prompt}` = the prompt text as one argument, `{prompt_file}` = its path (`~/.dasks/captain/prompt.md`) |

`dasks-captain --dry-run` prints the harness it would pick and the prompt; `--harness <entry>` overrides the chain once.

The prompt points the session at the captain skill ([skills/captain/SKILL.md](../skills/captain/SKILL.md), installed for
Claude Code and Codex), which lists its duties.

## One captain at a time

| Route | What |
|---|---|
| `GET /api/captain` | the lease holder and expiry, the harness chain, the chat's last message number |
| `POST /api/captain/lease` | `{ttl_sec}` takes the lease; `{ttl_sec, lease_id}` renews it. 409 with `holder` while someone else holds it |
| `POST /api/captain/lease/release` | `{lease_id}` gives it up |
| `POST /api/captain/lease/check` | `{lease_id}`: 200 when the caller holds the live lease under that id, else 409 |

Renewing needs the lease id the board handed out, so a second `dasks-captain`, even on the same Mac, gets
`the captain lease is held by …` and exits 3. A lease that is not renewed runs out after `lease_sec`; a captain that
finds its lease gone stops its harness.

## The watch

`dasks-captain-watch` prints one line per board event the captain should act on, then exits:

```
REVIEW web.t-form https://github.com/acme/web/pull/12
BLOCKED web.t-login
QUIET mini 2026-11-03T10:42:10.123Z
IDLE build2
CHAT 7
```

The captain runs it in the background and starts it again after each batch. It remembers what it saw in
`~/.dasks/captain/watch.json`; the first run only takes that baseline. `--once` looks once, `--follow` keeps printing,
`--timeout S` exits 124 when nothing happened.

A captain that forgets to start the watch again, or gets stuck in a long job, hears nothing more and nobody notices.
So `dasks-captain`, which runs outside the agent's session, checks at each lease renewal when the watch last looked at
the board (the time `watch.json` was last written):

```text
the watch has not looked for watch_gap_sec (default 600; or the session started that long ago and it never looked)
  → one captain chat message: the watch stopped
the watch looks again
  → one captain chat message: it is back
```

It never starts the watch itself: only the captain's session can act on its lines. `watch_gap_sec: 0` turns the
message off. A watch run with `--state FILE` writes elsewhere, so `dasks-captain` cannot see it.

The skill also tells the captain to stay light: it does only short jobs itself and hands anything longer to a background
subagent, so it answers each watch line at once.

## Merging

```bash
dask captain-merge web.t-form [--dry-run]
```

It runs only in the captain's session: the board must confirm that `captain@<machine>` holds the live lease under
`DASKS_CAPTAIN_LEASE` (dasks-captain sets it for its harness), before any check. Right before the merge it renews the
lease and needs at least 120 s left on it; the merge call itself is stopped after 60 s and reported (the card stays in
review; check the PR, it may have merged). It merges the card's PR (squash by default, `--method merge|rebase`) only
when all of these hold:

1. **CI is green on the PR head.** Every check finished and passed (success, neutral or skipped). No checks at all is
   not green.
2. **A clean cross-model review is recorded for that exact head.** The last review-run row for the head
   (`GET /api/tasks/<card>/review-runs`) has verdict clean and no open findings. Who reviewed and who built come from the
   board, never from the row's declared `reviewer` and `impl`: the reviewer is the actor that sent the row, the builders
   are every actor in the card's claim history, and the board records their model families when it stores the row. The
   reviewer must not be a builder, its family must be known and differ from every builder's. Rows written by a captain
   do not count. A fix pushed after the review moves the head, so it needs a new review.
3. **No changed file matches the repo's `risk-paths.txt`**, read from the PR's base branch (so a PR cannot drop its own
   rule). The files come from GitHub's file list for the PR: each name as it is, and for a rename the old name too. One glob per line, `#` comments: `*` within a name, `**` across folders, a trailing `/` for a whole folder, a
   name without `/` in any folder, a leading `/` at the repo root only.

If you approved a merge of that exact head on the board (the merge gate's merge OK, see the README), that stands in for
rules 2 and 3; CI must still be green. A draft PR is marked ready first, and the merge names the head it checked
(`--match-head-commit`), so a push in between makes it fail instead of merging something unchecked. The card then goes
to done.

**By default the captain does not merge on its own** (`captain.auto_merge: false`). A card that passes all three
rules goes to you instead: the card asks "head <sha> Merge this PR?" with the note `ready to merge: CI green, review
clean at <sha>, no risk paths`, and once you approve it on the board (a merge OK for that exact head), the next
`dask captain-merge` merges it. The reason: a machine token may write under every actor name on that machine, and one
OS account can run Claude and Codex alike, so the board cannot prove which model wrote a review sent from a machine.

With `auto_merge: true` the captain merges by itself, and the review row must also come from a fleet machine token of a
machine that built none of the card (no builder's name ends in `@<that machine>`). A review sent from the board's own
Mac, without a machine token, has no machine and does not count. `same_machine_review: true` drops that machine rule;
then a builder's machine can approve its own work under another model's name, so turn it on only if you trust every
session on every Mac.

Anything else: nothing is merged, the card stays in review with a note and a message to you saying why, and the command
exits 3. That is the expected outcome for a risky change, not an error to work around.

### Where reviews come from

The runner claims a card as `runner@<machine>` beside its build tool's name (`claude@<machine>`) and records its
cross-model review as the reviewing tool (`codex@<machine>`), for the head it read. For a PR built in your own session,
have the other model's session record the review, so the board sees it come from that model:

```bash
dask review-record web.t-form --head <sha> --impl claude --reviewer "codex" --verdict clean --answer-file review.md
```

A PR gets at most 2 review passes (`review-runs` passes 1 and 2; a third is refused): pass 1 reviews the whole change,
pass 2 only re-checks its findings and regressions from the fixes. A finding blocks only with a repro, or tagged
security, data-loss, approval or money; other findings are follow-ups in the PR body under `## Follow-ups`. The runner
records each review as the next free pass. A card not clean after pass 2 keeps its PR draft and goes back to its spec
(`dask block`), and you are told, as the `review-loop` skill says. Rows from older kits (a pass 3 recorded as `narrow`)
stay readable and count like any other row for their head.

## Captain chat

The Fleet page of the board (More → Fleet) has a small chat: you write while logged in with your passphrase, the
captain answers. Messages are kept in `run/captain-chat.jsonl` in the board data folder.

```bash
dasks captain chat read [--since N]
dasks captain chat reply "<text>"     # only the lease holder may write
```

| Route | What |
|---|---|
| `GET /api/captain/chat?since=N` | messages after N |
| `POST /api/captain/chat` | `{text}`, from the logged-in human or the lease holder |

An agent writes only as the lease holder and with its lease id (`DASKS_CAPTAIN_LEASE`); the holder's name alone is
refused.

**Chat never approves anything.** A chat message is not a merge OK, a spec approval or an answer to a decision. Those
stay the passphrase-gated actions on the board, and the captain skill says so.
