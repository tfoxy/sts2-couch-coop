// R1 — CROPPING AN OVERLAY SURFACE TO ITS ENCLOSING CLIP CHAIN.
//
// A canvas command lands inside whatever clip scopes the walk had open at its node; an overlay ELEMENT is a flat
// child of one container and lands inside none of them. So a label inside a scrolled dialog kept painting after it
// had scrolled out of its own viewport — the user's "the dialog's own text scrolls above the TopBar".
//
// THE ONE THING THESE TESTS EXIST TO STOP is the opposite failure: a crop that is too TIGHT loses text the game is
// showing, which is strictly worse than the bug. Hence the shape of every assertion below — the x rule is cited
// from `hitTest.insideClipChain` rather than restated, the radius is dropped rather than approximated the moment
// two scopes are involved, an already-contained box gets NO crop at all, and the insets are allowed to go negative
// so a label's outline and shadow (which sit outside its own box) are never cut at the box edge.

import { afterEach, describe, expect, it } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import { createMirrorOverlay, overlayClipPath, type MirrorOverlay } from "@/mirror/canvas/overlay";
import {
  intersectOverlayClip,
  type ClipSpec,
  type OverlayClip,
  type OverlayRecord
} from "@/mirror/canvas/paintSpec";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode } from "@/mirror/sceneTree";

function scope(over: Partial<ClipSpec> = {}): { spec: ClipSpec } {
  return { spec: { x: 0, y: 0, w: 100, h: 100, cornerRadius: 0, outsetX: 0, ...over } };
}

function clipOf(
  chain: Array<{ spec: ClipSpec }>,
  m: readonly number[] = [1, 0, 0, 1, 0, 0],
  w = 20,
  h = 20
): OverlayClip | null {
  return intersectOverlayClip(chain, m as [number, number, number, number, number, number], w, h);
}

describe("the enclosing chain, intersected", () => {
  it("takes the tightest edge of every scope", () => {
    // Two nested scrollers: the crop is the overlap, and the surface (at 0,0) pokes out of it on both axes.
    const clip = clipOf([scope({ x: 0, y: 0, w: 100, h: 100 }), scope({ x: 10, y: 20, w: 100, h: 60 })], undefined, 200, 200);
    expect(clip).toEqual({ x: 10, y: 20, w: 90, h: 60, cornerRadius: 0 });
  });

  it("widens BOTH x edges by outsetX and leaves y exact — hitTest.insideClipChain's rule verbatim", () => {
    const clip = clipOf([scope({ x: 100, y: 40, w: 50, h: 50, outsetX: 12 })], [1, 0, 0, 1, 0, 0], 400, 400);
    // x: [100-12, 150+12]; y: [40, 90] untouched.
    expect(clip).toEqual({ x: 88, y: 40, w: 74, h: 50, cornerRadius: 0 });
  });

  it("carries the corner radius of a lone scope", () => {
    expect(clipOf([scope({ w: 40, h: 40, cornerRadius: 9 })], [1, 0, 0, 1, 0, 0], 200, 200)?.cornerRadius).toBe(9);
  });

  it("DROPS the radius as soon as two scopes intersect — under-clipping is the safe direction", () => {
    // Two rounded rects do not intersect into a rounded rect. Radius 0 leaves the corner pixels a rounded clipper
    // would have cut; the alternative (keeping one of the two) can cut pixels the game is showing.
    const clip = clipOf(
      [scope({ w: 40, h: 40, cornerRadius: 9 }), scope({ x: 5, y: 5, w: 40, h: 40, cornerRadius: 4 })],
      [1, 0, 0, 1, 0, 0],
      200,
      200
    );
    expect(clip?.cornerRadius).toBe(0);
  });

  it("answers null when the chain already CONTAINS the placed box", () => {
    // The common case: a label well inside its container needs no crop, so no rect is carried and the overlay
    // writes no style at all.
    expect(clipOf([scope({ x: 0, y: 0, w: 500, h: 500 })], [1, 0, 0, 1, 100, 100], 50, 50)).toBeNull();
  });

  it("measures containment through the record's own MATRIX, not its box", () => {
    // Same 50x50 box, placed at 480 with a 2x scale: it reaches 580 and pokes out of a 500-wide scope.
    expect(clipOf([scope({ x: 0, y: 0, w: 500, h: 500 })], [2, 0, 0, 2, 480, 10], 50, 50)).not.toBeNull();
  });

  it("answers an EMPTY rect (not null) for disjoint scopes — the scrolled-out-of-view case", () => {
    const clip = clipOf([scope({ x: 0, y: 0, w: 50, h: 50 }), scope({ x: 200, y: 0, w: 50, h: 50 })], undefined, 400, 400);
    expect(clip!.w).toBeLessThanOrEqual(0);
  });

  it("answers null for no chain at all", () => {
    expect(clipOf([])).toBeNull();
    expect(intersectOverlayClip(null, [1, 0, 0, 1, 0, 0], 10, 10)).toBeNull();
  });
});

describe("the crop as a clip-path", () => {
  const RECT: OverlayClip = { x: 10, y: 20, w: 100, h: 40, cornerRadius: 0 };

  it("inverts an axis-aligned placement into an inset()", () => {
    // Element box 200x200 at the origin: the crop's left edge is 10 in, its right edge 200-110 = 90 in.
    expect(overlayClipPath(RECT, [1, 0, 0, 1, 0, 0], 200, 200)).toBe("inset(20px 90px 140px 10px)");
  });

  it("keeps NEGATIVE insets rather than clamping to the box — a label's ink lives outside its box", () => {
    // A 20x20 label inside a 200-wide clip: three of the four insets are negative, and clamping any of them to 0
    // would crop the label's own outline and shadow at the box edge. That is the failure this whole fix must not
    // introduce, so the string is pinned.
    const path = overlayClipPath({ x: -50, y: -50, w: 200, h: 200, cornerRadius: 0 }, [1, 0, 0, 1, 0, 0], 20, 20);
    expect(path).toBe("inset(-50px -130px -130px -50px)");
  });

  it("divides the radius per axis, and folds equal axes into one value", () => {
    expect(overlayClipPath({ ...RECT, cornerRadius: 8 }, [2, 0, 0, 2, 0, 0], 200, 200)).toContain("round 4px)");
    expect(overlayClipPath({ ...RECT, cornerRadius: 8 }, [2, 0, 0, 4, 0, 0], 200, 200)).toContain("round 4px / 2px)");
  });

  it("orders the edges under a MIRRORED placement instead of emitting an inverted inset", () => {
    const path = overlayClipPath(RECT, [-1, 0, 0, 1, 200, 0], 200, 200)!;
    const nums = [...path.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
    // top right bottom left — every inset is measured from its own edge, so none of them is an inverted span.
    expect(nums[1]).toBeGreaterThanOrEqual(0);
    expect(nums[3]).toBeGreaterThanOrEqual(0);
  });

  it("falls back to a polygon of the four inverted corners when the placement is rotated", () => {
    // 90 degrees: design x becomes element -y and design y becomes element x.
    const path = overlayClipPath(RECT, [0, 1, -1, 0, 0, 0], 200, 200)!;
    expect(path.startsWith("polygon(")).toBe(true);
    expect(path).toBe("polygon(20px -10px, 20px -110px, 60px -110px, 60px -10px)");
  });

  it("renders an empty crop as a zero-area inset, never display:none", () => {
    // gsw sizes a runtime's canvas off the host's client box and watches it with a ResizeObserver, so a
    // display-none host would collapse the surface rather than hide it.
    expect(overlayClipPath({ x: 0, y: 0, w: -5, h: 10, cornerRadius: 0 }, [1, 0, 0, 1, 0, 0], 10, 10)).toBe("inset(50%)");
  });

  it("writes NO crop for a singular placement", () => {
    expect(overlayClipPath(RECT, [0, 0, 0, 0, 0, 0], 10, 10)).toBeNull();
  });
});

// --- the builder's half ------------------------------------------------------------------------------------------

function mkNode(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.Control",
    showBehindParent: false,
    clipChildren: 0,
    clipContents: false,
    ninePatchMargins: null,
    font: null,
    richBoldFont: null,
    richItalicFont: null,
    richBoldItalicFont: null,
    richBoldFontSizePx: null,
    richItalicFontSizePx: null,
    richBoldItalicFontSizePx: null,
    richBoldFontSpacingPx: null,
    richItalicFontSpacingPx: null,
    richBoldItalicFontSpacingPx: null,
    textWrap: null,
    shadow: null,
    richText: false,
    shaderId: null,
    materialRef: null,
    shaderParams: null,
    textureStretchMode: null,
    textureFlipH: false,
    textureFlipV: false,
    particleSpec: null,
    particleEmitting: false,
    particleRestartEpoch: 0,
    spineSceneResPath: null,
    spineNodePath: null,
    spineAnimations: null,
    spineSkelResPath: null,
    sceneFilePath: null,
    mouseFilter: null,
    anchorLeft: null,
    anchorRight: null,
    anchorOwnerId: null,
    containerLayout: null,
    contentKey: null,
    spineCurrentAnim: null,
    spineSkin: null,
    spineMat: null,
    spinePaused: false,
    spineTrackTime: 0,
    spineLooping: true,
    pinnedLoopAnim: null,
    outline: null,
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 100, height: 100 },
    visible: true,
    focused: false,
    opacity: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    pivotX: 0,
    pivotY: 0,
    zIndex: null,
    textureUrl: null,
    textureRegion: null,
    textureMargin: null,
    ninePatch: false,
    modulate: null,
    selfModulate: null,
    fillColor: null,
    range: null,
    text: null,
    intentFrames: null,
    linePoints: null,
    lineWidth: null,
    lineColor: null,
    ...over
  };
}

/** A clipper with a label inside it, the label placed at `labelY` in the clipper's own space. */
function scrolledLabel(labelY: number, options: Parameters<typeof buildDrawList>[2] = {}) {
  const clipper = mkNode("Scroll", null, {
    clipContents: true,
    localRect: { x: 0, y: 0, width: 300, height: 200 }
  });
  const label = mkNode("Label", "Scroll", {
    nodeType: "Godot.Label",
    text: { text: "hi", sizePx: 20, color: null, align: null, valign: null, autowrap: false, lines: 1 } as never,
    transform: [1, 0, 0, 1, 0, labelY],
    localRect: { x: 0, y: 0, width: 100, height: 30 }
  });
  const state = createMirrorState();
  state.nodes.set(clipper.id, clipper);
  state.nodes.set(label.id, label);
  state.orderedIds = ["Scroll", "Label"];
  state.revision = 1;
  const build = buildDrawList(state, createDrawList<string>(), options);
  return build.overlayRecords.find((r) => r.id === "Label")!;
}

describe("the builder's overlay clipping", () => {
  it("crops a label that has scrolled past its clipper's bottom edge", () => {
    const clip = scrolledLabel(190).clip;
    // The clipper is 200 tall; the label runs 190..220, so the crop is real and its bottom edge is the clipper's.
    expect(clip).not.toBeNull();
    expect(clip!.y + clip!.h).toBe(200);
  });

  it("leaves a label WELL INSIDE its clipper uncropped", () => {
    expect(scrolledLabel(20).clip).toBeNull();
  });

  it("crops a label that has scrolled entirely outside down to nothing", () => {
    const clip = scrolledLabel(400).clip;
    // Still a rect — the element stays and is merely cropped — rather than a record the overlay has to drop.
    // Inverted through the label's own placement the band ends ABOVE the element box, so nothing of it paints.
    expect(clip).not.toBeNull();
    const path = overlayClipPath(clip!, [1, 0, 0, 1, 0, 400], 100, 30)!;
    const [top, , bottom] = [...path.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
    expect(top).toBeLessThan(0);
    expect(30 - bottom).toBeLessThanOrEqual(0);
  });
});

// --- the overlay's half ------------------------------------------------------------------------------------------

let overlay: MirrorOverlay | null = null;

afterEach(() => {
  overlay?.dispose();
  overlay = null;
  document.body.innerHTML = "";
});

function mountOverlay(): HTMLElement {
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  stage.appendChild(canvas);
  document.body.appendChild(stage);
  overlay = createMirrorOverlay(stage, canvas);
  return overlay.container;
}

function nodesOf(): Map<string, MirrorNode> {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ["n"],
      upserts: [
        {
          id: "n",
          parentId: null,
          name: "n",
          nodeType: "Godot.Label",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 50 } },
          visible: true,
          text: { text: "hi" }
        }
      ]
    })!
  );
  return state.nodes;
}

function record(clip: OverlayClip | null, over: Partial<OverlayRecord> = {}): OverlayRecord {
  return {
    id: "n",
    kind: "text",
    transform: [1, 0, 0, 1, 0, 0],
    w: 100,
    h: 50,
    order: 0,
    opacity: 1,
    tintR: 1,
    tintG: 1,
    tintB: 1,
    coveredAbove: false,
    clip,
    ...over
  };
}

describe("the overlay writes the crop", () => {
  it("sets clip-path from the record and clears it when the record stops carrying one", () => {
    const container = mountOverlay();
    const nodes = nodesOf();
    overlay!.reconcile([record({ x: 0, y: 0, w: 60, h: 20, cornerRadius: 0 })], nodes);
    const el = container.querySelector<HTMLElement>('[data-node-id="n"]')!;
    expect(el.style.clipPath).toBe("inset(0px 40px 30px 0px)");
    overlay!.reconcile([record(null)], nodes);
    expect(el.style.clipPath).toBe("");
  });

  it("writes NOTHING on a second reconcile of an unmoved crop", () => {
    const container = mountOverlay();
    const nodes = nodesOf();
    const clip: OverlayClip = { x: 0, y: 0, w: 60, h: 20, cornerRadius: 0 };
    overlay!.reconcile([record(clip)], nodes);
    const el = container.querySelector<HTMLElement>('[data-node-id="n"]')!;
    let writes = 0;
    const style = el.style;
    Object.defineProperty(style, "clipPath", {
      configurable: true,
      get: () => "",
      set: () => {
        writes++;
      }
    });
    // A fresh rect OBJECT with the same numbers: the cache is thirteen numeric compares, not an identity check.
    overlay!.reconcile([record({ ...clip })], nodes);
    expect(writes).toBe(0);
  });

  it("re-writes when the placement moves under a crop that did not", () => {
    const container = mountOverlay();
    const nodes = nodesOf();
    const clip: OverlayClip = { x: 0, y: 0, w: 60, h: 20, cornerRadius: 0 };
    overlay!.reconcile([record(clip)], nodes);
    const el = container.querySelector<HTMLElement>('[data-node-id="n"]')!;
    overlay!.reconcile([record(clip, { transform: [1, 0, 0, 1, 0, 5] })], nodes);
    // The crop is in DESIGN space and the element's box is not, so scrolling the element re-inverts the rect.
    expect(el.style.clipPath).toBe("inset(-5px 40px 35px 0px)");
  });

  it("counts crops, empties and polygons in the census", () => {
    mountOverlay();
    const nodes = nodesOf();
    const flat = overlay!.reconcile([record({ x: 0, y: 0, w: 60, h: 20, cornerRadius: 0 })], nodes).counts;
    expect([flat.clipped, flat.clipEmpty, flat.clipPolygon]).toEqual([1, 0, 0]);
    const empty = overlay!.reconcile([record({ x: 0, y: 0, w: -1, h: 20, cornerRadius: 0 })], nodes).counts;
    expect([empty.clipped, empty.clipEmpty]).toEqual([1, 1]);
    const rotated = overlay!.reconcile(
      [record({ x: 0, y: 0, w: 60, h: 20, cornerRadius: 0 }, { transform: [0, 1, -1, 0, 0, 0] })],
      nodes
    ).counts;
    expect([rotated.clipped, rotated.clipPolygon]).toEqual([1, 1]);
    const none = overlay!.reconcile([record(null)], nodes).counts;
    expect(none.clipped).toBe(0);
  });
});
