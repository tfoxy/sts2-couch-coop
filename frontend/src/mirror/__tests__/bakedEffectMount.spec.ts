// THE BAKED GLOW STILL, THROUGH A REAL MOUNTED MIRROR.
//
// `bakedEffects.spec` owns the SELECTION rules in isolation. What it cannot reach is whether the renderer mounts
// the still at all, places it where the policy said, and — the one that would be invisible in a unit test and
// obvious on screen — whether the ADDITIVE BLEND actually reaches it.
//
// That blend is the interesting case. `bakedEffects` deliberately does NOT set `mix-blend-mode` on the glow
// image, because the emitter's own `canvas_item_material_additive_shared.tres` already reaches the DOM as
// `canvasBlendMode: 1` and `nodeStyle` maps that to `plus-lighter` on the node element the image lives inside.
// If that ever stopped being true the still would composite normally and a glow would read as a grey film —
// which no unit test of `bakedEffects` alone could see.
//
// So the node below is NOT hand-made: it is the `UncommonGlow` emitter lifted verbatim out of a recorded live
// session (`.sts2/bench/audit-cardreward-open.ndjson`, the card-reward screen), including its real modulate,
// transform, material and `canvasBlendMode`. The pixels of the stills themselves are a separate question,
// answered by the bake (`scripts/bake-effect-stills.py`) and by `frontend/src/assets/effects/README.md`.

import { mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import MirrorView from "@/mirror/MirrorView.vue";
import { mirrorSettings, type EffectMode } from "@/mirror/mirrorSettings";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

// Verbatim from the recording, minus the fields a single-node delta cannot carry (its real parent chain).
const RECORDED_UNCOMMON_GLOW = {
  id: "glow",
  parentId: null,
  name: "UncommonGlow",
  nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.Cards.NCardUncommonGlow",
  texture: { resourcePath: "res://images/packed/vfx/generic/glow_card_uncommon.png" },
  modulate: { html: "#ffffffe6" },
  selfModulate: { html: "#ffffffff" },
  material: { resourcePath: "res://themes/canvas_item_material_additive_shared.tres" },
  // The emitter's own 1.35 y-scale, which is exactly why the bake pinned the node to identity: the element
  // matrix supplies it, so the still must not carry it too.
  transform: { xAxis: { x: 0.99999994, y: 0 }, yAxis: { x: 0, y: 1.3499999 }, origin: { x: 320, y: 540 } },
  sceneFilePath: "res://scenes/vfx/uncommon_glow_vfx.tscn",
  zIndex: 0,
  canvasBlendMode: 1,
  opacity: 0.9,
  visible: true,
  particleEmitting: true,
  particleRestartEpoch: 1,
  particleSpec: {
    kind: "GPUParticles2D",
    amount: 6,
    lifetime: 3,
    oneShot: false,
    preprocess: 2,
    localCoords: true,
    emissionShape: 0,
    scaleMin: 4,
    scaleMax: 5,
    blendMode: 1,
    texture: {
      resourcePath: "res://images/packed/vfx/generic/glow_card_uncommon.png",
      resourceType: "Texture2D",
      resourceName: ""
    }
  }
};

function glowState(): MirrorState {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ["glow"],
      upserts: [RECORDED_UNCOMMON_GLOW]
    })!
  );
  return state;
}

let savedParticleMode: EffectMode;

beforeEach(() => {
  savedParticleMode = mirrorSettings.particleMode;
});

afterEach(() => {
  mirrorSettings.particleMode = savedParticleMode;
});

describe("MirrorView baked glow still", () => {
  it("mounts the still at the node-local box the bake captured, and nothing else", () => {
    mirrorSettings.particleMode = "off";
    const wrapper = mount(MirrorView, { props: { state: glowState(), revision: 1 } });

    const host = wrapper.find('[data-node-id="glow"]');
    expect(host.exists()).toBe(true);
    const img = host.find("img.mirror-baked-still");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toMatch(/glow-uncommon/);

    // The box from bakedEffects, written in NODE-LOCAL units and centred on the emitter origin. No `scale()`:
    // the element's own matrix carries the emitter's 1.35 y-scale.
    const style = (img.element as HTMLElement).style;
    expect(style.width).toBe("512px");
    expect(style.height).toBe("512px");
    expect(style.transform).toBe("translate(-256px, -256px)");

    wrapper.unmount();
  });

  it("gets its additive blend from the node's own streamed material, not from itself", () => {
    // THE LOAD-BEARING ASSERTION (see the header). `canvasBlendMode: 1` on the wire must land as plus-lighter on
    // the element the image lives in — and the image must NOT repeat it, or the glow blends twice.
    mirrorSettings.particleMode = "off";
    const wrapper = mount(MirrorView, { props: { state: glowState(), revision: 1 } });

    const host = wrapper.find('[data-node-id="glow"]');
    expect((host.element as HTMLElement).style.mixBlendMode).toBe("plus-lighter");
    expect((wrapper.find("img.mirror-baked-still").element as HTMLElement).style.mixBlendMode).toBe("");

    // …and the game's own 0.9 modulate fade stays the ELEMENT's, which is why the still is baked opaque.
    expect((host.element as HTMLElement).style.opacity).toBe("0.9019607843137255");

    wrapper.unmount();
  });

  it("mounts no still at all while particles are simulating", () => {
    mirrorSettings.particleMode = "static";
    const wrapper = mount(MirrorView, { props: { state: glowState(), revision: 1 } });

    expect(wrapper.find("img.mirror-baked-still").exists()).toBe(false);
    // The real particle path is untouched: the runtime marker is still stamped for gsw to find.
    expect(wrapper.find('[data-node-id="glow"]').attributes("data-godot-particle-runtime")).toBe("1");

    wrapper.unmount();
  });
});
