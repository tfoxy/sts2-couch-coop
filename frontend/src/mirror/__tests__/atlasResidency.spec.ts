// THE ATLAS RESIDENCY BUDGET — who gets owned pixels, and who gives them back.
//
// The behaviour under test is the one that killed an iPhone: `getAtlas` used to mint an `ImageBitmap` for every
// page it loaded, and `imagePrefetch` loads the whole atlas list at mount, so ~205 MB of page-owned pixels were
// resident from the moment of join under no budget at all. An `ImageBitmap` is memory the OS can only reclaim by
// killing the tab, and nearly all of it belonged to pages this thread never draws from — every page at or under
// the renderer's 6 MP page-crop gate is painted by CSS out of the browser's own image cache, and has its regions
// cut by a worker from the WORKER's copy.
//
// So these specs pin two properties and one guarantee:
//   * LOADING IS NOT OWNING — a page nobody drew from holds no owned pixels, whatever warmed it;
//   * DRAWING IS OWNING, UNDER A CAP — a real draw promotes, and the cap releases the least-recently-drawn page;
//   * AN EVICTION IS INVISIBLE ABOVE THIS MODULE — the element and the size memo survive it, so a sprite never
//     goes blank and a 16 MP sheet never falls back to the CSS page crop this module exists to prevent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __ageAtlasUseForTest,
  __atlasOwnsPixelsForTest,
  __atlasResidencyTuningForTest,
  __resetAtlasCacheForTest,
  __setAtlasResidencyForTest,
  atlasDecodedSource,
  atlasPageSize,
  atlasResidencyStats,
  drawAtlasRegion,
  preloadAtlas
} from "@/mirror/atlasBaker";

// A controllable fake Image, with the intrinsic size the real one reports on load — which is where the size memo
// now comes from, and therefore what an eviction has to leave behind.
let images: FakeImage[] = [];
class FakeImage {
  onloadHandlers: Array<() => void> = [];
  onerrorHandlers: Array<() => void> = [];
  decoding = "";
  crossOrigin = "";
  naturalWidth = 0;
  naturalHeight = 0;
  private _src = "";
  constructor() {
    images.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    if (type === "load") this.onloadHandlers.push(cb);
    if (type === "error") this.onerrorHandlers.push(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    const list = type === "load" ? this.onloadHandlers : this.onerrorHandlers;
    const i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  }
  set src(v: string) {
    this._src = v;
  }
  get src(): string {
    return this._src;
  }
  fireLoad(width: number, height: number): void {
    this.naturalWidth = width;
    this.naturalHeight = height;
    for (const cb of this.onloadHandlers) cb();
  }
}

/** Every bitmap the fake decoder minted, so a spec can assert one was CLOSED rather than merely dropped. */
let bitmaps: FakeBitmap[] = [];
class FakeBitmap {
  closed = false;
  constructor(readonly width: number, readonly height: number) {
    bitmaps.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

let captures = 0;

function fakeCtx(): { ctx: CanvasRenderingContext2D; draws: unknown[][] } {
  const draws: unknown[][] = [];
  const ctx = { drawImage: (...args: unknown[]) => draws.push(args) } as unknown as CanvasRenderingContext2D;
  return { ctx, draws };
}

const REGION = { x: 0, y: 0, width: 64, height: 64 };

/** The two card sheets, at their measured dimensions — the only pages in the game over the page-crop gate. */
const CARD_0 = { url: "/res/card_atlas_0.png", width: 4032, height: 4072 };
const CARD_1 = { url: "/res/card_atlas_1.png", width: 4032, height: 4032 };
const bytesOf = (page: { width: number; height: number }): number => page.width * page.height * 4;

/** Load a page (as `preloadAtlas` does) and settle it at its real size. */
function load(page: { url: string; width: number; height: number }): void {
  preloadAtlas(page.url);
  images[images.length - 1].fireLoad(page.width, page.height);
}

/** Run the macrotask the promotion capture is scheduled on, then let its promise settle. */
async function settlePromotions(): Promise<void> {
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetAtlasCacheForTest();
  images = [];
  bitmaps = [];
  captures = 0;
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  vi.stubGlobal("createImageBitmap", (source: { naturalWidth: number; naturalHeight: number }) => {
    captures += 1;
    return Promise.resolve(new FakeBitmap(source.naturalWidth, source.naturalHeight));
  });
  // A generous cap by default, so a spec that is not about the cap never trips it.
  __setAtlasResidencyForTest(1024 * 1024 * 1024, "lazy");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("loading an atlas is not owning it", () => {
  it("a warmed page holds no owned pixels, and never asks the decoder", async () => {
    // THE 205 MB. `imagePrefetch` warms twelve pages at mount and only the two card sheets are ever drawn from
    // here; before this, all twelve were captured.
    load(CARD_0);
    load({ url: "/res/ui_atlas_0.png", width: 2048, height: 2048 });
    await settlePromotions();

    expect(captures).toBe(0);
    expect(atlasResidencyStats.residentBytes).toBe(0);
    expect(atlasResidencyStats.residentPages).toBe(0);
    expect(__atlasOwnsPixelsForTest(CARD_0.url)).toBe(false);
  });

  it("…and is still immediately drawable, off its element", async () => {
    load(CARD_0);
    await settlePromotions();

    const { ctx, draws } = fakeCtx();
    // The draw itself never waits on a capture: an unowned page paints from the element on the very first frame.
    expect(drawAtlasRegion(ctx, CARD_0.url, REGION, () => {})).toBe(true);
    expect(draws.length).toBe(1);
  });

  it("answers atlasPageSize from the load, so the renderer's placeholder gate is unaffected", () => {
    load(CARD_0);

    // 16.4 MP — over ATLAS_PAGE_CROP_MAX_PIXELS, so the renderer must keep choosing the canvas placeholder.
    expect(atlasPageSize(CARD_0.url)).toEqual({ width: 4032, height: 4072 });
  });

  it("?atlasOwn=eager restores mint-on-load, which is the device A/B's off-arm", async () => {
    __setAtlasResidencyForTest(0, "eager");

    load(CARD_0);
    await settlePromotions();

    expect(captures).toBe(1);
    expect(atlasResidencyStats.residentBytes).toBe(bytesOf(CARD_0));
  });
});

describe("drawing an atlas promotes it", () => {
  it("the first draw earns owned pixels, and later draws use them", async () => {
    load(CARD_0);
    drawAtlasRegion(fakeCtx().ctx, CARD_0.url, REGION, () => {});
    await settlePromotions();

    expect(captures).toBe(1);
    expect(__atlasOwnsPixelsForTest(CARD_0.url)).toBe(true);
    expect(atlasResidencyStats.residentBytes).toBe(bytesOf(CARD_0));
    expect(atlasResidencyStats.promoted).toBe(1);

    const { ctx, draws } = fakeCtx();
    drawAtlasRegion(ctx, CARD_0.url, REGION, () => {});
    await settlePromotions();

    expect(captures).toBe(1); // captured ONCE — a second draw is not a second capture
    expect(draws[0][0]).toBe(bitmaps[0]); // …and it is the bitmap being drawn now, not the element
  });

  it("N sprites of one page on one frame capture once", async () => {
    load(CARD_0);
    for (let i = 0; i < 5; i += 1) {
      drawAtlasRegion(fakeCtx().ctx, CARD_0.url, { x: i * 64, y: 0, width: 64, height: 64 }, () => {});
    }
    await settlePromotions();

    expect(captures).toBe(1);
    expect(atlasResidencyStats.residentPages).toBe(1);
  });

  it("the capture is a macrotask, so it never lands inside the frame that triggered it", () => {
    load(CARD_0);
    drawAtlasRegion(fakeCtx().ctx, CARD_0.url, REGION, () => {});

    // Nothing has run yet: `createImageBitmap` is not guaranteed asynchronous, so the call itself is deferred.
    expect(captures).toBe(0);
  });

  it("a crop-source ask promotes too, but answers null until it lands", async () => {
    load(CARD_0);

    // The canvas stage's re-packer asks this per page per build. A miss must not hand back the element — the
    // caller already has one — but the ask is evidence the page is wanted, so it arms the capture.
    expect(atlasDecodedSource(CARD_0.url)).toBeNull();
    await settlePromotions();

    expect(atlasDecodedSource(CARD_0.url)).toBe(bitmaps[0]);
  });

  it("a page that cannot be captured stays drawable forever and is counted, not retried", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    load(CARD_0);

    drawAtlasRegion(fakeCtx().ctx, CARD_0.url, REGION, () => {});
    drawAtlasRegion(fakeCtx().ctx, CARD_0.url, REGION, () => {});
    await settlePromotions();

    expect(atlasResidencyStats.promoteFailed).toBe(1); // refused once, never re-asked
    expect(atlasResidencyStats.residentBytes).toBe(0);
    const { ctx, draws } = fakeCtx();
    expect(drawAtlasRegion(ctx, CARD_0.url, REGION, () => {})).toBe(true);
    expect(draws.length).toBe(1);
  });
});

describe("the cap releases the least-recently-drawn page", () => {
  /** Draw a page, let its capture land, then back-date it out of the grace window. */
  async function drawAndAge(page: { url: string }, ageMs: number): Promise<void> {
    drawAtlasRegion(fakeCtx().ctx, page.url, REGION, () => {});
    await settlePromotions();
    __ageAtlasUseForTest(page.url, ageMs);
  }

  it("evicts over the cap, oldest first, and CLOSES the bitmap", async () => {
    // 96 MB holds one 62 MB card sheet and not two — the shipped shape of the budget.
    __setAtlasResidencyForTest(96 * 1024 * 1024, "lazy");
    load(CARD_0);
    load(CARD_1);

    await drawAndAge(CARD_0, 60_000);
    expect(atlasResidencyStats.residentPages).toBe(1);

    await drawAndAge(CARD_1, 0);

    expect(__atlasOwnsPixelsForTest(CARD_0.url)).toBe(false);
    expect(__atlasOwnsPixelsForTest(CARD_1.url)).toBe(true);
    expect(atlasResidencyStats.evictedByCap).toBe(1);
    expect(atlasResidencyStats.residentBytes).toBe(bytesOf(CARD_1));
    // CLOSED, not merely dereferenced: an un-closed bitmap is exactly the memory this whole budget is reclaiming.
    expect(bitmaps[0].closed).toBe(true);
  });

  it("never evicts a page drawn inside the grace window, even over the cap", async () => {
    // THE ALWAYS-ALLOW-ONE RULE. A screen whose live working set exceeds the cap keeps its pages: evicting one
    // the next frame redraws turns a memory ceiling into a re-decode treadmill and costs both currencies.
    __setAtlasResidencyForTest(96 * 1024 * 1024, "lazy");
    load(CARD_0);
    load(CARD_1);

    await drawAndAge(CARD_0, 0);
    await drawAndAge(CARD_1, 0);

    expect(__atlasOwnsPixelsForTest(CARD_0.url)).toBe(true);
    expect(__atlasOwnsPixelsForTest(CARD_1.url)).toBe(true);
    expect(atlasResidencyStats.evictedByCap).toBe(0);
    expect(atlasResidencyStats.residentBytes).toBe(bytesOf(CARD_0) + bytesOf(CARD_1));
  });

  it("a cap of zero is off, not a cap of nothing", async () => {
    __setAtlasResidencyForTest(0, "lazy");
    load(CARD_0);
    load(CARD_1);

    await drawAndAge(CARD_0, 60_000);
    await drawAndAge(CARD_1, 60_000);

    expect(atlasResidencyStats.evictedByCap).toBe(0);
    expect(atlasResidencyStats.residentBytes).toBe(bytesOf(CARD_0) + bytesOf(CARD_1));
  });

  it("the default cap is the shipped constant", () => {
    __setAtlasResidencyForTest(undefined, undefined);

    // Read through the module's own constant so this pins the wiring, not a copy of the number.
    expect(atlasResidencyStats.residentCap).toBe(__atlasResidencyTuningForTest.ATLAS_RESIDENT_BYTES_DEFAULT);
    expect(__atlasResidencyTuningForTest.ATLAS_RESIDENT_BYTES_DEFAULT).toBe(96 * 1024 * 1024);
  });
});

describe("an eviction is invisible above this module", () => {
  it("leaves the size memo standing, so a 16 MP sheet keeps its canvas placeholder", async () => {
    // The failure this guards: if `atlasPageSize` went null on eviction, `atlasPlaceholderMechanism` would answer
    // "page" and CSS-crop a 16.4 MP sheet to paint one card — the decode storm atlasBaker was written to stop.
    __setAtlasResidencyForTest(96 * 1024 * 1024, "lazy");
    load(CARD_0);
    load(CARD_1);

    drawAtlasRegion(fakeCtx().ctx, CARD_0.url, REGION, () => {});
    await settlePromotions();
    __ageAtlasUseForTest(CARD_0.url, 60_000);
    drawAtlasRegion(fakeCtx().ctx, CARD_1.url, REGION, () => {});
    await settlePromotions();

    expect(__atlasOwnsPixelsForTest(CARD_0.url)).toBe(false);
    expect(atlasPageSize(CARD_0.url)).toEqual({ width: 4032, height: 4072 });
  });

  it("leaves the page drawable, and a redraw re-promotes it as a countable re-decode", async () => {
    __setAtlasResidencyForTest(96 * 1024 * 1024, "lazy");
    load(CARD_0);
    load(CARD_1);

    drawAtlasRegion(fakeCtx().ctx, CARD_0.url, REGION, () => {});
    await settlePromotions();
    __ageAtlasUseForTest(CARD_0.url, 60_000);
    drawAtlasRegion(fakeCtx().ctx, CARD_1.url, REGION, () => {});
    await settlePromotions();
    __ageAtlasUseForTest(CARD_1.url, 60_000);

    const { ctx, draws } = fakeCtx();
    expect(drawAtlasRegion(ctx, CARD_0.url, REGION, () => {})).toBe(true); // never blank — the element is still there
    expect(draws.length).toBe(1);
    await settlePromotions();

    expect(__atlasOwnsPixelsForTest(CARD_0.url)).toBe(true);
    // The only re-decode signal script can see. A browser dropping an element's own frame is invisible from here.
    expect(atlasResidencyStats.rePromoted).toBe(1);
  });
});
