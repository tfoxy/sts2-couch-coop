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

  it("ignores a retained but effectively hidden rewards screen", () => {
    const state = scene(false);
    expect(rewardFocusSnapshotFromScene(state.nodes, state.orderedIds, [], () => false)).toEqual({
      screenId: null,
      rows: []
    });
  });
});
