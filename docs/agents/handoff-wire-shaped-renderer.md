# A renderer shaped by the wire — handoff

For a Claude Code coordinator (Opus) that runs the round with Opus and Sonnet subagents, each in its own worktree.

The goal is a Rust stage whose phone cost follows what the mod server actually sends:
- a frame exists only when pixels change;
- motion the server describes as a function of time is evaluated inside the renderer;
- a patch reaches WebGL by the shortest path the browser allows.

Today the DOM stage reaches 90 fps on the Moto g86 for about the same CPU the Rust stage spends on 30.

Base: couch `main` 3f2a2072, godot-scene-web (GSW) `main` d35185cb, spirectl `main` d737e3c1. Line numbers are at
those commits.

## 1. What is already known (do not re-measure)

**The stage is already retained and damage-limited.** On the default path (`rustFast` on, `rustPresent` =
`preserved-desync`):
- one instance buffer, of which only changed spans are uploaded;
- a damage plan of at most 4 rects, redrawn scissored into a kept picture (`renderer.rs:174-283`, `:2361-2422`);
- a scissored present;
- idle loops evaluated in Rust (`present_idle`, `idle.rs`).

An idle frame redraws about 33k px and about 7 draws. Pixels are not the cost: `rustPresent=preserved` wrote 98.6%
fewer pixels with no CPU change (ledger, Oct 3).

**Per-frame floor on the phone** (ledger rows Oct 4; `.sts2/bench/webgl-floor-oct4/`, `.sts2/bench/webgpu-floor-oct4/`;
memory `phone-webgl-frame-floor-oct4`). Moto g86, Chrome Stable 154, panel pinned 90 Hz, ABBA. Times are ms per
presented frame:

| Cell | fps | Renderer | GPU process |
| --- | ---: | ---: | ---: |
| Raw WebGL2, `preserveDrawingBuffer` + `desynchronized`, 1 quad | 90 | 3.55 | 6.19 |
| CSS keyframes, one element | 90 | 1.66 | 6.75 |
| DOM stage, quiet idle combat | 90 | 3.09 | 7.12 |
| GSW engine (wgpu → WebGL2), the same 1-quad scene | 90 | 6.19 | 8.27 |
| Rust stage, quiet idle combat, display-paced (`cmpIdle=display`) | 90 | 7.26 | 9.50 |
| Rust stage, quiet idle combat, authored 30 fps cadence | 29.4 | 15.06 | 16.59 |
| Raw WebGPU (Dawn on Vulkan), 1 quad | 90 | 5.81 | 15.03 |
| GSW engine on WebGPU (scratch build), 1 quad | 90 | 7.98 | 15.72 |

What the table says:
- **The display-paced Rust frame splits as follows:**
  - Chrome's floor: 49% renderer / 65% GPU process;
  - **the GSW engine path: 36% / 22%** (b − a = +2.6 ms renderer, mostly main thread JS + Wasm + wgpu; +2.1 ms
    `CrGpuMain`, a longer GL stream);
  - the real scene: 15% / 13%.
- **The 30 fps per-frame figure is inflated.** The little cores clock down to ~800 MHz, and part of the cost is per
  second. Per second, Rust at 30 fps (933 ms/s) equals DOM at 90 fps (919 ms/s).
- **WebGPU is rejected for phones.**
  - Chrome composites with GL on this phone (`Vulkan: Disabled`, GaneshGL over ANGLE), so each WebGPU frame crosses
    from Vulkan to GL.
  - WebGL2 `desynchronized` gets its own SurfaceFlinger layer, outside the page compositor.
  - Forcing Vulkan with flags fails: Graphite reports "Validate adapter failed". Players won't flip flags anyway.
- **Main thread busy:** raw WebGL2 11%, GSW 1-quad 29%, Rust idle 27%, DOM idle 1%.

**The wire sets the idle frame count, and the frames it adds are invisible.** In the as-recorded idle combat
(`.sts2/bench/bitmap-phase1-oct02/static-combat-a.repro.ndjson`):
- 737 of 738 deltas move one node, `…/Creature/Ironclad/Visuals/EyeSlot` (a spine bone follower, `Node2D`).
- Its only child, `EyeFire`, is `visible: false` in the keyframe and never changes.
- The Rust stage still turns each delta into a retained wire patch (`tryRetainedWire`,
  `createPixiMirrorRenderer.ts:1601`; 34.7 patches/s, 0 builds), a Wasm submit and a present. That takes presented
  frames from 29 to 54 per second and adds ~240 ms/s renderer and ~110 ms/s GPU process.
- DOM spends ~49 update walks/s on it.

**What the server sends** (`architecture-map.md`, `sceneTree.ts:510-534`):
- `scene-delta` JSON, ack-gated (one in flight; `mirrorClient.ts:529`): changed nodes only, with local transforms.
- Tween hints (target, from/to transform and opacity, `durationMs`, Godot trans/ease).
- Card-flight descriptors (bezier, speed, acceleration; the client steps the game's integrator).
- Idle loops folded out of the stream (path table or `pinnedLoopAnim`).

On the canvas stage, tweens and flights are evaluated in JS every frame (`canvas/tweenLoop.ts:597`,
`canvas/tweenPlan.ts:185`) and sent to Rust as retained patches. Only idle loops run in Rust, and alpha loops
(`glowPulse`, `pulseScaleFade` alpha) still take the patch path (`rustIdleDescriptor.ts:53`).

**Where wgpu lives in the crate.** It sits in `renderer.rs` (2,778 lines, 169 `wgpu::` references) and `present.rs`.
`contract.rs`, `geometry.rs`, `damage.rs`, `idle.rs` and `resources.rs` (~3,300 lines) have no wgpu dependency.
`glow` 0.17 is already in `Cargo.lock` (wgpu-hal's GLES backend uses it). The shader is 84 lines of WGSL. Each
present opens and pops a validation error scope (`renderer.rs:1932`).

## 2. Target design

1. **Present only visible change.** A delta, tween step or loop tick that changes no drawn instance does not
   schedule a frame or reach Wasm. Its state still applies and its ack still goes back.
2. **Evaluate server-described motion in Rust.** Tween hints, card flights and alpha loops join the idle-loop
   descriptor set. A frame with only time-driven motion is one synchronous Wasm call, like `present_idle` today.
3. **Shortest path to GL.** Keep the scene model, geometry, damage plan and resources. Replace the wgpu device,
   queue and encoder with direct WebGL2 calls through `glow`, issuing only the state changes a frame needs. That
   removes wgpu-core validation and tracking, and wgpu-hal's per-pass state resets.
4. **Stay on WebGL2 `preserved-desync`.** Only the new direct-GL backend is in scope, not WebGPU.
5. **No authored cadence cap.** Idle animation runs at display rate, like DOM's compositor animations. The 30 fps
   idle cap (`CANVAS_IDLE_ANIMATION_FPS`) goes in phase A (WP7). The user's decision on Oct 4: it should never have
   existed.

Out of scope this round:
- rendering in a worker with `OffscreenCanvas` (only its floor is measured, in WP3);
- producer-side suppression of invisible streams (spirectl's scene watcher; needs the maintainer's go-ahead, see §8).

## 3. Success criteria

Phone figures: Moto g86, Chrome Stable at default flags, panel pinned 90 Hz, ABBA, with the Oct 4 harness. Idle
figures are display-paced: once WP7 lands that is simply the product, with no `cmpIdle` needed.

| Measure | Now | Target |
| --- | --- | --- |
| Quiet idle combat, display-paced, ms/frame (renderer / GPU process) | 7.26 / 9.50 | **≤ 4.5 / ≤ 7.5** |
| Same, CPU per second vs DOM at 90 fps | +64% | **≤ +15%** |
| As-recorded idle combat: presented frames/s caused by the `EyeSlot` stream | 34.7 | **0** |
| As-recorded idle combat: CPU per second | +38% vs quiet (1,286 vs 933 ms/s) | **equal to quiet, within noise** |
| GSW engine, 1-quad scene, ms/frame | 6.19 / 8.27 | **≤ 4.3 / ≤ 6.9** (within ~0.7 ms of raw WebGL2) |
| Busy combat (card play, flights) | not measured since `rustFast` | set from WP3's baseline; aim for ≥ 60 fps |

The user's standing preference (memory `user-renderer-playtest-preference`): **large, obvious wins in a simple on/off
test**, delivered as switches. A change below 10% of renderer or GPU-process CPU isn't worth shipping alone.

**No regression:**
- `rustFastVerify=1` mismatch counters stay 0;
- pixel parity holds: `test-web-pixels.mjs` and `test-integration-browser.mjs` in every present mode, plus fixed-clock
  screenshots for any backend change;
- the touch harness is as green as `main` (H11 is intermittent there);
- no extra presented frames.

## 4. Rules for this round

The rules of [handoff-idle-combat-frame-cost.md](handoff-idle-combat-frame-cost.md) §3 apply unchanged: builds and
deploys, sibling repos and GSW worktrees, `COUCHCOOP_GSW_ROOT`, switches in `rustFastFlags.ts`, input-path QA, and
bookkeeping. Read them. In short:
- never `npm run build`, push or tag;
- leave `../godot-scene-web` and `../spirectl` on clean `main`;
- GSW lands first, as squash commits;
- no polling and no spirectl semantic actions;
- add a ledger row per attempt.

Added for this round:
- **Don't ask the user anything.** The user wants this round to run without questions. Proceed without asking on:
  - phone sessions (with the lease, preflight and restore below);
  - deploys through `couch-deploy`;
  - merges and squash commits to `main`.

  Where any rule says "ask the user", including the deploy rule in the idle-combat handoff's §3, decide yourself and
  report the decision at the end. The only hard stops are the go-aheads `CLAUDE.md` reserves for the maintainer:
  spirectl semantic actions, new polling, and a visible game window on the desktop. This round needs none of them,
  so route around them rather than asking.
- **Phone preflight.** The user flipped `#use-angle=vulkan`, `SkiaGraphite` and `Vulkan` in Chrome Stable on Oct 4.
  Before any phone cell, read `chrome://gpu`: it must show `Display type: ANGLE_OPENGLES` and no `--use-angle` on the
  command line. If not, reset the flags yourself:
  1. open `chrome://flags` over CDP and use "Reset all";
  2. relaunch Chrome (`adb shell am force-stop com.android.chrome`, then reopen);
  3. read `chrome://gpu` again.

  If it still isn't at default, record that session's phone cells as MFAIL and continue on desktop numbers.
  - Reuse the lease, panel-pin, rotation and restore steps in `.sts2/bench/webgl-floor-oct4/harness/`
    (`device-original.txt`, `floor-cell.sh`, `snooze.cjs`).
  - Restore the phone after every session.
- **One phone session per phase.** Batch every phone cell of a phase into one `mirror-bench` run, to keep the phone
  free as much as possible.
- **Exactness first.** A skipped frame must be provably pixel-identical to presenting it. Treat a changed resource or
  key with unchanged geometry as a change (memory `idle-combat-round-oct3`).
- **Merge-tree integration.** WP5 and WP6 both touch `renderer.rs`. Before landing either, merge them in a scratch GSW
  worktree and run every integration mode there. Two WPs that each pass alone have composed into a stale-picture bug
  before.

## 5. Team, models and worktrees

The coordinator is the main session on **Opus**. It owns this plan, creates the worktrees, reviews and merges, and
reports to the user at the end. Implementers are `round-implementer` with an explicit `model`. Each branch gets an Opus
`general-purpose` reviewer running `code-review` at level high. Measurements go to `mirror-bench` on **Sonnet**.

| WP | Owner (model) | Repo / main files | Switch |
| --- | --- | --- | --- |
| WP1 undrawn-wire skip | round-implementer (**Sonnet**) | couch `createPixiMirrorRenderer.ts` (`tryRetainedWire`, reconcile :3064), `frameScheduler.ts` | `rustSkipUndrawnWire` |
| WP2 GL census + main-thread split | `mirror-bench` (**Sonnet**) | read-only; scratch pages under `.sts2/bench/wire-renderer/` | — |
| WP3 phone baselines (busy + worker floor) | `mirror-bench` (**Sonnet**) | read-only | — |
| WP4 direct-GL spike | round-implementer (**Opus**) | GSW worktree, new `src/gl/` module beside `renderer.rs` | none (spike) |
| WP5 direct-GL backend | round-implementer (**Opus**) | GSW `renderer.rs`, `present.rs`, `wasm.rs`, shader; couch executor wiring | `rustGlBackend` |
| WP6 server motion in Rust | round-implementer (**Opus**) | GSW `idle.rs` + descriptor; couch `rustIdleLane.ts`, `rustIdleDescriptor.ts`, `visualState.ts` tween/flight hand-off | `rustMotionInRust` |
| WP7 remove the 30 fps idle cap | round-implementer (**Sonnet**) | couch `frameRuntime.ts:26`, `visualState.ts`, `createPixiMirrorRenderer.ts`, `frameAssembly.ts`, `diagnostics.ts`, `rendererComparison.ts` | none (removal) |
| Touch harness | `touch-input-qa` (**Sonnet**) | read-only | — |

**Worktrees:**
- **Couch:** use the `couch-worktree` skill (`cc-wire-<wp>` on `round/wire-<wp>`, cut from local `main`).
  - Copy, don't symlink, `.sts2/rust-prototype-web/`.
  - Export `COUCHCOOP_GAME_MODS_DIR=/tmp/cc-mods-wire-<wp>` before any build.
- **GSW:** `gsw-wire-<wp>` on `round/wire-<wp>`, via `git -C ../godot-scene-web worktree add`, then `mise trust` and
  an offline `pnpm install`.
- Pass absolute paths in every brief. Don't rely on the Agent tool's bare `isolation: "worktree"`.

**Phases:**
- **A, in parallel:** WP7, WP1, WP2, WP3, WP4.
  - WP7 is small and lands first.
  - WP1 rebases onto it before review (both touch the scheduler and reconcile path).
  - WP3 owns the phase's only phone session and measures with WP7 in place where it has landed.
- **B:** WP5 if WP4 passes its gate; WP6 in parallel. WP6's GSW part touches `idle.rs` and `present_idle`, and WP5
  replaces the GPU layer under it, so cut WP6's GSW worktree after WP5's backend seam commit (WP5 step 1).
- **C:** one phone session measuring the whole round.

**Briefs** name the WP section, worktree path, branch and switch. Each asks for:
- a diff on the branch;
- passing gate output;
- evidence paths;
- a report of at most 15 lines.

## 6. Work packages

### WP1 — skip wire deltas that draw nothing (Sonnet) — switch `rustSkipUndrawnWire`

- **Goal:** a delta whose changed nodes all lie in subtrees the committed build drew nothing for is applied to
  `MirrorState` and acked, but schedules no frame, sends no patch and calls no present.
- **"Drew nothing" comes from the committed build,** never re-derived: an empty paint-order span, no hit entries, and
  no captured follower pose depending on the node. The hidden-subtree memo (`rustHiddenMemo*`) and
  `snapshot.paintOrder` are the sources.
- **Mark the state dirty for the skipped nodes,** so the next build or patch that makes them visible poses them
  correctly. The test: `EyeFire` turning visible mid-stream must draw at the latest `EyeSlot` transform.
- **Shadow-check under `rustFastVerify=1`:** present the skipped frame anyway and compare instance bytes. The
  counter must stay 0.
- **Expected result:** as-recorded idle combat drops from ~54 to ~29 presented frames/s, with CPU per second equal to
  the quiet recording.
- **Gate:**
  - frontend gate;
  - replay `static-combat-a.repro.ndjson` with `rustProducerReasons=1`: wire patches about 0, builds 0;
  - narrowed touch harness (it touches the reconcile and scheduler path).
- Also report how DOM handles the same deltas (49 walks/s). A DOM-side skip is a separate, optional follow-up.

### WP2 — GL call census and main-thread split (Sonnet, read-only)

This decides WP4's and WP5's scope. Desktop headless Chromium is fine: call counts don't depend on the device.

- **Wrap `WebGL2RenderingContext.prototype`** in a scratch page to count calls per frame by name. Flag redundant
  state calls (same value set twice, binds re-issued, `invalidateFramebuffer`, viewport/scissor resets) and buffer
  uploads.
- **Cells:**
  - raw WebGL2 1-quad (the Oct 4 page);
  - GSW 1-quad (Oct 4 cell b);
  - the Rust stage on the quiet replay: an idle frame (`present_idle`) and a wire-patch frame.
- **Main-thread split per frame** with `performance.now()` brackets, not DevTools traces (memory
  `devtools-trace-inflates-scheduler-calls`): JS glue, Wasm `apply_patch`/`present_idle`, wgpu encode/submit, and
  time spent inside GL calls. Use sample counts if you profile; CDP ms are unreliable on this desktop (memory
  `rust-desktop-cdp-profile-invalid-sep28`).
- **Deliverable:** a table of GL calls per frame (raw vs GSW vs stage) and a ms split, plus a list of the calls a
  direct-GL frame would still need.

### WP3 — phone baselines: busy combat and the worker floor (Sonnet, one phone session)

One session with the §4 preflight:
1. **Busy baseline.** Rust vs DOM on a busy combat recording (card plays, flights, targeting), during-replay windows,
   at 90 Hz. Record ms/frame, ms/s, presented fps, and frames by cause (wire patch, tween, flight, idle, build).
   - Use the Oct 2 card-target recording named in [handoff-interactive-rebuild-cost.md](handoff-interactive-rebuild-cost.md)
     §1 (repro/1, card pick-up, aim and play). Copy it under `.sts2/bench/wire-renderer/` and work from the copy.
2. **Worker floor.** Raw WebGL2 1-quad rendered from a dedicated worker via `transferControlToOffscreen()` with
   `desynchronized` + `preserveDrawingBuffer`, against the main-thread page. This is a measurement only. It tells
   us whether a worker architecture could cut the renderer-process floor (3.55 ms/frame today) enough to plan it
   next round.

### WP4 — direct-WebGL2 spike (Opus, GSW worktree)

- **Question:** how much of the GSW engine's +2.6 / +2.1 ms over raw WebGL2 does a direct `glow` path remove?
- **Build a spike engine variant** (`createWithGl(canvas)` in the scratch branch) with the minimal scene of Oct 4
  cell b: background quad + 1 moving quad, kept picture, scissored damage redraw, scissored present on a
  `preserved-desync` context.
  - Reuse `geometry.rs` and `damage.rs` as they are.
  - Picture as an `SRGB8_ALPHA8` texture; the present shader encodes, matching wgpu-hal's sRGB pass.
  - Port the shader to GLSL ES 3.00 by hand or with naga's GLSL backend at build time.
  - Issue only the state a frame changes; no error scopes.
- **Measure on the phone,** batched into WP3's session if ready, otherwise its own session: spike vs cell b vs raw
  WebGL2, at least 4 ABBA reps.
- **Gate (GO for WP5):**
  - at least **1.5 ms/frame lower renderer and 1.0 ms/frame lower GPU process** than cell b;
  - pixel parity with cell b on a layered-alpha test (not a flat colour, per the `gsw-wgpu-renderer` skill).
- **Deliverable:** the diff stays on the branch (not landed), plus numbers, the parity image paths, and an estimate
  for WP5.

### WP5 — direct-GL backend behind a switch (Opus, GSW + couch) — switch `rustGlBackend`

Run only if WP4 passed its gate.
1. **Backend seam.** A trait over what `renderer.rs` asks of the GPU:
   - buffers and textures;
   - the picture pass (full or damage rects);
   - draws per batch;
   - present (direct, preserved, preserved-desync);
   - resource upload and release.

   The existing wgpu code becomes one implementation with no behaviour change. Land this commit first: WP6 cuts
   from it.
2. **The `glow` implementation:**
   - feature-gated;
   - created through a new `createWithGl(canvas, mode)` that couch probes as a capability (precedent:
     `translatesClips`, `createRustDrawListExecutor.ts:97-104`);
   - the wgpu path stays the fallback.
3. **Handle device and context loss** as distinct from a refused present (skill rule). A failed staged operation
   keeps the last accepted picture.
4. **Gates:**
   - `cargo test`;
   - `scripts/build-web.sh`, then `test-web-pixels.mjs` and `test-integration-browser.mjs` in every present mode and
     with `GSW_RUST_DAMAGE_PRESENT=1`, under both backends;
   - couch frontend gate;
   - fixed-clock screenshot pairs (wgpu vs gl) for combat, map, reward and shop;
   - `rustFastVerify=1`;
   - the narrowed touch harness.

### WP6 — server-described motion in Rust (Opus, GSW + couch) — switch `rustMotionInRust`

- **Goal:** tween hints, card flights and alpha loops become descriptors installed per revision, evaluated in Rust
  like idle loops. A frame whose only changes are time-driven is one synchronous call; JS stops lerping matrices and
  encoding patches for them.
- **Exactness, as in `rustIdleInRust`:**
  - Rust replays the JS f64 op order, and takes `cos`/`sin` (and any `pow`/`exp` the Godot easing uses) from the
    page's `Math` via js_sys;
  - poses match `tweenLoop`/`easedProgress`/the flight integrator bit for bit;
  - a vitest parity spec on the model of `rustIdleParity.spec.ts`;
  - live `rustFastVerify` at 0.

  See memory `rust-idle-in-rust-oct3` for the traps: `sync()` before planning; JSON loses −0.
- **Handover rules:** the descriptor owns a node only while its hint runs. A wire delta or local override on that
  node ends the Rust-side animation in the same frame. A settled tween releases (memory
  `settled-override-idle-rebuild-oct3`).
- **Order of work:** alpha loops first (smallest), then tween hints, then card flights.
- **Gates:**
  - WP3's busy recording replayed through `bench-rust-ab.mjs` (desktop, phone viewport), before and after;
  - the touch harness in full: drag and aim touch the tween path.

### WP7 — remove the 30 fps idle cap (Sonnet, phase A, lands first) — no switch

- **Goal:** delete `CANVAS_IDLE_ANIMATION_FPS` (`renderer/canvas/frameRuntime.ts:26`) and the deadline pacing built on
  it, so idle loops are sampled every display frame on every canvas backend (Rust, Pixi, TS canvas). Find every use
  with `grep -rn 'CANVAS_IDLE_ANIMATION_FPS\|idleCadence\|cmpIdle' frontend/src scripts`. Today that is
  `frameRuntime.ts`, `frameAssembly.ts`, `diagnostics.ts`, `visualState.ts`, `createPixiMirrorRenderer.ts`, and
  `rendererComparison.ts` plus `RendererComparisonPanel.vue`.
- **Drop the `idleCadence` comparison field and the `cmpIdle` parameter,** since only one cadence remains. Bench
  scripts or configs that still pass `cmpIdle=display` must keep working (the parameter is then ignored). Update any
  doc that tells a bench to set it.
- **No switch.** This is the user's explicit decision and is exempt from the §4 switch rule.
- **Keep the frame-count guarantees:**
  - no rAF is booked while no idle loop is installed and visible;
  - an idle-only frame stays one `present_idle` call (`rustIdleScheduler`, `rustIdleDueFrame`);
  - a hidden tab or a screen without loops presents nothing.
- **Gates:**
  - frontend gate (update `canvasFrameSchedulerIdle.spec.ts` and the comparison specs);
  - a desktop replay showing idle presents at display rate with loops visible, and 0 per second on a static screen;
  - narrowed touch harness (scheduler path).
- **Commit** as `perf(mirror): animate idle loops at the display rate`, with `Changelog: Idle animations in combat
  are smooth on the canvas renderer.`
- **Afterwards:** update memory `rust-phone-authored-cadence-sep27`, which describes the cap as current.

## 7. Measurement and integration

**Desktop A/B per WP:**
- `scripts/bench-rust-ab.mjs` at the phone viewport (`--viewport 739x281 --dpr 3.49`), with the config modelled on
  `.sts2/bench/rust-fast2-oct1/config.json`;
- recordings: the quiet and as-recorded idle combat, plus WP3's busy recording;
- gate every cell on `rendererWindow.backend === "rust"`, and record the load average;
- results under `.sts2/bench/wire-renderer/<wp>/`.

**Phone, in phase C:** one `mirror-bench` session, all round switches on vs off (WP7 has no switch, so both arms run
display-paced), ABBA, with the Oct 4
cells repeated as controls (raw WebGL2, DOM idle) to show drift. Report ms/frame, ms/s, presented fps and cpufreq
residency.

**Integration:**
- Per WP: implementer commit → Opus `code-review` → fixes → coordinator gates → merge into `round/wire-renderer`.
- GSW lands on its `main` first, as squash commits. Then rebuild the main checkout's Wasm and re-run the couch gate
  without the alias.
- Squash to couch `main`, one commit per coherent change, for example:
  - `perf(mirror): skip wire deltas that draw nothing` (WP1);
  - `perf(mirror): render the Rust stage through WebGL2 directly` (WP5);
  - `perf(mirror): evaluate tweens and card flights in the Rust renderer` (WP6).
- Add a player-facing `Changelog:` line on each `perf` commit, e.g. "Combat runs smoother and uses less battery on
  phones."
- Once the squash commits are on `main`, redeploy the installed mod through `couch-deploy` without asking, so the
  user's next play-test runs the round.

**Close-out:**
- a ledger row for every attempt, including WP4's spike and any MFAIL;
- update memory `topic-rust-stage`, and add per-WP memories where a trap was found;
- remove the worktrees.

## 8. Follow-ups for the next round (do not start in this one)

The coordinator recommends which of these to run next, based on this round's numbers.

- **Producer-side suppression** (now its own round: [handoff-producer-invisible-suppression.md](handoff-producer-invisible-suppression.md)) of transforms on subtrees with nothing visible, flushed when a descendant becomes
  visible. This saves host CPU and network as well. The scene watcher is in spirectl
  (`Sts2RuntimeSceneWatcher.cs`); check which repo owns the emission policy first.
- **Rendering in a worker** (`OffscreenCanvas`), if WP3's worker floor is markedly lower. Input hit maps would need a
  main-thread mirror.
- **DOM-side skip** of undrawn wire deltas.

## 9. Copy/paste prompt for the coordinator

> Run the round in `docs/agents/handoff-wire-shaped-renderer.md` as its Opus coordinator.
>
> 1. Read §1–§5, the Oct 4 ledger rows, the memories `phone-webgl-frame-floor-oct4`, `user-renderer-playtest-preference`,
>    `rust-idle-in-rust-oct3`, `idle-combat-round-oct3` and `topic-rust-stage`, and the `gsw-wgpu-renderer` skill.
> 2. Create a worktree per WP: couch via `couch-worktree`, copying `.sts2/rust-prototype-web/`; GSW via
>    `git worktree add` + `mise trust` + an offline `pnpm install`.
> 3. **Phase A, in parallel:**
>    - WP7 (round-implementer, Sonnet; remove the 30 fps idle cap; lands first, and WP1 rebases onto it);
>    - WP1 (round-implementer, Sonnet);
>    - WP2 (mirror-bench, Sonnet);
>    - WP3 (mirror-bench, Sonnet; the only phone session; run the §4 preflight first);
>    - WP4 (round-implementer, Opus).
> 4. **Phase B:** if WP4 meets its gate, run WP5 (Opus) and land its seam commit first. Then run WP6 (Opus) from that
>    seam. Merge WP5 and WP6 in a scratch GSW worktree and run every integration mode before landing either.
> 5. **Phase C:** one final phone session.
>
> Rules for every WP:
> - Review each branch with an Opus `code-review` pass before merging.
> - Add a ledger row per attempt.
> - Never `npm run build`, push or tag; leave the siblings on clean `main`; land GSW first.
> - Do not ask the user anything: run phone sessions, merges and the `couch-deploy` redeploy yourself, and decide
>   where a rule would otherwise ask.
>
> Finish with a report to the user:
> - the squash commits on `main`;
> - the deployed build;
> - the measured results against §3;
> - switch URLs for an on/off phone play-test.
