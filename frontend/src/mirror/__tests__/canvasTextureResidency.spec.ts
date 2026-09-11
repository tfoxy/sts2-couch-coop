import { describe, expect, it, vi } from "vitest";

import { createDrawList, createQuadView, type CanvasTextureCache, type ExecutorTexture } from "@godot-scene-web/canvas";

import {
  TEXTURE_RESIDENT_BYTES_DEFAULT,
  createTextureBridge,
  type TextureBridge
} from "@/mirror/canvas/textureBridge";
import { createAtlasRepack } from "@/mirror/canvas/atlasRepack";

// THE RESIDENT PAGE-BYTE CAP (default 192 MB).
//
// WHY IT EXISTS. Before this the bridge's pages were the largest UNCAPPED resident population on the canvas
// stage. The two governors it had are neither of them budgets: the upload PACE shapes when bytes arrive, and the
// 240-build age-out is a CLOCK — a page the scene keeps naming never ages out however many pages arrive behind
// it. Measured on the host at the device's geometry, and DECOMPOSED — the census's `textures.bytes` is the shared
// cache total, not a page figure, because the fx surfaces and the other populations acquire from the same cache —
// settled PAGE totals were ~79.9 MB (combat), ~83.6 MB (audit-shop) and ~124.6 MB (r13-discard), and running the
// effects dynamic left the page total flat while quadrupling the shared one. So what the ceiling actually bounds
// is CROSS-SCREEN ACCUMULATION — the session that walks combat to shop to a map and keeps every page it ever
// drew, which is what "it gets progressively worse over a session" describes.
//
// `stats.pageBytes` exists because of that decomposition: before it, nothing published the bridge's own total.

interface FakeCache extends CanvasTextureCache {
  uploaded: string[];
  released: string[];
}

function fakeCache(): FakeCache {
  const entries = new Map<string, ExecutorTexture>();
  const uploaded: string[] = [];
  const released: string[] = [];
  const stats = { entries: 0, uploads: 0, evictions: 0, bytes: 0, respecs: 0 };
  return {
    uploaded,
    released,
    stats,
    white: () => ({ texture: {} as WebGLTexture, width: 1, height: 1 }),
    peek: (key) => entries.get(key),
    acquire: (key, source) => {
      const existing = entries.get(key);
      if (existing) return existing;
      const src = source as { naturalWidth?: number; naturalHeight?: number };
      const handle = {
        texture: {} as WebGLTexture,
        width: src.naturalWidth ?? 1,
        height: src.naturalHeight ?? 1
      };
      entries.set(key, handle);
      uploaded.push(key);
      stats.entries++;
      stats.uploads++;
      stats.bytes += handle.width * handle.height * 4;
      return handle;
    },
    acquireBytes: () => {
      throw new Error("unused");
    },
    retain: (key) => entries.get(key)!,
    release: (key) => {
      const entry = entries.get(key);
      if (!entry) return;
      entries.delete(key);
      released.push(key);
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
}

interface FakeImage {
  el: HTMLImageElement;
  resolve(w: number, h: number): void;
  src: string;
}

function imageFactory(): { create: () => HTMLImageElement; bySrc: Map<string, FakeImage> } {
  const bySrc = new Map<string, FakeImage>();
  const create = (): HTMLImageElement => {
    const listeners = new Map<string, Set<() => void>>();
    const el = {
      decoding: "",
      crossOrigin: null as string | null,
      naturalWidth: 0,
      naturalHeight: 0,
      addEventListener: (type: string, fn: () => void) => {
        let set = listeners.get(type);
        if (!set) listeners.set(type, (set = new Set()));
        set.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
      set src(value: string) {
        record.src = value;
        bySrc.set(value, record);
      },
      get src() {
        return record.src;
      }
    } as unknown as HTMLImageElement;
    const record: FakeImage = {
      el,
      src: "",
      resolve(w, h) {
        (el as { naturalWidth: number }).naturalWidth = w;
        (el as { naturalHeight: number }).naturalHeight = h;
        for (const fn of [...(listeners.get("load") ?? [])]) fn();
      }
    };
    return el;
  };
  return { create, bySrc };
}

const MB = 1024 * 1024;
/**
 * A page whose RGBA cost is EXACTLY `mb` megabytes: 1024 x (mb * 256) x 4 bytes. Rectangular rather than square
 * on purpose — a square page needs an irrational side for most sizes and the float error lands in the byte
 * totals these cases assert on.
 */
const pageSize = (mb: number): { w: number; h: number } => ({ w: 1024, h: mb * 256 });

interface Harness {
  bridge: TextureBridge;
  cache: FakeCache;
  build(urls: readonly string[]): void;
  resolve(url: string, mb: number): void;
}

function harness(opts: { residentBytes?: number } = {}): Harness {
  const cache = fakeCache();
  const images = imageFactory();
  const bridge = createTextureBridge({
    cache,
    onResolved: vi.fn(),
    onPaced: vi.fn(),
    createImage: images.create,
    // The pace budget is a different feature and would otherwise defer the uploads these cases are about.
    paceBytes: 0,
    paceCount: 0,
    paceTinyBytes: 0,
    residentBytes: opts.residentBytes
  });
  const list = createDrawList<ExecutorTexture | null>();
  const adapted = bridge.adapt(list);
  const quad = createQuadView();
  return {
    bridge,
    cache,
    build(urls) {
      list.reset();
      adapted.reset();
      for (const url of urls) {
        // `sizeOf` is what the real builder asks first (it needs the page size for UVs) and it is what STARTS
        // the load; the push is where an upload can happen.
        bridge.sizeOf(url);
        adapted.pushQuad(quad, url);
      }
      bridge.endBuild();
    },
    resolve(url, mb) {
      const { w, h } = pageSize(mb);
      images.bySrc.get(url)?.resolve(w, h);
    }
  };
}

/** Name `urls` until every one has uploaded (a url is fetched on its first build and uploads on the next). */
function warm(h: Harness, urls: readonly string[], mb: number): void {
  h.build(urls);
  for (const url of urls) h.resolve(url, mb);
  h.build(urls);
}

describe("texture bridge resident cap", () => {
  it("returns a source mapping only after the exact page is resident, without starting its upload", () => {
    const h = harness();
    const src = { srcX: 48, srcY: 0, srcW: 48, srcH: 51 };

    // A source-only animation frame must not turn a cache miss into an upload or even a new page request.
    expect(h.bridge.residentSource("intent-page", src)).toBeNull();
    expect(h.cache.uploaded).toEqual([]);

    h.build(["intent-page"]);
    h.resolve("intent-page", 1);
    h.build(["intent-page"]);
    const resident = h.bridge.residentSource("intent-page", src);
    expect(resident).not.toBeNull();
    expect(resident?.dx).toBe(0);
    expect(resident?.dy).toBe(0);
    expect(resident?.handle).toBe(h.cache.peek("intent-page"));
  });

  it("returns a resident atlas crop with rebased UVs, and never cuts a missing crop on a source-only query", () => {
    const cache = fakeCache();
    const images = imageFactory();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      globalCompositeOperation: "source-over",
      drawImage: vi.fn()
    } as unknown as CanvasRenderingContext2D);
    const bridge = createTextureBridge({
      cache,
      onResolved: vi.fn(),
      createImage: images.create,
      paceBytes: 0,
      paceCount: 0,
      paceTinyBytes: 0,
      repack: (host) => createAtlasRepack({ cache, host, minPagePixels: 1 })
    });
    const list = createDrawList<ExecutorTexture | null>();
    const adapted = bridge.adapt(list);
    const source = { srcX: 48, srcY: 0, srcW: 48, srcH: 51 };
    const quad = createQuadView();
    quad.srcX = source.srcX;
    quad.srcY = source.srcY;
    quad.srcW = source.srcW;
    quad.srcH = source.srcH;

    try {
      bridge.sizeOf("intent-atlas");
      images.bySrc.get("intent-atlas")?.resolve(1024, 1024);
      adapted.pushQuad(quad, "intent-atlas"); // creates the crop on the ordinary build path
      const resident = bridge.residentSource("intent-atlas", source);
      expect(resident).not.toBeNull();
      expect(resident?.handle).toBe(list.textureAt(0));
      expect(resident?.dx).toBe(-44);
      expect(Math.abs(resident?.dy ?? Number.NaN)).toBe(0);

      const uploads = cache.uploaded.length;
      expect(bridge.residentSource("intent-atlas", { ...source, srcX: 500 })).toBeNull();
      expect(cache.uploaded).toHaveLength(uploads); // source patch did not crop or upload the missing mapping
    } finally {
      getContext.mockRestore();
      bridge.dispose();
    }
  });

  it("publishes the ceiling and the total it is compared against", () => {
    const h = harness({ residentBytes: 64 * MB });
    warm(h, ["a", "b"], 8);
    expect(h.bridge.stats.residentCap).toBe(64 * MB);
    expect(h.bridge.stats.pageBytes).toBe(16 * MB);
    expect(h.bridge.stats.evictedByCap).toBe(0);
  });

  it("evicts nothing while the total is under the ceiling", () => {
    const h = harness({ residentBytes: 64 * MB });
    warm(h, ["a", "b", "c"], 8);
    // Several more builds that name nothing: the age-out is 240 builds away and the cap is not reached.
    for (let i = 0; i < 5; i++) h.build([]);
    expect(h.bridge.stats.evictedByCap).toBe(0);
    expect(h.cache.released).toEqual([]);
  });

  // LRU by the residency clock the bridge already keeps (`lastSeen`), oldest first, and only as far as it must.
  it("releases least-recently-drawn pages first, and stops once under the ceiling", () => {
    const h = harness({ residentBytes: 40 * MB });
    warm(h, ["old", "mid", "new"], 16); // 48 MB resident, over a 40 MB ceiling
    // Re-name two of them so their clocks move; "old" keeps the oldest lastSeen.
    h.build(["mid", "new"]);
    h.build(["mid", "new"]);
    // Exactly one page had to go to get from 48 MB to 32 MB, and it is the oldest.
    expect(h.cache.released).toEqual(["old"]);
    expect(h.bridge.stats.evictedByCap).toBe(1);
    expect(h.bridge.stats.pageBytes).toBe(32 * MB);
  });

  // THE ALWAYS-ALLOW-ONE RULE. If the working set alone exceeds the ceiling then the CAP LOSES: evicting a
  // texture the very next build re-uploads converts a memory ceiling into an upload treadmill and makes the
  // screen worse in both currencies at once.
  it("never evicts a page the build that just ended drew, even over the ceiling", () => {
    const h = harness({ residentBytes: 8 * MB });
    warm(h, ["a", "b", "c"], 16); // 48 MB resident against an 8 MB ceiling, all three named every build
    expect(h.cache.released).toEqual([]);
    expect(h.bridge.stats.evictedByCap).toBe(0);
    expect(h.bridge.stats.pageBytes).toBe(48 * MB);
  });

  it("is disabled outright by an injected zero ceiling", () => {
    const h = harness({ residentBytes: 0 });
    warm(h, ["a", "b", "c"], 16);
    for (let i = 0; i < 5; i++) h.build([]);
    expect(h.bridge.stats.residentCap).toBe(0);
    expect(h.bridge.stats.evictedByCap).toBe(0);
    expect(h.cache.released).toEqual([]);
  });

  // A cap eviction is a page that may well be wanted again, so recovery is a texImage2D from the retained element.
  it("re-uploads an evicted page from the retained element", () => {
    const h = harness({ residentBytes: 40 * MB });
    warm(h, ["old", "mid", "new"], 16);
    h.build(["mid", "new"]);
    h.build(["mid", "new"]);
    expect(h.cache.released).toEqual(["old"]);
    const uploadsBefore = h.cache.uploaded.length;
    // The scene names it again. It comes straight back.
    h.build(["old", "mid", "new"]);
    expect(h.cache.uploaded.length).toBe(uploadsBefore + 1);
    expect(h.cache.uploaded[h.cache.uploaded.length - 1]).toBe("old");
  });

  // Separate counters because they mean opposite things: an age-out is a page nothing wants any more, a cap
  // eviction is a page that may be wanted next build, and only the second says the ceiling is too low.
  it("counts cap evictions apart from age-outs", () => {
    const h = harness({ residentBytes: 40 * MB });
    warm(h, ["old", "mid", "new"], 16);
    h.build(["mid", "new"]);
    h.build(["mid", "new"]);
    expect(h.bridge.stats.evictedByCap).toBe(1);
    expect(h.bridge.stats.evicted).toBe(0);
  });

  it("defaults to 192MB — above every measured single-screen page total, with headroom", () => {
    expect(TEXTURE_RESIDENT_BYTES_DEFAULT).toBe(192 * MB);
    const h = harness();
    warm(h, ["a"], 8);
    expect(h.bridge.stats.residentCap).toBe(192 * MB);
  });
});
