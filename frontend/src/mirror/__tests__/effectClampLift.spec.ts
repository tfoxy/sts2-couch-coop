import { afterEach, describe, expect, it, vi } from "vitest";

import type { GpuInfo } from "@godot-scene-web/html";

import {
  __setRenderQualityForTest,
  resolveRenderQuality,
  type RenderQuality
} from "@/render/quality";
import { nodeParticleAttributes } from "@/mirror/particleAttributes";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorNode
} from "@/mirror/sceneTree";

// R10 WS-A: THE PANEL DECIDES. A mid-range phone auto-resolves to the `very-low` tier, which seeds
// `particlesEnabled: false` — and that used to be a CLAMP in two places (no DOM markers stamped, and the
// effective particle mode forced `off`), so the Particles select in the settings panel did nothing at all on
// exactly the devices that see it most, while the same select worked on a desktop. Only the hard-off lane
// (?debug / ?quality=minimum / a software-WebGL phone) may still veto the panel.

const WEAK_MOBILE_GPU: GpuInfo = { renderer: "Mali-G57 MC2", software: false, unavailable: false };
const SOFTWARE_GPU: GpuInfo = { renderer: "Google SwiftShader", software: true, unavailable: false };

function phoneQuality(search = ""): RenderQuality {
  return resolveRenderQuality({
    search,
    gpu: WEAK_MOBILE_GPU,
    mobile: true,
    hardwareConcurrency: 8,
    deviceMemory: 8
  });
}

// A GPUParticles2D node through the real delta pipeline (the same fixture shape as particleAttributes.spec).
function particleNode(): MirrorNode {
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
          particleSpec: {
            kind: "GPUParticles2D",
            amount: 1,
            lifetime: 2,
            oneShot: true,
            scaleMin: 5,
            scaleMax: 5,
            emissionShape: 0,
            baseColor: { r: 1, g: 0.485, b: 0.303, a: 1, html: "#ff7b4dff" },
            gravity: { x: 0, y: 0 },
            texture: {
              resourcePath: "res://images/vfx/common/common_glow.png",
              resourceType: "Texture2D",
              resourceName: ""
            },
            blendMode: 1
          },
          particleEmitting: true,
          particleRestartEpoch: 0
        }
      ]
    })!
  );
  return state.nodes.get("glow")!;
}

afterEach(() => {
  __setRenderQualityForTest(undefined);
  vi.resetModules();
});

describe("particle marker stamping — the tier is a seed, not a clamp", () => {
  it("STAMPS on the mobile `very-low` tier, whose particlesEnabled is false", () => {
    const q = phoneQuality();
    expect(q.tier).toBe("very-low");
    expect(q.particlesEnabled).toBe(false); // the seed the panel starts from…
    __setRenderQualityForTest(q);
    // …and the markers are stamped anyway, so the runtime has something to attach to when the viewer picks a mode.
    expect(nodeParticleAttributes(particleNode())).not.toBeNull();
  });

  it("STAMPS on `low` and `medium` (the other reduced mobile tiers) and on a desktop `high`", () => {
    for (const search of ["?quality=low", "?quality=medium", "?quality=high"]) {
      __setRenderQualityForTest(resolveRenderQuality({ search, gpu: WEAK_MOBILE_GPU, mobile: true }));
      expect(nodeParticleAttributes(particleNode())).not.toBeNull();
    }
  });

  it("stays DEAD in the hard-off lane (?debug auto-player, ?quality=minimum, software-WebGL phone)", () => {
    for (const q of [
      resolveRenderQuality({ search: "?debug", gpu: WEAK_MOBILE_GPU }),
      resolveRenderQuality({ search: "?quality=minimum", gpu: WEAK_MOBILE_GPU }),
      resolveRenderQuality({ search: "", gpu: SOFTWARE_GPU, mobile: true })
    ]) {
      expect(q.tier).toBe("minimum");
      __setRenderQualityForTest(q);
      expect(nodeParticleAttributes(particleNode())).toBeNull();
    }
  });
});

// shaderResources reads the resolved quality ONCE at module load (the construction options are tier-fixed), so
// each case re-imports the module graph with the tier already installed.
async function loadForTier(q: RenderQuality) {
  vi.resetModules();
  const quality = await import("@/render/quality");
  quality.__setRenderQualityForTest(q);
  const resources = await import("@/mirror/shaderResources");
  const settings = await import("@/mirror/mirrorSettings");
  return { resources, settings };
}

describe("effective effect modes — the panel decides on every live tier", () => {
  it("constructs BOTH runtimes on the mobile `very-low` tier and follows the panel's particle mode", async () => {
    const { resources, settings } = await loadForTier(phoneQuality());
    expect(resources.mirrorParticleRenderOptions.enableParticles).toBe(true);
    expect(resources.mirrorShaderRenderOptions.enableWebglShaders).toBe(true);

    settings.mirrorSettings.particleMode = "dynamic";
    expect(resources.effectiveParticleMode.value).toBe("dynamic");
    settings.mirrorSettings.particleMode = "static";
    expect(resources.effectiveParticleMode.value).toBe("static");
    settings.mirrorSettings.shaderMode = "dynamic-half";
    expect(resources.effectiveShaderMode.value).toBe("dynamic-half");
  });

  it("forces `off` in the hard-off lane no matter what the panel says", async () => {
    const { resources, settings } = await loadForTier(
      resolveRenderQuality({ search: "?debug", gpu: WEAK_MOBILE_GPU })
    );
    expect(resources.mirrorParticleRenderOptions.enableParticles).toBe(false);
    expect(resources.mirrorShaderRenderOptions.enableWebglShaders).toBe(false);

    settings.mirrorSettings.particleMode = "dynamic";
    settings.mirrorSettings.shaderMode = "dynamic";
    expect(resources.effectiveParticleMode.value).toBe("off");
    expect(resources.effectiveShaderMode.value).toBe("off");
  });

  it("seeds the panel itself to `off` there, so it never offers a mode that cannot run", async () => {
    const { settings } = await loadForTier(resolveRenderQuality({ search: "?debug", gpu: WEAK_MOBILE_GPU }));
    const store = settings.createMirrorSettings(
      resolveRenderQuality({ search: "?debug", gpu: WEAK_MOBILE_GPU }),
      "?debug",
      { storage: null }
    );
    expect(store.shaderMode).toBe("off");
    expect(store.particleMode).toBe("off");
  });
});
