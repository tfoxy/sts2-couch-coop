---
name: mirror-bench
description: Measure or compare mirror rendering — replay benches, canvas-vs-DOM parity gates, trace attribution, phone A/B legs. Use whenever a claim about performance, paint output, hit-testing or frame cost needs a number behind it. Not for writing product code.
---

# Mirror measurement and parity gates

You produce **numbers and verdicts that survive scrutiny**. The failure mode this role exists to prevent is a
confident measurement of a blank page.

Read [docs/mirror-combat-bench.md](../docs/mirror-combat-bench.md) for the harness and the flag tables, and
[docs/agents/qa-recipes.md](../docs/agents/qa-recipes.md) §5 for the record/replay recipes. Load the section you
need, not the whole file — it is 7,700 lines.

## Command spine

Replay bench (tier-ii, headless Chromium against a dev server):

```bash
cd frontend && npm run dev -- --port 5174        # or: npx vite --host 127.0.0.1 --port 5190
node scripts/bench-mirror-replay.mjs --url http://127.0.0.1:5174 --repeats 5 --res-root
node scripts/analyze-mirror-trace.mjs .sts2/bench/traces/<f>.json --window B=2100-6300
node scripts/analyze-gpu-trace.mjs    .sts2/bench/traces/<f>.json
```

Canvas-vs-DOM parity gate — same checkout, one dev server, two arms:

```bash
# canvas arm adds --query stage=canvas; DOM arm is the identical line without it
node scripts/bench-mirror-replay.mjs --url http://127.0.0.1:5190 \
  --recording .sts2/bench/<recording>.ndjson --viewport 1920x1080 --repeats 1 --res-root \
  --query 'stage=canvas' \
  --paint-dump .sts2/artifacts/<round>/combat-canvas.paint.txt \
  --hit-grid   .sts2/artifacts/<round>/combat-canvas.hits.txt \
  --shot       .sts2/artifacts/<round>/combat-canvas.png
node scripts/compare-paint-dumps.mjs .sts2/artifacts/<round>/combat-{canvas,dom}.paint.txt --json
node scripts/compare-hit-grids.mjs   .sts2/artifacts/<round>/combat-{canvas,dom}.hits.txt  --json
```

Headed / GPU captures always go through the wrapper:

```bash
scripts/run-gpu.sh node scripts/bench-mirror-replay.mjs … --headed --gpu vulkan
```

Offline probes (no game, no browser, no dev server) and the draw-list gate are in
[docs/agents/canvas-stage-probes-aug26.md](../docs/agents/canvas-stage-probes-aug26.md);
`node scripts/verify-canvas-drawlist.mjs` is a gate, not a probe.

## Rules that decide whether your number means anything

- **`--res-root` is mandatory** for any paint, decode or report number. Without it every atlas 404s and you are
  measuring a blank page. The phone script refuses to start without a `/res` 200; the desktop one does not.
- **Never re-record between a before and an after.** A new recording is a different workload; the comparison is void.
- **Both arms: same checkout, one dev server.** Never branch-vs-branch. Never two servers.
- **Every headed capture through `scripts/run-gpu.sh`.** It unsets `WAYLAND_DISPLAY` first — otherwise Ozone prefers
  Wayland and the window lands on the operator's real desktop.
- **Xvfb has no vsync.** No pacing, frame-timing or dropped-frame claim may come from a run under it. Headless with no
  GPU flag is SwiftShader; xvfb does not make a run GPU.
- **The `cc.debug` trace buffer truncates at ~15 s and loses the tail first** — bound it with `--limit-ms`.
- **`contentUpdateHz` is not `swapRateHz`.** Never report the swap rate as fps.
- **Absent means unmeasured, never zero.** A null phase is missing data; do not render it as 0 in a table.
- **Peak counters are cumulative** — read them as such.
- Comparers refuse a pair captured at different viewports unless you pass `--any-viewport`. Do not reach for that
  flag to make a mismatch go away.
- `--shot` is space-form only; `--shot=x` is not parsed.
- A worktree has its own empty `.sts2/`, so pass an **absolute** `--recording` path there, and delete any partial
  local `.sts2/bench/` a `--trace` run creates (it makes the draw-list oracle silently skip).

## Device legs

`scripts/bench-phone-canvas-ab.sh`, `scripts/bench-phone.sh`, `scripts/phone-bench-tab.mjs list`.
Four device failures are **silent**: `page.bringToFront()` does not foreground an Android tab (only an
`am start … --ez create_new_tab true` intent does); `document.visibilityState` lies on a backgrounded tab;
`waitForFunction` polls on rAF and hangs forever against one; one leftover mirror tab wedges
`connectOverCDP` for the whole browser. Check the lockscreen early. **ABBA ordering is mandatory** — thermal drift
makes an A-then-B run meaningless. Read `.procs`/`.gpulog`/`.lmk` for every cell, not just failures. Leave
`adb forward --list` and `reverse --list` empty afterwards.

## Reporting

State the arms, the recording, the viewport, the repeat count and the window. Any visual claim must list the
concrete image path(s) that back it — that is a repo rule, not a preference. If a leg was skipped or a cell died,
say so; a partial matrix reported as complete is the one outcome worse than no measurement.

## Stop conditions

Stop and report the blocker rather than looping: 3 failed dev-server or instance launches; a `/res` 404 you cannot
fix; a device that locks or thermally throttles mid-matrix; an A/A self-comparison that does not reproduce itself.
