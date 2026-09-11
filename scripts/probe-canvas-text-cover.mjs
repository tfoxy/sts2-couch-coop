#!/usr/bin/env node
// P6 — TEXT OCCLUSION UNDER A DOM-TEXT OVERLAY. Offline feasibility probe for the interim stage of the planned
// single-canvas mirror renderer, in which everything BUT text is painted into one canvas and text keeps being real
// DOM on top. Any node that paints ABOVE a text node in the game's paint order would then be drawn UNDER the
// overlay instead — the visible wrongness that decides how long that interim can live.
//
//   node scripts/probe-canvas-text-cover.mjs [recording…]      (bare names resolve against .sts2/bench)
//
// METHOD. Replay each recording to its FINAL state, walk the resolved tree in paint order, and for every VISIBLE
// text node (`node.text != null`, not hidden, own alpha above the paint threshold) compute its screen AABB from
// `global x localRect`. Then count the visible PAINTING nodes that come LATER in paint order and whose own AABB
// intersects it. Text-on-text overlaps are reported separately: two DOM text nodes still layer correctly against
// each other, so only the NON-TEXT coverers are real regressions.
//
// APPROXIMATIONS:
//   * AABB, not shape. A coverer whose bounding box grazes a label's box but whose painted pixels do not is
//     counted — so this is an UPPER bound on how many things could look wrong.
//   * Paint order = `orderedIds` (pre-order DFS); Godot also sorts by z_index / show_behind_parent within a
//     parent, which permutes a few neighbours. See P4's note.
//   * Text nodes with no `localRect` (none observed, but possible) are skipped and counted.
//   * A coverer is counted per (text, coverer) pair regardless of how much area it overlaps.
//   * `nodePaintsContent` cannot know how much of its box a SHADER actually covers, so a full-screen shader
//     overlay sitting at "nothing drawn" still reads as painting and covers every label under it. The `-fs`
//     columns repeat the count with FULL-SCREEN coverers (AABB containing the whole 1920x1080 design rect)
//     dropped, which is the honest floor; the plain columns are the ceiling.

import {
  aabbIntersects,
  nodePaintsContent,
  paintSource,
  printTable,
  replayRecording,
  resolveRecordings,
  sceneFileOf,
  screenAabb,
  shortName,
  walkResolved
} from "./lib/mirror-probe.mjs";

const HELP = `probe-canvas-text-cover.mjs — P6: how many painting nodes sit ABOVE a text node

  node scripts/probe-canvas-text-cover.mjs [recording…]

  recording   NDJSON path, or a bare name resolved against .sts2/bench.
              Default: the standard probe set.
  --top N     how many offender pairs to list per recording (default 6)
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

async function analyze(recordingAbs) {
  const { state } = await replayRecording(recordingAbs);
  const painting = [];
  walkResolved(state, (v) => {
    if (v.hidden || !nodePaintsContent(v.node, v.ownOpacity)) {
      return;
    }
    painting.push({ id: v.id, node: v.node, aabb: screenAabb(v.global, v.node.localRect) });
  });

  const textIdx = [];
  let noBox = 0;
  for (let i = 0; i < painting.length; i++) {
    if (painting[i].node.text == null) {
      continue;
    }
    if (!painting[i].aabb) {
      noBox++;
      continue;
    }
    textIdx.push(i);
  }

  const histogram = new Map();
  const pairs = new Map();
  let covered = 0;
  let coverersTotal = 0;
  let textOnText = 0;
  let maxCoverers = 0;
  let coveredFs = 0;
  let coverersTotalFs = 0;
  let maxCoverersFs = 0;

  for (const i of textIdx) {
    const text = painting[i];
    let n = 0;
    let nFs = 0;
    for (let j = i + 1; j < painting.length; j++) {
      const other = painting[j];
      if (!other.aabb || !aabbIntersects(text.aabb, other.aabb)) {
        continue;
      }
      if (other.node.text != null) {
        textOnText++;
        continue; // both live in the DOM overlay — they still layer correctly against each other
      }
      n++;
      if (!isFullScreen(other.aabb)) {
        nFs++;
      }
      const key = `${text.node.nodeType || "?"} ← ${other.node.nodeType || "?"} [${shortName(sceneFileOf(other.node, state.nodes))}] ${sourceLabel(other.node)}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    coverersTotal += n;
    coverersTotalFs += nFs;
    if (n > 0) {
      covered++;
    }
    if (nFs > 0) {
      coveredFs++;
    }
    if (n > maxCoverers) {
      maxCoverers = n;
    }
    if (nFs > maxCoverersFs) {
      maxCoverersFs = nFs;
    }
    const bucket = nFs === 0 ? "0" : nFs <= 2 ? "1-2" : nFs <= 5 ? "3-5" : nFs <= 10 ? "6-10" : "11+";
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
  }

  return {
    texts: textIdx.length,
    noBox,
    covered,
    coverersTotal,
    coveredFs,
    coverersTotalFs,
    maxCoverersFs,
    textOnText,
    maxCoverers,
    histogram,
    topPairs: [...pairs.entries()].sort((a, b) => b[1] - a[1])
  };
}

// A coverer whose AABB contains the whole 1920x1080 design rect — a full-screen backdrop/overlay. Reported
// separately because the biggest single contributor in every recording is one such node whose SHADER is at
// "nothing drawn": it costs the interim overlay nothing on screen, but no wire field says so.
function isFullScreen(aabb) {
  return aabb.minX <= 0.5 && aabb.minY <= 0.5 && aabb.maxX >= 1919.5 && aabb.maxY >= 1079.5;
}

function sourceLabel(node) {
  const source = paintSource(node);
  return source.startsWith("texture:") ? shortName(source.slice("texture:".length)) : source;
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
    rows.push({
      recording: shortName(path).replace(/\.ndjson$/, ""),
      texts: r.texts,
      covered: r.covered,
      pct: r.texts > 0 ? `${((100 * r.covered) / r.texts).toFixed(0)}%` : "-",
      coverers: r.coverersTotal,
      max: r.maxCoverers,
      coveredFs: r.coveredFs,
      pctFs: r.texts > 0 ? `${((100 * r.coveredFs) / r.texts).toFixed(0)}%` : "-",
      coverersFs: r.coverersTotalFs,
      maxFs: r.maxCoverersFs,
      h0: r.histogram.get("0") ?? 0,
      h12: r.histogram.get("1-2") ?? 0,
      h35: r.histogram.get("3-5") ?? 0,
      h610: r.histogram.get("6-10") ?? 0,
      h11: r.histogram.get("11+") ?? 0,
      tot: r.textOnText
    });
    details.push({ name: shortName(path).replace(/\.ndjson$/, ""), r });
  }

  console.log("\nP6 — visible text nodes with NON-TEXT painting nodes above them (FINAL state, AABB overlap)");
  console.log("     `-fs` columns drop full-screen coverers; the =0/1-2/… histogram is over the -fs counts.\n");
  printTable(
    [
      { key: "recording", label: "recording" },
      { key: "texts", label: "text", align: "r" },
      { key: "covered", label: "covered", align: "r" },
      { key: "pct", label: "%", align: "r" },
      { key: "coverers", label: "coverers", align: "r" },
      { key: "max", label: "max/text", align: "r" },
      { key: "coveredFs", label: "cov-fs", align: "r" },
      { key: "pctFs", label: "%-fs", align: "r" },
      { key: "coverersFs", label: "cov'ers-fs", align: "r" },
      { key: "maxFs", label: "max-fs", align: "r" },
      { key: "h0", label: "=0", align: "r" },
      { key: "h12", label: "1-2", align: "r" },
      { key: "h35", label: "3-5", align: "r" },
      { key: "h610", label: "6-10", align: "r" },
      { key: "h11", label: "11+", align: "r" },
      { key: "tot", label: "text/text", align: "r" }
    ],
    rows
  );

  for (const { name, r } of details) {
    if (r.noBox > 0) {
      console.log(`\n${name} — ${r.noBox} text node(s) skipped (no localRect)`);
    }
    console.log(`\n${name} — top ${Math.min(top, r.topPairs.length)} offender pairs (text nodeType <- coverer nodeType [scene] source):`);
    for (const [key, count] of r.topPairs.slice(0, top)) {
      console.log(`    ${String(count).padStart(4)}  ${key}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
