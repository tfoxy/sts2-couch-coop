// This function is installed in the page before navigation. The recorded
// transport calls it at each crossing; CDP round trips never own the bounds.
export function installActiveWindowBoundary(config = {}) {
  const noteFirstReady = () => {
    const renderer = window.__mirrorRendererDiagnostics?.() ?? null;
    if (renderer?.ready === true && renderer?.readiness === "ready" &&
        renderer?.resources?.pending === 0 && renderer?.resources?.failed === 0) {
      window.__benchActiveFirstReadyAtMs = performance.now();
    } else requestAnimationFrame(noteFirstReady);
  };
  if (config.markBoundary !== false) requestAnimationFrame(noteFirstReady);
  const FNV_PRIME = 0x01000193;
  let hash = 0x811c9dc5;
  let count = 0;
  let lastT = null;
  const delivery = (message) => {
    const value = `${message.t}\0${message.data}\0`;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), FNV_PRIME) >>> 0;
    count++;
    lastT = message.t;
  };
  const snapshot = (level, boundMs, elapsedMs) => {
    if (level === 1) {
      for (const key of ["__benchLongTasks", "__benchLoaf", "__benchTicks", "__benchFrameGaps",
        "__benchSceneAckLatencies", "__benchSceneAckPending"]) {
        if (Array.isArray(window[key])) window[key].length = 0;
      }
      window.__benchSceneDeliveries = 0;
    }
    const renderer = window.__mirrorRendererDiagnostics?.() ?? null;
    const context = window.__mirrorGlContextEvents?.() ?? null;
    const atMs = performance.now();
    const row = {
      level, boundMs, elapsedMs, markerWallMinusBoundaryMs: elapsedMs - boundMs,
      atMs, atEpochMs: performance.timeOrigin + atMs,
      documentNonce: window.__benchDocumentNonce ?? null,
      firstReadyAtMs: window.__benchActiveFirstReadyAtMs ?? null,
      timeOrigin: performance.timeOrigin, url: location.href,
      visibility: { state: document.visibilityState, hidden: document.hidden },
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      renderer: renderer && { backend: renderer.backend ?? null,
        instance: renderer.instance?.id ?? renderer.instance ?? null,
        revision: renderer.frameIdentity?.revision ?? renderer.admittedRevision ?? null,
        frameIdentity: renderer.frameIdentity ?? null,
        draw: renderer.draw ?? null,
        readiness: renderer.readiness ?? null, ready: renderer.ready === true,
        resources: renderer.resources ?? null, failure: renderer.failure ?? null,
        lifecycle: renderer.lifecycle ?? null,
        effective: renderer.effective && { quality: renderer.effective.quality ?? null,
          shaders: renderer.effective.shaders ?? null, particles: renderer.effective.particles ?? null,
          staticBg: renderer.effective.staticBg ?? null, spineMode: renderer.effective.spineMode ?? null,
          backingWidth: renderer.effective.backingWidth ?? null,
          backingHeight: renderer.effective.backingHeight ?? null, dpr: renderer.effective.dpr ?? null,
          rustZeroCopyPixels: renderer.effective.rustZeroCopyPixels ?? null } },
      contextEvents: context,
      quality: { choice: new URL(location.href).searchParams.get("quality") ?? "auto",
        tier: renderer?.effective?.quality ?? null },
      savedSettings: localStorage.getItem("couchcoop.mirrorSettings.v1"),
      freshDefaults: window.__benchFreshDefaults ?? null,
      delivery: { count, hash: hash.toString(16).padStart(8, "0"), lastT },
    };
    if (!window.__benchActiveWindowBoundary) window.__benchActiveWindowBoundary = {};
    window.__benchActiveWindowBoundary[level === 1 ? "start" : "end"] = row;
    const marker = level === 1 ? "cc-report-start" : "cc-report-end";
    if (config.markBoundary !== false) {
      console.timeStamp(marker);
      performance.mark(marker);
    }
  };
  window.__benchActiveWindowDelivery = delivery;
  window.__benchActiveDeliveryState = () => ({ count, hash: hash.toString(16).padStart(8, "0"), lastT });
  window.__benchActiveWindowCapture = snapshot;
}

export function digestRecordedMessages(messages) {
  let hash = 0x811c9dc5;
  for (const message of messages) {
    const value = `${message.t}\0${message.data}\0`;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function validateActiveWindowBoundary({ start, end, expectedStart, expectedEnd,
  maxLatenessMs = 100, startupObservation = false }) {
  const failures = [];
  const check = (name, valid, observed) => { if (!valid) failures.push({ name, observed }); };
  for (const [name, row, expected] of [["start", start, expectedStart], ["end", end, expectedEnd]]) {
    check(`${name}.present`, !!row, row ?? null);
    if (!row) continue;
    check(`${name}.boundMs`, row.boundMs === expected.boundMs, row.boundMs);
    check(`${name}.pageTime`, Number.isFinite(row.atMs) && Number.isFinite(row.timeOrigin) &&
      row.atEpochMs === row.timeOrigin + row.atMs, row.atEpochMs);
    check(`${name}.latenessMs`, Number.isFinite(row.markerWallMinusBoundaryMs) &&
      row.markerWallMinusBoundaryMs >= 0 && row.markerWallMinusBoundaryMs <= maxLatenessMs,
    row.markerWallMinusBoundaryMs);
    check(`${name}.delivery`, row.delivery?.count === expected.count && row.delivery?.hash === expected.hash,
      row.delivery ?? null);
    const resourcesHealthy = Number.isInteger(row.renderer?.resources?.pending) &&
      row.renderer.resources.pending >= 0 && row.renderer.resources.failed === 0 &&
      !row.renderer.failure && [0, 1].includes(row.renderer.lifecycle?.contextReady);
    check(`${name}.ready`, startupObservation ? resourcesHealthy :
      row.renderer?.ready === true && row.renderer?.readiness === "ready" &&
      row.renderer?.resources?.pending === 0 && row.renderer?.resources?.failed === 0 &&
      !row.renderer?.failure && row.renderer?.lifecycle?.contextReady === 1 &&
      row.renderer?.lifecycle?.presentationValid === 1, row.renderer ?? null);
    if (name === "start" && !startupObservation) check("start.firstReadyAtMs", Number.isFinite(row.firstReadyAtMs) &&
      row.firstReadyAtMs > 0 && row.firstReadyAtMs <= row.atMs, row.firstReadyAtMs);
    check(`${name}.freshAutoOff`, row.freshDefaults?.cleared === true && row.savedSettings === null &&
      row.quality?.choice === "auto" && !!row.quality?.tier &&
      row.quality.tier === row.renderer?.effective?.quality &&
      row.renderer?.backend === "rust" && row.renderer?.effective?.shaders === "off" &&
      row.renderer?.effective?.particles === "off", row.renderer?.effective ?? null);
    check(`${name}.visibleLandscape`, row.visibility?.state === "visible" &&
      row.visibility?.hidden === false && row.viewport?.width > row.viewport?.height &&
      row.viewport?.dpr > 0, { visibility: row.visibility, viewport: row.viewport });
    check(`${name}.context`, row.contextEvents?.losses === 0 &&
      row.contextEvents?.creationErrors === 0, row.contextEvents ?? null);
  }
  if (start && end) {
    check("documentIdentity", start.documentNonce && start.documentNonce === end.documentNonce &&
      start.timeOrigin === end.timeOrigin && start.url === end.url &&
      start.renderer?.instance === end.renderer?.instance,
    { start: { documentNonce: start.documentNonce, timeOrigin: start.timeOrigin, url: start.url,
      instance: start.renderer?.instance }, end: { documentNonce: end.documentNonce,
      timeOrigin: end.timeOrigin, url: end.url, instance: end.renderer?.instance } });
    const comparableEffective = (row) => {
      const value = { ...row?.renderer?.effective };
      if (startupObservation) delete value.rustZeroCopyPixels;
      return value;
    };
    check("settingsViewportStable", JSON.stringify(start.quality) === JSON.stringify(end.quality) &&
      JSON.stringify(comparableEffective(start)) === JSON.stringify(comparableEffective(end)) &&
      JSON.stringify(start.viewport) === JSON.stringify(end.viewport),
    { start: { quality: start.quality, effective: start.renderer?.effective, viewport: start.viewport },
      end: { quality: end.quality, effective: end.renderer?.effective, viewport: end.viewport } });
    if (startupObservation) {
      const expectedCopy = new URL(start.url).searchParams.get("rustZeroCopyPixels") === "1";
      check("copyControl", end.renderer?.effective?.rustZeroCopyPixels === expectedCopy &&
        (start.renderer?.effective?.rustZeroCopyPixels === null ||
         start.renderer?.effective?.rustZeroCopyPixels === expectedCopy),
      { start: start.renderer?.effective?.rustZeroCopyPixels, end: end.renderer?.effective?.rustZeroCopyPixels,
        expected: expectedCopy });
    }
  }
  return { accepted: failures.length === 0, failures, maxLatenessMs, start, end };
}
