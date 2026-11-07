# HTTP API

The board serves JSON on `http://127.0.0.1:<port>` (default 4747), and on `server.listen` for a fleet, where every
request needs a machine token or the board login ([fleet.md](fleet.md)). Writes name their writer in `X-Dasks-Actor` and
carry `Authorization: Bearer <token>` (see [auth.md](auth.md)). The MCP server and the CLIs are thin clients of this API.

## Reads

| Route | What |
|---|---|
| `GET /api/health` | 200 `{ok: true, ready: true, …}` when every part works; 503 with `ok`/`ready` false and the failing part (`spec_index`, `journal`, `schema`, `files`) otherwise. `warnings` lists problems that do not stop the board (a failing backup) |
| `GET /api/board` | goals, milestones, cards and links in one reply |
| `GET /api/tasks` | every card in full; `?status=open\|all`, `fields=a,b`, `limit=` and `cursor=` page and slim it; replies of 1 KB or more are gzipped for clients that accept it, with an `ETag` |
| `GET /api/tasks/<id>` | one card with its activity, outcomes, handoff and lessons (`?log=0` leaves out the activity) |
| `GET /api/tasks/<id>/spec` | the current spec (`?version=N` an older one) |
| `GET /api/ready` | cards ready to build: open, unclaimed, deps done, spec ready (`?all=1`, `?goal=a,b`); your pushes first, then bug fixes (kind `bug`); a card whose goal has a version target also carries `version_target` |
| `GET /api/start` | one-call agent start: rules, unread messages, your cards, ready cards, cards in review, as text lines |
| `GET /api/stuck` | stuck cards and why |
| `GET /api/versions` | each goal with a `version_target`: `milestone`, `total`, `done`, `open`, `ready`, `gate_card` ([versions.md](versions.md)) |
| `GET /api/tasks/<id>/messages` | card messages (`/messages/wait` long-polls, `/participants` lists who is on the card) |
| `GET /api/merge-ok?card=&sha=` | `{ok: true}` only when you approved a merge of that card at exactly that head |
| `GET /api/views`, `/api/ideas`, `/api/lessons` | project pages, ideas for later, lessons |
| `GET /api/tasks/<id>/review-runs` | the recorded cross-model reviews of the card, one row per pass |
| `GET /api/fleet`, `/api/whoami` | runners' heartbeats; who your token says you are ([fleet.md](fleet.md)) |
| `GET /api/captain`, `/api/captain/chat?since=N` | the captain lease, harness chain and merge settings; the captain chat ([captain.md](captain.md)) |
| `GET /api/backup` | the data backup: remote, branch, last good push, failures in a row, `state` (`off`, `never`, `ok`, `failing`) ([upgrade.md](upgrade.md#backup-and-restore)) |
| `GET /api/review-triage` | cards in review with a PR, in buckets `ready`, `fix`, `ci`, `review`, `stale` (see below) |
| `GET /api/summary` | the latest daily summary (`summary: null` before the first) and `at`, the time it is written |

## Writes

| Route | What |
|---|---|
| `POST /api/tasks` | create a card (`goal`, `title`, `milestone`, optional `id`, `body`, `lane`, `priority`, …) → 201 |
| `POST /api/tasks/<id>` | update fields, add a `note`, set `now`; the context fields `what`/`why`/`do`/`rec`/`after`; `sweep: true` marks a board-tidying write (it never parks a card on the user); `job_end: <run_id>` is a job runner's close of that run (if the run's outcome already moved the card, the status is kept; a close for an older run never moves it) |
| `POST /api/tasks/<id>/claim` | take the card (`who`, `force`, `exclusive_touches`); the reply carries `run_id` and `attempt` |
| `POST /api/tasks/<id>/release` | give it back (`run_id`: only while the card is still on that run, else 409) |
| `POST /api/tasks/<id>/finish` | `result`, `status` (`done`, `review`, `blocked-on-user`), `pr`, `pr_summary` |
| `POST /api/tasks/<id>/outcome` | a run's outcome (`state`, `note`, `evidence`, `job`, `run_id`, `attempt`); a failed one counts toward the retry cap |
| `PUT /api/tasks/<id>/spec` | store the next spec version (`text`, `expected_spec_version`) |
| `POST /api/tasks/<id>/spec/review\|block\|unblock` | review the spec text, block it for Spec, lift a block |
| `POST /api/tasks/<id>/messages` | send a card message |
| `POST /api/tasks/<id>/review-runs` | record one cross-model review pass, 1 or 2 (`pass`, `head`, `reviewer`, `impl`, `verdict`, `open`, `answer`, …); the board adds the sender's family and the card's builders |
| `POST /api/nodes/<id>` | edit a goal, milestone or the north star (`title`, `title_ko`, `title_en`, `why`, …); a goal also takes `profile` ([cards.md](cards.md#project-profile)) and `version_target`, a milestone of that goal or empty ([versions.md](versions.md)) |
| `POST /api/fleet/heartbeat` | a runner's heartbeat |
| `POST /api/backup/now` | push the data repo to `backup.remote` now; 200 with the status, 502 when the push failed, 409 when no remote is set |
| `POST /api/captain/lease`, `/lease/release`, `/lease/check` | take, renew, release or check the captain lease (409 with the holder) |
| `POST /api/captain/chat` | `{text}` from the logged-in human, or `{text, lease_id}` from the lease holder |

Optimistic locking: most writes take `expected_version` and answer 409 when the card moved on. Refusals carry
`{error, rule?, reasons?}`.

## Review triage

`GET /api/review-triage` (the board page More → Review) puts every card in review that has a GitHub PR into one bucket,
in the order to clear them; the first rule that matches wins:

| Bucket | Rule |
|---|---|
| `ready` | CI green (or the PR has no checks) and a clean review recorded for the PR's head; or the PR is merged (close the card) |
| `fix` | CI red, open findings in the review of the head, or the PR was closed without a merge |
| `stale` | nothing moved for `review.stale_days` (default 3): the card, the PR and its reviews |
| `ci` | checks still running, or the PR's status is not known yet |
| `review` | no review recorded for the PR's head (`dask review-record`, or the runner's own) |

The page shows them as ready, fix, CI, review, stale. Inside a bucket: priority, then the longest wait. PR status is read
by the board with `gh pr view` (at most 4 at a time, 20 s each, 60 per sweep; a PR read in the last 5 minutes is not read
again) and kept in `run/pr-status.json`; the browser never calls GitHub. Without `gh` every PR stays in `ci` as unknown.
The page is read-only.

## Daily summary

Once a day at `summary.at` (config, `HH:MM`, default `08:30`, this Mac's time zone; a board that was off then writes it
within a minute of starting) the board writes a summary to `run/summary.json`: cards finished since the previous summary, cards
waiting on you (open decisions, approvals asked in `needs_user`, cards blocked on you), quiet machines and cards with no
news, failed runs and board warnings, and any steps an unattended run skipped for you (`skipped`, the section is left out
when there are none). It is shown at the top of the board until you press Got it (per browser), and read
with `GET /api/summary`, MCP `get_summary` and `dasks summary`. It is never sent anywhere.

A skipped step is any card note in the form `HUMAN-STEP: <step> -- <why>` ([runner.md](runner.md#what-one-run-does)). It stays
on the list every day while its card is open. When the card is done the step closes: it is listed once more only if it was
noted since the last summary, so you still see it. A cancelled card lists none, and the same step noted twice on a card is
one entry.
