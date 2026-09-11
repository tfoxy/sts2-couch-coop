import { afterEach, describe, expect, it } from "vitest";

import { createMirrorSettings, mirrorSettings, parseSpineMode, SPINE_MODES } from "@/mirror/mirrorSettings";
import { isGeoclipPlaybackEnabled, isSpineClipNode, isSpineStillMode, spineClipUrl } from "@/mirror/spineAttributes";
import type { MirrorNode } from "@/mirror/sceneTree";
import { __setRenderQualityForTest, type RenderQuality, type RenderQualityTier } from "@/render/quality";

// The 4-state spine mode. It is an OVERLAY on the device's resolved quality tier — the tier object is memoized per
// session and must never be mutated — consulted at the two decision gates that every spine consumer shares
// (`isSpineClipNode`, which nodeStyles ALSO calls for the zero-box placement, and `isSpineStillMode`, which picks
// &still=1 + the no-rAF paint). These cases pin all four modes against both a full-clip tier and a still-only tier,
// so a future tier change can't silently move an answer.
//
// The DEFAULT is `static` (server-baked stills everywhere); the panel select is gone and the other three values
// survive only as the dev `?spineMode=` override. The one asymmetry that buys: `static`, being what every real
// viewer runs, must NOT promote the `off` floor tier into rendering spines — while `dynamic`, which you can only
// reach by typing it, still overrides everything.

function quality(overrides: Partial<RenderQuality> = {}): RenderQuality {
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
    source: "default",
    ...overrides
  };
}

// A full-clip desktop tier vs the weak-phone tier that renders spines but fetches only ONE still frame.
const FULL_CLIP_TIER = quality();
const STILL_TIER = quality({ tier: "min", spineClipsEnabled: false });
// The floor tier (WebGL unavailable / the ?debug auto-player): fetches nothing at all.
const OFF_TIER = quality({ tier: "off", spineClipsEnabled: false });

function spineNode(over: Record<string, unknown> = {}): MirrorNode {
  return {
    spineSceneResPath: "res://scenes/x.tscn",
    spineNodePath: "Vis/Spine",
    spineCurrentAnim: "idle",
    ...over
  } as unknown as MirrorNode;
}

afterEach(() => {
  __setRenderQualityForTest(undefined);
  mirrorSettings.spineMode = "static"; // the product default
});

beforeEach(() => {
  // Several cases below exercise the tier-driven `auto` lane, which is no longer the default — pin it per case.
  mirrorSettings.spineMode = "static";
});

describe("parseSpineMode / seeding", () => {
  it("accepts the four modes (case-insensitively) and falls back to STATIC on anything else", () => {
    expect(SPINE_MODES).toEqual(["auto", "dynamic", "static", "off"]);
    for (const mode of SPINE_MODES) {
      expect(parseSpineMode(mode)).toBe(mode);
    }
    expect(parseSpineMode("AUTO")).toBe("auto");
    expect(parseSpineMode("nonsense")).toBe("static");
    expect(parseSpineMode(null)).toBe("static");
  });

  it("seeds spineMode to STATIC unless the dev ?spineMode= override says otherwise", () => {
    // No param — i.e. every real viewer, on every device.
    expect(createMirrorSettings(quality(), "").spineMode).toBe("static");
    expect(createMirrorSettings(quality(), "").spineMode).toBe("static");
    expect(createMirrorSettings(quality(), "?spineMode=bogus").spineMode).toBe("static");
    // …and the dev override still reaches all four values.
    expect(createMirrorSettings(quality(), "?spineMode=static").spineMode).toBe("static");
    expect(createMirrorSettings(quality(), "?spineMode=off").spineMode).toBe("off");
    expect(createMirrorSettings(quality(), "?spineMode=dynamic").spineMode).toBe("dynamic");
    expect(createMirrorSettings(quality(), "?spineMode=auto").spineMode).toBe("auto");
  });
});

describe("spine gates — Auto defers to the tier (the dev ?spineMode=auto lane)", () => {
  beforeEach(() => {
    mirrorSettings.spineMode = "auto";
  });

  it("full-clip tier: renders, animated", () => {
    __setRenderQualityForTest(FULL_CLIP_TIER);
    expect(isSpineClipNode(spineNode())).toBe(true);
    expect(isSpineStillMode()).toBe(false);
  });

  it("still-only (weak phone) tier: renders, still", () => {
    __setRenderQualityForTest(STILL_TIER);
    expect(isSpineClipNode(spineNode())).toBe(true);
    expect(isSpineStillMode()).toBe(true);
  });

  it("off floor tier: does not render at all", () => {
    __setRenderQualityForTest(OFF_TIER);
    expect(isSpineClipNode(spineNode())).toBe(false);
  });
});

describe("spine gates — the mode pins the answer on ANY tier", () => {
  it("keeps geoclips behind an explicit developer mode", () => {
    mirrorSettings.spineMode = "static";
    expect(isGeoclipPlaybackEnabled()).toBe(false);
    mirrorSettings.spineMode = "off";
    expect(isGeoclipPlaybackEnabled()).toBe(false);
    mirrorSettings.spineMode = "dynamic";
    expect(isGeoclipPlaybackEnabled()).toBe(true);
    mirrorSettings.spineMode = "auto";
    expect(isGeoclipPlaybackEnabled()).toBe(true);
  });

  it("Dynamic forces the animated clip even on a still-only tier", () => {
    __setRenderQualityForTest(STILL_TIER);
    mirrorSettings.spineMode = "dynamic";
    expect(isSpineClipNode(spineNode())).toBe(true);
    expect(isSpineStillMode()).toBe(false);
  });

  it("Dynamic renders even on the off floor tier (the viewer asked for it explicitly)", () => {
    __setRenderQualityForTest(OFF_TIER);
    mirrorSettings.spineMode = "dynamic";
    expect(isSpineClipNode(spineNode())).toBe(true);
  });

  it("Static (THE DEFAULT) forces the single still frame even on a full-clip tier", () => {
    __setRenderQualityForTest(FULL_CLIP_TIER);
    mirrorSettings.spineMode = "static";
    expect(isSpineClipNode(spineNode())).toBe(true);
    expect(isSpineStillMode()).toBe(true);
  });

  it("Static still honours the `off` FLOOR tier — the default must not promote it into rendering spines", () => {
    // This is the asymmetry with Dynamic above: `static` is what every viewer runs, so on the floor tier (WebGL
    // unavailable / the ?debug auto-player) it has to answer exactly what `auto` used to answer there — nothing.
    __setRenderQualityForTest(OFF_TIER);
    mirrorSettings.spineMode = "static";
    expect(isSpineClipNode(spineNode())).toBe(false);
  });

  it("Off makes a spine node NOT a spine-clip node — so nodeStyles leaves no phantom zero-box either", () => {
    __setRenderQualityForTest(FULL_CLIP_TIER);
    mirrorSettings.spineMode = "off";
    expect(isSpineClipNode(spineNode())).toBe(false);
    // Same on a tier that would otherwise render a still.
    __setRenderQualityForTest(STILL_TIER);
    expect(isSpineClipNode(spineNode())).toBe(false);
    // isSpineStillMode is moot when nothing renders, but must still answer a defined value.
    expect(isSpineStillMode()).toBe(false);
  });

  it("never makes a NON-spine node (no scene path / no anim) a spine node", () => {
    __setRenderQualityForTest(FULL_CLIP_TIER);
    for (const mode of SPINE_MODES) {
      mirrorSettings.spineMode = mode;
      expect(isSpineClipNode(spineNode({ spineSceneResPath: null }))).toBe(false); // not a SpineSprite
      expect(isSpineClipNode(spineNode({ spineCurrentAnim: null }))).toBe(false); // nothing playing on it
    }
  });
});

describe("spineClipUrl follows the mode", () => {
  it("Static appends &still=1 on a full-clip tier; Dynamic drops it on a still tier", () => {
    __setRenderQualityForTest(FULL_CLIP_TIER);
    mirrorSettings.spineMode = "static";
    expect(spineClipUrl(spineNode())).toBe("/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle&still=1");

    __setRenderQualityForTest(STILL_TIER);
    mirrorSettings.spineMode = "dynamic";
    expect(spineClipUrl(spineNode())).toBe("/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle");
  });

  it("Auto keeps the url BYTE-IDENTICAL to the pre-override behavior on both tiers", () => {
    mirrorSettings.spineMode = "auto";
    __setRenderQualityForTest(FULL_CLIP_TIER);
    expect(spineClipUrl(spineNode())).toBe("/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle");
    __setRenderQualityForTest(STILL_TIER);
    expect(spineClipUrl(spineNode())).toBe("/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle&still=1");
  });
});
