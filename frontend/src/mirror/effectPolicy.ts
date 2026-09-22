// THE INPUTS EVERY EFFECT DECISION READS — the per-viewer effect modes, the canvas-stage ownership latch, and the
// card-ripple `width` semantics. Nothing here mounts anything or talks to gsw.
//
// WHY IT IS ITS OWN MODULE, rather than living in `shaderResources.ts` with the gsw mount options that re-export
// it. `shaderResources` CONSTRUCTS at import time: its options objects call `staticShaderPinRatio()` in module
// scope, which builds the static-pin tracker. That is fine for a leaf, and this repo's effect graph is not one —
// `sceneTree` imports `particleAttributes` (spec normalization), so the moment a binding builder consults an
// effect mode, "read the mode" would drag the pin tracker into `sceneTree`'s own initialization and a module
// evaluating `staticPin` first would hit a TDZ before its body ran. Splitting the cheap INPUTS out from the
// expensive CONSTRUCTION is what keeps that from being a hazard anyone has to remember. Imports here are limited
// to the settings store and the quality tier for exactly that reason; keep it that way.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only.

import { computed, type ComputedRef } from "vue";

import { particlesHardOff, renderQuality, shadersHardOff } from "@/render/quality";
import { mirrorSettings, type EffectMode } from "@/mirror/mirrorSettings";
import type { MirrorNode } from "@/mirror/sceneTree";

// The device's render-quality tier, read ONCE at module load — the same snapshot `shaderResources` builds its
// tier-fixed construction options from, so the hard-off floor below cannot disagree with them mid-session.
const quality = renderQuality();

// The card glow/ripple shader. Its visibility is driven entirely by the `width` uniform: it is tweened up to
// 0.075 to show the ripple and back to 0 to hide it. At width 0 the transpiled
// `smoothstep(1.0 - width, width + (1.0 - width), brightness)` collapses to `smoothstep(1.0, 1.0, …)` — a
// degenerate (÷0) step that leaks a faint sliver at the SDF border on WebGL, where Godot draws nothing. So
// `shaderAttributes` suppresses the WebGL render when width ≈ 0, matching the game's hidden state. Both the
// res:// path and the uid:// alias appear depending on how the producer resolved the material's shader ref.
export const CARD_RIPPLE_SHADER_IDS = ["res://shaders/card_ripple.gdshader", "uid://bikvsfwlbp43n"];

// The `width` below which the game's ripple counts as HIDDEN (NCardHighlight at rest; only playable cards / the
// reward-screen flash tween it up to ~0.075). At width 0 the WebGL render leaks a sliver (degenerate smoothstep),
// so the renderer skips it.
//
// The floor and its two readers live beside the shader id whose semantics they encode, so both consumers can
// share them: `shaderAttributes` (the live WebGL path) and `bakedEffects` (the baked still that stands in for it)
// must answer the same question about the same uniform against the same number, or a still would paint on a card
// whose binding is live (and vice versa).
const RIPPLE_HIDDEN_WIDTH = 0.005;

/**
 * True when a card_ripple node's `width` uniform is streamed AND ≈ 0.
 *
 * Only suppress when the value is explicitly known near-zero: a missing `width` (shaderParams absent) falls
 * through to the normal WebGL path so a ripple we can't measure is never wrongly hidden.
 */
export function rippleEffectivelyOff(node: MirrorNode): boolean {
  const width = node.shaderParams?.find((p) => p.name === "width")?.number;
  return width != null && width < RIPPLE_HIDDEN_WIDTH;
}

/**
 * The streamed `width` of a ripple the game currently has SHOWN, or null.
 *
 * The positive twin of {@link rippleEffectivelyOff}, so `bakedEffects.ts` can ask the same question of the same
 * uniform against the same floor instead of re-deriving it.
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

// ---- DOES THE STAGE OWN THE EFFECT PIXELS? --------------------------------------------------------------------
//
// Latched by `renderer/canvas/createCanvasMirrorRenderer.ts` when it builds an fx registry, i.e. when the active
// canvas stage owns effect pixels, and un-latched on its dispose. A DOM-stage page never calls the setter, so it
// stays exactly as it was.
//
// Two decisions read it, both for the same underlying fact — on that stage an effect's host is
// `visibility: hidden` and its pixels are a quad in the stage's own draw list:
//   * the frozen-surface `<img>` swap is vetoed (`shaderResources.staticSurfacePolicy`) — there is no compositor
//     layer to remove, so every readback it takes buys nothing;
//   * the baked effect stills are vetoed (`bakedEffects`) — there the gsw binding IS what the draw list blits, so
//     suppressing one would delete the effect outright instead of substituting a still for it.
//
// A LATCH RATHER THAN AN IMPORT: `rendererFactory` -> `canvasRenderer` -> `shaderAttributes` -> the effect modules
// is an existing edge, so reading the factory from here would close it into a cycle. The canvas renderer pushes.
let stageOwnsEffectPixels = false;

/** Does the STAGE own effect pixels this page? Set by the canvas renderer when its fx registry exists. */
export function setStageOwnsEffectPixels(owns: boolean): void {
  stageOwnsEffectPixels = owns;
}

/** Exported for the spec — the veto's input, without a renderer to build. */
export function stageOwnsEffectPixelsNow(): boolean {
  return stageOwnsEffectPixels;
}

// The EFFECTIVE per-viewer effect mode the settings panel drives. The panel's mode IS the effective mode on every
// tier with a usable GPU path; only the HARD-OFF lane (?debug auto-player / ?quality=minimum / software-WebGL phone —
// see quality.ts) forces `off`, because there the runtimes would rasterize on the CPU for nothing and no DOM
// markers are stamped for them to find.
//
// This used to be an AND-gate against the tier's own enable flags, which is what made particles unreachable from
// the panel on the mobile `static` tier (and made the same panel setting mean different things on a phone and a
// desktop). MirrorView watches these to create/dispose + retune the shader + particle runtimes live without a
// reload (off ⇒ dispose; static ⇒ setStaticShaders/setStaticParticles; ½/¼ ⇒ setRenderScale) — the plain option
// objects in `shaderResources` stay the tier-fixed construction options.
export const effectiveShaderMode: ComputedRef<EffectMode> = computed(() =>
  shadersHardOff(quality) ? "off" : mirrorSettings.shaderMode
);
export const effectiveParticleMode: ComputedRef<EffectMode> = computed(() =>
  particlesHardOff(quality) ? "off" : mirrorSettings.particleMode
);
