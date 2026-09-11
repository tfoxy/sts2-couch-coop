#!/usr/bin/env node
// REPLAY a repro recording through the real mirror client — feed a "repro/1" file's recorded scene stream and
// recorded gestures back into a live browser, at the recorded pace, and capture what the hand does.
//
//   node scripts/replay-repro.mjs .sts2/repro/foo.ndjson --url http://127.0.0.1:5173/
//   node scripts/replay-repro.mjs <file> --url <dev> --around-markers        # stills + pose samples per marker
//   node scripts/replay-repro.mjs <file> --url <dev> --around-markers 1500,1500,50
//   node scripts/replay-repro.mjs <file> --url <dev> --freeze 41200 --keep   # pump to t, hold for devtools
//   node scripts/replay-repro.mjs <file> --url <dev> --speed 0.25            # slow the whole timeline down
//
// WHAT THIS ANSWERS that the analyzer cannot: the two hand bugs that are pure CLIENT RENDERING over a recorded
// wire — a focus handoff that jumps before it eases, and a card travelling further than it should. Both are
// decided entirely by code in this repo reacting to bytes that are already in the file, so both reproduce here,
// on screen, with no game and no phone. (The third bug — focus stops answering after a cancelled drag — splits:
// "the client didn't send" shows up in the divergence report at the end of this run, "the game didn't answer"
// shows up in analyze-repro.mjs.)
//
// IT NEVER BUILDS AND NEVER LAUNCHES A GAME. Point `--url` at a dev server the operator already started; the
// page is loaded with `repro=off` appended so a replay cannot recursively record itself.
//
// HOW THE STREAM GETS IN. An init script replaces `window.WebSocket` before any page script runs (the model is
// bench-mirror-replay.mjs's BenchWebSocket), so the mirror's own `new WebSocket(…/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0)` gets a fake
// that holds every recorded inbound frame until this process says go, then delivers them at their recorded
// offsets. Recorded `pong` and `server-reload` frames are dropped — the first is a reply to a ping this session
// never sent, the second would reload the page — and live `ping`s are answered here instead.
//
// HOW THE GESTURES GET IN. Over CDP, at the recorded offsets, on the SAME timeline as the stream: mouse events
// through `Input.dispatchMouseEvent`, touch through `Input.dispatchTouchEvent`, wheel through `mouseWheel`, keys
// through `Input.dispatchKeyEvent`. Both halves share one clock, which is the property that makes the whole idea
// work — a gesture landing one frame late against the stream is a different session.
//
// WHAT IS AND IS NOT DETERMINISTIC — read this before believing a negative result:
//   * SAME CHECKOUT. The recording carries the wire and the gestures, not the client. Replaying yesterday's file
//     against today's build is a comparison, not a reproduction.
//   * CANNED RESPONSES. Client sends are swallowed, never answered by a game. A flow that waits on an answer is
//     satisfied only because the RECORDED answer arrives at its own recorded offset. So a replay whose client
//     sends something the recording did not (or at a different moment) drifts from there on — which is exactly
//     what the divergence report at the end of the run is for.
//   * ±1 FRAME. rAF phase, layout timing and this process's scheduling all wobble by a frame or so. A one-frame
//     difference is noise; the bugs being chased are tens of frames wide.
//   * POINTER IDS ARE THE BROWSER'S. CDP assigns its own `pointerId`s; what is preserved is the IDENTITY mapping
//     (one recorded finger = one CDP touch point), not the recorded number.
//   * BOTH STAGES SAMPLE. `?stage=canvas` draws no per-node DOM, so the pose samples used to be empty there;
//     they now come from `window.__mirrorHandPoses()` (handPoseProbe.ts), which both backends install, and carry
//     the game pose beside the drawn one. The element walk remains only as a fallback for an older page.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { REPO_ROOT } from "./lib/mirror-probe.mjs";
import { requireReproHeader } from "./lib/repro-recording.mjs";

// Playwright is a frontend devDependency, resolved from there rather than from the repo root (precedent:
// scripts/bench-mirror-replay.mjs).
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

// The in-page fake fetches the inbound half from here; a Playwright route fulfils it from memory, so the file
// never has to be reachable by the dev server.
const FRAMES_PATH = "/__repro_frames__.ndjson";

// The mirror stamps every DOM node with its scene type; the hand's card holders are what every hand bug is
// about. Matched on the last dotted segment because `nodeType` is fully qualified on the wire
// (mirrorRenderer.ts's `nodeTypeLeaf`).
const HOLDER_SELECTOR = '[data-node-type$="NHandCardHolder"]';

// ===========================================================================================================
// args
// ===========================================================================================================

function parseArgs(argv) {
  const a = {
    file: null,
    url: null,
    speed: 1,
    aroundMarkers: null,
    marker: null,
    freeze: null,
    out: null,
    headed: false,
    keep: false,
    timeoutMs: 30000,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--url": a.url = argv[++i]; break;
      case "--speed": a.speed = Number(argv[++i]); break;
      case "--marker": a.marker = Number(argv[++i]); break;
      case "--freeze": a.freeze = Number(argv[++i]); break;
      case "--out": a.out = argv[++i]; break;
      case "--headed": a.headed = true; break;
      case "--keep": a.keep = true; break;
      case "--timeout": a.timeoutMs = Number(argv[++i]); break;
      case "--around-markers": {
        // Optional `pre,post,step` (ms). Bare = the defaults, which bracket a marker by a second either side at
        // 100ms — ~21 stills, enough to see an ease and cheap enough to run on every marker in a file.
        const next = argv[i + 1];
        const spec = next && !next.startsWith("--") ? argv[++i] : "";
        const [pre = 1000, post = 1000, step = 100] = spec.split(",").map(Number).filter((n) => Number.isFinite(n));
        a.aroundMarkers = { pre, post, step };
        break;
      }
      case "-h":
      case "--help": a.help = true; break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
        a.file = arg;
    }
  }
  return a;
}

const HELP = `replay-repro.mjs — replay a "repro/1" recording through the real mirror client

  <file>                     the .ndjson written by the in-browser repro recorder
  --url <dev>                a dev server ALREADY RUNNING (this never builds; required)
  --around-markers [p,q,s]   capture stills + hand poses from marker-p to marker+q every s ms
                             (default 1000,1000,100)
  --marker <n>               only that marker
  --freeze <ms>              pump the timeline to <ms> and stop there (pair with --keep)
  --speed <f>                scale the one shared timeline (0.25 = quarter speed)
  --out <dir>                artifact root (default .sts2/artifacts/repro/<file stem>)
  --headed                   a real window
  --keep                     leave the browser open when the run ends
  --timeout <ms>             how long to wait for the mirror stage to appear (default 30000)
`;

// ===========================================================================================================
// loading
// ===========================================================================================================

function loadRepro(path) {
  const abs = resolve(REPO_ROOT, path);
  const text = readFileSync(abs, "utf8");
  const raw = text.split("\n");
  let meta = requireReproHeader(text, abs);
  const inbound = [];   // {t, data} — the host's stream
  const outbound = [];  // {t, type, requestId, data} — what the RECORDED client sent (the divergence baseline)
  const input = [];     // pointer / wheel / key lines, in order
  const markers = [];
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i]) continue;
    let obj;
    try { obj = JSON.parse(raw[i]); } catch { continue; }
    if (i === 0) continue;
    const t = typeof obj.t === "number" ? obj.t : 0;
    if (obj.dir === "out" && typeof obj.data === "string") {
      let parsed = null;
      try { parsed = JSON.parse(obj.data); } catch { /* keep it as text */ }
      outbound.push({ t, type: parsed?.type ?? "?", key: sendKey(parsed), requestId: parsed?.requestId ?? null, parsed, data: obj.data });
      continue;
    }
    if (typeof obj.data === "string") {
      // A recorded `pong` answers a ping THIS session never sent, and a `server-reload` would reload the page
      // out from under the replay. Neither is part of the reproduction.
      if (obj.data.includes('"type":"pong"') || obj.data.includes('"type":"server-reload"')) continue;
      inbound.push({ t, data: obj.data });
      continue;
    }
    if (obj.kind === "pointer" || obj.kind === "wheel" || obj.kind === "key") { input.push({ ...obj, t }); continue; }
    if (obj.kind === "marker") markers.push({ n: obj.n, t, note: obj.note });
  }
  if (markers.length === 0 && Array.isArray(meta.markers)) {
    for (const m of meta.markers) markers.push({ n: m.n, t: m.t, note: m.note });
  }
  const seeded = seedInbound(inbound);
  return { abs, meta, inbound: seeded.inbound, seed: seeded.seed, outbound, input, markers };
}

// START AT THE KEYFRAME. A delta patches the map a `full:true` keyframe established; fed a stream that begins in
// the middle, every id in it addresses a node that was never introduced. That is
// not a hypothetical: the first phone recording of the canvas hand-landing bug was a wrapped 32 MB ring with no
// keyframe in it at all, and it replayed as 363 identical throws.
//
// So the frames BEFORE the first keyframe are dropped from the stream (they are unreplayable by construction),
// and their absence is reported rather than papered over. Timestamps are untouched: this omits frames, it does
// not re-base the timeline, so the gestures still land where they landed. `reproRecorder` now asks the host for a
// fresh keyframe whenever its ring drops the one it held, so a file recorded after that change always has one.
function seedInbound(inbound) {
  const at = inbound.findIndex((line) => line.data.lastIndexOf('"full":true', 64) !== -1);
  if (at <= 0) {
    return { inbound, seed: { index: at, t: at === 0 ? inbound[0].t : null, dropped: 0 } };
  }
  return { inbound: inbound.slice(at), seed: { index: at, t: inbound[at].t, dropped: at } };
}

// ===========================================================================================================
// in-page fake WebSocket (serialized into the page before any app script)
// ===========================================================================================================

function reproWebSocketInit(config) {
  const OPEN = 1;
  const realFetch = window.fetch.bind(window);

  window.__reproSent = [];
  window.__reproState = { ready: false, delivered: 0, total: 0, started: false, done: false, error: null };

  class ReproWebSocket extends EventTarget {
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
      window.__reproWs = this;
      if (this.url.includes("/ws")) this._start();
    }

    async _start() {
      let text = "";
      try {
        const res = await realFetch(config.framesUrl);
        text = await res.text();
      } catch (e) {
        window.__reproState.error = `frames fetch failed: ${e}`;
        this.readyState = 3;
        this._emit("error", new Event("error"));
        return;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          this._msgs.push(obj);
        } catch { /* skip */ }
      }
      if (this._closed) return;
      window.__reproState.total = this._msgs.length;
      this.readyState = OPEN;
      this._emit("open", new Event("open"));
      // A recording made before the viewer joined has no directView session in it; without one the mirror sits
      // on the join picker and renders nothing at all. Synthesize the same reply the real server would give a
      // solo run, exactly as the bench does.
      if (config.synthesizeDirectView) this._deliver('{"type":"session","directView":true}');
      window.__reproState.ready = true;
      // …and then WAIT. The gestures are dispatched by the driving process on the same clock as this stream, so
      // the stream may not start until that process is ready to dispatch alongside it.
      window.__reproGo = () => {
        if (window.__reproState.started) return;
        window.__reproState.started = true;
        this._pump();
      };
    }

    _pump() {
      const t0 = performance.now();
      window.__reproT0 = t0;
      const tick = () => {
        if (this._closed) return;
        const now = (performance.now() - t0) * config.speed;
        while (this._i < this._msgs.length && this._msgs[this._i].t <= now) {
          if (config.freezeMs !== null && this._msgs[this._i].t > config.freezeMs) {
            window.__reproState.done = true;
            return;
          }
          this._deliver(this._msgs[this._i].data);
          this._i++;
          window.__reproState.delivered = this._i;
        }
        if (this._i < this._msgs.length) {
          const wait = Math.max(0, this._msgs[this._i].t / config.speed - (performance.now() - t0));
          setTimeout(tick, wait);
        } else {
          window.__reproState.done = true;
        }
      };
      tick();
    }

    _deliver(data) {
      this._emit("message", new MessageEvent("message", { data }));
    }

    _emit(type, event) {
      const handler = this[`on${type}`];
      if (typeof handler === "function") {
        try { handler.call(this, event); } catch { /* a listener threw — keep the stream running */ }
      }
      this.dispatchEvent(event);
    }

    send(data) {
      // EVERY send is recorded, before any of them are handled: this array is the replay's half of the
      // divergence report, and the whole question "did the client send anything here" lives in it.
      const at = window.__reproT0 ? (performance.now() - window.__reproT0) * config.speed : null;
      window.__reproSent.push({ t: at, data: String(data) });
      let msg = null;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg?.type === "ping") {
        // Answered LIVE rather than from the recording: a recorded pong carries a `t0` from another session and
        // would poison the latency readout with a nonsense RTT.
        const echo = { type: "pong", t0: msg.t0 };
        if (msg.mainThread) echo.mainThread = true;
        this._deliver(JSON.stringify(echo));
        return;
      }
      if (msg?.type === "join") {
        this._deliver('{"type":"session","directView":true}');
        return;
      }
      // input / action / settings / watch / scene-ack — swallowed. Nothing here reaches a game (see the
      // determinism note in the header).
    }

    close() {
      this._closed = true;
      this.readyState = 3;
      this._emit("close", new CloseEvent("close"));
    }
  }

  window.WebSocket = ReproWebSocket;
}

// ===========================================================================================================
// CDP input
// ===========================================================================================================

/**
 * Dispatch recorded input over CDP.
 *
 * TOUCH, as VERIFIED against the installed Chromium rather than against the protocol docs (the docs say
 * "TouchEnd and TouchCancel must not contain any touch points"; this build accepts a list and treats it as the
 * points being RELEASED, leaving the rest down). So the release path prefers the precise form and falls back to
 * the documented one:
 *   * `touchStart` / `touchMove` carry EVERY point currently down — Chromium diffs them against its own active
 *     set, so a new id presses and a known id moves,
 *   * releasing the LAST finger is `touchEnd` with `[]` (unambiguous on any build),
 *   * releasing one of several is `touchEnd` with just that point; if a build rejects that, everything is
 *     released and the survivors are re-pressed, which is a worse but still faithful multi-touch.
 * The recorded `pointerId` is NOT reproduced — CDP assigns its own — but the identity mapping is.
 */
function createInputDriver(cdp) {
  const active = new Map(); // recorded pointerId -> { x, y }
  const point = (id, p) => ({ x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1, id });
  const all = () => [...active.entries()].map(([id, p]) => point(id, p));

  async function touch(type, points) {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  }

  async function mouse(type, line, extra = {}) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: line.x, y: line.y, ...extra });
  }

  return async function dispatch(line) {
    if (line.kind === "wheel") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: line.x, y: line.y, deltaX: line.dx, deltaY: line.dy, button: "none"
      });
      return;
    }
    if (line.kind === "key") {
      const modifiers = (line.alt ? 1 : 0) | (line.ctrl ? 2 : 0) | (line.meta ? 4 : 0) | (line.shift ? 8 : 0);
      // The mirror's key channel speaks `KeyboardEvent.code`, so `code` is the field that has to be right;
      // `key`/`text` are left to Chromium's own derivation.
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: line.code, modifiers });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code: line.code, modifiers });
      return;
    }
    if (line.kind !== "pointer") return;

    if (line.pt === "touch") {
      if (line.type === "down") {
        active.set(line.id, { x: line.x, y: line.y });
        await touch("touchStart", all());
        return;
      }
      if (line.type === "move") {
        if (!active.has(line.id)) return; // a move with no matching down — the ring dropped the press
        active.set(line.id, { x: line.x, y: line.y });
        await touch("touchMove", all());
        return;
      }
      // up / cancel
      if (!active.has(line.id)) return;
      const released = point(line.id, { x: line.x, y: line.y });
      active.delete(line.id);
      const type = line.type === "cancel" ? "touchCancel" : "touchEnd";
      if (active.size === 0) {
        await touch(type, []);
        return;
      }
      try {
        await touch(type, [released]);
      } catch {
        await touch(type, []);
        await touch("touchStart", all());
      }
      return;
    }

    // mouse / pen
    const button = line.button === 2 ? "right" : line.button === 1 ? "middle" : "left";
    if (line.type === "down") {
      await mouse("mousePressed", line, { button, buttons: line.buttons, clickCount: 1 });
      return;
    }
    if (line.type === "move") {
      await mouse("mouseMoved", line, { buttons: line.buttons });
      return;
    }
    await mouse("mouseReleased", line, { button, buttons: line.buttons, clickCount: 1 });
  };
}

// ===========================================================================================================
// sampling
// ===========================================================================================================

// Runs in the page. The COMPUTED transform and z-index are what the bugs are about — the recorded wire says
// where the game put a holder, this says where the client actually drew it, and the two are only the same when
// no client-side pose (lift, tween replay, focus z) is in play.
//
// TWO STAGES, ONE SAMPLE. The DOM half of this walks per-node elements, which the canvas stage does not emit —
// so a `?stage=canvas` run used to sample nothing and this file said so. It now reads the renderer-agnostic
// `window.__mirrorHandPoses()` seam (handPoseProbe.ts) FIRST, which both backends install and which answers the
// question directly (`mGame` = where the game has it, `mDrawn` = where this frame drew it, both in design space,
// plus the spread shift, the field mode and the raise). The element walk stays as the fallback for a page from
// before the seam existed.
function sampleHolders(selector) {
  const read = window.__mirrorHandPoses;
  if (typeof read === "function") {
    const report = read();
    return {
      stage: report.stage,
      spreadFactor: report.spreadFactor,
      handPresent: report.handPresent,
      holders: report.holders.map((h) => ({
        id: h.id,
        name: h.name,
        inFan: h.inFan,
        game: [Math.round(h.mGame[4] * 100) / 100, Math.round(h.mGame[5] * 100) / 100],
        drawn: [Math.round(h.mDrawn[4] * 100) / 100, Math.round(h.mDrawn[5] * 100) / 100],
        spreadDx: Math.round(h.spreadDx * 100) / 100,
        fieldMode: h.fieldMode,
        raiseDy: h.raiseDy,
        channelLive: h.channelLive
      })),
      nodes: document.querySelectorAll(".mirror-node").length
    };
  }
  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    out.push({
      id: el.getAttribute("data-node-id"),
      path: el.getAttribute("data-node-path"),
      transform: style.transform,
      zIndex: style.zIndex,
      opacity: style.opacity,
      x: Math.round(box.x * 100) / 100,
      y: Math.round(box.y * 100) / 100,
      w: Math.round(box.width * 100) / 100,
      h: Math.round(box.height * 100) / 100
    });
  }
  return { stage: "dom", holders: out, nodes: document.querySelectorAll(".mirror-node").length };
}

// ===========================================================================================================
// divergence
// ===========================================================================================================

/**
 * Compare what the RECORDED client sent with what the REPLAYED client sent.
 *
 * This is the machine-readable form of the first bug's exact question ("after the cancelled drag, did the client
 * send anything at all for the hover?"). Matching is nearest-in-time within a tolerance, keyed on the envelope's
 * SHAPE rather than its id: `input:412` restarts from 1 in a fresh session, so the ids identify nothing across
 * the two runs, while `input/hover` at roughly the same moment does. The kind is part of the key because a
 * `click` and a `hover` are the two answers this comparison exists to tell apart — matching them
 * interchangeably would report a missing click as "matched" against a neighbouring hover.
 */
function sendKey(parsed) {
  if (!parsed) return "?";
  return parsed.type === "input" ? `input/${parsed.kind}${parsed.button ? `/${parsed.button}` : ""}` : String(parsed.type);
}

function diffSends(recorded, replayed, toleranceMs) {
  const pool = replayed.map((s, index) => ({ ...s, index, taken: false }));
  const matched = [];
  const missing = [];
  for (const want of recorded) {
    let best = null;
    let bestGap = Infinity;
    for (const got of pool) {
      if (got.taken || got.key !== want.key) continue;
      const gap = Math.abs((got.t ?? Infinity) - want.t);
      if (gap < bestGap) { bestGap = gap; best = got; }
    }
    if (best && bestGap <= toleranceMs) {
      best.taken = true;
      matched.push({ t: want.t, key: want.key, gapMs: Math.round(bestGap) });
    } else {
      missing.push(want);
    }
  }
  return { matched, missing, extra: pool.filter((s) => !s.taken) };
}

// ===========================================================================================================
// main
// ===========================================================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.file || !args.url) {
  console.log(HELP);
  process.exit(args.help ? 0 : 2);
}

const rec = loadRepro(args.file);
const stem = basename(rec.abs).replace(/\.ndjson$/, "");
const outRoot = resolve(REPO_ROOT, args.out ?? `.sts2/artifacts/repro/${stem}`);
const speed = Number.isFinite(args.speed) && args.speed > 0 ? args.speed : 1;
const markers = args.marker === null ? rec.markers : rec.markers.filter((m) => m.n === args.marker);

// A touch recording needs a touch CONTEXT: without `hasTouch` the page reports no touch support and the mirror
// takes its mouse paths, which is a different client than the one the bug happened on.
const hasTouch = rec.input.some((line) => line.kind === "pointer" && line.pt === "touch");
const viewport = rec.meta.viewport?.w
  ? { width: Math.round(rec.meta.viewport.w), height: Math.round(rec.meta.viewport.h) }
  : { width: 1280, height: 720 };
const dpr = Number.isFinite(rec.meta.dpr) && rec.meta.dpr > 0 ? rec.meta.dpr : 1;

console.log(`replay-repro: ${rec.abs}`);
console.log(`  ${rec.inbound.length} inbound frames · ${rec.outbound.length} recorded sends · ${rec.input.length} input events · ${rec.markers.length} markers`);
console.log(`  viewport ${viewport.width}x${viewport.height} dpr ${dpr} touch ${hasTouch} · speed ${speed}x`);
if (rec.seed.index < 0) {
  console.log("   ⚠ NO KEYFRAME IN THIS FILE — the ring wrapped past it, so every delta patches a map that was");
  console.log("     never established. Expect the client to throw per frame and the scene to stay empty. Re-record");
  console.log("     on a build with the recorder's keyframe re-seed (reproRecorder.setResyncRequester).");
} else if (rec.seed.dropped > 0) {
  console.log(`   starting at the keyframe ${(rec.seed.t / 1000).toFixed(3)}s in — ${rec.seed.dropped} earlier frames skipped (unreplayable without it)`);
}

// `repro=off` so a replay cannot recursively record itself (and so the badge does not sit over the stills).
const target = new URL(args.url);
target.searchParams.set("repro", "off");

const browser = await chromium.launch({ headless: !args.headed });
const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, hasTouch });
const framesBody = rec.inbound.map((m) => JSON.stringify(m)).join("\n");
await context.route(`**${FRAMES_PATH}`, (route) =>
  route.fulfill({ status: 200, contentType: "application/x-ndjson", body: framesBody }));
await context.addInitScript(reproWebSocketInit, {
  framesUrl: FRAMES_PATH,
  speed,
  freezeMs: args.freeze,
  // A recording taken from a joined seat already carries its session; one taken before the join does not.
  synthesizeDirectView: !rec.inbound.some((m) => m.data.includes('"directView":true'))
});

const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") console.log(`  [page error] ${msg.text()}`);
});
const cdp = await context.newCDPSession(page);
const dispatch = createInputDriver(cdp);

await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__reproState?.ready === true || window.__reproState?.error, null, { timeout: args.timeoutMs });
const wsError = await page.evaluate(() => window.__reproState?.error ?? null);
if (wsError) {
  console.error(`  FAILED: ${wsError}`);
  await browser.close();
  process.exit(1);
}

// ---- build ONE timeline: the gestures, plus every capture point ------------------------------------------
const tasks = [];
for (const line of rec.input) {
  if (args.freeze !== null && line.t > args.freeze) continue;
  tasks.push({ at: line.t, kind: "input", line });
}
if (args.aroundMarkers && markers.length === 0) {
  // Worth saying out loud: a file with no marker is usually a player who forgot to tap it, and a silent
  // zero-artifact run reads as "the tool is broken".
  console.log("  ⚠ --around-markers, but this recording has no markers — nothing will be captured.");
}
if (args.aroundMarkers) {
  const { pre, post, step } = args.aroundMarkers;
  for (const marker of markers) {
    mkdirSync(resolve(outRoot, `marker-${marker.n}`), { recursive: true });
    for (let offset = -pre; offset <= post; offset += step) {
      const at = marker.t + offset;
      if (at < 0 || (args.freeze !== null && at > args.freeze)) continue;
      tasks.push({ at, kind: "capture", marker, offset });
    }
  }
}
tasks.sort((a, b) => a.at - b.at || (a.kind === "input" ? -1 : 1));

const samplesByMarker = new Map();
// Lag is tracked SEPARATELY for the two task kinds, because only one of them matters. A late screenshot is a
// still taken a few ms off the moment it is labelled with; a late INPUT is a different session (the gesture no
// longer lands on the frame it landed on when the bug happened).
let inputLagMax = 0;
let captureLagMax = 0;
let capturesSkipped = 0;
const captureBudgetMs = (args.aroundMarkers?.step ?? 100) / speed;

await page.evaluate(() => window.__reproGo?.());
const wall0 = Date.now();
for (const task of tasks) {
  const due = wall0 + task.at / speed;
  const wait = due - Date.now();
  if (wait > 0) await sleep(wait);
  const behind = Math.max(0, -wait);
  if (task.kind === "input") {
    inputLagMax = Math.max(inputLagMax, behind);
    try { await dispatch(task.line); } catch (error) { console.log(`  [input] ${task.line.kind} failed: ${error.message}`); }
    continue;
  }
  // CAPTURES YIELD TO THE CLOCK. A screenshot costs tens of ms (hundreds on a loaded box) and this loop is
  // serial, so without this a slow one pushes every later task — including the gestures — behind the stream and
  // the run silently stops being a reproduction. Dropping a still once we are already past the next capture
  // point bounds the damage to the artifact set, which is the half that can afford it.
  if (behind > captureBudgetMs) {
    capturesSkipped++;
    continue;
  }
  captureLagMax = Math.max(captureLagMax, behind);
  const dir = resolve(outRoot, `marker-${task.marker.n}`);
  const label = `${task.offset >= 0 ? "p" : "m"}${String(Math.abs(task.offset)).padStart(5, "0")}`;
  const shot = resolve(dir, `${label}.png`);
  await page.screenshot({ path: shot });
  const sample = await page.evaluate(sampleHolders, HOLDER_SELECTOR);
  if (!samplesByMarker.has(task.marker.n)) samplesByMarker.set(task.marker.n, []);
  samplesByMarker.get(task.marker.n).push({ offset: task.offset, t: task.at, shot: basename(shot), ...sample });
}

// Let the tail of the stream land (a marker at the very end of a file still wants its `post` window).
const tailMs = args.freeze === null ? Math.max(0, (rec.inbound.at(-1)?.t ?? 0) - (tasks.at(-1)?.at ?? 0)) / speed : 0;
await sleep(Math.min(tailMs, 5000));

for (const [n, samples] of samplesByMarker) {
  const path = resolve(outRoot, `marker-${n}`, "samples.ndjson");
  writeFileSync(path, `${samples.map((s) => JSON.stringify(s)).join("\n")}\n`);
  console.log(`  marker ${n}: ${samples.length} stills + ${basename(path)} → ${resolve(outRoot, `marker-${n}`)}`);
}

// ---- divergence -------------------------------------------------------------------------------------------
const replayedRaw = await page.evaluate(() => window.__reproSent ?? []);
const replayed = replayedRaw.map((s) => {
  let parsed = null;
  try { parsed = JSON.parse(s.data); } catch { /* text */ }
  return { t: s.t, type: parsed?.type ?? "?", key: sendKey(parsed), parsed, data: s.data };
});
const state = await page.evaluate(() => window.__reproState);

console.log("");
console.log(`stream: ${state.delivered}/${state.total} frames delivered${state.done ? " (complete)" : ""}`);
console.log(`  input lag max ${Math.round(inputLagMax)}ms · capture lag max ${Math.round(captureLagMax)}ms` +
  `${capturesSkipped ? ` · ${capturesSkipped} stills skipped to stay on the clock` : ""}`);
if (inputLagMax > 100) {
  // A gesture dispatched late against the stream is a different session (see the determinism note in the
  // header), so this is the one number that can invalidate a run.
  console.log(`   ⚠ gestures ran up to ${Math.round(inputLagMax)}ms behind the stream — re-run with a smaller`);
  console.log("     --speed (e.g. 0.25) or a coarser --around-markers step before trusting a NEGATIVE result.");
}
console.log("");
console.log(`-- sends: recorded vs replayed${args.freeze === null ? "" : ` (recorded side clipped to --freeze ${args.freeze}ms)`} --`);
// `scene-ack` is CADENCE, not behaviour: one per rendered frame, so a --speed other than 1 (or simply a faster
// machine than the phone that recorded this) moves it and means nothing. `input` is the row to read.
const recordedSends = rec.outbound.filter((s) => args.freeze === null || s.t <= args.freeze);
const types = [...new Set([...recordedSends.map((s) => s.type), ...replayed.map((s) => s.type)])].sort();
for (const type of types) {
  const a = recordedSends.filter((s) => s.type === type).length;
  const b = replayed.filter((s) => s.type === type).length;
  console.log(`   ${type.padEnd(12)} recorded ${String(a).padStart(5)}   replayed ${String(b).padStart(5)}${a === b ? "" : "   ≠"}`);
}
// `input` is the only type worth diffing per-envelope: the rest (scene-ack, ping, settings) are cadence, and
// their counts above already say everything a cadence difference can say.
// Under --freeze the timeline stopped early, so everything the recording did after that point is not a
// divergence — it is a part of the session this run deliberately never reached.
const recordedInputs = rec.outbound.filter((s) => s.type === "input" && (args.freeze === null || s.t <= args.freeze));
const replayedInputs = replayed.filter((s) => s.type === "input");
const diff = diffSends(recordedInputs, replayedInputs, 500);
console.log("");
console.log(`-- input envelopes: ${diff.matched.length} matched, ${diff.missing.length} NOT re-sent, ${diff.extra.length} extra --`);
const coords = (p) => `${p?.kind ?? "?"}${p?.button ? ` ${p.button}` : ""} coord=(${p?.coordX},${p?.coordY})`;
for (const miss of diff.missing.slice(0, 20)) {
  console.log(`   NOT RE-SENT  ${(miss.t / 1000).toFixed(3)}s  ${coords(miss.parsed)}`);
}
if (diff.missing.length > 20) console.log(`   … ${diff.missing.length - 20} more`);
for (const extra of diff.extra.slice(0, 20)) {
  console.log(`   EXTRA        ${extra.t === null ? "?" : (extra.t / 1000).toFixed(3)}s  ${coords(extra.parsed)}`);
}
if (diff.extra.length > 20) console.log(`   … ${diff.extra.length - 20} more`);

if (args.freeze !== null) {
  console.log(`\nfrozen at ${args.freeze}ms${args.keep ? " — browser left open" : ""}`);
}
if (args.keep) {
  console.log("--keep: press Ctrl-C to close");
  await new Promise(() => {});
}
await browser.close();
