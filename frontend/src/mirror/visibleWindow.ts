// Computes the VISIBLE sub-rect of an effect node (shader/particle) as node-local fractions, so the runtime can
// shrink an off-screen-overflowing full-screen background's canvas to only the part inside the viewport.
//
// Why: a full-screen character-select background is a node whose box extends far past the 16:9 stage (a parallax
// backdrop). Its gsw effect <canvas> covers the WHOLE box (e.g. ~6000×3400 device px) and carries the shader's
// blend mode (additive `blend_add` → `plus-lighter`), which forces the canvas to PAINT INTO THE PARENT LAYER ON
// THE MAIN THREAD — and that paint scales with the canvas DISPLAY size, so painting the full off-screen extent
// costs ~500ms on each character change (confirmed by trace). Clamping the canvas to the visible region removes
// the off-screen pixels (and the per-frame blit shrinks too) while the shader still samples the correct portion
// via `_godot_uv_window`. See [[mirror-lowend-quality-tiers]].

import { affineInverse, nodeMatrix, type Affine } from "@/mirror/affine";
import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH, type MirrorNode } from "@/mirror/sceneTree";

/** Node-local top-left fractions [u0, v0, du, dv] of the visible sub-rect. */
export type UvWindow = [number, number, number, number];

// Only clamp when the node meaningfully overflows (shrinks by > this fraction on some axis) — avoids churning
// the attribute (and a canvas re-layout) for ordinary fully-visible nodes.
const FULL_EPS = 0.02;

// The visible sub-rect of a node as node-local [u0,v0,du,dv] fractions (visible = node box ∩ design viewport
// [0,0,viewportWidth,1080]). Returns null — meaning "use the full canvas" — when the node is ~fully visible,
// rotated or skewed (b/c ≠ 0; the AABB clamp would be wrong, and big rotated backgrounds are rare), degenerate,
// entirely off-screen, or NOT bigger than the viewport.
//
// The viewport-size gate is load-bearing: the clamp only exists to shrink full-screen BACKGROUNDS whose canvas
// would otherwise be a multi-thousand-px main-thread paint. Small nodes that merely poke past an edge (a hand
// card fanned below the screen bottom) must NOT be clamped — their canvas is already tiny, and recomputing a
// changing sub-rect every frame as they move would resize (and thus CLEAR) the shader canvas each frame, making
// an animated shader like the card_ripple glow strobe. Gating on box > viewport excludes them entirely.
// `gTransform` is the node's GLOBAL Transform2D — the renderer composes it down the walk, so it can't be read off
// `node.transform` here (that is the node-local matrix). It defaults to `node.transform` for standalone callers
// whose node has no placed parent.
// `viewportWidth` is the visible stage's design width — `MIRROR_DESIGN_WIDTH · spreadFactor` on a widened stage
// (the spread never changes the 1080 height). Clipping an oversized
// background against the hard-coded 16:9 box on a widened stage windowed its canvas to a SUB-rect of the visible
// stage — black right of design x=1920 (the UNDERDOCKS combat-room gap). Defaults to 1920, the F=1 behavior.
export function visibleUvWindow(
  node: MirrorNode,
  gTransform: Affine | null = node.transform as Affine | null,
  viewportWidth: number = MIRROR_DESIGN_WIDTH
): UvWindow | null {
  const lr = node.localRect;
  const tr = gTransform;
  if (!lr || !tr || lr.width <= 0 || lr.height <= 0) return null;
  if (Math.abs(tr[1]) > 1e-6 || Math.abs(tr[2]) > 1e-6) return null; // rotated/skewed → leave full
  // Only clamp nodes that actually exceed the viewport on some axis (the oversized backgrounds this targets).
  const boxScreenW = Math.abs(tr[0]) * lr.width;
  const boxScreenH = Math.abs(tr[3]) * lr.height;
  if (boxScreenW <= viewportWidth && boxScreenH <= MIRROR_DESIGN_HEIGHT) return null;

  const m = nodeMatrix(tr, lr);
  const inv = affineInverse(m);
  if (!inv) return null;

  // Map the viewport's opposite corners into node-local space (axis-aligned ⇒ two corners give the AABB). The
  // node's local drawing box is [0,0,w,h] (nodeMatrix folds the localRect origin into the translate).
  const lx0 = inv[0] * 0 + inv[2] * 0 + inv[4];
  const ly0 = inv[1] * 0 + inv[3] * 0 + inv[5];
  const lx1 = inv[0] * viewportWidth + inv[2] * MIRROR_DESIGN_HEIGHT + inv[4];
  const ly1 = inv[1] * viewportWidth + inv[3] * MIRROR_DESIGN_HEIGHT + inv[5];
  const vx0 = Math.min(lx0, lx1);
  const vx1 = Math.max(lx0, lx1);
  const vy0 = Math.min(ly0, ly1);
  const vy1 = Math.max(ly0, ly1);

  const ix0 = Math.max(0, vx0);
  const iy0 = Math.max(0, vy0);
  const ix1 = Math.min(lr.width, vx1);
  const iy1 = Math.min(lr.height, vy1);
  if (ix1 <= ix0 || iy1 <= iy0) return null; // entirely off-screen → leave full

  const u0 = ix0 / lr.width;
  const v0 = iy0 / lr.height;
  const du = (ix1 - ix0) / lr.width;
  const dv = (iy1 - iy0) / lr.height;
  if (u0 <= FULL_EPS && v0 <= FULL_EPS && du >= 1 - FULL_EPS && dv >= 1 - FULL_EPS) {
    return null; // ~fully visible → no clamp
  }
  return [u0, v0, du, dv];
}

/** Serialize a window for the `data-godot-*-uv-window` attribute (4-dp, the runtime parses "u0,v0,du,dv"). */
export function uvWindowAttr(w: UvWindow): string {
  return w.map((n) => Math.round(n * 1e4) / 1e4).join(",");
}
