import { describe, expect, it, vi } from "vitest";
import type { HbGpuFont, HbGpuShapedGlyph } from "@godot-scene-web/hb-gpu";
import type { MsdfGeneration } from "@godot-scene-web/canvas/msdf-generator";
import { carrierForMsdfRun, createMsdfRuntime, shapeMsdfRun, type MsdfPlacement, type MsdfRunRecord } from "./msdf";

function record(measuredAdvance: number, outline = 0): MsdfRunRecord {
  return { key: "run", insertionIndex: 0, text: "A A", transform: [1, 0, 0, 1, 0, 0],
    style: { fontFamily: "fixture", fontSize: 16, fill: "#ffffff", stroke: { color: "#000000", width: outline } },
    msdf: { url: "/res/fixture.ttf", faceKey: "fixture", measuredAdvance, baselinePx: 18 } } as MsdfRunRecord;
}
function face(glyphs: HbGpuShapedGlyph[]): HbGpuFont {
  return { upem: 1000, shape: () => glyphs, destroy: () => {} } as unknown as HbGpuFont;
}
const glyph = (glyphId: number, xAdvance: number, xOffset = 0, yOffset = 0): HbGpuShapedGlyph =>
  ({ glyphId, cluster: 0, xAdvance, yAdvance: 0, xOffset, yOffset });

describe("MSDF main-thread shaping", () => {
  it("keeps inkless space advance and non-accumulating offsets in the measured run box", () => {
    const result = shapeMsdfRun(record(20), face([
      glyph(4, 500), glyph(3, 250), glyph(4, 500, 100, 50),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.glyphs).toEqual([
      { glyphId: 4, xPx: 0, yPx: 18 },
      { glyphId: 3, xPx: 8, yPx: 18 },
      { glyphId: 4, xPx: 13.6, yPx: 17.2 },
    ]);
    expect(result.run.advancePx).toBe(20);
    expect(result.run.range).toBe(8);
  });

  it("uses the strict measured advance tolerance and refuses missing coverage", () => {
    const shaped = face([glyph(4, 1250)]);
    expect(shapeMsdfRun(record(20.5), shaped).ok).toBe(true); // 0.5 px permitted
    expect(shapeMsdfRun(record(20.51), shaped)).toEqual({ ok: false, reason: "metrics" });
    expect(shapeMsdfRun(record(20), face([glyph(0, 1250)]))).toEqual({ ok: false, reason: "coverage" });
  });

  it("chooses the smallest full range and falls back when outline support is insufficient", () => {
    const shaped = face([glyph(4, 1250)]);
    const mid = shapeMsdfRun(record(20, 4), shaped);
    expect(mid.ok && mid.run.range).toBe(16);
    const wide = shapeMsdfRun(record(20, 10), shaped);
    expect(wide.ok && wide.run.range).toBe(32);
    expect(shapeMsdfRun(record(20, 12), shaped)).toEqual({ ok: false, reason: "range" });
  });

  it("places rich run glyphs at the producer baseline with tint, outline and hard shadow", () => {
    const input = { ...record(20, 2), tint: 0x80ffff };
    input.style.fill = "#ff8040";
    input.style.dropShadow = { color: "#000000", alpha: 0.5, angle: 0, distance: 2, blur: 0 };
    const shaped = shapeMsdfRun(input, face([glyph(4, 1250, 100, 50)]));
    expect(shaped.ok).toBe(true);
    if (!shaped.ok) return;
    const placement: MsdfPlacement = { glyphId: 4, pageKey: "page:g1", pageSize: 1024,
      src: [10, 20, 30, 40], left: -2, top: -10 };
    const carrier = carrierForMsdfRun(input, shaped.run, new Map([[4, placement]]));
    expect(carrier?.glyphs[0].src).toEqual([10, 20, 30, 40]);
    // outline 2 -> strokeHalf 1, added to the pen's x so an MSDF glyph lands at the same ink the Bitmap
    // carrier's strokeHalf-inset raster and the DOM/game both place it at (was 0.9333333333 before the fix).
    expect(carrier?.glyphs[0].dst[0]).toBeCloseTo(1.9333333333);
    expect(carrier?.glyphs[0].dst[1]).toBeCloseTo(13.8666666667);
    expect(carrier?.glyphs[0].dst[2]).toBeCloseTo(10);
    expect(carrier?.glyphs[0].dst[3]).toBeCloseTo(13.3333333333);
    expect(carrier?.outline?.width).toBe(1);
    expect(carrier?.shadow).toEqual({ color: [0, 0, 0, 0.5], offset: [2, 0] });
  });

  it("accepts streamed eight-digit fill and outline colours with an inkless space", () => {
    const input = record(20, 2);
    input.style.fill = "#FFF6E2FF";
    input.style.stroke = { color: "#00000080", width: 2 };
    input.style.dropShadow = { color: "#000000FF", alpha: 0.25, angle: 0, distance: 2, blur: 0 };
    const shaped = shapeMsdfRun(input, face([glyph(4, 500), glyph(3, 250), glyph(4, 500)]));
    expect(shaped.ok).toBe(true);
    if (!shaped.ok) return;
    const carrier = carrierForMsdfRun(input, shaped.run, new Map([
      [4, { glyphId: 4, pageKey: "page:g1", pageSize: 1024,
        src: [10, 20, 30, 40], left: -2, top: -10 }],
      [3, { glyphId: 3, pageKey: "", pageSize: 0,
        src: [0, 0, 0, 0], left: 0, top: 0 }],
    ]));
    expect(carrier?.glyphs).toHaveLength(2);
    const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    expect(carrier?.fill).toEqual([1, linear(246 / 255), linear(226 / 255), 1]);
    expect(carrier?.outline?.color).toEqual([0, 0, 0, 128 / 255]);
    expect(carrier?.shadow?.color).toEqual([0, 0, 0, 0.25]);
  });

  it("tints fill, outline, and shadow in sRGB before linear shader blending", () => {
    const input = { ...record(20, 10), tint: 0xfb927f, alpha: 0.5 };
    input.style.fill = "#FFF6E2FF";
    input.style.stroke = { color: "#363430FF", width: 10 };
    input.style.dropShadow = { color: "#808080", alpha: 0.25, angle: 0, distance: 2, blur: 0 };
    const shaped = shapeMsdfRun(input, face([glyph(4, 1250)]));
    expect(shaped.ok).toBe(true);
    if (!shaped.ok) return;
    const carrier = carrierForMsdfRun(input, shaped.run, new Map([[4,
      { glyphId: 4, pageKey: "page:g1", pageSize: 1024,
        src: [10, 20, 30, 40], left: -2, top: -10 }]]));
    const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    for (const [actual, expected] of [
      [carrier?.fill, [linear(251 / 255), linear(246 / 255 * 146 / 255),
        linear(226 / 255 * 127 / 255), 1]],
      [carrier?.outline?.color, [linear(54 / 255 * 251 / 255),
        linear(52 / 255 * 146 / 255), linear(48 / 255 * 127 / 255), 1]],
      [carrier?.shadow?.color, [linear(128 / 255 * 251 / 255),
        linear(128 / 255 * 146 / 255), linear(128 / 255 * 127 / 255), 0.25]],
    ] as const) {
      expect(actual).toBeDefined();
      expected.forEach((value, index) => expect(actual?.[index]).toBeCloseTo(value));
    }
    expect(carrier?.alpha).toBe(0.5);
  });

  it("refuses a run split across atlas pages rather than silently dropping a glyph", () => {
    const input = record(20);
    const shaped = shapeMsdfRun(input, face([glyph(4, 625), glyph(5, 625)]));
    expect(shaped.ok).toBe(true);
    if (!shaped.ok) return;
    const placement = (glyphId: number, pageKey: string): MsdfPlacement =>
      ({ glyphId, pageKey, pageSize: 1024, src: [0, 0, 16, 16], left: 0, top: -12 });
    expect(carrierForMsdfRun(input, shaped.run, new Map([
      [4, placement(4, "page:a")], [5, placement(5, "page:b")],
    ]))).toBeNull();
  });

  it("keeps Bitmap eligible before font/glyph completion and returns worker credit after consume", async () => {
    let resolveBatch!: (value: MsdfGeneration) => void;
    const generate = vi.fn(() => new Promise<MsdfGeneration>((resolve) => { resolveBatch = resolve; }));
    const release = vi.fn();
    const invalidate = vi.fn();
    const fakeFont = face([glyph(4, 1250)]);
    const runtime = createMsdfRuntime(invalidate, "/msdf_generator.js", {
      loadHb: async () => ({ createFont: () => fakeFont, heapBytes: 131072, destroy: vi.fn() }) as never,
      fetchFont: async () => new Uint8Array([1, 2, 3]),
      generator: { generate, dispose: vi.fn() } as never,
    });
    const input = record(20);
    expect(runtime.shape(input)).toEqual({ reason: "font-pending" });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    const shaped = runtime.shape(input);
    expect("face" in shaped).toBe(true);
    if (!("face" in shaped)) return;
    runtime.request(shaped.face, 8, [4]);
    expect(runtime.takeGeneration()).toBeNull();
    resolveBatch({ tiles: [{ glyphId: 4, width: 1, height: 1, left: 0, top: 0,
      advance: 20, pixels: new Uint8Array(4) }], generationMs: 2,
      wasmMemoryBytes: 65536, release });
    let lease = runtime.takeGeneration();
    await vi.waitFor(() => { lease = runtime.takeGeneration(); expect(lease).not.toBeNull(); });
    expect(runtime.takeGeneration()).toBeNull();
    runtime.finishGeneration(lease!);
    expect(release).toHaveBeenCalledOnce();
    runtime.request(shaped.face, 8, [5]);
    expect(generate).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("caches shaped ordered runs only under their full face and colour style identity", async () => {
    const shape = vi.fn(() => [glyph(4, 1250)]);
    const runtime = createMsdfRuntime(vi.fn(), "/msdf_generator.js", {
      loadHb: async () => ({ createFont: () => ({ upem: 1000, shape, destroy: vi.fn() }),
        heapBytes: 65536, destroy: vi.fn() }) as never,
      fetchFont: async () => new Uint8Array([1, 2, 3]),
      generator: { generate: vi.fn(), dispose: vi.fn() } as never,
    });
    const first = record(20);
    expect(runtime.shape(first)).toEqual({ reason: "font-pending" });
    await vi.waitFor(() => expect("run" in runtime.shape(first)).toBe(true));
    expect("run" in runtime.shape(first)).toBe(true);
    expect(shape).toHaveBeenCalledTimes(1);
    const recolored = { ...first, style: { ...first.style, fill: "#ff0000" } };
    expect("run" in runtime.shape(recolored)).toBe(true);
    const nextOrderedRun = { ...first, key: "run:1" };
    expect("run" in runtime.shape(nextOrderedRun)).toBe(true);
    expect(shape).toHaveBeenCalledTimes(3);
    expect(runtime.stats()).toMatchObject({ shapeHits: 1, shapeMisses: 3 });
    runtime.dispose();
  });
});
