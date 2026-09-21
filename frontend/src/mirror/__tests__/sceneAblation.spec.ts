import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDomMirrorRenderer } from "@/mirror/renderer/dom/createDomMirrorRenderer";
import {
  createSceneAblationRuntime,
  parseSceneAblationConfig,
  type SceneAblationRuntime
} from "@/mirror/sceneAblation";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

const SCENE = "res://diagnostics/screen.tscn";
const TARGET = "res://diagnostics/target.tscn";

function xform(x = 0, y = 0): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } };
}

function rawNode(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: xform(),
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } },
    visible: true,
    fillColor: { r: 0.2, g: 0.3, b: 0.4, a: 1, html: "#334455" },
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], orderedIds: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds })!
  );
}

function structuralDelta(
  state: MirrorState,
  upserts: Record<string, unknown>[],
  orderedIds: string[]
): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts, orderedIds })!
  );
}

function runtime(
  mode: "full" | "exclude" | "include" | "no-groups" | "data-only" | "app-shell",
  over: Record<string, unknown> = {}
): SceneAblationRuntime {
  return createSceneAblationRuntime({
    dev: true,
    requested: { version: 1, mode, ...over },
    target: {}
  });
}

function harness(ablation: SceneAblationRuntime) {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createDomMirrorRenderer(stage, defs, ablation) };
}

function el(stage: HTMLElement, id: string): HTMLElement | null {
  return stage.querySelector(`[data-node-id="${id}"]`);
}

beforeEach(() => {
  document.body.innerHTML = "";
  mirrorSettings.staticBgEnabled = false;
});

afterEach(() => {
  mirrorSettings.staticBgEnabled = true;
});

describe("scene ablation config boundary", () => {
  it("makes malformed requested config visibly invalid and behaviorally inert", () => {
    const result = parseSceneAblationConfig({ version: 1, mode: "exclude", selectedGroups: ["missing"] }, true);
    expect(result.active).toBe(false);
    expect(result.errors).toEqual(["selected group \"missing\" has no selectors"]);
    expect(result.requested).toEqual({ version: 1, mode: "exclude", selectedGroups: ["missing"] });
    expect(result.effective.mode).toBe("full");
  });

  it("does not read or install either diagnostic global in production", () => {
    const target = new Proxy<Record<string, unknown>>({}, {
      get() { throw new Error("production read diagnostic global"); },
      set() { throw new Error("production installed diagnostic global"); }
    });
    const prod = createSceneAblationRuntime({ dev: false, target });
    expect(prod.active).toBe(false);
    expect(prod.effective.mode).toBe("full");
    prod.noteElementCreated("ignored", false);
    expect(prod.receipt().createdElementIds).toEqual([]);
  });

  it("normalizes data-only/app-shell resource switches while preserving the requested receipt", () => {
    const data = runtime("data-only", { prefetch: "normal", effects: "normal" });
    expect(data.rendersScene).toBe(false);
    expect(data.streamsScene).toBe(true);
    expect(data.prefetchEnabled).toBe(false);
    expect(data.effectsStartupEnabled).toBe(false);
    expect(data.receipt().requested).toEqual({ version: 1, mode: "data-only", prefetch: "normal", effects: "normal" });
    expect(data.receipt().effective).toMatchObject({ mode: "data-only", prefetch: "off", effects: "no-startup" });

    const shell = runtime("app-shell");
    expect(shell.rendersScene).toBe(false);
    expect(shell.streamsScene).toBe(false);
  });

  it("reports applied UTF-8 bytes and returned credits without inventing presentation", () => {
    const data = runtime("data-only");
    const raw = '{"type":"scene-delta","label":"é"}';
    data.noteSceneDelta(raw);
    data.noteCreditReturned();
    expect(data.receipt().stream).toEqual({
      appliedRevisions: 1,
      appliedBytes: new TextEncoder().encode(raw).byteLength,
      creditsReturned: 1,
      consumedDirtyIds: 0,
      consumedSceneRewrites: 0,
      droppedHints: 0,
      droppedCardFlights: 0
    });
    expect(data.receipt()).not.toHaveProperty("presentedFrames");
  });

  it("consumes data-only transients after every delta without discarding retained scene state", () => {
    const data = runtime("data-only");
    const state = createMirrorState();
    full(state, [rawNode("screen", null, { sceneFilePath: SCENE })], ["screen"]);
    state.pendingHints.push({} as MirrorState["pendingHints"][number]);
    state.pendingCardFlights.push({} as MirrorState["pendingCardFlights"][number]);

    data.consumeDataOnlyState(state);
    expect(state).toMatchObject({ revision: 1, orderedIds: ["screen"], sceneRewrite: false });
    expect(state.nodes.has("screen")).toBe(true);
    expect(state.changedIds.size).toBe(0);
    expect(state.pendingHints).toHaveLength(0);
    expect(state.pendingCardFlights).toHaveLength(0);

    for (let revision = 2; revision <= 12; revision++) {
      structuralDelta(state, [rawNode(`node-${revision}`, "screen")], ["screen", `node-${revision}`]);
      state.pendingHints.push({} as MirrorState["pendingHints"][number]);
      state.pendingCardFlights.push({} as MirrorState["pendingCardFlights"][number]);
      data.consumeDataOnlyState(state);
      expect(state.changedIds.size).toBe(0);
      expect(state.pendingHints).toHaveLength(0);
      expect(state.pendingCardFlights).toHaveLength(0);
    }

    expect(state.revision).toBe(12);
    expect(state.nodes.has("node-12")).toBe(true);
    expect(data.receipt().stream).toMatchObject({
      consumedDirtyIds: 12,
      consumedSceneRewrites: 1,
      droppedHints: 12,
      droppedCardFlights: 12
    });
    expect(data.receipt()).not.toHaveProperty("presentedFrames");
  });
});

describe("scene ablation at the DOM ownership boundary", () => {
  it("excludes a selected root on the initial build before any descendant element exists", () => {
    const ablation = runtime("exclude", {
      groups: { scenery: [{ sceneFile: TARGET, relativePath: "" }] },
      selectedGroups: ["scenery"]
    });
    const { stage, renderer } = harness(ablation);
    const state = createMirrorState();
    full(state, [
      rawNode("screen", null, { sceneFilePath: SCENE }),
      rawNode("scenery", "screen", { sceneFilePath: TARGET }),
      rawNode("particle", "scenery"),
      rawNode("controls", "screen")
    ], ["screen", "scenery", "particle", "controls"]);

    renderer.reconcile(state);

    expect(el(stage, "screen")).not.toBeNull();
    expect(el(stage, "controls")).not.toBeNull();
    expect(el(stage, "scenery")).toBeNull();
    expect(el(stage, "particle")).toBeNull();
    expect(ablation.receipt()).toMatchObject({
      matchedGroups: ["scenery"],
      matchedIdsByGroup: { scenery: ["scenery"] },
      heldIds: ["scenery"],
      createdSceneElements: 2,
      createdElementIds: ["controls", "screen"],
      createdFullElementIds: ["controls", "screen"]
    });
    renderer.dispose();
    expect(ablation.receipt().createdElementIds).toEqual(["controls", "screen"]);
  });

  it("unions selected groups and never lets held roots into the idle hatchery", () => {
    const ablation = runtime("exclude", {
      groups: {
        a: [{ sceneFile: SCENE, relativePath: "A" }],
        b: [{ sceneFile: SCENE, relativePath: "B" }]
      },
      selectedGroups: ["a", "b"]
    });
    const { stage, renderer } = harness(ablation);
    const state = createMirrorState();
    full(state, [
      rawNode("screen", null, { sceneFilePath: SCENE }),
      rawNode("a", "screen", { name: "A" }),
      rawNode("a-child", "a"),
      rawNode("b", "screen", { name: "B" }),
      rawNode("b-child", "b"),
      rawNode("ordinary-hidden", "screen", { visible: false }),
      rawNode("ordinary-child", "ordinary-hidden")
    ], ["screen", "a", "a-child", "b", "b-child", "ordinary-hidden", "ordinary-child"]);
    renderer.reconcile(state);

    // The ordinary dormant subtree proves the hatch drain ran; selected roots remain allocation-free.
    for (let i = 0; i < 16 && renderer.__drainDormantHatchForTest(0); i++);
    expect(el(stage, "ordinary-hidden")).not.toBeNull();
    expect(el(stage, "a")).toBeNull();
    expect(el(stage, "a-child")).toBeNull();
    expect(el(stage, "b")).toBeNull();
    expect(el(stage, "b-child")).toBeNull();
    expect(ablation.receipt().heldIds).toEqual(["a", "b"]);
    expect(ablation.receipt().createdElementIds).toEqual(["ordinary-child", "ordinary-hidden", "screen"]);
    renderer.dispose();
  });

  it("include-only keeps transform wrappers but allocates no ancestor paint/effect surface", () => {
    const ablation = runtime("include", {
      groups: { selected: [{ sceneFile: TARGET, relativePath: "" }] },
      selectedGroups: ["selected"]
    });
    const { stage, renderer } = harness(ablation);
    const state = createMirrorState();
    full(state, [
      rawNode("screen", null, { sceneFilePath: SCENE, shaderId: "ancestor-shader", textureUrl: "/res/ancestor.png" }),
      rawNode("wrapper", "screen", { shaderId: "wrapper-shader", textureUrl: "/res/wrapper.png", transform: xform(20, 30) }),
      rawNode("selected", "wrapper", { sceneFilePath: TARGET }),
      rawNode("selected-child", "selected"),
      rawNode("other", "screen")
    ], ["screen", "wrapper", "selected", "selected-child", "other"]);
    renderer.reconcile(state);

    for (const id of ["screen", "wrapper"]) {
      const ancestor = el(stage, id)!;
      expect(ancestor).not.toBeNull();
      expect(ancestor.getAttribute("data-paints")).toBeNull();
      expect(ancestor.getAttribute("data-godot-shader-webgl")).toBeNull();
      expect(ancestor.style.backgroundImage).toBe("");
      expect(ancestor.style.backgroundColor).toBe("");
      expect(ancestor.style.pointerEvents).toBe("none");
      expect(ancestor.querySelectorAll(":scope > canvas")).toHaveLength(0);
    }
    expect(el(stage, "wrapper")!.style.transform).not.toBe("");
    expect(el(stage, "selected")).not.toBeNull();
    expect(el(stage, "selected-child")).not.toBeNull();
    expect(el(stage, "other")).toBeNull();
    expect(ablation.receipt()).toMatchObject({
      structuralAncestorIds: ["screen", "wrapper"],
      heldIds: ["other"],
      createdStructuralElements: 2,
      createdSceneElements: 4,
      createdElementIds: ["screen", "selected", "selected-child", "wrapper"],
      createdFullElementIds: ["selected", "selected-child"]
    });
    renderer.dispose();
  });

  it("restores create-only behavior when a structural ancestor becomes included content", () => {
    const ablation = runtime("include", {
      groups: { selected: [{ sceneFile: TARGET, relativePath: "" }] }, selectedGroups: ["selected"]
    });
    const { stage, renderer } = harness(ablation);
    const state = createMirrorState();
    const wrapper = (parentId: string) => rawNode("wrapper", parentId, { nodeType: "NRemoteMouseCursor" });
    full(state, [rawNode("screen", null, { sceneFilePath: SCENE }), wrapper("screen"),
      rawNode("a", "wrapper", { sceneFilePath: TARGET }), rawNode("b", "screen", { sceneFilePath: TARGET })],
    ["screen", "wrapper", "a", "b"]);
    renderer.reconcile(state);
    const structural = el(stage, "wrapper")!;
    expect(structural.style.transition).toBe("");

    structuralDelta(state, [wrapper("b")], ["screen", "b", "wrapper", "a"]);
    renderer.reconcile(state);
    expect(el(stage, "wrapper")).not.toBe(structural);
    expect(el(stage, "wrapper")!.style.transition).toBe("transform 80ms linear");
    expect(ablation.receipt().structuralAncestorIds).not.toContain("wrapper");

    structuralDelta(state, [wrapper("screen")], ["screen", "wrapper", "a", "b"]);
    renderer.reconcile(state);
    expect(el(stage, "wrapper")!.style.transition).toBe("");
    expect(ablation.receipt().structuralAncestorIds).toContain("wrapper");
    // A later structural-only state must not erase the earlier full build from the evidence.
    expect(ablation.receipt().createdFullElementIds).toContain("wrapper");
    renderer.dispose();
  });

  it("recomputes exact relative paths on a reparent delta and releases the old subtree in that walk", () => {
    const ablation = runtime("exclude", {
      groups: { scenery: [{ sceneFile: SCENE, relativePath: "Group" }] },
      selectedGroups: ["scenery"]
    });
    const { stage, renderer } = harness(ablation);
    const state = createMirrorState();
    full(state, [
      rawNode("screen", null, { sceneFilePath: SCENE }),
      rawNode("other", "screen", { name: "Other" }),
      rawNode("group", "other", { name: "Group" }),
      rawNode("child", "group")
    ], ["screen", "other", "group", "child"]);
    renderer.reconcile(state);
    expect(el(stage, "group")).not.toBeNull();
    expect(el(stage, "child")).not.toBeNull();

    structuralDelta(state, [rawNode("group", "screen", { name: "Group" })], ["screen", "other", "group", "child"]);
    renderer.reconcile(state);

    expect(el(stage, "group")).toBeNull();
    expect(el(stage, "child")).toBeNull();
    expect(ablation.receipt().matchedIdsByGroup).toEqual({ scenery: ["group"] });
    expect(ablation.receipt().heldIds).toEqual(["group"]);
    expect(ablation.receipt().createdElementIds).toEqual(["child", "group", "other", "screen"]);
    renderer.dispose();
  });

  it("no-groups still reconciles state and deltas while creating zero scene elements", () => {
    const ablation = runtime("no-groups", { prefetch: "off", effects: "no-startup" });
    const { stage, renderer } = harness(ablation);
    const state = createMirrorState();
    full(state, [rawNode("screen", null, { sceneFilePath: SCENE }), rawNode("child", "screen")], ["screen", "child"]);
    renderer.reconcile(state);
    structuralDelta(state, [rawNode("late", "screen")], ["screen", "child", "late"]);
    renderer.reconcile(state);

    expect(state.revision).toBe(2);
    expect(state.changedIds.size).toBe(0);
    expect(stage.querySelectorAll(".mirror-node")).toHaveLength(0);
    expect(ablation.receipt()).toMatchObject({
      heldIds: ["screen"],
      createdSceneElements: 0,
      createdElementIds: [],
      createdFullElementIds: [],
      effective: { mode: "no-groups", prefetch: "off", effects: "no-startup" }
    });
    expect(renderer.__drainDormantHatchForTest(1000)).toBe(false);
    expect(stage.querySelectorAll(".mirror-node")).toHaveLength(0);
    renderer.dispose();
  });
});
