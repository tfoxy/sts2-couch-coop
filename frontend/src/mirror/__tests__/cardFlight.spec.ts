import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  advanceCardFlight,
  buildCardFlightPoses,
  cardFlightGlobal6,
  cardFlightPoseAt,
  cardFlightTiming,
  createCardFlight,
  discardArcScale,
  discardPopScale,
  flightBezier,
  flightPopScale,
  smoothAngleStep,
  DISCARD_ARC_SCALE_TO,
  DISCARD_POP_OFFSETS,
  DISCARD_POP_ZERO_PROGRESS,
  DISCARD_RAMP_PSEUDOTIME_FACTOR,
  FLIGHT_MAX_STEP_SECONDS,
  FLIGHT_ROTATION_LOOK_AHEAD,
  FLIGHT_ROTATION_SMOOTH_RATE,
  type CardFlightState
} from "@/mirror/cardFlight";
import {
  createMirrorRenderer,

  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorCardFlightHint,
  type MirrorState
} from "@/mirror/sceneTree";

// WS-3 — the discard→draw shuffle card flight, REPLAYED client-side from a declarative hint.
//
// The producer used to stream every frame of every flying card (measured: 598 KB, 45% of a shuffle's upsert bytes,
// 1852 of 3469 upserts on a 34.8s recording) and — because scene deltas are credit-gated on the client's ack — the
// animation played back at the CLIENT's frame rate (traced: 9.4 fps for 1.7 s). Now it ships ~11 numbers and stops
// streaming those nodes entirely for the flight's duration.
//
// That last clause is what makes these specs load-bearing rather than cosmetic: the producer has FROZEN the nodes,
// so if the integrator is wrong or the pin is released early, the failure mode is a card stuck on the discard pile
// — not a slightly-wrong ease. The suites below
// go in that order of severity.

// A representative flight: right-to-left across the board, arcing up, with every parameter inside the range the
// producer can actually emit (speed0 ∈ [1.1,1.25], accel ∈ [2,2.5], duration ∈ [1,1.75], scale0 = 1).
function hint(overrides: Partial<MirrorCardFlightHint> = {}): MirrorCardFlightHint {
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
    ...overrides
  };
}

// Expected values pinned from the shipped replay model: the arc's position at 41 evenly spaced curve parameters
// (t = i/40) for the `hint()` flight above. Literals rather than a second implementation of the same formula — a
// re-derivation would agree with a mistyped constant. Regenerate only when the model changes on purpose.
const ARC_SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [300, 880], [333, 850.75], [366, 823], [399, 796.75],
  [432, 772], [465, 748.75], [498, 727], [531, 706.75],
  [564, 688], [597, 670.75], [630, 655], [663, 640.75],
  [696, 628], [729, 616.75], [762, 607], [795, 598.75],
  [828, 592], [861, 586.75], [894, 583], [927, 580.75],
  [960, 580], [993, 580.75], [1026, 583], [1059, 586.75],
  [1092, 592], [1125, 598.75], [1158, 607], [1191, 616.75],
  [1224, 628], [1257, 640.75], [1290, 655], [1323, 670.75],
  [1356, 688], [1389, 706.75], [1422, 727], [1455, 748.75],
  [1488, 772], [1521, 796.75], [1554, 823], [1587, 850.75],
  [1620, 880]
];

// Run a whole flight at a fixed frame rate, returning every pose it produced.
function fly(h: MirrorCardFlightHint, fps: number, maxSeconds = 30) {
  const state = createCardFlight(h);
  const dt = 1 / fps;
  const poses: Array<{ t: number; x: number; y: number; rotation: number; scale: number }> = [];
  for (let elapsed = 0; elapsed < maxSeconds && state.phase !== "done"; elapsed += dt) {
    poses.push({ t: elapsed + dt, ...advanceCardFlight(state, h, dt) });
  }
  return { state, poses };
}

describe("cardFlight — the arc's curve", () => {
  it("tracks the pinned quadratic across the whole parameter range", () => {
    const h = hint();
    const out = { x: 0, y: 0 };
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      flightBezier(h.start, h.end, h.control, t, out);
      const [x, y] = ARC_SAMPLES[i];
      expect(out.x).toBeCloseTo(x, 9);
      expect(out.y).toBeCloseTo(y, 9);
    }
  });

  it("is NOT clamped past t=1", () => {
    // The integrator steps first and tests after, so it can sample slightly past 1 and the curve has to keep
    // going there. A clamped implementation would silently flatten the last frame of every flight onto the pile.
    const out = { x: 0, y: 0 };
    flightBezier([0, 0], [100, 0], [50, 0], 1.1, out);
    expect(out.x).toBeGreaterThan(100);
  });
});

describe("cardFlight — phase 1, the arc", () => {
  it("starts AT the source pile, not wherever the node was spawned", () => {
    // Nothing has posed the flier before its first animation frame — its streamed transform is still the scene's
    // own. Since the producer immediately stops streaming it, an integrator that started anywhere else would leave
    // the card sitting at the scene origin for the whole flight.
    const h = hint();
    const first = advanceCardFlight(createCardFlight(h), h, 0);
    expect(first.x).toBeCloseTo(h.start[0], 6);
    expect(first.y).toBeCloseTo(h.start[1], 6);
  });

  it("accelerates: each step advances the curve parameter further than the last", () => {
    // The pseudo-time rate accelerates as the card travels. A constant-speed integrator would land the card LATE
    // and make the whole flight look like a different animation.
    const { poses } = fly(hint(), 60);
    const arc = poses.filter((p) => p.scale === 1);
    const steps = arc.slice(1).map((p, i) => Math.hypot(p.x - arc[i].x, p.y - arc[i].y));
    // Not monotone in ARC LENGTH (a bezier's speed varies along it), so compare the first and last thirds.
    const early = steps.slice(0, Math.floor(steps.length / 3));
    const late = steps.slice(-Math.floor(steps.length / 3));
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(late)).toBeGreaterThan(mean(early));
  });

  it("bows toward the control point rather than sliding in a straight line", () => {
    const h = hint();
    const { poses } = fly(h, 60);
    const arc = poses.filter((p) => p.scale === 1);
    const topY = Math.min(...arc.map((p) => p.y));
    expect(topY, "the arc lifts well above the two pile anchors").toBeLessThan(h.start[1] - 100);
  });

  it("faces along the flight: rotation is the tangent plus a quarter turn", () => {
    // `Rotation = (BezierCurve(…, (time+0.05)/duration) - GlobalPosition).Angle() + PI/2`.
    const h = hint({ start: [0, 500], end: [1000, 500], control: [500, 500] }); // a straight, rightward flight
    const state = createCardFlight(h);
    const pose = advanceCardFlight(state, h, 1 / 60);
    expect(pose.rotation).toBeCloseTo(Math.PI / 2, 6);
    expect(FLIGHT_ROTATION_LOOK_AHEAD).toBe(0.05);
  });

  it("lands EXACTLY on the target pile, never on the overshot curve sample", () => {
    // `GlobalPosition = _endPos;` before phase 2. The card must sit on the draw pile, not a few px past it.
    const h = hint();
    const { poses } = fly(h, 60);
    const landed = poses.filter((p) => p.scale !== 1);
    expect(landed.length).toBeGreaterThan(0);
    for (const p of landed) {
      expect(p.x).toBeCloseTo(h.end[0], 6);
      expect(p.y).toBeCloseTo(h.end[1], 6);
    }
  });
});

describe("cardFlight — phase 2, the pop (absolute Scale assignment)", () => {
  it("pops to a tenth then shrinks to nothing", () => {
    // `Scale = One * max(lerp(0.1, -0.1, progress), 0)` — an ABSOLUTE assignment against an authored scale of 1,
    // so the card really does snap to a tenth of its size on the first pop frame. Matching that is the whole
    // reason `scale0` is on the wire.
    expect(flightPopScale(0)).toBeCloseTo(0.1, 12);
    expect(flightPopScale(0.25)).toBeCloseTo(0.05, 12);
    expect(flightPopScale(0.5)).toBeCloseTo(0, 12);
    expect(flightPopScale(0.9)).toBeCloseTo(0, 12);
  });

  it("divides by the node's spawn scale so the pop is an absolute size, not a relative one", () => {
    // `basis` already carries the node's spawn scale, so the multiplier has to UNDO it: the pop assigns an
    // absolute 0.1, which against an authored 0.5 is a 0.2 multiplier and against an authored 1.0 is 0.1. Run two
    // otherwise-identical flights in lockstep and check the ratio holds at every pop frame.
    const unit = hint({ scale0: 1 });
    const half = hint({ scale0: 0.5 });
    const a = createCardFlight(unit);
    const b = createCardFlight(half);
    let compared = 0;
    for (let i = 0; i < 400 && a.phase !== "done"; i++) {
      const pa = advanceCardFlight(a, unit, 1 / 60);
      const pb = advanceCardFlight(b, half, 1 / 60);
      if (pa.scale !== 1 && pa.scale > 0) {
        expect(pb.scale).toBeCloseTo(pa.scale * 2, 9);
        compared++;
      }
    }
    expect(compared, "the pop actually ran").toBeGreaterThan(2);
  });

  it("does NOT keep accelerating (the second loop drops the accel term)", () => {
    // Phase 2 is `time += _speed*dt` only, carrying the speed phase 1 left. Re-accelerating would shrink the card
    // away visibly faster than it should.
    const h = hint();
    const state = createCardFlight(h);
    while (state.phase === "arc") {
      advanceCardFlight(state, h, 1 / 60);
    }
    const speedAtLanding = state.speed;
    advanceCardFlight(state, h, 1 / 60);
    advanceCardFlight(state, h, 1 / 60);
    expect(state.speed).toBe(speedAtLanding);
  });

  it("settles at scale 0 on the end pile and stays there however long it is polled", () => {
    const h = hint();
    const { state } = fly(h, 60);
    expect(state.phase).toBe("done");
    for (let i = 0; i < 5; i++) {
      const pose = advanceCardFlight(state, h, 1 / 60);
      expect(pose.scale).toBe(0);
      expect(pose.x).toBeCloseTo(h.end[0], 6);
    }
  });
});

describe("cardFlight — frame-rate behaviour", () => {
  it("flies the same path at 9.4 fps as at 60 fps (the traced slow-client case)", () => {
    // The whole point of replaying locally: the animation is driven by dt, not by how many deltas arrived. The
    // coarse client samples the SAME curve, just less often.
    const h = hint();
    const fast = fly(h, 60).poses.filter((p) => p.scale === 1);
    const slow = fly(h, 9.4).poses.filter((p) => p.scale === 1);
    for (const p of slow) {
      // Every coarse sample lies on the fine path (within the fine sampling's own chord length).
      const nearest = Math.min(...fast.map((f) => Math.hypot(f.x - p.x, f.y - p.y)));
      expect(nearest).toBeLessThan(60);
    }
  });

  it("finishes at nearly the same wall clock at both rates", () => {
    // Forward Euler over an accelerating speed under-integrates slightly at a coarse step, so this is "close",
    // not "equal" — but it must not drift by a visible fraction of the ~2s animation.
    const h = hint();
    const at60 = fly(h, 60).poses.at(-1)!.t;
    const at9 = fly(h, 9.4).poses.at(-1)!.t;
    expect(Math.abs(at9 - at60)).toBeLessThan(0.4);
  });

  it("clamps a huge step rather than teleporting after a backgrounded tab", () => {
    // rAF stops in a hidden tab, so the first frame back can carry seconds of dt. Stepping it whole would jump the
    // card across the board and lay one absurd trail chord; catching up over a few frames is both cheaper and
    // correct-looking, and if the stall outlives the hint's window the renderer's pin expires and the producer's
    // resumed stream takes over.
    const h = hint();
    const clamped = createCardFlight(h);
    advanceCardFlight(clamped, h, 30);
    const stepped = createCardFlight(h);
    advanceCardFlight(stepped, h, FLIGHT_MAX_STEP_SECONDS);
    expect(clamped.time).toBeCloseTo(stepped.time, 12);
    expect(clamped.phase).toBe("arc");
  });

  it("treats a negative or zero dt as a no-op sample", () => {
    const h = hint();
    const state: CardFlightState = createCardFlight(h);
    const before = state.time;
    advanceCardFlight(state, h, -5);
    expect(state.time).toBe(before);
  });
});

describe("cardFlight — pose composition", () => {
  it("composes basis · R(rotation) · scale with the pose as the origin", () => {
    const pose = { x: 123, y: 456, rotation: 0, scale: 1 };
    expect(cardFlightGlobal6([1, 0, 0, 1], pose, 1)).toEqual([1, 0, 0, 1, 123, 456]);
  });

  it("rotates in Godot's column convention (X = (cos, sin), Y = (-sin, cos))", () => {
    const pose = { x: 0, y: 0, rotation: Math.PI / 2, scale: 1 };
    const m = cardFlightGlobal6([1, 0, 0, 1], pose, 1);
    expect(m[0]).toBeCloseTo(0, 9);
    expect(m[1]).toBeCloseTo(1, 9);
    expect(m[2]).toBeCloseTo(-1, 9);
    expect(m[3]).toBeCloseTo(0, 9);
  });

  it("carries the parent chain's basis through (a scaled/flipped parent is not lost)", () => {
    const pose = { x: 10, y: 20, rotation: 0, scale: 1 };
    expect(cardFlightGlobal6([2, 0, 0, -3], pose, 1)).toEqual([2, 0, 0, -3, 10, 20]);
  });

  it("applies the pop scale to the basis, never to the position", () => {
    const pose = { x: 10, y: 20, rotation: 0, scale: 0.1 };
    const m = cardFlightGlobal6([1, 0, 0, 1], pose, pose.scale);
    expect(m.slice(0, 4)).toEqual([0.1, 0, 0, 0.1]);
    expect(m.slice(4)).toEqual([10, 20]); // the card shrinks IN PLACE on the pile
  });
});

describe("cardFlight — the wire contract (parseSceneDelta)", () => {
  const envelope = (flights: unknown[]) => ({
    type: "scene-delta",
    full: false,
    screenType: "combat",
    upserts: [],
    removedIds: [],
    cardFlights: flights
  });

  it("parses a producer-shaped flight", () => {
    const delta = parseSceneDelta(envelope([hint()]))!;
    expect(delta.cardFlights).toHaveLength(1);
    expect(delta.cardFlights[0].targetId).toBe("41");
    expect(delta.cardFlights[0].windowMs).toBe(3600);
  });

  it("defaults to an empty list when the key is absent (the common case)", () => {
    const delta = parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "combat",
      upserts: [],
      removedIds: []
    })!;
    expect(delta.cardFlights).toEqual([]);
  });

  it("drops a flight it could not integrate rather than half-applying it", () => {
    // Strict on purpose: the producer has stopped streaming these nodes, so a partially-understood flight leaves
    // them frozen. Each case mutates exactly one field.
    const bad: Array<[string, Partial<MirrorCardFlightHint> | Record<string, unknown>]> = [
      ["missing targetId", { targetId: "" }],
      ["short start", { start: [300] }],
      ["6-long basis (a transform, not a basis)", { basis: [1, 0, 0, 1, 0, 0] }],
      ["non-finite control", { control: [Number.POSITIVE_INFINITY, 0] }],
      ["zero duration", { duration: 0 }],
      ["zero speed0", { speed0: 0 }],
      ["zero scale0", { scale0: 0 }],
      ["zero windowMs", { windowMs: 0 }],
      ["string end", { end: "1620,880" }]
    ];
    for (const [label, patch] of bad) {
      const delta = parseSceneDelta(envelope([{ ...hint(), ...patch }]))!;
      expect(delta.cardFlights, label).toHaveLength(0);
    }
  });

  // R13 — `kind`/`rot0` are the one pair this strict parser is lenient about, and in the OTHER direction: they are
  // normalized, never rejected. Unusable geometry is dropped because there is nothing to integrate from it; a kind
  // this build has never heard of still arrives with a complete flight, so failing open to the shuffle motion costs
  // the wrong flavour of animation, while dropping it would leave the (suppressed) card frozen on the pile.
  it("normalizes an absent kind to the shuffle sweep", () => {
    const delta = parseSceneDelta(envelope([{ ...hint(), kind: undefined, rot0: undefined }]))!;
    expect(delta.cardFlights[0].kind).toBe("shuffle");
    expect(delta.cardFlights[0].rot0).toBe(0);
  });

  it("round-trips the discard kind and its rotation seed", () => {
    const delta = parseSceneDelta(envelope([{ ...hint(), kind: "discard", rot0: -0.35 }]))!;
    expect(delta.cardFlights).toHaveLength(1);
    expect(delta.cardFlights[0].kind).toBe("discard");
    expect(delta.cardFlights[0].rot0).toBeCloseTo(-0.35, 6);
  });

  it("fails an unrecognised kind OPEN to shuffle rather than dropping the flight", () => {
    // A future kind, a casing slip, an empty string, or a value that is not a string at all — none may drop it.
    for (const kind of ["supernova", "Discard", "DISCARD", "", null, 7, true, ["discard"]]) {
      const delta = parseSceneDelta(envelope([{ ...hint(), kind }]))!;
      expect(delta.cardFlights, `kind ${JSON.stringify(kind)} is still a flight`).toHaveLength(1);
      expect(delta.cardFlights[0].kind, `kind ${JSON.stringify(kind)} ⇒ shuffle`).toBe("shuffle");
    }
  });

  it("degrades an unusable rotation seed to 0 instead of dropping the flight", () => {
    for (const rot0 of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, null, "-0.35", [0.5]]) {
      const delta = parseSceneDelta(envelope([{ ...hint(), kind: "discard", rot0 }]))!;
      expect(delta.cardFlights, `rot0 ${JSON.stringify(rot0)} is still a flight`).toHaveLength(1);
      expect(delta.cardFlights[0].rot0, `rot0 ${JSON.stringify(rot0)} ⇒ 0`).toBe(0);
      // The two are independent in the parser: a discard with an unusable seed is still a discard.
      expect(delta.cardFlights[0].kind).toBe("discard");
    }
    expect(parseSceneDelta(envelope([{ ...hint(), rot0: 0.75 }]))!.cardFlights[0].rot0).toBeCloseTo(0.75, 6);
  });

  it("keeps a flight with no trail (there is none outside a combat room)", () => {
    const delta = parseSceneDelta(envelope([{ ...hint(), trailId: undefined }]))!;
    expect(delta.cardFlights).toHaveLength(1);
    expect(delta.cardFlights[0].trailId).toBeNull();
  });

  it("accumulates flights across coalesced deltas and bounds the backlog", () => {
    const state = createMirrorState();
    applySceneDelta(state, parseSceneDelta(envelope([hint(), hint({ targetId: "43" })]))!);
    expect(state.pendingCardFlights).toHaveLength(2);
    for (let i = 0; i < 100; i++) {
      applySceneDelta(state, parseSceneDelta(envelope([hint({ targetId: String(i) })]))!);
    }
    expect(state.pendingCardFlights).toHaveLength(64);
    expect(state.pendingCardFlights.at(-1)!.targetId).toBe("99");
  });
});

// ---- end-to-end through the renderer -----------------------------------------------------------------------

type Raw = Record<string, unknown>;

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

const xf = (tx: number, ty: number) => ({
  xAxis: { x: 1, y: 0 },
  yAxis: { x: 0, y: 1 },
  origin: { x: tx, y: ty }
});

const box = { position: { x: 0, y: 0 }, size: { x: 100, y: 140 } };

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

// The three nodes a flight moves: the VFX itself, the trail root that copies its pose, and one of the trail's
// `NCardTrail` strokes. Parked where they are spawned — i.e. NOT at the flight's start anchor, which is what
// makes "did the hint place it?" an observable question.
function flightNodes(): Raw[] {
  return [
    { id: "41", parentId: "Game", name: "VfxCardFlyShuffle", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardFlyShuffleVfx", visible: true, transform: xf(0, 0), localRect: box },
    { id: "42", parentId: "Game", name: "CardTrailIronclad", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx", visible: true, transform: xf(0, 0) },
    { id: "43", parentId: "42", name: "Trails", nodeType: "Godot.Node2D", visible: true, transform: xf(0, 0) },
    { id: "44", parentId: "43", name: "OuterTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0) }
  ];
}

function seed(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
}

function deliverFlight(state: MirrorState, h: MirrorCardFlightHint): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: [],
      cardFlights: [h]
    })!
  );
}

function translation(stage: HTMLElement, id: string): [number, number] | null {
  const el = stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null;
  const m = el?.style.transform.match(/matrix\(([^)]+)\)/);
  if (!m) {
    return null;
  }
  const parts = m[1].split(",").map(Number);
  return [parts[4], parts[5]];
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("cardFlight — renderer integration", () => {
  it("places the card at the flight's START the moment the hint lands", () => {
    // The producer stops streaming this node the same tick, and the node's own streamed transform is the scene's
    // (0,0) — so without an immediate frame-0 write the card would sit at the design origin for the whole flight.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes()]);
    renderer.reconcile(state);
    expect(translation(stage, "41"), "parked at the scene origin before the hint").toEqual([0, 0]);

    const h = hint();
    deliverFlight(state, h);
    renderer.reconcile(state);
    const at = translation(stage, "41")!;
    expect(at[0]).toBeCloseTo(h.start[0], 3);
    expect(at[1]).toBeCloseTo(h.start[1], 3);
    expect(state.pendingCardFlights, "the hint is one-shot").toHaveLength(0);
  });

  it("R14c: drives the trail ROOT from the flight's pose, not from the producer's stream", () => {
    // The comet root is the trail scene's transform carrier, so the client owns it for the flight's duration: one
    // write places the whole comet (ribbons, sparks, silhouettes all hang off it) and the producer is free to stop
    // re-sending the root's pose. If this ever goes back to null, the comet is being placed from the wire again.
    // trailRootDrive.spec.ts covers the composition and the counter-pins; this is the end-to-end liveness check.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes()]);
    renderer.reconcile(state);
    const h = hint();
    deliverFlight(state, h);
    renderer.reconcile(state);
    const root = translation(stage, "42")!;
    expect(root, "the comet root is placed by the client").not.toBeNull();
    expect(root[0]).toBeCloseTo(h.start[0], 3);
    expect(root[1]).toBeCloseTo(h.start[1], 3);
    expect(translation(stage, "41"), "the flight node itself IS driven").not.toBeNull();
  });

  it("holds the pose against a reconcile that re-ships the node's FROZEN transform", () => {
    // This is the failure the pin exists to stop: the producer's last streamed transform for this node is its
    // pre-flight one, and any later delta touching the node would repaint it there.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes()]);
    renderer.reconcile(state);
    deliverFlight(state, hint());
    renderer.reconcile(state);
    const flying = translation(stage, "41")!;

    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [{ id: "41", visible: true, transform: xf(0, 0) }]
      })!
    );
    renderer.reconcile(state);
    expect(translation(stage, "41"), "the frozen streamed transform must not win").toEqual(flying);
  });

  it("feeds the synthesized trail from the locally-integrated head", () => {
    // The trail's own head source (its parent's streamed global) is frozen by the producer, so without the flight
    // feeding it the ribbon would never grow past its first point.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes()]);
    renderer.reconcile(state);
    deliverFlight(state, hint());
    renderer.reconcile(state);

    const el = stage.querySelector('[data-node-id="44"]') as HTMLElement | null;
    expect(el, "the trail stroke has an element").not.toBeNull();
    const div = el!.querySelector(".mirror-trail");
    expect(div, "the trail's ribbon layer exists").not.toBeNull();
  });
});

// ---- WIDE SCREEN --------------------------------------------------------------------------------------------
//
// On a widened stage every node is placed on the horizontal squeeze field, and a flying card's own shift is a
// function of ITS OWN game X — so it changes all the way down the flight. The STREAMED sampler was fixed for this
// in R10 WS-F (see noteCardTrailSample: both globals must be the shifted pair). The FLIGHT is the other sampler:
// it writes the card's element through `nodeTransformForGlobal`, which applies the shift, but fed the ribbon the
// raw 1920-space pose — so the comet flew a different path from the card it belongs to.
describe("cardFlight — wide-screen spread (the ribbon rides the card's own shift)", () => {
  const F = 2520 / 1920; // 1.3125 — the widest stretch

  let clock = 0;
  let rafCb: FrameRequestCallback | null = null;
  let timers: { id: number; at: number; cb: () => void }[] = [];
  let nextTimerId = 1;

  beforeEach(() => {
    document.body.innerHTML = "";
    clock = 0;
    rafCb = null;
    timers = [];
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      rafCb = null;
    });
    vi.stubGlobal("setTimeout", (cb: () => void, ms?: number) => {
      const id = nextTimerId++;
      timers.push({ id, at: clock + (ms ?? 0), cb });
      return id;
    });
    vi.stubGlobal("clearTimeout", (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The renderer's animation loop is deadline-scheduled (a setTimeout park, then the rAF that mutates); model both
  // halves against the same fake clock, exactly like mirrorTween.spec's harness.
  function flushRaf(atMs: number): void {
    clock = atMs;
    for (let guard = 0; guard < 8; guard++) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
      if (due.length === 0) {
        break;
      }
      timers = timers.filter((t) => t.at > clock);
      for (const timer of due) {
        timer.cb();
      }
    }
    const cb = rafCb;
    rafCb = null;
    cb?.(atMs);
  }

  // A purely HORIZONTAL flight: the ribbon's normals are then vertical, so every path X IS a sampled head X (the
  // same trick cardTrail.spec's wide-screen leg uses).
  const flat = () => hint({ start: [300, 880], end: [1620, 880], control: [960, 880] });

  function ribbonXs(stage: HTMLElement): number[] {
    const el = stage.querySelector('[data-node-id="44"]') as HTMLElement;
    const path = el.querySelector(".mirror-trail path") as SVGPathElement | null;
    const d = path?.getAttribute("d") ?? null;
    expect(d, "the flight painted a ribbon").not.toBeNull();
    return [...d!.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
  }

  it("feeds the ribbon the card's SHIFTED head (trail head X === the flying card's element X)", () => {
    const { stage, renderer } = harness();
    renderer.setStretch(F);
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes()]);
    renderer.reconcile(state);
    deliverFlight(state, flat());
    renderer.reconcile(state);
    // Six 60Hz frames: the card moves ~20px per frame, i.e. well past the 12px min spawn distance, so the ribbon's
    // head IS the pose the same tick wrote the card's element at (pushCardTrailPoint repaints inline).
    for (let i = 1; i <= 6; i++) {
      flushRaf(i * 16);
    }

    const cardX = translation(stage, "41")![0];
    const xs = ribbonXs(stage);
    expect(cardX, "the card is on the spread field, not at its raw game X").toBeGreaterThan(400);
    // Precision 1 (±0.05px): the ribbon's path data is emitted rounded to 2 decimals, so an exact compare against
    // the element's full-precision matrix would fail on the rounding alone. The defect this guards is ~16px+.
    expect(Math.max(...xs)).toBeCloseTo(cardX, 1);
  });

  it("is byte-identical at 16:9 (every spread dx is 0)", () => {
    const { stage, renderer } = harness();
    renderer.setStretch(1);
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes()]);
    renderer.reconcile(state);
    deliverFlight(state, flat());
    renderer.reconcile(state);
    for (let i = 1; i <= 6; i++) {
      flushRaf(i * 16);
    }

    const cardX = translation(stage, "41")![0];
    expect(Math.max(...ribbonXs(stage))).toBeCloseTo(cardX, 1);
  });
});

// ---- R11: the flight as a COMPOSITOR animation ---------------------------------------------------------------
//
// The integrator above is a per-frame JS callback per flying card; at 30 cards a reshuffle spent 30 × 60 whole
// style-map derivations and transform writes a second on the main thread, and the animation stopped dead whenever
// that thread did. The closed-form solution below is what makes the flight precomputable, and therefore
// hand-off-able to the browser: `Element.animate` with transform-only keyframes runs on the compositor.
//
// jsdom implements NO `Element.animate`, which is deliberately useful here: every renderer test above exercises
// the JS fallback for free, and the WAAPI path is covered by (a) pure-function tests of the maths and (b) the
// renderer suite at the bottom, which installs a recording stub.

describe("cardFlight — the closed form (the thing that makes precomputation possible)", () => {
  // Integrate the shipped stepped integrator at a fine dt: the ground truth both the closed form and the shipped
  // 60Hz path are approximations of.
  function fineTrack(h: MirrorCardFlightHint, dt: number) {
    const state = createCardFlight(h);
    const track: Array<{ t: number; x: number; y: number; rotation: number; scale: number }> = [];
    track.push({ t: 0, ...advanceCardFlight(state, h, 0) });
    let t = 0;
    while (state.phase !== "done" && t < 30) {
      const pose = advanceCardFlight(state, h, dt);
      t += dt;
      track.push({ t, ...pose });
    }
    return track;
  }

  it("predicts the flight's wall-clock duration that a fine integration measures", () => {
    // τ1 = (√(s0²+2aD) − s0)/a, then D/√(s0²+2aD). This number IS the WAAPI animation's `duration`, so an error
    // here is an animation that ends somewhere other than where the stepped integrator would have.
    for (const h of [hint(), hint({ speed0: 1.25, accel: 2.5, duration: 1.75 }), hint({ accel: 0 })]) {
      const timing = cardFlightTiming(h);
      const stepped = fineTrack(h, 1 / 2000).at(-1)!.t;
      expect(timing.totalSeconds).toBeCloseTo(stepped, 2);
    }
  });

  it("matches the stepped integrator's pose at any instant", () => {
    const h = hint();
    const timing = cardFlightTiming(h);
    const fine = fineTrack(h, 1 / 2000);
    let worst = 0;
    for (const sample of fine) {
      if (sample.t > timing.totalSeconds) {
        break;
      }
      const pose = cardFlightPoseAt(h, timing, sample.t, sample.rotation);
      worst = Math.max(worst, Math.hypot(pose.x - sample.x, pose.y - sample.y));
    }
    // The residual is the FINE integration's own half-step lag (the card covers ~2570 px/s, so a 0.5ms grid is
    // ±0.6px), not a disagreement about the curve — at dt→0 the two converge exactly.
    expect(worst).toBeLessThan(1.5);
  });

  it("holds the landing rotation through the pop, exactly like the stepped phase 2", () => {
    const h = hint();
    const timing = cardFlightTiming(h);
    const a = cardFlightPoseAt(h, timing, timing.arcSeconds + 0.01, 0);
    const b = cardFlightPoseAt(h, timing, timing.arcSeconds + timing.popSeconds * 0.9, 0);
    expect(b.rotation).toBe(a.rotation);
    expect(a.x).toBe(h.end[0]);
    expect(a.y).toBe(h.end[1]);
  });

  it("runs the pop scale down to nothing on the same schedule", () => {
    const h = hint();
    const timing = cardFlightTiming(h);
    expect(cardFlightPoseAt(h, timing, timing.arcSeconds, 0).scale).toBeCloseTo(0.1, 9);
    // `max(lerp(0.1,-0.1,progress),0)` reaches 0 at HALF the pop, and phase-2 progress is linear in wall clock.
    expect(cardFlightPoseAt(h, timing, timing.arcSeconds + timing.popSeconds * 0.5, 0).scale).toBeCloseTo(0, 9);
    expect(cardFlightPoseAt(h, timing, timing.totalSeconds, 0).scale).toBe(0);
  });
});

describe("cardFlight — the precomputed keyframes", () => {
  function fineTrack(h: MirrorCardFlightHint, dt: number) {
    const state = createCardFlight(h);
    const track: Array<{ t: number; x: number; y: number }> = [];
    track.push({ t: 0, ...advanceCardFlight(state, h, 0) });
    let t = 0;
    while (state.phase !== "done" && t < 30) {
      const pose = advanceCardFlight(state, h, dt);
      t += dt;
      track.push({ t, x: pose.x, y: pose.y });
    }
    return track;
  }

  it("samples the arc densely enough that the linear interpolant IS the bezier", () => {
    // The browser draws straight lines between keyframes, so the only error the sample rate can introduce is the
    // chord's sagitta. Measured here across a TWO-segment chord (the deviation of the middle sample from the line
    // through its neighbours), which for a locally-circular arc is 4× the per-segment error the animation actually
    // shows: 0.62 here = ~0.16 design px on screen, under a fifth of a device pixel at phone stage scale. The bound
    // is the measured worst case plus headroom — it fails if the sampling ever stops tracking the acceleration.
    const h = hint();
    const built = buildCardFlightPoses(h);
    const arc = built.poses.filter((p) => Math.abs(p.g6[0]) > 0.5 || Math.abs(p.g6[1]) > 0.5);
    for (let i = 2; i < arc.length; i++) {
      const a = arc[i - 2];
      const b = arc[i - 1];
      const c = arc[i];
      // Distance from the middle sample to the chord through its neighbours.
      const ux = c.g6[4] - a.g6[4];
      const uy = c.g6[5] - a.g6[5];
      const len = Math.hypot(ux, uy) || 1;
      const sagitta = Math.abs((b.g6[4] - a.g6[4]) * (uy / len) - (b.g6[5] - a.g6[5]) * (ux / len));
      expect(sagitta).toBeLessThan(0.8);
    }
  });

  it("puts every keyframe on the path the stepped integrator flies", () => {
    const h = hint();
    const built = buildCardFlightPoses(h);
    const fine = fineTrack(h, 1 / 2000);
    for (const kf of built.poses) {
      const t = (kf.offset * built.durationMs) / 1000;
      let nearest = fine[0];
      for (const f of fine) {
        if (Math.abs(f.t - t) < Math.abs(nearest.t - t)) {
          nearest = f;
        }
      }
      expect(Math.hypot(nearest.x - kf.g6[4], nearest.y - kf.g6[5])).toBeLessThan(1.5);
    }
  });

  it("emits WAAPI-legal offsets: 0…1, non-decreasing", () => {
    const built = buildCardFlightPoses(hint());
    expect(built.poses[0].offset).toBe(0);
    expect(built.poses.at(-1)!.offset).toBe(1);
    for (let i = 1; i < built.poses.length; i++) {
      expect(built.poses[i].offset).toBeGreaterThanOrEqual(built.poses[i - 1].offset);
    }
  });

  it("carries the arc→pop SNAP as a zero-length keyframe interval", () => {
    // The pop takes its 0.1 scale outright the frame after the card lands — it does not ramp into it. Two
    // keyframes at the same offset is how WAAPI expresses that step; interpolating scale 1 → 0.1 across a whole
    // segment would turn the pop into a shrink.
    const built = buildCardFlightPoses(hint());
    const duplicated = built.poses.filter((p, i) => i > 0 && p.offset === built.poses[i - 1].offset);
    expect(duplicated).toHaveLength(1);
    const at = built.poses.indexOf(duplicated[0]);
    const before = built.poses[at - 1];
    expect(Math.hypot(before.g6[0], before.g6[1]), "full size on the last arc keyframe").toBeCloseTo(1, 6);
    expect(Math.hypot(duplicated[0].g6[0], duplicated[0].g6[1]), "a tenth on the first pop one").toBeCloseTo(0.1, 6);
  });

  it("starts at the source pile and ends on the target pile", () => {
    const h = hint();
    const built = buildCardFlightPoses(h);
    expect(built.poses[0].g6[4]).toBeCloseTo(h.start[0], 6);
    expect(built.poses[0].g6[5]).toBeCloseTo(h.start[1], 6);
    expect(built.poses.at(-1)!.g6[4]).toBe(h.end[0]);
    expect(built.poses.at(-1)!.g6[5]).toBe(h.end[1]);
  });

  it("never emits a SINGULAR matrix (CSS falls back to discrete interpolation for one)", () => {
    // A zero 2×2 cannot be decomposed, and an undecomposable keyframe pair animates as a hard cut. The vanished
    // card is pinned just off zero instead; the renderer writes the true zero inline when the animation finishes.
    for (const kf of buildCardFlightPoses(hint()).poses) {
      const det = kf.g6[0] * kf.g6[3] - kf.g6[1] * kf.g6[2];
      expect(Math.abs(det)).toBeGreaterThan(0);
    }
  });

  it("costs a bounded burst even when thirty cards arm at once", () => {
    // The whole point is that the work moves from 30 × 60Hz to 30 × once. This is a smoke bound, not a benchmark:
    // it fails only if the sampling ever becomes accidentally quadratic.
    const started = performance.now();
    let poses = 0;
    for (let i = 0; i < 30; i++) {
      poses += buildCardFlightPoses(hint({ duration: 1 + (i % 4) * 0.2 })).poses.length;
    }
    const elapsed = performance.now() - started;
    expect(poses).toBeLessThan(30 * 110); // ~50 samples per flight at the shipped rate
    expect(elapsed).toBeLessThan(200);
  });
});

// ================================================================================================================
// R13 — THE SECOND KIND: the hand→discard flight
// ================================================================================================================
//
// Same curve, same two-phase integrator, same closed-form timing. What changes is what the player is LOOKING at:
// the shuffle's mover is a throwaway silhouette, the discard's is the real card just played — the same element that
// was in the hand a frame ago. So it must turn OUT of its hand angle rather than snapping onto the curve, and it
// shrinks as it goes instead of travelling full-size and popping at the end.
//
// The suites are ordered by what breaks if they fail: the snap (which the eye catches immediately), the turn, the
// two scale channels, the keyframes the browser actually plays, and finally the SHUFFLE regression net — because
// the one unacceptable outcome of this round is the flight that already shipped moving differently.

const discardHint = (overrides: Partial<MirrorCardFlightHint> = {}): MirrorCardFlightHint =>
  hint({ kind: "discard", rot0: 0, ...overrides });

// A dead-straight rightward flight: the tangent is constant, so the angle the card is chasing is a FIXED +PI/2 for
// the whole arc and the chase can be watched in isolation from the curve.
const straightRight = (overrides: Partial<MirrorCardFlightHint> = {}) =>
  discardHint({ start: [0, 500], end: [1000, 500], control: [500, 500], ...overrides });

// The shortest signed arc from `from` to `to`, written out independently of the implementation.
function refShortestDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) {
    d -= Math.PI * 2;
  }
  if (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return d;
}

// The angle a keyframe's 6-tuple renders at, and the scale it renders at, for the identity-basis fixtures here.
const rotationOf = (g6: number[]) => Math.atan2(g6[1], g6[0]);
const scaleOf = (g6: number[]) => Math.hypot(g6[0], g6[1]);

describe("cardFlight — discard: the angle chase (smoothAngleStep)", () => {
  it("returns the current angle UNCHANGED for a zero step, however far the target is", () => {
    // This is the no-snap contract in one line: at dt = 0 the weight is 0, so the first sample of any flight is
    // exactly the pose the card was already resting in.
    expect(smoothAngleStep(-1.2, Math.PI / 2, FLIGHT_ROTATION_SMOOTH_RATE, 0)).toBe(-1.2);
  });

  it("closes a fixed FRACTION of the remaining gap per second of wall clock", () => {
    // 12/s: a 60Hz frame closes 12/60 = 20% of what is left.
    const from = 0;
    const to = 1;
    expect(smoothAngleStep(from, to, FLIGHT_ROTATION_SMOOTH_RATE, 1 / 60)).toBeCloseTo(0.2, 12);
    // …and a frame twice as long closes twice as much of it (not twice as much in total — the weight is what is
    // linear in dt, which is why the constant is documented as frame-rate dependent by design).
    expect(smoothAngleStep(from, to, FLIGHT_ROTATION_SMOOTH_RATE, 2 / 60)).toBeCloseTo(0.4, 12);
  });

  it("clamps the weight at 1 rather than overshooting on a long frame", () => {
    // A backgrounded tab's first frame back carries a huge dt. 12 × 0.5s = 6, and stepping 6× the gap would spin
    // the card the wrong way round several times.
    expect(smoothAngleStep(0, 1, FLIGHT_ROTATION_SMOOTH_RATE, 0.5)).toBe(1);
    expect(smoothAngleStep(0, 1, FLIGHT_ROTATION_SMOOTH_RATE, 30)).toBe(1);
  });

  it("takes the SHORT way round across the ±π seam", () => {
    // A card resting just under +π turning to just over −π is 0.1 rad away, not 6.18. Without the wrap the card
    // visibly spins a full turn on its way to the pile.
    const from = Math.PI - 0.05;
    const to = -Math.PI + 0.05;
    const next = smoothAngleStep(from, to, FLIGHT_ROTATION_SMOOTH_RATE, 1 / 60);
    expect(next, "it turned FORWARD through the seam").toBeGreaterThan(from);
    expect(next - from).toBeCloseTo(0.1 * (FLIGHT_ROTATION_SMOOTH_RATE / 60), 12);
  });
});

describe("cardFlight — discard: no first-frame snap", () => {
  it("seeds the integrator at the hint's rot0", () => {
    expect(createCardFlight(discardHint({ rot0: -1.2 })).rotation).toBe(-1.2);
    expect(createCardFlight(hint({ rot0: -1.2 })).rotation, "a shuffle ignores the seed").toBe(0);
  });

  it("starts at the source anchor and barely moves off rot0 while the tangent is far away", () => {
    const h = straightRight({ rot0: -1.2 });
    const state = createCardFlight(h);
    const first = advanceCardFlight(state, h, 1 / 1000);
    expect(
      Math.hypot(first.x - h.start[0], first.y - h.start[1]),
      "a millisecond in, still on the hand's anchor"
    ).toBeLessThan(2);
    // The gap it is chasing is enormous…
    expect(Math.abs(refShortestDelta(h.rot0, Math.PI / 2)), "…and the target really is far").toBeGreaterThan(2.5);
    // …and the first frame closes only a sliver of it. A tangent ASSIGNMENT (the shuffle's rule) would have put
    // the card at PI/2 here — a visible 2.7-radian snap on the very frame the player's eye is on the card.
    expect(Math.abs(first.rotation - h.rot0)).toBeLessThan(0.05);
  });

  it("puts rot0 EXACTLY on the first keyframe too", () => {
    // The compositor path has to agree with the stepped one about frame 0, or the hand-off itself is the snap.
    const h = straightRight({ rot0: -1.2 });
    expect(rotationOf(buildCardFlightPoses(h).poses[0].g6)).toBeCloseTo(h.rot0, 12);
  });
});

describe("cardFlight — discard: the turn converges on the curve's facing", () => {
  function arcRotations(h: MirrorCardFlightHint, fps = 60): number[] {
    const state = createCardFlight(h);
    const out: number[] = [];
    for (let i = 0; i < 600 && state.phase === "arc"; i++) {
      const pose = advanceCardFlight(state, h, 1 / fps);
      if (state.phase !== "arc") {
        break;
      }
      out.push(pose.rotation);
    }
    return out;
  }

  it("closes monotonically on tangent + π/2 and never overshoots it", () => {
    const h = straightRight({ rot0: -1.2 });
    const target = Math.PI / 2; // a straight rightward flight faces +x, so tangent + π/2 is a constant
    const rotations = arcRotations(h);
    expect(rotations.length, "the arc really ran").toBeGreaterThan(20);
    let gap = Math.abs(refShortestDelta(h.rot0, target));
    let previous = h.rot0;
    for (let i = 0; i < rotations.length; i++) {
      const next = Math.abs(refShortestDelta(rotations[i], target));
      expect(next, `frame ${i} closed the gap`).toBeLessThan(gap);
      expect(rotations[i], `frame ${i} turned one way only`).toBeGreaterThan(previous);
      expect(rotations[i], `frame ${i} did not overshoot`).toBeLessThanOrEqual(target);
      gap = next;
      previous = rotations[i];
    }
    expect(rotations.at(-1), "and it has essentially arrived by the landing").toBeCloseTo(target, 3);
  });

  it("crosses the seam rather than unwinding the long way round", () => {
    // A leftward flight faces −x, i.e. 3π/2 — the same angle as −π/2. From a card resting at 3.0 rad the short arc
    // is +1.71 (forward through π); the naive difference is −4.57, which on screen is the card counter-rotating
    // most of a full turn while it flies.
    const h = discardHint({ start: [1000, 500], end: [0, 500], control: [500, 500], rot0: 3.0 });
    const rotations = arcRotations(h);
    for (const r of rotations) {
      expect(r, "never turned backwards").toBeGreaterThanOrEqual(3.0);
    }
    expect(rotations.at(-1)).toBeCloseTo((3 * Math.PI) / 2, 2);
  });
});

describe("cardFlight — discard: the two scale channels", () => {
  it("shrinks 1 → 0.1 over the FIRST THIRD of the arc's pseudo-time, then holds", () => {
    const d = 1.4;
    expect(discardArcScale(0, d), "full size at the hand").toBe(1);
    expect(discardArcScale(d / 6, d), "half-way through the ramp").toBeCloseTo(0.55, 12);
    expect(discardArcScale(d / DISCARD_RAMP_PSEUDOTIME_FACTOR, d), "done at a third").toBeCloseTo(
      DISCARD_ARC_SCALE_TO,
      12
    );
    // …and HELD from there to the pile: a ramp that ran the whole arc would still be shrinking as it lands, which
    // is a different animation.
    expect(discardArcScale(d * 0.5, d)).toBeCloseTo(DISCARD_ARC_SCALE_TO, 12);
    expect(discardArcScale(d, d)).toBeCloseTo(DISCARD_ARC_SCALE_TO, 12);
  });

  it("runs the pop 0.1 → 0, hitting zero EXACTLY at progress 0.4 and staying", () => {
    expect(discardPopScale(0)).toBeCloseTo(0.1, 12);
    expect(discardPopScale(0.2)).toBeCloseTo(0.05, 12);
    expect(discardPopScale(DISCARD_POP_ZERO_PROGRESS), "gone at 0.4, not 0.5").toBe(0);
    expect(discardPopScale(0.7)).toBe(0);
    expect(discardPopScale(1)).toBe(0);
    // The steeper ramp is the whole difference from the shuffle's, which is still alive at 0.4.
    expect(flightPopScale(DISCARD_POP_ZERO_PROGRESS)).toBeGreaterThan(0);
  });

  it("drives the integrator's scale from those two, arc then pop", () => {
    const h = discardHint();
    const state = createCardFlight(h);
    let arcSamples = 0;
    let popSamples = 0;
    for (let i = 0; i < 600 && state.phase !== "done"; i++) {
      const wasArc = state.phase === "arc";
      const timeBefore = state.time;
      const pose = advanceCardFlight(state, h, 1 / 60);
      if (wasArc && state.phase === "arc") {
        expect(pose.scale).toBeCloseTo(discardArcScale(state.time, h.duration), 12);
        expect(pose.scale, "never larger than the card's own size").toBeLessThanOrEqual(1);
        expect(pose.scale).toBeLessThanOrEqual(discardArcScale(timeBefore, h.duration));
        arcSamples++;
      } else if (state.phase === "pop") {
        expect(pose.scale).toBeCloseTo(discardPopScale(state.time / h.duration), 12);
        popSamples++;
      }
    }
    expect(arcSamples).toBeGreaterThan(20);
    expect(popSamples).toBeGreaterThan(2);
  });

  it("is ABSOLUTE: scale0 does not divide the discard's multipliers (it does divide the shuffle's)", () => {
    // The discard's shrink is a channel of its own multiplying whatever the card was drawn at, so a hint with a
    // different spawn scale must produce the SAME multipliers. Dividing here (the shuffle's rule) would make a
    // card authored at 2× shrink to a twentieth instead of a tenth.
    const unit = discardHint({ scale0: 1 });
    const double = discardHint({ scale0: 2 });
    const a = createCardFlight(unit);
    const b = createCardFlight(double);
    let compared = 0;
    for (let i = 0; i < 600 && a.phase !== "done"; i++) {
      const pa = advanceCardFlight(a, unit, 1 / 60);
      const pb = advanceCardFlight(b, double, 1 / 60);
      expect(pb.scale, `frame ${i}`).toBe(pa.scale);
      compared++;
    }
    expect(compared).toBeGreaterThan(20);

    // The contrast, on the same fixture pair: the shuffle DOES divide, so its pop halves.
    const sUnit = hint({ scale0: 1 });
    const sDouble = hint({ scale0: 2 });
    const sa = createCardFlight(sUnit);
    const sb = createCardFlight(sDouble);
    let popsCompared = 0;
    for (let i = 0; i < 600 && sa.phase !== "done"; i++) {
      const pa = advanceCardFlight(sa, sUnit, 1 / 60);
      const pb = advanceCardFlight(sb, sDouble, 1 / 60);
      if (pa.scale !== 1 && pa.scale > 0) {
        expect(pb.scale).toBeCloseTo(pa.scale / 2, 12);
        popsCompared++;
      }
    }
    expect(popsCompared).toBeGreaterThan(2);
  });
});

describe("cardFlight — discard: the precomputed keyframes", () => {
  function split(h: MirrorCardFlightHint) {
    const timing = cardFlightTiming(h);
    const built = buildCardFlightPoses(h);
    const arcOffset = timing.arcSeconds / timing.totalSeconds;
    return {
      timing,
      built,
      arcOffset,
      arc: built.poses.filter((p) => p.offset < arcOffset),
      pop: built.poses.filter((p) => p.offset >= arcOffset)
    };
  }

  it("varies the scale ACROSS the arc samples (the shuffle's are all full size)", () => {
    const { arc } = split(discardHint());
    const scales = arc.map((p) => scaleOf(p.g6));
    expect(scales[0]).toBeCloseTo(1, 6);
    expect(scales.at(-1)).toBeCloseTo(DISCARD_ARC_SCALE_TO, 6);
    expect(new Set(scales.map((s) => s.toFixed(6))).size, "a real ramp, not two steps").toBeGreaterThan(6);
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i], `sample ${i} never grew`).toBeLessThanOrEqual(scales[i - 1] + 1e-12);
    }
    // The shuffle's arc is flat at 1 — this is the channel that did not exist before.
    for (const p of split(hint()).arc) {
      expect(scaleOf(p.g6)).toBeCloseTo(1, 6);
    }
  });

  it("puts a keyframe EXACTLY on the pop's zero kink", () => {
    // `max(lerp(...), 0)` is two straight segments joined at 0.4. A pair of keyframes straddling the join would cut
    // the corner, leaving the card faintly visible past the moment it should have gone.
    const h = discardHint();
    const { timing, built } = split(h);
    const kink =
      (timing.arcSeconds + timing.popSeconds * DISCARD_POP_ZERO_PROGRESS) / timing.totalSeconds;
    const at = built.poses.filter((p) => p.offset === kink);
    expect(at, "the kink is a keyframe offset, not an interpolated instant").toHaveLength(1);
    expect(scaleOf(at[0].g6), "and the card is gone there").toBeLessThan(1e-3);
    expect(DISCARD_POP_OFFSETS).toContain(DISCARD_POP_ZERO_PROGRESS);
    // One sample either side, so the ramp into the kink is drawn and the hold after it is flat.
    const before = built.poses.filter((p) => p.offset > timing.arcSeconds / timing.totalSeconds && p.offset < kink);
    expect(scaleOf(before.at(-1)!.g6), "half-way down the ramp").toBeCloseTo(0.05, 6);
    expect(built.poses.at(-1)!.offset).toBe(1);
    expect(scaleOf(built.poses.at(-1)!.g6), "…and stays gone").toBeLessThan(1e-3);
  });

  it("emits WAAPI-legal offsets and no singular matrix, exactly like the shuffle", () => {
    const built = buildCardFlightPoses(discardHint());
    expect(built.poses[0].offset).toBe(0);
    expect(built.poses.at(-1)!.offset).toBe(1);
    for (let i = 1; i < built.poses.length; i++) {
      expect(built.poses[i].offset).toBeGreaterThanOrEqual(built.poses[i - 1].offset);
    }
    for (const kf of built.poses) {
      expect(Math.abs(kf.g6[0] * kf.g6[3] - kf.g6[1] * kf.g6[2])).toBeGreaterThan(0);
    }
  });

  it("steps the sequential turn on WALL dt, not on pseudo-time", () => {
    // THE assertion that pins which clock the chase runs on. Two flights over the SAME geometry with the SAME
    // number of arc samples (both hit the 24-sample floor) and the same sample points in pseudo-time — the slow one
    // simply takes ~3× as many seconds to get there. A chase stepped on pseudo-time would produce identical angles;
    // stepped on wall clock the slow flight is further round at every sample.
    const fast = straightRight({ speed0: 3, accel: 2.3, duration: 0.3, rot0: 0 });
    const slow = straightRight({ speed0: 3, accel: 2.3, duration: 1.0, rot0: 0 });
    const fastTiming = cardFlightTiming(fast);
    const slowTiming = cardFlightTiming(slow);
    expect(slowTiming.arcSeconds / fastTiming.arcSeconds, "the slow arc really is slower").toBeGreaterThan(2.5);

    const a = split(fast).arc;
    const b = split(slow).arc;
    expect(a.length, "the same sample COUNT, so this compares like with like").toBe(b.length);
    expect(a.length).toBe(24);
    for (let i = 1; i < a.length; i++) {
      expect(rotationOf(b[i].g6), `sample ${i} turned further on the slower arc`).toBeGreaterThan(
        rotationOf(a[i].g6)
      );
    }
    // Both are chasing the same fixed target and neither passes it.
    expect(rotationOf(b.at(-1)!.g6)).toBeLessThanOrEqual(Math.PI / 2);
  });

  it("lands the keyframed turn where the stepped integrator lands it", () => {
    // The two paths are separate implementations of the same chase (one walks keyframe samples, one walks frames),
    // so this is the equivalence that keeps the two implementations on the same animation. The
    // residual is the two sample GRIDS disagreeing, not the rule.
    const h = straightRight({ rot0: -1.2 });
    const state = createCardFlight(h);
    while (state.phase === "arc") {
      advanceCardFlight(state, h, 1 / 240);
    }
    const { arc } = split(h);
    expect(rotationOf(arc.at(-1)!.g6)).toBeCloseTo(state.rotation, 1);
  });
});

// ---- THE REGRESSION NET: the shuffle's math must not have moved ----------------------------------------------
//
// R13 threaded a `kind` through every pose function. The reference implementations below are the PRE-R13 formulas
// written out from scratch — an independent copy, not a call into the module — and the shipped shuffle path is
// compared against them exactly (`toBe`, not `toBeCloseTo`). If a discard branch ever leaks into the shuffle path
// these fail on the first frame.

describe("cardFlight — the shuffle is byte-identical to the pre-R13 math", () => {
  const LOOK_AHEAD = 0.05;

  function refBezier(h: MirrorCardFlightHint, t: number): [number, number] {
    const omt = 1 - t;
    return [
      omt * omt * h.start[0] + 2 * omt * t * h.control[0] + t * t * h.end[0],
      omt * omt * h.start[1] + 2 * omt * t * h.control[1] + t * t * h.end[1]
    ];
  }

  function refPop(progress: number): number {
    return Math.max(0.1 + (-0.1 - 0.1) * progress, 0);
  }

  // The pre-R13 `advanceCardFlight`, restated.
  function refAdvance(
    state: { phase: string; time: number; speed: number; rotation: number },
    h: MirrorCardFlightHint,
    dtSeconds: number
  ) {
    const dt = Math.max(0, Math.min(dtSeconds, FLIGHT_MAX_STEP_SECONDS));
    if (state.phase === "arc") {
      state.time += state.speed * dt;
      state.speed += h.accel * dt;
      const progress = state.time / h.duration;
      if (progress <= 1) {
        const here = refBezier(h, progress);
        const ahead = refBezier(h, (state.time + LOOK_AHEAD) / h.duration);
        const dx = ahead[0] - here[0];
        const dy = ahead[1] - here[1];
        if (dx !== 0 || dy !== 0) {
          state.rotation = Math.atan2(dy, dx) + Math.PI / 2;
        }
        return { x: here[0], y: here[1], rotation: state.rotation, scale: 1 };
      }
      state.phase = "pop";
      state.time = 0;
    }
    if (state.phase === "pop") {
      state.time += state.speed * dt;
      const progress = state.time / h.duration;
      if (progress > 1) {
        state.phase = "done";
      } else {
        return {
          x: h.end[0],
          y: h.end[1],
          rotation: state.rotation,
          scale: refPop(progress) / h.scale0
        };
      }
    }
    return { x: h.end[0], y: h.end[1], rotation: state.rotation, scale: 0 };
  }

  // The pre-R13 `cardFlightPoseAt`, restated.
  function refPoseAt(h: MirrorCardFlightHint, timing: ReturnType<typeof cardFlightTiming>, t: number, prev: number) {
    if (t < timing.arcSeconds) {
      const time = h.speed0 * t + (h.accel * t * t) / 2;
      const here = refBezier(h, time / h.duration);
      const ahead = refBezier(h, (time + LOOK_AHEAD) / h.duration);
      const dx = ahead[0] - here[0];
      const dy = ahead[1] - here[1];
      const rotation = dx !== 0 || dy !== 0 ? Math.atan2(dy, dx) + Math.PI / 2 : prev;
      return { x: here[0], y: here[1], rotation, scale: 1 };
    }
    const end = refBezier(h, 1);
    const ahead = refBezier(h, (h.duration + LOOK_AHEAD) / h.duration);
    const dx = ahead[0] - end[0];
    const dy = ahead[1] - end[1];
    const rotation = dx !== 0 || dy !== 0 ? Math.atan2(dy, dx) + Math.PI / 2 : prev;
    const progress = ((t - timing.arcSeconds) * timing.speedAtLanding) / h.duration;
    return {
      x: h.end[0],
      y: h.end[1],
      rotation,
      scale: progress > 1 ? 0 : refPop(progress) / h.scale0
    };
  }

  const fixtures = [
    hint(),
    hint({ speed0: 1.25, accel: 2.5, duration: 1.75 }),
    hint({ accel: 0 }),
    hint({ scale0: 0.5, basis: [2, 0, 0, -3] }),
    hint({ start: [1620, 200], end: [300, 940], control: [400, 1200] }),
    // The two new fields at their non-default values, on a SHUFFLE hint: an unrecognised kind normalizes to
    // "shuffle" but may still carry a rot0, and that must change nothing at all.
    hint({ rot0: -1.2 })
  ];

  it("steps every fixture identically, frame for frame, through both phases", () => {
    for (const [n, h] of fixtures.entries()) {
      const mine: CardFlightState = createCardFlight(h);
      const ref = { phase: "arc", time: 0, speed: h.speed0, rotation: 0 };
      for (let i = 0; i < 400 && ref.phase !== "done"; i++) {
        const a = advanceCardFlight(mine, h, 1 / 60);
        const b = refAdvance(ref, h, 1 / 60);
        expect(a, `fixture ${n} frame ${i}`).toEqual(b);
        expect(mine.phase, `fixture ${n} frame ${i} phase`).toBe(ref.phase);
        expect(mine.time).toBe(ref.time);
        expect(mine.speed).toBe(ref.speed);
      }
      expect(ref.phase, `fixture ${n} completed`).toBe("done");
    }
  });

  it("samples the closed form identically at every instant of every fixture", () => {
    for (const [n, h] of fixtures.entries()) {
      const timing = cardFlightTiming(h);
      let prev = 0;
      for (let i = 0; i <= 200; i++) {
        const t = (timing.totalSeconds * i) / 200;
        const a = cardFlightPoseAt(h, timing, t, prev);
        const b = refPoseAt(h, timing, t, prev);
        expect(a, `fixture ${n} at t=${t}`).toEqual(b);
        prev = a.rotation;
      }
    }
  });

  it("builds the same keyframe list it built before", () => {
    // The builder gained a kind branch; the shuffle branch must still walk memorylessly off `cardFlightPoseAt`.
    const POP_OFFSETS = [0, 0.25, 0.5, 0.75, 1];
    for (const [n, h] of fixtures.entries()) {
      const timing = cardFlightTiming(h);
      const total = timing.totalSeconds;
      const arcSamples = Math.min(96, Math.max(24, Math.ceil((timing.arcSeconds * 1000) / 16)));
      const expected: Array<{ offset: number; g6: number[] }> = [];
      let rotation = 0;
      for (let i = 0; i < arcSamples; i++) {
        const time = (h.duration * i) / arcSamples;
        const t =
          h.accel > 0
            ? (Math.sqrt(h.speed0 * h.speed0 + 2 * h.accel * time) - h.speed0) / h.accel
            : time / h.speed0;
        const pose = refPoseAt(h, timing, t, rotation);
        rotation = pose.rotation;
        expected.push({ offset: t / total, g6: cardFlightGlobal6(h.basis, pose, pose.scale) });
      }
      const landing = refPoseAt(h, timing, timing.arcSeconds, rotation);
      rotation = landing.rotation;
      expected.push({
        offset: timing.arcSeconds / total,
        g6: cardFlightGlobal6(h.basis, { x: h.end[0], y: h.end[1], rotation, scale: 1 }, 1)
      });
      for (const f of POP_OFFSETS) {
        const t = timing.arcSeconds + timing.popSeconds * f;
        const pose = refPoseAt(h, timing, Math.min(t, total), rotation);
        expected.push({
          offset: Math.min(1, t / total),
          g6: cardFlightGlobal6(h.basis, pose, Math.max(pose.scale, 1e-4))
        });
      }
      expect(buildCardFlightPoses(h).poses, `fixture ${n}`).toEqual(expected);
    }
  });
});

// ---- the renderer's WAAPI branch, against a recording stub ---------------------------------------------------

interface FakeAnimation {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  currentTime: number;
  cancelled: number;
  onfinish: (() => void) | null;
  cancel(): void;
}

describe("cardFlight — renderer hands the flight to the compositor", () => {
  let clock = 0;
  let rafCb: FrameRequestCallback | null = null;
  let timers: { id: number; at: number; cb: () => void }[] = [];
  let nextTimerId = 1;
  let animations: FakeAnimation[] = [];
  const realAnimate = (Element.prototype as unknown as { animate?: unknown }).animate;

  function installAnimate(): void {
    (Element.prototype as unknown as { animate: unknown }).animate = function (
      keyframes: Keyframe[],
      options: KeyframeAnimationOptions
    ) {
      const anim: FakeAnimation = {
        keyframes: [...keyframes],
        options,
        currentTime: 0,
        cancelled: 0,
        onfinish: null,
        cancel() {
          this.cancelled++;
        }
      };
      animations.push(anim);
      return anim;
    };
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    clock = 0;
    rafCb = null;
    timers = [];
    animations = [];
    installAnimate();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      rafCb = null;
    });
    vi.stubGlobal("setTimeout", (cb: () => void, ms?: number) => {
      const id = nextTimerId++;
      timers.push({ id, at: clock + (ms ?? 0), cb });
      return id;
    });
    vi.stubGlobal("clearTimeout", (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    });
  });

  afterEach(() => {
    if (realAnimate === undefined) {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    } else {
      (Element.prototype as unknown as { animate: unknown }).animate = realAnimate;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function flushRaf(atMs: number): void {
    clock = atMs;
    for (let guard = 0; guard < 8; guard++) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
      if (due.length === 0) {
        break;
      }
      timers = timers.filter((t) => t.at > clock);
      for (const timer of due) {
        timer.cb();
      }
    }
    const cb = rafCb;
    rafCb = null;
    cb?.(atMs);
  }

  function arm(h = hint()): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes()]);
    renderer.reconcile(state);
    deliverFlight(state, h);
    renderer.reconcile(state);
    return { stage, renderer, state };
  }

  it("registers ONE transform animation per flight, linear, filling forwards", () => {
    const h = hint();
    arm(h);
    expect(animations).toHaveLength(1);
    const anim = animations[0];
    expect(anim.options.easing, "the keyframes already carry the flight's own timing").toBe("linear");
    expect(anim.options.fill).toBe("forwards");
    // The closed-form wall clock, in ms.
    expect(Number(anim.options.duration)).toBeCloseTo(cardFlightTiming(h).totalSeconds * 1000, 3);
    expect(anim.keyframes.length).toBeGreaterThan(24);
    for (const frame of anim.keyframes) {
      expect(String(frame.transform)).toMatch(/^matrix\(/);
    }
  });

  it("writes NO per-frame transform once the animation owns the element", () => {
    // The whole point: 30 cards × 60Hz of `nodeStyle` + `el.style.transform` becomes zero. The element keeps the
    // START pose inline (see the pin note in startFlightCssAnimation) while the compositor plays the keyframes.
    const { stage } = arm();
    const at0 = stage.querySelector('[data-node-id="41"]')!.getAttribute("style");
    for (let i = 1; i <= 12; i++) {
      flushRaf(i * 16);
    }
    expect(stage.querySelector('[data-node-id="41"]')!.getAttribute("style")).toBe(at0);
  });

  it("still places the card at the flight's START, so an un-applied animation fails visibly rather than invisibly", () => {
    const h = hint();
    const { stage } = arm(h);
    const at = translation(stage, "41")!;
    expect(at[0]).toBeCloseTo(h.start[0], 3);
    expect(at[1]).toBeCloseTo(h.start[1], 3);
  });

  it("keeps feeding the trail from the same closed form", () => {
    const flat = hint({ start: [300, 880], end: [1620, 880], control: [960, 880] });
    const { stage } = arm(flat);
    for (let i = 1; i <= 8; i++) {
      flushRaf(i * 16);
    }
    const path = stage.querySelector('[data-node-id="44"] .mirror-trail path') as SVGPathElement;
    const d = path.getAttribute("d");
    expect(d, "the comet grew while the compositor flew the card").not.toBeNull();
    const xs = [...d!.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
    expect(Math.max(...xs)).toBeGreaterThan(flat.start[0]);
  });

  it("lands the card and cancels the animation in ONE callback", () => {
    const h = hint();
    const { stage } = arm(h);
    animations[0].onfinish!();
    const at = translation(stage, "41")!;
    expect(at[0]).toBeCloseTo(h.end[0], 3);
    expect(at[1]).toBeCloseTo(h.end[1], 3);
    const el = stage.querySelector('[data-node-id="41"]') as HTMLElement;
    // The landed pose is a scale of exactly 0 — the keyframes stop just short of it so every pair stays
    // decomposable, and the inline write is what puts the true zero on the element.
    expect(el.style.transform).toMatch(/^matrix\(0, ?0, ?0, ?0,/);
    expect(animations[0].cancelled).toBe(1);
  });

  it("cancels a still-running animation when the flight is retired", () => {
    // A `fill: forwards` effect outlives its flight if nobody stops it, and would then override this node's
    // streamed transform for the life of the document.
    const { state, renderer } = arm();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [],
        removedIds: ["41"],
        orderedIds: ["Game", "42", "43", "44"]
      })!
    );
    renderer.reconcile(state);
    expect(animations[0].cancelled).toBeGreaterThan(0);
  });

  it("re-bakes (preserving where it is) when the stage resizes mid-flight", () => {
    const { renderer } = arm();
    animations[0].currentTime = 320;
    flushRaf(320);
    expect(animations).toHaveLength(1);
    renderer.setStretch(2520 / 1920);
    flushRaf(336);
    expect(animations, "a new animation on the widened field").toHaveLength(2);
    expect(animations[0].cancelled).toBe(1);
    expect(animations[1].currentTime).toBe(320);
  });

});
