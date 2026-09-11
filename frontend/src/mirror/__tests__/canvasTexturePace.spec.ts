import { describe, expect, it, vi } from "vitest";

import { createDrawList, createQuadView, type CanvasTextureCache, type ExecutorTexture } from "@godot-scene-web/canvas";

import {
  TEXTURE_PACE_BYTES_DEFAULT,
  TEXTURE_TINY_BUILD_BYTES,
  TEXTURE_TINY_BYTES_DEFAULT,
  createTextureBridge,
  type TextureBridge
} from "@/mirror/canvas/textureBridge";

// TEXTURE-UPLOAD PACING. `cache.acquire` calls `texImage2D` on the calling thread, so a build that names every url
// of a fresh screen uploads all of them inside that one task — the phone's 23.6 s first-textured-build storm. The
// bridge answers with a per-build BYTE budget and defers the rest; these are the properties that has to have.
//
// The cache below counts what it was asked to upload rather than uploading anything, which is the whole of what
// the pacer is deciding, and the image stub resolves on command so a test can order a build's arrivals exactly.

interface FakeCache extends CanvasTextureCache {
  /** Keys passed to `acquire`, IN ORDER — the upload log the budget is asserted against. */
  uploaded: string[];
}

function fakeCache(opts: { throwFor?: readonly string[] } = {}): FakeCache {
  const entries = new Map<string, ExecutorTexture>();
  const uploaded: string[] = [];
  const throwFor = new Set(opts.throwFor ?? []);
  const stats = { entries: 0, uploads: 0, evictions: 0, bytes: 0, respecs: 0 };
  const cache: FakeCache = {
    uploaded,
    stats,
    white: () => ({ texture: {} as WebGLTexture, width: 1, height: 1 }),
    peek: (key) => entries.get(key),
    acquire: (key, source) => {
      const existing = entries.get(key);
      if (existing) return existing;
      if (throwFor.has(key)) {
        // A tainted canvas is the realistic case: the CORS retry got us pixels the driver will not take. The
        // bridge answers with `markFailed`, which is one of the ABANDONMENT paths out of `awaitingUpload`.
        throw new Error(`tainted: ${key}`);
      }
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

/** An `<img>` stand-in whose load lands only when the test says so, at the pixel size the test asked for. */
interface FakeImage {
  el: HTMLImageElement;
  /** Fire `load` at `w`x`h` natural pixels. */
  resolve(w: number, h: number): void;
  fail(): void;
  src: string;
}

function imageFactory(options: { withDecode?: boolean } = {}): {
  create: () => HTMLImageElement;
  bySrc: Map<string, FakeImage>;
} {
  const bySrc = new Map<string, FakeImage>();
  const create = (): HTMLImageElement => {
    const listeners = new Map<string, Set<() => void>>();
    let decodeResolve: (() => void) | null = null;
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
    } as unknown as HTMLImageElement & { decode?: () => Promise<void> };
    if (options.withDecode) {
      // The real accelerator: readiness waits on `decode()` so the later `texImage2D` is not also a decode.
      el.decode = () =>
        new Promise<void>((res) => {
          decodeResolve = res;
        });
    }
    const fire = (type: string): void => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    };
    const record: FakeImage = {
      el,
      src: "",
      resolve(w, h) {
        (el as { naturalWidth: number }).naturalWidth = w;
        (el as { naturalHeight: number }).naturalHeight = h;
        fire("load");
        decodeResolve?.();
      },
      fail() {
        fire("error");
      }
    };
    return el;
  };
  return { create, bySrc };
}

interface Harness {
  bridge: TextureBridge;
  cache: FakeCache;
  /** Run one build that names `urls` in order, then close it. Returns the handles pushed, in the same order. */
  build(urls: readonly string[]): (ExecutorTexture | null)[];
  /** Fire `load` for every url named so far at `w`x`h`. */
  resolveAll(w: number, h: number): void;
  /** …or for ONE url, so a build can mix a 4 KB page with a 4 MB one (the tiny-exemption cases). */
  resolveOne(url: string, w: number, h: number): void;
  onPaced: ReturnType<typeof vi.fn>;
  onResolved: ReturnType<typeof vi.fn>;
  /** Run the scheduled bitmap captures and settle their promises. See {@link capturer}. */
  runCaptures(): Promise<void>;
  captures: Capturer;
}

/**
 * A stand-in for `createImageBitmap` plus the task hop the bridge schedules it in.
 *
 * BOTH halves are controlled on purpose: the point of the production code is that the capture happens in a task
 * of its OWN, so a test that could not tell "in the build" from "after the build" could not check the property
 * that matters.
 */
interface Capturer {
  /** Tasks the bridge asked to be scheduled but that have not run yet. */
  readonly queued: number;
  /** `close()` calls, in capture order — a bitmap that outlives its upload is the leak this bounds. */
  readonly closed: readonly number[];
  /** Elements handed to the capture, so a test can prove WHICH pixels were taken. */
  readonly captured: readonly HTMLImageElement[];
  schedule(task: () => void): void;
  decode(img: HTMLImageElement): Promise<ImageBitmap>;
  drain(): void;
}

function capturer(opts: { size?: { width: number; height: number }; fail?: boolean } = {}): Capturer {
  const tasks: Array<() => void> = [];
  const closed: number[] = [];
  const captured: HTMLImageElement[] = [];
  let seq = 0;
  return {
    get queued() {
      return tasks.length;
    },
    closed,
    captured,
    schedule: (task) => void tasks.push(task),
    drain: () => tasks.splice(0).forEach((task) => task()),
    decode(img) {
      captured.push(img);
      if (opts.fail) {
        return Promise.reject(new Error("undecodable"));
      }
      const id = seq++;
      const size = opts.size ?? { width: img.naturalWidth, height: img.naturalHeight };
      return Promise.resolve({ ...size, close: () => closed.push(id) } as unknown as ImageBitmap);
    }
  };
}

function harness(
  opts: {
    paceBytes?: number;
    paceCount?: number;
    paceTinyBytes?: number;
    maxTextureDim?: number;
    withDecode?: boolean;
    /** Urls whose `acquire` throws — the tainted-source path into `markFailed`. */
    throwFor?: readonly string[];
    /** Supply a capturer to exercise the owned-page path; omitted leaves bitmap capture unavailable. */
    captures?: Capturer;
  } = {}
): Harness {
  const cache = fakeCache({ throwFor: opts.throwFor });
  const images = imageFactory({ withDecode: opts.withDecode });
  const onPaced = vi.fn();
  const onResolved = vi.fn();
  const captures = opts.captures ?? capturer();
  const bridge = createTextureBridge({
    cache,
    onResolved,
    onPaced,
    createImage: images.create,
    // OFF unless a test asks: every case above this section is about the BUDGET, and an extra deferred build in
    // between would change what each of them is asserting without changing what it is about.
    decodeElement: opts.captures?.decode,
    scheduleDecode: opts.captures?.schedule,
    paceBytes: opts.paceBytes,
    paceCount: opts.paceCount,
    // Most cases below predate the tiny-page exemption and are ABOUT the budget, so they opt out by default and
    // keep testing exactly what they used to; the exemption has its own section at the bottom of this file.
    paceTinyBytes: opts.paceTinyBytes ?? 0,
    maxTextureDim: opts.maxTextureDim
  });
  const list = createDrawList<ExecutorTexture | null>();
  const adapted = bridge.adapt(list);
  const quad = createQuadView();

  return {
    bridge,
    cache,
    onPaced,
    onResolved,
    build(urls) {
      list.reset();
      adapted.reset();
      for (const url of urls) {
        // `sizeOf` is what the real builder asks first (it needs the page size for UVs) and it is what STARTS the
        // load; the push is where an upload can happen.
        bridge.sizeOf(url);
        adapted.pushQuad(quad, url);
      }
      const out: (ExecutorTexture | null)[] = [];
      for (let i = 0; i < list.count; i++) {
        out.push(list.textureAt(i));
      }
      bridge.endBuild();
      return out;
    },
    resolveAll(w, h) {
      for (const image of images.bySrc.values()) image.resolve(w, h);
    },
    resolveOne(url, w, h) {
      const image = images.bySrc.get(url);
      if (!image) {
        throw new Error(`no load in flight for ${url}`);
      }
      image.resolve(w, h);
    },
    captures,
    async runCaptures() {
      captures.drain();
      // Two turns: one for the capture's own promise, one for the `.then` the bridge chained onto it.
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

const MB = 1024 * 1024;
/** A url whose decoded page is `mb` megabytes of RGBA — the size the test resolves its image at. */
function sideFor(mb: number): number {
  return Math.round(Math.sqrt((mb * MB) / 4));
}

describe("stage-owned texture aliases", () => {
  it("keeps animated producer aliases bounded to the current draw-list build", () => {
    const x = harness();
    x.bridge.bindStageTexture("spine-stage://frame-0", {} as ExecutorTexture);
    x.bridge.bindStageTexture("spine-stage://frame-1", {} as ExecutorTexture);
    expect(x.bridge.stats.stageTextureBindings).toBe(2);
    x.bridge.beginStageTextureBuild();
    expect(x.bridge.stats.stageTextureBindings).toBe(0);
  });
});

describe("the per-build upload budget", () => {
  it("stops uploading once the build has spent its bytes, and finishes on later builds", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    const urls = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    h.build(urls); // starts the loads; nothing is decoded yet
    h.resolveAll(1024, 1024); // 4 MB each

    // 4 MB of budget and 4 MB per page: one upload lands, the rest are held.
    h.build(urls);
    expect(h.cache.uploaded).toEqual(["a.png"]);
    expect(h.bridge.stats.paced).toBe(4);

    h.build(urls);
    expect(h.cache.uploaded).toEqual(["a.png", "b.png"]);

    h.build(urls);
    h.build(urls);
    h.build(urls);
    expect(h.cache.uploaded).toEqual(urls);
    expect(h.bridge.stats.paced).toBe(0);
    expect(h.bridge.stats.resident).toBe(5);
  });

  it("packs several small pages into one build when they fit", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    const urls = ["a.png", "b.png", "c.png", "d.png"];
    h.build(urls);
    h.resolveAll(512, 512); // 1 MB each — all four fit in 4 MB

    h.build(urls);
    expect(h.cache.uploaded).toEqual(urls);
    expect(h.bridge.stats.paced).toBe(0);
  });

  it("caps the COUNT even when the bytes would fit — the fixed per-upload cost", () => {
    const h = harness({ paceBytes: 64 * MB, paceCount: 2 });
    const urls = ["a.png", "b.png", "c.png", "d.png"];
    h.build(urls);
    h.resolveAll(64, 64); // 16 KB each: the byte budget is nowhere near spent

    h.build(urls);
    expect(h.cache.uploaded).toEqual(["a.png", "b.png"]);
    h.build(urls);
    expect(h.cache.uploaded).toEqual(urls);
  });

  it("uploads a page LARGER than the whole budget rather than deadlocking on it", () => {
    // The always-allow-one rule. A 59 MB card atlas against a 4 MB budget must still land — it is one indivisible
    // `texImage2D`, and refusing it would leave every card unpainted forever.
    const h = harness({ paceBytes: 4 * MB });
    const side = sideFor(59);
    h.build(["atlas.png", "small.png"]);
    h.resolveAll(side, side);

    h.build(["atlas.png", "small.png"]);
    expect(h.cache.uploaded).toEqual(["atlas.png"]);
    h.build(["atlas.png", "small.png"]);
    expect(h.cache.uploaded).toEqual(["atlas.png", "small.png"]);
  });

  it("never puts two oversized pages in the same build", () => {
    // The storm-breaking property in one line: the always-allow-one rule passes the FIRST big page and the budget
    // stops the second, so no task ever carries two of them.
    const h = harness({ paceBytes: 4 * MB });
    const side = sideFor(38);
    h.build(["atlas0.png", "atlas1.png"]);
    h.resolveAll(side, side);

    h.build(["atlas0.png", "atlas1.png"]);
    expect(h.cache.uploaded).toEqual(["atlas0.png"]);
  });
});

describe("priority", () => {
  it("spends the budget in PAINT ORDER — the builder's own order is the priority", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    const painted = ["bg.png", "card.png", "tooltip.png"];
    h.build(painted);
    h.resolveAll(1024, 1024);

    h.build(painted);
    expect(h.cache.uploaded).toEqual(["bg.png"]);
    h.build(painted);
    expect(h.cache.uploaded).toEqual(["bg.png", "card.png"]);
    h.build(painted);
    expect(h.cache.uploaded).toEqual(painted);
  });

  it("follows the order the NEXT build paints in, not the order the urls arrived", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    h.build(["a.png", "b.png"]);
    h.resolveAll(1024, 1024);
    // The scene re-orders: `b` now paints first, so `b` is what the next slice of budget buys.
    h.build(["b.png", "a.png"]);
    expect(h.cache.uploaded).toEqual(["b.png"]);
  });
});

describe("what paints while a texture is pending", () => {
  it("pushes a paced quad FULLY TRANSPARENT, keeping its command index", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    h.build(["a.png", "b.png"]);
    h.resolveAll(1024, 1024);

    const handles = h.build(["a.png", "b.png"]);
    // Two commands either way — the deferred one holds its slot so ranges and clip intervals do not shift.
    expect(handles).toHaveLength(2);
    expect(handles[0]).not.toBeNull(); // uploaded
    expect(handles[1]).toBeNull(); // paced: no texture, and the quad went in at alpha 0
    expect(h.bridge.stats.deferredQuads).toBeGreaterThan(0);
  });

  it("counts a paced url as PENDING, so 'referenced - resident - failed' still reads as still-coming", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    const urls = ["a.png", "b.png", "c.png"];
    h.build(urls);
    expect(h.bridge.stats.pending).toBe(3); // three loads in flight
    expect(h.bridge.stats.paced).toBe(0);

    h.resolveAll(1024, 1024);
    h.build(urls);
    expect(h.bridge.stats.resident).toBe(1);
    expect(h.bridge.stats.paced).toBe(2);
    expect(h.bridge.stats.pending).toBe(2); // the two the pacer is holding, and nothing else
    expect(h.bridge.stats.failed).toBe(0);
  });

  it("stops counting a paced url as pending once the scene stops naming it", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    h.build(["a.png", "b.png"]);
    h.resolveAll(1024, 1024);
    h.build(["a.png", "b.png"]);
    expect(h.bridge.stats.paced).toBe(1);

    h.build(["a.png"]); // `b` left the screen before its turn came
    expect(h.bridge.stats.paced).toBe(0);
    expect(h.bridge.stats.pending).toBe(0);
  });
});

describe("the repaint the pacer asks for", () => {
  it("asks for another frame while it is holding uploads back, and stops when the queue drains", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    const urls = ["a.png", "b.png"];
    h.build(urls);
    h.resolveAll(1024, 1024);
    h.onPaced.mockClear();

    h.build(urls); // uploads `a`, holds `b`
    expect(h.onPaced).toHaveBeenCalledTimes(1);

    h.build(urls); // uploads `b`; nothing left to hold
    expect(h.onPaced).toHaveBeenCalledTimes(1);

    h.build(urls);
    expect(h.onPaced).toHaveBeenCalledTimes(1);
  });

  it("does not ask when nothing was held back", () => {
    const h = harness({ paceBytes: 64 * MB, paceCount: 0 });
    h.build(["a.png"]);
    h.resolveAll(256, 256);
    h.build(["a.png"]);
    expect(h.onPaced).not.toHaveBeenCalled();
  });
});

describe("the off lever", () => {
  it("uploads everything in one build when the budget is 0", () => {
    const h = harness({ paceBytes: 0, paceCount: 0 });
    const urls = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    h.build(urls);
    h.resolveAll(1024, 1024); // 4 MB each, 20 MB total

    h.build(urls);
    expect(h.cache.uploaded).toEqual(urls);
    expect(h.bridge.stats.paced).toBe(0);
    expect(h.onPaced).not.toHaveBeenCalled();
  });

  it("defaults to the documented budget when no option is passed", () => {
    const h = harness({});
    // Two pages of 3 MB: the first fits the 4 MB default, the second does not.
    const urls = ["a.png", "b.png"];
    h.build(urls);
    h.resolveAll(sideFor(3), sideFor(3));
    h.build(urls);
    expect(TEXTURE_PACE_BYTES_DEFAULT).toBe(4 * MB);
    expect(h.cache.uploaded).toEqual(["a.png"]);
  });
});

describe("maxTextureDimension", () => {
  it("refuses a source longer than the context's limit instead of uploading it incomplete", () => {
    // An over-limit `texImage2D` raises INVALID_VALUE rather than throwing, and the incomplete texture samples as
    // opaque BLACK. Refusing is what keeps the quad transparent — and stops the budget being spent on it forever.
    const h = harness({ maxTextureDim: 4096 });
    h.build(["huge.png"]);
    h.resolveAll(8192, 512);

    h.build(["huge.png"]);
    expect(h.cache.uploaded).toEqual([]);
    expect(h.bridge.stats.oversized).toBe(1);
    expect(h.bridge.stats.failed).toBe(1);
    expect(h.bridge.stats.pending).toBe(0);

    // And it is not retried on the next build.
    h.build(["huge.png"]);
    expect(h.bridge.stats.oversized).toBe(1);
  });

  it("uploads a page that fits the limit", () => {
    const h = harness({ maxTextureDim: 8192 });
    h.build(["atlas.png"]);
    h.resolveAll(4031, 3839);
    h.build(["atlas.png"]);
    expect(h.cache.uploaded).toEqual(["atlas.png"]);
  });
});

describe("decode", () => {
  it("holds readiness until decode() settles, so the upload is not also a decode", async () => {
    const h = harness({ withDecode: true, paceBytes: 0 });
    h.build(["a.png"]);
    h.resolveAll(256, 256); // fires `load` AND resolves the decode promise
    // `decode()` resolves on a microtask, so readiness is one turn behind the load event.
    expect(h.onResolved).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.onResolved).toHaveBeenCalledWith("a.png");
    h.build(["a.png"]);
    expect(h.cache.uploaded).toEqual(["a.png"]);
  });
});

// OWNED PAGE PIXELS. `decode()` above makes the FIRST upload cheap, but a decoded `<img>` frame is
// a cache the phone reclaims — after which `texImage2D` decodes the page again, inside the build. The Moto G86
// trace measured 40.5 / 37.0 / 36.8 / 18.7 / 18.0 / 17.5 / 14.2 ms of exactly that. These pin the answer.
describe("owned page pixels", () => {
  it("captures in a task of its OWN, then uploads pixels the browser cannot evict", async () => {
    const captures = capturer();
    const h = harness({ captures, paceBytes: 0 });
    h.build(["a.png"]);
    h.resolveAll(256, 256);

    // The build that WOULD have uploaded instead schedules a capture and paints transparent — and it schedules
    // it, rather than running it, because a synchronous `createImageBitmap` inside the build is the very cost
    // this is removing.
    h.build(["a.png"]);
    expect(h.cache.uploaded).toEqual([]);
    expect(captures.queued).toBe(1);
    expect(h.bridge.stats.pageDecodes).toBe(1);

    await h.runCaptures();
    h.build(["a.png"]);
    expect(h.cache.uploaded).toEqual(["a.png"]);
    expect(h.bridge.stats.pageOwnedUploads).toBe(1);
    expect(h.bridge.stats.pageElementUploads).toBe(0);
    // …and closed the moment it landed: the pixels are the GPU's, and a second copy on the JS heap is waste.
    expect(captures.closed).toEqual([0]);
  });

  it("keeps the page counted as pending while its capture is in flight", async () => {
    const captures = capturer();
    const h = harness({ captures, paceBytes: 0 });
    h.build(["a.png"]);
    h.resolveAll(256, 256);
    h.build(["a.png"]);
    // A page owed a frame must say so, or the caller stops repainting and the upload never happens.
    expect(h.bridge.stats.paced).toBe(1);
    expect(h.onPaced).toHaveBeenCalled();
    await h.runCaptures();
    h.build(["a.png"]);
    expect(h.bridge.stats.paced).toBe(0);
  });

  it("captures ONE page at a time", async () => {
    const captures = capturer();
    const h = harness({ captures, paceBytes: 0 });
    const urls = ["a.png", "b.png", "c.png"];
    h.build(urls);
    h.resolveAll(256, 256);
    h.build(urls);
    // Transient RGBA is bounded by one page, not by how many the screen names.
    expect(h.bridge.stats.pageDecodes).toBe(1);
    await h.runCaptures();
    h.build(urls);
    expect(h.cache.uploaded).toEqual(["a.png"]);
    expect(h.bridge.stats.pageDecodes).toBe(2); // the slot freed by `a.png`'s upload, spent on `b.png`
  });

  it("closes a capture the scene stopped naming, and frees the slot", async () => {
    const captures = capturer();
    const h = harness({ captures, paceBytes: 0 });
    h.build(["gone.png", "next.png"]);
    h.resolveAll(256, 256);
    h.build(["gone.png"]);
    await h.runCaptures();
    // The screen changed between the request and the resolve, so nothing ever spends these pixels.
    h.build(["next.png"]);
    h.build(["next.png"]);
    expect(captures.closed).toEqual([0]);
    expect(h.bridge.stats.pageDecodeStale).toBe(1);
  });

  it("falls back to the element when the capture rejects, and stops asking", async () => {
    const captures = capturer({ fail: true });
    const h = harness({ captures, paceBytes: 0 });
    h.build(["a.png"]);
    h.resolveAll(256, 256);
    h.build(["a.png"]);
    await h.runCaptures();
    expect(h.bridge.stats.pageDecodeFailed).toBe(1);
    h.build(["a.png"]);
    expect(h.cache.uploaded).toEqual(["a.png"]);
    expect(h.bridge.stats.pageElementUploads).toBe(1);
    expect(h.bridge.stats.pageDecodes).toBe(1); // never asked again
  });

  it("refuses pixels whose size disagrees with the page it measured", async () => {
    // A crop rect, a UV, and a quad are all in the coordinates read off the element. Differently-sized pixels
    // would paint the wrong thing silently, so they are treated as no pixels at all.
    const captures = capturer({ size: { width: 128, height: 128 } });
    const h = harness({ captures, paceBytes: 0 });
    h.build(["a.png"]);
    h.resolveAll(256, 256);
    h.build(["a.png"]);
    await h.runCaptures();
    expect(h.bridge.stats.pageDecodeFailed).toBe(1);
    expect(captures.closed).toEqual([0]);
    h.build(["a.png"]);
    expect(h.bridge.stats.pageElementUploads).toBe(1);
  });

  it("falls back to the element when no bitmap decoder is available", () => {
    vi.stubGlobal("createImageBitmap", undefined);
    try {
      const h = harness({ paceBytes: 0 });
      h.build(["a.png"]);
      h.resolveAll(256, 256);
      h.build(["a.png"]);
      expect(h.cache.uploaded).toEqual(["a.png"]);
      expect(h.bridge.stats.pageDecodes).toBe(0);
      expect(h.bridge.stats.pageElementUploads).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("upload accounting", () => {
  it("prices the storm: uploads, total ms, and the worst single build", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    const urls = ["a.png", "b.png", "c.png"];
    h.build(urls);
    h.resolveAll(1024, 1024);
    h.build(urls);
    h.build(urls);
    h.build(urls);

    expect(h.bridge.stats.uploads).toBe(3);
    expect(h.bridge.stats.uploadMs).toBeGreaterThanOrEqual(0);
    expect(h.bridge.stats.maxBuildUploadMs).toBeLessThanOrEqual(h.bridge.stats.uploadMs);
    expect(h.bridge.stats.lastUploadAt).toBeGreaterThan(0);
  });

  it("re-uploads through the pacer after a context loss", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    const urls = ["a.png", "b.png"];
    h.build(urls);
    h.resolveAll(1024, 1024);
    h.build(urls);
    h.build(urls);
    expect(h.bridge.stats.resident).toBe(2);

    h.cache.reset(); // gsw's context-lost hook
    h.bridge.invalidate();
    expect(h.bridge.stats.resident).toBe(0);

    // A restore re-uploads 2 pages' worth, and it is PACED exactly as the first build was.
    h.build(urls);
    expect(h.bridge.stats.resident).toBe(1);
    h.build(urls);
    expect(h.bridge.stats.resident).toBe(2);
  });
});

// THE TINY-PAGE EXEMPTION (R6 P6-B1).
//
// The budget above has no queue and no comparator on purpose: the builder's paint order IS the priority. That is
// right for atlas pages and wrong for one population — a texture of a few kilobytes wanted by something already on
// screen. The comet's trail page is 32x32 (4,096 bytes) and on a cold screen it queues behind ~158 MB of card
// atlas, so every ribbon draws its banded fallback for as many builds as that takes. Waiting is a real cost and
// the thing waited for is free.
//
// What is asserted here is that the exemption is BOUNDED at both ends: per upload (a byte over the ceiling is
// paced like anything else) and per build (a screen full of small art cannot use it to reinstate the storm). And
// that it is an admission rule only — an exempt upload is still an upload, still counted, still charged.
const KB = 1024;

describe("the tiny-page exemption", () => {
  it("admits a 4 KB page a spent budget would have deferred — the comet's case", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0, paceTinyBytes: 64 * KB });
    const urls = ["atlas.png", "trail.png"];
    h.build(urls);
    h.resolveOne("atlas.png", 1024, 1024); // 4 MB: the whole budget
    h.resolveOne("trail.png", 32, 32); // 4,096 bytes

    h.build(urls);
    // Without the exemption the atlas would spend the budget and the comet would wait a build (or many, on a
    // screen with a queue of pages behind it) drawing its banded fallback.
    expect(h.cache.uploaded).toEqual(["atlas.png", "trail.png"]);
    expect(h.bridge.stats.paced).toBe(0);
    expect(h.bridge.stats.paceExempt).toBe(1);
    expect(h.bridge.stats.paceTinyBytes).toBe(32 * 32 * 4);
  });

  it("paces a page ONE BYTE over the ceiling, exactly as before", () => {
    // The rule is `<=`, and the boundary is where a wrong comparison hides. 128x128 is 65,536 bytes = the 64 KB
    // ceiling exactly (admitted); the same page one row taller is not.
    const h = harness({ paceBytes: 4 * MB, paceCount: 0, paceTinyBytes: 64 * KB });
    h.build(["atlas.png", "edge.png"]);
    h.resolveOne("atlas.png", 1024, 1024);
    h.resolveOne("edge.png", 128, 128);
    h.build(["atlas.png", "edge.png"]);
    expect(h.cache.uploaded).toEqual(["atlas.png", "edge.png"]);

    const over = harness({ paceBytes: 4 * MB, paceCount: 0, paceTinyBytes: 64 * KB });
    over.build(["atlas.png", "over.png"]);
    over.resolveOne("atlas.png", 1024, 1024);
    over.resolveOne("over.png", 128, 129);
    over.build(["atlas.png", "over.png"]);
    expect(over.cache.uploaded).toEqual(["atlas.png"]);
    expect(over.bridge.stats.paceExempt).toBe(0);
  });

  it("caps the exemption per BUILD — the fifth maximal tiny page waits", () => {
    // 256 KB of allowance is four 64 KB uploads. The fifth is paced like anything else, which is what stops a
    // screen of small art from using this to reinstate the storm the budget exists to break.
    const h = harness({ paceBytes: 4 * MB, paceCount: 0, paceTinyBytes: 64 * KB });
    const urls = ["big.png", "t0.png", "t1.png", "t2.png", "t3.png", "t4.png"];
    h.build(urls);
    h.resolveOne("big.png", 1024, 1024); // spends the ordinary budget outright
    for (let i = 0; i < 5; i++) h.resolveOne(`t${i}.png`, 128, 128); // 64 KB each

    h.build(urls);
    expect(h.cache.uploaded).toEqual(["big.png", "t0.png", "t1.png", "t2.png", "t3.png"]);
    expect(h.bridge.stats.paced).toBe(1);
    expect(h.bridge.stats.paceTinyBytes).toBe(4 * 64 * KB);

    // …and the leftover lands on the NEXT build, where the allowance is fresh.
    h.build(urls);
    expect(h.cache.uploaded).toContain("t4.png");
  });

  it("bypasses the COUNT cap too — a fixed per-upload cost is what that cap prices, and this is under it", () => {
    const h = harness({ paceBytes: 64 * MB, paceCount: 2, paceTinyBytes: 64 * KB });
    const urls = ["a.png", "b.png", "c.png", "d.png"];
    h.build(urls);
    h.resolveAll(64, 64); // 16 KB each

    h.build(urls);
    expect(h.cache.uploaded).toEqual(urls);
  });

  it("off restores the single budget exactly — the A/B arm", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0, paceTinyBytes: 0 });
    const urls = ["atlas.png", "trail.png"];
    h.build(urls);
    h.resolveOne("atlas.png", 1024, 1024);
    h.resolveOne("trail.png", 32, 32);

    h.build(urls);
    expect(h.cache.uploaded).toEqual(["atlas.png"]);
    expect(h.bridge.stats.paced).toBe(1);
    expect(h.bridge.stats.paceExempt).toBe(0);
    expect(h.bridge.stats.paceTinyBytes).toBe(0);
  });

  it("does not exempt what the budget would have admitted anyway", () => {
    // The always-allow-one rule runs FIRST, so a build whose only upload is tiny is not an exemption at all — and
    // a grant that never happened must not be counted as one.
    const h = harness({ paceBytes: 4 * MB, paceCount: 0, paceTinyBytes: 64 * KB });
    h.build(["trail.png"]);
    h.resolveOne("trail.png", 32, 32);
    h.build(["trail.png"]);
    expect(h.cache.uploaded).toEqual(["trail.png"]);
    expect(h.bridge.stats.paceExempt).toBe(0);
    // It is still CHARGED against the allowance, though: the charge site cannot tell which rule admitted it, and
    // over-counting can only ever make the allowance stricter.
    expect(h.bridge.stats.paceTinyBytes).toBe(32 * 32 * 4);
  });

  it("is ON by default — an omitted setting is the 64 KB ceiling, not nothing", () => {
    // Every other case in this section says what to do; this one says what happens when nobody does. The bridge's
    // own default has to be the exemption, because the product url that wants it is the one with no query at all.
    const cache = fakeCache();
    const images = imageFactory();
    const bridge = createTextureBridge({
      cache,
      onResolved: vi.fn(),
      onPaced: vi.fn(),
      createImage: images.create,
      paceBytes: 4 * MB,
      paceCount: 0
      // …and NO `paceTinyBytes`.
    });
    const list = createDrawList<ExecutorTexture | null>();
    const adapted = bridge.adapt(list);
    const quad = createQuadView();
    const run = (): void => {
      list.reset();
      adapted.reset();
      for (const url of ["atlas.png", "trail.png"]) {
        bridge.sizeOf(url);
        adapted.pushQuad(quad, url);
      }
      bridge.endBuild();
    };
    run();
    images.bySrc.get("atlas.png")!.resolve(1024, 1024);
    images.bySrc.get("trail.png")!.resolve(32, 32);
    run();

    expect(cache.uploaded).toEqual(["atlas.png", "trail.png"]);
    expect(bridge.stats.paceExempt).toBe(1);
    expect(TEXTURE_TINY_BYTES_DEFAULT).toBe(64 * KB);
    expect(TEXTURE_TINY_BUILD_BYTES).toBe(256 * KB);
  });

  it("is an admission rule and nothing else — an exempt upload is a real, counted, resident upload", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0, paceTinyBytes: 64 * KB });
    const urls = ["atlas.png", "trail.png"];
    h.build(urls);
    h.resolveOne("atlas.png", 1024, 1024);
    h.resolveOne("trail.png", 32, 32);
    h.build(urls);

    expect(h.bridge.stats.uploads).toBe(2);
    expect(h.bridge.stats.resident).toBe(2);
    expect(h.bridge.stats.bytes).toBe(1024 * 1024 * 4 + 32 * 32 * 4);
    expect(h.onPaced).not.toHaveBeenCalled();
  });
});

// `paceReleases` — THE RELEASE COUNTER THE VERIFY ARM READS (R8 item 6).
//
// Patch verification compares a patched draw list against a rebuilt one and has to exclude any frame where the
// WORLD moved in between rather than the patcher. For textures it did that with `pending * 1e6 + failed`, and
// round 7 measured what that misses: at the default pacer the arm reported 24 / 28 / 4 / 86 / 7 mismatches on
// five deckview runs, every mismatching field a colour (a zero injected budget → zero). A quad whose texture is
// decoded but whose UPLOAD the pacer is holding is pushed fully transparent — it is neither `pending` nor
// `failed` in a way the comparison can see, so when the release happens between the two builds the second list
// paints what the first left transparent and the arm scores the patcher for it.
//
// `stats.paced` cannot close that: it is a GAUGE, sampled at the same point on both sides, so it never differs
// (it was tried and reverted). What the arm needs is a value that only ever GOES UP, so "did a release happen in
// this window" is a comparison of two readings rather than of two levels. Hence a cumulative counter, at the one
// choke point every transition out of `awaitingUpload` already goes through.
describe("paceReleases", () => {
  it("moves only on a release, monotonically, and is never reset by a build", () => {
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    const urls = ["a.png", "b.png", "c.png"];
    h.build(urls);
    // Loads in flight are pending, not paced: nothing has been HELD yet.
    expect(h.bridge.stats.paceReleases).toBe(0);
    h.resolveAll(1024, 1024); // 4 MB each against a 4 MB budget

    h.build(urls); // `a` lands on the always-allow-one rule; `b` and `c` are held
    expect(h.bridge.stats.paced).toBe(2);
    expect(h.bridge.stats.paceReleases).toBe(0);

    const seen: number[] = [];
    h.build(urls); // `b` released
    seen.push(h.bridge.stats.paceReleases);
    h.build(urls); // `c` released
    seen.push(h.bridge.stats.paceReleases);
    h.build(urls); // nothing left to hold — the counter must not drift on a quiet build
    seen.push(h.bridge.stats.paceReleases);

    expect(seen).toEqual([1, 2, 2]);
    expect(h.bridge.stats.paced).toBe(0);
    expect(h.bridge.stats.resident).toBe(3);
  });

  it("THE CONFOUND: a release and a new load net `pending` to the SAME value, and this one still moves", () => {
    // This is the case the old exclusion could not see, and the reason the counter exists. Read the two
    // assertions together: `pending` is identical on both sides of the window, so an epoch built from it would
    // have called the frame comparable — while a quad really did stop being transparent inside it.
    const h = harness({ paceBytes: 4 * MB, paceCount: 0 });
    h.build(["a.png", "b.png"]);
    h.resolveAll(1024, 1024);
    h.build(["a.png", "b.png"]); // `a` uploads, `b` is held
    expect(h.cache.uploaded).toEqual(["a.png"]);

    const pendingBefore = h.bridge.stats.pending; // 1 — the held `b`
    const failedBefore = h.bridge.stats.failed;
    const releasesBefore = h.bridge.stats.paceReleases;
    expect(pendingBefore).toBe(1);

    // `b`'s upload is released INSIDE this build, while `c` starts loading in the same build.
    h.build(["a.png", "b.png", "c.png"]);
    expect(h.cache.uploaded).toEqual(["a.png", "b.png"]);

    expect(h.bridge.stats.pending).toBe(pendingBefore); // held-`b` out, loading-`c` in: unchanged
    expect(h.bridge.stats.failed).toBe(failedBefore); // …and the other half of the old epoch is still 0
    expect(h.bridge.stats.paceReleases).toBe(releasesBefore + 1);
  });

  it("counts the ABANDONMENT paths too — over-counting, in the only direction that is safe", () => {
    // The counter is read ONLY to exclude a verify frame, never to admit one, so counting a transition that put
    // no pixels on screen costs at most one verified frame and can never manufacture a pass. Counting at the one
    // `clearAwaiting` choke point is the other half of the argument: no future caller can bypass it.

    // (1) `endBuild` drops a held url the scene stopped naming.
    const dropped = harness({ paceBytes: 4 * MB, paceCount: 0 });
    dropped.build(["a.png", "b.png"]);
    dropped.resolveAll(1024, 1024);
    dropped.build(["a.png", "b.png"]);
    expect(dropped.bridge.stats.paced).toBe(1);
    expect(dropped.bridge.stats.paceReleases).toBe(0);
    dropped.build(["a.png"]); // `b` left the screen before its turn came
    expect(dropped.bridge.stats.paced).toBe(0);
    expect(dropped.bridge.stats.paceReleases).toBe(1);

    // (2) `markFailed` — a held page whose source the driver then refuses.
    const failed = harness({ paceBytes: 4 * MB, paceCount: 0, throwFor: ["bad.png"] });
    failed.build(["a.png", "bad.png"]);
    failed.resolveAll(1024, 1024);
    failed.build(["a.png", "bad.png"]); // `a` uploads, `bad` is held
    expect(failed.bridge.stats.paced).toBe(1);
    expect(failed.bridge.stats.paceReleases).toBe(0);
    failed.build(["a.png", "bad.png"]); // `bad`'s turn comes and `acquire` throws
    expect(failed.bridge.stats.failed).toBe(1);
    expect(failed.bridge.stats.paced).toBe(0);
    expect(failed.bridge.stats.paceReleases).toBe(1);

    // (3) `invalidate` — a context loss drops every claim at once, and does NOT reset the counter.
    const lost = harness({ paceBytes: 4 * MB, paceCount: 0 });
    lost.build(["a.png", "b.png"]);
    lost.resolveAll(1024, 1024);
    lost.build(["a.png", "b.png"]);
    expect(lost.bridge.stats.paceReleases).toBe(0);
    lost.cache.reset(); // gsw's context-lost hook
    lost.bridge.invalidate();
    expect(lost.bridge.stats.paceReleases).toBe(1);
    lost.build(["a.png", "b.png"]); // re-uploads `a`, re-holds `b`: no release, and no reset either
    expect(lost.bridge.stats.paceReleases).toBe(1);
  });

});
