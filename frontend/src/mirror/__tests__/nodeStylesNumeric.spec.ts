// The NUMERIC core of the mirror's per-node paint math (`placementBox`, `clipCornerRadius`, `atlasFitAffine`,
// `atlasCanvasFit`) and its CSS twins. A future canvas renderer consumes the numbers directly; the DOM path must
// keep emitting exactly the same strings it always did, which is only true if the CSS functions are pure
// STRINGIFIERS over the numeric ones. Every case below asserts that literally: it stringifies the numeric result
// by hand and requires the CSS the renderer would write to be byte-equal.
import { describe, expect, it } from "vitest";

import { affineCss } from "@/mirror/affine";
import {
  atlasCanvasFit,
  atlasCanvasPlacement,
  atlasFitAffine,
  clipCornerRadius,
  nodePlacementTransform,
  nodeStyle,
  placementBox,
  type RenderItem
} from "@/mirror/nodeStyles";
import type { MirrorNode } from "@/mirror/sceneTree";

function mkNode(over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id: "n",
    parentId: null,
    name: "Sprite",
    nodeType: "TextureRect",
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
    textureUrl: "/res/images/atlases/ui_atlas_0.png",
    textureRegion: null,
    textureMargin: null,
    ninePatch: false,
    modulate: null,
    selfModulate: null,
    fillColor: null,
    range: null,
    text: null,
    outline: null,
    ...over
  };
}

function item(node: MirrorNode, parentInv: RenderItem["parentInv"] = null, hasChildren = false): RenderItem {
  return { node, opacity: 1, tintId: null, parentInv, hasChildren };
}

// How the CSS twin is ALLOWED to format the numeric fit: the trailing scale, and nothing else. Written out here so
// the assertions below prove the stringifier rule rather than re-stating whatever the implementation happens to do.
function scaleCss(fit: { sx: number; sy: number; uniform: boolean }): string {
  return fit.uniform ? `scale(${fit.sx})` : `scale(${fit.sx}, ${fit.sy})`;
}

// The CORPUS: every atlas-sprite shape the mirror actually paints. Each entry is a node plus the parentInv the walk
// would hand it, since the re-basing is part of the placement affine and must survive the split too.
const CORPUS: { name: string; node: MirrorNode; parentInv?: RenderItem["parentInv"] }[] = [
  {
    // Plain FILL (stretch mode null): the region is stretched anisotropically into the Control box.
    name: "leaf fill (null stretch)",
    node: mkNode({
      textureRegion: { x: 1920, y: 627, width: 90, height: 85 },
      localRect: { x: 0, y: 0, width: 140, height: 80 },
      transform: [1, 0, 0, 1, 210, 96]
    })
  },
  {
    name: "leaf fill (Scale=0) with a rotated/scaled global",
    node: mkNode({
      textureRegion: { x: 12, y: 34, width: 100, height: 50 },
      textureStretchMode: 0,
      localRect: { x: 7, y: 11, width: 200, height: 50 },
      transform: [0.8, 0.6, -0.6, 0.8, 400, 300]
    })
  },
  {
    name: "leaf fill (Tile=1)",
    node: mkNode({
      textureRegion: { x: 0, y: 0, width: 64, height: 64 },
      textureStretchMode: 1,
      localRect: { x: 0, y: 0, width: 300, height: 64 }
    })
  },
  {
    // The real top-bar deck icon: a 72x72 Control painting a 114x98 region, keep-aspect (the uniform CONTAIN fit,
    // whose CSS is the ONE-argument `scale(fit)` — the case the `uniform` flag exists for).
    name: "leaf keep-aspect (deck icon)",
    node: mkNode({
      textureRegion: { x: 1920, y: 423, width: 114, height: 98 },
      textureStretchMode: 5,
      localRect: { x: 0, y: 0, width: 72, height: 72 },
      transform: [1, 0, 0, 1, 4, 4]
    })
  },
  {
    name: "leaf keep-aspect, height-bound",
    node: mkNode({
      textureRegion: { x: 0, y: 0, width: 100, height: 100 },
      textureStretchMode: 2,
      localRect: { x: 0, y: 0, width: 400, height: 50 }
    })
  },
  {
    name: "leaf fill, flipped H",
    node: mkNode({
      textureRegion: { x: 0, y: 0, width: 100, height: 50 },
      textureStretchMode: 0,
      textureFlipH: true,
      localRect: { x: 0, y: 0, width: 200, height: 50 }
    })
  },
  {
    name: "leaf fill, flipped V",
    node: mkNode({
      textureRegion: { x: 0, y: 0, width: 100, height: 50 },
      textureStretchMode: 0,
      textureFlipV: true,
      localRect: { x: 5, y: 9, width: 200, height: 120 }
    })
  },
  {
    name: "leaf fill, flipped BOTH, non-zero box origin",
    node: mkNode({
      textureRegion: { x: 300, y: 400, width: 33, height: 17 },
      textureStretchMode: 0,
      textureFlipH: true,
      textureFlipV: true,
      localRect: { x: -12, y: 25, width: 66, height: 51 },
      transform: [2, 0, 0, 2, 100, 80]
    })
  },
  {
    // A trimmed AtlasTexture: the margin re-inflates the region to its authored size, so the fit divides by the
    // MARGINED box and the placement origin is pushed by the margin offset (scaled).
    name: "leaf fill with a texture MARGIN",
    node: mkNode({
      textureRegion: { x: 8, y: 8, width: 40, height: 30 },
      textureMargin: { x: 5, y: 3, width: 20, height: 10 },
      textureStretchMode: 0,
      localRect: { x: 0, y: 0, width: 120, height: 80 }
    })
  },
  {
    name: "leaf keep-aspect with a texture MARGIN and a flip",
    node: mkNode({
      textureRegion: { x: 8, y: 8, width: 40, height: 30 },
      textureMargin: { x: -4, y: 6, width: 12, height: 12 },
      textureStretchMode: 4,
      textureFlipH: true,
      localRect: { x: 3, y: 3, width: 90, height: 200 },
      transform: [1.5, 0, 0, 1.5, -20, 5]
    })
  },
  {
    // Re-based into a clipper's frame: `parentInv` composes into the SAME matrix the CSS emits.
    name: "leaf fill re-based by parentInv",
    node: mkNode({
      textureRegion: { x: 0, y: 0, width: 60, height: 60 },
      textureStretchMode: 0,
      localRect: { x: 0, y: 0, width: 120, height: 60 },
      transform: [1, 0, 0, 1, 205, 96]
    }),
    parentInv: [1, 0, 0, 1, -200, -100]
  },
  {
    name: "leaf keep-aspect re-based by a SCALING parentInv",
    node: mkNode({
      textureRegion: { x: 0, y: 0, width: 114, height: 98 },
      textureStretchMode: 5,
      localRect: { x: 3, y: 7, width: 72, height: 72 },
      transform: [2, 0, 0, 2, 100, 80]
    }),
    parentInv: [0.5, 0, 0, 0.5, -40, -45]
  }
];

// The INTERIOR twin: the same nodes as containers (hasChildren), where the fit rides the canvas instead of the el.
const INTERIOR: { name: string; node: MirrorNode }[] = [
  {
    name: "interior keep-aspect (the map-legend shape)",
    node: mkNode({
      textureRegion: { x: 0, y: 0, width: 100, height: 100 },
      textureStretchMode: 5,
      localRect: { x: 0, y: 0, width: 50, height: 100 },
      transform: [1, 0, 0, 1, 30, 40]
    })
  },
  {
    name: "interior fill, flipped H",
    node: mkNode({
      textureRegion: { x: 0, y: 0, width: 100, height: 50 },
      textureStretchMode: 0,
      textureFlipH: true,
      localRect: { x: 0, y: 0, width: 200, height: 50 }
    })
  },
  {
    name: "interior fill with a texture MARGIN, flipped V",
    node: mkNode({
      textureRegion: { x: 8, y: 8, width: 40, height: 30 },
      textureMargin: { x: 5, y: 3, width: 20, height: 10 },
      textureStretchMode: 0,
      textureFlipV: true,
      localRect: { x: 4, y: 4, width: 120, height: 80 }
    })
  }
];

describe("atlasFitAffine — the numeric core the CSS placement stringifies", () => {
  for (const entry of CORPUS) {
        it(`${entry.name}: the emitted CSS is exactly the numeric result, stringified`, () => {
          const it_ = item(entry.node, entry.parentInv ?? null);
          const lr = placementBox(entry.node);
          const fit = atlasFitAffine(it_, entry.node.transform, lr)!;
          expect(fit).not.toBeNull();
          // Snapshot the numbers BEFORE calling the CSS path: under the diet both the result object and its
          // matrix are module scratch, and the CSS call is exactly the "next call" that invalidates them.
          const expected = {
            transform: `${affineCss([...fit.m] as typeof fit.m)} ${scaleCss(fit)}`,
            width: `${fit.w}px`,
            height: `${fit.h}px`
          };

          const style = nodeStyle(it_);
          expect(style.transform).toBe(expected.transform);
          expect(style.width).toBe(expected.width);
          expect(style.height).toBe(expected.height);
          expect(style.transformOrigin).toBe("0 0");
          // The ancestor-affine fast path emits the same placement through the same seam.
          expect(nodePlacementTransform(it_)!.transform).toBe(expected.transform);
        });
  }

  it("declines for the shapes the base placement owns (interior / nine-patch / non-atlas)", () => {
    const node = CORPUS[0].node;
    // INTERIOR: the fit would cascade onto the DOM-nested children, so the element keeps the pure placement.
    expect(atlasFitAffine(item(node, null, true), node.transform, placementBox(node))).toBeNull();
    // Nine-patch-over-atlas is the 9-slice path.
    const np = mkNode({
      ...node,
      ninePatch: true,
      ninePatchMargins: { left: 4, top: 4, right: 4, bottom: 4 }
    });
    expect(atlasFitAffine(item(np), np.transform, placementBox(np))).toBeNull();
    // No region at all → a plain CSS background, no fit.
    const plain = mkNode({ textureRegion: null });
    expect(atlasFitAffine(item(plain), plain.transform, placementBox(plain))).toBeNull();
    // Degenerate texture box (margin cancels the region) → no fit computable.
    const degenerate = mkNode({
      textureRegion: { x: 0, y: 0, width: 40, height: 30 },
      textureMargin: { x: 0, y: 0, width: -40, height: 0 }
    });
    expect(atlasFitAffine(item(degenerate), degenerate.transform, placementBox(degenerate))).toBeNull();
  });

  it("the uniform CONTAIN fit is what makes the CSS collapse to one-argument scale()", () => {
    const contain = CORPUS.find((c) => c.name === "leaf keep-aspect (deck icon)")!;
    const fitted = atlasFitAffine(item(contain.node), contain.node.transform, placementBox(contain.node))!;
    expect(fitted.uniform).toBe(true);
    expect(fitted.sx).toBe(fitted.sy);
    expect(nodeStyle(item(contain.node)).transform).toContain(`scale(${fitted.sx})`);

    // A FILL whose two axes happen to be EQUAL is still not `uniform`, and still emits both arguments — that is
    // the whole reason the flag has to be carried rather than re-derived from `sx === sy`.
    const square = mkNode({
      textureRegion: { x: 0, y: 0, width: 50, height: 50 },
      textureStretchMode: 0,
      localRect: { x: 0, y: 0, width: 100, height: 100 }
    });
    const squareFit = atlasFitAffine(item(square), square.transform, placementBox(square))!;
    expect(squareFit.sx).toBe(squareFit.sy);
    expect(squareFit.uniform).toBe(false);
    expect(nodeStyle(item(square)).transform).toContain("scale(2, 2)");
  });

  it("a flipped axis is a NEGATIVE scale in the numbers, not just in the string", () => {
    const flipped = CORPUS.find((c) => c.name === "leaf fill, flipped BOTH, non-zero box origin")!;
    const fitted = atlasFitAffine(item(flipped.node), flipped.node.transform, placementBox(flipped.node))!;
    expect(fitted.sx).toBeLessThan(0);
    expect(fitted.sy).toBeLessThan(0);
    // …and the origin compensation lands in `m`, so `m` + (sx, sy) alone reproduce the element placement.
    expect(nodeStyle(item(flipped.node)).transform).toBe(`${affineCss(fitted.m)} ${scaleCss(fitted)}`);
  });

  it("uses transient scratch for the CSS placement path", () => {
    const entry = CORPUS[0];
    const a = atlasFitAffine(item(entry.node), entry.node.transform, placementBox(entry.node), true);
    const b = atlasFitAffine(item(entry.node), entry.node.transform, placementBox(entry.node), true);
    expect(a).toBe(b); // one module tuple, reused — callers must consume it immediately
    expect(a!.m).toBe(b!.m);
  });
});

describe("atlasCanvasFit — the numeric core of the interior node's canvas placement", () => {
  for (const entry of INTERIOR) {
    it(`${entry.name}: the emitted CSS is exactly the numeric result, stringified`, () => {
      const fit = atlasCanvasFit(entry.node)!;
      expect(fit).not.toBeNull();
      expect(atlasCanvasPlacement(entry.node)).toEqual({
        width: `${fit.w}px`,
        height: `${fit.h}px`,
        transform: `translate(${fit.dx}px, ${fit.dy}px) ${scaleCss(fit)}`
      });
    });
  }

  it("carries the fit the LEAF bakes into its element, with the box origin cancelled out", () => {
    // Same node twice: once as a leaf (fit in the el transform), once as an interior container (fit on the canvas).
    // The canvas offset is the leaf's placement translation minus the localRect origin the container already sits at.
    const node = mkNode({
      textureRegion: { x: 0, y: 0, width: 100, height: 100 },
      textureStretchMode: 5,
      localRect: { x: 12, y: 20, width: 50, height: 100 },
      transform: [1, 0, 0, 1, 30, 40]
    });
    const leaf = atlasFitAffine(item(node), node.transform, placementBox(node))!;
    const canvas = atlasCanvasFit(node)!;
    expect(canvas.sx).toBe(leaf.sx);
    expect(canvas.sy).toBe(leaf.sy);
    expect(canvas.uniform).toBe(leaf.uniform);
    expect(canvas.w).toBe(leaf.w);
    expect(canvas.h).toBe(leaf.h);
    // The leaf's matrix is `nodeMatrix(transform, boxOrigin + fitOffset)`; with an identity-linear transform its
    // translation is the global translation + the box origin + the offset the canvas carries on its own.
    expect(leaf.m[4] - node.transform![4] - node.localRect!.x).toBeCloseTo(canvas.dx, 10);
    expect(leaf.m[5] - node.transform![5] - node.localRect!.y).toBeCloseTo(canvas.dy, 10);
  });

  it("declines exactly where the CSS twin declines", () => {
    expect(atlasCanvasFit(mkNode({ textureRegion: null }))).toBeNull();
    expect(atlasCanvasPlacement(mkNode({ textureRegion: null }))).toBeNull();
    const boxless = mkNode({ textureRegion: { x: 0, y: 0, width: 8, height: 8 }, localRect: null });
    expect(atlasCanvasFit(boxless)).toBeNull();
    expect(atlasCanvasPlacement(boxless)).toBeNull();
  });

  it("keeps the numeric core safe to retain while the CSS twin uses scratch", () => {
    const node = INTERIOR[0].node;
    const a = atlasCanvasFit(node);
    const b = atlasCanvasFit(node);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(atlasCanvasFit(node, true)).toBe(atlasCanvasFit(node, true));
    expect(atlasCanvasPlacement(node)).toEqual(atlasCanvasPlacement(node));
  });
});

describe("placementBox / clipCornerRadius — the numeric placement inputs", () => {
  it("placementBox is the localRect, or the zero box the box-less paint kinds anchor at", () => {
    expect(placementBox(mkNode({ localRect: { x: 3, y: 4, width: 10, height: 20 } }))).toEqual({
      x: 3,
      y: 4,
      width: 10,
      height: 20
    });
    // A rect-only / box-less Control has NO placement box: nodeStyle falls through to the legacy `rect` branch.
    expect(placementBox(mkNode({ localRect: null }))).toBeNull();
    // A GpuParticles2D streams no localRect but must still be placed AT its transform.
    const particle = mkNode({
      nodeType: "GPUParticles2D",
      localRect: null,
      particleSpec: { kind: "GPUParticles2D" } as unknown as MirrorNode["particleSpec"]
    });
    expect(placementBox(particle)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(nodeStyle(item(particle)).width).toBe("0px");
    // A Line2D map stroke is the same shape.
    const stroke = mkNode({ nodeType: "Line2D", localRect: null, linePoints: [0, 0, 10, 10] } as Partial<MirrorNode>);
    expect(placementBox(stroke)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("clipCornerRadius is the px number nodeStyle writes as `border-radius`", () => {
    const capsule = mkNode({
      nodeType: "NinePatchRect",
      ninePatch: true,
      clipChildren: 1,
      textureUrl: "/res/images/ui/combat/health_bar.png",
      ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 },
      localRect: { x: 0, y: 0, width: 250, height: 16 }
    });
    const radius = clipCornerRadius(capsule);
    expect(radius).toBe(6);
    expect(nodeStyle(item(capsule)).borderRadius).toBe(`${radius}px`);

    // The half-box clamps are about the RENDERED box (R19 6c), so the override moves the number.
    const wide = mkNode({
      ...capsule,
      ninePatchMargins: { left: 400, top: 400, right: 400, bottom: 400 },
      localRect: { x: 0, y: 0, width: 600, height: 1000 }
    });
    expect(clipCornerRadius(wide)).toBe(300); // half the streamed width
    expect(clipCornerRadius(wide, 1200)).toBe(400); // the margin itself, once the box is wide enough
    expect(nodeStyle({ ...item(wide), renderWidthOverride: 1200 }).borderRadius).toBe("400px");

    // No rounding to describe → 0, and nodeStyle emits no radius at all.
    const square = mkNode({ ninePatchMargins: null, clipChildren: 1 });
    expect(clipCornerRadius(square)).toBe(0);
    expect(nodeStyle(item(square)).borderRadius).toBeUndefined();
  });
});
