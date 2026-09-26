# Hosting tracker without full state captures

Prepared 2026-09-25. A bounded implementation handoff. Nothing was implemented for it.

## Why

`ConnectionHostingTracker` decides when a hosting session has ended, so it can expire connection history and
stop the owned seats. It subscribes to spirectl's **full** state snapshot for that. The subscription:

- captures at the 500 ms floor. The 2 s idle maximum is clamped to 400 ms and raised back to the floor, so
  it is a fixed 500 ms poll;
- runs whenever any browser is connected or any seat is owned, which in practice means the whole session;
- performs, on every capture, spirectl's whole semantic walk on the game main thread, including a clone of
  each upgradable card.

The Sep-24 lag round measured it at 1.88 captures/s at 60 fps, about 9.65 ms/s of main thread with four
players × 20 cards (`.sts2/research/lag-20260924/REPORT.md`, local). `7d089e03` already removed the larger
per-seat driver. This tracker is now the largest remaining recurring full-state reader.

The tracker needs two facts, not a snapshot:

1. **Have we been hosting?** Today: `CharacterSelect.Lobby.NetGameType == "host"`, or a run player that is
   both `IsHost` and `IsLocal`.
2. **Are we back at the menu?** Today: no run, no character-select lobby, and `RootScene ==
   "screens/main_menu"`. Epoch and other non-lobby screens also report `main_menu`, because that string is
   the fallback.

The maintainer has explicitly allowed CouchCoop to read these facts itself, rather than through spirectl,
as a stopgap (2026-09-25). This is an exception to `CLAUDE.md`'s spirectl-ownership rule, which is under review
in [handoff-spirectl-boundary-review.md](handoff-spirectl-boundary-review.md). Keep the reads minimal.

## Current code

`src/CouchCoop.Mod/Connections/ConnectionHostingTracker.cs`:

- **Demand.** `SetBrowserDemand` / `SetOwnedSeatDemand` start monitoring on 0→>0 and stop it on >0→0.
  Generations guard stale callbacks. Keep all of this unchanged; it is pinned by
  `ConnectionHostingDemandTests`.
- **`StartMonitoring`** creates the state subscription plus a 1 s `Timer` that runs `Tick`.
- **`ObserveState`**: hosting seen sets `_hasHosted = true; _leftAt = null`. At the menu after hosting, it
  sets `_leftAt ??= now`.
- **`Tick`**: once `_leftAt` is at least 5 s old, it calls `EndHosting()` and
  `ConnectionRegistry.Shared.HostingEnded()`. The 5 s lets a lobby→run loading transition pass.
- **`OnNativeHostingEnded`**: `CouchCoopHostTransport.HostingEnded` ends hosting immediately. That native
  path is the primary signal; the state path is the backstop for exits that do not raise it.

## What to build

Replace only the state subscription. Keep demand, generations, the 1 s tick, the 5 s grace, and the native
end path.

- **"Hosting" fact.** `CouchCoopHostTransport` records the net host it installed (`_activeHost`, added in
  `7d089e03`, set in `AssignNetHost` and cleared in `ResetTransportState`). Every host start, whether a new
  lobby, a loaded save or the ENet-only fallback, goes through it. Expose a public "is hosting" read alongside
  `CouchCoopHostPeers` (the file is also compiled into the hot-reload assembly, which cannot see internals).
  - Do not treat "active host present" as "still in a hosted lobby or run". The backstop exists precisely for
    exits where the transport is not reset.
  - Latch `_hasHosted` when an active host is present **and** the game is in a lobby or a run. Start the
    countdown when the game is in neither.
- **"In a run" fact.** Read the game's run manager: whether a run is in progress, the property spirectl's run
  guard uses. CouchCoop compiles against the game assembly. Confirm the member is public on **both** API lanes
  (the installed v111 build and the declaration-only v107 SDK under `eng/`). Otherwise use the lane `#if` split
  as other CouchCoop code does.
  - Run presence must stay true through the end-of-run summary (death or the Architect), exactly as today.
    See memory `roster-push-only-run-end-rule`.
- **"On a lobby screen" fact.** `LobbyScreenRegistry` (`HostUi/`) plus `Sts2ScreenContext.IsCurrent`, which is
  how `CouchCoopQrHostPanelController` already recognizes the start-run and load-run lobby screens. Reuse
  it; do not add a new screen-type walk.
- **Trigger.** While monitoring, subscribe with `Sts2ScreenContext.SubscribeUpdated`. It fires on the game
  thread when the active screen may have changed. Evaluate the three facts there and once when monitoring
  starts; dispatch that first evaluation to the main thread, because the facts read live game objects.
  - Dispose the subscription when monitoring stops.
  - The evaluation is a few field reads. Never marshal to the main thread while holding `_gate` or
    `_hostingEndGate`.
- **Fallback.** `SubscribeUpdated` returns null when the game's screen event cannot be resolved. In that
  case keep today's state subscription unchanged, and log once.

## Constraints

- Zero-client dormancy is a top user priority. At zero demand there must be no subscription and no timer.
  `IdleHostCostTests` and `ConnectionHostingDemandTests` already assert that; keep them passing.
- No added input latency. Nothing here may run on the first-input path.
- Committed comments say what each fact means on screen and why the tracker needs it. No game-internals
  narrative (see `CLAUDE.md` "Game internals in committed files").
- Out of scope, but the next candidates: moving the run-end detached-seat reap here (the maintainer's rule is
  "reap only once the game has left both the run and any lobby"; the summary counts as in-run), and the state
  observer / session-envelope reads.

## Tests

In `tests/CouchCoop.Mod.Tests`, add small seams: a facts provider (hosting, in run, on lobby screen) and a
screen-changed source. Cover:

- **Dormancy:** demand 0→1→0 leaves no screen subscription and no timer, and never touches the state API.
  Assert on `RecordingSpirectlRuntime.StateSubscriptionActive` / `Calls`, or the stub equivalent.
- **Menu expiry:** hosted lobby → screen change to the menu → `EndHosting` after 5 s, not before. Inject time,
  or use a `TimeProvider` seam instead of sleeping 5 s.
- **Loading transition:** lobby → run within 5 s does not end hosting.
- **End-of-run summary:** a screen change while a run is in progress does not start the countdown.
- **Joined someone else's lobby:** not hosting, so never ends hosting.
- **Native end:** still immediate.
- **Fallback:** an unresolvable screen event keeps the state subscription path.

## Verification

- Worktree per the `couch-worktree` skill.
- Every dotnet command as `flock --close /tmp/sts2-dotnet-build.lock …` (without `--close`, the compiler server
  keeps the lock; see memory `flock-close-dotnet-builds`), with a scratch `COUCHCOOP_GAME_MODS_DIR`.
- Run `dotnet run --project tests/CouchCoop.Mod.Tests -- seats`, `-- idle-host` and `-- connections` (not
  `dotnet test`).
  - In the main checkout, `seats` currently dies in `ConnectionHostingDemandTests` on a `Sentry.Godot`
    load error that a clean worktree does not show. Run in a clean worktree.
- Manual check by the maintainer:
  1. Host a lobby with a phone connected, back out to the main menu: seats stop about 5 s later.
  2. Start a run from the lobby: nothing ends.
  3. Die or win and sit on the summary: nothing ends.
  4. Return to the menu: hosting ends.
- Commit `perf(host): …` with a `Changelog:` line. Never push or tag.
