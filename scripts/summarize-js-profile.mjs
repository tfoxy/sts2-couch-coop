#!/usr/bin/env node
// Node port of cc-profile-sol-sep29's .sts2/bench/canvas-profile/analyze-v8.py for the raw CDP
// `Profiler.Profile` JSON scripts/bench-mirror-replay.mjs writes under `.sts2/bench/profiles/` with
// `--js-profile <name>`. Top-N functions by SELF (leaf) sample count and by INCLUSIVE (appears anywhere in
// the sampled stack) sample count, each with its url:line, plus a split of every sample's leaf frame into
// JS / Wasm / GC / (program) / (idle).
//
// SAMPLE COUNTS ONLY — never milliseconds. V8's `timeDeltas` for a CDP profile are known to go non-monotonic
// (see MEMORY.md "Rust desktop CDP profile invalid Sep-28" / replay-clock-provenance), so converting a sample
// count to a duration here would be exactly the invalid move; `timeDeltas` is reported only as a validity
// diagnostic (how many entries are non-positive), never multiplied into an attribution.
//
// Usage: node scripts/summarize-js-profile.mjs <v8-profile.json> [--top 20] [--json] [--out <report.json>]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(`summarize-js-profile: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const a = { profile: null, top: 20, json: false, out: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--profile": a.profile = argv[++i]; break;
      case "--top": a.top = Number(argv[++i]); break;
      case "--json": a.json = true; break;
      case "--out": a.out = argv[++i]; break;
      case "--help": case "-h": a.help = true; break;
      default:
        if (arg.startsWith("--")) fail(`unknown argument: ${arg}`);
        positional.push(arg);
    }
  }
  if (!a.profile && positional.length) a.profile = positional[0];
  return a;
}

function frameLabel(callFrame) {
  const name = callFrame?.functionName || "(anonymous)";
  const url = callFrame?.url || "";
  if (!url) return name;
  const line = (callFrame.lineNumber ?? -1) + 1;
  return `${name} ${url}:${line}`;
}

function categorize(callFrame) {
  const name = callFrame?.functionName || "";
  const url = callFrame?.url || "";
  if (name === "(garbage collector)") return "gc";
  if (name === "(program)") return "program";
  if (name === "(idle)") return "idle";
  if (/\.wasm(?:[?#]|$)/i.test(url) || /^wasm:\/\//i.test(url) || /wasm-function/i.test(name)) return "wasm";
  return "js";
}

export function summarizeV8Profile(profile, { top = 20 } = {}) {
  const nodes = new Map((profile.nodes ?? []).map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes ?? []) {
    for (const childId of n.children ?? []) parent.set(childId, n.id);
  }
  const samples = profile.samples ?? [];
  const timeDeltas = profile.timeDeltas ?? [];

  const selfCounts = new Map(); // label -> count
  const inclusiveCounts = new Map(); // label -> count
  const categoryCounts = new Map([["js", 0], ["wasm", 0], ["gc", 0], ["program", 0], ["idle", 0]]);
  let unresolved = 0;

  for (const nodeId of samples) {
    const node = nodes.get(nodeId);
    if (!node) { unresolved++; continue; }
    const leafLabel = frameLabel(node.callFrame);
    selfCounts.set(leafLabel, (selfCounts.get(leafLabel) ?? 0) + 1);
    categoryCounts.set(categorize(node.callFrame), (categoryCounts.get(categorize(node.callFrame)) ?? 0) + 1);

    // Inclusive here means standard profiler "total samples": every frame on the sampled stack, the LEAF
    // included, gets +1 once per sample (deduped per sample so a recursive frame is not double-counted). The
    // ported analyze-v8.py instead starts one frame up (its `caller` counter excludes the leaf) — this walk
    // starts at the leaf itself on purpose, which is the more standard reading of "inclusive".
    const seenLabels = new Set();
    let id = nodeId;
    const visited = new Set();
    while (id != null && !visited.has(id)) {
      visited.add(id);
      const ancestor = nodes.get(id);
      if (ancestor) {
        const label = frameLabel(ancestor.callFrame);
        if (!seenLabels.has(label)) {
          inclusiveCounts.set(label, (inclusiveCounts.get(label) ?? 0) + 1);
          seenLabels.add(label);
        }
      }
      id = parent.get(id);
    }
  }

  const topN = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([label, count]) => ({ label, count }));

  const nonpositive = timeDeltas.filter((v) => v <= 0).length;
  const negative = timeDeltas.filter((v) => v < 0).length;

  return {
    schema: "v8-profile-summary/1",
    sampleCount: samples.length,
    nodeCount: nodes.size,
    unresolvedNodeIds: unresolved,
    categories: Object.fromEntries(categoryCounts),
    exclusiveSelfSamplesTop: topN(selfCounts),
    inclusiveSamplesTop: topN(inclusiveCounts),
    timeDeltasDiagnostic: {
      count: timeDeltas.length,
      nonpositive,
      negative,
      valid: nonpositive === 0,
      note: "diagnostic only — a CDP profile's timeDeltas are known to go non-monotonic; never convert a sample count to ms from this",
    },
  };
}

function printTable(result) {
  console.log(`samples: ${result.sampleCount}  nodes: ${result.nodeCount}  unresolved: ${result.unresolvedNodeIds}`);
  console.log(`categories (by SAMPLE's leaf frame): ${Object.entries(result.categories).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`timeDeltas: ${result.timeDeltasDiagnostic.count} entries, ${result.timeDeltasDiagnostic.nonpositive} non-positive ` +
    `(${result.timeDeltasDiagnostic.valid ? "monotonic" : "NON-MONOTONIC — diagnostic only, no ms derived anywhere in this report"})`);
  console.log("");
  console.log("=== top self (exclusive) SAMPLE COUNTS ===");
  for (const row of result.exclusiveSelfSamplesTop) console.log(`  ${String(row.count).padStart(6)}  ${row.label}`);
  console.log("");
  console.log("=== top inclusive (in-stack) SAMPLE COUNTS ===");
  for (const row of result.inclusiveSamplesTop) console.log(`  ${String(row.count).padStart(6)}  ${row.label}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.profile) {
    console.log("usage: summarize-js-profile.mjs <v8-profile.json> [--top 20] [--json] [--out <report.json>]");
    process.exit(args.help ? 0 : 2);
  }
  const profile = JSON.parse(readFileSync(resolve(args.profile), "utf8"));
  const result = summarizeV8Profile(profile, { top: args.top });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printTable(result);
  if (args.out) writeFileSync(resolve(args.out), JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
