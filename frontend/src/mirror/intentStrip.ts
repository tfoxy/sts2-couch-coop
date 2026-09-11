// COMPOSITOR-DRIVEN enemy-intent glyph cycling (R10-B1).
//
// The headless client freezes the enemy-intent glyph, so the browser replays its per-frame texture swap. The original
// mechanism blitted the current atlas frame onto the glyph's <canvas> from the renderer's deadline tick (see
// mirrorRenderer's advanceIntent/tickIntent). That works, but the tick is a MAIN-THREAD wakeup: the A4 idle
// baseline measured it waking at 30-37Hz for the whole idle window, and every wakeup's rAF forces a full main
// frame (UpdateLayoutTree + Layerize + Commit + PrePaint ≈ 7.1ms desktop / 20.2ms at 6× CPU throttle) — 17.6% /
// 74.8% of an idle window spent re-rendering a settled scene. Composited animations cost the main thread nothing;
// a bare frame REQUEST costs all of that. So the glyph must animate without asking for frames at all.
//
// MECHANISM: pre-render every frame of the set ONCE into a horizontal strip canvas (N cells), show it through a
// one-cell clipping viewport, and step the strip with a CSS `translate` animation:
//
//     @keyframes spirectl-mirror-intent-steps-<travel> {
//       from { translate: 0px 0px } to { translate: -<travel>px 0px }
//     }
//     animation: <name> <N/fps*1000>ms steps(N) -<phase>ms infinite;
//
// `steps(N)` is `steps(N, jump-end)`: it maps progress p to floor(p*N)/N, so the shown cell at local time t is
// floor((t mod T)/T * N) = floor(t*fps/1000) mod N — EXACTLY mirrorRenderer's intentFrameIndex, i.e. a flip-book
// cycled at a fixed frame rate. Verified in a browser control at 71/71
// sampled times, and unit-asserted in intentSteps.spec.ts.
//
// COMPOSITOR RULES this file exists to respect:
//   • the animated property is the INDIVIDUAL `translate:` with LITERAL px values — Chromium composites that (and
//     it composes with a baked `transform` matrix, so the strip may sit under placement transforms);
//   • `background-position` (the obvious sprite-sheet idiom) is NOT compositable — Chromium reports
//     `unsupportedCSSProperty` + `unsupportedProperties: ["background-position-x"]`, which the idle-compositing
//     gate flags;
//   • the animated element must not carry a baked matrix of its own, so the strip is a dedicated child INSIDE the
//     viewport (the viewport carries any placement transform).
//
// The keyframes are MIRROR-owned (injected here, not by @spirectl/presentation) but deliberately carry the
// `spirectl-` name prefix: scripts/assert-idle-compositing.mjs asserts `compositeFailed == 0` for every
// `spirectl-*` animation it sees, so the prefix keeps this family inside the frozen gate's scope forever.

import type { MirrorIntentFrames } from "@/mirror/sceneTree";

/** Prefix of every injected keyframes rule (see the header for why it is `spirectl-`). */
export const INTENT_STEPS_PREFIX = "spirectl-mirror-intent-steps";

export interface IntentStripGeometry {
  /** Number of cells = frames in the set. */
  count: number;
  /** One cell's INTRINSIC canvas pixels (max over the frames, so the biggest frame is never downsampled). */
  cellW: number;
  cellH: number;
  /** One cell's DISPLAY box in CSS px = the box the single-frame canvas has today (frame 0's region). */
  dispW: number;
  dispH: number;
  /** Total CSS px the strip travels over one cycle (count × dispW) — the keyframes' end translate. */
  travelPx: number;
  /** One full cycle in ms (count / fps × 1000) — with steps(count) each cell shows for exactly 1000/fps ms. */
  durationMs: number;
}

// Geometry for a frame set, or null when it can't be stripped (fewer than 2 frames, a frame with no region/url,
// a degenerate frame-0 box) — the caller then keeps the legacy per-frame blit.
//
// DISPLAY box = frame 0's region, because that is what the single-frame path renders today: nodeStyle sizes a LEAF
// atlas element to `textureRegion` (which sceneTree pins to frame 0 via applyIntentFrame0) and the canvas fills it
// at `inset:0; 100%`, while an INTERIOR node's canvas gets `atlasCanvasPlacement`, whose width/height are the same
// frame-0 region. Every later frame is therefore STRETCHED into that same on-screen box today, and each strip cell
// reproduces exactly that by drawing its frame scaled to fill the whole cell.
export function intentStripGeometry(spec: MirrorIntentFrames): IntentStripGeometry | null {
  const frames = spec.frames;
  const count = frames.length;
  if (count <= 1) {
    return null;
  }
  const base = frames[0].region;
  if (!base || base.width <= 0 || base.height <= 0) {
    return null;
  }
  let cellW = 0;
  let cellH = 0;
  for (const frame of frames) {
    if (!frame.url || !frame.region || frame.region.width <= 0 || frame.region.height <= 0) {
      return null; // an unpaintable frame — the legacy blit path skips it per frame; a strip can't
    }
    cellW = Math.max(cellW, Math.round(frame.region.width));
    cellH = Math.max(cellH, Math.round(frame.region.height));
  }
  const fps = spec.fps > 0 ? spec.fps : 15;
  return {
    count,
    cellW: Math.max(1, cellW),
    cellH: Math.max(1, cellH),
    dispW: base.width,
    dispH: base.height,
    travelPx: base.width * count,
    durationMs: (count / fps) * 1000
  };
}

// Where in its cycle a strip armed at `startMs` is at `nowMs`, as the NEGATIVE animation-delay that seeds it.
// Always in [0, durationMs) so the emitted CSS is stable, and non-negative for a clock that hasn't advanced.
export function intentStepsPhaseMs(nowMs: number, startMs: number, durationMs: number): number {
  if (!(durationMs > 0) || !Number.isFinite(nowMs) || !Number.isFinite(startMs)) {
    return 0;
  }
  const elapsed = nowMs - startMs;
  const phase = elapsed % durationMs;
  return phase < 0 ? phase + durationMs : phase;
}

/** Round a px travel to a stable keyframes-name token (3 decimals; `.` → `_` so the name stays a CSS ident). */
function travelToken(travelPx: number): string {
  return String(Math.round(travelPx * 1000) / 1000).replace(".", "_");
}

/** The keyframes rule name for one travel distance (pure — no DOM). */
export function intentStepsKeyframesName(travelPx: number): string {
  return `${INTENT_STEPS_PREFIX}-${travelToken(travelPx)}`;
}

/** The keyframes rule text for one travel distance (pure — no DOM). Literal px values: compositor-eligible. */
export function intentStepsKeyframesCss(travelPx: number): string {
  const px = Math.round(travelPx * 1000) / 1000;
  return `@keyframes ${intentStepsKeyframesName(travelPx)}{from{translate:0px 0px}to{translate:-${px}px 0px}}`;
}

// The `animation` shorthand for one strip (pure). Phase is applied as a NEGATIVE delay — see the header. Times
// keep 6 decimals: the cycle length is count/fps, which is rarely exact (4 frames at 15fps = 266.666667ms), and a
// coarser rounding would slowly drift the glyph off the game clock the phase is anchored to.
export function intentStepsAnimationCss(geo: IntentStripGeometry, phaseMs: number): string {
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  return `${intentStepsKeyframesName(geo.travelPx)} ${round6(geo.durationMs)}ms steps(${geo.count}) -${round6(phaseMs)}ms infinite`;
}

// --- keyframes injection (one <style data-mirror-intent-steps> in <head>, one rule per travel distance) --------

const injected = new Set<string>();
let styleEl: HTMLStyleElement | null = null;

/** Inject (idempotently) the keyframes for one travel distance and return its name. No-op without a DOM. */
export function ensureIntentStepsKeyframes(travelPx: number): string {
  const name = intentStepsKeyframesName(travelPx);
  if (injected.has(name) || typeof document === "undefined") {
    return name;
  }
  injected.add(name);
  if (!styleEl || !styleEl.isConnected) {
    styleEl = document.createElement("style");
    styleEl.dataset.mirrorIntentSteps = "";
    document.head.appendChild(styleEl);
  }
  styleEl.appendChild(document.createTextNode(intentStepsKeyframesCss(travelPx)));
  return name;
}

/** TEST-ONLY: forget the injected rules (and the shared <style>) so a test starts clean. */
export function __resetIntentStepsKeyframesForTest(): void {
  injected.clear();
  styleEl?.remove();
  styleEl = null;
}
