import { describe, expect, it, vi } from "vitest";
import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import { createBitmapTextMethod, type BitmapEnvironment } from "./bitmap";

interface DrawCall { method: "fillText" | "strokeText"; text: string; x: number; y: number }

/** A stub 2D context recording every `fillText`/`strokeText` call's exact draw origin, with fixed metrics
 *  standing in for a real font: ascent 14, descent 4 (both the ink and the font-box values agree, isolating
 *  the formula under test from the ink-vs-font-box `Math.max` bitmap.ts also does). */
function stubContext(calls: DrawCall[]): CanvasRenderingContext2D {
  return {
    getContextAttributes() { return { alpha: true }; },
    measureText(value: string) {
      return { width: value.length * 8, actualBoundingBoxAscent: 14, actualBoundingBoxDescent: 4,
        fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 4 };
    },
    fillText(text: string, x: number, y: number) { calls.push({ method: "fillText", text, x, y }); },
    strokeText(text: string, x: number, y: number) { calls.push({ method: "strokeText", text, x, y }); },
  } as unknown as CanvasRenderingContext2D;
}

function createEnv(calls: DrawCall[]): BitmapEnvironment {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => stubContext(calls)) as never);
  return {
    canvas: document.createElement("canvas"),
    textResourceKey: (record) => `text:${record.key}:${record.text}`,
    readPixels: (_source, key, width, height) => ({ key, width, height, pixels: new Uint8Array(width * height * 4) }),
    textInkDiagnostics: false,
    textInkCurrentSubmission: null,
    textInkDiagnosticEvents: [],
    textInkDiagnosticEventLimit: 0,
    setDiagnosticOverflow: () => {},
    setLastMissSubmission: () => {},
    onRasterization: () => {},
  };
}

// Stroke width 4 (strokeHalf 2) and a line pitch (40) well past the 18px font box (ascent 14 + descent 4), so
// a wrong fallback would show up as a wrong y too — the regression this round fixed combined an x shift (the
// missing `strokeHalf` inset) with a y shift (half-leading) on any label whose pitch exceeds its font box.
function strokedRecord(baselinePx?: number): PixiTextRecord {
  return {
    key: "label:0:0", insertionIndex: 0, text: "Hi", runs: [{ text: "Hi" }],
    transform: [1, 0, 0, 1, 0, 0],
    style: { fontFamily: "sans-serif", fontSize: 16, fill: "#ffffff",
      stroke: { color: "#000000", width: 4 }, lineHeight: 40 },
    ...(baselinePx !== undefined
      ? { msdf: { url: "/res/x.ttf", faceKey: "x", measuredAdvance: 16, baselinePx } } : {}),
  } as unknown as PixiTextRecord;
}

describe("Bitmap text raster origin", () => {
  // strokePad = ceil(4 + 1) = 5, no shadow, so pad = max(5, 0) + 2 = 7.
  const pad = 7;

  it("draws at (pad + strokeHalf, pad + baselinePx) when the record carries the producer's baseline", () => {
    const calls: DrawCall[] = [];
    const method = createBitmapTextMethod(createEnv(calls));
    const carrier = method.prepare(strokedRecord(20));
    expect(carrier).not.toBeNull();
    expect(calls).toContainEqual({ method: "strokeText", text: "Hi", x: pad + 2, y: pad + 20 });
    expect(calls).toContainEqual({ method: "fillText", text: "Hi", x: pad + 2, y: pad + 20 });
    // The record's x correction (`nativeTextOriginCorrection`'s `-strokeHalf`) already shifts the carrier's
    // anchor left by the same amount the raster's own ink shifts right, so the transform offset stays the
    // plain (-pad, -pad) it always was — only the ink's position inside the canvas moved.
    expect(carrier!.transform).toEqual([1, 0, 0, 1, -pad, -pad]);
  });

  it("falls back to strokeHalf + fontAscent + half-leading when the record has no msdf baseline", () => {
    const calls: DrawCall[] = [];
    const method = createBitmapTextMethod(createEnv(calls));
    const carrier = method.prepare(strokedRecord());
    expect(carrier).not.toBeNull();
    // strokeHalf 2 + fontAscent 14 + max(0, (40 - 14 - 4) / 2) = 2 + 14 + 11 = 27.
    expect(calls).toContainEqual({ method: "fillText", text: "Hi", x: pad + 2, y: pad + 27 });
  });
});
