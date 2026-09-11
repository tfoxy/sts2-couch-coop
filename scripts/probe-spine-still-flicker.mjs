#!/usr/bin/env node
// R11 WS-F — BLANK-FRAME PROBE for the spine still decode gate.
//
// Reproduces (and then proves the absence of) "creature spines flash INVISIBLE for a few frames on every
// animation change". A recorded combat keyframe mounts REAL creatures, then this script drives synthetic
// animation flips through the in-page fake WebSocket while an rAF sampler watches every `img.mirror-spine-img`
// and counts the frames on which it is attached but NOT paintable (`!complete || naturalWidth === 0`) — which
// is exactly the state Chromium paints as nothing.
//
// The spine STILLS themselves are real: `/spines/**` is proxied by the dev server to the live game, so the
// bytes are the game's own 0.7-1.4MP WebP bakes and the decode cost is the real one. That is the whole point —
// a synthetic 1×1 image decodes too fast to show the defect.
//
//   # dev server serving the branch under test:
//   cd frontend && npx vite --port 5199 --strictPort
//   # before (reproduce):
//   node scripts/probe-spine-still-flicker.mjs --url http://127.0.0.1:5199 --query spineDecodeGate=off --throttle 6
//   # after (the gate):
//   node scripts/probe-spine-still-flicker.mjs --url http://127.0.0.1:5199 --throttle 6
//
// Every run writes `result.json` + `flip-*.png` under `.sts2/artifacts/spine-still-flicker/<label>/`.

import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const a = {
    url: "http://127.0.0.1:5199",
    recording: resolve(REPO_ROOT, ".sts2/bench/combat-modern-2026-08-06.ndjson"),
    query: "",
    label: null,
    throttle: Number(process.env.COUCHCOOP_CPU_THROTTLE ?? 0),
    flips: 12,
    intervalMs: 500,
    shots: 3,
    viewport: { width: 1600, height: 900 },
    headed: false,
    screencast: 0 // capture the compositor's own frames for the last N flips (ground truth for "it went blank")
  };
  for (let i = 2; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const next = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--url") a.url = next();
    else if (flag === "--recording") a.recording = resolve(next());
    else if (flag === "--query") a.query = next();
    else if (flag === "--label") a.label = next();
    else if (flag === "--throttle") a.throttle = Number(next());
    else if (flag === "--flips") a.flips = Number(next());
    else if (flag === "--interval") a.intervalMs = Number(next());
    else if (flag === "--shots") a.shots = Number(next());
    else if (flag === "--headed") a.headed = true;
    else if (flag === "--screencast") a.screencast = Number(next());
    else if (flag === "--help") {
      console.log("usage: probe-spine-still-flicker.mjs [--url U] [--query q] [--label L] [--throttle N] [--flips N] [--interval MS]");
      process.exit(0);
    }
  }
  a.label ??= a.query ? a.query.replace(/[^a-z0-9]+/gi, "-") : "gate-on";
  return a;
}

const args = parseArgs(process.argv);

// ---------------------------------------------------------------------------------------------------------
// Recording → (a) the messages up to and including the first FULL scene-delta (the combat keyframe), and
// (b) the spine nodes in it, so the flips address real creatures with real animation names.
// ---------------------------------------------------------------------------------------------------------
function loadScene(path) {
  const recordingText = readFileSync(path, "utf8");
  requireReproHeader(recordingText, path);
  const lines = recordingText.split("\n");
  const prefix = [];
  const spines = new Map();
  const envelope = { screenType: "run", screenInstanceId: undefined };
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.meta || typeof obj.data !== "string") continue;
    if (obj.data.includes('"type":"server-reload"')) continue;
    prefix.push(obj.data);
    let msg;
    try {
      msg = JSON.parse(obj.data);
    } catch {
      continue;
    }
    if (msg.type !== "scene-delta") continue;
    if (msg.screenType) envelope.screenType = msg.screenType;
    if (msg.screenInstanceId) envelope.screenInstanceId = msg.screenInstanceId;
    for (const u of msg.upserts ?? []) {
      if (u.spine?.sceneResPath && (u.spine.animations ?? []).length > 1 && !spines.has(u.id)) {
        spines.set(u.id, { id: u.id, name: u.name, scene: u.spine.sceneResPath, animations: u.spine.animations, last: u });
      } else if (spines.has(u.id)) {
        // Keep the LATEST full upsert per creature: a flip has to re-send the whole node (parentId, transform,
        // spine metadata …), because a partial upsert replaces the node and would strip it of its spine
        // identity entirely — the node stops being a spine node and the layer is torn down instead of swapped.
        const entry = spines.get(u.id);
        entry.last = { ...entry.last, ...u, spine: u.spine ?? entry.last.spine };
      }
    }
  }
  return { prefix, spines: [...spines.values()], envelope };
}

const { prefix, spines, envelope } = loadScene(args.recording);
if (spines.length === 0) {
  console.error(`no multi-animation spine nodes found in ${args.recording}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------
// in-page: fake WebSocket (prefix, then whatever the driver pushes) + the rAF blank-frame sampler
// ---------------------------------------------------------------------------------------------------------
function pageInit(config) {
  const OPEN = 1;
  class ProbeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      window.__probeWs = this;
      // EVERY live socket, not just the newest: the app can open more than one (`window.__probeWs` alone
      // pointed at a later, non-listening socket — the recorded prefix rendered, the synthetic flips silently
      // went nowhere, and the probe measured 0 swaps).
      (window.__probeSockets ??= []).push(this);
      if (this.url.includes("/ws")) {
        // The 300ms open + the 1ms-per-message pacing are LOAD-BEARING: opening in the same task as the
        // constructor delivers the keyframe before the app has finished subscribing (observed: 0 nodes,
        // "Loading…" forever), and a 869-message burst in one task starves the very rAF this probe samples.
        setTimeout(async () => {
          this.readyState = OPEN;
          this._emit("open", new Event("open"));
          this._deliver('{"type":"session","directView":true}');
          window.__probeReady = true;
          for (const data of config.prefix) {
            this._deliver(data);
            await new Promise((r) => setTimeout(r, 1));
          }
          window.__probeDrained = true;
        }, 300);
      }
    }
    _emit(type, event) {
      const handler = this["on" + type];
      if (typeof handler === "function") handler.call(this, event);
      this.dispatchEvent(event);
    }
    _deliver(data) {
      this._emit("message", new MessageEvent("message", { data }));
    }
    send(data) {
      let msg = null;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg?.type === "join") this._deliver('{"type":"session","directView":true}');
      else if (msg?.type === "ping") this._deliver(JSON.stringify({ type: "pong", t0: msg.t0 }));
    }
    close() {
      this.readyState = 3;
      this._emit("close", new CloseEvent("close"));
    }
  }
  window.WebSocket = ProbeWebSocket;

  // THE PROBE. Once per rAF, for every attached spine <img>: is it paintable? An <img> whose `src` has been
  // swapped but whose bytes are not decoded yet answers complete=false (or naturalWidth 0) and paints NOTHING.
  window.__blank = { frames: 0, blankFrames: 0, blankByImg: {}, worstRun: 0, run: 0, samples: [] };
  const tick = () => {
    const state = window.__blank;
    state.frames += 1;
    let blankHere = 0;
    for (const img of document.querySelectorAll("img.mirror-spine-img")) {
      const ok = img.complete && img.naturalWidth > 0;
      if (!ok) {
        blankHere += 1;
        const key = img.getAttribute("src") ?? "(none)";
        state.blankByImg[key] = (state.blankByImg[key] ?? 0) + 1;
      }
    }
    if (blankHere > 0) {
      state.blankFrames += 1;
      state.run += 1;
      if (state.run > state.worstRun) state.worstRun = state.run;
    } else {
      state.run = 0;
    }
    if (state.samples.length < 4000) state.samples.push(blankHere);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // THE DECODE-DEBT PROBE — the measurement that actually sees the defect.
  //
  // `complete`/`naturalWidth` track the LOAD, and a blob url loads from memory in well under a frame, so they
  // stay true across the whole flash: the flash is the DECODE, which Chromium does lazily at paint time. So
  // watch the live element's `src` attribute and, the moment it changes, ask the element itself how long its
  // new bytes still need before they can paint (`img.decode()`), plus how many rAF frames elapse before that
  // resolves. That interval IS the window in which the element paints nothing.
  //   gate OFF: src is written first, decode debt is the full raster of a 0.7-1.4MP WebP.
  //   gate ON:  src is written only AFTER a probe image decoded the same url, so the debt is ~0 by construction.
  window.__swaps = [];
  const observer = new MutationObserver((records) => {
    const t0 = performance.now();
    const frame0 = window.__blank.frames;
    for (const rec of records) {
      if (rec.attributeName !== "src") continue;
      const el = rec.target;
      if (!(el instanceof HTMLImageElement) || !el.classList.contains("mirror-spine-img")) continue;
      const src = el.getAttribute("src") ?? "";
      const entry = {
        src: src.slice(0, 40),
        completeAtSwap: el.complete,
        naturalWidthAtSwap: el.naturalWidth,
        decodeMs: null,
        decodeFrames: null
      };
      window.__swaps.push(entry);
      const settle = () => {
        entry.decodeMs = Math.round((performance.now() - t0) * 100) / 100;
        entry.decodeFrames = window.__blank.frames - frame0;
      };
      if (typeof el.decode === "function") {
        el.decode().then(settle, settle);
      } else {
        settle();
      }
    }
  });
  const startObserving = () => {
    const stage = document.querySelector(".mirror-stage") ?? document.body;
    observer.observe(stage, { attributes: true, attributeFilter: ["src"], subtree: true });
  };
  window.__probeObserve = startObserving;

  // Deliver one synthetic scene-delta (the driver builds the anim flip).
  window.__probeSend = (json) => {
    let delivered = 0;
    for (const ws of window.__probeSockets ?? []) {
      if (ws.readyState === 1) {
        ws._deliver(json);
        delivered += 1;
      }
    }
    return delivered;
  };
  window.__spineImgCount = () => document.querySelectorAll("img.mirror-spine-img").length;
}

const pageUrl = `${args.url.replace(/\/$/, "")}/?quality=high&effects=off${args.query ? `&${args.query}` : ""}`;
const outDir = resolve(REPO_ROOT, ".sts2/artifacts/spine-still-flicker", args.label);
mkdirSync(outDir, { recursive: true });

console.log(`probe-spine-still-flicker  label=${args.label}`);
console.log(`  url:      ${pageUrl}`);
console.log(`  spines:   ${spines.map((s) => `${s.id}(${s.animations.length} anims)`).join(", ")}`);
console.log(`  throttle: ${args.throttle || 1}x   flips: ${args.flips} every ${args.intervalMs}ms`);

// Decode debt = how long the element's NEW bytes still needed before they could paint, measured from the src
// write. Anything above ~0 is a window in which Chromium has dropped the old frame and cannot yet draw the new
// one — the flash. `decodeFrames` counts the rAF frames that elapsed inside it.
function summarizeDebt(swaps) {
  const done = swaps.filter((s) => typeof s.decodeMs === "number");
  const ms = done.map((s) => s.decodeMs).sort((a, b) => a - b);
  const frames = done.map((s) => s.decodeFrames ?? 0);
  const at = (q) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : 0);
  return {
    measured: done.length,
    medianMs: at(0.5),
    p90Ms: at(0.9),
    maxMs: ms.length ? ms[ms.length - 1] : 0,
    maxFrames: frames.length ? Math.max(...frames) : 0,
    lateSwaps: frames.filter((f) => f > 1).length
  };
}

const browser = await chromium.launch({ headless: !args.headed, args: ["--disable-gpu"] });
const context = await browser.newContext({ viewport: args.viewport });
await context.addInitScript(pageInit, { prefix });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
page.on("console", (m) => {
  if (m.type() === "error") console.log(`  [page error] ${m.text().slice(0, 160)}`);
});
const spineResponses = [];
page.on("response", (r) => {
  if (r.url().includes("/spines/")) spineResponses.push(`${r.status()} ${r.url().replace(/^[^?]*\?/, "")}`);
});
const failedRequests = [];
page.on("requestfailed", (r) => failedRequests.push(`${r.failure()?.errorText ?? "?"} ${r.url().slice(0, 60)}`));

await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__probeReady === true, null, { timeout: 30000 });
// Drain the whole recording (the scene settles at its end state), then let the first stills fetch + land, so
// the count starts from a settled screen.
await page.waitForFunction(() => window.__probeDrained === true, null, { timeout: 180000 });
await page.waitForFunction(() => window.__spineImgCount?.() > 0, null, { timeout: 60000 });
await page.waitForTimeout(4000);
const settledImgs = await page.evaluate(() => window.__spineImgCount());
await page.evaluate(() => {
  window.__blank = { frames: 0, blankFrames: 0, blankByImg: {}, worstRun: 0, run: 0, samples: [] };
  window.__swaps = [];
  window.__probeObserve();
});
// Heap + compositor-layer baseline, taken AFTER the settle so the boot's garbage is not counted. The gate must
// not leak (it holds a retain per displayed still and a probe Image per in-flight decode) and must not add a
// composited layer (an <img> is not a layer; the whole point of the still path is that it replaced a canvas).
const measureHeap = async () => {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const m = await cdp.send("Performance.getMetrics");
  return m.metrics.find((x) => x.name === "JSHeapUsedSize")?.value ?? 0;
};
const countLayers = async () => {
  let latest = [];
  const onChange = (e) => {
    if (Array.isArray(e.layers)) latest = e.layers;
  };
  cdp.on("LayerTree.layerTreeDidChange", onChange);
  await cdp.send("LayerTree.enable");
  await page.waitForTimeout(500);
  if (typeof cdp.off === "function") cdp.off("LayerTree.layerTreeDidChange", onChange);
  await cdp.send("LayerTree.disable").catch(() => {});
  return latest.length;
};
await cdp.send("Performance.enable");
const heapBefore = await measureHeap();
const layersBefore = await countLayers();

// Throttle only for the MEASURED window: applying it to the boot/drain as well just makes the harness slow
// (and timed out at 30s), while what needs to be slow is the decode a swap has to wait for.
if (args.throttle > 1) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: args.throttle });
}

const spineFetchesBeforeWindow = spineResponses.length;
let delivered = 0;

// COMPOSITOR ground truth. `page.screenshot()` forces a full raster (it WAITS for pending decodes), so it can
// never show the flash; the screencast streams the frames the compositor actually presented.
const castFrames = [];
let casting = false;
cdp.on("Page.screencastFrame", async (f) => {
  castFrames.push({ t: f.metadata.timestamp, data: f.data });
  try {
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
  } catch {
    /* the page went away */
  }
});
const startCast = async () => {
  if (casting) return;
  casting = true;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 });
};
// Flip every creature's animation round-robin; a still swap is one full request → decode → paint each time.
const shotAt = new Set(
  Array.from({ length: args.shots }, (_, i) => Math.floor(((i + 1) * args.flips) / (args.shots + 1)))
);
for (let i = 0; i < args.flips; i++) {
  if (args.screencast > 0 && i === args.flips - args.screencast) {
    await startCast();
  }
  const upserts = spines.map((s, idx) => ({
    ...s.last,
    spineCurrentAnim: s.animations[(i + idx) % s.animations.length],
    spineTrackTime: 0
  }));
  delivered = await page.evaluate(
    (json) => window.__probeSend(json),
    JSON.stringify({
      type: "scene-delta",
      full: false,
      screenType: envelope.screenType,
      screenInstanceId: envelope.screenInstanceId,
      removedIds: [],
      orderPatch: { parents: [] },
      upserts
    })
  );
  if (shotAt.has(i)) {
    // A screenshot ~1 frame after the flip: with the gate off this is where the creature is missing.
    await page.waitForTimeout(40);
    await page.screenshot({ path: resolve(outDir, `flip-${String(i).padStart(2, "0")}.png`) });
    await page.waitForTimeout(args.intervalMs - 40);
  } else {
    await page.waitForTimeout(args.intervalMs);
  }
}
await page.waitForTimeout(600);
if (casting) {
  await cdp.send("Page.stopScreencast");
  const keep = castFrames.slice(-Math.min(castFrames.length, 60));
  keep.forEach((f, i) => {
    writeFileSync(resolve(outDir, `cast-${String(i).padStart(3, "0")}.jpg`), Buffer.from(f.data, "base64"));
  });
  console.log(`  screencast: ${castFrames.length} frames captured, last ${keep.length} written`);
}

if (args.throttle > 1) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
}
const heapAfter = await measureHeap();
const layersAfter = await countLayers();
const blank = await page.evaluate(() => window.__blank);
const swaps = await page.evaluate(() => window.__swaps);
const spineFetchesInWindow = spineResponses.length - spineFetchesBeforeWindow;
const walk = await page.evaluate(() => {
  const s = window.__mirrorWalkStats ?? {};
  return {
    spineStillDecodes: s.spineStillDecodes ?? null,
    spineStillCommits: s.spineStillCommits ?? null,
    spineStillStale: s.spineStillStale ?? null
  };
});
await page.screenshot({ path: resolve(outDir, "final.png") });

const result = {
  label: args.label,
  url: pageUrl,
  recording: args.recording,
  cpuThrottle: args.throttle || 1,
  flips: args.flips,
  intervalMs: args.intervalMs,
  spineImgs: settledImgs,
  frames: blank.frames,
  blankFrames: blank.blankFrames,
  blankFramePct: blank.frames ? Math.round((blank.blankFrames / blank.frames) * 10000) / 100 : 0,
  worstConsecutiveBlankFrames: blank.worstRun,
  blankByImg: blank.blankByImg,
  swaps: swaps.length,
  heapBeforeMB: Math.round((heapBefore / 1048576) * 100) / 100,
  heapAfterMB: Math.round((heapAfter / 1048576) * 100) / 100,
  layersBefore,
  layersAfter,
  socketsDeliveredTo: delivered,
  spineFetchesInWindow,
  spineResponses: spineResponses.slice(-24),
  failedRequests,
  decodeDebt: summarizeDebt(swaps),
  swapSample: swaps.slice(0, 12),
  walkStats: walk
};
writeFileSync(resolve(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(
  `  RESULT: ${blank.blankFrames}/${blank.frames} frames with a blank spine <img> ` +
    `(${result.blankFramePct}%), worst run ${blank.worstRun} frames; imgs=${settledImgs}`
);
console.log(
  `  SWAPS:  ${swaps.length}   decode debt after the src write: ` +
    `median ${result.decodeDebt.medianMs}ms  p90 ${result.decodeDebt.p90Ms}ms  max ${result.decodeDebt.maxMs}ms  ` +
    `(>1 frame on ${result.decodeDebt.lateSwaps}/${swaps.length} swaps, worst ${result.decodeDebt.maxFrames} frames)`
);
console.log(
  `  HEAP:   ${result.heapBeforeMB}MB → ${result.heapAfterMB}MB after ${swaps.length} swaps   ` +
    `LAYERS: ${layersBefore} → ${layersAfter}`
);
console.log(`  walk stats: ${JSON.stringify(walk)}`);
console.log(`  artifacts: ${outDir}`);

await browser.close();
