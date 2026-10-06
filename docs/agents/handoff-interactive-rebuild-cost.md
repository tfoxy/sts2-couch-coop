# Interactive rebuild cost on the Rust stage — fix handoff

For a Claude Code coordinator (Opus) that runs the round with Opus and Sonnet subagents, each in its own
worktree. The goal is a play-test-visible win: dragging and aiming a card on a phone must stop
saturating the page's main thread. Also fix the repro replay tool, which is broken, so it can serve as
this round's harness.

## 1. What is already known (do not re-measure)

Evidence:
- The ledger row "Oct 2 interactive aim attribution" in
  [renderer-optimization-ledger.md](renderer-optimization-ledger.md).
- Memories `rust-interactive-spread-build-cost-oct2` and `replay-repro-session-and-seat-gaps`.
- Raw files: `.sts2/bench/interactive-cost-oct2/README.md` in the main checkout.
- The user's inputs: `/opt/user/share/Trace-20261002T020643-card-target.json` (gzipped DevTools trace) and
  `/opt/user/share/repro-2026-10-02T05-08-25-986Z-card-target.ndjson` (repro/1).

Device and build: Moto g86, Chrome 153, 739x281 @ DPR 3.49, widescreen stretch on (designWidth 2520),
Rust canvas stage, build `2b06e30a`. While aiming, the renderer main thread is 80–105% busy; the GPU process
is ~17%.

| Cost (share of a 5.82 s trace) | % |
| --- | ---: |
| Full producer builds (`paint()` → `buildDrawList`): ~23/s, median 13.5 ms | 25.4 |
| · from the animation tick (`frameScheduler` → `runBuild`) | 9.4 |
| · from wire reconcile | 9.3 |
| · from touch `flushHover` → `setHeldCard` → `rebuildAndPaint` | 6.7 |
| Hand-raise pass (`scanRaiseIndex` + `createChildIndex`, rebuilt from scratch each call) | 7.9 |
| Wasm/Rust (apply_patch, serde JSON admit, wgpu submit) | ~12 |
| GC (heap saw-tooth 24 → ~100 MB per ~1.3 s, promoted per-build churn) | 4.5 |
| All text | 2.8 |

Mechanisms, each confirmed in source:

1. **Spread disables the hidden-subtree memo.** `buildDrawList.ts:1423` requires `!spreading`
   (`spreadFactor !== 1`, :1141). So on any screen wider than 16:9 with stretch on, every build walks
   about 2,928 hidden nodes. A desktop replay A/B at the phone viewport measured total build time of
   1,193/1,228 ms with stretch on vs 621/621 ms with `?stretch=off`.
2. **Builds are not coalesced.** In the same frame, `setHeldCard` builds synchronously
   (`interactionRuntime.ts:1219-1238`, twice on an id change, :1222 and :1236), the scheduler builds when a
   ramp moved (`frameScheduler.ts:416` skips `tryPatchAndPaint`), and reconcile builds. 92 of the 125 traced
   builds started within 11 ms of the previous one ending.
3. **Cosmetic offsets refuse retained patches.** `offset-pending` (`createPixiMirrorRenderer.ts:1266`,
   :1370) applies while a held-card lift or hand-raise ramp is moving. Wire deltas near captured nodes
   refuse with `wire-captured-global` (:1323): the held card, every offset id and every hand holder are
   captured (`interactionRuntime.ts:702-707`).
4. **The hand-raise pass rebuilds whole-scene indexes on every touch frame and every reconcile.**

**Touch is dearer than mouse.** The local "Raise held card" lift is touch-only
(`inputCapture.ts:1358-1364`; the mouse path never calls `onHeldCard`). Points 2–4 are therefore the touch
premium, about 12% of the trace. A mouse drag only receives host deltas.

The Oct 1 `rustFast` round (481/488 frames patched) was measured at 1920x1080 with no touch input and no
spread, so none of this was in its benchmark.

## 2. Success criteria

The user's standing preference (memory `user-renderer-playtest-preference`): **large, obvious wins in a
simple on/off test**, delivered as switches they can play-test. Keep tooling proportionate. A drop below 10%
relative renderer-main busy time is not worth shipping.

- Card drag/aim on the replay at the phone viewport:
  - full builds fall from ~23/s to a few per second;
  - per-build cost at designWidth 2520 is within ~10% of 1920;
  - retained patches carry the drag.
- Touch drag cost ends close to mouse drag cost.
- No regression:
  - `rustFastVerify=1` mismatch counters stay 0;
  - the touch harness H1–H17 is as green as on `main` (H11 is intermittently red on `main` too);
  - fixed-clock pixels and hits match.
- Visible to the user on their phone in a simple on/off comparison. Never claim a phone FPS gain that
  wasn't observed there.
- `replay-repro.mjs` renders a recording and its gestures reach `setHeldCard`.

## 3. Rules for this round

From `CLAUDE.md`/`AGENTS.md`, restated because each one has bitten a round before:

- **Builds and deploys.** Never `npm run build`; it deploys. The frontend gate is
  `cd frontend && npx vue-tsc --noEmit && npx vitest run`. Deploy for a live play-test only through
  `couch-deploy`, and only after asking the user.
- **Sibling repos.** Leave `../godot-scene-web` and `../spirectl` on clean `main`. To exercise a sibling
  branch, alias a sibling **worktree** through a scratch config (`couch-live-lock` skill). Only the optional
  WP6 touches GSW.
- **No polling** and no spirectl semantic actions. No visible game window. Never push or tag.
- **Switches.** Every behavior change is a switch in `renderer/pixi/rustFastFlags.ts`:
  - default-on once verified;
  - covered by `rustFast=0`, turned off individually with `<switch>=0`;
  - shadow-checked by `rustFastVerify=1` wherever it claims exactness.
- **Input-path QA.** Pointer-input or held-card changes need the `touch-input-qa` agent's H1–H17 run
  before landing (`docs/agents/touch-live-harness.md`). A live run takes the `couch-live-lock` leases.
- **Bookkeeping.**
  - After every attempt, accepted or not, add a ledger row to `renderer-optimization-ledger.md`.
  - Update or add a memory with the `project-memory` skill.
  - List image paths for every visual claim.

## 4. Team, models and worktrees

The coordinator is the main session on **Opus**. It owns this plan, creates worktrees, reviews and merges,
runs the final measurement, and talks to the user. Every implementer is a `round-implementer` subagent
launched with an explicit `model`.

| WP | Owner (model) | Main files |
| --- | --- | --- |
| WP0 repro replay | round-implementer (**Sonnet**) | `scripts/replay-repro.mjs`, `scripts/lib/replay-session.mjs`, new `scripts/test-replay-repro*.mjs` |
| WP1 spread-aware hidden memo | round-implementer (**Opus**) | `canvas/buildDrawList.ts`, `canvas/hiddenSubtreeMemo.ts`, `renderer/pixi/rustFastFlags.ts` |
| WP2 one build per frame | round-implementer (**Opus**) | `renderer/canvas/interactionRuntime.ts`, `renderer/canvas/frameScheduler.ts`, `renderer/pixi/createPixiMirrorRenderer.ts` |
| WP3 offsets as retained patch | round-implementer (**Opus**), after WP2 | same three files plus `renderer/pixi/retainedComposition.ts` |
| WP4 raise-index cache + small leftovers | round-implementer (**Sonnet**) | `raise/handRaisePlan.ts`, `canvas/handRaise.ts`, `fonts.ts` |
| WP5 allocation diet | round-implementer (**Sonnet**), after WP1–3 | `canvas/buildDrawList.ts`, `interactionRuntime.ts` `captureBuild`, `paint()` |
| WP6 (optional) binary command admission | round-implementer (**Opus**) | GSW `packages/canvas/src/rust-prototype-scene.ts`, crate `contract.rs` |
| Measurements | `mirror-bench` (**Sonnet**) | read-only, plus `.sts2/bench/` |
| Touch harness | `touch-input-qa` (**Sonnet**) | read-only |
| Diff review per WP | general-purpose reviewer (**Opus**) running the `code-review` skill on the WP branch | read-only |

Frontend paths above are relative to `frontend/src/mirror/`.

**Worktrees.** The coordinator creates one per WP with `scripts/create-worktree.sh cc-<wp>` (branch
`worktree/cc-<wp>`, cut from current local `main`) and passes the absolute path in the brief. Pass dependency
refs when a WP needs a specific Spirectl or Godot scene web revision. Do not rely on
the Agent tool's bare `isolation: "worktree"`: it skips the node_modules symlink, the scratch mods dir and
`install-agent-config.sh`. In addition:

- **Copy, do not symlink, the Rust Wasm.** Copy `.sts2/rust-prototype-web/` from the main checkout into each
  worktree that runs a browser. A symlink 403s and the stage silently falls back to DOM (memory
  `rust-wasm-worktree-dom-fallback`).
- **Gate every measured cell** on `rendererWindow.backend === "rust"`, or on `diag.backend === "rust"` in
  replay-repro output.

**Parallelism.**
- **Phase A, in parallel:** WP0, WP1, WP4. Their files are disjoint. WP4 must not touch `buildDrawList.ts`.
- **Phase B, sequential, one Opus agent in one worktree:** WP2, then WP3. They share three files.
- **Phase C:** WP5 rebased on the merged result. WP6 runs only if §6 says it is worth it.

**Briefs.** Each brief names the WP section below, its worktree path, its branch, its switch name, and what
to hand back:
- a diff on the branch;
- passing gate output;
- the evidence paths;
- a ≤15-line report.

## 5. Work packages

### WP0 — make `replay-repro.mjs` a working harness (Sonnet)

What is broken today, and the fix for each:

1. **The synthesized session is rejected.** It sends a bare `{"type":"session","directView":true}`
   (:251, :314-316). `browserEnvelope.ts:528-532` requires `hostName`, `scrollAction`, `screen` and
   `players`, and `mirrorClient.ts:766-788` swallows the failure, so the page sits on "Waiting for the
   game…". **Fix:** use `replaySession(rec.inbound)` from `scripts/lib/replay-session.mjs`, as
   `bench-mirror-replay.mjs:1143` does.
2. **Gestures arrive late.** On the GPU spectator run, input lag max was 5.9 s, 0 `input` envelopes were
   sent and only 5 `local` builds happened. Input capture *is* attached for a spectator
   (`MirrorView.vue:797-824` wires `onHeldCard` → `setHeldCard`, gated only by `raiseHeldCard`).
   - **Find why:** the serial `await dispatch(...)` loop behind a busy page, the touch point mapping, or the
     2.2 MB keyframe parse.
   - **Fix it.** The run must report input lag max < 100 ms at speed 1 on the desktop GPU.
   - **Assert gestures land.** The renderer-diagnostics `rustProducerReasons.bySource.local.count` (or the
     interaction runtime's `offsetBuilds`) must be > 0 on the card-target repro.
3. **New flags:**
   - `--gpu vulkan`, passing `--use-angle=vulkan` (SwiftShader drops the tier to very-low and stalls the
     clock).
   - `--diag-out <file>`, dumping `window.__mirrorRendererDiagnostics()` at the end, plus CDP
     `Performance.getMetrics` `TaskDuration`/`ScriptDuration` deltas over an optional `--window a:b`
     (ms on the recording clock).
   - Pass extra page queries through `--url` as today.
4. **Seat mode (`--as-seat`).** A joined seat waits for this sequence:
   1. the reply to `join` must be a valid session envelope with `headlessMirrorPort` and directView not true
      (`mirrorClient.ts:789-796`);
   2. `onHeadlessRedirect` (`MirrorApp.vue:741-783`) then opens a **second** WebSocket to that port
      (:593-610, :1252-1273);
   3. `showScene` needs a `full:true` keyframe on it (:977-979).

   Teach the fake socket to:
   - answer `join` that way;
   - serve the recorded frames on the seat socket and keep the host socket quiet;
   - fetch the frames once, with one shared `__reproGo` (today every `/ws` refetches and overwrites it,
     :218-223, :254-258).

   On the recorder side, tag inbound lines by socket so future seat recordings separate the two streams;
   the recorded `kind:"ws"` lines exist but the loader ignores them. **Done** when the card-target repro's
   replayed `input` count is near its recorded 372.
5. **Docs and tests.**
   - Document the offline dev-server recipe in `docs/agents/repro-recorder.md` (`node scripts/serve-res-root.mjs
     --port P --asset-cache-root ~/.local/share/SlayTheSpire2/couch-coop/cache/<branch>/assets` plus
     `COUCHCOOP_DEV_PROXY_TARGET=http://127.0.0.1:P npm run dev -- --port Q`).
   - Add node tests for session synthesis and seat-mode routing. Nothing tests the fake socket today;
     `scripts/test-repro-recording.mjs` checks headers only.
   - Update memory `replay-repro-session-and-seat-gaps`.

WP0 is tooling. Spend effort on correctness, not dashboards.

### WP1 — hidden-subtree memo under spread (Opus) — switch `rustHiddenMemoSpread`

**Why the memo is inexact under spread:**
- **Spread runs on hidden nodes too** (`buildDrawList.ts:1611-1672`). It writes
  `spreadDxOut.set(id,dx)`/`spreadFieldModeOut.set(id,fieldMode)` (:1665-1671), which the recording does
  not carry (`hiddenSubtreeMemo.ts:108-124`). Readers of those maps:
  - `visualState.ts:316-321` (next build's `ownerDx`)
  - `retainedComposition.ts:412`
  - `captureBuild` (`interactionRuntime.ts:650-651`)
  - eager-scroll `spreadDxOf`
- **The incoming 9-field `SpreadCtx`** (:1178-1207) is not in `packContext` (`hiddenSubtreeMemo.ts:503-529`),
  and `env` lacks `spreadFactor`/`viewScaleDesignW` (:1229).
- **Two reads leave the subtree:** `env.ownerDx` (`spreadLayout.ts:472`) and `remoteFollowerDx` (:486).

**Do this:**
- Add `spreadFactor` (and the spread registry identity) to the env key.
- Pack the SpreadCtx scalars and `containerChildAlign`'s null flag.
- Record `(id, dx, fieldMode)` in walk order and replay them into the out maps.
- Refuse a recording that consulted `ownerDx`/`remoteFollowerDx`, or record their answers and re-check
  them.
- Extend `sameRecording` (:545-560).
- Lift `!spreading` behind the switch.
- Fix the stale "default off" header comment; `rustHiddenMemo` is in the default-on umbrella.

**Facts that help:**
- `spreadFactor` is constant per viewport and stretch setting: designWidth is
  `clamp(round(w/h·1080),1920,2520)`, `MirrorView.vue:242-252`, so the phone's F is 1.3125.
- `setStretch` clears the dx map (`visualState.ts:1092-1096`).

**Verify:**
- `rustFastVerify=1` makes `hiddenSubtreeMemoVerify` walk validated roots and compare
  (`hiddenSubtreeMemo.ts:420-425`, :462-464; counter at `createPixiMirrorRenderer.ts:1785`).
- Extend `__tests__/canvasHiddenSubtreeMemo.spec.ts` and `rustFastParity.spec.ts` with spread cases.
- On the WP0 replay at the phone viewport, verify mismatches must be 0, and `rustHiddenWalk=1` must show
  about 1 hidden node walked per build instead of 2,928. (That diagnostic itself disables the memo, so use it
  only on the OFF arm or as a separate run.)

**Done when:** total build ms with stretch on is within ~10% of the `?stretch=off` arm on the same replay
(today 1,210 vs 621).

### WP2 — one build per frame, nothing lost (Opus) — switch `rustCoalescedBuilds`

- Replace the synchronous `ports.rebuildAndPaint()` calls with one per-frame build request. Calls to replace:
  - `setHeldCard` (`interactionRuntime.ts:1219-1238`), including its double build on an id change;
  - `setRaiseHandCards`, `setHandRaiseChrome`, `setStretch`, and any other `paint(state,"local")` caller
    (`createPixiMirrorRenderer.ts:474`).
- **Lane order is not fixed.** rAF lanes run in booking order: `flushHover`, `animationRaf`/`textureRaf`,
  `offsetFrameRaf`, `refinementRaf`. So a naive "mark dirty" can add a frame of latency when `flushHover`
  runs after the scheduler's tick.
- **The rule:** at most one full build or patch per frame. If the frame's tick already ran, the late
  request builds immediately but becomes that frame's only build; otherwise the tick does it. **The first
  lift must not present later than today.**
- `applyLocalOffset`/`armOffsetFrame` (:1157-1184) is the closest existing model. `armAnimation` cannot
  carry it, because frames with no demand are skipped (`frameScheduler.ts:389-394`); add a "dirty" demand
  source.
- **Fix the lost-build bug.** `paint()` returns `full-build-deferred-in-flight` while
  `asyncSubmissionRevision !== null` (:842-846) and records nothing. Keep a dirty bit and re-request on
  completion (:1010-1045).
- **Keep these working:**
  - `raiseInputStamps` (`interactionRuntime.ts:732-760`) and `invalidateSnapshotInputCaches` (:423-431);
  - the scene ack and first-presented report on "presented" (`MirrorView.vue` ~520-540, 126-139);
  - the `frameLifecycle` and `producerReasons` source tags;
  - the `offsetBuilds`/`offsetCoalesced` counters.
- **Gate:** specs for the scheduler and the interaction runtime, then **touch harness H1–H17**
  (`touch-input-qa`).
- **Done when:** the WP0 replay shows ≤1 build-or-patch per frame (the producer-reason ledger per
  `buildEpoch`) and no H-matrix latency regression.

### WP3 — cosmetic offsets as a retained translate patch (Opus, after WP2) — switch `rustOffsetPatch`

- Today `tryRetainedWire`/`planRetainedSample` refuse `offset-pending`, and the scheduler bypasses patching
  when `rampMoved`.
- Add a retained "translate these subtrees by (dx,dy)" patch for cosmetic-offset changes (held-card lift,
  hand-raise ramps, creature-HUD ramps).
- **What it must do:**
  - translate primitives, text records, hit `mFinal` and `nodeMatrices` in each span, **never `mGame`**
    (`patchWireTransform`, `retainedComposition.ts:364-388`, sets `mGame`, which would be wrong here);
  - compute the offset as the build does: `ownDx/ownDy = parentFinal.linear·offset`, scaled by `kIn`
    (`buildDrawList.ts:1704-1709`);
  - update `capturedGlobals[id].drawn` (read by landing, `visualState.ts:387`, :628);
  - publish new FrameData with the current offsets and a copied raise plan (`publishPatch`,
    `interactionRuntime.ts:681-700`).
- **What it must refuse:**
  - spans that contain a `clipPush`;
  - spans with view-scale stamps or candidates;
  - spans with local-anim roots or landings.
- Then let the scheduler try the patch when `rampMoved` instead of skipping it.
- **Second step:** relax `wire-captured-global` (:1323) for transform-only wire changes whose captured
  entries the patch can recompute.
- **Model to copy:** `rustHeldOverridePatch`: the equality gate (:1357-1359), the committed bank (:346,
  :927, :1112), and the shadow verify `verifyHeldOverridePatch` (:1495-1604, matrices at 1e-5).
- **Gate:** verify 0 on the WP0 replay, plus touch harness H1–H17.
- **Done when:** `offset-pending` and ramp-forced builds during the replay's drag/aim window are near zero
  and are replaced by patches.

### WP4 — raise-index cache and small leftovers (Sonnet) — switch `rustRaiseIndexCache`

- **Cache per `(state object, revision)`.** `applySceneDelta` mutates state in place and bumps `revision`
  on every delta (`sceneTree.ts:801`, :871), so that key is exact. Cache:
  - `scanRaiseIndex` (`raise/handRaisePlan.ts:412-447`, reads only the node map);
  - `createChildIndex` (:463-478, reads `orderedIds`/parentIds).

  Precedent: `targetingArrowVisible` (`interactionRuntime.ts:433-442`). `planHandRaise` (:289) and the
  `holderLocalY` closure (`canvas/handRaise.ts:88-111`) read held id, mode and the tween clock, so they must
  keep running every call. Verify under `rustFastVerify=1` by comparing against an uncached scan.
- **`fonts.ts:32`** re-reads `window.location.search` per font check (22 ms in the trace). Read it once.
- **Vue reactivity in the build path.** The trace shows the reactive proxy `get` (29 ms) on the build path:
  for example `fz` reads `mirrorSettings.spineMode` per node. Snapshot plain settings once per build.

### WP5 — allocation diet (Sonnet, after WP1–3 merge) — switch `rustAllocDiet`

The heap saw-tooth is promoted per-build churn. Each fix must be exact by construction:
- Use `affineMulInto` for the two per-node `affineMul`s in `buildDrawList` (:1571, :1595) and for
  `gSpread`/`gFinal` scratch.
- Stop copying `spreadDxByNode`/`spreadFieldModeByNode` in `captureBuild` (`interactionRuntime.ts:644-660`):
  share an immutable per-build map instead.
- Avoid `new Map(next.nodes)` per revision where `snapshotReuse` cannot apply
  (`createPixiMirrorRenderer.ts:957`).
- Pool the per-build Maps/Sets in `buildDrawList` (:1106-1363).

**Measure** with the WP0 replay: CDP heap-used slope and GC time, ON vs OFF. WP5 only matters if builds
still happen often after WP1–3.

### WP6 — optional: typed binary command admission (Opus, GSW)

Only if, after WP1–5, serde JSON admit/apply (`serde_json::de::*` under `admit_scene`/`apply_patch`) is still
>3% of busy main thread on the replay.
- **Where:** GSW worktree; alias it through a scratch Vite config.
- **Order:** GSW lands first.
- **Note:** the Sep 27 typed `patch/1` prototype has a fidelity MFAIL in the ledger; read that row first.

## 6. Measurement (mirror-bench, Sonnet; keep it light)

**Harness:**
- the fixed `replay-repro.mjs` (WP0) on the card-target repro;
- `--gpu vulkan`, the recorded phone viewport, `?stage=canvas&rustProducerReasons=1`;
- an offline asset server and dev server on private loopback ports (not 5219/5220);
- desktop benchmark lease via `scripts/live-qa-lock.mjs`.

**Report per cell:**
- builds by source and decline;
- total build ms;
- retained patches;
- CDP `TaskDuration` over the aim window (≈9–14 s on the recording clock);
- heap slope;
- verify counters.

**Cells:** run ABAB for the bundle: all new switches on vs `rustHiddenMemoSpread=0&rustCoalescedBuilds=0&rustOffsetPatch=0&rustRaiseIndexCache=0&rustAllocDiet=0`.
Add a stretch-off cell for context. Per-WP leave-one-out runs only if a reviewer asks. This is a quick
on/off, not a formal CPU/output campaign. `bench-rust-ab.mjs` cannot replay gestures, so use it only for
non-touch busy-combat regression (`--extra-bench-args "--viewport 739x281 --dpr 3.49"`).

**Phone:**
- Hand the user switch URLs to compare (`?rustCoalescedBuilds=0` etc.) and ask whether they want a local
  deploy.
- If a trace is wanted, follow their rule: settle 10 s, record ~2 s, phone leg ≤45 s, phone parked
  otherwise.
- A live drag needs a joined game, so the user drives it. Never script blind input against the live
  game.

## 7. Integration

**Per WP:**
1. The implementer commits on its branch.
2. The Opus reviewer runs `code-review` on the branch.
3. The implementer fixes the findings.
4. The coordinator runs the frontend gate (plus the script tests for WP0).
5. Merge into `round/interactive-rebuild` in WP order.

**Final:**
- Touch harness H1–H17 on the round branch, the ABAB above, user play-test.
- Squash to `main`, **one commit per coherent change**. Suggested split:
  - `fix(scripts): …` for WP0, with `Changelog: none`;
  - `perf(mirror): …` for WP1–WP5, with a player-facing `Changelog:` trailer such as "Dragging and aiming
    cards on wide phones is much smoother."
- Message format is in [../commit-and-release.md](../commit-and-release.md).

**Close-out:**
- Ledger rows for every WP attempt (ON/OFF/REJ/MFAIL).
- Update `rust-interactive-spread-build-cost-oct2`.
- Remove the worktrees.
- Never push or tag.

## 8. Copy/paste prompt for the coordinator

> Run the round in `docs/agents/handoff-interactive-rebuild-cost.md` as its Opus coordinator.
>
> 1. Read §1–§3 and the two memories they name.
> 2. Create a `couch-worktree` per WP, copying `.sts2/rust-prototype-web/` into each one that runs a
>    browser.
> 3. Phase A: launch WP0 (Sonnet), WP1 (Opus) and WP4 (Sonnet) as parallel `round-implementer` subagents,
>    each told its worktree path, branch, switch name and section.
> 4. When Phase A merges, run WP2 then WP3 with one Opus implementer, then WP5 (Sonnet).
>
> Rules for every WP:
> - Review each branch with an Opus `code-review` pass before merging.
> - Run `touch-input-qa` (H1–H17) after WP2 and WP3.
> - Measure only with the fixed `replay-repro.mjs` at the phone viewport (`mirror-bench`, Sonnet), as a
>   quick ABAB on/off.
> - Add a ledger row per attempt.
> - Never `npm run build`, push or tag; leave the siblings on clean `main`.
>
> Finish by giving the user switch URLs for a phone on/off play-test and the squash commits ready on `main`.
