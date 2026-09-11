#!/usr/bin/env node
// Live validation for the browser map overlay, against a RUNNING game + vite dev server:
//   node scripts/validate-map-overlay-live.mjs
//
// Prerequisites: the game on :13337 with a run in progress on a screen that has the
// top-bar map button (e.g. the Neow event fixture), and `npm run dev` in frontend/
// serving :5173 (which proxies /ws /res /bg /spines).
//
// Verifies, in a headless Chromium attached as an existing player:
//   1. parchment background present on FIRST map open
//   2. legend (A) hotkey glyph is hidden, legend labels have text
//   3. parchment background STILL present after close + re-open
//
// SAFETY: every outgoing `type:"action"` websocket envelope is swallowed in-page before
// the app boots, so nothing this script clicks can ever reach the live game.
//
// STATUS -- NOT YET PROVEN AGAINST THE MIRROR CLIENT. The URL, the DOM attribute
// (`data-node-path`) and the selectors below were retargeted from the removed structured
// client, but two of the original five checks were dropped because they are not mirror
// properties, and the DRIVE path still needs a live pass:
//   * the mirror sets `pointer-events: auto` on EVERY `.mirror-node`, so "is the backstop
//     hit-targetable" and "does a parchment click fall through to a button behind the map"
//     stopped being client-side questions -- hit arbitration happens in `inputCapture` over
//     the interactive-rect registry (`window.__mirrorInteractiveRects()`), and the game,
//     not the page, decides what a coordinate lands on.
//   * the mirror's pointer wire is COORDINATE-ONLY (`type:"input"`), so the synthetic DOM
//     `click` used here to open/close the map does nothing, and the action-swallowing
//     safety net does not cover input envelopes. Opening the map from the top bar means
//     real pointer events against the live game -- read docs/agents/touch-live-harness.md
//     and use the `touch-input-qa` agent before pointing this at anything live.
// Run it under the live-QA lock against a fixture instance, and fix the drive path first.

import { createRequire } from "node:module";
import { assertLease } from "./live-qa-lock.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const BASE_URL = process.env.COUCHCOOP_VALIDATE_URL ?? "http://127.0.0.1:5173/?name=2";
// Node paths are slash-joined scene-node NAMES from the mirror root, matched by SUFFIX so the
// root container's own name never has to be hardcoded here.
const MS = "/MapScreen";
const MAP_BUTTON = "/TopBar/RightAlignedStuff/Map";

assertLease({
  owner: process.env.COUCHCOOP_LIVEQA_OWNER,
  pid: Number(process.env.COUCHCOOP_LIVEQA_PID),
  resources: ["shared:install", `exclusive:game:${process.env.COUCHCOOP_LIVEQA_GAME_RESOURCE ?? "default"}`]
});

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`  FAIL  ${msg}`);
};
const skip = (msg) => console.log(`  SKIP  ${msg}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

// Drop all outgoing action envelopes (recorded for assertions) BEFORE the app loads.
await page.addInitScript(() => {
  const dropped = [];
  window.__droppedActions = dropped;
  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (msg) {
    if (typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && parsed.type === "action") {
          dropped.push(msg);
          return;
        }
      } catch {
        // not JSON — pass through
      }
    }
    return origSend.call(this, msg);
  };
});

console.log(`connecting to ${BASE_URL} ...`);
await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
try {
  await page.waitForFunction(() => document.querySelectorAll(".mirror-node").length > 50, null, {
    timeout: 20000,
  });
} catch {
  console.error("scene never rendered — is the game running with a run in progress, and vite dev up?");
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(3000);

const isOpen = () =>
  page.evaluate((ms) => {
    const el = document.querySelector(`[data-node-path$="${ms}"]`);
    return el ? getComputedStyle(el).display !== "none" : false;
  }, MS);

// Dispatch a bubbling click ON the node element with coordinates that miss every action
// surface rect: rect-resolution finds nothing and the DOM-walk fallback resolves the
// dispatched node. Geometry-independent — headless texture 404s collapse some top-bar
// buttons to zero width, so real-coordinate clicks on them are unreliable here.
const synthClick = (path) =>
  page.evaluate((p) => {
    const el = document.querySelector(`[data-node-path$="${p}"]`);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 3, clientY: 540 }));
    return true;
  }, path);

// Interactivity attaches asynchronously after render — retry until the toggle lands.
const setMapOpen = async (wantOpen, via) => {
  for (let i = 0; i < 6; i++) {
    if ((await isOpen()) === wantOpen) return true;
    await synthClick(via);
    await page.waitForTimeout(1000);
  }
  return (await isOpen()) === wantOpen;
};

// The MapScreen subtree is a lazily-fetched child scene: on the first open after page
// load its children mount only once the scene (and texture) resolve, so poll instead
// of sampling instantly. Resolves with the background as soon as it contains the
// parchment, else with whatever the last sample was (null = element absent).
const theMapBg = async (timeoutMs = 8000) => {
  let last = null;
  const deadline = Date.now() + timeoutMs;
  do {
    last = await page.evaluate((ms) => {
      const el = document.querySelector(`[data-node-path$="${ms}/TheMap"]`);
      return el ? getComputedStyle(el).backgroundImage : null;
    }, MS);
    if (last?.includes("map_middle")) return last;
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  return last;
};

// ---- open #1
if (!(await setMapOpen(true, MAP_BUTTON))) {
  console.error("could not open the map via the top-bar button — aborting");
  await browser.close();
  process.exit(1);
}

// 1. background on first open
const bg1 = await theMapBg();
if (bg1?.includes("map_middle")) pass(`open#1 background present (${bg1.slice(4, 80)}...)`);
else fail(`open#1 background missing: ${bg1}`);

// 2. legend: (A) glyph hidden, labels non-empty
const legend = await page.evaluate((ms) => {
  const icon = document.querySelector(`[data-node-path$="${ms}/MapLegend/LegendHotkeyIcon"]`);
  const labels = [...document.querySelectorAll(`[data-node-path*="${ms}/MapLegend/LegendItems/"]`)]
    .filter((el) => el.getAttribute("data-node-path").endsWith("/MegaLabel"))
    .map((el) => el.textContent.trim());
  return { iconDisplay: icon ? getComputedStyle(icon).display : "absent", labels };
}, MS);
if (legend.iconDisplay === "absent" || legend.iconDisplay === "none") pass("legend (A) hotkey glyph hidden");
else fail(`legend (A) hotkey glyph visible (display: ${legend.iconDisplay})`);
if (legend.labels.length >= 6 && legend.labels.every((t) => t.length > 0)) {
  pass(`legend labels: ${legend.labels.join(", ")}`);
} else {
  console.warn(`  WARN  legend labels unexpected: ${JSON.stringify(legend.labels)}`);
}

// Dropped with the structured client: "no click-through" asserted a property of the CLIENT's
// own hit routing (an inline `pointer-events` per node, bound from the catalog). The mirror
// makes every node hit-targetable and arbitrates taps against the interactive-rect registry
// before putting a bare coordinate on the wire, so the equivalent gate lives in the touch
// harness (docs/agents/touch-live-harness.md, H-series) -- not here.
skip("click-through: not a client-side property on the mirror (see touch-live-harness.md)");

// ---- close, then open #2
if (!(await setMapOpen(false, `${MS}/Back`))) fail("could not close the map via Back");
else pass("map closed via Back");

if (!(await setMapOpen(true, MAP_BUTTON))) {
  fail("could not re-open the map");
} else {
  // 3. background survives re-open
  const bg2 = await theMapBg();
  if (bg2?.includes("map_middle")) pass("open#2 background still present after close/re-open");
  else fail(`open#2 background missing after re-open: ${bg2}`);
}

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
