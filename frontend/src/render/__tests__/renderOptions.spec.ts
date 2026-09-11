import { describe, expect, it } from "vitest";

import type { GpuInfo } from "@godot-scene-web/html";

import { resolveRenderQuality } from "@/render/quality";
import {
  STATIC_SHADER_TIME,
  qualityParticleOptions,
  qualityShaderOptions
} from "@/render/renderOptions";

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };

// The tier→gsw-options mapping (the mirror builds mirrorShaderRenderOptions from it). These assertions lock
// which runtime knobs a given tier yields.
describe("qualityShaderOptions / qualityParticleOptions", () => {
  // "Full fidelity" = full RESOLUTION; the per-frame loops are capped at 30fps (the idle-cost
  // lever — see quality.ts's high tier). An explicit `?shaderFps=0` still buys back uncapped.
  it("maps the high tier to full-fidelity shader + particle knobs", () => {
    const q = resolveRenderQuality({ search: "?quality=high", gpu: UNKNOWN_GPU });
    expect(qualityShaderOptions(q)).toEqual({
      enableWebglShaders: true,
      renderScale: 1,
      shaderFps: 30,
      staticShaders: false,
      staticShaderTime: STATIC_SHADER_TIME,
      maxTextureDimension: 4096,
      enableScreenTextureCapture: true
    });
    expect(qualityParticleOptions(q)).toEqual({
      enableParticles: true,
      particleMaxInstances: 2048,
      particleFps: 30,
      renderScale: 1
    });
  });

  it("disables both runtimes on the off tier (?debug)", () => {
    const q = resolveRenderQuality({ search: "?debug", gpu: UNKNOWN_GPU });
    expect(qualityShaderOptions(q).enableWebglShaders).toBe(false);
    expect(qualityParticleOptions(q).enableParticles).toBe(false);
  });

  it("carries the low-end RESOLUTION lever from the tier — the fps caps are the shared 30", () => {
    const q = resolveRenderQuality({ search: "?quality=low", gpu: UNKNOWN_GPU });
    const shader = qualityShaderOptions(q);
    const particle = qualityParticleOptions(q);
    expect(shader.renderScale).toBe(0.5);
    expect(shader.shaderFps).toBe(30);
    // 30, not the old 25: an effect mode picked in the mirror's panel must pace identically on every device, so
    // the fps caps no longer vary per tier (resolution still does). See quality.ts' low/min tiers.
    expect(particle.particleFps).toBe(30);
    expect(particle.renderScale).toBe(0.5);
  });

  it("renders shaders as a single frozen frame on the static tier, particles off", () => {
    const q = resolveRenderQuality({ search: "?quality=static", gpu: UNKNOWN_GPU });
    expect(qualityShaderOptions(q).staticShaders).toBe(true);
    expect(qualityParticleOptions(q).enableParticles).toBe(false);
  });

  it("pays for SCREEN_TEXTURE capture only on the full-effect tiers", () => {
    const low = resolveRenderQuality({ search: "?quality=low", gpu: UNKNOWN_GPU });
    const min = resolveRenderQuality({ search: "?quality=min", gpu: UNKNOWN_GPU });
    expect(qualityShaderOptions(low).enableScreenTextureCapture).toBe(true);
    expect(qualityShaderOptions(min).enableScreenTextureCapture).toBe(false);
  });

  it("honors per-field query overrides applied on top of a tier", () => {
    const q = resolveRenderQuality({ search: "?quality=high&renderScale=0.3&particleFps=8", gpu: UNKNOWN_GPU });
    expect(qualityShaderOptions(q).renderScale).toBe(0.3);
    expect(qualityParticleOptions(q).particleFps).toBe(8);
  });
});
