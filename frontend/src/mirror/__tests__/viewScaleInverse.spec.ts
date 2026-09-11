import { describe, expect, it } from "vitest";

import {
  aabbContains,
  aabbEncloses,
  aabbIsStageBand,
  aabbOverlaps,
  remapViewScaleInverse,
  viewScaleForwardBox,
  viewScaleInverseMapPoint,
  type ViewScaleAabb,
  type ViewScaleChannel,
  type ViewScaleInputStamp
} from "@/mirror/viewScaleInverse";

// A realistic ANCIENT-EVENT option-group stamp in GAME space: a 1000x292 OptionsContainer centred at x=960 sitting
// at y 700..992, enlarged x1.2 about its BOTTOM centre (bottomCenter pivot ⇒ it grows UP), clamp 0 (it stays on
// screen). The forward stamp lifts the box top from y=700 to y≈641.6 — so the top option row visually paints in what
// was the gap/dialogue above it, which is exactly the halo the un-inverted web input misses.
function ancientOptionStamp(neighborRects: ViewScaleAabb[] = [], isGroup = true): ViewScaleInputStamp {
  const channel: ViewScaleChannel = { pivotX: 960, pivotY: 992, k: 1.2, offsetX: 0, offsetY: 0 };
  const originalBox: ViewScaleAabb = { minX: 460, minY: 700, maxX: 1460, maxY: 992 };
  const scaledBox = viewScaleForwardBox(originalBox, channel);
  return { channel, scaledBox, originalBox, isGroup, neighborRects };
}

describe("viewScaleInverse", () => {
  it("forward-maps a box exactly as applyViewScalePass's mDesign does", () => {
    const s = ancientOptionStamp();
    // bottomCenter pivot: bottom edge fixed, top lifted by 0.2*height; horizontal grows +/-0.2*halfWidth.
    expect(s.scaledBox.maxY).toBeCloseTo(992, 6); // bottom pinned
    expect(s.scaledBox.minY).toBeCloseTo(641.6, 3); // 992 + 1.2*(700-992)
    expect(s.scaledBox.minX).toBeCloseTo(360, 6); // 960 + 1.2*(460-960)
    expect(s.scaledBox.maxX).toBeCloseTo(1560, 6);
  });

  it("maps a point in the ENLARGED ancient-option halo back INSIDE the true option rect", () => {
    const s = ancientOptionStamp();
    // (960, 660) sits in the enlarged halo: inside the ScaledBox (641.6..992) but ABOVE the true box top (700).
    const p = remapViewScaleInverse(960, 660, [s]);
    expect(p.x).toBeCloseTo(960, 6); // horizontal pivot unchanged at the centre column
    // 992 + (660 - 992)/1.2 = 715.33 — back inside [700, 992], i.e. on the first real option row.
    expect(p.y).toBeCloseTo(715.333, 2);
    expect(p.y).toBeGreaterThan(s.originalBox.minY);
    expect(p.y).toBeLessThan(s.originalBox.maxY);
    expect(p.y).not.toBeCloseTo(660, 3); // it actually moved
  });

  it("returns a point OUTSIDE every ScaledBox unchanged (byte-identical to no inverse)", () => {
    const s = ancientOptionStamp();
    // Above the ScaledBox top (500 < 641.6) and left of it (100 < 360): both untouched.
    expect(remapViewScaleInverse(960, 500, [s])).toEqual({ x: 960, y: 500 });
    expect(remapViewScaleInverse(100, 660, [s])).toEqual({ x: 100, y: 660 });
  });

  it("leaves an EXEMPT overlay point unchanged over a GROUP (neighbour owns the tap)", () => {
    // A TopBar-style overlay button sitting inside the group halo at (960, 660).
    const overlay: ViewScaleAabb = { minX: 900, minY: 640, maxX: 1020, maxY: 700 };
    const withOverlay = ancientOptionStamp([overlay], true);
    expect(remapViewScaleInverse(960, 660, [withOverlay])).toEqual({ x: 960, y: 660 }); // identity — exempt

    // Control: the SAME point with no neighbour remaps (proves the exemption, not the containment, is what stopped it).
    const noOverlay = ancientOptionStamp([], true);
    expect(remapViewScaleInverse(960, 660, [noOverlay]).y).not.toBeCloseTo(660, 3);
  });

  it("gateEnabled=false ignores neighbours (every contained point remaps — pre-round-5 behaviour)", () => {
    const overlay: ViewScaleAabb = { minX: 900, minY: 640, maxX: 1020, maxY: 700 };
    const s = ancientOptionStamp([overlay], true);
    expect(remapViewScaleInverse(960, 660, [s], false).y).toBeCloseTo(715.333, 2);
  });

  it("an ITEM stamp's OWN face always remaps even under a neighbour; only its halo band is exempt", () => {
    // Same geometry but an ITEM (isGroup:false), with an overlay covering BOTH an on-face point and a halo point.
    const overlay: ViewScaleAabb = { minX: 460, minY: 640, maxX: 1460, maxY: 992 };
    const item = ancientOptionStamp([overlay], false);
    // On-face point (inside originalBox 700..992) → always remaps despite the neighbour.
    expect(remapViewScaleInverse(960, 750, [item]).y).not.toBeCloseTo(750, 3);
    // Halo point (660 < 700, in the band) under the same neighbour → exempt (identity).
    expect(remapViewScaleInverse(960, 660, [item])).toEqual({ x: 960, y: 660 });
  });

  it("round-trips: inverse(forward(q)) == q", () => {
    const c: ViewScaleChannel = { pivotX: 960, pivotY: 992, k: 1.2, offsetX: 15, offsetY: -70.4 };
    for (const q of [
      { x: 960, y: 750 },
      { x: 500, y: 720 },
      { x: 1400, y: 980 }
    ]) {
      const fwd = {
        x: c.pivotX + c.k * (q.x - c.pivotX) + c.offsetX,
        y: c.pivotY + c.k * (q.y - c.pivotY) + c.offsetY
      };
      const back = viewScaleInverseMapPoint(c, fwd.x, fwd.y);
      expect(back.x).toBeCloseTo(q.x, 6);
      expect(back.y).toBeCloseTo(q.y, 6);
    }
  });

  it("a k==1 translate-only stamp inverts to a pure un-translate (the ancient dialogue lift)", () => {
    const c: ViewScaleChannel = { pivotX: 960, pivotY: 500, k: 1, offsetX: 0, offsetY: -70.4 };
    const back = viewScaleInverseMapPoint(c, 960, 430);
    expect(back.x).toBeCloseTo(960, 6);
    expect(back.y).toBeCloseTo(500.4, 6); // 430 - (-70.4)
  });

  it("resolves the TOPMOST (last) stamp when two ScaledBoxes overlap", () => {
    const lower = ancientOptionStamp([], true); // remaps toward pivot (960, 992)
    // A different top stamp centred higher whose ScaledBox also contains (960, 660).
    const upperChannel: ViewScaleChannel = { pivotX: 960, pivotY: 660, k: 1.2, offsetX: 0, offsetY: 0 };
    const upperOriginal: ViewScaleAabb = { minX: 460, minY: 620, maxX: 1460, maxY: 700 };
    const upper: ViewScaleInputStamp = {
      channel: upperChannel,
      scaledBox: viewScaleForwardBox(upperOriginal, upperChannel),
      originalBox: upperOriginal,
      isGroup: true,
      neighborRects: []
    };
    // (960, 660) is the upper pivot → inverse fixes it exactly; if the LOWER stamp won it would move off 660.
    expect(remapViewScaleInverse(960, 660, [lower, upper])).toEqual({ x: 960, y: 660 });
  });

  it("aabb predicate helpers match the native registry rules", () => {
    const box: ViewScaleAabb = { minX: 100, minY: 100, maxX: 300, maxY: 200 };
    expect(aabbOverlaps(box, { minX: 250, minY: 150, maxX: 400, maxY: 250 })).toBe(true);
    expect(aabbOverlaps(box, { minX: 400, minY: 150, maxX: 500, maxY: 250 })).toBe(false);
    // enclosure tests against a slightly-inflated candidate (± eps).
    expect(aabbEncloses({ minX: 99.6, minY: 99.6, maxX: 300.4, maxY: 200.4 }, box)).toBe(true);
    expect(aabbEncloses({ minX: 120, minY: 100, maxX: 300, maxY: 200 }, box)).toBe(false);
    // a rect spanning >= 0.95*1920 is a stage-band bar.
    expect(aabbIsStageBand({ minX: 0, minY: 0, maxX: 1900, maxY: 60 }, 1920)).toBe(true);
    expect(aabbIsStageBand({ minX: 0, minY: 0, maxX: 1000, maxY: 60 }, 1920)).toBe(false);
  });
});

// --- the RENDERED-BOX guard (the wide-screen FALSE HALO) ------------------------------------------------------
//
// THE BUG. The web applies the inverse LAST: mapPointerToGame (+ the near-miss pass) resolves a GAME point first,
// and only then is that point tested against the stamps. On a wider-than-16:9 stage that can INVENT a halo hit —
// BESIDE the enlarged ancient-event options there is no `data-paints` painter to anchor the map, so
// mapPointerToGame falls back to the uniform squeeze (`designX·1920/designW`), which drops the centred content's
// spread shift (dx). The squeezed game X lands inside the group's ScaledBox even though the pointer was ~180
// design-px to the RIGHT of the enlarged plaque on screen, and the inverse then contracts it INTO an option row —
// hovering/tapping empty space beside the options focused/activated one.
//
// THE GUARD. A stamp may only claim a point when the RAW pointer's WIDENED-DESIGN position is inside the stamp's
// ON-STAGE `renderedBox` (= ScaledBox + spreadDx on X; Y is never spread). At 16:9 dx === 0 ⇒ renderedBox ===
// ScaledBox ⇒ a provable no-op. Native needs no twin (its InverseRemap already tests the raw design point against
// spread-folded boxes) — see the module header.
describe("viewScaleInverse — renderedBox guard (wide-stage false halo)", () => {
  // The LIVE ancient-event option group in GAME space (the geometry the bug was diagnosed on): a 1000x292
  // OptionsContainer centred at x=960 spanning y 750..1042, x1.2 about its BOTTOM centre, no clamp.
  const CHANNEL: ViewScaleChannel = { pivotX: 960, pivotY: 1042, k: 1.2, offsetX: 0, offsetY: 0 };
  const ORIGINAL: ViewScaleAabb = { minX: 460, minY: 750, maxX: 1460, maxY: 1042 };
  const SCALED = viewScaleForwardBox(ORIGINAL, CHANNEL); // x 360..1560, y 691.6..1042
  const SPREAD_DX = 147; // the group's applied shift on a 2214-wide stage (centre-anchored: ½·(2214−1920))
  const RENDERED: ViewScaleAabb = { ...SCALED, minX: SCALED.minX + SPREAD_DX, maxX: SCALED.maxX + SPREAD_DX };

  // The worked example from the live repro: the pointer sits at widened-design x 1750 (≈ 180 design-px right of the
  // enlarged plaque's right edge at 1707) on a 2214-wide stage. No painter ⇒ the uniform squeeze maps it to
  // 1750·1920/2214 ≈ 1517.6 — INSIDE the ScaledBox (360..1560), which is precisely the false halo.
  const RAW_BESIDE_X = 1750;
  const SQUEEZED_X = (RAW_BESIDE_X * 1920) / 2214; // 1517.615…
  const PREFIX_REMAP_X = CHANNEL.pivotX + (SQUEEZED_X - CHANNEL.pivotX) / CHANNEL.k; // 1424.679…
  const ROW_Y = 900; // the option-row band (inside both the ScaledBox and the true box on Y)

  function stamp(over: Partial<ViewScaleInputStamp> = {}): ViewScaleInputStamp {
    return {
      channel: CHANNEL,
      scaledBox: SCALED,
      originalBox: ORIGINAL,
      isGroup: true,
      neighborRects: [],
      renderedBox: RENDERED,
      ...over
    };
  }

  it("1. blocks the squeeze-mapped point from BESIDE the enlarged plaque (and it is the GUARD that stopped it)", () => {
    // Sanity: the mis-mapped point really is inside the ScaledBox — without the guard nothing else would stop it.
    expect(SQUEEZED_X).toBeCloseTo(1517.615, 2);
    expect(aabbContains(SCALED, SQUEEZED_X, ROW_Y)).toBe(true);
    expect(aabbContains(RENDERED, RAW_BESIDE_X, ROW_Y)).toBe(false); // the pointer was NOT over the plaque on stage

    // WITH the raw pointer → identity: the coordinate the game hit-tests is the squeezed one, i.e. empty space.
    const guarded = remapViewScaleInverse(SQUEEZED_X, ROW_Y, [stamp()], true, { x: RAW_BESIDE_X, y: ROW_Y });
    expect(guarded).toEqual({ x: SQUEEZED_X, y: ROW_Y });
    expect(guarded.x).toBeGreaterThan(ORIGINAL.maxX); // still outside the true option row — no false focus

    // The SAME call WITHOUT `raw` (the pre-guard path) contracts it into the row — proving the guard, not the
    // ScaledBox containment or the neighbour exemption, is what decided.
    const unguarded = remapViewScaleInverse(SQUEEZED_X, ROW_Y, [stamp()]);
    expect(unguarded.x).toBeCloseTo(PREFIX_REMAP_X, 2);
    expect(unguarded.x).toBeCloseTo(1424.679, 2);
    expect(aabbContains(ORIGINAL, unguarded.x, unguarded.y)).toBe(true); // THE BUG: inside the option row
  });

  it("2. a painter-anchored point genuinely OVER the enlarged plaque still remaps", () => {
    // Widened-design x 1200 IS inside the rendered plaque (507..1707). Over the plaque a `data-paints` painter
    // anchors the map, so mapPointerToGame subtracts the group's dx first: game x = 1200 − 147 = 1053. Y 700 sits
    // in the enlarged halo band (above the true top 750, inside the ScaledBox top 691.6).
    const rawX = 1200;
    const mappedX = rawX - SPREAD_DX;
    const haloY = 700;
    expect(aabbContains(RENDERED, rawX, haloY)).toBe(true);

    const p = remapViewScaleInverse(mappedX, haloY, [stamp()], true, { x: rawX, y: haloY });
    // Unchanged from the pre-guard result — the guard only ever subtracts hits.
    expect(p).toEqual(remapViewScaleInverse(mappedX, haloY, [stamp()]));
    expect(p.x).toBeCloseTo(1037.5, 3); // 960 + (1053 − 960)/1.2
    expect(p.y).toBeCloseTo(757, 3); // 1042 + (700 − 1042)/1.2
    expect(aabbContains(ORIGINAL, p.x, p.y)).toBe(true); // landed on the real option row
  });

  it("3. at 16:9 (dx 0 ⇒ renderedBox === ScaledBox) the guard is a provable no-op", () => {
    const s: ViewScaleInputStamp = stamp({ renderedBox: SCALED });
    expect(s.renderedBox).toEqual(s.scaledBox);
    for (const [x, y] of [
      [960, 700], // in the enlarged halo (above the true top)
      [960, 900], // on the item's own face
      [960, 500], // outside every ScaledBox (above it)
      [100, 900], // outside every ScaledBox (left of it)
      [360, 691.6], // exactly on the ScaledBox corner
      [1560, 1042] // exactly on the opposite corner
    ] as const) {
      // On 16:9 the raw design point IS the game point (no spread, no painter shift).
      expect(remapViewScaleInverse(x, y, [s], true, { x, y })).toEqual(remapViewScaleInverse(x, y, [s]));
    }
  });

  it("4. a stamp WITHOUT renderedBox ignores `raw` entirely (backward-compatible)", () => {
    const legacy = stamp({ renderedBox: undefined });
    expect(remapViewScaleInverse(SQUEEZED_X, ROW_Y, [legacy], true, { x: RAW_BESIDE_X, y: ROW_Y })).toEqual(
      remapViewScaleInverse(SQUEEZED_X, ROW_Y, [legacy])
    );
    expect(remapViewScaleInverse(SQUEEZED_X, ROW_Y, [legacy], true, { x: RAW_BESIDE_X, y: ROW_Y }).x).toBeCloseTo(
      PREFIX_REMAP_X,
      2
    );
  });

  it("5. a raw-BLOCKED top stamp falls through to a lower stamp that does contain the raw pointer", () => {
    // A lower stamp rendered where the pointer actually IS (its renderedBox covers raw x 1750) whose ScaledBox also
    // contains the mapped point — a `return` on the block would have silently swallowed its claim.
    const lowerChannel: ViewScaleChannel = { pivotX: 1500, pivotY: 1042, k: 1.25, offsetX: 0, offsetY: 0 };
    const lowerOriginal: ViewScaleAabb = { minX: 1400, minY: 800, maxX: 1600, maxY: 1042 };
    const lowerScaled = viewScaleForwardBox(lowerOriginal, lowerChannel);
    const lower: ViewScaleInputStamp = {
      channel: lowerChannel,
      scaledBox: lowerScaled,
      originalBox: lowerOriginal,
      isGroup: false,
      neighborRects: [],
      renderedBox: { minX: 1600, minY: lowerScaled.minY, maxX: 1900, maxY: lowerScaled.maxY }
    };
    expect(aabbContains(lowerScaled, SQUEEZED_X, ROW_Y)).toBe(true); // both stamps' ScaledBoxes cover the point
    expect(aabbContains(lower.renderedBox!, RAW_BESIDE_X, ROW_Y)).toBe(true);

    // `lower` first, the raw-blocked group LAST (topmost) — the guard must `continue`, not return.
    const p = remapViewScaleInverse(SQUEEZED_X, ROW_Y, [lower, stamp()], true, { x: RAW_BESIDE_X, y: ROW_Y });
    expect(p.x).toBeCloseTo(1500 + (SQUEEZED_X - 1500) / 1.25, 6); // the LOWER stamp's inverse ran
    expect(p.x).not.toBeCloseTo(SQUEEZED_X, 3);
    expect(p.x).not.toBeCloseTo(PREFIX_REMAP_X, 3);
  });

  it("6. a translate-only (k=1) stamp — the ancient DIALOGUE lift — is guarded the same way", () => {
    const c: ViewScaleChannel = { pivotX: 960, pivotY: 500, k: 1, offsetX: 0, offsetY: -70.4 };
    const original: ViewScaleAabb = { minX: 460, minY: 300, maxX: 1460, maxY: 700 };
    const scaled = viewScaleForwardBox(original, c); // pure translate: y 229.6..629.6
    const s: ViewScaleInputStamp = {
      channel: c,
      scaledBox: scaled,
      originalBox: original,
      isGroup: true,
      neighborRects: [],
      renderedBox: { ...scaled, minX: scaled.minX + SPREAD_DX, maxX: scaled.maxX + SPREAD_DX } // x 607..1607
    };
    // BESIDE it: raw design x 1750 squeezes to ≈1517.6, inside the ScaledBox (460..1460)? No — 1517.6 > 1460, so
    // pick a raw x whose squeeze DOES land inside: 1680 → 1456.9.
    const rawBeside = 1680;
    const squeezed = (rawBeside * 1920) / 2214;
    expect(aabbContains(scaled, squeezed, 400)).toBe(true);
    expect(aabbContains(s.renderedBox!, rawBeside, 400)).toBe(false); // 1680 > 1607 — beside the lifted dialogue
    expect(remapViewScaleInverse(squeezed, 400, [s], true, { x: rawBeside, y: 400 })).toEqual({ x: squeezed, y: 400 });

    // INSIDE it: raw design x 1100 is over the lifted dialogue; the painter-anchored map gives 1100 − 147 = 953.
    const p = remapViewScaleInverse(953, 400, [s], true, { x: 1100, y: 400 });
    expect(p.x).toBeCloseTo(953, 6); // k=1 ⇒ X untouched (offsetX 0)
    expect(p.y).toBeCloseTo(470.4, 6); // 400 − (−70.4) — the un-translate still fires
  });
});
