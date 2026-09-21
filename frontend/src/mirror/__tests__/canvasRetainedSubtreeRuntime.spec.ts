import { describe, expect, it, vi } from "vitest";
import {
  compileDrawList,
  createDrawList,
  createQuadView,
  DRAW_QUAD,
  type CanvasTextureHandle,
  type CompiledRefreshResult,
  type DrawList,
  type RetainedRangeCache,
  type RetainedRangeCandidate,
  type RetainedRangeSubstitutionPlan,
  type StageProjection,
} from "@godot-scene-web/canvas";

import type { DrawListBuild, NodeCommandRange } from "@/mirror/canvas/buildDrawList";
import { buildPaintOrder } from "@/mirror/canvas/paintOrder";
import {
  canvasSubtreeCacheEnabled,
  createRetainedSubtreeRuntime,
} from "@/mirror/renderer/canvas/retainedSubtreeRuntime";
import { createMirrorState, type MirrorNode } from "@/mirror/sceneTree";

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

function scene(groups = 1, withColorMatrix = false, patchJournalCapacity = 256) {
  const state = createMirrorState();
  const tree: [string, string | null][] = [["root", null]];
  for (let group = 0; group < groups; group++) {
    tree.push([`group-${group}`, "root"]);
    for (let index = 0; index < 8; index++) tree.push([`leaf-${group}-${index}`, `group-${group}`]);
  }
  for (const [id, parentId] of tree) state.nodes.set(id, node(id, parentId));
  state.orderedIds = tree.map(([id]) => id);
  const order = buildPaintOrder(state);
  const list = createDrawList<CanvasTextureHandle | null>({ patchJournalCapacity });
  const ranges = new Map<string, NodeCommandRange>();
  const texture: CanvasTextureHandle = { texture: {} as WebGLTexture, width: 8, height: 8, revision: 1 };
  const quad = createQuadView();
  quad.w = quad.h = quad.srcW = quad.srcH = 8;
  quad.hasColorMatrix = withColorMatrix;
  for (let group = 0; group < groups; group++) {
    for (let index = 0; index < 8; index++) {
      quad.m.set([1, 0, 0, 1, 20 + group * 180 + index * 5, 20]);
      const start = list.pushQuad(quad, texture);
      ranges.set(`leaf-${group}-${index}`, { start, paintEnd: start + 1 });
    }
  }
  const build = {
    order,
    ranges,
    clipRanges: new Map(),
    fxQuadIds: new Set(),
    spineQuadIds: new Set(),
    trailQuadIds: new Set(),
  } as unknown as DrawListBuild;
  return { list, build, state, texture };
}

function clippedScene() {
  const state = createMirrorState();
  const tree: [string, string | null][] = [["root", null], ["group", "root"]];
  for (let index = 0; index < 8; index++) tree.push([`leaf-${index}`, "group"]);
  for (const [id, parentId] of tree) state.nodes.set(id, node(id, parentId));
  state.orderedIds = tree.map(([id]) => id);
  const order = buildPaintOrder(state);
  const list = createDrawList<CanvasTextureHandle | null>();
  const texture: CanvasTextureHandle = { texture: {} as WebGLTexture, width: 8, height: 8, revision: 1 };
  const ranges = new Map<string, NodeCommandRange>();
  const push = list.pushClipRect({ x: 0, y: 0, w: 100, h: 100, cornerRadius: 0, outsetX: 0 });
  const quad = createQuadView();
  quad.w = quad.h = quad.srcW = quad.srcH = 8;
  for (let index = 0; index < 8; index++) {
    quad.m.set([1, 0, 0, 1, 20 + index * 5, 20]);
    const start = list.pushQuad(quad, texture);
    ranges.set(`leaf-${index}`, { start, paintEnd: start + 1 });
  }
  const pop = list.popClip();
  const build = {
    order,
    ranges,
    clipRanges: new Map([["group", { push, pop }]]),
    fxQuadIds: new Set(),
    spineQuadIds: new Set(),
    trailQuadIds: new Set(),
  } as unknown as DrawListBuild;
  return { list, build };
}

function refresh(changedCommands: readonly number[]): CompiledRefreshResult {
  return {
    rebuilt: false,
    rangeUpdates: changedCommands.length,
    changedCommands,
    planGeneration: 1,
    contentRevision: 1,
    deltaBaseRevision: 0,
  };
}

function fakeCache() {
  const prepared: RetainedRangeCandidate[][] = [];
  const invalidated: [string, string | undefined][] = [];
  const invalidatedAll: (string | undefined)[] = [];
  const plan = {} as RetainedRangeSubstitutionPlan;
  const cache = {
    gl: {} as WebGL2RenderingContext,
    stats: {
      plans: 0, planFallbacks: 0, realHits: 0, composites: 0, rebuilds: 0,
      rasterPixels: 0, compositePixels: 0, entries: 0, backings: 0, bytes: 0,
      peakBytes: 0, allocations: 0, deletes: 0, evictions: 0, contextRebuilds: 0,
      rebuildReasons: {}, fallbackReasons: {},
    },
    prepare: vi.fn((_list, _projection, candidates) => {
      prepared.push(candidates.map((candidate: RetainedRangeCandidate) => ({
        ...candidate,
        bounds: { ...candidate.bounds },
      })));
      return plan;
    }),
    invalidate: vi.fn((key: string, reason?: string) => { invalidated.push([key, reason]); }),
    invalidateAll: vi.fn((reason?: string) => { invalidatedAll.push(reason); }),
    clear: vi.fn(),
    invalidateContext: vi.fn(),
    dispose: vi.fn(),
  } as unknown as RetainedRangeCache;
  return { cache, prepared, invalidated, invalidatedAll, plan };
}

function translate(list: DrawList<CanvasTextureHandle | null>, start: number, end: number, dx: number): number[] {
  const changed: number[] = [];
  const view = createQuadView();
  for (let index = start; index < end; index++) {
    if (list.kindAt(index) !== DRAW_QUAD) continue;
    list.readQuad(index, view);
    view.m[4] += dx;
    list.patchQuadTransform(index, view.m);
    changed.push(index);
  }
  return changed;
}

describe("retained subtree runtime", () => {
  it("keeps the selector opt-in and recognizes only the explicit on value", () => {
    expect(canvasSubtreeCacheEnabled("")).toBe(false);
    expect(canvasSubtreeCacheEnabled("?canvasSubtreeCache=off")).toBe(false);
    expect(canvasSubtreeCacheEnabled("?canvasSubtreeCache=1")).toBe(false);
    expect(canvasSubtreeCacheEnabled("?canvasSubtreeCache=on")).toBe(true);
  });

  it("invalidates only the candidate whose content command changed", () => {
    const { list, build } = scene(2);
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, refresh([]));
    const first = f.prepared.at(-1)!;
    expect(first.map((candidate) => candidate.key)).toEqual(["group-0", "group-1"]);

    list.patchQuadColor(0, 0.5, 0.5, 0.5, 0.5);
    runtime.prepare(list, projection, refresh([0]));
    const second = f.prepared.at(-1)!;
    expect(second.find((candidate) => candidate.key === "group-0")?.pixelRevision).toBe(1);
    expect(second.find((candidate) => candidate.key === "group-1")?.pixelRevision).toBe(0);
    expect(runtime.stats.contentInvalidations).toBe(1);
  });

  it("re-fingerprints a candidate after a patch-journal overflow rebuild", () => {
    const { list, build } = scene(1, false, 2);
    const compiled = compileDrawList(list);
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, compiled.refresh());

    list.patchQuadColor(0, 0.9, 0.8, 0.7, 0.6);
    list.patchQuadColor(1, 0.8, 0.7, 0.6, 0.5);
    list.patchQuadColor(2, 0.7, 0.6, 0.5, 0.4);
    const overflow = compiled.refresh();
    expect(overflow).toMatchObject({ rebuilt: true, changedCommands: [] });

    runtime.prepare(list, projection, overflow);
    expect(f.prepared.at(-1)![0].pixelRevision).toBe(1);
    expect(runtime.stats.contentInvalidations).toBe(1);
  });

  it("preserves unrelated entries after a patch-journal overflow rebuild", () => {
    const { list, build } = scene(3, false, 2);
    (build.fxQuadIds as Set<string>).add("group-2");
    const compiled = compileDrawList(list);
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, compiled.refresh());
    expect(f.prepared.at(-1)!.map((candidate) => candidate.key)).toEqual(["group-0", "group-1"]);

    for (let index = 16; index < 19; index++) list.patchQuadColor(index, 0.5, 0.5, 0.5, 0.5);
    const overflow = compiled.refresh();
    expect(overflow).toMatchObject({ rebuilt: true, changedCommands: [] });
    runtime.prepare(list, projection, overflow);

    expect(f.prepared.at(-1)!.map((candidate) => candidate.pixelRevision)).toEqual([0, 0]);
    expect(runtime.stats.contentInvalidations).toBe(0);
  });

  it("invalidates a per-command texture rebind that preserves the dependency set", () => {
    const { list, build, texture: a } = scene();
    const b: CanvasTextureHandle = { texture: {} as WebGLTexture, width: 8, height: 8, revision: 1 };
    list.patchQuadSource(1, b, 0, 0, 8, 8);
    list.patchQuadSource(2, b, 0, 0, 8, 8);
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, refresh([]));

    // [A,B,B] -> [A,A,B] keeps the dependency set {A,B}, but changes pixels.
    list.patchQuadSource(1, a, 0, 0, 8, 8);
    runtime.prepare(list, projection, refresh([1]));
    expect(f.prepared.at(-1)![0].pixelRevision).toBe(1);
    expect(runtime.stats.contentInvalidations).toBe(1);
  });

  it("treats a rebuilt color-matrix side-arena value as pixel content", () => {
    const { list, build } = scene(1, true);
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, refresh([]));

    const matrix = list.colorMatrixIndexAt(0);
    expect(matrix).toBeGreaterThanOrEqual(0);
    list.colorMatrices[matrix * 9] = 0.5;
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, refresh([]));

    expect(f.prepared.at(-1)![0].pixelRevision).toBe(1);
    expect(runtime.stats.contentInvalidations).toBe(1);
  });

  it("invalidates an unchanged-payload interval when structural paint ownership reorders", () => {
    const { list, build, state } = scene();
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);

    const first = state.orderedIds.indexOf("leaf-0-0");
    const reordered = [...state.orderedIds];
    [reordered[first], reordered[first + 1]] = [reordered[first + 1], reordered[first]];
    state.orderedIds = reordered;
    const nextBuild = { ...build, order: buildPaintOrder(state) } as DrawListBuild;
    runtime.planBuild(nextBuild, list, projection);

    expect(f.invalidated.at(-1)).toEqual(["root", "topology"]);
    expect(runtime.candidatePlan?.candidates[0].pixelRevision).toBe(1);
  });

  it("invalidates a reparented subtree even when ids, command range, order, and payload stay unchanged", () => {
    const { list, build, state } = scene();
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, refresh([]));
    const before = runtime.candidatePlan!.candidates[0];

    const moved = state.nodes.get("leaf-0-1")!;
    state.nodes.set(moved.id, { ...moved, parentId: "leaf-0-0" });
    const nextOrder = buildPaintOrder(state);
    expect(nextOrder.ids).toEqual(build.order.ids);
    const reparented = { ...build, order: nextOrder } as DrawListBuild;
    runtime.planBuild(reparented, list, projection);
    const after = runtime.candidatePlan!.candidates[0];

    expect(after).toMatchObject({
      key: before.key,
      start: before.start,
      end: before.end,
      ownerOrder: before.ownerOrder,
      bounds: before.bounds,
      pixelRevision: before.pixelRevision + 1,
    });
    expect(after.ownershipKey).not.toBe(before.ownershipKey);
    expect(f.invalidated.at(-1)).toEqual([before.key, "topology"]);
  });

  it("reuses a uniform whole-device-pixel translation without advancing pixel identity", () => {
    const { list, build } = scene();
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, refresh([]));
    const before = f.prepared.at(-1)![0];

    const changed = translate(list, before.start, before.end, 1);
    runtime.prepare(list, projection, refresh(changed));
    const after = f.prepared.at(-1)![0];

    expect(after.pixelRevision).toBe(before.pixelRevision);
    expect(after.bounds.x).toBe(before.bounds.x + 1);
    expect(runtime.stats.translationReuses).toBe(1);
    expect(f.invalidated).toEqual([]);
  });

  it("reuses an integer translation across the stage edge using the full unclipped footprint", () => {
    const { list, build } = scene();
    translate(list, 0, list.count, -50);
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, refresh([]));
    const before = f.prepared.at(-1)![0];
    expect(before.bounds.x).toBeLessThan(0);

    runtime.prepare(list, projection, refresh(translate(list, before.start, before.end, 1)));
    const after = f.prepared.at(-1)![0];
    expect(after.pixelRevision).toBe(before.pixelRevision);
    expect(after.bounds.x).toBe(before.bounds.x + 1);
    expect(f.invalidated).toEqual([]);
  });

  it("falls back when paint translates beneath a stationary internal clip", () => {
    const { list, build } = clippedScene();
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, refresh([]));
    const candidate = f.prepared.at(-1)![0];

    const changed = translate(list, candidate.start, candidate.end, 1);
    expect(runtime.prepare(list, projection, refresh(changed))).toBeUndefined();
    expect(f.invalidated.at(-1)).toEqual([candidate.key, "transform"]);
    expect(runtime.stats.translationReuses).toBe(0);
  });

  it.each([
    ["fractional translation", (list: DrawList<CanvasTextureHandle | null>, candidate: RetainedRangeCandidate) =>
      translate(list, candidate.start, candidate.end, 0.5)],
    ["scale", (list: DrawList<CanvasTextureHandle | null>, candidate: RetainedRangeCandidate) => {
      const view = createQuadView();
      const changed: number[] = [];
      for (let index = candidate.start; index < candidate.end; index++) {
        list.readQuad(index, view);
        view.m[0] *= 1.1;
        list.patchQuadTransform(index, view.m);
        changed.push(index);
      }
      return changed;
    }],
  ])("falls back live for %s and rebuilds on the following frame", (_name, mutate) => {
    const { list, build } = scene();
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    runtime.planBuild(build, list, projection);
    runtime.prepare(list, projection, refresh([]));
    const candidate = f.prepared.at(-1)![0];

    const changed = mutate(list, candidate);
    expect(runtime.prepare(list, projection, refresh(changed))).toBeUndefined();
    expect(f.invalidated.at(-1)).toEqual([candidate.key, "transform"]);
    expect(runtime.stats.liveFallbacks).toBe(1);

    expect(runtime.prepare(list, projection, refresh([]))).toBe(f.plan);
    expect(f.prepared.at(-1)![0].pixelRevision).toBe(1);
  });

  it("separates resize, dead-context, and live-disposal lifecycle operations", () => {
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    const { list, build } = scene();
    runtime.planBuild(build, list, projection);

    runtime.invalidateAll("resize");
    runtime.contextLost();
    runtime.dispose();

    expect(f.invalidatedAll).toEqual([]);
    expect(f.cache.clear).toHaveBeenCalledWith("resize");
    expect(f.cache.invalidateContext).toHaveBeenCalledOnce();
    expect(f.cache.dispose).toHaveBeenCalledOnce();
    expect(runtime.stats.invalidations).toMatchObject({ resize: 1, context: 1, dispose: 1 });
  });

  it("invalidates retained pixels when the raster projection changes without a backing resize callback", () => {
    const f = fakeCache();
    const runtime = createRetainedSubtreeRuntime({ enabled: true, cache: f.cache });
    const { list, build } = scene();
    runtime.planBuild(build, list, projection);

    const scaled: StageProjection = {
      ...projection,
      toFramebuffer: new Float32Array([1.25, 0, 0, 1.25, 0, 0]),
    };
    runtime.prepare(list, scaled, refresh([]));

    expect(f.invalidatedAll).toEqual([]);
    expect(f.cache.clear).toHaveBeenCalledWith("rasterScale");
    expect(runtime.stats.invalidations.rasterScale).toBe(1);
    expect(f.prepared.at(-1)![0].pixelRevision).toBe(1);
  });
});
