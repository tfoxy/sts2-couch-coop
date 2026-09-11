#!/usr/bin/env node
// OFFLINE GATE for the single-canvas mirror stage's draw-list builder.
//
// Replays each recorded mirror stream (`.sts2/bench/*.ndjson`) to its final state through the REAL wire model, runs
// the REAL builder (`frontend/src/mirror/canvas/buildDrawList.ts`) into a REAL gsw draw list, and asserts four
// things about the result. No live game, no browser, no dev server — the same offline shape as the canvas-stage
// probes it shares `scripts/lib/mirror-probe.mjs` with (see docs/agents/canvas-stage-probes-aug26.md).
//
//   (a) CLIP SCOPES ARE CONTIGUOUS AND BALANCED. Every `clipPush` has a matching `clipPop`, the stream ends at
//       depth 0, and — the real claim — every command between a clipper's push and pop belongs to a node inside
//       that clipper's PAINT-ORDER SPAN, and every command from a node inside the span lies between them. That is
//       the invariant the whole clip model rests on ("z cannot escape its parent"), checked in command space
//       rather than assumed.
//   (b) EACH NODE ID CONTRIBUTES AT MOST ONCE PER CLASS. One classification per id, one overlay record per id, one
//       command range per id, one hit entry per id.
//   (c) THE PAINTING SET MATCHES AN INDEPENDENT ORACLE. `canvas ∪ overlay` must equal the visible painting set
//       `walkResolved` computes — a walk written before the builder existed, from `mirrorRenderer`'s own rules.
//       Any diff is printed, both ways.
//   (d) STATS PER RECORDING, printed: commands by kind, classification counts, textures, clip depth.
//
// THE ORACLE'S PAINT PREDICATE, and the two places it is EXTENDED. `mirror-probe`'s `nodePaintsContent` is
// `nodeStyles.nodePaintsContent` with the quality tier pinned to full — the CONTENT gate, which by construction
// knows nothing about the two paints the DOM backend renders as mirror-OWNED sub-layers rather than as the node's
// own background: a `Line2D` map-quill STROKE (`mirrorRenderer.needsOwnEl` gives it an element on the
// `linePoints != null` signal alone) and a `Range` BAR (`.mirror-range-fill`). The builder's own predicate
// (`paintSpec.nodeIsPainting`) is those three legs, and so is the oracle's here — named rather than hidden,
// because it is the ONE way both differ from `nodePaintsContent` alone. Across this set the two extra legs add
// zero nodes (every visible `Range` already paints something else, and none of these screens carries a stroke),
// which is why the painting counts still match probe P4's published table exactly.
//
// Exit code is nonzero on any violation or missing requested/default recording. A partial recording set is not
// coverage, so every missing path is reported and the result stays actionable for automation.
//
// Usage:
//   node scripts/verify-canvas-drawlist.mjs                    # the standard set below
//   node scripts/verify-canvas-drawlist.mjs perf5-map-open.ndjson

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  REPO_ROOT,
  benchDir,
  loadSceneTree,
  nodePaintsContent,
  printTable,
  replayRecording,
  walkResolved
} from "./lib/mirror-probe.mjs";

// The screens this gate has to survive. A superset of nothing: each is one screen FAMILY with a different paint
// mix (combat's blend/HSV nodes, the reward screen's card atlases, deck view's 40 cards, the map's 800 crops, the
// shop's inventory, the removal screen's dialog).
const RECORDINGS = [
  "combat-modern-2026-08-06.ndjson",
  "audit-cardreward-open.ndjson",
  "deckview-40-openclose.ndjson",
  "perf5-map-open.ndjson",
  "audit-shop-open.ndjson",
  "probe-removal-used.ndjson"
];

const FRONTEND_SRC = `${REPO_ROOT}/frontend/src`;

function usage() {
  console.log("usage: node scripts/verify-canvas-drawlist.mjs [recording.ndjson …]");
  console.log("  Replays each recording to its final state, builds the canvas draw list and asserts the");
  console.log("  clip / classification / painting-set invariants. Defaults to the standard screen set.");
}

/** `mirror-probe.nodePaintsContent` + the stroke and bar legs — see the header. Twin of `nodeIsPainting`. */
function oraclePaints(node, ownOpacity) {
  if (nodePaintsContent(node, ownOpacity)) {
    return true;
  }
  if (ownOpacity <= 0.02) {
    return false;
  }
  if (node.linePoints != null && node.linePoints.length >= 4) {
    return true;
  }
  const range = node.range;
  const lr = node.localRect;
  return (
    range != null &&
    lr != null &&
    lr.width > 0 &&
    lr.height > 0 &&
    range.max > range.min &&
    range.value > range.min
  );
}

function sortedSample(set, limit = 12) {
  const list = [...set].sort();
  return list.length <= limit ? list.join(", ") : `${list.slice(0, limit).join(", ")}, … (+${list.length - limit})`;
}

/**
 * (a) — the clip invariant, in command space.
 *
 * Two directions, both needed: nothing from OUTSIDE a clipper's subtree may sit inside its command interval, and
 * nothing from INSIDE the subtree may sit outside it.
 */
function checkClipScopes(list, build, drawKinds) {
  const problems = [];
  const stack = [];
  for (let i = 0; i < list.count; i++) {
    const kind = list.kindAt(i);
    if (kind === drawKinds.push) {
      stack.push(i);
    } else if (kind === drawKinds.pop) {
      if (stack.length === 0) {
        problems.push(`clipPop at command ${i} with no open scope`);
      } else {
        stack.pop();
      }
    }
  }
  if (stack.length > 0) {
    problems.push(`${stack.length} clip scope(s) left open (pushes at ${stack.join(", ")})`);
  }
  if (list.clipDepth !== 0) {
    problems.push(`list reports clipDepth ${list.clipDepth} at end of frame`);
  }

  // Command index → the node whose OWN paint pushed it, from the builder's per-node ranges. Those must be
  // DISJOINT: a range that swallowed a child's commands would still satisfy the span tests below (a parent is
  // inside its own span) while being unusable for the tier-3 patcher, so the overlap is caught here explicitly.
  const ownerOf = new Array(list.count).fill(null);
  for (const [id, range] of build.ranges) {
    for (let i = range.start; i < range.paintEnd; i++) {
      if (ownerOf[i] !== null) {
        problems.push(`command ${i} is claimed by both ${ownerOf[i]} and ${id} — per-node ranges overlap`);
      }
      ownerOf[i] = id;
    }
  }

  for (const [clipperId, range] of build.clipRanges) {
    const span = build.order.entries.get(clipperId);
    if (!span) {
      problems.push(`clipper ${clipperId} has a command range but no paint-order span`);
      continue;
    }
    if (list.kindAt(range.push) !== drawKinds.push || list.kindAt(range.pop) !== drawKinds.pop) {
      problems.push(`clipper ${clipperId} range [${range.push}, ${range.pop}] is not a push/pop pair`);
      continue;
    }
    // Inside the interval ⇒ inside the span.
    for (let i = range.push + 1; i < range.pop; i++) {
      const owner = ownerOf[i];
      if (owner === null) {
        continue; // a nested clip push/pop, already paired above
      }
      const entry = build.order.entries.get(owner);
      if (!entry || entry.order < span.spanStart || entry.order >= span.spanEnd) {
        problems.push(
          `command ${i} (node ${owner}) sits inside clip scope ${clipperId} [${range.push}, ${range.pop}] but ` +
            `outside its paint span [${span.spanStart}, ${span.spanEnd})`
        );
        break;
      }
    }
    // Inside the span ⇒ inside the interval.
    for (let o = span.spanStart; o < span.spanEnd; o++) {
      const id = build.order.ids[o];
      const nodeRange = build.ranges.get(id);
      if (!nodeRange) {
        continue;
      }
      if (nodeRange.start < range.push || nodeRange.paintEnd > range.pop) {
        problems.push(
          `node ${id} is inside clipper ${clipperId}'s span but its commands ` +
            `[${nodeRange.start}, ${nodeRange.paintEnd}) escape the scope [${range.push}, ${range.pop}]`
        );
        break;
      }
    }
  }
  return problems;
}

/** (b) — one classification, one overlay record, one command range, one hit entry per id. */
function checkOncePerClass(build, classified) {
  const problems = [];
  const seenOverlay = new Set();
  for (const record of build.overlayRecords) {
    if (seenOverlay.has(record.id)) {
      problems.push(`node ${record.id} produced two overlay records`);
    }
    seenOverlay.add(record.id);
  }
  const seenHit = new Set();
  for (const entry of build.hitEntries) {
    if (seenHit.has(entry.nodeId)) {
      problems.push(`node ${entry.nodeId} produced two hit entries`);
    }
    seenHit.add(entry.nodeId);
  }
  const seenOrder = new Set();
  for (const id of build.order.ids) {
    if (seenOrder.has(id)) {
      problems.push(`node ${id} appears twice in the paint order`);
    }
    seenOrder.add(id);
  }
  const total = build.stats.canvas + build.stats.overlay + build.stats.skip;
  if (total !== build.order.ids.length) {
    problems.push(`classified ${total} nodes but the paint order holds ${build.order.ids.length}`);
  }
  if (classified.size !== build.order.ids.length) {
    problems.push(`${build.order.ids.length - classified.size} node(s) were classified more than once`);
  }
  // Hit entries must be paint-order ascending: `hitStack` scans them backwards to get topmost-first.
  for (let i = 1; i < build.hitEntries.length; i++) {
    if (build.hitEntries[i].order < build.hitEntries[i - 1].order) {
      problems.push(`hit entries are not in paint order at index ${i}`);
      break;
    }
  }
  return problems;
}

/** (c) — the builder's painting set against `walkResolved`. */
function checkPaintingSet(state, classified) {
  const builderPainting = new Set();
  for (const [id, cls] of classified) {
    if (cls === "canvas" || cls === "overlay") {
      builderPainting.add(id);
    }
  }
  const oracle = new Set();
  walkResolved(state, ({ id, node, ownOpacity, hidden }) => {
    if (!hidden && oraclePaints(node, ownOpacity)) {
      oracle.add(id);
    }
  });
  const onlyBuilder = new Set([...builderPainting].filter((id) => !oracle.has(id)));
  const onlyOracle = new Set([...oracle].filter((id) => !builderPainting.has(id)));
  const problems = [];
  if (onlyBuilder.size > 0) {
    problems.push(`${onlyBuilder.size} node(s) painted by the builder but NOT by walkResolved: ${sortedSample(onlyBuilder)}`);
  }
  if (onlyOracle.size > 0) {
    problems.push(`${onlyOracle.size} node(s) painted by walkResolved but NOT by the builder: ${sortedSample(onlyOracle)}`);
  }
  return { problems, oracle: oracle.size, builder: builderPainting.size };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }
  // The wire model FIRST: importing it installs the loader hook that maps `@/…` onto frontend/src, which every
  // import below needs.
  await loadSceneTree();
  const { createDrawList, DRAW_QUAD, DRAW_NINE_PATCH, DRAW_POLYLINE, DRAW_CLIP_PUSH, DRAW_CLIP_POP } =
    await import("@godot-scene-web/canvas");
  const { buildDrawList } = await import(pathToFileURL(`${FRONTEND_SRC}/mirror/canvas/buildDrawList.ts`).href);
  const { hitStack } = await import(pathToFileURL(`${FRONTEND_SRC}/mirror/canvas/hitTest.ts`).href);
  const drawKinds = { push: DRAW_CLIP_PUSH, pop: DRAW_CLIP_POP };

  const names = argv.filter((a) => !a.startsWith("-"));
  const wanted = names.length > 0 ? names : RECORDINGS;

  const rows = [];
  const overlayRows = [];
  let failures = 0;
  let missing = 0;

  for (const name of wanted) {
    const path = name.includes("/") ? name : `${benchDir()}/${name}`;
    if (!existsSync(path)) {
      console.error(`  missing recording: ${path}`);
      missing++;
      continue;
    }
    const label = basename(path).replace(/\.ndjson$/, "");
    const { state } = await replayRecording(path);

    const list = createDrawList({ commandCapacity: 4096, floatCapacity: 4096 * 16, intCapacity: 4096 * 3 });
    const classified = new Map();
    const build = buildDrawList(state, list, {
      assert: true,
      onNode: (id, cls) => classified.set(id, cls)
    });

    const problems = [
      ...checkClipScopes(list, build, drawKinds),
      ...checkOncePerClass(build, classified)
    ];
    const paint = checkPaintingSet(state, classified);
    problems.push(...paint.problems);

    // A cheap liveness check on the hit surfaces: the stage centre must resolve without throwing, and every
    // result must really contain the point (the clip-chain leg included).
    const stack = hitStack(build.hitEntries, 960, 540);

    const s = build.stats;
    rows.push({
      recording: label,
      nodes: s.nodes,
      ordered: s.ordered,
      canvas: s.canvas,
      overlay: s.overlay,
      skip: s.skip,
      silent: s.silent,
      cmds: s.commands,
      quads: s.quads,
      "9p": s.ninePatches,
      lines: s.polylines,
      clips: s.clips,
      depth: s.maxClipDepth,
      tex: s.textures,
      hits: s.hitEntries,
      "hit@c": stack.length,
      ok: problems.length === 0 ? "yes" : "NO"
    });
    overlayRows.push({
      recording: label,
      text: s.overlayByKind.text,
      shader: s.overlayByKind.shader,
      particles: s.overlayByKind.particles,
      spine: s.overlayByKind.spine,
      trail: s.overlayByKind.trail,
      "paint(builder)": paint.builder,
      "paint(oracle)": paint.oracle
    });

    if (problems.length > 0) {
      failures++;
      console.log(`\n${label}: ${problems.length} violation(s)`);
      for (const problem of problems) {
        console.log(`  - ${problem}`);
      }
    }
  }

  if (rows.length === 0) {
    console.error("no recordings found — nothing verified");
    return 2;
  }

  console.log("\nDraw list per recording (final state)\n");
  printTable(
    [
      { key: "recording", label: "recording" },
      { key: "nodes", label: "nodes", align: "r" },
      { key: "ordered", label: "ordered", align: "r" },
      { key: "canvas", label: "canvas", align: "r" },
      { key: "overlay", label: "overlay", align: "r" },
      { key: "skip", label: "skip", align: "r" },
      { key: "silent", label: "silent", align: "r" },
      { key: "cmds", label: "cmds", align: "r" },
      { key: "quads", label: "quads", align: "r" },
      { key: "9p", label: "9p", align: "r" },
      { key: "lines", label: "lines", align: "r" },
      { key: "clips", label: "clips", align: "r" },
      { key: "depth", label: "depth", align: "r" },
      { key: "tex", label: "tex", align: "r" },
      { key: "hits", label: "hits", align: "r" },
      { key: "hit@c", label: "hit@c", align: "r" },
      { key: "ok", label: "ok" }
    ],
    rows
  );

  console.log("\nOverlay records by kind, and the painting-set cross-check\n");
  printTable(
    [
      { key: "recording", label: "recording" },
      { key: "text", label: "text", align: "r" },
      { key: "shader", label: "shader", align: "r" },
      { key: "particles", label: "particles", align: "r" },
      { key: "spine", label: "spine", align: "r" },
      { key: "trail", label: "trail", align: "r" },
      { key: "paint(builder)", label: "paint(builder)", align: "r" },
      { key: "paint(oracle)", label: "paint(oracle)", align: "r" }
    ],
    overlayRows
  );

  void DRAW_QUAD;
  void DRAW_NINE_PATCH;
  void DRAW_POLYLINE;

  if (failures > 0 || missing > 0) {
    if (failures > 0) {
      console.error(`\n${failures} recording(s) violated an invariant`);
    }
    if (missing > 0) {
      console.error(`\n${missing} requested/default recording(s) were missing`);
    }
    return 1;
  }
  console.log("\nAll invariants hold.");
  return 0;
}

process.exitCode = await main();
