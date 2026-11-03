#!/bin/bash
# Build dist/dasks-kit-<version>.tar.gz from the files git tracks (nothing untracked, no node_modules).
#   scripts/package.sh            version from package.json
set -euo pipefail
KIT=$(cd "$(dirname "$0")/.." && pwd)
cd "$KIT"
VERSION=$(node -p 'require("./package.json").version')
[ -z "$(git status --porcelain)" ] || echo "package.sh: note: uncommitted changes are left out (only committed files go in)" >&2
mkdir -p dist
OUT="dist/dasks-kit-$VERSION.tar.gz"
git archive --format=tar.gz --prefix="dasks-kit-$VERSION/" -o "$OUT" HEAD
echo "$OUT ($(du -h "$OUT" | cut -f1), $(git ls-files | wc -l | tr -d ' ') files)"
