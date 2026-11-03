# Cards

A card is one Markdown file with YAML front matter in the board's data repo: `data/tasks/<project>/t-<slug>.md`, id
`<project>.t-<slug>`. Every write is a git commit by the server; the activity log sits next to it in `data/activity/`.

Statuses: `todo` → `doing` → `review` or `blocked-on-user` → `done` (or `cancelled`). A claim moves a card to `doing` and
names its holder; a release gives it back.

## Context block

Moving a card to `review` or `blocked-on-user` needs a short context, so you can act without opening anything else.
It is stored as the first section of the body:

```markdown
## Context
What: A draft PR for this card is open: Add a contact form
Why: Claude built it; the review is clean
Do: Read the PR and its checks; merge it or ask for changes
Recommend: Merge when CI is green
After: Mark the card done
PR summary: Adds /contact with a form that sends mail.
```

Clients send the fields `what`, `why`, `do`, `rec`, `after` (and `pr_summary` with a PR); any language works.
`needs_user` (the question on a blocked-on-user card) must be one yes/no question that says what approving does.

## Spec review

A card's spec is versioned text next to it (`GET/PUT /api/tasks/<id>/spec`). Its `spec_state` decides whether it is
ready to build:

| State | Meaning |
|---|---|
| `none` | no spec yet: the board body is the card |
| `draft` | a spec exists, not reviewed |
| `ready` | the current version passed a text review by a different model family than its writer |
| `blocked` | someone blocked it for Spec (`dask block`); the user lifts it, or someone who wrote a newer spec version and never claimed the card |

`dask ready` and the runner pick only `ready` cards. Families come from actor names (`claude*` → anthropic, `codex*` and
`gpt*` → openai); `config.json` `families` maps other actors to any family name. An actor no rule maps has no family and
cannot pass a spec review. Whoever wrote the current Acceptance tests or Oracle section cannot claim the card.
A spec's `impl:` and `review:` header lines name the models that build and review the card (`impl: claude`,
`review: codex`; config `families` names other models the same way); the board refuses a spec whose two lines are of
the same family or of no known family.
Writing specs (the runner's spec pass, `dask spec`), the often × bad rule and the finish line (`done_when`,
`done_at`, the `live-check` lane): [specs.md](specs.md).

## touches

The first `touches:` line above the first `##` heading lists the paths a card changes:

```markdown
touches: src/contact/, public/contact.html
```

Two cards with overlapping touches are never built at the same time in the same repo. `.` or `**` means the whole repo;
no line means the card overlaps nothing.

## Check items

A card's `## Done criteria` list (or its spec's `pass_checks:`) becomes check items an agent reports one by one
(MCP `report_item`, `get_items`). Reports never change the card's status.

## Card messages

Short notes between the agents on one card (`dask msg`, `dask inbox`, `dask wait`, MCP `card_msg` / `card_inbox` /
`card_wait`), at most 2 KB, no secrets. They are information only: never an approval, a status change or an
instruction from you.

## Now line

One line, at most 120 characters, saying what the agent on a card is doing right now (`dask now <card> "<line>"`).
Moving the card to done clears it.

## Lessons

Agents propose lessons for the next card on a project (`dask lesson add`, MCP `add_lesson`); you confirm or retire them
on the project page. Confirmed lessons come with every card prompt on that project.

## Project profile

Milestone progress counts closed cards, so it cannot say what a project can do. Each project (goal) may keep a profile
next to its `why`: what works today and what is still missing, read from the project's latest code. It sits in the
goal file:

```yaml
why: The company website and its contact form
profile:
  as_of: 2026-11-03T10:12:00+09:00   # stamped by the board
  by: claude-code@laptop             # stamped by the board
  features:                          # what works today, up to 10
    - area: Contact
      text: The contact form sends a mail to the team
      ref: docs/contact.md              # optional: where to see it
  gaps:                              # what is missing, up to 10
    - text: No spam filter on the form
      must: true                     # needed for the current version
      why: bots fill the inbox       # optional
```

`area` is one line of at most 40 characters; `text`, `ref` and `why` one line of at most 200. A profile needs at least
one feature or gap. A write replaces the whole block, and `why` (and the titles) can change in the same commit; values
sent for `as_of` and `by` are ignored.

- CLI: `dasks profile <app>` prints it (`profile: null` when never written); `dasks profile set <app> <file|->` takes
  JSON `{profile: {features, gaps} | null, why?, title?, title_ko?, title_en?}`. `profile: null` removes it.
- MCP: `get_profile`, `set_profile`; `list_goals` shows `profile_as_of` for a project that has one.
- HTTP: `POST /api/nodes/<goal>` with `{profile, why?}` ([api.md](api.md)).
- `dasks check` reports a hand-edited profile that breaks these rules.
- The project page shows the why, "Works today" and "Missing" (must-haves first) after the stat cards, unless the
  page's view places a `profile` widget itself. A project without one shows no profile section.

## Ideas

"Ideas for later" per project (MCP `add_idea`, `promote_idea`): not cards yet; promoting one makes a card.

## Decisions

When a card needs you, it goes to `blocked-on-user` with a question. Today and `/asks` show these; you answer after
logging in. Answers are signed into a ledger in the data repo. A merge OK names one exact PR head: a new push needs a new
OK, and the merge gate checks exactly that.
