// RUNTIME ATLAS RE-PACKING FOR THE SINGLE-CANVAS STAGE — a 62 MB page in, the two-to-five sub-rects a screen
// actually names out.
//
// `textureBridge` uploads a PAGE: the url a node names is the game's own atlas sheet, and `cache.acquire` hands
// the whole sheet to `texImage2D`. That is the right shape for a small sprite atlas and the wrong shape for the
// card sheets, which are 4032x4072 (62.6 MB of RGBA) and are cropped by THREE nodes on a card-reward screen. The
// bridge's own header names the floor it cannot cut: a 59 MB page is one indivisible upload, ~200 ms here and
// seconds on the phone, and no byte budget can split one `texImage2D`. This module splits it a different way — by
// never asking for the page at all.
//
// WHAT IT DOES. Every textured quad arrives at the bridge carrying the page url AND its source rect. When the page
// is big enough to be worth it, this module crops that rect out of the decoded page into a scratch 2D canvas,
// uploads THAT (a card region is ~0.35 MP, ~1.4 MB) under its own key, and tells the bridge to rebase the quad's
// source rect into the crop. The page's `acquire` then simply never happens: three regions at 1.4 MB replace one
// page at 62 MB, and the picture is the same.
//
// ---------------------------------------------------------------------------------------------------------------
// PER-REGION TEXTURES, NOT A SHELF PACKER. There is no allocator here and that is a decision, not an omission.
//
// The predicate below selects pages of {@link REPACK_MIN_PAGE_PIXELS_DEFAULT} pixels or more, which on this game's
// asset set means the CARD sheets and nothing else: the largest non-card page is 4.19 MP and the smallest card page
// is 10.87 MP, so 6 MP sits in a gap rather than on a tuning curve (the DOM backend's `?atlasPageCropMaxMp` gate is
// argued from the same gap, `mirrorRenderer.ts`). Card sheets are cropped by a handful of nodes per screen, so the
// region population per page is small and a packer would be arithmetic with nothing to pack. A per-region texture
// costs the fixed per-upload term (~0.5 ms of bind + validate) and one batcher slot each; P1 measured 400 naive
// bind+draws still vsync-locked, so five more slots is not a cost this stage can feel.
//
// THE PROMOTION CRITERION, so a later round does not have to re-derive it: build a shelf allocator when
// `repack.regions` reaches 24 resident on ONE page of a gated recording, or when `crops` per build sits at the
// count cap for three builds running. Below that the packer is more moving parts for the same bytes.
//
// ---------------------------------------------------------------------------------------------------------------
// THE APRON, and why a re-pack does not change a single pixel.
//
// gsw's cache samples LINEAR with CLAMP_TO_EDGE and NO mipmaps. A LINEAR fetch reads at most a 2x2 texel
// neighbourhood, so a texel one pixel outside the region is the furthest a sample can reach. Crop ONE pixel of real
// page pixels around the region — {@link REPACK_APRON} — and every sample the executor can make finds exactly the
// texel the page would have given it, INCLUDING the neighbour bleed a tight atlas already has today. The re-pack is
// therefore not "as good as" the page, it is byte-identical sampling, and reproducing today's bleed rather than
// removing it is the point: a gutter would be a visual CHANGE, and this module is supposed to be invisible.
//
// At a page edge the apron clamps to the page, i.e. there is none — which is also exact, because CLAMP_TO_EDGE at
// the crop's edge repeats the same texel the page's own edge would have.
//
// IF ANYONE EVER TURNS ON MIPMAPS in `textures.ts`, this proof dies: a mip fetch reads a whole footprint, not 2x2,
// and one apron pixel stops being enough. That is a gsw-side change and this comment is the tripwire.
//
// ---------------------------------------------------------------------------------------------------------------
// THE KEY SPACE — `rp://<pageUrl>#x,y,w,h`, and it NEVER LEAVES THIS MODULE.
//
// Region textures share the stage's one `CanvasTextureCache` with the page textures and the `fx://` surfaces, for
// the reason `fxSurfaces` gives: one white texel, one byte total, one thing to reset on context loss. The prefix
// says which population owns a key.
//
// Unlike `fx://`, though, an `rp://` key is never a draw-list handle. The builder pushes the PAGE url, the bridge
// resolves it to a region texture on the way past, and the bridge's adapter answers `textureAt` with the page url
// and `readQuad` with the ORIGINAL source rect. That is the "builder's own currency" rule the adapter already
// follows for `keys`, extended by two numbers — and it is what makes the paint-dump parity gate byte-identical
// with this lever on or off BY CONSTRUCTION rather than by tolerance.
//
// THE COORDINATES ARE SNAPPED, on a {@link REPACK_QUANTUM}-pixel grid: the rect is grown to whole texels
// (floor/ceil), then by the apron, then OUT to the grid, then clamped to the page. That BOUNDS key churn rather
// than eliminating it — a source rect that moves within a grid cell keeps naming the same crop, and one that
// crosses a cell boundary mints a second. Four pixels is a quarter of the keys a per-texel key would make, and the
// resident byte cap is what stops a pathological population accumulating behind that.
//
// (In practice a card region's `textureRegion` is written once, by the wire model, and does not move at all; the
// grid is insurance against a source rect that is COMPUTED — the `cover` fit — rather than transcribed.)
//
// ---------------------------------------------------------------------------------------------------------------
// REFUSAL PROMOTES THE WHOLE PAGE. The one rule that keeps this from making things worse.
//
// If any quad on a page cannot be served by a region — a whole-page source rect (`NinePatchRect` over a plain
// image), a degenerate rect, a crop bigger than a quarter of the page, a crop the driver would not take — then that
// page IS going to be uploaded, and every crop of it becomes pure additional cost. So the first such quad marks the
// page UNREPACKABLE for good and releases whatever regions it had: after that the page pays for itself once and
// nothing else. Never both.
//
// ---------------------------------------------------------------------------------------------------------------
// THE SCRATCH CANVAS is created `willReadFrequently`, which is not about reading.
//
// `drawImage`-ing a 62 MB page into a GPU-backed 2D canvas hands the SOURCE to Chrome's canvas raster path — the
// decode + upload of the whole page, i.e. exactly the cost this module exists to avoid, paid on a different thread
// and then again on ours. `willReadFrequently` keeps the canvas's backing store CPU-side so the crop is a memcpy of
// the bytes the source already has. The DOM backend hit this and fixed it the same way with a CPU-friendly canvas, which
// is why the flag is hard-coded here rather than levered: there is no arm of this module where a GPU-backed scratch
// canvas is the right answer.
//
// "THE BYTES THE SOURCE ALREADY HAS" IS A PRECONDITION, NOT A GUARANTEE (Aug-28). This sentence used to say "the
// bytes the `<img>` already has", and a Moto G86 combat trace showed the `<img>` frequently does NOT have them: an
// element's decoded frame is a cache Chrome evicts under memory pressure, so `drawImage` re-decodes the 18 MB PNG
// synchronously — 260-306 ms a time, seven times in 29.5 s, every one inside a rAF. `willReadFrequently` is still
// right and still for the reason given above; it makes the COPY cheap, and it cannot make the DECODE not happen.
//
// Two things follow, and both are implemented. The caller should hand this module owned pixels wherever it has
// them (`TextureBridgeOptions.decodedPageSource`, wired to the `ImageBitmap`s `imagePrefetch` already holds for
// every atlas), and where it cannot, {@link CROP_HOSTILE_MS} stops one frame paying for several.
//
// The canvas ELEMENT is what goes to `cache.acquire`, never its bytes. A 2D canvas stores PREMULTIPLIED colour and
// `acquireBytes` would be told to premultiply again — a grossly visible darkening of every semi-transparent edge.
// Handing over the element lets gsw's `UNPACK_PREMULTIPLY_ALPHA_WEBGL` do the multiply exactly once, which is the
// path `fxSurfaces` has been shipping since M2.

import type { CanvasTextureCache, ExecutorTexture } from "@godot-scene-web/canvas";

/** The key-space prefix for a re-packed region. Internal: no draw-list handle ever carries it (see the header). */
export const REPACK_KEY_PREFIX = "rp://";

/**
 * How big a page has to be, in pixels, before it is worth cropping.
 *
 * 6 MP is placed in a GAP rather than tuned: the largest non-card page this game ships is 4.19 MP and the smallest
 * card sheet is 10.87 MP. So the predicate reads as "the card sheets, and nothing else" — which is also the set
 * whose per-page reference count is small enough for per-region textures to be the whole design. The DOM backend's
 * `?atlasPageCropMaxMp` gate is argued from the same gap and lands on the same number.
 */
export const REPACK_MIN_PAGE_PIXELS_DEFAULT = 6_000_000;

/**
 * Resident byte cap for region textures, evicted LRU when it is exceeded.
 *
 * 24 MB is deliberately about a third of ONE card page: if the regions of a screen ever approached the page they
 * were cut from, the re-pack would have stopped being a win and the cap is what says so (visibly, as `evicted`
 * climbing) instead of quietly holding both. Regions a build named are never the ones evicted.
 */
export const REPACK_MAX_BYTES_DEFAULT = 24 * 1024 * 1024;

/**
 * How slow ONE `drawImage` has to be before this module stops believing the crop is cheap — the DECODE-HOSTILE
 * threshold, and the repair for an assumption the Aug-28 phone trace falsified.
 *
 * WHAT THE ASSUMPTION WAS. The bridge decodes a page with `img.decode()` before it is ever `ready`, so both
 * modules took the decode to be PRE-PAID and costed a crop as a memcpy — which is why the only budget in the
 * pipeline counts BYTES, and a crop charges the ~1.4 MB it produces rather than the page it reads.
 *
 * WHAT ACTUALLY HAPPENS. `decode()` resolves, and Chrome then DISCARDS the decoded frame under memory pressure,
 * because an `<img>`'s pixels are a cache and not a possession. The next `drawImage` re-decodes the whole PNG
 * synchronously. Measured on a Moto G86 over one 29.5 s combat trace: seven `Decode LazyPixelRef` re-decodes of
 * the 4032x4072 card sheets at 260-306 ms each, ~2.0 s of main thread, every one inside a rAF — against a byte
 * budget that thought it had spent 1.4 MB.
 *
 * THE FIX IS TO CROP FROM PIXELS NOBODY CAN DISCARD (`TextureBridgeOptions.decodedPageSource`, wired to
 * `atlasBaker`'s prefetched `ImageBitmap`s). THIS is the backstop for when that source is missing — a page
 * nobody prefetched, a bitmap that has not settled, a device that has no `createImageBitmap`. It cannot make a
 * re-decode cheap; what it can do is stop one frame paying for several, by cutting at most ONE region of a
 * proven-hostile page per build and pacing the rest.
 *
 * 10 ms is a floor, not a tuning curve: a genuine crop of a card region is a sub-millisecond memcpy (the header's
 * `cropMs` census says so), and the failure it catches is two orders of magnitude above it. Anything in between
 * is a device slow enough that one crop per build is the right answer anyway.
 */
export const CROP_HOSTILE_MS = 10;

/** How many builds a region can go un-named before its texture is released. Matches the bridge's page clock. */
export const REPACK_EVICT_AFTER_BUILDS = 240;

/** Pixels of REAL page content kept around every crop, so LINEAR sampling is bit-identical. See the header. */
export const REPACK_APRON = 1;

/** The crop grid, in pixels. Snapping outward to it is what stops a wobbling source rect minting new textures. */
export const REPACK_QUANTUM = 4;

/** The four fields of a `QuadView` this module reads — stated separately so nothing here depends on the gsw view. */
export interface RepackSrcRect {
  readonly srcX: number;
  readonly srcY: number;
  readonly srcW: number;
  readonly srcH: number;
}

/** A snapped crop rectangle in PAGE pixels. */
export interface RepackCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The crop a source rect resolves to: whole texels, plus the apron, snapped out to {@link REPACK_QUANTUM}, clamped
 * to the page. PURE — the probe (`scripts/probe-canvas-atlas-vram.mjs`) calls it offline to count regions per page
 * without a browser anywhere.
 *
 * A page smaller than the rect it is asked about answers a clamped (possibly empty) crop rather than throwing; the
 * caller's predicate is what rejects that, so this stays total.
 */
export function repackCrop(pageW: number, pageH: number, src: RepackSrcRect): RepackCrop {
  const q = REPACK_QUANTUM;
  let x0 = Math.floor(Math.floor(src.srcX) - REPACK_APRON);
  let y0 = Math.floor(Math.floor(src.srcY) - REPACK_APRON);
  let x1 = Math.ceil(src.srcX + src.srcW) + REPACK_APRON;
  let y1 = Math.ceil(src.srcY + src.srcH) + REPACK_APRON;
  x0 = Math.floor(x0 / q) * q;
  y0 = Math.floor(y0 / q) * q;
  x1 = Math.ceil(x1 / q) * q;
  y1 = Math.ceil(y1 / q) * q;
  const x = x0 < 0 ? 0 : x0;
  const y = y0 < 0 ? 0 : y0;
  const right = x1 > pageW ? pageW : x1;
  const bottom = y1 > pageH ? pageH : y1;
  return { x, y, w: right - x, h: bottom - y };
}

/** The cache key one crop of one page uploads under. The inverse is never needed: nothing parses these. */
export function repackKey(url: string, crop: RepackCrop): string {
  return `${REPACK_KEY_PREFIX}${url}#${crop.x},${crop.y},${crop.w},${crop.h}`;
}

/**
 * What {@link AtlasRepacker.regionFor} answers.
 *
 * REGISTRY-OWNED AND UPDATED IN PLACE — there is one of these per repacker, so a 44-card deck view costs no
 * allocation per build. Read it, do not keep it.
 *
 * - `region`: `handle` is the crop's texture, and `dx`/`dy` are ADDED to the quad's `srcX`/`srcY` to move the rect
 *   out of page space and into the crop's. They are the crop origin negated, and always integers.
 * - `paced`: the crop is wanted but the build's upload budget is spent. The quad paints transparent this build and
 *   the bridge books another frame, exactly as it does for a paced page.
 * - `refused`: this page will never be re-packed (see the header). The caller falls back to the page.
 */
export interface RepackResult {
  readonly kind: "region" | "paced" | "refused";
  readonly handle: ExecutorTexture | null;
  readonly dx: number;
  readonly dy: number;
}

export interface AtlasRepackStats {
  /** Distinct region keys this repacker has ever cropped — cumulative, and the churn gauge against `resident`. */
  regions: number;
  /** Region textures live right now. */
  resident: number;
  /** Resident RGBA bytes across those textures — this population's share of the shared cache, not the total. */
  bytes: number;
  /** Pages holding at least one live region, i.e. pages whose full upload is currently being avoided. */
  pages: number;
  /** `drawImage` crops performed (each one followed by an upload). */
  crops: number;
  /**
   * Total main-thread ms spent inside those `drawImage` calls.
   *
   * Charged to the BUILD's upload total (so `maxBuildUploadMs` stays a truthful main-thread figure) but never to
   * `maxUploadMs`, which means "the biggest single `texImage2D`" and would stop meaning that if a crop counted.
   */
  cropMs: number;
  /**
   * The single worst `drawImage`, in ms — the instrument that says whether the crop source is eviction-proof.
   *
   * READ IT AS A VERDICT, not a percentile. A crop of a card region is a sub-millisecond memcpy when the page is
   * owned pixels, and ~290 ms when Chrome discarded the `<img>`'s decode and `drawImage` re-decoded the sheet.
   * There is nothing in between, so this number answers one question: did the re-packer cut from a bitmap or from
   * a cache? Above {@link CROP_HOSTILE_MS} the answer is "a cache", and {@link hostilePages} counts the pages.
   */
  worstCropMs: number;
  /**
   * Pages that have charged a crop at or above {@link CROP_HOSTILE_MS} and are now cut at most once per build.
   *
   * EXPECTED TO BE 0 whenever `TextureBridgeOptions.decodedPageSource` is supplying bitmaps for the pages a screen
   * names. A non-zero value is not this rule misfiring — it is the rule reporting that the eviction-proof source
   * was missing for that page, which is the thing to go and fix.
   */
  hostilePages: number;
  /** Quads refused a region (a crop the driver would not take, no 2D context, a rect this module cannot serve). */
  declined: number;
  /** Pages promoted to UNREPACKABLE — see the header's refusal rule. */
  refusedPages: number;
  /** Region textures released by the residency clock or the byte cap. */
  evicted: number;
  /** The page-size predicate in force, in pixels. */
  thresholdPixels: number;
  /** The resident byte cap in force. */
  maxBytes: number;
}

/**
 * The budget the repacker spends, which is the BRIDGE'S budget — the same per-build bytes and count that pace page
 * uploads, because a crop's upload is a `texImage2D` on the same thread in the same build and paying for it out of
 * a second budget would let a build spend twice.
 */
export interface AtlasRepackHost {
  /** May this build upload `bytes` more? False means "come back next build" (`paced`). */
  admit(bytes: number): boolean;
  /** A crop landed: charge it. `cropMs` is the `drawImage`, `uploadMs` the `texImage2D`. */
  noteUpload(bytes: number, uploadMs: number, cropMs: number): void;
}

export interface AtlasRepacker {
  /**
   * Would this module serve this quad? Cheap enough to ask for every textured quad: a page under the size
   * predicate answers false on one multiply.
   *
   * NOT PURE IN ONE CASE, and it is the refusal rule: a size-eligible page whose SOURCE RECT this module cannot
   * serve is promoted to unrepackable here, because the page is now certain to be uploaded and its existing crops
   * have become dead weight. Nothing else about the module's state moves.
   */
  claims(url: string, pageW: number, pageH: number, src: RepackSrcRect): boolean;
  /**
   * The region texture for a claimed quad, cropping and uploading it on first use.
   *
   * `source` is the decoded page. WHICH decoded page is the caller's choice and it is not a free one: this used to
   * say "the `<img>` the bridge already retains for context-loss re-reads, so the CPU copy costs nothing new",
   * which is true of an `ImageBitmap` and false of an `<img>` — an element's decoded frame is a cache the browser
   * evicts, and the crop then re-decodes the sheet synchronously (see {@link CROP_HOSTILE_MS}). Hand this owned
   * pixels where you have them.
   */
  regionFor(
    url: string,
    source: CanvasImageSource,
    pageW: number,
    pageH: number,
    src: RepackSrcRect
  ): RepackResult;
  /**
   * Resolve an ALREADY-LIVE mapping without cutting, uploading, aging or promoting a page.
   *
   * `region` and `refused` are exact answers (the latter means use the whole page); `paced` means the ordinary
   * build path would need work before it could know the mapping, so an in-place source patch must bail.
   */
  residentFor(url: string, pageW: number, pageH: number, src: RepackSrcRect): RepackResult;
  /** Does this page currently have live regions? I.e. is its own upload being avoided right now? */
  holds(url: string): boolean;
  /** Close the build: age the residency clock, evict what left the scene, then enforce the byte cap. */
  endBuild(): void;
  /** Context loss: forget every upload WITHOUT touching the dead driver. The next build re-crops from the page. */
  invalidate(): void;
  stats(): AtlasRepackStats;
  dispose(): void;
}

export interface AtlasRepackOptions {
  cache: CanvasTextureCache;
  host: AtlasRepackHost;
  /** Page-size predicate in PIXELS. Defaults to {@link REPACK_MIN_PAGE_PIXELS_DEFAULT}. */
  minPagePixels?: number;
  /** Resident byte cap for regions. Defaults to {@link REPACK_MAX_BYTES_DEFAULT}. */
  maxBytes?: number;
  /** Overridable for tests. Defaults to {@link REPACK_EVICT_AFTER_BUILDS}. */
  evictAfterBuilds?: number;
  /**
   * The context's `MAX_TEXTURE_SIZE`. A crop longer than this is refused (and its page promoted), for the reason
   * the bridge refuses an oversized page: an over-limit `texImage2D` leaves the texture INCOMPLETE, which samples
   * as opaque black. Omitted (or 0) means "do not check".
   */
  maxTextureDim?: number;
  /** Injectable for tests; defaults to `document.createElement("canvas")`. */
  createCanvas?: () => HTMLCanvasElement;
}

interface Region {
  key: string;
  url: string;
  crop: RepackCrop;
  bytes: number;
  uploaded: boolean;
  /** The build ordinal this region was last named in — the residency clock and the LRU key. */
  lastSeen: number;
}

interface PageState {
  /** Promoted by the refusal rule: every quad on this page uses the page from now on. */
  unrepackable: boolean;
  /** Live (uploaded) regions cut from this page. */
  live: number;
  /**
   * The worst `drawImage` this page has ever charged, in ms — the DECODE-HOSTILE signal (see
   * {@link CROP_HOSTILE_MS}). Sticky: a page that re-decoded once will do it again, because what makes it
   * re-decode is its own size against the device's memory, not anything about the frame it happened in.
   */
  worstCropMs: number;
  /** Build ordinal of the last crop CHARGED to the one-per-build rule, so the rule can be per-build. */
  hostileCropBuild: number;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function normalizePositive(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createAtlasRepack(options: AtlasRepackOptions): AtlasRepacker {
  const cache = options.cache;
  const host = options.host;
  const minPagePixels = normalizePositive(options.minPagePixels, REPACK_MIN_PAGE_PIXELS_DEFAULT);
  const maxBytes = normalizePositive(options.maxBytes, REPACK_MAX_BYTES_DEFAULT);
  const evictAfter = normalizePositive(options.evictAfterBuilds, REPACK_EVICT_AFTER_BUILDS);
  const maxTextureDim =
    options.maxTextureDim != null && Number.isFinite(options.maxTextureDim) && options.maxTextureDim > 0
      ? options.maxTextureDim
      : 0;

  const regions = new Map<string, Region>();
  const pages = new Map<string, PageState>();

  let build = 0;
  let disposed = false;
  let residentCount = 0;
  let residentBytes = 0;
  let livePages = 0;
  /** No 2D context anywhere (a headless/stubbed DOM): the whole module steps aside rather than refusing per quad. */
  let contextDead = false;
  let scratch: HTMLCanvasElement | null = null;
  let scratchCtx: CanvasRenderingContext2D | null = null;

  const stats: AtlasRepackStats = {
    regions: 0,
    resident: 0,
    bytes: 0,
    pages: 0,
    crops: 0,
    cropMs: 0,
    worstCropMs: 0,
    hostilePages: 0,
    declined: 0,
    refusedPages: 0,
    evicted: 0,
    thresholdPixels: minPagePixels,
    maxBytes
  };

  /** The one result object, updated in place (see {@link RepackResult}). */
  const result = { kind: "refused" as RepackResult["kind"], handle: null as ExecutorTexture | null, dx: 0, dy: 0 };

  function answer(kind: RepackResult["kind"], handle: ExecutorTexture | null, dx: number, dy: number): RepackResult {
    result.kind = kind;
    result.handle = handle;
    result.dx = dx;
    result.dy = dy;
    return result;
  }

  function pageFor(url: string): PageState {
    let page = pages.get(url);
    if (page === undefined) {
      page = { unrepackable: false, live: 0, worstCropMs: 0, hostileCropBuild: -1 };
      pages.set(url, page);
    }
    return page;
  }

  function forget(region: Region): void {
    if (!region.uploaded) {
      return;
    }
    region.uploaded = false;
    residentCount--;
    residentBytes -= region.bytes;
    const page = pages.get(region.url);
    if (page !== undefined && --page.live === 0) {
      livePages--;
    }
  }

  function releaseRegion(region: Region): void {
    if (region.uploaded) {
      cache.release(region.key);
    }
    forget(region);
    regions.delete(region.key);
  }

  /**
   * This page will be uploaded whole, so its crops are dead weight: drop them and stop cropping it.
   *
   * The releases are what makes the rule cheap to be wrong about — a page that mixes one whole-page quad in with
   * fifty region quads pays for at most one build's worth of crops before it settles on the page alone.
   */
  function declinePage(url: string): void {
    const page = pageFor(url);
    if (page.unrepackable) {
      return;
    }
    page.unrepackable = true;
    stats.refusedPages++;
    for (const region of [...regions.values()]) {
      if (region.url === url) {
        releaseRegion(region);
      }
    }
  }

  /** The scratch 2D context, created once. `null` means this environment has no 2D canvas at all. */
  function context(): CanvasRenderingContext2D | null {
    if (scratchCtx !== null || contextDead) {
      return scratchCtx;
    }
    const make = options.createCanvas ?? (typeof document !== "undefined" ? () => document.createElement("canvas") : null);
    if (make === null) {
      contextDead = true;
      return null;
    }
    try {
      const canvas = make();
      // HARD-CODED, not levered: see the header. A GPU-backed scratch canvas would drag the whole 62 MB page onto
      // the GPU through Chrome's raster path — the exact cost this module exists to remove.
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        contextDead = true;
        return null;
      }
      scratch = canvas;
      scratchCtx = ctx;
      return ctx;
    } catch {
      contextDead = true;
      return null;
    }
  }

  return {
    claims(url, pageW, pageH, src) {
      if (disposed || contextDead) {
        return false;
      }
      const page = pages.get(url);
      if (page !== undefined && page.unrepackable) {
        return false;
      }
      if (!(pageW > 0 && pageH > 0) || pageW * pageH < minPagePixels) {
        return false;
      }
      // From here the page IS worth re-packing, so anything this module cannot serve is a REFUSAL of the page
      // rather than of the quad: the page is about to be uploaded and every crop of it has become waste.
      if (!(src.srcW > 0 && src.srcH > 0)) {
        // A zero-span source rect is the draw list's "the whole texture" spelling (`NinePatchRect` over a plain
        // image before its size lands, an untextured fill). It names the page, so the page must exist.
        declinePage(url);
        return false;
      }
      const crop = repackCrop(pageW, pageH, src);
      if (!(crop.w > 0 && crop.h > 0)) {
        declinePage(url);
        return false;
      }
      if (crop.w * crop.h * 4 > pageW * pageH) {
        // A crop bigger than a quarter of the page is not a crop, it is the page with extra steps.
        declinePage(url);
        return false;
      }
      return true;
    },

    regionFor(url, source, pageW, pageH, src) {
      if (disposed) {
        return answer("refused", null, 0, 0);
      }
      const crop = repackCrop(pageW, pageH, src);
      const key = repackKey(url, crop);
      const existing = regions.get(key);
      if (existing !== undefined && existing.uploaded) {
        const live = cache.peek(key);
        if (live) {
          existing.lastSeen = build;
          return answer("region", live, -crop.x, -crop.y);
        }
        // The cache dropped it under us (a `reset()` after context loss): fall through and re-crop.
        forget(existing);
      }
      if (maxTextureDim > 0 && (crop.w > maxTextureDim || crop.h > maxTextureDim)) {
        stats.declined++;
        declinePage(url);
        return answer("refused", null, 0, 0);
      }
      const bytes = crop.w * crop.h * 4;
      if (!host.admit(bytes)) {
        return answer("paced", null, 0, 0);
      }
      // THE DECODE-HOSTILE GATE (see {@link CROP_HOSTILE_MS}). A page that has charged a pathological `drawImage`
      // gets ONE cut per build and its remaining rects are paced to later frames, so a screen that names four
      // regions of a re-decoding sheet costs four ordinary frames instead of one 1.2 s stall. Asked AFTER the byte
      // budget and BEFORE the source check so that a paced quad reads exactly like any other paced quad to the
      // bridge — this rule changes WHEN a crop happens, never whether the page can be re-packed at all.
      // (`admit` is a pure predicate — the bridge charges in `noteUpload` — so returning `paced` after it costs
      // the build nothing.)
      const hostilePage = pageFor(url);
      if (hostilePage.worstCropMs >= CROP_HOSTILE_MS && hostilePage.hostileCropBuild === build) {
        return answer("paced", null, 0, 0);
      }
      const ctx = context();
      if (ctx === null || scratch === null) {
        // No 2D canvas in this environment. `contextDead` is latched, so this is asked once and the bridge's page
        // path serves every quad from here on — the quad still paints, it just paints from the page.
        stats.declined++;
        return answer("refused", null, 0, 0);
      }
      try {
        const t0 = nowMs();
        // Assigning either dimension RESETS the 2D context state, so the composite op is set after the resize and
        // not once at construction. `copy` is what makes a re-used scratch exact: the destination becomes the
        // source, with no chance of a previous crop's pixels showing through a transparent one.
        scratch.width = crop.w;
        scratch.height = crop.h;
        ctx.globalCompositeOperation = "copy";
        ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
        const t1 = nowMs();
        // THE ELEMENT, never its bytes — `acquireBytes` would premultiply a canvas that already is (see header).
        const handle = cache.acquire(key, scratch);
        const t2 = nowMs();
        const region: Region = existing ?? { key, url, crop, bytes, uploaded: false, lastSeen: build };
        if (existing === undefined) {
          regions.set(key, region);
          stats.regions++;
        }
        region.bytes = bytes;
        region.lastSeen = build;
        if (!region.uploaded) {
          region.uploaded = true;
          residentCount++;
          residentBytes += bytes;
          const page = pageFor(url);
          if (page.live++ === 0) {
            livePages++;
          }
        }
        stats.crops++;
        const cropMs = t1 - t0;
        stats.cropMs += cropMs;
        if (cropMs > stats.worstCropMs) {
          stats.worstCropMs = cropMs;
        }
        // THE HOSTILE VERDICT AND ITS SLOT, both taken here so a cut that never happened cannot spend either.
        // `worstCropMs` is a high-water mark rather than an average: one 290 ms re-decode is the whole finding,
        // and a page that mixes it with thirty sub-millisecond memcpys must not average its way back to "cheap".
        if (cropMs > hostilePage.worstCropMs) {
          // Counted on the TRANSITION only, so `hostilePages` is a count of pages and not of crops.
          const wasHostile = hostilePage.worstCropMs >= CROP_HOSTILE_MS;
          hostilePage.worstCropMs = cropMs;
          if (!wasHostile && cropMs >= CROP_HOSTILE_MS) {
            stats.hostilePages++;
          }
        }
        hostilePage.hostileCropBuild = build;
        host.noteUpload(bytes, t2 - t1, t1 - t0);
        return answer("region", handle, -crop.x, -crop.y);
      } catch {
        // A tainted page, or a driver that would not take the crop. Retrying it every build would spend the
        // budget on it forever, and the page can serve every quad instead.
        stats.declined++;
        declinePage(url);
        return answer("refused", null, 0, 0);
      }
    },

    residentFor(url, pageW, pageH, src) {
      // This repeats `claims`' pure predicates rather than calling it: `claims` is allowed to promote a page to
      // unrepackable, while this query is used on the animation path and must leave every residency decision
      // exactly as it found it.
      if (disposed || contextDead) {
        return answer("refused", null, 0, 0);
      }
      const page = pages.get(url);
      if (page !== undefined && page.unrepackable) {
        return answer("refused", null, 0, 0);
      }
      if (!(pageW > 0 && pageH > 0) || pageW * pageH < minPagePixels || !(src.srcW > 0 && src.srcH > 0)) {
        return answer("refused", null, 0, 0);
      }
      const crop = repackCrop(pageW, pageH, src);
      if (!(crop.w > 0 && crop.h > 0) || crop.w * crop.h * 4 > pageW * pageH) {
        return answer("refused", null, 0, 0);
      }
      const existing = regions.get(repackKey(url, crop));
      if (existing !== undefined && existing.uploaded) {
        const live = cache.peek(existing.key);
        if (live !== undefined) {
          return answer("region", live, -crop.x, -crop.y);
        }
      }
      // `paced` here means "unresolved", not that we spent an upload budget. It is deliberately the existing
      // non-region answer with no usable handle, so callers cannot confuse it with a direct-page mapping.
      return answer("paced", null, 0, 0);
    },

    holds(url) {
      const page = pages.get(url);
      return page !== undefined && page.live > 0;
    },

    endBuild() {
      const spent = build;
      build++;
      for (const region of [...regions.values()]) {
        if (region.uploaded && build - region.lastSeen >= evictAfter) {
          releaseRegion(region);
          stats.evicted++;
        }
      }
      if (residentBytes > maxBytes) {
        // LRU, and a region THIS build named is never a candidate: evicting one would re-crop it next build
        // forever. If the named set alone is over the cap, the cap loses — that is the always-allow-one rule in
        // its residency form.
        const candidates = [...regions.values()].filter((r) => r.uploaded && r.lastSeen !== spent);
        candidates.sort((a, b) => a.lastSeen - b.lastSeen || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        for (const region of candidates) {
          if (residentBytes <= maxBytes) {
            break;
          }
          releaseRegion(region);
          stats.evicted++;
        }
      }
    },

    invalidate() {
      // gsw's own `cache.reset()` has already forgotten the textures, so this must NOT call `release`: that would
      // decrement a refcount on an entry that is gone and touch a dead driver. The records stay, so the next build
      // re-crops each region under the same key from the `<img>` the bridge still retains.
      for (const region of regions.values()) {
        region.uploaded = false;
      }
      for (const page of pages.values()) {
        page.live = 0;
      }
      residentCount = 0;
      residentBytes = 0;
      livePages = 0;
    },

    stats() {
      stats.resident = residentCount;
      stats.bytes = residentBytes;
      stats.pages = livePages;
      return { ...stats };
    },

    dispose() {
      // Deliberately no `cache.release`: the stage owns the cache and disposes it, exactly as the bridge and the
      // fx registry do. The scratch canvas IS dropped to 0x0 first, because its backing store is ours alone.
      disposed = true;
      if (scratch !== null) {
        scratch.width = 0;
        scratch.height = 0;
      }
      scratch = null;
      scratchCtx = null;
      regions.clear();
      pages.clear();
      residentCount = 0;
      residentBytes = 0;
      livePages = 0;
    }
  };
}
