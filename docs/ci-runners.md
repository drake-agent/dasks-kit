# CI runners on your Macs

`dasks-ci` runs your repos' GitHub Actions jobs on your own Macs as self-hosted runners: several runners per Mac, as
many as its cores and RAM can take, and a cap per Mac so it never runs more jobs at once than it can handle.

It is deliberately small: macOS only, no containers or VMs. Each runner is the official
[actions/runner](https://github.com/actions/runner) package, run as you by its own `svc.sh` LaunchAgent.

## Quick start

```bash
dasks-ci plan                                # how many jobs this Mac can run at once
dasks-ci add --repo you/app --dry-run        # what add would do
dasks-ci add --repo you/app                  # install that many runners on this Mac
dasks-ci add --repo you/app --host mac2 --count 2 --labels big
dasks-ci list --repo you/app                 # name, status, busy/idle, labels
```

Then point a workflow at them:

```yaml
jobs:
  test:
    runs-on: [self-hosted, macOS]   # or a label you gave, e.g. [self-hosted, big]
```

You need `gh`, logged in as someone with admin rights on the repo (registering a runner needs them). `--host` is an
ssh host alias from `~/.ssh/config`; without it everything happens on this Mac. ssh runs with `BatchMode=yes`, so the
host must take your key without a prompt. The other Mac needs nothing but bash and its user logged in.

**The user must be logged in at the Mac's screen.** Runners are LaunchAgents, and they live in that user's login
session (`gui/<uid>`). An ssh session alone is not enough: launchd ends a job started there about a minute after ssh
disconnects, and the runner goes offline for good. So `add` checks for the login session first
(`launchctl print gui/$(id -u)`) and, when there is none, stops before registering anything. On a Mac with no one at
it, turn on automatic login for that user (System Settings > Users & Groups) and keep it from logging out.

## What `add` does

1. Refuses a public repo (see [below](#public-repos)).
2. Reads the Mac's cores, RAM and architecture, checks the user's login session, and works out the count
   (`--count auto`, the default, is the plan number).
3. Downloads the runner for that architecture from the latest actions/runner release, checks its SHA-256 against the
   one published in that release (and again on the host), and unpacks one copy per runner into
   `~/.dasks/ci-runners/<name>/`.
4. Gets a registration token with `gh` and hands it to `config.sh --unattended` through ssh stdin and the
   `ACTIONS_RUNNER_INPUT_TOKEN` variable. It never appears in a command line, a log, a file or the output.
5. Writes the job hooks into each runner's `.env`, writes the LaunchAgent with `./svc.sh install`, and loads it into the
   login session with `launchctl bootstrap gui/<uid>` and `launchctl kickstart` (not `svc.sh start`, which from ssh
   would load it into the ssh session).
6. Waits until every runner shows `online` on GitHub, then checks each one is loaded in the login session
   (`launchctl print gui/<uid>/<label>`).

Runners are named `<host>-<owner>-<repo>-<n>` (a name over GitHub's 64 characters is cut and ends in a short hash of
the repo). Their labels are GitHub's defaults (`self-hosted`, `macOS`, the architecture) plus the host name plus your
`--labels`.

Running `add` again is safe: a runner that is already configured is not registered again (its service is checked), and
one left half made by an interrupted run is finished; a package that was not fully unpacked is unpacked again. Asking
for a larger `--count` adds the missing ones. A directory that belongs to another repo (its `.dasks-repo` says so) is
never taken over: `add` stops and names it.

If your shell traces commands (`set -x`, `SHELLOPTS`), the scripts turn tracing off before they touch a token, and
`dasks-ci` blanks the token out of anything the host prints.

## Sizing

```
jobs at once = min( floor(cores / cpu_per_job), floor((ram_gb - reserve_gb) / ram_per_job_gb) ), at least 1
```

Defaults: 2 cores and 3 GB per job, 4 GB kept for the system. A 10-core, 32 GB Mac gets min(5, 9) = 5. Change them with
`--cpu-per-job`, `--ram-per-job` and `--reserve` on `plan` and `add`. Heavy builds (Xcode, big test suites) want more
per job than the defaults.

## The job cap

Runners for several repos can live on one Mac, and GitHub does not know they share it. So every runner gets a
job-started hook and a job-completed hook (`ACTIONS_RUNNER_HOOK_JOB_STARTED` / `_COMPLETED` in its `.env`), and they
share `~/.dasks/ci-slots/` on that Mac:

- A job takes one of `max` slots before it starts (`~/.dasks/ci-slots/max`; the plan number unless you pass
  `--max-jobs N`, which sets it for every runner on that Mac, whatever the repo).
- No free slot: the job waits, up to 30 minutes (`~/.dasks/ci-slots/wait_sec`), then runs anyway and says so in its log.
  A cap that blocked forever would hang your CI.
- A slot whose job's `Runner.Worker` process is gone (a crash, a cancelled job) is freed by the next job that looks.
- The hook never fails a job. Its log is `~/.dasks/ci-slots/hook.log`.

So more runners than `max` is fine: they pick up jobs and queue for a slot on the Mac instead of on GitHub.

## Removal

```bash
dasks-ci remove --repo you/app                       # every runner of that repo on this Mac
dasks-ci remove --repo you/app --host mac2 --name mac2-you-app-3 --dry-run
```

It unloads each service from the login session (`launchctl bootout gui/<uid>/<label>`), uninstalls it, unregisters the
runner with a removal token (passed the same way as the registration token), and deletes its directory. A runner whose
service does not uninstall is kept as it is, so no LaunchAgent is left pointing at a deleted program; fix it and run
`remove` again. A runner already deleted on GitHub is cleaned up locally. `--dry-run` lists what would go and changes nothing. `~/.dasks/ci-slots/` stays for the runners that are left; delete it yourself
once none are. `uninstall.sh` removes the `dasks-ci` link but leaves your runners: remove them first.

## Public repos

`add` refuses a public repo unless you pass `--allow-public-repo`. GitHub advises against self-hosted runners on public
repos: anyone can open a pull request from a fork, and a workflow that runs on it can run their code on your Mac, as
you. Only allow it when you control which events and forks may run workflows (for example, required approval for
outside contributors).

## Limits

- **Not isolation.** Jobs run as your user, in your home, with your files, keychain and logins. A job can read and
  change anything you can. Use these runners for code you trust.
- Jobs on one Mac share it: ports, global caches, simulators, anything installed with Homebrew.
- LaunchAgents run in the login session: the Mac's user must be logged in.
- The cap is best effort. Its lock is a directory, and one older than a minute counts as left by a killed hook and is
  removed; a hook that held it that long (a very slow disk) can let two jobs past at once.
- macOS only; Linux or Windows hosts are not supported.
- Upgrading the runner is the runner's own job: it updates itself when GitHub tells it to.
