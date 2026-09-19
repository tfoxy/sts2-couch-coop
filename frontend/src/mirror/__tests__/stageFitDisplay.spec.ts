// The `?stageFit=display` arm (stageFit.ts): DOM boxes in real display px, stage with no scale transform.
//
// TWO THINGS ARE UNDER TEST, and the first matters more than the second:
//
//   1. THE DEFAULT ARM IS INERT. Every helper must be an exact identity while the lever is off, INCLUDING when a
//      fit measurement is pushed at it — because MirrorView pushes one on every resize whichever arm is live. The
//      whole parity argument rests on this, and the rest of the suite (4,604 tests, unedited) is the other half of
//      the proof.
//   2. THE DISPLAY ARM IS THE DESIGN ARM CONJUGATED BY THE FIT FACTOR. Not "roughly scaled" — conjugated, which is
//      a specific claim with a specific failure mode: scale the matrix's LINEAR part along with its translation and
//      every node gets S² of its own scale/rotation. The composition test below is what pins that.

import { afterEach, describe, expect, it } from "vitest";

import { affineMul, type Affine } from "@/mirror/affine";
import { nodeStyle, textStyle, type RenderItem } from "@/mirror/nodeStyles";
import { particleVisibleRect } from "@/mirror/particleVisibleRect";
import type { MirrorNode } from "@/mirror/sceneTree";
import {
  __resetStageFitForTest,
  __setStageFitForTest,
  designPx,
  displaySpaceLayout,
  layoutScale,
  px,
  pxCss,
  scaleAffineTranslation,
  setLayoutScale,
  stageFitMode
} from "@/mirror/stageFit";
import { createStaticPinTracker } from "@/mirror/staticPin";

// A deliberately AWKWARD factor: non-integral, non-terminating in binary, and close to the ~0.214 a 16:9 design box
// really fits to on a phone. A factor of 0.5 would hide an axis swap and every rounding mistake at once.
const FIT = 0.2143;

function mkNode(over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id: "n",
    parentId: null,
    name: "Box",
    nodeType: "Control",
    clipChildren: 0,
    clipContents: false,
    ninePatch: false,
    ninePatchMargins: null,
    richText: false,
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 200, height: 80 },
    visible: true,
    opacity: 1,
    zIndex: null,
    textureUrl: null,
    textureRegion: null,
    textureMargin: null,
    modulate: null,
    selfModulate: null,
    fillColor: null,
    range: null,
    text: null,
    outline: null,
    shadow: null,
    font: null,
    ...over
  } as unknown as MirrorNode;
}

function item(node: MirrorNode, parentInv: Affine | null = null, hasChildren = false): RenderItem {
  return { node, opacity: 1, tintId: null, parentInv, hasChildren };
}

/** Parse the six numbers out of a `matrix(...)` the styler emitted. */
function matrixOf(css: string | undefined): Affine {
  const m = /matrix\(([^)]+)\)/.exec(css ?? "");
  expect(m, `expected a matrix() in ${css}`).not.toBeNull();
  const parts = m![1].split(",").map((p) => Number(p.trim()));
  expect(parts).toHaveLength(6);
  return parts as unknown as Affine;
}

/** `styles(node…)` on whichever arm is currently set. */
function styleOn(mode: "design" | "display", fit: number, build: () => Record<string, string>): Record<string, string> {
  __setStageFitForTest(mode);
  setLayoutScale(fit);
  return build();
}

afterEach(() => {
  __resetStageFitForTest();
});

describe("stageFit — the lever and its defaults", () => {
  it("defaults to the design arm, factor 1, with the display layout NOT in force", () => {
    expect(stageFitMode()).toBe("design");
    expect(displaySpaceLayout()).toBe(false);
    expect(layoutScale()).toBe(1);
  });

  it("REFUSES a fit measurement on the design arm — the factor cannot be perturbed off the default", () => {
    // MirrorView calls this on every resize regardless of arm, so "refused" is the property that makes the whole
    // default arm inert rather than merely usually-inert.
    expect(setLayoutScale(FIT)).toBe(false);
    expect(layoutScale()).toBe(1);
    expect(setLayoutScale(3)).toBe(false);
    expect(layoutScale()).toBe(1);
  });

  it("accepts a fit on the display arm, and reports whether it MOVED (the forced-restyle trigger)", () => {
    __setStageFitForTest("display");
    expect(displaySpaceLayout()).toBe(true);
    expect(setLayoutScale(FIT)).toBe(true);
    expect(layoutScale()).toBe(FIT);
    // Same value again ⇒ nothing moved ⇒ no scene-wide restyle. A resize that does not change the fit (a sibling
    // panel resizing the frame on one axis only) must not cost a full walk.
    expect(setLayoutScale(FIT)).toBe(false);
    expect(layoutScale()).toBe(FIT);
  });

  it("refuses a degenerate fit rather than latching it", () => {
    __setStageFitForTest("display");
    expect(setLayoutScale(0)).toBe(false);
    expect(setLayoutScale(-1)).toBe(false);
    expect(setLayoutScale(Number.NaN)).toBe(false);
    expect(setLayoutScale(Number.POSITIVE_INFINITY)).toBe(false);
    expect(layoutScale()).toBe(1);
  });
});

describe("stageFit — the conversion helpers", () => {
  it("are exact identities at factor 1 (the default arm's byte-for-byte guarantee)", () => {
    for (const v of [0, 1, -0.5, 1920, 1 / 3, 1e-7, -2147483648]) {
      expect(px(v)).toBe(v);
      expect(designPx(v)).toBe(v);
      expect(pxCss(v)).toBe(`${v}px`);
    }
    const m: Affine = [2, 0.5, -0.25, 3, 17, -29];
    // The SAME tuple back, not a copy: nothing allocates on the default arm.
    expect(scaleAffineTranslation(m)).toBe(m);
  });

  it("scale lengths and INVERT cleanly on the display arm", () => {
    __setStageFitForTest("display");
    setLayoutScale(FIT);
    expect(px(1000)).toBeCloseTo(214.3, 10);
    expect(pxCss(1000)).toBe(`${1000 * FIT}px`);
    expect(designPx(px(1000))).toBeCloseTo(1000, 9);
  });

  it("CONJUGATE an affine: the translation scales, the linear part does NOT", () => {
    __setStageFitForTest("display");
    setLayoutScale(FIT);
    // A linear part that is NOT the identity — a node with its own scale and a shear, which is exactly the case a
    // naive "multiply the whole matrix" would corrupt into S² of its own geometry.
    const m: Affine = [2, 0.5, -0.25, 3, 100, -40];
    const out = scaleAffineTranslation(m);
    expect(out[0]).toBe(2);
    expect(out[1]).toBe(0.5);
    expect(out[2]).toBe(-0.25);
    expect(out[3]).toBe(3);
    expect(out[4]).toBeCloseTo(100 * FIT, 10);
    expect(out[5]).toBeCloseTo(-40 * FIT, 10);
  });
});

describe("nodeStyle on the display arm", () => {
  it("emits the box in display px and the placement translation scaled, linear part untouched", () => {
    const node = mkNode({
      transform: [1.5, 0, 0, 1.5, 640, 360],
      localRect: { x: 10, y: 20, width: 200, height: 80 }
    });
    const design = styleOn("design", FIT, () => nodeStyle(item(node)));
    const display = styleOn("display", FIT, () => nodeStyle(item(node)));

    expect(design.width).toBe("200px");
    expect(design.height).toBe("80px");
    expect(display.width).toBe(`${200 * FIT}px`);
    expect(display.height).toBe(`${80 * FIT}px`);

    const dm = matrixOf(design.transform);
    const xm = matrixOf(display.transform);
    expect([xm[0], xm[1], xm[2], xm[3]]).toEqual([dm[0], dm[1], dm[2], dm[3]]);
    expect(xm[4]).toBeCloseTo(dm[4] * FIT, 9);
    expect(xm[5]).toBeCloseTo(dm[5] * FIT, 9);
  });

  it("COMPOSITION: a child re-based against its parent stays conjugated — so the whole tree is one uniform scale", () => {
    // THE load-bearing algebraic claim. The mirror nests every node inside its parent element and re-bases the
    // child by `parentInv`, so the child's emitted matrix is NOT its global one. Conjugation has to survive that
    // composition or the display arm drifts further from the design arm the deeper the tree goes.
    const parentGlobal: Affine = [1, 0, 0, 1, 300, 150];
    const parentInv: Affine = [1, 0, 0, 1, -300, -150];
    const parent = mkNode({ transform: parentGlobal, localRect: { x: 0, y: 0, width: 400, height: 300 } });
    const child = mkNode({
      transform: [0.8, 0.6, -0.6, 0.8, 340, 190],
      localRect: { x: 0, y: 0, width: 50, height: 50 }
    });

    const designChild = matrixOf(styleOn("design", FIT, () => nodeStyle(item(child, parentInv))).transform);
    const designParent = matrixOf(styleOn("design", FIT, () => nodeStyle(item(parent))).transform);
    const displayChild = matrixOf(styleOn("display", FIT, () => nodeStyle(item(child, parentInv))).transform);
    const displayParent = matrixOf(styleOn("display", FIT, () => nodeStyle(item(parent))).transform);

    // The RENDERED chain is parent · child. Composing it on each arm and comparing is the end-to-end statement:
    // a design point lands at exactly FIT times where it landed before, on both axes, with no rotation lost.
    const designChain = affineMul(designParent, designChild);
    const displayChain = affineMul(displayParent, displayChild);
    expect(displayChain[0]).toBeCloseTo(designChain[0], 12);
    expect(displayChain[1]).toBeCloseTo(designChain[1], 12);
    expect(displayChain[2]).toBeCloseTo(designChain[2], 12);
    expect(displayChain[3]).toBeCloseTo(designChain[3], 12);
    expect(displayChain[4]).toBeCloseTo(designChain[4] * FIT, 9);
    expect(displayChain[5]).toBeCloseTo(designChain[5] * FIT, 9);
  });

  it("scales border-width but NOT border-image-slice (slices address the source texture)", () => {
    const node = mkNode({
      ninePatch: true,
      ninePatchMargins: { left: 6, top: 8, right: 10, bottom: 12 },
      textureUrl: "/res/x.png"
    });
    const display = styleOn("display", FIT, () => nodeStyle(item(node)));
    expect(display.borderWidth).toBe(`${8 * FIT}px ${10 * FIT}px ${12 * FIT}px ${6 * FIT}px`);
    // Unitless, and in SOURCE pixels — the texture does not move when the stage is fitted.
    expect(display.borderImageSlice).toBe("8 10 12 6 fill");
  });

  it("scales the one-axis clip outset with the box it insets", () => {
    const node = mkNode({ clipContents: true });
    const display = styleOn("display", FIT, () => nodeStyle({ ...item(node), clipAxisOutsetX: 40 }));
    expect(display.clipPath).toBe(`inset(0px -${40 * FIT}px)`);
  });
});

describe("textStyle on the display arm", () => {
  it("scales the font size, the exposed base px, the outline and the shadow", () => {
    const node = mkNode({
      text: { text: "x", halign: null, valign: null, colorHtml: null, fontSizePx: 28, outlineColorHtml: "#000", outlineSize: 4 },
      shadow: { colorHtml: "#123456", offsetX: 3, offsetY: -2 }
    } as Partial<MirrorNode>);
    const display = styleOn("display", FIT, () => textStyle(node));
    expect(display.fontSize).toBe(`calc(${28 * FIT}px * var(--godot-text-scale, 1))`);
    expect(display["--godot-font-px"]).toBe(`${28 * FIT}px`);
    // OUTLINE_SCALE (0.5) is a renderer-fidelity ratio and composes BEFORE the layout factor.
    expect(display.webkitTextStroke).toBe(`${2 * FIT}px #000`);
    expect(display.textShadow).toBe(`${3 * FIT}px ${-2 * FIT}px 0 #123456`);
  });
});

describe("staticPin on the display arm", () => {
  // gsw sizes a FROZEN surface as `contentBox × pin`, and it measures contentBox with transform-blind reads. On the
  // display arm that box already carries the fit, so a pin that still carried it would square the factor — blowing
  // up the very backing stores this arm exists to shrink.
  // A 1280x720 seed on purpose: its fit is 2/3, NOT 1. Seeding at 1920x1080 would make `fit` the multiplicative
  // identity and every assertion below would pass just as happily with the term deleted from both arms.
  const tracker = (displayLayout: boolean) =>
    createStaticPinTracker({
      screen: { width: 1280, height: 720 },
      devicePixelRatio: () => 3,
      displayLayout: () => displayLayout
    });

  it("keeps `fit × dpr × staticScale` on the default arm", () => {
    expect(tracker(false).targetFit()).toBeCloseTo(2 / 3, 12);
    expect(tracker(false).ratioFor(0.5)).toBeCloseTo((2 / 3) * 3 * 0.5, 12);
  });

  it("DROPS the fit term on the display arm — the ratio is `dpr × staticScale`", () => {
    const t = tracker(true);
    // A real fullscreen-landscape measurement moves `fit` to 0.5; the display-arm ratio must not notice.
    t.observeViewport(960, 540, true);
    expect(t.targetFit()).toBeCloseTo(0.5, 12);
    expect(t.ratioFor(0.5)).toBeCloseTo(3 * 0.5, 12);
    expect(t.ratioFor(1)).toBeCloseTo(3, 12);
  });

  it("omitting `displayLayout` entirely leaves the design-arm formula verbatim", () => {
    const t = createStaticPinTracker({ screen: { width: 1280, height: 720 }, devicePixelRatio: () => 2 });
    expect(t.ratioFor(0.25)).toBeCloseTo((2 / 3) * 2 * 0.25, 12);
  });
});

describe("particleVisibleRect on the display arm", () => {
  const identity: Affine = [1, 0, 0, 1, 0, 0];
  const viewport = { width: 1920, height: 1080 };

  it("reports the design rect, snapped OUTWARD to the 16px grid, on the default arm", () => {
    // 1080 is not a multiple of 16, and the snap only ever grants room (1080 → 1088).
    const rect = particleVisibleRect(identity, { x: 0, y: 0 }, viewport);
    expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1088 });
  });

  it("reports the rect in DISPLAY-local px — and lands ON the snap grid THERE, not on the design one", () => {
    __setStageFitForTest("display");
    setLayoutScale(FIT);
    const rect = particleVisibleRect(identity, { x: 0, y: 0 }, viewport);
    // 1920·FIT = 411.456 → 416; 1080·FIT = 231.444 → 240. Converting AFTER the snap would give 1920 → 1920·FIT =
    // 411.456 and 1088 → 233.15 — neither a multiple of 16, i.e. not snapped in the space the attribute is written
    // in, which is the whole point of the grid (gsw re-sizes the canvas whenever the string moves).
    expect(rect).toEqual({ x: 0, y: 0, width: 416, height: 240 });
    expect(rect!.width % 16).toBe(0);
    expect(rect!.height % 16).toBe(0);
  });

  it("carries a node's own offset through the conversion", () => {
    __setStageFitForTest("display");
    setLayoutScale(0.5);
    // A node at design (960, 512): the viewport reaches 960 design px to its left, i.e. 480 display px.
    const rect = particleVisibleRect([1, 0, 0, 1, 960, 512], { x: 0, y: 0 }, viewport);
    expect(rect!.x).toBe(-480);
    expect(rect!.y).toBe(-256);
  });
});

describe("the display arm never leaks into the default arm", () => {
  it("a node styled after the display arm has been used and reset is byte-identical to a fresh one", () => {
    const node = mkNode({ transform: [1, 0, 0, 1, 123.456, 78.9], localRect: { x: 3, y: 7, width: 199, height: 41 } });
    const before = nodeStyle(item(node));
    __setStageFitForTest("display");
    setLayoutScale(FIT);
    nodeStyle(item(node));
    __resetStageFitForTest();
    // Also push a fit at the reset default arm, which is what MirrorView does on every resize.
    setLayoutScale(FIT);
    expect(nodeStyle(item(node))).toEqual(before);
  });
});
