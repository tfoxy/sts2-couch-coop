// THE CANVAS BACKEND'S HOVERTIP SCALE — the wiring, not the algebra.
//
// `hoverTipScaleMath.spec.ts` pins the pivot/clamp geometry and `hoverTipScaleRenderer.spec.ts` pins the DOM
// application of it. This file pins what the DRAW-LIST WALK does: that a tip set measured from its children is
// stamped BEFORE its subtree is drawn, that the stamp cascades and composes with an enclosing view-scale stamp,
// that `mGame` never moves, and that with no env the feature does not exist.
//
// T1  the stamp — a tip is enlarged 1.2x about the pivot its children's union chooses, and its children ride it
// T2  the OWNER decides the side — the same tip grows the other way when it points at a creature
// T3  nesting — a tip inside a view-scaled group carries group ∘ tip, and the owner-follow tracks the group
// T4  the widescreen property — a tip child's own spread shift is scaled by k (the S9 property, for tips)
// T5  off ⇒ byte-identical: no env, and `enabled() === false`, both reproduce a build without the feature
// T6  input is untouched — `mGame` and the view-scale input registry are the same with the stamp and without
// T7  the visual-owner resolve is the DOM's rule — the paint test AND the producer-order walk, both load-bearing

import { describe, expect, it } from "vitest";

import { createDrawList, createQuadView, DRAW_QUAD } from "@godot-scene-web/canvas";

import { buildDrawList, type CanvasTipScaleEnv, type CapturedGlobal } from "@/mirror/canvas/buildDrawList";
import { resolveSceneInfo } from "@/mirror/canvas/hitTest";
import { designAabbOf, type ViewScaleEnv } from "@/mirror/viewScaleLayout";
import { HOVER_TIP_SCALE } from "@/mirror/hoverTipScaleMath";
import { createMirrorState, MIRROR_DESIGN_WIDTH, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import { VIEW_SCALE_MERCHANT_GROUP } from "@/mirror/viewScale";

/** 2100x900 letterboxes to a 2520-wide design box — the widest the mirror ever goes (canvasViewScale's F). */
const F = 2520 / MIRROR_DESIGN_WIDTH;

const MERCHANT_INVENTORY = "res://scenes/merchant/merchant_inventory.tscn";

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

function mkState(nodes: MirrorNode[]): MirrorState {
  const state = createMirrorState();
  for (const node of nodes) {
    state.nodes.set(node.id, node);
  }
  state.orderedIds = nodes.map((n) => n.id);
  return state;
}

type BuildOpts = Parameters<typeof buildDrawList>[2];

function build(state: MirrorState, options: BuildOpts = {}) {
  return buildDrawList(state, createDrawList<string>(), { assert: true, ...options });
}

/**
 * EVERY DRAWN FLOAT of a build — each quad's matrix and box in paint order, plus the hit entries. What T5 means
 * by "byte-identical": not a count, the numbers themselves.
 */
function dump(state: MirrorState, options: BuildOpts = {}) {
  const list = createDrawList<string>();
  const result = buildDrawList(state, list, { assert: true, ...options });
  const view = createQuadView();
  const commands: string[] = [];
  for (let i = 0; i < list.count; i++) {
    if (list.kindAt(i) === DRAW_QUAD) {
      const q = list.readQuad(i, view);
      commands.push([...q.m, q.w, q.h, q.a].join(","));
    } else {
      commands.push(`kind:${list.kindAt(i)}`);
    }
  }
  return {
    commands,
    hits: result.hitEntries.map((e) => [e.nodeId, ...e.mFinal, ...e.mGame].join(",")),
    stamps: [...result.viewScaleStamps.keys()]
  };
}

/**
 * WHERE THE BUILD DREW A NODE, read back through `captureGlobals` — and it has to be that seam rather than the
 * hit entries `canvasViewScale.spec` reads, because a tooltip HAS no hit entry: every `HoverTip*` leaf is an ECHO
 * container (`mirrorRenderer.isHitTestExcluded`), so the walk never builds one. That is the same fact T6 states
 * as the input-safety property, so the two are consistent by construction rather than by coincidence.
 *
 * `drawn` is `gFinal` (the stamp folded in); `g` is `gSpread`, the pre-stamp placement the caller retains.
 */
function drawnAt(state: MirrorState, ids: readonly string[], options: BuildOpts = {}) {
  const out = new Map<string, CapturedGlobal>();
  const result = build(state, { ...options, captureGlobals: { ids: new Set(ids), out } });
  return {
    result,
    drawn: (id: string) => {
      const captured = out.get(id);
      if (!captured) {
        throw new Error(`no captured global for ${id}`);
      }
      return captured.drawn;
    },
    preStamp: (id: string) => out.get(id)!.g
  };
}

/**
 * The env `canvasRenderer` builds, with the owner placed from the state exactly as the
 * renderer places it (rendered global + that node's retained spread shift, which is 0 in a spec).
 */
function tipEnv(state: MirrorState, over: Partial<CanvasTipScaleEnv> = {}): CanvasTipScaleEnv {
  return {
    enabled: () => true,
    hitTestAt: () => null,
    ownerBoxOf: (ownerId) => {
      const node = state.nodes.get(ownerId);
      return node?.localRect && node.transform ? designAabbOf(node.transform, node.localRect) : null;
    },
    ...over
  };
}

function vsEnv(state: MirrorState): ViewScaleEnv {
  return {
    enabled: () => true,
    sceneOf: (id) => resolveSceneInfo(id, state.nodes)
  };
}

/** A 0/1-anchored Control covering the design frame — the budget-granting root the spread needs. */
function frameRoot(): MirrorNode {
  return mkNode("root", null, {
    anchorLeft: 0,
    anchorRight: 1,
    localRect: { x: 0, y: 0, width: 1920, height: 1080 },
    transform: [1, 0, 0, 1, 0, 0]
  });
}

/**
 * A tip set with ONE paint-bearing child: the union is the child's box (1040,660)-(1400,782), so with no owner
 * and no bottom-edge hug the pivot is (union minX, union minY) = (1040, 660) — grow right and down. Same numbers
 * `hoverTipScaleRenderer.spec.ts` drives the DOM arm with, so the two stages are being asked the same question.
 */
function tipTree(over: { tip?: Partial<MirrorNode>; card?: Partial<MirrorNode>; extra?: MirrorNode[] } = {}) {
  return [
    frameRoot(),
    mkNode("tips", "root", {
      nodeType: "Sts2.HoverTips.NHoverTipSet",
      transform: [1, 0, 0, 1, 100, 200],
      localRect: { x: 0, y: 0, width: 400, height: 300 },
      ...over.tip
    }),
    mkNode("card", "tips", {
      nodeType: "Sts2.NHoverTipCardContainer",
      transform: [1, 0, 0, 1, 940, 460],
      localRect: { x: 0, y: 0, width: 360, height: 122 },
      fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" },
      mouseFilter: 0,
      ...over.card
    }),
    ...(over.extra ?? [])
  ];
}

describe("T1 — the stamp", () => {
  it("enlarges the tip 1.2x about its children's union, and the children ride it", () => {
    const state = mkState(tipTree());
    const k = HOVER_TIP_SCALE;
    const b = drawnAt(state, ["tips", "card"], { tipScaleEnv: tipEnv(state) });
    // No owner and not edge-hugging ⇒ the pivot is the union's top-LEFT: the tip grows right and down.
    const map = (x: number, y: number) => [1040 + k * (x - 1040), 660 + k * (y - 660)];

    const tip = b.drawn("tips");
    expect(tip[0]).toBeCloseTo(k, 9);
    expect(tip[4]).toBeCloseTo(map(100, 200)[0], 6);
    expect(tip[5]).toBeCloseTo(map(100, 200)[1], 6);

    // The CHILD rides the same stamp — the cascade, restated for a flat list.
    const card = b.drawn("card");
    expect(card[0]).toBeCloseTo(k, 9);
    // The pivot is a fixed point, so the child's own top-left corner does not move at all.
    expect(card[4]).toBeCloseTo(1040, 9);
    expect(card[5]).toBeCloseTo(660, 9);

    // …and the RETAINED placement stays pre-stamp, exactly as the view scale's does (the DOM twin writes the
    // stamp outside its style cache, so what it keeps is pre-scale too).
    expect(b.preStamp("card")).toEqual([1, 0, 0, 1, 1040, 660]);
  });

  it("a tip with no paint-bearing child is left alone (no union ⇒ no pivot ⇒ no stamp)", () => {
    // A boxless, ink-less, childless container: not paint-bearing, so it contributes nothing to measure.
    const state = mkState(
      tipTree({ card: { fillColor: null, nodeType: "Godot.Control", localRect: null, mouseFilter: null } })
    );
    expect(drawnAt(state, ["tips"], { tipScaleEnv: tipEnv(state) }).drawn("tips")[0]).toBe(1);
  });
});

describe("T2 — the owner decides which side the enlargement grows toward", () => {
  it("a CREATURE owner grows the tip LEFT (pivot at the union's right edge)", () => {
    const state = mkState(
      tipTree({
        tip: { anchorOwnerId: "creature" },
        extra: [
          mkNode("creature", "root", {
            nodeType: "Sts2.NCreature",
            transform: [1, 0, 0, 1, 600, 900],
            localRect: { x: 0, y: 0, width: 200, height: 160 },
            mouseFilter: 0
          })
        ]
      })
    );
    const card = drawnAt(state, ["card"], { tipScaleEnv: tipEnv(state) }).drawn("card");
    expect(card[0]).toBeCloseTo(HOVER_TIP_SCALE, 9);
    // T1's no-owner tip pinned the child's LEFT edge at 1040. A creature owner pivots at the union's RIGHT edge
    // instead, so the same child is drawn further left — the side choice, observable in one number.
    expect(card[4]).toBeLessThan(1040);
  });

  it("…and an owner this backend cannot place falls back to the no-owner rule", () => {
    const ghost = mkState(tipTree({ tip: { anchorOwnerId: "ghost" } }));
    const none = mkState(tipTree());
    expect(drawnAt(ghost, ["card"], { tipScaleEnv: tipEnv(ghost) }).drawn("card")[4]).toBeCloseTo(
      drawnAt(none, ["card"], { tipScaleEnv: tipEnv(none) }).drawn("card")[4],
      9
    );
  });
});

describe("T3 — nesting inside a view-scaled group", () => {
  /** The shop container (a 1.10 GROUP) with a tip set inside it. */
  function shopTipState(): MirrorState {
    return mkState([
      frameRoot(),
      mkNode("shopRoot", "root", {
        sceneFilePath: MERCHANT_INVENTORY,
        anchorLeft: 0,
        anchorRight: 1,
        localRect: { x: 0, y: 0, width: 1920, height: 1080 },
        transform: [1, 0, 0, 1, 0, 0]
      }),
      mkNode("SlotsContainer", "shopRoot", {
        name: "SlotsContainer",
        anchorLeft: 0,
        anchorRight: 1,
        localRect: { x: 0, y: 0, width: 1747, height: 978 },
        transform: [1, 0, 0, 1, 86, 51],
        mouseFilter: 0
      }),
      mkNode("tips", "SlotsContainer", {
        nodeType: "Sts2.HoverTips.NHoverTipSet",
        transform: [1, 0, 0, 1, 100, 200],
        localRect: { x: 0, y: 0, width: 400, height: 300 }
      }),
      mkNode("card", "tips", {
        nodeType: "Sts2.NHoverTipCardContainer",
        transform: [1, 0, 0, 1, 854, 409],
        localRect: { x: 0, y: 0, width: 360, height: 122 },
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" },
        mouseFilter: 0
      })
    ]);
  }

  it("the tip carries group ∘ tip — the product, in that order", () => {
    const state = shopTipState();
    const b = drawnAt(state, ["card"], { viewScaleEnv: vsEnv(state), tipScaleEnv: tipEnv(state) });
    const group = b.result.viewScaleStamps.get("SlotsContainer")!;
    const card = b.drawn("card");
    expect(card[0]).toBeCloseTo(VIEW_SCALE_MERCHANT_GROUP * HOVER_TIP_SCALE, 9);
    // The tip's own stamp leaves the child's corner at (1040,660) — its pivot — and the GROUP then carries that
    // point. `V_group(m_tip(p))`, not the other way round.
    expect(card[4]).toBeCloseTo(group.pivotX + group.k * (1040 - group.pivotX) + group.offsetX, 6);
    expect(card[5]).toBeCloseTo(group.pivotY + group.k * (660 - group.pivotY) + group.offsetY, 6);
  });

  it("the tip is NOT published to the view-scale stamp index (that map is the input registry's source)", () => {
    const state = shopTipState();
    const result = build(state, { viewScaleEnv: vsEnv(state), tipScaleEnv: tipEnv(state) });
    expect([...result.viewScaleStamps.keys()]).toEqual(["SlotsContainer"]);
  });
});

describe("T4 — the widescreen property", () => {
  it("a tip child's OWN spread shift is inside the scale, not added after it", () => {
    // A WORLD sprite child claims its own field shift (canvasViewScale's S9 setup, as a tip child).
    const state = mkState(
      tipTree({
        card: {
          nodeType: "Godot.Sprite2D",
          transform: [1, 0, 0, 1, 940, 460],
          localRect: { x: 0, y: 0, width: 360, height: 122 },
          mouseFilter: null
        }
      })
    );
    const dxOut = new Map<string, number>();
    const b = drawnAt(state, ["tips", "card"], {
      spreadFactor: F,
      tipScaleEnv: tipEnv(state),
      spreadDxOut: dxOut
    });
    const dx = dxOut.get("card")!;
    expect(dx).not.toBe(0); // the child really did claim a shift

    // The pivot is the union of the SHIFTED child box, so the child's drawn corner IS the pivot and the
    // enlargement moves it by exactly 0. Folding the stamp into `gRaw` — the S9 failure, for tips — would leave
    // it off by (k−1)·dx.
    expect(b.drawn("card")[4]).toBeCloseTo(1040 + dx, 6);

    // …and the tip ROOT is drawn k times its distance from that shifted pivot: the shift is INSIDE the scale.
    const pivotX = 1040 + dx;
    const tipDx = dxOut.get("tips")!;
    expect(b.drawn("tips")[4]).toBeCloseTo(pivotX + HOVER_TIP_SCALE * (100 + tipDx - pivotX), 6);
  });
});

describe("T5 — off ⇒ byte-identical", () => {
  it("no env at all: the walk never even asks a node's type leaf about a tip", () => {
    const state = mkState(tipTree());
    expect(dump(state)).toEqual(dump(state, { tipScaleEnv: null }));
  });

  it("the disabled readability setting leaves the draw list unchanged", () => {
    const state = mkState(tipTree());
    expect(dump(state, { tipScaleEnv: tipEnv(state, { enabled: () => false }) })).toEqual(dump(state));
  });

  it("…and with it ON the same tree is NOT unchanged (the gate would be vacuous otherwise)", () => {
    const state = mkState(tipTree());
    expect(dump(state, { tipScaleEnv: tipEnv(state) })).not.toEqual(dump(state));
  });

  it("a disabled readability setting is byte-identical on a WIDENED stage too", () => {
    const state = mkState(tipTree());
    expect(dump(state, { spreadFactor: F, tipScaleEnv: null })).toEqual(
      dump(state, { spreadFactor: F, tipScaleEnv: tipEnv(state, { enabled: () => false }) })
    );
  });
});

describe("T6 — input is untouched", () => {
  it("the hit entries are identical with the stamp and without, and a tip contributes none", () => {
    const state = mkState(
      tipTree({
        extra: [
          mkNode("button", "root", {
            transform: [1, 0, 0, 1, 300, 900],
            localRect: { x: 0, y: 0, width: 200, height: 60 },
            fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000" },
            mouseFilter: 0
          })
        ]
      })
    );
    const on = dump(state, { tipScaleEnv: tipEnv(state) });
    const off = dump(state);
    expect(on.hits).toEqual(off.hits);
    // The stamp DID apply — otherwise the line above proves nothing.
    expect(on.commands).not.toEqual(off.commands);
    // A tooltip is an ECHO container, so it is not a hit surface on either arm: no tip id appears at all.
    expect(on.hits.some((h) => h.startsWith("tips,") || h.startsWith("card,"))).toBe(false);
    expect(on.hits.some((h) => h.startsWith("button,"))).toBe(true);
  });

  it("a NON-echo node INSIDE the tip subtree keeps its streamed hit box while its paint is scaled", () => {
    // The echo exclusion keys on a node's OWN type leaf, so a plain `NinePatchRect` inside a tooltip (the real
    // scene's `NHoverTipSet > VFlowContainer > MarginContainer > NinePatchRect`) IS a hit surface. Scaling its
    // `mFinal` with the paint is what moved six `wscrisp-hovertip` grid samples out of a block region the DOM
    // still blocked — this is that case, in one assertion.
    const state = mkState(
      tipTree({
        extra: [
          mkNode("panel", "card", {
            nodeType: "Godot.NinePatchRect",
            transform: [1, 0, 0, 1, 1060, 680],
            localRect: { x: 0, y: 0, width: 300, height: 90 },
            fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" },
            mouseFilter: 0
          })
        ]
      })
    );
    const on = dump(state, { tipScaleEnv: tipEnv(state) });
    const off = dump(state);
    expect(on.hits.some((h) => h.startsWith("panel,"))).toBe(true);
    // The hit entry is byte-identical with the stamp and without it…
    expect(on.hits).toEqual(off.hits);
    // …while the PAINT moved, which is the whole point of the pass.
    expect(on.commands).not.toEqual(off.commands);
  });
});

describe("T7 — the visual-owner resolve is the DOM's rule, legs and order", () => {
  /**
   * A 0x0 `NHandCardHolder` owner with two descendants — the shape `wscrisp-hovertip` actually hovers, and the
   * shape that produced this round's 12-px divergence:
   *   * an AURA `TextureRect`, bigger, `z_index` 5 (so this backend's z-sorted child order puts it FIRST) and
   *     fully transparent (`modulate` alpha 0);
   *   * the real `NCardHolderHitbox`, which is what the tip must be placed against.
   * The paint test rejects the aura and the walk is the PRODUCER's order, so the resolve answers the hitbox.
   * Before both halves it answered the aura, whose box is 70 px wider and 286 px taller — a different tip pose.
   */
  function holderState(): MirrorState {
    return mkState([
      frameRoot(),
      mkNode("holder", "root", {
        nodeType: "Sts2.NHandCardHolder",
        transform: [1, 0, 0, 1, 500, 700],
        localRect: { x: 0, y: 0, width: 0, height: 0 }
      }),
      mkNode("hitbox", "holder", {
        nodeType: "Sts2.NCardHolderHitbox",
        transform: [1, 0, 0, 1, 350, 490],
        localRect: { x: 0, y: 0, width: 300, height: 422 },
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" },
        mouseFilter: 0
      }),
      mkNode("aura", "holder", {
        nodeType: "Godot.TextureRect",
        transform: [1, 0, 0, 1, 321, 358],
        localRect: { x: 0, y: 0, width: 370, height: 708 },
        modulate: { r: 0.6, g: 1, b: 1, a: 0, html: "#9dfffe00" },
        zIndex: 5,
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" }
      }),
      mkNode("tips", "root", {
        nodeType: "Sts2.HoverTips.NHoverTipSet",
        transform: [1, 0, 0, 1, 100, 200],
        localRect: { x: 0, y: 0, width: 400, height: 300 },
        anchorOwnerId: "holder"
      }),
      mkNode("card", "tips", {
        nodeType: "Sts2.NHoverTipCardContainer",
        transform: [1, 0, 0, 1, 1040, 660],
        localRect: { x: 0, y: 0, width: 360, height: 122 },
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" },
        mouseFilter: 0
      })
    ]);
  }

  /** The env's `ownerBoxOf` records WHICH node the resolve asked about — that is the whole assertion. */
  function recordingEnv(state: MirrorState, asked: string[]): CanvasTipScaleEnv {
    return tipEnv(state, {
      ownerBoxOf: (ownerId) => {
        asked.push(ownerId);
        const node = state.nodes.get(ownerId);
        return node?.localRect && node.transform && node.localRect.width > 0
          ? designAabbOf(node.transform, node.localRect)
          : null;
      }
    });
  }

  it("skips the transparent aura and measures the hitbox", () => {
    const state = holderState();
    const asked: string[] = [];
    build(state, { tipScaleEnv: recordingEnv(state, asked) });
    expect(asked).toContain("hitbox");
    expect(asked).not.toContain("aura");
  });

  it("walks the PRODUCER's order, not this backend's z-sorted paint order", () => {
    // Two PAINTING descendants, so the paint test cannot separate them: `first` comes first on the wire, `later`
    // is moved ahead of it in PAINT order by `show_behind_parent`. This backend's child list would answer
    // `later`; the DOM walks the producer's order and answers `first`, and the shared rule must agree with it.
    const state = mkState([
      frameRoot(),
      mkNode("holder", "root", {
        nodeType: "Sts2.NHandCardHolder",
        transform: [1, 0, 0, 1, 500, 700],
        localRect: { x: 0, y: 0, width: 0, height: 0 }
      }),
      mkNode("first", "holder", {
        transform: [1, 0, 0, 1, 350, 490],
        localRect: { x: 0, y: 0, width: 300, height: 422 },
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" },
        mouseFilter: 0
      }),
      mkNode("later", "holder", {
        transform: [1, 0, 0, 1, 321, 358],
        localRect: { x: 0, y: 0, width: 370, height: 708 },
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" },
        // `show_behind_parent` is drawn BEFORE its parent, so the paint order lifts it ahead of its sibling while
        // the wire order leaves it second — the cheapest way to make the two orders genuinely disagree.
        showBehindParent: true,
        mouseFilter: 0
      }),
      mkNode("tips", "root", {
        nodeType: "Sts2.HoverTips.NHoverTipSet",
        transform: [1, 0, 0, 1, 100, 200],
        localRect: { x: 0, y: 0, width: 400, height: 300 },
        anchorOwnerId: "holder"
      }),
      mkNode("card", "tips", {
        nodeType: "Sts2.NHoverTipCardContainer",
        transform: [1, 0, 0, 1, 1040, 660],
        localRect: { x: 0, y: 0, width: 360, height: 122 },
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" },
        mouseFilter: 0
      })
    ]);
    const asked: string[] = [];
    const result = build(state, { tipScaleEnv: recordingEnv(state, asked) });
    // The z-sort really did reorder the pair — otherwise this test proves nothing about the order.
    expect([...result.order.childrenOf("holder")]).toEqual(["later", "first"]);
    expect(asked).toContain("first");
    expect(asked).not.toContain("later");
  });

});
