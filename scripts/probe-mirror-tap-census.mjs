#!/usr/bin/env node
// Mirror TAP-COST + DOM/LISTENER CENSUS probe (offline; no live game, no device).
//
// Replays a recorded scene-delta stream (scripts/record-mirror-stream.mjs) into a real headless Chromium running
// the actual mirror page — the same in-page fake WebSocket bench-mirror-replay.mjs uses, so the stream is the
// invariant and the only variable is the code the dev server serves. Then, after settle, it reports the three
// things a phone-perf round keeps needing and the bench does not measure:
//
//   1. TAP COST — cumulative `RecalcStyleDuration` across N synthetic press/release pairs. This is what catches a
//      document-wide style invalidation on pointerdown (Aug-11: the game cursor's root-class toggle against its
//      `.game-cursor *` rules cost 133.96ms of recalc PER TAP at 4x CPU throttle on a ~5,600-element map; the
//      per-element press that replaced it costs 0.29ms).
//   2. DOM/LISTENER CENSUS — CDP `Nodes`/`JSEventListeners` plus a LIVE listener count attributed to the code
//      that registered it (addEventListener/removeEventListener are wrapped before any page script). This is how
//      the one-shot image `load` handlers that never came off (one per texture url, forever) were found.
//   3. EFFECT BACKING STORES — every effect canvas's CSS box vs its backing store, i.e. what render scale this
//      device actually paints at, plus window.__mirrorAtlasBakeStats.
//
// USAGE (dev server must serve the checkout under test — never `npm run build`, that DEPLOYS):
//   cd frontend && npx vite --port 5199 --strictPort &
//   node scripts/probe-mirror-tap-census.mjs --url http://127.0.0.1:5199 --label branch --out /tmp/a.json
//   node scripts/probe-mirror-tap-census.mjs --url http://127.0.0.1:5199 --desktop        # desktop pointer/UA
//
// `--mobile` (the default) sets BOTH the UA string and UA-CH `userAgentMetadata.mobile`, because
// render/quality.ts' mobile seam reads `navigator.userAgentData.mobile` first and a UA string alone leaves it
// false. NOTE headless Chromium has no GPU: a mobile run resolves to the `off` tier (software WebGL ⇒ effects
// off), so this probe can prove WHICH backing store a live effect got, but never what it costs — that needs a
// real device (see docs/agents/qa-recipes.md).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const url = arg("--url", "http://127.0.0.1:5199");
const label = arg("--label", "run");
const out = arg("--out", null);
const taps = Number(arg("--taps", 20));
const cpuThrottle = Number(arg("--cpu", 4));
const query = arg("--query", "");
const desktop = argv.includes("--desktop");
const recordingPath = arg("--recording", new URL("../.sts2/bench/r8-map-live.ndjson", import.meta.url).pathname);
const recordingText = readFileSync(recordingPath, "utf8");
requireReproHeader(recordingText, recordingPath);
const hasRecordedDirectView = recordingText.includes('"directView":true');

const PHONE_UA =
  "Mozilla/5.0 (Linux; Android 15; moto g86) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36";

// ---------------------------------------------------------------------------------------------------------
// in-page: the fake WebSocket (same contract as bench-mirror-replay.mjs — recorded pacing, synthesized
// directView when the recording has none, raw strings so the client pays the real JSON.parse)
// ---------------------------------------------------------------------------------------------------------
function fakeWebSocketInit(config) {
  const realFetch = window.fetch.bind(window);
  class BenchWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    constructor(u) {
      super();
      this.url = String(u);
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this._msgs = [];
      this._i = 0;
      this._closed = false;
      window.__benchWs = this;
      if (this.url.includes("/ws")) this._start();
    }
    async _start() {
      let text = "";
      try {
        text = await (await realFetch(config.recordingUrl)).text();
      } catch (e) {
        window.__benchWsError = String(e);
        return;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.meta || typeof obj.data !== "string") continue;
        if (obj.data.includes('"type":"server-reload"')) continue;
        this._msgs.push({ t: typeof obj.t === "number" ? obj.t : 0, data: obj.data });
      }
      this.readyState = 1;
      this._emit("open", new Event("open"));
      if (config.synthesizeDirectView) this._deliver('{"type":"session","directView":true}');
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
          window.__benchDone = true;
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
    send() {}
    close() { this._closed = true; this.readyState = 3; }
  }
  window.WebSocket = BenchWebSocket;
}

// ---------------------------------------------------------------------------------------------------------
// in-page: live listener census, attributed to the registering source line
// ---------------------------------------------------------------------------------------------------------
function listenerCensusInit() {
  const live = new Map();
  const site = () => {
    const lines = (new Error().stack ?? "").split("\n").slice(3, 8);
    for (const l of lines) {
      const m = /(https?:\/\/[^\s)]+)/.exec(l);
      if (m) return m[1].replace(/^https?:\/\/[^/]+/, "");
    }
    return lines[0]?.trim() ?? "?";
  };
  const keyOf = (target, type, where) => {
    let kind = "unknown";
    try {
      kind = target === window ? "window" : target === document ? "document" : (target?.constructor?.name ?? "?");
      if (target instanceof Element) {
        const cls = typeof target.className === "string" ? target.className.trim().split(/\s+/)[0] : "";
        kind = target.tagName.toLowerCase() + (cls ? "." + cls : "");
      }
    } catch { /* cross-origin/detached */ }
    return `${kind} | ${type} | ${where}`;
  };
  const realAdd = EventTarget.prototype.addEventListener;
  const realRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    try {
      const key = keyOf(this, type, site());
      const rec = live.get(key) ?? { count: 0, adds: 0, removes: 0 };
      rec.adds++;
      rec.count++;
      live.set(key, rec);
      if (listener) { try { listener.__censusKey = key; } catch { /* frozen */ } }
    } catch { /* never break the page */ }
    return realAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    try {
      const rec = listener?.__censusKey ? live.get(listener.__censusKey) : null;
      if (rec) { rec.removes++; rec.count--; }
    } catch { /* ignore */ }
    return realRemove.call(this, type, listener, options);
  };
  window.__listenerCensus = () =>
    [...live.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count);
}

function domCensusInPage() {
  const all = document.querySelectorAll("*");
  const byClass = {};
  for (const el of all) {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    if (cls) byClass[cls] = (byClass[cls] ?? 0) + 1;
  }
  const stage = document.querySelector(".mirror-stage");
  return {
    documentElements: all.length,
    stageElements: stage ? stage.querySelectorAll("*").length : 0,
    mirrorNodes: document.querySelectorAll(".mirror-node").length,
    canvases: document.querySelectorAll("canvas").length,
    images: document.querySelectorAll("img").length,
    byClass: Object.entries(byClass).sort((a, b) => b[1] - a[1]).slice(0, 15)
  };
}

// ---------------------------------------------------------------------------------------------------------

const browser = await chromium.launch({ args: ["--disable-gpu"] });
const context = desktop
  ? await browser.newContext({ viewport: { width: 1600, height: 900 } })
  : await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
      userAgent: PHONE_UA
    });
await context.route("**/__bench/recording", (route) =>
  route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: recordingText })
);
await context.addInitScript(listenerCensusInit);
await context.addInitScript(fakeWebSocketInit, {
  recordingUrl: "/__bench/recording",
  synthesizeDirectView: !hasRecordedDirectView
});

const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
if (!desktop) {
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: PHONE_UA,
    userAgentMetadata: {
      brands: [{ brand: "Chromium", version: "150" }],
      fullVersion: "150.0.0.0",
      platform: "Android",
      platformVersion: "15",
      architecture: "",
      model: "moto g86",
      mobile: true
    }
  });
}
if (cpuThrottle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

const consoleLines = [];
page.on("console", (m) => consoleLines.push(m.text()));

const pageUrl = `${url}/?bench=1${query}`;
await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll(".mirror-node").length > 50, null, { timeout: 180_000 });
try {
  await page.waitForFunction(() => window.__benchDone === true, null, { timeout: 240_000 });
} catch {
  console.error(`  stream did not finish (${await page.evaluate(() => window.__benchWsError ?? "no ws error")})`);
}
await page.waitForTimeout(2000);

const effectCanvases = await page.evaluate(() => {
  const out = [];
  for (const c of document.querySelectorAll("canvas")) {
    const r = c.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    out.push({
      cls: c.className,
      css: [Math.round(r.width), Math.round(r.height)],
      backing: [c.width, c.height],
      backingPerCssPx: r.width > 0 ? Math.round((c.width / (r.width * (window.devicePixelRatio || 1))) * 1000) / 1000 : null
    });
  }
  return out;
});

const readMetrics = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const g = (n) => metrics.find((m) => m.name === n)?.value ?? 0;
  return { recalc: g("RecalcStyleDuration"), layout: g("LayoutDuration"), task: g("TaskDuration"), nodes: g("Nodes"), listeners: g("JSEventListeners") };
};

const center = await page.evaluate(() => {
  const s = document.querySelector(".mirror-stage");
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.waitForTimeout(500);
const before = await readMetrics();
if (center) {
  for (let i = 0; i < taps; i++) {
    // A press/release pair with a forced style flush after each, so the recalc the press schedules is attributed
    // to this window rather than to whatever frame happens next.
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: "left", clickCount: 1, pointerType: "mouse" });
    await page.evaluate(() => document.documentElement.offsetHeight);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: "left", clickCount: 1, pointerType: "mouse" });
    await page.evaluate(() => document.documentElement.offsetHeight);
  }
}
const after = await readMetrics();

const listeners = await page.evaluate(() => (window.__listenerCensus ? window.__listenerCensus() : []));
const result = {
  label,
  emulated: true,
  profile: desktop ? "desktop" : "mobile(UA+UA-CH)",
  url: pageUrl,
  recording: recordingPath,
  cpuThrottle,
  quality: consoleLines.filter((l) => l.startsWith("[render] quality")),
  atlasBakeLog: consoleLines.filter((l) => l.includes("atlas region bake")),
  metrics: { nodes: after.nodes, jsEventListeners: after.listeners },
  dom: await page.evaluate(domCensusInPage),
  effectCanvases,
  atlasBakeStats: await page.evaluate(() => window.__mirrorAtlasBakeStats ?? null),
  taps,
  tapCost: {
    recalcMsPerTap: Math.round(((after.recalc - before.recalc) * 1000 / Math.max(1, taps)) * 100) / 100,
    recalcMsTotal: Math.round((after.recalc - before.recalc) * 1000),
    layoutMsTotal: Math.round((after.layout - before.layout) * 1000),
    taskMsTotal: Math.round((after.task - before.task) * 1000)
  },
  listenersLive: listeners.reduce((a, r) => a + Math.max(0, r.count), 0),
  listenerTop: listeners.filter((r) => r.count > 0).slice(0, 20)
};

console.log(JSON.stringify(result, null, 2));
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
await browser.close();
