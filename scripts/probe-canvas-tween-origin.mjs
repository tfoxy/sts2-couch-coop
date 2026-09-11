#!/usr/bin/env node
// THE ORIGIN-SNAP CENSUS for the single-canvas stage (`?stage=canvas`).
//
// The defect it exists to catch: interacting with a card made almost every OTHER hand card jump to the viewport
// corner for a frame and then ease back to where it belonged. The mechanism is a space error — a start-less tween
// hint arms from the node's CURRENT pose, and if the value handed to the evaluator is the node's LOCAL matrix
// instead of its rendered GLOBAL, a hand card (whose local matrix reads (0, 0) about its holder) arms from the
// design origin. Recorded matrices are parent-relative, so the error is not hypothetical.
//
//   # a dev server serving THE CODE UNDER TEST:
//   cd frontend && npx vite --port 5182 --strictPort
//   # then:
//   node scripts/probe-canvas-tween-origin.mjs --url http://127.0.0.1:5182 \
//     --recording .sts2/bench/wscrisp-hovertip.ndjson --res-root
//
// METHOD. Replay a recorded stream into the real mirror page at RECORDED pace — the recording already contains a
// player's card interaction and the hints it produced, so nothing has to be faked at the input end. After EVERY
// painted frame (the sampler wraps `requestAnimationFrame`, so it runs immediately after whichever callback
// painted, and skips frames the renderer did not repaint) read `window.__mirrorDrawListDump()` and follow each
// node's DRAWN ORIGIN from frame to frame.
//
// THE METRIC IS A TELEPORT TEST, NOT A PROXIMITY ONE. "Is anything drawn near (0, 0)" cannot answer this on its
// own: a stage's top-left corner is full of things that legitimately live there (the letterbox cover, the scene
// root, the energy/deck cluster), and a node that merely appears and disappears there is not a snap either. What
// the defect actually does is TELEPORT a node that was somewhere else — a card 900 px down the screen — to the
// corner for a frame or two and then ease it back. So a JUMPER is a node whose drawn origin was more than
// `--far` px from the design origin on the previous painted frame it appeared on, and is within `--radius` px of
// it on this one. Nothing that stays put, and nothing that is simply built or torn down at the corner, can
// register; a hand card yanked to (0, 0) cannot avoid registering.
//
// ATTRIBUTION, which is what makes it a gate rather than an observation. Not every teleport to the corner is
// this bug: a card that is PLAYED is genuinely torn out of the hand and rebuilt under another parent, and for a
// frame its children can be drawn at their new container's origin. Those happen with or without the fix, and
// they are indistinguishable from the defect by position alone.
//
// The discriminator is THE WIRE, and it is compared as a DISPLACEMENT rather than as a position. Every sample
// records the recorded timestamp of the last delta the fake socket had delivered, so each jump can be replayed
// against the stream offline and the node's STREAMED global — what the producer said, composed up the parent
// chain the producer described — computed for both ends of the jump. Displacement rather than position because a
// draw command's matrix carries the node's local-rect offset as well as its global, so the two are the same pose
// plus a constant; a difference cancels that constant out.
//
// A genuine reparent MOVES the wire by the same vector the canvas moved by. The defect does not: the producer
// has the card sitting still while the canvas yanks it 1,000 px into the corner. So a STRANDED jump — the canvas
// travelled, the wire did not, and no armed endpoint asked for it — is what the verdict is taken from.
//
// READ `strandedJumps` AGAINST AN A/B, NOT ALONE. The wire facts are an offline RECONSTRUCTION of the stream:
// the client's node map is rebuilt here from the same deltas, but a node re-parented on the very delta that
// hints it can resolve differently in the two, and then the endpoint this attributes to it is off. The signal
// that survives that is the DIFFERENCE between two runs of the same recording — which is how this probe is meant
// to be used, one arm per revision, never a single absolute count.
//
// `--tap` additionally drives a synthetic pointer drag on a hand card while the stream plays, so the HELD-CARD
// path (which captures a global and writes a cosmetic lift) is exercised at the same time as the hints — that is
// the reported scenario, where the focused card behaved and every other one did not.
//
// ASSETS. Pass `--res-root`: with `/res/**` 404ing, the texture bridge DEFERS every textured quad and the cards
// stop being in the draw list at all — the census would then be counting an empty stage and reporting a clean
// bill of health for a page that painted nothing.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { dirname, resolve } from "node:path";
import { RECOVERED_RESOURCE_ROOT, REPO_ROOT } from "./lib/repo-layout.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");


/** The same local extracted-resource root the bench and the card-trail probe read real asset bytes out of. */
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

function parseArgs(argv) {
  const a = {
    url: "http://127.0.0.1:5182",
    recording: ".sts2/bench/wscrisp-hovertip.ndjson",
    radius: 250,
    far: 500,
    wireMove: 120,
    width: 1920,
    height: 1080,
    query: "",
    limitMs: null,
    settleMs: 600,
    resRoot: null,
    tap: null,
    tapAt: null,
    out: null,
    shot: null
  };
  for (let i = 2; i < argv.length; i++) {
    const [k, inline] = argv[i].split("=");
    const next = () => (inline !== undefined ? inline : argv[++i]);
    if (k === "--url") a.url = next();
    else if (k === "--recording") a.recording = next();
    else if (k === "--radius") a.radius = Number(next());
    else if (k === "--far") a.far = Number(next());
    else if (k === "--wire-move") a.wireMove = Number(next());
    else if (k === "--width") a.width = Number(next());
    else if (k === "--height") a.height = Number(next());
    else if (k === "--query") a.query = next();
    else if (k === "--limit-ms") a.limitMs = Number(next());
    else if (k === "--settle") a.settleMs = Number(next());
    else if (k === "--out") a.out = next();
    else if (k === "--shot") a.shot = next();
    else if (k === "--tap") a.tap = next().split(",").map(Number);
    else if (k === "--tap-at") a.tapAt = Number(next());
    else if (k === "--res-root") {
      const peek = argv[i + 1];
      a.resRoot = inline !== undefined ? inline : peek != null && !peek.startsWith("--") ? argv[++i] : DEFAULT_RES_ROOT;
    }
  }
  return a;
}

// The in-page fake socket — the card-trail probe's, with the stop point replaced by an optional time limit and a
// tally of the transform hints the stream carried (so the census can say which nodes were actually animated).
function fakeWebSocketInit(config) {
  const OPEN = 1;
  window.__probeHintTargets = {};
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
      window.__probeT0 = t0;
      const tick = () => {
        const now = performance.now() - t0;
        while (this._i < this._msgs.length && this._msgs[this._i].t <= now) {
          if (config.limitMs != null && this._msgs[this._i].t > config.limitMs) {
            window.__probeDone = this._msgs[this._i].t;
            return;
          }
          this._deliver(this._msgs[this._i].data, this._msgs[this._i].t);
          this._i++;
        }
        if (this._i < this._msgs.length) {
          setTimeout(tick, Math.max(0, this._msgs[this._i].t - (performance.now() - t0)));
        } else {
          window.__probeDone = -1; // the whole stream played
        }
      };
      tick();
    }
    _deliver(data, t) {
      // WHERE THE STREAM HAS GOT TO, in the recording's own timebase. The census stamps every sample with it, so
      // a drawn pose can be compared offline against what the producer had actually said by that point — which
      // page wall-clock cannot do, because a stalled frame drifts away from the recorded timeline.
      if (typeof t === "number") window.__probeStreamT = t;
      // Tally every TRANSFORM hint the stream carries, keyed by target: those are the nodes whose `from` the
      // evaluator has to resolve, i.e. exactly the population this probe is about.
      if (data.includes('"hints"')) {
        try {
          const msg = JSON.parse(data);
          for (const h of msg.hints ?? []) {
            if (!h || !h.endTransform) continue;
            const rec = (window.__probeHintTargets[h.targetId] ??= { n: 0, declaredStart: 0 });
            rec.n++;
            if (h.startTransform) rec.declaredStart++;
          }
        } catch { /* a malformed line is the stream's problem, not the census's */ }
      }
      this._emit("message", new MessageEvent("message", { data }));
    }
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

// The census itself. Wraps rAF so a sample is taken straight after whichever callback painted — the reconcile's
// own synchronous paint included, which is the frame a freshly armed tween shows its `from` on and therefore the
// one a plain self-arming rAF loop is most likely to miss.
function censusInit(config) {
  const frames = [];
  const jumps = [];
  const lastAt = new Map(); // node id -> its drawn origin on the last painted frame it appeared on
  let lastFrames = -1;
  let painted = 0;

  function sample() {
    const stats = window.__mirrorCanvasStats?.();
    if (!stats || stats.frames === lastFrames) {
      return; // nothing repainted since the last look
    }
    lastFrames = stats.frames;
    const dump = window.__mirrorDrawListDump?.();
    if (!dump) return;
    painted++;
    const atMs = Math.round(performance.now() - (window.__probeT0 ?? 0));
    const near = new Set();
    const jumpers = [];
    let commands = 0;
    for (const line of dump) {
      if (line[0] !== "C") continue;
      commands++;
      const m = /\sm=([-\d.,]+)\s/.exec(line);
      if (!m) continue;
      const p = m[1].split(",");
      const x = Number(p[4]);
      const y = Number(p[5]);
      const id = line.split(" ")[2];
      const isNear = Math.abs(x) <= config.radius && Math.abs(y) <= config.radius;
      if (isNear) near.add(id);
      const prev = lastAt.get(id);
      if (isNear && prev && Math.hypot(prev.x - x, prev.y - y) > config.far) {
        jumpers.push({
          id,
          from: [Math.round(prev.x), Math.round(prev.y)],
          to: [Math.round(x), Math.round(y)],
          fromStreamT: prev.streamT
        });
      }
      lastAt.set(id, { x, y, streamT: window.__probeStreamT ?? null });
    }
    if (jumpers.length > 0 && jumps.length < config.maxSamples) {
      // `animActive` is the evaluator's live node count. A jump taken with NOTHING armed cannot have come from
      // the tween path at all — the frame was built straight from the streamed state — so it is the third thing
      // the classification needs to be able to say.
      jumps.push({
        frame: stats.frames,
        atMs,
        streamT: window.__probeStreamT ?? null,
        animActive: stats.animActive,
        jumpers
      });
    }
    if (frames.length < config.maxSamples) {
      frames.push({ frame: stats.frames, atMs, commands, near: near.size });
    }
  }

  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      try {
        cb(t);
      } finally {
        try { sample(); } catch { /* never break the page for a census */ }
      }
    });

  window.__probeCensus = () => ({ frames, jumps, paintedFrames: painted });
}

/** A wire transform (`{xAxis,yAxis,origin}` or a bare 6-tuple) as `[a,b,c,d,tx,ty]`, or null. */
function wireTransform6(tr) {
  if (!tr) return null;
  if (Array.isArray(tr)) return tr.length === 6 ? tr : null;
  const { xAxis: x, yAxis: y, origin: o } = tr;
  return x && y && o ? [x.x, x.y, y.x, y.y, o.x, o.y] : null;
}

function mul6(m, t) {
  const [a, b, c, d, e, f] = m;
  return [
    a * t[0] + c * t[1], b * t[0] + d * t[1],
    a * t[2] + c * t[3], b * t[2] + d * t[3],
    a * t[4] + c * t[5] + e, b * t[4] + d * t[5] + f
  ];
}

/**
 * ONE offline replay of the recording, answering everything the classification needs at a named stream moment:
 *
 *   * `globalOf(id)`  — the streamed global the producer had that node at, composed up the parent chain.
 *   * `armedHints`    — the transform hints armed on that node OR ANY ANCESTOR whose window is still open, each
 *                       with the endpoint LIFTED the way the client lifts it (through the target's parent global)
 *                       and the target's global at the arm. A card's tween moves its whole subtree, so a
 *                       descendant has to be judged against its ancestor's endpoint.
 *
 * Queries are served in stream order, so this is a single pass however many jumps there were.
 */
function wireFactsAt(text, queries) {
  const nodes = new Map();
  const live = []; // { targetId, endsAt, endLifted, targetGlobalAtArm }
  const pending = [...queries].sort((a, b) => a.streamT - b.streamT);
  const answers = new Map();
  let next = 0;
  const globalOf = (id) => {
    const chain = [];
    let cur = nodes.get(id);
    let guard = 0;
    while (cur && guard++ < 256) {
      chain.push(cur);
      cur = cur.parentId != null ? nodes.get(cur.parentId) : undefined;
    }
    let m = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const t = chain[i].t;
      if (!t) continue;
      m = m === null ? t.slice() : mul6(m, t);
    }
    return m;
  };
  const chainOf = (id) => {
    const out = [];
    let cur = id;
    let guard = 0;
    while (cur != null && guard++ < 256) {
      out.push(cur);
      cur = nodes.get(cur)?.parentId ?? null;
    }
    return out;
  };

  const serve = (upTo) => {
    while (next < pending.length && pending[next].streamT <= upTo) {
      const q = pending[next++];
      const chain = new Set(chainOf(q.id));
      answers.set(q.key, {
        global: globalOf(q.id),
        armedHints: live
          .filter((h) => h.endsAt >= q.streamT && chain.has(h.targetId))
          .map((h) => ({ targetId: h.targetId, endLifted: h.endLifted, targetGlobalAtArm: h.targetGlobalAtArm }))
      });
    }
  };

  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.meta || typeof rec.data !== "string") continue;
    let msg;
    try { msg = JSON.parse(rec.data); } catch { continue; }
    if (msg.type !== "scene-delta") continue;
    if (msg.full) {
      nodes.clear();
      live.length = 0;
    }
    for (const id of msg.removedIds ?? []) nodes.delete(id);
    for (const u of msg.upserts ?? []) {
      const prev = nodes.get(u.id);
      nodes.set(u.id, {
        parentId: u.parentId !== undefined ? u.parentId : (prev?.parentId ?? null),
        t: wireTransform6(u.transform) ?? prev?.t ?? null
      });
    }
    for (const h of msg.hints ?? []) {
      if (!h || !h.endTransform) continue;
      const parentId = nodes.get(h.targetId)?.parentId ?? null;
      const parentGlobal = parentId != null ? globalOf(parentId) : null;
      live.push({
        targetId: h.targetId,
        // Generous: the settled value is HELD after the window closes (the pin retains it), so an endpoint stays
        // a legitimate destination well past the tween's own duration.
        endsAt: rec.t + Math.max(0, h.durationMs) + 2000,
        endLifted: parentGlobal ? mul6(parentGlobal, h.endTransform) : h.endTransform,
        targetGlobalAtArm: globalOf(h.targetId)
      });
    }
    serve(rec.t);
  }
  serve(Infinity);
  return answers;
}

const args = parseArgs(process.argv);
const recordingPath = resolve(REPO_ROOT, args.recording);
const recordingText = readFileSync(recordingPath, "utf8"); // fail fast with a clear ENOENT, not inside the browser
requireReproHeader(recordingText, recordingPath);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: args.width, height: args.height } });

await context.route("**/__probe_recording", (route) =>
  route.fulfill({ status: 200, contentType: "text/plain", body: recordingText })
);

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
  limitMs: args.limitMs
});
await context.addInitScript(censusInit, { radius: args.radius, far: args.far, maxSamples: 4000 });

const page = await context.newPage();
const query = ["stage=canvas", "paintDump=1", args.query].filter(Boolean).join("&");
await page.goto(`${args.url}/?${query}`, { waitUntil: "domcontentloaded" });

// A synthetic pointer drag on a hand card, in DESIGN coordinates mapped through the stage's own rect — the same
// interaction the defect was reported for. Fire-and-forget: the census keeps running underneath it.
let tapped = null;
if (args.tap) {
  const startAt = Date.now();
  await page.waitForFunction(() => document.querySelector(".mirror-stage") != null, null, { timeout: 60000 });
  if (args.tapAt != null) {
    await page.waitForFunction(
      (at) => window.__probeT0 != null && performance.now() - window.__probeT0 >= at,
      args.tapAt,
      { timeout: 120000 }
    );
  }
  const box = await page.evaluate(() => {
    const stage = document.querySelector(".mirror-stage");
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height, lw: stage.clientWidth, lh: stage.clientHeight };
  });
  if (box) {
    const cx = box.left + (args.tap[0] / box.lw) * box.w;
    const cy = box.top + (args.tap[1] / box.lh) * box.h;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(cx, cy - i * 25);
      await page.waitForTimeout(24);
    }
    await page.mouse.up();
    tapped = { designX: args.tap[0], designY: args.tap[1], clientX: Math.round(cx), clientY: Math.round(cy), waitedMs: Date.now() - startAt };
  }
}

await page.waitForFunction(() => window.__probeDone !== undefined, null, { timeout: 180000 });
await page.waitForTimeout(args.settleMs);

if (args.shot) {
  const shotPath = resolve(REPO_ROOT, args.shot);
  mkdirSync(dirname(shotPath), { recursive: true });
  await page.screenshot({ path: shotPath });
}

const census = await page.evaluate(() => window.__probeCensus?.() ?? null);
const hintTargets = await page.evaluate(() => window.__probeHintTargets ?? {});
const stats = await page.evaluate(() => window.__mirrorCanvasStats?.() ?? null);
await browser.close();

if (!census || census.frames.length === 0) {
  console.error("no census samples — did the page render at all? (check the dev server and ?stage=canvas)");
  process.exit(2);
}

// Ask the WIRE how far each jumper was supposed to have travelled between the two frames the canvas moved it on.
const queries = [];
for (const j of census.jumps) {
  for (const k of j.jumpers) {
    queries.push({ key: `${j.frame}:${k.id}:to`, id: k.id, streamT: j.streamT ?? j.atMs });
    queries.push({ key: `${j.frame}:${k.id}:from`, id: k.id, streamT: k.fromStreamT ?? j.streamT ?? j.atMs });
  }
}
const wireFacts = wireFactsAt(recordingText, queries);

// THREE BUCKETS, in the order a jump is excused:
//   wireAgreed — the producer moved the node by the same vector: a reparent/teardown, not this bug.
//   authored   — the canvas landed where a hint armed on the node or an ancestor ASKED it to land. The producer
//                really does fling a played card off the top-left corner, and a faithful client following that
//                endpoint is not snapping. Judged as a DISPLACEMENT from the target's pose at the arm, so the
//                descendant's own constant offset from its ancestor drops out.
//   stranded   — everything else: the canvas travelled, the wire did not, and no endpoint asked for it.
const stranded = [];
const agreed = [];
const authored = [];
for (const j of census.jumps) {
  const s = [];
  const a = [];
  const au = [];
  for (const k of j.jumpers) {
    const to = wireFacts.get(`${j.frame}:${k.id}:to`);
    const from = wireFacts.get(`${j.frame}:${k.id}:from`);
    const g1 = to?.global ?? null;
    const g0 = from?.global ?? null;
    const wireMoved = g0 && g1 ? Math.round(Math.hypot(g1[4] - g0[4], g1[5] - g0[5])) : null;
    const drawnMoved = Math.round(Math.hypot(k.to[0] - k.from[0], k.to[1] - k.from[1]));
    // How far each armed endpoint asked the node's ancestor to travel from where it was at the arm.
    let bestHint = null;
    for (const h of to?.armedHints ?? []) {
      if (!h.targetGlobalAtArm) continue;
      const askedX = h.endLifted[4] - h.targetGlobalAtArm[4];
      const askedY = h.endLifted[5] - h.targetGlobalAtArm[5];
      const miss = Math.round(Math.hypot(k.from[0] + askedX - k.to[0], k.from[1] + askedY - k.to[1]));
      if (bestHint === null || miss < bestHint.miss) {
        bestHint = { targetId: h.targetId, asked: [Math.round(askedX), Math.round(askedY)], miss };
      }
    }
    const entry = {
      ...k,
      drawnMoved,
      wireMoved,
      wireTo: g1 ? [Math.round(g1[4]), Math.round(g1[5])] : null,
      hint: bestHint
    };
    if (wireMoved != null && wireMoved > Math.max(args.wireMove, drawnMoved * 0.25)) a.push(entry);
    else if (bestHint && bestHint.miss <= args.radius) au.push(entry);
    else s.push(entry);
  }
  const head = { frame: j.frame, atMs: j.atMs, streamT: j.streamT, animActive: j.animActive };
  if (s.length > 0) stranded.push({ ...head, jumpers: s });
  if (a.length > 0) agreed.push({ ...head, jumpers: a });
  if (au.length > 0) authored.push({ ...head, jumpers: au });
}
const authoredNodes = new Set();
for (const j of authored) for (const k of j.jumpers) authoredNodes.add(k.id);
const strandedNodes = new Set();
for (const j of stranded) for (const k of j.jumpers) strandedNodes.add(k.id);
const agreedNodes = new Set();
for (const j of agreed) for (const k of j.jumpers) agreedNodes.add(k.id);
const hinted = Object.entries(hintTargets);
const report = {
  recording: args.recording,
  radius: args.radius,
  far: args.far,
  wireMove: args.wireMove,
  paintedFrames: census.paintedFrames,
  sampledFrames: census.frames.length,
  transformHints: {
    targets: hinted.length,
    total: hinted.reduce((n, [, r]) => n + r.n, 0),
    withDeclaredStart: hinted.reduce((n, [, r]) => n + r.declaredStart, 0)
  },
  // THE GATE: drawn in the corner, and the wire never put it there.
  strandedJumps: {
    frames: stranded.length,
    distinctNodes: strandedNodes.size,
    all: stranded.slice(0, 12)
  },
  // Context: teleports the WIRE also made — a card played out of the hand and rebuilt under another parent.
  // Normal, and expected to be unchanged across an A/B of this fix.
  wireAgreedJumps: {
    frames: agreed.length,
    distinctNodes: agreedNodes.size,
    all: agreed.slice(0, 8)
  },
  // Context: teleports a HINT ENDPOINT asked for. Also normal — and also expected to be unchanged, because the
  // endpoint is lifted the same way before and after this fix; only the tween's `from` moved.
  hintAuthoredJumps: {
    frames: authored.length,
    distinctNodes: authoredNodes.size,
    all: authored.slice(0, 8)
  },
  // Context only: how many ids sat within `--radius` of the corner, per frame. Furniture makes this non-zero on
  // a perfectly healthy page, which is exactly why it is not the verdict.
  nearOriginPerFrame: {
    median: census.frames.map((f) => f.near).sort((a, b) => a - b)[census.frames.length >> 1],
    peak: Math.max(...census.frames.map((f) => f.near))
  },
  tap: tapped,
  canvasStats: stats && { frames: stats.frames, animFrames: stats.animFrames, commands: stats.commands },
  res: args.resRoot ? { root: args.resRoot, hits: resHits, missCount: resMisses.size, misses: [...resMisses].slice(0, 10) } : null,
  // THE VERDICT. Nothing may be drawn in the design origin that the producer has somewhere else.
  verdict: stranded.length > 0 ? "ORIGIN SNAP DETECTED" : "clean"
};

const text = JSON.stringify(report, null, 2);
if (args.out) {
  const outPath = resolve(REPO_ROOT, args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text + "\n");
  console.error(`  census -> ${outPath}`);
}
console.log(text);
process.exit(report.verdict === "clean" ? 0 : 1);
