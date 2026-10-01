import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inspectMotionCaptures, inspectProcessLedger } from "./post-idle-witness.mjs";
import { requireReadyWitnessState, stableWitnessState } from "./pre-idle-witness.mjs";

export class ActiveWindowWitnessError extends Error {
  constructor(code, receiptPath) {
    super(`active-window witness rejected: ${code}`);
    this.name = "ActiveWindowWitnessError";
    this.code = code;
    this.receiptPath = receiptPath;
  }
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  renameSync(temp, path);
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateActiveVisualReference(reference, { sourceSha256, recordingSha256, browser }) {
  const failures = [];
  const add = (name, valid) => { if (!valid) failures.push(name); };
  add("schema", reference?.schema === "mirror-active-visual-reference/1");
  add("source", reference?.sourceSha256 === sourceSha256);
  add("recording", reference?.recordingSha256 === recordingSha256);
  add("browser", reference?.browser?.packageName === browser.packageName &&
    reference?.browser?.pid === browser.pid);
  add("page", !!reference?.targetId && !!reference?.page?.documentNonce &&
    Number.isFinite(reference?.page?.timeOrigin) &&
    reference?.page?.renderer?.ready === true && reference?.page?.renderer?.backend === "rust" &&
    reference?.page?.renderer?.resources?.pending === 0 &&
    reference?.page?.renderer?.resources?.failed === 0 &&
    reference?.page?.renderer?.lifecycle?.contextReady === 1 &&
    reference?.page?.renderer?.lifecycle?.presentationValid === 1 &&
    reference?.page?.contextEvents?.losses === 0 &&
    reference?.page?.contextEvents?.creationErrors === 0 &&
    reference?.page?.savedSettings === null && reference?.page?.freshDefaults?.cleared === true &&
    reference?.page?.quality?.choice === "auto" &&
    ["auto", "default"].includes(reference?.page?.quality?.source) &&
    reference?.page?.quality?.tier === reference?.page?.renderer?.effective?.quality &&
    reference?.page?.visibility?.state === "visible" &&
    reference?.page?.visibility?.hidden === false &&
    reference?.page?.viewport?.width > reference?.page?.viewport?.height &&
    reference?.page?.viewport?.dpr > 0 &&
    reference?.page?.renderer?.effective?.shaders === "off" &&
    reference?.page?.renderer?.effective?.particles === "off" &&
    reference?.page?.renderer?.effective?.staticBg != null &&
    reference?.page?.renderer?.effective?.spineMode != null &&
    Number.isInteger(reference?.page?.renderer?.effective?.backingWidth) &&
    reference.page.renderer.effective.backingWidth > 0 &&
    Number.isInteger(reference?.page?.renderer?.effective?.backingHeight) &&
    reference.page.renderer.effective.backingHeight > 0 &&
    Number.isFinite(reference?.page?.renderer?.effective?.dpr) &&
    reference.page.renderer.effective.dpr > 0);
  const boundary = reference?.boundary;
  add("boundary", boundary?.start?.boundMs === 2500 && boundary?.end?.boundMs === 6500 &&
    Number.isFinite(boundary.start.atEpochMs) && Number.isFinite(boundary.end.atEpochMs) &&
    boundary.end.atEpochMs > boundary.start.atEpochMs &&
    boundary.start.atEpochMs >= reference?.page?.timeOrigin);
  let videoValid = false;
  let clockAlignment = null;
  try { videoValid = !!reference?.video?.path &&
    reference.video.sha256 === fileHash(reference.video.path) &&
    reference.video.clockDomain === "host" &&
    reference.video.endedEpochMs > reference.video.startedEpochMs;
    const samples = reference.video.clockSamples;
    const phase = (name) => samples.filter((sample) => sample.phase === name);
    const validSample = (sample) => Number.isFinite(sample.hostBeforeEpochMs) &&
      Number.isFinite(sample.deviceEpochMs) && Number.isFinite(sample.hostAfterEpochMs) &&
      sample.hostAfterEpochMs >= sample.hostBeforeEpochMs &&
      sample.hostAfterEpochMs - sample.hostBeforeEpochMs <= 2000;
    if (!Array.isArray(samples) || samples.length !== 6 || !samples.every(validSample) ||
        phase("start").length !== 3 || phase("end").length !== 3) videoValid = false;
    else {
      const startSamples = phase("start"), endSamples = phase("end");
      const ordered = samples.every((sample, index) => index === 0 ||
        (samples[index - 1].hostAfterEpochMs <= sample.hostBeforeEpochMs &&
         samples[index - 1].deviceEpochMs <= sample.deviceEpochMs)) &&
        samples.slice(0, 3).every((sample) => sample.phase === "start") &&
        samples.slice(3).every((sample) => sample.phase === "end");
      const offsets = (rows) => ({ lower: Math.min(...rows.map((sample) =>
        sample.hostBeforeEpochMs - sample.deviceEpochMs)),
      upper: Math.max(...rows.map((sample) => sample.hostAfterEpochMs - sample.deviceEpochMs)) });
      clockAlignment = { start: offsets(startSamples), end: offsets(endSamples),
        sampleCount: samples.length, maxSampleRttMs: Math.max(...samples.map((sample) =>
          sample.hostAfterEpochMs - sample.hostBeforeEpochMs)) };
      videoValid = videoValid && ordered &&
        startSamples[0].hostBeforeEpochMs >= reference.video.startedEpochMs &&
        startSamples[0].hostBeforeEpochMs - reference.video.startedEpochMs <= 1000 &&
        endSamples[2].hostAfterEpochMs <= reference.video.endedEpochMs &&
        reference.video.endedEpochMs - endSamples[2].hostAfterEpochMs <= 1000 &&
        startSamples[2].hostAfterEpochMs <= boundary.start.atEpochMs + clockAlignment.start.lower &&
        endSamples[0].hostBeforeEpochMs >= boundary.end.atEpochMs + clockAlignment.end.upper &&
        reference.video.startedEpochMs <= boundary.start.atEpochMs + clockAlignment.start.lower &&
        reference.video.endedEpochMs >= boundary.end.atEpochMs + clockAlignment.end.upper;
    }
  }
  catch { /* missing video fails reference admission */ }
  add("video", videoValid);
  return { accepted: failures.length === 0, failures, clockAlignment };
}

export async function runActiveWindowWitness({ prefix, boundary, visualReference, sourceSha256,
  recordingSha256, browser, targetId, capture, timeoutMs = 30_000, signal,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!prefix || !boundary || !visualReference || !sourceSha256 || !recordingSha256 ||
      typeof targetId !== "function" || typeof capture !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError("invalid active-window witness options");
  }
  const readyPath = `${prefix}.post-active-ready.json`;
  const ackPath = `${prefix}.post-active-ack.json`;
  const verifiedPath = `${prefix}.post-active-verified.json`;
  const rejectedPath = `${prefix}.post-active-rejected.json`;
  const receipt = { schema: "mirror-post-active-result/1", sourceSha256, recordingSha256,
    visualReference, boundary, ready: null, ack: null, before: null, after: null,
    motionCaptures: null, processLedger: null, failure: null, finishedEpochMs: null };
  const reject = (code, observed = null) => {
    receipt.failure = { code, observed, atEpochMs: now() };
    receipt.finishedEpochMs = now();
    writeAtomic(rejectedPath, receipt);
    throw new ActiveWindowWitnessError(code, rejectedPath);
  };
  const alive = () => { if (signal?.aborted) reject("navigationOrClose"); };
  if ([readyPath, ackPath, verifiedPath, rejectedPath].some(existsSync)) reject("filesAlreadyExist");
  const visualAdmission = validateActiveVisualReference(visualReference, { sourceSha256, recordingSha256, browser });
  if (!visualAdmission.accepted) reject("visualReferenceInvalid", visualAdmission.failures);
  receipt.visualClockAlignment = visualAdmission.clockAlignment;
  alive();
  try { receipt.before = await capture(); }
  catch (error) { reject("pageCaptureFailure", String(error)); }
  alive();
  try { requireReadyWitnessState(receipt.before, true); }
  catch (error) { reject("readinessFailure", { phase: "before", error: String(error), page: receipt.before }); }
  const start = boundary.start, end = boundary.end;
  if (!start?.documentNonce || start.documentNonce !== end?.documentNonce ||
      start.documentNonce !== receipt.before.documentNonce ||
      start.timeOrigin !== end.timeOrigin || end.timeOrigin !== receipt.before.timeOrigin ||
      start.url !== end.url || end.url !== receipt.before.url ||
      start.renderer?.instance !== end.renderer?.instance ||
      end.renderer?.instance !== receipt.before.renderer.instance) {
    reject("boundaryIdentityChanged", { start, end, page: receipt.before });
  }
  const visual = visualReference.page;
  receipt.visualMeasuredComparison = {
    viewportDelta: {
      width: receipt.before.viewport.width - visual.viewport.width,
      height: receipt.before.viewport.height - visual.viewport.height,
      dpr: receipt.before.viewport.dpr - visual.viewport.dpr,
    },
    backingDelta: {
      width: receipt.before.renderer.effective?.backingWidth - visual.renderer.effective?.backingWidth,
      height: receipt.before.renderer.effective?.backingHeight - visual.renderer.effective?.backingHeight,
      dpr: receipt.before.renderer.effective?.dpr - visual.renderer.effective?.dpr,
    },
    effective: { visual: visual.renderer.effective, measured: receipt.before.renderer.effective },
  };
  if (visualReference.page.documentNonce === receipt.before.documentNonce ||
      visualReference.page.timeOrigin === receipt.before.timeOrigin ||
      visualReference.page.quality?.tier !== receipt.before.quality?.tier ||
      visualReference.page.renderer?.effective?.quality !== receipt.before.renderer.effective?.quality ||
      visualReference.page.url !== receipt.before.url ||
      ["shaders", "particles", "staticBg", "spineMode"].some((key) =>
        visual.renderer.effective?.[key] !== receipt.before.renderer.effective?.[key]) ||
      Math.abs(receipt.visualMeasuredComparison.viewportDelta.width) > 1 ||
      Math.abs(receipt.visualMeasuredComparison.viewportDelta.height) > 1 ||
      receipt.visualMeasuredComparison.viewportDelta.dpr !== 0 ||
      !Number.isInteger(receipt.before.renderer.effective?.backingWidth) ||
      !Number.isInteger(receipt.before.renderer.effective?.backingHeight) ||
      !(receipt.before.renderer.effective?.dpr > 0) ||
      receipt.visualMeasuredComparison.backingDelta.width !== 0 ||
      receipt.visualMeasuredComparison.backingDelta.height !== 0 ||
      receipt.visualMeasuredComparison.backingDelta.dpr !== 0) {
    reject("visualMeasuredMismatch", { comparison: receipt.visualMeasuredComparison,
      visual, measured: receipt.before });
  }
  let selectedTargetId;
  try { selectedTargetId = await targetId(); }
  catch (error) { reject("targetFailure", String(error)); }
  alive();
  if (!selectedTargetId) reject("targetFailure", "missing protocol target ID");
  if (selectedTargetId === visualReference.targetId) {
    reject("visualMeasuredMismatch", { visualTargetId: visualReference.targetId,
      measuredTargetId: selectedTargetId });
  }
  receipt.ready = { schema: "mirror-post-active-ready/1", token: randomUUID(),
    documentNonce: receipt.before.documentNonce, timeOrigin: receipt.before.timeOrigin,
    targetId: selectedTargetId, browser, url: receipt.before.url,
    renderer: receipt.before.renderer, quality: receipt.before.quality,
    visibility: receipt.before.visibility, viewport: receipt.before.viewport,
    contextEvents: receipt.before.contextEvents, savedSettings: receipt.before.savedSettings,
    freshDefaults: receipt.before.freshDefaults, sourceSha256, recordingSha256,
    boundary, createdEpochMs: now() };
  writeAtomic(readyPath, receipt.ready);
  const deadline = now() + timeoutMs;
  while (!existsSync(ackPath)) {
    alive();
    if (now() >= deadline) reject("timeout");
    await sleep(50);
  }
  alive();
  try { receipt.ack = JSON.parse(readFileSync(ackPath, "utf8")); }
  catch (error) { reject("ackMalformed", String(error)); }
  const ack = receipt.ack;
  try { receipt.processLedger = inspectProcessLedger(ack.processLedger, browser); }
  catch (error) { receipt.ledgerInspectionError = String(error); }
  if (ack.schema !== "mirror-post-active-ack/1" || ack.token !== receipt.ready.token ||
      ack.documentNonce !== receipt.ready.documentNonce || ack.targetId !== selectedTargetId ||
      ack.browser?.packageName !== browser.packageName || ack.browser?.pid !== browser.pid) {
    reject("ackIdentityMismatch", ack);
  }
  try { receipt.motionCaptures = inspectMotionCaptures(ack.captures, receipt.ready); }
  catch (error) { reject("motionCaptureFailure", String(error)); }
  if (ack.captureOk !== true || !receipt.motionCaptures) reject("motionCaptureFailure", ack);
  if (!receipt.processLedger) reject("ledgerFailure", ack.processLedger);
  const lastMotionEpochMs = Math.max(...receipt.motionCaptures.flatMap((row) =>
    [row.physicalEpochMs, row.pageEpochMs]));
  if (receipt.processLedger.capturedEpochMs < lastMotionEpochMs ||
      receipt.processLedger.capturedEpochMs > now()) reject("ledgerFailure", ack.processLedger);
  try { receipt.after = await capture(); }
  catch (error) { reject("pageCaptureFailure", { phase: "after", error: String(error) }); }
  alive();
  try { requireReadyWitnessState(receipt.after, true); }
  catch (error) { reject("readinessFailure", { phase: "after", error: String(error) }); }
  let finalTargetId;
  try { finalTargetId = await targetId(); }
  catch (error) { reject("targetFailure", String(error)); }
  alive();
  if (finalTargetId !== selectedTargetId ||
      stableWitnessState(receipt.before) !== stableWitnessState(receipt.after)) {
    reject("identityChanged", { targetBefore: selectedTargetId, targetAfter: finalTargetId,
      pageBefore: receipt.before, pageAfter: receipt.after });
  }
  if (!boundary.accepted) reject("boundaryInvalid", boundary.failures);
  receipt.finishedEpochMs = now();
  writeAtomic(verifiedPath, receipt);
  return receipt;
}

export function activeWindowRejectedRepeats(runs, requested) {
  if (!requested) return [];
  return runs.flatMap((run, index) => {
    const marker = run.activeWindowWitness;
    let accepted = false;
    try {
      if (marker?.verified && marker.receiptPath) {
        const receipt = JSON.parse(readFileSync(marker.receiptPath, "utf8"));
        const motion = inspectMotionCaptures(receipt.motionCaptures, receipt.ready);
        const ledger = inspectProcessLedger(receipt.processLedger, receipt.ready.browser);
        const visual = validateActiveVisualReference(receipt.visualReference, {
          sourceSha256: receipt.sourceSha256, recordingSha256: receipt.recordingSha256,
          browser: receipt.ready.browser });
        accepted = receipt.schema === "mirror-post-active-result/1" && !receipt.failure &&
          receipt.boundary?.accepted === true && receipt.ack?.captureOk === true &&
          receipt.ack?.token === receipt.ready?.token && motion?.length >= 2 &&
          visual.accepted &&
          ledger?.sha256 === receipt.processLedger?.sha256 &&
          marker.processLedger?.sha256 === ledger.sha256 && !!receipt.before && !!receipt.after;
      }
    } catch { /* any missing artifact rejects the cell */ }
    return accepted ? [] : [{ repeat: index + 1, code: run.activeWindowFailure?.code ?? "missingActiveWindowWitness",
      reason: run.activeWindowFailure?.reason ?? run.crashReason ?? "active boundary or physical witness is absent",
      receiptPath: run.activeWindowFailure?.receiptPath ?? marker?.receiptPath ?? null }];
  });
}
