// The atlas region baker's WORKER ENTRY — one region in, one PNG blob out, off the main thread. (Also one N-cell
// STRIP in, one PNG blob out; same page handling, same response, same timing split — see STRIPS below.)
//
// WHY (measured, Aug-13 moto g86, real recorded combat over a real WebSocket, own tab, hiddenSamples: 0):
//   {"baked":24,"slow":9,"slowestMs":2962.3,"totalMs":4502.6,"syncTotalMs":385.3,"slowestSyncMs":93.6,
//    "disabled":true,"trips":3,"rearms":2,"requeued":85,"parked":41}
// 4,502.6ms of bake WALL against 385.3ms of main thread: 91.4% of a bake's life is not main-thread time. A
// bake-probe on the same phone then measured PNG encode at ~36ms/region on an IDLE page vs ~188ms/region on a
// BUSY one, with the main-thread share essentially unchanged (~20ms vs ~16ms). The encode did not get more
// expensive — THE WAIT DID: `convertToBlob` runs its PNG encode as an idle task, and a busy combat main thread
// starves idle callbacks even with the tab fully visible. So the fix is to run the encode somewhere that is not
// the busy thread, and the queue that stranded 41 regions on the canvas path disappears with it.
//
// SHAPE: **THE WORKER OWNS THE ATLAS.** It `fetch`es and decodes the atlas page itself, so a per-region job is
// `{key, url, region}` in and `{key, blob}` out — the main thread never pays a GPU→CPU readback, never touches a
// canvas, and never holds a job's pixels. This is the perf-harness's `worker-imagedata` arm (gsw
// `packages/perf-harness/probes/bake-probe.html`), the one that won even at FAN-OUT 1 (709ms vs 1,238ms inline)
// precisely because it removes the readback rather than just moving the codec. The `worker-webp` arm — transfer
// one `ImageBitmap` per region from the main thread — LOST at fan-out 1 and is deliberately not used.
// `Blob` structured-clones BY REFERENCE, so the return trip is not a copy either.
//
// RESIDENCY: the page is held as raw RGBA `ImageData`, i.e. exactly `width × height × 4` bytes, and every crop is
// a row-wise `subarray` copy into a small `ImageData` + `putImageData` + `convertToBlob`. No GPU surface is
// involved in a job at all, which matters because GPU-process contention is the pathology the baker's own
// self-disable exists to guard against — a worker that fought the compositor for the GPU would just move the
// problem. Measured page sizes in this game (RGBA bytes = w×h×4):
//     card_atlas_0 4032×4072 = 62.6MB   card_atlas_1 4032×4032 = 62.0MB   card_atlas_2 3528×3080 = 41.5MB
//     ui_atlas_0/1 2048×2048 = 16.0MB   compressed_0 1936×2020 = 14.9MB   relic_atlas  4096×680  = 10.6MB
// That is large enough that residency has to be BOUNDED, not assumed: a worker evicts least-recently-used pages
// past `keepBytes` (always keeping the newest one, or it could never make progress), and reports what it holds
// after every change so the pool can decide whether a SECOND copy of a page is affordable. See atlasBakePool.ts.
//
// DROPPING A FINISHED OVERSIZED PAGE (Aug-14 follow-up)
// That LRU has a floor — it always keeps ONE page, or a worker could evict the very page the job in its hand is
// cropping from — and the floor is UNBOUNDED when a page alone is bigger than `keepBytes`: a worker that baked a
// single card_atlas region then sits on 62.6MB indefinitely, whatever the pool's budget says. So a page bigger
// than this worker's whole share is ARMED to be dropped when the pool says nothing else is queued for it
// (`keepPage: false` on the bake), and is actually dropped `DROP_IDLE_MS` later if nothing used it in between.
// A drop is reported (`release`), never silently, so the pool's residency stays the workers' own truth.
//
// WHY A DELAY RATHER THAN A DROP TAKEN STRAIGHT AFTER THE CROP. `keepPage` is a much weaker signal than it looks.
// The baker's drain (atlasBaker.ts) issues ONE bake per task and only refills a slot when a bake SETTLES, so the
// pool's queue is usually EMPTY at the moment it hands a worker a job — at `poolSize` 1 it is empty by
// construction, since the drain's concurrency IS the pool size. A drop taken at the crop would therefore fire on
// nearly every region of an oversized page and pay ~590ms to re-decode it for the next one: worst case, one full
// page decode PER REGION. That is not a worry, it is a measurement — the last spec in atlasBakeWorkers.spec.ts
// drives the real baker through the real pool into this module, and the crop-time drop turns 8 page loads into
// 56 (~33s of worker time at 590ms each) on a 56-region workload. The idle window is what makes the drop safe —
// a page is only let go once demand for it has stopped for `dropIdleMs`, which at the 2s default is ~125x the
// baker's 16ms inter-bake yield, so main-thread jank inside a burst cannot look like the end of demand.
//
// AND WHY THE DROP IS OFF ON MOST DEVICES (Aug-19). What the delay still leaves is one re-decode per DEMAND GAP —
// a new hand of cards, a screen change — and a gap is not an exception in this game, it is the rhythm of a turn.
// Every gap cost ~590ms of worker time per oversized page to buy back 62.6MB that nothing else was asking for.
// So the policy is now DECODE-AT-MOST-ONCE-PER-WINDOW, tiered by `navigator.deviceMemory` and configured by the
// pool (see `resolveAtlasPageDrop` in atlasBakePool.ts):
//   * 4GB+ (and an ABSENT reading, which the pool has never treated as small): `dropIdleMs: "off"` — a page this
//     worker decoded stays decoded, and a whole run's regions of it cost ONE decode. Residency is still bounded,
//     just by the LRU alone (`keepBytes`) rather than by the LRU plus a timer.
//   * under 4GB: the 2s window above is kept, because on those devices the 62.6MB matters more than the 590ms —
//     but never more than TWICE per page, because the pool PINS (`keepPage: true` forever) any page it has seen
//     decoded a second time. A page that a demand gap has already cost one re-decode is a page whose demand comes
//     in bursts, and this worker stops betting against that.
// `?atlasPageDrop=off|<ms>` overrides the tier for a device sweep. Either way the cost stays measurable rather
// than mysterious: a release shows up as `atlasReleased` and any re-decode it causes shows up as `atlasLoads`
// above `atlasPages`, both now on `window.__mirrorAtlasBakeStats` directly.
//
// THE HOLD SLOT (Aug-20): the LRU's ACCOUNTING was the defect, not the budget's size.
// A fresh combat mount on a browser that reports no `navigator.deviceMemory` (so: budget 64MB, poolSize 2,
// `keepBytes` 32MB per worker, and the idle drop already off by the tier above) measured `atlasLoads` 18 against
// `atlasPages` 10 — eight pages decoded a second time inside ONE mount, ~590ms of worker time each. The cause was
// this module's own sweep: `total + incoming > keepBytes` over one flat map, with a floor of 0 whenever something
// was incoming. A card page is 62.6MB, which is bigger than EVERY share on the ladder (24 / 32 / 64MB), so it was
// evicted the moment any other page arrived and re-decoded the moment the next region of it came in. No budget
// raise fixes that at any size — an 8GB desktop's 64MB share had the identical defect — so the accounting is what
// changed:
//   * a page at or above `bigPageBytes` (24MB, the same line KEEP_MIN_BYTES draws — see `resolveAtlasBigPageBytes`
//     in atlasBakePool.ts) is held in a HOLD SLOT, one per worker, OUTSIDE the share. Only ANOTHER big page
//     displaces it, because only another big page is competing for the same thing.
//   * everything smaller shares `keepBytes` under the same LRU as before, with one addition: an UNPINNED page is
//     evicted before a PINNED one (`keepPage: true` — the pool still has work for it). Pinned is evicted LAST, not
//     never, or the share would stop being a budget.
// So a worker is bounded at `keepBytes + largestPage` — which is what it was bounded at all along. The LRU's
// always-keep-one floor meant residency could never fall below one whole page anyway; the old accounting bought
// its illusory 32MB bound by paying a ~590ms re-decode for it every time. The gauge for all of this is
// `atlasLoads - atlasPages`, NOT `atlasEvicted`: evicting a page whose regions are all baked costs nothing, and
// the counter that says whether an eviction actually hurt is the one that counts decodes.
//
// The hold slot is armed by exactly the same lever as the tier above (`?atlasPageDrop`), so the two halves cannot
// disagree: `bigPageBytes` is a number precisely when `dropIdleMs` is `"off"`, i.e. from 4GB up and on a device
// that reports nothing. Under 4GB `bigPageBytes` is `"off"` too, and this module's sweep is the pre-Aug-20 one,
// byte for byte — that tier gives oversized pages back on a timer instead, which is the trade it was measured to
// want.
//
// Instantiated by atlasBakePool.ts through Vite's worker-URL form:
//   new Worker(new URL("./atlasBakeWorker.ts", import.meta.url), { type: "module" })
// so this file is emitted as its own chunk. It imports nothing on purpose — a worker chunk that pulled in the
// renderer would ship (and parse) the whole mirror a second time per worker.

// --- STRIPS (Aug-15): N regions of one page, composed into ONE image ------------------------------------------
//
// The enemy-intent glyph cycles its frames on the COMPOSITOR: all N frames live side by side in one strip image
// that a `translate` + `steps(N)` animation walks (see frontend/src/mirror/intentStrip.ts). Building that strip is
// the same crop work a region bake already does, N times, plus one encode — so it belongs here for exactly the
// reasons a region bake does, and for one more: composing it on the main thread means N `drawImage`s into a
// canvas AND a `convertToBlob` whose PNG encode is an idle task a busy combat main thread starves.
//
// It is ONE job, not N: the pool's queue, the page's residency and the encode are all paid once, and the caller
// gets a single blob it can hang on a single <img>. All cells must be regions of the SAME page — the pool's whole
// placement/residency model is keyed on one url per job (see atlasBakePool's `bakeAtlasStripInWorker`), and every
// intent set this game ships comes out of one atlas.
export interface AtlasBakeStripCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Main → worker. `bake` (one region) and `strip` (N cells → one image) are the jobs; `config` retunes residency
 *  without a respawn. */
export type AtlasBakeWorkerRequest =
  | {
      type: "bake";
      id: number;
      key: string;
      url: string;
      x: number;
      y: number;
      width: number;
      height: number;
      /**
       * Does the POOL still have queued or in-flight work for this page after this region? `false` arms the idle
       * drop above — it means "nothing else is queued RIGHT NOW", which is all the pool can honestly say, so it
       * only ever arms the timer and never takes the drop itself.
       */
      keepPage: boolean;
    }
  | {
      type: "strip";
      id: number;
      key: string;
      url: string;
      /** The cells IN FRAME ORDER, each a region of `url`. */
      cells: AtlasBakeStripCell[];
      /** One cell's box in the composed image; a cell whose region is smaller is SCALED to fill it. */
      cellW: number;
      cellH: number;
      keepPage: boolean;
    }
  | {
      type: "config";
      keepBytes: number;
      /**
       * The idle-drop policy for a page bigger than `keepBytes`: `"off"` = never arm one (decode-at-most-once, the
       * default on 4GB+ and on devices that report no memory at all), a number = the idle window in ms. OPTIONAL
       * and sticky: a `config` that omits it retunes `keepBytes` alone and leaves the policy where it was, so the
       * pool can re-share the budget without re-deciding the tier. See DROPPING A FINISHED OVERSIZED PAGE, and
       * `resolveAtlasPageDrop` in atlasBakePool.ts for where the value comes from.
       */
      dropIdleMs?: number | "off";
      /**
       * The HOLD SLOT line: a page of this many bytes or more is held apart from `keepBytes` instead of competing
       * with it (see THE HOLD SLOT above). `"off"` = no hold slot, one flat LRU over everything — the pre-Aug-20
       * rule, and the FALLBACK here, so a config that never mentions it behaves exactly as it always did. Same
       * OPTIONAL-and-sticky contract as `dropIdleMs`, and decided by the same lever: see
       * `resolveAtlasBigPageBytes` in atlasBakePool.ts.
       */
      bigPageBytes?: number | "off";
    };

/** Worker → main. */
export type AtlasBakeWorkerResponse =
  | { type: "blob"; id: number; key: string; blob: Blob; workerMs: number; encodeMs: number }
  | { type: "error"; id: number; key: string; url: string; message: string; atlas: boolean }
  | { type: "atlas"; url: string; bytes: number; totalBytes: number; urls: string[]; loadMs: number }
  /**
   * A page this worker no longer holds — `idle` = its demand stopped and it was bigger than `keepBytes`,
   * `budget` = the LRU made room for another page. NOT a load: the pool must not count it as decode work.
   */
  | {
      type: "release";
      url: string;
      bytes: number;
      totalBytes: number;
      urls: string[];
      reason: "idle" | "budget";
    };

interface HeldPage {
  url: string;
  pixels: ImageData;
  bytes: number;
  /** Monotonic use stamp for the LRU eviction below (a counter, not a clock — no timer needed). */
  usedAt: number;
  /**
   * Has the pool ever said it still had work for this page (`keepPage: true`)? Sticky ONCE TRUE, for the same
   * reason the idle drop is delayed rather than taken at the crop: `keepPage: false` is only ever "nothing is
   * queued for it RIGHT NOW", which at poolSize 1 is true of every single region a burst issues. A later `false`
   * un-pinning the page would make the pin describe the last job instead of the page's demand. It orders the
   * share's LRU and nothing else — a pinned page is evicted last, not never (see evictPages).
   */
  pinned: boolean;
}

/** Decoded pages this worker holds, and the pages it will never hold (a failed fetch/decode). */
const pages = new Map<string, HeldPage>();
const deadPages = new Set<string>();
/** In-flight decodes, so two jobs for the same page never fetch+decode it twice. */
const loading = new Map<string, Promise<HeldPage>>();

/** LRU budget for THIS worker's decoded pages; the pool sets it from the device's memory (see atlasBakePool). */
let keepBytes = 32 * 1024 * 1024;
let useClock = 0;

/**
 * How long a page BIGGER than `keepBytes` stays resident after the pool said nothing else was queued for it. See
 * WHY A DELAY above: the baker paces bakes one per task with a 16ms yield between them, so this window has to be
 * long enough that a burst's own jank never reads as the end of demand. 2s is ~125 of those yields, and ~3.4x the
 * ~590ms decode it is risking — the trade it makes is "hold 62.6MB for two more seconds" against "maybe pay 590ms
 * of worker time again".
 *
 * This is the FALLBACK, not the shipped answer: the pool configures the policy on spawn (`dropIdleMs`), and on
 * every device that reports 4GB or more — or reports nothing — it configures it OFF. A worker only ever runs on
 * this constant if it was never told (which, outside a spec driving this module directly, does not happen).
 */
const DROP_IDLE_MS = 2_000;

/** The live policy: `"off"` = never arm a drop at all, a number = that idle window in ms. See DROP_IDLE_MS. */
let dropIdleMs: number | "off" = DROP_IDLE_MS;

/**
 * The live HOLD SLOT line: a page of this many bytes or more is held apart from the share (see THE HOLD SLOT).
 * `"off"` — the FALLBACK — is the pre-Aug-20 rule: no hold slot, no pin ordering, one flat LRU over every page.
 * The pool configures it on spawn from the same lever that decides `dropIdleMs`, so a worker only ever runs on
 * this fallback if it was never told (which, outside a spec driving this module directly, does not happen).
 */
let bigPageBytes: number | "off" = "off";

/** Pages armed to be dropped once demand for them stops (url → timer). See DROPPING A FINISHED OVERSIZED PAGE. */
const dropTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Readback band height in bytes. The page is decoded via `createImageBitmap` and read back into `ImageData`
 * BAND BY BAND rather than through one full-page canvas: a full-page canvas would make the peak
 * bitmap + canvas + ImageData ≈ 3× the page (188MB for card_atlas_0 — an OOM-kill risk on a phone), while a 4MB
 * band keeps the peak at bitmap + page + 4MB and costs the same total pixels.
 */
const BAND_BYTES = 4 * 1024 * 1024;

interface WorkerScope {
  postMessage(message: AtlasBakeWorkerResponse): void;
  onmessage: ((event: { data: AtlasBakeWorkerRequest }) => void) | null;
}

// `self` is typed as a Window by the DOM lib this project compiles against (tsconfig has no "WebWorker" lib, and
// adding it would fight DOM in the same program), so narrow it here instead.
const scope = self as unknown as WorkerScope;

const post = (message: AtlasBakeWorkerResponse): void => {
  scope.postMessage(message);
};

const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Read a decoded page back into raw RGBA, one band at a time (see BAND_BYTES). */
function readBack(bitmap: ImageBitmap): ImageData {
  const width = bitmap.width;
  const height = bitmap.height;
  const out = new ImageData(width, height);
  const bandRows = Math.max(1, Math.min(height, Math.floor(BAND_BYTES / Math.max(1, width * 4))));
  const canvas = new OffscreenCanvas(width, Math.min(height, bandRows));
  // `willReadFrequently` keeps the backing store CPU-side, which is the whole point: the readback must not
  // become a GPU round trip in a second process.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("no 2d context");
  }
  const rowBytes = width * 4;
  for (let y = 0; y < height; y += bandRows) {
    const rows = Math.min(bandRows, height - y);
    ctx.clearRect(0, 0, width, rows);
    ctx.drawImage(bitmap, 0, y, width, rows, 0, 0, width, rows);
    const band = ctx.getImageData(0, 0, width, rows);
    out.data.set(band.data.subarray(0, rows * rowBytes), y * rowBytes);
  }
  return out;
}

/** What this worker holds right now, in bytes. */
function heldBytes(): number {
  let total = 0;
  for (const page of pages.values()) {
    total += page.bytes;
  }
  return total;
}

/** Tell the pool a page left this worker, and what is left after it (residency is always the worker's own count). */
function postRelease(url: string, bytes: number, reason: "idle" | "budget"): void {
  post({ type: "release", url, bytes, totalBytes: heldBytes(), urls: [...pages.keys()], reason });
}

function cancelDrop(url: string): void {
  const timer = dropTimers.get(url);
  if (timer !== undefined) {
    clearTimeout(timer);
    dropTimers.delete(url);
  }
}

/**
 * Arm the idle drop for a page the pool has no more queued work for. A no-op unless the page ALONE is over this
 * worker's share — a page the LRU can manage is not worth risking a ~590ms re-decode on, and on an 8GB device
 * (`keepBytes` 64MB) that means nothing in this game is ever armed at all — and a no-op outright under
 * `dropIdleMs: "off"`, which is the shipped policy from 4GB up (see DROPPING A FINISHED OVERSIZED PAGE).
 */
function armDrop(page: HeldPage): void {
  cancelDrop(page.url);
  if (dropIdleMs === "off" || page.bytes <= keepBytes || typeof setTimeout !== "function") {
    return;
  }
  const idleMs = dropIdleMs;
  const url = page.url;
  const armedAt = page.usedAt;
  dropTimers.set(
    url,
    setTimeout(() => {
      dropTimers.delete(url);
      const held = pages.get(url);
      if (!held || held.usedAt !== armedAt || held.bytes <= keepBytes) {
        return; // used again since (or already gone, or a bigger `keepBytes` arrived) — keep it
      }
      pages.delete(url);
      postRelease(url, held.bytes, "idle");
    }, idleMs)
  );
}

/**
 * Is this page held in the HOLD SLOT rather than in the share? A page big enough to be worth more than a whole
 * share is not a page the share can budget: the LRU's always-keep-one floor was going to hold it anyway, so the
 * only thing counting it against `keepBytes` ever achieved was evicting everything else — or itself. See THE HOLD
 * SLOT. `bigPageBytes: "off"` (the fallback, and the under-4GB tier) means no hold slot at all.
 */
function isHoldSlotPage(bytes: number): boolean {
  return bigPageBytes !== "off" && bytes >= bigPageBytes;
}

/** Should `a` be evicted before `b`? Least-recently-used first, and UNPINNED before PINNED — a page the pool says
 *  it still has work for goes last, so an eviction takes the page whose re-decode is least likely to be paid for.
 *  Under `bigPageBytes: "off"` the pin is ignored entirely and this is the plain LRU it always was. */
function evictsFirst(a: HeldPage, b: HeldPage): boolean {
  if (bigPageBytes !== "off" && a.pinned !== b.pinned) {
    return b.pinned;
  }
  return a.usedAt < b.usedAt;
}

/**
 * Make room for a page this worker is about to hold (`incomingBytes`, 0 for a plain re-sweep after a `config`).
 * Returns the bytes still held, the incoming page not included.
 *
 * TWO POOLS, NOT ONE (see THE HOLD SLOT above):
 *   * a BIG incoming page displaces the hold slot's previous occupant and NOTHING else. The small pages in the
 *     share are not what its bytes are competing for, and evicting them for it is the defect this replaced.
 *   * everything else is budgeted against `keepBytes` over the SHARE set alone, with the floor this sweep always
 *     had: making room for an incoming share page may empty the share (the page a job is about to use is the
 *     incoming one), while a sweep with nothing incoming for the share keeps one — that one is the page the job in
 *     this worker's hand is cropping from.
 *
 * An eviction is a MAP removal, not a free: a bake that already holds the page in a local keeps its pixels alive
 * until it finishes, which is deliberate — a job in flight must never lose the pixels under it.
 */
function evictPages(incomingBytes = 0): number {
  const incomingIsBig = isHoldSlotPage(incomingBytes);
  if (incomingIsBig) {
    for (const page of [...pages.values()]) {
      if (isHoldSlotPage(page.bytes)) {
        evictPage(page);
      }
    }
  }
  const shareIncoming = incomingIsBig ? 0 : incomingBytes;
  const floor = shareIncoming > 0 ? 0 : 1;
  for (;;) {
    let total = 0;
    let count = 0;
    let worst: HeldPage | null = null;
    for (const page of pages.values()) {
      if (isHoldSlotPage(page.bytes)) {
        continue; // the hold slot is not part of the share it is held apart from
      }
      total += page.bytes;
      count += 1;
      if (worst === null || evictsFirst(page, worst)) {
        worst = page;
      }
    }
    if (worst === null || count <= floor || total + shareIncoming <= keepBytes) {
      break;
    }
    evictPage(worst);
  }
  return heldBytes();
}

/** Let a page go for the budget, and say so — residency is always the worker's own count, never an estimate. */
function evictPage(page: HeldPage): void {
  pages.delete(page.url);
  cancelDrop(page.url);
  postRelease(page.url, page.bytes, "budget");
}

async function decodePage(url: string, keepPage: boolean): Promise<HeldPage> {
  const startedAt = nowMs();
  // `force-cache` on purpose: the mod serves `/res/...` as `public, max-age=31536000, immutable`, so the atlas
  // the main thread already fetched for its own decode-once cache is in the HTTP cache — the worker should read
  // that copy rather than pull 19MB of PNG over the LAN a second time.
  // `credentials: "omit"`, not "same-origin": under the public-origin bootstrap the atlas is CROSS-origin,
  // and a credentialed CORS request additionally requires the server to echo a specific origin and send
  // `Access-Control-Allow-Credentials`. We send no credentials to the host in any mode, so omitting them
  // keeps the simplest CORS shape working in both. Same bytes either way.
  const response = await fetch(url, { cache: "force-cache", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const bytes = await response.blob();
  const bitmap = await createImageBitmap(bytes);
  let pixels: ImageData;
  try {
    // Make room BEFORE the readback allocates, not after the new page is inserted. `readBack` allocates a full
    // RGBA copy of the page, so the peak in here is (what this worker still holds) + bitmap + that copy: evicting
    // first is what keeps a 62.6MB card atlas from peaking at ~188MB inside one worker (62.6 held + 62.6 bitmap
    // + 62.6 readback) instead of ~125MB. `width × height × 4` is the same number as `pixels.data.byteLength`
    // below — it is just knowable one allocation earlier.
    evictPages(bitmap.width * bitmap.height * 4);
    pixels = readBack(bitmap);
  } finally {
    bitmap.close();
  }
  const page: HeldPage = { url, pixels, bytes: pixels.data.byteLength, usedAt: ++useClock, pinned: keepPage };
  cancelDrop(url);
  pages.set(url, page);
  post({
    type: "atlas",
    url,
    bytes: page.bytes,
    totalBytes: heldBytes(),
    urls: [...pages.keys()],
    loadMs: nowMs() - startedAt
  });
  return page;
}

/** Claim a page for a job: the LRU stamp, the pin and the drop's cancellation all happen HERE, at the moment the
 *  job takes the page, rather than after its crop — an eviction caused by another decode may land in between. */
function pageFor(url: string, keepPage: boolean): Promise<HeldPage> {
  const held = pages.get(url);
  if (held) {
    held.usedAt = ++useClock;
    held.pinned = held.pinned || keepPage; // sticky once true — see HeldPage.pinned
    cancelDrop(url); // demand for this page did not stop after all
    return Promise.resolve(held);
  }
  if (deadPages.has(url)) {
    return Promise.reject(new Error("atlas unavailable"));
  }
  const inFlight = loading.get(url);
  if (inFlight) {
    // A second job joins the decode the first one started, so the pin it carries has to reach the page the same
    // way a cache hit's would — the decode was started for the FIRST job's answer, not for this one's.
    return keepPage
      ? inFlight.then((page) => {
          page.pinned = true;
          return page;
        })
      : inFlight;
  }
  const started = decodePage(url, keepPage).catch((error: unknown) => {
    deadPages.add(url);
    throw error;
  });
  loading.set(url, started);
  // Clear the in-flight slot on BOTH outcomes without swallowing the rejection the caller is awaiting.
  void started.then(
    () => loading.delete(url),
    () => loading.delete(url)
  );
  return started;
}

/** Copy `region` out of a decoded page into its own small ImageData, clamped to the page's bounds. */
function cropRegion(page: HeldPage, x: number, y: number, width: number, height: number): ImageData {
  const out = new ImageData(width, height);
  const source = page.pixels;
  const copyWidth = Math.max(0, Math.min(width, source.width - x));
  if (copyWidth === 0) {
    return out;
  }
  for (let row = 0; row < height; row++) {
    const sourceY = y + row;
    if (sourceY < 0 || sourceY >= source.height) {
      continue;
    }
    const from = (sourceY * source.width + x) * 4;
    out.data.set(source.data.subarray(from, from + copyWidth * 4), row * width * 4);
  }
  return out;
}

async function bake(request: Extract<AtlasBakeWorkerRequest, { type: "bake" }>): Promise<void> {
  const startedAt = nowMs();
  let sawPage = false;
  // `let` plus the explicit `page = null` below are load-bearing, not style. An async function's suspended
  // context keeps EVERY binding still in scope alive across an await, so a page dropped (by the idle timer, or
  // evicted by another decode) while the `convertToBlob` below is outstanding would still be reachable through
  // this local and free nothing. Read the awaits before moving this: `page` is in scope across `convertToBlob`,
  // and the crop below is the last thing that reads it.
  let page: HeldPage | null = null;
  try {
    page = await pageFor(request.url, request.keepPage);
    sawPage = true;
    const width = Math.max(1, Math.round(request.width));
    const height = Math.max(1, Math.round(request.height));
    const encodeStartedAt = nowMs();
    // The only read of the page's pixels. `crop` is an independent ImageData from here on, so this is the window
    // in which the page may be let go — see DROPPING A FINISHED OVERSIZED PAGE.
    const crop = cropRegion(page, Math.round(request.x), Math.round(request.y), width, height);
    if (request.keepPage === false) {
      armDrop(page);
    }
    page = null;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("no 2d context");
    }
    ctx.putImageData(crop, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    post({
      type: "blob",
      id: request.id,
      key: request.key,
      blob,
      workerMs: nowMs() - startedAt,
      encodeMs: nowMs() - encodeStartedAt
    });
  } catch (error) {
    // `atlas: false` = this ONE region failed (the pool re-bakes it inline); `atlas: true` = the page itself is
    // unusable here, so the pool stops sending this worker regions of it at all.
    post({
      type: "error",
      id: request.id,
      key: request.key,
      url: request.url,
      message: error instanceof Error ? error.message : String(error),
      atlas: !sawPage
    });
  }
}

/**
 * Compose N cells of one page into a single horizontal strip image and encode it ONCE. Same page handling, same
 * `blob` response and the same `workerMs`/`encodeMs` split as `bake` — the pool and the baker cannot tell the two
 * apart, which is the point: a strip is a bake with more crops in it.
 *
 * WHY THE CROPS COME FIRST, IN ONE SYNCHRONOUS PASS. `cropRegion` is the only read of the page's pixels, so doing
 * all of them before anything is awaited keeps the window in which this job needs the page as narrow as a region
 * bake's — after it, `page` is released to the same idle drop (see DROPPING A FINISHED OVERSIZED PAGE) and nulled
 * so a suspended await cannot keep 62.6MB reachable. The crops it holds instead are cell-sized (an intent frame is
 * ~48×51 = 9.8KB of RGBA, and a set is 2-8 of them), i.e. nothing next to the page they came from.
 *
 * SCALING. A cell whose region is smaller than the cell box is stretched to fill it, reproducing exactly what the
 * main-thread strip canvas draws (`ctx.scale(cellW/region.width, …)` in mirrorRenderer's paintIntentStrip), which
 * in turn reproduces what the single-frame atlas element renders today. `putImageData` cannot scale and ignores
 * the transform, so only the EXACT-FIT case (every frame the same size — the normal one) takes it; anything else
 * goes through an `ImageBitmap` so the resample is the same `drawImage` the canvas path uses.
 */
async function bakeStrip(request: Extract<AtlasBakeWorkerRequest, { type: "strip" }>): Promise<void> {
  const startedAt = nowMs();
  let sawPage = false;
  let page: HeldPage | null = null;
  try {
    page = await pageFor(request.url, request.keepPage);
    sawPage = true;
    const cellW = Math.max(1, Math.round(request.cellW));
    const cellH = Math.max(1, Math.round(request.cellH));
    const count = request.cells.length;
    if (count === 0) {
      throw new Error("empty strip");
    }
    const encodeStartedAt = nowMs();
    const crops: Array<{ pixels: ImageData; width: number; height: number }> = [];
    for (const cell of request.cells) {
      const width = Math.max(1, Math.round(cell.width));
      const height = Math.max(1, Math.round(cell.height));
      crops.push({ pixels: cropRegion(page, Math.round(cell.x), Math.round(cell.y), width, height), width, height });
    }
    if (request.keepPage === false) {
      armDrop(page);
    }
    page = null;
    const canvas = new OffscreenCanvas(cellW * count, cellH);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("no 2d context");
    }
    for (let i = 0; i < count; i++) {
      const crop = crops[i];
      if (crop.width === cellW && crop.height === cellH) {
        ctx.putImageData(crop.pixels, i * cellW, 0);
        continue;
      }
      const bitmap = await createImageBitmap(crop.pixels);
      try {
        ctx.drawImage(bitmap, i * cellW, 0, cellW, cellH);
      } finally {
        bitmap.close();
      }
    }
    const blob = await canvas.convertToBlob({ type: "image/png" });
    post({
      type: "blob",
      id: request.id,
      key: request.key,
      blob,
      workerMs: nowMs() - startedAt,
      encodeMs: nowMs() - encodeStartedAt
    });
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      key: request.key,
      url: request.url,
      message: error instanceof Error ? error.message : String(error),
      atlas: !sawPage
    });
  }
}

scope.onmessage = (event: { data: AtlasBakeWorkerRequest }): void => {
  const request = event.data;
  if (request.type === "config") {
    keepBytes = Math.max(1, request.keepBytes);
    if (request.bigPageBytes !== undefined) {
      bigPageBytes = request.bigPageBytes === "off" ? "off" : Math.max(1, request.bigPageBytes);
    }
    if (request.dropIdleMs !== undefined) {
      dropIdleMs = request.dropIdleMs === "off" ? "off" : Math.max(1, request.dropIdleMs);
      if (dropIdleMs === "off") {
        // Turning the policy off has to release the timers already armed under the old one, or a page would still
        // be dropped once by a decision that has since been reversed.
        for (const url of [...dropTimers.keys()]) {
          cancelDrop(url);
        }
      }
    }
    evictPages();
    return;
  }
  if (request.type === "bake") {
    void bake(request);
    return;
  }
  if (request.type === "strip") {
    void bakeStrip(request);
  }
};

/**
 * TEST-ONLY: this worker's own tuning, so a spec asserts the real window instead of a copy of it. (A spec drives
 * this module through `self.onmessage` / `self.postMessage`, the same seam the browser uses — there is no other
 * entry point, and adding one would put a second dispatch path in the shipped worker chunk.)
 */
export const __atlasBakeWorkerTuningForTest = { DROP_IDLE_MS };
