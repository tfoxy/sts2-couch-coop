#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildSummary } from "./summarize-pixi-phone-bench.mjs";
import { decide } from "./decide-pixi-spike.mjs";

const runner = readFileSync(new URL("./bench-phone-canvas-ab.sh", import.meta.url), "utf8");
const replay = readFileSync(new URL("./bench-mirror-replay.mjs", import.meta.url), "utf8");
assert.match(runner, /ARMS="\$CONTROL_NAME,\$CANDIDATE_NAME,\$CANDIDATE_NAME,\$CONTROL_NAME"/);
assert.match(runner, /--idle-recording/);
assert.match(runner, /--dense-recording/);
assert.match(runner, /Pixi spike cells require EFFECTS=off and QUALITY=very-low/);
assert.match(runner, /staticBg=1/);
assert.match(runner, /spineMode=static/);
assert.match(runner, /lowmemorykiller: Kill/);
assert.match(runner, /orientationStable/);
assert.match(runner, /phone-bench-install-overlay\.mjs" restore/);
assert.match(replay, /hitProbe\(clientX, clientY, rect\?\.width \?\? width, gameX, gameY\)/,
  "parity capture must call the five-argument production hit probe");
assert.match(replay, /!Number\.isFinite\(gameX\) \|\| !Number\.isFinite\(gameY\)/,
  "parity capture must reject malformed production mapping coordinates");
assert.match(replay, /await this\._setDiagnosticClock\(this\._msgs\[this\._i\]\.t\);\s*this\._deliver/,
  "diagnostic replay must serialize async clock admission before each recorded message");
assert.match(replay, /getContextAttributes\?\.\(\)/,
  "qualification must record the selected stage's actual WebGL context attributes");
assert.match(replay, /premultipliedAlpha: .*premultipliedAlpha, antialias: .*antialias/,
  "qualification must retain alpha, premultiplied-alpha, and antialias settings");

function cell(workload, arm, sequence) {
  const pixi = arm === "pixi-candidate";
  const recordingSha256 = workload === "idle" ? "a".repeat(64) : "b".repeat(64);
  return {
    cell: { workload: { id: workload, recording: `/frozen/${workload}.ndjson`, recordingSha256 }, arm, sequence,
      query: `stage=${pixi ? "pixi" : "canvas"}&staticBg=1&spineMode=static`, run: { effects: "off", quality: "very-low" } },
    health: { benchExit: 0, lmk: false, contextLoss: false, processRestart: false, pageCrash: false, assetFailure: false, thermalThrottle: false, foregroundPre: true, foregroundPost: true, orientationStable: true, installOverlayAbsent: true },
    actualPresented: { fps: pixi ? 78 : 60, gapP95Ms: pixi ? 14 : 20 },
    frameGaps: { p95: 20 }, sceneAckLatency: workload === "idle"
      ? { p95: null, eventFree: true, delivered: 0, acked: 0, pending: 0 }
      : { p95: 10, eventFree: false, delivered: 8, acked: 8, pending: 0 },
    cpu: { rendererMainPct: pixi ? 40 : 42, gpuProcessPct: pixi ? 50 : 52 },
    memoryMb: { total: pixi ? 520 : 500 },
    rendererWindow: { frameDelta: 2, after: { backend: pixi ? "pixi" : "canvas", ready: true, draw: { objects: 100, textures: 20 } } },
    admission: { recordingSha256, selectedBackend: pixi ? "pixi" : "canvas", completedFrameDelta: 2,
      effectiveSettings: { quality: "very-low", shaders: "off", particles: "off", staticBg: 1, spineMode: "static" },
      staticBgBefore: { latched: false, decodes: 1, lastUrl: "/bg/overgrowth" },
      staticBgAfter: { latched: false, decodes: 1, lastUrl: "/bg/overgrowth" } },
  };
}
const rows = ["idle", "dense"].flatMap((workload) => ["canvas-control", "pixi-candidate", "pixi-candidate", "canvas-control"].map((arm, i) => cell(workload, arm, i + 1)));
assert.equal(buildSummary(rows).passed, true);
const missing = structuredClone(rows); delete missing[1].cpu.rendererMainPct;
assert.equal(buildSummary(missing).passed, false, "a missing required cell metric must fail closed");
const unhealthy = structuredClone(rows); unhealthy[2].health.lmk = true;
assert.equal(buildSummary(unhealthy).passed, false, "any-victim LMK must reject the workload");
const missingBackground = structuredClone(rows); missingBackground[0].admission.staticBgAfter.latched = true;
assert.equal(buildSummary(missingBackground).passed, false, "a latched static background must fail admission");
const missingIdleAckAccounting = structuredClone(rows); delete missingIdleAckAccounting[0].sceneAckLatency.eventFree;
assert.equal(buildSummary(missingIdleAckAccounting).passed, false, "idle ack N/A requires explicit zero-event accounting");
const zeroCpu = structuredClone(rows);
for (const row of zeroCpu) row.cpu.gpuProcessPct = 0;
assert.equal(buildSummary(zeroCpu).gates.find((row) => row.name === "idle: GPU CPU no >5% regression").status, "PASS", "numeric 0 vs 0 is measured equality");
zeroCpu[1].cpu.gpuProcessPct = 1;
assert.equal(buildSummary(zeroCpu).gates.find((row) => row.name === "idle: GPU CPU no >5% regression").status, "FAIL", "positive candidate vs zero control is a regression");

const temp = mkdtempSync(join(tmpdir(), "pixi-parity-"));
const capture = (backend, instance) => ({ schema: "mirror-renderer-parity/1", recording: "idle.ndjson", recordingSha256: "a".repeat(64), viewport: { width: 1920, height: 1080 }, capture: {
  accepted: true, clockMs: 7000, identityBefore: { revision: 148 }, identityAfter: { revision: 148 }, stateFingerprint: "1234abcd",
  logicalPaint: ["clip:start:0,0,100,100", "text:Strike:12,24", "clip:end"],
  hits: [{ x: 240, y: 912, hit: { available: true, value: { nodeId: "orb" } }, productionMapping: { available: true, value: { x: 240, y: 912 } } }],
  diagnostics: { backend, instance }
} });
const a = join(temp, "a.json"), b = join(temp, "b.json");
writeFileSync(a, JSON.stringify(capture("canvas", 1)));
writeFileSync(b, JSON.stringify(capture("pixi", 99)));
const compare = () => spawnSync(process.execPath, [new URL("./compare-renderer-parity.mjs", import.meta.url).pathname, a, b], { encoding: "utf8" });
assert.equal(compare().status, 0, "backend instance differences are intentionally ignored");
for (const mutate of [
  (value) => { value.recordingSha256 = "b".repeat(64); },
  (value) => { value.capture.logicalPaint[1] = "text:Bash:12,24"; },
  (value) => { value.capture.logicalPaint.shift(); },
  (value) => { value.capture.hits[0].productionMapping.available = false; },
]) {
  const changed = capture("pixi", 2); mutate(changed); writeFileSync(b, JSON.stringify(changed));
  assert.equal(compare().status, 1, "recording/text/clip/mapping mismatch must fail parity");
}

const qualification = Object.fromEntries(["sourceHashesMatch", "recordingHashesMatch", "settingsMatch", "geometryPassed", "contentPassed", "visualPassed", "objectGrowthBounded", "textureGrowthBounded", "actualPixiWebglProved"].map((key) => [key, true]));
const passingSummary = buildSummary(rows);
assert.equal(decide([passingSummary, passingSummary], qualification).verdict, "GO");
assert.equal(decide([passingSummary], qualification).verdict, "INCONCLUSIVE", "a promising first matrix requires replication before GO");
const noWinRows = structuredClone(rows); for (const row of noWinRows) if (row.cell.arm === "pixi-candidate") { row.actualPresented.fps = 60; row.actualPresented.gapP95Ms = 20; }
const noWin = buildSummary(noWinRows);
assert.equal(decide([noWin], qualification).verdict, "NO-GO");
const incompleteSummary = structuredClone(passingSummary); incompleteSummary.gates[0].status = "UNMEASURED";
assert.equal(decide([incompleteSummary], qualification).verdict, "INCONCLUSIVE");
const missingQualification = { ...qualification, visualPassed: false };
assert.equal(decide([noWin], missingQualification).verdict, "INCONCLUSIVE");
assert.equal(decide([{ schema: "wrong" }], qualification).verdict, "INCONCLUSIVE");
assert.equal(decide([{ ...passingSummary, gates: [] }, passingSummary], qualification).verdict, "INCONCLUSIVE",
  "claimed wins without the complete expected gate set are inconclusive");
assert.equal(decide([{ ...passingSummary, cells: 7 }, passingSummary], qualification).verdict, "INCONCLUSIVE",
  "a summary without all eight ABBA cells is inconclusive");
console.log("pixi bench selftest: pass");
