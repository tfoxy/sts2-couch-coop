import { afterEach, describe, expect, it, vi } from "vitest";

import type { GodotResource } from "@godot-scene-web/core";
import type { StaticSurfacePolicy } from "@godot-scene-web/html";

import {
  __resetUnsupportedRenderCensusForTest,
  HSV_SHADER_IDS,
  mirrorParticleRenderOptions,
  mirrorShaderRenderOptions,
  noteUnsupportedRender,
  unsupportedRenderCensus,
  resolveResource,
  setStageOwnsEffectPixels,
  shaderWarmSpecs,
  stageOwnsEffectPixelsNow,
  resolveShaderSource,

} from "@/mirror/shaderResources";
import {
  __resetMirrorFramePressureForTest,
  noteMirrorFrame
} from "@/mirror/framePressure";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { staticParticlePinRatio, staticShaderPinRatio } from "@/mirror/staticPin";

const STUB_NODE = { name: "", attributes: {}, properties: {} } as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveResource", () => {
  it("resolves a sampler image ref to a /res/ url (no fetch)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const resolved = resolveResource({ type: "ExtResource", path: "res://images/x.png" }, STUB_NODE);
    expect(resolved?.url).toBe("/res/images/x.png");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the synthesized material doc stashed on the source node", () => {
    const doc: GodotResource = {
      type: "ShaderMaterial",
      properties: { shader: { type: "ExtResource", id: "shader" } },
      extResources: [{ id: "shader", path: "res://shaders/x.gdshader", attributes: {}, properties: {} }],
      subResources: [],
      header: null,
      diagnostics: []
    };
    const node = { name: "", attributes: {}, properties: {}, __mirrorDoc: doc } as never;
    const resolved = resolveResource({ type: "ExtResource", path: "mirror://shader-material" }, node);
    expect(resolved?.type).toBe("ShaderMaterial");
    expect(resolved?.document).toBe(doc);
  });

  it("returns undefined for a non-image ref with no stashed doc", () => {
    expect(resolveResource({ type: "ExtResource", path: "res://x.tres" }, STUB_NODE)).toBeUndefined();
  });
});

// ---- The frozen-surface image swap: couch-coop POLICY over gsw's generic mechanism --------------------------
//
// gsw owns the swap itself (encode, stand-in, revert, refcount, pacing, watchdog) and has its own tests for it.
// What is OURS, and what these pin, is the policy object: which gate, what happens on invalidation, how hard the
// encode may hit the main thread, and the VETO that decides which surfaces may freeze at all. Every value here
// is a decision the deleted couch-coop implementation had already paid for on device — see the long comment in
// shaderResources.ts for the evidence behind each one.

function policyOf(option: unknown): StaticSurfacePolicy {
  expect(typeof option, "the policy is an object, not a bare boolean").toBe("object");
  return option as StaticSurfacePolicy;
}

function policiesOf(): { shader: StaticSurfacePolicy; particle: StaticSurfacePolicy } {
  return {
    shader: policyOf(mirrorShaderRenderOptions.staticShaderImages),
    particle: policyOf(mirrorParticleRenderOptions.staticParticleImages)
  };
}

/** Both families' `encode` blocks, keyed by family. Most levers must reach BOTH — the two fleets are the same
 *  kind of surface and every measurement behind those numbers covered both — but R17's three do not, so the
 *  keys are needed to say which. */
function encodesByFamily(): { shader: Record<string, unknown>; particle: Record<string, unknown> } {
  const { shader, particle } = policiesOf();
  return {
    shader: (shader.encode ?? {}) as unknown as Record<string, unknown>,
    particle: (particle.encode ?? {}) as unknown as Record<string, unknown>
  };
}

/** …and the same thing as a list, for the assertions that must hold for BOTH families identically. */
function encodes(): Array<Record<string, unknown>> {
  return Object.values(encodesByFamily());
}

// R17's three particle-side encode fields, listed once so a "the shader family is untouched" assertion cannot
// drift away from the list of things that could have touched it.
const PARTICLE_ONLY_ENCODE_FIELDS = ["stillCacheBytes", "primeUnseenKeys"] as const;

describe("static-surface image swap policy", () => {
  it("wires the SAME policy into BOTH runtimes: quiet-window 1s, retry-never-block, staggered encodes", () => {
    for (const [family, option] of [
      ["shader", mirrorShaderRenderOptions.staticShaderImages],
      ["particle", mirrorParticleRenderOptions.staticParticleImages]
    ] as const) {
      const policy = policyOf(option);
      // Our effect surfaces have no usable content key (a particle system, a SCREEN_UV vignette), so the only
      // observable evidence of stability is "this surface's own draws have held still" — the Stage D window.
      expect(policy.gate).toEqual({ kind: "quiet-window", quietMs: 1000 });
      // NEVER block. gsw's default disqualifies a surface for the life of its binding the first time its
      // content key churns, and `card_ripple` — our biggest frozen family — churns its key on `width`.
      expect(policy.onInvalidate).toBe("retry");
      // rc5's 736ms main-thread park: 72 encodes kicked at once. Small-first lands the fleet of tiny particle
      // canvases early and leaves the ~4821×2156 shader monsters for their own late slices.
      // WS-5 (Aug-18 phone perf round): `deferHead: true` opts into gsw's deferred-head behavior so the
      // encode that made a surface eligible never runs inline on THAT caller's stack. `slice`/`intervalMs`
      // deliberately stay put — see shaderResources.ts for why a throughput cut is not the fix here.
      // Aug-19: `busy` adds the WHEN that `deferHead` could not — a 1ms timer still fires inside a draw
      // burst. The rest of the block is the second Aug-19 trace's answer to the fact that `slice` bounds
      // THROUGHPUT and not the main-thread PARK (285ms + 1163ms tasks, 97% self-time in native toBlob):
      // one readback per task a display frame apart, a pinned deferral bound, gsw's own slow-readback
      // backoff, and parked stills so a re-freeze of an unpainted surface pays no readback at all.
      // No `maxDim`: the clamp is fidelity-affecting and ships OFF (see its own suite below).
      // R17: `stillCacheBytes` is the ONE field the two families do not share, and it is on the particle side
      // only — the shader fleet's frames are the room-sized ones and the still pool is shared, so retaining
      // shader keys would pin megabytes and evict the particle entries R17 exists to keep.
      expect(policy.encode).toEqual({
        slice: 4,
        intervalMs: 120,
        order: "smallest-first",
        deferHead: true,
        perTask: 1,
        taskGapMs: 16,
        parkedStillBytes: 24 * 1024 * 1024,
        busy: expect.any(Function),
        busyMaxDeferMs: 4000,
        slowEncodeMs: 50,
        slowBackoffMs: 1000,
        ...(family === "particle" ? { stillCacheBytes: 8 * 1024 * 1024 } : {})
      });
      expect("maxDim" in (policy.encode ?? {}), "the clamp is absent, not zero").toBe(false);
      // …and it is OUR frame-pressure signal, not some placeholder: cold (no frame ever noted) reads quiet,
      // which is what lets a fleet freeze at all on a viewer that has not rendered yet.
      __resetMirrorFramePressureForTest();
      expect(policy.encode?.busy?.()).toBe(false);
      noteMirrorFrame();
      expect(policy.encode?.busy?.()).toBe(true);
      __resetMirrorFramePressureForTest();
    }
  });

  // ---- THE PARK BOUND (`encode.perTask`) --------------------------------------------------------------------
  //
  // The traced defect in one line: gsw drained a whole slice of readbacks back-to-back INSIDE ONE TASK, so four
  // ~4821×2156 surfaces on a saturated phone GPU made a single 1,163 ms park — while the same four encodes cost
  // 6-13 ms each once the animation ended. `slice` never bounded that; it bounds throughput per window.
  describe("perTask (the main-thread park bound)", () => {
    it("pins ONE readback per task, a display frame apart, in BOTH families", () => {
      for (const encode of encodes()) {
        expect(encode.perTask, "one readback per task — the park is now one readback long").toBe(1);
        expect(encode.taskGapMs, "16ms ≈ a 60Hz frame, so our own rAF runs between two readbacks").toBe(16);
        // Throughput is UNTOUCHED: same budget per window, finer granularity. This is the guard against
        // "buying smaller tasks by freezing fewer surfaces", which would re-introduce the live-canvas cost.
        expect(encode.slice).toBe(4);
        expect(encode.intervalMs).toBe(120);
      }
    });

  });

  // ---- THE DEFERRAL BOUND (`encode.busyMaxDeferMs`) ---------------------------------------------------------
  describe("busyMaxDeferMs (the bound that keeps deferring from ever stopping the fleet)", () => {
    it("is PINNED at 4000 — derived from the burst it has to outlast", () => {
      // Lower bound: the traced 30-card discard→draw reshuffle runs ~2-4s, and a forced readback landing in the
      // middle of one is the thing the bound exists to avoid. Upper bound: a latched predicate drains the fleet
      // at one surface per bound (72 × 4s ≈ 4.8 min of live canvases), which is why 4000 and not 10000.
      for (const encode of encodes()) {
        expect(encode.busyMaxDeferMs).toBe(4000);
      }
    });

    it("ships gsw's own slow-readback backoff underneath it: 50ms arms a 1s hold", () => {
      // The belt to the predicate's braces. Our `busy` is frame recency and a long readback SUPPRESSES the
      // frames it is made of; gsw's measurement of the previous readback cannot be faked that way. 50ms sits
      // well above the 6-13ms an unloaded readback costs here and well below the ~290ms a loaded one costs, so
      // anything between the two returns the same verdict — the number is not a tuned guess.
      for (const encode of encodes()) {
        expect(encode.slowEncodeMs).toBe(50);
        expect(encode.slowBackoffMs, "one quiet-window's worth — the wait it was already going to pay").toBe(
          1000
        );
      }
    });
  });

  // ---- THE READBACK CLAMP (`encode.maxDim`) -----------------------------------------------------------------
  //
  // No readback clamp: shrinking a stand-in changes what the player sees because it is stretched back to the
  // canvas's CSS box.
  describe("stillEncodeClamp (fidelity-affecting, hence off)", () => {
    it("is absent — no `maxDim` field at all, not `maxDim: 0`", () => {
      for (const encode of encodes()) {
        expect("maxDim" in encode).toBe(false);
      }
    });

  });

  // ---- PARKED STILLS (`encode.parkedStillBytes`) ------------------------------------------------------------
  //
  // Parking is EXACT-BY-CONSTRUCTION reuse (gsw
  // re-attaches a parked frame only while the canvas's paint count and backing size still match the stamp it was
  // encoded at, and disqualifies + revokes it otherwise), so it trades memory for readbacks and nothing else.
  // What it buys here: our quiet-window fleet reverts constantly for reasons that are NOT repaints — a
  // MirrorView `invalidateStaticSurfaces()` on a change reconcile, a dormancy wake, a watchdog trip — and each
  // one used to make the next freeze re-pay a full readback for pixels the canvas still held.
  describe("parkedStillBytes (readbacks skipped, not rescheduled)", () => {
    it("opts in at 24 MB in BOTH families", () => {
      for (const encode of encodes()) {
        expect(encode.parkedStillBytes).toBe(24 * 1024 * 1024);
      }
    });

  });

  // ---- R17: THE PARTICLE-ONLY RETAINED-STILL BLOCK ----------------------------------------------------------
  //
  // Three levers, and the first thing all three suites pin is the SAME thing: what the shader family gets. The
  // deferral apparatus above was tuned against ~4821×2156 shader readbacks, `card_ripple` churns its content key
  // on `width`, and the still pool is shared with the parked stills — so every one of these on the shader side
  // is either worthless or actively harmful, and "the shader policy is untouched" has to be a pin rather than a
  // reading of the diff.
  describe("R17: the shader family's policy remains distinct", () => {
    it("carries no `keyedQuietMs`, no `stillCacheBytes` and no `primeUnseenKeys`", () => {
      const { shader } = policiesOf();
      expect(shader.gate).toEqual({ kind: "quiet-window", quietMs: 1000 });
      for (const field of PARTICLE_ONLY_ENCODE_FIELDS) {
        expect(field in (shader.encode ?? {}), `${field} must never reach the shader fleet`).toBe(false);
      }
    });

  });

  // ---- gsw's retained KEYED still pool ---------------------------------------------------------------------
  //
  // The R17 addition serves card flights and the STATIC effect-mode particle fleet: it
  // serves the STATIC effect-mode particle fleet, which is the tier a phone viewer actually ships with. A
  // retained entry is claimable by KEY, so its bytes serve every surface that ever reaches that frame rather
  // than the one surface that parked it.
  describe("stillCacheBytes (the retained keyed still pool)", () => {
    it("opts in at 8 MB on the PARTICLE side and nowhere else", () => {
      const { shader, particle } = encodesByFamily();
      expect(particle.stillCacheBytes).toBe(8 * 1024 * 1024);
      expect("stillCacheBytes" in shader).toBe(false);
    });

  });

  describe("primeUnseenKeys (off, because the deferral it skips was tuned for the OTHER fleet)", () => {
    it("is absent in both families", () => {
      const { shader, particle } = encodesByFamily();
      expect("primeUnseenKeys" in particle).toBe(false);
      expect("primeUnseenKeys" in shader).toBe(false);
    });

  });

  // THE VETO — the load-bearing half of this migration. The deleted mechanism only ever targeted families in
  // STATIC effect mode. A quiet-window gate has no such notion, so without this a DYNAMIC-mode surface that
  // merely happened to be quiet for a second would be frozen into an `<img>` — an animation that paused briefly
  // would stop permanently.
  describe("canFreezeSurface (the static-mode veto)", () => {
    const node = document.createElement("div");
    const canvas = document.createElement("canvas");
    const veto = (option: unknown): boolean =>
      policyOf(option).canFreezeSurface!(node, canvas);
    const shaderVeto = (): boolean => veto(mirrorShaderRenderOptions.staticShaderImages);
    const particleVeto = (): boolean => veto(mirrorParticleRenderOptions.staticParticleImages);

    afterEach(() => {
      mirrorSettings.shaderMode = "static";
      mirrorSettings.particleMode = "static";
    });

    it("permits a freeze ONLY in static mode — every dynamic mode is refused", () => {
      mirrorSettings.shaderMode = "static";
      expect(shaderVeto()).toBe(true);
      for (const mode of ["dynamic", "dynamic-half", "dynamic-quarter", "off"] as const) {
        mirrorSettings.shaderMode = mode;
        expect(shaderVeto(), `shader mode ${mode} must never freeze a surface`).toBe(false);
      }
    });

    it("is read LIVE, so a mode change takes effect without rebuilding the options object", () => {
      mirrorSettings.shaderMode = "static";
      expect(shaderVeto()).toBe(true);
      mirrorSettings.shaderMode = "dynamic";
      expect(shaderVeto()).toBe(false);
      mirrorSettings.shaderMode = "static";
      expect(shaderVeto()).toBe(true);
    });

    it("is PER FAMILY: a dynamic shader fleet does not stop the static particle fleet freezing", () => {
      mirrorSettings.shaderMode = "dynamic";
      mirrorSettings.particleMode = "static";
      expect(shaderVeto()).toBe(false);
      expect(particleVeto()).toBe(true);

      mirrorSettings.shaderMode = "static";
      mirrorSettings.particleMode = "dynamic";
      expect(shaderVeto()).toBe(true);
      expect(particleVeto()).toBe(false);
    });

    // M2 ADDS A THIRD TERM, and it is a refusal that outranks both of the others: when the STAGE owns effect
    // pixels, nothing may freeze at all. The
    // swap trades a readback for the removal of a compositor layer, and on that stage an effect host has no layer
    // to remove — it is `visibility: hidden` and its pixels are a quad in the draw list. Measured on the live
    // combat room in STATIC mode: 2 shader captures, 134.7 ms, both BLANK.
    describe("M2: the canvas stage owns the pixels", () => {
      afterEach(() => {
        setStageOwnsEffectPixels(false);
      });

      it("defaults to off, so a DOM-stage page is untouched", () => {
        expect(stageOwnsEffectPixelsNow()).toBe(false);
        mirrorSettings.shaderMode = "static";
        mirrorSettings.particleMode = "static";
        expect(shaderVeto()).toBe(true);
        expect(particleVeto()).toBe(true);
      });

      it("refuses BOTH families in the mode that would otherwise freeze everything", () => {
        mirrorSettings.shaderMode = "static";
        mirrorSettings.particleMode = "static";
        setStageOwnsEffectPixels(true);
        expect(shaderVeto(), "a static shader fleet on the canvas stage").toBe(false);
        expect(particleVeto(), "a static particle fleet on the canvas stage").toBe(false);
      });

      it("is read LIVE, like the two terms it guards", () => {
        mirrorSettings.shaderMode = "static";
        setStageOwnsEffectPixels(true);
        expect(shaderVeto()).toBe(false);
        setStageOwnsEffectPixels(false);
        expect(shaderVeto()).toBe(true);
      });
    });

  });
});

// The frozen-surface backing pin's SEED: both construction option objects carry the device target from the
// start, so a binding created before MirrorView's first frame measurement is never sized at
// `dpr × renderScale` and then re-sized. MirrorView owns the live correction (mirrorViewStaticPin.spec).
describe("static backing pin seed", () => {
  it("seeds BOTH runtimes' construction options from the shared tracker", () => {
    expect(mirrorShaderRenderOptions.staticShaderPixelRatio).toBe(staticShaderPinRatio());
    expect(mirrorParticleRenderOptions.staticParticlePixelRatio).toBe(staticParticlePinRatio());
    // In jsdom `screen.width/height` are 0, so there is no seed to give — and `undefined` is exactly gsw's
    // un-pinned path, i.e. a browser that reports no screen keeps today's behaviour until the first real
    // landscape measurement corrects the target (mirrorViewStaticPin.spec drives that with a stubbed screen).
    expect(mirrorShaderRenderOptions.staticShaderPixelRatio).toBeUndefined();
  });
});

describe("resolveShaderSource", () => {
  it("fetches the .gdshader text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "shader_type canvas_item;"
    } as Response);
    await expect(resolveShaderSource("res://shaders/card_ripple.gdshader")).resolves.toBe(
      "shader_type canvas_item;"
    );
  });

  it("returns undefined for a missing path or non-OK response", async () => {
    await expect(resolveShaderSource(undefined)).resolves.toBeUndefined();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false } as Response);
    await expect(resolveShaderSource("res://shaders/x.gdshader")).resolves.toBeUndefined();
  });
});

// --- unrenderable effects, counted (S4/D4) ----------------------------------------------------------------------
//
// gsw falls back to a node's CSS/SVG paint for any shader or particle it cannot run, which is correct and
// invisible — a shader that has never once rendered looks exactly like one with nothing to do. These pin the two
// halves of the wiring: that BOTH option families carry the reporter, and that supplying it does not make the
// failure quieter than gsw's own default sink.
describe("unrenderable effects are counted, and still warn", () => {
  afterEach(() => {
    __resetUnsupportedRenderCensusForTest();
    vi.restoreAllMocks();
  });

  it("wires the reporter into BOTH option families", () => {
    // The particle half matters as much as the shader half: a malformed spec degrades just as quietly.
    expect(mirrorShaderRenderOptions.onUnsupported).toBe(noteUnsupportedRender);
    expect(mirrorParticleRenderOptions.onUnsupported).toBe(noteUnsupportedRender);
  });

  it("counts by kind:reason, samples the offenders, and starts empty", () => {
    __resetUnsupportedRenderCensusForTest();
    expect(unsupportedRenderCensus()).toEqual({ total: 0, byReason: {}, ids: [] });

    vi.spyOn(console, "warn").mockImplementation(() => {});
    noteUnsupportedRender({ kind: "shader", id: "res://shaders/wind_sway.gdshader", reason: "unsupported shader construct" });
    noteUnsupportedRender({ kind: "shader", id: "uid://abc", reason: "unsupported shader construct" });
    noteUnsupportedRender({ kind: "particle", id: "/root/Game/Fx", reason: "malformed particle spec" });

    const census = unsupportedRenderCensus();
    expect(census.total).toBe(3);
    expect(census.byReason).toEqual({
      "shader:unsupported shader construct": 2,
      "particle:malformed particle spec": 1
    });
    expect(census.ids).toEqual(["res://shaders/wind_sway.gdshader", "uid://abc", "/root/Game/Fx"]);
  });

  it("RE-EMITS the warn — supplying a reporter must not make the failure quieter", () => {
    // gsw's default sink is a deduped `console.warn`, and it routes to `onUnsupported` INSTEAD of it. Wiring a
    // reporter that stays silent would have made this round's net effect "the failure got harder to notice".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteUnsupportedRender({ kind: "shader", id: "res://shaders/wind_sway.gdshader", reason: "unsupported shader construct" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("wind_sway");
    expect(String(warn.mock.calls[0][0])).toContain("unsupported shader construct");

    // …and an error-bearing report carries its message, exactly as gsw's own sink formats it.
    noteUnsupportedRender({
      kind: "shader",
      id: "res://shaders/x.gdshader",
      reason: "shader transpile error",
      error: new Error("no fragment()")
    });
    expect(String(warn.mock.calls[1][0])).toContain("(no fragment())");
  });

  it("hands back a COPY — a reader cannot edit the counters", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    noteUnsupportedRender({ kind: "shader", id: "a", reason: "r" });
    const first = unsupportedRenderCensus();
    first.ids.push("forged");
    first.byReason["shader:r"] = 99;
    expect(unsupportedRenderCensus()).toEqual({ total: 1, byReason: { "shader:r": 1 }, ids: ["a"] });
  });

  it("bounds the id sample while still counting every report", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 40; i++) {
      noteUnsupportedRender({ kind: "shader", id: `res://s${i}.gdshader`, reason: "unsupported shader construct" });
    }
    const census = unsupportedRenderCensus();
    expect(census.total).toBe(40);
    expect(census.byReason["shader:unsupported shader construct"]).toBe(40);
    expect(census.ids).toHaveLength(8); // UNSUPPORTED_ID_SAMPLE — a name for a bug report, not a growing list
  });

  it("publishes the harness seam without touching MirrorView's mount", () => {
    const read = (window as unknown as { __mirrorEffectUnsupported?: () => unknown }).__mirrorEffectUnsupported;
    expect(typeof read).toBe("function");
    expect(read!()).toEqual(unsupportedRenderCensus());
  });
});

describe("effects renderer", () => {
  it("leaves backend selection to gsw for both runtime families", () => {
    expect(mirrorShaderRenderOptions.effectsRenderer).toBe("auto");
    expect(mirrorParticleRenderOptions.effectsRenderer).toBe("auto");
  });
});

// SHADER WARMING. A cold link BLOCKS on a device with no `KHR_parallel_shader_compile`, and the
// phone this was measured on has none — 90.3 ms of `getProgramParameter` mid-combat. `shaderWarmSpecs` decides
// WHICH shaders gsw is asked to link ahead of the node that needs them; it cannot make a link cheaper, only
// earlier. These pin the lever, not the timing.
describe("shaderWarmSpecs", () => {
  it("names the mid-combat WebGL shaders, keyed the way the stamper keys them", () => {
    const specs = shaderWarmSpecs();
    expect(specs.length).toBeGreaterThan(0);
    // `shaderKey` MUST equal the resource path: that is what gsw derives from `data-godot-shader-path`, so a
    // warm keyed any other way compiles a program the create path then fails to find — a pure waste of 90 ms.
    for (const spec of specs) {
      expect(spec.shaderKey).toBe(spec.path);
      expect(spec.path.startsWith("res://")).toBe(true);
    }
    expect(specs.map((s) => s.path)).toContain("res://shaders/card_ripple.gdshader");
  });

  it("never warms the HSV family, which does not reach WebGL at all", () => {
    const specs = shaderWarmSpecs();
    // Diverted to a CSS colour-matrix (see `hsvAdjustShaderIds`), so linking one would cost a block for a
    // program nothing will ever bind.
    for (const id of HSV_SHADER_IDS) {
      expect(specs.map((s) => s.shaderKey)).not.toContain(id);
    }
  });

});
