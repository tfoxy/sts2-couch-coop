// WHAT A PARTICLE NODE CAN ACTUALLY BE SEEN THROUGH — the stage viewport, expressed in ONE particle
// node's own local px space, for gsw's `data-godot-particle-visible-rect`.
//
// WHY GSW NEEDS IT. gsw sizes a particle system's overlay canvas as the node box grown by a per-side
// MARGIN, and that margin is now derived from where the particles actually TRAVEL — initial velocity
// over the spread arc, gravity, acceleration, damping, orbit, lifetime (`@godot-scene-web/html`'s
// `particles/extents.ts`). Ballistics are unbounded in principle: the treasure chest's coin burst
// flies ~1264px sideways and falls 2500px in its 2.5s life. Two things make that a problem HERE
// rather than anywhere else:
//   * A MIRRORED PARTICLE LAYER IS 0x0. The producer sends a Godot `Node2D`, which has no rect at
//     all, so `nodeStyles`' `placementBox` gives it a zero box at its transform origin and the
//     canvas is 100% margin. There is no box to bound it with.
//   * SO WITHOUT A RECT THE MARGIN FALLS BACK TO GSW'S `PAD_CAP` (1024px per side), i.e. a 2048x2048
//     canvas for the coin burst — 8x the pixels of the stage it is drawn on, most of them for coins
//     that are off-screen. With the rect it is exactly the visible 1920x1080.
// The failure mode without EITHER is worse than wasted pixels: before the travel term existed that
// burst got a 710x710 square, and a canvas backing store IS the clip (there is no CSS overflow to
// relax), so the coins were cut off along a hard rectangle in mid-screen.
//
// THE SPACE. The rect is in the node's OWN LOCAL space — the space the gsw canvas is laid out in,
// INSIDE the element's CSS transform — with (0,0) at the element's own box corner. So it is the
// stage viewport pulled back through the node's rendered global: `inverse(g)` applied to the
// viewport's corners. A node at design (937, 512) on a 1920x1080 stage therefore reports
// `-937,-512,1920,1080`, and gsw reads off 937px of room to its left and 983 to its right.
//
// PURE MATH, NO LAYOUT READ. Every input is already in hand during the walk (`gNodeStretched` and
// the spread draw box), and this is per-particle-node per-visit work — a `getBoundingClientRect` here
// would be a forced reflow per emitter per frame, which is the phone-CPU rule `pointerMap.ts` states
// and which the particle runtime already paid for once (the Aug-14 trace where 97% of a gsw
// runtime's self-time was `get clientWidth`).

import { affineInverse, nodeMatrix, type Affine } from "@/mirror/affine";
import { px } from "@/mirror/stageFit";

/** The visible stage in design space: [0,width] x
 *  [0,height], where width is `MIRROR_DESIGN_WIDTH · spreadFactor` on a widened stage and the height
 *  never widens. The stage element clips to exactly this (`.mirror-stage` is `overflow: hidden`),
 *  which is what makes it the right budget — a particle outside it cannot be seen at all. */
export interface ParticleViewport {
  width: number;
  height: number;
}

/** A rect in the node's own local px space, as gsw's `parseLocalVisibleRect` reads it. */
export interface LocalVisibleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The rect is SNAPPED OUTWARD to this grid (design px), which is purely about CHURN. gsw re-reads
// the attribute every reconcile and re-sizes the canvas when it moved, and an unquantized rect
// changes on any sub-pixel drift — so a scrolling map's emitters would restate it, re-dirty gsw's
// particle runtime and re-key their frozen frames on EVERY frame of the scroll. Snapped, an emitter
// restates it once per 16px travelled. Outward (floor the corner, ceil the far edge) so the snap can
// only ever GRANT room, never take it: the rounding direction is the difference between a few wasted
// px and a visible crop.
const RECT_SNAP = 16;

// `+ 0` normalizes NEGATIVE ZERO, which `Math.floor(-0.4) * 16` produces and which is a different
// value to every equality a caller might write (`Object.is(-0, 0)` is false) even though it prints
// as "0". The attribute string would be right either way; the record's cached-value compare and the
// unit tests would not be.
function snapDown(v: number): number {
  return Math.floor(v / RECT_SNAP) * RECT_SNAP + 0;
}
function snapUp(v: number): number {
  return Math.ceil(v / RECT_SNAP) * RECT_SNAP + 0;
}

// The stage viewport in the node's local space, or null when there is nothing usable to say (a
// degenerate/non-invertible transform, or a non-finite result) — null meaning "stamp nothing", which
// leaves gsw on its `PAD_CAP` fallback rather than on a wrong budget.
//
// `gTransform` is the node's RENDERED global — the SHIFTED one (`gNodeStretched`) on a widened stage,
// because that is the matrix the element is actually placed by, and a node's own spread shift moves
// it across the field like anything else. `drawBox` is the local origin the element's matrix is baked
// at (`spreadDrawBox` / `nodeStyles`' `placementBox`): {0,0} for a particle point-anchor, which makes
// `nodeMatrix` a no-op, but taken as a parameter so this cannot silently disagree with the placement.
//
// ROTATION AND SKEW are handled by mapping all FOUR corners and taking the AABB. In local space a
// rotated viewport is a rotated quad, and its AABB is a strict superset — so the budget is generous
// rather than tight, which is the only safe direction to be wrong in (gsw floors every side at the
// old symmetric pad anyway, so a too-small rect cannot shrink a working canvas, but it can decline
// to grow one that needs it).
export function particleVisibleRect(
  gTransform: Affine,
  drawBox: { x: number; y: number },
  viewport: ParticleViewport
): LocalVisibleRect | null {
  if (!(viewport.width > 0) || !(viewport.height > 0)) {
    return null;
  }
  const inv = affineInverse(nodeMatrix(gTransform, drawBox));
  if (!inv) {
    return null; // a zero-scale (or otherwise singular) matrix: no local space to speak of
  }
  const w = viewport.width;
  const h = viewport.height;
  const x0 = inv[4];
  const y0 = inv[5];
  const x1 = inv[0] * w + x0;
  const y1 = inv[1] * w + y0;
  const x2 = inv[2] * h + x0;
  const y2 = inv[3] * h + y0;
  const x3 = inv[0] * w + inv[2] * h + x0;
  const y3 = inv[1] * w + inv[3] * h + y0;
  // LAYOUT SPACE (stageFit.ts). Everything above is DESIGN-space arithmetic — the inputs are the walk's own design
  // matrices — but the ANSWER is read by gsw in the element's own local CSS px, and on the `?stageFit=display` arm
  // that space is the design one scaled by the fit factor (the element's box is `W·S × H·S` under an unchanged
  // linear part, so one local px covers `1/S` of the design px it used to). Converting the four corners here, before
  // the snap, is what keeps the snap grid a grid in the space the attribute is actually written in — converting
  // after it would quantise to 16 DESIGN px and then land the result off-grid. A no-op factor of 1 on the default
  // arm leaves every corner, and therefore every attribute string, bit-identical.
  const minX = snapDown(px(Math.min(x0, x1, x2, x3)));
  const maxX = snapUp(px(Math.max(x0, x1, x2, x3)));
  const minY = snapDown(px(Math.min(y0, y1, y2, y3)));
  const maxY = snapUp(px(Math.max(y0, y1, y2, y3)));
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) {
    return null;
  }
  return { x: minX, y: minY, width, height };
}

/** Serialize for the attribute: `"x,y,width,height"`, which is exactly what gsw's
 *  `parseLocalVisibleRect` splits on. Integral already (the snap grid), so no formatting is needed —
 *  and an integral string is also a STABLE one, which is the point of the snap. */
export function particleVisibleRectAttr(rect: LocalVisibleRect): string {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}
