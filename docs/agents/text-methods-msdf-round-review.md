# Bitmap and MSDF text: round review

**Decision (Oct 2, 2026):** ship the switchable Rust-canvas text setting, keep Bitmap as the
device default, and offer MSDF for an opt-in play-test. This is a feature-completion GO, not an
FPS or CPU-speedup claim. No physical phone performance leg was requested.

## What shipped

The Couch setting is device-local, translated in 14 locales, absent from server and Rust settings
payloads, and selects between the unchanged Bitmap adapter and the runtime MSDF adapter. Couch
uses hb-gpu to shape prepared runs and preserves measured boxes, line breaks and baselines; each
run falls back to Bitmap on a failed shape, coverage, tile, atlas or metric gate. The generic
godot-scene-web Rust stage has a glyph-run contract, RSR2 atlas writes and explicit release. The
worker generates MTSDF tiles from font bytes at runtime with bounded buffers and uploads. No game
font or derived atlas was committed. The 40 compiled-target generator dependency licences and
shipped notices were independently audited.

Luna's clean-worktree Phase 4 audit passed Vue/Vitest (5,366 passed, one skipped), focused
atlas/executor tests (101 passed), pinned GSW/WASM source checks, and paired browser captures.
The Chinese reward `搜刮！` visibly replaced its Bitmap placeholder after tile completion while
retaining the same hit grid. A moving combat `6` kept its atlas glyph across retained transforms.
MSDF strokes appear modestly fuller and sharper. The diagnostic reports five long Chinese rich
labels refused by the common layout path in both methods, but their rows are below the visible
scroll area in the paired screenshot; this capture does not prove a visible omission. An atomic
atlas upload exceeded 1 ms once in one audit
capture; the repeat had none and the per-frame 256 KiB byte cap held.

The local [visual index](../../.sts2/artifacts/text-methods-msdf/PHASE4-VISUAL-INDEX.md) lists
every paired image at 739×281/DPR 3.49 and 1920×1080, including combat damage, card zoom,
rewards, and English/Russian shop. Those ignored local files are not packaged with the mod.

## Desktop WebGL comparison

Four fresh, untraced Bitmap/MSDF/Bitmap/MSDF pages used the same current combat recording and
9600–12500 ms window, 1920×1080/DPR 1, and the actual NVIDIA RTX 2060 Vulkan WebGL2 context.
Each leg delivered scene updates and performed the relevant text work inside its markers.

| Measure | Bitmap A1/A2 | MSDF B1/B2 |
| --- | ---: | ---: |
| Actual completed presentations | 42 / 35 | 53 / 61 |
| Text rasterizations | 3 / 3 | 0 / 1 fallback |
| Glyph-run presentations | 0 / 0 | 2,814 / 3,176 |
| Rust scene draws per presentation | 27.0 / 27.0 | 20.0 / 20.21 |
| CDP TaskDuration | 0.5332 / 0.6069 s | 0.4139 / 0.5558 s |

The `0 / 1 fallback` cell counts **new Bitmap text rasters inside the measured windows** while MSDF
was selected: zero in B1, one in B2. It does not count every run that temporarily used Bitmap;
cached fallback images can be reused without another rasterization. B2 logged additional
`glyph-pending` fallback uses while atlas tiles arrived.

The mean TaskDuration gap is 0.0852 s, smaller than MSDF's own 0.1419 s repeat spread, with
different presentation counts and marker-snapshot cost. The timing result is **inconclusive**.
A separate instrumented pair observed two Bitmap text rasters totaling 108.0 ms wall, including
105.1 ms in `getImageData`; MSDF had zero Bitmap text readbacks in that profiled window. This
attributes work in that capture and does not establish a speedup.

A separate GPU-verified clock-7600 diagnostic counted resident scene-resource textures from Rust
resource metadata: Bitmap 148 textures / 169,532,420 nominal RGBA8 bytes; MSDF 140 /
173,849,608 bytes, including one 4 MiB atlas page. The roughly 4.3 MB byte increase is an
observed snapshot. An earlier independent browser boot had different texture counts, so there is
no stable texture-count saving claim. These totals exclude internal targets and driver overhead.

Raw ABAB/profiler attempts, including rejected windows, are archived under the primary checkout's
`.sts2/artifacts/text-methods-msdf/evidence/phase5/`; the GPU-verified residency receipts are
under `.sts2/artifacts/text-methods-msdf/evidence/phase5-diag/`. Every completed
and failed attempt is recorded in the [renderer ledger](renderer-optimization-ledger.md).

## Recommendation

Keep Bitmap as default for the user's play-test and use the setting to compare MSDF's appearance.
If another method is pursued afterward, try a bounded **single-channel SDF** experiment using
the shared shaping and atlas seam. Gate it on zoom/outline quality, resident bytes and actual
frame cost. Slug needs a separate resource/pipeline path; revisit it only with a specific quality
or performance hypothesis.
