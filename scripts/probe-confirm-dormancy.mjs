#!/usr/bin/env node
// P6-G — WHY A CONFIRM TAP IS REFUSED, SAMPLED OVER TIME (investigation only; no product change).
//
// THE REPORT. A shop slot sometimes does not take a confirm tap. The dormancy work (`?dormant`) is the suspect,
// because it is the thing that makes an off-screen subtree stop being reconciled — but "suspect" is not a
// diagnosis, and the two candidate diagnoses want opposite fixes:
//
//   STRUCTURAL — the exclusion chain refuses this node for the SAME reason on every sample, at every instant.
//                Then dormancy (or something it exposes) is genuinely mis-classifying the node, and the fix is in
//                the renderer.
//   TIMING     — early samples refuse and later ones pass. Then nothing is mis-classified; the node is simply not
//                ready yet when the tap arrives, and the fix (if any) is in the hit GRID or in what the harness
//                waits for. NOT in the renderer.
//
// A single sample cannot tell those apart, which is why this probe exists and why it samples rather than asserts.
//
// THE PRE-COMMITTED INTERPRETATION, written down BEFORE the numbers exist so the verdict cannot be chosen to suit
// them (round-6 design WS-P6 §P6-G, carried into round 7 verbatim):
//
//   * the SAME predicate refuses on every sample of an arm            => STRUCTURAL. Fix it only if the fix is one
//                                                                        line; otherwise FILE it with this output.
//   * early samples refuse and a later one passes                     => TIMING. File with the sample index at
//                                                                        which it flipped. The renderer is not the
//                                                                        problem and must not be edited for it.
//   * `?dormant=off` passes where `?dormant=on` refuses               => dormancy is implicated as such.
//   * both arms behave identically                                    => dormancy is EXONERATED; the report is
//                                                                        about something else, and that is a
//                                                                        result worth having.
//
// NO PRODUCT CHANGE COMES OUT OF THIS SCRIPT. It reads a seam that already exists on every page.
//
// THE SEAM. `window.__mirrorHitProbe(clientX, clientY, backdropWidthPx, gameX, gameY)` is installed
// UNCONDITIONALLY by MirrorView — it is not behind `paintDump`, so a replay page (or a live one) can be sampled
// without any instrumentation build. It answers `{ stack, painter, mapNode, confirm, cover }`; `confirm` is
// `confirmTapAt`'s own answer and `null` IS the refusal this probe is about.
//
// WHAT IT DOES NOT ANSWER, and the second stage that would. `confirm: null` says the chain refused; it does not
// say WHICH link refused. That needs `__mirrorConfirmWhy`, a dev seam that does not exist yet — and per the
// design it is only worth building if THIS probe says STRUCTURAL, because a timing answer would not use it.
//
// READ THIS BEFORE YOU RUN IT — THE TARGET AUTO-LOCATOR HAS NO ON-SCREEN FILTER.
// It takes `candidates[0]` of the requested node type at its box centre, and a parked node is a candidate. On
// `audit-shop-open` at the settle point the ENTIRE merchant inventory is parked ABOVE the viewport (cards at
// game y ~ -560 and -187, relics -365, potions -221, and the default NMerchantCardRemoval target at -251); the
// only on-screen merchant control is NMerchantButton at ~1341,633. Round 8 ran it as written and got
// "accepts 10/10 on both arms" for a slot that is not drawn — an agreement about nothing, which is the one
// failure mode a probe like this must not have. CHECK THE PRINTED `target: … at game X,Y` AGAINST 0..1920 /
// 0..1080 BEFORE believing the verdict, and use `--at` or `--node-type` when it is outside.
//
// Usage:
//   # a dev server serving the code under test must be running
//   node scripts/probe-confirm-dormancy.mjs --url http://127.0.0.1:5254
//   node scripts/probe-confirm-dormancy.mjs --url http://127.0.0.1:5254 --node-type NMerchantCardRemoval
//   node scripts/probe-confirm-dormancy.mjs --url http://127.0.0.1:5254 --at 960,540 --samples 20
//
// EVERY HEADED/GPU LAUNCH GOES THROUGH scripts/run-gpu.sh. This probe is headless and takes no screenshot, so it
// does not need one — but if you add `--gpu`, it does.

import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `probe-confirm-dormancy.mjs — P6-G: why a confirm tap is refused, sampled over time

  node scripts/probe-confirm-dormancy.mjs --url http://127.0.0.1:5254 [options]

  --url <origin>       dev server serving the code under test (REQUIRED)
  --recording <path>   NDJSON to replay (default .sts2/bench/audit-shop-open.ndjson)
  --node-type <leaf>   the node type whose slot is sampled (default NMerchantCardRemoval)
  --at <gx,gy>         sample this GAME coordinate instead of auto-locating a slot
  --samples <n>        samples per arm (default 10)
  --span <ms>          window the samples are spread over (default 2000)
  --arms <a,b>         dormant arms to run (default on,off)
  --viewport <WxH>     default 1920x1080
  --out <path>         NDJSON output (default .sts2/artifacts/r7-dormancy/confirm-dormancy.ndjson)
  --help`;

function parseArgs(argv) {
  const a = {
    url: "",
    recording: ".sts2/bench/audit-shop-open.ndjson",
    nodeType: "NMerchantCardRemoval",
    at: null,
    samples: 10,
    span: 2000,
    arms: ["on", "off"],
    viewport: { width: 1920, height: 1080 },
    out: ".sts2/artifacts/r7-dormancy/confirm-dormancy.ndjson"
  };
  for (let i = 0; i < argv.length; i++) {
    const val = () => argv[++i];
    switch (argv[i]) {
      case "--url": a.url = val(); break;
      case "--recording": a.recording = val(); break;
      case "--node-type": a.nodeType = val(); break;
      case "--at": {
        const [x, y] = String(val()).split(",").map(Number);
        a.at = { x, y };
        break;
      }
      case "--samples": a.samples = Number(val()); break;
      case "--span": a.span = Number(val()); break;
      case "--arms": a.arms = String(val()).split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--viewport": {
        const [w, h] = String(val()).split("x").map(Number);
        a.viewport = { width: w, height: h };
        break;
      }
      case "--out": a.out = val(); break;
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      default:
        if (argv[i].startsWith("--")) {
          console.error(`unknown flag ${argv[i]}\n\n${HELP}`);
          process.exit(2);
        }
    }
  }
  if (!a.url) {
    console.error(`--url is required\n\n${HELP}`);
    process.exit(2);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const recordingPath = resolve(REPO_ROOT, args.recording);
const recordingText = readFileSync(recordingPath, "utf8");
requireReproHeader(recordingText, recordingPath);

/**
 * The bench's own fake socket, lifted by name rather than re-implemented.
 *
 * The replay wire IS the bench's — a second copy would drift, and then a probe and a bench measuring "the same"
 * recording would not be measuring the same thing. `probe-canvas-parked-present.mjs` takes it the same way.
 */
function benchFakeSocketSource() {
  const source = readFileSync(resolve(REPO_ROOT, "scripts/bench-mirror-replay.mjs"), "utf8");
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.startsWith("function fakeWebSocketInit(config) {"));
  if (start < 0) {
    throw new Error("bench-mirror-replay.mjs: fakeWebSocketInit not found — the probe's replay wire is gone");
  }
  const end = lines.findIndex((l, idx) => idx > start && l === "}");
  if (end < 0) {
    throw new Error("bench-mirror-replay.mjs: fakeWebSocketInit has no top-level close");
  }
  return lines.slice(start, end + 1).join("\n");
}

/**
 * One arm: replay to settle, then sample the confirm chain `samples` times over `span` ms.
 *
 * Runs in the page because that is where the seam is; returns plain data so every judgement is made out here,
 * against the rule written at the top of this file rather than against whatever the numbers turn out to be.
 */
async function runArm(browser, dormant) {
  const context = await browser.newContext({ viewport: { ...args.viewport }, deviceScaleFactor: 1 });
  await context.route("**/__bench/recording", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: recordingText })
  );
  await context.addInitScript({
    content:
      `${benchFakeSocketSource()}\n;(${"fakeWebSocketInit"})(` +
      `${JSON.stringify({ recordingUrl: "/__bench/recording", pace: "max", ackPacedMs: 0, dropCardFlights: false, synthesizeDirectView: true, window: null })});`
  });

  const params = new URLSearchParams("quality=high&shaders=off&particles=off");
  params.set("dormant", dormant);
  const pageUrl = `${args.url.replace(/\/$/, "")}/?${params.toString()}`;

  const page = await context.newPage();
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  // The bench's own readiness gate: a rendered keyframe, not merely a loaded document.
  await page.waitForFunction(() => document.querySelectorAll("[data-node-id]").length > 400, null, { timeout: 60000 });
  await page.waitForTimeout(3500); // the same settle the touch harness waits out

  const result = await page.evaluate(
    async ({ nodeType, at, samples, span }) => {
      const probe = window.__mirrorHitProbe;
      if (typeof probe !== "function") {
        return { error: "__mirrorHitProbe is not installed — this page is not a mirror view" };
      }
      // WHERE TO TAP. Auto-located from the DOM rather than hardcoded, so the probe survives a layout change:
      // the deepest element whose node type ends in the requested leaf, at its box centre. `--at` overrides it
      // for a slot this cannot find.
      const stage = document.querySelector("[data-mirror-stage], .mirror-stage") ?? document.body;
      const rect = stage.getBoundingClientRect();
      const toGame = (cx, cy) => ({
        x: ((cx - rect.left) / Math.max(1, rect.width)) * 1920,
        y: ((cy - rect.top) / Math.max(1, rect.height)) * 1080
      });
      let target = null;
      if (at) {
        const cx = rect.left + (at.x / 1920) * rect.width;
        const cy = rect.top + (at.y / 1080) * rect.height;
        target = { nodeId: "(--at)", clientX: cx, clientY: cy, gameX: at.x, gameY: at.y };
      } else {
        const candidates = [...document.querySelectorAll("[data-node-id]")].filter((el) => {
          const type = el.getAttribute("data-node-type") ?? "";
          return type === nodeType || type.endsWith(`.${nodeType}`);
        });
        const el = candidates[0];
        if (el) {
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const g = toGame(cx, cy);
          target = { nodeId: el.getAttribute("data-node-id"), clientX: cx, clientY: cy, gameX: g.x, gameY: g.y };
        }
      }
      if (!target) {
        return { error: `no element of node type "${nodeType}" on this screen`, candidates: 0 };
      }

      const rows = [];
      const t0 = performance.now();
      const step = samples > 1 ? span / (samples - 1) : 0;
      for (let i = 0; i < samples; i++) {
        const answer = probe(target.clientX, target.clientY, rect.width, target.gameX, target.gameY);
        // The renderer's own gauge, read the way the bench reads it: `__mirrorWalkStats` is a LIVE object the
        // renderer mutates in place, so it is sampled per row rather than captured once. Read defensively — a
        // build without the counter must produce a null column, never a crash.
        const dormancy = window.__mirrorWalkStats?.dormantRoots ?? null;
        rows.push({
          sampleIndex: i,
          tMs: Math.round(performance.now() - t0),
          // `null` IS the refusal — the whole subject of this probe.
          confirmId: answer?.confirm?.id ?? null,
          confirmKind: answer?.confirm?.kind ?? null,
          coverAbove: answer?.cover ?? null,
          stackTop: answer?.stack?.[answer.stack.length - 1]?.nodeId ?? null,
          dormantRoots: dormancy
        });
        if (step > 0 && i < samples - 1) {
          await new Promise((r) => setTimeout(r, step));
        }
      }
      return { target, rows };
    },
    { nodeType: args.nodeType, at: args.at, samples: args.samples, span: args.span }
  );

  await context.close();
  return result;
}

// ---------------------------------------------------------------------------------------------------------

const browser = await chromium.launch({ headless: true });
const arms = {};
for (const dormant of args.arms) {
  arms[dormant] = await runArm(browser, dormant);
}
await browser.close();

const outPath = resolve(REPO_ROOT, args.out);
mkdirSync(dirname(outPath), { recursive: true });
const lines = [];
for (const [arm, result] of Object.entries(arms)) {
  if (result.error) {
    lines.push(JSON.stringify({ arm, error: result.error }));
    continue;
  }
  lines.push(JSON.stringify({ arm, target: result.target }));
  for (const row of result.rows) {
    lines.push(JSON.stringify({ arm, ...row }));
  }
}
writeFileSync(outPath, `${lines.join("\n")}\n`);

console.log("probe-confirm-dormancy");
console.log(`  url:       ${args.url}`);
console.log(`  recording: ${recordingPath}`);
console.log(`  samples:   ${args.samples} over ${args.span}ms per arm`);
console.log(`  out:       ${outPath}`);
console.log("");

/** Apply the rule from the top of this file. Every branch is pre-committed; none is chosen after the fact. */
function verdictFor(result) {
  if (result.error) {
    return `NO READING — ${result.error}`;
  }
  const passes = result.rows.filter((r) => r.confirmId !== null);
  if (passes.length === result.rows.length) {
    return "PASSES on every sample — this arm reproduces nothing";
  }
  if (passes.length === 0) {
    return "REFUSES on every sample => STRUCTURAL (fix iff one line, else file this output)";
  }
  const firstPass = result.rows.find((r) => r.confirmId !== null);
  return (
    `refuses early, passes from sample ${firstPass.sampleIndex} (t=${firstPass.tMs}ms) => TIMING ` +
    "(the grid, not the renderer — file with this index)"
  );
}

for (const [arm, result] of Object.entries(arms)) {
  console.log(`  ?dormant=${arm}`);
  if (!result.error) {
    console.log(`    target:  ${result.target.nodeId} at game ${Math.round(result.target.gameX)},${Math.round(result.target.gameY)}`);
    console.log(`    confirm: ${result.rows.map((r) => (r.confirmId ? "." : "x")).join("")}   (. = accepted, x = refused)`);
    const roots = result.rows.map((r) => r.dormantRoots).filter((v) => v != null);
    if (roots.length > 0) {
      console.log(`    dormantRoots: ${Math.min(...roots)}..${Math.max(...roots)}`);
    }
  }
  console.log(`    verdict: ${verdictFor(result)}`);
}

// AND THE CROSS-ARM READING, which is the one the report is actually about.
const on = arms.on;
const off = arms.off;
if (on && off && !on.error && !off.error) {
  const onPass = on.rows.filter((r) => r.confirmId !== null).length;
  const offPass = off.rows.filter((r) => r.confirmId !== null).length;
  console.log("");
  if (onPass === offPass) {
    console.log(`  DORMANCY EXONERATED: both arms accept ${onPass}/${on.rows.length}. Whatever the report is` +
      " about, it is not the dormancy lever — and that is a result, not a null one.");
  } else {
    console.log(`  DORMANCY IMPLICATED: on accepts ${onPass}/${on.rows.length}, off accepts ${offPass}/${off.rows.length}.`);
  }
}
