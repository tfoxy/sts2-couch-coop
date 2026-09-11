#!/usr/bin/env node
// R19 6a — the SQUEEZE RENDERED-BOX GATE probe: does hovering (and dragging) in the empty stage band RIGHT of the
// map legend still resolve onto a legend row?
//
// THE BUG. On a wider-than-16:9 stage the map legend is ANCHORED: at 2520x1080 it carries spreadDx = 300, so its
// rows live at game x[1582,1862] but RENDER at x[1882,2162]. Right of that nothing paints at all, so
// mapPointerToGame falls back to the uniform SQUEEZE (`designX·1920/designW`) — and because the squeeze knows
// nothing about the legend's translation, the coordinate it produces over designX 2220-2440 lands INSIDE the
// legend's game rect. The near-miss pass, which exists to undo exactly that kind of misregistration, is
// deliberately suppressed for squeeze-resolved points (its bistability is separately measured), so the coordinate
// went out verbatim and the game focused a legend row the pointer was nowhere near. A DRAG was worse: the frozen
// replay never ran any consistency pass at all, so it held the row for the whole gesture.
//
// THE FIX (pointerMap.pushOutOfSqueezeMiss + inputCapture.squeezeGate) holds a squeeze-resolved coordinate to ONE
// invariant: it may only resolve into an interactive rect whose RENDERED box contains the raw widened-design
// pointer. Where it doesn't, the coordinate is ejected from that one rect. `?squeezeRenderedGate=off` restores the
// pre-fix behaviour, which is what makes this probe a true A/B on a single build.
//
// WHAT THIS SCRIPT DOES. It replays a recorded MAP-screen scene-delta stream into a REAL headless Chromium running
// the ACTUAL mirror page (the WebSocket is faked in-page, exactly like scripts/probe-viewscale-halo-input.mjs, so
// no live game is needed), then CDP-sweeps real `mouseMoved` events left→right across the legend band and RECORDS
// what the page put on the wire for each sweep position. A second pass repeats the sweep with the left button HELD
// (the drag case). Both run twice: once with the gate ON, once with `?squeezeRenderedGate=off`.
//
//   # 1. start a dev server serving THE CODE UNDER TEST:
//   cd frontend && npm run dev -- --port 5174 --strictPort
//   # 2. run the probe:
//   node scripts/probe-map-legend-squeeze.mjs --url http://127.0.0.1:5174 \
//        --recording .sts2/bench/r8-map-live.ndjson --out .sts2/artifacts/diag-map-legend-2520-after.json
//
// METRIC (per mode, hover sweep and drag sweep separately):
//   falseFocus  samples whose SENT coordinate is inside a legend row's GAME rect while the pointer's designX is
//               outside the legend's ON-STAGE rendered box (rows' game rect + spreadDx, unioned with the view-scale
//               stamp's renderedBox when the legend is enlarged) by more than --slack design px. Those are exactly
//               the samples that focus a row nobody is pointing at.
//   legitFocus  samples inside the rendered box that DO resolve onto a row — the gate must not cost any of these.
//
// Exits non-zero if the gate-on run still has false focuses, or if the gate-off run has none (the probe would then
// be blind to the bug it claims to measure).

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const a = {
    url: process.env.COUCHCOOP_PROBE_URL ?? "http://127.0.0.1:5174",
    recording: process.env.COUCHCOOP_PROBE_RECORDING ?? ".sts2/bench/r8-map-live.ndjson",
    out: null,
    width: 2520,
    height: 1080,
    fromX: 1500, // design-x of the first sweep sample
    toX: 2500,
    stepX: 20, // design px between samples (51 samples over the default range)
    designY: 500,
    gapMs: 33,
    settleMs: 1200,
    slack: 2,
    keep: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [key, inlineVal] = eq > 0 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const val = () => inlineVal ?? argv[++i];
    switch (key) {
      case "--url": a.url = val(); break;
      case "--recording": a.recording = val(); break;
      case "--out": a.out = val(); break;
      case "--width": a.width = Number(val()); break;
      case "--height": a.height = Number(val()); break;
      case "--from": a.fromX = Number(val()); break;
      case "--to": a.toX = Number(val()); break;
      case "--step": a.stepX = Number(val()); break;
      case "--y": a.designY = Number(val()); break;
      case "--gap": a.gapMs = Number(val()); break;
      case "--settle": a.settleMs = Number(val()); break;
      case "--slack": a.slack = Number(val()); break;
      case "--keep": a.keep = true; break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`Unknown argument: ${arg}`); a.help = true;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`probe-map-legend-squeeze.mjs — CDP hover + drag sweep across the dead band right of the map legend

  --url <origin>      dev server serving the code under test (default http://127.0.0.1:5174)
                        cd frontend && npm run dev -- --port 5174 --strictPort
  --recording <path>  NDJSON scene-delta recording of the MAP screen (default .sts2/bench/r8-map-live.ndjson)
  --out <path>        write the full per-sample record as JSON (default: none)
  --width/--height    viewport (default 2520x1080 — the measured wide stage)
  --from/--to/--step  design-x sweep range and stride (default 1500..2500 by 20 = 51 samples)
  --y <designY>       sweep row (default 500)
  --gap <ms>          ms between samples (default 33)
  --settle <ms>       quiet ms after the stream finishes (default 1200)
  --slack <px>        design-px tolerance around the legend's rendered box (default 2)
  --keep              leave the browser open after a failure

Prints a per-mode table and a machine-readable "PROBE_RESULT {json}" line. Non-zero exit on failure.`);
  process.exit(0);
}

const recordingPath = resolve(REPO_ROOT, args.recording);
let recordingText;
try {
  recordingText = readFileSync(recordingPath, "utf8");
  requireReproHeader(recordingText, recordingPath);
} catch (e) {
  console.error(`Cannot read recording '${recordingPath}': ${e.message}`);
  process.exit(2);
}
const hasRecordedDirectView = recordingText.includes('"directView":true');

// ---------------------------------------------------------------------------------------------------------
// in-page fake WebSocket + input recorder (injected BEFORE any page script) — same shape as
// probe-viewscale-halo-input.mjs: recorded pacing, join → directView, ping → pong, and send() captures every
// `{type:"input"}` frame onto window.__probeSentInputs. That array IS the evidence.
// ---------------------------------------------------------------------------------------------------------
function probeWebSocketInit(config) {
  const OPEN = 1;
  const realFetch = window.fetch.bind(window);
  window.__probeSentInputs = [];
  window.__probeMarks = [];
  window.__probeMark = (i) => window.__probeMarks.push({ i, t: performance.now() });
  window.__probeStreamDone = false;

  class ProbeWebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      this._msgs = []; this._i = 0; this._closed = false;
      window.__probeWs = this;
      if (this.url.includes("/ws")) this._start();
    }
    async _start() {
      let text = "";
      try {
        const res = await realFetch(config.recordingUrl);
        text = await res.text();
      } catch (e) { this._fail("recording fetch failed: " + e); return; }
      for (const line of text.split("\n")) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.meta) continue;
        if (typeof obj.data !== "string") continue;
        if (obj.data.includes('"type":"server-reload"')) continue;
        this._msgs.push({ t: typeof obj.t === "number" ? obj.t : 0, data: obj.data });
      }
      if (this._closed) return;
      this.readyState = OPEN;
      this._emit("open", new Event("open"));
      if (config.synthesizeDirectView) this._deliver('{"type":"session","directView":true}');
      this._pump();
    }
    _pump() {
      const t0 = performance.now();
      const tick = () => {
        if (this._closed) return;
        const now = performance.now() - t0;
        while (this._i < this._msgs.length && this._msgs[this._i].t <= now) {
          this._deliver(this._msgs[this._i].data);
          this._i++;
        }
        if (this._i < this._msgs.length) setTimeout(tick, Math.max(0, this._msgs[this._i].t - (performance.now() - t0)));
        else window.__probeStreamDone = true;
      };
      tick();
    }
    _deliver(data) { this._emit("message", new MessageEvent("message", { data })); }
    _emit(type, event) {
      const handler = this["on" + type];
      if (typeof handler === "function") { try { handler.call(this, event); } catch { /* keep going */ } }
      this.dispatchEvent(event);
    }
    _fail(reason) { this.readyState = 3; window.__probeWsError = reason; this._emit("error", new Event("error")); }
    send(data) {
      let msg = null;
      try { msg = JSON.parse(data); } catch { return; }
      const type = msg && msg.type;
      if (type === "scene-ack") return;
      if (type === "join") { this._deliver('{"type":"session","directView":true}'); return; }
      if (type === "ping") {
        const echo = { type: "pong", t0: msg.t0 };
        if (msg.mainThread) echo.mainThread = true;
        this._deliver(JSON.stringify(echo));
        return;
      }
      if (type === "input" && (msg.kind === "hover" || msg.kind === "click")) {
        window.__probeSentInputs.push({
          kind: msg.kind,
          pressed: msg.pressed ?? null,
          coordX: msg.coordX ?? null,
          coordY: msg.coordY ?? null,
          t: performance.now()
        });
      }
    }
    close() { this._closed = true; this.readyState = 3; this._emit("close", new CloseEvent("close")); }
  }
  window.WebSocket = ProbeWebSocket;
}

const round = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

async function readStage(page) {
  return page.evaluate(() => {
    const s = document.querySelector(".mirror-stage");
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, designW: s.offsetWidth, designH: s.offsetHeight };
  });
}

// The legend's geometry, straight off the live input structures the fix reads:
//   * the LegendItem node ids come from the DOM (`data-node-path` carries "MapLegend/LegendItems/...")
//   * their GAME boxes + spreadDx come from the retained interactive rects (window.__mirrorInteractiveRects)
//   * the on-stage RENDERED box is the union of (game box + spreadDx) and, when the legend is view-scale enlarged,
//     the stamp's own renderedBox — a pointer inside EITHER is genuinely over the legend.
async function readLegend(page) {
  return page.evaluate(() => {
    const ids = new Set();
    for (const el of document.querySelectorAll("[data-node-path]")) {
      const path = el.getAttribute("data-node-path") ?? "";
      const id = el.getAttribute("data-node-id");
      if (id && /MapLegend\/LegendItems\//.test(path)) ids.add(id);
    }
    const getRects = window.__mirrorInteractiveRects;
    if (typeof getRects !== "function") return { error: "window.__mirrorInteractiveRects seam missing" };
    const rects = getRects().filter((r) => ids.has(r.id));
    if (rects.length === 0) return { error: `no interactive rect for the ${ids.size} LegendItem node(s) on screen` };
    const box = (r) => {
      const m = r.transform;
      const w = r.localRect.width;
      const h = r.localRect.height;
      const xs = [m[4], m[0] * w + m[4], m[2] * h + m[4], m[0] * w + m[2] * h + m[4]];
      const ys = [m[5], m[1] * w + m[5], m[3] * h + m[5], m[1] * w + m[3] * h + m[5]];
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    };
    const boxes = rects.map(box);
    const game = {
      minX: Math.min(...boxes.map((b) => b.minX)),
      maxX: Math.max(...boxes.map((b) => b.maxX)),
      minY: Math.min(...boxes.map((b) => b.minY)),
      maxY: Math.max(...boxes.map((b) => b.maxY))
    };
    const dx = Math.max(...rects.map((r) => r.spreadDx));
    const rendered = { minX: game.minX + dx, maxX: game.maxX + dx, minY: game.minY, maxY: game.maxY };
    // View-scale enlargement (the legend band is a 1.2 stamp on the real map screen): widen the rendered box to
    // the stamp's own renderedBox wherever the stamp covers the legend, so an enlarged halo hit counts as legit.
    const stamps = typeof window.__mirrorViewScaleInputStamps === "function" ? window.__mirrorViewScaleInputStamps() : [];
    let stampBox = null;
    for (const s of stamps) {
      const rb = s.renderedBox ?? s.scaledBox;
      const covers = s.originalBox.minX <= game.maxX && s.originalBox.maxX >= game.minX &&
        s.originalBox.minY <= game.maxY && s.originalBox.maxY >= game.minY;
      if (!covers) continue;
      stampBox = stampBox
        ? { minX: Math.min(stampBox.minX, rb.minX), maxX: Math.max(stampBox.maxX, rb.maxX), minY: Math.min(stampBox.minY, rb.minY), maxY: Math.max(stampBox.maxY, rb.maxY) }
        : { ...rb };
    }
    if (stampBox) {
      rendered.minX = Math.min(rendered.minX, stampBox.minX);
      rendered.maxX = Math.max(rendered.maxX, stampBox.maxX);
      rendered.minY = Math.min(rendered.minY, stampBox.minY);
      rendered.maxY = Math.max(rendered.maxY, stampBox.maxY);
    }
    return { rows: rects.length, spreadDx: dx, game, rendered, stampBox };
  });
}

// One left→right sweep at `designY`, optionally with the left button HELD the whole way (the drag case).
async function sweep(page, cdp, stage, held) {
  const toClientX = (designX) => stage.left + (designX / stage.designW) * stage.width;
  const clientY = stage.top + (args.designY / stage.designH) * stage.height;
  const samples = [];
  for (let designX = args.fromX; designX <= args.toX; designX += args.stepX) {
    samples.push({ i: samples.length, designX, clientX: toClientX(designX) });
  }
  await page.evaluate(() => { window.__probeSentInputs.length = 0; window.__probeMarks.length = 0; });
  if (held) {
    // Press in dead space at the RIGHT end of the band, then drag left→right across it. The press point is what
    // freezes the field (and, after 6a, the "unanchored" flag the replay inherits).
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: toClientX(args.toX), y: clientY });
    await page.waitForTimeout(args.gapMs);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: toClientX(args.toX), y: clientY, button: "left", buttons: 1, clickCount: 1 });
    await page.waitForTimeout(args.gapMs);
    await page.evaluate(() => { window.__probeSentInputs.length = 0; window.__probeMarks.length = 0; });
  }
  for (const smp of samples) {
    await page.evaluate((k) => window.__probeMark(k), smp.i);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: smp.clientX,
      y: clientY,
      ...(held ? { button: "left", buttons: 1 } : {})
    });
    await page.waitForTimeout(args.gapMs);
  }
  await page.waitForTimeout(250);
  if (held) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: toClientX(args.toX), y: clientY, button: "left", buttons: 0, clickCount: 1 });
  }
  const { sent, marks } = await page.evaluate(() => ({ sent: window.__probeSentInputs, marks: window.__probeMarks }));
  const hovers = sent.filter((m) => m.kind === "hover");
  for (const smp of samples) {
    const from = marks.find((m) => m.i === smp.i)?.t ?? Infinity;
    const next = marks.find((m) => m.i === smp.i + 1)?.t ?? Infinity;
    const w = hovers.filter((h) => h.t >= from && h.t < next);
    smp.sent = w.length > 0 ? w[w.length - 1] : null;
  }
  return samples;
}

function classify(samples, legend) {
  const inBox = (b, x, y) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
  let falseFocus = 0;
  let legitFocus = 0;
  let matched = 0;
  const worst = [];
  for (const smp of samples) {
    if (!smp.sent) continue;
    matched++;
    const onRow = inBox(legend.game, smp.sent.coordX, smp.sent.coordY);
    if (!onRow) continue;
    const pointerOver =
      smp.designX >= legend.rendered.minX - args.slack && smp.designX <= legend.rendered.maxX + args.slack;
    if (pointerOver) {
      legitFocus++;
    } else {
      falseFocus++;
      if (worst.length < 6) {
        worst.push({ designX: smp.designX, sentX: round(smp.sent.coordX), sentY: round(smp.sent.coordY) });
      }
    }
  }
  return { samples: samples.length, matched, falseFocus, legitFocus, worst };
}

async function runMode(browser, mode) {
  const context = await browser.newContext({ viewport: { width: args.width, height: args.height } });
  await context.route("**/__probe/recording", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: recordingText })
  );
  await context.addInitScript(probeWebSocketInit, {
    recordingUrl: "/__probe/recording",
    synthesizeDirectView: !hasRecordedDirectView
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const pageUrl = `${args.url.replace(/\/$/, "")}/?quality=high&shaders=off&particles=off${mode.query ?? ""}`;
  const result = { mode: mode.name, url: pageUrl, errors: [] };
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll(".mirror-node").length > 50, null, { timeout: 120_000 });
    try {
      await page.waitForFunction(() => window.__probeStreamDone === true, null, { timeout: 120_000 });
    } catch {
      result.errors.push(`stream did not finish (fake WS error: ${await page.evaluate(() => window.__probeWsError ?? "none")})`);
    }
    await page.waitForTimeout(args.settleMs);

    const stage = await readStage(page);
    if (!stage || stage.width <= 0) { result.errors.push("no .mirror-stage rect"); return result; }
    result.stage = stage;
    const legend = await readLegend(page);
    if (legend.error) { result.errors.push(legend.error); return result; }
    result.legend = legend;

    result.hover = classify(await sweep(page, cdp, stage, false), legend);
    result.drag = classify(await sweep(page, cdp, stage, true), legend);
    return result;
  } finally {
    if (!args.keep) await context.close();
  }
}

console.log("probe-map-legend-squeeze");
console.log(`  url:        ${args.url}`);
console.log(`  recording:  ${recordingPath}`);
console.log(`  viewport:   ${args.width}x${args.height}`);
console.log(`  sweep:      designX ${args.fromX}..${args.toX} step ${args.stepX} at designY ${args.designY}`);

const MODES = [
  { name: "gate-off", query: "&squeezeRenderedGate=off" }, // BEFORE — the pre-fix behaviour, byte-identical
  { name: "gate-on", query: "" } // AFTER — the default
];

const browser = await chromium.launch({ args: ["--disable-gpu"] });
const results = [];
for (const mode of MODES) {
  process.stdout.write(`  running ${mode.name}... `);
  const r = await runMode(browser, mode);
  results.push(r);
  console.log(r.errors.length ? `ERROR: ${r.errors.join("; ")}` : "ok");
}
if (!args.keep) await browser.close();

const byName = Object.fromEntries(results.map((r) => [r.mode, r]));
for (const r of results) {
  if (!r.legend) continue;
  console.log(
    `\n  ${r.mode}: legend rows=${r.legend.rows} dx=${round(r.legend.spreadDx)} ` +
      `game x[${round(r.legend.game.minX, 1)},${round(r.legend.game.maxX, 1)}] y[${round(r.legend.game.minY, 1)},${round(r.legend.game.maxY, 1)}] ` +
      `rendered x[${round(r.legend.rendered.minX, 1)},${round(r.legend.rendered.maxX, 1)}]`
  );
}
console.log("");
console.log("mode      sweep   samples  matched  false-focus  legit-focus");
console.log("--------  ------  -------  -------  -----------  -----------");
for (const r of results) {
  for (const kind of ["hover", "drag"]) {
    const c = r[kind];
    if (!c) continue;
    const cell = (v, w) => String(v ?? "-").padEnd(w);
    console.log(`${cell(r.mode, 10)}${cell(kind, 8)}${cell(c.samples, 9)}${cell(c.matched, 9)}${cell(c.falseFocus, 13)}${cell(c.legitFocus, 11)}`);
  }
}
for (const r of results) {
  for (const kind of ["hover", "drag"]) {
    const c = r[kind];
    if (!c?.worst?.length) continue;
    console.log(`\n  ${r.mode}/${kind}: false focuses (pointer beside the legend resolved ONTO a row):`);
    for (const v of c.worst) console.log(`      designX ${v.designX} → sent (${v.sentX}, ${v.sentY})`);
  }
}

if (args.out) {
  const outPath = resolve(REPO_ROOT, args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ args, results }, null, 1));
  console.log(`\n  wrote ${outPath}`);
}

const failures = [];
for (const r of results) if (r.errors.length) failures.push(`${r.mode}: ${r.errors.join("; ")}`);
const on = byName["gate-on"];
const off = byName["gate-off"];
if (on && !on.errors.length) {
  if (on.hover.falseFocus > 0) failures.push(`gate-on: ${on.hover.falseFocus} hover sample(s) still false-focus the legend`);
  if (on.drag.falseFocus > 0) failures.push(`gate-on: ${on.drag.falseFocus} drag sample(s) still false-focus the legend`);
  if (on.hover.legitFocus === 0) failures.push("gate-on: NO sample over the legend resolved onto a row — the gate ate the real hits");
}
if (!off || off.errors.length) failures.push("gate-off: could not run the pre-fix repro");
else if (off.hover.falseFocus === 0 && off.drag.falseFocus === 0) {
  failures.push("gate-off: the pre-fix run produced NO false focus, so this probe cannot see the bug it measures");
}

console.log("");
console.log(`PROBE_RESULT ${JSON.stringify({
  ok: failures.length === 0,
  modes: results.map((r) => ({
    mode: r.mode,
    legend: r.legend ? { game: r.legend.game, rendered: r.legend.rendered, spreadDx: r.legend.spreadDx } : null,
    hover: r.hover ? { samples: r.hover.samples, matched: r.hover.matched, falseFocus: r.hover.falseFocus, legitFocus: r.hover.legitFocus } : null,
    drag: r.drag ? { samples: r.drag.samples, matched: r.drag.matched, falseFocus: r.drag.falseFocus, legitFocus: r.drag.legitFocus } : null,
    errors: r.errors
  }))
})}`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.error(`FAIL  ${f}`);
  process.exit(1);
}
console.log("PASS  the gate removes every false legend focus (hover + drag) and keeps the legitimate ones");
