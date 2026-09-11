// WHERE A HAND CARD ENDS UP — the same three gestures, played through BOTH backends, scored against the game.
//
// THE REPORT THIS EXISTS FOR. On the canvas stage with the wide-screen stretch on, the client-side replay of the
// hand's motion ends somewhere other than where the game has the card, so the card SNAPS when the motion stops:
// focusing a card does not push its neighbours to the right places, selecting one does not re-lay-out the rest as
// a hand with one card fewer, and cancelling a selection lands neither the returning card nor the others.
//
// WHY IT IS A SPEC AND NOT A PROBE. The canvas backend's existing spread test builds a synthetic holder — a
// boxless node with an override on it — and asserts the rebase arithmetic. That is the algebra, and it passed
// while the live stage was wrong, because the fixture was not the wire's hand. The chain this file drives is the
// real one (see `handStageHarness.handNodes`), with the shapes taken off a recording rather than invented.
//
// WHAT IS SCORED, and why it is the game and not the other stage. A tween hint opens a SUPPRESSION WINDOW: for as
// long as the client is replaying, the producer ships no transform for that node, so at the moment the replay ends
// the streamed pose is still the pre-tween one. The contradiction arrives one frame later, when the window closes
// and the game states its own pose — and on screen THAT is the jump. So each scenario is played in three beats:
//
//   1. the hints land (and the producer goes quiet about those nodes);
//   2. the clock runs past the tween, both backends settle, and the drawn pose is recorded;
//   3. the producer's settle re-emit arrives with the game's own poses.
//
// and the assertions are: the drawn pose did not MOVE across beat 3 (no snap), and where it settled IS where the
// game says the card is, taken through the same wide-screen field (no drift). Cross-stage agreement is asserted
// too, but only after both — two arms that agree can both be wrong, which is the whole reason this file measures
// against the producer instead.
//
// The gestures here are IDEALISED (one batch, one duration, round numbers). `handLandingRepro.spec.ts` plays the
// same rig against the raw batches out of a player's recording, which is where the double-arms and the declared
// starts are.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HAND_RAISE_RAMP_END_Y } from "@/mirror/mirrorRenderer";
import { landingDrift, crossStageDrift, formatHandPoseReport, type HandPoseReport } from "@/mirror/handPoseProbe";
import type { SpreadAuditReport } from "@/mirror/canvas/spreadAudit";
import {
  classifyLanding,
  endpointFieldResidual,
  formatLandingLog,
  scoredLandings,
  worstLanding,
  type LandingLogReport
} from "@/mirror/landingLog";
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
  DESIGN_W,
  type HandStage,
  type MirrorState,
  type NodeSpec,
  type StageBackend
} from "./handStageHarness";

// The widest stage the mirror ever draws (2520 design px at 20:9), and the one every wide-screen defect in this
// area has been reported at. `1` is carried alongside it in every case so the 16:9 arm proves the feature inert.
const F_WIDE = 2520 / DESIGN_W;

/** The pose the game TELEPORTS a focused holder to: upright, unscaled-ish, at the ramp's focused height. */
function focusedSlot(i: number, n: number): number[] {
  const centred = i - (n - 1) / 2;
  return [1, 0, 0, 1, centred * CARD_SPREAD_PX, HAND_RAISE_RAMP_END_Y];
}

describe("hand landing — one gesture, two backends, scored against the game", () => {
  let stage: HandStage;

  beforeEach(() => {
    stage = installHandStage();
  });

  afterEach(() => {
    stage.teardown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Play one gesture on one backend and report the three beats. `mutate` applies the delta that starts the motion
   * (poses the game teleports + hints for what it tweens); `settle` applies the producer's re-emit once the
   * suppression window closes.
   */
  function play(
    backend: StageBackend,
    spreadFactor: number,
    raise: boolean,
    build: (state: MirrorState) => void,
    mutate: (state: MirrorState) => void,
    settle: (state: MirrorState) => void,
    durationMs: number
  ): { atSettle: HandPoseReport; afterReEmit: HandPoseReport; landings: LandingLogReport } {
    const arm = stage.makeArm(backend, spreadFactor, raise);
    const state = createMirrorState();
    build(state);
    arm.renderer.reconcile(state);
    stage.pump();

    // BEAT 1 — the gesture. The game teleports what it teleports and hints what it tweens; from here it says
    // nothing about the hinted nodes at all.
    mutate(state);
    arm.renderer.reconcile(state);
    stage.pump();

    // BEAT 2 — the replay runs out. FRAME BY FRAME, not in one jump: both backends sample their channels on
    // whatever frames actually run, and the canvas's cosmetic-offset RAMP (the readable-hand lift) is integrated
    // over them. A single 300ms leap would hand every evaluator one perfect sample at t=end and hide any
    // frame-rate-dependent term either of them carries.
    for (let t = 0; t <= durationMs + 32; t += 16) {
      stage.pump();
    }
    const atSettle = arm.poses();

    // BEAT 3 — the producer's own word arrives.
    settle(state);
    arm.renderer.reconcile(state);
    stage.pump();
    const afterReEmit = arm.poses();
    return { atSettle, afterReEmit, landings: arm.landings() };
  }

  /**
   * THE PREDICTION VERDICT — where the backend DECIDED to send each card, against where the card finished.
   *
   * Distinct from `scoreLanding` above in the one way that matters: that pair of numbers is read after the
   * producer's re-emit has been adopted, and adopting it is what makes "drawn == game" true, so a client that eased
   * to the wrong place and was rescued by the re-emit passes it. This reads the decision itself. See
   * `landingLog.ts`, and the round note in `docs/agents/`.
   */
  function expectPredicted(label: string, landings: LandingLogReport, spreadFactor: number): void {
    expect(landings.rows.length, `${label}: no hand tween was armed at all — the gate would be vacuous`).toBeGreaterThan(
      0
    );
    for (const row of landings.rows) {
      // THE FIELD CLAIM, on every row including the unscored ones: "is the endpoint on the wide-screen squeeze
      // field where the field rule puts it" needs no settle to answer, and it is the arithmetic the report is about.
      const residual = endpointFieldResidual(row, spreadFactor);
      if (residual !== null) {
        expect(
          Math.abs(residual),
          `${label}: ${row.name}'s ENDPOINT got a wide-screen shift the field rule does not produce\n` +
            formatLandingLog([row], spreadFactor)
        ).toBeLessThan(EPS_PX);
      }
    }
    const worst = worstLanding(scoredLandings(landings.rows, spreadFactor));
    if (worst !== null) {
      expect(
        worst.distPx,
        `${label}: ${worst.name} was sent to a place it did not end up — cause ` +
          `"${classifyLanding(worst, spreadFactor)}"\n${formatLandingLog(landings.rows, spreadFactor)}`
      ).toBeLessThan(EPS_PX);
    }
  }

  /** The two verdicts, per holder: did it MOVE when the game spoke, and did it land where the game has it? */
  function scoreLanding(
    label: string,
    atSettle: HandPoseReport,
    afterReEmit: HandPoseReport
  ): { snapPx: number; driftPx: number; worst: string } {
    let snapPx = 0;
    let driftPx = 0;
    let worst = "";
    for (const settled of atSettle.holders) {
      const after = afterReEmit.holders.find((h) => h.id === settled.id);
      if (!after) continue;
      const snap = crossStageDrift(settled, after).distPx;
      const drift = landingDrift(after, afterReEmit.spreadFactor).distPx;
      if (snap > snapPx) {
        snapPx = snap;
        worst = `${label}/${settled.id}: snap ${snap.toFixed(2)}px`;
      }
      if (drift > driftPx) {
        driftPx = drift;
        if (drift > snapPx) worst = `${label}/${settled.id}: drift ${drift.toFixed(2)}px`;
      }
    }
    return { snapPx, driftPx, worst };
  }

  // --- the three gestures ------------------------------------------------------------------------------------
  //
  // Each is expressed once and played on both backends, so the two arms cannot be given different gestures.

  const HAND = 5;
  const FOCUSED = 2;
  const DURATION = 300;

  it.each(["dom", "canvas"] as StageBackend[])("publishes focused-holder z-order through the shared hand-pose seam (%s)", (backend) => {
    const arm = stage.makeArm(backend, 1, true);
    const state = createMirrorState();
    applyKeyframe(state, HAND);
    arm.renderer.reconcile(state);
    stage.pump();

    update(state, [holderSpec(FOCUSED, "container", focusedSlot(FOCUSED, HAND), { zIndex: 1 })]);
    arm.renderer.reconcile(state);
    stage.pump();

    const focused = arm.poses().holders.find((holder) => holder.id === holderId(FOCUSED));
    expect(focused?.zIndex).toBe(1);
    expect(arm.poses().holders.filter((holder) => holder.id !== holderId(FOCUSED)).every((holder) => holder.zIndex === 0)).toBe(true);
  });

  it.each(["dom", "canvas"] as StageBackend[])("publishes NCard content identity instead of the pooled holder name (%s)", (backend) => {
    const arm = stage.makeArm(backend, 1, true);
    const state = createMirrorState();
    applyKeyframe(state, HAND);
    arm.renderer.reconcile(state);
    stage.pump();

    const holders = arm.poses().holders;
    expect(holders.map((holder) => holder.name)).toEqual(
      Array.from({ length: HAND }, (_, i) => `${holderId(i)}-CARD_STRIKE`)
    );
    expect(holders.map((holder) => holder.cardContentKey)).toEqual(
      Array.from({ length: HAND }, (_, i) => `nc:DEFEND_IRONCLAD#${i + 1}`)
    );
  });

  /** FOCUS — the game teleports the focused holder and tweens its neighbours apart to make room. */
  function focusGesture(state: MirrorState): void {
    const hints: unknown[] = [];
    const upserts: NodeSpec[] = [];
    for (let i = 0; i < HAND; i++) {
      if (i === FOCUSED) {
        // A focus is a TELEPORT: the game assigns the pose and streams it (never a hint).
        upserts.push(holderSpec(i, "container", focusedSlot(i, HAND)));
      } else {
        // …and the neighbours are pushed outward, which IS hinted.
        const pushed = slot(i, HAND);
        pushed[4] += i < FOCUSED ? -60 : 60;
        hints.push(positionHint(holderId(i), pushed, DURATION));
      }
    }
    update(state, upserts, hints);
  }

  function focusSettle(state: MirrorState): void {
    const upserts: NodeSpec[] = [];
    for (let i = 0; i < HAND; i++) {
      if (i === FOCUSED) continue;
      const pushed = slot(i, HAND);
      pushed[4] += i < FOCUSED ? -60 : 60;
      upserts.push(holderSpec(i, "container", pushed));
    }
    update(state, upserts);
  }

  /** SELECT — the chosen holder is reparented onto the hand ROOT and parked; the rest re-lay-out as a 4-card fan. */
  function selectGesture(state: MirrorState): void {
    const hints: unknown[] = [];
    const upserts: NodeSpec[] = [holderSpec(FOCUSED, "hand", [1, 0, 0, 1, DESIGN_W / 2, 620])];
    let slotIndex = 0;
    for (let i = 0; i < HAND; i++) {
      if (i === FOCUSED) continue;
      hints.push(positionHint(holderId(i), slot(slotIndex, HAND - 1), DURATION));
      slotIndex++;
    }
    update(state, upserts, hints, orderFor(HAND, FOCUSED));
  }

  function selectSettle(state: MirrorState): void {
    const upserts: NodeSpec[] = [];
    let slotIndex = 0;
    for (let i = 0; i < HAND; i++) {
      if (i === FOCUSED) continue;
      upserts.push(holderSpec(i, "container", slot(slotIndex, HAND - 1)));
      slotIndex++;
    }
    update(state, upserts);
  }

  /** RETURN — the selection is cancelled: the card comes home and the whole 5-card fan is tweened back. */
  function returnGesture(state: MirrorState): void {
    const hints: unknown[] = [];
    // The reparent lands FIRST (the game puts the card back in the container), and the tween that carries it
    // there is hinted in the same batch — the case that made the DOM path read endpoints at all.
    const upserts: NodeSpec[] = [holderSpec(FOCUSED, "container", slot(FOCUSED, HAND))];
    for (let i = 0; i < HAND; i++) {
      if (i === FOCUSED) continue;
      hints.push(positionHint(holderId(i), slot(i, HAND), DURATION));
    }
    update(state, upserts, hints, orderFor(HAND, null));
  }

  function returnSettle(state: MirrorState): void {
    const upserts: NodeSpec[] = [];
    for (let i = 0; i < HAND; i++) {
      if (i === FOCUSED) continue;
      upserts.push(holderSpec(i, "container", slot(i, HAND)));
    }
    update(state, upserts);
  }

  const GESTURES: Array<{
    name: string;
    build: (state: MirrorState) => void;
    mutate: (state: MirrorState) => void;
    settle: (state: MirrorState) => void;
  }> = [
    {
      name: "focus",
      build: (s) => applyKeyframe(s, HAND),
      mutate: focusGesture,
      settle: focusSettle
    },
    {
      name: "select",
      build: (s) => applyKeyframe(s, HAND),
      mutate: selectGesture,
      settle: selectSettle
    },
    {
      name: "return",
      build: (s) => {
        applyKeyframe(s, HAND);
        selectGesture(s);
        selectSettle(s);
      },
      mutate: returnGesture,
      settle: returnSettle
    }
  ];

  // Sub-pixel. Both backends compute in design-space doubles and the raise rounds its own channel to whole px, so
  // anything above this is a real disagreement about where the card goes, not float noise.
  const EPS_PX = 0.5;

  for (const spreadFactor of [1, F_WIDE]) {
    const at = spreadFactor === 1 ? "16:9" : "2520 wide";
    for (const raise of [false, true]) {
      const mode = `${at}, raise ${raise ? "on" : "off"}`;
      for (const gesture of GESTURES) {
        it(`${gesture.name}: the canvas stage lands where the game has the card (${mode})`, () => {
          const { atSettle, afterReEmit } = play(
            "canvas",
            spreadFactor,
            raise,
            gesture.build,
            gesture.mutate,
            gesture.settle,
            DURATION
          );
          expect(atSettle.holders.length, formatHandPoseReport(atSettle)).toBe(HAND);
          // With the mode off nothing may claim a lift — the assumption `landingDrift` leans on when it subtracts
          // one out, made explicit rather than trusted.
          if (!raise) {
            expect(atSettle.holders.every((h) => h.raiseDy === 0)).toBe(true);
          }
          const score = scoreLanding("canvas", atSettle, afterReEmit);
          expect(
            score.snapPx,
            `canvas ${gesture.name} @${mode} SNAPPED when the game spoke\n${score.worst}\n` +
              `at settle:\n${formatHandPoseReport(atSettle)}\nafter re-emit:\n${formatHandPoseReport(afterReEmit)}`
          ).toBeLessThan(EPS_PX);
          expect(
            score.driftPx,
            `canvas ${gesture.name} @${mode} landed away from the game's pose\n${score.worst}\n` +
              `after re-emit:\n${formatHandPoseReport(afterReEmit)}`
          ).toBeLessThan(EPS_PX);
        });

        it(`${gesture.name}: the DOM stage lands where the game has the card (${mode})`, () => {
          const { atSettle, afterReEmit } = play(
            "dom",
            spreadFactor,
            raise,
            gesture.build,
            gesture.mutate,
            gesture.settle,
            DURATION
          );
          expect(atSettle.holders.length, formatHandPoseReport(atSettle)).toBe(HAND);
          const score = scoreLanding("dom", atSettle, afterReEmit);
          expect(
            score.snapPx,
            `dom ${gesture.name} @${mode} SNAPPED when the game spoke\n${score.worst}\n` +
              `at settle:\n${formatHandPoseReport(atSettle)}\nafter re-emit:\n${formatHandPoseReport(afterReEmit)}`
          ).toBeLessThan(EPS_PX);
          expect(
            score.driftPx,
            `dom ${gesture.name} @${mode} landed away from the game's pose\n${score.worst}\n` +
              `after re-emit:\n${formatHandPoseReport(afterReEmit)}`
          ).toBeLessThan(EPS_PX);
        });

        for (const backend of ["canvas", "dom"] as StageBackend[]) {
          it(`${gesture.name}: every landing the ${backend} stage PREDICTED is the one it got (${mode})`, () => {
            const { landings } = play(
              backend,
              spreadFactor,
              raise,
              gesture.build,
              gesture.mutate,
              gesture.settle,
              DURATION
            );
            expectPredicted(`${backend} ${gesture.name} @${mode}`, landings, spreadFactor);
          });
        }

        if (spreadFactor !== 1) {
          it(`${gesture.name}: MID-FLIGHT, every claimed node is drawn on its own field (${mode})`, () => {
            // THE ASSERTION THE OTHER SEVEN CANNOT MAKE. Every gate above reads the HOLDER — a zero-size
            // positioner that paints nothing — and reads it once the motion is over. The Aug-29 defect lived in
            // the holder's painted DESCENDANTS (`handNodes` grows a self-claiming `CardFx/Portrait` chain for
            // exactly this) and only while the producer was silent, so it was invisible to all of them.
            //
            // `?spreadAudit=1` asks the build itself, of every node, on the frame it is drawn: is the wide-screen
            // shift you applied the one the field rule gives at the pose you drew it at? Sampled MID-WINDOW,
            // because after the settle the walk re-derives everything and the answer is right by construction.
            window.history.replaceState({}, "", "?spreadAudit=1");
            try {
              const arm = stage.makeArm("canvas", spreadFactor, raise);
              const state = createMirrorState();
              gesture.build(state);
              arm.renderer.reconcile(state);
              stage.pump();
              gesture.mutate(state);
              arm.renderer.reconcile(state);
              // A third of the way into the window: the cards are in the air and the producer has said nothing.
              for (let t = 0; t <= DURATION / 3; t += 16) {
                stage.pump();
              }
              const read = (window as unknown as { __mirrorSpreadAudit?: () => SpreadAuditReport })
                .__mirrorSpreadAudit;
              expect(read, "the audit lever built no seam").toBeTypeOf("function");
              const audit = read!();
              expect(audit.checked, `${gesture.name} @${mode}: the audit examined nothing`).toBeGreaterThan(0);
              expect(
                audit.moved,
                `${gesture.name} @${mode}: nothing was in flight, so the audit proved nothing\n${audit.text}`
              ).toBeGreaterThan(0);
              expect(
                audit.rows.filter((r) => r.reason === "drawn-pose").length,
                `${gesture.name} @${mode}: a node was drawn through a field claim measured somewhere else\n${audit.text}`
              ).toBe(0);
            } finally {
              window.history.replaceState({}, "", "/");
            }
          });
        }

        it(`${gesture.name}: the two stages draw the same hand (${mode})`, () => {
          const canvas = play("canvas", spreadFactor, raise, gesture.build, gesture.mutate, gesture.settle, DURATION);
          const dom = play("dom", spreadFactor, raise, gesture.build, gesture.mutate, gesture.settle, DURATION);
          for (const c of canvas.afterReEmit.holders) {
            const d = dom.afterReEmit.holders.find((h) => h.id === c.id);
            expect(d, `no DOM row for ${c.id}`).toBeDefined();
            expect(
              crossStageDrift(c, d!).distPx,
              `${gesture.name} @${mode} — the stages disagree about ${c.id}\n` +
                `${formatHandPoseReport(canvas.afterReEmit)}\n${formatHandPoseReport(dom.afterReEmit)}`
            ).toBeLessThan(EPS_PX);
            // …and about the LIFT itself, which is the other half of a drawn hand card. `landingDrift` subtracts
            // it out (it is a deliberate cosmetic offset the input side inverts exactly), so without this row a
            // backend could lift a card by the wrong amount and still score a perfect landing.
            expect(
              c.raiseDy,
              `${gesture.name} @${mode} — the stages lift ${c.id} differently\n` +
                `${formatHandPoseReport(canvas.afterReEmit)}\n${formatHandPoseReport(dom.afterReEmit)}`
            ).toBeCloseTo(d!.raiseDy, 6);
          }
        });
      }
    }
  }
});
