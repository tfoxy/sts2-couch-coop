import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendTrailPoint,
  buildTrailRibbon,
  buildTrailStrip,
  createTrailPoints,
  decimateTrailPoints,
  expireTrailPoints,
  isCardTrailNode,
  nextTrailExpiryMs,
  pushTrailPoint,
  sampleAlpha,
  sampleCurve,
  trailProfile,
  TRAIL_HEAD_KEEP,
  TRAIL_MAX_SPAWN_DIST,
  TRAIL_MIN_SPAWN_DIST,
  TRAIL_POINT_DURATION_MS,
  TRAIL_TELEPORT_DIST,
  type TrailPoints
} from "@/mirror/cardTrail";
import {
  createMirrorRenderer,
  mirrorWalkStats,

  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { __setRenderQualityForTest, type RenderQuality } from "@/render/quality";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// WS4 — the comet behind a flying card, SYNTHESIZED client-side.
//
// The Aug-7 producer streamed every `Line2D`'s points on a TYPE-only gate, which made the two `NCardTrail` strokes
// behind every flying card render as thick solid bars (their look is a width_curve + gradient + stretched texture +
// additive material, none of which that unit carries) and re-marshalled two growing arrays per reshuffled card per
// tick. The producer is now scoped to the map quill strokes, and the trail is rebuilt here from data already on the
// wire: a trail stroke stays pinned to the world origin while its PARENT moves, so the head of the trail is the
// parent transform the mirror already streams.
//
// These specs pin, in the order the bugs would bite:
//   * the point rules (12px min spacing, >48px subdivision, 0.8s lifetime) — get these wrong and the
//     trail is the wrong LENGTH, which is the whole difference between a comet and a bar;
//   * the authored taper/ramp sampling (Godot Curve bezier + Gradient clamping);
//   * the ribbon geometry (tapered closed polygon, gradient along the tail→head axis);
//   * and end-to-end: a trail node with NO wire geometry still gets an element and a painted path.

describe("cardTrail — node identification", () => {
  it("matches the NCardTrail script class and nothing else", () => {
    expect(isCardTrailNode({ nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail" })).toBe(true);
    expect(isCardTrailNode({ nodeType: "NCardTrail" })).toBe(true);
  });

  it("does NOT match the trail scene's own Node2D root", () => {
    // `NCardTrailVfx` is the root that MOVES (it is the head source); mistaking it for a stroke would paint a
    // second ribbon at the card itself.
    expect(isCardTrailNode({ nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx" })).toBe(false);
  });

  it("does not match a plain Line2D or an unrelated node", () => {
    expect(isCardTrailNode({ nodeType: "Godot.Line2D" })).toBe(false);
    expect(isCardTrailNode({ nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCard" })).toBe(false);
    expect(isCardTrailNode({ nodeType: "" })).toBe(false);
  });
});

describe("cardTrail — the point rules", () => {
  it("always takes the first point", () => {
    const points = createTrailPoints();
    expect(appendTrailPoint(points, 100, 200, 0)).toBe(true);
    expect(points.xy).toEqual([100, 200]);
  });

  it("ignores a move shorter than the minimum spawn distance", () => {
    // `_minSpawnDist = 12`: a card that has barely moved must NOT lay a point, or a stationary card would grow a
    // dense zero-length trail and the arc-length parameterisation would collapse.
    const points = createTrailPoints();
    appendTrailPoint(points, 0, 0, 0);
    expect(appendTrailPoint(points, TRAIL_MIN_SPAWN_DIST - 0.5, 0, 16)).toBe(false);
    expect(points.xy).toEqual([0, 0]);
    expect(appendTrailPoint(points, TRAIL_MIN_SPAWN_DIST, 0, 32)).toBe(true);
    expect(points.xy).toEqual([0, 0, TRAIL_MIN_SPAWN_DIST, 0]);
  });

  it("subdivides a long jump once there are enough points to curve through", () => {
    // Over TRAIL_MAX_SPAWN_DIST (48px): a fast card (or a slow delta) would otherwise leave one long chord.
    // Subdivision needs >2 points already in hand, because it interpolates through the previous two.
    const points = createTrailPoints();
    appendTrailPoint(points, 0, 0, 0);
    appendTrailPoint(points, 20, 0, 10);
    appendTrailPoint(points, 40, 0, 20);
    const before = points.xy.length / 2;
    appendTrailPoint(points, 40 + TRAIL_MAX_SPAWN_DIST * 4, 0, 30);
    const added = points.xy.length / 2 - before;
    expect(added, "one head point plus the interpolated in-betweens").toBeGreaterThan(1);
    // Still monotone along the (straight) flight — a subdivision that overshoots would fold the ribbon.
    for (let i = 1; i < points.xy.length / 2; i++) {
      expect(points.xy[i * 2]).toBeGreaterThanOrEqual(points.xy[i * 2 - 2]);
    }
  });

  it("does NOT subdivide before the third point", () => {
    const points = createTrailPoints();
    appendTrailPoint(points, 0, 0, 0);
    appendTrailPoint(points, 1000, 0, 16);
    expect(points.xy.length / 2).toBe(2);
  });

  it("refuses a NaN sample rather than poisoning the path", () => {
    const points = createTrailPoints();
    appendTrailPoint(points, 0, 0, 0);
    expect(appendTrailPoint(points, Number.NaN, 0, 16)).toBe(false);
    expect(points.xy).toEqual([0, 0]);
  });
});

describe("cardTrail — ageing", () => {
  const laid = (): TrailPoints => {
    const points = createTrailPoints();
    appendTrailPoint(points, 0, 0, 1000);
    appendTrailPoint(points, 100, 0, 1400);
    appendTrailPoint(points, 200, 0, 1800);
    return points;
  };

  it("drops only the expired PREFIX", () => {
    const points = laid();
    // `_pointDuration = 0.8s`. At 1000 + 800 + ε the first point is gone and the rest stay.
    expect(expireTrailPoints(points, 1000 + TRAIL_POINT_DURATION_MS + 1)).toBe(true);
    expect(points.xy).toEqual([100, 0, 200, 0]);
    expect(points.spawnMs).toEqual([1400, 1800]);
  });

  it("reports no change when nothing has expired", () => {
    const points = laid();
    expect(expireTrailPoints(points, 1500)).toBe(false);
    expect(points.xy.length / 2).toBe(3);
  });

  it("collapses the whole trail once the card has been still for the point duration", () => {
    // THE reason this needs a clock of its own: after the card lands nothing moves, so no delta arrives — without
    // ageing the ribbon would sit at full length on the discard pile until the VFX node is removed.
    const points = laid();
    expireTrailPoints(points, 1800 + TRAIL_POINT_DURATION_MS + 1);
    expect(points.xy).toEqual([]);
    expect(nextTrailExpiryMs(points)).toBe(Infinity);
  });

  it("publishes the OLDEST point's expiry as the next deadline", () => {
    const points = laid();
    expect(nextTrailExpiryMs(points)).toBe(1000 + TRAIL_POINT_DURATION_MS);
  });

  // The surface diet's `short` rung shortens the comet by shortening the lifetime, so both halves of the
  // ageing pair take it as an argument. The default must stay 800ms exactly: every existing caller passes
  // nothing, and a drifted default would silently re-time every trail in the mirror.
  it("ages against an explicit lifetime when one is given", () => {
    const points = laid();
    // At 1799 the oldest point is 799ms old: one millisecond short of the full lifetime, four hundred past a
    // 400ms one. Same call, same clock, opposite answers — which is the whole of the `short` rung.
    expect(expireTrailPoints(points, 1799)).toBe(false);
    expect(expireTrailPoints(points, 1799, 400)).toBe(true);
    expect(points.spawnMs).toEqual([1400, 1800]);
  });

  it("publishes the deadline against that same lifetime", () => {
    const points = laid();
    expect(nextTrailExpiryMs(points, 400)).toBe(1400);
    expect(nextTrailExpiryMs(points), "…and the default is still the full 0.8s").toBe(
      1000 + TRAIL_POINT_DURATION_MS
    );
  });
});

// M3 — THE SAMPLE ORDERING, on its own. It used to live inside `mirrorRenderer.pushCardTrailPoint`, closed over
// the DOM's records and levers; the canvas stage integrates the same ribbons, so the SEQUENCE is now a pure
// function both backends run and these are the specs that stop it being re-ordered by accident.
describe("cardTrail — pushTrailPoint (the sample ordering)", () => {
  const opts = (over: Partial<Parameters<typeof pushTrailPoint>[4]> = {}) => ({
    lifeMs: TRAIL_POINT_DURATION_MS,
    budget: 0,
    ...over
  });

  it("appends, and reports the change plus the new deadline", () => {
    const points = createTrailPoints();
    const first = pushTrailPoint(points, 100, 100, 1000, opts());
    expect(first.grew).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.paint, "ungated by default — a 1-3 card flight paints every sample").toBe(true);
    expect(first.dueMs).toBe(1000 + TRAIL_POINT_DURATION_MS);
    // …and a sample under the minimum spawn distance changes nothing at all.
    const still = pushTrailPoint(points, 104, 100, 1016, opts());
    expect(still.grew).toBe(false);
    expect(still.changed).toBe(false);
    expect(still.paint, "nothing changed, so there is nothing to paint").toBe(false);
  });

  it("cuts the history BEFORE it measures against it (the teleport rule runs first)", () => {
    const points = createTrailPoints();
    pushTrailPoint(points, 0, 0, 0, opts());
    pushTrailPoint(points, 100, 0, 100, opts());
    const jump = pushTrailPoint(points, 100 + TRAIL_TELEPORT_DIST + 1, 0, 200, opts());
    expect(jump.teleported).toBe(true);
    // The whole point of ordering the cut first: nothing was subdivided across the jump, so the list holds the
    // new head ALONE rather than a band drawn across the stage.
    expect(points.xy).toEqual([100 + TRAIL_TELEPORT_DIST + 1, 0]);
    expect(jump.grew).toBe(true);
  });

  it("expires INCLUDING the point it just appended, so one clock governs the ribbon", () => {
    const points = createTrailPoints();
    pushTrailPoint(points, 0, 0, 0, opts());
    pushTrailPoint(points, 0, 100, 100, opts());
    // A sample a full lifetime later: the two old points die in the same call that adds the new one.
    const late = pushTrailPoint(points, 0, 200, 1000, opts());
    expect(late.aged).toBe(true);
    expect(points.spawnMs).toEqual([1000]);
    expect(late.dueMs).toBe(1000 + TRAIL_POINT_DURATION_MS);
  });

  it("budgets the AGED list, not the raw one", () => {
    const points = createTrailPoints();
    // Eight points, the first four of which are already older than the (short) lifetime by the last sample.
    for (let i = 0; i < 8; i++) {
      pushTrailPoint(points, i * 40, 0, i * 100, opts({ lifeMs: 400, budget: 6 }));
    }
    // Ordering: the expiry took the stale prefix first, so what is left is inside the budget and the decimator
    // never ran. Budget-before-expiry would have spent the budget on points that were about to die anyway.
    expect(points.spawnMs.length).toBeLessThanOrEqual(6);
    expect(points.spawnMs[0]).toBeGreaterThanOrEqual(700 - 400);
  });

  it("decimates the interior and reports the budget change", () => {
    const points = createTrailPoints();
    for (let i = 0; i < 12; i++) {
      pushTrailPoint(points, i * 40, 0, i * 10, opts({ budget: 6 }));
    }
    expect(points.spawnMs.length).toBe(6);
    expect(points.xy[0], "the tail remains part of the comet").toBe(0);
    const last = pushTrailPoint(points, 12 * 40, 0, 120, opts({ budget: 6 }));
    expect(last.trimmed).toBe(true);
    expect(last.decimated).toBe(true);
  });

  it("defers the PAINT without dropping the point (the paint-rate cap)", () => {
    const points = createTrailPoints();
    pushTrailPoint(points, 0, 0, 0, opts());
    const gated = pushTrailPoint(points, 0, 100, 10, opts({ paintMinMs: 33, paintedAtMs: 0 }));
    expect(gated.grew, "the geometry is exact whatever the paint rate is").toBe(true);
    expect(gated.changed).toBe(true);
    expect(gated.paint, "…but the draw waits for the grid").toBe(false);
    expect(points.spawnMs.length).toBe(2);
    // …and once the window has passed, the same sample paints.
    const due = pushTrailPoint(points, 0, 200, 40, opts({ paintMinMs: 33, paintedAtMs: 0 }));
    expect(due.paint).toBe(true);
  });
});

describe("cardTrail — authored curve/gradient sampling", () => {
  it("pins the Curve's endpoints", () => {
    const outer = trailProfile("OuterTrail");
    expect(sampleCurve(outer.widthCurve, 0)).toBeCloseTo(0.111037, 6);
    expect(sampleCurve(outer.widthCurve, 1)).toBeCloseTo(0.685611, 6);
  });

  it("clamps outside the authored range instead of extrapolating", () => {
    const outer = trailProfile("OuterTrail");
    expect(sampleCurve(outer.widthCurve, -5)).toBeCloseTo(0.111037, 6);
    expect(sampleCurve(outer.widthCurve, 12)).toBeCloseTo(0.685611, 6);
  });

  it("bulges near the head — the shape that makes it read as a comet", () => {
    // The authored taper peaks at t≈0.92 (0.943) and narrows again at the very head (0.686). A straight-line
    // reading of the control points would miss the bulge entirely.
    const outer = trailProfile("OuterTrail");
    const atPeak = sampleCurve(outer.widthCurve, 0.922468);
    expect(atPeak).toBeCloseTo(0.94341, 5);
    expect(atPeak).toBeGreaterThan(sampleCurve(outer.widthCurve, 0.5));
    expect(atPeak).toBeGreaterThan(sampleCurve(outer.widthCurve, 1));
  });

  it("fades the tail to nothing and the head to full", () => {
    const outer = trailProfile("OuterTrail");
    expect(sampleAlpha(outer.alphaStops, 0)).toBe(0);
    expect(sampleAlpha(outer.alphaStops, 1)).toBe(1);
    // Monotone through the ramp.
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const a = sampleAlpha(outer.alphaStops, t);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });

  it("keeps the inner core shorter than the outer flare", () => {
    // The inner gradient starts at 0.261 (vs 0 outer), which is what makes the bright core sit inside a longer,
    // softer flare instead of the two ribbons being the same length.
    const outer = trailProfile("OuterTrail");
    const inner = trailProfile("InnerTrail");
    expect(sampleAlpha(inner.alphaStops, 0.2)).toBe(0);
    expect(sampleAlpha(outer.alphaStops, 0.2)).toBeGreaterThan(0);
    expect(inner.width).toBe(64);
    expect(outer.width).toBe(96);
  });

  it("falls back to the outer profile for an unknown node name", () => {
    expect(trailProfile(null)).toEqual(trailProfile("OuterTrail"));
    expect(trailProfile("Whatever")).toEqual(trailProfile("OuterTrail"));
  });
});

describe("cardTrail — ribbon geometry", () => {
  const straight = (): TrailPoints => {
    const points = createTrailPoints();
    for (let i = 0; i <= 8; i++) {
      appendTrailPoint(points, i * 40, 500, i * 40);
    }
    return points;
  };

  it("draws nothing for a degenerate trail", () => {
    const empty = createTrailPoints();
    expect(buildTrailRibbon(empty, trailProfile("OuterTrail"))).toBeNull();
    appendTrailPoint(empty, 10, 10, 0);
    expect(buildTrailRibbon(empty, trailProfile("OuterTrail")), "one point is not a ribbon").toBeNull();
  });

  it("builds CLOSED polygons, not a stroked polyline", () => {
    // The taper IS the geometry: a stroked polyline (what the pre-fix wire path drew) has one width everywhere,
    // which is exactly the "thick solid bar" look this replaces.
    const ribbon = buildTrailRibbon(straight(), trailProfile("OuterTrail"))!;
    expect(ribbon.bands.length).toBe(trailProfile("OuterTrail").bands.length);
    for (const band of ribbon.bands) {
      expect(band.d.startsWith("M")).toBe(true);
      expect(band.d.endsWith("Z")).toBe(true);
    }
  });

  it("stacks the cross-section bands widest-first, inside each other", () => {
    // The trail textures are pure white with only a soft alpha falloff ACROSS the ribbon; under the additive
    // material, nested polygons render that falloff exactly. Order matters (back-to-front) and each band must
    // be strictly INSIDE the previous one, or the staircase inverts and the trail gets a hard bright rim.
    const profile = trailProfile("OuterTrail");
    const ribbon = buildTrailRibbon(straight(), profile)!;
    const spread = ribbon.bands.map(
      (band) => Math.max(...[...band.d.matchAll(/[ML]-?[\d.]+ (-?[\d.]+)/g)].map((m) => Math.abs(Number(m[1]) - 500)))
    );
    for (let i = 1; i < spread.length; i++) {
      expect(spread[i]).toBeLessThan(spread[i - 1]);
    }
    // The band alphas sum to the texture's centre-line alpha (0.78 for trail.png) times default_color.
    const total = ribbon.bands.reduce((sum, band) => sum + band.opacity, 0);
    expect(total).toBeCloseTo(0.784 * profile.baseAlpha, 2);
  });

  it("tapers: the tail is far thinner than the widest point", () => {
    const points = straight();
    const profile = trailProfile("OuterTrail");
    const ribbon = buildTrailRibbon(points, profile)!;
    // The flight is horizontal at y=500, so each side of the widest band is at 500 ± halfWidth — read the extreme
    // y of the first vertex (tail) and compare with the widest.
    const ys = [...ribbon.bands[0].d.matchAll(/[ML]-?[\d.]+ (-?[\d.]+)/g)].map((m) => Number(m[1]));
    const tailOffset = Math.abs(ys[0] - 500);
    const widest = Math.max(...ys.map((y) => Math.abs(y - 500)));
    expect(tailOffset).toBeCloseTo((profile.width * 0.111037) / 2, 1);
    expect(widest).toBeGreaterThan(tailOffset * 4);
    expect(widest).toBeLessThanOrEqual(profile.width / 2 + 0.01);
  });

  it("runs the gradient along the tail→head axis", () => {
    const points = straight();
    const ribbon = buildTrailRibbon(points, trailProfile("OuterTrail"))!;
    expect(ribbon.x1).toBe(0);
    expect(ribbon.y1).toBe(500);
    expect(ribbon.x2).toBe(320);
    expect(ribbon.y2).toBe(500);
  });

  it("emits non-decreasing stop offsets reaching 1", () => {
    // SVG requires monotone offsets, and the authored ramp's last stop (0.52 outer) must PLATEAU to the head
    // rather than letting the browser interpolate back down.
    const ribbon = buildTrailRibbon(straight(), trailProfile("OuterTrail"))!;
    let prev = -1;
    for (const stop of ribbon.stops) {
      expect(stop.offset).toBeGreaterThanOrEqual(prev);
      prev = stop.offset;
    }
    expect(ribbon.stops[ribbon.stops.length - 1].offset).toBe(1);
    expect(ribbon.stops[0].opacity).toBe(0);
  });

  it("keeps the three alpha factors on separate channels", () => {
    // Godot multiplies gradient x texture x default_color exactly once each. The shared gradient carries ONLY the
    // length ramp (so it tops out at 1); `default_color` and the cross-section share ride the band opacities.
    // Folding default_color into both would square it and darken every trail.
    const ribbon = buildTrailRibbon(straight(), trailProfile("OuterTrail"))!;
    expect(ribbon.stops[ribbon.stops.length - 1].opacity).toBe(1);
    const inner = buildTrailRibbon(straight(), trailProfile("InnerTrail"))!;
    expect(inner.bands.reduce((s, b) => s + b.opacity, 0)).toBeCloseTo(0.984, 2);
  });

  it("keeps the stops monotone on a curved flight", () => {
    // The gradient axis is a straight line but a card flies an arc; the stop offsets are PROJECTIONS onto that
    // axis, which a doubling-back curve could otherwise invert.
    const points = createTrailPoints();
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      appendTrailPoint(points, 400 + Math.cos(a) * 300, 400 + Math.sin(a) * 300, i * 40);
    }
    const ribbon = buildTrailRibbon(points, trailProfile("OuterTrail"))!;
    let prev = -1;
    for (const stop of ribbon.stops) {
      expect(stop.offset).toBeGreaterThanOrEqual(prev);
      prev = stop.offset;
    }
  });
});

// ---- collapsed stacks keep the authored alpha mass -------------------------------------------------------------
//
// `maxBands` is the mass-flight diet's cost lever: fewer polygons to build, to stringify and to write. But the
// bands are a decomposition of one cross-section alpha curve, so their SUM is what a viewer reads as the comet's
// brightness — dropping the narrow ones without their alpha turns a cheaper trail into a dim one (0.101 of 0.784
// on the one-band rung: 13%). Compensation moves the dropped alpha to the narrowest survivor, so the collapse
// costs bands and nothing else.

// M3 — THE CANVAS RIBBON. The draw list has no polygon primitive, so the same comet is drawn as per-band runs of
// parallelograms. These specs pin its current band, texture, ramp and joint contracts.
describe("cardTrail — buildTrailStrip (the canvas quad strip)", () => {
  const arcOf = (steps: Array<[number, number]>): TrailPoints => {
    const points = createTrailPoints();
    steps.forEach(([x, y], i) => appendTrailPoint(points, x, y, i * 16));
    return points;
  };

  const straight = (): TrailPoints =>
    arcOf(Array.from({ length: 9 }, (_, i) => [i * 40, 500] as [number, number]));

  // A card flight's actual shape: a wide arc across the stage, sampled at flight-like spacing.
  const curved = (): TrailPoints =>
    arcOf(
      Array.from({ length: 24 }, (_, i) => {
        const t = i / 23;
        return [200 + t * 1400, 900 - Math.sin(t * Math.PI) * 520] as [number, number];
      })
    );

  it("declines in exactly the cases the SVG ribbon declines in", () => {
    const profile = trailProfile("OuterTrail");
    const empty = createTrailPoints();
    expect(buildTrailStrip(empty, profile)).toBeNull();
    appendTrailPoint(empty, 10, 10, 0);
    expect(buildTrailStrip(empty, profile), "one point is not a ribbon on either arm").toBeNull();
    expect(buildTrailRibbon(empty, profile)).toBeNull();
    // A list with two points a fraction of a pixel apart is under MIN_TRAIL_LENGTH for both.
    const sliver = createTrailPoints();
    sliver.xy.push(0, 0, 0.4, 0);
    sliver.spawnMs.push(0, 16);
    expect(buildTrailStrip(sliver, profile)).toBeNull();
    expect(buildTrailRibbon(sliver, profile)).toBeNull();
  });

  it("emits one quad per segment per band, widest band first", () => {
    const profile = trailProfile("OuterTrail");
    const points = straight();
    const strip = buildTrailStrip(points, profile)!;
    expect(strip.bands).toBe(profile.bands.length);
    expect(strip.segments).toBe(points.spawnMs.length - 1);
    expect(strip.quads.length).toBe(strip.bands * strip.segments);
    // Widest first is what makes the DRAW order back-to-front under an additive blend, exactly as the SVG bands
    // are ordered. Compare the cross vectors of the two bands' first cells.
    const widest = Math.hypot(strip.quads[0].m[2], strip.quads[0].m[3]);
    const next = Math.hypot(strip.quads[strip.segments].m[2], strip.quads[strip.segments].m[3]);
    expect(widest).toBeGreaterThan(next);
  });

  it("samples the along-length ramp at each segment's own arc-length midpoint", () => {
    const profile = trailProfile("OuterTrail");
    const strip = buildTrailStrip(straight(), profile)!;
    // The outer ramp climbs from 0 at the tail to its plateau, so a band's cells must be non-decreasing along it
    // — and the tail cell must be far darker than the head cell.
    for (let i = 1; i < strip.segments; i++) {
      expect(strip.quads[i].alpha).toBeGreaterThanOrEqual(strip.quads[i - 1].alpha - 1e-9);
    }
    expect(strip.quads[0].alpha).toBeLessThan(strip.quads[strip.segments - 1].alpha * 0.5);
    // …and the value itself is the authored ramp times the band's own share, not an approximation of it. Nine
    // points at 40 px spacing ⇒ a 320 px arc, so segment 0's midpoint sits at arc 20, i.e. t = 0.0625.
    const band = profile.bands[0];
    expect(strip.quads[0].alpha).toBeCloseTo(
      band.alpha * profile.baseAlpha * sampleAlpha(profile.alphaStops, 20 / 320),
      9
    );
  });

  it("collapses bands and compensates exactly as the SVG ribbon does", () => {
    const profile = trailProfile("OuterTrail");
    const points = straight();
    const full = buildTrailStrip(points, profile)!;
    const collapsed = buildTrailStrip(points, profile, { maxBands: 2 })!;
    expect(collapsed.bands).toBe(2);
    // The alpha mass on the centre line is a decomposition, so a collapse must carry the dropped band's share —
    // the same claim `buildTrailRibbon` makes, read off the last band's first cell.
    const fullSum = full.quads[0].alpha + full.quads[full.segments].alpha + full.quads[2 * full.segments].alpha;
    const collapsedSum = collapsed.quads[0].alpha + collapsed.quads[collapsed.segments].alpha;
    expect(collapsedSum).toBeCloseTo(fullSum, 9);
  });

  it("applies the noblend scale BEFORE the ramp, clamped at 1", () => {
    const profile = trailProfile("OuterTrail");
    const points = straight();
    const plain = buildTrailStrip(points, profile)!;
    const scaled = buildTrailStrip(points, profile, { alphaScale: 1.3 })!;
    // At the shipped 1.3 nothing saturates, so every cell scales linearly — the diet's own claim.
    for (let i = 0; i < plain.quads.length; i++) {
      expect(scaled.quads[i].alpha).toBeCloseTo(plain.quads[i].alpha * 1.3, 9);
    }
    // The clamp is on the BAND, not on the finished cell: at a scale big enough to saturate the band, every cell
    // of it reads the ramp against 1 rather than against an alpha the fill could not express anyway.
    const hot = buildTrailStrip(points, profile, { alphaScale: 40 })!;
    const head = hot.quads[hot.segments - 1];
    expect(head.alpha).toBeCloseTo(sampleAlpha(profile.alphaStops, (300 + 320) / 2 / 320), 9);
    expect(head.alpha).toBeLessThanOrEqual(1);
  });

  // --- textured cells carry the cross-section -------------------------------------------------------------------

  it("textured: ONE full-width cell per segment, and it says so", () => {
    const profile = trailProfile("OuterTrail");
    const points = straight();
    const banded = buildTrailStrip(points, profile)!;
    const textured = buildTrailStrip(points, profile, { textured: true })!;

    expect(banded.textured).toBe(false);
    expect(textured.textured).toBe(true);
    expect(textured.bands).toBe(1);
    expect(textured.segments).toBe(banded.segments);
    expect(textured.quads.length).toBe(textured.segments);

    // FULL WIDTH: the textured cell's cross vector is the widest band's, exactly — the profile's own authored
    // half-width, with no share taken out of it. That is what makes the page's falloff land edge to edge.
    for (let i = 0; i < textured.segments; i++) {
      const t = textured.quads[i].m;
      const w = banded.quads[i].m; // band 0 is the widest
      expect(Math.hypot(t[2], t[3])).toBeCloseTo(Math.hypot(w[2], w[3]), 9);
    }
  });

  it("textured: the cell alpha is default_color x ramp, with no band share in it", () => {
    const profile = trailProfile("OuterTrail");
    const strip = buildTrailStrip(straight(), profile, { textured: true })!;
    // Nine points at 40 px ⇒ a 320 px arc; segment 0's midpoint is arc 20. The page supplies the third factor
    // (the cross-section) in the shader, so the only factors here are the Line2D's tint and the along-length ramp.
    expect(strip.quads[0].alpha).toBeCloseTo(profile.baseAlpha * sampleAlpha(profile.alphaStops, 20 / 320), 9);
  });

  it("textured: the core reads HOTTER than the staircase — the authored look, stated as a number", () => {
    const profile = trailProfile("OuterTrail");
    const points = straight();
    const banded = buildTrailStrip(points, profile)!;
    const textured = buildTrailStrip(points, profile, { textured: true })!;
    const cell = textured.segments - 1; // the head, where both ramps are at their plateau

    // What a centre-line pixel accumulates under ADD: the staircase sums its three shares, the textured ribbon
    // multiplies the page's own peak in the shader. The decomposition sums to 0.784 of a peak of 0.933 — so the
    // textured core is ~19% brighter, which is the page and not a bug.
    let stack = 0;
    for (let band = 0; band < banded.bands; band++) {
      stack += banded.quads[band * banded.segments + cell].alpha;
    }
    const PAGE_PEAK_ALPHA = 0.933;
    const texturedCore = textured.quads[cell].alpha * PAGE_PEAK_ALPHA;
    expect(texturedCore).toBeGreaterThan(stack);
    expect(texturedCore / stack).toBeCloseTo(0.933 / 0.784, 2);
  });

  it("textured: band truncation is inert — there is one band", () => {
    const profile = trailProfile("OuterTrail");
    const points = straight();
    const plain = buildTrailStrip(points, profile, { textured: true })!;
    for (const options of [{ maxBands: 2 }, { maxBands: 1 }]) {
      const other = buildTrailStrip(points, profile, { textured: true, ...options })!;
      expect(other.quads.length).toBe(plain.quads.length);
      for (let i = 0; i < plain.quads.length; i++) {
        expect(other.quads[i].alpha, JSON.stringify(options)).toBeCloseTo(plain.quads[i].alpha, 12);
      }
    }
    // …but the flat scale still rides, because that one is not about the cross-section at all.
    const scaled = buildTrailStrip(points, profile, { textured: true, alphaScale: 0.5 })!;
    expect(scaled.quads[0].alpha).toBeCloseTo(plain.quads[0].alpha * 0.5, 9);
  });

  it("textured: joint-fill quads retain their cell's cross vector", () => {
    const points = curved();
    const profile = trailProfile("OuterTrail");
    const split = buildTrailStrip(points, profile, { textured: true })!;
    for (const seam of split.seamQuads) {
      const owner = split.quads.find(
        (c) => Math.abs(c.m[2] - seam.m[2]) < 1e-9 && Math.abs(c.m[3] - seam.m[3]) < 1e-9
      );
      expect(owner).toBeDefined();
    }
  });
});

describe("cardTrail — band collapse", () => {
  const straight = (): TrailPoints => {
    const points = createTrailPoints();
    for (let i = 0; i <= 8; i++) {
      appendTrailPoint(points, i * 40, 500, i * 40);
    }
    return points;
  };
  const OUTER = trailProfile("OuterTrail");
  const AUTHORED = OUTER.bands.reduce((sum, band) => sum + band.alpha, 0); // 0.784
  const sum = (ribbon: { bands: Array<{ opacity: number }> }) =>
    ribbon.bands.reduce((total, band) => total + band.opacity, 0);

  it("keeps the authored alpha mass on a 2-band collapse", () => {
    const ribbon = buildTrailRibbon(straight(), OUTER, 2)!;
    expect(ribbon.bands).toHaveLength(2);
    expect(ribbon.bands[0].opacity, "the widest band is untouched").toBeCloseTo(0.101 * OUTER.baseAlpha, 9);
    expect(ribbon.bands[1].opacity, "the narrowest KEPT band carries 0.349 + 0.334").toBeCloseTo(
      0.683 * OUTER.baseAlpha,
      9
    );
    expect(Math.abs(sum(ribbon) - AUTHORED * OUTER.baseAlpha)).toBeLessThan(1e-6);
  });

  it("puts the WHOLE stack on the single band of the retreat rung", () => {
    const ribbon = buildTrailRibbon(straight(), OUTER, 1)!;
    expect(ribbon.bands).toHaveLength(1);
    expect(ribbon.bands[0].opacity).toBeCloseTo(AUTHORED * OUTER.baseAlpha, 9);
    expect(Math.abs(sum(ribbon) - AUTHORED * OUTER.baseAlpha)).toBeLessThan(1e-6);
  });

  it("holds for the inner profile too — the rule is the profile's own sum, not a constant", () => {
    const inner = trailProfile("InnerTrail");
    const authored = inner.bands.reduce((total, band) => total + band.alpha, 0); // 0.984
    for (const bands of [1, 2, 3]) {
      const ribbon = buildTrailRibbon(straight(), inner, bands)!;
      expect(ribbon.bands).toHaveLength(bands);
      expect(Math.abs(sum(ribbon) - authored * inner.baseAlpha), `${bands} bands`).toBeLessThan(1e-6);
    }
  });

  it("changes NOTHING about the geometry, and nothing at all with no band dropped", () => {
    // Compensation is an alpha rule: same points, same widths, same `d` — and a call that drops no band must be
    // bit-identical to the uncollapsed one, which is what keeps the common case free.
    const full = buildTrailRibbon(straight(), OUTER)!;
    const collapsed = buildTrailRibbon(straight(), OUTER, 2)!;
    expect(collapsed.bands[0].d).toBe(full.bands[0].d);
    expect(collapsed.bands[1].d).toBe(full.bands[1].d);
    expect(collapsed.stops).toEqual(full.stops);
    expect(buildTrailRibbon(straight(), OUTER, 3)).toEqual(full);
  });
});

// ---- end-to-end through the renderer ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

const xf = (tx: number, ty: number) => ({
  xAxis: { x: 1, y: 0 },
  yAxis: { x: 0, y: 1 },
  origin: { x: tx, y: ty }
});

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

// The producer streams parent-relative matrices, so the counter-transform below is the wire's real shape.
function full(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
}

function update(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!
  );
}

// The real shape: the trail ROOT carries the card's global position, and the stroke counter-transforms so its own
// GLOBAL transform stays the identity (NCardTrail pins GlobalPosition = 0 every frame). Measured against a live
// recording: the composite is the identity to within 0.01px for a whole card flight.
function flight(x: number, y: number): Raw[] {
  return [
    { id: "root", parentId: "Game", name: "CardTrailIronclad", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx", visible: true, transform: xf(x, y) },
    { id: "outer", parentId: "root", name: "OuterTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(-x, -y) }
  ];
}

function trailPath(stage: HTMLElement): SVGPathElement {
  const el = stage.querySelector('[data-node-id="outer"]');
  expect(el, "the trail node's element").not.toBeNull();
  const div = (el as HTMLElement).querySelector(".mirror-trail");
  expect(div, "the trail's .mirror-trail sub-layer").not.toBeNull();
  const path = (div as HTMLElement).querySelector("path");
  expect(path, "the trail's <path>").not.toBeNull();
  return path as SVGPathElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("cardTrail — renderer integration", () => {
  it("gives a geometry-less NCardTrail node its own element and ribbon layer", () => {
    // The producer streams NO linePoints for a trail any more, and a Line2D has no localRect — so without the
    // node-type gate this node would produce no element at all and nothing would ever paint.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(400, 300)]);
    renderer.reconcile(state);

    const path = trailPath(stage);
    expect(path.getAttribute("fill")).toMatch(/^url\(#mtrail-\d+\)$/);
    expect(path.getAttribute("stroke")).toBe("none");
  });

  it("paints a ribbon once the card has flown far enough", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(400, 300)]);
    renderer.reconcile(state);
    expect(trailPath(stage).getAttribute("d"), "one sample is not a ribbon yet").toBeNull();

    for (let i = 1; i <= 6; i++) {
      update(state, flight(400 + i * 60, 300));
      renderer.reconcile(state);
    }
    const d = trailPath(stage).getAttribute("d");
    expect(d, "the flight painted a ribbon").not.toBeNull();
    expect(d!.startsWith("M")).toBe(true);
    expect(d!.endsWith("Z")).toBe(true);
  });

  it("samples the head in the trail's OWN local space", () => {
    // The head is `nodeGlobal⁻¹ · parentGlobalOrigin`. With the stroke's world pin, that is exactly the
    // card's design-space position — and the element bakes the node matrix at local (0,0), so those
    // coordinates land in SVG user space unchanged. Getting this wrong draws the comet somewhere else entirely.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(1000, 500)]);
    renderer.reconcile(state);
    update(state, flight(1200, 500));
    renderer.reconcile(state);

    const d = trailPath(stage).getAttribute("d")!;
    const xs = [...d.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThan(900);
    expect(Math.max(...xs)).toBeLessThan(1300);
  });

  it("derives the head from current local transforms", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(1000, 500)]);
    renderer.reconcile(state);
    update(state, flight(1200, 500));
    renderer.reconcile(state);

    const d = trailPath(stage).getAttribute("d")!;
    const xs = [...d.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThan(900);
    expect(Math.max(...xs)).toBeLessThan(1300);
  });

  // R10 WS-F — WIDE SCREEN. The trail head was sampled from the card's UN-shifted 1920-space global while the card
  // itself is placed on the spread field (`renderedX = gameX · spreadFactor`), so the ribbon flew a different path
  // from the card it belongs to — diverging by `gameX·(F−1)`, up to 600 design px at the 2520 stage. The head now
  // rides the parent record's own applied `spreadDx`, i.e. exactly where the DOM put the card.
  it("R10 WS-F: the ribbon rides the card's wide-screen spread shift (same path as the flying card)", () => {
    const F = 2520 / 1920; // 1.3125 — the widest stretch
    const { stage, renderer } = harness();
    renderer.setStretch(F);
    const state = createMirrorState();
    // A purely HORIZONTAL flight: the ribbon's normals are vertical, so every path X is a sampled head X exactly.
    full(state, [ROOT, ...flight(400, 500)]);
    renderer.reconcile(state);
    for (let i = 1; i <= 6; i++) {
      update(state, flight(400 + i * 60, 500));
      renderer.reconcile(state);
    }

    const d = trailPath(stage).getAttribute("d")!;
    const xs = [...d.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
    // Tail 400 and head 760 in GAME space → 525 and 997.5 on the stage. The pre-fix ribbon spanned 400..760, i.e.
    // its head sat 237.5 design px LEFT of the card — which is what the bug looked like.
    expect(Math.min(...xs)).toBeCloseTo(400 * F, 1);
    expect(Math.max(...xs)).toBeCloseTo(760 * F, 1);
    expect(Math.max(...xs)).toBeGreaterThan(760); // not the un-shifted path any more
  });

  it("R10 WS-F: is byte-identical at 16:9 (every spread dx is 0)", () => {
    const { stage, renderer } = harness();
    renderer.setStretch(1);
    const state = createMirrorState();
    full(state, [ROOT, ...flight(400, 500)]);
    renderer.reconcile(state);
    for (let i = 1; i <= 6; i++) {
      update(state, flight(400 + i * 60, 500));
      renderer.reconcile(state);
    }
    const d = trailPath(stage).getAttribute("d")!;
    const xs = [...d.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeCloseTo(400, 6);
    expect(Math.max(...xs)).toBeCloseTo(760, 6);
  });

  it("keeps the SAME element identity across the whole flight", () => {
    // A card flight is ~20 deltas; rebuilding the svg on each one is exactly what this path must not do.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(400, 300)]);
    renderer.reconcile(state);
    const first = trailPath(stage);

    for (let i = 1; i <= 8; i++) {
      update(state, flight(400 + i * 60, 300 + i * 20));
      renderer.reconcile(state);
      expect(trailPath(stage), "the path survives every sample").toBe(first);
    }
  });

  it("REFUSES wire geometry for a trail node (no solid bar under the ribbon)", () => {
    // The scoped producer ships no `linePoints` for a trail, but an OLDER host — or one run with
    // SPIRECTL_SCENE_WATCH_LINE2D_GEOMETRY=all — still does. Stroking that array is precisely the thick solid bar
    // this feature replaces, and without the guard both would draw at once.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const withPoints = flight(400, 300);
    withPoints[1] = { ...withPoints[1], linePoints: [0, 0, 200, 100, 400, 300], lineWidth: 96 };
    full(state, [ROOT, ...withPoints]);
    renderer.reconcile(state);

    expect(stage.querySelector(".mirror-line"), "no stroked polyline for a trail").toBeNull();
    expect(stage.querySelector(".mirror-trail"), "the synthesized ribbon instead").not.toBeNull();
  });

  it("tears the trail down with its node", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(400, 300)]);
    renderer.reconcile(state);
    expect(stage.querySelector(".mirror-trail")).not.toBeNull();

    full(state, [ROOT]);
    renderer.reconcile(state);
    expect(stage.querySelector(".mirror-trail")).toBeNull();
  });
});

// THE WRITE DIET. A shuffle trace measured ~85ms of `setAttribute` on trail paths + gradient
// stops, half of it a straight duplicate (visit painted the ribbon, then the same frame's tick painted it again
// because a tail point had aged out). These pin the three levers: the coalesced repaint, the unchanged-value
// skips, and the weak-tier length cap.
describe("cardTrail — write diet (WS-P1)", () => {
  it("writes a gradient stop only when its value actually changed", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(400, 300)]);
    renderer.reconcile(state);
    for (let i = 1; i <= 4; i++) {
      update(state, flight(400 + i * 60, 300));
      renderer.reconcile(state);
    }
    const gradient = stage.querySelector("linearGradient") as SVGLinearGradientElement;
    expect(gradient).not.toBeNull();
    const stop = gradient.querySelector("stop") as SVGStopElement;
    const setAttr = vi.spyOn(stop, "setAttribute");
    // A further sample down the SAME straight flight leaves the authored ramp identical.
    update(state, flight(700, 300));
    renderer.reconcile(state);
    expect(setAttr).not.toHaveBeenCalled();
    setAttr.mockRestore();
  });

  it("coalesces the aged-tail repaint against the visit paint (and still lands it a beat later)", () => {
    // The duplicate: `visit` paints the ribbon from the new head sample, then the SAME frame's animation tick
    // paints it again because a tail point expired. The tick now defers that write until the coalescing window has
    // passed — deferred, never dropped.
    let clock = 10_000;
    let rafCb: FrameRequestCallback | null = null;
    let timers: { at: number; cb: () => void }[] = [];
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      rafCb = null;
    });
    vi.stubGlobal("setTimeout", (cb: () => void, ms?: number) => {
      timers.push({ at: clock + (ms ?? 0), cb });
      return timers.length;
    });
    vi.stubGlobal("clearTimeout", () => {});
    const runTick = (): void => {
      const due = timers.filter((t) => t.at <= clock);
      timers = timers.filter((t) => t.at > clock);
      for (const t of due) {
        t.cb();
      }
      const cb = rafCb;
      rafCb = null;
      cb?.(clock);
    };
    try {
      const { stage, renderer } = harness();
      const state = createMirrorState();
      full(state, [ROOT, ...flight(400, 300)]);
      renderer.reconcile(state);
      // A dense flight: one sample every 3ms, so the tail expires point-by-point 800ms later — which is what gives
      // the animation tick real ageing work to do in the SAME frame as a visit paint.
      for (let i = 1; i <= 20; i++) {
        clock += 3;
        update(state, flight(400 + i * 60, 300));
        renderer.reconcile(state);
      }
      // Jump past the first points' 800ms lifetime.
      clock = 10_000 + TRAIL_POINT_DURATION_MS + 5;
      const path = trailPath(stage);
      const setAttr = vi.spyOn(path, "setAttribute");

      // The visit paint for this sample (it also ages the expired prefix)…
      update(state, flight(1660, 300));
      renderer.reconcile(state);
      const afterVisit = setAttr.mock.calls.length;
      expect(afterVisit).toBeGreaterThan(0);

      // …and the tick 4ms later — with MORE tail genuinely expired — writes nothing: the ribbon on screen is one
      // 800ms-old point longer than the model for less than a frame.
      clock += 4;
      runTick();
      expect(setAttr.mock.calls.length).toBe(afterVisit);

      // Past the coalescing window the deferred repaint lands (deferred, never dropped).
      clock += 6;
      runTick();
      expect(setAttr.mock.calls.length).toBeGreaterThan(afterVisit);
      setAttr.mockRestore();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

// ---- R11 A0: the writes that were never carrying information --------------------------------------------------
//
// A line-audit of `paintCardTrail` found ~300 of the ~960 attribute writes a 30-card shuffle makes per frame were
// re-writing a value the element already had. Both cases below are ZERO visual change by construction: one value
// is a constant of the authored profile, the other is an endpoint that simply did not move.

describe("cardTrail — A0, the free writes", () => {
  it("writes each band's constant fill-opacity ONCE, at build time, not per paint", () => {
    // `band.alpha × profile.baseAlpha` has no term a repaint can change. It used to be written next to every `d`.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(400, 300)]);
    renderer.reconcile(state);

    const paths = [...stage.querySelectorAll('[data-node-id="outer"] .mirror-trail path')] as SVGPathElement[];
    expect(paths.length, "one path per authored cross-section band").toBe(3);
    const before = paths.map((p) => p.getAttribute("fill-opacity"));
    for (const value of before) {
      expect(value, "already carried by the freshly built path").not.toBeNull();
    }
    const spies = paths.map((p) => vi.spyOn(p, "setAttribute"));
    for (let i = 1; i <= 5; i++) {
      update(state, flight(400 + i * 60, 300));
      renderer.reconcile(state);
    }
    for (const spy of spies) {
      const written = spy.mock.calls.map((c) => c[0]);
      expect(written, "the ribbon really did repaint").toContain("d");
      expect(written, "…but never re-stated the profile's constant alpha").not.toContain("fill-opacity");
      spy.mockRestore();
    }
    expect(paths.map((p) => p.getAttribute("fill-opacity"))).toEqual(before);
  });

  it("re-states the band alphas when a pooled element is adopted for the OTHER profile", () => {
    // Outer and inner carry different authored band alphas. Hoisting the write out of the paint loop only stays
    // correct if the profile RE-RESOLVE writes it — otherwise an adopted element keeps the previous trail's look.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(400, 300)]);
    renderer.reconcile(state);
    const outer = [...stage.querySelectorAll('[data-node-id="outer"] .mirror-trail path')].map((p) =>
      p.getAttribute("fill-opacity")
    );

    // Same node id, renamed to the inner stroke — the shape a pooled/adopted element takes.
    update(state, [
      { id: "outer", parentId: "root", name: "InnerTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(-400, -300) }
    ]);
    renderer.reconcile(state);
    const inner = [...stage.querySelectorAll('[data-node-id="outer"] .mirror-trail path')].map((p) =>
      p.getAttribute("fill-opacity")
    );
    expect(inner).not.toEqual(outer);
    for (const value of inner) {
      expect(value).not.toBeNull();
    }
  });

  it("moves the gradient HEAD without re-writing the TAIL", () => {
    // The tail (x1,y1) only moves when the oldest point expires; the head (x2,y2) moves on every sample. One
    // combined signature rewrote all four attributes whenever either end moved.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(400, 300)]);
    renderer.reconcile(state);
    for (let i = 1; i <= 3; i++) {
      update(state, flight(400 + i * 60, 300));
      renderer.reconcile(state);
    }
    const gradient = stage.querySelector("linearGradient") as SVGLinearGradientElement;
    const spy = vi.spyOn(gradient, "setAttribute");
    // A further sample down the same flight: the head advances, nothing ages out, so the tail is where it was.
    update(state, flight(700, 300));
    renderer.reconcile(state);
    const written = spy.mock.calls.map((c) => c[0]);
    expect(written, "the head followed the card").toContain("x2");
    expect(written, "the tail did not move, so it was not written").not.toContain("x1");
    expect(written).not.toContain("y1");
    spy.mockRestore();
  });
});

// ---- arc-length budget -----------------------------------------------------------------------------------------
//
// The comet retains ~0.8s of head positions, which for a real flight is the WHOLE arc. The R10 budget above spent
// that budget on the NEWEST points and threw the rest away, so a weak-tier phone (32) drew 32 of the 36-49 points
// its arc wanted and the ribbon stopped 16-31% short of where the card had actually been — a comet with its tail
// cut off, on exactly the devices least able to hide it. The current policy removes the surplus from the
// trail's INTERIOR instead, which decouples LENGTH from POINT COUNT: same cost per sample, whole arc drawn.
//
// The measurements below are taken against a full-length flight arc (1893 design px — the canonical shuffle sweep
// widened to the full stage) sampled the way the replay samples it: the accelerating pseudo-time clock, fed
// through the same `appendTrailPoint` rules the live renderer uses.

// The flight curve, written out independently of cardFlight.ts — this suite is a fidelity check ON the curve, so
// it must not measure the implementation against itself.
const ARC_START = [140, 960];
const ARC_END = [1780, 960];
const ARC_CONTROL = [960, 120];

function arcPoint(t: number): { x: number; y: number } {
  const omt = 1 - t;
  return {
    x: omt * omt * ARC_START[0] + 2 * omt * t * ARC_CONTROL[0] + t * t * ARC_END[0],
    y: omt * omt * ARC_START[1] + 2 * omt * t * ARC_CONTROL[1] + t * t * ARC_END[1]
  };
}

// One flight's worth of head samples at `hz`, through the point rules above. The flight's clock ACCELERATES
// (`time += speed·dt; speed += accel·dt`), so the samples are dense at the tail and sparse at the head — which is
// the distribution the budget actually has to thin, and nothing like an evenly-spaced test polyline.
function flyArc(hz: number, budget: number): TrailPoints {
  const points = createTrailPoints();
  const dt = 1 / hz;
  const duration = 1.4;
  let time = 0;
  let speed = 1.18;
  let now = 0;
  while (time / duration <= 1) {
    time += speed * dt;
    speed += 2.3 * dt;
    now += dt * 1000;
    const p = arcPoint(Math.min(1, time / duration));
    appendTrailPoint(points, p.x, p.y, now);
    decimateTrailPoints(points, budget);
  }
  return points;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-12) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

// The curve parameter nearest a point — the polyline covers [t of its tail, t of its head], not all of [0,1], and
// measuring outside that span would score the sampler's start/end offsets rather than the decimation.
function nearestT(x: number, y: number): number {
  let bestT = 0;
  let best = Infinity;
  for (let s = 0; s <= 2000; s++) {
    const p = arcPoint(s / 2000);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < best) {
      best = d;
      bestT = s / 2000;
    }
  }
  return bestT;
}

/** The worst distance from the TRUE curve to the decimated polyline, in design px. */
function curveDeviation(points: TrailPoints): number {
  const n = points.xy.length / 2;
  const t0 = nearestT(points.xy[0], points.xy[1]);
  const t1 = nearestT(points.xy[(n - 1) * 2], points.xy[(n - 1) * 2 + 1]);
  let worst = 0;
  for (let s = 0; s <= 1500; s++) {
    const p = arcPoint(t0 + ((t1 - t0) * s) / 1500);
    let best = Infinity;
    for (let i = 1; i < n; i++) {
      const d = distanceToSegment(
        p.x,
        p.y,
        points.xy[i * 2 - 2],
        points.xy[i * 2 - 1],
        points.xy[i * 2],
        points.xy[i * 2 + 1]
      );
      if (d < best) {
        best = d;
      }
    }
    if (best > worst) {
      worst = best;
    }
  }
  return worst;
}

/** Total polyline length — what the comet actually spans on screen. */
function totalSpan(points: TrailPoints): number {
  let total = 0;
  for (let i = 1; i < points.xy.length / 2; i++) {
    total += Math.hypot(points.xy[i * 2] - points.xy[i * 2 - 2], points.xy[i * 2 + 1] - points.xy[i * 2 - 1]);
  }
  return total;
}

describe("cardTrail — interior decimation", () => {
  const laid = (count: number): TrailPoints => {
    const points = createTrailPoints();
    for (let i = 0; i < count; i++) {
      // Deliberately UNEVEN spacing (a real flight accelerates), so decimation has a dense stretch to prefer.
      appendTrailPoint(points, i * (TRAIL_MIN_SPAWN_DIST + i * 0.6), 0, 1000 + i * 16);
    }
    return points;
  };

  it("keeps the tail point and the newest TRAIL_HEAD_KEEP whatever the budget", () => {
    // These two ends are what the ribbon is BUILT from: point 0 anchors the gradient's tail and the age expiry,
    // and the head window is where the card is drawn and where the authored taper puts its bulge.
    const points = laid(50);
    const first = points.xy.slice(0, 2);
    const head = points.xy.slice(-TRAIL_HEAD_KEEP * 2);
    const headSpawns = points.spawnMs.slice(-TRAIL_HEAD_KEEP);
    expect(decimateTrailPoints(points, 16)).toBe(true);
    expect(points.spawnMs.length).toBe(16);
    expect(points.xy.slice(0, 2)).toEqual(first);
    expect(points.xy.slice(-TRAIL_HEAD_KEEP * 2)).toEqual(head);
    expect(points.spawnMs.slice(-TRAIL_HEAD_KEEP)).toEqual(headSpawns);
  });

  it("leaves a list that already fits (and an unbudgeted one) untouched", () => {
    const points = laid(12);
    const before = points.xy.slice();
    expect(decimateTrailPoints(points, 16)).toBe(false);
    expect(decimateTrailPoints(points, 0)).toBe(false); // 0 = unbudgeted, the full-length trail
    expect(points.xy).toEqual(before);
  });

  it("stops at the floor the protected ends impose instead of spinning", () => {
    // A budget under 1 + TRAIL_HEAD_KEEP is unreachable by construction. It must terminate at the floor, not loop.
    const points = laid(30);
    expect(decimateTrailPoints(points, 2)).toBe(true);
    expect(points.spawnMs.length).toBe(1 + TRAIL_HEAD_KEEP);
    expect(decimateTrailPoints(points, 2)).toBe(false);
  });

  it("keeps the spawn clock ordered, so the age expiry still works on the decimated list", () => {
    const points = laid(50);
    decimateTrailPoints(points, 16);
    expect(points.spawnMs.length).toBe(points.xy.length / 2);
    for (let i = 1; i < points.spawnMs.length; i++) {
      expect(points.spawnMs[i]).toBeGreaterThanOrEqual(points.spawnMs[i - 1]);
    }
    expect(nextTrailExpiryMs(points)).toBe(points.spawnMs[0] + TRAIL_POINT_DURATION_MS);
  });

  it("takes its victim from the DENSEST stretch", () => {
    // A tight cluster at the tail, then wide even steps (all inside the 12..48px spawn band, so nothing is
    // subdivided). The victim must come out of the cluster — that is the point whose neighbours are closest
    // together, i.e. the one whose removal changes the drawn shape least.
    const points = createTrailPoints();
    for (const x of [0, 14, 28, 42, 86, 130, 174, 218, 262]) {
      appendTrailPoint(points, x, 0, 1000 + points.spawnMs.length * 16);
    }
    expect(points.spawnMs.length).toBe(9);
    expect(decimateTrailPoints(points, 8)).toBe(true);
    expect(points.xy.length / 2).toBe(8);
    expect(points.xy.slice(0, 6), "the cluster lost one, the tail and the wide steps kept theirs").toEqual([
      0, 0, 28, 0, 42, 0
    ]);
  });

  it("holds the whole arc within the point budget", () => {
    const decimated = flyArc(60, 32);
    expect(decimated.xy.length / 2).toBe(32);
    expect(totalSpan(decimated) / totalSpan(flyArc(60, 0))).toBeGreaterThan(0.99);
  });

  it("tracks the true curve within 2px at the shipped budgets", () => {
    // Measured on this 1893px arc: 1.03px at the weak tier's budget of 32, 0.35px at the high tier's 48 — a fifth
    // of a design pixel per 10px of arc, on a ribbon 96px wide. LENGTH is decoupled from POINT COUNT essentially
    // for free, which is the premise of the round.
    expect(curveDeviation(flyArc(60, 32))).toBeLessThanOrEqual(2);
    expect(curveDeviation(flyArc(60, 48))).toBeLessThanOrEqual(1);
  });

  it("degrades by ERROR, not by length, at the MASS-FLIGHT budget", () => {
    // 16 points is the mass-shuffle rung (TRAIL_MASS_POINT_CAP), not a tier budget: 60 ribbons in the air for ~1s.
    // 16 points over 1893px is ~150px of chord each, and NO choice of 16 points tracks this arc to 2px — an
    // evenly-spaced 16-point polyline on the same curve still misses it by ~2px, and this rule (which must also
    // keep the tail and the head window) misses by a measured 6.3px. What matters at this rung is that the miss is
    // bounded ERROR rather than missing comet: the trail is still the length the card actually flew.
    const massed = flyArc(60, 16);
    expect(massed.xy.length / 2).toBe(16);
    expect(totalSpan(massed) / totalSpan(flyArc(60, 0))).toBeGreaterThan(0.99);
    expect(curveDeviation(massed)).toBeLessThanOrEqual(8);
  });

  it("is CADENCE-INDEPENDENT: 30Hz and 60Hz decimate to the same comet", () => {
    // A 30Hz client's raw samples are twice as far apart, which trips the >48px subdivision and gives a
    // differently-shaped point list (45 raw points against 60Hz's 48). After decimation to the same budget the two
    // must still be the same comet — otherwise the trail's length would silently track the client's frame rate.
    const at60 = flyArc(60, 32);
    const at30 = flyArc(30, 32);
    expect(at60.xy.length / 2).toBe(32);
    expect(at30.xy.length / 2).toBe(32);
    // Each cadence keeps essentially all of the length ITS OWN sampling laid…
    expect(totalSpan(at60) / totalSpan(flyArc(60, 0))).toBeGreaterThan(0.99);
    expect(totalSpan(at30) / totalSpan(flyArc(30, 0))).toBeGreaterThan(0.99);
    // …and the two agree to 1.7% (measured 0.983), which is the raw sampling's own chord-cutting, not decimation.
    expect(totalSpan(at30) / totalSpan(at60)).toBeGreaterThan(0.97);
    expect(totalSpan(at30) / totalSpan(at60)).toBeLessThan(1.03);
    // Measured 1.03px at 60Hz, 1.70px at 30Hz.
    expect(curveDeviation(at60)).toBeLessThanOrEqual(2);
    expect(curveDeviation(at30)).toBeLessThanOrEqual(2);
  });
});

// ---- interior decimation through the renderer ------------------------------------------------------------------

describe("cardTrail — interior decimation in the renderer", () => {
  // A budget small enough that a handful of samples reaches it, so the A/B is visible in ONE flight.
  const BUDGETED: RenderQuality = {
    tier: "low",
    shadersEnabled: true,
    shadersStatic: false,
    particlesEnabled: true,
    spineClipsEnabled: true,
    spineClipFps: 30,
    renderScale: 0.5,
    shaderFps: 30,
    particleFps: 30,
    maxTextureDim: 2048,
    maxTrailPoints: 8,
    staticShaderScale: 1,
    staticParticleScale: 1,
    source: "query"
  };

  // A straight rightward flight from x=400: the ribbon's normals are vertical, so the smallest path X IS the
  // trail's tail — one number tells the two policies apart.
  function flyAcross(): HTMLElement {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, ...flight(400, 300)]);
    renderer.reconcile(state);
    for (let i = 1; i <= 20; i++) {
      update(state, flight(400 + i * 60, 300));
      renderer.reconcile(state);
    }
    return stage;
  }

  const tailX = (stage: HTMLElement): number =>
    Math.min(...[...trailPath(stage).getAttribute("d")!.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1])));

  beforeEach(() => {
    __setRenderQualityForTest(BUDGETED);
    mirrorWalkStats.reset();
  });

  afterEach(() => {
    __setRenderQualityForTest(undefined);
  });

  it("holds the ribbon's tail at the flight's origin while honouring the budget", () => {
    const stage = flyAcross();
    // 20 samples 60px apart, budget 8 — and the comet still starts where the card started.
    expect(tailX(stage)).toBeCloseTo(400, 1);
    expect(mirrorWalkStats.trailPointsPeak).toBeLessThanOrEqual(8);
  });

  it("counts the samples at which the budget bit (walkStats.trailDecimations)", () => {
    flyAcross();
    // One per sample past the budget, per stroke — not one per point removed.
    expect(mirrorWalkStats.trailDecimations).toBeGreaterThan(0);
    expect(mirrorWalkStats.trailDecimations).toBeLessThanOrEqual(20);
  });

});
