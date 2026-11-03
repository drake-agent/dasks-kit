#!/usr/bin/env python3
"""Run contract.py card on every fixture card and print {name: {ok, errors, warnings}} as JSON. expected.json is this
output; test/contract.test.ts compares src/lib/contract.ts to it and, when python3 is present, to a fresh run."""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
out = {}
for name in sorted(os.listdir(os.path.join(HERE, "cards"))):
    r = subprocess.run([sys.executable, os.path.join(HERE, "contract.py"), "card", os.path.join(HERE, "cards", name)],
                       capture_output=True, text=True)
    errs = [l[4:] for l in r.stderr.splitlines() if l.startswith("  - ")]
    warns = [l[len("card warning: "):] for l in r.stderr.splitlines() if l.startswith("card warning: ")]
    out[name] = {"ok": r.returncode == 0, "errors": errs, "warnings": warns}
print(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True))
