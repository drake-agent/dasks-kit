#!/usr/bin/env python3
"""Helpers for install.sh and uninstall.sh: file edits that shell would get wrong. Each prints one short line.

  installer.py plist OUT LABEL WORKDIR LOG PATH_ENV DASKS_ROOT HOME -- ARGV...   write a LaunchAgent plist (plistlib)
  installer.py client FILE URL MACHINE [TOKEN_FILE]     write the stored connection (mode 600); keeps a stored token
                                                         unless TOKEN_FILE gives a new one
  installer.py has-token FILE                           exit 0 when the stored connection has a token
  installer.py codex-mcp add|remove CONFIG NODE MCP ACTOR   the managed [mcp_servers.dasks] block of ~/.codex/config.toml
  installer.py gate add|remove SETTINGS GATE            the merge gate hook in ~/.claude/settings.json
  installer.py record FILE get KEY                      print a recorded value (one item per line)
  installer.py record FILE add KEY VALUE                remember an item this install made
  installer.py record FILE drop KEY VALUE               forget it
  installer.py record FILE set KEY VALUE                set a scalar
The install record (~/.dasks/install.json) lists what the installer made, so an update replaces only those and the
uninstaller removes only those."""
import json, os, plistlib, re, shutil, sys, tempfile, time

def write_atomic(path, data, mode=None):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-dasks-", dir=d)
    try:
        with os.fdopen(fd, "wb") as f: f.write(data if isinstance(data, bytes) else data.encode())
        if mode is not None: os.chmod(tmp, mode)
        elif os.path.exists(path): os.chmod(tmp, os.stat(path).st_mode & 0o7777)
        else: os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp): os.unlink(tmp)
        raise

def backup(path):
    if os.path.exists(path): shutil.copy2(path, path + ".bak-dasks-" + time.strftime("%Y%m%d%H%M%S"))

def plist(a):
    out, label, workdir, log, path_env, root, home = a[:7]
    if a[7] != "--": sys.exit("plist: missing -- before the program arguments")
    doc = {"Label": label, "ProgramArguments": a[8:], "EnvironmentVariables": {"DASKS_ROOT": root, "HOME": home, "PATH": path_env},
           "WorkingDirectory": workdir, "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
           "StandardOutPath": log, "StandardErrorPath": log}
    data = plistlib.dumps(doc)
    plistlib.loads(data)
    write_atomic(out, data, 0o644)
    print("   wrote " + out)

def client(a):
    path, url, machine = a[:3]
    old = {}
    try:
        with open(path) as f: old = json.load(f) or {}
    except Exception: pass
    token = old.get("token", "")
    if len(a) > 3 and a[3]:
        with open(a[3]) as f: token = f.read().strip()
    if token and not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", token): sys.exit("client: the new token is malformed")
    # ca: the CA file of an https board (install.sh --ca-file); kept from the old file when not given.
    ca = os.path.abspath(a[4]) if len(a) > 4 and a[4] else old.get("ca", "")
    doc = {"url": url, "machine": machine, **({"token": token} if token else {}), **({"ca": ca} if ca else {})}
    write_atomic(path, json.dumps(doc, indent=1) + "\n", 0o600)
    print("   " + path + (" (token stored)" if token else " (no token)"))

def has_token(a):
    try:
        with open(a[0]) as f: sys.exit(0 if (json.load(f) or {}).get("token") else 1)
    except Exception: sys.exit(1)

BEGIN, END = "# >>> dasks (managed by dasks install.sh) >>>\n", "# <<< dasks <<<\n"
BLOCK_RE = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.S)

def codex_mcp(a):
    op, path = a[0], a[1]
    old = open(path).read() if os.path.exists(path) else ""
    if op == "add":
        node, mcp, actor = a[2:5]
        q = lambda s: '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
        block = BEGIN + "[mcp_servers.dasks]\ncommand = %s\nargs = [%s]\nenv = { DASKS_ACTOR = %s }\n" % (q(node), q(mcp), q(actor)) + END
        if BLOCK_RE.search(old): new = BLOCK_RE.sub(lambda m: block, old)
        elif re.search(r"^\[mcp_servers\.dasks\]", old, re.M):
            print("   ~/.codex/config.toml has its own [mcp_servers.dasks]; left as it is"); sys.exit(3)
        else: new = old + ("\n" if old and not old.endswith("\n") else "") + ("\n" if old else "") + block
    else:
        new = BLOCK_RE.sub("", old)
        new = re.sub(r"\n{3,}", "\n\n", new)
    if new == old: print("   Codex: unchanged"); return
    backup(path)
    write_atomic(path, new)
    print("   Codex: " + ("registered" if op == "add" else "removed"))

def gate(a):
    op, path, cmd = a
    doc = {}
    if os.path.exists(path):
        try:
            with open(path) as f: doc = json.load(f)
        except Exception: sys.exit("~/.claude/settings.json is not valid JSON; fix it first (nothing changed)")
    if not isinstance(doc, dict): sys.exit("~/.claude/settings.json is not a JSON object; nothing changed")
    hooks = doc.get("hooks", {})
    pre = hooks.get("PreToolUse", []) if isinstance(hooks, dict) else None
    if not isinstance(pre, list): sys.exit("hooks.PreToolUse is not a list; nothing changed")
    mine = lambda h: isinstance(h, dict) and h.get("command") == cmd
    present = any(mine(h) for g in pre if isinstance(g, dict) for h in g.get("hooks", []) or [])
    if op == "add":
        if present: print("   already there"); return
        pre.append({"matcher": "Bash", "hooks": [{"type": "command", "command": cmd}]})
        doc.setdefault("hooks", {})["PreToolUse"] = pre
    else:
        if not present: print("   not there"); return
        for g in pre:
            if isinstance(g, dict) and isinstance(g.get("hooks"), list): g["hooks"] = [h for h in g["hooks"] if not mine(h)]
        pre = [g for g in pre if not (isinstance(g, dict) and g.get("hooks") == [])]
        if pre: doc["hooks"]["PreToolUse"] = pre
        else:
            del doc["hooks"]["PreToolUse"]
            if not doc["hooks"]: del doc["hooks"]
    backup(path)
    write_atomic(path, json.dumps(doc, indent=2) + "\n")
    print("   " + ("added" if op == "add" else "removed") + " (backup kept next to the file)")

def record(a):
    path, op, key = a[0], a[1], a[2]
    try:
        with open(path) as f: doc = json.load(f)
    except FileNotFoundError: doc = {}
    if op == "get":
        v = doc.get(key)
        for x in (v if isinstance(v, list) else [v] if v not in (None, "") else []): print(x)
        return
    val = a[3]
    if op == "set": doc[key] = val
    else:
        items = [x for x in doc.get(key, []) if x != val]
        if op == "add": items.append(val)
        doc[key] = items
    write_atomic(path, json.dumps(doc, indent=1) + "\n", 0o600)

if __name__ == "__main__":
    cmd, rest = sys.argv[1], sys.argv[2:]
    {"plist": plist, "client": client, "has-token": has_token, "codex-mcp": codex_mcp, "gate": gate, "record": record}[cmd](rest)
