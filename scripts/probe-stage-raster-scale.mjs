#!/usr/bin/env node
// RASTER-SCALE / TILE census for the mirror stage — "how many pixels does this page actually rasterise, and at
// what scale?", answered by the COMPOSITOR itself rather than by DevTools' layer panel.
//
// It replays a recorded mirror stream into the real mirror page (same fake-WebSocket trick as
// scripts/bench-mirror-replay.mjs), then reads cc's own `cc::LayerTreeHostImpl` object snapshots out of a
// `disabled-by-default-cc.debug` trace. Those snapshots carry, per composited layer: `bounds`,
// `raster_scales.contents_scale`, `ideal_contents_scale`, every `tilings[]` entry (its `tiling_rect`,
// `visible_rect` and `num_tiles`), `gpu_memory_usage`, and the layer's REAL `compositing_reasons`.
//
//   cd frontend && npx vite --port 5199 --strictPort
//   node scripts/probe-stage-raster-scale.mjs --url http://127.0.0.1:5199 \
//     --recording "$PRIMARY/.sts2/bench/combat-modern-2026-08-06.ndjson" \
//     --viewport 780x351 --dpr 3.4876 --bg <2520x1080.png> --out .sts2/artifacts/raster/base.json
//   # ...repeat with `--css '<stylesheet>'` or a supported diagnostic `--query <flag>=off` when investigating.
//
// FOUR traps it exists to kill — each one produces a confident WRONG answer:
//
//  1. `Layer.width/height` (CDP `LayerTree`) is the layer's BOUNDS, not its rastered area. A phone capture
//     reporting an 8374x3767 layer for a 2712x1220 screen is NOT proof of a 9.5x raster: on a device Chrome uses
//     zoom-for-dsf, so bounds come out in PHYSICAL px (2401 design px x 3.4876 dsf = 8374) while the raster scale
//     is a separate number. The rastered area is `tilings[].tiling_rect` — read it, don't infer it.
//  2. Playwright's `deviceScaleFactor` never reaches cc: it goes through `Emulation.setDeviceMetricsOverride`, so
//     `raster_scales.device_scale` stays 1 and every layer's bounds stay in CSS px — a different machine from the
//     phone. This probe therefore ALSO passes `--force-device-scale-factor=<dpr>` to the browser, which is what
//     switches Chromium to zoom-for-dsf and reproduces a device capture number-for-number.
//  3. CDP `LayerTree.compositingReasons` MISATTRIBUTES reasons to neighbouring layers. Measured here: it reported
//     `RootScroller + OverflowScrolling` for a layer that cc's own snapshot shows is an `Overlap`-promoted
//     `.mirror-node`. Only the trace's `compositing_reasons` are the compositor's answer.
//  4. A viewport nudge (this probe uses one to force a re-raster) leaves a STALE second tiling on each layer for
//     a while, which doubles naive `num_tiles`/`gpu_memory_usage` totals and makes the run bimodal. Totals below
//     count only the tiling at the layer's CURRENT raster scale; `staleTilings` reports how many were dropped.
//
// Plus one configuration trap that is not about the compositor at all: on a dev server `/bg/<id>.png` 404s (no
// host to render it), so StaticBackground.vue fails open and the LIVE combat-background subtree stays on screen —
// roughly 3x the tile budget of the shipped configuration. `--bg <png>` serves a stand-in so the census describes
// what a player actually gets. (A 2520x1080 image with distinctive outer 300px bands doubles as the visual proof
// that `.mirror-stage` still clips them on a 16:9 stage.)
//
// Exit codes: 0 census taken (or `--assert-folded` passed) - 1 `--assert-folded` found a layer rastering above
// its ideal scale - 2 usage/harness error.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { dirname, resolve } from "node:path";
import { REPO_ROOT } from "./lib/repo-layout.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    url: "http://127.0.0.1:5199",
    recording: null,
    viewport: { width: 780, height: 351 },
    dpr: 3.4876,
    css: null,
    query: "",
    bg: null,
    out: null,
    shot: null,
    settleMs: 2500,
    top: 14,
    assertFolded: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [key, inline] = eq > 0 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const val = () => inline ?? argv[++i];
    switch (key) {
      case "--url": a.url = val(); break;
      case "--recording": a.recording = val(); break;
      case "--viewport": {
        const m = /^(\d+)x(\d+)$/i.exec(String(val()));
        if (m) a.viewport = { width: Number(m[1]), height: Number(m[2]) };
        break;
      }
      case "--dpr": a.dpr = Number(val()); break;
      case "--css": a.css = val(); break;
      case "--css-file": a.css = readFileSync(resolve(val()), "utf8"); break;
      case "--query": a.query = String(val()).replace(/^[?&]/, ""); break;
      case "--bg": a.bg = resolve(val()); break;
      case "--out": a.out = resolve(val()); break;
      case "--shot": a.shot = resolve(val()); break;
      case "--settle": a.settleMs = Number(val()); break;
      case "--top": a.top = Number(val()); break;
      case "--assert-folded": a.assertFolded = true; break;
      case "--help": case "-h": a.help = true; break;
      default: break;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`probe-stage-raster-scale.mjs - per-layer raster scale + tile census from cc's own snapshots

  --url <origin>        dev server serving the code under test (default http://127.0.0.1:5199)
  --recording <path>    recorded scene-delta stream (scripts/record-mirror-stream.mjs)
  --viewport <WxH>      CSS-px viewport (default 780x351 - the Moto G86's 2712x1220 at dpr 3.4876)
  --dpr <n>             device scale factor; ALSO passed as --force-device-scale-factor (default 3.4876)
  --css '<css>'         inject a stylesheet before page scripts for a diagnostic comparison without editing source
  --css-file <path>     same, from a file
  --query <k=v&...>     extra page-URL params (kill switches)
  --bg <png>            serve this image for /bg/** so StaticBackground.vue engages (see the header)
  --out <file.json>     write the full census
  --shot <file.png>     post-settle screenshot
  --settle <ms>         extra settle after the stream drains (default 2500)
  --top <n>             rows in the printed table (default 14)
  --assert-folded       exit 1 if any layer rasters above its ideal contents scale
`);
  process.exit(0);
}

const recordingPath = args.recording
  ? resolve(args.recording)
  : resolve(REPO_ROOT, ".sts2/bench/combat-modern-2026-08-06.ndjson");
if (!existsSync(recordingPath)) {
  console.error(`no recording at ${recordingPath} (pass --recording)`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------
// in-page fake WebSocket - same semantics as scripts/bench-mirror-replay.mjs (recorded pace, synthesized
// directView for a passive capture, ping/pong, join reply). Kept local for the same reason its siblings do.
// ---------------------------------------------------------------------------------------------------------

function fakeWebSocketInit(config) {
  const OPEN = 1;
  const realFetch = window.fetch.bind(window);
  class ProbeWebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      this._msgs = []; this._i = 0; this._closed = false;
      if (this.url.includes("/ws")) this._start();
    }
    async _start() {
      let text = "";
      try { text = await (await realFetch(config.recordingUrl)).text(); } catch { window.__probeWsError = "fetch"; return; }
      for (const line of text.split("\n")) {
        if (!line) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        if (obj.meta || typeof obj.data !== "string") continue;
        if (obj.data.includes('"type":"server-reload"')) continue;
        this._msgs.push({ t: typeof obj.t === "number" ? obj.t : 0, data: obj.data });
      }
      if (this._closed) return;
      this.readyState = OPEN;
      this._emit("open", new Event("open"));
      if (config.synthesizeDirectView) this._deliver('{"type":"session","directView":true}');
      const t0 = performance.now();
      const tick = () => {
        if (this._closed) return;
        const now = performance.now() - t0;
        while (this._i < this._msgs.length && this._msgs[this._i].t <= now) { this._deliver(this._msgs[this._i].data); this._i++; }
        if (this._i < this._msgs.length) setTimeout(tick, Math.max(0, this._msgs[this._i].t - (performance.now() - t0)));
        else window.__probeDone = true;
      };
      tick();
    }
    _deliver(data) { this._emit("message", new MessageEvent("message", { data })); }
    _emit(type, event) {
      const handler = this["on" + type];
      if (typeof handler === "function") { try { handler.call(this, event); } catch { /* listener threw - keep going */ } }
      this.dispatchEvent(event);
    }
    send(data) {
      let msg = null; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === "join") { this._deliver('{"type":"session","directView":true}'); return; }
      if (msg.type === "ping") {
        const echo = { type: "pong", t0: msg.t0 };
        if (msg.mainThread) echo.mainThread = true;
        this._deliver(JSON.stringify(echo));
      }
    }
    close() { this._closed = true; this.readyState = 3; this._emit("close", new CloseEvent("close")); }
  }
  window.WebSocket = ProbeWebSocket;
}

// ---------------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------------

const replayText = readFileSync(recordingPath, "utf8");
requireReproHeader(replayText, recordingPath);
const hasDirectView = replayText.includes('"directView":true');

// `--disable-gpu` keeps raster deterministic (software tiles); raster-scale selection is the same cc code path.
// `--force-device-scale-factor` is the trap-2 fix: without it cc never sees the dsf (see the header).
const browser = await chromium.launch({ args: ["--disable-gpu", `--force-device-scale-factor=${args.dpr}`] });
const context = await browser.newContext({ viewport: args.viewport, deviceScaleFactor: args.dpr });
await context.route("**/__probe_recording", (route) =>
  route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: replayText })
);
if (args.bg) {
  const bgBytes = readFileSync(args.bg);
  await context.route("**/bg/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: bgBytes }));
}
await context.addInitScript(fakeWebSocketInit, {
  recordingUrl: "/__probe_recording",
  synthesizeDirectView: !hasDirectView
});
if (args.css) {
  await context.addInitScript((css) => {
    const install = () => {
      const style = document.createElement("style");
      style.id = "__probe_stage_raster_css";
      style.textContent = css;
      document.head.appendChild(style);
    };
    if (document.head) install();
    else document.addEventListener("DOMContentLoaded", install);
  }, args.css);
}

const page = await context.newPage();
const pageUrl = `${args.url}/?quality=high${args.query ? `&${args.query}` : ""}`;
await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll(".mirror-node").length > 50, null, { timeout: 60000 });
await page.waitForFunction(() => window.__probeDone === true, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(args.settleMs);

const geometry = await page.evaluate(() => {
  const stage = document.querySelector(".mirror-stage");
  const frame = document.querySelector(".mirror-frame");
  if (!stage || !frame) return null;
  const cs = getComputedStyle(stage);
  const rect = stage.getBoundingClientRect();
  const bg = document.querySelector('[data-testid="mirror-static-bg-image"]');
  const bgRect = bg?.getBoundingClientRect();
  return {
    dpr: devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    design: [parseFloat(cs.width), parseFloat(cs.height)],
    presented: [Math.round(rect.width), Math.round(rect.height)],
    transform: cs.transform,
    overflow: cs.overflow,
    clipPath: cs.clipPath,
    contain: cs.contain,
    stageScroll: [stage.scrollWidth, stage.scrollHeight],
    nodes: document.querySelectorAll(".mirror-node").length,
    staticBg: bgRect ? [Math.round(bgRect.left), Math.round(bgRect.top), Math.round(bgRect.width), Math.round(bgRect.height)] : null
  };
});

// cc only emits its layer-tree object snapshots while it is producing frames, and a settled page produces none -
// so nudge the viewport (this is also what leaves the stale tilings trap 4 filters out).
const cdp = await context.newCDPSession(page);
const traceEvents = [];
cdp.on("Tracing.dataCollected", (e) => { if (Array.isArray(e.value)) traceEvents.push(...e.value); });
await cdp.send("Tracing.start", {
  traceConfig: {
    includedCategories: ["cc", "disabled-by-default-cc.debug"],
    excludedCategories: ["*"],
    recordMode: "recordContinuously"
  },
  transferMode: "ReportEvents"
});
await page.setViewportSize({ width: args.viewport.width + 2, height: args.viewport.height + 1 });
await page.waitForTimeout(2000);
await page.setViewportSize(args.viewport);
await page.waitForTimeout(3000);
const traced = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
await cdp.send("Tracing.end");
await traced;

if (args.shot) {
  mkdirSync(dirname(args.shot), { recursive: true });
  await page.screenshot({ path: args.shot });
}
await browser.close();

// ---------------------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------------------

let best = null;
let bestDrawing = 0;
for (const ev of traceEvents) {
  const tree = ev?.name === "cc::LayerTreeHostImpl" ? ev.args?.snapshot?.active_tree : null;
  if (!tree?.layers) continue;
  const drawing = tree.layers.filter((l) => l.draws_content).length;
  if (drawing > bestDrawing) { bestDrawing = drawing; best = tree; }
}
if (!best) {
  console.error("no cc::LayerTreeHostImpl snapshot in the trace - is `disabled-by-default-cc.debug` available?");
  process.exit(2);
}

let tiles = 0;
let tiledPx = 0;
let staleTilings = 0;
const rows = [];
for (const layer of best.layers) {
  const rasterScale = layer.raster_scales?.contents_scale?.[0] ?? null;
  const ideal = layer.ideal_contents_scale ?? null;
  const tilings = layer.tilings ?? [];
  let picked = null;
  if (tilings.length) {
    staleTilings += tilings.length - 1;
    picked = rasterScale == null
      ? tilings[0]
      : tilings.reduce((a, b) => (Math.abs((b.content_scale ?? 0) - rasterScale) < Math.abs((a.content_scale ?? 0) - rasterScale) ? b : a), tilings[0]);
    tiles += picked.num_tiles ?? 0;
    if (picked.tiling_rect) tiledPx += picked.tiling_rect[2] * picked.tiling_rect[3];
  }
  rows.push({
    // FULL name, never truncated: cc's names are long ("LayoutBlockFlow (relative positioned, children-inline)
    // DIV class='mirror-stage'") and the interesting part — the class — is at the END, so truncating here would
    // silently break the `.mirror-stage` lookup below (and every grep of the JSON). Truncation is print-only.
    name: layer.layer_name ?? "",
    bounds: [layer.bounds?.width ?? 0, layer.bounds?.height ?? 0],
    draws: !!layer.draws_content,
    rasterScale,
    ideal,
    // A raster scale ABOVE the ideal (screen-space) scale is the "raster scale is pinned" failure: the layer
    // rasters more pixels than it presents. Below-ideal is the opposite (blurry) and is also worth seeing.
    pinned: rasterScale != null && ideal != null && ideal > 0 && rasterScale > ideal * 1.05,
    tiles: picked?.num_tiles ?? 0,
    tiling: picked?.tiling_rect ? [picked.tiling_rect[2], picked.tiling_rect[3]] : null,
    visible: picked?.visible_rect ?? null,
    gpuBytes: layer.gpu_memory_usage ?? 0,
    reasons: layer.compositing_reasons ?? []
  });
}
rows.sort((a, b) => b.tiles - a.tiles || b.gpuBytes - a.gpuBytes);

const stage = rows.find((r) => /mirror-stage/.test(r.name)) ?? null;
const pinned = rows.filter((r) => r.pinned);
const presentedPx = (geometry?.presented?.[0] ?? 0) * (geometry?.presented?.[1] ?? 0) * args.dpr * args.dpr;

const report = {
  pageUrl,
  recording: recordingPath,
  viewport: args.viewport,
  dpr: args.dpr,
  css: args.css,
  geometry,
  layers: best.layers.length,
  drawingLayers: bestDrawing,
  tiles,
  tiledMpx: +(tiledPx / 1e6).toFixed(3),
  presentedMpx: +(presentedPx / 1e6).toFixed(3),
  staleTilingsDropped: staleTilings,
  pinnedLayers: pinned.length,
  stage,
  rows
};
if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 1));
}

const fmt = (n) => String(n).padStart(5);
console.log(`\n${pageUrl}`);
if (geometry) {
  console.log(
    `  design ${geometry.design.join("x")} -> presented ${geometry.presented.join("x")} CSS px @dpr ${args.dpr}` +
      `   ${geometry.transform}   overflow=${geometry.overflow} clip-path=${geometry.clipPath} contain=${geometry.contain}`
  );
  console.log(`  mirror nodes ${geometry.nodes}   static bg ${geometry.staticBg ? geometry.staticBg.join(",") : "NOT SHOWN (see --bg)"}`);
}
console.log(
  `  layers ${best.layers.length} (${bestDrawing} drawing)   tiles ${tiles}   tiled ${(tiledPx / 1e6).toFixed(2)} Mpx` +
    `   screen ${(presentedPx / 1e6).toFixed(2)} Mpx   ratio ${(tiledPx / Math.max(1, presentedPx)).toFixed(2)}x` +
    `   staleTilingsDropped ${staleTilings}   PINNED ${pinned.length}`
);
if (stage) {
  console.log(
    `  .mirror-stage: bounds ${stage.bounds.join("x")} draws=${stage.draws} rasterScale=${stage.rasterScale} ideal=${stage.ideal}` +
      ` tiles=${stage.tiles} tiling=${stage.tiling ? stage.tiling.join("x") : "-"}\n      reasons: ${stage.reasons.join("; ")}`
  );
}
console.log("\n  tiles   gpuKB  bounds          rasterScale/ideal   tiling        layer / compositing reasons");
for (const r of rows.slice(0, args.top)) {
  console.log(
    `  ${fmt(r.tiles)} ${String(Math.round(r.gpuBytes / 1024)).padStart(7)}  ${(r.bounds.join("x")).padEnd(13)} ` +
      `${String(r.rasterScale).padStart(8)}/${String(r.ideal).padEnd(8)} ${(r.tiling ? r.tiling.join("x") : "-").padEnd(12)} ${r.name.slice(-72)}` +
      (r.pinned ? "  <<< PINNED" : "") +
      `\n${" ".repeat(8)}${r.reasons.join("; ") || "(no reason listed - could not merge with the preceding layer, i.e. overlap)"}`
  );
}

if (args.assertFolded && pinned.length > 0) {
  console.error(`\nFAIL: ${pinned.length} layer(s) raster above their ideal contents scale`);
  process.exit(1);
}
