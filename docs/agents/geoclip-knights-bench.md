# Geoclip Knights paired gate bench

`scripts/bench-geoclip-knights.mjs` compares cold geoclip production with the `/spines/` still for one encounter.
It has two gates: host main-thread blocking time from `/perf/spine.json`, and browser request-to-drawn-data time.
It runs ABBA legs per identity so monotone drift is visible and partially cancelled. This is a live-game benchmark:
use `mirror-bench` and take the resource-scoped live-QA lease before starting it.

The script does not launch or drive a game. Use the isolated gamescope workflow in
[qa-recipes.md](qa-recipes.md) and `couch-live-lock`; never use the shared game install, its browser port, or its
cache directory. The run purges the supplied cache root, which must belong solely to the isolated instance.

## Live run

Bring up a leased isolated instance, load the desired encounter, and record the actual roster as:

```json
{ "identities": [{ "id": "...", "scene": "...", "node": "...", "anim": "..." }] }
```

Then use the instance's browser-port record and private cache root:

```bash
node scripts/bench-geoclip-knights.mjs \
  --origin http://127.0.0.1:<walked-port> \
  --port-file /absolute/path/to/couch-coop/browser-port \
  --dataset /absolute/path/to/knights-roster.json \
  --cache-root /tmp/geoclip-knights-cache \
  --pairs 8 --browser headed-gpu --include-animated-clip \
  --out /absolute/path/to/geoclip-knights-$(date -u +%Y%m%dT%H%M%SZ)
```

`--pairs 8` is the minimum for a gate. The script verifies that the port record belongs to the supplied origin,
uses a fresh browser process per leg, clears produced cache entries by snapshot difference, and requires a producer
witness rather than treating a response as proof of production. The optional animated clip leg is context only;
it is not part of either gate.

For an unsafe exploratory run, `--allow-ineligible` records data but cannot enable a verdict. Avoid
`--no-preflight` unless the failed-fast geoclip admission check has already been established for the roster.

## Eligibility and report

The output is `<out>/geoclip-knights-bench.json`, schema `geoclip-knights-bench/1`.

- `verdict` contains eligibility, blockers, the `hostBlockingGate`, the `browserFirstFrameGate`, and overall
  `GEOCLIP-PASSES`, `GEOCLIP-FAILS`, or `NOT-DECIDED`. A pass requires geoclip to win both gates.
- `aggregate.metrics` and `creatures[].metrics` contain paired distributions, median deltas, confidence intervals,
  sign tests, and raw paired rows. Gate metrics are `hostBlockingMs` and `browserFirstFrameMs`; remaining metrics
  are context.
- `creatures[].legs[]` preserves the browser timing, host window, producer proof, cache clear, and retained image
  evidence. `overhead` is reported but excluded from the gates. `limits` travels with the report.

A run is not eligible under Xvfb, a software renderer, or an unverified GPU. It is also undecided when an expected
host row is absent, phases are unmeasured, producer proof is missing, or usable pairs fall below the minimum. A
missing geoclip `/perf/spine.json` row means missing data, never zero cost; current host QA describes geoclip rows
in [qa-recipes.md](qa-recipes.md#geoclip-bakes-are-in-the-same-report-in-their-own-block).

The paired sign test is intentionally distribution-free. The bench measures cold production on one host, GPU,
encounter, and roster. It does not prove visual correctness, scanout/frame pacing, warm-cache behavior,
multi-client performance, or shipped-client end-to-end cost.

## Offline validation

These commands do not start a game, host, or GPU workload:

```bash
node scripts/bench-geoclip-knights.mjs --self-test --pairs 8 --out /tmp/geoclip-knights-selftest
node scripts/bench-geoclip-knights.mjs --self-test --self-test-inject host-row-absent --pairs 8 --out /tmp/geoclip-knights-missing-row
node --test "scripts/lib/geoclip-bench-*.test.mjs"
```

Self-test artifacts are deliberately `NOT-DECIDED`: they validate orchestration and blocker handling, not a product
comparison. The injected missing-row case specifically verifies that absent instrumentation remains unmeasured.
