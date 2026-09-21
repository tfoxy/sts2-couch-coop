import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  createDrawList,
  createQuadView,
  type CanvasTextureCache,
  type ExecutorTexture
} from "@godot-scene-web/canvas";

import { fxAxisScale } from "@/mirror/canvas/fxPixelRatio";
import { createTextureBridge } from "@/mirror/canvas/textureBridge";
import {
  FX_RESIDENT_BYTES_DEFAULT,
  FX_FPS_DEFAULT,
  FX_KEY_PREFIX,
  FX_PACE_BYTES_DEFAULT,
  FX_PACE_COUNT_DEFAULT,
  FX_UNDER_RESOLVED_SLACK,
  createFxSurfaces,
  fxKeyForNode,
  fxNodeIdFromKey,
  resolveFxBox,
  type FxRenderInfo,
  type FxSurfaceRegistry
} from "@/mirror/canvas/fxSurfaces";

// EFFECT SURFACES. The registry that turns a gsw-owned <canvas> into a stage texture, so a shader or particle
// surface can be a QUAD at its own paint index instead of a DOM layer above the whole stage.
//
// Three of these describes are PARK GUARDS. The stage is >90% idle and stays that way because `armAnimation`
// stops when every demand source answers Infinity; this registry is a third demand source, so its failure mode is
// not a wrong pixel but a phone that never sleeps. Each guard is specced on its own below.
//
// The cache here counts what it was asked to upload instead of uploading anything (there is no GL in a unit test),
// which is the whole of what the governor is deciding.

interface FakeCache extends CanvasTextureCache {
  /** Keys passed to `update`, IN ORDER — the upload log the rotation is asserted against. */
  uploaded: string[];
  /** Keys passed to `release`. */
  released: string[];
  /** Make `update` throw once, the way a tainted source does. */
  failNext(key: string): void;
}

function fakeCache(): FakeCache {
  const entries = new Map<string, ExecutorTexture>();
  const uploaded: string[] = [];
  const released: string[] = [];
  const failing = new Set<string>();
  const stats = { entries: 0, uploads: 0, evictions: 0, bytes: 0, respecs: 0 };
  return {
    uploaded,
    released,
    failNext: (key) => failing.add(key),
    stats,
    white: () => ({ texture: {} as WebGLTexture, width: 1, height: 1, revision: 1 }),
    peek: (key) => entries.get(key),
    acquire: () => {
      throw new Error("fx surfaces never `acquire` — pixels change, so they `update`");
    },
    acquireBytes: () => {
      throw new Error("unused");
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
    update: (key, source) => {
      if (failing.has(key)) {
        failing.delete(key);
        // gsw's cache makes the entry BEFORE it uploads, so a throwing upload leaves one behind.
        entries.set(key, { texture: {} as WebGLTexture, width: 1, height: 1, revision: 1 });
        throw new Error("tainted source");
      }
      const src = source as { width?: number; height?: number };
      const handle = { texture: {} as WebGLTexture, width: src.width ?? 1, height: src.height ?? 1, revision: 1 };
      const existing = entries.get(key);
      if (existing) {
        stats.bytes += handle.width * handle.height * 4 - existing.width * existing.height * 4;
      } else {
        stats.entries++;
        stats.bytes += handle.width * handle.height * 4;
      }
      entries.set(key, handle);
      stats.uploads++;
      uploaded.push(key);
      return handle;
    },
    reset: () => {
      entries.clear();
      stats.entries = 0;
      stats.bytes = 0;
    },
    dispose: () => entries.clear()
  };
}

const MB = 1024 * 1024;

/** A gsw-shaped surface canvas: a CSS box the runtime placed, and a backing store the upload is priced from. */
function fxCanvas(
  opts: { w: number; h: number; left?: string; top?: string; width?: string; height?: string } = { w: 512, h: 512 }
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = opts.w;
  canvas.height = opts.h;
  canvas.style.left = opts.left ?? "0";
  canvas.style.top = opts.top ?? "0";
  canvas.style.width = opts.width ?? "100%";
  canvas.style.height = opts.height ?? "100%";
  return canvas;
}

/** The backing-store side that makes one upload cost `mb` megabytes of RGBA. */
function sideFor(mb: number): number {
  return Math.round(Math.sqrt((mb * MB) / 4));
}

interface Harness {
  fx: FxSurfaceRegistry;
  cache: FakeCache;
  onDirty: ReturnType<typeof vi.fn>;
  /** One build that names `ids` in order (paint order), then closes it. */
  build(ids: readonly string[]): void;
  /** A gsw frame for `id` — creates the canvas on first use. `info` carries the frame key when one is being told. */
  render(id: string, canvas?: HTMLCanvasElement, info?: FxRenderInfo): HTMLCanvasElement;
  canvases: Map<string, HTMLCanvasElement>;
}

function harness(
  opts: {
    paceBytes?: number;
    paceCount?: number;
    maxTextureDim?: number;
    evictAfterBuilds?: number;
    side?: number;
    fps?: number;
    residentBytes?: number;
  } = {}
): Harness {
  const cache = fakeCache();
  const onDirty = vi.fn();
  const fx = createFxSurfaces({
    cache,
    onDirty,
    paceBytes: opts.paceBytes,
    paceCount: opts.paceCount,
    maxTextureDim: opts.maxTextureDim,
    evictAfterBuilds: opts.evictAfterBuilds,
    fps: opts.fps,
    residentBytes: opts.residentBytes
  });
  const canvases = new Map<string, HTMLCanvasElement>();
  const side = opts.side ?? 512;
  return {
    fx,
    cache,
    onDirty,
    canvases,
    build(ids) {
      for (const id of ids) fx.acquire(id, 100, 100);
      fx.endBuild();
    },
    render(id, canvas, info) {
      let el = canvas ?? canvases.get(id);
      if (!el) {
        el = fxCanvas({ w: side, h: side });
        canvases.set(id, el);
      }
      fx.noteRendered(id, el, info);
      return el;
    }
  };
}

describe("the fx:// key space", () => {
  it("namespaces a node id so it cannot collide with a page url in the shared cache", () => {
    expect(fxKeyForNode("42")).toBe("fx://42");
    expect(FX_KEY_PREFIX).toBe("fx://");
    expect(fxNodeIdFromKey("fx://42")).toBe("42");
    // A page url is emphatically NOT one of ours.
    expect(fxNodeIdFromKey("/res/ui_atlas_0.png")).toBeNull();
    expect(fxNodeIdFromKey("blob:http://host/abc")).toBeNull();
  });

  it("uploads under the prefixed key and answers a handle for the bare node id", () => {
    const h = harness();
    h.build(["7"]);
    h.render("7");
    h.build(["7"]);

    expect(h.cache.uploaded).toEqual(["fx://7"]);
    expect(h.fx.handleFor("7")).not.toBeNull();
    expect(h.fx.handleFor("nobody")).toBeNull();
    expect(h.fx.sizeOf("7")).toEqual({ width: 512, height: 512 });
  });
});

describe("park guard 1 — endBuild clears the dirty bit of surfaces the build did not name", () => {
  it("stops a surface nothing draws from holding the stage awake forever", () => {
    const h = harness();
    h.build(["a", "b"]);
    h.render("a");
    h.render("b");
    h.build(["a", "b"]);
    expect(h.fx.stats().dirty).toBe(0);

    // `b` scrolls off the stage. gsw keeps rendering it (its loop gates on dormancy attributes, not visibility),
    // so it keeps going dirty — but no build names it.
    h.render("b");
    h.build(["a"]);

    expect(h.fx.stats().dirty).toBe(0);
    expect(h.fx.nextDeadline(1000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("re-arms the surface the moment a build names it again", () => {
    const h = harness();
    h.build(["a"]);
    h.render("a");
    h.build(["a"]); // uploaded

    h.render("a"); // new pixels
    h.build(["other"]); // and `a` is not drawn this build — guard 1 drops the bit
    expect(h.fx.stats().dirty).toBe(0);

    // Naming it again is what brings the demand back: the epoch check inside `acquire` sees pixels newer than
    // the texture and re-arms, so the upload lands on the following build.
    h.fx.acquire("a", 100, 100);
    expect(h.fx.stats().dirty).toBe(1);
    h.fx.endBuild();
    h.build(["a"]);
    expect(h.cache.uploaded).toEqual(["fx://a", "fx://a"]);
  });

  it("keeps the dirty bit of a surface the build DID name (deferral must survive endBuild)", () => {
    const h = harness({ paceBytes: 1, side: sideFor(4) });
    h.build(["a", "b"]);
    h.render("a");
    h.render("b");
    h.build(["a", "b"]); // always-allow-one uploads exactly one; the other stays owed

    expect(h.cache.uploaded).toHaveLength(1);
    expect(h.fx.stats().dirty).toBe(1);
    expect(h.fx.nextDeadline(1000)).toBe(1000);
  });
});

describe("park guard 2 — noteRendered only wakes the stage for ids the last build named", () => {
  it("does not fire onDirty for a node no build has ever drawn", () => {
    const h = harness();
    h.render("ghost");
    expect(h.onDirty).not.toHaveBeenCalled();
    expect(h.fx.stats().dirty).toBe(0);
    expect(h.fx.nextDeadline(500)).toBe(Number.POSITIVE_INFINITY);
  });

  it("fires onDirty for a node the last build named", () => {
    const h = harness();
    h.build(["a"]);
    h.render("a");
    expect(h.onDirty).toHaveBeenCalledTimes(1);
    expect(h.fx.nextDeadline(500)).toBe(500);
  });

  it("stops firing the first build after the scene stops naming the node", () => {
    const h = harness();
    h.build(["a"]);
    h.render("a");
    h.build(["a"]);
    h.onDirty.mockClear();

    // `a` left the scene. The LAST build is the one that just closed, and it did not name it.
    h.build(["b"]);
    h.render("a");
    expect(h.onDirty).not.toHaveBeenCalled();
    expect(h.fx.nextDeadline(1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("records the pixels even when it does not schedule, so a later build sees them", () => {
    const h = harness();
    h.render("late"); // no build has named it: recorded, not scheduled
    expect(h.onDirty).not.toHaveBeenCalled();

    h.build(["late"]); // names it; the epoch check re-arms
    h.build(["late"]); // and the plan for THIS build uploads it
    expect(h.cache.uploaded).toEqual(["fx://late"]);
  });
});

describe("park guard 3 — the budget pump terminates", () => {
  it("drains a whole screen of dirty surfaces and then parks", () => {
    const h = harness({ paceBytes: 4 * MB, side: sideFor(4) });
    const ids = ["a", "b", "c", "d", "e"];
    h.build(ids);
    for (const id of ids) h.render(id);

    // Each build takes one surface (4 MB budget, 4 MB apiece). Five builds, and then Infinity.
    for (let i = 0; i < ids.length; i++) {
      expect(h.fx.nextDeadline(1)).toBe(1);
      h.build(ids);
    }
    expect(h.fx.stats().dirty).toBe(0);
    expect(h.fx.nextDeadline(1)).toBe(Number.POSITIVE_INFINITY);
    expect(h.cache.uploaded).toHaveLength(5);
  });

  it("clears the bit for a canvas with no backing store rather than retrying it forever", () => {
    const h = harness();
    const empty = fxCanvas({ w: 0, h: 0 });
    h.build(["a"]);
    h.render("a", empty);
    h.build(["a"]);

    expect(h.cache.uploaded).toEqual([]);
    expect(h.fx.stats().dirty).toBe(0);
    expect(h.fx.nextDeadline(1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("clears the bit for a refused surface rather than spending the budget on it every build", () => {
    const h = harness({ maxTextureDim: 4096 });
    h.build(["big"]);
    h.render("big", fxCanvas({ w: 8192, h: 512 }));
    h.build(["big"]);

    expect(h.fx.stats().oversized).toBe(1);
    expect(h.fx.stats().dirty).toBe(0);
    h.build(["big"]);
    expect(h.fx.stats().oversized).toBe(1);
    expect(h.fx.nextDeadline(1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the per-build upload budget", () => {
  it("stops uploading once the build has spent its bytes, and finishes on later builds", () => {
    const h = harness({ paceBytes: 4 * MB, side: sideFor(4) });
    const ids = ["a", "b", "c"];
    h.build(ids);
    for (const id of ids) h.render(id);

    h.build(ids);
    expect(h.cache.uploaded).toEqual(["fx://a"]);
    expect(h.fx.stats().deferred).toBe(2);

    h.build(ids);
    h.build(ids);
    expect(h.cache.uploaded).toEqual(["fx://a", "fx://b", "fx://c"]);
    expect(h.fx.stats().dirty).toBe(0);
    expect(h.fx.stats().resident).toBe(3);
  });

  it("packs several small surfaces into one build when they fit", () => {
    const h = harness({ paceBytes: 4 * MB, side: sideFor(1) });
    const ids = ["a", "b", "c", "d"];
    h.build(ids);
    for (const id of ids) h.render(id);

    h.build(ids);
    expect(h.cache.uploaded).toEqual(["fx://a", "fx://b", "fx://c", "fx://d"]);
    expect(h.fx.stats().deferred).toBe(0);
  });

  it("uploads a surface LARGER than the whole budget rather than deadlocking on it", () => {
    // ALWAYS-ALLOW-ONE. The 2765x1296 water reflection is one indivisible `texImage2D`; refusing it would leave
    // that effect blank forever.
    const h = harness({ paceBytes: 1 });
    h.build(["water"]);
    h.render("water", fxCanvas({ w: 2765, h: 1296 }));
    h.build(["water"]);
    expect(h.cache.uploaded).toEqual(["fx://water"]);
  });

  it("never puts two big surfaces in the same build", () => {
    const h = harness({ paceBytes: 4 * MB, side: sideFor(14) });
    h.build(["a", "b"]);
    h.render("a");
    h.render("b");
    h.build(["a", "b"]);
    expect(h.cache.uploaded).toEqual(["fx://a"]);
  });

  it("counts the uploads, and times their SUBMIT (not the GPU's copy)", () => {
    // `uploadMs`/`maxUploadMs`/`maxBuildUploadMs` measure main-thread time inside `update` and nothing else:
    // `texImage2D(canvas)` records a pending copy and returns, so the real bill (see the module header's cost
    // model) is ~30x what this timer can see. They are a submit-stall detector, not the governor's yardstick.
    const h = harness({ paceBytes: 0, paceCount: 0 });
    const ids = ["a", "b", "c"];
    h.build(ids);
    for (const id of ids) h.render(id);
    h.build(ids);

    const stats = h.fx.stats();
    expect(stats.uploads).toBe(3);
    expect(stats.uploadMs).toBeGreaterThanOrEqual(0);
    expect(stats.maxUploadMs).toBeLessThanOrEqual(stats.uploadMs);
    expect(stats.maxBuildUploadMs).toBeLessThanOrEqual(stats.uploadMs);
  });
});

describe("LRU-first rotation", () => {
  it("shares the budget out instead of spending it on the earliest-painted surfaces forever", () => {
    // The reason this is not paint-order like the bridge's: an fx surface is dirty AGAIN next frame, so the
    // 19 combat fires (which paint before the hand) would take the whole budget every build and a card glow
    // behind them would never refresh at all.
    const h = harness({ paceBytes: 4 * MB, side: sideFor(4) });
    const painted = ["fire", "glow"];
    h.build(painted);
    h.render("fire");
    h.render("glow");

    h.build(painted); // never-uploaded, tie on seq 0 → id order
    expect(h.cache.uploaded).toEqual(["fx://fire"]);

    // Both are dirty again every frame; the one that has waited longest goes next, in turn.
    for (let i = 0; i < 4; i++) {
      h.render("fire");
      h.render("glow");
      h.build(painted);
    }
    expect(h.cache.uploaded).toEqual([
      "fx://fire",
      "fx://glow",
      "fx://fire",
      "fx://glow",
      "fx://fire"
    ]);
  });

  it("ignores the order the BUILD names them in — the rotation clock decides", () => {
    const h = harness({ paceBytes: 4 * MB, side: sideFor(4) });
    h.build(["a", "b"]);
    h.render("a");
    h.render("b");
    h.build(["a", "b"]); // uploads `a`

    h.render("a");
    // `a` paints FIRST, but `b` has been waiting since before `a`'s upload, so `b` is what the budget buys.
    h.build(["a", "b"]);
    expect(h.cache.uploaded).toEqual(["fx://a", "fx://b"]);
  });

  it("gives a never-uploaded surface priority over one that has pixels already", () => {
    const h = harness({ paceBytes: 4 * MB, side: sideFor(4) });
    h.build(["old"]);
    h.render("old");
    h.build(["old"]); // `old` is resident

    // A new effect appears LATER in paint order; the build that discovers it has no pixels for it yet.
    h.build(["old", "new"]);
    // Now BOTH are dirty in the same build, and only one fits. Seq 0 sorts first: the new one gets its first
    // pixels before the old one gets its next frame.
    h.render("old");
    h.render("new");
    h.build(["old", "new"]);
    expect(h.cache.uploaded).toEqual(["fx://old", "fx://new"]);
  });
});

describe("what paints while an upload is deferred", () => {
  it("keeps the LAST uploaded pixels — never a transparent hole", () => {
    const h = harness({ paceBytes: 4 * MB, side: sideFor(4) });
    h.build(["a", "b"]);
    h.render("a");
    h.render("b");
    h.build(["a", "b"]); // `a` uploads
    const first = h.fx.handleFor("a");
    expect(first).not.toBeNull();

    // New pixels for `a`, but `b` is older and takes the budget. `a` still has a handle and a box to draw with.
    h.render("a");
    const surface = h.fx.acquire("a", 100, 100);
    expect(surface).not.toBeNull();
    expect(surface?.stale).toBe(true);
    expect(h.fx.handleFor("a")).toBe(first);
    h.fx.endBuild();
  });

  it("says stale=false once the pixels on the GPU are the ones gsw drew", () => {
    const h = harness({ paceBytes: 0 });
    h.build(["a"]);
    h.render("a");
    const surface = h.fx.acquire("a", 100, 100);
    expect(surface?.stale).toBe(false);
    h.fx.endBuild();
  });

  it("answers null while a surface has NEVER uploaded, so the build emits no quad at all", () => {
    const h = harness();
    // Named, but no runtime frame has arrived yet.
    expect(h.fx.acquire("a", 100, 100)).toBeNull();
    h.fx.endBuild();
    expect(h.fx.handleFor("a")).toBeNull();
  });

  it("counts a deferral in stats.deferred, once per acquire that painted old pixels", () => {
    const h = harness({ paceBytes: 4 * MB, side: sideFor(4) });
    const ids = ["a", "b", "c"];
    h.build(ids);
    for (const id of ids) h.render(id);

    h.build(ids);
    expect(h.fx.stats().deferred).toBe(2);
    h.build(ids);
    expect(h.fx.stats().deferred).toBe(3);
  });
});

describe("byte accounting", () => {
  it("counts the BACKING STORE, not the CSS box — that is what texImage2D moves", () => {
    const h = harness({ paceBytes: 0 });
    // A quarter-scale tier: a 2048x768 effect backed by a 512x192 store, drawn over the same CSS box.
    h.build(["a"]);
    h.render("a", fxCanvas({ w: 512, h: 192, width: "2048px", height: "768px" }));
    h.build(["a"]);

    expect(h.fx.stats().bytes).toBe(512 * 192 * 4);
    const surface = h.fx.acquire("a", 100, 100);
    expect(surface?.cssW).toBe(2048);
    expect(surface?.cssH).toBe(768);
    h.fx.endBuild();
  });

  it("re-prices a surface whose backing store changed rather than double-counting it", () => {
    const h = harness({ paceBytes: 0 });
    const canvas = fxCanvas({ w: 256, h: 256 });
    h.build(["a"]);
    h.render("a", canvas);
    h.build(["a"]);
    expect(h.fx.stats().bytes).toBe(256 * 256 * 4);

    canvas.width = 512;
    canvas.height = 512;
    h.render("a", canvas);
    h.build(["a"]);
    expect(h.fx.stats().resident).toBe(1);
    expect(h.fx.stats().bytes).toBe(512 * 512 * 4);
  });

  it("reports THIS registry's bytes, not the shared cache's total", () => {
    // The bridge's page textures live in the same cache; `fx.bytes` is the fx share alone, which is what makes
    // the census line legible.
    const h = harness({ paceBytes: 0 });
    h.build(["a"]);
    h.render("a", fxCanvas({ w: 64, h: 64 }));
    h.build(["a"]);
    h.cache.update("/res/atlas.png", fxCanvas({ w: 1024, h: 1024 }));

    expect(h.fx.stats().bytes).toBe(64 * 64 * 4);
    expect(h.cache.stats.bytes).toBeGreaterThan(h.fx.stats().bytes);
  });
});

describe("effect-surface pacing", () => {
  it("uploads everything in one build when the budget is off", () => {
    const h = harness({ paceBytes: 0, paceCount: 0, side: sideFor(14) });
    const ids = ["a", "b", "c", "d"];
    h.build(ids);
    for (const id of ids) h.render(id);

    h.build(ids);
    expect(h.cache.uploaded).toEqual(["fx://a", "fx://b", "fx://c", "fx://d"]);
    expect(h.fx.stats().paceBytes).toBe(0);
    expect(h.fx.stats().paceCount).toBe(0);
  });

  it("defaults to the two measured constants, and reports both", () => {
    // 32 MB / 8 uploads. The count cap is the one that usually binds: on a real GPU an upload costs ~0.164 ms of
    // FIXED call overhead plus ~0.0245 ms per Mpx, so a byte budget alone cannot bound a build of small surfaces.
    const h = harness();
    expect(FX_PACE_BYTES_DEFAULT).toBe(32 * MB);
    expect(FX_PACE_COUNT_DEFAULT).toBe(8);
    expect(h.fx.stats().paceBytes).toBe(FX_PACE_BYTES_DEFAULT);
    expect(h.fx.stats().paceCount).toBe(FX_PACE_COUNT_DEFAULT);
  });
});

describe("the per-build upload COUNT cap", () => {
  // WHY THERE IS A SECOND CAP AT ALL. The fixed per-upload term dominates every surface a mirror screen carries
  // (a 2048x768 fire is 1.6 Mpx = 0.04 ms of pixels against 0.164 ms of call overhead), so thirty small surfaces
  // are ~5 ms of real cost and a rounding error against any megabyte figure. Bytes cannot see that build.

  it("admits exactly the cap and defers the rest, with nine dirty surfaces and a cap of eight", () => {
    const h = harness({ paceBytes: 0, paceCount: 8, side: 64 });
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    h.build(ids);
    for (const id of ids) h.render(id);

    h.build(ids);
    expect(h.cache.uploaded).toHaveLength(8);
    expect(h.fx.stats().deferred).toBe(1);
    // …and the ninth lands on the next build, so the pump still drains (park guard 3).
    h.build(ids);
    expect(h.cache.uploaded).toHaveLength(9);
    expect(h.fx.stats().dirty).toBe(0);
    expect(h.fx.nextDeadline(1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("counts uploads, not bytes — a cap of one admits one tiny surface", () => {
    const h = harness({ paceBytes: 0, paceCount: 1, side: 8 });
    const ids = ["a", "b", "c"];
    h.build(ids);
    for (const id of ids) h.render(id);

    h.build(ids);
    expect(h.cache.uploaded).toEqual(["fx://a"]);
  });

  it("keeps always-allow-one above BOTH caps", () => {
    // A cap of one with a byte budget smaller than a single surface must still make progress rather than deadlock.
    const h = harness({ paceBytes: 1, paceCount: 1 });
    h.build(["water"]);
    h.render("water", fxCanvas({ w: 2765, h: 1296 }));
    h.build(["water"]);
    expect(h.cache.uploaded).toEqual(["fx://water"]);
  });

  it("lets whichever cap binds first end the plan", () => {
    // Four 14 MB surfaces under a 32 MB budget and a cap of 8: BYTES stop the plan at two.
    const bytesBound = harness({ paceBytes: 32 * MB, paceCount: 8, side: sideFor(14) });
    const ids = ["a", "b", "c", "d"];
    bytesBound.build(ids);
    for (const id of ids) bytesBound.render(id);
    bytesBound.build(ids);
    expect(bytesBound.cache.uploaded).toHaveLength(2);

    // The same four at 1 MB apiece under the same caps: neither binds, so all four land in one build.
    const neither = harness({ paceBytes: 32 * MB, paceCount: 8, side: sideFor(1) });
    neither.build(ids);
    for (const id of ids) neither.render(id);
    neither.build(ids);
    expect(neither.cache.uploaded).toHaveLength(4);
  });
});

describe("refusals", () => {
  it("refuses a backing store longer than MAX_TEXTURE_SIZE instead of uploading it incomplete", () => {
    // An over-limit `texImage2D` raises INVALID_VALUE rather than throwing, and the incomplete texture samples
    // as opaque BLACK — a black rectangle over the game.
    const h = harness({ maxTextureDim: 4096 });
    h.build(["big"]);
    h.render("big", fxCanvas({ w: 8192, h: 512 }));
    h.build(["big"]);

    expect(h.cache.uploaded).toEqual([]);
    expect(h.fx.stats().oversized).toBe(1);
    expect(h.fx.stats().declined).toBe(1);
    expect(h.fx.acquire("big", 100, 100)).toBeNull();
    h.fx.endBuild();
  });

  it("uploads a surface that fits the limit", () => {
    const h = harness({ maxTextureDim: 8192 });
    h.build(["ok"]);
    h.render("ok", fxCanvas({ w: 2765, h: 1296 }));
    h.build(["ok"]);
    expect(h.cache.uploaded).toEqual(["fx://ok"]);
  });

  it("refuses a SCREEN_TEXTURE shader and counts it in declined, not in withheld", () => {
    // gsw's screen capture is a throttled DOM-composite approximation, and on this stage the DOM composite holds
    // only text and effects — not the game, which is in the canvas. Painting that would be confidently wrong.
    const h = harness();
    h.build(["water"]);
    h.fx.noteRendered("water", fxCanvas({ w: 512, h: 512 }), { usesScreenTexture: true });

    expect(h.onDirty).not.toHaveBeenCalled();
    expect(h.fx.stats().declined).toBe(1);
    h.build(["water"]);
    expect(h.cache.uploaded).toEqual([]);
    expect(h.fx.acquire("water", 100, 100)).toBeNull();
    h.fx.endBuild();
  });

  it("gives back the cache entry a throwing upload left behind, and never retries", () => {
    const h = harness();
    h.build(["a"]);
    h.render("a");
    h.cache.failNext("fx://a");
    h.build(["a"]);

    expect(h.fx.stats().declined).toBe(1);
    expect(h.cache.released).toEqual(["fx://a"]);
    expect(h.fx.stats().resident).toBe(0);
    h.render("a");
    h.build(["a"]);
    expect(h.cache.uploaded).toEqual([]);
  });
});

// ONE TEXTURE PER FROZEN FRAME. In a frozen effect mode — the product default — gsw draws one frame and blits it
// into every identical binding's canvas, and it NAMES that frame (`FxRenderInfo.staticKey`). Seven cards in a
// hand are seven canvases holding one picture; uploading each of them is seven copies of the same megabytes.
//
// The safety argument is gsw's own: the key IS the frame's identity — the same string its static-frame cache
// stores the bitmap under — so sharing the texture is exactly as correct as the blit that already happened.
describe("one texture per frozen frame key", () => {
  /** Name `ids` in one build and hand back what each surface would draw. */
  function drawn(h: Harness, ids: readonly string[]): Array<ReturnType<FxSurfaceRegistry["acquire"]>> {
    const views = ids.map((id) => {
      const view = h.fx.acquire(id, 100, 100);
      // The registry updates ONE record per surface in place, so a caller that keeps it must copy.
      return view === null ? null : { ...view };
    });
    h.fx.endBuild();
    return views;
  }

  it("uploads ONCE for twins and points both quads at the same texture", () => {
    const h = harness();
    h.build(["a", "b"]);
    h.render("a", undefined, { staticKey: "glow|100x50" });
    h.render("b", undefined, { staticKey: "glow|100x50" });
    const views = drawn(h, ["a", "b"]);

    // One `texImage2D`, under the FRAME's key rather than either node's.
    expect(h.cache.uploaded).toEqual(["fx://k1"]);
    expect(views.map((v) => v?.key)).toEqual(["fx://k1", "fx://k1"]);
    // …and both quads draw: the second surface has pixels without having uploaded any.
    expect(views[1]?.stale).toBe(false);
    expect(views[1]?.pageW).toBe(512);
    expect(h.fx.stats().uploads).toBe(1);
    expect(h.fx.stats().sharedAttaches).toBe(1);
    expect(h.fx.stats().sharedEntries).toBe(1);
    // The bytes are ONE surface's, which is the whole point.
    expect(h.fx.stats().resident).toBe(1);
    expect(h.fx.stats().bytes).toBe(512 * 512 * 4);
  });

  it("keeps a private per-node texture when the runtime names no frame", () => {
    // The un-shared path, byte for byte as it was before sharing existed: a live effect, a screen-space shader, a
    // decoding texture — gsw reports no key for any of them, and two of them are not interchangeable.
    const h = harness();
    h.build(["a", "b"]);
    h.render("a");
    h.render("b", undefined, { staticKey: null });
    const views = drawn(h, ["a", "b"]);

    expect(h.cache.uploaded).toEqual(["fx://a", "fx://b"]);
    expect(views.map((v) => v?.key)).toEqual(["fx://a", "fx://b"]);
    expect(h.fx.stats().sharedEntries).toBe(0);
    expect(h.fx.stats().sharedAttaches).toBe(0);
  });

  it("charges the budget per TEXTURE, so a fleet of twins is not deferred behind itself", () => {
    // A cap of one upload per build used to mean one SURFACE per build: a seven-card hand would take seven builds
    // to light up. Six of those seven cost no upload at all, so the cap has nothing to bound.
    const h = harness({ paceCount: 1 });
    h.build(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) h.render(id, undefined, { staticKey: "glow" });
    const views = drawn(h, ["a", "b", "c"]);

    expect(h.cache.uploaded).toEqual(["fx://k1"]);
    expect(views.every((v) => v !== null)).toBe(true);
    expect(h.fx.stats().deferred).toBe(0);
    expect(h.fx.stats().dirty).toBe(0);
  });

  it("costs nothing when a surface re-blits the frame it already has", () => {
    // gsw re-blits a frozen fleet whenever its loop is kicked (a reconcile, a resize). Each blit is a real paint
    // and is reported as one — but the texture already holds that frame, so there is nothing to move.
    const h = harness();
    h.build(["a"]);
    h.render("a", undefined, { staticKey: "glow" });
    h.build(["a"]);
    expect(h.cache.uploaded).toEqual(["fx://k1"]);

    h.render("a", undefined, { staticKey: "glow" });
    h.build(["a"]);
    expect(h.cache.uploaded).toEqual(["fx://k1"]);
    expect(h.fx.stats().uploads).toBe(1);
    expect(h.fx.stats().sharedAttaches).toBe(1);
  });

  it("moves a surface whose frame key churns, and frees the old texture with its last holder", () => {
    // `card_ripple` re-keys on its `width` uniform, so this is the common case rather than an edge one.
    const h = harness();
    h.build(["a", "b"]);
    h.render("a", undefined, { staticKey: "glow|w=0.2" });
    h.render("b", undefined, { staticKey: "glow|w=0.2" });
    h.build(["a", "b"]);
    expect(h.cache.uploaded).toEqual(["fx://k1"]);

    // `a` alone moves on. `b` is still showing the old frame, so its texture must stay.
    h.render("a", undefined, { staticKey: "glow|w=0.6" });
    h.build(["a", "b"]);
    expect(h.cache.uploaded).toEqual(["fx://k1", "fx://k2"]);
    expect(h.cache.released).toEqual([]);
    expect(h.fx.stats().resident).toBe(2);

    // …and when `b` follows, the frame nobody is showing any more goes back.
    h.render("b", undefined, { staticKey: "glow|w=0.6" });
    h.build(["a", "b"]);
    expect(h.cache.released).toEqual(["fx://k1"]);
    expect(h.cache.uploaded).toEqual(["fx://k1", "fx://k2"]);
    expect(h.fx.stats().resident).toBe(1);
  });

  it("keeps the shared texture while ANY holder is still on screen, and frees it with the last release", () => {
    const h = harness();
    h.build(["a", "b"]);
    h.render("a", undefined, { staticKey: "glow" });
    h.render("b", undefined, { staticKey: "glow" });
    h.build(["a", "b"]);

    h.fx.release("a");
    expect(h.cache.released).toEqual([]);
    expect(h.fx.acquire("b", 100, 100)).not.toBeNull();
    h.fx.endBuild();

    h.fx.release("b");
    expect(h.cache.released).toEqual(["fx://k1"]);
    expect(h.fx.stats().resident).toBe(0);
    expect(h.fx.stats().bytes).toBe(0);
  });

  it("re-uploads for real when a holder is invalidated — a re-key is not a reason to trust old pixels", () => {
    // `invalidate(id)` means "gsw rebuilt this binding, its pixels are not what you think". Recognising the frame
    // key and skipping the upload would leave exactly the pixels the caller just disowned.
    const h = harness();
    h.build(["a", "b"]);
    h.render("a", undefined, { staticKey: "glow" });
    h.render("b", undefined, { staticKey: "glow" });
    h.build(["a", "b"]);
    expect(h.cache.uploaded).toEqual(["fx://k1"]);

    h.fx.invalidate("a");
    h.build(["a", "b"]);
    expect(h.cache.uploaded).toEqual(["fx://k1", "fx://k1"]);
  });

  it("re-arms EVERY holder when the shared texture is evicted", () => {
    // A per-node registry got this for free. Holders each carry their own generation, so an eviction that left
    // one of them believing it still had pixels would draw a quad from a texture that is not there.
    const h = harness({ evictAfterBuilds: 2 });
    h.build(["a", "b"]);
    h.render("a", undefined, { staticKey: "glow" });
    h.render("b", undefined, { staticKey: "glow" });
    h.build(["a", "b"]);
    expect(h.fx.stats().resident).toBe(1);

    // Nothing names them for a while: the texture ages out.
    h.build(["other"]);
    h.build(["other"]);
    h.build(["other"]);
    expect(h.fx.stats().resident).toBe(0);
    expect(h.cache.released).toEqual(["fx://k1"]);

    // Both come back, and both draw again off ONE re-upload.
    const views = drawn(h, ["a", "b"]);
    expect(views.every((v) => v === null)).toBe(true); // the re-upload lands on the build after the re-arm
    const back = drawn(h, ["a", "b"]);
    expect(h.cache.uploaded).toEqual(["fx://k1", "fx://k1"]);
    expect(back.every((v) => v !== null)).toBe(true);
    expect(h.fx.stats().resident).toBe(1);
  });

  it("answers handleFor / sizeOf by the KEY the quad carries, node id or frame token alike", () => {
    const h = harness();
    h.build(["a", "plain"]);
    h.render("a", undefined, { staticKey: "glow" });
    h.render("plain");
    h.build(["a", "plain"]);

    // The bridge slices `fx://` off a draw-list key and hands back the rest, whichever shape it is.
    expect(h.fx.sizeOf("k1")).toEqual({ width: 512, height: 512 });
    expect(h.fx.handleFor("k1")).not.toBeNull();
    expect(h.fx.sizeOf("plain")).toEqual({ width: 512, height: 512 });
    // A node id that is only ever a HOLDER of a shared frame is not a texture key at all.
    expect(h.fx.handleFor("a")).toBeNull();
  });

  it("refuses a shared frame per surface, and never retries either of them", () => {
    // A refusal stays PER SURFACE, sharing or not — each holder discovers the over-cap backing store once, on
    // the build it first tries to upload, and is never asked again. The refusal is decided before any GL call, so
    // "once each" costs nothing but the counter; what the entry's own `declined` flag adds is the case where the
    // frame outlives its first holder, and neither is a retry.
    const h = harness({ maxTextureDim: 256 });
    h.build(["a", "b"]);
    h.render("a", fxCanvas({ w: 512, h: 512 }), { staticKey: "huge" });
    h.render("b", fxCanvas({ w: 512, h: 512 }), { staticKey: "huge" });
    h.build(["a", "b"]);

    expect(h.fx.stats().declined).toBe(2);
    expect(h.cache.uploaded).toEqual([]);
    expect(h.fx.stats().resident).toBe(0);

    // Never retried: more frames, more builds, still nothing uploaded and no further refusals counted.
    h.render("a", undefined, { staticKey: "huge" });
    h.render("b", undefined, { staticKey: "huge" });
    h.build(["a", "b"]);
    expect(h.cache.uploaded).toEqual([]);
    expect(h.fx.stats().declined).toBe(2);
    expect(h.fx.stats().oversized).toBe(2);
  });
});

describe("the surface box", () => {
  it("resolves a shader's PERCENT placement against the node's box", () => {
    const canvas = fxCanvas({ w: 256, h: 256, left: "25%", top: "10%", width: "50%", height: "80%" });
    expect(resolveFxBox(canvas, 400, 200)).toEqual({ offsetX: 100, offsetY: 20, cssW: 200, cssH: 160 });
  });

  it("takes a particle canvas's NEGATIVE pixel travel margin verbatim", () => {
    // A particle emitter's own node box is 0x0, so the box MUST come from the canvas: reading the node would
    // produce an empty quad and no effect at all.
    const canvas = fxCanvas({ w: 512, h: 512, left: "-96px", top: "-64px", width: "292px", height: "228px" });
    expect(resolveFxBox(canvas, 0, 0)).toEqual({ offsetX: -96, offsetY: -64, cssW: 292, cssH: 228 });
  });

  it("falls back to the node's box for a canvas with no placement of its own", () => {
    const canvas = document.createElement("canvas");
    expect(resolveFxBox(canvas, 300, 120)).toEqual({ offsetX: 0, offsetY: 0, cssW: 300, cssH: 120 });
  });

  it("re-reads the box every acquire, so a runtime that re-places its canvas moves the quad", () => {
    const h = harness({ paceBytes: 0 });
    const canvas = fxCanvas({ w: 64, h: 64, left: "0", top: "0", width: "100%", height: "100%" });
    h.build(["a"]);
    h.render("a", canvas);
    expect(h.fx.acquire("a", 200, 100)?.cssW).toBe(200);
    h.fx.endBuild();

    canvas.style.width = "50%";
    expect(h.fx.acquire("a", 200, 100)?.cssW).toBe(100);
    h.fx.endBuild();
  });
});

describe("the surface blend", () => {
  it("takes the shader's own render_mode when gsw reports it", () => {
    const h = harness({ paceBytes: 0 });
    h.build(["a"]);
    h.fx.noteRendered("a", fxCanvas({ w: 64, h: 64 }), { blend: "add" });
    expect(h.fx.acquire("a", 100, 100)?.blend).toBe(BLEND_ADD);
    h.fx.endBuild();
  });

  it("falls back to the mix-blend-mode gsw wrote on the host element", () => {
    // The DOM fallback for a runtime that passes no info: gsw maps `add` to `plus-lighter` and `mul` to
    // `multiply` on the NODE, which is the canvas's grandparent.
    const h = harness({ paceBytes: 0 });
    const host = document.createElement("div");
    const selfLayer = document.createElement("div");
    const canvas = fxCanvas({ w: 64, h: 64 });
    host.style.mixBlendMode = "plus-lighter";
    host.appendChild(selfLayer);
    selfLayer.appendChild(canvas);

    h.build(["a"]);
    h.render("a", canvas);
    expect(h.fx.acquire("a", 100, 100)?.blend).toBe(BLEND_ADD);
    h.fx.endBuild();

    host.style.mixBlendMode = "multiply";
    expect(h.fx.acquire("a", 100, 100)?.blend).toBe(BLEND_MUL);
    h.fx.endBuild();
  });

  it("is MIX for everything else, including the modes CSS cannot spell", () => {
    const h = harness({ paceBytes: 0 });
    h.build(["a", "b"]);
    h.fx.noteRendered("a", fxCanvas({ w: 64, h: 64 }), { blend: "sub" });
    h.fx.noteRendered("b", fxCanvas({ w: 64, h: 64 }));
    expect(h.fx.acquire("a", 100, 100)?.blend).toBe(BLEND_MIX);
    expect(h.fx.acquire("b", 100, 100)?.blend).toBe(BLEND_MIX);
    h.fx.endBuild();
  });
});

describe("release, evict, invalidate and dispose", () => {
  it("release gives the texture back and forgets the node", () => {
    const h = harness({ paceBytes: 0 });
    h.build(["a"]);
    h.render("a");
    h.build(["a"]);
    expect(h.fx.stats().resident).toBe(1);

    h.fx.release("a");
    expect(h.cache.released).toEqual(["fx://a"]);
    expect(h.fx.stats().resident).toBe(0);
    expect(h.fx.stats().bytes).toBe(0);
    expect(h.fx.stats().surfaces).toBe(0);
    expect(h.fx.handleFor("a")).toBeNull();
  });

  it("release of an unknown node is a no-op, and never double-releases", () => {
    const h = harness({ paceBytes: 0 });
    h.fx.release("nobody");
    expect(h.cache.released).toEqual([]);

    h.build(["a"]);
    h.render("a");
    h.build(["a"]);
    h.fx.release("a");
    h.fx.release("a");
    expect(h.cache.released).toEqual(["fx://a"]);
  });

  it("evicts a surface no build has named for a while, and re-uploads it if it comes back", () => {
    const h = harness({ paceBytes: 0, evictAfterBuilds: 3 });
    h.build(["a"]);
    h.render("a");
    h.build(["a"]);
    expect(h.fx.stats().resident).toBe(1);

    for (let i = 0; i < 3; i++) h.build(["b"]);
    expect(h.fx.stats().evicted).toBe(1);
    expect(h.fx.stats().resident).toBe(0);
    expect(h.fx.stats().bytes).toBe(0);

    // The record survives (its canvas is still the runtime's), so naming it again re-arms and re-uploads.
    h.build(["a"]);
    h.build(["a"]);
    expect(h.cache.uploaded).toEqual(["fx://a", "fx://a"]);
  });

  it("invalidate(id) re-uploads over the same entry while the old pixels keep painting", () => {
    const h = harness({ paceBytes: 0 });
    h.build(["a"]);
    h.render("a");
    h.build(["a"]);

    h.fx.invalidate("a");
    expect(h.fx.stats().resident).toBe(1); // still drawable — no transparent hole
    expect(h.fx.acquire("a", 100, 100)).not.toBeNull();
    h.fx.endBuild();
    h.build(["a"]);
    expect(h.cache.uploaded).toEqual(["fx://a", "fx://a"]);
    expect(h.cache.released).toEqual([]); // `update` keeps the refcount; nothing was handed back
  });

  it("invalidate() forgets every upload WITHOUT touching the dead driver, and re-uploads on the next build", () => {
    const h = harness({ paceBytes: 0 });
    h.build(["a", "b"]);
    h.render("a");
    h.render("b");
    h.build(["a", "b"]);
    expect(h.fx.stats().resident).toBe(2);

    h.cache.reset(); // gsw's context-lost hook
    h.fx.invalidate();
    expect(h.fx.stats().resident).toBe(0);
    expect(h.fx.stats().bytes).toBe(0);
    expect(h.cache.released).toEqual([]);

    h.build(["a", "b"]);
    expect(h.fx.stats().resident).toBe(2);
  });

  it("dispose stops answering and lets go of every record", () => {
    const h = harness({ paceBytes: 0 });
    h.build(["a"]);
    h.render("a");
    h.build(["a"]);

    h.fx.dispose();
    expect(h.fx.stats().surfaces).toBe(0);
    expect(h.fx.stats().resident).toBe(0);
    expect(h.fx.stats().dirty).toBe(0);
    expect(h.fx.nextDeadline(1)).toBe(Number.POSITIVE_INFINITY);
    expect(h.fx.acquire("a", 100, 100)).toBeNull();
    h.fx.noteRendered("a", fxCanvas({ w: 64, h: 64 }));
    expect(h.onDirty).toHaveBeenCalledTimes(1); // the one from before dispose, and no more
  });
});

describe("the textureBridge fx:// seam", () => {
  /** A bridge over the same cache, with an image factory that counts how many loads it was asked to start. */
  function bridged(fx?: FxSurfaceRegistry): {
    bridge: ReturnType<typeof createTextureBridge>;
    images: number;
  } {
    const counter = { n: 0 };
    const bridge = createTextureBridge({
      cache: fakeCache(),
      onResolved: () => {},
      fx,
      createImage: () => {
        counter.n++;
        return { addEventListener: () => {}, removeEventListener: () => {}, style: {} } as unknown as HTMLImageElement;
      }
    });
    return {
      bridge,
      get images() {
        return counter.n;
      }
    };
  }

  it("hands an fx:// key to the registry instead of trying to load it as an image", () => {
    const h = harness({ paceBytes: 0 });
    h.build(["a"]);
    h.render("a", fxCanvas({ w: 128, h: 64 }));
    h.build(["a"]);

    const b = bridged(h.fx);
    expect(b.bridge.sizeOf(fxKeyForNode("a"))).toEqual({ width: 128, height: 64 });
    expect(b.images).toBe(0);

    const list = createDrawList<ExecutorTexture | null>();
    const adapted = b.bridge.adapt(list);
    adapted.pushQuad(createQuadView(), fxKeyForNode("a"));
    expect(list.textureAt(0)).not.toBeNull();
    expect(adapted.textureAt(0)).toBe("fx://a");
    expect(b.images).toBe(0);
  });

  it("answers null for an fx key with no pixels, and leaves the quad transparent", () => {
    const h = harness();
    const b = bridged(h.fx);
    expect(b.bridge.sizeOf(fxKeyForNode("nobody"))).toBeNull();

    const list = createDrawList<ExecutorTexture | null>();
    const adapted = b.bridge.adapt(list);
    adapted.pushQuad(createQuadView(), fxKeyForNode("nobody"));
    expect(list.textureAt(0)).toBeNull();
    expect(b.bridge.stats.requested).toBe(0); // never became a url
  });

  it("still treats every ordinary url exactly as before — with an fx source and without one", () => {
    for (const fx of [undefined, harness().fx]) {
      const b = bridged(fx);
      expect(b.bridge.sizeOf("/res/ui_atlas_0.png")).toBeNull();
      expect(b.bridge.stats.requested).toBe(1);
      expect(b.images).toBe(1);
    }
  });
});

describe("the third demand source", () => {
  it("answers nowMs while a named surface is dirty and Infinity when it is not", () => {
    const h = harness({ paceBytes: 0 });
    expect(h.fx.nextDeadline(1234)).toBe(Number.POSITIVE_INFINITY);

    h.build(["a"]);
    h.render("a");
    expect(h.fx.nextDeadline(1234)).toBe(1234);

    h.build(["a"]);
    expect(h.fx.nextDeadline(1234)).toBe(Number.POSITIVE_INFINITY);
  });
});

// --- THE STAGE-WAKEUP CAP (M3) ---------------------------------------------------------------------------------
//
// M2 shipped with a measured residual: in a DYNAMIC effect mode the settled stage booked 25.07 frames and 50
// uploads a second on an IDLE combat room with two surfaces, because any dirty bit answered "now". The cap makes
// the deadline the oldest dirty surface's LAST UPLOAD plus one capped frame.
//
// What it does NOT do is the load-bearing half. It does not suppress `onDirty` — that would leave a dirty bit
// nothing ever clears, so `nextDeadline` could never answer Infinity again and PARK GUARD 3 would be dead,
// strictly worse than the frame rate it fixes. It does not change `acquire`: a build that runs anyway still
// uploads the freshest pixels. And it does not delay a surface's FIRST pixels. Each of those has a test here.
describe("the stage-wakeup cap", () => {
  /** The upload instant, PINNED — the deadline is an offset from it, so a real clock would test the machine. */
  const T = 1000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Name, paint and UPLOAD `id` at `at` — the only state the cap can act on. */
  function uploadedAt(h: Harness, at: number, id = "a", named: readonly string[] = [id]): void {
    vi.spyOn(performance, "now").mockReturnValue(at);
    h.build(named);
    h.render(id);
    h.build(named);
  }

  it("defaults to FX_FPS_DEFAULT and reports it", () => {
    // It has to sit BELOW gsw's own rate to bind at all: every quality tier says 30fps, and the measured idle
    // wakeup rate was already 25.07.
    expect(FX_FPS_DEFAULT).toBe(15);
    expect(harness().fx.stats().fps).toBe(15);
    expect(harness({ fps: 0 }).fx.stats().fps).toBe(0);
    expect(harness({ fps: 30 }).fx.stats().fps).toBe(30);
  });

  it("does NOT delay a surface's first pixels — a never-uploaded dirty surface is due now", () => {
    const h = harness({ paceBytes: 0 });
    h.build(["a"]);
    h.render("a");
    expect(h.fx.nextDeadline(1_000_000)).toBe(1_000_000);
  });

  it("holds an already-uploaded surface until one capped frame after its last upload", () => {
    const h = harness({ paceBytes: 0, fps: 10 });
    uploadedAt(h, T);
    expect(h.fx.nextDeadline(T + 1)).toBe(Number.POSITIVE_INFINITY); // clean: nothing owed

    h.render("a"); // gsw paints again
    // 10fps is a 100ms frame. Asked at the upload instant the answer is 100ms out, NOT "now" — which is the whole
    // difference between a stage that repaints per gsw frame and one that repaints at the cap.
    expect(h.fx.nextDeadline(T)).toBe(T + 100);
    expect(h.fx.nextDeadline(T + 50)).toBe(T + 100);
    // …and once the boundary is past it is due NOW, never a stale past timestamp the arm would misread.
    expect(h.fx.nextDeadline(T + 500)).toBe(T + 500);
  });

  it("returns immediately when an injected zero cap disables pacing", () => {
    const h = harness({ paceBytes: 0, fps: 0 });
    uploadedAt(h, T);
    h.render("a");
    expect(h.fx.nextDeadline(1_000_000)).toBe(1_000_000);
  });

  it("takes the MINIMUM over the dirty set — the surface waiting longest sets the wakeup", () => {
    const h = harness({ paceBytes: 0, fps: 10 });
    uploadedAt(h, T, "old");
    uploadedAt(h, T + 1000, "new", ["old", "new"]);

    h.render("old");
    h.render("new");
    // `old` uploaded a second earlier, so its deadline is the sooner one and the later surface cannot push the
    // wakeup out past it.
    expect(h.fx.nextDeadline(0)).toBe(T + 100);
  });

  it("still fires onDirty on every gsw frame — the cap must not touch park guard 2", () => {
    const h = harness({ paceBytes: 0, fps: 10 });
    uploadedAt(h, T);
    h.onDirty.mockClear();
    h.render("a");
    h.render("a");
    // Suppressing these would leave a dirty bit nothing ever clears. The renderer's own arm is idempotent; THAT
    // is the layer that coalesces, and it is why this one can stay dumb.
    expect(h.onDirty).toHaveBeenCalledTimes(2);
    expect(h.fx.stats().dirty).toBe(1);
  });

  it("still UPLOADS inside any build that runs — the cap is on wakeups, not on pixels", () => {
    const h = harness({ paceBytes: 0, fps: 1 });
    uploadedAt(h, T);
    h.render("a");
    // The wakeup would be a second away, but a build the tween loop or a scene delta ran anyway must not paint
    // stale pixels on purpose.
    h.build(["a"]);
    expect(h.cache.uploaded).toEqual(["fx://a", "fx://a"]);
    expect(h.fx.stats().dirty).toBe(0);
  });

  it("keeps park guard 1: an unnamed surface's bit is still dropped, and the deadline goes Infinite", () => {
    const h = harness({ paceBytes: 0, fps: 10 });
    uploadedAt(h, T);
    h.render("a");
    h.build(["other"]); // `a` left the scene
    expect(h.fx.stats().dirty).toBe(0);
    expect(h.fx.nextDeadline(1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps park guard 3: a capped screen still drains to Infinity", () => {
    const h = harness({ paceBytes: 4 * MB, side: sideFor(4), fps: 10 });
    const ids = ["a", "b", "c", "d", "e"];
    h.build(ids);
    for (const id of ids) h.render(id);
    // One upload per build (4MB budget, 4MB apiece). Every candidate here is a never-uploaded surface, so the cap
    // never holds the pump up — and the pump still terminates.
    for (let i = 0; i < ids.length; i++) {
      expect(h.fx.nextDeadline(1)).toBe(1);
      h.build(ids);
    }
    expect(h.fx.stats().dirty).toBe(0);
    expect(h.fx.nextDeadline(1)).toBe(Number.POSITIVE_INFINITY);
  });
});

// THE RESIDENT FX-BYTE CAP (default 48 MB) — the sibling of the texture bridge's page
// ceiling, and the second of the two populations round 7's ledger found with no resident budget at all. What this
// registry had was an upload PACE (32 MB per build, which shapes when bytes arrive rather than how many stay) and
// a 120-build age-out (a clock, not a budget).
//
// The default is placed by ITS OWN measurements rather than by symmetry with the page cap. Measured on the host
// at the device's geometry, fx bytes alone: 0 MB on combat and audit-shop with effects STATIC, 3.0 MB on
// r13-discard static, 4.2 MB on combat with a live background — and 209.2 MB on r13-discard with effects
// DYNAMIC. The product default is static on both effect families, so 48 MB is never approached by the shipped
// configuration; what it bounds is the dynamic worst case.
describe("fx resident byte cap", () => {
  /** Warm `ids` to `mb` megabytes each and leave them uploaded. */
  const warm = (h: Harness, ids: readonly string[], mb: number): void => {
    const side = sideFor(mb);
    h.build(ids);
    for (const id of ids) h.render(id, fxCanvas({ w: side, h: side }));
    h.build(ids);
  };

  it("publishes the ceiling in force", () => {
    const h = harness({ residentBytes: 32 * MB });
    expect(h.fx.stats().residentCap).toBe(32 * MB);
    expect(h.fx.stats().evictedByCap).toBe(0);
  });

  it("evicts nothing while the total is under the ceiling", () => {
    const h = harness({ residentBytes: 64 * MB, paceBytes: 0, paceCount: 0 });
    warm(h, ["a", "b"], 8);
    for (let i = 0; i < 5; i++) h.build([]);
    expect(h.fx.stats().evictedByCap).toBe(0);
  });

  // Least-recently-NAMED first, and only as far as it must.
  it("releases least-recently-drawn surfaces first, and stops once under the ceiling", () => {
    const h = harness({ residentBytes: 40 * MB, paceBytes: 0, paceCount: 0 });
    warm(h, ["old", "mid", "new"], 16); // 48 MB resident against a 40 MB ceiling
    // Two more builds naming only the newer pair: "old" falls outside `namedRecently` and has the oldest clock.
    h.build(["mid", "new"]);
    h.build(["mid", "new"]);
    expect(h.fx.stats().evictedByCap).toBe(1);
    expect(h.cache.released).toContain("fx://old");
    expect(h.fx.stats().bytes).toBe(32 * MB);
  });

  // THE NAMED-RECENTLY EXEMPTION, reusing this registry's own definition (the build that just ran OR the one in
  // progress). The one-build lag matters more here than for a page: an fx surface is uploaded from a runtime
  // canvas that is still animating, so evicting one the next build draws spends the pace budget on a treadmill
  // instead of on new pixels. If the live set alone exceeds the ceiling, the cap loses.
  it("never evicts a surface the scene is still drawing, even over the ceiling", () => {
    const h = harness({ residentBytes: 8 * MB, paceBytes: 0, paceCount: 0 });
    warm(h, ["a", "b", "c"], 16); // 48 MB against an 8 MB ceiling, all three named every build
    expect(h.fx.stats().evictedByCap).toBe(0);
    expect(h.fx.stats().bytes).toBe(48 * MB);
  });

  it("is disabled outright by an injected zero ceiling", () => {
    const h = harness({ residentBytes: 0, paceBytes: 0, paceCount: 0 });
    warm(h, ["a", "b", "c"], 16);
    for (let i = 0; i < 5; i++) h.build([]);
    expect(h.fx.stats().residentCap).toBe(0);
    expect(h.fx.stats().evictedByCap).toBe(0);
  });

  // Separate counters, because they say different things about a low `resident`: an age-out is a surface the
  // scene stopped drawing, a cap eviction is one it may draw again next build.
  it("counts cap evictions apart from age-outs", () => {
    const h = harness({ residentBytes: 40 * MB, paceBytes: 0, paceCount: 0, evictAfterBuilds: 1000 });
    warm(h, ["old", "mid", "new"], 16);
    h.build(["mid", "new"]);
    h.build(["mid", "new"]);
    expect(h.fx.stats().evictedByCap).toBe(1);
    expect(h.fx.stats().evicted).toBe(0);
  });

  // The recovery is what makes a ceiling this size defensible: ONE texImage2D from the runtime's own live canvas,
  // with no fetch and no decode — unlike a page, which at worst goes back to the network.
  it("re-uploads an evicted surface from the runtime canvas when the scene names it again", () => {
    const h = harness({ residentBytes: 40 * MB, paceBytes: 0, paceCount: 0 });
    warm(h, ["old", "mid", "new"], 16);
    h.build(["mid", "new"]);
    h.build(["mid", "new"]);
    expect(h.cache.released).toContain("fx://old");
    const before = h.cache.uploaded.length;
    // The runtime is still drawing it. Naming it again re-admits the surface, and the next frame it renders is
    // uploaded from that same canvas — no fetch, no decode, which is what makes a ceiling this size defensible.
    h.build(["old", "mid", "new"]);
    h.render("old");
    h.build(["old", "mid", "new"]);
    expect(h.cache.uploaded.length).toBeGreaterThan(before);
    expect(h.cache.uploaded[h.cache.uploaded.length - 1]).toBe("fx://old");
    expect(h.fx.handleFor("old")).not.toBeNull();
  });

  it("defaults to 48MB — an order of magnitude above every static-effects reading measured on the host", () => {
    expect(FX_RESIDENT_BYTES_DEFAULT).toBe(48 * MB);
    expect(harness().fx.stats().residentCap).toBe(48 * MB);
  });
});

// --- the under-resolution census, `fx.underResolved` (R-A4) -------------------------------------------------------
//
// WHAT IT IS FOR, and it is a class of wrong render that every other number in this file is blind to. A gsw
// effect owns its own <canvas>: the runtime picks the BACKING STORE, the mirror places the CSS box, and until now
// nothing compared the two. A 128x128 store stretched across a 512-device-pixel box is consistent with every
// reading here — `resident` counts it, `bytes` prices it, `uploads` says the pixels are flowing — and the
// executor's LINEAR filter turns the shortfall into a smooth, plausible, WRONG image. It is the fx twin of the
// glyph path's ppem floor: the picture is not missing, it is blurrier than the machine could have drawn it.
//
// THE SLACK IS ONE 1/8 QUANTISATION STEP, not a tolerance for being wrong: gsw sizes a store in 1/8 steps of its
// box, so a correctly-sized surface can sit up to one step under its device box and a tighter test would report
// every effect on every screen.

describe("under-resolved surfaces (fx.underResolved)", () => {
  /** A surface canvas with a stated backing store and a stated DESIGN-space css width. */
  function sized(backing: number, cssWidth: number): HTMLCanvasElement {
    return fxCanvas({ w: backing, h: backing, width: `${cssWidth}px`, height: `${cssWidth}px` });
  }

  /**
   * One closed build that renders and names `id` with the given canvas, census armed.
   *
   * The two knobs are the census's two inputs besides the canvas: `axis` is the mean-axis scale of the affine
   * the quad is drawn through (what `emitFxQuad` passes), `perDesignPx` is the stage's design-to-device factor.
   * NEITHER is a layout read — that is the point of the shape (see `noteResolution`).
   */
  function censusOf(canvas: HTMLCanvasElement, axis = 1, perDesignPx = 1): number {
    const h = harness();
    const fx = createFxSurfaces({
      cache: h.cache,
      onDirty: () => {},
      resolutionCensus: true,
      perDesignPx: () => perDesignPx
    });
    fx.noteRendered("s", canvas);
    fx.acquire("s", 100, 100, axis);
    fx.endBuild();
    return fx.stats().underResolved;
  }

  it("counts a surface whose backing store is well under its device box", () => {
    // 128 backing against 512 device px — a quarter of the pixels it is being stretched over.
    expect(censusOf(sized(128, 512))).toBe(1);
  });

  it("counts 0 for a surface sized to its box — the healthy case, asserted rather than assumed", () => {
    expect(censusOf(sized(512, 512))).toBe(0);
  });

  it("counts 0 one quantisation step under, and 1 past it", () => {
    // 1/8 of 512 is 64. A store at 448 is exactly one step down and is FINE; 447 is past the step.
    expect(censusOf(sized(448, 512))).toBe(0);
    expect(censusOf(sized(447, 512))).toBe(1);
  });

  it("prices the box in DEVICE pixels — the same store passes at 1x and fails at 2x", () => {
    // The failure mode this catches lives on a phone: the design box does not change, the device box doubles,
    // and a runtime that sized its store from the design box alone is suddenly drawing half-resolution.
    expect(censusOf(sized(512, 512), 1, 1)).toBe(0);
    expect(censusOf(sized(512, 512), 1, 2)).toBe(1);
  });

  it("counts a MAGNIFIED surface — the class `data-godot-shader-pixel-ratio` exists to fix", () => {
    // gsw sizes a store from `clientWidth`, which is blind to an ancestor `transform: scale()`. A node drawn at
    // 2x with a store sized for 1x is exactly half the resolution it is being shown at, and nothing gsw can read
    // off its own element says so — which is why the mirror stamps the magnification for it.
    expect(censusOf(sized(512, 512), 2)).toBe(1);
    // …and once the store follows the magnification, the finding goes away.
    expect(censusOf(sized(1024, 512), 2)).toBe(0);
  });

  it("does NOT count a ROTATED surface — the regression this counter shipped with", () => {
    // A rotated square's `getBoundingClientRect()` is its AXIS-ALIGNED BOUNDING BOX: `|cos|+|sin|` wider than
    // the square, up to sqrt(2) at 45 degrees, with not one extra device pixel underneath it. Measuring that
    // made the census report two of three IDENTICALLY-SIZED sibling particle surfaces on the live combat page
    // as under-resolved purely because they were turned 15 and 45 degrees (their needs read 1.2247x and
    // 1.4142x; the upright third read 1.0000x). The census now takes the affine's mean AXIS scale, which a
    // rotation leaves at exactly 1 — so all three read the same, which is the truth about all three.
    const rot = (deg: number): number => {
      const r = (deg * Math.PI) / 180;
      return fxAxisScale([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
    };
    expect(rot(15)).toBeCloseTo(1, 12);
    expect(rot(45)).toBeCloseTo(1, 12);
    expect(censusOf(sized(512, 512), rot(15))).toBe(0);
    expect(censusOf(sized(512, 512), rot(45))).toBe(0);
    // The AABB widths those two really have, for the record — and the areas the old measurement would have
    // asked gsw to allocate for nothing.
    expect(Math.cos(Math.PI / 12) + Math.sin(Math.PI / 12)).toBeCloseTo(Math.sqrt(1.5), 6);
    expect(Math.cos(Math.PI / 4) + Math.sin(Math.PI / 4)).toBeCloseTo(Math.SQRT2, 12);
  });

  it("says nothing about a surface with no box, no scale, or no stage factor", () => {
    // "Not drawn" is not "drawn small". Each of the three inputs can be legitimately absent — a zero-width
    // quad, a collapsed transform, a registry built without `perDesignPx` — and none of them is a finding.
    expect(censusOf(sized(1, 0))).toBe(0);
    expect(censusOf(sized(128, 512), 0)).toBe(0);
    expect(censusOf(sized(128, 512), 1, 0)).toBe(0);
  });

  it("is a LAST-BUILD count, not a running total — a repainting screen must not accumulate", () => {
    const h = harness();
    const fx = createFxSurfaces({
      cache: h.cache,
      onDirty: () => {},
      resolutionCensus: true,
      perDesignPx: () => 1
    });
    fx.noteRendered("s", sized(128, 512));
    for (let i = 0; i < 5; i++) {
      fx.acquire("s", 100, 100);
      fx.endBuild();
    }
    expect(fx.stats().underResolved).toBe(1);
    // …and it falls back to 0 when the build stops naming the surface, rather than latching.
    fx.acquire("other", 100, 100);
    fx.endBuild();
    expect(fx.stats().underResolved).toBe(0);
  });

  it("is OFF by default, and costs NO layout read even when armed", () => {
    // It used to read `getBoundingClientRect()` — a forced synchronous layout inside a build that had just
    // written the overlay, per named surface. It no longer reads the DOM's geometry at all: the device width is
    // derived from the quad's own numbers. The arm survives anyway, because a number nobody reads is still a
    // number nobody should pay for; and a 0 with the arm down means "not measured", not "nothing is wrong".
    const canvas = sized(128, 512);
    let rectReads = 0;
    const inner = canvas.getBoundingClientRect;
    canvas.getBoundingClientRect = function measured(this: HTMLCanvasElement) {
      rectReads++;
      return inner.call(this);
    };
    const h = harness();
    const off = createFxSurfaces({ cache: h.cache, onDirty: () => {}, perDesignPx: () => 1 });
    off.noteRendered("s", canvas);
    off.acquire("s", 100, 100);
    off.endBuild();
    expect(off.stats().underResolved).toBe(0);
    expect(rectReads).toBe(0);

    const on = createFxSurfaces({
      cache: h.cache,
      onDirty: () => {},
      resolutionCensus: true,
      perDesignPx: () => 1
    });
    on.noteRendered("s", canvas);
    on.acquire("s", 100, 100);
    on.endBuild();
    expect(on.stats().underResolved).toBe(1); // it really did measure
    expect(rectReads).toBe(0); // ...without a single forced layout

    // …and the census SAYS whether it was on, which is the whole reason the flag is published: a reader who
    // sees 0 with no arm beside it cannot tell "measured, all fine" from "never measured".
    expect(off.stats().resolutionCensus).toBe(false);
    expect(on.stats().resolutionCensus).toBe(true);
  });

  it("declares the slack it uses, so a reader never has to reverse it out of a threshold", () => {
    expect(FX_UNDER_RESOLVED_SLACK).toBe(1 / 8);
  });
});
