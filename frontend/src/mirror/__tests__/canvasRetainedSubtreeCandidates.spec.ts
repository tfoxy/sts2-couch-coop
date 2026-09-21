import { describe, expect, it } from "vitest";
import {
  BLEND_ADD,
  createDrawList,
  createQuadView,
  DRAW_QUAD,
  type BlendMode,
  type DrawList,
  type StageProjection,
} from "@godot-scene-web/canvas";

import type { DrawListBuild, NodeCommandRange } from "@/mirror/canvas/buildDrawList";
import { buildPaintOrder } from "@/mirror/canvas/paintOrder";
import { planRetainedSubtreeCandidates } from "@/mirror/canvas/retainedSubtreeCandidates";
import { createMirrorState, type MirrorNode } from "@/mirror/sceneTree";

type Texture = { id: string; revision: number };

const projection: StageProjection = {
  designWidth: 400,
  designHeight: 200,
  toClip: new Float32Array([2 / 400, -2 / 200, -1, 1]),
  toFramebuffer: new Float32Array([1, 0, 0, 1, 0, 0]),
  framebufferWidth: 400,
  framebufferHeight: 200,
};

function node(id: string, parentId: string | null): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 1, height: 1 },
    visible: true,
    opacity: 1,
  } as MirrorNode;
}

function fixture(tree: readonly [string, string | null][]) {
  const state = createMirrorState();
  for (const [id, parentId] of tree) state.nodes.set(id, node(id, parentId));
  state.orderedIds = tree.map(([id]) => id);
  const order = buildPaintOrder(state);
  const list = createDrawList<Texture>();
  const ranges = new Map<string, NodeCommandRange>();
  const texture = { id: "atlas", revision: 1 };
  const quad = createQuadView();
  quad.w = 8;
  quad.h = 8;
  quad.srcW = 8;
  quad.srcH = 8;
  function paint(id: string, x: number, y = 20, blend: BlendMode = 0, w = 8, h = 8): number {
    quad.m.set([1, 0, 0, 1, x, y]);
    quad.blend = blend;
    quad.w = quad.srcW = w;
    quad.h = quad.srcH = h;
    const start = list.count;
    list.pushQuad(quad, texture);
    ranges.set(id, { start, paintEnd: list.count });
    return start;
  }
  function build(over: Partial<DrawListBuild> = {}): DrawListBuild {
    return {
      order,
      ranges,
      clipRanges: new Map(),
      fxQuadIds: new Set(),
      spineQuadIds: new Set(),
      trailQuadIds: new Set(),
      ...over,
    } as DrawListBuild;
  }
  return { list, ranges, paint, build };
}

describe("retained subtree candidate planning", () => {
  it("derives one interval from PaintOrder ownership and includes commands inserted inside a node range", () => {
    const f = fixture([
      ["root", null],
      ...Array.from({ length: 8 }, (_, i) => [`leaf-${i}`, "root"] as [string, string]),
    ]);
    for (let i = 0; i < 8; i++) f.paint(`leaf-${i}`, 20 + i * 10);
    const insertedAt = f.list.count;
    const q = createQuadView();
    q.m.set([1, 0, 0, 1, 105, 20]);
    q.w = q.h = q.srcW = q.srcH = 8;
    f.list.pushQuad(q, { id: "runtime", revision: 1 });
    const last = f.ranges.get("leaf-7")!;
    f.ranges.set("leaf-7", { start: last.start, paintEnd: f.list.count });

    const plan = planRetainedSubtreeCandidates(f.build(), f.list, projection);

    expect(insertedAt).toBe(8);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      key: "root",
      start: 0,
      end: 9,
      commandCount: 9,
      texturedPrimitives: 9,
    });
    expect(plan.candidates[0].pixelArea).toBeGreaterThan(0);
  });

  it("rejects an interval with external paint interleaving", () => {
    const f = fixture([
      ["root", null],
      ...Array.from({ length: 8 }, (_, i) => [`leaf-${i}`, "root"] as [string, string]),
    ]);
    for (let i = 0; i < 4; i++) f.paint(`leaf-${i}`, 20 + i * 10);
    const q = createQuadView();
    q.w = q.h = q.srcW = q.srcH = 8;
    f.list.pushQuad(q, { id: "unowned", revision: 1 });
    for (let i = 4; i < 8; i++) f.paint(`leaf-${i}`, 20 + i * 10);

    const plan = planRetainedSubtreeCandidates(f.build(), f.list, projection);

    expect(plan.candidates).toEqual([]);
    expect(plan.rejected.interleaved).toBeGreaterThan(0);
  });

  it("rejects unsafe blends and dynamic effect/spine/trail ownership", () => {
    const blended = fixture([
      ["root", null],
      ...Array.from({ length: 8 }, (_, i) => [`leaf-${i}`, "root"] as [string, string]),
    ]);
    for (let i = 0; i < 8; i++) blended.paint(`leaf-${i}`, 20 + i * 10, 20, i === 4 ? BLEND_ADD : 0);
    const blendPlan = planRetainedSubtreeCandidates(blended.build(), blended.list, projection);
    expect(blendPlan.candidates).toEqual([]);
    expect(blendPlan.rejected.unsafeBlend).toBeGreaterThan(0);

    const dynamic = fixture([
      ["root", null],
      ...Array.from({ length: 8 }, (_, i) => [`leaf-${i}`, "root"] as [string, string]),
    ]);
    for (let i = 0; i < 8; i++) dynamic.paint(`leaf-${i}`, 20 + i * 10);
    const dynamicPlan = planRetainedSubtreeCandidates(
      dynamic.build({ fxQuadIds: new Set(["leaf-3"]) }),
      dynamic.list,
      projection,
    );
    expect(dynamicPlan.candidates).toEqual([]);
    expect(dynamicPlan.rejected.dynamicSurface).toBeGreaterThan(0);
  });

  it("prices the full unclipped offstage width before applying the dimension limit", () => {
    const f = fixture([
      ["root", null],
      ...Array.from({ length: 8 }, (_, i) => [`leaf-${i}`, "root"] as [string, string]),
    ]);
    for (let i = 0; i < 8; i++) f.paint(`leaf-${i}`, -800 + i * 157);

    const plan = planRetainedSubtreeCandidates(f.build(), f.list, projection);

    expect(plan.candidates).toEqual([]);
    expect(plan.rejected.dimension).toBeGreaterThan(0);
    expect(plan.rejected.emptyPixels).toBe(0);
  });

  it("prices the full unclipped offstage area before applying the stage-area limit", () => {
    const f = fixture([
      ["root", null],
      ...Array.from({ length: 8 }, (_, i) => [`leaf-${i}`, "root"] as [string, string]),
    ]);
    for (let i = 0; i < 8; i++) f.paint(`leaf-${i}`, -700 + i * 124, 20, 0, 30, 30);

    const plan = planRetainedSubtreeCandidates(f.build(), f.list, projection);

    expect(plan.candidates).toEqual([]);
    expect(plan.rejected.entryArea).toBeGreaterThan(0);
    expect(plan.rejected.dimension).toBe(0);
  });

  it("ranks non-overlapping descendants without double-caching their parent", () => {
    const tree: [string, string | null][] = [["root", null], ["left", "root"]];
    for (let i = 0; i < 8; i++) tree.push([`left-${i}`, "left"]);
    tree.push(["right", "root"]);
    for (let i = 0; i < 8; i++) tree.push([`right-${i}`, "right"]);
    const f = fixture(tree);
    for (let i = 0; i < 8; i++) f.paint(`left-${i}`, 20 + i * 5);
    for (let i = 0; i < 8; i++) f.paint(`right-${i}`, 220 + i * 5);

    const plan = planRetainedSubtreeCandidates(f.build(), f.list, projection);

    expect(plan.candidates.map((candidate) => candidate.key)).toEqual(["left", "right"]);
    expect(plan.candidates.every((candidate) => candidate.start < candidate.end)).toBe(true);
    expect(plan.candidates[0].end).toBeLessThanOrEqual(plan.candidates[1].start);
    expect(plan.rejected.overlap).toBeGreaterThan(0);
    expect(f.list.kindAt(plan.candidates[0].start)).toBe(DRAW_QUAD);
  });
});
