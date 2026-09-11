// TEXTURE HANDLES FOR THE SINGLE-CANVAS STAGE — page url in, uploaded GL texture out.
//
// The draw list is built over STRING handles (a node's `textureUrl`, which is the host's `/res/...` route), because
// the builder runs offline in the gate and under bare Node, where there is no GL. The executor wants
// `CanvasTextureHandle`s. This module is the join: an adapter that presents itself to the builder as a
// `DrawList<string>` while pushing into a real `DrawList<ExecutorTexture | null>`, resolving each url on the way
// past.
//
// WHY NOT REUSE `textureCache`'s IMAGES. It has none to reuse. `warmImage` creates an `Image`, records its natural
// size on load and then DROPS the element on purpose (a live phone session had leaked 381 load listeners, one per
// distinct sprite). What survives is the size and the browser's own HTTP/image cache — which is exactly what the
// DOM backend needs, because it hands the url back to the browser as a `background-image`. A GL upload needs the
// decoded pixels in hand, so this module keeps its own element per url. The browser's cache means the second
// request costs no network.
//
// ONE READINESS BIT, and it is the whole reason this is not two mechanisms. A url is READY only when its image has
// decoded AND its texture is uploaded; until then `sizeOf` reports null too. That matters because of what the
// executor does with a zero-span source rect: it stretches ONE TEXEL over the quad (correct for an untextured
// solid fill on the white texel, and a full-box smear of pixel (0,0) for anything else). So a half-resolved
// texture would paint a flat colour block over the scene. Instead an unresolved quad is pushed FULLY TRANSPARENT
// — it keeps its command index, so ranges and clip intervals stay exactly where the builder put them — and the
// load's completion re-runs the build. Nothing is drawn wrong; something is drawn a frame or two late.
//
// CORS. The frontend is not always served by the host that serves `/res/` (the LNA web-link / hosted-pages
// shapes), and `texImage2D` of a cross-origin image without CORS taints the context and throws. Each url is tried
// `crossOrigin="anonymous"` first and retried WITHOUT it on error, so a host that sends no `Access-Control-Allow-
// Origin` still loads the image for the DOM path's sake; the upload then throws and the url is marked failed
// rather than taking the frame down with it.
//
// ---------------------------------------------------------------------------------------------------------------
// UPLOAD PACING — the reason this module has a budget in it.
//
// `cache.acquire(url, source)` is not a hand-off that some later bind pays for: it calls `texImage2D` THERE, on the
// calling thread, before it returns. So every new url a build names is a synchronous main-thread upload inside that
// build, and the FIRST textured build of a screen names all of them at once. Measured on this project's headless
// box (SwiftShader), a premultiplied RGBA upload runs ~2.8-4.1 ms per MB and is near-linear in bytes:
//
//     256x256   0.25 MB   0.5 ms      1914x1976  14.4 MB   56.0 ms
//     1024x1024 4.00 MB  11.0 ms      3275x3071  38.4 MB  133.6 ms
//     2047x2047 16.0 MB  65.5 ms      4031x3839  59.0 MB  199.8 ms
//
// The combat recording settles at ~166 MB resident across ~43 urls, i.e. ~570 ms of `texImage2D` that today lands
// in as few tasks as the build order allows; the phone (5-10x slower here) recorded a 23.6 s long task on its first
// textured combat build. So this module spends a BYTE BUDGET per build and defers the rest to the next frame.
//
// BYTES, NOT COUNT, IS THE CURRENCY, because the cost is linear in bytes and the sizes span 200x. The count cap is
// secondary and exists only for the fixed per-upload cost (~0.5 ms of bind + `texParameteri` + driver validation,
// which is the whole of the 256x256 sample above).
//
// PAINT-ORDER-FIRST, and it costs nothing to get. `buildDrawList` walks in paint order and `pushTextured` is where
// an upload happens, so the first budget-worth of NEW uploads in a build ARE the earliest-painted ones — the
// background before the cards, the cards before a tooltip. There is no queue and no priority comparator here; the
// builder's own order is the priority, which is also why this cannot drift out of sync with what the frame needs.
// The alternative (visible-first) would need a second pass to know what is visible, and on this stage "visible" and
// "painted early" are close enough that the pass would not pay for itself.
//
// THE ALWAYS-ALLOW-ONE RULE. A budget smaller than a single texture must not deadlock it, so the first upload of
// every build is unconditional. That also fixes the floor of what pacing can achieve: a 59 MB card atlas is one
// indivisible `texImage2D`, so its ~200 ms (here) / seconds (phone) is a single task no budget can split. What
// pacing does is guarantee such a page is never uploaded in the same task as another one.
//
// CUTTING THAT PAGE IS `atlasRepack`'s JOB, and as of Aug 27 it is done and on by default: the re-packer answers a
// quad with a CROP of the page (`options.repack` below), so the sheet's `acquire` never happens at all and the
// floor moves down to whatever the largest page it does NOT claim costs. This module's budget is unchanged and
// still the only one — a crop's upload is charged here, through the same `budgetSpent`.
//
// DECODE IS PART OF THE UPLOAD TASK unless something forces it earlier, which is why readiness waits on `decode()`
// where the browser has it. `texImage2D` of an `HTMLImageElement` whose bitmap Chrome has not produced yet decodes
// it SYNCHRONOUSLY, inside the frame, and that cost is invisible to a byte budget — a paced build would then spend
// a predictable 4 MB and an unpredictable decode. `decode()` resolves once the bitmap exists (off the main thread
// where the browser can), so the FIRST upload of a url is fully paid for by the time the pacer prices it.
//
// …AND THAT IS ONLY TRUE ONCE. Corrected Aug-28 by a Moto G86 combat trace; the paragraph above used to end "so by
// the time the pacer spends budget on a url, the budget is the whole bill", and it is not.
//
// `decode()` resolves, and Chrome is then free to DISCARD the decoded frame — an `<img>`'s pixels are a cache, not
// a possession, and a phone under memory pressure evicts them. Nothing tells us when. The next draw that needs
// them re-decodes the whole PNG synchronously, and the trace shows exactly that: seven `Decode LazyPixelRef`
// re-decodes of the 4032x4072 card sheets, 260-306 ms each, ~2.0 s of main thread, every one inside a rAF and
// every one priced by this module as the ~1.4 MB crop it produced.
//
// So the honest statement of the budget's scope is: it prices BYTES UPLOADED, and it assumes the pixels it is
// uploading already exist. Where they might not, the fix is not a bigger budget — no byte figure can predict an
// eviction — it is to hold pixels the browser cannot take back. See `decodedPageSource` below, which lets the
// re-packer cut from an `ImageBitmap` (owned pixels) instead of from the element (a cache), and `CROP_HOSTILE_MS`
// in atlasRepack for what happens on the pages where no such source exists.
//
// THE `fx://` AND `spine://` KEY SPACES — the two populations of textures this module does NOT own.
//
// Effect surfaces (a gsw shader or particle canvas) are keyed `fx://<nodeId>` and uploaded by `fxSurfaces`,
// because their pixels CHANGE: everything above — one load, one upload, a residency clock — is wrong for them.
// Spine clip stills are keyed `spine://<clipUrl>` and uploaded by `spineSurfaces`, because their pixels arrive
// ALREADY DECODED (the overlay's own `<img>`) and are 4-16 MB apiece — one of those through the 4 MB page budget's
// always-allow-one would spend a whole screen's atlas budget on a creature.
//
// The draw list is still ONE list of string handles, so both key spaces arrive here; `options.fx` / `options.spine`
// are where they are handed on. With neither configured, nothing here even tests a prefix.
//
// MAX TEXTURE DIMENSION. A source longer than the context's `MAX_TEXTURE_SIZE` cannot be uploaded at all: WebGL
// answers `texImage2D` with INVALID_VALUE rather than an exception, leaving the texture INCOMPLETE — which samples
// as opaque black, i.e. a black rectangle over the scene, and would ALSO be re-attempted (and re-charged to the
// budget) on every build forever. So an oversized source is refused here, before the upload, and counted as failed:
// the quad then paints transparent, which is this module's existing and legible answer for "no pixels".

import type {
  CanvasTextureCache,
  ClipRectView,
  DrawList,
  ExecutorTexture,
  GlyphsView,
  NinePatchView,
  PolylineView,
  QuadView
} from "@godot-scene-web/canvas";

import type { AtlasRepackHost, AtlasRepackStats, AtlasRepacker, RepackSrcRect } from "@/mirror/canvas/atlasRepack";
import { FX_KEY_PREFIX, type FxTextureSource } from "@/mirror/canvas/fxSurfaces";
import { SPINE_KEY_PREFIX, type SpineTextureSource } from "@/mirror/canvas/spineSurfaces";
import { TEXT_KEY_PREFIX, type TextTextureSource } from "@/mirror/canvas/textSurfaces";

/** How long a url the scene stopped naming stays resident before its texture is released. */
const EVICT_AFTER_BUILDS = 240;

/**
 * Default per-build upload budget, in bytes.
 *
 * 4 MB is one 60 Hz frame's worth of upload on the box the ms/MB table in the header was measured on (the 1024x1024
 * sample IS 4 MB and cost 11.0 ms). It also sits BELOW every atlas page P5 found (9.3-59 MB) and ABOVE nearly every
 * individual sprite, which is the split that matters: each big page gets a task to itself, while the long tail of
 * small art still flows several per frame instead of stretching a 43-texture screen over 43 frames.
 */
export const TEXTURE_PACE_BYTES_DEFAULT = 4 * 1024 * 1024;

/**
 * THE RESIDENT PAGE-BYTE CAP, default 192 MB.
 *
 * Until this existed the bridge's pages were the largest UNCAPPED resident population on the stage: the only
 * governors were a per-build upload PACE (which shapes when bytes arrive, not how many stay) and a 240-build
 * age-out (which is a clock, not a budget). Every population that already HAD a cap sat far below it over the
 * same runs — the re-packer used 1.3 MB of its 24 MB.
 *
 * THE MEASUREMENT, and the correction it needed. The census's `textures.bytes` is the SHARED cache total: the
 * fx surfaces, the spine stills, the label rasters and the re-packer's regions all acquire from the same cache
 * the bridge does, so that number is not a page figure and must not be read as one. Decomposed on the host at
 * the device's own geometry (dpr 3.4876, viewport 703x281, quality static):
 *
 *   combat-modern    80.3 MB shared - 0.4 repack           = ~79.9 MB of pages
 *   audit-shop-open  84.9 MB shared - 1.3 repack           = ~83.6 MB of pages
 *   r13-discard-10  128.5 MB shared - 3.0 fx - 0.9 repack  = ~124.6 MB of pages
 *   r13-discard-10  331.2 MB shared - 209.2 fx - 0.4 repack = ~121.6 MB of pages   (effects DYNAMIC)
 *
 * The last row is the point: running the effects dynamic quadruples the shared total and leaves the PAGE total
 * flat. The dynamic excursion belongs to the fx surfaces, which are a separate uncapped population with their
 * own (unlanded) ceiling — which is exactly why this cap counts its own bytes rather than reading the cache's.
 *
 * 192 MB therefore sits above every measured single-screen page total with about 50% of headroom, so an
 * ordinary screen never touches the ceiling. What it actually bounds is CROSS-SCREEN ACCUMULATION — a session
 * that walks combat to shop to a map to a rest site and keeps every page it has ever drawn. That is what "it
 * gets progressively worse over a session" describes, and a clock alone cannot bound it: a page the scene keeps
 * naming never ages out however many other pages arrive behind it.
 *
 * `0` is the documented OFF switch, matching the pace budgets beside it.
 */
export const TEXTURE_RESIDENT_BYTES_DEFAULT = 192 * 1024 * 1024;

/**
 * Default per-build upload COUNT cap — secondary to the byte budget, and here only because each upload carries a
 * fixed ~0.5 ms of bind/parameterize/validate regardless of size. Eight is ~4 ms of that floor.
 */
export const TEXTURE_PACE_COUNT_DEFAULT = 8;

/**
 * THE TINY-PAGE EXEMPTION (R6 P6-B1) — the largest byte a build may still upload without asking the budget.
 *
 * The pacer has no queue and no comparator by design (see the header): the builder's own paint order IS the
 * priority. That is right for the atlas pages it was written for, and wrong for one population — a texture that is
 * a few kilobytes and is wanted by something ALREADY ON SCREEN. The comet's trail page is 32x32 = 4,096 bytes, and
 * on a cold screen it queues behind ~158 MB of card atlas: for the several builds that takes, every ribbon draws
 * its banded fallback instead of its texture. Waiting is a real cost and the thing waited for is free.
 *
 * 64 KB is chosen to bound the FIXED cost of one upload rather than its byte cost: the ms/MB table's smallest
 * sample (256x256 = 256 KB, 0.5 ms) is essentially all bind + parameterize + validate, and a quarter of that is
 * ~0.5 ms whatever the pixels are. Anything at or below it is a rounding error against a 4 MB budget that already
 * costs ~11 ms, so admitting it cannot be what makes a frame late.
 *
 * The asset-size distribution has NO gap at the small end (501 assets are ≤64 KB in the recorded corpus), so this
 * is NOT a "these are the special small ones" argument and must not be read as one. It is a PER-BUILD ALLOWANCE:
 * the exemption is capped in total by {@link TEXTURE_TINY_BUILD_BYTES}, so a screen full of small art cannot use it
 * to reinstate the storm.
 */
export const TEXTURE_TINY_BYTES_DEFAULT = 64 * 1024;

/**
 * How much exempt upload one build may do IN TOTAL, over and above its ordinary budget.
 *
 * 256 KB is four maximal tiny uploads, i.e. ~0.7 ms on the desktop the ms/MB table was measured on and ~4-7 ms on
 * the phone (5-10x). That is under a frame on the phone and invisible on the desktop, which is the property this
 * number has to have: the exemption is allowed to make a build slightly longer, never to make it late.
 */
export const TEXTURE_TINY_BUILD_BYTES = 256 * 1024;

export interface TextureBridgeStats {
  /** Same-context producer aliases currently reachable by the active draw list. */
  readonly stageTextureBindings: number;
  /** Distinct urls the bridge has been asked for. */
  requested: number;
  /** Urls with a live uploaded texture right now. */
  resident: number;
  /**
   * Urls that are referenced and neither resident nor failed — i.e. still coming. That is loads in flight PLUS
   * anything the pacer holds back, and the union is deliberate: a reader (and the parity gates) treats
   * `referenced - resident - failed` as "not done yet", so a paced url that reported neither would read as
   * finished while its pixels were still queued. {@link paced} breaks the second half back out.
   */
  pending: number;
  /** Urls that will never resolve (network error, a tainted/undecodable source, or over `MAX_TEXTURE_SIZE`). */
  failed: number;
  /** The subset of {@link pending} that is decoded and waiting only on the upload budget. */
  paced: number;
  /**
   * Transitions OUT of {@link paced}, cumulative and monotonic for the life of the bridge.
   *
   * The consumer is draw-list verification, which patches a list, rebuilds behind the
   * patch and compares the two — so it must be able to say whether the WORLD moved in that window. Neither
   * counter it had could: `pending` nets a release against any load starting in the same window and reads the
   * same on both sides, and `paced` is a GAUGE sampled at the same point on both sides, so it never differs
   * either (that was tried and reverted). A value that only ever goes UP turns the question into a comparison of
   * two readings, which is answerable.
   *
   * HONESTY LIMIT: this counts EVERY transition out of `awaitingUpload`, not only the two that put pixels on
   * screen (a page released post-acquire, a re-packer region served). The ABANDONMENT paths move it too — a
   * source the driver refused, a url the scene stopped naming before its turn came, a context loss. That is
   * deliberate: the counter is only ever read to EXCLUDE a frame from a comparison and never to admit one, so
   * over-counting costs at most a verified frame and can never manufacture a pass. Counting at the single
   * `clearAwaiting` choke point is the other half of it — no future caller can add a release the counter does
   * not see, which is exactly the class of omission that produced the defect this exists to fix.
   */
  paceReleases: number;
  /**
   * Times the TINY-PAGE EXEMPTION admitted an upload the budget would have deferred (R6 P6-B1). A GRANT count,
   * not an upload count: the re-packer asks through `admit` and can still decline the crop afterwards, so this
   * can run slightly ahead of `uploads`. Zero with the exemption off, which is the A/B arm.
   */
  paceExempt: number;
  /** Bytes charged against the per-build tiny allowance, cumulative — what the exemption actually cost. */
  paceTinyBytes: number;
  /** Quads pushed fully transparent because their texture was not ready — including pacer deferrals. */
  deferredQuads: number;
  /** Textures released because nothing named them for {@link EVICT_AFTER_BUILDS} builds. */
  evicted: number;
  /** The resident page-byte ceiling in force (0 = off) — see {@link TEXTURE_RESIDENT_BYTES_DEFAULT}. */
  residentCap: number;
  /**
   * Textures released by that ceiling rather than by the age-out. Kept separate from {@link evicted} because
   * they mean opposite things: an age-out is a page nothing wants any more, and a cap eviction is a page that
   * may well be wanted next build. A number climbing here on an ordinary screen says the cap is too low.
   */
  evictedByCap: number;
  /** Resident PAGE bytes this bridge is holding — what {@link residentCap} is compared against. */
  pageBytes: number;
  /** Resident RGBA bytes, as gsw's cache counts them. */
  bytes: number;
  /** Uploads (`texImage2D` through `cache.acquire`) this bridge has made. */
  uploads: number;
  /** Total main-thread ms spent inside those uploads — the storm, priced. */
  uploadMs: number;
  /** The longest single upload, ms. Pacing cannot push this below the biggest single page (see the header). */
  maxUploadMs: number;
  /** The largest total upload ms charged to ONE build — what pacing is supposed to flatten. */
  maxBuildUploadMs: number;
  /** `performance.now()` of the most recent upload, i.e. time-to-all-resident once the scene has settled. */
  lastUploadAt: number;
  /** Urls refused because a side exceeded `maxTextureDim` (a subset of {@link failed}). */
  oversized: number;
  /**
   * Ready urls whose PAGE upload is currently being avoided because the re-packer's regions serve every quad
   * naming them — see the `rp://` seam note on {@link TextureBridgeOptions.repack}.
   *
   * Such a url counts as neither {@link resident} (there is no page texture) nor {@link pending} (nothing is
   * owed), so it is the one break in the `referenced - resident - failed = still coming` reading and this is
   * where it shows up. `0` whenever the re-packer is off.
   */
  repackServed: number;
  /** RGBA bytes of page that {@link repackServed} represents — the headline number the re-packer exists for. */
  pageBytesAvoided: number;
  /**
   * Quads the re-packer CLAIMED and then refused, falling back to the page.
   *
   * Expected to be zero: a claim that cannot be served promotes the whole page instead, so this counts the races
   * and driver rejections that get past that, and a non-zero value on a gated run is an anomaly to chase.
   */
  repackPageFallbacks: number;
  /** Whole-page bitmap captures started when a bitmap decoder is available. At most one is in flight. */
  pageDecodes: number;
  /** Captures that rejected, or answered a size the page disagrees with. Those urls upload from the `<img>`. */
  pageDecodeFailed: number;
  /** Resolved captures closed unspent because the scene stopped naming the page. */
  pageDecodeStale: number;
  /** Uploads whose source was an `ImageBitmap` this module owned. */
  pageOwnedUploads: number;
  /** Uploads whose source was the entry's `<img>` — the only arm that can re-decode inside a build. */
  pageElementUploads: number;
  /**
   * Total wall time to RESOLVE the captures, ms. Includes whatever the browser did off-thread, so this is a
   * latency figure and not a main-thread bill — {@link maxPageDecodeSyncMs} is the one that is.
   */
  pageDecodeMs: number;
  /**
   * The worst SYNCHRONOUS cost of a single `createImageBitmap` call, ms — the time the call took to RETURN, before
   * anything awaited its promise. This is the number that settles whether the capture is a main-thread copy (gsw
   * measured 576 ms on a GPU-resident source) or genuinely off-thread, and therefore whether moving it out of the
   * animation frame moved a real cost or an imaginary one. Whatever it says, the capture is in its OWN task.
   */
  maxPageDecodeSyncMs: number;
}

export interface TextureBridge {
  /**
   * The page size of a url, or null until it is READY (see the header). This is the builder's `textureSize`, and
   * asking for one that is unknown STARTS the load — so a scene naming a new sprite warms it by drawing it.
   */
  sizeOf(url: string): { width: number; height: number } | null;
  /**
   * Resolve a source rect only when its exact page/crop mapping is already resident.
   *
   * This never starts a load, acquires a texture, cuts a crop or changes a residency clock. `null` therefore means
   * a source patch must rebuild through the normal bridge path, where those operations are permitted.
   */
  residentSource(url: string, src: RepackSrcRect): { handle: ExecutorTexture; dx: number; dy: number } | null;
  /** True only after this bridge has uploaded the exact page into its stage texture registry. */
  isResident(url: string): boolean;
  /** Resolve a full-page source into this stage now. Used only by DOM-free effect passes. */
  stageTexture(url: string): ExecutorTexture | null;
  /**
   * Name a same-context texture already owned by another stage producer.
   * This never acquires/releases it: the producer that created the cache entry
   * retains lifetime ownership. It exists for DOM-free sources (Spine/geoclip
   * and headless effects), whose pixels must reach this list without an image
   * element or a second upload.
   */
  bindStageTexture(key: string, handle: ExecutorTexture): void;
  /** Start a new full list build; stage-owned bindings are rebuilt from its visible sources. */
  beginStageTextureBuild(): void;
  /** Wrap a real draw list so `buildDrawList` can push string handles into it. */
  adapt(list: DrawList<ExecutorTexture | null>): DrawList<string>;
  /** Called once per completed build: ages the residency clock and evicts what the scene stopped naming. */
  endBuild(): void;
  /** Forget every upload WITHOUT touching GL (context loss). The urls stay known, so a rebuild re-uploads. */
  invalidate(): void;
  readonly stats: TextureBridgeStats;
  /** The re-packer's own counters. */
  repackStats(): AtlasRepackStats | null;
  dispose(): void;
}

export interface TextureBridgeOptions {
  cache: CanvasTextureCache;
  /** Called when a url finishes loading — the renderer's cue to rebuild and repaint. Batched by the caller. */
  onResolved(url: string): void;
  /** A source could not fetch/decode. The canvas static-background bridge uses this to fail open. */
  onFailed?(url: string): void;
  /**
   * Called at the end of a build that left decoded urls unuploaded, i.e. "come back for the rest". The caller MUST
   * answer with a repaint that does NOT acknowledge a scene delta (see the note at `scheduleTexturePaint`).
   */
  onPaced?(): void;
  /** Injectable for tests; defaults to `new Image()`. */
  createImage?: () => HTMLImageElement;
  /**
   * AN EVICTION-PROOF CROP SOURCE for the re-packer, asked per page, per build. Return null (or omit the option
   * entirely) and nothing changes: the re-packer crops from this module's own `<img>` exactly as before.
   *
   * WHY IT EXISTS. A `<img>`'s decoded frame is a CACHE. Chrome discards it under memory pressure and re-decodes
   * it lazily on the next `drawImage` — so the re-packer's crop, which this module's header used to argue "costs
   * nothing new", can cost a full synchronous PNG decode. Measured on a Moto G86 (Aug-28, 29.5 s combat trace):
   * seven `Decode LazyPixelRef` re-decodes of the 4032x4072 card sheets, 260-306 ms each, ~2.0 s of main thread,
   * every one inside a rAF. See the DECODE note in this module's header, which that trace corrected.
   *
   * The intended supplier is `atlasBaker.atlasDecodedSource`: `imagePrefetch` already decodes every atlas into an
   * `ImageBitmap` at app mount and holds it for the life of the page, and a bitmap is owned pixels rather than a
   * cache, so `drawImage` of one cannot re-decode. This module stays free of that dependency — it is handed a
   * function, which is also what lets a test supply pixels without a decoder.
   *
   * THE SIZE CHECK IS THIS MODULE'S, not the supplier's: a source whose dimensions disagree with the page's own
   * `naturalWidth`/`naturalHeight` is ignored, because the crop rect is in page-pixel coordinates and a
   * differently-sized decode would cut the wrong sprite silently instead of failing loudly.
   */
  decodedPageSource?: (url: string) => CanvasImageSource | null;
  /**
   * Upload a WHOLE page from an `ImageBitmap` this module mints and owns, rather than from its `<img>`, whenever
   * {@link decodeElement} or `createImageBitmap` is available.
   *
   * THE SAME BUG AS {@link decodedPageSource}, one path over. That option fixed the re-packer's CROP source, which
   * was the 260-306 ms class. The pages that go up WHOLE — the vfx PNGs, which `imagePrefetch` does not carry, so
   * `atlasBaker` has no bitmap to lend them — kept the original shape: `cache.acquire(url, entry.image)` on an
   * element whose decoded frame the phone had since evicted, re-decoding it inside the build. The same Moto G86
   * trace measured 40.5 / 37.0 / 36.8 / 18.7 / 18.0 / 17.5 / 14.2 ms of that around +20 s.
   *
   * WHAT THIS BUYS, precisely. `createImageBitmap(HTMLImageElement)` is NOT free and may not even be
   * asynchronous — gsw's `surface-image-swap` measured a synchronous 576 ms capture on a GPU-resident source — so
   * this does not claim to make the decode disappear. It claims two narrower things:
   *   1. the cost is moved OUT of the animation frame (the capture is scheduled as its own task), and
   *   2. it is paid ONCE, because a bitmap cannot be evicted and re-decoded the way an element's frame can.
   * `pageDecodeSyncMs` exists so claim 1 can be checked on the device instead of assumed: it is the wall time the
   * `createImageBitmap` CALL itself took, which is the whole of the main-thread cost when the capture is
   * synchronous and ~0 when it is not.
   *
   * The transient RGBA is bounded by ONE page (a single decode slot, closed the moment the upload returns) and is
   * only ever spent on a page a build actually named. Everywhere it is unavailable — no `createImageBitmap`, a
   * decode that rejects, a bitmap whose size disagrees with the page's — the `<img>` upload runs exactly as before.
   */
  /** TEST-ONLY seam for the bitmap capture. Defaults to `createImageBitmap`. */
  decodeElement?: (img: HTMLImageElement) => Promise<ImageBitmap>;
  /**
   * Where the capture runs. Defaults to `setTimeout(task, 0)` — a MACROTASK, deliberately: `pageHandleFor` is
   * called from inside a build, and a microtask would land the (possibly synchronous) capture in the very
   * animation frame this is trying to get it out of.
   */
  scheduleDecode?: (task: () => void) => void;
  /**
   * Per-build upload budget in bytes. `0` (or a non-finite value) turns pacing OFF — every url a build names is
   * uploaded in that build, which is what this module did before pacing existed and what a zero injected budget asks
   * for. Defaults to {@link TEXTURE_PACE_BYTES_DEFAULT}.
   */
  paceBytes?: number;
  /** Per-build upload count cap; `0` means uncapped. Defaults to {@link TEXTURE_PACE_COUNT_DEFAULT}. */
  paceCount?: number;
  /**
   * Largest upload the TINY-PAGE EXEMPTION admits without asking the budget, in bytes. `0` turns the exemption off
   * (a zero injected exemption), which is the A/B arm. Defaults to {@link TEXTURE_TINY_BYTES_DEFAULT}; the total a
   * build may admit this way is fixed at {@link TEXTURE_TINY_BUILD_BYTES}.
   */
  paceTinyBytes?: number;
  /**
   * The context's `MAX_TEXTURE_SIZE`. A source with a longer side is refused rather than uploaded incomplete (see
   * the header). Omitted (or 0) means "do not check", which is what a test without a real GL context wants.
   */
  maxTextureDim?: number;
  /**
   * THE `fx://` SEAM. A second population of textures shares the stage's texture cache: EFFECT surfaces, whose
   * pixels a gsw runtime repaints and which `fxSurfaces` re-uploads (see that module's header for why its
   * lifecycle is the opposite of this one's). The draw list is one list, so both populations arrive here as
   * string handles, and the `fx://` prefix is what says which registry owns a key.
   *
   * Absent — which is every caller until the fx registry is wired — nothing about this module changes: no key the
   * builder emits today starts with `fx://`, and the prefix is not even tested for.
   *
   * NOTE for whoever wires it: {@link TextureBridgeStats.bytes} is the whole cache's byte total, so once fx
   * textures live in the same cache it counts theirs too. `fx.bytes` reports the fx share separately.
   */
  fx?: FxTextureSource;
  /**
   * THE `spine://` SEAM — the same shape as {@link TextureBridgeOptions.fx}, for a THIRD population: server-baked
   * spine clip stills, uploaded by `spineSurfaces` from the pixels the DOM overlay already decoded.
   *
   * Absent (every caller that wires no spine registry) nothing about this module
   * changes: no key the
   * builder emits then starts with `spine://`, and the prefix is not even tested for.
   *
   * The prefix test has to come BEFORE `entryFor`, and more so than for `fx://`: a spine key WRAPS a real url
   * (`spine:///spines/<scene>?anim=…`), so falling through would start an image load for it.
   */
  spine?: SpineTextureSource;
  /**
   * THE `text://` SEAM — the same shape again, for a FOURTH population: label rasters drawn by `textSurfaces` on
   * its own 2D canvas (M4).
   *
   * Absent (every non-canvas stage) nothing about this module changes: no key
   * the builder emits then starts with `text://`, and the prefix is not even tested for.
   *
   * The prefix test has to come before `entryFor` for a sharper reason than either seam above. A `text://` key's
   * suffix is a raster DIGEST, and its first field is the label's own string — so a fall-through would hand
   * arbitrary game text to `entryFor` AS A URL, fetch it, fail, and mark an entry permanently failed. The label
   * would then never paint again on either path.
   */
  text?: TextTextureSource;
  /**
   * THE `rp://` SEAM — the RUNTIME ATLAS RE-PACKER, absent (and therefore invisible) unless a caller passes it.
   *
   * A FACTORY, not an instance, because the re-packer spends THIS module's upload budget: it is handed the
   * `admit`/`noteUpload` closure over `budgetSpent` and the build counters, so a crop's `texImage2D` is paced
   * against the same bytes and count as a page's rather than out of a second, unrelated allowance.
   *
   * WHAT IT CHANGES HERE, in full: a quad whose page is big enough gets a CROP's texture instead of the page's,
   * and its source rect is rebased into that crop for the push. The page's `acquire` then simply never happens —
   * the skip is emergent, there is no branch that says "do not upload the page". The `<img>` is still retained,
   * because the crops are cut from it.
   *
   * WHAT IT DOES NOT CHANGE: what the draw list SAYS. `textureAt` still answers the page url and `readQuad` still
   * answers the original source rect (see `adapt`'s `srcDx`/`srcDy`), so the paint-dump parity gate is
   * byte-identical with the re-packer on or off BY CONSTRUCTION rather than by tolerance. An `rp://` key exists
   * only between here and gsw's cache.
   */
  repack?: (host: AtlasRepackHost) => AtlasRepacker;
  /**
   * Resident RGBA byte ceiling for this bridge's PAGE textures — see {@link TEXTURE_RESIDENT_BYTES_DEFAULT}.
   * `0` disables it. Pages only: the re-packer, the fx surfaces, the spine stills and the label rasters each
   * keep their own governor, and a shared budget would make one population's growth evict another's working
   * set for reasons that have nothing to do with either.
   */
  residentBytes?: number;
}

interface Entry {
  url: string;
  state: "pending" | "ready" | "failed";
  width: number;
  height: number;
  /** Retained past the upload for context-loss re-read and as the re-packer's crop source. */
  image: HTMLImageElement | null;
  /** Whether this url's texture is currently held in the gsw cache (so `release` is balanced). */
  uploaded: boolean;
  /** The build ordinal this url was last drawn in — the residency clock. */
  lastSeen: number;
  /** Has the `crossOrigin="anonymous"` attempt already failed? */
  retriedPlain: boolean;
  /** Decoded, wanted by the build that just ran, and held back by the pacer. Counted into `stats.paced`. */
  awaitingUpload: boolean;
  /**
   * Owned pixels for a WHOLE-page upload, held only between the capture resolving and the upload spending it.
   * Exists only when a bitmap decoder is available.
   */
  bitmap: ImageBitmap | null;
  /** A capture for this url is in flight; it holds the module's one decode slot until it lands or fails. */
  decoding: boolean;
  /** The capture failed, or answered the wrong size. This url uploads from its `<img>` for the rest of the run. */
  bitmapFailed: boolean;
}

/**
 * How many builds a resolved-but-unspent page bitmap may hold the decode slot.
 *
 * The pacer pump (`onPaced`) brings a page a build still wants back on the very next build, so anything older
 * than this was named by a scene that has since moved on — and it is holding both megabytes and the slot the
 * next page needs.
 */
const PAGE_BITMAP_STALE_BUILDS = 2;

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function createTextureBridge(options: TextureBridgeOptions): TextureBridge {
  const cache = options.cache;
  const fx = options.fx;
  const spine = options.spine;
  const text = options.text;
  const makeImage = options.createImage ?? (() => new Image());
  const askDecodedPage = options.decodedPageSource ?? null;
  const decodeElement =
    options.decodeElement ??
    (typeof createImageBitmap === "function" ? (img: HTMLImageElement) => createImageBitmap(img) : null);
  // A macrotask by default — see {@link TextureBridgeOptions.scheduleDecode} for why a microtask would defeat it.
  const scheduleDecode = options.scheduleDecode ?? ((task: () => void) => void setTimeout(task, 0));
  const canDecodeOwnedPage = decodeElement !== null;
  const entries = new Map<string, Entry>();
  /** Handles owned by non-URL stage producers; cleared on a context reset. */
  const stageTextures = new Map<string, ExecutorTexture>();
  let build = 0;
  let disposed = false;
  /** The url whose capture owns the one page-decode slot, or null when it is free. */
  let pageDecodeSlot: string | null = null;

  // `0` is the documented OFF switch for both, so a caller that computed a budget of zero gets today's unpaced
  // behaviour rather than a stage that uploads one texture per frame forever.
  const paceBytes = normalizeBudget(options.paceBytes, TEXTURE_PACE_BYTES_DEFAULT);
  const paceCount = normalizeBudget(options.paceCount, TEXTURE_PACE_COUNT_DEFAULT);
  const paceTinyBytes = normalizeBudget(options.paceTinyBytes, TEXTURE_TINY_BYTES_DEFAULT);
  const maxTextureDim =
    options.maxTextureDim != null && Number.isFinite(options.maxTextureDim) && options.maxTextureDim > 0
      ? options.maxTextureDim
      : 0;

  let loadingCount = 0;
  let pacedCount = 0;
  let residentCount = 0;
  const residentCap = normalizeBudget(options.residentBytes, TEXTURE_RESIDENT_BYTES_DEFAULT);
  /** Resident PAGE bytes, maintained alongside `residentCount` — the cache's own total also carries the
   *  re-packer's regions, and a page cap must not be moved by a population it does not govern. */
  let pageBytes = 0;

  /** Bytes and uploads charged to the build currently being walked; reset by `endBuild`. */
  let buildBytes = 0;
  let buildUploads = 0;
  let buildUploadMs = 0;
  /**
   * Bytes charged against this build's TINY-PAGE ALLOWANCE (see {@link TEXTURE_TINY_BUILD_BYTES}). Charged at the
   * two upload sites for EVERY small upload, not only the exempted ones, which over-counts on purpose: the sites
   * cannot tell which rule admitted them, and over-counting can only make the allowance stricter.
   */
  let buildTinyBytes = 0;

  const stats: TextureBridgeStats = {
    get stageTextureBindings() {
      return stageTextures.size;
    },
    requested: 0,
    get resident() {
      return residentCount;
    },
    get pending() {
      return loadingCount + pacedCount;
    },
    get paced() {
      return pacedCount;
    },
    // A PLAIN FIELD, not a getter over a level — see the doc comment. The gauge is what failed here.
    paceReleases: 0,
    paceExempt: 0,
    paceTinyBytes: 0,
    failed: 0,
    deferredQuads: 0,
    evicted: 0,
    residentCap: 0, // assigned immediately below, once `residentCap` is in scope
    evictedByCap: 0,
    get pageBytes() {
      return pageBytes;
    },
    bytes: 0,
    uploads: 0,
    uploadMs: 0,
    maxUploadMs: 0,
    maxBuildUploadMs: 0,
    lastUploadAt: 0,
    oversized: 0,
    get repackServed() {
      return repackSummary().urls;
    },
    get pageBytesAvoided() {
      return repackSummary().bytes;
    },
    repackPageFallbacks: 0,
    pageDecodes: 0,
    pageDecodeFailed: 0,
    pageDecodeStale: 0,
    pageOwnedUploads: 0,
    pageElementUploads: 0,
    pageDecodeMs: 0,
    maxPageDecodeSyncMs: 0
  };
  stats.residentCap = residentCap;

  /**
   * How much page this build is not uploading, walked rather than counted incrementally.
   *
   * A url's page is being AVOIDED when it is decoded, has no page texture of its own, and the re-packer holds
   * live regions cut from it. All three legs can change without this module hearing about it (a region can be
   * evicted by the re-packer's own clock), so the honest answer is a walk — over ~50 entries, once per census.
   */
  function repackSummary(): { urls: number; bytes: number } {
    if (repack === null) {
      return { urls: 0, bytes: 0 };
    }
    let urls = 0;
    let bytes = 0;
    for (const entry of entries.values()) {
      if (entry.state === "ready" && !entry.uploaded && repack.holds(entry.url)) {
        urls++;
        bytes += entry.width * entry.height * 4;
      }
    }
    return { urls, bytes };
  }

  function normalizeBudget(value: number | undefined, fallback: number): number {
    if (value === undefined) {
      return fallback;
    }
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /**
   * THE RE-PACKER, sharing this module's budget.
   *
   * `admit` is `budgetSpent` inverted — the same bytes, the same count, the same always-allow-one — because a
   * crop's upload lands in the same task as a page's and a second allowance would let one build spend twice.
   * `noteUpload` charges it: the CROP's ms goes into the build total (so `maxBuildUploadMs` stays a truthful
   * main-thread figure) but never into `maxUploadMs`, which means "the biggest single `texImage2D`" and would
   * stop meaning that if a `drawImage` counted.
   */
  const repackHost: AtlasRepackHost = {
    admit: (bytes) => !budgetSpent(bytes),
    noteUpload: (bytes, uploadMs, cropMs) => {
      buildBytes += bytes;
      buildUploads++;
      chargeTiny(bytes);
      buildUploadMs += uploadMs + cropMs;
      stats.uploads++;
      stats.uploadMs += uploadMs;
      if (uploadMs > stats.maxUploadMs) {
        stats.maxUploadMs = uploadMs;
      }
      stats.lastUploadAt = nowMs();
      stats.bytes = cache.stats.bytes;
    }
  };
  const repack: AtlasRepacker | null = options.repack ? options.repack(repackHost) : null;

  function markFailed(entry: Entry): void {
    if (entry.state === "failed") {
      return;
    }
    if (entry.state === "pending") {
      loadingCount--;
    }
    clearAwaiting(entry);
    entry.state = "failed";
    entry.image = null;
    // Nothing will ever upload this url again, so its pixels — and the slot they hold — are pure waste.
    freePageDecode(entry);
    stats.failed++;
    options.onFailed?.(entry.url);
  }

  /**
   * THE ONE WAY OUT of `awaitingUpload`, which is why the release counter is incremented here and nowhere else.
   * Every caller — the two real releases and the three abandonments — is already funnelled through this.
   */
  function clearAwaiting(entry: Entry): void {
    if (entry.awaitingUpload) {
      entry.awaitingUpload = false;
      pacedCount--;
      stats.paceReleases++;
    }
  }

  /** Load a pending url's element, including the CORS retry and forced decode. */
  function startFetch(url: string, entry: Entry): void {
    if (typeof Image === "undefined" && options.createImage === undefined) {
      // No DOM (jsdom without an Image constructor, a worker): the url can never resolve, and saying so is far
      // better than leaving every quad that names it invisible forever with no counter to show for it.
      markFailed(entry);
      return;
    }
    const live = (): boolean => !disposed && entry.state === "pending";
    const img = makeImage();
    img.decoding = "async";
    const settle = (): void => {
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
    };
    const ready = (): void => {
      if (!live()) {
        return;
      }
      entry.image = img;
      entry.width = img.naturalWidth;
      entry.height = img.naturalHeight;
      entry.state = "ready";
      loadingCount--;
      options.onResolved(url);
    };
    const onLoad = (): void => {
      settle();
      if (!live()) {
        return;
      }
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) {
        markFailed(entry);
        return;
      }
      // Force the decode HERE rather than letting `texImage2D` drag it into a paint frame (see the header). Where
      // `decode()` is missing — jsdom, an injected stub, an older engine — readiness is the load event exactly as
      // before, so this is an accelerator and never a gate.
      if (typeof img.decode === "function") {
        img.decode().then(ready, () => {
          // A decode failure after a successful load is a corrupt/undecodable body. Uploading it would fail too.
          if (live()) {
            markFailed(entry);
          }
        });
        return;
      }
      ready();
    };
    const onError = (): void => {
      settle();
      if (!live()) {
        return;
      }
      if (!entry.retriedPlain) {
        // The `anonymous` attempt failed. That is indistinguishable from a plain 404 here, so retry WITHOUT CORS:
        // a host that serves no `Access-Control-Allow-Origin` still gives us pixels, and the upload below is where
        // the tainting shows up (as a throw we can attribute). The entry stays `pending` and stays counted as one
        // load in flight across the retry.
        entry.retriedPlain = true;
        startFetch(url, entry);
        return;
      }
      markFailed(entry);
    };
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);
    if (!entry.retriedPlain) {
      img.crossOrigin = "anonymous";
    }
    img.src = url;
  }

  function entryFor(url: string): Entry {
    let entry = entries.get(url);
    if (entry === undefined) {
      entry = {
        url,
        state: "pending",
        width: 0,
        height: 0,
        image: null,
        uploaded: false,
        lastSeen: build,
        retriedPlain: false,
        awaitingUpload: false,
        bitmap: null,
        decoding: false,
        bitmapFailed: false
      };
      entries.set(url, entry);
      stats.requested++;
      loadingCount++;
      startFetch(url, entry);
    }
    return entry;
  }

  /**
   * Has this build already spent its budget? `buildUploads === 0` is the always-allow-one rule (see the header):
   * the first upload of a build never asks, so a texture larger than the whole budget still lands.
   */
  function budgetSpent(bytes: number): boolean {
    if (buildUploads === 0) {
      return false;
    }
    // THE TINY-PAGE EXEMPTION, second only to always-allow-one and before either cap — including the COUNT cap,
    // which a 4 KB page would otherwise be held behind for exactly the same reason it is held behind the byte one.
    // Bounded twice: per upload by `paceTinyBytes`, and per build by the allowance, so a screen of small art
    // cannot use this to reinstate the storm. See the constants for why neither bound is a frame.
    if (paceTinyBytes > 0 && bytes <= paceTinyBytes && buildTinyBytes + bytes <= TEXTURE_TINY_BUILD_BYTES) {
      stats.paceExempt++;
      return false;
    }
    if (paceBytes > 0 && buildBytes + bytes > paceBytes) {
      return true;
    }
    return paceCount > 0 && buildUploads >= paceCount;
  }

  /** Charge an admitted upload against the tiny allowance. Deliberately blind to WHICH rule admitted it. */
  function chargeTiny(bytes: number): void {
    if (paceTinyBytes > 0 && bytes <= paceTinyBytes) {
      buildTinyBytes += bytes;
      stats.paceTinyBytes += bytes;
    }
  }

  /**
   * The supplier's eviction-proof pixels for a page, or null when there are none this module may use. See
   * {@link TextureBridgeOptions.decodedPageSource} for why the caller wants these and what they cost.
   *
   * THE SIZE GATE IS THE WHOLE OF THE SAFETY ARGUMENT. A crop rect is in the coordinates of the page THIS module
   * measured (`entry.width`/`entry.height`, read off the `<img>`'s natural size), so a source of any other size
   * would cut a different sprite and paint it without complaint. Disagreement is therefore treated as "no source"
   * rather than as an error: the `<img>` path still serves the quad correctly, just more expensively.
   *
   * A zero-sized entry (a page whose load has not settled) can never match, which is the behaviour we want —
   * `resolveFor` only asks about `ready` entries anyway.
   */
  function decodedPageSource(url: string, entry: Entry): CanvasImageSource | null {
    if (askDecodedPage === null) {
      return null;
    }
    const source = askDecodedPage(url);
    if (source === null) {
      return null;
    }
    // `naturalWidth` for an element, `width` for a bitmap; anything that answers neither is not a page.
    const w = (source as HTMLImageElement).naturalWidth ?? (source as ImageBitmap).width;
    const h = (source as HTMLImageElement).naturalHeight ?? (source as ImageBitmap).height;
    if (w !== entry.width || h !== entry.height || !(w > 0 && h > 0)) {
      return null;
    }
    return source;
  }

  /**
   * Give up this entry's claim on the page-decode slot, closing any pixels it is still holding.
   *
   * Every exit a capture has funnels through here — spent, stale, failed, disposed — because the slot is what
   * bounds transient RGBA, and a leaked one would quietly switch owned page pixels off for the rest of the run.
   */
  function freePageDecode(entry: Entry): void {
    if (entry.bitmap !== null) {
      entry.bitmap.close();
      entry.bitmap = null;
    }
    entry.decoding = false;
    if (pageDecodeSlot === entry.url) {
      pageDecodeSlot = null;
    }
  }

  /**
   * Capture this page's pixels into a bitmap this module owns, in a task of its own.
   *
   * Answers nothing: the caller declines to upload this build either way — with a capture started, or with the
   * slot busy and this page queued behind another. The pacer pump (`onPaced`) is what brings it back.
   */
  function requestPageDecode(entry: Entry): void {
    if (decodeElement === null || pageDecodeSlot !== null || entry.decoding || entry.image === null) {
      return;
    }
    const img = entry.image;
    pageDecodeSlot = entry.url;
    entry.decoding = true;
    stats.pageDecodes++;
    scheduleDecode(() => {
      // The world may have moved during the task hop: disposed, the entry replaced, or the element re-fetched
      // (in which case `img` is the OLD one and its pixels are not this page's any more).
      if (disposed || entries.get(entry.url) !== entry || entry.image !== img) {
        freePageDecode(entry);
        return;
      }
      const t0 = nowMs();
      let capture: Promise<ImageBitmap>;
      try {
        capture = decodeElement(img);
      } catch {
        entry.bitmapFailed = true;
        stats.pageDecodeFailed++;
        freePageDecode(entry);
        options.onResolved(entry.url);
        return;
      }
      // MEASURED AROUND THE CALL, not around the await: a synchronous capture spends its whole cost before the
      // promise even exists. See {@link TextureBridgeStats.maxPageDecodeSyncMs}.
      const syncMs = nowMs() - t0;
      if (syncMs > stats.maxPageDecodeSyncMs) {
        stats.maxPageDecodeSyncMs = syncMs;
      }
      const fail = (): void => {
        entry.bitmapFailed = true;
        stats.pageDecodeFailed++;
        freePageDecode(entry);
        options.onResolved(entry.url);
      };
      capture.then((bitmap) => {
        stats.pageDecodeMs += nowMs() - t0;
        if (disposed || entries.get(entry.url) !== entry || entry.uploaded) {
          bitmap.close();
          freePageDecode(entry);
          return;
        }
        // THE SAME SIZE ARGUMENT `decodedPageSource` makes, for the same reason: every rect this module hands out
        // is in the coordinates it measured off the element, so pixels of another size are the wrong pixels.
        if (bitmap.width !== entry.width || bitmap.height !== entry.height) {
          bitmap.close();
          fail();
          return;
        }
        entry.decoding = false;
        entry.bitmap = bitmap;
        options.onResolved(entry.url);
      }, fail);
    });
  }

  /** The uploaded handle for a READY PAGE url, uploading it on first use. Null while pending / paced / failed. */
  function pageHandleFor(url: string): ExecutorTexture | null {
    const entry = entryFor(url);
    entry.lastSeen = build;
    if (entry.state !== "ready") {
      return null;
    }
    if (entry.uploaded) {
      const live = cache.peek(url);
      if (live) {
        return live;
      }
      // The cache dropped it under us (a `reset()` after context loss): fall through and re-upload.
      entry.uploaded = false;
      residentCount--;
      pageBytes -= entry.width * entry.height * 4;
    }
    // OWNED PIXELS FIRST. A bitmap outlives the element's decoded frame and cannot be evicted, so where one exists
    // it is both the cheaper and the safer source.
    const source: TexImageSource | null = entry.bitmap ?? entry.image;
    if (!source) {
      markFailed(entry);
      return null;
    }
    if (maxTextureDim > 0 && (entry.width > maxTextureDim || entry.height > maxTextureDim)) {
      // Refused, not attempted: an incomplete texture samples opaque black, and retrying every build would spend
      // the budget on it forever.
      stats.oversized++;
      markFailed(entry);
      return null;
    }
    const bytes = entry.width * entry.height * 4;
    if (budgetSpent(bytes)) {
      if (!entry.awaitingUpload) {
        entry.awaitingUpload = true;
        pacedCount++;
      }
      return null;
    }
    // AFTER the budget, so a capture is only ever spent on a page that would really have uploaded this build, and
    // BEFORE the upload, so the element's (possibly evicted, possibly multi-megabyte) decode never runs in here.
    // One build of a transparent page is what a paced page already costs; capture whenever the capability exists.
    if (canDecodeOwnedPage && entry.bitmap === null && !entry.bitmapFailed && entry.image !== null) {
      requestPageDecode(entry);
      if (!entry.awaitingUpload) {
        entry.awaitingUpload = true;
        pacedCount++;
      }
      return null;
    }
    const owned = entry.bitmap !== null;
    try {
      const t0 = nowMs();
      const handle = cache.acquire(url, source);
      const ms = nowMs() - t0;
      // The pixels are the GPU's now, so the JS copy has done its whole job. Closing HERE is what keeps the
      // transient cost at one page rather than at one page per url the scene has ever named.
      freePageDecode(entry);
      if (owned) {
        stats.pageOwnedUploads++;
      } else {
        stats.pageElementUploads++;
      }
      entry.uploaded = true;
      clearAwaiting(entry);
      residentCount++;
      pageBytes += bytes;
      buildBytes += bytes;
      buildUploads++;
      chargeTiny(bytes);
      buildUploadMs += ms;
      stats.uploads++;
      stats.uploadMs += ms;
      stats.lastUploadAt = t0 + ms;
      if (ms > stats.maxUploadMs) {
        stats.maxUploadMs = ms;
      }
      stats.bytes = cache.stats.bytes;
      // The element has done its job; the pixels live on the GPU now. (A context loss re-reads `entry.image`, so
      // it is kept — an <img> whose bytes the browser cache still holds is cheap next to a re-fetch mid-session.)
      return handle;
    } catch {
      // A tainted canvas is the realistic case: the CORS retry above got us pixels the driver will not take.
      markFailed(entry);
      return null;
    }
  }

  /**
   * The texture a quad should actually sample, and how far its source rect has to move to sample it.
   *
   * FOUR POPULATIONS, tried in this order, and the order is the invariant. Every PREFIXED key comes first —
   * `fx://`, `spine://`, `text://` — because those keys are not urls at all and `entryFor` would start an image
   * load for one; the re-packer next, because a crop is only reachable while the page has NOT been uploaded and
   * asking the page path first would upload it; the page last, which is what this module did before any of the
   * seams existed.
   *
   * The fourth reason the order is an invariant, and the sharpest: a `text://` key's suffix is a raster DIGEST
   * whose first field is the label's own STRING. Falling through would hand arbitrary game text to `entryFor` as
   * a url — a fetch of nonsense, a permanently `failed` entry, and a label that never paints again.
   *
   * `dx`/`dy` are ADDED to the quad's `srcX`/`srcY` before the push and are non-zero only on the crop path.
   */
  interface Resolved {
    handle: ExecutorTexture | null;
    dx: number;
    dy: number;
  }
  /** One result object; `pushTextured` reads it and drops it inside the same statement. */
  const resolved: Resolved = { handle: null, dx: 0, dy: 0 };
  /** `residentSource`'s equivalent; callers copy it into a one-frame source plan and never retain it. */
  const residentResolved: { handle: ExecutorTexture; dx: number; dy: number } = {
    handle: null as unknown as ExecutorTexture,
    dx: 0,
    dy: 0
  };

  function resolveFor(url: string, src: RepackSrcRect): Resolved {
    resolved.dx = 0;
    resolved.dy = 0;
    const stageTexture = stageTextures.get(url);
    if (stageTexture !== undefined) {
      resolved.handle = stageTexture;
      return resolved;
    }
    if (fx !== undefined && url.startsWith(FX_KEY_PREFIX)) {
      resolved.handle = fx.handleFor(url.slice(FX_KEY_PREFIX.length));
      return resolved;
    }
    if (spine !== undefined && url.startsWith(SPINE_KEY_PREFIX)) {
      // A spine clip still. Same rule as the fx leg, and the prefix test is even more load-bearing here: the key
      // WRAPS a real url (`spine:///spines/<scene>?anim=…`), so falling through would start a SECOND, undecoded
      // fetch of a clip the client already holds decoded in an <img>. It also has to come before the re-packer,
      // which would otherwise try to crop a page it has no `<img>` for.
      resolved.handle = spine.handleFor(url.slice(SPINE_KEY_PREFIX.length));
      return resolved;
    }
    if (text !== undefined && url.startsWith(TEXT_KEY_PREFIX)) {
      // A rastered label (M4). Third prefix leg, same rule, and see the note above for why falling through with
      // one of these would be worse than a missing texture rather than merely equivalent to one.
      resolved.handle = text.handleFor(url.slice(TEXT_KEY_PREFIX.length));
      return resolved;
    }
    if (repack !== null) {
      // NOT `entryFor`: a url this build has never named has no decoded page to crop from, so the page path can
      // start the load exactly as it always did and the re-packer gets its turn on the build after.
      const entry = entries.get(url);
      // THE EVICTION-PROOF SOURCE, asked ONCE — this is per textured quad per build, so the supplier's map lookup
      // is not worth paying twice. See {@link TextureBridgeOptions.decodedPageSource}: a bitmap cannot re-decode
      // under `drawImage` and this module's `<img>` can, which on the card sheets is ~290 ms of main thread per
      // crop. Null for a page nobody prefetched, and then everything below behaves exactly as it did before.
      const owned = entry !== undefined && entry.state === "ready" ? decodedPageSource(url, entry) : null;
      const source = owned ?? entry?.image ?? null;
      if (
        entry !== undefined &&
        entry.state === "ready" &&
        source !== null &&
        repack.claims(url, entry.width, entry.height, src)
      ) {
        entry.lastSeen = build;
        const region = repack.regionFor(url, source, entry.width, entry.height, src);
        if (region.kind === "region") {
          // The url is SERVED, so it must stop counting as owed a frame even though its page never uploaded.
          clearAwaiting(entry);
          resolved.handle = region.handle;
          resolved.dx = region.dx;
          resolved.dy = region.dy;
          return resolved;
        }
        if (region.kind === "paced") {
          // Same bookkeeping as a paced page: the quad paints transparent, the url reads as still coming, and
          // `endBuild` books the frame that finishes it.
          if (!entry.awaitingUpload) {
            entry.awaitingUpload = true;
            pacedCount++;
          }
          resolved.handle = null;
          return resolved;
        }
        // Refused. The re-packer has already promoted the page, so this is the last quad to take this branch.
        stats.repackPageFallbacks++;
      }
    }
    resolved.handle = pageHandleFor(url);
    return resolved;
  }

  /** Read-only counterpart to {@link resolveFor}, used by the intent-frame patcher between builds. */
  function residentSource(url: string, src: RepackSrcRect): { handle: ExecutorTexture; dx: number; dy: number } | null {
    const stageTexture = stageTextures.get(url);
    if (stageTexture !== undefined) {
      residentResolved.handle = stageTexture;
      residentResolved.dx = 0;
      residentResolved.dy = 0;
      return residentResolved;
    }
    // These key spaces are owned by their own registries. Source-frame sprites name ordinary atlas pages, and
    // treating a prefixed key as a page would be a fetch bug, so the conservative answer is no mapping.
    if (
      (fx !== undefined && url.startsWith(FX_KEY_PREFIX)) ||
      (spine !== undefined && url.startsWith(SPINE_KEY_PREFIX)) ||
      (text !== undefined && url.startsWith(TEXT_KEY_PREFIX))
    ) {
      return null;
    }
    const entry = entries.get(url);
    if (entry === undefined || entry.state !== "ready") {
      return null;
    }
    if (repack !== null) {
      const resolved = repack.residentFor(url, entry.width, entry.height, src);
      if (resolved.kind === "region" && resolved.handle !== null) {
        residentResolved.handle = resolved.handle;
        residentResolved.dx = resolved.dx;
        residentResolved.dy = resolved.dy;
        return residentResolved;
      }
      if (resolved.kind !== "refused") {
        return null;
      }
    }
    // `uploaded` is the bridge's own proof that this is a page it put in the cache; `peek` catches a context reset
    // without turning a source-only frame into the upload that a full build is allowed to perform.
    if (!entry.uploaded) {
      return null;
    }
    const handle = cache.peek(url);
    if (handle === undefined) {
      return null;
    }
    residentResolved.handle = handle;
    residentResolved.dx = 0;
    residentResolved.dy = 0;
    return residentResolved;
  }

  function sizeOf(url: string): { width: number; height: number } | null {
    if (fx !== undefined && url.startsWith(FX_KEY_PREFIX)) {
      return fx.sizeOf(url.slice(FX_KEY_PREFIX.length));
    }
    if (spine !== undefined && url.startsWith(SPINE_KEY_PREFIX)) {
      return spine.sizeOf(url.slice(SPINE_KEY_PREFIX.length));
    }
    if (text !== undefined && url.startsWith(TEXT_KEY_PREFIX)) {
      return text.sizeOf(url.slice(TEXT_KEY_PREFIX.length));
    }
    const entry = entryFor(url);
    entry.lastSeen = build;
    return entry.state === "ready" ? { width: entry.width, height: entry.height } : null;
  }

  /**
   * Release resident PAGE textures, least-recently-drawn first, until the total is back under the cap.
   *
   * THE ALWAYS-ALLOW-ONE FORM, and it is the rule that keeps this from being a disaster on a heavy screen: a
   * page NAMED BY THE BUILD THAT JUST ENDED is never evicted, whatever the total. If the working set alone
   * exceeds the cap then the cap loses — the alternative is evicting a texture the next build immediately
   * re-uploads, which converts a memory ceiling into an upload treadmill and makes the screen worse in both
   * currencies at once. `stats.evictedByCap` climbing on an ordinary screen is how that shows up, which is why
   * it is counted separately from the age-out.
   *
   * The re-upload is a `texImage2D` from the retained image, not a fetch.
   */
  function evictOverCap(spentBuild: number): void {
    if (residentCap <= 0 || pageBytes <= residentCap || entries.size === 0) {
      return;
    }
    const candidates: Entry[] = [];
    for (const entry of entries.values()) {
      // Uploaded, and not part of the frame that just rendered.
      if (entry.uploaded && entry.lastSeen !== spentBuild) {
        candidates.push(entry);
      }
    }
    if (candidates.length === 0) {
      return;
    }
    candidates.sort((a, b) => a.lastSeen - b.lastSeen);
    for (const entry of candidates) {
      if (pageBytes <= residentCap) {
        return;
      }
      cache.release(entry.url);
      entry.uploaded = false;
      residentCount--;
      pageBytes -= entry.width * entry.height * 4;
      stats.evictedByCap++;
    }
  }

  // --- the DrawList<string> facade -----------------------------------------------------------------------------

  function adapt(list: DrawList<ExecutorTexture | null>): DrawList<string> {
    // The url each command was pushed under, so `textureAt` can answer in the builder's own currency rather than
    // lying about it. Grows with the list and is rewound by `reset` alongside it.
    const keys: (string | null)[] = [];
    // …and, for the same reason, how far each command's SOURCE RECT was moved to reach a re-packed crop. Zero for
    // every command on every arm where the re-packer is off, which is what makes the read-backs below identical
    // by construction rather than by tolerance. See `options.repack`.
    const srcDx: number[] = [];
    const srcDy: number[] = [];

    /**
     * Push `view` under `texture`, making it INVISIBLE when the texture is not ready yet (see the header). The
     * view is caller-owned scratch and every push copies out of it, so the four colour fields — and the two
     * source-rect fields a re-pack rebases — are restored afterwards purely so a caller that re-reads its own
     * scratch is not surprised.
     */
    function pushTextured<T extends QuadView>(
      texture: string | null | undefined,
      view: T,
      push: (v: T, t: ExecutorTexture | null) => number
    ): number {
      if (texture == null) {
        keys[list.count] = null;
        srcDx[list.count] = 0;
        srcDy[list.count] = 0;
        return push(view, null);
      }
      const target = resolveFor(texture, view);
      const handle = target.handle;
      const dx = target.dx;
      const dy = target.dy;
      const index = list.count;
      keys[index] = texture;
      srcDx[index] = dx;
      srcDy[index] = dy;
      if (handle !== null) {
        if (dx === 0 && dy === 0) {
          return push(view, handle);
        }
        // REBASE INTO THE CROP. Same save/restore discipline as the colour fields below, and the same reason: the
        // view is the builder's scratch, and what it hands us back on the next node must be what it wrote.
        const sx = view.srcX;
        const sy = view.srcY;
        view.srcX = sx + dx;
        view.srcY = sy + dy;
        const at = push(view, handle);
        view.srcX = sx;
        view.srcY = sy;
        return at;
      }
      stats.deferredQuads++;
      const r = view.r;
      const g = view.g;
      const b = view.b;
      const a = view.a;
      view.r = 0;
      view.g = 0;
      view.b = 0;
      view.a = 0;
      push(view, null);
      view.r = r;
      view.g = g;
      view.b = b;
      view.a = a;
      return index;
    }

    /**
     * Undo a re-pack's rebase on the way back out, so a reader sees the rect the BUILDER pushed.
     *
     * Subtracting the same integer that was added is exact for the integer source rects the atlas emitters push
     * (an `AtlasTexture` region is transcribed from the wire, never computed), which is what makes the paint dump
     * byte-identical with the re-packer on or off. The executor is not affected either way: it reads the REAL
     * list, not this facade.
     */
    function unrebase<T extends QuadView>(index: number, out: T): T {
      const dx = srcDx[index] ?? 0;
      const dy = srcDy[index] ?? 0;
      if (dx !== 0) {
        out.srcX -= dx;
      }
      if (dy !== 0) {
        out.srcY -= dy;
      }
      return out;
    }

    const overrides: Partial<DrawList<string>> = {
      get count() {
        return list.count;
      },
      get clipDepth() {
        return list.clipDepth;
      },
      get maxClipDepth() {
        return list.maxClipDepth;
      },
      get floats() {
        return list.floats;
      },
      get ints() {
        return list.ints;
      },
      get colorMatrices() {
        return list.colorMatrices;
      },
      reset() {
        keys.length = 0;
        srcDx.length = 0;
        srcDy.length = 0;
        list.reset();
      },
      kindAt: (index) => list.kindAt(index),
      kindNameAt: (index) => list.kindNameAt(index),
      textureAt: (index) => keys[index] ?? null,
      floatOffsetAt: (index) => list.floatOffsetAt(index),
      intOffsetAt: (index) => list.intOffsetAt(index),
      colorMatrixIndexAt: (index) => list.colorMatrixIndexAt(index),
      pushQuad: (quad, texture) => pushTextured(texture, quad, (v, t) => list.pushQuad(v, t)),
      pushNinePatch: (patch, texture) =>
        pushTextured(texture, patch, (v, t) => list.pushNinePatch(v as NinePatchView, t)),
      pushPolyline: (line: PolylineView) => list.pushPolyline(line),
      // GLYPH RUNS PASS STRAIGHT THROUGH — they are UNTEXTURED. A run's `slots` name entries in the glyph pass's
      // OWN atlas, which this bridge neither owns, re-packs nor uploads to, so there is nothing here to rebase
      // and nothing to defer: no key is recorded and `textureAt` correctly answers null for the command.
      pushGlyphs: (run: GlyphsView) => list.pushGlyphs(run),
      pushClipRect: (clip: ClipRectView) => list.pushClipRect(clip),
      popClip: () => list.popClip(),
      readQuad: (index, out) => unrebase(index, list.readQuad(index, out)),
      readNinePatch: (index, out) => unrebase(index, list.readNinePatch(index, out)),
      readPolyline: (index, out) => list.readPolyline(index, out),
      readGlyphs: (index, out) => list.readGlyphs(index, out),
      readClipRect: (index, out) => list.readClipRect(index, out),
      // STRAIGHT THROUGH, and no rebase on either. A transform patch does not touch the source rect, and a colour
      // patch touches neither the source rect nor the texture — so a command's `srcDx`/`srcDy` (and therefore what
      // `readQuad` unrebases on the way back out) stay exactly what the push recorded. The side arrays are only
      // ever invalidated by a re-push, which is precisely what patching exists to avoid.
      patchQuadTransform: (index, m) => list.patchQuadTransform(index, m),
      patchQuadColor: (index, r, g, b, a) => list.patchQuadColor(index, r, g, b, a),
      // …and the glyph twin, for the same reason and with even less to say: a glyph command has no source rect
      // and no texture key at all, so neither patch can interact with anything this facade tracks.
      patchGlyphsTransform: (index, m) => list.patchGlyphsTransform(index, m),
      patchGlyphsColor: (index, r, g, b, a) => list.patchGlyphsColor(index, r, g, b, a)
    };
    const facade = Object.create(list) as DrawList<string>;
    Object.defineProperties(facade, Object.getOwnPropertyDescriptors(overrides));
    return facade;
  }

  return {
    sizeOf,
    residentSource,
    isResident(url) {
      if (stageTextures.has(url)) {
        return true;
      }
      return entries.get(url)?.uploaded === true;
    },
    stageTexture(url) {
      // Headless shader/particle passes sample whole stage textures. Unlike a
      // sprite quad they cannot leave a transparent deferred command behind,
      // so this is the one explicit full-page upload admission point.
      return pageHandleFor(url);
    },
    bindStageTexture(key, handle) {
      stageTextures.set(key, handle);
    },
    beginStageTextureBuild() {
      // A dynamic Spine clip names one cache key per sampled frame. The list
      // is rebuilt before any stage producer can bind, so dropping the prior
      // frame's bridge aliases is safe and keeps this map bounded by the
      // current scene rather than by animation duration.
      stageTextures.clear();
    },
    adapt,
    endBuild() {
      if (buildUploadMs > stats.maxBuildUploadMs) {
        stats.maxBuildUploadMs = buildUploadMs;
      }
      const spentBuild = build;
      buildBytes = 0;
      buildUploads = 0;
      buildUploadMs = 0;
      buildTinyBytes = 0;
      build++;
      if (entries.size > 0) {
        for (const entry of entries.values()) {
          if (entry.awaitingUpload && entry.lastSeen !== spentBuild) {
            // The scene stopped naming it before its turn came: it is no longer owed a frame, so it must stop
            // counting as pending too.
            clearAwaiting(entry);
          }
          if (!entry.uploaded || build - entry.lastSeen < EVICT_AFTER_BUILDS) {
            continue;
          }
          cache.release(entry.url);
          entry.uploaded = false;
          residentCount--;
          pageBytes -= entry.width * entry.height * 4;
          stats.evicted++;
        }
      }
      // THE STALE-CAPTURE SWEEP, outside the eviction rule above because it bounds JS memory and the one decode
      // slot — neither of which has anything to do with what the GPU is holding.
      if (pageDecodeSlot !== null) {
        const held = entries.get(pageDecodeSlot);
        if (held !== undefined && held.bitmap !== null && build - held.lastSeen >= PAGE_BITMAP_STALE_BUILDS) {
          stats.pageDecodeStale++;
          freePageDecode(held);
        }
      }
      // AFTER the page evictions, because its own clock and byte cap release textures out of the same cache and
      // the byte total below has to see both. (Outside the `entries.size` guard for the same reason: a build that
      // named only crops still moves the number.)
      repack?.endBuild();
      // AFTER `repack.endBuild()` because the re-packer may have just served pages whose own texture is no longer
      // needed, and evicting before that would release pages it was about to make free.
      evictOverCap(spentBuild);
      stats.bytes = cache.stats.bytes;
      if (pacedCount > 0) {
        // ASK FOR ANOTHER FRAME, and note what the caller owes: this is NOT a delta, so the repaint it books must
        // never reach `onSceneRendered`. The pump ends by itself — every build either uploads something (shrinking
        // the queue) or fails it, and a url the scene stopped naming is dropped above.
        options.onPaced?.();
      }
    },
    invalidate() {
      stageTextures.clear();
      // The cache's own `reset()` has already forgotten the textures (gsw calls it from the stage's context-lost
      // hook); this only has to drop our claim on them, so the next build re-uploads from the retained images.
      for (const entry of entries.values()) {
        entry.uploaded = false;
        clearAwaiting(entry);
      }
      repack?.invalidate();
      residentCount = 0;
      pageBytes = 0;
      stats.bytes = 0;
    },
    stats,
    repackStats: () => repack?.stats() ?? null,
    dispose() {
      disposed = true;
      repack?.dispose();
      for (const entry of entries.values()) {
        freePageDecode(entry); // owned pixels are OURS — the cache never saw them, so nothing else will close them
      }
      pageDecodeSlot = null;
      entries.clear();
      loadingCount = 0;
      pacedCount = 0;
      residentCount = 0;
      pageBytes = 0;
      stats.bytes = 0;
    }
  };
}
