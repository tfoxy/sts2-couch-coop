# Replace scene polling: renderer and invalidation research

Prepared 2026-09-25 at the user's explicit request. This is a separate investigation from
[making the existing polling loop cheaper](handoff-host-cpu.md). Search for information the engine already
has about changed nodes, including renderer state and hookable update paths. Do not assume the previous
two-hook prototype is the only possible design.

This handoff contains a source review, not a working observer. No game was launched, executable patched,
runtime changed, or performance measurement taken while preparing it.

## User authorization and merge boundary

- A significant CPU improvement may justify **one or two additional frames of visible latency, strictly
  less than 50 ms of added end-to-end latency compared with baseline**. This is not a 50 ms total-latency
  target, and not a separate 50 ms allowance for each pipeline stage.
- The millisecond limit wins over the frame count. Two frames at 30 Hz exceed it; even one frame at an
  idle headless frame rate may exceed it. Include first input after idle and after reconnect.
- Keep input admission, ordering, and dispatch immediate. Investigate bounded observation/capture timing,
  not input batching, slower input polling, or relaxed game sleeps. The allowance does not authorize a
  lower update frequency, reduced visual quality, lost transient states, or static-background/Spine bake work.
- Use the previous 10% relative combined host-plus-seat CPU target as the working meaning of significant;
  show absolute CPU and per-process figures too. Do not present this interpretation as a guaranteed saving.
- **Report the proposed tradeoff to the user before merging any observer/runtime candidate into main.**
  Finish the investigation with a reviewable branch, diff, results, and recommendation, then stop for the
  user's decision. Do not report and auto-merge in the same turn. Default commit-on-completion applies to
  verified work on the experiment branch; it does not override this runtime merge boundary.
- With zero streaming viewers, detach scene/native observation completely. Retained multiplayer seats
  keep only the required gameplay/network supervision. No permanently installed hot hook with merely an
  early-return guard should be described as zero observation overhead.

This conditional observer allowance supersedes the earlier blanket no-added-latency requirement **for this
investigation only**. It does not retroactively establish latency evidence for already-landed work or relax
the separate polling-cache handoff by default.

## Starting point

Read the CPU handoff's landed-commit table and refresh current local main. Spirectl `386c7ed6` already parks
observers when unused; Couch `6ef11725` connects host service demand. Preserve those lifecycle fixes.
The current watcher caches topology and scans `_ordered` nodes during ordinary captures; `Reconcile` runs
on structural dirtiness or a full keyframe. The target is recurring property reads/signatures over tracked
nodes, not an unconditional recursive topology traversal on every tick.

Prefer keeping the current scene protocol and snapshot builder. A new source should identify candidate
dirty nodes/fields, then reuse current reads and comparisons for those candidates. A renderer invalidation
is not proof that a serialized field changed: conservative extra candidates are acceptable if cheap, but
missed changes are not. Send a delta only after establishing its actual changed fields.

Reusable engine observation belongs in Spirectl. Couch owns streaming demand and viewer behavior.
Keep any browser presentation changes in godot-scene-web; do not change protocol or switch to pixel/video
streaming as an unannounced substitute for identifying changed nodes.

## Source map: promising seams and their limits

The following was reviewed in upstream Godot **4.5.1 stable**, not proven against the installed game's ABI.
Paths below are relative to that engine source tree; line numbers are only navigation aids. Engine version
and exact game executable must be rechecked before any private interception.

| Source / seam | Information it may provide | What must not be assumed |
| --- | --- | --- |
| `scene/main/canvas_item.cpp:452` — `queue_redraw`; `:133` — deferred redraw callback | A coalesced content-redraw request, with an originating CanvasItem | Redraw is not every mutation. The public `draw` signal is visible-only; pure transforms, modulation and ordering can bypass it. Capture must occur after relevant state is ready. |
| `scene/main/canvas_item.cpp:1034`; `scene/main/scene_tree.cpp:193` — transform invalidation and flush | Engine propagation and a queue of transform notifications | Notification collection is opt-in, transform-only, and delivered to the node's own implementation. It is not a universal connectable changed signal. |
| `servers/rendering/renderer_canvas_cull.cpp:613` onward; `rendering_server_default.h:939` onward — canvas setters | RID-keyed writes for visibility, transforms, modulation, ordering and related canvas state | These are mutation entry points, not a ready-made complete dirty queue. Setters may repeat unchanged values and omit scene/interaction metadata. |
| `renderer_canvas_cull.cpp:2493` — `_item_update_list` | Dependency/material maintenance | This is **not** a list of all changed canvas items; transform/visibility/modulation/text coverage is incomplete. |
| `renderer_canvas_cull.cpp:629` and `:2690` — interpolation transform lists | Current/previous transform RIDs used for interpolation | They depend on global and item interpolation being enabled. Do not enable interpolation just to manufacture an observer. |
| `scene/main/canvas_item.cpp:1458`; `scene/gui/control.cpp:3894` onward — public signals | Draw, rectangle, visibility, resize, theme, hover/focus and structural hints | Signal coverage is incomplete. Local transform notifications do not cover parent motion; camera/canvas changes are separate. |
| `scene/resources/material.cpp:448`; `doc/classes/ShaderMaterial.xml:9`; `doc/classes/Resource.xml:73` | Resource changes and direct shader-parameter writes | `Resource.changed` is not universally emitted. Shader parameter mutation can reach RenderingServer without that signal. Shared resources affect multiple nodes. |
| `doc/classes/RenderingServer.xml:4457` — frame signals; `:1775` — `has_changed` | Potential synchronization boundaries and a global changed flag | Neither identifies nodes. A global dirty bit followed by a full scan has not replaced per-node polling. |

Additional pointers: Control interaction-only setters at `scene/gui/control.cpp:1888` and `:2232`;
camera/viewport canvas transforms at `scene/main/viewport.cpp:1228`; canvas-layer transforms at
`scene/main/canvas_layer.cpp:78`; notification delivery at `core/object/object.cpp:928`.
Node-to-canvas-RID access is in `scene/main/canvas_item.h:354`; do not assume a general inverse RID-to-node API.

### Headless is a first-class target

`servers/rendering/rendering_server_default.cpp:219` still constructs canvas culling infrastructure, but
the dummy canvas renderer in `servers/rendering/dummy/rasterizer_canvas_dummy.h` does no drawing.
`main/main.cpp:4817` onward can skip RenderingServer draw work when presentation is not required.
Dirty-item maintenance reached from draw (`rendering_server_default.cpp:68`) therefore is not a dependable
headless callback. Command synchronization (`rendering_server_default.cpp:410`) is a different boundary.

Prove that a proposed source executes in the actual `--headless` seat with no rendering output. Do not turn
on a renderer, force draws, or raise seat frame rates to make its dirty list available; that can erase the
CPU benefit and changes the baseline. A useful rendered-host-only result is a narrower result to report,
not proof of a solution for the host machine's headless seats.

## Search multiple approaches before choosing a prototype

Use Sol or lower agents in worktrees from current local main, at most three workers plus a coordinator.
Install agent configuration in every worktree, keep sibling main checkouts clean, and direct builds to scratch.
Avoid overlapping watcher edits. A useful first division is:

1. **Renderer/update-state route:** trace setter and dependency lifetimes through RenderingServer, canvas
   culling/storage, command synchronization and the dummy backend. Look for existing dirty bits, revisions,
   object IDs, update queues, or dependency callbacks that can be exposed or intercepted without a full scan.
2. **Scene/resource route:** combine supported structural/rectangle/theme/resource signals with redraw and
   transform invalidation. Evaluate any supported attachment path to existing nodes before private hooks.
   As a separate hypothesis, test whether an owned helper/proxy node can observe inherited transforms where
   direct notification subscription is unavailable. Prove registration works in the mod and measure the extra
   nodes/callbacks; reject layout, input, rendering or exported-scene side effects. Do not replace game scripts.
   Managed wrapper/Harmony interception must be checked for native-to-native bypass; intercepting a C# API
   call alone is not evidence that engine animation/layout changes are observed.
3. **Coverage/measurement review:** enumerate the actual scene DTO fields and dependencies read by the current
   watcher. Establish which route covers each field, how its native identity maps to tracked nodes, when it
   becomes visible to capture, and how to reuse the existing oracle and CPU/input tools.

The coordinator should compare a small capability matrix before selecting one bounded prototype. Include
supported extension APIs, engine-side invalidation/dependency hooks, and a hybrid dirty-set design. If a narrow
set of interaction or active-animation fields still needs polling, quantify and label that residual polling;
do not claim complete observer coverage. Polling an equally large native table each frame merely moves work.

A custom Godot build may expose internal lists in a **fixture** to test their semantics. It is not a deployment
solution unless the same information can be obtained safely from the unchanged installed game. Do not start
by building a general detour framework, adding many game-specific hooks, or expanding an incomplete seam
into an unbounded reverse-engineering project.

## Required observer contract

- Maintain generation-safe node, RID, resource, and parent/viewport dependency mappings. A material or texture
  may affect many nodes; a parent/camera change may affect descendants even without child-local writes.
  Account for top-level items, canvas layers, reparenting, destruction, RID reuse and resource replacement.
- Identify changes to content **and** transforms, visibility, modulation, clipping, ordering, geometry,
  text/theme, textures/atlases, shaders, particles, animation state and any interaction fields used by the wire.
  Renderer dirtiness alone cannot prove mouse filtering or focus-related metadata is unchanged.
- Time-driven shaders, particles and animations may advance without fresh property writes. Determine what
  the existing browser animation protocol already represents; otherwise retain an explicit active set or
  another proven source. No dirty setters is not proof of a static picture.
- Hooks should enqueue bounded value records/IDs, with clear thread ownership. Do not call scene APIs from
  render threads, block the input path, or retain unsafe native pointers for later use. Handle deferred command
  execution, reentrant mutations and teardown with callbacks in flight.
- A bounded dirty queue may coalesce redundant writes. Overflow, unknown identity, or loss of coverage must
  force a full capture/fallback, never silent stale state. Record fallback frequency and cost.
- Define capture's exact phase and revision boundary. A frame signal that runs before deferred layout/redraw
  completion can yield stale reads; one that waits for a nonexistent headless draw can stall forever.
  Bound extra delay in milliseconds as well as frames, with immediate wake when there is pending work.
- Detach at the final streaming subscriber, clear retained state safely, reject delayed old-generation work,
  and rebuild mappings with a fresh full keyframe on resubscription. Detached network peers are not viewers.

## Private-hook feasibility and the earlier experiment

Spirectl `experiments/native-scene-invalidation/README.md` documents the retained RenderingServer/redraw
prototype. Its generated host verifies some queue, fingerprint and restoration mechanics. No safely resolved
actual-game targets, connected game shadow oracle, complete dependency graph, or concurrent game teardown
were established. Reuse useful pieces, but do not mistake that fixture for an almost-shippable observer.

For private interception, recognize an exact executable/build fingerprint and validate each target, layout,
calling convention, instruction patch and threading assumption before writes. Unknown builds fall back
untouched to current polling. Reversibility includes callback quiescence, not just restoring bytes.
Never modify or redistribute the installed executable. Keep game-derived addresses, private symbols,
source reconstructions and captured data in local ignored research, not committed documentation/code.
Any enabled platform needs its own actual-game evidence; unsupported platforms stay on the existing path.

## Prove coverage, then measure benefit

Start in shadow mode: the current poller remains authoritative while the candidate records dirty events.
For every reference-visible node/field change, record the reference revision/frame, candidate dirty reason,
affected-node closure, capture time and eligible presentation. Every relevant change must be covered within
the declared delay. Compare reference-observed timelines rather than only final snapshots: an A→B→A
transient can disappear entirely if a later dirty-set flush merely rereads A. If baseline presents B and
then A, the candidate must preserve both in order within its allowance. Check omissions, late changes
and incorrect removals.

The poller is a sampled oracle: it can itself miss a transient entirely between captures. In scripted
fixtures, also retain an independently timed mutation record to expose dirty-source misses and the oracle's
blind spots. Distinguish detecting those mutations from requiring presentation of states the baseline never
shows; do not claim complete transient coverage from poller parity alone.

Exercise parent motion with unchanged local transforms, camera/canvas-layer movement, layout, same-size text,
theme updates, visibility/modulation/z-order, clipping, shared shader/material changes, texture replacement and
atlas mutation, particles, reparent/free/recreate, initial keyframes, late subscribers and reconnect. Include
engine-driven changes without browser input, hidden-to-visible nodes and both rendered and headless processes.

Shadow mode runs both paths and adds overhead. Use it to establish coverage; it cannot establish production
CPU savings. After coverage passes, compare a candidate-authoritative, reversible branch mode with current
main using short interleaved equivalent workloads and existing tools. Include one and three active seats,
idle/first-return behavior and zero-viewer teardown. Record exact sources, executable/assembly fingerprints,
settings, process identities, dirty fraction, full-fallback frequency, allocations and total/per-process CPU.

Measure causal input-to-visible latency with the existing real-input harness. Report baseline and candidate
p50/p95/p99/worst, added milliseconds, frame counts, first-after-idle and reconnect cases, sample counts and
uncertainty. Use paired causal events where possible or closely matched interleaved trials; subtracting
unpaired percentile summaries is not a distribution of added latency. Explain the bound on introduced queue,
deferred-phase and fallback delay, including slow/idle frames; an observed maximum alone is not a universal
upper bound. A ping, arbitrary next delta, DOM mutation or input-result is not a presentation witness. Observe
the **added** <50 ms limit end to end; a fast hook callback alone does not establish it. Preserve immediate
input ordering and distinguish discovery, snapshot, queue and browser presentation delay.

Do not spend another multi-day cycle building measurement infrastructure. Produce an initial ranked
feasibility report with a small source-backed matrix, then one bounded prototype if justified. Stop a route
when headless execution, safe identity/targets, meaningful CPU headroom, coverage or latency cannot be shown;
record the negative result and whether another already-identified route is worth a separate attempt.

## Report to the user and stop before runtime merge

Provide the exact branch/diff and a recommendation that states:

1. Which polling work was removed, which remains, and which platforms/backends were actually tested.
2. Combined and per-process CPU savings, workload identity, and whether they meet the significant-gain target.
3. Coverage failures or limits, fallback rate/cost, visual/interaction correctness, and zero-viewer teardown.
4. Added latency in frames and milliseconds, its distribution and worst observation, including first input.
5. Hook/versioning/teardown risks, practical fallback/disable behavior, and concrete local evidence paths.

Leave runtime changes unmerged until the user has reviewed the tradeoff and given the go-ahead. Committing
this documentation does not enable any observer or latency change. Never push or tag.

Local continuation pointers are in
`.sts2/research/host-perf-20260925-landing/observer-followup-handoff.md`.
