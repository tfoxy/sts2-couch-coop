import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,




  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// R10-PERF5 WS-1 — DORMANT HIDDEN SUBTREES.
//
// A census of the canonical combat recording found 82.8% of all stage elements (4,365 of 5,270) sitting under
// `visible=false` subtree roots — a closed MapScreen alone is 1,922 elements. Dormancy is the boundary that stops
// building them: a node that is effectively hidden (its own flag, or an ancestor's) AND has no element yet keeps
// its RenderRecord marker but gets NO DOM and NO child recursion; its descendants get nothing at all.
//
// The properties these specs pin, in order:
//   1. nothing is built under a hidden root, and volatile churn aimed INTO one stays cheap;
//   2. a reveal builds the whole subtree in one walk — including child ORDER and the behindCount that decides
//      where a parent's own paint slots among its children (the one number a dormant sibling could corrupt);
//   3. dormancy is NEVER a teardown — a subtree built while visible keeps its DOM when it hides;
//   4. every neighbouring mechanism (order patches, occlusion, the adopt pool, tween hints, identity/touch attrs)
//      behaves under a dormant subtree.
//
// Every case drives REAL wire JSON through parseSceneDelta/applySceneDelta — never a hand-built MirrorState.

type Raw = Record<string, unknown>;

const NCARD = "MegaCrit.Sts2.Core.Nodes.Cards.NCard";

const xf = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });
const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const rgba = (r: number, g: number, b: number, a: number) => ({ r, g, b, a, html: "" });

function node(id: string, parentId: string | null, over: Raw = {}): Raw {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.Control",
    transform: xf(0, 0),
    localRect: rect(0, 0, 100, 16),
    visible: true,
    ...over
  };
}

// A boxed, painted leaf — real fill + a box, so it produces both an element and paint.
function boxed(id: string, parentId: string, x: number, y: number, over: Raw = {}): Raw {
  return node(id, parentId, {
    nodeType: "Godot.ColorRect",
    transform: xf(x, y),
    localRect: rect(0, 0, 80, 24),
    fillColor: rgba(1, 0, 0, 1),
    mouseFilter: 0,
    ...over
  });
}

let created: MirrorRenderer[] = [];

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  const renderer = createMirrorRenderer(stage, defs);
  created.push(renderer);
  return { stage, renderer };
}

function full(state: MirrorState, nodes: Raw[], order?: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: nodes,
      orderedIds: order ?? nodes.map((n) => n.id as string)
    })!
  );
}

function update(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

// A NON-full structural delta: the wire shape of a reorder / add / remove / reparent (orderedIds always present).
function structural(
  state: MirrorState,
  parts: { upserts?: Raw[]; removedIds?: string[]; orderedIds: string[] }
): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: parts.upserts ?? [],
      removedIds: parts.removedIds ?? [],
      orderedIds: parts.orderedIds
    })!
  );
}

function hintsOnly(state: MirrorState, hints: unknown[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", hints })!);
}

function el(stage: HTMLElement, id: string): HTMLElement | null {
  return stage.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
}

function nodeCount(stage: HTMLElement): number {
  return stage.querySelectorAll(".mirror-node").length;
}

function childIds(parent: HTMLElement): (string | null)[] {
  return [...parent.children].filter((c) => c.hasAttribute("data-node-id")).map((c) => c.getAttribute("data-node-id"));
}

// The element children of `parent` labelled by what they are: a mirror node id, or the kind of sub-layer. This is
// the sequence `behindCount` places — the whole point of the behindCount fix is that the parent's own paint must
// sit AFTER its behind-parent children and BEFORE its normal ones.
function childLayout(parent: HTMLElement): string[] {
  return [...parent.children].map((c) => {
    const id = c.getAttribute("data-node-id");
    if (id != null) return id;
    if (c.classList.contains("mirror-clip-self")) return "<self>";
    return `<${c.tagName.toLowerCase()}>`;
  });
}

// --- the screen scene ------------------------------------------------------------------------------------------
//
// Game
//  ├─ Combat        (always visible — the control group)
//  │   └─ CombatCard
//  └─ Map           (the SCREEN whose `visible` flips — the dormancy root)
//      ├─ MapInner
//      │   ├─ Dot1
//      │   ├─ Dot2
//      │   └─ MapCard   (an NCard — carries the touch-scan class stamped by createEl)
//      └─ MapEdge
const MAP_IDS = ["Map", "MapInner", "Dot1", "Dot2", "MapCard", "MapEdge"];
const VISIBLE_IDS = ["Game", "Combat", "CombatCard"];

function screenScene(mapVisible: boolean): Raw[] {
  return [
    node("Game", null),
    node("Combat", "Game"),
    boxed("CombatCard", "Combat", 100, 100),
    node("Map", "Game", { visible: mapVisible, sceneFilePath: "res://scenes/map/MapScreen.tscn" }),
    node("MapInner", "Map"),
    boxed("Dot1", "MapInner", 200, 200),
    boxed("Dot2", "MapInner", 300, 200),
    boxed("MapCard", "MapInner", 400, 200, { nodeType: NCARD }),
    boxed("MapEdge", "Map", 500, 400)
  ];
}

function mount(nodes: Raw[]): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
  const { stage, renderer } = harness();
  const state = createMirrorState();
  full(state, nodes);
  renderer.reconcile(state);
  return { stage, renderer, state };
}

beforeEach(() => {
  document.body.innerHTML = "";
  mirrorWalkStats.reset();
});

afterEach(() => {
  for (const r of created) {
    r.dispose();
  }
  created = [];
  document.body.innerHTML = "";
});

// --- 1. nothing is built --------------------------------------------------------------------------------------

describe("the dormancy boundary", () => {
  it("builds ZERO elements under a subtree hidden at the keyframe", () => {
    const { stage } = mount(screenScene(false));

    for (const id of VISIBLE_IDS) {
      expect(el(stage, id), `visible ${id}`).not.toBeNull();
    }
    for (const id of MAP_IDS) {
      expect(el(stage, id), `dormant ${id}`).toBeNull();
    }
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);
    // Exactly ONE boundary: the walk stops at `Map` and never reaches the five nodes below it.
    expect(mirrorWalkStats.dormantRoots).toBe(1);
    expect(mirrorWalkStats.dormantSkippedBuilds).toBe(1);
    expect(mirrorWalkStats.createEl).toBe(VISIBLE_IDS.length);
    expect(mirrorWalkStats.revealBuilds).toBe(0);
    expect(mirrorWalkStats.revealBuildMs).toBe(0);
  });

  it("is dormant for a VISIBLE node under a hidden ancestor too (the boundary is EFFECTIVE visibility)", () => {
    // Every node under `Map` is `visible: true` — only the screen root's own flag is false, which is exactly how
    // STS2 parks a closed screen. Nothing below it may build.
    const { stage } = mount(screenScene(false));
    expect(el(stage, "MapInner")).toBeNull();
    expect(el(stage, "Dot1")).toBeNull();
  });

  it("keeps volatile churn aimed INTO a dormant subtree free of DOM and O(depth) in the walk", () => {
    const { stage, renderer, state } = mount(screenScene(false));

    mirrorWalkStats.reset();
    // Two upserts deep inside the closed screen — the shape of a map that keeps animating while parked.
    update(state, [boxed("Dot1", "MapInner", 205, 200), boxed("Dot2", "MapInner", 305, 201)]);
    renderer.reconcile(state);

    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);
    expect(mirrorWalkStats.createEl).toBe(0);
    expect(mirrorWalkStats.styledNodes).toBe(0);
    // markDirty seeds Dot1/Dot2 + their ancestors, so the walk descends Game → Map and TERMINATES at the boundary.
    // `Game` is clean-with-a-dirty-descendant → the recurse-only fast path; `Map` is the single REAL visit; the
    // five nodes below it are never reached at all, and `Combat` skip-cleans without a visit.
    expect(mirrorWalkStats.visits).toBe(1);
    expect(mirrorWalkStats.fastPathVisits).toBe(1);
    expect(mirrorWalkStats.dormantRoots).toBe(1);
    expect(mirrorWalkStats.skippedSubtrees).toBeGreaterThanOrEqual(1);
  });

  it("skip-cleans a settled dormant root in O(1) — an unrelated delta never even reaches it", () => {
    const { renderer, state } = mount(screenScene(false));

    mirrorWalkStats.reset();
    update(state, [boxed("CombatCard", "Combat", 101, 100)]);
    renderer.reconcile(state);

    // `Map` is clean (same node object, same cached ctx incl. cAncestorHidden) and not in the dirty set, so the
    // skip gate returns before the dormancy branch — the boundary is not even RE-DERIVED (skippedBuilds flat),
    // while the marker itself of course still stands (the gauge is live membership, not a per-walk tally).
    expect(mirrorWalkStats.dormantSkippedBuilds).toBe(0);
    expect(mirrorWalkStats.dormantRoots).toBe(1);
    expect(mirrorWalkStats.skippedSubtrees).toBeGreaterThanOrEqual(1);
    expect(mirrorWalkStats.createEl).toBe(0);
  });
});

// --- 2. the reveal --------------------------------------------------------------------------------------------

describe("reveal", () => {
  it("builds the WHOLE subtree on the visible flip, in orderedIds order, with identity + touch attrs", () => {
    const { stage, renderer, state } = mount(screenScene(false));

    mirrorWalkStats.reset();
    update(state, [node("Map", "Game", { visible: true, sceneFilePath: "res://scenes/map/MapScreen.tscn" })]);
    renderer.reconcile(state);

    for (const id of MAP_IDS) {
      expect(el(stage, id), `revealed ${id}`).not.toBeNull();
    }
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
    expect(el(stage, "Map")!.style.display).toBe("");
    // Sibling order inside the revealed screen follows the wire paint order.
    expect(childIds(el(stage, "MapInner")!)).toEqual(["Dot1", "Dot2", "MapCard"]);
    expect(childIds(el(stage, "Map")!)).toEqual(["MapInner", "MapEdge"]);

    // Exactly ONE record was a dormant marker (`Map`); its five descendants had no records at all, so they are
    // ordinary first builds. The whole reveal is charged to `revealBuildMs`.
    expect(mirrorWalkStats.revealBuilds).toBe(1);
    expect(mirrorWalkStats.createEl).toBe(MAP_IDS.length);
    expect(mirrorWalkStats.revealBuildMs).toBeGreaterThan(0);
    expect(mirrorWalkStats.dormantRoots).toBe(0);
  });

  it("restamps every identity / touch attribute on the freshly built elements", () => {
    const { stage, renderer, state } = mount(screenScene(false));
    update(state, [node("Map", "Game", { visible: true, sceneFilePath: "res://scenes/map/MapScreen.tscn" })]);
    renderer.reconcile(state);

    const map = el(stage, "Map")!;
    expect(map.getAttribute("data-node-id")).toBe("Map");
    expect(map.getAttribute("data-node-type")).toBe("Godot.Control");
    expect(map.getAttribute("data-node-path")).toBe("Game/Map");
    expect(map.getAttribute("data-scene-file")).toBe("res://scenes/map/MapScreen.tscn");

    // The touch-scan class the drag/lift path keys off — stamped by createEl, so a card revealed inside a closed
    // screen is as draggable as one that was always on screen.
    const card = el(stage, "MapCard")!;
    expect(card.classList.contains("mirror-card-liftable")).toBe(true);
    expect(card.getAttribute("data-node-path")).toBe("Game/Map/MapInner/MapCard");
  });

  it("reveals through an ANCESTOR's flip (the dormant root's own node object never changes)", () => {
    // Hide `Game` itself: `Map` is then dormant with `visible: true`, and only `Game` is upserted to reveal.
    const nodes = screenScene(true);
    (nodes.find((n) => n.id === "Game") as Raw).visible = false;
    const { stage, renderer, state } = mount(nodes);
    expect(nodeCount(stage)).toBe(0);
    expect(mirrorWalkStats.dormantRoots).toBe(1); // the ROOT is the boundary

    update(state, [node("Game", null, { visible: true })]);
    renderer.reconcile(state);
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
    expect(mirrorWalkStats.revealBuilds).toBe(1);
  });

  it("is not swallowed while an ancestor owns a transform tween (the pin skip)", () => {
    const { stage, renderer, state } = mount(screenScene(false));
    // Arm a real transform tween on `Game`, so every descendant walks with ctx.pinnedAncestor = true.
    hintsOnly(state, [
      { targetId: "Game", property: "position", durationMs: 5000, trans: "Cubic", ease: "Out", endTransform: [1, 0, 0, 1, 40, 0] }
    ]);
    renderer.reconcile(state);

    update(state, [node("Map", "Game", { visible: true, sceneFilePath: "res://scenes/map/MapScreen.tscn" })]);
    renderer.reconcile(state);
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
  });
});

// --- 3. never a teardown --------------------------------------------------------------------------------------
//
// …on the PRUNED walks, which is what every case below drives (a volatile update / an incremental structural
// delta). R10-PERF5 WS-4 added the one exception — a FULL walk reclaims an already-built hidden subtree — because
// only a full walk owns the `visited` set + post-walk prune that can clean up the descendants. That half lives in
// `dormantReclaim.spec.ts`; the invariant here (a hide is never a teardown on the paths live play uses) is exactly
// what keeps the two from colliding.

describe("dormancy is never-build, not tear-down", () => {
  it("keeps the DOM of a subtree that was built while visible and then hidden", () => {
    const { stage, renderer, state } = mount(screenScene(true));
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
    const mapEl = el(stage, "Map")!;
    const dotEl = el(stage, "Dot1")!;

    mirrorWalkStats.reset();
    update(state, [node("Map", "Game", { visible: false, sceneFilePath: "res://scenes/map/MapScreen.tscn" })]);
    renderer.reconcile(state);

    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
    expect(el(stage, "Map")).toBe(mapEl); // element IDENTITY survives the hide
    expect(el(stage, "Dot1")).toBe(dotEl);
    expect(mapEl.style.display).toBe("none");
    // The root HAS an element, so it is not a dormancy boundary — nothing was skipped and nothing was removed.
    expect(mirrorWalkStats.dormantRoots).toBe(0);
    expect(mirrorWalkStats.removedRecords).toBe(0);
  });

  it("re-hides after a reveal without dropping a single element (hide → reveal → hide)", () => {
    const { stage, renderer, state } = mount(screenScene(false));
    update(state, [node("Map", "Game", { visible: true })]);
    renderer.reconcile(state);
    const built = nodeCount(stage);

    update(state, [node("Map", "Game", { visible: false })]);
    renderer.reconcile(state);
    expect(nodeCount(stage)).toBe(built);
    expect(el(stage, "Map")!.style.display).toBe("none");
    expect(mirrorWalkStats.dormantRoots).toBe(0);
  });
});

// --- 4. behindCount with MIXED built / dormant behind-children ------------------------------------------------
//
// A node's own paint sub-layers slot at index `behindCount` among its element's children (updateSubLayers' `lead`,
// applyChildOrder). Counting a DORMANT behind-child — which produces no element — would push the parent's own
// paint one slot too far and render it AFTER a normal child instead of before.

describe("behindCount across a dormancy boundary", () => {
  // Panel (painted box WITH children → its own paint lives on a `.mirror-clip-self` wrapper)
  //   ├─ Behind1   showBehindParent, VISIBLE   → an element
  //   ├─ Behind2   showBehindParent, HIDDEN    → DORMANT, no element
  //   └─ Normal1   normal child
  function panelScene(behind2Visible: boolean): Raw[] {
    return [
      node("Root", null),
      boxed("Panel", "Root", 0, 0, { localRect: rect(0, 0, 400, 300) }),
      boxed("Behind1", "Panel", 10, 10, { showBehindParent: true }),
      boxed("Behind2", "Panel", 20, 20, { showBehindParent: true, visible: behind2Visible }),
      boxed("Normal1", "Panel", 30, 30)
    ];
  }

  it("does NOT count a dormant behind-child — the parent's own paint keeps its slot", () => {
    const { stage } = mount(panelScene(false));
    const panel = el(stage, "Panel")!;
    expect(el(stage, "Behind2")).toBeNull();
    // Behind1, then the panel's own paint, then the normal child. Counting the dormant Behind2 would have put
    // `<self>` last (`lead = 2` against a single behind element).
    expect(childLayout(panel)).toEqual(["Behind1", "<self>", "Normal1"]);
  });

  it("re-counts it the moment it is revealed", () => {
    const { stage, renderer, state } = mount(panelScene(false));
    update(state, [boxed("Behind2", "Panel", 20, 20, { showBehindParent: true, visible: true })]);
    renderer.reconcile(state);

    expect(childLayout(el(stage, "Panel")!)).toEqual(["Behind1", "Behind2", "<self>", "Normal1"]);
  });

  it("counts a behind-child that is hidden but ALREADY BUILT (it keeps its element)", () => {
    const { stage, renderer, state } = mount(panelScene(true));
    expect(childLayout(el(stage, "Panel")!)).toEqual(["Behind1", "Behind2", "<self>", "Normal1"]);

    update(state, [boxed("Behind2", "Panel", 20, 20, { showBehindParent: true, visible: false })]);
    renderer.reconcile(state);
    // Hidden, but the element is still there and still occupies its behind slot — so the count must NOT drop.
    expect(childLayout(el(stage, "Panel")!)).toEqual(["Behind1", "Behind2", "<self>", "Normal1"]);
    expect(el(stage, "Behind2")!.style.display).toBe("none");
  });

  it("does not count a behind-child that is dormant because the PARENT is hidden", () => {
    // Panel itself is built (it was visible at the keyframe) and then hides; a NEW behind-child added under it is
    // dormant even though its own `visible` flag is true.
    const { stage, renderer, state } = mount(panelScene(true));
    update(state, [boxed("Panel", "Root", 0, 0, { localRect: rect(0, 0, 400, 300), visible: false })]);
    renderer.reconcile(state);

    structural(state, {
      upserts: [boxed("Behind3", "Panel", 40, 40, { showBehindParent: true })],
      orderedIds: ["Root", "Panel", "Behind1", "Behind2", "Behind3", "Normal1"]
    });
    renderer.reconcile(state);

    expect(el(stage, "Behind3")).toBeNull(); // visible flag, but its parent is hidden → dormant
    expect(childLayout(el(stage, "Panel")!)).toEqual(["Behind1", "Behind2", "<self>", "Normal1"]);
  });
});

// --- 5. neighbouring mechanisms -------------------------------------------------------------------------------

describe("order patches naming dormant parents", () => {
  it("applies a sibling reorder inside a dormant subtree with no DOM, and lands it on reveal", () => {
    const { stage, renderer, state } = mount(screenScene(false));

    mirrorWalkStats.reset();
    structural(state, {
      orderedIds: ["Game", "Combat", "CombatCard", "Map", "MapInner", "MapCard", "Dot2", "Dot1", "MapEdge"]
    });
    renderer.reconcile(state);
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);
    expect(mirrorWalkStats.createEl).toBe(0);
    expect(mirrorWalkStats.dormantRoots).toBe(1);

    update(state, [node("Map", "Game", { visible: true })]);
    renderer.reconcile(state);
    expect(childIds(el(stage, "MapInner")!)).toEqual(["MapCard", "Dot2", "Dot1"]);
  });

  it("survives an ADD + REMOVE inside a dormant subtree without building anything", () => {
    const { stage, renderer, state } = mount(screenScene(false));

    structural(state, {
      upserts: [boxed("Dot3", "MapInner", 350, 200)],
      orderedIds: ["Game", "Combat", "CombatCard", "Map", "MapInner", "Dot1", "Dot2", "Dot3", "MapCard", "MapEdge"]
    });
    renderer.reconcile(state);
    expect(el(stage, "Dot3")).toBeNull();

    structural(state, {
      removedIds: ["Dot1"],
      orderedIds: ["Game", "Combat", "CombatCard", "Map", "MapInner", "Dot2", "Dot3", "MapCard", "MapEdge"]
    });
    renderer.reconcile(state);
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);

    update(state, [node("Map", "Game", { visible: true })]);
    renderer.reconcile(state);
    expect(childIds(el(stage, "MapInner")!)).toEqual(["Dot2", "Dot3", "MapCard"]);
    expect(el(stage, "Dot1")).toBeNull();
  });

  it("tears down an element REPARENTED into a dormant subtree (the strand guard)", () => {
    // The one delta that can make a LIVE element unreachable: a node with an element moves under a dormant root,
    // so the walk never visits it and it would otherwise stay attached to its old dom parent forever.
    const { stage, renderer, state } = mount(screenScene(false));
    expect(el(stage, "CombatCard")).not.toBeNull();

    structural(state, {
      upserts: [boxed("CombatCard", "MapInner", 100, 100)],
      orderedIds: ["Game", "Combat", "Map", "MapInner", "Dot1", "Dot2", "MapCard", "CombatCard", "MapEdge"]
    });
    renderer.reconcile(state);

    expect(el(stage, "CombatCard")).toBeNull(); // no longer stranded under `Combat`
    expect(nodeCount(stage)).toBe(2); // Game + Combat

    update(state, [node("Map", "Game", { visible: true })]);
    renderer.reconcile(state);
    expect(childIds(el(stage, "MapInner")!)).toEqual(["Dot1", "Dot2", "MapCard", "CombatCard"]);
  });

  it("strand guard: ONE delta that both CREATES the hidden subtree and reparents into it", () => {
    // The gate on the strand guard must read the renderer's LIVE marker count, not the published
    // `mirrorWalkStats.dormantRoots` gauge (written only at the END of a walk, and zeroable by
    // `mirrorWalkStats.reset()`). This delta is the case that separates the two: at guard time the published gauge
    // is still 0 — there was no dormant subtree in the scene until this very walk created one — while the live
    // count is already 2. Reading the stale gauge would skip the guard and strand `CombatCard` under `Combat`.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("Game", null), node("Combat", "Game"), boxed("CombatCard", "Combat", 100, 100)]);
    renderer.reconcile(state);
    const strandedEl = el(stage, "CombatCard")!;
    expect(strandedEl.parentElement).toBe(el(stage, "Combat"));

    // Belt: also reproduce the second failure mode — an external reset() between walks (the bench does this on
    // every repeat) must not disable the guard either.
    mirrorWalkStats.reset();
    expect(mirrorWalkStats.dormantRoots).toBe(0);

    structural(state, {
      upserts: [
        node("Deck", "Game", { visible: false }), // the hidden subtree appears THIS walk…
        node("DeckList", "Deck"),
        boxed("CombatCard", "DeckList", 100, 100) // …and an already-built node moves into it in the same delta
      ],
      orderedIds: ["Game", "Combat", "Deck", "DeckList", "CombatCard"]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1); // the PRUNED path — no full-walk sweep to save us
    expect(el(stage, "CombatCard")).toBeNull(); // not stranded under `Combat`
    expect(strandedEl.isConnected).toBe(false);
    expect(nodeCount(stage)).toBe(2); // Game + Combat
    // Two markers: the new dormant root `Deck`, and `CombatCard`'s record, demoted by the guard.
    expect(mirrorWalkStats.dormantRoots).toBe(2);

    // The demoted record is a genuine marker: revealing the dialog rebuilds it in its NEW place.
    update(state, [node("Deck", "Game", { visible: true })]);
    renderer.reconcile(state);
    expect(childIds(el(stage, "DeckList")!)).toEqual(["CombatCard"]);
    expect(el(stage, "CombatCard")!.parentElement).toBe(el(stage, "DeckList"));
    expect(mirrorWalkStats.dormantRoots).toBe(0);
  });
});

describe("occlusion", () => {
  // Game
  //  ├─ World      (covered by the dialog)
  //  ├─ Closed     (a hidden sibling screen — DORMANT)
  //  └─ Dialog / Scrim  (the opaque full-stage cover)
  function coverScene(): Raw[] {
    return [
      node("Game", null, { localRect: rect(0, 0, 1920, 1080) }),
      node("World", "Game"),
      boxed("Enemy", "World", 300, 300),
      node("Closed", "Game", { visible: false }),
      boxed("ClosedItem", "Closed", 10, 10),
      node("Dialog", "Game"),
      node("Scrim", "Dialog", {
        nodeType: "Godot.ColorRect",
        transform: xf(0, 0),
        localRect: rect(0, 0, 1920, 1080),
        fillColor: rgba(0, 0, 0, 1),
        mouseFilter: 0
      })
    ];
  }

  it("gates the covered subtree normally while a dormant sibling sits beside it", () => {
    const { stage, renderer, state } = mount(coverScene());
    for (let i = 0; i < 3; i++) {
      renderer.reconcile(state); // satisfy the engage hysteresis
    }

    expect(el(stage, "World")!.style.display).toBe("none"); // the cover still engages
    expect(mirrorWalkStats.occludedRoots).toBeGreaterThanOrEqual(1);
    // The dormant sibling built nothing and is not (and cannot be) a gated root — there is no element to gate.
    expect(el(stage, "Closed")).toBeNull();
    expect(el(stage, "ClosedItem")).toBeNull();
  });

  it("gates a dormant subtree's elements once it is revealed under the cover", () => {
    const { stage, renderer, state } = mount(coverScene());
    for (let i = 0; i < 3; i++) {
      renderer.reconcile(state);
    }
    update(state, [node("Closed", "Game", { visible: true })]);
    for (let i = 0; i < 5; i++) {
      renderer.reconcile(state); // the gate re-engages through the normal hysteresis once an element exists
    }
    // Revealed BELOW the cover in paint order → gated exactly like `World`, with a real element to gate.
    expect(el(stage, "Closed")).not.toBeNull();
    expect(el(stage, "Closed")!.style.display).toBe("none");
  });
});

describe("the element-adoption pool", () => {
  // The pooled-shell recycle (see mirrorAdoption.spec.ts): the SAME walk removes one card's ids and adds another
  // set carrying the same `contentKey`. Filler keeps the delta on the INCREMENTAL structural path.
  const FILLER = 40;
  const fillerNodes = () => Array.from({ length: FILLER }, (_, i) => node(`f${i}`, "Root", { name: `F${i}` }));
  const fillerIds = () => Array.from({ length: FILLER }, (_, i) => `f${i}`);

  function card(prefix: string, parentId: string, contentKey: string): Raw[] {
    return [
      node(prefix, parentId, { name: "Card", nodeType: NCARD, contentKey, mouseFilter: 0 }),
      node(`${prefix}-cc`, prefix, { name: "CardContainer" }),
      node(`${prefix}-title`, `${prefix}-cc`, { name: "TitleLabel" })
    ];
  }
  const cardIds = (p: string) => [p, `${p}-cc`, `${p}-title`];

  function poolScene(): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        node("Root", null),
        node("Hand", "Root"),
        node("Deck", "Root", { visible: false }), // the CLOSED dialog
        node("DeckList", "Deck"),
        ...fillerNodes(),
        ...card("a", "Hand", "nc:strike#1")
      ],
      ["Root", "Hand", "Deck", "DeckList", ...fillerIds(), ...cardIds("a")]
    );
    renderer.reconcile(state);
    return { stage, renderer, state };
  }

  it("does NOT spend a pooled element on a card recycled INTO a closed dialog", () => {
    const { stage, renderer, state } = poolScene();
    expect(el(stage, "a")).not.toBeNull();

    mirrorWalkStats.reset();
    structural(state, {
      removedIds: cardIds("a"),
      upserts: card("b", "DeckList", "nc:strike#1"), // same contentKey, but the destination is dormant
      orderedIds: ["Root", "Hand", "Deck", "DeckList", ...fillerIds(), ...cardIds("b")]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.adoptions).toBe(0); // declined: never spend a real element on an invisible tree
    expect(mirrorWalkStats.condemnedSwept).toBe(cardIds("a").length); // the pool entries are torn down as usual
    for (const id of cardIds("b")) {
      expect(el(stage, id), `dormant ${id}`).toBeNull();
    }
    expect(el(stage, "a")).toBeNull();

    // …and it builds fresh on reveal (a missed reuse, never a bug).
    update(state, [node("Deck", "Root", { visible: true })]);
    renderer.reconcile(state);
    for (const id of cardIds("b")) {
      expect(el(stage, id), `revealed ${id}`).not.toBeNull();
    }
    expect(el(stage, "b")!.classList.contains("mirror-card-liftable")).toBe(true);
  });

  it("still adopts normally when the destination is VISIBLE", () => {
    const { stage, renderer, state } = poolScene();
    const before = cardIds("a").map((id) => el(stage, id));

    mirrorWalkStats.reset();
    structural(state, {
      removedIds: cardIds("a"),
      upserts: card("b", "Hand", "nc:strike#1"),
      orderedIds: ["Root", "Hand", "Deck", "DeckList", ...fillerIds(), ...cardIds("b")]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.adoptions).toBe(cardIds("a").length);
    expect(cardIds("b").map((id) => el(stage, id))).toEqual(before); // element identity survived
  });
});

describe("tween hints against a dormant target", () => {
  it("drops a transform/opacity hint on a dormant node without building or throwing", () => {
    const { stage, renderer, state } = mount(screenScene(false));

    hintsOnly(state, [
      { targetId: "Map", property: "position", durationMs: 300, endTransform: [1, 0, 0, 1, 40, 0] },
      { targetId: "Map", property: "modulate:a", durationMs: 300, endOpacity: 1, startOpacity: 0 }
    ]);
    expect(() => renderer.reconcile(state)).not.toThrow();
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);
  });

  it("PIN: armTweenSelfOpacity has no `el` guard — a dormant record survives it because it can have no selfLayer", () => {
    // `armTweenSelfOpacity` (unlike armTween / armTweenOpacity / primeTween*) does NOT check `record.el`; it writes
    // the DURABLE `tweenSelfOpacity*` pin and only touches the DOM `if (record.selfLayer)`. A dormant record can
    // never own a selfLayer (the layer is created inside the paint block, which the dormancy return skips), so the
    // hint is inert here. This spec pins BOTH halves — no DOM now, and the durable pin applied on reveal.
    const { stage, renderer, state } = mount(screenScene(false));

    hintsOnly(state, [
      { targetId: "Map", property: "self_modulate:a", durationMs: 60_000, endOpacity: 0.25 }
    ]);
    expect(() => renderer.reconcile(state)).not.toThrow();
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);
    expect(stage.querySelectorAll(".mirror-clip-self").length).toBe(0);

    // Reveal: `Map` is an interior node, so its own paint (if any) lands on a lazily-created selfLayer that picks
    // the still-live pin up. Whether or not this particular node paints, the reveal must not throw and must build.
    update(state, [node("Map", "Game", { visible: true })]);
    expect(() => renderer.reconcile(state)).not.toThrow();
    expect(el(stage, "Map")).not.toBeNull();
  });

  it("applies the durable self_modulate pin to the selfLayer built on reveal", () => {
    // A PAINTED interior node (fill + children) does own a selfLayer, so the pin has somewhere to land.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [
      node("Root", null),
      boxed("Panel", "Root", 0, 0, { localRect: rect(0, 0, 400, 300), visible: false }),
      boxed("Kid", "Panel", 10, 10)
    ]);
    renderer.reconcile(state);
    expect(el(stage, "Panel")).toBeNull();

    hintsOnly(state, [{ targetId: "Panel", property: "self_modulate:a", durationMs: 60_000, endOpacity: 0.25 }]);
    renderer.reconcile(state);
    expect(stage.querySelectorAll(".mirror-clip-self").length).toBe(0); // no layer to write to → nothing written

    update(state, [boxed("Panel", "Root", 0, 0, { localRect: rect(0, 0, 400, 300), visible: true })]);
    renderer.reconcile(state);
    const self = el(stage, "Panel")!.querySelector<HTMLElement>(".mirror-clip-self");
    expect(self).not.toBeNull();
    expect(self!.style.opacity).toBe("0.25"); // the pin outlived the dormancy
  });
});

// --- 6. the input surface is untouched ------------------------------------------------------------------------

describe("input-side invariance", () => {
  it("keeps hidden dormant controls out of the current input registry", () => {
    // Interactive rects are derived from the `nodes` map (game truth) + each record's spreadDx, never from what is
    // painted — and a dormant record keeps its spreadDx current. A hidden subtree contributes nothing either way
    // (forEachInteractiveRect rejects an ancestor-hidden control), so the pointer map cannot notice dormancy.
    const nodes = screenScene(false);
    const current = mount(nodes);
    const rects = current.renderer.interactiveRects().map((r) => ({ ...r, transform: [...r.transform] }));
    expect(rects.map((r) => r.id)).toContain("CombatCard");
    expect(rects.map((r) => r.id)).not.toContain("Dot1");
  });

  it("adds the controls to the input registry on reveal", () => {
    const current = mount(screenScene(false));
    update(current.state, [node("Map", "Game", { visible: true, sceneFilePath: "res://scenes/map/MapScreen.tscn" })]);
    current.renderer.reconcile(current.state);
    expect(current.renderer.interactiveRects().map((r) => r.id)).toContain("Dot1");
  });
});
