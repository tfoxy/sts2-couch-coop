# Handoff: attribute mirror SFX latency in combat

**Status:** investigation needed after per-viewer audio landed. Diagnose the measured latency misses before
changing the renderer, transport, cache or browser scheduler. The goal is an evidence-backed cause and, if the
cause is in CouchCoop, a measured fix.

## Why this exists

The E6 prototype on the Moto G31 measured predicted play-call-to-output p50/p95 of 37.0/39.7 ms for cached
SFX (247 starts), 48.2/62.9 ms for first-sight SFX (24 starts), and 37.3/68.6 ms for decoded TmpSfx
(158 starts). It held Chrome's FAST track. E6 had one phone browser and a Node subscriber for the second
seat; its route and browser workload were not identical to the shipped mirror. See the local, ignored
`.sts2/research/audio/e6-shape-b-e2e.md`.

The integrated WP7 runs also held FAST, with roughly 33 ms phone output lead. A quiet production run had
cached SFX at 37.45/43.57 ms predicted, though its 38 starts were near-simultaneous pairs. Combat captures
then missed the handoff targets:

| WP7 sample | Predicted p50/p95 | Coverage and observation |
| --- | --- | --- |
| First-sight SFX | 146.93/431.95 ms | 9 distinct keys in three combat bursts; fewer than the required 10 |
| Decoded-cache SFX | 52.60/138.72 ms | 9 overlapping starts; no independent single-cue gate |
| Decoded TmpSfx | 148.62/354.58 ms | 4 starts, 3 in one card-deal burst |

These are real misses in the recorded bursts, not population percentiles from independent trials. The
browser scheduled the delayed sounds within 1 ms of receiving their event or first PCM block. Music PCM was
delayed in the same windows. For two cold keys, the first block was stamped 30–42 ms after the seat play
call, but reached phone scheduling another 353–364 ms later. Decoded TmpSfx play-call-to-phone receipt took
85–354 ms in the slow burst; one quiet TmpSfx start completed in 36.51 ms. The clock uncertainty was only
about 2–3 ms. See local ignored reports:

- `.sts2/research/audio/wp7-live/bench/fixed-run-summary.md`
- `.sts2/research/audio/wp7-live/bench/broader-run-summary.md`
- `.sts2/research/audio/wp7-live/bench/tmpsfx-focused-summary.md`
- `.sts2/research/audio/wp7-live/bench/silent-stall-run-summary.md`

**Do not label the delay “Wi-Fi” yet.** `AudioFrame.SentUs` is assigned in
[`DeadlineSender.cs`](../../src/CouchCoop.Mod/Audio/Delivery/DeadlineSender.cs) *before* the awaited send.
It includes time waiting for the shared send gate and `WebSocket.SendAsync`; the current trace cannot locate
the exact stall. Nor does the shared stall explain every miss: play-call-to-first-frame-stamp itself ranged
from 10 to 93 ms across the nine cold keys. FAST loss, slow browser source creation, and an inaccurate clock
do not explain the observed bursts.

## Work sequence

### 1. Add bounded timing probes

Use the existing opt-in `COUCHCOOP_AUDIO_DIAG=1` and `?audioDiag=1` surfaces. Keep all new tracing dormant
with no subscribers and avoid allocation in native callbacks or typed Harmony sound prefixes. Never log
PCM, bank data, full game payloads or private game internals. Record one monotonic timestamp at each boundary,
plus a connection ID and existing correlation fields (`seatTUs`, key ID or TmpSfx path, stream ID and block
index). Preserve enough identity to distinguish rapid repeated card sounds without changing the gameplay
wire contract merely for a benchmark.

Trace these boundaries first:

1. Seat sound call, seat audio queue insertion, and the dedicated seat socket's `SendAsync` start/completion
   in [`SeatAudioLaneConnection.cs`](../../src/CouchCoop.Mod/Server/SeatAudioLaneConnection.cs).
2. Host relay ingress/egress for the seat audio socket in
   [`SeatBrowserPipe.cs`](../../src/CouchCoop.Mod/Server/SeatBrowserPipe.cs), if the first trace leaves the
   seat path ambiguous. The relay must remain byte-transparent.
3. Browser seat `message` callback entry, parse completion and audio-engine event entry in
   [`seatAudioLane.ts`](../../frontend/src/audio/seatAudioLane.ts) and
   [`audioEngine.ts`](../../frontend/src/audio/audioEngine.ts).
4. Host render request receipt; take enqueue, render start and first block; deadline queue insertion,
   dequeue and stamp; send-gate wait/acquisition; `WebSocket.SendAsync` start/completion in
   [`AudioRenderLaneConnection.cs`](../../src/CouchCoop.Mod/Server/AudioRenderLaneConnection.cs) and
   `DeadlineSender.cs`. Trace the same stages for a nearby music block.
5. Browser render `message` callback entry, frame decode completion and `source.start()` scheduling in
   [`renderLane.ts`](../../frontend/src/audio/renderLane.ts) and `audioEngine.ts`.

Instrument the private QA edge's read/write start and completion only if the host and browser stamps leave
an edge interval unresolved. Its scripts and captured traces stay under `.sts2/research/`. Capture Chrome
network receive and main-thread task timing with CDP/Chrome tracing, but treat CDP event notification time
as an observation, not as the instant bytes reached the radio. Calibrate its clock against
`performance.now()`; do not subtract unaligned monotonic clocks. Use clock-probe bursts around each combat
window and carry uncertainty bounds into every latency number.

Keep diagnostic overhead measurable. First run a short self-check that all stages correlate and no events
are lost. Use bounded rings or sampled marks for continuous music; do not serialize every PCM block to the
phone just to measure a few SFX. Compare a minimal-instrumentation leg with the full trace before trusting
a result that appears only with tracing enabled.

### 2. Run a controlled paired live comparison

Use `live-game-qa` for the real instances and `mirror-bench` for independent timing analysis. Create an
isolated worktree with `scripts/create-worktree.sh`, run `scripts/install-agent-config.sh`, and set a
scratch `COUCHCOOP_GAME_MODS_DIR` before any C# build. Deploy to a private farm under
`exclusive:install`; prove `build-info.txt`, installed DLL identity, and the frontend build. Hold the
resource-scoped leases. Use host plus two seats, the Moto G31 over the same Wi-Fi and route, and private
headless gamescope on the RTX 2060. Never open a desktop window or use Xvfb. Keep `mFastIndex >= 0`,
output lead, seat volumes, route, game version, browser version and competing CPU/network load in the record.

Predeclare one quiet scene and one real combat burst in the **same full product**. Use only real pointer/key
input for gameplay choices; a spirectl semantic action requires separate maintainer approval. Use a
short pilot to establish repeatable stimuli and clock alignment, then paired runs with order reversal.
Collect at least 10 distinct first-sight keys and at least 30 independently spaced cached and decoded
TmpSfx cues per path. Verify that each cold key was absent from the host and phone caches before its play;
do not count repeats as new first sights. Compare the same cue/key in quiet and combat where real input
allows it, and report any unmatched workload. Exclude overlapping sounds from an acoustic single-cue gate.
Do not treat the 15 `card_deal.mp3` calls in one burst as 15 independent trials. Do not assume
`map_ping.mp3` repeats on harmless hovers: WP7 saw one event on the final map vote. If real input cannot
supply the required sample, report that gate incomplete rather than manufacturing cold keys or using
semantic actions.

The first comparison is quiet versus combat on the same integrated build and network route. If that does
not explain the E6 difference, rerun the E6 prototype from an isolated worktree and farm under matched
phone, route and workload conditions. E5's acoustic warm-path run used USB `adb reverse` and a separate
short Wi-Fi train, so do not substitute it for a paired production Wi-Fi result.

### 3. Attribute, then change one cause

For every SFX sample, report p50/p95 and worst-case spans for play call → host request/first block → send
gate → completed host send → edge write → browser callback → source schedule → predicted output. Report
counts, independent stimulus groups, clock uncertainty, and nearby music-block lag. Use this decision rule:

| Excess interval | Investigate first |
| --- | --- |
| Play call → render block | seat relay, request dispatch, worker queue, render timing |
| Stamp → send start/completion | deadline ordering, shared send gate, socket backpressure |
| Completed host send → edge write | private edge forwarding and host-to-edge transport |
| Edge write → browser dispatch | Wi-Fi/phone transport, Chrome network receive and main-thread tasks |
| Browser callback → source schedule | frontend decode, cache lookup and scheduling |
| Only the detailed-trace leg is slow | measurement overhead |

The seat and render lanes are separate WebSockets. A simultaneous delay in both is evidence against a
render-socket-only explanation, but does not by itself identify Wi-Fi. Fix only the measured stage in its
own worktree. Rerun the same paired workload, including music and dormant-subscriber checks. If the delay
is external or cannot be isolated, deliver the trace and limits instead of making a speculative product
change.

## Gates and handoff artifacts

- Keep the audio wire fixtures and existing C#/TypeScript suites green. Run the Mod custom runner and the
  frontend typecheck/Vitest for changed code; NativeTests if rendering changes; beta-targets and reference
  verification if hook targets change. `dotnet test` is a no-op here, and `npm run build` deploys.
- The live target remains [qa-recipes §Seat audio live matrix](qa-recipes.md#seat-audio-live-matrix): cached
  predicted p50/p95 ≤40/45 ms, first-sight ≤50/63 ms, decoded TmpSfx ≤40/70 ms, and cached acoustic
  p50 ≤50 ms. Confirm music p50 ≤120 ms, FAST allocation and zero-client dormancy did not regress.
- Save a machine-readable per-event stage table, raw host/edge/CDP traces, clock model and uncertainty,
  route/load metadata, installed-build proof, and a short verdict under `.sts2/research/audio/`. Keep
  official assets, screenshots and captured game payloads out of Git. Cite exact image paths for any visual
  claim. Release all leases and restore the phone and sibling repositories.
- Record the earlier single WAV `ERR_CONTENT_LENGTH_MISMATCH` as a separate anomaly. If it recurs, capture
  CDP `loadingFailed.canceled`, response `Content-Length`, and host bytes-written/exception before treating
  it as the cause of SFX latency.
