#!/usr/bin/env node
// Quick per-phase thread-CPU summary from a raw Chrome trace written by scripts/bench-mirror-replay.mjs's
// `--trace <name>` (lands under .sts2/bench/traces/). No gates, no oracle, no pass/fail verdict — just calls,
// thread-CPU ms, wall ms and ms/call per `console.timeStamp` phase pair, inside the bench's own active (or
// idle) window.
//
// Chrome TimeStamp events carry `tts`: cumulative CPU time on the EMITTING thread, in microseconds. Pairing a
// `...:start` TimeStamp with its matching `...:end` TimeStamp and differencing `tts` gives that span's thread-
// CPU; differencing `ts` gives its wall time. This is the same technique
// .sts2/bench/desktop-integrated-rust-oct1-index-0c221425-controls-prep/analyze-paint-order-trace.mjs and
// cc-rust-text-ink-sep28's check-natural-phase-trace.py use, with every strict invariant/gate from both
// dropped: this tool reports what the trace says, it does not certify it.
//
// Marker sources (see docs at the call sites for the exact format):
//   frontend/src/mirror/renderer/pixi/createPixiMirrorRenderer.ts
//     cc:couch-exec:<phase>:<buildId>:start|end        e.g. cc:couch-exec:build:1234:start
//   godot-scene-web packages/canvas/rust-prototype/src/renderer.rs (phase_stamp, wasm32 build)
//     cc:rust-exec:<operationId>:<phase>:start|end     e.g. cc:rust-exec:1234:upload:start
//   generic fallback: any `cc:<name...>:start|end`, with a trailing numeric segment before the edge read as
//   an instance id (folded out of the phase name so every instance of one phase aggregates together).
//
// Usage:
//   node scripts/analyze-phase-cpu.mjs <trace.json> [--phase active|idle] [--json]
//   node scripts/analyze-phase-cpu.mjs --trace <trace.json> [--out <report.json>]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_TRACE_WINDOW, IDLE_TRACE_WINDOW, markerWindowOrError, traceMarkerLabel } from "./bench-trace-lifecycle.mjs";

function fail(message) {
  console.error(`analyze-phase-cpu: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const a = { trace: null, phase: "active", json: false, out: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--trace": a.trace = argv[++i]; break;
      case "--phase": a.phase = argv[++i]; break;
      case "--json": a.json = true; break;
      case "--out": a.out = argv[++i]; break;
      case "--help": case "-h": a.help = true; break;
      default:
        if (arg.startsWith("--")) fail(`unknown argument: ${arg}`);
        positional.push(arg);
    }
  }
  if (!a.trace && positional.length) a.trace = positional[0];
  return a;
}

function loadTraceEvents(tracePath) {
  const raw = readFileSync(tracePath, "utf8");
  const parsed = JSON.parse(raw);
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  if (!Array.isArray(events)) fail(`${tracePath} does not contain a Chrome trace event array`);
  return events;
}

// cc:couch-exec:<phase>:<id>:<edge>   -> domain === 'couch-exec' (special-cased: id is the LAST segment)
// cc:rust-exec:<id>:<phase>:<edge>    -> domain === 'rust-exec'  (special-cased: id comes BEFORE the phase)
// cc:<name>:<id>:<edge>               -> generic: trailing numeric segment (before the edge) is the id
// cc:<name>:<edge>                    -> generic: no id
const EDGE_RE = /^(.*):(start|end)$/;

export function parseMarker(label) {
  if (typeof label !== "string" || !label.startsWith("cc:")) return null;
  const m = EDGE_RE.exec(label);
  if (!m) return null;
  const [, body, edge] = m;
  const parts = body.split(":"); // ["cc", ...]
  if (parts.length < 2) return { key: body, phase: body, id: null, edge };
  const domain = parts[1];
  if (domain === "rust-exec" && parts.length === 4) {
    return { key: body, phase: `rust-exec:${parts[3]}`, id: parts[2], edge };
  }
  const last = parts[parts.length - 1];
  if (parts.length >= 3 && /^-?\d+$/.test(last)) {
    return { key: body, phase: parts.slice(1, -1).join(":"), id: last, edge };
  }
  return { key: body, phase: parts.slice(1).join(":"), id: null, edge };
}

function round(v, digits = 3) { return v == null ? null : Math.round(v * 10 ** digits) / 10 ** digits; }

export function summarizePhaseCpu(events, scope) {
  const window = markerWindowOrError(events, scope);
  if (window.error) return { error: window.error };
  const { start, end } = window;
  const sameThread = (e) => e.pid === start.pid && e.tid === start.tid;
  const threadNameRow = events.find((e) => e.ph === "M" && e.name === "thread_name" && sameThread(e));

  const open = new Map(); // key -> stack of {ts, tts}
  const phases = new Map(); // phase -> { calls, cpuUs, wallUs }
  let unmatchedStarts = 0;
  let unmatchedEnds = 0;
  const unmatchedLabels = [];

  for (const e of events) {
    if (e.name !== "TimeStamp") continue;
    if (!sameThread(e)) continue;
    if (!(e.ts >= start.ts && e.ts <= end.ts)) continue;
    const label = traceMarkerLabel(e);
    const marker = parseMarker(label);
    if (!marker) continue;
    const finiteClock = Number.isFinite(e.ts) && Number.isFinite(e.tts);
    if (marker.edge === "start") {
      if (!open.has(marker.key)) open.set(marker.key, []);
      open.get(marker.key).push({ ts: e.ts, tts: finiteClock ? e.tts : null, phase: marker.phase });
    } else {
      const stack = open.get(marker.key);
      const openSpan = stack?.pop();
      if (!openSpan) { unmatchedEnds++; unmatchedLabels.push(label); continue; }
      if (!finiteClock || openSpan.tts == null) { unmatchedLabels.push(`${label} (no tts)`); continue; }
      const wallUs = e.ts - openSpan.ts;
      const cpuUs = e.tts - openSpan.tts;
      if (wallUs < 0) { unmatchedLabels.push(`${label} (negative wall)`); continue; }
      let bucket = phases.get(marker.phase);
      if (!bucket) { bucket = { calls: 0, cpuUs: 0, wallUs: 0 }; phases.set(marker.phase, bucket); }
      bucket.calls++;
      bucket.cpuUs += Math.max(0, cpuUs);
      bucket.wallUs += wallUs;
    }
  }
  for (const [key, stack] of open) {
    for (const openSpan of stack) { unmatchedStarts++; unmatchedLabels.push(`${key}:start (never closed)`); void openSpan; }
  }

  const rows = [...phases.entries()]
    .map(([phase, b]) => ({
      phase, calls: b.calls,
      totalCpuMs: round(b.cpuUs / 1000),
      wallMs: round(b.wallUs / 1000),
      msPerCall: b.calls ? round(b.cpuUs / 1000 / b.calls) : null,
    }))
    .sort((a, b) => (b.totalCpuMs ?? 0) - (a.totalCpuMs ?? 0));

  return {
    schema: "rust-phase-cpu/1",
    scope: scope.phase,
    window: { pid: start.pid, tid: start.tid, threadName: threadNameRow?.args?.name ?? null, windowMs: round(window.windowMs) },
    phases: rows,
    unmatched: { starts: unmatchedStarts, ends: unmatchedEnds, labels: unmatchedLabels.slice(0, 50) },
  };
}

function printTable(result) {
  console.log(`scope: ${result.scope}  window: ${result.window.windowMs}ms  thread: ${result.window.threadName ?? "?"} (pid ${result.window.pid} tid ${result.window.tid})`);
  console.log("");
  console.log(`  phase`.padEnd(32) + "calls".padStart(7) + "totalCpuMs".padStart(13) + "wallMs".padStart(10) + "ms/call".padStart(10));
  for (const row of result.phases) {
    console.log(`  ${row.phase}`.padEnd(32) + String(row.calls).padStart(7) +
      String(row.totalCpuMs ?? "n/a").padStart(13) + String(row.wallMs ?? "n/a").padStart(10) + String(row.msPerCall ?? "n/a").padStart(10));
  }
  console.log("");
  console.log(`  unmatched: ${result.unmatched.starts} unclosed starts, ${result.unmatched.ends} ends with no start`);
  if (result.unmatched.labels.length) console.log(`    ${result.unmatched.labels.slice(0, 10).join("\n    ")}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.trace) {
    console.log("usage: analyze-phase-cpu.mjs <trace.json> [--phase active|idle] [--json] [--out <report.json>]");
    process.exit(args.help ? 0 : 2);
  }
  const scope = args.phase === "idle" ? IDLE_TRACE_WINDOW : ACTIVE_TRACE_WINDOW;
  const events = loadTraceEvents(resolve(args.trace));
  const result = summarizePhaseCpu(events, scope);
  if (result.error) { console.error(`analyze-phase-cpu: ${result.error}`); process.exit(1); }
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printTable(result);
  if (args.out) writeFileSync(resolve(args.out), JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
