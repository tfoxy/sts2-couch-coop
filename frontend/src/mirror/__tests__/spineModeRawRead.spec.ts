import { afterEach, describe, expect, it } from "vitest";

import { isCreaturePlaceholderNode } from "@/mirror/creaturePlaceholder";
import { effectiveSpineMode, mirrorSettings, rawSpineMode } from "@/mirror/mirrorSettings";
import { isGeoclipPlaybackEnabled, isSpineClipNode, isSpineStillMode } from "@/mirror/spineAttributes";
import type { MirrorNode } from "@/mirror/sceneTree";
import { __setRenderQualityForTest, type RenderQuality, type RenderQualityTier } from "@/render/quality";

// PERF FIX, R2-A: `isCreaturePlaceholderNode`/`isSpineClipNode`/`isSpineStillMode`/`isGeoclipPlaybackEnabled` used
// to read `mirrorSettings.spineMode` (or `effectiveMirrorRenderSettings(mirrorSettings).spineMode`) directly
// through the reactive Proxy on every node, every producer build. `spineMode` is parsed once from the dev-only
// `?spineMode=` URL flag and nothing reassigns it in production, so `rawSpineMode`/`effectiveSpineMode` read it
// off `toRaw(mirrorSettings)` instead — identical by construction. This file pins that the two load-time states
// (the product default, and the dev `?spineMode=off` override) still answer exactly as before, and that a direct
// assignment to the singleton (how both this repo's specs AND a real `?spineMode=` parse set the field) is still
// visible immediately — i.e. the raw read is live, not a module-load snapshot.

function fullClipQuality(overrides: Partial<RenderQuality> = {}): RenderQuality {
  const tier: RenderQualityTier = "high";
  return {
    tier,
    shadersEnabled: true,
    shadersStatic: false,
    particlesEnabled: true,
    spineClipsEnabled: true,
    spineClipFps: 0,
    renderScale: 1,
    shaderFps: 0,
    particleFps: 30,
    maxTextureDim: 4096,
    maxTrailPoints: 0,
    staticShaderScale: 1,
    staticParticleScale: 1,
    ios: false,
    source: "default",
    ...overrides
  };
}

function creatureNode(): MirrorNode {
  return {
    spineSceneResPath: "res://scenes/creature_visuals/ironclad.tscn",
    spineNodePath: "Visuals",
    spineCurrentAnim: "idle_loop"
  } as unknown as MirrorNode;
}

afterEach(() => {
  __setRenderQualityForTest(undefined);
  mirrorSettings.spineMode = "static"; // back to the product default — the store is an app-wide singleton
  mirrorSettings.runtimeStage = "dom";
});

describe("spineMode raw read — same answers as the proxy read it replaced", () => {
  it("default at load (no ?spineMode=): static, and the creature placeholder + spine gates are unaffected", () => {
    __setRenderQualityForTest(fullClipQuality());
    expect(rawSpineMode()).toBe("static");
    expect(effectiveSpineMode()).toBe("static");
    expect(isCreaturePlaceholderNode(creatureNode())).toBe(true);
    expect(isSpineClipNode(creatureNode())).toBe(true);
    expect(isSpineStillMode()).toBe(true); // static always wants a still, even on a full-clip tier
    expect(isGeoclipPlaybackEnabled()).toBe(false);
  });

  it("dev `?spineMode=off` override: both gates go dark, exactly as the direct proxy read did", () => {
    __setRenderQualityForTest(fullClipQuality());
    mirrorSettings.spineMode = "off"; // simulates the `?spineMode=off` parse (see parseSpineMode)
    expect(rawSpineMode()).toBe("off");
    expect(effectiveSpineMode()).toBe("off");
    expect(isCreaturePlaceholderNode(creatureNode())).toBe(false);
    expect(isSpineClipNode(creatureNode())).toBe(false);
  });

  it("a direct assignment to the singleton is visible immediately — the raw read is live, not cached at load", () => {
    expect(rawSpineMode()).toBe("static");
    mirrorSettings.spineMode = "dynamic";
    expect(rawSpineMode()).toBe("dynamic");
    expect(isGeoclipPlaybackEnabled()).toBe(true);
    mirrorSettings.spineMode = "off";
    expect(rawSpineMode()).toBe("off");
  });

  it("effectiveSpineMode still forces static on the canvas runtime stage, even with ?spineMode=off", () => {
    mirrorSettings.spineMode = "off";
    mirrorSettings.runtimeStage = "canvas";
    expect(effectiveSpineMode()).toBe("static");
    // The raw field itself is untouched by the canvas override — only the EFFECTIVE value changes.
    expect(rawSpineMode()).toBe("off");
  });
});
