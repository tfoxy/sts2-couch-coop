# Canvas-stage offline probes

These four offline probes analyse recorded mirror streams. They replay the real browser wire model and report
properties of the retained scene tree; they neither start a game nor open a browser or dev server.

Use them when changing canvas-stage draw-list, atlas, text-layer, or animation-arena work. They are diagnostic
inputs, not release gates and not visual-parity evidence.

| Probe | Script | Reports |
| --- | --- | --- |
| P4 | `scripts/probe-canvas-batch-runs.mjs` | consecutive draw-batch runs, distinct keys, and break causes |
| P5 | `scripts/probe-canvas-atlas-vram.mjs` | atlas-page count and lower-bound RGBA residency |
| P6 | `scripts/probe-canvas-text-cover.mjs` | paint-order coverers above text nodes |
| P8 | `scripts/probe-canvas-anim-concurrency.mjs` | concurrent tween, card-flight, and pinned-loop windows |

## Run

Pass absolute recording paths, repository-relative paths, or bare filenames. A bare filename resolves through
`.sts2/bench`; with no positional paths the scripts use the shared standard recording set. A worktree has an empty
`.sts2`, so the helper falls back to the primary checkout's bench directory when it is available.

```bash
node scripts/probe-canvas-batch-runs.mjs
node scripts/probe-canvas-atlas-vram.mjs --regions
node scripts/probe-canvas-text-cover.mjs /absolute/path/to/recording.ndjson
node scripts/probe-canvas-anim-concurrency.mjs r13-reshuffle-30.ndjson
```

Use `--help` for each script's current options. All output is a human-readable stdout report; save it externally if
it is evidence for a round. Do not write recordings or measurements to a worktree `.sts2/`; use an absolute path in
the primary checkout instead.

## Shared method and limits

`scripts/lib/mirror-probe.mjs` replays recording NDJSON through
`frontend/src/mirror/sceneTree.ts`, then walks the resolved retained tree. The loader resolves the frontend and
sibling TypeScript sources under Node; its resolver is deliberately part of the harness, so a source-resolution
failure is a probe failure rather than a substitute implementation.

All final-state probes use producer order (`orderedIds`) as their paint-order approximation. Native sibling sorting
and `show_behind_parent` can change local order, so batch and occlusion numbers are estimates. P4/P5/P6 inspect the
final retained state; P8 scans the recording timeline. Full-quality paint predicates are used, and shader coverage,
actual standalone-image dimensions, and exact geometry coverage are not available from the wire. Treat P5 as a
lower bound and P6's AABB intersections as possible, not pixel-proven, occlusion.

## Reading each probe

- P4's `runs` is the tree-order batch count; `distinct keys` is only a lower bound for a renderer that can preserve
  paint ordering while grouping compatible draws. Break axes identify why neighbouring nodes cannot share a batch.
- P5 sizes atlas regions from the maximum observed crop extent. `--regions` additionally applies the runtime
  re-packer's crop algebra and reports distinct crops; it does not decode assets or measure total texture residency.
- P6 counts non-text painting nodes that appear later in producer order and intersect a text AABB. The `-fs` columns
  remove full-screen coverers, because shader coverage cannot be determined from scene state. Neither column proves
  a visible defect.
- P8 treats reissued tween or flight keys as superseding their earlier windows. Its percentiles are time-weighted
  across active windows; pinned loops come from the final state and are reported separately.

For canvas rendering measurements or DOM/canvas parity conclusions, use the mirror bench workflow in
[mirror-combat-bench.md](../mirror-combat-bench.md), not these analyses.
