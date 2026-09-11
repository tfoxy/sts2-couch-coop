#!/usr/bin/env node
// Input→render LATENCY measurement for the mirror client, against a RUNNING game + vite dev server:
//   node scripts/measure-latency.mjs
//   COUCHCOOP_CPU_THROTTLE=6 node scripts/measure-latency.mjs   # emulate a low-end laptop CPU
//
// Prerequisites: the game on :13337 (any screen with a presentation scene), and `npm run dev` in frontend/
// serving :5173.
//
// Reports two metrics (see the latency plan):
//   1. ping→pong RTT — the CONSISTENT, game-independent round-trip the client measures via its `?latency=1`
//      probe (host echoes a timestamped ping through the same send path as scene deltas, so it reflects real
//      send congestion). p50/p95/max over N samples. This is the number to watch (target p95 ≤ 50ms).
//   2. hover→render — a real end-to-end spot-check: move the pointer over the stage (a safe, state-free input
//      the game reacts to) and time, via an in-page MutationObserver, until the resulting scene-delta repaints
//      the DOM. Depends on the game producing a change, so it's a best-effort proxy for "click→selected".

import { createRequire } from "node:module";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const BASE_URL = process.env.COUCHCOOP_VALIDATE_URL ?? "http://127.0.0.1:5173/?latency=1";
const CPU_THROTTLE = Number(process.env.COUCHCOOP_CPU_THROTTLE ?? "1");
const PING_SAMPLES = Number(process.env.COUCHCOOP_PING_SAMPLES ?? "40");
const HOVER_SAMPLES = Number(process.env.COUCHCOOP_HOVER_SAMPLES ?? "20");
const SCENE_TIMEOUT_MS = Number(process.env.COUCHCOOP_SCENE_TIMEOUT_MS ?? "120000");

function stats(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1], count: sorted.length };
}

const fmt = (v) => (v === null || v === undefined ? "—" : `${Math.round(v)}ms`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const cdp = await page.context().newCDPSession(page);
if (CPU_THROTTLE > 1) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  console.log(`CPU throttle: ${CPU_THROTTLE}x`);
}

console.log(`connecting to ${BASE_URL} ...`);
await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

let sceneReady = false;
try {
  await page.waitForFunction(() => document.querySelectorAll("[data-node-id]").length > 20, null, {
    timeout: SCENE_TIMEOUT_MS,
  });
  sceneReady = true;
} catch {
  console.error(`scene never rendered within ${SCENE_TIMEOUT_MS}ms — measuring what we can`);
}

// --- 1. ping→pong RTT: poll the client's own rolling latency until it has enough samples -----------------
console.log(`collecting ${PING_SAMPLES} ping samples (probe runs every 250ms) ...`);
try {
  await page.waitForFunction(
    (n) => (window.__mirrorLatency?.()?.count ?? 0) >= n,
    PING_SAMPLES,
    { timeout: PING_SAMPLES * 250 + 10_000 },
  );
} catch {
  console.error("did not reach the target ping-sample count — reporting what was collected");
}
const ping = await page.evaluate(() => window.__mirrorLatency?.() ?? null);

// --- 2. hover→render: move the pointer, time to the resulting DOM mutation -------------------------------
const rect = await page.evaluate(() => {
  const stage = document.querySelector(".mirror-stage");
  if (!stage) {
    return null;
  }
  const r = stage.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
});

const hoverSamples = [];
if (rect && rect.width > 0 && rect.height > 0) {
  for (let i = 0; i < HOVER_SAMPLES; i++) {
    await page.evaluate(() => {
      window.__mut = new Promise((resolve) => {
        const stage = document.querySelector(".mirror-stage");
        if (!stage) {
          resolve(null);
          return;
        }
        const t0 = performance.now();
        const obs = new MutationObserver(() => {
          obs.disconnect();
          resolve(performance.now() - t0);
        });
        obs.observe(stage, { attributes: true, childList: true, subtree: true, characterData: true });
        setTimeout(() => {
          obs.disconnect();
          resolve(null);
        }, 1500);
      });
    });
    // A point that moves each iteration so the game's cursor/targeting actually changes (→ a scene delta).
    const x = rect.x + rect.width * (0.2 + 0.6 * ((i % 10) / 10));
    const y = rect.y + rect.height * (0.3 + 0.4 * ((i % 7) / 7));
    await page.mouse.move(x, y);
    const dt = await page.evaluate(() => window.__mut);
    if (typeof dt === "number") {
      hoverSamples.push(dt);
    }
    await page.waitForTimeout(80);
  }
}

const pingStats = ping && ping.count > 0 ? { p50: ping.p50, p95: ping.p95, max: null, count: ping.count } : null;
const hoverStats = stats(hoverSamples);

console.log("");
console.log(`scene:        ${sceneReady ? "ready" : "NOT ready"}`);
if (pingStats) {
  console.log(`ping RTT:     p50 ${fmt(pingStats.p50)}  p95 ${fmt(pingStats.p95)}  (n=${pingStats.count}, last ${fmt(ping.lastMs)})`);
} else {
  console.log("ping RTT:     no samples (is ?latency=1 on / is the host updated?)");
}
if (hoverStats) {
  console.log(`hover→render: p50 ${fmt(hoverStats.p50)}  p95 ${fmt(hoverStats.p95)}  max ${fmt(hoverStats.max)}  (n=${hoverStats.count}/${HOVER_SAMPLES})`);
} else {
  console.log(`hover→render: no mutations observed (the game produced no tree change on hover)`);
}

const targetMet = pingStats !== null && pingStats.p95 !== null && pingStats.p95 <= 50;
console.log("");
console.log(targetMet ? "✓ ping p95 within the 50ms target" : "✗ ping p95 above the 50ms target (or no samples)");

await browser.close();
process.exit(targetMet ? 0 : 1);
