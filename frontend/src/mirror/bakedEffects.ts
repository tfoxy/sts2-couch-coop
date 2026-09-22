// BAKED EFFECT STILLS — what the mirror paints where a WebGL effect would be, when that effect family is OFF or
// STATIC.
//
// THE GAP THIS FILLS. `Shaders: Off` / `Particles: Off` is not a debug lane. It is what the `minimum` quality rung
// writes (`qualityPreset.ts`) and what the hard-off floor forces on a software-WebGL phone, so it is the
// configuration the WEAKEST devices ship with. In it the mirror renders NOTHING for two families of cue that the
// game uses to tell a player something:
//
//   * `res://shaders/card_ripple.gdshader` on a card's `Highlight` (`NCardHighlight`) — the glow that says a card
//     is PLAYABLE, and in gold/red variants that a different rule applies. `nodeStyles.paintsTexture` suppresses
//     the node's own texture deliberately (it is `card_frame_sdf.exr`, shader INPUT, a meaningless grey blob on
//     its own — see `isShaderInputNode`), so Off means no glow AND no blob: nothing.
//   * `res://scenes/vfx/uncommon_glow_vfx.tscn` / `rare_glow_vfx.tscn` — the rarity shimmer behind a card. Both
//     are `GPUParticles2D` roots, and a particle node's pixels only ever come from the gsw runtime, so Off is
//     again nothing at all.
//
// THE ANSWER is one PNG per effect, rendered ONCE by the real game (`scripts/bake-effect-stills.py`), committed,
// and bundled into the app by Vite. Zero GPU cost, one decode, and the cue survives on the devices that need the
// saving most.
//
// AND THE SAME PNG SERVES `static`, THE PRODUCT DEFAULT — which is where it stops being a fallback and starts
// being a saving. In `static` gsw renders one frozen frame per binding and `shaderResources.staticSurfacePolicy`
// then swaps each quiet canvas for an `<img>`: a GPU→CPU READBACK plus a PNG encode, per surface. Nearly every
// tuned constant in that file exists to bound the damage — kicking all 72 fleet encodes at once parked the main
// thread for 736 ms; a reshuffle trace caught single tasks of 285 ms and 1,163 ms at 97% self-time inside native
// `toBlob`, for surfaces that cost 6-13 ms each unloaded — and its `onInvalidate: "retry"` note named the biggest
// offender: `card_ripple`, whose content key churns on `width`, so a hand re-encodes through every playability
// tween. A committed still replaces that whole population with one decode, and the bakes ARE the frames the
// client was paying to produce.
//
// THE THREE DYNAMIC MODES KEEP THE LIVE PATH. `dynamic`, `dynamic-half` and `dynamic-quarter` exist to animate,
// and a still is not a cheaper animation.
//
// ---------------------------------------------------------------------------------------------------------------
// WHAT THE STILLS ARE, AND THE TWO CONTRACTS A CONSUMER MUST HONOUR
//
// 1. THEY ARE ADDITIVE. All three effects are `blend_add` in the game, and each still was captured over an opaque
//    black backdrop and converted to straight alpha, so `rgb x alpha` IS the contribution the game adds. Paint
//    them with `mix-blend-mode: plus-lighter` and the result matches; paint them normally and a glow reads as a
//    grey film. The glows get that blend for free — the producer streams their additive CanvasItemMaterial as
//    `canvasBlendMode: 1` and `nodeStyle` already maps it — but the ripple's blend is declared by the SHADER, not
//    by a material, so nothing streams it and this module has to say so.
//
// 2. THE MODULATE IS NOT BAKED IN, and must not be applied twice. The ripple still is NEUTRAL (white) on purpose:
//    `card_ripple` only ever writes `COLOR.a`, so its rgb passes through as `texture.rgb x modulate.rgb`, and the
//    mirror already multiplies every node by its own streamed modulate through an feColorMatrix
//    (`svgDefsRegistry.registerTint`, a plain per-channel multiply). One white bake x that existing tint therefore
//    reproduces all three `NCardHighlight` colours — playable cyan, gold, red — and any colour added later,
//    EXACTLY. So the paint path must leave the node's own tint filter alone and add no second tint.
//    The glow stills are likewise captured at full opacity while the game's scripts tween `modulate:a` to 0.9;
//    the mirror streams that 0.9 as element opacity, which is where it belongs.
//
// THE NODE-LOCAL BOX of each still is the rect the bake captured, one node-local unit per captured pixel. The
// numbers below are the numbers `scripts/bake-effect-stills.py` asked the game for; the script prints them after
// every run so the two can be checked against each other.
//
// ONE POLICY, ONE MECHANISM-FREE MODULE (the `creaturePlaceholder.ts` shape): this file decides WHETHER a node
// gets a still and WHERE it goes. The DOM renderer owns how it is mounted, and the two effect-binding builders
// (`shaderAttributes` / `particleAttributes`) ask {@link bakedStillCoversNode} whether to build a binding at all.
//
// SCOPE: the DOM stage (`?stage=dom`, the shipping default). The opt-in `?stage=canvas` backend is deliberately
// untouched — see `canvas/paintSpec.ts`'s note and `bakedEffects.spec.ts` — and that is enforced here rather than
// only documented: on that stage the gsw binding IS what the draw list blits (`paintSpec.fxHostIsLive` is
// literally "the builder returned a binding"), so suppressing one there would delete the effect outright instead
// of substituting for it. Hence the `stageOwnsEffectPixelsNow()` term in {@link stillsCover}.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only.

import cardRippleStill from "@/assets/effects/card-ripple.png";
import glowRareStill from "@/assets/effects/glow-rare.png";
import glowUncommonStill from "@/assets/effects/glow-uncommon.png";

// `effectPolicy`, NOT `shaderResources` (which re-exports all four): this module is reached from the binding
// builders, and `particleAttributes` is reached from `sceneTree`'s own initialization — see effectPolicy's header
// for why importing the gsw mount options from there would be a module-init hazard.
import {
  effectiveParticleMode,
  effectiveShaderMode,
  rippleShownWidth,
  stageOwnsEffectPixelsNow,
  CARD_RIPPLE_SHADER_IDS
} from "@/mirror/effectPolicy";
import type { MirrorNode } from "@/mirror/sceneTree";

/** A node-local rectangle, in the same units the producer streams `localRect` in. */
export interface BakedStillBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BakedStill {
  /** The bundled image URL (Vite resolves it to a hashed `/app/…png`). */
  url: string;
  /**
   * The node-local rect the image covers, or `"localRect"` when the still was baked at the node's OWN box and the
   * element can simply paint it across itself. The ripple is the latter; a boxless emitter cannot be.
   */
  box: BakedStillBox | "localRect";
  /**
   * Whether this paint must carry `mix-blend-mode: plus-lighter` ITSELF. False where the node already streams an
   * additive `canvasBlendMode` that `nodeStyle` maps — adding it here too would be harmless but misleading about
   * where the blend comes from.
   */
  additive: boolean;
  /**
   * A multiplier on the node's painted opacity, for an effect whose live intensity is streamed as a shader
   * uniform rather than as modulate. 1 for everything that has no such uniform.
   */
  opacityScale: number;
}

/**
 * The `width` uniform `NCardHighlight.AnimShow` tweens to when a card becomes playable, and the value the ripple
 * still was baked at. `AnimFlash` briefly overshoots to 0.15; scaling opacity by `width / SHOWN` therefore peaks
 * above 1 there, which is why the scale is clamped rather than used raw.
 */
export const CARD_RIPPLE_SHOWN_WIDTH = 0.075;

/** The two rarity-glow emitters, by the node type the producer streams. */
const UNCOMMON_GLOW_NODE_TYPE = "MegaCrit.Sts2.Core.Nodes.Vfx.Cards.NCardUncommonGlow";
const RARE_GLOW_NODE_TYPE = "MegaCrit.Sts2.Core.Nodes.Vfx.Cards.NCardRareGlow";

// The captured rects, echoing `scripts/bake-effect-stills.py`'s BAKES table. Centred on the emitter origin,
// because a particle node has no `localRect` — the producer streams none for a `GPUParticles2D`, so `placementBox`
// gives it a zero box at its transform origin and the still has to state its own extent.
//
// Both are wider than the measured content (the uncommon emitter reaches ~210 node-local units, the rare ~300).
// That headroom is not padding for its own sake: these are STOCHASTIC emitters, so a re-bake does not land on the
// same particles, and a rect trimmed to one run's content would clip the next.
const UNCOMMON_GLOW_BOX: BakedStillBox = { x: -256, y: -256, width: 512, height: 512 };
const RARE_GLOW_BOX: BakedStillBox = { x: -384, y: -384, width: 768, height: 768 };

/** True when this node is a card highlight running the ripple shader. */
function isCardRippleNode(node: MirrorNode): boolean {
  return node.shaderId != null && CARD_RIPPLE_SHADER_IDS.includes(node.shaderId);
}

/** A node's entitlement to a still, and the effect family whose mode decides whether it is served. */
interface BakedStillEntry {
  still: BakedStill;
  family: "shader" | "particle";
}

/**
 * The still this node WOULD paint, ignoring the effect mode entirely — identity, box, blend, opacity.
 *
 * Null for the overwhelming majority of nodes, and the gate is ordered so they pay almost nothing: a node with
 * neither a shader nor a particle spec returns on one field read.
 */
function bakedStillEntryFor(node: MirrorNode): BakedStillEntry | null {
  if (node.shaderId != null) {
    if (!isCardRippleNode(node)) {
      return null;
    }
    // The game hides the ripple by tweening `width` to 0, so a still painted regardless would light up every
    // unplayable card. `rippleShownWidth` answers null when the uniform is not streamed at all, and an effect we
    // cannot measure is left unpainted rather than guessed at — the same rule the WebGL path's dormancy gate uses.
    // It is MODE-INDEPENDENT on purpose: it is also what keeps such a node's live binding (see
    // `bakedStillCoversNode`), so an unmeasurable ripple renders the real shader rather than nothing at all.
    const width = rippleShownWidth(node);
    if (width == null) {
      return null;
    }
    return {
      family: "shader",
      still: {
        url: cardRippleStill,
        // The bake captured the node's own 759x951 `localRect`, so the element paints it across itself 1:1.
        box: "localRect",
        // Declared by the shader's `render_mode blend_add`, which nothing streams — see the header.
        additive: true,
        // Reproduces the 0.5 s AnimShow/AnimHide fade instead of popping the glow on at every energy change.
        // Clamped for `AnimFlash`, which overshoots to 0.15.
        opacityScale: Math.min(1, width / CARD_RIPPLE_SHOWN_WIDTH)
      }
    };
  }

  if (node.particleSpec == null) {
    return null;
  }
  if (node.nodeType === UNCOMMON_GLOW_NODE_TYPE) {
    // `additive: false` — the emitter's `canvas_item_material_additive_shared.tres` already reaches the DOM as
    // `canvasBlendMode: 1`, and `nodeStyle` maps that to `plus-lighter` for us.
    return {
      family: "particle",
      still: { url: glowUncommonStill, box: UNCOMMON_GLOW_BOX, additive: false, opacityScale: 1 }
    };
  }
  if (node.nodeType === RARE_GLOW_NODE_TYPE) {
    return { family: "particle", still: { url: glowRareStill, box: RARE_GLOW_BOX, additive: false, opacityScale: 1 } };
  }
  return null;
}

/**
 * Does a committed still stand in for this FAMILY right now?
 *
 * The mode gate reads the EFFECTIVE per-viewer mode rather than the device tier, which is what makes this cover
 * both ways a viewer reaches Off — choosing it in the panel on a capable device, and the hard-off floor where no
 * WebGL path exists at all. A tier flag alone would miss the first.
 *
 * `static` joins `off` because in that mode the client was BAKING these same frames itself, once per surface, at
 * a readback + PNG encode each (see the header). The three dynamic modes are excluded: they exist to animate.
 *
 * The stage term is the DOM-stage scope, enforced rather than documented — see the header.
 */
function stillsCover(family: "shader" | "particle"): boolean {
  if (stageOwnsEffectPixelsNow()) {
    return false;
  }
  const mode = family === "shader" ? effectiveShaderMode.value : effectiveParticleMode.value;
  return mode === "off" || mode === "static";
}

/** The baked still this node should paint, or null. */
export function bakedStillFor(node: MirrorNode): BakedStill | null {
  const entry = bakedStillEntryFor(node);
  return entry !== null && stillsCover(entry.family) ? entry.still : null;
}

/**
 * True when a committed still is standing in for this node's live effect — so the effect's own BINDING must not
 * be built (`shaderAttributes` / `particleAttributes` both gate on this).
 *
 * Deliberately the same answer as `bakedStillFor(node) !== null`, by construction rather than by agreement: a
 * node whose binding is suppressed but whose still declines to paint would render NOTHING, which is the one
 * failure mode this pair has. Hence one entry helper, one mode helper, two thin readers.
 */
export function bakedStillCoversNode(node: MirrorNode): boolean {
  const entry = bakedStillEntryFor(node);
  return entry !== null && stillsCover(entry.family);
}

/** True when this node paints a baked still INSTEAD of a boxless effect surface (the glow emitters). */
export function bakedStillNeedsOwnLayer(still: BakedStill): boolean {
  return still.box !== "localRect";
}
