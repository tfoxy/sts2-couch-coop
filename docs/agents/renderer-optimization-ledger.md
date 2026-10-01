# Renderer optimization attempt ledger

A consolidated record of CPU/GPU optimization attempts on the CouchCoop web mirror renderer (DOM,
custom WebGL2/TS canvas stage, Pixi, and the Rust/wgpu WebGL2 stage). It exists because the same
switches keep getting re-proposed and re-measured — check it **before** proposing a renderer
optimization, and add a row **after you finish an attempt, including a failed measurement**.

`.sts2/bench/` paths are local, git-ignored working state. They exist on the machine/worktree that
produced them and may not exist in another clone or worktree — treat a missing path as "ask whoever
ran it", not as evidence the attempt didn't happen. Memory slugs (`MEM foo`) are durable and shared
via `.agents/memory/foo.md`; prefer them when both exist.

## 1. Purpose and how to use

Before proposing a renderer optimization: search this doc for the switch/technique by name or by
target (buildDrawList, text, Pixi scene graph, Rust/wgpu submission, idle cadence, …). If an outcome
is `REJ`, do not re-run the same measurement hoping for a different sample — cite *new* evidence that
addresses the specific rejection reason. If an outcome is `MFAIL`, the idea is still open — the
*measurement* failed to qualify (bad control, broken tooling, harness defect), not the idea.

Outcome codes:

| Code | Meaning |
| --- | --- |
| `ON` | Accepted, is (or was) the default-on behavior |
| `OFF` | Implemented behind a switch, kept default-off on the evidence |
| `REJ` | Measured cleanly and rejected — no help, or worse, beyond control variation/noise |
| `MFAIL` | Measurement could not qualify (harness defect, invalidated control, missing tool capability, correctness bug blocking a clean A/B) — **not** evidence the underlying idea fails |
| `PT` | Play-test prototype — implemented, offered for manual comparison, no controlled measurement |
| `DIAG` | Diagnostic-only control (e.g. no-submit, no-glyph, clear-only) — exists to attribute cost, never a shipped candidate |

**`REJ` vs `MFAIL` is the whole point of this table.** A `REJ` closes a question: cite a new mechanism
before reopening it. An `MFAIL` leaves it open: the next attempt needs a working measurement, not a
new idea. Conflating them is how a tooling failure gets remembered as "we tried that, it doesn't
help."

**Rule: add a row when you finish an attempt, including failed measurements.** An unrecorded `MFAIL`
is the single biggest source of repeated work in this campaign — see the Rust `perf`/Nsight/uProf
entries in §3 for how many capture-only attempts it actually took.

## 2. Attempt table

### A. Custom WebGL2/TS canvas stage

| Date | Switch/name | Target | What it changed | Outcome | Key numbers | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Aug 26 | `?stage=canvas` (M1/M1a) | whole mirror | one full-DPR canvas replaces DOM compositing; widescreen spread + texture pacing | ON | canvas decisively beat DOM on a real phone | `MEM canvas-stage-round-aug26` |
| Aug 27 | `?texturePace` | texture uploads | 4MB/8-count budget per build, always-allow-one, decode off the paint frame | ON (default) | — | `MEM canvas-stage-round-aug26` |
| Aug 27 | atlas re-packer, `rp://` seam | atlas uploads | `canvas/atlasRepack.ts` repacks atlases before upload | ON (default) | maxUpload 316→182.6 ms; 167.5→106 MB avoided | `MEM canvas-stage-m3-round-aug27` |
| Aug 27 | `?fxFps=15` + timer-arm scheduler | idle FX redraw cadence | dynamic idle cadence throttle | ON (default) | dynamic idle 30→15 Hz | `MEM canvas-stage-m3-round-aug27` |
| Aug 27 | `?listPatch=opacity` | tier-3 opacity-only patch | skip full rebuild for opacity-only animated nodes | ON | median animated frame 1.75→0.4 ms; 0/378 verify mismatches, 72% deckview frames patched | `MEM canvas-stage-r5-round-aug27` |
| Aug 27 | spine quads, trail join | spine rendering, comet trails | — | OFF (spine host down at measurement; trail join slivers on headed capture) | — | `MEM canvas-stage-m3-round-aug27` |
| Aug 27 | atlas `imgDrop` | — | — | OFF (held on own criterion; `--force-gpu-mem-available-mb` inert) | — | `MEM canvas-stage-r5-round-aug27` |
| Aug 27/28 | `?listPatch=transform` | tier-3 transform-only patch | — | ON | builds 969→319; frameMs p50 3.6→0.5 | `MEM canvas-stage-r7-round-aug27` |
| Aug 28 | owned `ImageBitmap`s (`atlasDecodedSource`, `spineStillBitmap`, `pageBitmap`) | phone decode stalls | stop re-decoding evicted `<img>` frames; mint/hold owned bitmaps instead | ON | fix described in `MEM canvas-stage-decode-eviction-aug28`; round-1 trace confirmed busy 53.7→41.5%, tasks >200 ms 8→0, `Decode Image` 2276→410 ms, GPU peak 450→369 MB | `MEM canvas-stage-decode-eviction-aug28` (what/why); numbers in `MEM canvas-stage-r2-owned-pixels-aug28` |
| Aug 28 | `HitMemo` | per-build hit/ancestor-walk cache | cache cleared at top of `buildDrawList` | ON | 41% of a 1,501-node wide-screen `buildDrawList`: 3.34→1.97 ms (ABBA in-process) | `MEM canvas-stage-r2-owned-pixels-aug28` |
| Aug 28 | depth-indexed `SpreadCtx` pool | walk allocation | pool small per-depth spread-context objects | REJ | 3.34 vs 3.30 ms — inside noise on desktop V8 | `MEM canvas-stage-r2-owned-pixels-aug28` |
| Aug 28 | `warmPrograms` | shader link timing | pre-warm GSW `WebglShaderRuntime` programs | ON | moves WHEN link happens, not its cost (cannot help when `KHR_parallel_shader_compile` is absent) | `MEM canvas-stage-r2-owned-pixels-aug28` |
| Sep 3 | `framePatchBail` spread-bail fix (R21/B2) | tier-3 transform patch on non-16:9 viewports | fixed a bail that refused every maximized-browser frame | ON (FIXED) | 1878×954: 0/295 patched, frameMs p50 16 ms → after fix 1654×954: 364/388 patched, frameMs p50 1 ms; 2,238 verified frames, 0 mismatches | `MEM r21-canvas-firefox-round-sep03` |
| Sep 3 | `?paintSkip` (B1) | static-screen redraw skip | — | ON (default) | fires on only 2.6% of paints in live combat (idle bobs move something almost every frame); 29.5% with `?idleAnim=off`, 34% on the map | `MEM r21-canvas-firefox-round-sep03` |
| Sep 3 | two rAF-period cadence controllers | idle redraw cadence | tried to correct `request + overhead` period drift | REJ | both diverged — overhead is not request-independent; shipped the *measurement*, not a controller | `MEM r21-canvas-firefox-round-sep03` |
| Sep 3 | `?textCanvas=plain` (R22) glyph-bail fix | text patching | `listPatch`'s `polyline` bail was really refusing `glyphs`; fixed couch-side adapter wiring | ON (default) | deckview: patched 5→565, `polyline` refusals 571→0, frameMs p50 6.7→1.8 ms | `MEM r22-textcanvas-flip-round-sep03` |
| Sep 6 | `glyphBlocks` layout/shaping memo | glyph layout + `measureText` | digest memo over `layoutText`/cmap sweep/`fillRun` | ON (default) | layout calls 48,073→1,226 (combat, full ABBA); buildMs p50 7.6→5.0 (deckview, same memo) | `MEM glyph-blocks-retention-sep06` (layout calls); `MEM r22-textcanvas-flip-round-sep03` (buildMs, where the memo was introduced) |
| Sep 6 | `withGlyphUnpack` removal | glyph atlas reupload | tried to drop the UNPACK wrapper | REJ | 6-row (24,576-texel) atlas made 24,921 deck reuploads with 2 same-frame atlas-overwrite errors; 7-row capacity was clean but isn't available | `MEM glyph-unpack-retention-sep06` |
| Sep 5 | `?stage=canvas&pureCanvas=on&canvasRetained=on` (strict single-canvas) | whole mirror, DOM-overlay-free | inert overlay facade, finite numeric patch chain | OFF (not promoted) | idle cadence fix moved candidate 48→60 fps, but failed CPU gates vs DOM: renderer-main 32.1% vs 16.53%, GPU-process 98.41% vs 79.57% | `MEM single-canvas-device-round-sep05` |
| Sep 5 | `?glyphRunBatch=on` | text instancing | 40-byte instance records vs per-glyph draws | REJ | 47.8 fps on vs 48.4 off; ~1% GPU-per-present; default off | `MEM single-canvas-device-round-sep05` |
| Sep 5 | exact tile-damage retained replay (coalesced dirty regions, one batched FBO transaction) | retained present cost | reduce replay command/FBO work | REJ | reduced replay overhead but still lost to DOM GPU cost | `MEM single-canvas-device-round-sep05` |
| Sep 5 | `canvasStaticBg=behind` | static background compositing | draw background behind stage vs in-stage | REJ | idle-only hint was −5.35% GPU-process CPU; full weighted matrix: behind 97.427% vs stage 102.098% GPU CPU (misses 5% bar) and frame gaps regress — `stage` stays default | `MEM single-canvas-device-round-sep05` (idle hint); `MEM android-mali-webview-profiling` (final weighted verdict) |
| Sep 5 | numeric-uniform update path | shader uniform churn | guarded Couch/GSW numeric-uniform update, skip redundant `GetShaderiv`/`CheckFramebufferStatus` | REJ | query counts fell (36→6, 37.5→25.5) but renderer CPU +5.66%, GPU-proc CPU +5.93%, rAF p95 +6.87%, actual-present p95 improved only 9.45% (insufficient) | `MEM single-canvas-device-round-sep05` |
| Sep 5 | stock-Chrome program-cache ABBA v2 | shader program compile cache | — | MFAIL | tab-leak across ports invalidated the cache/GPU-RSS comparison; operationally rejected, not causally | `MEM android-mali-webview-profiling` |
| Sep 5 | stock-Chrome program-cache ABBA v3 | shader program compile cache | re-ran v2 with both ports swept before every cell | REJ | compiles fell 33→6, but FPS −1.94%, rAF p95 +12.21%, actual-present p95 +36.37%; no GSW landing | `MEM android-mali-webview-profiling` |
| Sep 5 | native glyph-header cache | glyph upload header | — | REJ (default-off) | discards ack/present p95 and dense rAF/CPU despite some lower cycles/present; "no safe universal win" | `MEM android-mali-webview-profiling` |
| Sep 21 | texture churn reduction, headless-target pooling, compiled draw-list repair | GPU submission | — | MFAIL | Sep-21 Moto corpus did not qualify any of the three | `MEM canvas-gpu-gates-sep21` |
| Sep 21 | rAF-favoring mixed scheduler policy | idle cadence | book callbacks earlier/differently | REJ | more callbacks but no repeatable full-scene FPS gain; worsened present p95 | `MEM canvas-idle-cadence-attribution` |
| Sep 21 | no-glyph / no-submit / one-quad / clear-only controls | cost attribution | diagnostic-only ablations, never shipped | DIAG | — | `.sts2/bench/canvas-gpu-sep21/architecture-analysis/report.md` |
| Sep 21–22 | compact retained-subtree cache | retained composition | subtree-scoped retained cache | MFAIL then REJ | first attempt: exact 220-point hit parity failed (correctness bug, not a clean A/B) = NO-GO; requalified correctness, then one clean phone ABBA failed perf: idle 21.45 fps / GPU CPU +10.2%, reshuffle regresses rAF/present/ack p95 5.4/9.0/11.6%, dense regresses actual-presented FPS −19.9% | `MEM retained-subtree-no-go-sep21` (MFAIL); `MEM retained-subtree-requalification-sep22` (REJ) |
| Sep 23 | execution-only text ablation | idle cost attribution | remove text submission entirely as a diagnostic | DIAG | idle 26.85→54.00 fps (+101.1%); independent ordinary-geometry removal did not improve FPS | `.sts2/bench/canvas-gpu-sep21/canvas-ablation-sep23/report.md`; `MEM canvas-text-pixels-versus-shapes` |
| Sep 23 | `canvasTextCache=gpu` (GPU label baking / shape cache) | text raster cost | bake labels to GPU textures instead of re-rastering each frame | OFF (default; "NO-GO" on the CPU gate — the maintainer notes this is the only switch with a visible FPS gain so far) | phone idle ABBA: actual FPS 26.8→37.1, present p95 91.69→38.92 ms, GPU-process CPU 159.24→75.76% (−52.4%), **but** renderer-main CPU 26.58→92.60% of one core (+248.4%) — mandatory NO-GO on the CPU gate | `MEM canvas-text-pixels-versus-shapes`; `.sts2/bench/canvas-gpu-sep21/canvas-text-cache/phone-sep23/measurement-report.md` |
| Sep 23 | renderer-comparison play-test panel (DOM/Canvas/cached-text/Pixi/full-rebuild/CPU-reuse/compiled-submission/dirty-redraw/cached-layers/separate-surfaces) | manual A/B tool | play-test switch panel, no automated phone campaign | PT | — | `.sts2/bench/renderer-playtest-sep23/delivery.md` |
| Sep 24 | dirty redraw, preserved-WebGL dirty-copy, single-canvas dirty copy (display-paced idle targets) | idle GPU cost | three alternate idle pixel-update strategies behind the play-test panel | PT | manual-only; no phone FPS claim | `.sts2/bench/idle-gpu-sep24/delivery.md` |
| Sep 24 | `cmpStructure=reuse` (paint-order prep reuse), `cmpTextCpu=reuse` (text prep reuse) | CPU preparation reuse | reuse validated paint-order/text preparation across builds | PT/OFF | manual-only; no automated phone or performance acceptance campaign run | `.sts2/bench/cpu-prep-sep24/delivery.md` |
| Sep 24 | source-shape (animated-frame) patch design: repeated source-fit correction | avoid full rebuild on source-frame dimension/margin changes | algebra-only feasibility pass for a geometry-patch formula | PT (design only, feeds `cmpSource=reuse` below) | max matrix error ≈1.14e-13 over 300 synthetic swaps — algebra feasibility, not a renderer measurement | `.sts2/bench/cpu-prep-followup-sep24/next-experiments.md` |
| Sep 24 | `cmpSource=reuse` (animated-frame / source-frame geometry reuse) | avoid full rebuild for single-quad source dimension/margin changes | implemented, became the "CPU best verified" play-test default | PT/OFF | "No ablation or promotion is claimed without an accepted algorithm comparison" | `.sts2/bench/cpu-campaign-sep24/STATUS.md` |
| Sep 24 | `cmpAnimation=reference` + texture coalescing | animated-frame reuse algorithm | reference-patch animation path, cross-session CPU comparison | OFF (accepted preview, stays off pending ablation) | renderer-main busy 96.94%→53.12% (cross-session, ~45.2% relative) | `.sts2/bench/cpu-campaign-sep24/cpu-reuse-120/RESULTS.md` |
| Sep 24 | overlay-pose update without full reconcile + coalesced cached-GPU instance uploads | overlay/instance upload cost | `perf(canvas): update overlay poses without full reconcile` + `perf(canvas): coalesce cached GPU instance uploads` | REJ | busy fraction 30.45%→38.49% (worse); failed the 10% relative-reduction gate | `.sts2/bench/cpu-campaign-sep24/cpu-frame-work/RESULTS.md` |
| Sep 24 | nine-patch spans, opaque-tint skip, zero-alpha glyph skip | geometry/glyph submission cost | skip redundant geometry/glyph work | REJ | busy fraction 30.45%→64.05% (much worse) | `.sts2/bench/cpu-campaign-sep24/cpu-geometry-glyph/RESULTS.md` |
| Sep 24 | production vs development bundle | dev-only instrumentation overhead | measure devtools/assertion overhead vs a scratch production build | MFAIL | development/production ABBA stopped at cell B1: attached-browser setup timed out before warmup; earlier single-cell contrast (dev 35.1% vs prod 31.9% main-thread) is provisional only | `.sts2/bench/cpu-campaign-sep24/STATUS.md` |

### B. Pixi

| Date | Switch/name | Target | What it changed | Outcome | Key numbers | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Sep 22–23 | native Pixi Text/retained-object candidate | whole Pixi stage | retained objects + native `PIXI.Text`, replacing per-frame rebuild | REJ (scoped migration gate NO-GO) | idle actual-present p95 improved 42.7%, but idle renderer-main CPU +162.8% (30.98%→81.43% of one core) and RSS exceeded the memory allowance on both idle and dense workloads | `MEM pixi-spike-negative-investment-gate`; `.sts2/bench/canvas-gpu-sep21/pixijs-spike/report.md` |
| Sep 24 (source audit) | Pixi change-driven scene graph (render groups / `cacheAsTexture`) | incomplete integration follow-up | audited why the Sep-22 spike cost CPU; no code change | DIAG (source audit only) | adapter still resets/rebuilds the full draw list and reapplies every transform per frame | `MEM pixi-spike-negative-investment-gate` |
| ~Sep 25 | `gl.getParameter(SCISSOR_BOX)` clip-state query removal | retained-Slug clip recovery | stop querying GL state per label | ON (kept on branch) | 55.48% of a retained cached-Slug phone profile (3,047/5,492 samples) was inside that one query | `MEM pixi-instruction-state-reset` |
| Sep 25–26 | retained-combat CPU bundle (stage3) | quiet-combat retained render cost | sequential (non-ABBA) fixed/candidate phone pair | REJ (weak single pair, promotion rejected/rolled back) | candidate +13.55pp renderer-main occupancy (59.72% vs 46.16%), −12.1% completed-draw throughput; explicitly not a controlled ABBA — "severe high-load result is sufficient to reject promotion and restore the accepted preview" | `.sts2/bench/cpu-campaign-sep24/pixi-retained-combat/REPORT.md`; `.../stage3/phone-combat-sep26-report.md` |
| Sep 26 | retained-combat CPU attribution (why it still costs) | explain stage3 regression | saved-trace attribution only, no new capture | DIAG | `AbstractRenderer.render`/`executeInstructions` (retained instruction walk + batch submission) is the leading identified recurring cost, 1,000 inclusive samples; 2,283/4,531 non-build samples remain unresolved `(program)` leaves | `.../stage3/pixi-cpu-attribution-report.md` |
| Sep 26 | retained Pixi present-reuse (skip re-submitting unchanged batches) | batch submission cost | certify which direct batches are safely reusable across quiet frames | MFAIL (negative reuse-proof gate) | only 39/123 direct batches per frame were barrier-clear reuse candidates (52/123 even had certified-unchanged inputs, below the required half); the other 66 were unresolved Graphics-mask batches — "unknown rather than zero or changed" | `MEM pixi-present-reuse-gate-sep26` |
| Sep 26 | skip-GL / clip-omission / single-quad controls | cost attribution | diagnostic-only ablations | DIAG | — | `.sts2/bench/renderer-attribution-sep26/`, `.sts2/bench/renderer-attribution-ops-sep26/` |
| Sep 26 | Pixi `buildDrawList` qualified hotspot | callback repricing / cost attribution | marker-derivative A/B isolating `buildDrawList` exclusive CPU | DIAG (qualifies a target, not a candidate) | three on-cells: 1,122.5 / 1,179.7 / 1,100.2 ms exclusive draw-list construction over ~4 s (38–40% of main CPU); the natural next control (paint-order/command-fragment reuse) was explicitly "a hypothesis," not yet tested | `.sts2/bench/renderer-dev-nightly-sep26/continuation/offline-attribution/callback-reprice/round-decision.md` |
| Sep 26 | `ccPaintOrderReuse` on Pixi | paint-order/command-fragment reuse during full builds | offline correctness gate passed (parity, hit probes); phone A/B never completed | MFAIL | offline parity/hit gates passed; the ON/OFF/OFF/ON phone schedule stopped after cell 2 because the first trace-off replay recorded black display frames after readiness — "No optimization CPU claim is made" | `.sts2/bench/renderer-dev-nightly-sep26/continuation/offline-attribution/paint-order-control/` (offline gate: `paint-order-control/offline/decision.md`; phone stop: `paint-order-control/trace-crossover/audit.md`) |
| — | Pixi WebGPU backend | render backend | evaluate wgpu/WebGPU under Pixi | MFAIL | — | `.sts2/bench/wasm-feasibility/webgpu-campaign/WEBGPU-API-AXIS-REPORT.md` |

### C. Rust/wgpu WebGL2 stage

| Date | Switch/name | Target | What it changed | Outcome | Key numbers | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Sep 27 | instanced 8-texture batching + typed `patch/1` | draw-call count, scene (de)serialization | batch draws by texture, typed incremental patches vs full scene JSON | fairer prototype, but mixed | quiet/busy draws fell 191/85→23/12; busy renderer CPU −16.94% vs paired Pixi (does not clear 15%-beyond-noise bar); quiet renderer CPU +84.92% vs Pixi; the TS-canvas busy arm in the same campaign was +328.50% presents vs Pixi and was never followed up | `.sts2/bench/wasm-feasibility/measurement/FAIR-WEBGL2-REPORT.md` |
| Sep 27 | retained Rust `patch/1` update path (second pass) | same-shape update cost | typed retained transform/opacity/source patches, staged hit/composition | MFAIL | desktop fidelity mostly byte-equal but busy differs 8/3,517 logical-paint rows (up to 14.32 design-unit displacement) — a strict fidelity failure even though the captured pixel frame matched; phone comparison matrix collected but not a paired-control verdict here | `.sts2/bench/wasm-feasibility/retained-rust-sep27/RESULT.md` |
| Sep 27 | `rustRetainedTransformOverrides` | retained transform-override plan | reuse last-committed transforms instead of rebuilding | REJ | busy control: 19 plans attempted, 0 accepted, 17/17 fallbacks kept | `MEM rust-retained-transform-override-fallback-sep27` |
| Sep 27 | native Android Vulkan renderer | native (non-browser) Rust path | run the Rust renderer natively via Vulkan vs a GLES clear-and-swap baseline | REJ | Rust ~34.3% of one app CPU core vs ~20–21% baseline (+13.59pp / +65.6% relative); ~0.6–0.75 GB PSS vs ~0.10–0.12 GB; both ~45 Hz — "numbers do not support a native performance win" | `.sts2/bench/wasm-feasibility/native/native-ab-report.md` |
| — | Rust/wgpu WebGPU backend | render backend | — | MFAIL | — | (see `.sts2/bench/wasm-feasibility/webgpu-campaign/`) |
| Sep 28 | `rustTextInkReadFrequently` | phone text raster | `readFrequently` canvas hint for text ink | ACCEPTED, but still opt-in (query-gated `=1`, not default-on — verify current default in `frontend/src/mirror/renderer/pixi/createRustDrawListExecutor.ts`) | OFF→ON phone busy content presentations: 8.06/21.00/20.83/8.20 fps (one order), 19.15/11.83/11.23/21.46 fps (reversed order) — ON wins both orders but total renderer CPU rose (~93→150%, ~102→146%); FPS benefit, not a CPU saving | `MEM rust-text-ink-phone-sep28` |
| Sep 28 | `rustZeroCopyPixels` (first-frame `ImageData` zero-copy) | phone startup CPU | typed-array view instead of a copy | REJ | OFF 8,140 ms vs ON 8,194 ms startup, inside 613 ms OFF/OFF spread | `MEM rust-phone-zero-copy-startup-sep28` |
| Sep 28 | `rustOmitStaticPixelCaches` | desktop static-pixel cache | omit Pixi-style static-pixel admission for Rust | OFF | ON averaged 6.09% lower renderer CPU, but OFF/OFF variation was 9.81% — bounds don't separate | `MEM rust-static-cache-desktop-sep28` |
| Sep 28 | `rustSkipHiddenHitCandidates` | hidden-subtree hit-test walk | skip hit candidates for hidden subtrees | REJ | renderer CPU 2.14% **higher** at the ON point estimate, inside OFF/OFF variation | `MEM rust-static-cache-desktop-sep28` |
| Sep 28 | `rustFlatOnAnimationRefusal` | flat-plan shortcut on animation refusal | — | REJ | 9.36% worse point estimate (7,267 ms vs baseline over 8.195 s) | `MEM rust-static-cache-desktop-sep28` |
| Sep 28 | `rustReuseGameRawMatrix` | raw game-matrix reuse | — | REJ | 1.84% lower point estimate, inside 2.51% OFF/OFF variation; GPU-process CPU proxy was higher | `MEM rust-static-cache-desktop-sep28` |
| Sep 28 | `ccPaintOrderReuse` on Rust desktop | paint-order/command-fragment reuse | — | MFAIL | — | `cc-rust-text-ink-sep28` worktree: `.sts2/bench/paint-order/READOUT.md` |
| Sep 29–30 | desktop CPU/output lane harness v7–v14 | measurement-harness hardening (oracle freezes, lease/preflight fixes, warm-resource replay) | — | MFAIL | v8 oracle failed source-hash attestation; v9/v10 preflight lease-liveness edge cases; v11 C1 eligible but C2 failed the frozen-resource rule (124 vs 125 resources), C3 not run; v12 warm-resource oracle failed at scene 31; v13/v14 diagnostic-only traced that failure (a lost-pull race, test-reproduced, fixed by a default-off `rustPendingAckRetry` repair) | `cc-rust-cpu-output-sol-sep29` worktree: `.sts2/bench/desktop-rust-cpu-output-wrap-2026-09-30.md` |
| Oct 1 | merged Rust canvas stage; ordinary controls C1–C3 | desktop baseline for further CPU work | GSW `2a9491ec` + Couch `79917d0e`..`0c221425` merged to local `main` | ON (stage merged; no CPU saving claimed) | C1–C3 all delivered the same 291 scenes (indices 387–677) with equal output; conservative renderer-process CPU envelope 5,061.626–5,330 ms (width 268.374 ms); C1/C2 completed 459 intermediate frames, C3 451 | `.sts2/bench/desktop-integrated-rust-oct1-index-0c221425-controls-prep/DIAGNOSTIC-DECISION.md` |
| Oct 1 | `ccPaintOrderReuse` diagnostic (desktop, against the Oct-1 merged stage) | paint-order/command-fragment reuse | query-gated shadow-cache diagnostic over the C1–C3 baseline | HOLD (MFAIL) | V4: 489 paint-order pairs, 503.128 ms instrumented renderer-main CPU, but the marker span stretched to 10.455 s (vs the ordinary ~7 s slice) and Chrome omitted canonical decode events, so no valid output/shadow-eligibility receipt; V5 (explicit decode allowance) timed out on the close handshake. Astra directed HOLD, no further live retry under this plan | `MEM rust-paint-order-diagnostic-oct1`; `.sts2/bench/desktop-integrated-rust-oct1-index-0c221425-controls-prep/DIAGNOSTIC-DECISION.md` |

## 3. Profilers and tools: verdicts

| Tool / technique | Verdict | Notes | Evidence |
| --- | --- | --- | --- |
| Chrome trace (`chrome://tracing` / `Tracing.start`) | Works | Primary source for marker windows, thread CPU, named events | — |
| `console.timeStamp` phase markers | Works, but fragile | Only valid when **every** call on the path is marked — a single unmarked call invalidates a window's attribution | `MEM pixi-phase-marker-sampling-sep27` |
| CDP `Profiler` (V8 CPU profile via DevTools protocol) | Broken timing | Nonmonotonic/negative sample-time deltas; usable for exclusive-leaf **sample counts** only, never ms | `MEM rust-desktop-cdp-profile-invalid-sep28`, `MEM chrome-profile-chunk-time-deltas` |
| Android Perfetto (`sched`, `FrameTimeline`) | Works | Needs PID/UPID join + clock-snapshot offset; join `app.display_frame_token` to the SF display row for actual presentation, not `DrawFrame` submission | — |
| Desktop Perfetto system-wide capture | Denied | `kernel.perf_event_paranoid` blocks system-wide sampling even at 0 on this box's Nsight path | — |
| `/proc` process/thread CPU brackets (Node read/evaluate calls around a page marker) | Works | Causal brackets around the actual read call, not post-read epoch stamps | `MEM desktop-proc-marker-causal-brackets` |
| Linux `perf` + V8 JIT injection | Fails to qualify | Best run resolved JS leaf/caller well (97%/98%) but WASM leaf/caller gates failed (92%/1.8%); throttle events and a close-handshake bug also present | `MEM rust-profile-v8-perf-jit-sep29`, `MEM rust-desktop-perf-profile-unqualified-sep28`; full campaign in `.sts2/research/wasm-caller-recovery-sol-sep30-v4/` (uncommittable, local to each checkout) |
| NVIDIA Nsight Systems | Unresolved | A qualified ordinary replay capture had 97.97% unresolved leaves and 99.46% unresolved immediate callers; no hotspot follows | `cc-profile-sol-sep29` worktree: `.sts2/bench/canvas-profile/nsight-sep29-cpu/offline-qualification.md` |
| AMD uProf (TBP) | No usable stacks on the production path | A dedicated-binary smoke resolved symbols; the real replay's report spans 48.6 s across 185 threads with no call stacks, 3.6 of 5.1 s unresolved `[heap]` | `MEM android-mali-webview-profiling`; `cc-profile-sol-sep29` worktree: `.sts2/bench/canvas-profile/campaign-readout.md` |
| AMD uProf IBS | Never tried | Driver (`AMDPowerProfiler.ko`) not loaded on this box; CLI reports IBS capability but no capture was taken | `MEM android-mali-webview-profiling` |
| RenderDoc | Never validated on the actual Rust Chrome WebGL2 context | Arm-GPU RenderDoc binary exists locally; no capture run | `MEM rust-webgl-profiler-gap-sep28` |
| Spector.js | Works on desktop with a pre-context shim; unusable on phone | Command markers join batches; carrier identity inside a batch remains ambiguous | `MEM spector-precontext-batch-join` |
| Chrome `--enable-gpu-service-tracing` | Works | — | `MEM chrome-dev-gl-trace-native-limits` |
| Android Simpleperf | GPU-process only | Sandboxed renderer process refuses native sampling even on profileable Dev/Canary builds | `MEM android-chrome-per-gl-attribution`, `MEM webview-profileable-wrapper-limit` |
| Arm Mali Streamline | Global counters only, not per-call | Needs a debuggable WebView wrapper; stock Chrome is not attachable | `MEM android-mali-webview-profiling` |
| WebGL/wgpu timer queries | Mixed | wgpu reports no `TIMESTAMP_QUERY` on this adapter, so GPU execution stays null through wgpu; but `EXT_disjoint_timer_query_webgl2` **is** present and `disjoint=false` on the same NVIDIA/ANGLE path when queried directly from JS, and has never been tried wrapped around `present()` | `MEM rust-webgl-profiler-gap-sep28` |
| Wayland presentation feedback | No content identity | Surface-commit/feedback timestamps exist but never carry a per-content (revision/build/present) token — can't isolate "this frame" | `MEM rust-wayland-feedback-content-gap-sep29` |
| Chrome 147 decode trace events | Missing | Canonical image-decode events absent from an otherwise valid Rust replay trace | `MEM rust-profile-chrome-decode-trace-sep29` |
| `campaign-readout.md` | Reference | The Sep-29 profiler-ledger of record; read it before trusting any older profiling summary in this doc | `cc-profile-sol-sep29` worktree: `.sts2/bench/canvas-profile/campaign-readout.md` |

## 4. Valid CPU attribution numbers

All of the following are **thread-CPU or process-CPU intervals bound to an explicit marker window**,
not inclusive wall sums — read the clock column before comparing two rows.

- **Rust desktop, ordinary ~7 s busy window (Oct 1, C1–C3):** renderer-process conservative CPU
  envelope 5,061.6–5,330 ms (268.4 ms wide across 3 cells). `.sts2/bench/desktop-integrated-rust-oct1-index-0c221425-controls-prep/DIAGNOSTIC-DECISION.md`
- **Same window, thread-CPU phase breakdown (Chrome `tts`, balanced marker pairs):**
  `buildDrawList` 2,485.259 ms / 381 calls; retained composition 957.506 ms / 372 calls (zero overlap
  between the two phase families); Rust-side `prepare`/`encode-submit`/`resume` 86.5/161.3/34.5 ms
  (Chrome-thread-tts; 372 calls each) — these Rust-side numbers are synchronous spans only, not a
  renderer-process CPU share. `cc-rust-text-ink-sep28` worktree, `.sts2/bench/rust-exec-phases/`:
  `NATURAL-PRODUCER-PROFILE-PREFLIGHT.md` (buildDrawList/retained-composition) and
  `natural-phase-attribution.json` (Rust prepare/encode-submit/resume).
- **Wall-time (not CPU) lead:** transform-override plan evaluation precedes 353/366 full builds in a
  wire-reason ranking; hidden-subtree hit-test walk upper bound 1,567.6 ms over an 8.2 s window.
  `cc-rust-text-ink-sep28` worktree: `.sts2/bench/rust-static-cache/WIRE-REASON-RANKING.md`
- **DevTools exclusive-leaf sample counts (not timed — see §3 CDP verdict):**
  `createRetainedPixiComposition` 1,583 samples; `buildDrawList` walk 952 samples (of 9,601 total,
  611 with invalid/negative time deltas). `cc-profile-sol-sep29` worktree, `.sts2/bench/canvas-profile/`: output of `analyze-v8.py` against `v8-pinned/v8-diagnostic.stdout.txt`.
- **Pixi phone, busy ~4 s window:** `buildDrawList` exclusive construction 1,100–1,180 ms across three
  on-cells (38–40% of main CPU, 15–17% of process CPU). `.sts2/bench/renderer-dev-nightly-sep26/continuation/offline-attribution/callback-reprice/round-decision.md`
- **Rust phone, busy ~7 s window, refused delivery-pacing cell:** 11,922.123 ms renderer-process
  scheduled CPU (named-family partition, 0.000 ms reconciliation error) — this cell was refused for
  delivery pacing, so treat it as attribution evidence, not an accepted FPS/performance result.
  `cc-rust-text-ink-sep28` worktree: `.sts2/bench/text-ink-phone-sep28/natural-aligned-20260928-134210-utc/aligned/OFFLINE-CPU-DECOMPOSITION.md`

## 5. Proposed but never tried

- TS canvas GPU-executor submission reduction (currently ~47 batches / 134 binds per frame).
- TS canvas busy-arm +328.5% presents-vs-Pixi result from the Sep-27 fair comparison — never
  investigated for *why*, only recorded.
- `renderer-playtest.md` backlog (on the experiment branch, not on `main`): packed glyph atlas,
  incremental draw-list/hit preparation, drawn-node-map reuse on unchanged revision/topology,
  `textPosePending`/`textPoseSelection`-driven relaxation of text-pose patch admission, longer-lived
  rebased transform patches, incremental overlay reconciliation, cached-text scale/rotation/tint
  support, Canvas2D browser-raster-vs-GPU-text-baking cost comparison.
- Compositor islands (named but not scoped).
- Pixi batch combining + scheduler/GC driver handoff. `.sts2/bench/cpu-campaign-sep24/pixi-scheduler-gc-handoff.md`
- Rust: retained-transform-from-last-committed-matrix (distinct from the rejected override-plan
  approach — a safe-baseline-rules redesign was never attempted); a diagnostic that separates
  transform/spread/view-scale cost explicitly; `FontFaceSet.check` caching; `computeSpread` reuse;
  Slug text rendering in Rust; making `rustTextInkReadFrequently` default-on (currently opt-in).
- Tooling: a symbolized Chromium build (to make `perf`/CDP leaf resolution actually work); AMD uProf
  IBS capture (driver installed but never loaded/exercised); RenderDoc / Nsight Graphics validated
  against the actual Rust WebGL2 context; a JS-side `EXT_disjoint_timer_query_webgl2` timer wrapped
  directly around Rust's `present()` call (the extension is present and usable from JS; only the
  wgpu-internal `TIMESTAMP_QUERY` path is unsupported).

## Oct 1 rustFast bundle

All items are exact by construction and resolve in `rustFastFlags.ts`. `rustFast=1` enables them all;
`<switch>=0` turns one back off. The code lives on Couch and GSW `experiment/rust-fast-oct1`, default
off, and is not on `main`.

**How it was measured:** `scripts/bench-rust-ab.mjs` with untraced `/proc` cells and a stage gate on
every cell. The workload is `dense-vfx-endturn` at the 12–19 s busy window, 1920x1080, very-low tier,
Vite dev build, with n=6 cells per arm alternated. Evidence:
`.sts2/bench/rust-fast-oct1/REPORT.md` (main checkout).

| Date | Switch/name | Target | What it changed | Outcome | Key numbers | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Oct 1 | `rustFast=1` (whole bundle) | desktop busy renderer CPU | every row below at once | OFF (clear win; merge pending the user's decision) | renderer `/proc` 4,398 → 2,420 ms per 7 s (**−45%**); worst ON cell 2,720 < best OFF cell 3,840; CPU per stage frame 10.91 → 5.89 ms; GPU process −8.5% (inside spread); stage frames unchanged; verify counters 0; no pixel or hit difference beyond animation noise | REPORT.md |
| Oct 1 | `rustLazyComposition` + `rustOmitStaticPixelCaches` | retained composition built on every full build | static pixel-cache admission skipped for Rust; patch index built lazily on first use (never in the busy window) | OFF (largest piece) | composition phase 1,028 → 39 ms of thread CPU per 7 s; leave-out costs +890 ms vs ON (~20–24% of OFF). Supersedes the Sep 28 static-only "unconfirmed −6%" as the composition lever | REPORT.md, `MEM rust-static-cache-desktop-sep28` |
| Oct 1 | `ccPaintOrderReuse`, `rustFastSerializer`, `rustTextPrepCache`, `rustFontCheckCache`, `rustSnapshotReuse`, `rustDrawStateDedupe` | per-build JS overheads; wgpu `set_pipeline` churn | reuse the complete paint order; `jsonEqual` diff plus a group index in the GSW encoder; cache text preparation and true font checks (event-invalidated); skip O(N) copies; set the pipeline only on change | OFF | together about −0.65 s (~15% of OFF); individually below cell noise (±250 ms). The Rust phases barely moved (238 → 221 ms) | REPORT.md |
| Oct 1 | `rustHiddenMemo` | hidden-subtree walk metadata | replay recorded metadata for unchanged hidden subtrees | OFF (inside noise) | offline node hit rate 95.7%, live only 41% (root hit rate 92.6%, but misses fall on ~393-node subtrees: absent, taint, span, context); −150 to −295 ms, within noise; 52,478 roots verified, 0 mismatches | REPORT.md |

**What remains with ON** (JS profile, sample counts; `profiled/`):
- `buildDrawList` `walk` is still the largest JS item (22% inclusive). Native work with no JS frame is ~51% of busy samples, Wasm ~4%.
- Small leaks: `rewardFocusSnapshotFromScene`, `staticBgTargetPathOf`, and a `URLSearchParams` parse per font check in `fonts.ts` `corpusDiagnosticEnabled`.
- The bench's own WebSocket replay shim accounts for ~8% in both arms.

**Trap:** a worktree with a symlinked `.sts2/rust-prototype-web` 403s the Wasm, and the stage silently
falls back to DOM. The first smoke of this round measured DOM at ~1.46 s. Gate every cell on
`rendererWindow.backend === "rust"` (`MEM rust-wasm-worktree-dom-fallback`).
