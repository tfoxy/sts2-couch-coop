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
import { basename, dirname, resolve } from "node:path";

import { REPO_ROOT } from "./lib/mirror-probe.mjs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import {
  applyRecordingSettings,
  buildSeatHostSession,
  diffSends,
  parseReproText,
  parseWindowArg,
  partitionInboundBySock,
  partitionInputBySeed,
  replaySession,
  seedInbound,
  sendKey,
  urlNameParam
} from "./lib/repro-replay.mjs";

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
    help: false,
    gpu: null,
    diagOut: null,
    window: null,
    asSeat: false,
    preTap: null
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
      case "--gpu": a.gpu = argv[++i]; break;
      case "--diag-out": a.diagOut = argv[++i]; break;
      case "--as-seat": a.asSeat = true; break;
      case "--pre-tap": {
        const spec = argv[++i];
        const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(spec));
        if (!m) throw new Error(`--pre-tap expects "<x>,<y>" in CSS px, got "${spec}"`);
        a.preTap = { x: Number(m[1]), y: Number(m[2]) };
        break;
      }
      case "--window": {
        const spec = argv[++i];
        const parsed = parseWindowArg(spec);
        if (!parsed) throw new Error(`--window expects "<startMs>:<endMs>" on the recording clock, got "${spec}"`);
        a.window = parsed;
        break;
      }
      case "--around-markers": {
        // Optional `pre,post,step` (ms). Bare = the defaults, which bracket a marker by a second either side at
        // 100ms — ~21 stills, enough to see an ease and cheap enough to run on every marker in a file.
        // A bare flag (or one followed immediately by another `--flag`) must produce EXACTLY those defaults:
        // `"".split(",")` is `[""]`, not `[]`, and `Number("")` is 0 (finite!), so the old
        // `.filter(Number.isFinite)` let a bare flag's empty spec supply a REAL 0 for `pre` (silently narrowing
        // the capture window) instead of falling through to the default. Splitting only a NON-EMPTY spec fixes
        // that; `step <= 0` (e.g. an explicit "0,0,0") is rejected outright, since the capture loop below
        // (`for (let offset = -pre; offset <= post; offset += step)`) never terminates for it.
        const next = argv[i + 1];
        const spec = next && !next.startsWith("--") ? argv[++i] : "";
        const parts = spec.length > 0 ? spec.split(",").map(Number) : [];
        const [pre = 1000, post = 1000, step = 100] = parts;
        if (!Number.isFinite(pre) || !Number.isFinite(post) || !Number.isFinite(step) || step <= 0) {
          throw new Error(`--around-markers expects "<pre>,<post>,<step>" with step > 0, got "${spec}"`);
        }
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
  --gpu <backend>            real GPU via --use-angle=<backend> (e.g. "vulkan"); default is headless
                             Chromium's own SwiftShader software path, which stalls the recording clock
  --diag-out <file>          write window.__mirrorRendererDiagnostics() + CDP Performance deltas here
  --window <a>:<b>           ms on the RECORDING clock; narrows the --diag-out Performance deltas to
                             this span (default: the whole replay)
  --as-seat                  join as a seat (headlessMirrorPort + a second socket) instead of watching
                             as a direct-view spectator — see docs/agents/repro-recorder.md
  --pre-tap <x>,<y>          dispatch one synthetic tap (CSS px) BEFORE the recorded clock starts — for
                             local-only UI toggle state (e.g. the settings panel) a recording armed
                             mid-session carries no record of; see docs/agents/repro-recorder.md
`;

// ===========================================================================================================
// loading
// ===========================================================================================================

// Parsing/keyframe-seeking is in scripts/lib/repro-replay.mjs (parseReproText, seedInbound) so it can be unit
// tested without a browser; this is just the filesystem + header-validation wrapper.
//
// `allInbound` (UNTRIMMED) vs `inbound` (seeded — only `full:true` onward): a `session` envelope, when a
// recording has one at all, almost always arrives BEFORE the keyframe (the server answers `join` with it, then
// streams the scene). Scanning the SEEDED array for `replaySession`/`buildSeatHostSession` would silently throw
// that session away and fall back to the generic default — the wire pump is right to start only at the
// keyframe (a delta before it patches a map that was never established), but session lookup has no such
// constraint, so it gets the full history.
function loadRepro(path) {
  const abs = resolve(REPO_ROOT, path);
  const text = readFileSync(abs, "utf8");
  const meta = requireReproHeader(text, abs);
  const { inbound, outbound, input, markers } = parseReproText(text);
  if (markers.length === 0 && Array.isArray(meta.markers)) {
    for (const m of meta.markers) markers.push({ n: m.n, t: m.t, note: m.note });
  }
  const seeded = seedInbound(inbound);
  return { abs, meta, allInbound: inbound, inbound: seeded.inbound, seed: seeded.seed, outbound, input, markers };
}

// ===========================================================================================================
// in-page fake WebSocket (serialized into the page before any app script)
// ===========================================================================================================

function reproWebSocketInit(config) {
  const OPEN = 1;
  const realFetch = window.fetch.bind(window);

  window.__reproSent = [];
  window.__reproState = { ready: false, delivered: 0, total: 0, started: false, done: false, error: null };

  // NON-STAGE TOUCH PROBE — warn, don't silently swallow. `inputCapture.ts`'s listeners are attached to the
  // `.mirror-stage` element only, so a touch whose target is outside it (a settings control, a chrome button)
  // can NEVER reach `send()` — it bubbles nowhere near inputCapture. That is the exact, previously silent,
  // signature of a client-local UI toggle (the settings panel; see `--pre-tap`'s own note) swallowing gestures
  // the recording expected to reach the game: a replay used to just report "0 input sent" with nothing pointing
  // at why. Counted here (capture phase, so nothing the page does can stop it from seeing the hit) and reported
  // once at the end of the run.
  window.__reproOffStage = { count: 0, samples: [] };
  // ORDER PROBE — the monotonic-sequence check for the pipelined dispatch fix: the in-page ARRIVAL order of
  // every pointer event, by CDP's own assigned `pointerId` (not the recorded one — see the header). Checked
  // after the run (Node side) per id: down must be first, up/cancel (if present) must be last, and `timeStamp`
  // must be non-decreasing within the id — a reorder from pipelining commands within one gesture would show up
  // here as a move or up arriving before its own down, or out of timeStamp order.
  window.__reproPointerOrder = [];
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    window.addEventListener(type, (event) => {
      window.__reproPointerOrder.push({ type, id: event.pointerId, t: event.timeStamp });
      const target = event.target;
      if (target && typeof target.closest === "function" && target.closest(".mirror-stage")) return;
      window.__reproOffStage.count++;
      if (window.__reproOffStage.samples.length < 8) {
        const id = (target && (target.getAttribute?.("data-testid") || target.id || target.tagName)) || "?";
        window.__reproOffStage.samples.push(String(id));
      }
    }, { capture: true });
  }

  // Fetched ONCE no matter how many fake sockets ask for it. `--as-seat` always opens two (a quiet host socket
  // plus the seat socket that actually carries the recorded stream); today's direct-view spectator mode only
  // ever opens one, so this collapses to the old "fetch on construct" there. Before this, a second `/ws` match
  // re-fetched and clobbered `window.__reproGo` out from under the first socket.
  let framesPromise = null;
  function loadFrames() {
    if (!framesPromise) {
      framesPromise = realFetch(config.framesUrl).then((res) => res.text()).then((text) => {
        const msgs = [];
        for (const line of text.split("\n")) {
          if (!line) continue;
          try { msgs.push(JSON.parse(line)); } catch { /* skip */ }
        }
        return msgs;
      });
    }
    return framesPromise;
  }

  // PURE PORT-BASED ROUTING — the only thing that tells the host and seat sockets apart.
  // `buildHeadlessMirrorWebSocketUrl` (mirrorClient.ts) reuses the SAME origin and `/ws` path for a seat
  // reconnect and only changes the port, so a seat replay's second `new WebSocket(...)` call lands here with a
  // URL that differs from the first ONLY in its port. Deliberately duplicated (not imported) from
  // scripts/lib/repro-replay.mjs's `classifySeatSocketUrl` — this whole function is serialized into the page by
  // `fn.toString()`, so it cannot reference an outer module import; the lib copy is what the unit tests check.
  function isSeatUrl(url) {
    if (config.mode !== "seat" || config.seatPort == null) return false;
    try { return new URL(url).port === String(config.seatPort); } catch { return false; }
  }

  // __reproGo fires every registered socket's pump in one shot, so the Node side only ever has to call it once
  // regardless of how many fake sockets ended up open.
  window.__reproSockets = [];
  let expectedReady = config.mode === "seat" ? 2 : 1;
  let readyCount = 0;
  function markReady() {
    readyCount++;
    if (readyCount >= expectedReady) window.__reproState.ready = true;
  }
  window.__reproGo = () => {
    if (window.__reproState.started) return;
    window.__reproState.started = true;
    for (const sock of window.__reproSockets) {
      if (sock._msgs.length > 0) sock._pump();
    }
  };

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
      // In spectator mode every socket carries the stream. In seat mode only the SEAT socket does — a real host
      // goes quiet the moment its one seat redirects (`c.sendWatch(false)`, MirrorApp.vue's `onHeadlessRedirect`),
      // and reproducing that quiet is the entire point of keeping the two apart.
      this.role = config.mode === "seat" ? (isSeatUrl(this.url) ? "seat" : "host") : "spectator";
      window.__reproWs = this; // last-constructed; kept for older callers that only ever expected one
      window.__reproSockets.push(this);
      if (this.url.includes("/ws")) this._start();
    }

    async _start() {
      if (config.mode === "seat" && this.role === "host") {
        // A real WebSocket's "open" is ALWAYS asynchronous — never in the same tick as `new WebSocket(...)`. This
        // branch has no `await` of its own (there are no frames to fetch), so without one of its own it would
        // emit "open" SYNCHRONOUSLY, inside the constructor call, before `connectMirrorClient` (mirrorClient.ts)
        // has executed its very next statement: `socket.addEventListener("open", ...)`. The event would fire to
        // zero listeners and the client would sit on "Connecting…" forever. One microtask tick is enough — the
        // caller's remaining synchronous statements (including that addEventListener) run before any microtask
        // does, regardless of how soon this one is scheduled.
        await Promise.resolve();
        this.readyState = OPEN;
        this._emit("open", new Event("open"));
        if (config.synthesizedSession) this._deliver(config.synthesizedSession);
        markReady();
        return;
      }
      let msgs;
      try {
        msgs = await loadFrames();
      } catch (e) {
        window.__reproState.error = `frames fetch failed: ${e}`;
        this.readyState = 3;
        this._emit("error", new Event("error"));
        return;
      }
      if (this._closed) return;
      // SOCKET-TAG ROUTING (reproRecorder.ts's `sock` field on each line) — the in-page mirror of
      // scripts/lib/repro-replay.mjs's `partitionInboundBySock` (tested there; duplicated here for the same
      // `fn.toString()` reason as `isSeatUrl` above). This socket is never the quiet host (that branch returned
      // above), so it is the one that carries the stream — a "host"-tagged line belongs on the OTHER socket
      // instead. An UNTAGGED recording (every `sock` is `null`, including every file from before this tag
      // existed) passes every line through unchanged: `null !== "host"` is always true, which is exactly
      // today's "everything goes to whichever socket carries the stream" behaviour.
      this._msgs = msgs.filter((m) => m.sock !== "host");
      window.__reproState.total = this._msgs.length;
      this.readyState = OPEN;
      this._emit("open", new Event("open"));
      // A recording made before the viewer joined has no directView session in it; without one the browser
      // envelope parser rejects a bare `{"type":"session","directView":true}` (it requires hostName, scrollAction,
      // screen and players — browserEnvelope.ts), and the mirror sits on "Waiting for the game…" forever, acking
      // nothing. Synthesize a COMPLETE session envelope instead, exactly as bench-mirror-replay.mjs does
      // (`replaySession`, reusing the recording's own host/screen/player/asset fields when it has a session in it).
      // Seat mode never does this on the SEAT socket — that session already came from the host socket (or, for a
      // recording with no session in it at all, from the synthetic-seat meta's short-circuit — see below).
      if (config.mode !== "seat" && config.synthesizeDirectView) this._deliver(config.synthesizedSession);
      markReady();
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
      window.__reproSent.push({ t: at, data: String(data), sock: this.role });
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
      if (msg?.type === "join" && config.mode !== "seat") {
        this._deliver(config.synthesizedSession ?? '{"type":"session","directView":true}');
        return;
      }
      // Seat mode never sees a `join` here: the `couchcoop-synthetic-seat` meta tag (installed below) makes
      // `MirrorApp.vue`'s `submitJoin` jump straight to `openSeatView(port)` without sending one. input / action /
      // settings / watch / scene-ack — swallowed everywhere. Nothing here reaches a game (see the determinism
      // note in the header).
    }

    close() {
      this._closed = true;
      this.readyState = 3;
      this._emit("close", new CloseEvent("close"));
    }
  }

  window.WebSocket = ReproWebSocket;

  // SEAT MODE ONLY. Reproduce the server's `couchcoop-synthetic-seat` meta tag
  // (`CouchCoopBrowserServer.cs`'s `SyntheticSeatPort`) — the same seam `iphone-webkit/iphone-burst.e2e.spec.ts`
  // already uses to exercise "a seat socket opens, the host socket stays open and quiet" without a real headless
  // game process. `MirrorApp.vue`'s `submitJoin` reads it and short-circuits to `openSeatView(port)` directly,
  // which is exactly the shape this replay needs: most repro recordings are armed mid-session (this tool's own
  // card-target repro carries zero `session`/`join` lines), so there is no real join exchange to replay in the
  // first place — inventing one from scratch would be putting wire on the stream the recording never had an
  // opinion on.
  if (config.mode === "seat") {
    // NOT gated on DOMContentLoaded: a module-script app (Vite's default) runs its main module — including the
    // auto-join effect that reads this tag — AFTER parsing but BEFORE `DOMContentLoaded` fires, so waiting for
    // that event made `submitJoin` check for a meta tag that had not been inserted yet (observed: the page stuck
    // on "Joining…" forever, the synthetic-port branch silently never taken). `document.documentElement` can
    // exist before `<head>` does this early (addInitScript runs before the page's own parser has gotten far), so
    // a MutationObserver on `document` catches the moment EITHER appears, with no dependency on parse order.
    const insert = () => {
      const target = document.head || document.documentElement;
      if (!target || target.querySelector('meta[name="couchcoop-synthetic-seat"]')) return false;
      const meta = document.createElement("meta");
      meta.name = "couchcoop-synthetic-seat";
      meta.content = String(config.seatPort);
      target.appendChild(meta);
      return true;
    };
    if (!insert()) {
      const observer = new MutationObserver(() => {
        if (insert()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }
  }
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
      // BOTH sends issued before either is awaited: a single CDP session delivers and handles commands in the
      // order they were SENT, not the order their acks come back, so writing rawKeyDown then keyUp back-to-back
      // (no await between) is what keeps them in order relative to each other AND relative to whatever the
      // caller dispatches next — awaiting between them (the old code) serialized this call's OWN latency into
      // every later dispatch queued behind it, which is what turned a dense touchmove stream into a growing
      // backlog (queueWaitMs ramped 2ms -> 1.8s within one long drag — the chain was the cost, not the page).
      const down = cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: line.code, modifiers });
      const up = cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code: line.code, modifiers });
      await Promise.all([down, up]);
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
      // MULTI-FINGER RELEASE ONLY (active.size > 0 here — absent from the card-target repro, which never has two
      // fingers down at once). This ONE path still awaits its first send before deciding whether to issue the
      // fallback, because the fallback's existence depends on how the FIRST call was answered — unlike every
      // other branch in this function, it genuinely cannot be pipelined without knowing that answer first. A
      // multi-touch recording whose release lands here can still see this call's own CDP latency propagate into
      // whatever is queued right behind it; nothing else in this file's dispatch paths does.
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
//
// `sendKey`/`diffSends` live in scripts/lib/repro-replay.mjs (imported above) — comparing what the RECORDED
// client sent against what the REPLAYED client sent, nearest-in-time within a tolerance, keyed on the envelope's
// SHAPE rather than its id (`input:412` restarts from 1 in a fresh session and identifies nothing across runs).

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
if (args.asSeat) {
  const split = partitionInboundBySock(rec.inbound);
  console.log(split.tagged
    ? `  inbound is socket-tagged: ${split.seat.length} seat-bound, ${split.host.length} host-bound`
    : "  inbound has no socket tags (pre-dates reproRecorder.ts's sock field) — all of it goes to the seat socket");
}
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

// SEAT MODE SETUP. The seat port is a pure label — nothing in this process ever opens a real socket on it, both
// fake sockets are intercepted at `window.WebSocket` before either tries — so any number works; it only has to
// differ from the dev server's own port (which the host socket's URL carries unchanged).
const SEAT_PORT = 44199;
const seatName = args.asSeat ? (urlNameParam(rec.meta.url) ?? "ReplaySeat") : null;
if (args.asSeat) {
  // The SAME `?name=` auto-join marker a real seat viewer's URL carries (MirrorApp.vue's `autoJoinSent`); without
  // it the page sits on the join picker and never calls `submitJoin` at all.
  target.searchParams.set("name", seatName);
}
const hostSession = args.asSeat ? buildSeatHostSession(rec.allInbound) : null;

console.log(args.asSeat
  ? `  --as-seat: joining as "${seatName}" (seat port label ${SEAT_PORT})`
  : "  direct-view spectator");

// APPLY THE RECORDING'S OWN SETTINGS. Without this a replay always ran under mirrorSettings.ts's framework
// defaults — `raiseHandCards: false`, regardless of what the recording had — which is not a neutral baseline,
// it is a DIFFERENT CLIENT than the one that made the recording (measured: `bySource.local.count` 5-9 instead
// of ~43, ~37 of them in the aim window, with the recording's OWN `raiseHandCards: true` applied). `settings`
// is `meta.settings` (the save-time snapshot, every recording has it); `settingsAtArm`, when present (see
// reproRecorder.ts), is more faithful for anything that can change mid-recording and is preferred.
const recordingSettings = rec.meta.settingsAtArm ?? rec.meta.settings ?? null;
const { applied: appliedSettings, skipped: skippedSettings, storageOnly: storageOnlySettings } =
  applyRecordingSettings(target, recordingSettings);
if (Object.keys(appliedSettings).length > 0) {
  console.log(`  applied recording settings: ${JSON.stringify(appliedSettings)}`);
}
if (skippedSettings.length > 0) {
  console.log(`  --url already set these — left alone: ${skippedSettings.join(", ")}`);
}

const launchArgs = [];
if (args.gpu) launchArgs.push(`--use-angle=${args.gpu}`);
const browser = await chromium.launch({ headless: !args.headed, args: launchArgs });
const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, hasTouch });
if (Object.keys(storageOnlySettings).length > 0) {
  // The settings with no URL lever at all (refreshRate, tweenReplay — see SETTINGS_STORAGE_ONLY_KEYS). Seeded
  // into the SAME storage key `mirrorSettings.ts` reads on load (`MIRROR_SETTINGS_STORAGE_KEY`), merged with
  // whatever else is already there (nothing, on a fresh context) rather than replacing it outright.
  await context.addInitScript((values) => {
    const KEY = "couchcoop.mirrorSettings.v1";
    try {
      const current = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      localStorage.setItem(KEY, JSON.stringify({ ...current, ...values }));
    } catch { /* a private/blocked store is not a reason this replay should fail to start */ }
  }, storageOnlySettings);
}
const framesBody = rec.inbound.map((m) => JSON.stringify(m)).join("\n");
await context.route(`**${FRAMES_PATH}`, (route) =>
  route.fulfill({ status: 200, contentType: "application/x-ndjson", body: framesBody }));
await context.addInitScript(reproWebSocketInit, {
  framesUrl: FRAMES_PATH,
  speed,
  freezeMs: args.freeze,
  mode: args.asSeat ? "seat" : "spectator",
  seatPort: args.asSeat ? SEAT_PORT : null,
  // Spectator mode: the one socket's connect-time session. Seat mode: the HOST socket's connect-time session
  // (and its `join` reply, since there is only one — see buildSeatHostSession's own note on why this harness
  // does not simulate a headlessMirrorPort redirect reply).
  synthesizedSession: args.asSeat ? hostSession : replaySession(rec.allInbound),
  // A recording taken from a joined seat already carries its session; one taken before the join does not.
  synthesizeDirectView: !rec.inbound.some((m) => m.data.includes('"directView":true'))
});

const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") console.log(`  [page error] ${msg.text()}`);
});
const cdp = await context.newCDPSession(page);
const dispatch = createInputDriver(cdp);
const perfWindow = args.window ?? { startMs: rec.input[0]?.t ?? 0, endMs: rec.input.at(-1)?.t ?? (rec.inbound.at(-1)?.t ?? 0) };
if (args.diagOut) await cdp.send("Performance.enable");

await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
try {
  await page.waitForFunction(() => window.__reproState?.ready === true || window.__reproState?.error, null, { timeout: args.timeoutMs });
} catch (e) {
  // The one thing this ALWAYS needs is "how many of the sockets this run expected ever got to ready" — in
  // --as-seat mode specifically, that's most often a seat socket that never opened because `submitJoin` never
  // ran (an auto-join guard refused, or the `couchcoop-synthetic-seat` meta landed after the app already read
  // it once — see buildSeatHostSession and the meta-insertion comment in reproWebSocketInit).
  const dbg = await page.evaluate(() => ({
    state: window.__reproState,
    sockets: (window.__reproSockets ?? []).map((s) => ({ role: s.role, readyState: s.readyState, msgs: s._msgs?.length })),
    body: document.body.innerText.slice(0, 200)
  }));
  console.error(`  FAILED waiting for ready: ${JSON.stringify(dbg)}`);
  await browser.close();
  throw e;
}
const wsError = await page.evaluate(() => window.__reproState?.error ?? null);
if (wsError) {
  console.error(`  FAILED: ${wsError}`);
  await browser.close();
  process.exit(1);
}

// GESTURES RECORDED BEFORE THE KEYFRAME CANNOT BE REPLAYED MEANINGFULLY — see partitionInputBySeed's own
// comment (scripts/lib/repro-replay.mjs) for why, and why this is skip-and-report rather than dispatch-anyway.
const { replayable: replayableInput, skipped: skippedPreSeed, hasValidSeed } = partitionInputBySeed(rec.input, rec.seed);
if (skippedPreSeed > 0) {
  console.log(`   ⚠ ${skippedPreSeed}/${rec.input.length} gestures are recorded BEFORE the keyframe` +
    ` (t<${rec.seed.t}ms) — skipped, not dispatched (nothing has rendered yet at that point in a cold replay).`);
}

// ---- build ONE timeline: the gestures, plus every capture point ------------------------------------------
const tasks = [];
for (const line of replayableInput) {
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
// Two CDP Performance.getMetrics snapshots, scheduled on the SAME shared clock as the gestures, bracketing
// --window (or, absent one, the whole span the recorded input/stream covers). `perf` tasks never yield to the
// clock the way a screenshot does — a getMetrics call is cheap and a few ms of slop on the bracket matters far
// less than a still landing exactly on a marker does.
const perfMetrics = { before: null, after: null };
if (args.diagOut) {
  tasks.push({ at: perfWindow.startMs, kind: "perf", which: "before" });
  tasks.push({ at: perfWindow.endMs, kind: "perf", which: "after" });
}
// Stable by construction, not by engine guarantee: two tasks at the identical `at` keep their ORIGINAL relative
// order (an explicit index tiebreaker) once `at` and the input-first rule both come out equal — e.g. two input
// lines recorded at the exact same millisecond, where their recorded order is the only signal left for which
// one a multi-touch sequence (down before move, move before up) needs to land first.
for (let i = 0; i < tasks.length; i++) tasks[i]._seq = i;
tasks.sort((a, b) => {
  if (a.at !== b.at) return a.at - b.at;
  const aRank = a.kind === "input" ? 0 : 1;
  const bRank = b.kind === "input" ? 0 : 1;
  return aRank !== bRank ? aRank - bRank : a._seq - b._seq;
});

const samplesByMarker = new Map();
// Lag is tracked SEPARATELY for the two task kinds, because only one of them matters. A late screenshot is a
// still taken a few ms off the moment it is labelled with; a late INPUT is a different session (the gesture no
// longer lands on the frame it landed on when the bug happened).
//
// TWO DIFFERENT "input lag" numbers, on purpose. `scheduleLagMax` is how late THIS PROCESS issued a dispatch
// call against its own due time — fixed by the non-blocking loop below, so it reads ~0ms whether or not
// anything is actually wrong. `completionLagMax`/`completionLagP95` are how late the PAGE finished handling it
// (the CDP call's own ack, which on this build correlates with real main-thread cost — a 2+MB keyframe parse
// measured up to 926ms here) — THIS is the honest number, and the one the <100ms spec target is measured
// against. Reporting only the schedule number was the bug: it read 0ms while gestures landed up to 926ms late.
let scheduleLagMax = 0;
const completionLags = [];
let captureLagMax = 0;
let capturesSkipped = 0;
const captureBudgetMs = (args.aroundMarkers?.step ?? 100) / speed;

// ORDERING: PIPELINED, not serialized. A round-trip-blocking chain was tried first (await the previous
// dispatch's own completion before sending the next one of the same kind) and MEASURED to be the actual cost:
// `REPRO_CHAIN_DIAG=1` showed `queueWaitMs` (time a dispatch sat queued behind its own chain's tail) ramping
// 2ms -> 1.8s within one long drag, resetting at chain boundaries — a backlog signature, not page cost
// (confirmed separately: `completionLagMax` stayed ~flat whether or not the page had anything else to do).
// 16-34ms per CDP round trip, times a touchmove stream recorded under 10ms apart, is exactly a growing queue.
//
// The fix: a single CDP session delivers and HANDLES commands in the order they were SENT, not the order their
// acks return — so sending every command for a line immediately (synchronous call order, nothing awaited in
// between) keeps down->moves->up (and a key's rawKeyDown->keyUp — fixed inside createInputDriver's dispatch, see
// its own comment) in order with ZERO round trips blocking the next SEND. Only the one rare, genuinely
// conditional case (a multi-touch release's fallback, absent from this file — see dispatch's own comment) still
// awaits internally, and only within its own single line.
// Diagnostic only (REPRO_CHAIN_DIAG=1), kept to re-check the ramp hypothesis after any future change here: for
// each "chain" (touch/mouse vs key), how long THIS dispatch's own promise took to settle (`ownMs` — with the
// pipelining fix this should track the bare ~16-34ms CDP round trip, flat, regardless of how deep into a long
// drag it is) versus the old symptom (`queueWaitMs` ramping with elapsed time — that was the serialized-chain
// backlog, measured and removed above).
const chainDiag = process.env.REPRO_CHAIN_DIAG ? [] : null;
const chainStart = new Map();
function queueDispatch(line) {
  const key = line.kind === "key" ? "key" : "pointer";
  if (chainDiag && !chainStart.has(key)) chainStart.set(key, Date.now());
  const t0 = Date.now();
  const p = dispatch(line).catch((error) => console.log(`  [input] ${line.kind} failed: ${error.message}`));
  if (chainDiag) {
    p.then(() => chainDiag.push({ key, sinceChainStartMs: t0 - chainStart.get(key), ownMs: Date.now() - t0 }));
  }
  return p;
}

if (args.preTap) {
  // ONE setup tap, dispatched BEFORE the recorded clock starts — see the --pre-tap help text. This is NOT part
  // of the recording's own gesture stream (it never appears in the divergence report) and never touches the
  // wire; it exists solely to put client-local UI chrome (anything a reload always resets, like the settings
  // panel) into the state a mid-session recording's own first recorded gesture assumes it is already in.
  console.log(`  --pre-tap: dispatching a setup tap at (${args.preTap.x}, ${args.preTap.y})`);
  await dispatch({ kind: "pointer", pt: "touch", type: "down", id: -1, x: args.preTap.x, y: args.preTap.y });
  await dispatch({ kind: "pointer", pt: "touch", type: "up", id: -1, x: args.preTap.x, y: args.preTap.y });
  await sleep(200);
}
await page.evaluate(() => window.__reproGo?.());
// WAIT FOR THE SCENE, THEN START THE GESTURE CLOCK. The wire pump above is already flowing from the keyframe;
// gestures must not start landing until the renderer has actually produced a frame from it, or the "nothing to
// interact with yet" problem the pre-seed skip (above) exists for recurs for the first gestures AFTER the seed
// too — a multi-MB keyframe's own parse is not free. Gated on the renderer's OWN readiness signal rather than a
// guessed fixed delay, so this costs nothing extra once the page is actually fast, and reports exactly how long
// it took when it is not — which is also what REMOVES the keyframe-parse stall from the completion-lag numbers
// below: they now measure gesture-handling cost, not "waiting for the first frame to exist at all".
let readyWaitMs = 0;
if (hasValidSeed) {
  const readyWaitStart = Date.now();
  try {
    await page.waitForFunction(() => window.__mirrorRendererDiagnostics?.()?.ready === true, null, { timeout: args.timeoutMs });
    readyWaitMs = Date.now() - readyWaitStart;
    console.log(`  scene ready ${readyWaitMs}ms after go (keyframe parse + first paint)`);
  } catch {
    console.log(`   ⚠ renderer never reported ready within ${args.timeoutMs}ms — proceeding anyway; expect gestures to miss`);
  }
}
const wall0 = Date.now();
// INPUT IS NOT AWAITED HERE (beyond its own chain — see queueDispatch above). `Input.dispatch*Event` over CDP
// round-trips through the browser process — observed 16-34ms per call on this host regardless of GPU backend,
// and many recorded gestures are spaced closer together than that (a touchmove stream is often <10ms apart).
// Awaiting each call serially, with nothing else in flight, cannot keep pace with ANY such recording — the
// per-call latency alone, summed over hundreds of events, was the entire multi-second SCHEDULE lag this harness
// used to report before this fix. Only the chain's own internal ordering blocks; the loop's `sleep(wait)` above
// is the only thing pacing it. All pending dispatches are drained with `Promise.allSettled` before anything
// reads page state back out.
const pendingDispatches = [];
for (const task of tasks) {
  const due = wall0 + task.at / speed;
  const wait = due - Date.now();
  if (wait > 0) await sleep(wait);
  const behind = Math.max(0, -wait);
  if (task.kind === "input") {
    scheduleLagMax = Math.max(scheduleLagMax, behind);
    pendingDispatches.push(
      queueDispatch(task.line).then(() => {
        completionLags.push(Math.max(0, Date.now() - due));
      })
    );
    continue;
  }
  if (task.kind === "perf") {
    await Promise.allSettled(pendingDispatches.splice(0));
    const { metrics } = await cdp.send("Performance.getMetrics");
    perfMetrics[task.which] = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
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
  // A still must reflect every gesture dispatched up to this point on the clock, not whatever happened to have
  // landed by the time the CDP screenshot call was issued.
  await Promise.allSettled(pendingDispatches.splice(0));
  const dir = resolve(outRoot, `marker-${task.marker.n}`);
  const label = `${task.offset >= 0 ? "p" : "m"}${String(Math.abs(task.offset)).padStart(5, "0")}`;
  const shot = resolve(dir, `${label}.png`);
  await page.screenshot({ path: shot });
  const sample = await page.evaluate(sampleHolders, HOLDER_SELECTOR);
  if (!samplesByMarker.has(task.marker.n)) samplesByMarker.set(task.marker.n, []);
  samplesByMarker.get(task.marker.n).push({ offset: task.offset, t: task.at, shot: basename(shot), ...sample });
}

// Drain whatever is still in flight before reading anything back out of the page.
await Promise.allSettled(pendingDispatches.splice(0));

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
// `s.t` is wall time since `__reproGo` (the WIRE pump's own clock, `reproT0` — see reproWebSocketInit), which
// this run deliberately started dispatching gestures `readyWaitMs` AFTER (the scene-ready wait above). Shifting
// it back by that amount puts replayed sends back onto the RECORDING's own clock, so the divergence comparison
// below answers "did this gesture land on time relative to the scene it was dispatched against" instead of
// "exactly how long did this run spend waiting for the keyframe to parse" — which `completionLagMax` above
// already answers, and would otherwise swamp every comparison here with that one constant offset.
const replayed = replayedRaw.map((s) => {
  let parsed = null;
  try { parsed = JSON.parse(s.data); } catch { /* text */ }
  return { t: s.t === null ? null : s.t - readyWaitMs, type: parsed?.type ?? "?", key: sendKey(parsed), parsed, data: s.data };
});
const state = await page.evaluate(() => window.__reproState);

// p95 of a sorted ascending array — plain nearest-rank, no interpolation (the sample sizes here are small enough
// that the choice never matters to the ms this prints).
function percentile95(valuesAscending) {
  if (valuesAscending.length === 0) return 0;
  const idx = Math.min(valuesAscending.length - 1, Math.ceil(0.95 * valuesAscending.length) - 1);
  return valuesAscending[idx];
}
const completionLagsSorted = [...completionLags].sort((a, b) => a - b);
const completionLagMax = completionLagsSorted.length ? completionLagsSorted[completionLagsSorted.length - 1] : 0;
const completionLagP95 = percentile95(completionLagsSorted);

console.log("");
console.log(`stream: ${state.delivered}/${state.total} frames delivered${state.done ? " (complete)" : ""}`);
console.log(`  schedule lag max ${Math.round(scheduleLagMax)}ms (this process issuing a dispatch call late` +
  " against its own clock — expect ~0) · capture lag max " + `${Math.round(captureLagMax)}ms` +
  `${capturesSkipped ? ` · ${capturesSkipped} stills skipped to stay on the clock` : ""}`);
console.log(`  completion lag max ${Math.round(completionLagMax)}ms, p95 ${Math.round(completionLagP95)}ms` +
  ` (the PAGE finishing each dispatch — this is the honest number)`);
if (completionLagMax > 100) {
  // A gesture whose CDP ack came back late is a gesture the page handled late against the stream (a different
  // session — see the determinism note in the header), and this is the one pair of numbers that can invalidate
  // a run. Unlike the old schedule-only metric, a smaller --speed does NOT fix this on its own: it stretches the
  // WALL-CLOCK gap between gestures, which gives a slow page more room, but a page that is genuinely this slow
  // to handle input is a real finding, not a measurement artifact to tune away.
  console.log(`   ⚠ gestures were handled up to ${Math.round(completionLagMax)}ms late (p95 ${Math.round(completionLagP95)}ms).`);
  console.log("     If this persists after --speed 0.5, it is the page's own handling cost, not this harness's.");
}
if (chainDiag) {
  const byKey = new Map();
  for (const row of chainDiag) {
    if (!byKey.has(row.key)) byKey.set(row.key, []);
    byKey.get(row.key).push(row);
  }
  for (const [key, rows] of byKey) {
    const buckets = [[0, 1000], [1000, 3000], [3000, 6000], [6000, 1e9]];
    console.log(`  [chain-diag] "${key}" chain, ${rows.length} dispatches, ownMs (this dispatch's own CDP round` +
      " trip — flat means pipelined, ramping means serialized) by time-since-chain-start:");
    for (const [lo, hi] of buckets) {
      const slice = rows.filter((r) => r.sinceChainStartMs >= lo && r.sinceChainStartMs < hi);
      if (slice.length === 0) continue;
      const avg = slice.reduce((s, r) => s + r.ownMs, 0) / slice.length;
      const max = Math.max(...slice.map((r) => r.ownMs));
      console.log(`    [${lo}-${hi === 1e9 ? "+" : hi}ms] n=${slice.length} avg=${avg.toFixed(0)}ms max=${max}ms`);
    }
  }
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

// ---- pointer order check (the pipelined dispatch fix's monotonic-sequence check) ------------------------------
// Per pointerId (CDP's own, not the recorded one): down first, up/cancel (if any) last, timeStamp non-decreasing
// throughout. A violation here is exactly what pipelining WITHOUT the in-order CDP-session guarantee would
// produce — proof, not assumption, that down->moves->up stayed in order with zero round trips blocking issuance.
const pointerOrder = await page.evaluate(() => window.__reproPointerOrder ?? []);
{
  const byId = new Map();
  for (const ev of pointerOrder) {
    if (!byId.has(ev.id)) byId.set(ev.id, []);
    byId.get(ev.id).push(ev);
  }
  const violations = [];
  for (const [id, events] of byId) {
    for (let i = 1; i < events.length; i++) {
      if (events[i].t < events[i - 1].t) violations.push(`id ${id}: ${events[i - 1].type}@${events[i - 1].t} then ${events[i].type}@${events[i].t} (out of order)`);
    }
    const first = events[0];
    if (first.type !== "pointerdown") violations.push(`id ${id}: first event is "${first.type}", not "pointerdown"`);
    const lastReleaseIdx = events.map((e) => e.type).lastIndexOf("pointerup") >= 0 || events.map((e) => e.type).lastIndexOf("pointercancel") >= 0
      ? Math.max(events.map((e) => e.type).lastIndexOf("pointerup"), events.map((e) => e.type).lastIndexOf("pointercancel"))
      : -1;
    if (lastReleaseIdx >= 0 && lastReleaseIdx !== events.length - 1) {
      violations.push(`id ${id}: a release (up/cancel) is not the LAST event for this id`);
    }
  }
  console.log("");
  console.log(`-- pointer order check: ${byId.size} CDP pointer ids, ${pointerOrder.length} events, ` +
    `${violations.length === 0 ? "NO reorder" : `${violations.length} VIOLATIONS`} --`);
  for (const v of violations.slice(0, 10)) console.log(`   ⚠ ${v}`);
}

// ---- non-stage touch warning --------------------------------------------------------------------------------
// See reproWebSocketInit's `__reproOffStage` probe: a touch that never reaches `.mirror-stage` can never reach
// inputCapture.ts, no matter how correct the dispatch/session/seat plumbing above is. Printed unconditionally —
// a silent "0 input sent" with no pointer to why is the exact failure mode this exists to end.
const offStage = await page.evaluate(() => window.__reproOffStage ?? { count: 0, samples: [] });
if (offStage.count > 0) {
  console.log(`   ⚠ ${offStage.count} dispatched touch/pointer events landed OUTSIDE .mirror-stage — these can`);
  console.log("     never reach inputCapture.ts. First targets hit: " + offStage.samples.join(", "));
  console.log("     Likely cause: client-local UI state (e.g. the settings panel) the recording cannot carry —");
  console.log("     see --pre-tap and docs/agents/repro-recorder.md.");
}

// ---- renderer diagnostics -----------------------------------------------------------------------------------
// `diag.backend` always prints, even without --diag-out: it's the one field that tells a caller whether this run
// measured the Rust canvas stage or silently fell back to DOM (memory `rust-wasm-worktree-dom-fallback`), so
// "gate every measured cell on diag.backend === 'rust'" never needs a separate flag to check.
const rendererDiag = await page.evaluate(() => window.__mirrorRendererDiagnostics?.() ?? null);
const localBuilds = rendererDiag?.effective?.rustProducerReasons?.bySource?.local?.count ?? null;
console.log("");
console.log(`diag.backend: ${rendererDiag?.backend ?? "(no renderer diagnostics — pass ?stage=canvas or check the page loaded)"}`);
if (localBuilds !== null) console.log(`diag.rustProducerReasons.bySource.local.count: ${localBuilds}`);
if (args.diagOut) {
  // CDP Performance.getMetrics reports TaskDuration/ScriptDuration in SECONDS (cumulative, floating point) —
  // NOT ms. Converted here so every field this writes is unambiguously ms, named accordingly.
  const perfDeltaMs = perfMetrics.before && perfMetrics.after
    ? Object.fromEntries(
        ["TaskDuration", "ScriptDuration"].map((name) => [
          name, ((perfMetrics.after[name] ?? 0) - (perfMetrics.before[name] ?? 0)) * 1000
        ])
      )
    : null;
  const diagOutPath = resolve(REPO_ROOT, args.diagOut);
  mkdirSync(dirname(diagOutPath), { recursive: true });
  writeFileSync(diagOutPath, JSON.stringify({
    backend: rendererDiag?.backend ?? null,
    rendererDiagnostics: rendererDiag,
    scheduleLagMaxMs: Math.round(scheduleLagMax),
    completionLagMaxMs: Math.round(completionLagMax),
    completionLagP95Ms: Math.round(completionLagP95),
    skippedPreSeedGestures: skippedPreSeed,
    offStageTouchCount: offStage.count,
    replayedInputCount: replayedInputs.length,
    recordedInputCount: recordedInputs.length,
    perfWindow,
    perfMetricsRawSeconds: perfMetrics,
    perfDeltaMs
  }, null, 2));
  console.log(`diag written: ${diagOutPath}`);
  if (perfDeltaMs) {
    console.log(`  CDP Performance deltas over [${perfWindow.startMs}, ${perfWindow.endMs}]ms (recording clock), in ms:`);
    for (const [name, value] of Object.entries(perfDeltaMs)) console.log(`    ${name}: ${value.toFixed(3)}ms`);
  } else {
    console.log("  (no Performance deltas — the perf-mark tasks did not both land; re-run with a wider --window)");
  }
}

if (args.freeze !== null) {
  console.log(`\nfrozen at ${args.freeze}ms${args.keep ? " — browser left open" : ""}`);
}
if (args.keep) {
  console.log("--keep: press Ctrl-C to close");
  await new Promise(() => {});
}
await browser.close();
