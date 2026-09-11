#!/usr/bin/env node
// Particle-VFX visual probe — replays a RECORDED mirror stream into the real mirror page, stops it at a chosen
// moment of a burst, and screenshots the particle system. No live game, no live lock. Sibling of
// scripts/probe-card-trail-replay.mjs; it exists for the same reason (the thing under test has to be judged by
// eye, and a live-game session per attempt is far too expensive), plus two traps that make a naive replay lie:
//
//   1. `/res/**` — vite dev PROXIES it to the game. With no game the textures 404, every particle falls back to
//      gsw's procedural soft dot, and a broken system looks FINE. This probe serves `/res/**` from the local
//      extracted resource root on disk (`--res-root`) via a Playwright route, so the real sheets are decoded.
//   2. Recordings predate the shader-ramp wire fields — no `gradientStops` / `curvePoints` on their shader
//      params, so a replay of an old capture does NOT reproduce the SHIPPED appearance. `--inject` reads the
//      material `.tres` from that same resource root and patches the resolved ramps back onto the recorded nodes.
//
//   # dev server serving the code under test:
//   cd frontend && npx vite --port 5199 --strictPort            # (or --config <scratch> to point at a gsw worktree)
//   # then, e.g. the combat energy-count orb, static particles, AFTER the fix:
//   node scripts/probe-particle-vfx-replay.mjs \
//     --url http://127.0.0.1:5199 \
//     --recording .sts2/bench/b3-pool-recycle.ndjson --at 3000 --inject \
//     --focus vfx_common_glow \
//     --out .sts2/artifacts/particle-vfx/orb-static-after.png
//   # ...and the BEFORE leg is the same command plus `--query particleCoverage=off`.
//
// `--at` is the recorded-stream timestamp (ms) to stop at; the fake socket delivers at RECORDED pace up to it.
// `--query` appends to the page URL (`particleCoverage=off`, `particles=dynamic`, …).
// `--focus <substring>` also writes a CROP around the matching node's particle canvas (`<out>` + `-crop.png`) —
// a 1920x1080 frame is useless evidence for a 128px sprite.
//
// STATIC particles (the shipped default) are the easy case: the runtime warms every system to a representative
// mid-flight frame and parks, so any `--settle` shows the art. `particles=dynamic` is a moving target — a
// one-shot burst is alive for a few hundred ms and the replay itself lags (13s of combat through SwiftShader),
// so the burst's window sits some way AFTER the stop. The recipe that works: stop just after the delta that
// TRIGGERS the burst and give it a long settle (e.g. `--at 13040 --settle 4000`), then read `systems[].paint`
// in the JSON to confirm the frame you photographed actually had pixels.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { RECOVERED_RESOURCE_ROOT, REPO_ROOT } from "./lib/repo-layout.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const DEFAULT_RES_ROOT = RECOVERED_RESOURCE_ROOT;
// These two paths were missing in the baseline replay. Keep them named in every report; an empty canvas must not
// disguise either a synthetic GradientTexture or an unresolved atlas sprite as particle coverage.
const REQUIRED_COVERAGE_RESOURCES = [
  "scenes/game.tscn::GradientTexture2D_5newe",
  "images/atlases/intent_atlas.sprites/attack/intent_attack_3.tres"
];

function parseArgs(argv) {
  const a = {
    url: "http://127.0.0.1:5199",
    recording: ".sts2/bench/b3-pool-recycle.ndjson",
    at: 3000,
    out: ".sts2/artifacts/particle-vfx/probe.png",
    query: "",
    width: 1920,
    height: 1080,
    settleMs: 600,
    resRoot: DEFAULT_RES_ROOT,
    inject: false,
    focus: "",
    pad: 140,
    captures: 3,
    assetFixtures: "",
    // Hold the last drawn frame for every observation below (see the freeze block). `--freeze=false` restores
    // the live-page behaviour.
    freeze: true
  };
  for (let i = 2; i < argv.length; i++) {
    const [k, inline] = argv[i].split("=");
    const next = () => (inline !== undefined ? inline : argv[++i]);
    if (k === "--url") a.url = next();
    else if (k === "--recording") a.recording = next();
    else if (k === "--at") a.at = Number(next());
    else if (k === "--out") a.out = next();
    else if (k === "--query") a.query = next();
    else if (k === "--width") a.width = Number(next());
    else if (k === "--height") a.height = Number(next());
    else if (k === "--settle") a.settleMs = Number(next());
    else if (k === "--res-root") a.resRoot = next();
    else if (k === "--inject") a.inject = inline === undefined ? true : inline !== "false";
    else if (k === "--focus") a.focus = next();
    else if (k === "--pad") a.pad = Number(next());
    else if (k === "--captures") a.captures = Number(next());
    else if (k === "--asset-fixtures") a.assetFixtures = next();
    else if (k === "--freeze") a.freeze = inline === undefined ? true : inline !== "false";
    else if (k === "--help" || k === "-h") {
      printUsage(a);
      process.exit(0);
    } else {
      // A typo must not silently run a full probe pass (dev server + Chromium + replay).
      console.error(`Unknown argument: ${argv[i]}`);
      printUsage(a);
      process.exit(2);
    }
  }
  return a;
}

function printUsage(defaults) {
  console.log(`probe-particle-vfx-replay.mjs — replay a recorded mirror stream, stop mid-burst, screenshot the particles
(the full recipe, including the two replay traps this probe exists for, is in the header comment of this file)

  --url <origin>       dev server serving the code under test (default ${defaults.url})
  --recording <path>   NDJSON mirror recording (default ${defaults.recording})
  --at <ms>            recorded-stream timestamp to stop at (default ${defaults.at})
  --settle <ms>        wait after the stop before observing (default ${defaults.settleMs})
  --out <path>         screenshot output (default ${defaults.out})
  --focus <substring>  also write a crop around the matching node's particle canvas (<out>-crop.png)
  --pad <px>           crop padding around the focused canvas (default ${defaults.pad})
  --query <qs>         extra page-URL query (e.g. particleCoverage=off, particles=dynamic)
  --width/--height     viewport (default ${defaults.width}x${defaults.height})
  --res-root <dir>     serve /res/** from this resource root (default: the local extracted one)
  --inject[=false]     patch ramp samplers (gradientStops/curvePoints) from .tres onto recorded params
  --freeze[=false]     hold the last drawn frame for observation (default on)
  --captures <n>       repeated frozen full-frame captures (default ${defaults.captures}, minimum 2)
  --asset-fixtures <json> explicit local route fixtures for /res, /bg or /spines (never implicit)
  --help, -h           this text`);
}

// ---------------------------------------------------------------------------------------------------------
// Trap 2: `--inject` — resolve a material's PROCEDURAL ramp samplers from the .tres on disk and patch them onto
// the recorded shader params, exactly as today's producer would stream them (`gradientStops` /
// `gradientInterpolation` / `curvePoints`). Without this a pre-ramp recording replays as a DIFFERENT bug than
// the one that shipped (the energy orb's white-block regression only exists once its LUT is on the wire).
// ---------------------------------------------------------------------------------------------------------

function resPathToFile(resRoot, resourcePath) {
  const trimmed = resourcePath.startsWith("res://") ? resourcePath.slice(6) : resourcePath;
  return join(resRoot, trimmed);
}

const tresCache = new Map();
function readTres(resRoot, resourcePath) {
  if (tresCache.has(resourcePath)) return tresCache.get(resourcePath);
  const file = resPathToFile(resRoot, resourcePath);
  let text = null;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = null;
  }
  tresCache.set(resourcePath, text);
  return text;
}

// The body of `[sub_resource type="…" id="<id>"]` up to the next section header.
function subResourceBlock(tres, id) {
  const start = tres.indexOf(`id="${id}"]`);
  if (start < 0) return null;
  const rest = tres.slice(start);
  const end = rest.indexOf("\n[", 1);
  return end < 0 ? rest : rest.slice(0, end);
}

function floatsIn(text) {
  return (text.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
}

function toHtml(r, g, b, a) {
  const hex = (v) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`;
}

// A Gradient / GradientTexture1D sub-resource → the producer's {stops, interpolation} shape. Godot's DEFAULTS
// (an EMPTY `[sub_resource type="Gradient"]`, as the status blob's lut is) are black -> white, which for a
// grayscale sheet is the identity — so it is reported as such and the consumer may drop it.
function gradientFrom(tres, id) {
  let block = subResourceBlock(tres, id);
  if (!block) return null;
  const nested = /gradient = SubResource\("([^"]+)"\)/.exec(block);
  if (nested) {
    const inner = subResourceBlock(tres, nested[1]);
    if (!inner) return null;
    block = inner;
  }
  const offsetsMatch = /offsets = PackedFloat32Array\(([^)]*)\)/.exec(block);
  const colorsMatch = /colors = PackedColorArray\(([^)]*)\)/.exec(block);
  const offsets = offsetsMatch ? floatsIn(offsetsMatch[1]) : [0, 1];
  const channels = colorsMatch ? floatsIn(colorsMatch[1]) : [0, 0, 0, 1, 1, 1, 1, 1];
  const interpolationMatch = /interpolation_mode = (\d+)/.exec(block);
  const stops = offsets.map((offset, i) => {
    const [r, g, b, a] = channels.slice(i * 4, i * 4 + 4);
    return { offset, color: { r, g, b, a, html: toHtml(r, g, b, a) } };
  });
  return {
    stops,
    interpolation: interpolationMatch ? Number(interpolationMatch[1]) : 0
  };
}

// A Curve / CurveTexture sub-resource → the producer's `curvePoints` (the Vector2 point positions of `_data`).
function curveFrom(tres, id) {
  let block = subResourceBlock(tres, id);
  if (!block) return null;
  const nested = /curve = SubResource\("([^"]+)"\)/.exec(block);
  if (nested) {
    const inner = subResourceBlock(tres, nested[1]);
    if (!inner) return null;
    block = inner;
  }
  const points = [...block.matchAll(/Vector2\(([^)]*)\)/g)].map((m) => {
    const [x, y] = floatsIn(m[1]);
    return { x, y };
  });
  return points.length > 0 ? points : null;
}

// Patch one recorded upsert's shaderParameters in place. Returns true when anything changed.
function injectIntoNode(node, resRoot, stats) {
  const params = node.shaderParameters;
  if (!Array.isArray(params)) return false;
  let changed = false;
  for (const param of params) {
    const path = param?.resource?.resourcePath;
    if (typeof path !== "string" || !path.includes("::")) continue;
    const [tresPath, subId] = path.split("::");
    const tres = readTres(resRoot, tresPath);
    if (!tres) continue;
    if (param.gradientStops == null && subId.startsWith("Gradient")) {
      const gradient = gradientFrom(tres, subId);
      if (gradient) {
        param.gradientStops = gradient.stops;
        param.gradientInterpolation = gradient.interpolation;
        stats.gradients += 1;
        changed = true;
      }
    }
    if (param.curvePoints == null && subId.startsWith("Curve")) {
      const points = curveFrom(tres, subId);
      if (points) {
        param.curvePoints = points;
        stats.curves += 1;
        changed = true;
      }
    }
  }
  return changed;
}

// Transform the whole recording. Lines with no `::` sub-resource reference are passed through untouched (a cheap
// substring pre-filter — these files run to tens of MB).
function injectRecording(text, resRoot) {
  const stats = { gradients: 0, curves: 0, lines: 0 };
  const out = [];
  for (const line of text.split("\n")) {
    if (!line || !line.includes(".tres::")) {
      out.push(line);
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (typeof obj.data !== "string") {
      out.push(line);
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(obj.data);
    } catch {
      out.push(line);
      continue;
    }
    let changed = false;
    for (const node of msg.upserts ?? []) {
      changed = injectIntoNode(node, resRoot, stats) || changed;
    }
    if (!changed) {
      out.push(line);
      continue;
    }
    stats.lines += 1;
    obj.data = JSON.stringify(msg);
    out.push(JSON.stringify(obj));
  }
  return { text: out.join("\n"), stats };
}

// ---------------------------------------------------------------------------------------------------------
// The in-page fake socket (same contract as probe-card-trail-replay.mjs's).
// ---------------------------------------------------------------------------------------------------------
function fakeWebSocketInit(config) {
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
      this._msgs = [];
      this._i = 0;
      if (this.url.includes("/ws")) this._start();
    }
    async _start() {
      const res = await fetch(config.recordingUrl);
      const text = await res.text();
      for (const line of text.split("\n")) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.meta || typeof obj.data !== "string") continue;
        if (obj.data.includes('"type":"server-reload"')) continue;
        this._msgs.push({ t: typeof obj.t === "number" ? obj.t : 0, data: obj.data });
      }
      this.readyState = OPEN;
      this._emit("open", new Event("open"));
      this._deliver('{"type":"session","directView":true}');
      const t0 = performance.now();
      const tick = () => {
        const now = performance.now() - t0;
        while (this._i < this._msgs.length && this._msgs[this._i].t <= now) {
          if (this._msgs[this._i].t > config.stopAtT) {
            window.__probeStopped = this._msgs[this._i].t;
            return;
          }
          this._deliver(this._msgs[this._i].data);
          this._i++;
        }
        if (this._i < this._msgs.length) {
          setTimeout(tick, Math.max(0, this._msgs[this._i].t - (performance.now() - t0)));
        } else {
          window.__probeStopped = -1; // ran out of stream before the stop point
        }
      };
      tick();
    }
    _deliver(data) { this._emit("message", new MessageEvent("message", { data })); }
    _emit(type, event) {
      const h = this["on" + type];
      if (typeof h === "function") { try { h.call(this, event); } catch { /* keep going */ } }
      this.dispatchEvent(event);
    }
    send(data) {
      let msg = null;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg && msg.type === "join") this._deliver('{"type":"session","directView":true}');
      else if (msg && msg.type === "ping") this._deliver(JSON.stringify({ type: "pong", t0: msg.t0 }));
    }
    close() { this.readyState = 3; this._emit("close", new CloseEvent("close")); }
  }
  window.WebSocket = ProbeWebSocket;
}

const CONTENT_TYPES = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  gdshader: "text/plain",
  tres: "text/plain",
  json: "application/json"
};

const args = parseArgs(process.argv);
if (!Number.isInteger(args.captures) || args.captures < 2) {
  throw new Error("--captures must be an integer of at least 2 so frozen evidence is repeatable");
}
const recordingPath = resolve(REPO_ROOT, args.recording);
let recordingText = readFileSync(recordingPath, "utf8"); // fail fast with a clear ENOENT
requireReproHeader(recordingText, recordingPath);
let injectStats = null;
if (args.inject) {
  if (!existsSync(args.resRoot)) {
    throw new Error(`--inject needs an extracted resource root at --res-root (${args.resRoot})`);
  }
  const injected = injectRecording(recordingText, args.resRoot);
  recordingText = injected.text;
  injectStats = injected.stats;
}
const outPath = resolve(REPO_ROOT, args.out);
mkdirSync(dirname(outPath), { recursive: true });
const cropPath = outPath.replace(/\.png$/, "-crop.png");
const frozenCapturePath = (index) => index === 0 ? outPath : outPath.replace(/\.png$/, `-frozen-${index + 1}.png`);
const fixtureManifestPath = args.assetFixtures ? resolve(REPO_ROOT, args.assetFixtures) : null;
let fixtureManifest = { routes: {} };
if (fixtureManifestPath) {
  const parsed = JSON.parse(readFileSync(fixtureManifestPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || !parsed.routes || typeof parsed.routes !== "object") {
    throw new Error("--asset-fixtures must be JSON with a routes object");
  }
  fixtureManifest = parsed;
}
const fixtureRoute = (routePath) => {
  const entry = fixtureManifest.routes[routePath];
  if (!entry) return null;
  if (typeof entry.file !== "string" || typeof entry.source !== "string" || !entry.source) {
    throw new Error(`asset fixture ${routePath} must declare both file and non-empty source provenance`);
  }
  const file = resolve(dirname(fixtureManifestPath), entry.file);
  return { file, source: entry.source, present: existsSync(file) };
};

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader"] });
const context = await browser.newContext({ viewport: { width: args.width, height: args.height } });

await context.route("**/__probe_recording", (route) =>
  route.fulfill({ status: 200, contentType: "text/plain", body: recordingText })
);

// Trap 1: serve `/res/**` from the extracted resource root instead of proxying to a game that isn't running.
const resMisses = new Set();
let resHits = 0;
const assetRequests = { res: [], bg: [], spines: [] };
const assetResponses = { bg: [], spines: [] };
const assetFailures = { bg: [], spines: [] };
const assetSubstitutions = { res: [], bg: [], spines: [] };
const assetKind = (url) => {
  const path = new URL(url).pathname;
  if (path.startsWith("/res/")) return "res";
  if (path.startsWith("/bg/")) return "bg";
  if (path.startsWith("/spines/")) return "spines";
  return null;
};
await context.route("**/res/**", async (route) => {
  const url = new URL(route.request().url());
  const rel = decodeURIComponent(url.pathname.replace(/^\/res\//, ""));
  const routePath = url.pathname + url.search;
  assetRequests.res.push(routePath);
  const substitute = fixtureRoute(routePath);
  if (substitute) {
    assetSubstitutions.res.push({ url: routePath, ...substitute });
    if (substitute.present) {
      await route.fulfill({ status: 200, contentType: CONTENT_TYPES[substitute.file.split(".").pop()?.toLowerCase()] ?? "application/octet-stream", body: readFileSync(substitute.file) });
      resHits += 1;
    } else {
      resMisses.add(rel);
      await route.fulfill({ status: 404, body: "" });
    }
    return;
  }
  const file = join(args.resRoot, rel);
  try {
    const body = readFileSync(file);
    resHits += 1;
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    await route.fulfill({ status: 200, contentType: CONTENT_TYPES[ext] ?? "application/octet-stream", body });
  } catch {
    resMisses.add(rel);
    await route.fulfill({ status: 404, body: "" });
  }
});
// `/bg/` and `/spines/` are host-rendered production routes. Deliberately do NOT substitute fixture bytes for
// either: pass them through and report every request/result, including a dev-server 404.
const passThroughHostAsset = async (route) => {
  const kind = assetKind(route.request().url());
  const url = new URL(route.request().url());
  const routePath = url.pathname + url.search;
  if (kind) assetRequests[kind].push(routePath);
  const substitute = fixtureRoute(routePath);
  if (kind && substitute) {
    assetSubstitutions[kind].push({ url: routePath, ...substitute });
    if (substitute.present) {
      await route.fulfill({ status: 200, contentType: CONTENT_TYPES[url.pathname.split(".").pop()?.toLowerCase()] ?? "application/octet-stream", body: readFileSync(substitute.file) });
    } else {
      await route.fulfill({ status: 404, body: "" });
    }
    return;
  }
  await route.continue();
};
await context.route("**/bg/**", passThroughHostAsset);
await context.route("**/spines/**", passThroughHostAsset);

// Trap 3: gsw REFUSES to create its shared WebGL context on a software renderer (SOFTWARE_RENDERER_RE in
// shared-gl.ts) — and headless Chromium only has SwiftShader. Without this escape hatch the particle runtime is
// never created, no canvas is mounted, and the probe screenshots an empty stage while reporting success.
await context.addInitScript(() => {
  globalThis.__gswForceWebglShaders = true;
});
await context.addInitScript(fakeWebSocketInit, {
  recordingUrl: "/__probe_recording",
  stopAtT: args.at
});

const page = await context.newPage();
page.on("response", (response) => {
  const kind = assetKind(response.url());
  if (kind === "bg" || kind === "spines") assetResponses[kind].push({ url: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status() });
});
page.on("requestfailed", (request) => {
  const kind = assetKind(request.url());
  if (kind === "bg" || kind === "spines") assetFailures[kind].push({ url: new URL(request.url()).pathname + new URL(request.url()).search, error: request.failure()?.errorText ?? "unknown" });
});
const pageUrl = `${args.url.replace(/\/$/, "")}/${args.query ? `?${args.query}` : ""}`;
await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.readyState === "complete", null, { timeout: 60000 });
await page.waitForFunction(() => window.__probeStopped !== undefined, null, { timeout: 60000 });
await page.waitForTimeout(args.settleMs);

// Readiness is an evidence gate, not a best-effort delay: freeze only after the page finished loading, requested
// fixture bytes settled, every visible image decoded (or reported its failure), and particle canvases have real
// backing stores. That prevents a frozen empty canvas from masquerading as a static burst.
await page.waitForFunction(
  () => [...document.querySelectorAll("[data-godot-particle-canvas]")].every((canvas) => canvas.width > 0 && canvas.height > 0),
  null,
  { timeout: 60000 }
);
const readiness = await page.evaluate(async () => {
  const images = [...document.images];
  const imageStates = await Promise.all(images.map(async (img) => {
    try { await img.decode(); return { src: img.currentSrc || img.src, decoded: true, complete: img.complete, width: img.naturalWidth, height: img.naturalHeight }; }
    catch { return { src: img.currentSrc || img.src, decoded: false, complete: img.complete, width: img.naturalWidth, height: img.naturalHeight }; }
  }));
  const canvases = [...document.querySelectorAll("[data-godot-particle-canvas]")].map((canvas) => ({ width: canvas.width, height: canvas.height }));
  return { readyState: document.readyState, images: imageStates, canvases };
});
const stoppedAtRecordedMs = await page.evaluate(() => window.__probeStopped);

// FREEZE the page before measuring/screenshotting. In `particles=dynamic` the simulation keeps running between
// the measurement evaluate and the two screenshots, so a one-shot burst can be mid-flight for one and finished
// (canvas CLEARED) for the next — the probe would then report a shaped burst and photograph an empty stage.
// Neutering the timers holds whatever frame was last drawn for every observation below. The probe takes at least
// two independent screenshots and marks the run failed when their digests differ; a claimed freeze needs evidence.
if (args.freeze) {
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
    window.setTimeout = () => 0;
    window.setInterval = () => 0;
  });
  // Existing callbacks can have captured the native rAF before the page-level overrides above. Pausing Chromium's
  // virtual clock closes that last escape hatch (including WebGL work scheduled outside our page globals) while
  // still allowing screenshot capture. The repeated hashes below are the proof that the freeze held.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
}

// What the runtime actually mounted: one entry per live particle canvas, with the owning node's path and the
// spec fields this probe exists to prove.
const systems = await page.evaluate(() => {
  const out = [];
  for (const canvas of document.querySelectorAll("[data-godot-particle-canvas]")) {
    const owner = canvas.closest("[data-node-path]");
    const specNode = canvas.closest("[data-godot-particle-specs]");
    let spec = null;
    try {
      spec = JSON.parse(specNode?.getAttribute("data-godot-particle-specs") ?? "null");
    } catch {
      spec = null;
    }
    const box = canvas.getBoundingClientRect();
    // What the system actually PAINTED, measured off its own canvas (downsampled to 48x48 so a 2048px
    // ambient emitter is cheap). `covered` is the fraction of the canvas carrying real alpha: an opaque
    // SQUARE tends to ~1.0 over the sprite's rect, a shaped glow is a small fraction of it. This is the
    // numeric half of the evidence — the screenshot is the other half.
    let paint = null;
    try {
      const probeCanvas = document.createElement("canvas");
      probeCanvas.width = 48;
      probeCanvas.height = 48;
      const pctx = probeCanvas.getContext("2d");
      pctx.drawImage(canvas, 0, 0, 48, 48);
      const data = pctx.getImageData(0, 0, 48, 48).data;
      let sum = 0;
      let covered = 0;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) {
        sum += data[i];
        if (data[i] > 24) covered += 1;
        if (data[i] > 232) opaque += 1;
      }
      const total = data.length / 4;
      paint = {
        meanAlpha: Number((sum / total / 255).toFixed(4)),
        covered: Number((covered / total).toFixed(4)),
        opaque: Number((opaque / total).toFixed(4))
      };
    } catch {
      paint = null;
    }
    // The canvas box gsw itself WROTE (`writeCanvasBox`: `-padLeft`/`-padTop` + the css size), which is the
    // sizing law's output directly. Reported next to `box` because they answer different questions and the
    // difference matters: `box` is a LAYOUT read, so it is 0x0 for any system inside a hidden/dormant subtree
    // — the state most of a scene's emitters are in at any moment — while `cssBox` is what gsw decided
    // regardless. A canvas sized 710x710 over a burst that travels 2500px is the R19 WP-3 crop, and it is
    // visible here whether or not the node happens to be on screen.
    const cssBox = {
      left: canvas.style.left,
      top: canvas.style.top,
      width: canvas.style.width,
      height: canvas.style.height
    };
    out.push({
      nodePath: owner?.getAttribute("data-node-path") ?? null,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      cssBox,
      // The host's budget for that decision (`particleVisibleRect.ts`): the stage viewport in this node's own
      // local space. Null = the host stamped nothing, so gsw is on its PAD_CAP fallback.
      visibleRect: specNode?.getAttribute("data-godot-particle-visible-rect") ?? null,
      paint,
      textureUrl: spec?.textureUrl ?? null,
      alphaFromRed: spec?.alphaFromRed ?? false,
      uvPolar: spec?.uvPolar ?? false,
      alphaErode: spec?.alphaErode ?? null,
      maskUrl: spec?.maskUrl ?? null,
      colorLutStops: Array.isArray(spec?.colorLut) ? spec.colorLut.length : 0
    });
  }
  return out;
});

const captures = [];
for (let index = 0; index < args.captures; index++) {
  const path = frozenCapturePath(index);
  await page.screenshot({ path });
  captures.push({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
}
const frozenCapturesIdentical = new Set(captures.map((capture) => capture.sha256)).size === 1;

let cropped = null;
if (args.focus) {
  const target = systems.find((s) => (s.nodePath ?? "").includes(args.focus));
  if (target && target.box.width > 0) {
    const clip = {
      x: Math.max(0, target.box.x - args.pad),
      y: Math.max(0, target.box.y - args.pad),
      width: Math.min(args.width, target.box.width + args.pad * 2),
      height: Math.min(args.height, target.box.height + args.pad * 2)
    };
    clip.width = Math.min(clip.width, args.width - clip.x);
    clip.height = Math.min(clip.height, args.height - clip.y);
    await page.screenshot({ path: cropPath, clip });
    cropped = { path: cropPath, clip, nodePath: target.nodePath };
  }
}

console.log(
  JSON.stringify(
    {
      out: outPath,
      crop: cropped,
      frozenCaptures: captures,
      freeze: {
        requested: args.freeze,
        stable: !args.freeze || frozenCapturesIdentical,
        // A mismatch is a failed probe, not a cosmetic warning: it means the measurement and screenshot did not
        // observe one static frame. The files remain as failure evidence.
        failure: args.freeze && !frozenCapturesIdentical ? "Repeated frozen captures differed; do not use this replay as static visual evidence." : null
      },
      frozenCapturesIdentical,
      stoppedAtRecordedMs,
      inject: injectStats,
      readiness,
      assetRoutes: {
        fixtureSubstitution: "--res-root serves /res/**. --asset-fixtures may explicitly substitute exact /res, /bg or /spines routes with declared source provenance; neither is production-route parity.",
        fixtureManifest: fixtureManifestPath ? { path: fixtureManifestPath, supplied: true } : { supplied: false, reason: "No local /bg or /spines fixture manifest was supplied; those routes were left on the configured origin." },
        requiredCoverageResources: REQUIRED_COVERAGE_RESOURCES.map((resource) => {
          const route = assetRequests.res.find((url) => decodeURIComponent(url.slice("/res/".length)) === resource) ?? `/res/${resource}`;
          return { resource: `res://${resource}`, requested: assetRequests.res.includes(route), missing: resMisses.has(resource), substitution: assetSubstitutions.res.find((entry) => entry.url === route) ?? null };
        }),
        res: { mode: "res-root plus explicit manifest substitutions", requested: assetRequests.res, served: resHits, missing: [...resMisses], substitutions: assetSubstitutions.res },
        bg: { mode: fixtureManifestPath ? "explicit-fixture-or-production-origin" : "production-origin-passthrough", requested: assetRequests.bg, responses: assetResponses.bg, failures: assetFailures.bg, substitutions: assetSubstitutions.bg },
        spines: { mode: fixtureManifestPath ? "explicit-fixture-or-production-origin" : "production-origin-passthrough", requested: assetRequests.spines, responses: assetResponses.spines, failures: assetFailures.spines, substitutions: assetSubstitutions.spines }
      },
      systems
    },
    null,
    2
  )
);

await browser.close();
if (args.freeze && !frozenCapturesIdentical) process.exitCode = 1;
