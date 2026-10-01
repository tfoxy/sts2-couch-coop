import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { markerWindowOrError, traceMarkerLabel, ACTIVE_TRACE_WINDOW } from "../bench-trace-lifecycle.mjs";
import { inspectProcessLedger } from "./post-idle-witness.mjs";
import { requireReadyWitnessState } from "./pre-idle-witness.mjs";

// Caller-supplied frozen facts are independent of whichever recording path the
// harness loaded. Check the bytes before navigation and the sliced delivery
// sequence before installing the replay transport.
export function inspectStartupRecordingPin({ expectedRecordingSha256, actualRecordingSha256,
  expectedDeliveryCount, expectedDeliveryHash, actualDelivery }) {
  const failures = [];
  if (!/^[a-f0-9]{64}$/i.test(expectedRecordingSha256 ?? "") ||
      !/^[a-f0-9]{64}$/i.test(actualRecordingSha256 ?? "") ||
      expectedRecordingSha256.toLowerCase() !== actualRecordingSha256.toLowerCase())
    failures.push("recordingSha256");
  if (!Number.isSafeInteger(expectedDeliveryCount) || expectedDeliveryCount <= 0 ||
      !/^[a-f0-9]{8}$/i.test(expectedDeliveryHash ?? "")) failures.push("deliveryPin");
  if (actualDelivery !== undefined && (actualDelivery?.count !== expectedDeliveryCount ||
      actualDelivery?.hash?.toLowerCase() !== expectedDeliveryHash?.toLowerCase()))
    failures.push("deliverySequence");
  return { accepted: failures.length === 0, failures };
}

// Installed only for a startup observation. The renderer emits operation facts;
// this recorder adds page timestamps without copying pixels or touching the clock.
export function installStartupResourceReceipt(config) {
  const events = [];
  const receipt = { schema: "mirror-startup-resources/1", timeOrigin: performance.timeOrigin,
    events, dropped: 0 };
  window.__benchStartupResources = receipt;
  const workload = { schema: "mirror-startup-workload/1", expected: config,
    start: null, end: null, fullSceneCount: 0, finalDelivery: null, presentationChecks: 0,
    lastCommittedPresentation: null };
  window.__benchStartupWorkload = workload;
  window.__benchStartupFullSceneBeforeDelivery = (message) => {
    workload.fullSceneCount++;
    if (workload.start) return;
    const atPageMs = performance.now();
    workload.start = { atPageMs, atEpochMs: performance.timeOrigin + atPageMs,
      timeOrigin: performance.timeOrigin, documentNonce: window.__benchDocumentNonce ?? null,
      url: location.href, messageT: message.t,
      deliveryBefore: window.__benchActiveDeliveryState?.() ?? null };
    console.timeStamp("cc-report-start");
  };
  window.__benchStartupDelivered = () => {
    const delivery = window.__benchActiveDeliveryState?.() ?? null;
    if (delivery?.count === config.count) workload.finalDelivery = delivery;
  };
  window.__benchStartupPresentationComplete = () => {
    workload.presentationChecks++;
    if (!workload.start || workload.end || workload.fullSceneCount !== 1 ||
        workload.finalDelivery?.count !== config.count ||
        workload.finalDelivery?.hash !== config.hash) return;
    const renderer = window.__mirrorRendererDiagnostics?.() ?? null;
    const context = window.__mirrorGlContextEvents?.() ?? null;
    const committed = workload.lastCommittedPresentation;
    if (renderer?.backend !== "rust" || renderer?.frameIdentity?.revision !== config.finalRevision ||
        committed?.sceneRevision !== config.finalRevision ||
        committed?.rendererInstance !== (renderer.instance?.id ?? renderer.instance) ||
        committed?.documentNonce !== (window.__benchDocumentNonce ?? null) ||
        !Number.isSafeInteger(committed?.backendRevision) ||
        committed?.completedFrames !== renderer.draw?.completedFrames ||
        JSON.stringify(committed?.frameIdentity) !== JSON.stringify(renderer.frameIdentity) ||
        renderer.ready !== true || renderer.readiness !== "ready" || renderer.failure ||
        renderer.resources?.pending !== 0 || renderer.resources?.failed !== 0 ||
        renderer.pendingBreakdown?.refinement !== 0 ||
        renderer.asyncSubmissionRevision !== null || renderer.asyncAwaitingAckRevision !== null ||
        renderer.lifecycle?.contextReady !== 1 || renderer.lifecycle?.presentationValid !== 1 ||
        !(renderer.draw?.completedFrames > 0) || !(renderer.draw?.objects > 0) ||
        context?.losses !== 0 || context?.creationErrors !== 0 ||
        document.visibilityState !== "visible" || document.hidden) return;
    const atPageMs = performance.now();
    workload.end = { atPageMs, atEpochMs: performance.timeOrigin + atPageMs,
      timeOrigin: performance.timeOrigin, documentNonce: window.__benchDocumentNonce ?? null,
      url: location.href, delivery: workload.finalDelivery,
      committedPresentation: workload.lastCommittedPresentation,
      renderer: { backend: renderer.backend, instance: renderer.instance?.id ?? renderer.instance ?? null,
        revision: renderer.frameIdentity.revision, frameIdentity: renderer.frameIdentity,
        draw: renderer.draw, resources: renderer.resources, pendingBreakdown: renderer.pendingBreakdown,
        effective: renderer.effective, lifecycle: renderer.lifecycle,
        asyncSubmissionRevision: renderer.asyncSubmissionRevision,
        asyncAwaitingAckRevision: renderer.asyncAwaitingAckRevision },
      contextEvents: context,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      visibility: { state: document.visibilityState, hidden: document.hidden } };
    console.timeStamp("cc-report-end");
  };
  window.__benchStartupResourceEvent = (name, detail) => {
    if (events.length >= 4096) { receipt.dropped++; return; }
    const atPageMs = performance.now();
    const row = { name, detail, atPageMs, atEpochMs: performance.timeOrigin + atPageMs };
    events.push(row);
    return row;
  };
  window.__benchStartupCommittedPresentation = (detail) => {
    if (window.__benchStartupResourceEvent("commit", detail)) workload.lastCommittedPresentation = detail;
  };
}

export function inspectStartupPresentationLink(receipt, workload, finalRevision = 172) {
  const failures = [];
  const end = workload?.end, start = workload?.start;
  const mapping = end?.committedPresentation;
  const rows = Array.isArray(receipt?.events) ? receipt.events : [];
  const commitRows = rows.filter((row) => row.name === "commit" &&
    row.detail?.documentNonce === mapping?.documentNonce &&
    row.detail?.rendererInstance === mapping?.rendererInstance &&
    row.detail?.backendRevision === mapping?.backendRevision &&
    row.detail?.completedFrames === mapping?.completedFrames &&
    row.detail?.sceneRevision === mapping?.sceneRevision);
  const presentRows = rows.filter((row) => row.name === "present" &&
    row.detail?.documentNonce === mapping?.documentNonce &&
    row.detail?.rendererInstance === mapping?.rendererInstance &&
    row.detail?.backendRevision === mapping?.backendRevision &&
    row.detail?.completedFrames === mapping?.completedFrames);
  const commit = commitRows.length === 1 ? commitRows[0] : null;
  const present = presentRows.length === 1 ? presentRows[0] : null;
  if (!mapping || mapping.presented !== true || !Number.isSafeInteger(mapping.backendRevision) ||
      !Number.isSafeInteger(mapping.completedFrames) || mapping.completedFrames < 1 ||
      mapping.sceneRevision !== finalRevision || mapping.sceneRevision !== end?.renderer?.revision ||
      mapping.rendererInstance !== end?.renderer?.instance ||
      mapping.documentNonce !== end?.documentNonce || mapping.documentNonce !== start?.documentNonce ||
      JSON.stringify(mapping.frameIdentity) !== JSON.stringify(end?.renderer?.frameIdentity) ||
      mapping.completedFrames !== end?.renderer?.draw?.completedFrames || !commit || !present ||
      JSON.stringify(commit?.detail) !== JSON.stringify(mapping) ||
      !(start?.atPageMs <= present?.atPageMs && present.atPageMs <= commit?.atPageMs &&
        commit.atPageMs <= end?.atPageMs) ||
      present?.detail?.presented !== true || present?.detail?.pending !== 0 ||
      present?.detail?.failure != null)
    failures.push("finalPresentationMapping");
  return { accepted: failures.length === 0, failures, commit, present };
}

export function inspectStartupResources(receipt, finalPage, copyControl, workload, finalRevision = 172) {
  const failures = [];
  const rows = receipt?.events;
  if (receipt?.schema !== "mirror-startup-resources/1" || !Array.isArray(rows) ||
      receipt.dropped !== 0 || !(receipt.timeOrigin > 0) ||
      receipt.timeOrigin !== finalPage?.timeOrigin) failures.push("resourceReceipt");
  if (!Array.isArray(rows)) return { accepted: false, failures, operations: null };
  if (rows.some((row, i) => !["body", "decoded", "pixels", "upload", "present", "commit"].includes(row.name) ||
      !Number.isFinite(row.atPageMs) || row.atEpochMs !== receipt.timeOrigin + row.atPageMs ||
      (i > 0 && row.atPageMs < rows[i - 1].atPageMs))) failures.push("resourceEvents");
  if (rows.some((row) => row.name === "pixels" &&
      (typeof row.detail?.key !== "string" || !Number.isInteger(row.detail.width) ||
       !Number.isInteger(row.detail.height) || row.detail.width <= 0 || row.detail.height <= 0 ||
       row.detail.rgbaBytes !== row.detail.width * row.detail.height * 4 ||
       row.detail.copy !== (copyControl ? "view" : "copy")))) failures.push("pixelOperations");
  if (rows.some((row) => row.name === "upload" &&
      (!Number.isInteger(row.detail?.batchBytes) || row.detail.batchBytes <= 0 ||
       !Array.isArray(row.detail.resources) || !row.detail.resources.length ||
       row.detail.resources.some((item) => typeof item.key !== "string" ||
         item.rgbaBytes !== item.width * item.height * 4)))) failures.push("uploadOperations");
  const atlas = "/res/images/atlases/card_atlas_0.png";
  const pathOf = (key) => { try { return new URL(key, "https://bench.invalid").pathname; }
    catch { return null; } };
  const rowFor = (name) => rows.find((row) => row.name === name &&
    typeof row.detail?.key === "string" && pathOf(row.detail.key) === atlas);
  const body = rowFor("body"), decoded = rowFor("decoded"), pixels = rowFor("pixels");
  const upload = rows.find((row) => row.name === "upload" && row.detail?.resources?.some((item) =>
    typeof item.key === "string" && pathOf(item.key) === atlas));
  if (!body || !decoded || !pixels || !upload ||
      !(body.atPageMs <= decoded.atPageMs && decoded.atPageMs <= pixels.atPageMs &&
        pixels.atPageMs <= upload.atPageMs)) failures.push("atlasOperationSequence");
  if (pixels && (pixels.detail.copy !== (copyControl ? "view" : "copy") ||
      pixels.detail.width !== decoded?.detail?.width || pixels.detail.height !== decoded?.detail?.height ||
      pixels.detail.rgbaBytes !== pixels.detail.width * pixels.detail.height * 4))
    failures.push("atlasPixels");
  const atlasUpload = upload?.detail?.resources?.find((item) =>
    typeof item.key === "string" && pathOf(item.key) === atlas);
  if (atlasUpload && pixels && (atlasUpload.width !== pixels.detail.width ||
      atlasUpload.height !== pixels.detail.height || atlasUpload.rgbaBytes !== pixels.detail.rgbaBytes))
    failures.push("atlasUpload");
  const presentationLink = inspectStartupPresentationLink(receipt, workload, finalRevision);
  if (!presentationLink.accepted) failures.push(...presentationLink.failures);
  const finalPresent = presentationLink.present;
  if (!finalPresent || finalPage?.renderer?.revision !== finalRevision ||
      finalPage.renderer.ready !== true || finalPage.renderer.resources?.pending !== 0 ||
      finalPage.renderer.resources?.failed !== 0 || finalPage.renderer.failure ||
      finalPage.renderer.lifecycle?.presentationValid !== 1 ||
      finalPresent.detail.pending !== 0 || finalPresent.detail.failure != null ||
      finalPresent.detail.completedFrames < 1)
    failures.push("finalPresentation");
  return { accepted: failures.length === 0, failures,
    operations: { atlas: { body, decoded, pixels, upload }, finalPresent,
      committedPresentation: presentationLink.commit,
      count: rows.length, dropped: receipt.dropped } };
}

export function inspectStartupWorkload(workload, expected, resources) {
  const failures = [];
  const start = workload?.start, end = workload?.end;
  if (workload?.schema !== "mirror-startup-workload/1" ||
      workload.fullSceneCount !== 1 || !start || !end || !(workload.presentationChecks > 0))
    failures.push("completionMissingOrDuplicate");
  if (start && end && (!(start.atPageMs < end.atPageMs) ||
      start.atEpochMs !== start.timeOrigin + start.atPageMs ||
      end.atEpochMs !== end.timeOrigin + end.atPageMs ||
      start.timeOrigin !== end.timeOrigin || start.documentNonce !== end.documentNonce ||
      start.url !== end.url || start.messageT !== expected.fullSceneT)) failures.push("workloadIdentityOrTime");
  if (expected.fullSceneCount !== 1 ||
      start?.deliveryBefore?.count !== expected.fullSceneBefore?.count ||
      start?.deliveryBefore?.hash !== expected.fullSceneBefore?.hash ||
      end?.visibility?.state !== "visible" || end?.visibility?.hidden !== false)
    failures.push("workloadStartOrVisibility");
  if (end && (end.delivery?.count !== expected.end.count ||
      end.delivery?.hash !== expected.end.hash || end.delivery?.lastT !== expected.end.lastT ||
      end.delivery?.lastT > 6500 ||
      workload.finalDelivery?.count !== end.delivery.count ||
      workload.finalDelivery?.hash !== end.delivery.hash ||
      workload.expected?.count !== expected.end.count ||
      workload.expected?.hash !== expected.end.hash ||
      workload.expected?.finalRevision !== expected.finalRevision)) failures.push("deliveryDigest");
  if (end && (end.renderer?.revision !== expected.finalRevision ||
      end.renderer?.frameIdentity?.revision !== expected.finalRevision ||
      end.renderer?.backend !== "rust" || end.renderer?.resources?.pending !== 0 ||
      end.renderer?.resources?.failed !== 0 || end.renderer?.pendingBreakdown?.refinement !== 0 ||
      end.renderer?.asyncSubmissionRevision !== null ||
      end.renderer?.asyncAwaitingAckRevision !== null ||
      end.renderer?.lifecycle?.contextReady !== 1 ||
      end.renderer?.lifecycle?.presentationValid !== 1 ||
      !(end.renderer?.draw?.completedFrames > 0) || !(end.renderer?.draw?.objects > 0) ||
      end.contextEvents?.losses !== 0 || end.contextEvents?.creationErrors !== 0))
    failures.push("completionRenderer");
  const presentationLink = inspectStartupPresentationLink(resources, workload, expected.finalRevision);
  if (!presentationLink.accepted) failures.push(...presentationLink.failures);
  const finalPresent = presentationLink.present;
  if (!finalPresent || !start || !end || finalPresent.atPageMs < start.atPageMs ||
      finalPresent.atPageMs > end.atPageMs ||
      finalPresent.detail.pending !== 0 || finalPresent.detail.failure != null)
    failures.push("completionPresentation");
  const uploads = (resources?.events ?? []).filter((row) => row.name === "upload");
  return { accepted: failures.length === 0, failures,
    elapsedMs: start && end ? end.atPageMs - start.atPageMs : null,
    delivery: end?.delivery ?? null,
    draws: end?.renderer?.draw ?? null,
    resourceLedger: { uploads: uploads.length,
      batchBytes: uploads.reduce((sum, row) => sum + (row.detail?.batchBytes ?? 0), 0),
      rgbaBytes: uploads.reduce((sum, row) => sum + (row.detail?.resources ?? []).reduce(
        (nested, item) => nested + (item.rgbaBytes ?? 0), 0), 0) } };
}

export function inspectStartupFinalState({ workload, finalPage, targetBefore, targetAfter, copyControl }) {
  const failures = [];
  try { requireReadyWitnessState(finalPage, true); }
  catch { failures.push("finalReadiness"); }
  const start = workload?.start, end = workload?.end;
  if (!start?.documentNonce || finalPage?.documentNonce !== start.documentNonce ||
      finalPage.documentNonce !== end?.documentNonce || finalPage.timeOrigin !== start.timeOrigin ||
      finalPage.timeOrigin !== end?.timeOrigin || finalPage.url !== end?.url ||
      finalPage.renderer?.instance !== end?.renderer?.instance ||
      !targetBefore || targetAfter !== targetBefore) failures.push("finalIdentity");
  const stableEffective = ["quality", "shaders", "particles", "staticBg", "spineMode",
    "backingWidth", "backingHeight", "dpr", "rustZeroCopyPixels"];
  if (stableEffective.some((key) => end?.renderer?.effective?.[key] !==
      finalPage?.renderer?.effective?.[key]) ||
      end?.viewport?.width !== finalPage?.viewport?.width ||
      end?.viewport?.height !== finalPage?.viewport?.height ||
      end?.viewport?.dpr !== finalPage?.viewport?.dpr ||
      finalPage?.renderer?.effective?.rustZeroCopyPixels !== copyControl ||
      finalPage?.contextEvents?.losses !== 0 || finalPage?.contextEvents?.creationErrors !== 0)
    failures.push("finalSettingsOrContext");
  return { accepted: failures.length === 0, failures };
}

export function inspectStartupProcessAndTrace({ before, after, browser, tracePath, workload }) {
  const failures = [];
  const pre = inspectProcessLedger(before, browser);
  const post = inspectProcessLedger(after, browser);
  const startEpoch = workload?.start?.atEpochMs;
  const endEpoch = workload?.end?.atEpochMs;
  if (!pre || !post || !(pre.capturedEpochMs < startEpoch) ||
      !(post.capturedEpochMs >= endEpoch)) failures.push("processLedgers");
  let markerPids = null;
  let traceSha256 = null;
  try {
    const bytes = readFileSync(tracePath);
    traceSha256 = createHash("sha256").update(bytes).digest("hex");
    const raw = JSON.parse(bytes.toString("utf8"));
    const traceMeta = JSON.parse(readFileSync(`${tracePath}.meta.json`, "utf8"));
    if (traceMeta.tracingComplete !== true || traceMeta.dataLossOccurred !== false ||
        !Number.isFinite(traceMeta.maxBufferPercent) || traceMeta.maxBufferPercent < 0 ||
        traceMeta.maxBufferPercent >= 1 || traceMeta.fullRawEvents !== true)
      failures.push("traceCompleteness");
    const events = Array.isArray(raw) ? raw : raw.traceEvents;
    const markers = markerWindowOrError(events, ACTIVE_TRACE_WINDOW);
    if (markers.error) failures.push("traceMarkers");
    else {
      const count = (label) => events.filter((event) => traceMarkerLabel(event) === label).length;
      if (count(ACTIVE_TRACE_WINDOW.startMarker) !== 1 ||
          count(ACTIVE_TRACE_WINDOW.endMarker) !== 1 ||
          Math.abs(markers.windowMs - (workload.end.atPageMs - workload.start.atPageMs)) > 200)
        failures.push("traceMarkerWindow");
      markerPids = { start: markers.start.pid, end: markers.end.pid };
      const rows = readFileSync(after.path, "utf8").split(/\r?\n/);
      const rendererPids = rows.filter((row) => row.includes(`${browser.packageName}:sandboxed_process`))
        .map((row) => Number(/^\s*(\d+)/.exec(row)?.[1]));
      if (!Number.isInteger(markerPids.start) || markerPids.start !== markerPids.end ||
          !rendererPids.includes(markerPids.start)) failures.push("markerRendererPid");
    }
  } catch { failures.push("traceArtifact"); }
  return { accepted: failures.length === 0, failures, before: pre, after: post,
    markerPids, traceSha256 };
}
