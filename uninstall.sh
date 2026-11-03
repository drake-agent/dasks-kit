#!/bin/bash
# Dasks uninstaller: removes what install.sh made, as listed in ~/.dasks/install.json (LaunchAgents, MCP registrations,
# CLI links, skills, the merge gate hook). The runner is stopped first and its cards are given back while the board still
# runs; then the board stops. Your board data in ~/.dasks stays unless you pass --purge.
#   ./uninstall.sh [--dry-run] [--purge] [--no-claude-mcp]
set -euo pipefail

KIT=$(cd "$(dirname "$0")" && pwd)
DASKS_HOME="$HOME/.dasks"
RECORD="$DASKS_HOME/install.json"
AGENTS="$HOME/Library/LaunchAgents"
LABEL=dev.dasks.server
RLABEL=dev.dasks.runner
DRY=0; PURGE=0; CLAUDE_MCP=1
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --purge) PURGE=1 ;;
    --no-claude-mcp) CLAUDE_MCP=0 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "uninstall.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
run() { if [ $DRY = 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }
recall() { python3 "$KIT/scripts/installer.py" record "$RECORD" get "$1" 2>/dev/null || true; }
recorded() { recall "$1" | grep -qxF -- "$2"; }
forget() { [ $DRY = 1 ] || python3 "$KIT/scripts/installer.py" record "$RECORD" drop "$1" "$2"; }
alive() { kill -0 "$1" 2>/dev/null; }

# ---------- 1. runner: stop it and wait until its cards are back ----------
RPLIST="$AGENTS/$RLABEL.plist"
LOCK="$DASKS_HOME/runner/lock"
RPID=$(cat "$LOCK" 2>/dev/null || true)
if [ -e "$RPLIST" ] || { [ -n "$RPID" ] && alive "$RPID"; }; then
  say "Card runner (stopped first: it stops its agents and gives their cards back while the board still runs)"
  if [ -e "$RPLIST" ] && recorded plists "$RPLIST"; then run launchctl bootout "gui/$(id -u)/$RLABEL" 2>/dev/null || true
  elif [ -n "$RPID" ] && alive "$RPID"; then run kill -TERM "$RPID"; fi
  if [ $DRY = 0 ] && [ -n "$RPID" ]; then
    printf '   waiting for the runner to hand its cards back '
    for _ in $(seq 1 120); do alive "$RPID" || break; printf .; sleep 1; done; echo
    alive "$RPID" && echo "   the runner is still running after 2 minutes (pid $RPID); stop it yourself"
  fi
  if [ -s "$DASKS_HOME/runner/state.json" ] && [ $DRY = 0 ] \
    && python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("running") else 1)' "$DASKS_HOME/runner/state.json"; then
    echo "   note: some cards could not be handed back yet; the next runner start gives them back (see dask runner status)"
  fi
  if [ -e "$RPLIST" ] && recorded plists "$RPLIST"; then run rm -f "$RPLIST"; forget plists "$RPLIST"; fi
fi

# ---------- 2. the board ----------
PLIST="$AGENTS/$LABEL.plist"
say "LaunchAgent $LABEL"
if [ -e "$PLIST" ] && recorded plists "$PLIST"; then
  run launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  run rm -f "$PLIST"; forget plists "$PLIST"
elif [ -e "$PLIST" ]; then echo "   $PLIST was not made by this installer: left as it is"
else echo "   not installed"; fi

# ---------- 3. MCP registrations ----------
say "MCP registrations"
if [ $CLAUDE_MCP = 1 ] && command -v claude >/dev/null; then
  if recorded claude_mcp yes; then
    run claude mcp remove --scope user dasks >/dev/null 2>&1 || true; echo "   Claude Code: removed"
    [ $DRY = 1 ] || python3 "$KIT/scripts/installer.py" record "$RECORD" set claude_mcp no
  else echo "   Claude Code: none of ours"; fi
fi
if [ -f "$HOME/.codex/config.toml" ]; then run python3 "$KIT/scripts/installer.py" codex-mcp remove "$HOME/.codex/config.toml"; fi

# ---------- 4. links, skills, hook ----------
say "CLI links"
recall links | while IFS= read -r l; do
  if [ -L "$l" ]; then run rm -f "$l"; echo "   $l"; fi
  forget links "$l"
done

say "Skills"
recall skills | while IFS= read -r d; do
  if [ -e "$d/.dasks-kit" ]; then run rm -rf "$d"; echo "   $d"; fi
  forget skills "$d"
done

GATE=$(recall gate)
if [ -n "$GATE" ] && [ -f "$HOME/.claude/settings.json" ]; then
  say "Merge gate hook"
  run python3 "$KIT/scripts/installer.py" gate remove "$HOME/.claude/settings.json" "$GATE"
  [ $DRY = 1 ] || python3 "$KIT/scripts/installer.py" record "$RECORD" set gate ""
fi

if [ -e "$KIT/secret/.build/release/dasks-secret" ]; then
  echo "   note: secrets stored with dasks-secret stay in your login Keychain (service dev.dasks.secret). List and remove them:"
  echo "   $KIT/secret/.build/release/dasks-secret list;  … delete --label <name>"
fi
if [ $PURGE = 1 ]; then
  say "Deleting $DASKS_HOME (--purge: board data, passphrase, token, logs)"
  run rm -rf "$DASKS_HOME"
else
  echo; echo "Your board data stays in $DASKS_HOME/data. Delete everything with: $0 --purge"
fi
echo "Dasks is uninstalled."
