# Silence streams that draw nothing at the producer — handoff

For a Claude Code coordinator (Opus) that runs the round with Opus and Sonnet subagents, each in its own worktree.

The goal: a node whose transform cannot move a visible pixel stops being sent by the host. In idle combat that is the
spine bone follower `…/Creature/Ironclad/Visuals/EyeSlot`. It is 737 of 738 scene deltas, about 35 per second, and its
only child `EyeFire` is hidden. The client already ignores it (`rustSkipUndrawnWire`, couch `138778e7`). The host still
reads, diffs, serializes, coalesces and sends it, the phone still parses and applies it, and the producer never idles.

Base: couch `main` 40004ce9, godot-scene-web `main` f18c4dd6, spirectl `main` d737e3c1. Line numbers are at those
commits.

**Go-ahead.** §8 of [handoff-wire-shaped-renderer.md](handoff-wire-shaped-renderer.md) reserved this change for the
maintainer. The maintainer asked for this round on Oct 4. That go-ahead covers the emission policy inside spirectl's
scene watcher. It does not cover moving the watcher into couch, new polling, or spirectl write actions.

## 1. What is already known (do not re-measure)

**The emission policy lives in spirectl.** Couch builds spirectl from source as `CouchCoop.Spirectl`
(`src/CouchCoop.Mod/CouchCoop.Mod.csproj:63-80`, root from `Directory.Build.props:23`, overridable with
`-p:CouchCoopSpirectlRoot=<path>`). The path of a delta:
- `Sts2RuntimeSceneWatcher` (`spirectl/bridge-mod/src/Spirectl.Sts2/Live/Sts2RuntimeSceneWatcher.cs`) polls on the main
  thread (`OnTick` `:532`). It paces at 16 ms and backs off to 128 ms while nothing emits (`:26`, `:35`, `:566`).
- `Capture` (`:678-1406`) decides what is sent: `ReadVolatile` (`:2790`), folds and caps (`:973-1249`),
  `ApplyIfChanged` (`:3224`), `BuildNodeDelta` (`:3426`).
- `Dispatch` (`:3709`) hands the delta to couch.
- Couch: `CouchCoopSceneObserver.OnDelta/Apply` (`:45-98`) keeps the retained map that keyframes come from
  (`BuildKeyframe` `:331`) and calls `HeadlessIdleActivity.Mark()` on every delta (`:62`).
- `CouchCoopBrowserServer.BroadcastSceneDelta` (`:1079-1107`) → per-connection `SceneDeltaCoalescer` → ack-gated pump
  (`CouchCoopWebSocketConnection.cs:1378`, `:1552`) → `BrowserSceneDeltaMessage.Serialize` → client
  (`mirrorClient.ts:529`, `sceneTree.ts:575`).

**The closest precedent is R15, the creature spine-anchor fold** (`Sts2RuntimeSceneWatcher.cs:973-1011`, policy in
`Live/Sts2SpineAnchorFold.cs`). It withholds the transform of a spine skeleton leaf that carries no paint of its own
(`CarriesOwnPaint` `:1658`). The `suppressDepth` sentinel (`:748-875`) withholds its subtree's transforms too. It has
two arms:
- **Arm A:** the anchor has no descendants.
- **Arm B:** the anchor is named in a scene table (`EmitterAnchorPathsByScene` `:92-179`), and a live scan
  (`SpineAnchorSubtreeQuiet` `:1686`) finds only inert classes (`IsInertDescendantClass` `:246`) or idle particle
  emitters.

While suppressed, `LastTransform` does not advance (`:3319-3322`), so the first capture that fails the gate emits the
live pose. Kill switches: `SPIRECTL_SPINE_ANCHOR_FOLD` (`:319`) and `SPIRECTL_DECOR_EMIT_SUPPRESS` (`:242`).

**Why `EyeSlot` escapes R15.** In the live capture `.sts2/research/spirectl-boundary-review-sep26/wp4b-live-qa2/death-scene.json`,
`EyeSlot` is a `SpineSlotNode` and `EyeFire` is a `TextureRect`. Arm A fails because there is a child. Arm B fails twice:
the ironclad isn't in the table, and `TextureRect` isn't an inert class. Neither arm looks at the child's own `visible`.

**Descendants of a suppressed root are still read every tick.** `suppressTransform` only withholds the transform
(`:863-866`). So a visibility flip on `EyeFire` is already observed and emitted on the tick it happens. What would go
wrong is the anchor: it is withheld, so `EyeFire` would draw at a stale `EyeSlot` pose.

**What the producer knows.** Each node's own `Visible`, modulate and self-modulate (`:2794`). By design it never calls
`IsVisibleInTree` (header `:16-19`); the client composes visibility down the chain. `Tracked.LastVisible` (`:3942`) is
one capture old for an anchor, because the anchor is read before its children (pre-order).

**Client side, already measured (Oct 4, wire-shaped round):**
- On the phone, as-recorded idle combat now costs the same CPU per second as the quiet recording, in both arms (+0.4% /
  +0.6%). Since WP7 the wire frames coincide with display-rate idle frames. **So this round's win is host-side and on
  the network, not phone rendering.**
- Desktop: as-recorded retained patches are 51 → 1/s with the client skip on.
- The client still spends one JSON parse, a `MirrorState` apply and an ack per delta.
- Nothing on the client needs an invisible node's transform except to pose its descendants once they draw
  (composition down the chain). The audit covered `interactionRuntime.ts:750` captured globals, remote followers
  (`spreadLayout.ts:184-189`), the `anchorOwnerId` hover-tip owner, hit tests and the DOM stage's dormant subtrees
  (`renderer/dom/nodeWalker.ts:198-224`). The native `godot-client` `SceneReconciler.cs` was not audited.

**Per-seat streams.** Every streaming connection on a process gets the same producer stream, coalesced per connection.
Joined viewers are redirected to their own headless seat process with its own watcher. Seats freeze spines
(`CouchCoopHeadlessVisualSuspender.cs:1-30`), so the `EyeSlot` stream is probably a host (direct-view) effect. That is
inferred, not verified: WP0 settles it.

## 2. Target design

1. **A third R15 arm, structural, with no table.** Withhold the anchor's transform when it is a paintless spine
   skeleton leaf and every descendant is either an inert class or a CanvasItem whose own `Visible` is false. A hidden
   descendant's own subtree is not scanned, because it cannot paint while its parent is hidden. Use the values the walk
   already holds (`LastVisible` of each descendant); add **no new reads**. The scan stays bounded and short-circuited,
   like arm B.
2. **Flush on the flip, in the same delta.** When a descendant inside a suppressed subtree emits a visibility change
   (or any field that can make it paint), the suppression root's live transform must ship in the **same** delta, ahead
   of the descendant in `orderedIds`. The root was read this tick, so this is a fix-up after the walk with no extra
   Godot read. The next capture then sees the gate fail and continues normally. A one-capture-late pose is not
   acceptable.
3. **The policy stays pure and testable**, as in R15. The decision is a pure function in `Sts2SpineAnchorFold.cs`
   (or a sibling), tested by table. The watcher only gathers facts.
4. **Let the producer go quiet.** With the stream gone, idle combat should reach the watcher's 128 ms back-off, and
   `HeadlessIdleActivity` should stop being marked by a stream that draws nothing. Verify both; don't add mechanisms
   for them.
5. **Kill switch:** a new env switch for the arm (for example `SPIRECTL_SPINE_ANCHOR_HIDDEN_FOLD`), default on, under
   the existing master switches.
6. **Keep the client skip.** `rustSkipUndrawnWire` stays as the safety net for anything the producer still sends.

Out of scope this round:
- moving the watcher into couch (`spirectl-boundary-review.md:92`, P3 `:304-309`);
- treating modulate alpha 0 as "draws nothing" (fading folds such as the proceed and end-turn glows rely on alpha);
- anything beyond spine anchors, unless WP0's census finds another large stream (see WP3).

## 3. Success criteria

| Measure | Now | Target |
| --- | --- | --- |
| Live idle combat: `EyeSlot` transform emits per second at the producer | ~35 | **0** |
| Live idle combat: scene-delta messages per second to one streaming client | ~35 + clock | **clock text only** |
| Watcher capture cadence in idle combat | 16 ms (never backs off) | **reaches the 128 ms back-off** |
| Host process CPU per second, idle combat, one client streaming (`/perf/scene-delta.json` cpu block or `/proc`) | set by WP2's baseline | **≥ 10% lower**, host and seat combined, interleaved (`handoff-host-cpu.md` rule) |
| `rustSkipUndrawnWire.skipped` on the client, live idle combat | ~35/s | **~0** (the producer did it) |

The user's standing preference (memory `user-renderer-playtest-preference`): **large, obvious wins**. If the host CPU
row misses 10% and nothing else improves visibly, record the result as REJ in the ledger, keep the branch, and don't
land it.

**No regression:**
- **Flip correctness:** when `EyeFire` (or any hidden descendant under a suppressed anchor) turns visible, it is posed
  at the live anchor transform in that delta. A late joiner's keyframe is correct too.
- **Pixel parity:** fixed-clock screenshots of combat on the canvas and DOM stages, arm on vs off, for at least two
  creature encounters.
- `rustFastVerify=1` mismatch counters stay 0.
- spirectl `bridge-tests` and couch `Mod.Tests` / `MirrorProtocol.Tests` stay green.
- The touch harness is as green as `main` (canvas H16 reward-focus flakes on `main` too).

## 4. Rules for this round

The rules of [handoff-idle-combat-frame-cost.md](handoff-idle-combat-frame-cost.md) §3 and
[handoff-wire-shaped-renderer.md](handoff-wire-shaped-renderer.md) §4 apply, adapted for spirectl:
- never `npm run build`, `git push` or tag; land spirectl first, as squash commits under its Conventional Commits hook;
- leave `../spirectl` and `../godot-scene-web` on clean `main`; work in worktrees;
- **no new polling:** the watcher's poll exists and stays, but don't extend it with new reads. The design above uses
  values already read. If it turns out to need a new per-tick read or a timer, stop and report instead;
- no spirectl semantic or write actions to cause state changes. Don't toggle `EyeFire` through the bridge to test the
  flip. If no natural trigger exists, prove the flip with the pure tests and the fix-up unit test (WP1);
- no visible game window, and no Xvfb. Live instances run under `gamescope --backend headless` (CLAUDE.md "Automated
  game displays");
- game internals: node names and a structural rule are fine to commit; game code and walkthroughs of the game's logic
  are not (CLAUDE.md "Game internals in committed files");
- **don't ask the user anything** (memory `dont-ask-run-autonomously`). Phone sessions, merges, squash commits and the
  `couch-deploy` redeploy go ahead without asking. Decide and report at the end;
- **avoid command shapes that trigger permission prompts**, so the round finishes with nobody at the keyboard:
  - no `cd … &&` compounds; use absolute paths, `git -C` or `--prefix`;
  - multi-step shell, adb and `$(…)` work goes into a scratchpad script run as a plain `bash /abs/path/script.sh`;
  - no edits under `.claude/`, `.git/` or settings files;
  - kill by PID, not with `pkill -f`;
  - background long waits instead of sleep loops;
- the phone may be on a secure lock screen (memory `phone-secure-keyguard-blocks-autonomous-rounds`). Check the
  keyguard first. If it is locked, record MFAIL and use desktop numbers; never try to get past the lock;
- `../spirectl/scripts/validate.sh bridge-tests` must run **alone**: alongside other legs it hits the MSB3030 race;
- `dotnet test` does nothing on couch's C# suites. Use `dotnet run --project tests/CouchCoop.Mod.Tests` and
  `…/CouchCoop.MirrorProtocol.Tests`;
- a spirectl change has two copies to deploy: `sts2 game install-bridge` (bridge) and `scripts/build-local-mod.sh`
  (the embedded copy couch serves). See the `couch-deploy` skill;
- add a ledger row to `renderer-optimization-ledger.md` per attempt, and update memories with `project-memory`.

## 5. Team, models and worktrees

The coordinator is the main session on **Opus**. It creates the worktrees, reviews and merges, runs the final
measurement and reports to the user. Each branch gets an Opus `general-purpose` reviewer running `code-review` at
level high.

| WP | Owner (model) | Repo / main files |
| --- | --- | --- |
| WP0 census + trigger + baseline | `mirror-bench` (**Sonnet**), with a `live-game-qa` helper for the live instance | read-only; results under `.sts2/bench/producer-quiet/wp0/` |
| WP1 hidden-descendant anchor arm + flip flush | round-implementer (**Opus**) | spirectl `Live/Sts2RuntimeSceneWatcher.cs`, `Live/Sts2SpineAnchorFold.cs`, tests in `bridge-mod/tests/Spirectl.BridgeMod.Tests/` |
| WP2 measurement | `mirror-bench` (**Sonnet**) | read-only; `.sts2/bench/producer-quiet/wp2/` |
| WP3 (optional) further streams | round-implementer (**Opus**) | only if WP0 finds another invisible stream of the same size |
| Touch harness | `touch-input-qa` (**Sonnet**) | read-only |

**Worktrees:**
- **spirectl:** `spirectl-quiet-<wp>` on `round/quiet-<wp>`, via `git -C ../spirectl worktree add`.
- **couch:** use the `couch-worktree` skill (`cc-quiet-<wp>` on `round/quiet-<wp>`). Build it against the spirectl
  worktree with `-p:CouchCoopSpirectlRoot=<spirectl worktree>` and `COUCHCOOP_GAME_MODS_DIR=/tmp/cc-mods-quiet-<wp>`.
- Live instances are isolated (`instances/<name>`, a private `gamescope --backend headless`), never the user's own game
  on :13337. A scratch `COUCHCOOP_GAME_MODS_DIR` does not isolate the game's mod scan (memory
  `modsdir-does-not-isolate-touchqa`); use the public-beta second install for live legs, under the
  `exclusive:install:public-beta` lease.
- Pass absolute paths in every brief.

**Phases:**
- **A:** WP0, then WP1 starting from WP0's census (WP1 may begin the pure policy and its tests in parallel).
- **B:** WP2 before/after measurement, the review, the touch harness, and WP3 only if warranted.
- **C:** land spirectl, deploy both copies, land couch's bookkeeping, and one phone session if the phone is
  unlocked.

**Briefs** name the WP section, worktree paths, branch and kill-switch name. Each asks for a diff on the branch,
passing gate output, evidence paths, and a report of at most 15 lines.

## 6. Work packages

### WP0 — census, trigger and baseline (Sonnet, read-only)

1. **Which process sends the stream.** Take a fresh `repro/1` recording of idle combat (`scripts/record-mirror-stream.mjs`)
   from an isolated live host in direct view, and one from a joined seat. Count transform emits per node per second.
   Confirm or refute that `EyeSlot` streams only on the host.
2. **Census of invisible streams.** For idle combat with two or three different creatures, a map, a shop and an
   event: list every node whose transform is emitted at least 1/s while it and all its descendants draw nothing.
   Use the client's own verdict (`undrawnWireSpan` in `createPixiMirrorRenderer.ts:1649-1675`, or the
   `rustSkipUndrawnWire` counters) to label each one. Group the results by class and by parent pattern. This
   decides whether the spine-anchor arm is enough or WP3 is needed.
3. **Does `EyeFire` ever turn visible**, and what triggers it in play? Find a fixture or scenario that reaches the
   trigger, if one exists. Don't use a write action to force it.
4. **Baseline:** on the live host, with one headless-browser client streaming at the phone viewport, measure host
   CPU per second, scene-delta messages per second and wire bytes (`/perf/scene-delta.json?arm=1&reset=1`, or
   `COUCHCOOP_WIRE_METRICS=1`), plus the watcher's capture cadence. If the embedded profiler is off
   (`Sts2RuntimeInstrumentation.None`), use the tick interval or the emit count over time. Interleave at least 3
   reps and record the load average.

### WP1 — hidden-descendant anchor arm and flip flush (Opus, spirectl) — switch `SPIRECTL_SPINE_ANCHOR_HIDDEN_FOLD`

- **Pure policy first.** Extend `Sts2SpineAnchorFold.ShouldSuppressTransform` with a third arm, fed by a new fact:
  "every descendant is inert or locally hidden, with hidden subtrees pruned". Write the decision-table tests next to
  `Sts2SpineAnchorFoldTests.cs`.
- **Gathering the fact** in the watcher reuses the descendants' `LastVisible` and class, already known from earlier
  captures. It must stay short-circuited (only for a paintless skeleton leaf with descendants) and bounded, like
  `SpineAnchorSubtreeQuiet`.
- **The flip flush:** in the same capture where a descendant of a suppressed root emits `visible` (or any field
  that can make it paint), emit the root's live transform before that descendant, and clear the suppression for
  the subtree for that capture. Factor the decision as a pure function so it can be unit-tested without Godot
  (the watcher loop has no Godot-free harness). Test it: a hidden child turns visible → the root's live transform
  and the child's `visible:true` appear in the same delta, root first in `orderedIds`.
- **Never apply the arm on `JustAdded`,** exactly like R15, and honour the master switches.
- **Keyframes:** confirm a late joiner sees `EyeSlot`'s last emitted pose while suppressed (harmless while hidden),
  and the live pose once the flip flush has run.
- **Gates:**
  - `../spirectl/scripts/validate.sh bridge-tests`, run alone;
  - the couch C# suites via `dotnet run --project …`, built against the spirectl worktree;
  - a live isolated host with the arm on: `EyeSlot` emits 0/s, and the client's `rustSkipUndrawnWire.skipped` ≈ 0;
  - the flip, live if WP0 found a trigger, otherwise the unit test;
  - pixel parity on vs off (fixed-clock screenshots, canvas and DOM, two encounters; list the image paths);
  - `rustFastVerify=1` at 0.

### WP2 — measurement (Sonnet)

Repeat WP0's baseline with the arm on vs off (the kill switch), interleaved ABBA, at least 3 reps. Report host CPU per
second, messages per second, wire bytes per second, watcher cadence, and the client's skip counter. Repeat the seat
leg if WP0 found the stream there. If the phone is unlocked, run one phone cell: as-recorded idle combat streaming
live, phone renderer CPU per second, arm on vs off. It is expected to be flat, so it only guards against regression.

### WP3 — optional: other invisible streams (Opus)

Only if WP0's census finds another stream of comparable size that the spine-anchor arm doesn't cover. Generalise the
rule structurally (a paintless node whose whole subtree is locally hidden or inert), with the same flip flush, tests
and gates as WP1. If the census finds nothing, skip it and say so.

## 7. Integration

- **Per WP:** implementer commits → Opus `code-review` → fixes → coordinator gates → squash.
- **spirectl lands first** on its `main` as one squash commit, for example
  `perf(scene): withhold spine anchors whose descendants are hidden`, with a player-facing `Changelog:` line if
  spirectl's convention asks for one.
- **Then deploy both copies** through `couch-deploy`, without asking: `sts2 game install-bridge`, then
  `scripts/build-local-mod.sh` under the `exclusive:install` lease, and prove the installed build. Couch has no
  product change unless WP1 needed one; its commit carries the ledger rows (`docs(bench): …`).
- **The on/off play-test is host-side:** the kill switch is an environment variable read at game start, so
  comparing needs a game restart with `SPIRECTL_SPINE_ANCHOR_HIDDEN_FOLD=0`. Say so in the final report.
- **Close-out:**
  - a ledger row per attempt, including WP0's census and any MFAIL;
  - update memory `topic-rust-stage` (or a producer topic) and add memories for any traps found;
  - correct the old warning in memory `idle-wire-silence-and-backstop-occlusion`, which only holds while the
    subtree paints;
  - remove the worktrees.

## 8. Follow-ups (do not start in this round)

- **Move the scene watcher into couch** (`spirectl-boundary-review.md` P3) once the maintainer confirms nothing else in
  spirectl needs the scene stream.
- **The intent-frame source swaps:** about 67 patch frames per busy replay that Rust could also take (found by WP6 of
  the wire-shaped round).
- **The `rustTextPatch` verify mismatch** on an equal-width clock swap ("04:01"). It is present on `main` with or
  without GL.

## 9. Copy/paste prompt for the coordinator

> Run the round in `docs/agents/handoff-producer-invisible-suppression.md` as its Opus coordinator.
>
> 1. Read §1–§5, the Oct 4 ledger rows, the memories `rust-skip-undrawn-wire-oct4`, `dont-ask-run-autonomously`,
>    `user-renderer-playtest-preference`, `idle-wire-silence-and-backstop-occlusion` and `topic-rust-stage`, and R15 in
>    `../spirectl/bridge-mod/src/Spirectl.Sts2/Live/Sts2SpineAnchorFold.cs`.
> 2. Create the worktrees: spirectl via `git worktree add`; couch via `couch-worktree`, built with
>    `-p:CouchCoopSpirectlRoot=<spirectl worktree>`.
> 3. **Phase A:** WP0 (mirror-bench, Sonnet, with a live-game-qa helper), then WP1 (round-implementer, Opus); WP1 may
>    start the pure policy and its tests at once.
> 4. **Phase B:** WP2 (mirror-bench, Sonnet) on vs off; the touch harness; WP3 only if WP0's census warrants it.
> 5. **Phase C:** land spirectl first, deploy both copies through `couch-deploy`, commit the ledger rows, and run one
>    phone cell if the phone is unlocked.
>
> Rules for every WP:
> - Review each branch with an Opus `code-review` pass before merging.
> - Add a ledger row per attempt.
> - Never `npm run build`, push or tag; leave the siblings on clean `main`; land spirectl first.
> - Do not ask the user anything. Use command shapes that don't trigger permission prompts (§4).
> - No new polling and no spirectl write actions. If the design needs either, stop and report.
>
> Finish with a report to the user:
> - the squash commits on spirectl and couch `main`;
> - the deployed build (both copies);
> - the measured results against §3;
> - how to switch the arm off for an on/off play-test (an environment variable plus a game restart).
