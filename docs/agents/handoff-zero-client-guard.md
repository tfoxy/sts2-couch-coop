# Zero-client work guard

Prepared 2026-09-25 from the lag-20260924 investigation. This is a handoff for a regression guard: a test plus a
runtime tripwire. Nothing was implemented for it.

## Why

The user's standing priority is that an empty host does no recurring work: no scene or state observation without
demand. Detached seats in an active run, and their necessary supervision, stay alive (see project memory
`user-empty-host-dormancy`).

That rule was broken once without any test noticing:

- The Sep-5 idle-cost round made every known subscriber demand-gated. `IdleHostCostTests` pinned those
  components.
- A week later, `ConnectionHostingTracker` (Sep-13) added an **always-on** full state subscription at ~2 Hz,
  built at mod init in every non-seat process: menus, singleplayer, plain Steam co-op.
- Nothing failed, because every test checks named components rather than the host as a whole.
- In v0.3.0–v0.3.2 that subscription drove the upgrade-preview clone leak in every modded player's game: about
  450 MB/hour with no phones connected (`.sts2/research/lag-20260924/REPORT.md`, local).

`6ef11725` (`fix(host): park runtime services without clients`) now gates the tracker on browser and owned-seat
demand, and `ConnectionHostingDemandTests` pins **that tracker's** transitions. What is still missing is a
contract that catches the **next** subscriber, timer or poll that somebody adds without demand.

## What to build

1. **A whole-host zero-client contract test** in `tests/CouchCoop.Mod.Tests`.
   - Compose the real host services the mod builds at init (the browser server host, host UI services, session
     supervision) over counting test doubles for every state and scene entry point of the runtime host, plus the
     dispatcher/timer seam if it can be injected.
   - Drive it through these phases with **zero clients**:
     - startup / menu
     - a hosting lobby opened, then closed
     - an active run with no viewers
     - after a `0→1→0` viewer cycle
     - after a seat detaches mid-run
   - Assert, per phase:
     - zero state captures
     - zero state or scene subscriptions
     - zero main-thread dispatches
     - no recurring timers beyond an **explicit, reviewed allow-list**: the listener's accept loop, and detached
       active-run seat supervision as the dormancy rule permits
   - The allow-list is the point of review: adding to it should require a comment saying why that work is
     demand-free.
   - **Prove that the test bites.** In a scratch branch or inside the test, inject a rogue always-on subscriber,
     or revert the tracker's gating from `6ef11725`, and show the test fails. Keep that negative case as a
     permanent test using a rogue double.
2. **A runtime tripwire.** Any state or scene entry point used while aggregate demand is zero increments a
   counter and emits a rate-limited log line such as `[couchcoop][idle-work] <caller> <entry point>`.
   - Demand here means `BrowserDemandLedger`, `StreamingViewerDemand` and owned seats.
   - Take the caller from `[CallerMemberName]`/`[CallerFilePath]`.
   - It costs one integer check per call, and makes a regression visible in players' `godot.log` and in QA
     without a profiler.
   - Allowed exceptions, such as a lobby panel reading its own lobby state while the lobby screen is current,
     must be named and justified.
   - Don't turn it into a hard failure at runtime.
3. **Optional live check:** a 10-minute zero-client window with the session-soak harness
   (`scripts/run-session-soak.mjs`) plus a grep for the tripwire line in `godot.log`. Zero hits passes.

## Coordination

Another agent is currently moving couch off spirectl's state capture (the per-seat membership check, B2 in the lag
report). The entry points this guard wraps may move. Target whatever state and scene source the host uses after
that change, and agree on the choke point before writing the doubles.

## Acceptance

- The contract test passes on current `main` and fails with a rogue subscriber, and that failure is kept as a
  test. `dotnet run --project tests/CouchCoop.Mod.Tests` exits 0; `dotnet test` is a no-op for this suite.
- The tripwire stays silent in a zero-client headless run and fires, naming the caller, for an injected rogue
  subscriber.
- There is no added latency on the first input after idle, and no change to join readiness or the listener.
