#!/usr/bin/env node
// THE HIT-TEST PARITY GATE — does the single-canvas backend answer "what is under this point" the way the DOM
// backend does?
//
// WHY A DUAL RUN RATHER THAN A `?hitTest=both` LEVER. A one-page `both` mode would have to run the DOM probe
// beside the canvas one — and the canvas arm has NO scene DOM to probe. There is nothing for
// `elementsFromPoint` to return, so the second opinion has to come from a second RUN. Both backends implement
// the same three seams (`touchStackAt` / `spreadPainterAt` / `mapNodeAt`) behind the same `MirrorRenderer`
// interface, so `bench-mirror-replay.mjs --hit-grid` samples the identical grid through the identical code on
// each arm and this diffs the two files. Nothing about the comparison is backend-specific.
//
// WHAT IS COMPARED, per sampled point:
//   TOP        — the topmost id the stack resolved to. This is the one that decides where a tap goes, so it is
//                the headline agreement number.
//   BLOCKED    — the stack's "an occluder is in the way" verdict, which gates the confirm/focus branches.
//   PAINTER    — `spreadPainterAt`, the wide-screen anchor map's painter at the point.
//   MAP NODE   — `mapNodeAt`, the map-point identity a tap on the map resolves to.
//   DEPTH      — how many surfaces the stack found. Reported for context, not as a pass/fail: the DOM stack is
//                built from `elementsFromPoint`, which returns mirror-OWNED sub-layers (`.mirror-atlas-region`,
//                a self layer) as separate elements, while the draw list has one hit entry per NODE. Depth is
//                therefore expected to differ; the TOP is not.
//
// A TOP mismatch is grouped by the pair of node TYPES involved, because that is what says whether it is the
// pre-registered z-order class (a) — the canvas backend sorts siblings by `z_index` and lifts show-behind-parent
// children, the DOM backend resolves through CSS stacking — or a real hit-test bug.
//
// Usage:
//   node scripts/compare-hit-grids.mjs <canvas.hits.txt> <dom.hits.txt>
//   node scripts/compare-hit-grids.mjs a.txt b.txt --top 20 --json

import { readFileSync } from "node:fs";
import { basename } from "node:path";

function usage() {
  console.log("usage: node scripts/compare-hit-grids.mjs <a.hits.txt> <b.hits.txt> [--top n] [--json]");
}

function parseGrid(path) {
  const meta = {};
  const points = new Map();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      const m = /^#\s*([A-Za-z]+)=(.*)$/.exec(line);
      if (m) meta[m[1]] = m[2];
      continue;
    }
    const parts = line.split(" ");
    if (parts[0] !== "P") continue;
    const at = parts[1];
    const f = {};
    for (const token of parts.slice(2)) {
      const eq = token.indexOf("=");
      if (eq > 0) f[token.slice(0, eq)] = token.slice(eq + 1);
    }
    points.set(at, {
      at,
      top: f.top ?? "-",
      depth: Number(f.depth ?? 0),
      blocked: f.blocked ?? "-",
      painter: f.painter ?? "-",
      map: f.map ?? "-",
      confirm: f.confirm ?? "-",
      cover: f.cover ?? "-",
      stack: (f.stack ?? "-").split(">")
    });
  }
  return { path, meta, points };
}

function pct(n, d) {
  return d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : "-";
}

function table(rows, columns) {
  if (rows.length === 0) return;
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? "").length)));
  const pad = (s, w, right) => (right ? String(s).padStart(w) : String(s).padEnd(w));
  console.log("  " + columns.map((c, i) => pad(c.label, widths[i], c.align === "r")).join("  "));
  console.log("  " + columns.map((_, i) => "-".repeat(widths[i])).join("  "));
  for (const r of rows) {
    console.log("  " + columns.map((c, i) => pad(r[c.key] ?? "", widths[i], c.align === "r")).join("  "));
  }
}

function main() {
  const argv = process.argv.slice(2);
  const files = argv.filter((a) => !a.startsWith("--"));
  const wantJson = argv.includes("--json");
  const topN = (() => {
    const i = argv.indexOf("--top");
    return i >= 0 ? Number(argv[i + 1]) : 12;
  })();
  if (argv.includes("--help") || argv.includes("-h") || files.length !== 2) {
    usage();
    return files.length === 2 ? 0 : 2;
  }
  const [first, second] = files.map(parseGrid);
  const canvas = first.meta.backend === "canvas" ? first : second;
  const dom = canvas === first ? second : first;
  if (canvas.meta.backend !== "canvas" || dom.meta.backend !== "dom") {
    console.error(`expected one canvas grid and one dom grid (got ${first.meta.backend} / ${second.meta.backend})`);
    return 2;
  }
  if (canvas.meta.recording !== dom.meta.recording) {
    console.error(`different recordings: ${canvas.meta.recording} vs ${dom.meta.recording}`);
    return 2;
  }

  let shared = 0;
  let topAgree = 0;
  let blockedAgree = 0;
  let painterAgree = 0;
  let mapAgree = 0;
  let depthAgree = 0;
  // A canvas TOP that is somewhere in the DOM's stack (or vice versa) is a REORDER, not a miss: both backends
  // found the same surfaces and disagreed about which is on top — exactly the shape of the z-order class.
  let topReorder = 0;
  let confirmAgree = 0;
  let coverAgree = 0;
  const mismatches = [];
  const confirmMismatches = [];

  for (const [at, c] of canvas.points) {
    const d = dom.points.get(at);
    if (!d) continue;
    shared++;
    if (c.top === d.top) topAgree++;
    else {
      const reorder = d.stack.includes(c.top) || c.stack.includes(d.top);
      if (reorder) topReorder++;
      mismatches.push({ at, canvas: c.top, dom: d.top, reorder, cDepth: c.depth, dDepth: d.depth });
    }
    if (c.blocked === d.blocked) blockedAgree++;
    if (c.painter === d.painter) painterAgree++;
    if (c.map === d.map) mapAgree++;
    if (c.depth === d.depth) depthAgree++;
    if (c.confirm === d.confirm) confirmAgree++;
    else confirmMismatches.push({ at, canvas: c.confirm, dom: d.confirm });
    if (c.cover === d.cover) coverAgree++;
  }

  console.log(`\n${basename(canvas.path)}  vs  ${basename(dom.path)}`);
  console.log(
    `  recording ${canvas.meta.recording}   viewport ${canvas.meta.viewport}   step ${canvas.meta.step}px` +
      `   canvas ${canvas.points.size} samples / dom ${dom.points.size}   shared ${shared}`
  );

  console.log("\nAGREEMENT");
  table(
    [
      { seam: "touchStackAt top id", agree: topAgree, rate: pct(topAgree, shared), note: `${topReorder} of the ${shared - topAgree} mismatches are REORDERS (class a)` },
      { seam: "touchStackAt + reorders", agree: topAgree + topReorder, rate: pct(topAgree + topReorder, shared), note: "same surfaces found, order differs" },
      { seam: "touchStackAt blocked", agree: blockedAgree, rate: pct(blockedAgree, shared), note: "" },
      { seam: "spreadPainterAt", agree: painterAgree, rate: pct(painterAgree, shared), note: "" },
      { seam: "mapNodeAt", agree: mapAgree, rate: pct(mapAgree, shared), note: "" },
      { seam: "confirmTapAt", agree: confirmAgree, rate: pct(confirmAgree, shared), note: "would a tap here raise a confirm button" },
      { seam: "coverAbove", agree: coverAgree, rate: pct(coverAgree, shared), note: "and would it be sunk under an overlay" },
      { seam: "stack depth (context only)", agree: depthAgree, rate: pct(depthAgree, shared), note: "DOM counts sub-layers, the draw list counts NODES" }
    ],
    [
      { key: "seam", label: "seam" },
      { key: "agree", label: "agree", align: "r" },
      { key: "rate", label: "rate", align: "r" },
      { key: "note", label: "note" }
    ]
  );

  if (mismatches.length > 0) {
    console.log(`\nTOP-ID MISMATCHES (${mismatches.length}; top ${Math.min(topN, mismatches.length)} shown)`);
    table(
      mismatches.slice(0, topN).map((m) => ({
        at: m.at,
        canvas: m.canvas,
        dom: m.dom,
        depth: `${m.cDepth}/${m.dDepth}`,
        cls: m.reorder ? "reorder (a)" : "DISJOINT — investigate"
      })),
      [
        { key: "at", label: "design x,y" },
        { key: "canvas", label: "canvas top" },
        { key: "dom", label: "dom top" },
        { key: "depth", label: "depth c/d", align: "r" },
        { key: "cls", label: "class" }
      ]
    );
  }

  if (confirmMismatches.length > 0) {
    console.log(`\nCONFIRM-TAP MISMATCHES (${confirmMismatches.length}; top ${Math.min(topN, confirmMismatches.length)} shown)`);
    table(confirmMismatches.slice(0, topN), [
      { key: "at", label: "design x,y" },
      { key: "canvas", label: "canvas kind:id" },
      { key: "dom", label: "dom kind:id" }
    ]);
  }

  const summary = {
    recording: canvas.meta.recording,
    viewport: canvas.meta.viewport,
    step: Number(canvas.meta.step),
    samples: shared,
    topAgree,
    topAgreePct: shared > 0 ? Math.round((topAgree / shared) * 1000) / 10 : null,
    topReorder,
    topDisjoint: mismatches.filter((m) => !m.reorder).length,
    blockedAgree,
    painterAgree,
    mapAgree,
    confirmAgree,
    confirmMismatched: confirmMismatches.length,
    coverAgree
  };
  if (wantJson) console.log("\nHIT_DIFF " + JSON.stringify(summary));
  console.log("");
  return 0;
}

process.exitCode = main();
