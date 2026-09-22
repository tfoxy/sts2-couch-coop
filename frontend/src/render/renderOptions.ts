// gsw render options derived purely from the resolved quality tier: the quality-derived scalar knobs —
// enable flags, internal renderScale, fps caps, the frozen `static` mode, the GL texture-upload cap. Kept
// separate from the caller so the tier→knobs mapping is one testable pure function; the mirror supplies its
// OWN resolvers and shader identity policy on top (it synthesizes material docs and runs every shader via
// `webglShaderIds: ["*"]`).

import type { GodotHtmlMountOptions } from "@godot-scene-web/html/runtime";

import { renderQuality, type RenderQuality } from "@/render/quality";

// The representative TIME (seconds) the frozen `very-low` tier renders each shader at. Pinned so looping
// shaders (glow/scroll/pulse) land on a visible phase rather than a trough. Cheap to retune.
export const STATIC_SHADER_TIME = 1;

// gsw shader-runtime knobs that follow purely from the tier (no view-specific resolver/policy). Spread
// into a view's render options, then add `resolveShaderSource` (+ any shader-id policy) alongside.
export function qualityShaderOptions(
  quality: RenderQuality = renderQuality()
): GodotHtmlMountOptions {
  return {
    enableWebglShaders: quality.shadersEnabled,
    renderScale: quality.renderScale,
    shaderFps: quality.shaderFps,
    staticShaders: quality.shadersStatic,
    staticShaderTime: STATIC_SHADER_TIME,
    maxTextureDimension: quality.maxTextureDim,
    // SCREEN_TEXTURE post-process shaders (water reflections, …) need the gsw runtime's throttled
    // DOM-composite capture pass. Only the two top rungs, which run full animated effects, pay for it; from
    // `low` down those shaders keep their CSS/texture fallback.
    enableScreenTextureCapture: quality.tier === "high" || quality.tier === "medium"
  };
}

// gsw particle-runtime knobs that follow purely from the tier. `particleMaxInstances` matches gsw's own
// default; `particleFps`/`renderScale` are the low-end levers.
export function qualityParticleOptions(
  quality: RenderQuality = renderQuality()
): GodotHtmlMountOptions {
  return {
    enableParticles: quality.particlesEnabled,
    particleMaxInstances: 2048,
    particleFps: quality.particleFps,
    renderScale: quality.renderScale
  };
}
