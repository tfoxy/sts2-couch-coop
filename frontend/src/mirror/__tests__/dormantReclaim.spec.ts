import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,






  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// R10-PERF5 WS-4 — RECLAIM HIDDEN DOM ON FULL WALKS.
//
// WS-1 never BUILDS a hidden subtree and WS-3 pre-builds it at idle, but neither ever gives DOM back: a screen the
// player opened once keeps its ~1,900 elements for the session, and a keyframe/reconnect re-establishes every one
// of them inline. WS-4 closes that loop. On a FULL walk — the only walk that owns the `visited` set and the
// post-walk prune — an effectively-hidden node that HAS an element is dormant too: its element is torn down at the
// boundary and its record demotes to an ordinary marker, so the keyframe rebuilds only what is visible and the
// hatchery re-grows the rest at idle.
//
// The properties these specs pin, in order:
//   1. a full walk reclaims a hidden BUILT subtree — root element detached, descendant RECORDS pruned (no record
//      is left holding a reference into the detached tree), the root left as a marker;
//   2. what it reclaimed comes back identically — by hatch (still `display:none`, incl. the WAAPI re-anchor) or by
//      a reveal that beats the hatchery (charged to `revealBuilds`, never `hatchedBuilds`);
//   3. it is FULL-walk-only: an incremental structural walk and a volatile update both keep the DOM (there is no
//      whole-scene sweep on those paths to clean up after them);
//   4. the neighbouring mechanisms survive it — behindCount, the occlusion gate (which must NEVER be mistaken for
//      wire invisibility), and the adoption pool;
//
// Every case drives REAL wire JSON through parseSceneDelta/applySceneDelta — never a hand-built MirrorState.

type Raw = Record<string, unknown>;

const NCARD = "MegaCrit.Sts2.Core.Nodes.Cards.NCard";

const xf = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });
const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const rgba = (r: number, g: number, b: number, a: number) => ({ r, g, b, a, html: "#ff0000" });

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

// A wire KEYFRAME (`full: true`) — the delta that sends the reconcile down the full path.
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

function el(stage: HTMLElement, id: string): HTMLElement | null {
  return stage.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
}

function nodeCount(stage: HTMLElement): number {
  return stage.querySelectorAll(".mirror-node").length;
}

function childIds(parent: HTMLElement): (string | null)[] {
  return [...parent.children].filter((c) => c.hasAttribute("data-node-id")).map((c) => c.getAttribute("data-node-id"));
}

function childLayout(parent: HTMLElement): string[] {
  return [...parent.children].map((c) => {
    const id = c.getAttribute("data-node-id");
    if (id != null) return id;
    if (c.classList.contains("mirror-clip-self")) return "<self>";
    return `<${c.tagName.toLowerCase()}>`;
  });
}

function underDisplayNone(node: HTMLElement | null): boolean {
  for (let cur: HTMLElement | null = node; cur; cur = cur.parentElement) {
    if (cur.style.display === "none") {
      return true;
    }
  }
  return false;
}

// Run hatch slices until the queue is empty (bounded so a stalled drain fails rather than hangs).
function hatchAll(renderer: MirrorRenderer, budgetMs = 0): number {
  let drains = 0;
  while (renderer.__drainDormantHatchForTest(budgetMs)) {
    drains++;
    expect(drains).toBeLessThan(200);
  }
  return drains + 1;
}

// --- the screen scene ------------------------------------------------------------------------------------------
//
// Game
//  ├─ Combat        (always visible — the control group)
//  │   └─ CombatCard
//  └─ Map           (the SCREEN whose `visible` flips — the reclaim root)
//      ├─ MapInner
//      │   ├─ Dot1
//      │   ├─ Dot2
//      │   └─ MapCard   (an NCard — carries the touch-scan class stamped by createEl)
//      └─ MapEdge
const MAP_IDS = ["Map", "MapInner", "Dot1", "Dot2", "MapCard", "MapEdge"];
const VISIBLE_IDS = ["Game", "Combat", "CombatCard"];
const MAP_SCENE = "res://scenes/map/MapScreen.tscn";

function screenScene(mapVisible: boolean): Raw[] {
  return [
    node("Game", null),
    node("Combat", "Game"),
    boxed("CombatCard", "Combat", 100, 100),
    node("Map", "Game", { visible: mapVisible, sceneFilePath: MAP_SCENE }),
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

// The state every reclaim case starts from: the whole map was BUILT (it was open), then the screen closed. Per
// Phase 1 the DOM survives that hide — it is the following full walk that hands it back.
function builtThenHidden(): {
  stage: HTMLElement;
  renderer: MirrorRenderer;
  state: MirrorState;
  mapEl: HTMLElement;
  dotEl: HTMLElement;
} {
  const { stage, renderer, state } = mount(screenScene(true));
  expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
  const mapEl = el(stage, "Map")!;
  const dotEl = el(stage, "Dot1")!;

  update(state, [node("Map", "Game", { visible: false, sceneFilePath: MAP_SCENE })]);
  renderer.reconcile(state);
  expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length); // WS-1: a hide is not a teardown
  expect(mapEl.style.display).toBe("none");
  return { stage, renderer, state, mapEl, dotEl };
}

beforeEach(() => {
  document.body.innerHTML = "";
  mirrorWalkStats.reset();
});

afterEach(() => {
  for (const r of created) {
    r.dispose(); // also disarms the hatch timer — a live one would hatch into a LATER test's stage
  }
  created = [];
  document.body.innerHTML = "";
});

// --- 1. the reclaim -------------------------------------------------------------------------------------------

describe("reclaim on a full walk", () => {
  it("hands back the DOM of a hidden subtree that was built while visible", () => {
    const { stage, renderer, state, mapEl, dotEl } = builtThenHidden();

    mirrorWalkStats.reset();
    full(state, screenScene(false)); // the keyframe (reconnect / scene rewrite)
    renderer.reconcile(state);

    expect(mirrorWalkStats.fullWalks).toBe(1);
    for (const id of MAP_IDS) {
      expect(el(stage, id), `reclaimed ${id}`).toBeNull();
    }
    for (const id of VISIBLE_IDS) {
      expect(el(stage, id), `kept ${id}`).not.toBeNull();
    }
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);
    // The DOM left in ONE detach: removing the root's element took its whole subtree with it.
    expect(mapEl.isConnected).toBe(false);
    expect(dotEl.isConnected).toBe(false);

    // ONE reclaim — the boundary is the outermost effectively-hidden node, never a node per descendant.
    expect(mirrorWalkStats.reclaimedRoots).toBe(1);
    // …and it leaves exactly one marker behind: the root. Its five descendants' records were destroyed by the
    // post-walk prune (they were never visited), which is what stops any of them holding a detached element.
    expect(mirrorWalkStats.dormantRoots).toBe(1);
    expect(mirrorWalkStats.removedRecords).toBe(MAP_IDS.length - 1);
  });

  it("reclaims on ANY full walk, not just a wire keyframe (forceTextures)", () => {
    const { stage, renderer, state } = builtThenHidden();

    mirrorWalkStats.reset();
    renderer.reconcile(state, { forceTextures: true });

    expect(mirrorWalkStats.fullWalks).toBe(1);
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);
    expect(mirrorWalkStats.reclaimedRoots).toBe(1);
    expect(mirrorWalkStats.dormantRoots).toBe(1);
  });

  it("is idempotent: a second full walk finds a marker and reclaims nothing (the reconnect-storm case)", () => {
    const { stage, renderer, state } = builtThenHidden();
    full(state, screenScene(false));
    renderer.reconcile(state);

    mirrorWalkStats.reset();
    full(state, screenScene(false));
    renderer.reconcile(state);

    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);
    expect(mirrorWalkStats.reclaimedRoots).toBe(0); // nothing left to take
    expect(mirrorWalkStats.dormantRoots).toBe(1); // …and the marker is re-derived, not lost
    expect(mirrorWalkStats.dormantSkippedBuilds).toBe(1);
    expect(mirrorWalkStats.createEl).toBe(0); // the visible tree is re-styled, never rebuilt
  });

  it("never touches a subtree that is merely OCCLUSION-gated (display, not wire visibility)", () => {
    // Game
    //  ├─ World   ← covered by the dialog: the occlusion pass parks it at display:none
    //  └─ Dialog / Scrim  (the opaque full-stage cover)
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [
      node("Game", null, { localRect: rect(0, 0, 1920, 1080) }),
      node("World", "Game"),
      boxed("Enemy", "World", 300, 300),
      node("Dialog", "Game"),
      node("Scrim", "Dialog", {
        nodeType: "Godot.ColorRect",
        transform: xf(0, 0),
        localRect: rect(0, 0, 1920, 1080),
        fillColor: rgba(0, 0, 0, 1),
        mouseFilter: 0
      })
    ]);
    for (let i = 0; i < 3; i++) {
      renderer.reconcile(state); // satisfy the gate's engage hysteresis
    }
    expect(el(stage, "World")!.style.display).toBe("none");
    const worldEl = el(stage, "World")!;

    mirrorWalkStats.reset();
    renderer.reconcile(state, { forceTextures: true });

    // The gate is a RENDER decision about a node the wire still calls visible. Reclaiming it would tear down the
    // whole covered world on every keyframe — and re-grow it while the cover is still up.
    expect(el(stage, "World")).toBe(worldEl);
    expect(el(stage, "Enemy")).not.toBeNull();
    expect(mirrorWalkStats.reclaimedRoots).toBe(0);
    expect(mirrorWalkStats.dormantRoots).toBe(0);
  });

  it("leaves no occlusion gate state behind when a GATED root is later hidden and reclaimed", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const scene = (worldVisible: boolean, dialogVisible: boolean): Raw[] => [
      node("Game", null, { localRect: rect(0, 0, 1920, 1080) }),
      node("World", "Game", { visible: worldVisible }),
      boxed("Enemy", "World", 300, 300),
      node("Dialog", "Game", { visible: dialogVisible }),
      node("Scrim", "Dialog", {
        nodeType: "Godot.ColorRect",
        transform: xf(0, 0),
        localRect: rect(0, 0, 1920, 1080),
        fillColor: rgba(0, 0, 0, 1),
        mouseFilter: 0
      })
    ];
    full(state, scene(true, true));
    for (let i = 0; i < 3; i++) {
      renderer.reconcile(state);
    }
    expect(el(stage, "World")!.style.display).toBe("none"); // gated by the cover

    // The wire now hides the covered world for real, and a keyframe lands.
    update(state, [node("World", "Game", { visible: false })]);
    renderer.reconcile(state);
    mirrorWalkStats.reset();
    full(state, scene(false, true));
    renderer.reconcile(state);
    expect(el(stage, "World")).toBeNull();
    expect(mirrorWalkStats.reclaimedRoots).toBe(1);

    // Re-show it with the cover gone: the freshly built element must not inherit the old gate's `display:none`
    // (removeEl drops `occluded` / `occludedRootTiers` / `occlusionPending` with the element).
    update(state, [node("World", "Game", { visible: true }), node("Dialog", "Game", { visible: false })]);
    for (let i = 0; i < 3; i++) {
      renderer.reconcile(state);
    }
    expect(el(stage, "World")!.style.display).toBe("");
    expect(el(stage, "Enemy")).not.toBeNull();
  });

  it("re-counts behindCount for a hidden behind-child it is about to reclaim", () => {
    // Panel (painted box WITH children → its own paint lives on a `.mirror-clip-self` wrapper)
    //   ├─ Behind1  showBehindParent, visible
    //   ├─ Behind2  showBehindParent, built-then-hidden → RECLAIMED by the full walk
    //   └─ Normal1
    const panelScene = (behind2Visible: boolean): Raw[] => [
      node("Root", null),
      boxed("Panel", "Root", 0, 0, { localRect: rect(0, 0, 400, 300) }),
      boxed("Behind1", "Panel", 10, 10, { showBehindParent: true }),
      boxed("Behind2", "Panel", 20, 20, { showBehindParent: true, visible: behind2Visible }),
      boxed("Normal1", "Panel", 30, 30)
    ];
    const { stage, renderer, state } = mount(panelScene(true));
    expect(childLayout(el(stage, "Panel")!)).toEqual(["Behind1", "Behind2", "<self>", "Normal1"]);

    update(state, [boxed("Behind2", "Panel", 20, 20, { showBehindParent: true, visible: false })]);
    renderer.reconcile(state);
    expect(childLayout(el(stage, "Panel")!)).toEqual(["Behind1", "Behind2", "<self>", "Normal1"]); // still built

    full(state, panelScene(false));
    renderer.reconcile(state);
    // The parent's behindCount is computed BEFORE its children are visited, so it has to predict the reclaim:
    // counting the doomed behind-child would leave `<self>` one slot too late for the whole walk.
    expect(el(stage, "Behind2")).toBeNull();
    expect(childLayout(el(stage, "Panel")!)).toEqual(["Behind1", "<self>", "Normal1"]);
  });
});

// --- 2. what it reclaimed comes back --------------------------------------------------------------------------

describe("re-growing a reclaimed subtree", () => {
  it("re-queues the marker so the idle hatchery rebuilds it — still display:none, same shape", () => {
    const { stage, renderer, state } = builtThenHidden();
    full(state, screenScene(false));
    renderer.reconcile(state);
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);

    mirrorWalkStats.reset();
    hatchAll(renderer);

    for (const id of MAP_IDS) {
      expect(el(stage, id), `re-hatched ${id}`).not.toBeNull();
      expect(underDisplayNone(el(stage, id)), `hidden ${id}`).toBe(true);
    }
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
    expect(childIds(el(stage, "MapInner")!)).toEqual(["Dot1", "Dot2", "MapCard"]);
    expect(childIds(el(stage, "Map")!)).toEqual(["MapInner", "MapEdge"]);
    expect(mirrorWalkStats.createEl).toBe(MAP_IDS.length);
    expect(mirrorWalkStats.hatchedBuilds).toBeGreaterThanOrEqual(1);
    expect(mirrorWalkStats.revealBuilds).toBe(0); // an idle re-grow is not a reveal
    expect(mirrorWalkStats.dormantRoots).toBe(0);
  });

  it("reveals correctly after a reclaim + hatch (order, identity + touch attrs, display)", () => {
    const { stage, renderer, state } = builtThenHidden();
    full(state, screenScene(false));
    renderer.reconcile(state);
    hatchAll(renderer);

    update(state, [node("Map", "Game", { visible: true, sceneFilePath: MAP_SCENE })]);
    renderer.reconcile(state);

    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
    expect(el(stage, "Map")!.style.display).toBe("");
    expect(childIds(el(stage, "Map")!)).toEqual(["MapInner", "MapEdge"]);
    expect(childIds(el(stage, "MapInner")!)).toEqual(["Dot1", "Dot2", "MapCard"]);
    const map = el(stage, "Map")!;
    expect(map.getAttribute("data-node-path")).toBe("Game/Map");
    expect(map.getAttribute("data-scene-file")).toBe(MAP_SCENE);
    const card = el(stage, "MapCard")!;
    expect(card.classList.contains("mirror-card-liftable")).toBe(true);
    expect(card.getAttribute("data-node-path")).toBe("Game/Map/MapInner/MapCard");
  });

  it("builds SYNCHRONOUSLY when the reveal beats the hatchery — charged to revealBuilds, not hatchedBuilds", () => {
    const { stage, renderer, state } = builtThenHidden();
    full(state, screenScene(false));
    renderer.reconcile(state);

    mirrorWalkStats.reset();
    update(state, [node("Map", "Game", { visible: true, sceneFilePath: MAP_SCENE })]);
    renderer.reconcile(state);

    for (const id of MAP_IDS) {
      expect(el(stage, id), `revealed ${id}`).not.toBeNull();
    }
    expect(mirrorWalkStats.createEl).toBe(MAP_IDS.length);
    expect(mirrorWalkStats.revealBuilds).toBe(1); // the reclaimed ROOT was the only marker
    expect(mirrorWalkStats.revealBuildMs).toBeGreaterThan(0);
    expect(mirrorWalkStats.hatchedBuilds).toBe(0);
    expect(mirrorWalkStats.dormantRoots).toBe(0);
    expect(renderer.__drainDormantHatchForTest(0)).toBe(false); // the queue emptied with the marker
  });

});

// --- 3. full walks only ---------------------------------------------------------------------------------------

describe("reclaim is a FULL-walk act", () => {
  it("does not fire on an INCREMENTAL structural walk (no whole-scene sweep to clean up after it)", () => {
    const { stage, renderer, state, mapEl, dotEl } = builtThenHidden();

    mirrorWalkStats.reset();
    structural(state, {
      upserts: [boxed("CombatCard2", "Combat", 120, 100)],
      orderedIds: [
        "Game",
        "Combat",
        "CombatCard",
        "CombatCard2",
        "Map",
        "MapInner",
        "Dot1",
        "Dot2",
        "MapCard",
        "MapEdge"
      ]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1); // the pruned path, not a bail
    expect(mirrorWalkStats.fullWalks).toBe(0);
    expect(el(stage, "Map")).toBe(mapEl); // element IDENTITY survives
    expect(el(stage, "Dot1")).toBe(dotEl);
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length + 1);
    expect(mirrorWalkStats.reclaimedRoots).toBe(0);
    expect(mirrorWalkStats.dormantRoots).toBe(0);
  });

  it("does not fire on a volatile UPDATE walk", () => {
    const { stage, renderer, state, mapEl } = builtThenHidden();

    mirrorWalkStats.reset();
    update(state, [boxed("Dot1", "MapInner", 205, 200)]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.updateWalks).toBe(1);
    expect(el(stage, "Map")).toBe(mapEl);
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
    expect(mirrorWalkStats.reclaimedRoots).toBe(0);
  });
});

// --- 4. the adoption pool -------------------------------------------------------------------------------------

describe("the element-adoption pool across a reclaim", () => {
  // The pooled-shell recycle, but with the pool's donor sitting INSIDE the subtree the same walk reclaims: the
  // up-front condemn (which runs before the walk) captured elements that the reclaim then detaches. Whatever the
  // adopt decision is, no element may end up in the visible tree detached or half-placed.
  function card(prefix: string, parentId: string, contentKey: string): Raw[] {
    return [
      node(prefix, parentId, { name: "Card", nodeType: NCARD, contentKey, mouseFilter: 0 }),
      node(`${prefix}-cc`, prefix, { name: "CardContainer" }),
      node(`${prefix}-title`, `${prefix}-cc`, { name: "TitleLabel" })
    ];
  }
  const cardIds = (p: string) => [p, `${p}-cc`, `${p}-title`];

  const scene = (deckVisible: boolean, cardPrefix: string, cardParent: string): Raw[] => [
    node("Root", null),
    node("Hand", "Root"),
    node("Deck", "Root", { visible: deckVisible }),
    node("DeckList", "Deck"),
    ...card(cardPrefix, cardParent, "nc:strike#1")
  ];

  it("re-attaches (never strands) an element adopted out of the subtree being reclaimed", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, scene(true, "a", "DeckList")); // the deck dialog is OPEN: card `a` is built inside it
    renderer.reconcile(state);
    const cardEl = el(stage, "a")!;
    expect(cardEl.isConnected).toBe(true);

    // ONE keyframe closes the deck AND recycles the card's shell into the (visible) hand under fresh ids.
    mirrorWalkStats.reset();
    full(state, scene(false, "b", "Hand"));
    renderer.reconcile(state);

    expect(mirrorWalkStats.reclaimedRoots).toBe(1); // the closed deck went
    expect(el(stage, "Deck")).toBeNull();
    expect(el(stage, "DeckList")).toBeNull();
    for (const id of cardIds("b")) {
      const kid = el(stage, id);
      expect(kid, `placed ${id}`).not.toBeNull();
      expect(kid!.isConnected, `connected ${id}`).toBe(true);
    }
    expect(el(stage, "b")!.parentElement).toBe(el(stage, "Hand"));
    expect(childIds(el(stage, "Hand")!)).toEqual(["b"]);
    // Nothing from the old ids survives anywhere in the tree.
    for (const id of cardIds("a")) {
      expect(el(stage, id), `gone ${id}`).toBeNull();
    }
  });

  it("does not spend a pooled element on a card recycled INTO the reclaimed (closed) dialog", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, scene(true, "a", "Hand"));
    renderer.reconcile(state);

    mirrorWalkStats.reset();
    full(state, scene(false, "b", "DeckList"));
    renderer.reconcile(state);

    expect(mirrorWalkStats.adoptions).toBe(0); // the destination is dormant — never spend a real element there
    for (const id of cardIds("b")) {
      expect(el(stage, id), `dormant ${id}`).toBeNull();
    }
    expect(nodeCount(stage)).toBe(2); // Root + Hand

    // …and the whole thing builds on reveal, correctly parented.
    update(state, [node("Deck", "Root", { visible: true })]);
    renderer.reconcile(state);
    expect(childIds(el(stage, "DeckList")!)).toEqual(["b"]);
    expect(el(stage, "b")!.classList.contains("mirror-card-liftable")).toBe(true);
  });
});
