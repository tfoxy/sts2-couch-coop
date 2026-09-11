// THE SHAPED-BLOCK MEMO — the glyph path's twin of `textSurfaces`' digest cache.
//
// Two claims, and they are checked in opposite directions. The KEY must separate every input that changes what is
// shaped (or the cache draws one label's glyphs for another's words, which is the failure `textSurfaces`' collision
// counter exists for); and it must NOT separate the pose, or a moving label misses on every frame and the cache is
// a pure cost. The rest is the eviction clock, which is the same shape `textSurfaces` uses and is tested the same
// way: a surface nothing names goes away, and one that is named every build never does.

import { describe, expect, it } from "vitest";

import {
  createGlyphBlockCache,
  GLYPH_BLOCK_EVICT_AFTER_BUILDS,
  type GlyphBlockCache
} from "@/mirror/canvas/glyphBlocks";
import type { TextGlyphBlock } from "@/mirror/canvas/paintSpec";
import type { TextSpec } from "@/mirror/canvas/textLayout";

function mkSpec(over: Partial<TextSpec> = {}): TextSpec {
  return {
    text: "Deal 6 damage.",
    cssFont: "20px kreon_regular",
    fontPx: 20,
    pitchPx: 24,
    paragraphGapPx: 0,
    color: "#ffffff",
    outlinePx: 0,
    outlineColor: null,
    shadow: null,
    align: "left",
    whiteSpace: "normal",
    contentW: 180,
    blockScale: 1,
    godotLines: null,
    refusal: null,
    ...over
  } as TextSpec;
}

/** A pooled block, as `glyphPass.blockFor` hands one over: two runs (outline + fill) over ONE shared span. */
function mkBlock(over: Partial<TextGlyphBlock> = {}): TextGlyphBlock {
  return {
    runCount: 2,
    origins: Float32Array.from([0, 18, 0, 18]),
    spans: Int32Array.from([0, 3, 0, 3]),
    colors: Float32Array.from([0, 0, 0, 1, 1, 1, 1, 1]),
    spreads: Float32Array.from([1, 0]),
    slots: Int32Array.from([7, 8, 9]),
    positions: Float32Array.from([0, 0, 9, 0, 18, 0]),
    pixelsPerEm: 20,
    blockScale: 1,
    ...over
  };
}

function seeded(): { cache: GlyphBlockCache; key: string } {
  const cache = createGlyphBlockCache();
  const key = cache.keyFor(mkSpec(), "/fonts/kreon.ttf", undefined);
  cache.put(key, mkBlock(), 1);
  return { cache, key };
}

describe("the key separates everything that changes what is shaped", () => {
  const base = createGlyphBlockCache();
  const key = (spec: TextSpec, face = "/fonts/kreon.ttf", spans?: undefined) => base.keyFor(spec, face, spans);

  it("separates the words, the face shorthand and the streamed face URL", () => {
    expect(key(mkSpec({ text: "Deal 9 damage." }))).not.toBe(key(mkSpec()));
    expect(key(mkSpec({ cssFont: "28px kreon_regular" }))).not.toBe(key(mkSpec()));
    // THE FACE URL IS THE ONE `textDigest` CANNOT SEE. Two labels can share a `cssFont` shorthand while the
    // streamed face behind it differs, and shaping goes through the face — not the shorthand.
    expect(key(mkSpec(), "/fonts/other.ttf")).not.toBe(key(mkSpec()));
  });

  it("separates the BLOCK SCALE, which the raster path reaches only through its scale field", () => {
    // `emitTextGlyphs` folds `blockScale` into every run's matrix and the cached block carries it, so two card
    // descriptions at 1.0 and 1.24 are not the same block however identical their words.
    expect(key(mkSpec({ blockScale: 1.24 }))).not.toBe(key(mkSpec({ blockScale: 1 })));
  });

  it("separates the wrap inputs — the box width and the streamed line breaks", () => {
    expect(key(mkSpec({ contentW: 240 }))).not.toBe(key(mkSpec({ contentW: 180 })));
    expect(key(mkSpec({ godotLines: [{ text: "Deal", start: 0, end: 4 }] as never }))).not.toBe(key(mkSpec()));
  });

  it("separates the run STRUCTURE — an outline and a shadow are extra runs, not extra pixels", () => {
    expect(key(mkSpec({ outlinePx: 2, outlineColor: "#000000" }))).not.toBe(key(mkSpec()));
    expect(key(mkSpec({ shadow: { dx: 1, dy: 1, color: "#000000" } as never }))).not.toBe(key(mkSpec()));
  });

  it("does NOT separate the pose — a shaped run is scale-free, which is the whole reason the path exists", () => {
    // There is no pose in the signature at all, and that is the assertion: a key that took one would miss on
    // every frame of every animated label and the cache would be a pure cost. This pins the SHAPE of the seam.
    expect(key(mkSpec())).toBe(key(mkSpec()));
    expect(base.keyFor.length).toBe(3);
  });
});

describe("what it hands back", () => {
  it("answers a stored block and counts the hit", () => {
    const { cache, key } = seeded();
    const held = cache.get(key);
    expect(held?.lines).toBe(1);
    expect(held?.block.runCount).toBe(2);
    expect(cache.stats().hits).toBe(1);
    // The `put` itself is not a hit, and the `get` that preceded a real miss is counted as one.
    expect(cache.stats().misses).toBe(0);
    expect(cache.get("nobody")).toBeNull();
    expect(cache.stats().misses).toBe(1);
  });

  it("OWNS its copy — the caller's block is pooled and is refilled by the very next label", () => {
    const cache = createGlyphBlockCache();
    const key = cache.keyFor(mkSpec(), "/f.ttf", undefined);
    const pooled = mkBlock();
    cache.put(key, pooled, 1);
    // The registry refills the pool in place for the next label. A cache that kept the reference would hand the
    // NEXT label's glyphs back under THIS label's key — the same words, drawn wrong, with nothing to notice it by.
    pooled.slots[0] = 999;
    pooled.positions[0] = -1;
    pooled.runCount = 0;
    const held = cache.get(key);
    expect(held?.block.slots[0]).toBe(7);
    expect(held?.block.positions[0]).toBe(0);
    expect(held?.block.runCount).toBe(2);
  });

  it("copies the glyph arrays to the SPANS' high-water mark, not to the run count", () => {
    // An outlined label's runs SHARE a span, so `runCount` says nothing about how many glyphs there are. A copy
    // sized from the run count would truncate every multi-line label to its first two glyphs.
    const cache = createGlyphBlockCache();
    const key = cache.keyFor(mkSpec(), "/f.ttf", undefined);
    cache.put(
      key,
      mkBlock({
        runCount: 2,
        spans: Int32Array.from([0, 3, 3, 4]),
        origins: Float32Array.from([0, 18, 0, 42]),
        slots: Int32Array.from([1, 2, 3, 4, 5, 6, 7]),
        positions: new Float32Array(14)
      }),
      2
    );
    expect(cache.get(key)?.block.slots.length).toBe(7);
    expect(cache.stats().glyphs).toBe(7);
  });

  it("reports exact retained typed-array bytes and the detached-copy cost", () => {
    const cache = createGlyphBlockCache();
    const key = cache.keyFor(mkSpec(), "/f.ttf", undefined);
    const pooled = mkBlock();
    const exactBytes =
      pooled.origins.byteLength +
      pooled.spans.byteLength +
      pooled.colors.byteLength +
      pooled.spreads.byteLength +
      pooled.slots.byteLength +
      pooled.positions.byteLength;
    cache.put(key, pooled, 1);
    const stats = cache.stats();
    expect(stats.retainedBytes).toBe(exactBytes);
    expect(stats.copies).toBe(1);
    expect(stats.copiedBytes).toBe(exactBytes);
    cache.invalidate();
    // Invalidating releases the retained payload, while the copy cost remains a cumulative accounting fact.
    expect(cache.stats()).toMatchObject({ retainedBytes: 0, copies: 1, copiedBytes: exactBytes });
  });
});

describe("the eviction clock", () => {
  it("keeps a block that is named every build, forever", () => {
    const { cache, key } = seeded();
    for (let i = 0; i < GLYPH_BLOCK_EVICT_AFTER_BUILDS * 2; i++) {
      expect(cache.get(key), `build ${i}`).not.toBeNull();
      cache.endBuild();
    }
    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().evicted).toBe(0);
  });

  it("drops one nothing has named for the whole horizon", () => {
    const { cache, key } = seeded();
    for (let i = 0; i < GLYPH_BLOCK_EVICT_AFTER_BUILDS; i++) {
      cache.endBuild();
    }
    expect(cache.get(key)).toBeNull();
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().evicted).toBe(1);
  });

  it("caps the population, dropping the LEAST RECENTLY NAMED first", () => {
    const cache = createGlyphBlockCache({ maxEntries: 2 });
    const keys = ["a", "b", "c"].map((t) => cache.keyFor(mkSpec({ text: t }), "/f.ttf", undefined));
    cache.put(keys[0], mkBlock(), 1);
    cache.endBuild();
    cache.put(keys[1], mkBlock(), 1);
    cache.endBuild();
    // `a` is now the oldest NAMED, so re-naming it must save it and sink `b` instead.
    expect(cache.get(keys[0])).not.toBeNull();
    cache.put(keys[2], mkBlock(), 1);
    expect(cache.stats().entries).toBe(2);
    expect(cache.get(keys[1])).toBeNull();
    expect(cache.get(keys[0])).not.toBeNull();
    expect(cache.get(keys[2])).not.toBeNull();
  });

  it("drops everything on a context loss — the atlas those slot ids name is gone", () => {
    const { cache, key } = seeded();
    cache.invalidate();
    expect(cache.get(key)).toBeNull();
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().invalidations).toBe(1);
    // …and an invalidation with nothing held is not an event.
    cache.invalidate();
    expect(cache.stats().invalidations).toBe(1);
  });
});
