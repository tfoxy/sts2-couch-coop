import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMirrorRenderer, mirrorWalkStats, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { affineMul, nodeMatrix, IDENTITY_AFFINE, type Affine } from "@/mirror/affine";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// Stage 3 — INCREMENTAL structural walks: an orderedIds-changed delta (reorder / add / remove / reparent) keeps
// dirty pruning + the recurse-only fast path and reorders ONLY the parents whose child lists changed, instead of
// falling back to a full un-pruned restyle walk. These specs drive the renderer through the wire deltas the
// producer actually emits and assert DOM order, element identity, restyle counts, and the composed-matrix parity
// oracle after each shape of delta.

function xform(tx: number, ty: number, a = 1, b = 0, c = 0, d = 1): Record<string, unknown> {
  return { xAxis: { x: a, y: b }, yAxis: { x: c, y: d }, origin: { x: tx, y: ty } };
}

function box(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}

function parseMatrix(transform: string): Affine {
  const m = /matrix\(([^)]*)\)/.exec(transform);
  if (!m) return [...IDENTITY_AFFINE] as Affine;
  const n = m[1].split(",").map((v) => Number(v.trim()));
  return [n[0], n[1], n[2], n[3], n[4], n[5]];
}

function composedMatrix(el: HTMLElement, stage: HTMLElement): Affine {
  let acc: Affine = [...IDENTITY_AFFINE] as Affine;
  let cur: HTMLElement | null = el;
  while (cur && cur !== stage) {
    acc = affineMul(parseMatrix(cur.style.transform), acc);
    cur = cur.parentElement;
  }
  return acc;
}

function approx(a: Affine, b: Affine): void {
  for (let i = 0; i < 6; i++) {
    expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-6);
  }
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function rawNode(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: xform(0, 0),
    localRect: box(100, 16),
    visible: true,
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
}

function volatileDelta(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

// A NON-full structural delta: the wire shape of a reorder / add / remove / reparent (orderedIds always present).
function structuralDelta(
  state: MirrorState,
  parts: { upserts?: Record<string, unknown>[]; removedIds?: string[]; orderedIds: string[] }
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
  return stage.querySelector(`[data-node-id="${id}"]`);
}

function childIds(parent: HTMLElement): (string | null)[] {
  return [...parent.children].filter((c) => c.hasAttribute("data-node-id")).map((c) => c.getAttribute("data-node-id"));
}

beforeEach(() => {
  document.body.innerHTML = "";
  mirrorWalkStats.reset();
});

describe("incremental structural walks", () => {
  it("REORDER-ONLY: applies sibling DOM order with zero restyles, identical transforms, kept element identity", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("r", null, { transform: xform(10, 10) }),
        rawNode("a", "r", { transform: xform(20, 20) }),
        rawNode("b", "r", { transform: xform(30, 30) }),
        rawNode("c", "r", { transform: xform(40, 40) })
      ],
      ["r", "a", "b", "c"]
    );
    renderer.reconcile(state);
    const [rEl, aEl, bEl, cEl] = [el(stage, "r")!, el(stage, "a")!, el(stage, "b")!, el(stage, "c")!];
    const transformsBefore = [aEl.style.transform, bEl.style.transform, cEl.style.transform];

    mirrorWalkStats.reset();
    // Pure sibling reorder: permuted orderedIds, NO upserts (node objects all keep identity).
    structuralDelta(state, { orderedIds: ["r", "c", "a", "b"] });
    renderer.reconcile(state);

    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    expect(mirrorWalkStats.fullWalks).toBe(0);
    expect(mirrorWalkStats.bails).toBe(0);
    expect(mirrorWalkStats.styledNodes).toBe(0); // nothing restyled — order is a DOM-move, not a style change
    expect(mirrorWalkStats.reorderedParents).toBe(1); // exactly the permuted parent

    // Sibling DOM order matches the new orderedIds; elements kept identity; transforms byte-identical.
    expect(childIds(rEl)).toEqual(["c", "a", "b"]);
    expect(el(stage, "a")).toBe(aEl);
    expect(el(stage, "b")).toBe(bEl);
    expect(el(stage, "c")).toBe(cEl);
    expect([aEl.style.transform, bEl.style.transform, cEl.style.transform]).toEqual(transformsBefore);
  });

  it("ADD + REMOVE in one delta (damage-number churn): new el in slot, removed el detached, counts right", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("holder", null), rawNode("a", "holder"), rawNode("b", "holder")], ["holder", "a", "b"]);
    renderer.reconcile(state);
    const bEl = el(stage, "b")!;

    mirrorWalkStats.reset();
    structuralDelta(state, {
      upserts: [rawNode("d", "holder", { transform: xform(5, 5) })],
      removedIds: ["b"],
      orderedIds: ["holder", "a", "d"]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    expect(mirrorWalkStats.removedRecords).toBe(1);
    expect(el(stage, "b")).toBeNull(); // removed el detached
    expect(bEl.isConnected).toBe(false);
    expect(childIds(el(stage, "holder")!)).toEqual(["a", "d"]); // new el in its correct slot
    expect(stage.querySelectorAll("[data-node-id]").length).toBe(3); // holder, a, d — no stale records/els
    approx(composedMatrix(el(stage, "d")!, stage), nodeMatrix([1, 0, 0, 1, 5, 5], { x: 0, y: 0 }));
  });

  it("REPARENT: element moves under the new parent at the right slot in BOTH parents; parity holds", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("p1", null, { transform: xform(100, 0) }),
        rawNode("m", "p1", { transform: xform(10, 20) }),
        rawNode("p2", null, { transform: xform(500, 0) }),
        rawNode("k", "p2", { transform: xform(10, 20) })
      ],
      ["p1", "m", "p2", "k"]
    );
    renderer.reconcile(state);
    expect(el(stage, "m")!.parentElement).toBe(el(stage, "p1")!);

    mirrorWalkStats.reset();
    // The game reparents m under p2, BEFORE k, with a new local transform.
    structuralDelta(state, {
      upserts: [rawNode("m", "p2", { transform: xform(20, 40) })],
      orderedIds: ["p1", "p2", "m", "k"]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    expect(mirrorWalkStats.fullWalks).toBe(0);
    const p1El = el(stage, "p1")!;
    const p2El = el(stage, "p2")!;
    const mEl = el(stage, "m")!;
    expect(mEl.parentElement).toBe(p2El); // moved under the new parent
    expect(childIds(p1El)).toEqual([]); // gone from the old one
    expect(childIds(p2El)).toEqual(["m", "k"]); // correct sibling slot
    // PARITY oracle: composed on-screen matrices equal the local-transform composition.
    approx(composedMatrix(mEl, stage), nodeMatrix([1, 0, 0, 1, 520, 40], { x: 0, y: 0 }));
    approx(composedMatrix(el(stage, "k")!, stage), nodeMatrix([1, 0, 0, 1, 510, 20], { x: 0, y: 0 }));
  });

  it("BOX-APPEARS via a volatile upsert (no orderedIds): attached + ordered via the pending set, no full rerun", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // b starts BOXLESS with no children → no element (record only).
    full(
      state,
      [
        rawNode("frame", null),
        rawNode("a", "frame", { transform: xform(10, 0) }),
        { id: "b", parentId: "frame", name: "b", nodeType: "Control", visible: true }, // no box → no el
        rawNode("c", "frame", { transform: xform(30, 0) })
      ],
      ["frame", "a", "b", "c"]
    );
    renderer.reconcile(state);
    expect(el(stage, "b")).toBeNull();

    mirrorWalkStats.reset();
    // A volatile upsert gives b a box — same orderedIds ref (no structural delta on the wire).
    volatileDelta(state, [rawNode("b", "frame", { transform: xform(20, 0) })]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.updateWalks).toBe(1); // stays an update walk
    expect(mirrorWalkStats.fullWalks).toBe(0); // no structural re-run (the old fixup path)
    expect(mirrorWalkStats.fixupWalks).toBe(0);
    expect(mirrorWalkStats.reorderedParents).toBe(1); // the pending dom-parent got the targeted reorder
    expect(childIds(el(stage, "frame")!)).toEqual(["a", "b", "c"]); // slotted BETWEEN its siblings, not appended
  });

  it("FULL keyframe replacing the scene → bail path; DOM identical to a fresh renderer fed the same keyframe", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("a1", null), rawNode("a2", "a1")], ["a1", "a2"]);
    renderer.reconcile(state);

    // Scene B (disjoint ids, with a behind child + own paint to exercise ordering) arrives as a FULL keyframe.
    const sceneB = [
      rawNode("b1", null, { fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000" }, transform: xform(50, 50) }),
      rawNode("b2", "b1", { showBehindParent: true, transform: xform(60, 60) }),
      rawNode("b3", "b1", { transform: xform(70, 70) })
    ];
    const orderB = ["b1", "b2", "b3"];
    mirrorWalkStats.reset();
    full(state, sceneB, orderB);
    renderer.reconcile(state);

    // A keyframe upserts every node → the changedIds-ratio bail always trips → the full path ran.
    expect(mirrorWalkStats.bails).toBe(1);
    expect(mirrorWalkStats.fullWalks).toBe(1);
    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(0);
    expect(el(stage, "a1")).toBeNull(); // old scene fully pruned

    // The resulting DOM is byte-identical to a fresh renderer fed the same keyframe.
    const fresh = harness();
    const freshState = createMirrorState();
    full(freshState, sceneB, orderB);
    fresh.renderer.reconcile(freshState);
    expect(stage.innerHTML).toBe(fresh.stage.innerHTML);
  });

  it("exposes the NEW paint order via interactiveRects after a reorder-only delta", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("frame", null, { localRect: box(1920, 1080) }),
        rawNode("s1", "frame", { transform: xform(100, 100), localRect: box(50, 50), mouseFilter: 0 }),
        rawNode("s2", "frame", { transform: xform(300, 100), localRect: box(50, 50), mouseFilter: 0 })
      ],
      ["frame", "s1", "s2"]
    );
    renderer.reconcile(state);
    expect(renderer.interactiveRects().map((r) => r.id)).toEqual(["s1", "s2"]);

    structuralDelta(state, { orderedIds: ["frame", "s2", "s1"] });
    renderer.reconcile(state);
    // Paint order is back-to-front; topmost LAST — s1 now paints on top.
    expect(renderer.interactiveRects().map((r) => r.id)).toEqual(["s2", "s1"]);
  });
});

describe("incremental behind-parent + sub-layer ordering", () => {
  const paint = { fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000" } };

  it("slots a behind child added incrementally BEFORE the parent's sub-layers; removal re-slots them", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("p", null, paint), rawNode("f", "p")], ["p", "f"]);
    renderer.reconcile(state);
    const pEl = el(stage, "p")!;
    const selfLayer = pEl.querySelector(":scope > .mirror-clip-self")!;
    expect([...pEl.children].indexOf(selfLayer)).toBe(0); // no behind children yet → self-paint first

    // ADD a behind child incrementally → it must land BEFORE the self-paint layer.
    structuralDelta(state, {
      upserts: [rawNode("bg", "p", { showBehindParent: true })],
      orderedIds: ["p", "bg", "f"]
    });
    renderer.reconcile(state);
    let kids = [...pEl.children];
    expect(kids.indexOf(el(stage, "bg")!)).toBe(0);
    expect(kids.indexOf(selfLayer)).toBe(1);
    expect(kids.indexOf(el(stage, "f")!)).toBe(2);

    // REMOVE it incrementally → behindCount drops; the NEXT child change slots the sub-layers correctly again.
    structuralDelta(state, { removedIds: ["bg"], orderedIds: ["p", "f"] });
    renderer.reconcile(state);
    kids = [...pEl.children];
    expect(kids.indexOf(selfLayer)).toBe(0);
    expect(kids.indexOf(el(stage, "f")!)).toBe(1);

    structuralDelta(state, { upserts: [rawNode("g", "p")], orderedIds: ["p", "f", "g"] });
    renderer.reconcile(state);
    kids = [...pEl.children];
    expect(kids.indexOf(selfLayer)).toBe(0); // sub-layers stay FIRST (behindCount 0)
    expect(kids.indexOf(el(stage, "f")!)).toBe(1);
    expect(kids.indexOf(el(stage, "g")!)).toBe(2);
  });

  it("keeps the [behind, sub-layers, normal] invariant when a sub-layer owner's children are permuted", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("p", null, paint),
        rawNode("w", "p", { showBehindParent: true }),
        rawNode("x", "p"),
        rawNode("y", "p"),
        rawNode("z", "p")
      ],
      ["p", "w", "x", "y", "z"]
    );
    renderer.reconcile(state);
    const pEl = el(stage, "p")!;
    const selfLayer = pEl.querySelector(":scope > .mirror-clip-self")!;

    mirrorWalkStats.reset();
    structuralDelta(state, { orderedIds: ["p", "w", "z", "x", "y"] }); // permute the normal children
    renderer.reconcile(state);

    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    const kids = [...pEl.children];
    expect(kids.indexOf(el(stage, "w")!)).toBe(0); // behind child stays first
    expect(kids.indexOf(selfLayer)).toBe(1); // own paint after behind children
    expect(kids.slice(2).map((c) => c.getAttribute("data-node-id"))).toEqual(["z", "x", "y"]);
  });
});

describe("incremental walk under a tween pin", () => {
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps a tween-pinned ancestor's transform while an incremental delta adds a child under it", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("p", null, { transform: xform(100, 100) }), rawNode("c", "p", { transform: xform(50, 30) })], ["p", "c"]);
    renderer.reconcile(state);

    // Arm a transform tween on p → global (300,100) over 200ms (pins p's element to the endpoint).
    clock = 10;
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        hints: [{ targetId: "p", property: "position", durationMs: 200, trans: "Cubic", ease: "Out", endTransform: [1, 0, 0, 1, 300, 100] }]
      })!
    );
    renderer.reconcile(state);
    const pEl = el(stage, "p")!;
    expect(parseMatrix(pEl.style.transform).slice(4)).toEqual([300, 100]);
    expect(pEl.style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1)");

    // Mid-tween (t=100 < 210) an INCREMENTAL structural delta adds a new child under the pinned p. p's streamed
    // node object's local transform is unchanged (still 100,100 at the root).
    clock = 100;
    mirrorWalkStats.reset();
    structuralDelta(state, {
      upserts: [rawNode("n", "p", { transform: xform(20, 40) })],
      orderedIds: ["p", "c", "n"]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    // The pinned element is untouched: endpoint transform + transition intact (its paint block never re-ran).
    expect(parseMatrix(pEl.style.transform).slice(4)).toEqual([300, 100]);
    expect(pEl.style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1)");
    // The new child mounts with its streamed local (20,40), so it rides the pinned element visually, exactly like
    // the tween model's descendants.
    const nEl = el(stage, "n")!;
    expect(nEl.parentElement).toBe(pEl);
    expect(parseMatrix(nEl.style.transform).slice(4)).toEqual([20, 40]);
    expect(childIds(pEl)).toEqual(["c", "n"]);
  });
});

describe("incremental walk during a held-card touch interaction", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the held card's lift across a hand reorder delivered as an incremental delta", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("frame", null, { localRect: box(1920, 1080) }),
        rawNode("card", "frame", { nodeType: "NCard", transform: xform(540, 800), localRect: box(160, 220) }),
        rawNode("other", "frame", { nodeType: "NCard", transform: xform(760, 800), localRect: box(160, 220) })
      ],
      ["frame", "card", "other"]
    );
    renderer.reconcile(state);

    renderer.setHeldCard("card", 620, 900, "drag"); // grabbed in hand → lifted off the pickup
    const lifted = el(stage, "card")!.style.translate;
    expect(lifted).not.toBe("0px");
    expect(lifted).not.toBe("");

    // The hand re-sorts (an incremental reorder) while the card is held.
    structuralDelta(state, { orderedIds: ["frame", "other", "card"] });
    renderer.reconcile(state);

    expect(el(stage, "card")!.style.translate).toBe(lifted); // lift preserved
    expect(childIds(el(stage, "frame")!)).toEqual(["other", "card"]); // reorder applied
  });

  it("cleans a targeting arrow REMOVED via an incremental delta (the drag lift can re-engage)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("frame", null, { localRect: box(1920, 1080) }),
        rawNode("card", "frame", { nodeType: "NCard", transform: xform(540, 800), localRect: box(160, 220) }),
        rawNode("targetMgr", "frame", { nodeType: "NTargetManager", transform: xform(0, 0), localRect: box(1, 1) }),
        rawNode("arrow", "targetMgr", { nodeType: "NTargetingArrow", transform: xform(0, 0), localRect: box(1, 1), visible: true })
      ],
      ["frame", "card", "targetMgr", "arrow"]
    );
    renderer.reconcile(state);

    // Grab the card (lifts), then a re-render tracks the VISIBLE arrow → targeting drops the drag lift.
    renderer.setHeldCard("card", 620, 900, "drag");
    expect(el(stage, "card")!.style.translate).not.toBe("0px");
    volatileDelta(state, [rawNode("arrow", "targetMgr", { nodeType: "NTargetingArrow", transform: xform(0, 0), localRect: box(1, 1), visible: true })]);
    renderer.reconcile(state);
    expect(el(stage, "card")!.style.translate).toBe("0px"); // targeting active → static card

    // The arrow node is REMOVED via an incremental structural delta (not a keyframe).
    mirrorWalkStats.reset();
    structuralDelta(state, { removedIds: ["arrow"], orderedIds: ["frame", "card", "targetMgr"] });
    renderer.reconcile(state);
    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    expect(mirrorWalkStats.removedRecords).toBe(1);

    // The removal must have cleaned activeTargetingArrows: the next finger move re-engages the lift.
    renderer.setHeldCard("card", 620, 900, "drag");
    expect(el(stage, "card")!.style.translate).not.toBe("0px");
  });
});

// --- randomized mixed sequence: THE strongest guard — parity + order after every step -------------------------

interface ModelNode {
  id: string;
  parentId: string | null;
  x: number;
  y: number;
  behind: boolean;
}

interface Model {
  nodes: Map<string, ModelNode>;
  kids: Map<string, string[]>; // parent id → ordered child ids
  roots: string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wire(m: ModelNode): Record<string, unknown> {
  return {
    id: m.id,
    parentId: m.parentId,
    name: m.id,
    nodeType: "Control",
    transform: xform(m.x, m.y),
    localRect: box(60, 40),
    visible: true,
    showBehindParent: m.behind
  };
}

function kidsOf(model: Model, pid: string | null): string[] {
  if (pid == null) {
    return model.roots;
  }
  let list = model.kids.get(pid);
  if (!list) {
    list = [];
    model.kids.set(pid, list);
  }
  return list;
}

function dfsOrder(model: Model): string[] {
  const out: string[] = [];
  const walk = (id: string): void => {
    out.push(id);
    for (const kid of model.kids.get(id) ?? []) {
      walk(kid);
    }
  };
  for (const root of model.roots) {
    walk(root);
  }
  return out;
}

function subtreeIds(model: Model, id: string): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    out.push(cur);
    for (const kid of model.kids.get(cur) ?? []) {
      walk(kid);
    }
  };
  walk(id);
  return out;
}

function isDescendant(model: Model, maybeDesc: string, ancestor: string): boolean {
  let cur: string | null | undefined = maybeDesc;
  while (cur != null) {
    if (cur === ancestor) {
      return true;
    }
    cur = model.nodes.get(cur)?.parentId;
  }
  return false;
}

function composedModelMatrix(model: Model, m: ModelNode): Affine {
  const own = nodeMatrix([1, 0, 0, 1, m.x, m.y], { x: 0, y: 0 });
  return m.parentId === null ? own : affineMul(composedModelMatrix(model, model.nodes.get(m.parentId)!), own);
}

// Assert full parity between the model and the DOM: element per node, composed matrix = composed local transforms
// (the PARITY oracle), dom-parenting, per-parent child order ([behind in model order, normal in model order] — these
// nodes carry no own paint, so parents have no sub-layers), and root order under the stage.
function verifyModel(stage: HTMLElement, model: Model): void {
  expect(stage.querySelectorAll("[data-node-id]").length).toBe(model.nodes.size);
  for (const m of model.nodes.values()) {
    const e = el(stage, m.id);
    expect(e, `element for ${m.id}`).not.toBeNull();
    approx(composedMatrix(e!, stage), composedModelMatrix(model, m));
    const expectedParent = m.parentId == null ? stage : el(stage, m.parentId)!;
    expect(e!.parentElement, `dom parent of ${m.id}`).toBe(expectedParent);
  }
  for (const [pid, kids] of model.kids) {
    if (!model.nodes.has(pid) || kids.length === 0) {
      continue;
    }
    const behind = kids.filter((k) => model.nodes.get(k)!.behind);
    const normal = kids.filter((k) => !model.nodes.get(k)!.behind);
    expect(childIds(el(stage, pid)!), `child order under ${pid}`).toEqual([...behind, ...normal]);
  }
  expect(childIds(stage), "root order").toEqual(model.roots);
}

describe("randomized mixed delta sequence (seeded)", () => {
  it("holds the parity + order oracle after every volatile/reorder/add/remove/reparent step", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const rng = mulberry32(0xc0ffee);
    const model: Model = { nodes: new Map(), kids: new Map(), roots: [] };
    let nextId = 0;

    const addModelNode = (parentId: string | null, at: number): ModelNode => {
      const m: ModelNode = {
        id: `n${nextId++}`,
        parentId,
        x: Math.round(rng() * 800),
        y: Math.round(rng() * 600),
        behind: rng() < 0.25
      };
      model.nodes.set(m.id, m);
      kidsOf(model, parentId).splice(at, 0, m.id);
      return m;
    };

    // Initial scene: 2 roots + 28 random-parent nodes, one full keyframe.
    addModelNode(null, 0);
    addModelNode(null, 1);
    for (let i = 0; i < 28; i++) {
      const ids = [...model.nodes.keys()];
      const parent = ids[Math.floor(rng() * ids.length)];
      addModelNode(parent, Math.floor(rng() * (kidsOf(model, parent).length + 1)));
    }
    full(state, [...model.nodes.values()].map(wire), dfsOrder(model));
    renderer.reconcile(state);
    verifyModel(stage, model);

    const pickId = (): string => {
      const ids = [...model.nodes.keys()];
      return ids[Math.floor(rng() * ids.length)];
    };

    for (let step = 0; step < 120; step++) {
      const roll = rng();
      if (roll < 0.35) {
        // VOLATILE MOVE: one node streams a fresh local transform. Its subtree rides the parent delta.
        const m = model.nodes.get(pickId())!;
        m.x = Math.round(rng() * 800);
        m.y = Math.round(rng() * 600);
        volatileDelta(state, [wire(m)]);
      } else if (roll < 0.55) {
        // REORDER: shuffle one parent's (or the roots') child list; orderedIds only.
        const parents: (string | null)[] = [null, ...model.kids.keys()];
        const pid = parents[Math.floor(rng() * parents.length)];
        const list = kidsOf(model, pid);
        for (let i = list.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [list[i], list[j]] = [list[j], list[i]];
        }
        structuralDelta(state, { orderedIds: dfsOrder(model) });
      } else if (roll < 0.75) {
        // ADD: a new node under a random parent (or as a root).
        const parent = rng() < 0.15 ? null : pickId();
        const m = addModelNode(parent, Math.floor(rng() * (kidsOf(model, parent).length + 1)));
        structuralDelta(state, { upserts: [wire(m)], orderedIds: dfsOrder(model) });
      } else if (roll < 0.9) {
        // REMOVE a random subtree (keep the scene ≥ 5 nodes and ≥ 1 root).
        const id = pickId();
        const doomed = subtreeIds(model, id);
        const m = model.nodes.get(id)!;
        if (model.nodes.size - doomed.length < 5 || (m.parentId == null && model.roots.length === 1)) {
          continue;
        }
        for (const d of doomed) {
          model.nodes.delete(d);
          model.kids.delete(d);
        }
        const siblings = kidsOf(model, m.parentId);
        siblings.splice(siblings.indexOf(id), 1);
        structuralDelta(state, { removedIds: doomed, orderedIds: dfsOrder(model) });
      } else {
        // REPARENT: move a node (with its subtree) under a different parent.
        const id = pickId();
        const m = model.nodes.get(id)!;
        const candidates = [...model.nodes.keys()].filter((c) => c !== id && c !== m.parentId && !isDescendant(model, c, id));
        if (candidates.length === 0) {
          continue;
        }
        const newParent = candidates[Math.floor(rng() * candidates.length)];
        const oldSiblings = kidsOf(model, m.parentId);
        oldSiblings.splice(oldSiblings.indexOf(id), 1);
        m.parentId = newParent;
        const newSiblings = kidsOf(model, newParent);
        newSiblings.splice(Math.floor(rng() * (newSiblings.length + 1)), 0, id);
        structuralDelta(state, { upserts: [wire(m)], orderedIds: dfsOrder(model) });
      }
      renderer.reconcile(state);
      verifyModel(stage, model);
    }

    // Nothing unaccounted ever fired the defensive full-walk escape.
    expect(mirrorWalkStats.fixupWalks).toBe(0);
    // Sanity: the sequence actually exercised the incremental path (not only bails/updates).
    expect(mirrorWalkStats.incrementalStructuralWalks).toBeGreaterThan(10);
  });
});

// R10-PERF5 WS-1 — DORMANT HIDDEN SUBTREES, from this file's angle: the composed-matrix parity oracle must hold
// for a subtree the renderer never built until the reveal walk. (The boundary itself is specced in
// mirrorRendererDormant.spec.ts; this pins that a revealed subtree is geometrically indistinguishable from one
// that was always on screen.)
describe("incremental walks across a dormancy boundary", () => {
  it("REVEAL: composed matrices + child order match a subtree that was visible all along", () => {
    const scene = (dialogVisible: boolean) => [
      rawNode("root", null, { transform: xform(10, 10) }),
      rawNode("hud", "root", { transform: xform(20, 20) }),
      rawNode("dlg", "root", { transform: xform(30, 30), visible: dialogVisible }),
      rawNode("dlg-a", "dlg", { transform: xform(40, 41) }),
      rawNode("dlg-b", "dlg", { transform: xform(50, 51) }),
      rawNode("dlg-a1", "dlg-a", { transform: xform(60, 61) })
    ];
    const order = ["root", "hud", "dlg", "dlg-a", "dlg-a1", "dlg-b"];

    // (a) hidden at the keyframe, then revealed by a volatile flip.
    const lazy = harness();
    const lazyState = createMirrorState();
    full(lazyState, scene(false), order);
    lazy.renderer.reconcile(lazyState);
    expect(el(lazy.stage, "dlg-a1")).toBeNull(); // nothing under the closed dialog exists yet
    volatileDelta(lazyState, [rawNode("dlg", "root", { transform: xform(30, 30), visible: true })]);
    lazy.renderer.reconcile(lazyState);

    // (b) the control: the same scene, visible from the start.
    const eager = harness();
    const eagerState = createMirrorState();
    full(eagerState, scene(true), order);
    eager.renderer.reconcile(eagerState);

    for (const id of ["dlg", "dlg-a", "dlg-b", "dlg-a1"]) {
      const revealed = el(lazy.stage, id)!;
      expect(revealed, `revealed ${id}`).not.toBeNull();
      approx(composedMatrix(revealed, lazy.stage), composedMatrix(el(eager.stage, id)!, eager.stage));
    }
    expect(childIds(el(lazy.stage, "dlg")!)).toEqual(childIds(el(eager.stage, "dlg")!));
    expect(lazy.stage.innerHTML).toBe(eager.stage.innerHTML);
  });

  it("an incremental ADD under a hidden root builds nothing and still reorders the VISIBLE parents", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("root", null),
        rawNode("hud", "root", { transform: xform(20, 20) }),
        rawNode("hud-a", "hud"),
        rawNode("dlg", "root", { visible: false }),
        rawNode("dlg-a", "dlg")
      ],
      ["root", "hud", "hud-a", "dlg", "dlg-a"]
    );
    renderer.reconcile(state);
    const before = stage.querySelectorAll(".mirror-node").length;

    mirrorWalkStats.reset();
    // One add inside the closed dialog + a sibling reorder in the OPEN hud, in the same structural delta.
    structuralDelta(state, {
      upserts: [rawNode("dlg-b", "dlg"), rawNode("hud-b", "hud")],
      orderedIds: ["root", "hud", "hud-b", "hud-a", "dlg", "dlg-a", "dlg-b"]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    expect(el(stage, "dlg-b")).toBeNull(); // dormant add — no element
    expect(stage.querySelectorAll(".mirror-node").length).toBe(before + 1); // only `hud-b`
    expect(childIds(el(stage, "hud")!)).toEqual(["hud-b", "hud-a"]); // the visible reorder still lands
  });
});
