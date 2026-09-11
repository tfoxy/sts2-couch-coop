// WIRE HINT → CHANNEL HINT. The pure half of `mirrorRenderer.applyTweenHints`.
//
// A `MirrorTweenHint` off the wire is not yet something an evaluator can run: one hint may drive TWO channels, its
// opacity endpoint is a raw Godot `modulate.a` / `self_modulate.a` that has to be folded against the node's OTHER
// alpha factor before it is a painted value, and WHICH element carries that fold depends on whether the target has
// children. `applyTweenHints` does all of that inline, mixed in with the DOM writes. This module is the same
// decision table with the DOM removed, so the canvas renderer arrives at `createTweenLoop().applyHints()` with a
// flat list of `(nodeId × channel)` endpoints and no policy left to get wrong.
//
// WHAT STAYS WITH THE CALLER. Everything that needs the scene tree: resolving the target, lifting a "local"-space
// endpoint through the parent global (`liftEndpointToGlobal`), and the wide-screen spread shift the endpoint's own
// X claims (`spreadDxAtGlobal`). Those are geometry the walk owns; this module takes the already-GLOBAL 6-tuple.
// See `TweenTargetFacts`.

import { godotEaseSample } from "@godot-scene-web/effects/easing";

import type { MirrorTweenHint } from "@/mirror/sceneTree";

/**
 * The three independent channels a node can be driven on, exactly as `mirrorRenderer`'s record carries them:
 *
 * - `transform` — the node's own global Transform2D.
 * - `opacity` — the node's ELEMENT alpha. A `modulate` fade drives it (and CASCADES to descendants, which is why
 *   the DOM path needs no subtree fan); a `self_modulate` fade on a LEAF folds into it too, because a leaf has no
 *   cascade to protect.
 * - `selfOpacity` — an INTERIOR node's OWN-PAINT alpha. `self_modulate` on a node WITH children must not touch the
 *   children, so it drives a separate self-paint layer. On a canvas that is "the node's own draw call's alpha",
 *   with children unaffected.
 */
export type TweenChannel = "transform" | "opacity" | "selfOpacity";

/** The two alpha channels, i.e. everything that is not `transform`. */
export type OpacityChannel = "opacity" | "selfOpacity";

/**
 * One resolved endpoint, ready to arm. Exactly one of the transform / opacity pairs is populated, chosen by
 * `channel`.
 */
export interface TweenLoopHint {
  nodeId: string;
  channel: TweenChannel;
  /** Always > 0 — a hint with a non-positive duration is dropped by the planner, as `applyTweenHints` drops it. */
  durationMs: number;
  /** Raw Godot enum names, handed straight to `godotEaseSample`. */
  ease: string | null;
  trans: string | null;
  /** `transform` channel: the target's END GLOBAL 6-tuple, already lifted + spread-shifted by the caller. */
  endTransform: readonly number[] | null;
  /** `transform` channel: the DECLARED start, when the tween carried `.From(...)`. Null ⇒ arm from the live pose. */
  startTransform: readonly number[] | null;
  /** Opacity channels: the END PAINTED alpha (the raw wire alpha already folded — see `planTweenHints`). */
  endOpacity: number | null;
  /** Opacity channels: the declared start, folded the same way. Null ⇒ arm from the live alpha. */
  startOpacity: number | null;
  /**
   * HIDE-LATCH SIGNATURE (element `opacity` channel only, and only for a fade-OUT): the node's PRE-fade painted
   * alpha. The producer streams it unchanged right through the fade and then ships one "resting alpha + visible"
   * drain before hiding the node — the flash the latch exists to swallow. Null on a partial fade and on the
   * `selfOpacity` channel.
   */
  restingAlpha: number | null;
  /** The wire `group` that ties one Godot tween's transform + opacity hints together. Carried through verbatim. */
  group: string | null;
}

/**
 * What the walk knows about a hint's target that the planner cannot work out for itself.
 *
 * `hasChildren` decides the `self_modulate` routing (interior → its own paint layer, leaf → fold into the
 * element). `modAlpha`/`selfAlpha` are the node's CURRENT `modulate.a` and `self_modulate.a` — the factors the
 * endpoint multiplies against, read at hint time exactly as `applyTweenHints` reads them off `targetNode`.
 * `endTransformGlobal`/`startTransformGlobal` are the hint's endpoints ALREADY lifted into global space (and, on
 * a wide stage, already carrying the endpoint's own spread shift).
 */
export interface TweenTargetFacts {
  hasChildren: boolean;
  modAlpha: number;
  selfAlpha: number;
  endTransformGlobal: readonly number[] | null;
  startTransformGlobal: readonly number[] | null;
}

/** Below this the fade's endpoint counts as "gone" — `mirrorRenderer.HIDE_LATCH_ALPHA_EPS`, verbatim. */
export const HIDE_LATCH_ALPHA_EPS = 0.01;

/** True for the two raw Godot properties that drive a node's OWN paint alone. */
export function isSelfModulateProperty(property: string): boolean {
  return property === "self_modulate:a" || property === "self_modulate";
}

/**
 * Turn one wire hint into 0-2 channel hints. Returns nothing (and appends nothing) for a hint with no usable
 * endpoint or a non-positive duration — the same two early-outs `applyTweenHints` takes.
 *
 * `facts` null ⇒ the target is not mirrored: the hint is a one-shot and is dropped, exactly as the DOM path drops
 * a hint whose `records.get(targetId)` misses.
 */
export function planTweenHint(
  hint: MirrorTweenHint,
  facts: TweenTargetFacts | null,
  out: TweenLoopHint[]
): void {
  const hasTransform = !!hint.endTransform && hint.endTransform.length === 6;
  const hasOpacity = hint.endOpacity != null;
  if (!hasTransform && !hasOpacity) {
    return;
  }
  if (!facts) {
    return;
  }
  const durationMs = Math.max(0, hint.durationMs);
  if (durationMs <= 0) {
    return;
  }
  const ease = hint.ease ?? null;
  const trans = hint.trans ?? null;
  const group = hint.group ?? null;

  if (hasTransform && facts.endTransformGlobal) {
    out.push({
      nodeId: hint.targetId,
      channel: "transform",
      durationMs,
      ease,
      trans,
      endTransform: facts.endTransformGlobal,
      startTransform: facts.startTransformGlobal ?? null,
      endOpacity: null,
      startOpacity: null,
      restingAlpha: null,
      group
    });
  }

  if (!hasOpacity) {
    return;
  }
  const m1 = hint.endOpacity as number;
  const m0 = hint.startOpacity; // null unless the tween declared `.From(...)`
  const isSelf = isSelfModulateProperty(hint.property);
  const { modAlpha, selfAlpha, hasChildren } = facts;

  if (isSelf && hasChildren) {
    // INTERIOR + self_modulate: the node's own paint fades to `m1` and the children keep the container's
    // untouched `modulate.a`. The endpoint is the raw m1 — there is no other factor on that layer.
    out.push({
      nodeId: hint.targetId,
      channel: "selfOpacity",
      durationMs,
      ease,
      trans,
      endTransform: null,
      startTransform: null,
      endOpacity: m1,
      startOpacity: m0 ?? null,
      restingAlpha: null,
      group
    });
    return;
  }

  // ELEMENT opacity. Interior element alpha = modulate.a; leaf element alpha = modulate.a × self_modulate.a. A
  // `modulate` fade drives the modulate.a factor, a `self_modulate` fade on a leaf drives the selfAlpha factor —
  // so exactly one of the two is animated and the other rides along as a constant multiplier.
  const leafSelfFactor = hasChildren ? 1 : selfAlpha;
  const endVal = isSelf ? modAlpha * m1 : m1 * leafSelfFactor;
  const startVal = isSelf ? modAlpha * (m0 ?? 0) : (m0 ?? 0) * leafSelfFactor;
  out.push({
    nodeId: hint.targetId,
    channel: "opacity",
    durationMs,
    ease,
    trans,
    endTransform: null,
    startTransform: null,
    endOpacity: endVal,
    startOpacity: m0 == null ? null : startVal,
    // Only a fade that SETTLES at ~0 is a disappear, and only then is the pre-fade painted alpha worth capturing.
    restingAlpha: endVal <= HIDE_LATCH_ALPHA_EPS ? modAlpha * leafSelfFactor : null,
    group
  });
}

/** `planTweenHint` over a batch, resolving each target through `facts`. Allocates one array. */
export function planTweenHints(
  hints: readonly MirrorTweenHint[],
  facts: (hint: MirrorTweenHint) => TweenTargetFacts | null
): TweenLoopHint[] {
  const out: TweenLoopHint[] = [];
  for (const hint of hints) {
    planTweenHint(hint, facts(hint), out);
  }
  return out;
}

/**
 * The eased progress of a hint at `elapsedMs`, in [0, 1]. Thin, but it is THE place the mirror's replay meets
 * Godot's own equations, so it is named rather than inlined: `godotEaseSample` reproduces
 * `scene/animation/easing_equations.h` exactly, including returning 1 at t >= 1 (which is `PropertyTweener::step`
 * assigning `final_val` outright, not a rounding convenience).
 */
export function easedProgress(hint: TweenLoopHint, elapsedMs: number): number {
  const raw = hint.durationMs > 0 ? elapsedMs / hint.durationMs : 1;
  return godotEaseSample(hint.ease ?? undefined, hint.trans ?? undefined, raw);
}
