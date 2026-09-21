# WebKit scene-group memory attribution

These development diagnostics measure avoidable costs under a fixed scene workload. They are not a renderer
setting or a claim about exclusive memory ownership. Keep the recording, source revisions, asset source,
viewport, quality fields, browser version and cache policy identical across comparisons. Use fresh browser
processes and do not force garbage collection.

## Renderer controls

Before the application loads, inject a JSON assignment through the probe's `--init-json-file` option:

```json
{
  "__mirrorSceneAblationConfig": {
    "version": 1,
    "mode": "exclude",
    "groups": {
      "example": [{ "sceneFile": "res://example.tscn", "relativePath": "Decoration" }]
    },
    "selectedGroups": ["example"],
    "prefetch": "normal",
    "effects": "normal"
  }
}
```

Build the real group manifest from inspected ancestry. Record each selector's exact descendant membership and
verify a non-overlapping partition. A missing group is not applicable, never a zero-cost observation. Selectors
use the renderer's scene identity and relative path, rather than browser element IDs. Keep captured manifests
and game payloads in ignored research storage.

| Mode | Behavior |
| --- | --- |
| `full` | Normal construction, with diagnostic receipts |
| `exclude` | Hold selected groups before construction and descendant traversal |
| `include` | Build selected groups and transform-only structural ancestors |
| `no-groups` | Hold every scene root while retaining state, reconciliation and normal startup |
| `data-only` | Consume scene state and return credits without mounting the renderer |
| `app-shell` | Application bootstrap with the scene watch gate closed |

`prefetch: "off"` suppresses independent speculative image loading. `effects: "no-startup"` prevents effect
runtime creation. Both are forced for `data-only` and `app-shell`. A blank-page control uses the same probe and
viewport without application code. Diagnostic configuration is ignored in production. Invalid development
configuration leaves the normal behavior active and reports validation errors; reject that measurement.

Read `window.__mirrorSceneAblationReceipt()` to verify requested/effective configuration, matching roots, held
roots, structural ancestors, created/live element counts, cumulative created element identities (including full
versus transform-only construction), effect runtime starts, retained-state revision, applied
UTF-8 scene bytes and sent acknowledgement batches (`creditsReturned`). Data-only clears transient dirty IDs and one-shot queues while preserving
the retained scene. It does not claim a rendered frame. Compare cumulative identities against the manifest's
forbidden membership as well as temporal DOM/canvas/effect samples; disposal cannot erase an earlier build.

The host's scene credit is binary: one acknowledgement closes every delta applied since the preceding
acknowledgement. Do not impose an applied-revision minus acknowledgement bound or ratio. Match the page's
revision, byte and acknowledgement counters to one unique exact ordered wire prefix. That prefix may end after
an applied delta, before its scheduled acknowledgement. If it ends with an open batch, prove the next
acknowledgement closes that nonempty batch; reject empty acknowledgements before or through that closure.
Reconcile the complete raw frame ledger with summary totals and record the remaining suffix descriptively.

Keep `staticBg=off` throughout group attribution: omitting scenery must not load a replacement picture. Measure
the product's static-background off/on comparison separately.

## Controlled replay and capture

Use one complete recording containing live scenery and the same asset origin for every arm:

```bash
node scripts/replay-ws-server.mjs --recording "$RECORDING" --pace recorded \
  --respect-watch --host 127.0.0.1 --port "$REPLAY_PORT" --assets-origin "$ASSET_ORIGIN"
node scripts/probe-webkit-memory.mjs --url "$APP_URL" --out "$LEG_DIR" \
  --width 390 --height 645 --dpr 3 --duration-ms 75000 \
  --cgroup --process-memory smaps --sample-interval-ms 10000 \
  --init-json-file "$ARM_CONFIG"
```

Serve the candidate through its worktree's development server with the appropriate proxy and scratch aliases
for any sibling worktrees. Follow the live-QA lease and deployment skills before starting endpoints or games.
Never use the installed-mod build destination for an experiment.

Pin one census interval across the matrix and reject sampling gaps. Full process/DOM censuses can take
several seconds; the example's ten-second interval leaves room for that work while Inspector events and the
kernel cgroup peak remain continuous. Confirm UI readiness, dismiss any orientation prompt through raw input,
and assert the prompt is absent before and after measured snapshots.

`--respect-watch` leaves an app shell free of incoming scene traffic. On admission it starts the original
recorded timeline from its full keyframe; recorded pacing remains independent of acknowledgements. A later
off/on watch transition starts a new complete replay. Do not loop the recording for these comparisons.

The Linux-only `--cgroup` option creates a fresh systemd user scope for the complete WebKit process tree,
excluding Node orchestration. It defaults to `memory.max=max` and `memory.swap.max=0`. A survival run may
separately specify `--cgroup-memory-max-bytes`; capped measurements do not replace uncapped product gates.

For residual-memory attribution with the product still present, capture a new stream with
`record-mirror-stream.mjs --static-bg on` (the default remains `off`). The recorder writes the selected value
and canonical WebSocket URL in its metadata. Use it separately from a graded live-browser measurement: an
additional watcher changes the host's streaming workload. Changing a replay URL cannot add a missing static
descriptor to an old recording; pin the successful still response and other asset bytes separately.

Finite recorded replay can write an optional `--timing-out <new-file>` NDJSON ledger. It identifies the
recording hash, admission generations, scheduled and actual monotonic send times, lateness, and terminal
message/scene byte totals. It refuses overwrite, looping, maximum-speed pacing, and chaos. The ledger observes
sends without changing protocol messages or ACK pacing. Use its admission clock and recording offsets for
common observation boundaries, require readiness before the boundary, and reconcile browser consumption
against the terminal totals. Sends alone do not prove consumption. A watch restart creates a new generation
and invalidates a comparison requiring one uninterrupted workload. This diagnostic adds server-side logging
outside the browser cgroup; keep it enabled consistently across a comparison.

The probe records continuous Inspector memory, cgroup counters and identity, process PSS/smaps, temporal
DOM/LayerTree attribution, canvas dimensions, effects receipts and Network evidence. Outgoing WebSocket
receipts include scene acknowledgements and client-vitals when emitted. Incoming frames retain hashes, sizes
and scene identifiers without duplicating the entire scene payload.

Journey mode accepts JSON-line commands for `begin`, `snapshot`, `evaluate`, raw WebKit `mouse`/`tap`, and
`stop`; wait for its `ready` receipt before sending them. Use actual input for application controls. Snapshot
paths, source/install identities, fixtures/recording hashes, ports and process IDs belong in the leg evidence.
Do not use the optional heap/GC commands in attribution or acceptance runs.

Reject legs with missing evidence, target/process replacement, failed initialization readback, missing assets,
or unequal scene consumption. Check all continuous failures and sampling gaps. Require at least 60 seconds of
settled observation after startup; extend a capture if startup consumed the nominal observation window.

## Comparisons and interpretation

Explore full scene, each applicable group omitted, no groups, no groups without prefetch, no groups without
effect startup, data-only, app shell, and blank page. Confirm the two largest group reductions and residual
controls with fresh-process A-B-B-A comparisons. Subdivide expensive groups, test each large group alone with
its structural ancestors, and omit both together to expose shared-resource costs. Validate strong replay
contrasts against the same live direct-screen fixture.

Keep cgroup, PSS, JavaScript and LayerTree ledgers separate. Report startup peaks, settled levels and retained
growth. Cgroup `memory.peak` is cumulative: use tail-window `memory.current` samples for settled memory, not
the lifetime peak copied into a later sample. Full-minus-group deltas are avoidable costs in that workload;
they are not additive percentages or exclusive ownership.

`scripts/analyze-webkit-ablation.mjs` reads the normalized `couchcoop-webkit-ablation/1` schema implemented in
`scripts/lib/webkit-ablation-analysis.mjs`. An experiment-specific adapter supplies validated leg identities,
trigger/workload evidence and separate peak metrics. The analyzer rejects missing metrics, reused processes,
OOMs, workload mismatches and incorrect confirmation order. Whole-browser separation must exceed replicate
drift; other ledgers retain independent repeatability results. Product acceptance additionally uses the absolute
whole-browser budget and zero swap. Visual correctness, exclusion from first appearance, settled bounds and
stream receipts must be verified before setting a leg's `triggerValid` field.

Store raw captures, manifests, arm configurations, rankings and concrete screenshot paths in the handoff's
ignored evidence directory. A failed product gate stops advancement to later screens; diagnostic controls may
exceed the budget without becoming product acceptance results.
