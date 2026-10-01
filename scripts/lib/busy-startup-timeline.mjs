// Installed before the untimed visual replay. Renderer hooks push only when this
// opt-in callback exists; the recorded transport and presentation clock are untouched.
export function installBusyStartupTimeline() {
  if (window.__benchBusyStartupTimeline) return;
  const events = [];
  const timeline = { schema: "mirror-busy-startup-timeline/1", timeOrigin: performance.timeOrigin,
    events, dropped: 0 };
  const emit = (name, detail = {}) => {
    if (events.length >= 4096) { timeline.dropped++; return; }
    const atPageMs = performance.now();
    events.push({ name, atPageMs, atEpochMs: performance.timeOrigin + atPageMs,
      documentNonce: window.__benchDocumentNonce ?? null, detail });
  };
  window.__benchBusyStartupTimeline = timeline;
  window.__benchBusyStartupEvent = emit;
  emit("document.init", { url: location.href, visibility: document.visibilityState,
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio });
  document.addEventListener("visibilitychange", () => emit("document.visibility", {
    state: document.visibilityState, hidden: document.hidden }));
  window.addEventListener("pagehide", () => emit("document.pagehide", { url: location.href }));
  window.addEventListener("pageshow", () => emit("document.pageshow", { url: location.href }));
  window.addEventListener("resize", () => emit("document.resize", {
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  for (const name of ["webglcontextlost", "webglcontextrestored", "webglcontextcreationerror"]) {
    document.addEventListener(name, (event) => emit(`context.${name}`, {
      message: event.statusMessage ?? null }), true);
  }
}

export function inspectBusyStartupTimeline(timeline) {
  const rows = timeline?.events;
  const failures = [];
  if (timeline?.schema !== "mirror-busy-startup-timeline/1" || !Array.isArray(rows))
    failures.push("schema");
  if (!Number.isFinite(timeline?.timeOrigin) || timeline.timeOrigin <= 0) failures.push("timeOrigin");
  if (timeline?.dropped !== 0) failures.push("eventsDropped");
  if (Array.isArray(rows)) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row?.name || !Number.isFinite(row.atPageMs) ||
          row.atEpochMs !== timeline.timeOrigin + row.atPageMs ||
          (i > 0 && row.atPageMs < rows[i - 1].atPageMs)) {
        failures.push(`event[${i}]`); break;
      }
    }
    for (const name of ["document.init", "stream.fullScene", "stream.boundaryStart",
      "stream.boundaryEnd", "renderer.create", "renderer.initStart",
      "renderer.initComplete", "renderer.framePrepare", "renderer.frameSubmit",
      "renderer.frameComplete", "renderer.firstReady"]) {
      if (!rows.some((row) => row.name === name)) failures.push(name);
    }
    const at = (name) => rows.find((row) => row.name === name)?.atPageMs;
    if (!(at("stream.fullScene") <= at("stream.boundaryStart") &&
        at("stream.boundaryStart") < at("stream.boundaryEnd"))) failures.push("streamOrder");
    if (!(at("document.init") <= at("renderer.create") &&
        at("renderer.create") <= at("renderer.initStart") &&
        at("renderer.initStart") <= at("renderer.initComplete") &&
        at("renderer.initComplete") <= at("renderer.framePrepare") &&
        at("renderer.framePrepare") <= at("renderer.frameSubmit") &&
        at("renderer.frameSubmit") <= at("renderer.frameComplete") &&
        at("renderer.frameComplete") <= at("renderer.firstReady"))) failures.push("rendererOrder");
    const init = rows.find((row) => row.name === "renderer.initComplete")?.detail;
    if (!(init?.contextReady === true && Number.isInteger(init.pending) && init.pending >= 0 &&
        init.failed === 0)) failures.push("initResources");
    const ready = rows.find((row) => row.name === "renderer.firstReady")?.detail;
    if (!(Number.isInteger(ready?.revision) && ready.pending === 0 && ready.failed === 0 &&
        Number.isInteger(ready.backingWidth) && ready.backingWidth > 0 &&
        Number.isInteger(ready.backingHeight) && ready.backingHeight > 0 &&
        Number.isFinite(ready.dpr) && ready.dpr > 0)) failures.push("firstReadyResources");
  }
  return { accepted: failures.length === 0, failures };
}

// Wall waits include browser scheduling. Only the explicit synchronous spans can
// be attributed to JavaScript work; browser traces supply runnable/awaiting time.
export function summarizeCardAtlasIngestion(timeline) {
  const names = ["fetchStart", "response", "body", "bitmapDecoded", "pixelReadback",
    "sceneSerialized", "firstSubmissionQueued", "firstSubmissionStart",
    "resourcesBatchSerialized", "wasmBatchUpload", "sceneAdmitted", "firstSubmissionComplete"];
  const rows = Array.isArray(timeline?.events) ? timeline.events : [];
  const stages = Object.fromEntries(names.map((name) => [name,
    rows.filter((row) => row.name === `cardAtlas.${name}`)[0] ?? null]));
  const failures = names.flatMap((name) => {
    const count = rows.filter((row) => row.name === `cardAtlas.${name}`).length;
    return count === 1 ? [] : [`${count === 0 ? "missing" : "duplicate"}:${name}`];
  });
  if (rows.some((row) => row.name?.startsWith("cardAtlas.") &&
      !names.includes(row.name.slice("cardAtlas.".length)))) failures.push("unknownStage");
  const key = stages.fetchStart?.detail?.key;
  let keyPath = null;
  try { if (typeof key === "string") keyPath = new URL(key, "https://bench.invalid").pathname; }
  catch { /* Invalid resource keys are rejected below. */ }
  if (keyPath !== "/res/images/atlases/card_atlas_0.png") failures.push("atlasKey");
  for (const name of names) if (stages[name]?.detail?.key !== key) failures.push(`key:${name}`);
  let previous = -Infinity;
  for (const name of names) {
    const row = stages[name];
    if (!row) continue;
    if (!Number.isFinite(row.atPageMs) || row.atPageMs < previous ||
        row.atEpochMs !== timeline.timeOrigin + row.atPageMs) failures.push(`order:${name}`);
    previous = row.atPageMs;
  }
  for (const [name, fields] of Object.entries({
    response: ["waitMs"], body: ["waitMs", "encodedBytes"],
    bitmapDecoded: ["syncCallMs", "awaitMs", "width", "height", "encodedBytes"],
    pixelReadback: ["drawMs", "getImageDataMs", "uint8CopyMs", "width", "height", "rgbaBytes"],
    sceneSerialized: ["durationMs", "sceneBytes"],
    resourcesBatchSerialized: ["durationMs", "batchBytes", "atlasRgbaBytes", "resourceCount"],
    wasmBatchUpload: ["durationMs", "batchBytes", "atlasRgbaBytes", "resourceCount"],
    sceneAdmitted: ["durationMs", "sceneBytes"],
  })) {
    const detail = stages[name]?.detail;
    if (detail && fields.some((field) => !Number.isFinite(detail[field]) || detail[field] < 0))
      failures.push(`detail:${name}`);
  }
  const decoded = stages.bitmapDecoded?.detail;
  const pixels = stages.pixelReadback?.detail;
  if (decoded && pixels && (decoded.width !== pixels.width || decoded.height !== pixels.height ||
      pixels.rgbaBytes !== pixels.width * pixels.height * 4)) failures.push("pixelDimensions");
  if (stages.firstSubmissionQueued?.detail?.hasAtlasUpload !== true) failures.push("atlasUploadMissing");
  if (stages.body && decoded && stages.body.detail.encodedBytes !== decoded.encodedBytes)
    failures.push("encodedBytesMismatch");
  if (pixels && [stages.firstSubmissionQueued?.detail?.rgbaBytes,
    stages.resourcesBatchSerialized?.detail?.atlasRgbaBytes,
    stages.wasmBatchUpload?.detail?.atlasRgbaBytes].some((bytes) => bytes !== pixels.rgbaBytes))
    failures.push("uploadBytesMismatch");
  const serialized = stages.resourcesBatchSerialized?.detail;
  const uploaded = stages.wasmBatchUpload?.detail;
  const composition = serialized?.resources;
  if (serialized && (serialized.scope !== "wholeBatch" || !Array.isArray(composition) ||
      composition.length !== serialized.resourceCount ||
      composition.filter((row) => row.key === key).length !== 1 ||
      composition.some((row) => !Number.isInteger(row.rgbaBytes) || row.rgbaBytes < 0) ||
      composition.find((row) => row.key === key)?.rgbaBytes !== serialized.atlasRgbaBytes ||
      composition.reduce((sum, row) => sum + row.rgbaBytes, 0) > serialized.batchBytes))
    failures.push("batchComposition");
  if (serialized && uploaded && (uploaded.scope !== "wholeBatch" ||
      uploaded.batchBytes !== serialized.batchBytes || uploaded.resourceCount !== serialized.resourceCount ||
      uploaded.atlasRgbaBytes !== serialized.atlasRgbaBytes)) failures.push("batchTransfer");
  if ([stages.sceneSerialized, stages.sceneAdmitted].some((row) => row && row.detail?.scope !== "wholeScene"))
    failures.push("sceneScope");
  if (stages.firstSubmissionComplete?.detail?.presented !== true) failures.push("firstSubmissionNotPresented");
  return { schema: "mirror-card-atlas-ingestion/1", resource: "/res/images/atlases/card_atlas_0.png",
    accepted: failures.length === 0, failures, timingBasis: {
      waitMs: "wall time including browser scheduling", durationMs: "synchronous JavaScript span",
      browserRunnableTime: "inspect browser trace" },
    stages };
}
