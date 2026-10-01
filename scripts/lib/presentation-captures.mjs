import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function presentationSnapshotInPage() {
  const renderer = typeof window.__mirrorRendererDiagnostics === "function" ? window.__mirrorRendererDiagnostics() : null;
  const canvas = document.querySelector("canvas.mirror-canvas-stage, .mirror-canvas-host canvas");
  return {
    wallEpochMs: Date.now(), pageNowMs: performance.now(), pageTimeOriginMs: performance.timeOrigin,
    requestedStage: new URL(location.href).searchParams.get("stage") ?? "dom",
    actualStage: renderer?.backend ?? (document.querySelector(".mirror-node") ? "dom" : null),
    visibility: { state: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() },
    viewport: {
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      visualWidth: window.visualViewport?.width ?? null, visualHeight: window.visualViewport?.height ?? null,
      visualScale: window.visualViewport?.scale ?? null,
      orientation: screen.orientation?.type ?? null, orientationAngle: screen.orientation?.angle ?? null,
    },
    renderer: renderer && {
      backend: renderer.backend ?? null, readiness: renderer.readiness ?? null,
      failure: renderer.failure ?? null, frameIdentity: renderer.frameIdentity ?? null,
      resources: renderer.resources ?? null,
      draw: { frames: renderer.draw?.frames ?? null, completedFrames: renderer.draw?.completedFrames ?? null },
      lifecycle: renderer.lifecycle ?? null,
      effective: renderer.effective ?? null,
    },
    stageCanvas: canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight, className: canvas.className } : null,
    contextEvents: typeof window.__mirrorGlContextEvents === "function" ? window.__mirrorGlContextEvents() : null,
    replay: { done: window.__benchDone === true, wsError: window.__benchWsError ?? null,
      messageIndex: window.__benchWs?._i ?? null },
  };
}

export async function capturePresentationSequence(page, { prefix, count = 3, gapMs = 1000, metadata = {} }) {
  if (!prefix || !Number.isInteger(count) || count < 2 || count > 10 ||
      !Number.isInteger(gapMs) || gapMs < 0 || gapMs > 10_000) throw new Error("invalid presentation capture request");
  const receipt = { schema: "mirror-presentation-captures/1", source: "CDP page.screenshot; stage pixels may be absent without preserveDrawingBuffer",
    metadata, captures: [] };
  mkdirSync(dirname(prefix), { recursive: true });
  for (let i = 0; i < count; i++) {
    if (i > 0) await page.waitForTimeout(gapMs);
    const before = await page.evaluate(presentationSnapshotInPage);
    const screenshot = `${prefix}-${String(i + 1).padStart(2, "0")}.png`;
    const screenshotStartedEpochMs = Date.now();
    await page.screenshot({ path: screenshot, fullPage: false });
    const screenshotEndedEpochMs = Date.now();
    const after = await page.evaluate(presentationSnapshotInPage);
    const bytes = readFileSync(screenshot);
    receipt.captures.push({ index: i + 1, screenshot, screenshotSha256: createHash("sha256").update(bytes).digest("hex"),
      screenshotBytes: bytes.length, screenshotStartedEpochMs, screenshotEndedEpochMs, before, after });
    writeFileSync(`${prefix}.json`, JSON.stringify(receipt, null, 2) + "\n");
  }
  return receipt;
}
