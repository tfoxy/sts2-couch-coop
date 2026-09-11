// CANVAS TEXT RASTERS — a laid-out label in, an uploaded GL texture out.
//
// The FOURTH population of textures in the stage's shared `CanvasTextureCache`, after `textureBridge`'s page urls,
// `fxSurfaces`' effect canvases and `spineSurfaces`' clip stills. Its shape is argued the same way that one was —
// by saying why neither of the existing registries would do:
//
//   * NOT `textureBridge`. The bridge's population is URLS the host serves and whose bytes arrive asynchronously.
//     A label has no url and no fetch; its pixels are produced synchronously, by us, inside the build.
//   * NOT `fxSurfaces`. That registry keys per NODE because a gsw surface's pixels are mutable and dirty again next
//     frame. A label's pixels are IMMUTABLE for as long as its text and style hold, and are SHARED by every node
//     that draws the same words — so this keys by a digest of the raster descriptor, like `spineSurfaces` keys by
//     clip url.
//
// ---------------------------------------------------------------------------------------------------------------
// WHY A REGISTRY AT ALL, measured rather than assumed (scripts/probe-text-census.mjs).
//
// It is NOT cross-node sharing. That is real but small: 1.00-1.29x on the six standard screens, because a screen's
// labels mostly say different things. The argument is CROSS-BUILD reuse. Those screens carry 15-52 labels that are
// re-drawn on EVERY build, while their pixels change 0-64 times per THIRTY SECONDS — the shop, the map and the
// removal screen change zero times. So the digest is what turns a per-build raster into a per-change one, and the
// hit rate on a settled screen is ~100%.
//
// That also decides where the cache check goes: the caller computes the digest from the SPEC, which needs no
// measurement, and a hit skips line breaking entirely. Laying the text out first and then discovering it was
// already rastered would pay the measurement cost this exists to avoid.
//
// ---------------------------------------------------------------------------------------------------------------
// THE SCRATCH CANVAS IS DELIBERATELY *NOT* `willReadFrequently`, and that is the opposite of `atlasRepack`.
//
// The re-packer hard-codes `willReadFrequently: true` because it reads pixels back on the CPU. This canvas is
// only ever a `texImage2D` SOURCE: nothing calls `getImageData` on it, ever. Asking for the read-optimised
// context would force a CPU-backed surface and make every upload a readback — the exact cost the flag exists to
// avoid in the other direction. If a future change needs to read these pixels, changing this flag is not the fix;
// the fix is a second canvas.
//
// ---------------------------------------------------------------------------------------------------------------
// A REFUSAL IS NOT A LOSS — the same property that lets `spineSurfaces` set tight caps. Everything here is an
// optimisation of a label that already renders: if this registry paces, refuses or declines, no quad is emitted,
// the DOM overlay keeps its element, and the label paints exactly as it does today.
//
// ---------------------------------------------------------------------------------------------------------------
// ATLAS PACKING (R6 P6-D2). The promotion criterion this module wrote for itself has been MET, so labels now share
// pages by default.
//
// The criterion was: pack when `flushes.textureSlots` rises by more than 8 per build, when more than 128 labels
// are resident, or when acquires are paced at the count cap for 3 consecutive builds. The first of those was
// measured at +20 and +45 per build against the +8 budget, and it is the one that matters: gsw's batcher holds 16
// textures per batch and NEVER reorders, so once a screen's labels exceed the slot table the batcher flushes
// mid-list and the text arm costs more draw calls than it saves.
//
// THE PAGE IS 1024x1024, and the number is measured (`scripts/probe-text-census.mjs --raster-hist`, R6 P6-D1):
// across the six standard screens at every raster scale a device actually picks (1-1.5; the stage transform
// divides by DPR while `rasterScaleFor` multiplies by it, so they largely cancel and scale 3 is the pathological
// arm, not the operating point) a whole screen's labels fit ONE page with ZERO oversize rects. 512 spills to 2-4
// pages and starts producing oversize rects at scale 1.5; 2048 always fits but carries 1.7-37% ink, i.e. a 16 MB
// allocation for under a megabyte of glyphs.
//
// THE KEY SPACE IS UNCHANGED, which is what keeps this change confined to this file plus two lines in
// `emitTextQuad`. A label is still `text://<digest>` to everything outside — the bridge, the draw list, a paint
// dump — and `handleFor` simply answers the PAGE's handle for a digest that lives on one. The page's own key
// (`txp://<n>`) never escapes this module, exactly as `atlasRepack`'s `rp://` keys never escape that one.
//
// THE ALLOCATOR is shelf next-fit with a bounded best-fit-by-height retry, shelf heights quantized to 8px so a row
// of similar labels shares a shelf instead of minting one each. A 1px GUTTER separates rects, and the argument is
// `atlasRepack`'s verbatim: the sampler is LINEAR + CLAMP_TO_EDGE, so a texel at a region's border blends with its
// neighbour — and the gutter is a CLEARED texel (the page is allocated zeroed), never a neighbour's pixel. The
// label's own 1px ink margin is INSIDE its rect and does a different job (it stops a glyph's antialiased edge
// being clipped by the raster bound).
//
// A rect too big for a page keeps its own texture, on exactly the path every label took before this existed —
// counted as `dedicated`, so "the atlas is not helping this screen" is a reading rather than an inference.
//
// WHAT THIS DOES NOT DO IS RECLAIM. A shelf allocator cannot free an arbitrary rect, so an evicted label's space
// stays spent until its whole page goes. `pageLiveFraction` is the instrument for whether that matters.
//
// ---------------------------------------------------------------------------------------------------------------
// PARTIAL-PAGE RECLAMATION (R6 P6-D3's second half): MEASURED, DECIDED AGAINST, AND FILED — with the number, so
// re-opening it is a matter of the number changing rather than of somebody's taste.
//
// The proposal was: a page under 50% live gets RETIRED AND REFILLED — it takes no new allocations, a couple of
// labels per build are told their box is gone, and the callers re-lay-out onto a fresh page. It is not built, and
// the reason is that the measurement says there is nothing to migrate.
//
// `scripts/probe-text-census.mjs --raster-hist` runs the shelf allocator offline over the six standard screens.
// At the shipped 1024 page and the scale a desktop actually picks, EVERY screen fits ONE page with ZERO oversize
// rects, and that page is 7.0-17.7% live; at the 1.5 a phone picks, still one page, 15.3-38.6% live. So the low
// live fraction is not a symptom of ghosts accumulating — it is the page being an order of magnitude larger than
// one screenful of glyphs needs, which is the same fact that made 1024 the right choice in the first place.
//
// Which turns the cure into the disease. Reclaiming means retiring a page while its survivors re-acquire onto a
// new one, so the peak is TWO pages — a transient +4 MB — spent to reclaim under 4 MB of a 24 MB ceiling that the
// measurement says is never approached (one page, always). And +4 MB transient is exactly the currency that has
// been shown to matter: renderer memory is what kills the arm on a device, and a spike is worse than a plateau.
//
// RE-OPEN WHEN, precisely: `pages >= 3` with `pageLiveFraction < 0.5` on a SETTLED screen, or `atlasFull > 0` at
// all. The first says pages really are accumulating ghosts rather than just being roomy; the second says the byte
// ceiling has started binding, which the design does not expect and which would make the trade different.
//
// A SMALLER FIRST PAGE (512, growing to 1024 on spill) is filed and NOT built for a separate reason: at 512 the
// same screens need 1-4 pages and start producing oversize rects at the phone's own raster scale, so it trades a
// measured "one page, one bind" for an unmeasured multi-page path — while the thing under measurement is the flip.
// Never move the thing under measurement.

import type { CanvasTextureCache, ExecutorTexture } from "@godot-scene-web/canvas";

import {
  baselineOf,
  type MeasureText,
  type TextLayout,
  type TextLineMetrics,
  type TextSpan,
  type TextSpec
} from "@/mirror/canvas/textLayout";

/** The key-space prefix that tells `textureBridge` a key belongs to this registry rather than to a page url. */
export const TEXT_KEY_PREFIX = "text://";

/**
 * Default RESIDENT byte ceiling for label rasters.
 *
 * 24 MB. The offline census puts a whole screen's final-state text under 0.7 MB at scale 1 (box-bound, so the real
 * figure is lower), and the worst case this has to survive is scale 3 on the busiest screen — 52 labels at 9x the
 * area, still an order of magnitude inside this. The ceiling is therefore not expected to bind at all; it is here
 * so that a pathological screen degrades to "some labels stay on the overlay" instead of to an OOM.
 */
export const TEXT_PACE_BYTES_DEFAULT = 24 * 1024 * 1024;

/**
 * Default per-build upload COUNT cap.
 *
 * Eight. Unlike a spine still (11.76 MB at p90, ~40 ms of submit), a label raster is a few KB and its upload is
 * dominated by the fixed ~0.164 ms call overhead — so the cap is about not paying for a whole screen's first
 * paint in one build, not about bytes. Eight lands a 52-label screen over ~7 builds, and every label not yet
 * landed is still drawn by the overlay in the meantime.
 */
export const TEXT_PACE_COUNT_DEFAULT = 8;

/** How many builds a digest can go un-named before its texture is released. `textureBridge`'s clock. */
export const TEXT_EVICT_AFTER_BUILDS = 240;

/** A 1px skirt around the ink box so a glyph's antialiased edge is never clipped by the texture bound. */
const INK_MARGIN_PX = 1;

/**
 * ROUND 7's scratch-probe selection band, in device px — the default for {@link TextSurfaceOptions.scratchMaxTexW}.
 *
 * Named rather than inlined because a committed photograph is scored against it: `?textScratchProbe=1` has to keep
 * producing round 7's sample exactly, and a band that drifted would quietly re-select the population under a name
 * that says it did not.
 */
export const SCRATCH_MAX_TEX_W_DEFAULT = 24;

/**
 * The label atlas page, square, in device pixels — 4 MB of RGBA. Measured, not guessed: see the header, and
 * `scripts/probe-text-census.mjs --raster-hist` for the distribution it was chosen against.
 */
export const TEXT_PAGE_DIM = 1024;

/**
 * Cleared texels between packed rects. ONE is enough, and the proof is the sampler's: LINEAR + CLAMP_TO_EDGE
 * blends a border texel with its neighbour, and this page is allocated ZEROED — so the worst a blend can reach is
 * transparent black, never another label's ink. (`atlasRepack` makes the identical argument for its own apron.)
 */
export const TEXT_ATLAS_GUTTER = 1;

/** Shelf heights are rounded up to this, so a row of similar labels shares one shelf instead of minting each. */
export const TEXT_SHELF_QUANTUM = 8;

/** The page key space. NEVER escapes this module — `handleFor` answers a page handle under the label's own key. */
const PAGE_KEY_PREFIX = "txp://";

function pageKeyFor(index: number): string {
  return `${PAGE_KEY_PREFIX}${index}`;
}

/** Fallback font metrics when a context reports no `fontBoundingBox*` — ~ the ratios of a typical Latin face. */
const FALLBACK_ASCENT_RATIO = 0.8;
const FALLBACK_DESCENT_RATIO = 0.2;

export function textKeyFor(digest: string): string {
  return TEXT_KEY_PREFIX + digest;
}

export function textDigestFromKey(key: string): string | null {
  return key.startsWith(TEXT_KEY_PREFIX) ? key.slice(TEXT_KEY_PREFIX.length) : null;
}

/**
 * Where a label's raster sits, and how big it is.
 *
 * `dx`/`dy`/`w`/`h` are in the label's own BOX space (design px) — the quad's placement is
 * `record.transform · scale(blockScale about the box centre) · translate(dx, dy)` with a `w x h` box, so nothing
 * downstream re-derives a placement. `texW`/`texH` are the texture's device pixels, which is `w x h` times the
 * raster scale, and the two are kept separate precisely so a scale change cannot silently move the quad.
 */
export interface TextRasterBox {
  dx: number;
  dy: number;
  w: number;
  h: number;
  texW: number;
  texH: number;
  /**
   * WHERE the raster sits in the texture `handleFor` answers — `(0, 0)` for a label on its own dedicated texture,
   * and its packed origin for one on an atlas page. The quad's source rect is `(texX, texY, texW, texH)`, so this
   * is the only thing `emitTextQuad` needed in order to stop assuming a label owns its whole texture.
   */
  texX: number;
  texY: number;
  /**
   * How many LINES the label broke into — retained purely so the parity gate can read it off a cache hit.
   *
   * The bench's `T` records report a line count per label, and on the DOM arm it is measured from the element
   * (`scrollHeight / lineHeight`). A canvas-drawn label has no element, so the count has to survive here: a hit
   * skips the layout entirely, and re-laying-out just to count lines would undo the saving the cache exists for.
   */
  lines: number;
}

export interface TextSurfaceStats {
  /** Distinct digests this registry has been asked for. */
  surfaces: number;
  /** Digests holding a live uploaded texture right now. */
  resident: number;
  /** Resident RGBA bytes across those textures — this registry's share of the shared cache. */
  bytes: number;
  uploads: number;
  /** Total main-thread ms spent RASTERING (the 2D draw), separate from the upload submit. */
  rasterMs: number;
  /** Total main-thread ms inside `texImage2D` — SUBMIT cost only, never quotable as the GPU's bill. */
  uploadMs: number;
  maxUploadMs: number;
  /** Acquires held back because the build had already spent its upload COUNT. */
  paced: number;
  /** Acquires refused because uploading would breach the resident byte ceiling. */
  refusedForBudget: number;
  /** Digests refused for exceeding `maxTextureDim`, or which the driver would not take. Never retried. */
  declined: number;
  evicted: number;
  /**
   * TWO DIFFERENT SPECS THAT PRODUCED THE SAME DIGEST. Must stay 0.
   *
   * The digest is the full descriptor NUL-joined, not a hash, so a collision should be impossible by
   * construction — this counter is what turns "should be" into "is". A non-zero reading means two labels are
   * sharing one texture and at least one of them is drawing the wrong pixels, which is a silent-wrong failure and
   * exactly the kind that needs an instrument rather than an argument.
   */
  digestCollisions: number;
  /**
   * FACES REFUSED AND STILL UNRESOLVED, RIGHT NOW — a GAUGE, not a total.
   *
   * The flip criterion is written against this number ("`fontsPending` 0 on a settled screen"), so it has to be
   * capable of returning to zero. Until R8 it could not: it was a cumulative per-attempt-per-build counter that
   * was incremented at one site and never decremented, so a healthy warm-up in which every face arrived within a
   * few builds still read 45 at settle and the criterion could only ever fail. That reading is kept, honestly
   * named, as {@link fontWaits}.
   *
   * What it counts now is DISTINCT `cssFont` strings that have been refused and whose load has not since come
   * back. A face's load resolving removes it; a load rejecting moves it to {@link fontsFailed}. So non-zero at
   * settle really does mean "a face this screen wants has not arrived", which is what the criterion always meant.
   *
   * The refusal itself is not a failure and not a pacing: a raster taken before the face arrives would bake the
   * browser's fallback typeface into a texture that is then reused for as long as the label says the same words
   * — permanently wrong pixels, not a slow first frame. The label stays on the DOM overlay (where a late face
   * re-renders for free) and the load's resolution arms a repaint.
   */
  fontsPending: number;
  /**
   * CUMULATIVE REFUSAL ATTEMPTS — every acquire the readiness gate turned away, counted once per attempt per
   * build. NOT a number of stuck faces, and no criterion is written against it.
   *
   * Worth keeping because it is the only reading that says how much WORK the gate did: 45 here with
   * {@link fontsPending} 0 is a healthy warm-up in which a handful of faces were asked for over a handful of
   * builds, and the same 45 with `fontsPending` 3 is three faces that never came. Neither statement is available
   * from either number alone, which is why both are published.
   */
  fontWaits: number;
  /**
   * Distinct faces whose `load` REJECTED — a host that cannot serve the font.
   *
   * Its own guardrail, and a different failure from {@link fontsPending}: those labels will never be rastered
   * however long the screen sits there, so they keep their overlay element forever. Expected 0; non-zero is a
   * serving problem rather than a timing one, and the two must not be summed into one "fonts are unhappy" number.
   */
  fontsFailed: number;
  paceBytes: number;
  paceCount: number;
  /** Atlas pages allocated (R6 P6-D2). Each is {@link TEXT_PAGE_DIM} squared of RGBA — 4 MB at 1024. */
  pages: number;
  /** The page dimension in force, so a census can never be read against the wrong page size. */
  pageDim: number;
  /** Labels on a texture of their own because no page could hold them — each one is a bind the atlas did not save. */
  dedicated: number;
  /**
   * Fraction of allocated page area currently carrying a LIVE label's rect, 0-1.
   *
   * The number reclamation has to answer for. A shelf allocator cannot free an arbitrary rect, so an evicted
   * label's space stays spent until its whole page goes: a low reading on a settled screen means pages are mostly
   * holding the ghosts of labels that are gone.
   */
  pageLiveFraction: number;
  /**
   * Labels refused because placing them would have needed a page the byte ceiling will not allow.
   *
   * Not a failure: the label keeps its overlay element, exactly as for any other refusal here. It IS the signal
   * that the ceiling is binding, which the design does not expect it to.
   */
  atlasFull: number;
  /**
   * Pages released because nothing live was left on them (R6 P6-D3).
   *
   * The only thing in this module that ever frees a page allocation — a shelf cannot take an arbitrary rect back,
   * so without this a session that walks through screens grows by a page per screenful of labels and never
   * shrinks. Reclaiming a PARTIALLY live page is a different and larger decision; see `pageLiveFraction`.
   */
  retiredPages: number;
  /**
   * Labels whose text measured a DIFFERENT width at raster time than the width the caller laid them out with.
   *
   * Must be 0. The raster surface is sized from the caller's measurement and the glyphs are drawn with whatever
   * font the context resolves at draw time; if those disagree the ink is drawn outside the surface allocated for
   * it and the label is clipped to a fragment. A non-zero reading is that failure, and `metricsSamples` says by
   * how much and on what face.
   */
  metricsMismatch: number;
  /** Up to eight witnesses for {@link metricsMismatch}, each carrying both widths and the face involved. */
  metricsSamples: { chars: number; laidOut: number; atRaster: number; cssFont: string; fontReady: boolean | null }[];
  /**
   * THE BISECT SEAM (`?textScratchProbe=<n>`, diagnostic only, empty otherwise).
   *
   * The scratch canvas read back RIGHT AFTER the label is drawn and BEFORE it is uploaded, with the atlas
   * coordinates the upload then wrote it to. That is the one observation that splits the missing-ink defect in
   * two: if the scratch already holds a fragment the RASTERIZER drew it wrong, and if the scratch holds the label
   * then the upload or the region write put the wrong pixels on the page. Keyed by `texX`/`texY` so a sample can
   * be matched against a paint dump's `src` rect exactly, with no guessing about which label is which.
   *
   * ROUND 7 ANSWERED THAT BISECT — the scratch is already wrong — so round 8's job is to name the TERM, and the
   * sample carries the whole arithmetic rather than just the picture. The added fields exist to discriminate
   * between two mechanisms that produce the same photograph:
   *
   *   * A SIZING term. `ink`/`rasterScale`/`laidOutW` are every input `texW = ceil(ink.w * rasterScale)` has, so a
   *     surface that is too small for the ink it was asked to hold can be shown to be too small ARITHMETICALLY.
   *   * A FONT-RESOLUTION term. `ctx.font` resolves its face AT ASSIGNMENT, and this module memoizes the
   *     assignment (see `setFont`) on a context SHARED with `measureFor`. So the measurement that SIZED the
   *     surface and the font that DREW into it can be different faces without a single number disagreeing at
   *     measure time. `memoWasSet`/`fontBefore`/`fontAfter` witness the memo's state across the resize, and
   *     `preW`/`postW`/`postAscent`/`postDescent` re-ask the SAME questions on either side of it: a pre-resize
   *     measure that disagrees with a post-resize one is a face that changed underneath the memo.
   *
   * `metricsMismatch` cannot answer the second question and never could — both of ITS measurements are taken
   * before the resize, so they agree with each other whatever face is in force.
   */
  scratchSamples: {
    texX: number;
    texY: number;
    texW: number;
    texH: number;
    dataUrl: string;
    /** The ink box `texW`/`texH` were derived from, in box space. */
    ink: { dx: number; dy: number; w: number; h: number };
    /** The scale that multiplied it. `ceil(ink.w * rasterScale) === texW` is checkable from the row alone. */
    rasterScale: number;
    cssFont: string;
    /** The face's own line metrics as read at ACQUIRE time, before the resize. */
    ascent: number;
    descent: number;
    /** `layout.lines[0].width` — the width the CALLER laid the label out with, via `measureFor`. */
    laidOutW: number;
    /** The same line re-measured at acquire time, BEFORE the resize. This is `metricsMismatch`'s own reading. */
    preW: number;
    /** Was the memo already claiming this `cssFont` on entry? The poisoning witness. */
    memoWasSet: boolean;
    /** `ctx.font` immediately BEFORE the resize that clears the context's state. */
    fontBefore: string;
    /** `ctx.font` immediately AFTER the post-resize re-assignment the draw actually runs under. */
    fontAfter: string;
    /** The first line re-measured AFTER the resize — under the font the draw uses. */
    postW: number;
    /** `fontBoundingBox*` re-read after the resize, likewise under the draw's own font. */
    postAscent: number;
    postDescent: number;
  }[];
}

/** The seam `textureBridge` delegates `text://` keys through. */
export interface TextTextureSource {
  handleFor(digest: string): ExecutorTexture | null;
  sizeOf(digest: string): { width: number; height: number } | null;
}

export interface TextSurfaceRegistry extends TextTextureSource {
  /**
   * The resident raster for this digest, or null — NAMING it for the build in progress either way.
   *
   * The cheap path, and the one that runs on a settled screen: a hit means the caller skips line breaking and
   * measurement entirely. Naming happens on a miss too, so a digest that is being paced does not also age out.
   */
  boxFor(digest: string): TextRasterBox | null;
  /**
   * RASTER and upload this label. `null` means "no quad this build" — the overlay keeps its element.
   *
   * Called only after `boxFor` missed, so the caller has already paid for the layout by the time it gets here.
   */
  acquire(
    digest: string,
    spec: TextSpec,
    layout: TextLayout,
    rasterScale: number,
    spans?: readonly TextSpan[]
  ): TextRasterBox | null;
  /** A width measurer bound to this font, for `layoutText`. Null when there is no 2D context to measure with. */
  measureFor(cssFont: string): MeasureText | null;
  /**
   * THE FACE'S OWN LINE BOX for this shorthand — measured once, cached, and `null` rather than approximated.
   *
   * Published because the GLYPH path needs the same two numbers this module's `acquire` reads off the context, and
   * has no context of its own to ask (hb-gpu draws outlines; it never opens a 2D canvas). Both backends place a
   * baseline with `baselineOf`, so a label that moves between them must not move on screen — and it only does not
   * if both are given the SAME face's metrics.
   *
   * NULL HAS THREE CAUSES AND NONE OF THEM IS "USE A DEFAULT": no 2D context at all, a face that has not loaded
   * yet (`measureText` would answer for the browser's fallback, which is a WRONG ascent rather than a missing
   * one — the same reason `acquire` refuses to raster there), and a context that reports no `fontBoundingBox*`.
   * The caller's answer to null is to refuse the label and count it.
   */
  lineMetricsFor(cssFont: string): TextLineMetrics | null;
  /** Close the build: bank the count cap and evict what the scene stopped naming. */
  endBuild(): void;
  /** CONTEXT LOSS: every digest forgets its upload WITHOUT touching the dead driver. */
  invalidate(): void;
  stats(): TextSurfaceStats;
  dispose(): void;
}

export interface TextSurfaceOptions {
  cache: CanvasTextureCache;
  paceBytes?: number;
  paceCount?: number;
  /**
   * The atlas page dimension, or `0` to give every label its own texture (`?textAtlas=off`).
   *
   * The off arm is what makes the promotion criterion re-checkable: the whole argument for packing is a measured
   * texture-slot flush rate, and a measurement needs both halves. It is also the fallback if the pages ever cost
   * more than the binds they remove. Defaults to {@link TEXT_PAGE_DIM}.
   */
  pageDim?: number;
  /** The context's `MAX_TEXTURE_SIZE`. A larger raster is refused rather than uploaded incomplete (black). */
  maxTextureDim?: number;
  evictAfterBuilds?: number;
  /**
   * The scratch canvas factory. Overridable for tests, which have no real 2D context — and NOT a way to pass a
   * read-optimised canvas in: see the module header for why this one must not be `willReadFrequently`.
   */
  createCanvas?: () => HTMLCanvasElement;
  /**
   * The FONT READINESS oracle — `document.fonts` in a browser, injectable for tests.
   *
   * `null` (and an environment with no `FontFaceSet` at all) means "cannot tell", and the path then rasters
   * rather than refusing forever: a gate that can never open would be worse than the fallback it guards against.
   * Every browser this ships to has the API, so that arm is the test environment's.
   */
  fonts?: FontReadiness | null;
  /**
   * A face this registry was waiting on has LOADED. The caller arms a repaint so the label re-rasters.
   *
   * NEVER ACKS — `onSpineReady`'s contract verbatim. A font load is not a scene delta, and answering the wire's
   * ack from one would tell MirrorView a frame was presented for state it never saw.
   */
  onFontReady?: () => void;
  /**
   * Read each label's scratch canvas back before uploading it (`?textScratchProbe=<n>`). DIAGNOSTIC ONLY — a
   * `toDataURL` per acquire is exactly the readback this module is otherwise careful never to do.
   */
  captureScratch?: boolean;
  /**
   * The scratch probe's SELECTION BAND: only rasters at most this many device px wide are sampled.
   *
   * Defaults to {@link SCRATCH_MAX_TEX_W_DEFAULT}, which is round 7's band verbatim — `?textScratchProbe=1` must
   * keep reproducing that round's sample byte for byte, because the committed bisect photograph is scored against
   * it. Widening it (`?textScratchProbe=64`) is what puts the BROKEN SIBLINGS in: the same shop shelf carries a
   * 28-wide label that is wrong in exactly the same way and that round 7's band could not see, and "identical
   * font, identical scale, adjacent acquires, some right and some wrong" is the observation the round turns on.
   */
  scratchMaxTexW?: number;
}

/** The half of `FontFaceSet` this module uses. See {@link TextSurfaceOptions.fonts}. */
export interface FontReadiness {
  check(font: string): boolean;
  load(font: string): Promise<unknown>;
}

interface Surface {
  digest: string;
  uploaded: boolean;
  /** RGBA bytes this surface's OWN texture holds — 0 for a label packed onto a page (the page owns the bytes). */
  bytes: number;
  /** Which atlas page holds it, or null for a dedicated texture. See {@link TextRasterBox.texX}. */
  pageIndex: number | null;
  box: TextRasterBox | null;
  declined: boolean;
  lastNamedBuild: number;
  /** The (text, font) this digest was FIRST rastered from — the collision detector. See `digestCollisions`. */
  witness: string;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function normalizeCap(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * HOW FAR A LABEL'S INK REACHES OUTSIDE ITS GLYPH RUN, per side, in box space.
 *
 * Split out of {@link inkBoxOf} so that a caller which cannot lay text out — an OFFLINE probe has no 2D context and
 * therefore no `measureText` — can still state the pad EXACTLY rather than guessing one. The parity harness
 * (`scripts/probe-text-crops.mjs`) crops per-label comparison windows out of a screenshot, and a guessed pad there
 * would either clip a shadow (and score a difference nobody drew) or swallow half the screen (and dilute every
 * RMSE toward zero). There is one definition of the pad and this is it.
 *
 * The outline is a CENTRED stroke, so half of it lands outside the glyph; the shadow displaces a full copy of the
 * ink (stroke included) by its offset, in one direction only.
 */
export function inkPadOf(spec: TextSpec): { padL: number; padR: number; padT: number; padB: number } {
  const shadowDx = spec.shadow?.dx ?? 0;
  const shadowDy = spec.shadow?.dy ?? 0;
  const spread = spec.outlinePx / 2 + INK_MARGIN_PX;
  return {
    padL: spread + Math.max(0, -shadowDx),
    padR: spread + Math.max(0, shadowDx),
    padT: spread + Math.max(0, -shadowDy),
    padB: spread + Math.max(0, shadowDy)
  };
}

/**
 * THE INK BOX of a laid-out label, in box space — what the raster has to cover.
 *
 * NOT the streamed box. Two reasons, and they pull in opposite directions, which is why this is computed rather
 * than assumed. Text can be SMALLER than its box (a 3-character counter in a wide plaque) and rastering the whole
 * box would waste most of the texture. Text can also be LARGER: an unbreakable word overflows, and an outline and
 * a shadow both add ink outside the glyph run. The DOM overlay does not clip either case (`.mirror-text` has no
 * overflow rule), so a box-sized raster would crop something the other backend shows.
 *
 * VERTICALLY it follows the CSS line box: a line of pitch P holds a font content box of `ascent + descent`
 * centred in it, so the ink of line i starts at `y_i + (P - content) / 2`. When the pitch is TIGHTER than the
 * content — which the End-Turn rule's `calc(0.79em + 1px)` deliberately is — that half-leading goes negative and
 * the ink correctly extends above the line box, which is what the browser does with it too.
 */
export function inkBoxOf(
  layout: TextLayout,
  spec: TextSpec,
  ascent: number,
  descent: number
): { dx: number; dy: number; w: number; h: number } {
  const contentH = ascent + descent;
  const halfLeading = (spec.pitchPx - contentH) / 2;
  const { padL, padR, padT, padB } = inkPadOf(spec);

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const line of layout.lines) {
    const top = line.y + halfLeading;
    if (line.x < minX) minX = line.x;
    if (line.x + line.width > maxX) maxX = line.x + line.width;
    if (top < minY) minY = top;
    if (top + contentH > maxY) maxY = top + contentH;
  }
  if (!Number.isFinite(minX)) {
    return { dx: 0, dy: 0, w: 0, h: 0 };
  }
  const dx = minX - padL;
  const dy = minY - padT;
  return { dx, dy, w: maxX - minX + padL + padR, h: maxY - minY + padT + padB };
}

export function createTextSurfaces(options: TextSurfaceOptions): TextSurfaceRegistry {
  const cache = options.cache;
  const surfaces = new Map<string, Surface>();
  const paceBytes = normalizeCap(options.paceBytes, TEXT_PACE_BYTES_DEFAULT);
  const paceCount = normalizeCap(options.paceCount, TEXT_PACE_COUNT_DEFAULT);
  const evictAfter = normalizeCap(options.evictAfterBuilds, TEXT_EVICT_AFTER_BUILDS);
  const maxTextureDim =
    options.maxTextureDim != null && Number.isFinite(options.maxTextureDim) && options.maxTextureDim > 0
      ? options.maxTextureDim
      : 0;

  const pageDim = normalizeCap(options.pageDim, TEXT_PAGE_DIM);
  const pageBytes = pageDim * pageDim * 4;

  let build = 0;
  let buildUploads = 0;
  let residentCount = 0;
  let dedicatedBytes = 0;
  let disposed = false;

  /**
   * ONE SHELF: a horizontal band of a page at a fixed height, filled left to right.
   *
   * `used` is how far along the band the next rect starts, gutter included. Rects are never removed from a shelf —
   * a shelf allocator cannot free an arbitrary one — so `used` only ever grows until the whole page goes.
   */
  interface Shelf {
    y: number;
    height: number;
    used: number;
  }

  interface Page {
    index: number;
    key: string;
    shelves: Shelf[];
    /** The first free row below the last shelf. */
    bottom: number;
    /** RGBA bytes of the rects on this page that are still LIVE — the numerator of `pageLiveFraction`. */
    liveBytes: number;
  }

  /**
   * Live pages by index. A RELEASED slot is nulled rather than spliced, because a surface remembers its page by
   * index — and the slot is then reused by the next allocation, so the `txp://` key space stays bounded.
   */
  const pages: (Page | null)[] = [];

  function livePages(): number {
    let n = 0;
    for (const page of pages) {
      if (page !== null) n++;
    }
    return n;
  }

  /** Pages plus dedicated textures: this registry's whole share of the shared cache. */
  function residentBytesNow(): number {
    return livePages() * pageBytes + dedicatedBytes;
  }

  /**
   * A page with nothing live on it is pure waste — and, before this, permanent waste: a shelf cannot take a rect
   * back, so nothing else in this module ever frees an allocation. Without it a session that walks through screens
   * accumulates 4 MB per screenful of labels for as long as it runs.
   *
   * Only the EMPTY case, deliberately. Reclaiming a PARTIALLY live page means retiring it and migrating the
   * survivors, which is a real cost paid against a measurement this module does not have yet (see the header's
   * note on `pageLiveFraction`). Empty needs no such argument: there is nothing to migrate.
   */
  function releaseEmptyPages(): void {
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (page === null || page.liveBytes > 0) {
        continue;
      }
      cache.release(page.key);
      pages[i] = null;
      stats.retiredPages++;
    }
  }

  /**
   * Find a home for a `w x h` rect (gutter already added by the caller), allocating a page if one is needed and
   * the byte ceiling allows it. Null = no room; the caller falls back to a dedicated texture or refuses.
   *
   * Next-fit across existing pages with a BEST-FIT-BY-HEIGHT choice among the shelves of each — a short label must
   * not open a tall shelf, which is the failure mode that turns one page into three.
   */
  function placeRect(w: number, h: number): { page: Page; x: number; y: number } | null {
    for (const page of pages) {
      if (page === null) {
        continue;
      }
      let best: Shelf | null = null;
      for (const shelf of page.shelves) {
        if (shelf.height < h || shelf.used + w > pageDim) {
          continue;
        }
        if (best === null || shelf.height < best.height) {
          best = shelf;
        }
      }
      if (best !== null) {
        const x = best.used;
        best.used += w;
        return { page, x, y: best.y };
      }
      if (page.bottom + h <= pageDim) {
        const shelf: Shelf = { y: page.bottom, height: h, used: w };
        page.shelves.push(shelf);
        page.bottom += h;
        return { page, x: 0, y: shelf.y };
      }
    }
    // A NEW PAGE. Charged against the same resident ceiling every other texture here is: a page is 4 MB whether
    // one label or two hundred sit on it, and the ceiling exists so a pathological screen degrades to "some
    // labels stay on the overlay" rather than to an OOM.
    if (paceBytes > 0 && residentBytesNow() + pageBytes > paceBytes) {
      return null;
    }
    // Reuse a released slot if there is one, so a session that walks through screens does not mint an unbounded
    // run of `txp://` keys — and so a surface's remembered index can never point at a page that has moved.
    const freeSlot = pages.indexOf(null);
    const index = freeSlot >= 0 ? freeSlot : pages.length;
    const key = pageKeyFor(index);
    try {
      // ZEROED and declared PREMULTIPLIED, which is what makes the gutter argument hold: an untouched texel is
      // transparent black, so a LINEAR blend at a rect's border can only ever reach nothing. `acquireBytes`
      // specifies the storage, which is the precondition `updateRegion` refuses without.
      cache.acquireBytes(key, new Uint8Array(pageBytes), pageDim, pageDim, { premultiplied: true });
    } catch {
      return null; // no page, no atlas: the caller takes the dedicated path
    }
    const page: Page = { index, key, shelves: [{ y: 0, height: h, used: w }], bottom: h, liveBytes: 0 };
    if (freeSlot >= 0) {
      pages[freeSlot] = page;
    } else {
      pages.push(page);
    }
    return { page, x: 0, y: 0 };
  }

  const stats: TextSurfaceStats = {
    surfaces: 0,
    resident: 0,
    bytes: 0,
    uploads: 0,
    rasterMs: 0,
    uploadMs: 0,
    maxUploadMs: 0,
    paced: 0,
    refusedForBudget: 0,
    declined: 0,
    evicted: 0,
    digestCollisions: 0,
    fontsPending: 0,
    fontWaits: 0,
    fontsFailed: 0,
    paceBytes,
    paceCount,
    pages: 0,
    pageDim: 0,
    dedicated: 0,
    pageLiveFraction: 0,
    atlasFull: 0,
    retiredPages: 0,
    metricsMismatch: 0,
    metricsSamples: [],
    scratchSamples: []
  };
  const metricsSamples = stats.metricsSamples;
  const captureScratch = options.captureScratch === true;
  /**
   * How many samples a probe run may take. Raised 20 -> 32 for round 8, and the number is the WIDENED BAND's:
   * `?textScratchProbe=64` admits the broken 28-wide siblings that round 7's 24px band excluded, and the shop
   * shelf under investigation carries ~24 labels inside that band across the settling builds. At 20 the cap
   * bound before the shelf was complete, which would have made "the wide siblings are absent from the sample"
   * unreadable — cap or band, no way to tell. 32 clears the shelf with room, and the cost is bounded by the same
   * argument the seam already rests on: 32 `toDataURL` calls, once, on a diagnostic run nothing times.
   */
  const SCRATCH_SAMPLE_CAP = 32;
  /**
   * Only rasters THIS NARROW are sampled. The first pass at this seam took the first fourteen acquires and every
   * one of them was a label that renders correctly — so it proved that correct labels are correct and nothing
   * else. The labels that come out as a fragment are short strings whose rasters sit at 22x22, so selecting the
   * band rather than the order is what puts the population under investigation into the sample.
   */
  const scratchMaxTexW =
    options.scratchMaxTexW != null && Number.isFinite(options.scratchMaxTexW) && options.scratchMaxTexW > 0
      ? options.scratchMaxTexW
      : SCRATCH_MAX_TEX_W_DEFAULT;

  // The scratch canvas and its context, built lazily and reused for every raster: creating one per label would
  // dominate the cost this module exists to keep small. `null` once we have tried and failed, so a context-less
  // environment asks once rather than on every acquire.
  // THE FONT READINESS ORACLE. `document.fonts` when the caller did not supply one; `null` when there is no
  // FontFaceSet at all, which means "cannot tell" and lets the raster through — a gate that can never open would
  // be worse than the fallback it guards against.
  const fonts: FontReadiness | null =
    options.fonts !== undefined
      ? options.fonts
      : typeof document !== "undefined" && (document as Document & { fonts?: FontReadiness }).fonts
        ? ((document as Document & { fonts?: FontReadiness }).fonts as FontReadiness)
        : null;
  /** Faces a `load` is already in flight for, so a busy screen does not re-ask every build. */
  const fontLoads = new Set<string>();
  /** THE GAUGE's backing set: faces refused and not yet resolved. See `TextSurfaceStats.fontsPending`. */
  const unresolvedFonts = new Set<string>();
  /** …and the ones whose load REJECTED, which is a different failure and gets its own guardrail. */
  const failedFonts = new Set<string>();

  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let ctxTried = false;
  let ctxFont = "";

  function context(): CanvasRenderingContext2D | null {
    if (ctxTried) {
      return ctx;
    }
    ctxTried = true;
    const make = options.createCanvas ?? (() => document.createElement("canvas"));
    try {
      canvas = make();
      // NOT `willReadFrequently` — see the module header. This canvas is only ever a texImage2D SOURCE.
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    return ctx;
  }

  /**
   * Faces `fonts.check` has answered TRUE for at least once.
   *
   * Readiness is MONOTONIC — a loaded `FontFace` stays loaded and nothing in this client calls `fonts.clear()` —
   * so a positive answer never has to be re-asked and no generation counter is needed. That is what keeps the
   * memo's honesty down to one `Set.has` on the hot path.
   */
  const readyFonts = new Set<string>();

  /**
   * `fontBoundingBox*` by FONT SHORTHAND, measured once and kept — the memo `lineMetricsFor` exists to be cheap by.
   *
   * KEYED ON THE WHOLE SHORTHAND, size included, and NOT on a family whose ratio is then scaled. That is not
   * tidiness: Chrome returns these metrics as WHOLE PIXELS, so the ratio is not constant down the size ladder —
   * `kreon_regular` measures 12/3 at 12px (1.000 ascent), 14/4 at 14px (1.000) and 19/6 at 20px (0.950). A
   * one-size measurement scaled by `px/refPx` would reproduce none of those exactly, and "exactly" is the whole
   * requirement: the number has to match what the RASTER path reads at that same size or the two paths part.
   *
   * ONLY READY FACES ARE CACHED, on the same monotonic argument `readyFonts` rests on: a loaded `FontFace` stays
   * loaded, and nothing here calls `fonts.clear()`. A measurement taken before the face landed would be the
   * fallback's, which is the one answer this seam must never memoize.
   */
  const lineMetrics = new Map<string, TextLineMetrics>();

  function fontReady(cssFont: string): boolean {
    if (fonts === null) {
      // "CANNOT TELL", and the same arm the raster gate takes for the same reason: a memo that can never be
      // trusted would re-assign on every measure forever, in an environment that has no way to say otherwise.
      return true;
    }
    if (readyFonts.has(cssFont)) {
      return true;
    }
    if (fonts.check(cssFont)) {
      readyFonts.add(cssFont);
      return true;
    }
    return false;
  }

  /**
   * THE MEMO IS NO LONGER TRUE — say so, rather than letting the next `setFont` skip its write.
   *
   * Called wherever the context's font can move without going through {@link setFont}. There are exactly two such
   * places and they are both below; a third would have to call this, which is the point of naming it.
   */
  function forgetFont(): void {
    ctxFont = "";
  }

  /**
   * Declare the font, skipping the write when the context is already speaking it.
   *
   * THE SKIP IS THE WHOLE OPTIMISATION AND ALSO THE WHOLE HAZARD. `ctx.font` RESOLVES ITS FACE AT ASSIGNMENT: the
   * string is parsed once, matched against the faces available at that instant, and the result is what every
   * later `measureText`, `fillText` and `strokeText` speaks until something assigns again. So a skipped write is
   * only sound while the memo's string is still what the context would resolve — and there are two ways for that
   * to stop being true, both of which were live defects:
   *
   *   1. THE CONTEXT'S FONT MOVED WITHOUT US. `font` is part of a 2D context's drawing state, so `restore()`
   *      puts back whatever was in force at the matching `save()` — and this module's `save()` runs AFTER the
   *      resize that reset the context, so what it banks is `10px sans-serif`. That is the defect R8's probe
   *      measured in the field: nine of eleven fragment rasters on the shop screen were SIZED from a measurement
   *      taken at `10px sans-serif` and DRAWN with the label's real 46.8px face, four to five times larger than
   *      the surface allocated for them. {@link forgetFont} is the answer, at both sites.
   *
   *   2. THE FACE ARRIVED AFTER THE ASSIGNMENT. `measureFor` runs during the CALLER's layout, which is an
   *      argument expression at the acquire site and therefore happens before the readiness gate has said
   *      anything. A label measured while its face is still loading resolves to the fallback and is then
   *      refused; nothing draws, nothing restores, and the memo is left claiming a string the context did not
   *      really resolve. When the face lands, re-assignment of the SAME string is suppressed and the surface is
   *      sized from the fallback's metrics while the draw uses the face that has since arrived. So an UNREADY
   *      assignment is never memoized.
   *
   * The cost of (2) is one `Set.has` per call once a face is ready, and a re-assignment per measure only while it
   * is not — which is exactly the window in which the acquire gate is refusing the label anyway.
   */
  function setFont(c: CanvasRenderingContext2D, cssFont: string): void {
    if (ctxFont !== cssFont) {
      c.font = cssFont;
      ctxFont = fontReady(cssFont) ? cssFont : "";
    }
  }

  function surfaceFor(digest: string): Surface {
    let surface = surfaces.get(digest);
    if (surface === undefined) {
      surface = {
        digest,
        uploaded: false,
        bytes: 0,
        pageIndex: null,
        box: null,
        declined: false,
        lastNamedBuild: build,
        witness: ""
      };
      surfaces.set(digest, surface);
    }
    return surface;
  }

  function forgetTexture(surface: Surface): void {
    if (!surface.uploaded) {
      return;
    }
    surface.uploaded = false;
    residentCount--;
    if (surface.pageIndex !== null) {
      // The ALLOCATION is what is freed, not the space: the page's live total drops, but a shelf cannot take an
      // arbitrary rect back, so the room stays spent until the whole page goes. That gap is exactly what
      // `pageLiveFraction` measures.
      const page = pages[surface.pageIndex];
      if (page != null) {
        page.liveBytes -= surface.bytes;
      }
      surface.pageIndex = null;
    } else {
      dedicatedBytes -= surface.bytes;
    }
    surface.bytes = 0;
    surface.box = null;
  }

  function releaseTexture(surface: Surface): void {
    // A PAGED label holds no reference of its own — the page does, and the page outlives it. Releasing under the
    // label's key would decrement a refcount that was never taken.
    if (surface.pageIndex === null) {
      cache.release(textKeyFor(surface.digest));
    }
    forgetTexture(surface);
  }

  /**
   * The fields a collision would have to differ in. Cheap, and enough: a shared digest with the same words in the
   * same font is the same raster whatever else matched.
   *
   * T11 folds the RUN COLOURS in beside them, because once a digest can carry spans the words and the font stop
   * being sufficient on their own: two labels can say the same thing in the same face and differ only in which
   * stretch of it is red. As in `textDigest`, a span-less witness is byte-identical to the old one — every caller
   * today is span-less, so nothing existing is re-keyed.
   *
   * The separator is a RAW NUL, exactly as the digest's is, and for the same reason: game text contains spaces,
   * so a printable separator would let a crafted string impersonate a field boundary. Editors and greps hide it;
   * do not "tidy" it into a space.
   */
  function witnessOf(spec: TextSpec, spans?: readonly TextSpan[]): string {
    const base = `${spec.text} ${spec.cssFont}`;
    if (spans === undefined || spans.length === 0) {
      return base;
    }
    return `${base} ${spans.map((s) => `${s.start},${s.end},${s.color}`).join(";")}`;
  }

  return {
    boxFor(digest) {
      const surface = surfaces.get(digest);
      if (surface === undefined) {
        return null;
      }
      // NAMED even on a miss: a digest the pacer is holding back must not also age out from under the pacer.
      surface.lastNamedBuild = build;
      if (!surface.uploaded || surface.box === null) {
        return null;
      }
      // `peek` rather than a bare box: a `reset()` after context loss can have dropped the entry underneath us,
      // and a quad pointing at a texture that is gone samples black. The entry to ask about is whichever one
      // `handleFor` would answer with — the PAGE for a packed label, which holds no entry under its own key.
      if (!cache.peek(surface.pageIndex !== null ? pageKeyFor(surface.pageIndex) : textKeyFor(digest))) {
        forgetTexture(surface);
        return null;
      }
      return surface.box;
    },

    acquire(digest, spec, layout, rasterScale, spans) {
      if (disposed) {
        return null;
      }
      const surface = surfaceFor(digest);
      surface.lastNamedBuild = build;
      if (surface.declined) {
        return null;
      }
      const witness = witnessOf(spec, spans);
      if (surface.witness !== "" && surface.witness !== witness) {
        // TWO DIFFERENT LABELS, ONE DIGEST. Structurally impossible with a NUL-joined descriptor, which is why
        // this counts rather than throws — but it must not be allowed to silently draw the wrong words, so the
        // second claimant is refused and keeps its overlay element.
        stats.digestCollisions++;
        return null;
      }
      if (fonts !== null && !fonts.check(spec.cssFont)) {
        // THE FACE HAS NOT ARRIVED. Rastering now would bake the browser's fallback typeface into a texture that
        // is then reused for as long as this label says the same words — permanently wrong pixels rather than a
        // slow first frame. The DOM overlay keeps the label (where a late face re-renders for free) and the load's
        // resolution arms a repaint, which re-enters this path with the real face.
        //
        // This gate only works because the caller has already registered the `@font-face`: `check` answers TRUE
        // for a family with no matching rule, since there is nothing to load. See `fonts.ensureNodeFonts`.
        stats.fontWaits++;
        // THE GAUGE goes up here and comes down in the load's settlement, which is what makes it capable of
        // reading zero on a settled screen — see `TextSurfaceStats.fontsPending`. A set, not a counter: the
        // question the criterion asks is "how many faces are missing", and one face refused on forty builds is
        // one missing face.
        unresolvedFonts.add(spec.cssFont);
        if (!fontLoads.has(spec.cssFont)) {
          fontLoads.add(spec.cssFont);
          // TWO-ARGUMENT `then`, deliberately, rather than `.then().catch()`: `onFontReady` is the caller's
          // repaint arm and may throw, and a trailing `.catch` would then record a font the host served
          // perfectly well as a FAILED one. The two settlements have to stay distinguishable because they mean
          // opposite things — one face arrived, versus one face never will.
          void fonts.load(spec.cssFont).then(
            () => {
              unresolvedFonts.delete(spec.cssFont);
              // ARM AND REPAINT, NEVER ACK — `onSpineReady`'s contract. A font load is not a scene delta.
              options.onFontReady?.();
            },
            () => {
              // A face the host cannot serve. The label keeps its overlay element forever, which is exactly what
              // it does today; re-asking every build would be the only way to make this worse. It leaves the
              // pending gauge — it is not waiting on anything any more — and lands in its own guardrail.
              unresolvedFonts.delete(spec.cssFont);
              failedFonts.add(spec.cssFont);
            }
          );
        }
        return null;
      }
      const c = context();
      if (c === null) {
        return null;
      }
      const t0 = nowMs();
      // THE MEMO'S STATE ON ENTRY (diagnostic). `setFont` is about to skip its write if the memo already claims
      // this string — and the memo is shared with `measureFor`, which ran during the caller's layout, BEFORE the
      // readiness gate above. So this boolean is the witness for whether the assignment that resolved this face
      // happened here (under a face the gate has just certified) or somewhere earlier (under whatever was loaded
      // then). Cheap enough to compute unconditionally, gated anyway so the seam's contract stays one rule.
      const memoWasSet = captureScratch ? ctxFont === spec.cssFont : false;
      setFont(c, spec.cssFont);
      // Font metrics for the LINE BOX, read off the live context so they are the face's own. `measureText` is the
      // only way to reach them, and the string does not matter: `fontBoundingBox*` describes the FONT.
      const probe = c.measureText("M") as TextMetrics;
      const ascent = probe.fontBoundingBoxAscent ?? spec.fontPx * FALLBACK_ASCENT_RATIO;
      const descent = probe.fontBoundingBoxDescent ?? spec.fontPx * FALLBACK_DESCENT_RATIO;
      // THE METRICS INSTRUMENT (R7). The raster is sized from widths the CALLER measured, and drawn with the font
      // this context has NOW. If those two disagree the glyphs are drawn wider than the surface that was allocated
      // for them and the label comes out clipped to a sliver — which is what the G8 gate photographed on short
      // labels. One `measureText` per ACQUIRE (not per build, not per draw) is a negligible price for telling
      // "the raster is wrong" apart from "the raster is right and something else is".
      // The PRE-RESIZE readings, retained for the scratch sample: the width the caller laid out with, and the
      // width this context answers for the same line right now. Both are taken before `target.width = texW`
      // resets the context, which is the whole point — the sample compares them against the same two questions
      // asked AFTER it, and a disagreement across that boundary is a font that changed, not a number that drifted.
      let laidOutW = 0;
      let preW = 0;
      if (layout.lines.length > 0) {
        const first = layout.lines[0];
        const remeasured = c.measureText(first.text).width;
        laidOutW = first.width;
        preW = remeasured;
        if (Math.abs(remeasured - first.width) > 0.5) {
          stats.metricsMismatch++;
          if (metricsSamples.length < 8) {
            metricsSamples.push({
              chars: first.text.length,
              laidOut: Math.round(first.width * 100) / 100,
              atRaster: Math.round(remeasured * 100) / 100,
              cssFont: spec.cssFont,
              fontReady: fonts === null ? null : fonts.check(spec.cssFont)
            });
          }
        }
      }
      const ink = inkBoxOf(layout, spec, ascent, descent);
      if (!(ink.w > 0 && ink.h > 0)) {
        return null; // nothing to draw — an empty label, or a layout with no lines
      }
      const texW = Math.max(1, Math.ceil(ink.w * rasterScale));
      const texH = Math.max(1, Math.ceil(ink.h * rasterScale));
      if (maxTextureDim > 0 && (texW > maxTextureDim || texH > maxTextureDim)) {
        // Refused BEFORE the upload: an over-limit `texImage2D` answers INVALID_VALUE and leaves the texture
        // INCOMPLETE, which samples as opaque black — a black slab where the label should be.
        surface.declined = true;
        stats.declined++;
        return null;
      }
      const bytes = texW * texH * 4;
      // What this label would ADD to residency. On a page that is the page's whole allocation or nothing at all —
      // a rect that fits an existing shelf is free — so the ceiling is asked about the page, not about the glyphs.
      // (`placeRect` asks again at allocation time; this is the cheap pre-check that also covers the dedicated
      // arm, where the label's own bytes are the answer.)
      const wouldAdd = pageDim > 0 && texW + TEXT_ATLAS_GUTTER <= pageDim && texH + TEXT_ATLAS_GUTTER <= pageDim ? 0 : bytes;
      if (paceBytes > 0 && wouldAdd > 0 && residentBytesNow() + wouldAdd > paceBytes) {
        stats.refusedForBudget++;
        return null;
      }
      if (paceCount > 0 && buildUploads >= paceCount) {
        stats.paced++;
        return null;
      }

      // WHETHER THIS ACQUIRE IS SAMPLED, decided BEFORE the draw so the diagnostic reads either side of the
      // resize are taken for exactly the rasters the sample will carry — and never for the ones it will not.
      const sampling = captureScratch && stats.scratchSamples.length < SCRATCH_SAMPLE_CAP && texW <= scratchMaxTexW;
      const fontBefore = sampling ? c.font : "";

      const target = canvas as HTMLCanvasElement;
      target.width = texW;
      target.height = texH;
      // Sizing a canvas RESETS its context state, so the font has to be re-declared after it (and the memo has to
      // be told, or the next `setFont` would skip the write). SITE ONE of two — see `setFont`.
      forgetFont();
      c.clearRect(0, 0, texW, texH);
      c.save();
      c.scale(rasterScale, rasterScale);
      c.translate(-ink.dx, -ink.dy);
      setFont(c, spec.cssFont);
      // THE DRAW'S OWN FONT, and the same two measurements the sizing was taken from, re-asked under it. The
      // transform above does not enter `measureText`, so these are directly comparable with `preW`/`ascent`.
      const fontAfter = sampling ? c.font : "";
      let postW = 0;
      let postAscent = 0;
      let postDescent = 0;
      if (sampling) {
        postW = layout.lines.length > 0 ? c.measureText(layout.lines[0].text).width : 0;
        const postProbe = c.measureText("M") as TextMetrics;
        postAscent = postProbe.fontBoundingBoxAscent ?? spec.fontPx * FALLBACK_ASCENT_RATIO;
        postDescent = postProbe.fontBoundingBoxDescent ?? spec.fontPx * FALLBACK_DESCENT_RATIO;
      }
      // The baseline is the browser's own: `alphabetic` is what CSS lays text on, and the y we pass already has
      // the half-leading and the ascent folded in.
      c.textBaseline = "alphabetic";
      c.textAlign = "left";
      c.lineJoin = "round";
      c.miterLimit = 2;

      // THE FACE'S LINE BOX, as one value, so the baseline arithmetic below is the SHARED one (`baselineOf`) and
      // not a second copy of it. `ascent`/`descent` above are still the numbers `inkBoxOf` sized the surface from.
      const lineBox: TextLineMetrics = { ascent, descent };

      /**
       * One full pass of the label's ink — stroke then fill, in the given colours.
       *
       * THE RUN SPLIT (T10) IS A FILL-ONLY CONCERN, and that asymmetry is the design rather than an oversight.
       *
       * The STROKE is the label's outline: one colour for the whole label, by the spec's own shape
       * (`spec.outlineColor` is a single value, and `[outline_color]` is a NAMED REFUSAL in `richSimple` for
       * exactly this reason). Stroking per run would also double the ink at every run boundary, because two
       * adjacent runs' strokes overlap along the seam where a single stroke has none — visible on any outlined
       * label, which is most of them. So the stroke stays one pass over `line.text`.
       *
       * The FILL is the only thing a colour run changes, and only on the pass that is the label ITSELF. A shadow
       * is a SILHOUETTE — CSS composites a single-colour copy of the ink behind it — so the shadow pass draws
       * every run in the shadow's colour and `runColors` is false for it. Getting that wrong is not subtle and it
       * is not theoretical: the first version of this drew the first run of every shadow in the RUN's colour,
       * which puts a red shadow under red words, and the spec below caught it on the first run.
       *
       * WITH NO RUNS THIS IS THE OLD FUNCTION, call for call. No caller supplies spans today, so `runs` is absent
       * on every line and the `else` branch below is the only one that executes — pinned by spec against the
       * exact `fillText`/`strokeText` sequence, because "the plain path did not move" is the whole licence for
       * landing this while the plain path is the one under measurement.
       */
      const drawPass = (
        fill: string,
        stroke: string | null,
        offsetX: number,
        offsetY: number,
        runColors: boolean
      ): void => {
        if (stroke !== null && spec.outlinePx > 0) {
          c.strokeStyle = stroke;
          c.lineWidth = spec.outlinePx;
          for (const line of layout.lines) {
            c.strokeText(line.text, line.x + offsetX, baselineOf(line.y, spec.pitchPx, lineBox) + offsetY);
          }
        }
        c.fillStyle = fill;
        for (const line of layout.lines) {
          const baseline = baselineOf(line.y, spec.pitchPx, lineBox) + offsetY;
          if (line.runs === undefined) {
            c.fillText(line.text, line.x + offsetX, baseline);
            continue;
          }
          for (const run of line.runs) {
            // A run's `x` is already a CUMULATIVE PREFIX measurement in box space (see `runsFor`), never a sum of
            // piece widths — a font's advance for a pair is not the sum of its parts, so summing would drift at
            // every colour boundary. Nothing here re-derives it.
            c.fillStyle = runColors && run.color !== null ? run.color : fill;
            c.fillText(run.text, run.x + offsetX, baseline);
          }
          c.fillStyle = fill;
        }
      };

      // THE SHADOW IS A WHOLE EXTRA PASS, drawn FIRST and including the stroke. CSS `text-shadow` composites a
      // silhouette of the element's ink — outline included — behind it, so a shadow pass that drew only the fill
      // would produce a visibly thinner shadow than the DOM backend's on every outlined label, which is most of
      // them. `shadowColor`/`shadowBlur` are deliberately NOT used: the streamed shadow has zero blur, and the
      // canvas shadow API would apply to the stroke and fill separately and double the overlap.
      if (spec.shadow) {
        drawPass(spec.shadow.color, spec.shadow.color, spec.shadow.dx, spec.shadow.dy, false);
      }
      // …then the label itself: outline under fill, which is `paint-order: stroke fill` — the same declaration
      // `textStyle` writes for the DOM path, and the reason a thick outline does not eat into the glyph.
      drawPass(spec.color, spec.outlineColor, 0, 0, true);
      c.restore();
      // SITE TWO of two, and the one that was missing. `font` is part of the drawing state, and the `save()` above
      // ran AFTER the resize — so this `restore()` has just put `10px sans-serif` back, silently. Leaving the memo
      // claiming the label's own font is what made the NEXT label in that face measure at ten pixels and get a
      // surface four to five times too small for the glyphs the draw then put in it.
      forgetFont();
      stats.rasterMs += nowMs() - t0;
      // THE BISECT: what the rasterizer actually produced, read BEFORE anything uploads it.
      let scratchUrl: string | null = null;
      if (sampling) {
        try {
          scratchUrl = target.toDataURL();
        } catch {
          scratchUrl = null;
        }
      }

      try {
        const t1 = nowMs();
        // ONTO A PAGE if one will have it (R6 P6-D2). The rect carries its gutter on the right and bottom only —
        // the page's own left and top edges are already a cleared boundary, and doubling the gutter between two
        // rects would cost 2px of page for a 1px guarantee.
        const placement =
          pageDim > 0 && texW + TEXT_ATLAS_GUTTER <= pageDim && texH + TEXT_ATLAS_GUTTER <= pageDim
            ? placeRect(texW + TEXT_ATLAS_GUTTER, texH + TEXT_ATLAS_GUTTER)
            : null;
        let texX = 0;
        let texY = 0;
        if (placement !== null && cache.updateRegion(placement.page.key, target, placement.x, placement.y)) {
          texX = placement.x;
          texY = placement.y;
          surface.pageIndex = placement.page.index;
          placement.page.liveBytes += bytes;
        } else if (placement !== null) {
          // The page exists and refused the write, which by `updateRegion`'s contract can only be a rect that does
          // not fit the storage — i.e. this allocator got its own arithmetic wrong. Fall through to a dedicated
          // texture (the label still draws) rather than leave a hole; the shelf space is spent either way.
          cache.acquire(textKeyFor(digest), target);
          surface.pageIndex = null;
          dedicatedBytes += bytes;
          stats.dedicated++;
        } else if (pageDim > 0 && (texW + TEXT_ATLAS_GUTTER > pageDim || texH + TEXT_ATLAS_GUTTER > pageDim)) {
          // TOO BIG FOR ANY PAGE — the pre-atlas path, and the one number that says the page size is wrong for a
          // screen. `--raster-hist` puts this at zero for every recorded screen at every scale a device picks.
          cache.acquire(textKeyFor(digest), target);
          dedicatedBytes += bytes;
          stats.dedicated++;
        } else if (pageDim > 0) {
          // No page and none allowed: the byte ceiling is binding. Refuse rather than quietly minting the
          // dedicated texture the ceiling was about to stop, and keep the label on the overlay.
          stats.atlasFull++;
          return null;
        } else {
          cache.acquire(textKeyFor(digest), target); // `?textAtlas=off` — every label its own texture, as before
          dedicatedBytes += bytes;
          stats.dedicated++;
        }
        const ms = nowMs() - t1;
        surface.uploaded = true;
        surface.bytes = bytes;
        surface.witness = witness;
        surface.box = { dx: ink.dx, dy: ink.dy, w: ink.w, h: ink.h, texW, texH, texX, texY, lines: layout.lines.length };
        if (scratchUrl !== null) {
          stats.scratchSamples.push({
            texX,
            texY,
            texW,
            texH,
            dataUrl: scratchUrl,
            ink: { dx: ink.dx, dy: ink.dy, w: ink.w, h: ink.h },
            rasterScale,
            cssFont: spec.cssFont,
            ascent,
            descent,
            laidOutW,
            preW,
            memoWasSet,
            fontBefore,
            fontAfter,
            postW,
            postAscent,
            postDescent
          });
        }
        residentCount++;
        buildUploads++;
        stats.uploads++;
        stats.uploadMs += ms;
        if (ms > stats.maxUploadMs) {
          stats.maxUploadMs = ms;
        }
        return surface.box;
      } catch {
        // A source the driver would not take. Retrying every build would spend the cap on it forever.
        surface.declined = true;
        stats.declined++;
        releaseTexture(surface);
        return null;
      }
    },

    measureFor(cssFont) {
      const c = context();
      if (c === null) {
        return null;
      }
      return (text: string) => {
        setFont(c, cssFont);
        return c.measureText(text).width;
      };
    },

    lineMetricsFor(cssFont) {
      const known = lineMetrics.get(cssFont);
      if (known !== undefined) {
        return known;
      }
      const c = context();
      if (c === null) {
        return null;
      }
      // THE READINESS GATE FIRST, and it is the same one `acquire` takes, for a sharper version of the same
      // reason. A raster taken early bakes the fallback TYPEFACE; metrics taken early hand back the fallback's
      // ASCENT, which then places a real face's baseline — and unlike a raster there is no texture to look at
      // afterwards and no digest to notice it by. Refusing costs the label nothing: it stays on the path it is
      // already on, and the raster gate a few frames later is what arms the `load` that fixes both.
      if (!fontReady(cssFont)) {
        return null;
      }
      setFont(c, cssFont);
      // The string does not matter — `fontBoundingBox*` describes the FONT — so `acquire`'s own probe is reused
      // verbatim, character for character, rather than re-argued here.
      const probe = c.measureText("M") as TextMetrics;
      const ascent = probe.fontBoundingBoxAscent;
      const descent = probe.fontBoundingBoxDescent;
      if (!Number.isFinite(ascent) || !Number.isFinite(descent)) {
        // A context that does not report the metrics at all. `acquire` substitutes its ratios and rasters, which
        // is right for it — it is the only path that label has. This one has an alternative (that same raster),
        // so it declines and lets the label take it rather than drawing at a ratio nobody measured.
        return null;
      }
      const metrics: TextLineMetrics = { ascent, descent };
      lineMetrics.set(cssFont, metrics);
      return metrics;
    },

    handleFor(digest) {
      const surface = surfaces.get(digest);
      if (surface === undefined || !surface.uploaded) {
        return null;
      }
      // THE PAGE, for a packed label. This is the whole of what keeps the key space unchanged: everything outside
      // still names the label `text://<digest>`, and only this line knows that many digests answer with one
      // texture — which is also what makes gsw's batcher bind ONE slot for all of them, since it dedupes by
      // texture identity rather than by key.
      const key = surface.pageIndex !== null ? pageKeyFor(surface.pageIndex) : textKeyFor(digest);
      return cache.peek(key) ?? null;
    },

    sizeOf(digest) {
      const surface = surfaces.get(digest);
      if (surface === undefined || !surface.uploaded || surface.box === null) {
        return null;
      }
      // The size of the texture `handleFor` just answered with — the PAGE's for a packed label, because that is
      // what a source rect is normalized against. The label's own extent is `box.texW/texH` at `box.texX/texY`.
      if (surface.pageIndex !== null) {
        return { width: pageDim, height: pageDim };
      }
      return { width: surface.box.texW, height: surface.box.texH };
    },

    endBuild() {
      buildUploads = 0;
      build++;
      if (evictAfter <= 0) {
        return;
      }
      for (const surface of surfaces.values()) {
        if (surface.uploaded && build - surface.lastNamedBuild >= evictAfter) {
          releaseTexture(surface);
          stats.evicted++;
        }
      }
      // AFTER the evictions, which is the only thing that can empty a page. Cheap: one pass over at most a
      // handful of entries, and it runs on the same clock the evictor does.
      releaseEmptyPages();
    },

    invalidate() {
      // CONTEXT LOSS. gsw's `cache.reset()` has already forgotten every texture, so this must not call `release`
      // — it would decrement a refcount on an entry that is gone. A `declined` verdict is kept: it was a property
      // of the RASTER's size, not of the lost context.
      for (const surface of surfaces.values()) {
        forgetTexture(surface);
      }
      // …and every PAGE, which the reset also dropped. Not released for the same reason: the entries are gone, so
      // a release would decrement a refcount on nothing. The next acquire allocates page 0 again from scratch.
      pages.length = 0;
      residentCount = 0;
      dedicatedBytes = 0;
    },

    stats() {
      stats.surfaces = surfaces.size;
      // READ FROM THE SETS, not accumulated: that is the whole difference between a gauge and a total.
      stats.fontsPending = unresolvedFonts.size;
      stats.fontsFailed = failedFonts.size;
      stats.resident = residentCount;
      stats.bytes = residentBytesNow();
      stats.pages = livePages();
      stats.pageDim = pageDim;
      const allocated = stats.pages * pageBytes;
      let live = 0;
      for (const page of pages) {
        if (page !== null) live += page.liveBytes;
      }
      stats.pageLiveFraction = allocated > 0 ? Math.round((live / allocated) * 1000) / 1000 : 0;
      return { ...stats };
    },

    dispose() {
      // Deliberately no `cache.release`: the stage owns the cache and disposes it, and after a context loss the
      // driver is gone — the bridge, `fxSurfaces` and `spineSurfaces` all take this line.
      disposed = true;
      surfaces.clear();
      lineMetrics.clear();
      pages.length = 0;
      residentCount = 0;
      dedicatedBytes = 0;
      buildUploads = 0;
      canvas = null;
      ctx = null;
    }
  };
}
