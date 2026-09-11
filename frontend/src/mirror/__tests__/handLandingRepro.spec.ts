// THE PLAYER'S OWN GESTURES, REPLAYED OFFLINE — the hand batches out of a phone recording, on both backends.
//
// `handLanding.spec.ts` plays IDEALISED gestures: one hint batch, one duration, round endpoints. Everything in it
// passed on both stages while the reported defect was live on a phone, which means the idealisation dropped
// whatever the defect is made of. This file drops the idealisation instead: every beat below is transcribed from
// `.sts2/repro/repro-2026-08-28T17-51-50-883Z.ndjson` — a 20:9 Android session on `?stage=canvas` at design width
// 2401 with the wide-screen stretch, tap-to-focus, confirm-tap and the readable-hand raise all on — and the
// timings are the recording's own.
//
// WHAT THE RECORDING HAS THAT AN INVENTED FIXTURE DOES NOT. Every one of the reported cases turns out to be a
// DOUBLE ARM: the game hints a layout, and then 58-81ms later — while an Expo/Out curve is already past half its
// distance — hints a DIFFERENT layout for the same cards. Around that:
//
//   * a REPARENT between the hand root and the card-holder container, sent as a full static re-describe, which is
//     a named upsert and therefore replaces the retained node rather than merging into it;
//   * …and on two of the three, that re-describe carries NO TRANSFORM AT ALL. For one tick the node's pose is
//     null, mid-gesture, with a hint already armed on it;
//   * a DECLARED START on the focused card's hint (`startTransform`), which is what makes a batch "primed";
//   * per-card durations that all differ (502-661ms), so the batch does not end at one moment;
//   * the producer's settle re-emit arriving in two or three deltas, tens of ms apart, rather than in one.
//
// THE VERDICTS ARE THE SAME TWO, so a result here is comparable with the file next door: the drawn pose may not
// MOVE when the producer's re-emit lands (no snap), and where it settles must be where the game says the card is,
// taken through the wide-screen field (no drift). Both are measured through `window.__mirrorHandPoses()`, which
// both backends install, and the field term in `landingDrift` is RE-DERIVED rather than read back off the sample.
//
// The numbers are poses and durations off the wire — no game code, no internals; the same class of fact as the
// resource paths the fixture chain already names.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { landingDrift, crossStageDrift, formatHandPoseReport, type HandPoseReport } from "@/mirror/handPoseProbe";
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
  update,
  DESIGN_W,
  type HandStage,
  type NodeSpec,
  type StageBackend
} from "./handStageHarness";

// The phone's own stage: 2401 design px (a 20:9 viewport, 777x349 at dpr 3.49). Deliberately not the round 2520
// the other file uses — the report is from this width, and an off-round factor is where an arithmetic that only
// works at the cap would show.
const F_PHONE = 2401 / DESIGN_W;

// --- the transcript ------------------------------------------------------------------------------------------

interface Upsert {
  /** Holder index (0-based, in the recording's own order). */
  i: number;
  parent: "container" | "hand";
  /** The pose, or null for a re-describe that carried none. */
  m: readonly number[] | null;
  z?: number;
  /** A full static re-describe (named ⇒ replaces the retained node), as the producer sends on a re-attach. */
  redescribe?: boolean;
}

interface Hint {
  i: number;
  dur: number;
  end: readonly number[];
  /** The producer's `startTransform` — present only on the focused card's hint in the drag-return batch. */
  start?: readonly number[];
}

interface Beat {
  /** ms on the recording's clock. */
  t: number;
  up?: Upsert[];
  hints?: Hint[];
  /** Send the draw order (the recording's `orderPatch`): required on any beat that moves a node in the tree. */
  order?: { count: number; parked: number | null };
}

interface Scenario {
  name: string;
  /** How many holders the hand has in this stretch of the recording. */
  hand: number;
  /** The resting layout the beats start from, and where the out-of-fan card (if any) is parked. */
  seed: { poses: Array<{ i: number; parent: "container" | "hand"; m: readonly number[] }>; parked: number | null };
  beats: Beat[];
  /** The recorded settle poses, keyed by holder — what the game says once every window has closed. */
  endsAt: number;
  /**
   * From this beat on, the named holder has nothing left to predict and must draw what the producer streams: its
   * drawn pose is scored against the game's ON EVERY BEAT, not only at rest. Set where a gesture takes a card out
   * of the fan mid-tween — the case where a landing that is right in the end is still half a second of wrong.
   *
   * ONE holder, not the whole hand: its neighbours are legitimately mid-tween on those beats, and a client that
   * drew them at the game's (frozen, suppressed) pose would not be predicting at all.
   */
  followsGame?: { fromBeat: number; holder: number };
}

// 5-card fan, even (the layout a hand rests in with nothing focused).
const FAN5 = {
  0: [0.7922, -0.1113, 0.1113, 0.7922, -340, 10],
  1: [0.7981, -0.0558, 0.0558, 0.7981, -170, -30],
  2: [0.8, 0, 0, 0.8, 0, -50],
  3: [0.7981, 0.0558, -0.0558, 0.7981, 170, -30],
  4: [0.7922, 0.1113, -0.1113, 0.7922, 340, 10]
} as const;

// …the same hand with card 4 out of the fan: four cards, evenly re-laid.
const FAN4 = {
  0: [0.7922, -0.1113, 0.1113, 0.7922, -240, -25],
  1: [0.7981, -0.0558, 0.0558, 0.7981, -80, -50],
  2: [0.7981, 0.0558, -0.0558, 0.7981, 80, -50],
  3: [0.7922, 0.1113, -0.1113, 0.7922, 240, -25]
} as const;

// …and with one of THOSE four out of the fan: three cards.
const FAN3 = {
  0: [0.7989, -0.0419, 0.0419, 0.7989, -180, -50],
  2: [0.8, 0, 0, 0.8, 0, -59],
  3: [0.7989, 0.0419, -0.0419, 0.7989, 180, -50]
} as const;

/**
 * DRAG-RETURN (t=12.93→13.74s). A card that was dragged out of the fan is released and comes home.
 *
 * The shape: three streamed drag poses under the hand ROOT, then a re-attach into the container WITH NO POSE plus
 * a five-hint batch for the even 5-card fan, then 61ms later a five-hint batch for the FOCUS layout (neighbours
 * pushed) in which the returning card's hint carries a declared start and its pose finally arrives — and the two
 * batches disagree about where three of the five cards are going.
 */
const DRAG_RETURN: Scenario = {
  name: "drag-return",
  hand: 5,
  seed: {
    parked: 4,
    poses: [
      { i: 0, parent: "container", m: FAN4[0] },
      { i: 1, parent: "container", m: FAN4[1] },
      { i: 2, parent: "container", m: FAN4[2] },
      { i: 3, parent: "container", m: FAN4[3] },
      { i: 4, parent: "hand", m: [1, 0, 0, 1, 1443.4738, 907.235] }
    ]
  },
  beats: [
    { t: 12934, up: [{ i: 4, parent: "hand", m: [1, 0, 0, 1, 1443.4738, 907.235] }] },
    { t: 12953, up: [{ i: 4, parent: "hand", m: [1, 0, 0, 1, 1431.9556, 944.03] }] },
    { t: 12992, up: [{ i: 4, parent: "hand", m: [1, 0, 0, 1, 1427.324, 959.0598] }] },
    {
      t: 13106,
      // The re-attach: a named re-describe with NO transform. The node's pose is null for the next 61ms.
      up: [{ i: 4, parent: "container", m: null, redescribe: true }],
      order: { count: 5, parked: null },
      hints: [
        { i: 4, dur: 661, end: FAN5[4] },
        { i: 0, dur: 609, end: FAN5[0] },
        { i: 1, dur: 591, end: FAN5[1] },
        { i: 2, dur: 572, end: FAN5[2] },
        { i: 3, dur: 554, end: FAN5[3] }
      ]
    },
    {
      t: 13167,
      up: [{ i: 4, parent: "container", m: [1, 0, 0, 1, 407.3254, -209], z: 1 }],
      order: { count: 5, parked: null },
      hints: [
        { i: 0, dur: 576, end: [0.7922, -0.1113, 0.1113, 0.7922, -340, 10] },
        { i: 1, dur: 597, end: [0.7981, -0.0558, 0.0558, 0.7981, -195, -30] },
        { i: 2, dur: 617, end: [0.8, 0, 0, 0.8, -50, -50] },
        { i: 3, dur: 636, end: [0.7981, 0.0558, -0.0558, 0.7981, 95, -30] },
        // The returning card: upright, at the focus height, and told where to start from.
        { i: 4, dur: 582, end: [1, 0, 0, 1, 340, -209], start: [1, 0, 0, 1, 416.2175, -209] }
      ]
    },
    // The producer's settle re-emit — in three deltas, ~50ms apart, exactly as recorded.
    {
      t: 13642,
      up: [
        { i: 0, parent: "container", m: [0.7922, -0.1113, 0.1113, 0.7922, -340, 10] },
        { i: 4, parent: "container", m: [1, 0, 0, 1, 340, -209], z: 1 }
      ]
    },
    {
      t: 13694,
      up: [
        { i: 1, parent: "container", m: [0.7981, -0.0558, 0.0558, 0.7981, -195, -30] },
        { i: 2, parent: "container", m: [0.8, 0, 0, 0.8, -50, -50] }
      ]
    },
    { t: 13739, up: [{ i: 3, parent: "container", m: [0.7981, 0.0558, -0.0558, 0.7981, 95, -30] }] }
  ],
  endsAt: 13739
};

/**
 * SELECT (t=38.09→38.83s). A tap focuses a card and, 58ms later, the same gesture picks it up.
 *
 * The shape: a focus batch (the card teleports to the focus height, its neighbours are hinted to the "gap"
 * layout), immediately superseded by a select batch — the card is re-described onto the hand ROOT and the three
 * that remain are hinted to a real 3-card fan. This is the user's case 2: "selecting a card, the others don't
 * move where they should with one card fewer". The first batch's endpoints are never reached and never should be.
 */
const SELECT: Scenario = {
  name: "select",
  hand: 4,
  seed: {
    parked: null,
    poses: [
      { i: 0, parent: "container", m: FAN4[0] },
      { i: 1, parent: "container", m: FAN4[1] },
      { i: 2, parent: "container", m: FAN4[2] },
      { i: 3, parent: "container", m: FAN4[3] }
    ]
  },
  beats: [
    {
      t: 38092,
      up: [{ i: 1, parent: "container", m: [1, 0, 0, 1, -80, -209], z: 1 }],
      order: { count: 4, parked: null },
      hints: [
        { i: 0, dur: 556, end: [0.7922, -0.1113, 0.1113, 0.7922, -315, -25] },
        { i: 2, dur: 556, end: [0.7981, 0.0558, -0.0558, 0.7981, 155, -50] },
        { i: 3, dur: 502, end: [0.7922, 0.1113, -0.1113, 0.7922, 290, -25] }
      ]
    },
    {
      t: 38150,
      // Onto the hand ROOT — a widening 0/1 frame, which is a DIFFERENT wide-screen field branch from the
      // centred container the card just left.
      up: [{ i: 1, parent: "hand", m: [1, 0, 0, 1, 867.2127, 916.092], redescribe: true }],
      order: { count: 4, parked: 1 },
      hints: [
        { i: 0, dur: 600, end: FAN3[0] },
        { i: 2, dur: 622, end: FAN3[2] },
        { i: 3, dur: 584, end: FAN3[3] }
      ]
    },
    // The held card keeps streaming (it is not tweened — the player's finger owns it), shrinking toward the
    // held-card scale as it goes.
    { t: 38205, up: [{ i: 1, parent: "hand", m: [0.914, 0, 0, 0.914, 893.7899, 924.2479] }] },
    { t: 38293, up: [{ i: 1, parent: "hand", m: [0.844, 0, 0, 0.844, 919.1552, 923.2909] }] },
    { t: 38379, up: [{ i: 1, parent: "hand", m: [0.803, 0, 0, 0.803, 935.1323, 922.6882] }] },
    { t: 38461, up: [{ i: 1, parent: "hand", m: [0.7695, 0, 0, 0.7695, 949.5642, 922.1437] }] },
    { t: 38530, up: [{ i: 1, parent: "hand", m: [0.761, 0, 0, 0.761, 953.6461, 921.9897] }] },
    { t: 38602, up: [{ i: 1, parent: "hand", m: [0.7554, 0, 0, 0.7554, 956.5828, 921.8789] }] },
    { t: 38678, up: [{ i: 1, parent: "hand", m: [0.753, 0, 0, 0.753, 957.9195, 921.8285] }] },
    { t: 38738, up: [{ i: 1, parent: "hand", m: [0.75, 0, 0, 0.75, 958.7333, 921.7978] }] },
    {
      t: 38825,
      up: [
        { i: 3, parent: "container", m: FAN3[3] },
        { i: 1, parent: "hand", m: [0.75, 0, 0, 0.75, 960, 921.75] },
        { i: 0, parent: "container", m: FAN3[0] },
        { i: 2, parent: "container", m: FAN3[2] }
      ]
    }
  ],
  endsAt: 38825
};

/**
 * RETURN (t=42.13→42.74s). The held card is not played: it goes back into the fan.
 *
 * The shape: ONE batch, but the returning card is re-described into the container WITH NO POSE while its own hint
 * is armed in the same delta — so the client is asked to replay a card from a pose it does not have, under a
 * parent it has just moved to. This is the user's case 3.
 */
const RETURN: Scenario = {
  name: "return",
  hand: 4,
  seed: {
    parked: 1,
    poses: [
      { i: 0, parent: "container", m: FAN3[0] },
      { i: 1, parent: "hand", m: [0.75, 0, 0, 0.75, 960, 921.75] },
      { i: 2, parent: "container", m: FAN3[2] },
      { i: 3, parent: "container", m: FAN3[3] }
    ]
  },
  beats: [
    {
      t: 42131,
      up: [{ i: 1, parent: "container", m: null, redescribe: true }],
      order: { count: 4, parked: null },
      hints: [
        { i: 1, dur: 625, end: FAN4[1] },
        { i: 0, dur: 544, end: FAN4[0] },
        { i: 2, dur: 572, end: FAN4[2] },
        { i: 3, dur: 544, end: FAN4[3] }
      ]
    },
    {
      t: 42741,
      up: [
        { i: 0, parent: "container", m: FAN4[0] },
        { i: 1, parent: "container", m: FAN4[1] },
        { i: 2, parent: "container", m: FAN4[2] },
        { i: 3, parent: "container", m: FAN4[3] }
      ]
    }
  ],
  endsAt: 42741
};

/**
 * SELECT MID-TWEEN — the card is taken out of the fan while a tween is still carrying it.
 *
 * Transcribed from a LIVE trace rather than from the phone file: `.sts2/artifacts/touch-harness/
 * report-1787948069857.json`, canvas stage, 2400 wide, where H11 caught a 165.94px jump —
 *
 *     t=21226  a transform channel goes live; the game has the card at the focus height
 *     t=21484  the card leaves the fan (re-parented onto the hand ROOT) and the game streams its new,
 *              much lower pose — while the client keeps replaying toward the focus endpoint
 *     t=21753  the client draws (1200,871); the game says (922,1030). 159px apart, and holding
 *     t=22019  the channel's clock runs out and the card SNAPS 165.94px onto the game's pose
 *
 * WHY IT IS A REAL DEFECT AND NOT A LATE SETTLE. Both backends already refuse a hint whose target has MOVED HOUSE
 * before the arm, for a reason that does not stop being true a frame later: in `"local"` space an endpoint is
 * parent-relative, so it is only meaningful in the parent it was authored under, and the space is GONE once the
 * node is re-parented. Applying the refusal only at arm time leaves the window between the arm and the reparent
 * unguarded, and a card selected out of the hand is exactly that window.
 *
 * `beat 1` is the reparent; from there the card is out of the fan and the game streams every pose for it, so the
 * client has nothing left to predict and must draw what it is told.
 */
const SELECT_MID_TWEEN: Scenario = {
  name: "select-mid-tween",
  hand: 4,
  followsGame: { fromBeat: 1, holder: 2 },
  seed: {
    parked: null,
    poses: [
      { i: 0, parent: "container", m: FAN4[0] },
      { i: 1, parent: "container", m: FAN4[1] },
      { i: 2, parent: "container", m: FAN4[2] },
      { i: 3, parent: "container", m: FAN4[3] }
    ]
  },
  beats: [
    {
      t: 0,
      hints: [
        // The focused card, on its way UP to the focus height — the long channel the select then interrupts.
        { i: 2, dur: 800, end: [1, 0, 0, 1, 80, -209] },
        { i: 0, dur: 556, end: [0.7922, -0.1113, 0.1113, 0.7922, -315, -25] },
        { i: 1, dur: 556, end: [0.7981, -0.0558, 0.0558, 0.7981, -195, -50] },
        { i: 3, dur: 502, end: [0.7922, 0.1113, -0.1113, 0.7922, 290, -25] }
      ]
    },
    {
      // 258ms in — the click lands, the card moves house, and the game starts streaming its parked pose.
      t: 258,
      up: [{ i: 2, parent: "hand", m: [1, 0, 0, 1, 960, 1030], redescribe: true }],
      order: { count: 4, parked: 2 }
    },
    { t: 520, up: [{ i: 2, parent: "hand", m: [1, 0, 0, 1, 960, 1030] }] },
    { t: 780, up: [{ i: 2, parent: "hand", m: [1, 0, 0, 1, 960, 1030] }] },
    {
      t: 1040,
      up: [
        { i: 0, parent: "container", m: FAN3[0] },
        { i: 1, parent: "container", m: FAN3[2] },
        { i: 2, parent: "hand", m: [1, 0, 0, 1, 960, 1030] },
        { i: 3, parent: "container", m: FAN3[3] }
      ]
    }
  ],
  endsAt: 1040
};

const SCENARIOS = [DRAG_RETURN, SELECT, RETURN, SELECT_MID_TWEEN];

// --- driving it ----------------------------------------------------------------------------------------------

function specFor(u: Upsert): NodeSpec {
  return holderSpec(u.i, u.parent === "container" ? "container" : "hand", u.m, {
    ...(u.z == null ? {} : { zIndex: u.z }),
    volatile: !u.redescribe
  });
}

describe("hand landing — the recorded gestures, two backends, scored against the game", () => {
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
   * Play one transcript on one backend at the recording's own timestamps.
   *
   * FRAMES BETWEEN BEATS ARE REAL FRAMES. The clock is stepped 16ms at a time between deltas rather than jumped
   * to each one, because both backends sample their channels on the frames that actually run: a rig that only
   * ticked on delta boundaries would give each replay one perfect sample at exactly the moment the next batch
   * arrived, and the double-arm cases are precisely about what is on screen BETWEEN those two moments.
   */
  function play(
    scenario: Scenario,
    backend: StageBackend,
    raise: boolean
  ): {
    beforeSettle: HandPoseReport;
    atRest: HandPoseReport;
    mid: HandPoseReport[];
    landings: LandingLogReport;
  } {
    const arm = stage.makeArm(backend, F_PHONE, raise);
    const state = createMirrorState();
    applyKeyframe(state, scenario.hand);
    update(
      state,
      scenario.seed.poses.map((p) => specFor({ i: p.i, parent: p.parent, m: p.m, redescribe: true })),
      undefined,
      orderFor(scenario.hand, scenario.seed.parked)
    );
    arm.renderer.reconcile(state);

    const start = scenario.beats[0].t;
    stage.pumpTo(start - 100);
    arm.renderer.reconcile(state);
    stage.pump();

    // The last beat is the producer's final settle word; everything before it is the gesture. `beforeSettle` is
    // the frame just before that word lands — the pose a snap would be measured from.
    const settleBeat = scenario.beats[scenario.beats.length - 1];
    const mid: HandPoseReport[] = [];
    let beforeSettle: HandPoseReport | null = null;

    for (const beat of scenario.beats) {
      while (stage.now() + 16 <= beat.t) {
        stage.pump();
        arm.renderer.reconcile(state);
      }
      stage.pumpTo(beat.t);
      if (beat === settleBeat) {
        beforeSettle = arm.poses();
      }
      if (beat.up || beat.hints) {
        update(
          state,
          (beat.up ?? []).map(specFor),
          beat.hints?.map((h) =>
            positionHint(holderId(h.i), h.end, h.dur, h.start)
          ),
          beat.order ? orderFor(beat.order.count, beat.order.parked) : undefined
        );
      }
      arm.renderer.reconcile(state);
      stage.pump();
      mid.push(arm.poses());
    }

    // Run out every remaining window (the longest recorded duration is 661ms) plus a margin, one frame at a time.
    for (let t = 0; t <= 900; t += 16) {
      stage.pump();
      arm.renderer.reconcile(state);
    }
    return { beforeSettle: beforeSettle ?? arm.poses(), atRest: arm.poses(), mid, landings: arm.landings() };
  }

  /** Where the game has each card once its window has closed, vs where the client draws it. */
  function worstDrift(report: HandPoseReport): { px: number; who: string } {
    let px = 0;
    let who = "";
    for (const h of report.holders) {
      const d = landingDrift(h, report.spreadFactor).distPx;
      if (d > px) {
        px = d;
        who = `${h.id} drift ${d.toFixed(2)}px`;
      }
    }
    return { px, who };
  }

  /**
   * How far a card MOVED when the producer's settle word landed — the snap the report is about.
   *
   * A holder the GAME itself moved across that boundary is excluded, because a card that is genuinely somewhere
   * new is supposed to be drawn somewhere new: the held card in the select transcript is still following the
   * player's finger while the fan settles, and scoring its last 1.3px of real travel as a snap would make this
   * spec fail on a correct client. (The live harness's H11 draws the same distinction, for the same reason.)
   */
  function worstSnap(before: HandPoseReport, after: HandPoseReport): { px: number; who: string } {
    let px = 0;
    let who = "";
    for (const b of before.holders) {
      const a = after.holders.find((h) => h.id === b.id);
      if (!a) continue;
      if (Math.hypot(a.mGame[4] - b.mGame[4], a.mGame[5] - b.mGame[5]) > 0.01) continue;
      const d = crossStageDrift(b, a).distPx;
      if (d > px) {
        px = d;
        who = `${b.id} moved ${d.toFixed(2)}px when the game spoke`;
      }
    }
    return { px, who };
  }

  // Sub-pixel, as next door: both backends compute in design-space doubles.
  const EPS_PX = 0.5;

  for (const scenario of SCENARIOS) {
    for (const raise of [false, true]) {
      const mode = `raise ${raise ? "on" : "off"}`;

      for (const backend of ["canvas", "dom"] as StageBackend[]) {
        it(`${scenario.name}: the ${backend} stage lands where the game has the card (${mode}, F=${F_PHONE.toFixed(4)})`, () => {
          const { beforeSettle, atRest, mid } = play(scenario, backend, raise);
          // …and, where the transcript says so, on every beat from the moment the client stops predicting.
          if (scenario.followsGame) {
            const watched = holderId(scenario.followsGame.holder);
            for (let i = scenario.followsGame.fromBeat; i < mid.length; i++) {
              const row = mid[i].holders.find((h) => h.id === watched);
              expect(row, `${watched} is not in the hand on beat ${i}`).toBeDefined();
              expect(
                landingDrift(row!, mid[i].spreadFactor).distPx,
                `${backend} ${scenario.name} @${mode} beat ${i}: ${watched} is drawn away from the pose the game ` +
                  `is STREAMING for it\n${formatHandPoseReport(mid[i])}`
              ).toBeLessThan(EPS_PX);
            }
          }
          expect(atRest.holders.length, formatHandPoseReport(atRest)).toBe(scenario.hand);
          const drift = worstDrift(atRest);
          expect(
            drift.px,
            `${backend} ${scenario.name} @${mode} landed away from the game's pose — ${drift.who}\n` +
              `${formatHandPoseReport(atRest)}`
          ).toBeLessThan(EPS_PX);
          const snap = worstSnap(beforeSettle, atRest);
          expect(
            snap.px,
            `${backend} ${scenario.name} @${mode} SNAPPED when the producer's re-emit landed — ${snap.who}\n` +
              `before:\n${formatHandPoseReport(beforeSettle)}\nafter:\n${formatHandPoseReport(atRest)}`
          ).toBeLessThan(EPS_PX);
        });
      }

      for (const backend of ["canvas", "dom"] as StageBackend[]) {
        it(`${scenario.name}: every landing the ${backend} stage PREDICTED is the one it got (${mode})`, () => {
          // THE PREDICTION GATE — the one the checks above cannot be. They score the hand once the producer's
          // settle re-emit has been adopted, and adopting it is what makes `drawn == game` true; a client that
          // eased to the wrong place and was rescued by that re-emit passes them. This one compares where the
          // backend DECIDED to put the card at the moment it armed the tween against where the card actually
          // finished, so a rescued mis-prediction is a non-zero row. See `landingLog.ts`.
          const { landings } = play(scenario, backend, raise);
          expect(
            landings.rows.length,
            `${backend} ${scenario.name} @${mode}: the transcript armed no hand tween at all — the gate is vacuous`
          ).toBeGreaterThan(0);
          // `scoredLandings` drops the three rows that are not verdicts about this client: a card that left the
          // hand, an endpoint a later arm replaced (every gesture in the recording is a double arm 58-81ms apart),
          // and an endpoint THE GAME abandoned. Whether the client then draws the game's new pose correctly is the
          // rest-time check above; this one is only about the prediction.
          const worst = worstLanding(scoredLandings(landings.rows, F_PHONE));
          if (worst !== null) {
            expect(
              worst.distPx,
              `${backend} ${scenario.name} @${mode}: ${worst.name} was sent to a place it did not end up — ` +
                `cause "${classifyLanding(worst, F_PHONE)}"\n${formatLandingLog(landings.rows, F_PHONE)}`
            ).toBeLessThan(EPS_PX);
          }
          // …and the field claim on EVERY row, scored or not: "did this backend put the endpoint on the
          // wide-screen squeeze field correctly" is answerable without a settle at all, so a row the game
          // abandoned still has to pass it. This is the arithmetic the user's report points at.
          for (const row of landings.rows) {
            const residual = endpointFieldResidual(row, F_PHONE);
            if (residual !== null) {
              expect(
                Math.abs(residual),
                `${backend} ${scenario.name} @${mode}: ${row.name}'s ENDPOINT got a wide-screen shift the field ` +
                  `rule does not produce\n${formatLandingLog([row], F_PHONE)}`
              ).toBeLessThan(EPS_PX);
            }
          }
        });
      }

      it(`${scenario.name}: the two stages draw the same hand (${mode})`, () => {
        const canvas = play(scenario, "canvas", raise);
        const dom = play(scenario, "dom", raise);
        // AT REST ONLY, and that is a property of the rig rather than a choice. The DOM stage hands its motion to
        // the compositor — it writes the endpoint once and lets a CSS transition interpolate — and jsdom runs no
        // transitions, so the DOM arm's drawn pose IS the endpoint from the first frame of a tween. Mid-flight the
        // two arms are therefore incomparable here by construction (an early draft of this file "found" a 425px
        // disagreement that was entirely that). Mid-flight behaviour is what the live harness's H11 measures, on a
        // browser that actually composites.
        for (const c of canvas.atRest.holders) {
          const d = dom.atRest.holders.find((h) => h.id === c.id);
          expect(d, `no DOM row for ${c.id}`).toBeDefined();
          expect(
            c.raiseDy,
            `${scenario.name} @${mode} — the stages lift ${c.id} differently\n` +
              `${formatHandPoseReport(canvas.atRest)}\n${formatHandPoseReport(dom.atRest)}`
          ).toBeCloseTo(d!.raiseDy, 6);
        }
      });
    }
  }
});
