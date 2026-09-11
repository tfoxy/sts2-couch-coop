// Diagnoses the flaky mirror touch tap: is the mouse_filter→pointer-events pipeline working, and what
// actually occludes a hover-first widget (a card / event option) at its neighbour's spot?
//
// Usage (from frontend/, so playwright resolves):
//   node ../scripts/diagnose-touch-occlusion.mjs
//   MIRROR_URL=http://localhost:5173/?name=diag node ../scripts/diagnose-touch-occlusion.mjs
//
// Navigate the live game to the repro screen FIRST (combat with cards in hand, a card reward, or the ancient
// event), then run it.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "package.json"));
const { chromium } = require("playwright");

const url = process.env.MIRROR_URL ?? "http://localhost:5173/?name=pla";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(Number(process.env.MIRROR_WAIT_MS ?? 4500));

const report = await page.evaluate(() => {
  const all = [...document.querySelectorAll(".mirror-node")];
  const peNone = all.filter((el) => getComputedStyle(el).pointerEvents === "none");
  const typeLeaf = (t) => (t ?? "").split(".").at(-1);
  // Confirms the frontend actually shipped the data-mouse-filter stamp (else mf is null everywhere = stale build).
  const stampedNodes = all.filter((el) => el.getAttribute("data-mouse-filter") !== null).length;

  // 1. Pipeline health: how many nodes are pointer-events:none, and a sample of their types.
  const noneTypes = {};
  for (const el of peNone) {
    const t = typeLeaf(el.getAttribute("data-node-type"));
    noneTypes[t] = (noneTypes[t] ?? 0) + 1;
  }

  // 2. Per touch-widget: its descendants, their type + computed pointer-events + rect, so we can see which
  // descendants still capture the hit-test and whether they extend beyond the widget's own body.
  const byTouch = {};
  for (const el of document.querySelectorAll("[data-touch-id]")) {
    const id = el.getAttribute("data-touch-id");
    (byTouch[id] ??= []).push(el);
  }
  const widgets = Object.entries(byTouch).map(([id, els]) => {
    const rects = els.map((el) => el.getBoundingClientRect());
    const minX = Math.min(...rects.map((r) => r.left));
    const minY = Math.min(...rects.map((r) => r.top));
    const maxX = Math.max(...rects.map((r) => r.right));
    const maxY = Math.max(...rects.map((r) => r.bottom));
    const descendants = els
      .map((el, i) => ({
        type: typeLeaf(el.getAttribute("data-node-type")),
        name: (el.getAttribute("data-scene-node-path") ?? "").split("/").at(-1),
        mf: el.getAttribute("data-mouse-filter"), // Godot mouse_filter: 0 Stop / 1 Pass / 2 Ignore / null non-Control
        pe: getComputedStyle(el).pointerEvents,
        w: Math.round(rects[i].width),
        h: Math.round(rects[i].height)
      }))
      // Every descendant with a non-trivial box, with its real mouse_filter — so we can see why an occluder
      // stays hittable (Stop=0 mouse_filter, or null/non-Control, or a stale build where mf is null).
      .filter((d) => d.w > 4 && d.h > 4);
    return {
      id,
      count: els.length,
      bbox: { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) },
      hittable: descendants
    };
  });

  // 3. Overlap: for each pair of touch widgets, does one's hittable bbox cover the OTHER's centre? That's the
  // occlusion that turns a switch-tap into a false commit.
  const overlaps = [];
  for (const a of widgets) {
    const cx = a.bbox.x + a.bbox.w / 2;
    const cy = a.bbox.y + a.bbox.h / 2;
    const stack = document.elementsFromPoint(cx, cy);
    const topTouch = stack.map((el) => el.getAttribute?.("data-touch-id")).find((v) => v);
    if (topTouch && topTouch !== a.id) {
      const topEl = stack.find((el) => el.getAttribute?.("data-touch-id") === topTouch);
      overlaps.push({
        widget: a.id,
        occludedBy: topTouch,
        viaType: typeLeaf(topEl?.getAttribute?.("data-node-type")),
        viaName: (topEl?.getAttribute?.("data-scene-node-path") ?? "").split("/").at(-1),
        viaMf: topEl?.getAttribute?.("data-mouse-filter"),
        viaPe: topEl ? getComputedStyle(topEl).pointerEvents : "?"
      });
    }
  }

  return {
    totalNodes: all.length,
    stampedNodes,
    pointerEventsNone: peNone.length,
    noneTypes,
    touchWidgetCount: widgets.length,
    widgets: widgets.slice(0, 20),
    overlaps
  };
});
await browser.close();

console.log(JSON.stringify(report, null, 2));
