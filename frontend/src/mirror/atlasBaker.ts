// Decode-once atlas cache for the MIRROR's atlas-region sprites.
//
// PROBLEM it solves: the old approach painted each atlas sprite with `background-image: url(atlas)` +
// `background-position` to crop one region out of the page. That forces the browser to DECODE THE WHOLE ATLAS
// (up to 4032×4080 ≈ 16 MP) to paint one small sprite — and because many nodes share an atlas at different
// painted sizes, and decoded bitmaps get evicted under phone memory pressure, the same atlas re-decodes dozens
// of times per combat (a CPU-saturating decode storm; see the combat trace).
//
// FIX: decode each atlas exactly once into an `ImageBitmap` (decoded pixels held alive here), and draw a sprite's
// region into a small per-node `<canvas>` via `drawImage`. The browser never re-decodes the atlas to paint a
// sprite (it composites the small canvas), and an ANIMATED icon (a node that swaps which region it shows each
// frame) just redraws with new source coords — synchronous, no fetch, no decode, no flicker. This preserves both
// reasons the atlas approach exists: fetch-once (no per-icon requests) and flicker-free animation. See
// [[atlas-sprite-client-crop]].
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only.
//
// --- R10-PERF4 WS-4: REGION BLOBS (the per-node <canvas> → <div> swap) ----------------------------------------
//
// The decode-once win above cost one COMPOSITED LAYER per sprite: every `<canvas>` in the tree is unconditionally
// promoted, and each promoted layer also forces `Overlap` promotions on whatever paints above it. A phone trace of
// combat measured 115 composited layers (Canvas×38, Overlap×44) with Layerize 263ms + Commit 259ms — a cost that
// scales with the layer COUNT, not with pixels.
//
// So bake each DISTINCT region ONCE into an object-URL blob (drawn from the same decode-once ImageBitmap) and let
// the node paint it as an ordinary `background-image` div: no canvas, no forced layer, and still exactly one decode
// of the atlas page plus one small encode per region (~58 distinct regions / ~1.7 MP for a whole combat). Blobs are
// never revoked — the set is bounded by the distinct regions a session actually shows, and a revoked url would
// blank a node that is still painting it.
//
// A region's blob is asynchronous (the atlas has to decode, then the region has to encode), so the renderer keeps
// TODAY'S canvas as the synchronous first paint and swaps to the div when the blob lands. Readiness is published
// through the same targeted-restyle seam textureCache uses for natural sizes: `atlasRegionBlobUrl` registers the
// styling node against the region key on a miss, and the bake's completion hands exactly those ids to the listener
// (MirrorView → renderer.markTextureDirty + a NORMAL coalesced render → an O(depth) descent + one node's restyle).

// --- R11 (Aug-14): THE ENCODE MOVES OFF THE MAIN THREAD -------------------------------------------------------
//
// A phone session measured 4,502.6ms of bake WALL against 385.3ms of main thread (91.4% of a bake's life is not
// main-thread time) and still tripped the self-disable three times, stranding 41 regions on the canvas path. The
// bake-probe explained it: `convertToBlob` encodes PNG as an IDLE TASK, and a busy combat main thread starves
// idle callbacks even in a fully visible tab — the encode did not get more expensive, the WAIT did. So the encode
// (and the readback that feeds it) now runs in a worker pool that owns the atlas page; the main thread's whole
// share of a bake is one `postMessage`. The inline path below remains the recovery fallback, which
// is also the automatic fallback for every worker-side failure.
//
// That move changed what a bake's WALL means — it now contains the pool's queue latency and, for the first region
// of each atlas page, a whole page decode — so the wall backstop had to be re-derived per path. See WHICH WALL IS
// THE DAMAGE in the drain below for the device session that proved it and the arithmetic that replaced it.

// --- Aug-15: STRIPS, the same pipeline with N crops in one job -------------------------------------------------
//
// The enemy-intent glyph shows N atlas frames in turn. The mirror cycles them on the COMPOSITOR — every frame side
// by side in ONE strip image, walked by a `translate` + `steps(N)` animation (frontend/src/mirror/intentStrip.ts)
// — so what it needs from this module is not N region blobs but one STRIP blob, and it needs it built the same way
// for the same reason: composing N cells into a canvas and `convertToBlob`-ing it on the main thread is exactly
// the idle-task-starved encode the R11 round moved off this thread.
//
// So a strip rides this file's whole pipeline verbatim: one queue entry, one drain slot, the same strike/suspend
// machinery, the same never-revoked `regionBlobs` cache and the same `regionWaiting` → `onAtlasRegionsReady`
// readiness seam. Two things differ, both deliberate:
//   * a strip is WORKER-ONLY. There is no inline retry, because the inline composition IS the mechanism it
//     replaces — the caller's fallback for a refused/failed strip is the main-thread strip canvas it is already
//     painting through, which is correct and costs one composited layer. The inline fallback therefore keeps the
//     canvas path, exactly like every other worker-side failure.
//   * its cache key is the WHOLE SET (see `atlasStripKey`), so the second enemy in a combat showing the same
//     intent — and every later combat showing it again — is a pure cache hit: no crop, no encode, no worker trip.
import {
  atlasBakePoolStats,
  bakeAtlasRegionInWorker,
  bakeAtlasStripInWorker,
  __resetAtlasBakePoolForTest
} from "@/mirror/atlasBakePool";

export interface AtlasRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

type AtlasSource = ImageBitmap | HTMLImageElement;

interface AtlasEntry {
  /**
   * The loaded page element. It is BOTH the fallback draw source and the source a promotion captures from, and
   * it is deliberately the only thing an ordinary page ever holds: an `<img>`'s decoded frame is a BROWSER
   * CACHE, which the OS can reclaim under pressure. See THE RESIDENCY BUDGET below.
   */
  element: HTMLImageElement | null;
  /**
   * OWNED pixels — minted on this page's first real DRAW and closed by the budget. Null until promoted, and null
   * again after an eviction. A bitmap is memory the PAGE owns: iOS cannot reclaim it without killing the tab,
   * which is why it is spent only on pages this thread actually draws from.
   */
  bitmap: ImageBitmap | null;
  /**
   * The page's decoded size — a MEMO, kept because a page's dimensions never change, so an eviction must not
   * un-answer `atlasPageSize`. Null while loading, and for a page that settled with no pixels.
   */
  size: { width: number; height: number } | null;
  /** true once loading settled (success OR failure) — a failed atlas stops retrying. */
  settled: boolean;
  /** One-shot callbacks fired when the page becomes drawable (nodes waiting to draw their first frame). */
  listeners: Set<() => void>;
  /** `now()` of the last REAL use (a draw, or a crop-source ask). The LRU key — a preload is not a use. */
  usedAtMs: number;
  /** A promotion is in flight: N sprites of one page asking on the same frame capture once. */
  promoting: boolean;
  /** A page whose promotion cannot work (no `createImageBitmap`, or a capture that rejected). Never re-asked. */
  promoteFailed: boolean;
  /** …and whether the budget has ever taken this page's pixels back, so a re-promotion is countable. */
  evicted: boolean;
}

const atlases = new Map<string, AtlasEntry>();

/** What `drawImage` may be handed for this page right now: owned pixels if we have them, the element if not. */
function drawSourceOf(entry: AtlasEntry): AtlasSource | null {
  return entry.bitmap ?? entry.element;
}

// Load an atlas once (idempotent) and hold its element. A no-op shell without a DOM.
//
// THIS NO LONGER DECODES INTO AN OWNED BITMAP. It used to `createImageBitmap` every page it loaded, which — with
// `imagePrefetch` warming the whole atlas list at mount — pinned ~205 MB of page-owned pixels from the moment of
// join, for the life of the page, whether or not anything ever drew from them. See THE RESIDENCY BUDGET.
function getAtlas(url: string): AtlasEntry {
  let entry = atlases.get(url);
  if (entry) return entry;
  entry = {
    element: null,
    bitmap: null,
    size: null,
    settled: false,
    listeners: new Set(),
    usedAtMs: 0,
    promoting: false,
    promoteFailed: false,
    evicted: false
  };
  atlases.set(url, entry);
  if (typeof Image === "undefined") {
    entry.settled = true;
    return entry;
  }
  const img = new Image();
  img.decoding = "async";
  img.crossOrigin = "anonymous";
  // Both DOM handlers come off as soon as the page settles (same one-shot rule as textureCache.warmImage): a
  // page's load is a single event, but a registered listener lives — and holds its Image — for the whole session.
  const detach = (): void => {
    img.removeEventListener("load", onLoad);
    img.removeEventListener("error", onError);
  };
  const onLoad = (): void => {
    detach();
    entry!.element = img;
    // The size MEMO, read off the element rather than off a bitmap — which is what lets it outlive an eviction.
    // A page that loaded with no intrinsic size has no pixels to speak of, and is treated exactly like a failure
    // by everything that reads `atlasPageSize` (the placeholder gate, the prefetch's byte accounting).
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    entry!.size = typeof w === "number" && typeof h === "number" && w > 0 && h > 0 ? { width: w, height: h } : null;
    if (ownershipMode() === "eager") {
      // THE OFF-ARM, for an exact A/B against the behaviour that shipped before the budget (`?atlasOwn=eager`).
      requestPromotion(url, entry!);
    }
    entry!.settled = true;
    const waiting = [...entry!.listeners];
    entry!.listeners.clear();
    for (const cb of waiting) cb();
  };
  // A FAILED page still SETTLES, and settling has to wake its waiters (Aug-19). This used to clear `listeners`
  // without invoking them, which silently stranded everyone waiting on a page that 404'd or failed to decode:
  // startRegionBake's callback never ran, so its region stayed in `regionBaking` forever (never baked, never
  // failed), and drawAtlasRegion's onReady never re-checked. Both registrants already handle `source === null`
  // correctly — onReady re-checks and no-ops, startRegionBake's callback calls failRegion — so the fix is simply
  // to fire them exactly like onLoad's finish does. The idle prefetch chain (imagePrefetch.ts) depends on this
  // too: it advances from `whenAtlasSettled`, so one dead page would otherwise stall every page behind it.
  const onError = (): void => {
    detach();
    entry!.settled = true;
    const waiting = [...entry!.listeners];
    entry!.listeners.clear();
    for (const cb of waiting) cb();
  };
  img.addEventListener("load", onLoad);
  img.addEventListener("error", onError);
  img.src = url;
  return entry;
}

// Start loading + decoding an atlas without drawing a region yet. Used for mirror startup prefetches that should
// populate the same decode-once cache later used by drawAtlasRegion().
export function preloadAtlas(url: string): void {
  if (!url) {
    return;
  }
  getAtlas(url);
}

/**
 * The DECODED size of an atlas page, or null when this module has no pixels for it (never requested, still
 * loading, or failed). A PURE READ — it never calls `getAtlas`, so asking about a page cannot start a fetch: the
 * renderer consults this from a style pass, and a style read that kicks off a 62MB decode would be a trap.
 *
 * The invariant that makes it useful is UNCHANGED by the residency budget: a non-null answer means this module
 * holds a drawable source for the page, so "size known" still implies "drawable right now" — the renderer's
 * placeholder-size gate (`atlasPlaceholderMechanism`) relies on exactly that to know a canvas placeholder can
 * paint synchronously. It reads the size MEMO rather than a bitmap precisely so an eviction cannot break it: the
 * element is still drawable after the budget takes the owned pixels back, and a size that went null would flip a
 * 16 MP card sheet from its canvas placeholder to a CSS page crop — the decode storm this whole module exists to
 * prevent, and a far worse outcome than the residency it was buying back.
 */
export function atlasPageSize(url: string): { width: number; height: number } | null {
  const entry = atlases.get(url);
  if (!entry || entry.size === null || drawSourceOf(entry) === null) {
    return null;
  }
  return { width: entry.size.width, height: entry.size.height };
}

/**
 * The DECODED PIXELS of an atlas page — the thing `getAtlas` is holding alive — or null when this module has none
 * (never requested, still loading, or failed). A PURE READ, for the same reason `atlasPageSize` is one.
 *
 * WHY THIS IS EXPORTED, and it is the whole point of the accessor (Aug-28 phone trace).
 *
 * The canvas stage's re-packer crops its regions out of the decoded page with `drawImage`. It was handed the
 * TEXTURE BRIDGE's own `<img>`, and a `<img>`'s decoded frame is a CACHE: Chrome discards it under memory
 * pressure and re-decodes lazily on the next draw. On a phone holding two 4032x4072 card sheets that is a ~290 ms
 * synchronous PNG decode inside a rAF — measured seven times in one 29.5 s combat trace, ~2.0 s of main thread,
 * every one of them a dropped-frame stall mid-combat.
 *
 * A bitmap from `createImageBitmap` is NOT a cache. It is decoded pixels the page owns until it is closed, so
 * `drawImage` of one can never re-decode (see `getAtlas`'s own note where it prefers it). This module already
 * holds exactly that, for exactly these pages, because `imagePrefetch` warms every atlas at app mount — the
 * bytes are already spent. Handing them to the re-packer is what makes them do work instead of just sit there.
 *
 * CALLERS MUST CHECK THE SIZE. A non-null answer is only a valid crop source for a page whose dimensions match
 * the caller's own idea of the page (the bridge compares against its `<img>`'s `naturalWidth`/`naturalHeight`
 * before using it): the crop rect is in page-pixel coordinates, so cropping from a differently-sized decode
 * would silently cut the wrong sprite rather than fail.
 *
 * ONLY OWNED PIXELS ARE OFFERED. Handing back the element instead would satisfy the type and give the caller
 * nothing: it holds its own `<img>` for the same page, and an element's evictable frame is the exact thing this
 * accessor exists to route around. So a page nobody has drawn from answers null — and, because the ASK is itself
 * the evidence that somebody wants to crop this page, it also schedules the promotion that makes the NEXT build's
 * answer non-null. Still a pure read in the sense the sibling accessor means it: no fetch, and no synchronous
 * decode inside the caller's frame (the capture is a macrotask — see `requestPromotion`).
 */
export function atlasDecodedSource(url: string): ImageBitmap | HTMLImageElement | null {
  const entry = atlases.get(url);
  if (!entry) {
    return null;
  }
  entry.usedAtMs = now();
  if (entry.bitmap !== null) {
    return entry.bitmap;
  }
  requestPromotion(url, entry);
  return null;
}

/**
 * Run `done` once `url` has SETTLED — decoded, or failed trying. Starts the load if nobody has (`getAtlas` is
 * idempotent, so a page the demand path already grabbed is a map hit and this only joins its wait). Fires
 * SYNCHRONOUSLY when the page has already settled, which callers that chain on it must expect: the idle prefetch
 * schedules its next step rather than recursing, so an all-cached list cannot overflow the stack.
 *
 * `done` says nothing about success — read `atlasPageSize` for that (null ⇒ the page has no pixels).
 */
export function whenAtlasSettled(url: string, done: () => void): void {
  const entry = getAtlas(url);
  if (entry.settled) {
    done();
    return;
  }
  entry.listeners.add(done);
}

// Draw a sprite region into `ctx` (a region-sized canvas) from its atlas. Returns true when drawn now; false when
// the atlas isn't loaded yet — in which case `onReady` is invoked once it is (the caller redraws then). The
// canvas is assumed already sized to region.width × region.height and cleared by the caller.
//
// THIS IS THE ONE CALL THAT EARNS A PAGE ITS OWNED PIXELS. On the DOM stage it fires for exactly the pages over
// `ATLAS_PAGE_CROP_MAX_PIXELS` (the card sheets) — every smaller page is CSS page-cropped from the browser's own
// image cache and has its regions cut by a worker from the WORKER's copy, so nothing on this thread ever draws
// it. Promotion keyed on the draw therefore spends the budget on the pages that use it, discovered by use rather
// than by a rule this module would have to keep in sync with the renderer's size gate.
export function drawAtlasRegion(
  ctx: CanvasRenderingContext2D,
  url: string,
  region: AtlasRegion,
  onReady: () => void
): boolean {
  const entry = getAtlas(url);
  const source = drawSourceOf(entry);
  if (!source) {
    if (!entry.settled) entry.listeners.add(onReady);
    return false;
  }
  entry.usedAtMs = now();
  ctx.drawImage(
    source,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    region.width,
    region.height
  );
  // AFTER the draw, never before it: the capture can be synchronous on some hosts (gsw measured a 576ms one), and
  // this frame's sprite must not wait on the next frame's optimisation.
  requestPromotion(url, entry);
  return true;
}

// --- THE RESIDENCY BUDGET -------------------------------------------------------------------------------------
//
// WHAT WENT WRONG. A player's iPhone rendered the character-select screen and then the tab died, repeatedly —
// the WebKit content process being killed by iOS, which leaves no trace at all on the client (no unload, no
// error, no close frame). The census the host keeps for exactly this case (see clientVitals.ts) said what the
// page was holding: `decodedBytes=208169356 … texCap=0 fxCap=0`. ~205 MB of decoded atlas pixels on the
// SHIPPING stage, under no budget of any kind.
//
// WHERE IT CAME FROM. `getAtlas` used to `createImageBitmap` every page it loaded, and `imagePrefetch` loads the
// whole atlas list at mount. The eleven pages a stable build ships come to ~205 MB of RGBA — two card sheets at
// 62.6 + 62.0 MB and nine smaller pages at ~81 MB together — so the figure was resident from the moment of join,
// before a single card was drawn, and nothing ever released it.
//
// WHY THAT IS THE FAULT AND NOT MERELY A BIG NUMBER. An `ImageBitmap` is memory the PAGE owns. The OS cannot
// reclaim it; on a phone under pressure the only way to get it back is to kill the tab. An `<img>`'s decoded
// frame is a browser CACHE — the OS reclaims it and the browser lazily re-decodes, which costs CPU rather than
// the session. So the 205 MB was the least reclaimable thing on the page.
//
// WHY NEARLY ALL OF IT WAS DEAD WEIGHT. Every atlas sprite reaches the same steady state: a `<div>` painting a
// small BAKED REGION BLOB. The two placeholder mechanisms that precede it are chosen by page size alone
// (`atlasPlaceholderMechanism`): a page at or under 6 MP is CSS page-cropped out of the browser's own image
// cache, and a page over it mounts a canvas and calls `drawAtlasRegion`. Only the second needs pixels on THIS
// thread, and only the card sheets are over the gate. The nine smaller pages — ui, relics, potions, intents,
// powers — are on screen constantly and were never once drawn from here. Their bitmaps were ~81 MB of
// unreclaimable memory bought for nothing.
//
// THE POLICY, which deliberately mirrors the canvas stage's texture bridge rather than inventing one:
//   * a page loads as an ELEMENT. That is all a load buys, and it is all `imagePrefetch` ever asks for;
//   * a page is PROMOTED to owned pixels by a real draw (or a crop-source ask), so the budget is spent on use;
//   * the owned set is capped, least-recently-used first, and an evicted page keeps its element and its size
//     memo — the worst an eviction can cost is a lazy re-decode inside the browser, never a blank sprite and
//     never a downgraded placeholder;
//   * a page used inside `ATLAS_USE_GRACE_MS` is NEVER evicted, whatever the total. This is the bridge's
//     always-allow-one rule (see `evictOverCap` there): if the live working set alone exceeds the cap then the
//     cap loses, because evicting a page the next frame immediately redraws converts a memory ceiling into a
//     re-decode treadmill and makes the screen worse in both currencies at once. `evictedByCap` climbing on an
//     ordinary screen is how a too-tight cap announces itself.

/**
 * THE RESIDENT OWNED-PAGE CAP, default 96 MB.
 *
 * Sized against the measured pages rather than guessed: the two card sheets are 62.6 and 62.0 MB, so this holds
 * one of them with ~33 MB of headroom for a second page passing through, and sheds the other once it has been
 * idle. A run that shows cards from both sheets at once keeps both — the grace rule above makes the cap lose
 * that argument on purpose — so this bounds CROSS-SCREEN ACCUMULATION rather than a single screen's working set,
 * exactly as `TEXTURE_RESIDENT_BYTES_DEFAULT` does one stage over.
 *
 * `0` is the documented OFF switch, matching the budgets it is modelled on. `?atlasResident=<MB>` overrides it
 * for one page load; `?atlasOwn=eager` additionally restores the pre-budget mint-on-load behaviour, and the two
 * together (`?atlasOwn=eager&atlasResident=0`) are the exact off-arm for a device A/B.
 */
export const ATLAS_RESIDENT_BYTES_DEFAULT = 96 * 1024 * 1024;

/**
 * How recently a page must have been drawn to be un-evictable. One second rather than a frame count because this
 * module has no build clock of its own — it is called from the renderer's style pass, not from a build — and a
 * second is comfortably longer than the gap between a sprite's successive redraws while it is on screen.
 */
const ATLAS_USE_GRACE_MS = 1_000;

/** Live residency counters — `window.__mirrorAtlasResidency`, and the census's `decodedBytes`/`atlasCap`. */
export interface AtlasResidencyStats {
  /** Owned (`ImageBitmap`) bytes held right now, and how many pages they are. THE number the census reports. */
  residentBytes: number;
  residentPages: number;
  /** The cap in force (0 = off). Non-zero on BOTH stages, unlike the canvas-only texture/fx caps. */
  residentCap: number;
  /** Pages promoted from an element to owned pixels, and how many of those were promoted more than once. */
  promoted: number;
  /**
   * …the subset that had been evicted before. This is the ONLY re-decode signal script can see: when the budget
   * takes a page back the element remains, and whether the BROWSER then drops and re-decodes that element's
   * frame is invisible from here. A device trace is what answers that; this counter only says how often the cap
   * made us re-capture a bitmap we used to have.
   */
  rePromoted: number;
  /** Pages released by the cap. Climbing on an ordinary screen means the cap is too tight for its working set. */
  evictedByCap: number;
  /** Promotions refused outright — no `createImageBitmap`, or a capture that rejected. */
  promoteFailed: number;
}

export const atlasResidencyStats: AtlasResidencyStats = {
  residentBytes: 0,
  residentPages: 0,
  residentCap: 0,
  promoted: 0,
  rePromoted: 0,
  evictedByCap: 0,
  promoteFailed: 0
};

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__mirrorAtlasResidency = atlasResidencyStats;
}

/** The levers, read ONCE per page load like every other lever in this codebase (see rendererFactory). */
type AtlasOwnershipMode = "lazy" | "eager";

function readSearchParams(): URLSearchParams | null {
  if (typeof window === "undefined" || typeof URLSearchParams === "undefined") {
    return null;
  }
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
}

// `?atlasResident=<MB>`: a finite, non-negative number of MEGABYTES (0 = no cap). Junk keeps the shipped default
// — an unrecognised lever value must never silently remove a viewer's budget.
function readResidentCap(): number {
  const raw = readSearchParams()?.get("atlasResident");
  if (raw === null || raw === undefined || raw === "") {
    return ATLAS_RESIDENT_BYTES_DEFAULT;
  }
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) {
    return ATLAS_RESIDENT_BYTES_DEFAULT;
  }
  return Math.floor(mb * 1024 * 1024);
}

// `?atlasOwn=eager` restores mint-on-load. Anything else is the shipped `lazy`.
function readOwnershipMode(): AtlasOwnershipMode {
  return readSearchParams()?.get("atlasOwn") === "eager" ? "eager" : "lazy";
}

let residentCapBytes: number = readResidentCap();
let ownership: AtlasOwnershipMode = readOwnershipMode();
atlasResidencyStats.residentCap = residentCapBytes;

function ownershipMode(): AtlasOwnershipMode {
  return ownership;
}

/** The cap in force, for the census (which must report the budget even on a page holding nothing yet). */
export function atlasResidentCapBytes(): number {
  return residentCapBytes;
}

function bytesOf(entry: AtlasEntry): number {
  return entry.size === null ? 0 : entry.size.width * entry.size.height * 4;
}

/**
 * Where a promotion's capture runs. A MACROTASK, deliberately, and for the same reason the texture bridge
 * schedules its own: `createImageBitmap` is not guaranteed asynchronous, so a capture taken inline would land in
 * the animation frame of the sprite that triggered it.
 */
function schedulePromotion(task: () => void): void {
  if (typeof setTimeout === "function") {
    setTimeout(task, 0);
    return;
  }
  task();
}

/** Mint owned pixels for a page that has earned them. Idempotent, and a no-op for a page that cannot be captured. */
function requestPromotion(url: string, entry: AtlasEntry): void {
  if (entry.bitmap !== null || entry.promoting || entry.promoteFailed || entry.element === null) {
    return;
  }
  if (typeof createImageBitmap !== "function") {
    // No capture path (an older WebKit, a test shell). The element stays the draw source forever, which is
    // exactly the behaviour that predates this module's bitmaps — correct, just not eviction-proof.
    entry.promoteFailed = true;
    atlasResidencyStats.promoteFailed += 1;
    return;
  }
  entry.promoting = true;
  schedulePromotion(() => {
    const element = entry.element;
    if (element === null || entry.bitmap !== null || atlases.get(url) !== entry) {
      entry.promoting = false;
      return;
    }
    let capture: Promise<ImageBitmap>;
    try {
      capture = createImageBitmap(element);
    } catch {
      entry.promoting = false;
      entry.promoteFailed = true;
      atlasResidencyStats.promoteFailed += 1;
      return;
    }
    capture.then(
      (bitmap) => {
        entry.promoting = false;
        // Raced by a second capture, or by a reset that dropped this entry: close the loser rather than leak it.
        if (entry.bitmap !== null || atlases.get(url) !== entry) {
          closeBitmap(bitmap);
          return;
        }
        entry.bitmap = bitmap;
        atlasResidencyStats.residentPages += 1;
        atlasResidencyStats.residentBytes += bytesOf(entry);
        atlasResidencyStats.promoted += 1;
        if (entry.evicted) {
          atlasResidencyStats.rePromoted += 1;
        }
        evictOverCap();
      },
      () => {
        entry.promoting = false;
        entry.promoteFailed = true;
        atlasResidencyStats.promoteFailed += 1;
      }
    );
  });
}

function closeBitmap(bitmap: ImageBitmap): void {
  if (typeof (bitmap as { close?: () => void }).close === "function") {
    bitmap.close();
  }
}

/** Take a page's owned pixels back. The element and the size memo stay, so nothing it answers goes null. */
function releaseOwnedPixels(entry: AtlasEntry): void {
  const bitmap = entry.bitmap;
  if (bitmap === null) {
    return;
  }
  entry.bitmap = null;
  entry.evicted = true;
  atlasResidencyStats.residentPages -= 1;
  atlasResidencyStats.residentBytes -= bytesOf(entry);
  closeBitmap(bitmap);
}

/** Release owned pages, least-recently-drawn first, until the total is back under the cap. */
function evictOverCap(): void {
  if (residentCapBytes <= 0 || atlasResidencyStats.residentBytes <= residentCapBytes) {
    return;
  }
  const at = now();
  const candidates: AtlasEntry[] = [];
  for (const entry of atlases.values()) {
    // Owned, and not part of what the page is drawing right now — see the always-allow-one rule above.
    if (entry.bitmap !== null && at - entry.usedAtMs > ATLAS_USE_GRACE_MS) {
      candidates.push(entry);
    }
  }
  candidates.sort((a, b) => a.usedAtMs - b.usedAtMs);
  for (const entry of candidates) {
    if (atlasResidencyStats.residentBytes <= residentCapBytes) {
      return;
    }
    releaseOwnedPixels(entry);
    atlasResidencyStats.evictedByCap += 1;
  }
}

// --- region blobs ---------------------------------------------------------------------------------------------

/** The cache identity of one atlas sprite: its page url plus its exact source rect. */
export function atlasRegionKey(url: string, region: AtlasRegion): string {
  return `${url}|${region.x},${region.y},${region.width},${region.height}`;
}

// key → the object URL of that region baked as its own image. Populated once per distinct region and never
// revoked (see the header).
const regionBlobs = new Map<string, string>();
// Keys whose bake is in flight (dedupe: N nodes showing the same sprite bake it once). A PARKED key stays in this
// set: its bake is still pending, just suspended, so a re-request is a no-op rather than a second enqueue.
const regionBaking = new Set<string>();
// … and keys whose bake CANNOT succeed (no OffscreenCanvas/toBlob/createObjectURL, a failed atlas, a tainted or
// zero-sized draw). Those nodes stay on the canvas mechanism forever — correct, just one layer each.
//
// GENUINE FAILURE ONLY (Aug-12). This set used to double as the dumping ground for regions dropped because the
// slow-bake revert had fired, which is what made that revert unrecoverable in practice: flipping `disabled` back
// would not have helped, because every region the session had already asked for was parked in here permanently
// and `atlasRegionBlobUrl` answers null for anything in it without re-requesting. A live re-arm probe on the
// phone watched 28s plus a deck-view open that mounted 82 fresh canvases produce exactly 0 bake requests. Regions
// dropped by a suspension now go to `regionParked` instead, which a re-arm drains back into the queues.
const regionFailed = new Set<string>();
// key → the node ids that styled while the blob was missing, i.e. the nodes to re-style when it lands. Mirrors
// textureCache's `awaiting`: a dangling id (its node was removed meanwhile) is harmless — markDirty filters it.
const regionWaiting = new Map<string, Set<string>>();

export type AtlasRegionListener = (ids: ReadonlySet<string>) => void;

const regionListeners = new Set<AtlasRegionListener>();

// Subscribe to region-blob readiness. Returns an unsubscribe. A Set (not a single slot) for the same reason as
// textureCache's: two coexisting mirror views must not silently steal each other's listener.
export function onAtlasRegionsReady(listener: AtlasRegionListener): () => void {
  regionListeners.add(listener);
  return () => {
    regionListeners.delete(listener);
  };
}

// The object URL for `region` of `url`, or null when it isn't baked (yet, or ever). A null answer with a non-null
// `nodeId` registers that node for the targeted re-style that fires when the bake completes, and kicks the bake
// off (idempotent — the first caller wins, later ones just join the wait).
export function atlasRegionBlobUrl(url: string, region: AtlasRegion, nodeId: string | null): string | null {
  const key = atlasRegionKey(url, region);
  const blob = regionBlobs.get(key);
  if (blob !== undefined) {
    return blob;
  }
  if (regionFailed.has(key)) {
    return null; // permanently unavailable — the caller keeps painting through its canvas
  }
  // A suspension that has elapsed heals here too, not only on its timer: a re-styling node is proof the page is
  // live, and this covers a timer the browser throttled (a backgrounded tab) or a host without one.
  if (atlasBakeStats.disabled && now() >= atlasBakeStats.suspendedUntilMs) {
    rearmBaking();
  }
  if (nodeId !== null) {
    let ids = regionWaiting.get(key);
    if (ids === undefined) {
      ids = new Set<string>();
      regionWaiting.set(key, ids);
    }
    ids.add(nodeId);
    // R10-PERF6 WS-P2 — URGENT BEATS SPECULATIVE. A waiter means a node is on screen RIGHT NOW painting through
    // its canvas and waiting for this blob; a no-waiter request (the hidden-sprite warm-up) is speculation about
    // a screen nobody has opened. The drain is strictly one-at-a-time and FIFO, so without this promotion a map
    // that opens while a ~700-deep warm queue is still draining puts every one of its own regions BEHIND that
    // queue — measured on the cold-map reveal burst as a 1,535-layer, 715-canvas open (vs 34 layers when the
    // warm-up had finished first), i.e. the speculative work made the urgent case dramatically worse. Promoting
    // on the FIRST waiter only (`ids.size === 1`) keeps this O(1) per region rather than per waiter.
    if (ids.size === 1) {
      promoteBake(key);
    }
  }
  startRegionBake(key, url, region);
  return null;
}

// --- strips ---------------------------------------------------------------------------------------------------

/** One cell of a strip: which page, and which rect of it. */
export interface AtlasStripCell {
  url: string;
  region: AtlasRegion;
}

/** A strip to build, as the renderer describes it. `key` comes from `atlasStripKey`. */
export interface AtlasStripSpec {
  key: string;
  cells: readonly AtlasStripCell[];
  /** One cell's box in the composed image (a smaller frame is scaled up to fill it — see the worker). */
  cellW: number;
  cellH: number;
}

/**
 * The cache identity of one strip: everything that changes a pixel of it, plus the `tag` its caller uses to say
 * WHICH cycle it is (the mirror passes `animationName|fps`, the two fields that decide the animation the strip is
 * stepped by even though they do not change its pixels — a strip cached under the wrong cadence would be a
 * silently-wrong glyph, and the intent sets a session shows are few enough that the stricter key costs nothing).
 *
 * The `strip|` prefix is load-bearing: strips share the region cache's maps (`regionBlobs`, `regionBaking`,
 * `regionFailed`, `regionWaiting`), and `atlasRegionKey`'s `<url>|<x>,<y>,<w>,<h>` must never be able to collide
 * with one.
 */
export function atlasStripKey(tag: string, cells: readonly AtlasStripCell[], cellW: number, cellH: number): string {
  let key = `strip|${tag}|${cellW}x${cellH}`;
  for (const cell of cells) {
    key += `|${cell.url}@${cell.region.x},${cell.region.y},${cell.region.width},${cell.region.height}`;
  }
  return key;
}

/**
 * The object URL of `spec` baked as ONE image, or null when it isn't baked (yet, or ever) — same contract, same
 * never-revoke policy and the same targeted-restyle registration as `atlasRegionBlobUrl`, so a caller swaps to the
 * strip blob exactly when it swaps to a region blob: on the re-style the completed bake triggers.
 */
export function atlasStripBlobUrl(spec: AtlasStripSpec, nodeId: string | null): string | null {
  const key = spec.key;
  const blob = regionBlobs.get(key);
  if (blob !== undefined) {
    return blob; // THE STEADY STATE: every later glyph with this intent lands here — no crop, no encode, no worker
  }
  if (regionFailed.has(key)) {
    return null; // permanently unavailable — the caller keeps its own composition (the strip canvas)
  }
  if (atlasBakeStats.disabled && now() >= atlasBakeStats.suspendedUntilMs) {
    rearmBaking();
  }
  if (nodeId !== null) {
    let ids = regionWaiting.get(key);
    if (ids === undefined) {
      ids = new Set<string>();
      regionWaiting.set(key, ids);
    }
    ids.add(nodeId);
    if (ids.size === 1) {
      promoteBake(key);
    }
  }
  startStripBake(spec);
  return null;
}

// Queue a strip's bake (idempotent — N glyphs sharing an intent enqueue it once). Unlike a region bake this does
// NOT wait on the main thread's own decode of the page: there is no inline path to feed, the worker fetches and
// decodes its own copy, and a page it cannot load comes back as an `atlas` error that fails the key here.
function startStripBake(spec: AtlasStripSpec): void {
  if (regionBaking.has(spec.key)) {
    return;
  }
  const url = spec.cells[0]?.url;
  if (!url || spec.cells.some((cell) => cell.url !== url)) {
    // Multi-page (or empty): the pool models one page per job, so this is refused up front rather than half-
    // supported. No intent set in this game is shaped like that — see bakeAtlasStripInWorker's SINGLE PAGE note.
    regionFailed.add(spec.key);
    regionWaiting.delete(spec.key);
    return;
  }
  regionBaking.add(spec.key);
  enqueueBake({
    key: spec.key,
    url,
    region: { x: 0, y: 0, width: spec.cellW * spec.cells.length, height: spec.cellH },
    source: null,
    strip: spec
  });
}

// Regions waiting to be drawn+encoded. A page's decode resolves EVERY region of that page at once (they all
// registered against the same `load`), and doing all of them inline would pile ~58 draws + encodes into the very
// task that just spent ~150ms decoding a 16 MP atlas — the worst possible moment. So the bakes drain ONE AT A
// TIME: each node is already painting correctly through its canvas, so a bake is never on a critical path, and
// spreading them costs nothing but a slightly later swap.
//
// --- WHY ONE AT A TIME (Aug-11) — STILL TRUE FOR THE INLINE PATH ONLY (Aug-14) ---------------------------------
// The rule this comment shipped, quoted verbatim so the update is auditable:
//
//   "The drain used to be a `while` loop with a 3ms budget checked AFTER each `bakeRegion`. But a bake is
//    ASYNCHRONOUS: `bakeRegion` only KICKS OFF `convertToBlob` and returns in ~0ms, so the budget check measured
//    nothing, the loop emptied the whole queue in one task, and every encode ran concurrently. On a Mali-G57 phone
//    loading the map that measured 3.1s of blocked main thread across ~20 regions (≈0.33 MP total — the cost is
//    the per-encode GPU readback/stall, not the pixels), 53.3% of the screen's whole load CPU."
//
// Every word of that is still correct ABOUT THE INLINE PATH, and the inline path still obeys it when a worker is
// and every fallback below drain strictly one at a time. But note WHAT the 3.1s was made of — "the per-encode GPU
// readback/stall", i.e. work done ON THE MAIN THREAD on behalf of the encode. When the encode runs in a worker
// that owns the atlas (atlasBakeWorker.ts), the main thread does neither the readback nor the encode: a bake
// costs it one `postMessage`. The serial rule was protecting the main thread from work that is no longer on it,
// so on the WORKER path the drain runs up to `poolSize` regions in flight — and it has to, because a serial
// schedule makes any pool slower by construction (a fan-out of one is the only thing it can express).
//
// Unchanged either way: one region is started per TASK (never a `while` loop), each bake is TIMED end-to-end, and
// past the thresholds below a device that is telling us its bake path is pathological loses the mechanism —
// every waiting/future region stays on the canvas path (correct, one composited layer each) instead of buying a
// layer saving with seconds of jank. Mirrors mirrorRenderer's ATLAS_STICKY_CANVAS_REVERTS idiom, one level up:
// there a NODE stops thrashing, here the MECHANISM does.
//
// --- WHY THE BACKOFF DECAYS (Aug-12) ---------------------------------------------------------------------------
// That backoff used to be a SESSION-DEATH LATCH: three slow urgent bakes and no region was ever baked again. A
// real phone (moto g86, Mali-G615) tripped it on its very first screens — `{"baked":20,"slow":3,"slowestMs":3762,
// "disabled":true}` — and the consequence was permanent and catastrophic, far worse than the jank the latch was
// protecting against:
//   * the map then opened with 941 <canvas> sprites / 1,888 compositor layers / 1.48 Gpx of layer area, versus
//     34 layers on the same device when the bakes land;
//   * 2 of 3 combat traces recorded 2,029ms and 2,705ms main-thread tasks holding only ~100ms of CPU — the
//     renderer BLOCKED ON THE GPU PROCESS (GpuImageDecodeCache::UploadImage, 490ms self time). That is the
//     steady-state price of the canvas-fallback regime, paid every frame, forever.
// So the arithmetic that matters is: even a 3.7s bake is cheaper than one session of that. Exposure control is
// still legitimate — a burst of pathological encodes should not fight a user who is waiting — but it has to HEAL.
//
// The shape: a DECAYING STRIKE WINDOW plus an ESCALATING, TIME-BOUNDED suspension.
//   * A strike = one slow URGENT bake (unchanged criterion, see the drain). Strikes older than
//     BAKE_STRIKE_DECAY_MS stop counting, so the trip means "this device's encode path is pathological RIGHT
//     NOW", not "three slow bakes happened at some point this session" — which is literally what the phone's
//     baseline was: 3 slow bakes scattered across a whole session of 20.
//   * On the trip, baking suspends for a bounded window instead of forever, and every queued region is PARKED
//     (not failed) so a re-arm can put it straight back on the queue with its waiters intact.
//   * The suspension DOUBLES per consecutive trip up to BAKE_SUSPEND_MAX_MS, because a slow device's re-arm is
//     genuinely likely to re-trip and we must not thrash: the worst case is a fixed BAKE_SLOW_LIMIT of slow bakes
//     per attempt, spaced ever further apart. It is still forward progress — a slow bake that LANDS still keeps
//     its blob, so every attempt permanently removes some canvases — and it can never reach "never again".
//   * A suspension that survives BAKE_TRIP_MEMORY_MS of healthy baking forgives the escalation, so one bad moment
//     at load does not punish minute 20 of the session.
// `source` is the decoded page the INLINE path draws from, and is null for exactly one kind of job: a STRIP,
// which has no inline path (see the strips block at the top of this file). `strip` is the mirror image of that —
// non-null only for a strip — so the two fields are one tagged union spelled out in two columns.
type BakeJob = {
  key: string;
  url: string;
  region: AtlasRegion;
  source: AtlasSource | null;
  strip: AtlasStripSpec | null;
};
const bakeQueue: BakeJob[] = [];
// R10-PERF6 WS-P2: speculative (no-waiter) bakes — drained only when nothing urgent is pending. See enqueueBake.
const warmQueue: BakeJob[] = [];
/** Bakes started and not yet settled, and drain tasks scheduled but not yet run. Together they are the drain. */
let bakeInFlight = 0;
let bakePumps = 0;
/** A bake that owned the MAIN THREAD for longer than this is pathological on this device. */
const BAKE_SLOW_MS = 50;
/** …and this many of them (inside BAKE_STRIKE_DECAY_MS) suspend the div/blob mechanism. */
const BAKE_SLOW_LIMIT = 3;
/**
 * INLINE-PATH wall backstop (Aug-14). A bake whose encode blocks *here* for this long has stalled behind something
 * we cannot see from script — a saturated GPU process, an idle-callback queue that never runs — and that is damage
 * even when the main thread was free, so it keeps its own strike count. 2,000ms is chosen against three measured
 * points: the honest cost of a region on an IDLE page on this phone is ~36ms; a BUSY page pays ~188ms for the same
 * encode (a wait, not work); and the pathological session that motivated this round had a 2,962ms worst bake. So
 * the backstop sits ~55× above healthy, ~10× above busy-but-fine, and below the real pathology — it cannot fire on
 * a device that is merely slow, and it still fires on the one that is stuck.
 *
 * It is measured from the moment the INLINE encode starts, not from the moment the region was dequeued, so a
 * region that reached this path after a worker refused it is judged on what it cost HERE (see WHICH WALL IS THE
 * DAMAGE below). On the inline path those two stamps are the same instant, so this is exactly the pre-Aug-14
 * number for the path it still governs.
 */
const BAKE_STALL_MS = 2_000;
/**
 * WORKER-PATH stall backstop (Aug-14, revised). The worker path's wall is `queue wait + (maybe) a whole atlas page
 * decode + crop + encode`, and only the last of those is evidence about this device's encode path — so the
 * backstop reads the worker's own `encodeMs` instead. See WHICH WALL IS THE DAMAGE below for why, and for the
 * device session that made a wall threshold here indefensible.
 *
 * 1,000ms, argued the same way as the inline number above but from the worker path's OWN measurements (moto g86,
 * 60s of recorded combat, pool of 4, `workerEncodeMsTotal` 544.9ms over 64 regions):
 *   * healthy is ~8.5ms per region (544.9 / 64), so this sits ~118× above healthy;
 *   * the measured idle→busy inflation factor for a PNG encode on this phone was 188/36 ≈ 5.2×, which puts a
 *     "busy but fine" worker encode at ~44ms — still ~23× under the threshold;
 *   * three of them inside BAKE_STRIKE_DECAY_MS is 3s of a background core spent on three small sprites.
 * The margins are deliberately wider than the inline path's ~55×/~10×, for two reasons. (a) We have a MEAN, not a
 * maximum: 64 mixed-size regions, and the biggest atlas region in this game (a full card face) is an order of
 * magnitude more pixels than the median icon, so one legitimate region can honestly cost many times the mean.
 * (b) The asymmetry is worse here than inline: a slow worker encode costs the main thread nothing (that damage is
 * BAKE_SLOW_MS's job and it reads syncMs), while tripping strands every un-baked sprite on the canvas path — the
 * regime this file's Aug-12 block prices at 1,888 compositor layers and 2-second GPU-blocked tasks.
 * `workerSlowestEncodeMs` is published so the next device probe can replace this reasoning with a measured
 * maximum and tighten the number with data.
 */
const BAKE_WORKER_STALL_MS = 1_000;
/** …and this many of THOSE (same decay window, shared between the two paths) suspend it. */
const BAKE_STALL_LIMIT = 3;
/**
 * How long one slow-bake strike counts for. 15s is chosen against the phone baseline: the three slow bakes that
 * killed that session were spread across it, while a device that is ACTUALLY struggling produces them back to
 * back (the drain is one-at-a-time, so three slow bakes in a burst complete inside a few seconds of each other).
 */
const BAKE_STRIKE_DECAY_MS = 15_000;
/** The first suspension. Long enough to outlast the burst that tripped it (a screen open), short enough that the
 * next screen of the session gets its layers back. */
const BAKE_SUSPEND_MS = 15_000;
/** …doubling per consecutive trip, capped here (≈ BAKE_SLOW_LIMIT slow bakes per 2 minutes, worst case). */
const BAKE_SUSPEND_MAX_MS = 120_000;
/** An arm that baked this long without tripping resets the escalation (see above). */
const BAKE_TRIP_MEMORY_MS = 120_000;
/** A bake costing more than this yields the main thread for a frame before the next one, instead of a bare task. */
const BAKE_BUDGET_MS = 3;
const BAKE_YIELD_MS = 16;

/** Live counters for the bake loop — read by probes/benches (`window.__mirrorAtlasBakeStats`). */
export interface AtlasBakeStats {
  baked: number;
  failed: number;
  /**
   * Urgent bakes over BAKE_SLOW_MS of MAIN-THREAD time, and urgent bakes whose WORK (not wall) ran past the stall
   * backstop for the path they took — BAKE_STALL_MS inline, BAKE_WORKER_STALL_MS of worker encode.
   */
  slow: number;
  stalled: number;
  /**
   * The slowest single bake's WALL time, and the session total. Wall, not main-thread: the timing spans the async
   * `convertToBlob`, so it includes time the page spent doing other things and time the bake spent queued behind
   * a saturated GPU process — or, as the Aug-13 phone session showed, behind an idle-callback queue that a busy
   * main thread never lets run. So a 2,962ms sample is NOT 2.9s of blocked script.
   * ON THE WORKER PATH IT IS PURELY DIAGNOSTIC: a bake's wall there is `pool queue wait + (maybe) a whole atlas
   * page decode + crop + encode`, three unrelated quantities, so NO criterion reads it. Split it with
   * `slowestQueuedMs`/`queuedMsTotal` (queue), `workerMsTotal - workerEncodeMsTotal` (page decode) and
   * `workerEncodeMsTotal`/`workerSlowestEncodeMs` (the encode itself).
   * `syncTotalMs` / `slowestSyncMs` measure the part that provably owned the main thread (setup + draw + the
   * `convertToBlob`/`toBlob` call itself, or just the `postMessage` on the worker path), and THAT is what the
   * strike criterion reads; `inlineTotalMs` / `slowestInlineMs` are the inline encode's own wall, which is what
   * the stall backstop reads on that path. See the drain.
   */
  slowestMs: number;
  totalMs: number;
  syncTotalMs: number;
  slowestSyncMs: number;
  inlineTotalMs: number;
  slowestInlineMs: number;
  /** true while no region is being baked during a live suspension. */
  disabled: boolean;
  /**
   * Strikes still inside the decay window, aged LAZILY (on the next strike), so a probe reading this between
   * strikes may see one that has since expired — it is a debugging read-out, not the trip condition itself. Two
   * independent counts, one per criterion. The clock stamp names when baking resumes (0 = not suspended).
   */
  strikes: number;
  stallStrikes: number;
  suspendedUntilMs: number;
  /** How often the mechanism tripped, how often it healed, and how many parked regions those re-arms re-queued. */
  trips: number;
  rearms: number;
  requeued: number;
  /**
   * …and WHICH criterion tripped it, split out so the next device probe can tell a main-thread trip from a stall
   * without reading console lines. `trips === syncTrips + stallTrips`; `disabledReason` is the most recent one
   * (null while the mechanism is live).
   */
  syncTrips: number;
  stallTrips: number;
  disabledReason: "sync" | "stall" | null;
  /** Regions currently parked by a suspension (they bake again on the next re-arm). */
  parked: number;
  /**
   * The worker pool's own counters, folded in so one probe read covers both halves. `poolSize` 0 = the inline
   * path (no Worker support or every worker died); `workerFailed` counts regions a worker
   * could not finish and the inline path re-baked.
   *
   * The three timing pairs are the whole point of the Aug-14 revision: `queuedMsTotal`/`slowestQueuedMs` is
   * WAITING for a free worker, `workerMsTotal - workerEncodeMsTotal` is WAITING for a page decode, and
   * `workerEncodeMsTotal`/`workerSlowestEncodeMs` is WORK — the only one the stall backstop is allowed to judge.
   */
  poolSize: number;
  workerBaked: number;
  workerFailed: number;
  workerMsTotal: number;
  workerSlowestMs: number;
  workerEncodeMsTotal: number;
  workerSlowestEncodeMs: number;
  queuedMsTotal: number;
  slowestQueuedMs: number;
  workerAtlasBytes: number;
  /**
   * THE DECODE-ONCE GAUGE, mirrored here so `window.__mirrorAtlasBakeStats` alone answers it: `atlasLoads` is
   * page decodes (fetch + decode + full readback, ~590ms of worker time each), `atlasPages` is how many DISTINCT
   * pages those were, so `atlasLoads === atlasPages` is the pipeline paying for every page exactly once — the
   * whole point of the residency policy (see DECODE AT MOST ONCE PER WINDOW in atlasBakePool.ts). A gap between
   * them is attributed by the two next to it: `atlasReleased` is a worker giving an oversized page back once its
   * demand stopped, `atlasEvicted` is its LRU making room. `atlasFailed` is pages no worker could load at all
   * (their regions bake inline for the rest of the session), which is why it belongs beside them rather than in
   * with the region failures.
   */
  atlasLoads: number;
  atlasPages: number;
  atlasReleased: number;
  atlasEvicted: number;
  atlasFailed: number;
  /**
   * …and how many of those worker jobs were STRIPS (N cells of one page composed into one image, for the intent
   * glyph's compositor cycling). Mirrored here so ONE probe read proves where a strip was built: `stripBaked > 0`
   * is the strip coming off a worker; `stripBaked: 0` with intents on screen means every one of them fell back to
   * the main-thread strip canvas, and `stripFailed` says the pool was asked and could not.
   */
  stripBaked: number;
  stripFailed: number;
}

export const atlasBakeStats: AtlasBakeStats = {
  baked: 0,
  failed: 0,
  slow: 0,
  stalled: 0,
  slowestMs: 0,
  totalMs: 0,
  syncTotalMs: 0,
  slowestSyncMs: 0,
  inlineTotalMs: 0,
  slowestInlineMs: 0,
  disabled: false,
  strikes: 0,
  stallStrikes: 0,
  suspendedUntilMs: 0,
  trips: 0,
  rearms: 0,
  requeued: 0,
  syncTrips: 0,
  stallTrips: 0,
  disabledReason: null,
  parked: 0,
  poolSize: 0,
  workerBaked: 0,
  workerFailed: 0,
  workerMsTotal: 0,
  workerSlowestMs: 0,
  workerEncodeMsTotal: 0,
  workerSlowestEncodeMs: 0,
  queuedMsTotal: 0,
  slowestQueuedMs: 0,
  workerAtlasBytes: 0,
  atlasLoads: 0,
  atlasPages: 0,
  atlasReleased: 0,
  atlasEvicted: 0,
  atlasFailed: 0,
  stripBaked: 0,
  stripFailed: 0
};

// The pool publishes into its own record; mirror the fields a probe reads onto the bake stats after every bake so
// `window.__mirrorAtlasBakeStats` stays the single read-out it has always been.
function syncPoolStats(): void {
  atlasBakeStats.poolSize = atlasBakePoolStats.poolSize;
  atlasBakeStats.workerBaked = atlasBakePoolStats.workerBaked;
  atlasBakeStats.workerFailed = atlasBakePoolStats.workerFailed;
  atlasBakeStats.workerMsTotal = atlasBakePoolStats.workerMsTotal;
  atlasBakeStats.workerSlowestMs = atlasBakePoolStats.workerSlowestMs;
  atlasBakeStats.workerEncodeMsTotal = atlasBakePoolStats.workerEncodeMsTotal;
  atlasBakeStats.workerSlowestEncodeMs = atlasBakePoolStats.workerSlowestEncodeMs;
  atlasBakeStats.queuedMsTotal = atlasBakePoolStats.queuedMsTotal;
  atlasBakeStats.slowestQueuedMs = atlasBakePoolStats.slowestQueuedMs;
  atlasBakeStats.workerAtlasBytes = atlasBakePoolStats.atlasBytes;
  // The page counters travel with the byte total: the question a device probe asks of this record is "did any
  // page decode twice", and it must not need a second global (`__mirrorAtlasBakePoolStats`) to answer it.
  atlasBakeStats.atlasLoads = atlasBakePoolStats.atlasLoads;
  atlasBakeStats.atlasPages = atlasBakePoolStats.atlasPages;
  atlasBakeStats.atlasReleased = atlasBakePoolStats.atlasReleased;
  atlasBakeStats.atlasEvicted = atlasBakePoolStats.atlasEvicted;
  atlasBakeStats.atlasFailed = atlasBakePoolStats.atlasFailed;
  atlasBakeStats.stripBaked = atlasBakePoolStats.stripBaked;
  atlasBakeStats.stripFailed = atlasBakePoolStats.stripFailed;
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__mirrorAtlasBakeStats = atlasBakeStats;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

// Regions dropped by a suspension, in queue order (the Map preserves it), each holding everything a re-arm needs
// to put it back: its region rect and the decoded atlas it draws from. Their WAITERS are deliberately kept in
// `regionWaiting` — a parked node is on screen right now painting through its canvas, so when the re-armed bake
// lands it must re-style exactly that node (`failRegion` drops waiters silently; parking must not).
const regionParked = new Map<string, BakeJob>();
// Completion stamps of the strikes still inside BAKE_STRIKE_DECAY_MS, one list per criterion (at most
// BAKE_SLOW_LIMIT / BAKE_STALL_LIMIT of them). Kept apart so a device that stalls does not borrow strikes from a
// device that blocks, and so `syncTrips`/`stallTrips` mean what they say.
const strikeTimes: number[] = [];
const stallTimes: number[] = [];
let tripLevel = 0; // consecutive trips, i.e. the backoff exponent
let lastRearmAtMs = 0;
let rearmTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueBake(job: BakeJob): void {
  const key = job.key;
  if (atlasBakeStats.disabled) {
    if (now() < atlasBakeStats.suspendedUntilMs) {
      parkRegion(job); // suspended — this node keeps its canvas until the re-arm
      return;
    }
    rearmBaking(); // the suspension elapsed (a throttled/absent timer): heal on the spot, then queue normally
  }
  // A region with a waiter is URGENT (a node is on screen painting through its canvas, waiting for this blob); one
  // without is SPECULATIVE (the hidden-sprite warm-up). Two FIFO queues rather than one priority-sorted queue,
  // deliberately: with nothing speculative in flight `warmQueue` is always empty and the drain order is exactly
  // what it was before this change — no reordering risk for the path that ships today.
  (regionWaiting.has(key) ? bakeQueue : warmQueue).push(job);
  pumpBakeDrain(0);
}

/**
 * How many bakes may be in flight at once: one on the INLINE path (see WHY ONE AT A TIME), `poolSize` on the
 * worker path, where a bake costs the main thread a `postMessage` and the serial rule would just cap the pool's
 * fan-out at one. Read live, so a pool that loses its last worker mid-session falls back to serial too.
 */
function bakeConcurrency(): number {
  return Math.max(1, atlasBakePoolStats.poolSize);
}

// Schedule ONE more drain task, if the concurrency budget has room for it and there is anything to drain.
// `bakeInFlight + bakePumps` is the drain's whole state: pumps are tasks that will each start exactly one bake.
function pumpBakeDrain(delayMs: number): void {
  if (atlasBakeStats.disabled) {
    return;
  }
  if (bakeQueue.length === 0 && warmQueue.length === 0) {
    return;
  }
  if (bakeInFlight + bakePumps >= bakeConcurrency()) {
    return;
  }
  bakePumps += 1;
  scheduleBakeDrain(delayMs);
}

// A region queued SPECULATIVELY has just gained its first waiter — move it to the urgent queue, keeping FIFO
// order in both. A no-op when it isn't in the warm queue: it may be baking already (nothing left to reorder), or
// not yet enqueued at all, in which case enqueueBake files it as urgent to begin with.
function promoteBake(key: string): void {
  if (warmQueue.length === 0) {
    return;
  }
  const at = warmQueue.findIndex((b) => b.key === key);
  if (at >= 0) {
    bakeQueue.push(warmQueue.splice(at, 1)[0]);
  }
}

// A region the suspension dropped: recoverable, unlike failRegion. Stays in `regionBaking` (its bake is pending,
// just not running) so re-requests from the nodes still painting it dedupe instead of re-enqueueing.
function parkRegion(job: BakeJob): void {
  regionParked.set(job.key, job);
  atlasBakeStats.parked = regionParked.size;
}

// Record a slow URGENT bake against one criterion's window and answer how many of ITS strikes are live, dropping
// the ones that have aged out. Ageing on WRITE (rather than on a timer) is enough: the count is only ever read
// here.
function recordStrike(times: number[], atMs: number): number {
  while (times.length > 0 && atMs - times[0] > BAKE_STRIKE_DECAY_MS) {
    times.shift();
  }
  times.push(atMs);
  atlasBakeStats.strikes = strikeTimes.length;
  atlasBakeStats.stallStrikes = stallTimes.length;
  return times.length;
}

// Stop baking and park queued/future regions on the canvas path until the backoff elapses. `criterion` records
// WHICH threshold fired (main-thread time vs wall stall) into the stats, so the next device probe can tell them apart.
function disableBaking(criterion: "sync" | "stall", reason: string, elapsedMs: number): void {
  if (atlasBakeStats.disabled) {
    return;
  }
  atlasBakeStats.disabled = true;
  atlasBakeStats.disabledReason = criterion;
  if (criterion === "sync") {
    atlasBakeStats.syncTrips += 1;
  } else {
    atlasBakeStats.stallTrips += 1;
  }
  const at = now();
  // An arm that ran healthily for BAKE_TRIP_MEMORY_MS earns a fresh escalation ladder; a re-trip soon after
  // re-arming keeps climbing it (that is the anti-thrash memory).
  if (lastRearmAtMs > 0 && at - lastRearmAtMs > BAKE_TRIP_MEMORY_MS) {
    tripLevel = 0;
  }
  tripLevel += 1;
  atlasBakeStats.trips += 1;
  const backoffMs = Math.min(BAKE_SUSPEND_MAX_MS, BAKE_SUSPEND_MS * 2 ** (tripLevel - 1));
  atlasBakeStats.suspendedUntilMs = at + backoffMs;
  strikeTimes.length = 0;
  stallTimes.length = 0;
  atlasBakeStats.strikes = 0;
  atlasBakeStats.stallStrikes = 0;
  for (const job of bakeQueue.splice(0).concat(warmQueue.splice(0))) {
    parkRegion(job);
  }
  scheduleRearm(backoffMs);
  if (typeof console !== "undefined") {
    console.info(
      `[mirror] atlas region bake suspended (${reason}, ${Math.round(elapsedMs)}ms) for ${Math.round(backoffMs / 1000)}s —` +
        ` ${atlasBakeStats.baked} baked, ${atlasBakeStats.slow} slow, ${regionParked.size} parked;` +
        ` sprites stay on the canvas path until it re-arms`
    );
  }
}

// The suspension's own timer. It is what makes the mechanism heal on a STATIC screen: a map that is just sitting
// there re-styles nothing, so nothing would ever ask for a blob again and an arrival-driven re-arm would never
// fire (the live probe measured exactly that — 28s and 82 fresh canvases, 0 bake requests).
function scheduleRearm(delayMs: number): void {
  if (typeof setTimeout !== "function") {
    return; // no timer host (SSR/shell): enqueueBake's elapsed-suspension check is the only re-arm path
  }
  if (rearmTimer !== null) {
    clearTimeout(rearmTimer);
  }
  rearmTimer = setTimeout(() => {
    rearmTimer = null;
    rearmBaking();
  }, delayMs);
}

// Resume baking and put every parked region back on its queue (urgent vs warm is re-decided by whether it still
// has a waiter, so a region that gained one while parked is now correctly urgent).
function rearmBaking(): void {
  if (!atlasBakeStats.disabled) {
    return;
  }
  if (rearmTimer !== null && typeof clearTimeout === "function") {
    clearTimeout(rearmTimer);
    rearmTimer = null;
  }
  atlasBakeStats.disabled = false;
  atlasBakeStats.suspendedUntilMs = 0;
  atlasBakeStats.rearms += 1;
  atlasBakeStats.disabledReason = null;
  lastRearmAtMs = now();
  strikeTimes.length = 0;
  stallTimes.length = 0;
  atlasBakeStats.strikes = 0;
  atlasBakeStats.stallStrikes = 0;
  const jobs = [...regionParked.values()];
  regionParked.clear();
  atlasBakeStats.parked = 0;
  atlasBakeStats.requeued += jobs.length;
  for (const job of jobs) {
    enqueueBake(job);
  }
  if (typeof console !== "undefined") {
    console.info(
      `[mirror] atlas region bake re-armed (attempt ${atlasBakeStats.rearms}) — ${jobs.length} parked regions re-queued`
    );
  }
}

function scheduleBakeDrain(delayMs: number): void {
  const run = (): void => {
    bakePumps -= 1;
    const urgent = bakeQueue.length > 0;
    const job = urgent ? bakeQueue.shift()! : warmQueue.shift(); // urgent first, speculative only when idle
    if (!job || atlasBakeStats.disabled) {
      return;
    }
    // EXACTLY ONE per task: a task never starts a second bake. On the worker path the settle continuation is not
    // the only thing that can schedule the next one (see the tail of this function), but the "one bake per task"
    // rule holds regardless, so no task's budget is ever spent twice.
    bakeInFlight += 1;
    bakeRegion(job, (timing) => {
      const { wallMs, syncMs, inlineMs, encodeMs } = timing;
      bakeInFlight -= 1;
      atlasBakeStats.totalMs += wallMs;
      atlasBakeStats.syncTotalMs += syncMs;
      atlasBakeStats.inlineTotalMs += inlineMs;
      syncPoolStats();
      if (wallMs > atlasBakeStats.slowestMs) {
        atlasBakeStats.slowestMs = wallMs;
      }
      if (syncMs > atlasBakeStats.slowestSyncMs) {
        atlasBakeStats.slowestSyncMs = syncMs;
      }
      if (inlineMs > atlasBakeStats.slowestInlineMs) {
        atlasBakeStats.slowestInlineMs = inlineMs;
      }
      // R10-PERF6 WS-P2 — ONLY AN URGENT BAKE CAN TRIP THE STICKY REVERT. The revert's job is to stop bakes from
      // janking a user who is waiting; a SPECULATIVE bake (the hidden-sprite warm-up) runs at idle for a screen
      // nobody has opened, so a slow one is evidence about the device rather than damage to anyone. This is
      // EXPOSURE CONTROL, not a measured win: the warm-up takes a session from ~54 bakes to ~780, and under the
      // old rule every one of those extra 726 was a fresh chance to trip a SESSION-WIDE kill switch whose failure
      // mode is catastrophic for exactly the screen being warmed (mechanism off ⇒ the map's ~715 sprites each
      // mount a <canvas> ⇒ a 1,535-layer open). Honest measurement on this box: it changed nothing either way,
      // because here the slow bakes that trip the switch are the URGENT combat ones (SwiftShader's convertToBlob
      // runs 350-400ms per region, so the revert is a coin flip on this host with or without the warm-up). What
      // it buys is that shipping the warm-up does not make that coin flip worse. Urgent bakes count exactly as
      // before, so the protection the switch was added for is untouched.
      //
      // --- WHICH TIME IS THE DAMAGE (Aug-13 device probe; the Aug-12 note above asked for exactly this) ---------
      // The comment this replaces read: "The criterion stays WALL time … the phone's pathology is GPU-process
      // contention, where the bake's cost lands on the compositor rather than on script, and a 3.7s wall bake is
      // exactly a bake fighting the frames for the GPU. The main-thread share is now measured alongside it
      // (`syncTotalMs`/`slowestSyncMs`) so a device probe can revisit this with data." THIS IS THAT REVISIT, and
      // the data says wall was the wrong trigger — but it does NOT retire the GPU-contention argument.
      //
      // The measurement (moto g86, real recorded combat over a real WebSocket, own visible tab, 106 samples,
      // hiddenSamples 0): totalMs 4,502.6 against syncTotalMs 385.3 — 91.4% of bake wall time was NOT main-thread
      // time — slowestMs 2,962.3 against slowestSyncMs 93.6, mean sync ~16ms per bake against a 50ms threshold.
      // Three trips (15s → 30s → 60s) ended with 41 regions stranded on the canvas path. A bake-probe on the same
      // phone then priced a region at ~36ms wall on an IDLE page vs ~188ms on a BUSY one with sync unchanged
      // (~20ms vs ~16ms): `convertToBlob` runs its encode as an IDLE TASK, so a busy main thread starves it. The
      // self-disable was firing on the page being busy — the one condition under which turning the mechanism off
      // does the most harm.
      //
      // So the two criteria now guard different things, and nothing about the GPU argument is deleted: this
      // session proved the MAIN THREAD was idle, it proved nothing about the GPU PROCESS.
      //   * BAKE_SLOW_MS (50ms) now reads `syncMs` — time this bake provably OWNED the main thread. That is the
      //     jank the switch was added to prevent, and it is the only part a busy page cannot inflate.
      //   * BAKE_STALL_MS (2,000ms) keeps reading wall, with its OWN strike count, so a genuine pathology that
      //     lands off-thread (the Aug-12 blocked-on-GPU tasks: 2,029ms and 2,705ms of wall on ~100ms of CPU) can
      //     still trip the mechanism. It is a backstop, not the trigger. [REVISED the same day — that wall rule
      //     survives for the INLINE path only; see WHICH WALL IS THE DAMAGE immediately below.]
      // Urgent-only is unchanged for both. On the worker path `syncMs` is one `postMessage`, which is the point:
      // a device whose encodes are slow no longer loses its layers for it, only one whose MAIN THREAD is.
      //
      // --- WHICH WALL IS THE DAMAGE (Aug-14 device probe, workers ON; the revision above asked for this too) ----
      // The syncMs half above worked exactly as designed: slow 0, syncTrips 0, slowestSyncMs 106.3 → 7.0,
      // syncTotalMs 483.5 → 108.2, parked 31 → 0. The WALL backstop then tripped anyway — `stallTrips: 1`, a 15s
      // suspension — which is the SAME category error, reintroduced on the wall axis:
      //   {"baked":64,"slow":0,"stalled":3,"slowestMs":2725.3,"totalMs":12532.2,"syncTotalMs":108.2,
      //    "trips":1,"requeued":34,"syncTrips":0,"stallTrips":1,"poolSize":4,"workerBaked":64,
      //    "workerMsTotal":4680.7,"workerEncodeMsTotal":544.9,"workerSlowestMs":1837.4,"atlasLoads":7}
      // Read the wall of a worker bake as the sum of three unrelated things:
      //   1. POOL QUEUE WAIT — slowestMs 2,725.3 against the worker's own slowestMs 1,837.4: ~888ms of the worst
      //      bake was spent pending in atlasBakePool's queue. With 64 regions, 4 workers, and the first copy of a
      //      page held exclusive until it reports its size, that wait is normal, expected and harms nobody.
      //   2. A ONE-OFF PAGE DECODE — workerEncodeMsTotal 544.9 of workerMsTotal 4,680.7, i.e. ~88% of all worker
      //      time was fetching + decoding the 7 atlas pages (140MB of RGBA). The FIRST job for a page pays that in
      //      full and every later job for it pays nothing, so charging it to a region is charging one arbitrary
      //      sprite for a cost the whole page owes — 7 of the session's 64 bakes start pre-loaded with a verdict
      //      they did not earn.
      //   3. THE ENCODE — 544.9ms over 64 regions, ~8.5ms each. Only this is evidence about the device's bake path.
      // So the stall backstop now measures WORK, not waiting, per path: the inline encode's own wall against
      // BAKE_STALL_MS (no queue and no separate decode exist there, so wall is still fair — that path is
      // unchanged), and the worker's reported `encodeMs` against BAKE_WORKER_STALL_MS. A wall threshold on the
      // worker path is not merely mis-tuned, it is uncalibratable: its floor would be set by a 62.6MB page decode
      // that is amortised over that page's regions, so any value low enough to catch a real encode pathology fires
      // on the first bake of a big page and any value high enough to clear a decode is above every real encode by
      // three orders of magnitude. Both halves stay URGENT-ONLY, share one strike window, and trip as "stall".
      //
      // Still true, and still not covered by either criterion: a bake that never settles at all cannot strike.
      // That was equally true of the wall rule this replaces (both criteria run in the settle), so nothing changed;
      // a worker watchdog would be a different mechanism. If the PAGE DECODE ever turns out to be the pathology,
      // it needs its own criterion keyed on the pool's per-page `loadMs`/`atlasLoads` — per page, not per region.
      if (urgent && syncMs >= BAKE_SLOW_MS) {
        atlasBakeStats.slow += 1;
        const live = recordStrike(strikeTimes, now());
        if (live >= BAKE_SLOW_LIMIT) {
          disableBaking("sync", `${live} bakes over ${BAKE_SLOW_MS}ms of main thread`, syncMs);
        }
      }
      const inlineStall = inlineMs >= BAKE_STALL_MS;
      const workerStall = encodeMs >= BAKE_WORKER_STALL_MS;
      if (urgent && (inlineStall || workerStall)) {
        atlasBakeStats.stalled += 1;
        const live = recordStrike(stallTimes, now());
        if (live >= BAKE_STALL_LIMIT) {
          const stallMs = inlineStall ? inlineMs : encodeMs;
          const over = inlineStall ? `${BAKE_STALL_MS}ms inline` : `${BAKE_WORKER_STALL_MS}ms of worker encode`;
          disableBaking("stall", `${live} bakes stalled over ${over}`, stallMs);
        }
      }
      if (atlasBakeStats.disabled) {
        return;
      }
      // PACING, not damage. This picks how long to wait before starting the NEXT bake, and what it has to react
      // to is how much of the main thread the last one ate — a bake that waited 900ms on an idle callback cost
      // this thread nothing and there is no reason to hold the queue back for it. (Before Aug-14 this read
      // `elapsedMs`, which on the phone meant almost every bake took the 16ms yield for time it never spent.)
      pumpBakeDrain(syncMs >= BAKE_BUDGET_MS ? BAKE_YIELD_MS : 0);
    });
    // WORKER PATH: the bake above is now someone else's thread, so the next region does not have to wait for it —
    // issue it in its own task, up to `bakeConcurrency()`. A no-op when the pool is off (concurrency 1), which is
    // what keeps the inline path exactly as serial as it was.
    pumpBakeDrain(0);
  };
  if (typeof setTimeout === "function") {
    setTimeout(run, delayMs);
  } else {
    run();
  }
}

function startRegionBake(key: string, url: string, region: AtlasRegion): void {
  if (regionBaking.has(key)) {
    return;
  }
  regionBaking.add(key);
  const entry = getAtlas(url);
  // The INLINE fallback's draw source, resolved when the job is queued. It is whatever this page has — owned
  // pixels if the budget is holding them, otherwise the element, whose `drawImage` is exactly as correct and
  // merely less eviction-proof. A bake deliberately does NOT promote: the pool does the cropping from its own
  // copy of the page, so a bake is not evidence that THIS thread needs the pixels.
  const source = drawSourceOf(entry);
  if (source) {
    enqueueBake({ key, url, region, source, strip: null });
    return;
  }
  if (entry.settled) {
    failRegion(key); // the atlas itself failed to load — nothing to cut a region out of
    return;
  }
  // Waiting on the MAIN THREAD's load even when the pool will do the work: a worker's atlas is its own copy, so
  // a page the main thread could not load (404, tainted, decode failure) is one the worker has no business
  // fetching either — and this is also what keeps the inline fallback below always able to draw.
  entry.listeners.add(() => {
    const settledSource = drawSourceOf(entry);
    if (settledSource) {
      enqueueBake({ key, url, region, source: settledSource, strip: null });
    } else {
      failRegion(key);
    }
  });
}

/** What one bake cost, split so the drain's two criteria each read a number they are allowed to judge. */
interface BakeTiming {
  /** End-to-end wall, from the drain dequeuing this region to its terminal path. Diagnostic only (see the drain). */
  wallMs: number;
  /** The share of that wall which provably ran ON THIS THREAD — the strike criterion. */
  syncMs: number;
  /** The INLINE encode's own wall (draw + `convertToBlob`/`toBlob`), 0 when no inline attempt ran. */
  inlineMs: number;
  /** The WORKER's crop+encode, as it reported it: no pool queue wait, no page decode. 0 when no worker ran it. */
  encodeMs: number;
}

// Encode one job to a blob — in a worker when there is a pool, on this thread when there is not. A REGION job
// (`source` set) has both halves; a STRIP job (`strip` set) is worker-only and abandons instead of retrying here.
//
// `settled(timing)` is called EXACTLY ONCE, on every terminal path (published, failed, or refused). `syncMs` is an
// ACCUMULATOR over every synchronous segment, not a single stamp, because a worker bake that fails can still
// spend main-thread time afterwards on the inline retry — and a criterion that reads syncMs (see the drain) must
// not be blind to that. `inlineMs` is stamped from the start of the inline attempt for the same reason: a region
// the pool refused (or could not finish) must be judged on what the retry cost HERE, not on the worker time and
// queue wait it wore first. Wall still spans everything; the four together are what let a device probe tell "this
// bake blocked the page" from "this bake did expensive work" from "this bake waited".
function bakeRegion(job: BakeJob, settled: (timing: BakeTiming) => void): void {
  const { key, url, region, source } = job;
  const startedAt = now();
  let done = false;
  let syncMs = 0;
  let segmentDepth = 0;
  let segmentStart = 0;
  /** -1 until an inline attempt starts (0 is a legitimate clock reading, so it cannot be the sentinel). */
  let inlineStartedAt = -1;
  /** …and the worker's own encode time, once a worker reports one. */
  let encodeMs = 0;
  /**
   * Run a synchronous segment and charge its cost to this bake's main-thread total. Only the OUTERMOST segment
   * is charged (a nested one is already inside its parent's span), so a worker hand-off that fails synchronously
   * and retries inline counts its main-thread time once, not twice.
   */
  const onMainThread = <T>(segment: () => T): T => {
    if (segmentDepth === 0) {
      segmentStart = now();
    }
    segmentDepth += 1;
    try {
      return segment();
    } finally {
      segmentDepth -= 1;
      if (segmentDepth === 0) {
        syncMs += now() - segmentStart;
      }
    }
  };
  const finish = (): void => {
    if (done) return;
    done = true;
    const at = now();
    // A terminal path reached from INSIDE a segment (a synchronous `toBlob` callback, a synchronous refusal) has
    // to close that segment's time out itself — it will never reach the `finally` that would have added it.
    settled({
      wallMs: at - startedAt,
      syncMs: syncMs + (segmentDepth > 0 ? at - segmentStart : 0),
      inlineMs: inlineStartedAt >= 0 ? at - inlineStartedAt : 0,
      encodeMs
    });
  };
  const abandon = (): void => {
    failRegion(key);
    atlasBakeStats.failed += 1;
    finish();
  };
  const w = Math.max(1, Math.round(region.width));
  const h = Math.max(1, Math.round(region.height));
  const canUrl = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
  if (!canUrl) {
    abandon();
    return;
  }
  const publish = (blob: Blob | null): void => {
    if (!blob) {
      abandon();
      return;
    }
    regionBaking.delete(key);
    onMainThread(() => regionBlobs.set(key, URL.createObjectURL(blob)));
    atlasBakeStats.baked += 1;
    // A blob that DID land is kept even if it was slow — the pixels are paid for; the slowness only counts
    // toward turning the mechanism off for the regions that come after it.
    finish();
    notifyRegion(key);
  };

  // --- a STRIP: the worker path, with no inline half behind it ---------------------------------------------------
  // A strip has no inline retry ON PURPOSE (see the strips block at the top of this file): the caller's fallback is
  // the strip it is already compositing on its own canvas, so "the pool refused it" and "the worker could not
  // finish it" both mean the same thing here — this key never becomes a blob, the caller keeps its canvas, and the
  // main thread pays nothing to find that out. `abandon()` is therefore the whole failure handling.
  if (job.strip) {
    const strip = job.strip;
    const accepted = onMainThread(() =>
      bakeAtlasStripInWorker(
        key,
        url,
        strip.cells.map((cell) => cell.region),
        strip.cellW,
        strip.cellH,
        (blob, timing) => {
          if (blob) {
            encodeMs = timing.encodeMs; // set BEFORE publish: publish is what closes this bake's books
            publish(blob);
          } else {
            abandon();
          }
        }
      )
    );
    if (!accepted) {
      abandon();
    }
    return;
  }

  // --- the INLINE path (no Worker support and every worker-side fallback) ---------------------------------------
  // Draw the region into a throwaway canvas and encode it here. The draw mirrors the per-node canvas path EXACTLY
  // (rounded backing store, unrounded destination rect) so the two mechanisms produce the same pixels.
  //
  // WHEN THIS RUNS AT ALL, given the pool exists (Aug-19 audit — the list, so nobody has to re-derive it):
  //   1. no pool: no `Worker` global, or the constructor threw (CSP),
  //   2. a page that FAILED to load in a worker — the pool marks it dead and refuses every later region of it
  //      (`deadPages` in bakeAtlasRegionInWorker), so that page bakes here for the rest of the session,
  //   3. a single worker job that failed, or the pool losing its last worker with work in hand (`settle(null, …)`),
  //   4. a NON-INTEGRAL region, which never goes to a worker at all (the `integral` gate below; 0 of 2,771 sampled).
  // A STRIP never reaches here — it returned above, with the caller's own canvas as its fallback.
  //
  // AND IT IS NOT THE MAIN-THREAD `canvas.toBlob` A TRACE SHOWS. This path takes `OffscreenCanvas.convertToBlob`
  // whenever `OffscreenCanvas` exists — every Chromium this client targets — so the `HTMLCanvasElement.toBlob`
  // branch under it is a floor for hosts without it, not a path that runs here. The reachable main-thread
  // `toBlob` callers in this client are both SURFACE FREEZERS, not bakes: mirrorRenderer's `encodeCanvasSnapshot`
  // (tier-2 occlusion, which needs an engaged cover), and godot-scene-web's static-surface swap fleet, which
  // encodes on a TIMER ~1s after a surface's own draws go quiet (`STATIC_SURFACE_QUIET_MS` in
  // mirror/shaderResources.ts, `deferHead: true` ⇒ every encode on a `TimerFire`) — the timing that lines up with
  // a card's VFX settling, and a readback because those surfaces are GPU-backed. The same fleet was already
  // caught this way once (its `toBlob` + `createObjectURL` measured 52.8 + 17.1ms inside a `TimerFire` on a moto
  // g86, Aug-18), and `window.__mirrorShaderStats()`'s `staticImageEncodes` is what confirms it on a device. It
  // lives in gsw, so its cost is a gsw-side question — this module is not where it gets a workaround.
  const inlineBake = (): void => {
    if (!source) {
      // A STRIP is the only job without a decoded page, and it returned above — this is the type's floor, not a
      // case: there is nothing to draw from here, so failing is the only honest answer.
      abandon();
      return;
    }
    inlineStartedAt = now(); // BAKE_STALL_MS is measured from HERE, not from the drain's dequeue
    try {
      if (typeof OffscreenCanvas === "function") {
        const encoding = onMainThread(() => {
          const off = new OffscreenCanvas(w, h);
          const ctx = off.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
          if (!ctx) {
            return null;
          }
          ctx.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
          // Everything in this segment owned the main thread; what follows is the encode's own (async) time.
          return off.convertToBlob({ type: "image/png" });
        });
        if (!encoding) {
          abandon();
          return;
        }
        encoding.then(publish, abandon);
        return;
      }
      if (typeof document === "undefined") {
        abandon();
        return;
      }
      const started = onMainThread(() => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx || typeof canvas.toBlob !== "function") {
          return false;
        }
        ctx.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
        canvas.toBlob(publish, "image/png");
        return true;
      });
      if (!started) {
        abandon();
      }
    } catch {
      abandon();
    }
  };

  // --- the WORKER path (default) -------------------------------------------------------------------------------
  // The main thread's whole share is the `postMessage` inside `bakeAtlasRegionInWorker`. `false` means the pool
  // would not take it (no pool, this page failed to load in a worker, every worker lost); a later `null` blob
  // means it took it and could not finish. Both degrade to the inline path — a region is never dropped because a
  // worker misbehaved. The pool hands back the job's queue/decode/encode split with the blob; only `encodeMs`
  // reaches a criterion (see WHICH WALL IS THE DAMAGE in the drain).
  //
  // PIXEL-IDENTICAL ONLY. The worker crops raw RGBA row by row, so it reproduces the inline `drawImage` exactly
  // for an INTEGRAL rect; a FRACTIONAL one would be resampled there and nearest-copied here. No such region
  // exists in practice (0 of 2,771 sampled across three recorded sessions — Godot atlas rects are whole pixels),
  // so this gate costs nothing and makes "same mechanism, same pixels" true by construction rather than by
  // assumption.
  const integral =
    Number.isInteger(region.x) &&
    Number.isInteger(region.y) &&
    Number.isInteger(region.width) &&
    Number.isInteger(region.height);
  const accepted =
    integral &&
    onMainThread(() =>
      bakeAtlasRegionInWorker(key, url, { x: region.x, y: region.y, width: w, height: h }, (blob, timing) => {
        if (blob) {
          encodeMs = timing.encodeMs; // set BEFORE publish: publish is what closes this bake's books
          publish(blob);
        } else {
          inlineBake();
        }
      })
    );
  if (!accepted) {
    inlineBake();
  }
}

// A region that can never be baked — a GENUINE failure (no encode path, a dead atlas, a refused draw). Drop its
// waiters WITHOUT notifying (they are already
// painting through their canvas, which stays correct) so no node is ever re-styled for a swap that will not
// happen. Contrast parkRegion, which is the recoverable one and keeps its waiters.
function failRegion(key: string): void {
  regionBaking.delete(key);
  regionFailed.add(key);
  regionWaiting.delete(key);
}

function notifyRegion(key: string): void {
  const ids = regionWaiting.get(key);
  if (ids === undefined) {
    return;
  }
  regionWaiting.delete(key);
  for (const listener of regionListeners) {
    listener(ids);
  }
}

// STAGE-C (img-first sprites): re-fire the region listeners with an EXPLICIT id set. The renderer's blob decode
// gate holds a canvas/page-div → region-div mechanism swap until a freshly-baked blob is actually paintable
// (decodeStill), and when that async decode resolves it routes its "re-style exactly these nodes" signal through
// the SAME onAtlasRegionsReady → markTextureDirty → coalesced-render chain a landing bake takes — no second seam
// for MirrorView (or a test harness) to wire. Not a gate on the bake pipeline itself: publish/stats/waiter
// bookkeeping above are untouched.
export function notifyAtlasRegionIds(ids: ReadonlySet<string>): void {
  if (ids.size === 0) {
    return;
  }
  for (const listener of regionListeners) {
    listener(ids);
  }
}

/** TEST-ONLY: drop the atlas cache so a test starts clean. */
export function __resetAtlasCacheForTest(): void {
  for (const entry of atlases.values()) {
    releaseOwnedPixels(entry); // closes the bitmaps AND rewinds the byte/page counters
  }
  atlases.clear();
  atlasResidencyStats.residentBytes = 0;
  atlasResidencyStats.residentPages = 0;
  atlasResidencyStats.promoted = 0;
  atlasResidencyStats.rePromoted = 0;
  atlasResidencyStats.evictedByCap = 0;
  atlasResidencyStats.promoteFailed = 0;
  __setAtlasResidencyForTest(undefined, undefined);
  for (const blob of regionBlobs.values()) {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(blob);
    }
  }
  regionBlobs.clear();
  regionBaking.clear();
  regionFailed.clear();
  regionWaiting.clear();
  regionParked.clear();
  bakeQueue.length = 0;
  warmQueue.length = 0;
  bakeInFlight = 0;
  bakePumps = 0;
  strikeTimes.length = 0;
  stallTimes.length = 0;
  tripLevel = 0;
  lastRearmAtMs = 0;
  if (rearmTimer !== null && typeof clearTimeout === "function") {
    clearTimeout(rearmTimer);
  }
  rearmTimer = null;
  __resetAtlasBakePoolForTest(); // the pool re-resolves its size/budget from the next spec's stubs
  atlasBakeStats.baked = 0;
  atlasBakeStats.failed = 0;
  atlasBakeStats.slow = 0;
  atlasBakeStats.stalled = 0;
  atlasBakeStats.slowestMs = 0;
  atlasBakeStats.totalMs = 0;
  atlasBakeStats.syncTotalMs = 0;
  atlasBakeStats.slowestSyncMs = 0;
  atlasBakeStats.inlineTotalMs = 0;
  atlasBakeStats.slowestInlineMs = 0;
  atlasBakeStats.disabled = false;
  atlasBakeStats.strikes = 0;
  atlasBakeStats.stallStrikes = 0;
  atlasBakeStats.suspendedUntilMs = 0;
  atlasBakeStats.trips = 0;
  atlasBakeStats.rearms = 0;
  atlasBakeStats.requeued = 0;
  atlasBakeStats.syncTrips = 0;
  atlasBakeStats.stallTrips = 0;
  atlasBakeStats.disabledReason = null;
  atlasBakeStats.parked = 0;
  syncPoolStats();
}

/**
 * TEST-ONLY: seed a page's DECODED size, which jsdom can never produce (it loads no images). Stands in for a
 * settled page exactly as `__publishRegionBlobForTest` stands in for a completed encode — the stand-in source
 * carries only what `atlasPageSize` reads, which is all the renderer's placeholder size gate asks of it.
 * `null` forgets the page again.
 */
export function __setAtlasPageSizeForTest(url: string, size: { width: number; height: number } | null): void {
  if (size === null) {
    const existing = atlases.get(url);
    if (existing) releaseOwnedPixels(existing);
    atlases.delete(url);
    return;
  }
  const entry: AtlasEntry = atlases.get(url) ?? {
    element: null,
    bitmap: null,
    size: null,
    settled: false,
    listeners: new Set<() => void>(),
    usedAtMs: 0,
    promoting: false,
    promoteFailed: false,
    evicted: false
  };
  entry.size = { width: size.width, height: size.height };
  // A stand-in for the loaded ELEMENT, carrying only what a draw source has to satisfy the type — `atlasPageSize`
  // reads the memo above, and nothing in jsdom ever rasterises this.
  entry.element = (entry.element ?? { naturalWidth: size.width, naturalHeight: size.height }) as HTMLImageElement;
  entry.settled = true;
  atlases.set(url, entry);
  const waiting = [...entry.listeners];
  entry.listeners.clear();
  for (const cb of waiting) cb();
}

/** TEST-ONLY: pin the residency levers without a URL (`undefined` restores the values read at module load). */
export function __setAtlasResidencyForTest(
  cap: number | undefined,
  mode: AtlasOwnershipMode | undefined = undefined
): void {
  residentCapBytes = cap === undefined ? readResidentCap() : cap;
  ownership = mode === undefined ? readOwnershipMode() : mode;
  atlasResidencyStats.residentCap = residentCapBytes;
}

/** TEST-ONLY: the residency tuning, so a spec asserts the real constants rather than copies of them. */
export const __atlasResidencyTuningForTest = {
  ATLAS_RESIDENT_BYTES_DEFAULT,
  ATLAS_USE_GRACE_MS
};

/** TEST-ONLY: is this page holding OWNED pixels right now? (`atlasDecodedSource` would promote on a miss.) */
export function __atlasOwnsPixelsForTest(url: string): boolean {
  return atlases.get(url)?.bitmap != null;
}

/** TEST-ONLY: back-date a page's last use so the grace window has elapsed without a fake clock. */
export function __ageAtlasUseForTest(url: string, byMs: number): void {
  const entry = atlases.get(url);
  if (entry) entry.usedAtMs -= byMs;
}

/** TEST-ONLY: the bake tuning constants, so a spec asserts the real thresholds rather than copies of them. */
export const __atlasBakeTuningForTest = {
  BAKE_SLOW_MS,
  BAKE_SLOW_LIMIT,
  BAKE_STALL_MS,
  BAKE_WORKER_STALL_MS,
  BAKE_STALL_LIMIT,
  BAKE_BUDGET_MS,
  BAKE_YIELD_MS,
  BAKE_STRIKE_DECAY_MS,
  BAKE_SUSPEND_MS,
  BAKE_SUSPEND_MAX_MS,
  BAKE_TRIP_MEMORY_MS
};

/** TEST-ONLY: the node ids currently waiting on a region's bake. */
export function __regionWaitersForTest(url: string, region: AtlasRegion): string[] {
  return [...(regionWaiting.get(atlasRegionKey(url, region)) ?? [])];
}

/** TEST-ONLY: …and the ids waiting on any cache key (a strip's, which its caller builds with atlasStripKey). */
export function __keyWaitersForTest(key: string): string[] {
  return [...(regionWaiting.get(key) ?? [])];
}

/** TEST-ONLY: publish a region blob exactly as a completed bake does (jsdom never encodes one). */
export function __publishRegionBlobForTest(url: string, region: AtlasRegion, blobUrl: string): void {
  const key = atlasRegionKey(url, region);
  regionBaking.delete(key);
  regionFailed.delete(key);
  regionParked.delete(key);
  regionBlobs.set(key, blobUrl);
  notifyRegion(key);
}

/** TEST-ONLY: how many distinct regions have been baked (bake-once assertions). */
export function __regionBlobCountForTest(): number {
  return regionBlobs.size;
}

/** TEST-ONLY: publish a STRIP blob exactly as a completed strip bake does (jsdom never encodes one). */
export function __publishStripBlobForTest(key: string, blobUrl: string): void {
  regionBaking.delete(key);
  regionFailed.delete(key);
  regionParked.delete(key);
  regionBlobs.set(key, blobUrl);
  notifyRegion(key);
}
