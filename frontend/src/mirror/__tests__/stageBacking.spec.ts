import { describe, expect, it } from "vitest";

import { paintedDeviceBox, stageBackingSize, type StageHostRect } from "@/mirror/canvas/stageBacking";
import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH, MIRROR_MAX_DESIGN_WIDTH } from "@/mirror/sceneTree";

// THE STAGE'S BACKING STORE vs THE BOX IT IS COMPOSITED INTO.
//
// The stage is one <canvas>, re-uploaded and re-composited every frame. That composite is a 1:1 blit only when
// the backing store equals the device-pixel box the compositor paints it into; at any other ratio — including a
// ratio of 1920/1921 — a software compositor resamples the whole surface with a bilinear filter, every frame. A
// Firefox profile of this stage on software WebRender (Sep-03) spent 7.2 ms/frame in exactly those paths.
//
// The condition is BINARY, so this file is arithmetic and pins real numbers rather than tolerances. Everything
// here is offline: a browser is needed to observe the cost, not to compute the sizes.

// ---- the real layout chain, modelled ---------------------------------------------------------------------------
//
// Reproduces MirrorView.vue so the rects below are the ones a browser actually produces, rather than rects chosen
// to make the assertions come out. Three steps, each one a line of that file:
//   design  — `design` computed: the widescreen stretch widens the design width to the frame's aspect, clamped.
//   scale   — `recomputeScale`: contain-fit the design box in the frame.
//   host    — `.mirror-canvas-host`, `width/height: design x scale` with `inset: 0; margin: auto` centring it.
// Plus the layout grid: Gecko stores used lengths in app units (1/60 CSS px), so a fractional inline width is
// snapped to that grid before anything measures it. Blink's LayoutUnit (1/64) behaves the same way.
const APP_UNIT = 1 / 60;
const snapToLayoutGrid = (v: number): number => Math.round(v / APP_UNIT) * APP_UNIT;

interface Layout {
  designW: number;
  designH: number;
  rect: StageHostRect;
}

function layoutFor(frameW: number, frameH: number, stretch: boolean): Layout {
  let designW = MIRROR_DESIGN_WIDTH;
  if (stretch) {
    const wanted = Math.round((frameW / frameH) * MIRROR_DESIGN_HEIGHT);
    designW = Math.min(MIRROR_MAX_DESIGN_WIDTH, Math.max(MIRROR_DESIGN_WIDTH, wanted));
  }
  const designH = MIRROR_DESIGN_HEIGHT;
  const scale = Math.min(frameW / designW, frameH / designH);
  const width = snapToLayoutGrid(designW * scale);
  const height = snapToLayoutGrid(designH * scale);
  return {
    designW,
    designH,
    rect: {
      left: snapToLayoutGrid((frameW - width) / 2),
      top: snapToLayoutGrid((frameH - height) / 2),
      width,
      height
    }
  };
}

interface Case {
  name: string;
  frame: { w: number; h: number };
  dpr: number;
  stretch: boolean;
  design: { w: number; h: number };
  /** What the compositor paints into. */
  snapped: { w: number; h: number };
}

// Every number below was derived from the chain above and is asserted twice: against the layout model, and as a
// literal. A literal that has to be re-derived by hand is the point — it is what makes a silent drift loud.
const CASES: Case[] = [
  {
    name: "dpr 1, the profiled 1920x1080 window (chrome 136 tall)",
    frame: { w: 1920, h: 944 },
    dpr: 1,
    stretch: true,
    design: { w: 2197, h: 1080 },
    snapped: { w: 1920, h: 944 }
  },
  {
    name: "dpr 1, stretch off — 16:9 letterboxed into the same window",
    frame: { w: 1920, h: 944 },
    dpr: 1,
    stretch: false,
    design: { w: 1920, h: 1080 },
    snapped: { w: 1678, h: 944 }
  },
  {
    name: "dpr 1, an exact 16:9 viewport",
    frame: { w: 1920, h: 1080 },
    dpr: 1,
    stretch: false,
    design: { w: 1920, h: 1080 },
    snapped: { w: 1920, h: 1080 }
  },
  {
    // THE RESIDUAL, on a mainstream desktop: 1.25 dpr from fractional display scaling, an odd viewport height.
    //
    // DO NOT TRY TO REPRODUCE THIS FROM A WINDOW SIZE — you will fail, and it will cost you an afternoon. The
    // arithmetic below is exact for the rect `layoutFor(1536, 730, …)` derives, and that is all this case claims.
    // Which side of the fit a real window lands on is decided by the FRACTIONAL PART of the frame rect, and that
    // is a product of fractional display scaling plus browser chrome: it is not `innerWidth`/`innerHeight` (which
    // are rounded integers and hide it), and there is no window size a live agent can set that pins it. A live
    // probe of this very viewport measured AGREEMENT, because the instance's true frame height was ~730.0-730.1
    // rather than the 730 the browser reported, which flips the fit from height-bound to width-bound. Both
    // readings are correct; they are different rects. See the header of `stageBacking.ts` for why only one axis
    // is ever at risk, and why a handful of agreeing live samples is the expected outcome either way.
    name: "dpr 1.25, a 1536x730 CSS viewport (GNOME text scaling)",
    frame: { w: 1536, h: 730 },
    dpr: 1.25,
    stretch: true,
    design: { w: 2272, h: 1080 },
    snapped: { w: 1920, h: 913 }
  },
  {
    name: "dpr 1.5, a 1280x607 CSS viewport",
    frame: { w: 1280, h: 607 },
    dpr: 1.5,
    stretch: true,
    design: { w: 2277, h: 1080 },
    snapped: { w: 1920, h: 911 }
  },
  {
    name: "dpr 2, a 1440x789 CSS viewport",
    frame: { w: 1440, h: 789 },
    dpr: 2,
    stretch: true,
    design: { w: 1971, h: 1080 },
    snapped: { w: 2880, h: 1578 }
  },
  {
    name: "dpr 2, an exact 16:9 viewport",
    frame: { w: 1920, h: 1080 },
    dpr: 2,
    stretch: false,
    design: { w: 1920, h: 1080 },
    snapped: { w: 3840, h: 2160 }
  },
  {
    name: "dpr 3, a 780x360 phone in landscape",
    frame: { w: 780, h: 360 },
    dpr: 3,
    stretch: true,
    design: { w: 2340, h: 1080 },
    snapped: { w: 2340, h: 1080 }
  },
  {
    // THE RESIDUAL on a phone, and in the other direction — today's law is one pixel too WIDE here.
    name: "dpr 3, stretch off — 16:9 into a taller phone viewport",
    frame: { w: 780, h: 407 },
    dpr: 3,
    stretch: false,
    design: { w: 1920, h: 1080 },
    snapped: { w: 2170, h: 1221 }
  },
  {
    name: "dpr 1, 16:9 letterboxed into 4:3",
    frame: { w: 1024, h: 768 },
    dpr: 1,
    stretch: false,
    design: { w: 1920, h: 1080 },
    snapped: { w: 1024, h: 576 }
  },
  {
    // THE RESIDUAL at the widened design width: past the 2520 clamp the design box is MAGNIFIED (scale > 1), and
    // the host's left edge sits a third of a pixel off the device grid.
    name: "dpr 1, ultrawide past the 2520 design clamp",
    frame: { w: 3440, h: 1300 },
    dpr: 1,
    stretch: true,
    design: { w: 2520, h: 1080 },
    snapped: { w: 3034, h: 1300 }
  },
  {
    name: "dpr 2.625, a 412x915 portrait phone",
    frame: { w: 412, h: 915 },
    dpr: 2.625,
    stretch: false,
    design: { w: 1920, h: 1080 },
    snapped: { w: 1082, h: 608 }
  }
];

describe("the stage's backing-store sizing law", () => {
  describe.each(CASES)("$name", (testCase) => {
    const layout = layoutFor(testCase.frame.w, testCase.frame.h, testCase.stretch);
    const input = { designW: layout.designW, designH: layout.designH, rect: layout.rect, pixelRatio: testCase.dpr };

    it("derives the design box the layout model says it does", () => {
      expect([layout.designW, layout.designH]).toEqual([testCase.design.w, testCase.design.h]);
    });

    it("makes the backing store the device box the compositor paints into", () => {
      const sized = stageBackingSize(input);
      expect([sized.backingW, sized.backingH]).toEqual([testCase.snapped.w, testCase.snapped.h]);
      // The property, stated separately from the literal: a 1:1 blit.
      const painted = paintedDeviceBox(layout.rect, testCase.dpr);
      expect([sized.backingW, sized.backingH]).toEqual([painted.w, painted.h]);
      expect(sized.snapped).toBe(true);
    });

    it("keeps the design-to-device factor at fitted scale times dpr", () => {
      const sized = stageBackingSize(input);
      expect(sized.perDesignPx).toBeCloseTo((layout.rect.width / layout.designW) * testCase.dpr, 12);
    });
  });

  it("is 1:1 across a swept device/dpr matrix", () => {
    let checked = 0;
    for (const dpr of [1, 1.25, 1.5, 2, 2.625, 3, 3.4876]) {
      for (const stretch of [true, false]) {
        for (let deviceW = 1280; deviceW <= 3840; deviceW += 137) {
          for (let deviceH = 600; deviceH <= 2160; deviceH += 61) {
            const frameW = deviceW / dpr;
            const frameH = deviceH / dpr;
            if (frameW < 320 || frameH < 240) {
              continue;
            }
            const layout = layoutFor(frameW, frameH, stretch);
            const input = { designW: layout.designW, designH: layout.designH, rect: layout.rect, pixelRatio: dpr };
            const sized = stageBackingSize(input);
            const painted = paintedDeviceBox(layout.rect, dpr);
            checked++;
            expect(sized.backingW).toBe(painted.w);
            expect(sized.backingH).toBe(painted.h);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  // ---- the fallback -------------------------------------------------------------------------------------------
  //
  // A usable rect is required. Where there is none — jsdom, an unlaid-out host, a `display: none` ancestor — the
  // design-box scale avoids returning a 1x1 stage.
  describe("a rect it cannot use", () => {
    const base = { designW: 1920, designH: 1080, pixelRatio: 2 };

    it.each([
      ["all zero (jsdom, an unlaid-out host)", { left: 0, top: 0, width: 0, height: 0 }],
      ["zero width only", { left: 0, top: 0, width: 0, height: 500 }],
      ["zero height only", { left: 0, top: 0, width: 500, height: 0 }],
      ["a negative width", { left: 0, top: 0, width: -10, height: 500 }],
      ["NaN in the offset", { left: Number.NaN, top: 0, width: 800, height: 450 }],
      ["Infinity in the size", { left: 0, top: 0, width: Number.POSITIVE_INFINITY, height: 450 }]
    ])("uses the design-box scale: %s", (_label, rect) => {
      const sized = stageBackingSize({ ...base, rect });
      expect(sized.snapped).toBe(false);
      expect(sized.backingW).toBeGreaterThanOrEqual(1);
      expect(sized.backingH).toBeGreaterThanOrEqual(1);
    });

    it("a zero rect keeps `stageScale()`'s own fallback of 1, so the stage is design x dpr", () => {
      const sized = stageBackingSize({ ...base, rect: { left: 0, top: 0, width: 0, height: 0 } });
      expect(sized.perDesignPx).toBe(2);
      expect([sized.backingW, sized.backingH]).toEqual([3840, 2160]);
    });

    it("never returns a zero or negative backing store even for a sub-pixel host", () => {
      const sized = stageBackingSize({
        designW: 1920,
        designH: 1080,
        rect: { left: 10.4, top: 10.4, width: 0.05, height: 0.05 },
        pixelRatio: 1,
      });
      expect(sized.backingW).toBe(1);
      expect(sized.backingH).toBe(1);
    });
  });
});
