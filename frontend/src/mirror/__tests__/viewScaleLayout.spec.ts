// THE VIEW-SCALE LAYOUT ALGEBRA, as a pure function.
//
// `viewScaleLayout.ts` is the ONE copy of the enlargement rules both mirror backends apply (the DOM walk's
// registration branch + `applyViewScalePass`, the canvas walk in `buildDrawList`). Like `spreadLayout.spec` beside
// it, this file pins the algebra with no renderer, no DOM and no browser anywhere near it: plain nodes in, plain
// numbers out.
//
// S1  the PRE-FILTER SHADOWING TRAP — the four scene roots deliberately absent from VIEW_SCALE_ROOT_FILES
// S2  the leaf-detected resolves + the card-reward ancestry flag
// S3  disabled readability scaling and an invisible node resolve to nothing
// S4  the measure step: nominal card box, the P4 off-stage reject, noClamp
// S5  the stamp matrix IS the forward map `viewScaleInverse` inverts
// S6  the input registry's truth table: the four neighbour rules, the unknown-index KEEP, the group paint floor's
//     contiguity fallback and the item Z-rule lever

import { describe, expect, it } from "vitest";

import { MIRROR_DESIGN_WIDTH, type MirrorNode } from "@/mirror/sceneTree";
import { computeAnchoredScaleStamp, type TipAabb } from "@/mirror/hoverTipScaleMath";
import {
  CARD_REWARD_SCREEN_LEAF,
  TREASURE_RELIC_LEAF,
  VIEW_SCALE_CARD_REWARD_CARD,
  VIEW_SCALE_CARD_REWARD_GROUP,
  VIEW_SCALE_DRAWING_TOOLS,
  VIEW_SCALE_MAP_LEGEND,
  VIEW_SCALE_MERCHANT_GROUP,
  VIEW_SCALE_PILE,
  VIEW_SCALE_REWARD_LIST,
  VIEW_SCALE_TREASURE_RELIC,
  VIEW_SCALE_VIEW_UPGRADES_DECK,
  VIEW_SCALE_VIEW_UPGRADES_DETAIL
} from "@/mirror/viewScale";
import { remapViewScaleInverse, viewScaleInverseMapPoint, type ViewScaleAabb } from "@/mirror/viewScaleInverse";
import {
  buildViewScaleInputRegistry,
  computeViewScaleStamp,
  designAabbOf,
  opensCardRewardScreen,
  resolveViewScaleForNode,
  VIEW_SCALE_NOMINAL_CARD_H,
  VIEW_SCALE_NOMINAL_CARD_W,
  viewScaleNominalBox,
  viewScaleStampMatrix,
  type ViewScaleEnv,
  type ViewScaleRegistryEnv,
  type ViewScaleStamp,
  type ViewScaleStampIndex
} from "@/mirror/viewScaleLayout";

const MERCHANT_INVENTORY = "res://scenes/merchant/merchant_inventory.tscn";
const MAP_SCREEN = "res://scenes/screens/map/map_screen.tscn";
const REWARDS_SCREEN = "res://scenes/screens/rewards_screen.tscn";
const DECK_VIEW_SCREEN = "res://scenes/screens/deck_view_screen.tscn";
const INSPECT_CARD_SCREEN = "res://scenes/screens/inspect_card_screen.tscn";
const DRAW_PILE = "res://scenes/combat/draw_pile.tscn";

function mkNode(id: string, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId: null,
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

/** An env whose scene resolver answers from a fixed table with readability scaling enabled. */
function env(scenes: Record<string, { file: string; relPath: string }>, over: Partial<ViewScaleEnv> = {}): ViewScaleEnv {
  return {
    enabled: () => true,
    sceneOf: (id) => scenes[id] ?? null,
    ...over
  };
}

describe("S1 — the pre-filter shadowing trap (VIEW_SCALE_ROOT_FILES absences are deliberate)", () => {
  // The registration branch is an if/else CHAIN: a node that passes the cheap pre-filter takes the TABLE branch
  // even when the table then answers neutral. So a scene root whose rule really fires on a CHILD (or on a node-type
  // leaf) must NOT be in the root-file set, or its root would shadow the branch that actually stamps it.

  it("a map_screen.tscn ROOT resolves to nothing — its rules live on MapLegend / DrawingTools", () => {
    const node = mkNode("map", { sceneFilePath: MAP_SCREEN, name: "MapScreen" });
    const e = env({ map: { file: MAP_SCREEN, relPath: "" } });
    expect(resolveViewScaleForNode("map", node, "NMapScreen", false, e)).toBeNull();
  });

  it("…while its MapLegend / DrawingTools CHILDREN resolve through the NAME pre-filter", () => {
    const e = env({
      legend: { file: MAP_SCREEN, relPath: "MapLegend" },
      tools: { file: MAP_SCREEN, relPath: "DrawingTools" }
    });
    const legend = mkNode("legend", { name: "MapLegend" });
    const tools = mkNode("tools", { name: "DrawingTools" });
    expect(resolveViewScaleForNode("legend", legend, "Control", false, e)).toMatchObject({
      scale: VIEW_SCALE_MAP_LEGEND,
      isGroup: true,
      pivot: "bottomRight",
      noClamp: true
    });
    expect(resolveViewScaleForNode("tools", tools, "NinePatchRect", false, e)).toMatchObject({
      scale: VIEW_SCALE_DRAWING_TOOLS,
      isGroup: true,
      pivot: "center",
      noClamp: true
    });
  });

  it("a rewards_screen.tscn ROOT resolves to nothing; its `Rewards` panel child is the 1.2 GROUP", () => {
    const root = mkNode("rew", { sceneFilePath: REWARDS_SCREEN, name: "RewardsScreen" });
    const panel = mkNode("panel", { name: "Rewards" });
    const e = env({
      rew: { file: REWARDS_SCREEN, relPath: "" },
      panel: { file: REWARDS_SCREEN, relPath: "Rewards" }
    });
    expect(resolveViewScaleForNode("rew", root, "NRewardsScreen", false, e)).toBeNull();
    expect(resolveViewScaleForNode("panel", panel, "Control", false, e)).toMatchObject({
      scale: VIEW_SCALE_REWARD_LIST,
      isGroup: true
    });
  });

  it("the deck / card-detail dialog ROOTS resolve to nothing; their View-Upgrades children carry the entries", () => {
    const e = env({
      deckRoot: { file: DECK_VIEW_SCREEN, relPath: "" },
      deckToggle: { file: DECK_VIEW_SCREEN, relPath: "ViewUpgrades" },
      detailRoot: { file: INSPECT_CARD_SCREEN, relPath: "" },
      detailToggle: { file: INSPECT_CARD_SCREEN, relPath: "Upgrade" }
    });
    expect(
      resolveViewScaleForNode("deckRoot", mkNode("deckRoot", { sceneFilePath: DECK_VIEW_SCREEN }), "Control", false, e)
    ).toBeNull();
    expect(
      resolveViewScaleForNode(
        "detailRoot",
        mkNode("detailRoot", { sceneFilePath: INSPECT_CARD_SCREEN }),
        "Control",
        false,
        e
      )
    ).toBeNull();
    expect(
      resolveViewScaleForNode("deckToggle", mkNode("deckToggle", { name: "ViewUpgrades" }), "Control", false, e)
    ).toMatchObject({ scale: VIEW_SCALE_VIEW_UPGRADES_DECK, pivot: "bottomLeft" });
    expect(
      resolveViewScaleForNode("detailToggle", mkNode("detailToggle", { name: "Upgrade" }), "Control", false, e)
    ).toMatchObject({ scale: VIEW_SCALE_VIEW_UPGRADES_DETAIL, pivot: "bottomCenter" });
  });

  it("a ROOT-FILE entry (the draw pile) resolves at its own root — the set's members do fire there", () => {
    const pile = mkNode("pile", { sceneFilePath: DRAW_PILE, name: "DrawPile" });
    const e = env({ pile: { file: DRAW_PILE, relPath: "" } });
    expect(resolveViewScaleForNode("pile", pile, "NDrawPileButton", false, e)).toMatchObject({
      scale: VIEW_SCALE_PILE,
      pivot: "bottomLeft",
      isGroup: false
    });
  });

  it("a pre-filtered node whose scene identity does NOT match the table resolves neutral, not by leaf", () => {
    // `SlotsContainer` passes the NAME pre-filter, so it takes the table branch — and the table's entry is scoped
    // to merchant_inventory.tscn. Under any other scene the answer is null, and the leaf branches below are NOT
    // consulted (that is the shadowing the chain order encodes).
    const slots = mkNode("slots", { name: "SlotsContainer" });
    const e = env({ slots: { file: "res://scenes/somewhere_else.tscn", relPath: "SlotsContainer" } });
    expect(resolveViewScaleForNode("slots", slots, CARD_REWARD_SCREEN_LEAF, false, e)).toBeNull();
    // …and the same node under the merchant scene IS the 1.1 unclamped group.
    const merchant = env({ slots: { file: MERCHANT_INVENTORY, relPath: "SlotsContainer" } });
    expect(resolveViewScaleForNode("slots", slots, "Control", false, merchant)).toMatchObject({
      scale: VIEW_SCALE_MERCHANT_GROUP,
      isGroup: true,
      noClamp: true
    });
  });

  it("a pre-filtered node with NO resolvable scene identity resolves to nothing", () => {
    const slots = mkNode("slots", { name: "SlotsContainer" });
    expect(resolveViewScaleForNode("slots", slots, "Control", false, env({}))).toBeNull();
  });
});

describe("S2 — the leaf-detected resolves and the card-reward ancestry flag", () => {
  it("the card-reward screen ROOT is the 1.10 whole-screen GROUP, unclamped", () => {
    expect(resolveViewScaleForNode("s", mkNode("s"), CARD_REWARD_SCREEN_LEAF, false, env({}))).toMatchObject({
      scale: VIEW_SCALE_CARD_REWARD_GROUP,
      isGroup: true,
      pivot: "center",
      noClamp: true
    });
  });

  it("an NCard is the per-card 1.15 ONLY under the ancestry flag", () => {
    const card = mkNode("c", { nodeType: "NCard" });
    expect(resolveViewScaleForNode("c", card, "NCard", false, env({}))).toBeNull();
    expect(resolveViewScaleForNode("c", card, "NCard", true, env({}))).toMatchObject({
      scale: VIEW_SCALE_CARD_REWARD_CARD,
      isGroup: false,
      noClamp: true
    });
  });

  it("`opensCardRewardScreen` is what sets that flag, and only for the screen leaf", () => {
    expect(opensCardRewardScreen(CARD_REWARD_SCREEN_LEAF)).toBe(true);
    expect(opensCardRewardScreen("NCard")).toBe(false);
    expect(opensCardRewardScreen("Control")).toBe(false);
  });

  it("the treasure relic HOLDER is leaf-detected: 1.25 about its bottom centre, unclamped", () => {
    expect(resolveViewScaleForNode("r", mkNode("r"), TREASURE_RELIC_LEAF, false, env({}))).toMatchObject({
      scale: VIEW_SCALE_TREASURE_RELIC,
      pivot: "bottomCenter",
      noClamp: true
    });
  });

  it("an ordinary combat node resolves to nothing — the hot path costs one Set lookup each", () => {
    const node = mkNode("x", { name: "Hitbox" });
    expect(resolveViewScaleForNode("x", node, "NCreature", false, env({}))).toBeNull();
  });
});

describe("S3 — the enablement and visibility gate", () => {
  it("disabled readability scaling makes every node neutral", () => {
    const e = env({ slots: { file: MERCHANT_INVENTORY, relPath: "SlotsContainer" } }, { enabled: () => false });
    expect(resolveViewScaleForNode("slots", mkNode("slots", { name: "SlotsContainer" }), "Control", false, e)).toBeNull();
    expect(resolveViewScaleForNode("s", mkNode("s"), CARD_REWARD_SCREEN_LEAF, false, e)).toBeNull();
  });

  it("a node with its OWN visible flag cleared resolves to nothing", () => {
    const e = env({ slots: { file: MERCHANT_INVENTORY, relPath: "SlotsContainer" } });
    const hidden = mkNode("slots", { name: "SlotsContainer", visible: false });
    expect(resolveViewScaleForNode("slots", hidden, "Control", false, e)).toBeNull();
  });

  it("`enabled` is re-read per call — an env is not a snapshot", () => {
    let on = false;
    const e = env({ s: { file: MERCHANT_INVENTORY, relPath: "SlotsContainer" } }, { enabled: () => on });
    const node = mkNode("s", { name: "SlotsContainer" });
    expect(resolveViewScaleForNode("s", node, "Control", false, e)).toBeNull();
    on = true;
    expect(resolveViewScaleForNode("s", node, "Control", false, e)).not.toBeNull();
  });
});

describe("S4 — the measure step", () => {
  const groupEntry = { scale: 1.1, isGroup: true, pivot: "center" as const, translateX: 0, translateY: 0, noClamp: true };
  const itemEntry = { scale: 1.25, isGroup: false, pivot: "center" as const, translateX: 0, translateY: 0, noClamp: false };

  it("designAabbOf transforms the four corners — a rotated box measures its envelope", () => {
    const box = designAabbOf([1, 0, 0, 1, 100, 200], { x: 0, y: 0, width: 40, height: 60 });
    expect(box).toEqual({ x: 100, y: 200, w: 40, h: 60 });
    // 90° rotation: [a,b,c,d] = [0,1,-1,0] ⇒ w/h swap.
    const rot = designAabbOf([0, 1, -1, 0, 100, 200], { x: 0, y: 0, width: 40, height: 60 });
    expect(rot.w).toBeCloseTo(60, 6);
    expect(rot.h).toBeCloseTo(40, 6);
  });

  it("designAabbOf honours the node-local box ORIGIN (nodeMatrix's translate)", () => {
    const box = designAabbOf([1, 0, 0, 1, 100, 200], { x: 5, y: 7, width: 40, height: 60 });
    expect(box).toEqual({ x: 105, y: 207, w: 40, h: 60 });
  });

  it("the nominal card box is 240x338 CENTRED on the design origin", () => {
    const box = viewScaleNominalBox(960, 540);
    expect(box).toEqual({
      x: 960 - VIEW_SCALE_NOMINAL_CARD_W / 2,
      y: 540 - VIEW_SCALE_NOMINAL_CARD_H / 2,
      w: VIEW_SCALE_NOMINAL_CARD_W,
      h: VIEW_SCALE_NOMINAL_CARD_H
    });
    expect(VIEW_SCALE_NOMINAL_CARD_W).toBe(240);
    expect(VIEW_SCALE_NOMINAL_CARD_H).toBe(338);
  });

  it("the P4 off-stage reject: a box wholly off the design rect gets NO stamp", () => {
    // The closed shop parks its SlotsContainer at local y ≈ −1000 while still Visible. Without the reject the
    // stamp's own on-screen clamp would drag the parked panel back into view.
    const parked: TipAabb = { x: 100, y: -1200, w: 1747, h: 978 };
    expect(computeViewScaleStamp(parked, groupEntry, MIRROR_DESIGN_WIDTH)).toBeNull();
  });

  it("…but a box only PARTIALLY off-stage still stamps (the clamp is the right answer there)", () => {
    const partly: TipAabb = { x: -50, y: 100, w: 400, h: 200 };
    expect(computeViewScaleStamp(partly, groupEntry, MIRROR_DESIGN_WIDTH)).not.toBeNull();
  });

  it("a degenerate box gets no stamp", () => {
    expect(computeViewScaleStamp({ x: 10, y: 10, w: 0, h: 0 }, itemEntry, MIRROR_DESIGN_WIDTH)).toBeNull();
  });

  it("noClamp keeps the growth exactly symmetric about the pivot; clamped pushes it back on-stage", () => {
    // A box hugging the right edge: at 1.25 the scaled right edge (1925) runs past 1920.
    const box: TipAabb = { x: 1700, y: 500, w: 200, h: 100 };
    const clamped = computeViewScaleStamp(box, itemEntry, MIRROR_DESIGN_WIDTH)!;
    const unclamped = computeViewScaleStamp(box, { ...itemEntry, noClamp: true }, MIRROR_DESIGN_WIDTH)!;
    expect(unclamped.offsetX).toBe(0);
    expect(clamped.offsetX).toBeLessThan(0); // pushed left, back inside the viewport
    expect(clamped.pivotX).toBe(unclamped.pivotX);
  });

  it("computeViewScaleStamp delegates to computeAnchoredScaleStamp with the entry's own pivot/translate", () => {
    const box: TipAabb = { x: 400, y: 300, w: 200, h: 100 };
    const entry = { scale: 1.2, isGroup: true, pivot: "bottomCenter" as const, translateX: 3, translateY: -7, noClamp: false };
    expect(computeViewScaleStamp(box, entry, MIRROR_DESIGN_WIDTH)).toEqual(
      computeAnchoredScaleStamp(box, 1.2, MIRROR_DESIGN_WIDTH, undefined, "bottomCenter", 3, -7, false)
    );
  });
});

describe("S5 — the stamp matrix IS the forward map the inverse inverts", () => {
  const res = { pivotX: 700, pivotY: 400, offsetX: 12, offsetY: -5 };
  const k = 1.2;

  it("viewScaleStampMatrix(k, res) maps p ↦ P + k(p − P) + C", () => {
    const m = viewScaleStampMatrix(k, res);
    expect(m[0]).toBe(k);
    expect(m[3]).toBe(k);
    expect(m[1]).toBe(0);
    expect(m[2]).toBe(0);
    for (const [px, py] of [
      [0, 0],
      [700, 400],
      [1234, 56]
    ]) {
      const mappedX = m[0] * px + m[2] * py + m[4];
      const mappedY = m[1] * px + m[3] * py + m[5];
      expect(mappedX).toBeCloseTo(res.pivotX + k * (px - res.pivotX) + res.offsetX, 9);
      expect(mappedY).toBeCloseTo(res.pivotY + k * (py - res.pivotY) + res.offsetY, 9);
    }
  });

  it("…and `viewScaleInverseMapPoint` takes a mapped point exactly back", () => {
    const m = viewScaleStampMatrix(k, res);
    const channel = { pivotX: res.pivotX, pivotY: res.pivotY, k, offsetX: res.offsetX, offsetY: res.offsetY };
    for (const [px, py] of [
      [10, 20],
      [960, 540],
      [1900, 1070]
    ]) {
      const fx = m[0] * px + m[2] * py + m[4];
      const fy = m[1] * px + m[3] * py + m[5];
      const back = viewScaleInverseMapPoint(channel, fx, fy);
      expect(back.x).toBeCloseTo(px, 9);
      expect(back.y).toBeCloseTo(py, 9);
    }
  });

  it("k = 1 (the ancient-dialogue lift) is a PURE translate", () => {
    const m = viewScaleStampMatrix(1, { pivotX: 500, pivotY: 500, offsetX: 0, offsetY: -70.4 });
    expect(m).toEqual([1, 0, 0, 1, 0, -70.4]);
  });
});

describe("S6 — the input registry truth table", () => {
  // A flat two-level tree: `root` → {`group`, `nb`, `under`, `backdrop`, `band`}, plus `group` → `inner`.
  const TREE: Record<string, string | null> = {
    root: null,
    group: "root",
    inner: "group",
    nb: "root",
    under: "root",
    backdrop: "root",
    band: "root"
  };

  function regEnv(over: Partial<ViewScaleRegistryEnv> = {}): ViewScaleRegistryEnv {
    return {
      parentIdOf: (id) => TREE[id] ?? null,
      get orderedIds() {
        // back-to-front: `under` paints BELOW the group, `nb` above it.
        return ["root", "under", "group", "inner", "nb", "backdrop", "band"];
      },
      ancestorChainHidden: () => false,
      designWidth: MIRROR_DESIGN_WIDTH,
      ...over
    };
  }

  function stamp(over: Partial<ViewScaleStamp> = {}): ViewScaleStamp {
    return {
      pivotX: 700,
      pivotY: 400,
      k: 1.2,
      offsetX: 0,
      offsetY: 0,
      box: { x: 600, y: 300, w: 200, h: 200 },
      spreadDx: 0,
      isGroup: true,
      ...over
    };
  }

  function rectAt(id: string, x: number, y: number, w: number, h: number) {
    return { id, transform: [1, 0, 0, 1, x, y] as const, localRect: { x: 0, y: 0, width: w, height: h } };
  }

  const stamps = (): ViewScaleStampIndex => new Map([["group", stamp()]]);

  it("an empty stamp index publishes nothing", () => {
    expect(buildViewScaleInputRegistry(new Map(), [rectAt("nb", 0, 0, 10, 10)], regEnv())).toEqual([]);
  });

  it("the ScaledBox is the pre-scale box forward-mapped through the channel", () => {
    const out = buildViewScaleInputRegistry(stamps(), [], regEnv());
    expect(out).toHaveLength(1);
    expect(out[0].originalBox).toEqual({ minX: 600, minY: 300, maxX: 800, maxY: 500 });
    // pivot (700,400), k 1.2 ⇒ [580,820] x [280,520]
    expect(out[0].scaledBox).toEqual({ minX: 580, minY: 280, maxX: 820, maxY: 520 });
    expect(out[0].renderedBox).toEqual(out[0].scaledBox); // dx === 0 on 16:9 ⇒ equal geometry
  });

  it("a spread shift moves the GAME-space stamp left and the renderedBox back right by exactly dx", () => {
    const out = buildViewScaleInputRegistry(new Map([["group", stamp({ spreadDx: 60 })]]), [], regEnv());
    expect(out[0].channel.pivotX).toBe(640);
    expect(out[0].originalBox).toEqual({ minX: 540, minY: 300, maxX: 740, maxY: 500 });
    expect(out[0].renderedBox).toEqual({
      minX: out[0].scaledBox.minX + 60,
      minY: out[0].scaledBox.minY,
      maxX: out[0].scaledBox.maxX + 60,
      maxY: out[0].scaledBox.maxY
    });
  });

  it("a nested widened-design channel keeps the enclosing scale's (k−1)·dx contribution", () => {
    // The group is centred in game coordinates while the card has its own +100 widened-stage field shift. Compose
    // in widened space first: card(600+100) → group(...) → subtract 100. Reducing each stamp to game space before
    // composition loses exactly the group's 0.10×100 = 10px contribution at the card edge.
    const index: ViewScaleStampIndex = new Map([
      ["group", stamp({ k: 1.1, pivotX: 960, pivotY: 400, box: { x: 0, y: 0, w: 1920, h: 800 }, spreadDx: 0 })],
      ["inner", stamp({ isGroup: false, k: 1.15, pivotX: 800, pivotY: 360, box: { x: 700, y: 340, w: 200, h: 40 }, spreadDx: 100 })]
    ]);
    const [, card] = buildViewScaleInputRegistry(index, [], regEnv());
    expect(card.originalBox).toEqual({ minX: 600, minY: 340, maxX: 800, maxY: 380 });
    expect(card.scaledBox.minX).toBeCloseTo(557.5, 9);
    expect(card.renderedBox!.minX).toBeCloseTo(657.5, 9);
    expect(card.renderedBox!.minX - card.scaledBox.minX).toBeCloseTo(100, 9);
    expect(card.ownUnscaledBox!.minX).toBeCloseTo(574, 9);
  });

  it("rule 0 — a NESTED stamp publishes its composed group∘item inverse and wins its border", () => {
    const index: ViewScaleStampIndex = new Map([
      ["group", stamp({ k: 1.1 })],
      ["inner", stamp({ isGroup: false, k: 1.15, pivotX: 660, pivotY: 360, box: { x: 640, y: 340, w: 40, h: 40 } })]
    ]);
    const out = buildViewScaleInputRegistry(index, [], regEnv());
    expect(out).toHaveLength(2);
    const [group, card] = out;
    expect(card.channel.k).toBeCloseTo(1.1 * 1.15, 9);
    // The card's true box is first enlarged 1.15 about (660,360), then carried by the 1.10 group.
    expect(card.scaledBox.minX).toBeCloseTo(630.7, 9);
    expect(card.scaledBox.minY).toBeCloseTo(330.7, 9);
    expect(card.scaledBox.maxX).toBeCloseTo(681.3, 9);
    expect(card.scaledBox.maxY).toBeCloseTo(381.3, 9);
    expect(card.ownUnscaledBox).toEqual({ minX: 634, minY: 334, maxX: 678, maxY: 378 });

    // The upper-left card border is inside the composed card box and the group box. Last-published card ownership
    // must run the composed inverse exactly once, rather than the old group-only 1.10 inverse.
    const point = { x: 631, y: 331 };
    const p = remapViewScaleInverse(point.x, point.y, out);
    expect(p).toEqual(viewScaleInverseMapPoint(card.channel, point.x, point.y));
    expect(p).not.toEqual(viewScaleInverseMapPoint(group.channel, point.x, point.y));
  });

  it("rule 0b — an ancestor-hidden stamp is not published (a closed screen claims no pointers)", () => {
    const out = buildViewScaleInputRegistry(stamps(), [], regEnv({ ancestorChainHidden: (id) => id === "group" }));
    expect(out).toEqual([]);
  });

  it("a plain overlapping overlay IS a neighbour", () => {
    const out = buildViewScaleInputRegistry(stamps(), [rectAt("nb", 590, 290, 40, 40)], regEnv());
    expect(out[0].neighborRects).toEqual([{ minX: 590, minY: 290, maxX: 630, maxY: 330 }]);
  });

  it("a rect that does NOT overlap the ScaledBox is not a neighbour", () => {
    const out = buildViewScaleInputRegistry(stamps(), [rectAt("nb", 1500, 900, 40, 40)], regEnv());
    expect(out[0].neighborRects).toEqual([]);
  });

  it("rule 1 — a strict ANCESTOR of the stamped node is never a neighbour", () => {
    const out = buildViewScaleInputRegistry(stamps(), [rectAt("root", 590, 290, 40, 40)], regEnv());
    expect(out[0].neighborRects).toEqual([]);
  });

  it("rule 1b — a rect INSIDE the stamped subtree is never a neighbour", () => {
    const out = buildViewScaleInputRegistry(stamps(), [rectAt("inner", 610, 310, 20, 20)], regEnv());
    expect(out[0].neighborRects).toEqual([]);
  });

  it("rule 2 — a rect ENCLOSING the pre-scale box is a backdrop, not a neighbour", () => {
    const out = buildViewScaleInputRegistry(stamps(), [rectAt("backdrop", 500, 200, 400, 400)], regEnv());
    expect(out[0].neighborRects).toEqual([]);
  });

  it("rule 3 — a full-stage BAND (≥95% of the design width) is never a neighbour", () => {
    const out = buildViewScaleInputRegistry(
      stamps(),
      [rectAt("band", 0, 290, MIRROR_DESIGN_WIDTH, 40)],
      regEnv()
    );
    expect(out[0].neighborRects).toEqual([]);
  });

  it("rule 4 — a rect painted UNDER the group is hidden by it and cannot own a tap there", () => {
    const out = buildViewScaleInputRegistry(stamps(), [rectAt("under", 590, 290, 40, 40)], regEnv());
    expect(out[0].neighborRects).toEqual([]);
  });

  it("rule 4 — a rect MISSING from the paint order is KEPT (native's TryGetValue arm)", () => {
    const out = buildViewScaleInputRegistry(stamps(), [rectAt("ghost", 590, 290, 40, 40)], regEnv());
    expect(out[0].neighborRects).toHaveLength(1);
  });

  it("rule 4 — an ITEM stamp uses its OWN paint index as the floor", () => {
    const item: ViewScaleStampIndex = new Map([["group", stamp({ isGroup: false })]]);
    const under = [rectAt("under", 590, 290, 40, 40)];
    expect(buildViewScaleInputRegistry(item, under, regEnv())[0].neighborRects).toEqual([]);
  });

  it("groupPaintFloor — a CONTIGUOUS stamped subtree keeps the ROOT's own index as the floor", () => {
    // group(2) → inner(3) is contiguous, so the floor stays at 2 and a rect painted at 4 (`nb`) survives.
    const index: ViewScaleStampIndex = new Map([
      ["group", stamp()],
      ["inner", stamp({ isGroup: false, box: { x: 640, y: 340, w: 40, h: 40 } })]
    ]);
    const out = buildViewScaleInputRegistry(index, [rectAt("nb", 590, 290, 40, 40)], regEnv());
    expect(out[0].neighborRects).toHaveLength(1);
  });

  it("groupPaintFloor — a NON-CONTIGUOUS stamped subtree raises the floor to the max stamped index", () => {
    // Interleave a foreign node between the group root and its stamped descendant, and put the candidate BETWEEN
    // them: with the contiguity fallback the floor rises past it, so the interleaved underlay is dropped.
    const order = ["root", "group", "nb", "inner", "backdrop"];
    const index: ViewScaleStampIndex = new Map([
      ["group", stamp()],
      ["inner", stamp({ isGroup: false, box: { x: 640, y: 340, w: 40, h: 40 } })]
    ]);
    const e = regEnv({
      get orderedIds() {
        return order;
      }
    });
    const out = buildViewScaleInputRegistry(index, [rectAt("nb", 590, 290, 40, 40)], e);
    expect(out[0].neighborRects).toEqual([]);
  });

  it("groupPaintFloor — a group root that is NOT painted disables rule 4 for it", () => {
    const e = regEnv({
      get orderedIds() {
        return ["root", "under", "nb"]; // no `group`
      }
    });
    const out = buildViewScaleInputRegistry(stamps(), [rectAt("under", 590, 290, 40, 40)], e);
    expect(out[0].neighborRects).toHaveLength(1);
  });

  it("a DUPLICATED id in the paint order keeps its LAST index", () => {
    // `under` appears at 1 (below the group) and again at 5 (above it). The later paint wins ⇒ it survives rule 4.
    const e = regEnv({
      get orderedIds() {
        return ["root", "under", "group", "inner", "nb", "under"];
      }
    });
    const out = buildViewScaleInputRegistry(stamps(), [rectAt("under", 590, 290, 40, 40)], e);
    expect(out[0].neighborRects).toHaveLength(1);
  });

  it("publication order follows the stamp map's INSERTION order — the input side's z-order", () => {
    const a = stamp({ box: { x: 100, y: 100, w: 100, h: 100 }, pivotX: 150, pivotY: 150 });
    const b = stamp({ box: { x: 900, y: 100, w: 100, h: 100 }, pivotX: 950, pivotY: 150 });
    const index: ViewScaleStampIndex = new Map([
      ["nb", a],
      ["under", b]
    ]);
    const out = buildViewScaleInputRegistry(index, [], regEnv());
    expect(out.map((s) => s.originalBox.minX)).toEqual([100, 900]);
  });

  it("the interactive rects are folded through the SAME designAabbOf the stamps measure with", () => {
    const rect = rectAt("nb", 590, 290, 40, 40);
    const out = buildViewScaleInputRegistry(stamps(), [rect], regEnv());
    const box = designAabbOf(rect.transform, rect.localRect);
    const expected: ViewScaleAabb = { minX: box.x, minY: box.y, maxX: box.x + box.w, maxY: box.y + box.h };
    expect(out[0].neighborRects[0]).toEqual(expected);
  });
});
