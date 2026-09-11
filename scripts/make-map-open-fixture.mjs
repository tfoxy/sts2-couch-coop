#!/usr/bin/env node
// Derive a MAP-OPEN bench fixture from an existing map-screen recording.
//
// Why derived rather than recorded (same honesty rule as `make-map-scroll-fixture.mjs`): no recording in
// `.sts2/bench/` captures the moment the map OPENS. Every map recording starts with the map already up
// (`final-smoke-mapstroke`, `r8-map-live`, `wse-*-map`), and the one recording that CONTAINS a closed map
// (`combat-modern-2026-08-06`, MapScreen hidden for all 868 deltas) carries a map with **zero**
// `pinnedLoopAnim` points — the game only pins the travelable-point pulse while the map screen is live — so
// revealing that subtree prices the reveal but not the pulsing map the Aug-11 phone trace measured.
//
// So this fixture takes a REAL, live map keyframe (2,796 nodes, real atlas regions / shaders / 3 pulsing
// `mapPointPulse` travelable points) and appends TWO upserts of the `MapScreen` root: `visible:false` (the state
// the client is in during combat), then `visible:true` — exactly the wire shape of "combat ends, player opens the
// map". Nothing is synthesized: the keyframe, both node payloads and the delta envelope are copied verbatim out
// of the source recording, and the only edited value is `MapScreen.visible`.
//
//   node scripts/make-map-open-fixture.mjs \
//     --in  "$PRIMARY/.sts2/bench/final-smoke-mapstroke.ndjson" \
//     --out .sts2/bench/perf5-map-open.ndjson \
//     [--node MapScreen] [--close-at-ms 800] [--open-at-ms 2300] [--hold-ms 2000]
//
// Why the map starts OPEN and is closed on the wire rather than being hidden in the keyframe: the bench's
// readiness gate waits for >50 `.mirror-node` elements before it opens its measurement window, and a map
// recording whose only screen is the map has almost nothing else on screen — a keyframe with `MapScreen` hidden
// renders a near-empty stage and the bench times out. Closing it one delta later is also the more faithful model
// of the shipped client: `?dormantReclaim` only tears hidden DOM down on a FULL walk, so a mirror that watched a
// combat arrives at the open with the map's elements already built (the dormant round measured `createEl` = 0
// across the reveal) — which is precisely the state this fixture reproduces.
//
// `--open-at-ms - --close-at-ms` is the quiet gap the map spends closed. `--hold-ms` appends cheap keep-alive
// frames AFTER the reveal (one volatile upsert of the map's own scroll container at its resting offset) so the
// measured window covers the settled, pulsing map — the "PaintImage per frame while the pulse runs" regime. They
// move nothing: the transform is the source's own resting value.

import fs from "node:fs";
import path from "node:path";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { PRIMARY_REPO_ROOT } from "./lib/repo-layout.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const inPath = arg("in", path.resolve(PRIMARY_REPO_ROOT, ".sts2/bench/final-smoke-mapstroke.ndjson"));
const outPath = arg("out", ".sts2/bench/perf5-map-open.ndjson");
const nodeName = arg("node", "MapScreen");
const holdNodeName = arg("hold-node", "TheMap");
const closeAtMs = Number(arg("close-at-ms", "800"));
const openAtMs = Number(arg("open-at-ms", "2300"));
const holdMs = Number(arg("hold-ms", "2000"));
const holdStepMs = Number(arg("hold-step-ms", "100"));

const recordingText = fs.readFileSync(inPath, "utf8");
requireReproHeader(recordingText, inPath);
const lines = recordingText.split("\n").filter(Boolean);
const records = [];
for (const line of lines) {
  const rec = JSON.parse(line);
  if (rec.meta) continue;
  records.push(rec);
}

// Everything up to and including the first FULL scene-delta (session envelope + keyframe); the rest of the
// source stream is dropped — after the keyframe the only thing that happens in this fixture is the open.
const prefix = [];
let keyframeRec = null;
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
    keyframeRec = rec;
    break;
  }
  prefix.push(rec);
}
if (!keyframe) {
  throw new Error(`no full keyframe in ${inPath}`);
}
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
if (target.visible === false) {
  throw new Error(`${nodeName} is already hidden in the keyframe — nothing to open`);
}

const children = new Map();
for (const u of keyframe.upserts) {
  const p = String(u.parentId ?? "");
  if (!children.has(p)) children.set(p, []);
  children.get(p).push(u);
}
const subtree = [];
const stack = [String(target.id)];
while (stack.length) {
  for (const kid of children.get(stack.pop()) ?? []) {
    subtree.push(kid);
    stack.push(String(kid.id));
  }
}
const pulses = subtree.filter((u) => u.pinnedLoopAnim);
const textured = subtree.filter((u) => u.texture).length;

// The close / open upserts: the node's own keyframe payload with `visible` flipped. Both keep `name`, so
// `mergeNode` takes the static-replace branch a real re-add would take (the rule the bench's `--reveal-burst`
// encodes) — and nothing else about the node changes between them.
function visibilityMsg(visible) {
  return {
    type: "scene-delta",
    full: false,
    screenType: envelope.screenType,
    screenInstanceId: envelope.screenInstanceId,
    upserts: [{ ...target, visible }],
    removedIds: []
  };
}

const holdTarget = keyframe.upserts.find((u) => u.name === holdNodeName);
function holdUpsert() {
  // A VOLATILE upsert at the map's RESTING offset — the shape the producer ships per tick, moving nothing.
  return {
    id: holdTarget.id,
    parentId: holdTarget.parentId,
    transform: holdTarget.transform,
    localRect: holdTarget.localRect,
    visible: true
  };
}

const out = [...prefix];
// The keyframe keeps its ORIGINAL timestamp. It matters: delivered in the same tick as the session envelope the
// client has not finished processing, the keyframe is dropped. The source's own gap is the honest one.
const t0 = keyframeRec.t;
let t = t0;
out.push({ t, data: keyframeRec.data }); // the source's own raw keyframe string, byte for byte
t = t0 + closeAtMs;
out.push({ t, data: JSON.stringify(visibilityMsg(false)) });
t = t0 + openAtMs;
out.push({ t, data: JSON.stringify(visibilityMsg(true)) });
const holdFrames = holdTarget && holdMs > 0 ? Math.floor(holdMs / holdStepMs) : 0;
for (let i = 0; i < holdFrames; i++) {
  t += holdStepMs;
  out.push({
    t,
    data: JSON.stringify({
      type: "scene-delta",
      full: false,
      screenType: envelope.screenType,
      screenInstanceId: envelope.screenInstanceId,
      upserts: [holdUpsert()],
      removedIds: []
    })
  });
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
    openNode: `${nodeName}#${target.id}`,
    openSubtreeNodes: subtree.length,
    openSubtreeTexturedNodes: textured,
    pinnedLoopPoints: pulses.length,
    closeAtMs,
    openAtMs,
    holdFrames,
    holdStepMs,
    keyframeNodes: keyframe.upserts.length,
    keyframeT: keyframeRec.t
  }
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  [JSON.stringify({ meta }), ...out.map((r) => JSON.stringify(r))].join("\n") + "\n"
);
console.log(
  `wrote ${outPath}: ${out.length} messages, ${(bytes / 1e6).toFixed(2)} MB, keyframe ${keyframe.upserts.length} nodes ` +
    `(${nodeName}#${target.id} closed: ${subtree.length} nodes, ${textured} textured, ${pulses.length} pinned-loop points), ` +
    `closed at ${closeAtMs}ms, open at ${openAtMs}ms + ${holdFrames} hold frames, span ${(t / 1000).toFixed(1)}s`
);
