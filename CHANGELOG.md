# Changelog

## Unreleased

- Optional SQLite board store: with `store.mode` `sqlite` in `config.json` the board keeps its `data/` files as rows of
  one SQLite file (`node:sqlite`, no new dependency), so a write is one transaction instead of a lock, a journal and a
  git commit. `node bin/board-store.ts import` fills the store once from the data repo; `compare` and `status` check
  it. The server refuses to start (exit 2) on a store that is missing, empty or another board's. `store.mode` `git`
  stays the default and behaves as before. See docs/storage.md.
- SQLite store export: `node bin/board-store.ts export` replays the store's writes as git commits (one per write, same
  message) into the store's own bare export repo, and `compare --export` checks it. In sqlite mode the backup exports
  first and pushes that branch, the digest and the decisions witness read its history, a schema migration keeps a copy
  of the db, and `dasks check`, `dasks-digest` and `bin/verify-decisions.ts` read the store. `restore --from <copy>` puts such a copy back and resumes the export. See docs/storage.md.
- Live window: while the runner builds, reviews or fixes a card, it posts the agent's newest steps and the worktree's
  diff since the run started to `POST /api/tasks/<card>/live` (agent token), and `GET /api/tasks/<card>/live` reads
  them back. Both sides redact secrets; sensitive and config files show no content; steps, files and diff bytes are
  capped, and the board keeps it in memory only, never in `data/`. `DASKS_RUNNER_LIVE_MS` sets the interval (`0` = off).
  See docs/runner.md.
- Card panel: a "Live" section shows a running card's newest steps, its phase, and the changed files with a coloured
  diff (folded); it updates on the board's `live` event and keeps the last state after the run. A card without live
  data shows nothing new.
- Hands-off mode, off by default: `dasks hands-off on|off|status` sets `hands_off.enabled` in `config.json`, read on
  each request (no restart). While it is on, `GET /api/merge-ok` answers 410 and `dask captain-merge` lands a card on
  green CI and a clean review without a merge OK; review cards show no approve/reject; a build-stage park, question,
  ask, needs-user outcome or retry cap becomes a card note (a doing card goes back to its spec stage) unless it is a
  taste pick or about money, deleting data, a secret or credential, a physical device or a UI choice. `/api/status`, `/api/health`,
  `/api/board` and `/api/captain` report `hands_off`. See docs/captain.md.
- Specs: a later spec version may reach 1,600 words in total (room for a fix line, a decision or an answer, on a full
  spec); the first version stays at 1,500. The spec writer prompt and the `spec-writer` skill say so. See docs/specs.md.
- Specs: a spec versions folder that cannot be read (a permission error, a file in its place) answers 503 with
  `Retry-After`, never "no spec yet" (404, version 0), and a `PUT /spec` on it stores nothing, so a second version 1 is
  never written over a stored spec. `GET /api/asks` and `/asks.md` still answer 200: such a card is listed under
  `unavailable` with the reason, and every other card's decision is served.
- Touches from the real PR: a PR file whose name holds glob characters (`app/[id]/page.tsx`, `[slug].ts`) now holds
  that one file. It used to be read as a pattern cut at `[`, so it held its whole folder (or, at the repo root, was
  dropped). See docs/cards.md.
- Code map: Swift access-level imports (`public import X`, `package import X`, `internal`, `fileprivate`, `private`) are
  read as the same edge as `import X`.
- Secret scan: a gitleaks run that exits 0 is clean only when it prints its `N commits scanned` summary and no error
  line. gitleaks also exits 0 when its own `git log` fails (an `ERR [git]` line), for example for a base the clone does
  not have; the runner then pushed a branch nothing had scanned. Now the runner's push, its saved-work push and
  `dask submit` refuse to push in that case. A count of 0 (a delete-only commit) is still clean. See docs/runner.md.
- Secret scan: merge commits are scanned by their first-parent diff (`--diff-merges=first-parent`), so a secret added
  only while merging is caught; plain `git log -p` shows no patch for a merge.
- `dasks ci`: every ssh call to another Mac sends keepalives and ends after `DASKS_CI_REMOTE_SEC` seconds (default 900),
  so a host that hangs fails that step instead of holding the command for hours. See docs/ci-runners.md.
- `GET /api/start` marks messages read only after the reply was sent in full, so a reply that fails on the way (a reset,
  a closed connection) leaves them unread. `HEAD` never marks them read, and under auth `enforce` only a caller whose
  token proves the actor name moves its read cursor; anyone else still gets the text, as a peek.
- Read cursors of names that differ only in case (`Spec@host1`, `spec@host1`) keep separate files on a case-insensitive
  disk. An all-lower-case name keeps the file it had.
- Every secret compare goes through one helper that checks the length first, so a client-sent value of another byte
  length is a refusal, never a 500.
- `GET /api/board`: one reply (and one gzip, made off the main thread) per data version is reused for 3 seconds, so a
  burst of reloads from open pages no longer stringifies and compresses the whole board again for each tab and stalls
  the board. A write moves the version, so it shows at once, also
  in a gzip reply whose compression was still running when the write finished (it is rebuilt, never sent older); `now` and `stuck` may be up to 3 seconds old.
- Tests: tearing down a test server that was already killed by a signal returns at once instead of hanging until the
  test timeout. The fleet test checks that `dasks machine list` never prints the whole token secret (it took the
  part after the second `_`, which can be a short fragment because the secret may hold `_`, and failed by chance).
- Card create: the near-duplicate check no longer refuses a title whose slug has no a-z0-9 (they all share the `task`
  fallback id), a title like `Phase` while `Phase 2` (`<goal>.t-phase-2`) is open, or two long titles that share only their
  first 40 slug characters. A real repeat (the same normalized title) is still 409.
- Card create: the intake todo limit holds only a create that lands in todo; a card filed straight into review at the limit
  is written instead of becoming an idea.
- Card create: a retry is never replayed onto a done or cancelled card; filing the same create again after a cancel makes a
  new card.
- Release: the board checks the caller (the request's actor), not the `who` it sends. Releasing a claim you do not hold, or
  naming someone else, needs `force`.
- Outcomes: a needs-spec outcome that arrives after the run was already closed as failed (or is sent again) still moves the
  card to spec-rework for its owner, with the question kept.
- Ideas: the ideas file cap is 8 KB per idea (300 ideas), so the 300-idea count is the limit, also for ideas written in
  3-byte characters (the fixed 128 KB cap refused new ideas after about 100 long ones).

## 1.1.1 — 2026-11-16

- Rethink cards: while a rethink card is open (not done, not cancelled), the card it replaces no longer asks you for a
  decision. A card in review that is blocked at the review limit and named by an open card's `rethink:` line gets no
  `decision_request` on `/api/board` or `/api/tasks/<card>` (so no approve/reject on its panel), leaves the review
  triage page, lists no skipped steps in the daily summary and is not `review-stale` in `/api/stuck`, project status or
  the digest. The board's write checks still treat it as asking. It still asks as before when it has `needs_user` or `approvals` set, when the rethink card is done or
  cancelled, when it is no longer blocked at the limit, and when the board cannot read the facts it needs. See
  docs/runner.md.

## 1.1.0 — 2026-11-16

- Needs a Node release with its October security fixes: 22.23.4+, 24.22.1+ or 26.12.1+. The installer refuses an
  older or pre-release Node, and the board warns when it runs on one. Upgrade Node before you pull this version.
- Specs: `PUT /spec` refuses (422) a spec over 1,500 words, with a reason that says what to cut. A spec says what to
  build, why and how to tell it is done, never how to build it; the spec writer prompt and the `spec-writer` skill say
  so. Specs stored over the cap before this stay readable and still take shorter or auto-ok-only writes. See
  docs/specs.md.
- Runner: the build prompt tells the agent to read the code around the change before a feature, reproduce a bug before
  fixing it, and that a quick throwaway prototype is fine when the approach is unclear. The `dasks` skill says the same.
  See docs/runner.md.
- Project status: `GET /api/status` (every project) and `GET /api/status/<app>` (one) say where a project stands: cards
  per status, what is in progress, what is blocked and on whom, what finished in the last 7 days, and the version's
  progress when version mode is on. `?format=text` gives plain text. The same answer is MCP `project_status` and
  `dasks status [app]`. Read-only. See docs/api.md.
- Runner: a card whose review is not clean after pass 2 no longer just waits. The runner files a rethink card
  (`<card>-rethink-1`, its body starting `rethink: <card>`) with the open findings and the old card's text, asking to
  re-check the design and change the approach; as a new card it gets its own 2 review passes. A rethink card stopped at
  the limit gets the next one, up to `runner.rethinks` (default 3, `0` = off) in one line of cards; then the card waits
  for you. When the rethink card is done, a later look cancels the old card (and any card above it in the line still at
  the limit) as `superseded by <rethink card>`, comments on and closes its PR (the branch is kept) and moves cards that
  waited on it to the rethink card. See docs/runner.md.
- Touches from the real PR: after the runner opens or updates a card's PR, it stores the files the PR head changes on
  the task (`touches_actual`, with the head commit in `touches_sha`). When the card is worked again, the board's claim
  check holds those files instead of the planned `touches:` line, so a card no longer blocks paths it never changed.
  The list is capped (a long one is shortened to folders), never counts toward the size limit, and is cleared by a new
  PR link. GitHub PRs only; when the list cannot be read, the `touches:` line holds as before. See docs/cards.md.
- Runner: a code map. Each project clone gets a map of which file imports which (TS/JS, Python, Rust, SwiftPM), built
  from the git tree at `origin/main` in the background, with no model and within file, byte and time limits. When a
  claimed card changes a file one import away from a file another card in the same repo is changing, the runner logs a
  warning and writes one note on the card. It is only a warning: nothing is held. The board's exclusive claim reply now
  lists those other cards (`beside`). See docs/runner.md "Code map".
- Code review rule: at most 2 passes per PR. Pass 1 reviews the whole change; pass 2 only re-checks pass-1 findings and
  regressions from the fixes; the board and `dask review-record` refuse a third pass (older stored pass-3 rows stay
  readable). A finding blocks only if it carries a repro (a `repro:` line with the command or input and the wrong
  result) or is tagged `[security]`, `[data-loss]`, `[approval]` or `[money]`; the P level no longer blocks. Other
  findings go under `## Follow-ups` in the PR body. The runner now runs pass 2 after its fix pass; not clean after it,
  the PR stays a draft, the card is blocked with the open findings and you get a message. Spec reviews are unchanged.
  See the `review-loop` skill and docs/runner.md.
- Runner: a build that stops before it finishes keeps its work. Uncommitted changes become a WIP commit (secret-shaped
  files stay out), gitleaks scans the new commits, and `dasks/<card>` is pushed to origin; a finding, a failed scan or a
  missing gitleaks pushes nothing. The card's note says where the work is, or that it was not saved and why, and a failed
  save never holds up the hand-back. The next run on any Mac starts from the saved branch when it is still usable, and
  its prompt says it is continuing. See docs/runner.md.
- Runner: an unattended build that meets a step only you can do (a login, signing, a paid purchase, a physical device, an
  approval) skips that one step, never fakes it, and finishes the rest. It reports `HUMAN-STEP: <step> -- <why>` above its
  `RESULT:` line; the runner writes that as a card note and in the PR body, and the daily summary (data, text and page, in
  English and Korean) lists the step until its card ends. A card that is only that step stops as before and is never
  reported as built. See docs/runner.md.
- Version mode, opt-in per project: a goal's `version_target` (`POST /api/nodes/<goal>`, checked by `dasks check`) names
  the milestone it builds now. New cards without a milestone go there, and the runner starts only its cards (`p0` apart),
  logging the rest as skipped. `GET /api/versions` and the Goals page show progress. A ready version gets one gate card
  that asks you to judge it; `launch_gate: <milestone>` marks cards that do not hold it back. No target, no change. See
  docs/versions.md.
- Captain: `dasks-captain` writes once in the captain chat when the watch has not looked at the board for
  `captain.watch_gap_sec` (default 600 s, 0 = off), and once more when it is back. The captain skill now says to stay
  light: short jobs only, anything longer goes to a background subagent. See docs/captain.md.
- `dasks-ci` (optional): runs a repo's GitHub Actions jobs on your own Macs as self-hosted runners. `plan` sizes a Mac
  from its cores and RAM, `add` installs that many official runners (checksum-checked, registered with a token passed
  over stdin, run by their LaunchAgent) on this Mac or an ssh host, `list` and `remove` manage them. A job hook caps
  jobs at once per Mac across repos. Public repos are refused unless `--allow-public-repo`. See docs/ci-runners.md.
- `dasks-ci add` needs the user logged in at the host's screen and stops before registering when there is no login
  session; runners are loaded into `gui/<uid>` with `launchctl bootstrap` (and checked there after the online wait), so
  they no longer stop when the ssh session that added them ends. `remove` unloads them the same way. Labels GitHub adds
  itself, and repeats, are dropped from `--labels`.

## 1.0.0 — 2026-11-03

First public release.

- Board server and web UI on 127.0.0.1 (English and Korean), with the board's data in a local git repo.
- `dasks` MCP server for Claude Code and Codex; `dasks` / `gb` and `dask` CLIs; `dasks`, `review-loop` (cross-model
  review) and `captain` skills. A card's implementer and reviewer must be of different model families.
- Agent tokens on by default: the installer issues one and stores the connection in `~/.dasks/client.json`.
- Card runner (`dasks-runner`, optional): builds ready cards in worktrees, gets a cross-model review, scans with
  gitleaks, opens draft PRs and hands cards back. Never merges.
- Optional merge gate hook: an agent's `gh pr merge` runs only after you approve that exact PR head on the board.
- `install.sh` / `uninstall.sh` that record what they make and touch nothing else.
- Fleet (optional): `--listen` puts the board on a private network (agent tokens enforced, a machine token per Mac via
  `dasks machine add`), `install.sh --join` sets up another Mac, runners send heartbeats (`dasks fleet`, the Fleet page)
  and the board gives back the cards of a runner that went quiet.
- Captain (optional): `dasks-captain` holds the board's one captain lease and runs Claude Code, Codex or another CLI
  with the `captain` skill; `dasks-captain-watch` prints the events to act on; `dask captain-merge` merges only on green
  CI, a clean cross-model review of the exact head and no `risk-paths.txt` match; a captain chat on the Fleet page that
  never approves anything. The runner records its cross-model review on the board (`dask review-record` for your own).
- Runner: past `timeout_min` a run whose worktree still changes is kept, as one whose log still grows; a quiet one stops
  after `idle_min`, every run at `max_min`. A Claude build that exits without a RESULT line gets one "continue" in its
  session (`runner.nudge`).
- Runner: PR first. A repo with more open PRs than `runner.pr_limit` (default 10, counted with `gh`) starts no new
  card; the runner logs why and `dask runner status` shows it. Without a working `gh` it starts cards without that limit.
- Web UI: done ticker. One line under the top bar lists cards finished since this browser last pressed Got it (first
  visit: the last 24 h; at most 7 days), three at a time with "+N more". It is for people only: no MCP tool, CLI or
  route carries it.
- Project profile: each project keeps its why, what works today and what is missing, read from its code. MCP
  `get_profile` / `set_profile`, CLI `dasks profile`, `POST /api/nodes/<goal>` with `{profile}`, checked by `dasks check`
  and shown on the project page.
- `dasks-secret` (optional, `./install.sh --with-secrets`): secrets for agents in the login Keychain. Values are typed
  into a native masked window only; `run` asks for one Touch ID / password approval and starts the command with each
  value in an env var. Per-label agent allowlists (`allow` / `disallow`, human only), commands refused for agents
  (shells, `env`, inline interpreters, network tools, wrappers, `git push`, publishing), an audit log without values.
  `dask secrets <card>` shows what a card's `secrets:` still need; the runner does not start such a card and leaves the
  human the commands on it. docs/secrets.md.
- Spec writing ([docs/specs.md](docs/specs.md)): the `spec-writer` skill (Claude Code and Codex); the runner's spec
  pass (`runner.spec`, default on): with no ready card to start, one harness drafts a spec from a read-only view of the
  project's default branch (a GitHub `owner/name` is read through a shallow `gh` clone), the other attacks it, one
  revision after each failing pass, two full review passes then at most one narrow pass, recorded under the reviewer's name;
  ready, or draft with the findings as a card note. Open questions are scored often × bad: security, data-loss and
  approval questions always block, plain what/where/done questions under 30 become implementer decides. A Mac with one
  harness drafts only. `dask spec <card> [--file F]` runs the same loop from a session. The tool that wrote a spec is
  never picked to build it. `impl: claude` / `review: codex` pass the card contract.
- Spec finish line: every new spec carries `done_when:` (what the user sees when it is done) and `done_at: pr | live`
  (older specs are grandfathered with a warning). A `live` card that would close without a check moves to review on the
  `live-check` lane; `dask verify <card> --evidence … --commit <sha>` records the check and closes it.
- Static type checking: strict `tsc --noEmit` over the code and the tests (`npm run typecheck`), no build step; Node
  still runs the TypeScript directly. `npm run verify` = typecheck + tests.
- Checked boundaries: each write route parses its request body into a typed value (a wrong type is a 400 naming the
  field), and a task file whose frontmatter is not a card (a list where one value belongs, a bad id, status or kind) is
  a load error that `dasks check` reports, not a card with made-up fields.
- Recovery state is kept, never deleted: an unreadable write journal is moved aside and every write stops with a 503
  that says what to do until a human removes it (`dasks check` reports it); an unreadable runner state file is moved
  aside and the runner starts no card until it is resolved (`dask runner status` says STOPPED).
- Bounded subprocesses: every git call of the board is killed after 15 s (`DASKS_GIT_TIMEOUT_MS`) and the write it
  served is rolled back, so a hung git cannot stop the server; the runner's board calls have a deadline too.
- Durable writes: files are fsynced before the rename and their directory after it.
- Readiness: `/api/health` is 200 and `ready: true` only when the spec index, the write journal, the schema and every
  board file are sound, else 503 naming the part; `install.sh` waits for it.
- Upgrades: `data/schema.json` holds the board's schema version; the server migrates an older board at start, after a
  git bundle backup, one commit per step, and refuses a board newer than the kit. docs/upgrade.md: back up, upgrade,
  verify, roll back.
- Board data backup (optional): with `backup.remote` the board pushes its data repo's commits every `backup.every_min`
  minutes (default 10) to one branch named for the board, fast-forward only, never forced; a commit that carries
  `run/` or a secret is refused; a URL with a password is refused at start. A failing push is a `/api/health` warning
  (never a 503) and a `dasks check` line. `dasks backup status|now`; docs/upgrade.md has the restore steps.
- Runner self-update: on a Mac that joined a fleet (`runner.update`) the runner fast-forwards its kit checkout to the
  remote's default branch between cards, runs `npm ci --omit=dev` when the lockfile changed and restarts; it holds and
  says why on a dirty, diverged or off-branch checkout or when the new kit needs a newer board schema. The heartbeat
  carries the kit commit and the hold; `dasks fleet` and the Fleet page mark machines behind the board's kit.
- Bugs first: cards of the new kind `bug` come right after your pushes in `dask ready`, MCP `ready_tasks` and the
  runner's start order. Board schema 3 (no file changes): an older kit refuses a board that may hold bug cards.
- Review triage page (More → Review, `GET /api/review-triage`): cards in review with a PR in the order to clear them
  (ready to merge, needs a fix, waiting on CI, waiting on review, stale), from the board's review records and PR status
  the board reads with bounded, cached `gh` calls. Read-only.
- Daily summary: once a day at `summary.at` (default 08:30, this Mac's time) the board writes what finished, what waits
  on you, what is stuck and what failed; shown at the top of the board until dismissed, `GET /api/summary`, MCP
  `get_summary`, `dasks summary`. Never sent anywhere.
- Fleet transport: a listen address beyond this Mac needs TLS (`server.tls`, `install.sh --tls-cert/--tls-key`) or an
  explicit, unsafe `server.allow_plain_http`; clients take https URLs and a CA file (`--ca-file`, `DASKS_CA_FILE`).
  docs/auth.md says plainly what one macOS account does not separate, and how a separate user does.
