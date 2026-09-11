#!/usr/bin/env node
// PROBE — "is a parked canvas stage's last synchronous paint actually PRESENTED?" (defect 4, Aug-26 2026)
//
// The canvas backend paints SYNCHRONOUSLY at the end of `reconcile` (that is what makes the scene ack honest),
// and when nothing is animating it books NO rAF at all (`tweenLoop` parks at nextDeadline=Infinity). The gsw
// stage runs with `preserveDrawingBuffer: false`. The open question the parity gates left behind is whether the
// LAST such paint on a fully-parked page reaches the screen — `audit-shop-open` screenshots as the room looked
// BEFORE the inventory opened, with a correct DOM overlay on top of it.
//
// This script runs the decisive experiment, on ONE page, in this order:
//
//   S1  park, then capture (untouched)
//   S1b capture AGAIN with nothing else changed        — control: does capturing repair it?
//   D   page-side readback of the canvas + stats       — diagnostics only, taken after S1/S1b
//   S2  force a REAL backing-store resize, capture     — the nudge must change round(w*scale*dpr); a 1px
//                                                        window nudge can round away (renderer `resize()`
//                                                        early-returns when the rounded size is unchanged)
//   S3  restore the original viewport, capture         — same dimensions as S1, so S1/S3 diff exactly
//
// Run it once per arm (`--stage canvas`, `--stage dom`); the DOM arm's S1 is the ground truth the canvas arm's
// frames are read against.
//
// REAL GPU IS MANDATORY. Playwright's default headless chromium rasterizes WebGL on SwiftShader; presentation
// timing is exactly the kind of thing a software path can get right (or wrong) for reasons no device shares.
// `--gpu` launches `channel: "chromium"` with the Vulkan ANGLE backend, which on this box binds the real GPU.
// The script PRINTS the resolved WebGL renderer string and refuses to pretend: check it in the output.
//
// Assets: `--res-root` serves `/res/**` from a game project on disk exactly as bench-mirror-replay.mjs does, so
// no live game is required. The shop screen carries ZERO fillColor content — every pixel on it is a texture —
// so an asset-less run of this probe proves nothing at all. `resHits` is printed; if it is 0, stop.
//
// The in-page fake WebSocket is not re-implemented here: its source is EXTRACTED VERBATIM from
// scripts/bench-mirror-replay.mjs at run time, so this probe replays a recording through the same wire model the
// bench does and cannot drift from it.
//
// Usage:
//   cd frontend && npx vite --host 127.0.0.1 --port 5185       # the code under test
//   node scripts/probe-canvas-parked-present.mjs --url http://127.0.0.1:5185 \
//     --recording .sts2/bench/audit-shop-open.ndjson --stage canvas --gpu \
//     --res-root --out .sts2/artifacts/defect4/shop-canvas
//
// Writes <out>-s1.png, <out>-s1b.png, <out>-s2.png, <out>-s3.png and <out>.json (stats at every step).

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { dirname, resolve } from "node:path";
import { RECOVERED_RESOURCE_ROOT, REPO_ROOT } from "./lib/repo-layout.mjs";

const require = createRequire(resolve(REPO_ROOT, "frontend/package.json"));
const { chromium } = require("@playwright/test");

const DEFAULT_RES_ROOT = RECOVERED_RESOURCE_ROOT;
const RES_CONTENT_TYPES = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  gdshader: "text/plain",
  tres: "text/plain",
  json: "application/json"
};

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------

const args = {
  url: "http://127.0.0.1:5185",
  recording: ".sts2/bench/audit-shop-open.ndjson",
  stage: "canvas",
  viewport: { width: 1920, height: 1080 },
  nudge: { width: 1856, height: 1044 },
  out: ".sts2/artifacts/defect4/run",
  resRoot: null,
  // `--fake-bg <png>`: answer the STATIC BACKGROUND route (`/bg/<id>?frame=<n>`, served by the game host and by
  // nothing else) with a picture, so a hostless replay can still exercise the layer that only exists when a
  // real host is up. Defect 4's round-1 screenshot shows a merchant room that appears NOWHERE in the settled
  // draw list, and this is the only other thing on the page that can paint one.
  fakeBg: null,
  gpu: false,
  launchArgs: [],
  query: "",
  parkMs: 2500,
  settleMs: 800,
  cpuThrottle: 1
};

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  const eq = arg.indexOf("=");
  const [key, inline] = eq > 0 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
  const val = () => inline ?? process.argv[++i];
  switch (key) {
    case "--url": args.url = val(); break;
    case "--recording": args.recording = val(); break;
    case "--stage": args.stage = val(); break;
    case "--out": args.out = val(); break;
    case "--gpu": args.gpu = true; break;
    case "--fake-bg": args.fakeBg = resolve(val()); break;
    // Repeatable. `--launch-arg --disable-gpu` reproduces bench-mirror-replay's own `--effects off` launch, i.e.
    // the SOFTWARE (SwiftShader) rasterizer the M1 baselines were taken on.
    case "--launch-arg": args.launchArgs.push(String(val())); break;
    case "--query": args.query = String(val()).replace(/^[?&]/, ""); break;
    case "--park-ms": args.parkMs = Number(val()); break;
    // Held for the WHOLE run, captures included: a starved main thread (and with it a starved compositor) is the
    // condition the M1 baselines were taken under, and it is the one a stale presented frame would need.
    case "--cpu-throttle": args.cpuThrottle = Number(val()); break;
    case "--settle-ms": args.settleMs = Number(val()); break;
    case "--viewport": {
      const [w, h] = String(val()).split("x").map(Number);
      args.viewport = { width: w, height: h };
      break;
    }
    case "--nudge": {
      const [w, h] = String(val()).split("x").map(Number);
      args.nudge = { width: w, height: h };
      break;
    }
    case "--res-root": {
      const next = process.argv[i + 1];
      args.resRoot = inline ?? (next != null && !next.startsWith("--") ? process.argv[++i] : DEFAULT_RES_ROOT);
      break;
    }
    default:
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
  }
}

const recordingPath = resolve(REPO_ROOT, args.recording);
const recordingText = readFileSync(recordingPath, "utf8");
requireReproHeader(recordingText, recordingPath);
let hasRecordedDirectView = false;
for (const line of recordingText.split("\n")) {
  if (line.includes('"directView":true')) {
    hasRecordedDirectView = true;
    break;
  }
}

const outPath = resolve(REPO_ROOT, args.out);
mkdirSync(dirname(outPath), { recursive: true });

// ---------------------------------------------------------------------------------------------------------
// the fake socket, verbatim from the bench
// ---------------------------------------------------------------------------------------------------------

function benchFakeSocketSource() {
  const benchSource = readFileSync(resolve(REPO_ROOT, "scripts/bench-mirror-replay.mjs"), "utf8");
  const lines = benchSource.split("\n");
  const start = lines.findIndex((l) => l.startsWith("function fakeWebSocketInit(config) {"));
  if (start < 0) {
    throw new Error("bench-mirror-replay.mjs: fakeWebSocketInit not found — the probe's replay wire is gone");
  }
  // Top-level function: its closing brace is the next line that is exactly "}".
  const end = lines.findIndex((l, idx) => idx > start && l === "}");
  if (end < 0) {
    throw new Error("bench-mirror-replay.mjs: fakeWebSocketInit has no top-level close");
  }
  return lines.slice(start, end + 1).join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------------

const launchOptions = args.gpu
  ? {
      headless: true,
      channel: "chromium",
      args: ["--use-angle=vulkan", "--enable-features=Vulkan", ...args.launchArgs]
    }
  : { headless: true, args: [...args.launchArgs] };

const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({
  viewport: { ...args.viewport },
  deviceScaleFactor: 1
});

let resHits = 0;
const resMisses = new Set();

await context.route("**/__bench/recording", (route) =>
  route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: recordingText })
);
if (args.resRoot) {
  await context.route("**/res/**", (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/res\//, ""));
    try {
      const body = readFileSync(resolve(args.resRoot, rel));
      resHits += 1;
      const ext = rel.split(".").pop()?.toLowerCase() ?? "";
      route.fulfill({ status: 200, contentType: RES_CONTENT_TYPES[ext] ?? "application/octet-stream", body });
    } catch {
      resMisses.add(rel);
      route.fulfill({ status: 404, body: "" });
    }
  });
}

let bgHits = 0;
if (args.fakeBg) {
  await context.route("**/bg/**", (route) => {
    bgHits += 1;
    route.fulfill({ status: 200, contentType: "image/png", body: readFileSync(args.fakeBg) });
  });
}

const config = {
  recordingUrl: "/__bench/recording",
  pace: "recorded",
  ackPacedMs: 0,
  dropCardFlights: false,
  synthesizeDirectView: !hasRecordedDirectView,
  window: null
};
await context.addInitScript({
  content: `${benchFakeSocketSource()}\n;(${"fakeWebSocketInit"})(${JSON.stringify(config)});`
});

const params = new URLSearchParams("quality=high&shaders=off&particles=off&paintDump=1");
if (args.stage === "canvas") {
  params.set("stage", "canvas");
}
for (const [k, v] of new URLSearchParams(args.query)) {
  params.set(k, v);
}
const pageUrl = `${args.url.replace(/\/$/, "")}/?${params.toString()}`;

const page = await context.newPage();
const cdp = await context.newCDPSession(page);

const gpuInfo = await (async () => {
  await page.goto("about:blank");
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return { webgl2: false };
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      webgl2: true,
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      software: /swiftshader|llvmpipe|software/i.test(
        String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      )
    };
  });
})();

console.log(`probe-canvas-parked-present`);
console.log(`  url:       ${pageUrl}`);
console.log(`  recording: ${recordingPath}`);
console.log(`  gpu:       ${gpuInfo.renderer ?? "NO WEBGL2"}${gpuInfo.software ? "   *** SOFTWARE — NOT A VERDICT ***" : ""}`);
console.log(`  viewport:  ${args.viewport.width}x${args.viewport.height} -> nudge ${args.nudge.width}x${args.nudge.height}`);

if (args.cpuThrottle > 1) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: args.cpuThrottle });
  console.log(`  cpu:       throttled ${args.cpuThrottle}x (held through every capture)`);
}

await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

// The same readiness gate the bench uses: either backend's evidence of a rendered keyframe.
await page.waitForFunction(
  () => {
    if (document.querySelectorAll(".mirror-node").length > 50) return true;
    const read = window.__mirrorCanvasStats;
    if (typeof read !== "function") return false;
    const stats = read();
    return stats.frames > 0 && stats.quads > 50;
  },
  null,
  { timeout: 120_000 }
);

try {
  await page.waitForFunction(() => window.__benchDone === true, null, { timeout: 180_000 });
} catch {
  const err = await page.evaluate(() => window.__benchWsError ?? null);
  console.error(`  stream did not finish (fake WS error: ${err ?? "none"})`);
}
await page.waitForTimeout(args.settleMs);

const readStats = () =>
  page.evaluate(() => {
    const read = window.__mirrorCanvasStats;
    const stats = typeof read === "function" ? read() : null;
    return {
      at: performance.now(),
      canvas: stats,
      mirrorNodes: document.querySelectorAll(".mirror-node").length,
      overlayNodes: document.querySelectorAll(".mirror-overlay-node").length
    };
  });

// --- park: hold until the renderer stops painting entirely -------------------------------------------------
const parkSamples = [];
{
  const deadline = Date.now() + 20_000;
  let last = await readStats();
  parkSamples.push(last);
  for (;;) {
    await page.waitForTimeout(args.parkMs);
    const now = await readStats();
    parkSamples.push(now);
    const framesStill = !now.canvas || now.canvas.frames === last.canvas?.frames;
    const animStill = !now.canvas || (now.canvas.animActive === 0 && now.canvas.animFrames === last.canvas?.animFrames);
    if ((framesStill && animStill) || Date.now() > deadline) break;
    last = now;
  }
}

const shot = async (label) => {
  const file = `${outPath}-${label}.png`;
  const res = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  writeFileSync(file, Buffer.from(res.data, "base64"));
  return file;
};

const steps = [];
const note = async (label, file, extra = {}) => {
  const stats = await readStats();
  steps.push({ label, file, stats, ...extra });
  const c = stats.canvas;
  console.log(
    `  ${label.padEnd(4)} ${file}` +
      (c ? `   frames=${c.frames} anim=${c.animFrames}/${c.animActive} backing=${c.backingStore} lost=${c.contextLost}` : "")
  );
};

const s1 = await shot("s1");
await note("s1", s1);

const s1b = await shot("s1b");
await note("s1b", s1b);

// Diagnostics AFTER the two pristine captures: a readback of what the stage canvas itself holds, plus the
// draw-list size. `drawImage` copies the canvas's current image without asking the renderer to repaint.
const readback = await page.evaluate(() => {
  const canvases = Array.from(document.querySelectorAll("canvas"));
  const out = [];
  for (const source of canvases) {
    const w = source.width;
    const h = source.height;
    if (w <= 0 || h <= 0) continue;
    const scratch = document.createElement("canvas");
    const sw = Math.min(320, w);
    const sh = Math.max(1, Math.round((h / w) * sw));
    scratch.width = sw;
    scratch.height = sh;
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) continue;
    ctx.clearRect(0, 0, sw, sh);
    try {
      ctx.drawImage(source, 0, 0, sw, sh);
    } catch {
      out.push({ className: source.className, w, h, error: "drawImage threw" });
      continue;
    }
    const data = ctx.getImageData(0, 0, sw, sh).data;
    let opaque = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 8) opaque++;
      sum += data[i] + data[i + 1] + data[i + 2];
    }
    out.push({
      className: source.className || "(no class)",
      w,
      h,
      sampled: sw * sh,
      nonTransparent: opaque,
      meanRgb: Math.round(sum / (sw * sh * 3))
    });
  }
  const dump = typeof window.__mirrorDrawListDump === "function" ? window.__mirrorDrawListDump() : null;
  return {
    canvases: out,
    drawListLines: dump ? dump.length : null,
    drawListHead: dump ? dump.slice(0, 12) : null
  };
});

// --- S2: a REAL backing-store resize ------------------------------------------------------------------------
await page.setViewportSize({ ...args.nudge });
await page.waitForTimeout(600);
const s2 = await shot("s2");
await note("s2", s2, { viewport: { ...args.nudge } });

// --- S3: back to the original size, so S1 and S3 are pixel-comparable ---------------------------------------
await page.setViewportSize({ ...args.viewport });
await page.waitForTimeout(600);
const s3 = await shot("s3");
await note("s3", s3, { viewport: { ...args.viewport } });

const summary = {
  probe: "canvas-parked-present",
  when: new Date().toISOString(),
  url: pageUrl,
  stage: args.stage,
  recording: recordingPath,
  gpu: gpuInfo,
  viewport: args.viewport,
  nudge: args.nudge,
  resRoot: args.resRoot,
  fakeBg: args.fakeBg,
  bgHits,
  resHits,
  resMisses: [...resMisses].slice(0, 40),
  resMissCount: resMisses.size,
  parkSamples,
  readback,
  steps
};
writeFileSync(`${outPath}.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`  res-root:  ${resHits} served, ${resMisses.size} missing${args.fakeBg ? `   /bg/ requests answered: ${bgHits}` : ""}`);
console.log(`  summary:   ${outPath}.json`);

await page.close();
await context.close();
await browser.close();
