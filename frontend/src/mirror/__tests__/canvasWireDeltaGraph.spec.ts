import { describe, expect, it } from "vitest";

import { createDrawList, createNinePatchView, createQuadView } from "@godot-scene-web/canvas";
import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import { applyOpacityPlan, applySourcePlan, createPatchScratch, patchOpacity, planOpacity, planSource, type PatchEnv, type PatchOutcome, type SourcePatchTarget } from "@/mirror/canvas/listPatch";
import { captureWireDeltaGraph, commitWireDelta, createWireDeltaScratch, planWireDelta } from "@/mirror/canvas/wireDeltaGraph";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

function node(id: string, parentId: string | null = null, over: Record<string, unknown> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.TextureRect",
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: 1,
    textureUrl: "atlas-a.png",
    textureRegion: { x: 0, y: 0, width: 20, height: 20 },
    ...over
  } as MirrorNode;
}

function state(nodes: MirrorNode[]): MirrorState {
  const result = createMirrorState();
  for (const item of nodes) result.nodes.set(item.id, item);
  result.orderedIds = nodes.map((item) => item.id);
  return result;
}

describe("canvas wire-delta graph", () => {
  it("admits a coalesced source/UV + opacity delta without visiting unchanged siblings", () => {
    const first = state([node("root"), node("card", "root"), node("unchanged", "root")]);
    const graph = captureWireDeltaGraph(first, new Map([["card", { start: 4, paintEnd: 5 }]]));
    const next = state([
      node("root"),
      node("card", "root", {
        opacity: 0.5,
        textureUrl: "atlas-b.png",
        textureRegion: { x: 40, y: 0, width: 20, height: 20 }
      }),
      node("unchanged", "root")
    ]);
    // Preserve the wire's order identity: ordinary deltas mutate nodes but do
    // not replace orderedIds.
    next.orderedIds = first.orderedIds;
    next.changedIds.add("card");

    expect(planWireDelta(graph, next, next.changedIds, false, createWireDeltaScratch())).toMatchObject({
      mode: "direct",
      sourceIds: ["card"],
      opacityIds: ["card"],
      nodesVisited: 1
    });
  });

  it("commits only admitted snapshots, so the next delta remains O(changedIds)", () => {
    const first = state([node("a"), node("b")]);
    const graph = captureWireDeltaGraph(first, new Map([["a", { start: 0, paintEnd: 1 }]]));
    const next = state([node("a", null, { opacity: 0.5 }), node("b")]);
    next.orderedIds = first.orderedIds;
    next.changedIds.add("a");
    const scratch = createWireDeltaScratch();
    const plan = planWireDelta(graph, next, next.changedIds, false, scratch);
    expect(plan.mode).toBe("direct");
    commitWireDelta(graph, next, ["a"], scratch);

    next.changedIds.clear();
    next.nodes.set("a", node("a", null, { opacity: 0.25 }));
    next.changedIds.add("a");
    expect(planWireDelta(graph, next, next.changedIds, false, scratch)).toMatchObject({
      mode: "direct",
      opacityIds: ["a"],
      nodesVisited: 1
    });
  });

  it("retains node references and reuses caller-owned plan buffers", () => {
    const first = state([node("card")]);
    const graph = captureWireDeltaGraph(first, new Map());
    const scratch = createWireDeltaScratch();
    expect(graph.nodes.get("card")!.node).toBe(first.nodes.get("card"));
    const next = state([node("card", null, { opacity: 0.5 })]);
    next.orderedIds = first.orderedIds;
    next.changedIds.add("card");
    const one = planWireDelta(graph, next, next.changedIds, false, scratch);
    const sourceIds = scratch.sourceIds;
    const opacityIds = scratch.opacityIds;
    const changedIds = scratch.changedIds;
    commitWireDelta(graph, next, one.mode === "direct" ? one.changedIds : [], scratch);
    next.nodes.set("card", node("card", null, { opacity: 0.25 }));
    const two = planWireDelta(graph, next, next.changedIds, false, scratch);
    expect(two.mode).toBe("direct");
    expect(two.mode === "direct" && two.sourceIds).toBe(sourceIds);
    expect(two.mode === "direct" && two.opacityIds).toBe(opacityIds);
    expect(two.mode === "direct" && two.changedIds).toBe(changedIds);
    expect(two).toBe(one);
  });

  it("admits fresh normalized values from a parsed volatile upsert, including alpha-only colors", () => {
    const raw = (item: MirrorNode) => ({
      type: "scene-delta", full: false, screenType: "combat", upserts: [item], removedIds: [], orderedIds: null, hints: [], cardFlights: []
    });
    const original = node("card", null, {
      localRect: { x: 0, y: 0, width: 40, height: 30 },
      rect: { x: 0, y: 0, width: 40, height: 30 },
      fillColor: { r: 0.8, g: 0.5, b: 0.2, a: 1, html: "#cc8033ff" },
      text: { value: "same", horizontalAlignment: 0, verticalAlignment: 0 },
      shaderParams: [{ name: "same", kind: "number", number: 1 }],
      modulate: { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" }
    });
    const live = createMirrorState();
    applySceneDelta(live, { ...parseSceneDelta({ ...raw(original), full: true, orderedIds: ["card"] })!, full: true });
    live.changedIds.clear();
    live.sceneRewrite = false;
    const graph = captureWireDeltaGraph(live, new Map());
    const volatile = node("card", null, {
      name: "",
      localRect: { x: 0, y: 0, width: 40, height: 30 },
      rect: { x: 0, y: 0, width: 40, height: 30 },
      fillColor: { r: 0.8, g: 0.5, b: 0.2, a: 1, html: "#cc8033ff" },
      text: { value: "same", horizontalAlignment: 0, verticalAlignment: 0 },
      shaderParams: [{ name: "same", kind: "number", number: 1 }],
      modulate: { r: 1, g: 1, b: 1, a: 0.5, html: "#ffffff80" }
    });
    applySceneDelta(live, parseSceneDelta(raw(volatile))!);
    const plan = planWireDelta(graph, live, live.changedIds, false, createWireDeltaScratch());
    expect(plan).toMatchObject({ mode: "direct", opacityIds: ["card"], nodesVisited: 1 });
  });

  it("treats authoritative focus changes as a known volatile field that needs a full content walk", () => {
    const first = state([node("reward", null, { focused: false })]);
    const graph = captureWireDeltaGraph(first, new Map());
    const next = state([node("reward", null, { focused: true })]);
    next.orderedIds = first.orderedIds;
    next.changedIds.add("reward");

    expect(planWireDelta(graph, next, next.changedIds, false, createWireDeltaScratch())).toMatchObject({
      mode: "full",
      cause: "content",
      nodesVisited: 1
    });
  });

  it("matches a forced full list build for an admitted opacity delta, including hits and animation metadata", () => {
    const first = state([
      node("card", null, {
        localRect: { x: 0, y: 0, width: 40, height: 30 },
        fillColor: { r: 0.8, g: 0.5, b: 0.2, a: 1, html: "#cc8033" },
        mouseFilter: 0
      })
    ]);
    const patchedList = createDrawList<string>();
    const initial = buildDrawList(first, patchedList, { assert: true });
    const graph = captureWireDeltaGraph(first, initial.ranges);
    const next = state([
      node("card", null, {
        localRect: { x: 0, y: 0, width: 40, height: 30 },
        fillColor: { r: 0.8, g: 0.5, b: 0.2, a: 1, html: "#cc8033" },
        mouseFilter: 0,
        opacity: 0.5
      })
    ]);
    next.orderedIds = first.orderedIds;
    next.changedIds.add("card");
    const plan = planWireDelta(graph, next, next.changedIds, false, createWireDeltaScratch());
    expect(plan).toMatchObject({ mode: "direct", opacityIds: ["card"] });

    const old = graph.nodes.get("card")!;
    const env: PatchEnv = {
      nodeOf: (id) => next.nodes.get(id),
      childrenOf: () => [],
      rangeOf: (id) => initial.ranges.get(id),
      appliedAlphaOf: (id) => (id === "card" ? old : undefined),
      currentAlphaOf: () => undefined
    };
    const outcome: PatchOutcome = { patched: false, bail: null, quads: 0, nodes: 0, visited: 0 };
    patchOpacity(new Set(plan.mode === "direct" ? plan.opacityIds : []), env, patchedList, createPatchScratch(createQuadView(), createNinePatchView()), outcome);
    expect(outcome).toMatchObject({ patched: true });

    const forcedList = createDrawList<string>();
    const forced = buildDrawList(next, forcedList, { assert: true });
    const quad = createQuadView();
    const forcedQuad = createQuadView();
    expect(patchedList.count).toBe(forcedList.count);
    for (let index = 0; index < patchedList.count; index++) {
      expect(patchedList.kindNameAt(index)).toBe(forcedList.kindNameAt(index));
      if (patchedList.kindNameAt(index) === "quad") {
        expect(patchedList.readQuad(index, quad)).toMatchObject(forcedList.readQuad(index, forcedQuad));
      }
    }
    expect(initial.hitEntries).toEqual(forced.hitEntries);
    expect(initial.localAnimFrames).toEqual(forced.localAnimFrames);
  });

  it("validates then atomically combines source and opacity", () => {
    const first = state([node("card", null, {
      localRect: { x: 0, y: 0, width: 40, height: 30 },
      mouseFilter: 0
    })]);
    const list = createDrawList<string>();
    const initial = buildDrawList(first, list, { assert: true });
    const graph = captureWireDeltaGraph(first, initial.ranges);
    const next = state([node("card", null, {
      localRect: { x: 0, y: 0, width: 40, height: 30 },
      mouseFilter: 0,
      opacity: 0.5,
      textureUrl: "atlas-b.png",
      textureRegion: { x: 20, y: 0, width: 20, height: 20 }
    })]);
    next.orderedIds = first.orderedIds;
    next.changedIds.add("card");
    const plan = planWireDelta(graph, next, next.changedIds, false, createWireDeltaScratch());
    expect(plan).toMatchObject({ mode: "direct", sourceIds: ["card"], opacityIds: ["card"] });
    const patchScratch = createPatchScratch(createQuadView(), createNinePatchView());
    const sourceOutcome: PatchOutcome = { patched: false, bail: null, quads: 0, nodes: 0, visited: 0 };
    const opacityOutcome: PatchOutcome = { patched: false, bail: null, quads: 0, nodes: 0, visited: 0 };
    const old = graph.nodes.get("card")!;
    const env: PatchEnv = {
      nodeOf: (id) => next.nodes.get(id),
      childrenOf: () => [],
      rangeOf: (id) => initial.ranges.get(id),
      appliedAlphaOf: (id) => id === "card" ? old : undefined,
      currentAlphaOf: () => undefined
    };
    planSource([{ id: "card", range: initial.ranges.get("card")!, texture: "atlas-b.png", srcX: 20, srcY: 0, srcW: 20, srcH: 20 }], list as SourcePatchTarget<string>, patchScratch, sourceOutcome);
    planOpacity(new Set(plan.mode === "direct" ? plan.opacityIds : []), env, list, patchScratch, opacityOutcome);
    expect(sourceOutcome).toMatchObject({ patched: true });
    expect(opacityOutcome).toMatchObject({ patched: true });
    applySourcePlan(list as SourcePatchTarget<string>, patchScratch, sourceOutcome);
    applyOpacityPlan(list, patchScratch, opacityOutcome);
    const forcedList = createDrawList<string>();
    buildDrawList(next, forcedList, { assert: true });
    expect(list.count).toBe(forcedList.count);
    for (let index = 0; index < list.count; index++) {
      expect(list.readQuad(index, createQuadView())).toMatchObject(forcedList.readQuad(index, createQuadView()));
    }
  });

  it("refuses an opacity root with an overlay descendant before writing any command", () => {
    const first = state([
      node("parent", null, { localRect: { x: 0, y: 0, width: 40, height: 30 }, fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#fff" } }),
      node("label", "parent", { nodeType: "Godot.Label", localRect: { x: 0, y: 0, width: 30, height: 10 }, text: "blocked" })
    ]);
    const list = createDrawList<string>();
    const built = buildDrawList(first, list, { assert: true });
    const graph = captureWireDeltaGraph(first, built.ranges);
    const next = state([
      node("parent", null, { localRect: { x: 0, y: 0, width: 40, height: 30 }, fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#fff" }, opacity: 0.5 }),
      node("label", "parent", { nodeType: "Godot.Label", localRect: { x: 0, y: 0, width: 30, height: 10 }, text: "blocked" })
    ]);
    next.orderedIds = first.orderedIds;
    next.changedIds.add("parent");
    const plan = planWireDelta(graph, next, next.changedIds, false, createWireDeltaScratch());
    expect(plan).toMatchObject({ mode: "direct", opacityIds: ["parent"] });
    const before = list.readQuad(0, createQuadView()).a;
    const old = graph.nodes.get("parent")!;
    const env: PatchEnv = {
      nodeOf: (id) => next.nodes.get(id),
      childrenOf: (id) => id === "parent" ? ["label"] : [],
      rangeOf: (id) => built.ranges.get(id),
      appliedAlphaOf: (id) => id === "parent" ? old : undefined,
      currentAlphaOf: () => undefined
    };
    const outcome: PatchOutcome = { patched: false, bail: null, quads: 0, nodes: 0, visited: 0 };
    planOpacity(plan.mode === "direct" ? plan.opacityRoots : new Set(), env, list, createPatchScratch(createQuadView(), createNinePatchView()), outcome);
    expect(outcome).toMatchObject({ patched: false, bail: "overlay" });
    expect(list.readQuad(0, createQuadView()).a).toBe(before);
  });

  it("admits transform separately and fails closed for structural/order and unknown content", () => {
    const first = state([node("parent"), node("child", "parent")]);
    const graph = captureWireDeltaGraph(first, new Map());
    const transformed = state([node("parent", null, { transform: [1, 0, 0, 1, 10, 0] }), node("child", "parent")]);
    transformed.orderedIds = first.orderedIds;
    transformed.changedIds.add("parent");
    expect(planWireDelta(graph, transformed, transformed.changedIds, false, createWireDeltaScratch())).toMatchObject({ mode: "direct", transformIds: ["parent"] });

    const recolored = state([node("parent", null, { fillColor: { r: 1, g: 0, b: 0, a: 1 } }), node("child", "parent")]);
    recolored.orderedIds = first.orderedIds;
    recolored.changedIds.add("parent");
    expect(planWireDelta(graph, recolored, recolored.changedIds, false, createWireDeltaScratch())).toMatchObject({ mode: "full", cause: "content" });

    const reordered = state([node("parent"), node("child", "parent")]);
    reordered.changedIds.add("parent");
    expect(planWireDelta(graph, reordered, reordered.changedIds, true, createWireDeltaScratch())).toMatchObject({ mode: "full", cause: "structural", nodesVisited: 0 });

    const unknown = state([node("parent"), node("child", "parent")]);
    unknown.orderedIds = first.orderedIds;
    unknown.changedIds.add("not-in-graph");
    expect(planWireDelta(graph, unknown, unknown.changedIds, false, createWireDeltaScratch())).toMatchObject({ mode: "full", cause: "unknown", nodesVisited: 1 });
  });
});
