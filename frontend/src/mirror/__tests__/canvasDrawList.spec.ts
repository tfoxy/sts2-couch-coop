// THE DRAW-LIST BUILDER: what one node contributes, and what the walk guarantees about the stream.
//
// The paint assertions are CROSS-CHECKS, not restatements. `nodeStylesNumeric.spec.ts` already pins the numeric
// core (`atlasFitAffine`, `atlasCanvasFit`, `clipCornerRadius`, `placementBox`) byte-for-byte against the CSS the
// DOM backend emits; this file pins the draw list against that same core. So a quad proved equal to
// `atlasFitAffine` here is, transitively, proved equal to the CSS the browser paints — without either file having
// to parse the other's strings.

import { describe, expect, it } from "vitest";
import { normalizeParticleSpecConfig } from "@godot-scene-web/html/runtime";

import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_NINE_PATCH,
  DRAW_POLYLINE,
  DRAW_QUAD,
  createClipRectView,
  createDrawList,
  createNinePatchView,
  createPolylineView,
  createQuadView
} from "@godot-scene-web/canvas";

import { nodeMatrix, type Affine } from "@/mirror/affine";
import { buildDrawList, streamedAlphasOf } from "@/mirror/canvas/buildDrawList";
import { classifyNode, createPaintScratch, normalizeFlip, overlayKindOf } from "@/mirror/canvas/paintSpec";
import { ninePatchAtlasQuads, ninePatchAtlasSlices } from "@/mirror/ninePatch";
import { atlasFitAffine, type RenderItem } from "@/mirror/nodeStyles";
import { createMirrorState, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import { __recordTextureSizeForTest } from "@/mirror/textureCache";

const ATLAS = "/res/images/atlases/ui_atlas_0.png";

function mkNode(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.TextureRect",
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

function color(r: number, g: number, b: number, a: number) {
  return { r, g, b, a, html: "#000000" };
}

/** A state whose `orderedIds` is the producer's pre-order DFS over `nodes` (parents must precede their children). */
function mkState(nodes: MirrorNode[]): MirrorState {
  const state = createMirrorState();
  for (const node of nodes) {
    state.nodes.set(node.id, node);
  }
  state.orderedIds = nodes.map((n) => n.id);
  state.revision = 1;
  return state;
}

function build(nodes: MirrorNode[], options: Parameters<typeof buildDrawList>[2] = {}) {
  const list = createDrawList<string>();
  const classes = new Map<string, string>();
  const result = buildDrawList(mkState(nodes), list, {
    ...options,
    onNode: (id, cls) => classes.set(id, cls)
  });
  return { list, result, classes };
}

/** Map a point in a quad's local [0,w]x[0,h] box into design space through its 2x3. */
function apply(m: ArrayLike<number>, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function expectClose(actual: readonly number[], expected: readonly number[], eps = 1e-4): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 4);
  }
  void eps;
}

// --- the scratch views ------------------------------------------------------------------------------------------

describe("createPaintScratch", () => {
  it("is field-for-field gsw's own view constructors — the one place this repo restates them", () => {
    const scratch = createPaintScratch(8);
    const quad = createQuadView();
    expect(Object.keys(scratch.quad).sort()).toEqual(Object.keys(quad).sort());
    for (const key of Object.keys(quad) as (keyof typeof quad)[]) {
      const mine = scratch.quad[key];
      const theirs = quad[key];
      if (mine instanceof Float32Array && theirs instanceof Float32Array) {
        expect([...mine]).toEqual([...theirs]);
      } else {
        expect(mine).toEqual(theirs);
      }
    }
    const nine = createNinePatchView();
    expect(Object.keys(scratch.nine).sort()).toEqual(Object.keys(nine).sort());
    expect([scratch.nine.marginLeft, scratch.nine.marginTop, scratch.nine.marginRight, scratch.nine.marginBottom])
      .toEqual([nine.marginLeft, nine.marginTop, nine.marginRight, nine.marginBottom]);
    const line = createPolylineView(8);
    expect(Object.keys(scratch.line).sort()).toEqual(Object.keys(line).sort());
    expect(scratch.line.points.length).toBe(line.points.length);
    expect(scratch.line.pointCount).toBe(line.pointCount);
    expect(scratch.line.width).toBe(line.width);
  });
});

describe("client hand-raise chrome ordering", () => {
  it("emits in the combat-pile node range before later hand and modal siblings", () => {
    const nodes = [
      mkNode("Root", null, { nodeType: "Control", localRect: { x: 0, y: 0, width: 1920, height: 1080 } }),
      mkNode("Piles", "Root", {
        nodeType: "NCombatPilesContainer",
        sceneFilePath: "res://scenes/combat/combat_piles_container.tscn",
        localRect: { x: 0, y: 0, width: 1920, height: 1080 }
      }),
      mkNode("Hand", "Root", { fillColor: color(1, 0, 0, 1) }),
      mkNode("Backstop", "Root", {
        localRect: { x: 0, y: 0, width: 1920, height: 1080 },
        fillColor: color(0, 0, 0, 0.9)
      })
    ];
    const { list, result } = build(nodes, {
      handRaiseChrome: {
        emit(_input, scratch, sink) {
          const q = scratch.quad;
          q.m.set([1, 0, 0, 1, 1700, 980]);
          q.w = 100; q.h = 70;
          q.srcX = 0; q.srcY = 0; q.srcW = 166; q.srcH = 121;
          q.r = q.g = q.b = q.a = 1;
          q.blend = 0; q.flipH = q.flipV = false; q.hasColorMatrix = false;
          sink.quad(q, "client://hand-raise");
          return 1;
        }
      }
    });

    expect(result.handRaiseAnchorId).toBe("Piles");
    expect(result.handRaiseChromeCommand).toBe(0);
    expect(list.textureAt(0)).toBe("client://hand-raise");
    expect(result.order.orderOf("Hand")).toBeLessThan(result.order.orderOf("Backstop"));
    expect(list.count).toBe(3);
  });

  it("is byte-identical without the optional chrome source", () => {
    const piles = mkNode("Piles", null, { nodeType: "NCombatPilesContainer" });
    const without = build([piles]);
    expect(without.list.count).toBe(0);
    expect(without.result.handRaiseChromeCommand).toBe(-1);
    expect(without.result.handRaiseAnchorId).toBe("Piles");
  });
});

// --- the flip normalisation -------------------------------------------------------------------------------------

describe("normalizeFlip", () => {
  it("turns a mirrored destination into an unmirrored one plus a source flip — the same picture", () => {
    for (const base of [
      [1, 0, 0, 1, 30, 40],
      [0.8, 0.6, -0.6, 0.8, 400, 300],
      [2, 0, 0, 0.5, -12, 7]
    ] as Affine[]) {
      const w = 90;
      const h = 55;
      for (const [fh, fv] of [
        [true, false],
        [false, true],
        [true, true]
      ]) {
        const mirrored: Affine = [
          base[0] * (fh ? -1 : 1),
          base[1] * (fh ? -1 : 1),
          base[2] * (fv ? -1 : 1),
          base[3] * (fv ? -1 : 1),
          base[4],
          base[5]
        ];
        const normalized = mirrored.slice() as Affine;
        const flip = normalizeFlip(normalized, w, h, fh, fv);
        expect(flip).toEqual({ h: fh, v: fv });
        // Every corner of the normalized quad maps where the mirrored one maps its MIRRORED corner.
        for (const [x, y] of [
          [0, 0],
          [w, 0],
          [0, h],
          [w, h],
          [w / 3, h / 7]
        ]) {
          expectClose(apply(normalized, x, y), apply(mirrored, fh ? w - x : x, fv ? h - y : y));
        }
      }
    }
  });
});

// --- atlas sprites, against the numeric core the CSS is stringified from ------------------------------------------

describe("atlas-region quads vs nodeStyles.atlasFitAffine", () => {
  // The corpus of nodeStylesNumeric.spec.ts's atlas shapes, plus the two flips.
  const CORPUS: { name: string; node: MirrorNode }[] = [
    {
      name: "fill, null stretch",
      node: mkNode("a", null, {
        textureUrl: ATLAS,
        textureRegion: { x: 1920, y: 627, width: 90, height: 85 },
        localRect: { x: 0, y: 0, width: 140, height: 80 },
        transform: [1, 0, 0, 1, 210, 96]
      })
    },
    {
      name: "fill (Scale=0) under a rotated/scaled global",
      node: mkNode("a", null, {
        textureUrl: ATLAS,
        textureRegion: { x: 12, y: 34, width: 100, height: 50 },
        textureStretchMode: 0,
        localRect: { x: 7, y: 11, width: 200, height: 50 },
        transform: [0.8, 0.6, -0.6, 0.8, 400, 300]
      })
    },
    {
      name: "keep-aspect (the top-bar deck icon)",
      node: mkNode("a", null, {
        textureUrl: ATLAS,
        textureRegion: { x: 1920, y: 423, width: 114, height: 98 },
        textureStretchMode: 5,
        localRect: { x: 0, y: 0, width: 72, height: 72 },
        transform: [1, 0, 0, 1, 4, 4]
      })
    },
    {
      name: "fill with a texture margin",
      node: mkNode("a", null, {
        textureUrl: ATLAS,
        textureRegion: { x: 40, y: 40, width: 60, height: 30 },
        textureMargin: { x: 4, y: 6, width: 10, height: 12 },
        localRect: { x: 3, y: 5, width: 120, height: 90 },
        transform: [1, 0, 0, 1, 11, 13]
      })
    },
    {
      name: "flipH",
      node: mkNode("a", null, {
        textureUrl: ATLAS,
        textureRegion: { x: 0, y: 0, width: 64, height: 64 },
        textureFlipH: true,
        localRect: { x: 0, y: 0, width: 128, height: 64 },
        transform: [1, 0, 0, 1, 20, 30]
      })
    },
    {
      name: "flipH + flipV with a margin",
      node: mkNode("a", null, {
        textureUrl: ATLAS,
        textureRegion: { x: 8, y: 9, width: 50, height: 40 },
        textureMargin: { x: 2, y: 3, width: 6, height: 8 },
        textureFlipH: true,
        textureFlipV: true,
        localRect: { x: 1, y: 2, width: 90, height: 70 },
        transform: [1.5, 0, 0, 1.5, 5, 6]
      })
    }
  ];

  for (const entry of CORPUS) {
    it(`places ${entry.name} exactly where the DOM's fit places it`, () => {
      const { list } = build([entry.node]);
      expect(list.count).toBe(1);
      expect(list.kindAt(0)).toBe(DRAW_QUAD);
      expect(list.textureAt(0)).toBe(ATLAS);
      const view = list.readQuad(0, createQuadView());

      const item: RenderItem = { node: entry.node, opacity: 1, tintId: null, parentInv: null, hasChildren: false };
      const fit = atlasFitAffine(item, entry.node.transform, entry.node.localRect, false)!;
      expect(fit).not.toBeNull();
      // The element the CSS builds: `matrix(fit.m) scale(fit.sx, fit.sy)` over a `fit.w x fit.h` box, origin 0 0.
      const css: Affine = [fit.m[0] * fit.sx, fit.m[1] * fit.sx, fit.m[2] * fit.sy, fit.m[3] * fit.sy, fit.m[4], fit.m[5]];

      expect(view.w).toBe(fit.w);
      expect(view.h).toBe(fit.h);
      expect(view.srcX).toBe(entry.node.textureRegion!.x);
      expect(view.srcY).toBe(entry.node.textureRegion!.y);
      expect(view.srcW).toBe(entry.node.textureRegion!.width);
      expect(view.srcH).toBe(entry.node.textureRegion!.height);
      expect(view.flipH).toBe(entry.node.textureFlipH);
      expect(view.flipV).toBe(entry.node.textureFlipV);
      // The quad paints the same pixels at the same places: local (x, y) of the quad is the CSS element's
      // (flipped) local point, because a source flip and a destination mirror are the same picture.
      for (const [x, y] of [
        [0, 0],
        [fit.w, 0],
        [0, fit.h],
        [fit.w, fit.h],
        [fit.w / 3, fit.h / 5]
      ]) {
        expectClose(
          apply(view.m, x, y),
          apply(css, entry.node.textureFlipH ? fit.w - x : x, entry.node.textureFlipV ? fit.h - y : y)
        );
      }
    });
  }
});

// --- nine-patch --------------------------------------------------------------------------------------------------

describe("nine-patch commands", () => {
  it("carries the region + patch margins the DOM's own band algebra expands", () => {
    __recordTextureSizeForTest(ATLAS, 2048, 2048);
    const node = mkNode("np", null, {
      nodeType: "Godot.NinePatchRect",
      textureUrl: ATLAS,
      ninePatch: true,
      textureRegion: { x: 100, y: 200, width: 60, height: 40 },
      ninePatchMargins: { left: 12, top: 10, right: 14, bottom: 8 },
      localRect: { x: 0, y: 0, width: 300, height: 120 },
      transform: [1, 0, 0, 1, 50, 60]
    });
    const { list } = build([node]);
    expect(list.count).toBe(1);
    expect(list.kindAt(0)).toBe(DRAW_NINE_PATCH);
    const view = list.readNinePatch(0, createNinePatchView());
    expect([view.srcX, view.srcY, view.srcW, view.srcH]).toEqual([100, 200, 60, 40]);
    expect([view.marginLeft, view.marginTop, view.marginRight, view.marginBottom]).toEqual([12, 10, 14, 8]);
    expect([view.w, view.h]).toEqual([300, 120]);
    expectClose([...view.m], [1, 0, 0, 1, 50, 60]);

    // The executor's expansion is `ninePatchAtlasQuads` over exactly these numbers — the same decomposition the
    // DOM's 9 spans are framed from, so one command and nine CSS spans describe the same geometry.
    const quads = ninePatchAtlasQuads(
      { x: view.srcX, y: view.srcY, width: view.srcW, height: view.srcH },
      { left: view.marginLeft, top: view.marginTop, right: view.marginRight, bottom: view.marginBottom },
      { width: view.w, height: view.h },
      { width: 2048, height: 2048 }
    );
    const slices = ninePatchAtlasSlices(
      node.textureRegion!,
      node.ninePatchMargins!,
      { width: node.localRect!.width, height: node.localRect!.height },
      { width: 2048, height: 2048 }
    );
    expect(quads.length).toBe(slices.length);
    expect(quads.length).toBe(9);
    for (let i = 0; i < quads.length; i++) {
      expect([quads[i].dst.x, quads[i].dst.y, quads[i].dst.w, quads[i].dst.h]).toEqual([
        slices[i].left,
        slices[i].top,
        slices[i].width,
        slices[i].height
      ]);
    }
  });

  it("reports a whole-image nine-patch's source only once the image size is known", () => {
    const node = mkNode("np2", null, {
      nodeType: "Godot.NinePatchRect",
      textureUrl: "/res/images/packed/panel.png",
      ninePatch: true,
      ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 },
      localRect: { x: 0, y: 0, width: 200, height: 100 }
    });
    const unmeasured = build([node]).list;
    expect(unmeasured.readNinePatch(0, createNinePatchView()).srcW).toBe(0); // "the whole texture"

    __recordTextureSizeForTest("/res/images/packed/panel.png", 64, 32);
    const measured = build([node]).list;
    const view = measured.readNinePatch(0, createNinePatchView());
    expect([view.srcW, view.srcH]).toEqual([64, 32]);
  });
});

// --- plain textures ------------------------------------------------------------------------------------------------

describe("plain-texture quads", () => {
  const url = "/res/images/packed/bg.png";

  it("fills the box for Scale/Tile, and centres a keep-aspect CONTAIN fit", () => {
    const size = { width: 200, height: 100 };
    const node = mkNode("t", null, {
      textureUrl: url,
      localRect: { x: 0, y: 0, width: 400, height: 400 },
      transform: [1, 0, 0, 1, 0, 0]
    });
    const fill = build([node], { textureSize: () => size }).list.readQuad(0, createQuadView());
    expect([fill.w, fill.h]).toEqual([400, 400]);
    expectClose([...fill.m], [1, 0, 0, 1, 0, 0]);
    expect([fill.srcW, fill.srcH]).toEqual([200, 100]);

    // KeepAspectCentered (5) → contain: 400x200 centred vertically in the 400x400 box.
    const contained = build([mkNode("t", null, { ...node, textureStretchMode: 5 })], {
      textureSize: () => size
    }).list.readQuad(0, createQuadView());
    expect([contained.w, contained.h]).toEqual([400, 200]);
    expectClose([...contained.m], [1, 0, 0, 1, 0, 100]);
  });

  it("crops the SOURCE for a keep-aspect COVER fit, as `background-size: cover` does", () => {
    const covered = build(
      [
        mkNode("t", null, {
          textureUrl: url,
          textureStretchMode: 6,
          localRect: { x: 0, y: 0, width: 400, height: 400 }
        })
      ],
      { textureSize: () => ({ width: 200, height: 100 }) }
    ).list.readQuad(0, createQuadView());
    expect([covered.w, covered.h]).toEqual([400, 400]);
    // scale = max(400/200, 400/100) = 4 ⇒ the source window is 100x100, centred on a 200x100 image.
    expect([covered.srcX, covered.srcY, covered.srcW, covered.srcH]).toEqual([50, 0, 100, 100]);
  });

  it("falls back to filling the box while the image size is unknown", () => {
    const view = build(
      [mkNode("t", null, { textureUrl: url, textureStretchMode: 5, localRect: { x: 0, y: 0, width: 400, height: 400 } })],
      { textureSize: () => null }
    ).list.readQuad(0, createQuadView());
    expect([view.w, view.h]).toEqual([400, 400]);
    expect([view.srcW, view.srcH]).toEqual([0, 0]);
  });
});

// --- colour, alpha and blend ---------------------------------------------------------------------------------------

describe("tint composition", () => {
  it("cascades modulate and applies self_modulate to the node's OWN paint only", () => {
    const parent = mkNode("P", null, {
      nodeType: "Godot.Control",
      modulate: color(0.5, 1, 1, 0.5),
      selfModulate: color(1, 0.25, 1, 0.5),
      fillColor: color(1, 1, 1, 1)
    });
    const child = mkNode("C", "P", { fillColor: color(1, 1, 1, 1) });
    const { list } = build([parent, child]);
    expect(list.count).toBe(2);

    // Parent's own paint: modulate × self_modulate on BOTH rgb and alpha.
    const own = list.readQuad(0, createQuadView());
    expect(own.a).toBeCloseTo(0.25, 6);
    expect(own.r).toBeCloseTo(0.5 * 1 * 0.25, 6); // premultiplied
    expect(own.g).toBeCloseTo(1 * 0.25 * 0.25, 6);

    // Child: only the parent's MODULATE cascaded — never its self_modulate.
    const kid = list.readQuad(1, createQuadView());
    expect(kid.a).toBeCloseTo(0.5, 6);
    expect(kid.r).toBeCloseTo(0.5 * 0.5, 6);
    expect(kid.g).toBeCloseTo(1 * 0.5, 6);
  });

  it("passes Godot's CanvasItem blend mode straight through — the two enums are the same numbers", () => {
    const at = (mode: number | undefined) =>
      build([mkNode("b", null, { fillColor: color(1, 1, 1, 1), canvasBlendMode: mode })]).list.readQuad(
        0,
        createQuadView()
      ).blend;
    expect(at(undefined)).toBe(BLEND_MIX);
    expect(at(1)).toBe(BLEND_ADD);
    expect(at(3)).toBe(BLEND_MUL);
  });

  it("reports the streamed alphas the walk itself composes from", () => {
    // The helper the tier-3 patcher reads a NON-walked node's alpha through. It is the walk's own two lines, so
    // the cases that matter are the fallbacks: `opacity` when there is no modulate, and 1 when there is no
    // self-modulate.
    const out = { mod: -1, self: -1 };
    expect(streamedAlphasOf(mkNode("a", null, { opacity: 0.4 }), out)).toBe(out);
    expect([out.mod, out.self]).toEqual([0.4, 1]);

    streamedAlphasOf(mkNode("b", null, { opacity: 0.4, modulate: color(1, 1, 1, 0.25) }), out);
    expect([out.mod, out.self]).toEqual([0.25, 1]);

    streamedAlphasOf(
      mkNode("c", null, { opacity: 1, modulate: color(1, 1, 1, 0.5), selfModulate: color(1, 1, 1, 0.75) }),
      out
    );
    expect([out.mod, out.self]).toEqual([0.5, 0.75]);
  });

  it("composes a quad's alpha out of exactly those two streamed halves", () => {
    // The join between the helper and the list: whatever `streamedAlphasOf` reports for parent and child is what
    // the quads carry (cascade × own), which is what makes a patcher's multiplier derivable without a re-walk.
    const parent = mkNode("P", null, { nodeType: "Godot.Control", modulate: color(1, 1, 1, 0.5), fillColor: color(1, 1, 1, 1) });
    const child = mkNode("C", "P", { selfModulate: color(1, 1, 1, 0.5), fillColor: color(1, 1, 1, 1) });
    const { list } = build([parent, child]);
    const p = { mod: 0, self: 0 };
    const c = { mod: 0, self: 0 };
    streamedAlphasOf(parent, p);
    streamedAlphasOf(child, c);
    expect(list.readQuad(0, createQuadView()).a).toBeCloseTo(p.mod * p.self, 6);
    expect(list.readQuad(1, createQuadView()).a).toBeCloseTo(p.mod * c.mod * c.self, 6);
  });

  it("emits nothing for a node faded below the paint threshold", () => {
    const { list, classes } = build([
      mkNode("f", null, { fillColor: color(1, 1, 1, 1), modulate: color(1, 1, 1, 0.01) })
    ]);
    expect(list.count).toBe(0);
    expect(classes.get("f")).toBe("skip");
  });
});

// --- other paint kinds ------------------------------------------------------------------------------------------

describe("other paint kinds", () => {
  it("emits a Line2D stroke as a design-space polyline", () => {
    const { list } = build([
      mkNode("stroke", null, {
        nodeType: "Godot.Line2D",
        localRect: null,
        transform: [2, 0, 0, 2, 100, 50],
        linePoints: [0, 0, 10, 0, 10, 10],
        lineWidth: 4,
        lineColor: color(1, 0, 0, 1)
      })
    ]);
    expect(list.count).toBe(1);
    expect(list.kindAt(0)).toBe(DRAW_POLYLINE);
    const view = list.readPolyline(0, createPolylineView());
    expect(view.pointCount).toBe(3);
    expect([...view.points.slice(0, 6)]).toEqual([100, 50, 120, 50, 120, 70]);
    expect(view.width).toBe(8); // 4 node-local px under a uniform 2x global
    expect(view.r).toBeCloseTo(1, 6);
    expect(view.g).toBeCloseTo(0, 6);
  });

  it("emits a Range bar as a percentage-wide quad", () => {
    const { list } = build([
      mkNode("bar", null, {
        nodeType: "Godot.ProgressBar",
        localRect: { x: 0, y: 0, width: 200, height: 20 },
        range: { value: 3, min: 0, max: 4 }
      })
    ]);
    expect(list.count).toBe(1);
    const view = list.readQuad(0, createQuadView());
    expect(view.w).toBe(150);
    expect(view.h).toBe(20);
    expect(view.a).toBeCloseTo(0.55, 6);
  });

  it("layers a fill_color under the node's texture, in the DOM's own order", () => {
    __recordTextureSizeForTest(ATLAS, 2048, 2048);
    const { list } = build([
      mkNode("both", null, {
        fillColor: color(0, 0, 1, 1),
        textureUrl: ATLAS,
        localRect: { x: 0, y: 0, width: 50, height: 50 }
      })
    ]);
    expect(list.count).toBe(2);
    expect(list.textureAt(0)).toBeNull(); // the background colour first…
    expect(list.textureAt(1)).toBe(ATLAS); // …then the image over it
  });
});

// --- classification ------------------------------------------------------------------------------------------------

describe("node classification", () => {
  it("routes text, particles, spine and WebGL-shader nodes to the overlay, not the list", () => {
    const nodes = [
      mkNode("label", null, {
        nodeType: "Godot.Label",
        text: { text: "hi", colorHtml: null, fontSizePx: 20, halign: null, valign: null, outlineColorHtml: null, outlineSize: 0 }
      }),
      mkNode("emitter", null, {
        nodeType: "Godot.GpuParticles2D",
        localRect: null,
        // A bare emitter with no material paints NOTHING by the content gate (`nodePaintsContent` says so in as
        // many words); STS2's systems all carry a ShaderMaterial, which is what makes them painting nodes.
        shaderId: "res://shaders/vfx/particle.gdshader",
        particleSpec: normalizeParticleSpecConfig({ kind: "GPUParticles2D" })
      }),
      mkNode("skeleton", null, {
        nodeType: "SpineSprite",
        localRect: null,
        spineSceneResPath: "res://scenes/creature.tscn",
        spineNodePath: "Spine",
        spineCurrentAnim: "idle"
      }),
      mkNode("fx", null, {
        nodeType: "Godot.ColorRect",
        shaderId: "res://shaders/vfx/ripple.gdshader",
        fillColor: color(1, 1, 1, 1)
      })
    ];
    const { list, result, classes } = build(nodes);
    expect(list.count).toBe(0);
    expect([...classes.values()]).toEqual(["overlay", "overlay", "overlay", "overlay"]);
    expect(result.overlayRecords.map((r) => r.kind)).toEqual(["text", "particles", "spine", "shader"]);
    expect(result.stats.overlayByKind).toMatchObject({ text: 1, particles: 1, spine: 1, shader: 1 });
    // The record carries the placement + box the overlay element needs, in the shape nodeStyle emits.
    const label = result.overlayRecords[0];
    expect(label.w).toBe(100);
    expect(label.h).toBe(100);
    expect([...label.transform]).toEqual([...nodeMatrix([1, 0, 0, 1, 0, 0], { x: 0, y: 0 })]);
  });

  it("carries the walk's COMPOSED alpha and tint on the overlay record", () => {
    // The overlay's elements are flat children of one container, so neither the opacity cascade nor the tint
    // filter the DOM backend gets from element NESTING reaches them. The record is where both arrive, and it must
    // carry exactly what `setQuadColor` would have premultiplied into a quad for the same node.
    const { result } = build([
      mkNode("P", null, { nodeType: "Godot.Control", modulate: color(0.5, 1, 1, 0.5) }),
      mkNode("L", "P", {
        nodeType: "Godot.Label",
        selfModulate: color(1, 0.25, 1, 0.5),
        text: { text: "hi", colorHtml: null, fontSizePx: 20, halign: null, valign: null, outlineColorHtml: null, outlineSize: 0 }
      })
    ]);
    const label = result.overlayRecords.find((r) => r.id === "L")!;
    expect(label.opacity).toBeCloseTo(0.25, 6); // cascaded modulate.a × own self_modulate.a
    expect(label.tintR).toBeCloseTo(0.5, 6);
    expect(label.tintG).toBeCloseTo(0.25, 6);
    expect(label.tintB).toBeCloseTo(1, 6);
  });

  it("classifies a pure transform group and an invisible subtree as skip", () => {
    const { list, classes } = build([
      mkNode("group", null, { nodeType: "Godot.Node2D", textureUrl: null }),
      mkNode("hiddenParent", null, { visible: false, fillColor: color(1, 1, 1, 1) }),
      mkNode("hiddenKid", "hiddenParent", { fillColor: color(1, 1, 1, 1) })
    ]);
    expect(list.count).toBe(0);
    expect(classes.get("group")).toBe("skip");
    expect(classes.get("hiddenParent")).toBe("skip");
    expect(classes.get("hiddenKid")).toBe("skip");
  });

  it("agrees with the standalone predicates", () => {
    const label = mkNode("l", null, {
      text: { text: "x", colorHtml: null, fontSizePx: 10, halign: null, valign: null, outlineColorHtml: null, outlineSize: 0 }
    });
    expect(overlayKindOf(label)).toBe("text");
    expect(classifyNode(label, 1, false)).toBe("overlay");
    expect(classifyNode(label, 1, true)).toBe("skip");
    expect(classifyNode(label, 0.01, false)).toBe("skip");
  });
});

// --- the overlay cover pass -------------------------------------------------------------------------------------

describe("the overlay cover pass", () => {
  /** A WebGL-shader overlay node: a fill gives it a shader BASE, which is what makes it webgl-eligible. */
  function fx(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
    return mkNode(id, parentId, {
      nodeType: "Godot.ColorRect",
      shaderId: "res://shaders/card_ripple.gdshader",
      fillColor: color(1, 1, 1, 1),
      ...over
    });
  }

  function coveredOf(nodes: MirrorNode[]): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const r of build(nodes).result.overlayRecords) {
      out[r.id] = r.coveredAbove;
    }
    return out;
  }

  it("marks a surface a LATER canvas node paints over", () => {
    // The shape of the bug: a background VFX layer at paint rank 0 with the whole scene painted on top of it.
    expect(
      coveredOf([
        fx("glow", null, { localRect: { x: 0, y: 0, width: 500, height: 500 } }),
        mkNode("art", null, { fillColor: color(1, 0, 0, 1), localRect: { x: 0, y: 0, width: 500, height: 500 } })
      ])
    ).toEqual({ glow: true });
  });

  it("leaves a surface nothing paints over UNCOVERED", () => {
    expect(
      coveredOf([
        mkNode("art", null, { fillColor: color(1, 0, 0, 1), localRect: { x: 0, y: 0, width: 500, height: 500 } }),
        fx("glow", null, { localRect: { x: 0, y: 0, width: 500, height: 500 } })
      ])
    ).toEqual({ glow: false });
  });

  it("ignores a later node that does not OVERLAP the surface", () => {
    expect(
      coveredOf([
        fx("glow", null, { localRect: { x: 0, y: 0, width: 100, height: 100 } }),
        mkNode("art", null, {
          fillColor: color(1, 0, 0, 1),
          transform: [1, 0, 0, 1, 400, 0],
          localRect: { x: 0, y: 0, width: 100, height: 100 }
        })
      ])
    ).toEqual({ glow: false });
  });

  it("ignores a SILENT later node — it pushed no command, so it covers nothing", () => {
    // A node with a material and nothing to apply it to (`DrawListStats.silent`) paints no pixels on either
    // backend, so counting it would withhold an effect for a surface that is not actually hidden.
    expect(
      coveredOf([
        fx("glow", null, { localRect: { x: 0, y: 0, width: 500, height: 500 } }),
        mkNode("empty", null, {
          shaderId: "res://shaders/vfx/wind_sway.gdshader",
          localRect: { x: 0, y: 0, width: 500, height: 500 }
        })
      ])
    ).toEqual({ glow: false });
  });

  it("has no opinion about a ZERO-AREA record", () => {
    // A `GpuParticles2D` streams no `localRect`, so its record is a 0x0 anchor at the node origin and its real
    // extent lives in a gsw canvas that grows around it. There is no box to intersect.
    const nodes = [
      mkNode("emitter", null, {
        nodeType: "Godot.GpuParticles2D",
        localRect: null,
        shaderId: "res://shaders/vfx/particle.gdshader",
        particleSpec: normalizeParticleSpecConfig({ kind: "GPUParticles2D" })
      }),
      mkNode("art", null, { fillColor: color(1, 0, 0, 1), localRect: { x: 0, y: 0, width: 1920, height: 1080 } })
    ];
    expect(coveredOf(nodes)).toEqual({ emitter: false });
  });
});

// --- clip scopes ------------------------------------------------------------------------------------------------

describe("clip scopes", () => {
  it("wraps a clipper's whole subtree — behind children included — in one balanced interval", () => {
    const { list, result } = build([
      mkNode("Clip", null, {
        nodeType: "Godot.Control",
        clipContents: true,
        localRect: { x: 0, y: 0, width: 200, height: 100 },
        transform: [1, 0, 0, 1, 10, 20]
      }),
      mkNode("Behind", "Clip", { showBehindParent: true, fillColor: color(1, 1, 1, 1) }),
      mkNode("Front", "Clip", { fillColor: color(1, 1, 1, 1) })
    ]);
    expect(list.kindAt(0)).toBe(DRAW_CLIP_PUSH);
    expect(list.kindAt(list.count - 1)).toBe(DRAW_CLIP_POP);
    expect(list.clipDepth).toBe(0);
    const clip = list.readClipRect(0, createClipRectView());
    expect([clip.x, clip.y, clip.w, clip.h]).toEqual([10, 20, 200, 100]);
    expect(clip.cornerRadius).toBe(0);
    expect(clip.outsetX).toBe(0);
    const range = result.clipRanges.get("Clip")!;
    const span = result.order.entries.get("Clip")!;
    // Every command between push and pop belongs to a node inside the clipper's paint-order span.
    for (const [id, r] of result.ranges) {
      if (id === "Clip") continue;
      const entry = result.order.entries.get(id)!;
      expect(entry.order).toBeGreaterThanOrEqual(span.spanStart);
      expect(entry.order).toBeLessThan(span.spanEnd);
      expect(r.start).toBeGreaterThan(range.push);
      expect(r.paintEnd).toBeLessThanOrEqual(range.pop);
    }
  });

  it("nests clip scopes without ever crossing them", () => {
    const { list } = build([
      mkNode("Outer", null, { nodeType: "Godot.Control", clipContents: true, localRect: { x: 0, y: 0, width: 300, height: 300 } }),
      mkNode("Inner", "Outer", { nodeType: "Godot.Control", clipContents: true, localRect: { x: 0, y: 0, width: 100, height: 100 } }),
      mkNode("Paint", "Inner", { fillColor: color(1, 1, 1, 1) }),
      mkNode("Sibling", "Outer", { fillColor: color(1, 1, 1, 1) })
    ]);
    const kinds: number[] = [];
    for (let i = 0; i < list.count; i++) {
      kinds.push(list.kindAt(i));
    }
    expect(kinds).toEqual([
      DRAW_CLIP_PUSH, // Outer
      DRAW_CLIP_PUSH, // Inner
      DRAW_QUAD, // Paint
      DRAW_CLIP_POP, // Inner
      DRAW_QUAD, // Sibling
      DRAW_CLIP_POP // Outer
    ]);
    expect(list.maxClipDepth).toBe(2);
  });

  it("rounds a clip_children capsule and never clips rich text", () => {
    __recordTextureSizeForTest(ATLAS, 2048, 2048);
    const rounded = build([
      mkNode("Mask", null, {
        clipChildren: 1,
        textureUrl: ATLAS,
        ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 },
        localRect: { x: 0, y: 0, width: 60, height: 12 }
      })
    ]).list;
    expect(rounded.kindAt(0)).toBe(DRAW_CLIP_PUSH);
    expect(rounded.readClipRect(0, createClipRectView()).cornerRadius).toBe(6);

    const rich = build([
      mkNode("Desc", null, {
        nodeType: "Godot.RichTextLabel",
        clipContents: true,
        richText: true,
        localRect: { x: 0, y: 0, width: 200, height: 60 },
        text: { text: "[b]hi[/b]", colorHtml: null, fontSizePx: 20, halign: null, valign: null, outlineColorHtml: null, outlineSize: 0 }
      })
    ]).list;
    expect(rich.count).toBe(0); // no clip, and the text itself is an overlay
  });

  it("applies the R20 one-axis outset from the clip-axis table's scene identity", () => {
    const { list } = build([
      mkNode("EventRoot", null, {
        nodeType: "Godot.Control",
        sceneFilePath: "res://scenes/events/ancient_event_layout.tscn",
        localRect: { x: 0, y: 0, width: 1920, height: 1080 }
      }),
      mkNode("ContentContainer", "EventRoot", {
        nodeType: "Godot.Control",
        clipContents: true,
        localRect: { x: 380, y: 320, width: 1160, height: 720 }
      })
    ]);
    const clip = list.readClipRect(0, createClipRectView());
    expect(clip.outsetX).toBe(380);
    expect([clip.x, clip.w]).toEqual([380, 1160]);
  });

  it("opens no clip inside a hidden subtree — nothing is there to clip", () => {
    const { list } = build([
      mkNode("Hidden", null, { visible: false, nodeType: "Godot.Control", clipContents: true }),
      mkNode("Inner", "Hidden", { nodeType: "Godot.Control", clipContents: true })
    ]);
    expect(list.count).toBe(0);
    expect(list.clipDepth).toBe(0);
  });
});

// --- transform composition ---------------------------------------------------------------------------------------

describe("transform composition", () => {
  it("composes a local-space child onto its parent, exactly as walkResolved does", () => {
    const state = mkState([
      mkNode("P", null, { transform: [1, 0, 0, 1, 100, 50] }),
      mkNode("C", "P", { transform: [2, 0, 0, 2, 10, 10], fillColor: color(1, 1, 1, 1) })
    ]);
    const list = createDrawList<string>();
    buildDrawList(state, list);
    const view = list.readQuad(0, createQuadView());
    expectClose([...view.m], [2, 0, 0, 2, 110, 60]);
  });

  it("composes a child's local matrix with its parent", () => {
    const { list } = build([
      mkNode("P", null, { transform: [1, 0, 0, 1, 100, 50] }),
      mkNode("C", "P", { transform: [2, 0, 0, 2, 10, 10], fillColor: color(1, 1, 1, 1) })
    ]);
    expectClose([...list.readQuad(0, createQuadView()).m], [2, 0, 0, 2, 110, 60]);
  });

  it("holds an ORPHAN invisible rather than collapsing it onto the design origin", () => {
    const { list, classes } = build([mkNode("Lost", "NotHere", { fillColor: color(1, 1, 1, 1) })]);
    expect(classes.get("Lost")).toBe("skip");
    expect(list.count).toBe(0);
  });
});
