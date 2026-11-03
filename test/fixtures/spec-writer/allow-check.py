# Used by fake-agent.sh: match paths against a Claude spec run's --settings allow rules the way Claude reads them
# (Read(//abs/dir/**) = anything under /abs/dir). Prints one line per path: allowed or denied.
#   python3 -I allow-check.py <inside-path> <outside-path> <outside-path> <the run's argv...>
import json
import sys

paths, argv = sys.argv[1:4], sys.argv[4:]
allow = json.loads(argv[argv.index('--settings') + 1])['permissions']['allow']
roots = [r[len('Read(/'):-len('/**)')] for r in allow if r.startswith('Read(//')]
for label, p in zip(['inside', 'outside', 'outside'], paths):
    ok = any(p == r or p.startswith(r + '/') for r in roots)
    print('%s %s: %s' % (label, p, 'allowed' if ok else 'denied'))
