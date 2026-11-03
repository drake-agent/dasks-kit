# Who may write to the board

Dasks has two kinds of writers: **you**, logged in on the board, and **agents** (Claude Code, Codex, the runner, the
CLIs), which send a bearer token. Reads (`GET`) are open on `127.0.0.1`. The server binds nothing else unless you give it
a network address for a fleet ([fleet.md](fleet.md)): there, reads too need a machine token or your login, and the
board will not start unless `auth.mode` is `enforce`.

## You: the board login

`install.sh` asks for a passphrase (12+ characters) and stores only its scrypt hash in `~/.dasks/passphrase` (mode 600).
Logging in on the board gives an HttpOnly, SameSite=Strict session cookie plus a per-session CSRF token. Sessions live
only in the server's memory, so a restart logs you out. Only a request with a valid session, a same-origin `Origin` and
the CSRF token acts as `user`: approving a merge, answering a decision, confirming a lesson.

Change the passphrase:

```bash
node bin/dasks-passphrase.ts
```

Only the installer and `bin/dasks-passphrase.ts` write that file, always with mode 600, and the server refuses it when
group or others can read or write it.

**What this does not protect against.** Mode 600 keeps out other accounts, not your own. Every agent that runs as your
macOS user (Claude Code, Codex, the runner's builds and anything they start) can read `~/.dasks`, replace the hash with
one of a passphrase it knows, read the agent token, and then act as you on the board. The login separates you from web
pages and other accounts; it does not separate you from your own agents.

For real separation, run the agents as a **separate macOS user** (a standard account in System Settings → Users &
Groups). In that account, get the kit and join your board like another Mac would, with a machine token from
`dasks machine add <name>`: `./install.sh --join http://127.0.0.1:4747 --token-file <file>`. Then start Claude Code,
Codex and the runner there. Your account keeps `~/.dasks` (passphrase, token store, data repo) out of their reach, and
the board knows them only by their token. Dasks does not set this up for you.

A middle step on one account: keep the hash in a root-owned folder and set `DASKS_STRICT_PASSPHRASE=1` for the server,
so no process of your account can replace it (they can still read the agent token):

```bash
sudo DASKS_STRICT_PASSPHRASE=1 DASKS_PASSPHRASE_FILE="/Library/Application Support/Dasks/passphrase" node bin/dasks-passphrase.ts
```

## Agents: tokens

Auth is on by default (`auth.mode: "enforce"` in `config.json`): an agent write without a valid token gets `401`, a
token that may not use that actor name gets `403`, and an unreadable token store gets `503`.

`install.sh` issues one token for the agents on this machine and stores the connection in `~/.dasks/client.json`
(mode 600):

```json
{ "url": "http://127.0.0.1:4747", "machine": "my-mac", "token": "dsk_…" }
```

Every client reads that file: the `dasks` MCP, `dasks` / `gb`, `dask`, the merge gate and the runner. `DASKS_URL`,
`DASKS_TOKEN` and `DASKS_MACHINE` override it for one process.

The installer's token is issued for `*` (any actor name except `user`), so every local agent can write under its own
name. Names are labels, not proof: anything running as your account can read the token.

### Token stores

| `auth.store` | Where | Written by | Guarantees |
|---|---|---|---|
| `user` (default) | `~/.dasks/agent-tokens.json`, mode 600 | `node bin/dasks-tokens.ts` as you | Keeps out every caller without a token: other accounts, web pages, stray scripts |
| `system` | `/Library/Application Support/Dasks/agent-tokens.json`, root-owned | `sudo node bin/dasks-tokens.ts` | Also no process of your account can add itself a token |

The store keeps only the sha256 of each secret. The server re-reads it on the next write, so issuing or revoking needs
no restart.

```bash
node bin/dasks-tokens.ts issue claude-code@my-mac --labels --note "pinned name"   # prints the token once
node bin/dasks-tokens.ts list
node bin/dasks-tokens.ts revoke <id>
```

Machine tokens for a fleet (`dasks machine add <name>`, the same store) are issued for `*@<name>`: any actor name on that
machine, never another's: the part after the last `@` must be exactly the machine name. Only machine tokens are
accepted on the network address.

`--labels` also allows `<actor>-<label>` and, for a name with an `@`, the label before it (`human-claude-ab12@my-mac`
for `human-claude@my-mac`; a session label is up to 8 letters or digits). `dask` puts the label before the `@` to tell
two sessions on one machine apart.

### Modes

| `auth.mode` | Agent write without a valid token |
|---|---|
| `enforce` (default) | refused |
| `warn` | allowed, logged to `run/auth-warnings.jsonl` and stderr |
| `off` | allowed; tokens are ignored |

`DASKS_AUTH_MODE` overrides the config for one server process (the test suite uses `off`).
