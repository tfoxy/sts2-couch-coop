import { describe, expect, it } from "vitest";

import {
  cardFlightGlobal6,
  cardFlightPoseAt,
  cardFlightTiming,
  smoothAngleStep,
  FLIGHT_ROTATION_SMOOTH_RATE
} from "@/mirror/cardFlight";
import {
  bobPhaseMs,
  createTweenLoop,
  pinnedLoopSpecFor,
  ALPHA_OPACITY,
  ALPHA_SELF_OPACITY,
  HIDE_LATCH_GRACE_MS,
  HIDE_LATCH_HELD_RESTORE_MS,
  SAMPLE_NONE,
  SAMPLE_OPACITY,
  SAMPLE_SELF_OPACITY,
  SAMPLE_TRANSFORM,
  type TweenLoop,
  type TweenLoopHint,
  type TweenLoopOptions
} from "@/mirror/canvas/tweenLoop";
import { MAP_POINT_PULSE_TOKEN, END_TURN_GLOW_TOKEN } from "@/mirror/animAttributes";
import type { MirrorCardFlightHint } from "@/mirror/sceneTree";

// THE CANVAS MIRROR'S ANIMATION EVALUATOR.
//
// Every observable behaviour asserted here is ported from the DOM path's own specs — mirrorTween.spec.ts (arm /
// pin / expiry / re-target / pin catch-up), mirrorHideLatch.spec.ts (the whole cancel matrix + the held-restore
// self-heal) and cardFlight.spec.ts (the closed form and the discard's rotation chase) — restated against an
// evaluator that computes the value instead of handing a `transition` string to the browser. Where the two must
// differ, the difference is named in the test.
//
// The clock is INJECTED everywhere, so there is no fake-timer / rAF harness at all: a "frame" here is just a
// number handed to `sampleInto` and `advance`.

// ---- harness ----------------------------------------------------------------------------------------------------

const t6: number[] = [0, 0, 0, 0, 0, 0];
const alphas: number[] = [1, 1];

interface Sampled {
  mask: number;
  transform: number[];
  opacity: number;
  selfOpacity: number;
}

function sample(loop: TweenLoop, id: string, now: number): Sampled {
  const mask = loop.sampleInto(id, t6, alphas, now);
  return { mask, transform: t6.slice(), opacity: alphas[ALPHA_OPACITY], selfOpacity: alphas[ALPHA_SELF_OPACITY] };
}

/** The x-translation of a sampled transform — the one number most of the ported hand-layout cases turn on. */
function tx(s: Sampled): number {
  return s.transform[4];
}
function ty(s: Sampled): number {
  return s.transform[5];
}

function translate(x: number, y = 0): number[] {
  return [1, 0, 0, 1, x, y];
}

function transformHint(nodeId: string, end: number[], durationMs = 200, over: Partial<TweenLoopHint> = {}): TweenLoopHint {
  return {
    nodeId,
    channel: "transform",
    durationMs,
    ease: "Out",
    trans: "Cubic",
    endTransform: end,
    startTransform: null,
    endOpacity: null,
    startOpacity: null,
    restingAlpha: null,
    group: null,
    ...over
  };
}

function opacityHint(nodeId: string, end: number, durationMs = 200, over: Partial<TweenLoopHint> = {}): TweenLoopHint {
  return {
    nodeId,
    channel: "opacity",
    durationMs,
    ease: "Out",
    trans: "Cubic",
    endTransform: null,
    startTransform: null,
    endOpacity: end,
    startOpacity: null,
    restingAlpha: null,
    group: null,
    ...over
  };
}

function selfOpacityHint(nodeId: string, end: number, durationMs = 200, over: Partial<TweenLoopHint> = {}): TweenLoopHint {
  return { ...opacityHint(nodeId, end, durationMs, over), channel: "selfOpacity" };
}

/** A LINEAR hint, for the cases that assert an exact mid-tween value rather than a curve. */
function linear<T extends TweenLoopHint>(hint: T): T {
  return { ...hint, ease: "In", trans: "Linear" };
}

/** A loop plus a mutable "what is this node's current pose/alpha" table for the arm-time resolvers. */
function harness(options: TweenLoopOptions = {}): {
  loop: TweenLoop;
  poses: Map<string, number[]>;
  alphaOf: Map<string, number>;
} {
  const poses = new Map<string, number[]>();
  const alphaOf = new Map<string, number>();
  const loop = createTweenLoop({
    currentTransform: (id, out) => {
      const pose = poses.get(id);
      if (!pose) {
        return false;
      }
      for (let i = 0; i < 6; i++) {
        out[i] = pose[i];
      }
      return true;
    },
    currentOpacity: (id) => alphaOf.get(id) ?? null,
    ...options
  });
  return { loop, poses, alphaOf };
}

// ---- arming, expiry, channel independence -------------------------------------------------------------------------

describe("canvas tween loop: arming and expiry", () => {
  it("arms ONLY the hinted node — a descendant is never fanned (mirrorTween: 'the TARGET only')", () => {
    const { loop, poses } = harness();
    poses.set("p", translate(100, 100));
    poses.set("c", translate(110, 120));
    loop.applyHints([transformHint("p", translate(300, 100))], 0);
    expect(loop.activeCount()).toBe(1);
    expect([...loop.activeIds()]).toEqual(["p"]);
    expect(sample(loop, "c", 0).mask).toBe(SAMPLE_NONE);
  });

  it("carries the wire `group` through, so a caller can still see which channels belong to one Godot tween", () => {
    const { loop, poses } = harness();
    poses.set("ret", translate(300, 80));
    loop.applyHints(
      [transformHint("ret", translate(272, 80), 250, { group: "g1" }), opacityHint("ret", 1, 50, { group: "g1" })],
      0
    );
    expect(loop.channelGroup("ret", "transform")).toBe("g1");
    expect(loop.channelGroup("ret", "opacity")).toBe("g1");
    expect(loop.channelGroup("ret", "selfOpacity")).toBeNull();
    expect(loop.channelGroup("nobody", "transform")).toBeNull();
  });

  it("sweeps from the live pose to the endpoint and releases the channel at its deadline", () => {
    const { loop, poses } = harness();
    poses.set("p", translate(100, 100));
    loop.applyHints([linear(transformHint("p", translate(300, 100), 200))], 0);

    expect(tx(sample(loop, "p", 0))).toBeCloseTo(100, 9);
    expect(tx(sample(loop, "p", 100))).toBeCloseTo(200, 9);
    expect(tx(sample(loop, "p", 200))).toBeCloseTo(300, 9);

    // Past the deadline the loop owns nothing: the caller paints its own streamed value, instantly and unsmeared.
    // (This is what "clears the transition at epoch end so a later reposition is instant" means with no DOM.)
    expect(loop.advance(210)).toBe(Infinity);
    expect(sample(loop, "p", 210).mask).toBe(SAMPLE_NONE);
    expect(loop.activeCount()).toBe(0);
  });

  it("drives a parallel move + fade on one node, and expires each channel independently", () => {
    const { loop, poses, alphaOf } = harness();
    poses.set("p", translate(100, 100));
    alphaOf.set("p", 1);
    loop.applyHints(
      [linear(transformHint("p", translate(300, 100), 200)), linear(opacityHint("p", 0.3, 400))],
      0
    );

    const both = sample(loop, "p", 100);
    expect(both.mask & SAMPLE_TRANSFORM).toBeTruthy();
    expect(both.mask & SAMPLE_OPACITY).toBeTruthy();
    expect(tx(both)).toBeCloseTo(200, 9);
    expect(both.opacity).toBeCloseTo(1 - 0.7 * 0.25, 9);

    // Past the move's epoch but not the fade's: the transform channel publishes its FINAL value once and drops,
    // while the fade keeps running.
    const settle = sample(loop, "p", 210);
    expect(settle.mask & SAMPLE_TRANSFORM).toBeTruthy();
    expect(tx(settle)).toBeCloseTo(300, 9);
    expect(loop.advance(210)).toBe(400);
    expect(sample(loop, "p", 300).mask).toBe(SAMPLE_OPACITY);

    // ...and then the fade does the same.
    expect(sample(loop, "p", 410).opacity).toBeCloseTo(0.3, 9);
    expect(loop.advance(410)).toBe(Infinity);
    expect(sample(loop, "p", 410).mask).toBe(SAMPLE_NONE);
  });

  it("keeps `selfOpacity` a channel of its own (an interior node's OWN paint, never the cascade)", () => {
    const { loop } = harness();
    loop.applyHints([linear(selfOpacityHint("p", 0.2, 200, { startOpacity: 1 }))], 0);
    const s = sample(loop, "p", 100);
    expect(s.mask).toBe(SAMPLE_SELF_OPACITY);
    expect(s.selfOpacity).toBeCloseTo(0.6, 9);
    // The ELEMENT alpha is untouched — that is the whole point of the split.
    expect(s.mask & SAMPLE_OPACITY).toBe(0);
  });

  it("arms nothing for a node with no hint, and drops a non-positive duration", () => {
    const { loop } = harness();
    expect(loop.activeCount()).toBe(0);
    loop.applyHints([transformHint("h", translate(90, 40), 0)], 0);
    expect(loop.activeCount()).toBe(0);
    expect(loop.nextDeadline(0)).toBe(Infinity);
  });

  it("uses Godot's own easing equations, not a cubic-bezier fit", () => {
    const { loop, poses } = harness();
    poses.set("p", translate(0));
    // Cubic/Out at the halfway point is (t−1)³ + 1 = 0.875 exactly — the number the game's own
    // `easing_equations.h` produces, which is why the evaluator samples rather than approximates.
    loop.applyHints([transformHint("p", translate(1000), 200)], 0);
    expect(tx(sample(loop, "p", 100))).toBeCloseTo(875, 9);
  });
});

// ---- the pin ------------------------------------------------------------------------------------------------------

describe("canvas tween loop: the pin", () => {
  it("ignores streamed intermediate poses while it owns the channel, and yields at the settle", () => {
    const { loop, poses } = harness();
    poses.set("p", translate(100, 100));
    loop.applyHints([linear(transformHint("p", translate(300, 100), 200))], 10);

    // The game's own tween at ~60% arrives mid-window. It must not fight the replay.
    loop.noteStreamedValue("p", "transform", translate(220, 100), 130);
    expect(tx(sample(loop, "p", 130))).toBeCloseTo(100 + 200 * 0.6, 9);

    // Once the channel expires the node is streamed again — which is what lets the producer's settle re-emit (and
    // its cancel-on-abandon path) re-sync a node the game moved elsewhere.
    loop.advance(215);
    expect(sample(loop, "p", 215).mask & SAMPLE_TRANSFORM).toBeTruthy(); // the catch-up, delivered once
    loop.advance(216);
    expect(loop.activeCount()).toBe(0);
  });

  it("A HINT IS ONE-WAY: the producer resuming its stream does not shorten the client's deadline", () => {
    const { loop, poses } = harness();
    poses.set("h", translate(-200));
    loop.applyHints([transformHint("h", translate(-40), 884)], 0);
    // `CancelTweenSuppression` un-pins the PRODUCER; there is no wire field that aborts the CLIENT.
    loop.noteStreamedValue("h", "transform", translate(-150), 200);
    expect(loop.nextDeadline(200)).toBe(884);
    expect(sample(loop, "h", 200).mask & SAMPLE_TRANSFORM).toBeTruthy();
  });
});

// ---- prime/arm collapse and `from` resolution ------------------------------------------------------------------------

describe("canvas tween loop: where a tween starts", () => {
  it("PRIME AND ARM COLLAPSE: a declared start IS the channel's `from`, effective at nowMs", () => {
    // DOM deviation, and the reason for it: the DOM path must write the start, let the browser COMMIT it (that
    // commit is the transition's implicit "from") and only then write the endpoint — so it defers the arm a whole
    // frame and holds the channel meanwhile. A computed animation has no implicit "from" to publish.
    const { loop, poses } = harness();
    poses.set("btn", translate(1983, 764)); // the coalescer already folded the node to its NEAR-FINAL value
    loop.applyHints(
      [linear(transformHint("btn", translate(1983, 764), 800, { startTransform: translate(1583, 764) }))],
      0
    );
    expect(tx(sample(loop, "btn", 0))).toBeCloseTo(1583, 9); // the real start, not the folded 1983
    expect(tx(sample(loop, "btn", 400))).toBeCloseTo(1783, 9);
    expect(tx(sample(loop, "btn", 800))).toBeCloseTo(1983, 9);
  });

  it("a START-LESS hint against an already-folded value collapses to no motion (backward-compatible)", () => {
    const { loop, poses } = harness();
    poses.set("btn", translate(1983, 764));
    loop.applyHints([transformHint("btn", translate(1983, 764), 800)], 0);
    expect(tx(sample(loop, "btn", 0))).toBeCloseTo(1983, 9);
    expect(tx(sample(loop, "btn", 400))).toBeCloseTo(1983, 9);
  });

  it("primes an opacity fade from its declared start, then reaches the end alpha", () => {
    const { loop, alphaOf } = harness();
    alphaOf.set("ret", 1);
    loop.applyHints([linear(opacityHint("ret", 1, 50, { startOpacity: 0 }))], 0);
    expect(sample(loop, "ret", 0).opacity).toBeCloseTo(0, 9);
    expect(sample(loop, "ret", 50).opacity).toBeCloseTo(1, 9);
  });

  it("drives BOTH channels of one target from their own declared starts (the prime-clobber regression)", () => {
    // The DOM bug this guards: priming the opacity channel after the transform channel was already armed snapped
    // the transform to its end, losing the slide and keeping only the fade. Independent channels cannot clobber.
    const { loop, poses, alphaOf } = harness();
    poses.set("ret", translate(300, 80));
    alphaOf.set("ret", 1);
    loop.applyHints(
      [
        linear(transformHint("ret", translate(272, 80), 250, { startTransform: translate(300, 80) })),
        linear(opacityHint("ret", 1, 50, { startOpacity: 0 }))
      ],
      0
    );
    const start = sample(loop, "ret", 0);
    expect(tx(start)).toBeCloseTo(300, 9);
    expect(start.opacity).toBeCloseTo(0, 9);
    const mid = sample(loop, "ret", 125);
    expect(tx(mid)).toBeCloseTo(286, 9); // still sliding
    expect(mid.opacity).toBeCloseTo(1, 9); // the shorter fade already finished
    expect(tx(sample(loop, "ret", 250))).toBeCloseTo(272, 9);
  });

  it("RE-TARGETS mid-flight without teleporting: the new `from` is the live sample", () => {
    // The hand's layout motion re-targets as its NORMAL case — every drawn card re-lays out the whole hand — so a
    // re-arm must ease on from wherever the running channel had reached.
    const { loop, poses } = harness();
    poses.set("h", translate(-200));
    loop.applyHints([linear(transformHint("h", translate(-40), 884))], 0);
    const before = tx(sample(loop, "h", 300));
    expect(before).toBeCloseTo(-200 + 160 * (300 / 884), 9);

    loop.applyHints([linear(transformHint("h", translate(60), 620))], 300);
    expect(tx(sample(loop, "h", 300))).toBeCloseTo(before, 9); // continuous across the re-arm: no jump back
    expect(loop.nextDeadline(300)).toBe(920); // the NEW window, not the old one
    expect(tx(sample(loop, "h", 920))).toBeCloseTo(60, 9);
  });
});

// ---- pin catch-up ----------------------------------------------------------------------------------------------

describe("canvas tween loop: pin catch-up", () => {
  it("DEFECT 2: the settle lands on the GAME's pose, not the stale endpoint", () => {
    const { loop, poses } = harness();
    poses.set("h", translate(-200));
    loop.applyHints([transformHint("h", translate(-40), 884)], 0);

    // The producer decided the remaining travel was under its floor, cancelled the window and resumed streaming.
    // -150 is authoritative and NO further hint is coming; the pin still (rightly) refuses to fight the replay.
    loop.noteStreamedValue("h", "transform", translate(-150), 200);
    expect(tx(sample(loop, "h", 200))).not.toBeCloseTo(-150, 3);

    // ...but the settle must not DROP it. Before the fix the slot stayed at −40 for good.
    loop.advance(900);
    const settled = sample(loop, "h", 900);
    expect(settled.mask & SAMPLE_TRANSFORM).toBeTruthy();
    expect(tx(settled)).toBe(-150);
    // Handed over exactly once, and then the node goes inert.
    loop.advance(901);
    expect(loop.activeCount()).toBe(0);
  });

  it("DEFECT 1: a refocus streamed mid-unfocus wins the settle (the card ends FOCUSED)", () => {
    const { loop, poses } = harness();
    poses.set("h", translate(-200, -60));
    loop.applyHints([transformHint("h", translate(-140, 0), 400)], 0);
    // 120ms in the player re-focuses: the game writes the lift INSTANTLY, so the producer's batch has ~no travel
    // left, falls under its floor, publishes no hint and merely streams the live post-snap pose.
    loop.noteStreamedValue("h", "transform", translate(-188, -60), 120);
    loop.advance(410);
    const settled = sample(loop, "h", 410);
    expect([tx(settled), ty(settled)]).toEqual([-188, -60]);
  });

  it("does NOT replay a merely-SUPPRESSED node's retained pose (no teleport back to the start)", () => {
    const { loop, poses } = harness();
    poses.set("h", translate(-200));
    loop.applyHints([transformHint("h", translate(-40), 884)], 0);
    // A suppressed holder ships upserts with NO transform at all, so nothing is ever noted — there is nothing to
    // catch up on and the settle must keep the ENDPOINT (not the retained pre-tween −200).
    loop.advance(900);
    expect(tx(sample(loop, "h", 900))).toBeCloseTo(-40, 9);
  });

  it("does NOT replay an UNCHANGED streamed pose (a byte-identical re-derivation is not a fresh pose)", () => {
    const { loop, poses } = harness();
    poses.set("h", translate(-200));
    loop.applyHints([transformHint("h", translate(-40), 884)], 0);
    loop.noteStreamedValue("h", "transform", translate(-200), 300); // the retained pre-tween matrix, re-shipped
    loop.noteStreamedValue("h", "transform", translate(-200), 600);
    loop.advance(900);
    expect(tx(sample(loop, "h", 900))).toBeCloseTo(-40, 9);
  });

  it("a mid-flight RE-ARM clears the pending catch-up (the new endpoint already accounts for it)", () => {
    const { loop, poses } = harness();
    poses.set("h", translate(-200));
    loop.applyHints([transformHint("h", translate(-40), 884)], 0);
    loop.noteStreamedValue("h", "transform", translate(-150), 200);
    // Another card is drawn: the producer recomputes the endpoint from the holder's LIVE pose, so the new hint
    // already describes the travel that remains from −150. Replaying the stash would undo it.
    loop.applyHints([transformHint("h", translate(60), 620)], 210);
    loop.advance(900);
    expect(tx(sample(loop, "h", 900))).toBeCloseTo(60, 9);
    loop.advance(901);
    expect(loop.activeCount()).toBe(0);
  });

  it("a catch-up EQUAL to the endpoint hands nothing back (the producer's ordinary settle re-emit)", () => {
    const { loop, poses } = harness();
    poses.set("h", translate(-200));
    loop.applyHints([transformHint("h", translate(-40), 884)], 0);
    loop.noteStreamedValue("h", "transform", translate(-40), 800); // the game landed exactly where the hint said
    loop.advance(900);
    // The settle still publishes its final value, but that value IS the endpoint: nothing moved.
    expect(tx(sample(loop, "h", 900))).toBeCloseTo(-40, 9);
  });

});

// ---- the hide-latch --------------------------------------------------------------------------------------------

describe("canvas tween loop: hide-latch", () => {
  /** Fade `p` out from `resting` and settle it, leaving the latch armed. Returns the loop at t = 210. */
  function fadeThenSettle(resting = 1, options: TweenLoopOptions = {}): TweenLoop {
    const { loop, alphaOf } = harness(options);
    alphaOf.set("p", resting);
    loop.applyHints([opacityHint("p", 0, 200, { restingAlpha: resting })], 0);
    expect(sample(loop, "p", 200).opacity).toBeCloseTo(0, 9);
    loop.advance(210); // past the 200ms fade → settle → latch armed
    return loop;
  }

  it("ON: holds 0 through the producer's resting-alpha restore", () => {
    const loop = fadeThenSettle(1);
    // The pre-hide drain: modulate.a restored to 1, still visible. Without the latch this paints 1 for a frame.
    expect(loop.noteStreamedValue("p", "opacity", 1, 220)).toBe(0);
    expect(sample(loop, "p", 220).opacity).toBe(0);
    // ...and the node then actually hides, which the caller reports as a removal.
    loop.releaseNode("p");
    expect(loop.activeCount()).toBe(0);
  });

  it("holds 0 for a resting alpha that ISN'T 1 (e.g. a 0.75 card)", () => {
    const loop = fadeThenSettle(0.75);
    expect(loop.noteStreamedValue("p", "opacity", 0.75, 220)).toBe(0);
  });

  it("cancel — incoming ≠ resting signature (a genuine reveal ramp) writes through, and clears the latch", () => {
    const loop = fadeThenSettle(1);
    expect(loop.noteStreamedValue("p", "opacity", 0.5, 220)).toBe(0.5);
    expect(loop.noteStreamedValue("p", "opacity", 1, 230)).toBe(1); // no lingering clamp
  });

  it("cancel — an incoming ~0 (the producer caught up) writes through and clears the latch", () => {
    const loop = fadeThenSettle(1);
    expect(loop.noteStreamedValue("p", "opacity", 0, 220)).toBe(0);
    expect(loop.noteStreamedValue("p", "opacity", 1, 230)).toBe(1);
  });

  it("cancel — a NEW opacity tween on the node clears the latch (a fade back in animates)", () => {
    const loop = fadeThenSettle(1);
    loop.applyHints([linear(opacityHint("p", 0.8, 100))], 220);
    expect(loop.noteStreamedValue("p", "opacity", 1, 230)).toBe(1); // not clamped
    expect(sample(loop, "p", 320).opacity).toBeCloseTo(0.8, 9);
  });

  it("cancel — the grace expires and the resting alpha comes through", () => {
    const loop = fadeThenSettle(1);
    expect(loop.noteStreamedValue("p", "opacity", 1, 210 + HIDE_LATCH_GRACE_MS + 10)).toBe(1);
  });

  it("cancel — a STAGE REBUILD (wire keyframe) clears every latch", () => {
    const loop = fadeThenSettle(1);
    loop.clearHideLatches();
    expect(loop.noteStreamedValue("p", "opacity", 1, 220)).toBe(1);
  });

  it("cancel — a REMOVAL / display-gone forgets the node entirely", () => {
    const loop = fadeThenSettle(1);
    loop.releaseNode("p");
    expect(loop.noteStreamedValue("p", "opacity", 1, 220)).toBe(1);
    expect(loop.nextDeadline(220)).toBe(Infinity);
  });

  it("WS-REST: the held-restore self-heals at 150ms and hands the clamped value back", () => {
    // The rest-site refocus defect: the re-show arrives as a PLAIN resting-alpha write with NO fade-in hint, so
    // it is value-identical to the pre-hide flash and gets clamped. With NO further delta to un-stick it, the
    // evaluator has to release on its own — and it has to give the caller the value it swallowed.
    const loop = fadeThenSettle(1);
    expect(loop.noteStreamedValue("p", "opacity", 1, 220)).toBe(0); // the held-restore clock starts here
    expect(loop.nextDeadline(220)).toBe(220 + HIDE_LATCH_HELD_RESTORE_MS);

    loop.advance(320); // <150ms after the hold: still clamped
    expect(sample(loop, "p", 320).opacity).toBe(0);

    loop.advance(220 + HIDE_LATCH_HELD_RESTORE_MS);
    const healed = sample(loop, "p", 220 + HIDE_LATCH_HELD_RESTORE_MS);
    expect(healed.mask & SAMPLE_OPACITY).toBeTruthy();
    expect(healed.opacity).toBe(1);
    loop.advance(400);
    expect(loop.activeCount()).toBe(0); // and the node drains
  });

  it("never arms a latch for a PARTIAL fade (only a settle at ~0 is a disappear)", () => {
    const { loop, alphaOf } = harness();
    alphaOf.set("p", 1);
    loop.applyHints([opacityHint("p", 0.4, 200, { restingAlpha: null })], 0);
    loop.advance(210);
    expect(loop.noteStreamedValue("p", "opacity", 1, 220)).toBe(1);
  });
});

// ---- card flights --------------------------------------------------------------------------------------------

function flightHint(over: Partial<MirrorCardFlightHint> = {}): MirrorCardFlightHint {
  return {
    targetId: "41",
    trailId: "42",
    start: [300, 880],
    end: [1620, 880],
    control: [960, 280],
    basis: [1, 0, 0, 1],
    speed0: 1.18,
    accel: 2.3,
    duration: 1.4,
    scale0: 1,
    windowMs: 3600,
    kind: "shuffle",
    rot0: 0,
    ...over
  };
}

describe("canvas tween loop: card flights", () => {
  it("samples the CLOSED FORM — every pose matches cardFlightPoseAt directly", () => {
    const hint = flightHint();
    const timing = cardFlightTiming(hint);
    const { loop } = harness();
    loop.applyFlights([hint], 1000);

    let prevRotation = 0;
    for (const ms of [1000, 1016, 1100, 1400, 1700, 1900]) {
      const pose = cardFlightPoseAt(hint, timing, (ms - 1000) / 1000, prevRotation);
      prevRotation = pose.rotation;
      const expected = cardFlightGlobal6(hint.basis, pose, pose.scale);
      const got = sample(loop, "41", ms);
      expect(got.mask & SAMPLE_TRANSFORM).toBeTruthy();
      for (let i = 0; i < 6; i++) {
        expect(got.transform[i], `t=${ms} component ${i}`).toBeCloseTo(expected[i], 9);
      }
    }
  });

  it("holds the PIN past the landing, until the producer's suppression window closes", () => {
    const hint = flightHint();
    const timing = cardFlightTiming(hint);
    const { loop } = harness();
    loop.applyFlights([hint], 1000);

    const landedAt = 1000 + timing.totalSeconds * 1000;
    // Mid-flight this is a per-frame animator; landed, it is ONE wakeup at the pin's release.
    expect(loop.nextDeadline(1100)).toBe(1100);
    expect(loop.nextDeadline(landedAt + 1)).toBe(1000 + hint.windowMs);
    // The card is parked on the target anchor at scale 0 — releasing early would teleport a vanished card back.
    const parked = sample(loop, "41", landedAt + 500);
    expect([parked.transform[4], parked.transform[5]]).toEqual([1620, 880]);
    expect(parked.transform[0]).toBeCloseTo(0, 12);

    loop.advance(1000 + hint.windowMs);
    expect(sample(loop, "41", 1000 + hint.windowMs).mask).toBe(SAMPLE_NONE);
    expect(loop.nextDeadline(1000 + hint.windowMs)).toBe(Infinity);
  });

  it("a DISCARD's rotation is a sequential CHASE, stepped by wall-clock dt", () => {
    const hint = flightHint({ kind: "discard", rot0: 1.2, scale0: 1 });
    const timing = cardFlightTiming(hint);
    const { loop } = harness();
    loop.applyFlights([hint], 0);

    // Walked independently, exactly as `buildCardFlightPoses` walks its arc samples.
    let reference = hint.rot0;
    let prev = 0;
    const angles: number[] = [];
    for (let ms = 0; ms <= 600; ms += 16) {
      const facing = cardFlightPoseAt(hint, timing, ms / 1000, reference).rotation;
      reference = smoothAngleStep(reference, facing, FLIGHT_ROTATION_SMOOTH_RATE, (ms - prev) / 1000);
      prev = ms;
      const got = sample(loop, "41", ms);
      // basis is the identity and the arc scale is positive, so atan2(b, a) IS the composed rotation.
      const rotation = Math.atan2(got.transform[1], got.transform[0]);
      expect(rotation, `t=${ms}`).toBeCloseTo(reference, 9);
      angles.push(rotation);
    }

    // NO FIRST-FRAME SNAP: the flight opens exactly on the card's resting angle, however far the curve's facing
    // already is from it.
    expect(angles[0]).toBeCloseTo(hint.rot0, 12);
    // ...and no single frame closes more than the chase rate allows (12 · dt of the remaining arc).
    const maxStep = Math.min(1, FLIGHT_ROTATION_SMOOTH_RATE * 0.016) * Math.PI;
    for (let i = 1; i < angles.length; i++) {
      expect(Math.abs(angles[i] - angles[i - 1]), `step ${i}`).toBeLessThanOrEqual(maxStep + 1e-9);
    }
  });

  it("a SHUFFLE takes the curve's facing outright (no chase, no carried angle)", () => {
    const hint = flightHint({ kind: "shuffle", rot0: 0 });
    const timing = cardFlightTiming(hint);
    const { loop } = harness();
    loop.applyFlights([hint], 0);
    const got = sample(loop, "41", 16);
    expect(Math.atan2(got.transform[1], got.transform[0])).toBeCloseTo(
      cardFlightPoseAt(hint, timing, 0.016, 0).rotation,
      9
    );
  });

  it("erases a tween armed underneath it, rather than letting one pop in when the pin lifts", () => {
    const { loop, poses } = harness();
    poses.set("41", translate(300, 880));
    loop.applyFlights([flightHint()], 0);
    loop.applyHints([transformHint("41", translate(-999, -999), 100)], 100);
    loop.advance(3601); // past the flight's whole window AND the tween's deadline
    expect(sample(loop, "41", 3601).mask).toBe(SAMPLE_NONE);
    expect(loop.activeCount()).toBe(0);
  });

  it("supersedes a tween on the same node and clears its pending catch-up", () => {
    const { loop, poses } = harness();
    poses.set("41", translate(300, 880));
    loop.applyHints([transformHint("41", translate(900, 400), 800)], 0);
    loop.noteStreamedValue("41", "transform", translate(500, 700), 100); // would have been a catch-up
    loop.applyFlights([flightHint()], 200);

    // The flight is the authority: it re-derives the pose from its own curve every frame, so there is nothing to
    // "catch up" to — and the interrupted tween's stash must not survive to yank the card off the curve.
    const s = sample(loop, "41", 300);
    expect(s.transform[4]).not.toBeCloseTo(500, 3);
    loop.advance(3801); // past both the tween's deadline and the flight's pin
    expect(sample(loop, "41", 3801).mask).toBe(SAMPLE_NONE);
  });
});

// ---- R5 T-DR4: the comet root follows its flight -----------------------------------------------------------------
//
// A client that declares `trailDrive` tells the host it will place the comet root itself, and the producer then
// stops streaming that root's transform. This backend did not place it, so the whole comet — the ribbons' host and
// the decorative sprites hanging off it — sat frozen wherever the last streamed pose left it. The fix is a
// FOLLOWER: a second node in this map that holds no curve and no clock of its own and evaluates the CARD's flight.

describe("canvas tween loop: the comet root follows its flight", () => {
  /** A harness that drives every root it is offered, and one that refuses by capability. */
  function driven(over: Partial<TweenLoopOptions> = {}) {
    return createTweenLoop({ canDriveTrailRoot: () => true, ...over });
  }

  it("is OFF unless the renderer says otherwise — an absent guard drives nothing", () => {
    const loop = createTweenLoop();
    loop.applyFlights([flightHint()], 0);
    // Byte-identical to the pre-R5 loop: only the card is animated, and the root is not even in the map.
    expect(sample(loop, "42", 100).mask).toBe(SAMPLE_NONE);
    expect(loop.ownsTransform("42")).toBe(false);
    expect(loop.activeCount()).toBe(1);
    expect(loop.trailRootDrives()).toBe(0);
  });

  it("places the root at the flight's own POSITION and FACING, at scale 1", () => {
    const hint = flightHint();
    const timing = cardFlightTiming(hint);
    const loop = driven();
    loop.applyFlights([hint], 1000);

    for (const ms of [1000, 1100, 1400, 1900]) {
      const card = sample(loop, "41", ms);
      const root = sample(loop, "42", ms);
      expect(root.mask & SAMPLE_TRANSFORM, `t=${ms}`).toBeTruthy();
      // Same place as the card…
      expect(root.transform[4]).toBeCloseTo(card.transform[4], 9);
      expect(root.transform[5]).toBeCloseTo(card.transform[5], 9);
      // …and the pose the flight would give at scale 1, which is NOT the card's own (it pops and shrinks). The
      // ribbons carry their own authored widths, so folding the card's scale in would breathe the whole comet.
      const pose = cardFlightPoseAt(hint, timing, (ms - 1000) / 1000, 0);
      const expected = cardFlightGlobal6(hint.basis, pose, 1);
      for (let i = 0; i < 4; i++) {
        expect(root.transform[i], `t=${ms} basis ${i}`).toBeCloseTo(expected[i], 9);
      }
    }
    expect(loop.trailRootDrives(), "counted once per FLIGHT, not once per frame").toBe(1);
  });

  it("survives being sampled BEFORE the card — the flight's chase steps exactly once per frame", () => {
    // A discard's rotation is a sequential chase stepped by wall-clock dt, so two readers of one flight could
    // easily step it twice. `sampleFlight` is idempotent for a repeated `now`, and the map's iteration order is
    // not something a caller should have to know about.
    const hint = flightHint({ kind: "discard", rot0: 1.2 });
    const rootFirst = driven();
    const cardFirst = driven();
    rootFirst.applyFlights([hint], 0);
    cardFirst.applyFlights([hint], 0);
    for (const ms of [0, 16, 32, 48, 64]) {
      sample(rootFirst, "42", ms);
      sample(rootFirst, "41", ms);
      sample(cardFirst, "41", ms);
      sample(cardFirst, "42", ms);
    }
    const a = sample(rootFirst, "41", 80);
    const b = sample(cardFirst, "41", 80);
    for (let i = 0; i < 6; i++) {
      expect(a.transform[i], `component ${i}`).toBeCloseTo(b.transform[i], 9);
    }
  });

  it("is OWNED while it follows, so nothing else writes there", () => {
    const loop = driven();
    loop.applyFlights([flightHint()], 0);
    expect(loop.ownsTransform("42")).toBe(true);
    // …and the card's own ownership is unchanged.
    expect(loop.ownsTransform("41")).toBe(true);
  });

  it("lets go with the pin, publishing NOTHING — a vanished comet gets no extra frame", () => {
    const hint = flightHint();
    const loop = driven();
    loop.applyFlights([hint], 0);
    sample(loop, "42", 100);

    loop.advance(hint.windowMs);
    expect(sample(loop, "42", hint.windowMs).mask).toBe(SAMPLE_NONE);
    expect(loop.ownsTransform("42")).toBe(false);
    // Both nodes are inert and pruned: a follower that outlived its flight would pin a comet forever.
    expect(loop.activeCount()).toBe(0);
    expect(loop.nextDeadline(hint.windowMs)).toBe(Infinity);
  });

  it("does not hold the scheduler awake on its own — the flight already answers for both", () => {
    const hint = flightHint();
    const timing = cardFlightTiming(hint);
    const loop = driven();
    loop.applyFlights([hint], 0);
    expect(loop.nextDeadline(100)).toBe(100); // mid-flight: a per-frame animator, because of the CARD
    // Landed but pinned: ONE wakeup at the release, exactly as without a follower.
    expect(loop.nextDeadline(timing.totalSeconds * 1000 + 1)).toBe(hint.windowMs);
  });

  it("answers the release the same way whichever node `advance` reaches first", () => {
    // `advance` refreshes in map order, so a follower can be visited before the card whose flight expired. The
    // live test reads the flight's own window rather than trusting the card to have been cleared already.
    const hint = flightHint();
    const loop = driven();
    loop.applyFlights([hint], 0);
    sample(loop, "42", 10);
    // Sample the ROOT at an instant past the window without advancing anything first.
    expect(sample(loop, "42", hint.windowMs + 1).mask).toBe(SAMPLE_NONE);
  });

  it("a hint with no trailId drives nothing", () => {
    const loop = driven();
    loop.applyFlights([flightHint({ trailId: null })], 0);
    expect(loop.activeCount()).toBe(1);
    expect(loop.trailRootDrives()).toBe(0);
  });

  it("the renderer's refusal is per ROOT", () => {
    const refused: string[] = [];
    const loop = createTweenLoop({
      canDriveTrailRoot: (rootId) => {
        refused.push(rootId);
        return false;
      }
    });
    loop.applyFlights([flightHint()], 0);
    expect(refused).toEqual(["42"]);
    expect(sample(loop, "42", 100).mask).toBe(SAMPLE_NONE);
    expect(loop.trailRootDrives()).toBe(0);
  });

  it("a re-flown comet re-arms its follower — the same root serves the next card off the pile", () => {
    const loop = driven();
    loop.applyFlights([flightHint()], 0);
    sample(loop, "42", 10);
    loop.advance(3601);
    expect(loop.activeCount()).toBe(0);

    loop.applyFlights([flightHint({ targetId: "51" })], 4000);
    expect(sample(loop, "42", 4100).mask & SAMPLE_TRANSFORM).toBeTruthy();
    expect(loop.trailRootDrives()).toBe(2);
  });

  it("`releaseNode` on the CARD retires the follower with it", () => {
    const loop = driven();
    loop.applyFlights([flightHint()], 0);
    sample(loop, "42", 10);
    loop.releaseNode("41"); // the card left the scene mid-flight
    expect(sample(loop, "42", 20).mask).toBe(SAMPLE_NONE);
    loop.advance(20);
    expect(loop.activeCount()).toBe(0);
  });
});

// ---- demand-driven scheduling -----------------------------------------------------------------------------------

describe("canvas tween loop: demand-driven scheduling", () => {
  it("parks completely when nothing is armed", () => {
    const { loop } = harness();
    expect(loop.nextDeadline(0)).toBe(Infinity);
    expect(loop.activeCount()).toBe(0);
    expect(loop.advance(1000)).toBe(Infinity);
  });

  it("keeps a caller-owned pinned loop passive while a real tween remains urgent", () => {
    const { loop, poses } = harness({ loopDeadline: "caller" });
    const spec = pinnedLoopSpecFor(MAP_POINT_PULSE_TOKEN, "passive-loop")!;
    loop.applyPinnedLoop("passive-loop", spec, 0);

    // Canvas publishes the loop's own display-capped deadline. It must not
    // turn a finite future release or an always-visible local phase into an
    // unconditional rAF demand.
    expect(loop.nextDeadline(0)).toBe(Infinity);
    expect(loop.hasPerFrameDemand(0)).toBe(false);

    poses.set("moving", translate(0));
    loop.applyHints([transformHint("moving", translate(300), 300)], 0);
    expect(loop.nextDeadline(0)).toBe(300);
    expect(loop.hasPerFrameDemand(0)).toBe(true);
  });

  it("timer-parks a landed flight's future pin release without weakening live flight demand", () => {
    const hint = flightHint();
    const timing = cardFlightTiming(hint);
    const { loop } = harness();
    loop.applyFlights([hint], 0);

    expect(loop.hasPerFrameDemand(100)).toBe(true);
    const landedAt = timing.totalSeconds * 1000 + 1;
    expect(loop.nextDeadline(landedAt)).toBe(hint.windowMs);
    expect(loop.hasPerFrameDemand(landedAt)).toBe(false);
  });

  it("a 300ms tween publishes its deadline, then Infinity once it has settled", () => {
    const { loop, poses } = harness();
    poses.set("p", translate(0));
    loop.applyHints([transformHint("p", translate(300), 300)], 0);
    expect(loop.nextDeadline(0)).toBe(300);
    expect(loop.advance(150)).toBe(300); // still armed halfway through
    sample(loop, "p", 300); // the settle frame: nothing to catch up on, so nothing is handed back
    expect(loop.advance(300)).toBe(Infinity);
    expect(loop.activeCount()).toBe(0);
  });

  it("publishes the EARLIEST of many deadlines", () => {
    const { loop, poses } = harness();
    for (let i = 0; i < 5; i++) {
      poses.set(`n${i}`, translate(0));
      loop.applyHints([transformHint(`n${i}`, translate(100), 100 + i * 50)], 0);
    }
    expect(loop.nextDeadline(0)).toBe(100);
    // The documented frame contract: sweep the active set, THEN advance. `n0` settles at 100, publishes its final
    // value into this sweep, and the next-earliest deadline is `n1`'s.
    for (const id of [...loop.activeIds()]) {
      sample(loop, id, 120);
    }
    expect(loop.advance(120)).toBe(150);
  });

  it("a sweep is O(active), not O(scene) — the arena's peak is 78 concurrent", () => {
    // docs/agents/canvas-stage-probes-aug26.md §P8: the reshuffle peaks at 46 tweens + 30 flights = 78 combined,
    // while six of the eight recordings never exceed 6 and are idle 90%+ of their span. So the cost of a frame
    // must track what is ARMED, and a scene of any size must cost nothing while it is still.
    let visited = 0;
    const { loop, poses } = harness({ onNodeVisited: () => visited++ });
    for (let i = 0; i < 78; i++) {
      poses.set(`n${i}`, translate(i));
      // The probe's own mix: `modulate:a` is 124 of the reshuffle's 137 hints, so most channels never touch the
      // matrix math at all.
      loop.applyHints([i < 13 ? transformHint(`n${i}`, translate(i + 500), 400) : opacityHint(`n${i}`, 0.2, 400)], 0);
    }
    expect(loop.activeCount()).toBe(78);

    visited = 0;
    loop.advance(100);
    expect(visited).toBe(78); // exactly the active set — not the (arbitrarily larger) scene

    // A node the loop has never heard of costs one Map miss and no allocation, which is what lets the caller feed
    // `noteStreamedValue` every node it paints.
    visited = 0;
    for (let i = 0; i < 500; i++) {
      loop.noteStreamedValue(`unrelated${i}`, "opacity", 1, 100);
    }
    expect(visited).toBe(0);

    // Everything settles → the whole arena drains and the caller parks.
    loop.advance(410);
    expect(loop.advance(411)).toBe(Infinity);
    expect(loop.activeCount()).toBe(0);
  });

  it("`sampleInto` and `advance` are order-independent at the same clock", () => {
    const build = (): TweenLoop => {
      const { loop, poses } = harness();
      poses.set("h", translate(-200));
      loop.applyHints([transformHint("h", translate(-40), 884)], 0);
      loop.noteStreamedValue("h", "transform", translate(-150), 200);
      return loop;
    };
    const sampleFirst = build();
    const sampled = sample(sampleFirst, "h", 900);
    sampleFirst.advance(900);

    const advanceFirst = build();
    advanceFirst.advance(900);
    const advanced = sample(advanceFirst, "h", 900);

    expect(advanced).toEqual(sampled);
  });

  it("a settle value the caller never collects cannot hold the scheduler awake forever", () => {
    const { loop, poses } = harness();
    poses.set("h", translate(-200));
    loop.applyHints([transformHint("h", translate(-40), 884)], 0);
    loop.noteStreamedValue("h", "transform", translate(-150), 200);
    expect(loop.advance(900)).toBe(900); // one more paint owed
    expect(loop.advance(916)).toBe(Infinity); // ...and exactly one sweep is the bound
    expect(loop.activeCount()).toBe(0);
  });
});

// ---- pinned loops ------------------------------------------------------------------------------------------------

describe("canvas tween loop: pinned loops", () => {
  it("evaluates a phase against the shared clock origin, and de-locksteps per node", () => {
    const { loop } = harness({ clockOriginMs: 0 });
    const a = pinnedLoopSpecFor(MAP_POINT_PULSE_TOKEN, "map-point-a")!;
    const b = pinnedLoopSpecFor(MAP_POINT_PULSE_TOKEN, "map-point-b")!;
    expect(a.periodMs).toBeCloseTo((2000 * Math.PI) / 4, 9); // one cycle of the pulse's 4 rad/s sine
    expect(a.anchor).toBe("document");
    expect(a.phaseMs).not.toBe(b.phaseMs); // the game seeds each point's clock randomly; a lockstep fleet blinks

    loop.applyPinnedLoop("map-point-a", a, 0);
    expect(loop.loopPhase("map-point-a", 0)).toBeCloseTo((a.phaseMs / a.periodMs) % 1, 12);
    expect(loop.loopPhase("map-point-a", a.periodMs / 2)).toBeCloseTo(((a.phaseMs / a.periodMs) + 0.5) % 1, 12);
    // A whole period later the phase is exactly where it started — that is what "anchored" buys.
    expect(loop.loopPhase("map-point-a", a.periodMs)).toBeCloseTo(loop.loopPhase("map-point-a", 0), 12);
    expect(loop.loopPhase("nobody", 0)).toBe(-1);
  });

  it("does NOT anchor the end-turn glow: its cycle ends invisible, so it starts where it is applied", () => {
    const { loop } = harness();
    const spec = pinnedLoopSpecFor(END_TURN_GLOW_TOKEN, "glow")!;
    expect(spec.anchor).toBe("apply");
    expect(spec.phaseMs).toBe(0);
    loop.applyPinnedLoop("glow", spec, 5000);
    expect(loop.loopPhase("glow", 5000)).toBe(0);
    expect(loop.loopPhase("glow", 5000 + spec.periodMs / 4)).toBeCloseTo(0.25, 12);
  });

  it("re-applying an equal spec never restarts the cycle; a visibility flip is applied in place", () => {
    const { loop } = harness();
    const spec = pinnedLoopSpecFor(END_TURN_GLOW_TOKEN, "glow")!;
    loop.applyPinnedLoop("glow", spec, 5000);
    loop.applyPinnedLoop("glow", { ...spec, visible: false }, 6000); // a re-style, mid-cycle
    expect(loop.loopPhase("glow", 6000)).toBeCloseTo(((6000 - 5000) / spec.periodMs) % 1, 12);
    expect(loop.nextDeadline(6000)).toBe(Infinity); // invisible ⇒ inert
    loop.applyPinnedLoop("glow", spec, 6500);
    expect(loop.nextDeadline(6500)).toBe(6500); // visible again ⇒ per-frame
  });

  it("only a VISIBLE loop holds the scheduler at per-frame", () => {
    const { loop } = harness();
    const spec = pinnedLoopSpecFor(MAP_POINT_PULSE_TOKEN, "mp")!;
    loop.applyPinnedLoop("mp", { ...spec, visible: false }, 0);
    expect(loop.nextDeadline(100)).toBe(Infinity);
    loop.applyPinnedLoop("mp", { ...spec, visible: true }, 0);
    expect(loop.nextDeadline(100)).toBe(100);
    loop.applyPinnedLoop("mp", null, 100);
    expect(loop.nextDeadline(100)).toBe(Infinity);
    expect(loop.activeCount()).toBe(0);
  });

  it("keeps the normal visible-loop contract urgent", () => {
    const { loop } = harness();
    loop.applyPinnedLoop("mp", pinnedLoopSpecFor(MAP_POINT_PULSE_TOKEN, "mp")!, 0);
    expect(loop.hasPerFrameDemand(100)).toBe(true);
  });

  it("bobPhaseMs de-locksteps a row of intents by their baked X, mount-independently", () => {
    // The game offsets each NIntent's bob by its index (`i·0.3` rad on a 2000ms period); intents lay out
    // left-to-right, so the baked global X stands in for the index.
    expect(bobPhaseMs(2000, 0)).toBe(0);
    expect(bobPhaseMs(2000, 1920)).toBe(0); // one full design width = one full period
    expect(bobPhaseMs(2000, 960)).toBeCloseTo(1000, 9);
    expect(bobPhaseMs(2000, -960)).toBeCloseTo(1000, 9); // always normalized into [0, period)
    // Adjacent icons ~100px apart land ~104ms apart, close to the game's own ~95.5ms/icon.
    expect(bobPhaseMs(2000, 1060) - bobPhaseMs(2000, 960)).toBeCloseTo(104.1666, 3);
  });
});

// ---- the dormant / never-sampled target ---------------------------------------------------------------------------

describe("canvas tween loop: a target nothing is painting", () => {
  it("arms all three channels inertly and still holds the self pin when the node is finally drawn", () => {
    // The DOM path's dormancy case, restated: a hint can name a node the walk declined to build. There, only the
    // DURABLE `tweenSelfOpacity` pin survives (the two element-bound arms no-op on a null `el`); here every
    // channel is inherently durable because there is no element to be missing.
    const { loop } = harness();
    loop.applyHints(
      [
        transformHint("dlg", translate(300, 300), 60_000),
        opacityHint("dlg", 0.5, 60_000, { startOpacity: 1 }),
        linear(selfOpacityHint("dlg", 0.25, 60_000, { startOpacity: 1 }))
      ],
      0
    );
    expect(() => loop.advance(1000)).not.toThrow();
    expect(() => loop.advance(2000)).not.toThrow();
    expect(loop.activeCount()).toBe(1);

    // The reveal, 30s later: the pins outlived the dormancy and the node is drawn mid-fade.
    const revealed = sample(loop, "dlg", 30_000);
    expect(revealed.mask & SAMPLE_SELF_OPACITY).toBeTruthy();
    expect(revealed.selfOpacity).toBeCloseTo(1 - 0.75 * 0.5, 9);
  });
});

// WHO OWNS A NODE'S TRANSFORM (M3 WS-D). The eager-scroll snapshot asks this of every scrollable it publishes: a
// container something is ANIMATING must not also carry a cosmetic scroll offset, because the two would be writing
// the same pixel every frame. The question is deliberately about the TRANSFORM channel and not about membership
// of the loop, which is the proxy that looks right and is not.
describe("canvas tween loop: transform ownership", () => {
  it("is true for a running transform tween and false once it has expired", () => {
    const { loop } = harness();
    expect(loop.ownsTransform("scroll")).toBe(false);
    loop.applyHints([transformHint("scroll", translate(0, -300), 200)], 0);
    expect(loop.ownsTransform("scroll")).toBe(true);
    sample(loop, "scroll", 250); // collect the settle value, then let the sweep drop the channel
    loop.advance(250);
    expect(loop.ownsTransform("scroll")).toBe(false);
  });

  it("is true for a live card FLIGHT, which owns the channel outright", () => {
    const { loop } = harness();
    loop.applyFlights([flightHint()], 1000);
    expect(loop.ownsTransform("41")).toBe(true);
  });

  it("is FALSE for a node the loop holds by an ALPHA channel alone — the wrong proxy's answer", () => {
    const { loop } = harness();
    loop.applyHints([opacityHint("dlg", 0.5, 60_000, { startOpacity: 1 })], 0);
    // The node IS in the loop (a fading dialog is animated) — but nothing is moving it, so a scroll container in
    // this state may still lead.
    expect(loop.activeCount()).toBe(1);
    expect([...loop.activeIds()]).toContain("dlg");
    expect(loop.ownsTransform("dlg")).toBe(false);
  });

  it("is false for a node the loop has never heard of", () => {
    const { loop } = harness();
    expect(loop.ownsTransform("nobody")).toBe(false);
  });
});

// ---- the transform ENDPOINT accessor ---------------------------------------------------------------------------
//
// The read `handRaise`'s focus ramp needs: where is this node HEADED, and is anything actually taking it there
// right now. The whole point of the method is that a STALE endpoint is unrepresentable, so most of these cases
// assert a `false` rather than a number.

describe("canvas tween loop: transformEndpointInto", () => {
  const out: number[] = [0, 0, 0, 0, 0, 0];

  it("answers the ENDPOINT of a running channel — not the pose it has reached", () => {
    const { loop } = harness();
    loop.applyHints([linear(transformHint("holder", translate(400, -209), 400, { startTransform: translate(0, -50) }))], 1000);
    // Mid-tween: the SAMPLE is halfway, the endpoint is the destination. The ramp wants the destination.
    expect(ty(sample(loop, "holder", 1200))).toBeCloseTo(-129.5, 6);
    expect(loop.transformEndpointInto("holder", out, 1200)).toBe(true);
    expect(out).toEqual([1, 0, 0, 1, 400, -209]);
  });

  it("is FALSE for a node the loop has never heard of, and for an ALPHA-only node", () => {
    const { loop } = harness();
    loop.applyHints([opacityHint("dlg", 0.5, 60_000, { startOpacity: 1 })], 0);
    expect(loop.transformEndpointInto("nobody", out, 0)).toBe(false);
    expect(loop.transformEndpointInto("dlg", out, 100)).toBe(false);
  });

  it("is FALSE for a live card FLIGHT — a comet has no endpoint to be headed for", () => {
    const { loop } = harness();
    loop.applyFlights([flightHint()], 1000);
    expect(loop.ownsTransform("41")).toBe(true); // the channel IS owned…
    expect(loop.transformEndpointInto("41", out, 1400)).toBe(false); // …but not by anything with a destination
  });

  it("STILL answers across the settle while the value is uncollected — the pin-catch-up leg", () => {
    const { loop } = harness();
    loop.applyHints([transformHint("holder", translate(400, -209), 200, { startTransform: translate(0, -50) })], 1000);
    // Past `until`: the channel is gone, but nobody has painted the settle yet, so the node's own state is still
    // the frozen pre-tween pose. Releasing here is what dropped the DOM card a whole lift one frame early.
    expect(loop.transformEndpointInto("holder", out, 1300)).toBe(true);
    expect(out).toEqual([1, 0, 0, 1, 400, -209]);
  });

  it("READS the settle purely — sampleInto still delivers it exactly once, and then the answer is false", () => {
    const { loop } = harness();
    loop.applyHints([transformHint("holder", translate(400, -209), 200, { startTransform: translate(0, -50) })], 1000);
    expect(loop.transformEndpointInto("holder", out, 1300)).toBe(true);
    expect(loop.transformEndpointInto("holder", out, 1300)).toBe(true); // idempotent: never consumed

    const settled = sample(loop, "holder", 1300);
    expect(settled.mask & SAMPLE_TRANSFORM).toBeTruthy();
    expect(settled.transform).toEqual([1, 0, 0, 1, 400, -209]);
    // Collected. The caller now holds the pose in its own state, so there is nothing left to be headed for.
    expect(loop.transformEndpointInto("holder", out, 1300)).toBe(false);
  });

  it("hands back the PIN CATCH-UP, not the endpoint, when the producer contradicted it", () => {
    const { loop } = harness();
    loop.applyHints([transformHint("holder", translate(400, -209), 200, { startTransform: translate(0, -50) })], 1000);
    // A fresher streamed pose arrives mid-tween (the focus teleport the pin overrode).
    loop.noteStreamedValue("holder", "transform", translate(900, -300), 1100);
    expect(loop.transformEndpointInto("holder", out, 1300)).toBe(true);
    expect(out).toEqual([1, 0, 0, 1, 900, -300]);
  });

  it("follows a RE-TARGET to the new endpoint and drops the old one", () => {
    const { loop } = harness();
    loop.applyHints([transformHint("holder", translate(400, -209), 400, { startTransform: translate(0, -50) })], 1000);
    loop.applyHints([transformHint("holder", translate(-100, -50), 400)], 1200);
    expect(loop.transformEndpointInto("holder", out, 1300)).toBe(true);
    expect(out).toEqual([1, 0, 0, 1, -100, -50]);
  });

  it("goes false once the settle is collected AND the sweep has run — no endpoint outlives its tween", () => {
    const { loop } = harness();
    loop.applyHints([transformHint("holder", translate(400, -209), 200, { startTransform: translate(0, -50) })], 1000);
    sample(loop, "holder", 1300);
    loop.advance(1300);
    expect(loop.activeCount()).toBe(0); // pruned entirely
    expect(loop.transformEndpointInto("holder", out, 5000)).toBe(false);
    expect(loop.transformEndpointInto("holder", out, 900_000)).toBe(false);
  });

  it("does not disturb the frame contract: asking BEFORE the sweep gives the sweep's own values", () => {
    const { loop } = harness();
    loop.applyHints([linear(transformHint("holder", translate(400, 0), 400, { startTransform: translate(0, 0) }))], 1000);
    // The renderer's order: raise pass (this read) → sweepAnimated → advance, all at one clock read.
    expect(loop.transformEndpointInto("holder", out, 1200)).toBe(true);
    expect(tx(sample(loop, "holder", 1200))).toBeCloseTo(200, 6);
    expect(loop.advance(1200)).toBe(1400);
  });
});
