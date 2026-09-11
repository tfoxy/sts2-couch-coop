#!/usr/bin/env node
// The wide-screen TARGETING-CURSOR probe: does the game coordinate the mirror sends move CONTINUOUSLY while the
// pointer sweeps smoothly across a widened stage — during a plain hover AND during a held (targeting) drag?
//
// WHY IT MATTERS. Everything the game draws AT the cursor (the targeting arrow, the reticle, a dragged card) is
// re-placed by the mirror at `sentX · spreadFactor` (the positional squeeze field every world visual rides). So a
// DISCONTINUITY in the sent X — the pointer moves 8px and the sent coordinate moves 100 — teleports the in-game
// cursor away from the real one. The pre-fix pipeline has several such edges:
//   * the per-painter FIELD switch (a hover crossing from one `data-spread-dx` painter to another),
//   * the exact-local-translation vs squeeze-field mismatch INSIDE one rigid prop painter,
//   * the view-scale inverse flipping on/off mid-drag (it ran live on every frozen drag frame),
//   * `clampGameX` saturation at the stage edges for an anchored affine.
//
// WHAT THIS SCRIPT DOES. It replays a recorded scene-delta stream into a REAL headless Chromium running the ACTUAL
// mirror page (the WebSocket is faked in-page, exactly like scripts/probe-viewscale-halo-input.mjs, so no live game
// is needed), then CDP-sweeps real mouse events left→right across the stage and records what the page put ON THE
// WIRE for each sweep position, together with the topmost `data-paints` painter (id / spread mode / spread dx) the
// pointer was over. The recording is passive — the game cannot react — so the CURSOR position is MODELLED
// (`sentX · spreadFactor`), which is exactly how the renderer places world-space visuals.
//
//   # 1. start a dev server serving THE CODE UNDER TEST:
//   cd frontend && npx vite --port 5177 --strictPort
//   # 2. run the probe:
//   node scripts/probe-targeting-drag-jump.mjs --url http://127.0.0.1:5177 \
//        --recording .sts2/bench/combat-modern-2026-08-06.ndjson --out .sts2/artifacts/targeting-drag-jump
//
// LEGS (each a fresh context/page):
//   wide-hover  2520x1080 — plain hover sweep (the click-to-select-then-move targeting path)
//   wide-drag   2520x1080 — press on the hand, sweep held, release (the drag targeting path)
//   control     1920x1080 — the same drag sweep at 16:9; must be the identity map (regression guard)
//
// METRICS (per leg):
//   stepJumpMax   the largest EXCESS |ΔsentX| between two adjacent samples over the leg's median step (design px)
//   jumps>5       how many adjacent-sample steps exceed the median step by more than 5 design px
//   trackErrMax   max |sentX·spreadFactor − designX| — how far the modelled in-game cursor renders from the real
//                 pointer (design px). 0 at 16:9 by construction.
//   deadZone      how many samples the sent X did not move at all (clampGameX saturation)
//   near-miss     per sample, the hit-consistency decision behind the send (`window.__probeNearMiss`, installed
//                 before page load): the offender control's id + game-x extent, the push direction, and whether that
//                 direction came from the hysteresis memory. `offender flips` counts adjacent pushing samples that
//                 disagreed about WHO the offender was — the alternation that made the sent X bistable.
//
// Exits non-zero only on a harness failure (no stage, no samples); the numbers are the evidence.

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
    url: process.env.COUCHCOOP_PROBE_URL ?? "http://127.0.0.1:5177",
    recording: process.env.COUCHCOOP_PROBE_RECORDING ?? ".sts2/bench/combat-modern-2026-08-06.ndjson",
    out: ".sts2/artifacts/targeting-drag-jump",
    tag: "run",
    width: 2520,
    sweepY: 420, // design Y of the sweep line (the enemy band — where a targeting arrow tip lives)
    pressX: 960, // design X/Y of the drag press (the hand)
    pressY: 950,
    step: 10, // client-px between sweep samples
    gapMs: 24, // > one frame; hover sends are rAF-coalesced
    settleMs: 800,
    query: "",
    shot: false,
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
      case "--tag": a.tag = val(); break;
      case "--width": a.width = Number(val()); break;
      case "--sweep-y": a.sweepY = Number(val()); break;
      case "--press-x": a.pressX = Number(val()); break;
      case "--press-y": a.pressY = Number(val()); break;
      case "--step": a.step = Number(val()); break;
      case "--gap": a.gapMs = Number(val()); break;
      case "--settle": a.settleMs = Number(val()); break;
      case "--query": a.query = val(); break;
      case "--shot": a.shot = true; break;
      case "--keep": a.keep = true; break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`Unknown argument: ${arg}`); a.help = true;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`probe-targeting-drag-jump.mjs — CDP hover/drag sweep measuring the sent-coordinate continuity

  --url <origin>       dev server serving the code under test (default http://127.0.0.1:5177)
  --recording <path>   NDJSON scene-delta recording (default .sts2/bench/combat-modern-2026-08-06.ndjson)
  --out <dir>          artifact dir for the per-sample JSON (default .sts2/artifacts/targeting-drag-jump)
  --tag <name>         artifact filename tag, e.g. "before" / "after" (default "run")
  --width <px>         widened viewport width (default 2520)
  --sweep-y <design>   design Y of the sweep line (default 420)
  --press-x/--press-y  design point of the drag press (default 960 / 950)
  --step <px>          client-px between sweep samples (default 10)
  --gap <ms>           ms between samples (default 24)
  --query <str>        extra query string appended to the page URL (e.g. "&dragFreezeFull=off")
  --shot               save a PNG of each leg
  --keep               leave the browser open
`);
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
const outDir = resolve(REPO_ROOT, args.out);
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------------------------------------
// in-page fake WebSocket + input recorder (same shape as probe-viewscale-halo-input.mjs)
// ---------------------------------------------------------------------------------------------------------

function probeWebSocketInit(config) {
  const OPEN = 1;
  const realFetch = window.fetch.bind(window);
  window.__probeSentInputs = [];
  window.__probeMarks = [];
  window.__probeMark = (i) => window.__probeMarks.push({ i, t: performance.now() });
  window.__probeStreamDone = false;
  // The near-miss (hit-consistency) seam: pointerMap reports the decision every pass made — which control was found
  // to be the offender, its game-x extent, and which way (and whether from hysteresis memory) the coord was pushed.
  // Installed HERE, before any page module loads, because pointerMap latches the hook's presence at module load.
  window.__probeNearMissLog = [];
  window.__probeNearMiss = (r) => {
    if (window.__probeNearMissLog.length < 40000) window.__probeNearMissLog.push({ ...r, t: performance.now() });
  };

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
        if (this._i < this._msgs.length) {
          setTimeout(tick, Math.max(0, this._msgs[this._i].t - (performance.now() - t0)));
        } else {
          window.__probeStreamDone = true;
        }
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
          kind: msg.kind, button: msg.button ?? null, pressed: msg.pressed ?? null,
          coordX: msg.coordX ?? null, coordY: msg.coordY ?? null, t: performance.now()
        });
      }
    }
    close() { this._closed = true; this.readyState = 3; this._emit("close", new CloseEvent("close")); }
  }
  window.WebSocket = ProbeWebSocket;
}

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

const round = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

async function readStage(page) {
  return page.evaluate(() => {
    const s = document.querySelector(".mirror-stage");
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, designW: s.offsetWidth, designH: s.offsetHeight };
  });
}

// The topmost `data-paints` painter under a client point, the way pointerMap picks it (skipping full-stage
// backdrops) — so a jump can be ATTRIBUTED to the painter that changed under the pointer.
async function readPainter(page, clientX, clientY) {
  return page.evaluate(([x, y]) => {
    const stage = document.querySelector(".mirror-stage");
    const stageW = stage ? stage.getBoundingClientRect().width : 0;
    let lastOwner = null;
    for (const el of document.elementsFromPoint(x, y)) {
      const owner = el.closest("[data-node-id]");
      if (!owner || owner === lastOwner) continue;
      lastOwner = owner;
      if (!owner.hasAttribute("data-paints")) continue;
      const ownWidth = owner.getBoundingClientRect().width;
      if (owner.hasAttribute("data-spread-w") || ownWidth >= 0.95 * stageW) continue;
      const holder = owner.closest("[data-spread-dx]");
      return {
        id: owner.getAttribute("data-node-id"),
        type: owner.getAttribute("data-node-type"),
        mode: owner.getAttribute("data-spread-mode"),
        dx: holder ? Number(holder.getAttribute("data-spread-dx")) || 0 : 0,
        w: Math.round(ownWidth)
      };
    }
    return null;
  }, [clientX, clientY]);
}

// ---------------------------------------------------------------------------------------------------------
// one leg
// ---------------------------------------------------------------------------------------------------------

async function runLeg(browser, leg) {
  const context = await browser.newContext({ viewport: leg.viewport });
  await context.route("**/__probe/recording", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: recordingText })
  );
  await context.addInitScript(probeWebSocketInit, {
    recordingUrl: "/__probe/recording",
    synthesizeDirectView: !hasRecordedDirectView
  });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const pageUrl = `${args.url.replace(/\/$/, "")}/?quality=high&shaders=off&particles=off${args.query}${leg.query ?? ""}`;
  const result = { leg: leg.name, viewport: `${leg.viewport.width}x${leg.viewport.height}`, drag: leg.drag, errors: [] };

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll(".mirror-node").length > 50, null, { timeout: 120_000 });
    try {
      await page.waitForFunction(() => window.__probeStreamDone === true, null, { timeout: 180_000 });
    } catch {
      result.errors.push(`stream did not finish (${await page.evaluate(() => window.__probeWsError ?? "no ws error")})`);
    }
    await page.waitForTimeout(args.settleMs);

    const stage = await readStage(page);
    if (!stage || stage.width <= 0) { result.errors.push("no .mirror-stage rect"); return result; }
    result.stage = stage;
    const spreadFactor = stage.designW / 1920;
    result.spreadFactor = round(spreadFactor, 5);
    const toClientX = (designX) => stage.left + (designX / stage.designW) * stage.width;
    const toClientY = (designY) => stage.top + (designY / stage.designH) * stage.height;
    const toDesignX = (clientX) => ((clientX - stage.left) / stage.width) * stage.designW;

    if (args.shot) {
      await page.screenshot({ path: resolve(outDir, `${args.tag}-${leg.name}-scene.png`) });
    }

    // The live view-scale input registry — a jump inside ONE painter is almost always a stamp edge, so record the
    // stamps alongside the trace (the same `window.__mirrorViewScaleInputStamps` seam probe-viewscale-halo-input uses).
    result.stamps = await page.evaluate(() => {
      const get = window.__mirrorViewScaleInputStamps;
      if (typeof get !== "function") return null;
      const all = get();
      return Array.isArray(all)
        ? all.map((s) => ({ k: s.channel.k, isGroup: s.isGroup, scaledBox: s.scaledBox, renderedBox: s.renderedBox ?? null }))
        : null;
    });

    const sweepClientY = toClientY(args.sweepY);
    await page.evaluate(() => {
      window.__probeSentInputs.length = 0;
      window.__probeMarks.length = 0;
      window.__probeNearMissLog.length = 0;
    });

    // Park the pointer at the press point first (so the press is not the pointer's first event), then press.
    const pressClientX = toClientX(args.pressX * (stage.designW / 1920) === 0 ? args.pressX : args.pressX);
    const pressClientY = toClientY(args.pressY);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pressClientX, y: pressClientY });
    await page.waitForTimeout(args.gapMs * 2);
    result.pressPainter = await readPainter(page, pressClientX, pressClientY);
    if (leg.drag) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: pressClientX, y: pressClientY, button: "left", buttons: 1, clickCount: 1
      });
      await page.waitForTimeout(args.gapMs);
    }

    const samples = [];
    for (let clientX = Math.ceil(stage.left) + 2; clientX < stage.left + stage.width - 2; clientX += args.step) {
      const i = samples.length;
      samples.push({ i, clientX, designX: toDesignX(clientX) });
      await page.evaluate((k) => window.__probeMark(k), i);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: clientX, y: sweepClientY, ...(leg.drag ? { button: "left", buttons: 1 } : {})
      });
      await page.waitForTimeout(leg.gapMs ?? args.gapMs);
    }
    await page.waitForTimeout(200);
    if (leg.drag) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: samples[samples.length - 1].clientX, y: sweepClientY, button: "left", buttons: 0, clickCount: 1
      });
    }

    const { sent, marks, nearMiss } = await page.evaluate(() => ({
      sent: window.__probeSentInputs,
      marks: window.__probeMarks,
      nearMiss: window.__probeNearMissLog
    }));
    const hovers = sent.filter((m) => m.kind === "hover");
    for (const smp of samples) {
      const from = marks.find((m) => m.i === smp.i)?.t ?? Infinity;
      const next = marks.find((m) => m.i === smp.i + 1)?.t ?? Infinity;
      const window_ = hovers.filter((h) => h.t >= from && h.t < next);
      smp.sent = window_.length > 0 ? window_[window_.length - 1] : null;
      // The near-miss decision that produced THAT send (the last pass inside the same sample window). Absent = the
      // pass never ran for this sample — which is exactly what the squeeze gate does on a wide hover.
      const nmWindow = nearMiss.filter((n) => n.t >= from && n.t < next);
      smp.nearMiss = nmWindow.length > 0 ? nmWindow[nmWindow.length - 1] : null;
    }

    // Painter attribution for the sweep line (one pass AFTER the sweep — the scene is settled/static, and the
    // sweep itself never mutates the tree; a held drag is the client's own frozen math either way).
    for (const smp of samples) {
      smp.painter = await readPainter(page, smp.clientX, sweepClientY);
    }

    // ---- metrics ---------------------------------------------------------------------------------------
    const matched = samples.filter((s) => s.sent);
    if (matched.length < 4) { result.errors.push(`only ${matched.length} samples produced a hover`); return result; }
    const steps = [];
    for (let i = 1; i < matched.length; i++) {
      steps.push({
        i: matched[i].i,
        designX: matched[i].designX,
        dSent: matched[i].sent.coordX - matched[i - 1].sent.coordX,
        fromPainter: matched[i - 1].painter?.id ?? null,
        toPainter: matched[i].painter?.id ?? null
      });
    }
    const absSteps = steps.map((s) => Math.abs(s.dSent)).sort((a, b) => a - b);
    const median = absSteps[Math.floor(absSteps.length / 2)];
    for (const s of steps) s.excess = Math.abs(s.dSent) - median;
    const worst = [...steps].sort((a, b) => b.excess - a.excess).slice(0, 6);
    const trackErr = matched.map((s) => ({ designX: s.designX, err: s.sent.coordX * spreadFactor - s.designX }));
    const worstTrack = [...trackErr].sort((a, b) => Math.abs(b.err) - Math.abs(a.err))[0];
    const deadZone = steps.filter((s) => Math.abs(s.dSent) < 1e-6).length;

    result.samples = samples.length;
    result.matched = matched.length;
    result.medianStep = round(median, 3);
    result.stepJumpMax = round(Math.max(...steps.map((s) => s.excess)), 2);
    result.jumpsOver5 = steps.filter((s) => s.excess > 5).length;
    result.jumpsOver20 = steps.filter((s) => s.excess > 20).length;
    result.trackErrMax = round(Math.abs(worstTrack.err), 2);
    result.trackErrAt = round(worstTrack.designX, 1);
    result.deadZone = deadZone;
    result.worstSteps = worst.map((s) => ({
      designX: round(s.designX, 1), dSent: round(s.dSent, 2), excess: round(s.excess, 2),
      from: s.fromPainter, to: s.toPainter
    }));
    // Near-miss attribution: how many samples ran the pass at all, and how often the OFFENDER IDENTITY flipped
    // between adjacent samples that both pushed (the alternation behind the bistable sent X).
    const pushed = matched.filter((s) => s.nearMiss && s.nearMiss.offenderId !== null);
    let offenderFlips = 0;
    for (let i = 1; i < matched.length; i++) {
      const a = matched[i - 1].nearMiss?.offenderId ?? null;
      const b = matched[i].nearMiss?.offenderId ?? null;
      if (a !== null && b !== null && a !== b) offenderFlips++;
    }
    result.nearMissPasses = matched.filter((s) => s.nearMiss).length;
    result.nearMissPushes = pushed.length;
    result.nearMissOffenderFlips = offenderFlips;
    result.nearMissSeeded = pushed.filter((s) => s.nearMiss.seeded).length;

    result.trace = matched.map((s) => ({
      designX: round(s.designX, 2), sentX: round(s.sent.coordX, 3), sentY: round(s.sent.coordY, 2),
      // The near-miss decision behind this sample (null = the pass did not run / found no offender).
      nm: s.nearMiss
        ? { id: s.nearMiss.offenderId, gL: round(s.nearMiss.gLeft, 1), gR: round(s.nearMiss.gRight, 1),
            dir: s.nearMiss.dir, seeded: s.nearMiss.seeded, out: round(s.nearMiss.outX, 2) }
        : null,
      painter: s.painter ? `${s.painter.type ?? "?"}#${s.painter.id}` : null,
      mode: s.painter?.mode ?? null, dx: s.painter ? round(s.painter.dx, 2) : null,
      // The painter's RENDERED width — pointerMap demotes a painter wider than 60% of the stage to the uniform
      // squeeze, so a jump between two adjacent painters can be attributed to that flip.
      w: s.painter?.w ?? null
    }));
    return result;
  } finally {
    if (!args.keep) await context.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------

console.log("probe-targeting-drag-jump");
console.log(`  url:        ${args.url}${args.query ? `   query: ${args.query}` : ""}`);
console.log(`  recording:  ${recordingPath}`);
console.log(`  sweep:      y=${args.sweepY} design, every ${args.step} client-px, ${args.gapMs}ms apart`);
console.log(`  press:      (${args.pressX}, ${args.pressY}) design`);

const LEGS = [
  // `wide-hover` samples FASTER than the hover-probe memo's bound (HOVER_REPROBE_PX/MS), so most of its flushes
  // replay the memoized field affine — the real behaviour of a moving mouse. `wide-hover-fresh` waits the memo out
  // (gap > HOVER_REPROBE_MS) so EVERY flush is a fresh elementsFromPoint probe: the two legs together separate a
  // field-replay discontinuity from a fresh-probe one.
  { name: "wide-hover", viewport: { width: args.width, height: 1080 }, drag: false },
  { name: "wide-hover-fresh", viewport: { width: args.width, height: 1080 }, drag: false, gapMs: 140 },
  { name: "wide-drag", viewport: { width: args.width, height: 1080 }, drag: true },
  { name: "control-drag", viewport: { width: 1920, height: 1080 }, drag: true }
];

const browser = await chromium.launch({ args: ["--disable-gpu"] });
const results = [];
for (const leg of LEGS) {
  process.stdout.write(`  running ${leg.name}... `);
  const r = await runLeg(browser, leg);
  results.push(r);
  console.log(r.errors.length ? `ERROR: ${r.errors.join("; ")}` : "ok");
}
if (!args.keep) await browser.close();

console.log("");
console.log("leg           viewport     factor   samples  medStep  stepJumpMax  >5   >20  trackErrMax  dead");
console.log("------------  -----------  -------  -------  -------  -----------  ---  ---  -----------  ----");
for (const r of results) {
  const c = (v, w) => String(v ?? "-").padEnd(w);
  console.log(
    `${c(r.leg, 14)}${c(r.viewport, 13)}${c(r.spreadFactor, 9)}${c(r.matched, 9)}${c(r.medianStep, 9)}` +
      `${c(r.stepJumpMax, 13)}${c(r.jumpsOver5, 5)}${c(r.jumpsOver20, 5)}${c(r.trackErrMax, 13)}${c(r.deadZone, 6)}`
  );
}
for (const r of results) {
  if (r.pressPainter) console.log(`\n  ${r.leg}: press painter ${r.pressPainter.type}#${r.pressPainter.id} mode=${r.pressPainter.mode} dx=${round(r.pressPainter.dx, 2)} w=${r.pressPainter.w}`);
  if (r.stamps?.length) {
    console.log(`  ${r.leg}: ${r.stamps.length} view-scale stamp(s) live:`);
    for (const s of r.stamps.slice(0, 6)) {
      console.log(`      k=${s.k} group=${s.isGroup} scaled x[${round(s.scaledBox.minX, 1)},${round(s.scaledBox.maxX, 1)}] y[${round(s.scaledBox.minY, 1)},${round(s.scaledBox.maxY, 1)}]` +
        (s.renderedBox ? ` rendered x[${round(s.renderedBox.minX, 1)},${round(s.renderedBox.maxX, 1)}]` : ""));
    }
  }
  if (r.nearMissPasses !== undefined) {
    console.log(
      `  ${r.leg}: near-miss passes ${r.nearMissPasses}/${r.matched}, pushes ${r.nearMissPushes}, ` +
        `offender flips ${r.nearMissOffenderFlips}, hysteresis-seeded ${r.nearMissSeeded}`
    );
  }
  if (r.worstSteps?.length) {
    console.log(`  ${r.leg}: worst adjacent-sample jumps (design px of sent-X movement over one ${args.step}px pointer step):`);
    for (const s of r.worstSteps) console.log(`      at designX ${s.designX}: dSent ${s.dSent} (excess ${s.excess})  painter ${s.from} → ${s.to}`);
  }
}

const outFile = resolve(outDir, `${args.tag}.json`);
writeFileSync(outFile, JSON.stringify({ args: { ...args }, results }, null, 1));
console.log(`\n  per-sample trace: ${outFile}`);
console.log(`PROBE_RESULT ${JSON.stringify({
  ok: results.every((r) => r.errors.length === 0),
  legs: results.map((r) => ({
    leg: r.leg, spreadFactor: r.spreadFactor, matched: r.matched, medianStep: r.medianStep,
    stepJumpMax: r.stepJumpMax, jumpsOver5: r.jumpsOver5, jumpsOver20: r.jumpsOver20,
    trackErrMax: r.trackErrMax, deadZone: r.deadZone,
    nearMissPushes: r.nearMissPushes ?? null, nearMissOffenderFlips: r.nearMissOffenderFlips ?? null,
    errors: r.errors
  }))
})}`);
process.exit(results.some((r) => r.errors.length) ? 1 : 0);
