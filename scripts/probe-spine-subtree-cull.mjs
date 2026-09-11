#!/usr/bin/env node
// SUBTREE PAINT-CULL census for mirror spine stills — "which spine nodes are shaped like the bug?"
//
// THE BUG THIS EXISTS FOR (Aug-25-2026, Moto G86 / Chrome 151 / dpr 3.4876): the Shop's background stopped
// painting ~47% of the way across and `.mirror-stage`'s own background showed through, reading as a large black
// rectangle. Blink was culling the paint recording of the `BgContainer/SpineSprite` SUBTREE. It is not an
// overlay, not a missing image, and NOT a layer/texture-size clamp:
//
//   * a ruler of bars appended to `.mirror-stage` (design space) painted edge to edge straight through the dead
//     region, while the identical ruler given the spine img's transform and appended INSIDE the spine subtree
//     truncated at exactly the background's cut — so the boundary belongs to that subtree's recording;
//   * `will-change: transform` on the spine node (its own composited layer ⇒ its own cull rect) fixed it with
//     every effect still on, at +1 composited layer;
//   * with the fix applied there were still 4 composited layers over 8192px and `.mirror-stage`'s layer was
//     unchanged at 8789x3767, which is what rules out the texture-size story.
//
// THE FAILING SHAPE, which is what this probe looks for: a `.mirror-node` that (a) paints a spine STILL laid out
// in Godot-native pixels — the Shop's is 2080x1005 CSS px carrying its own `scale(2.5)`, i.e. ~5200 local px,
// shrunk ~7x by ancestor transforms — and (b) has composited effect surfaces INSIDE its subtree (bone-attached
// VFX).
//
// WORKING MODEL for the dpr dependence, which is what the numbers below are chosen to expose: the cull budget
// behaves as a DEVICE-pixel quantity while the span it has to cover is that Godot-native LOCAL span, so
// `local px x dpr` is the ratio that decides whether the boundary lands inside the picture. Measured support is
// the dpr split (multiple phones reproduce, desktop at dpr 1 does not) plus the containment split above; the
// exact Blink constant and the exact coordinate space are NOT pinned down, so treat the product as a risk
// ranking, not as an arithmetic prediction of where the cut will fall.
//
// Effects that are SIBLINGS of the spine node do not trigger it — in the Shop, `BgContainer/fire`, `fire2` and
// `fire3` are harmless while `SpineSprite/SpineBoneNode/fire4` is not. That containment is the whole predicate.
//
// WHY IT MUST BE RUN ON A REAL HIGH-DPR DEVICE: the geometry that decides the outcome is `local px x dpr`, and a
// desktop Chrome at dpr 1 reports a healthy tree for a page that is broken on a phone. This probe therefore
// talks CDP to whatever browser you point it at, and REFUSES to call a run conclusive below `--min-dpr`.
//
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
//   node scripts/probe-spine-subtree-cull.mjs                        # census of the live room
//   node scripts/probe-spine-subtree-cull.mjs --json out.json        # machine-readable
//   node scripts/probe-spine-subtree-cull.mjs --assert-promoted      # exit 1 if a node needs promotion and lacks it
//
// `--assert-promoted` is the regression gate: every node with the failing shape must carry the renderer's
// promotion class. Run it in each room you care about — the shape is per-room, so a green Shop proves nothing
// about a boss fight.
//
// Exit codes: 0 census taken (or the assert passed) - 1 `--assert-promoted` found an unpromoted node - 2 harness error.

const DEFAULT_CDP = "http://localhost:9222";

// Kept in sync with the renderer's own predicate (mirrorRenderer.ts). Both the LIVE canvas and the frozen `<img>`
// stand-in count: the bug reproduces with `?fxStaticStills=off` (canvases live) and in the default stills
// configuration, so a census that only looked for `canvas` would call a stills-configured page clean.
const EFFECT_SELECTOR = "canvas, .mirror-shader-self, .mirror-particle-self, [data-godot-shader-image]";
const PROMOTED_CLASS = "mirror-spine-promoted";

function parseArgs(argv) {
  const a = { cdp: DEFAULT_CDP, match: "sts2-couch", json: null, assert: false, minDpr: 2 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--cdp") a.cdp = argv[++i];
    else if (k === "--match") a.match = argv[++i];
    else if (k === "--json") a.json = argv[++i];
    else if (k === "--assert-promoted") a.assert = true;
    else if (k === "--min-dpr") a.minDpr = Number(argv[++i]);
    else if (k === "--help" || k === "-h") {
      console.log("usage: probe-spine-subtree-cull.mjs [--cdp URL] [--match SUBSTR] [--json FILE] [--assert-promoted] [--min-dpr N]");
      process.exit(0);
    } else {
      console.error(`unknown arg: ${k}`);
      process.exit(2);
    }
  }
  return a;
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  // A backgrounded tab stops producing frames and reports a torn-down mirror; front it first or the census is a
  // census of nothing (measured: `document.visibilityState === "hidden"` ⇒ 0 `.mirror-node`).
  await send("Page.bringToFront");
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  ws.close();
  if (r.result?.exceptionDetails) {
    throw new Error(`page threw: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`);
  }
  return r.result?.result?.value;
}

const CENSUS = `(() => {
  const EFFECT = ${JSON.stringify(EFFECT_SELECTOR)};
  const PROMOTED = ${JSON.stringify(PROMOTED_CLASS)};
  const stage = document.querySelector(".mirror-stage");
  const nodes = [];
  for (const el of document.querySelectorAll(".mirror-node")) {
    const still = el.querySelector(":scope > .mirror-clip-self > .mirror-spine-img");
    if (!still) continue;
    const fx = el.querySelectorAll(EFFECT);
    const box = still.getBoundingClientRect();
    // The element's own layout box times its own transform scale = the local span Blink has to cover. That
    // product, NOT the natural image size, is the quantity that tracks risk here (see the WORKING MODEL note).
    const layoutW = parseFloat(still.style.width) || still.naturalWidth || 0;
    const ownScale = (() => {
      const m = new DOMMatrixReadOnly(getComputedStyle(still).transform);
      return m.a || 1;
    })();
    nodes.push({
      path: el.getAttribute("data-node-path") || "",
      naturalPx: [still.naturalWidth, still.naturalHeight],
      layoutPx: Math.round(layoutW),
      ownScale: +ownScale.toFixed(4),
      localSpanPx: Math.round(layoutW * ownScale),
      renderedCssPx: Math.round(box.width),
      effectDescendants: fx.length,
      atRisk: fx.length > 0,
      promoted: el.classList.contains(PROMOTED) || getComputedStyle(el).willChange.includes("transform"),
    });
  }
  return {
    url: location.href,
    visibility: document.visibilityState,
    dpr: devicePixelRatio,
    stageDesignPx: stage ? [parseFloat(stage.style.width) || 0, parseFloat(stage.style.height) || 0] : null,
    mirrorNodes: document.querySelectorAll(".mirror-node").length,
    canvases: document.querySelectorAll("canvas").length,
    nodes,
  };
})()`;

async function main() {
  const args = parseArgs(process.argv);
  let list;
  try {
    list = await (await fetch(`${args.cdp}/json/list`)).json();
  } catch (err) {
    console.error(`cannot reach CDP at ${args.cdp} (${err.message}).`);
    console.error("for a phone: adb forward tcp:9222 localabstract:chrome_devtools_remote");
    process.exit(2);
  }
  const page = list.find((p) => p.type === "page" && (p.url || "").includes(args.match));
  if (!page) {
    console.error(`no page whose url contains ${JSON.stringify(args.match)}; open the mirror first.`);
    process.exit(2);
  }

  const census = await evaluate(page.webSocketDebuggerUrl, CENSUS);
  if (!census.mirrorNodes) {
    console.error("the page has no `.mirror-node` — the mirror is not mounted (not joined, or the tab was asleep).");
    process.exit(2);
  }

  console.log(`url            ${census.url}`);
  console.log(`dpr            ${census.dpr.toFixed(4)}   stage design ${census.stageDesignPx?.join("x") ?? "?"}`);
  console.log(`mirror nodes   ${census.mirrorNodes}   canvases ${census.canvases}`);
  console.log("");
  if (!census.nodes.length) {
    console.log("no spine stills mounted in this room — nothing to say about this room.");
  }
  for (const n of census.nodes) {
    const flag = n.atRisk ? (n.promoted ? "OK  (at risk, promoted)" : "RISK(unpromoted)      ") : "safe(no effects)      ";
    console.log(
      `${flag} ${n.localSpanPx.toString().padStart(6)} local px  x dpr = ${Math.round(n.localSpanPx * census.dpr)
        .toString()
        .padStart(6)}  fx=${n.effectDescendants.toString().padStart(3)}  ${n.path.split("/").slice(-3).join("/")}`,
    );
  }

  if (census.dpr < args.minDpr) {
    console.log("");
    console.log(
      `NOTE: dpr ${census.dpr.toFixed(2)} < ${args.minDpr}. This browser is too low-DPR to reproduce the cull — a clean`,
    );
    console.log("      census here says nothing about a phone. Re-run against a real device.");
  }

  if (args.json) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(args.json), { recursive: true });
    writeFileSync(args.json, JSON.stringify(census, null, 2));
    console.log(`\nwrote ${args.json}`);
  }

  if (args.assert) {
    const bad = census.nodes.filter((n) => n.atRisk && !n.promoted);
    if (bad.length) {
      console.error(`\nFAIL: ${bad.length} spine node(s) have the failing shape and are not promoted:`);
      for (const n of bad) console.error(`  ${n.path}`);
      process.exit(1);
    }
    console.log(`\nPASS: ${census.nodes.filter((n) => n.atRisk).length} at-risk node(s), all promoted.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
