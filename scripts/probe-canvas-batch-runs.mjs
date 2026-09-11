#!/usr/bin/env node
// P4 — CANVAS DRAW-BATCH RUNS. Offline feasibility probe for the planned single-canvas mirror stage: how many
// distinct draw batches would a naive "walk paint order, draw each node" canvas builder issue per screen?
//
//   node scripts/probe-canvas-batch-runs.mjs [recording…]      (bare names resolve against .sts2/bench)
//
// METHOD. Replay each recording to its FINAL state through the real wire model (frontend/src/mirror/sceneTree.ts),
// walk the resolved tree in paint order, keep the nodes that PAINT (nodeStyles' `nodePaintsContent`, plus the
// visibility/opacity gating the renderer's walk applies), and give each one a BATCH KEY:
//
//     (paint source, canvas blend mode, innermost clip ancestor id, has-HSV-shader)
//
// where paint source is the texture PAGE url, or "text" / "spine" / "particles" / "solid". Two ADJACENT nodes with
// the same key can be drawn in one batch; a key change is a batch boundary. The batch count is therefore the number
// of CONSECUTIVE RUNS over the paint-ordered list — the metric that decides whether the canvas builder can get away
// with drawing in tree order or needs a reordering/bucketing pass.
//
// APPROXIMATIONS (stated so the numbers are read correctly):
//   * PAINT ORDER = `orderedIds`, the producer's pre-order DFS. Godot additionally sorts siblings by `z_index` and
//     lifts `show_behind_parent` children, so the true order permutes a few nodes within each parent. That can only
//     make runs SHORTER or LONGER locally; it does not change the order of magnitude.
//   * A batch key change is counted even when the two neighbours do not overlap on screen. A real builder can
//     sometimes merge non-overlapping runs; this is the conservative (upper-bound) count.
//   * Quality tier is pinned to "shaders on / spines on" (a full-quality device). A degraded tier paints strictly
//     fewer nodes.

import {
  isHsvShaderNode,
  nodePaintsContent,
  paintSource,
  printTable,
  replayRecording,
  resolveRecordings,
  shortName,
  walkResolved
} from "./lib/mirror-probe.mjs";

const HELP = `probe-canvas-batch-runs.mjs — P4: draw-batch runs for a single-canvas mirror stage

  node scripts/probe-canvas-batch-runs.mjs [recording…]

  recording   NDJSON path, or a bare name resolved against .sts2/bench.
              Default: the standard probe set (combat / card reward / deck view / map open /
              map scroll / reshuffle / removal / shop).
  --top N     how many run-breaking transitions to list per recording (default 6)
  --help`;

function parseArgs(argv) {
  const rest = [];
  let top = 6;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "--top") {
      top = Number(argv[++i]) || 6;
    } else {
      rest.push(arg);
    }
  }
  return { rest, top };
}

// What CHANGED between two adjacent batch keys — the reason the run broke.
function breakReason(prev, next) {
  const reasons = [];
  if (prev.source !== next.source) {
    reasons.push(`source ${sourceLabel(prev.source)}→${sourceLabel(next.source)}`);
  }
  if (prev.blend !== next.blend) {
    reasons.push(`blend ${prev.blend}→${next.blend}`);
  }
  if (prev.clip !== next.clip) {
    reasons.push("clip");
  }
  if (prev.hsv !== next.hsv) {
    reasons.push(`hsv ${prev.hsv ? 1 : 0}→${next.hsv ? 1 : 0}`);
  }
  return reasons.join(" + ") || "(none)";
}

function sourceLabel(source) {
  return source.startsWith("texture:") ? shortName(source.slice("texture:".length)) : source;
}

async function analyze(recordingAbs, top) {
  const { state } = await replayRecording(recordingAbs);
  const painted = [];
  // How far the pre-order approximation could be off: the painting nodes that carry a non-zero `z_index` or
  // `show_behind_parent`, i.e. the ones Godot would sort out of their DFS position within their parent.
  let zNodes = 0;
  let behindNodes = 0;
  walkResolved(state, (v) => {
    if (v.hidden || !nodePaintsContent(v.node, v.ownOpacity)) {
      return;
    }
    if (v.node.zIndex) {
      zNodes++;
    }
    if (v.node.showBehindParent) {
      behindNodes++;
    }
    painted.push({
      id: v.id,
      node: v.node,
      key: {
        source: paintSource(v.node),
        blend: v.node.canvasBlendMode ?? 0,
        clip: v.clipId,
        hsv: isHsvShaderNode(v.node)
      }
    });
  });

  let runs = painted.length > 0 ? 1 : 0;
  const reasonCounts = new Map();
  const sourceCounts = new Map();
  for (let i = 1; i < painted.length; i++) {
    const prev = painted[i - 1].key;
    const next = painted[i].key;
    if (prev.source === next.source && prev.blend === next.blend && prev.clip === next.clip && prev.hsv === next.hsv) {
      continue;
    }
    runs++;
    const reason = breakReason(prev, next);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  for (const p of painted) {
    const s = p.key.source.startsWith("texture:") ? "texture" : p.key.source;
    sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1);
  }

  // How much of the break count is attributable to each key AXIS on its own (a break can name several).
  const axis = { source: 0, blend: 0, clip: 0, hsv: 0 };
  for (let i = 1; i < painted.length; i++) {
    const prev = painted[i - 1].key;
    const next = painted[i].key;
    if (prev.source !== next.source) axis.source++;
    if (prev.blend !== next.blend) axis.blend++;
    if (prev.clip !== next.clip) axis.clip++;
    if (prev.hsv !== next.hsv) axis.hsv++;
  }

  // The batch count a builder could reach if it were free to REORDER within the paint-safe limit — the number of
  // DISTINCT keys. The gap between this and `runs` is exactly what a bucketing pass would buy.
  const distinctKeys = new Set(painted.map((p) => `${p.key.source}|${p.key.blend}|${p.key.clip}|${p.key.hsv}`)).size;

  const topReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);

  return {
    painting: painted.length,
    runs,
    distinctKeys,
    perRun: painted.length > 0 ? (painted.length / runs).toFixed(2) : "0",
    axis,
    sourceCounts,
    topReasons,
    zNodes,
    behindNodes
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
    const r = await analyze(path, top);
    rows.push({
      recording: shortName(path).replace(/\.ndjson$/, ""),
      painting: r.painting,
      runs: r.runs,
      keys: r.distinctKeys,
      perRun: r.perRun,
      src: r.axis.source,
      blend: r.axis.blend,
      clip: r.axis.clip,
      hsv: r.axis.hsv,
      zOrder: `${r.zNodes}/${r.behindNodes}`
    });
    details.push({ name: shortName(path).replace(/\.ndjson$/, ""), r });
  }

  console.log("\nP4 — draw-batch runs over the FINAL state, paint order = orderedIds (pre-order DFS)\n");
  printTable(
    [
      { key: "recording", label: "recording" },
      { key: "painting", label: "painting", align: "r" },
      { key: "runs", label: "runs", align: "r" },
      { key: "keys", label: "distinct keys", align: "r" },
      { key: "perRun", label: "nodes/run", align: "r" },
      { key: "src", label: "brk:src", align: "r" },
      { key: "blend", label: "brk:blend", align: "r" },
      { key: "clip", label: "brk:clip", align: "r" },
      { key: "hsv", label: "brk:hsv", align: "r" },
      { key: "zOrder", label: "z!=0/behind", align: "r" }
    ],
    rows
  );

  for (const { name, r } of details) {
    console.log(`\n${name} — paint sources: ${[...r.sourceCounts.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
    console.log(`  top run-breaking transitions (of ${r.runs - 1} breaks):`);
    for (const [reason, count] of r.topReasons) {
      console.log(`    ${String(count).padStart(4)}  ${reason}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
