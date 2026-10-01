#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { inspectStartupRecordingPin, installStartupResourceReceipt, inspectStartupResources,
  inspectStartupWorkload, inspectStartupProcessAndTrace, inspectStartupFinalState } from "./lib/startup-observation.mjs";
import { validateActiveWindowBoundary } from "./lib/active-window-boundary.mjs";
import { startupTimingQueryError } from "./lib/active-replay-options.mjs";

let time = 0;
const page = {};
const marks = [];
const workloadExpected = { fullSceneT: 2326, fullSceneCount: 1,
  fullSceneBefore: { count: 1, hash: "before" },
  end: { count: 3, hash: "complete", lastT: 6499 }, finalRevision: 172 };
const recordingPin = { expectedRecordingSha256: "a".repeat(64),
  actualRecordingSha256: "a".repeat(64), expectedDeliveryCount: 173,
  expectedDeliveryHash: "da5535f5", actualDelivery: { count: 173, hash: "da5535f5" } };
assert.equal(inspectStartupRecordingPin(recordingPin).accepted, true);
assert.ok(inspectStartupRecordingPin({ ...recordingPin,
  actualRecordingSha256: "b".repeat(64) }).failures.includes("recordingSha256"),
"wrong recording bytes reject before navigation");
assert.ok(inspectStartupRecordingPin({ ...recordingPin,
  actualDelivery: { count: 172, hash: "da5535f5" } }).failures.includes("deliverySequence"),
"short replay prefix rejects even with pinned recording bytes");
assert.ok(inspectStartupRecordingPin({ ...recordingPin,
  actualDelivery: { count: 173, hash: "00000000" } }).failures.includes("deliverySequence"),
"same length, changed sequence rejects");
const context = { window: page, location: { href: "http://example.test/?stage=rust&shaders=off&particles=off&rustZeroCopyPixels=1" },
  document: { visibilityState: "visible", hidden: false }, innerWidth: 800, innerHeight: 400,
  devicePixelRatio: 2, console: { timeStamp: (label) => marks.push(label) },
  performance: { timeOrigin: 1_800_000_000_000, now: () => time } };
runInNewContext(`(${installStartupResourceReceipt.toString()})(${JSON.stringify({ count: 3, hash: "complete", finalRevision: 172 })})`, context);
const emit = (name, detail) => { time++; page.__benchStartupResourceEvent(name, detail); };
const key = "/res/images/atlases/card_atlas_0.png";
emit("body", { key, encodedBytes: 100 });
emit("decoded", { key, width: 2, height: 3 });
emit("pixels", { key, width: 2, height: 3, rgbaBytes: 24, copy: "view" });
emit("upload", { revision: 1, batchBytes: 80, resources: [{ key, width: 2, height: 3, rgbaBytes: 24 }] });
emit("present", { backendRevision: 1, documentNonce: "doc", rendererInstance: 1,
  presented: true, draws: 5, completedFrames: 1, pending: 0, failure: null });
const final = { timeOrigin: 1_800_000_000_000,
  renderer: { revision: 172, ready: true, resources: { pending: 0, failed: 0 },
    lifecycle: { presentationValid: 1 } } };

const effective = { quality: "very-low", shaders: "off", particles: "off", staticBg: 1,
  spineMode: "static", backingWidth: 1600, backingHeight: 800, dpr: 2,
  rustZeroCopyPixels: true };
const renderer = (ready) => ({ backend: "rust", instance: 1, readiness: ready ? "ready" : "initializing",
  ready, resources: { pending: ready ? 0 : 1, failed: 0 }, failure: null,
  lifecycle: { contextReady: 1, presentationValid: ready ? 1 : 0 }, effective,
  frameIdentity: { revision: 172 }, pendingBreakdown: { refinement: 0 },
  asyncSubmissionRevision: null, asyncAwaitingAckRevision: null,
  draw: { completedFrames: 7, objects: 5 } });
const bound = (level, ready) => ({ boundMs: level === 1 ? 2500 : 6500,
  markerWallMinusBoundaryMs: 0, delivery: { count: level, hash: `hash${level}` },
  firstReadyAtMs: ready ? 5000 : null, atMs: level === 1 ? 2500 : 6500,
  atEpochMs: 1_800_000_000_000 + (level === 1 ? 2500 : 6500),
  documentNonce: "doc", timeOrigin: 1_800_000_000_000,
  url: "http://example.test/?stage=rust&shaders=off&particles=off&rustZeroCopyPixels=1",
  visibility: { state: "visible", hidden: false }, viewport: { width: 800, height: 400, dpr: 2 },
  renderer: renderer(ready), contextEvents: { losses: 0, creationErrors: 0 },
  quality: { choice: "auto", tier: "very-low" }, savedSettings: null,
  freshDefaults: { cleared: true } });
const start = bound(1, false), end = bound(2, true);
const expectedStart = { boundMs: 2500, count: 1, hash: "hash1" };
const expectedEnd = { boundMs: 6500, count: 2, hash: "hash2" };
assert.equal(validateActiveWindowBoundary({ start, end, expectedStart, expectedEnd,
  startupObservation: true }).accepted, true);
assert.equal(validateActiveWindowBoundary({ start, end: bound(2, false), expectedStart, expectedEnd,
  startupObservation: true }).accepted, true);
assert.equal(validateActiveWindowBoundary({ start, end, expectedStart, expectedEnd }).accepted, false);
const late = structuredClone(start); late.markerWallMinusBoundaryMs = 150;
assert.ok(validateActiveWindowBoundary({ start: late, end, expectedStart, expectedEnd,
  startupObservation: true }).failures.some((row) => row.name === "start.latenessMs"));
const wrongControl = structuredClone(end); wrongControl.renderer.effective.rustZeroCopyPixels = false;
assert.ok(validateActiveWindowBoundary({ start, end: wrongControl, expectedStart, expectedEnd,
  startupObservation: true }).failures.some((row) => row.name === "copyControl"));
const finalPage = { documentNonce: "doc", timeOrigin: 1_800_000_000_000, url: end.url,
  visibility: end.visibility, viewport: end.viewport,
  renderer: { ...end.renderer, revision: 172 }, quality: { choice: "auto", tier: "very-low", source: "auto" },
  contextEvents: end.contextEvents, savedSettings: null, freshDefaults: { cleared: true } };
page.__benchDocumentNonce = "doc";
page.__benchActiveDeliveryState = () => ({ count: 1, hash: "before", lastT: 0 });
page.__mirrorRendererDiagnostics = () => page.rendererState;
page.__mirrorGlContextEvents = () => ({ losses: 0, creationErrors: 0 });
page.rendererState = renderer(false);
time = 20;
page.__benchStartupFullSceneBeforeDelivery({ t: 2326 });
assert.deepEqual(marks, ["cc-report-start"]);
page.__benchActiveDeliveryState = () => ({ count: 3, hash: "complete", lastT: 6499 });
page.__benchStartupDelivered();
page.rendererState = { ...renderer(true), asyncSubmissionRevision: 172 };
page.__benchStartupPresentationComplete();
assert.equal(page.__benchStartupWorkload.end, null, "async submission cannot close interval");
page.rendererState = renderer(true);
page.__benchStartupPresentationComplete();
assert.equal(page.__benchStartupWorkload.end, null, "ready state without owning commit cannot mark completion");
time = 23;
emit("present", { backendRevision: 7, documentNonce: "doc", rendererInstance: 1,
  presented: true, draws: 5, completedFrames: 7, pending: 0, failure: null });
const committed = { documentNonce: "doc", rendererInstance: 1, sceneRevision: 172,
  backendRevision: 7, completedFrames: 7, frameIdentity: { revision: 172 }, presented: true };
time = 25;
page.__benchStartupCommittedPresentation(committed);
time = 26;
page.__benchStartupPresentationComplete();
assert.deepEqual(marks, ["cc-report-start", "cc-report-end"]);
page.__benchStartupPresentationComplete();
assert.equal(marks.length, 2, "completion marker emits once");
const workload = page.__benchStartupWorkload;
const workloadInspection = inspectStartupWorkload(workload, workloadExpected, page.__benchStartupResources);
assert.equal(workloadInspection.accepted, true, JSON.stringify(workloadInspection.failures));
assert.equal(workloadInspection.elapsedMs, 6);
assert.equal(workloadInspection.delivery.hash, "complete");
assert.equal(inspectStartupResources(page.__benchStartupResources, final, true, workload).accepted, true);
const laterPresentation = structuredClone(page.__benchStartupResources);
laterPresentation.events.push({ name: "present", detail: { backendRevision: 8,
  documentNonce: "doc", rendererInstance: 1, completedFrames: 8,
  presented: true, pending: 0, failure: null }, atPageMs: 27,
atEpochMs: 1_800_000_000_027 });
assert.equal(inspectStartupWorkload(workload, workloadExpected, laterPresentation).accepted, true,
  "later nearby backend present cannot replace the mapped completion");
const duplicateCommit = structuredClone(page.__benchStartupResources);
duplicateCommit.events.push({ ...duplicateCommit.events.find((row) => row.name === "commit"),
  atPageMs: 27, atEpochMs: 1_800_000_000_027 });
assert.ok(inspectStartupWorkload(workload, workloadExpected, duplicateCommit)
  .failures.includes("finalPresentationMapping"), "duplicate mapping rejects");
assert.ok(inspectStartupResources(page.__benchStartupResources, final, false, workload).failures.includes("atlasPixels"));
const incomplete = structuredClone(page.__benchStartupResources);
incomplete.events = incomplete.events.filter((row) => row.name !== "commit");
assert.ok(inspectStartupResources(incomplete, final, true, workload).failures.includes("finalPresentationMapping"));
const malformedPixels = structuredClone(page.__benchStartupResources);
malformedPixels.events.find((row) => row.name === "pixels").detail.rgbaBytes = 20;
assert.ok(inspectStartupResources(malformedPixels, final, true, workload).failures.includes("pixelOperations"));
for (const [name, changedWorkload, changedResources] of [
  ["stale scene", { ...workload, end: { ...workload.end, committedPresentation: { ...committed,
    sceneRevision: 171 } } }, page.__benchStartupResources],
  ["other instance", { ...workload, end: { ...workload.end, committedPresentation: { ...committed,
    rendererInstance: 2 } } }, page.__benchStartupResources],
  ["later backend event", { ...workload, end: { ...workload.end, committedPresentation: { ...committed,
    backendRevision: 8 } } }, page.__benchStartupResources],
  ["failed present", workload, { ...page.__benchStartupResources,
    events: page.__benchStartupResources.events.map((row) => row.name === "present" &&
      row.detail.backendRevision === 7 ? { ...row, detail: { ...row.detail, failure: "GPU error" } } : row) }],
]) assert.ok(inspectStartupWorkload(changedWorkload, workloadExpected, changedResources)
  .failures.includes("finalPresentationMapping"), `${name} must reject`);
assert.ok(inspectStartupWorkload({ ...workload, end: null }, workloadExpected,
  page.__benchStartupResources).failures.includes("completionMissingOrDuplicate"));
assert.ok(inspectStartupWorkload({ ...workload, fullSceneCount: 2 }, workloadExpected,
  page.__benchStartupResources).failures.includes("completionMissingOrDuplicate"));
assert.ok(inspectStartupWorkload({ ...workload, end: { ...workload.end,
  delivery: { ...workload.end.delivery, hash: "wrong" } } }, workloadExpected,
page.__benchStartupResources).failures.includes("deliveryDigest"));
for (const mutation of [
  { resources: { pending: 0, failed: 1 } },
  { pendingBreakdown: { refinement: 1 } },
  { asyncAwaitingAckRevision: 172 },
  { lifecycle: { contextReady: 0, presentationValid: 1 } },
]) {
  const localPage = { __benchDocumentNonce: "doc",
    __benchActiveDeliveryState: () => ({ count: 3, hash: "complete", lastT: 6499 }),
    __mirrorGlContextEvents: () => ({ losses: 0, creationErrors: 0 }),
    rendererState: { ...renderer(true), ...mutation } };
  localPage.__mirrorRendererDiagnostics = () => localPage.rendererState;
  const localMarks = [];
  runInNewContext(`(${installStartupResourceReceipt.toString()})(${JSON.stringify({
    count: 3, hash: "complete", finalRevision: 172 })})`, {
    ...context, window: localPage, console: { timeStamp: (label) => localMarks.push(label) },
  });
  localPage.__benchStartupFullSceneBeforeDelivery({ t: 2326 });
  localPage.__benchStartupDelivered();
  localPage.__benchStartupPresentationComplete();
  assert.deepEqual(localMarks, ["cc-report-start"], "invalid final presentation cannot end interval");
}
const duplicatePage = { ...page, __benchStartupWorkload: null };
const duplicateMarks = [];
runInNewContext(`(${installStartupResourceReceipt.toString()})(${JSON.stringify({
  count: 3, hash: "complete", finalRevision: 172 })})`, {
  ...context, window: duplicatePage, console: { timeStamp: (label) => duplicateMarks.push(label) },
});
duplicatePage.__benchStartupFullSceneBeforeDelivery({ t: 2326 });
duplicatePage.__benchStartupFullSceneBeforeDelivery({ t: 2326 });
duplicatePage.__benchStartupDelivered();
duplicatePage.__benchStartupPresentationComplete();
assert.deepEqual(duplicateMarks, ["cc-report-start"], "duplicate full scene cannot end interval");
const finalInput = { workload, finalPage, targetBefore: "target-1",
  targetAfter: "target-1", copyControl: true };
assert.equal(inspectStartupFinalState(finalInput).accepted, true);
assert.ok(inspectStartupFinalState({ ...finalInput, targetAfter: "target-2" }).failures.includes("finalIdentity"));
assert.ok(inspectStartupFinalState({ ...finalInput, finalPage: { ...finalPage,
  documentNonce: "navigated" } }).failures.includes("finalIdentity"));
assert.ok(inspectStartupFinalState({ ...finalInput, finalPage: { ...finalPage,
  renderer: { ...finalPage.renderer, effective: { ...effective, shaders: "on" } } } })
  .failures.includes("finalSettingsOrContext"));
assert.ok(inspectStartupFinalState({ ...finalInput, finalPage: { ...finalPage,
  contextEvents: { losses: 1, creationErrors: 0 } } }).failures.includes("finalSettingsOrContext"));

const dir = mkdtempSync(join(tmpdir(), "startup-observation-"));
try {
  const ps = "PID RSS NAME\n100 5000 com.android.chrome\n200 5000 com.android.chrome:privileged_process0\n300 5000 com.android.chrome:sandboxed_process0\n";
  const beforePath = join(dir, "before.txt"), afterPath = join(dir, "after.txt"), tracePath = join(dir, "trace.json");
  writeFileSync(beforePath, ps); writeFileSync(afterPath, ps);
  writeFileSync(tracePath, JSON.stringify([
    { name: "TimeStamp", ts: 1_000_000, pid: 300, args: { data: { message: "cc-report-start" } } },
    { name: "TimeStamp", ts: 1_005_000, pid: 300, args: { data: { message: "cc-report-end" } } },
  ]));
  writeFileSync(`${tracePath}.meta.json`, JSON.stringify({ tracingComplete: true, dataLossOccurred: false,
    maxBufferPercent: 0.2, fullRawEvents: true }));
  const input = { before: { path: beforePath, capturedEpochMs: 1_799_999_999_000 },
    after: { path: afterPath, capturedEpochMs: 1_800_000_007_000 },
    browser: { packageName: "com.android.chrome", pid: 100 }, tracePath,
    workload };
  assert.equal(inspectStartupProcessAndTrace(input).accepted, true);
  assert.ok(inspectStartupProcessAndTrace({ ...input,
    after: { ...input.after, capturedEpochMs: 1_800_000_000_024 } }).failures.includes("processLedgers"));
  assert.ok(inspectStartupProcessAndTrace({ ...input, after: null }).failures.includes("processLedgers"));
  const traceRows = JSON.parse(readFileSync(tracePath, "utf8"));
  writeFileSync(tracePath, JSON.stringify([...traceRows, traceRows[0]]));
  assert.ok(inspectStartupProcessAndTrace(input).failures.includes("traceMarkerWindow"));
  writeFileSync(tracePath, JSON.stringify(traceRows));
  writeFileSync(tracePath, readFileSync(tracePath, "utf8").replace('"pid":300,"args":{"data":{"message":"cc-report-end"}}',
    '"pid":301,"args":{"data":{"message":"cc-report-end"}}'));
  assert.ok(inspectStartupProcessAndTrace(input).failures.includes("markerRendererPid"));
  writeFileSync(`${tracePath}.meta.json`, JSON.stringify({ tracingComplete: true, dataLossOccurred: true,
    maxBufferPercent: 1, fullRawEvents: true }));
  assert.ok(inspectStartupProcessAndTrace(input).failures.includes("traceCompleteness"));
  for (const meta of [
    { tracingComplete: true, maxBufferPercent: 0.2, fullRawEvents: true },
    { tracingComplete: true, dataLossOccurred: null, maxBufferPercent: 0.2, fullRawEvents: true },
    { tracingComplete: true, dataLossOccurred: false, maxBufferPercent: null, fullRawEvents: true },
    { tracingComplete: true, dataLossOccurred: false, maxBufferPercent: 1, fullRawEvents: true },
  ]) {
    writeFileSync(`${tracePath}.meta.json`, JSON.stringify(meta));
    assert.ok(inspectStartupProcessAndTrace(input).failures.includes("traceCompleteness"));
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

const source = readFileSync(new URL("./bench-mirror-replay.mjs", import.meta.url), "utf8");
const baseArgs = { startupObservationOut: "ignored.json", url: "http://127.0.0.1:5180/?stage=rust",
  query: "rustDiagnostics=1" };
assert.equal(startupTimingQueryError(baseArgs), null);
for (const value of ["1", "true", "TRUE", "on", "yes"]) {
  assert.match(startupTimingQueryError({ ...baseArgs, query: `rustDebug=${value}` }), /cannot use rustDebug/);
  assert.match(startupTimingQueryError({ ...baseArgs,
    url: `${baseArgs.url}&rustDebug=${value}` }), /cannot use rustDebug/);
}
assert.equal(startupTimingQueryError({ ...baseArgs, query: "rustDebug=1",
  url: `${baseArgs.url}&rustDebug=0` }), null, "URL query retains actual precedence");
assert.match(startupTimingQueryError({ ...baseArgs, query: "rustDebug=0&rustDebug=1" }),
  /cannot use rustDebug/, "last --query value wins");
assert.equal(startupTimingQueryError({ ...baseArgs, query: "rustDebug=1&rustDebug=0" }), null);
assert.match(startupTimingQueryError({ ...baseArgs,
  url: `${baseArgs.url}&rustDebug=0&rustDebug=1` }), /cannot use rustDebug/,
"last URL value wins");
assert.equal(startupTimingQueryError({ ...baseArgs,
  url: `${baseArgs.url}&rustDebug=1&rustDebug=0` }), null);
assert.equal(startupTimingQueryError({ ...baseArgs, query: "rustDebug=0&rustDiagnostics=1" }), null);
assert.match(source, /startupObservationOut[\s\S]*?await markerTrace\.start\(\)/);
assert.match(source, /activeWindowWitness: !!\(args\.activeWindowWitness \|\| args\.startupObservationOut\)/);
assert.match(source, /if \(opts\.preIdleWitness \|\| opts\.activeWindowWitness \|\| opts\.startupObservationOut \|\| opts\.activeVisualReferenceOut\) \{/);
assert.match(source, /if \(args\.activeWindowWitness \|\| args\.startupObservationOut\) await addBoundedInitScript\("active window boundary"/);
assert.match(source, /await markerTrace\.start\(\);[\s\S]*?noteStartupNavigation\("harness\.gotoReplay"/);
assert.match(source, /if \(!opts\.activeWindowWitness && !opts\.startupObservationOut\) try/);
assert.match(source, /startupObservation: true/);
assert.match(source, /comparisonEligibility: args\.startupObservationOut \? \{ fps: false, equivalence: false \}/);
const rejected = spawnSync(process.execPath, [new URL("./bench-mirror-replay.mjs", import.meta.url).pathname,
  "--startup-observation-out", "ignored.json", "--parity-capture", "ignored-parity.json"],
{ encoding: "utf8", timeout: 5000 });
assert.equal(rejected.status, 2);
assert.match(rejected.stderr, /cannot use --parity-capture diagnostic clock/);
const startupCli = [new URL("./bench-mirror-replay.mjs", import.meta.url).pathname,
  "--startup-observation-out", "ignored.json", "--url", `${baseArgs.url}&rustDebug=on`,
  "--connect-cdp", "ws://127.0.0.1:19999", "--fresh-defaults", "--window", "2500:6500",
  "--limit-ms", "6500", "--repeats", "1", "--report", "ignored-report.json", "--trace", "ignored-trace.json",
  "--active-source-sha256", "a".repeat(64), "--witness-browser-package", "com.android.chrome",
  "--witness-browser-pid", "123", "--startup-expected-recording-sha256", "a".repeat(64),
  "--startup-expected-delivery-count", "173", "--startup-expected-delivery-hash", "da5535f5"];
const missingPin = spawnSync(process.execPath, startupCli.slice(0, -6), { encoding: "utf8", timeout: 5000,
  env: { ...process.env, COUCHCOOP_BENCH_ADB_SERIAL: "fake-offline-serial" } });
assert.equal(missingPin.status, 2);
assert.match(missingPin.stderr, /requires explicit expected recording SHA-256/);
const wrongRecordingDir = mkdtempSync(join(tmpdir(), "startup-recording-pin-"));
try {
  const wrongRecording = join(wrongRecordingDir, "wrong.ndjson");
  writeFileSync(wrongRecording, "wrong recording bytes\n");
  const wrongFile = spawnSync(process.execPath, [
    ...startupCli.map((arg) => arg === `${baseArgs.url}&rustDebug=on` ? baseArgs.url : arg),
    "--recording", wrongRecording,
  ], { encoding: "utf8", timeout: 5000,
    env: { ...process.env, COUCHCOOP_BENCH_ADB_SERIAL: "fake-offline-serial" } });
  assert.equal(wrongFile.status, 2);
  assert.match(wrongFile.stderr, /startup recording pin rejected: recordingSha256/);
} finally { rmSync(wrongRecordingDir, { recursive: true, force: true }); }
const cliRejected = spawnSync(process.execPath, startupCli, { encoding: "utf8", timeout: 5000,
  env: { ...process.env, COUCHCOOP_BENCH_ADB_SERIAL: "fake-offline-serial" } });
assert.equal(cliRejected.status, 2, "rustDebug must fail before recording and CDP setup");
assert.match(cliRejected.stderr, /cannot use rustDebug/);
const duplicateCli = spawnSync(process.execPath, startupCli.map((arg) =>
  arg === `${baseArgs.url}&rustDebug=on` ? `${baseArgs.url}&rustDebug=0&rustDebug=1` : arg),
{ encoding: "utf8", timeout: 5000,
  env: { ...process.env, COUCHCOOP_BENCH_ADB_SERIAL: "fake-offline-serial" } });
assert.equal(duplicateCli.status, 2);
assert.match(duplicateCli.stderr, /cannot use rustDebug/);
console.log("startup observation offline tests passed");
