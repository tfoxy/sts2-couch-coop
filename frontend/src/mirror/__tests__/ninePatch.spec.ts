import { describe, expect, it } from "vitest";

import { ninePatchAtlasSlices } from "@/mirror/ninePatch";

// Real top-bar PotionBg numbers: top_bar_char_backdrop region 90x85 in the 2048x2048 ui_atlas_0 page,
// patch_margin 32 each side, stretched into the ~140x80 potion panel box.
const region = { x: 1920, y: 627, width: 90, height: 85 };
const margins = { left: 32, top: 32, right: 32, bottom: 32 };
const page = { width: 2048, height: 2048 };

describe("ninePatchAtlasSlices", () => {
  it("emits 9 patches that tile the destination box without gaps or overlap", () => {
    const box = { width: 140, height: 80 };
    const slices = ninePatchAtlasSlices(region, margins, box, page);
    expect(slices).toHaveLength(9);

    // Corners are fixed at the patch margins; the middle column/row stretch to fill the box.
    const topLeft = slices[0];
    expect(topLeft).toMatchObject({ left: 0, top: 0, width: 32, height: 32 });
    // Corner is 1:1 (source 32 -> dest 32): page drawn at native size, offset to the region corner.
    expect(topLeft.backgroundSizeWidth).toBeCloseTo(2048, 3);
    expect(topLeft.backgroundPositionX).toBeCloseTo(-1920, 3);
    expect(topLeft.backgroundPositionY).toBeCloseTo(-627, 3);

    // Dest bands cover the box edge-to-edge: left cap + middle + right cap == box width.
    const widths = new Set(slices.map((s) => `${s.left}-${s.width}`));
    expect(widths.has("0-32")).toBe(true); // left cap
    expect(widths.has("32-76")).toBe(true); // middle: 140 - 32 - 32
    expect(widths.has("108-32")).toBe(true); // right cap pinned to the end

    // The center patch stretches a 26x21 source slice into the 76x16 middle band.
    const center = slices.find((s) => s.left === 32 && s.top === 32);
    expect(center).toBeDefined();
    expect(center!.width).toBeCloseTo(76, 3);
    expect(center!.height).toBeCloseTo(16, 3); // 80 - 32 - 32
    expect(center!.backgroundSizeWidth).toBeCloseTo(2048 * (76 / 26), 3);
    expect(center!.backgroundSizeHeight).toBeCloseTo(2048 * (16 / 21), 3);
  });

  it("drops degenerate patches (zero margins / box smaller than caps)", () => {
    // Box narrower than left+right caps: the middle column collapses (width 0) and is dropped.
    const slices = ninePatchAtlasSlices(region, margins, { width: 50, height: 80 }, page);
    expect(slices.every((s) => s.width > 0 && s.height > 0)).toBe(true);
    // No middle-column patches remain (only the two caps per row).
    expect(slices.some((s) => s.left === 32 && s.width > 0)).toBe(false);
  });

  it("returns nothing without a known page size", () => {
    expect(ninePatchAtlasSlices(region, margins, { width: 140, height: 80 }, { width: 0, height: 0 })).toEqual([]);
  });
});

// R19 6c — the WIDESCREEN case. `box` is the element's RENDERED box, not its streamed 1920-space localRect: on a
// wider-than-16:9 stage the anchor algebra hands an anchored SPAN a `renderWidthOverride` and nodeStyles lays the
// element out that much wider. Slicing from the 1920 width leaves the right cap `deltaW` px short of the element's
// right edge and stops the stretched middle there — the panel art visibly ends before its own frame does.
describe("ninePatchAtlasSlices — widened (rendered) box", () => {
  const DELTA = 600; // the 2520 cap: (2520/1920 − 1) · 1920

  it("pins the right cap to the RENDERED edge and stretches the middle across it", () => {
    const streamed = { width: 640, height: 80 };
    const rendered = { width: streamed.width + DELTA, height: 80 };
    const wide = ninePatchAtlasSlices(region, margins, rendered, page);
    expect(wide).toHaveLength(9);

    // Right cap at renderedWidth − 32; middle band spans the whole interior.
    expect(wide.some((s) => s.left === rendered.width - 32 && s.width === 32)).toBe(true);
    const center = wide.find((s) => s.left === 32 && s.top === 32)!;
    expect(center.width).toBeCloseTo(rendered.width - 64, 3);
    expect(center.backgroundSizeWidth).toBeCloseTo(2048 * ((rendered.width - 64) / 26), 3);

    // The bands still tile edge to edge: left cap + middle + right cap === the rendered width.
    const row = wide.filter((s) => s.top === 0).sort((a, b) => a.left - b.left);
    expect(row[0].left).toBe(0);
    expect(row.at(-1)!.left + row.at(-1)!.width).toBeCloseTo(rendered.width, 3);
  });

  it("is exactly what the 1920-space box got WRONG (the pre-fix shortfall)", () => {
    const streamed = { width: 640, height: 80 };
    const rendered = { width: streamed.width + DELTA, height: 80 };
    const narrow = ninePatchAtlasSlices(region, margins, streamed, page);
    const narrowRow = narrow.filter((s) => s.top === 0).sort((a, b) => a.left - b.left);
    // Sliced from the streamed width, the art ends a full Δ short of the element it is painted into.
    expect(rendered.width - (narrowRow.at(-1)!.left + narrowRow.at(-1)!.width)).toBeCloseTo(DELTA, 3);
  });
});
