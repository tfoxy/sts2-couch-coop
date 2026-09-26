# Implement the spirectl boundary recommendations

Prepared 2026-09-26. A bounded implementation handoff for [spirectl-boundary-review.md](spirectl-boundary-review.md)
(the "memo"). This document now records the implementation status; the original work-package descriptions below
remain as design and verification reference. Steps marked **maintainer** are decisions, not agent work.

## Where things stand

WP1, WP2, WP3, WP4a, WP7 and WP8 are complete. The WP3 integration branch removes the runtime state port and
temporary snapshot parity oracles and adds a metadata gate against full-state references in both mod assemblies.
Its focused tests and v107/v111 compile lanes passed. The roster reaction now compares every `RosterFacts` value;
a typed character-change callback wakes a one-frame deferred read. The integrated work passed the full mod,
MirrorProtocol and Connection suites, the paired boundary check, and v107/v111 Release builds. It is landed on
local CouchCoop `main`. Nothing has been pushed or tagged.

WP4b landed on local spirectl `main` as `6a922914`; the subsequent Embedded `ClaimReward` trim landed as
`fab2dca1`, which CouchCoop pins. Independent review caught and fixed four state-only game-API manifest
requirements before WP4b landed. Full and Embedded profiles compiled on v107 and v111, and the reward trim
repassed both lanes. After WP4b, `bridge-tests` passed 2,088 tests, the live-host gate passed 2,390 with four
skipped, and the paired boundary check confirmed Embedded's 213 compile items versus Full's 288. The reward trim
also passed `bridge-tests`, the live-host gate, and the paired boundary check. Same-SDK method-body IL fell from
1,190,261 bytes at the WP4a baseline to 991,218 after WP4b, then 980,544 after the reward trim (−17.62%
cumulative); Full is 1,416,456 bytes. Current measurement:
`.sts2/research/spirectl-boundary-review-sep26/wp4b/fab2dca1-il-readme.md`.

Both private-headless live legs completed before the final reward trim. QA1 exposed the missing character wake on
the older build; QA2 proved
that a real browser character change advances the host roster and updates another viewer's mirror with unchanged
seat IDs and connectivity. QA1 recorded 27 roster reads, QA2 recorded 18 and 27 over two launches; both saw zero
reads before viewer demand and zero idle-work or tripwire entries. Joins, leave/rejoin, hosted start, ordinary
browser reconnect, load-run and hosted QR, hosted Save and Quit to menu, and singleplayer summary/no-QR checks ran.
QA2 installed and proved both bridge-facing and embedded assemblies in a private farm because another live owner
held the shared-install lease. See `.sts2/research/spirectl-boundary-review-sep26/wp3-live-qa1/QA1-REPORT.md` and
`.sts2/research/spirectl-boundary-review-sep26/wp4b-live-qa2/QA2-REPORT.md` for identities, read counts and images.

**Verification follow-up:** the first full CouchCoop mod-suite build found test fakes that still named
combat-event types removed from Embedded. The test-only fakes and boundary assertions were corrected; the full mod,
MirrorProtocol, Connection and focused Embedded boundary suites now pass. Run-name-only editing and a hosted
run-to-summary-to-menu transition were not
exercised end to end. A separate forced headless-seat death left its player unavailable in the reconnect picker;
ordinary browser close/reopen passed. These limits and the distinct forced-death evidence are in the QA reports.

**Retained polling:** the existing QR host-panel 0.25 s heartbeat and seat readiness loops remain at their existing
cadence. No new polling was added.

**Browser-action decisions (2026-09-26):** `ClaimReward` is retired from the browser contract and Embedded action
catalog; reward rows use real input. `SetScrollOffset` is retained with the maintainer's approval so the game follows
the client's final absolute scroll position without correcting an inaccurate local prediction. `SelectMapNode`
remains in use pending investigation of map voting and the travelable gate.

**Ownership wording approved:** memo §9's "reuse is earned" rule is in `AGENTS.md` (`922caf2e`).

**Maintainer decisions remain open:** whether scene or animation hooks are earmarked for a spirectl consumer;
the remaining `SelectMapNode` browser action pending investigation; whether to remove the host-start transport
cap probe that reads null in stock flows; and deletion of the paused `roster-port` branch/worktrees. The later
per-join live lobby-cap read already limits seat allocation to `cap - 1`; no join-cap bug was found.

## Rules for every work package

- **Ownership wording is approved.** Follow the current `AGENTS.md` rule: support only CouchCoop needs starts here;
  move it to spirectl when another consumer exists. The named geoclip exception stays in spirectl.
- Follow `CLAUDE.md` "Verify What You Touched": the `couch-worktree` skill for a worktree, every dotnet command as
  `flock --close /tmp/sts2-dotnet-build.lock …`, a scratch `COUCHCOOP_GAME_MODS_DIR`, and
  `dotnet run --project tests/CouchCoop.Mod.Tests -- <verb>` (`dotnet test` is a no-op here). `npm run build`
  deploys; do not run it.
- **`seats` dies in the main checkout** on a missing `Sentry.Godot` assembly (the static initializer of
  `CouchCoopHostTransport`); run it in a clean worktree. The tracker suites live in the `seats` verb.
- Committed comments say what a fact means on screen and why the code needs it. No game-internals narrative (see
  `CLAUDE.md` "Game internals in committed files"). Resource paths the mod needs to work are fine.
- Zero-client dormancy is a top user priority: at zero demand there is no subscription, no timer and no state read.
  `IdleHostCostTests` and `ConnectionHostingDemandTests` must stay green.
- The release ships the **v107** lane, and the local install is v111. Any lane-varying code needs a v107 compile
  (WP1's recipe) before a release cut.
- Never push, never tag. `main` gets one squash commit per change; multi-step work goes on a branch.

## WP1: compile the tracker on the v107 lane (complete)

The mod compiled against v107 without a compatibility fix; v111 also compiles. The SDK recipe from the original
handoff is omitted here because the result is recorded above and the standard lane procedure lives in
`scripts/package-release.sh`.

## WP2: delete the dead connecting-player path (complete)

The dead connecting-player path was removed in `c4cfeca2`; the lobby gate remains live. The original proposal was
intentionally narrowed after caller review: the lobby gate was a live path and stayed. Focused suites passed when
this change landed.

## WP3: retire the remaining full-state reads (complete; memo P1)

**Completed:** the seven read paths were replaced by CouchCoop typed facts and signals. The runtime state port and
temporary parity oracles are removed. A metadata test rejects full-state references in both mod assemblies. The
combined branch passed its focused path suites, zero-client contract, boundary check, and v107/v111 builds. QA1
and QA2 completed as described above. Goal: CouchCoop never calls `GetCurrentState` or `SubscribeCurrentState`.
WP4b then excluded the state builders, screen inspectors and `StateSnapshot` from Embedded. The table below is the
historical read-path inventory and rationale.

| # | Read path | Runs | Facts it needs |
| --- | --- | --- | --- |
| 1 | **Lobby gates.** `CouchCoopMod.TryGetLobbyState`, called by the QR host panel (`HostUi/CouchCoopQrHostPanelController`, the bounded 0.25 s chain decided by `LobbyEvaluationPlan`) and the pause-menu QR (`CouchCoopPauseMenuQrEntry`); feeds `CouchCoopLobbyHostGate` and `CouchCoopPauseMenuGate` | **recurring, about 4 Hz, while a lobby screen is current**; per pause-menu visibility | a run is present; the lobby is a host lobby; the local player hosts the run |
| 2 | **`CouchCoopStateObserver`**, started by `CouchCoopBrowserServer` while a viewer is parked on the join picker (50 ms floor); drives the roster-change rebroadcast, `PublishRosterNames`, the run-end reap of detached seats | **recurring while picker-parked viewers exist** | seat ids, names, characters, connected flags for lobby and run; run and lobby presence. `Latest` may have no readers: check |
| 3 | **Session envelope.** `Protocol/BrowserStateEnvelopeFactory.CreateStateV2`, `Session/BrowserAssignmentState.cs` (classifier, `StampSeats`), plus a hidden second pull through `DescribeSeats` → `MaxSlot` → `MaxCouchSeats` | per envelope, times every connection on each roster, screen or static-background resend | the same seat facts plus the live player cap |
| 4 | **Join.** `DescribeMirrorJoinContext`, `MaxSlot`, `IsRunInProgress` | about 3 pulls per `join` | seat net ids (lobby, run, saved run), host name, roster names |
| 5 | **Admission and cap.** `MaxLobbyPlayers` per WebSocket upgrade, and at host start on the main thread in `CouchCoopHostTransport` | per upgrade, per host start | the player cap only |
| 6 | **Seat join wait.** `IsGamePlayerConnected` lobby-membership check in the readiness loop, and the full-read fallback `7d089e03` kept for when CouchCoop's transport is not the running host | about 200 ms per joining seat | is this net id a connected lobby or run player |
| 7 | **Browser disconnect.** `IsRunInProgress` in `CouchCoopWebSocketConnection` and `HeadlessClientManager`, deciding detach versus release | per disconnect | run presence |

The whole set of fields CouchCoop reads is about 20 leaves: the root screen (four strings), lobby presence and its
`{net game type, host player id, max players, player count}`, lobby seats `{id, name, character, connected}`,
saved-run seat ids, run presence and net game type, run seats `{id, name, character, is host, is local,
connected}`. Ids stay `p:{netId}` (`MirrorSeatNetIds.TryParsePlayerId`). A run seat's connected flag fails open.

**Implemented direction:** CouchCoop-owned readers of typed facts replaced these full-state paths; a metadata test
rejects full-state references in both mod assemblies. Temporary snapshot parity oracles were removed. The original
design used a CouchCoop-owned reader typed against the game assemblies with the
existing lane `#if` split, **not** by-name reflection. Build on what already exists: `HostingSessionFacts`,
`LobbyScreenRegistry` and `Sts2ScreenContext` (the start-run and load-run lobby screens), and the host peer list
`7d089e03` added to `CouchCoopHostTransport`. Path 1 is the natural first target: "host lobby" is roughly "a host is
installed, a lobby screen is current, and no run is in progress", which is exactly what the tracker's facts already
answer, and it replaces a recurring pull with a push-driven evaluation. For paths 3 to 7, an on-demand read of only
the needed leaves is enough; they are event-driven. Only path 2 wants push (the screen event, the host transport's
peer events, the seat-name registry). The paused round's plan (local, under `~/.claude/plans/`, file
`handoff-replace-couchcoop-s-full-iridescent-waterfall.md`) has a signal-source table and the exact roster
semantics; use it as a reference for *what to signal on*, not as a spirectl design to build.

Constraints, each learned the hard way:

- **Push only.** No backstop poll, and no cheap-fact poll standing in for a missing signal. Report a missed signal
  with evidence instead.
- **Defer game reads out of the screen-changed callback by one frame** (see `ConnectionHostingTracker.ScheduleOnNextFrame`
  and `CouchCoopQrHostPanelController.WakeEvaluation`): resolving the current screen inside that callback segfaults
  uncatchably.
- **Guard any seam that reaches the engine with `CouchCoopMod.EngineAvailable`**; a test process can otherwise load
  the game assemblies, succeed at subscribing, and crash inside `Engine.GetMainLoop()`.
- **Never marshal to the main thread while holding a mod lock** (the `DescribeSeats` deadlock; see the remarks on
  `TryGetLobbyState`).
- Run presence stays true through the end-of-run summary. The reap predicate is "no run and no lobby".
- Keep the QR panel's behavior for a listener that failed to bind (the button stays reachable) and the
  once-per-mount alert latch.

The original verification design used a fake facts provider per path (the tracker's `FakeFacts` and `FakeScreenTrigger` in
`tests/CouchCoop.Mod.Tests/ConnectionHostingTrackerStateTests.cs` are the pattern), with time injected. The completed
implementation migrated historical fixtures to `RosterFacts` and removed the temporary full-snapshot oracles. The
zero-client tripwire is part of the focused gates. Static source and metadata checks, focused suites and both compile
lanes passed in the integration worktree. QA1 and QA2 read-count and signal evidence is recorded above.

## WP4: compile profile in spirectl (memo P2)

**4a completed:** the embedded compile profile landed, with its initial size reduction below the memo estimate.
**4b completed on local spirectl `main`:** one spirectl change trims the embedded copy
so it stops compiling and installing code CouchCoop cannot reach.
The bridge and CLI keep the **full** profile, byte-for-byte unchanged in behavior.

- **4a. Dead today (about 16K LOC, 19% of the IL); can start now, independent of WP3:** the legacy state-extractor
  lane, `Sts2RuntimeObservationProvider` with its geometry and presentation resolvers, `Core/Reference` and the
  reference provider, the combat-event hooks and hub, the host-local seat watchers, and the unreached action
  partials (`CardPile`, `Combat`, `DeckView`, `HandSelection`, `InspectRelic`, `TopBar`, and most of `ScreenIntents`
  and `RewardCommit`). The dispatcher's switch statically references all 64 action kinds, so the profile needs its
  own dispatcher list; CouchCoop uses 8.
- **4b outcome:** `StateSnapshot`, state builders/projection, screen and overlay inspectors, the state-only preview
  core and fixture-only helpers are excluded from Embedded. This includes the unused fixture helper and main-menu
  helper; profile tests pin their absence. Full retains those lanes and helpers. The Embedded game-API manifest also
  drops the four state-only member requirements identified in review; the Full manifest keeps them.

Implementation uses an MSBuild property the CouchCoop project reference selects and the bridge does not; explicit item lists
in place of the hand-maintained `Exclude` mirror on the `Live/**` glob (five entries there name files that no longer
exist, and `Live/Sts2SceneSubtreeStillKey.cs` is compiled twice); a composition-factory variant that neither
constructs nor installs the excluded lanes; the four state-only game-API member requirements dropped from the
Embedded manifest while Full retains them; and
`scripts/validate-spirectl-embedded-boundary.sh`'s 4 KB drift check replaced by "the embedded profile equals the
upstream build of the same profile".

**Verify each hook before dropping it.** A Harmony hook can change game behavior, not just observe. For each row:
find its consumer, check whether it only observes, and record the evidence in the commit. Initial verdicts, from the
memo (confidence in brackets):

| Install in `Sts2ReusableLiveCompositionFactory.Create` | Verdict |
| --- | --- |
| `Sts2HostLocalSeatSyncWatcher`, `Sts2HostLocalSeatTurnWatcher` | dead: synthetic seats only [high] |
| `Sts2DamageEventHooks`, `Sts2CardUpgradeEventHooks`, `Sts2VfxSpawnEventHooks` | dead: combat-event hub has no subscriber [high] |
| `Sts2ChooseACardOverlayHooks`, `Sts2HandSelectionHooks`, `Sts2EndTurnReadinessHooks`, `Sts2RewardsCaptureHooks` | probably dead for CouchCoop: outputs feed only dead lanes or `ClaimReward` [medium; `ClaimReward` remains in Full tooling and is absent from Embedded] |
| `Sts2MultiplayerConnectionHooks`, `Sts2SyntheticLobbyNameHooks` | keep: connection reporting and client-name overrides are live |
| `Sts2ParticleRestartHooks`, `Sts2SpineAnimationHooks`, `Sts2TweenRecorderHooks`, `Sts2CardFlightHooks`, `Sts2DiscardFlightHooks`, `Sts2HandHolderHooks` | keep: they feed the mirror's animation hints and scene stream |

The paired worktrees let CouchCoop build against the reviewed spirectl source without switching the shared sibling
checkout. After landing, `scripts/validate.sh bridge-tests` ran alone and passed; `bridge-build` with
`EnableSts2LiveHost=true` and the live-host gate passed. The CouchCoop pin has a `Refs:` trailer, and the paired
boundary check passed. Both installed copies were proved in a private game farm; the shared install was held by
other live owners and was not overwritten. The full mod, MirrorProtocol and Connection suites passed.

## WP5: make geoclip cheap to validate where it lives (memo P2b, contingent)

Only worth doing if geoclip work resumes; it has had one commit since publication, against 58 in the build-out
window. Its Godot-free core (7 of 9 files, 9.5K LOC, 62% of its IL) needs only three outside files
(`Sts2RenderPhaseProfile`, `Sts2SceneFitFrame`, and three types from `IAssetExtractProvider`). The baker (the two
Godot-typed files) is the blocker: it calls four static members of the asset extractor. A small interface seam would
let the core become its own project with an offline fixture leg, so iterating on it stops needing the live-host
legs and a pin bump. **Geoclip stays in spirectl either way.** Start with a one-page design and the maintainer's
go-ahead.

## WP6: move CouchCoop-only machinery, on touch (memo P3)

Not a project. When CouchCoop next has to change one of these, move it first, in this order: the scene watcher and
scene-delta DTOs (about 10K LOC), the animation and card-flight hooks (about 4K), and the embedding ports last (they
are the seam). Preconditions: the maintainer confirms it is not earmarked for a spirectl consumer; spirectl exposes
a small public substrate (dispatcher, screen locator, introspection, build identity, the lane probe);
`verify-reflected-game-members.sh` has a runner covering both source trees (WP8) before any by-name read moves. The
geoclip baker and the Spine hooks, inspector and materials it stands on do **not** move.

## WP7: zero-client guard (complete)

The zero-client tripwire and whole-host contract test landed in `626335f1`; its focused `-- zero-client` gate passes.

[handoff-zero-client-guard.md](handoff-zero-client-guard.md) proceeds independently. Its choke point is
`CouchCoopRuntimeDependencies.FromFactory` and `CouchCoopRuntimeHost` for the runtime ports, **plus** the direct
statics that bypass them: `Sts2ScreenContext` (the tracker subscribes to it), the dispatcher and build identity.
Wrap those call sites too, or put a CouchCoop-owned facade over them, so the tripwire also catches the next
subscriber WP3 adds.

## WP8: housekeeping

- The reflected-members runner covers the CouchCoop and spirectl source trees.
- The live-host test leg is now a passing gate.
- Keep [architecture-map.md](architecture-map.md) accurate as code moves; the current roster and WP4b status is
  recorded there and in this handoff.
- **Maintainer:** delete the `roster-port` branch (`77d5f2dc`) and the leftover round worktrees when ready.

## Questions for the maintainer

1. Is the scene stream, the animation-hint stream, or the browser input maps earmarked for a spirectl consumer?
2. Can `SelectMapNode` be replaced by real input while preserving map voting and the travelable gate? Investigate
   before changing it.
3. Remove the host-start transport cap probe, which reads null in stock flows? This is separate from the working
   per-join live lobby-cap read that bounds seat allocation to `cap - 1`.
