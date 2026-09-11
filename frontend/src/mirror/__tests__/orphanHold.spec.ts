import { beforeEach, describe, expect, it } from "vitest";

import {
  createMirrorRenderer,

  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, isOrphanNode, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// ORPHAN HOLD. A node whose `parentId` names a node that is NOT live has to go SOMEWHERE in the
// draw order, and both structure builders put it at the stage root. That is fine for order and wrong for placement:
// its streamed transform is one link of a chain the client can't reconstruct, so drawing it as a root collapses it
// onto (or near) the design origin — the phantom-in-the-top-left-corner class of bug. The safeguard holds such a
// node INVISIBLE (kept warm: its record survives, the dormancy boundary just refuses to build DOM for it) until its
// parent becomes live. True producer roots (parentId null/absent) are untouched.

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function node(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.Sprite2D",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 3, y: 3 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 54, y: 54 } },
    texture: { resourcePath: "res://images/potion.png" },
    visible: true,
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "event", upserts: nodes, orderedIds: order })!
  );
}

function el(stage: HTMLElement, id: string): HTMLElement | null {
  return stage.querySelector(`[data-node-id="${id}"]`);
}

// "The viewer can see it": it has an element AND that element isn't display:none. A held orphan usually has no
// element at all (the dormancy boundary never builds one); one that was built BEFORE it lost its parent is
// display:none'd instead. Both are "not visible", which is the property the safeguard is about.
function visiblyRendered(stage: HTMLElement, id: string): boolean {
  const found = el(stage, id);
  return found != null && found.style.display !== "none";
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("isOrphanNode", () => {
  it("is true only for a node whose named parent is missing from the map", () => {
    const state = createMirrorState();
    full(state, [node("root", null), node("child", "root"), node("stray", "ghost")], ["root", "child", "stray"]);
    const nodes = state.nodes;
    expect(isOrphanNode(nodes.get("root")!, nodes)).toBe(false);
    expect(isOrphanNode(nodes.get("child")!, nodes)).toBe(false);
    expect(isOrphanNode(nodes.get("stray")!, nodes)).toBe(true);
  });
});

describe("orphan hold", () => {
  it("does not render a node whose parent is not live", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("root", null), node("stray", "ghost")], ["root", "stray"]);

    renderer.reconcile(state);

    expect(visiblyRendered(stage, "root"), "a TRUE producer root is unaffected").toBe(true);
    expect(visiblyRendered(stage, "stray"), "the orphan is held invisible").toBe(false);
  });

  it("renders it as soon as the parent becomes live", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("root", null), node("stray", "ghost")], ["root", "stray"]);
    renderer.reconcile(state);
    expect(visiblyRendered(stage, "stray")).toBe(false);

    // The missing parent arrives (a structural delta: new node + a new order).
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "event",
        upserts: [node("ghost", "root")],
        orderedIds: ["root", "ghost", "stray"]
      })!
    );
    renderer.reconcile(state);

    expect(visiblyRendered(stage, "ghost")).toBe(true);
    expect(visiblyRendered(stage, "stray"), "the held node renders once its chain is complete").toBe(true);
    // And it now hangs UNDER the parent, not at the stage root.
    expect(el(stage, "stray")!.closest('[data-node-id="ghost"]')).not.toBeNull();
  });

  it("holds a node that LOSES its parent mid-session (it was visible, now it would collapse to the origin)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("root", null), node("holder", "root"), node("potion", "holder")], [
      "root",
      "holder",
      "potion"
    ]);
    renderer.reconcile(state);
    expect(visiblyRendered(stage, "potion")).toBe(true);

    // The parent is removed but the child is NOT — the reparent/prune race the safeguard exists for.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "event",
        upserts: [],
        removedIds: ["holder"],
        orderedIds: ["root", "potion"]
      })!
    );
    renderer.reconcile(state);

    expect(visiblyRendered(stage, "potion"), "the stranded child stops being drawn at the origin").toBe(false);
  });

  it("leaves a node hidden by the GAME hidden when its parent arrives (the hold is additive)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("root", null), node("stray", "ghost", { visible: false })], ["root", "stray"]);
    renderer.reconcile(state);

    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "event",
        upserts: [node("ghost", "root")],
        orderedIds: ["root", "ghost", "stray"]
      })!
    );
    renderer.reconcile(state);

    expect(visiblyRendered(stage, "stray"), "still hidden — the game says so").toBe(false);
  });
});
