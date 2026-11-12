import { describe, expect, it } from "vitest";

import { mirrorDesignSize } from "@/mirror/mirrorDesign";
import { streamSeatAspect } from "@/mirror/renderStreamAvailability";
import { streamChromeGeometry } from "@/mirror/streamChrome";

interface Frame { left: number; top: number; width: number; height: number }

// The seat caps and normalises presentation widths to even pixels, retaining a width its float32 viewport fits.
function seatWidth(aspect: number | undefined, cap = 2520): number {
  let width = Math.min(cap, Math.max(1920, Math.round(1080 * (aspect ?? 1920 / 1080))));
  width -= width % 2;
  while (width > 1920 && Math.floor(Math.fround(1080 * Math.fround(width / 1080))) !== width) width -= 2;
  return width;
}

function canvasIn(frame: Frame, presentationWidth: number): Frame {
  const scale = Math.min(frame.width / presentationWidth, frame.height / 1080);
  return {
    left: frame.left + (frame.width - presentationWidth * scale) / 2,
    top: frame.top + (frame.height - 1080 * scale) / 2,
    width: presentationWidth * scale, height: 1080 * scale
  };
}

describe("stream chrome geometry", () => {
  for (const [width, height] of [[1920, 1080], [2340, 1080], [2400, 1080], [1440, 1080], [932, 430], [3840, 1080]]) {
    for (const stretchEnabled of [false, true]) {
      it.each([false, true])(`matches the mirror in ${width}×${height}, stretch ${stretchEnabled}, safe area %s`, (safeAreaPaddingEnabled) => {
        const inset = safeAreaPaddingEnabled ? 60 : 0;
        const frame = { left: inset, top: 0, width: width - 2 * inset, height };
        const settings = { stretchEnabled, safeAreaPaddingEnabled };
        const design = mirrorDesignSize(frame.width, frame.height, stretchEnabled);
        const presentationWidth = seatWidth(streamSeatAspect(settings, () => frame));
        const canvas = canvasIn(frame, presentationWidth);
        const chrome = streamChromeGeometry(canvas, presentationWidth)!;
        const mirrorScale = Math.min(frame.width / design.w, height / design.h);
        const mirrorTop = (height - design.h * mirrorScale) / 2;
        const mirrorChrome = {
          gear: { left: width / 2 - 40 * mirrorScale, top: mirrorTop, width: 80 * mirrorScale, height: 80 * mirrorScale },
          fullscreen: { left: width / 2 + 52 * mirrorScale, top: mirrorTop, width: 80 * mirrorScale, height: 80 * mirrorScale }
        };
        if (design.w % 2 === 0) expect(presentationWidth).toBe(design.w);
        for (const button of ["gear", "fullscreen"] as const) {
          for (const field of ["left", "top", "width", "height"] as const) {
            if (design.w % 2 === 0) {
              expect(chrome[button][field]).toBeCloseTo(mirrorChrome[button][field], 10);
            } else {
              // The seat's even-width normalisation can differ from the mirror's integer design width.
              expect(Math.abs(chrome[button][field] - mirrorChrome[button][field])).toBeLessThanOrEqual(0.5);
            }
          }
        }
        expect(Math.round(chrome.gear.top + chrome.gear.height + 6))
          .toBe(Math.round(mirrorTop + 80 * mirrorScale + 6));
      });
    }
  }

  it("follows a picture whose aspect no longer matches the frame after the viewport or settings change", () => {
    const frame = { left: 60, top: 0, width: 2280, height: 1080 };
    const canvas = canvasIn(frame, 2400);
    const chrome = streamChromeGeometry(canvas, 2400)!;
    expect(chrome.scale).toBe(0.95);
    expect(chrome.gear).toEqual({ left: 1162, top: 27, width: 76, height: 76 });
    expect(chrome.fullscreen.left).toBeCloseTo(1249.4, 10);
    expect(Math.round(chrome.gear.top + chrome.gear.height + 6)).toBe(109);
  });

  it("follows the canvas when a configured seat cap is below the mirror's maximum", () => {
    const frame = { left: 0, top: 0, width: 2400, height: 1080 };
    const aspect = streamSeatAspect({ stretchEnabled: true, safeAreaPaddingEnabled: false }, () => frame);
    const presentationWidth = seatWidth(aspect, 2160);
    expect(presentationWidth).toBe(2160);
    expect(mirrorDesignSize(frame.width, frame.height, true).w).toBe(2400);
    const canvas = canvasIn(frame, presentationWidth);
    expect(canvas).toEqual({ left: 120, top: 0, width: 2160, height: 1080 });
    expect(streamChromeGeometry(canvas, presentationWidth)).toEqual({ scale: 1,
      gear: { left: 1160, top: 0, width: 80, height: 80 },
      fullscreen: { left: 1252, top: 0, width: 80, height: 80 } });
  });

  it("uses the canvas's page offset, including asymmetric safe-area and letterbox offsets", () => {
    const chrome = streamChromeGeometry({ left: 70, top: 35, width: 1170, height: 540 }, 2340)!;
    expect(chrome).toEqual({ scale: 0.5,
      gear: { left: 635, top: 35, width: 40, height: 40 },
      fullscreen: { left: 681, top: 35, width: 40, height: 40 } });
  });

  it("waits for a laid-out canvas", () => {
    expect(streamChromeGeometry({ left: 0, top: 0, width: 0, height: 0 }, 1920)).toBeNull();
  });
});
