#!/usr/bin/env node
// Card-trail visual probe — replays a RECORDED mirror stream into the real mirror page, pauses it at a chosen
// moment of a card flight, and screenshots. No live game, no live lock: the recording already contains a real
// card-fly (the trail root's transform per delta + the two `NCardTrail` nodes' counter-transforms), which is
// exactly and only the data the client-side trail synthesis consumes (see frontend/src/mirror/cardTrail.ts).
//
// It exists because the synthesis has ONE tunable that has to be judged by eye — how much of the flight the
// comet covers — and iterating that against a live game costs a QA-lock session per attempt.
//
//   # dev server serving the code under test:
//   cd frontend && npx vite --port 5199 --strictPort
//   # then:
//   node scripts/probe-card-trail-replay.mjs \
//     --url http://127.0.0.1:5199 \
//     --recording .sts2/bench/combat-modern-2026-08-06.ndjson \
//     --at 10450 --out .sts2/artifacts/card-trail/web-midflight.png
//
// `--at` is the recorded-stream timestamp (ms) to stop at; the fake socket delivers at RECORDED pace up to it,
// so point ages — and therefore the trail's length — are the same ones a live viewer would see.
// `--query` appends to the page URL.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { dirname, resolve } from "node:path";
import { RECOVERED_RESOURCE_ROOT, REPO_ROOT } from "./lib/repo-layout.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");


// `--res-root` — where real game assets are read from, the same local extracted-resource root
// `scripts/bench-mirror-replay.mjs` and `scripts/probe-particle-vfx-replay.mjs` serve `/res/**` out of.
//
// WHY A TRAIL PROBE GREW ONE (R17). The trails this probe was built for are SVG strokes, so they render
// perfectly against a dead `/res` proxy — which is why it never needed assets. PARTICLES do not: with every
// sprite 404ing, gsw holds a 1x1 transparent placeholder, the emitter paints nothing, and — the part that
// silently voids a comparison rather than merely emptying it — `staticFrameKeyFor` REFUSES to key a binding
// whose texture has not decoded, so the frozen-still path under test cannot engage at all. Both arms would then
// render the same nothing and the grid would report RMSE 0, i.e. "no visual difference", for a mechanism that
// never ran. Any arm that involves particles must pass this.
const DEFAULT_RES_ROOT = RECOVERED_RESOURCE_ROOT;
const RES_CONTENT_TYPES = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml"
};

function parseArgs(argv) {
  const a = {
    url: "http://127.0.0.1:5199",
    recording: ".sts2/bench/combat-modern-2026-08-06.ndjson",
    at: 10450,
    out: ".sts2/artifacts/card-trail/web-midflight.png",
    query: "",
    width: 1920,
    height: 1080,
    settleMs: 400,
    resRoot: null,
    // Accept the pre-T0 behaviour on a canvas arm that cannot snapshot: write the DOM-overlay-only page
    // screenshot and exit 0. Off by default — see the capture block at the bottom.
    allowBlankShot: false,
    // `--age <ms>` — capture at a chosen point of the comet's own DECAY rather than after a flat settle. See
    // the age-gate block below; 0 (the default) is the settle-only `--settle` behavior.
    ageMs: 0,
    ageTimeoutMs: 4000
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
    else if (k === "--allow-blank-shot") a.allowBlankShot = true;
    else if (k === "--age") a.ageMs = Number(next());
    else if (k === "--age-timeout") a.ageTimeoutMs = Number(next());
    else if (k === "--res-root") {
      // Bare `--res-root` means the default resource root; a following non-flag word is a custom root.
      const peek = argv[i + 1];
      a.resRoot = inline !== undefined ? inline : peek != null && !peek.startsWith("--") ? argv[++i] : DEFAULT_RES_ROOT;
    }
  }
  return a;
}

// The in-page fake socket: same contract as scripts/bench-mirror-replay.mjs's, minus the pacing modes, plus a
// hard STOP at `stopAtT` so the page can be screenshotted at a deterministic point of the stream.
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

const args = parseArgs(process.argv);
const recordingPath = resolve(REPO_ROOT, args.recording);
const recordingText = readFileSync(recordingPath, "utf8");
requireReproHeader(recordingText, recordingPath);
const outPath = resolve(REPO_ROOT, args.out);
mkdirSync(dirname(outPath), { recursive: true });

// `PROBE_CHROME_ARGS` — extra launch flags, space-separated (the bench's `COUCHCOOP_BENCH_CHROME_ARGS`
// shape). The canvas stage needs a GL context, and which backend headless Chromium lands on is a launch-flag
// question: `--disable-gpu` pins SwiftShader, `--use-angle=vulkan` reaches the real adapter. See the note
// above the canvas block below for what this probe can and cannot currently prove about that arm.
//
// `PROBE_HEADED=1` — launch a REAL window (needs a display), the bench's `--headed` in this probe's terms.
// It exists because a HEADLESS canvas-arm screenshot on this box captures the DOM overlay and none of the
// stage's pixels (see the canvas block below): any visual claim about the stage must come from a headed run,
// and until this flag the probe could not produce one. Pair it with PROBE_CHROME_ARGS="--use-angle=vulkan" —
// headed alone still leaves the GL backend on ANGLE's default.
const browser = await chromium.launch({
  headless: process.env.PROBE_HEADED !== "1",
  args: ["--no-sandbox", ...(process.env.PROBE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean)]
});
const context = await browser.newContext({ viewport: { width: args.width, height: args.height } });

// Serve the recording to the page from disk (the dev server has no route for .sts2/).
await context.route("**/__probe_recording", (route) =>
  route.fulfill({ status: 200, contentType: "text/plain", body: recordingText })
);

// Real asset bytes, when asked for (see DEFAULT_RES_ROOT). Misses are COUNTED and reported, never silently
// swallowed: an arm whose textures all 404 must be visible as such rather than read as "the effect is subtle".
let resHits = 0;
const resMisses = new Set();
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
await context.addInitScript(fakeWebSocketInit, {
  recordingUrl: "/__probe_recording",
  stopAtT: args.at
});

// THE FRAME PUMP, lifted from scripts/probe-eager-scroll.mjs (read its note there for the measurements).
//
// A headless Chromium produces compositor frames on DAMAGE, and rAF callbacks ride those frames. The canvas
// stage PARKS: between builds its canvas is unchanged, nothing is damaged, and the frame interval backs off
// (measured 126ms → 248 → 533 → 716 after a single gesture). A parked stage does not age its ribbons on the
// display's schedule, so the age gate below could never be satisfied — and on a real display the problem does
// not exist, because the compositor ticks at vsync whether or not anyone damaged anything.
//
// It moves one 1px marker per frame and nothing else. Every number this probe reports comes from the
// renderer's own state, never from the marker.
async function startFramePump(target) {
  await target.evaluate(() => {
    const marker = document.createElement("div");
    marker.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647;background:#000";
    document.body.appendChild(marker);
    let i = 0;
    const tick = () => {
      marker.style.opacity = i++ % 2 ? "0.01" : "0.02";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const page = await context.newPage();
const pageUrl = `${args.url.replace(/\/$/, "")}/${args.query ? `?${args.query}` : ""}`;
await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__probeStopped !== undefined, null, { timeout: 60000 });
await startFramePump(page);

// THE AGE GATE (R5 T-DR5) — capture at a chosen point of the COMET'S OWN DECAY.
//
// `--at` stops the stream at a recorded millisecond, which fixes where the card is. It does NOT fix what the
// ribbon looks like: a trail is a decaying record of motion whose every point dies 800 ms after it was laid
// down, so what is on screen depends on how long the page has been running FREE since the stream stopped. The
// old flat `--settle 400` is half a ribbon lifetime of that, and the two arms age on different clocks — which
// is how the round-4 comparison ended up diffing a canvas ribbon at one phase against a DOM ribbon at another
// and reporting the difference as fidelity.
//
// So: wait until the head has STOPPED MOVING (consecutive polls at the same position — the card has landed and
// the ribbon is now purely decaying) and then until `--age` ms have passed SINCE THE LAST POINT WAS LAID DOWN.
// Both arms then hold the same picture by construction rather than by luck.
//
// THE ANCHOR IS THE HEAD'S AGE, not the tail's, and the difference is the whole gate. The tail is already ~800
// ms old the moment the card lands — it is the next point to expire — so a tail-age target is satisfied
// instantly and then keeps being satisfied while the ribbon drains to nothing. The head's age starts at zero
// when the card stops and counts the decay from there, which is exactly the phase both arms have to share.
//
// `--age 0` keeps settle-only behavior, because a run that is not comparing arms does not need any of this.
// THE POLL RUNS IN THE PAGE, not over CDP, and that is a correctness property rather than a speed one. A
// round-tripped `page.evaluate` costs whatever the box is busy with — measured at ~700 ms per poll here with
// other work running — so an out-of-process poll cannot resolve a 100 ms target at all: it lands wherever the
// first round trip after the condition happens to fall, and the two arms land in different places. Polled on
// the page's own rAF, the gate fires on the FIRST frame the condition holds.
let ageGate = null;
if (args.ageMs > 0) {
  try {
    const handle = await page.waitForFunction(
      (target) => {
        const fn = window.__mirrorTrailProbe;
        const state = (window.__ccTrailGate ||= { stable: 0, lastHead: null, everAlive: false });
        const phase = typeof fn === "function" ? fn() : null;
        if (phase === null) {
          return false; // no trail backend is available for this capture
        }
        state.everAlive = state.everAlive || phase.strokes > 0;
        const head = phase.headX === null ? null : `${phase.headX.toFixed(2)},${phase.headY.toFixed(2)}`;
        state.stable = head !== null && head === state.lastHead ? state.stable + 1 : 0;
        state.lastHead = head;
        // Head STOPPED (the card has landed and the ribbon is purely decaying) and `target` ms have passed
        // since the last point was laid down. Returning the phase itself makes the captured value the one the
        // gate actually fired on, rather than a re-read taken a round trip later.
        return state.stable >= 2 && phase.strokes > 0 && phase.headAgeMs >= target ? phase : false;
      },
      args.ageMs,
      { timeout: args.ageTimeoutMs, polling: "raf" }
    );
    ageGate = { ok: true, reason: null, phase: await handle.jsonValue() };
  } catch {
    const everAlive = await page
      .evaluate(() => (window.__ccTrailGate ? window.__ccTrailGate.everAlive : false))
      .catch(() => false);
    const phase = await page
      .evaluate(() => (typeof window.__mirrorTrailProbe === "function" ? window.__mirrorTrailProbe() : null))
      .catch(() => null);
    ageGate = everAlive
      ? {
          ok: false,
          reason: `age ${args.ageMs}ms not reached in ${args.ageTimeoutMs}ms (last: ${JSON.stringify(phase)})`,
          phase
        }
      : {
          // Never a comet on this arm — the trails-off half of a corridor pair. The full window was waited out,
          // so the flight underneath has landed and the screen is settled, which is the whole requirement.
          ok: true,
          noComet: true,
          reason: null,
          phase
        };
  }
} else {
  await page.waitForTimeout(args.settleMs);
}

// THE CAPTURE (R5 T0). On the DOM arm this is the page screenshot it has always been. On the canvas arm a page
// screenshot captures the overlay and NONE of the stage — the context carries no `preserveDrawingBuffer`, so the
// drawing buffer is only defined until the end of the task that painted it and a capture is always a later task.
// `__mirrorCanvasSnapshot()` (paint-dump gated) reads it inside the painting task instead, which is the only
// moment the pixels exist to be read.
//
// A canvas arm that cannot answer REFUSES: exit 2 with a message, rather than leaving a blank PNG that every
// downstream comparer will read as "the ribbon is missing". `--allow-blank-shot` writes the page screenshot
// anyway (the pre-T0 behaviour) for the rare run that only wants the overlay.
async function takeCapture() {
  // Which arm, asked in ONE round trip so a DOM page pays nothing for a canvas-only question.
  const arm = await page
    .evaluate(() => {
      const stats = typeof window.__mirrorCanvasStats === "function" ? window.__mirrorCanvasStats() : null;
      if (!stats || stats.backend !== "canvas") return null;
      return { seam: typeof window.__mirrorCanvasSnapshot === "function", contextLost: !!stats.contextLost };
    })
    .catch(() => null);
  if (arm === null) {
    await page.screenshot({ path: outPath });
    return { refused: null };
  }
  const dataUrl =
    arm.seam && !arm.contextLost
      ? await page.evaluate(() => window.__mirrorCanvasSnapshot()).catch(() => null)
      : null;
  if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,")) {
    writeFileSync(outPath, Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"));
    // …and the DOM overlay beside it, so a text-bearing comparison still has its half.
    await page.screenshot({ path: outPath.replace(/\.png$/i, "") + ".overlay.png" }).catch(() => {});
    return { refused: null };
  }
  const refused = arm.contextLost
    ? "canvas context lost"
    : arm.seam
      ? "__mirrorCanvasSnapshot() declined (no scene, or toDataURL refused)"
      : "no __mirrorCanvasSnapshot() — add paintDump=1 to --query";
  if (args.allowBlankShot) {
    await page.screenshot({ path: outPath });
  }
  return { refused };
}

// CAPTURE FIRST, DIAGNOSE AFTER — and this ordering is load-bearing, not tidiness.
//
// A comet is gone 800 ms after the card stops, and every `page.evaluate` below costs a CDP round trip whose
// price is whatever else the machine is doing (measured at several hundred ms each on a busy box). Taking the
// diagnostics first and the picture afterwards therefore photographs a screen the numbers no longer describe:
// it is how the first version of this block produced an empty stage beside a census reporting 160 live trail
// commands. The picture is the perishable one, so it goes first.
const capture = await takeCapture();

const trails = await page.evaluate(() => {
  const els = [...document.querySelectorAll(".mirror-trail")];
  return els.map((el) => {
    const path = el.querySelector("path");
    const owner = el.closest("[data-node-id]");
    const d = path?.getAttribute("d") ?? null;
    return {
      nodeId: owner?.getAttribute("data-node-id") ?? null,
      nodeType: owner?.getAttribute("data-node-type") ?? null,
      points: d ? (d.match(/[ML]/g) || []).length : 0,
      hasGeometry: d != null,
      ownerStyle: owner instanceof HTMLElement ? owner.style.cssText : null
    };
  });
});

// THE CANVAS ARM'S OWN ANSWER (M3 WS-C). `trails` above walks `.mirror-trail` elements, of which the canvas
// backend has none: its comet is a run of quads inside the stage list. So a probe run with `?stage=canvas` would
// otherwise report `trails: []` and look exactly like a run where the ribbon was missing — the failure mode a
// harness must never have. This block reads what CAN answer on that arm, and reports null (not an empty list)
// when the page is not the canvas backend at all.
//
// THE HEADLESS CAPTURE GAP, AND WHAT CLOSED IT (measured Aug-27, fixed by R5 T0). A page screenshot of a
// canvas-arm run captures the DOM overlay and none of the stage's own pixels — a run whose executor reported
// 492 quads in 5 batches at 1920x1080 produced a PNG with nothing in it but text. The cause is not a missing
// paint: the GL context carries no `preserveDrawingBuffer`, so the drawing buffer is defined only until the end
// of the task that painted it, and a capture is always a later task. The renderer's `__mirrorCanvasSnapshot()`
// seam reads it INSIDE the painting task (see the capture block at the bottom of this file), which needs
// `paintDump=1` in `--query`. Without that query this probe now REFUSES the capture and exits 2 rather than
// leaving a blank PNG — a blank canvas-arm crop must never be read as "the ribbon is missing".
const canvasArm = await page.evaluate(() => {
  const stats = window.__mirrorCanvasStats?.();
  if (!stats) {
    return null;
  }
  const dump = window.__mirrorDrawListDump?.() ?? null;
  return {
    // THE ARM'S OWN LIVENESS, first. A canvas arm whose GL context never came up paints an empty stage and every
    // comparison against it reads as "the ribbon is missing" — the failure mode that silently voids a run. These
    // three are what say the stage drew at all before any trail number is worth reading.
    frames: stats.frames,
    commands: stats.commands,
    executorQuads: stats.quads,
    batches: stats.batches,
    backingStore: stats.backingStore,
    contextLost: stats.contextLost,
    // `null` here means no trail backend was available, which is distinct from a backend that drew nothing.
    trails: stats.trails ?? null,
    overlayTrailRecords: stats.overlayCounts?.trail ?? null,
    // Straight off the paint dump, so the number is the one the parity comparer's class (g) counts. Requires
    // `?paintDump=1`; null without it rather than 0, for the reason above.
    roleTrailCommands: dump ? dump.filter((l) => l.includes("role=trail")).length : null,
    // A HANDFUL OF ACTUAL LINES, for the same reason the liveness fields above are here: "396 trail commands"
    // and "396 trail commands that paint nothing" are the same number, and only the matrix, the colour and the
    // blend can tell them apart. A `fill` line rides along as the known-good reference.
    sampleLines: dump
      ? [...dump.filter((l) => l.includes("role=trail")).slice(0, 4), ...dump.filter((l) => l.includes("role=fill")).slice(0, 2)]
      : null
  };
});

const shotRefused = capture.refused;
console.log(
  JSON.stringify(
    {
      out: outPath,
      // Non-null when this run deliberately produced no stage capture — see the block above. A consumer that
      // reads a PNG without reading this can be looking at the overlay and calling it the stage.
      shotRefused,
      stoppedAtRecordedMs: await page.evaluate(() => window.__probeStopped),
      // THE COMET'S PHASE AT CAPTURE (R5 T-DR5), and whether the age gate was satisfied. `null` when `--age`
      // was not asked for. A comparer must read this before it diffs anything: two crops taken at different
      // points of an 800 ms decay are two different pictures, however equal the code that drew them.
      ageGate,
      trailPhase: await page.evaluate(() =>
        typeof window.__mirrorTrailProbe === "function" ? window.__mirrorTrailProbe() : null
      ),
      trails,
      canvas: canvasArm,
      // Provenance for any claim made off this screenshot: how many real asset bytes it actually painted with.
      // Absent when `--res-root` was not passed, which for a particle arm is itself the finding.
      res: args.resRoot ? { root: args.resRoot, hits: resHits, misses: [...resMisses].slice(0, 20), missCount: resMisses.size } : null
    },
    null,
    2
  )
);

await browser.close();

// An age gate that was ASKED FOR and not met is a failed run, for the same reason a refused capture is: the
// PNG exists and looks plausible, and every comparison made against it would be comparing decay phases.
if (ageGate !== null && !ageGate.ok) {
  console.error(`probe-card-trail-replay: --age ${args.ageMs} gate not satisfied — ${ageGate.reason}`);
  process.exit(3);
}

// A refused capture is a FAILED probe run: every consumer of this script (compare-card-trail.mjs above all)
// treats the PNG as the stage, and a silent zero exit would hand it the overlay to measure instead.
if (shotRefused !== null && !args.allowBlankShot) {
  console.error(
    `probe-card-trail-replay: canvas-arm capture refused (${shotRefused}) — no stage PNG written.\n` +
      `  Re-run with --query 'paintDump=1' (plus whatever else the arm needs), or pass --allow-blank-shot to\n` +
      `  accept the DOM-overlay-only screenshot the pre-T0 script produced.`
  );
  process.exit(2);
}
