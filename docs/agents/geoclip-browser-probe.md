# Geoclip browser first-frame probe

`scripts/probe-geoclip-first-frame.mjs` measures the current checkout's browser path. It starts a local Vite middleware server, imports `geoclipPlayer` and `spineClip` from source, and proxies only the selected instance's `/geoclips/` and `/spines/` routes.

For an offline smoke check, generate a synthetic artifact and use the explicit software renderer:

```bash
node scripts/probe-geoclip-first-frame.mjs \
  --origin http://127.0.0.1:9 --identity synthetic --lane geoclip \
  --artifact .sts2/research/browser-fixture --make-synthetic \
  --renderer software --out .sts2/research/browser-fixture-result
```

For a live arm, the live-QA owner must first provide an isolated instance port record and authorize the identity. Supply the frozen dataset and that `--port-file`; the probe checks that its live pid and port agree with `--origin` before making any request. A headed hardware check is coordinated with the lock owner and runs on the owner-specified display, not through an unapproved game session.

```bash
node scripts/probe-geoclip-first-frame.mjs \
  --origin http://127.0.0.1:<isolated-port> --port-file <instance-browser-port> \
  --dataset <frozen-dataset.json> --identity <id> --lane geoclip \
  --headed --renderer default --out <ignored-output-dir>
```

Run the raster arm with the same arguments and `--compare-with <geoclip-result.json>`. It rejects a placement mismatch before any visual comparison. Each result records the raw canvas image and the page image; visual claims must name those paths.

The phase fields are browser-side durations. `startToAfterTwoRafMs` ends after two requestAnimationFrame callbacks, which is a presentation proxy, not scanout or frame-pacing proof. Asset requests cross the local Vite/proxy hop, so the timing is observed at that hop. `backendProbe.webgl2` is a separate diagnostic context; the presented canvas is 2D and the probe does not infer hardware acceleration from that string.

## Atlas-page reuse

`scripts/analyze-geoclip-page-reuse.mjs` is offline size research. Give it the frozen dataset and the local geoclip cache; keep its JSON output under ignored research storage.

```bash
node scripts/analyze-geoclip-page-reuse.mjs \
  --dataset <frozen-dataset.json> --cache-root <geoclip-cache-root> \
  --out <ignored-report.json>
```

It prefers each identity's frozen `snapshotManifest`, records `sourceManifest` separately, and counts a page once by its observed full SHA-256. Missing local files make the relevant byte total `null`; a declared hash mismatch is recorded and does not establish content identity. `artifactDisposition: "complete"` and `visualValidated: false` describe artifact availability only, never visual acceptance.
