# Implement the spirectl boundary recommendations

Prepared 2026-09-26. A bounded implementation handoff for [spirectl-boundary-review.md](spirectl-boundary-review.md)
(the "memo"). Nothing here has been started except what is listed under "Where things stand". Steps marked
**maintainer** are decisions, not agent work.

## Where things stand

- **Landed:** the hosting tracker is event-driven (`b6a1ec12`), its state-subscription fallback is gone (`a9f382b6`),
  and the memo is committed (`7c2ad70a`).
- **`a9f382b6` was done before it was asked for.** The maintainer's decision was "the fallback must be removed",
  not "remove it now". It is local, unpushed, one commit, and verified (`seats`, `idle-host`, `connections` in a
  clean worktree). Keep it unless the maintainer says otherwise; `git revert a9f382b6` undoes it cleanly. This
  handoff treats it as landed.
- **Decided by the maintainer:** geoclip stays in spirectl (a tool in the making: cheap animated Spines without the
  Spine library); no backstop poll for hosting end; roster observation is push-only and the run-end reap fires only
  once the game has left both the run and any lobby, with the end-of-run summary still counting as in-run
  (memory `roster-push-only-run-end-rule`).
- **Still the maintainer's:** approving the `CLAUDE.md` / `AGENTS.md` wording (memo §9); whether the scene stream or
  animation hooks are earmarked for a spirectl consumer (gates WP6); the `ClaimReward` allow-list and the two
  "awaiting the maintainer's call" browser actions; deleting the paused `roster-port` branch.
- **Correction to earlier notes:** the recurring full-state captures are **not** all gone. The tracker was the last
  *unbounded* poll. One bounded recurring read remains: the QR host panel's 0.25 s chain pulls the full lobby state on
  every tick while a lobby screen is the current screen (WP3 item 1). `CouchCoopStateObserver` also runs a 50 ms
  subscription while a viewer is parked on the join picker.

## Rules for every work package

- **Do not edit `CLAUDE.md` or `AGENTS.md`.** Until the maintainer approves the new wording, the current rule
  stands (spirectl owns reusable code; an exception needs the maintainer's go-ahead). The two exceptions granted so
  far are the seat peer-list read (`7d089e03`) and the hosting tracker.
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

## WP1: compile the tracker on the v107 lane (small, independent)

`b6a1ec12` and `a9f382b6` were compiled against v111 only. The v107 decompile corpus (`.sts2/toolchain-public`)
declares the same public run-in-progress member, so the risk is small, but no v107 compile has run. Both reference
packages are cached in the local NuGet store. In a **worktree** (the release script wipes every `src/**/{bin,obj}`
before a lane, and the two lanes must not share intermediates):

1. Stage the SDK: `dotnet build eng/Sts2.ReferenceSdk/stable/Sts2.ReferenceSdk.stable.csproj -c Release -o <scratch>/sdk
   -p:RestoreLockedMode=true -p:ContinuousIntegrationBuild=true -p:DebugSymbols=false -p:DebugType=None`.
2. Build the mod against it: `dotnet build src/CouchCoop.Mod/CouchCoop.Mod.csproj -c Release
   -p:CouchCoopBuildToLocalMods=false -p:Sts2AssembliesDir=<scratch>/sdk -p:Sts2GameApi=v107
   -p:EnableSts2LiveHost=true`, with `DOTNET_ROLL_FORWARD=Major`.

This mirrors the lane loop in `scripts/package-release.sh` (which builds the Loader project, and so the mod). It
proves compilation only; the SDK is declaration-only, so no test can run against it. Report the result either way.

## WP2: delete the dead connecting-player path (small, independent)

Recorded as a maintainer decision on 2026-09-25 in the paused roster round. Delete `MayLaunchNewHeadless`,
`HasFreeLobbySlot`, `EnsureLobbyPlayer`, `FindPlayerIdByName` and the instance `RosterNames()` from
`Session/CouchCoopLobbyParticipation.cs`, the gate in `HostUi/CouchCoopLobbyHostGate.cs` that mirrors
`MayLaunchNewHeadless`, and their tests (`CouchCoopLobbyHostGateTests`, `HostPeerRoutingTests`,
`HeadlessClientManagerTests`). Today only comments reference the first two outside that file; **re-verify each has
no live caller before deleting it**, including the hot-reload build. It also makes two semantic-action uses
unreachable: `JoinLobbyPlayer` (its only caller is `EnsureLobbyPlayer`) and `LeaveLobbyPlayer` (called from
`CouchCoopWebSocketConnection` on disconnect, and always refused because CouchCoop's seats are real ENet clients).
Remove those calls and the matching comment in `BrowserSessionRegistry`. This shrinks WP3's surface first.
Suites: `seats`, `host-guards`, `host-ui`, `connections`.

## WP3: retire the remaining full-state reads (memo P1)

Goal: CouchCoop never calls `GetCurrentState` or `SubscribeCurrentState`. That is what lets WP4b stop compiling
the state builders, the screen inspectors and `StateSnapshot` (about 12K LOC). Work **by read path**, one commit
each, most valuable first. Re-check each row against the code before starting; line numbers drift.

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

**Design direction, not a spec.** A CouchCoop-owned reader of those facts, typed against the game assemblies with the
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

Tests: a fake facts provider per path (the tracker's `FakeFacts` and `FakeScreenTrigger` in
`tests/CouchCoop.Mod.Tests/ConnectionHostingTrackerStateTests.cs` are the pattern), with time injected. For parity,
keep the old full-snapshot read as a **test-only oracle** until the last path lands and assert the new facts equal
its projection on the existing fixtures. Add the tripwire from [handoff-zero-client-guard.md](handoff-zero-client-guard.md)
before the last path so a regression is visible. One headless live session per path (private compositor only, see
`CLAUDE.md` "Automated game displays") with before and after read counts.

Acceptance: `grep -rn "GetCurrentState\|SubscribeCurrentState\|WatchCurrentStateAsync" src` finds nothing outside the
runtime-ports adapter; every suite above passes on v111 and compiles on v107; a hosted run shows no full-state
capture on the game thread outside a join.

## WP4: compile profile in spirectl (memo P2)

One spirectl change, in two parts, so the embedded copy stops compiling and installing code CouchCoop cannot reach.
The bridge and CLI keep the **full** profile, byte-for-byte unchanged in behavior.

- **4a. Dead today (about 16K LOC, 19% of the IL); can start now, independent of WP3:** the legacy state-extractor
  lane, `Sts2RuntimeObservationProvider` with its geometry and presentation resolvers, `Core/Reference` and the
  reference provider, the combat-event hooks and hub, the host-local seat watchers, and the unreached action
  partials (`CardPile`, `Combat`, `DeckView`, `HandSelection`, `InspectRelic`, `TopBar`, and most of `ScreenIntents`
  and `RewardCommit`). The dispatcher's switch statically references all 64 action kinds, so the profile needs its
  own dispatcher list; CouchCoop uses 8.
- **4b. Dead once WP3 lands (about 12K LOC, 14%):** `StateSnapshot`, the state builders and projection, the screen
  and overlay inspectors (the scene watcher keeps only the screen locator).

Mechanism: an MSBuild property the CouchCoop project reference selects and the bridge does not; explicit item lists
in place of the hand-maintained `Exclude` mirror on the `Live/**` glob (five entries there name files that no longer
exist, and `Live/Sts2SceneSubtreeStillKey.cs` is compiled twice); a composition-factory variant that neither
constructs nor installs the excluded lanes; game-API manifest requirements that only the excluded lanes read dropped
from the embedded profile (about 8 of 20; a miss there is fatal at startup today); and
`scripts/validate-spirectl-embedded-boundary.sh`'s 4 KB drift check replaced by "the embedded profile equals the
upstream build of the same profile".

**Verify each hook before dropping it.** A Harmony hook can change game behavior, not just observe. For each row:
find its consumer, check whether it only observes, and record the evidence in the commit. Initial verdicts, from the
memo (confidence in brackets):

| Install in `Sts2ReusableLiveCompositionFactory.Create` | Verdict |
| --- | --- |
| `Sts2HostLocalSeatSyncWatcher`, `Sts2HostLocalSeatTurnWatcher` | dead: synthetic seats only [high] |
| `Sts2DamageEventHooks`, `Sts2CardUpgradeEventHooks`, `Sts2VfxSpawnEventHooks` | dead: combat-event hub has no subscriber [high] |
| `Sts2ChooseACardOverlayHooks`, `Sts2HandSelectionHooks`, `Sts2EndTurnReadinessHooks`, `Sts2RewardsCaptureHooks` | probably dead: outputs feed only dead lanes or `ClaimReward` [medium; `ClaimReward` is still allow-listed] |
| `Sts2MultiplayerConnectionHooks`, `Sts2SyntheticLobbyNameHooks` | keep: connection reporting and client-name overrides are live |
| `Sts2ParticleRestartHooks`, `Sts2SpineAnimationHooks`, `Sts2TweenRecorderHooks`, `Sts2CardFlightHooks`, `Sts2DiscardFlightHooks`, `Sts2HandHolderHooks` | keep: they feed the mirror's animation hints and scene stream |

Spirectl's own process applies (see the `spirectl` skill and its docs): pair-root worktrees so CouchCoop builds
against the branch (`CouchCoopSpirectlRoot`), `scripts/validate.sh bridge-tests` **alone**, `bridge-build` with an
explicit `-p:EnableSts2LiveHost=true`, and the live-host test leg with the `Sts2HostTests` exclusion, compared **by
failing test name** against the 9 known failures at `386c7ed6` (`Sts2MainMenuStartRunTests` x3,
`EncounterVisualCatalogTests` x1, `Sts2EmbeddableAssetProviderTests` x5), never by count. Both game lanes' manifests
change and both must be pinned. Then a CouchCoop pin bump with a `Refs:` trailer, the boundary script, the couch
suites, and a redeploy of **both** copies (bridge and mod). Re-run the memo's IL measurement (the local tool under
`.sts2/research/spirectl-boundary-review-sep26/size/tool`) and report before and after. Acceptance: the embedded IL
falls by about the figures above; the bridge, CLI and `bridge-tests` behave as before; a game update can no longer
stop CouchCoop from starting over a member only an excluded lane read.

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

## WP7: zero-client guard

[handoff-zero-client-guard.md](handoff-zero-client-guard.md) proceeds independently. Its choke point is
`CouchCoopRuntimeDependencies.FromFactory` and `CouchCoopRuntimeHost` for the runtime ports, **plus** the direct
statics that bypass them: `Sts2ScreenContext` (the tracker subscribes to it), the dispatcher and build identity.
Wrap those call sites too, or put a CouchCoop-owned facade over them, so the tripwire also catches the next
subscriber WP3 adds.

## WP8: housekeeping

- Give `scripts/verify-reflected-game-members.sh` (spirectl) a runner and make it cover both trees: nothing runs it.
- The live-host test leg is red on a clean checkout (9 failures). Fix or quarantine them so it can be a gate.
- Keep [architecture-map.md](architecture-map.md) accurate as code moves; update the subsystem entries in the same
  commit.
- **Maintainer:** delete the `roster-port` branch (`77d5f2dc`) and the leftover round worktrees when ready.

## Order

```
WP1 ─┐
WP2 ─┼─► WP3 (path 1 first, one commit per path) ─► WP4b ─► WP6 (on touch)
WP4a ┘        WP7 in parallel; the tripwire lands before WP3's last path
WP5 only if geoclip work resumes;  WP8 alongside;  maintainer's wording approval anytime
```

Start with WP1, WP2 and WP4a in parallel: none depends on another, and each is small.

## Questions for the maintainer

1. Approve or amend the wording in memo §9 (it decides whether agents still ask permission for CouchCoop-side reads).
2. Is the scene stream, the animation-hint stream, or the browser input maps earmarked for a spirectl consumer?
3. Keep or revert `a9f382b6`?
4. `ClaimReward` is allow-listed but no longer sent by the frontend; `SelectMapNode` and `SetScrollOffset` are still
   "awaiting your call". Retire, keep or ratify each?
