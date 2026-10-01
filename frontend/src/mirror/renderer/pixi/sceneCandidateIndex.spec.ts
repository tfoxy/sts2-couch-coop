import { describe, expect, it } from "vitest";

import { createSceneCandidateIndex, type SceneCandidateIndex } from "./sceneCandidateIndex";
import { applySceneDelta, createMirrorState, nodeTypeLeaf, parseSceneDelta, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

function node(id: string, parentId: string | null, nodeType: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, parentId, name: id, nodeType, visible: true, ...over };
}

function apply(state: MirrorState, upserts: Array<Record<string, unknown>>, removedIds: string[] = [], full = false): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full, screenType: "combat", upserts, removedIds })!);
}

/** By-leaf-type classifier — the same shape `createPixiMirrorRenderer.ts` uses for reward focus. */
const byType = (node: MirrorNode): readonly string[] => [nodeTypeLeaf(node.nodeType)];

/** Full scan, independent of the index, the ground truth every assertion below checks the index against. */
function fullScanIds(state: MirrorState, bucket: string): Set<string> {
  const out = new Set<string>();
  for (const n of state.nodes.values()) if (nodeTypeLeaf(n.nodeType) === bucket) out.add(n.id);
  return out;
}

/** Drains `state.changedIds`/`sceneRewrite` into `index` the way `reconcile()` does — invalidateAll on a rewrite,
 *  then noteChanged with whatever accumulated — and clears them after, like the renderer does once presented. */
function sync(state: MirrorState, index: SceneCandidateIndex): void {
  if (state.sceneRewrite) index.invalidateAll();
  index.noteChanged(state.nodes, state.changedIds);
  state.changedIds.clear();
  state.sceneRewrite = false;
}

describe("createSceneCandidateIndex", () => {
  it("is empty before any noteChanged", () => {
    const index = createSceneCandidateIndex(byType);
    expect(index.idsIn("NRewardsScreen")).toEqual(new Set());
  });

  it("does one full rebuild from a keyframe, then tracks hit and miss ids", () => {
    const state = createMirrorState();
    apply(state, [
      node("screen", null, "NRewardsScreen"),
      node("rowA", "screen", "NRewardButton"),
      node("rowB", "screen", "NRewardButton"),
      node("label", "rowA", "Label"),
    ], [], true);
    const index = createSceneCandidateIndex(byType);
    sync(state, index);

    expect(index.idsIn("NRewardsScreen")).toEqual(new Set(["screen"]));
    expect(index.idsIn("NRewardButton")).toEqual(new Set(["rowA", "rowB"]));
    // A miss: a type nothing matches reads as the shared empty set, not an error.
    expect(index.idsIn("NHandCardHolder")).toEqual(new Set());
    // A plain Label is a miss for every bucket the test cares about — never a false candidate.
    expect(index.idsIn("NRewardButton").has("label")).toBe(false);
  });

  it("adds a newly-upserted id to its bucket from changedIds alone, without rescanning the rest", () => {
    const state = createMirrorState();
    apply(state, [node("screen", null, "NRewardsScreen")], [], true);
    const index = createSceneCandidateIndex(byType);
    sync(state, index);

    apply(state, [node("rowA", "screen", "NRewardButton")]);
    sync(state, index);
    expect(index.idsIn("NRewardButton")).toEqual(new Set(["rowA"]));
    expect(index.idsIn("NRewardsScreen")).toEqual(new Set(["screen"])); // untouched bucket survives
  });

  it("drops a removed id from its bucket", () => {
    const state = createMirrorState();
    apply(state, [node("screen", null, "NRewardsScreen"), node("rowA", "screen", "NRewardButton")], [], true);
    const index = createSceneCandidateIndex(byType);
    sync(state, index);

    apply(state, [], ["rowA"]);
    sync(state, index);
    expect(index.idsIn("NRewardButton")).toEqual(new Set());
  });

  it("moves a reclassified id to its new bucket and out of the old one", () => {
    const state = createMirrorState();
    apply(state, [node("x", null, "NRewardButton")], [], true);
    const index = createSceneCandidateIndex(byType);
    sync(state, index);
    expect(index.idsIn("NRewardButton")).toEqual(new Set(["x"]));

    apply(state, [node("x", null, "Label")]);
    sync(state, index);
    expect(index.idsIn("NRewardButton")).toEqual(new Set());
    expect(index.idsIn("Label")).toEqual(new Set(["x"]));
  });

  it("keeps bucket membership across a reparent — the classifier never reads parentId", () => {
    const state = createMirrorState();
    apply(state, [node("a", null, "NRewardsScreen"), node("b", null, "NRewardsScreen"), node("x", "a", "NRewardButton")], [], true);
    const index = createSceneCandidateIndex(byType);
    sync(state, index);

    apply(state, [node("x", "b", "NRewardButton")]);
    sync(state, index);
    expect(index.idsIn("NRewardButton")).toEqual(new Set(["x"]));
  });

  it("rebuilds everything on invalidateAll, discarding stale entries a dirty pass never revisits", () => {
    const state = createMirrorState();
    apply(state, [node("screen", null, "NRewardsScreen")], [], true);
    const index = createSceneCandidateIndex(byType);
    sync(state, index);

    index.invalidateAll();
    // A second keyframe replaces the whole map; the stale "screen" id must not survive into the rebuild.
    apply(state, [node("other", null, "NRewardsScreen")], [], true);
    sync(state, index);
    expect(index.idsIn("NRewardsScreen")).toEqual(new Set(["other"]));
  });

  it("matches a full scan through a randomized delta sequence (add/remove/retype/reparent/keyframe)", () => {
    let seed = 0x5eed1;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    const TYPES = ["NRewardsScreen", "NRewardButton", "Label", "Control"];
    let serial = 0;

    const state = createMirrorState();
    const index = createSceneCandidateIndex(byType);
    apply(state, [node("root", null, "Control")], [], true);
    sync(state, index);

    for (let step = 0; step < 400; step++) {
      const ids = [...state.nodes.keys()];
      const roll = rand();
      if (roll < 0.3) {
        const id = `n${serial++}`;
        apply(state, [node(id, pick(ids), pick(TYPES))]);
      } else if (roll < 0.45 && ids.length > 1) {
        const id = pick(ids.filter((i) => i !== "root"));
        if (id) apply(state, [], [id]);
      } else if (roll < 0.6 && ids.length > 0) {
        // retype in place — same id, a different leaf type
        const id = pick(ids);
        apply(state, [node(id, state.nodes.get(id)!.parentId, pick(TYPES))]);
      } else if (roll < 0.75 && ids.length > 1) {
        // reparent — must never change bucket membership for a type-only classifier
        const id = pick(ids.filter((i) => i !== "root"));
        const target = pick(ids.filter((i) => i !== id));
        if (id) apply(state, [node(id, target, state.nodes.get(id)!.nodeType)]);
      } else if (roll < 0.85) {
        apply(state, [node("root", null, "Control"), ...ids.filter((i) => i !== "root")
          .map((i) => node(i, "root", state.nodes.get(i)!.nodeType))], [], true);
      } else {
        index.invalidateAll();
      }
      sync(state, index);
      for (const type of TYPES) expect(index.idsIn(type)).toEqual(fullScanIds(state, type));
    }
  });
});
