#!/bin/bash
# fake claude / codex for spec runs and builds. FAKE_SPEC_REVIEW: clean | p1once | p1always. FAKE_SPEC_RATE=<tool>: that tool hits a usage limit.
# FAKE_DRAFT: empty (prints no spec) | sleep (records its pid, then sleeps)
me=$(basename "$0")
printf '%s\n' "$*" >> "$FAKE_DIR/$me.args"
prompt="${@: -1}"
card=$(printf '%s' "$prompt" | grep -o 'Dasks card [a-z0-9.-]*' | head -1 | cut -d' ' -f3)
spec() {
  cite=README.md; [ -f src/origin-only.ts ] && cite=src/origin-only.ts
  printf '<<<SPEC\nid: %s\ngoal: beta\nrole: builder\ntier: 2\nrepo: proj\nbranch: dasks/%s\nlane: claude\ndeadline: 2026-12-01\nsize: small\ndepends_on: none\nimpl: claude\nreview: codex\ntouches: src/a\ndone_when: src/a/built.txt says hello on main\ndone_at: pr\npass_checks:\n  - test -f src/a/built.txt exits 0\n  - grep -c hello src/a/built.txt prints 1\n  - npm test exits 0\n\n## Background\nToday %s holds the entry point. %s\n\n## Why\nBecause.\n\n## Context pack\n- %s\n\n## Acceptance tests\n- built.txt exists and says hello\n\n## Tests\n- test/a.test.ts\n\n## Done criteria\n- the file is there\nSPEC>>>\nRESULT: drafted\n' "$card" "$card" "$cite" "$1" "$cite"
}
case "$prompt" in
  *"You are writing the spec"*)
    [ "$FAKE_SPEC_RATE" = "$me" ] && { echo "API Error: 429 rate_limit_error: you have hit your usage limit" >&2; exit 1; }
    n=$(( $(cat "$FAKE_DIR/$me.drafts" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE_DIR/$me.drafts"
    [ "$FAKE_DRAFT" = empty ] && { echo "I could not find the code."; exit 0; }
    [ "$FAKE_DRAFT" = sleep ] && { echo $$ > "$FAKE_DIR/draft.pid"; exec sleep 300; }
    { echo "pwd=$PWD"; echo "head=$(git rev-parse HEAD)"; ls -A; [ -w README.md ] && echo "README writable" || echo "README read-only"; } > "$FAKE_DIR/$me.view.$n"
    case "$prompt" in *"Revise the spec"*) spec "Revised after review." ;; *) spec "First draft." ;; esac
    exit 0 ;;
  *"adversarial reviewer of the spec"*)
    n=$(( $(cat "$FAKE_DIR/reviews" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE_DIR/reviews"
    echo "pwd=$PWD" > "$FAKE_DIR/$me.review.$n"
    [ "$me" = claude ] && python3 -I "$FAKE_FIXTURES/allow-check.py" "$PWD/README.md" /etc/hosts "$HOME/.dasks/client.json" "$@" > "$FAKE_DIR/$me.paths.$n"
    mode=${FAKE_SPEC_REVIEW:-clean}
    if [ "$mode" = p1always ] || { [ "$mode" = p1once ] && [ $n = 1 ]; }; then echo "- [P1] Acceptance tests: none would fail on today's code"; echo "VERDICT: fail"
    else echo "- [P3] wording"; echo "- [Q] often=2 bad=3 kind=where Which folder holds the fixture?"; echo "VERDICT: pass"; fi
    exit 0 ;;
  *"cross-model reviewer"*) echo "- [P3] fine"; echo "VERDICT: clean"; exit 0 ;;
esac
mkdir -p src/a && echo hello > src/a/built.txt && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm "card: add built.txt" && echo "RESULT: built src/a/built.txt"
