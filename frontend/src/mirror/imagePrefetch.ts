// IDLE ATLAS PREFETCH — decode the pages a session is going to need anyway, one at a time, before it needs them.
//
// WHAT THIS DOES NOT CHANGE. Every page in the list below is one `getAtlas` call away for any session that shows a
// card, a relic, a potion or an enemy intent: the demand path (drawAtlasRegion / atlasRegionBlobUrl / the hidden-
// subtree `preloadAtlas`) already fetches and decodes each of them exactly once. So this file changes WHEN the
// decode happens, never HOW MUCH decoding happens — a page is loaded once per session either way, `getAtlas` is
// idempotent, and a page the demand path grabbed first is a plain map hit here.
//
// WHY IT MATTERS ANYWAY. The mirror's atlas placeholder is chosen by whether the page is DECODED yet
// (mirrorRenderer's `placeholderMechanism` asks `atlasPageSize`), and the first card draw of a run is exactly the
// moment a cold ~16 MP card atlas is asked for — the worst possible time to pay for it. Doing it while the client
// is sitting on the join/lobby screen moves that cost off the frame budget of the first thing the player sees.
//
// WHY THE ORDER IS THIS ORDER. Strictly most-certain-to-be-needed first, so a session that is interrupted (or a
// truncated list, `?atlasPrefetch=<n>`) still got the pages it was most likely to use:
//   1. ui_atlas_0/1 + compressed_0 — the chrome. Every screen paints out of them, and they are small enough to
//      keep the page-crop placeholder, so warming them helps the placeholder path itself.
//   2. card_atlas_0/1/2 — the hand. The biggest pages in the game and the ones the size gate refuses to page-crop,
//      so a card sprite's synchronous placeholder needs their decoded bitmap to exist.
//   3. relic / potion / intent / power, then the two outline pages — real, but later in a run and rarer per screen.
//
// WHY IT IS STRICTLY SEQUENTIAL. One page in flight at a time, each step scheduled from the previous page's
// settle. The prefetch runs during connect/join, when the socket is pulling the scene stream and the bake pool is
// spinning up; firing a dozen multi-megabyte fetches at once would contend for the same bandwidth and the same
// decode threads as the work the player is actually waiting on. Sequential also means the queue degrades
// gracefully: whatever idle time exists is spent in priority order rather than spread thin across everything.
//
// WHY THE WORKER PAGES ARE NOT WARMED. The bake pool's workers hold their OWN copies of a page (atlasBakePool's
// residency budget is 48–128MB across the pool) while this list is ~247MB of RGBA. Pre-decoding it into the pool
// would evict, per page, whatever regions the pool was actually asked for — a guaranteed LRU thrash in exchange
// for speculation. The pool decodes a page when a region of it is baked, and not before.
import { atlasPageSize, preloadAtlas, whenAtlasSettled } from "@/mirror/atlasBaker";
import { mirrorResourceUrl } from "@/mirror/sceneTree";
import { warmImage } from "@/mirror/textureCache";

const PREFETCH_ATLASES = [
  "res://images/atlases/ui_atlas_0.png",
  "res://images/atlases/ui_atlas_1.png",
  "res://images/atlases/compressed_0.png",
  "res://images/atlases/card_atlas_0.png",
  "res://images/atlases/card_atlas_1.png",
  "res://images/atlases/card_atlas_2.png",
  "res://images/atlases/relic_atlas.png",
  "res://images/atlases/potion_atlas.png",
  "res://images/atlases/intent_atlas.png",
  "res://images/atlases/power_atlas.png",
  "res://images/atlases/relic_outline_atlas.png",
  "res://images/atlases/potion_outline_atlas.png"
] as const;

// Not atlases: the targeting arrow is assembled from two whole images, so it warms through the ordinary texture
// cache (one Image per url, no region cropping). Warmed as the chain's LAST step — same priority argument.
const PREFETCH_IMAGES = [
  "res://images/ui/combat/targeting_arrow_head.png",
  "res://images/ui/combat/targeting_arrow_segment.png"
] as const;

/** The idle deadline: a browser that never goes idle still runs the step within this long. */
const IDLE_TIMEOUT_MS = 2_000;
/** Safari has no requestIdleCallback. A short timer is the honest stand-in — late enough not to race connect. */
const FALLBACK_DELAY_MS = 50;

/** `window.__mirrorImagePrefetch` — what the chain planned, how far it got, and what it cost. */
export interface MirrorImagePrefetchStats {
  /** The atlas urls this chain will walk, in order (already truncated by `?atlasPrefetch=<n>`). */
  list: string[];
  /** How many of them have been DISPATCHED (0…list.length) — `index === list.length` means the walk finished. */
  index: number;
  /** Pages this chain asked `preloadAtlas` for, pages that settled, and pages that settled with NO pixels. */
  started: number;
  settled: number;
  failed: number;
  /** …of those, the ones already settled when we got to them: the demand path (or a re-run) beat us to it. */
  skipped: number;
  /** Wall from the `prefetchMirrorImages()` call to the last step, idle waiting included (that IS the latency). */
  ms: number;
  /**
   * DECODED BYTES this chain is holding alive, `width * height * 4` summed over the atlases that settled with
   * pixels. Published because the cost was an ESTIMATE for a whole round and estimates do not survive contact
   * with a device.
   *
   * WHAT IT IS: `atlasBaker` decodes each atlas once into an `ImageBitmap` held in a module-scope Map that is
   * never evicted, so this is a resident figure for the life of the page, not a transient. Measured against it
   * on the host (peak renderer VmRSS, `?atlasPrefetch=off` vs default, three pairs plus a standalone ABBA
   * probe): 222-292 MB. RGBA8 is the right multiplier for a decoded bitmap whatever the source PNG's channel
   * count, so this is the pixel cost, not the download.
   *
   * WHAT IT IS NOT: an amount that would be RECLAIMED by turning the prefetch off. The canvas stage never reads
   * `atlasBaker` at all (the texture bridge keeps its own images), but the DOM stage does, and on either stage
   * a page the demand path would have fetched later still gets decoded — later, and off the HTTP cache the
   * prefetch warmed. Measured cost of not warming it: the combat replay's last texture upload lands a median
   * 1501 ms later. That trade is why this is a counter and not a default change.
   */
  decodedBytes: number;
  /** Atlases counted into `decodedBytes` (settled WITH pixels), so the byte figure has a denominator. */
  decodedPages: number;
}

const stats: MirrorImagePrefetchStats = {
  list: [],
  index: 0,
  started: 0,
  settled: 0,
  failed: 0,
  skipped: 0,
  ms: 0,
  decodedBytes: 0,
  decodedPages: 0
};

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__mirrorImagePrefetch = stats;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Test override for the query param (undefined = read the real URL). */
let prefetchParamOverride: string | null | undefined;

// `?atlasPrefetch=off` skips the whole chain; `?atlasPrefetch=<n>` walks only the first n atlases (0 = none, but
// the arrows still warm). Same shape as atlasBakePool's readWorkerCountParam — junk keeps the shipped default,
// and 0 is a MEANINGFUL value rather than a half-disabled feature. Read per call, not at module load, so the test
// seam works and a second mirror view sees the current URL.
function readPrefetchParam(): string | null {
  if (prefetchParamOverride !== undefined) {
    return prefetchParamOverride;
  }
  return null;
}

/** The atlas urls to walk, or null for "prefetch nothing at all" (`?atlasPrefetch=off`). */
function plannedAtlases(): string[] | null {
  const raw = readPrefetchParam();
  if (raw === "off" || raw === "false") {
    return null;
  }
  let limit: number = PREFETCH_ATLASES.length;
  if (raw !== null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      limit = Math.min(limit, Math.floor(n));
    }
  }
  return PREFETCH_ATLASES.slice(0, limit).map((path) => mirrorResourceUrl(path));
}

/**
 * Run `step` on the next idle slot. NOTHING here is synchronous — the very first step of the chain goes through
 * this too, so `prefetchMirrorImages()` itself never touches the network on the caller's task. A host with
 * neither scheduler (an SSR shell) simply never prefetches, which is correct: the whole mechanism is speculative.
 */
function schedule(step: () => void): void {
  const w =
    typeof window !== "undefined"
      ? (window as unknown as { requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => unknown })
      : null;
  if (w && typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(step, { timeout: IDLE_TIMEOUT_MS });
    return;
  }
  if (typeof setTimeout === "function") {
    setTimeout(step, FALLBACK_DELAY_MS);
  }
}

export function prefetchMirrorImages(): void {
  const planned = plannedAtlases();
  stats.list = planned ?? [];
  if (planned === null) {
    return;
  }
  const startedAt = now();
  let at = 0;
  const step = (): void => {
    if (at >= planned.length) {
      for (const path of PREFETCH_IMAGES) {
        warmImage(mirrorResourceUrl(path));
      }
      stats.ms = now() - startedAt;
      return;
    }
    const url = planned[at++];
    stats.index = at;
    stats.started += 1;
    preloadAtlas(url);
    // ONE IN FLIGHT: the next step is scheduled from THIS page's settle, never before it. A page that had already
    // settled (the demand path got there first, or a host with no `Image` at all) calls back synchronously — hence
    // `schedule` rather than a direct `step()`: a fully-cached list must not recurse twelve frames deep.
    let sync = true;
    whenAtlasSettled(url, () => {
      stats.settled += 1;
      if (sync) {
        stats.skipped += 1;
      }
      const size = atlasPageSize(url);
      if (size === null) {
        stats.failed += 1; // a dead page (404/decode failure) advances the chain like any other — it never stalls it
      } else {
        // Only pages that decoded are counted: a 404 costs a request, not 67MB of pixels.
        stats.decodedBytes += size.width * size.height * 4;
        stats.decodedPages += 1;
      }
      schedule(step);
    });
    sync = false;
  };
  schedule(step);
}

/** TEST-ONLY: pin `?atlasPrefetch` without a URL (undefined restores reading the real one). */
export function __setAtlasPrefetchParamForTest(value: string | null | undefined): void {
  prefetchParamOverride = value;
}

/** TEST-ONLY: zero the published counters so one spec's chain cannot be read by the next. */
export function __resetImagePrefetchStatsForTest(): void {
  stats.list = [];
  stats.index = 0;
  stats.started = 0;
  stats.settled = 0;
  stats.failed = 0;
  stats.skipped = 0;
  stats.ms = 0;
  stats.decodedBytes = 0;
  stats.decodedPages = 0;
}
