import { describe, expect, it } from "vitest";

import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode } from "@/mirror/sceneTree";

// Stage 3 (client side of the omission lockstep): the server's WireNodeDelta OMITS a value-type field iff it
// equals the client's normalizeNode fallback default. This spec pins those defaults so a server-side omission and
// the client-side refill can never disagree — if someone changes a default here, the corresponding server
// omission (WireNodeDelta.FromNode) must change in lockstep or the wire misrenders.

function parse(over: Record<string, unknown>): MirrorNode {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: [{ id: "n", name: "n", nodeType: "Control", ...over }],
      orderedIds: ["n"]
    })!
  );
  return state.nodes.get("n")!;
}

describe("wire default omission fallback table (normalizeNode)", () => {
  it("fills every omittable field with the agreed default when the wire omits it", () => {
    const n = parse({}); // a maximally-slim node: only id/name/nodeType present
    // Defaults that MUST match the server's WireNodeDelta omission rules.
    expect(n.visible).toBe(true); // omit when true
    expect(n.opacity).toBe(1); // omit when 1
    expect(n.scaleX).toBe(1); // omit when 1
    expect(n.scaleY).toBe(1); // omit when 1
    expect(n.pivotX).toBe(0); // omit when 0
    expect(n.pivotY).toBe(0); // omit when 0
    expect(n.ninePatch).toBe(false); // omit when false
    expect(n.showBehindParent).toBe(false); // omit when false
    expect(n.clipChildren).toBe(0); // omit when 0
    expect(n.clipContents).toBe(false); // omit when false
    expect(n.focused).toBe(false); // omit when false or unavailable
    expect(n.richText).toBe(false); // omit when false
    expect(n.textureFlipH).toBe(false); // omit when false
    expect(n.textureFlipV).toBe(false); // omit when false
    expect(n.particleEmitting).toBe(false); // omit when false
    expect(n.particleRestartEpoch).toBe(0); // omit when 0
    expect(n.spineTrackTime).toBe(0); // omit when 0
    expect(n.spineLooping).toBe(true); // omit when true
    expect(n.rotation).toBe(0); // rotation killed end-to-end; client refills 0
    expect(n.zIndex).toBeNull(); // nullable passthrough
  });

  it("preserves MEANINGFUL non-default values (never omitted by the server)", () => {
    const n = parse({
      visible: false,
      opacity: 0,
      spineLooping: false,
      ninePatch: true,
      scaleX: 2,
      clipChildren: 1,
      clipContents: true,
      focused: true
    });
    expect(n.visible).toBe(false);
    expect(n.opacity).toBe(0);
    expect(n.spineLooping).toBe(false);
    expect(n.ninePatch).toBe(true);
    expect(n.scaleX).toBe(2);
    expect(n.clipChildren).toBe(1);
    expect(n.clipContents).toBe(true);
    expect(n.focused).toBe(true);
  });

  it("takes focus from every volatile upsert, including an omitted false after true", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        upserts: [{ id: "n", name: "n", nodeType: "NRewardButton", focused: true }],
        orderedIds: ["n"]
      })!
    );
    expect(state.nodes.get("n")?.focused).toBe(true);

    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [{ id: "n" }],
        removedIds: []
      })!
    );
    expect(state.nodes.get("n")?.focused).toBe(false);
  });

  it("float-cast wire values parse transparently (e.g. slimmed opacity/scale)", () => {
    // The server ships these as float32 shortest round-trip; JSON.parse yields the same JS number.
    const n = parse({ opacity: 0.5, scaleX: 1.3125, pivotX: 12.5 });
    expect(n.opacity).toBe(0.5);
    expect(n.scaleX).toBe(1.3125);
    expect(n.pivotX).toBe(12.5);
  });
});
