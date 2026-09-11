#!/usr/bin/env node
// Startup-performance measurement for the browser client, against a RUNNING game +
// vite dev server:
//   node scripts/measure-startup-live.mjs
//   COUCHCOOP_CPU_THROTTLE=6 node scripts/measure-startup-live.mjs   # phone-ish CPU
//
// Prerequisites: the game on :13337 (any screen the mirror can stream, e.g. the Neow
// event), and `npm run dev` in frontend/ serving :5173.
//
// Reports:
//   - time-to-scene: page.goto -> >50 .mirror-node elements rendered
//   - ScriptDuration/TaskDuration (CDP Performance.getMetrics) at scene-ready, and the
//     delta over a 10s idle window after (steady-state JS burn)
//   - /res/ request count + first/last request timestamps (fetch waterfall spread)

import { createRequire } from "node:module";
import { assertLease } from "./live-qa-lock.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const BASE_URL = process.env.COUCHCOOP_VALIDATE_URL ?? "http://127.0.0.1:5173/?name=2";
const CPU_THROTTLE = Number(process.env.COUCHCOOP_CPU_THROTTLE ?? "1");
const SCENE_TIMEOUT_MS = Number(process.env.COUCHCOOP_SCENE_TIMEOUT_MS ?? "120000");
const IDLE_WINDOW_MS = 10_000;

assertLease({
  owner: process.env.COUCHCOOP_LIVEQA_OWNER,
  pid: Number(process.env.COUCHCOOP_LIVEQA_PID),
  resources: ["shared:install", `shared:game:${process.env.COUCHCOOP_LIVEQA_GAME_RESOURCE ?? "default"}`]
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

// Swallow outgoing action envelopes so nothing here can ever reach the live game.
await page.addInitScript(() => {
  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (msg) {
    if (typeof msg === "string") {
      try {
        if (JSON.parse(msg)?.type === "action") return;
      } catch {
        // not JSON — pass through
      }
    }
    return origSend.call(this, msg);
  };
});

const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
if (CPU_THROTTLE > 1) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  console.log(`CPU throttle: ${CPU_THROTTLE}x`);
}

const metrics = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { script: get("ScriptDuration"), task: get("TaskDuration"), layout: get("LayoutDuration") };
};

const resRequests = [];
page.on("request", (req) => {
  const url = req.url();
  if (url.includes("/res/") || url.includes("/bg/") || url.includes("/spines/")) {
    resRequests.push({ url, t: performance.now() });
  }
});

console.log(`connecting to ${BASE_URL} ...`);
const t0 = performance.now();
await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
let sceneReady = false;
try {
  await page.waitForFunction(() => document.querySelectorAll(".mirror-node").length > 50, null, {
    timeout: SCENE_TIMEOUT_MS,
  });
  sceneReady = true;
} catch {
  console.error(`scene never rendered within ${SCENE_TIMEOUT_MS}ms — measuring what we can`);
}
const tScene = performance.now() - t0;
const atReady = await metrics();
const nodesAtReady = await page.evaluate(() => document.querySelectorAll(".mirror-node").length);

// The idle window is timed by wall clock around the metrics round trips: when the
// main thread is saturated, waitForTimeout+getMetrics stretch far past the nominal
// window, so busy% must use the actual elapsed time.
const tIdleStart = performance.now();
await page.waitForTimeout(IDLE_WINDOW_MS);
const atIdle = await metrics();
const idleElapsed = (performance.now() - tIdleStart) / 1000;

const fmt = (s) => `${s.toFixed(2)}s`;
console.log("");
console.log(`time-to-scene:        ${sceneReady ? fmt(tScene / 1000) : `TIMEOUT (${fmt(tScene / 1000)})`} (${nodesAtReady} nodes)`);
console.log(`ScriptDuration@ready: ${fmt(atReady.script)}  TaskDuration@ready: ${fmt(atReady.task)}`);
console.log(
  `idle burn (${fmt(idleElapsed)} actual): script ${fmt(atIdle.script - atReady.script)}  task ${fmt(atIdle.task - atReady.task)}` +
    `  (${(((atIdle.task - atReady.task) / idleElapsed) * 100).toFixed(0)}% busy)`,
);
if (resRequests.length > 0) {
  const first = (resRequests[0].t - t0) / 1000;
  const last = (resRequests[resRequests.length - 1].t - t0) / 1000;
  console.log(`resource requests:    ${resRequests.length} (first ${fmt(first)}, last ${fmt(last)})`);
}

await browser.close();
process.exit(sceneReady ? 0 : 1);
