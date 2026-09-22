import { afterEach, describe, expect, it, vi } from "vitest";

import type { GpuInfo } from "@godot-scene-web/html";

import {
  detectedRenderQualityTier,
  isAdaptiveEligible,
  parseRenderQualityTier,
  particlesHardOff,
  resolveRenderQuality,
  shadersHardOff,
  stagePixelRatio,
  __resetDetectedTierForTest,
  __setRenderQualityForTest,
  RENDER_QUALITY_TIERS,
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
  it("?debug forces the minimum tier (auto-player parity), even with ?quality=high", () => {
    const q = resolveRenderQuality(signals({ search: "?debug&quality=high" }));
    expect(q.tier).toBe("minimum");
    expect(q.source).toBe("debug");
    expect(q.shadersEnabled).toBe(false);
    expect(q.particlesEnabled).toBe(false);
  });

  it("?quality=minimum disables shaders + particles", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=minimum" }));
    expect(q.tier).toBe("minimum");
    expect(q.source).toBe("query");
    expect(q.shadersEnabled).toBe(false);
    expect(q.particlesEnabled).toBe(false);
  });

  it("?quality=medium keeps effects but halves resolution and caps FPS", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=medium" }));
    expect(q.tier).toBe("medium");
    expect(q.source).toBe("query");
    expect(q.shadersEnabled).toBe(true);
    expect(q.particlesEnabled).toBe(true);
    expect(q.renderScale).toBe(0.5);
    expect(q.shaderFps).toBe(30);
    // RESOLUTION is the per-tier lever; the fps caps are the SAME on every live tier so that a given panel effect
    // mode paces identically on a phone and a desktop (was 25 here and on `low`).
    expect(q.particleFps).toBe(30);
  });

  it("?quality=low keeps effects on but drops resolution hard while keeping fps high (the empirical lever)", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=low" }));
    expect(q.tier).toBe("low");
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
    expect(q.tier).toBe("medium");
    expect(q.source).toBe("auto");
  });

  it("downgrades a positively-weak GPU to low (2-point signal)", () => {
    const q = resolveRenderQuality(signals({ gpu: WEAK_GPU, hardwareConcurrency: 16, deviceMemory: 16 }));
    expect(q.tier).toBe("medium");
  });

  it("downgrades on two weak signals (few cores + little memory)", () => {
    const q = resolveRenderQuality(signals({ gpu: UNKNOWN_GPU, hardwareConcurrency: 4, deviceMemory: 4 }));
    expect(q.tier).toBe("medium");
  });

  it("stays high on a single weak signal (e.g. 4-core desktop, unknown GPU, ample memory)", () => {
    const q = resolveRenderQuality(signals({ gpu: UNKNOWN_GPU, hardwareConcurrency: 4, deviceMemory: 16 }));
    expect(q.tier).toBe("high");
  });

  it("a DESKTOP never auto-selects the bottom rungs — a weak laptop stays at medium", () => {
    const q = resolveRenderQuality(
      signals({ gpu: WEAK_GPU, hardwareConcurrency: 2, deviceMemory: 2 }), // mobile: undefined → desktop
    );
    expect(q.tier).toBe("medium");
  });
});

describe("resolveRenderQuality — mobile auto-detect (full ladder)", () => {
  it("a weak-GPU phone auto-selects static (real shaders, frozen one frame — cheap and still correct)", () => {
    const q = resolveRenderQuality(
      signals({ gpu: WEAK_GPU, mobile: true, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("very-low");
    expect(q.source).toBe("auto");
    expect(q.shadersEnabled).toBe(true);
    expect(q.shadersStatic).toBe(true);
    expect(q.particlesEnabled).toBe(false);
  });

  it("a software-WebGL phone auto-selects off (CPU-rasterized shaders peg the CPU for no gain)", () => {
    const q = resolveRenderQuality(
      signals({ gpu: SOFTWARE_GPU, mobile: true, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("minimum");
    expect(q.shadersEnabled).toBe(false);
  });

  it("a phone with no weak signals (capable GPU, ample cores/mem) lands on low", () => {
    const q = resolveRenderQuality(
      signals({ gpu: STRONG_GPU, mobile: true, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("medium");
  });

  it("a phone with a non-weak GPU but few cores/little memory lands on min", () => {
    const q = resolveRenderQuality(
      signals({ gpu: UNKNOWN_GPU, mobile: true, hardwareConcurrency: 4, deviceMemory: 4 }),
    );
    expect(q.tier).toBe("low");
  });

  it("a phone with a MASKED GPU string defaults to min even with ample cores/mem (can't confirm capable)", () => {
    const q = resolveRenderQuality(
      signals({ gpu: UNKNOWN_GPU, mobile: true, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("low");
  });

  it("the SAME signals on desktop (not mobile) only reach low, never off", () => {
    const q = resolveRenderQuality(
      signals({ gpu: WEAK_GPU, mobile: false, hardwareConcurrency: 8, deviceMemory: 8 }),
    );
    expect(q.tier).toBe("medium");
  });
});

describe("resolveRenderQuality — per-field query overrides", () => {
  it("overrides renderScale / shaderFps / particleFps on top of the resolved tier", () => {
    const q = resolveRenderQuality(
      signals({ search: "?quality=medium&renderScale=0.2&shaderFps=10&particleFps=8" }),
    );
    expect(q.tier).toBe("medium"); // tier unchanged
    expect(q.renderScale).toBe(0.2);
    expect(q.shaderFps).toBe(10);
    expect(q.particleFps).toBe(8);
  });

  it("clamps renderScale to 0.05..1", () => {
    expect(resolveRenderQuality(signals({ search: "?renderScale=5" })).renderScale).toBe(1);
    expect(resolveRenderQuality(signals({ search: "?renderScale=0" })).renderScale).toBe(0.05);
  });

  it("?shaders=off / ?particles=off disable just that effect, tier intact", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=medium&shaders=off&particles=off" }));
    expect(q.tier).toBe("medium");
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
    const q = resolveRenderQuality(signals({ search: "?quality=medium" }));
    expect(q.renderScale).toBe(0.5);
    expect(q.shadersEnabled).toBe(true);
  });
});

describe("resolveRenderQuality — static tier", () => {
  it("?quality=very-low enables frozen-frame shaders (shaders on + shadersStatic), particles off", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=very-low" }));
    expect(q.tier).toBe("very-low");
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
    const q = resolveRenderQuality(signals({ search: "?quality=very-low" }));
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
    expect(resolveRenderQuality(signals({ search: "?quality=minimum&shaders=dynamic" })).shadersEnabled).toBe(true);
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
    expect(resolveRenderQuality(signals({ search: "?quality=medium" })).maxTextureDim).toBe(2048);
    expect(resolveRenderQuality(signals({ search: "?quality=low" })).maxTextureDim).toBe(2048);
    expect(resolveRenderQuality(signals({ search: "?quality=very-low" })).maxTextureDim).toBe(2048);
  });

  it("?maxTextureDim overrides the tier default (0 = native size)", () => {
    expect(resolveRenderQuality(signals({ search: "?maxTextureDim=1024" })).maxTextureDim).toBe(1024);
    expect(resolveRenderQuality(signals({ search: "?quality=high&maxTextureDim=0" })).maxTextureDim).toBe(0);
  });
});

// The ONE clamp the mirror's settings panel cannot lift (everything else the tier decides is a seed). Read by
// shaderResources' effective-mode computeds, particleAttributes' stamping gate and mirrorSettings' seeding.
describe("shadersHardOff / particlesHardOff", () => {
  it("is true only on the minimum tier — the ?debug auto-player and an explicit ?quality=minimum", () => {
    for (const search of ["?debug", "?quality=minimum"]) {
      const q = resolveRenderQuality(signals({ search }));
      expect(shadersHardOff(q)).toBe(true);
      expect(particlesHardOff(q)).toBe(true);
    }
  });

  it("is true for a software-WebGL PHONE (auto-resolved off) — CPU-rasterized effects buy nothing", () => {
    const q = resolveRenderQuality(signals({ gpu: SOFTWARE_GPU, mobile: true }));
    expect(q.tier).toBe("minimum");
    expect(shadersHardOff(q)).toBe(true);
    expect(particlesHardOff(q)).toBe(true);
  });

  it("is FALSE on every live tier — including `static`, whose particles the panel may turn on", () => {
    for (const tier of ["high", "low", "min", "static"] as const) {
      const q = resolveRenderQuality(signals({ search: `?quality=${tier}` }));
      expect(shadersHardOff(q)).toBe(false);
      expect(particlesHardOff(q)).toBe(false);
    }
    // The `very-low` tier is the one that matters: it SEEDS particles off, but that is a seed, not a clamp.
    expect(resolveRenderQuality(signals({ search: "?quality=very-low" })).particlesEnabled).toBe(false);
  });

  it("an explicit per-effect override re-opens that effect even on the minimum tier", () => {
    const q = resolveRenderQuality(signals({ search: "?quality=minimum&shaders=dynamic" }));
    expect(q.tier).toBe("minimum");
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
    for (const search of ["", "?quality=medium", "?quality=low", "?quality=very-low", "?quality=high"]) {
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
    expect(q.tier).toBe("very-low");
    expect(isAdaptiveEligible(q, "")).toBe(false);
  });

  it("is false when a tier or per-field value is explicitly pinned", () => {
    const pinned = resolveRenderQuality(signals({ gpu: STRONG_GPU, search: "?renderScale=0.3" }));
    expect(isAdaptiveEligible(pinned, "?renderScale=0.3")).toBe(false);
  });

  it("is false once the viewer has PICKED a rung in the panel — detection stops for that device", () => {
    // The other half of "auto-detect stops once quality is set": not only does the stored rung beat autoTier
    // below, the live downgrade sampler stands down too, so nothing keeps ratcheting under a deliberate choice.
    const stored = resolveRenderQuality(signals({ gpu: STRONG_GPU, storedQuality: "high" }));
    expect(stored.source).toBe("stored");
    expect(isAdaptiveEligible(stored, "")).toBe(false);
  });
});

// THE LADDER RENAME (high/low/min/static/off → high/medium/low/very-low/minimum). Three old spellings map
// cleanly onto rungs and are still accepted; `low` is the one that cannot be, because it now names the rung
// below the one it used to.
describe("parseRenderQualityTier", () => {
  it("accepts every current rung, case-insensitively", () => {
    for (const tier of RENDER_QUALITY_TIERS) {
      expect(parseRenderQualityTier(tier)).toBe(tier);
      expect(parseRenderQualityTier(tier.toUpperCase())).toBe(tier);
    }
  });

  it("maps the three legacy spellings onto the SAME configuration they used to select", () => {
    expect(parseRenderQualityTier("min")).toBe("low");
    expect(parseRenderQualityTier("static")).toBe("very-low");
    expect(parseRenderQualityTier("off")).toBe("minimum");
  });

  it("keeps a legacy link's behaviour identical, field for field", () => {
    const legacy = resolveRenderQuality(signals({ search: "?quality=static" }));
    const renamed = resolveRenderQuality(signals({ search: "?quality=very-low" }));
    expect(legacy).toEqual(renamed);
    expect(resolveRenderQuality(signals({ search: "?quality=off" })).tier).toBe("minimum");
    expect(shadersHardOff(resolveRenderQuality(signals({ search: "?quality=off" })))).toBe(true);
  });

  it("rejects anything else, so a junk param falls through to detection", () => {
    for (const raw of ["", "minimal", "very low", "veryLow", "nope", null, undefined]) {
      expect(parseRenderQualityTier(raw)).toBeNull();
    }
    expect(resolveRenderQuality(signals({ search: "?quality=nope", gpu: STRONG_GPU })).source).toBe("default");
  });
});

// THE PANEL'S SAVED CHOICE as this device's tier — the settings-panel half of the same setting lives in
// qualityPreset.spec.ts.
describe("resolveRenderQuality — the viewer's saved quality", () => {
  it("beats auto-detection, and says so in `source`", () => {
    const detected = resolveRenderQuality(signals({ gpu: WEAK_GPU, mobile: true }));
    expect(detected.tier).toBe("very-low");
    const chosen = resolveRenderQuality(signals({ gpu: WEAK_GPU, mobile: true, storedQuality: "high" }));
    expect(chosen.tier).toBe("high");
    expect(chosen.source).toBe("stored");
    // …and it really carries that rung's device levers, not just its name.
    expect(chosen.maxTextureDim).toBe(4096);
    expect(chosen.spineClipsEnabled).toBe(true);
  });

  it("loses to `?quality=` and to `?debug` — a QA link still describes the page it opens", () => {
    const url = resolveRenderQuality(signals({ storedQuality: "high", search: "?quality=low" }));
    expect([url.tier, url.source]).toEqual(["low", "query"]);
    const debug = resolveRenderQuality(signals({ storedQuality: "high", search: "?debug" }));
    expect([debug.tier, debug.source]).toEqual(["minimum", "debug"]);
  });

  it("falls through to detection for `auto`, for junk, and for a non-string", () => {
    for (const storedQuality of ["auto", "AUTO", "nonsense", 7, null, undefined, {}]) {
      const q = resolveRenderQuality(signals({ gpu: STRONG_GPU, storedQuality }));
      expect([q.tier, q.source]).toEqual(["high", "default"]);
    }
  });

  it("accepts a rung saved under its pre-rename name", () => {
    expect(resolveRenderQuality(signals({ storedQuality: "static" })).tier).toBe("very-low");
  });
});

describe("detectedRenderQualityTier", () => {
  afterEach(() => __resetDetectedTierForTest());

  it("reports what the DEVICE would be judged as, ignoring the URL and the saved choice", () => {
    // This is the rung the panel prints in its Auto entry ("Auto (Medium)"), so it must describe the hardware
    // rather than whatever is currently overriding it — otherwise the entry would just echo the override.
    vi.stubGlobal("navigator", { hardwareConcurrency: 2, deviceMemory: 2, userAgent: "Mozilla/5.0" });
    vi.stubGlobal("window", { location: { search: "?quality=high" } });
    expect(detectedRenderQualityTier()).toBe("medium");
    vi.unstubAllGlobals();
  });
});

// ---- the STAGE's own pixel ratio (M0 single-canvas renderer) ----------------------------------------------------
//
// The stage's backing store is `design px × stage scale × stagePixelRatio()`, and the rule this pins is that the
// last factor is the DEVICE's, never the tier's: a quality tier may shrink an effect's offscreen target, but the
// surface the text is drawn on stays at device resolution. The godot client's "Half-res stage" lever blurred every
// glyph on the screen; this test is the structural reason that cannot recur here.

describe("stagePixelRatio", () => {
  const TIERS: RenderQualityTier[] = ["high", "medium", "low", "very-low", "minimum"];

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
    const low = resolveRenderQuality(signals({ search: "?quality=low" }));
    expect(high.renderScale).not.toBe(low.renderScale);
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
