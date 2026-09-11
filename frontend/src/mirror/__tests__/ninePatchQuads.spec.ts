// `ninePatchAtlasQuads` is the numeric core of the mirror's nine-patch-over-atlas slicing: one src→dst blit per
// patch, in page px / design px, which is what a canvas renderer draws. `ninePatchAtlasSlices` is the CSS framing
// of the SAME quads (page-sized background + offset). This spec pins the two views to one geometry: for a corpus of
// (region, margins, box, page) cases — degenerate margins included — it INVERTS the CSS back into src/dst rects and
// requires them to be the quads. If the two ever drift, the canvas renderer and the DOM renderer disagree on screen.
import { describe, expect, it } from "vitest";

import { ninePatchAtlasQuads, ninePatchAtlasSlices, type NinePatchQuad } from "@/mirror/ninePatch";
import type { MirrorMargins, MirrorRect } from "@/mirror/sceneTree";

interface Case {
  name: string;
  region: MirrorRect;
  margins: MirrorMargins;
  box: { width: number; height: number };
  page: { width: number; height: number };
}

const PAGE = { width: 2048, height: 2048 };

const CASES: Case[] = [
  {
    // The real top-bar PotionBg: a 90x85 region with 32px margins stretched into the ~140x80 panel.
    name: "all 9 patches present",
    region: { x: 1920, y: 627, width: 90, height: 85 },
    margins: { left: 32, top: 32, right: 32, bottom: 32 },
    box: { width: 140, height: 80 },
    page: PAGE
  },
  {
    name: "widescreen rendered box (R19 6c)",
    region: { x: 1920, y: 627, width: 90, height: 85 },
    margins: { left: 32, top: 32, right: 32, bottom: 32 },
    box: { width: 1240, height: 80 },
    page: PAGE
  },
  {
    name: "asymmetric margins",
    region: { x: 40, y: 12, width: 120, height: 64 },
    margins: { left: 10, top: 4, right: 30, bottom: 20 },
    box: { width: 400, height: 96 },
    page: PAGE
  },
  {
    name: "DEGENERATE: zero margins everywhere (only the centre patch survives)",
    region: { x: 0, y: 0, width: 64, height: 64 },
    margins: { left: 0, top: 0, right: 0, bottom: 0 },
    box: { width: 200, height: 50 },
    page: PAGE
  },
  {
    name: "DEGENERATE: zero horizontal margins (a vertical 3-band strip)",
    region: { x: 5, y: 5, width: 64, height: 64 },
    margins: { left: 0, top: 8, right: 0, bottom: 8 },
    box: { width: 200, height: 50 },
    page: PAGE
  },
  {
    name: "DEGENERATE: zero vertical margins (a horizontal 3-band strip)",
    region: { x: 5, y: 5, width: 64, height: 64 },
    margins: { left: 8, top: 0, right: 8, bottom: 0 },
    box: { width: 200, height: 50 },
    page: PAGE
  },
  {
    name: "DEGENERATE: box narrower than its caps (middle COLUMN collapses)",
    region: { x: 1920, y: 627, width: 90, height: 85 },
    margins: { left: 32, top: 32, right: 32, bottom: 32 },
    box: { width: 50, height: 80 },
    page: PAGE
  },
  {
    name: "DEGENERATE: box shorter than its caps (middle ROW collapses)",
    region: { x: 1920, y: 627, width: 90, height: 85 },
    margins: { left: 32, top: 32, right: 32, bottom: 32 },
    box: { width: 140, height: 40 },
    page: PAGE
  },
  {
    // The health-bar Mask shape: a 12x10 texture with 6px margins — the SOURCE centre column is 0 wide.
    name: "DEGENERATE: region smaller than its margins (source middle collapses)",
    region: { x: 0, y: 0, width: 12, height: 10 },
    margins: { left: 6, top: 6, right: 6, bottom: 6 },
    box: { width: 250, height: 16 },
    page: { width: 512, height: 512 }
  },
  {
    name: "DEGENERATE: box exactly equal to its caps",
    region: { x: 100, y: 100, width: 80, height: 80 },
    margins: { left: 20, top: 20, right: 20, bottom: 20 },
    box: { width: 40, height: 40 },
    page: PAGE
  },
  {
    name: "fractional box and margins",
    region: { x: 33, y: 77, width: 91.5, height: 43.25 },
    margins: { left: 7.5, top: 3.25, right: 11.75, bottom: 6.5 },
    box: { width: 317.4, height: 88.6 },
    page: { width: 1024, height: 4096 }
  },
  {
    name: "non-square page",
    region: { x: 0, y: 0, width: 60, height: 20 },
    margins: { left: 6, top: 6, right: 6, bottom: 6 },
    box: { width: 300, height: 44 },
    page: { width: 4096, height: 1024 }
  }
];

// The CSS slice, read BACK as the src→dst blit it describes. `backgroundSize` is the whole page scaled so the
// source slice fills the band, and `backgroundPosition` is the scaled slice origin negated — invert both.
function quadFromSlice(
  slice: ReturnType<typeof ninePatchAtlasSlices>[number],
  page: { width: number; height: number }
): NinePatchQuad {
  const scaleX = slice.backgroundSizeWidth / page.width;
  const scaleY = slice.backgroundSizeHeight / page.height;
  return {
    dst: { x: slice.left, y: slice.top, w: slice.width, h: slice.height },
    src: {
      x: -slice.backgroundPositionX / scaleX,
      y: -slice.backgroundPositionY / scaleY,
      w: slice.width / scaleX,
      h: slice.height / scaleY
    }
  };
}

function expectQuadClose(actual: NinePatchQuad, expected: NinePatchQuad): void {
  for (const side of ["dst", "src"] as const) {
    for (const axis of ["x", "y", "w", "h"] as const) {
      expect(actual[side][axis]).toBeCloseTo(expected[side][axis], 9);
    }
  }
}

describe("ninePatchAtlasQuads ≡ ninePatchAtlasSlices (one geometry, two views)", () => {
  for (const c of CASES) {
    it(`${c.name}: the CSS slices invert back to exactly the quads`, () => {
      const quads = ninePatchAtlasQuads(c.region, c.margins, c.box, c.page);
      const slices = ninePatchAtlasSlices(c.region, c.margins, c.box, c.page);
      expect(slices).toHaveLength(quads.length);
      expect(quads.length).toBeGreaterThan(0); // every case here paints SOMETHING
      slices.forEach((slice, i) => expectQuadClose(quadFromSlice(slice, c.page), quads[i]));
    });

    it(`${c.name}: no quad is degenerate, and each src lies inside the region`, () => {
      for (const q of ninePatchAtlasQuads(c.region, c.margins, c.box, c.page)) {
        expect(q.dst.w).toBeGreaterThan(0);
        expect(q.dst.h).toBeGreaterThan(0);
        expect(q.src.w).toBeGreaterThan(0);
        expect(q.src.h).toBeGreaterThan(0);
        expect(q.src.x).toBeGreaterThanOrEqual(c.region.x - 1e-9);
        expect(q.src.y).toBeGreaterThanOrEqual(c.region.y - 1e-9);
        expect(q.src.x + q.src.w).toBeLessThanOrEqual(c.region.x + c.region.width + 1e-9);
        expect(q.src.y + q.src.h).toBeLessThanOrEqual(c.region.y + c.region.height + 1e-9);
      }
    });
  }

  it("emits at most 9 quads, in row-major order", () => {
    const c = CASES[0];
    const quads = ninePatchAtlasQuads(c.region, c.margins, c.box, c.page);
    expect(quads).toHaveLength(9);
    // Rows are non-decreasing in y; within a row, x strictly increases.
    for (let i = 1; i < quads.length; i += 1) {
      const prev = quads[i - 1];
      const cur = quads[i];
      expect(cur.dst.y >= prev.dst.y).toBe(true);
      if (cur.dst.y === prev.dst.y) {
        expect(cur.dst.x).toBeGreaterThan(prev.dst.x);
      }
    }
  });

  it("the quads tile the destination box edge to edge (the property the caps/middle exist for)", () => {
    const c = CASES[0];
    const quads = ninePatchAtlasQuads(c.region, c.margins, c.box, c.page);
    const row = quads.filter((q) => q.dst.y === 0).sort((a, b) => a.dst.x - b.dst.x);
    expect(row[0].dst.x).toBe(0);
    expect(row.at(-1)!.dst.x + row.at(-1)!.dst.w).toBeCloseTo(c.box.width, 9);
    const col = quads.filter((q) => q.dst.x === 0).sort((a, b) => a.dst.y - b.dst.y);
    expect(col[0].dst.y).toBe(0);
    expect(col.at(-1)!.dst.y + col.at(-1)!.dst.h).toBeCloseTo(c.box.height, 9);
  });

  it("corners are 1:1 blits: the cap keeps its source size, only the middles stretch", () => {
    const c = CASES[0];
    const [topLeft] = ninePatchAtlasQuads(c.region, c.margins, c.box, c.page);
    expect(topLeft.dst).toEqual({ x: 0, y: 0, w: 32, h: 32 });
    expect(topLeft.src).toEqual({ x: 1920, y: 627, w: 32, h: 32 });
  });

  it("both views agree that an UNMEASURED page yields nothing to draw", () => {
    const c = CASES[0];
    expect(ninePatchAtlasQuads(c.region, c.margins, c.box, { width: 0, height: 0 })).toEqual([]);
    expect(ninePatchAtlasSlices(c.region, c.margins, c.box, { width: 0, height: 0 })).toEqual([]);
    expect(ninePatchAtlasQuads(c.region, c.margins, { width: 0, height: 80 }, c.page)).toEqual([]);
    expect(ninePatchAtlasSlices(c.region, c.margins, { width: 0, height: 80 }, c.page)).toEqual([]);
  });
});
