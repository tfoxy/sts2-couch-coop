# Rust WebGL2 native-profiler continuation

This handoff continues [the Rust profiling campaign](handoff-rust-webgl-profiling.md)
and GSW's `docs/canvas-profiling.md`. Read the ignored
`.sts2/bench/canvas-profile/campaign-readout.md` in the Sol Couch profiling
worktree before interpreting any old capture. The production replay has no
qualified CPU hotspot, GPU execution total, physical-content rate, or speed
claim. The accepted phone text-ink switch improved busy content presentation
rate, but the target remains above 30/s at fresh Auto quality with shaders and
particles Off. Do not lower resolution or animation cadence as the proposed
solution.

## Agent and decision sequence

1. Ask Astra to review the readout and no-repeat ledger **before** selecting a
   profiler sequence or candidate. Astra's initial direction for this round was:
   qualify one useful capture, locate the limiting interval, and implement
   only an operation with a plausible recoverable frame-time saving. An
   unavailable capability is a completed diagnostic, not a reason to relabel
   another metric as GPU time or CPU attribution.
2. Sol owns the profiler qualification, captures, narrow code changes, and
   source/artifact manifests in isolated Couch and GSW worktrees. Luna owns an
   independent no-repeat ledger and audits raw captures, clock/loss joins,
   symbol coverage, output, comparison arithmetic, and source changes. The
   coordinator integrates only verified reusable work into the existing GSW
   experiment branch first, rebuilds and hashes WASM/glue, verifies Couch with
   scratch GSW aliases, then commits Couch's experiment branch.
3. After the profiler leg, and again after any implemented candidate, give
   Astra the hypothesis, ledger entry, exact diff if any, source/WASM/glue
   hashes, raw traces, unresolved samples, image/hit evidence, and control
   variation where a comparison exists. Ask whether the causal claim holds,
   whether to keep/revise/revert, and for **one** next justified action. Fix
   any identified evidence or code defect, then ask Astra to review the
   corrected result and next step again.

The phone stays parked until the combined desktop source confirms a saving
near the existing cumulative 50% renderer-process CPU or directly measured
GPU-execution target. That gate concerns those costs, not a single function,
GPU-process CPU, or submitted frames. A later phone leg needs its own lease,
landscape, fresh Auto, shaders/particles Off, active refresh, and distinct
physical content presentations.

## No-repeat ledger

Before proposing any of these again, cite **new evidence that addresses the
specific rejection**. Preserve an inconclusive result as inconclusive.
Detailed receipts are in the named project-memory note and its ignored artifact
path; the campaign readout supersedes older profiling summaries.

[renderer-optimization-ledger.md](renderer-optimization-ledger.md) is the superset of this table —
it also covers the custom WebGL2/TS canvas stage and Pixi, and gets a row for every attempt across
all three renderers, not just this Rust native-profiler lane.

| Approach already tried | Result and reopen condition |
| --- | --- |
| Text-ink `readFrequently` | Accepted phone busy presentation gain in both ABBA orders, roughly 8–12 to 19–21/s; renderer CPU rose. Keep ON as the current workload baseline. Modest glyph raster differences were user-accepted. `rust-text-ink-phone-sep28`. |
| Compact retained subtree cache | Correctness requalified, then a clean phone ABBA failed: dense actual FPS fell 19.9% and idle GPU-process CPU rose 10.2%. Reopen only after a new profile separates warm preparation, validation, composition, and rebuild costs. `retained-subtree-requalification-sep22`. |
| Pixi present reuse | Only 39/123 quiet-frame batches were certified barrier-clear; 66 mask batches remained unknown. Reopen with a new scene proving a majority of safely isolatable submissions or measured majority direct-instruction CPU. `pixi-present-reuse-gate-sep26`. |
| Rust retained transform patches | The busy control accepted 0/19 plans and kept 17 fallbacks; singular root poses and moving spread blocked it. Later high fallback counts are reason rankings, not savings. Reopen with last committed rendered matrices, safe baseline rules, and measured replacement cost. `rust-retained-transform-override-fallback-sep27`. |
| Rust static pixel-cache omission and hidden hit candidates | Omission's 6.09% CPU point estimate was inside 9.81% control variation; hit skipping was 2.14% worse inside 11.59% variation. Hidden subtree walks still publish semantic and input metadata. Reopen only with a different measured mechanism. `rust-static-cache-desktop-sep28`. |
| Rust flat-plan shortcut and raw-matrix reuse | Flat-plan was 9.36% worse; raw-matrix's 1.84% CPU estimate was inside 2.51% control variation. Both were reverted. Do not rerun for a favorable sample. `rust-static-cache-desktop-sep28`. |
| First ImageData zero-copy | Phone startup CPU 8,140 ms OFF versus 8,194 ms ON, inside 613 ms control spread; work also shifted. Keep OFF; reopen only for a distinct proven recurring copy. `rust-phone-zero-copy-startup-sep28`. |
| rAF/scheduler changes | Faster callback booking did not repeatably raise full-scene FPS and worsened present p95. The 30/s passive cap and a separate Chrome Dev UID cap confused earlier cells. Reopen with the exact production policy and distinct callback, admission, and display counts. `canvas-idle-cadence-attribution`, `rust-phone-authored-cadence-sep27`. |
| Program/uniform cache | Program compiles fell 33→6, but controlled phone FPS and latency regressed. Numeric-uniform reuse reduced status queries but did not improve 17.35 FPS and raised CPU/GPU cost. Reopen with a new measured mechanism, live resource identity, and controlled tabs. `android-mali-webview-profiling`. |
| Glyph batching, background and dirty regions | Glyph layout memo and static background already have positive controls; prior glyph instancing/upload, target-pooling and dirty-region probes did not establish a production-path cost. Reopen only with same-window attributable uploads, allocations, or GPU pass cost on the current Rust path. `canvas-gpu-gates-sep21`, `glyph-blocks-retention-sep06`. |
| JS→WASM `perf` symbol recovery | The first smoke and repaired repeat are exhausted; the separately authorized sole fixed-period capture passed clock/loss but failed WASM leaf (202/219) and caller (4/219) gates. The profiling campaign is closed. Reopen only with new evidence that specifically recovers generated-WASM caller ownership and a newly authorized capture. `js-wasm-symbol-smoke-{1,2}`, `fixed-period-tool-1`. |

## Profile tools on the production replay

The desktop uses AMD Ryzen 5 5500 and NVIDIA RTX 2060; the phone uses Mali.
AMD uProf 5.3 CPU CLI and NVIDIA Nsight Systems/Graphics are installed locally.
The maintainer set `kernel.perf_event_paranoid=0`; verify its current value and
`nsys status -e` at each capture. uProf's separate Power Profiler DKMS signing
error does not prevent its CPU CLI from reporting TBP/EBP/IBS capability.
The current wgpu WebGL2 adapter does not advertise `TIMESTAMP_QUERY`; leave
in-context GPU execution null unless a safe backend query is actually
submitted and read without disjoint. Desktop WebGL extension presence alone
does not satisfy that gate. NVIDIA timing is desktop evidence, not Mali timing.

### September 29 qualification receipts

These are ignored local captures in the Sol Couch profiling worktree under
`.sts2/bench/canvas-profile/`. Luna independently audited the raw files.

| Capture | What it established | What it did not establish |
| --- | --- | --- |
| `nsight-sep29-smoke/` | Nsight wrote a trace; Chromium reported repeated GPU-process launch failures and the replay exited 1. | No workload, marker, Vulkan or GPU-work join. The later successful arm changed both collection scope/mode and trace classes, so the pair does not isolate the cause of the crash. |
| `nsight-sep29-cpu/` | An ordinary 6.992 s direct-marker replay completed with source/workload and PID/start joins. `/proc` process brackets recorded 4,320 ms renderer, 450 ms GPU process, and 30 ms browser CPU. Sampling overhang is 18.726/18.756/18.647 ms respectively, with 1 ms marker-clock and 20 ms jiffy uncertainty. A 25,609,266-byte Nsight report and 229,187,584-byte SQLite export preserve call-chain samples for offline inspection. | The exported profile is unqualified for the busy window; GPU/Vulkan activity, exact profiler loss, and sample-clock uncertainty are unavailable. The `/proc` numbers are bounded process costs, not a function profile. Physical content presentation remains null. |
| `uprof-sep29-symbol/` | A 1 ms TBP smoke resolved 2.010 s to `known_hot_function` in a dedicated test binary. | Renderer symbols, call stacks, and marker joins. |
| `uprof-sep29-replay/` | TBP sampled a completed ordinary replay. Its raw profile, replay receipt, and report are preserved. The stable served glue/serializer hashes differ from local file hashes because Vite transforms source; the WASM bytes match. | The report spans 48.605 s across 185 session threads; this is not whole-renderer coverage. Call stacks were disabled and 3.626/3.628 sampled renderer CPU-seconds are unresolved `[heap]`. Those full-session samples cannot be compared directly with the 5.140 s busy-window `/proc` bracket. Profiler loss, exclusive CPU cost, and overhead are unmeasured. |

The exact raw files are `nsight-sep29-smoke/nsys.nsys-rep`,
`nsight-sep29-smoke/replay/bench.stderr.txt`,
`nsight-sep29-cpu/nsys.nsys-rep`, `nsight-sep29-cpu/nsys.sqlite`,
`nsight-sep29-cpu/replay/receipt.json`,
`uprof-sep29-symbol/report.csv`,
`uprof-sep29-replay/profile/cpu/CpuProfile_Sep-29-2026_06-42-40.caperf`,
`uprof-sep29-replay/profile/report.csv`, and
`uprof-sep29-replay/replay/receipt.json`, and
`uprof-sep29-replay/replay/server-proof.json`. Preserve the failed receipts rather
than treating an empty GPU table or unresolved symbol as zero cost.

Profiler overhead and contemporary control variation are unmeasured; the two
different profiler arms cannot estimate either. The existing `nsys.sqlite`
contains renderer sampling and call-chain rows, including a full-capture libc
copying lead. Their busy-window meaning remains unqualified.

Sol's bounded offline pass is preserved as
`nsight-sep29-cpu/offline-qualification.md`, with exact SQLite queries. The
nominal busy window joins 8,287 renderer samples across 14 TIDs, 7,274 on
renderer main. It has 8,119/8,287 unresolved leaves (97.97%) and
8,242/8,287 unresolved immediate callers (99.46%). The 106 nominal-window
samples in libc `__memcpy_avx_unaligned_erms` are an investigation lead with
mostly unknown callers, not CPU milliseconds or an exclusive canvas operation.
The Nsight UTC-to-system-clock anchor lacks an explicit uncertainty bound;
the OS throttled sampling 273 times, while exact lost samples are unmeasured.
Process/thread start identities come from the replay's `/proc` receipts;
Nsight supplies the PID/TID mapping but does not independently certify process
start identity. No hotspot follows from this pass.

**Current stop gate:** the offline pass cannot establish the clock/loss chain
or owning caller, so stop this profiler leg here. A future capture first needs
a symbol smoke that resolves the relevant generated-code leaf and caller on
the exact browser build, a bounded clock pair, and measured loss. Do not
automatically launch another full capture or implement a canvas candidate.

### Astra's next bounded action after offline review

Sol should qualify the existing V8-aware `perf` path on a tiny ignored
diagnostic page in the **same pinned Chrome binary** before another combat
capture. Pin its binary hash, prior JIT-export/`perf inject` commands and
generated-code artifacts. Exercise a named JavaScript caller and named,
non-inlined WebAssembly functions in separate known intervals for about 10 s,
scoped to the renderer and its threads. Keep raw perf loss/throttle records,
PID/TID start receipts, paired page/collector clocks, and process CPU
brackets. Decode exclusive leaves and inclusive caller chains with an explicit
unresolved bucket. Luna audits the names, interval joins and denominators.

Qualify this *tool capability only* if at least 95% of workload leaf samples
and 90% of expected caller-chain samples resolve, marker-clock uncertainty is
bounded, loss is measured zero, throttling is absent, and sampled activity
plausibly reconciles with process CPU. Allow one configuration repair and one
repeat. If JS or WASM remains predominantly anonymous, stop and identify
whether JIT metadata, WASM names/debug info, unwinding, clock or loss is the
failure. A successful smoke permits a later targeted production capture; it
does not establish a combat hotspot or saving. Do not substitute uProf's
native C smoke for this generated-code qualification.

Use the committed Couch `experiment/rust-text-ink-readback-sep28` and GSW
`experiment/rust-webgl-phase-sep28` branches. Reuse the ignored production-v6
ordinary-clock configuration and its source aliases, 12–19 s busy markers,
recording, resource manifest, diagnostic-clock pixel oracle, and hit grid.
Pin the exact revisions, served WASM/glue/serializer bytes, quality/effects,
viewport/DPR, browser binary, GPU/driver and ANGLE backend. Do not force
ANGLE OpenGL to make a profiler attach: it would measure another backend.
The September 29 desktop profiler captures used **very-low** quality at
1920×1080, DPR 1, shaders/particles Off. They are not fresh-Auto phone runs.

1. **Preserve the completed Nsight offline pass.** The receipt above records
   its nominal sample join and failed clock, loss and symbol gates. Do not
   rerun the same query hoping for an attributable `memcpy` caller.
2. **Qualify generated-code symbols before a new combat capture.** Run the
   bounded smoke above. A renderer-bound
   uProf call-stack capture would need an exact-browser smoke resolving the
   generated-code leaf and caller, a validated monotonic/page clock bridge,
   PID/start identity, measured loss, and output-equivalent ordinary replay.
   If GPU work instead becomes the question, require a source-bound actual
   graphics context and valid hardware interval. Stripped Chrome and failed
   V8 sample clocks remain unresolved, not zero.
3. **Reconcile a causal frame path.** Report renderer-main and other renderer
   TIDs, GPU-process/driver CPU, hardware GPU work, queue or scheduling waits,
   and presentation separately. CPU and GPU can overlap. Count inclusive
   callers separately from exclusive leaves; show every unresolved sample and
   thread. The 3,152.3 ms draw-root-walk and 2,256.4 ms retained-composition
   totals in the earlier diagnostic are synchronous wall, not CPU attribution.
   A submitted frame or Wayland feedback without a producer content token is
   not a distinct physical content presentation.

### Bounded symbol smoke outcome (September 29)

The single JS→WASM smoke and its one repaired repeat are complete in the Sol
Couch worktree's ignored `.sts2/bench/canvas-profile/js-wasm-symbol-smoke-{1,2}/`.
The repeat's `QUALIFICATION.md`, `analysis.json`, raw `perf.data`, injected
profile, event records, and receipts are the review source. Luna audited the
raw files; Astra accepted the corrected report as an **unqualified diagnostic**.

- Attempt 1 failed with 108 sampling throttles, unnamed JS leaves, only 408/462
  named WASM leaves, and no recovered WASM caller chains.
- The single combined repair changed renderer attachment, frame-pointer
  unwinding, sample frequency, JS source/naming, and loop clock-check frequency.
  It recovered conditional JS leaf and all-phase caller coverage at 227/235
  (96.60%) and WASM at 217/228 (95.18%). The combined changes do not isolate
  which setting recovered symbols or prove production coverage.
- Attempt 2 still has 16 throttle records, including both workload phases.
  Raw LOST records are zero, but missed sampling opportunity from throttling is
  unknown. Full timing qualification is unverified because the expanded page
  clock bound assumes timestamp error and a common monotonic rate not proved
  independently. Per-thread CPU receipts duplicate process counters; only the
  4.50 s renderer-process user-CPU bracket in each phase is usable for coarse
  activity reconciliation. The wrapper's exit 1 is a perf-stop bookkeeping
  defect despite a readable capture.

**Stop:** the repair and repeat allowance is exhausted. Do not run another
symbol smoke, combat capture, or canvas candidate from these results. Astra's
one next action is an **offline event-ID-aware audit** of attempt 2's existing
`perf.data`: join THROTTLE/UNTHROTTLE records to renderer TIDs and nearby sample
periods, test whether adaptive-period startup could explain bursts, and report
unmatched events and uncertainty. Preserve the no-go verdict.

### Fixed-period tool qualification outcome (September 29)

The offline audit of attempt 2 is preserved in
`js-wasm-symbol-smoke-2/event-id-audit.md`. It found 541 samples, 16 THROTTLE,
15 UNTHROTTLE, and zero LOST records. Fifteen throttle pairs joined by event ID,
stream ID, PID, and TID; one inherited-thread throttle remained unmatched.
Nearby short sample periods are a clue, not a cause: those samples lack event ID
and CPU. The original smoke and its one repeat remain exhausted.

The user's renewed authorization allowed one newly designed fixed-period
qualification capture, after a trace-only clock preflight. Ignored
`trace-clock-preflight-1/` preserves the failed identity receipt, the receipt
without a post-edge clock sync, the final raw trace, and the source-chain
review. The final trace had 37 unique clock-sync joins inside native monotonic
brackets, stable renderer phase markers, and no reported trace loss. Same-source
untraced–traced–untraced work and CPU stayed within the observed control range.
The exact browser-version source chain plus runtime brackets qualified the
clock method for that pinned Linux configuration, with a disclosed binary
provenance assumption. This qualified timing method alone establishes no
production cost.

The **sole** `fixed-period-tool-1/` capture recorded 439 renderer-main
`cycles:u` samples at an actual period of 86 million cycles each. Raw LOST,
THROTTLE, and UNTHROTTLE counts were zero; 39 clock-sync joins and phase
markers passed, with no reported trace loss. JS named leaves were 214/220
(97.27%) and expected callers 217/220 (98.64%). WASM named leaves were
202/219 (92.24%, below the 95% gate), and expected callers only 4/219
(1.83%, below the 90% gate). The named leaf-plus-caller intersection was
214/220 for JS and 4/219 for WASM. The WASM denominator includes 13 unknown
leaves, four other named leaves, and 198 named leaves without the expected
caller. The wrapper also exited 1 after its perf-stop SIGINT despite a readable
raw capture; that bookkeeping failure is preserved. Process and main-thread
`/proc` CPU brackets were about 4.5 seconds per phase; sampled cycle totals
are not CPU milliseconds or an exclusive production cost.

**Stop this profiling campaign.** The new capture has no repair or repeat
allowance. Its WASM leaf and caller gates failed, so it does not qualify a
combat capture, hotspot, canvas candidate, or speed claim. Astra reviewed the
raw artifacts and recommended ending the campaign without a profiler
substitution or another capture. The phone remains parked; GPU execution and
physical content presentation remain unmeasured.

## Candidate and comparison gate

Before Sol implements a control, name the exclusive operation, its measured
share of the *limiting interval*, expected absolute milliseconds recoverable
per useful frame, owner, invalidation rule, and a result that would falsify the
hypothesis. If no operation clears this gate, report the attribution gap and
stop candidate work. Do not choose a control from an inclusive caller or a
gross wall sum.

Keep a justified candidate default-off and verify recovery, fixed-clock
pixels/hits, and ordinary-clock delivery/output. If a visible change is
intentional, save full-resolution paired images and diffs for the user's
decision. Run serial, leased, uninstrumented interleaved controls and
candidates on the combined source. Report renderer CPU, GPU-process CPU,
direct GPU time if available, workload duration, and distinct physical
content presentations as separate quantities, with contemporary control
variation and profiler overhead. A desktop speed claim requires equivalent
useful output and a saving beyond variation and counter uncertainty. Missing
display identity keeps end-to-end presentation claims null; retain the raw
diagnostic and continue only with qualified internal cost claims.

Keep shared Couch, GSW and spirectl `main` clean. Use scratch GSW aliases,
ignored artifacts, serial captures and resource leases. Do not run Couch
`npm run build`, deploy, push, tag, use ports 5219/5220, or open a visible
game window. Run only affected Couch script/frontend and GSW canvas,
perf-harness and Rust suites before committing completed reusable code.
