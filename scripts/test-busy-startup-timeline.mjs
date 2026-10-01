#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { installBusyStartupTimeline, inspectBusyStartupTimeline, summarizeCardAtlasIngestion } from "./lib/busy-startup-timeline.mjs";

let now = 0;
const handlers = new Map();
const register = (name, fn) => handlers.set(name, fn);
const page = { __benchDocumentNonce: "doc-A", addEventListener: register };
const context = { window: page, document: { visibilityState: "visible", hidden: false,
    addEventListener: register }, location: { href: "http://example.test/?stage=rust" },
  innerWidth: 800, innerHeight: 400, devicePixelRatio: 2,
  performance: { now: () => now, timeOrigin: 1_800_000_000_000 } };
runInNewContext(`(${installBusyStartupTimeline.toString()})()`, context);
runInNewContext(`(${installBusyStartupTimeline.toString()})()`, context);
assert.equal(page.__benchBusyStartupTimeline.events.length, 1,
  "warmup init script persisting into repeat does not install a second recorder");
const emit = (at, name, detail = {}) => { now = at; page.__benchBusyStartupEvent(name, detail); };
emit(100, "stream.fullScene", { t: 2326, sceneOrdinal: 1, wireRevision: null });
emit(101, "renderer.create", { instance: 1 });
emit(102, "renderer.initStart", { sliceSupported: true });
emit(200, "renderer.initComplete", { contextReady: true, pending: 0, failed: 0 });
emit(250, "renderer.framePrepare", { revision: 1 });
emit(251, "renderer.frameSubmit", { revision: 1 });
emit(252, "renderer.frameComplete", { revision: 1 });
emit(253, "renderer.firstReady", { revision: 1, pending: 0, failed: 0,
  backingWidth: 1600, backingHeight: 800, dpr: 2 });
emit(300, "stream.boundaryStart", { boundMs: 2500 });
emit(400, "stream.boundaryEnd", { boundMs: 6500 });
assert.equal(inspectBusyStartupTimeline(page.__benchBusyStartupTimeline).accepted, true);
assert.equal(page.__benchBusyStartupTimeline.events[1].atEpochMs, 1_800_000_000_100);
now = 401;
handlers.get("visibilitychange")();
assert.equal(page.__benchBusyStartupTimeline.events.at(-1).name, "document.visibility");
const missingReady = structuredClone(page.__benchBusyStartupTimeline);
missingReady.events = missingReady.events.filter((row) => row.name !== "renderer.firstReady");
assert.ok(inspectBusyStartupTimeline(missingReady).failures.includes("renderer.firstReady"));
const badInit = structuredClone(page.__benchBusyStartupTimeline);
badInit.events.find((row) => row.name === "renderer.initComplete").detail.contextReady = false;
assert.ok(inspectBusyStartupTimeline(badInit).failures.includes("initResources"));
const badReady = structuredClone(page.__benchBusyStartupTimeline);
badReady.events.find((row) => row.name === "renderer.firstReady").detail.pending = 1;
assert.ok(inspectBusyStartupTimeline(badReady).failures.includes("firstReadyResources"));
const badOrder = structuredClone(page.__benchBusyStartupTimeline);
badOrder.events.find((row) => row.name === "renderer.frameSubmit").atPageMs = 99;
badOrder.events.find((row) => row.name === "renderer.frameSubmit").atEpochMs = 1_800_000_000_099;
assert.ok(inspectBusyStartupTimeline(badOrder).failures.includes("rendererOrder"));
const atlas = structuredClone(page.__benchBusyStartupTimeline);
const atlasKey = "/res/images/atlases/card_atlas_0.png";
const atlasEvents = [
  ["fetchStart", {}], ["response", { waitMs: 12, status: 200 }],
  ["body", { waitMs: 5, encodedBytes: 100 }],
  ["bitmapDecoded", { syncCallMs: 1, awaitMs: 20, width: 2, height: 3, encodedBytes: 100 }],
  ["pixelReadback", { drawMs: 2, getImageDataMs: 3, uint8CopyMs: 4, width: 2, height: 3, rgbaBytes: 24 }],
  ["sceneSerialized", { scope: "wholeScene", durationMs: 5, sceneBytes: 40 }],
  ["firstSubmissionQueued", { hasAtlasUpload: true, rgbaBytes: 24 }], ["firstSubmissionStart", {}],
  ["resourcesBatchSerialized", { scope: "wholeBatch", durationMs: 6, batchBytes: 150,
    atlasRgbaBytes: 24, resourceCount: 2, resources: [{ key: atlasKey, rgbaBytes: 24 },
      { key: "/res/images/other.png", rgbaBytes: 8 }] }],
  ["wasmBatchUpload", { scope: "wholeBatch", durationMs: 7, batchBytes: 150,
    atlasRgbaBytes: 24, resourceCount: 2 }],
  ["sceneAdmitted", { scope: "wholeScene", durationMs: 8, sceneBytes: 40 }],
  ["firstSubmissionComplete", { presented: true }],
];
atlas.events.push(...atlasEvents.map(([name, detail], index) => ({ name: `cardAtlas.${name}`,
  atPageMs: 500 + index, atEpochMs: atlas.timeOrigin + 500 + index,
  documentNonce: "doc-A", detail: { key: atlasKey, ...detail } })));
assert.equal(summarizeCardAtlasIngestion(atlas).accepted, true);
const missing = structuredClone(atlas);
missing.events = missing.events.filter((row) => row.name !== "cardAtlas.wasmBatchUpload");
assert.ok(summarizeCardAtlasIngestion(missing).failures.includes("missing:wasmBatchUpload"));
const wrongDimensions = structuredClone(atlas);
wrongDimensions.events.find((row) => row.name === "cardAtlas.pixelReadback").detail.rgbaBytes = 20;
assert.ok(summarizeCardAtlasIngestion(wrongDimensions).failures.includes("pixelDimensions"));
assert.ok(summarizeCardAtlasIngestion(wrongDimensions).failures.includes("uploadBytesMismatch"));
const badSequence = structuredClone(atlas);
badSequence.events.find((row) => row.name === "cardAtlas.resourcesBatchSerialized").atPageMs = 502;
assert.ok(summarizeCardAtlasIngestion(badSequence).failures.includes("order:resourcesBatchSerialized"));
const mixedKey = structuredClone(atlas);
mixedKey.events.find((row) => row.name === "cardAtlas.body").detail.key = "/res/images/atlases/card_atlas_1.png";
assert.ok(summarizeCardAtlasIngestion(mixedKey).failures.includes("key:body"));
const duplicate = structuredClone(atlas);
duplicate.events.push(structuredClone(duplicate.events.find((row) => row.name === "cardAtlas.bitmapDecoded")));
assert.ok(summarizeCardAtlasIngestion(duplicate).failures.includes("duplicate:bitmapDecoded"));
const mislabeledBatch = structuredClone(atlas);
mislabeledBatch.events.find((row) => row.name === "cardAtlas.resourcesBatchSerialized").detail.scope = "atlasOnly";
assert.ok(summarizeCardAtlasIngestion(mislabeledBatch).failures.includes("batchComposition"));
const wrongBatch = structuredClone(atlas);
wrongBatch.events.find((row) => row.name === "cardAtlas.resourcesBatchSerialized").detail.resources[1].rgbaBytes = 200;
assert.ok(summarizeCardAtlasIngestion(wrongBatch).failures.includes("batchComposition"));
const source = readFileSync(new URL("./bench-mirror-replay.mjs", import.meta.url), "utf8");
assert.match(source, /if \(opts\.busyStartupTimelineOut\) \{[\s\S]*?page\.addInitScript\(installBusyStartupTimeline\)/);
assert.match(source, /busyStartupTimeline: !!args\.busyStartupTimelineOut/);
assert.match(source, /if \(opts\.busyStartupTimelineOut\) \{[\s\S]*?inspectBusyStartupTimeline\(timeline\)/);
assert.match(source, /noteStartupNavigation\("harness\.gotoAboutBlank"/);
assert.match(source, /noteStartupNavigation\("harness\.gotoReplay"/);
assert.match(source, /busyStartupTimelineOut: args\.busyStartupTimelineOut \? `\$\{args\.busyStartupTimelineOut\}\.warmup\.json` : null/);
assert.match(source, /runKind: opts\.busyStartupRunKind \?\? "visual-repeat"/);
assert.match(source, /navigation: startupNavigation, inspection: inspectBusyStartupTimeline\(timeline\)/);
assert.match(source, /cardAtlasIngestion: summarizeCardAtlasIngestion\(timeline\)/);
const rendererSource = readFileSync(new URL("../frontend/src/mirror/renderer/pixi/createPixiMirrorRenderer.ts", import.meta.url), "utf8");
assert.match(rendererSource, /startupEnabled && \+\+startupPrepares <= 5/);
assert.match(rendererSource, /startupEnabled && \+\+startupSubmits <= 5/);
assert.match(rendererSource, /startupEnabled && \+\+startupCompletes <= 5/);
assert.match(rendererSource, /if \(startupEnabled\) noteStartupReady\(next\.revision\)/);
const executorSource = readFileSync(new URL("../frontend/src/mirror/renderer/pixi/createRustDrawListExecutor.ts", import.meta.url), "utf8");
assert.match(executorSource, /\? emitBusyStartupEvent : null/);
assert.doesNotMatch(executorSource, /(?<!\?)emitBusyStartupEvent\("texture\./);
console.log("untimed busy startup timeline tests passed");
