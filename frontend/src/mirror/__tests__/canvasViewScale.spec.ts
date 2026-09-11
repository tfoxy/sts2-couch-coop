// THE CANVAS BACKEND'S VIEW SCALE — the wiring, not the algebra.
//
// `viewScaleLayout.spec.ts` pins the algebra itself (which nodes resolve, how a stamp is measured, what the input
// registry keeps). This file pins what the DRAW-LIST WALK does with it: that the accumulated stamp product
// left-multiplies each descendant's spread-shifted global exactly the way CSS nesting does it on the DOM stage,
// that `mGame` never moves, and that with no env the whole feature is byte-identical to not existing.
//
// S7   the cascade — a child of a stamped group renders at `mDesign · g_child`, and its `mGame` is untouched
// S8   nesting — the card-reward 1.10 group ∘ the per-card 1.15 is 1.265 on the card
// S9   THE WIDESCREEN PROPERTY — a descendant's OWN spread shift is scaled by k. Folding the stamp into `gRaw`
//      instead passes every 16:9 test and is wrong by `(k−1)·dx` on a widened stage; this is the test that says so
// S10  a cosmetic offset scales by the INHERITED k only
// S11  no env ⇒ byte-identical draw list and hit entries
// S12  an ancestor-hidden item is STAMPED (the visual costs nothing) but never reaches the input registry
// S13  the stamp is measured at the APPLIED pose — a transform override moves the item's box
// S14  `capturedGlobals` still banks the PRE-scale placement

import { describe, expect, it } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList, type CapturedGlobal } from "@/mirror/canvas/buildDrawList";
import { resolveSceneInfo } from "@/mirror/canvas/hitTest";
import { createMirrorState, MIRROR_DESIGN_WIDTH, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import {
  VIEW_SCALE_CARD_REWARD_CARD,
  VIEW_SCALE_CARD_REWARD_GROUP,
  VIEW_SCALE_MERCHANT_GROUP,
  VIEW_SCALE_PILE
} from "@/mirror/viewScale";
import {
  buildViewScaleInputRegistry,
  type ViewScaleEnv,
  type ViewScaleRegistryEnv
} from "@/mirror/viewScaleLayout";

/** 2100x900 letterboxes to a 2520-wide design box — the widest the mirror ever goes. */
const F = 2520 / MIRROR_DESIGN_WIDTH;
const BUDGET = (F - 1) * MIRROR_DESIGN_WIDTH;

const MERCHANT_INVENTORY = "res://scenes/merchant/merchant_inventory.tscn";
const DRAW_PILE = "res://scenes/combat/draw_pile.tscn";

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

/** The env the renderer builds, restated: readability scaling enabled, scene identity off the walked node map. */
function vsEnv(state: MirrorState, over: Partial<ViewScaleEnv> = {}): ViewScaleEnv {
  return {
    enabled: () => true,
    sceneOf: (id) => resolveSceneInfo(id, state.nodes),
    ...over
  };
}

function regEnv(state: MirrorState, ids: readonly string[]): ViewScaleRegistryEnv {
  return {
    parentIdOf: (id) => state.nodes.get(id)?.parentId,
    get orderedIds() {
      return ids;
    },
    ancestorChainHidden: (id) => {
      for (let p = state.nodes.get(id)?.parentId; p != null; p = state.nodes.get(p)?.parentId) {
        if (!state.nodes.get(p)?.visible) {
          return true;
        }
      }
      return false;
    },
    designWidth: MIRROR_DESIGN_WIDTH
  };
}

type BuildOpts = Parameters<typeof buildDrawList>[2];

function build(state: MirrorState, options: BuildOpts = {}) {
  return buildDrawList(state, createDrawList<string>(), { assert: true, ...options });
}

function entry(result: ReturnType<typeof build>, id: string) {
  const found = result.hitEntries.find((e) => e.nodeId === id);
  if (!found) {
    throw new Error(`no hit entry for ${id}`);
  }
  return found;
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

// --- the shop: a merchant `SlotsContainer` (1.10 GROUP, unclamped, centre pivot) with children ------------------

/**
 * `shopRoot` carries the scene file so its child's scene-relative path is exactly "SlotsContainer"; the container
 * itself is a 0/1-anchored SPAN so it hands its own widening down and its children can claim their own field
 * shifts (which is what S9 needs).
 */
function shopTree(slotsOver: Partial<MirrorNode> = {}, extra: MirrorNode[] = []): MirrorNode[] {
  return [
    frameRoot(),
    mkNode("shopRoot", "root", {
      sceneFilePath: MERCHANT_INVENTORY,
      // A real 0/1-anchored box, so the widening budget reaches the container's children (a BOXLESS positioner
      // hands its descendants `anchorDelta: 0` and every one of them would ride instead of claiming).
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
    { ...mkNode("rug", "SlotsContainer", {}), ...slotsOver },
    ...extra
  ];
}

describe("S7 — the cascade", () => {
  it("a stamped GROUP scales itself and everything under it, and touches no mGame", () => {
    const state = mkState(
      shopTree({
        id: "rug",
        parentId: "SlotsContainer",
        nodeType: "Godot.Sprite2D",
        transform: [1, 0, 0, 1, 214, 149],
        localRect: { x: 0, y: 0, width: 400, height: 300 },
        mouseFilter: 0
      } as Partial<MirrorNode> as MirrorNode)
    );
    const result = build(state, { viewScaleEnv: vsEnv(state) });
    const k = VIEW_SCALE_MERCHANT_GROUP;
    expect(result.viewScaleStamps.has("SlotsContainer")).toBe(true);
    const stamp = result.viewScaleStamps.get("SlotsContainer")!;
    expect(stamp.k).toBe(k);
    expect(stamp.isGroup).toBe(true);

    // The design-space stamp: p ↦ P + k(p − P) + C.
    const mapX = (x: number) => stamp.pivotX + k * (x - stamp.pivotX) + stamp.offsetX;
    const mapY = (y: number) => stamp.pivotY + k * (y - stamp.pivotY) + stamp.offsetY;

    const group = entry(result, "SlotsContainer");
    expect(group.mFinal[0]).toBeCloseTo(k, 9);
    expect(group.mFinal[4]).toBeCloseTo(mapX(86), 9);
    expect(group.mFinal[5]).toBeCloseTo(mapY(51), 9);

    // The CHILD rides the same stamp — that is the CSS cascade, restated for a flat list.
    const rug = entry(result, "rug");
    expect(rug.mFinal[0]).toBeCloseTo(k, 9);
    expect(rug.mFinal[4]).toBeCloseTo(mapX(300), 9);
    expect(rug.mFinal[5]).toBeCloseTo(mapY(200), 9);

    // …and NEITHER node's game pose moved: taps still send the true 1920-space point.
    expect(group.mGame).toEqual([1, 0, 0, 1, 86, 51]);
    expect(rug.mGame).toEqual([1, 0, 0, 1, 300, 200]);
  });

  it("an ITEM stamp (the draw pile) scales about its own bottom-left corner", () => {
    const state = mkState([
      frameRoot(),
      mkNode("pile", "root", {
        sceneFilePath: DRAW_PILE,
        transform: [1, 0, 0, 1, 15, 985],
        localRect: { x: 0, y: 0, width: 80, height: 80 },
        mouseFilter: 0
      })
    ]);
    const result = build(state, { viewScaleEnv: vsEnv(state) });
    const stamp = result.viewScaleStamps.get("pile")!;
    expect(stamp.k).toBe(VIEW_SCALE_PILE);
    // bottomLeft ⇒ the pivot is the box's own bottom-left corner, so the button grows up and right.
    expect(stamp.pivotX).toBe(15);
    expect(stamp.pivotY).toBe(1065);
    const pile = entry(result, "pile");
    expect(pile.mFinal[0]).toBeCloseTo(VIEW_SCALE_PILE, 9);
    expect(pile.mFinal[4]).toBeCloseTo(15, 9); // the pinned corner does not move
    expect(pile.mFinal[5]).toBeCloseTo(1065 + VIEW_SCALE_PILE * (985 - 1065), 9);
  });
});

describe("S8 — nesting", () => {
  it("the card-reward 1.10 GROUP composed with the per-card 1.15 is 1.265 on the card", () => {
    const state = mkState([
      frameRoot(),
      mkNode("screen", "root", {
        nodeType: "Sts2.NCardRewardSelectionScreen",
        localRect: { x: 0, y: 0, width: 1920, height: 1080 },
        transform: [1, 0, 0, 1, 0, 0],
        mouseFilter: 0
      }),
      mkNode("card", "screen", {
        nodeType: "Sts2.NCard",
        transform: [1, 0, 0, 1, 700, 500],
        localRect: { x: 0, y: 0, width: 0, height: 0 },
        mouseFilter: 0
      })
    ]);
    const result = build(state, { viewScaleEnv: vsEnv(state) });
    expect(result.viewScaleStamps.get("screen")!.k).toBe(VIEW_SCALE_CARD_REWARD_GROUP);
    expect(result.viewScaleStamps.get("card")!.k).toBe(VIEW_SCALE_CARD_REWARD_CARD);
    // The card's 0x0 box was measured through the NOMINAL 240x338 substitution about its own origin.
    expect(result.viewScaleStamps.get("card")!.box).toEqual({ x: 580, y: 331, w: 240, h: 338 });

    const card = entry(result, "card");
    const nested = VIEW_SCALE_CARD_REWARD_GROUP * VIEW_SCALE_CARD_REWARD_CARD;
    expect(nested).toBeCloseTo(1.265, 9);
    expect(card.mFinal[0]).toBeCloseTo(nested, 9);
    expect(card.mFinal[3]).toBeCloseTo(nested, 9);
    // Order matters: the card's OWN stamp is a centre scale about its own nominal box, so it leaves the card's
    // origin where it is; the GROUP's stamp — a centre scale about the 1920x1080 screen — then carries that origin
    // toward the screen centre. `V_group(m_card(p))`, not the other way round.
    expect(card.mFinal[4]).toBeCloseTo(960 + VIEW_SCALE_CARD_REWARD_GROUP * (700 - 960), 6);
    expect(card.mFinal[5]).toBeCloseTo(540 + VIEW_SCALE_CARD_REWARD_GROUP * (500 - 540), 6);
    expect(card.mGame).toEqual([1, 0, 0, 1, 700, 500]);
  });
});

describe("S9 — THE WIDESCREEN PROPERTY: a descendant's own spread shift is scaled by k", () => {
  // This is the test that separates "thread the stamp product down the walk" from "fold the stamp into gRaw".
  // Both are identical at 16:9. On a widened stage the DOM renders a descendant at
  //   V · (g_child + dx_child)        — the child's own dx is INSIDE the scale
  // while folding the stamp into `gRaw` would render it at
  //   V · g_child + dx_child          — the dx applied AFTER, unscaled
  // a difference of exactly (k−1)·dx_child.
  it("the shop's rug rides k·dx, not dx", () => {
    const state = mkState(
      shopTree({
        id: "rug",
        parentId: "SlotsContainer",
        // A non-Control WORLD sprite: the positional claimer branch, so it takes its OWN field shift rather than
        // riding its parent's.
        nodeType: "Godot.Sprite2D",
        transform: [1, 0, 0, 1, 814, 349],
        localRect: { x: 0, y: 0, width: 400, height: 300 },
        mouseFilter: null
      } as Partial<MirrorNode> as MirrorNode)
    );
    const result = build(state, { spreadFactor: F, viewScaleEnv: vsEnv(state) });
    const stamp = result.viewScaleStamps.get("SlotsContainer")!;
    const k = stamp.k;
    const rug = entry(result, "rug");

    expect(BUDGET).toBeGreaterThan(0);
    expect(rug.spreadDx).toBeGreaterThan(0); // the child really did claim its own shift

    const gSpreadX = 900 + rug.spreadDx;
    const right = stamp.pivotX + k * (gSpreadX - stamp.pivotX) + stamp.offsetX;
    const foldedIntoGRaw = stamp.pivotX + k * (900 - stamp.pivotX) + stamp.offsetX + rug.spreadDx;

    expect(rug.mFinal[4]).toBeCloseTo(right, 6);
    expect(Math.abs(right - foldedIntoGRaw)).toBeCloseTo((k - 1) * rug.spreadDx, 6);
    expect(Math.abs(rug.mFinal[4] - foldedIntoGRaw)).toBeGreaterThan(1); // and the error is not sub-pixel
  });

  it("…and at 16:9 the two are the same number, which is why only a wide gate can catch this", () => {
    const state = mkState(
      shopTree({
        id: "rug",
        parentId: "SlotsContainer",
        nodeType: "Godot.Sprite2D",
        transform: [1, 0, 0, 1, 814, 349],
        localRect: { x: 0, y: 0, width: 400, height: 300 },
        mouseFilter: null
      } as Partial<MirrorNode> as MirrorNode)
    );
    const result = build(state, { spreadFactor: 1, viewScaleEnv: vsEnv(state) });
    expect(entry(result, "rug").spreadDx).toBe(0);
  });
});

describe("S10 — a cosmetic offset scales by the INHERITED k only", () => {
  function offsetTree() {
    return mkState([
      frameRoot(),
      mkNode("shopRoot", "root", { sceneFilePath: MERCHANT_INVENTORY, localRect: null }),
      mkNode("SlotsContainer", "shopRoot", {
        name: "SlotsContainer",
        anchorLeft: 0,
        anchorRight: 1,
        localRect: { x: 0, y: 0, width: 1747, height: 978 },
        transform: [1, 0, 0, 1, 86, 51],
        mouseFilter: 0
      }),
      mkNode("item", "SlotsContainer", { transform: [1, 0, 0, 1, 214, 149], mouseFilter: 0 })
    ]);
  }

  it("a descendant's lift rides its ancestor's factor", () => {
    const state = offsetTree();
    const rest = build(state, { viewScaleEnv: vsEnv(state) });
    const lifted = build(state, {
      viewScaleEnv: vsEnv(state),
      cosmeticOffsets: new Map([["item", { dx: 0, dy: -100 }]])
    });
    const moved = entry(lifted, "item").mFinal[5] - entry(rest, "item").mFinal[5];
    expect(moved).toBeCloseTo(-100 * VIEW_SCALE_MERCHANT_GROUP, 6);
  });

  it("…but a stamped node's OWN lift does not ride its OWN factor, and neither does its subtree's", () => {
    const state = offsetTree();
    const rest = build(state, { viewScaleEnv: vsEnv(state) });
    const lifted = build(state, {
      viewScaleEnv: vsEnv(state),
      cosmeticOffsets: new Map([["SlotsContainer", { dx: 0, dy: -100 }]])
    });
    // The DOM twin is `translate` composing BEFORE `transform`, i.e. outside the node's own prepended stamp.
    expect(entry(lifted, "SlotsContainer").mFinal[5] - entry(rest, "SlotsContainer").mFinal[5]).toBeCloseTo(-100, 6);
    // …AND SO DOES THE CHILD — corrected in R7a, where this line used to expect `-100 x k`.
    //
    // A nested DOM child inherits its parent's whole USED transform, which is `translate · V · mDesign`: the
    // owner's translate is applied OUTSIDE the owner's own stamp, so a descendant moves by the offset itself and
    // not by the offset scaled by a stamp that sits BELOW the offset's owner. The old expectation was measured on
    // the map, where it moved a travelable point's icon by `offset x 1.5` while the map moved by `offset` — the
    // user's "map icons are not client-side scrolled; they lag behind".
    expect(entry(lifted, "item").mFinal[5] - entry(rest, "item").mFinal[5]).toBeCloseTo(-100, 6);
  });

  it("with no view scale at all a lift is a plain design-space translate", () => {
    const state = offsetTree();
    const rest = build(state);
    const lifted = build(state, { cosmeticOffsets: new Map([["item", { dx: 7, dy: -100 }]]) });
    expect(entry(lifted, "item").mFinal[4] - entry(rest, "item").mFinal[4]).toBeCloseTo(7, 9);
    expect(entry(lifted, "item").mFinal[5] - entry(rest, "item").mFinal[5]).toBeCloseTo(-100, 9);
  });
});

describe("S11 — disabled ⇒ byte-identical", () => {
  function dump(result: ReturnType<typeof build>) {
    return {
      hits: result.hitEntries.map((e) => [e.nodeId, ...e.mFinal, ...e.mGame].join(",")),
      stamps: result.viewScaleStamps.size,
      commands: result.stats.commands,
      quads: result.stats.quads
    };
  }

  it("no env at all: the walk never resolves a leaf and every float is unchanged", () => {
    const state = mkState(shopTree());
    expect(dump(build(state))).toEqual(dump(build(state, { viewScaleEnv: null })));
    expect(build(state).viewScaleStamps.size).toBe(0);
  });

  it("a disabled readability setting produces no stamp or cascade", () => {
    const state = mkState(shopTree());
    const off = build(state, { viewScaleEnv: vsEnv(state, { enabled: () => false }) });
    expect(dump(off)).toEqual(dump(build(state)));
  });

  it("…and with the env ON the same tree is NOT unchanged (the gate would be vacuous otherwise)", () => {
    const state = mkState(shopTree());
    expect(dump(build(state, { viewScaleEnv: vsEnv(state) }))).not.toEqual(dump(build(state)));
  });

  it("off ⇒ byte-identical on a WIDENED stage too", () => {
    const state = mkState(shopTree());
    expect(dump(build(state, { spreadFactor: F, viewScaleEnv: null }))).toEqual(
      dump(build(state, { spreadFactor: F, viewScaleEnv: vsEnv(state, { enabled: () => false }) }))
    );
  });
});

describe("S12 — an ancestor-hidden item is stamped but never claims a pointer", () => {
  it("the stamp index holds it (the visual costs nothing) and the input registry drops it", () => {
    // A screen is hidden by clearing the flag on its ROOT, so the item itself still reads visible:true.
    const state = mkState([
      frameRoot(),
      mkNode("screenRoot", "root", { visible: false, localRect: null }),
      mkNode("shopRoot", "screenRoot", { sceneFilePath: MERCHANT_INVENTORY, localRect: null }),
      mkNode("SlotsContainer", "shopRoot", {
        name: "SlotsContainer",
        localRect: { x: 0, y: 0, width: 1747, height: 978 },
        transform: [1, 0, 0, 1, 86, 51],
        mouseFilter: 0
      })
    ]);
    const result = build(state, { viewScaleEnv: vsEnv(state) });
    expect(result.viewScaleStamps.has("SlotsContainer")).toBe(true);
    // …and it is NOT a hit surface either, so nothing can be tapped on it.
    expect(result.hitEntries.some((e) => e.nodeId === "SlotsContainer")).toBe(false);
    const registry = buildViewScaleInputRegistry(
      result.viewScaleStamps,
      [],
      regEnv(state, result.order.ids)
    );
    expect(registry).toEqual([]);
  });
});

describe("S13 — the stamp is measured at the APPLIED pose", () => {
  it("a transform override moves the item, and the stamp follows it", () => {
    const state = mkState([
      frameRoot(),
      mkNode("shopRoot", "root", { sceneFilePath: MERCHANT_INVENTORY, localRect: null }),
      mkNode("SlotsContainer", "shopRoot", {
        name: "SlotsContainer",
        localRect: { x: 0, y: 0, width: 400, height: 300 },
        transform: [1, 0, 0, 1, 100, 100],
        mouseFilter: 0
      })
    ]);
    const rest = build(state, { viewScaleEnv: vsEnv(state) });
    expect(rest.viewScaleStamps.get("SlotsContainer")!.box).toEqual({ x: 100, y: 100, w: 400, h: 300 });

    const slid = build(state, {
      viewScaleEnv: vsEnv(state),
      transformOverrides: new Map([["SlotsContainer", [1, 0, 0, 1, 700, 250]]])
    });
    expect(slid.viewScaleStamps.get("SlotsContainer")!.box).toEqual({ x: 700, y: 250, w: 400, h: 300 });
    // The pivot is the OVERRIDDEN box's centre, so the enlargement stays on the item wherever the tween put it.
    expect(slid.viewScaleStamps.get("SlotsContainer")!.pivotX).toBe(900);
  });

  it("an override that parks the item wholly off-stage gets NO stamp (the P4 phantom)", () => {
    const state = mkState([
      frameRoot(),
      mkNode("shopRoot", "root", { sceneFilePath: MERCHANT_INVENTORY, localRect: null }),
      mkNode("SlotsContainer", "shopRoot", {
        name: "SlotsContainer",
        localRect: { x: 0, y: 0, width: 400, height: 300 },
        transform: [1, 0, 0, 1, 100, 100],
        mouseFilter: 0
      })
    ]);
    const parked = build(state, {
      viewScaleEnv: vsEnv(state),
      transformOverrides: new Map([["SlotsContainer", [1, 0, 0, 1, 100, -1400]]])
    });
    expect(parked.viewScaleStamps.size).toBe(0);
    // …and with no stamp the item is drawn exactly where the override put it, un-enlarged.
    expect(entry(parked, "SlotsContainer").mFinal).toEqual([1, 0, 0, 1, 100, -1400]);
  });
});

describe("S14 — capturedGlobals stays PRE-scale", () => {
  it("the retained placement is the spread-shifted global, without the view-scale stamp", () => {
    const state = mkState(
      shopTree({
        id: "rug",
        parentId: "SlotsContainer",
        transform: [1, 0, 0, 1, 214, 149],
        localRect: { x: 0, y: 0, width: 400, height: 300 },
        mouseFilter: 0
      } as Partial<MirrorNode> as MirrorNode)
    );
    const out = new Map<string, CapturedGlobal>();
    const result = build(state, {
      viewScaleEnv: vsEnv(state),
      captureGlobals: { ids: new Set(["rug", "SlotsContainer"]), out }
    });
    // The DOM twin writes `el.style.transform` straight to the element and never through its style cache, so the
    // placement it retains is pre-scale too — and every consumer (`scrollRenderedY`, the held-card lift) composes
    // the NEXT frame's cosmetic offset against it.
    expect(out.get("rug")!.g).toEqual([1, 0, 0, 1, 300, 200]);
    expect(out.get("SlotsContainer")!.g).toEqual([1, 0, 0, 1, 86, 51]);
    // …while the DRAWN pose really is scaled.
    expect(entry(result, "rug").mFinal[0]).toBeCloseTo(VIEW_SCALE_MERCHANT_GROUP, 9);
  });
});

// S15 — THE STAMP IS MEASURED AT THE DRAWN POSE, offsets included (R7).
//
// `gSpread` is the node's PRE-offset pose, so before this a client-side scroll left the stamp stale in two ways:
// `computeViewScaleStamp` answers null for a box fully outside the design stage, so an item scrolled INTO view
// kept scale 1 until a wire delta landed, and the anchored clamp re-derived from the un-scrolled box on every
// build. Measured on `perf5-map-scroll`: at a +300 px scroll, NINE map points gain the stamp they should have had.
describe("S15 — a scrolled item is stamped where it is DRAWN", () => {
  /**
   * A merchant group parked below the design frame. The SCROLLER is the scene root above it — the offset has to
   * ride an ancestor, exactly as an eager-scroll gesture offsets a container and not the item inside it.
   */
  function parkedTree(y: number) {
    return mkState([
      frameRoot(),
      mkNode("shopRoot", "root", { sceneFilePath: MERCHANT_INVENTORY, localRect: null }),
      mkNode("SlotsContainer", "shopRoot", {
        name: "SlotsContainer",
        localRect: { x: 0, y: 0, width: 800, height: 400 },
        transform: [1, 0, 0, 1, 400, y],
        mouseFilter: 0
      })
    ]);
  }

  it("stamps an item a scroll brought into view", () => {
    const state = parkedTree(1400); // entirely below the 1080-tall design frame
    expect(build(state, { viewScaleEnv: vsEnv(state) }).viewScaleStamps.has("SlotsContainer")).toBe(false);
    const scrolled = build(state, {
      viewScaleEnv: vsEnv(state),
      cosmeticOffsets: new Map([["shopRoot", { dx: 0, dy: -900 }]])
    });
    expect(scrolled.viewScaleStamps.has("SlotsContainer")).toBe(true);
  });

  it("CONVERGES: the scrolled stamp is the one a wire delta would have produced", () => {
    // The property that makes this exact rather than approximate. Same drawn pose, two ways of getting there —
    // a cosmetic offset of -900 over the parked node, and the node actually streamed 900 px higher.
    const scrolled = build(parkedTree(1400), {
      viewScaleEnv: vsEnv(parkedTree(1400)),
      cosmeticOffsets: new Map([["shopRoot", { dx: 0, dy: -900 }]])
    });
    const delta = build(parkedTree(500), { viewScaleEnv: vsEnv(parkedTree(500)) });
    const a = entry(scrolled, "SlotsContainer").mFinal;
    const b = entry(delta, "SlotsContainer").mFinal;
    for (let i = 0; i < 6; i++) {
      expect(a[i]).toBeCloseTo(b[i], 6);
    }
  });

  it("publishes the UNSHIFTED box, which is what the input registry's contract is", () => {
    // The pointer inverse compensates for the offset before it ever asks, so a registry rect is a game-space
    // rect. Shifting the published box would double-apply the scroll on every tap.
    const state = parkedTree(900);
    const rest = build(state, { viewScaleEnv: vsEnv(state) });
    const scrolled = build(state, {
      viewScaleEnv: vsEnv(state),
      cosmeticOffsets: new Map([["shopRoot", { dx: 0, dy: -300 }]])
    });
    expect(scrolled.viewScaleStamps.get("SlotsContainer")!.box).toEqual(
      rest.viewScaleStamps.get("SlotsContainer")!.box
    );
  });

});
