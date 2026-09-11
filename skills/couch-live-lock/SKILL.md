---
name: couch-live-lock
description: Take, verify, hand over and release resource-scoped CouchCoop live-QA leases before and after driving a game instance, browser endpoint, or physical device.
---

# Resource-scoped live-QA leases

Use `scripts/live-qa-lock.mjs`; do not create lock files by hand. Leases live in
`/tmp/couchcoop-liveqa.leases/`, shared across worktrees. The helper acquires a whole set atomically and records
owner, PID, time, mode, and resources in readable JSON.

## Resources and modes

- `shared:install` for every session using the installed mod; deploy/build uses `exclusive:install`.
- `shared:game:<instance>` for passive inspection; `exclusive:game:<instance>` for input, fixtures, launch, or close.
- `exclusive:android:<serial>` for a physical device.
- `exclusive:browser:<cdp-port>` for a CDP endpoint.
- `exclusive:port:<port>` where a harness owns a listening port.

Shared holders coexist. An exclusive holder conflicts with either mode on the same resource. Thus a Mali job
holding an Android/CDP pair and a QA run holding an isolated game can coexist; both take `shared:install`, while a
deploy takes `exclusive:install` and waits for both.

## Acquire, inherit, inspect, release

```bash
owner=handraiseqa
node scripts/live-qa-lock.mjs acquire --owner "$owner" --pid "$$" \
  --resource shared:install --resource exclusive:game:touchqa --resource exclusive:port:13457
export COUCHCOOP_LIVEQA_OWNER="$owner" COUCHCOOP_LIVEQA_PID="$$"

node scripts/live-qa-lock.mjs assert --owner "$owner" --pid "$$" --resource exclusive:game:touchqa
node scripts/live-qa-lock.mjs list
node scripts/live-qa-lock.mjs release --owner "$owner" --pid "$$"
```

For one command, prefer the exit-safe wrapper:

```bash
node scripts/live-qa-lock.mjs with --owner handraiseqa \
  --resource shared:install --resource exclusive:game:touchqa -- command arg
```

Children inherit `COUCHCOOP_LIVEQA_OWNER/PID` and must `assert` the exact resources they touch. Release on every
exit path. A lease is owner/PID-specific; never delete someone else's JSON.

## Stale holders

`list` marks PIDs alive/dead. A dead lease remains conflicting. Only remove it after confirming the PID is dead,
no process owns the named game/device/port, and the resource has been idle for roughly ten minutes; record the
takeover in the new lease owner. A live PID always means wait or coordinate.

The operator's default game is not implicitly a blocker. Address it as `game:default` only when inspecting or
driving that game; otherwise use an isolated named instance.

## Release checklist

1. Restore the `spirectl` and `godot-scene-web` sibling checkouts next to the primary checkout to clean `main`.
2. Close only instances you started, by name.
3. Remove only device forwards/reverses owned by this lease.
4. Release the lease even on failure or early exit.

## Related

The `live-game-qa` agent covers work while holding leases; `couch-deploy` covers exclusive install;
[qa-recipes.md](../../docs/agents/qa-recipes.md) §0–§2 is the source protocol.
