import { beforeEach, describe, expect, it } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import { resolveSceneInfo } from "@/mirror/canvas/hitTest";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, MIRROR_DESIGN_WIDTH, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import { remapViewScaleInverse, type ViewScaleAabb, type ViewScaleInputStamp } from "@/mirror/viewScaleInverse";
import { buildViewScaleInputRegistry } from "@/mirror/viewScaleLayout";

// R9 (WS-A) — the WEB half of the view-scale input-gate truth table: mirrorRenderer.buildViewScaleInputStamps and its
// FOUR neighbour-exclusion rules, in lockstep with the native
// tests/CouchCoop.MirrorProtocol.Tests/ViewScaleInputRegistryTests.cs (same cases, same names in the titles). Change
// one suite, change the other.
//
// THE BUG this suite locks down: the web builder shipped rules 1/2/3 only (ancestor / enclosure / stage-band) and
// never got native's rule 4 (the GROUP Z-rule). On the MAP, the map screen paints over the room it was opened from,
// so that room's creature `Hitbox` (interactive, 560 px wide, painted ~2000 paint slots BELOW the legend, not an
// ancestor, not enclosing the legend's pre-scale box, not a stage band) survived 1/2/3 and overlaps the legend's 1.2x
// ScaledBox. Every covered point of the enlarged legend interior was therefore EXEMPT from the inverse -> identity ->
// the legend's rows only reacted at their PRE-scale positions ("the legend interaction position is not mapped").
// Geometry below is the REAL live capture (.sts2/bench/r9-wsa-live-map.ndjson, map open over a combat room).

const LEGEND_SCENE = "res://scenes/screens/map/map_screen.tscn";
const MAP_POINT_SCENE = "res://scenes/ui/normal_map_point.tscn";

// Live legend box + the 1.2x bottomRight/noClamp stamp it resolves to.
const LEGEND = { x: 1536, y: 289, w: 340, h: 454 };
const LEGEND_SCALED: ViewScaleAabb = { minX: 1468, minY: 198.2, maxX: 1876, maxY: 743 };
// The enemy creature's hitbox from the same frame — the underlay that broke the legend.
const ENEMY_HITBOX: ViewScaleAabb = { minX: 1160, minY: 326, maxX: 1720, maxY: 740 };

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}

function rect(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}

function node(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: xform(0, 0),
    localRect: rect(100, 100),
    visible: true,
    ...over
  };
}

// A visible mouse-visible (Stop) Control at a game-space box — an interactive-rect candidate.
function hitRect(id: string, parentId: string | null, x: number, y: number, w: number, h: number): Record<string, unknown> {
  return node(id, parentId, { transform: xform(x, y), localRect: rect(w, h), mouseFilter: 0 });
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

// Reconcile one FULL keyframe (paint order = the given id order) and return the published input registry.
// `stretch` is the stage's horizontal spread factor (MirrorView.setStretch): 1 = 16:9, > 1 = a widened stage where
// anchored content shifts by its share of Δ = (stretch − 1)·1920 and the stamps carry a non-zero spreadDx.
function registryOf(nodes: Record<string, unknown>[], order: string[], stretch = 1): ViewScaleInputStamp[] {
  const { renderer } = harness();
  const state: MirrorState = createMirrorState();
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
  if (stretch !== 1) {
    renderer.setStretch(stretch);
  }
  renderer.reconcile(state);
  return renderer.viewScaleInputStamps();
}

function hasBox(boxes: readonly ViewScaleAabb[], target: ViewScaleAabb): boolean {
  return boxes.some(
    (b) =>
      Math.abs(b.minX - target.minX) < 0.5 &&
      Math.abs(b.minY - target.minY) < 0.5 &&
      Math.abs(b.maxX - target.maxX) < 0.5 &&
      Math.abs(b.maxY - target.maxY) < 0.5
  );
}

// The real map shape: MapScreen (the scene root, so the legend resolves by name) -> MapLegend (the 1.2x GROUP) with a
// row inside it, plus whatever extra nodes the case needs. `extras` are appended in the given ORDER position.
function mapScene(extras: { before?: Record<string, unknown>[]; after?: Record<string, unknown>[] } = {}): {
  nodes: Record<string, unknown>[];
  order: string[];
} {
  const before = extras.before ?? [];
  const after = extras.after ?? [];
  const nodes = [
    node("screen", null, { nodeType: "NMapScreen", sceneFilePath: LEGEND_SCENE, transform: xform(0, 0), localRect: rect(1920, 1080), mouseFilter: 0 }),
    ...before,
    node("MapLegend", "screen", { nodeType: "TextureRect", transform: xform(LEGEND.x, LEGEND.y), localRect: rect(LEGEND.w, LEGEND.h), mouseFilter: 2 }),
    // The legend's own interactive row — inside the stamped subtree, so never a neighbour (it rides the stamp).
    hitRect("row", "MapLegend", 1582, 390, 280, 48),
    ...after
  ];
  return { nodes, order: nodes.map((n) => n.id as string) };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("buildViewScaleInputStamps — neighbour rules (native twin: ViewScaleInputRegistryTests)", () => {
  it("publishes the map legend as a GROUP stamp with the live ScaledBox", () => {
    const { nodes, order } = mapScene();
    const reg = registryOf(nodes, order);
    expect(reg).toHaveLength(1);
    expect(reg[0].isGroup).toBe(true);
    expect(reg[0].scaledBox.minX).toBeCloseTo(LEGEND_SCALED.minX, 3);
    expect(reg[0].scaledBox.minY).toBeCloseTo(LEGEND_SCALED.minY, 3);
    expect(reg[0].scaledBox.maxX).toBeCloseTo(LEGEND_SCALED.maxX, 3);
    expect(reg[0].scaledBox.maxY).toBeCloseTo(LEGEND_SCALED.maxY, 3);
    // The legend's own row sits in the stamped subtree → never collected (pre-existing rule, guarded here too).
    expect(reg[0].neighborRects).toHaveLength(0);
  });

  // UnderlayBelowGroupIsNotNeighbor + OverlayAboveGroupIsNeighbor (native pair), same scene.
  it("rule 4 (Z-rule): drops a rect painted BELOW the group, keeps one painted ABOVE", () => {
    const underlay: ViewScaleAabb = { minX: 1500, minY: 400, maxX: 1580, maxY: 460 };
    const overlay: ViewScaleAabb = { minX: 1700, minY: 400, maxX: 1780, maxY: 460 };
    const { nodes, order } = mapScene({
      before: [hitRect("underlay", "screen", 1500, 400, 80, 60)],
      after: [hitRect("overlay", "screen", 1700, 400, 80, 60)]
    });
    const neighbors = registryOf(nodes, order)[0].neighborRects;
    expect(hasBox(neighbors, underlay)).toBe(false); // painted under the legend → invisible there → not a neighbour
    expect(hasBox(neighbors, overlay)).toBe(true); // a legitimate overlay paints AFTER the whole group
    expect(neighbors).toHaveLength(1);
  });

  // THE map-shaped regression, with the live geometry: the combat creature's Hitbox under the map legend.
  it("rule 4: the live combat creature Hitbox under the map legend is dropped and the enlarged interior remaps", () => {
    const { nodes, order } = mapScene({
      before: [
        node("room", null, { transform: xform(0, 0), localRect: rect(1920, 1080), mouseFilter: 2 }),
        hitRect("enemyHitbox", "room", ENEMY_HITBOX.minX, ENEMY_HITBOX.minY, ENEMY_HITBOX.maxX - ENEMY_HITBOX.minX, ENEMY_HITBOX.maxY - ENEMY_HITBOX.minY)
      ]
    });
    const reg = registryOf(nodes, order);
    expect(reg).toHaveLength(1);
    expect(hasBox(reg[0].neighborRects, ENEMY_HITBOX)).toBe(false);
    expect(reg[0].neighborRects).toHaveLength(0);

    // End-to-end: (1600, 350) is inside the RENDERED top legend row — the live row (1582,390)-(1862,438) paints at
    // (1523,319)-(1859,377) under the 1.2x bottomRight stamp — and also inside the enemy hitbox. It must remap DOWN
    // into the true row, not stay put.
    expect(ENEMY_HITBOX.minX <= 1600 && 1600 <= ENEMY_HITBOX.maxX && ENEMY_HITBOX.minY <= 350 && 350 <= ENEMY_HITBOX.maxY).toBe(true);
    const p = remapViewScaleInverse(1600, 350, reg);
    // x = 1876 + (1600 − 1876)/1.2 = 1646, y = 743 + (350 − 743)/1.2 = 415.5 → inside the true row (390..438).
    expect(p.x).toBeCloseTo(1646, 3);
    expect(p.y).toBeCloseTo(415.5, 3);
    expect(p.y).toBeGreaterThan(390);
    expect(p.y).toBeLessThan(438);
  });

  it("control: the SAME hitbox painted ABOVE the legend stays a neighbour and freezes the point (proves it is the Z-rule)", () => {
    const { nodes, order } = mapScene({
      after: [
        node("room", null, { transform: xform(0, 0), localRect: rect(1920, 1080), mouseFilter: 2 }),
        hitRect("enemyHitbox", "room", ENEMY_HITBOX.minX, ENEMY_HITBOX.minY, ENEMY_HITBOX.maxX - ENEMY_HITBOX.minX, ENEMY_HITBOX.maxY - ENEMY_HITBOX.minY)
      ]
    });
    const reg = registryOf(nodes, order);
    expect(hasBox(reg[0].neighborRects, ENEMY_HITBOX)).toBe(true);
    // This is the pre-fix behaviour, and it is CORRECT for a genuine overlay: the point belongs to the thing on top.
    expect(remapViewScaleInverse(1600, 350, reg)).toEqual({ x: 1600, y: 350 });
  });

  // Rules 1/2/3 in isolation — every candidate here is painted ABOVE the legend, so ONLY the older rule can drop it
  // (rule 4 must not be what is doing the work, and must not have masked a regression in 1/2/3).
  it("rules 1/2/3 still drop an ancestor / an enclosing backdrop / a stage band painted ABOVE the group", () => {
    const backdrop: ViewScaleAabb = { minX: 1530, minY: 283, maxX: 1882, maxY: 749 };
    const band: ViewScaleAabb = { minX: 0, minY: 400, maxX: 1900, maxY: 460 };
    const { nodes, order } = mapScene({
      after: [
        node("backdrop", "screen", { transform: xform(1530, 283), localRect: rect(352, 466), mouseFilter: 0 }),
        node("band", "screen", { transform: xform(0, 400), localRect: rect(1900, 60), mouseFilter: 0 }),
        hitRect("overlay", "screen", 1700, 400, 80, 60)
      ]
    });
    const neighbors = registryOf(nodes, order)[0].neighborRects;
    // 1. `screen` is a strict ANCESTOR of the legend (full-viewport, mouseFilter Stop) — never a neighbour.
    expect(hasBox(neighbors, { minX: 0, minY: 0, maxX: 1920, maxY: 1080 })).toBe(false);
    expect(hasBox(neighbors, backdrop)).toBe(false); // 2. encloses the legend's PRE-scale box
    expect(hasBox(neighbors, band)).toBe(false); // 3. ≥ 0.95 × 1920 wide
    expect(hasBox(neighbors, { minX: 1700, minY: 400, maxX: 1780, maxY: 460 })).toBe(true);
    expect(neighbors).toHaveLength(1);
  });

  // ItemHaloSiblingSurvivesFilter (native twin). An ITEM stamp's halo sibling survives when it paints ABOVE the item
  // (a legitimate un-scaled overlay). R19 WP-6d gave item stamps a paint floor of their OWN index, so the same
  // sibling painted BELOW is now dropped — an item's halo is the pixels it paints OVER, so a rect it paints over
  // cannot be what the finger is on.
  it("rule 4 for an ITEM stamp: a halo sibling ABOVE it survives, one BELOW it is dropped", () => {
    const sibling: ViewScaleAabb = { minX: 500, minY: 380, maxX: 550, maxY: 400 };
    const siblingNode = hitRect("sibling", "map", 500, 380, 50, 20); // inside the point's 1.5x halo
    const pointNodes = [
      node("point", "map", {
        nodeType: "NNormalMapPoint",
        sceneFilePath: MAP_POINT_SCENE,
        transform: xform(459, 339),
        localRect: rect(56, 56),
        mouseFilter: 1
      }),
      node("pointIcon", "point", { transform: xform(459, 339), localRect: rect(56, 56), mouseFilter: 2 })
    ];
    const mapNode = node("map", null, { transform: xform(0, 0), localRect: rect(1920, 1080), mouseFilter: 2 });
    const above = [mapNode, ...pointNodes, siblingNode]; // sibling painted LAST → above the item
    const below = [mapNode, siblingNode, ...pointNodes]; // sibling painted FIRST → under the item

    const regAbove = registryOf(above, above.map((n) => n.id as string));
    expect(regAbove).toHaveLength(1);
    expect(regAbove[0].isGroup).toBe(false);
    expect(hasBox(regAbove[0].neighborRects, sibling)).toBe(true);

    const regBelow = registryOf(below, below.map((n) => n.id as string));
    expect(regBelow).toHaveLength(1);
    expect(hasBox(regBelow[0].neighborRects, sibling)).toBe(false); // the R19 item paint floor

  });

  // GroupPaintFloor's defensive contiguity fallback (native ViewScaleInputRegistry.GroupPaintFloor): when a FOREIGN
  // node interleaves between a group root and a stamped DESCENDANT of it (a non-DFS paint order), the floor rises to
  // the subtree max so the interleaved underlay is still dropped. Uses the card-reward screen (a GROUP with a nested
  // per-card stamp) because it is the only shape with a stamped descendant.
  it("rule 4 contiguity fallback: an underlay interleaved inside the group's stamped subtree is still dropped", () => {
    const interleaved: ViewScaleAabb = { minX: 300, minY: 300, maxX: 380, maxY: 360 };
    const build = (order: string[]) => {
      const nodes = [
        node("screen", null, { nodeType: "NCardRewardSelectionScreen", transform: xform(0, 0), localRect: rect(1920, 1080), mouseFilter: 2 }),
        node("card", "screen", { nodeType: "NCard", transform: xform(880, 430), localRect: rect(160, 220), mouseFilter: 2 }),
        node("cardArt", "card", { transform: xform(880, 430), localRect: rect(160, 220), mouseFilter: 2 }),
        hitRect("foreign", null, 300, 300, 80, 60)
      ];
      const byId = new Map(nodes.map((n) => [n.id as string, n]));
      return registryOf(order.map((id) => byId.get(id)!), order);
    };

    // NON-contiguous: `foreign` paints between the group root and its stamped NCard descendant → floor rises to the
    // card's index → foreign is under the subtree → dropped.
    const gap = build(["screen", "foreign", "card", "cardArt"]);
    expect(gap).toHaveLength(2); // group plus the composed per-card stamp
    expect(gap[0].isGroup).toBe(true);
    expect(hasBox(gap[0].neighborRects, interleaved)).toBe(false);

    // CONTIGUOUS control: the same rect painted after the whole subtree is a legitimate overlay → kept.
    const contiguous = build(["screen", "card", "cardArt", "foreign"]);
    expect(hasBox(contiguous[0].neighborRects, interleaved)).toBe(true);
  });
});

// The WEB-ONLY `renderedBox` the input side's false-halo guard tests the RAW pointer against (see
// viewScaleInverse's header + viewScaleInverse.spec's "renderedBox guard" describe). It is the stamp's ON-STAGE box
// in WIDENED-DESIGN space: forward-mapping the widened stamp (pivot P+dx, box B+dx) yields
// (P+dx) + k·((B+dx) − (P+dx)) + C = scaledBox + dx, so the box shifts by exactly the applied spreadDx on X while
// the clamp offset and both Y edges carry unchanged. No native twin (native's InverseRemap already tests a raw
// design point against spread-folded boxes).
describe("buildViewScaleInputStamps — renderedBox (widened-design on-stage box)", () => {
  const DESIGN_W = 2214; // the ultrawide stage the false-halo bug reproduces on
  const STRETCH = DESIGN_W / 1920; // 1.153125
  const DELTA = DESIGN_W - 1920; // 294 — the root's parent-width delta anchor fractions budget against

  // The map legend, but CENTRE-anchored (0.5/0.5) so a widened stage really does shift it: dx = ½·Δ = 147 — the same
  // shift the live ancient-event OptionsContainer picks up at this width.
  function centredLegendScene(): { nodes: Record<string, unknown>[]; order: string[] } {
    const nodes = [
      node("screen", null, {
        nodeType: "NMapScreen",
        sceneFilePath: LEGEND_SCENE,
        transform: xform(0, 0),
        localRect: rect(1920, 1080),
        mouseFilter: 0,
        anchorLeft: 0,
        anchorRight: 1
      }),
      node("MapLegend", "screen", {
        nodeType: "TextureRect",
        transform: xform(LEGEND.x, LEGEND.y),
        localRect: rect(LEGEND.w, LEGEND.h),
        mouseFilter: 2,
        anchorLeft: 0.5,
        anchorRight: 0.5
      })
    ];
    return { nodes, order: nodes.map((n) => n.id as string) };
  }

  it("at spreadFactor 1 (16:9) renderedBox IS the ScaledBox — the guard is a provable no-op", () => {
    const { nodes, order } = mapScene();
    const reg = registryOf(nodes, order);
    expect(reg).toHaveLength(1);
    expect(reg[0].renderedBox).toBeDefined();
    expect(reg[0].renderedBox).toEqual(reg[0].scaledBox);
  });

  it("on a WIDENED stage renderedBox is the ScaledBox shifted by exactly the applied spreadDx (Y + ScaledBox unchanged)", () => {
    const { nodes, order } = centredLegendScene();
    const narrow = registryOf(nodes, order)[0];
    const wide = registryOf(nodes, order, STRETCH)[0];
    const dx = DELTA / 2; // 147 — the centre-anchored legend's share

    // The GAME-space ScaledBox is spread-invariant (the builder subtracts dx before forward-mapping), so the
    // resolved-point containment test is byte-identical at both widths...
    expect(wide.scaledBox.minX).toBeCloseTo(narrow.scaledBox.minX, 6);
    expect(wide.scaledBox.maxX).toBeCloseTo(narrow.scaledBox.maxX, 6);
    expect(wide.scaledBox.minY).toBeCloseTo(narrow.scaledBox.minY, 6);
    expect(wide.scaledBox.maxY).toBeCloseTo(narrow.scaledBox.maxY, 6);

    // ...while renderedBox tracks where the stamp actually PAINTS on the widened stage.
    expect(wide.renderedBox).toBeDefined();
    expect(wide.renderedBox!.minX - wide.scaledBox.minX).toBeCloseTo(dx, 6);
    expect(wide.renderedBox!.maxX - wide.scaledBox.maxX).toBeCloseTo(dx, 6);
    expect(wide.renderedBox!.minY).toBeCloseTo(wide.scaledBox.minY, 6);
    expect(wide.renderedBox!.maxY).toBeCloseTo(wide.scaledBox.maxY, 6);
    // The 16:9 build is still the degenerate case of the same rule.
    expect(narrow.renderedBox).toEqual(narrow.scaledBox);
  });
});

// R10 WS-F — EFFECTIVE VISIBILITY. A SCREEN is hidden by clearing the flag on its ROOT; every descendant keeps
// `visible: true`. The stamp pass only tested the item's OWN flag, so a CLOSED map screen kept publishing its
// MapLegend (1.2 group) and NNormalMapPoint (1.5) stamps into this coordinate-only registry while the player was back
// in COMBAT. Nothing was drawn (the elements are display:none), but every pointer whose resolved game X crossed one of
// those bands was silently remapped: measured on the real page with a combat recording, 66.7 design px of
// instantaneous cursor jump at 1920x1080 and 67.6 at 2520x1080 (scripts/probe-targeting-drag-jump.mjs). Native twin:
// the EffectivelyVisible gate in ViewScaleStampIndex.Build.
describe("buildViewScaleInputStamps — effective visibility (R10 WS-F)", () => {
  it("publishes nothing for a stamp under a HIDDEN ancestor (the closed map screen behind combat)", () => {
    const { nodes, order } = mapScene();
    // Close the screen the way the game does: the ROOT's flag drops, the legend's own stays true.
    const hidden = nodes.map((n) => (n.id === "screen" ? { ...n, visible: false } : n));
    expect(hidden.find((n) => n.id === "MapLegend")!.visible).toBe(true);
    expect(registryOf(hidden, order)).toHaveLength(0);
  });

  it("still publishes it while the screen is open (the gate only subtracts hidden stamps)", () => {
    const { nodes, order } = mapScene();
    expect(registryOf(nodes, order)).toHaveLength(1);
  });

  it("publishes nothing for a stamp whose OWN flag is clear (unchanged pre-existing rule)", () => {
    const { nodes, order } = mapScene();
    const hidden = nodes.map((n) => (n.id === "MapLegend" ? { ...n, visible: false } : n));
    expect(registryOf(hidden, order)).toHaveLength(0);
  });

  it("re-publishes as soon as the ancestor is visible again (no stamp memory to go stale)", () => {
    const { nodes, order } = mapScene();
    const { renderer } = harness();
    const state: MirrorState = createMirrorState();
    const closed = nodes.map((n) => (n.id === "screen" ? { ...n, visible: false } : n));
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: closed, orderedIds: order })!);
    renderer.reconcile(state);
    expect(renderer.viewScaleInputStamps()).toHaveLength(0);

    // One delta flips the ancestor back on — the SAME drain must re-stamp (a `visible` flip bumps the geometry
    // epoch, which is what re-runs the pass).
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: [{ id: "screen", visible: true }] })!);
    renderer.reconcile(state);
    expect(renderer.viewScaleInputStamps()).toHaveLength(1);
  });
});

// M2 — THE TWO BACKENDS FOLD THE SAME DELTA THE SAME WAY.
//
// The registry is now `viewScaleLayout.buildViewScaleInputRegistry`, called by both stages. The DOM backend feeds
// it its records + `state.orderedIds`; the canvas backend feeds it the draw-list walk's stamps + its own z-sorted
// paint order. Same delta in, same claim out — which is the property a player actually experiences (a tap in the
// legend's halo has to reach the same row on either stage).
//
// The ONE pre-registered divergence is that order: `state.orderedIds` is the producer's pre-order DFS, while the
// canvas order is z-sorted and show-behind-lifted. Rule 4 asks "is this rect painted UNDER the item", so the
// sorted order is the more faithful answer — class (a), canvas more correct. On a scene where the two orders
// agree (this one — no z_index, no show_behind_parent) the registries have to be identical.
describe("cross-backend lockstep — the same delta folds to the same registry", () => {
  function canvasRegistryOf(nodes: Record<string, unknown>[], order: string[], spreadFactor = 1): ViewScaleInputStamp[] {
    const state: MirrorState = createMirrorState();
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
    const built = buildDrawList(state, createDrawList<string>(), {
      assert: true,
      spreadFactor,
      viewScaleEnv: {
        enabled: () => true,
        sceneOf: (id) => resolveSceneInfo(id, state.nodes)
      }
    });
    const rects = built.hitEntries
      .filter((e) => e.mouseVisible)
      .map((e) => ({ id: e.nodeId, transform: e.mGame, localRect: e.localRect }));
    return buildViewScaleInputRegistry(built.viewScaleStamps, rects, {
      parentIdOf: (id) => state.nodes.get(id)?.parentId,
      get orderedIds() {
        return built.order.ids;
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
    });
  }

  /** Compare only what the pointer inverse reads, and to the half-pixel the rest of this file uses. */
  function shape(reg: readonly ViewScaleInputStamp[]) {
    return reg.map((s) => ({
      isGroup: s.isGroup,
      k: Math.round(s.channel.k * 1e6) / 1e6,
      pivot: [Math.round(s.channel.pivotX * 2) / 2, Math.round(s.channel.pivotY * 2) / 2],
      offset: [Math.round(s.channel.offsetX * 2) / 2, Math.round(s.channel.offsetY * 2) / 2],
      scaled: [
        Math.round(s.scaledBox.minX * 2) / 2,
        Math.round(s.scaledBox.minY * 2) / 2,
        Math.round(s.scaledBox.maxX * 2) / 2,
        Math.round(s.scaledBox.maxY * 2) / 2
      ],
      neighbors: s.neighborRects
        .map((b) => [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 2) / 2).join(","))
        .sort()
    }));
  }

  it("the map legend, with an underlay below it and an overlay above it", () => {
    const { nodes, order } = mapScene({
      before: [hitRect("underlay", "screen", 1500, 400, 80, 60)],
      after: [hitRect("overlay", "screen", 1700, 400, 80, 60)]
    });
    const dom = shape(registryOf(nodes, order));
    expect(dom).toHaveLength(1);
    expect(dom[0].neighbors).toHaveLength(1); // the overlay survives, the underlay does not
    expect(shape(canvasRegistryOf(nodes, order))).toEqual(dom);
  });

  it("a reward-card border uses the composed card channel on both stages", () => {
    const nodes = [
      node("screen", null, {
        nodeType: "NCardRewardSelectionScreen",
        transform: xform(0, 0),
        localRect: rect(1920, 1080),
        mouseFilter: 2
      }),
      node("card", "screen", {
        nodeType: "NCard",
        transform: xform(700, 420),
        localRect: rect(240, 338),
        mouseFilter: 2
      })
    ];
    const order = nodes.map((n) => n.id as string);
    const dom = registryOf(nodes, order);
    const canvas = canvasRegistryOf(nodes, order);
    expect(shape(canvas)).toEqual(shape(dom));
    expect(dom).toHaveLength(2);
    const [group, card] = dom;
    expect(card.channel.k).toBeCloseTo(1.1 * 1.15, 9);

    // The left edge is visually painted by the enlarged card, but lies outside the true card face. Its single
    // composed inverse must still settle inside that face; the old group-only registry left it outside.
    const x = card.scaledBox.minX + 1;
    const y = (card.scaledBox.minY + card.scaledBox.maxY) / 2;
    const mapped = remapViewScaleInverse(x, y, dom);
    const groupOnly = remapViewScaleInverse(x, y, [group]);
    expect(mapped.x).toBeGreaterThanOrEqual(card.originalBox.minX);
    expect(mapped.x).toBeLessThanOrEqual(card.originalBox.maxX);
    expect(mapped.x).not.toBeCloseTo(groupOnly.x, 4);
  });

  it("…and a closed screen publishes nothing on either stage", () => {
    const { nodes, order } = mapScene();
    const closed = nodes.map((n) => (n.id === "screen" ? { ...n, visible: false } : n));
    expect(registryOf(closed, order)).toHaveLength(0);
    expect(canvasRegistryOf(closed, order)).toHaveLength(0);
  });

  it("the inverse contracts a halo point onto the same true coordinate on both stages", () => {
    const { nodes, order } = mapScene();
    // A point in the legend's 1.2x halo band, above its pre-scale top edge (289).
    const [px, py] = [1600, 240];
    const domPoint = remapViewScaleInverse(px, py, registryOf(nodes, order));
    const canvasPoint = remapViewScaleInverse(px, py, canvasRegistryOf(nodes, order));
    expect(domPoint.x).not.toBeCloseTo(px, 3); // the gate would be vacuous if nothing claimed it
    expect(canvasPoint.x).toBeCloseTo(domPoint.x, 3);
    expect(canvasPoint.y).toBeCloseTo(domPoint.y, 3);
  });
});
