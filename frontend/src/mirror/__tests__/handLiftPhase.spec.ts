// THE TWO CHANNELS A HAND CARD IS DRAWN BY, AND WHETHER THEY START TOGETHER — on both stages, over time.
//
// A holder's drawn y is the SUM of two channels: the streamed/tweened POSE, and the readable-hand LIFT the mode
// composes on top of it (a CSS `translate` on the DOM, a cosmetic offset on the canvas). The lift is a function of
// the pose — `handRaiseDy` of the ramp — so the two are conjugate, and the pair is only coherent while they agree
// about which pose they are describing.
//
// THE DEFECT. One producer delta can carry a streamed STEP of an un-focus AND the tween hint for the rest of the
// journey home. Both stages paint that step at once and then ease the remainder; both gave the lift the tween's
// own duration and easing. Neither gave it the tween's own START: the lift left the value conjugate to the pose
// BEFORE the step, so one frame of new pose composed with an old lift drew the card `step − (journey − lift)` PAST
// the place it was heading for, and the error decayed over the tween's window. Live H10 measured it on the DOM at
// 9.4 design px, 1 focus change in 8, and the DOM was fixed on 2026-09-19 (`noteTransformArmPose`); this file is
// where the canvas twin was measured, and it was worse — 24.4 px on this fixture, on every un-focus rather than
// one in eight, because the canvas ramp re-derives the lift every frame and had no notion of a start at all.
//
// HOW EACH STAGE IS READ, and why it differs. The canvas rebuilds its picture every frame, so `handPoses().mDrawn`
// IS the drawn composition and can simply be sampled frame by frame. The DOM hands both channels to the compositor
// and jsdom runs no transitions, so its element carries the ENDPOINT from the first frame — the values a browser
// would interpolate between survive only in the ORDER of the writes (`styleChannels.ts`). So the canvas is checked
// over the whole glide and the DOM is held to the same two endpoints of the blend: the drawn y each stage LEAVES
// and the one it ARRIVES at. Those are what parity means here — the curve between them is one shared easing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatHandPoseReport, type HandPoseSample } from "@/mirror/handPoseProbe";
import { HAND_RAISE_PX, HAND_RAISE_RAMP_END_Y, HAND_RAISE_RAMP_START_Y } from "@/mirror/raise/constants";
import { handRaiseDy } from "@/mirror/raise/handRaisePlan";
import { applySceneDelta, parseSceneDelta } from "@/mirror/sceneTree";

import {
  applyKeyframe,
  createMirrorState,
  holderId,
  holderSpec,
  installHandStage,
  orderFor,
  positionHint,
  slot,
  update,
  CARD_SPREAD_PX,
  type HandStage,
  type MirrorState
} from "./handStageHarness";
import { channelOf, watchStyle } from "./styleChannels";

const HAND = 5;
const FOCUSED = 2;
const DURATION = 400;

/** The hand container's own y — every local pose below is drawn this far down. */
const CONTAINER_Y = 1080;

/**
 * The live step, to the pixel: the producer had already moved the card 49.4 px of its journey home when it shipped
 * the tween for the rest (a 159 px journey there, 144 px here — the ramp's own span).
 */
const STEP_PX = 49.4;
const STEPPED_LOCAL_Y = HAND_RAISE_RAMP_END_Y + STEP_PX;

/** Where the card is drawn while focused: the game's own pose, lift 0 (the ramp is 1 at the focused y). */
const FOCUSED_DRAWN_Y = CONTAINER_Y + HAND_RAISE_RAMP_END_Y;
/** …and where it is heading: the resting fan, raised by the full lift. */
const DESTINATION_Y = CONTAINER_Y + HAND_RAISE_RAMP_START_Y - HAND_RAISE_PX;

/** The pose the game TELEPORTS a focused holder to: upright, at the ramp's focused height. */
function poseAt(i: number, n: number, y: number): number[] {
  const centred = i - (n - 1) / 2;
  return [1, 0, 0, 1, centred * CARD_SPREAD_PX, y];
}

/** The game's own "something is being aimed" signal, and the gate that holds the whole lift at 0 while it shows. */
const TARGETING_ARROW = {
  id: "targeting-arrow",
  parentId: "root",
  name: "TargetingArrow",
  nodeType: "MegaCrit.Sts2.Core.Nodes.Combat.NTargetingArrow"
};

const EPS = 1e-9;

describe("hand lift phase — the lift channel starts where the pose channel starts", () => {
  let stage: HandStage;

  beforeEach(() => {
    stage = installHandStage();
  });

  afterEach(() => {
    stage.teardown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A five-card hand with `FOCUSED` teleported to the focused pose, on one arm, pumped to rest. */
  function focusedHand(backend: "canvas" | "dom"): { arm: ReturnType<HandStage["makeArm"]>; state: MirrorState } {
    const arm = stage.makeArm(backend, 1, true);
    const state = createMirrorState();
    applyKeyframe(state, HAND);
    arm.renderer.reconcile(state);
    stage.pump();
    update(state, [holderSpec(FOCUSED, "container", poseAt(FOCUSED, HAND, HAND_RAISE_RAMP_END_Y), { zIndex: 1 })]);
    arm.renderer.reconcile(state);
    stage.pump();
    return { arm, state };
  }

  /**
   * THE UN-FOCUS, as the producer sends it: the pose the game has ALREADY moved the card to, and in the same delta
   * the tween that covers the rest of the way home. `steppedY` null ⇒ the pose is suppressed outright (the
   * re-describe with no pose, which the producer really does send), so nothing on this frame says where the card
   * is being drawn.
   */
  function unfocus(state: MirrorState, steppedY: number | null): void {
    update(
      state,
      [holderSpec(FOCUSED, "container", steppedY === null ? null : poseAt(FOCUSED, HAND, steppedY), { zIndex: 0 })],
      [positionHint(holderId(FOCUSED), slot(FOCUSED, HAND), DURATION)]
    );
  }

  function holderOf(arm: ReturnType<HandStage["makeArm"]>): HandPoseSample {
    const report = arm.poses();
    const found = report.holders.find((h) => h.id === holderId(FOCUSED));
    if (!found) throw new Error(`no holder row\n${formatHandPoseReport(report)}`);
    return found;
  }

  /**
   * Every drawn y the canvas stage paints for the un-focusing card, starting with THE ARM FRAME ITSELF — the
   * reconcile that carries the step and the hint is also a build, so the first sample is the picture that delta
   * produced, before any clock has run. That frame is the one the defect lived on.
   */
  function canvasGlide(steppedY: number | null): { y: number; dy: number }[] {
    const { arm, state } = focusedHand("canvas");
    expect(holderOf(arm).mDrawn[5]).toBeCloseTo(FOCUSED_DRAWN_Y, 6);
    expect(holderOf(arm).raiseDy).toBe(0);

    unfocus(state, steppedY);
    arm.renderer.reconcile(state);
    const trace: { y: number; dy: number }[] = [];
    for (let t = 0; t <= DURATION + 64; t += 16) {
      const holder = holderOf(arm);
      trace.push({ y: holder.mDrawn[5], dy: holder.raiseDy });
      stage.pump();
    }
    return trace;
  }

  /** The verdict, per frame: one straight move from the focused pose into the raised fan, and no further. */
  function expectNoExcursion(trace: { y: number; dy: number }[], from: number): void {
    const readable = trace.map((s, i) => `${i}: y=${s.y.toFixed(2)} dy=${s.dy}`).join("\n");
    let previous = from;
    for (const [i, sample] of trace.entries()) {
      expect(sample.y, `frame ${i} was drawn PAST the pose it is heading for\n${readable}`).toBeLessThanOrEqual(
        DESTINATION_Y + EPS
      );
      expect(sample.y, `frame ${i} reversed — the card went back up\n${readable}`).toBeGreaterThanOrEqual(
        previous - EPS
      );
      previous = sample.y;
    }
    expect(trace[trace.length - 1].y, `the glide never arrived\n${readable}`).toBeCloseTo(DESTINATION_Y, 6);
  }

  it("canvas: a card losing focus is never drawn past the pose it is heading for", () => {
    // The number the defect is worth on this fixture, stated so the gate cannot pass by measuring nothing: with the
    // lift left at its focused 0 for the arm frame, the drawn y IS the stepped pose — 24.4 px below the raised
    // resting place the card is on its way to.
    expect(CONTAINER_Y + STEPPED_LOCAL_Y - DESTINATION_Y).toBeCloseTo(24.4, 6);

    const trace = canvasGlide(STEPPED_LOCAL_Y);
    expectNoExcursion(trace, FOCUSED_DRAWN_Y);
    // …and the reason it does not: the arm frame leaves the lift conjugate to the pose the ease leaves, which is
    // the whole fix as one number.
    expect(trace[0].dy).toBe(handRaiseDy(HAND_RAISE_PX, STEPPED_LOCAL_Y));
    expect(trace[0].y).toBeCloseTo(CONTAINER_Y + STEPPED_LOCAL_Y + trace[0].dy, 6);
  });

  it("canvas: a SUPPRESSED pose leaves the LIFT alone rather than guessing the resting fan", () => {
    // The other half of the pose read's contract, and this case pins the LIFT CHANNEL ONLY: a holder that arrives
    // with no pose at all has no drawn position worth asserting (the canvas composes it against its parent alone
    // for that frame), which is exactly why the read must refuse to answer for it. `holderPaintedLocalY` answers
    // null here, where the ramp read answers the resting fan because it has to produce a destination for every
    // raisable card. Seeding the lift off that guess would jump this card's lift STRAIGHT to the full 119 px —
    // the ramp's from and to would be the same number, so there would be no glide at all, just a snap.
    const trace = canvasGlide(null);
    const readable = trace.map((s, i) => `${i}: dy=${s.dy}`).join("\n");
    expect(trace[0].dy, `the lift jumped on a frame that said nothing about the pose\n${readable}`).toBe(0);
    let previous = 0;
    for (const sample of trace) {
      expect(sample.dy, `the lift reversed\n${readable}`).toBeLessThanOrEqual(previous + EPS);
      previous = sample.dy;
    }
    // …and it still arrives, on the tween's own curve, at the raised resting lift.
    expect(trace[trace.length - 1].dy, readable).toBe(-HAND_RAISE_PX);
  });

  it("canvas: a card whose pose arms on a GATE-RELEASE frame still glides with the rest of the hand", () => {
    // THE SCOPE OF THE PHASE FIX, pinned. A lift is only put in phase with a pose when it is RIDING that pose's
    // own tween; the mode's own glide (a gate letting go — targeting ending, a drag released, the mode switched
    // on) is a motion of the lift ALONE, over a pose that is not moving, and it must still start from the lift the
    // hand already had. The DOM draws exactly this line (`handRaiseTransition` answers null on a lift change, so
    // its start-value write is skipped and the stylesheet's 160 ms glide runs), and the canvas has to draw it in
    // the same place: seeding here would make a card whose tween happened to arm on the release frame jump
    // straight to the full lift while its four neighbours glide — one card out of a fan of five.
    const arm = stage.makeArm("canvas", 1, true);
    const state = createMirrorState();
    applyKeyframe(state, HAND);
    // A visible targeting arrow holds the whole lift at 0 (the game is aiming something).
    update(state, [TARGETING_ARROW], undefined, [...orderFor(HAND, null), TARGETING_ARROW.id]);
    arm.renderer.reconcile(state);
    stage.pump();
    expect(arm.poses().holders.map((h) => h.raiseDy)).toEqual(Array.from({ length: HAND }, () => 0));

    // ONE delta: the arrow goes away (the gate releases, so the whole hand starts its 160 ms glide up) and one
    // holder is handed a tween in the same breath.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "combat",
        upserts: [],
        removedIds: [TARGETING_ARROW.id],
        orderedIds: orderFor(HAND, null),
        hints: [positionHint(holderId(1), slot(1, HAND), DURATION)]
      })!
    );
    arm.renderer.reconcile(state);

    for (let t = 0; t <= 192; t += 16) {
      const dys = arm.poses().holders.map((h) => h.raiseDy);
      const readable = `t=${t}: ${arm.poses().holders.map((h) => `${h.id}=${h.raiseDy}`).join(", ")}`;
      expect(new Set(dys).size, `the hinted card left the fan's glide\n${readable}`).toBe(1);
      if (t === 0) expect(dys[0], `the glide did not start from the gated lift\n${readable}`).toBe(0);
      stage.pump();
    }
    expect(arm.poses().holders.map((h) => h.raiseDy)).toEqual(Array.from({ length: HAND }, () => -HAND_RAISE_PX));
  });

  it("both stages leave — and reach — the same drawn y across the same un-focus", () => {
    const canvas = canvasGlide(STEPPED_LOCAL_Y);

    const { arm, state } = focusedHand("dom");
    const el = arm.stage.querySelector<HTMLElement>(`[data-node-id="${holderId(FOCUSED)}"]`);
    expect(el, "the DOM arm drew no element for the holder").not.toBeNull();
    const timeline = watchStyle(el!);
    unfocus(state, STEPPED_LOCAL_Y);
    arm.renderer.reconcile(state);
    const states = timeline();
    const pose = channelOf(states, "transform");
    const lift = channelOf(states, "translate");

    // The two DOM channels run one curve, so the drawn y between the endpoints is their straight blend — asserted,
    // not assumed, because the comparison below only reads the ends of it.
    expect(pose.ms).toBe(DURATION);
    expect(lift.ms).toBe(pose.ms);
    expect(lift.ease).toBe(pose.ease);
    // …and the pose channel really does leave the pose the producer stepped to, which is what makes the sum below
    // the drawn position rather than an arithmetic coincidence.
    expect(pose.from).toBeCloseTo(STEPPED_LOCAL_Y, 6);
    expect(pose.to).toBeCloseTo(HAND_RAISE_RAMP_START_Y, 6);

    // THE PARITY CLAIM. Both stages leave the same drawn y…
    expect(CONTAINER_Y + pose.from + lift.from).toBeCloseTo(canvas[0].y, 6);
    expect(lift.from).toBe(canvas[0].dy);
    // …and both arrive at the same one.
    expect(CONTAINER_Y + pose.to + lift.to).toBeCloseTo(DESTINATION_Y, 6);
    expect(canvas[canvas.length - 1].y).toBeCloseTo(DESTINATION_Y, 6);
  });
});
