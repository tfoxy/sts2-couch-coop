// Card-flight replay — a card sweeping between the piles, integrated CLIENT-SIDE from a declarative hint instead of
// received as ~60 transform deltas per second per flying card. Pure module (no DOM, no renderer state) so the
// integrator/curve math is unit-testable; the renderer owns the elements and drives this from its animation loop,
// exactly the split cardTrail.ts uses.
//
// R13: there are now TWO kinds sharing all of this — "shuffle" (the discard→draw sweep this module was written for)
// and "discard" (the hand→discard fly, whose mover is the real played card). They share the curve, the two-phase
// integrator and the whole closed-form timing; they differ only in the rotation and scale channels. See the
// DISCARD_* block below for that contract, and `MirrorCardFlightHint.kind` for the wire side.
//
// WHY THIS EXISTS
// ---------------
// A reshuffle puts one flying card node (`NCardFlyShuffleVfx`) on screen per shuffled card, each dragging an
// `NCardTrailVfx` comet behind it. None of that motion is a Godot `Tween`, so the producer's tween recorder (a
// `Tween`-construction hook) has nothing to capture, and the only way the animation could reach the mirror was as
// streamed per-frame transforms. Measured on a 34.8s wire recording taken with instant acks (i.e. the uncoalesced
// truth):
//
//   segment            upserts    of which this subtree
//   4–8s enemy turn    1288 KB    143 KB  (11%)
//   8–10s SHUFFLE      1340 KB    598 KB  (45%) — 1852 of 3469 upserts
//   10–34s idle        1331 KB    ~1%
//
// And because scene deltas are credit-gated on the client's `scene-ack`, a client that cannot keep up gets FEWER
// deltas — so the animation literally played at the client's frame rate. A DevTools trace of the same shuffle
// measured 9.4 fps for 1.7 s (median client frame 95 ms) while the host's ack→delta stayed 19–24 ms throughout.
// Replaying locally removes the bytes AND decouples the animation from the wire: the trail below now gets 60
// samples/s instead of 9, i.e. it looks BETTER, not merely cheaper.
//
// THE REPLAY MODEL
// ----------------
// The producer publishes ONE declarative hint per flight — both endpoints, the bezier control point, the starting
// speed, the acceleration and the duration, all already resolved into streamed space (see MirrorCardFlightHint)
// — and this module integrates a pose out of it. On screen the flight reads as three beats:
//
//   1. an ARC. The card sweeps along a quadratic bezier between the two piles, speeding up as it goes, and always
//      faces along the curve: the angle comes from a fixed look-ahead step plus a quarter turn, so the card's long
//      axis lies on its own path rather than staying upright.
//   2. a POP. The card arrives exactly on the target anchor and stops travelling; only its scale keeps moving,
//      ramping down through zero — the "put away" beat that ends with the card gone.
//   3. a FADE. Alpha to 0 over the last of it. That beat IS a real tween, so it arrives as an ordinary
//      MirrorTweenHint and nothing here replays it.
//
// A flight's parameters are fixed the moment it starts and never change afterwards, which is what makes a single
// declarative hint enough and a client-side replay possible at all.
//
// UNITS. `time` and `duration` below are a PSEUDO-TIME, not seconds: `time` accumulates `speed*dt` with speed
// ≈ 1.1…1.25 and rising, so it runs 15–100% fast against the wall clock. Both the arc's shape and the pop's ramp
// are expressed in that unit; `cardFlightTiming` is the closed-form conversion to seconds.

import type { MirrorCardFlightHint } from "@/mirror/sceneTree";

// How far ahead along the curve the facing is sampled, in pseudo-time units: the card points at where it is about
// to be, which is what keeps its long axis lying along the arc instead of wobbling.
export const FLIGHT_ROTATION_LOOK_AHEAD = 0.05;

// The shuffle pop's scale ramp endpoints. The ramp is deliberately UNCLAMPED and floored at 0 instead, so the card
// has shrunk to nothing halfway through the pop and stays gone for the rest of it.
export const FLIGHT_POP_SCALE_FROM = 0.1;
export const FLIGHT_POP_SCALE_TO = -0.1;

// ---- R13: the SECOND flight kind, "discard" -------------------------------------------------------------------
//
// Same two-phase arc, same pseudo-time integrator, same bezier — `cardFlightTiming` is shared unchanged. What is
// different is WHAT IS MOVING. The shuffle's flier is a throwaway silhouette spawned at the draw pile for the
// sweep; the discard's mover is the REAL card the player just played — the same element that was resting in the
// hand a frame earlier, face and all. Two consequences on screen, and they are the whole of this kind:
//
//   ROTATION. A card that is already lying at some angle in the hand must TURN OUT of that angle, not snap onto the
//   curve's tangent on its first frame. So the on-screen global angle CHASES (tangent + PI/2) — seeded at the
//   hint's `rot0`, each frame stepping a fixed fraction of the remaining shortest arc. The rate is per WALL second
//   (a `1 - e^{-k·dt}`-shaped approach sampled discretely), so a slower display turns the card in fewer, bigger
//   steps and lands in the same place; 60fps is the reference cadence the constant was picked against.
//
//   SCALE. The card SHRINKS as it flies instead of staying full-size to the pile: 1 → 0.1 over the FIRST THIRD of
//   the arc's pseudo-time, held at 0.1 for the rest of it, and then the pop runs 0.1 → 0 as the card is put away.
//   Unlike the shuffle's, this multiplier is ABSOLUTE — it is not divided by `scale0`. The shuffle divides because
//   its flier's spawn scale is baked into `basis` and its pop ASSIGNS an absolute size on top; the discard's shrink
//   is a channel of its own that multiplies whatever the card was already drawn at, which is what `basis` carries.
//
// The card also DARKENS white→black down the arc. That is an ordinary modulate animation, it keeps streaming as
// deltas, and nothing here replays it.
export const DISCARD_ARC_SCALE_FROM = 1;
export const DISCARD_ARC_SCALE_TO = 0.1;

// The arc's shrink is complete at ONE THIRD of the arc's pseudo-time: `w = clamp01(time * 3 / duration)`. (Weighting
// in pseudo-time rather than wall clock is deliberate — it is the same clock the position walks, so the card is
// always the same size at the same point ON THE CURVE whatever the frame rate.)
export const DISCARD_RAMP_PSEUDOTIME_FACTOR = 3;

// The pop's `lerp(0.1, -0.15, progress)` endpoints, and the progress at which that crosses zero — a steeper ramp
// than the shuffle's, so the card is gone by 0.4 of the pop rather than 0.5. Pinned as its own constant because the
// keyframe builder must put a sample EXACTLY on the kink (a keyframe pair straddling it would cut the corner and
// leave the card visible past the moment it should have vanished).
export const DISCARD_POP_SCALE_FROM = 0.1;
export const DISCARD_POP_SCALE_TO = -0.15;
export const DISCARD_POP_ZERO_PROGRESS = 0.4;

// How fast the discard's angle chases the tangent, in units of "fraction of the remaining arc per WALL second":
// `weight = min(1, 12 * dt)`, i.e. ~20% of the gap closed per 60Hz frame. Wall clock, not pseudo-time — the turn is
// something the eye follows in real seconds while the card is also being read.
export const FLIGHT_ROTATION_SMOOTH_RATE = 12;

// The largest step the integrator will take in one advance. A backgrounded tab stops firing rAF, so the first
// frame back can carry a multi-SECOND delta; stepping it whole would teleport the card (and lay one absurd trail
// chord). Catching up over a few frames instead is both cheaper and correct-looking, and if the stall outlasts the
// hint's `windowMs` the renderer's pin expires and the producer's resumed stream takes over — the self-heal.
export const FLIGHT_MAX_STEP_SECONDS = 0.1;

export type CardFlightPhase = "arc" | "pop" | "done";

// One in-flight card's integrator state. Mutated in place (one flight per shuffled card, ~60 steps/s each — an
// immutable step would allocate a few thousand short-lived objects per reshuffle).
export interface CardFlightState {
  phase: CardFlightPhase;
  // The pseudo-time accumulator, reset to 0 when phase 2 starts.
  time: number;
  // The pseudo-time rate: phase 1 accelerates it, phase 2 carries it forward frozen.
  speed: number;
  // The last rotation the arc produced; phase 2 holds it (the animation stops writing an angle once it lands).
  // For a "discard" this is also CARRIED FORWARD between frames on the arc — the angle chases the tangent rather
  // than being re-derived from it, so the previous frame's value is an input, not just a fallback.
  rotation: number;
}

// The pose one advance produced, in the hint's streamed space.
export interface CardFlightPose {
  x: number;
  y: number;
  rotation: number;
  // The multiplier to apply to the hint's `basis` (which already carries the node's spawn scale). For a "shuffle":
  // 1 through the whole arc, then `popScale/scale0` through the pop. For a "discard": the absolute arc shrink
  // (1 → 0.1 over the first third of the arc) and then the absolute pop ramp — never divided by `scale0`.
  scale: number;
}

export function createCardFlight(hint: MirrorCardFlightHint): CardFlightState {
  // A "discard" starts from the angle the card was resting at in the hand, so its first frame is a small step off
  // that pose rather than a snap onto the curve. A "shuffle" has no prior pose to preserve (its flier is spawned
  // for the sweep), so it takes the tangent outright and 0 is never observed.
  return { phase: "arc", time: 0, speed: hint.speed0, rotation: hint.kind === "discard" ? hint.rot0 : 0 };
}

// The quadratic bezier the arc walks: (1-t)^2*v0 + 2(1-t)t*c0 + t^2*v1. Deliberately NOT clamped in `t` — the
// integrator steps first and tests after, so it can sample a fraction past t=1, and the curve really does
// continue there.
export function flightBezier(
  v0: readonly number[],
  v1: readonly number[],
  c0: readonly number[],
  t: number,
  out: { x: number; y: number }
): void {
  const omt = 1 - t;
  const a = omt * omt;
  const b = 2 * omt * t;
  const c = t * t;
  out.x = a * v0[0] + b * c0[0] + c * v1[0];
  out.y = a * v0[1] + b * c0[1] + c * v1[1];
}

// The shuffle pop's scale at pop progress `progress`: a straight ramp down from 0.1, floored at 0 once it would
// go negative.
export function flightPopScale(progress: number): number {
  return Math.max(
    FLIGHT_POP_SCALE_FROM + (FLIGHT_POP_SCALE_TO - FLIGHT_POP_SCALE_FROM) * progress,
    0
  );
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The discard's ABSOLUTE arc scale at pseudo-time `time`: 1 → 0.1 over the first third, then held. */
export function discardArcScale(time: number, duration: number): number {
  const w = clamp01((time * DISCARD_RAMP_PSEUDOTIME_FACTOR) / duration);
  return DISCARD_ARC_SCALE_FROM + (DISCARD_ARC_SCALE_TO - DISCARD_ARC_SCALE_FROM) * w;
}

/** The discard's ABSOLUTE pop scale at pop progress `progress`: 0.1 → 0 by `DISCARD_POP_ZERO_PROGRESS`, then 0. */
export function discardPopScale(progress: number): number {
  return Math.max(
    DISCARD_POP_SCALE_FROM + (DISCARD_POP_SCALE_TO - DISCARD_POP_SCALE_FROM) * progress,
    0
  );
}

// The shortest signed arc from `from` to `to`, in (-PI, PI]. Godot's `angle_difference`, written out: without the
// wrap a card resting just past -PI and turning to just under +PI would take the LONG way round the circle, which
// on screen is a card spinning a full turn while it flies.
function shortestAngleDelta(from: number, to: number): number {
  const TAU = Math.PI * 2;
  const difference = (to - from) % TAU;
  return ((2 * difference) % TAU) - difference;
}

/**
 * One frame of the discard's angle chase: step `current` a `min(1, ratePerSec * dtSeconds)` fraction of the way
 * along the SHORTEST arc toward `target`. Exported because it is the whole of the "no first-frame snap" contract
 * and is asserted directly (a `dtSeconds` of 0 must return `current` unchanged, whatever the target is).
 */
export function smoothAngleStep(
  current: number,
  target: number,
  ratePerSec: number,
  dtSeconds: number
): number {
  const weight = Math.min(1, Math.max(0, ratePerSec * dtSeconds));
  return current + shortestAngleDelta(current, target) * weight;
}

const scratchHere = { x: 0, y: 0 };
const scratchAhead = { x: 0, y: 0 };
const scratchPose: CardFlightPose = { x: 0, y: 0, rotation: 0, scale: 1 };

// Position on the arc at pseudo-time `time` (written into `out`), and the angle the curve FACES there — the tangent
// taken over the fixed `FLIGHT_ROTATION_LOOK_AHEAD` step, plus a quarter turn. A degenerate (zero-length) look-ahead
// returns `fallback` rather than atan2(0,0): holding the previous angle is the visually stable read, and it is
// unreachable for a real flight (a fixed step along a non-degenerate quadratic).
function arcPositionAndFacing(
  hint: MirrorCardFlightHint,
  time: number,
  fallback: number,
  out: { x: number; y: number }
): number {
  flightBezier(hint.start, hint.end, hint.control, time / hint.duration, out);
  flightBezier(
    hint.start,
    hint.end,
    hint.control,
    (time + FLIGHT_ROTATION_LOOK_AHEAD) / hint.duration,
    scratchAhead
  );
  const dx = scratchAhead.x - out.x;
  const dy = scratchAhead.y - out.y;
  return dx !== 0 || dy !== 0 ? Math.atan2(dy, dx) + Math.PI / 2 : fallback;
}

// Step one flight by `dtSeconds` of WALL CLOCK and return its new pose. Phase 1 walks the curve with an
// accelerating pseudo-time and drives the angle; phase 2 keeps the speed frozen, parks the mover on the target
// anchor and drives only the scale. Once phase 2 completes the state goes "done" and every further call returns the
// same landed-and-vanished pose, so a caller that keeps polling (or re-polls after the renderer parked) can never
// produce a different frame.
//
// The `dt` the discard's chase is stepped by is the CLAMPED one, deliberately: a backgrounded tab's first frame
// back would otherwise close the whole angle gap in one step, which is the snap this kind exists to avoid — and
// the position is catching up over several frames for the same reason, so the two stay in step.
export function advanceCardFlight(
  state: CardFlightState,
  hint: MirrorCardFlightHint,
  dtSeconds: number
): CardFlightPose {
  const dt = Math.max(0, Math.min(dtSeconds, FLIGHT_MAX_STEP_SECONDS));

  const discard = hint.kind === "discard";

  if (state.phase === "arc") {
    state.time += state.speed * dt;
    state.speed += hint.accel * dt;
    const progress = state.time / hint.duration;
    if (progress <= 1) {
      const facing = arcPositionAndFacing(hint, state.time, state.rotation, scratchHere);
      // The one place the two kinds' motion differs on the arc: a shuffle takes the curve's facing outright (its
      // flier has no prior pose to preserve), a discard CHASES it out of the angle the card was resting at.
      state.rotation = discard
        ? smoothAngleStep(state.rotation, facing, FLIGHT_ROTATION_SMOOTH_RATE, dt)
        : facing;
      return {
        x: scratchHere.x,
        y: scratchHere.y,
        rotation: state.rotation,
        scale: discard ? discardArcScale(state.time, hint.duration) : 1
      };
    }
    // The arc always ends EXACTLY on the target anchor, never on the overshot curve sample, and the second phase's
    // clock restarts from there.
    state.phase = "pop";
    state.time = 0;
  }

  if (state.phase === "pop") {
    state.time += state.speed * dt;
    const progress = state.time / hint.duration;
    if (progress > 1) {
      state.phase = "done";
    } else {
      return {
        x: hint.end[0],
        y: hint.end[1],
        rotation: state.rotation,
        // ABSOLUTE for a discard (the shrink multiplies the card's own drawn size); the shuffle divides out the
        // spawn scale `basis` carries because its pop assigns an absolute size instead of scaling one.
        scale: discard ? discardPopScale(progress) : flightPopScale(progress) / hint.scale0
      };
    }
  }

  return { x: hint.end[0], y: hint.end[1], rotation: state.rotation, scale: 0 };
}

// ---- R11: the CLOSED FORM, for handing the animation to the browser -------------------------------------------
//
// `advanceCardFlight` above is a forward-Euler integrator stepped once per displayed frame: it is stateful, it is
// stepped, and it therefore needs a JS callback on every displayed frame. But both phases are integrable in closed
// form, which is what lets the renderer precompute the WHOLE flight once and hand it to the compositor as a WAAPI
// keyframe animation (see `?flightCssAnim`). Writing the solution out:
//
//   phase 1   dtime/dτ = speed(τ),  speed(τ) = s0 + a·τ      ⇒ time(τ) = s0·τ + a·τ²/2
//             the phase ends when time = duration            ⇒ τ1 = (√(s0² + 2aD) − s0)/a       (a = 0 ⇒ D/s0)
//             and the speed it hands to phase 2 is           ⇒ sEnd = s0 + a·τ1 = √(s0² + 2aD)
//   phase 2   dtime/dτ = sEnd (frozen)                       ⇒ the phase lasts D/sEnd seconds
//
// so the flight's WALL-CLOCK duration is exactly τ1 + D/sEnd — no stepping, no accumulation, no dependence on the
// client's frame rate. That also disposes of FLIGHT_MAX_STEP_SECONDS for this path: the clamp exists because a
// stepped integrator handed a multi-second dt would teleport the card, and a precomputed animation is driven by the
// document timeline instead of by dt, so a backgrounded tab simply resumes the animation wherever it now is. (The
// producer's suppression window still bounds it — see the renderer's pin.)
//
// The Euler integrator lags this solution by a·τ·Δt/2 in `time` units — i.e. by half a frame's worth of progress at
// any given instant, the same disagreement a 30Hz client already has with a 60Hz one today. The curve travelled and
// the landing point are identical; only the parameterisation differs, and it differs in the direction of being MORE
// correct. `?flightCssAnim=off` restores the stepped path exactly.
export interface CardFlightTiming {
  // τ1 — how long phase 1 (the arc) lasts, in seconds.
  arcSeconds: number;
  // D/sEnd — how long phase 2 (the pop) lasts, in seconds.
  popSeconds: number;
  // The whole animation, in seconds.
  totalSeconds: number;
  // The pseudo-time rate at the moment the arc ends — the frozen speed phase 2 carries.
  speedAtLanding: number;
}

export function cardFlightTiming(hint: MirrorCardFlightHint): CardFlightTiming {
  const s0 = hint.speed0;
  const a = hint.accel;
  const d = hint.duration;
  // a ≤ 0 can't come off the producer (its accel is always positive) but a zero would divide by zero
  // here, so degrade to the constant-speed solution rather than emitting NaN keyframes.
  const arcSeconds = a > 0 ? (Math.sqrt(s0 * s0 + 2 * a * d) - s0) / a : d / s0;
  const speedAtLanding = a > 0 ? Math.sqrt(s0 * s0 + 2 * a * d) : s0;
  const popSeconds = d / speedAtLanding;
  return { arcSeconds, popSeconds, totalSeconds: arcSeconds + popSeconds, speedAtLanding };
}

// The pose at WALL-CLOCK second `t` of the flight, computed directly rather than integrated. `prevRotation` is only
// consulted for the degenerate-tangent case the stepped integrator holds the previous angle for (unreachable for a
// real flight: the look-ahead is a fixed step along a non-degenerate quadratic), so a sampling loop should pass the
// last pose's rotation exactly as `advanceCardFlight` would have kept it.
//
// MEMORYLESS, AND WHY THAT IS STILL RIGHT FOR BOTH KINDS. Position and scale are functions of `t` alone for a
// shuffle AND for a discard, so this is exact for both. ROTATION is not: a discard's angle is a chase whose value
// depends on the whole sequence of frames before it, and only a sequential walk (`buildCardFlightPoses`, or the
// stepped integrator) can reproduce it — what this returns for a discard is the facing it is chasing, not the
// angle it has reached. That is fine for its two callers: the keyframe builder walks the arc sequentially and never
// takes rotation from here, and the TRAIL sampler consumes x/y only (the comet is a point trail — it has no
// orientation of its own to get wrong).
export function cardFlightPoseAt(
  hint: MirrorCardFlightHint,
  timing: CardFlightTiming,
  t: number,
  prevRotation: number
): CardFlightPose {
  if (t < timing.arcSeconds) {
    const time = hint.speed0 * t + (hint.accel * t * t) / 2;
    const rotation = arcPositionAndFacing(hint, time, prevRotation, scratchHere);
    return {
      x: scratchHere.x,
      y: scratchHere.y,
      rotation,
      scale: hint.kind === "discard" ? discardArcScale(time, hint.duration) : 1
    };
  }
  // Phase 2 parks the mover ON the target anchor and holds the angle the arc ended at, so the only thing still
  // moving is the scale — and `time` is now linear in τ, which makes both kinds' pop scale a piecewise LINEAR ramp
  // in wall clock. That is what lets the keyframe builder below cover a whole pop with five samples.
  const rotation = arcEndRotation(hint, prevRotation);
  const progress = ((t - timing.arcSeconds) * timing.speedAtLanding) / hint.duration;
  if (progress > 1) {
    return { x: hint.end[0], y: hint.end[1], rotation, scale: 0 };
  }
  return {
    x: hint.end[0],
    y: hint.end[1],
    rotation,
    scale: hint.kind === "discard" ? discardPopScale(progress) : flightPopScale(progress) / hint.scale0
  };
}

// The facing at the very end of the arc — the one phase 2 freezes.
function arcEndRotation(hint: MirrorCardFlightHint, fallback: number): number {
  return arcPositionAndFacing(hint, hint.duration, fallback, scratchHere);
}

// One precomputed animation sample: the streamed GLOBAL 6-tuple at `offset` (a 0..1 fraction of the flight's wall
// clock, i.e. a WAAPI keyframe offset).
export interface CardFlightKeyframePose {
  offset: number;
  g6: number[];
}

// How MANY arc keyframes: one per ~16ms of wall clock (one per 60Hz display frame), bounded to [24, 96]. The
// browser interpolates BETWEEN keyframes, so this is not "how smooth the animation is" — it is how closely the
// piecewise-linear interpolant tracks the true bezier.
//
// WHERE they are placed is the other half, and it is NOT uniform in wall clock. The card accelerates hard (it
// covers the last third of the arc at ~3× the speed of the first), so evenly-spaced sample TIMES put 60px between
// the late samples and 20px between the early ones — all the error at the end, where the eye is following the
// fastest thing on screen. Sampling uniformly in PSEUDO-TIME instead (i.e. uniformly along the curve
// parameter, with each keyframe carrying its own wall-clock `offset`) spreads the chords evenly and cuts the worst
// deviation from the true curve from ~0.30 to ~0.16-0.22 design px across the producer's whole parameter range —
// under a fifth of a device pixel at phone stage scale — for the same keyframe count. The acceleration is not
// lost: it is exactly what the non-uniform offsets encode.
const FLIGHT_ARC_SAMPLE_MS = 16;
const FLIGHT_ARC_SAMPLES_MIN = 24;
const FLIGHT_ARC_SAMPLES_MAX = 96;

// The POP needs five. `flightPopScale` is `max(lerp(0.1, -0.1, progress), 0)` and phase-2 progress is LINEAR in
// wall clock, so the scale is two straight segments joined at progress 0.5 — and a matrix keyframe pair that
// differs only in scale interpolates that scale linearly (CSS decomposes both matrices, interpolates the
// components and recomposes). Samples at 0/0.25/0.5/0.75/1 therefore reproduce the ramp EXACTLY, with 0.5 pinned so
// the kink lands on a keyframe rather than being cut across.
const FLIGHT_POP_OFFSETS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

// The discard's pop crosses zero at 0.4 instead of 0.5, so its five samples move with it: same rule (the kink gets
// its own keyframe, and there is one sample either side of it), different kink. Exported so the spec can assert the
// pin is on the constant rather than on a literal that drifted away from it.
export const DISCARD_POP_OFFSETS: readonly number[] = [0, 0.2, DISCARD_POP_ZERO_PROGRESS, 0.7, 1];

// A matrix with a zero 2×2 is singular, and CSS falls back to DISCRETE interpolation for a keyframe pair it cannot
// decompose. The card is 1e-4 of its size by then (sub-pixel on any display), so pinning the keyframed scale just
// off zero keeps every pair interpolable; the renderer writes the true `scale 0` transform inline when the
// animation finishes.
const FLIGHT_MIN_KEYFRAME_SCALE = 1e-4;

// Precompute the whole flight as WAAPI-ready samples. Pure: no DOM, no renderer state — the caller converts each
// `g6` through the same parent-relative placement its per-frame writes use.
//
// KIND-AWARE IN ONE PLACE ONLY: the rotation channel. A shuffle's angle is a function of where it is on the curve,
// so every sample can be taken independently (and `cardFlightPoseAt` does). A discard's angle is a CHASE, so this
// walks the arc samples in order and steps the chase by the WALL-CLOCK gap between consecutive samples — which is
// not the same as the pseudo-time gap, because the samples are spaced evenly along the curve and the mover
// accelerates along it (the early samples are further apart in seconds than the late ones). Using the pseudo-time
// gap here would turn the card fastest exactly where it is moving slowest.
export function buildCardFlightPoses(hint: MirrorCardFlightHint): {
  durationMs: number;
  poses: CardFlightKeyframePose[];
} {
  const timing = cardFlightTiming(hint);
  const total = timing.totalSeconds;
  const poses: CardFlightKeyframePose[] = [];
  if (!(total > 0) || !Number.isFinite(total)) {
    return { durationMs: 0, poses };
  }
  const discard = hint.kind === "discard";
  const arcSamples = Math.min(
    FLIGHT_ARC_SAMPLES_MAX,
    Math.max(FLIGHT_ARC_SAMPLES_MIN, Math.ceil((timing.arcSeconds * 1000) / FLIGHT_ARC_SAMPLE_MS))
  );
  let rotation = discard ? hint.rot0 : 0;
  let prevT = 0;
  for (let i = 0; i < arcSamples; i++) {
    // The wall-clock instant at which the `time` accumulator reaches `i/arcSamples` of `duration` — the inverse of
    // `time(τ) = s0·τ + a·τ²/2`.
    const time = (hint.duration * i) / arcSamples;
    const t =
      hint.accel > 0
        ? (Math.sqrt(hint.speed0 * hint.speed0 + 2 * hint.accel * time) - hint.speed0) / hint.accel
        : time / hint.speed0;
    if (discard) {
      const facing = arcPositionAndFacing(hint, time, rotation, scratchHere);
      // `t - prevT` is this sample's own wall-clock step; at i = 0 it is 0, which is what keeps the first keyframe
      // exactly on `rot0` (no snap) however far the curve's facing already is from it.
      rotation = smoothAngleStep(rotation, facing, FLIGHT_ROTATION_SMOOTH_RATE, t - prevT);
      scratchPose.x = scratchHere.x;
      scratchPose.y = scratchHere.y;
      scratchPose.rotation = rotation;
      const scale = Math.max(discardArcScale(time, hint.duration), FLIGHT_MIN_KEYFRAME_SCALE);
      poses.push({ offset: t / total, g6: cardFlightGlobal6(hint.basis, scratchPose, scale) });
    } else {
      const pose = cardFlightPoseAt(hint, timing, t, rotation);
      rotation = pose.rotation;
      poses.push({ offset: t / total, g6: cardFlightGlobal6(hint.basis, pose, pose.scale) });
    }
    prevT = t;
  }
  // The arc's LAST sample is the landing pose written out explicitly — the end position is assigned outright rather
  // than taken from the (overshot) curve sample. A shuffle is still at full size when it gets there; a discard has
  // finished its shrink long before and arrives at the pop's own opening scale, so its two are continuous.
  const arcOffset = timing.arcSeconds / total;
  if (discard) {
    rotation = smoothAngleStep(
      rotation,
      arcEndRotation(hint, rotation),
      FLIGHT_ROTATION_SMOOTH_RATE,
      timing.arcSeconds - prevT
    );
  } else {
    rotation = arcEndRotation(hint, rotation);
  }
  const landedScale = discard
    ? Math.max(discardArcScale(hint.duration, hint.duration), FLIGHT_MIN_KEYFRAME_SCALE)
    : 1;
  scratchPose.x = hint.end[0];
  scratchPose.y = hint.end[1];
  scratchPose.rotation = rotation;
  poses.push({ offset: arcOffset, g6: cardFlightGlobal6(hint.basis, scratchPose, landedScale) });
  // Phase 2 opens at the SAME offset, which for a shuffle is a deliberate duplicate-offset keyframe PAIR: its scale
  // assignment is an instantaneous snap from the authored size to a tenth, not a ramp into it, and a zero-length
  // keyframe interval is how WAAPI expresses a step. The discard's pair is the same shape but a no-op — its arc
  // already ended at the pop's opening scale.
  //
  // `f` IS the pop's progress: phase-2 `time` is linear in wall clock (the speed is frozen), and popSeconds is
  // exactly `duration / speedAtLanding`, so a fraction of the phase is the same fraction of its progress.
  for (const f of discard ? DISCARD_POP_OFFSETS : FLIGHT_POP_OFFSETS) {
    const t = timing.arcSeconds + timing.popSeconds * f;
    const offset = Math.min(1, t / total);
    if (discard) {
      // Position parked on the anchor and the angle HELD at the arc's last — the same freeze the shuffle's phase 2
      // has, so the only channel these five samples carry is the scale ramp through its 0.4 kink.
      scratchPose.rotation = rotation;
      poses.push({
        offset,
        g6: cardFlightGlobal6(
          hint.basis,
          scratchPose,
          Math.max(discardPopScale(f), FLIGHT_MIN_KEYFRAME_SCALE)
        )
      });
      continue;
    }
    const pose = cardFlightPoseAt(hint, timing, Math.min(t, total), rotation);
    poses.push({
      offset,
      g6: cardFlightGlobal6(hint.basis, pose, Math.max(pose.scale, FLIGHT_MIN_KEYFRAME_SCALE)),
    });
  }
  return { durationMs: total * 1000, poses };
}

// Compose the streamed GLOBAL 6-tuple `[a,b,c,d,tx,ty]` a pose renders with: `basis · R(rotation) · scale`, then
// the pose's position as the origin. `basis` already carries the parent chain's basis and the node's spawn scale
// with the node's OWN rotation divided out (see MirrorCardFlightHint), so this is the whole composition.
//
// Godot's Transform2D is column-major with `X = (cos, sin)` and `Y = (-sin, cos)` for a rotation, and the
// renderer's 6-tuple is `[X.x, X.y, Y.x, Y.y, O.x, O.y]` — the same order CSS `matrix()` takes.
export function cardFlightGlobal6(
  basis: readonly number[],
  pose: CardFlightPose,
  scale: number
): number[] {
  return cardFlightGlobal6Into([0, 0, 0, 0, 0, 0], basis, pose, scale);
}

// The same composition written into a caller-owned tuple. The R11 trail sampler runs this once per stroke-owning
// flight per frame purely to derive a head position, and a fresh array there is 1,800 short-lived allocations a
// second during a 30-card reshuffle — exactly the garbage nodeStyles' placement scratch exists to avoid. The tuple
// is consumed (read into a string / a spread lookup) before the next call, so one is enough.
export function cardFlightGlobal6Into(
  out: number[],
  basis: readonly number[],
  pose: CardFlightPose,
  scale: number
): number[] {
  const cos = Math.cos(pose.rotation);
  const sin = Math.sin(pose.rotation);
  const a = basis[0];
  const b = basis[1];
  const c = basis[2];
  const d = basis[3];
  out[0] = (a * cos + c * sin) * scale;
  out[1] = (b * cos + d * sin) * scale;
  out[2] = (-a * sin + c * cos) * scale;
  out[3] = (-b * sin + d * cos) * scale;
  out[4] = pose.x;
  out[5] = pose.y;
  return out;
}
