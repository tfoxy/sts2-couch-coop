// COSMETIC-OFFSET RAMPS — the time dimension the canvas raise did not have.
//
// WHAT THE DEFECT WAS. The DOM backend expresses the readable-hand raise as a CSS `translate` on the holder's own
// element, and `.mirror-hand-raisable` carries `transition: translate 160ms ease-out` — so pressing "raise" glides
// the hand up. The canvas expresses the same raise as a COSMETIC OFFSET, which the walk simply adds: a step
// function with no time in it at all, so the same button teleports every card. This module is the missing time.
//
// WHY NOT THE TWEEN LOOP. `tweenLoop` already interpolates, and an "offset" channel there would have been fewer
// lines — but the loop's channels are the ones the PRODUCER owns (a hint arrives, a channel is armed, a settle
// collects it), and its two-writer guard exists to keep exactly one of those in charge of a node's transform. The
// cosmetic offset is a deliberately DIFFERENT writer: it is this client's own decoration, it composes on top of
// whatever the loop is doing, and it must survive a keyframe wipe that clears every tween. Blurring the two would
// cost the guard its meaning. So the ramp lives beside the offsets it ramps.
//
// WHAT IT IS. A per-node scalar pair (the offset's own `dx`/`dy`) easing from where it was to where it is going, on
// Godot's own easing equations via `godotEaseSample` — the same evaluator the tween replay uses, so a raise that
// rides a tween's timing rides the LITERAL curve that tween is drawing. The declared timing is the caller's: this
// module holds no policy, no clock and no default duration.
//
// THREE RULES worth stating, because each is a decision:
//
//   * A NULL TIMING IS A TELEPORT, and it is the DEFAULT everywhere. `declare` with no timing drops any ramp for
//     the node and answers the target verbatim — which is byte-for-byte what writing the offset did before this
//     module existed. Every caller that has not opted in is therefore unchanged by construction.
//   * RE-TARGETING CONTINUES FROM THE CURRENT SAMPLE, never from the new `from` the caller offers: a hand that is
//     half-way up when the target moves keeps going from half-way up. A restart from the caller's value would be a
//     visible hitch on every mid-ramp change of mind, and mid-ramp changes of mind are the normal case (the focus
//     ramp re-evaluates every frame of a hand tween).
//   * DECLARING THE SAME TARGET TWICE DOES NOT RESTART. The caller re-decides the whole raise on every reconcile
//     and every finger move, so without this guard a 160 ms ramp would be re-armed at 60 Hz and never arrive. It is
//     the direct twin of the DOM's compare-before-write on the `transition` property, which exists for the same
//     reason (an inline `transition` write lands mid-ease and snaps the element to the end value).
//
// PURE in this codebase's sense: no DOM, no `window`, no module-level mutable state, and the clock arrives as an
// argument. One instance drives one stage.

import { godotEaseSample } from "@godot-scene-web/effects/easing";

/** Where a ramp is right now — a caller-owned pair, so sampling allocates nothing. */
export interface OffsetRampSample {
  dx: number;
  dy: number;
}

/**
 * How a declared move should be drawn. `ease`/`trans` are the raw Godot enum names `godotEaseSample` takes; a
 * `durationMs` of 0 or less is a teleport, so a caller need not special-case a degenerate timing it read off a
 * tween.
 */
export interface OffsetRampTiming {
  durationMs: number;
  ease?: string | null;
  trans?: string | null;
}

/**
 * THE RAISE-ALL TIMING — the canvas twin of `.mirror-hand-raisable`'s `transition: translate 160ms ease-out`.
 *
 * CSS `ease-out` is `cubic-bezier(0, 0, 0.58, 1)`; Godot's `Out`/`Sine` is `sin(t·π/2)`. They are not the same
 * curve, but over [0,1] they differ by at most 0.024 — which on the raise's own 119 px lift is a 2.9 px peak
 * discrepancy lasting about two frames of a 160 ms glide, i.e. invisible. Reproducing the bezier would mean a
 * Newton solver in a module whose whole job is one lerp; using the evaluator the rest of this backend already
 * calls keeps the mirror on ONE easing implementation, which is worth more than 2.9 px.
 */
export const RAISE_LIFT_RAMP: OffsetRampTiming = Object.freeze({ durationMs: 160, ease: "Out", trans: "Sine" });

interface Ramp {
  fromDx: number;
  fromDy: number;
  toDx: number;
  toDy: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  ease: string | undefined;
  trans: string | undefined;
}

/** The retained half — one per stage. See the header for why this is not a `tweenLoop` channel. */
export interface OffsetRamps {
  /**
   * Point `id` at (`toDx`, `toDy`), and answer what to WRITE RIGHT NOW in `out`.
   *
   * `fromDx`/`fromDy` are the caller's current value, used only when no ramp is already running for the node (see
   * the header's re-target rule). Returns whether a ramp is live for `id` afterwards, which is the caller's cue to
   * keep the frame loop awake.
   */
  declare(
    id: string,
    fromDx: number,
    fromDy: number,
    toDx: number,
    toDy: number,
    timing: OffsetRampTiming | null,
    atMs: number,
    out: OffsetRampSample
  ): boolean;
  /** Sample every live ramp at `atMs`, hand each to `visit`, and retire the ones that have arrived. */
  advance(atMs: number, visit: (id: string, dx: number, dy: number) => void): void;
  /** One node's current value, or false when nothing is ramping it (and `out` is left alone). */
  sampleInto(id: string, atMs: number, out: OffsetRampSample): boolean;
  /**
   * The EARLIEST live ramp's end, or `Infinity` when none is running.
   *
   * It is an END, not a next-step time — a ramp wants EVERY frame until it arrives. A caller that slept on this
   * would deliver the whole glide in one jump at the end, which is worse than the teleport this module replaces.
   */
  nextDeadline(): number;
  /** How many ramps are live. */
  active(): number;
  /** Drop `id`'s ramp (a node left the scene, or its offset was deleted outright). */
  forget(id: string): void;
  /** Drop every ramp — a keyframe, a re-attach, the mode being switched off. */
  clear(): void;
}

export function createOffsetRamps(): OffsetRamps {
  const ramps = new Map<string, Ramp>();

  function progress(ramp: Ramp, atMs: number): number {
    const raw = ramp.durationMs > 0 ? (atMs - ramp.startMs) / ramp.durationMs : 1;
    return godotEaseSample(ramp.ease, ramp.trans, raw);
  }

  function sample(ramp: Ramp, atMs: number, out: OffsetRampSample): void {
    const t = progress(ramp, atMs);
    out.dx = ramp.fromDx + (ramp.toDx - ramp.fromDx) * t;
    out.dy = ramp.fromDy + (ramp.toDy - ramp.fromDy) * t;
  }

  return {
    declare(id, fromDx, fromDy, toDx, toDy, timing, atMs, out) {
      const running = ramps.get(id) ?? null;
      // A TELEPORT — and the default. Any ramp in flight is abandoned at the target rather than eased to it: the
      // caller asked for no time, and finishing the old curve would be a motion nobody declared.
      if (timing === null || !(timing.durationMs > 0)) {
        if (running !== null) {
          ramps.delete(id);
        }
        out.dx = toDx;
        out.dy = toDy;
        return false;
      }
      // ALREADY HEADED THERE — keep the curve in flight (see the header's third rule).
      if (running !== null && running.toDx === toDx && running.toDy === toDy) {
        sample(running, atMs, out);
        return true;
      }
      if (running !== null) {
        // Re-target: continue from where the node IS, not from the caller's idea of where it was.
        sample(running, atMs, out);
        fromDx = out.dx;
        fromDy = out.dy;
      }
      // Nothing to draw: a move of zero length is its own arrival, and arming it would keep a frame loop awake for
      // a curve between two identical numbers.
      if (fromDx === toDx && fromDy === toDy) {
        ramps.delete(id);
        out.dx = toDx;
        out.dy = toDy;
        return false;
      }
      ramps.set(id, {
        fromDx,
        fromDy,
        toDx,
        toDy,
        startMs: atMs,
        endMs: atMs + timing.durationMs,
        durationMs: timing.durationMs,
        ease: timing.ease ?? undefined,
        trans: timing.trans ?? undefined
      });
      out.dx = fromDx;
      out.dy = fromDy;
      return true;
    },

    advance(atMs, visit) {
      if (ramps.size === 0) {
        return;
      }
      const out: OffsetRampSample = { dx: 0, dy: 0 };
      for (const [id, ramp] of ramps) {
        sample(ramp, atMs, out);
        visit(id, out.dx, out.dy);
        // `godotEaseSample` returns exactly 1 at t >= 1, so the last frame a ramp is visited it is AT its target —
        // the caller has already been handed the final value when this retires it.
        if (atMs >= ramp.endMs) {
          ramps.delete(id);
        }
      }
    },

    sampleInto(id, atMs, out) {
      const ramp = ramps.get(id);
      if (ramp === undefined) {
        return false;
      }
      sample(ramp, atMs, out);
      return true;
    },

    nextDeadline() {
      let soonest = Infinity;
      for (const ramp of ramps.values()) {
        if (ramp.endMs < soonest) {
          soonest = ramp.endMs;
        }
      }
      return soonest;
    },

    active() {
      return ramps.size;
    },

    forget(id) {
      ramps.delete(id);
    },

    clear() {
      ramps.clear();
    }
  };
}
