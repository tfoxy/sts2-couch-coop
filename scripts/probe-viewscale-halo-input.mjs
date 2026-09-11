#!/usr/bin/env node
// The wide-screen FALSE-HALO input probe: does hovering BESIDE a view-scale-enlarged ancient-event option row
// still resolve INTO that row?
//
// THE BUG (fixed by the renderedBox guard — viewScaleInverse.ts / mirrorRenderer.buildViewScaleInputStamps /
// inputCapture.applyViewScaleInverse). The web applies the view-scale inverse LAST, to an already-resolved GAME
// point. On a wider-than-16:9 stage that ordering can invent a halo hit: BESIDE the enlarged options no
// `data-paints` element anchors the pointer map, so mapPointerToGame falls back to the uniform SQUEEZE
// (`designX·1920/designW`), which drops the centred content's spread shift (dx). The squeezed game X lands inside
// the option group's ScaledBox anyway, and the inverse then CONTRACTS it into an option row the pointer was never
// over — hovering/tapping empty space beside the plaque focused/activated an option. The guard requires the RAW
// widened-design pointer to be inside the stamp's ON-STAGE renderedBox (ScaledBox + spreadDx on X) before any
// stamp may remap; `?viewScaleRenderedGate=off` turns it back off.
//
// WHAT THIS SCRIPT DOES. It replays a recorded ancient-event scene-delta stream into a REAL headless Chromium
// running the ACTUAL mirror page (the WebSocket is faked in-page, exactly like scripts/bench-mirror-replay.mjs, so
// no live game is needed), then CDP-sweeps real `mouseMoved` events left→right across the option-row band and
// RECORDS what the page put on the wire for each sweep position (the fake WS's send() captures every hover/click).
//
//   # 1. start a dev server serving THE CODE UNDER TEST:
//   cd frontend && npm run dev -- --port 5174 --strictPort
//   # 2. run the probe:
//   node scripts/probe-viewscale-halo-input.mjs --url http://127.0.0.1:5174 \
//        --recording /abs/path/to/.sts2/bench/audit-event-enter.ndjson
//
// MODES (each a fresh context/page):
//   wide      2214x1080, guard ON  — assertions A + B
//   wide-off  2214x1080, `?viewScaleRenderedGate=off` — assertion C: it MUST violate A (harness sensitivity; this
//             is the pre-fix repro, so no git juggling is needed to prove the probe can see the bug)
//   control   1920x1080, guard ON  — assertions A + B + D
//
// ASSERTIONS:
//   A  every sweep x whose designX is OUTSIDE the renderedBox (±SLACK design-px, covering the near-miss ±1 push)
//      must NOT send a coordinate inside the stamp's originalBox (the true option row)
//   B  sweep x well INSIDE the renderedBox at row height DOES send a coordinate inside originalBox (the remap is
//      still alive — the guard subtracts false hits only)
//   C  the `viewScaleRenderedGate=off` re-run produces >= 1 violation of A
//   D  at 1920x1080 every outside-renderedBox sweep coordinate equals the pure fraction mapping (no remap at all)
//
// Exits non-zero if any required assertion fails.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    url: process.env.COUCHCOOP_PROBE_URL ?? "http://127.0.0.1:5174",
    recording: process.env.COUCHCOOP_PROBE_RECORDING ?? ".sts2/bench/audit-event-enter.ndjson",
    step: 8, // client-px between sweep samples
    gapMs: 16, // ~60Hz, one animation frame apart (hover sends are rAF-coalesced)
    settleMs: 800, // quiet time after the stream finishes before the stamps are read
    slack: 2, // design-px tolerance around the renderedBox edges (the near-miss pass pushes by ±1)
    keep: false, // keep the browser open on failure (debugging)
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
      case "--step": a.step = Number(val()); break;
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
  console.log(`probe-viewscale-halo-input.mjs — CDP hover sweep across a view-scale halo, on the REAL mirror page

  --url <origin>      dev server serving the code under test (default http://127.0.0.1:5174,
                      env COUCHCOOP_PROBE_URL). Start it with:
                        cd frontend && npm run dev -- --port 5174 --strictPort
  --recording <path>  NDJSON scene-delta recording, absolute or relative to the repo root
                      (default .sts2/bench/audit-event-enter.ndjson, env COUCHCOOP_PROBE_RECORDING)
  --step <px>         client-px between sweep samples (default 8)
  --gap <ms>          ms between sweep samples (default 16 — one frame; hovers are rAF-coalesced)
  --settle <ms>       quiet ms after the stream finishes before reading the stamps (default 800)
  --slack <px>        design-px tolerance around the renderedBox edges (default 2)
  --keep              leave the browser open after a failure
  --help

Prints a per-mode summary table and a machine-readable "PROBE_RESULT {json}" line. Non-zero exit on failure.`);
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
// in-page fake WebSocket + input recorder (injected BEFORE any page script via addInitScript)
// ---------------------------------------------------------------------------------------------------------
//
// Same shape as bench-mirror-replay.mjs's fake WS (recorded pacing, join → directView, ping → pong), with ONE
// addition: send() no longer swallows input — it parses every `{type:"input"}` frame and pushes
// {kind, button, coordX, coordY, t} onto window.__probeSentInputs. That array IS the probe's evidence: it is
// exactly what the real client would have put on the wire to the game.

function probeWebSocketInit(config) {
  const OPEN = 1;
  const realFetch = window.fetch.bind(window);

  window.__probeSentInputs = [];
  window.__probeMarks = [];
  window.__probeMark = (i) => {
    window.__probeMarks.push({ i, t: performance.now() });
  };
  window.__probeStreamDone = false;

  class ProbeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;

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
      this._closed = false;
      window.__probeWs = this;
      if (this.url.includes("/ws")) {
        this._start();
      }
    }

    async _start() {
      let text = "";
      try {
        const res = await realFetch(config.recordingUrl);
        text = await res.text();
      } catch (e) {
        this._fail("recording fetch failed: " + e);
        return;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.meta) continue;
        if (typeof obj.data !== "string") continue;
        if (obj.data.includes('"type":"server-reload"')) continue; // dev-reload signal — strip
        this._msgs.push({ t: typeof obj.t === "number" ? obj.t : 0, data: obj.data });
      }
      if (this._closed) return;
      this.readyState = OPEN;
      this._emit("open", new Event("open"));
      // A passive recording carries no directView session, so the mirror would sit on the join picker.
      if (config.synthesizeDirectView) {
        this._deliver('{"type":"session","directView":true}');
      }
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

    _deliver(data) {
      this._emit("message", new MessageEvent("message", { data }));
    }

    _emit(type, event) {
      const handler = this["on" + type];
      if (typeof handler === "function") {
        try { handler.call(this, event); } catch { /* listener threw — keep going */ }
      }
      this.dispatchEvent(event);
    }

    _fail(reason) {
      this.readyState = 3;
      window.__probeWsError = reason;
      this._emit("error", new Event("error"));
    }

    send(data) {
      let msg = null;
      try { msg = JSON.parse(data); } catch { return; }
      const type = msg && msg.type;
      if (type === "scene-ack") return;
      if (type === "join") {
        this._deliver('{"type":"session","directView":true}');
        return;
      }
      if (type === "ping") {
        const echo = { type: "pong", t0: msg.t0 };
        if (msg.mainThread) echo.mainThread = true;
        this._deliver(JSON.stringify(echo));
        return;
      }
      // THE PROBE'S EVIDENCE: record every resolved input the client would have sent the game.
      if (type === "input" && (msg.kind === "hover" || msg.kind === "click")) {
        window.__probeSentInputs.push({
          kind: msg.kind,
          button: msg.button ?? null,
          pressed: msg.pressed ?? null,
          coordX: msg.coordX ?? null,
          coordY: msg.coordY ?? null,
          t: performance.now()
        });
        return;
      }
      // settings / anything else — swallow (never reaches a game).
    }

    close() {
      this._closed = true;
      this.readyState = 3;
      this._emit("close", new CloseEvent("close"));
    }
  }

  window.WebSocket = ProbeWebSocket;
}

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

const round = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const inBox = (b, x, y) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;

// The stage geometry the input path itself uses: the SCALED client rect (inputCapture.stageRect) plus the
// UNSCALED layout width, which is exactly MirrorView's `design.w` (stageStyle sets `width: ${design.w}px`).
async function readStage(page) {
  return page.evaluate(() => {
    const s = document.querySelector(".mirror-stage");
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, designW: s.offsetWidth, designH: s.offsetHeight };
  });
}

// The ancient-event OPTION GROUP stamp: the isGroup stamp scaled by ~1.2. Ties (a screen with several) break on
// area — the options container is the big one.
async function readOptionStamp(page) {
  return page.evaluate(() => {
    const get = window.__mirrorViewScaleInputStamps;
    if (typeof get !== "function") return { error: "window.__mirrorViewScaleInputStamps seam missing" };
    const all = get();
    if (!Array.isArray(all)) return { error: "seam did not return an array" };
    const area = (b) => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
    const cands = all.filter((s) => s.isGroup && Math.abs(s.channel.k - 1.2) < 0.001);
    cands.sort((a, b) => area(b.originalBox) - area(a.originalBox));
    return { count: all.length, stamp: cands[0] ?? null, all: all.map((s) => ({ k: s.channel.k, isGroup: s.isGroup, originalBox: s.originalBox })) };
  });
}

// ---------------------------------------------------------------------------------------------------------
// one mode
// ---------------------------------------------------------------------------------------------------------

async function runMode(browser, mode) {
  const context = await browser.newContext({ viewport: mode.viewport });
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

  const result = { mode: mode.name, viewport: `${mode.viewport.width}x${mode.viewport.height}`, url: pageUrl, errors: [] };
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
    if (!stage || stage.width <= 0) {
      result.errors.push("no .mirror-stage rect");
      return result;
    }
    const found = await readOptionStamp(page);
    if (found.error) {
      result.errors.push(found.error);
      return result;
    }
    if (!found.stamp) {
      result.errors.push(`no isGroup k=1.2 view-scale stamp on screen (registry has ${found.count}: ${JSON.stringify(found.all)})`);
      return result;
    }

    const s = found.stamp;
    const renderedBox = s.renderedBox ?? s.scaledBox; // pre-guard builds have no renderedBox
    result.stage = { ...stage };
    result.stamp = { k: s.channel.k, originalBox: s.originalBox, scaledBox: s.scaledBox, renderedBox: s.renderedBox ?? null };
    result.spreadDx = round(renderedBox.minX - s.scaledBox.minX, 3);

    // Sweep at the RENDERED row height: the vertical centre of the on-stage (enlarged) box. Its inverse is the
    // centre of the true box, so a genuine halo hit there lands on a real option row.
    const rowDesignY = (renderedBox.minY + renderedBox.maxY) / 2;
    const clientY = stage.top + (rowDesignY / stage.designH) * stage.height;
    const toDesignX = (clientX) => ((clientX - stage.left) / stage.width) * stage.designW;
    result.rowDesignY = round(rowDesignY, 2);

    // Reset the recorder, then sweep left→right across the whole stage in `--step` client-px, marking each
    // sample so the sends can be attributed back to the pointer position that produced them.
    await page.evaluate(() => { window.__probeSentInputs.length = 0; window.__probeMarks.length = 0; });
    const samples = [];
    for (let clientX = Math.ceil(stage.left) + 1; clientX < stage.left + stage.width - 1; clientX += args.step) {
      const i = samples.length;
      samples.push({ i, clientX, designX: toDesignX(clientX) });
      await page.evaluate((k) => window.__probeMark(k), i);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: clientX, y: clientY });
      await page.waitForTimeout(args.gapMs);
    }
    await page.waitForTimeout(200); // let the last coalesced hover flush
    const { sent, marks } = await page.evaluate(() => ({ sent: window.__probeSentInputs, marks: window.__probeMarks }));

    // Attribute each sample to the LAST hover sent at/after its own mark and before the next one's.
    const hovers = sent.filter((m) => m.kind === "hover");
    for (const smp of samples) {
      const from = marks.find((m) => m.i === smp.i)?.t ?? Infinity;
      const next = marks.find((m) => m.i === smp.i + 1)?.t ?? Infinity;
      const window_ = hovers.filter((h) => h.t >= from && h.t < next);
      smp.sent = window_.length > 0 ? window_[window_.length - 1] : null;
    }

    // ---- assertions -----------------------------------------------------------------------------------------
    const orig = s.originalBox;
    const outside = samples.filter((p) => p.sent && (p.designX < renderedBox.minX - args.slack || p.designX > renderedBox.maxX + args.slack));
    const inside = samples.filter((p) => p.sent && p.designX > renderedBox.minX + 0.15 * (renderedBox.maxX - renderedBox.minX) && p.designX < renderedBox.maxX - 0.15 * (renderedBox.maxX - renderedBox.minX));

    const violationsA = outside.filter((p) => inBox(orig, p.sent.coordX, p.sent.coordY));
    const hitsB = inside.filter((p) => inBox(orig, p.sent.coordX, p.sent.coordY));
    // D: outside the renderedBox nothing should remap at all — the sent x IS the pure fraction mapping. Only
    // meaningful where design space === game space (16:9); on a widened stage the anchor map legitimately shifts.
    const violationsD = stage.designW === 1920 ? outside.filter((p) => Math.abs(p.sent.coordX - p.designX) > args.slack) : [];

    result.samples = samples.length;
    result.matched = samples.filter((p) => p.sent).length;
    result.outside = outside.length;
    result.inside = inside.length;
    result.violationsA = violationsA.length;
    result.hitsB = hitsB.length;
    result.violationsD = violationsD.length;
    result.worstA = violationsA
      .slice(0, 4)
      .map((p) => ({ clientX: round(p.clientX, 1), designX: round(p.designX, 1), sentX: round(p.sent.coordX, 2), sentY: round(p.sent.coordY, 2) }));
    result.sampleB = hitsB
      .slice(0, 2)
      .map((p) => ({ clientX: round(p.clientX, 1), designX: round(p.designX, 1), sentX: round(p.sent.coordX, 2), sentY: round(p.sent.coordY, 2) }));
    return result;
  } finally {
    if (!args.keep) {
      await context.close();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------

console.log("probe-viewscale-halo-input");
console.log(`  url:        ${args.url}`);
console.log(`  recording:  ${recordingPath}`);
console.log(`  sweep:      every ${args.step} client-px, ${args.gapMs}ms apart, slack ${args.slack} design-px`);
console.log(`  directView: ${hasRecordedDirectView ? "in recording" : "SYNTHESIZED"}`);

const MODES = [
  { name: "wide", viewport: { width: 2214, height: 1080 }, query: "" },
  { name: "wide-off", viewport: { width: 2214, height: 1080 }, query: "&viewScaleRenderedGate=off" },
  { name: "control", viewport: { width: 1920, height: 1080 }, query: "" }
];

const browser = await chromium.launch({ args: ["--disable-gpu"] });
const results = [];
for (const mode of MODES) {
  process.stdout.write(`  running ${mode.name}... `);
  const r = await runMode(browser, mode);
  results.push(r);
  console.log(r.errors.length ? `ERROR: ${r.errors.join("; ")}` : "ok");
}
if (!args.keep) {
  await browser.close();
}

// ---- report ----------------------------------------------------------------------------------------------

const byName = Object.fromEntries(results.map((r) => [r.mode, r]));
console.log("");
console.log("mode      viewport   dx     samples  matched  outside  inside  A-violations  B-hits  D-violations");
console.log("--------  ---------  -----  -------  -------  -------  ------  ------------  ------  ------------");
for (const r of results) {
  const cell = (v, w) => String(v ?? "-").padEnd(w);
  console.log(
    `${cell(r.mode, 10)}${cell(r.viewport, 11)}${cell(r.spreadDx, 7)}${cell(r.samples, 9)}${cell(r.matched, 9)}` +
      `${cell(r.outside, 9)}${cell(r.inside, 8)}${cell(r.violationsA, 14)}${cell(r.hitsB, 8)}${cell(r.violationsD, 12)}`
  );
}
for (const r of results) {
  if (r.stamp) {
    console.log(
      `\n  ${r.mode}: stamp k=${r.stamp.k} original x[${round(r.stamp.originalBox.minX, 1)},${round(r.stamp.originalBox.maxX, 1)}] ` +
        `y[${round(r.stamp.originalBox.minY, 1)},${round(r.stamp.originalBox.maxY, 1)}]  scaled x[${round(r.stamp.scaledBox.minX, 1)},${round(r.stamp.scaledBox.maxX, 1)}]  ` +
        `rendered x[${r.stamp.renderedBox ? round(r.stamp.renderedBox.minX, 1) : "n/a"},${r.stamp.renderedBox ? round(r.stamp.renderedBox.maxX, 1) : "n/a"}]  rowY=${r.rowDesignY}`
    );
  }
  if (r.worstA?.length) {
    console.log(`  ${r.mode}: A-violations (pointer beside the plaque resolved INTO the option row):`);
    for (const v of r.worstA) console.log(`      designX ${v.designX} → sent (${v.sentX}, ${v.sentY})`);
  }
  if (r.sampleB?.length) {
    console.log(`  ${r.mode}: B-hits (pointer ON the enlarged plaque still remaps onto the row):`);
    for (const v of r.sampleB) console.log(`      designX ${v.designX} → sent (${v.sentX}, ${v.sentY})`);
  }
}

// ---- verdict ---------------------------------------------------------------------------------------------

const failures = [];
for (const r of results) {
  if (r.errors.length) failures.push(`${r.mode}: ${r.errors.join("; ")}`);
}
for (const name of ["wide", "control"]) {
  const r = byName[name];
  if (!r || r.errors.length) continue;
  if (r.outside === 0) failures.push(`${name}: no sweep sample landed outside the renderedBox (probe is blind)`);
  if (r.violationsA > 0) failures.push(`${name}: A FAILED — ${r.violationsA} sample(s) beside the plaque resolved into the option row`);
  if (r.hitsB === 0) failures.push(`${name}: B FAILED — no sample on the enlarged plaque remapped into the option row (the inverse is dead)`);
}
{
  const r = byName["control"];
  if (r && !r.errors.length && r.violationsD > 0) {
    failures.push(`control: D FAILED — ${r.violationsD} outside-sample(s) did not equal the pure fraction mapping`);
  }
}
{
  const r = byName["wide-off"];
  if (!r || r.errors.length) {
    failures.push("wide-off: could not run the kill-switch repro");
  } else if (r.violationsA === 0) {
    failures.push("wide-off: C FAILED — the ?viewScaleRenderedGate=off run produced NO A-violation, so this probe cannot see the bug it claims to guard");
  }
}

console.log("");
console.log(`PROBE_RESULT ${JSON.stringify({ ok: failures.length === 0, modes: results.map((r) => ({ mode: r.mode, viewport: r.viewport, spreadDx: r.spreadDx, samples: r.samples, matched: r.matched, outside: r.outside, inside: r.inside, violationsA: r.violationsA, hitsB: r.hitsB, violationsD: r.violationsD, errors: r.errors })) })}`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.error(`FAIL  ${f}`);
  process.exit(1);
}
console.log("PASS  A (no false halo) + B (remap alive) on wide & control, C (kill-switch reproduces the bug), D (16:9 pure fraction mapping)");
