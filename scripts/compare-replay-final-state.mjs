#!/usr/bin/env node
// Cross-language STATE-PARITY check for the mirror scene-delta stream: replay ONE recorded NDJSON through both
// the WEB client model (frontend/src/mirror/sceneTree.ts, in-process) and the native Godot client
// (--replay --dump-final-state via the pinned 4.5.1 editor binary), compute the SAME final-state summary on each
// side, and diff them. Exit 0 with a PASS line on a match; non-zero with a field-by-field diff on a mismatch.
//
//   node scripts/compare-replay-final-state.mjs --recording .sts2/bench/combat-2026-07-15T16-40-09-999Z.ndjson
//
// The summary (both sides): { nodeCount, orderedIdsCount, orderedIdsFnv1a (32-bit FNV-1a over the newline-joined
// orderedIds), nodeTypeCounts (per-nodeType counts), revision }.
//
// TS execution uses mirror-probe's alias-aware loader because sceneTree.ts has runtime imports. Godot binary:
// $GODOT_BIN or the pinned default below.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { loadSceneTree, REPO_ROOT } from "./lib/mirror-probe.mjs";
import { requireReproHeader } from "./lib/repro-recording.mjs";

const DEFAULT_GODOT = resolve(
  homedir(),
  ".local/godot-4.5.1-mono/Godot_v4.5.1-stable_mono_linux_x86_64/Godot_v4.5.1-stable_mono_linux.x86_64"
);

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { recording: ".sts2/bench/combat-2026-07-15T16-40-09-999Z.ndjson", godot: process.env.GODOT_BIN ?? DEFAULT_GODOT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [key, inlineVal] = eq > 0 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const val = () => inlineVal ?? argv[++i];
    switch (key) {
      case "--recording": a.recording = val(); break;
      case "--godot": a.godot = val(); break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`Unknown argument: ${arg}`); a.help = true;
    }
  }
  return a;
}

const HELP = `compare-replay-final-state.mjs — cross-language mirror replay state-parity check

  --recording <path>   NDJSON recording (default .sts2/bench/combat-2026-07-15T16-40-09-999Z.ndjson)
  --godot <path>       Godot 4.5.1 mono editor binary (default: pinned; or $GODOT_BIN)
  --help`;

// ---------------------------------------------------------------------------------------------------------
// shared summary helpers
// ---------------------------------------------------------------------------------------------------------

// FNV-1a 32-bit over the UTF-8 bytes of `str` — byte-identical to the C# AppShell.Fnv1a32.
function fnv1a32(str) {
  const bytes = Buffer.from(str, "utf8");
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------------------------------------
// TS-side replay (frontend/src/mirror/sceneTree.ts, in-process)
// ---------------------------------------------------------------------------------------------------------

async function replayTs(recordingAbs) {
  const { createMirrorState, parseSceneDelta, applySceneDelta } = await loadSceneTree();

  const state = createMirrorState();
  const text = readFileSync(recordingAbs, "utf8");
  requireReproHeader(text, recordingAbs);
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // not a JSON envelope line
    }
    // A repro recording (reproRecorder.ts, format "repro/1") interleaves the CLIENT's own sends as `dir:"out"`;
    // only the inbound half is scene state, and folding an `input` envelope into the tree would be nonsense.
    if (obj?.dir === "out") continue;
    if (typeof obj?.data !== "string") continue; // meta / non-data line
    let raw;
    try {
      raw = JSON.parse(obj.data);
    } catch {
      continue;
    }
    // parseSceneDelta returns null for non-scene-delta frames (session/pong/…).
    const delta = parseSceneDelta(raw);
    if (delta) applySceneDelta(state, delta);
  }

  const nodeTypeCounts = {};
  for (const node of state.nodes.values()) {
    const t = node.nodeType ?? "";
    nodeTypeCounts[t] = (nodeTypeCounts[t] ?? 0) + 1;
  }

  return {
    nodeCount: state.nodes.size,
    orderedIdsCount: state.orderedIds.length,
    orderedIdsFnv1a: fnv1a32(state.orderedIds.join("\n")),
    nodeTypeCounts,
    revision: state.revision
  };
}

// ---------------------------------------------------------------------------------------------------------
// C#-side replay (Godot client --replay --dump-final-state)
// ---------------------------------------------------------------------------------------------------------

function replayGodot(godotBin, recordingAbs) {
  const clientDir = resolve(REPO_ROOT, "godot-client");
  const result = spawnSync(
    godotBin,
    ["--headless", "--path", clientDir, "--", "--replay", recordingAbs, "--dump-final-state"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300_000 }
  );

  if (result.error) {
    throw new Error(`Failed to run Godot client (${godotBin}): ${result.error.message}`);
  }

  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const marker = "M1B_FINAL_STATE: ";
  const line = combined.split("\n").find((l) => l.includes(marker));
  if (!line) {
    const tail = combined.split("\n").slice(-40).join("\n");
    throw new Error(`Godot client produced no ${marker.trim()} line (exit ${result.status}). Last output:\n${tail}`);
  }

  const json = line.slice(line.indexOf(marker) + marker.length).trim();
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------------------------------------

function diffSummaries(ts, cs) {
  const diffs = [];
  for (const key of ["nodeCount", "orderedIdsCount", "orderedIdsFnv1a", "revision"]) {
    if (ts[key] !== cs[key]) diffs.push(`  ${key}: TS=${ts[key]}  C#=${cs[key]}`);
  }

  const keys = new Set([...Object.keys(ts.nodeTypeCounts), ...Object.keys(cs.nodeTypeCounts)]);
  const typeDiffs = [];
  for (const k of [...keys].sort()) {
    const a = ts.nodeTypeCounts[k] ?? 0;
    const b = cs.nodeTypeCounts[k] ?? 0;
    if (a !== b) typeDiffs.push(`    ${k}: TS=${a}  C#=${b}`);
  }
  if (typeDiffs.length > 0) diffs.push("  nodeTypeCounts:\n" + typeDiffs.join("\n"));

  return diffs;
}

// ---------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const recordingAbs = isAbsolute(args.recording) ? args.recording : resolve(REPO_ROOT, args.recording);
  console.log(`compare-replay-final-state: recording ${recordingAbs}`);

  let ts;
  try {
    ts = await replayTs(recordingAbs);
  } catch (e) {
    console.error(`TS replay failed: ${e.message}`);
    process.exit(2);
  }
  console.log(
    `  TS : nodes=${ts.nodeCount} orderedIds=${ts.orderedIdsCount} fnv1a=${ts.orderedIdsFnv1a} ` +
    `revision=${ts.revision} types=${Object.keys(ts.nodeTypeCounts).length}`
  );

  let cs;
  try {
    cs = replayGodot(args.godot, recordingAbs);
  } catch (e) {
    console.error(`C# (Godot) replay failed: ${e.message}`);
    process.exit(2);
  }
  console.log(
    `  C# : nodes=${cs.nodeCount} orderedIds=${cs.orderedIdsCount} fnv1a=${cs.orderedIdsFnv1a} ` +
    `revision=${cs.revision} types=${Object.keys(cs.nodeTypeCounts).length}`
  );

  const diffs = diffSummaries(ts, cs);
  if (diffs.length === 0) {
    console.log(
      `PASS — TS and C# final states match ` +
      `(nodes=${ts.nodeCount}, orderedIds=${ts.orderedIdsCount}, fnv1a=${ts.orderedIdsFnv1a}, ` +
      `revision=${ts.revision}, ${Object.keys(ts.nodeTypeCounts).length} node types)`
    );
    process.exit(0);
  }

  console.error("FAIL — TS vs C# final-state mismatch:\n" + diffs.join("\n"));
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
