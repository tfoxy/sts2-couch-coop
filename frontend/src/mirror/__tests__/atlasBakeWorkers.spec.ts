// R11 (Aug-14) — THE REGION BAKE RUNS IN A WORKER POOL.
//
// The phone session that motivated this measured 4,502.6ms of bake WALL against 385.3ms of main thread (91.4% of
// a bake's life is not main-thread time) and still tripped the self-disable three times, leaving 41 regions on the
// canvas path. `convertToBlob` encodes PNG as an IDLE TASK, so a busy combat main thread starves it — the encode
// never got more expensive, the wait did. The fix is to encode where the page is not busy.
//
// This file pins the contract that makes that safe on real devices:
//   * pool SIZE adapts to the device (a 2-core phone still works, and still wins — even one worker removes the
//     GPU→CPU readback and the encode from the main thread),
//   * dispatch prefers a worker that already holds the atlas page, because each copy is real memory
//     (card_atlas_0 is 4032×4072 = 62.6MB of RGBA),
//   * a page bigger than one worker's `keepBytes` share is given BACK once its demand stops, so the LRU's
//     always-keep-one floor cannot pin 62.6MB in a worker for the rest of the session, and
//   * EVERY failure degrades to the inline path rather than dropping a region.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  atlasBakeStats,
  atlasRegionBlobUrl,
  __atlasBakeTuningForTest,
  __resetAtlasCacheForTest,
  type AtlasRegion
} from "@/mirror/atlasBaker";
import {
  atlasBakePoolStats,
  bakeAtlasRegionInWorker,
  bakeAtlasStripInWorker,
  chooseAtlasBakeWorker,
  resolveAtlasBakePoolSize,
  resolveAtlasBigPageBytes,
  resolveAtlasBudgetBytes,
  resolveAtlasKeepBytes,
  resolveAtlasPageDrop,
  __atlasBakePoolTuningForTest,
  __resetAtlasBakePoolForTest,
  __setAtlasBakeWorkerFactoryForTest,
  __setAtlasBakePoolSizeForTest,
  __setAtlasPageDropForTest
} from "@/mirror/atlasBakePool";

const ATLAS = "/res/images/atlases/ui_atlas_0.png";
const OTHER = "/res/images/atlases/card_atlas_1.png";
const THIRD = "/res/images/atlases/relic_atlas.png";
const r = (x: number): AtlasRegion => ({ x, y: 0, width: 8, height: 8 });

// The real pipeline (`request()` below) never hands the pool more than `poolSize` concurrent jobs for ANY page —
// atlasBaker's own drain throttles hand-off to `bakeConcurrency()` and only refills a slot once a prior job
// SETTLES (see WHY ONE AT A TIME in atlasBaker.ts). That is real and load-bearing (it is WHY the amortization
// bar is rarely if ever crossed in production — see the "realistic multi-page workload" spec below), but it means
// `request()` cannot build a queue deep enough to exercise the amortization gate's OWN boundary in isolation. For
// that, go around the baker and hand the pool jobs directly, exactly the shape `bakeAtlasRegionInWorker` expects.
function bakeDirect(url: string, x: number): void {
  bakeAtlasRegionInWorker(`${url}|${x}`, url, { x, y: 0, width: 8, height: 8 }, () => {});
}

// --- fixtures ---------------------------------------------------------------------------------------------------

let images: FakeImage[] = [];
class FakeImage {
  private loaders: Array<() => void> = [];
  decoding = "";
  crossOrigin = "";
  src = "";
  constructor() {
    images.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    if (type === "load") this.loaders.push(cb);
  }
  removeEventListener(_type: string, cb: () => void): void {
    const i = this.loaders.indexOf(cb);
    if (i >= 0) this.loaders.splice(i, 1);
  }
  fireLoad(): void {
    for (const cb of [...this.loaders]) cb();
  }
}

/** The INLINE encode path, faked — a test asserts on whether it ran at all. */
let inlinePending: Array<(b: Blob | null) => void> = [];
class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number
  ) {}
  getContext(): { drawImage: () => void } {
    return { drawImage: () => {} };
  }
  convertToBlob(): Promise<Blob> {
    return new Promise((resolve) => {
      inlinePending.push(resolve as (b: Blob | null) => void);
    });
  }
}

interface BakeMessage {
  type: string;
  id: number;
  key: string;
  url: string;
  width: number;
  height: number;
  /** Does the POOL still have work queued for this page? False arms the worker's idle drop of an oversized page. */
  keepPage: boolean;
}

/** A STRIP job: N cells of ONE page composed into a single image, encoded once (the intent glyph's strip). */
interface StripMessage {
  type: string;
  id: number;
  key: string;
  url: string;
  cells: Array<{ x: number; y: number; width: number; height: number }>;
  cellW: number;
  cellH: number;
  keepPage: boolean;
}

let workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  terminated = false;
  constructor(
    public url: unknown,
    public options: unknown
  ) {
    workers.push(this);
  }
  postMessage(message: Record<string, unknown>): void {
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }

  /** The bake jobs this worker was handed, in order — regions AND strips (both are answered by `finishBake`). */
  get bakes(): BakeMessage[] {
    return this.sent.filter((m) => m.type === "bake" || m.type === "strip") as unknown as BakeMessage[];
  }
  /** …just the strip ones. */
  get strips(): StripMessage[] {
    return this.sent.filter((m) => m.type === "strip") as unknown as StripMessage[];
  }
  /** …and how many of them it has not answered yet. */
  get outstanding(): number {
    return this.bakes.length - this.answered;
  }
  reply(message: Record<string, unknown>): void {
    this.onmessage?.({ data: message });
  }
  /**
   * Answer the oldest unanswered bake with a blob, and report the page it decoded (`bytes`). `timing` is the
   * worker's own split: `workerMs` is the whole job (its wait for the page included) and `encodeMs` is the
   * crop+encode inside it — the difference is a one-off page decode, which is exactly what the stall backstop may
   * not charge to a region (see WHICH WALL IS THE DAMAGE in atlasBaker.ts).
   */
  finishBake(bytes = 16 * 1024 * 1024, timing: { workerMs?: number; encodeMs?: number } = {}): void {
    const job = this.bakes[this.answered];
    expect(job, "a bake was in flight for this worker").toBeDefined();
    this.answered += 1;
    if (!this.pages.has(job.url)) {
      this.pages.add(job.url);
      this.reply({
        type: "atlas",
        url: job.url,
        bytes,
        totalBytes: bytes * this.pages.size,
        urls: [...this.pages],
        loadMs: 12
      });
    }
    this.reply({
      type: "blob",
      id: job.id,
      key: job.key,
      blob: new Blob([""]),
      workerMs: timing.workerMs ?? 7,
      encodeMs: timing.encodeMs ?? 5
    });
  }
  /**
   * Give a page back, the way the real worker does when its idle drop fires (`idle`) or when its LRU makes room
   * for another page (`budget`). The fake forgets it too, so a later `finishBake` for that url reports a fresh
   * load — which is exactly the re-decode a release risks.
   */
  release(url: string, bytes = 16 * 1024 * 1024, reason: "idle" | "budget" = "idle"): void {
    this.pages.delete(url);
    this.reply({
      type: "release",
      url,
      bytes,
      totalBytes: bytes * this.pages.size,
      urls: [...this.pages],
      reason
    });
  }
  /** …or refuse it. `atlas` = the page itself is unusable, not just this region. */
  failBake(atlas = false): void {
    const job = this.bakes[this.answered];
    expect(job, "a bake was in flight for this worker").toBeDefined();
    this.answered += 1;
    this.reply({ type: "error", id: job.id, key: job.key, url: job.url, message: "nope", atlas });
  }
  private answered = 0;
  private pages = new Set<string>();
}

let clockMs = 0;
let objectUrls = 0;

function stubDevice(cores: number, memoryGb?: number): void {
  vi.stubGlobal("navigator", { hardwareConcurrency: cores, deviceMemory: memoryGb } as unknown as Navigator);
}

/**
 * Pin a pool size for a test about pool MECHANICS rather than about sizing. The shipped ladder tops out at
 * POOL_MAX (2) on the device sweep's evidence, but dispatch, holder-first placement, worker death and re-queue
 * are only interesting with more workers than pages in flight — and those behaviours must not silently stop
 * being covered every time the shipped default moves.
 */
function usePoolSize(n: number): void {
  __setAtlasBakePoolSizeForTest(n);
}

/**
 * Put the pool on the SMALL-DEVICE residency tier (`dropIdleMs` armed) without moving the pool size or the byte
 * budget `navigator.deviceMemory` also decides — the fixture device is 8GB, where the idle drop is off outright
 * (see `the page-drop tier` below). Specs that are about what a RELEASED page costs need a tier that can still
 * release one, and nothing else about them should change.
 */
function useIdleDropTier(): void {
  __setAtlasPageDropForTest(__atlasBakePoolTuningForTest.PAGE_DROP_IDLE_MS);
  __resetAtlasBakePoolForTest();
}

beforeEach(() => {
  images = [];
  workers = [];
  inlinePending = [];
  clockMs = 0;
  objectUrls = 0;
  window.history.replaceState(null, "", "/");
  vi.useFakeTimers();
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  vi.stubGlobal("createImageBitmap", undefined);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas as unknown as typeof OffscreenCanvas);
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
  vi.stubGlobal("performance", { now: () => clockMs } as unknown as Performance);
  // NOT a wholesale URL stub: the pool's `new Worker(new URL("./atlasBakeWorker.ts", import.meta.url))` needs the
  // real constructor, which is exactly the call site under test here.
  Object.defineProperty(URL, "createObjectURL", {
    value: () => `blob:region-${++objectUrls}`,
    configurable: true,
    writable: true
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true, writable: true });
  stubDevice(8, 8);
  __resetAtlasCacheForTest();
});

afterEach(() => {
  __resetAtlasCacheForTest();
  __setAtlasBakeWorkerFactoryForTest(null);
  __setAtlasBakePoolSizeForTest(null);
  __setAtlasPageDropForTest(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Ask for a region's blob; a non-null nodeId is a visible node waiting on it (an URGENT bake). */
function request(url: string, x: number, nodeId: string | null = `node-${x}`): string | null {
  return atlasRegionBlobUrl(url, r(x), nodeId);
}

/** Let the atlas "decode" and run the drain far enough to issue everything it can. */
async function pump(): Promise<void> {
  await vi.advanceTimersByTimeAsync(64);
}

/** Total bake jobs handed to the pool. */
function dispatched(): number {
  return workers.reduce((n, w) => n + w.bakes.length, 0);
}

// --- pool sizing ------------------------------------------------------------------------------------------------

describe("worker pool sizing", () => {
  it("maps cores to a pool, with a floor of 1 and a cap of 2", () => {
    const { POOL_MAX } = __atlasBakePoolTuningForTest;
    expect(POOL_MAX).toBe(2);
    // A 2-CORE DEVICE IS NOT EXCLUDED: it gets one worker, which is the fan-out the perf harness measured as
    // already beating inline encoding (709ms vs 1,238ms) — the win is the readback and the encode leaving this
    // thread, not the extra cores.
    expect(resolveAtlasBakePoolSize(1, undefined)).toBe(1);
    expect(resolveAtlasBakePoolSize(2, undefined)).toBe(1);
    // …and the ladder is FLAT from 3 cores up. It used to climb to 4; the Aug-14 device sweep (see the table on
    // POOL_MAX) measured four workers as the worst main-thread arm AND 65MB heavier than two, because the
    // parallelism here is bounded by distinct PAGES in flight, not by cores.
    expect(resolveAtlasBakePoolSize(3, undefined)).toBe(2);
    expect(resolveAtlasBakePoolSize(4, undefined)).toBe(2);
    expect(resolveAtlasBakePoolSize(5, undefined)).toBe(2);
    expect(resolveAtlasBakePoolSize(7, undefined)).toBe(2);
    expect(resolveAtlasBakePoolSize(8, undefined)).toBe(2);
    expect(resolveAtlasBakePoolSize(16, undefined), "no device gets more than POOL_MAX").toBe(POOL_MAX);
    expect(resolveAtlasBakePoolSize(undefined, undefined), "unknown cores ⇒ the low end").toBe(1);
    expect(resolveAtlasBakePoolSize(0, undefined)).toBe(1);
  });

  it("caps the pool by navigator.deviceMemory (each worker holds its own decoded page)", () => {
    const { POOL_MAX } = __atlasBakePoolTuningForTest;
    expect(resolveAtlasBakePoolSize(8, 1), "under 2GB ⇒ a single worker").toBe(1);
    expect(resolveAtlasBakePoolSize(8, 2)).toBe(2);
    expect(resolveAtlasBakePoolSize(8, 4)).toBe(2);
    expect(resolveAtlasBakePoolSize(8, 8)).toBe(2);
    expect(resolveAtlasBakePoolSize(2, 8), "the memory cap never RAISES the core answer").toBe(1);
    expect(resolveAtlasBakePoolSize(8, undefined), "unreported memory is not treated as small").toBe(
      POOL_MAX
    );
  });

  it("derives the decoded-page budget from device memory, clamped", () => {
    const { BUDGET_MIN_BYTES, BUDGET_MAX_BYTES } = __atlasBakePoolTuningForTest;
    expect(resolveAtlasBudgetBytes(8)).toBe(BUDGET_MAX_BYTES);
    expect(resolveAtlasBudgetBytes(4)).toBe(64 * 1024 * 1024);
    expect(resolveAtlasBudgetBytes(1)).toBe(BUDGET_MIN_BYTES);
    expect(resolveAtlasBudgetBytes(64)).toBe(BUDGET_MAX_BYTES);
    // …and the fallback that the Aug-20 mount burst put on trial and did NOT move: an unreported reading is the
    // TIER LINE, not a desktop, because iOS Safari and Firefox report nothing at all and phones are in that
    // bucket. It is the same reading the pool size and the drop tier already take (see the two specs above).
    expect(resolveAtlasBudgetBytes(undefined), "4GB assumed when unreported").toBe(64 * 1024 * 1024);
  });

  // The per-worker share used to be written `Math.max(BUDGET_MIN_BYTES / POOL_MAX, budget / poolSize)`. That first
  // term is a RAISE, not a cap, and it was derived from a constant with nothing to do with it: when POOL_MAX went
  // 4 → 2 last round the floor silently DOUBLED, 12MB → 24MB, in a diff that never mentioned it. It is a literal
  // now. (24MB is what the old expression evaluates to today, so this pinned NO change in shipped behaviour — had
  // POOL_MAX moved again first, it would have.)
  it("splits the budget into per-worker shares over a floor that is a literal, not POOL_MAX arithmetic", () => {
    const { KEEP_MIN_BYTES, BUDGET_MIN_BYTES, BUDGET_MAX_BYTES } = __atlasBakePoolTuningForTest;
    expect(KEEP_MIN_BYTES).toBe(24 * 1024 * 1024);
    // The two page sizes that make 24MB the right number: a worker's share always holds a whole UI atlas, and
    // never holds a whole card atlas — so the card atlases are exactly the pages the worker's idle drop can arm on.
    expect(KEEP_MIN_BYTES, "ui_atlas_0 (2048×2048) fits in the floor").toBeGreaterThan(2048 * 2048 * 4);
    expect(KEEP_MIN_BYTES, "…and card_atlas_2 (3528×3080), the smallest card page, does not").toBeLessThan(
      3528 * 3080 * 4
    );
    // The shipped ladder: poolSize 1-2 against a 48-128MB budget. The floor never binds here — the share IS the
    // budget divided by the pool.
    expect(resolveAtlasKeepBytes(BUDGET_MIN_BYTES, 1)).toBe(BUDGET_MIN_BYTES);
    expect(resolveAtlasKeepBytes(BUDGET_MIN_BYTES, 2)).toBe(24 * 1024 * 1024);
    expect(resolveAtlasKeepBytes(64 * 1024 * 1024, 2)).toBe(32 * 1024 * 1024);
    expect(resolveAtlasKeepBytes(BUDGET_MAX_BYTES, 2)).toBe(64 * 1024 * 1024);
    // The floor remains defensive for test pool sizes beyond the shipped ladder.
    expect(resolveAtlasKeepBytes(BUDGET_MAX_BYTES, 4)).toBe(32 * 1024 * 1024);
    expect(resolveAtlasKeepBytes(BUDGET_MAX_BYTES, 8), "16MB/worker floored back up").toBe(KEEP_MIN_BYTES);
    expect(resolveAtlasKeepBytes(BUDGET_MIN_BYTES, 8)).toBe(KEEP_MIN_BYTES);
    expect(resolveAtlasKeepBytes(BUDGET_MIN_BYTES, 0), "a pool of nobody never divides by zero").toBe(
      BUDGET_MIN_BYTES
    );
  });

  it("posts that share to every worker it spawns", () => {
    usePoolSize(4); // pool MECHANICS, not sizing — see usePoolSize
    bakeDirect(ATLAS, 0);
    expect(workers.length).toBe(4);
    for (const worker of workers) {
      // 8GB ⇒ a 128MB budget, four workers ⇒ 32MB each (the floor does not bind at four) — and the whole residency
      // POLICY rides the same message: on a 4GB+ device a decoded page is never given back on idle alone
      // (`dropIdleMs: "off"`), which is exactly the tier that needs somewhere to keep a page too big for the share
      // (`bigPageBytes` — see `the hold slot line` below).
      expect(worker.sent[0]).toEqual({
        type: "config",
        keepBytes: resolveAtlasKeepBytes(128 * 1024 * 1024, 4),
        dropIdleMs: "off",
        bigPageBytes: __atlasBakePoolTuningForTest.BIG_PAGE_BYTES
      });
    }
  });
});

// --- the page-drop tier: how long a worker may hold a page after its demand stops --------------------------------
//
// A worker gives an oversized page back once nothing has asked for it in `dropIdleMs` (see DROPPING A FINISHED
// OVERSIZED PAGE in atlasBakeWorker.ts), and every demand GAP in this game — a new hand of cards, a screen change
// — then costs ~590ms of worker time to decode that page again. The window is worth that on a device where
// 62.6MB matters and not on one where it does not, so the pool decides it from `navigator.deviceMemory` and ships
// it on the config message the worker already gets.
describe("the page-drop tier", () => {
  const { PAGE_DROP_IDLE_MS, PAGE_DROP_MIN_MEMORY_GB } = __atlasBakePoolTuningForTest;

  it("turns the idle drop OFF from 4GB up, and on a device that reports nothing", () => {
    expect(PAGE_DROP_MIN_MEMORY_GB).toBe(4);
    expect(resolveAtlasPageDrop(8), "8GB: hold the page, decode it once").toBe("off");
    expect(resolveAtlasPageDrop(4), "…and 4GB is inside that, not on the small side").toBe("off");
    expect(resolveAtlasPageDrop(2), "2GB: the 62.6MB is worth a re-decode").toBe(PAGE_DROP_IDLE_MS);
    expect(resolveAtlasPageDrop(1)).toBe(PAGE_DROP_IDLE_MS);
    // Same rule the pool size uses (see `resolveAtlasBakePoolSize`): Safari/Firefox report NO deviceMemory, and an
    // absent reading has never been read here as "this device is small". The byte budget bounds them either way.
    expect(resolveAtlasPageDrop(undefined), "unreported memory is not treated as small").toBe("off");
    expect(resolveAtlasPageDrop(0)).toBe("off");
  });

  it("configures its workers with the tier, and publishes which one they got", () => {
    stubDevice(8, 2); // a small device: the drop stays armed there
    __resetAtlasBakePoolForTest();
    bakeDirect(ATLAS, 0);
    expect(workers[0].sent[0]).toMatchObject({ type: "config", dropIdleMs: PAGE_DROP_IDLE_MS });
    expect(atlasBakePoolStats.pageDropMs, "…and a device probe can read the decision back").toBe(
      PAGE_DROP_IDLE_MS
    );
  });

});

// --- the hold-slot line: which pages stop being budgetable by a share at all (Aug-20) ----------------------------
//
// The other half of the same policy, and derived from it rather than from the device: a worker that is KEEPING its
// oversized pages (`dropIdleMs: "off"`) needs somewhere to keep them that is not the share they cannot fit in, and
// a worker that gives them back on a timer does not. Deriving one from the other is what makes "the two halves
// disagree" unrepresentable — see THE HOLD SLOT in atlasBakePool.ts.
describe("the hold-slot line", () => {
  const { BIG_PAGE_BYTES, KEEP_MIN_BYTES, PAGE_DROP_IDLE_MS } = __atlasBakePoolTuningForTest;

  it("is the same line KEEP_MIN_BYTES draws, and it sits between this game's own page sizes", () => {
    expect(BIG_PAGE_BYTES).toBe(KEEP_MIN_BYTES);
    expect(BIG_PAGE_BYTES, "ui_atlas_0 (2048×2048 = 16.0MB) is an ordinary share page").toBeGreaterThan(
      2048 * 2048 * 4
    );
    expect(BIG_PAGE_BYTES, "…and card_atlas_2 (3528×3080 = 41.5MB), the SMALLEST card page, is not").toBeLessThan(
      3528 * 3080 * 4
    );
  });

  it("arms the hold slot exactly where the idle drop is off — one lever, two halves", () => {
    expect(resolveAtlasBigPageBytes("off"), "keeping big pages ⇒ somewhere to keep them").toBe(BIG_PAGE_BYTES);
    expect(resolveAtlasBigPageBytes(PAGE_DROP_IDLE_MS), "giving them back on a timer ⇒ no hold slot").toBe("off");
    expect(resolveAtlasBigPageBytes(500)).toBe("off");
    // …and the composition that actually ships: ONE device reading produces both answers, so there is no ordering
    // of decisions in which a device ends up holding pages with nowhere to hold them (or the reverse).
    expect(resolveAtlasBigPageBytes(resolveAtlasPageDrop(undefined)), "unreported memory: hold").toBe(
      BIG_PAGE_BYTES
    );
    expect(resolveAtlasBigPageBytes(resolveAtlasPageDrop(8)), "8GB: hold").toBe(BIG_PAGE_BYTES);
    expect(resolveAtlasBigPageBytes(resolveAtlasPageDrop(2)), "2GB: drop").toBe("off");
  });

  it("stays put when the SHARE moves — a 64MB share must not re-classify a card page as ordinary", () => {
    stubDevice(8, 8); // a 128MB budget over two workers: a 64MB share, twice the line
    __resetAtlasBakePoolForTest();
    bakeDirect(ATLAS, 0);
    expect(atlasBakePoolStats.keepBytes).toBe(64 * 1024 * 1024);
    expect(atlasBakePoolStats.bigPageBytes, "the line is a fact about the assets, not about the device").toBe(
      BIG_PAGE_BYTES
    );
    // Which is exactly why it is a constant. card_atlas_0 is 62.6MB — UNDER a 64MB share — so a line derived from
    // `keepBytes` would budget it there, and the first 16MB ui atlas to arrive would evict it again.
    expect(4032 * 4072 * 4, "the biggest page this game ships fits an 8GB share").toBeLessThan(
      atlasBakePoolStats.keepBytes
    );
  });

  it("configures both halves on one message, and publishes the share and the line a device ended up with", () => {
    stubDevice(8, undefined); // the reported burst's own device: a browser that reports no deviceMemory at all
    __resetAtlasBakePoolForTest();
    bakeDirect(ATLAS, 0);
    expect(workers.length, "unreported memory is not treated as small").toBe(2);
    expect(workers[0].sent[0]).toEqual({
      type: "config",
      keepBytes: 32 * 1024 * 1024,
      dropIdleMs: "off",
      bigPageBytes: BIG_PAGE_BYTES
    });
    // …and all three terms of the residency bound are readable from one probe: a worker holds `keepBytes` of share
    // plus one page at or above `bigPageBytes`, so this pool is bounded at 2 × (32MB + the biggest page).
    expect([
      atlasBakePoolStats.budgetBytes,
      atlasBakePoolStats.keepBytes,
      atlasBakePoolStats.bigPageBytes
    ]).toEqual([64 * 1024 * 1024, 32 * 1024 * 1024, BIG_PAGE_BYTES]);
  });

});

// --- the hard cap: TWO decodes per page, on every device --------------------------------------------------------
//
// The tier above buys memory back on a small device by paying for at most ONE re-decode per demand gap — but a gap
// is the RHYTHM of this game, not an event, so "one per gap" is unbounded over a session. The pool watches its own
// `atlas` reports and pins a page it has seen decoded twice: `keepPage: true` for every later job, forever, which
// is already the worker's "do not arm a drop for this page" signal. No new message, no worker change.
describe("a page decoded twice is pinned", () => {
  it("sends keepPage:true for every later job once a page has cost two decodes", () => {
    usePoolSize(1); // one worker, so every job for the page lands in the same `sent` log
    useIdleDropTier(); // …on the tier where a page can be given back at all
    bakeDirect(ATLAS, 0);
    expect(workers[0].bakes[0].keepPage, "nothing queued behind it, and one load is not a pattern").toBe(false);
    workers[0].finishBake(16 * 1024 * 1024); // load 1
    workers[0].release(ATLAS, 16 * 1024 * 1024); // …the idle drop this tier still takes

    bakeDirect(ATLAS, 1);
    expect(workers[0].bakes[1].keepPage, "still one load: the drop is still allowed to happen").toBe(false);
    workers[0].finishBake(16 * 1024 * 1024); // load 2 — this page has now been paid for twice

    bakeDirect(ATLAS, 2);
    expect(workers[0].bakes[2].keepPage, "…and from here it is pinned").toBe(true);
    workers[0].finishBake(16 * 1024 * 1024);
    workers[0].release(ATLAS, 16 * 1024 * 1024, "budget"); // an LRU eviction is NOT the pin's business
    bakeDirect(ATLAS, 3);
    expect(workers[0].bakes[3].keepPage, "the pin outlives an eviction of the page it names").toBe(true);
    workers[0].finishBake(16 * 1024 * 1024); // load 3 — forced by the LRU, not by an idle drop

    expect(atlasBakePoolStats.atlasReleased, "one idle drop, and no second one").toBe(1);
  });

  it("pins the page that was decoded twice and nothing else", () => {
    usePoolSize(1);
    useIdleDropTier();
    bakeDirect(ATLAS, 0);
    workers[0].finishBake(16 * 1024 * 1024);
    workers[0].release(ATLAS, 16 * 1024 * 1024);
    bakeDirect(ATLAS, 1);
    workers[0].finishBake(16 * 1024 * 1024); // ATLAS: two loads ⇒ pinned

    bakeDirect(OTHER, 2);
    expect(workers[0].bakes[2].url).toBe(OTHER);
    expect(workers[0].bakes[2].keepPage, "a page on its first load is not pinned by its neighbour").toBe(false);
    workers[0].finishBake(16 * 1024 * 1024);
    bakeDirect(ATLAS, 3);
    expect(workers[0].bakes[3].keepPage).toBe(true);
  });
});

// --- dispatch ---------------------------------------------------------------------------------------------------

describe("worker choice", () => {
  const slot = (holds: boolean, busy: boolean, bytes = 0) => ({ holds, busy, bytes });

  it("prefers an idle worker that already holds the page", () => {
    expect(chooseAtlasBakeWorker([slot(false, false), slot(true, false)], true)).toBe(1);
  });

  it("spreads onto the emptiest idle worker when a new copy of the page is affordable", () => {
    expect(chooseAtlasBakeWorker([slot(false, false, 62_000_000), slot(false, false, 0)], true)).toBe(1);
  });

  it("waits for a busy HOLDER rather than duplicating a page the budget cannot afford", () => {
    // Worker 0 holds a 62MB card atlas and is busy; worker 1 is idle and holds nothing. With the budget spent, a
    // second copy is refused and the job stays pending until the copy that already exists frees up.
    expect(chooseAtlasBakeWorker([slot(true, true), slot(false, false)], false)).toBe(-1);
    expect(chooseAtlasBakeWorker([slot(true, true), slot(false, false)], true), "…and goes wide when it fits").toBe(1);
  });

  it("returns -1 when nothing may take the job right now", () => {
    expect(chooseAtlasBakeWorker([slot(true, true)], true), "the only holder is busy").toBe(-1);
    expect(chooseAtlasBakeWorker([], true)).toBe(-1);
  });
});

// --- the baker on the worker path ---------------------------------------------------------------------------------

describe("baking through the pool", () => {
  it("ships regions to workers instead of encoding inline, and publishes the blobs they return", async () => {
    usePoolSize(4); // pool MECHANICS, not sizing — see usePoolSize
    request(ATLAS, 0);
    images[0].fireLoad();
    await pump();

    expect(workers.length, "8 cores / 8GB ⇒ four workers").toBe(4);
    expect(atlasBakePoolStats.poolSize).toBe(4);
    expect(dispatched()).toBe(1);
    expect(inlinePending.length, "nothing encoded on this thread").toBe(0);

    workers[0].finishBake();
    await pump();

    expect(atlasRegionBlobUrl(ATLAS, r(0), null)).toMatch(/^blob:/);
    expect(atlasBakeStats.baked).toBe(1);
    expect(atlasBakeStats.workerBaked).toBe(1);
    expect(atlasBakeStats.poolSize).toBe(4);
    expect(atlasBakeStats.workerFailed).toBe(0);
    expect(atlasBakeStats.slowestSyncMs, "the main thread only posted a message").toBe(0);
  });

  it("runs poolSize regions CONCURRENTLY once the page's cost is known AND its queue clears the amortization bar", async () => {
    usePoolSize(4); // pool MECHANICS, not sizing — see usePoolSize
    const { AMORTIZE_QUEUE_REGIONS } = __atlasBakePoolTuningForTest;
    // Comfortably past the bar: the cascade below opens 3 fresh copies (worker1, worker2, worker3) in sequence
    // as part of the SAME placement pass, each one shrinking the page's own queue by one, so the margin has to
    // survive that many removals and still clear AMORTIZE_QUEUE_REGIONS on the last of them. Going straight to
    // `bakeAtlasRegionInWorker` (not `request()`) is deliberate: the real baker pipeline never hands the pool
    // more than `poolSize` concurrent jobs for one page (see the note above `bakeDirect`), so a queue this deep
    // can only be built by talking to the pool directly.
    const total = AMORTIZE_QUEUE_REGIONS + 10;
    for (let x = 0; x < total; x++) bakeDirect(ATLAS, x);

    // MEMORY FIRST: until one worker has reported what this page costs, a second copy of it is not started —
    // four workers each fetching and decoding the same 62.6MB card atlas would be the worst possible open.
    expect(dispatched(), "the first copy of a page is exclusive").toBe(1);

    workers[0].finishBake(16 * 1024 * 1024); // …and now the pool knows it is a 16MB page

    expect(dispatched(), "four bakes in flight, one per worker").toBe(5);
    expect(workers.filter((w) => w.bakes.length > 0).length, "every worker ends up holding a copy").toBe(4);
    expect(atlasBakePoolStats.atlasBytes).toBe(16 * 1024 * 1024);
  });

  it("does NOT open a second copy while the page's own queue is below the amortization bar", async () => {
    const { AMORTIZE_QUEUE_REGIONS } = __atlasBakePoolTuningForTest;
    // Well under the ~70-region break-even: a second copy of this 16MB page is well within the byte budget, but
    // there is not enough of the page's OWN work queued to earn back the ~590ms decode a copy would cost.
    expect(AMORTIZE_QUEUE_REGIONS, "sanity: the fixture below must stay under this").toBeGreaterThan(5);
    for (let x = 0; x < 5; x++) bakeDirect(ATLAS, x);
    workers[0].finishBake(16 * 1024 * 1024);

    expect(workers.filter((w) => w.bakes.length > 0).length, "only the existing holder ever bakes this page").toBe(
      1
    );
    expect(atlasBakePoolStats.atlasAmortizedWaits, "the deferred regions are counted").toBeGreaterThan(0);

    // …and they still all get baked — funnelled through the one holder rather than dropped.
    while (workers[0].outstanding > 0) {
      workers[0].finishBake(16 * 1024 * 1024);
    }
    expect(atlasBakePoolStats.workerBaked).toBe(5);
  });

  // The two specs below pin the exact break-even: at the moment worker 0's report unblocks the queue (before
  // that pass removes anything itself), the page's own queue is `total - 1` regions deep. `AMORTIZE_QUEUE_REGIONS`
  // total requests puts that check one region short of the bar; `AMORTIZE_QUEUE_REGIONS + 1` puts it exactly on
  // the bar (`>=`, not `>`).
  it("does NOT open a second copy one region short of AMORTIZE_QUEUE_REGIONS", async () => {
    const { AMORTIZE_QUEUE_REGIONS } = __atlasBakePoolTuningForTest;
    for (let x = 0; x < AMORTIZE_QUEUE_REGIONS; x++) bakeDirect(ATLAS, x);
    workers[0].finishBake(16 * 1024 * 1024);
    expect(workers.filter((w) => w.bakes.length > 0).length, "the queue was one short of the bar").toBe(1);
  });

  it("opens a second copy right at AMORTIZE_QUEUE_REGIONS", async () => {
    const { AMORTIZE_QUEUE_REGIONS } = __atlasBakePoolTuningForTest;
    for (let x = 0; x < AMORTIZE_QUEUE_REGIONS + 1; x++) bakeDirect(ATLAS, x);
    workers[0].finishBake(16 * 1024 * 1024);
    expect(workers.filter((w) => w.bakes.length > 0).length, "the queue exactly cleared the bar").toBe(2);
  });

  it("refuses to replicate a page the pool's byte budget cannot afford, even with the queue to amortize it", async () => {
    const { AMORTIZE_QUEUE_REGIONS } = __atlasBakePoolTuningForTest;
    // card_atlas_0 is 4032×4072 = 62.6MB of RGBA. With the 128MB budget of an 8GB device exactly two copies fit,
    // so the third region has to wait for a worker that already holds it instead of spawning a third copy — the
    // queue below clears the amortization bar comfortably, so budget is the only thing left refusing it.
    const CARD_BYTES = 4032 * 4072 * 4;
    const total = AMORTIZE_QUEUE_REGIONS + 10;
    for (let x = 0; x < total; x++) bakeDirect(OTHER, x);
    workers[0].finishBake(CARD_BYTES);

    const holders = workers.filter((w) => w.bakes.length > 0).length;
    expect(holders, "one more copy fits in 128MB, a third does not").toBe(2);
    expect(atlasBakePoolStats.atlasBytes).toBe(CARD_BYTES);
  });

  it("gives a 2-core phone one worker and still takes the encode off its main thread", async () => {
    stubDevice(2, 2);
    __resetAtlasBakePoolForTest();
    for (let x = 0; x < 3; x++) request(ATLAS, x);
    images[0].fireLoad();
    await pump();

    expect(workers.length).toBe(1);
    expect(dispatched(), "serial, but off-thread").toBe(1);
    expect(inlinePending.length).toBe(0);

    workers[0].finishBake();
    await pump();
    expect(dispatched()).toBe(2);
    expect(atlasBakeStats.workerBaked).toBe(1);
  });

  it("prefers the worker that already holds the page, and spreads distinct pages across the pool", async () => {
    request(ATLAS, 0);
    images[0].fireLoad();
    await pump();
    workers[0].finishBake(); // worker 0 now reports holding ATLAS
    await pump();

    request(ATLAS, 1);
    await pump();
    expect(workers[0].bakes.length, "the holder took it").toBe(2);

    // A DISTINCT page's FIRST copy is always allowed (`holders === 0` bypasses the amortization bar entirely —
    // see placePending), so it does NOT queue behind worker0 just because worker0 is the busiest/first holder
    // around. If the amortization gate ever started gating first copies too, this would serialize every page
    // through one worker, which is exactly what holder-first dispatch exists to avoid.
    request(OTHER, 2);
    images[1].fireLoad(); // the second atlas page decodes
    await pump();
    expect(workers[0].bakes.length, "a DIFFERENT page goes elsewhere").toBe(2);
    expect(dispatched()).toBe(3);
  });

  // --- liveness: the amortization gate must never be able to starve a region forever -----------------------------

  it("bakes a single queued region for a BRAND-NEW page promptly, however high AMORTIZE_QUEUE_REGIONS is", async () => {
    const { AMORTIZE_QUEUE_REGIONS } = __atlasBakePoolTuningForTest;
    expect(AMORTIZE_QUEUE_REGIONS, "sanity: the queue below has nowhere near this many regions").toBeGreaterThan(1);
    // holders === 0 bypasses BOTH the byte budget and the amortization bar — a lone region of a page nobody has
    // touched yet cannot be made to wait for a queue depth that will never arrive.
    bakeDirect(ATLAS, 0);
    expect(dispatched(), "the first copy of any page is unconditional").toBe(1);
    expect(atlasBakePoolStats.atlasAmortizedWaits, "nothing was deferred").toBe(0);
    workers[0].finishBake();
    expect(atlasBakePoolStats.workerBaked).toBe(1);
  });

  it("re-loads a page once its sole holder is lost, instead of waiting on a holder that no longer exists", async () => {
    usePoolSize(4); // pool MECHANICS, not sizing — see usePoolSize
    // Default 4-worker pool: worker0 becomes the sole holder of ATLAS while workers 1-3 survive it dying, so this
    // exercises the SAME code path a mid-session worker crash would (`alive` excludes the dead one from `holders`
    // — see placePending) rather than the "whole pool is gone" path a different spec already covers.
    bakeDirect(ATLAS, 0); // first copy, holders === 0, goes to worker0
    workers[0].finishBake(16 * 1024 * 1024); // worker0 now the sole holder of ATLAS, and idle again

    workers[0].onerror?.({ message: "boom" }); // its only holder is gone; 3 workers survive
    expect(atlasBakePoolStats.poolSize, "the pool has survivors").toBe(3);

    // The page's byte size is still remembered (`pageBytes` is never cleared by a lost worker), but `holders`
    // over the ALIVE set is 0 now, so the amortization bar (which only applies once `holders > 0`) must not
    // apply either: this is treated as a first copy again, not a stuck second one.
    bakeDirect(ATLAS, 1);
    expect(dispatched(), "re-loadable — not stuck waiting for a holder that no longer exists").toBe(2);
  });
});

// --- keepPage: what the pool can honestly tell a worker about a page's future ------------------------------------
//
// A worker holds its decoded pages, and its LRU always keeps ONE of them — so a page bigger than the worker's
// whole `keepBytes` share (every card atlas, on anything under an 8GB device) is pinned there for the rest of the
// session once it has baked a single region. `keepPage` is the pool's answer to "is anything else queued for this
// page right now", which is what arms the worker's drop of such a page.
//
// Read the specs below for what that answer is WORTH: the baker hands the pool one region per drain task and only
// refills a slot when a bake settles, so this queue is usually empty at send time and `keepPage` is usually false
// even mid-burst. That is why the worker treats false as "arm a delayed drop", never as "drop it now" — see
// DROPPING A FINISHED OVERSIZED PAGE in atlasBakeWorker.ts.
describe("keepPage", () => {
  it("is false for a lone region — nothing else is queued for its page", () => {
    bakeDirect(ATLAS, 0);
    expect(workers[0].bakes.length).toBe(1);
    expect(workers[0].bakes[0].keepPage).toBe(false);
  });

  it("is true while more of that page's own regions are queued behind the holder", () => {
    bakeDirect(ATLAS, 0); // the first copy of a page is exclusive: 1 and 2 queue behind it
    bakeDirect(ATLAS, 1);
    bakeDirect(ATLAS, 2);
    expect(workers[0].bakes.length, "one copy, one job at a time").toBe(1);

    workers[0].finishBake(16 * 1024 * 1024);
    expect(workers[0].bakes.length).toBe(2);
    expect(workers[0].bakes[1].keepPage, "region 2 is still queued for this page").toBe(true);

    workers[0].finishBake(16 * 1024 * 1024);
    expect(workers[0].bakes.length).toBe(3);
    expect(workers[0].bakes[2].keepPage, "…and now it is the last one").toBe(false);
  });

  it("counts only THAT page's regions, not whatever else the queue happens to hold", () => {
    usePoolSize(1); // one worker, so a region of another page really does sit in the queue
    bakeDirect(ATLAS, 0);
    bakeDirect(OTHER, 1); // queued: the only worker is busy
    bakeDirect(ATLAS, 2); // …and so is this one
    expect(dispatched()).toBe(1);

    workers[0].finishBake(16 * 1024 * 1024);
    const second = workers[0].bakes[1];
    expect(second.url, "the queue is FIFO").toBe(OTHER);
    expect(second.keepPage, "an ATLAS region queued behind it says nothing about OTHER").toBe(false);
  });
});

// --- a page a worker gave back ------------------------------------------------------------------------------------
//
// TIER NOTE (Aug-19): an IDLE release only happens on a device under PAGE_DROP_MIN_MEMORY_GB now — the fixture
// device is 8GB, where the pool configures `dropIdleMs: "off"` — so the specs below that model one put the pool on
// that tier explicitly (`useIdleDropTier`). They are unchanged otherwise: what a release costs the pool, and how
// the stats attribute it, is the same question it always was, and it is the question the pin above answers a
// SECOND time around. A `budget` release (the LRU making room) is tier-independent and left alone.
describe("a released page", () => {
  it("gives its bytes back to the pool without ever counting as a load", () => {
    useIdleDropTier();
    bakeDirect(ATLAS, 0);
    workers[0].finishBake(16 * 1024 * 1024);
    expect([atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages]).toEqual([1, 1]);
    expect(atlasBakePoolStats.atlasBytes).toBe(16 * 1024 * 1024);

    workers[0].release(ATLAS, 16 * 1024 * 1024);

    expect(atlasBakePoolStats.atlasBytes, "residency is the worker's own count, and it dropped").toBe(0);
    expect(atlasBakePoolStats.atlasReleased, "…attributed to the idle drop").toBe(1);
    expect(atlasBakePoolStats.atlasEvicted).toBe(0);
    // The two stats a device probe reads together must not move: a release is not decode work, it is the opposite.
    expect([atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages]).toEqual([1, 1]);
  });

  it("counts an LRU eviction apart from a demand-ended drop", () => {
    bakeDirect(ATLAS, 0);
    workers[0].finishBake(16 * 1024 * 1024);
    workers[0].release(ATLAS, 16 * 1024 * 1024, "budget");
    expect([atlasBakePoolStats.atlasReleased, atlasBakePoolStats.atlasEvicted]).toEqual([0, 1]);
  });

  // THE HONEST COST OF THE DROP, pinned rather than hoped away. Releasing a page is exactly what makes a later
  // region of it pay for a second ~590ms decode, and the amortization gate does NOT prevent it — that gate only
  // guards SECOND copies, and after a release `holders === 0`, which is the case that bypasses it. So the cost is
  // real, it is bounded at one re-decode per gap in demand, and it shows up where the Aug-14 round taught us to
  // look: `atlasLoads` above `atlasPages`, with `atlasReleased` naming the cause.
  it("re-loads on the next region — and says so in the stats", () => {
    useIdleDropTier();
    bakeDirect(ATLAS, 0);
    workers[0].finishBake(16 * 1024 * 1024);
    workers[0].release(ATLAS, 16 * 1024 * 1024);

    bakeDirect(ATLAS, 1);
    expect(dispatched(), "holders === 0 again, so this is a first copy and goes straight out").toBe(2);
    workers[0].finishBake(16 * 1024 * 1024);

    expect([atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages], "one page, decoded twice").toEqual([
      2, 1
    ]);
    expect(atlasBakePoolStats.atlasReleased, "…and this is what caused it").toBe(1);
  });

  it("frees budget that was refusing another copy of the page", () => {
    usePoolSize(4); // pool MECHANICS, not sizing — see usePoolSize
    const { AMORTIZE_QUEUE_REGIONS } = __atlasBakePoolTuningForTest;
    const CARD_BYTES = 4032 * 4072 * 4; // 62.6MB: exactly two copies fit an 8GB device's 128MB budget
    for (let x = 0; x < AMORTIZE_QUEUE_REGIONS + 10; x++) bakeDirect(OTHER, x);
    workers[0].finishBake(CARD_BYTES);
    workers[1].finishBake(CARD_BYTES);
    expect(workers.filter((w) => w.bakes.length > 0).length, "two copies fit, a third does not").toBe(2);

    // Worker 1 gives its copy back. A third copy is affordable again, so a region that was waiting for a holder
    // to free up goes out to a worker that will decode it — a release re-pumps this queue exactly like a report.
    workers[1].release(OTHER, CARD_BYTES, "budget");
    expect(workers.filter((w) => w.bakes.length > 0).length, "the freed bytes unblock the queue").toBe(3);
  });
});

// --- a realistic multi-page workload (Aug-14 device calibration) --------------------------------------------------
//
// A controlled device calibration on a moto g86 (54-region combat, one build, hiddenSamples 0) found the real
// session touches 8 DISTINCT atlas pages, and larger pools paid for redundant
// decodes purely from the pool opening extra copies of a page other queued regions were about to reuse:
//   pool 1: atlasLoads 8 / atlasPages 8 (0 redundant — a single worker can only ever hold ONE copy of anything)
//   pool 2: atlasLoads 14 / atlasPages 8, and 12 / 8 on a repeat run (6 redundant decodes)
//   pool 4: atlasLoads 11 / atlasPages 8, and 10 / 8 on a repeat run (2-3 redundant decodes)
// This is the strongest pin for the fix: drive something SHAPED like that session through the REAL baker
// pipeline (not the pool's API directly — see `bakeDirect`'s note) and check the pool never pays for a page
// twice, however the pool happens to be sized.
describe("realistic multi-page workload (regression pin for atlasLoads:9 / atlasPages:7)", () => {
  const PAGES = [
    ATLAS,
    OTHER,
    THIRD,
    "/res/images/atlases/card_atlas_0.png",
    "/res/images/atlases/card_atlas_2.png",
    "/res/images/atlases/compressed_0.png",
    "/res/images/atlases/ui_atlas_1.png",
    "/res/images/atlases/relic_atlas_2.png"
  ];
  const REGIONS_PER_PAGE = 7; // 8 × 7 = 56, in the ballpark of the device session's 54

  /** Answer whatever any worker has outstanding, and let the baker's own drain refill the pool, until nothing is
   *  left running anywhere — the shape of "just let combat keep playing until the queue empties". */
  async function drainToCompletion(): Promise<void> {
    for (let i = 0; i < 500 && workers.some((w) => w.outstanding > 0); i++) {
      for (const w of workers) {
        while (w.outstanding > 0) {
          w.finishBake();
        }
      }
      await pump();
    }
  }

  it("keeps atlasLoads equal to atlasPages with the default pool (4 workers)", async () => {
    let x = 0;
    for (const url of PAGES) {
      for (let i = 0; i < REGIONS_PER_PAGE; i++) {
        request(url, x++);
      }
    }
    for (const img of images) {
      img.fireLoad();
    }
    await pump();
    await drainToCompletion();

    expect(atlasBakeStats.baked, "every region baked, none dropped").toBe(PAGES.length * REGIONS_PER_PAGE);
    expect(
      [atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages],
      "no page paid for a decode twice"
    ).toEqual([PAGES.length, PAGES.length]);
    // …and the same two numbers are on the BAKE stats, which is the record a device probe reads
    // (`window.__mirrorAtlasBakeStats`): "did anything decode twice" must not need a second global to answer.
    expect([atlasBakeStats.atlasLoads, atlasBakeStats.atlasPages]).toEqual([PAGES.length, PAGES.length]);
  });

  it("keeps atlasLoads equal to atlasPages with a smaller pool (2 workers) too", async () => {
    stubDevice(3, 4); // resolveAtlasBakePoolSize(3, 4) === 2
    __resetAtlasBakePoolForTest();
    let x = 0;
    for (const url of PAGES) {
      for (let i = 0; i < REGIONS_PER_PAGE; i++) {
        request(url, x++);
      }
    }
    for (const img of images) {
      img.fireLoad();
    }
    await pump();
    await drainToCompletion();

    expect(atlasBakeStats.baked).toBe(PAGES.length * REGIONS_PER_PAGE);
    expect([atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages]).toEqual([PAGES.length, PAGES.length]);
  });

  it("keeps atlasLoads equal to atlasPages with a single worker too (the device sweep's own zero-redundancy baseline)", async () => {
    stubDevice(2, 1); // resolveAtlasBakePoolSize(2, 1) === 1
    __resetAtlasBakePoolForTest();
    let x = 0;
    for (const url of PAGES) {
      for (let i = 0; i < REGIONS_PER_PAGE; i++) {
        request(url, x++);
      }
    }
    for (const img of images) {
      img.fireLoad();
    }
    await pump();
    await drainToCompletion();

    expect(atlasBakeStats.baked).toBe(PAGES.length * REGIONS_PER_PAGE);
    expect([atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages]).toEqual([PAGES.length, PAGES.length]);
  });
});

// --- STRIPS: N cells of one page, composed and encoded ONCE, in the worker -----------------------------------------
//
// The enemy-intent glyph cycles its frames on the compositor: every frame side by side in ONE strip image walked by
// a `translate`/`steps(N)` animation (see mirror/intentStrip.ts). Building that strip is a region bake with more
// crops in it, so it rides this same pipeline — one queue entry, one worker job, one encode — rather than N region
// bakes plus a main-thread composition. These specs pin what makes that a real off-thread win and not a rename:
// ONE job for the whole set, the composition happening WORKER-SIDE (the last block drives the real module), and a
// refusal degrading to the caller's own composition rather than to a main-thread encode.
describe("strip bakes", () => {
  const STRIP_CELLS = [r(0), r(8), r(16), r(24)];

  function stripDirect(url: string, key = "strip|attack", cells = STRIP_CELLS): boolean {
    return bakeAtlasStripInWorker(key, url, cells, 8, 8, () => {});
  }

  it("hands the WHOLE set to one worker as a single strip job", () => {
    expect(stripDirect(ATLAS)).toBe(true);
    expect(dispatched(), "four frames, ONE job").toBe(1);
    const strip = workers[0].strips[0];
    expect(strip.url).toBe(ATLAS);
    expect(strip.cells).toEqual(STRIP_CELLS);
    expect([strip.cellW, strip.cellH]).toEqual([8, 8]);
    // Nothing about it is special to the pool: it queues, holds and releases its page exactly like a region.
    expect(strip.keepPage).toBe(false);
  });

  it("publishes the worker's blob and counts it apart from region bakes", () => {
    let published: Blob | null = null;
    bakeAtlasStripInWorker("strip|attack", ATLAS, STRIP_CELLS, 8, 8, (blob) => {
      published = blob;
    });
    workers[0].finishBake();

    expect(published, "the strip came back as ONE blob").toBeInstanceOf(Blob);
    expect(inlinePending.length, "nothing was composed on this thread").toBe(0);
    expect(atlasBakePoolStats.workerBaked).toBe(1);
    expect(atlasBakePoolStats.stripBaked, "…and a probe can tell it was a strip").toBe(1);
    expect(atlasBakePoolStats.stripFailed).toBe(0);
  });

  it("shares a page with the region jobs around it — a strip is not a second copy", async () => {
    request(ATLAS, 0);
    images[0].fireLoad();
    await pump();
    workers[0].finishBake(16 * 1024 * 1024); // worker 0 now holds ATLAS
    stripDirect(ATLAS);
    expect(workers[0].bakes.length, "holder-first placement applies to a strip too").toBe(2);
    expect([atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages]).toEqual([1, 1]);
  });

  it("REFUSES a strip whose cells span two pages, rather than half-modelling it", () => {
    expect(
      bakeAtlasStripInWorker("strip|mixed", ATLAS, STRIP_CELLS, 8, 8, () => {}),
      "single page — accepted"
    ).toBe(true);
    // The pool keys placement, residency and keepPage on ONE url per job, so a two-page strip is not expressible.
    // The caller's fallback (its own canvas composition) is correct, so refusing is the honest answer.
    expect(dispatched()).toBe(1);
  });

  it("reports a worker-side strip failure as a refusal the caller can fall back from", () => {
    let settled: Blob | null | undefined;
    bakeAtlasStripInWorker("strip|attack", ATLAS, STRIP_CELLS, 8, 8, (blob) => {
      settled = blob;
    });
    workers[0].failBake();
    expect(settled, "null = 'bake it yourself'").toBeNull();
    expect(atlasBakePoolStats.stripFailed).toBe(1);
    expect(inlinePending.length, "…and the pool never started a main-thread encode for it").toBe(0);
  });
});

// --- the stall backstop on the worker path ------------------------------------------------------------------------
//
// R11 Aug-14, SECOND device probe (moto g86, 60s of real recorded combat over a real WebSocket, own visible tab,
// workers on, pool 4). The main-thread half of the new criterion worked — slow 0, syncTrips 0, slowestSyncMs 7.0,
// parked 0 — and the WALL backstop tripped anyway:
//   {"baked":64,"stalled":3,"slowestMs":2725.3,"syncTotalMs":108.2,"trips":1,"stallTrips":1,"requeued":34,
//    "poolSize":4,"workerMsTotal":4680.7,"workerEncodeMsTotal":544.9,"workerSlowestMs":1837.4,"atlasLoads":7}
// A worker bake's wall is three unrelated things added together: the pool's queue wait (2,725.3 - 1,837.4 ≈ 888ms
// on the worst bake — 64 regions through 4 workers HAS to queue), a ONE-OFF page decode (4,680.7 - 544.9 = 88% of
// all worker time, paid in full by the first region of each of 7 pages and by nobody after it), and the region's
// own encode (544.9ms over 64 regions, ~8.5ms each). Only the third is evidence about this device. These specs pin
// that the backstop reads it and nothing else.
describe("the stall backstop measures work, not waiting", () => {
  it("does NOT strike on POOL QUEUE WAIT, however long the bake's wall ends up", async () => {
    usePoolSize(4); // pool MECHANICS, not sizing — see usePoolSize
    const { BAKE_STALL_MS } = __atlasBakeTuningForTest;
    for (let x = 0; x < 4; x++) request(ATLAS, x);
    images[0].fireLoad();
    await pump();
    expect(dispatched(), "the first copy of a page is exclusive — the other three queue").toBe(1);

    // …and they queue for longer than the whole backstop while worker 0 fetches and decodes the page. Only 4
    // regions are ever queued on this page — far below the amortization bar — so the rest do NOT fan out to
    // fresh copies; they wait for worker 0 and go out one at a time as it frees up.
    clockMs += BAKE_STALL_MS + 700;
    workers[0].finishBake(16 * 1024 * 1024, { workerMs: BAKE_STALL_MS + 600, encodeMs: 6 });
    await pump();
    expect(dispatched(), "the next one goes to the same holder, not a fresh copy").toBe(2);
    while (workers[0].outstanding > 0) {
      workers[0].finishBake(16 * 1024 * 1024, { workerMs: 9, encodeMs: 6 });
    }
    await pump();

    expect(atlasBakeStats.baked).toBe(4);
    const wallNote = "the WALL was past the backstop — the pre-fix criterion would have fired";
    expect(atlasBakeStats.slowestMs, wallNote).toBeGreaterThan(BAKE_STALL_MS);
    expect(atlasBakeStats.slowestQueuedMs, "…and that wall was queue latency").toBeGreaterThan(BAKE_STALL_MS);
    expect(atlasBakeStats.stalled, "which is waiting, not damage").toBe(0);
    expect(atlasBakeStats.disabled).toBe(false);
    expect(atlasBakeStats.trips).toBe(0);
  });

  it("does NOT charge a region for the ONE-OFF atlas decode it happened to trigger", async () => {
    const { BAKE_STALL_LIMIT, BAKE_STALL_MS, BAKE_WORKER_STALL_MS } = __atlasBakeTuningForTest;
    // One region each on three pages: every one of them is the first job for its page, so every one of them pays a
    // full fetch+decode inside its `workerMs`. Three in a row is the strike limit — if the decode counted, the
    // mechanism would suspend itself on a cold cache every session.
    const urls = [ATLAS, OTHER, THIRD];
    for (let i = 0; i < urls.length; i++) {
      request(urls[i], i);
      images[i].fireLoad();
      await pump();
      const worker = workers.find((w) => w.outstanding > 0);
      expect(worker, "a worker took it").toBeDefined();
      // The shape the device measured: ~590ms of page decode per load, ~8.5ms of encode inside it. The wall ticks
      // for all of it (that is what the pre-fix criterion was reading), the worker's `encodeMs` for none of it.
      clockMs += BAKE_STALL_MS + 500;
      worker!.finishBake(16 * 1024 * 1024, { workerMs: BAKE_STALL_MS + 400, encodeMs: 9 });
      await pump();
    }

    expect(atlasBakeStats.baked).toBe(urls.length);
    expect(atlasBakeStats.baked, "…and that was the strike limit's worth of them").toBe(BAKE_STALL_LIMIT);
    expect(atlasBakeStats.slowestMs, "the WALL of every one of them cleared the old backstop").toBeGreaterThan(
      BAKE_STALL_MS
    );
    expect(atlasBakeStats.workerSlowestMs, "the JOBS were slow").toBeGreaterThan(BAKE_WORKER_STALL_MS);
    expect(atlasBakeStats.workerSlowestEncodeMs, "…but the encodes were not").toBeLessThan(BAKE_WORKER_STALL_MS);
    expect(atlasBakeStats.stalled).toBe(0);
    expect(atlasBakeStats.disabled).toBe(false);
    // A load is only excusable BECAUSE it is one-off, so the probe has to be able to check that: `atlasLoads`
    // above `atlasPages` is decode work the pool paid twice (a replicated copy, or an evicted page re-decoded).
    expect([atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages]).toEqual([urls.length, urls.length]);
  });

  it("DOES strike when the worker's own encode is pathological, and suspends at the limit", async () => {
    const { BAKE_STALL_LIMIT, BAKE_WORKER_STALL_MS, BAKE_SUSPEND_MS } = __atlasBakeTuningForTest;
    expect(BAKE_WORKER_STALL_MS, "~118x the 8.5ms/region this phone measured").toBe(1000);
    const slow = { workerMs: BAKE_WORKER_STALL_MS + 100, encodeMs: BAKE_WORKER_STALL_MS + 50 };
    for (let x = 0; x < 5; x++) request(ATLAS, x);
    images[0].fireLoad();
    await pump();

    workers[0].finishBake(16 * 1024 * 1024, slow); // strike 1 (and the page's cost is now known)
    await pump();
    expect(atlasBakeStats.stalled).toBe(1);
    expect(atlasBakeStats.disabled, "one is not a verdict").toBe(false);

    let struck = 1;
    for (const w of workers) {
      while (w.outstanding > 0 && struck < BAKE_STALL_LIMIT) {
        w.finishBake(16 * 1024 * 1024, slow);
        struck += 1;
      }
    }
    await pump();

    expect(atlasBakeStats.stalled).toBe(BAKE_STALL_LIMIT);
    expect(atlasBakeStats.slow, "the main thread was never the problem").toBe(0);
    expect(atlasBakeStats.disabled).toBe(true);
    expect(atlasBakeStats.disabledReason).toBe("stall");
    expect([atlasBakeStats.syncTrips, atlasBakeStats.stallTrips]).toEqual([0, 1]);
    expect(atlasBakeStats.suspendedUntilMs).toBe(clockMs + BAKE_SUSPEND_MS);
  });

  it("judges a region the pool REFUSED on what its inline retry cost, not on the worker time it wore first", async () => {
    const { BAKE_STALL_MS } = __atlasBakeTuningForTest;
    request(ATLAS, 0);
    images[0].fireLoad();
    await pump();

    clockMs += BAKE_STALL_MS + 500; // the worker held it this long and then could not finish it
    workers[0].failBake();
    await pump();
    expect(inlinePending.length, "it fell back to this thread").toBe(1);

    clockMs += 5; // …where the encode was quick
    inlinePending.shift()!(new Blob([""]));
    await pump();

    expect(atlasBakeStats.baked).toBe(1);
    expect(atlasBakeStats.slowestMs).toBeGreaterThan(BAKE_STALL_MS);
    expect(atlasBakeStats.slowestInlineMs, "only the retry is charged to the inline backstop").toBeLessThan(50);
    expect(atlasBakeStats.stalled).toBe(0);
    expect(atlasBakeStats.disabled).toBe(false);
  });
});

// --- degradation ---------------------------------------------------------------------------------------------------

describe("degrading to the inline path", () => {
  it("re-bakes a region inline when its worker job fails", async () => {
    request(ATLAS, 0);
    images[0].fireLoad();
    await pump();

    workers[0].failBake();
    await pump();

    expect(inlinePending.length, "the region fell back to this thread").toBe(1);
    inlinePending.shift()!(new Blob([""]));
    await pump();
    expect(atlasRegionBlobUrl(ATLAS, r(0), null)).toMatch(/^blob:/);
    expect(atlasBakeStats.failed, "…and was never counted as a failed region").toBe(0);
    expect(atlasBakeStats.workerFailed).toBe(1);
  });

  it("hands back regions still WAITING on a page that just failed in a worker", async () => {
    usePoolSize(4); // pool MECHANICS, not sizing — see usePoolSize
    // Regions 1-3 are pending on the same page as region 0 (a second copy of an unmeasured page is refused), so
    // when region 0's load fails they would be pending against a page no worker will ever hold.
    for (let x = 0; x < 4; x++) request(ATLAS, x);
    images[0].fireLoad();
    await pump();
    expect(dispatched()).toBe(1);

    workers[0].failBake(true);
    await pump();

    expect(inlinePending.length, "every waiting region came back to this thread").toBe(4);
  });

  it("stops using the pool for a page the worker could not load", async () => {
    request(ATLAS, 0);
    images[0].fireLoad();
    await pump();
    workers[0].failBake(true); // the PAGE is unusable in a worker (fetch/decode failed)
    await pump();
    inlinePending.shift()!(new Blob([""]));
    await pump();

    request(ATLAS, 1);
    await pump();
    expect(dispatched(), "no further region of that page is dispatched").toBe(1);
    expect(inlinePending.length, "it goes straight inline").toBe(1);
  });

  it("re-queues the work of a worker that dies onto the survivors", async () => {
    usePoolSize(4); // pool MECHANICS, not sizing — see usePoolSize
    for (let x = 0; x < 6; x++) request(ATLAS, x);
    images[0].fireLoad();
    await pump();
    expect(workers[0].bakes.length).toBe(1);

    workers[0].onerror?.({ message: "boom" });
    await pump();

    expect(workers[0].terminated).toBe(true);
    expect(atlasBakePoolStats.workersLost).toBe(1);
    expect(atlasBakePoolStats.poolSize, "the pool shrinks to the survivors").toBe(3);
    expect(inlinePending.length, "a survivor took the orphaned region — no main-thread encode").toBe(0);
    expect(dispatched(), "and it is baking there").toBe(2);

    workers.find((w) => !w.terminated && w.bakes.length > 0)!.finishBake();
    await pump();
    expect(atlasRegionBlobUrl(ATLAS, r(0), null)).toMatch(/^blob:/);
    // The bake stats mirror the pool's counters on every settled bake, so the probe read-out follows too.
    expect(atlasBakeStats.poolSize).toBe(3);
  });

  it("falls back to the main thread when the LAST worker dies with work in hand", async () => {
    stubDevice(2, 2); // one worker, so losing it loses the pool
    __resetAtlasBakePoolForTest();
    request(ATLAS, 0);
    images[0].fireLoad();
    await pump();
    expect(workers.length).toBe(1);

    workers[0].onerror?.({ message: "boom" });
    await pump();

    expect(atlasBakePoolStats.poolSize).toBe(0);
    expect(inlinePending.length, "its region was re-baked here, not dropped").toBe(1);
    inlinePending.shift()!(new Blob([""]));
    await pump();
    expect(atlasRegionBlobUrl(ATLAS, r(0), null)).toMatch(/^blob:/);
  });

  it("bakes a FRACTIONAL region inline — the worker crop is only pixel-exact for whole rects", async () => {
    atlasRegionBlobUrl(ATLAS, { x: 4.5, y: 0, width: 8, height: 8 }, "node-frac");
    images[0].fireLoad();
    await pump();

    expect(dispatched(), "not handed to a worker").toBe(0);
    expect(inlinePending.length).toBe(1);
    inlinePending.shift()!(new Blob([""]));
    await pump();
    expect(atlasRegionBlobUrl(ATLAS, { x: 4.5, y: 0, width: 8, height: 8 }, null)).toMatch(/^blob:/);
  });

  it("falls back to the inline path when the Worker cannot be constructed at all", async () => {
    __resetAtlasBakePoolForTest();
    __setAtlasBakeWorkerFactoryForTest(() => {
      throw new Error("blocked by CSP");
    });
    request(ATLAS, 0);
    images[0].fireLoad();
    await pump();

    expect(atlasBakeStats.poolSize).toBe(0);
    expect(inlinePending.length).toBe(1);
    inlinePending.shift()!(new Blob([""]));
    await pump();
    expect(atlasRegionBlobUrl(ATLAS, r(0), null)).toMatch(/^blob:/);
  });

  it("falls back when the host has no Worker at all", async () => {
    vi.stubGlobal("Worker", undefined);
    __resetAtlasBakePoolForTest();
    request(ATLAS, 0);
    images[0].fireLoad();
    await pump();

    expect(atlasBakeStats.poolSize).toBe(0);
    expect(inlinePending.length).toBe(1);
  });
});

// --- INSIDE the worker (atlasBakeWorker.ts) -----------------------------------------------------------------------
//
// Everything above drives the POOL with a fake worker. These drive the real worker module through the only seam it
// has — `self.onmessage` in, `self.postMessage` out, the same one the browser uses — because the two residency
// bugs this round fixes live on that side of the wire:
//   * the LRU always keeps ONE page, so a page bigger than the worker's whole `keepBytes` share stays resident for
//     the session however little work it has left (62.6MB per worker, against a 48MB pool budget on a 2GB phone),
//   * and the eviction that bounds residency ran AFTER the new page was inserted, i.e. after its full-page
//     readback had already been allocated, so it never bounded the decode's own peak.
// The worker module holds its residency in module scope, so each spec gets a fresh copy of it (resetModules + a
// dynamic import) rather than inheriting the last one's pages.
describe("the worker's own page residency", () => {
  const PAGE = "/res/images/atlases/card_atlas_0.png";
  const PAGE_B = "/res/images/atlases/card_atlas_1.png";
  const PAGE_W = 64;
  const PAGE_H = 64;
  const PAGE_BYTES = PAGE_W * PAGE_H * 4; // 16,384 — "oversized" is relative to the keepBytes the test configures

  type Posted = Record<string, unknown>;
  const scope = self as unknown as {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: (message: unknown) => void;
  };

  let posted: Posted[] = [];
  let fetched: string[] = [];
  /** A snapshot of everything posted so far, taken DURING each page's readback (see the eviction-order spec). */
  let readbackSnapshots: string[][] = [];
  /** When set, `convertToBlob` parks until the test resolves it — an encode still outstanding. */
  let gateEncode = false;
  let parkedEncodes: Array<() => void> = [];

  /**
   * The worker's `ImageData`, faked — `data` carries a byteLength and nothing else. The module reads
   * `pixels.data.byteLength` for a page's size and `set`/`subarray` to move rows around, and nothing in this file
   * asserts on a pixel, while the hold-slot specs below present the game's REAL page sizes (a 62.6MB card atlas,
   * ten pages of them) to the REAL budget a device resolves. Allocating those for real would mean this one spec
   * file zero-filling and copying hundreds of MB to prove an accounting rule.
   */
  class WorkerImageData {
    data: { byteLength: number; set: () => void; subarray: () => unknown };
    constructor(
      public width: number,
      public height: number
    ) {
      this.data = { byteLength: width * height * 4, set: () => {}, subarray: () => this.data };
    }
  }

  /**
   * Per-url page sizes, so a fixture can present a MIX (a 62.6MB card atlas next to a 16.0MB ui one) instead of
   * the uniform page every spec written before the hold slot assumes. A url that is not in here decodes at the
   * caller's fallback size, so nothing else in this block changes.
   */
  let pageSizes = new Map<string, { width: number; height: number }>();

  /** Declare a page's decoded size by BYTES rather than by a rectangle (w × h × 4 = bytes). */
  function sizePage(url: string, bytes: number): void {
    pageSizes.set(url, { width: Math.max(1, Math.round(bytes / 4)), height: 1 });
  }

  /**
   * The size a decode should report, found from the url the `fetch` stub tagged its blob with. (The worker hands
   * `createImageBitmap` the fetched blob, never the url — tagging the blob is how a fixture gets the two back
   * together without changing the module's own shape.)
   */
  function bitmapFor(source: unknown, fallback: { width: number; height: number }): Promise<unknown> {
    const url = (source as { pageUrl?: string } | null)?.pageUrl;
    const size = (url === undefined ? undefined : pageSizes.get(url)) ?? fallback;
    return Promise.resolve({ width: size.width, height: size.height, close: () => {} });
  }

  /** Every canvas the worker made, and every cell it wrote into one — the strip specs read both. */
  let canvases: WorkerCanvas[] = [];
  let encodes = 0;

  class WorkerCanvas {
    puts: Array<{ x: number; width: number; height: number }> = [];
    draws: Array<{ x: number; width: number; height: number }> = [];
    constructor(
      public width: number,
      public height: number
    ) {
      canvases.push(this);
    }
    getContext(): Record<string, unknown> {
      return {
        clearRect: () => {},
        drawImage: (_bitmap: unknown, x: number, _y: number, w: number, h: number) => {
          this.draws.push({ x, width: w, height: h });
        },
        putImageData: (data: WorkerImageData, x: number) => {
          this.puts.push({ x, width: data.width, height: data.height });
        },
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          readbackSnapshots.push(
            posted.map((m) => (m.type === "release" ? `release:${String(m.url)}` : String(m.type)))
          );
          return new WorkerImageData(w, h);
        }
      };
    }
    convertToBlob(): Promise<Blob> {
      encodes += 1;
      if (!gateEncode) {
        return Promise.resolve(new Blob([""]));
      }
      return new Promise((resolve) => {
        parkedEncodes.push(() => resolve(new Blob([""])));
      });
    }
  }

  /**
   * A `Worker` for the pool that is actually the real worker module: what the pool posts goes into its message
   * handler, and what it posts comes back out through `onmessage` (see the last spec in this block).
   */
  class BridgedWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onmessageerror: ((event: unknown) => void) | null = null;
    constructor(private readonly handler: (event: { data: unknown }) => void) {}
    postMessage(message: unknown): void {
      this.handler({ data: message });
    }
    terminate(): void {}
  }

  /** Load a FRESH copy of the worker module (its pages, its timers, its keepBytes), and hand back its tuning. */
  async function loadWorker(): Promise<{ DROP_IDLE_MS: number }> {
    vi.resetModules();
    const module = await import("@/mirror/atlasBakeWorker");
    return module.__atlasBakeWorkerTuningForTest;
  }

  /**
   * …and wire that fresh copy in as the pool's actual Worker, so a spec drives the REAL baker → REAL pool → REAL
   * worker module (the harness of "pays for no redundant decode through the real pipeline" below, hoisted because
   * the demand-gap specs need exactly the same one). The caller still chooses the device and resets the pool.
   */
  async function bridgeRealWorker(): Promise<{ DROP_IDLE_MS: number }> {
    const tuning = await loadWorker();
    const workerHandler = scope.onmessage!; // the module installed itself here; the bridge feeds it
    let bridged: BridgedWorker | null = null;
    vi.stubGlobal("postMessage", (message: unknown) => {
      posted.push(message as Posted);
      bridged?.onmessage?.({ data: message }); // worker → pool
    });
    vi.stubGlobal("createImageBitmap", (source: unknown) => bitmapFor(source, { width: 512, height: 512 }));
    __setAtlasBakeWorkerFactoryForTest(() => {
      bridged = new BridgedWorker(workerHandler);
      return bridged as unknown as Worker;
    });
    return tuning;
  }

  /**
   * …and the same bridge for a pool of MORE THAN ONE worker. The worker module keeps its pages, its `keepBytes`
   * and its timers in module scope, so two workers of one pool have to be two module INSTANCES or they are one
   * worker wearing two hats — and the residency question this block exists to ask is exactly the one that answer
   * would forge. Each instance is imported against its own `self`, which is the only thing they would otherwise
   * share: the module installs its handler on that scope and posts back through it, so a message reaches (and
   * comes from) the instance the pool thinks it is talking to.
   */
  async function spawnRealWorkers(count: number): Promise<void> {
    const instances: BridgedWorker[] = [];
    for (let i = 0; i < count; i++) {
      let bridge: BridgedWorker | null = null;
      const instanceScope = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage: (message: unknown) => {
          posted.push(message as Posted);
          bridge?.onmessage?.({ data: message }); // worker → pool
        }
      };
      vi.stubGlobal("self", instanceScope);
      vi.resetModules();
      await import("@/mirror/atlasBakeWorker");
      bridge = new BridgedWorker(instanceScope.onmessage!);
      instances.push(bridge);
    }
    vi.stubGlobal("createImageBitmap", (source: unknown) => bitmapFor(source, { width: 512, height: 512 }));
    let next = 0;
    __setAtlasBakeWorkerFactoryForTest(() => instances[next++] as unknown as Worker);
  }

  /** Run the baker's drain until `target` regions have baked. Bounded well under one idle window on purpose: a
   *  burst must finish INSIDE the drop's window, or the drop would be firing mid-burst rather than mid-gap. */
  async function drainBakes(target: number): Promise<void> {
    for (let i = 0; i < 12 && atlasBakeStats.baked < target; i++) {
      await pump(); // 64ms each ⇒ at most 768ms
    }
    expect(atlasBakeStats.baked, "the burst drained").toBe(target);
  }

  function send(request: Record<string, unknown>): void {
    scope.onmessage?.({ data: request });
  }

  let nextId = 0;
  function bakeInWorker(url: string, keepPage: boolean): void {
    nextId += 1;
    send({ type: "bake", id: nextId, key: `${url}|${nextId}`, url, x: 0, y: 0, width: 8, height: 8, keepPage });
  }

  /** Run the worker's promise chain out (fetch → blob → bitmap → readback → crop → encode). */
  async function settle(): Promise<void> {
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
    }
  }

  const types = (): string[] => posted.map((m) => String(m.type));
  const releases = (): Posted[] => posted.filter((m) => m.type === "release");

  beforeEach(() => {
    posted = [];
    fetched = [];
    readbackSnapshots = [];
    canvases = [];
    encodes = 0;
    gateEncode = false;
    parkedEncodes = [];
    nextId = 0;
    pageSizes = new Map();
    vi.stubGlobal("postMessage", (message: unknown) => {
      posted.push(message as Posted);
    });
    vi.stubGlobal("ImageData", WorkerImageData as unknown as typeof ImageData);
    vi.stubGlobal("OffscreenCanvas", WorkerCanvas as unknown as typeof OffscreenCanvas);
    vi.stubGlobal("createImageBitmap", (source: unknown) => bitmapFor(source, { width: PAGE_W, height: PAGE_H }));
    vi.stubGlobal("fetch", (url: string) => {
      fetched.push(url);
      // The blob carries the url it came from: `createImageBitmap` is where a page's size is decided, and it only
      // ever sees the blob (see bitmapFor).
      return Promise.resolve({ ok: true, blob: () => Promise.resolve({ pageUrl: url } as unknown as Blob) });
    });
  });

  afterEach(() => {
    scope.onmessage = null; // the module installed itself on this scope; don't leak it into the next spec
  });

  it("gives back a page bigger than its share once the pool says its work has run out", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    send({ type: "config", keepBytes: PAGE_BYTES - 1 }); // one page alone overruns this worker's whole share
    bakeInWorker(PAGE, false);
    await settle();

    expect(types(), "the region baked normally first").toEqual(["atlas", "blob"]);
    expect(releases(), "…and nothing was dropped out from under the encode").toEqual([]);

    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS);
    expect(releases()).toEqual([
      { type: "release", url: PAGE, bytes: PAGE_BYTES, totalBytes: 0, urls: [], reason: "idle" }
    ]);

    // …and it really let go of the pixels, by the worker's own accounting: the next region of that page has to
    // fetch and decode it again. THIS IS THE COST OF THE DROP — see `a released page` above for the pool-side half.
    bakeInWorker(PAGE, false);
    await settle();
    expect(fetched, "a second decode of the same page").toEqual([PAGE, PAGE]);
  });

  it("keeps a page the pool still has queued work for", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    send({ type: "config", keepBytes: PAGE_BYTES - 1 });
    bakeInWorker(PAGE, true); // keepPage: more regions of this page are queued
    await settle();

    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS * 4);
    expect(releases(), "nothing armed").toEqual([]);

    bakeInWorker(PAGE, true);
    await settle();
    expect(fetched, "the second region baked from the page already held").toEqual([PAGE]);
  });

  it("keeps a finished page that FITS its share — the LRU can manage that one", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    send({ type: "config", keepBytes: PAGE_BYTES * 4 });
    bakeInWorker(PAGE, false); // no more work queued, but the page is nowhere near the share
    await settle();

    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS * 4);
    expect(releases(), "a page worth holding is not worth a ~590ms re-decode").toEqual([]);
    bakeInWorker(PAGE, false);
    await settle();
    expect(fetched).toEqual([PAGE]);
  });

  // --- `dropIdleMs`: the policy the pool configures (see `the page-drop tier` above) ------------------------------

  it("never arms a drop at all under `dropIdleMs: off` — the 4GB+ policy", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    // The worst case the old policy had: a page far over this worker's share, with nothing queued behind it.
    send({ type: "config", keepBytes: PAGE_BYTES - 1, dropIdleMs: "off" });
    bakeInWorker(PAGE, false);
    await settle();

    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS * 10);
    expect(releases(), "the page stays decoded").toEqual([]);

    // …and THAT is the win: the next region of it, a whole demand gap later, costs no decode.
    bakeInWorker(PAGE, false);
    await settle();
    expect(fetched, "one decode across the gap").toEqual([PAGE]);
    expect(types()).toEqual(["atlas", "blob", "blob"]);
  });

  it("drops on the window the pool configured, not on its own default", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    send({ type: "config", keepBytes: PAGE_BYTES - 1, dropIdleMs: 500 });
    bakeInWorker(PAGE, false);
    await settle();

    await vi.advanceTimersByTimeAsync(499);
    expect(releases(), "not yet").toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(releases().map((m) => m.url), "…and on the configured window, well inside the default").toEqual([PAGE]);
    expect(500).toBeLessThan(DROP_IDLE_MS);
  });

  // The pool re-shares `keepBytes` whenever its own residency answer changes; the TIER is decided once, from the
  // device. So a config that omits `dropIdleMs` must leave the policy exactly where it was — otherwise a budget
  // re-share would silently put a 4GB+ device back on the small-device drop.
  it("keeps the policy when a later config only re-shares the budget", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    send({ type: "config", keepBytes: PAGE_BYTES * 4, dropIdleMs: "off" });
    send({ type: "config", keepBytes: PAGE_BYTES - 1 }); // …now the page counts as oversized
    bakeInWorker(PAGE, false);
    await settle();

    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS * 4);
    expect(releases(), "the tier survived a share that did not mention it").toEqual([]);
  });

  it("releases a drop already armed when the policy is switched off", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    send({ type: "config", keepBytes: PAGE_BYTES - 1, dropIdleMs: DROP_IDLE_MS });
    bakeInWorker(PAGE, false);
    await settle();

    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS / 2); // armed, half way through its window
    send({ type: "config", keepBytes: PAGE_BYTES - 1, dropIdleMs: "off" });
    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS * 4);
    expect(releases(), "a reversed decision must not still fire once").toEqual([]);
  });

  it("is configured with the same window the pool would send", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    // Two constants, one number, in two modules that cannot import each other (the pool importing the worker
    // module would bundle and RUN it on the main thread). This is the pin that keeps them the same window.
    expect(__atlasBakePoolTuningForTest.PAGE_DROP_IDLE_MS).toBe(DROP_IDLE_MS);
  });

  // This is WHY the drop is delayed instead of taken at the crop. `keepPage: false` only means "nothing queued
  // right now": the baker issues one bake per drain task, so at poolSize 1 every single region of a page arrives
  // with an empty queue behind it. A drop at the crop would re-decode the page for the very next region.
  it("cancels an armed drop when another region of that page arrives inside the window", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    send({ type: "config", keepBytes: PAGE_BYTES - 1 });
    bakeInWorker(PAGE, false);
    await settle();

    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS - 1);
    bakeInWorker(PAGE, false); // the next region of the burst, one tick before the window closes
    await settle();
    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS - 1);

    expect(releases(), "demand had not stopped after all").toEqual([]);
    expect(fetched, "…so it never paid for a second decode").toEqual([PAGE]);

    // The window restarts from the LAST use, so the page still goes when the burst genuinely ends.
    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS);
    expect(releases().map((m) => m.url)).toEqual([PAGE]);
  });

  it("evicts to make room BEFORE it reads the incoming page back, not after it is held", async () => {
    await loadWorker();
    // Room for one page, not two: decoding B has to evict A.
    send({ type: "config", keepBytes: PAGE_BYTES + 1 });
    bakeInWorker(PAGE, true);
    await settle();
    bakeInWorker(PAGE_B, true);
    await settle();

    expect(types()).toEqual(["atlas", "blob", "release", "atlas", "blob"]);
    expect(releases()).toEqual([
      { type: "release", url: PAGE, bytes: PAGE_BYTES, totalBytes: 0, urls: [], reason: "budget" }
    ]);
    // The ordering that matters is not "release before atlas" — it is that A was already gone when B's readback
    // ALLOCATED. That readback is a full RGBA copy of the page, so holding A across it is what made the peak
    // (held + bitmap + readback) instead of (bitmap + readback).
    expect(readbackSnapshots.length, "one banded readback per decode").toBe(2);
    expect(readbackSnapshots[0], "nothing to evict for the first page").toEqual([]);
    expect(readbackSnapshots[1], "A was released before B's pixels were allocated").toEqual([
      "atlas",
      "blob",
      `release:${PAGE}`
    ]);
  });

  // The observable half of the `page = null` in bake(): a drop must not be queued behind the encode that is still
  // outstanding. (Whether the BYTES are freed depends on that local binding being cleared — an async function's
  // suspended context keeps every in-scope binding alive across an await — and no test can see a free; the null
  // assignment is what makes this drop mean anything.)
  it("drops the page while the region's own encode is still outstanding", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    gateEncode = true;
    send({ type: "config", keepBytes: PAGE_BYTES - 1 });
    bakeInWorker(PAGE, false);
    await settle();
    expect(types(), "the encode has not come back yet").toEqual(["atlas"]);

    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS);
    expect(types(), "…and the page went anyway").toEqual(["atlas", "release"]);

    parkedEncodes.shift()!();
    await settle();
    expect(types(), "the region still lands").toEqual(["atlas", "release", "blob"]);
  });

  // THE PIN FOR THE WHOLE DESIGN. Everything else here fakes one side of the wire; this drives the REAL baker
  // through the REAL pool into the REAL worker module, at poolSize 1 (a 2-core phone) with `keepBytes` cranked so
  // low that EVERY page counts as oversized — the worst case a device can present to the drop.
  //
  // It is the experiment that rejected the obvious implementation. A drop taken straight after the crop would be
  // armed on every single region here, because at poolSize 1 the baker issues one bake per task and this pool's
  // queue is therefore EMPTY every time it hands the worker a job — `keepPage` is false on all 56 of them. That
  // version of the fix measures 56 loads for 8 pages (~33s of worker time at the 590ms/decode this device
  // session measured). The delayed drop measures 8, which is the number last round fought to get.
  it("pays for no redundant decode through the real pipeline, however oversized every page is", async () => {
    const { DROP_IDLE_MS } = await loadWorker();
    const workerHandler = scope.onmessage!; // the module installed itself here; the bridge below feeds it
    let bridged: BridgedWorker | null = null;
    vi.stubGlobal("postMessage", (message: unknown) => {
      posted.push(message as Posted);
      bridged?.onmessage?.({ data: message }); // worker → pool
    });
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 512, height: 512, close: () => {} }));
    __setAtlasBakeWorkerFactoryForTest(() => {
      bridged = new BridgedWorker(workerHandler);
      return bridged as unknown as Worker;
    });
    stubDevice(2, 2); // poolSize 1 — the case where this queue is empty at send time BY CONSTRUCTION
    __resetAtlasBakePoolForTest();
    __resetAtlasCacheForTest();

    // One region first, purely to spawn the pool — it configures the worker with this device's real share (48MB)
    // on spawn, and the point of this spec is the case where that share is too small for the page.
    request(ATLAS, 900);
    for (const img of images) img.fireLoad();
    await pump();
    expect(atlasBakePoolStats.poolSize, "a 2-core phone gets one worker").toBe(1);
    // …so crank it to 1 byte: now EVERY page in the workload counts as oversized and arms the drop the moment
    // its queue runs dry, which at poolSize 1 is every single region.
    send({ type: "config", keepBytes: 1 });

    const pages = [ATLAS, OTHER, THIRD, "/a/4.png", "/a/5.png", "/a/6.png", "/a/7.png", "/a/8.png"];
    const perPage = 7;
    const total = pages.length * perPage + 1; // + the warm-up region above
    let x = 0;
    for (const url of pages) {
      for (let i = 0; i < perPage; i++) request(url, x++);
    }
    for (const img of images) img.fireLoad();

    let pumps = 0;
    for (; pumps < 20 && atlasBakeStats.baked < total; pumps++) {
      await pump(); // 64ms each — the whole drain has to finish well inside DROP_IDLE_MS, and it does
    }
    expect(pumps * 64, "the drain fits inside the idle window, so no drop fires mid-run").toBeLessThan(
      DROP_IDLE_MS
    );

    expect(atlasBakeStats.baked, "every region baked off-thread").toBe(total);
    expect(inlinePending.length, "…none of it on this thread").toBe(0);
    expect(
      [atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages],
      "no page was decoded twice — this is what the delay buys"
    ).toEqual([pages.length, pages.length]);
    expect(atlasBakePoolStats.atlasEvicted, "the LRU still made room, page by page").toBe(pages.length - 1);

    // …and once the work really is over, the last page goes too: residency falls to nothing rather than being
    // pinned at one page by the LRU's always-keep-one floor.
    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS);
    expect(atlasBakePoolStats.atlasReleased, "the idle drop fired").toBe(1);
    expect(atlasBakePoolStats.atlasBytes).toBe(0);
  });

  // --- THE DEFECT THIS ROUND FIXES: a demand GAP between two bursts of the same page ------------------------------
  //
  // The shape a player produces every turn. A hand of cards bakes its regions, the queue empties, nothing asks for
  // that atlas again while the turn is played — and then a new hand asks for it. Under the old policy the page was
  // given back in the gap and the second hand paid ~590ms of worker time to decode it again, every single turn.
  // Both specs drive the REAL baker through the REAL pool into the REAL worker module, with `keepBytes` cranked so
  // low that the page is oversized (the only case the drop ever applied to) — the difference between them is the
  // DEVICE, and nothing else.
  const GAP_PAGE = ATLAS;

  it("decodes a page ONCE across a demand gap on a 4GB+ device — the drop is off there", async () => {
    const { DROP_IDLE_MS } = await bridgeRealWorker();
    usePoolSize(1); // one worker, so this is one residency and one decode count
    stubDevice(8, 8); // …on the tier that holds pages
    __resetAtlasBakePoolForTest();
    __resetAtlasCacheForTest();

    request(GAP_PAGE, 900); // spawns the pool, which configures the worker with this device's policy
    for (const img of images) img.fireLoad();
    await pump();
    expect(atlasBakePoolStats.poolSize).toBe(1);
    expect(atlasBakePoolStats.pageDropMs, "8GB ⇒ a decoded page stays decoded").toBe("off");
    send({ type: "config", keepBytes: 1 }); // every page is now oversized: the drop's own worst case

    for (let x = 0; x < 6; x++) request(GAP_PAGE, x); // the first hand
    await drainBakes(7);
    expect(atlasBakePoolStats.atlasLoads, "one page, one decode").toBe(1);

    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS * 2); // THE GAP: the turn is played, nothing bakes
    expect(atlasBakePoolStats.atlasReleased, "nothing was given back").toBe(0);

    for (let x = 100; x < 106; x++) request(GAP_PAGE, x); // the next hand
    await drainBakes(13);

    expect(
      [atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages],
      "the second hand cost NO decode — this is the whole round"
    ).toEqual([1, 1]);
    // …and one probe read says so: the pool's page counters are on the bake stats now, so a device session does
    // not need `__mirrorAtlasBakePoolStats` to answer "did anything decode twice".
    expect([atlasBakeStats.atlasLoads, atlasBakeStats.atlasPages]).toEqual([1, 1]);
    expect([atlasBakeStats.atlasReleased, atlasBakeStats.atlasEvicted, atlasBakeStats.atlasFailed]).toEqual([
      0, 0, 0
    ]);
    expect(inlinePending.length, "…none of it on this thread").toBe(0);
  });

  it("costs at most TWO decodes on a small device, however many gaps there are", async () => {
    const { DROP_IDLE_MS } = await bridgeRealWorker();
    usePoolSize(1);
    stubDevice(8, 2); // under 4GB: the 62.6MB is worth giving back, ONCE
    __resetAtlasBakePoolForTest();
    __resetAtlasCacheForTest();

    request(GAP_PAGE, 900);
    for (const img of images) img.fireLoad();
    await pump();
    expect(atlasBakePoolStats.pageDropMs).toBe(DROP_IDLE_MS);
    send({ type: "config", keepBytes: 1 });

    for (let x = 0; x < 6; x++) request(GAP_PAGE, x);
    await drainBakes(7);
    expect(atlasBakePoolStats.atlasLoads).toBe(1);

    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS * 2); // gap 1
    expect(atlasBakePoolStats.atlasReleased, "this tier does give the page back").toBe(1);
    expect(atlasBakePoolStats.atlasBytes).toBe(0);

    for (let x = 100; x < 106; x++) request(GAP_PAGE, x);
    await drainBakes(13);
    expect(atlasBakePoolStats.atlasLoads, "…and pays for it once: the tier's price").toBe(2);

    // THE CAP. The page has now been decoded twice, so the pool pinned it — a second gap cannot cost a third.
    await vi.advanceTimersByTimeAsync(DROP_IDLE_MS * 2); // gap 2
    expect(atlasBakePoolStats.atlasReleased, "no second drop").toBe(1);

    for (let x = 200; x < 206; x++) request(GAP_PAGE, x);
    await drainBakes(19);
    expect([atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages], "two decodes, and that is all").toEqual(
      [2, 1]
    );
    expect([atlasBakeStats.atlasLoads, atlasBakeStats.atlasPages, atlasBakeStats.atlasReleased]).toEqual([2, 1, 1]);
    expect(inlinePending.length).toBe(0);
  });

  // THE PROOF THAT THE STRIP IS COMPOSED WHERE IT CLAIMS TO BE. Everything in the `strip bakes` block above talks
  // to a FAKE worker; this drives the REAL worker module through the same `self.onmessage` seam the browser uses,
  // so what it asserts is the module's own behaviour: one page decode, N crops written into one canvas of the
  // strip's exact size, and exactly ONE encode — no main thread anywhere in it.
  it("composes a whole strip inside the worker: one page, one canvas, ONE encode", async () => {
    await loadWorker();
    send({ type: "config", keepBytes: PAGE_BYTES * 8 });
    send({
      type: "strip",
      id: 1,
      key: "strip|attack",
      url: PAGE,
      cells: [0, 1, 2, 3].map((i) => ({ x: i * 8, y: 0, width: 8, height: 8 })),
      cellW: 8,
      cellH: 8,
      keepPage: false
    });
    await settle();

    expect(types(), "one page load, one blob out").toEqual(["atlas", "blob"]);
    expect(fetched, "…and the four frames cost ONE fetch+decode between them").toEqual([PAGE]);
    expect(encodes, "ONE encode for the set, not one per frame").toBe(1);
    // The last canvas is the strip's: 4 cells of 8×8 side by side, each cell written at its own offset. (The
    // earlier canvases are the banded page readback — see readBack.)
    const strip = canvases[canvases.length - 1];
    expect([strip.width, strip.height]).toEqual([32, 8]);
    expect(strip.puts.map((p) => p.x), "cells land in frame order").toEqual([0, 8, 16, 24]);
    expect(strip.draws, "every cell was an exact fit — no resample needed").toEqual([]);
    const blob = posted.find((m) => m.type === "blob")!;
    expect(blob.key).toBe("strip|attack");
    expect(blob.encodeMs, "…and the encode is timed like a region's, so the same backstop judges it").toBeTypeOf(
      "number"
    );
  });

  it("SCALES a cell smaller than the cell box, the way the main-thread strip canvas does", async () => {
    await loadWorker();
    send({ type: "config", keepBytes: PAGE_BYTES * 8 });
    send({
      type: "strip",
      id: 1,
      key: "strip|mixed",
      url: PAGE,
      // Frame 1 is smaller than the cell box (the box is the biggest frame), so it is stretched to fill its cell —
      // exactly what paintIntentStrip's `ctx.scale(cellW/region.width, …)` does, and what the single-frame sprite
      // renders today. `putImageData` cannot scale, so that cell goes through an ImageBitmap + drawImage instead.
      cells: [
        { x: 0, y: 0, width: 8, height: 8 },
        { x: 8, y: 0, width: 4, height: 4 }
      ],
      cellW: 8,
      cellH: 8,
      keepPage: false
    });
    await settle();

    expect(types()).toEqual(["atlas", "blob"]);
    const strip = canvases[canvases.length - 1];
    expect([strip.width, strip.height]).toEqual([16, 8]);
    expect(strip.puts.map((p) => p.x), "the exact-fit cell was written directly").toEqual([0]);
    expect(strip.draws, "…and the small one was drawn INTO the full cell box").toEqual([
      { x: 8, width: 8, height: 8 }
    ]);
  });

  it("reports a strip whose page cannot load as an ATLAS failure, like a region of it would", async () => {
    await loadWorker();
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 404 }));
    send({
      type: "strip",
      id: 1,
      key: "strip|gone",
      url: PAGE,
      cells: [{ x: 0, y: 0, width: 8, height: 8 }],
      cellW: 8,
      cellH: 8,
      keepPage: false
    });
    await settle();

    const error = posted.find((m) => m.type === "error")!;
    expect(error).toMatchObject({ id: 1, key: "strip|gone", url: PAGE, atlas: true });
    expect(encodes, "nothing was encoded").toBe(0);
  });

  // --- THE HOLD SLOT (Aug-20): a page too big for the share is held APART from it -------------------------------
  //
  // The defect this replaced, in one line: `evictPages` asked `total + incoming > keepBytes` over ONE flat set of
  // pages, so a page bigger than the whole share was evicted by whatever arrived next and re-decoded by whatever
  // asked for it after that — at EVERY share on the ladder, an 8GB desktop's 64MB included. Live evidence: a fresh
  // combat mount with `deviceMemory` unreported measured `atlasLoads` 18 against `atlasPages` 10, on the tier where
  // the idle drop is already off, so not one of those eight second decodes was a release.
  //
  // These specs work in KB where the game works in MB (a 62KB "card page" against a 32KB share), because the rule
  // is about the RATIO of a page to a share and the module has no idea what a megabyte is. The two real-pipeline
  // pins that follow do use the game's own page sizes, against the budget a real device resolves.
  describe("the hold slot", () => {
    const KB = 1024;
    const BIG = "/res/images/atlases/card_atlas_0.png"; // 62KB here, 62.6MB in the game
    const BIG_B = "/res/images/atlases/card_atlas_1.png";
    const SMALL = "/res/images/atlases/ui_atlas_0.png";
    const SMALL_B = "/res/images/atlases/compressed_0.png";
    const SMALL_C = "/res/images/atlases/relic_atlas.png";

    /** The shipped pairing: a hold slot is armed exactly where the idle drop is off (see `the hold-slot line`). */
    function configure(keepBytes: number, bigPageBytes: number | "off"): void {
      send({ type: "config", keepBytes, bigPageBytes, dropIdleMs: "off" });
    }

    /** A share of 32KB, a hold-slot line of 24KB — the unreported-memory tier's own 32MB/24MB, scaled. */
    function configureTier(bigPageBytes: number | "off" = 24 * KB): void {
      configure(32 * KB, bigPageBytes);
      sizePage(BIG, 62 * KB);
      sizePage(BIG_B, 62 * KB);
      sizePage(SMALL, 16 * KB);
      sizePage(SMALL_B, 16 * KB);
      sizePage(SMALL_C, 16 * KB);
    }

    const releasedUrls = (): unknown[] => releases().map((m) => m.url);

    it("keeps the share when a page too big for it arrives — the whole defect, in three bakes", async () => {
      await loadWorker();
      configureTier();
      bakeInWorker(SMALL, false);
      await settle();
      bakeInWorker(BIG, false); // 62KB against a 32KB share: pre-Aug-20 this emptied the worker
      await settle();

      expect(releasedUrls(), "the small page was never competing with it").toEqual([]);
      // …and it really is still decoded, by the only measure that matters: no second fetch of it.
      bakeInWorker(SMALL, false);
      await settle();
      expect(fetched, "one decode each, and the burst is not over").toEqual([SMALL, BIG]);
    });

    it("…and the hold slot does not disturb the share as it fills up either", async () => {
      await loadWorker();
      configureTier();
      bakeInWorker(BIG, false);
      await settle();
      bakeInWorker(SMALL, false);
      await settle();
      bakeInWorker(SMALL_B, false); // 16 + 16 = the share exactly
      await settle();

      expect(releasedUrls()).toEqual([]);
      bakeInWorker(BIG, false);
      await settle();
      expect(fetched, "three pages, three decodes").toEqual([BIG, SMALL, SMALL_B]);
    });

    it("gives the slot to the newer big page — one per worker, and it takes nothing else with it", async () => {
      await loadWorker();
      configureTier();
      bakeInWorker(SMALL, false);
      await settle();
      bakeInWorker(BIG, false);
      await settle();
      bakeInWorker(BIG_B, false);
      await settle();

      expect(releasedUrls(), "only the previous occupant, and only because it wanted the same slot").toEqual([BIG]);
      expect(releases()[0], "…the share is untouched underneath it").toMatchObject({
        reason: "budget",
        urls: [SMALL],
        totalBytes: 16 * KB
      });
    });

    it("bounds a worker at `keepBytes + the one big page`, and reports exactly that", async () => {
      await loadWorker();
      configureTier();
      bakeInWorker(SMALL, false);
      await settle();
      bakeInWorker(SMALL_B, false);
      await settle();
      bakeInWorker(BIG, false);
      await settle();

      const loads = posted.filter((m) => m.type === "atlas");
      expect(loads.length).toBe(3);
      // THE BOUND, stated by the worker itself rather than by arithmetic in a comment: a full share (32KB) plus
      // one page that is not part of it (62KB). In the game's own numbers that is 32MB + 62.6MB per worker, and
      // 189MB across the pool — which is what residency always was, since the LRU's always-keep-one floor was
      // going to hold that page anyway. What it used to cost extra was a ~590ms re-decode per eviction.
      expect(loads[2].totalBytes).toBe(32 * KB + 62 * KB);
      expect(releasedUrls()).toEqual([]);
    });

    it("still budgets the small pages against the share, least-recently-used first", async () => {
      await loadWorker();
      configureTier();
      bakeInWorker(BIG, false); // the hold slot is occupied throughout: it is not part of this question
      await settle();
      for (const url of [SMALL, SMALL_B, SMALL_C]) {
        bakeInWorker(url, false);
        await settle();
      }

      expect(releasedUrls(), "three 16KB pages do not fit a 32KB share; the oldest goes").toEqual([SMALL]);
      // Reported BEFORE the incoming page's readback allocates (see decodePage), so what is left at that moment is
      // the hold slot plus the one surviving share page — the incoming one is not held yet.
      expect(releases()[0]).toMatchObject({ reason: "budget", totalBytes: 62 * KB + 16 * KB });
    });

    it("evicts an UNPINNED page before a pinned one, whatever the LRU order says", async () => {
      await loadWorker();
      configureTier();
      bakeInWorker(SMALL, true); // the pool still had work for this one …
      await settle();
      bakeInWorker(SMALL_B, false); // … and none for this one, which is NEWER
      await settle();
      bakeInWorker(SMALL_C, false);
      await settle();

      expect(releasedUrls(), "the newer page went, because nothing was waiting on it").toEqual([SMALL_B]);
    });

    it("…but evicts a pinned page too when the share has nothing else left — a pin is an order, not an exemption", async () => {
      await loadWorker();
      configureTier();
      bakeInWorker(SMALL, true);
      await settle();
      bakeInWorker(SMALL_B, true);
      await settle();
      bakeInWorker(SMALL_C, true);
      await settle();

      // All three pinned, so the tie breaks on the LRU and the budget is still a budget. The alternative — a pin
      // that cannot be evicted — is a share that silently stops bounding anything the moment the pool is busy.
      expect(releasedUrls()).toEqual([SMALL]);
    });

    it("keeps a pin once it is set: a later keepPage:false is 'nothing queued RIGHT NOW', not 'let it go'", async () => {
      await loadWorker();
      configureTier();
      bakeInWorker(SMALL, true);
      await settle();
      bakeInWorker(SMALL, false); // the last region of that burst — the queue behind it is empty by construction
      await settle();
      bakeInWorker(SMALL_B, false);
      await settle();
      bakeInWorker(SMALL_C, false);
      await settle();

      // Un-pinning here would have made SMALL the plain LRU victim (it was used before SMALL_B), which is the same
      // mistake the idle drop makes if it fires at the crop: `keepPage: false` describes this job, not the page.
      expect(releasedUrls()).toEqual([SMALL_B]);
    });

    it("takes the pin on a cache HIT too, not only when the page is first decoded", async () => {
      await loadWorker();
      configureTier();
      bakeInWorker(SMALL, false); // decoded before the pool had any reason to keep it …
      await settle();
      bakeInWorker(SMALL, true); // … and pinned by the next region of it, off the page already held
      await settle();
      bakeInWorker(SMALL_B, false);
      await settle();
      bakeInWorker(SMALL_C, false);
      await settle();

      expect(fetched, "the pinning job baked from the page in hand").toEqual([SMALL, SMALL_B, SMALL_C]);
      expect(releasedUrls(), "SMALL is the LRU here, and survives anyway").toEqual([SMALL_B]);
    });

    it("keeps the hold-slot line when a later config only re-shares the budget", async () => {
      await loadWorker();
      configureTier();
      send({ type: "config", keepBytes: 40 * KB }); // a re-share that says nothing about the tier
      bakeInWorker(BIG, false);
      await settle();
      bakeInWorker(SMALL, false);
      await settle();

      expect(releasedUrls(), "the line survived a share that did not mention it").toEqual([]);
    });

    // The other side of the same lever, and the reason `bigPageBytes` is optional at all: under `"off"` this
    // module's sweep is the pre-Aug-20 one, byte for byte. That is not a leftover — it is what the under-4GB tier
    // still ships, where an oversized page is given back on an idle timer instead of held (see `the page-drop
    // tier`), and it is the arm the real-pipeline pin below measures the fix against.
    it("evicts the big page for a small one under `bigPageBytes: off` — today's rule, on the tier that keeps it", async () => {
      await loadWorker();
      configureTier("off");
      bakeInWorker(BIG, false);
      await settle();
      bakeInWorker(SMALL, false);
      await settle();

      expect(releasedUrls(), "62KB + 16KB over a 32KB share, with a floor of zero: the worker empties").toEqual([
        BIG
      ]);
      bakeInWorker(BIG, false);
      await settle();
      expect(fetched, "…and the next region of it pays for a second decode").toEqual([BIG, SMALL, BIG]);
    });

    it("does the same when it was never configured at all — the fallback is the old rule, not the new one", async () => {
      await loadWorker();
      send({ type: "config", keepBytes: 32 * KB, dropIdleMs: "off" }); // no `bigPageBytes` anywhere
      sizePage(BIG, 62 * KB);
      sizePage(SMALL, 16 * KB);
      bakeInWorker(BIG, false);
      await settle();
      bakeInWorker(SMALL, false);
      await settle();

      expect(releasedUrls()).toEqual([BIG]);
    });
  });

  // --- THE MOUNT BURST THAT NAMED THE HOLD SLOT (atlasLoads 18 against atlasPages 10) ---------------------------
  //
  // THE PIN FOR THE WHOLE ROUND, and an A/B rather than a remembered number: the same workload, the same device and
  // the same real baker → real pool → real workers, run once on each side of the ONE lever that arms the hold slot.
  // The `off` arm is not a museum piece — it is what the under-4GB tier still ships — so both arms are behaviour
  // this repo is responsible for, and the difference between them is the round.
  describe("a fresh combat mount, at the game's own page sizes", () => {
    /**
     * Ten pages in the shape a combat mount presents them. The first five sizes are this game's own measured ones
     * (the table in atlasBakeWorker.ts's header); the rest stand in for the smaller pages a mount also touches.
     * Exactly TWO are over the 24MB hold-slot line, which is how many hold slots a two-worker pool has — the cost
     * of a third is the next spec, not this one.
     */
    const MOUNT: Array<[string, number, number]> = [
      ["/res/images/atlases/card_atlas_0.png", 4032, 4072], // 62.6MB — a hold-slot page
      ["/res/images/atlases/card_atlas_1.png", 4032, 4032], // 62.0MB — …and the other one
      ["/res/images/atlases/ui_atlas_0.png", 2048, 2048], // 16.0MB
      ["/res/images/atlases/compressed_0.png", 1936, 2020], // 14.9MB
      ["/res/images/atlases/relic_atlas.png", 4096, 680], // 10.6MB
      ["/res/images/atlases/mount_5.png", 1024, 1024], // 4.2MB
      ["/res/images/atlases/mount_6.png", 1024, 768], // 3.1MB
      ["/res/images/atlases/mount_7.png", 1024, 512], // 2.1MB
      ["/res/images/atlases/mount_8.png", 800, 600], // 1.9MB
      ["/res/images/atlases/mount_9.png", 512, 512] // 1.0MB
    ];
    const LARGEST_PAGE_BYTES = 4032 * 4072 * 4;
    /** Two passes over the scene — the mount's own walk, and the first thing that asks for those atlases again. */
    const PASSES = 2;

    /**
     * INTERLEAVED, AND SPREAD OVER FRAMES — both halves matter, and the second one is why the Aug-14 workload
     * never caught this. A mount walks the scene once and asks for each sprite's region as it reaches it, so
     * consecutive requests hop between atlases; but if a whole pass is handed to the pool AT ONCE, the pool's
     * holder-first placement re-groups it page by page and every page finishes before anything can evict it. On a
     * device the walk trickles in across frames with the queue empty in between, which is what this drains for.
     */
    async function runMount(): Promise<void> {
      let x = 0;
      let pumps = 0;
      for (let pass = 0; pass < PASSES; pass++) {
        for (const [url] of MOUNT) {
          request(url, x++);
        }
        for (const img of images) img.fireLoad();
        for (let i = 0; i < 10 && atlasBakeStats.baked < x; i++) {
          await pump();
          pumps += 1;
        }
      }
      expect(atlasBakeStats.baked, "the whole mount baked off-thread").toBe(MOUNT.length * PASSES);
      expect(inlinePending.length, "…none of it on this thread").toBe(0);
      expect(pumps * 64, "the mount fits inside an idle window, so no drop can fire mid-burst").toBeLessThan(
        __atlasBakePoolTuningForTest.PAGE_DROP_IDLE_MS
      );
    }

    /** The device that reported the burst: 8 cores and NO `deviceMemory` — two workers, a 64MB budget, 32MB each. */
    async function mountPool(pageDrop: number | null): Promise<void> {
      await spawnRealWorkers(2);
      for (const [url, width, height] of MOUNT) pageSizes.set(url, { width, height });
      __setAtlasPageDropForTest(pageDrop);
      stubDevice(8, undefined);
      __resetAtlasBakePoolForTest();
      __resetAtlasCacheForTest();
    }

    it("decodes each of its ten pages EXACTLY ONCE", async () => {
      await mountPool(null); // the device's own answer: drop off, hold slot armed
      expect(atlasBakePoolStats.atlasPages).toBe(0);
      await runMount();

      expect(
        [atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages],
        "ten pages, ten decodes — the burst that opened this round measured 18 for the same ten"
      ).toEqual([MOUNT.length, MOUNT.length]);
      expect(atlasBakePoolStats.atlasEvicted, "…and nothing had to be given up to get there").toBe(0);
      // The price, stated rather than hidden: residency is now bounded at a share PLUS a page per worker, and the
      // pool sits inside that bound rather than under `budgetBytes`. `budgetBytes` never bounded this (the first
      // copy of a page is unconditional); what it used to do was buy the appearance of a bound with re-decodes.
      const bound = 2 * (atlasBakePoolStats.keepBytes + LARGEST_PAGE_BYTES);
      expect(bound, "2 × (32MB + 62.6MB)").toBe(198_455_296);
      expect(atlasBakePoolStats.atlasBytes).toBeLessThanOrEqual(bound);
      expect(atlasBakePoolStats.atlasBytes, "…and it really is holding the big pages, not skirting them").toBeGreaterThan(
        LARGEST_PAGE_BYTES * 2
      );
    });

    it("…and re-decodes half of them when the hold slot is off, which is what it used to do everywhere", async () => {
      await mountPool(__atlasBakePoolTuningForTest.PAGE_DROP_IDLE_MS); // the under-4GB tier: no hold slot
      await runMount();

      // 19 loads for 10 pages, against the device's 18 for 10 — the same defect, in a fixture, at the game's own
      // page sizes. Every one of those extra nine is a full fetch + decode + readback (~590ms of worker time on
      // the Aug-14 phone) spent re-acquiring a page the worker had already had.
      expect([atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages]).toEqual([19, 10]);
      // …and NOT ONE of them was a release: `atlasEvicted` is the mechanism, which is exactly why the damage
      // gauge is `atlasLoads - atlasPages` and not either release counter.
      expect(atlasBakePoolStats.atlasReleased).toBe(0);
      expect(atlasBakePoolStats.atlasEvicted).toBeGreaterThan(0);
    });

    /**
     * THE ACKNOWLEDGED COST, AND ITS EXACT SCOPE. A hold slot per worker is TWO on this pool, and this game ships
     * THREE card atlases. A mount that keeps coming back to all three cannot hold them all, and the pages past the
     * slot count go on displacing each other exactly as they always did — one decode per revisit each. The hold
     * slot does not fix that and was never going to: with nothing but big pages in the workload, a worker holds
     * one page either way, so the two arms measure the SAME. What the hold slot changes is WHO pays — a page under
     * the line is no longer evicted by a page that could never have shared a share with it — which is why the ten-
     * page mount above goes 19 → 10 while these three do not move at all.
     */
    it("does not pretend to help when a mount has more big pages than slots — that cost is the same either way", async () => {
      const CARDS: Array<[string, number, number]> = [
        ["/res/images/atlases/card_atlas_0.png", 4032, 4072], // 62.6MB
        ["/res/images/atlases/card_atlas_1.png", 4032, 4032], // 62.0MB
        ["/res/images/atlases/card_atlas_2.png", 3528, 3080] // 41.5MB — still over the 24MB line
      ];

      async function runCards(pageDrop: number | null): Promise<number[]> {
        await spawnRealWorkers(2);
        for (const [url, width, height] of CARDS) pageSizes.set(url, { width, height });
        __setAtlasPageDropForTest(pageDrop);
        stubDevice(8, undefined);
        __resetAtlasBakePoolForTest();
        __resetAtlasCacheForTest();
        let x = 0;
        for (let pass = 0; pass < 2; pass++) {
          for (const [url] of CARDS) request(url, x++);
          for (const img of images) img.fireLoad();
          for (let i = 0; i < 10 && atlasBakeStats.baked < x; i++) await pump();
        }
        expect(atlasBakeStats.baked).toBe(CARDS.length * 2);
        return [atlasBakePoolStats.atlasLoads, atlasBakePoolStats.atlasPages];
      }

      // Worker 0 keeps card_atlas_0 (holder-first placement sends its regions back to it), so the other two share
      // the ONE slot left and swap places on every pass: three pages, five decodes, two passes.
      expect(await runCards(null), "the hold slot's own capacity, paid honestly").toEqual([5, 3]);
      expect(await runCards(__atlasBakePoolTuningForTest.PAGE_DROP_IDLE_MS), "…and unchanged without it").toEqual([
        5, 3
      ]);
    });
  });

  it("re-tunes residency when the pool re-sends its share", async () => {
    await loadWorker();
    send({ type: "config", keepBytes: PAGE_BYTES * 4 });
    bakeInWorker(PAGE, true);
    await settle();
    bakeInWorker(PAGE_B, true);
    await settle();
    expect(releases(), "both pages fit").toEqual([]);

    send({ type: "config", keepBytes: PAGE_BYTES }); // …until the share shrinks under the two of them
    expect(releases().map((m) => [m.url, m.reason])).toEqual([[PAGE, "budget"]]);
    expect(releases()[0]).toMatchObject({ totalBytes: PAGE_BYTES, urls: [PAGE_B] });
  });
});
