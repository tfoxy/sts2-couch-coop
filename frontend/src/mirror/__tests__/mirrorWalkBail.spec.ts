import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,
  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// R10-PERF3 — WALK-MODE CLASSIFICATION. Which reconciles take the expensive FULL structural path and which stay
// on the pruned incremental one. The regression these specs pin: a card play is VOLATILE-FAT (hundreds of
// re-upserted nodes: tween hints, HP, badges, energy, VFX) but STRUCTURALLY TINY (a handful of adds/removes), and
// the old classifier read `state.changedIds.size` — which counts every one of those volatile upserts — so it
// misclassified the tick as "too churny to prune" and paid a full walk (~130ms on a phone), which let the next
// coalesced batch grow fatter and bail again. Classification now looks ONLY at structure: a wire keyframe, or the
// churn the index diff itself reports.

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}

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

function rawNode(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: xform(0, 0),
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 16 } },
    visible: true,
    ...over
  };
}

function keyframe(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!
  );
}

function structural(
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
  return stage.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
}

function childIds(parent: HTMLElement): (string | null)[] {
  return [...parent.children].filter((c) => c.hasAttribute("data-node-id")).map((c) => c.getAttribute("data-node-id"));
}

// A combat-shaped base scene: a root, a "hand" holder, and enough inert leaves that the 15% churn ratio (not the
// absolute floor of 8) is what governs — the regime a real ~680-node combat scene is in.
const LEAF_COUNT = 200;
const leafIds = Array.from({ length: LEAF_COUNT }, (_, i) => `leaf${i}`);
const BASE_ORDER = ["root", "hand", ...leafIds];

function baseScene(): Record<string, unknown>[] {
  return [
    rawNode("root", null),
    rawNode("hand", "root"),
    ...leafIds.map((id, i) => rawNode(id, "root", { transform: xform(i, 0) }))
  ];
}

function build(): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
  const { stage, renderer } = harness();
  const state = createMirrorState();
  keyframe(state, baseScene(), BASE_ORDER);
  renderer.reconcile(state);
  return { stage, renderer, state };
}

let created: MirrorRenderer[] = [];

beforeEach(() => {
  document.body.innerHTML = "";
  created = [];
  mirrorWalkStats.reset();
});

afterEach(() => {
  for (const r of created) {
    r.dispose();
  }
  created = [];
  document.body.innerHTML = "";
});

// The delta a card play looks like to the classifier: ONE structural add, plus a flood of volatile re-upserts of
// nodes that were already there (new transforms only — no structure).
function volatileFatTick(state: MirrorState, volatileCount: number): void {
  structural(state, {
    upserts: [
      rawNode("played", "hand"),
      ...leafIds.slice(0, volatileCount).map((id, i) => rawNode(id, "root", { transform: xform(i, 7) }))
    ],
    orderedIds: [...BASE_ORDER, "played"]
  });
}

describe("walk-mode classification: structural churn only", () => {
  it("VOLATILE-FAT, structurally tiny tick stays INCREMENTAL (the card-play regression)", () => {
    const { stage, renderer, state } = build();
    expect(mirrorWalkStats.fullWalks).toBe(1); // the keyframe itself

    volatileFatTick(state, 150);
    // The old classifier's input, for the record: 151 changed ids on a 202-node scene — way over max(16, 30%).
    expect(state.changedIds.size).toBeGreaterThan(state.orderedIds.length * 0.3);
    renderer.reconcile(state);

    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    expect(mirrorWalkStats.bails).toBe(0);
    expect(mirrorWalkStats.fullWalks).toBe(1); // still just the keyframe

    // ...and the pruned walk actually applied the delta: the added node is in the DOM under `hand`, and a
    // volatile-only re-upsert moved its element.
    expect(childIds(el(stage, "hand")!)).toEqual(["played"]);
    expect(el(stage, "leaf3")!.style.transform).toContain("7");
  });

  it("keeps the volatile-fat tick incremental at 100% volatile coverage (every node re-upserted)", () => {
    const { renderer, state } = build();
    volatileFatTick(state, LEAF_COUNT);
    expect(state.changedIds.size).toBeGreaterThanOrEqual(LEAF_COUNT);
    renderer.reconcile(state);

    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    expect(mirrorWalkStats.bails).toBe(0);
  });

  it("GENUINE structural storm (mass remove + reparent) BAILS to the full path", () => {
    const { renderer, state } = build();
    // Every leaf is re-parented under `hand` AND the first 60 are deleted: 2 order-dirty parents + 60 derived
    // removals — but the metric that matters is that this is all STRUCTURE, unlike the tick above.
    const survivors = leafIds.slice(60);
    structural(state, {
      removedIds: leafIds.slice(0, 60),
      upserts: survivors.map((id) => rawNode(id, "hand")),
      orderedIds: ["root", "hand", ...survivors]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.bails).toBe(1);
    expect(mirrorWalkStats.fullWalks).toBe(2); // keyframe + the bail
    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(0);
  });

  it("ADD-ONLY storm bails on the added-node term (which the old churn metric could not see)", () => {
    const { renderer, state } = build();
    // One order-dirty parent, zero removals — churn is carried entirely by the 60 new nodes (> 15% of 262).
    const fresh = Array.from({ length: 60 }, (_, i) => `new${i}`);
    structural(state, {
      upserts: fresh.map((id) => rawNode(id, "root")),
      orderedIds: [...BASE_ORDER, ...fresh]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.bails).toBe(1);
    expect(mirrorWalkStats.fullWalks).toBe(2);

  });

  it("a small structural delta stays incremental (unchanged behaviour)", () => {
    const { renderer, state } = build();
    structural(state, { upserts: [rawNode("one", "hand")], orderedIds: [...BASE_ORDER, "one"] });
    renderer.reconcile(state);
    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    expect(mirrorWalkStats.bails).toBe(0);
  });
});

describe("walk-mode classification: wire keyframes", () => {
  it("a mid-session `full:true` keyframe takes the FULL path and counts a bail", () => {
    const { stage, renderer, state } = build();
    mirrorWalkStats.reset();

    // A brand-new scene delivered as a keyframe (nodes.clear() + re-upsert of everything).
    keyframe(
      state,
      [rawNode("root2", null), rawNode("kid", "root2")],
      ["root2", "kid"]
    );
    expect(state.sceneRewrite).toBe(true);
    renderer.reconcile(state);

    expect(mirrorWalkStats.bails).toBe(1);
    expect(mirrorWalkStats.fullWalks).toBe(1);
    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(0);
    // The full path re-established the scene: the old tree is gone, the new one is mounted.
    expect(el(stage, "leaf0")).toBeNull();
    expect(childIds(el(stage, "root2")!)).toEqual(["kid"]);
  });

  it("the keyframe flag is CONSUMED by the reconcile — the next structural delta stays incremental", () => {
    const { renderer, state } = build();
    keyframe(state, baseScene(), BASE_ORDER);
    renderer.reconcile(state);
    expect(state.sceneRewrite).toBe(false);
    mirrorWalkStats.reset();

    volatileFatTick(state, 150);
    renderer.reconcile(state);
    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    expect(mirrorWalkStats.bails).toBe(0);
  });

  it("a keyframe COALESCED with a later volatile delta still bails (the flag survives until consumed)", () => {
    const { renderer, state } = build();
    mirrorWalkStats.reset();
    keyframe(state, baseScene(), BASE_ORDER);
    // A second delta lands in the same frame — Vue coalesces both into one reconcile.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [rawNode("leaf0", "root", { transform: xform(3, 3) })]
      })!
    );
    expect(state.sceneRewrite).toBe(true);
    renderer.reconcile(state);
    expect(mirrorWalkStats.bails).toBe(1);
    expect(mirrorWalkStats.fullWalks).toBe(1);
  });
});
