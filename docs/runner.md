# The card runner

`dasks-runner` builds ready cards on this machine while you are away. It is off until you turn it on.

## What one run does

```mermaid
flowchart LR
  A[claim on the board] --> B[recovery record saved]
  B --> C[worktree on dasks/&lt;card&gt;]
  C --> D[build: claude -p or codex exec]
  D -->|built| E[review pass 1 by the other model]
  E -->|a finding blocks| F[one fix pass]
  F --> P[review pass 2: findings and fixes only]
  E -->|clean| G[gitleaks scan]
  P --> G
  G --> H[push branch, draft PR]
  H --> I[card to review, handed back]
  H -->|not clean after pass 2| B2[card blocked, you are told]
  D -->|failed, stopped, limit| R[outcome, then release]
```

- **Claim.** The claim asks the board to refuse it while a card with overlapping `touches:` is being worked in the same
  repo, so two runners on different machines cannot start colliding cards. The board answers with a run id.
- **Recovery record.** Saved in `~/.dasks/runner/state.json` right after the claim. If the runner dies, the next start
  stops what it left running and gives the card back. A record goes away only after the board confirmed the release or
  the hand-back.
- **Success** means: the agent exited 0, was not stopped, ended with `RESULT: built …` and made commits after the
  branch tip it started from. Anything else is a failed attempt: its commits stay on the branch for the next one.
- **Giving a card back:** the failed attempt's outcome is recorded for that run first (it counts toward the board's
  retry cap), then the release names the run, so it can never release a later claim.
- **Limits** count from the card's start, across build, review and fix: never stopped before `timeout_min`. Past it, a
  run that is still writing is kept: new log output or a change in its worktree (an edit, a new file, a commit; checked
  every 30 s, without blocking the runner; a worktree that cannot be read in time counts as activity) counts. A run
  quiet for `idle_min` is stopped, and every run stops at `max_min` (12 h by default). The
  runner logs one line when it keeps a run past `timeout_min`. A stopped agent gets SIGTERM, then SIGKILL, and the
  worktree is removed only after every process it started is gone. `idle_min: 0` stops every run at `timeout_min`.
- **One nudge.** A Claude build that exits 0 without a `RESULT:` line usually ended its turn while waiting on something.
  The runner resumes that session once with a "continue" prompt, under the same limits and into the same log. Codex
  builds get no nudge: the runner starts `codex exec` without a session it could resume. `nudge: false` turns it off.
- **PR first.** The runner opens draft PRs and never merges them, so they can pile up. Before it starts cards it counts
  every open PR of each repo with `gh pr list` (four repos at a time, 20 s each at most, without holding up
  heartbeats or the card limits); a repo with more than `pr_limit` open PRs gets no new card until some
  merge or close. It logs one line when a repo goes over (and when it is back under), each held card is logged as
  skipped with the reason, and `dask runner status` lists the held repos. If `gh` is missing, not logged in or fails, the
  count is skipped and cards start without the PR limit (one log line).
- **Usage or rate limits:** that tool waits `backoff_min`; the attempt does not count.
- **gitleaks is required.** Without it the runner builds but never pushes.
- It **never merges**, never pushes the default branch and never force-pushes.
- **Review.** At most 2 passes per PR, and passes an earlier attempt left on the board count. Pass 1 reviews the whole
  change. If a finding blocks, the builder gets one fix pass and pass 2 re-checks only those findings and regressions
  from the fixes. There is no pass 3.
- **What blocks.** A finding blocks only if it carries a repro: a `repro:` line right under it with the exact command,
  input or failing test and the wrong result it shows. A finding tagged `[security]`, `[data-loss]`, `[approval]` or
  `[money]` always blocks. Everything else is a follow-up: it is listed under `## Follow-ups` in the PR body and blocks
  nothing. The P level only orders the list; the line format is in the `review-loop` skill.
- **Not clean after pass 2.** The PR stays a draft (a ready PR from an earlier attempt goes back to draft), the open
  findings go on top of a new PR's body, the card gets a Spec block with those findings and you get a message on the
  card. It stays in review with its PR; nothing picks it up until you unblock it.
- **Review record.** Each pass is also stored on the board for the head it read, sent as the reviewing
  tool (`codex@<machine>`; the claim goes in as the build tool beside `runner@<machine>`)
  (`GET /api/tasks/<card>/review-runs`), which is what `dask captain-merge` checks ([captain.md](captain.md)). A clean
  pass 2 is the review of the fixed head.
- **Spec pass.** When a look starts no ready card, its free slots draft and review specs of open cards that have none
  (or an unreviewed draft): one harness drafts from a read-only view of the default branch, the other reviews, at most
  two full review passes and at most one narrow one, then the card is given back ready or draft with a note. No branch, no commit, no PR. `spec: false` turns
  it off. [specs.md](specs.md).
- **Heartbeat.** Every look, and every minute between, the runner tells the board it is alive and what it is working
  ([fleet.md](fleet.md)). A runner silent for `fleet.dead_min` loses its cards to the pool.
- **Order.** Cards you pushed start first, then bug fixes (cards of kind `bug`: `dasks new <app> "…" --kind bug`), then
  the rest by priority. `dask ready` and MCP `ready_tasks` list them in the same order.

## Turn it on

1. Give each project the checkout its cards build in (a git repo with a GitHub remote, `gh auth login` done), in
   `~/.dasks/data/config.json`:

   ```json
   "projects": [{ "id": "web", "name": "Website", "repo": "~/code/website" }]
   ```

2. Install the LaunchAgent and enable it:

   ```bash
   ./install.sh --with-runner
   ```

3. Watch it:

   ```bash
   dask runner status
   tail -f ~/.dasks/runs/runner.log
   ```

Try one look by hand first: `bin/dasks-runner --once`.

## Settings

`runner` in `config.json`, all optional:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | off until you turn it on |
| `max_parallel` | `1` | cards built at the same time |
| `daily_cap` | `10` | cards started per local day (rate-limited starts are taken back) |
| `poll_minutes` | `10` | minutes between looks |
| `model` | `""` | Claude model for builds, fixes and Claude reviews (`--model`); empty = the `claude` CLI's default |
| `timeout_min` / `idle_min` / `max_min` | `180` / `150` / `720` | card limits, see above |
| `backoff_min` | `60` | wait after a usage or rate limit |
| `pr_limit` | `10` | a repo with more open PRs than this starts no new card; `0` turns it off |
| `nudge` | `true` | one "continue" to a Claude build that exited without a RESULT line |
| `spec` | `true` | when a look starts no ready card, free slots write specs for cards without a ready one ([specs.md](specs.md)) |
| `machine` | stored machine name | the runner's name on the board: `runner@<machine>` |
| `update` | on a joined Mac, off on the board's | between cards, update the kit checkout from its remote (below) |

On a Mac that joined a fleet these settings, and `projects` with this Mac's checkouts, live in `~/.dasks/runner.json`
([fleet.md](fleet.md)).

## Staying current

With `update` on (the default on a Mac that joined a fleet), the runner looks at the kit checkout between cards, never
while one runs: it fetches the checkout's remote and, when the remote's default branch moved, fast-forwards, runs
`npm ci --omit=dev` if `package-lock.json` changed, and restarts (launchd starts the new code; a runner started by hand
starts a copy of itself). It does not update, and says why in its log, in `dask runner status` and in its heartbeat
(`dasks fleet`, the Fleet page), when:

- the checkout has local changes, is on another branch, or has commits the remote does not (it never resets, stashes or
  forces anything of yours);
- the new kit needs a board schema newer than the board's (`/api/health` `schema.version`): update the board first;
- the fetch fails, or the kit folder is not a git clone.

The new dependencies are installed in a staging folder beside the kit first; only when that `npm ci` succeeds does the
checkout move and its `node_modules` get swapped, so a failed install (offline, say) leaves the runner as it was. The heartbeat carries the kit commit, so
`dasks fleet` marks a Mac whose kit is older than the board's as BEHIND. On the board's own Mac the board and the runner
share the kit, so `update` is off there: upgrade it as in [upgrade.md](upgrade.md).

## Stop it

```bash
launchctl bootout gui/$(id -u)/dev.dasks.runner
```

Running agents are stopped and their cards given back. Or set `runner.enabled` to `false`: it finishes the current card,
then idles. `./uninstall.sh` stops the runner and waits for its cards to be handed back before it stops the board.

## Read this first

`claude -p --permission-mode auto` and `codex exec --full-auto` run commands in the card's worktree with nobody
watching, using your account, your git and `gh` logins and your network. Turn the runner on only for repos and cards
you would let an agent work on alone.
