# Desktop-first Rust canvas optimization handoff

## Goal and limits

Find an **output-matched reduction in desktop renderer-process CPU for the same
useful work**, beyond contemporary control variation and counter uncertainty.
Use the production Rust WebGL2 replay as the workload. This is a CPU/output
result, not a phone, GPU-execution, physical-content-presentation, or desktop
FPS claim. A desktop improvement in shared code is a phone candidate, not a
guaranteed phone improvement. Keep the phone parked.

This is a renewed desktop CPU/output hypothesis lane. It does not reopen or
qualify the stopped profiler campaign. Astra must approve a desktop candidate
from independent evidence; failed profiler samples cannot supply that
evidence. The separate [WASM caller investigation](handoff-wasm-caller-recovery.md)
may finish before or after this lane unless a reviewed dependency is named.

Do not use the failed `perf` JS→WASM or Nsight samples to choose a hotspot.
They do not split production renderer CPU into JavaScript and WASM. The Sol
Couch worktree's ignored `.sts2/bench/canvas-profile/campaign-readout.md` and
the Rust experiment branch's `docs/agents/handoff-rust-native-profilers.md`
hold the frozen evidence and no-repeat ledger. The earlier ordinary replay's
`couch.draw-root-walk` and retained-composition spans are synchronous wall
time, not attributable CPU. Recheck them only as diagnostic leads.

## Worktrees, owners, and shared resources

- Sol owns measurement harness fixes and one default-off canvas candidate at
  a time. Start dedicated Couch and GSW worktrees from local
  `experiment/rust-text-ink-readback-sep28` (currently `bfa7fca0`) and
  `experiment/rust-webgl-phase-sep28` (currently `e2760120`), respectively.
  Record actual starting heads. Use the setup and safety steps of
  `couch-worktree` with these explicit experiment-branch bases, and run
  `scripts/install-agent-config.sh` in each Couch worktree. Do not change the
  sibling repositories' shared `main` checkouts. Use a scratch Vite config
  whose GSW aliases point at the GSW **worktree**.
- Luna audits from separate clean Couch and GSW worktrees pinned to Sol's
  submitted commits, reading ignored raw artifacts by manifest path. Luna
  does not modify Sol's checkouts. Record all starting and reviewed heads.
  Luna independently checks raw controls, source/served Wasm/glue/resource
  identity, output and hit evidence, process/thread CPU arithmetic, counter
  uncertainty, diff, and the no-repeat ledger. Astra reviews each measurement
  gate and one candidate at a time, then gives one next action.
- Sol owns Couch `scripts/profile-mirror-rust.mjs`, its focused tests, and any
  GSW canvas/Rust code needed for the candidate. The separate WASM-caller lane
  owns only its new profiler tooling and offline artifacts; coordinate before
  touching another lane's file. Agents are not alone in the repositories and
  must not revert each other's edits.
- Serialize **all** desktop benchmark and profiler captures across both lanes
  under `exclusive:bench:desktop` plus browser and port leases via
  `scripts/live-qa-lock.mjs with`; release on every exit path. Choose free
  ports other than 5219/5220. Keep raw output in each worktree's ignored
  `.sts2/bench/`; do not commit images, official assets, Wasm output, or
  captured payloads. No visible game window, Couch `npm run build`, deploy,
  phone, push, or tag.

## First action: make desktop controls comparable

Use the ignored `production-v6-target-control-config.json` in the existing Sol
Couch profiling worktree as the ordinary-clock template and
`production-v6-target-oracle-config.json` only for a separate fixed-clock
pixel/hit oracle. The ordinary control has one validated target-aliased run
(`production-v6-target-c1`): 291 active deliveries, renderer/GPU-process
`/proc` brackets of 4,700/450 ms. **One run cannot establish variation.** The
earlier v5 control pair differed by one served resource request, and a traced
diagnostic changed delivery and resource behavior; neither pair establishes a
speed or profiler-overhead correction.

1. Pin Couch and GSW source heads, served Wasm/glue/serializer and resource
   hashes, recording, viewport/DPR, browser, GPU/backend, quality and effects,
   cache, background, 12–19 s direct busy markers, and full delivery ledger.
   Before the first control, freeze a comparison contract: cell eligibility,
   control/candidate order, treatment of failed cells, useful-output counts,
   CPU uncertainty method, and saving formula. Run serial uninstrumented
   same-source controls with the same fixture using
   `node scripts/profile-mirror-rust.mjs capture --config <config> --out <out>`
   under desktop/browser/port leases. Both paths must be ignored and unique
   per cell. Distinguish
   scheduled from actually delivered messages inside direct markers. Fix any
   resource-request, readiness, delivery, marker-boundary, or process
   identity mismatch **before** estimating variation; a fix starts a new
   named cohort and retains the failed one. Do not rerun until favorable
   counters appear.
2. Keep the existing strict `validateSpeedReceipt` requirement for actual
   physical presentations. If headless runs cannot supply producer-bound
   physical-content evidence, add a separately named **CPU/output comparator**
   with focused tests. It may report process CPU, completed work and output
   equivalence with explicit coverage, but must leave presentation/FPS and GPU
   execution `null`. Never weaken the speed validator or relabel submitted or
   completed frames as displayed content.
3. Quantify control/control variation and `/proc` jiffy and bracket uncertainty
   on the exact ordinary window. Whole-bracket CPU is not exact marker-window
   CPU: bound possible CPU in marker overhang and tick rounding for each cell,
   or leave marker-window CPU unavailable. For fixed replay work, define the
   conservative saving as the lowest valid control CPU lower bound minus the
   highest valid candidate CPU upper bound. For control intervals `[Lᵢ,Uᵢ]`,
   control spread is `max(Uᵢ) − min(Lᵢ)`; saving is `min(control Lᵢ) −
   max(candidate Uⱼ)`. Require saving greater than that spread. The intervals
   already include counter and bracket uncertainty; do not add it again.
   Report renderer-main and other
   renderer TIDs, whole renderer process and GPU-process CPU separately. If
   controls cannot be made comparable, stop candidate selection and ask Astra
   for one next action.

## Diagnostic and candidate gate

After a stable ordinary baseline, use the existing opt-in phase/counter trace
in a **separate** diagnostic run to locate one repeated synchronous operation.
Measure trace overhead against same-source untraced controls. Inclusive phase
totals, promise waits, sampled cycles, and wall spans are not CPU milliseconds.
Before writing a candidate, supply **either** qualified exclusive CPU
attribution **or** a source-demonstrated redundant operation with measured
occurrence counts, a correctness argument for removing it, and a falsifiable
CPU/output experiment. The second route is a hypothesis, not a hotspot claim.
State its owner and invalidation rule, plausible absolute recoverable work per
useful frame, and the result that would falsify the benefit. Astra reviews
that evidence before implementation.
If no operation clears this gate, report the attribution gap; do not pick a
canvas change by intuition.

Implement one Astra-reviewed, default-off candidate at a time. Verify OFF
recovery, source and resource identity, fixed-clock decoded pixels and semantic
hits, then ordinary-clock delivery, completed useful work, errors and output.
For an intended visual difference, retain full-resolution paired images and
diffs for the user's decision. Preserve exact image paths for every visual
claim. Run serial, **uninstrumented** interleaved control/candidate cells,
predeclaring the order and comparison arithmetic. Keep contemporary controls
on both sides. A failed candidate stays failed; a revised experiment needs a
new hypothesis and Astra review, not another draw from the same setup.
Claim a desktop CPU saving only when output and useful work are equivalent,
candidate work is not lower through skipped frames/deliveries, and the observed
conservative process-CPU saving bound exceeds contemporary control spread.
Report GPU-process CPU and workload duration separately; GPU execution and
physical presentations remain unavailable unless independently
qualified. Ask Luna to audit and Astra to review the actual artifacts and give
one next action.

## Verification and integration

Run affected Couch script tests and frontend `npx vue-tsc --noEmit` plus
`npx vitest run`; run affected GSW canvas, perf-harness and Rust tests for any GSW
change. Do not run Couch `npm run build`, which deploys. Commit only complete,
verified reusable changes on lane branches. Retain ignored raw evidence with
hash manifests and a final handoff; it does not merge with Git.

The Rust canvas stage lands independently of a desktop CPU saving. GSW's
renderer and serializer land before the Couch adapter, settings, and serving
path. Once both are on local `main`, freeze a **new** warm-resource oracle and
ordinary-clock control cohort against those exact commits and served artifacts.
The older C1/C2 pair and v12-v14 diagnostics cannot qualify that cohort.
Require equal source, resources, deliveries, useful output, fixed-clock pixels
and hits, and valid process-CPU brackets. A CPU candidate remains default-off
until a separate diagnostic isolates its work and Astra approves the
hypothesis. No candidate may become the Rust default without interleaved,
uninstrumented controls whose conservative saving exceeds contemporary spread
and uncertainty. If none passes, keep the merged stage and report no established
desktop saving. Do not push or tag; retain raw artifacts only in ignored state.

## Copy/paste execution prompt

Continue the desktop-first lane from this handoff after verifying both local
`main` commits. Use separate Sol and Luna worktrees: Sol for measurements and
one scoped implementation, Luna for independent raw/output/CPU review, and
Astra for a candidate hypothesis and evidence review. Freeze a newly named
warm-resource oracle and ordinary-clock controls before selecting a candidate;
fix resource, delivery, identity, and output mismatches first. Use isolated
worktrees and shared desktop/browser/port leases. Preserve the profiler
no-repeat ledger and failed receipts. Implement only a measured default-off
operation with a falsifying test; require fixed-clock pixels/hits and ordinary
output/work equality, then interleaved uninstrumented controls beyond spread
and counter uncertainty. Keep phone, GPU execution, and physical presentation
claims parked. Do not use prohibited ports, a visible game window, push, or tag.
