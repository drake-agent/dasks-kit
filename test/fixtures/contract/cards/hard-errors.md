id: shared.t-smpl
goal: shared
role: wizard
tier: 4
repo: <repo>
branch: human/shared.t-smpl
deadline: 1 Nov
size: big
depends_on: none
impl: claude
review: codex
pass_checks:
  - npm test is green
  - GET /spec returns the text
  - <third check>

## Background
Why this card exists.

## Why
Because.

## Context pack
- docs/design/x.md

## Tests
- test/spec-store.test.ts
