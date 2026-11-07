# Changelog

## Unreleased

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
