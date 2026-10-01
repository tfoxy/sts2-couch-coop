# Renderer benchmark result contract

Use `renderer-benchmark-result.schema.json` for each measured cell. A cell is one renderer, one
input slice, and one marker interval. Keep raw recordings, traces, images, and local paths in
ignored artifacts; the portable record contains hashes and artifact identifiers only.
Record `renderer.graphicsApi` for every cell. The product target is the WebGL web client;
native Vulkan or web WebGPU results may reveal removable work, but a performance win for WebGL
still requires an independent WebGL A/B with equivalent output. Keep comparisons within one API
unless the question is explicitly about choosing an API.
`renderer.environmentSha256` hashes a canonical inventory of device model, OS build, browser
and version (or native runtime), GPU and driver, display mode, and relevant power/thermal state.
Describe the inventory in `environmentIdentity`. Leave its hash `null` until pinned; a cell
cannot pass without it. Compare cells only when both hashes match.

## Comparable input and time

Compare cells only when `input` is identical: the source recording hash, delivered slice hash,
first inclusive and last exclusive filtered message indices, viewport, pixel ratio, render
settings hash, and resource identity. Hash canonical settings as sorted key/value pairs after
normalizing aliases and defaults. Hash each delivered message with its byte length and an
unambiguous separator; document the filter and any replay transformations in `input.method`.
If an aggregate resource hash was not pinned, set `resourcesSha256: null`, describe the available
resource evidence in `resourceIdentity`, and leave input equivalence unverified.
Confirm the first and last delivered revisions and message count. An identical recording hash
alone does not establish an identical measured workload.

`window` records the markers' clock domain, timestamps, mapping method, and actual span. Set
nanosecond endpoints to `null` and mapping coverage to `unavailable` when a trace-off arm lacks
an aligned clock; retain the measured page-clock span without claiming a scheduler join.
Encode nanosecond timestamps as decimal strings so Unix-epoch values retain full precision in
JavaScript and Rust JSON readers; compare them as integers, never floating-point numbers.
Markers must bracket message dispatch at the stated indices. If a replay clock setter or other
work runs before a marker, record that in `window.edgeWork`; this prevents treating the marker
as a boundary for work it did not contain. Compare CPU rates using the actual marker span.

## Required evidence and verdict

`milestones` records first input, renderer ready, first completed draw, first and final actual
presentations, and final delivered revision on the same mapped clock. `readiness` records resources and valid
presentation state at both marker boundaries. A missing milestone has `timestampNs: null` and a
reason; never substitute a callback or completed draw for an actual display presentation.
`measurements.workloadCompletion` is elapsed first-input to final eligible presentation time;
`presentationTiming` records actual presentation intervals and missed deadlines with its source.
Keep delivered updates, completed draws, and actual presentations as separate counts.

Every numeric observation has `value`, `unit`, `method`, and `coverage`. Use `value: null` with
`coverage.status: "unavailable"` when a source cannot measure it. Process CPU is scheduled thread
time clipped to the marker interval; concurrent threads can total more than wall time. Name each
included PID, role, and process instance, and state excluded roles. Browser results identify the
renderer and GPU processes using same-run process metadata. Native results identify the app and
any separate GPU service; do not silently fold a system compositor into app CPU. `gpuHardware`
is elapsed hardware work only when a supported GPU timer/counter supplies it; GPU-process CPU
belongs under `processCpu`.
When process identity or CPU joining fails, leave the corresponding arrays empty, mark process
coverage unavailable, and make the cell unverified or invalid. Do not insert a guessed PID.

`visualWitness` records image or video artifact hashes, the frame timestamp source, interval
coverage, and time-aligned black intervals. `pass` requires a witness covering the measured
interval, no unexplained black interval, and equivalent output and hit geometry against the
control. A witnessed black interval is `invalid`, even if CPU is lower. Missing or unaligned
visual evidence is `unverified`. `validity.status` is `pass` only when input, time, delivery,
readiness, CPU coverage, presentation source, and visual checks all pass. Invalid or unverified
cells cannot support a CPU win. Preserve the reason and raw artifact reference for review.
Black intervals carry their own clock domain (for example, video presentation timestamps);
`clockMapping` states how those intervals overlap the measured window and with what uncertainty.
A pass requires continuous video of the measured window; one still image cannot rule out a
transient black interval. Extracted frames may supplement the video for parity inspection.

The schema enforces field types and the minimum evidence for `pass`. Run
`python3 scripts/validate-renderer-benchmark-result.py <cell.json>` (requires Python
`jsonschema`) to check relational invariants that JSON Schema cannot express: delivered count,
window span, CPU membership in the PID ledger, video coverage, and mapped milestone timing.
Use `--compare <other-cell.json>` to check two passing cells for the same graphics API,
environment, input identity, and complete process role set. Identify pre-window readiness in
the milestone source. Check that presentation intervals and missed deadlines derive from actual
display events, not draws. A paired CPU claim also requires a contemporary variation bound and
an independent confirmation on the final source. For a WebGL performance claim, both arms and
the confirmation must run through WebGL. The validator checks admission and comparability; it
does not declare a CPU winner.

## Backend attribution

`attribution.chromeCdp` and `attribution.rustWgpu` are separate optional adapters. Chrome may
carry CDP trace categories, renderer-main trace markers, and Perfetto scheduler/FrameTimeline
joins. Rust may carry tracing spans, wgpu submission timestamps, and native scheduler or surface
presentation joins. Adapter spans explain where time went; they do not replace the common
process-CPU and actual-presentation observations. Keep unsupported fields unavailable instead
of inferring them from adjacent callbacks.

For the Rust prototype, first use [wgpu's timestamp queries](https://wgpu.rs/doc/wgpu_examples/timestamp_queries/index.html)
or [wgpu-profiler](https://docs.rs/wgpu-profiler/0.28.0/wgpu_profiler/) for GPU pass scopes
when the adapter supports `TIMESTAMP_QUERY`. The latter already manages query sets and readback
and its 0.28 release uses wgpu 30. Keep these scopes in a diagnostic build and measure their
overhead against an unarmed build. Record unsupported features as unavailable. These queries
measure GPU execution, not Rust CPU or actual display presentation; use Rust tracing/scheduler
evidence and platform display timestamps for those distinct questions. The
[wgpu GL backend](https://docs.rs/wgpu/30.0.1/wgpu/struct.Backends.html) supports WebGL through
WebAssembly, so the Rust prototype can provide a direct WebGL comparison if the same workload
and witness gates pass.
