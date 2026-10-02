// `retainSourceSwaps` (rustCoalescedBuilds / rustOffsetPatch): an intent-frame swap (and an opacity step) stays open
// until a committed frame drew it. A frame that samples the swap and draws nothing (a yielding tick, a patch that
// never presents) used to consume it, and the next patch then omitted the swap.
import { describe, expect, it } from "vitest";

import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import { createCanvasVisualState, type CanvasVisualPorts } from "./visualState";

const FPS = 10; // one swap per 100 ms

function intentScene(): MirrorState {
  const region = (x: number) => ({ position: { x, y: 0 }, size: { x: 48, y: 48 } });
  const state = createMirrorState();
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", orderedIds: ["Intent"],
    upserts: [{ id: "Intent", parentId: null, name: "Intent", nodeType: "Sprite2D", visible: true,
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 300, y: 300 } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 48, y: 48 } },
      intentFrames: { animationName: "attack", fps: FPS, frames: [
        { atlasPath: "res://atlases/intent_atlas.png", region: region(0), margin: null },
        { atlasPath: "res://atlases/intent_atlas.png", region: region(48), margin: null },
        { atlasPath: "res://atlases/intent_atlas.png", region: region(96), margin: null },
      ] } }] })!);
  return state;
}

function visualFor(state: MirrorState, retainSourceSwaps: boolean) {
  const ports: CanvasVisualPorts = {
    state: () => state, nodeOf: (id) => state.nodes.get(id), hasChildren: () => false, paintOrder: () => null,
    hitEntries: () => [], capturedGlobal: () => undefined, cosmeticOffsetDy: () => 0,
    effectivelyVisible: (node) => node.visible, isLandingTarget: () => false, onTransformArm: () => {},
    onNodePresent: () => {}, onNodeRemoved: () => {}, onRewrite: () => {}, onFlights: () => {},
  };
  const visual = createCanvasVisualState(ports, { clockOriginMs: 0, now: () => 0, spreadAuditEnabled: false,
    noteIdlePeriod: () => {}, retainSourceSwaps });
  visual.applyInputs(state, 0);
  return visual;
}

describe("intent-frame swaps (retainSourceSwaps)", () => {
  it("keeps a swap until a committed frame drew it, and only that swap", () => {
    const visual = visualFor(intentScene(), true);
    visual.sample(150); // frame 1: a swap
    expect([...visual.sourceSampledIds]).toEqual(["Intent"]);
    // This frame draws nothing (a yielding tick). The next sample has no new swap, but the old one is still open.
    visual.sample(160);
    expect([...visual.sourceSampledIds]).toEqual(["Intent"]);
    // A patch planned now draws it; before it commits, the intent swaps again.
    const mark = visual.sampleMark();
    visual.sample(250); // frame 2
    visual.settleSamples(mark);
    // The later swap is still open: the committed patch drew frame 1, not frame 2.
    expect([...visual.sourceSampledIds]).toEqual(["Intent"]);
    visual.settleSamples(visual.sampleMark());
    expect(visual.sourceSampledIds.size).toBe(0);
    visual.sample(260);
    expect(visual.sourceSampledIds.size).toBe(0);
  });

  it("drops an open swap with its node", () => {
    const state = intentScene();
    const visual = visualFor(state, true);
    visual.sample(150);
    expect([...visual.sourceSampledIds]).toEqual(["Intent"]);
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "combat", upserts: [],
      removedIds: ["Intent"] })!);
    visual.applyInputs(state, 160);
    expect(visual.sourceSampledIds.size).toBe(0);
    expect(visual.sampleMark()!.sources.size).toBe(0);
  });

  it("keeps a fade's last step open until a committed frame drew it", () => {
    const state = intentScene();
    const visual = visualFor(state, true);
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "combat", upserts: [],
      hints: [{ targetId: "Intent", property: "modulate:a", durationMs: 100, trans: "Linear", ease: "In", endOpacity: 0 }] })!);
    visual.applyInputs(state, 0);
    visual.sample(50);
    visual.sample(120); // the last step: the fade reaches 0, and nothing draws this frame
    expect(visual.opacityPatchIds.has("Intent")).toBe(true);
    visual.sample(140); // no opacity change this sample...
    expect(visual.opacitySampledIds.has("Intent")).toBe(false);
    // ...but the patch that comes next still has to draw the step.
    expect(visual.opacityPatchIds.has("Intent")).toBe(true);
    visual.settleSamples(visual.sampleMark());
    expect(visual.opacityPatchIds.size).toBe(0);
  });

  it("reports this sample's swaps only without it", () => {
    const visual = visualFor(intentScene(), false);
    visual.sample(150);
    expect([...visual.sourceSampledIds]).toEqual(["Intent"]);
    visual.sample(160);
    expect(visual.sourceSampledIds.size).toBe(0);
    expect(visual.sampleMark()).toBeNull();
  });
});
