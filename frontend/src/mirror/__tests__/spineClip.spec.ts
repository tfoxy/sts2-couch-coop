import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __clearSpineClipCacheForTest,
  frameIndexAt,
  loadSpineClip,
  msToNextSpineFrame,
  parseSpineClip
} from "@/mirror/spineClip";
import { applySceneDelta, createMirrorState, parseSceneDelta } from "@/mirror/sceneTree";
import { resolveRenderQuality, type RenderQualitySignals } from "@/render/quality";
import { spineClipRoute } from "@/protocol/browserResources";

// Build a SpineClipWire v1 blob the way SpineClipWire.cs / CouchCoopSpineClipProvider does, so the parser is
// tested against the exact wire contract (header + length-prefixed per-frame PNG with placement).
interface WireFrame {
  index: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  durationMs: number;
  png: number[];
}

function buildClipBlob(
  frames: WireFrame[],
  canvasWidth: number,
  canvasHeight: number,
  placement: { localX: number; localY: number; localWidth: number; localHeight: number } = {
    localX: 0,
    localY: 0,
    localWidth: 0,
    localHeight: 0
  }
): ArrayBuffer {
  const HEADER = 40;
  const FRAME_HEADER = 28;
  const total = HEADER + frames.reduce((sum, f) => sum + FRAME_HEADER + f.png.length, 0);
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes[0] = 0x53; // S
  bytes[1] = 0x50; // P
  bytes[2] = 0x43; // C
  bytes[3] = 0x4c; // L
  bytes[4] = 1; // version
  view.setUint32(8, frames.length, true);
  view.setUint32(12, canvasWidth, true);
  view.setUint32(16, canvasHeight, true);
  const totalDurationMs = frames.reduce((sum, f) => sum + f.durationMs, 0);
  view.setUint32(20, totalDurationMs, true);
  view.setFloat32(24, placement.localX, true);
  view.setFloat32(28, placement.localY, true);
  view.setFloat32(32, placement.localWidth, true);
  view.setFloat32(36, placement.localHeight, true);
  let offset = HEADER;
  for (const f of frames) {
    view.setUint32(offset, f.index, true);
    view.setInt32(offset + 4, f.offsetX, true);
    view.setInt32(offset + 8, f.offsetY, true);
    view.setUint32(offset + 12, f.width, true);
    view.setUint32(offset + 16, f.height, true);
    view.setUint32(offset + 20, f.durationMs, true);
    view.setUint32(offset + 24, f.png.length, true);
    offset += FRAME_HEADER;
    bytes.set(f.png, offset);
    offset += f.png.length;
  }
  return buffer;
}

describe("spineClip — parse", () => {
  it("round-trips the SpineClipWire header + frames", () => {
    const blob = buildClipBlob(
      [
        { index: 0, offsetX: 1, offsetY: 2, width: 10, height: 20, durationMs: 33, png: [0xa, 0xb, 0xc] },
        { index: 1, offsetX: -3, offsetY: 4, width: 11, height: 21, durationMs: 33, png: [0xd, 0xe] }
      ],
      100,
      200,
      { localX: -50, localY: -75, localWidth: 100, localHeight: 200 }
    );
    const clip = parseSpineClip(blob);
    expect(clip.canvasWidth).toBe(100);
    expect(clip.canvasHeight).toBe(200);
    expect(clip.totalDurationMs).toBe(66);
    expect(clip.localX).toBeCloseTo(-50);
    expect(clip.localY).toBeCloseTo(-75);
    expect(clip.localWidth).toBeCloseTo(100);
    expect(clip.localHeight).toBeCloseTo(200);
    expect(clip.frames).toHaveLength(2);
    expect(clip.frames[0]).toMatchObject({ index: 0, offsetX: 1, offsetY: 2, width: 10, height: 20, startMs: 0 });
    // Second frame's signed offset + cumulative startMs.
    expect(clip.frames[1]).toMatchObject({ index: 1, offsetX: -3, offsetY: 4, startMs: 33 });
    expect(Array.from(clip.frames[0].png)).toEqual([0xa, 0xb, 0xc]);
    expect(Array.from(clip.frames[1].png)).toEqual([0xd, 0xe]);
  });

  it("rejects a stream without the SPCL magic", () => {
    expect(() => parseSpineClip(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toThrow(/SPCL/);
  });

  it("rejects a truncated frame payload", () => {
    const blob = buildClipBlob([{ index: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 33, png: [1, 2, 3] }], 8, 8);
    // Chop the last PNG byte so the declared pngLength overruns the buffer.
    expect(() => parseSpineClip(new Uint8Array(blob).slice(0, blob.byteLength - 1))).toThrow(/truncated/);
  });
});

describe("spineClip — frameIndexAt", () => {
  const clip = parseSpineClip(
    buildClipBlob(
      [
        { index: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [1] },
        { index: 1, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [2] },
        { index: 2, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [3] }
      ],
      4,
      4
    )
  );

  it("maps a time to the covering frame within the loop period", () => {
    expect(frameIndexAt(clip, 0)).toBe(0);
    expect(frameIndexAt(clip, 99)).toBe(0);
    expect(frameIndexAt(clip, 100)).toBe(1);
    expect(frameIndexAt(clip, 250)).toBe(0);
  });

  it("wraps at the final frame start", () => {
    expect(frameIndexAt(clip, 200)).toBe(0);
    expect(frameIndexAt(clip, 450)).toBe(0);
    expect(frameIndexAt(clip, -50)).toBe(1);
  });

  it("keeps the endpoint sample out of looping playback", () => {
    // The REAL baked shape: N distinct frames + a DUPLICATE tail frame clamped to t=duration. Here 4 frames @ 100ms
    // (f0..f2 distinct, f3 = the duplicate of f0), total 400, startMs 0/100/200/300. The true period is
    // frames[last].startMs = 300, so wrapping there shows f0 at t=300 (the same pose as the duplicate) — never f3.
    const baked = parseSpineClip(
      buildClipBlob(
        [
          { index: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [0] },
          { index: 1, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [1] },
          { index: 2, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [2] },
          { index: 3, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [3] } // duplicate tail
        ],
        4,
        4
      )
    );
    expect(frameIndexAt(baked, 0)).toBe(0);
    expect(frameIndexAt(baked, 200)).toBe(2);
    expect(frameIndexAt(baked, 300)).toBe(0); // wraps at 300 → f0, not f3
    expect(frameIndexAt(baked, 400)).toBe(1);
    expect(frameIndexAt(baked, -100)).toBe(2); // negative skew wraps → 200 → f2
    // The duplicate tail (index 3) is never reached while looping.
    for (let t = 0; t < 300; t += 1) {
      expect(frameIndexAt(baked, t)).not.toBe(3);
    }
  });

  it("FREEZES on the last frame past the end when loop=false (one-shot anim)", () => {
    // A non-looping anim (attack/cast/hurt/die) must hold its final frame instead of replaying — the fix for
    // the perpetual-replay flicker (e.g. Regent's weapons stuck looping "attack" at a 800s+ track time).
    expect(frameIndexAt(clip, 250, false)).toBe(2); // within range → covering frame
    expect(frameIndexAt(clip, 300, false)).toBe(2); // AT the end → last frame (NOT wrapped to 0)
    expect(frameIndexAt(clip, 999999, false)).toBe(2); // long past the end → still the last frame
    expect(frameIndexAt(clip, -50, false)).toBe(0); // negative clock skew clamps to the first frame
  });

  it("returns 0 for a single-frame clip", () => {
    const single = parseSpineClip(
      buildClipBlob([{ index: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 33, png: [1] }], 2, 2)
    );
    expect(frameIndexAt(single, 9999)).toBe(0);
  });
});

// M3 — THE HONEST SPINE DEADLINE. `msToNextSpineFrame` is the scheduler's twin of `frameIndexAt`: it must answer
// exactly when that function's answer would change, on the same period and the same clamp, or the canvas stage
// would wake for a frame that has not moved (or show one late). The clip client bakes at 15fps.
describe("spineClip — msToNextSpineFrame", () => {
  /** The REAL baked shape: 3 distinct frames @ 100ms plus the duplicate tail clamped to t=duration. */
  const baked = parseSpineClip(
    buildClipBlob(
      [
        { index: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [0] },
        { index: 1, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [1] },
        { index: 2, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [2] },
        { index: 3, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 100, png: [3] } // duplicate tail
      ],
      4,
      4
    )
  );

  it("answers the time to the next frame boundary while looping", () => {
    expect(msToNextSpineFrame(baked, 0)).toBe(100);
    expect(msToNextSpineFrame(baked, 40)).toBe(60);
    expect(msToNextSpineFrame(baked, 100)).toBe(100);
    expect(msToNextSpineFrame(baked, 199)).toBe(1);
  });

  it("uses the loop boundary as a frame deadline", () => {
    // The last REACHABLE frame is f2 (200..300). Its next boundary is the wrap back to f0 at the period (300),
    // never the endpoint sample.
    expect(msToNextSpineFrame(baked, 200)).toBe(100);
    expect(msToNextSpineFrame(baked, 250)).toBe(50);
    expect(msToNextSpineFrame(baked, 300)).toBe(100); // 300 % 300 = 0 → back at f0
    expect(msToNextSpineFrame(baked, 450)).toBe(50);
    expect(msToNextSpineFrame(baked, -50)).toBe(50); // negative clock skew wraps positive, like frameIndexAt
  });

  it("agrees with frameIndexAt at every millisecond of a period — the property, not a sample", () => {
    // THE INVARIANT: sleeping exactly this long must land on a DIFFERENT frame, and one millisecond less must not.
    for (let t = 0; t < 300; t++) {
      const ms = msToNextSpineFrame(baked, t);
      expect(ms).toBeGreaterThan(0);
      expect(frameIndexAt(baked, t + ms)).not.toBe(frameIndexAt(baked, t));
      if (ms > 1) {
        expect(frameIndexAt(baked, t + ms - 1)).toBe(frameIndexAt(baked, t));
      }
    }
  });

  it("answers Infinity for a CLAMPED one-shot that has run out — a landed attack stops asking", () => {
    // The pre-M3 stage kept repainting at the display's rate for the rest of the screen because a one-shot is
    // still "playing": it has more than one frame and is not paused. It just has no next frame.
    expect(msToNextSpineFrame(baked, 0, false)).toBe(100);
    expect(msToNextSpineFrame(baked, 250, false)).toBe(50); // still inside the clip
    expect(msToNextSpineFrame(baked, 300, false)).toBe(Number.POSITIVE_INFINITY);
    expect(msToNextSpineFrame(baked, 999999, false)).toBe(Number.POSITIVE_INFINITY);
  });

  it("answers Infinity for a STILL — the product default on every non-dev device", () => {
    const single = parseSpineClip(
      buildClipBlob([{ index: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 66, png: [1] }], 2, 2)
    );
    expect(msToNextSpineFrame(single, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(msToNextSpineFrame(single, 9999, false)).toBe(Number.POSITIVE_INFINITY);
  });

});

describe("spineClipRoute", () => {
  it("builds /spines/<scene>?node=&anim= from a res:// scene + node + anim", () => {
    expect(spineClipRoute("res://scenes/merchant/characters/ironclad_merchant.tscn", "Visuals/SpineSprite", "idle_loop")).toBe(
      "/spines/scenes/merchant/characters/ironclad_merchant.tscn?node=Visuals%2FSpineSprite&anim=idle_loop"
    );
  });

  it("omits node when null", () => {
    expect(spineClipRoute("res://scenes/backgrounds/main_menu_bg.tscn", null, "animation")).toBe(
      "/spines/scenes/backgrounds/main_menu_bg.tscn?anim=animation"
    );
  });
});

describe("sceneTree — spine fields", () => {
  function spineDelta(full: boolean, upsert: Record<string, unknown>) {
    return parseSceneDelta({ type: "scene-delta", full, screenType: "run", upserts: [upsert], removedIds: [], orderedIds: ["7"] })!;
  }

  it("normalizes the static spine block + volatile anim/track", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      spineDelta(true, {
        id: "7",
        name: "SpineSprite",
        nodeType: "SpineSprite",
        spine: {
          sceneResPath: "res://scenes/merchant/characters/ironclad_merchant.tscn",
          nodePath: "Visuals/SpineSprite",
          animations: ["idle_loop", "attack"],
          skelResPath: "res://models/ironclad.skel.tres"
        },
        spineCurrentAnim: "idle_loop",
        spineSkin: "default",
        spineTrackTime: 0.5
      })
    );
    const node = state.nodes.get("7")!;
    expect(node.spineSceneResPath).toBe("res://scenes/merchant/characters/ironclad_merchant.tscn");
    expect(node.spineNodePath).toBe("Visuals/SpineSprite");
    expect(node.spineAnimations).toEqual(["idle_loop", "attack"]);
    expect(node.spineSkelResPath).toBe("res://models/ironclad.skel.tres");
    expect(node.spineCurrentAnim).toBe("idle_loop");
    expect(node.spineSkin).toBe("default");
    expect(node.spineTrackTime).toBeCloseTo(0.5);
  });

  it("retains the static spine block across a volatile-only upsert while anim/track update", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      spineDelta(true, {
        id: "7",
        name: "SpineSprite",
        nodeType: "SpineSprite",
        spine: {
          sceneResPath: "res://scenes/merchant/characters/ironclad_merchant.tscn",
          nodePath: "Visuals/SpineSprite",
          animations: ["idle_loop", "attack"],
          skelResPath: "res://models/ironclad.skel.tres"
        },
        spineCurrentAnim: "idle_loop",
        spineSkin: "default",
        spineTrackTime: 0.5
      })
    );
    // Volatile-only upsert: no name, no spine block, a new anim + new skin (the game switched idle→attack, re-skinned).
    applySceneDelta(state, spineDelta(false, { id: "7", spineCurrentAnim: "attack", spineSkin: "poisoned", spineTrackTime: 0.1 }));
    const node = state.nodes.get("7")!;
    expect(node.spineSceneResPath).toBe("res://scenes/merchant/characters/ironclad_merchant.tscn");
    expect(node.spineAnimations).toEqual(["idle_loop", "attack"]);
    // The STATIC skeleton path is retained across the volatile-only upsert; the VOLATILE skin/anim update.
    expect(node.spineSkelResPath).toBe("res://models/ironclad.skel.tres");
    expect(node.spineCurrentAnim).toBe("attack");
    expect(node.spineSkin).toBe("poisoned");
    expect(node.spineTrackTime).toBeCloseTo(0.1);
  });

  it("leaves spine fields null for a non-SpineSprite node", () => {
    const state = createMirrorState();
    applySceneDelta(state, spineDelta(true, { id: "7", name: "Card", nodeType: "NinePatchRect" }));
    const node = state.nodes.get("7")!;
    expect(node.spineSceneResPath).toBeNull();
    expect(node.spineAnimations).toBeNull();
    expect(node.spineCurrentAnim).toBeNull();
  });
});

describe("quality — spine clip fetch-or-flat gate", () => {
  const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };
  function signals(overrides: Partial<RenderQualitySignals> = {}): RenderQualitySignals {
    return { search: "", gpu: UNKNOWN_GPU, ...overrides };
  }

  it("enables clips on high/low, disables on min/static/off (protect weak-device wifi)", () => {
    expect(resolveRenderQuality(signals({ search: "?quality=high" })).spineClipsEnabled).toBe(true);
    expect(resolveRenderQuality(signals({ search: "?quality=low" })).spineClipsEnabled).toBe(true);
    expect(resolveRenderQuality(signals({ search: "?quality=min" })).spineClipsEnabled).toBe(false);
    expect(resolveRenderQuality(signals({ search: "?quality=static" })).spineClipsEnabled).toBe(false);
    expect(resolveRenderQuality(signals({ search: "?quality=off" })).spineClipsEnabled).toBe(false);
  });

  it("honors ?spineClips + ?spineClipFps overrides on top of the tier", () => {
    expect(resolveRenderQuality(signals({ search: "?quality=min&spineClips=on" })).spineClipsEnabled).toBe(true);
    expect(resolveRenderQuality(signals({ search: "?quality=high&spineClips=off" })).spineClipsEnabled).toBe(false);
    expect(resolveRenderQuality(signals({ search: "?quality=high&spineClipFps=12" })).spineClipFps).toBe(12);
  });
});

describe("spineClip cache — eviction never closes a clip the renderer is still painting", () => {
  // One tiny 1-frame clip's bytes, reused for every url (the parse is covered above; this is about lifetime).
  const blob = buildClipBlob([{ index: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 33, png: [1] }], 1, 1);

  function stubDecode(): { closes: () => number } {
    let closed = 0;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        close() {
          closed += 1;
        }
      }))
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => blob.slice(0) }) as unknown as Response)
    );
    return { closes: () => closed };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    __clearSpineClipCacheForTest();
  });

  // The still-first chain adds two entries per playing node, so retained clips must remain usable after eviction.
  it("keeps a RETAINED clip's bitmaps alive past eviction, and closes them on release", async () => {
    const { closes } = stubDecode();
    __clearSpineClipCacheForTest();

    const painting = await loadSpineClip("/spines/painting");
    painting.retain(); // what the renderer does when it assigns record.spineClip

    // Push the cache (24 entries) past its bound so the retained clip is the evicted LRU victim.
    for (let i = 0; i < 24; i += 1) {
      await loadSpineClip(`/spines/filler-${i}`);
    }

    expect(closes()).toBe(0); // evicted, but still referenced → NOT closed

    painting.release();
    expect(closes()).toBe(1); // last reference gone → now it frees
  });

  // …while an evicted clip nothing is painting still frees PROMPTLY (the refcount must not turn the cache into a
  // leak on a low-end device).
  it("closes an UNREFERENCED clip's bitmaps as soon as it is evicted", async () => {
    const { closes } = stubDecode();
    __clearSpineClipCacheForTest();

    await loadSpineClip("/spines/orphan");
    for (let i = 0; i < 24; i += 1) {
      await loadSpineClip(`/spines/filler-${i}`);
    }

    expect(closes()).toBe(1);
  });
});

// The host can answer a full-clip request with a single-frame stand-in while the machine is
// oversubscribed, and says so with `X-Spine-Degraded`. The decoded clip must carry that through, because it is what
// stops the renderer from re-requesting the expensive bake (see mirrorRenderer's escalation guard).
describe("spineClip degraded marker", () => {
  const blob = buildClipBlob([{ index: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 33, png: [1] }], 1, 1);

  function stubFetch(headerValue: string | null): void {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close() {} })));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            headers: { get: (name: string) => (name.toLowerCase() === "x-spine-degraded" ? headerValue : null) },
            arrayBuffer: async () => blob.slice(0)
          }) as unknown as Response
      )
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    __clearSpineClipCacheForTest();
  });

  it("reads X-Spine-Degraded: 1 onto the loaded clip", async () => {
    stubFetch("1");
    __clearSpineClipCacheForTest();
    expect((await loadSpineClip("/spines/degraded")).degraded).toBe(true);
  });

  it("leaves an ordinary response undegraded (absent header, and an explicit 0)", async () => {
    stubFetch(null);
    __clearSpineClipCacheForTest();
    expect((await loadSpineClip("/spines/normal")).degraded).toBe(false);

    stubFetch("0");
    __clearSpineClipCacheForTest();
    expect((await loadSpineClip("/spines/normal-zero")).degraded).toBe(false);
  });
});

// A still painted with an <img> needs its encoded bytes and object URL, not a decoded ImageBitmap. The separate
// pool keeps those cheap entries warm without displacing decoded clips.
describe("spineClip — encoded-bytes-only stills and split LRU pools", () => {
  const stillBlob = buildClipBlob([{ index: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 33, png: [1] }], 1, 1);
  const clipBlob = buildClipBlob(
    [
      { index: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 33, png: [1] },
      { index: 1, offsetX: 0, offsetY: 0, width: 1, height: 1, durationMs: 33, png: [2] }
    ],
    1,
    1
  );

  function stub(blobFor: (url: string) => ArrayBuffer): { bitmaps: () => number; closes: () => number } {
    let made = 0;
    let closed = 0;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        made += 1;
        return {
          close() {
            closed += 1;
          }
        };
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: true, arrayBuffer: async () => blobFor(url).slice(0) }) as unknown as Response)
    );
    return { bitmaps: () => made, closes: () => closed };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    __clearSpineClipCacheForTest();
  });

  it("skips the dead-weight ImageBitmap for a 1-frame clip the caller will paint as an <img>", async () => {
    const { bitmaps } = stub((url) => (url.includes("animated") ? clipBlob : stillBlob));
    __clearSpineClipCacheForTest();

    const still = await loadSpineClip("/spines/still", { stillImg: true });
    expect(bitmaps()).toBe(0);
    expect(still.frames[0].bitmap).toBeNull(); // advanceSpine's `!frame.bitmap` guard covers this
    expect(still.stillUrl).not.toBeNull(); // …because the ENCODED bytes are what the <img> paints

    // A caller that did not ask still decodes.
    const canvasStill = await loadSpineClip("/spines/still-canvas");
    expect(bitmaps()).toBe(1);
    expect(canvasStill.frames[0].bitmap).not.toBeNull();

    // …and a MULTI-frame answer ignores the hint entirely: every frame is blitted, so every frame is decoded.
    const animated = await loadSpineClip("/spines/animated", { stillImg: true });
    expect(bitmaps()).toBe(3);
    expect(animated.frames.every((f) => f.bitmap !== null)).toBe(true);

  });

  it("keeps 64 bytes-only stills warm while the expensive clips stay on the 24 bound", async () => {
    stub((url) => (url.includes("animated") ? clipBlob : stillBlob));
    __clearSpineClipCacheForTest();

    const first = await loadSpineClip("/spines/still-0", { stillImg: true });
    // 40 more stills + a full 24 animated clips: well past the old single 24-entry bound…
    for (let i = 1; i <= 40; i += 1) {
      await loadSpineClip(`/spines/still-${i}`, { stillImg: true });
    }
    for (let i = 0; i < 24; i += 1) {
      await loadSpineClip(`/spines/animated-${i}`);
    }
    // …yet the very first still is still cached (same object back, no re-fetch): an A→B→A animation flip stays warm.
    expect(await loadSpineClip("/spines/still-0", { stillImg: true })).toBe(first);

    // Past 64 stills the pool does turn over, oldest first.
    for (let i = 41; i <= 70; i += 1) {
      await loadSpineClip(`/spines/still-${i}`, { stillImg: true });
    }
    expect(await loadSpineClip("/spines/still-1", { stillImg: true })).not.toBe(first);
  });

  it("evicts the CLIP pool without touching the stills", async () => {
    const { closes } = stub((url) => (url.includes("animated") ? clipBlob : stillBlob));
    __clearSpineClipCacheForTest();

    const warmStill = await loadSpineClip("/spines/still-warm", { stillImg: true });
    const doomed = await loadSpineClip("/spines/animated-doomed");
    for (let i = 0; i < 24; i += 1) {
      await loadSpineClip(`/spines/animated-${i}`);
    }
    expect(closes()).toBe(2); // the oldest animated clip's two frames — the still beside it is untouched
    expect(await loadSpineClip("/spines/still-warm", { stillImg: true })).toBe(warmStill);
    expect(await loadSpineClip("/spines/animated-doomed")).not.toBe(doomed);
  });
});
