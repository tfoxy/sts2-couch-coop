import { mount } from "@vue/test-utils";
import { SELF_LAYER_CLASS } from "@godot-scene-web/html";
import { beforeAll, describe, expect, it } from "vitest";

import MirrorView from "@/mirror/MirrorView.vue";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

function particleState(): MirrorState {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ["glow"],
      upserts: [
        {
          id: "glow",
          parentId: null,
          name: "EnergyVfxBack",
          nodeType: "GPUParticles2D",
          // A real GpuParticles2D streams a global transform but NO localRect — the node must still render (the
          // render-list gate + a synthetic zero-rect in nodeStyle handle it).
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 320, y: 540 } },
          visible: true,
          particleSpec: {
            kind: "GPUParticles2D",
            amount: 1,
            lifetime: 2,
            oneShot: true,
            scaleMin: 5,
            scaleMax: 5,
            emissionShape: 0,
            texture: {
              resourcePath: "res://images/vfx/common/common_glow.png",
              resourceType: "Texture2D",
              resourceName: ""
            },
            blendMode: 1
          },
          particleEmitting: true,
          particleRestartEpoch: 1
        }
      ]
    })!
  );
  return state;
}

describe("MirrorView particle nodes", () => {
  it("stamps the particle runtime marker + a self-layer carrying the spec JSON", () => {
    // jsdom has no WebGL2 → createParticleRuntime no-ops; assert the DOM contract (attributes) is stamped.
    const wrapper = mount(MirrorView, { props: { state: particleState(), revision: 1 } });

    const glow = wrapper.find('[data-node-id="glow"]');
    expect(glow.exists()).toBe(true);
    // gsw reads the spec off the OUTER node (it querySelectorAll's [data-godot-particle-runtime] then reads
    // data-godot-particle-specs on that same element), so BOTH must be on the .mirror-node, not the self-layer.
    expect(glow.attributes("data-godot-particle-runtime")).toBe("1");
    const specs = glow.attributes("data-godot-particle-specs");
    expect(specs).toBeTruthy();

    const selfLayer = glow.find(`.${SELF_LAYER_CLASS}`);
    expect(selfLayer.exists()).toBe(true);
    const parsed = JSON.parse(specs!);
    expect(parsed.kind).toBe("GPUParticles2D");
    expect(parsed.emitting).toBe(true);
    expect(parsed.textureUrl).toBe("/res/images/vfx/common/common_glow.png");

    // A particle node must NOT also stamp the shader self-layer (mutually exclusive gate).
    expect(glow.attributes("data-godot-shader-webgl")).toBeUndefined();

    expect(() => wrapper.unmount()).not.toThrow();
  });

  it("keeps the static particleSpec across a volatile-only upsert (the ClipChildren lesson)", () => {
    const state = particleState();
    // A volatile-only upsert (no name): carries fresh emitting/epoch but no spec — the retained spec must survive.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [{ id: "glow", parentId: null, particleEmitting: false, particleRestartEpoch: 2 }]
      })!
    );
    const node = state.nodes.get("glow")!;
    expect(node.particleSpec).not.toBeNull();
    expect(node.particleSpec!.kind).toBe("GPUParticles2D");
    // Volatile fields refreshed from the new upsert.
    expect(node.particleEmitting).toBe(false);
    expect(node.particleRestartEpoch).toBe(2);
  });
});
