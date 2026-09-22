// Bridges a mirror particle node into gsw's particle runtime. The producer streams the system flattened into
// gsw's ParticleSpecConfig shape (on `node.particleSpec`, with the texture URL already resolved); this stamps it
// as the `data-godot-particle-specs` JSON blob the runtime parses. The live `emitting` flag and a `_epoch`
// burst counter are folded into the JSON so a change to either changes the spec SIGNATURE — which is how the
// reconciling runtime knows to re-trigger a one-shot burst (re-init that node's simulation) without resetting
// unrelated systems. `_epoch` is an extra key gsw ignores; it only exists to vary the signature.

import { particlesHardOff, renderQuality } from "@/render/quality";
import { bakedStillCoversNode } from "@/mirror/bakedEffects";
import type { MirrorNode, MirrorShaderParam } from "@/mirror/sceneTree";

export interface MirrorParticleBinding {
  specsJson: string;
}

// A flipbook that lives in the particle material's SHADER rather than in a CanvasItemMaterial.
// STS2's VFX shaders (`vfx_common_particle_shader`, `vfx_flipbook_shader`, `vfx_row_flipbook_shader`)
// take `flipbook_size` + `frame_count` uniforms and crop the sheet themselves, so the NODE's own
// `hframes`/`vframes` stay 1 — and gsw, which only knows the node-level grid, drew the whole sprite
// sheet as one quad (the energy orb's 2x2 `common_outward_streaks.png` rendered as an orange square).
export interface ShaderFlipbook {
  hframes: number;
  vframes: number;
  /** Authored frame total; may be fewer than the grid holds (gsw wraps the index into the cells). */
  frameCount: number;
  /** The shader remaps the frame over the particle's life (a `flipbook_curve`), i.e. it PLAYS. */
  animates: boolean;
}

function paramNumber(params: MirrorShaderParam[], name: string): number | null {
  const found = params.find((param) => param.name === name);
  return found && typeof found.number === "number" ? found.number : null;
}

/**
 * The shader-driven flipbook a particle node's material declares, or null when there is none.
 *
 * Null when: no `flipbook_size` uniform, a degenerate 1x1 grid, or the node ALREADY carries its own
 * `hframes`/`vframes` — a real `CanvasItemMaterial.particles_animation` grid is authoritative and
 * must not be stomped (it also sizes the sprite differently; see gsw's `flipbookCropOnly`).
 *
 * `animates` keys off a `flipbook_curve` uniform: the shaders that have one advance the frame over
 * the particle's life (`frame_count * curve(life)`), while the ones that don't
 * (`vfx_common_particle_shader`) index purely by the particle's random anim OFFSET — one cell held
 * for the whole life. Both ride gsw's offset/speed model once the grid is known.
 */
export function shaderFlipbookFrom(
  params: MirrorShaderParam[] | null | undefined,
  nodeHframes: number,
  nodeVframes: number
): ShaderFlipbook | null {
  if (!params || params.length === 0) {
    return null;
  }
  if (nodeHframes > 1 || nodeVframes > 1) {
    return null; // the node's own CanvasItemMaterial flipbook wins
  }
  const size = params.find((param) => param.name === "flipbook_size")?.vector2;
  if (!size) {
    return null;
  }
  const hframes = Math.max(1, Math.round(size.x));
  const vframes = Math.max(1, Math.round(size.y));
  if (hframes * vframes <= 1) {
    return null; // a 1x1 "grid" is not a flipbook
  }
  const declared = paramNumber(params, "frame_count");
  const frameCount =
    declared != null && declared >= 1 ? Math.round(declared) : hframes * vframes;
  return {
    hframes,
    vframes,
    frameCount,
    animates: params.some((param) => param.name === "flipbook_curve")
  };
}

// A per-TEXEL color LUT declared by the particle material's SHADER, in gsw's `colorLut` shape.
//
// STS2's whole VFX particle-shader family ends in
// `COLOR = vec4(texture(lut, texture_color.rr).rgb, erosion) * vertex_color`: the sprite sheet is a
// single-channel MASK and the `lut` GradientTexture1D holds the real colors, looked up per texel by the
// source's RED channel (NOT a color-over-life ramp — that is `colorRamp`, a separate, per-particle thing).
// Without it gsw drew the mask's own RGB, i.e. the energy orb / hit streaks as a red-orange block.
export interface ShaderColorLut {
  stops: Array<{ offset: number; color: [number, number, number, number] }>;
  /** Godot `Gradient.interpolation_mode`: 0 linear, 1 constant (stepped — how STS2 authors these). */
  interpolation: number;
}

export function shaderLutFrom(
  params: MirrorShaderParam[] | null | undefined
): ShaderColorLut | null {
  if (!params || params.length === 0) {
    return null;
  }
  const lut = params.find((param) => param.name === "lut");
  const raw = lut?.gradientStops;
  if (!raw || raw.length === 0) {
    return null;
  }
  const stops = raw.map((stop) => ({
    offset: stop.offset,
    color: [
      stop.color?.r ?? 1,
      stop.color?.g ?? 1,
      stop.color?.b ?? 1,
      stop.color?.a ?? 1
    ] as [number, number, number, number]
  }));
  return { stops, interpolation: lut?.gradientInterpolation ?? 0 };
}

// The shader's `pivot_offset` uniform, in PIXELS, or null when absent/zero.
//
// The vertex stage does `VERTEX += pivot_offset * (1.0 / TEXTURE_PIXEL_SIZE)`, i.e. the authored value is a
// FRACTION OF THE TEXTURE SIZE and shifts the whole sprite quad. gsw has no per-sprite pivot, so the mirror
// folds it into the system's draw origin (`originX`/`originY`) — see normalizeParticleSpec for the
// approximation that implies.
export function shaderPivotPxFrom(
  params: MirrorShaderParam[] | null | undefined,
  textureWidth: number,
  textureHeight: number
): { x: number; y: number } | null {
  if (!params || params.length === 0 || textureWidth <= 0 || textureHeight <= 0) {
    return null;
  }
  const pivot = params.find((param) => param.name === "pivot_offset")?.vector2;
  if (!pivot || (pivot.x === 0 && pivot.y === 0)) {
    return null;
  }
  return { x: pivot.x * textureWidth, y: pivot.y * textureHeight };
}

// Where a particle SHADER takes its coverage (final alpha) from, plus the extra coverage inputs it declares.
//
// STS2's eight common VFX shaders split in half over this. Four take coverage from the source texture's RED
// channel (`res://shaders/vfx/common/`):
//   - vfx_grayscale_particle_shader  `COLOR = vec4(lut(grayscale.r).rgb, vertex_color.a * grayscale.r)`
//   - vfx_ring_polar_shader          `smoothstep(curve, curve + offset, texture_color.r)`, plus a polar UV remap
//   - vfx_poof_shader                `erosion_from_factors(..., texture_color.r)`
//   - vfx_round_smoke_shader         `erosion_from_factors(..., texture_color.r)`
// and vfx_panning_shader does either, decided by its own `use_red_channel_as_alpha` uniform
// (`mix(main_tex.a, main_tex.r, use_red_channel_as_alpha)`). The other four
// (vfx_common_particle_shader, vfx_flipbook_shader, vfx_row_flipbook_shader, vfx_ray_shader) take it from the
// texture's ALPHA — and they declare the SAME `lut` / `erosion_curve` / `erosion_offset` uniforms, so a
// parameter heuristic is unsound in BOTH directions. The rule is a property of the shader IDENTITY; hence an
// explicit allowlist keyed by the shader's basename.
//
// It matters because the red-channel sheets (common_glow, common_ring_polar_a, vfx_noise_*, common_glow_speck)
// are GRAYSCALE PNGs with no alpha channel at all: a browser samples alpha = 1.0 everywhere, so gsw drew the
// energy-count orb and the creature status VFX as opaque SQUARES.
export interface ShaderCoverage {
  /** gsw `alphaFromRed`: coverage from the texture's red channel (pre-LUT). */
  alphaFromRed: boolean;
  /** gsw `alphaErode`: constant-erosion smoothstep factors, or null when the curve isn't a constant. */
  erode: { threshold: number; softness: number } | null;
  /** The `mask` sampler's res:// path (resolved to a URL by the caller — see sceneTree). */
  maskResourcePath: string | null;
  /** gsw `uvPolar`: this shader samples through Godot's polar_coordinates remap. */
  uvPolar: boolean;
}

// The four `res://shaders/vfx/common/*.gdshader` basenames whose fragment reads coverage from tex.r.
const RED_COVERAGE_SHADERS = [
  "vfx_grayscale_particle_shader",
  "vfx_ring_polar_shader",
  "vfx_poof_shader",
  "vfx_round_smoke_shader"
];

// The one shader whose sampling is radial: `texture(TEXTURE, polar_coordinates(UV, vec2(0.5), 1, 1))`. Fixing
// coverage WITHOUT the remap turns the ring's square into a soft vertical bar, which is worse.
const POLAR_UV_SHADERS = ["vfx_ring_polar_shader"];

// `res://shaders/vfx/common/vfx_poof_shader.gdshader` → `vfx_poof_shader`. A `uid://…` id (the producer ships
// whichever form the material resolved to) has no basename and simply matches nothing — the node then keeps
// today's alpha coverage rather than guessing.
function shaderBasename(shaderId: string | null | undefined): string {
  if (!shaderId) {
    return "";
  }
  const file = shaderId.split("/").pop() ?? "";
  return file.endsWith(".gdshader") ? file.slice(0, -".gdshader".length) : "";
}

/**
 * The coverage semantics a particle material's shader implies, or null when it implies none (the shader takes
 * coverage from the texture's alpha, declares no mask, and samples flat) — in which case the spec keeps exactly
 * the fields it had before, so its JSON (a memo key) is byte-identical.
 *
 * `use_red_channel_as_alpha` WINS when present: it is the shader saying so itself, for the one shader that is
 * authored both ways.
 */
export function shaderCoverageFrom(
  shaderId: string | null | undefined,
  params: MirrorShaderParam[] | null | undefined
): ShaderCoverage | null {
  const basename = shaderBasename(shaderId);
  if (!basename) {
    return null;
  }
  const declared = params ? paramNumber(params, "use_red_channel_as_alpha") : null;
  const alphaFromRed =
    declared != null ? declared >= 0.5 : RED_COVERAGE_SHADERS.includes(basename);
  const uvPolar = POLAR_UV_SHADERS.includes(basename);
  const maskResourcePath =
    params?.find((param) => param.name === "mask")?.resourcePath ?? null;
  const erode = erodeFactorsFrom(params);
  if (!alphaFromRed && !uvPolar && !maskResourcePath && !erode) {
    return null;
  }
  return { alphaFromRed, erode, maskResourcePath, uvPolar };
}

// The CONSTANT-erosion smoothstep a material declares: `smoothstep(curve(life), curve(life) + erosion_offset,
// coverage)`. Only a SINGLE-POINT erosion curve qualifies — that is a constant threshold, cheap to apply per
// node (the status blob's `erosion_over_lifetime` is exactly one point at (0, 0.2012), with erosion_offset 0.5).
// A multi-point curve SWEEPS over the particle's life, which would need a per-instance attribute; those are left
// un-eroded (the ring's 2-point curve barely moves, so the ring simply doesn't dissolve as it fades).
function erodeFactorsFrom(
  params: MirrorShaderParam[] | null | undefined
): { threshold: number; softness: number } | null {
  if (!params) {
    return null;
  }
  const curve = params.find(
    (param) => param.name === "erosion_curve" || param.name === "erosion_over_lifetime"
  );
  const points = curve?.curvePoints;
  if (!points || points.length !== 1) {
    return null;
  }
  const threshold = points[0].y;
  const softness = paramNumber(params, "erosion_offset");
  if (!Number.isFinite(threshold) || softness == null || !Number.isFinite(softness)) {
    return null;
  }
  return { threshold, softness };
}

// True when a node runs the gsw particle simulation (the gate is mutually exclusive with isWebglShaderNode,
// which early-returns false for particle nodes — see shaderAttributes.ts).
export function isParticleNode(node: MirrorNode): boolean {
  return node.particleSpec != null;
}

// R10-B3 pure-work memo.
// Here it covers the BINDING object: the JSON was already memoized, but a fresh `{ specsJson }` wrapper was
// allocated on every call, i.e. once per particle node per re-style.
// Memoize the (potentially large) specs JSON keyed by the spec OBJECT identity. The spec is static — mergeNode
// carries the SAME object across volatile-only upserts — so this only re-stringifies when emitting/epoch change
// (a one-shot trigger) or a keyframe rebuilds the spec, instead of every revision (~60Hz) for every particle node.
// R10-B3: the BINDING is cached alongside the JSON (the callers treat it as immutable — visit only reads
// `particle.specsJson`), so a repeat call allocates nothing at all.
let specsJsonCache = new WeakMap<
  object,
  { emitting: boolean; epoch: number; json: string; binding: MirrorParticleBinding }
>();

// The stamped particle binding for a node, or null when it isn't a particle node.
export function nodeParticleAttributes(node: MirrorNode): MirrorParticleBinding | null {
  const spec = node.particleSpec;
  // The gate is the HARD-OFF lane only (?debug auto-player / ?quality=minimum / software-WebGL phone). It used to
  // be the tier's `particlesEnabled`, which silently skipped stamping on the `very-low` tier a mid-range phone
  // auto-resolves to — so the settings panel's Particles select did nothing there no matter what the viewer
  // picked (no markers ⇒ nothing for the runtime to attach to). The panel decides now; the tier only seeds it.
  if (!spec || particlesHardOff(renderQuality())) {
    return null; // no particle node, or the hard-off lane (no usable GPU path at all)
  }
  // A BAKED STILL is standing in for this emitter (bakedEffects.ts): the two card rarity glows, while particles
  // are `off` or `static`. Stamp no markers — gsw's particle runtime selects on `[data-godot-particle-runtime]`,
  // so without them it never attaches, and there is no canvas to simulate into, freeze or read back. Otherwise
  // the viewer would get the still AND the canvas.
  //
  // AHEAD OF `specsJsonCache` DELIBERATELY. The memo is keyed on the spec OBJECT, which does not move when the
  // settings panel does; gating behind it would serve a stale binding across a mode flip. (Its shader twin has
  // no such refuge — see `shaderContentKey`, which had to grow the mode as a key term.)
  if (bakedStillCoversNode(node)) {
    return null;
  }
  const cached = specsJsonCache.get(spec);
  if (cached && cached.emitting === node.particleEmitting && cached.epoch === node.particleRestartEpoch) {
    return cached.binding;
  }
  const json = JSON.stringify({
    ...spec,
    emitting: node.particleEmitting,
    _epoch: node.particleRestartEpoch
  });
  const binding: MirrorParticleBinding = { specsJson: json };
  specsJsonCache.set(spec, {
    emitting: node.particleEmitting,
    epoch: node.particleRestartEpoch,
    json,
    binding
  });
  return binding;
}
