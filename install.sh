#!/bin/bash
# Dasks installer: the board server, its web UI, the dasks MCP for Claude Code and Codex, the dasks / gb / dask CLIs and
# the agent skills, on this machine. Idempotent: run it again to repair or update; board data is never overwritten.
# Everything goes under $HOME. What it makes is listed in ~/.dasks/install.json; updates and uninstall.sh touch only that.
#   ./install.sh [--dry-run] [--port N] [--passphrase-file F] [--no-launchd] [--no-claude-mcp] [--no-codex-mcp]
#                [--with-merge-gate] [--with-runner] [--with-secrets]
#                [--listen ADDR] [--tls-cert F --tls-key F --ca-file F | --allow-plain-http]
#   ./install.sh --join URL --token-file F [--machine NAME] [--ca-file F] [...]   this Mac joins a fleet: clients only
set -euo pipefail

KIT=$(cd "$(dirname "$0")" && pwd)
DASKS_HOME="$HOME/.dasks"
DATA="$DASKS_HOME/data"
BIN="$HOME/.local/bin"
AGENTS="$HOME/Library/LaunchAgents"
LABEL=dev.dasks.server
RLABEL=dev.dasks.runner
RECORD="$DASKS_HOME/install.json"
CLIENT="$DASKS_HOME/client.json"
PORT=""; PASSFILE=""; DRY=0; LAUNCHD=1; CLAUDE_MCP=1; CODEX_MCP=1; GATE=0; RUNNER=0; SECRETS=0; LISTEN=""; JOIN=""; TOKFILE_IN=""; MACHINE_IN=""
TLS_CERT=""; TLS_KEY=""; CA_FILE=""; PLAIN_HTTP=0

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --port) PORT=${2:?--port needs a number}; shift ;;
    --passphrase-file) PASSFILE=${2:?--passphrase-file needs a path}; shift ;;
    --no-launchd) LAUNCHD=0 ;;
    --no-claude-mcp) CLAUDE_MCP=0 ;;
    --no-codex-mcp) CODEX_MCP=0 ;;
    --with-merge-gate) GATE=1 ;;
    --with-runner) RUNNER=1 ;;
    --with-secrets) SECRETS=1 ;;
    --listen) LISTEN=${2:?--listen needs an address}; shift ;;
    --join) JOIN=${2:?--join needs the board URL}; shift ;;
    --token-file) TOKFILE_IN=${2:?--token-file needs a path}; shift ;;
    --machine) MACHINE_IN=${2:?--machine needs a name}; shift ;;
    --tls-cert) TLS_CERT=${2:?--tls-cert needs a PEM file}; shift ;;
    --tls-key) TLS_KEY=${2:?--tls-key needs a PEM file}; shift ;;
    --ca-file) CA_FILE=${2:?--ca-file needs a PEM file}; shift ;;
    --allow-plain-http) PLAIN_HTTP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
case $PORT in ''|*[!0-9]*) [ -z "$PORT" ] || { echo "install.sh: --port must be a number" >&2; exit 2; } ;; esac
if [ -n "$JOIN" ]; then
  [ -n "$TOKFILE_IN" ] || { echo "install.sh: --join needs --token-file (from dasks machine add <name> on the board's Mac)" >&2; exit 2; }
  [ -z "$PORT$PASSFILE$LISTEN" ] || { echo "install.sh: --port, --passphrase-file and --listen are for the board's Mac, not --join" >&2; exit 2; }
  case $JOIN in http://*|https://*) ;; *) echo "install.sh: --join takes the board URL, e.g. http://10.0.0.5:4747" >&2; exit 2 ;; esac
  JOIN=${JOIN%/}
  [ -z "$TLS_CERT$TLS_KEY" ] && [ $PLAIN_HTTP = 0 ] || { echo "install.sh: --tls-cert, --tls-key and --allow-plain-http are for the board's Mac, not --join" >&2; exit 2; }
elif [ -n "$TOKFILE_IN$MACHINE_IN" ]; then echo "install.sh: --token-file and --machine go with --join" >&2; exit 2; fi
{ [ -z "$TLS_CERT" ] && [ -z "$TLS_KEY" ]; } || { [ -n "$TLS_CERT" ] && [ -n "$TLS_KEY" ]; } || { echo "install.sh: --tls-cert and --tls-key go together" >&2; exit 2; }
[ -z "$TLS_CERT" ] || [ $PLAIN_HTTP = 0 ] || { echo "install.sh: --allow-plain-http and --tls-cert exclude each other" >&2; exit 2; }
for f in "$TLS_CERT" "$TLS_KEY" "$CA_FILE"; do [ -z "$f" ] || [ -r "$f" ] || { echo "install.sh: cannot read $f" >&2; exit 2; }; done
abspath() { [ -z "$1" ] || (cd "$(dirname "$1")" && printf '%s/%s' "$(pwd)" "$(basename "$1")"); }
TLS_CERT=$(abspath "$TLS_CERT"); TLS_KEY=$(abspath "$TLS_KEY"); CA_FILE=$(abspath "$CA_FILE")

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
run() { if [ $DRY = 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
helper() { run python3 "$KIT/scripts/installer.py" "$@"; }
recall() { python3 "$KIT/scripts/installer.py" record "$RECORD" get "$1" 2>/dev/null; }
recorded() { recall "$1" | grep -qxF -- "$2"; }
remember() { [ $DRY = 1 ] || python3 "$KIT/scripts/installer.py" record "$RECORD" add "$1" "$2"; }
note() { [ $DRY = 1 ] || python3 "$KIT/scripts/installer.py" record "$RECORD" set "$1" "$2"; }

# ---------- 1. prerequisites ----------
say "Checking prerequisites"
[ "$(uname -s)" = Darwin ] || fail "this kit is for macOS (uname says $(uname -s))."
command -v git >/dev/null || fail "git is missing. Fix: xcode-select --install"
command -v python3 >/dev/null || fail "python3 is missing. Fix: xcode-select --install   (or: brew install python)"
NODE=$(command -v node || true)
[ -n "$NODE" ] || fail "node is missing. Fix: brew install node   (Node 22.18 or newer)"
NODE_V=$("$NODE" -p 'process.versions.node')
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || fail "node $NODE_V is too old (need 22.18+). Fix: brew upgrade node"
if ! "$NODE" "$KIT/src/lib/node-floor.ts"; then
  [ "${DASKS_ALLOW_UNPATCHED_NODE:-}" = 1 ] || fail "update node first, then run the installer again (DASKS_ALLOW_UNPATCHED_NODE=1 installs anyway)"
  say "installing on a node without its security fixes (DASKS_ALLOW_UNPATCHED_NODE=1)"
fi
command -v npm >/dev/null || fail "npm is missing (it comes with node). Fix: brew reinstall node"
MACHINE=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' | cut -c1-16); MACHINE=${MACHINE:-local}
[ -n "$MACHINE_IN" ] && MACHINE=$MACHINE_IN
echo "   node $NODE_V, git, python3 ok; this machine is \"$MACHINE\""
if ! command -v gitleaks >/dev/null; then
  echo "   gitleaks is missing: dask submit pushes nothing without its secret scan."
  if [ $DRY = 0 ] && [ -t 0 ] && command -v brew >/dev/null; then
    printf '   Install it now with Homebrew (brew install gitleaks)? [Y/n] '
    read -r ans || ans=n
    case $ans in [nN]*) echo "   skipped: install it later with brew install gitleaks" ;; *) brew install gitleaks ;; esac
  else
    echo "   Fix: brew install gitleaks"
  fi
fi

# ---------- 2. dependencies ----------
# A developer checkout (TypeScript installed for npm run verify) keeps its dev tools: --omit=dev would prune them.
OMIT=--omit=dev; [ -d "$KIT/node_modules/typescript" ] && OMIT=
say "Installing node dependencies (npm install $OMIT)"
if [ $DRY = 1 ]; then echo "   [dry-run] npm install $OMIT in $KIT"; else
  (cd "$KIT" && npm install $OMIT --no-audit --no-fund --silent)
fi

if [ -n "$JOIN" ]; then
  # ---------- 3-5 (join). the stored connection to a board on another Mac; no board here ----------
  say "Joining the fleet at $JOIN"
  [ -r "$TOKFILE_IN" ] || fail "cannot read --token-file $TOKFILE_IN"
  run mkdir -p "$DASKS_HOME"
  run chmod 700 "$DASKS_HOME"
  if [ $DRY = 1 ]; then echo "   [dry-run] check the token against $JOIN and write $CLIENT"; else
    CA_ENV=(); [ -z "$CA_FILE" ] || CA_ENV=(NODE_EXTRA_CA_CERTS="$CA_FILE")
    WHO=$(env ${CA_ENV[@]+"${CA_ENV[@]}"} "$NODE" -e '
      const [url, file, want] = process.argv.slice(1);
      const tok = require("fs").readFileSync(file, "utf8").trim();
      fetch(url + "/api/whoami", { headers: { Authorization: "Bearer " + tok } }).then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { console.error("the board refused the token: " + r.status + " " + (j.error || "")); process.exit(1); }
        if (!j.machine) { console.error("that is not a machine token (make one with: dasks machine add <name>)"); process.exit(1); }
        if (want && want !== j.machine) { console.error("the token is for machine " + j.machine + ", not " + want); process.exit(1); }
        console.log(j.machine);
      }, (e) => { console.error("board unreachable at " + url + " (" + (e.cause?.code || e.message) + ")"); process.exit(1); });' "$JOIN" "$TOKFILE_IN" "$MACHINE_IN") || fail "could not join $JOIN"
    MACHINE=$WHO
    helper client "$CLIENT" "$JOIN" "$MACHINE" "$TOKFILE_IN" "$CA_FILE"
    note mode join
  fi
  URL=$JOIN
  echo "   this Mac is \"$MACHINE\" in the fleet"
else
# ---------- 3. data repo ----------
say "Board data in $DATA"
run mkdir -p "$DASKS_HOME"
run chmod 700 "$DASKS_HOME"
INIT_ARGS=(--root "$DATA"); [ -n "$PORT" ] && INIT_ARGS+=(--port "$PORT")
run "$NODE" --disable-warning=ExperimentalWarning "$KIT/src/cli/init.ts" "${INIT_ARGS[@]}"
if [ -z "$PORT" ]; then
  PORT=$("$NODE" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).server?.port||4747)}catch{console.log(4747)}' "$DATA/config.json")
fi
# server.tls on the board (this run's --tls-cert, or set before): every listener is https, this Mac's clients too.
if [ -n "$TLS_CERT" ]; then
  say "TLS: the board serves https with $TLS_CERT (docs/fleet.md)"
  if [ $DRY = 1 ]; then echo "   [dry-run] would set server.tls in $DATA/config.json"; else
    "$NODE" -e 'const fs=require("fs"),[f,c,k]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(f,"utf8"));j.server={...(j.server||{}),tls:{cert:c,key:k}};delete j.server.allow_plain_http;fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$DATA/config.json" "$TLS_CERT" "$TLS_KEY"
  fi
fi
if [ $PLAIN_HTTP = 1 ] && [ $DRY = 0 ]; then
  "$NODE" -e 'const fs=require("fs"),[f]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(f,"utf8"));j.server={...(j.server||{}),allow_plain_http:true};fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$DATA/config.json"
  echo "   server.allow_plain_http=true: UNSAFE, tokens and the passphrase cross the network in clear"
fi
if [ $DRY = 0 ] && { [ -n "$TLS_CERT" ] || [ $PLAIN_HTTP = 1 ]; } && [ -n "$(git -C "$DATA" status --porcelain -- config.json 2>/dev/null)" ]; then
  git -C "$DATA" -c user.name="dasks install" -c user.email=install@dasks.invalid commit -q -m "server.tls / allow_plain_http (install.sh)" -- config.json || true
fi
HAS_TLS=$( [ $DRY = 1 ] && [ -n "$TLS_CERT" ] && echo 1 || "$NODE" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).server?.tls?1:0)}catch{console.log(0)}' "$DATA/config.json")
if [ "$HAS_TLS" = 1 ]; then
  URL="https://127.0.0.1:$PORT"
  [ -n "$CA_FILE" ] || CA_FILE=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("ca",""))' "$CLIENT" 2>/dev/null || true)
  [ -n "$CA_FILE" ] || echo "   note: no --ca-file: clients trust only the system's CAs (fine for a certificate from a public CA)"
else URL="http://127.0.0.1:$PORT"; fi
if [ -n "$LISTEN" ]; then
  # Beyond this Mac the board needs TLS (or an explicit, unsafe allow_plain_http): say so now, not as a board that won't start.
  case $LISTEN in 127.*|::1) ;; *)
    if [ "$HAS_TLS" != 1 ] && [ $PLAIN_HTTP = 0 ] && ! grep -q '"allow_plain_http": true' "$DATA/config.json" 2>/dev/null; then
      fail "--listen $LISTEN needs TLS: add --tls-cert F --tls-key F (and --ca-file F for your own CA), see docs/fleet.md. Or --allow-plain-http (unsafe: tokens and the passphrase in clear)"
    fi ;;
  esac
  say "Board on the network: $LISTEN:$PORT (docs/fleet.md)"
  if [ $DRY = 1 ]; then echo "   [dry-run] would set server.listen=$LISTEN in $DATA/config.json"; else
    "$NODE" -e 'const fs=require("fs"),net=require("net"),[f,a]=process.argv.slice(1);if(!net.isIP(a)){console.error("--listen must be an IP address");process.exit(2)}const c=JSON.parse(fs.readFileSync(f,"utf8"));c.server={...(c.server||{}),listen:a};fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$DATA/config.json" "$LISTEN" || fail "--listen must be an IP address"
    if [ -n "$(git -C "$DATA" status --porcelain -- config.json 2>/dev/null)" ]; then
      git -C "$DATA" -c user.name="dasks install" -c user.email=install@dasks.invalid commit -q -m "server.listen=$LISTEN (install.sh --listen)" -- config.json || true
    fi
    echo "   server.listen=$LISTEN. Give each Mac its own token: dasks machine add <name>"
  fi
fi

# ---------- 4. login passphrase and agent token ----------
PASS_OUT="$DASKS_HOME/passphrase"
say "Board login passphrase ($PASS_OUT, mode 600)"
if [ -n "$PASSFILE" ]; then
  [ -r "$PASSFILE" ] || fail "cannot read --passphrase-file $PASSFILE"
  if [ $DRY = 1 ]; then echo "   [dry-run] store the hash of the passphrase in $PASSFILE"; else
    head -n1 "$PASSFILE" | DASKS_PASSPHRASE_FILE="$PASS_OUT" "$NODE" --disable-warning=ExperimentalWarning "$KIT/bin/dasks-passphrase.ts" --stdin
  fi
elif [ -s "$PASS_OUT" ]; then
  echo "   already set (change it with: node $KIT/bin/dasks-passphrase.ts)"
elif [ $DRY = 1 ]; then
  echo "   [dry-run] would ask for a passphrase (12+ characters) and store its hash"
elif [ -t 0 ]; then
  DASKS_PASSPHRASE_FILE="$PASS_OUT" "$NODE" --disable-warning=ExperimentalWarning "$KIT/bin/dasks-passphrase.ts"
else
  echo "   skipped (no terminal): set it later with  node $KIT/bin/dasks-passphrase.ts"
fi

say "Agent token and connection ($CLIENT, mode 600)"
if [ $DRY = 1 ]; then echo "   [dry-run] issue an agent token (if none is stored) and write $CLIENT for $URL"
elif python3 "$KIT/scripts/installer.py" has-token "$CLIENT"; then
  helper client "$CLIENT" "$URL" "$MACHINE" "" "$CA_FILE"
else
  TOKFILE=$(mktemp "$DASKS_HOME/.token.XXXXXX")
  DASKS_ROOT="$DATA" "$NODE" --disable-warning=ExperimentalWarning "$KIT/bin/dasks-tokens.ts" issue '*' --note "install.sh: agents on $MACHINE" > "$TOKFILE"
  helper client "$CLIENT" "$URL" "$MACHINE" "$TOKFILE" "$CA_FILE"
  rm -f "$TOKFILE"
fi

# ---------- 5. LaunchAgent ----------
BASE_PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"
if [ $LAUNCHD = 1 ]; then
  say "LaunchAgent $LABEL (starts the board at login, restarts it if it stops)"
  PLIST="$AGENTS/$LABEL.plist"
  if [ -e "$PLIST" ] && ! recorded plists "$PLIST"; then
    echo "   $PLIST exists and was not made by this installer: left as it is"
  elif [ $DRY = 1 ]; then echo "   [dry-run] would write $PLIST and load it"; else
    helper plist "$PLIST" "$LABEL" "$DATA" "$DASKS_HOME/server.log" "$BASE_PATH" "$DATA" "$HOME" -- "$NODE" --disable-warning=ExperimentalWarning "$KIT/src/server.ts"
    remember plists "$PLIST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    # Ready = /api/health answers 200: it is 503 while a part is broken (spec index, write journal, a board file).
    printf '   waiting for %s/api/health to be ready ' "$URL"
    CACERT=(); [ -z "$CA_FILE" ] || CACERT=(--cacert "$CA_FILE")
    ok=0; for _ in $(seq 1 60); do if curl -fsS ${CACERT[@]+"${CACERT[@]}"} "$URL/api/health" >/dev/null 2>&1; then ok=1; break; fi; printf .; sleep 0.5; done; echo
    [ $ok = 1 ] || fail "the board is not ready on $URL ($(curl -sS ${CACERT[@]+"${CACERT[@]}"} "$URL/api/health" 2>&1 | head -c 600)); see $DASKS_HOME/server.log"
  fi
else
  say "Skipping the LaunchAgent (--no-launchd). Start the board yourself:"
  echo "   DASKS_ROOT=\"$DATA\" \"$KIT/bin/dasks-server\""
fi
fi
note kit "$KIT"

# ---------- 6. MCP for Claude Code and Codex ----------
CLAUDE_ACTOR="claude-code@$MACHINE"; CODEX_ACTOR="codex@$MACHINE"
MCP="$KIT/mcp/dasks-mcp.mjs"
if [ $CLAUDE_MCP = 1 ] && command -v claude >/dev/null; then
  say "Registering the dasks MCP for Claude Code (user scope, actor $CLAUDE_ACTOR)"
  add_claude() { claude mcp add --scope user dasks -e DASKS_ACTOR="$1" -- "$2" "$3" >/dev/null; }
  if [ $DRY = 1 ]; then echo "   [dry-run] claude mcp add --scope user dasks (only when absent or made by this installer)"
  elif recorded claude_mcp yes; then
    # Ours: replace it, and put the previous one back if the new one cannot be added.
    OLD_ACTOR=$(recall claude_mcp_actor); OLD_NODE=$(recall claude_mcp_node); OLD_MCP=$(recall claude_mcp_path)
    claude mcp remove --scope user dasks >/dev/null 2>&1 || true
    if ! add_claude "$CLAUDE_ACTOR" "$NODE" "$MCP"; then
      add_claude "${OLD_ACTOR:-$CLAUDE_ACTOR}" "${OLD_NODE:-$NODE}" "${OLD_MCP:-$MCP}" || true
      fail "claude mcp add failed; the previous dasks registration was put back"
    fi
    echo "   updated"
  elif claude mcp get dasks >/dev/null 2>&1; then
    echo "   Claude Code already has a dasks MCP this installer did not make: left as it is"
  else
    add_claude "$CLAUDE_ACTOR" "$NODE" "$MCP"
    note claude_mcp yes
    echo "   registered"
  fi
  if recorded claude_mcp yes; then note claude_mcp_actor "$CLAUDE_ACTOR"; note claude_mcp_node "$NODE"; note claude_mcp_path "$MCP"; fi
else
  say "Claude Code MCP: skipped ($( [ $CLAUDE_MCP = 0 ] && echo '--no-claude-mcp' || echo 'claude CLI not found'))"
fi
if [ $CODEX_MCP = 1 ] && command -v codex >/dev/null; then
  say "Registering the dasks MCP for Codex (~/.codex/config.toml, actor $CODEX_ACTOR)"
  run mkdir -p "$HOME/.codex"
  if helper codex-mcp add "$HOME/.codex/config.toml" "$NODE" "$MCP" "$CODEX_ACTOR"; then note codex_mcp yes; fi
else
  say "Codex MCP: skipped ($( [ $CODEX_MCP = 0 ] && echo '--no-codex-mcp' || echo 'codex CLI not found'))"
fi

# ---------- 7. CLIs, skills, optional merge gate ----------
# A link is (re)made only where nothing is, or where this installer made it; anything else is reported and left.
link() {
  local src=$1 dst=$2
  if [ -L "$dst" ] && { recorded links "$dst" || [ "$(readlink "$dst")" = "$src" ]; }; then :
  elif [ -e "$dst" ] || [ -L "$dst" ]; then echo "   $dst exists and is not ours: left as it is"; return; fi
  run ln -sfn "$src" "$dst"
  remember links "$dst"
  echo "   $dst"
}
say "Linking dasks, gb, dask and dasks-ci into $BIN"
run mkdir -p "$BIN"
for c in dasks gb dask dasks-captain dasks-captain-watch dasks-ci; do link "$KIT/bin/$c" "$BIN/$c"; done
case ":$PATH:" in *":$BIN:"*) ;; *) echo "   note: $BIN is not on your PATH. Add it:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;; esac

# A skill folder is replaced only when this installer made it (its marker file or the record).
install_skill() {
  local src="$KIT/skills/$1" dst="$2/$1"
  if [ -e "$dst" ] && [ ! -e "$dst/.dasks-kit" ] && ! recorded skills "$dst"; then echo "   $dst exists and is not ours: left as it is"; return; fi
  if [ $DRY = 1 ]; then echo "   [dry-run] copy $src -> $dst"; return; fi
  mkdir -p "$2"
  rm -rf "$dst.tmp-dasks" && cp -R "$src" "$dst.tmp-dasks" && touch "$dst.tmp-dasks/.dasks-kit"
  rm -rf "$dst" && mv "$dst.tmp-dasks" "$dst"
  remember skills "$dst"
  echo "   $dst"
}
SKILLS="dasks review-loop captain spec-writer"
say "Installing skills"
for s in $SKILLS; do install_skill $s "$HOME/.claude/skills"; done
if [ -d "$HOME/.codex" ] || command -v codex >/dev/null; then
  for s in $SKILLS; do install_skill $s "$HOME/.codex/skills"; done
fi
# A skill an earlier version of this kit installed and this one no longer ships is removed, but only when the install
# record says this installer made it.
{ [ ! -f "$RECORD" ] || recall skills || true; } | while IFS= read -r d; do
  case " $SKILLS " in *" $(basename "$d") "*) continue ;; esac
  if [ -e "$d" ]; then run rm -rf "$d"; echo "   $d (no longer part of the kit): removed"; fi
  [ $DRY = 1 ] || python3 "$KIT/scripts/installer.py" record "$RECORD" drop skills "$d"
done

# Optional secrets for agents (docs/secrets.md): dasks-secret, built from source with the Xcode Command Line Tools.
if [ $SECRETS = 1 ]; then
  say "Secrets for agents: dasks-secret (login Keychain, native windows, Touch ID approval per run)"
  if ! xcrun --find swift >/dev/null 2>&1; then
    echo "   skipped: the Xcode Command Line Tools are missing (swift). Fix: xcode-select --install, then run this again"
  elif [ $DRY = 1 ]; then echo "   [dry-run] swift build -c release in $KIT/secret, then link dasks-secret into $BIN"
  elif (cd "$KIT/secret" && swift build -c release --product dasks-secret >"$DASKS_HOME/secret-build.log" 2>&1); then
    link "$KIT/secret/.build/release/dasks-secret" "$BIN/dasks-secret"
    echo "   store a value: dasks-secret store --label <name>; let an agent use it: dasks-secret allow --label <name> --agent claude-code"
  else
    echo "   skipped: the build failed; see $DASKS_HOME/secret-build.log"
  fi
fi

if [ $GATE = 1 ]; then
  say "Adding the merge gate hook (PreToolUse Bash) to ~/.claude/settings.json"
  run mkdir -p "$HOME/.claude"
  helper gate add "$HOME/.claude/settings.json" "$KIT/bin/dask-merge-gate"
  note gate "$KIT/bin/dask-merge-gate"
fi

# ---------- 8. optional card runner ----------
if [ $RUNNER = 1 ]; then
  RPLIST="$AGENTS/$RLABEL.plist"
  say "Card runner: LaunchAgent $RLABEL (builds ready cards headless, opens draft PRs, never merges)"
  if [ -n "$JOIN" ]; then
    # A joined Mac has no board config: its runner settings and project checkouts live in ~/.dasks/runner.json.
    RCONF="$DASKS_HOME/runner.json"
    if [ $DRY = 1 ]; then echo "   [dry-run] would write $RCONF (runner.enabled=true) if it is missing"
    elif [ -e "$RCONF" ]; then echo "   $RCONF exists: left as it is"
    else
      printf '{\n  "runner": { "enabled": true },\n  "projects": []\n}\n' > "$RCONF"
      echo "   wrote $RCONF: add each project's local checkout there, e.g. \"projects\": [{ \"id\": \"web\", \"repo\": \"~/code/web\" }]"
    fi
  elif [ $DRY = 1 ]; then echo "   [dry-run] would set runner.enabled=true in $DATA/config.json"; else
    "$NODE" -e 'const fs=require("fs"),f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c.runner={...(c.runner||{}),enabled:true};fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$DATA/config.json"
    if [ -n "$(git -C "$DATA" status --porcelain -- config.json 2>/dev/null)" ]; then
      git -C "$DATA" -c user.name="dasks install" -c user.email=install@dasks.invalid commit -q -m "runner.enabled=true (install.sh --with-runner)" -- config.json || true
    fi
    echo "   runner.enabled=true in $DATA/config.json"
  fi
  link "$KIT/bin/dasks-runner" "$BIN/dasks-runner"
  RPATH="$(dirname "$NODE")"
  for t in claude codex gh git gitleaks python3; do d=$(command -v $t 2>/dev/null || true); [ -n "$d" ] && RPATH="$RPATH:$(dirname "$d")"; done
  RPATH="$RPATH:$BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  if [ $LAUNCHD = 1 ]; then
    if [ -e "$RPLIST" ] && ! recorded plists "$RPLIST"; then
      echo "   $RPLIST exists and was not made by this installer: left as it is"
    elif [ $DRY = 1 ]; then echo "   [dry-run] would write $RPLIST and load it (logs in $DASKS_HOME/runs/runner.log)"; else
      mkdir -p "$DASKS_HOME/runs"
      helper plist "$RPLIST" "$RLABEL" "$DASKS_HOME" "$DASKS_HOME/runs/runner.log" "$RPATH" "$DATA" "$HOME" -- "$NODE" --disable-warning=ExperimentalWarning "$KIT/src/cli/runner.ts"
      remember plists "$RPLIST"
      launchctl bootout "gui/$(id -u)/$RLABEL" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$RPLIST"
      echo "   loaded; log: $DASKS_HOME/runs/runner.log; status: dask runner status"
    fi
  else
    echo "   no LaunchAgent (--no-launchd). Run it yourself: $KIT/bin/dasks-runner   (or --once)"
  fi
  command -v gitleaks >/dev/null || echo "   note: without gitleaks the runner builds cards but never pushes them (brew install gitleaks)"
  echo "   note: the agent runs with --permission-mode auto in ~/.dasks/worktrees/<card>: it runs commands there without asking."
fi

# ---------- 9. done ----------
[ $DRY = 1 ] && { echo; echo "Dry run: nothing was changed."; exit 0; }
if [ -n "$JOIN" ]; then
cat <<EOF

This Mac joined the fleet as "$MACHINE".
  Board:   $JOIN   (on its own Mac; log in there or here in a browser)
  Agents:  ask Claude Code or Codex "list my Dasks cards" (MCP: dasks); CLI: dasks fleet, dask ready
$( [ $RUNNER = 1 ] && echo "  Runner:  dask runner status   (projects: $DASKS_HOME/runner.json)" )
  Remove:  $KIT/uninstall.sh
EOF
exit 0
fi
cat <<EOF

Dasks is installed.
  Board:   $URL   (log in with your passphrase to approve or answer cards)
  Data:    $DATA  (a git repo: every change is a commit)
  Agents:  ask Claude Code or Codex "list my Dasks cards" (MCP: dasks); CLI: dasks tasks, dask ready
$( [ $RUNNER = 1 ] && echo "  Runner:  dask runner status   (stop: launchctl bootout gui/\$(id -u)/$RLABEL)" )
  Remove:  $KIT/uninstall.sh   (keeps your data; --purge deletes it)
EOF
