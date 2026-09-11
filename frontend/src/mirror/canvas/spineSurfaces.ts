// SPINE STILLS FOR THE SINGLE-CANVAS STAGE — a decoded clip frame in, an uploaded GL texture out.
//
// The third population of textures in the stage's shared `CanvasTextureCache`, after `textureBridge`'s page urls
// and `fxSurfaces`' effect canvases. It exists because a spine clip is neither of those things, and picking either
// module would have been wrong in a way that costs pixels or milliseconds:
//
//   * NOT `textureBridge`. The bridge's budget is 4 MB per build, with always-allow-one so a page larger than the
//     whole budget still lands. A decoded spine still is 4.10 MB at the median and 11.76 MB at p90 (spine drives
//     room BACKGROUNDS here, not just creatures), so putting one through that door would spend the entire page
//     budget on a creature and stall the atlases the rest of the screen is waiting for.
//   * NOT `fxSurfaces`. That registry's whole shape follows from its pixels being MUTABLE — keyed per node,
//     uploaded with `update`, dirty again next frame, rotated LRU-first. A clip frame is IMMUTABLE per url and
//     SHARED across every node playing it: keyed per url, uploaded once with `acquire`, never dirty. Keying it per
//     node would upload the same merchant three times on the shop screen.
//
// ---------------------------------------------------------------------------------------------------------------
// THE KEY SPACE — `spine://<clipUrl>`.
//
// The same prefix seam `fx://` uses, for the same reason: the draw list is ONE list of string handles, so a key
// minted here arrives at the bridge, and the prefix is what says which registry owns it. Per-URL keys inherit
// cross-node sharing for free — two ironclads playing the same idle are one texture and one upload.
//
// ---------------------------------------------------------------------------------------------------------------
// THE PIXEL SOURCE — an `ImageBitmap` this module owns for exactly as long as the upload needs it.
//
// `spineClip`'s bytes-only still path deliberately never decodes a single-frame clip: it mints an object url and
// hands it to an `<img>`, which saves 4-16 MB of RGBA per still against ~50-300 KB of encoded bytes. A stage quad
// needs PIXELS, so a naive version would have re-decoded every clip into an ImageBitmap and kept all of that.
//
// This module first uploaded the element the overlay already has, on the reasoning that A1's decode gate had
// resolved so the browser had the bitmap in hand and `texImage2D` would not decode inline. THAT REASONING WAS
// HALF RIGHT AND IS CORRECTED HERE. A decoded `<img>` frame is a CACHE, not a possession: `decode()` resolves,
// and then a phone under memory pressure throws the pixels away. The next `texImage2D` re-decodes a multi-megabyte
// WebP synchronously, inside the build. A Moto G86 combat trace measured that as 58.2 / 26.9 / 26.9 / 22.4 /
// 20.9 ms frame tasks — the same eviction, and the same shape, as the card-atlas stalls `atlasRepack` was taught
// to dodge by cropping from owned bitmaps instead of from an element.
//
// So the upload source is now an `ImageBitmap` decoded from the clip's ENCODED bytes (which the clip retains
// anyway), and the discipline that keeps this from re-spending what the bytes-only path saved is:
//
//   * ONE decode at a time, across the whole registry (`decodeSlot`). Transient RGBA is bounded by ONE still, not
//     by how many creatures are on screen — a deck view's 33 overlays cannot conspire to allocate 388 MB here.
//   * The caps are checked BEFORE a decode is requested. A still that could not be uploaded if it were decoded
//     never gets decoded.
//   * `close()` the instant the upload returns. The pixels exist on the JS heap for one build, then only on the
//     GPU where the byte ceiling above already governs them.
//   * A decode is REQUESTED, never awaited: `acquire` answers false for the builds it is in flight, and the node
//     keeps painting through the overlay's `<img>` — the same safe refusal every other path here takes.
//
// The `<img>` remains the fallback wherever owned pixels are unavailable (no `createImageBitmap`, no `Blob`, a
// clip that cannot produce bytes, a decode that failed): that is the pre-existing behaviour, cost and all.
//
// ---------------------------------------------------------------------------------------------------------------
// RESIDENCY, and why it is a byte cap rather than a pace.
//
// An upload here happens ONCE per url, so there is no rotation to govern and no per-frame cost to spread: what has
// to be bounded is how much of the GPU a screen's creatures may hold at rest. Deck view carries 33 spine overlays;
// at the p90 still size that is 388 MB, which is the phone's whole budget several times over. So the caps are a
// resident BYTE ceiling and a per-build upload COUNT (the count is the same fixed-cost argument the other two
// registries make — an upload is ~0.164 ms of call overhead before any pixels move).
//
// A REFUSAL IS NOT A LOSS. Everything here is an OPTIMISATION of a surface that already renders: if this registry
// declines a clip, no quad is emitted, the overlay keeps its `<img>` and the node paints exactly as it does today.
// That is the property that lets the caps be tight — the failure mode is the status quo, not a missing creature.

import type { CanvasTextureCache, ExecutorTexture } from "@godot-scene-web/canvas";

/** The key-space prefix that tells `textureBridge` a key belongs to this registry rather than to a page url. */
export const SPINE_KEY_PREFIX = "spine://";

/**
 * Default RESIDENT byte ceiling for spine stills.
 *
 * 32 MB is ~8 medians or ~3 p90 stills — enough for a combat's creatures (4 spine overlays) and a shop's merchants
 * (5) with room to spare, and far short of what a deck view's 33 would ask for. The cap is on RESIDENCY rather
 * than on a per-build spend because the uploads are one-shot: what a screen can hold is the question.
 */
export const SPINE_PACE_BYTES_DEFAULT = 32 * 1024 * 1024;

/**
 * Default per-build upload COUNT cap.
 *
 * One. An upload of a p90 still is 11.76 MB — 40 ms of `texImage2D` on the headless box's measured 3.4 ms/MB, and
 * seconds on a phone — so the honest per-build budget is a single creature. A screen full of them lands over the
 * next few builds, and until each one does its node keeps the `<img>` it already had.
 */
export const SPINE_PACE_COUNT_DEFAULT = 1;

/** How many builds a clip can go un-named before its texture is released. `textureBridge`'s clock. */
export const SPINE_EVICT_AFTER_BUILDS = 240;

/** What the key for a clip url is. The inverse of {@link spineUrlFromKey}. */
export function spineKeyForUrl(clipUrl: string): string {
  return SPINE_KEY_PREFIX + clipUrl;
}

/** The clip url inside a `spine://` key, or null when the key belongs to some other population. */
export function spineUrlFromKey(key: string): string | null {
  return key.startsWith(SPINE_KEY_PREFIX) ? key.slice(SPINE_KEY_PREFIX.length) : null;
}

/**
 * How many builds a resolved-but-unspent bitmap may sit in the decode slot before it is closed.
 *
 * A decode resolves for a url the scene has since stopped naming (the creature died, the screen changed) — and
 * the bitmap would then hold the slot, and its megabytes, until something else asked. Two builds is enough for
 * the normal case (resolve, then upload on the very next build) and short enough that a stale one cannot linger.
 */
export const SPINE_BITMAP_STALE_BUILDS = 2;

/** What a caller hands over: a paintable image source, the size the upload will cost, and how to own the pixels. */
export interface SpinePixelSource {
  /** Anything `texImage2D` takes — in practice the overlay's own `<img>`. The FALLBACK source; see the header. */
  source: TexImageSource;
  width: number;
  height: number;
  /**
   * The still's ENCODED bytes, for minting pixels this module owns rather than uploading an evictable element.
   * A THUNK, so nothing is allocated for a still the caps would refuse anyway. Omit (or answer null) to keep the
   * pre-existing `<img>` upload.
   */
  bytes?: () => Blob | null;
}

export interface SpineSurfaceStats {
  /** Distinct clip urls this registry has been asked for. */
  surfaces: number;
  /** Urls holding a live uploaded texture right now. */
  resident: number;
  /** Resident RGBA bytes across those textures — this registry's share of the shared cache, not the total. */
  bytes: number;
  /** `texImage2D` calls made through `cache.acquire`. */
  uploads: number;
  /** Total main-thread ms inside those calls — SUBMIT cost only, never quotable as the GPU's bill. */
  uploadMs: number;
  /** The longest single upload SUBMIT, ms. */
  maxUploadMs: number;
  /** Acquires held back because the build had already spent its upload COUNT. */
  paced: number;
  /** Acquires refused because uploading would breach the resident byte ceiling. */
  refusedForBudget: number;
  /** Urls refused for exceeding `maxTextureDim`, or which the driver would not take. Never retried. */
  declined: number;
  /** Textures released because no build named them for {@link SPINE_EVICT_AFTER_BUILDS} builds. */
  evicted: number;
  /** The resident byte ceiling in force; `0` means uncapped. */
  paceBytes: number;
  /** The per-build upload count cap in force; `0` means uncapped. */
  paceCount: number;
  /** Decodes STARTED for owned pixels. At most one is ever in flight — see the header. */
  decodes: number;
  /** Decodes that rejected (or whose bytes were unavailable). Those urls fall back to the `<img>` forever. */
  decodeFailed: number;
  /** Resolved bitmaps closed unspent because the scene stopped naming the url. See {@link SPINE_BITMAP_STALE_BUILDS}. */
  decodeStale: number;
  /**
   * Uploads whose source was an `ImageBitmap` this module owned. Together with {@link elementUploads} this is the
   * gauge that says whether the header's argument is actually in force on a device: `elementUploads` is the arm
   * that can still re-decode inside a build, so it should be ~0 anywhere `createImageBitmap` exists.
   */
  ownedUploads: number;
  /** Uploads whose source was the caller's `<img>` — the fallback, and the only arm that can decode inline. */
  elementUploads: number;
}

/**
 * The seam `textureBridge` delegates `spine://` keys through — structurally satisfied by
 * {@link SpineSurfaceRegistry}, written out separately so the bridge depends on two methods.
 */
export interface SpineTextureSource {
  handleFor(clipUrl: string): ExecutorTexture | null;
  sizeOf(clipUrl: string): { width: number; height: number } | null;
}

export interface SpineSurfaceRegistry extends SpineTextureSource {
  /**
   * NAME this clip for the build in progress and say whether its pixels are on the GPU.
   *
   * Uploading happens HERE, inside the build, exactly like the other two registries: that is where a budget can
   * see it. `false` means "no quad this build" — the caller keeps the overlay's `<img>`, which is the pre-M3
   * behaviour and is why every refusal here is safe.
   */
  acquire(clipUrl: string, pixels: SpinePixelSource): boolean;
  /** Close the build: bank the count cap and evict what the scene stopped naming. */
  endBuild(): void;
  /** The clip is gone (its node unmounted, or it swapped anim): drop the record and the texture. */
  release(clipUrl: string): void;
  /** CONTEXT LOSS: every url forgets its upload WITHOUT touching the dead driver (gsw's `reset()` did that). */
  invalidate(): void;
  stats(): SpineSurfaceStats;
  dispose(): void;
}

export interface SpineSurfaceOptions {
  cache: CanvasTextureCache;
  /** Resident byte ceiling. `0` (or non-finite) uncaps. Defaults to {@link SPINE_PACE_BYTES_DEFAULT}. */
  paceBytes?: number;
  /** Per-build upload count cap. `0` (or non-finite) uncaps. Defaults to {@link SPINE_PACE_COUNT_DEFAULT}. */
  paceCount?: number;
  /** The context's `MAX_TEXTURE_SIZE`. A larger source is refused rather than uploaded incomplete (black). */
  maxTextureDim?: number;
  /** Overridable for tests. Defaults to {@link SPINE_EVICT_AFTER_BUILDS}. */
  evictAfterBuilds?: number;
  /**
   * A decode resolved — ask for a rebuild, or the pixels wait for whatever happens to redraw next.
   *
   * `acquire` runs INSIDE a build, so a still whose decode was requested there is refused for that build and
   * uploaded on a later one. On a settled screen there is no later one: nothing is animating, so nothing schedules
   * a frame, and the creature would keep its `<img>` indefinitely. That is safe but it is not the upgrade this
   * module exists for, so a resolved decode nudges the renderer exactly as `textureBridge.onResolved` does.
   */
  onDecoded?: (clipUrl: string) => void;
  /** TEST-ONLY seam for the (async, browser-only) bitmap decode. Defaults to `createImageBitmap`. */
  decodeBlob?: (blob: Blob) => Promise<ImageBitmap>;
}

interface Surface {
  url: string;
  /** Whether this url currently holds a reference in the shared cache (so `release` is balanced). */
  uploaded: boolean;
  /** Resident RGBA bytes, tracked so `stats.bytes` is this registry's share alone. */
  bytes: number;
  width: number;
  height: number;
  /** Permanently refused (over `maxTextureDim`, or a source the driver rejected): never retried. */
  declined: boolean;
  /** The build ordinal that last named this url. */
  lastNamedBuild: number;
  /** Owned pixels waiting to be uploaded, and closed the moment they are. Occupies the registry's decode slot. */
  bitmap: ImageBitmap | null;
  /** The build this url's bitmap resolved on, for {@link SPINE_BITMAP_STALE_BUILDS}. */
  bitmapBuild: number;
  /** A decode for this url is in flight. The slot is held from here until the bitmap is spent or abandoned. */
  decoding: boolean;
  /** The bytes could not be decoded. Falls back to the caller's `<img>` and never asks again. */
  bitmapFailed: boolean;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/** A cap: absent ⇒ the default, anything non-positive or non-finite ⇒ `0`, the documented OFF switch. */
function normalizeCap(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function createSpineSurfaces(options: SpineSurfaceOptions): SpineSurfaceRegistry {
  const cache = options.cache;
  const surfaces = new Map<string, Surface>();
  const paceBytes = normalizeCap(options.paceBytes, SPINE_PACE_BYTES_DEFAULT);
  const paceCount = normalizeCap(options.paceCount, SPINE_PACE_COUNT_DEFAULT);
  const evictAfter = normalizeCap(options.evictAfterBuilds, SPINE_EVICT_AFTER_BUILDS);
  const maxTextureDim =
    options.maxTextureDim != null && Number.isFinite(options.maxTextureDim) && options.maxTextureDim > 0
      ? options.maxTextureDim
      : 0;

  const decodeBlob =
    options.decodeBlob ?? (typeof createImageBitmap === "function" ? (blob: Blob) => createImageBitmap(blob) : null);
  // Owned pixels need a decoder and caller-supplied bytes; either missing uses the `<img>` fallback.
  const canDecodeOwnedPixels = decodeBlob !== null;

  let build = 0;
  let buildUploads = 0;
  let residentCount = 0;
  let residentBytes = 0;
  let disposed = false;
  /** The url whose decode owns the one slot, or null when it is free. See the header's ONE-DECODE rule. */
  let decodeSlot: string | null = null;

  const stats: SpineSurfaceStats = {
    surfaces: 0,
    resident: 0,
    bytes: 0,
    uploads: 0,
    uploadMs: 0,
    maxUploadMs: 0,
    paced: 0,
    refusedForBudget: 0,
    declined: 0,
    evicted: 0,
    paceBytes,
    paceCount,
    decodes: 0,
    decodeFailed: 0,
    decodeStale: 0,
    ownedUploads: 0,
    elementUploads: 0
  };

  function surfaceFor(url: string): Surface {
    let surface = surfaces.get(url);
    if (surface === undefined) {
      surface = {
        url,
        uploaded: false,
        bytes: 0,
        width: 0,
        height: 0,
        declined: false,
        lastNamedBuild: build,
        bitmap: null,
        bitmapBuild: -1,
        decoding: false,
        bitmapFailed: false
      };
      surfaces.set(url, surface);
    }
    return surface;
  }

  /**
   * Give up this url's claim on the decode slot, closing any pixels it is still holding.
   *
   * Called from every exit a decode has — spent, stale, released, invalidated, disposed — because the slot is
   * what bounds transient memory, and a leaked slot would silently turn owned pixels back off for the whole run.
   */
  function freeDecode(surface: Surface): void {
    if (surface.bitmap !== null) {
      surface.bitmap.close();
      surface.bitmap = null;
    }
    surface.decoding = false;
    if (decodeSlot === surface.url) {
      decodeSlot = null;
    }
  }

  /**
   * Start a decode for `surface` if the slot is free and the caller can supply bytes.
   *
   * Deliberately answers nothing: the caller refuses this build either way — with a decode started, or with the
   * slot busy and this still queued behind another creature. Both are "keep the `<img>` for now".
   */
  function requestDecode(surface: Surface, pixels: SpinePixelSource): void {
    if (decodeBlob === null || decodeSlot !== null || surface.bitmapFailed || pixels.bytes === undefined) {
      return;
    }
    let blob: Blob | null = null;
    try {
      blob = pixels.bytes();
    } catch {
      blob = null;
    }
    if (blob === null) {
      // The clip cannot produce bytes (no `Blob` at all, or it threw). That is a property of the SOURCE, so this
      // url stops asking rather than re-running the thunk on every build for the rest of the run.
      surface.bitmapFailed = true;
      stats.decodeFailed++;
      return;
    }
    decodeSlot = surface.url;
    surface.decoding = true;
    stats.decodes++;
    decodeBlob(blob).then(
      (bitmap) => {
        // Everything that could have moved while the decode ran: the registry is gone, the url was released and
        // re-created (so this `surface` is stale), or it already got its pixels some other way. In all three the
        // bitmap is ours to close and nothing else may touch the slot.
        if (disposed || surfaces.get(surface.url) !== surface || surface.uploaded) {
          bitmap.close();
          if (decodeSlot === surface.url) {
            decodeSlot = null;
          }
          surface.decoding = false;
          return;
        }
        surface.decoding = false;
        surface.bitmap = bitmap;
        surface.bitmapBuild = build;
        options.onDecoded?.(surface.url);
      },
      () => {
        // A decode that rejects is undecodable bytes — the `<img>` will not do better, but it is what the node is
        // already painting, so fall back to it permanently rather than re-decoding every build.
        surface.bitmapFailed = true;
        stats.decodeFailed++;
        freeDecode(surface);
      }
    );
  }

  function forgetTexture(surface: Surface): void {
    if (!surface.uploaded) {
      return;
    }
    surface.uploaded = false;
    residentCount--;
    residentBytes -= surface.bytes;
    surface.bytes = 0;
  }

  function releaseTexture(surface: Surface): void {
    cache.release(spineKeyForUrl(surface.url));
    forgetTexture(surface);
    // Also the decode slot: this covers eviction (where the bitmap is already null — it was closed at upload) and
    // the `acquire` catch, where a source the driver refused would otherwise strand its pixels AND the slot.
    freeDecode(surface);
  }

  return {
    acquire(clipUrl, pixels) {
      if (disposed) {
        return false;
      }
      const surface = surfaceFor(clipUrl);
      surface.lastNamedBuild = build;
      if (surface.declined) {
        return false;
      }
      if (surface.uploaded) {
        // Already on the GPU. `peek` rather than a bare true, because a `reset()` after context loss can have
        // dropped the entry underneath us — and a quad pointing at a texture that is gone samples black.
        if (cache.peek(spineKeyForUrl(clipUrl))) {
          return true;
        }
        forgetTexture(surface);
      }
      const width = Math.round(pixels.width);
      const height = Math.round(pixels.height);
      if (!(width > 0 && height > 0)) {
        return false; // nothing decoded yet — no quad, and the node keeps its <img>
      }
      if (maxTextureDim > 0 && (width > maxTextureDim || height > maxTextureDim)) {
        // Refused before the upload: an over-limit `texImage2D` answers INVALID_VALUE and leaves the texture
        // INCOMPLETE, which samples as opaque BLACK — a black rectangle over the creature.
        surface.declined = true;
        stats.declined++;
        return false;
      }
      const bytes = width * height * 4;
      if (paceBytes > 0 && residentBytes + bytes > paceBytes) {
        // The ceiling is on RESIDENCY, so this is not a deferral — it will not fit until something leaves. The
        // node keeps painting through the overlay, which is the whole reason a tight cap is safe here.
        stats.refusedForBudget++;
        return false;
      }
      if (paceCount > 0 && buildUploads >= paceCount) {
        stats.paced++;
        return false;
      }
      // OWNED PIXELS OR NOTHING, while a decode is a live possibility. Both caps are behind us, so this still
      // WOULD upload — which is exactly the point at which spending a decode is justified, and exactly the point
      // at which uploading the evictable `<img>` instead would risk the multi-megabyte inline re-decode the header
      // describes. A refusal here costs one build of the overlay's own painting, which is what it was doing anyway.
      if (canDecodeOwnedPixels && surface.bitmap === null && !surface.bitmapFailed && pixels.bytes !== undefined) {
        requestDecode(surface, pixels);
        return false;
      }
      const source: TexImageSource = surface.bitmap ?? pixels.source;
      const owned = surface.bitmap !== null;
      try {
        const t0 = nowMs();
        cache.acquire(spineKeyForUrl(clipUrl), source);
        const ms = nowMs() - t0;
        // The pixels are on the GPU now, so the JS copy has done its whole job. Closing HERE rather than on some
        // later sweep is what keeps the transient cost at one still (see the header's `close()` rule).
        freeDecode(surface);
        if (owned) {
          stats.ownedUploads++;
        } else {
          stats.elementUploads++;
        }
        surface.uploaded = true;
        surface.bytes = bytes;
        surface.width = width;
        surface.height = height;
        residentCount++;
        residentBytes += bytes;
        buildUploads++;
        stats.uploads++;
        stats.uploadMs += ms;
        if (ms > stats.maxUploadMs) {
          stats.maxUploadMs = ms;
        }
        return true;
      } catch {
        // A tainted or otherwise unuploadable source. Retrying it every build would spend the cap on it forever.
        surface.declined = true;
        stats.declined++;
        releaseTexture(surface);
        return false;
      }
    },

    handleFor(clipUrl) {
      const surface = surfaces.get(clipUrl);
      if (surface === undefined || !surface.uploaded) {
        return null;
      }
      return cache.peek(spineKeyForUrl(clipUrl)) ?? null;
    },

    sizeOf(clipUrl) {
      const surface = surfaces.get(clipUrl);
      if (surface === undefined || !surface.uploaded) {
        return null;
      }
      const live = cache.peek(spineKeyForUrl(clipUrl));
      return live ? { width: live.width, height: live.height } : null;
    },

    endBuild() {
      buildUploads = 0;
      build++;
      // The STALE-BITMAP sweep runs whether or not eviction is on: it bounds transient JS memory and frees the one
      // decode slot, neither of which has anything to do with what the GPU is holding.
      if (decodeSlot !== null) {
        const held = surfaces.get(decodeSlot);
        if (held !== undefined && held.bitmap !== null && build - held.bitmapBuild >= SPINE_BITMAP_STALE_BUILDS) {
          stats.decodeStale++;
          freeDecode(held);
        }
      }
      if (evictAfter <= 0) {
        return;
      }
      for (const surface of surfaces.values()) {
        if (surface.uploaded && build - surface.lastNamedBuild >= evictAfter) {
          releaseTexture(surface);
          stats.evicted++;
        }
      }
    },

    release(clipUrl) {
      const surface = surfaces.get(clipUrl);
      if (surface === undefined) {
        return;
      }
      releaseTexture(surface);
      surfaces.delete(clipUrl);
    },

    invalidate() {
      // CONTEXT LOSS. gsw's `cache.reset()` has already forgotten every texture, so this must not call `release`
      // — it would decrement a refcount on an entry that is gone, and touch a dead driver. A `declined` verdict
      // is kept: it was a property of the SOURCE, not of the lost context.
      for (const surface of surfaces.values()) {
        forgetTexture(surface);
      }
      residentCount = 0;
      residentBytes = 0;
    },

    stats() {
      stats.surfaces = surfaces.size;
      stats.resident = residentCount;
      stats.bytes = residentBytes;
      return { ...stats };
    },

    dispose() {
      // Deliberately no `cache.release`: the stage owns the cache and disposes it, and after a context loss the
      // driver is gone — the bridge and `fxSurfaces` both take this line.
      disposed = true;
      for (const surface of surfaces.values()) {
        freeDecode(surface); // owned pixels are OURS — the cache never saw them, so nothing else will close them
      }
      surfaces.clear();
      decodeSlot = null;
      residentCount = 0;
      residentBytes = 0;
      buildUploads = 0;
    }
  };
}
