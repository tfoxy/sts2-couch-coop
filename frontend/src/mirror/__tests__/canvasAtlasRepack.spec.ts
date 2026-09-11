import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDrawList,
  createNinePatchView,
  createQuadView,
  type CanvasTextureCache,
  type ExecutorTexture,
  type NinePatchView,
  type QuadView
} from "@godot-scene-web/canvas";

import {
  createTextureBridge,
  type TextureBridge
} from "@/mirror/canvas/textureBridge";
import {
  REPACK_APRON,
  REPACK_KEY_PREFIX,
  REPACK_MIN_PAGE_PIXELS_DEFAULT,
  REPACK_QUANTUM,
  createAtlasRepack,
  repackCrop,
  repackKey,
  type AtlasRepackHost,
  type AtlasRepacker,
  type RepackSrcRect
} from "@/mirror/canvas/atlasRepack";

// RUNTIME ATLAS RE-PACKING. A card sheet is 4032x4072 (62.6 MB of RGBA) and a card-reward screen crops THREE
// regions out of it; the bridge's pacing cannot split one `texImage2D`, so the only way under that floor is to
// never name the page. These are the properties the crop has to have for that to be invisible.
//
// The cache below counts what it was asked to upload rather than uploading anything (the pacing spec's harness,
// widened to size a canvas source), and `acquireBytes` THROWS — a re-pack that reached for it would be
// double-premultiplying a canvas that already is, which is the module's loudest failure mode.

interface FakeCache extends CanvasTextureCache {
  /** Keys passed to `acquire`, IN ORDER. */
  uploaded: string[];
  /** The source object each `acquire` was handed — the premultiply assertion reads this. */
  sources: unknown[];
  released: string[];
}

function fakeCache(): FakeCache {
  const entries = new Map<string, ExecutorTexture>();
  const uploaded: string[] = [];
  const sources: unknown[] = [];
  const released: string[] = [];
  const stats = { entries: 0, uploads: 0, evictions: 0, bytes: 0, respecs: 0 };
  const cache: FakeCache = {
    uploaded,
    sources,
    released,
    stats,
    white: () => ({ texture: {} as WebGLTexture, width: 1, height: 1 }),
    peek: (key) => entries.get(key),
    acquire: (key, source) => {
      const existing = entries.get(key);
      if (existing) return existing;
      const src = source as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
      const handle = {
        texture: {} as WebGLTexture,
        width: src.naturalWidth ?? src.width ?? 1,
        height: src.naturalHeight ?? src.height ?? 1
      };
      entries.set(key, handle);
      uploaded.push(key);
      sources.push(source);
      stats.entries++;
      stats.uploads++;
      stats.bytes += handle.width * handle.height * 4;
      return handle;
    },
    acquireBytes: () => {
      throw new Error("acquireBytes would premultiply a premultiplied canvas — see atlasRepack's header");
    },
    retain: (key) => entries.get(key)!,
    release: (key) => {
      released.push(key);
      const entry = entries.get(key);
      if (!entry) return;
      entries.delete(key);
      stats.entries--;
      stats.evictions++;
      stats.bytes -= entry.width * entry.height * 4;
    },
    updateRegion: () => {
      throw new Error("unused");
    },
    update: () => {
      throw new Error("unused");
    },
    reset: () => {
      entries.clear();
      stats.entries = 0;
      stats.bytes = 0;
    },
    dispose: () => entries.clear()
  };
  return cache;
}

// A CONTROLLABLE CLOCK for the crop timer. `atlasRepack` reads `performance.now` around its own `drawImage`, so a
// spec that wants to show it a 290 ms re-decode has to move the clock rather than the calendar. The offset is
// zero unless a test asks, which makes this spy invisible to every other test in the file.
let clockOffset = 0;
const realNow = performance.now.bind(performance);
vi.spyOn(performance, "now").mockImplementation(() => realNow() + clockOffset);

function advanceClock(ms: number): void {
  clockOffset += ms;
}

beforeEach(() => {
  clockOffset = 0;
});

interface FakeCanvas {
  el: HTMLCanvasElement;
  /** Every `getContext` call's second argument, so the `willReadFrequently` contract is assertable. */
  contextOptions: unknown[];
  /**
   * One entry per `drawImage`: the crop rect it was asked for, the canvas size at the time, and the SOURCE it
   * read from — the last of those is what says whether the re-packer cut from the bridge's evictable `<img>` or
   * from the eviction-proof bitmap it was offered.
   */
  draws: {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    canvasW: number;
    canvasH: number;
    composite: string;
    source: unknown;
  }[];
  /** Sizes the canvas was resized to, in order. */
  sizes: string[];
}

function fakeCanvas(options: { noContext?: boolean; throwOnDraw?: boolean; drawMs?: number } = {}): FakeCanvas {
  const contextOptions: unknown[] = [];
  const draws: FakeCanvas["draws"] = [];
  const sizes: string[] = [];
  let w = 0;
  let h = 0;
  const ctx = {
    globalCompositeOperation: "source-over",
    drawImage(src: unknown, sx: number, sy: number, sw: number, sh: number) {
      if (options.throwOnDraw) {
        throw new Error("tainted");
      }
      // `drawMs` stands in for a re-decode: the module times its own `drawImage` and this is the only way a spec
      // can put a pathological one in front of it. Advancing the clock beats sleeping — the module reads
      // `performance.now`, and a spec that actually slept would add its cost to every run.
      if (options.drawMs) {
        advanceClock(options.drawMs);
      }
      draws.push({ sx, sy, sw, sh, canvasW: w, canvasH: h, composite: ctx.globalCompositeOperation, source: src });
    }
  };
  const el = {
    get width() {
      return w;
    },
    set width(v: number) {
      w = v;
      sizes.push(`${w}x${h}`);
      // The real thing resets context state on a resize; the spec pins that the module re-states the composite op.
      ctx.globalCompositeOperation = "source-over";
    },
    get height() {
      return h;
    },
    set height(v: number) {
      h = v;
      sizes.push(`${w}x${h}`);
      ctx.globalCompositeOperation = "source-over";
    },
    getContext(_type: string, opts?: unknown) {
      contextOptions.push(opts);
      return options.noContext ? null : ctx;
    }
  } as unknown as HTMLCanvasElement;
  return { el, contextOptions, draws, sizes };
}

/** A decoded page stand-in — the module only hands it to `drawImage`. */
function fakePage(width: number, height: number): CanvasImageSource {
  return { width, height } as unknown as CanvasImageSource;
}

interface Harness {
  repack: AtlasRepacker;
  cache: FakeCache;
  canvas: FakeCanvas;
  admit: ReturnType<typeof vi.fn>;
  noteUpload: ReturnType<typeof vi.fn>;
  /** `claims` then `regionFor` in one call, the way the bridge asks. */
  ask(url: string, pageW: number, pageH: number, src: RepackSrcRect): ReturnType<AtlasRepacker["regionFor"]> | null;
}

function harness(
  opts: {
    minPagePixels?: number;
    maxBytes?: number;
    evictAfterBuilds?: number;
    maxTextureDim?: number;
    admit?: (bytes: number) => boolean;
    canvas?: FakeCanvas;
  } = {}
): Harness {
  const cache = fakeCache();
  const canvas = opts.canvas ?? fakeCanvas();
  const admit = vi.fn((bytes: number) => (opts.admit ? opts.admit(bytes) : true));
  const noteUpload = vi.fn();
  const host: AtlasRepackHost = { admit, noteUpload };
  const repack = createAtlasRepack({
    cache,
    host,
    minPagePixels: opts.minPagePixels,
    maxBytes: opts.maxBytes,
    evictAfterBuilds: opts.evictAfterBuilds,
    maxTextureDim: opts.maxTextureDim,
    createCanvas: () => canvas.el
  });
  return {
    repack,
    cache,
    canvas,
    admit,
    noteUpload,
    ask(url, pageW, pageH, src) {
      if (!repack.claims(url, pageW, pageH, src)) {
        return null;
      }
      return repack.regionFor(url, fakePage(pageW, pageH), pageW, pageH, src);
    }
  };
}

const CARD_W = 4032;
const CARD_H = 4072;
const region = (x: number, y: number, w: number, h: number): RepackSrcRect => ({
  srcX: x,
  srcY: y,
  srcW: w,
  srcH: h
});

describe("the crop algebra", () => {
  it("grows a region by the apron and snaps outward to the quantum", () => {
    // 100..600 x 200..900, +1 apron = 99..601 x 199..901, snapped out to multiples of 4 = 96..604 x 196..904.
    expect(repackCrop(CARD_W, CARD_H, region(100, 200, 500, 700))).toEqual({ x: 96, y: 196, w: 508, h: 708 });
    expect(REPACK_APRON).toBe(1);
    expect(REPACK_QUANTUM).toBe(4);
  });

  it("clamps the apron at a page edge, which CLAMP_TO_EDGE makes exact", () => {
    const crop = repackCrop(CARD_W, CARD_H, region(0, 0, 64, 64));
    expect(crop).toEqual({ x: 0, y: 0, w: 68, h: 68 });
    // …and at the far edge, where the snap would otherwise run past the page.
    const far = repackCrop(CARD_W, CARD_H, region(CARD_W - 64, CARD_H - 64, 64, 64));
    expect(far.x + far.w).toBe(CARD_W);
    expect(far.y + far.h).toBe(CARD_H);
  });

  it("covers a FRACTIONAL source rect entirely, and rebases it by an integer", () => {
    const src = region(100.25, 200.75, 500.5, 700.5);
    const crop = repackCrop(CARD_W, CARD_H, src);
    // Whole-texel containment first, then apron and snap: the crop must strictly contain the sampled rect.
    expect(crop.x).toBeLessThanOrEqual(src.srcX - REPACK_APRON);
    expect(crop.y).toBeLessThanOrEqual(src.srcY - REPACK_APRON);
    expect(crop.x + crop.w).toBeGreaterThanOrEqual(src.srcX + src.srcW + REPACK_APRON);
    expect(crop.y + crop.h).toBeGreaterThanOrEqual(src.srcY + src.srcH + REPACK_APRON);
    // The rebase is the origin negated, and an INTEGER — which is what keeps the adapter's restore bit-exact for
    // the integer source rects the atlas emitters actually push.
    expect(Number.isInteger(crop.x)).toBe(true);
    expect(Number.isInteger(crop.y)).toBe(true);
  });

  it("collapses a wobbling source rect onto the quantum grid", () => {
    const key = (src: RepackSrcRect): string =>
      repackKey("/res/card_atlas_0.png", repackCrop(CARD_W, CARD_H, src));
    const a = key(region(100, 200, 500, 700));
    expect(a).toBe(`${REPACK_KEY_PREFIX}/res/card_atlas_0.png#96,196,508,708`);
    // Two rects that snap into the SAME grid cell are one texture, not two — which is the whole of the churn
    // guard. It is a BOUND, not an identity: the grid is 4 px, so a wobble that crosses a cell boundary does mint
    // a second key (and the byte cap is what stops a pathological one accumulating).
    expect(key(region(101, 201, 500, 700))).toBe(key(region(102, 202, 499, 699)));
    expect(key(region(101, 201, 500, 700))).not.toBe(a);
    // …and every distinct key is aligned to the grid, so the population is bounded by the page, not by the wobble.
    for (const dx of [0, 1, 2, 3, 4, 5]) {
      const crop = repackCrop(CARD_W, CARD_H, region(100 + dx, 200, 500, 700));
      expect(crop.x % REPACK_QUANTUM).toBe(0);
      expect((crop.x + crop.w) % REPACK_QUANTUM).toBe(0);
    }
    // A region genuinely elsewhere still gets its own key.
    expect(key(region(900, 200, 500, 700))).not.toBe(a);
  });
});

describe("the page-size predicate", () => {
  it("claims a card sheet and ignores everything under the threshold", () => {
    const h = harness();
    expect(REPACK_MIN_PAGE_PIXELS_DEFAULT).toBe(6_000_000);
    expect(h.repack.claims("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))).toBe(true);
    // ui_atlas 2048x2048 = 4.19 MP — the largest non-card page, and below the gap.
    expect(h.repack.claims("/res/ui_atlas_0.png", 2048, 2048, region(10, 10, 64, 64))).toBe(false);
  });

  it("takes the boundary exactly: >= the threshold claims, one pixel under does not", () => {
    const h = harness({ minPagePixels: 1000 });
    expect(h.repack.claims("/res/a.png", 100, 10, region(1, 1, 8, 8))).toBe(true);
    expect(h.repack.claims("/res/b.png", 99, 10, region(1, 1, 8, 8))).toBe(false);
  });

  it("refuses a whole-page source rect and promotes the PAGE, so nothing pays twice", () => {
    const h = harness();
    // One region lands first…
    expect(h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))?.kind).toBe("region");
    expect(h.repack.holds("/res/card_atlas_0.png")).toBe(true);
    // …then a `NinePatchRect`-over-a-plain-image quad names the same page with a zero-span rect.
    expect(h.repack.claims("/res/card_atlas_0.png", CARD_W, CARD_H, region(0, 0, 0, 0))).toBe(false);
    // The page is now unrepackable, its crop has been given back, and no later quad claims it.
    expect(h.repack.holds("/res/card_atlas_0.png")).toBe(false);
    expect(h.cache.released).toEqual([`${REPACK_KEY_PREFIX}/res/card_atlas_0.png#96,196,508,708`]);
    expect(h.repack.claims("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))).toBe(false);
    expect(h.repack.stats().refusedPages).toBe(1);
  });

  it("refuses a crop bigger than a quarter of the page", () => {
    const h = harness();
    // Half the page in each axis is a quarter of the AREA — just inside…
    expect(h.repack.claims("/res/card_atlas_0.png", CARD_W, CARD_H, region(0, 0, CARD_W / 2 - 8, CARD_H / 2 - 8))).toBe(
      true
    );
    // …and over it the page is promoted rather than the quad being served.
    expect(h.repack.claims("/res/big.png", CARD_W, CARD_H, region(0, 0, CARD_W, CARD_H))).toBe(false);
    expect(h.repack.stats().refusedPages).toBe(1);
  });
});

describe("cropping and uploading", () => {
  it("hands the CANVAS ELEMENT to acquire, never its bytes, and keeps the scratch CPU-side", () => {
    const h = harness();
    const out = h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700));
    expect(out?.kind).toBe("region");
    // `acquireBytes` throws in the fake cache: reaching for it would double-premultiply (see the module header).
    expect(h.cache.uploaded).toEqual([`${REPACK_KEY_PREFIX}/res/card_atlas_0.png#96,196,508,708`]);
    expect(h.cache.sources[0]).toBe(h.canvas.el);
    expect(h.canvas.contextOptions).toEqual([{ willReadFrequently: true }]);
    // The crop is the snapped rect, drawn at the canvas's own origin, over a `copy` composite (a re-used scratch
    // must not let a previous region show through a transparent one).
    expect(h.canvas.draws).toEqual([
      {
        sx: 96,
        sy: 196,
        sw: 508,
        sh: 708,
        canvasW: 508,
        canvasH: 708,
        composite: "copy",
        // The direct harness cuts from the page it was handed; which source a crop reads is its own subject
        // (see "the crop source"), and this assertion only pins that it is the one passed in.
        source: { width: CARD_W, height: CARD_H }
      }
    ]);
  });

  it("rebases the source rect by the crop origin, negated", () => {
    const h = harness();
    const out = h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))!;
    expect(out.dx).toBe(-96);
    expect(out.dy).toBe(-196);
    // …so the quad samples 4,4 -> 504,704 inside a 508x708 crop: the apron is intact on every side.
    expect(100 + out.dx).toBe(4);
    expect(200 + out.dy).toBe(4);
  });

  it("uploads a region ONCE and answers the cached handle afterwards", () => {
    const h = harness();
    const first = h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))!.handle;
    h.repack.endBuild();
    const second = h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))!.handle;
    expect(second).toBe(first);
    expect(h.cache.uploaded).toHaveLength(1);
    expect(h.canvas.draws).toHaveLength(1);
    expect(h.repack.stats().crops).toBe(1);
    expect(h.repack.stats().regions).toBe(1);
  });

  it("charges the host's budget and holds a region back when the build has spent it", () => {
    let allow = true;
    const h = harness({ admit: () => allow });
    const first = h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))!;
    expect(first.kind).toBe("region");
    expect(h.admit).toHaveBeenCalledWith(508 * 708 * 4);
    expect(h.noteUpload).toHaveBeenCalledTimes(1);
    expect(h.noteUpload.mock.calls[0][0]).toBe(508 * 708 * 4);

    allow = false;
    const held = h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(2000, 200, 500, 700))!;
    expect(held.kind).toBe("paced");
    expect(held.handle).toBeNull();
    expect(h.cache.uploaded).toHaveLength(1);
    // …and it lands on a later build, with no state to unwind.
    h.repack.endBuild();
    allow = true;
    expect(h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(2000, 200, 500, 700))!.kind).toBe("region");
    expect(h.cache.uploaded).toHaveLength(2);
  });

  it("refuses a crop over MAX_TEXTURE_SIZE and lets the page serve it", () => {
    const h = harness({ maxTextureDim: 256 });
    const out = h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700));
    expect(out?.kind).toBe("refused");
    expect(h.cache.uploaded).toEqual([]);
    expect(h.repack.stats().declined).toBe(1);
    expect(h.repack.stats().refusedPages).toBe(1);
  });

  it("RESCUES a page that is itself over MAX_TEXTURE_SIZE, which the bridge can only refuse", () => {
    // 9000x9000 is 81 MP: the bridge marks such a url failed and every quad naming it paints transparent. A crop
    // of it is 508x708 and uploads fine, so the regions are the only pixels this page will ever have.
    const h = harness({ maxTextureDim: 8192 });
    const out = h.ask("/res/huge_atlas.png", 9000, 9000, region(100, 200, 500, 700));
    expect(out?.kind).toBe("region");
    expect(h.cache.uploaded).toHaveLength(1);
  });

  it("steps aside entirely when there is no 2D context", () => {
    const h = harness({ canvas: fakeCanvas({ noContext: true }) });
    expect(h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))?.kind).toBe("refused");
    expect(h.cache.uploaded).toEqual([]);
    // Latched: the next quad is not even claimed, so the bridge's page path serves the whole screen.
    expect(h.repack.claims("/res/card_atlas_0.png", CARD_W, CARD_H, region(900, 200, 500, 700))).toBe(false);
    expect(h.canvas.contextOptions).toHaveLength(1);
  });

  it("promotes the page when the crop itself throws (a tainted source)", () => {
    const h = harness({ canvas: fakeCanvas({ throwOnDraw: true }) });
    expect(h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))?.kind).toBe("refused");
    expect(h.repack.stats().refusedPages).toBe(1);
    expect(h.repack.claims("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))).toBe(false);
  });
});

describe("residency", () => {
  it("releases a region the scene stopped naming, on the clock", () => {
    const h = harness({ evictAfterBuilds: 3 });
    h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700));
    expect(h.repack.stats().resident).toBe(1);
    for (let i = 0; i < 2; i++) h.repack.endBuild();
    expect(h.repack.stats().resident).toBe(1);
    h.repack.endBuild();
    expect(h.repack.stats().resident).toBe(0);
    expect(h.repack.stats().evicted).toBe(1);
    expect(h.repack.holds("/res/card_atlas_0.png")).toBe(false);
  });

  it("evicts LRU over the byte cap, and NEVER a region this build named", () => {
    const bytes = 508 * 708 * 4;
    const h = harness({ maxBytes: bytes * 2 + 1 });
    // Three regions, oldest first.
    h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700));
    h.repack.endBuild();
    h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(1100, 200, 500, 700));
    h.repack.endBuild();
    h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(2100, 200, 500, 700));
    expect(h.repack.stats().resident).toBe(3);
    h.repack.endBuild();
    // Over the cap by one region: the least-recently-named goes, and the one the last build named stays.
    expect(h.repack.stats().resident).toBe(2);
    expect(h.cache.released).toEqual([`${REPACK_KEY_PREFIX}/res/card_atlas_0.png#96,196,508,708`]);
    expect(h.repack.stats().evicted).toBe(1);
  });

  it("keeps the named set even when it alone is over the cap", () => {
    const h = harness({ maxBytes: 1 });
    h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700));
    h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(1100, 200, 500, 700));
    h.repack.endBuild();
    // Both were named by the build that just closed, so the cap loses rather than starting a re-crop loop.
    expect(h.repack.stats().resident).toBe(2);
    expect(h.repack.stats().evicted).toBe(0);
  });

  it("counts pages, not just regions", () => {
    const h = harness();
    h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700));
    h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(1100, 200, 500, 700));
    h.ask("/res/card_atlas_1.png", CARD_W, CARD_H, region(100, 200, 500, 700));
    const s = h.repack.stats();
    expect(s.regions).toBe(3);
    expect(s.resident).toBe(3);
    expect(s.pages).toBe(2);
    expect(s.bytes).toBe(508 * 708 * 4 * 3);
    expect(s.thresholdPixels).toBe(REPACK_MIN_PAGE_PIXELS_DEFAULT);
  });

  it("re-crops after a context loss, without touching the dead driver", () => {
    const h = harness();
    h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700));
    h.cache.reset(); // gsw's own context-lost hook
    h.repack.invalidate();
    expect(h.repack.stats().resident).toBe(0);
    expect(h.repack.holds("/res/card_atlas_0.png")).toBe(false);
    // NO `release` — the entries are already gone and the driver is dead.
    expect(h.cache.released).toEqual([]);
    // The next build re-crops from the page the bridge still retains, under the same key.
    expect(h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))?.kind).toBe("region");
    expect(h.canvas.draws).toHaveLength(2);
    expect(h.repack.stats().resident).toBe(1);
    // …and the key was NOT counted as a second distinct region.
    expect(h.repack.stats().regions).toBe(1);
  });

  it("re-crops when the cache drops an entry under it", () => {
    const h = harness();
    h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700));
    h.cache.reset();
    // No `invalidate` this time: the module finds the hole through `peek` and heals in place.
    expect(h.ask("/res/card_atlas_0.png", CARD_W, CARD_H, region(100, 200, 500, 700))?.kind).toBe("region");
    expect(h.canvas.draws).toHaveLength(2);
    expect(h.repack.stats().resident).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// THE BRIDGE SEAM. Everything above is the module alone; these are the properties that only exist once it is
// wired, and the first two are the whole reason the wiring took the shape it did.

/** An `<img>` stand-in whose load lands on command, at the pixel size the test asks for. */
function imageFactory(): {
  create: () => HTMLImageElement;
  resolveAll: (w: number, h: number) => void;
  /** Every element handed out, in order — how a spec counts FETCHES rather than uploads. */
  created: { el: HTMLImageElement; fire: (type: string) => void }[];
  /** Fail the most recent element instead of resolving it (the re-fetch-never-comes-back case). */
  failLast: () => void;
} {
  const created: { el: HTMLImageElement; fire: (type: string) => void }[] = [];
  const create = (): HTMLImageElement => {
    const listeners = new Map<string, Set<() => void>>();
    const el = {
      decoding: "",
      crossOrigin: null as string | null,
      naturalWidth: 0,
      naturalHeight: 0,
      src: "",
      addEventListener: (type: string, fn: () => void) => {
        let set = listeners.get(type);
        if (!set) listeners.set(type, (set = new Set()));
        set.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn)
    } as unknown as HTMLImageElement;
    created.push({ el, fire: (type) => [...(listeners.get(type) ?? [])].forEach((fn) => fn()) });
    return el;
  };
  return {
    create,
    created,
    failLast() {
      created[created.length - 1]?.fire("error");
    },
    resolveAll(w, h) {
      for (const rec of created) {
        (rec.el as { naturalWidth: number }).naturalWidth = w;
        (rec.el as { naturalHeight: number }).naturalHeight = h;
        rec.fire("load");
      }
    }
  };
}

interface QuadSpec {
  url: string;
  src: RepackSrcRect;
  ninePatch?: boolean;
}

interface BridgeHarness {
  bridge: TextureBridge;
  cache: FakeCache;
  canvas: FakeCanvas;
  images: ReturnType<typeof imageFactory>;
  /** Run one build that names `quads` in order, then close it. */
  build(quads: readonly QuadSpec[]): void;
  /** Every command's `textureAt` + read-back source rect, i.e. exactly what the paint dump prints. */
  dump(): string[];
  resolveAll(w: number, h: number): void;
}

function bridgeHarness(
  opts: {
    repack?: boolean;
    paceBytes?: number;
    maxTextureDim?: number;
    canvas?: FakeCanvas;
    decodedPageSource?: (url: string) => CanvasImageSource | null;
  } = {}
): BridgeHarness {
  const cache = fakeCache();
  const canvas = opts.canvas ?? fakeCanvas();
  const images = imageFactory();
  const bridge = createTextureBridge({
    cache,
    onResolved: () => {},
    onPaced: () => {},
    createImage: images.create,
    decodedPageSource: opts.decodedPageSource,
    // Pacing OFF unless a test is about it: the default 4 MB budget would hold back the 62 MB page on the `off`
    // arm and turn every comparison into a comparison of the PACER.
    paceBytes: opts.paceBytes ?? 0,
    maxTextureDim: opts.maxTextureDim,
    repack:
      opts.repack === false
        ? undefined
        : (host) =>
            createAtlasRepack({
              cache,
              host,
              maxTextureDim: opts.maxTextureDim,
              createCanvas: () => canvas.el
            })
  });
  const list = createDrawList<ExecutorTexture | null>();
  const adapted = bridge.adapt(list);
  const quad = createQuadView();
  const nine = createNinePatchView();

  return {
    bridge,
    cache,
    canvas,
    images,
    build(quads) {
      list.reset();
      adapted.reset();
      for (const spec of quads) {
        // `sizeOf` is what the real builder asks first (it needs the page size for UVs) and it is what STARTS the
        // load; the push is where an upload can happen.
        bridge.sizeOf(spec.url);
        const view: QuadView | NinePatchView = spec.ninePatch ? nine : quad;
        view.srcX = spec.src.srcX;
        view.srcY = spec.src.srcY;
        view.srcW = spec.src.srcW;
        view.srcH = spec.src.srcH;
        if (spec.ninePatch) {
          adapted.pushNinePatch(view as NinePatchView, spec.url);
        } else {
          adapted.pushQuad(view, spec.url);
        }
      }
      bridge.endBuild();
    },
    dump() {
      const out: string[] = [];
      const q = createQuadView();
      const n = createNinePatchView();
      for (let i = 0; i < list.count; i++) {
        const view = list.kindNameAt(i) === "ninePatch" ? adapted.readNinePatch(i, n) : adapted.readQuad(i, q);
        out.push(
          `${i} tex=${adapted.textureAt(i) ?? "-"} src=${view.srcX.toFixed(3)},${view.srcY.toFixed(3)},` +
            `${view.srcW.toFixed(3)},${view.srcH.toFixed(3)}`
        );
      }
      return out;
    },
    resolveAll: images.resolveAll
  };
}

const CARDS = "/res/card_atlas_0.png";
const UI = "/res/ui_atlas_0.png";

describe("the bridge's rp:// seam", () => {
  it("never uploads the page: the crops ARE the page's residency", () => {
    const h = bridgeHarness();
    h.build([{ url: CARDS, src: region(100, 200, 500, 700) }]);
    h.resolveAll(CARD_W, CARD_H);
    h.build([
      { url: CARDS, src: region(100, 200, 500, 700) },
      { url: CARDS, src: region(1100, 200, 500, 700) }
    ]);
    // Only `rp://` keys were uploaded — the 62 MB `acquire` never happened.
    expect(h.cache.uploaded.every((k) => k.startsWith(REPACK_KEY_PREFIX))).toBe(true);
    expect(h.cache.uploaded).toHaveLength(2);
    // …and the bridge says so in the currency the census reports.
    expect(h.bridge.stats.resident).toBe(0);
    expect(h.bridge.stats.repackServed).toBe(1);
    expect(h.bridge.stats.pageBytesAvoided).toBe(CARD_W * CARD_H * 4);
    expect(h.bridge.stats.repackPageFallbacks).toBe(0);
    expect(h.bridge.repackStats()?.regions).toBe(2);
  });

  it("answers the PAGE url and the ORIGINAL source rect — the dump is identical lever on or off", () => {
    const quads: QuadSpec[] = [
      { url: CARDS, src: region(100, 200, 500, 700) },
      { url: CARDS, src: region(1100, 200, 500, 700), ninePatch: true },
      { url: UI, src: region(10, 10, 64, 64) }
    ];
    const on = bridgeHarness();
    on.build(quads);
    on.resolveAll(CARD_W, CARD_H);
    on.build(quads);

    const off = bridgeHarness({ repack: false });
    off.build(quads);
    off.resolveAll(CARD_W, CARD_H);
    off.build(quads);

    // THE GATE, in miniature: what a reader of the draw list sees does not move. Not "within tolerance" —
    // identical, because the rebase is undone with the same integer it was made with.
    expect(on.dump()).toEqual(off.dump());
    expect(on.dump().some((line) => line.includes(REPACK_KEY_PREFIX))).toBe(false);
    expect(on.dump()[0]).toBe(`0 tex=${CARDS} src=100.000,200.000,500.000,700.000`);
    // …while the two arms uploaded completely different things.
    expect(on.cache.uploaded).not.toEqual(off.cache.uploaded);
    expect(off.cache.uploaded).toEqual([CARDS, UI]);
    expect(off.bridge.repackStats()).toBeNull();
  });

  it("rebases a NINE-PATCH too, so its bands derive from the crop", () => {
    const h = bridgeHarness();
    const quads: QuadSpec[] = [{ url: CARDS, src: region(100, 200, 500, 700), ninePatch: true }];
    h.build(quads);
    h.resolveAll(CARD_W, CARD_H);
    h.build(quads);
    expect(h.cache.uploaded).toEqual([`${REPACK_KEY_PREFIX}${CARDS}#96,196,508,708`]);
    // The read-back is the ORIGINAL rect; the executor's copy (the real list) carries the rebased one.
    expect(h.dump()).toEqual([`0 tex=${CARDS} src=100.000,200.000,500.000,700.000`]);
  });

  it("falls back to the whole page when one quad on it cannot be cropped", () => {
    const h = bridgeHarness();
    const quads: QuadSpec[] = [
      { url: CARDS, src: region(100, 200, 500, 700) },
      // A `NinePatchRect` over a plain image: a zero-span rect means "the whole texture", so the page must exist.
      { url: CARDS, src: region(0, 0, 0, 0), ninePatch: true }
    ];
    h.build(quads);
    h.resolveAll(CARD_W, CARD_H);
    h.build(quads);
    // The crop of the first quad happened, then the second promoted the page and gave it back…
    expect(h.cache.uploaded).toEqual([`${REPACK_KEY_PREFIX}${CARDS}#96,196,508,708`, CARDS]);
    expect(h.cache.released).toEqual([`${REPACK_KEY_PREFIX}${CARDS}#96,196,508,708`]);
    // …and from the next build on, the page serves everything: no page AND crops.
    h.build(quads);
    expect(h.cache.uploaded).toEqual([`${REPACK_KEY_PREFIX}${CARDS}#96,196,508,708`, CARDS]);
    expect(h.bridge.stats.resident).toBe(1);
    expect(h.bridge.stats.pageBytesAvoided).toBe(0);
    expect(h.bridge.repackStats()?.refusedPages).toBe(1);
    expect(h.bridge.stats.repackPageFallbacks).toBe(0);
  });

  it("charges the crop to the BUILD's ms but never to maxUploadMs", () => {
    const h = bridgeHarness();
    h.build([{ url: CARDS, src: region(100, 200, 500, 700) }]);
    h.resolveAll(CARD_W, CARD_H);
    h.build([{ url: CARDS, src: region(100, 200, 500, 700) }]);
    // The fake cache uploads instantly, so the interesting assertion is the SHAPE: one upload counted, a crop ms
    // that exists on its own line, and a `maxUploadMs` that never saw the `drawImage`.
    expect(h.bridge.stats.uploads).toBe(1);
    expect(h.bridge.stats.maxUploadMs).toBeLessThanOrEqual(h.bridge.stats.maxBuildUploadMs);
    expect(h.bridge.repackStats()?.crops).toBe(1);
    expect(h.bridge.repackStats()?.cropMs).toBeGreaterThanOrEqual(0);
  });

  it("spends the bridge's OWN budget, so a build cannot pay twice", () => {
    // One crop is 508*708*4 = 1.44 MB. A 2 MB budget admits one and stops (always-allow-one is used by the first).
    const h = bridgeHarness({ paceBytes: 2 * 1024 * 1024 });
    const quads: QuadSpec[] = [
      { url: CARDS, src: region(100, 200, 500, 700) },
      { url: CARDS, src: region(1100, 200, 500, 700) },
      { url: CARDS, src: region(2100, 200, 500, 700) }
    ];
    h.build(quads);
    h.resolveAll(CARD_W, CARD_H);
    h.build(quads);
    expect(h.cache.uploaded).toHaveLength(1);
    // The held quads paint transparent and the url still reads as "coming", so nothing reports itself finished.
    // (Three of the five are the first build's, before the page had decoded at all.)
    expect(h.bridge.stats.deferredQuads).toBe(3 + 2);
    expect(h.bridge.stats.pending).toBe(1);
    h.build(quads);
    expect(h.cache.uploaded).toHaveLength(2);
    h.build(quads);
    expect(h.cache.uploaded).toHaveLength(3);
    // …and once every crop has landed the url is served, not pending.
    h.build(quads);
    expect(h.bridge.stats.pending).toBe(0);
    expect(h.bridge.stats.repackServed).toBe(1);
  });

  it("still paints when there is no 2D canvas at all", () => {
    const h = bridgeHarness({ canvas: fakeCanvas({ noContext: true }) });
    const quads: QuadSpec[] = [{ url: CARDS, src: region(100, 200, 500, 700) }];
    h.build(quads);
    h.resolveAll(CARD_W, CARD_H);
    h.build(quads);
    // The page path served it: this is the arm a browser without a 2D context lands on, and it is today's picture.
    expect(h.cache.uploaded).toEqual([CARDS]);
    expect(h.bridge.stats.resident).toBe(1);
    expect(h.dump()).toEqual([`0 tex=${CARDS} src=100.000,200.000,500.000,700.000`]);
  });

  it("RESCUES a page over MAX_TEXTURE_SIZE, which the bridge alone can only refuse", () => {
    const quads: QuadSpec[] = [{ url: CARDS, src: region(100, 200, 500, 700) }];
    const off = bridgeHarness({ repack: false, maxTextureDim: 4096 });
    off.build(quads);
    off.resolveAll(9000, 9000);
    off.build(quads);
    expect(off.cache.uploaded).toEqual([]);
    expect(off.bridge.stats.oversized).toBe(1);
    expect(off.bridge.stats.failed).toBe(1);

    const on = bridgeHarness({ maxTextureDim: 4096 });
    on.build(quads);
    on.resolveAll(9000, 9000);
    on.build(quads);
    expect(on.cache.uploaded).toEqual([`${REPACK_KEY_PREFIX}${CARDS}#96,196,508,708`]);
    expect(on.bridge.stats.oversized).toBe(0);
    expect(on.bridge.stats.failed).toBe(0);
  });

  it("re-crops after a context loss without releasing anything", () => {
    const h = bridgeHarness();
    const quads: QuadSpec[] = [{ url: CARDS, src: region(100, 200, 500, 700) }];
    h.build(quads);
    h.resolveAll(CARD_W, CARD_H);
    h.build(quads);
    expect(h.cache.uploaded).toHaveLength(1);

    h.cache.reset(); // gsw's context-lost hook
    h.bridge.invalidate();
    expect(h.cache.released).toEqual([]);
    expect(h.bridge.stats.pageBytesAvoided).toBe(0);

    h.build(quads);
    expect(h.cache.uploaded).toEqual([
      `${REPACK_KEY_PREFIX}${CARDS}#96,196,508,708`,
      `${REPACK_KEY_PREFIX}${CARDS}#96,196,508,708`
    ]);
    expect(h.bridge.stats.pageBytesAvoided).toBe(CARD_W * CARD_H * 4);
  });
});

// THE CROP SOURCE, and the phone finding behind it.
//
// The re-packer was handed the bridge's own `<img>` and both modules costed the crop as a memcpy, because the
// bridge `decode()`s a page before it is ever `ready`. A Moto G86 combat trace (Aug-28) says otherwise: an
// `<img>`'s decoded frame is a CACHE, Chrome discards it under memory pressure, and `drawImage` then re-decodes
// the whole sheet synchronously — seven times in 29.5 s, 260-306 ms each, all inside a rAF, against a byte budget
// that thought it had spent 1.4 MB.
//
// Two answers, and these specs pin both: crop from pixels nobody can discard (`decodedPageSource`, in practice
// `atlasBaker`'s prefetched `ImageBitmap`s), and — for when there are none — stop one frame paying for several.
describe("the crop source", () => {
  /** A bitmap stand-in, distinguishable from the bridge's element by identity. */
  const bitmap = (width: number, height: number): CanvasImageSource =>
    ({ width, height, __bitmap: true }) as unknown as CanvasImageSource;

  it("cuts from the eviction-proof source when one is offered, not from the bridge's element", () => {
    const page = bitmap(CARD_W, CARD_H);
    const h = bridgeHarness({ decodedPageSource: () => page });
    h.build([{ url: CARDS, src: region(100, 200, 500, 700) }]);
    h.resolveAll(CARD_W, CARD_H);
    h.build([{ url: CARDS, src: region(100, 200, 500, 700) }]);

    expect(h.canvas.draws).toHaveLength(1);
    expect(h.canvas.draws[0].source).toBe(page);
    // …and the picture is untouched: the page still never uploads, and the region still does.
    expect(h.cache.uploaded.every((k) => k.startsWith(REPACK_KEY_PREFIX))).toBe(true);
    expect(h.bridge.repackStats()?.regions).toBe(1);
  });

  it("falls back to the element when the supplier has nothing — a page nobody prefetched", () => {
    const h = bridgeHarness({ decodedPageSource: () => null });
    h.build([{ url: CARDS, src: region(100, 200, 500, 700) }]);
    h.resolveAll(CARD_W, CARD_H);
    h.build([{ url: CARDS, src: region(100, 200, 500, 700) }]);

    expect(h.canvas.draws).toHaveLength(1);
    expect(h.canvas.draws[0].source).toBe(h.images.created[0].el);
  });

  it("IGNORES a source whose size disagrees with the page — it would cut a different sprite", () => {
    // The crop rect is in the coordinates of the page the bridge measured. A decode of any other size would be
    // cropped by those numbers and painted without complaint, so disagreement has to read as "no source".
    const wrong = bitmap(CARD_W / 2, CARD_H / 2);
    const h = bridgeHarness({ decodedPageSource: () => wrong });
    h.build([{ url: CARDS, src: region(100, 200, 500, 700) }]);
    h.resolveAll(CARD_W, CARD_H);
    h.build([{ url: CARDS, src: region(100, 200, 500, 700) }]);

    expect(h.canvas.draws).toHaveLength(1);
    expect(h.canvas.draws[0].source).not.toBe(wrong);
    expect(h.canvas.draws[0].source).toBe(h.images.created[0].el);
  });

  it("cuts a DECODE-HOSTILE page at most once per build, and paces the rest", () => {
    // Every `drawImage` in this harness costs 40 ms — a re-decode, not a memcpy. Three regions of one sheet in a
    // single build is the shape that produced the trace's ~300 ms frames.
    const slow = fakeCanvas({ drawMs: 40 });
    const h = bridgeHarness({ canvas: slow });
    const quads: QuadSpec[] = [
      { url: CARDS, src: region(100, 200, 500, 700) },
      { url: CARDS, src: region(1100, 200, 500, 700) },
      { url: CARDS, src: region(2100, 200, 500, 700) }
    ];
    h.build(quads);
    h.resolveAll(CARD_W, CARD_H);

    // Build 1 does not yet know the page is hostile, so it cuts once and LEARNS.
    h.build(quads);
    expect(slow.draws).toHaveLength(1);
    expect(h.bridge.repackStats()?.hostilePages).toBe(1);
    expect(h.bridge.repackStats()?.worstCropMs).toBeGreaterThanOrEqual(40);

    // From here the rule is load-bearing: one cut per build, so three regions cost three ordinary frames instead
    // of one stall. (The already-cut region is SERVED, which is free and does not spend the build's slot.)
    h.build(quads);
    expect(slow.draws).toHaveLength(2);
    h.build(quads);
    expect(slow.draws).toHaveLength(3);
    // …and once the set is complete, later builds are pure serves.
    h.build(quads);
    expect(slow.draws).toHaveLength(3);
    expect(h.bridge.repackStats()?.regions).toBe(3);
  });

  it("leaves a CHEAP page alone — the rule triggers on measured cost, not on page size", () => {
    // Same 62 MB sheet, same three regions, but the crops are memcpys. Nothing is held back.
    const fast = fakeCanvas();
    const h = bridgeHarness({ canvas: fast });
    const quads: QuadSpec[] = [
      { url: CARDS, src: region(100, 200, 500, 700) },
      { url: CARDS, src: region(1100, 200, 500, 700) },
      { url: CARDS, src: region(2100, 200, 500, 700) }
    ];
    h.build(quads);
    h.resolveAll(CARD_W, CARD_H);
    h.build(quads);

    expect(fast.draws).toHaveLength(3);
    expect(h.bridge.repackStats()?.hostilePages).toBe(0);
    expect(h.bridge.repackStats()?.regions).toBe(3);
  });
});
