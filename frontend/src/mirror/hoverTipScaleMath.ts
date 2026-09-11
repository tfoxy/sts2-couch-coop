// HoverTip-set 1.2× enlargement geometry (WEB port of the native HoverTipScaleMath).
//
// STS2 renders a card/creature/relic tooltip as a `NHoverTipSet` whose direct children are the tip's content
// blocks (a text panel, a card, a creature card, …). The mirror enlarges the whole set 1.2× so it reads on a
// phone, but a naive scale-about-center drifts the tip off the thing it points at and can push it off screen.
// This module chooses an ANCHOR PIVOT (the enlargement grows AWAY from the pointed-at edge) plus a clamp OFFSET
// that keeps the scaled union inside the design viewport. Pure geometry over design-space AABBs — no DOM — so it
// can be unit-tested against the SAME vectors the native side uses, keeping both clients pixel-identical.
//
// All coordinates are DESIGN space (game 1920×1080). `designW` is passed in because a widened (wider-than-16:9)
// stage renders at designW > 1920; the right-edge "hug" band and the horizontal clamp both scale with it. The
// vertical viewport is a fixed 1080.

export const HOVER_TIP_SCALE = 1.2; // k — the enlargement factor (must match native)
export const HOVER_TIP_EDGE_THRESHOLD = 48; // bottom "edge-hug" band, design px (must match native)
export const HOVER_TIP_DESIGN_HEIGHT = 1080; // design viewport height (must match native)
export const HOVER_TIP_SIDE_GAP = 12; // R5 non-overlap gap enforced between a scaled tip and its owner (must match native)

// The semantic thing a HoverTip points at (its anchor owner), driving which side the 1.2× enlargement grows toward
// (#17/#18). Twin of native HoverTipScaleMath.TipOwnerKind. "none" (the default) grows RIGHT unless that overflows
// the right viewport edge, then flips to grow LEFT.
export type TipOwnerKind = "none" | "handCard" | "creature" | "rewardItem" | "cardReward";

// A design-space axis-aligned bounding box (top-left + size).
export interface TipAabb {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Resolve a HoverTip's owner KIND from the anchor-owner node's TYPE LEAF (+ owning scene file fallback) — twin of
// native HoverTipScaleMath.ResolveOwnerKind. The KIND only picks which SIDE an enlarged tip grows toward, from the
// anchor owners observed carrying a tip on screen: any card-holder (hand cards + card rewards) → grow RIGHT;
// NCreature → grow LEFT; NRewardButton → grow LEFT; everything else (map legend, HUD, merchant, relics, …) → none
// (grow right, flip left on overflow).
export function resolveTipOwnerKind(ownerTypeLeaf: string | null, ownerSceneFile: string | null): TipOwnerKind {
  if (ownerTypeLeaf) {
    if (ownerTypeLeaf.endsWith("CardHolder")) return "handCard";
    if (ownerTypeLeaf === "NCreature") return "creature";
    if (ownerTypeLeaf === "NRewardButton") return "rewardItem";
  }
  if (ownerSceneFile && ownerSceneFile.endsWith("reward_button.tscn")) return "rewardItem";
  return "none";
}

// The stamp the renderer applies: scale by HOVER_TIP_SCALE about (pivotX, pivotY), then translate by
// (offsetX, offsetY) to clamp the scaled union back inside the viewport.
export interface TipScaleResult {
  pivotX: number;
  pivotY: number;
  offsetX: number;
  offsetY: number;
}

// Choose the pivot + clamp offset for a tip set from its paint-bearing direct-child AABBs. `owner` is the tip's
// anchor-owner design AABB (the card/creature/button the tip points at) when known — the R4 defect was a creature
// tip growing down+right INTO its own HP bar because the pivot chased the screen edge, not the anchored content.
//   (a) TWO horizontally-disjoint child columns (the hand-card "straddle": a text panel on one side, the card on
//       the other) → pivot X at the inner-gap midpoint, pivot Y at the union's top, so the tip grows outward
//       symmetrically from the gap the card points through.
//   (b) a single block → pivot X keyed by the OWNER KIND (#17/#18): handCard/cardReward → union LEFT edge (grow
//       RIGHT); creature/rewardItem → union RIGHT edge (grow LEFT); none → grow RIGHT (LEFT edge) unless the scaled
//       right edge would overflow the viewport (`MinX + k·(MaxX−MinX) > designW`), then flip to the RIGHT edge (grow
//       LEFT — the map-legend fix). Pivot Y grows UP (MaxY) by default — STS2 anchored content (HP bars at a
//       creature's feet, the hand, buttons) sits at/below a tooltip's level — REVERSING to grow down (MinY) only when
//       a KNOWN owner sits clearly ABOVE the tip; with no owner it falls back to the bottom-hug screen-edge rule.
//   (c) no paint-bearing children → null (no stamp).
// The scaled union is finally clamped into [0, designW] × [0, 1080]; a union taller/wider than the viewport pins
// to the top/left edge (fitting both edges is impossible).
export function computeHoverTipScale(
  children: readonly TipAabb[],
  designW: number,
  owner?: TipAabb | null,
  ownerKind: TipOwnerKind = "none",
  ownerFollowX = 0,
  ownerFollowY = 0
): TipScaleResult | null {
  if (children.length === 0) {
    return null; // (c) no paint → no stamp
  }

  // Union AABB across every paint-bearing child.
  let uMinX = Infinity;
  let uMinY = Infinity;
  let uMaxX = -Infinity;
  let uMaxY = -Infinity;
  for (const c of children) {
    if (c.x < uMinX) uMinX = c.x;
    if (c.y < uMinY) uMinY = c.y;
    if (c.x + c.w > uMaxX) uMaxX = c.x + c.w;
    if (c.y + c.h > uMaxY) uMaxY = c.y + c.h;
  }

  const clusters = mergeXClusters(children);
  const k = HOVER_TIP_SCALE;
  const designH = HOVER_TIP_DESIGN_HEIGHT;

  const straddle = clusters.length === 2;
  let pivotX: number;
  let pivotY: number;
  if (straddle) {
    // (a) straddle: anchor at the inner-gap midpoint / union top. Kind does not override this.
    pivotX = (clusters[0].maxX + clusters[1].minX) / 2;
    pivotY = uMinY;
  } else {
    // (b) single block: pivot X keyed by the owner kind (independent of the owner box, used only for the vertical).
    pivotX = pivotXForKind(ownerKind, uMinX, uMaxX, k, designW);
    if (owner) {
      const ownerCy = owner.y + owner.h / 2;
      pivotY = ownerCy < uMinY ? uMinY : uMaxY; // known owner clearly above the tip → grow down; else grow up
    } else {
      pivotY = uMaxY >= designH - HOVER_TIP_EDGE_THRESHOLD ? uMaxY : uMinY;
    }
  }

  // Scale the union about the pivot, then clamp back into the viewport.
  const sMinX = pivotX + k * (uMinX - pivotX);
  const sMaxX = pivotX + k * (uMaxX - pivotX);
  const sMinY = pivotY + k * (uMinY - pivotY);
  const sMaxY = pivotY + k * (uMaxY - pivotY);

  // R5 owner-follow (item 6): translate the whole tip by the view-scaled owner's mapped-minus-raw centre.
  let offsetX = clampAxis(sMinX, sMaxX, designW) + ownerFollowX;
  let offsetY = clampAxis(sMinY, sMaxY, designH) + ownerFollowY;

  // R5 non-overlap invariant (item 5): push a SINGLE-BLOCK tip off its owner (straddle untouched).
  if (!straddle && owner) {
    const u = { minX: uMinX, minY: uMinY, maxX: uMaxX, maxY: uMaxY };
    [offsetX, offsetY] = applySideClamp(u, pivotX, pivotY, k, offsetX, offsetY, owner, ownerKind, designW, designH);
  }

  return { pivotX, pivotY, offsetX, offsetY };
}

// Push the scaled tip box off its owner (item 5 — twin of native HoverTipScaleMath.ApplySideClamp). Preferred side by
// kind (handCard/cardReward/none → RIGHT; creature/rewardItem → LEFT); on overlap with inflate(owner, SideGap) the tip
// translates to the preferred side (+SideGap), flipping on viewport overflow, vertical-falling-back when neither side
// fits, then re-clamped on-screen — one deterministic retry on re-overlap. `owner` is (x,y,w,h); `u` is min/max union.
function applySideClamp(
  u: { minX: number; minY: number; maxX: number; maxY: number },
  px: number,
  py: number,
  k: number,
  cx: number,
  cy: number,
  owner: TipAabb,
  kind: TipOwnerKind,
  w: number,
  h: number
): [number, number] {
  const scaled = (addX: number, addY: number) => ({
    minX: px + k * (u.minX - px) + addX,
    minY: py + k * (u.minY - py) + addY,
    maxX: px + k * (u.maxX - px) + addX,
    maxY: py + k * (u.maxY - py) + addY
  });
  const oMinX = owner.x;
  const oMinY = owner.y;
  const oMaxX = owner.x + owner.w;
  const oMaxY = owner.y + owner.h;
  const g = HOVER_TIP_SIDE_GAP;
  const overlaps = (s: { minX: number; minY: number; maxX: number; maxY: number }) =>
    s.minX <= oMaxX + g && oMinX - g <= s.maxX && s.minY <= oMaxY + g && oMinY - g <= s.maxY;
  const preferRight = kind === "handCard" || kind === "cardReward" || kind === "none";

  for (let attempt = 0; attempt < 2; attempt++) {
    const s = scaled(cx, cy);
    if (!overlaps(s)) {
      break;
    }
    const toRight = oMaxX + g - s.minX; // tip's LEFT edge → SideGap right of owner
    const toLeft = oMinX - g - s.maxX; // tip's RIGHT edge → SideGap left of owner
    const first = preferRight ? toRight : toLeft;
    const second = preferRight ? toLeft : toRight;
    const sFirst = scaled(cx + first, cy);
    const sSecond = scaled(cx + second, cy);
    if (sFirst.minX >= 0 && sFirst.maxX <= w) {
      cx += first;
    } else if (sSecond.minX >= 0 && sSecond.maxX <= w) {
      cx += second;
    } else {
      const up = oMinY - g - s.maxY; // tip's BOTTOM edge → SideGap above owner
      const down = oMaxY + g - s.minY; // tip's TOP edge → SideGap below owner
      const sUp = scaled(cx, cy + up);
      const sDown = scaled(cx, cy + down);
      if (sUp.minY >= 0 && sUp.maxY <= h) {
        cy += up;
      } else if (sDown.minY >= 0 && sDown.maxY <= h) {
        cy += down;
      }
    }
    const after = scaled(cx, cy);
    cx += clampAxis(after.minX, after.maxX, w);
    cy += clampAxis(after.minY, after.maxY, h);
  }
  return [cx, cy];
}

// R7/R9 (WS-G2): the anchor a view-scale GROUP stamp grows FROM — twin of native HoverTipScaleMath.AnchorPivot.
// R8 (WS-1) adds the two CORNER pivots — the first whose pivot X is NOT the box centre. A screen-CORNER widget must
// grow INWARD from the corner the game anchored it to: "bottomLeft" pins the bottom-LEFT corner (draw pile at
// (15,985)), "bottomRight" pins the bottom-RIGHT corner (discard pile at (1826,985); the map legend, whose right edge
// already sits at 1996 > 1920 by design, so a centre pivot + the on-screen clamp would drag the panel ~110px left).
// R9 (WS-B) adds the EDGE pivot "middleRight": pivot X at the box's RIGHT edge but pivot Y still at the box CENTRE, so
// a SIDE-anchored (not corner-anchored) widget grows LEFT and splays symmetrically up/down. The combat EXHAUST pile
// sits mid-right at (1830,800)-(1910,880) — right-anchored like the discard pile but not in a corner, so pinning its
// bottom would push the whole enlargement upward off its own row.
export type ScalePivot = "center" | "topCenter" | "bottomCenter" | "bottomLeft" | "bottomRight" | "middleRight";

// A CENTRE-pivot scale stamp (#19 general view-scale — twin of native HoverTipScaleMath.ComputeCenterStamp): scale
// `box` by `k` about its own centre, then clamp the scaled box back inside [0,designW]×[0,designH]. Reuses the SAME
// clampAxis channel as the HoverTip pivot stamp. Null for a degenerate box.
export function computeCenterScaleStamp(
  box: TipAabb,
  k: number,
  designW: number,
  designH: number = HOVER_TIP_DESIGN_HEIGHT
): TipScaleResult | null {
  return computeAnchoredScaleStamp(box, k, designW, designH, "center");
}

// R7/R9 (WS-G2) generalization — twin of native HoverTipScaleMath.ComputeAnchoredStamp: scale `box` by `k` about a
// per-PIVOT anchor (center / topCenter / bottomCenter keep pivot X at the box centre; the R8 corner pivots
// bottomLeft / bottomRight move it to the box's left / right edge), add a design-space TRANSLATE into the clamp
// channel BEFORE the on-screen clamp, then clamp the translated+scaled box on-screen. A pure translate
// (k=1) carries via the clamp channel (the ancient-event dialogue lift). Null for a degenerate box.
// R4-round4 noClamp: when true the on-screen clamp is SKIPPED (offset carries only the requested translate). The
// card-reward container (a full-viewport box scaled >1) corner-pins under the clamp; an unclamped centre scale crops a
// symmetric border instead and keeps the interior on-screen. A per-card 1.15 uses noClamp too (exact centre scale).
// The (pivotX, pivotY) a ScalePivot anchors at — the exact twin of the native `px`/`py` switches in
// HoverTipScaleMath.ComputeAnchoredStamp. Deliberately an EXHAUSTIVE switch with a declared return type rather than
// the ternary chain it replaced: a ternary chain silently absorbs a missed pivot into its "centre" fallback arm, so
// adding a pivot to ScalePivot (or to the native enum) could diverge the two clients with no compile error. With this
// shape, an unhandled member makes the function fall off its end → TS2366 at the `vue-tsc` gate.
function pivotAnchor(box: TipAabb, pivot: ScalePivot): [number, number] {
  switch (pivot) {
    case "center":
      return [box.x + box.w / 2, box.y + box.h / 2];
    case "topCenter":
      return [box.x + box.w / 2, box.y]; // pin top, grow down
    case "bottomCenter":
      return [box.x + box.w / 2, box.y + box.h]; // pin bottom, grow up
    case "bottomLeft":
      return [box.x, box.y + box.h]; // pin the bottom-LEFT corner
    case "bottomRight":
      return [box.x + box.w, box.y + box.h]; // pin the bottom-RIGHT corner
    case "middleRight":
      // R9: pin the RIGHT edge only — vertical growth stays symmetric about the box centre (a side-anchored widget
      // has no pinned bottom, unlike the two corner pivots above).
      return [box.x + box.w, box.y + box.h / 2];
  }
}

export function computeAnchoredScaleStamp(
  box: TipAabb,
  k: number,
  designW: number,
  designH: number = HOVER_TIP_DESIGN_HEIGHT,
  pivot: ScalePivot = "center",
  translateX = 0,
  translateY = 0,
  noClamp = false
): TipScaleResult | null {
  if (box.w <= 0 || box.h <= 0) {
    return null;
  }
  const [pivotX, pivotY] = pivotAnchor(box, pivot);
  const sMinX = pivotX + k * (box.x - pivotX);
  const sMaxX = pivotX + k * (box.x + box.w - pivotX);
  const sMinY = pivotY + k * (box.y - pivotY);
  const sMaxY = pivotY + k * (box.y + box.h - pivotY);
  return {
    pivotX,
    pivotY,
    offsetX: noClamp ? translateX : translateX + clampAxis(sMinX + translateX, sMaxX + translateX, designW),
    offsetY: noClamp ? translateY : translateY + clampAxis(sMinY + translateY, sMaxY + translateY, designH)
  };
}

// WS-shopfix (P4 shop phantom) — twin of native DesignAabb.FullyOutside(width, height, margin=0): true when `box`
// has NO overlap at all with the design rect [0,designW]×[0,designH]. A node can be visible==true yet PARKED
// entirely off-stage (e.g. the closed shop's SlotsContainer sitting at local y≈−1000); applyViewScalePass must
// reject such a box BEFORE computing a stamp, or the stamp's on-screen clamp drags the parked box fully into view
// (the phantom). A box that still overlaps the design rect — even partially, near an edge — is NOT rejected; the
// normal clamp continues to handle that case.
export function boxFullyOutsideDesign(box: TipAabb, designW: number, designH: number = HOVER_TIP_DESIGN_HEIGHT): boolean {
  return box.x + box.w < 0 || box.x > designW || box.y + box.h < 0 || box.y > designH;
}

// The translation that pulls the interval [min, max] back inside [0, viewport]. An interval LARGER than the
// viewport can't fit both edges, so it pins to the MIN edge (0) — the "taller than viewport → pin top" rule and
// its horizontal twin.
function clampAxis(min: number, max: number, viewport: number): number {
  if (max - min > viewport) {
    return -min; // larger than the viewport → pin the top/left edge to 0
  }
  if (min < 0) {
    return -min; // off the top/left → push in
  }
  if (max > viewport) {
    return viewport - max; // off the bottom/right → push in
  }
  return 0;
}

// Pivot-X by owner kind (#17/#18 — twin of native HoverTipScaleMath.PivotX). handCard/cardReward grow RIGHT (pivot
// the union LEFT edge); creature/rewardItem grow LEFT (pivot the RIGHT edge); none grows RIGHT unless the scaled
// right edge would overflow the viewport, then flips to grow LEFT.
function pivotXForKind(kind: TipOwnerKind, minX: number, maxX: number, k: number, designW: number): number {
  switch (kind) {
    case "handCard":
    case "cardReward":
      return minX;
    case "creature":
    case "rewardItem":
      return maxX;
    default:
      return minX + k * (maxX - minX) > designW ? maxX : minX;
  }
}

interface XCluster {
  minX: number;
  maxX: number;
}

// Merge the children's horizontal [x, x+w] intervals (sorted, overlap-merged) into disjoint clusters. Exactly
// two clusters is the hand-card straddle; anything else (one multi-line block, or 3+ disjoint pieces) is treated
// as a single block by the caller.
function mergeXClusters(children: readonly TipAabb[]): XCluster[] {
  const intervals = children.map((c) => ({ minX: c.x, maxX: c.x + c.w })).sort((a, b) => a.minX - b.minX);
  const out: XCluster[] = [];
  for (const iv of intervals) {
    const last = out[out.length - 1];
    if (last && iv.minX <= last.maxX) {
      if (iv.maxX > last.maxX) {
        last.maxX = iv.maxX;
      }
    } else {
      out.push({ minX: iv.minX, maxX: iv.maxX });
    }
  }
  return out;
}
