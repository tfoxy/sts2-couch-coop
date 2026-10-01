# Rust WebGL2 profiling handoff

## Objective and starting evidence

Find the CPU work that keeps the Rust WebGL2 mirror below the desired busy-combat presentation rate, then select a switchable change with a measured end-to-end benefit. Profile the **whole browser renderer process** first: Couch's TypeScript scene preparation and resource work, godot-scene-web's scene serialization, Wasm/Rust admission and present execution, Chromium native rendering and driver submission. Measure GPU execution and display delivery on their own clocks. A faster `buildDrawList` alone is not a faster viewer if another thread, the GPU, or presentation pacing becomes the limit.

The latest pinned Linux `perf` capture is a useful map, not a qualified hotspot result. The fixed busy markers contain 715 renderer-process samples; 505 (70.6%) have a named V8 function somewhere on the stack. Renderer main has 548 samples, including 246 with `buildDrawList` as an **inclusive caller**, but other renderer threads and many leaves remain unresolved. Resolving native symbols and thread CPU would complete the process picture; it would **not** turn those 246 inclusive samples into a specific `buildDrawList` leaf hotspot. That needs exclusive operation evidence. The copied gate also rejected a stale flag expectation and lacks a contemporaneous source-after receipt. The ≥80% meaningful whole-renderer symbol gate applied to **that capture** was not met. Preserve the raw capture and `rust-perf-profile/capture-1/OFFLINE-READOUT.md` in the experiment checkout's ignored `.sts2/bench/`; do not turn inclusive sample counts into CPU milliseconds or pick a leaf from it.

The current ink read-frequency control has accepted phone evidence, but the static pixel-cache and hidden-hit controls have no confirmed CPU saving. Keep existing controls and their effective settings explicit. The user accepts **more than 89 actual content presentations/s at idle** as a target; the current ink configuration has not been measured at that rate. The priority is **busy combat above 30 actual content presentations/s**. For the next phone checkpoint, the compatible controls together should first show about **50% lower desktop renderer-process CPU or directly measured GPU execution cost** against the pinned current baseline. This is a cumulative target, not a requirement for each control. Candidate output can differ visibly if the gain justifies it: keep before/after images and the measured speed so the user can judge. Instrumentation-only arms should still match output.

## Shared `canvas-profile/1` contract (frozen for this round)

Use the generic contract in GSW's `docs/canvas-profiling.md`. The profiling
transport is opt-in JSON Lines plus a run receipt. `runId` is fresh per capture;
`rendererInstanceId` distinguishes mounts. The consumer allocates a positive
unsigned 32-bit `operationId` monotonically for every full build, retained patch
and present-only attempt in that renderer instance. It never wraps or reuses an
ID; no high-bit range is reserved. The join key is `(runId,
rendererInstanceId, operationId)`. `buildId` and `sceneRevision` remain separate,
optional facts, so a stopped build still has an operation ID. GSW carries the ID
without assigning consumer semantics to it.

Each event has `schema: "canvas-profile/1"`, the join key, `kind`
(`full-build|retained-patch|present-only`), `eventType`
(`phase-edge|outcome|counter|gpu-result`), `clockDomain`, and a decimal-string
`timestampUs`. Phase edges have `phase` and `edge: start|end`; outcomes are
`built|accepted|submitted|completed|displayed|refused|superseded|failed` with a
reason when applicable. Couch phases use `couch.*`; generic phases use
`canvas.serialize`, `canvas.wasm-copy`, `rust.admit`, `rust.upload`,
`rust.encode-submit` and `rust.resume`. Queue/promise waits use separate
`*.wait` wall-time phases. Synchronous spans close in `finally` and never cross
an await. Counters name calls and bytes. Bounded collection reports dropped
events and open spans. Only display evidence may establish `displayed`.

The run receipt records command/profiler settings; source, Wasm, glue, input and
resource SHA-256 before and after; effective backend/settings/viewport;
browser, GPU and driver identity; PID/TID and process start identity; clock
mappings and uncertainty; markers, readiness, delivery, resource and output/hit
results; per-thread JS/Wasm/native leaf and caller symbol coverage; lost events;
GPU capability/disjoint status; and actual content presentation source/count.
Every metric has value, unit, method and coverage; unavailable values are `null`
with a reason. Raw traces, profiles, images and video stay ignored and are
referenced by path and hash. This receipt explains attribution; the existing
renderer benchmark result contract still gates comparable cells.

## Branches, owners, and integration

| Owner | Isolated worktree and branch | Starting head | Scope | Merge destination |
| --- | --- | --- | --- | --- |
| Sol, Couch | `cc-profile-sol-sep29`, `round/profile-sol-sep29` | `7ad968e6` | Replay orchestration, TypeScript producer/executor diagnostics, benchmark receipt and this handoff | `experiment/rust-text-ink-readback-sep28` in `cc-rust-text-ink-sep28`, then the coordinator's reviewed canvas integration branch |
| Luna, Couch | `cc-profile-luna-sep29`, `round/profile-luna-sep29` | `7ad968e6` | Independent source, fidelity, clock and evidence audit; focused fixtures | Same Couch experiment branch after Sol/Luna reconciliation |
| Sol, GSW | `gsw-profile-sol-sep29`, `round/profile-sol-sep29` | `b97b71bd` | Scene encoder, Wasm bridge and Rust renderer phase/counter hooks | `experiment/rust-webgl-phase-sep28` in `gsw-rust-webgl-phase-sep28`, then the coordinator's reviewed GSW canvas integration branch |
| Luna, GSW | `gsw-profile-luna-sep29`, `round/profile-luna-sep29` | `b97b71bd` | Independent Rust/serializer attribution and output audit | Same GSW experiment branch after Sol/Luna reconciliation |

This is **one coordinated profiling campaign**. Freeze the shared operation-ID/phase schema and artifact receipt first. Couch CLI/producer work and GSW canvas/Rust hooks may then proceed in parallel in their isolated worktrees. Integrate GSW into `experiment/rust-webgl-phase-sep28` first and rebuild/re-pin source, Wasm and glue. Next, point Couch's scratch aliases at that exact GSW worktree, verify the combined path, then integrate Couch into `experiment/rust-text-ink-readback-sep28`. The final canvas integration branch names beyond these targets must be recorded by the coordinator **before merging**; do not silently use either repository's `main`. Serialize diagnostic captures and uninstrumented benchmark cells on the shared desktop, GPU and phone: overlapping runs create contention, lease conflicts and invalid comparisons. Do not switch the shared GSW checkout from clean `main`, merge into main, push, tag, deploy, use ports 5219/5220, or open a visible game window. Use ignored scratch output; `npm run build` deploys in Couch. Run `scripts/install-agent-config.sh` in a newly created worktree.

Product ownership stays clear: Couch owns `frontend/src/mirror/canvas/buildDrawList.ts`, `frontend/src/mirror/renderer/pixi/{createPixiMirrorRenderer,createRustDrawListExecutor,producerBuildReasons}.ts` and the replay adapter. GSW owns `packages/canvas/src/rust-prototype-scene.ts`, `packages/canvas/rust-prototype/src/{renderer,wasm}.rs`, GPU query plumbing, and the generated Wasm/glue artifact for a benchmark. Scene `scene/2` and patch `patch/1` remain compatible unless a separately reviewed protocol change is justified.

### Reusable tooling deliverables

The Couch entry point coordinates the **consumer campaign**; the GSW entry point is a reusable **canvas component contract**. They share identity and receipt fields, while only Couch chooses the replay, viewer settings and paired comparison. These commands are implemented on the two experiment branches:

| Owner | Command | Required behavior and durable output |
| --- | --- | --- |
| Couch | `node scripts/profile-mirror-rust.mjs probe --config <config.json>` | Report host and optional browser binary identity, `perf`/Perfetto/uProf/ADB/CDP availability and host driver. Mark actual Rust GPU timer and physical presentation capability pending an in-page or compositor capture; do not change kernel settings. |
| Couch | `node scripts/profile-mirror-rust.mjs capture --config <config.json> --out <ignored-dir>` | Drive a pinned recording through the existing replay adapter; record source/Wasm/glue/cache hashes and effective settings; capture direct markers, `/proc` CPU brackets, optional Chrome trace/phase events, readiness, delivery, errors and visual witness. Enforce unique output directory and cleanup. Speed cells have no profiler or phase flags. |
| Couch | `node scripts/profile-mirror-rust.mjs analyze --run <ignored-dir>` and `… compare --control <dir> --candidate <dir> --off-off <dir> --sequence <json>` | Validate marker/PID/clock/loss joins and workload equality; conserve per-thread CPU with an unresolved bucket; distinguish samples, CPU, GPU execution and actual presentations. Require an interleaved sequence, contemporary off/off variation and the renderer benchmark contract before comparing uninstrumented cells. |
| GSW | `mise exec -- pnpm exec tsx scripts/profile-canvas-rust.mjs probe|capture|analyze` | Own a standalone WebGL2/Wasm fixture for encoder, Rust admission/present and GPU timer probes, with matched source/Wasm/glue. Reuse perf-harness trace-health and `tdur` rules. See GSW `docs/canvas-profiling.md` for options and the standalone runbook. |

### Run the consumer workflow

Create a local config under ignored `.sts2/bench/`. It must pin a `repro/1`
recording, `gswRoot` at the GSW experiment worktree, matching Wasm/glue files
and served URLs, the scene serializer path/URL, resource root and manifest,
asset cache and background fixture, dedicated loopback Vite and asset ports,
effective quality/effects, and benchmark arguments. The capture command starts
a scratch Vite server with GSW source aliases from `gswRoot`; leave both shared
sibling checkouts on `main`. Set `hitReferencePath` and `imageReferencePath`
with their SHA-256s to require semantic hit and decoded pixel equality. Keep
the config and all output in ignored paths.

```sh
node scripts/profile-mirror-rust.mjs probe --config .sts2/bench/canvas-profile/config.json --out .sts2/bench/canvas-profile/probe-1
node scripts/profile-mirror-rust.mjs capture --config .sts2/bench/canvas-profile/config.json --out .sts2/bench/canvas-profile/run-1
node scripts/profile-mirror-rust.mjs analyze --run .sts2/bench/canvas-profile/run-1
```

`probe` writes `capabilities.json` only when `--out` is supplied, as above.

Use `captureMode: "speed"` with `phases: false` for untraced comparison cells.
Leave capture mode unset for a Chrome trace diagnostic; set `phases: true` to
collect the opt-in producer, canvas and Rust operation events. Every capture
gets a new directory and a fresh run ID. An analyzer rejection keeps the raw
receipt, trace, events and images and names each failed gate. A comparison also
needs `--off-off` and a JSON `--sequence` whose `cells` list has chronological
`{ "label": "control|candidate|off-off", "run": "<capture-dir>" }` rows. It
rejects profiler-bearing cells, source or environment drift, output/hit
mismatch, missing physical presentations and invalid benchmark contracts.
Run hardware captures serially under the resource lease; diagnostic trace time
and sampled `/proc` intervals are distinct CPU measurements.

When a separately captured physical display trace is available, store its
sidecar with the capture and pass `analyze --run <dir> --evidence <sidecar.json>`.
Every referenced display or raw-trace artifact must be inside the capture
directory and listed in the sidecar's `artifacts` with a matching SHA-256; the
analyzer rejects paths outside that directory. The sidecar
must bind the same run and raw benchmark hash, identify the content layer and
external compositor PID/start lifetime, and include loss-free
`ActualContentPresentation` events plus paired clock syncs from a first-party
Perfetto FrameTimeline or DRM pageflip trace. The analyzer admits only events
whose full clock-uncertainty interval lies within the direct markers. A browser
promise, rAF, draw completion or screenshot cannot fill this field.

Keep common schema fields stable: `runId`, source/artifact/input hashes, clock domains, browser process identities, direct marker IDs, effective flags, `buildId`/`operationId`, phase start/end, resource and present outcomes, sampling denominator, lost events and qualification failures. GSW owns Rust/Wasm execution phases and GPU queries; Couch owns orchestration and the cross-repo comparison. Luna tests each parser with missing marker, dropped trace, stale PID, nonpositive V8 delta, absent GPU query, output mismatch and async supersession fixtures before any profiler receipt is used to choose product work.

## Measurement ledger: distinct quantities

| Quantity | Preferred source | Interpretation and hard boundary |
| --- | --- | --- |
| Renderer-main CPU and whole renderer-process CPU | Linux Perfetto scheduler slices or `/proc` thread/process CPU brackets; Android Perfetto `sched_switch` | Sum **nonoverlapping scheduler slices** clipped exactly to direct busy markers by PID/TID. `/proc` tick deltas provide coarse lower/upper estimates bounded by samples, with jiffy and bracket uncertainty; never present them as exact marker-clipped CPU. Include all renderer threads and an unresolved bucket. Concurrent CPU can exceed wall time. |
| JavaScript/Rust/native operation attribution | V8 JIT-mapped `perf`, Chrome trace synchronous `tdur`, GSW phase markers/counters | Samples are shares of a declared sample population; `tdur` is thread CPU for a valid synchronous span. Do not sum nested spans or multiply samples by average interval when timestamps are invalid. |
| GPU-process CPU | Perfetto or `/proc` GPU-process TIDs | CPU spent issuing/driving GPU work, never GPU hardware time or utilization. |
| GPU execution | WebGL2 timer queries or supported hardware GPU counters | Hardware command interval on that graphics API. Query availability/disjoint state and readback overhead must be recorded. Driver queues can overlap CPU. |
| Actual content presentations | Android SurfaceFlinger/FrameTimeline and display-layer events; desktop compositor/display evidence where available | Count distinct content updates actually shown. `completedFrames`, `presentCalls`, rAF and encoded patches are separate counters, not presentations. |
| Latency and pacing | Direct recording delivery markers, renderer stage events, queue submit/ack, compositor frame timestamps | Split input/delivery → build/admission → queue wait → GPU completion → visible frame. Promise wall time is not CPU. |

Apply [the renderer benchmark result contract](../renderer-benchmark-contract.md) and its validator to each comparable cell. A `pass` result needs pinned source/artifact/environment/input identity, ready resources, complete delivery, process/thread identity, marker mapping, actual presentation evidence and a visual witness. A diagnostic can be useful when one field is unavailable; label its precise coverage and do not promote it to an end-to-end win. Preserve the strict logical-paint/hit oracle for unchanged-output controls. For a deliberate visual tradeoff, retain full-resolution images, pixel-difference extent, hit differences and an explicit user decision.

## CPU-first profiling path

1. **Freeze the workload and ordinary baseline.** Use the existing quiet and busy recordings, including `final-smoke-cardtrail.ndjson` and its SHA-256 `e730091d…`, the same cache/resource byte manifest, one source head per repository, matching Wasm and JS glue, viewport/DPR, effective quality and effects settings. The established desktop busy window is 12,000–20,195 ms, with direct delivery prefixes 99→429 and eventual full 430; validate the actual boundary hashes, revisions, lateness, readiness, errors and completed draws rather than assuming the recording hash is enough. Desktop Very-low is explicitly a phone-equivalent **diagnostic**; desktop Auto and phone Auto are separate regimes. Keep hardware WebGL2 proof (adapter/vendor/backend; reject SwiftShader when claiming RTX 2060 work). Run ordinary uninstrumented control repeats around any diagnostic and quantify their own variation.
2. **Partition the process, then name the work.** Join Chrome renderer/GPU process identities and thread names to Perfetto or `perf`/`/proc` on the same marker clock. First report all renderer TIDs and an unresolved bucket; qualify scheduler CPU separately from bounded `/proc` tick estimates. Then rank expensive inclusive stacks and **concrete exclusive leaves** in each bucket. The saved 70.6% whole-renderer named-JS result requires native Chromium/driver symbols or a separate native-thread accounting path before a whole-process hotspot decision. Even with that accounting, the 246 inclusive `buildDrawList` samples remain a broad caller until an inner operation is isolated. Keep GC, compositor/raster, Wasm, queue wait and profiler workers separate. Do not assign native samples under a nearby JavaScript caller.
3. **Trace the exact synchronous pipeline.** Couch boundaries: visual/interaction prep, `buildDrawList`, retained composition, text/layout/raster preparation, resource readback and upload decisions, hit/semantic publication. GSW boundaries: `encodeRustScene`/resource and patch encoding, JS→Wasm copies, Rust scene decode/diff/admission, geometry and texture upload, draw/submit, and the resumed portion after the renderer's `scope.pop().await`. Use the same monotonically allocated operation-ID sequence for full builds, retained patches and present-only attempts. Mark each synchronous enter/exit through `finally`; never span the `submissionTail` queue or an `await present()` promise. Keep counters for calls, bytes, resource readiness, accepted/refused/stale outcomes and completed presents. GSW owns Rust phase/counter hooks; Couch cannot infer Rust execution from `engine.present()` wall duration.
4. **Resolve the hottest family.** Once a broad caller is reproducible, use an appropriate narrow tool: V8 source-mapped samples for a JS leaf; Chrome trace `tts` for balanced synchronous calls; Linux `perf` plus Chromium symbols for native threads; uProf counters/IBS for cache, instructions, branch or memory hypotheses; Rust scoped diagnostics for Wasm internals. Measure diagnostic overhead with same-source A/A and stop claiming precise shares if it changes delivery, frame count or presentation. Do not add high-volume per-node stamps to a timed cell. Maintain nonoverlapping exclusive attribution and an explicit residual.
5. **Select and test a control.** Name the repeated operation, its owning module and input-invalidation rule, measured gross opportunity, expected removed bytes/calls/CPU or GPU work, and a switchable default-off path. Test fidelity and recovery first. Then run paired **uninstrumented** control/candidate cells with interleaved controls and a contemporary off/off variation bound. Compare whole renderer CPU, GPU-process CPU, direct GPU time, actual content presentations and latency separately. Confirm a desktop saving independently on the final combined source before asking for a phone checkpoint.

There is no fixed number of diagnostic attempts or one-size-fits-all sampling interval. Choose enough samples and repeated cells to resolve the observed variation; document why the tool can answer the specific question. Stop a **particular** capture when its symbol coverage, clock join, lost events or workload gate fails, then select another tool or repair that capability before another claim. This avoids both an arbitrary campaign limit and unbounded retries of the same invalid capture.

## Tool capability probes and failure modes

| Tool or channel | Probe before trusting it | Use if supported | Known failure or fallback |
| --- | --- | --- | --- |
| Linux `perf` + V8 JIT symbols | Unprivileged event permission; prefer V8's documented `--perf-prof --interpreted-frames-native-stack` and `perf inject --jit`; short hot-JS symbol smoke; PID/TID and `CLOCK_MONOTONIC` join; lost-event count | 99 Hz or justified frequency, user-mode cycles/call stacks across renderer threads; source-map JS, resolve matching Chromium/native build symbols | The prior `--perf-basic-prof-only-functions` attempt resolved named JS in only 70.6% of whole-renderer samples. Stock Chrome native libraries may remain stripped even with V8 JIT symbols. Preserve raw `perf.data`, injected data, JIT map, browser binary build ID, perf version and lost rate. No kernel setting change just to force a result. [V8 Linux perf](https://v8.dev/docs/linux-perf). |
| Chrome `Tracing` + DevTools Performance | Reuse GSW `docs/perf-harness.md` trace-health rules: `Tracing.getCategories`, same PID/TID busy marker pair, `RunTask`/`FunctionCall` and GC `tdur`, `Tracing.tracingComplete.dataLossOccurred`, GPU-process metadata | Visualize call ordering, exclusive nested spans, JS/GC versus browser native tasks, raster/compositor/driver service, synchronization; use GPU-service GL tracing only after effective startup flag and actual `gl*` events are shown | As that harness documents, Chrome `tdur` is a lower bound for attributed thread CPU; lost trace data invalidates totals; GPU-process CPU is not GPU execution. Empty-URL `FunctionCall` can wrap product rAF. Trace categories and JS sampling can add cost. [CDP Tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/), [Chrome Performance](https://developer.chrome.com/docs/devtools/performance/overview). |
| CDP V8 `Profiler` / trace `ProfileChunk` | Reuse Couch `scripts/lib/profile-timing-health.mjs` for sample count, `timeDelta` shape and marker containment; independently pin profile ID/PID/TID and envelope, and count nonpositive deltas | Named JS **unweighted** leaf/caller sample counts if timing fails; timed attribution needs independently validated timestamps and overhead | Existing `chrome-profile-chunk-time-deltas` research records negative deltas in phone and desktop captures, chunk events on another TID and profiler-worker CPU. The existing helper deliberately reports unweighted samples even with valid delta shape. Never call samples CPU-ms merely because the profile is wide. [CDP Profiler](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/). |
| Linux Perfetto scheduler and `linux.perf` | `sched_switch` and process/thread metadata cover both markers; exact PID start identity; no gaps; clock sync | Conserved scheduled CPU by TID, runnable/blocked delay, optional counter samples on same timeline | Trace slices may cross a boundary; intersect them with scheduler time, do not prorate a Chrome `tdur` by wall overlap. Missing CPU frequency or counters stay unavailable. [CPU scheduling](https://perfetto.dev/docs/data-sources/cpu-scheduling), [counter sampling](https://perfetto.dev/docs/quickstart/callstack-sampling). |
| AMD Ryzen uProf | Record host CPU, `AMDuProfCLI` availability, supported events, permission and `perf_event_paranoid` in the **ignored local capability receipt** before attempting a capture. Check IBS prerequisites separately. | Time-based hotspots, retired instructions/cycles, IPC, cache misses, branch or IBS samples **after** a hypothesis; compare event groups without unexamined multiplexing | Counter ratios are hardware/clock/frequency sensitive; IBS and event-based sample counts have different bases. An unavailable PMU, missing symbols, or perturbing driver is a capability result; do not alter kernel settings to obtain a profile. [AMD uProf guide](https://docs.amd.com/r/en-US/68658-uProf-getting-started-guide), [IBS caution](https://docs.amd.com/r/en-US/57368-uProf-user-guide/IBS-Derived-Events). |
| Android Perfetto + CDP | Verify device refresh/thermal/foreground state; `sched_switch`, process starts, FrameTimeline/SurfaceFlinger layer identity, trace loss and direct browser markers; CDP target is the measured page | Renderer/GPU process CPU and runnable wait, actual content presentations and missed frames, Chrome tasks/GC; independently align monotonic and browser clocks | A completed draw or rAF can occur without a physical content presentation. Compositor layer changes and black intervals invalidate output. Use native layer timestamps, not page promises, for FPS. [Perfetto scheduler](https://perfetto.dev/docs/data-sources/cpu-scheduling), [Android GPU/system profiler](https://developer.android.com/agi/sys-trace/system-profiler). |
| Android Simpleperf | Check target APK `profileable` status, shell permission, renderer PID and symbol files; short symbol/lost-event smoke | Renderer-native or GPU-service samples when permitted; sort by TID/DSO/symbol and inspect call graphs | Stock Stable may deny renderer attach; a profileable Chrome Dev/Canary target may work, but stripped `libchrome.so` offsets alone cannot name an operation. Keep those samples unresolved. [Simpleperf](https://developer.android.com/ndk/guides/simpleperf). |
| WebGL2 GPU timer queries | `EXT_disjoint_timer_query_webgl2` on the **actual** Rust WebGL2 context; async query availability; `GPU_DISJOINT_EXT` false; timer overhead A/A | GSW-owned diagnostic brackets around upload/draw/pass groups; report query durations and overlap by frame/operation ID | Unsupported/invalid disjoint query is unavailable. Never block with `gl.finish()` or busy-read query results in timed cells. Timers exclude display queue latency. [Khronos WebGL2 timer extension](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/). |
| External GPU tools | Probe RTX driver/permissions and the target graphics API; verify captured context and real GPU process | Nsight Graphics/Systems, RenderDoc or Spector for shader/draw/batch/texture and driver/API call structure; hardware counters where supported | Frame debuggers, Spector and API interception alter pacing and can hang or fall back to SwiftShader. Use as untimed structural evidence unless an overhead-matched timed mode qualifies. Do not use Vulkan-only results as a WebGL2 win. |
| Android GPU counters/tools | Enumerate actual Perfetto `gpu.counters` / renderstage producer and device IDs; check available layers and trace health | Frequency, busy/stall/cache counters and GPU stage intervals to test a GPU hypothesis | Counter names and access vary by SoC; GPU-process CPU is not hardware time. AGI's OpenGL ES coverage may be counters-only. [Perfetto GPU](https://perfetto.dev/docs/data-sources/gpu), [AGI limits](https://developer.android.com/agi/troubleshooting). |

For allocation/GC hypotheses, use Chrome heap allocation sampling, `MinorGC`/background scavenger slices, retained resource bytes and an A/A profiler-tax check. Heap sampling checkpoints without aligned timestamps can rank source families but cannot yield exact marker-window bytes. For latency hypotheses, include long tasks, runnable delay, blocked state, GPU queue and frame lifecycle. Keep timestamp origin, uncertainty and exclusions in every table.

## Evidence package and review gates

Every run gets a new ignored `.sts2/bench/` directory containing the exact command, source and generated artifact hashes **before and after**, recording and delivered-prefix hashes, resource manifest, browser/OS/GPU/driver/refresh inventory, effective query/settings, process PID/starttime ledger, direct marker receipt, raw traces/profiles, event-loss and symbol-coverage reports, CPU/GPU/presentation receipt, and image or video paths. A screenshot supports final-frame appearance; interval video supports the absence of a transient black frame. Readiness, failed resources, async refusal/recovery, scene revision, completed draws and actual presentation counts are separate. Report marker read non-atomicity and open operations instead of silently settling work at a marker.

An attribution report should show: (1) whole renderer CPU by thread with an unresolved row that exactly reconciles to the measured total; (2) inclusive callers and exclusive leaves with sample denominators and symbol coverage; (3) JS, Wasm/Rust, Chromium native, driver and GC buckets without double counting; (4) GPU-process CPU and hardware GPU time separately; (5) delivery and presentation cadence; (6) diagnostic overhead against uninstrumented A/A; (7) the concrete next operation or a named evidence gap. A profile with 70.6% named-JS whole-renderer coverage can describe JS main, but cannot certify the whole-process bottleneck.

Before integration, Sol supplies source-matched focused TS/Vitest/Rust tests and a reproducible diagnostic receipt; Luna independently checks operation-ID balance, nested/exclusive math, clock joins, symbol and loss gates, output/hit/recovery, and user-visible visual tradeoffs. The coordinator then merges GSW and Couch changes into the experiment branches above, pins the combined artifacts, and runs uninstrumented paired controls. A diagnostic hook stays opt-in and absent from timed cells unless its overhead is measured and explicitly included. The next phone measurement follows the desktop combined saving and uses a fresh, leased, landscape Stable browser with **Auto quality, shaders Off and particles Off**; record the resolved effective quality/effects settings and active refresh, physical presentation evidence, and cleanup restoring device state. No live game window is needed for passive recorded replay.
