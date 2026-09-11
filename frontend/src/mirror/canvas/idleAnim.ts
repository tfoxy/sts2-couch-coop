// THE IDLE-ANIMATION VOCABULARY AS NUMBERS — the missing half of the canvas stage's loop support (R3).
//
// The mirror replays two families of decorative animation on the browser's own clock, because the headless
// instance freezes them game-side to stop the wire churning: the PATH-KEYED folds (`animAttributes.nodeAnimBinding`
// — the energy/star orb spin, the enemy-intent bob, the candle flicker) and the WIRE-PINNED loops
// (`pinnedLoopAnim` — the map-point pulse, the top-bar rocks, the proceed and end-turn glows). On the DOM backend
// both arrive as `@spirectl/presentation` CSS keyframes, which is why the canvas backend had none of them: a draw
// list has no stylesheet, and `canvasRenderer` deliberately did not arm the loops it could already SCHEDULE
// (`tweenLoop`'s `PinnedLoopSpec`) because there was nothing to turn a phase into pixels with.
//
// This module is that missing piece and nothing else: phase in, transform/alpha out. It is PURE — no DOM, no
// scene walk, no lever of its own (the pinned family's four kill switches are passed IN) — so the numbers can be
// pinned against the CSS they mirror without a browser.
//
// ONE CAVEAT, named because it is the only place the two arms can disagree. Three of the wire-pinned tokens ride
// a self-layer CHILD on the DOM backend, whose scale/opacity therefore covers the node's OWN paint and not its
// children; a `post` matrix here covers the node's whole subtree, and an alpha multiplier lands on the node's
// `self_modulate` half, which does not cascade. For every token that rides that layer today the animated node is
// a LEAF (a top-bar `Control/Icon`, the proceed outline, `GlowVfx`), so the two are the same picture. A future
// token on an INTERIOR node would need a leaf-only transform channel, and this is where that would be said.
//
// WHY CLOSED FORMS RATHER THAN A KEYFRAME INTERPRETER. Every one of these animations is two keyframes plus a
// timing function, and four of the six are the same trick: a HALF-period `alternate` iteration eased with
// `cubic-bezier(0.37, 0, 0.63, 1)`, which presentation chose precisely because easeInOutSine(t) = (1 − cos πt)/2
// makes one leg an exact cosine, so the two legs join into a true sine. Substituting that back into the two
// extrema collapses the whole apparatus to one cosine per kind:
//
//     rotate         θ  = 2π·φ                                  (linear, full period, one turn)
//     rock           θ  = −amp·cos 2πφ                           (½-period alternate, easeInOutSine)
//     bob            dy = −base − amp·cos 2πφ                    (ditto; CSS −Y is up, as Godot's Up is)
//     pivotPulse     k  = from + (to − from)(1 − cos 2πφ)/2      (ditto)
//     glowPulse      a  = from + (to − from)·tri(φ)              (½-period alternate, LINEAR ⇒ a triangle)
//     pulseScaleFade at cssEaseOut(φ)                            (FULL period, `ease-out`, NO alternate)
//
// so a sample is a handful of arithmetic rather than an interpolator, and the forms are exact rather than close.
//
// THE PIVOT RULE, which is the one place a naive port goes wrong. The DOM needed a self-layer CHILD for the two
// rotation kinds because CSS applies an individual `rotate:` OUTSIDE the element's baked `matrix()`, so a rotation
// written on the node's own element ORBITS the design origin instead of spinning about the node. A draw list has
// no such constraint: it composes matrices itself, so the rotation is expressed as a node-LOCAL conjugation
// `T(p)·R(θ)·T(−p)` and right-multiplied onto the node's global — which is Godot's own semantics (a Control
// rotates about its `pivot_offset` in its own space) and needs no extra layer. `pivotPulse` is the same shape with
// a uniform scale, and there it is not merely equivalent to the DOM's spelling but IDENTICAL to it: a uniform
// scale commutes with any linear map, so `M·T(p)·S(k)·T(−p)` and the DOM's `T(M·p)·S(k)·T(−M·p)·M` are the same
// affine for every k. The bob is the one PRE: a parent-space translate, left-multiplied onto the node's own wire
// matrix, so the whole subtree rides it for free exactly as the DOM's nested `translate:` moves the holder's
// children.

import type { PresentationAnimationBinding } from "@spirectl/presentation/render";

import {
  nodeAnimBinding,
  pinnedLoopAnchorsToDocument,
  pinnedLoopBinding,
  pinnedLoopNodePivot
} from "@/mirror/animAttributes";
import type { MirrorNode } from "@/mirror/sceneTree";

/** The six kinds this module can evaluate. `flameFlicker` is deliberately absent — see {@link idleAnimPlanFor}. */
export type IdleAnimKind = "rotate" | "rock" | "bob" | "pivotPulse" | "glowPulse" | "pulseScaleFade";

/** Which channels a plan writes, hoisted so a sweep can skip the ones it does not. */
export type IdleAnimChannel = "pre" | "post" | "alpha" | "postAlpha";

/**
 * One node's resolved idle animation: everything a sample needs, with the node's geometry already folded in.
 *
 * Resolved once per node (the caller memoises on node identity) and sampled every frame, so the sample path
 * touches no strings, no scene and no allocation.
 */
export interface IdleAnimPlan {
  kind: IdleAnimKind;
  channel: IdleAnimChannel;
  /** `rock`: peak excursion in radians. */
  amplitudeRad: number;
  /** `bob`: peak excursion in px, and the constant upward offset it oscillates around. */
  amplitudePx: number;
  baselineUpPx: number;
  /** `pivotPulse` / `pulseScaleFade`: the sweep's scale extrema. */
  scaleFrom: number;
  scaleTo: number;
  /** `glowPulse` / `pulseScaleFade`: the sweep's alpha extrema, as MULTIPLIERS on the node's streamed alpha. */
  alphaFrom: number;
  alphaTo: number;
  /** The rotation/scale centre in the node's OWN local space. See the header's pivot rule. */
  pivotX: number;
  pivotY: number;
}

/** A sample's destination. Caller-owned and reused, which is what makes {@link sampleIdleAnim} allocation-free. */
export interface IdleAnimSample {
  /** Parent-space translate, applied BEFORE the node's own wire matrix (`bob`). */
  hasPre: boolean;
  preX: number;
  preY: number;
  /** Node-local 2x3, right-multiplied onto the node's global (`rotate`/`rock`/`pivotPulse`/`pulseScaleFade`). */
  hasPost: boolean;
  post: number[];
  /** A MULTIPLIER on the node's own painted alpha. 1 when the plan animates no alpha. */
  alpha: number;
}

export function createIdleAnimSample(): IdleAnimSample {
  return { hasPre: false, preX: 0, preY: 0, hasPost: false, post: [1, 0, 0, 1, 0, 0], alpha: 1 };
}

/** The node's placement box, as `nodeStyles.placementBox` answers it — the space every pivot below is in. */
export interface IdleAnimBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The plan for one presentation binding on a node with this box, or null when the kind has no numeric form.
 *
 * `flameFlicker` is the deliberate omission and stays one: it is not a periodic loop but two independent
 * self-chaining tween tracks whose visible paint lives on a per-quad gsw shader canvas, so its canvas port is an
 * FX-SURFACE composition problem rather than a transform problem. Filed, not built here.
 *
 * `pivot` overrides the box centre for the kinds that rotate about the node's authored `pivot_offset` (the
 * top-bar icons — deck 36,34 / map 42,32 / settings 32,33, which are NOT their box centres, and at a full 1 rad/s
 * spin a 1 px pivot error is a visible wobble). Everything else pivots about the box centre, which is what the
 * DOM's `transform-origin: 50% 50%` resolves to for exactly these elements.
 */
export function idleAnimPlanFor(
  binding: PresentationAnimationBinding,
  box: IdleAnimBox,
  pivot?: { x: number; y: number } | null
): IdleAnimPlan | null {
  const kind = binding.kind;
  if (kind !== "rotate" && kind !== "rock" && kind !== "bob" && kind !== "pivotPulse" && kind !== "glowPulse" && kind !== "pulseScaleFade") {
    return null;
  }
  if (!(binding.durationMs != null && binding.durationMs > 0)) {
    return null; // no cycle, no phase — the scheduler would refuse it too (`loopSpecFromBinding`)
  }
  const px = pivot ? box.x + pivot.x : box.x + box.width / 2;
  const py = pivot ? box.y + pivot.y : box.y + box.height / 2;
  return {
    kind,
    channel:
      kind === "bob" ? "pre" : kind === "glowPulse" ? "alpha" : kind === "pulseScaleFade" ? "postAlpha" : "post",
    amplitudeRad: binding.amplitudeRad ?? ROCK_AMPLITUDE_RAD,
    amplitudePx: binding.amplitudePx ?? BOB_AMPLITUDE_PX,
    baselineUpPx: binding.baselineUpPx ?? BOB_BASELINE_UP_PX,
    scaleFrom: binding.scaleFrom ?? 1,
    scaleTo: binding.scaleTo ?? 1,
    alphaFrom: binding.alphaFrom ?? 1,
    alphaTo: binding.alphaTo ?? 1,
    pivotX: px,
    pivotY: py
  };
}

/** Everything a caller needs to both SCHEDULE and SAMPLE one node's idle loop. See {@link resolveIdleAnim}. */
export interface ResolvedIdleAnim {
  /** The presentation binding, which is where the PERIOD and the per-node phase come from. */
  binding: PresentationAnimationBinding;
  plan: IdleAnimPlan;
  /**
   * Where the cycle's zero is. `"document"` for every loop whose game-side clock is unknowable and permanently
   * running (a map point seeds its phase randomly; the top-bar rocks started when a screen opened), so a shared
   * timeline plus a per-node offset is the honest answer AND keeps a re-resolved node from jumping. `"apply"` for
   * the one loop whose real start instant IS known — the end-turn glow starts the moment the button lights up,
   * which is the same delta that starts naming the token, and anchoring it would drop the browser into a random
   * point of a cycle that ends at opacity 0.
   */
  anchor: "document" | "apply";
}

/**
 * The idle animation for one node, from EITHER family, or null.
 *
 * TWO FAMILIES, one evaluator. The PATH-KEYED folds (`animAttributes.nodeAnimBinding` — the energy/star orb spin,
 * the enemy-intent bob) are always frozen on a known set of nodes, so a scene-path match resolves them. The
 * WIRE-PINNED loops (`node.pinnedLoopAnim` — the map-point pulse, the two top-bar rocks, the settings spin, the
 * proceed and end-turn glows) are named by the producer per node, because MEMBERSHIP CHANGES AT RUNTIME and
 * carries meaning: a map point pulses exactly while you may travel to it, and an end-turn button glows exactly
 * while the turn is idle and you have nothing left to play. The wire family wins where both could match, since a
 * producer that names a token is describing THIS node right now.
 *
 * The pinned family is the one that brings its own PIVOT: three of its tokens rotate about the node's authored
 * `pivot_offset` rather than about its box centre.
 */
export function resolveIdleAnim(
  node: MirrorNode,
  sceneRelPath: string | null,
  box: IdleAnimBox,
): ResolvedIdleAnim | null {
  const token = node.pinnedLoopAnim;
  if (token != null && token !== "") {
    // (0, 0) for the binding's OWN pivot fields: they are the DOM's, expressed in the space its baked matrix maps
    // into, and this arm conjugates in the node's own local space instead — see the header's pivot rule.
    const binding = pinnedLoopBinding(token, node.id, 0, 0);
    if (binding === null) {
      return null; // an unknown token from a newer producer: render the rest pose, exactly as the DOM does
    }
    const plan = idleAnimPlanFor(binding, box, pinnedLoopNodePivot(token));
    return plan === null
      ? null
      : { binding, plan, anchor: pinnedLoopAnchorsToDocument(token) ? "document" : "apply" };
  }
  const binding = nodeAnimBinding(sceneRelPath, node.nodeType);
  if (binding === null) {
    return null;
  }
  const plan = idleAnimPlanFor(binding, box);
  return plan === null ? null : { binding, plan, anchor: "document" };
}

/**
 * Evaluate a plan at `phase` ∈ [0,1) — `tweenLoop.loopPhase`'s answer — into a caller-owned sample.
 *
 * Allocation-free and idempotent. Every form is the header's; the two rotation kinds and the two scale kinds
 * share `postRotate` / `postScale`, which are the only places a pivot conjugation is spelt.
 */
export function sampleIdleAnim(plan: IdleAnimPlan, phase: number, out: IdleAnimSample): void {
  out.hasPre = false;
  out.hasPost = false;
  out.preX = 0;
  out.preY = 0;
  out.alpha = 1;
  const turn = TAU * phase;
  switch (plan.kind) {
    case "rotate":
      // One full turn per cycle, at constant speed — the whole turn takes `durationMs`.
      postRotate(out, turn, plan.pivotX, plan.pivotY);
      break;
    case "rock":
      // ±amplitude about rest, starting at −amplitude (the keyframe's `from`) and reaching +amplitude at φ = ½.
      postRotate(out, -plan.amplitudeRad * Math.cos(turn), plan.pivotX, plan.pivotY);
      break;
    case "bob":
      // The holder rides UP by `sin(t)·amp + baseline`; CSS −Y is up, and the keyframes run peak → trough, so the
      // eased leg is a cosine that starts at the TOP.
      out.hasPre = true;
      out.preY = -(plan.baselineUpPx + plan.amplitudePx * Math.cos(turn));
      break;
    case "pivotPulse":
      postScale(out, plan.scaleFrom + (plan.scaleTo - plan.scaleFrom) * (1 - Math.cos(turn)) / 2, plan.pivotX, plan.pivotY);
      break;
    case "glowPulse":
      // Two LINEAR legs, so the composite is a triangle wave — not a sine. That straight ramp is the one thing
      // that makes this loop read as a shimmer rather than a breathe.
      out.alpha = plan.alphaFrom + (plan.alphaTo - plan.alphaFrom) * triangle(phase);
      break;
    case "pulseScaleFade": {
      // The one kind that does NOT alternate: both parallel channels restart from their start values every cycle
      // rather than easing back, so the browser runs a full-period `ease-out` iteration.
      const t = cssEaseOut(phase);
      postScale(out, plan.scaleFrom + (plan.scaleTo - plan.scaleFrom) * t, plan.pivotX, plan.pivotY);
      out.alpha = plan.alphaFrom + (plan.alphaTo - plan.alphaFrom) * t;
      break;
    }
  }
}

const TAU = Math.PI * 2;
/** presentation's `ROCK_AMPLITUDE_RAD` / `BOB_*` defaults, so a binding that omits them lands where CSS does. */
const ROCK_AMPLITUDE_RAD = 0.12;
const BOB_AMPLITUDE_PX = 10;
const BOB_BASELINE_UP_PX = 8;

/** `T(p) · R(θ) · T(−p)` — a rotation about the node's own pivot, in the node's own local space. */
function postRotate(out: IdleAnimSample, theta: number, px: number, py: number): void {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const m = out.post;
  m[0] = c;
  m[1] = s;
  m[2] = -s;
  m[3] = c;
  m[4] = px - c * px + s * py;
  m[5] = py - s * px - c * py;
  out.hasPost = true;
}

/** `T(p) · S(k) · T(−p)` — a uniform scale about the same pivot. See the header for why this IS the DOM's. */
function postScale(out: IdleAnimSample, k: number, px: number, py: number): void {
  const m = out.post;
  m[0] = k;
  m[1] = 0;
  m[2] = 0;
  m[3] = k;
  m[4] = (1 - k) * px;
  m[5] = (1 - k) * py;
  out.hasPost = true;
}

/** A half-period `alternate` at LINEAR timing: 0 → 1 over the first half, back over the second. */
function triangle(phase: number): number {
  return phase < 0.5 ? phase * 2 : 2 - phase * 2;
}

/**
 * CSS `ease-out` — `cubic-bezier(0, 0, 0.58, 1)` — solved for y at x = `phase`.
 *
 * NOT `godotEaseSample`. This matches what the BROWSER does on the DOM arm, and presentation writes the CSS
 * keyword rather than a Godot easing: the halo's own leg is a quartic ease-out, the DOM arm has always
 * approximated it with `ease-out`, and the canvas arm's job is to agree with the arm the player sees. Substituting a different
 * curve here would put a visible divergence between two stages of the same client.
 *
 * Newton from `t = x` (the curve is monotone and gently sloped, so four steps land inside 1e-7 across the whole
 * unit interval), with a bisection-free bail: a derivative near zero only happens at the endpoints, where `t = x`
 * is already the answer to within the tolerance.
 */
export function cssEaseOut(phase: number): number {
  const x = phase <= 0 ? 0 : phase >= 1 ? 1 : phase;
  if (x === 0 || x === 1) {
    return x;
  }
  // Polynomial coefficients of the x and y components for control points (0, 0.58) / (0, 1).
  const bx = 3 * 0.58;
  const ax = 1 - bx;
  const by = 3;
  const ay = 1 - by;
  let t = x;
  for (let i = 0; i < 5; i++) {
    const fx = (ax * t + bx) * t * t - x;
    if (fx > -1e-9 && fx < 1e-9) {
      break;
    }
    const dx = (3 * ax * t + 2 * bx) * t;
    if (dx > -1e-6 && dx < 1e-6) {
      break;
    }
    t -= fx / dx;
  }
  return (ay * t + by) * t * t;
}
