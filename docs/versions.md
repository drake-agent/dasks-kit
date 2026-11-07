# Versions

Version mode lets a project build one milestone at a time. It is off until you set a target, per project, and there is
no other switch: a goal without a target works exactly as before, so nothing stops by accident.

## Set a target

A goal's `version_target` names the milestone it builds now. It must be a milestone of that goal. Set it with
`POST /api/nodes/web` and `{"version_target": "web.m-v1"}` ([api.md](api.md)); an empty string turns it off. You can also
write `version_target: web.m-v1` in `data/goals/web.yaml`; if that value
is not a milestone of the goal, `dasks check` reports it and the goal runs as if no target were set.

## What changes

- **New cards.** A card created without a milestone goes to the target, so a review follow-up or a bug card is not left
  outside the version. A card that names a milestone stays there.
- **The runner** starts only the target's cards in that goal, and gives them the spec pass too. A held card is logged as
  skipped (`not in version web.m-v1`) and `dask runner status` counts them. `p0` cards are exempt. Other goals and cards
  you claim yourself are not affected, and `dask ready` still lists every card.

A target's card that depends on a card outside the target waits for it: move that card into the milestone, make it `p0`
or drop the dependency.

## Version status

A version is ready when at least one of its cards is done and none is open. Cancelled cards do not count at all.

`GET /api/versions` lists one row per goal with a target:

```json
[{ "goal": "web", "milestone": "web.m-v1", "total": 5, "done": 2, "open": 3, "ready": false, "gate_card": null }]
```

The Goals page shows `<milestone>: 2/5` on the goal's row, or `<milestone>: ready to judge`.

## Cards that close after the gate

Some cards can only finish once the version is judged, such as a release switch. Mark such a card with a line
`launch_gate: <milestone>`, its own milestone, in its body or as a board note whose whole text is that line. It stays in
the milestone and starts as before, but it is not counted, so it does not hold the version back from ready. The marker is
for the count: the board does not refuse to close the card early. Archiving old notes keeps this note in the card.

## The gate card

When a version is ready, the board makes one card in that milestone: `Judge version <milestone>: e2e and batch review`,
with `version_gate: <milestone>` on its first line. It waits on you (`blocked-on-user`, lane `none`, so no runner picks it
up) and asks you to run the end-to-end flow and review the whole version together, then to judge it.

- It does not count as a card of the version.
- It is made once. A closed or cancelled gate card still counts, and so does a card you marked by hand.
- The board's own tick makes it, within a minute of the last card closing, whether or not any runner is on. It has a fixed
  id and is written under the board's lock, so any number of runners and clients cannot make a second one, and the intake
  limit never turns it into an idea.

Nothing here merges anything. Which PRs land, and whether the version is good, stays your call.
