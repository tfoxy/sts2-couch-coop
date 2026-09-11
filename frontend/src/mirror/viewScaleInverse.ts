// FIX 3 (R7) — Web input view-scale inverse: the TS twin of native ViewScaleInput.Remap (+ the round-5
// ViewScaleInputRegistry neighbour exemption). This is the PURE consumer half.
//
// THE BUG it fixes. The web input path is coordinate-only and view-scale BLIND. inputCapture resolves a hover/tap to
// a GAME (1920x1080) point via mapPointerToGame and sends it UN-inverted, while applyViewScalePass has VISUALLY
// enlarged the item with a CSS transform. So a hover over the ENLARGED "halo" resolves to the halo's game point —
// for an ancient-event option (bottomCenter pivot ⇒ grows UP, plus the dialogue lift) that point sits in the
// gap/dialogue ABOVE the option's true rect, so the game hit-tests nothing and the option never focuses. Native has
// had the coordinate inverse since round 5 (InputRouter.ToDesign → ViewScaler.InverseRemap): for a point inside an
// enlarged item's ScaledBox (and not on an un-scaled neighbour overlay) map it back to the item's TRUE (un-scaled)
// game coordinate so the hit-test lands. Points outside every ScaledBox are returned unchanged.
//
// THE FORWARD/INVERSE MATH. applyViewScalePass applies, in DESIGN space, `p = P + k·(q − P) + C` (pivot P, factor k,
// clamp offset C) — see mirrorRenderer's mDesign compose. So the exact inverse is `q = P + (p − C − P)/k` (twin of
// native ViewScale.InverseMapPoint). The ScaledBox is that forward map applied to the item's PRE-scale box.
//
// SPACE. The channel/boxes here are already GAME space (1920). The renderer builds them from its widened-design
// `viewScaleStamps` by subtracting the item's spread shift from X (the clamp offset + Y carry unchanged — the
// applied on-screen clamp is exactly what the visual displacement folded, so inverting with the SAME offset is
// exact); see mirrorRenderer.buildViewScaleInputStamps. inputCapture applies remapViewScaleInverse to the game point
// mapPointerToGame already resolved.
//
// EXEMPTION (ported from ViewScaleInputRegistry). A point inside a stamp's ScaledBox is left as identity (belongs to
// an un-scaled overlay) iff a NEIGHBOUR rect contains it AND (the stamp is a GROUP — its scaled interior children are
// their own hit surfaces — OR the point is OUTSIDE the item's own pre-scale box, i.e. in the halo band). A neighbour
// is an un-scaled surface drawn ON TOP of the scaled item (a TopBar deck/gold/settings button over the ~full-viewport
// card-reward group), never an ancestor / full-viewport backdrop / the group's own scaled children. The renderer
// does the neighbour SELECTION (it owns the node tree + interactive rects); this module only tests containment.
//
// RENDERED-BOX GUARD (the wide-screen FALSE HALO). The web runs the inverse LAST — mapPointerToGame (+ near-miss)
// resolves a GAME point first, and only then is that point tested against the stamps. On a WIDER-than-16:9 stage
// that ordering can invent a halo hit: beside the enlarged item there is no `data-paints` painter to anchor the map,
// so mapPointerToGame falls back to the uniform SQUEEZE (`designX·1920/designW`), which drops the centred content's
// spread shift (dx). The squeezed game X can land inside the stamp's ScaledBox even though the pointer was nowhere
// near the item ON SCREEN — and the inverse then contracts it onto an option row the user never pointed at (a hover
// beside an ancient-event option focused/activated it). So a stamp may only claim a point when the RAW pointer's
// WIDENED-DESIGN position is inside the stamp's ON-STAGE rendered box: `renderedBox` = ScaledBox shifted by +spreadDx
// on X (Y is never spread). At 16:9 dx === 0 ⇒ renderedBox has the same geometry as ScaledBox ⇒ provably a no-op.
//
// WHY NATIVE (`src/CouchCoop.MirrorProtocol/Input/ViewScaleInput.cs`, InputRouter.cs:420-432) NEEDS NO TWIN: native
// feeds InverseRemap the RAW design point (ToDesign's letterbox-inverse of the physical pointer) and tests it against
// spread-FOLDED boxes, i.e. its containment test is ALREADY raw-vs-rendered. The web keeps its inverse-last ordering
// (the near-miss pass and the frozen-affine drag replay both need the resolved game point) and recovers the same
// semantics with this extra raw-vs-renderedBox gate. `renderedBox` is therefore WEB-ONLY by construction — do not
// port it to the native stamp.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only (the renderer + inputCapture consume it).

// A design/game-space axis-aligned bounding box in min/max form (the native DesignAabb shape — handier for the
// containment/overlap tests than the {x,y,w,h} TipAabb the renderer measures with).
export interface ViewScaleAabb {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// A centre-pivot scale CHANNEL as the inverse sees it (twin of native HoverTipScaleMath.Stamp): scale `k` about
// (pivotX, pivotY) then translate by (offsetX, offsetY) — the exact forward applyViewScalePass applies.
export interface ViewScaleChannel {
  pivotX: number;
  pivotY: number;
  k: number;
  offsetX: number;
  offsetY: number;
}

// One applied view-scale stamp as the input gate sees it (twin of native ViewScaleInput.Stamp): the channel (for the
// inverse), the enlarged box the pointer is tested against (ScaledBox), the item's PRE-scale box (OriginalBox — an
// item-stamp's own face always remaps), whether the stamp is a whole-screen GROUP, and the un-scaled neighbour
// overlays sitting in the halo (a point on one is left as identity). All GAME space.
export interface ViewScaleInputStamp {
  channel: ViewScaleChannel;
  scaledBox: ViewScaleAabb;
  originalBox: ViewScaleAabb;
  // For a nested ITEM this is its true face after every enclosing stamp, but before this item's OWN
  // enlargement. An overlay covering that face must not steal the item's inverse; testing OriginalBox there
  // would be wrong because an enclosing group has already moved/scaled the face. Top-level stamps leave this
  // equal to OriginalBox. Optional only so older hand-built test/probe stamps retain their exact behaviour.
  ownUnscaledBox?: ViewScaleAabb;
  isGroup: boolean;
  neighborRects: ViewScaleAabb[];
  // WEB-ONLY (no native twin — see the header): the stamp's ON-STAGE box in WIDENED-DESIGN space, i.e. `scaledBox`
  // shifted by +spreadDx on X (Y carries — Y is never spread). The RAW pointer's widened-design position is tested
  // against this before the stamp may remap, so a squeeze-mapped game point from BESIDE the item can't fake a halo
  // hit. Identical to `scaledBox` on 16:9 (dx === 0). Absent ⇒ the guard is inert (pre-guard behaviour).
  renderedBox?: ViewScaleAabb;
}

// Lockstep with NearMiss.StageBandFraction / pointerMap's 0.95 backdrop-demote threshold: a rect covering at least
// this fraction of the design width is a full-stage bar/backdrop, never a per-widget neighbour.
export const VIEW_SCALE_STAGE_BAND_FRACTION = 0.95;

// Enclosure comparison epsilon (design px) — a rect within this of enclosing the stamp's pre-scale box on every side
// counts as enclosing (a backdrop measured a fraction of a px inside still encloses).
export const VIEW_SCALE_ENCLOSURE_EPS = 0.5;

export function aabbContains(b: ViewScaleAabb, x: number, y: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

export function aabbOverlaps(a: ViewScaleAabb, b: ViewScaleAabb): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

// Rule 2 (twin of ViewScaleInputRegistry.EnclosesDesignBox): `candidate` encloses `inner` on every side (± eps).
// Tested against the stamp's PRE-scale box on purpose (a 1920x1080 backdrop does not enclose the enlarged ScaledBox).
export function aabbEncloses(candidate: ViewScaleAabb, inner: ViewScaleAabb, eps = VIEW_SCALE_ENCLOSURE_EPS): boolean {
  return (
    candidate.minX <= inner.minX + eps &&
    candidate.minY <= inner.minY + eps &&
    candidate.maxX >= inner.maxX - eps &&
    candidate.maxY >= inner.maxY - eps
  );
}

// Rule 3 (twin of ViewScaleInputRegistry.IsStageBand): `candidate`'s horizontal extent is ≥ the stage-band fraction
// of `designWidth` (a full-stage bar/backdrop can't speak for a specific widget under the pointer).
export function aabbIsStageBand(candidate: ViewScaleAabb, designWidth: number): boolean {
  return candidate.maxX - candidate.minX >= VIEW_SCALE_STAGE_BAND_FRACTION * designWidth;
}

// Forward-map an AABB through a channel (twin of ViewScaleInputRegistry.ScaledBox): scale about the pivot, add the
// clamp offset. The renderer uses this to derive a stamp's ScaledBox from its pre-scale box.
export function viewScaleForwardBox(box: ViewScaleAabb, c: ViewScaleChannel): ViewScaleAabb {
  return {
    minX: c.pivotX + c.k * (box.minX - c.pivotX) + c.offsetX,
    minY: c.pivotY + c.k * (box.minY - c.pivotY) + c.offsetY,
    maxX: c.pivotX + c.k * (box.maxX - c.pivotX) + c.offsetX,
    maxY: c.pivotY + c.k * (box.maxY - c.pivotY) + c.offsetY
  };
}

// The exact inverse of a view-scale stamp (twin of native ViewScale.InverseMapPoint): given a point `p` that landed
// on the ENLARGED item, return the TRUE (un-scaled) coordinate. Forward `p = P + k·(q − P) + C` ⇒ `q = P + (p − C − P)/k`.
export function viewScaleInverseMapPoint(c: ViewScaleChannel, px: number, py: number): { x: number; y: number } {
  if (c.k === 0) {
    return { x: px, y: py };
  }
  return {
    x: c.pivotX + (px - c.offsetX - c.pivotX) / c.k,
    y: c.pivotY + (py - c.offsetY - c.pivotY) / c.k
  };
}

// A point is exempt from a stamp's inverse remap (twin of ViewScaleInput.IsExempt) iff a NEIGHBOUR rect contains it
// AND the point is not on the item's own face: for a GROUP every interior point is a candidate; for an ITEM only a
// point OUTSIDE its pre-scale box (in the halo band) qualifies — a point on the item's own face always remaps.
function isExempt(s: ViewScaleInputStamp, x: number, y: number): boolean {
  if (!s.isGroup && aabbContains(s.ownUnscaledBox ?? s.originalBox, x, y)) {
    return false;
  }
  for (const nb of s.neighborRects) {
    if (aabbContains(nb, x, y)) {
      return true;
    }
  }
  return false;
}

// Un-map a GAME-space pointer landed on an enlarged view-scale item back to its TRUE coordinate (twin of
// ViewScaleInput.Remap). Iterates topmost-first (paint order, topmost LAST); the first stamp whose ScaledBox
// contains the point wins: EXEMPT → identity (belongs to an un-scaled neighbour), else the centre-pivot inverse.
// Identity when no stamp contains the point (byte-identical to the no-view-scale path). `gateEnabled=false` disables
// the exemption (every contained point remaps — the pre-round-5 behaviour).
//
// `raw` is the pointer's WIDENED-DESIGN position (pre-map, pre-near-miss). When supplied AND the stamp carries a
// `renderedBox`, a stamp may only claim the point if the RAW pointer was inside the stamp's ON-STAGE box — the
// false-halo guard (see the header). Omitting `raw`, or a stamp without `renderedBox`, leaves behaviour EXACTLY as
// it was before the guard existed.
export function remapViewScaleInverse(
  x: number,
  y: number,
  stamps: readonly ViewScaleInputStamp[],
  gateEnabled = true,
  raw?: { x: number; y: number }
): { x: number; y: number } {
  const claimed = claimViewScaleStamp(x, y, stamps, raw);
  if (claimed === null) {
    return { x, y };
  }
  if (gateEnabled && isExempt(claimed, x, y)) {
    return { x, y }; // on an un-scaled neighbour in this halo → the game hit-tests it in place
  }
  return viewScaleInverseMapPoint(claimed.channel, x, y);
}

// WHICH stamp owns a point (topmost-first, same order + same false-halo guard remapViewScaleInverse applies), or null
// when no stamp claims it. Split out of remapViewScaleInverse — which is now a thin wrapper — so a caller can FREEZE
// the claim: inputCapture decides the view-scale question ONCE at a gesture's press and replays that decision on every
// held drag-motion frame, instead of re-testing the whole live registry per frame. Re-testing is what let a stamp
// appear (or vanish) UNDER a held drag and step the sent coordinate by tens of design px in one frame — see
// inputCapture's frozenViewScaleStamps.
export function claimViewScaleStamp(
  x: number,
  y: number,
  stamps: readonly ViewScaleInputStamp[],
  raw?: { x: number; y: number }
): ViewScaleInputStamp | null {
  for (let i = stamps.length - 1; i >= 0; i--) {
    const s = stamps[i];
    if (!aabbContains(s.scaledBox, x, y)) {
      continue;
    }
    // FALSE-HALO GUARD: the pointer was not actually over this stamp's rendered box on the widened stage — the
    // squeeze fallback merely mapped it into the ScaledBox. `continue` (not return): a LOWER overlapping stamp
    // whose renderedBox DOES contain the raw pointer is still allowed to claim the point.
    if (raw && s.renderedBox && !aabbContains(s.renderedBox, raw.x, raw.y)) {
      continue;
    }
    return s;
  }
  return null;
}
