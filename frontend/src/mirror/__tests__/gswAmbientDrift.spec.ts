// AMBIENT GSW DRIFT — exercise the real source aliases, not a hand-written mock.
//
// `spirectl-presentation.d.ts` is intentionally a small ambient mirror of the toolkit's public
// surface: Vite aliases these imports straight to sibling TypeScript source, while vue-tsc sees
// this declaration file. A new runtime export can otherwise be invisible until a consumer happens
// to use it. Keep runtime assertions and declaration-only samples together here.

import { describe, expect, it } from "vitest";

import * as canvas from "@godot-scene-web/canvas";
import * as effects from "@godot-scene-web/effects/easing";
import * as html from "@godot-scene-web/html";
import * as hbGpu from "@godot-scene-web/hb-gpu";
import * as hbGpuWebgl from "@godot-scene-web/hb-gpu/webgl";
import { FX_PIXEL_RATIO_ATTR } from "@/mirror/canvas/fxPixelRatio";
import type { CanvasTextureOptions } from "@godot-scene-web/canvas";
import type { HbGpuGlyphPassOptions } from "@godot-scene-web/canvas/glyphs";
import type { ParticleRuntime, WebglShaderRuntime } from "@godot-scene-web/html/runtime";

// Declaration-only samples: if this hand-maintained consumer contract drifts, vue-tsc fails here.
const textureOptions: CanvasTextureOptions = {
  premultiplied: true,
  mipmap: true,
  minFilter: 0x2703,
  magFilter: 0x2600
};

const legacyCompatibleGlyphSlot: import("@godot-scene-web/hb-gpu/webgl").GlyphSlot = {
  key: "0/17",
  generation: 1,
  loc: 0,
  upem: 1000,
  minX: 0,
  minY: 0,
  maxX: 1,
  maxY: 1,
  texels: 1
};

const glyphPassOptions: Pick<HbGpuGlyphPassOptions, "shapeCacheEntries" | "shapeCacheGlyphs"> = {
  shapeCacheEntries: 512,
  shapeCacheGlyphs: 1024
};

void textureOptions;
void legacyCompatibleGlyphSlot;
void glyphPassOptions;

// Every capability MirrorView probes is optional at this boundary. This is intentionally declaration-only: a
// newer source alias may implement all of them, while an older source alias must still mount and keep its
// mandatory reconcile/mode/disposal contract.
const legacyShaderRuntime: Pick<
  WebglShaderRuntime,
  "reconcile" | "setRenderScale" | "setFps" | "setStaticShaders" | "setStaticShaderImages" | "dispose"
> = {
  reconcile() {},
  setRenderScale() {},
  setFps() {},
  setStaticShaders() {},
  setStaticShaderImages() {},
  dispose() {}
};
const legacyParticleRuntime: Pick<
  ParticleRuntime,
  "reconcile" | "setRenderScale" | "setFps" | "setStaticParticles" | "setStaticParticleImages" | "dispose"
> = {
  reconcile() {},
  setRenderScale() {},
  setFps() {},
  setStaticParticles() {},
  setStaticParticleImages() {},
  dispose() {}
};
void legacyShaderRuntime;
void legacyParticleRuntime;

describe("godot-scene-web source contracts", () => {
  it("loads the public runtime exports through source aliases", () => {
    expect(typeof effects.createEaseSampler).toBe("function");
    expect(typeof html.godotBbcodeTagKind).toBe("function");
    expect(typeof html.parseSurfacePixelRatio).toBe("function");
    expect(typeof canvas.createDrawList).toBe("function");
    expect(typeof canvas.createTextureCache).toBe("function");
    expect(typeof hbGpu.createHbGpu).toBe("function");
    expect(typeof hbGpuWebgl.HB_GPU_CONTRAST_NONE).toBe("object");
  });

  it("pins shared easing, BBCode, and surface-density contracts", () => {
    const sample = effects.createEaseSampler("Out", "Sine");
    expect(sample(0.5)).toBe(effects.godotEaseSample("Out", "Sine", 0.5));
    expect(html.godotBbcodeTagKind("wave")).toBe("effect");
    expect(html.godotBbcodeTagKind("custom", { custom: { kind: "color", value: "#fff" } })).toBe("color");
    expect(Object.isFrozen(html.GODOT_BBCODE_BUILT_IN_EFFECTS)).toBe(true);

    expect(html.MAX_SURFACE_PIXEL_RATIO).toBe(4);
    expect(html.SURFACE_PIXEL_RATIO_ATTR).toBe("data-godot-shader-pixel-ratio");
    expect(html.SURFACE_PIXEL_RATIO_ATTR).toBe(FX_PIXEL_RATIO_ATTR);
    expect(html.parseSurfacePixelRatio("40")).toBe(html.MAX_SURFACE_PIXEL_RATIO);
    expect(html.parseSurfacePixelRatio("bad")).toBe(1);
  });
});
