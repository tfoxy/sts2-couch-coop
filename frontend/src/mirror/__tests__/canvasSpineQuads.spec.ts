import { describe, expect, it, vi } from "vitest";

import { BLEND_ADD, BLEND_MIX, createDrawList, type CanvasTextureCache, type ExecutorTexture } from "@godot-scene-web/canvas";

import { buildDrawList, type SpineQuadSource } from "@/mirror/canvas/buildDrawList";
import {
  createPaintScratch,
  emitSpineQuad,
  type OverlayRecord,
  type PaintSink,
  type SpineQuadBox
} from "@/mirror/canvas/paintSpec";
import {
  SPINE_KEY_PREFIX,
  SPINE_PACE_COUNT_DEFAULT,
  createSpineSurfaces,
  spineKeyForUrl,
  spineUrlFromKey
} from "@/mirror/canvas/spineSurfaces";
import { createTextureBridge } from "@/mirror/canvas/textureBridge";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

// SPINE STILLS INTO THE CANVAS (M3 A2).
//
// A spine paints EARLY — ranks 41 to 630 on the gated recordings — and 40 to 576 later canvas commands overlap it:
// HP bars, block outlines, the shop's slot plates. The overlay hoists every spine unconditionally, so an `<img>`
// above the whole canvas paints all of that UNDER the creature. A quad at the node's own paint index does not.
//
// The rule is SELECTIVE and it is the whole design. A decoded still is 4-16 MB and deck view carries 33 of them, so
// a still gets a quad only where the hoist is actually WRONG — where the cover pass finds something painted over
// it. Everything else keeps the element, keeps `spineClip`'s bytes-only path, and looks identical either way.
// Every refusal on this path falls back to that same hoist, which is why there is no state where a creature
// disappears; several of these tests are exactly that property.

// --- fixtures ---------------------------------------------------------------------------------------------

function wireNode(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId: null,
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 50 } },
    visible: true,
    ...over
  };
}

/** A `SpineSprite` — which streams NO `localRect`, and that is why the cover pass has never had an opinion. */
function spineSpec(id = "sp", over: Record<string, unknown> = {}): Record<string, unknown> {
  return wireNode(id, {
    nodeType: "SpineSprite",
    localRect: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } },
    spine: { sceneResPath: "res://creature.tscn", nodePath: "Sprite" },
    spineCurrentAnim: "idle",
    ...over
  });
}

function stateOf(specs: Array<Record<string, unknown>>): MirrorState {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: specs.map((s) => s.id),
      upserts: specs
    })!
  );
  return state;
}

function record(over: Partial<OverlayRecord> = {}): OverlayRecord {
  return {
    id: "sp",
    kind: "spine",
    transform: [1, 0, 0, 1, 0, 0],
    w: 0,
    h: 0,
    order: 0,
    opacity: 1,
    tintR: 1,
    tintG: 1,
    tintB: 1,
    coveredAbove: false,
    clip: null,
    ...over
  };
}

function box(over: Partial<SpineQuadBox> = {}): SpineQuadBox {
  return { clipUrl: "/spines/creature?anim=idle", frameW: 40, frameH: 60, tx: -10, ty: -20, scale: 2, ...over };
}

interface Pushed {
  texture: string | null;
  m: number[];
  w: number;
  h: number;
  src: [number, number, number, number];
  rgba: [number, number, number, number];
  blend: number;
  hasColorMatrix: boolean;
}

function capturingSink(): { sink: PaintSink; pushed: Pushed[] } {
  const pushed: Pushed[] = [];
  return {
    pushed,
    sink: {
      quad(view, texture) {
        pushed.push({
          texture,
          m: [...view.m],
          w: view.w,
          h: view.h,
          src: [view.srcX, view.srcY, view.srcW, view.srcH],
          rgba: [view.r, view.g, view.b, view.a],
          blend: view.blend,
          hasColorMatrix: view.hasColorMatrix
        });
      },
      ninePatch() {
        throw new Error("a spine quad is never a nine-patch");
      },
      polyline() {
        throw new Error("a spine quad is never a polyline");
      }
    }
  };
}

function emit(rec: OverlayRecord, b: SpineQuadBox, node?: MirrorNode): { pushed: Pushed[]; count: number } {
  const { sink, pushed } = capturingSink();
  const count = emitSpineQuad(rec, b, node, createPaintScratch(), sink);
  return { pushed, count };
}

// --- the quad's own numbers ---------------------------------------------------------------------------------

describe("emitSpineQuad", () => {
  it("places the quad EXACTLY where the <img> sits — the same composition mountStill writes", () => {
    // The element is `width/height = frame px` with `transform: translate(tx,ty) scale(s)` inside a host carrying
    // `record.transform`. The quad is that same composition, so the two backends cannot drift apart by
    // construction rather than by a tolerance.
    const { pushed, count } = emit(record({ transform: [1, 0, 0, 1, 900, 500] }), box());
    expect(count).toBe(1);
    expect(pushed[0].m).toEqual([2, 0, 0, 2, 900 - 10, 500 - 20]);
    expect(pushed[0].w).toBe(40);
    expect(pushed[0].h).toBe(60);
  });

  it("carries the WHOLE still as its source rect", () => {
    // A zero-span source makes the executor stretch ONE TEXEL over the box — a flat smear of the creature's
    // top-left pixel, which is the trap the bridge documents.
    expect(emit(record(), box()).pushed[0].src).toEqual([0, 0, 40, 60]);
  });

  it("keys the quad in the spine:// key space", () => {
    expect(emit(record(), box()).pushed[0].texture).toBe(`${SPINE_KEY_PREFIX}/spines/creature?anim=idle`);
  });

  it("premultiplies the composed tint and alpha, with no colour matrix", () => {
    const { pushed } = emit(record({ opacity: 0.5, tintR: 1, tintG: 0.4, tintB: 0 }), box());
    expect(pushed[0].rgba).toEqual([0.5, 0.2, 0, 0.5]);
    expect(pushed[0].hasColorMatrix).toBe(false);
  });

  it("takes the node's own CanvasItemMaterial blend, which the hoisted element could not express", () => {
    const additive = stateOf([spineSpec("sp", { canvasBlendMode: 1 })]).nodes.get("sp")!;
    expect(emit(record(), box(), additive).pushed[0].blend).toBe(BLEND_ADD);
    expect(emit(record(), box()).pushed[0].blend).toBe(BLEND_MIX);
  });

  it("pushes NOTHING for a degenerate box or a non-spine record", () => {
    expect(emit(record(), box({ frameW: 0 })).count).toBe(0);
    expect(emit(record(), box({ frameH: 0 })).count).toBe(0);
    expect(emit(record({ kind: "shader" }), box()).count).toBe(0);
  });
});

// --- the builder's selectivity ------------------------------------------------------------------------------

function sourceOf(
  over: Partial<SpineQuadSource> = {}
): SpineQuadSource & { admitted: string[]; asked: string[] } {
  const admitted: string[] = [];
  const asked: string[] = [];
  return {
    admitted,
    asked,
    boxFor: (id) => {
      asked.push(id);
      return box({ clipUrl: `/spines/${id}` });
    },
    wanted: () => true,
    admit: (id) => {
      admitted.push(id);
      return true;
    },
    ...over
  };
}

/** A scene with a creature and a plate painted OVER it — the exact defect the flag exists for. */
function coveredScene(): MirrorState {
  return stateOf([
    wireNode("Root", { localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } }),
    spineSpec("sp", { parentId: "Root", transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 100, y: 100 } } }),
    wireNode("Plate", {
      parentId: "Root",
      localRect: { position: { x: 0, y: 0 }, size: { x: 400, y: 400 } },
      fillColor: { r: 1, g: 0, b: 0, a: 1 }
    })
  ]);
}

function build(state: MirrorState, spineSource: SpineQuadSource | null) {
  return buildDrawList(state, createDrawList<string>(), { spineSource, hitTest: false, assert: true });
}

describe("the builder's spine-quad rule", () => {
  it("emits NOTHING without a source — the default page is byte-identical", () => {
    const withOut = build(coveredScene(), null);
    expect(withOut.stats.spineQuads).toBe(0);
    expect(withOut.spineQuadIds.size).toBe(0);
    // …and the cover pass keeps its "a 0x0 record has no extent, so no opinion" rule.
    expect(withOut.overlayRecords.find((r) => r.kind === "spine")!.coveredAbove).toBe(false);
  });

  it("gives the cover pass a real extent for a spine, which it has never had before", () => {
    const built = build(coveredScene(), sourceOf());
    // The still's rect is 40x60 at scale 2 offset (-10,-20) from the node at (100,100): design 90,80 .. 170,200,
    // which the 0..400 plate painted after it overlaps.
    expect(built.overlayRecords.find((r) => r.kind === "spine")!.coveredAbove).toBe(true);
  });

  it("does NOT quad a creature nothing paints over — the hoist is correct there", () => {
    const clear = stateOf([
      wireNode("Root", { localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } }),
      wireNode("Backdrop", { parentId: "Root", localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } }, fillColor: { r: 0, g: 0, b: 0, a: 1 } }),
      spineSpec("sp", { parentId: "Root" })
    ]);
    // `wanted` is the caller's memory of the PREVIOUS build's cover answer, and nothing here is covered.
    const built = build(clear, sourceOf({ wanted: () => false }));
    expect(built.stats.spineQuads).toBe(0);
    expect(built.overlayRecords.find((r) => r.kind === "spine")!.coveredAbove).toBe(false);
  });

  it("emits the quad INSIDE the node's own command range, at its own paint index", () => {
    const built = build(coveredScene(), sourceOf());
    expect(built.stats.spineQuads).toBe(1);
    expect(built.spineQuadIds.has("sp")).toBe(true);
    const range = built.ranges.get("sp")!;
    expect(range.paintEnd - range.start).toBe(1);
    // The plate paints AFTER the creature, which is the whole point: on the DOM arm it would paint under.
    expect(built.ranges.get("Plate")!.start).toBeGreaterThan(range.start);
  });

  it("falls back to the hoist when the registry REFUSES the pixels", () => {
    const built = build(coveredScene(), sourceOf({ admit: () => false }));
    expect(built.stats.spineQuads).toBe(0);
    expect(built.spineQuadIds.size).toBe(0);
    // The record is untouched, so the overlay keeps mounting the creature exactly as it does today.
    expect(built.overlayRecords.some((r) => r.kind === "spine")).toBe(true);
  });

  it("falls back to the hoist when the overlay has no committed still (a MULTI-FRAME clip, or none yet)", () => {
    // `overlay.spineQuads()` publishes only committed single-frame stills, so an animating creature — or one whose
    // clip has not decoded — simply has no box. The multi-frame path is never reachable from here.
    const src = sourceOf({ boxFor: () => null });
    const built = build(coveredScene(), src);
    expect(built.stats.spineQuads).toBe(0);
    expect(src.admitted).toEqual([]); // and nothing is asked to upload for it either
  });

  it("does not ADMIT a clip it does not want — selectivity is decided before residency is spent", () => {
    const src = sourceOf({ wanted: () => false });
    build(coveredScene(), src);
    expect(src.admitted).toEqual([]);
  });
});

// --- the registry ------------------------------------------------------------------------------------------

interface FakeCache extends CanvasTextureCache {
  uploaded: string[];
  released: string[];
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
    acquire: (key, source) => {
      if (failing.has(key)) {
        failing.delete(key);
        entries.set(key, { texture: {} as WebGLTexture, width: 1, height: 1, revision: 1 });
        throw new Error("tainted source");
      }
      const src = source as { width?: number; height?: number };
      const handle = { texture: {} as WebGLTexture, width: src.width ?? 1, height: src.height ?? 1, revision: 1 };
      entries.set(key, handle);
      stats.entries++;
      stats.uploads++;
      uploaded.push(key);
      return handle;
    },
    acquireBytes: () => {
      throw new Error("a spine still is a decoded <img>, never raw bytes");
    },
    retain: (key) => entries.get(key)!,
    release: (key) => {
      released.push(key);
      entries.delete(key);
    },
    updateRegion: () => {
      throw new Error("unused");
    },
    update: () => {
      throw new Error("a spine still is IMMUTABLE per url — it acquires, it never updates");
    },
    reset: () => entries.clear(),
    dispose: () => entries.clear()
  };
}

/** The overlay's own decoded `<img>`, as the registry receives it — the point being that nothing re-decodes. */
function pixels(w = 64, h = 64): { source: TexImageSource; width: number; height: number } {
  const el = document.createElement("img");
  el.width = w;
  el.height = h;
  return { source: el as unknown as TexImageSource, width: w, height: h };
}

/**
 * The same still, but ALSO carrying its encoded bytes — the shape the overlay hands over once the registry is
 * allowed to mint pixels it owns. `bytes` is a thunk on purpose, so a test can assert it was never called.
 */
function pixelsWithBytes(w = 64, h = 64, bytes?: () => Blob | null) {
  return { ...pixels(w, h), bytes: bytes ?? (() => ({ size: w * h }) as unknown as Blob) };
}

/** A stand-in for `createImageBitmap`, with the resolution held so a test can decide WHEN the pixels arrive. */
function fakeDecoder(w = 64, h = 64) {
  const closed: number[] = [];
  let pending: Array<() => void> = [];
  let seq = 0;
  return {
    closed,
    get inFlight() {
      return pending.length;
    },
    /** Resolve every decode requested so far. */
    async flush(): Promise<void> {
      const now = pending;
      pending = [];
      for (const settle of now) settle();
      await Promise.resolve();
      await Promise.resolve();
    },
    decode: (_blob: Blob) =>
      new Promise<ImageBitmap>((resolve) => {
        const id = seq++;
        pending.push(() =>
          resolve({ width: w, height: h, close: () => closed.push(id) } as unknown as ImageBitmap)
        );
      }),
    reject: null as null | (() => void)
  };
}

const MB = 1024 * 1024;

describe("the spine still registry", () => {
  it("namespaces a clip url so it cannot collide with a page url in the shared cache", () => {
    expect(spineKeyForUrl("/spines/x?anim=idle")).toBe("spine:///spines/x?anim=idle");
    expect(spineUrlFromKey("spine:///spines/x?anim=idle")).toBe("/spines/x?anim=idle");
    expect(spineUrlFromKey("/res/ui_atlas_0.png")).toBeNull();
  });

  it("uploads ONCE per url and SHARES it across every node playing that anim", () => {
    const cache = fakeCache();
    const spine = createSpineSurfaces({ cache, paceCount: 0 });
    // Two ironclads, one idle. Keying per NODE would have uploaded the same 4 MB creature twice.
    expect(spine.acquire("/spines/iron?anim=idle", pixels())).toBe(true);
    expect(spine.acquire("/spines/iron?anim=idle", pixels())).toBe(true);
    expect(cache.uploaded).toEqual(["spine:///spines/iron?anim=idle"]);
    expect(spine.stats().uploads).toBe(1);
    expect(spine.stats().resident).toBe(1);
  });

  it("caps uploads per build at ONE by default — a p90 still is 40ms of texImage2D", () => {
    expect(SPINE_PACE_COUNT_DEFAULT).toBe(1);
    const cache = fakeCache();
    const spine = createSpineSurfaces({ cache });
    expect(spine.acquire("/a", pixels())).toBe(true);
    expect(spine.acquire("/b", pixels())).toBe(false); // …and `/b` keeps its <img> for one more build
    expect(spine.stats().paced).toBe(1);
    spine.endBuild();
    expect(spine.acquire("/b", pixels())).toBe(true);
  });

  it("refuses an upload that would breach the RESIDENT ceiling, and says so", () => {
    const cache = fakeCache();
    // 1 MB ceiling; each still here is 512x512x4 = 1 MB exactly.
    const spine = createSpineSurfaces({ cache, paceBytes: 1 * MB, paceCount: 0 });
    expect(spine.acquire("/a", pixels(512, 512))).toBe(true);
    expect(spine.acquire("/b", pixels(512, 512))).toBe(false);
    expect(spine.stats().refusedForBudget).toBe(1);
    // A REFUSAL IS NOT A LOSS: the node keeps its <img> and renders exactly as it did before the flag. That is
    // what lets the ceiling be this tight.
    expect(spine.stats().bytes).toBe(1 * MB);
  });

  it("refuses an over-MAX_TEXTURE_SIZE still permanently rather than uploading it black", () => {
    const cache = fakeCache();
    const spine = createSpineSurfaces({ cache, paceCount: 0, maxTextureDim: 4096 });
    expect(spine.acquire("/huge", pixels(8192, 64))).toBe(false);
    expect(spine.stats().declined).toBe(1);
    // Never retried: an over-limit `texImage2D` answers INVALID_VALUE and leaves the texture INCOMPLETE, which
    // samples as opaque BLACK — a black rectangle over the creature.
    expect(spine.acquire("/huge", pixels(64, 64))).toBe(false);
    expect(cache.uploaded).toEqual([]);
  });

  it("declines a source the driver will not take, once", () => {
    const cache = fakeCache();
    const spine = createSpineSurfaces({ cache, paceCount: 0 });
    cache.failNext("spine:///tainted");
    expect(spine.acquire("/tainted", pixels())).toBe(false);
    expect(spine.stats().declined).toBe(1);
    expect(spine.acquire("/tainted", pixels())).toBe(false);
    expect(cache.uploaded).toEqual([]);
  });

  it("evicts a clip the scene stopped naming, and re-uploads it when it comes back", () => {
    const cache = fakeCache();
    const spine = createSpineSurfaces({ cache, paceCount: 0, evictAfterBuilds: 3 });
    spine.acquire("/a", pixels());
    for (let i = 0; i < 4; i++) spine.endBuild();
    expect(spine.stats().evicted).toBe(1);
    expect(spine.stats().resident).toBe(0);
    expect(cache.released).toEqual(["spine:///a"]);
    expect(spine.acquire("/a", pixels())).toBe(true);
  });

  it("re-uploads after a CONTEXT LOSS without touching the dead driver", () => {
    const cache = fakeCache();
    const spine = createSpineSurfaces({ cache, paceCount: 0 });
    spine.acquire("/a", pixels());
    cache.reset(); // gsw's own reset, which has already forgotten every texture
    spine.invalidate();
    expect(cache.released).toEqual([]); // a `release` here would decrement an entry that is gone
    expect(spine.stats().resident).toBe(0);
    expect(spine.acquire("/a", pixels())).toBe(true);
  });

  it("answers a handle and a page size only while a clip is really resident", () => {
    const cache = fakeCache();
    const spine = createSpineSurfaces({ cache, paceCount: 0 });
    expect(spine.handleFor("/a")).toBeNull();
    spine.acquire("/a", pixels(200, 100));
    expect(spine.handleFor("/a")).not.toBeNull();
    expect(spine.sizeOf("/a")).toEqual({ width: 200, height: 100 });
    spine.release("/a");
    expect(spine.handleFor("/a")).toBeNull();
    expect(spine.sizeOf("/a")).toBeNull();
  });

  // OWNED PIXELS. A decoded `<img>` frame is a CACHE the phone throws away under memory pressure, after which
  // `texImage2D(img)` re-decodes a 4-16 MB WebP INSIDE the build — 20-58 ms frame tasks on a Moto G86 trace.
  // These tests pin the discipline that fixes it without giving back what the bytes-only still path saved.

  it("refuses the build it starts a decode on, then uploads the pixels it OWNS", async () => {
    const cache = fakeCache();
    const dec = fakeDecoder();
    const spine = createSpineSurfaces({ cache, paceCount: 0, decodeBlob: dec.decode, onDecoded: () => {} });
    // The `<img>` is never uploaded: the still keeps painting through the overlay for exactly one build.
    expect(spine.acquire("/a", pixelsWithBytes())).toBe(false);
    expect(cache.uploaded).toEqual([]);
    expect(spine.stats().decodes).toBe(1);
    await dec.flush();
    expect(spine.acquire("/a", pixelsWithBytes())).toBe(true);
    expect(cache.uploaded).toEqual(["spine:///a"]);
    expect(spine.stats().ownedUploads).toBe(1);
    expect(spine.stats().elementUploads).toBe(0);
    // …and closed the instant it landed: the pixels live on the GPU, where the byte ceiling governs them.
    expect(dec.closed).toEqual([0]);
  });

  it("nudges the renderer when a decode resolves — a settled screen schedules no build of its own", async () => {
    const cache = fakeCache();
    const dec = fakeDecoder();
    const woken: string[] = [];
    const spine = createSpineSurfaces({
      cache,
      paceCount: 0,
      decodeBlob: dec.decode,
      onDecoded: (url) => woken.push(url)
    });
    spine.acquire("/a", pixelsWithBytes());
    expect(woken).toEqual([]);
    await dec.flush();
    expect(woken).toEqual(["/a"]);
  });

  it("decodes ONE still at a time, whatever the screen asks for", async () => {
    const cache = fakeCache();
    const dec = fakeDecoder();
    const spine = createSpineSurfaces({ cache, paceCount: 0, decodeBlob: dec.decode, onDecoded: () => {} });
    // A deck view's 33 creatures must not conspire to allocate 33 stills' worth of RGBA.
    for (const url of ["/a", "/b", "/c"]) expect(spine.acquire(url, pixelsWithBytes())).toBe(false);
    expect(spine.stats().decodes).toBe(1);
    await dec.flush();
    expect(spine.acquire("/a", pixelsWithBytes())).toBe(true);
    // The slot is free again only once its pixels have been spent.
    expect(spine.acquire("/b", pixelsWithBytes())).toBe(false);
    expect(spine.stats().decodes).toBe(2);
  });

  it("spends no decode on a still the caps would refuse anyway", async () => {
    const cache = fakeCache();
    const dec = fakeDecoder(512, 512);
    const spine = createSpineSurfaces({
      cache,
      paceBytes: 1 * MB,
      paceCount: 0,
      decodeBlob: dec.decode,
      onDecoded: () => {}
    });
    let asked = 0;
    const bytes = () => {
      asked++;
      return {} as Blob;
    };
    // 512²×4 = 1 MB, which is the whole ceiling: decode, then upload, and `/a` is now the resident set.
    expect(spine.acquire("/a", pixelsWithBytes(512, 512, bytes))).toBe(false);
    expect(asked).toBe(1);
    await dec.flush();
    expect(spine.acquire("/a", pixelsWithBytes(512, 512, bytes))).toBe(true);
    // `/b` cannot fit, so it never reaches the decode at all — the caps gate the ALLOCATION, not just the upload.
    expect(spine.acquire("/b", pixelsWithBytes(512, 512, bytes))).toBe(false);
    expect(asked).toBe(1);
    expect(spine.stats().refusedForBudget).toBe(1);
    expect(spine.stats().decodes).toBe(1);
  });

  it("closes a resolved bitmap the scene stopped naming, and frees the slot", async () => {
    const cache = fakeCache();
    const dec = fakeDecoder();
    const spine = createSpineSurfaces({ cache, paceCount: 0, decodeBlob: dec.decode, onDecoded: () => {} });
    spine.acquire("/gone", pixelsWithBytes());
    await dec.flush();
    // The creature died between the request and the resolve, so no build ever spends these pixels.
    for (let i = 0; i < 3; i++) spine.endBuild();
    expect(dec.closed).toEqual([0]);
    expect(spine.stats().decodeStale).toBe(1);
    // …and the next creature can decode, which is the property the slot exists for.
    expect(spine.acquire("/next", pixelsWithBytes())).toBe(false);
    expect(spine.stats().decodes).toBe(2);
  });

  it("falls back to the `<img>` for good when the bytes will not decode", async () => {
    const cache = fakeCache();
    const spine = createSpineSurfaces({
      cache,
      paceCount: 0,
      decodeBlob: () => Promise.reject(new Error("corrupt")),
      onDecoded: () => {}
    });
    expect(spine.acquire("/bad", pixelsWithBytes())).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(spine.stats().decodeFailed).toBe(1);
    // The element is what the node is already painting — worse than owned pixels, better than nothing.
    expect(spine.acquire("/bad", pixelsWithBytes())).toBe(true);
    expect(spine.stats().elementUploads).toBe(1);
    expect(spine.stats().decodes).toBe(1); // and never asks again
  });

  it("closes pixels it still owns on dispose — nothing else has a reference to them", async () => {
    const cache = fakeCache();
    const dec = fakeDecoder();
    const spine = createSpineSurfaces({ cache, paceCount: 0, decodeBlob: dec.decode, onDecoded: () => {} });
    spine.acquire("/a", pixelsWithBytes());
    await dec.flush();
    spine.dispose();
    expect(dec.closed).toEqual([0]);
  });

});

// --- the bridge seam ----------------------------------------------------------------------------------------

describe("the bridge's spine:// seam", () => {
  function bridged(spine?: ReturnType<typeof createSpineSurfaces>) {
    const cache = fakeCache();
    let images = 0;
    const bridge = createTextureBridge({
      cache,
      onResolved: () => {},
      createImage: () => {
        images++;
        return document.createElement("img");
      },
      spine
    });
    return { bridge, cache, images: () => images };
  }

  it("never treats a spine:// key as a url to LOAD — the key wraps a real one", () => {
    const cache = fakeCache();
    const spine = createSpineSurfaces({ cache, paceCount: 0 });
    const b = bridged(spine);
    // `spine:///spines/creature?anim=idle` contains a fetchable path. Falling through to `entryFor` would start a
    // SECOND, undecoded fetch of a clip the client already has decoded in an <img>.
    expect(b.bridge.sizeOf("spine:///spines/creature?anim=idle")).toBeNull();
    expect(b.images()).toBe(0);
    expect(b.bridge.stats.requested).toBe(0);
  });

  it("resolves a spine:// key through the registry once its pixels are up", () => {
    const cache = fakeCache();
    const spine = createSpineSurfaces({ cache, paceCount: 0 });
    spine.acquire("/spines/creature?anim=idle", pixels(120, 90));
    const b = bridged(spine);
    expect(b.bridge.sizeOf("spine:///spines/creature?anim=idle")).toEqual({ width: 120, height: 90 });
  });

  it("does not even test the prefix without a spine source configured", () => {
    const b = bridged(undefined);
    // With the flag off no key the builder emits starts with `spine://`, so this is the pre-A2 path verbatim —
    // and a key that DID arrive would be treated as an ordinary url, which is the honest fallback.
    b.bridge.sizeOf("/res/ui_atlas_0.png");
    expect(b.bridge.stats.requested).toBe(1);
  });
});

// --- source-free identity guard -------------------------------------------------------------------------------

describe("an absent spine source is byte-identical", () => {
  it("produces the same list, float for float, as a build that has never heard of spine quads", () => {
    // The source-free property the offline draw-list gate depends on: it runs
    // with no DOM, no decoded image and therefore no source, so it must see exactly the pre-A2 list.
    const a = createDrawList<string>();
    const b = createDrawList<string>();
    build(coveredScene(), null);
    const built = buildDrawList(coveredScene(), a, { hitTest: false });
    const same = buildDrawList(coveredScene(), b, { spineSource: null, hitTest: false });
    expect(same.stats).toEqual(built.stats);
    expect(a.count).toBe(b.count);
    expect(same.overlayRecords.map((r) => [r.id, r.kind, r.coveredAbove])).toEqual(
      built.overlayRecords.map((r) => [r.id, r.kind, r.coveredAbove])
    );
  });

  it("leaves the cover pass's answer for EVERY OTHER record alone when a source is present", () => {
    // The spine box changes what the pass measures for a SPINE record and for nothing else — a shader or text
    // record beside it must read the same either way.
    const state = stateOf([
      wireNode("Root", { localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } }),
      wireNode("Label", { parentId: "Root", nodeType: "Godot.Label", text: { text: "hp" } }),
      spineSpec("sp", { parentId: "Root" }),
      wireNode("Plate", {
        parentId: "Root",
        localRect: { position: { x: 0, y: 0 }, size: { x: 400, y: 400 } },
        fillColor: { r: 1, g: 0, b: 0, a: 1 }
      })
    ]);
    const off = build(state, null).overlayRecords.filter((r) => r.kind !== "spine");
    const on = build(state, sourceOf()).overlayRecords.filter((r) => r.kind !== "spine");
    expect(on.map((r) => [r.id, r.coveredAbove])).toEqual(off.map((r) => [r.id, r.coveredAbove]));
  });
});

// A quad emitted inside the walk rides `paintStart..paintEnd` for free, so the oracle's per-node union is
// untouched by construction. This asserts it rather than asserting the oracle again.
describe("the oracle's painting set is untouched", () => {
  it("keeps a spine node classified as an OVERLAY node even when it also has pixels", () => {
    const built = build(coveredScene(), sourceOf());
    expect(built.stats.overlayByKind.spine).toBe(1);
    expect(built.overlayRecords.some((r) => r.id === "sp")).toBe(true);
    // …and it is not double-counted as a canvas node.
    expect(built.stats.canvas).toBe(build(coveredScene(), null).stats.canvas);
  });
});

vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: () => Promise.reject(new Error("no host in a unit test")) };
});
