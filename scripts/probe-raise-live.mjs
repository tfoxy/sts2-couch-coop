#!/usr/bin/env node
// U3b — THE RAISE PROBE, ON A LIVE RAISED FRAME. Two arms, one shape, no game input.
//
// WHY THIS CANNOT BE A REPLAY. With readable-hand mode on, a raised creature's health bar and powers sit a little
// higher on the canvas stage than on the DOM one. Round 6 ranked two mechanisms for that and then measured that
// NEITHER reproduces on `combat-modern`: the creature chains there are identity (so mechanism 1's `parentScaleY`
// is 1 and predicts no difference at all), and the reticle/power groups ARE streamed (so the DOM fallback that
// mechanism 2 turns on never fires). Both arms compute the same −343/−95 for Ironclad and −311/−62 for
// SludgeSpinner. A recording therefore cannot decide this, and the design's conclusion was that a LIVE raised
// frame is the round's one irreplaceable evidence item.
//
// THE PRE-COMMITTED DECISION RULE (round-6 design WS-M §M6+M7, verbatim — written before the numbers exist so the
// verdict cannot be fitted to them):
//
//   values AGREE and `drawnY` differs by about `parentScaleY`
//        => MECHANISM (1). `planHandRaise` multiplies a creature-local dy by a new env `parentScaleY(rootId)`.
//           Identity chains make that byte-identical, which round 6 already proved on the recording.
//   values DIFFER (e.g. −244 against −343)
//        => MECHANISM (2). Adopt the DOM's EFFECTIVE answer under the same fallback trigger. PARITY WINS: the DOM
//           arm is what the player sees and the user filed the canvas arm as the wrong one. The
//           both-should-measure-it-properly improvement is filed DOM-side for a later round.
//   NEITHER
//        => the probe NAMES THE TERM that differs, and nothing ships. This is a valid outcome.
//
// R9 — THE MECHANISM WAS FOUND OFFLINE, AND THIS SCRIPT IS NOW ITS LIVE GATE. `raiseParity.spec.ts` renders one
// scene through BOTH backends and shows mechanism (1) exactly: on a creature whose chain SCALES by k, the DOM's
// CSS `translate` (parent space, riding the chain) moves the HUD group by `k·dy` while the canvas's design-space
// add moved it by `dy` — a divergence of `dy·(k−1)`, in the direction the user filed. The canvas now maps a
// cosmetic offset through its owner's parent transform, which is byte-identical on the identity chains every
// recording has and correct on the chains they do not.
//
// So the branches below are re-pointed: they no longer SELECT a mechanism to ship, they say whether the shipped
// one holds on a live frame. What the run is looking for, in order of value:
//   * a NON-IDENTITY creature chain with the drawn heights AGREEING — the fix, proven live;
//   * a non-identity chain with the drawn heights DIFFERING — the bundle is stale or the fix is incomplete;
//     `mech1PredictedDelta` per row separates those two;
//   * identity chains everywhere — this frame cannot exercise it either, and the run says so rather than
//     claiming a pass. RUN IT AT THE REPORTED VIEWPORT (`--viewport`), not only at 1920x1080: rounds 6-8 all
//     measured at 1920 and all came back identity.
//
// R8 — THE DRAWN-HEIGHT SEAM IS NOW CLOSED, and the rule above gains the branch it was missing. Round 7's live run
// took the NEITHER arm and named its own blocker: the DOM arm published `bakedY` (its element's `matrix()`
// translate, PARENT space) against the canvas arm's design-space `drawnY`, so the ONE comparison that could still
// separate the mechanisms was not available and the probe reported NOT COMPARABLE rather than a number. The DOM
// renderer now publishes `creatureGroupRows` — the design-space global m[5] plus the same `raiseDy` the raise pass
// wrote, over the same `creatureHudIds` population — which is the exact twin of the canvas term, joined by id. The
// two extra pre-committed outcomes, added here and nowhere else:
//
//   dy agrees, chains identity, drawn heights AGREE within 1px on every shared group
//        => U3b UNREPRODUCED with the drawn-height seam CLOSED. A valid outcome: the next attempt needs a frame
//           with a NON-IDENTITY creature chain, not a better measurement.
//   dy agrees, chains identity, drawn heights DIFFER
//        => THE TERM IS NAMED. `drawnY = streamedY + dy` on both arms and the `dy`s agree, so the differing
//           component is `streamedY` — WALK PLACEMENT, not the raise. Printed per row; nothing ships this run;
//           filed for M7 mechanism selection next round.
//
// Tolerance is 1.0px because the DOM's dy is `Math.round`ed at the write site and the deltas in question are of
// order 67-89px.
//
// SAFETY — the envelope is the whole reason this script is allowed to exist, and none of it is optional:
//   * It NEVER scripts input into a live game. It loads a fixture at the menu and OPENS PAGES. `?raiseHand=on` is
//     purely client-side (`mirrorSettings`): the game is never told, so the raise happens entirely in the browser.
//   * It talks only to its OWN instance (`touchqa`) on its OWN port (13457). The developer's game is on :13337 and
//     is never addressed — not for input, not for a fixture, not for `game close`.
//   * It atomically leases its touchqa instance, ports, and shared install before doing anything, and releases the
//     set on EVERY exit path including the error ones.
//   * It shuts down only what it started.
//
// Bring the instance and the dev server up with the audited lifecycle rather than re-implementing it:
//
//   node scripts/validate-touch-live.mjs --keep            # launches instance `touchqa` + vite 5199, loads a fixture
//   ./scripts/run-gpu.sh node scripts/probe-raise-live.mjs # this script, THROUGH the xvfb wrapper
//   sts2 --instance touchqa game close                     # when finished
//
// THROUGH run-gpu.sh, ALWAYS. A bare Playwright launch here would let Ozone route a real window onto the
// developer's desktop; the wrapper unsets WAYLAND_DISPLAY and gives it an Xvfb display. (Xvfb has no vsync, so no
// pacing claim may ever be made from this script — it measures GEOMETRY, which is vsync-independent.)

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
import { acquireLease, releaseLease } from "./live-qa-lock.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The developer's own instance. Named ONLY so the guard below can refuse to talk to it. */
const FORBIDDEN_PORT = 13337;

const HELP = `probe-raise-live.mjs — U3b: the raise probe on a LIVE raised frame (no game input)

  ./scripts/run-gpu.sh node scripts/probe-raise-live.mjs [options]

  --vite <port>     dev server validate-touch-live.mjs brought up (default 5199)
  --game <port>     the harness instance's browser server (default 13457; 13337 is REFUSED)
  --out <dir>       artifacts (default .sts2/artifacts/r8-raise-live; r7's run is never overwritten)
  --viewport <WxH>  browser viewport (default 1920x1080). THE VARIABLE ROUNDS 6-8 NEVER MOVED: both of those
                    runs measured at 1920x1080 and found the arms identical, and U3b was reported from an
                    ULTRAWIDE PHONE IN LANDSCAPE, where the spread and view-scale passes are live and a
                    creature chain need not be the identity. Run the reported geometry AND the 1920 control.
  --settle <ms>     post-readiness settle (default 3500 — the touch harness's own)
  --timeout <ms>    readiness timeout per arm (default 90000)
  --help`;

function parseArgs(argv) {
  const a = {
    vite: 5199,
    game: 13457,
    out: ".sts2/artifacts/r8-raise-live",
    settle: 3500,
    timeout: 90000,
    viewport: { width: 1920, height: 1080 }
  };
  for (let i = 0; i < argv.length; i++) {
    const val = () => argv[++i];
    switch (argv[i]) {
      case "--vite": a.vite = Number(val()); break;
      case "--game": a.game = Number(val()); break;
      case "--out": a.out = val(); break;
      case "--settle": a.settle = Number(val()); break;
      case "--timeout": a.timeout = Number(val()); break;
      case "--viewport": {
        const raw = String(val());
        const m = /^(\d+)x(\d+)$/.exec(raw.trim());
        if (!m) {
          console.error(`--viewport wants WxH (e.g. 2340x1080), got "${raw}"`);
          process.exit(2);
        }
        a.viewport = { width: Number(m[1]), height: Number(m[2]) };
        break;
      }
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
  return a;
}

const args = parseArgs(process.argv.slice(2));

// ---- the safety envelope, enforced rather than documented ------------------------------------------------

if (args.game === FORBIDDEN_PORT || args.vite === FORBIDDEN_PORT) {
  console.error(
    `REFUSED: :${FORBIDDEN_PORT} is the developer's own game. This probe talks only to its own instance.`
  );
  process.exit(2);
}

let lockHeld = false;
function acquireLock() {
  acquireLease({
    owner: "W3W4-raise-live", pid: process.pid,
    resources: ["shared:install", "shared:game:touchqa", `exclusive:port:${args.game}`, `exclusive:port:${args.vite}`]
  });
  lockHeld = true;
}
function releaseLock() {
  if (lockHeld) {
    try { releaseLease({ owner: "W3W4-raise-live", pid: process.pid }); } catch {}
    lockHeld = false;
  }
}
// EVERY exit path, including the ones nobody plans for. A stuck lock blocks every other agent on the box.
process.on("exit", releaseLock);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    releaseLock();
    process.exit(130);
  });
}
process.on("uncaughtException", (err) => {
  releaseLock();
  console.error(err);
  process.exit(1);
});

// ---- the in-page probe, portable and verbatim ------------------------------------------------------------

/**
 * `bench-mirror-replay.mjs`'s `raiseProbeInPage`, lifted BY NAME at run time.
 *
 * Copied rather than imported because it has to be serialised into the page — but lifted from the bench's source
 * instead of duplicated into this file, so the two arms of a comparison can never come from two different
 * measurements of "the same" thing. The body is backend-agnostic by construction: the canvas arm answers through
 * `window.__mirrorRaiseProbe()` and the DOM arm is read off attributes its renderer already stamps, so neither
 * backend needed a line of new code for this.
 *
 * `bench --raise-probe` itself is recording-ONLY (it exits without one, and `--connect-cdp` navigates away), which
 * is why this script exists at all rather than a flag on the bench.
 */
function raiseProbeSource() {
  const source = readFileSync(resolve(REPO_ROOT, "scripts/bench-mirror-replay.mjs"), "utf8");
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.startsWith("function raiseProbeInPage() {"));
  if (start < 0) {
    throw new Error("bench-mirror-replay.mjs: raiseProbeInPage not found — the shared probe body has moved");
  }
  const end = lines.findIndex((l, idx) => idx > start && l === "}");
  if (end < 0) {
    throw new Error("bench-mirror-replay.mjs: raiseProbeInPage has no top-level close");
  }
  return lines.slice(start, end + 1).join("\n");
}

const PROBE_SOURCE = raiseProbeSource();

// ---- run --------------------------------------------------------------------------------------------------

async function portOpen(port) {
  const net = await import("node:net");
  return new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      done(true);
    });
    socket.on("error", () => done(false));
    socket.setTimeout(1500, () => {
      socket.destroy();
      done(false);
    });
  });
}

/** One arm. Sequential by design: two live pages against one headless instance is a second variable. */
async function runArm(browser, name, extraQuery) {
  const params = new URLSearchParams("raiseHand=on&paintDump=1");
  for (const [k, v] of new URLSearchParams(extraQuery)) {
    params.set(k, v);
  }
  const url = `http://127.0.0.1:${args.vite}/?${params.toString()}`;
  const context = await browser.newContext({ viewport: args.viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const warnings = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning" || msg.type() === "error") {
      warnings.push(`${msg.type()}: ${msg.text()}`.slice(0, 300));
    }
  });
  console.log(`  [${name}] ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // READINESS HAS TO ASK EACH BACKEND ITS OWN QUESTION — the bench's rule, and this probe learned it the hard
  // way. `[data-node-id] > 400` is the touch harness's gate and the touch harness is DOM-only: the canvas stage
  // paints its nodes into a canvas and gives DOM elements only to overlay records (~53 of them), so that count
  // can never be reached there and the canvas arm times out on a scene that rendered perfectly.
  await page.waitForFunction(
    () => {
      if (document.querySelectorAll("[data-node-id]").length > 400) {
        return true;
      }
      const readCanvasStats = window.__mirrorCanvasStats;
      if (typeof readCanvasStats !== "function") {
        return false;
      }
      const stats = readCanvasStats();
      return stats.frames > 0 && stats.quads > 50;
    },
    null,
    { timeout: args.timeout }
  );
  await page.waitForTimeout(args.settle);
  const probe = await page.evaluate(`(${PROBE_SOURCE})()`);
  const unsupported = await page.evaluate(() =>
    typeof window.__mirrorEffectUnsupported === "function" ? window.__mirrorEffectUnsupported() : null
  );
  await context.close();
  return { arm: name, url, probe, unsupported, warnings };
}

/** THE PRE-COMMITTED RULE, applied. Every branch is from the design; none is invented here. */
function verdict(dom, canvas) {
  const groupsOf = (r) => new Map((r?.probe?.groups ?? []).map((g) => [`${g.id}/${g.name}`, g]));
  const domGroups = groupsOf(dom);
  const canvasGroups = groupsOf(canvas);
  const shared = [...domGroups.keys()].filter((k) => canvasGroups.has(k));
  if (shared.length === 0) {
    return {
      branch: "neither",
      reason:
        "no creature HUD group is present on BOTH arms — there is no raised frame here to compare. Re-run on a " +
        "combat fixture with a creature on screen; this is not a verdict about the mechanisms."
    };
  }
  // THE TWO ARMS DO NOT PUBLISH THE SAME TERMS BY DEFAULT, and pretending otherwise is how this function lied on
  // its first run. The canvas arm answers through `__mirrorRaiseProbe` with `drawnY` in DESIGN space; the DOM
  // arm's `bakedY` is its element's own `matrix()` translate in its PARENT's space. Differencing those two is
  // meaningless, and differencing `bakedY` against a field the canvas rows do not carry is worse: it reads
  // `undefined ?? 0` and manufactures a 200-330 px "delta" out of nothing, which is exactly what it did.
  //
  // `domDrawnY` is NOT that number. It comes from the renderer's own `creatureGroupRows` seam, which publishes
  // the design-space global plus the same `raiseDy` the raise pass wrote — the canvas term, on parity. Where that
  // seam is absent (an older build) `drawnComparable` is false and the row degrades to what it printed before.
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  /** The seam's tolerance: the DOM's dy is Math.round-ed at the write site, and the deltas at issue are ~67-89px. */
  const DRAWN_TOLERANCE_PX = 1.0;
  const rows = shared.map((key) => {
    const d = domGroups.get(key);
    const c = canvasGroups.get(key);
    const dyAgree = Math.abs((d.dy ?? 0) - (c.dy ?? 0)) < 0.5;
    const domDrawnY = finite(d.drawnY) ? d.drawnY : null;
    const canvasDrawnY = finite(c.drawnY) ? c.drawnY : null;
    const domStreamedY = finite(d.streamedY) ? d.streamedY : null;
    const canvasStreamedY = finite(c.streamedY) ? c.streamedY : null;
    const drawnComparable = domDrawnY !== null && canvasDrawnY !== null;
    // CANVAS MINUS DOM, and the sign is readable: y grows downward, so a NEGATIVE delta is the canvas drawing the
    // group HIGHER — which is the direction U3b was filed in.
    const drawnDelta = drawnComparable ? canvasDrawnY - domDrawnY : null;
    const parentScaleY = c.parentScaleY ?? 1;
    return {
      key,
      domDy: d.dy,
      canvasDy: c.dy,
      dyAgree,
      // Report-only: the renderer's own record of the lift vs the `translate` read off the element. Two readings
      // of one write, so a disagreement means the DOM row is not trustworthy and the rest of it should be doubted.
      domRenderDy: finite(d.renderDy) ? d.renderDy : null,
      domRenderDyAgree: finite(d.renderDy) ? Math.abs(d.renderDy - (d.dy ?? 0)) < 0.5 : null,
      domAncestorScaleY: d.ancestorScaleY ?? 1,
      canvasParentScaleY: parentScaleY,
      domStreamedY,
      canvasStreamedY,
      streamedDelta: domStreamedY !== null && canvasStreamedY !== null ? canvasStreamedY - domStreamedY : null,
      canvasDrawnY,
      domDrawnY,
      domBakedY: finite(d.bakedY) ? d.bakedY : null,
      drawnComparable,
      drawnDelta,
      drawnAgree: drawnComparable ? Math.abs(drawnDelta) <= DRAWN_TOLERANCE_PX : null,
      // MECHANISM (1)'s OWN PREDICTION, so the branch below is checked rather than merely selected: the DOM writes
      // its lift as a CSS translate outside its matrix (parent space), the canvas adds it in global design space,
      // so the two differ by exactly dy·(parentScaleY − 1) and by nothing else.
      mech1PredictedDelta: (c.dy ?? 0) * (parentScaleY - 1)
    };
  });
  // R9 — THE RULE'S OWN RESIDUAL, per creature. Both arms now publish where they DREW the reticle, the state
  // display and the first power row's bottom edge, so the user's report can be read as a number instead of a
  // photograph: `powerGap` is `reticleDrawnY − powerBottomY`, and the rule the shared measurement implements says
  // it is 0. A gap that is 0 on the DOM arm and not on the canvas arm is the defect, localized; a gap that is
  // non-zero on BOTH is the rule itself failing on this creature and is not a backend difference at all.
  const creaturesOf = (r) => new Map((r?.probe?.creatures ?? []).map((c) => [c.rootId, c]));
  const domCreatures = creaturesOf(dom);
  const canvasCreatures = creaturesOf(canvas);
  const creatureRows = [...canvasCreatures.keys()]
    .filter((k) => domCreatures.has(k))
    .map((rootId) => {
      const d = domCreatures.get(rootId);
      const c = canvasCreatures.get(rootId);
      const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const pair = (key) => ({ dom: num(d[key]), canvas: num(c[key]) });
      const gapDom = num(d.powerGap);
      const gapCanvas = num(c.powerGap);
      return {
        rootId,
        powerGap: { dom: gapDom, canvas: gapCanvas },
        powerGapDelta: gapDom === null || gapCanvas === null ? null : gapCanvas - gapDom,
        reticleDrawnY: pair("reticleDrawnY"),
        displayDrawnY: pair("displayDrawnY"),
        powerBottomY: pair("powerBottomY"),
        reticleTop: pair("reticleTop"),
        powerTop: pair("powerTop"),
        reticleFallback: { dom: d.reticleFallback ?? null, canvas: c.reticleFallback ?? null },
        powerFallback: { dom: d.powerFallback ?? null, canvas: c.powerFallback ?? null }
      };
    });
  const allAgree = rows.every((r) => r.dyAgree);
  const drawnComparable = rows.every((r) => r.drawnComparable);
  const drawnAllAgree = drawnComparable && rows.every((r) => r.drawnAgree);
  // Mechanism (1)'s whole content is that a NON-IDENTITY parent scale stretches the lift. At identity it predicts
  // no difference at all and its fix is byte-identical, so an identity chain cannot select it.
  const anyNonIdentityScale = rows.some(
    (r) => Math.abs(r.canvasParentScaleY - 1) > 1e-3 || Math.abs(r.domAncestorScaleY - 1) > 1e-3
  );
  if (!allAgree) {
    return {
      branch: "plan-divergence",
      reason:
        "the two arms compute DIFFERENT dy — which they no longer can by construction: both call " +
        "`raise/handRaisePlan.planHandRaise` and the creature measurement lives in `raise/creatureHud`. So this " +
        "is not mechanism (2) any more, it is a REGRESSION: a backend has re-grown a private decision, or the " +
        "two pages are running different bundles. Check the build before reading anything else in this file.",
      rows,
      creatureRows
    };
  }
  if (anyNonIdentityScale) {
    // THE FRAME THIS SCRIPT EXISTS FOR. A non-identity chain is the only thing that can tell the two application
    // spaces apart, and with the fix in force the drawn heights must now AGREE on it. `mech1PredictedDelta` is
    // what the OLD arithmetic would have produced (`dy·(parentScaleY − 1)`), so a delta that matches it says the
    // fix is not in force on this page rather than that it is wrong.
    if (!drawnComparable) {
      return {
        branch: "not-comparable",
        reason:
          "a NON-IDENTITY creature chain is on screen — the frame this run wanted — but one of the arms published " +
          "no design-space drawn height, so the comparison could not be made. The DOM seam is " +
          "`handRaiseDebug().creatureGroupRows`; a page without it is stale.",
        rows,
        creatureRows
      };
    }
    if (drawnAllAgree) {
      return {
        branch: "parent-space-fix-holds",
        reason:
          "a NON-IDENTITY creature chain is on screen AND the two arms draw every shared creature-HUD group at " +
          `the same height (within ${DRAWN_TOLERANCE_PX}px). This is U3b's mechanism (1) exercised live and the ` +
          "shipped fix holding: the canvas maps its cosmetic offset through the owner's parent transform, which " +
          "is what the DOM's CSS `translate` does. `mech1PredictedDelta` per row is the divergence this frame " +
          "WOULD have shown on the old arithmetic — non-zero there is the measure of what was fixed.",
        rows,
        creatureRows
      };
    }
    const looksUnfixed = rows.every(
      (r) => Math.abs(r.drawnDelta - r.mech1PredictedDelta) <= DRAWN_TOLERANCE_PX
    );
    return {
      branch: "parent-space-fix-absent",
      reason: looksUnfixed
        ? "a NON-IDENTITY creature chain is on screen and the drawn heights differ by EXACTLY " +
          "`dy·(parentScaleY − 1)` — the old design-space add, to the pixel. The fix is not in force on this " +
          "page: check the canvas arm's parent-space diagnostic and that the bundle is current."
        : "a NON-IDENTITY creature chain is on screen, the drawn heights DIFFER, and the difference is NOT " +
          "`dy·(parentScaleY − 1)`. So it is neither the old arithmetic nor the fix: since drawnY = streamedY + " +
          "dy on both arms and the dys agree, the residual is `streamedY` — WALK PLACEMENT. File the per-row " +
          "streamedDelta; nothing about the raise explains it.",
      rows,
      creatureRows
    };
  }

  if (drawnComparable && !drawnAllAgree) {
    return {
      branch: "term-named",
      reason:
        "every shared creature-HUD group computes the SAME dy on both arms and every parent scale is identity, " +
        "so neither mechanism selects — but the DRAWN HEIGHTS DIFFER. On both arms drawnY = streamedY + dy, and " +
        "the dys agree, so the differing component is `streamedY`: WALK PLACEMENT, not the raise. That is the " +
        "term this branch is required to name, and it is a different defect from either filed mechanism. " +
        "NOTHING SHIPS this run; the per-row streamedDelta is the number M7 mechanism selection starts from " +
        "next round.",
      rows,
      creatureRows
    };
  }
  if (drawnAllAgree) {
    return {
      branch: "neither",
      reason:
        "every shared creature-HUD group computes the SAME dy on both arms, every parent scale is identity, AND " +
        `the drawn heights agree within ${DRAWN_TOLERANCE_PX}px on every one of them. Mechanism (1) predicts no ` +
        "difference (its fix would be byte-identical) and mechanism (2) has no disagreement to adopt. Neither " +
        "selects and NOTHING SHIPS. " +
        "WHAT THAT DOES AND DOES NOT SAY, now that the parent-space fix has shipped: it is a REGRESSION PASS " +
        "(the fix is byte-identical on an identity chain, and it is), and it is NOT evidence about the fix, " +
        "which only bites where a chain scales. This frame cannot exercise it. Re-run at the viewport the " +
        "defect was reported from — `--viewport WxH` — before concluding anything about U3b.",
      rows,
      creatureRows
    };
  }
  return {
    branch: "neither",
    reason:
      "every shared creature-HUD group computes the SAME dy on both arms, and every parent scale is identity — " +
      "so mechanism (1) predicts no difference (its fix would be byte-identical) and mechanism (2) has no " +
      "disagreement to adopt. Neither selects and NOTHING SHIPS. " +
      "THE TERM, as this branch is required to name it: this build's DOM arm publishes no drawn height. It " +
      "exposes `bakedY` (its element's matrix translate, in PARENT space) while the canvas publishes `drawnY` " +
      "(design space), so the one comparison that could still separate the mechanisms is not available. The " +
      "renderer seam that closes it is `handRaiseDebug().creatureGroupRows` — if this branch is reached on a " +
      "current client, the page is stale or the raise pass tracked no creature group.",
    rows,
    creatureRows
  };
}

async function main() {
  if (!(await portOpen(args.game))) {
    console.error(
      `no instance on :${args.game}. Bring it up first:\n  node scripts/validate-touch-live.mjs --keep`
    );
    process.exit(4);
  }
  if (!(await portOpen(args.vite))) {
    console.error(`no dev server on :${args.vite}. Same command brings it up.`);
    process.exit(4);
  }
  acquireLock();

  const outDir = resolve(REPO_ROOT, args.out);
  mkdirSync(outDir, { recursive: true });

  console.log("probe-raise-live");
  console.log(`  instance port: ${args.game}   vite: ${args.vite}`);
  console.log(`  NO GAME INPUT IS SCRIPTED. ?raiseHand=on is client-side; these are page loads.`);
  console.log("");

  const browser = await chromium.launch({ headless: true });
  let dom = null;
  let canvas = null;
  try {
    // SEQUENTIAL, not parallel: two live pages against one headless instance would put a second variable
    // (contention for the host's own frame budget) into a geometry comparison.
    dom = await runArm(browser, "dom", "");
    canvas = await runArm(browser, "canvas", "stage=canvas");
  } finally {
    await browser.close();
  }

  writeFileSync(resolve(outDir, "raise-live-dom.json"), `${JSON.stringify(dom, null, 2)}\n`);
  writeFileSync(resolve(outDir, "raise-live-canvas.json"), `${JSON.stringify(canvas, null, 2)}\n`);
  const answer = verdict(dom, canvas);
  // A self-describing artifact: the viewport is the variable this round added, and a verdict file that does not
  // carry it cannot be compared with the 1920x1080 control it is supposed to be read against.
  answer.viewport = `${args.viewport.width}x${args.viewport.height}`;
  // Retain the captured diagnostic value for artifact readers; it is not a URL control.
  answer.canvasOffsetParentSpace = canvas?.probe?.offsetParentSpace ?? null;
  writeFileSync(resolve(outDir, "verdict.json"), `${JSON.stringify(answer, null, 2)}\n`);

  console.log("");
  console.log(`  dom    groups ${dom.probe?.groups?.length ?? 0}, holders ${dom.probe?.holders?.length ?? 0}`);
  console.log(`  canvas groups ${canvas.probe?.groups?.length ?? 0}, holders ${canvas.probe?.holders?.length ?? 0}, liftPx ${canvas.probe?.liftPx ?? "n/a"}`);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : "n/a");
  for (const row of answer.rows ?? []) {
    console.log(
      `    ${row.key}: dom dy ${row.domDy}, canvas dy ${row.canvasDy}` +
        `${row.dyAgree ? " (agree)" : " (DIFFER)"}` +
        `, parentScaleY dom ${row.domAncestorScaleY} / canvas ${row.canvasParentScaleY}`
    );
    if (row.drawnComparable) {
      console.log(
        `        drawnY  dom ${num(row.domDrawnY)} / canvas ${num(row.canvasDrawnY)}` +
          `  delta ${num(row.drawnDelta)} (canvas − dom)` +
          `${row.drawnAgree ? " AGREE" : " DIFFER"}` +
          // The named term, printed on every row rather than only on the branch that concludes with it: with the
          // dys agreeing, drawnY = streamedY + dy makes any drawn delta a STREAMED delta by arithmetic.
          `   streamedY dom ${num(row.domStreamedY)} / canvas ${num(row.canvasStreamedY)} delta ${num(row.streamedDelta)}` +
          `   mech1 predicts ${num(row.mech1PredictedDelta)}`
      );
      if (row.domRenderDyAgree === false) {
        console.log(
          `        !! the DOM element's translate (${row.domDy}) disagrees with the renderer's own raiseDy ` +
            `(${row.domRenderDy}) — this row's drawn height should not be trusted`
        );
      }
    } else {
      console.log(
        `        drawn height NOT COMPARABLE (dom bakedY ${num(row.domBakedY)} is parent-space; canvas drawnY ` +
          `${num(row.canvasDrawnY)} is design-space) — this build publishes no creatureGroupRows seam`
      );
    }
  }
  // THE RULE'S RESIDUAL, per creature — printed whenever both arms answered, because it is the term the report
  // was written in ("the powers should sit directly above the target box") and a reader should not have to open
  // the JSON to see it.
  for (const c of answer.creatureRows ?? []) {
    const gapLine =
      c.powerGap.dom === null || c.powerGap.canvas === null
        ? "one arm published no gap"
        : `dom ${num(c.powerGap.dom)} / canvas ${num(c.powerGap.canvas)}  delta ${num(c.powerGapDelta)}` +
          `${Math.abs(c.powerGapDelta ?? 0) <= 1 ? " AGREE" : " DIFFER"}`;
    console.log(`    creature ${c.rootId}: power-row bottom vs reticle top — ${gapLine}`);
    console.log(
      `        reticleDrawnY dom ${num(c.reticleDrawnY.dom)} / canvas ${num(c.reticleDrawnY.canvas)}` +
        `   powerBottomY dom ${num(c.powerBottomY.dom)} / canvas ${num(c.powerBottomY.canvas)}` +
        `   fallbacks reticle ${c.reticleFallback.dom}/${c.reticleFallback.canvas} power ${c.powerFallback.dom}/${c.powerFallback.canvas}`
    );
  }

  console.log("");
  console.log(`  VERDICT: ${answer.branch}`);
  console.log(`    ${answer.reason}`);
  console.log("");
  console.log(`  artifacts: ${outDir}`);
  console.log(`  remember: sts2 --instance touchqa game close`);
}

await main();
releaseLock();
