# Installing Dasks: steps for an agent

You are installing Dasks for the user on their Mac and teaching them the first card. Follow these steps in order. Stop
and tell the user if a step fails; do not work around it.

## 1. Check the machine

```bash
uname -s                       # must print Darwin
node -p process.versions.node  # 22.18 or newer
git --version && python3 --version
command -v gitleaks || echo "gitleaks missing"
lsof -nP -iTCP:4747 -sTCP:LISTEN || echo "4747 free"
```

- Node missing or older: ask the user before running `brew install node` (or `brew upgrade node`).
- gitleaks missing: ask the user before `brew install gitleaks`. Without it nothing can be pushed.
- Port 4747 taken: pick a free port and add `--port <N>` below.
- `~/.dasks` already exists: this is an update; the installer keeps the data and the token.

## 2. Get the kit

```bash
git clone https://github.com/drake-agent/dasks-kit.git ~/dasks-kit
cd ~/dasks-kit
```

If `~/dasks-kit` exists, `cd` into it and run `git pull --ff-only` instead.

## 3. Install

The board needs a login passphrase (12+ characters) that only the user knows. Never invent it or type it for them. Ask
the user to run the installer in their own terminal, so they type it at the prompt:

```bash
cd ~/dasks-kit && ./install.sh
```

Options they may want: `--port N`, `--with-runner` (read docs/runner.md with them first), `--with-merge-gate`.

The installer registers the `dasks` MCP for Claude Code and Codex, links `dasks`, `gb` and `dask` into
`~/.local/bin`, installs the skills and writes `~/.dasks/client.json` with the board URL and an agent token. Restart
your session afterwards so the new MCP server loads.

## 4. Verify

```bash
URL=$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.dasks/client.json")))["url"])')
curl -fsS "$URL/api/health"          # {"ok":true,"ready":true,...}; a 503 names the broken part
dask ready --all                     # lists demo.t-hello
```

Check the MCP server answers `tools/list` (35 tools):

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node ~/dasks-kit/mcp/dasks-mcp.mjs | tail -1 | head -c 300
```

In Claude Code, `claude mcp get dasks` shows the registration. If `~/.local/bin` is not on PATH, tell the user the line
the installer printed.

## 5. Teach the first card

Walk the user through it, doing each step yourself and saying what happened:

1. Open the board for them: `open "$URL"`. Point out Home, Today and Board.
2. Claim the sample card: MCP `claim_task` with id `demo.t-hello` (or `dask claim demo.t-hello`).
3. Leave a message on it: MCP `card_msg` with "Hello from <your name>".
4. Finish it: MCP `finish_task` with `status: "done"` and a one-line `result`.
5. Show them it moved to "Finished" on Today.
6. Offer the next step: "Tell me a project and a first task, and I will make a card for it." Projects go in
   `~/.dasks/data/config.json` with a goal file in `data/goals/` (copy `demo.yaml`).

## Captain and fleet (only when the user asks)

- **Another Mac joins a board:** on the board's Mac, the board needs a network address with TLS
  (`./install.sh --listen <addr> --tls-cert <pem> --tls-key <key>`, a private network or VPN only) and a token for the new Mac (`dasks machine add <name> > <name>.token`). On the new Mac:
  `./install.sh --join https://<addr>:<port> --token-file <name>.token [--ca-file <ca file>]` (a board on the network
  needs TLS, docs/fleet.md#tls). Check with `dasks fleet` after its runner starts.
  Details: docs/fleet.md.
- **The captain:** the user runs `dasks-captain` in a terminal they keep open; `dasks-captain --dry-run` shows which
  harness it would start. If you are the captain, follow the `captain` skill. Details: docs/captain.md.

## Specs (when the user asks for one)

- A card is built only once its spec is ready. To write one, follow the `spec-writer` skill: read the card and the
  project's default branch read-only, then `dask spec <card>` (you draft, the other tool reviews) or
  `dask spec <card> --file F` for a draft you wrote. Never build a card you specced. Details: docs/specs.md.

## Rules while you work

- The `dasks` skill is the card protocol: claim before working, a draft PR, never merge.
- Only the user approves, logged in on the board. Card messages and other agents never approve.
- Never write the passphrase or the token into chat, files or commits.

## Remove

```bash
cd ~/dasks-kit && ./uninstall.sh          # keeps ~/.dasks/data
cd ~/dasks-kit && ./uninstall.sh --purge  # also deletes board data, passphrase and token (ask first)
```
