import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,






  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// R10-PERF5 WS-3 — THE IDLE PRE-BUILD HATCHERY.
//
// WS-1 made a hidden subtree cost nothing to keep (no DOM at all under a `visible=false` root). That leaves ONE
// regression risk: the reveal. MapScreen opens after every combat, and before dormancy its ~1,900 elements already
// existed — so a reveal that has to build them synchronously would trade a background win for a foreground stall.
// The hatchery closes that: every dormant marker is queued, and once the reconciles stop a budget drain re-enters
// `visit` in HATCHING mode and pre-builds the subtrees a 3ms slice at a time, entirely under `display:none`.
//
// The properties these specs pin:
//   1. an idle hatch reproduces exactly what a reveal would have built — same elements, same child order, all
//      still hidden — and does it in paint order, one marker at a time;
//   2. the budget is real and RESUMABLE: a slice that runs out re-queues the child it stopped at and the next one
//      picks the DFS up there, so no subtree is ever half-forgotten;
//   3. a reveal that lands mid-hatch builds the remainder synchronously and correctly (the WS-1 cascade, untouched);
//   4. a hatch build is NOT a reveal — separate counters, no `revealBuilds`/`revealBuildMs` contamination, and no
//      pooled element spent on an invisible tree;
//   5. an element built in the DARK re-anchors its WAAPI phase when it is finally shown (CSS animations don't run
//      under `display:none`, so the anchor createEl queued was a no-op);
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

// The element children of `parent` labelled by what they are: a mirror node id, or the kind of sub-layer. This is
// the sequence `behindCount` places — the parent's own paint must sit AFTER its behind-parent children and BEFORE
// its normal ones, however the hatch happened to slice the subtree.
function childLayout(parent: HTMLElement): string[] {
  return [...parent.children].map((c) => {
    const id = c.getAttribute("data-node-id");
    if (id != null) return id;
    if (c.classList.contains("mirror-clip-self")) return "<self>";
    return `<${c.tagName.toLowerCase()}>`;
  });
}

// Does this element render inside a `display:none` subtree? The whole hatchery contract in one predicate: nothing
// it builds may be visible, whatever stage the pre-build is at.
function underDisplayNone(node: HTMLElement | null): boolean {
  for (let cur: HTMLElement | null = node; cur; cur = cur.parentElement) {
    if (cur.style.display === "none") {
      return true;
    }
  }
  return false;
}

// Run slices until the queue is empty; returns how many it took. Bounded so a stalled drain fails as a test rather
// than hanging the suite.
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
//  └─ Map           (the SCREEN whose `visible` flips — the dormancy root / hatch entry)
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
    r.dispose(); // also disarms the hatch timer — a live one would hatch into a LATER test's stage
  }
  created = [];
  document.body.innerHTML = "";
});

// --- 1. the idle pre-build ------------------------------------------------------------------------------------

describe("hatching a dormant subtree at idle", () => {
  it("builds the WHOLE hidden subtree, still display:none, with the reveal's child order", () => {
    const { stage, renderer } = mount(screenScene(false));
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length); // WS-1: nothing under the closed screen

    mirrorWalkStats.reset();
    hatchAll(renderer); // real 3ms slices — however many the host needs

    for (const id of MAP_IDS) {
      expect(el(stage, id), `hatched ${id}`).not.toBeNull();
    }
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
    // …and NONE of it can be seen: the screen root still carries its own display:none, so the whole pre-built
    // subtree is inert (no paint, no layout, no compositing, nothing hittable).
    expect(el(stage, "Map")!.style.display).toBe("none");
    for (const id of MAP_IDS) {
      expect(underDisplayNone(el(stage, id)), `hidden ${id}`).toBe(true);
    }
    // Identical structure to the reveal path (mirrorRendererDormant.spec.ts pins the same two sequences).
    expect(childIds(el(stage, "MapInner")!)).toEqual(["Dot1", "Dot2", "MapCard"]);
    expect(childIds(el(stage, "Map")!)).toEqual(["MapInner", "MapEdge"]);
  });

  it("counts hatch builds SEPARATELY from reveals (the whole point of the accounting split)", () => {
    const { renderer } = mount(screenScene(false));

    mirrorWalkStats.reset();
    const drains = hatchAll(renderer);

    // Every node is built EXACTLY once however the budget happened to slice the subtree (a deferred child is
    // re-queued, never re-built), and each marker the hatchery realises is counted once.
    expect(mirrorWalkStats.createEl).toBe(MAP_IDS.length);
    expect(mirrorWalkStats.hatchedBuilds).toBeGreaterThanOrEqual(1); // `Map` at minimum — the walk's only marker
    expect(mirrorWalkStats.hatchedBuilds).toBeLessThanOrEqual(MAP_IDS.length);
    expect(mirrorWalkStats.hatchDrains).toBe(drains);
    expect(mirrorWalkStats.hatchMs).toBeGreaterThanOrEqual(0);
    // NOT a reveal: nobody asked for this, and no frame was blocked by it.
    expect(mirrorWalkStats.revealBuilds).toBe(0);
    expect(mirrorWalkStats.revealBuildMs).toBe(0);
    // The gauge is republished by the drain itself — no walk runs on a settled screen to do it.
    expect(mirrorWalkStats.dormantRoots).toBe(0);
  });

  it("STYLES what it builds, so the texture/atlas warm-up happens at idle too", () => {
    // The paint block runs for every hatched node whose OWN `visible` is true (only the screen root's flag is
    // false), which is what pulls `warmImage` / the atlas region bakes onto the idle path instead of the reveal.
    const { stage, renderer } = mount(screenScene(false));
    hatchAll(renderer);

    expect(el(stage, "Dot1")!.style.backgroundColor).not.toBe("");
    expect(el(stage, "MapCard")!.classList.contains("mirror-card-liftable")).toBe(true);
    expect(el(stage, "MapCard")!.getAttribute("data-node-path")).toBe("Game/Map/MapInner/MapCard");
  });

  it("pops markers in PAINT order, not in the order they became dormant", () => {
    // `Beta` goes dormant first (it exists at the keyframe); `Alpha` is added later but sorts EARLIER in
    // orderedIds. A queue that drained in insertion order would hatch Beta first.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("Game", null), node("Beta", "Game", { visible: false }), boxed("BetaKid", "Beta", 10, 10)]);
    renderer.reconcile(state);

    structural(state, {
      upserts: [node("Alpha", "Game", { visible: false }), boxed("AlphaKid", "Alpha", 20, 20)],
      orderedIds: ["Game", "Alpha", "AlphaKid", "Beta", "BetaKid"]
    });
    renderer.reconcile(state);
    expect(mirrorWalkStats.dormantRoots).toBe(2);

    // Budget 0 ⇒ exactly one marker per slice (the popped entry always builds; everything deeper is deferred).
    expect(renderer.__drainDormantHatchForTest(0)).toBe(true);
    expect(el(stage, "Alpha")).not.toBeNull();
    expect(el(stage, "Beta")).toBeNull();
  });
});

// --- 2. the budget --------------------------------------------------------------------------------------------

describe("the drain budget", () => {
  it("re-queues the child it ran out on and RESUMES the DFS from there", () => {
    const { stage, renderer } = mount(screenScene(false));
    mirrorWalkStats.reset();

    // Slice 1: the entry (`Map`) builds unconditionally; both its children are past the (zero) deadline, so they
    // become markers again and go back on the queue.
    expect(renderer.__drainDormantHatchForTest(0)).toBe(true);
    expect(el(stage, "Map")).not.toBeNull();
    expect(childIds(el(stage, "Map")!)).toEqual([]);
    expect(mirrorWalkStats.dormantRoots).toBe(2); // MapInner + MapEdge

    // Slice 2 resumes at `MapInner` (the earlier of the two in paint order) — not at `Map`, which is done.
    expect(renderer.__drainDormantHatchForTest(0)).toBe(true);
    expect(childIds(el(stage, "Map")!)).toEqual(["MapInner"]);
    expect(childIds(el(stage, "MapInner")!)).toEqual([]);

    // …and the rest of the subtree arrives one node per slice until the queue empties.
    const remaining = hatchAll(renderer, 0);
    expect(remaining).toBe(4); // Dot1, Dot2, MapCard, MapEdge
    expect(mirrorWalkStats.hatchDrains).toBe(6);
    expect(mirrorWalkStats.hatchedBuilds).toBe(MAP_IDS.length); // every node was a marker before it was built
    expect(mirrorWalkStats.createEl).toBe(MAP_IDS.length); // …and each was built exactly ONCE
    expect(mirrorWalkStats.dormantRoots).toBe(0);

    // The partially-hatched intermediate states were all prefixes of the real thing: the finished DOM is the same
    // one a single unbudgeted slice produces.
    expect(childIds(el(stage, "MapInner")!)).toEqual(["Dot1", "Dot2", "MapCard"]);
    expect(childIds(el(stage, "Map")!)).toEqual(["MapInner", "MapEdge"]);
    for (const id of MAP_IDS) {
      expect(underDisplayNone(el(stage, id)), `hidden ${id}`).toBe(true);
    }
  });

  it("is armed by the real timer once the reconciles stop, and re-armed until the queue drains", () => {
    vi.useFakeTimers();
    try {
      const { stage, renderer } = mount(screenScene(false));
      expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);

      // Not immediately: the drain is debounced behind an idle window, so a streaming scene never hatches.
      vi.advanceTimersByTime(100);
      expect(nodeCount(stage)).toBe(VISIBLE_IDS.length);

      vi.advanceTimersByTime(150);
      expect(nodeCount(stage)).toBeGreaterThan(VISIBLE_IDS.length);
      vi.runAllTimers(); // the re-arm chain terminates when nothing is left pending
      expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
      expect(mirrorWalkStats.dormantRoots).toBe(0);

      renderer.dispose(); // disarm before handing the timers back
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- 2b. behindCount, the one number a slice-by-slice build can corrupt ---------------------------------------

describe("behindCount inside a hatch", () => {
  // A closed screen holding a painted panel WITH children (its own paint lives on a `.mirror-clip-self` wrapper
  // that slots BETWEEN its behind-parent children and its normal ones — the `behindCount` index):
  //   Screen (hidden)
  //     └─ Panel
  //         ├─ Behind1  showBehindParent
  //         ├─ Behind2  showBehindParent
  //         └─ Normal1
  function panelScene(): Raw[] {
    return [
      node("Root", null),
      node("Screen", "Root", { visible: false }),
      boxed("Panel", "Screen", 0, 0, { localRect: rect(0, 0, 400, 300) }),
      boxed("Behind1", "Panel", 10, 10, { showBehindParent: true }),
      boxed("Behind2", "Panel", 20, 20, { showBehindParent: true }),
      boxed("Normal1", "Panel", 30, 30)
    ];
  }
  const LAYOUT = ["Behind1", "Behind2", "<self>", "Normal1"];

  it("counts the behind-children the hatch is ABOUT to build (a parent is built before them)", () => {
    // The WS-1 rule — "count a hidden child only if it has an element TODAY" — is exactly wrong here: the hatch
    // builds `Panel` first, so at that moment neither behind-child has an element and the panel's own paint would
    // slot at index 0, rendering BEHIND children that are one instruction away from existing.
    const { stage, renderer } = mount(panelScene());
    hatchAll(renderer);
    expect(childLayout(el(stage, "Panel")!)).toEqual(LAYOUT);
  });

  it("lands the same layout however the budget slices the subtree", () => {
    const { stage, renderer } = mount(panelScene());
    hatchAll(renderer, 0); // one node per slice: Panel exists for three slices with its children outstanding
    expect(childLayout(el(stage, "Panel")!)).toEqual(LAYOUT);
  });

  it("matches what a plain reveal builds", () => {
    const revealed = mount(panelScene());
    update(revealed.state, [node("Screen", "Root", { visible: true })]);
    revealed.renderer.reconcile(revealed.state);
    expect(childLayout(el(revealed.stage, "Panel")!)).toEqual(LAYOUT);

    // …and a hatch followed by the reveal is the same again — the reveal re-visit must not disturb the slot.
    const hatched = mount(panelScene());
    hatchAll(hatched.renderer, 0);
    update(hatched.state, [node("Screen", "Root", { visible: true })]);
    hatched.renderer.reconcile(hatched.state);
    expect(childLayout(el(hatched.stage, "Panel")!)).toEqual(LAYOUT);
  });
});

// --- 3. a reveal that beats the hatchery ----------------------------------------------------------------------

describe("reveal mid-hatch", () => {
  it("builds the remainder SYNCHRONOUSLY in the reveal walk, and charges it to the reveal series", () => {
    const { stage, renderer, state } = mount(screenScene(false));
    renderer.__drainDormantHatchForTest(0);
    renderer.__drainDormantHatchForTest(0); // Map + MapInner pre-built; four markers still queued

    mirrorWalkStats.reset();
    update(state, [node("Map", "Game", { visible: true, sceneFilePath: "res://scenes/map/MapScreen.tscn" })]);
    renderer.reconcile(state);

    for (const id of MAP_IDS) {
      expect(el(stage, id), `revealed ${id}`).not.toBeNull();
    }
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
    expect(el(stage, "Map")!.style.display).toBe("");
    expect(childIds(el(stage, "MapInner")!)).toEqual(["Dot1", "Dot2", "MapCard"]);
    expect(childIds(el(stage, "Map")!)).toEqual(["MapInner", "MapEdge"]);

    // The four still-dormant markers were built by the WALK — so they ARE reveals, and the frame is charged.
    expect(mirrorWalkStats.revealBuilds).toBe(4);
    expect(mirrorWalkStats.createEl).toBe(4); // the two hatched ones were NOT rebuilt
    expect(mirrorWalkStats.revealBuildMs).toBeGreaterThan(0);
    expect(mirrorWalkStats.hatchedBuilds).toBe(0);
    // Nothing is left queued: the reveal dequeued every marker it built (setDormant owns both memberships).
    expect(mirrorWalkStats.dormantRoots).toBe(0);
    expect(renderer.__drainDormantHatchForTest(0)).toBe(false);
    expect(mirrorWalkStats.hatchDrains).toBe(0); // an empty queue is not even a drain
  });

  it("re-hides without tearing down, and hatches nothing further", () => {
    const { stage, renderer, state } = mount(screenScene(false));
    hatchAll(renderer);
    update(state, [node("Map", "Game", { visible: true })]);
    renderer.reconcile(state);
    update(state, [node("Map", "Game", { visible: false })]);
    renderer.reconcile(state);

    // Dormancy is never-build, not tear-down: the DOM stays, hidden.
    expect(nodeCount(stage)).toBe(VISIBLE_IDS.length + MAP_IDS.length);
    expect(el(stage, "Map")!.style.display).toBe("none");
    expect(mirrorWalkStats.dormantRoots).toBe(0); // nothing is a MARKER — every node has its element
    expect(renderer.__drainDormantHatchForTest()).toBe(false);
  });
});

// --- 4. the WAAPI phase anchor --------------------------------------------------------------------------------

// jsdom has no Web Animations API, so model the ONE browser rule this branch exists for: an element only has
// animations when it declares one AND is not inside a `display:none` subtree. `applyAnchor` writes `startTime`
// onto whatever this returns, so a lost anchor is directly observable.
type FakeAnim = { startTime: number | null };
const fakeAnims = new WeakMap<HTMLElement, FakeAnim>();

function installFakeWaapi(): void {
  (HTMLElement.prototype as unknown as { getAnimations?: () => FakeAnim[] }).getAnimations = function (
    this: HTMLElement
  ): FakeAnim[] {
    if (!this.style.animation) {
      return [];
    }
    if (underDisplayNone(this)) {
      return []; // CSS animations do not run under display:none — the reason the hatchery has to re-anchor
    }
    let anim = fakeAnims.get(this);
    if (!anim) {
      anim = { startTime: null };
      fakeAnims.set(this, anim);
    }
    return [anim];
  };
}

function uninstallFakeWaapi(): void {
  delete (HTMLElement.prototype as unknown as { getAnimations?: () => FakeAnim[] }).getAnimations;
}

// A closed screen holding one enemy intent HOLDER — the path-keyed `bob` binding (see animAttributes), whose phase
// is seeded from the leaf's baked global x so a row of intents bobs as a wave instead of in lockstep.
const BOB_X = 400;
const BOB_PERIOD_MS = 2000;
const EXPECTED_PHASE_MS = ((BOB_X / 1920) * BOB_PERIOD_MS) % BOB_PERIOD_MS;

function bobScene(): Raw[] {
  return [
    node("Game", null),
    node("Screen", "Game", { visible: false, sceneFilePath: "res://scenes/combat/combat.tscn" }),
    node("Enemies", "Screen", { name: "EnemyContainer" }),
    node("Enemy1", "Enemies", { name: "Enemy" }),
    boxed("Holder", "Enemy1", BOB_X, 300, { name: "IntentHolder" })
  ];
}

describe("the WAAPI phase anchor of an element built in the dark", () => {
  beforeEach(() => installFakeWaapi());
  afterEach(() => uninstallFakeWaapi());

  it("is re-queued on the hidden→visible flip — matching a subtree that was never hatched", () => {
    // (a) HATCHED: the element is built while the screen is closed, so its bob has nothing to anchor…
    const { stage, renderer, state } = mount(bobScene());
    hatchAll(renderer);
    const holder = el(stage, "Holder")!;
    expect(holder.style.animation).not.toBe(""); // the binding IS declared
    expect(fakeAnims.get(holder)).toBeUndefined(); // …but no animation existed to anchor
    expect(underDisplayNone(holder)).toBe(true);

    // …until the screen opens, where the flip re-queues it through the same end-of-walk flush.
    update(state, [node("Screen", "Game", { visible: true, sceneFilePath: "res://scenes/combat/combat.tscn" })]);
    renderer.reconcile(state);
    const hatchedAnim = fakeAnims.get(holder);
    expect(hatchedAnim).toBeDefined();
    expect(hatchedAnim!.startTime).toBeCloseTo(-EXPECTED_PHASE_MS, 6);

    // (b) CONTROL: the same scene revealed WITHOUT a hatch (the element is created by the reveal walk itself, when
    // it is already visible) must land on the same phase — that parity is what the re-anchor buys.
    const control = mount(bobScene());
    expect(el(control.stage, "Holder")).toBeNull();
    update(control.state, [
      node("Screen", "Game", { visible: true, sceneFilePath: "res://scenes/combat/combat.tscn" })
    ]);
    control.renderer.reconcile(control.state);
    const controlAnim = fakeAnims.get(el(control.stage, "Holder")!);
    expect(controlAnim).toBeDefined();
    expect(controlAnim!.startTime).toBe(hatchedAnim!.startTime);
  });

  it("re-anchors only ONCE — a re-hide/re-show does not re-queue a stale phase", () => {
    const { stage, renderer, state } = mount(bobScene());
    hatchAll(renderer);
    const holder = el(stage, "Holder")!;

    update(state, [node("Screen", "Game", { visible: true, sceneFilePath: "res://scenes/combat/combat.tscn" })]);
    renderer.reconcile(state);
    const anim = fakeAnims.get(holder)!;
    anim.startTime = 12345; // whatever the page did with it afterwards

    update(state, [node("Screen", "Game", { visible: false, sceneFilePath: "res://scenes/combat/combat.tscn" })]);
    renderer.reconcile(state);
    update(state, [node("Screen", "Game", { visible: true, sceneFilePath: "res://scenes/combat/combat.tscn" })]);
    renderer.reconcile(state);
    // The flag is consumed by the first flip: this element is a normal live element now, and re-showing it is not
    // the hatchery's business.
    expect(anim.startTime).toBe(12345);
  });
});

// --- 5. neighbours: the adopt pool and the strand guard -------------------------------------------------------

describe("the element-adoption pool", () => {
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

  it("is not consumed by a hatch — and the hatched card is a fresh build, not a reveal", () => {
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

    mirrorWalkStats.reset();
    // The pooled-shell recycle, aimed INTO the closed dialog: WS-1 declines the adoption (never spend a real,
    // styled element on an invisible tree), so `b` is a dormant add…
    structural(state, {
      removedIds: cardIds("a"),
      upserts: card("b", "DeckList", "nc:strike#1"),
      orderedIds: ["Root", "Hand", "Deck", "DeckList", ...fillerIds(), ...cardIds("b")]
    });
    renderer.reconcile(state);
    expect(mirrorWalkStats.adoptions).toBe(0);
    expect(el(stage, "b")).toBeNull();

    // …and the hatchery builds it FRESH later, still without touching the pool (which no longer holds anything —
    // the condemned record was swept at the end of that walk).
    mirrorWalkStats.reset();
    hatchAll(renderer);
    expect(mirrorWalkStats.adoptions).toBe(0);
    expect(mirrorWalkStats.revealBuilds).toBe(0);
    expect(mirrorWalkStats.hatchedBuilds).toBeGreaterThan(0);
    expect(el(stage, "b")).not.toBeNull();
    expect(underDisplayNone(el(stage, "b"))).toBe(true);
    expect(childIds(el(stage, "DeckList")!)).toEqual(["b"]);
  });
});

describe("the strand guard against a PARTIALLY hatched subtree", () => {
  it("tears down an element reparented under a marker that is still queued, and re-builds it in place", () => {
    const { stage, renderer, state } = mount(screenScene(false));
    // Hatch exactly the screen root: `MapInner` is now a marker INSIDE a built (but hidden) parent — the state
    // that only exists because of the hatchery, and the one the guard has to keep handling.
    renderer.__drainDormantHatchForTest(0);
    expect(el(stage, "Map")).not.toBeNull();
    expect(el(stage, "MapInner")).toBeNull();

    structural(state, {
      upserts: [boxed("CombatCard", "MapInner", 100, 100)],
      orderedIds: ["Game", "Combat", "Map", "MapInner", "Dot1", "Dot2", "MapCard", "CombatCard", "MapEdge"]
    });
    renderer.reconcile(state);
    // The walk reaches `Map` (it has an element) but stops at the `MapInner` marker, so the moved node is never
    // visited: the guard tears its element down rather than leaving it stranded under `Combat`.
    expect(el(stage, "CombatCard")).toBeNull();

    // Finishing the hatch rebuilds it in its NEW place — the guard's demoted record carries no usable ctx, so it is
    // the ancestor's DFS that reaches it, with a freshly derived one.
    hatchAll(renderer, 0);
    expect(childIds(el(stage, "MapInner")!)).toEqual(["Dot1", "Dot2", "MapCard", "CombatCard"]);
    expect(underDisplayNone(el(stage, "CombatCard"))).toBe(true);
    expect(mirrorWalkStats.dormantRoots).toBe(0);

    update(state, [node("Map", "Game", { visible: true })]);
    renderer.reconcile(state);
    expect(el(stage, "Map")!.style.display).toBe("");
    expect(childIds(el(stage, "MapInner")!)).toEqual(["Dot1", "Dot2", "MapCard", "CombatCard"]);
    expect(el(stage, "CombatCard")!.parentElement).toBe(el(stage, "MapInner"));
  });
});

// --- 6. the re-arm coalesce (WS-6) -----------------------------------------------------------------------------
//
// `scheduleHatchDrain` is called from the END OF EVERY RECONCILE (a pure debounce push-back), so a streaming scene
// calls it dozens of times a second even though only the LAST one before quiet ever matters. These specs pin the
// two things that change:
//   1. a burst of reconciles that land while a hatch timer is already pending must not tear it down and rebuild
//      it every time;
//   2. the drain loop's OWN re-arm (`scheduleHatchDrain(HATCH_STEP_MS)`, a 0ms continuation fired from inside the
//      timer callback) must never be swallowed by that same coalescing — a hatch big enough to need many slices
//      still has to drain to completion via the REAL timer chain, not stall after one.
describe("the re-arm coalesce (WS-6)", () => {
  it("leaves the hatch timer alone across N successive reconciles while one is already pending", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const { renderer, state } = mount(screenScene(false));
      // The mount's own reconcile already armed the debounce — that ONE install is not what this test is about.
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      setTimeoutSpy.mockClear();
      clearTimeoutSpy.mockClear();

      // A burst of reconciles land back-to-back with NO clock advance — tighter than the measured ~19ms streaming
      // cadence (53 reconciles/s), so the freshly requested deadline (now + HATCH_IDLE_MS) is IDENTICAL every time.
      // None of them should tear down and rebuild the timer.
      for (let i = 0; i < 20; i++) {
        renderer.reconcile(state);
      }

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(clearTimeoutSpy).not.toHaveBeenCalled();
      expect(mirrorWalkStats.dormantRoots).toBeGreaterThan(0); // still pending — nothing hatched out from under us
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });


  it("never swallows its own 0ms continuation — a hatch too big for one slice still drains via the REAL timer chain", async () => {
    // HATCH_BUDGET_MS is time-boxed against a REAL clock (a fake one never advances mid-call, so every slice would
    // finish the whole queue in one shot — see the file header). Real `setTimeout`s and enough leaves that jsdom
    // cannot build them all inside one 3ms slice is what actually exercises the chain: `scheduleHatchDrain`'s own
    // `HATCH_STEP_MS = 0` re-arm has to keep installing fresh timers, slice after slice, without the coalescing
    // added in this workstream ever mistaking one of THOSE for "close enough" to skip.
    const LEAVES = 200;
    const nodes: Raw[] = [node("Game", null), node("Screen", "Game", { visible: false })];
    for (let i = 0; i < LEAVES; i++) {
      nodes.push(boxed(`leaf${i}`, "Screen", i % 100, Math.floor(i / 100)));
    }
    const { stage } = mount(nodes);
    expect(nodeCount(stage)).toBe(1); // "Game" only — "Screen" is the dormant root and isn't built until hatched

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const poll = (): void => {
        if (mirrorWalkStats.dormantRoots === 0) {
          resolve();
        } else if (Date.now() - start > 5000) {
          reject(new Error(`hatchery stalled: dormantRoots=${mirrorWalkStats.dormantRoots}, hatchDrains=${mirrorWalkStats.hatchDrains}`));
        } else {
          setTimeout(poll, 10);
        }
      };
      poll();
    });

    // If the coalescing had swallowed the drain loop's own 0ms re-arm, this would have stalled after the FIRST
    // slice and the promise above would have timed out instead of resolving.
    expect(mirrorWalkStats.hatchDrains).toBeGreaterThan(3);
    expect(nodeCount(stage)).toBe(LEAVES + 2); // Game + Screen + every leaf
  }, 8000);
});
