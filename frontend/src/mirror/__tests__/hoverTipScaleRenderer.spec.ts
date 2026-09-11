import { beforeEach, describe, expect, it } from "vitest";

import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// DOM-level cover for Feature 1: the per-drain tip-scale pass stamps a 1.2× scale (composed with the tip root's
// own transform) onto an NHoverTipSet root, leaves everything else alone, and follows the readability setting.
// The pivot/clamp MATH itself is unit-tested in hoverTipScaleMath.spec.ts.

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}
function boxAt(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}
function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
}
function el(stage: HTMLElement, id: string): HTMLElement {
  return stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
}
// The FIRST matrix() of a transform string (the tip-scale pass prepends its scale matrix ahead of the base).
function firstMatrix(transform: string): number[] {
  const m = /matrix\(([^)]*)\)/.exec(transform);
  return m ? m[1].split(",").map((v) => Number(v.trim())) : [];
}
function matrixCount(transform: string): number {
  return (transform.match(/matrix\(/g) ?? []).length;
}

// A HoverTip set: root NHoverTipSet (a container placed at `rootGlobal`, with a box so it renders a matrix) and a
// single paint-bearing card child at design (1040,660) sized 360×122 → design AABB (1040,660,360,122) → pivot
// (1040,660), no clamp. The 1.2× stamp about that pivot is matrix(1.2,0,0,1.2, 1040·-0.2, 660·-0.2) = (…,-208,-132).
function tipScene(state: MirrorState, rootX = 100, rootY = 200): void {
  full(
    state,
    [
      { id: "tips", parentId: null, name: "tips", nodeType: "HoverTips.NHoverTipSet", transform: xform(rootX, rootY), localRect: boxAt(400, 300), visible: true },
      {
        id: "card",
        parentId: "tips",
        name: "card",
        nodeType: "NHoverTipCardContainer",
        transform: xform(940, 460),
        localRect: boxAt(360, 122),
        visible: true,
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" }
      }
    ],
    ["tips", "card"]
  );
}

// Like tipScene but the tip carries an anchorOwnerId pointing at an owner whose KIND drives the growth side (#17/#18).
// `ownerType` NCreature → Creature kind → pivot union.MaxX (grow LEFT); NHandCardHolder → HandCard → union.MinX
// (grow RIGHT). Tip child union (1040,660,1400,782); owner box below-right so the vertical stays grow-up (MaxY 782).
//   Creature: scale matrix = matrix(1.2,0,0,1.2, 1400·-0.2, 782·-0.2) = (…, -280, -156.4).
//   HandCard: scale matrix = matrix(1.2,0,0,1.2, 1040·-0.2, 782·-0.2) = (…, -208, -156.4).
function tipSceneWithOwner(state: MirrorState, ownerType = "NCreature"): void {
  full(
    state,
    [
      { id: "owner", parentId: null, name: "owner", nodeType: ownerType, transform: xform(1600, 660), localRect: boxAt(100, 100), visible: true, fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#fff" } },
      { id: "tips", parentId: null, name: "tips", nodeType: "HoverTips.NHoverTipSet", transform: xform(100, 200), localRect: boxAt(400, 300), visible: true, anchorOwnerId: "owner" },
      {
        id: "card",
        parentId: "tips",
        name: "card",
        nodeType: "NHoverTipCardContainer",
        transform: xform(940, 460),
        localRect: boxAt(360, 122),
        visible: true,
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" }
      }
    ],
    ["owner", "tips", "card"]
  );
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("mirror tip-scale pass (Feature 1)", () => {
  it("prepends a 1.2× scale about the anchored pivot to the tip root's transform", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    tipScene(state);
    renderer.reconcile(state);

    const t = el(stage, "tips").style.transform;
    // Two matrices: the prepended scale, then the tip root's own placement (matrix(1,0,0,1,100,200)).
    expect(matrixCount(t)).toBe(2);
    const scale = firstMatrix(t);
    expect(scale[0]).toBeCloseTo(1.2, 6); // a
    expect(scale[3]).toBeCloseTo(1.2, 6); // d
    expect(scale[4]).toBeCloseTo(-208, 4); // 1040·(1−1.2)
    expect(scale[5]).toBeCloseTo(-132, 4); // 660·(1−1.2)
    expect(t.endsWith("matrix(1, 0, 0, 1, 100, 200)")).toBe(true); // base preserved (composed, not clobbered)
  });

  it("owner kind Creature: grows LEFT (pivots at union.MaxX)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    tipSceneWithOwner(state, "NCreature");
    renderer.reconcile(state);

    const t = el(stage, "tips").style.transform;
    expect(matrixCount(t)).toBe(2);
    const scale = firstMatrix(t);
    expect(scale[0]).toBeCloseTo(1.2, 6);
    expect(scale[4]).toBeCloseTo(-280, 4); // 1400·(1−1.2): Creature kind → pivot union.MaxX (grow left)
    expect(scale[5]).toBeCloseTo(-156.4, 4); // 782·(1−1.2): pivot at union.MaxY (grow up)
  });

  it("owner kind HandCard: grows RIGHT (pivots at union.MinX)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    tipSceneWithOwner(state, "NHandCardHolder");
    renderer.reconcile(state);

    const t = el(stage, "tips").style.transform;
    expect(matrixCount(t)).toBe(2);
    const scale = firstMatrix(t);
    expect(scale[4]).toBeCloseTo(-208, 4); // 1040·(1−1.2): HandCard kind → pivot union.MinX (grow right)
    expect(scale[5]).toBeCloseTo(-156.4, 4); // 782·(1−1.2): pivot at union.MaxY (grow up)
  });

  it("leaves a NON-tip node's transform untouched (single matrix, no scale)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [{ id: "plain", parentId: null, name: "plain", nodeType: "ColorRect", transform: xform(50, 60), localRect: boxAt(80, 40), visible: true, fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#fff" } }],
      ["plain"]
    );
    renderer.reconcile(state);
    const t = el(stage, "plain").style.transform;
    expect(matrixCount(t)).toBe(1);
    expect(firstMatrix(t)[0]).toBe(1); // no 1.2 scale
  });

  it("is idempotent across drains — the scale never self-compounds", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    tipScene(state);
    renderer.reconcile(state);
    renderer.reconcile(state);
    renderer.reconcile(state);
    const t = el(stage, "tips").style.transform;
    expect(matrixCount(t)).toBe(2); // still exactly scale + base, not scale·scale·…·base
    expect(firstMatrix(t)[0]).toBeCloseTo(1.2, 6);
  });
});
