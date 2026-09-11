import { afterEach, describe, expect, it, vi } from "vitest";

import type { GpuInfo } from "@godot-scene-web/html";

import {
  isAdaptiveEligible,
  particlesHardOff,
  resolveRenderQuality,
  shadersHardOff,
  stagePixelRatio,
  __setRenderQualityForTest,
  STATIC_PARTICLE_SCALE_MOBILE,
  STATIC_SCALE_DESKTOP,
  STATIC_SHADER_SCALE_MOBILE,
  type RenderQualitySignals,
  type RenderQualityTier
} from "@/render/quality";

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };
const STRONG_GPU: GpuInfo = {
  renderer: "NVIDIA GeForce RTX 4080",
  software: false,
  unavailable: false,
};
const WEAK_GPU: GpuInfo = {
  renderer: "Intel(R) UHD Graphics 620",
  software: false,
  unavailable: false,
};
const SOFTWARE_GPU: GpuInfo = {
  renderer: "Google SwiftShader",
  software: true,
  unavailable: false,
};

function signals(overrides: Partial<RenderQualitySignals> = {}): RenderQualitySignals {
  return {
    search: "",
    gpu: UNKNOWN_GPU,
    hardwareConcurrency: 16,
    deviceMemory: 16,
    ...overrides,
  };
}

describe("resolveRenderQuality — explicit overrides", () => {
  it("?debug forces the off tier (auto-player parity), even with ?quality=high", () => {
    const q = resolveRenderQuality(signals({ search: "?debug&quality=high" }));
    expect(q.tier).toBe("off");
    expect(q.source).toBe("debug");
    expect(q.shadersEnabled).toBe(false);
    expect(q.particlesEnabled).toBe(false);
  });

  it("?quality=off disables shaders + particles", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=off" }));
    expect(q.tier).toBe("off");
    expect(q.source).toBe("query");
    expect(q.shadersEnabled).toBe(false);
    expect(q.particlesEnabled).toBe(false);
  });

  it("?quality=low keeps effects but halves resolution and caps FPS", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=low" }));
    expect(q.tier).toBe("low");
    expect(q.source).toBe("query");
    expect(q.shadersEnabled).toBe(true);
    expect(q.particlesEnabled).toBe(true);
    expect(q.renderScale).toBe(0.5);
    expect(q.shaderFps).toBe(30);
    // RESOLUTION is the per-tier lever; the fps caps are the SAME on every live tier so that a given panel effect
    // mode paces identically on a phone and a desktop (was 25 here and on `min`).
    expect(q.particleFps).toBe(30);
  });

  it("?quality=min keeps effects on but drops resolution hard while keeping fps high (the empirical lever)", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=min" }));
    expect(q.tier).toBe("min");
    expect(q.source).toBe("query");
    expect(q.shadersEnabled).toBe(true);
    expect(q.particlesEnabled).toBe(true);
    expect(q.renderScale).toBe(0.125);
    expect(q.shaderFps).toBe(30);
    expect(q.particleFps).toBe(30);
  });

  it("?quality=high forces full fidelity even on a weak device", () => {
    const q = resolveRenderQuality(
      signals({ search: "?quality=high", gpu: WEAK_GPU, hardwareConcurrency: 2, deviceMemory: 2 }),
    );
    expect(q.tier).toBe("high");
    expect(q.renderScale).toBe(1); // resolution is the fidelity lever — untouched on high
    expect(q.shaderFps).toBe(30);
  });

  // Resolution stays full on high, but the per-frame effect LOOPS are capped: uncapped meant every
  // TIME shader / spine clip re-rendered on every rAF even on an idle screen (a phone-trace idle
  // tax), and these effects are slow enough that 30fps is indistinguishable from 60.
  it("caps the high tier's per-frame effect loops at 30fps (shader, particle, spine clip)", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=high" }));
    expect(q.renderScale).toBe(1);
    expect(q.shaderFps).toBe(30);
    expect(q.particleFps).toBe(30);
    expect(q.spineClipFps).toBe(30);
  });

  it("?shaderFps=0 / ?spineClipFps=0 still mean UNCAPPED on top of the capped high tier", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=high&shaderFps=0&spineClipFps=0" }));
    expect(q.tier).toBe("high");
    expect(q.shaderFps).toBe(0);
    expect(q.spineClipFps).toBe(0);
  });
});

describe("resolveRenderQuality — auto-detect (no override)", () => {
  it("defaults a capable device to high", () => {
    const q = resolveRenderQuality(signals({ gpu: STRONG_GPU }));
    expect(q.tier).toBe("high");
    expect(q.source).toBe("default");
  });

  it("downgrades a software renderer to low", () => {
    const q = resolveRenderQuality(signals({ gpu: SOFTWARE_GPU }));
    expect(q.tier).toBe("low");
    expect(q.source).toBe("auto");
  });

  it("downgrades a positively-weak GPU to low (2-point signal)", () => {
    const q = resolveRenderQuality(signals({ gpu: WEAK_GPU, hardwareConcurrency: 16, deviceMemory: 16 }));
    expect(q.tier).toBe("low");
  });

  it("downgrades on two weak signals (few cores + little memory)", () => {
    const q = resolveRenderQuality(signals({ gpu: UNKNOWN_GPU, hardwareConcurrency: 4, deviceMemory: 4 }));
    expect(q.tier).toBe("low");
  });

  it("stays high on a single weak signal (e.g. 4-core desktop, unknown GPU, ample memory)", () => {
    const q = resolveRenderQuality(signals({ gpu: UNKNOWN_GPU, hardwareConcurrency: 4, deviceMemory: 16 }));
    expect(q.tier).toBe("high");
  });

  it("a DESKTOP never auto-selects min/off — a weak laptop stays at low", () => {
    const q = resolveRenderQuality(
      signals({ gpu: WEAK_GPU, hardwareConcurrency: 2, deviceMemory: 2 }), // mobile: undefined → desktop
    );
    expect(q.tier).toBe("low");
  });
});

describe("resolveRenderQuality — mobile auto-detect (full ladder)", () => {
  it("a weak-GPU phone auto-selects static (real shaders, frozen one frame — cheap and still correct)", () => {
    const q = resolveRenderQuality(
      signals({ gpu: WEAK_GPU, mobile: true, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("static");
    expect(q.source).toBe("auto");
    expect(q.shadersEnabled).toBe(true);
    expect(q.shadersStatic).toBe(true);
    expect(q.particlesEnabled).toBe(false);
  });

  it("a software-WebGL phone auto-selects off (CPU-rasterized shaders peg the CPU for no gain)", () => {
    const q = resolveRenderQuality(
      signals({ gpu: SOFTWARE_GPU, mobile: true, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("off");
    expect(q.shadersEnabled).toBe(false);
  });

  it("a phone with no weak signals (capable GPU, ample cores/mem) lands on low", () => {
    const q = resolveRenderQuality(
      signals({ gpu: STRONG_GPU, mobile: true, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("low");
  });

  it("a phone with a non-weak GPU but few cores/little memory lands on min", () => {
    const q = resolveRenderQuality(
      signals({ gpu: UNKNOWN_GPU, mobile: true, hardwareConcurrency: 4, deviceMemory: 4 }),
    );
    expect(q.tier).toBe("min");
  });

  it("a phone with a MASKED GPU string defaults to min even with ample cores/mem (can't confirm capable)", () => {
    const q = resolveRenderQuality(
      signals({ gpu: UNKNOWN_GPU, mobile: true, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("min");
  });

  it("the SAME signals on desktop (not mobile) only reach low, never off", () => {
    const q = resolveRenderQuality(
      signals({ gpu: WEAK_GPU, mobile: false, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("low");
  });
});

describe("resolveRenderQuality — per-field query overrides", () => {
  it("overrides renderScale / shaderFps / particleFps on top of the resolved tier", () => {
    const q = resolveRenderQuality(
      signals({ search: "?quality=low&renderScale=0.2&shaderFps=10&particleFps=8" }),
    );
    expect(q.tier).toBe("low"); // tier unchanged
    expect(q.renderScale).toBe(0.2);
    expect(q.shaderFps).toBe(10);
    expect(q.particleFps).toBe(8);
  });

  it("clamps renderScale to 0.05..1", () => {
    expect(resolveRenderQuality(signals({ search: "?renderScale=5" })).renderScale).toBe(1);
    expect(resolveRenderQuality(signals({ search: "?renderScale=0" })).renderScale).toBe(0.05);
  });

  it("?shaders=off / ?particles=off disable just that effect, tier intact", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=low&shaders=off&particles=off" }));
    expect(q.tier).toBe("low");
    expect(q.shadersEnabled).toBe(false);
    expect(q.particlesEnabled).toBe(false);
  });

  it("applies overrides on top of an AUTO-detected tier too (no explicit ?quality)", () => {
    const q = resolveRenderQuality(signals({ gpu: STRONG_GPU, search: "?renderScale=0.3" }));
    expect(q.tier).toBe("high");
    expect(q.source).toBe("default");
    expect(q.renderScale).toBe(0.3);
  });

  it("leaves the tier defaults when no override is present", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=low" }));
    expect(q.renderScale).toBe(0.5);
    expect(q.shadersEnabled).toBe(true);
  });
});

describe("resolveRenderQuality — static tier", () => {
  it("?quality=static enables frozen-frame shaders (shaders on + shadersStatic), particles off", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=static" }));
    expect(q.tier).toBe("static");
    expect(q.source).toBe("query");
    expect(q.shadersEnabled).toBe(true);
    expect(q.shadersStatic).toBe(true);
    expect(q.particlesEnabled).toBe(false);
    expect(q.renderScale).toBe(0.25); // frozen, but per-delta re-renders on a weak GPU → a low resolution floor
  });

  it("carries REAL fps caps even though it seeds particles off (the panel can turn them on)", () => {
    // This tier used to carry 0 (= UNCAPPED) for both loops on the grounds that nothing ran. Since the mirror's
    // panel can now reach dynamic shaders/particles from any live tier, an uncapped placeholder would have made
    // the same setting run HARDER on the weakest phones than on a desktop.
    const q = resolveRenderQuality(signals({ search: "?quality=static" }));
    expect(q.shaderFps).toBe(30);
    expect(q.particleFps).toBe(30);
  });

  it("animated tiers are NOT static (shadersStatic false)", () => {
    for (const tier of ["high", "low", "min"] as const) {
      const q = resolveRenderQuality(signals({ search: `?quality=${tier}` }));
      expect(q.shadersStatic).toBe(false);
    }
  });
});

describe("?shaders= / ?particles= effect-mode overrides", () => {
  it("accepts only canonical effect-mode values", () => {
    expect(resolveRenderQuality(signals({ search: "?quality=off&shaders=dynamic" })).shadersEnabled).toBe(true);
    expect(resolveRenderQuality(signals({ search: "?quality=high&shaders=off" })).shadersEnabled).toBe(false);
    for (const v of ["", "on", "1", "true", "yes", "0", "false", "no", "half", "quarter"]) {
      const q = resolveRenderQuality(signals({ search: `?quality=high&shaders=${v}` }));
      expect(q.shadersEnabled).toBe(true);
      expect(q.shadersStatic).toBe(false);
    }
  });

  it("?shaders=static → frozen shaders on (shadersEnabled + shadersStatic), tier renderScale kept", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=high&shaders=static" }));
    expect(q.shadersEnabled).toBe(true);
    expect(q.shadersStatic).toBe(true);
    expect(q.renderScale).toBe(1); // static leaves the tier's renderScale untouched
  });

  it("?shaders=dynamic-half / dynamic-quarter set the (shared) renderScale, animated", () => {
    const half = resolveRenderQuality(signals({ search: "?quality=high&shaders=dynamic-half" }));
    expect(half.shadersEnabled).toBe(true);
    expect(half.shadersStatic).toBe(false);
    expect(half.renderScale).toBe(0.5);

    const quarter = resolveRenderQuality(signals({ search: "?quality=high&particles=dynamic-quarter" }));
    expect(quarter.particlesEnabled).toBe(true);
    expect(quarter.renderScale).toBe(0.25); // renderScale is shared by both runtimes
  });

  it("an unrecognized value leaves the tier default (no override)", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=high&shaders=bogus" }));
    expect(q.shadersEnabled).toBe(true); // high-tier default, untouched
    expect(q.shadersStatic).toBe(false);
  });
});

describe("maxTextureDim (texture-upload cap)", () => {
  it("caps lower on the reduced tiers (2048) and higher on high (4096)", () => {
    expect(resolveRenderQuality(signals({ search: "?quality=high" })).maxTextureDim).toBe(4096);
    expect(resolveRenderQuality(signals({ search: "?quality=low" })).maxTextureDim).toBe(2048);
    expect(resolveRenderQuality(signals({ search: "?quality=min" })).maxTextureDim).toBe(2048);
    expect(resolveRenderQuality(signals({ search: "?quality=static" })).maxTextureDim).toBe(2048);
  });

  it("?maxTextureDim overrides the tier default (0 = native size)", () => {
    expect(resolveRenderQuality(signals({ search: "?maxTextureDim=1024" })).maxTextureDim).toBe(1024);
    expect(resolveRenderQuality(signals({ search: "?quality=high&maxTextureDim=0" })).maxTextureDim).toBe(0);
  });
});

// The ONE clamp the mirror's settings panel cannot lift (everything else the tier decides is a seed). Read by
// shaderResources' effective-mode computeds, particleAttributes' stamping gate and mirrorSettings' seeding.
describe("shadersHardOff / particlesHardOff", () => {
  it("is true only on the off tier — the ?debug auto-player and an explicit ?quality=off", () => {
    for (const search of ["?debug", "?quality=off"]) {
      const q = resolveRenderQuality(signals({ search }));
      expect(shadersHardOff(q)).toBe(true);
      expect(particlesHardOff(q)).toBe(true);
    }
  });

  it("is true for a software-WebGL PHONE (auto-resolved off) — CPU-rasterized effects buy nothing", () => {
    const q = resolveRenderQuality(signals({ gpu: SOFTWARE_GPU, mobile: true }));
    expect(q.tier).toBe("off");
    expect(shadersHardOff(q)).toBe(true);
    expect(particlesHardOff(q)).toBe(true);
  });

  it("is FALSE on every live tier — including `static`, whose particles the panel may turn on", () => {
    for (const tier of ["high", "low", "min", "static"] as const) {
      const q = resolveRenderQuality(signals({ search: `?quality=${tier}` }));
      expect(shadersHardOff(q)).toBe(false);
      expect(particlesHardOff(q)).toBe(false);
    }
    // The `static` tier is the one that matters: it SEEDS particles off, but that is a seed, not a clamp.
    expect(resolveRenderQuality(signals({ search: "?quality=static" })).particlesEnabled).toBe(false);
  });

  it("an explicit per-effect override re-opens that effect even on the off tier", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=off&shaders=dynamic" }));
    expect(q.tier).toBe("off");
    expect(shadersHardOff(q)).toBe(false); // the viewer asked for it by name
    expect(particlesHardOff(q)).toBe(true); // …and said nothing about particles
  });
});

// The STATIC backing-store scales — the one scale that is a DEVICE answer rather than a panel one. Round-2 made
// both a flat 1 and a Mali-G57 map screen went 6.5ms → 126ms StartDrawToSwapStart p50 (a frozen shader still
// re-renders per scene-delta, so fill still scales with the backing store).
describe("static effect scales", () => {
  it("a phone renders static shaders at ½ and static particles at ¼", () => {
    const phone = resolveRenderQuality(signals({ gpu: WEAK_GPU, mobile: true }));
    expect(phone.staticShaderScale).toBe(STATIC_SHADER_SCALE_MOBILE);
    expect(phone.staticParticleScale).toBe(STATIC_PARTICLE_SCALE_MOBILE);
    expect([phone.staticShaderScale, phone.staticParticleScale]).toEqual([0.5, 0.25]);
  });

  it("a desktop renders both at full resolution, on every tier", () => {
    for (const search of ["", "?quality=low", "?quality=min", "?quality=static", "?quality=high"]) {
      const desktop = resolveRenderQuality(signals({ search, gpu: WEAK_GPU }));
      expect([desktop.staticShaderScale, desktop.staticParticleScale]).toEqual([
        STATIC_SCALE_DESKTOP,
        STATIC_SCALE_DESKTOP
      ]);
    }
  });

  it("?staticScale sets both; the per-family params win over it and clamp to 0.05..1", () => {
    const shared = resolveRenderQuality(signals({ search: "?staticScale=0.35", mobile: true }));
    expect([shared.staticShaderScale, shared.staticParticleScale]).toEqual([0.35, 0.35]);

    const split = resolveRenderQuality(
      signals({ search: "?staticScale=0.35&staticShaderScale=1&staticParticleScale=0.125" })
    );
    expect([split.staticShaderScale, split.staticParticleScale]).toEqual([1, 0.125]);

    const clamped = resolveRenderQuality(signals({ search: "?staticShaderScale=4&staticParticleScale=0" }));
    expect([clamped.staticShaderScale, clamped.staticParticleScale]).toEqual([1, 0.05]);

    // Unparseable ⇒ the param never happened (the device default stands).
    const junk = resolveRenderQuality(signals({ search: "?staticScale=nope", mobile: true }));
    expect([junk.staticShaderScale, junk.staticParticleScale]).toEqual([0.5, 0.25]);
  });

  it("the DYNAMIC ½/¼ modes are unaffected — those stay the same on every device", () => {
    const phone = resolveRenderQuality(signals({ search: "?quality=high&shaders=dynamic-half", mobile: true }));
    expect(phone.renderScale).toBe(0.5);
    const desktop = resolveRenderQuality(signals({ search: "?quality=high&shaders=dynamic-half" }));
    expect(desktop.renderScale).toBe(0.5);
  });
});

describe("isAdaptiveEligible", () => {
  it("is true for a pure-auto animated tier with effects on and no pinned override", () => {
    const q = resolveRenderQuality(signals({ gpu: STRONG_GPU }));
    expect(isAdaptiveEligible(q, "")).toBe(true);
  });

  it("is false for the static tier (no per-frame loop to measure or downgrade)", () => {
    const q = resolveRenderQuality(
      signals({ gpu: WEAK_GPU, mobile: true, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("static");
    expect(isAdaptiveEligible(q, "")).toBe(false);
  });

  it("is false when a tier or per-field value is explicitly pinned", () => {
    const pinned = resolveRenderQuality(signals({ gpu: STRONG_GPU, search: "?renderScale=0.3" }));
    expect(isAdaptiveEligible(pinned, "?renderScale=0.3")).toBe(false);
  });
});

// ---- the STAGE's own pixel ratio (M0 single-canvas renderer) ----------------------------------------------------
//
// The stage's backing store is `design px × stage scale × stagePixelRatio()`, and the rule this pins is that the
// last factor is the DEVICE's, never the tier's: a quality tier may shrink an effect's offscreen target, but the
// surface the text is drawn on stays at device resolution. The godot client's "Half-res stage" lever blurred every
// glyph on the screen; this test is the structural reason that cannot recur here.

describe("stagePixelRatio", () => {
  const TIERS: RenderQualityTier[] = ["high", "low", "min", "static", "off"];

  afterEach(() => {
    vi.unstubAllGlobals();
    __setRenderQualityForTest(undefined);
  });

  it("is the DEVICE pixel ratio, identical on every quality tier", () => {
    vi.stubGlobal("devicePixelRatio", 3);
    for (const tier of TIERS) {
      // Resolve the real tier and pin it as THIS session's quality, exactly as a device would land on it.
      const quality = resolveRenderQuality(signals({ search: `?quality=${tier}`, mobile: true }));
      __setRenderQualityForTest(quality);
      expect(quality.tier).toBe(tier);
      // The tiers really do differ in what they scale — that is the point of the assertion below.
      expect(stagePixelRatio()).toBe(3);
    }
    // ...and the effect-target lever moves across those same tiers while the stage's does not.
    const high = resolveRenderQuality(signals({ search: "?quality=high" }));
    const min = resolveRenderQuality(signals({ search: "?quality=min" }));
    expect(high.renderScale).not.toBe(min.renderScale);
  });

  it("tracks whatever the device reports (a 1x desktop, a 2x phone)", () => {
    for (const dpr of [1, 1.5, 2, 2.625, 4]) {
      vi.stubGlobal("devicePixelRatio", dpr);
      expect(stagePixelRatio()).toBe(dpr);
    }
  });

  it("falls back to 1 for an absent or nonsensical ratio", () => {
    vi.stubGlobal("devicePixelRatio", undefined);
    expect(stagePixelRatio()).toBe(1);
    vi.stubGlobal("devicePixelRatio", 0);
    expect(stagePixelRatio()).toBe(1);
    vi.stubGlobal("devicePixelRatio", Number.NaN);
    expect(stagePixelRatio()).toBe(1);
  });
});
