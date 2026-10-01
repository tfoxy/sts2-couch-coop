import { describe, expect, it } from "vitest";

import { rewardFocusSnapshotFromScene } from "@/mirror/rewardFocusSnapshot";
import type { InteractiveRect } from "@/mirror/renderer/contracts";
import { applySceneDelta, createMirrorState, parseSceneDelta } from "@/mirror/sceneTree";

function scene(visible = true) {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "rewards",
      upserts: [
        { id: "screen", name: "Rewards", nodeType: "NRewardsScreen", visible },
        { id: "row-b", parentId: "screen", name: "B", nodeType: "NRewardButton" },
        { id: "hit-b", parentId: "row-b", name: "Hitbox", nodeType: "Control" },
        { id: "row-a", parentId: "screen", name: "A", nodeType: "NRewardButton", focused: true },
        { id: "row-a-self", parentId: "row-a", name: "Body", nodeType: "Control" },
        { id: "hit-a", parentId: "row-a", name: "Hitbox", nodeType: "Control" }
      ],
      orderedIds: ["screen", "row-b", "hit-b", "row-a", "row-a-self", "hit-a"]
    })!
  );
  return state;
}

function rect(id: string, tx: number, ty: number): InteractiveRect {
  return {
    id,
    transform: [1, 0, 0, 1, tx, ty],
    localRect: { x: 0, y: 0, width: 20, height: 10 },
    spreadDx: 300,
    renderedWidth: 0,
    raiseDy: -50
  };
}

describe("rewardFocusSnapshotFromScene", () => {
  it("returns ordered rows, authoritative focus, cover state, and native game-space hit centers", () => {
    const state = scene();
    const snapshot = rewardFocusSnapshotFromScene(
      state.nodes,
      state.orderedIds,
      [rect("row-a-self", 500, 500), rect("hit-a", 100, 200), rect("hit-b", 300, 400)],
      (id) => id === "row-b"
    );

    expect(snapshot).toEqual({
      screenId: "screen",
      rows: [
        { id: "row-b", focused: false, covered: true, gameCenter: { x: 310, y: 405 } },
        { id: "row-a", focused: true, covered: false, gameCenter: { x: 110, y: 205 } }
      ]
    });
    // Cosmetic spread/raise values above deliberately do not move the game-space focus point.
  });

  it("has identical output for DOM- and canvas-shaped copies of the same renderer facts", () => {
    const state = scene();
    const domRects = [rect("hit-b", 300, 400), rect("hit-a", 100, 200)];
    const canvasRects = domRects.map((value) => ({
      ...value,
      transform: [...value.transform] as InteractiveRect["transform"],
      localRect: { ...value.localRect }
    }));
    const dom = rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, domRects, () => false);
    const canvas = rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, canvasRects, () => false);
    expect(canvas).toEqual(dom);
  });

  it("answers the same from a rectangle getter, read once and only when a reward screen is present", () => {
    const state = scene();
    const rects = [rect("row-a-self", 500, 500), rect("hit-a", 100, 200), rect("hit-b", 300, 400)];
    const calls: string[] = [];
    const cover = (id: string) => { calls.push(`cover:${id}`); return id === "row-b"; };
    const eager = rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, rects, (id) => id === "row-b");
    const lazy = rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, () => { calls.push("rects"); return rects; }, cover);
    expect(lazy).toEqual(eager);
    // An eager caller gathered the rectangles before any cover query; the getter keeps that order.
    expect(calls).toEqual(["rects", "cover:row-b", "cover:row-a"]);

    const hidden = scene(false);
    let read = 0;
    expect(rewardFocusSnapshotFromScene(hidden.nodes, hidden.orderedIds, () => { read++; return rects; }, () => false))
      .toEqual(rewardFocusSnapshotFromScene(hidden.nodes, hidden.orderedIds, rects, () => false));
    expect(read).toBe(0);
  });

  it("ignores a retained but effectively hidden rewards screen", () => {
    const state = scene(false);
    expect(rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, [], () => false)).toEqual({
      screenId: null,
      rows: []
    });
  });

  // `candidates` (R2-P3, `rustSceneIndex`): a superset restricting the two `orderedIds` scans. A caller passes it
  // only as a HINT — every candidate is still re-checked against the node, so a candidate set with extra, wrong
  // members changes nothing about the answer, only how many ids get looked at.
  describe("candidates", () => {
    it("gives the same answer as an unrestricted scan when every real candidate is present", () => {
      const state = scene();
      const unrestricted = rewardFocusSnapshotFromScene(
        state.nodes, state.orderedIds, [rect("hit-a", 100, 200), rect("hit-b", 300, 400)], (id) => id === "row-b"
      );
      const restricted = rewardFocusSnapshotFromScene(
        state.nodes, state.orderedIds, [rect("hit-a", 100, 200), rect("hit-b", 300, 400)], (id) => id === "row-b",
        { screens: new Set(["screen"]), buttons: new Set(["row-a", "row-b"]) }
      );
      expect(restricted).toEqual(unrestricted);
    });

    it("misses a real screen/row dropped from its candidate set — candidates narrow, they do not widen", () => {
      const state = scene();
      // Neither candidate set names the real ids, so both scans see nothing to check: the index is only ever
      // SAFE when it is a superset, and this spells out the other direction so the contract stays legible.
      expect(rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, [], () => false,
        { screens: new Set(), buttons: new Set(["row-a", "row-b"]) }))
        .toEqual({ screenId: null, rows: [] });
      expect(rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, [], () => false,
        { screens: new Set(["screen"]), buttons: new Set() }))
        .toEqual({ screenId: "screen", rows: [] });
    });

    it("tolerates a stale candidate that no longer matches — verified, not trusted, at query time", () => {
      const state = scene();
      const withExtra = rewardFocusSnapshotFromScene(
        state.nodes, state.orderedIds, [rect("hit-a", 100, 200), rect("hit-b", 300, 400)], (id) => id === "row-b",
        // "hit-a" (a plain Control, never a reward type) and a nonexistent id are harmless extra candidates.
        { screens: new Set(["screen", "ghost"]), buttons: new Set(["row-a", "row-b", "hit-a", "nope"]) }
      );
      const unrestricted = rewardFocusSnapshotFromScene(
        state.nodes, state.orderedIds, [rect("hit-a", 100, 200), rect("hit-b", 300, 400)], (id) => id === "row-b"
      );
      expect(withExtra).toEqual(unrestricted);
    });

    it("omitted (undefined/null) behaves exactly like today — a full scan", () => {
      const state = scene();
      const base = rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, [], () => false);
      expect(rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, [], () => false, undefined)).toEqual(base);
      expect(rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, [], () => false, null)).toEqual(base);
    });
  });
});
