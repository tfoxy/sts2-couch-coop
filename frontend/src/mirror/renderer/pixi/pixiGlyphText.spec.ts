import { describe, expect, it, vi } from "vitest";
import type { GlyphBlock, GlyphPassRegistry } from "@/mirror/canvas/glyphPass";
import { copyPixiGlyphBlock, preparePixiGlyph } from "./pixiGlyphText";

function block(): GlyphBlock {
  return { runCount: 2, origins: new Float32Array([1, 2, 3, 4, 99, 99]),
    spans: new Int32Array([0, 2, 1, 2, 99, 99]), colors: new Float32Array(12).fill(0.5),
    spreads: new Float32Array([0, 1, 99]), slots: new Int32Array([7, 8, 9, 99]),
    positions: new Float32Array([1, 2, 3, 4, 5, 6, 99, 99]), pixelsPerEm: 20, blockScale: 1.5 };
}

describe("Pixi glyph text preparation", () => {
  it("copies only referenced borrowed prefixes, including overlapping run spans", () => {
    const borrowed = block();
    const owned = copyPixiGlyphBlock(borrowed);
    expect([...owned.slots]).toEqual([7, 8, 9]);
    expect([...owned.positions]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(owned.origins).toHaveLength(4);
    expect(owned.colors).toHaveLength(8);
    borrowed.slots.fill(-1); borrowed.origins.fill(-1); borrowed.positions.fill(-1);
    expect([...owned.slots]).toEqual([7, 8, 9]);
    expect([...owned.origins]).toEqual([1, 2, 3, 4]);
    expect([...owned.positions]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("retains box-local ink bounds before the next registry call", () => {
    const borrowed = block();
    const registry = { stats: () => ({}), blockFor: () => borrowed,
      boundsFor: () => ({ x: -2, y: 1, width: 30, height: 14 }) } as unknown as GlyphPassRegistry;
    const prepared = preparePixiGlyph(registry, { boxW: 100, boxH: 40 } as never,
      { lines: [] } as never, { url: "/font.ttf" } as never, [1, 0, 0, 1, 0, 0], 2, "label-key", true);
    expect(prepared.glyph?.box).toEqual({ width: 100, height: 40 });
    expect(prepared.glyph?.inkBounds).toEqual({ x: -2, y: 1, width: 30, height: 14 });
    expect(prepared.glyph?.contentKey).toBe("label-key");
    borrowed.slots.fill(-1);
    expect([...prepared.glyph!.block.slots]).toEqual([7, 8, 9]);
  });

  it("keeps differently colored rich spans on the native fallback path", () => {
    const blockFor = vi.fn(() => block());
    const registry = { blockFor } as unknown as GlyphPassRegistry;
    const prepared = preparePixiGlyph(registry, { color: "#ffffff" } as never,
      { lines: [{ runs: [{ text: "red", x: 0, width: 20, color: "#ff0000" }] }] } as never,
      { url: "/font.ttf" } as never, [1, 0, 0, 1, 0, 0], 1, "rich", false);
    expect(prepared).toEqual({ fallbackReason: "glyph-rich-spans" });
    expect(blockFor).not.toHaveBeenCalled();
  });
});
