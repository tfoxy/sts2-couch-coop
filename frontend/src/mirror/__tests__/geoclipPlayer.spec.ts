import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __clearGeoclipProbesForTest,
  applyGeoclipVerts,
  createGeoclipNode,
  deriveGeoclipFit,
  foldGeoclipUvs,
  geoclipFrameIndexAt,
  geoclipPlacementFromManifest,
  parseGeoclipManifest,
  probeGeoclip,
  uploadGeoclip,
  type GpuClip
} from "@/mirror/geoclipPlayer";
import { mirrorWalkStats } from "@/mirror/renderer/walkStats";
import { asPresentationPackedGeoclip } from "@/mirror/geoclipManifest";
import { parseGeoclip } from "@spirectl/presentation/spine";
import { geoclipUrl } from "@/mirror/spineAttributes";
import type { MirrorNode } from "@/mirror/sceneTree";

// The PURE half of packed geoclip playback: decode, clock, coordinate mapping, and probe cache.

const fileUrl = (file: string): string => `/geoclips/scenes/x.tscn?anim=idle&file=${file}`;

// A two-vertex-triangle part is enough for every decode assertion; the renderer never sees these numbers.
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { schema: "geoclip/1", anim: "idle_loop", fps: 30, frameCount: 2, durationMs: 66 },
    pages: [{ id: "p0", file: "page-0.png", width: 64, height: 32 }],
    parts: [
      {
        id: "torso",
        slotIndex: 3,
        attachmentName: "torso",
        pageId: "p0",
        srcRect: [16, 8, 32, 16],
        indices: [0, 1, 2],
        uvs: [0, 0, 1, 0, 1, 1],
        refVerts: [0, 0, 10, 0, 10, 10],
        rigid: true,
        blendMode: 0
      }
    ],
    frames: [
      {
        t: 0,
        drawOrder: [3],
        slots: { "3": { part: "torso", color: [1, 1, 1, 1], xform: [1, 0, 0, 1, 5, 7] } }
      },
      {
        t: 0.033,
        drawOrder: [3],
        slots: { "3": { part: "torso", color: [1, 1, 1, 0.5], vref: 0 } }
      }
    ],
    vertsBin: { file: "verts.bin", records: 1, offsets: [0], quant: { torso: [0, 0, 10, 10] } },
    ...overrides
  };
}

afterEach(() => {
  __clearGeoclipProbesForTest();
  vi.unstubAllGlobals();
});

describe("parseGeoclipManifest (geoclip/1)", () => {
  it("adapts Couch's packed wire schema before calling the presentation parser", () => {
    const raw = manifest();
    expect(parseGeoclip(raw, (file) => ({ uri: file })).ok).toBe(false);
    const adapted = asPresentationPackedGeoclip(raw);
    expect(adapted).not.toBeNull();
    expect(parseGeoclip(adapted!, (file) => ({ uri: file })).ok).toBe(true);
    expect(parseGeoclipManifest(raw, fileUrl).schema).toBe("geoclip/1");
  });

  it("decodes pages, parts and both kinds of frame slot", () => {
    const clip = parseGeoclipManifest(manifest(), fileUrl);
    expect(clip.schema).toBe("geoclip/1");
    expect(clip.fps).toBe(30);
    expect(clip.pages).toEqual([{ id: "p0", file: "page-0.png", width: 64, height: 32 }]);
    const part = clip.parts.get("torso")!;
    expect(part.srcRect).toEqual([16, 8, 32, 16]);
    expect(Array.from(part.refVerts)).toEqual([0, 0, 10, 0, 10, 10]);
    expect(clip.frames[0].slots.get(3)!.xform).toEqual([1, 0, 0, 1, 5, 7]);
    expect(clip.frames[1].slots.get(3)!.vref).toBe(0);
  });

  // THE CLIENT NEVER SPELLS A PAGE'S EXTENSION. The host mints a page's name from the hash of its own bytes, and
  // since the baker started copying an already-lossless WebP out of the imported texture instead of re-encoding a
  // PNG, that name may end in `.webp`. Nothing here parses, validates or reconstructs the extension: `pages[].file`
  // is carried through verbatim into the artifact URL and handed to the browser, which decodes WebP natively. This
  // pins that — a `.png` assumption creeping in anywhere would break every webp-paged rig with no host-side signal.
  it("carries a page's file name through verbatim, whatever container the host named it in", () => {
    const clip = parseGeoclipManifest(
      manifest({ pages: [{ id: "p0", file: "page-a3f0c1d2e3f40567.webp", width: 64, height: 32 }] }),
      fileUrl
    );
    expect(clip.pages).toEqual([{ id: "p0", file: "page-a3f0c1d2e3f40567.webp", width: 64, height: 32 }]);
    expect(clip.fileUrl(clip.pages[0].file)).toBe(
      "/geoclips/scenes/x.tscn?anim=idle&file=page-a3f0c1d2e3f40567.webp"
    );
  });

  it("tolerates unknown fields at every level (the contract says additive keys are safe)", () => {
    const doc = manifest();
    (doc.meta as Record<string, unknown>).bake = { bakerVersion: "spine-geoclip-baker/2" };
    (doc.parts as Record<string, unknown>[])[0].futureKey = 1;
    (doc.frames as Record<string, unknown>[])[0].alsoNew = "x";
    expect(() => parseGeoclipManifest(doc, fileUrl)).not.toThrow();
  });

  it("keeps an explicit `part: null` as a hidden slot rather than dropping the slot", () => {
    const doc = manifest();
    (doc.frames as { slots: Record<string, unknown> }[])[0].slots = { "3": { part: null } };
    const clip = parseGeoclipManifest(doc, fileUrl);
    expect(clip.frames[0].slots.has(3)).toBe(true);
    expect(clip.frames[0].slots.get(3)!.part).toBeNull();
  });

  it("falls back to ascending slot order when a frame carries no drawOrder", () => {
    const doc = manifest();
    doc.frames = [{ slots: { "9": { part: "torso" }, "2": { part: "torso" } } }];
    // The fixture replaces the 2-frame array with a 1-frame one, so its declared count has to follow: a manifest
    // whose `meta.frameCount` disagrees with `frames` is now refused as truncated (see the case below).
    (doc.meta as Record<string, unknown>).frameCount = 1;
    const clip = parseGeoclipManifest(doc, fileUrl);
    expect(clip.frames[0].drawOrder).toBeNull();
    expect([...clip.frames[0].slots.keys()].sort((a, b) => a - b)).toEqual([2, 9]);
  });

  it("refuses a document that is not a geoclip at all", () => {
    expect(() => parseGeoclipManifest({ meta: { schema: "spineclip/1" } }, fileUrl)).toThrow(/packed/);
    expect(() => parseGeoclipManifest(null, fileUrl)).toThrow();
  });

  // A TRUNCATED artifact is the one malformation the tolerance rules must not absorb: `meta.frameCount` is the
  // manifest's own checksum over `frames`, and a clip declaring 61 and carrying 40 used to play as an ordinary
  // 40-frame animation — a third of a creature missing, with nothing anywhere saying so. The strict decoder in
  // `@spirectl/presentation` refuses exactly this; these pin that the two now agree.
  it("refuses a manifest that declares more frames than it carries", () => {
    const doc = manifest();
    (doc.meta as Record<string, unknown>).frameCount = 61;
    expect(() => parseGeoclipManifest(doc, fileUrl)).toThrow(/declares 61 frames but carries 2/);
  });

  it("refuses one that declares FEWER, too — a mismatch either way is not the clip it claims to be", () => {
    const doc = manifest();
    (doc.meta as Record<string, unknown>).frameCount = 1;
    expect(() => parseGeoclipManifest(doc, fileUrl)).toThrow(/frames/);
  });

  // …and the tolerance the check must not break. The parser defaults an ABSENT count to the array's own length, so
  // every pre-Phase-4 artifact in the wild that never stated one keeps loading; a stringified count is a shape
  // change rather than a value (`parseManifestPlacement`'s rule) and is likewise not treated as a declaration.
  it("still loads a manifest that declares NO frame count, and one whose count is not a number", () => {
    const absent = manifest();
    delete (absent.meta as Record<string, unknown>).frameCount;
    expect(parseGeoclipManifest(absent, fileUrl).frameCount).toBe(2);

    const stringly = manifest();
    (stringly.meta as Record<string, unknown>).frameCount = "2";
    expect(() => parseGeoclipManifest(stringly, fileUrl)).not.toThrow();
  });

  it("reverts the node to raster rather than drawing a fragment (the throw is caught by probeGeoclip)", async () => {
    const doc = manifest();
    (doc.meta as Record<string, unknown>).frameCount = 61;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => doc }));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(probeGeoclip("/geoclips/truncated?file=manifest.json", fileUrl)).resolves.toBeNull();
    // Named once on the failure channel — a broken artifact is worth the line an ordinary 404 does not get.
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("declares 61 frames but carries 2");
    info.mockRestore();
  });
});

describe("applyGeoclipVerts (packed geoclip/1)", () => {
  // The frozen contract: record i starts at offsets[i] and holds vertCount*2 little-endian u16s, interleaved
  // x,y; `x = minX + q*(maxX-minX)/65535` against the part's own bbox over the whole clip.
  function v2(): { doc: Record<string, unknown>; bin: ArrayBuffer } {
    const doc = manifest({
      meta: { schema: "geoclip/1", anim: "idle_loop", fps: 30, frameCount: 1, durationMs: 33 },
      pages: [{ id: "p0", file: "sheet-0.png", width: 64, height: 32 }],
      frames: [{ slots: { "3": { part: "torso", vref: 0 } } }],
      vertsBin: {
        file: "verts.bin",
        records: 1,
        offsets: [0],
        quant: { torso: [-10, -20, 10, 20] }
      }
    });
    // 3 vertices: (min, min), (mid, mid), (max, max).
    const values = [0, 0, 32768, 32768, 65535, 65535];
    const bin = new ArrayBuffer(values.length * 2);
    const view = new DataView(bin);
    values.forEach((value, i) => view.setUint16(i * 2, value, true));
    return { doc, bin };
  }

  it("dequantizes a packed record into the playable in-memory shape", () => {
    const { doc, bin } = v2();
    const clip = parseGeoclipManifest(doc, fileUrl);
    expect(clip.frames[0].slots.get(3)!.verts).toBeNull();
    applyGeoclipVerts(clip, bin);
    const verts = clip.frames[0].slots.get(3)!.verts!;
    expect(verts.length).toBe(6);
    expect(verts[0]).toBeCloseTo(-10, 5);
    expect(verts[1]).toBeCloseTo(-20, 5);
    expect(verts[4]).toBeCloseTo(10, 5);
    expect(verts[5]).toBeCloseTo(20, 5);
  });

  it("keeps the quantisation error under range/65535 (the contract's subpixel bound)", () => {
    const { doc, bin } = v2();
    const clip = parseGeoclipManifest(doc, fileUrl);
    applyGeoclipVerts(clip, bin);
    const verts = clip.frames[0].slots.get(3)!.verts!;
    // The mid sample is 32768/65535 of a 20-unit range from -10.
    expect(Math.abs(verts[2] - (-10 + 20 * (32768 / 65535)))).toBeLessThan(20 / 65535);
    expect(Math.abs(verts[3] - (-20 + 40 * (32768 / 65535)))).toBeLessThan(40 / 65535);
  });

  it("skips a truncated record instead of throwing (the slot falls back to its xform)", () => {
    const { doc } = v2();
    const clip = parseGeoclipManifest(doc, fileUrl);
    applyGeoclipVerts(clip, new ArrayBuffer(4)); // one vertex' worth, for a 3-vertex part
    expect(clip.frames[0].slots.get(3)!.verts).toBeNull();
  });

  it("skips a part with no quantisation box", () => {
    const { doc, bin } = v2();
    (doc.vertsBin as { quant: Record<string, unknown> }).quant = {};
    const clip = parseGeoclipManifest(doc, fileUrl);
    applyGeoclipVerts(clip, bin);
    expect(clip.frames[0].slots.get(3)!.verts).toBeNull();
  });

  it("rejects an unpacked manifest", () => {
    const doc = manifest();
    delete doc.vertsBin;
    expect(() => parseGeoclipManifest(doc, fileUrl)).toThrow(/packed/);
  });

  // A part that never moves on an axis quantizes to a ZERO range, which the encoder writes as q=0. Dequantising
  // that must answer `min` rather than NaN — hence the multiply-by-span form instead of a divide.
  it("dequantizes a degenerate (min == max) range back to the constant, never NaN", () => {
    const { doc, bin } = v2();
    (doc.vertsBin as { quant: Record<string, number[]> }).quant = { torso: [7, -3, 7, -3] };
    const clip = parseGeoclipManifest(doc, fileUrl);
    applyGeoclipVerts(clip, bin);
    const verts = clip.frames[0].slots.get(3)!.verts!;
    expect(Array.from(verts)).toEqual([7, -3, 7, -3, 7, -3]);
    expect(verts.some((value) => Number.isNaN(value))).toBe(false);
  });

  it("rejects inline vertices", () => {
    const { doc } = v2();
    (doc.frames as { slots: Record<string, unknown> }[])[0].slots = {
      "3": { part: "torso", verts: [1, 2, 3, 4] } // wrong length for a 3-vertex part; kept, not vref'd
    };
    expect(() => parseGeoclipManifest(doc, fileUrl)).toThrow(/packed/);
  });

  // Page ids are integers in a real bake and strings in the synthetic fixture; part ids are integers too. The
  // decoder stringifies BOTH sides of every id comparison so the two shapes address the same maps.
  it("matches numeric page ids and numeric part ids against their string forms", () => {
    const doc = manifest({
      meta: { schema: "geoclip/1", fps: 30, frameCount: 1 },
      pages: [{ id: 0, file: "sheet-0.png", width: 34, height: 106 }],
      parts: [
        {
          id: 20,
          pageId: 0,
          srcRect: [1, 1, 32, 104],
          indices: [0, 1, 2],
          uvs: [0, 0, 1, 0, 1, 1],
          refVerts: [0, 0, 1, 0, 1, 1]
        }
      ],
      frames: [{ slots: { "3": { part: 20, vref: 0 } } }],
      vertsBin: { file: "verts.bin", records: 1, offsets: [0], quant: { "20": [0, 0, 10, 10] } }
    });
    const bin = new ArrayBuffer(12);
    const view = new DataView(bin);
    for (let i = 0; i < 6; i++) {
      view.setUint16(i * 2, 65535, true);
    }
    const clip = parseGeoclipManifest(doc, fileUrl);
    expect(clip.parts.get("20")!.pageId).toBe("0");
    expect(clip.pages[0].id).toBe("0");
    applyGeoclipVerts(clip, bin);
    expect(Array.from(clip.frames[0].slots.get(3)!.verts!)).toEqual([10, 10, 10, 10, 10, 10]);
  });
});

describe("geoclipFrameIndexAt", () => {
  // A REAL bake's shape: the baker's frame times are endpoint-inclusive, so 61 frames at 30fps cover [0, 2000]ms
  // and `durationMs == (frameCount - 1) / fps * 1000` exactly. Frame 60 duplicates frame 0 (measured max |delta|
  // 0.000 on the shipped ironclad_merchant idle_loop), which is why the loop must wrap over 60, not 61.
  const clip = { frames: new Array(61).fill(null), fps: 30, durationMs: 2000 };

  it("maps playback ms onto a uniformly-spaced frame grid", () => {
    expect(geoclipFrameIndexAt(clip, 0)).toBe(0);
    expect(geoclipFrameIndexAt(clip, 33)).toBe(0);
    expect(geoclipFrameIndexAt(clip, 34)).toBe(1);
    expect(geoclipFrameIndexAt(clip, 1000)).toBe(30);
  });

  it("wraps a looping clip over durationMs, keeping the endpoint sample out of the loop", () => {
    expect(geoclipFrameIndexAt(clip, 1967, true)).toBe(59); // last REACHABLE frame
    expect(geoclipFrameIndexAt(clip, 2000, true)).toBe(0); // wraps 59 -> 0, no doubled frame-0 slot
    expect(geoclipFrameIndexAt(clip, 2034, true)).toBe(1);
    expect(geoclipFrameIndexAt(clip, 4000, true)).toBe(0); // and again a whole period later
    expect(geoclipFrameIndexAt(clip, -33, true)).toBe(59); // negative clock skew wraps positive
    // Every index across a wrap is distinct: no frame is shown twice in a row. Sampled at each slot's MIDPOINT so
    // the assertion is about the wrap, not about float equality at a frame boundary.
    const seq: number[] = [];
    for (let i = 57; i <= 62; i++) {
      seq.push(geoclipFrameIndexAt(clip, ((i + 0.5) * 1000) / 30, true));
    }
    expect(seq).toEqual([57, 58, 59, 0, 1, 2]);
  });

  it("clamps a one-shot to its TRUE last frame forever", () => {
    expect(geoclipFrameIndexAt(clip, 2000, false)).toBe(60);
    expect(geoclipFrameIndexAt(clip, 999999, false)).toBe(60); // holds, never replays
    expect(geoclipFrameIndexAt(clip, -33, false)).toBe(0);
  });

  it("falls back to count - 1 when the manifest carries no usable durationMs", () => {
    const noDuration = { frames: new Array(61).fill(null), fps: 30 };
    expect(geoclipFrameIndexAt(noDuration, 2000, true)).toBe(0);
    expect(geoclipFrameIndexAt(noDuration, 1967, true)).toBe(59);
    expect(geoclipFrameIndexAt({ ...noDuration, durationMs: 0 }, 2000, true)).toBe(0);
    expect(geoclipFrameIndexAt({ ...noDuration, durationMs: Number.NaN }, 2000, true)).toBe(0);
  });

  it("clamps a malformed period into [1, count] rather than dividing by zero", () => {
    const short = { frames: new Array(5).fill(null), fps: 30, durationMs: 999999 };
    expect(geoclipFrameIndexAt(short, 1000, true)).toBe(0); // period clamped to 5, not 30000
    const tiny = { frames: new Array(5).fill(null), fps: 30, durationMs: 1 };
    expect(geoclipFrameIndexAt(tiny, 1000, true)).toBe(0); // period clamped up to 1, no % 0
  });

  it("answers frame 0 for a degenerate clip", () => {
    expect(geoclipFrameIndexAt({ frames: [null], fps: 30, durationMs: 0 }, 9999)).toBe(0);
    expect(geoclipFrameIndexAt({ frames: [], fps: 0 }, 9999)).toBe(0);
  });

  it("uses the 30fps fallback for a degenerate fps instead of producing NaN", () => {
    const badFps = { frames: new Array(61).fill(null), fps: 0, durationMs: 2000 };
    expect(geoclipFrameIndexAt(badFps, 2000, true)).toBe(0);
    expect(geoclipFrameIndexAt(badFps, 1967, true)).toBe(59);
    expect(geoclipFrameIndexAt({ frames: new Array(61).fill(null), fps: -30 }, 1000, true)).toBe(30);
  });
});

describe("deriveGeoclipFit", () => {
  // The baked clip places its canvas with `translate(localX, localY) scale(localWidth / canvasWidth)`, so a
  // geoclip's skeleton-local vertex maps into that canvas by the INVERSE of exactly that placement.
  it("inverts the baked clip's own placement", () => {
    const fit = deriveGeoclipFit({ canvasWidth: 500, localX: -600, localY: -1200, localWidth: 1000 });
    expect(fit.scaleX).toBeCloseTo(0.5, 10); // canvasWidth / localWidth
    expect(fit.scaleY).toBeCloseTo(0.5, 10);
    expect(fit.offsetX).toBeCloseTo(300, 10);
    expect(fit.offsetY).toBeCloseTo(600, 10);
  });

  it("round-trips the placement: the node-local origin lands where the canvas transform puts it back", () => {
    const placement = { canvasWidth: 1004, localX: -590.6, localY: -1273.6, localWidth: 994.5 };
    const fit = deriveGeoclipFit(placement);
    const scale = placement.localWidth / placement.canvasWidth;
    for (const skeletonLocal of [0, 123.5, -400]) {
      const canvasPx = skeletonLocal * fit.scaleX + fit.offsetX;
      expect(placement.localX + canvasPx * scale).toBeCloseTo(skeletonLocal, 6);
    }
  });

  it("falls back to scale 1 for a MISSING placement rather than collapsing the clip to a point", () => {
    const fit = deriveGeoclipFit({ canvasWidth: 512, localX: 0, localY: 0, localWidth: 0 });
    expect(fit.scaleX).toBe(1);
    expect(fit.scaleY).toBe(1);
  });

  it("prefers the manifest's own fitScale over inverting the rect", () => {
    // A DELIBERATELY INCONSISTENT pair, so the assertion can only pass by reading `fitScale`: inverting the rect
    // here would answer 4 (canvasWidth / localWidth), not 3.
    const fit = deriveGeoclipFit({ canvasWidth: 400, localX: -10, localY: -20, localWidth: 100, fitScale: 3 });
    expect(fit.scaleX).toBe(3);
    expect(fit.scaleY).toBe(3);
    expect(fit.offsetX).toBeCloseTo(30, 10);
    expect(fit.offsetY).toBeCloseTo(60, 10);
  });

  it("ignores a nonsense fitScale and falls back to the rect inversion", () => {
    for (const fitScale of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      const fit = deriveGeoclipFit({ canvasWidth: 500, localX: -600, localY: -1200, localWidth: 1000, fitScale });
      expect(fit.scaleX).toBeCloseTo(0.5, 10);
      expect(fit.offsetX).toBeCloseTo(300, 10);
    }
  });

  // THE EQUIVALENCE GUARD, and the cheapest possible one against a silent placement regression.
  //
  // The host mints the raster clip's wire placement as `clipPlacement = (-NodePosition / fitScale,
  // cellSize / fitScale)` from the SAME `FrameFromBoundsFitted` the manifest's `meta.placement` is emitted from.
  // So for one identity `localWidth / canvasWidth == 1 / fitScale`, and the two sources must produce the SAME fit:
  // `inverse == fitScale`, and `offsetX == -localX * fitScale == NodePosition.X`. If they ever diverge, a rig with
  // both would jump the instant the manifest gained a placement — visible as a creature standing in the wrong
  // place, with nothing in the diff naming the cause.
  it("agrees EXACTLY with the baked-clip inversion for a rig that has both", () => {
    for (const [fitScale, nodePositionX, nodePositionY, cellW, cellH] of [
      [1, 0, 0, 512, 512],
      [2, -600, -1200, 1004, 2048],
      [0.3405, 123.5, -400.25, 340, 1060]
    ] as const) {
      // The host's own algebra, spelled out rather than assumed.
      const manifest = {
        canvasWidth: cellW,
        canvasHeight: cellH,
        localX: -nodePositionX / fitScale,
        localY: -nodePositionY / fitScale,
        localWidth: cellW / fitScale,
        localHeight: cellH / fitScale,
        fitScale
      };
      const fromManifest = deriveGeoclipFit(manifest);
      const fromBaked = deriveGeoclipFit({
        canvasWidth: manifest.canvasWidth,
        localX: manifest.localX,
        localY: manifest.localY,
        localWidth: manifest.localWidth
      });
      expect(fromManifest.scaleX).toBeCloseTo(fromBaked.scaleX, 9);
      expect(fromManifest.scaleY).toBeCloseTo(fromBaked.scaleY, 9);
      expect(fromManifest.offsetX).toBeCloseTo(fromBaked.offsetX, 6);
      expect(fromManifest.offsetY).toBeCloseTo(fromBaked.offsetY, 6);
      // …and both are the NodePosition the host placed the bake at, which is the number that makes it correct
      // rather than merely self-consistent.
      expect(fromManifest.offsetX).toBeCloseTo(nodePositionX, 6);
      expect(fromManifest.offsetY).toBeCloseTo(nodePositionY, 6);
    }
  });
});

describe("meta.placement", () => {
  const PLACEMENT = {
    canvasWidth: 1004,
    canvasHeight: 2048,
    localX: -590.6,
    localY: -1273.6,
    localWidth: 994.5,
    localHeight: 2028.4,
    fitScale: 1.0096
  };

  function withPlacement(placement: unknown): Record<string, unknown> {
    return manifest({
      meta: { schema: "geoclip/1", anim: "idle_loop", fps: 30, frameCount: 2, durationMs: 66, placement }
    });
  }

  it("reads all seven fields when the bake stated them", () => {
    const clip = parseGeoclipManifest(withPlacement(PLACEMENT), fileUrl);
    expect(clip.placement).toEqual(PLACEMENT);
  });

  it("is null when the manifest carries none (every pre-Phase-4 bake)", () => {
    expect(parseGeoclipManifest(manifest(), fileUrl).placement).toBeNull();
  });

  // TOLERANCE, not validation: a placement that cannot be trusted must leave the clip PLAYABLE on the baked
  // inversion, never throw and never half-apply.
  it("is null — never a throw, never partial — for anything malformed", () => {
    const bad: [string, unknown][] = [
      ["not an object", 7],
      ["an array", [1, 2, 3]],
      ["null", null],
      ["missing fitScale", { ...PLACEMENT, fitScale: undefined }],
      ["missing localHeight", { ...PLACEMENT, localHeight: undefined }],
      ["a stringified number", { ...PLACEMENT, localX: "-590.6" }],
      ["a NaN", { ...PLACEMENT, localWidth: Number.NaN }],
      ["an Infinity", { ...PLACEMENT, fitScale: Number.POSITIVE_INFINITY }],
      ["a zero canvas", { ...PLACEMENT, canvasWidth: 0 }],
      ["a negative canvas height", { ...PLACEMENT, canvasHeight: -8 }]
    ];
    for (const [label, placement] of bad) {
      const clip = parseGeoclipManifest(withPlacement(placement), fileUrl);
      expect(clip.placement, label).toBeNull();
      expect(clip.parts.size, label).toBe(1); // …and the rest of the clip decoded exactly as before
    }
  });

  it("hands the mount a placement carrying the bake's own fitScale — or null, so the caller waits for the baked clip", () => {
    const clip = parseGeoclipManifest(withPlacement(PLACEMENT), fileUrl);
    expect(geoclipPlacementFromManifest(clip)).toEqual({
      canvasWidth: 1004,
      canvasHeight: 2048,
      localX: -590.6,
      localY: -1273.6,
      localWidth: 994.5,
      fitScale: 1.0096
    });
    expect(geoclipPlacementFromManifest(parseGeoclipManifest(manifest(), fileUrl))).toBeNull();
  });
});

describe("foldGeoclipUvs", () => {
  it("folds srcRect-relative uvs into whole-page coordinates against the DECODED page size", () => {
    const clip = parseGeoclipManifest(manifest(), fileUrl);
    const uvs = foldGeoclipUvs(clip.parts.get("torso")!, 64, 32);
    // srcRect = [16, 8, 32, 16] on a 64x32 page: u=0 -> 16/64, u=1 -> 48/64; v=0 -> 8/32, v=1 -> 24/32.
    expect(uvs[0]).toBeCloseTo(0.25, 6);
    expect(uvs[1]).toBeCloseTo(0.25, 6);
    expect(uvs[2]).toBeCloseTo(0.75, 6);
    expect(uvs[5]).toBeCloseTo(0.75, 6);
  });
});

describe("probeGeoclip", () => {
  it("probes a url ONCE, cached miss included", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeGeoclip("/geoclips/a?file=manifest.json", fileUrl)).toBeNull();
    expect(await probeGeoclip("/geoclips/a?file=manifest.json", fileUrl)).toBeNull();
    expect(await probeGeoclip("/geoclips/a?file=manifest.json", fileUrl)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches verts.bin for a v2 manifest and hands back a clip with materialised verts", async () => {
    const doc = manifest({
      meta: { schema: "geoclip/1", fps: 30, frameCount: 1 },
      frames: [{ slots: { "3": { part: "torso", vref: 0 } } }],
      vertsBin: { file: "verts.bin", records: 1, offsets: [0], quant: { torso: [0, 0, 100, 100] } }
    });
    const bin = new ArrayBuffer(12);
    const view = new DataView(bin);
    for (let i = 0; i < 6; i++) {
      view.setUint16(i * 2, 65535, true);
    }
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("verts.bin")
          ? { ok: true, arrayBuffer: () => Promise.resolve(bin) }
          : { ok: true, json: () => Promise.resolve(doc) }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const clip = await probeGeoclip("/geoclips/b?file=manifest.json", fileUrl);
    expect(clip).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Array.from(clip!.frames[0].slots.get(3)!.verts!)).toEqual([100, 100, 100, 100, 100, 100]);
  });

  // packed geoclip/1 always emits a vertsBin block; an all-rigid rig gets `records: 0` and a ZERO-BYTE verts.bin. That
  // must load as an ordinary, playable clip — not as a broken artifact.
  it("loads an all-rigid v2 clip whose verts.bin is empty", async () => {
    const doc = manifest({
      meta: { schema: "geoclip/1", fps: 30, frameCount: 1 },
      frames: [{ slots: { "3": { part: "torso", xform: [1, 0, 0, 1, 0, 0] } } }],
      vertsBin: { file: "verts.bin", records: 0, offsets: [], quant: {} }
    });
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("verts.bin")
          ? { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }
          : { ok: true, json: () => Promise.resolve(doc) }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const clip = await probeGeoclip("/geoclips/rigid?file=manifest.json", fileUrl);
    expect(clip).not.toBeNull();
    expect(clip!.frames[0].slots.get(3)!.xform).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("falls back (null) rather than drawing a rest pose when a v2 manifest's blob is missing", async () => {
    const doc = manifest({
      meta: { schema: "geoclip/1", fps: 30, frameCount: 1 },
      frames: [{ slots: { "3": { part: "torso", vref: 0 } } }],
      vertsBin: { file: "verts.bin", records: 1, offsets: [0], quant: { torso: [0, 0, 1, 1] } }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(url.includes("verts.bin") ? { ok: false, status: 404 } : { ok: true, json: () => Promise.resolve(doc) })
      )
    );
    expect(await probeGeoclip("/geoclips/c?file=manifest.json", fileUrl)).toBeNull();
  });

  it("swallows a malformed manifest into a null (the node stays on the baked clip)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ nope: 1 }) }));
    expect(await probeGeoclip("/geoclips/d?file=manifest.json", fileUrl)).toBeNull();
  });
});

describe("geoclipUrl", () => {
  function spineNode(): MirrorNode {
    return {
      spineSceneResPath: "res://scenes/x.tscn",
      spineNodePath: "Vis/Spine",
      spineCurrentAnim: "idle",
      spineSkin: "poisoned",
      spineMat: "0123456789abcdef"
    } as unknown as MirrorNode;
  }

  it("carries the same readable selectors as the clip route, plus the artifact file", () => {
    expect(geoclipUrl(spineNode(), "manifest.json")).toBe(
      "/geoclips/scenes/x.tscn?node=Vis%2FSpine&anim=idle&file=manifest.json"
    );
    expect(geoclipUrl(spineNode(), "sheet-0.png")).toBe(
      "/geoclips/scenes/x.tscn?node=Vis%2FSpine&anim=idle&file=sheet-0.png"
    );
    // The builder is container-agnostic: it encodes whatever the manifest named, it does not compose a name.
    expect(geoclipUrl(spineNode(), "page-a3f0c1d2e3f40567.webp")).toBe(
      "/geoclips/scenes/x.tscn?node=Vis%2FSpine&anim=idle&file=page-a3f0c1d2e3f40567.webp"
    );
  });

  it("never asks for a still, a skin, a material or a skeleton (a geoclip bake is per scene+node+anim)", () => {
    const url = geoclipUrl(spineNode(), "manifest.json")!;
    expect(url).not.toContain("still");
    expect(url).not.toContain("skin");
    expect(url).not.toContain("mat=");
    expect(url).not.toContain("skel");
  });

  it("answers null for a node that is not a playable spine node", () => {
    expect(geoclipUrl({ spineSceneResPath: null, spineCurrentAnim: "idle" } as unknown as MirrorNode, "manifest.json")).toBeNull();
    expect(
      geoclipUrl({ spineSceneResPath: "res://scenes/x.tscn", spineCurrentAnim: null } as unknown as MirrorNode, "manifest.json")
    ).toBeNull();
  });
});

// --- the bench seams ---------------------------------------------------------------------------------------------
//
// The geoclip lane had no client-side series at all: a bench comparing it against the shipped `/spines/` still could
// state what the HOST spent and nothing about what the browser waited for. These four counters are appended to
// `mirrorWalkStats` (the surface both backends' harnesses already read) and sourced from this module's own funnels,
// so the DOM arm and the canvas arm move the same numbers without either learning about walk stats.

describe("the geoclip bench seams on mirrorWalkStats", () => {
  beforeEach(() => {
    mirrorWalkStats.geoclipProbeMs = 0;
    mirrorWalkStats.geoclipUploadMs = 0;
    mirrorWalkStats.geoclipMounts = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A monotonic `performance.now`, so an elapsed measurement in a suite with no real latency is still non-zero. */
  function tickingClock(stepMs: number): void {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += stepMs));
  }

  it("charges geoclipProbeMs to the request that went out, and nothing to a cached ask", async () => {
    // The per-url probe cache is the reason this must be sampled BELOW the lookup: a second creature playing the
    // same animation issued no request, and charging it ms would make a screen's cost scale with its cast list.
    tickingClock(7);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => manifest() }));

    await probeGeoclip("/geoclips/seam?file=manifest.json", fileUrl);
    const afterFirst = mirrorWalkStats.geoclipProbeMs;
    expect(afterFirst).toBeGreaterThan(0);

    await probeGeoclip("/geoclips/seam?file=manifest.json", fileUrl);
    expect(mirrorWalkStats.geoclipProbeMs).toBe(afterFirst);
  });

  it("charges geoclipUploadMs once per CLIP — an upload that FAILED still cost the device its time", async () => {
    // jsdom has no WebGL2, so this takes `uploadGeoclipOnce`'s null arm. That is the honest thing to measure: a
    // device that spent time discovering it cannot play geoclips spent it, and a lane that only counted successes
    // would report its worst hardware as its fastest.
    tickingClock(5);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const clip = parseGeoclipManifest(manifest(), fileUrl);

    expect(await uploadGeoclip(clip)).toBeNull();
    const afterFirst = mirrorWalkStats.geoclipUploadMs;
    expect(afterFirst).toBeGreaterThan(0);

    await uploadGeoclip(clip); // the per-clip cache, same rule as the probe's
    expect(mirrorWalkStats.geoclipUploadMs).toBe(afterFirst);
  });

  it("counts a MOUNT only where a paint element was really created", () => {
    // jsdom hands back no 2d context, so `createGeoclipNode` takes its null arm and nothing is counted. Only the
    // NEGATIVE half is checkable offline — the positive half needs a real canvas and is what the live bench reads —
    // but it is the half that matters for honesty: `geoclipMounts` is the anti-vacuity counter, and a run that
    // mounted nothing must never be able to report itself as a fast one.
    vi.spyOn(console, "info").mockImplementation(() => {});
    const clip = parseGeoclipManifest(manifest(), fileUrl);
    const placement = { canvasWidth: 10, canvasHeight: 20, localX: 0, localY: 0, localWidth: 10 };

    expect(createGeoclipNode(clip, { parts: new Map() } as GpuClip, placement)).toBeNull();
    expect(mirrorWalkStats.geoclipMounts).toBe(0);
  });

  it("are all reset by mirrorWalkStats.reset(), like every other window counter", () => {
    mirrorWalkStats.geoclipProbeMs = 12;
    mirrorWalkStats.geoclipUploadMs = 34;
    mirrorWalkStats.geoclipMounts = 4;
    mirrorWalkStats.reset();
    expect(mirrorWalkStats.geoclipProbeMs).toBe(0);
    expect(mirrorWalkStats.geoclipUploadMs).toBe(0);
    expect(mirrorWalkStats.geoclipMounts).toBe(0);
  });
});
