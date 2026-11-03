# Secrets for agents: `dasks-secret`

`dasks-secret` lets a coding agent run a command that needs an API key without the key ever passing through the chat,
the agent's context, a file in the repo or the shell history. You type each value once into a native masked window; it
lives in your login Keychain. When an agent needs it, it asks `dasks-secret run`, you approve that one run with Touch ID
(or your password), and the command starts with the value in an environment variable. The agent sees the command's
output, never the value.

It is optional, macOS only and local only: no server, no sync, no backup. Install it with

```bash
./install.sh --with-secrets      # builds secret/ with swift; needs the Xcode Command Line Tools (xcode-select --install)
```

Without the Command Line Tools the installer skips it and says so; the rest of Dasks works the same.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `dasks-secret store --label L [--replace]` | human | Opens a masked window (NSSecureTextField) for the value. `--replace` overwrites after a native confirm and keeps L's agents. |
| `dasks-secret run --labels a,b [--agent NAME] -- <cmd> [args…]` | agent | One Touch ID / password prompt showing the agent, the requesting process, the labels and the full command. On approval it `exec`s the command with `A`, `B` set; it prints nothing else. |
| `dasks-secret allow --label L --agent A` | human | Lets agent A use L through `run` (Touch ID). |
| `dasks-secret disallow --label L --agent A` | human | Takes that back (Touch ID). |
| `dasks-secret list [--json]` | anyone | Labels and their agents. No prompt, no values. |
| `dasks-secret check --labels a,b [--agent A] [--json]` | anyone | Stored / allowed per label. No prompt, no values. Exit 0 ready, 10 not. |
| `dasks-secret delete --label L` | human | Removes L after a native confirm. |

There is no `show`, no export to a file and no rotate, backup or recovery: a value leaves the Keychain only into the
environment of a command you approved. To change a value, `store --replace`.

**Labels** are `a-z 0-9 . _ -` (first a letter or digit, at most 89), the same names a card's `secrets:` field takes. The
variable is the label in upper case with `-` and `.` as `_`: `google-places-api-key` → `GOOGLE_PLACES_API_KEY` (a leading
digit gets a `_`). A label whose variable a shell, loader or common tool reads as its own setting is refused at `store`
and at `run`, because the tool may act on it or print it back (git prints a bad `GIT_TRACE`): by prefix `GIT_`, `PYTHON`,
`NODE_`, `NPM_CONFIG_`, `YARN_`, `LD_`, `DYLD_`, `BASH`, `PS1`-`PS4`, `PERL`, `RUBY`, `JAVA_`, `JDK_`, `SSH_`, `LC_`,
`MALLOC_`, `DASKS_` and more, and names such as `PATH`, `HOME`, `SHELLOPTS`, `IFS`, `ENV`. So are two labels that map to one
name. Name labels after the service (`github-token`, `npm-token`, `openai-api-key` are fine).

**Agents.** `dasks-secret` looks up its own process tree: under `claude` the caller is `claude-code`, under `codex` it is
`codex`; with neither it is you. A real executable named `claude` / `codex` counts first; a process's arguments (`node
…/codex.js`) count only where no executable says otherwise, and a process whose arguments name one runtime under an
executable of the other (`exec -a claude bash` under codex) is refused (`agent_mismatch`). `--agent` may name a lane under the caller's runtime (`claude-code.review`), never you
and never the other runtime. Each label has its own allowlist of agent names; a lane must be listed itself.

## A run, step by step

1. The command is resolved first: PATH lookup, every symlink followed, the file's identity noted. Both the typed name
   and the real file's name are checked against the refusal list (agents only, below) → `refused_command`, so `./safe`
   pointing at `printenv` is refused. The prompt shows that file.
2. Every stored label must list the agent → otherwise `agent_not_allowed`, before any prompt. The error carries the
   exact `allow` line for you; the agent prints it and waits. It never runs it: `allow` and `disallow` refuse callers
   under an agent (`human_only`).
3. A label that is not stored opens the masked window with that label filled in, then stops with `label_missing`. The
   agent asks again after you stored (and allowed) it.
4. One approval prompt. Declined or closed → `user_cancelled`; nothing runs.
5. The name must still resolve to the same file, unchanged (device, inode, size, times, mode); otherwise
   `target_changed` and nothing runs. The decision is written to the audit log (no log line, no run: `audit_failed`),
   then that exact file replaces `dasks-secret` (`execve`) with the values in its environment. A file swapped in the
   microseconds between that last check and `execve` is not caught.

**Refused for agents** (a speed bump, see below): shells (`sh`, `bash`, `zsh`, …), `env`, `printenv`, interpreters
unless they run an existing script file (or `python -m module`): an inline program anywhere before the script (`node -e`,
`node -pe`, `node -r x -e`, `python3 -W ignore -c`, `perl -Ilib -e`, …), no script, stdin (`-`), or a "script" that is
not a file here are all refused, with each interpreter's options that take a value parsed as such, and an option
before the script that the tool does not know is refused too (write it as `--opt=value` or put it after the script); `awk`,
network tools (`curl`, `wget`, `nc`, `ssh`, `scp`, `rsync`, `gh`, `openssl`, …), wrappers that hide the real command
(`sudo`, `xargs`, `nohup`, `timeout`, `nice`, `time`, `osascript`, `open`, `security`, `find`, `npx`, …), `git push` (and
`git remote`, `git config`), and publishing commands (`npm publish`, `cargo publish`, `docker push`, `twine upload`, …).
Use a script file instead: `dasks-secret run --labels maps-key -- node scripts/geocode.js`.

**Errors** are one line on stderr, `dasks-secret: <code>: <detail>`, with a stable code: `usage`, `value_not_accepted`,
`invalid_label`, `invalid_agent`, `invalid_env_name`, `agent_mismatch`, `human_only`, `refused_command`,
`agent_not_allowed`, `label_missing`, `label_exists`, `empty_value`, `user_cancelled`, `keychain_error`, `audit_failed`,
`exec_failed`, `target_changed`. Exit status: 2 usage, 3 refused, 4 label missing, 5 cancelled, 6 exists or empty, 1 other.

**Audit log**: `~/.dasks/secret-audit.log` (mode 0600), one JSON line per decision: time, action, agent, process,
labels, command, outcome. Never a value.

## Cards and the runner

A card names what it needs in its `secrets:` field (`dasks update <card> --secrets places-key,maps-key`; names only).

- `dask secrets <card>` checks those labels for the current agent (`claude-code` in Claude Code, `codex` in Codex,
  `--agent` to choose) and prints what is missing and the exact lines for you to run. Exit 0 when ready.
- The runner checks a card's labels for the agent that would build it before it claims the card. If one is missing or
  not allowed, it does not start the card, posts one message on the card (to `human`, kind `blocked-on`) with the labels
  and the commands, and moves on; it tries again on its next look (also when the card could not be read). If `dasks-secret` is not installed on that Mac, the
  message says so.

## What it protects, and what it does not

It protects against the common leaks: a key pasted into chat (and so into the agent's context, logs and transcripts),
a key in a `.env` file the agent reads or commits, a key in shell history or in a command line others can see with `ps`,
and an agent quietly using a key you did not mean it to use or running a command you did not see.

It does **not** protect against:

- **Other processes running as you.** Anything under your macOS account can talk to your login Keychain (reading a
  value made by `dasks-secret` makes macOS ask you first), read or edit the audit log, and may be able to change a
  label's agent list (it sits in the item's attributes). The allowlist and the refusal list are speed bumps for agents
  that follow their instructions, not a sandbox.
- **The approved command itself.** Once you approve a run, that command has the value in its environment and can print
  it, write it to a file or send it anywhere. Read the command in the prompt; approve only commands you understand.
  The refusal list only removes the obvious ways (a shell, `env`, `-e`); a script the agent wrote can still do them.
- **Process-tree tricks.** Agent detection reads the parent processes. Something started outside the agent's tree (for
  example through `launchctl`) looks like you. The prompt always says who asked and which process.
- **A compromised Mac**, malware, or someone at your unlocked keyboard.

**Keychain details.** `dasks-secret` first tries the data protection keychain with an access control that requires user
presence for every read. A binary built from source has no keychain entitlement, so macOS refuses that, and the item
goes to the file-based login keychain (service `dev.dasks.secret`, one item per label) where only this binary may read it
without a macOS dialog; the run approval (LocalAuthentication) is the Touch ID gate. After a rebuild (`./install.sh
--with-secrets` again) macOS may ask once whether `dasks-secret` may use its items: choose Always Allow. If any other
program (for example `security`) asks for a `dasks secret: …` item, deny it unless you started it.

**Remove everything:** `dasks-secret list`, then `dasks-secret delete --label <name>` for each, then `./uninstall.sh`.

## Developing it

```bash
cd secret && swift test            # unit tests: labels, env names, refusals, agents, allowlist, audit, argument rules
node --test --import=./test/file-limit-preload.ts test/secrets.test.ts   # dask secrets, runner pre-check (fake dasks-secret)
```

The Keychain, the windows and Touch ID sit behind protocols (`SecretStore`, `HumanPrompts`, `CommandExecutor`), so the
tests use fakes. A CI job could run `swift test` too: on a `macos-latest` runner, add a step `run: swift test` with
`working-directory: secret` (the Command Line Tools are already there).
