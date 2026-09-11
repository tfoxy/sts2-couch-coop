import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// IDLE ATLAS PREFETCH (Aug-19). The contract these specs pin is a SCHEDULE, not a set of urls: the whole point of
// the rewrite is that `prefetchMirrorImages()` requests nothing on the caller's task and never has more than one
// page in flight, so a connect/join that is already fetching the scene stream is not made to race a dozen
// multi-megabyte atlas fetches. So the atlasBaker mock below is a small FAKE of the real cache rather than a bare
// spy: it models `getAtlas`'s idempotence (a page loads once no matter how many callers ask) and its
// settle-once-then-synchronous behaviour, which is what the dedupe and no-stack-overflow properties rest on.
const baker = vi.hoisted(() => {
  interface FakeEntry {
    settled: boolean;
    size: { width: number; height: number } | null;
    listeners: Array<() => void>;
  }
  const entries = new Map<string, FakeEntry>();
  /** Every DISTINCT page load started — the real cache's map, i.e. what "loaded once" is measured against. */
  const loads: string[] = [];
  const ensure = (url: string): FakeEntry => {
    let entry = entries.get(url);
    if (entry === undefined) {
      entry = { settled: false, size: null, listeners: [] };
      entries.set(url, entry);
      loads.push(url);
    }
    return entry;
  };
  return {
    entries,
    loads,
    ensure,
    preloadAtlas: vi.fn((url: string) => {
      ensure(url);
    }),
    whenAtlasSettled: vi.fn((url: string, done: () => void) => {
      const entry = ensure(url);
      if (entry.settled) {
        done(); // already settled ⇒ synchronous, exactly like the real one
        return;
      }
      entry.listeners.push(done);
    }),
    atlasPageSize: vi.fn((url: string) => entries.get(url)?.size ?? null)
  };
});

vi.mock("@/mirror/atlasBaker", () => ({
  preloadAtlas: baker.preloadAtlas,
  whenAtlasSettled: baker.whenAtlasSettled,
  atlasPageSize: baker.atlasPageSize
}));

const warmImage = vi.hoisted(() => vi.fn());
vi.mock("@/mirror/textureCache", () => ({ warmImage }));

import {
  prefetchMirrorImages,
  __resetImagePrefetchStatsForTest,
  __setAtlasPrefetchParamForTest,
  type MirrorImagePrefetchStats
} from "@/mirror/imagePrefetch";

const ATLAS = (name: string): string => `/res/images/atlases/${name}.png`;
const ARROWS = [
  "/res/images/ui/combat/targeting_arrow_head.png",
  "/res/images/ui/combat/targeting_arrow_segment.png"
];

/** The full shipped priority list, in order (the SPEC of the order, not a copy of the module's array). */
const ORDER = [
  "ui_atlas_0",
  "ui_atlas_1",
  "compressed_0",
  "card_atlas_0",
  "card_atlas_1",
  "card_atlas_2",
  "relic_atlas",
  "potion_atlas",
  "intent_atlas",
  "power_atlas",
  "relic_outline_atlas",
  "potion_outline_atlas"
].map(ATLAS);

// --- the idle scheduler, stubbed so a spec owns the clock ------------------------------------------------------

type IdleCb = () => void;
let idleQueue: IdleCb[] = [];

function flushIdle(): number {
  const queued = idleQueue;
  idleQueue = [];
  for (const cb of queued) cb();
  return queued.length;
}

/** Settle a page the chain has started. `size: null` = a page that failed (404 / decode failure). */
function settle(url: string, size: { width: number; height: number } | null = { width: 2048, height: 2048 }): void {
  const entry = baker.entries.get(url);
  expect(entry, `no load was started for ${url}`).toBeTruthy();
  entry!.settled = true;
  entry!.size = size;
  for (const cb of entry!.listeners.splice(0)) cb();
}

/** Run the chain to completion: flush the idle slot, settle whatever it started, repeat. */
function drain(failing: ReadonlySet<string> = new Set()): void {
  for (let guard = 0; guard < 64; guard++) {
    if (flushIdle() === 0) {
      return;
    }
    for (const [url, entry] of baker.entries) {
      if (!entry.settled) {
        settle(url, failing.has(url) ? null : { width: 2048, height: 2048 });
      }
    }
  }
  throw new Error("the prefetch chain did not terminate");
}

function stats(): MirrorImagePrefetchStats {
  return (window as unknown as Record<string, MirrorImagePrefetchStats>).__mirrorImagePrefetch;
}

const preloadedUrls = (): string[] => baker.preloadAtlas.mock.calls.map((call) => call[0] as string);

beforeEach(() => {
  baker.entries.clear();
  baker.loads.length = 0;
  baker.preloadAtlas.mockClear();
  baker.whenAtlasSettled.mockClear();
  baker.atlasPageSize.mockClear();
  warmImage.mockClear();
  idleQueue = [];
  (window as unknown as Record<string, unknown>).requestIdleCallback = (cb: IdleCb) => {
    idleQueue.push(cb);
    return idleQueue.length;
  };
  __setAtlasPrefetchParamForTest(null);
  __resetImagePrefetchStatsForTest();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).requestIdleCallback;
  __setAtlasPrefetchParamForTest(undefined);
  __resetImagePrefetchStatsForTest();
  vi.useRealTimers();
});

describe("prefetchMirrorImages scheduling", () => {
  it("requests NOTHING synchronously — the first page waits for the first idle slot", () => {
    prefetchMirrorImages();

    expect(baker.preloadAtlas).not.toHaveBeenCalled();
    expect(baker.whenAtlasSettled).not.toHaveBeenCalled();
    expect(warmImage).not.toHaveBeenCalled();
    expect(idleQueue.length).toBe(1);

    flushIdle();
    expect(preloadedUrls()).toEqual([ATLAS("ui_atlas_0")]);
  });

  it("walks the pages in the shipped priority order, then warms the targeting arrows last", () => {
    prefetchMirrorImages();
    drain();

    expect(preloadedUrls()).toEqual(ORDER);
    expect(warmImage.mock.calls.map((call) => call[0])).toEqual(ARROWS);
    expect(stats().list).toEqual(ORDER);
    expect(stats().index).toBe(ORDER.length);
    expect(stats().started).toBe(ORDER.length);
    expect(stats().settled).toBe(ORDER.length);
    expect(stats().failed).toBe(0);
    expect(stats().skipped).toBe(0);
  });

  it("keeps AT MOST ONE page in flight: the next step is scheduled only by the previous page's settle", () => {
    prefetchMirrorImages();
    flushIdle();
    expect(preloadedUrls()).toEqual([ATLAS("ui_atlas_0")]);

    // Nothing settled ⇒ nothing scheduled. Draining the idle queue again must not start a second page.
    expect(idleQueue.length).toBe(0);
    expect(flushIdle()).toBe(0);
    expect(preloadedUrls()).toEqual([ATLAS("ui_atlas_0")]);

    settle(ATLAS("ui_atlas_0"));
    expect(idleQueue.length).toBe(1); // …and the settle scheduled the next one rather than running it inline
    expect(preloadedUrls()).toEqual([ATLAS("ui_atlas_0")]);

    flushIdle();
    expect(preloadedUrls()).toEqual([ATLAS("ui_atlas_0"), ATLAS("ui_atlas_1")]);
    expect(warmImage).not.toHaveBeenCalled(); // the arrows are the LAST step, not a parallel one
  });

  it("falls back to a timer when the host has no requestIdleCallback (Safari)", () => {
    delete (window as unknown as Record<string, unknown>).requestIdleCallback;
    vi.useFakeTimers();

    prefetchMirrorImages();
    expect(baker.preloadAtlas).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(preloadedUrls()).toEqual([ATLAS("ui_atlas_0")]);

    settle(ATLAS("ui_atlas_0"));
    expect(preloadedUrls()).toEqual([ATLAS("ui_atlas_0")]); // still scheduled, still not synchronous
    vi.advanceTimersByTime(50);
    expect(preloadedUrls()).toEqual([ATLAS("ui_atlas_0"), ATLAS("ui_atlas_1")]);
  });
});

describe("prefetchMirrorImages and the demand path", () => {
  it("never loads a page twice, and a page the demand path already settled just advances the chain", () => {
    // The demand path (a sprite that painted before the chain reached this page) loaded and settled it already.
    baker.ensure(ATLAS("card_atlas_0"));
    settle(ATLAS("card_atlas_0"), { width: 4032, height: 4072 });

    prefetchMirrorImages();
    drain();

    // One LOAD for that page even though two callers asked — `getAtlas` idempotence, which is what makes this
    // prefetch free to ask for anything: it can never duplicate or block a demand fetch.
    expect(baker.loads.filter((url) => url === ATLAS("card_atlas_0")).length).toBe(1);
    expect(baker.loads.length).toBe(ORDER.length);
    // …and the chain walked the whole list anyway, advancing through the already-settled page via the scheduler
    // (a synchronous callback must never recurse into the next step).
    expect(preloadedUrls()).toEqual(ORDER);
    expect(stats().skipped).toBe(1);
    expect(stats().settled).toBe(ORDER.length);
  });

  it("a page that FAILS to load does not stall the chain", () => {
    prefetchMirrorImages();
    drain(new Set([ATLAS("compressed_0")]));

    expect(preloadedUrls()).toEqual(ORDER);
    expect(stats().failed).toBe(1);
    expect(warmImage.mock.calls.map((call) => call[0])).toEqual(ARROWS);
  });
});

describe("?atlasPrefetch", () => {
  it("=off prefetches nothing at all", () => {
    __setAtlasPrefetchParamForTest("off");
    prefetchMirrorImages();

    expect(idleQueue.length).toBe(0);
    drain();
    expect(baker.preloadAtlas).not.toHaveBeenCalled();
    expect(warmImage).not.toHaveBeenCalled();
    expect(stats().list).toEqual([]);
  });

  it("=3 walks only the first three pages (the arrows still warm)", () => {
    __setAtlasPrefetchParamForTest("3");
    prefetchMirrorImages();
    drain();

    expect(preloadedUrls()).toEqual(ORDER.slice(0, 3));
    expect(stats().list).toEqual(ORDER.slice(0, 3));
    expect(warmImage.mock.calls.map((call) => call[0])).toEqual(ARROWS);
  });

  it("ignores junk and keeps the full shipped list", () => {
    __setAtlasPrefetchParamForTest("yes-please");
    prefetchMirrorImages();
    drain();

    expect(preloadedUrls()).toEqual(ORDER);
  });
});

// R7 W1 fix (b) — DECODED BYTES. The prefetch's cost was an estimate for a whole round, and estimates do not
// survive contact with a device. `atlasBaker` decodes each atlas once into an `ImageBitmap` held in a module-scope
// Map that is never evicted, so what this counts is RESIDENT for the life of the page. The host measurement it
// was validated against: peak renderer VmRSS, `?atlasPrefetch=off` against the default, three pairs plus a
// standalone ABBA probe, 222-292 MB. The default is deliberately UNCHANGED — turning the prefetch off costs the
// combat replay a median 1501 ms on its last texture upload — so this is the number that makes the trade
// arguable rather than a change that assumes the answer.
describe("prefetch decoded-byte accounting", () => {
  it("counts width * height * 4 per decoded page, and only decoded ones", () => {
    __setAtlasPrefetchParamForTest("3");
    prefetchMirrorImages();
    // Two pages decode at 2048², one fails outright.
    drain(new Set([ORDER[1]]));
    const s = stats();
    expect(s.decodedPages).toBe(2);
    expect(s.decodedBytes).toBe(2 * 2048 * 2048 * 4);
    // The failed page is counted as a failure and contributes NO bytes: a 404 costs a request, not 67MB.
    expect(s.failed).toBe(1);
  });

  it("prices differently-sized pages by their own dimensions", () => {
    __setAtlasPrefetchParamForTest("2");
    prefetchMirrorImages();
    flushIdle();
    settle(ORDER[0], { width: 4096, height: 4096 });
    flushIdle();
    settle(ORDER[1], { width: 1024, height: 512 });
    drain();
    const s = stats();
    expect(s.decodedPages).toBe(2);
    expect(s.decodedBytes).toBe(4096 * 4096 * 4 + 1024 * 512 * 4);
  });

  // `?atlasPrefetch=off` is the lever the device leg uses to ask this question (Leg S3), so the zero has to be a
  // real measured zero rather than an absent field.
  it("reports zero bytes when the chain is switched off", () => {
    __setAtlasPrefetchParamForTest("off");
    prefetchMirrorImages();
    drain();
    const s = stats();
    expect(s.decodedPages).toBe(0);
    expect(s.decodedBytes).toBe(0);
  });
});
