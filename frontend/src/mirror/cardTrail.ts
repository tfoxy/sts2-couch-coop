// Card-trail synthesis — the comet behind a flying card, reconstructed CLIENT-SIDE from the trail node's own
// streamed motion. Pure module (no DOM, no renderer state) so the geometry/curve math is unit-testable; the
// renderer owns the elements and calls into here.
//
// WHY SYNTHESIS AND NOT WIRE GEOMETRY
// -----------------------------------
// `card_trail_<character>.tscn` hangs two `Line2D`s off every flying card: `Trails/OuterTrail` (width 96) and
// `Trails/InnerTrail` (width 64). Their whole look is FOUR things the producer's stroke-geometry unit deliberately
// drops — a `width_curve` taper, an alpha `gradient`, a stretched `trail.png`, and an ADDITIVE material — so when
// the Aug-7 producer started streaming every Line2D's points (a TYPE-only gate) the mirror drew each trail as one
// thick solid bar. Worse, a discard→draw reshuffle spawns two GROWING strokes PER CARD, each re-marshalled and
// re-shipped whole on every changed tick. The producer is now scoped to the map quill strokes it was written for
// (spirectl's Sts2Line2DGeometryEmit), and the trail is rebuilt here from data that is ALREADY on the wire.
//
// THE ONE FACT THAT MAKES THIS EXACT
// ----------------------------------
// A trail stroke stays pinned to the world origin while the comet root moves under the card. Measured over a whole
// card flight, its streamed GLOBAL transform is the identity to within 0.01px. Two consequences, and they are the
// whole design:
//   • the node-LOCAL space the mirror renders this element in IS design/global space, so a point list can be
//     written straight into the element with no re-basing; and
//   • the head of the trail at any instant is the trail root's global origin, which the mirror already streams as
//     the parent's transform — no new wire field, no geometry, nothing.
// The renderer samples that point once per delta and this module rebuilds the ribbon around it.
//
// THE POINT RULES THE RIBBON IS BUILT ON — the shape the comet has on screen, restated as this module's model:
//   • a point is appended only once the head has moved >= 12px from the last one, so a slow card does not stack
//     points on top of each other;
//   • a jump longer than 48px is SUBDIVIDED along a quadratic through the two previous points, so a fast card
//     still gets a smooth curve instead of one long chord;
//   • a point is dropped once it is older than 0.8s — which is also what collapses the trail after the card lands,
//     tail-first, instead of leaving a streak sitting on the discard pile.
// Point 0 is therefore the OLDEST (the tail) and the last point is the head, which is the orientation Godot's
// `Line2D` samples `width_curve` / `gradient` in (both are arc-length parameterised over the point list —
// `line_builder.cpp` samples at `current_distance / total_distance`).

import type { MirrorNode } from "@/mirror/sceneTree";

// ---- the point-list constants: how long the comet is and how finely it is sampled ----------------------------

// How long a point survives, in ms. Also the trail's whole visible lifetime after the card stops moving: the
// comet collapses tail-first over this long and is then gone.
export const TRAIL_POINT_DURATION_MS = 800;

// A new point is only appended once the head moved at least this far (design px) — the spacing that keeps a slow
// card from stacking points on one spot.
export const TRAIL_MIN_SPAWN_DIST = 12;

// A longer jump than this is subdivided at this spacing, so a fast card still draws a smooth curve.
export const TRAIL_MAX_SPAWN_DIST = 48;

// A trail is worth drawing only once it has a real extent; below this the ribbon is a degenerate sliver whose
// normals are numerically meaningless anyway.
const MIN_TRAIL_LENGTH = 1;

// ---- node identification ------------------------------------------------------------------------------------

// The script class BOTH trail Line2Ds carry (`res://src/Core/Nodes/Vfx/NCardTrail.cs`). The trail scene's ROOT is
// `NCardTrailVfx` (a Node2D) — matched on the exact last dot-segment so the root can't be mistaken for a stroke.
const TRAIL_NODE_TYPE = "NCardTrail";

// The trail scene's ROOT — the comet container the flying card drags behind it. The two strokes above hang under it
// (via a `Trails` group) and its decorative branch (sparks, silhouettes) under a sibling group, so the renderer
// needs to name it to place the WHOLE comet from one element (see mirrorRenderer's trail-root drive).
const TRAIL_ROOT_NODE_TYPE = "NCardTrailVfx";

// Exact last dot-segment match: a namespaced type and a bare one read the same, and `NCardTrailVfx` can never be
// mistaken for `NCardTrail` (nor the reverse) — the two are distinct nodes with opposite roles.
function matchesTypeLeaf(type: string | null | undefined, leaf: string): boolean {
  if (type == null || type.length < leaf.length) {
    return false;
  }
  if (type.length === leaf.length) {
    return type === leaf;
  }
  return type.charCodeAt(type.length - leaf.length - 1) === 46 /* . */ && type.endsWith(leaf);
}

export function isCardTrailNode(node: Pick<MirrorNode, "nodeType">): boolean {
  return matchesTypeLeaf(node.nodeType, TRAIL_NODE_TYPE);
}

export function isCardTrailRootNode(node: Pick<MirrorNode, "nodeType">): boolean {
  return matchesTypeLeaf(node.nodeType, TRAIL_ROOT_NODE_TYPE);
}

// ---- Godot Curve / Gradient sampling --------------------------------------------------------------------------

// One authored `Curve` control point: position + the left/right bezier tangents Godot stores alongside it.
export interface CurvePoint {
  t: number;
  v: number;
  left: number;
  right: number;
}

// Godot's `Curve::sample` (scene/resources/curve.cpp): a cubic bezier between the bracketing control points whose
// inner control points sit at one third of the x-span, offset by the tangents. Implemented exactly rather than approximated
// with a straight line because the outer trail's taper leans hard on the -2.61 tangents at t=0.84.
export function sampleCurve(points: readonly CurvePoint[], t: number): number {
  if (points.length === 0) {
    return 0;
  }
  if (points.length === 1 || t <= points[0].t) {
    return points[0].v;
  }
  const last = points[points.length - 1];
  if (t >= last.t) {
    return last.v;
  }
  let i = 0;
  while (i + 1 < points.length && points[i + 1].t < t) {
    i++;
  }
  const a = points[i];
  const b = points[i + 1];
  const span = b.t - a.t;
  if (span <= 1e-9) {
    return b.v;
  }
  const local = (t - a.t) / span;
  const third = span / 3;
  const yac = a.v + third * a.right;
  const ybc = b.v - third * b.left;
  const omt = 1 - local;
  return (
    a.v * omt * omt * omt +
    yac * 3 * omt * omt * local +
    ybc * 3 * omt * local * local +
    b.v * local * local * local
  );
}

// One authored `Gradient` stop, pre-reduced to the single number the mirror needs. Godot's Line2D multiplies the
// vertex colour by the gradient colour and the material blends ADDITIVELY, so a stop's visible contribution is
// `rgb x a` — i.e. the black-to-white ramp and the alpha ramp collapse into ONE effective alpha against a white
// fill. (Both authored ramps are neutral grey, so no hue is lost in the collapse.)
export interface AlphaStop {
  t: number;
  a: number;
}

// Godot `Gradient.get_color_at_offset`: linear between stops, CLAMPED to the end stops outside the authored range.
export function sampleAlpha(stops: readonly AlphaStop[], t: number): number {
  if (stops.length === 0) {
    return 1;
  }
  if (t <= stops[0].t) {
    return stops[0].a;
  }
  const last = stops[stops.length - 1];
  if (t >= last.t) {
    return last.a;
  }
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t <= b.t) {
      const span = b.t - a.t;
      return span <= 1e-9 ? b.a : a.a + ((t - a.t) / span) * (b.a - a.a);
    }
  }
  return last.a;
}

// ---- the two authored trail profiles --------------------------------------------------------------------------

// One CROSS-SECTION band of the ribbon. The authored trails are textured (`texture_mode = 2`, STRETCH) with
// `trail.png` / `trail2.png`, both of which are PURE WHITE with a constant profile along the line and a soft alpha
// falloff ACROSS it — i.e. the texture's only contribution is a cross-section alpha curve, which is most of why a
// real trail reads as glow instead of a painted stripe. Under the ADDITIVE material that curve is matched
// exactly by STACKING nested ribbons: a point at cross-fraction v accumulates every band whose `width` covers it,
// so K bands give a K-step staircase of the authored profile (K=3 midpoint rule; measured off the PNGs).
export interface TrailBand {
  // Fraction of the ribbon's full half-width this band spans.
  width: number;
  // Alpha this band ADDS (the staircase increment, not the cumulative value).
  alpha: number;
}

export interface TrailProfile {
  // `Line2D.width` — the taper's 100% width, in design px.
  width: number;
  // `default_color.a` (the Line2D's own tint alpha). `modulate` is NOT folded in here: the mirror already applies
  // the node's modulate as element opacity + an SVG tint filter, exactly as Godot applies it.
  baseAlpha: number;
  widthCurve: readonly CurvePoint[];
  alphaStops: readonly AlphaStop[];
  bands: readonly TrailBand[];
}

// `Curve_0ojw2` — the OUTER taper, identical in all five `card_trail_*.tscn` files.
const OUTER_WIDTH_CURVE: readonly CurvePoint[] = [
  { t: 0, v: 0.111037, left: 0, right: 0 },
  { t: 0.839578, v: 0.663793, left: -2.61019, right: -2.61019 },
  { t: 0.922468, v: 0.94341, left: 0, right: 0 },
  { t: 1, v: 0.685611, left: 0, right: 0 },
];

// `Gradient_6eyfw` collapsed to rgb x a (see AlphaStop): (0,0,0,0) → (0.25 grey, 0.3059) → white opaque.
const OUTER_ALPHA_STOPS: readonly AlphaStop[] = [
  { t: 0, a: 0 },
  { t: 0.141431, a: 0.25 * 0.305882 },
  { t: 0.522463, a: 1 },
];

// `Curve_eaky7` — the INNER taper (starts at exactly 0, so the inner trail comes to a point at the tail).
const INNER_WIDTH_CURVE: readonly CurvePoint[] = [
  { t: 0, v: 0, left: 0, right: 0 },
  { t: 0.801075, v: 0.571397, left: -3.15833, right: -3.15833 },
  { t: 0.900922, v: 0.367031, left: 0, right: 0 },
  { t: 0.938291, v: 0.930834, left: 0, right: 0 },
  { t: 1, v: 0.742201, left: 0, right: 0 },
];

// `Gradient_fdg7u` — the inner ramp starts LATER (0.261), so the inner core is shorter than the outer flare.
const INNER_ALPHA_STOPS: readonly AlphaStop[] = [
  { t: 0.261231, a: 0 },
  { t: 0.647255, a: 0.25 * 0.305882 },
  { t: 0.821549, a: 1 },
];

// `trail.png` (32x32, pure white) sampled across its V axis: an almost perfectly TRIANGULAR falloff, peak 0.93 at
// the centre line, 0 at both edges. Band alphas are that profile's 3-step midpoint decomposition
// (A(5/6) = 0.101, A(1/2)-A(5/6) = 0.349, A(1/6)-A(1/2) = 0.334).
const OUTER_BANDS: readonly TrailBand[] = [
  { width: 1, alpha: 0.101 },
  { width: 2 / 3, alpha: 0.349 },
  { width: 1 / 3, alpha: 0.334 },
];

// `trail2.png` (64x64, pure white): a flatter core with a sharper shoulder — a plateau out to ~v=0.5, then a fast
// falloff. Same 3-step decomposition (0.081 / 0.645 / 0.258).
const INNER_BANDS: readonly TrailBand[] = [
  { width: 1, alpha: 0.081 },
  { width: 2 / 3, alpha: 0.645 },
  { width: 1 / 3, alpha: 0.258 },
];

const OUTER_PROFILE: TrailProfile = {
  width: 96,
  baseAlpha: 0.752941, // OuterTrail's authored default_color
  widthCurve: OUTER_WIDTH_CURVE,
  alphaStops: OUTER_ALPHA_STOPS,
  bands: OUTER_BANDS,
};

const INNER_PROFILE: TrailProfile = {
  width: 64,
  baseAlpha: 1, // InnerTrail sets no default_color → Godot's opaque white
  widthCurve: INNER_WIDTH_CURVE,
  alphaStops: INNER_ALPHA_STOPS,
  bands: INNER_BANDS,
};

// ---- merged profile for the surface diet's `single` rung -------------------------------------------------------
//
// WHAT "SINGLE" IS. Every comet is TWO strokes, and each of them is hosted in an element carrying
// `mix-blend-mode: plus-lighter` — so each is its own compositor render surface, sized to the arc it paints. The
// R15 phone bench pinned the per-frame compositing of those surfaces (AREA × COUNT) as the largest single cause of
// 3+-card flight lag, and pinned equally firmly that the paint-rate, band and point diets do NOT touch it: they
// make each surface cheaper to FILL, and the phone is not paying for the fill. The only lever that moves the term
// is fewer or smaller surfaces. `single` takes the count: ONE stroke is drawn, carrying the light both of them
// used to carry, and the other's host is left blank (a 1×1-content surface ≈ free).
//
// WHERE THE NUMBERS COME FROM. Fit at t = 0.92 — the HEAD end. Both tapers put their bulge there and both alpha
// ramps are at their plateau by then, so one cross-section stands in for the whole stretch that reads as "the
// comet". Fitting mid-trail would be wrong in a way that is easy to miss: the inner ramp is still ~0.05 at t=0.5,
// so a mid-trail fit would decide the inner trail contributes almost nothing and merge to something very close to
// the outer alone.
//
// At that section the inner's half-width is ≈ 2/3 of the outer's (29.8px against 45.3px), so the inner staircase's
// three steps — 1, 2/3, 1/3 of ITS half-width — land at 2/3, 4/9 and 2/9 of the OUTER's. Summing the two additive
// fields ring by ring in outer cross-coordinates (outer × its 0.752941 default_color, inner × 1) gives, from the
// centre line out: 1.574 / 1.316 / 1.065 / 0.420 / 0.076.
//
// Those first three are SATURATED to 1.0, and that is the load-bearing step. Two plus-lighter surfaces can pile a
// combined field past white; ONE element cannot — `fill-opacity` is capped at 1 — and the display clamps either
// way, so what the eye is shown by the pair is already the clamped field. Merging to the clamped field matches
// what is on screen, not what the arithmetic says.
//
// Area-matching the clamped field onto this profile's own three rings (boundaries at 1/3 and 2/3, weighting each
// sub-ring by its width) gives cumulative targets 0.076 / 0.613 / 1.0, i.e. per-band ADDS of 0.076 / 0.537 /
// 0.387 — which, divided by the outer's baseAlpha so they can ride the outer's `default_color` unchanged, are the
// 0.101 / 0.713 / 0.514 below.
//
// KNOWN APPROXIMATION. The merged stroke samples the OUTER alpha ramp, which starts at t=0, while the inner's
// starts at t=0.261. Mid-trail the merge is therefore slightly TOO BRIGHT — it lights the inner's contribution
// over a stretch where the real inner trail has not started yet. The RMSE harness is the judge of whether that
// reads; if it does, the retreat knob is lowering the 0.713 / 0.514 (the two bands the inner dominates), never
// touching the stops.
//
// THREE BANDS ON PURPOSE. `acquireTrailScaffold`'s pool is keyed on `paths.length === bandCount`, so a profile
// with a different band count would miss the pool on every acquire and rebuild ~10 elements per stroke — paying
// in element churn exactly where the diet is trying to save.
//
// THE OUTER STOPS, UNCHANGED, ON PURPOSE. The OUTER↔MERGED swap then rewrites no gradient stop at all: the arm
// edge is popless (the along-length ramp is bit-identical across it) and the swap is safe under the mass diet's
// stop freeze, which stops re-syncing the ramp after a stroke's first paint and would otherwise pin whichever
// ramp happened to be in force when the stroke was born.
const MERGED_BANDS: readonly TrailBand[] = [
  { width: 1, alpha: 0.101 },
  { width: 2 / 3, alpha: 0.713 },
  { width: 1 / 3, alpha: 0.514 },
];

const MERGED_PROFILE: TrailProfile = {
  width: 96,
  baseAlpha: 0.752941,
  widthCurve: OUTER_WIDTH_CURVE,
  alphaStops: OUTER_ALPHA_STOPS,
  bands: MERGED_BANDS,
};

export function mergedTrailProfile(): TrailProfile {
  return MERGED_PROFILE;
}

// The two profiles are keyed by NODE NAME because the five per-character trail scenes are byte-identical in
// everything this module needs (same curves, same gradients, same widths) and differ ONLY in `modulate` and the
// texture — and `modulate` already streams. An unrecognised name falls back to the outer (wider, softer) profile
// rather than rendering nothing.
export function trailProfile(name: string | null | undefined): TrailProfile {
  return name === "InnerTrail" ? INNER_PROFILE : OUTER_PROFILE;
}

// ---- the point list -------------------------------------------------------------------------------------------

// The ribbon's point history: positions plus the wall clock each was sampled at. Flat arrays, because one trail is
// rebuilt on every delta of a card flight and an array of {x,y,age} objects would allocate a few hundred
// short-lived objects per flying card.
export interface TrailPoints {
  // Interleaved `[x0,y0,x1,y1,…]`, OLDEST FIRST (index 0 = the tail), in the trail node's local space.
  xy: number[];
  // `spawnMs[i]` — the wall clock at which point i was appended. Same length as `xy / 2`.
  spawnMs: number[];
}

export function createTrailPoints(): TrailPoints {
  return { xy: [], spawnMs: [] };
}

// The teleport cut is a mirror rule with no counterpart on the host.
//
// A ribbon is a record of MOTION: every point in the list is somewhere the card has been, and the polygon between
// two of them asserts that the card travelled from one to the other. A stroke drawn in-engine never has to test
// that, because it samples a live node every frame. The mirror does: it sees the
// comet subtree ARRIVE on one delta — at the un-posed scene origin, before the producer has placed it — and get
// its real pose on the next one, so the first two samples are the design origin and the card, and the subdivision
// above dutifully fills the ~2100px between them with a straight band across the whole stage. (The same thing
// would happen at any other discontinuity in the head: a reparent, a re-layout, a scaffold adopted mid-life.)
//
// So: a head that arrives further away than any real motion could have carried it is a TELEPORT, and the history
// before it describes a different journey — drop it and start a new one at the new head rather than drawing the
// jump. The threshold is a third of the design width: the fastest thing that legitimately moves a head is a card
// flight (~1900 design px in ~1.4s ≈ 1360 px/s), and a trail with live points is sampled at ≥30Hz, so even a very
// long frame cannot carry a head a third of the way across the stage. Well clear of real motion, well under the
// discontinuities it exists to cut.
export const TRAIL_TELEPORT_DIST = 640;

export function isTrailTeleport(points: TrailPoints, x: number, y: number): boolean {
  const xy = points.xy;
  if (xy.length === 0) {
    return false; // an empty history has nothing to be discontinuous with
  }
  return Math.hypot(x - xy[xy.length - 2], y - xy[xy.length - 1]) > TRAIL_TELEPORT_DIST;
}

// Drop the whole history, keeping the array objects (the caller's record holds them, and a trail that teleports
// mid-flight is about to refill them immediately).
export function resetTrailPoints(points: TrailPoints): void {
  points.xy.length = 0;
  points.spawnMs.length = 0;
}

// One head sample: ignore a move under TRAIL_MIN_SPAWN_DIST; subdivide a move over TRAIL_MAX_SPAWN_DIST along the
// quadratic bezier through the previous two points and the new one; then append the new head. `nowMs` is the
// sample's wall clock, and the subdivided in-between points share it — they are all part of the same step, so they
// age out together.
//
// Returns true when anything was appended (the caller only needs to rebuild the ribbon then).
export function appendTrailPoint(points: TrailPoints, x: number, y: number, nowMs: number): boolean {
  const xy = points.xy;
  const count = xy.length / 2;
  if (count > 0) {
    const lastX = xy[xy.length - 2];
    const lastY = xy[xy.length - 1];
    const dist = Math.hypot(x - lastX, y - lastY);
    if (!(dist >= TRAIL_MIN_SPAWN_DIST)) {
      return false; // also catches NaN
    }
    if (count > 2 && dist > TRAIL_MAX_SPAWN_DIST) {
      const p0x = xy[xy.length - 4];
      const p0y = xy[xy.length - 3];
      for (let d = TRAIL_MAX_SPAWN_DIST; d < dist - TRAIL_MIN_SPAWN_DIST; d += TRAIL_MAX_SPAWN_DIST) {
        const s = 0.5 + (d / dist) * 0.5;
        const ax = p0x + (lastX - p0x) * s;
        const ay = p0y + (lastY - p0y) * s;
        const bx = lastX + (x - lastX) * s;
        const by = lastY + (y - lastY) * s;
        points.xy.push(ax + (bx - ax) * s, ay + (by - ay) * s);
        points.spawnMs.push(nowMs);
      }
    }
  }
  points.xy.push(x, y);
  points.spawnMs.push(nowMs);
  return true;
}

// The ageing half: drop every point older than the lifetime. Points are appended in time order, so the expired
// ones are always a PREFIX — one splice, never a scan of the whole list.
// Returns true when anything was dropped.
//
// `durationMs` is caller-supplied, defaulting to the full 800ms above. The surface diet's `short` rung
// shortens the ribbon by ageing its points out sooner: a shorter comet is a smaller painted arc, i.e. a smaller
// compositor surface, which is the only thing on the phone that reads as cheaper. It is a parameter rather than a
// module-level knob because both callers (the head sample and the ageing tick) must agree on it WITHIN a frame,
// and the renderer is the only thing that knows whether the diet is armed right now.
export function expireTrailPoints(
  points: TrailPoints,
  nowMs: number,
  durationMs: number = TRAIL_POINT_DURATION_MS
): boolean {
  const cutoff = nowMs - durationMs;
  let drop = 0;
  while (drop < points.spawnMs.length && points.spawnMs[drop] <= cutoff) {
    drop++;
  }
  if (drop === 0) {
    return false;
  }
  points.spawnMs.splice(0, drop);
  points.xy.splice(0, drop * 2);
  return true;
}

// When the next point will expire (wall clock), or Infinity when the trail is already empty. The renderer publishes
// this as an animation-loop deadline so a landed card's trail collapses tail-first on its own schedule instead of
// freezing at full length until the node is removed. `durationMs` must be the SAME lifetime the caller expires
// with, or the loop would wake for a point that is already gone (or park past one that is not).
export function nextTrailExpiryMs(points: TrailPoints, durationMs: number = TRAIL_POINT_DURATION_MS): number {
  return points.spawnMs.length === 0 ? Infinity : points.spawnMs[0] + durationMs;
}

// How many of the NEWEST points decimation may never drop. The head is where the eye is: the card is drawn
// there, and the authored taper puts its bulge at t≈0.92, so a chord swallowed in that stretch is the one that
// reads as the comet lagging behind its card. Four points ≈ the last two frames of a 60Hz flight.
export const TRAIL_HEAD_KEEP = 4;

// The point budget (renderQuality().maxTrailPoints; 0 = unbudgeted). The ribbon is rebuilt from EVERY point
// on every sample, so a flight's per-frame cost is linear in the list length and the count must stay bounded — but
// the LENGTH need not follow it down. Decimating the interior keeps both ends and
// thins what is between them, so the comet still spans the whole arc at the same point count. Measured against a
// full-length flight arc (1893 design px): the 32-point weak-tier budget tracks the true curve within 1.0px and
// the 48-point high-tier one within 0.4px — a fraction of a 96px-wide ribbon, i.e. length is decoupled from point
// count for nothing visible. (The mass-flight rung of 16 costs ~6px, which is the point COUNT's own limit on that
// arc, not this rule's: no 16-point polyline tracks it better than ~2px.)
//
// The victim is the interior point whose two neighbours are CLOSEST together — the point sitting in the densest
// stretch, i.e. the one contributing least shape. Removing it leaves the neighbour span the eye actually sees.
// Point 0 (the tail, and the anchor of the age expiry above) and the last TRAIL_HEAD_KEEP points are never
// candidates, which puts a floor of 1 + TRAIL_HEAD_KEEP on what any budget can reach.
//
// Returns true when anything was dropped.
export function decimateTrailPoints(points: TrailPoints, budget: number): boolean {
  if (budget <= 0) {
    return false;
  }
  const xy = points.xy;
  let dropped = false;
  while (points.spawnMs.length > budget) {
    // The last removable index: everything above it is the protected head window.
    const last = points.spawnMs.length - TRAIL_HEAD_KEEP - 1;
    if (last < 1) {
      break; // the budget is below the floor the two protected ends impose
    }
    let victim = 1;
    let shortest = Infinity;
    for (let i = 1; i <= last; i++) {
      const span = Math.hypot(xy[i * 2 + 2] - xy[i * 2 - 2], xy[i * 2 + 3] - xy[i * 2 - 1]);
      if (span < shortest) {
        shortest = span;
        victim = i;
      }
    }
    xy.splice(victim * 2, 2);
    points.spawnMs.splice(victim, 1);
    dropped = true;
  }
  return dropped;
}

// ---- one head sample, start to finish ---------------------------------------------------------------------------

/** The diet state one head sample runs under. Every field is "what is in force RIGHT NOW", resolved by the caller. */
export interface TrailPushOptions {
  // The point lifetime to age against (see `expireTrailPoints`). The caller must publish its expiry deadline
  // against this SAME number or the loop wakes for a point that is already gone.
  lifeMs: number;
  // The point budget in force; 0 = unbudgeted (see `decimateTrailPoints`).
  budget: number;
  // Minimum ms between ribbon PAINTS; 0 = ungated (the state a 1-3 card flight never leaves).
  paintMinMs?: number;
  // When this ribbon was last painted, on the same clock as `nowMs`.
  paintedAtMs?: number;
}

/** What one head sample did — every branch the caller has to react to, and nothing about how it reacts. */
export interface TrailPushResult {
  /** The head arrived somewhere no motion could have carried it, so the history before it was dropped. */
  teleported: boolean;
  /** A point was appended (the card moved at least TRAIL_MIN_SPAWN_DIST). */
  grew: boolean;
  /** At least one point aged out. */
  aged: boolean;
  /** The budget dropped at least one point. */
  trimmed: boolean;
  /** The point budget removed interior points. */
  decimated: boolean;
  /** `grew || aged || trimmed` — is the ribbon's geometry different from the one already on screen? */
  changed: boolean;
  /** Should the caller repaint NOW, or defer to the paint-rate grid? Always false when nothing changed. */
  paint: boolean;
  /** When the oldest surviving point dies, against `lifeMs` — `Infinity` for an empty history. */
  dueMs: number;
}

// THE ORDER IS THE CONTRACT. A head sample is four decisions taken in one fixed sequence, and every one of them
// depends on the one before it:
//
//   1. TELEPORT CUT — is this head continuous with the history at all? A discontinuity means the stored points
//      describe a different journey, so they go before anything is measured against them (`isTrailTeleport`).
//   2. APPEND — the spawn rules above, on whatever history survived step 1 (`appendTrailPoint`).
//   3. EXPIRE — age the list, INCLUDING the point just appended, so one clock governs the whole ribbon.
//   4. BUDGET — bound the point count on the AGED list, so a long flight cannot pay for points that were about to
//      die anyway (`decimateTrailPoints`).
//
// …and then the PAINT-RATE GATE, which is a decision about the OUTPUT and not about the geometry: the list has
// already grown either way, so a gated sample defers the draw and never drops a point. Ordering it after the
// budget is what lets the deferred paint, when it lands, draw the same ribbon this sample would have drawn.
//
// Pure so both backends run the SAME sequence: the DOM renderer feeds it from its retained record and repaints an
// SVG, the canvas one feeds it from a draw-list build and emits quads, and neither can re-order the steps by
// accident. It owns the sequencing and NOTHING else — the stats, the deadline registration and the paint itself
// stay with whoever called it.
export function pushTrailPoint(
  points: TrailPoints,
  x: number,
  y: number,
  nowMs: number,
  options: TrailPushOptions
): TrailPushResult {
  const teleported = isTrailTeleport(points, x, y);
  if (teleported) {
    resetTrailPoints(points);
  }
  const grew = appendTrailPoint(points, x, y, nowMs);
  const aged = expireTrailPoints(points, nowMs, options.lifeMs);
  const decimated = decimateTrailPoints(points, options.budget);
  const trimmed = decimated;
  const changed = grew || aged || trimmed;
  const paintMinMs = options.paintMinMs ?? 0;
  const gated = paintMinMs > 0 && nowMs - (options.paintedAtMs ?? 0) < paintMinMs;
  return {
    teleported,
    grew,
    aged,
    trimmed,
    decimated,
    changed,
    paint: changed && !gated,
    dueMs: nextTrailExpiryMs(points, options.lifeMs)
  };
}

// ---- phase probe -------------------------------------------------------------------------------------------------
//
// WHY A RIBBON CANNOT BE COMPARED WITHOUT ONE. A trail is a DECAYING record of motion: its length, its taper and
// its brightness are all functions of how long ago each point was laid down, and every point dies 800 ms after it
// was born. Two clients stopped at "the same" recorded-stream millisecond are therefore NOT showing the same
// picture unless their ribbons are also the same AGE — and nothing on either arm published an age at all. Every
// trail number was a peak or a counter, which is exactly the sort of instrument that cannot detect the problem:
// the round-4 crop comparison put a canvas ribbon at one phase of its decay beside a DOM ribbon at another and
// reported the difference as a fidelity gap.
//
// So both backends publish this, from ONE implementation, and the harness refuses to compare pixels until the two
// answers agree. It is a measurement of the point histories and nothing else — no elements, no quads, no paint.

/** One stroke's history, as the probe needs it. Both backends already hold exactly this. */
export interface TrailPhaseStroke {
  id: string;
  points: TrailPoints;
}

/** What a comet looks like RIGHT NOW, in the terms that decide whether two arms may be diffed. */
export interface TrailPhase {
  /** Strokes holding at least one live point. Zero means there is no comet on screen to compare. */
  strokes: number;
  /** Live points across all of them — the ribbon's resolution, and the first thing to diverge. */
  points: number;
  /**
   * How old the OLDEST live point is, in ms — the ribbon's phase within its own 800 ms decay, which is the
   * number the two arms have to match. `-1` when nothing is alive.
   */
  oldestAgeMs: number;
  /** …and the youngest point's age, which says how recently the card moved. `-1` when nothing is alive. */
  headAgeMs: number;
  /** The newest head across every stroke, in the stroke's own local space. `null` when nothing is alive. */
  headX: number | null;
  headY: number | null;
  /** Total polyline arc length over every live stroke, in design px — the comet's extent, blend-independent. */
  arcPx: number;
}

/**
 * Measure the phase of a set of live strokes. Pure, and shared by both backends BY IMPORT rather than by
 * restatement: a probe that each arm implemented for itself could report agreement that came from two matching
 * bugs, which is the one failure a cross-arm gate must not have.
 */
export function trailPhaseProbe(strokes: Iterable<TrailPhaseStroke>, nowMs: number): TrailPhase {
  let liveStrokes = 0;
  let points = 0;
  let oldestSpawn = Infinity;
  let newestSpawn = -Infinity;
  let headX: number | null = null;
  let headY: number | null = null;
  let arcPx = 0;
  for (const stroke of strokes) {
    const spawn = stroke.points.spawnMs;
    const n = spawn.length;
    if (n === 0) {
      continue;
    }
    liveStrokes++;
    points += n;
    if (spawn[0] < oldestSpawn) {
      oldestSpawn = spawn[0];
    }
    // THE NEWEST HEAD ACROSS THE COMET, not any one stroke's: both strokes of a comet are fed the same card
    // position, so whichever was sampled last is the one that says where the card is now.
    if (spawn[n - 1] > newestSpawn) {
      newestSpawn = spawn[n - 1];
      headX = stroke.points.xy[(n - 1) * 2];
      headY = stroke.points.xy[(n - 1) * 2 + 1];
    }
    const xy = stroke.points.xy;
    for (let i = 1; i < n; i++) {
      arcPx += Math.hypot(xy[i * 2] - xy[i * 2 - 2], xy[i * 2 + 1] - xy[i * 2 - 1]);
    }
  }
  return {
    strokes: liveStrokes,
    points,
    oldestAgeMs: liveStrokes === 0 ? -1 : nowMs - oldestSpawn,
    headAgeMs: liveStrokes === 0 ? -1 : nowMs - newestSpawn,
    headX,
    headY,
    arcPx
  };
}

// ---- the ribbon ------------------------------------------------------------------------------------------------

export interface TrailRibbon {
  // One closed tapered polygon per cross-section band (tail→head down one side, head→tail back the other),
  // WIDEST FIRST so the DOM order is back-to-front. `opacity` is the band's additive share folded with the
  // Line2D's `default_color` alpha; the shared gradient carries the along-length ramp. On a COLLAPSED stack the
  // narrowest band's share includes every dropped band, so the sum is unchanged.
  bands: Array<{ d: string; opacity: number }>;
  // `linearGradient` endpoints in the SAME user space as the paths — the tail and head points.
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  // Gradient stops (offset, opacity) against a white fill, carrying ONLY the along-length ramp. Offsets are the
  // authored arc-length stops PROJECTED onto the tail→head axis, so a curved flight puts each stop where it
  // geometrically belongs instead of where a straight-line reading of the arc length would put it.
  stops: Array<{ offset: number; opacity: number }>;
  // R15 — INSTRUMENT ONLY (`mirrorWalkStats.trailPathBboxAreaSum`); nothing here draws with it. The axis-aligned
  // box ONE band covers, in design px², i.e. the surface an SVG re-raster of this ribbon has to fill. It is the
  // centre-line extent inflated by the widest band's half-width: the widest band is the one every diet rung draws
  // (bands are widest-first and `maxBands` truncates from the back), and a flat flight would otherwise measure a
  // zero-height box for a ribbon that is plainly filling pixels. 0 for a degenerate ribbon (the null cases here
  // never return one).
  bboxArea: number;
}

// Build the ribbon for one trail. Returns null when there is nothing to draw (fewer than two points, or a
// degenerate zero-length path) — the caller blanks the path rather than leaving stale geometry up.
//
// GEOMETRY. Each point gets a half-width from the width curve sampled at its ARC-LENGTH fraction (what Godot's
// line_builder does) and a normal from the average of its adjacent segment directions (Godot's round joints;
// averaging is the standard miter-free stand-in and cannot fold the ribbon at the shallow angles a card flight
// makes). The polygon walks the +normal side tail→head and the −normal side back. Ends are FLAT because both
// authored trail scenes leave `begin_cap_mode` / `end_cap_mode` at None.
//
// `maxBands` truncates the band list (and NOTHING else). The bands are emitted WIDEST FIRST, so keeping the first
// N keeps the widest, softest ones — the ones that carry the glow read — and drops the bright narrow core.
//
// The stack's bands are a
// DECOMPOSITION of one cross-section alpha curve: what a point on the centre line ends up with is their SUM, so
// dropping bands without redistributing their alpha is not a coarser staircase, it is a dimmer trail — the outer
// profile's widest band alone is 0.101 of a stack summing 0.784, i.e. 13% of the authored brightness. Folding the
// dropped alpha into the NARROWEST KEPT band preserves that sum exactly, and puts the recovered brightness where
// the dropped bands were: a 2-band collapse then reads as the same comet drawn with a coarser cross-section,
// which is what the diet is supposed to be buying.
export function buildTrailRibbon(
  points: TrailPoints,
  profile: TrailProfile,
  maxBands?: number
): TrailRibbon | null {
  const sample = ribbonSample(points, profile);
  if (sample === null) {
    return null;
  }
  const xy = points.xy;
  const { n, arc, total, nx, ny, half, bboxArea } = sample;

  // One polygon per cross-section band, widest first (back-to-front under the additive blend).
  const bands: Array<{ d: string; opacity: number }> = [];
  const bandCount = bandCountFor(profile, maxBands);
  const carried = carriedAlpha(profile, bandCount);
  for (let bandIndex = 0; bandIndex < bandCount; bandIndex++) {
    const band = profile.bands[bandIndex];
    const alpha = bandIndex === bandCount - 1 ? band.alpha + carried : band.alpha;
    let d = "";
    for (let i = 0; i < n; i++) {
      const h = half[i] * band.width;
      d += `${i === 0 ? "M" : "L"}${r2(xy[i * 2] + nx[i] * h)} ${r2(xy[i * 2 + 1] + ny[i] * h)}`;
    }
    for (let i = n - 1; i >= 0; i--) {
      const h = half[i] * band.width;
      d += `L${r2(xy[i * 2] - nx[i] * h)} ${r2(xy[i * 2 + 1] - ny[i] * h)}`;
    }
    bands.push({ d: `${d}Z`, opacity: alpha * profile.baseAlpha });
  }

  // Project the arc-length stops onto the tail→head axis. `axisLen2 === 0` (head back on the tail) can't survive
  // the `total > MIN_TRAIL_LENGTH` gate for a real flight, but a perfect out-and-back would hit it — fall back to
  // the raw arc-length offsets rather than dividing by zero.
  const tailX = xy[0];
  const tailY = xy[1];
  const headX = xy[(n - 1) * 2];
  const headY = xy[(n - 1) * 2 + 1];
  const axisX = headX - tailX;
  const axisY = headY - tailY;
  const axisLen2 = axisX * axisX + axisY * axisY;
  const stops: Array<{ offset: number; opacity: number }> = [];
  let lastOffset = -1;
  for (const stop of profile.alphaStops) {
    const at = projectArcStop(xy, arc, total, stop.t);
    const offset =
      axisLen2 > 1e-9
        ? clamp01(((at.x - tailX) * axisX + (at.y - tailY) * axisY) / axisLen2)
        : clamp01(stop.t);
    // SVG requires non-decreasing offsets; a curve that doubles back can invert two projections.
    const monotone = offset <= lastOffset ? Math.min(1, lastOffset + 1e-4) : offset;
    lastOffset = monotone;
    // The LENGTH ramp only — `default_color` alpha and the cross-section band share ride the band paths'
    // `fill-opacity`, so the three factors multiply exactly once each (Godot: gradient x texture x default_color).
    stops.push({ offset: monotone, opacity: stop.a });
  }
  // Godot clamps a gradient outside its authored range; SVG does the same for stops inside [0,1], but the LAST
  // authored stop is often well short of 1 (0.52 outer / 0.82 inner) and its plateau must reach the head.
  if (stops.length > 0 && stops[stops.length - 1].offset < 1) {
    stops.push({ offset: 1, opacity: stops[stops.length - 1].opacity });
  }

  return { bands, x1: tailX, y1: tailY, x2: headX, y2: headY, stops, bboxArea };
}

// ---- the shared cross-section sampler ---------------------------------------------------------------------------

/** Everything both ribbon shapes are built out of, measured ONCE per point list. */
interface RibbonSample {
  n: number;
  /** Arc length at each point, and the total — the parameterisation Godot samples both ramps in. */
  arc: number[];
  total: number;
  /** Per-point unit normal (the average of the adjacent segment directions — Godot's round joints). */
  nx: number[];
  ny: number[];
  /** Per-point HALF-WIDTH at 100% band width, from the authored taper. */
  half: number[];
  /** See `TrailRibbon.bboxArea`. Instrument only. */
  bboxArea: number;
}

// The arc/normal/half-width pass, shared by the SVG ribbon and the canvas quad strip.
//
// It is extracted rather than restated on purpose: the two shapes must be the same comet drawn two ways, and the
// three things that decide where a comet's edge lands — the arc-length parameterisation, the averaged normal, and
// the taper sampled at that parameter — are exactly what a second copy would get subtly wrong. Whatever this
// returns null for, BOTH shapes decline to draw.
function ribbonSample(points: TrailPoints, profile: TrailProfile): RibbonSample | null {
  const xy = points.xy;
  const n = xy.length / 2;
  if (n < 2) {
    return null;
  }

  const arc = new Array<number>(n);
  arc[0] = 0;
  for (let i = 1; i < n; i++) {
    arc[i] = arc[i - 1] + Math.hypot(xy[i * 2] - xy[i * 2 - 2], xy[i * 2 + 1] - xy[i * 2 - 1]);
  }
  const total = arc[n - 1];
  if (!(total > MIN_TRAIL_LENGTH)) {
    return null;
  }

  // Per-point unit normal, from the average of the adjacent segment directions. The point extents ride along in
  // the same pass (see `bboxArea`) — four compares per point, and no second walk of the list.
  const nx = new Array<number>(n);
  const ny = new Array<number>(n);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xy[i * 2]);
    maxX = Math.max(maxX, xy[i * 2]);
    minY = Math.min(minY, xy[i * 2 + 1]);
    maxY = Math.max(maxY, xy[i * 2 + 1]);
    let dx = 0;
    let dy = 0;
    if (i > 0) {
      const ux = xy[i * 2] - xy[i * 2 - 2];
      const uy = xy[i * 2 + 1] - xy[i * 2 - 1];
      const len = Math.hypot(ux, uy) || 1;
      dx += ux / len;
      dy += uy / len;
    }
    if (i + 1 < n) {
      const ux = xy[i * 2 + 2] - xy[i * 2];
      const uy = xy[i * 2 + 3] - xy[i * 2 + 1];
      const len = Math.hypot(ux, uy) || 1;
      dx += ux / len;
      dy += uy / len;
    }
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      nx[i] = 0;
      ny[i] = 0;
    } else {
      // Rotate the tangent 90°: (dx,dy) → (-dy,dx).
      nx[i] = -dy / len;
      ny[i] = dx / len;
    }
  }

  const half = new Array<number>(n);
  let maxHalf = 0;
  for (let i = 0; i < n; i++) {
    half[i] = (profile.width * sampleCurve(profile.widthCurve, arc[i] / total)) / 2;
    maxHalf = Math.max(maxHalf, half[i]);
  }
  // Every vertex of the widest band is a point offset by at most `maxHalf x bands[0].width` along a UNIT normal,
  // so the centre-line box grown by that much bounds the drawn polygon on both axes. Instrument only.
  const pad = maxHalf * profile.bands[0].width;
  const bboxArea = (maxX - minX + 2 * pad) * (maxY - minY + 2 * pad);

  return { n, arc, total, nx, ny, half, bboxArea };
}

/**
 * HALF the joint fill for the seam between cells `k` and `k+1` — i.e. how far ONE of the two neighbours runs
 * past the point they share. `dvx`/`dvy` is `V_k − V_{k+1}`, their disagreement about the cross vector there.
 *
 * Projected onto the SEAM's own direction (the normalized sum of the two chords' unit directions) rather than
 * onto either neighbour's, so both sides of a joint are handed the same number — which is what makes the fill
 * symmetric about the shared point instead of leaning into whichever cell asked first. Divided by 4 because the
 * worst separation over an edge is `|ΔV·û| / 2` and each neighbour covers half of it.
 *
 * The residual, stated: the two cells then bleed along their OWN chords rather than along the seam direction,
 * so at a turn the fill is short by a factor of `cos` of the half-angle. On real flight geometry that is
 * measured in hundredths of a pixel (`trailSeamGeometry.spec`); a genuinely sharp corner is a different shape
 * of hole — a WEDGE on the outside of the turn, which is what a round joint's fan fills and which no
 * parallelogram can. Card-flight point lists do not contain those; the teleport cut is what keeps them out.
 */
function seamBleedAt(xy: readonly number[], k: number, dvx: number, dvy: number): number {
  const ax = xy[k * 2 + 2] - xy[k * 2];
  const ay = xy[k * 2 + 3] - xy[k * 2 + 1];
  const al = Math.hypot(ax, ay) || 1;
  const bx = xy[k * 2 + 4] - xy[k * 2 + 2];
  const by = xy[k * 2 + 5] - xy[k * 2 + 3];
  const bl = Math.hypot(bx, by) || 1;
  let sx = ax / al + bx / bl;
  let sy = ay / al + by / bl;
  const sl = Math.hypot(sx, sy);
  if (!(sl > 1e-9)) {
    return 0; // a perfect reversal has no seam direction to project onto
  }
  sx /= sl;
  sy /= sl;
  return Math.abs(dvx * sx + dvy * sy) / 4;
}

/**
 * The joint below which a seam quad is not worth drawing.
 *
 * A twentieth of a pixel cannot be seen and cannot be rasterised, so below it the cell keeps its un-bled edge
 * and no seam quad is pushed at all — which is what makes a straight ribbon come out with `quads.length`
 * cells and an EMPTY `seamQuads`, rather than with a hundred invisible slivers to batch.
 */
const SEAM_QUAD_MIN_PX = 0.05;

/** How many bands this call draws — `maxBands` truncates the list (widest first) and NOTHING else. */
function bandCountFor(profile: TrailProfile, maxBands?: number): number {
  return maxBands != null && maxBands > 0 ? Math.min(maxBands, profile.bands.length) : profile.bands.length;
}

/**
 * The alpha of every band a call is NOT drawing, for the narrowest one it IS to carry (see `buildTrailRibbon`'s
 * note). 0 when nothing was dropped, so the full stack is untouched by construction.
 */
function carriedAlpha(profile: TrailProfile, bandCount: number): number {
  let carried = 0;
  for (let i = bandCount; i < profile.bands.length; i++) {
    carried += profile.bands[i].alpha;
  }
  return carried;
}

// ---- the quad strip (the canvas stage's ribbon) ------------------------------------------------------------------

/**
 * One cell of the strip: an affine that maps the UNIT square onto a parallelogram, plus the alpha to fill it with.
 *
 * `m` is `[a,b,c,d,e,f]` in the trail node's LOCAL space, applied to a quad of `w = h = 1` — so corner `(u,v)`
 * lands at `(e + u·a + v·c, f + u·b + v·d)`. The caller composes the node's own placement on the left, which is
 * what makes the wide-screen spread and the view scale ride along for free.
 */
export interface TrailStripQuad {
  m: number[];
  alpha: number;
}

/**
 * The single band a TEXTURED strip draws: the ribbon's full authored width, with the whole of the Line2D's own
 * tint alpha. The cross-section is the page's job from here (see `buildTrailStrip`), so there is no share to
 * take — this is the decomposition's identity, not one of its steps.
 */
const TEXTURED_BAND: TrailBand = { width: 1, alpha: 1 };

/** A trail as the canvas stage draws it: per-band runs of parallelograms, tail→head, widest band first. */
export interface TrailStrip {
  /** In DRAW order: band 0's segments tail→head, then band 1's, and so on. */
  quads: TrailStripQuad[];
  /**
 * Joint fills, kept apart from the cells.
   *
   * A cell retreats from each interior seam, and two short quads at half alpha fill it.
   * seam is covered by two short quads at half alpha instead. They are a separate array so `quads.length` stays
   * `bands × segments` — every spec and every consumer that indexes a band's cells by `band × segments + i`
   * keeps working, and a caller that draws only `quads` draws exactly the cells.
   *
   * Same texture, same blend, same batch as the cells: a consumer draws them straight after, and they cost one
   * loop rather than one state change. Empty on a straight ribbon.
   */
  seamQuads: TrailStripQuad[];
  /**
   * Is this the TEXTURED shape (one full-width cell per segment, cross-section carried by the page) or the
   * banded staircase? The caller must texture the quads iff this is true — see `TrailStripOptions.textured`.
   */
  textured: boolean;
  /** Bands drawn (`maxBands` truncates; always 1 when `textured`). */
  bands: number;
  /** Segments per band — every band walks the same centre line, so `quads.length === bands × segments`. */
  segments: number;
  /** The centre line's tail and head, for the same use `TrailRibbon`'s gradient endpoints have. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** See `TrailRibbon.bboxArea`. Instrument only. */
  bboxArea: number;
}

/** What the strip's alpha is scaled by beyond the authored stack. See `buildTrailStrip`. */
export interface TrailStripOptions {
  /** Truncate the band list, widest first (the mass diet's collapse). */
  maxBands?: number;
  /**
   * A flat multiplier over every band's alpha, applied before the along-length ramp and clamped at 1.
   */
  alphaScale?: number;
  /**
   * Draw one full-width cell per segment and let the texture carry the cross-section, instead of
   * stacking the band staircase that stands in for it. See `buildTrailStrip`'s note; the caller must actually
   * texture the quads (a full-width band with no texture is a solid bar), which is why this is resolved per
   * stroke against a READY page and falls back to the bands when it is not.
   */
  textured?: boolean;
}

/**
 * THE CANVAS RIBBON: one QUAD per band per segment, instead of one closed polygon per band.
 *
 * WHY A STRIP AND NOT A POLYGON. The draw list has three primitives and none of them is a polygon: a quad is an
 * AFFINE RECT, so a trapezoid — which is what a tapering ribbon's every segment is — cannot be expressed as one.
 * Banding the ribbon into per-segment cells is what makes the taper expressible at all, and the cell count is
 * bounded by the point budget the flight already runs under (≤48 points ⇒ ≤141 quads per stroke per band stack).
 *
 * THE CELL, and why this one. Each cell must approximate a trapezoid with a parallelogram, and the choice is
 * WHERE to spend the error. This one keeps the CENTRE LINE EXACT — the quad's own centre line runs along the
 * chord from centre point `i` to centre point `i+1`, which is where the eye reads the comet's path — and takes
 * the average of the two cross vectors for its width. (`m = [U, V, O]` with `U` along the chord, `V` the FULL
 * averaged cross vector and `O = P_i − V/2`.)
 *
 * The cost of that choice is that two neighbours disagree about the cross vector at the point they share, which
 * opens a hole between them everywhere except on the centre line — the joint fill closes it by
 * letting each cell run past the shared point; see the note at the bleed itself for the arithmetic and for why
 * subdividing does not work. With the bleed on, `U` no longer ends exactly at `P_{i+1}`: the centre line is
 * still exactly the chord, and the cell deliberately overshoots along it.
 *
 * THE RAMP IS SAMPLED PER SEGMENT, at the segment's own ARC-LENGTH midpoint. The SVG twin projects three or four
 * authored stops onto the tail→head chord and lets the browser interpolate between them, which on a curved flight
 * puts the ramp slightly off where the arc-length parameterisation says it belongs; sampling every cell is both
 * cheaper here (no gradient element to maintain) and closer to what Godot draws. Registered as a deliberate
 * divergence from the DOM arm rather than a fix, because it is one.
 *
 * The textured shape carries the cross-section directly on this backend.
 *
 * The band stack is an APPROXIMATION of one thing: the cross-section alpha profile of the authored page, which
 * both trail images carry as a soft falloff across the ribbon and a CONSTANT along it. Stacking K nested ribbons
 * renders that profile as a K-step staircase, and the DOM arm has to, because an SVG path cannot vary its
 * fill across itself. A quad can: the cell already maps `v` from one edge of the ribbon to the other, so a
 * whole-page source rect makes GPU LINEAR sampling do the falloff exactly — `texture × premultiplied colour` is
 * Godot's `texture × gradient × default_color × modulate`, factor for factor, with no steps in it.
 *
 * So `textured` draws ONE cell per segment at FULL width and share 1. That is a real fidelity CHANGE, not a
 * refactor, and it is brighter: the 3-step decomposition sums to 0.784 of the page's peak alpha 0.933, i.e. the
 * textured core reads ~19% hotter than the staircase. That is the authored look; the staircase was the diet.
 *
 * `u` IS A NO-OP ON PURPOSE. Both pages are constant along their U axis, so mapping the full 0..1 U range onto
 * every cell samples the same column whatever the cell's arc length — which is what makes per-cell texturing
 * equivalent to Godot's STRETCH mode over the whole line, and what makes U-slicing (dividing the U range across
 * the cells) a no-op that only buys a class of off-by-one bugs.
 *
 * Returns null in exactly the cases `buildTrailRibbon` returns null — the two share `ribbonSample`.
 */
export function buildTrailStrip(
  points: TrailPoints,
  profile: TrailProfile,
  options: TrailStripOptions = {}
): TrailStrip | null {
  const sample = ribbonSample(points, profile);
  if (sample === null) {
    return null;
  }
  const xy = points.xy;
  const { n, arc, total, nx, ny, half, bboxArea } = sample;
  const textured = options.textured === true;
  const bandCount = textured ? 1 : bandCountFor(profile, options.maxBands);
  const carried = textured ? 0 : carriedAlpha(profile, bandCount);
  const alphaScale = options.alphaScale ?? 1;
  const segments = n - 1;
  const quads: TrailStripQuad[] = [];
  const seamQuads: TrailStripQuad[] = [];

  for (let bandIndex = 0; bandIndex < bandCount; bandIndex++) {
    const band = textured ? TEXTURED_BAND : profile.bands[bandIndex];
    const share = textured ? band.alpha : bandIndex === bandCount - 1 ? band.alpha + carried : band.alpha;
    // The two constant factors of Godot's `gradient × texture × default_color`, folded once per band: the band's
    // share of the cross-section and the Line2D's own tint alpha. The third factor is the ramp, per cell below.
    const bandAlpha = Math.min(1, share * profile.baseAlpha * alphaScale);
    const bw = band.width;
    /** This band's FULL cross vector for cell `i` — x then y (see the seam-bleed note). */
    const crossX = (i: number): number => nx[i] * half[i] * bw + nx[i + 1] * half[i + 1] * bw;
    const crossY = (i: number): number => ny[i] * half[i] * bw + ny[i + 1] * half[i + 1] * bw;
    for (let i = 0; i < segments; i++) {
      const x0 = xy[i * 2];
      const y0 = xy[i * 2 + 1];
      const ux = xy[i * 2 + 2] - x0;
      const uy = xy[i * 2 + 3] - y0;
      // The FULL cross vector at each end (half-width × the band's fraction of it), averaged.
      const vx = crossX(i);
      const vy = crossY(i);
      let ex = ux;
      let ey = uy;
      let ox = x0 - vx / 2;
      let oy = y0 - vy / 2;
      const ul0 = Math.hypot(ux, uy) || 1;
      const hx = ux / ul0;
      const hy = uy / ul0;
      /** This cell's own half of each interior joint (0 at the strip's flat ends, and below the split floor). */
      let tailE = 0;
      let headE = 0;
      // Two neighbours share a centre point and disagree about the cross vector there, opening a hairline gap.
      // Each cell retreats half of the measured overlap and a pair of half-alpha quads fills the seam. The ends
      // stay flat: both authored trail scenes leave their cap modes at None, so the first cell's
      // tail and the last cell's head are never extended.
      tailE = i > 0 ? seamBleedAt(xy, i - 1, crossX(i - 1) - vx, crossY(i - 1) - vy) : 0;
      headE = i + 1 < segments ? seamBleedAt(xy, i, vx - crossX(i + 1), vy - crossY(i + 1)) : 0;
      tailE = tailE > SEAM_QUAD_MIN_PX ? tailE : 0;
      headE = headE > SEAM_QUAD_MIN_PX ? headE : 0;
      // The core retreats half of each seam; separate quads below carry the join at half alpha.
      ox += (hx * tailE) / 2;
      oy += (hy * tailE) / 2;
      ex -= (hx * (tailE + headE)) / 2;
      ey -= (hy * (tailE + headE)) / 2;
      const cellAlpha = bandAlpha * sampleAlpha(profile.alphaStops, ((arc[i] + arc[i + 1]) / 2) / total);
      quads.push({ m: [ex, ey, vx, vy, ox, oy], alpha: cellAlpha });
      // One quad per end of each joint, carrying the same cross vector as its cell.
      if (tailE > 0) {
        seamQuads.push({
          m: [hx * 1.5 * tailE, hy * 1.5 * tailE, vx, vy, x0 - hx * tailE - vx / 2, y0 - hy * tailE - vy / 2],
          alpha: cellAlpha / 2
        });
      }
      if (headE > 0) {
        const px = x0 + ux;
        const py = y0 + uy;
        seamQuads.push({
          m: [
            hx * 1.5 * headE,
            hy * 1.5 * headE,
            vx,
            vy,
            px - (hx * headE) / 2 - vx / 2,
            py - (hy * headE) / 2 - vy / 2
          ],
          alpha: cellAlpha / 2
        });
      }
    }
  }

  return {
    quads,
    seamQuads,
    textured,
    bands: bandCount,
    segments,
    x1: xy[0],
    y1: xy[1],
    x2: xy[(n - 1) * 2],
    y2: xy[(n - 1) * 2 + 1],
    bboxArea
  };
}

// The point at arc-length fraction `t` along the polyline (linear within the bracketing segment).
function projectArcStop(
  xy: readonly number[],
  arc: readonly number[],
  total: number,
  t: number
): { x: number; y: number } {
  const target = clamp01(t) * total;
  const n = arc.length;
  for (let i = 1; i < n; i++) {
    if (arc[i] >= target) {
      const span = arc[i] - arc[i - 1];
      const f = span <= 1e-9 ? 0 : (target - arc[i - 1]) / span;
      return {
        x: xy[i * 2 - 2] + (xy[i * 2] - xy[i * 2 - 2]) * f,
        y: xy[i * 2 - 1] + (xy[i * 2 + 1] - xy[i * 2 - 1]) * f,
      };
    }
  }
  return { x: xy[(n - 1) * 2], y: xy[(n - 1) * 2 + 1] };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 2 dp — the same quantization the producer uses for positional wire data, and enough to keep the `d` string
// short (it is rewritten on every delta of a flight).
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}
