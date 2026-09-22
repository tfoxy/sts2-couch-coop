// Bridges a mirror shader node into gsw's renderers. From the producer-streamed shader params it synthesizes a
// gsw ShaderMaterial doc, then:
//   - HSV-adjust shaders (the one exception) → a feColorMatrix the node applies as `filter` (no WebGL).
//   - every other shader → gsw `assignMaterialAttributes` stamps `data-godot-shader-*` so the WebGL runtime
//     runs the real shader (gsw falls back gracefully for shaders it can't transpile).
// Reuses gsw's material logic wholesale (param formatting, sampler urls, modulate, hsv math) — no per-shader
// special-casing beyond the HSV family.

import { ref } from "vue";

import type { ColorMatrix, GodotExtResource, GodotNode, GodotResource, GodotVariant } from "@godot-scene-web/core";
import {
  SHADER_DORMANT_ATTR,
  assignMaterialAttributes,
  colorMatrixFeValues,
  materialColorMatrix
} from "@godot-scene-web/html";

import { renderQuality } from "@/render/quality";
import type { MirrorColor, MirrorNode, MirrorShaderParam } from "@/mirror/sceneTree";
import {
  CARD_RIPPLE_SHADER_IDS,
  HSV_SHADER_IDS,
  LOW_HP_BORDER_NODE_TYPE,
  TRANSITION_NODE_TYPE,
  mirrorShaderRenderOptions
} from "@/mirror/shaderResources";

// Ripple dormancy keeps an invisible card's binding parked instead of rebuilding it on every energy update.
// dropping to width ≈ 0 (the game's "not playable" state) returned NO binding at all — the reconciler then removed
// every `data-godot-shader-*` attribute, gsw's next reconcile could no longer find the node, and it DISPOSED the
// binding. Flipping a hand's playability (which happens on every energy change, every card played, every turn
// boundary) therefore destroyed and rebuilt a shader binding per card, each rebuild paying a `syncCanvasSize`
// forced layout. With it ON the node keeps its full attribute set and merely adds `data-godot-shader-dormant`, and
// gsw parks the binding instead: canvas hidden (so the ripple is just as invisible as before — the degenerate
// smoothstep sliver never renders), no scheduler, no rect reads, `syncCanvasSize` deferred to the wake, and a
// real dispose only after ~30s of continuous dormancy. Waking is removing one attribute.
// The screen-transition overlay is also parked while fully transparent.
//
// WHY: `Game/GameTransitionRect` (see `TRANSITION_NODE_TYPE`) is the single biggest surface in the fleet — a
// 2560×1200 design-px full-bleed node — and it is INVISIBLE except while a screen change is actually fading.
// Measured over the 37 recorded mirror sessions in `.sts2/bench`: the node is present in every one, is upserted
// exactly once, and its `threshold` uniform is 0 in every single upsert — it was never once anything else. Yet
// today it costs, on every screen: one WebGL binding + a full-screen backing store (2048×832 = 6.5 MB under the
// static pin; `designBox × dpr × renderScale` unpinned), one GL draw producing zero pixels, a promoted
// compositor layer, and — once the static-stills driver settles — a full-screen PNG encode + decode for an
// `<img>` still of a completely transparent canvas.
//
// Dormancy is the exact remedy the gsw contract exists for (see `shader-dormant.ts` and the ripple block below):
// the attribute set is kept, gsw parks the binding with its canvas hidden and DEFERS `syncCanvasSize`, and the
// first streamed `threshold > 0` wakes it by removing one attribute. Suppression is only ever applied to a
// threshold we can actually SEE (`!= null`), so a transition whose uniform is not streamed stays live.
// The low-HP vignette is likewise parked while effectively transparent.
//
// WHY: `Run/GlobalUi/vfx_low_hp_border` (see `LOW_HP_BORDER_NODE_TYPE`) is a 2048×922 full-screen shader surface.
// Across the recorded benches it renders `meanAlpha 0` while streaming `alpha_multiplier: 0.0025295` — it costs a
// binding, a full-screen backing store, a GL draw and a promoted compositor layer while being literally invisible.
// Unlike the transition gate, whose "invisible" rests on the shader writing alpha 0 exactly, this one rests on a
// PROVEN UPPER BOUND plus the destination's precision — see `lowHpBorderEffectivelyOff`.
export interface MirrorShaderBinding {
  attributes: Record<string, string>;
  style: Record<string, string>;
  // The base texture URL for the WebGL self-layer: the node's texture, or a 1×1 solid of its fill color (so a
  // shader that only writes COLOR.a — e.g. a transition over a black fill — gets the right base, not white).
  textureUrl?: string;
  // The self-layer's `background-size` — gsw's `backgroundFit` reads it to decide how the base texture is
  // sampled. Maps the node's Godot StretchMode (KeepAspectCentered → "contain") so a non-stretched texture
  // (e.g. the card_ripple SDF in its oversized Highlight box) isn't fill-stretched and over-spilling. Only set
  // for WebGL shader nodes (the self-layer); absent for the HSV/feColorMatrix path, which has no self-layer.
  selfLayerFit?: string;
}

// Map a Godot TextureRect.StretchMode (enum 0..6) to a CSS background-size that gsw's `backgroundFit` reads
// ("contain"/"cover"/"fill"). Scale/Tile → fill; KeepAspectCovered → cover; the Keep* family → contain (the
// closest gsw fit — keep-aspect-centered is exact; native Keep/KeepCentered is best-effort, both rare in STS2).
// Unknown / non-TextureRect (null) → "fill", the prior default.
export function stretchModeToBackgroundSize(mode: number | null): string {
  switch (mode) {
    case 6: // KeepAspectCovered
      return "cover";
    case 2: // Keep
    case 3: // KeepCentered
    case 4: // KeepAspect
    case 5: // KeepAspectCentered
      return "contain";
    default: // 0 Scale, 1 Tile, null/unknown
      return "fill";
  }
}

// A 1×1 SVG data URL of a solid color, used as the WebGL base for a textureless ColorRect/transition shader.
function solidColorDataUrl(color: MirrorColor): string {
  const rgba = `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${color.a})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="${rgba}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// A non-image resource path for the synthesized material ref (gsw needs a ref to call resolveResource; the
// actual doc is stashed on the source node).
const SYNTH_MATERIAL_PATH = "mirror://shader-material";

function colorVariant(color: MirrorColor | null): GodotVariant | undefined {
  return color ? { type: "Color", args: [color.r, color.g, color.b, color.a] } : undefined;
}

// The `width` below which the game's ripple counts as HIDDEN (NCardHighlight at rest; only playable cards / the
// reward-screen flash tween it up to ~0.075). At width 0 the WebGL render leaks a sliver (degenerate smoothstep),
// so the renderer skips it.
const RIPPLE_HIDDEN_WIDTH = 0.005;

// True when a card_ripple node's `width` uniform is streamed AND ≈ 0. Only suppress when the value is
// explicitly known near-zero: a missing `width` (shaderParams absent) falls through to the normal WebGL path so
// a ripple we can't measure is never wrongly hidden.
function rippleEffectivelyOff(node: MirrorNode): boolean {
  const width = node.shaderParams?.find((p) => p.name === "width")?.number;
  return width != null && width < RIPPLE_HIDDEN_WIDTH;
}

/**
 * The streamed `width` of a ripple the game currently has SHOWN, or null.
 *
 * The positive twin of `rippleEffectivelyOff`, exported so `bakedEffects.ts` can ask the same question of the
 * same uniform against the same floor instead of re-deriving it — the two must agree, or the shaders-off still
 * would paint on cards whose WebGL binding is parked (and vice versa).
 *
 * Null covers BOTH "the game has it hidden" and "the uniform is not streamed": a ripple that cannot be measured
 * is not painted, which is the conservative direction here. (The WebGL path makes the opposite call for the same
 * unmeasurable node, and deliberately so — there a missing uniform must not wrongly HIDE a live effect, while
 * here it must not wrongly INVENT one.)
 */
export function rippleShownWidth(node: MirrorNode): number | null {
  const width = node.shaderParams?.find((p) => p.name === "width")?.number;
  return width != null && width >= RIPPLE_HIDDEN_WIDTH ? width : null;
}

// True when this node is the game's screen-transition overlay AND its `threshold` uniform is streamed AND ≈ 0 —
// i.e. no screen change is in flight, so every transition shader resolves the fragment alpha to 0 (see
// `TRANSITION_NODE_TYPE` for the two shader bodies). Same shape as `rippleEffectivelyOff`: only suppress a value
// we can actually see, so a transition whose threshold is not streamed is never wrongly parked.
function transitionEffectivelyOff(node: MirrorNode): boolean {
  if (node.nodeType !== TRANSITION_NODE_TYPE) {
    return false;
  }
  const threshold = node.shaderParams?.find((p) => p.name === "threshold")?.number;
  return threshold != null && threshold < 0.005;
}

// The smallest alpha an 8-bit destination can represent. gsw composites a shader binding through a 2D canvas
// context, whose backing store is 8 bits per channel, so an alpha strictly below 1/255 rounds to 0 in EVERY
// pixel — the surface cannot set a single bit anywhere. DERIVED, not tuned: it is the destination's precision,
// which is why it is NOT the `0.005` the ripple/transition gates use (0.005 = 1.275/255 — above the provable
// bound, so it would be a heuristic rather than a proof).
const EIGHT_BIT_ALPHA_STEP = 1 / 255;

// True when this node is the game's low-HP vignette AND its `alpha_multiplier` uniform is streamed AND small
// enough that the surface provably cannot paint one bit of alpha.
//
// THE PROOF (see `LOW_HP_BORDER_NODE_TYPE` for the quoted shader source). The shader's final two statements are
//   final_alpha = smoothstep(…, …, final_alpha) * clamp(alpha_multiplier, 0.0, 1.0);
//   COLOR = vec4(main_color.rgb, final_alpha) * vertex_color;
// GLSL `smoothstep` returns a value in [0,1] for every input, so
//   max fragment alpha ≤ clamp(alpha_multiplier, 0, 1) ≤ alpha_multiplier   (for alpha_multiplier ≥ 0)
// UNCONDITIONALLY — independent of the noise texture, the radii, `smoothstep_factors`, `main_color` and the
// vertex color (which is a modulate, so it only shrinks the result further). Below `EIGHT_BIT_ALPHA_STEP` that
// upper bound quantizes to zero, so the node renders an entirely transparent canvas.
//
// Deliberately keyed on the multiplier ALONE: it is the only uniform that bounds the output from above, so it is
// the only one the proof can rest on. And only ever on a value we can SEE (`!= null`), so a vignette whose
// uniform is not streamed stays live. The gate is purely value-driven, so the node wakes on the first streamed
// multiplier at or above the floor — which matters, because this vignette is real: on screen it animates all the
// way to full strength when the player is hurt.
function lowHpBorderEffectivelyOff(node: MirrorNode): boolean {
  if (node.nodeType !== LOW_HP_BORDER_NODE_TYPE) {
    return false;
  }
  const multiplier = node.shaderParams?.find((p) => p.name === "alpha_multiplier")?.number;
  return multiplier != null && multiplier < EIGHT_BIT_ALPHA_STEP;
}

// Map one streamed param to a gsw shader_parameter variant; sampler textures become ExtResource refs added to
// the doc's ext-resource table (so gsw's samplerImageUrls resolves them via resolveResource).
function paramVariant(p: MirrorShaderParam, extResources: GodotExtResource[]): GodotVariant | undefined {
  switch (p.kind) {
    case "number":
      return p.number ?? undefined;
    case "bool":
      return p.bool ?? undefined;
    case "string":
      return p.string ?? undefined;
    case "color":
      return p.color ? { type: "Color", args: [p.color.r, p.color.g, p.color.b, p.color.a] } : undefined;
    case "vector2":
      return p.vector2 ? { type: "Vector2", args: [p.vector2.x, p.vector2.y] } : undefined;
    case "resource": {
      if (!p.resourcePath) {
        return undefined; // inline procedural sampler (no path) → gsw uses defaults
      }
      const id = `tex_${p.name}`;
      extResources.push({ id, path: p.resourcePath, attributes: {}, properties: {} });
      return { type: "ExtResource", id };
    }
    default:
      return undefined;
  }
}

// Synthesize a gsw ShaderMaterial doc from the node's shader path + streamed uniform params.
/**
 * Build the exact transient ShaderMaterial document consumed by both mirror
 * render paths.  Canvas callers use the document to preserve the existing
 * parameter/resource conversion without stamping DOM attributes.
 */
export function synthesizeMirrorShaderMaterial(node: MirrorNode): GodotResource {
  const extResources: GodotExtResource[] = [{ id: "shader", path: node.shaderId ?? undefined, attributes: {}, properties: {} }];
  const properties: Record<string, GodotVariant> = { shader: { type: "ExtResource", id: "shader" } };
  for (const param of node.shaderParams ?? []) {
    const variant = paramVariant(param, extResources);
    if (variant !== undefined) {
      properties[`shader_parameter/${param.name}`] = variant;
    }
  }
  return { type: "ShaderMaterial", header: null, properties, extResources, subResources: [], diagnostics: [] };
}

function shaderProps(node: MirrorNode): Record<string, GodotVariant> {
  const props: Record<string, GodotVariant> = { material: { type: "ExtResource", path: SYNTH_MATERIAL_PATH } };
  const modulate = colorVariant(node.modulate);
  if (modulate) {
    props.modulate = modulate;
  }
  const selfModulate = colorVariant(node.selfModulate);
  if (selfModulate) {
    props.self_modulate = selfModulate;
  }
  return props;
}

// --- HSV feColorMatrix filter registry --------------------------------------------------------------------
// HSV-adjust nodes apply a `filter: url(#mhsv-N)` referencing an SVG <feColorMatrix>. The defs are rendered by
// MirrorView (alongside the modulate-tint filters); `hsvFilterVersion` bumps when a new matrix is registered so
// the defs re-render. Keyed by the feColorMatrix values string (identical transforms share one filter).
const hsvFilterIds = new Map<string, string>();
export const hsvFilterVersion = ref(0);

function registerHsvFilter(feValues: string): string {
  const existing = hsvFilterIds.get(feValues);
  if (existing) {
    return existing;
  }
  const id = `mhsv-${hsvFilterIds.size}`;
  hsvFilterIds.set(feValues, id);
  hsvFilterVersion.value += 1;
  return id;
}

export function hsvFilterDefs(): Array<{ id: string; values: string }> {
  void hsvFilterVersion.value;
  return [...hsvFilterIds.entries()].map(([values, id]) => ({ id, values }));
}

// The structural gates deciding whether a node's shader runs on the gsw WebGL self-layer canvas — IGNORING the
// quality tier (i.e. "is this a shader node whose own texture is shader INPUT, not final art?"). A node passing
// these renders on the canvas when shaders are on, and is the one whose raw CSS paint must be suppressed when
// shaders are off (its base — e.g. card_ripple's SDF — is a meaningless gray blob without the shader).
function isWebglEligible(node: MirrorNode): boolean {
  if (node.particleSpec) {
    return false; // a particle node renders via the gsw particle runtime, not the shader self-layer (its
    // GpuParticles2D.Material IS a ShaderMaterial, so the shader probe also fires — the particle path wins)
  }
  if (!node.shaderId || HSV_SHADER_IDS.includes(node.shaderId)) {
    return false; // not a shader node, or HSV → rendered via feColorMatrix, not the canvas
  }
  if (!node.textureUrl && !node.fillColor) {
    return false; // no base to sample → skipped (no canvas)
  }
  if (node.textureRegion) {
    return false; // atlas sprite → shader skipped, the CSS crop is the fallback
  }
  return true;
}

// True when a node renders its shader via the gsw WebGL self-layer canvas (so its own raw texture/fill must
// NOT also be painted in CSS — that duplicate would show under the canvas, e.g. card_ripple's SDF as a gray
// rectangle). Mirrors the exact gates in `nodeShaderAttributes`'s WebGL branch; keep the two in lockstep. In the
// `static` tier shaders ARE enabled (rendered as a single frozen frame), so this stays true — the canvas paints
// the still frame.
export function isWebglShaderNode(node: MirrorNode): boolean {
  if (!renderQuality().shadersEnabled) {
    return false; // low-end "off" tier: WebGL shaders disabled → the node's raw paint is suppressed instead
    // (see isShaderInputNode, used by nodeStyles' paintsTexture gate). The HSV feColorMatrix path in
    // nodeShaderAttributes is BEFORE this gate and unaffected — cheap CSS tint stays on.
  }
  return isWebglEligible(node);
}

// True when a node's painted texture is shader INPUT (e.g. an SDF), meaningful only with the shader running.
// Generic (no per-shader id): it's exactly an isWebglEligible node. When shaders are OFF, nodeStyles uses this
// to paint NOTHING for such a node rather than its raw pre-shader texture (the gray blob). This is the generic
// replacement for the old per-shader card_ripple CSS glow — the normal low-end path is the `static` tier, which
// shows the REAL frozen glow; only the true `off` floor (WebGL unavailable / `?debug`) loses the cue.
export function isShaderInputNode(node: MirrorNode): boolean {
  return isWebglEligible(node);
}

// True when every element in the color matrix is near zero — the texture would map to near-black.
// Used to gate the HSV feColorMatrix: when v ≈ 0 the raw texture is a better visual approximation.
function colorMatrixIsNearlyBlack(matrix: ColorMatrix): boolean {
  const r = matrix.rows;
  const sum = r[0][0]+r[0][1]+r[0][2] + r[1][0]+r[1][1]+r[1][2] + r[2][0]+r[2][1]+r[2][2];
  return sum < 0.1;
}

// True when any ancestor within `maxDepth` hops has the given nodeType. Used to detect when a node lives
// inside a scene that provides compensating particle VFX — the HSV filter would double-darken the texture
// without those VFX being faithfully replicated by the mirror's particle runtime.
function hasAncestorType(node: MirrorNode, nodes: Map<string, MirrorNode>, type: string, maxDepth = 5): boolean {
  let cur = nodes.get(node.parentId ?? "");
  for (let i = 0; i < maxDepth && cur; i++) {
    if (cur.nodeType === type) return true;
    cur = nodes.get(cur.parentId ?? "");
  }
  return false;
}

// Memoize the full shader binding keyed on the node OBJECT (only for actual shader nodes — see below). Building it
// — synthesizing the material doc, gsw's resolveResource walk, and the shader-signature JSON.stringify inside
// assignMaterialAttributes — was a measured combat hotspot (~160ms over a 24s trace on a mid-range phone), yet the
// result is a pure function of the node: the reconciler swaps in a FRESH node object whenever a node's data
// changes (uniforms, texture, modulate, …), so a STABLE object across walks — an incremental-structural re-style,
// or a node dragged only by a parent-transform tween (own object unchanged, inherited ctx moved) — has an
// unchanged binding and can reuse the cached one. A `null` result (hidden ripple / near-black HSV) is cached too;
// the has()-guard distinguishes "cached null" from "never computed". Entries are GC'd with their node object, so
// the map self-bounds.
let shaderBindingCache = new WeakMap<MirrorNode, MirrorShaderBinding | null>();

// --- L2: the CONTENT-keyed memo (R10-B3) --------------------------------------------------------------------
// L1 above is keyed on the node OBJECT, so it busts on ANY field change — and the reconciler swaps in a fresh
// node object for a node whose modulate, transform, text or visibility moved, none of which the shader binding
// depends on. On a card play the pooled shells are re-instantiated wholesale, so EVERY shader node under the
// hand arrives as a brand-new object and L1 misses across the board — exactly when the work (material-doc
// synthesis, gsw's resolveResource walk, the shader-signature JSON.stringify inside assignMaterialAttributes,
// the HSV matrix maths) is most concentrated.
//
// L2 is keyed on the binding's real inputs instead, so a rebuilt-but-identical node hits. The key MUST cover
// every input `computeShaderAttributes` reads — correctness over hit rate:
//   * the shader path and every streamed uniform (the material doc + the ripple `width` gate),
//   * modulate / self_modulate (they go into `shaderProps` → the HSV matrix and the WebGL modulate attr),
//   * the WebGL eligibility gates: particleSpec presence, textureUrl, fillColor, textureRegion,
//   * the base-texture fit input (textureStretchMode),
//   * the global quality tier's `shadersEnabled` (isWebglShaderNode reads it live),
//   * the ripple-dormancy switch, which changes the SHAPE of the returned binding, and
//   * for the HSV family only, the NEnergyCounter-ancestor skip bit — the one input that isn't on the node.
// The returned binding object is treated as IMMUTABLE by every caller (mergedNodeStyle spreads `shader.style`,
// visit spreads `shader.attributes`), so sharing one instance between nodes is safe.
const SHADER_CONTENT_CACHE_MAX = 512;
const shaderContentCache = new Map<string, MirrorShaderBinding | null>();

function colorKey(c: MirrorColor | null): string {
  return c ? `${c.r},${c.g},${c.b},${c.a}` : "";
}

function paramKey(p: MirrorShaderParam): string {
  switch (p.kind) {
    case "number":
      return `${p.name}=n${p.number}`;
    case "bool":
      return `${p.name}=b${p.bool}`;
    case "string":
      return `${p.name}=s${p.string}`;
    case "color":
      return `${p.name}=c${colorKey(p.color)}`;
    case "vector2":
      return `${p.name}=v${p.vector2 ? `${p.vector2.x},${p.vector2.y}` : ""}`;
    case "resource":
      return `${p.name}=r${p.resourcePath ?? ""}`;
    default:
      // Extended Godot-native kinds ride through untouched (paramVariant ignores them), so they cannot change
      // the output — but the KIND is what decides that, and it is already in the key via this branch's name.
      return `${p.name}=?${p.kind}`;
  }
}

function shaderContentKey(node: MirrorNode, energyAncestor: boolean): string {
  let params = "";
  for (const p of node.shaderParams ?? []) {
    params += `${paramKey(p)};`;
  }
  const region = node.textureRegion;
  return (
    `${node.shaderId}|${params}|${colorKey(node.modulate)}|${colorKey(node.selfModulate)}` +
    `|${node.textureUrl ?? ""}|${colorKey(node.fillColor)}` +
    `|${region ? `${region.x},${region.y},${region.width},${region.height}` : ""}` +
    `|${node.textureStretchMode ?? ""}|${node.particleSpec ? 1 : 0}` +
    `|${renderQuality().shadersEnabled ? 1 : 0}|${energyAncestor ? 1 : 0}` +
    // The transition gate reads the node TYPE (the one binding input outside shaderId/params/modulate), plus its
    // own switch — both change the SHAPE of the returned binding, so both must key it. One comparison, one char:
    // the type string itself is deliberately NOT concatenated, since only "is this the transition overlay" matters.
    `|${node.nodeType === TRANSITION_NODE_TYPE ? 1 : 0}` +
    // The low-HP vignette gate keys exactly the same way (its `alpha_multiplier` is already in `params`).
    `|${node.nodeType === LOW_HP_BORDER_NODE_TYPE ? 1 : 0}`
  );
}

// Drop the OBJECT-keyed L1. Called on a FULL walk (keyframe / forced re-render): a full walk re-styles every node
// with fresh objects anyway (so the old entries would only ever miss), and this eagerly releases them.
//
// L2 is deliberately KEPT: it is keyed on content, so a full walk's fresh objects HIT it (that is the point), and
// the one input the object key could not see — an ANCESTOR's type changing under a stable node (the NEnergyCounter
// HSV skip check walks ancestors) — is now part of the L2 key itself, so no reset is needed to cover it.
export function resetShaderDocCache(): void {
  shaderBindingCache = new WeakMap();
}

// Shader binding for a node, or null when it isn't a shader node / its shader isn't runnable. HSV-adjust
// shaders return a `style.filter`; all others return WebGL `data-godot-shader-*` attributes.
// `nodes` is the full live-scene node map; when provided it enables ancestor-type checks.
export function nodeShaderAttributes(node: MirrorNode, nodes?: Map<string, MirrorNode>): MirrorShaderBinding | null {
  // The overwhelming majority of styled nodes have NO shader — take the cheapest possible path (one field read,
  // no WeakMap traffic) so the memo never taxes the non-shader hot path. Only real shader nodes are memoized.
  if (!node.shaderId) {
    return null;
  }
  if (shaderBindingCache.has(node)) {
    return shaderBindingCache.get(node) as MirrorShaderBinding | null;
  }
  // The ancestor bit is only an INPUT for the HSV family (the only branch that consults `nodes`), so the 5-hop
  // climb is paid only there — every WebGL shader node keys on its own fields alone.
  const energyAncestor =
    nodes != null &&
    HSV_SHADER_IDS.includes(node.shaderId) &&
    hasAncestorType(node, nodes, "MegaCrit.Sts2.Core.Nodes.Combat.NEnergyCounter");
  const key = shaderContentKey(node, energyAncestor);
  let binding: MirrorShaderBinding | null;
  if (shaderContentCache.has(key)) {
    binding = shaderContentCache.get(key) as MirrorShaderBinding | null;
    // LRU touch: re-insert so the eviction below drops the genuinely coldest entry.
    shaderContentCache.delete(key);
    shaderContentCache.set(key, binding);
  } else {
    binding = computeShaderAttributes(node, nodes);
    shaderContentCache.set(key, binding);
    if (shaderContentCache.size > SHADER_CONTENT_CACHE_MAX) {
      const oldest = shaderContentCache.keys().next();
      if (!oldest.done) {
        shaderContentCache.delete(oldest.value);
      }
    }
  }
  shaderBindingCache.set(node, binding);
  return binding;
}

function computeShaderAttributes(node: MirrorNode, nodes?: Map<string, MirrorNode>): MirrorShaderBinding | null {
  if (!node.shaderId) {
    return null; // never reached (the wrapper gates on shaderId) — kept only so TS narrows shaderId to string below
  }

  const props = shaderProps(node);
  // gsw threads `source` into resolveResource untouched — stash the synthesized doc on it so resolveResource
  // returns it for the material ref.
  const source = { name: "", attributes: {}, properties: {}, __mirrorDoc: synthesizeMirrorShaderMaterial(node) } as unknown as GodotNode;

  const attributes: Record<string, string> = {};
  const style: Record<string, string> = {};

  // HSV exception: the HSV color-adjust family NEVER runs on WebGL (perf + it's a pure color transform).
  // Render via a feColorMatrix filter, or fall back when the matrix is identity (e.g. params not yet streamed)
  // — crucially never WebGL, so an HSV node can't garble regardless of whether params are present.
  if (HSV_SHADER_IDS.includes(node.shaderId)) {
    const matrix = materialColorMatrix(attributes, props, source, mirrorShaderRenderOptions);
    if (!matrix) {
      return null;
    }
    // When the computed matrix maps the texture to near-black (v ≈ 0), skip the filter — the raw texture
    // better approximates the game's glow-compensated appearance.
    if (colorMatrixIsNearlyBlack(matrix)) {
      return null;
    }
    // NEnergyCounter nests its texture layers (Layer1-Layer5) alongside additive particle VFX nodes
    // (EnergyVfxFront/Back). The HSV filter desaturates/darkens the background (s=0.5, v=0.85); in the game
    // those VFX restore the glow. The mirror's particle runtime reproduces only part of that effect, so the
    // combined appearance is darker than the game. Skip the filter: the raw texture with the particle glow
    // on top closely matches the game's visual.
    if (nodes && hasAncestorType(node, nodes, "MegaCrit.Sts2.Core.Nodes.Combat.NEnergyCounter")) {
      return null;
    }
    const id = registerHsvFilter(colorMatrixFeValues(matrix));
    return { attributes: {}, style: { filter: `url(#${id})` } };
  }

  // Past the HSV exception, `isWebglShaderNode` decides whether this node renders on the canvas. It rejects:
  //   - no base (no texture/fill): gsw would default to opaque WHITE and a COLOR.a-only shader paints a sheet.
  //   - atlas-sprite shaders (`textureRegion`): the self-layer would sample the FULL packed page and garble
  //     the icon (region-aware sampling is future work); the CSS crop in nodeStyle stays as the fallback.
  if (!isWebglShaderNode(node)) {
    return null;
  }

  // card_ripple with width ≈ 0 = the game's HIDDEN ripple. Either way the node stays a shader-INPUT node
  // (isWebglShaderNode / isShaderInputNode are unchanged), so nodeStyles keeps suppressing its raw SDF paint and
  // nothing renders the degenerate-smoothstep sliver:
  //   * DEFAULT (R10-B3): keep the full attribute set and add `data-godot-shader-dormant`, so gsw PARKS the
  //     binding (canvas hidden ⇒ nothing painted) instead of disposing it. A hand's playability flips constantly;
  //     parking makes the next flip a one-attribute wake instead of a rebuild + forced layout per card.
  const rippleOff = CARD_RIPPLE_SHADER_IDS.includes(node.shaderId) && rippleEffectivelyOff(node);

  // Everything else → WebGL. assignMaterialAttributes stamps data-godot-shader-* (path/params/samplers/modulate).
  assignMaterialAttributes(attributes, style, props, source, mirrorShaderRenderOptions);
  if (!attributes["data-godot-shader-webgl"]) {
    return null;
  }
  // The screen-transition overlay at rest (`threshold ≈ 0`) parks the same way — see the switch block above for
  // the measurement. The low-HP vignette below the 8-bit alpha floor is the third member of the same family.
  if (
    rippleOff ||
    transitionEffectivelyOff(node) ||
    lowHpBorderEffectivelyOff(node)
  ) {
    attributes[SHADER_DORMANT_ATTR] = "1";
  }
  // Base texture for the self-layer: the node's texture, or a solid of its fill color (transition over black).
  // Fit: a real texture follows its StretchMode (so an unstretched SDF isn't fill-stretched); a synthesized
  // 1×1 fill-color base must "fill" (contain of a 1×1 wouldn't cover the node).
  const textureUrl = node.textureUrl ?? (node.fillColor ? solidColorDataUrl(node.fillColor) : undefined);
  const selfLayerFit = node.textureUrl ? stretchModeToBackgroundSize(node.textureStretchMode) : "fill";
  return { attributes, style, textureUrl, selfLayerFit };
}
