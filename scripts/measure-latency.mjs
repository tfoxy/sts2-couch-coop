#!/usr/bin/env node
// Real-input response bench against an OWNED, already prepared combat hand.
// COUCHCOOP_VALIDATE_URL=http://... node scripts/measure-latency.mjs --out <artifact-dir>
// Or --cdp <url> to use an already joined owned browser page (instrumentation requires a reload).
// Take the game/browser live-QA leases first. This script does not create a fixture or deploy.
//
// A sample needs: real pointer event -> exactly one input request -> the target holder's authoritative
// focus upsert -> renderer reports that holder focused -> its unique witness appears in a CDP frame.
// A benchmark-only barcode is painted at the backend's response pre-paint boundary. Chrome's animation-frame
// trace identifies that frame's compositor presentation. A later barcode PNG corroborates visible persistence;
// Chrome 147's screencast timestamp is a video-consumer clock, not the presentation time.
// No ping, unrelated animation, next mutation, rAF timestamp, or timeout can substitute for that chain.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import path from "node:path";
import {
  POINTER_TRACE_PREFIX,
  RESPONSE_TRACE_PREFIX,
  markerWord,
  percentiles,
  qualifyCausalChain,
  qualifySample,
  responseMatches,
  selectCdpPage,
} from "./lib/input-response-latency.mjs";
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const out = option("--out", null);
if (!out) throw new Error("--out <artifact-dir> is required");
const count = Number(option("--samples", "40"));
const idleMs = Number(option("--idle-ms", "1500"));
if (!Number.isInteger(count) || count < 1 || count > 65535 || !Number.isFinite(idleMs) || idleMs < 0)
  throw new Error("invalid sample count or idle duration");
const url = process.env.COUCHCOOP_VALIDATE_URL ?? "http://127.0.0.1:5173/";
const cdpUrl = option("--cdp", null);
const matchUrlPrefix = option("--match-url-prefix", url);
if ((args.includes("--match-url-prefix") && !cdpUrl) || !url.startsWith(matchUrlPrefix))
  throw new Error("--match-url-prefix requires --cdp and must prefix COUCHCOOP_VALIDATE_URL");
const freshPage = args.includes("--fresh-page");
if (freshPage && !cdpUrl) throw new Error("--fresh-page requires --cdp");
const viewportOption = option("--viewport", null);
const viewportMatch = viewportOption?.match(/^(\d+)x(\d+)$/);
if (viewportOption && (!freshPage || !viewportMatch))
  throw new Error("--viewport WIDTHxHEIGHT requires --fresh-page");
const freshViewport = viewportMatch ? { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) } : null;
if (freshViewport && (freshViewport.width < 320 || freshViewport.height < 320 ||
    freshViewport.width > 4096 || freshViewport.height > 4096))
  throw new Error("fresh-page viewport is outside supported bounds");
const pageIndexOption = option("--page-index", null);
const pageIndex = pageIndexOption === null ? null : Number(pageIndexOption);
if (pageIndex !== null && (!Number.isInteger(pageIndex) || pageIndex < 0 || !cdpUrl))
  throw new Error("--page-index requires --cdp and a nonnegative integer");
const expectedPages = Number(option("--expected-pages", "1"));
const companionHoverHz = Number(option("--companion-hover-hz", "0"));
const firstReturn = args.includes("--first-return");
const FIRST_RETURN_READY_TO_INPUT_LIMIT_MS = 100;
const disconnectMs = Number(option("--disconnect-ms", "1500"));
if (!Number.isInteger(expectedPages) || expectedPages < 1 || !Number.isFinite(companionHoverHz) ||
    companionHoverHz < 0 || companionHoverHz > 60 ||
    (companionHoverHz > 0 && (!cdpUrl || expectedPages < 2)))
  throw new Error("companion hover requires --cdp, --expected-pages >= 2, and 0 < Hz <= 60");
if (firstReturn && (!cdpUrl || count !== 1 || expectedPages !== 1 || companionHoverHz !== 0 ||
    !Number.isFinite(disconnectMs) || disconnectMs < 1000))
  throw new Error("--first-return requires one CDP page, one sample, no companions, and >=1000ms disconnected");
const synthetic = args.includes("--synthetic-fixture");
const syntheticAckDelayMs = Number(option("--synthetic-ack-delay-ms", "0"));
const syntheticOmitFirstAcks = Number(option("--synthetic-omit-first-acks", "0"));
if (!Number.isFinite(syntheticAckDelayMs) || syntheticAckDelayMs < 0 || syntheticAckDelayMs > 1000 ||
    !Number.isInteger(syntheticOmitFirstAcks) || syntheticOmitFirstAcks < 0 || syntheticOmitFirstAcks > 3 ||
    ((syntheticAckDelayMs > 0 || syntheticOmitFirstAcks > 0) && !synthetic))
  throw new Error("synthetic ACK perturbation requires a synthetic fixture, delay 0..1000ms, omission 0..3");
const instance = option("--instance", null);
if (!synthetic) {
  if (!instance || instance === "default") throw new Error("--instance must name an owned QA instance");
  const owner = process.env.COUCHCOOP_LIVEQA_OWNER, pid = process.env.COUCHCOOP_LIVEQA_PID;
  if (!owner || !pid) throw new Error("take the live-QA leases before measuring real input");
  const resources = ["shared:install", `exclusive:game:${instance}`];
  if (cdpUrl) resources.push(`exclusive:browser:${new URL(cdpUrl).port}`);
  execFileSync(process.execPath, [new URL("./live-qa-lock.mjs", import.meta.url).pathname,
    "assert", "--owner", owner, "--pid", pid, ...resources.flatMap(r => ["--resource", r])]);
}
await mkdir(out, { recursive: true });
const browser = cdpUrl ? await chromium.connectOverCDP(cdpUrl) : await chromium.launch();
const browserVersion = browser.version();
if (browserVersion !== "147.0.7727.15")
  throw new Error(`schema 3 clock/frame source audit covers Chrome 147.0.7727.15, found ${browserVersion}`);
const matchingPages = cdpUrl ? browser.contexts().flatMap(context => context.pages()
  .filter(page => page.url().startsWith(matchUrlPrefix))) : [];
if (cdpUrl && matchingPages.length !== expectedPages)
  throw new Error(`expected ${expectedPages} matching joined pages, found ${matchingPages.length}`);
let selected = null;
if (cdpUrl) {
  if (matchUrlPrefix === url) {
    selected = selectCdpPage(browser.contexts(), url, pageIndex);
  } else {
    if (pageIndex !== null) throw new Error("--page-index is ambiguous with --match-url-prefix; exact seat URL selects the page");
    const exact = browser.contexts().flatMap(context => context.pages()
      .filter(page => page.url() === url).map(page => ({ context, page })));
    if (exact.length !== 1) throw new Error(`expected one page at the exact seat URL, found ${exact.length}`);
    selected = exact[0];
  }
}
if (selected && selected.page.url() !== url)
  throw new Error(`selected page URL differs from exact seat reload URL: ${selected.page.url()}`);
const selectedPageIndex = selected ? matchingPages.indexOf(selected.page) : null;
const context = selected?.context ?? await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
let page = selected?.page ?? await context.newPage();
if (freshPage) {
  const selectedIndex = matchingPages.indexOf(page);
  const previousViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.close(); // page-scoped init scripts from previous attempts must not survive a retry
  page = await context.newPage();
  await page.setViewportSize(freshViewport ?? previousViewport);
  matchingPages[selectedIndex] = page;
}
const frames = new Map();
const frameDecoder = new Worker(new URL("./lib/latency-frame-decoder-worker.mjs", import.meta.url));
const decoderStats = { submitted: 0, decoded: 0, matched: 0, replacedPending: 0,
  skippedUnarmed: 0, discardedPending: 0, errors: 0, maxQueueDepth: 0 };
let captureTargetId = null;
let activeDecodeFrame = null;
let pendingDecodeFrame = null;
const submitDecode = frame => {
  activeDecodeFrame = frame;
  decoderStats.submitted++;
  decoderStats.maxQueueDepth = Math.max(decoderStats.maxQueueDepth, 1);
  frameDecoder.postMessage({ data: frame.data, targetId: frame.targetId });
};
frameDecoder.on("message", result => {
  const completed = activeDecodeFrame;
  activeDecodeFrame = null;
  decoderStats.decoded++;
  if (result.error) {
    decoderStats.errors++;
    failure ??= `PNG decoder: ${result.error}`;
  } else if (completed && result.matched && result.targetId === completed.targetId &&
      captureTargetId === completed.targetId && !frames.has(completed.targetId)) {
    frames.set(completed.targetId, { id: completed.targetId, timestampMs: completed.timestampMs,
      png: Buffer.from(completed.data, "base64") });
    decoderStats.matched++;
    captureTargetId = null;
    if (pendingDecodeFrame) decoderStats.discardedPending++;
    pendingDecodeFrame = null;
  }
  if (captureTargetId !== null && pendingDecodeFrame) {
    const next = pendingDecodeFrame;
    pendingDecodeFrame = null;
    submitDecode(next);
  }
});
frameDecoder.on("error", error => { decoderStats.errors++; failure ??= `PNG decoder worker: ${error}`; });
const samples = [];
const targetSelections = [];
const traceEvents = [];
let failure = null;
let screencastFrames = 0;
let preInputScreencastFrames = 0;
let captureSamples = false;
let geometryBefore = null;
let geometryAfter = null;
let preSampleInputs = null;
let returnLifecycle = null;
let cdp;
let traceStarted = false;
let companionRunning = false;
let companionLoop = null;
const companionStats = [];
let traceCompleteResolve;
const traceComplete = new Promise(resolve => { traceCompleteResolve = resolve; });
try {
  cdp = await context.newCDPSession(page);
  await cdp.send("Page.enable");
  cdp.on("Tracing.dataCollected", event => {
    for (const row of event.value ?? []) {
      const message = row.args?.data?.message ?? row.args?.data?.name ?? "";
      if (row.name === "AnimationFrame" || row.name === "AnimationFrame::Presentation" ||
          (row.name === "TimeStamp" && (message.startsWith(POINTER_TRACE_PREFIX) || message.startsWith(RESPONSE_TRACE_PREFIX)))) {
        traceEvents.push(row);
      }
    }
  });
  cdp.on("Tracing.tracingComplete", () => traceCompleteResolve());
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline.frame",
    options: "record-as-much-as-possible",
    transferMode: "ReportEvents",
  });
  traceStarted = true;

  const installWitness = (matches, word, pointerPrefix, responsePrefix) => {
    const clock = () => performance.timeOrigin + performance.now();
    const socketIdentity = new WeakMap();
    const bench = window.__responseBench = { current: null, streamOpenAt: null,
      firstFullSceneAt: null, firstFullScene: null, nextSocketId: 0,
      lastSeatInputAt: null,
      preSampleInputCount: 0, preSampleInputs: [],
      clockResolutionMs: crossOriginIsolated ? .005 : .1 };
    bench.pickTarget = () => {
      const stage = document.querySelector(".mirror-stage");
      if (!stage) {
        bench.lastPickState = { at: clock(), reason: "stage missing" };
        return null;
      }
      const box = stage.getBoundingClientRect();
      const scale = box.width / stage.offsetWidth;
      const hand = window.__mirrorHandPoses?.().holders.filter(h => h.inFan) ?? [];
      const holders = hand.filter(h => h.zIndex !== 1 && !h.channelLive);
      const priorFocusedIds = hand.filter(h => h.zIndex === 1).map(h => h.id);
      const rects = window.__mirrorInteractiveRects?.() ?? [];
      const state = { at: clock(), handCount: hand.length, focusedCount: priorFocusedIds.length,
        unsettledCount: hand.filter(h => h.zIndex !== 1 && h.channelLive).length,
        eligibleCount: holders.length, rectCount: rects.length, matchedRectCount: 0,
        onstageCount: 0, stageWidth: stage.offsetWidth, stageHeight: stage.offsetHeight };
      // Use an upper-centre point to avoid neighbouring cards overlapping the bottom of the fan.
      for (const holder of holders.slice().sort((a, b) => a.mDrawn[4] - b.mDrawn[4])) {
        const rect = rects.find(r => r.id === holder.hitboxId);
        if (!rect) continue;
        state.matchedRectCount++;
        const m = rect.transform, r = rect.localRect;
        const lx = r.x + r.width / 2, ly = r.y + r.height * .25;
        const gx = m[0] * lx + m[2] * ly + m[4] + rect.spreadDx;
        const gy = m[1] * lx + m[3] * ly + m[5] + rect.raiseDy;
        if (gx < 2 || gy < 2 || gx > stage.offsetWidth - 2 || gy > stage.offsetHeight - 2) continue;
        state.onstageCount++;
        bench.lastPickState = state;
        return { targetId: holder.id, contentKey: holder.cardContentKey, priorFocusedIds,
          targetBeforeZIndex: holder.zIndex, targetBeforeChannelLive: holder.channelLive,
          x: box.left + gx * scale, y: box.top + gy * scale };
      }
      bench.lastPickState = state;
      return null;
    };
    // Allocate the witness layer before the first scene frame. A layer created in the first response
    // callback can miss that response's presentation while a later screencast frame carries its pixels.
    const marker = document.createElement("canvas");
    marker.width = 128; marker.height = 8;
    marker.style.cssText = "position:fixed;left:0;top:0;width:128px;height:8px;z-index:2147483647;pointer-events:none";
    const markerContext = marker.getContext("2d");
    markerContext.fillStyle = "black";
    markerContext.fillRect(0, 0, marker.width, marker.height); // invalid id 0, but its layer/raster exists
    if (document.documentElement) document.documentElement.append(marker);
    else document.addEventListener("DOMContentLoaded", () => document.documentElement.append(marker), { once: true });
    function paintWitness(source) {
      const sample = bench.current;
      if (!sample?.responseAt || sample.drawnAt) return false;
      const report = window.__mirrorHandPoses?.();
      const holder = report?.holders.find(h => h.id === sample.targetId);
      if (!holder?.inFan || holder.zIndex !== 1) return false;
      sample.drawnAt = clock();
      sample.drawnPose = [...holder.mDrawn];
      sample.stage = report.stage;
      sample.witnessSource = source;
      const bits = word(sample.id);
      for (let bit = 0; bit < 32; bit++) {
        markerContext.fillStyle = (bits >>> (31 - bit)) & 1 ? "white" : "black";
        markerContext.fillRect(bit * 4, 0, 4, 8);
      }
      sample.responseMarkBeforeMs = clock();
      console.timeStamp(`${responsePrefix}${sample.id}`);
      sample.responseMarkAfterMs = clock();
      return true;
    }

    new MutationObserver(records => {
      const sample = bench.current;
      if (!sample || sample.drawnAt) return;
      for (const record of records) {
        const target = record.target;
        if (target instanceof HTMLElement && target.dataset.nodeId === sample.targetId && target.style.zIndex === "1") {
          paintWitness("dom-style-mutation");
          return;
        }
      }
    }).observe(document, { attributes: true, attributeFilter: ["style"], subtree: true });

    const gl2 = globalThis.WebGL2RenderingContext?.prototype;
    for (const method of ["drawArraysInstanced", "drawElements"]) {
      const native = gl2?.[method];
      if (typeof native !== "function") continue;
      gl2[method] = function(...args) {
        if (this.canvas?.classList?.contains("mirror-canvas-stage")) paintWitness("canvas-webgl-submit");
        return native.apply(this, args);
      };
    }
    const nativeSocket = window.WebSocket;
    window.WebSocket = class extends nativeSocket {
      constructor(...args) {
        super(...args);
        const socketId = ++bench.nextSocketId;
        const socketUrl = new URL(String(args[0]), location.href).href;
        const isWatchedStream = new URL(socketUrl).searchParams.get("watch") === "1";
        socketIdentity.set(this, { socketId, socketUrl, isWatchedStream });
        this.addEventListener("open", () => {
          if (isWatchedStream && !bench.streamOpenAt) {
            bench.streamOpenAt = clock();
            bench.streamSocketId = socketId;
            bench.streamSocketUrl = socketUrl;
          }
        });
        this.addEventListener("message", event => {
          const sample = bench.current;
          if ((!sample?.sentAt || sample.responseAt) && bench.firstFullSceneAt) return;
          if (typeof event.data !== "string") return;
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (isWatchedStream && message?.type === "scene-delta" && message.full === true &&
              !bench.firstFullSceneAt) {
            bench.firstFullSceneAt = clock();
            bench.firstFullScene = { socketId, socketUrl,
              screenInstanceId: message.screenInstanceId ?? null,
              screenType: message.screenType ?? null,
              revision: message.revision ?? null, sequence: message.sequence ?? null,
              upserts: message.upserts?.length ?? null,
              orderedIds: message.orderedIds?.length ?? null };
          }
          if (sample?.sentAt && !sample.responseAt && sample.inputSocketId === socketId &&
              matches(message, sample.targetId)) {
            sample.responseAt = clock();
            sample.responseNode = message.upserts.find(n => n.id === sample.targetId);
            sample.responseSocketId = socketId;
            sample.responseSocketUrl = socketUrl;
          }
        });
      }
      send(data) {
        const sample = bench.current;
        const { socketId, socketUrl, isWatchedStream } = socketIdentity.get(this);
        if (typeof data === "string") {
          let message;
          try { message = JSON.parse(data); } catch { /* not JSON */ }
          if (message?.type === "input") {
            const sentAt = clock();
            if (isWatchedStream) bench.lastSeatInputAt = sentAt;
            if (!sample?.pointerAt) {
              bench.preSampleInputCount++;
              bench.preSampleInputs.push({ requestId: message.requestId ?? null,
                kind: message.kind ?? null, socketId, socketUrl, at: sentAt });
            } else {
              sample.inputCount++;
              if (message.kind === "hover" && !sample.sentAt) {
                sample.sentAt = sentAt;
                sample.requestId = message.requestId;
                sample.input = message;
                sample.inputSocketId = socketId;
                sample.inputSocketUrl = socketUrl;
              }
            }
          }
        }
        return super.send(data);
      }
    };
    window.addEventListener("pointermove", event => {
      const sample = bench.current;
      if (sample && !sample.pointerAt && event.isTrusted) {
        sample.pointerEventTimestampMs = event.timeStamp;
        sample.pointerEventTimeOriginMs = performance.timeOrigin;
        sample.clockResolutionMs = bench.clockResolutionMs;
        sample.previousSeatInputAt = bench.lastSeatInputAt;
        sample.pointerAt = performance.timeOrigin + event.timeStamp;
        sample.pointerHandlerAt = clock();
        sample.pointerMarkBeforeMs = clock();
        console.timeStamp(`${pointerPrefix}${sample.id}`);
        sample.pointerMarkAfterMs = clock();
      }
    }, true);
  };
  await page.addInitScript({ content: `(${installWitness.toString()})(${responseMatches.toString()}, ${markerWord.toString()}, ${JSON.stringify(POINTER_TRACE_PREFIX)}, ${JSON.stringify(RESPONSE_TRACE_PREFIX)})` });
  cdp.on("Page.screencastFrame", event => {
    // Ack immediately; decoding and disk I/O must not stall admission of the next frame.
    const ack = () => void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    screencastFrames++;
    if (screencastFrames > syntheticOmitFirstAcks) {
      if (syntheticAckDelayMs) setTimeout(ack, syntheticAckDelayMs);
      else ack();
    }
    if (!captureSamples || captureTargetId === null) { decoderStats.skippedUnarmed++; return; }
    const next = { targetId: captureTargetId, timestampMs: event.metadata.timestamp * 1000,
      data: event.data };
    if (!activeDecodeFrame) submitDecode(next);
    else {
      if (pendingDecodeFrame) decoderStats.replacedPending++;
      pendingDecodeFrame = next;
      decoderStats.maxQueueDepth = Math.max(decoderStats.maxQueueDepth, 2);
    }
  });
  // Start recording before reload and wait for post-ready frames so sample 1 cannot be a cold
  // screencast admission. The barcode map stays disarmed until the new document is ready.
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  if (firstReturn) {
    if (freshPage) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__mirrorHandPoses?.().holders.some(h => h.inFan), null, { timeout: 120000 });
    }
    // Park the cursor outside the stage, then close the viewer socket. No reset hover is sent
    // after return: the next pointer event is the first controlled input of the new subscription.
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(out, "before-return.png") });
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    const disconnectedAtMs = Date.now();
    await new Promise(resolve => setTimeout(resolve, disconnectMs));
    returnLifecycle = { disconnectedAtMs, disconnectMs, returnNavigationAtMs: Date.now() };
  }
  await page.goto(url, { waitUntil: "domcontentloaded" });
  let firstReturnPreparedTarget = null;
  if (firstReturn) {
    // Arm the exact target in the same browser task that first observes the returned hand.
    // A separate waitForFunction followed by evaluate adds a CDP roundtrip after readiness.
    const prepared = await page.evaluate(async () => {
      const start = performance.now();
      while (!window.__mirrorHandPoses?.().holders.some(h => h.inFan)) {
        if (performance.now() - start > 120000) throw new Error("returned combat hand did not become ready");
        await new Promise(resolve => {
          const timeout = setTimeout(resolve, 100);
          requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
        });
      }
      const bench = window.__responseBench;
      bench.handReadyAt ??= performance.timeOrigin + performance.now();
      const target = bench.pickTarget();
      if (target) bench.current = { ...target, id: 1, idleMs: 0, firstReturn: true, inputCount: 0 };
      bench.preparedAt = performance.timeOrigin + performance.now();
      return { target, stream: {
        streamOpenAt: bench.streamOpenAt ?? null,
        streamSocketId: bench.streamSocketId ?? null,
        streamSocketUrl: bench.streamSocketUrl ?? null,
        firstFullSceneAt: bench.firstFullSceneAt ?? null,
        firstFullScene: bench.firstFullScene ?? null,
        preSampleInputCount: bench.preSampleInputCount,
        preSampleInputs: bench.preSampleInputs,
        handReadyAt: bench.handReadyAt ?? null,
        preparedAt: bench.preparedAt,
      }, geometry: {
        innerWidth, innerHeight, devicePixelRatio, visibilityState: document.visibilityState,
        crossOriginIsolated, clockResolutionMs: bench.clockResolutionMs,
        visualViewport: window.visualViewport ? {
          width: window.visualViewport.width, height: window.visualViewport.height,
          scale: window.visualViewport.scale, offsetLeft: window.visualViewport.offsetLeft,
          offsetTop: window.visualViewport.offsetTop,
        } : null,
        stage: window.__mirrorHandPoses?.().stage ?? null,
      } };
    });
    firstReturnPreparedTarget = prepared.target;
    geometryBefore = prepared.geometry;
    returnLifecycle.stream = prepared.stream;
    returnLifecycle.returnNavigationToStreamOpenMs = prepared.stream.streamOpenAt -
      returnLifecycle.returnNavigationAtMs;
    if (!Number.isFinite(returnLifecycle.stream.streamOpenAt) ||
        !Number.isFinite(returnLifecycle.stream.firstFullSceneAt) ||
        returnLifecycle.stream.streamOpenAt > returnLifecycle.stream.firstFullSceneAt ||
        returnLifecycle.stream.firstFullSceneAt > returnLifecycle.stream.handReadyAt ||
        returnLifecycle.stream.streamSocketId !== returnLifecycle.stream.firstFullScene?.socketId ||
        returnLifecycle.stream.preSampleInputCount !== 0)
      throw new Error("return stream open/full-keyframe/hand-ready chain is missing or out of order");
  } else {
    await page.waitForFunction(() => {
      if (!window.__mirrorHandPoses?.().holders.some(h => h.inFan)) return false;
      window.__responseBench.handReadyAt ??= performance.timeOrigin + performance.now();
      return true;
    }, null, { timeout: 120000 });
  }
  const pageGeometry = () => ({
    innerWidth, innerHeight, devicePixelRatio, visibilityState: document.visibilityState,
    crossOriginIsolated, clockResolutionMs: window.__responseBench?.clockResolutionMs ?? null,
    visualViewport: window.visualViewport ? {
      width: window.visualViewport.width, height: window.visualViewport.height,
      scale: window.visualViewport.scale, offsetLeft: window.visualViewport.offsetLeft,
      offsetTop: window.visualViewport.offsetTop,
    } : null,
    stage: window.__mirrorHandPoses?.().stage ?? null,
  });
  if (!firstReturn) geometryBefore = await page.evaluate(pageGeometry);
  if (geometryBefore.devicePixelRatio !== 1)
    throw new Error("the witness decoder requires deviceScaleFactor=1; scaled captures are not comparable");
  const framesAtReady = screencastFrames;
  if (!firstReturn) {
    await page.screenshot({ path: path.join(out, "before.png") });
    const admissionDeadline = Date.now() + 5000;
    while (screencastFrames - framesAtReady < 2 && Date.now() < admissionDeadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    preInputScreencastFrames = screencastFrames - framesAtReady;
    if (preInputScreencastFrames < 2) throw new Error("screencast did not deliver two post-ready frames before input");
  } else {
    preInputScreencastFrames = 0; // no after-ready recorder gate on the first return input
  }
  frames.clear();
  captureSamples = true;
  if (companionHoverHz > 0) {
    const activitySnapshot = () => {
      const stage = window.__mirrorHandPoses?.().stage ?? null;
      const walks = window.__mirrorWalkStats?.walks;
      const canvasFrames = window.__mirrorCanvasStats?.().frames;
      return { visibilityState: document.visibilityState, stage,
        walks: Number.isFinite(walks) ? walks : null,
        canvasFrames: Number.isFinite(canvasFrames) ? canvasFrames : null,
        renderedFrames: stage === "canvas" ? canvasFrames ?? null : walks ?? null };
    };
    for (const [index, companion] of matchingPages.entries()) {
      if (companion === page) continue;
      await companion.waitForFunction(() => window.__mirrorHandPoses?.().holders.some(h => h.inFan),
        null, { timeout: 30000 });
      const stage = await companion.locator(".mirror-stage").boundingBox();
      if (!stage) throw new Error(`companion page ${index} has no mirror stage`);
      const session = await companion.context().newCDPSession(companion);
      await session.send("Network.enable");
      const stat = { pageIndex: index, pageUrl: companion.url(), moves: 0, wireHovers: 0,
        receivedDeltas: 0, activityBefore: await companion.evaluate(activitySnapshot), activityAfter: null,
        startedAt: Date.now(), stoppedAt: null, error: null, session, stage, page: companion };
      session.on("Network.webSocketFrameSent", event => {
        try {
          const input = JSON.parse(event.response?.payloadData ?? "");
          if (input.type === "input" && input.kind === "hover") stat.wireHovers++;
        } catch { /* other socket traffic */ }
      });
      session.on("Network.webSocketFrameReceived", event => {
        try {
          const message = JSON.parse(event.response?.payloadData ?? "");
          if (message.type === "scene-delta") stat.receivedDeltas++;
        } catch { /* other socket traffic */ }
      });
      companionStats.push(stat);
    }
    companionRunning = true;
    companionLoop = (async () => {
      let tick = 0;
      const periodMs = 1000 / companionHoverHz;
      let nextAt = performance.now();
      while (companionRunning) {
        const fraction = tick++ % 2 ? .7 : .3;
        try {
          await Promise.all(companionStats.map(async stat => {
            await stat.session.send("Input.dispatchMouseEvent", { type: "mouseMoved",
              x: stat.stage.x + stat.stage.width * fraction,
              y: stat.stage.y + stat.stage.height * .78 });
            stat.moves++;
          }));
        } catch (error) {
          for (const stat of companionStats) stat.error = String(error);
          companionRunning = false;
          break;
        }
        nextAt += periodMs;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, nextAt - performance.now())));
      }
    })();
  }
  for (let id = 1; id <= count; id++) {
    if (!firstReturn) await page.evaluate(() => { window.__responseBench.current = null; });
    // Separate idle and continuously active populations: never merge away a slow first input.
    const idle = !firstReturn && id % 2 === 0 ? idleMs : 0;
    if (idle) await page.waitForTimeout(idle);
    // A response can finish before the hand pose and interactive-rect probes settle on the
    // same frame. Readiness may recover without any input; the observed seat-input gap below
    // still rejects a nominally active sample if this wait crosses the user-idle boundary.
    const targetWaitStart = performance.now();
    let selection = firstReturn ? { target: firstReturnPreparedTarget, state: null } :
      await page.evaluate(() => {
        const bench = window.__responseBench;
        return { target: bench.pickTarget(), state: bench.lastPickState };
      });
    const firstMiss = selection.target ? null : selection.state;
    let attempts = 1;
    while (!firstReturn && !selection.target && performance.now() - targetWaitStart < 500) {
      await new Promise(resolve => setTimeout(resolve, 16));
      selection = await page.evaluate(() => {
        const bench = window.__responseBench;
        return { target: bench.pickTarget(), state: bench.lastPickState };
      });
      attempts++;
    }
    targetSelections.push({ id, attempts, waitMs: performance.now() - targetWaitStart,
      firstMiss, finalMiss: selection.target ? null : selection.state });
    const target = selection.target;
    if (!target) throw new Error(`sample ${id}: no unfocused on-stage hand target after ${attempts} reads`);
    captureTargetId = id;
    if (!firstReturn) await page.evaluate(sample => { window.__responseBench.current = sample; },
      { ...target, id, idleMs: idle, firstReturn: false, inputCount: 0 });
    if (firstReturn) {
      // One CDP dispatch keeps the first trusted pointer adjacent to the in-page ready signal.
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
    } else {
      await page.mouse.move(target.x, target.y);
    }
    try {
      await page.waitForFunction(() => window.__responseBench.current?.drawnAt, null, { timeout: 5000 });
      const deadline = Date.now() + 5000;
      while (!frames.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    } catch (error) { failure = String(error); }
    const sample = await page.evaluate(() => {
      const current = window.__responseBench.current;
      window.__responseBench.current = null;
      return current;
    });
    if (firstReturn && sample?.pointerAt) {
      returnLifecycle.handReadyToInputMs = sample.pointerAt - returnLifecycle.stream.handReadyAt;
      returnLifecycle.handReadyToPreparedMs = returnLifecycle.stream.preparedAt -
        returnLifecycle.stream.handReadyAt;
      returnLifecycle.preparedToInputMs = sample.pointerAt - returnLifecycle.stream.preparedAt;
      returnLifecycle.streamOpenToHandReadyMs = returnLifecycle.stream.handReadyAt -
        returnLifecycle.stream.streamOpenAt;
      returnLifecycle.fullSceneToHandReadyMs = returnLifecycle.stream.handReadyAt -
        returnLifecycle.stream.firstFullSceneAt;
      returnLifecycle.immediateInputLimitMs = FIRST_RETURN_READY_TO_INPUT_LIMIT_MS;
      returnLifecycle.immediateInputQualified = returnLifecycle.handReadyToInputMs >= 0 &&
        returnLifecycle.handReadyToInputMs <= FIRST_RETURN_READY_TO_INPUT_LIMIT_MS;
      if (!returnLifecycle.immediateInputQualified)
        failure = `first return input waited ${returnLifecycle.handReadyToInputMs.toFixed(3)}ms after observed hand readiness`;
      const preSample = await page.evaluate(() => ({
        count: window.__responseBench.preSampleInputCount,
        inputs: window.__responseBench.preSampleInputs,
      }));
      returnLifecycle.preSampleInputCountAfter = preSample.count;
      returnLifecycle.preSampleInputsAfter = preSample.inputs;
      if (preSample.count !== 0) failure = "input was sent before the first controlled return pointer";
    }
    const frame = frames.get(id);
    const verdict = qualifyCausalChain(sample, frame);
    const framePath = frame ? path.join(out, `response-${id}.png`) : null;
    if (frame) await writeFile(framePath, frame.png);
    samples.push({ ...sample, frame: frame ? { id, timestampMs: frame.timestampMs, path: framePath } : null,
      causalValid: verdict.valid, causalReason: verdict.reason ?? null, ...verdict });
    if (!verdict.valid || failure) throw new Error(failure ?? `sample ${id}: ${verdict.reason}`);
  }
} catch (error) { failure = String(error); }
finally {
  captureTargetId = null;
  pendingDecodeFrame = null;
  preSampleInputs = await page.evaluate(() => window.__responseBench ? {
    count: window.__responseBench.preSampleInputCount,
    inputs: window.__responseBench.preSampleInputs,
  } : null).catch(() => null);
  if (!preSampleInputs || preSampleInputs.count !== 0)
    failure ??= "unmeasured input was sent from the selected browser page";
  geometryAfter = await page.evaluate(() => ({
    innerWidth, innerHeight, devicePixelRatio, visibilityState: document.visibilityState,
    crossOriginIsolated, clockResolutionMs: window.__responseBench?.clockResolutionMs ?? null,
    visualViewport: window.visualViewport ? {
      width: window.visualViewport.width, height: window.visualViewport.height,
      scale: window.visualViewport.scale, offsetLeft: window.visualViewport.offsetLeft,
      offsetTop: window.visualViewport.offsetTop,
    } : null,
    stage: window.__mirrorHandPoses?.().stage ?? null,
  })).catch(() => null);
  if (geometryBefore && JSON.stringify(geometryBefore) !== JSON.stringify(geometryAfter))
    failure ??= "page geometry, visibility, or backend changed during capture";
  companionRunning = false;
  if (companionLoop) await companionLoop;
  for (const stat of companionStats) {
    stat.stoppedAt = Date.now();
    stat.activityAfter = await stat.page.evaluate(() => {
      const stage = window.__mirrorHandPoses?.().stage ?? null;
      const walks = window.__mirrorWalkStats?.walks;
      const canvasFrames = window.__mirrorCanvasStats?.().frames;
      return { visibilityState: document.visibilityState, stage,
        walks: Number.isFinite(walks) ? walks : null,
        canvasFrames: Number.isFinite(canvasFrames) ? canvasFrames : null,
        renderedFrames: stage === "canvas" ? canvasFrames ?? null : walks ?? null };
    }).catch(() => null);
    if (stat.error || stat.wireHovers === 0 || stat.receivedDeltas === 0 ||
        stat.activityBefore?.visibilityState !== "visible" ||
        stat.activityAfter?.visibilityState !== "visible" ||
        stat.activityBefore?.stage !== stat.activityAfter?.stage ||
        !Number.isFinite(stat.activityBefore?.renderedFrames) ||
        !Number.isFinite(stat.activityAfter?.renderedFrames) ||
        stat.activityAfter.renderedFrames <= stat.activityBefore.renderedFrames)
      failure ??= `companion page ${stat.pageIndex} lacked active hover, scene, or render evidence`;
    await stat.session.detach().catch(() => {});
  }
  if (cdp) await cdp.send("Page.stopScreencast").catch(() => {});
  await frameDecoder.terminate();
  if (cdp && traceStarted) {
    await cdp.send("Tracing.end").catch(error => { failure ??= String(error); });
    await Promise.race([
      traceComplete,
      new Promise((_, reject) => setTimeout(() => reject(new Error("trace completion timed out")), 10000)),
    ]).catch(error => { failure ??= String(error); });
  }
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const verdict = qualifySample(sample, frames.get(sample.id), traceEvents);
    samples[i] = { ...sample, ...verdict };
    if (!verdict.valid) failure ??= `sample ${sample.id}: ${verdict.reason}`;
  }
  await writeFile(path.join(out, "trace-events.json"), JSON.stringify(traceEvents) + "\n");
  const summarize = (population, field = "inputToPresentedMs") =>
    percentiles(samples.filter(s => s.valid && s.population === population).map(s => s[field]));
  const harnessFiles = {};
  for (const file of ["measure-latency.mjs", "lib/input-response-latency.mjs", "lib/png.mjs",
    "lib/latency-frame-decoder-worker.mjs"]) {
    const bytes = await readFile(new URL(`./${file}`, import.meta.url));
    harnessFiles[`scripts/${file}`] = createHash("sha256").update(bytes).digest("hex");
  }
  const report = { schema: "input-response-latency/3", synthetic, syntheticAckDelayMs,
    syntheticOmitFirstAcks,
    browserVersion, chromiumSourceTag: "147.0.7727.15",
    instance, url, matchUrlPrefix, pageUrl: page.url(), pageIndex, selectedPageIndex,
    freshPage, requestedViewport: freshViewport, preSampleInputs,
    harnessFiles,
    firstReturn, returnLifecycle,
    expectedPages, companionHoverHz, companions: companionStats.map(({ session, stage, page, ...stat }) => stat),
    viewport: geometryBefore, viewportAfter: geometryAfter, preInputScreencastFrames, screencastFrames,
    decoderStats,
    targetSelections,
    captureWarmup: firstReturn
      ? "screencast before return; black marker canvas/context/layer preallocated; no post-ready frame gate or reset input"
      : "screencast before navigation; black marker canvas/context/layer preallocated; two post-ready frames before input; no reset input",
    samples,
    metric: "input-to-first-browser-presentation-callback", presentation:
      "Chrome AnimationFrame opaque-id and nonzero begin-frame presentation callback (swap fallback possible); clock bounded by response trace marker; later barcode PNG proves visible persistence, not swap timing or physical scanout",
    firstInput: firstReturn ? null : summarize("first-input"),
    firstInputLower: firstReturn ? null : summarize("first-input", "inputToPresentedLowerMs"),
    firstInputUpper: firstReturn ? null : summarize("first-input", "inputToPresentedUpperMs"),
    active: firstReturn ? null : summarize("active"),
    firstAfterIdle: firstReturn ? null : summarize("first-after-idle"),
    activeLower: firstReturn ? null : summarize("active", "inputToPresentedLowerMs"),
    activeUpper: firstReturn ? null : summarize("active", "inputToPresentedUpperMs"),
    firstAfterIdleLower: firstReturn ? null : summarize("first-after-idle", "inputToPresentedLowerMs"),
    firstAfterIdleUpper: firstReturn ? null : summarize("first-after-idle", "inputToPresentedUpperMs"),
    firstAfterReturn: firstReturn ? summarize("first-after-return") : null,
    firstAfterReturnLower: firstReturn ? summarize("first-after-return", "inputToPresentedLowerMs") : null,
    firstAfterReturnUpper: firstReturn ? summarize("first-after-return", "inputToPresentedUpperMs") : null,
    requested: count, complete: !failure && samples.length === count,
    failure, noRegressionVerdict: "unassessed: requires repeated interleaved ABBA baseline/candidate runs" };
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
  await browser.close();
}
process.exitCode = failure ? 1 : 0;
