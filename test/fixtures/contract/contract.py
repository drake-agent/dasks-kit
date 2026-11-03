#!/usr/bin/env python3
"""Reference card contract check in plain Python (no deps), the yardstick for src/lib/contract.ts.
  contract.py card <CARD.md>    exit 0 ok, 4 refused (reasons on stderr)
Missing soft sections (Background, Why, Context pack, Tests), depends_on and size are warnings on stderr.
"""
import re, sys

ROLES = {"builder", "reviewer", "designer", "marketer", "qa", "ops", "research"}
CODE_ROLES = {"builder", "reviewer"}
REQ = ["id", "goal", "role", "tier", "repo", "branch", "lane", "deadline"]
# Model name prefix -> model family, the same defaults the board uses for actor names (src/lib/schema.ts).
FAMILY_PREFIXES = [("claude", "anthropic"), ("human-claude", "anthropic"), ("codex", "openai"), ("human-codex", "openai"), ("gpt", "openai")]

def parse_card(path):
    d, checks, inlist = {}, [], False
    for raw in open(path, encoding="utf-8"):
        line = raw.rstrip("\n")
        if line.startswith("## "): break
        if not line.strip() or line.lstrip().startswith("#"): continue
        if inlist and re.match(r"^\s*-\s+", line):
            checks.append(re.sub(r"^\s*-\s+", "", line).strip()); continue
        m = re.match(r"^([a-z_]+):\s*(.*?)\s*(#.*)?$", line)
        if not m: continue
        k, v = m.group(1), m.group(2)
        inlist = (k == "pass_checks")
        if not inlist: d[k] = v
    d["pass_checks"] = checks
    return d

def family(model):
    m = "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in model).replace(" ", "")
    hits = [f for p, f in sorted(FAMILY_PREFIXES, key=lambda x: -len(x[0])) if m.startswith(p)]
    return hits[0] if hits else None

def pair_error(impl, review):
    """None when implementer and reviewer are of different known model families."""
    a1, a2 = impl, review
    if not a1: return "PAIR REFUSED: implementer model not specified"
    if not a2: return "PAIR REFUSED: reviewer model not specified"
    fa, fb = family(a1), family(a2)
    if fa is None: return "PAIR REFUSED: unknown implementer model '%s'" % a1
    if fb is None: return "PAIR REFUSED: unknown reviewer model '%s'" % a2
    if fa == fb: return "PAIR REFUSED: same model family reviewing itself (%s -> %s)" % (a1, a2)
    return None

def check_card(path):
    errs, d = [], parse_card(path)
    for k in REQ:
        v = d.get(k, "")
        if not v or v.startswith("<"): errs.append("missing field: " + k)
    if d.get("role") and d["role"] not in ROLES: errs.append("role must be one of " + "|".join(sorted(ROLES)))
    if d.get("tier") and d["tier"] not in ("1", "2", "3"): errs.append("tier must be 1, 2 or 3")
    if d.get("deadline") and not re.match(r"^\d{4}-\d{2}-\d{2}$", d["deadline"]): errs.append("deadline must be YYYY-MM-DD")
    pc = [c for c in d["pass_checks"] if c and not c.startswith("<")]
    if not 3 <= len(pc) <= 5: errs.append("pass_checks: need 3-5 concrete checks, got %d" % len(pc))
    if d.get("role") in CODE_ROLES or d.get("impl") or d.get("review"):
        e = pair_error(d.get("impl", ""), d.get("review", ""))
        if e: errs.append(e.strip().splitlines()[0])
    txt = open(path, encoding="utf-8").read()
    warns = []
    for sec in ("Background", "Why", "Context pack", "Tests"):
        m = re.search(r"^## %s[^\n]*\n([\s\S]*?)(?=^## |\Z)" % sec, txt, re.M)
        if not m or not m.group(1).strip() or m.group(1).strip().startswith("<"): warns.append("self-contained card: section '## %s' missing or empty" % sec)
    if not d.get("depends_on") or d["depends_on"].startswith("<"): warns.append("depends_on missing (write 'none' if nothing)")
    if d.get("size") not in ("small", "big"): warns.append("size missing: write 'small' or 'big' (big = a deeper review; unsure = big)")
    return errs, warns

if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "card": print(__doc__); sys.exit(2)
    errs, warns = check_card(sys.argv[2])
    for w in warns: print("card warning: " + w, file=sys.stderr)
    if errs:
        print("CONTRACT REFUSED (card): %s" % sys.argv[2], file=sys.stderr)
        for e in errs: print("  - " + e, file=sys.stderr)
        sys.exit(4)
    print("card ok: %s" % sys.argv[2])
