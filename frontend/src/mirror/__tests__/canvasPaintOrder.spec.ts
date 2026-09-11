// PAINT ORDER for the single-canvas stage: the three sibling rules, the contiguity invariant they imply, and the
// cache that keeps the sorts off the hot path.
//
// The behind-parent split is cross-checked against the DOM backend itself — `mirrorRenderer` produces exactly this
// order in the DOM (`desiredKidsInVisitOrder` → `applyChildOrder`), so an equal-z scene must give byte-identical
// child sequences. Where the two DIVERGE (z != 0) the divergence is asserted rather than papered over: the DOM
// backend leaves z to CSS, so its element order does not carry it, while the draw list must.

import { beforeEach, describe, expect, it } from "vitest";

import {
  assertContiguousSpans,
  buildPaintOrder,
  createPaintOrderCache
} from "@/mirror/canvas/paintOrder";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorNode,
  type MirrorState
} from "@/mirror/sceneTree";

// --- fixtures --------------------------------------------------------------------------------------------------

function mkNode(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId,
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

/** A state whose `orderedIds` is the producer's own pre-order DFS over the listed nodes. */
function mkState(nodes: MirrorNode[]): MirrorState {
  const state = createMirrorState();
  for (const node of nodes) {
    state.nodes.set(node.id, node);
  }
  state.orderedIds = preOrder(nodes);
  state.revision = 1;
  return state;
}

function preOrder(nodes: MirrorNode[]): string[] {
  const byParent = new Map<string | null, string[]>();
  for (const node of nodes) {
    const key = node.parentId != null && nodes.some((n) => n.id === node.parentId) ? node.parentId : null;
    const list = byParent.get(key) ?? [];
    list.push(node.id);
    byParent.set(key, list);
  }
  const out: string[] = [];
  const walk = (id: string): void => {
    out.push(id);
    for (const kid of byParent.get(id) ?? []) {
      walk(kid);
    }
  };
  for (const root of byParent.get(null) ?? []) {
    walk(root);
  }
  return out;
}

// --- the sort's stability --------------------------------------------------------------------------------------

describe("Array.prototype.sort stability", () => {
  it("is stable — the whole equal-z rule rests on it", () => {
    // ES2019 requires it, but `sortSiblings` is a bare `a.z - b.z` with no id tiebreak, so if the engine under
    // vitest were ever unstable, an equal-z run would silently permute (intra-card stacking, the hand fan).
    // 200 entries is past the 10-element threshold V8 used to switch algorithms at.
    const items = Array.from({ length: 200 }, (_, i) => ({ i, key: i % 3 }));
    const sorted = items.slice().sort((a, b) => a.key - b.key);
    for (let k = 0; k < 3; k++) {
      const run = sorted.filter((e) => e.key === k).map((e) => e.i);
      expect(run).toEqual(run.slice().sort((a, b) => a - b));
    }
  });
});

// --- ordering rules ---------------------------------------------------------------------------------------------

describe("buildPaintOrder", () => {
  it("emits behind-parent children, then the node, then the front children", () => {
    const order = buildPaintOrder(
      mkState([
        mkNode("P", null),
        mkNode("behindA", "P", { showBehindParent: true }),
        mkNode("frontA", "P"),
        mkNode("behindB", "P", { showBehindParent: true }),
        mkNode("frontB", "P")
      ])
    );
    expect(order.ids).toEqual(["behindA", "behindB", "P", "frontA", "frontB"]);
    expect(order.childrenOf("P")).toEqual(["behindA", "behindB", "frontA", "frontB"]);
    expect(order.behindCountOf("P")).toBe(2);
  });

  it("sorts each group by z ascending, and keeps equal-z siblings in producer order", () => {
    const order = buildPaintOrder(
      mkState([
        mkNode("P", null),
        mkNode("f0a", "P"),
        mkNode("fHigh", "P", { zIndex: 5 }),
        mkNode("f0b", "P"),
        mkNode("fLow", "P", { zIndex: -3 }),
        mkNode("f0c", "P"),
        mkNode("bHigh", "P", { showBehindParent: true, zIndex: 2 }),
        mkNode("b0", "P", { showBehindParent: true })
      ])
    );
    // behind group first (own z order), then P, then the front group.
    expect(order.ids).toEqual(["b0", "bHigh", "P", "fLow", "f0a", "f0b", "f0c", "fHigh"]);
  });

  it("keeps a raised child inside its parent's span — z cannot escape the parent", () => {
    const order = buildPaintOrder(
      mkState([
        mkNode("Root", null),
        mkNode("Low", "Root"),
        mkNode("LowKid", "Low", { zIndex: 999 }),
        mkNode("High", "Root", { zIndex: 1 })
      ])
    );
    const low = order.entries.get("Low")!;
    const kid = order.entries.get("LowKid")!;
    expect(kid.order).toBeGreaterThanOrEqual(low.spanStart);
    expect(kid.order).toBeLessThan(low.spanEnd);
    // …and the z=999 grandchild still paints BELOW its uncle, because the uncle is later in the parent's list.
    expect(order.orderOf("LowKid")).toBeLessThan(order.orderOf("High"));
    expect(() => assertContiguousSpans(order)).not.toThrow();
  });

  it("gives every node a contiguous span holding exactly its subtree", () => {
    const order = buildPaintOrder(
      mkState([
        mkNode("A", null),
        mkNode("A1", "A", { showBehindParent: true }),
        mkNode("A1a", "A1"),
        mkNode("A2", "A", { zIndex: 3 }),
        mkNode("A2a", "A2", { showBehindParent: true }),
        mkNode("A3", "A"),
        mkNode("B", null, { zIndex: -1 })
      ])
    );
    for (const entry of order.entries.values()) {
      const slice = order.ids.slice(entry.spanStart, entry.spanEnd);
      expect(slice).toContain(entry.id);
      // Every id in the span descends from `entry` (walk the parent chain in the order's own entries).
      for (const id of slice) {
        let cur: string | null = id;
        let found = false;
        while (cur != null) {
          if (cur === entry.id) {
            found = true;
            break;
          }
          cur = order.entries.get(cur)?.parentId ?? null;
        }
        expect(found).toBe(true);
      }
    }
    expect(() => assertContiguousSpans(order)).not.toThrow();
  });

  it("orders an ORPHAN as a stage root, like every other structure builder", () => {
    const order = buildPaintOrder(mkState([mkNode("Root", null), mkNode("Lost", "NotHere")]));
    expect(order.rootIds).toEqual(["Root", "Lost"]);
    expect(order.entries.get("Lost")!.parentId).toBeNull();
  });

  it("drops ids the node map no longer holds", () => {
    const state = mkState([mkNode("Root", null), mkNode("Gone", "Root")]);
    state.nodes.delete("Gone");
    const order = buildPaintOrder(state);
    expect(order.ids).toEqual(["Root"]);
  });

  it("throws when a span is not contiguous — the invariant is checked, not assumed", () => {
    const order = buildPaintOrder(mkState([mkNode("P", null), mkNode("K", "P")]));
    const broken = {
      ...order,
      entries: new Map(order.entries).set("K", { ...order.entries.get("K")!, spanEnd: 99 })
    };
    expect(() => assertContiguousSpans(broken)).toThrow(/escapes parent|not contiguous/);
  });
});

// --- the cache ---------------------------------------------------------------------------------------------------

describe("PaintOrderCache", () => {
  it("reuses sibling sorts while orderedIds keeps its identity, and re-sorts when it changes", () => {
    const cache = createPaintOrderCache();
    const state = mkState([mkNode("P", null), mkNode("a", "P"), mkNode("b", "P", { zIndex: 2 })]);

    buildPaintOrder(state, cache);
    const sortedFirst = cache.stats.sortedParents;
    expect(sortedFirst).toBeGreaterThan(0);
    expect(cache.stats.reusedParents).toBe(0);

    buildPaintOrder(state, cache);
    expect(cache.stats.sortedParents).toBe(sortedFirst); // nothing re-sorted
    expect(cache.stats.reusedParents).toBeGreaterThan(0);

    // A structural delta hands the reconciler a NEW orderedIds array — the cache's own signal.
    state.orderedIds = state.orderedIds.slice();
    const rebuilds = cache.stats.rebuilds;
    buildPaintOrder(state, cache);
    expect(cache.stats.rebuilds).toBe(rebuilds + 1);
    expect(cache.stats.sortedParents).toBeGreaterThan(sortedFirst);
  });

  it("drops exactly the parent whose child's z moved, on the reconciler's own changedIds", () => {
    const cache = createPaintOrderCache();
    const a = mkNode("a", "P");
    const state = mkState([mkNode("P", null), a, mkNode("b", "P"), mkNode("Q", null), mkNode("q1", "Q")]);
    buildPaintOrder(state, cache);

    // The reconciler swaps in a FRESH node object for a changed node, exactly as `applySceneDelta` does.
    state.nodes.set("a", { ...a, zIndex: 9 });
    expect(cache.noteChanged(state, ["a"])).toBe(1);

    const before = cache.stats.sortedParents;
    const order = buildPaintOrder(state, cache);
    expect(cache.stats.sortedParents).toBe(before + 1); // only P re-sorted; Q and the roots were reused
    expect(order.childrenOf("P")).toEqual(["b", "a"]);
  });

  it("dirties BOTH lists on a reparent, and the former parent's on a removal", () => {
    const cache = createPaintOrderCache();
    const kid = mkNode("k", "P");
    // Q already has a child, so it HAS a cached sort for the reparent to dirty. (A childless parent has no cache
    // entry at all — leaves never take one — so a reparent onto one drops exactly the old list.)
    const state = mkState([mkNode("P", null), mkNode("Q", null), kid, mkNode("q1", "Q")]);
    buildPaintOrder(state, cache);

    state.nodes.set("k", { ...kid, parentId: "Q" });
    expect(cache.noteChanged(state, ["k"])).toBe(2);

    buildPaintOrder(state, cache);
    state.nodes.delete("k");
    expect(cache.noteChanged(state, ["k"])).toBe(1);
  });
});

// --- cross-check against the DOM backend ---------------------------------------------------------------------

function wireNode(
  id: string,
  parentId: string | null,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 40, y: 40 } },
    visible: true,
    ...over
  };
}

function domChildIds(stage: HTMLElement, parentId: string): string[] {
  const parent = stage.querySelector<HTMLElement>(`[data-node-id="${parentId}"]`);
  if (!parent) throw new Error(`no element for ${parentId}`);
  return [...parent.children]
    .map((el) => (el as HTMLElement).getAttribute("data-node-id"))
    .filter((id): id is string => id !== null);
}

describe("agreement with the DOM backend's own child order", () => {
  let stage: HTMLElement;
  let renderer: MirrorRenderer;

  beforeEach(() => {
    document.body.innerHTML = "";
    stage = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(defs);
    document.body.append(stage, svg);
    renderer = createMirrorRenderer(stage, defs);
  });

  function build(nodes: Record<string, unknown>[]): MirrorState {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        upserts: nodes,
        orderedIds: nodes.map((n) => n.id as string)
      })!
    );
    renderer.reconcile(state);
    return state;
  }

  it("produces the DOM's exact behind-then-front sequence when every sibling is at z 0", () => {
    const state = build([
      wireNode("P", null),
      wireNode("f1", "P"),
      wireNode("b1", "P", { showBehindParent: true }),
      wireNode("f2", "P"),
      wireNode("b2", "P", { showBehindParent: true })
    ]);
    const order = buildPaintOrder(state);
    // The DOM parent element holds [behind children…, own sub-layers…, front children…]; the mirror node children
    // are the ones carrying `data-node-id`, and their sequence is what this order must reproduce.
    expect(order.childrenOf("P")).toEqual(domChildIds(stage, "P"));
    expect(order.behindCountOf("P")).toBe(2);
  });

  it("DIVERGES from DOM order on z — deliberately: the DOM leaves z to CSS, a draw list cannot", () => {
    const state = build([
      wireNode("P", null),
      wireNode("low", "P"),
      wireNode("high", "P", { zIndex: 4 }),
      wireNode("mid", "P")
    ]);
    const order = buildPaintOrder(state);
    // The DOM keeps producer order and stamps `z-index: 4` on `high`…
    expect(domChildIds(stage, "P")).toEqual(["low", "high", "mid"]);
    expect(stage.querySelector<HTMLElement>('[data-node-id="high"]')!.style.zIndex).toBe("4");
    // …the draw list resolves it into the emission order instead.
    expect(order.childrenOf("P")).toEqual(["low", "mid", "high"]);
  });
});
