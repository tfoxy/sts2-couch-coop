# Host CPU follow-up

Prepared 2026-09-25. This is a handoff for a bounded CPU investigation, not authorization to restart the
previous multi-day measurement campaign. No further implementation or game launch was done for this handoff.

For the separately requested search for engine/renderer observation, see
[Replace scene polling](handoff-scene-observer.md). That investigation has a conditional allowance for one
or two additional frames, strictly under 50 ms added latency, in exchange for significant CPU savings;
the user must review the result before a runtime merge. The polling-cache trial below retains its existing
no-added-latency scope and is not a prerequisite for starting that separate research.

## Objective and boundaries

Find a substantial reduction in CPU consumed by the host game and its headless seats during active streaming.
Preserve input latency, including the first input after idle, visual quality, and capture/update frequency.
Do not change static-background or Spine image baking. Do not lengthen polling intervals, batch inputs,
relax sleeps, or reduce headless frame limits as an optimization.

The user's stop direction is that a CPU improvement below 10% is not worth continuing this campaign.
Use **10% relative reduction in combined host-plus-seat CPU** as the working interpretation; report both
relative change and CPU percentage points so the denominator is explicit. Keep per-process results too.
An allocation reduction or a faster helper alone does not meet this target.

Zero-viewer dormancy remains a correctness requirement: no scene observation without streaming viewers.
Preserve detached headless peers during an active multiplayer run and their necessary network supervision.
The listener must remain available. Existing lobby join readiness is not permission to restart permanent
background scene observation.

Use Sol or lower agents in isolated worktrees from current local main, at most three workers plus coordinator.
Keep sibling repositories on clean main, install agent configuration in every worktree, and build only to
scratch. Commit coherent verified work; never push or tag. Follow the live lock/deploy skills for any game.
Use headless gamescope for rendered checks, never Xvfb or an unapproved desktop window.

## What already landed

| Repository | Commit | Change |
| --- | --- | --- |
| Couch | `6ef11725` | Demand-driven host supervision/discovery; dormant host input and visual-rescan timers; runtime dependency pin |
| Couch | `728b844f` | Prefix-preserving HTTP reads, one-pass scene serialization, bounded pooled incoming UTF-8 |
| Couch | `0f242f09` | Project references honor `CouchCoopSpirectlRoot` for isolated integration |
| Spirectl | `beec281f` | Late subscribers reliably receive their own full keyframe |
| Spirectl | `386c7ed6` | Tick-demand leases, immediate queued-work drain, synthetic-seat demand, subscriber-scoped scene cleanup |

Refresh these against current main before starting; do not reapply the old aggregate candidates.
The dormant dispatcher retains its existing 10 ms timer while consumers exist. Posted work independently
wakes the main thread immediately. Host input-guard activation shares that FIFO: a separate deferred callback
can run too late if an already-scheduled drain consumes first input before the guard repairs the root window.

These changes passed the executable suites, actual Godot scheduling fixtures, and a bounded private-game
host-mirror check: timers stopped before connection, active during connection, and stopped after closure;
real input reached the game, and reconnect received a fresh full keyframe. That last check did **not** exercise
a detached multiplayer seat, establish unmodded-level CPU, or measure a latency distribution.
No CPU improvement percentage was established. Local receipts: `.sts2/research/host-perf-20260925-landing/`.

## Start with active node reads, not another observer framework

The scene watcher already caches topology. In Spirectl's
`bridge-mod/src/Spirectl.Sts2/Live/Sts2RuntimeSceneWatcher.cs`, `Capture` calls `Reconcile` on
`_structureDirty || full`; ordinary incremental captures iterate the cached `_ordered` list.
It does **not** recursively call `GetChildren()` across the whole tree on every incremental capture.

The remaining repeated work is reading tracked nodes' changing values, comparing signatures, constructing
snapshots, and producing deltas. Measure that fraction before trying to replace traversal. If profiling shows
frequent structural invalidation, distinguish reconciliation cost from the ordinary per-node scan.

The first concrete candidate is the retained polling-cache implementation. It aims to:

- Cache native-class read plans per tracked node and text accessor plans per managed type.
- Read control fields currently emitted only with the static block when emitting that block, including
  full frames and late first appearances. These fields need not be intrinsically immutable.
- Reuse immutable text snapshots after freshly reading and comparing their current values.
- Reuse texture-reference snapshots while still checking resource identity and mutable metadata.

This still polls mutable values at the existing cadence. It is a candidate for reducing interop, reflection,
and allocation work, **not** an implemented observer or a demonstrated 10% CPU saving.

### Recover the candidate safely

Retained Spirectl commit: `c67569bd`; earlier focused polling commits: `248af92f` / `57c3c37e`.
The retained checkout was `../host-perf-20260924/candidate/spirectl` relative to the Couch checkout.
Git objects are the durable source if that worktree has been removed.

At the handoff revisions, comparing Spirectl `386c7ed6` with `c67569bd` identifies four files:

1. `bridge-mod/src/Spirectl.Sts2/Common/Sts2RuntimeSceneTextDiagnostics.cs`
2. `bridge-mod/src/Spirectl.Sts2/Live/Sts2RuntimeSceneWatcher.cs`
3. `bridge-mod/tests/Spirectl.BridgeMod.Tests/Sts2PollingReadCacheTests.cs`
4. `bridge-mod/tests/Spirectl.BridgeMod.Tests/Sts2TextDiagnosticsTestDoubles.cs`

**Do not cherry-pick the aggregate C6 commit or replace the whole watcher.** Its lifecycle/admission code is
older than main's extracted fixes. Port only the read-plan, static-field, text, and texture-cache changes;
preserve current subscription generations, admitted recipients, full-request versions, and cleanup.
Read-plan helpers in the candidate include `NodeReadPlan`; use symbol-level review rather than old line numbers.

Tests must cover same-size text changes, themes and outlines, resource replacement with identical metadata,
texture path/name changes, atlas region/margin changes, script-attached native texture nodes, reparenting,
destruction, late first emission, and full-keyframe replay. Do not retain Godot resources merely to compare
their identity. Keep change signatures and observation revisions identical.

## A short decision path

1. Establish a **current-main active-seat baseline**, with exact executable/mod fingerprints, settings, and
   process identities. Start with one stable combat and one seat. Include the host and every seat in CPU totals;
   report browser/compositor CPU separately. Existing helpers and private workloads are listed in the local
   companion handoff. Do not use historical C6 measurements as a current baseline.
2. Use a brief working profiler to establish the fraction spent in the targeted capture/read/signature work.
   The embedded `CouchCoop.Spirectl` runtime and the separate QA bridge are different copies: profiling the
   bridge's own watcher does not automatically measure the browser producer. Its embedded instrumentation is
   normally a no-op. Do not build a new profiler to overcome this during the first pass.
3. Check the upper bound: if the target accounts for fraction `f` of total CPU and the change removes fraction
   `r` of that cost, the approximate overall saving is `f * r`. If even an optimistic result cannot reach the
   target, stop this direction. A synthetic text-allocation result is not a CPU fraction.
4. If the target is large enough, extract that one candidate into a current-main worktree. Compare a small
   interleaved baseline/candidate workload using existing tools. Freeze scene/settings, capture cadence, seats,
   and build identity. Do not combine this with renderer experiments or bake changes.
5. If there is a clear material saving, verify three seats and the affected correctness paths. If the result
   is below 10%, noisy/inconclusive, or mostly outside this code, report it and stop rather than expanding the
   campaign. Prefer a useful on/off trial to hours of new instrumentation. Suggested initial investigation
   timebox: one hour to a go/no-go result; do not treat a handoff as resetting any existing tooling budget.

Only if the existing cache trial/profile justifies it, consider a second bounded change: skip hidden subtrees
with precomputed subtree end indices instead of stepping through every hidden descendant. `_ordered` already
skips their expensive reads; this would save loop overhead only. Preserve visibility re-entry, reparenting,
overlay sentinels, and first emissions. There is no measured reason yet to expect a 10% overall gain here.

## Why a complete native observer is not the next default step

The opt-in experiment is in Spirectl `experiments/native-scene-invalidation/`. It exercises two interception
families, dirty queues, and restoration **in a generated fixture**. No safe exact-build targets were recovered
for the installed game, and no game poller was connected to its shadow oracle. It has not replaced polling.

The remaining work includes actual target resolution, concurrent teardown, parent/subtree dependencies,
resource fan-out, identity reuse, and same-capture coverage of engine-driven mutations. See that directory's
README before assigning any native work. Successful loader or fixture tests are not game coverage.
Do not convert this CPU follow-up into an open-ended hook project. Unknown builds must remain untouched,
and no installed executable may be modified or redistributed.

OS priority is also not an established CPU target. Existing Linux samples did not show lower configured
priority for seats. Windows/macOS probes remain disabled and unverified in the game; the experiments under
`experiments/seat-scheduling/` are not a shipped remedy. Raising scheduling priority is not a reduction in work.

## Verification and delivery

- Run Spirectl `bridge-tests` **alone**, plus the live-host compilation/tests for changed readers. Pass the
  configured `game.assembliesDir`; use scratch outputs. Run Couch's Mod and MirrorProtocol **executable** runners
  once on the integrated candidate (`dotnet test` is a no-op for those suites).
- Check exact scene/keyframe equivalence for the relevant text/texture/layout mutations. Test repeated
  `0→1→0` viewers, late subscribe/reconnect, and detached active-run peers; preserve dormant timers and callbacks.
- Use the existing real-input/causal latency harness for ordinary and first-after-idle inputs. An unrelated
  scene delta, DOM mutation, ping, or successful input-result is not an input-to-visible latency witness.
  Do not trade a CPU gain for worse p50/p95/p99/worst latency, lower cadence, or missing updates. A functional
  hover alone cannot establish latency equivalence. If valid evidence cannot be obtained with existing tools,
  report that limit; do not silently weaken the input requirement or build another measurement framework.
- Keep game-derived traces, source findings, screenshots, and measurements local. Report concrete artifact
  paths, total and per-process CPU, settings, source/build identity, correctness results, and limitations.
- End with either one verified coherent optimization, or a concise no-go explaining why the 10% target was
  not demonstrated. Do not count already-landed lifecycle fixes or new test infrastructure as a new CPU win.

The machine-local continuation file is `.sts2/research/host-perf-20260925-landing/cpu-followup-handoff.md`.
It indexes the preserved workloads and receipts without committing game-derived evidence.
