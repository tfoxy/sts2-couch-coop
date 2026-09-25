# Seat GC pauses and the act-change seat stall

Prepared 2026-09-25 from the lag-20260924 progressive-lag investigation. This is a handoff for a bounded
attribution task. Nothing was implemented for it. Local evidence, which is uncommittable:
`.sts2/research/lag-20260924/ws3/SUMMARY.md` ("Seat GC", "W3-6", per-room seat tables) and `REPORT.md` row 5.

## What was observed

The graded soak sessions S1, S1′, S2 and S2′ ran on one private host in headless gamescope, with 3 headless seats
and 3 headless-Chromium viewers. The route was 3 Act 1 fights, the Act 1 boss, `act 2`, then the first Act 2
fight. In all four sessions:

- **Every seat spent about 0.85–1.4 s per minute in GC pauses, in every room.** This is `GC.GetTotalPauseDuration`
  deltas per 5 s window, from the research lag probe.
- **In the 30 s after `act 2`, every seat hit a 1.7–2.0 s frame and logged 5.5–7.8 s of GC pause.** In the same
  window the host's worst frame was 0.4 s with the leak suspects switched off, and 0.8–1.0 s with them on.
- **It is not the preview-clone leak.** It happens identically in S2, where the clone was switched off, and seats
  hold only a few hundred clones.

Why it matters: a seat is a real player's game. A seat that pauses for 2 s delays that player's mirror, and any
multiplayer step that waits for every peer waits for the slowest one. The route took no card rewards, so these
figures come from a small, static deck.

## Suspects (ranked; none verified)

1. **The seat memory tuning.** `HeadlessClientManager.SeatMemoryTuningEnvironment` gives every seat
   `DOTNET_GCConserveMemory=5` and `MALLOC_ARENA_MAX=2`, and its own remark says it trades collection throughput
   for a tighter heap. Conserve-memory mode compacts gen2 more eagerly, so it is a direct candidate for both the
   steady pause rate and the act-change burst. The kill-switch `COUCHCOOP_HEADLESS_MEM_TUNING=0` already exists.
   See architecture-map "Headless seat memory" for why the tuning was added. The fix must not simply give back
   the seat RSS it saved.
2. **Seat-side scene production while streaming to its viewer**: per-frame snapshot and delta construction,
   serialization and hint collection. Measure its allocation rate per seat, first with a viewer attached and then
   with none (dormancy should make it zero).
3. **Periodic main-thread housekeeping:**
   - `HeadlessTextureImageEvictor`: 512 paths every 2 s.
   - `HeadlessMallocTrim`: `malloc_trim(0)` at most every 30 s once the seat has idled 5 s. Its cost scales with
     heap size.
   - `CouchCoopHeadlessVisualSuspender`: whole-tree walks that allocate node wrappers and child arrays.
4. **Act-change content.** New act assets and scenes arrive at once, with large-object allocations. Also look at
   whether the evictor or suspender re-census after a big tree swap.
5. **GC configuration**: workstation or server, concurrent or not, and gen0 budget, as the seat's process
   environment actually sets them. Read `/proc/<pid>/environ` of a live seat; don't infer it.

## Method

- Use the session-soak harness on `main`: `scripts/run-session-soak.mjs`, qa-recipes §2.z. Its route fixture
  already covers the boss and the act change.
- **Compare within one session, not across sessions.** In the lag round, cross-session CPU % moved ±10–16 pp
  because of CPU frequency scaling and a noisy desktop. Launch seats with different settings in the **same**
  session, e.g. seat 2 tuned and seat 3 with `COUCHCOOP_HEADLESS_MEM_TUNING=0`, then swap them in the repeat
  session. This works because every seat plays the same route in lockstep.
- **GC evidence:**
  - Per-seat GC counts, pause time and allocated bytes over time. The research lag probe
    (`research/lag-20260924-probe` on couch and spirectl) records these every 5 s; reuse it or add an equivalent,
    env-gated.
  - If attribution by allocation site is needed, collect a short GC-event trace from one seat around the act change.
- Report seat RSS next to every GC number. The tuning exists to cap RSS, and a fix that gives back hundreds of MB
  per seat moves the problem onto the player's memory.

## Acceptance

- **Either:** attribute at least 80 % of seat GC pause time, both steady-state and at the act change, to named
  causes with numbers.
- **Or:** give a concise no-go explaining why the evidence doesn't separate them.
- If a change is proposed, it must reduce seat GC pause per minute and the act-change seat stall in same-session
  A/B, without:
  - raising seat RSS materially (report the trade-off)
  - lengthening timers or batching work
  - lowering visual cadence or quality
  - regressing input latency (first input after idle included)
  - breaking zero-viewer dormancy (no scene observation without streaming viewers)
- Run the Mod executable suite (`dotnet run --project tests/CouchCoop.Mod.Tests`). Build only to scratch (never the
  live install), and use headless gamescope for any rendered check, never Xvfb.
