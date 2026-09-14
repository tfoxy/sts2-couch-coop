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
  publishAtlasManifest,
  __resetAtlasManifestForTest,
  __resetImagePrefetchStatsForTest,
  __setAtlasPrefetchParamForTest,
  type MirrorImagePrefetchStats
} from "@/mirror/imagePrefetch";
import { publishAssetVersion, __resetAssetVersionForTest } from "@/join/assetVersion";

/**
 * The host's game build, latched in `beforeEach` because the chain now WAITS for it — asset urls carry it, and
 * this chain is the one asset consumer that can run before the `session` envelope supplies it. Every url below
 * therefore carries `?b=`, which is the whole point: it is what stops a repacked beta atlas being served out of
 * the HTTP cache on a stable host. The gate itself is specced separately at the bottom of this file.
 */
const BUILD = "cc-testbuild000001";
const B = `?b=${BUILD}`;

const ATLAS = (name: string): string => `/res/images/atlases/${name}.png${B}`;
const ARROWS = [
  `/res/images/ui/combat/targeting_arrow_head.png${B}`,
  `/res/images/ui/combat/targeting_arrow_segment.png${B}`
];

/** The full shipped priority list, in order (the SPEC of the order, not a copy of the module's array). */
const NAMES = [
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
];
const ORDER = NAMES.map(ATLAS);

// --- the host's published manifest -----------------------------------------------------------------------------

/** The `res://` spelling of a page: what the HOST publishes, and what the intersection is done on. */
const ATLAS_DIR = "res://images/atlases/";
const RES = (name: string): string => `${ATLAS_DIR}${name}.png`;

/** What a repacked build's manifest looks like: every page this frontend wishes for, minus the named ones. */
const manifestWithout = (...missing: readonly string[]) => ({
  directory: ATLAS_DIR,
  pages: NAMES.filter((name) => !missing.includes(name)).map(RES)
});

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
  // The manifest is latched at module scope and `publishAtlasManifest` deliberately never clears it, so one
  // spec's host would otherwise decide what the next spec's chain may ask for. The asset version is latched the
  // same way and for the same reason.
  __resetAtlasManifestForTest();
  __resetAssetVersionForTest();
  publishAssetVersion(BUILD);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).requestIdleCallback;
  __setAtlasPrefetchParamForTest(undefined);
  __resetImagePrefetchStatsForTest();
  __resetAtlasManifestForTest();
  __resetAssetVersionForTest();
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

// THE HOST'S PUBLISHED PAGE LIST (`atlasManifest` on the session envelope). The wish-list above is compiled into
// this bundle, so it describes the game build this file was written against: the game's public-beta branch
// repacked the card atlas from three pages into two, and every client then asked for `card_atlas_2` — a 404 that
// costs the HOST a failed main-thread ResourceLoader.Load per new client, uncached, forever. These specs pin the
// three halves of the fix: a page the host does not publish is never requested; with no manifest the compiled-in
// list is walked unchanged (an older host, a test harness, SSR); and the intersection is a FILTER, never a
// reorder — the priority order at the top of imagePrefetch.ts is the whole reason that file exists.
describe("prefetchMirrorImages and the host's atlas manifest", () => {
  it("never requests a page the host did not publish", () => {
    publishAtlasManifest(manifestWithout("card_atlas_2"));
    prefetchMirrorImages();
    drain();

    expect(preloadedUrls()).not.toContain(ATLAS("card_atlas_2"));
    expect(preloadedUrls()).toEqual(ORDER.filter((url) => url !== ATLAS("card_atlas_2")));
    // Not merely unrequested — never LOADED, which is the host-side cost this exists to remove.
    expect(baker.loads).not.toContain(ATLAS("card_atlas_2"));
    expect(stats().failed).toBe(0);
    // Known absent before the walk started, so it is filtered out of the plan rather than counted mid-walk.
    expect(stats().list).toEqual(ORDER.filter((url) => url !== ATLAS("card_atlas_2")));
    expect(stats().absent).toBe(0);
    // …and the arrows still warm: dropping a page must not truncate the chain.
    expect(warmImage.mock.calls.map((call) => call[0])).toEqual(ARROWS);
  });

  it("keeps the shipped priority order across the pages that survive", () => {
    publishAtlasManifest(manifestWithout("ui_atlas_1", "card_atlas_2", "power_atlas"));
    prefetchMirrorImages();
    drain();

    // The chrome still leads, the cards still precede the relics: a filter, not a reordering.
    expect(preloadedUrls()).toEqual(
      ["ui_atlas_0", "compressed_0", "card_atlas_0", "card_atlas_1", "relic_atlas", "potion_atlas",
        "intent_atlas", "relic_outline_atlas", "potion_outline_atlas"].map(ATLAS)
    );
  });

  it("walks the full compiled-in list when the host publishes no manifest", () => {
    prefetchMirrorImages();
    drain();

    expect(preloadedUrls()).toEqual(ORDER);
    expect(stats().list).toEqual(ORDER);
    expect(stats().absent).toBe(0);
  });

  // The ordinary first connect: the chain is started at mirror setup and the session envelope lands a moment
  // later, while the walk is already a page or two in. The pages that matter — the card atlas — are further down
  // the list than that, which is why the check is re-run per step rather than only at plan time.
  it("filters the REST of the walk when the manifest arrives mid-chain", () => {
    prefetchMirrorImages();
    flushIdle();
    settle(ATLAS("ui_atlas_0"));
    expect(preloadedUrls()).toEqual([ATLAS("ui_atlas_0")]);

    publishAtlasManifest(manifestWithout("card_atlas_2"));
    drain();

    expect(preloadedUrls()).toEqual(ORDER.filter((url) => url !== ATLAS("card_atlas_2")));
    // The plan was made before the host answered, so it still names the page; `absent` is what says it was
    // dropped on the way past.
    expect(stats().list).toEqual(ORDER);
    expect(stats().absent).toBe(1);
    expect(stats().started).toBe(ORDER.length - 1);
    expect(stats().failed).toBe(0);
    expect(warmImage.mock.calls.map((call) => call[0])).toEqual(ARROWS);
  });

  // A manifest for some OTHER directory says nothing about these pages, and a host that stops sending one has
  // not retracted what it already said. Both fail open, because a prefetch that warms nothing is the regression
  // this list was written to avoid (a median 1501 ms later last texture upload).
  it("fails open for pages outside the published directory, and ignores a later null", () => {
    publishAtlasManifest({ directory: "res://images/other_atlases/", pages: [RES("nothing_we_want")] });
    publishAtlasManifest(null);
    prefetchMirrorImages();
    drain();

    expect(preloadedUrls()).toEqual(ORDER);
  });

  // `?atlasPrefetch=<n>` means "the first n pages worth warming" — so on a repacked build it warms n REAL pages
  // rather than n-1 and a 404.
  it("applies ?atlasPrefetch=<n> to what survived the intersection", () => {
    publishAtlasManifest(manifestWithout("ui_atlas_1"));
    __setAtlasPrefetchParamForTest("3");
    prefetchMirrorImages();
    drain();

    expect(preloadedUrls()).toEqual(["ui_atlas_0", "compressed_0", "card_atlas_0"].map(ATLAS));
  });
});

// THE HOST'S GAME BUILD (`assetCacheToken` on the session envelope → `?b=` on every asset url). This chain is
// the ONE asset consumer that can run before that envelope: it starts from MirrorApp's setup body, before the
// socket is open, whereas everything else mints urls off a delta that arrives after it. Warming a page under an
// unqualified url is the exact bug the qualifier exists to fix — the host answers `immutable` for a year, and
// the atlases this chain warms first are the ones a repacked branch changes — so the walk waits.
describe("prefetchMirrorImages and the host's game build", () => {
  it("requests NOTHING until the host's build is known", () => {
    __resetAssetVersionForTest();
    prefetchMirrorImages();

    expect(idleQueue.length).toBe(0);
    expect(flushIdle()).toBe(0);
    expect(baker.preloadAtlas).not.toHaveBeenCalled();
    // Not merely unrequested: nothing was even PLANNED, so no unqualified url exists to be fetched later.
    expect(stats().list).toEqual([]);
  });

  it("walks the whole list, build-qualified, as soon as the token lands", () => {
    __resetAssetVersionForTest();
    prefetchMirrorImages();
    expect(baker.preloadAtlas).not.toHaveBeenCalled();

    publishAssetVersion(BUILD);
    drain();

    expect(preloadedUrls()).toEqual(ORDER);
    for (const url of preloadedUrls()) {
      expect(url).toContain(`?b=${BUILD}`);
    }
    expect(warmImage.mock.calls.map((call) => call[0])).toEqual(ARROWS);
  });

  // A host too old to send a token at all. Prefetching is speculative, so "we never learned the build" degrades
  // to the unqualified walk that predates the qualifier rather than silently never warming anything — which
  // would cost the combat replay a median 1501 ms on its last texture upload.
  it("walks unqualified once the deadline passes with no token", () => {
    __resetAssetVersionForTest();
    vi.useFakeTimers();

    prefetchMirrorImages();
    expect(idleQueue.length).toBe(0);

    vi.advanceTimersByTime(15_000);
    drain();

    expect(preloadedUrls()).toEqual(ORDER.map((url) => url.replace(B, "")));
    expect(preloadedUrls()[0]).not.toContain("?b=");
  });

  // Both the token and the atlas manifest ride the SAME envelope, so a chain gated on the token is also a chain
  // that has the manifest — the mid-walk re-check stays, but on a first connect it no longer has to carry the
  // case it was written for.
  it("has the host's manifest by the time it plans, so an absent page is filtered out of the plan", () => {
    __resetAssetVersionForTest();
    prefetchMirrorImages();

    publishAtlasManifest(manifestWithout("card_atlas_2"));
    publishAssetVersion(BUILD);
    drain();

    expect(preloadedUrls()).toEqual(ORDER.filter((url) => url !== ATLAS("card_atlas_2")));
    expect(stats().list).toEqual(ORDER.filter((url) => url !== ATLAS("card_atlas_2")));
    expect(stats().absent).toBe(0);
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
