import { mount } from "@vue/test-utils";
import { SELF_LAYER_CLASS, SHADER_DORMANT_ATTR } from "@godot-scene-web/html";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import MirrorView from "@/mirror/MirrorView.vue";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
  // The WebGL runtime fetches .gdshader text; stub it (jsdom has no WebGL2 so it no-ops anyway).
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    text: async () => "shader_type canvas_item;"
  } as Response);
});

function shaderState(): MirrorState {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ["card"],
      upserts: [
        {
          id: "card",
          parentId: null,
          name: "Card",
          nodeType: "TextureRect",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 280 } },
          visible: true,
          texture: { resourcePath: "res://images/card.png", resourceType: "Texture2D" },
          shader: { resourcePath: "res://shaders/card_ripple.gdshader", resourceType: "Shader" },
          shaderParameters: [{ name: "strength", kind: "number", number: 0.5 }]
        }
      ]
    })!
  );
  return state;
}

describe("MirrorView shader nodes", () => {
  it("stamps WebGL shader attributes + self-layer synchronously from the delta params", () => {
    const wrapper = mount(MirrorView, { props: { state: shaderState(), revision: 1 } });

    const card = wrapper.find('[data-node-id="card"]');
    expect(card.exists()).toBe(true);
    expect(card.attributes("data-godot-shader-webgl")).toBe("1");
    expect(card.attributes("data-godot-shader-path")).toBe("res://shaders/card_ripple.gdshader");

    const selfLayer = card.find(`.${SELF_LAYER_CLASS}`);
    expect(selfLayer.exists()).toBe(true);
    expect(selfLayer.attributes("data-godot-shader-texture-url")).toBe("/res/images/card.png");

    expect(() => wrapper.unmount()).not.toThrow();
  });
});

// AUG-14 never-drawn surfaces: the DOM half of the low-HP vignette gate (the pure-function half lives in
// shaderAttributes.spec.ts). What matters here is that the dormancy DECLARATION reaches the element and — the
// property the effect depends on — comes OFF again when the streamed multiplier rises, because on screen the
// vignette really does climb to full strength as the player is hurt. gsw wakes a parked binding by exactly that
// removal, and `data-godot-shader-*` writes set the shader FX-dirty bit, so the removal also drives the runtime
// reconcile that performs the wake.
describe("low-HP vignette dormancy reaches (and leaves) the DOM", () => {
  const LOW_HP_TYPE = "MegaCrit.Sts2.Core.Nodes.Vfx.Ui.NLowHpBorderVfx";
  const LOW_HP_SHADER = "res://shaders/vfx/ui/vfx_ui_low_hp_border_shader.gdshader";

  function vignetteState(multiplier: number, state = createMirrorState()): MirrorState {
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["vfx"],
        upserts: [
          {
            id: "vfx",
            parentId: null,
            name: "vfx_low_hp_border",
            nodeType: LOW_HP_TYPE,
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
            localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
            visible: true,
            fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" },
            selfModulate: { r: 1, g: 1, b: 1, a: 0.7529412, html: "#ffffffc0" },
            shader: { resourcePath: LOW_HP_SHADER, resourceType: "Shader" },
            shaderParameters: [
              { name: "alpha", kind: "number", number: 1 },
              { name: "alpha_multiplier", kind: "number", number: multiplier },
              { name: "smoothstep_factors", kind: "vector2", vector2: { x: 0.1, y: 0.8 } }
            ]
          }
        ]
      })!
    );
    return state;
  }

  function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
    const stage = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(defs);
    document.body.append(stage, svg);
    return { stage, renderer: createMirrorRenderer(stage, defs) };
  }

  it("stamps the dormant marker at rest and REMOVES it when the multiplier rises", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();

    // The recorded resting value: below the 8-bit alpha floor, so the surface cannot paint a bit.
    renderer.reconcile(vignetteState(0.0025295019149780273, state));
    const el = stage.querySelector('[data-node-id="vfx"]') as HTMLElement;
    expect(el.getAttribute("data-godot-shader-webgl")).toBe("1");
    expect(el.getAttribute(SHADER_DORMANT_ATTR)).toBe("1");

    // The player takes a hit: the curve drives the multiplier up. One attribute removal is the whole wake.
    renderer.reconcile(vignetteState(1, state));
    expect(el.getAttribute("data-godot-shader-webgl")).toBe("1");
    expect(el.hasAttribute(SHADER_DORMANT_ATTR)).toBe(false);

    // …and it re-parks when the vignette fades back out.
    renderer.reconcile(vignetteState(0.0025295019149780273, state));
    expect(el.getAttribute(SHADER_DORMANT_ATTR)).toBe("1");

    renderer.dispose();
  });
});
