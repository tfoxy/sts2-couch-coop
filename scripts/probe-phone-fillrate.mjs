#!/usr/bin/env node
// probe-phone-fillrate.mjs — drive scripts/fill-probe.html on the PHONE's own Chrome and report where the
// device's fill / batching ceiling sits, in the same rAF-gap currency bench-mirror-replay.mjs uses.
//
// THE QUESTION. `?stage=canvas` trades ~2,400 composited DOM elements for one WebGL2 canvas painted as ~41
// draws / ~150 quads (docs/mirror-combat-bench.md, M1 census). A replay bench can say the app got faster or
// slower; it cannot say WHY, because the app's frame budget also contains the producer walk, the reconciler,
// the DOM overlay and the compositor. This probe removes all of that and asks the GPU two questions directly:
//
//   1. QUAD COUNT / STATE CHANGE — at the M1 quad count, does the number of draws matter on this device?
//      Three modes over the same pixels: one draw one texture (`batch1`), one draw sixteen texture slots
//      (`slot16`, what the executor actually emits), one draw per quad (`naive`).
//   2. FILL — a straight overdraw ladder of full-screen blended quads, so the ceiling can be quoted in
//      Mpx/frame instead of guessed from quad counts.
//
// SAFETY. This script drives ONE tab that it owns. It never opens the mirror's "/" direct view (that pushes
// settings to the live host on connect), it never sends input anywhere near a live game, and it refuses to run
// on a locked screen — a locked phone still answers adb and still serves CDP, so without the check the run
// would faithfully measure a display that was never composited.
//
// Usage:
//   node scripts/probe-phone-fillrate.mjs --out .sts2/research/fill-probe.json
//   ADB_SERIAL=XXXX node scripts/probe-phone-fillrate.mjs --port 5184 --seconds 8
//
// The phone reaches this process's HTTP server at 127.0.0.1:<port> through `adb reverse`; nothing binds a
// network interface and the reverse/forward are torn down on every exit path.

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { assertLease } from "./live-qa-lock.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("playwright");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const a = {
    serial: process.env.ADB_SERIAL || "ZY32LL2X8W",
    port: 5184,
    cdpPort: 9222,
    seconds: 8,
    warmupMs: 1500,
    out: null,
    quads: [25, 50, 100, 200, 400],
    modes: ["batch1", "slot16", "naive"],
    layers: [1, 2, 4, 8, 16],
    coverage: 0.027,
    alpha: 0.85,
    skipOverdraw: false,
    keepTab: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const val = () => argv[++i];
    const nums = () => String(val()).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    switch (arg) {
      case "--serial": a.serial = String(val()); break;
      case "--port": a.port = Number(val()); break;
      case "--cdp-port": a.cdpPort = Number(val()); break;
      case "--seconds": a.seconds = Number(val()); break;
      case "--warmup-ms": a.warmupMs = Number(val()); break;
      case "--out": a.out = resolve(val()); break;
      case "--quads": a.quads = nums(); break;
      case "--modes": a.modes = String(val()).split(",").map((s) => s.trim()); break;
      case "--layers": a.layers = nums(); break;
      case "--coverage": a.coverage = Number(val()); break;
      case "--alpha": a.alpha = Number(val()); break;
      case "--skip-overdraw": a.skipOverdraw = true; break;
      case "--keep-tab": a.keepTab = true; break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`Unknown argument: ${arg}`); a.help = true;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`probe-phone-fillrate.mjs — WebGL2 fill/batching ceiling on the phone, over adb + CDP

  --serial <s>       adb serial (default env ADB_SERIAL or ZY32LL2X8W)
  --port <n>         host port this process serves fill-probe.html on, reversed to the phone (default 5184)
  --cdp-port <n>     host port forwarded to the phone's DevTools socket (default 9222)
  --seconds <n>      MEASURED seconds per cell (default 8; warmup is extra)
  --warmup-ms <n>    discarded warmup per cell (default 1500)
  --quads <a,b,…>    quad counts for the mode sweep (default 25,50,100,200,400)
  --modes <a,b,…>    batch1 | slot16 | naive (default all three)
  --layers <a,b,…>   full-screen overdraw ladder (default 1,2,4,8,16)
  --coverage <f>     mode-sweep quad area as a fraction of the viewport (default 0.027 — card-sized)
  --alpha <f>        per-quad alpha, premultiplied (default 0.85)
  --skip-overdraw    mode sweep only
  --keep-tab         leave the bench tab open (default: close it and hand the foreground back)
  --out <file>       write the full result JSON (raw gap arrays included)

Prints a human table and a machine-readable FILL_PROBE_RESULT {json} line.`);
  process.exit(0);
}

assertLease({
  owner: process.env.COUCHCOOP_LIVEQA_OWNER,
  pid: Number(process.env.COUCHCOOP_LIVEQA_PID),
  resources: ["shared:install", `exclusive:android:${args.serial}`, `exclusive:browser:${args.cdpPort}`]
});

const adb = (...a) => execFileSync("adb", ["-s", args.serial, ...a], { encoding: "utf8" });

// ---------------------------------------------------------------------------------------------------------
// LOCKSCREEN FIRST — before any forward is installed, so a refusal leaves the device exactly as it was.
// ---------------------------------------------------------------------------------------------------------
let lockState = "";
try {
  lockState = (adb("shell", "dumpsys", "window").match(/mDreamingLockscreen=[a-z]+/) || [""])[0];
} catch (e) {
  console.error(`fill-probe: cannot reach '${args.serial}' over adb: ${e.message}`);
  process.exit(2);
}
if (lockState !== "mDreamingLockscreen=false") {
  console.error(`fill-probe: the phone is LOCKED (${lockState || "unreadable"}).`);
  console.error("            Unlock it, keep the screen on (adb shell svc power stayon true), then re-run.");
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------
// adb plumbing, torn down on every exit path
// ---------------------------------------------------------------------------------------------------------
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  // Best-effort, always both: a stale reverse points the phone's next request at whatever binds that host
  // port next, and a stale forward silently captures the next session's CDP.
  try { adb("forward", "--remove", `tcp:${args.cdpPort}`); } catch { /* ignore */ }
  try { adb("reverse", "--remove", `tcp:${args.port}`); } catch { /* ignore */ }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

adb("forward", `tcp:${args.cdpPort}`, "localabstract:chrome_devtools_remote");
adb("reverse", `tcp:${args.port}`, `tcp:${args.port}`);

// ---------------------------------------------------------------------------------------------------------
// the probe server (loopback only)
// ---------------------------------------------------------------------------------------------------------
const PROBE_HTML = readFileSync(resolve(SCRIPT_DIR, "fill-probe.html"), "utf8");
const server = createServer((req, res) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(PROBE_HTML);
});
await new Promise((r) => server.listen(args.port, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${args.port}/`;

// ---------------------------------------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------------------------------------
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
/** The panel's period is DETECTED, never assumed — this phone is 90Hz, the desktop leg is 60. */
function snapVsync(ms) {
  const candidates = [8.33, 11.11, 16.67, 33.33];
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(c - ms) < Math.abs(best - ms)) best = c;
  return best;
}
function summarize(gaps) {
  const s = [...gaps].sort((a, b) => a - b);
  const vsync = s.length ? snapVsync(pct(s, 20)) : null;
  return {
    frames: gaps.length,
    p50: pct(s, 50),
    p95: pct(s, 95),
    max: s.length ? s[s.length - 1] : null,
    vsyncMs: vsync,
    fpsFromP50: s.length ? 1000 / pct(s, 50) : null
  };
}
const f2 = (n) => (n === null || n === undefined ? "—" : n.toFixed(2));

// ---------------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------------
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${args.cdpPort}`);
const context = browser.contexts()[0];
if (!context) {
  console.error("fill-probe: the attached browser has no context.");
  process.exit(2);
}

// -------------------------------------------------------------------------------------------------------
// WHICH TAB. Two Android-only facts shape this, both of them measured here rather than assumed:
//
//   1. `context.newPage()` DOES create a tab over Android CDP, but the tab it creates is a BACKGROUND tab and
//      `bringToFront()` did not reliably foreground it — the run then sat forever on a page that was never
//      composited.
//   2. Playwright's `waitForFunction` polls on requestAnimationFrame BY DEFAULT, and Android throttles a
//      background tab to NO animation frames at all. So on a background tab the wait does not time out and
//      fail — it hangs, silently, forever. Every wait below therefore polls on a TIMER, never on rAF.
//
// So: adopt a tab (one already on the probe origin, or an about:blank, or an explicit --adopt match), never
// open one, and then PROVE the adopted tab is actually being scheduled before believing a single number.
const before = context.pages().map((p) => p.url());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Count real animation frames over ~1s — the only reliable "is this tab foreground" test on Android. */
async function rafRate(p) {
  return Promise.race([
    p.evaluate(() => new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else resolve(n); };
      requestAnimationFrame(tick);
      setTimeout(() => resolve(n), 2500);
    })),
    new Promise((r) => setTimeout(() => r(-1), 6000))
  ]).catch(() => -1);
}

// Close any STALE tab of ours on this origin, then ask ANDROID for a fresh foreground one. `bringToFront()`
// cannot do this (measured: returns in 4ms, reports success, tab stays backgrounded at 0 rAF), and two tabs
// on the same URL would make "find the bench tab" pick the dead one.
for (const p of context.pages()) {
  if (p.url().startsWith(ORIGIN)) await p.close().catch(() => {});
}
adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", ORIGIN,
    "-n", "com.android.chrome/com.google.android.apps.chrome.Main", "--ez", "create_new_tab", "true");
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500);
  page = context.pages().find((p) => p.url().startsWith(ORIGIN)) || null;
}
if (!page) {
  console.error(`fill-probe: no tab appeared on ${ORIGIN} after 20s. Is Chrome in the foreground with the screen on?`);
  await browser.close();
  process.exit(2);
}
const adoptedFrom = page.url();

// LOAD, and REFUSE a dead context. A lost WebGL context does not throw: every gl call becomes a no-op and the
// rAF loop keeps ticking at a perfect vsync, so a probe that does not check this reports a beautiful sweep of
// a canvas that drew nothing. (Measured: headless Chromium's SwiftShader loses the FIRST page's context
// ~150ms in, every time, and warm pages never do — so a retry is the right shape, not a hard failure.)
let lostAtLoad = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  await page.goto(attempt === 1 ? ORIGIN : `${ORIGIN}?attempt=${attempt}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(
    () => window.__fillProbeReady === true || window.__fillProbeError,
    null,
    { timeout: 30000, polling: 250 } // TIMER polling: see the note above
  );
  const err = await page.evaluate(() => window.__fillProbeError || null);
  if (err) {
    console.error(`fill-probe: the page could not start WebGL2: ${err}`);
    await browser.close();
    process.exit(1);
  }
  await page.waitForTimeout(1200);
  lostAtLoad = await page.evaluate(() => (window.__fillProbeLost ? window.__fillProbeLost.at : null));
  if (lostAtLoad === null) break;
  console.error(`fill-probe: WebGL context LOST ${Math.round(lostAtLoad)}ms after load (attempt ${attempt}/3) — reloading`);
  if (attempt === 3) {
    console.error("fill-probe: the context keeps dying; the numbers would describe a canvas that drew nothing.");
    await browser.close();
    process.exit(1);
  }
}

// rAF LIVENESS GATE. The one thing that makes every later number meaningless is a tab Android is not
// scheduling, and that failure is INVISIBLE in the results (a throttled tab reports very few, very regular
// gaps). Count real animation frames over a second and refuse anything that looks throttled.
const rafFps = await rafRate(page);
if (rafFps < 20) {
  console.error(`fill-probe: the adopted tab got ${rafFps} animation frames in a second — it is BACKGROUNDED or`);
  console.error("            throttled. Foreground the probe tab on the phone (it is the one showing 'fill-probe')");
  console.error("            and re-run; a background tab measures a page that was never composited.");
  await browser.close();
  process.exit(2);
}

const env = await page.evaluate(() => window.__fillProbe.envInfo());
console.log("");
console.log(`fill-probe on ${args.serial}`);
console.log(`  renderer   ${env.renderer}  (${env.vendor})`);
console.log(`  gl         ${env.glVersion}   texture units ${env.maxTextureImageUnits}`);
console.log(`  viewport   ${env.cssW}x${env.cssH} css @ dpr ${env.dpr}  =>  ${env.drawW}x${env.drawH} ` +
  `(${(env.pixels / 1e6).toFixed(2)} Mpx per full-screen layer)`);
console.log(`  tabs       ${before.length} open; adopted '${adoptedFrom.slice(0, 60)}'  (rAF ${rafFps}/s — scheduled)`);
console.log("");

const cells = [];
for (const mode of args.modes) {
  for (const n of args.quads) {
    cells.push({ kind: "quads", mode, n, coverage: args.coverage, alpha: args.alpha, label: `${mode}/n${n}` });
  }
}
if (!args.skipOverdraw) {
  for (const l of args.layers) {
    cells.push({ kind: "overdraw", mode: "batch1", n: l, coverage: 1.0, alpha: args.alpha, label: `overdraw/x${l}` });
  }
}

const results = [];
let cellIndex = 0;
for (const cell of cells) {
  cellIndex++;
  process.stderr.write(`[${cellIndex}/${cells.length}] ${cell.label} … `);
  // The cell resolves off the page's own rAF loop. If the tab is backgrounded mid-sweep (a notification, a
  // tab switch) that loop stops and this await never returns, so it is raced against a wall-clock budget —
  // a run that dies has to SAY so, not hang until someone notices.
  const budgetMs = (args.seconds * 1000 + args.warmupMs) * 3 + 20000;
  const raw = await Promise.race([
    page.evaluate(
      (cfg) => window.__fillProbe.runCell(cfg),
      { n: cell.n, mode: cell.mode, coverage: cell.coverage, alpha: cell.alpha, ms: args.seconds * 1000, warmupMs: args.warmupMs, label: cell.label }
    ),
    new Promise((_r, rej) => setTimeout(() => rej(new Error(
      `cell '${cell.label}' did not finish in ${Math.round(budgetMs / 1000)}s — the tab stopped being scheduled ` +
      "(backgrounded / screen off). Re-run with the probe tab in the foreground."
    )), budgetMs))
  ]).catch((e) => { console.error("\nfill-probe: " + e.message); process.exit(3); });
  const stats = summarize(raw.gaps);
  // A context that died MID-SWEEP turns every later cell into a free no-op that still books vsync-perfect
  // frames. Mark it on the cell rather than letting it read as a result.
  const lostNow = await page.evaluate(() => (window.__fillProbeLost ? window.__fillProbeLost.at : null));
  if (lostNow !== null) {
    console.error(`fill-probe: CONTEXT LOST during '${cell.label}' — this cell and every later one are void.`);
  }
  const quadPx = cell.coverage * env.drawW * env.drawH;
  const rec = {
    ...cell,
    contextLost: lostNow,
    drawsPerFrame: raw.drawsPerFrame,
    quadPx,
    fillMpxPerFrame: (quadPx * cell.n) / 1e6,
    frames: stats.frames,
    p50: stats.p50,
    p95: stats.p95,
    max: stats.max,
    vsyncMs: stats.vsyncMs,
    fps: stats.fpsFromP50,
    gaps: raw.gaps
  };
  results.push(rec);
  process.stderr.write(`p50 ${f2(stats.p50)}ms  p95 ${f2(stats.p95)}ms  (${stats.frames} frames)\n`);
}

// ---------------------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------------------
const quadCells = results.filter((r) => r.kind === "quads");
const overCells = results.filter((r) => r.kind === "overdraw");

if (quadCells.length) {
  console.log("");
  console.log(`QUAD / STATE-CHANGE SWEEP — ${(args.coverage * 100).toFixed(1)}% viewport per quad ` +
    `(${((args.coverage * env.drawW * env.drawH) / 1e6).toFixed(3)} Mpx), alpha ${args.alpha}, blended`);
  console.log("");
  console.log("  mode     |    N | draws |  Mpx/frame |   p50 ms |   p95 ms |   max ms | fps(p50)");
  console.log("  ---------+------+-------+------------+----------+----------+----------+---------");
  for (const r of quadCells) {
    console.log(
      `  ${r.mode.padEnd(8)} | ${String(r.n).padStart(4)} | ${String(r.drawsPerFrame).padStart(5)} | ` +
      `${r.fillMpxPerFrame.toFixed(2).padStart(10)} | ${f2(r.p50).padStart(8)} | ${f2(r.p95).padStart(8)} | ` +
      `${f2(r.max).padStart(8)} | ${f2(r.fps).padStart(7)}`
    );
  }
}

if (overCells.length) {
  console.log("");
  console.log("OVERDRAW LADDER — full-screen blended quads, one draw call");
  console.log("");
  console.log("  layers |  Mpx/frame |   p50 ms |   p95 ms |   max ms | fps(p50) |  Gpx/s @p50");
  console.log("  -------+------------+----------+----------+----------+----------+------------");
  for (const r of overCells) {
    const gpxs = r.p50 ? (r.fillMpxPerFrame / 1e3) / (r.p50 / 1000) : null;
    console.log(
      `  ${String(r.n).padStart(6)} | ${r.fillMpxPerFrame.toFixed(2).padStart(10)} | ${f2(r.p50).padStart(8)} | ` +
      `${f2(r.p95).padStart(8)} | ${f2(r.max).padStart(8)} | ${f2(r.fps).padStart(8)} | ${f2(gpxs).padStart(11)}`
    );
  }
}
console.log("");

const payload = {
  schema: "fill-probe/1",
  when: new Date().toISOString(),
  serial: args.serial,
  env,
  params: { seconds: args.seconds, warmupMs: args.warmupMs, coverage: args.coverage, alpha: args.alpha },
  cells: results
};
if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(payload, null, 2));
  console.log(`raw gaps + summary -> ${args.out}`);
}
console.log("FILL_PROBE_RESULT " + JSON.stringify({
  env: { renderer: env.renderer, dpr: env.dpr, css: `${env.cssW}x${env.cssH}`, draw: `${env.drawW}x${env.drawH}` },
  cells: results.map(({ gaps, ...rest }) => rest)
}));

// Hand the device back: park the adopted tab on about:blank unless asked to keep it live, so the phone is not
// left running a GPU benchmark. Closing it and re-foregrounding the operator's tab is a separate, deliberate
// step (the probe must not guess which of 20 tabs a person was reading).
if (!args.keepTab) {
  await page.goto("about:blank", { waitUntil: "load" }).catch(() => {});
}
await browser.close();
server.close();
cleanup();
process.exit(0);
