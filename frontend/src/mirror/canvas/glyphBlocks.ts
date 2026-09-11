// SHAPED LABELS, KEPT — the glyph path's answer to the question `textSurfaces` answered for the raster path.
//
// gsw now memoizes HarfBuzz shaping inside its glyph pass too. This cache remains useful because it
// avoids the consumer's layout and measurement work before a run reaches that pass.
//
// WHAT IT IS FOR, measured rather than assumed. `canvasRenderer`'s `glyphSource.blockFor` runs, per label, per
// BUILD: `layoutText` (greedy line breaking, which measures every candidate through a 2D context), a cmap sweep
// over every codepoint of every line, and `shaper.fillRun` per line through the HarfBuzz wasm. None of it was
// memoized, and none of its inputs move between builds — a label's words, face, box and colours are the same
// string they were last frame. A combat screen with canvas text therefore paid all three for seventy
// labels on every one of its 372 builds in thirty seconds, and a Firefox profile of that arm attributes 1.54
// ms/frame to `ctx.font =` and 1.17 ms/frame to `measureText` alone.
//
// THE ARGUMENT IS `textSurfaces`' VERBATIM, and so is the shape of the answer: "the offline census measured 15-52
// labels re-drawn on EVERY build while their pixels change 0-64 times per THIRTY SECONDS". The raster path turned
// that into a per-change cost by keying a digest computed from the SPEC — before any measurement — so that a hit
// skips line breaking entirely. This is the same key in front of the same work for the other backend.
//
// ---------------------------------------------------------------------------------------------------------------
// WHY A SHAPED BLOCK IS SAFE TO KEEP, which is the one thing that had to be checked rather than assumed.
//
// A block holds ATLAS SLOT IDS, and a glyph atlas evicts. Caching an atlas OFFSET would be the classic disaster —
// a different glyph's outline drawn at the right size in the right place, unreadable text that looks like working
// text. Slot ids are not offsets: gsw's `GlyphsView` documents them as HANDLES ("a slot id survives eviction
// because the atlas re-resolves it, re-uploading the outline if it has to, at draw time"), and `glyphPass.drawRun`
// says the same from the consumer's side. So a block outlives the atlas contents it was shaped against, which is
// exactly the property that makes it cacheable at all.
//
// WHAT DOES NOT SURVIVE is a CONTEXT LOSS: the pass is rebuilt, the atlas is new, and the ids in a retained block
// name nothing. {@link GlyphBlockCache.invalidate} is that, and the renderer calls it where it calls every other
// registry's.
//
// ---------------------------------------------------------------------------------------------------------------
// THE KEY IS SCALE-FREE, and that is a statement about the two backends rather than a shortcut.
//
// A raster is pixels, so its digest carries the scale it was drawn at. A shaped run is OUTLINES plus pen positions
// in the run's own local space, with the whole on-screen transform in `GlyphsView.m` — which is the entire reason
// the glyph path exists. So the same block serves the label at any pose, and `textDigest(spec, 0, spans)` is used
// with a constant in the scale field rather than with a scale nobody would read back.
//
// THREE FIELDS IN FRONT OF IT, all of which change what is shaped while leaving the raster descriptor identical:
// the FACE URL (`faceFor` keys on it, and two labels can share a `cssFont` shorthand while the streamed face
// behind it differs), the BLOCK SCALE (card rules apply a `transform: scale(N)` about the box
// centre, which `emitTextGlyphs` folds into every run's matrix and which the raster path reaches only through its
// scale field), and a `g` tag so a glyph key can never be read as a raster one. None of the three can contain a
// NUL, so `textDigest`'s counting argument survives the prefix intact.
//
// ---------------------------------------------------------------------------------------------------------------
// The cache is independent of the fidelity-floor diagnostic: that diagnostic reports the current device ppem but
// does not change which text path owns the label, so a block key remains stable across poses.

import type { TextGlyphBlock } from "@/mirror/canvas/paintSpec";
import { textDigest, type TextSpan, type TextSpec } from "@/mirror/canvas/textLayout";

/**
 * Builds a label goes unnamed for before its shaped block is dropped.
 *
 * `textSurfaces`' own horizon, deliberately: the two caches hold the two halves of the same label and a screen
 * that keeps one worth keeping keeps the other. It is generous because a block is BYTES — a few hundred per label
 * — where a raster is up to a 4 MB page, so the pressure that sizes the raster evictor does not exist here.
 */
export const GLYPH_BLOCK_EVICT_AFTER_BUILDS = 240;

/**
 * …and a hard ceiling on entries, which the raster path expresses in megabytes and this one cannot.
 *
 * A block is too small for a byte budget to bite before something else does, but "small" is not "free" and the
 * population is unbounded in principle: a screen whose text changes every build (a scrolling log, a timer) mints
 * a key per build and would otherwise grow this map until the age bound caught up 240 builds later. The cap
 * evicts the LEAST RECENTLY NAMED first, which is the same clock the age bound uses.
 */
export const GLYPH_BLOCK_MAX_ENTRIES = 512;

export interface GlyphBlockStats {
  /** Blocks held right now. */
  entries: number;
  /** Glyphs across them — the memory gauge, since a block's size is its glyph count. */
  glyphs: number;
  /** Exact bytes retained in the six owned typed arrays across all held blocks. */
  retainedBytes: number;
  /** Number of successful `put`s — each is one detached copy of the pooled glyph block. */
  copies: number;
  /** Exact typed-array bytes copied by those successful `put`s, cumulative. */
  copiedBytes: number;
  /** Builds that found a block and skipped layout, the cmap sweep and shaping entirely. */
  hits: number;
  /** …and the ones that had to do all three. On a settled screen this stops climbing. */
  misses: number;
  /** Dropped by the age bound or the entry cap. */
  evicted: number;
  /** Dropped whole, by a context loss. */
  invalidations: number;
}

/** One label's shaped runs, plus what the caller would otherwise have to re-derive to report the label. */
export interface GlyphBlockEntry {
  block: TextGlyphBlock;
  /** `layout.lines.length` — the paint-dump `T` record's line count, which a hit must not have to re-measure. */
  lines: number;
}

export interface GlyphBlockCache {
  /**
   * The key for one label, or null when the spec cannot produce a stable one.
   *
   * Exposed rather than inlined at the call site because the key IS the contract — a caller that spelled it
   * differently from the cache would get a permanent miss and no error.
   */
  keyFor(spec: TextSpec, faceUrl: string, spans: readonly TextSpan[] | undefined): string;
  /** The block for this key, or null — NAMING it for the build in progress either way, exactly like `boxFor`. */
  get(key: string): GlyphBlockEntry | null;
  /** Keep an OWNED copy of `block` (the caller's is pooled) and answer it. */
  put(key: string, block: TextGlyphBlock, lines: number): GlyphBlockEntry;
  /** Age the clock and run the evictor. Called from the renderer's `endBuild`, never from a patch frame. */
  endBuild(): void;
  /** A context loss: the atlas the slot ids name is gone. */
  invalidate(): void;
  stats(): GlyphBlockStats;
}

/** A block with its own storage, sliced to what the run actually uses — the pooled one is refilled next label. */
function ownCopy(block: TextGlyphBlock): TextGlyphBlock {
  const runs = Math.max(0, block.runCount);
  let glyphs = 0;
  for (let i = 0; i < runs; i++) {
    const end = block.spans[i * 2] + block.spans[i * 2 + 1];
    if (end > glyphs) {
      glyphs = end;
    }
  }
  return {
    runCount: runs,
    origins: block.origins.slice(0, runs * 2),
    spans: block.spans.slice(0, runs * 2),
    colors: block.colors.slice(0, runs * 4),
    spreads: block.spreads.slice(0, runs),
    // THE SPANS ARE INDICES INTO THESE, so the copy is taken to the high-water mark of the spans rather than to
    // `runCount * something`: an outlined label's three runs SHARE one span, and a shadow run can name a span the
    // run before it already covered.
    slots: block.slots.slice(0, glyphs),
    positions: block.positions.slice(0, glyphs * 2),
    pixelsPerEm: block.pixelsPerEm,
    blockScale: block.blockScale
  };
}

function glyphsIn(block: TextGlyphBlock): number {
  return block.slots.length;
}

/** The exact owned ArrayBufferView payload; object headers are engine-private and therefore not guessed at. */
function typedArrayBytes(block: TextGlyphBlock): number {
  return (
    block.origins.byteLength +
    block.spans.byteLength +
    block.colors.byteLength +
    block.spreads.byteLength +
    block.slots.byteLength +
    block.positions.byteLength
  );
}

export function createGlyphBlockCache(
  options: { evictAfterBuilds?: number; maxEntries?: number } = {}
): GlyphBlockCache {
  interface Held extends GlyphBlockEntry {
    lastNamedBuild: number;
  }
  const held = new Map<string, Held>();
  const evictAfter = options.evictAfterBuilds ?? GLYPH_BLOCK_EVICT_AFTER_BUILDS;
  const maxEntries = Math.max(1, options.maxEntries ?? GLYPH_BLOCK_MAX_ENTRIES);
  let build = 0;
  const stats: GlyphBlockStats = {
    entries: 0,
    glyphs: 0,
    retainedBytes: 0,
    copies: 0,
    copiedBytes: 0,
    hits: 0,
    misses: 0,
    evicted: 0,
    invalidations: 0
  };

  function evictOverCap(): void {
    while (held.size > maxEntries) {
      // The least recently NAMED, found by a scan: the map is capped in the hundreds and this runs once per build,
      // so an intrusive LRU list would be more bookkeeping than the thing it saves.
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of held) {
        if (entry.lastNamedBuild < oldestAt) {
          oldestAt = entry.lastNamedBuild;
          oldestKey = key;
        }
      }
      if (oldestKey === null) {
        return;
      }
      held.delete(oldestKey);
      stats.evicted++;
    }
  }

  return {
    keyFor(spec, faceUrl, spans) {
      // RAW NUL SEPARATORS, exactly as `textDigest`'s are and for its reason: a face url is streamed data and a
      // printable separator would let one impersonate a field boundary. (Which also puts this file in the
      // family `grep` reports as binary — use `grep -a`.)
      //
      // `0` in the SCALE field and not the label's real one — see the header: a shaped run is scale-free, and a
      // key that carried the pose would miss on every frame of every animated label.
      return `g ${faceUrl} ${spec.blockScale} ${textDigest(spec, 0, spans)}`;
    },

    get(key) {
      const entry = held.get(key);
      if (entry === undefined) {
        stats.misses++;
        return null;
      }
      entry.lastNamedBuild = build;
      stats.hits++;
      return entry;
    },

    put(key, block, lines) {
      const owned = ownCopy(block);
      const entry: Held = { block: owned, lines, lastNamedBuild: build };
      held.set(key, entry);
      stats.copies++;
      stats.copiedBytes += typedArrayBytes(owned);
      evictOverCap();
      return entry;
    },

    endBuild() {
      build++;
      if (evictAfter <= 0) {
        return;
      }
      for (const [key, entry] of held) {
        if (build - entry.lastNamedBuild >= evictAfter) {
          held.delete(key);
          stats.evicted++;
        }
      }
    },

    invalidate() {
      if (held.size > 0) {
        stats.invalidations++;
      }
      held.clear();
    },

    stats() {
      stats.entries = held.size;
      let glyphs = 0;
      let retainedBytes = 0;
      for (const entry of held.values()) {
        glyphs += glyphsIn(entry.block);
        retainedBytes += typedArrayBytes(entry.block);
      }
      stats.glyphs = glyphs;
      stats.retainedBytes = retainedBytes;
      return { ...stats };
    }
  };
}
