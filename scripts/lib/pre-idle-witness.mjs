import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function installWitnessDocumentNonce() {
  window.__benchDocumentNonce = crypto.randomUUID();
}

export async function snapshotPreIdleWitnessInPage() {
  const [qualityModule, settingsModule] = await Promise.all([
    import("/src/render/quality.ts"), import("/src/mirror/mirrorSettings.ts"),
  ]);
  const quality = qualityModule.renderQuality();
  const settings = settingsModule.mirrorSettings;
  const renderer = window.__mirrorRendererDiagnostics?.() ?? null;
  const effective = renderer?.effective ?? null;
  return {
    documentNonce: window.__benchDocumentNonce ?? null,
    timeOrigin: performance.timeOrigin,
    url: location.href,
    visibility: { state: document.visibilityState, hidden: document.hidden },
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    renderer: renderer && {
      backend: renderer.backend ?? null, instance: renderer.instance?.id ?? renderer.instance ?? null,
      revision: renderer.frameIdentity?.revision ?? renderer.admittedRevision ?? null,
      readiness: renderer.readiness ?? null, ready: renderer.ready === true,
      resources: renderer.resources ?? null, failure: renderer.failure ?? null,
      effective: effective && { quality: effective.quality ?? null, shaders: effective.shaders ?? null,
        particles: effective.particles ?? null, staticBg: effective.staticBg ?? null,
        spineMode: effective.spineMode ?? null, backingWidth: effective.backingWidth ?? null,
        backingHeight: effective.backingHeight ?? null, dpr: effective.dpr ?? null,
        rustZeroCopyPixels: effective.rustZeroCopyPixels ?? null },
      lifecycle: renderer.lifecycle ?? null,
    },
    contextEvents: window.__mirrorGlContextEvents?.() ?? null,
    quality: { choice: settings.quality, tier: quality.tier, source: quality.source },
    savedSettings: localStorage.getItem("couchcoop.mirrorSettings.v1"),
    freshDefaults: window.__benchFreshDefaults ?? null,
  };
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  renameSync(temp, path);
}

export function requireReadyWitnessState(state, requireFreshDefaults) {
  if (!state?.documentNonce || !Number.isFinite(state.timeOrigin) || state.timeOrigin <= 0 ||
      !state?.url || state.visibility?.state !== "visible" || state.visibility?.hidden ||
      !(state.viewport?.width > state.viewport?.height) || !(state.viewport?.dpr > 0) ||
      !state.renderer?.instance || !Number.isInteger(state.renderer.revision) ||
      state.renderer.readiness !== "ready" || state.renderer.ready !== true || state.renderer.failure ||
      state.renderer.resources?.pending !== 0 || state.renderer.resources?.failed !== 0 ||
      state.renderer.lifecycle?.contextReady !== 1 || state.renderer.lifecycle?.presentationValid !== 1 ||
      !state.contextEvents || state.contextEvents.losses !== 0 || state.contextEvents.creationErrors !== 0) {
    throw new Error("pre-idle witness page is not ready");
  }
  if (requireFreshDefaults) {
    const params = new URL(state.url).searchParams;
    const requestedStage = params.get("stage");
    if (params.has("quality") || state.savedSettings !== null ||
        state.freshDefaults?.cleared !== true || state.quality?.choice !== "auto" ||
        !["auto", "default"].includes(state.quality?.source) ||
        state.quality?.tier !== state.renderer.effective?.quality ||
        !["rust", "canvas"].includes(requestedStage) || state.renderer.backend !== requestedStage ||
        state.renderer.effective?.shaders !== "off" || state.renderer.effective?.particles !== "off") {
      throw new Error("pre-idle witness page is not fresh Auto with effects Off");
    }
  }
}

export function stableWitnessState(state) {
  return JSON.stringify({ documentNonce: state.documentNonce, timeOrigin: state.timeOrigin,
    url: state.url, visibility: state.visibility,
    viewport: state.viewport, renderer: state.renderer, contextEvents: state.contextEvents,
    quality: state.quality, savedSettings: state.savedSettings, freshDefaults: state.freshDefaults });
}

export async function runPreIdleWitness({ prefix, browser, capture, targetId, timeoutMs = 30_000,
  requireFreshDefaults = false, signal, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!prefix || !browser?.packageName || !Number.isSafeInteger(browser.pid) || browser.pid <= 0 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("invalid pre-idle witness options");
  const requestPath = `${prefix}.request.json`, ackPath = `${prefix}.ack.json`, verifiedPath = `${prefix}.verified.json`;
  const requireAlive = () => { if (signal?.aborted) throw new Error("pre-idle witness page navigated or closed while waiting"); };
  requireAlive();
  if ([requestPath, ackPath, verifiedPath].some(existsSync)) throw new Error("pre-idle witness files already exist");
  const before = await capture();
  requireAlive();
  requireReadyWitnessState(before, requireFreshDefaults);
  const selectedTargetId = await targetId();
  requireAlive();
  if (typeof selectedTargetId !== "string" || !selectedTargetId) throw new Error("pre-idle witness has no CDP target ID");
  const request = { schema: "mirror-pre-idle-witness/1", token: randomUUID(), documentNonce: before.documentNonce,
    targetId: selectedTargetId, browser, url: before.url, renderer: before.renderer,
    visibility: before.visibility, viewport: before.viewport, contextEvents: before.contextEvents,
    quality: before.quality, savedSettings: before.savedSettings, freshDefaults: before.freshDefaults,
    createdEpochMs: now() };
  writeAtomic(requestPath, request);
  const deadline = now() + timeoutMs;
  let ack;
  while (!existsSync(ackPath)) {
    requireAlive();
    if (now() >= deadline) throw new Error("pre-idle witness ack timeout");
    await sleep(50);
  }
  requireAlive();
  try { ack = JSON.parse(readFileSync(ackPath, "utf8")); }
  catch { throw new Error("pre-idle witness ack is malformed"); }
  if (ack.schema !== "mirror-pre-idle-witness-ack/1" || ack.token !== request.token ||
      ack.documentNonce !== request.documentNonce || ack.targetId !== request.targetId ||
      ack.browser?.packageName !== browser.packageName || ack.browser?.pid !== browser.pid ||
      ack.browserVerified !== true || ack.captureOk !== true || !Array.isArray(ack.captures) || ack.captures.length < 1) {
    throw new Error("pre-idle witness ack identity/capture mismatch");
  }
  const after = await capture();
  requireAlive();
  requireReadyWitnessState(after, requireFreshDefaults);
  if (await targetId() !== request.targetId || stableWitnessState(before) !== stableWitnessState(after)) {
    throw new Error("pre-idle witness page changed before marker");
  }
  const verified = { schema: "mirror-pre-idle-witness-verified/1", request, ack, before, after, verifiedEpochMs: now() };
  writeAtomic(verifiedPath, verified);
  return verified;
}
