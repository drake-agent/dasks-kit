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
impl: claude
review: codex
pass_checks:
  - npm test is green
  - GET /spec returns the text

## Tests
  - this list item is after a heading and does not count
