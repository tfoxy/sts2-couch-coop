#!/usr/bin/env node
// Derive a MAP-SCROLL bench fixture from an existing map-screen recording.
//
// Why derived rather than recorded: a map scroll is the cheapest possible wire event — the phone trace that
// motivated the walk fast path (Aug-11, `Trace-20260811T170937`) shows ONE scene-delta per scroll frame carrying a
// SINGLE upsert: the map's scroll container (`TheMap`) with a new transform. Everything else on screen is
// untouched; the ~4k descendants re-derive style purely because their inherited parent matrices moved. So the
// fixture only needs a REAL map keyframe (2,796 nodes here, with the real shaders / atlas regions / pinned-loop
// map points) plus a run of those one-node upserts, which is exactly what this script assembles. Nothing about
// the scene is synthesized — the keyframe and the delta envelope are copied verbatim out of the source recording,
// and the only edited value is the scroll container's `transform.origin.y`.
//
//   node scripts/make-map-scroll-fixture.mjs \
//     --in  "$PRIMARY/.sts2/bench/final-smoke-mapstroke.ndjson" \
//     --out .sts2/bench/perf5-map-scroll.ndjson [--node TheMap] [--frames 120] [--step-ms 30]
//
// The scroll travels the map's real range (the source's own origin.y is the resting scroll offset) and back, at a
// 30ms cadence — i.e. a two-second flick in each direction, the gesture the trace captured.

import fs from "node:fs";
import path from "node:path";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { PRIMARY_REPO_ROOT } from "./lib/repo-layout.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const inPath = arg("in", path.resolve(PRIMARY_REPO_ROOT, ".sts2/bench/final-smoke-mapstroke.ndjson"));
const outPath = arg("out", ".sts2/bench/perf5-map-scroll.ndjson");
const nodeName = arg("node", "TheMap");
const frames = Number(arg("frames", "120"));
const stepMs = Number(arg("step-ms", "30"));
const travel = Number(arg("travel", "420")); // design px of scroll, each way

const recordingText = fs.readFileSync(inPath, "utf8");
requireReproHeader(recordingText, inPath);
const lines = recordingText.split("\n").filter(Boolean);
const records = [];
for (const line of lines) {
  const rec = JSON.parse(line);
  if (rec.meta) continue;
  records.push(rec);
}

// Keep everything up to and including the first FULL scene-delta (the session envelope + the keyframe), drop the
// rest of the source stream — the fixture's whole point is that the ONLY thing that happens after the keyframe is
// scrolling.
const prefix = [];
let keyframe = null;
let envelope = null;
for (const rec of records) {
  let msg;
  try {
    msg = JSON.parse(rec.data);
  } catch {
    continue;
  }
  if (msg.type === "scene-delta" && msg.full) {
    keyframe = msg;
    prefix.push(rec);
    break;
  }
  prefix.push(rec);
}
if (!keyframe) {
  throw new Error(`no full keyframe in ${inPath}`);
}
// A later non-full delta supplies the exact delta envelope the client expects (screenInstanceId).
for (const rec of records) {
  const msg = JSON.parse(rec.data);
  if (msg.type === "scene-delta" && !msg.full) {
    envelope = msg;
    break;
  }
}
if (!envelope) {
  throw new Error(`no incremental delta in ${inPath} to copy an envelope from`);
}

const target = keyframe.upserts.find((u) => u.name === nodeName);
if (!target) {
  throw new Error(`no node named ${nodeName} in the keyframe`);
}
// Descendant count, purely for the report line (it is the number of nodes the walk has to re-derive per frame).
const children = new Map();
for (const u of keyframe.upserts) {
  const p = String(u.parentId ?? "");
  if (!children.has(p)) children.set(p, []);
  children.get(p).push(String(u.id));
}
let descendants = 0;
const stack = [String(target.id)];
while (stack.length) {
  const kids = children.get(stack.pop()) ?? [];
  descendants += kids.length;
  for (const k of kids) stack.push(k);
}

const baseY = target.transform.origin.y;
const out = [];
let t = prefix.length > 0 ? prefix[prefix.length - 1].t : 0;
for (const rec of prefix) out.push(rec);

// A VOLATILE upsert: the producer merges these forward onto the retained node, so it carries the per-tick fields
// only (no `name`/`nodeType`) — matching what the recorded stream's own volatile upserts look like.
function scrollUpsert(y) {
  return {
    id: target.id,
    parentId: target.parentId,
    transform: {
      xAxis: target.transform.xAxis,
      yAxis: target.transform.yAxis,
      origin: { x: target.transform.origin.x, y: Math.round(y * 100) / 100 }
    },
    localRect: target.localRect,
    visible: true
  };
}

for (let i = 0; i < frames; i++) {
  // Down the map and back: a flick each way, so the fixture exercises both scroll directions.
  const phase = (i / frames) * 2 * Math.PI;
  const y = baseY + travel * 0.5 * (1 - Math.cos(phase));
  t += stepMs;
  const msg = {
    type: "scene-delta",
    full: false,
    screenType: envelope.screenType,
    screenInstanceId: envelope.screenInstanceId,
    upserts: [scrollUpsert(y)],
    removedIds: []
  };
  out.push({ t, data: JSON.stringify(msg) });
}

const bytes = out.reduce((n, r) => n + Buffer.byteLength(r.data, "utf8"), 0);
const meta = {
  format: "repro/1",
  recordedAt: new Date().toISOString(),
  url: `derived:${path.basename(inPath)}`,
  durationMs: t,
  messages: out.length,
  bytes,
  derived: {
    source: inPath,
    scrollNode: `${nodeName}#${target.id}`,
    scrollDescendants: descendants,
    frames,
    stepMs,
    travel
  }
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  [JSON.stringify({ meta }), ...out.map((r) => JSON.stringify(r))].join("\n") + "\n"
);
console.log(
  `wrote ${outPath}: ${out.length} messages, ${(bytes / 1e6).toFixed(2)} MB, ` +
    `${frames} scroll frames over ${nodeName}#${target.id} (${descendants} descendants), span ${(t / 1000).toFixed(1)}s`
);
