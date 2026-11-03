id: shared.t-smpl
goal: shared
role: builder
tier: 1
repo: example-org/dasks
branch: human/shared.t-smpl
lane: none
deadline: 2026-11-01
size: big
depends_on: none
impl: Claude Code
review: codex
pass_checks:
  - npm test is green
  - GET /spec returns the text
  - a spec over the cap gets 413

## Background
Why this card exists.

## Why
Because.

## Context pack
- docs/design/x.md

## Tests
- test/spec-store.test.ts
