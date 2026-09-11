// Live-tree MIRROR Spine-animation CLIP client. The host streams a rendered clip as one binary blob from
// `GET /spines/<scene>?node=&anim=` (see SpineClipWire.cs): a small header + length-prefixed, per-frame-tight
// PNG frames, each carrying its placement (offset within a shared canvas). This module fetches + parses +
// decodes that blob, caches the decoded clip by URL, and exposes "the frame to show at playback time t" so the
// reconciler can drive a SpineSprite's animation off the live track-time signal.
//
// Self-contained per the mirror decoupling rule (no @/protocol/* or @/presentation/*). The PARSE + frame-lookup
// are pure (unit-tested); only loadSpineClip touches the DOM (fetch + Image decode + object URLs).

// SpineClipWire v1 layout (little-endian) — keep in lockstep with SpineClipWire.cs:
//   Header (40 bytes): magic "SPCL"(4) | version u8 | flags u8 | reserved u16 | frameCount u32 |
//                      canvasWidth u32 | canvasHeight u32 | totalDurationMs u32 |
//                      localX f32 | localY f32 | localWidth f32 | localHeight f32
//     localX/Y/W/H = the node-LOCAL rect the canvas covers (a SpineSprite has no localRect, so the
//     reconciler draws this rect under the node's transform to align the clip).
//   Per frame (28-byte header + png): index u32 | offsetX i32 | offsetY i32 | width u32 | height u32 |
//                      durationMs u32 | pngLength u32 | png[pngLength]
const MAGIC = 0x4c435053; // "SPCL" read as a little-endian u32 (0x53 'S',0x50 'P',0x43 'C',0x4c 'L')
const SUPPORTED_VERSION = 1;
const HEADER_SIZE = 40;
const FRAME_HEADER_SIZE = 28;

export interface SpineClipFrame {
  index: number;
  // Placement of this (tight-cropped) frame within the clip's shared canvas, in canvas pixels.
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  durationMs: number;
  // Cumulative start time (ms) of this frame within the clip — frame i covers [startMs, startMs+durationMs).
  startMs: number;
  // Raw PNG bytes (kept for the pure parse; loadSpineClip turns these into a decoded image + object URL).
  png: Uint8Array;
}

// The node-LOCAL rect the shared canvas covers, in the SpineSprite's local coordinates. The reconciler draws
// the canvas at this rect and then applies the node's transform, so the clip lands where the skeleton would.
export interface SpineClipPlacement {
  localX: number;
  localY: number;
  localWidth: number;
  localHeight: number;
}

export interface ParsedSpineClip extends SpineClipPlacement {
  canvasWidth: number;
  canvasHeight: number;
  totalDurationMs: number;
  frames: SpineClipFrame[];
}

// A decoded, ready-to-paint clip frame: a pre-decoded image source the renderer blits with ctx.drawImage.
// An ImageBitmap holds DECODED pixels, so drawImage never re-decodes (no per-frame decode → no flicker — the
// reason we paint to a <canvas> instead of swapping a CSS background-image). HTMLImageElement is the fallback
// when createImageBitmap is unavailable; null only in a DOM-less context (tests use the pure parse path).
export interface DecodedSpineClipFrame extends SpineClipFrame {
  bitmap: ImageBitmap | HTMLImageElement | null;
}

export interface LoadedSpineClip extends SpineClipPlacement {
  canvasWidth: number;
  canvasHeight: number;
  totalDurationMs: number;
  frames: DecodedSpineClipFrame[];
  // Object URL of the sole frame of a single-frame (still) clip — null for a multi-frame clip and
  // wherever object URLs are unavailable. A still never advances, so the renderer paints it with an <img> instead
  // of a <canvas> (a canvas is an unconditional composited layer; an <img> is not). Revoked with the clip's other
  // urls once it is BOTH evicted and unreferenced, so it is exactly as safe as the frame bitmaps beside it.
  stillUrl: string | null;
  // The host can answer with a single-frame stand-in (X-Spine-Degraded) when the machine is oversubscribed,
  // rather than baking the clip we asked for. The renderer paints it, must not retry it as an animated clip,
  // and drops its cache entry so a later request for the same identity gets the real bake.
  degraded: boolean;
  // `dispose()` is the cache's "I no longer index this clip" — it is not a free. An LRU eviction
  // used to close() the clip's ImageBitmaps outright, but a decoded clip outlives its cache entry: the reconciler
  // holds the one it is currently painting in `record.spineClip`, so evicting a still-playing clip closed bitmaps
  // out from under it and every later drawImage threw InvalidStateError — the spine went (and stayed) blank, with
  // still-first doubling the entries that fit in the 24-clip cache. The renderer therefore retain()s the clip it
  // paints and release()s it when it swaps/tears down, and the real close happens only once the clip is BOTH
  // evicted and unreferenced. Retain/release are idempotent-safe (release never drops below zero).
  retain(): void;
  release(): void;
  dispose(): void;
}

// Parse a SpineClipWire blob into its frames + metadata. Pure (no DOM): the reconciler-facing loadSpineClip
// decodes the PNG bytes on top of this. Throws on a malformed / truncated / wrong-version stream.
export function parseSpineClip(buffer: ArrayBuffer | Uint8Array): ParsedSpineClip {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < HEADER_SIZE || view.getUint32(0, true) !== MAGIC) {
    throw new Error("spine clip: missing SPCL header");
  }
  const version = view.getUint8(4);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(`spine clip: unsupported version ${version}`);
  }

  const frameCount = view.getUint32(8, true);
  const canvasWidth = view.getUint32(12, true);
  const canvasHeight = view.getUint32(16, true);
  const totalDurationMs = view.getUint32(20, true);
  const localX = view.getFloat32(24, true);
  const localY = view.getFloat32(28, true);
  const localWidth = view.getFloat32(32, true);
  const localHeight = view.getFloat32(36, true);

  const frames: SpineClipFrame[] = [];
  let offset = HEADER_SIZE;
  let startMs = 0;
  for (let i = 0; i < frameCount; i += 1) {
    if (offset + FRAME_HEADER_SIZE > bytes.byteLength) {
      throw new Error("spine clip: truncated frame header");
    }
    const index = view.getUint32(offset, true);
    const offsetX = view.getInt32(offset + 4, true);
    const offsetY = view.getInt32(offset + 8, true);
    const width = view.getUint32(offset + 12, true);
    const height = view.getUint32(offset + 16, true);
    const durationMs = view.getUint32(offset + 20, true);
    const pngLength = view.getUint32(offset + 24, true);
    offset += FRAME_HEADER_SIZE;
    if (offset + pngLength > bytes.byteLength) {
      throw new Error("spine clip: truncated frame payload");
    }
    frames.push({
      index,
      offsetX,
      offsetY,
      width,
      height,
      durationMs,
      startMs,
      png: bytes.subarray(offset, offset + pngLength)
    });
    offset += pngLength;
    startMs += durationMs;
  }

  return { canvasWidth, canvasHeight, totalDurationMs, localX, localY, localWidth, localHeight, frames };
}

// The index of the frame to show at playback time `timeMs`. When `loop` (default), wraps at the final frame's
// start time; when false, CLAMPS past the end so a one-shot anim (attack/cast/hurt/die) holds its LAST frame instead
// of replaying forever (the flicker). Returns 0 for an empty/zero-duration clip. Pure — the reconciler computes
// the time from the live track-time signal + the producer's loop flag.
//
// Bakes include an endpoint sample, so looping wraps before that sample while a clamped one-shot can display it.
// A malformed clip with no usable final start falls back to its wire duration, then to a non-zero sentinel.
export function frameIndexAt(
  clip: { frames: SpineClipFrame[]; totalDurationMs: number },
  timeMs: number,
  loop = true
): number {
  const frames = clip.frames;
  if (frames.length <= 1) {
    return 0;
  }
  const lastStartMs = frames[frames.length - 1].startMs;
  let t: number;
  if (loop) {
    // Negative times (clock skew) wrap positive. frames.length >= 2 here.
    const period = lastStartMs > 0 ? lastStartMs : clip.totalDurationMs > 0 ? clip.totalDurationMs : lastStartMs + 1;
    t = timeMs % period;
    if (t < 0) {
      t += period;
    }
  } else {
    // Freeze at the end: clamp into [0, total) so the binary search lands on the final frame and stays there.
    const total = clip.totalDurationMs > 0 ? clip.totalDurationMs : lastStartMs + 1;
    t = Math.max(0, Math.min(timeMs, total - 1));
  }
  // frames are ascending by startMs; find the last frame whose startMs <= t (binary search).
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].startMs <= t) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

// MS UNTIL `frameIndexAt` WOULD ANSWER A DIFFERENT FRAME, or `Infinity` when it never will again. Pure, and the
// exact twin of the function above — same period and clamp — because a scheduler that slept
// on a different clock from the one the painter reads would show a frame late (or wake for one that has not moved).
//
// M3: this is what turns a spine clip from a BOOLEAN demand source into a real deadline. The canvas stage used to
// ask only "is anything playing?" and then repaint at the display's rate, so a 15 fps bake was sampled at 60 Hz —
// three wakeups in four painting the same pixels. Two cases answer Infinity, and both are the point:
//
//   * A STILL (frames.length <= 1). It has no next frame at any time, which is the product default for every
//     non-dev device — `overlay`'s playing set already excludes them, and this agrees rather than relying on that.
//   * A CLAMPED ONE-SHOT that has run out (`loop === false`, past the last frame). An attack that has landed holds
//     its final pose forever; asking for frames it will never show is what kept the stage awake after every swing.
export function msToNextSpineFrame(
  clip: { frames: SpineClipFrame[]; totalDurationMs: number },
  timeMs: number,
  loop = true
): number {
  const frames = clip.frames;
  if (frames.length <= 1) {
    return Number.POSITIVE_INFINITY;
  }
  const lastStartMs = frames[frames.length - 1].startMs;
  const index = frameIndexAt(clip, timeMs, loop);
  if (loop) {
    // The wrap back to frame 0 is a frame boundary, so the final reachable frame's deadline is the period itself.
    const period = lastStartMs > 0 ? lastStartMs : clip.totalDurationMs > 0 ? clip.totalDurationMs : lastStartMs + 1;
    let t = timeMs % period;
    if (t < 0) {
      t += period;
    }
    const nextStart = index + 1 < frames.length ? frames[index + 1].startMs : period;
    const boundary = nextStart < period ? nextStart : period;
    return boundary - t;
  }
  // CLAMPED: `frameIndexAt` pins `t` into [0, total) and stays on the last frame from there on.
  if (index >= frames.length - 1) {
    return Number.POSITIVE_INFINITY;
  }
  const total = clip.totalDurationMs > 0 ? clip.totalDurationMs : lastStartMs + 1;
  if (timeMs >= total - 1) {
    return Number.POSITIVE_INFINITY; // the clamp has taken over; the index cannot move again
  }
  return frames[index + 1].startMs - Math.max(0, timeMs);
}

// ---- Browser-side load + decode + cache --------------------------------------------------------------------

// Sniff a frame's image MIME from its magic bytes so the Blob carries the correct type regardless of the
// server-side codec policy (the wire is codec-agnostic — see SpineClipWire). webp = "RIFF"…"WEBP"; otherwise
// PNG. Keeps the reader unchanged when the host flips PNG↔webp.
//
// Exported because the ENCODED bytes outlive the decode: `spineSurfaces` re-reads a still's `frames[0].png` to
// mint owned pixels for a GL upload, and a Blob with the wrong type will not decode at all.
export function imageMime(bytes: Uint8Array): string {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) {
    return "image/webp";
  }
  return "image/png";
}

// `stillImg` = "if this comes back as a single frame I will paint it with an <img> off `stillUrl`" (the renderer's
// default still path). For that caller an ImageBitmap is pure dead weight: nothing ever blits it, yet it holds the
// frame's full RGBA — 0.4-8.6MB per still at STS2's frame sizes, against ~50-300KB of encoded bytes. A caller that
// leaves it unset, or a build has no object-URL support, still gets fully-decoded frames.
export interface LoadSpineClipOptions {
  stillImg?: boolean;
}

// Decode every frame to a pre-decoded image source the renderer blits via ctx.drawImage. Prefer
// createImageBitmap (decoded pixels, GPU-uploadable, drawImage never re-decodes) — the same approach as
// atlasBaker — falling back to a fully-decoded <img>. Awaiting ALL frames here means playback never decodes
// mid-flight, so frames never pop in blank (the flicker). No-op-safe without a DOM (frames carry null bitmaps;
// tests use the pure parse path or mock loadSpineClip).
async function decodeClip(parsed: ParsedSpineClip, degraded = false, stillImg = false): Promise<LoadedSpineClip> {
  const bitmaps: ImageBitmap[] = [];
  const urls: string[] = [];
  const hasBlob = typeof Blob !== "undefined";
  const canBitmap = typeof createImageBitmap === "function" && hasBlob;
  const canUrl = typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && hasBlob;
  // The <img>-painted still (above): keep the ENCODED bytes (as the object URL minted below) and skip the pixels.
  // `canUrl` is load-bearing — without an object URL there is no <img> to paint, so the clip must keep its bitmap
  // or it would have nothing to draw at all.
  const bytesOnlyStill = stillImg && canUrl && parsed.frames.length === 1;

  const frames: DecodedSpineClipFrame[] = await Promise.all(
    parsed.frames.map(async (frame): Promise<DecodedSpineClipFrame> => {
      // Copy out of the shared buffer subarray so the Blob owns its bytes.
      let bitmap: ImageBitmap | HTMLImageElement | null = null;
      if (bytesOnlyStill) {
        return { ...frame, bitmap };
      }
      if (canBitmap) {
        try {
          const bmp = await createImageBitmap(new Blob([frame.png.slice()], { type: imageMime(frame.png) }));
          bitmaps.push(bmp);
          bitmap = bmp;
        } catch {
          // Fall through to the <img> decode below.
        }
      }
      if (bitmap === null && canUrl && typeof Image !== "undefined") {
        const url = URL.createObjectURL(new Blob([frame.png.slice()], { type: imageMime(frame.png) }));
        urls.push(url);
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        try {
          await img.decode?.(); // ensure it's painted-ready so the first drawImage doesn't blit blank
        } catch {
          // decode() can reject in some environments; drawImage still works once the <img> loads.
        }
        bitmap = img;
      }
      return { ...frame, bitmap };
    })
  );

  // A single-frame clip also gets an object URL for that frame, so the renderer can paint it with
  // an <img> (no composited layer) instead of a canvas. Registered in `urls` → revoked with everything else. Only
  // for a still: a multi-frame clip is blitted per frame and gains nothing from a url, so this is at most one extra
  // small Blob per single-frame clip (and the <img> decode fallback's own url, if it took that path, is separate).
  let stillUrl: string | null = null;
  if (frames.length === 1 && canUrl) {
    const only = frames[0];
    stillUrl = URL.createObjectURL(new Blob([only.png.slice()], { type: imageMime(only.png) }));
    urls.push(stillUrl);
  }

  let refs = 0;
  let evicted = false;
  let closed = false;
  const closeIfUnused = (): void => {
    if (closed || !evicted || refs > 0) {
      return;
    }
    closed = true;
    for (const bmp of bitmaps) {
      bmp.close();
    }
    if (canUrl) {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
    }
  };

  return {
    canvasWidth: parsed.canvasWidth,
    canvasHeight: parsed.canvasHeight,
    totalDurationMs: parsed.totalDurationMs,
    localX: parsed.localX,
    localY: parsed.localY,
    localWidth: parsed.localWidth,
    localHeight: parsed.localHeight,
    frames,
    stillUrl,
    degraded,
    retain() {
      refs += 1;
    },
    release() {
      if (refs > 0) {
        refs -= 1;
      }
      closeIfUnused();
    },
    dispose() {
      evicted = true;
      closeIfUnused();
    }
  };
}

type CacheEntry = { promise: Promise<LoadedSpineClip>; loaded: LoadedSpineClip | null };

// LRU-bounded decoded-clip cache keyed by /spines/ URL. A clip's frames are static per (scene, node, anim)
// within a game/mod version (the host also caches the bytes), so once fetched + decoded a clip is reused
// across every node + tick that plays it. Eviction hands the clip back (dispose()); its bitmaps are only really
// closed once nothing is still painting it (see LoadedSpineClip.retain/release).
//
// The bound is per DECODED clip, and the still-first chain puts TWO entries (the `&still=1` placeholder and
// the animated clip) in the cache for every playing spine node, so 24 covers ~12 concurrently-playing spines
// before the LRU starts turning over — comfortably above a busy combat screen, but the refcount above is what
// makes exceeding it merely wasteful instead of visually fatal.
const MAX_CACHED_CLIPS = 24;

// A `bytesOnlyStill` (above) holds only its encoded frame bytes, so a
// still costs ~50-300KB against a decoded clip's megabytes: bounding the two together made a busy combat evict
// stills that cost almost nothing to keep, and an A→B→A animation flip (idle → attack → idle, the STS2 combat
// loop) then re-fetched + re-baked a frame the client had held minutes earlier. 64 keeps every creature's whole
// animation set warm for a fight (~3-19MB worst case) while the expensive multi-frame clips stay on the tight 24.
const MAX_CACHED_STILLS = 64;
const cache = new Map<string, CacheEntry>();

export function loadSpineClip(url: string, opts?: LoadSpineClipOptions): Promise<LoadedSpineClip> {
  const existing = cache.get(url);
  if (existing) {
    // LRU touch: re-insert to mark most-recently-used.
    cache.delete(url);
    cache.set(url, existing);
    return existing.promise;
  }

  const promise = fetchAndDecode(url, opts?.stillImg === true);
  const entry: CacheEntry = { promise, loaded: null };
  cache.set(url, entry);
  promise.then(
    (loaded) => {
      entry.loaded = loaded;
    },
    () => {
      // A failed load shouldn't poison the cache — drop it so a later request can retry.
      if (cache.get(url) === entry) {
        cache.delete(url);
      }
    }
  );
  evictIfNeeded();
  return promise;
}

async function fetchAndDecode(url: string, stillImg: boolean): Promise<LoadedSpineClip> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`spine clip fetch failed: ${response.status} ${url}`);
  }
  // The host marks a degraded (single-frame stand-in) response with X-Spine-Degraded and serves it no-store,
  // so the same url returns the real clip once the machine recovers. `headers` is optional-chained because the
  // renderer's specs (and any Response stub) may not provide it.
  const degradedHeader = response.headers?.get?.("X-Spine-Degraded") ?? null;
  const degraded = degradedHeader !== null && degradedHeader !== "" && degradedHeader !== "0";
  const buffer = await response.arrayBuffer();
  return await decodeClip(parseSpineClip(buffer), degraded, stillImg);
}

// Which POOL an entry belongs to. A clip that kept its decoded pixels — every multi-frame clip, plus any 1-frame
// clip the caller will paint through the canvas — is EXPENSIVE and rides the 24 bound; only an entry that is
// provably encoded-bytes-only (resolved, single frame, has an object URL, carries no bitmap) rides the 64.
// Deriving it from the loaded clip (rather than from the request) means an UNRESOLVED entry counts as expensive,
// which is the conservative direction.
function isBytesOnlyStill(entry: CacheEntry): boolean {
  const loaded = entry.loaded;
  return loaded !== null && loaded.stillUrl !== null && loaded.frames.length === 1 && loaded.frames[0].bitmap === null;
}

function evictOldest(match: (entry: CacheEntry) => boolean, count: number): void {
  let remaining = count;
  // Oldest insertion order = least-recently-used (Map preserves insertion order; we re-insert on touch).
  // Deleting during iteration is safe: a deleted entry is simply not revisited.
  for (const [key, entry] of cache) {
    if (remaining <= 0) {
      return;
    }
    if (!match(entry)) {
      continue;
    }
    cache.delete(key);
    entry.loaded?.dispose();
    remaining -= 1;
  }
}

function evictIfNeeded(): void {
  let stills = 0;
  let clips = 0;
  for (const entry of cache.values()) {
    if (isBytesOnlyStill(entry)) {
      stills += 1;
    } else {
      clips += 1;
    }
  }
  if (clips > MAX_CACHED_CLIPS) {
    evictOldest((entry) => !isBytesOnlyStill(entry), clips - MAX_CACHED_CLIPS);
  }
  if (stills > MAX_CACHED_STILLS) {
    evictOldest(isBytesOnlyStill, stills - MAX_CACHED_STILLS);
  }
}

// Drop a single url from the decoded-clip cache (revoking its object URLs if already loaded). After a non-still
// clip comes back with a single frame, drop the stale entry so the
// re-request (with &retry=1, a distinct url that also bypasses the immutable HTTP cache) fetches a fresh render.
export function dropSpineClipCacheEntry(url: string): void {
  const entry = cache.get(url);
  if (entry) {
    cache.delete(url);
    entry.loaded?.dispose();
  }
}

// TEST-ONLY: clear the clip cache (revoking object URLs) so a test starts clean.
export function __clearSpineClipCacheForTest(): void {
  for (const entry of cache.values()) {
    entry.loaded?.dispose();
  }
  cache.clear();
}
