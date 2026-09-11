import { describe, expect, it } from "vitest";

import {
  isParticleNode,
  nodeParticleAttributes,
  shaderCoverageFrom,
  shaderFlipbookFrom,
  shaderLutFrom,
  shaderPivotPxFrom
} from "@/mirror/particleAttributes";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorNode,
  type MirrorState
} from "@/mirror/sceneTree";

// Build the energy-glow GPUParticles2D node through the real delta pipeline (raw camelCase wire shape →
// normalizeParticleSpec), so the test exercises parsing + the attribute stamper together.
//
// `blendMode` is 0 (MIX), which is what the game authors this material with. It used to say 1 (add) here, and
// that single wrong digit structurally HID a whole bug class: the additive draw path derives coverage from
// luminance in its resolve pass, so an alpha-less grayscale sheet still looked right there, while the mix path
// (every affected VFX in the game) drew an opaque square. Keep this fixture on the mix path.
function glowNode(over: Record<string, unknown> = {}): MirrorNode {
  const state: MirrorState = createMirrorState();
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
            blendMode: 0,
            alphaCurve: [
              { x: 0, y: 0.353 },
              { x: 1, y: 0 }
            ],
            scaleCurve: [
              { x: 0, y: 1 },
              { x: 1, y: 0.2 }
            ]
          },
          particleEmitting: false,
          particleRestartEpoch: 0,
          ...over
        }
      ]
    })!
  );
  return state.nodes.get("glow")!;
}

describe("normalizeParticleSpec", () => {
  it("flattens the producer snapshot into gsw's ParticleSpecConfig shape", () => {
    const spec = glowNode().particleSpec!;
    expect(spec).not.toBeNull();
    expect(spec.kind).toBe("GPUParticles2D");
    expect(spec.amount).toBe(1);
    expect(spec.oneShot).toBe(true);
    expect(spec.blendMode).toBe(0);
    // vec2 snapshot → tuple; color snapshot → [r,g,b,a]; texture ref → resolved /res/ URL.
    expect(spec.gravity).toEqual([0, 0]);
    expect(spec.baseColor).toEqual([1, 0.485, 0.303, 1]);
    expect(spec.textureUrl).toBe("/res/images/vfx/common/common_glow.png");
    // curves keep their authored {x,y} points.
    expect(spec.alphaCurve).toEqual([
      { x: 0, y: 0.353 },
      { x: 1, y: 0 }
    ]);
    expect(spec.scaleCurve).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 0.2 }
    ]);
  });

  it("returns null for a non-particle node", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["x"],
        upserts: [{ id: "x", parentId: null, name: "Label", nodeType: "Label" }]
      })!
    );
    expect(state.nodes.get("x")!.particleSpec).toBeNull();
  });

  it("normalizes a CpuParticles2D background spec (stars: rect emitter, color ramp)", () => {
    // The always-on encounter-background particles are CpuParticles2D; the producer flattens them into the same
    // ParticleSpecConfig shape (scale_amount_* → scaleMin/Max, emission_rect_extents → emissionBoxExtents).
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["stars"],
        upserts: [
          {
            id: "stars",
            parentId: null,
            name: "stars",
            nodeType: "CPUParticles2D",
            particleSpec: {
              kind: "CPUParticles2D",
              amount: 160,
              lifetime: 5,
              oneShot: false,
              emissionShape: 3,
              emissionBoxExtents: { x: 1500, y: 200 },
              scaleMin: 0.01,
              scaleMax: 0.04,
              baseColor: { r: 0.83, g: 0.69, b: 0.44, a: 1, html: "#d3b070ff" },
              texture: { resourcePath: "res://images/vfx/dot.png", resourceType: "Texture2D", resourceName: "" },
              blendMode: 0,
              colorRamp: [
                { offset: 0, color: { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" } },
                { offset: 1, color: { r: 1, g: 0.5, b: 0, a: 0, html: "#ff800000" } }
              ]
            },
            particleEmitting: true,
            particleRestartEpoch: 0
          }
        ]
      })!
    );
    const spec = state.nodes.get("stars")!.particleSpec!;
    expect(spec.kind).toBe("CPUParticles2D");
    expect(spec.amount).toBe(160);
    expect(spec.emissionShape).toBe(3);
    expect(spec.emissionBoxExtents).toEqual([1500, 200]);
    expect(spec.scaleMin).toBe(0.01);
    expect(spec.textureUrl).toBe("/res/images/vfx/dot.png");
    expect(spec.colorRamp).toHaveLength(2);
    // ambient: emitting flows through to the stamped JSON.
    const binding = nodeParticleAttributes(state.nodes.get("stars")!);
    expect(JSON.parse(binding!.specsJson).emitting).toBe(true);
  });
});

describe("nodeParticleAttributes", () => {
  it("returns null for a node with no particle spec", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["x"],
        upserts: [{ id: "x", parentId: null, name: "Label", nodeType: "Label" }]
      })!
    );
    expect(nodeParticleAttributes(state.nodes.get("x")!)).toBeNull();
  });

  it("stamps the spec JSON with the live emitting flag and a burst epoch (signature seam)", () => {
    const binding = nodeParticleAttributes(glowNode({ particleEmitting: true, particleRestartEpoch: 3 }));
    expect(binding).not.toBeNull();
    const parsed = JSON.parse(binding!.specsJson);
    // The per-tick emitting flag overrides the spec placeholder, and the resolved texture URL is carried.
    expect(parsed.emitting).toBe(true);
    expect(parsed.textureUrl).toBe("/res/images/vfx/common/common_glow.png");
    // `_epoch` rides in the JSON so a restart bump changes the signature the reconciling runtime keys on.
    expect(parsed._epoch).toBe(3);
  });

  it("changes the spec signature when the restart epoch bumps (re-trigger seam)", () => {
    const a = nodeParticleAttributes(glowNode({ particleEmitting: true, particleRestartEpoch: 0 }))!.specsJson;
    const b = nodeParticleAttributes(glowNode({ particleEmitting: true, particleRestartEpoch: 1 }))!.specsJson;
    expect(a).not.toBe(b);
  });

  it("isParticleNode is true for a particle node, false otherwise", () => {
    expect(isParticleNode(glowNode())).toBe(true);
  });
});

// The energy-orb VFX, exactly as the producer streams it (captured from a live combat recording):
// `vfx_common_outward_streaks` is a 256x256 sheet of FOUR streak shapes whose flipbook lives in the
// material's SHADER (`flipbook_size = (2,2)`, `frame_count = 4`) — the NODE's hframes/vframes stay 1.
// Unmapped, gsw drew the whole sheet as one quad: a red/orange square over the orb.
const STREAKS_SHADER_PARAMS = [
  { name: "frame_count", kind: "number", number: 4 },
  { name: "flipbook_size", kind: "vector2", vector2: { x: 2, y: 2 } },
  {
    // The per-TEXEL color LUT. `common_outward_streaks.png` is a single-channel MASK; the shader does
    // `COLOR = vec4(texture(lut, texture_color.rr).rgb, erosion) * vertex_color`, so the mask's own RGB is
    // meaningless — unmapped, gsw drew it as the red/orange block. `gradientStops` are exactly what
    // `vfx_outward_streaks.tres` authors (mid grey held until 0.563, then white, interpolation_mode = 1),
    // shipped in the wire's html-only color form.
    name: "lut",
    kind: "resource",
    resource: { resourcePath: "res://materials/vfx/common/vfx_outward_streaks.tres::GradientTexture1D_85n0p" },
    gradientStops: [
      { offset: 0, color: { html: "#595959ff" } },
      { offset: 0.56302524, color: { html: "#ffffffff" } }
    ],
    gradientInterpolation: 1
  },
  { name: "pivot_offset", kind: "vector2", vector2: { x: 0, y: 0.25 } },
  { name: "erosion_offset", kind: "number", number: 0.25 }
];

function streaksNode(over: Record<string, unknown> = {}): MirrorNode {
  const state: MirrorState = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "combat",
      orderedIds: ["streaks"],
      upserts: [
        {
          id: "streaks",
          parentId: null,
          name: "vfx_common_outward_streaks",
          nodeType: "Godot.GpuParticles2D",
          shader: { resourcePath: "res://shaders/vfx/common/vfx_common_particle_shader.gdshader" },
          shaderParameters: STREAKS_SHADER_PARAMS,
          particleSpec: {
            kind: "GPUParticles2D",
            amount: 2,
            lifetime: 0.3,
            oneShot: true,
            explosiveness: 0.9,
            fixedFps: 60,
            localCoords: true,
            emissionShape: 6,
            emissionRingRadius: 100,
            emissionRingInnerRadius: 25,
            scaleMin: 0.75,
            scaleMax: 1,
            baseColor: { html: "#ffa459ff" },
            texture: { resourcePath: "res://images/vfx/common/common_outward_streaks.png" },
            textureWidth: 256,
            textureHeight: 256,
            hframes: 1,
            vframes: 1,
            animOffsetMin: 0,
            animOffsetMax: 1,
            animSpeedMin: 0,
            animSpeedMax: 0,
            blendMode: 0
          },
          particleEmitting: true,
          particleRestartEpoch: 1,
          ...over
        }
      ]
    })!
  );
  return state.nodes.get("streaks")!;
}

describe("shaderFlipbookFrom (pure)", () => {
  const size = (x: number, y: number) => ({
    name: "flipbook_size",
    kind: "vector2",
    number: null,
    bool: null,
    string: null,
    color: null,
    vector2: { x, y },
    resourcePath: null,
    vector3: null,
    vector4: null,
    rect2: null,
    transform2d: null,
    numberArray: null
  });
  const count = (n: number) => ({ ...size(0, 0), name: "frame_count", kind: "number", number: n, vector2: null });
  const curve = () => ({ ...size(0, 0), name: "flipbook_curve", kind: "resource", vector2: null });

  it("reads the grid + frame total off the shader uniforms", () => {
    expect(shaderFlipbookFrom([size(2, 2), count(4)], 1, 1)).toEqual({
      hframes: 2,
      vframes: 2,
      frameCount: 4,
      animates: false
    });
  });

  it("falls back to the full grid when frame_count is absent", () => {
    expect(shaderFlipbookFrom([size(3, 2)], 1, 1)?.frameCount).toBe(6);
  });

  it("reports a PLAYING flipbook when the shader remaps the frame over life", () => {
    expect(shaderFlipbookFrom([size(3, 2), count(6), curve()], 1, 1)?.animates).toBe(true);
  });

  it("is null without a flipbook_size uniform, and for a degenerate 1x1 grid", () => {
    expect(shaderFlipbookFrom([count(4)], 1, 1)).toBeNull();
    expect(shaderFlipbookFrom([size(1, 1), count(1)], 1, 1)).toBeNull();
    expect(shaderFlipbookFrom(null, 1, 1)).toBeNull();
    expect(shaderFlipbookFrom([], 1, 1)).toBeNull();
  });

  it("never stomps a node's OWN CanvasItemMaterial flipbook grid", () => {
    expect(shaderFlipbookFrom([size(2, 2), count(4)], 4, 1)).toBeNull();
  });
});

describe("shaderLutFrom / shaderPivotPxFrom (pure)", () => {
  // The normalized shape of the fixture's lut param, as normalizeShaderParams produces it.
  const lutParam = (over: Record<string, unknown> = {}) => ({
    name: "lut",
    kind: "resource",
    number: null,
    bool: null,
    string: null,
    color: null,
    vector2: null,
    resourcePath: "res://materials/vfx/common/vfx_outward_streaks.tres::GradientTexture1D_85n0p",
    vector3: null,
    vector4: null,
    rect2: null,
    transform2d: null,
    numberArray: null,
    gradientStops: [
      { offset: 0, color: { r: 0.35, g: 0.35, b: 0.35, a: 1, html: "#595959ff" } },
      { offset: 0.5, color: { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" } }
    ],
    gradientInterpolation: 1,
    ...over
  });

  it("maps the lut sampler's authored stops into gsw's colorLut shape", () => {
    expect(shaderLutFrom([lutParam()])).toEqual({
      stops: [
        { offset: 0, color: [0.35, 0.35, 0.35, 1] },
        { offset: 0.5, color: [1, 1, 1, 1] }
      ],
      interpolation: 1
    });
  });

  it("defaults the interpolation to LINEAR when the producer omits it (Godot's default)", () => {
    expect(shaderLutFrom([lutParam({ gradientInterpolation: null })])?.interpolation).toBe(0);
  });

  it("is null with no lut uniform, and for a lut the producer could not resolve (path only)", () => {
    // The kill-switched / older producer ships `resource` alone — the client then draws the raw
    // texture rather than inventing colors.
    expect(shaderLutFrom([lutParam({ name: "erosion_curve" })])).toBeNull();
    expect(shaderLutFrom([lutParam({ gradientStops: null })])).toBeNull();
    expect(shaderLutFrom(null)).toBeNull();
    expect(shaderLutFrom([])).toBeNull();
  });

  it("scales pivot_offset by the TEXTURE SIZE (the shader's 1/TEXTURE_PIXEL_SIZE factor)", () => {
    const pivot = {
      ...lutParam(),
      name: "pivot_offset",
      kind: "vector2",
      vector2: { x: 0, y: 0.25 },
      gradientStops: null
    };
    expect(shaderPivotPxFrom([pivot], 256, 256)).toEqual({ x: 0, y: 64 });
    // No uniform, a zero pivot, or an unknown texture size => nothing to shift.
    expect(shaderPivotPxFrom([lutParam()], 256, 256)).toBeNull();
    expect(shaderPivotPxFrom([{ ...pivot, vector2: { x: 0, y: 0 } }], 256, 256)).toBeNull();
    expect(shaderPivotPxFrom([pivot], 0, 0)).toBeNull();
  });
});

describe("shader lut / pivot → particle spec", () => {
  it("carries the LUT stops onto the spec so gsw recolors the mask instead of drawing it red", () => {
    const spec = streaksNode().particleSpec! as unknown as Record<string, unknown>;
    const stops = spec.colorLut as Array<{ offset: number; color: number[] }>;
    expect(stops).toHaveLength(2);
    expect(stops[0].offset).toBe(0);
    // The wire ships colors html-only (the scene-delta color converter), so the channels are the
    // 8-bit round-trip of the authored 0.35 grey — not the raw float.
    expect(stops[0].color[0]).toBeCloseTo(0.35, 2);
    expect(stops[1].offset).toBeCloseTo(0.563, 3);
    expect(stops[1].color).toEqual([1, 1, 1, 1]);
    // CONSTANT stops: the game holds the grey until the stop and then steps to white.
    expect(spec.colorLutInterpolation).toBe(1);
  });

  it("folds pivot_offset into the draw origin (0.25 of a 256px sheet = 64px down)", () => {
    const spec = streaksNode().particleSpec!;
    expect(spec.originX).toBe(0);
    expect(spec.originY).toBe(64);
  });

  it("omits colorLut entirely for a material with no lut sampler", () => {
    const spec = glowNode().particleSpec! as unknown as Record<string, unknown>;
    expect(spec.colorLut).toBeUndefined();
    expect(spec.colorLutInterpolation).toBeUndefined();
    expect(spec.originY).toBe(0);
  });
});

describe("shader flipbook → particle spec", () => {
  it("crops the energy-orb sheet to its 2x2 grid instead of drawing the whole sheet", () => {
    const spec = streaksNode().particleSpec!;
    expect(spec.hframes).toBe(2);
    expect(spec.vframes).toBe(2);
    expect(spec.frameCount).toBe(4);
    // Godot draws a SHADER flipbook's quad at the full texture size (only its own particles_animation
    // shrinks the quad to one cell), so the crop must not also halve the sprite.
    expect(spec.flipbookCropOnly).toBe(true);
    // This family indexes by the particle's random anim OFFSET (already streamed 0..1) and holds one
    // cell for the whole life — no curve, so no playback is synthesized.
    expect(spec.animSpeedMin).toBe(0);
    expect(spec.animSpeedMax).toBe(0);
    expect(spec.animLoop).toBe(false);
  });

  it("plays the flipbook over the particle's life when the shader has a flipbook_curve", () => {
    const spec = streaksNode({
      shaderParameters: [...STREAKS_SHADER_PARAMS, { name: "flipbook_curve", kind: "resource", resource: {} }]
    }).particleSpec!;
    expect(spec.animLoop).toBe(true);
    expect(spec.animSpeedMin).toBe(1);
    expect(spec.animSpeedMax).toBe(1);
  });

  it("leaves a node WITHOUT shader flipbook uniforms on its streamed grid", () => {
    const spec = glowNode().particleSpec!;
    expect(spec.hframes).toBe(1);
    expect(spec.vframes).toBe(1);
    expect(spec.flipbookCropOnly).toBe(false);
    expect(spec.frameCount).toBe(0);
  });

  it("keeps the crop across a volatile-only upsert that drops shaderParameters", () => {
    // `shaderParams` is volatile (absent from most ticks); the grid is baked into the STATIC spec, so
    // the memoized stamp keeps cropping instead of reverting to the whole sheet mid-burst.
    const state: MirrorState = createMirrorState();
    const node = streaksNode();
    state.nodes.set(node.id, node);
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        screenType: "combat",
        upserts: [{ id: "streaks", particleEmitting: false, particleRestartEpoch: 2 }]
      })!
    );
    const spec = state.nodes.get("streaks")!.particleSpec!;
    expect(spec.hframes).toBe(2);
    expect(spec.vframes).toBe(2);
    expect(JSON.parse(nodeParticleAttributes(state.nodes.get("streaks")!)!.specsJson).hframes).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------
// COVERAGE (where a particle shader takes its final alpha from).
//
// Half of STS2's eight common VFX shaders read coverage from the source texture's RED channel, and the sheets
// they use (common_glow, common_ring_polar_a, vfx_noise_*, common_glow_speck) are GRAYSCALE PNGs with NO alpha
// channel — a browser samples alpha = 1.0 everywhere, so gsw drew the combat energy-count orb and the creature
// status VFX as opaque SQUARES. The other four declare the SAME lut/erosion uniforms while reading tex.a, so
// the rule cannot be inferred from parameters in EITHER direction: it is keyed by shader identity.
// ---------------------------------------------------------------------------------------------------------

// A normalized MirrorShaderParam (every sibling field null) with just the bits a case needs.
function param(over: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "",
    kind: "number",
    number: null,
    bool: null,
    string: null,
    color: null,
    vector2: null,
    resourcePath: null,
    vector3: null,
    vector4: null,
    rect2: null,
    transform2d: null,
    numberArray: null,
    gradientStops: null,
    gradientInterpolation: null,
    curvePoints: null,
    ...over
  };
}

const GRAYSCALE_SHADER = "res://shaders/vfx/common/vfx_grayscale_particle_shader.gdshader";
const RING_POLAR_SHADER = "res://shaders/vfx/common/vfx_ring_polar_shader.gdshader";
const PANNING_SHADER = "res://shaders/vfx/common/vfx_panning_shader.gdshader";

describe("shaderCoverageFrom (pure)", () => {
  it("reads coverage from RED for each of the four tex.r shaders", () => {
    for (const basename of [
      "vfx_grayscale_particle_shader",
      "vfx_ring_polar_shader",
      "vfx_poof_shader",
      "vfx_round_smoke_shader"
    ]) {
      const coverage = shaderCoverageFrom(`res://shaders/vfx/common/${basename}.gdshader`, []);
      expect(coverage?.alphaFromRed, basename).toBe(true);
    }
  });

  it("leaves the tex.a shader family completely alone, LUT and erosion uniforms and all", () => {
    // The regression guard for the ~329 VFX that already render correctly: these four end in
    // `alpha = flipbook_texture_color.a * …` / `grayscale.a * vertical_alpha.r`, yet declare the very same
    // `lut` + `erosion_curve` + `erosion_offset` uniforms as the red-channel family. A parameter heuristic
    // would flip them and blow a hole through every hit-streak, smoke and ray in the game.
    const params = [
      param({ name: "lut", kind: "resource", resourcePath: "res://materials/x.tres::G" }),
      param({ name: "erosion_curve", kind: "resource", curvePoints: [{ x: 0, y: 0.3 }] }),
      param({ name: "erosion_offset", kind: "number", number: 0.25 })
    ] as never;
    for (const basename of [
      "vfx_common_particle_shader",
      "vfx_flipbook_shader",
      "vfx_row_flipbook_shader",
      "vfx_ray_shader"
    ]) {
      const coverage = shaderCoverageFrom(
        `res://shaders/vfx/common/${basename}.gdshader`,
        params
      );
      expect(coverage?.alphaFromRed ?? false, basename).toBe(false);
      expect(coverage?.uvPolar ?? false, basename).toBe(false);
    }
  });

  it("lets the panning shader's own use_red_channel_as_alpha uniform decide, both ways", () => {
    const withFlag = (value: number) =>
      shaderCoverageFrom(PANNING_SHADER, [
        param({ name: "use_red_channel_as_alpha", kind: "number", number: value })
      ] as never);
    expect(withFlag(1)?.alphaFromRed).toBe(true);
    expect(withFlag(0)?.alphaFromRed ?? false).toBe(false);
  });

  it("marks ONLY the ring shader as polar-sampled", () => {
    expect(shaderCoverageFrom(RING_POLAR_SHADER, [])?.uvPolar).toBe(true);
    expect(shaderCoverageFrom(GRAYSCALE_SHADER, [])?.uvPolar).toBe(false);
  });

  it("turns a CONSTANT (single-point) erosion curve into smoothstep factors, and skips a sweeping one", () => {
    const withCurve = (points: Array<{ x: number; y: number }>) =>
      shaderCoverageFrom(PANNING_SHADER, [
        param({ name: "use_red_channel_as_alpha", kind: "number", number: 1 }),
        param({ name: "erosion_over_lifetime", kind: "resource", curvePoints: points }),
        param({ name: "erosion_offset", kind: "number", number: 0.5 })
      ] as never);
    // The status blob's real curve: one point at (0, 0.2012), erosion_offset 0.5.
    expect(withCurve([{ x: 0, y: 0.20121944 }])?.erode).toEqual({
      threshold: 0.20121944,
      softness: 0.5
    });
    // A 2-point curve SWEEPS over the particle's life — out of scope (it would need a per-instance attribute).
    expect(
      withCurve([
        { x: 0, y: 0.499536 },
        { x: 1, y: 1 }
      ])?.erode
    ).toBeNull();
  });

  it("is null for a shader that implies nothing (and for a uid:// id with no basename)", () => {
    expect(shaderCoverageFrom("res://shaders/vfx/common/vfx_flipbook_shader.gdshader", [])).toBeNull();
    expect(shaderCoverageFrom("uid://itf5b86p54j0", [])).toBeNull();
    expect(shaderCoverageFrom(null, [])).toBeNull();
  });
});

// The energy-count orb, exactly as the producer streams it: `vfx_glow.tres` on a 128x128 GRAYSCALE
// common_glow.png, with a LUT whose only stop is WHITE. Before the coverage fix this drew a solid block —
// and the LUT made it WORSE (white block instead of a grey one), because the LUT is indexed by the same red
// channel that should have been the shape.
function orbNode(over: Record<string, unknown> = {}): MirrorNode {
  const state: MirrorState = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "combat",
      orderedIds: ["orb"],
      upserts: [
        {
          id: "orb",
          parentId: null,
          name: "vfx_common_glow",
          nodeType: "Godot.GpuParticles2D",
          selfModulate: { html: "#ff7c4dff" },
          shader: { resourcePath: GRAYSCALE_SHADER },
          shaderParameters: [
            { name: "pivot_offset", kind: "vector2", vector2: { x: 0, y: 0 } },
            {
              name: "lut",
              kind: "resource",
              resource: { resourcePath: "res://materials/vfx/common/vfx_glow.tres::GradientTexture1D_4kh46" },
              gradientStops: [{ offset: 1, color: { html: "#ffffffff" } }]
            }
          ],
          particleSpec: {
            kind: "GPUParticles2D",
            amount: 1,
            lifetime: 1,
            oneShot: true,
            scaleMin: 3.5,
            scaleMax: 3.5,
            emissionShape: 0,
            texture: { resourcePath: "res://images/vfx/common/common_glow.png" },
            textureWidth: 128,
            textureHeight: 128,
            hframes: 1,
            vframes: 1,
            blendMode: 0
          },
          particleEmitting: true,
          particleRestartEpoch: 1,
          ...over
        }
      ]
    })!
  );
  return state.nodes.get("orb")!;
}

// The creature status VFX ("power applied"): the panning shader over a grayscale noise sheet, with a
// quad-shaped mask, a constant erosion curve and an EMPTY (default black->white) gradient as its lut.
function statusBlobNode(over: Record<string, unknown> = {}): MirrorNode {
  const state: MirrorState = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "combat",
      orderedIds: ["blob"],
      upserts: [
        {
          id: "blob",
          parentId: null,
          name: "panning_noise",
          nodeType: "Godot.GpuParticles2D",
          selfModulate: { html: "#b32d2dff" },
          shader: { resourcePath: PANNING_SHADER },
          shaderParameters: [
            { name: "pivot_offset", kind: "vector2", vector2: { x: 0.1, y: 0 } },
            {
              name: "lut",
              kind: "resource",
              resource: { resourcePath: "res://materials/vfx/power_applied/x.tres::GradientTexture1D_siqtg" }
            },
            {
              name: "mask",
              kind: "resource",
              resource: { resourcePath: "res://images/vfx/power_applied/power_applied_noise_mask.png" }
            },
            {
              name: "erosion_over_lifetime",
              kind: "resource",
              resource: { resourcePath: "res://materials/vfx/power_applied/x.tres::CurveTexture_siqtg" },
              curvePoints: [{ x: 0, y: 0.20121944 }]
            },
            { name: "erosion_offset", kind: "number", number: 0.5 },
            { name: "use_red_channel_as_alpha", kind: "number", number: 1 }
          ],
          particleSpec: {
            kind: "GPUParticles2D",
            amount: 1,
            lifetime: 0.65,
            oneShot: true,
            emissionShape: 0,
            scaleMin: 1,
            scaleMax: 1,
            texture: { resourcePath: "res://images/vfx/noise/vfx_noise_1.png" },
            textureWidth: 256,
            textureHeight: 256,
            hframes: 1,
            vframes: 1,
            blendMode: 0
          },
          particleEmitting: true,
          particleRestartEpoch: 1,
          ...over
        }
      ]
    })!
  );
  return state.nodes.get("blob")!;
}

describe("shader coverage → particle spec", () => {
  it("gives the energy orb red-channel coverage ALONGSIDE its white-stop LUT", () => {
    const spec = orbNode().particleSpec! as unknown as Record<string, unknown>;
    expect(spec.alphaFromRed).toBe(true);
    // The LUT stays — it only ever decided RGB. Its single white stop is why the pre-fix orb was a WHITE
    // block rather than a grey one: coverage came from the (all-1.0) alpha channel, so the whole quad was
    // opaque and the LUT painted it white. With coverage on tex.r the glow's own falloff shapes it again and
    // the node's own tint (selfModulate #ff7c4d) colors it.
    expect(spec.colorLut).toHaveLength(1);
    // No mask sampler, no erosion curve, flat sampling.
    expect(spec.maskUrl).toBeNull();
    expect(spec.alphaErode).toBeNull();
    expect(spec.uvPolar).toBe(false);
  });

  it("gives the status blob red coverage, the resolved MASK URL and the constant erosion pair", () => {
    const spec = statusBlobNode().particleSpec! as unknown as Record<string, unknown>;
    expect(spec.alphaFromRed).toBe(true);
    // The mask res:// is resolved to the host asset route HERE (sceneTree), not in particleAttributes —
    // which must not import sceneTree (import cycle).
    expect(spec.maskUrl).toBe("/res/images/vfx/power_applied/power_applied_noise_mask.png");
    expect(spec.alphaErode).toEqual({ threshold: 0.20121944, softness: 0.5 });
    expect(spec.uvPolar).toBe(false);
    // Its lut is Godot's DEFAULT (empty) gradient, which the producer resolves to no stops at all: for a
    // grayscale sheet a black->white ramp is the identity, so dropping it changes nothing.
    expect(spec.colorLut).toBeUndefined();
  });

  it("marks the ring's spec polar so it renders as a RING, not a soft vertical bar", () => {
    const spec = orbNode({
      shader: { resourcePath: RING_POLAR_SHADER },
      shaderParameters: [
        {
          name: "erosion_curve",
          kind: "resource",
          curvePoints: [
            { x: 0, y: 0.499536 },
            { x: 1, y: 1 }
          ]
        },
        { name: "erosion_offset", kind: "number", number: 0.1 }
      ]
    }).particleSpec! as unknown as Record<string, unknown>;
    expect(spec.alphaFromRed).toBe(true);
    expect(spec.uvPolar).toBe(true);
    // Its erosion curve SWEEPS (2 points) — parked, so no constant smoothstep is invented.
    expect(spec.alphaErode).toBeNull();
  });

  it("keeps the normalizer's default coverage values for a shader that takes coverage from alpha", () => {
    const spec = streaksNode().particleSpec! as unknown as Record<string, unknown>;
    expect(spec.alphaFromRed).toBe(false);
    expect(spec.uvPolar).toBe(false);
    expect(spec.alphaErode).toBeNull();
    expect(spec.maskUrl).toBeNull();
  });

});
