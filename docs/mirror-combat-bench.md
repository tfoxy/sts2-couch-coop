# Mirror replay benchmark

Use this harness to compare the current mirror renderer against itself with the same recorded scene stream. It has two complementary gates:

| Gate | Command | Measures |
| --- | --- | --- |
| Offline walk cost | `COUCHCOOP_BENCH_RECORDING=<recording> npm --prefix frontend run bench:mirror` | Parse, apply, and reconcile cost plus `mirrorWalkStats`. |
| Browser replay | `node scripts/bench-mirror-replay.mjs …` | Chromium main-thread work, rAF gaps, frame gaps, and optional visual or compositor evidence. |

Recordings, traces, screenshots, and reports belong under ignored `.sts2/bench/` or `.sts2/artifacts/`; never commit them. Do not run `npm run build` for this workflow: it deploys the frontend to the local game installation.

## Record a representative stream

With a live, animated combat running, record a passive extra viewer:

```bash
node scripts/record-mirror-stream.mjs --duration 30 \
  --out .sts2/bench/combat-current.ndjson

# A non-local host
COUCHCOOP_GAME_ORIGIN=ws://192.168.1.5:13337 \
  node scripts/record-mirror-stream.mjs --duration 30 --out .sts2/bench/combat-current.ndjson
```

The recorder connects to the canonical `/ws` endpoint, sends no input, and immediately acknowledges scene deltas.
All accepted recordings use `repro/1` NDJSON: the first line is its required metadata header, and the first inbound
scene frame must be a full keyframe. Drive meaningful combat activity while recording; do not replace a
before/after recording mid-comparison. See [the repro recorder](agents/repro-recorder.md) for capture and replay
details.

## Run the browser gate

Start a dev server from the checkout under test, then run fresh-page repeats against one recording:

```bash
cd frontend && npx vite --port 5174 --strictPort

node scripts/bench-mirror-replay.mjs \
  --url http://127.0.0.1:5174 \
  --recording .sts2/bench/combat-current.ndjson \
  --repeats 5 \
  --trace current.json \
  --layers \
  --shot .sts2/artifacts/mirror-bench/current.png
```

The command prints `BENCH_RESULT {…}` with median metrics. Record the exact command, commit under test, recording path and hash, viewport/DPR, effect mode, CPU throttle, and whether the game was available for assets. Keep those inputs identical between arms.

Useful focused legs:

```bash
# Maximum credit-paced consumption rate.
node scripts/bench-mirror-replay.mjs --recording <recording> --pace max --repeats 5

# Phone-shaped credit delay; do not coalesce the recording again.
node scripts/bench-mirror-replay.mjs --recording <recording> --ack-paced 150 --repeats 5

# Offline resource fixture when the game is down.
node scripts/bench-mirror-replay.mjs --recording <recording> --res-root <resource-root> --repeats 5

# Cross-backend paint and hit-test parity. Use the same viewport for both arms.
node scripts/bench-mirror-replay.mjs --recording <recording> --query stage=dom \
  --paint-dump .sts2/artifacts/mirror-bench/dom.paint --hit-grid .sts2/artifacts/mirror-bench/dom.hits
node scripts/bench-mirror-replay.mjs --recording <recording> --query stage=canvas \
  --paint-dump .sts2/artifacts/mirror-bench/canvas.paint --hit-grid .sts2/artifacts/mirror-bench/canvas.hits
node scripts/compare-paint-dumps.mjs .sts2/artifacts/mirror-bench/{canvas,dom}.paint --json
node scripts/compare-hit-grids.mjs .sts2/artifacts/mirror-bench/{canvas,dom}.hits --json
```

Use `--report <file>` when producing a portable performance envelope. Validate it with the installed `godot-scene-web` performance validator; a report discards incomplete repeats rather than treating missing observations as zero. The report path needs a shorter capture window when traces are large, for example `--limit-ms 12000`.

## Read the results

- For CPU regressions, compare `busyPct`, `tickMs`, `walkStatsWindow`, and the offline bench together. Absolute CDP task buckets can drift with the captured window.
- `frameGaps` measures callback opportunities, not presentation. On a device, pair it with a device presentation trace.
- Use `--layers` or `--layer-detail` for compositor changes, `--census` for post-settle DOM/canvas population, and `--churn-census` only when comparing runs that both enable it.
- Use `--effects`/`--effect-mode` only when the compared viewer setting is the same. A headless GPU result is not visual proof; visual canvas evidence requires `--headed --gpu vulkan` and a screenshot path in the report.
- Use `--paint-dump` and `--hit-grid` for backend parity, not screenshots alone. A wide-stage comparison needs `--any-viewport` where the comparator requires it.

## Gates and artifacts

The benchmark itself does not prescribe one universal budget. A change proposal must state its applicable baseline and gate before measuring. At minimum retain:

- `BENCH_RESULT` output for every repeat set and the input recording identity.
- Trace path when claiming main-thread or compositor behavior.
- Screenshot path for every visual claim.
- Paint-dump and hit-grid comparison JSON for canvas/DOM parity claims.
- Report JSON plus validation output when using `--report`.

## Troubleshooting

- `npm run build` deploys. Use `npx vue-tsc --noEmit` and the focused tests for code verification; this document's Vite command only serves the checkout.
- Compare one asset regime at a time. Game-hosted assets, offline `--res-root`, and 404 fallbacks are different workloads.
- A recording without an initial full keyframe is not suitable for replay. Re-record it; do not patch the stream by hand.
- The game can be stressed by repeated live `/spines/` requests. Prefer a game-down fixture or a disposable host for repeated replay legs.
- A backgrounded tab does not provide reliable rAF or frame-gap evidence. Keep the bench foregrounded.
- `--churn-census`, hover sweeps, and other in-window instrumentation change the workload. Enable them in both arms or treat them as diagnostics only.
