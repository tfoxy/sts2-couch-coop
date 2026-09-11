#!/usr/bin/env node
// P8 — ANIMATION CONCURRENCY. Offline feasibility probe for the planned single-canvas mirror stage: how many
// client-side animations are live AT THE SAME TIME? That sizes the rAF tween arena the canvas stage needs — the
// DOM renderer hands each one to CSS/WAAPI and lets the compositor own it, a canvas renderer has to integrate
// every one of them itself, every frame.
//
//   node scripts/probe-canvas-anim-concurrency.mjs [recording…]      (bare names resolve against .sts2/bench)
//
// METHOD. Replay the WHOLE recording (not just the final state) and, for each applied scene-delta, open a window
// on the recording's own timeline for every animation hint it carried:
//   * `hints[]`       — MirrorTweenHint: active for `durationMs` from the delta's `t`.
//   * `cardFlights[]` — MirrorCardFlightHint: active for `windowMs` from the delta's `t` (the producer has stopped
//                       streaming those nodes for exactly that long, so the client is integrating throughout).
// Sweeping the open/close events gives the concurrency function over time; p50/p95 are TIME-WEIGHTED over the
// recording span (the fraction of wall-clock the arena held at least N animations), and max is the peak.
//
// SUPERSEDING. A tween re-issued on the same (targetId, property) REPLACES the one in flight — the client kills the
// old transition — so the deduped sweep truncates the previous window at the new one's start. That deduped number
// is the arena SLOT count; the `raw` columns keep the naive overlapping-window count for comparison. Flights are
// deduped the same way, per targetId.
//
// PINNED LOOPS are counted separately, from the FINAL state: `pinnedLoopAnim` is a declarative infinite animation
// the producer pinned to its rest value, so it costs nothing on the wire and everything on the client's clock —
// each one is an unconditional per-frame write for as long as it is set.
//
// APPROXIMATIONS:
//   * A hint with `durationMs <= 0` is given one frame (16 ms) so it registers as work rather than vanishing.
//   * The timeline is the RECORDING's `t`, i.e. host emission time. Client-side replay can start a frame or two
//     later; that shifts windows, it does not change how many overlap.
//   * A tween the client REFUSES (no resolvable endpoint) still counts here — the wire is what this probe sees.

import { printTable, replayRecording, resolveRecordings, shortName } from "./lib/mirror-probe.mjs";

const HELP = `probe-canvas-anim-concurrency.mjs — P8: concurrent tweens / card flights / pinned loops

  node scripts/probe-canvas-anim-concurrency.mjs [recording…]

  recording   NDJSON path, or a bare name resolved against .sts2/bench.
              Default: the standard probe set.
  --top N     how many tween properties to list per recording (default 5)
  --help`;

const MIN_WINDOW_MS = 16;

function parseArgs(argv) {
  const rest = [];
  let top = 5;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "--top") {
      top = Number(argv[++i]) || 5;
    } else {
      rest.push(arg);
    }
  }
  return { rest, top };
}

/** Collect [start, end) windows, optionally superseding an earlier window with the same key. */
class WindowSet {
  constructor(dedupe) {
    this.dedupe = dedupe;
    this.windows = [];
    this.open = new Map(); // key → index into `windows`
  }

  add(key, start, durationMs) {
    const end = start + Math.max(MIN_WINDOW_MS, durationMs);
    if (this.dedupe) {
      const prev = this.open.get(key);
      if (prev !== undefined) {
        const w = this.windows[prev];
        if (w.end > start) {
          w.end = start; // the re-issue killed the one in flight
        }
      }
      this.open.set(key, this.windows.length);
    }
    this.windows.push({ start, end });
  }

  /** Time-weighted concurrency over the windows: { p50, p95, max, samplesMs } (samplesMs = total covered span). */
  stats() {
    const events = [];
    for (const w of this.windows) {
      if (w.end <= w.start) {
        continue;
      }
      events.push([w.start, 1], [w.end, -1]);
    }
    if (events.length === 0) {
      return { p50: 0, p95: 0, max: 0, spanMs: 0 };
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const held = new Map(); // level → ms spent at that level
    let level = 0;
    let max = 0;
    let prevT = events[0][0];
    for (const [t, d] of events) {
      if (t > prevT) {
        held.set(level, (held.get(level) ?? 0) + (t - prevT));
        prevT = t;
      }
      level += d;
      if (level > max) {
        max = level;
      }
    }
    // p50/p95 over the ACTIVE span only (time with level 0 would swamp the percentiles on a mostly-idle screen,
    // and the question is "how deep does the arena get while it is being used").
    let activeMs = 0;
    for (const [lvl, ms] of held) {
      if (lvl > 0) {
        activeMs += ms;
      }
    }
    const levels = [...held.entries()].filter(([lvl]) => lvl > 0).sort((a, b) => a[0] - b[0]);
    const at = (p) => {
      let acc = 0;
      for (const [lvl, ms] of levels) {
        acc += ms;
        if (acc >= (p / 100) * activeMs) {
          return lvl;
        }
      }
      return levels.length > 0 ? levels[levels.length - 1][0] : 0;
    };
    return { p50: at(50), p95: at(95), max, spanMs: activeMs };
  }
}

async function analyze(recordingAbs) {
  const tweens = new WindowSet(true);
  const tweensRaw = new WindowSet(false);
  const flights = new WindowSet(true);
  const flightsRaw = new WindowSet(false);
  const both = new WindowSet(false);
  const propCounts = new Map();
  let hintCount = 0;
  let flightCount = 0;
  let zeroDuration = 0;

  const { state, lastT, deltas } = await replayRecording(recordingAbs, (delta, t) => {
    for (const hint of delta.hints) {
      hintCount++;
      if (hint.durationMs <= 0) {
        zeroDuration++;
      }
      const key = `${hint.targetId}|${hint.property}`;
      tweens.add(key, t, hint.durationMs);
      tweensRaw.add(key, t, hint.durationMs);
      both.add(key, t, hint.durationMs);
      propCounts.set(hint.property, (propCounts.get(hint.property) ?? 0) + 1);
    }
    for (const flight of delta.cardFlights) {
      flightCount++;
      flights.add(flight.targetId, t, flight.windowMs);
      flightsRaw.add(flight.targetId, t, flight.windowMs);
      both.add(flight.targetId, t, flight.windowMs);
    }
  });

  const pinned = new Map();
  let pinnedVisible = 0;
  for (const node of state.nodes.values()) {
    if (!node.pinnedLoopAnim) {
      continue;
    }
    pinned.set(node.pinnedLoopAnim, (pinned.get(node.pinnedLoopAnim) ?? 0) + 1);
    if (node.visible !== false) {
      pinnedVisible++;
    }
  }

  return {
    deltas,
    lastT,
    hintCount,
    flightCount,
    zeroDuration,
    tween: tweens.stats(),
    tweenRaw: tweensRaw.stats(),
    flight: flights.stats(),
    flightRaw: flightsRaw.stats(),
    both: both.stats(),
    propCounts,
    pinned,
    pinnedVisible
  };
}

async function main() {
  const { rest, top } = parseArgs(process.argv.slice(2));
  const recordings = resolveRecordings(rest);
  if (recordings.length === 0) {
    console.error("No recordings to analyze.");
    process.exit(2);
  }

  const rows = [];
  const details = [];
  for (const path of recordings) {
    const r = await analyze(path);
    let pinnedTotal = 0;
    for (const n of r.pinned.values()) {
      pinnedTotal += n;
    }
    rows.push({
      recording: shortName(path).replace(/\.ndjson$/, ""),
      secs: (r.lastT / 1000).toFixed(1),
      hints: r.hintCount,
      tp50: r.tween.p50,
      tp95: r.tween.p95,
      tmax: r.tween.max,
      trawmax: r.tweenRaw.max,
      flights: r.flightCount,
      fp50: r.flight.p50,
      fp95: r.flight.p95,
      fmax: r.flight.max,
      bmax: r.both.max,
      pinned: pinnedTotal,
      pinnedVis: r.pinnedVisible
    });
    details.push({ name: shortName(path).replace(/\.ndjson$/, ""), r, pinnedTotal });
  }

  console.log("\nP8 — concurrent client-side animations over the recording timeline (time-weighted p50/p95)");
  console.log("     tween/flight columns are DEDUPED per (target, property) / target; `raw` keeps the naive count.\n");
  printTable(
    [
      { key: "recording", label: "recording" },
      { key: "secs", label: "span s", align: "r" },
      { key: "hints", label: "hints", align: "r" },
      { key: "tp50", label: "tw p50", align: "r" },
      { key: "tp95", label: "tw p95", align: "r" },
      { key: "tmax", label: "tw max", align: "r" },
      { key: "trawmax", label: "tw raw max", align: "r" },
      { key: "flights", label: "flights", align: "r" },
      { key: "fp50", label: "fl p50", align: "r" },
      { key: "fp95", label: "fl p95", align: "r" },
      { key: "fmax", label: "fl max", align: "r" },
      { key: "bmax", label: "combined max", align: "r" },
      { key: "pinned", label: "pinned", align: "r" },
      { key: "pinnedVis", label: "pinned vis", align: "r" }
    ],
    rows
  );

  for (const { name, r, pinnedTotal } of details) {
    const props = [...r.propCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
    console.log(
      `\n${name} — ${r.deltas} deltas, ${r.zeroDuration} zero-duration hint(s) floored to ${MIN_WINDOW_MS}ms; ` +
        `tween-active span ${(r.tween.spanMs / 1000).toFixed(1)}s of ${(r.lastT / 1000).toFixed(1)}s`
    );
    console.log(`  top tween properties: ${props.map(([p, n]) => `${p}=${n}`).join("  ") || "(none)"}`);
    console.log(
      `  pinned loops in final state: ${pinnedTotal}` +
        (pinnedTotal > 0 ? ` (${[...r.pinned.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}, ${r.pinnedVisible} visible)` : "")
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
