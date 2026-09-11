// DID THE CLIENT PICK THE RIGHT PLACE? — the intended landing, measured against the settled one.
//
// WHY THIS EXISTS, AND WHY `handPoseProbe` IS NOT ENOUGH. The pose seam next door answers "where is the hand drawn
// RIGHT NOW", and every gate built on it scores the hand once the motion has stopped. That is the wrong moment, and
// wrong in a way that hides the whole defect class this module is for: the pose the client settles at is the pose
// the PRODUCER re-emitted at the end of the tween window, adopted by the walk. `drawn == game` at rest is very
// nearly true by construction. Such a gate can catch a client that fails to ADOPT the game's word afterwards — two
// of those were found and fixed — but it is structurally blind to a client that eased to the WRONG PLACE and was
// then rescued by the re-emit. That rescue is exactly what the player sees as "the card ends in the wrong place and
// jumps when it stops".
//
// So this measures the PREDICTION instead:
//
//   1. the moment a tween is armed, write down where this backend has DECIDED to put the card — not where the wire
//      said, but where the drawing path will actually draw it, wide-screen field and all (`noteArm`);
//   2. let the motion run and the producer's settle re-emit land;
//   3. read the drawn pose off the frame once it has (`tick` → `LandingProbe.drawnGlobal`);
//   4. the difference is the prediction error, whatever the animation happened to look like in between.
//
// THE ONE RULE THAT KEEPS IT HONEST: `endpointDrawn` must be produced by the BACKEND'S OWN DRAWING PATH and handed
// in. A re-derivation here would be a second implementation of the field algebra that could only ever agree with
// itself — the same tautology `landingDrift`'s field re-derivation exists to avoid, one level up. This module does
// no geometry: it stores two matrices and subtracts them.
//
// EVENT-DRIVEN ON PURPOSE. The headless box this is measured on runs page rAF at ~11 fps, so anything sampled per
// frame is quantised to ~90 ms of motion and a settle can be missed entirely. Rows open on an arm, close on a
// producer re-emit, and are read whenever someone asks.

import type { Affine } from "@/mirror/affine";

/** The window name the backends install; a harness reads THIS and never touches a renderer. */
export const LANDING_LOG_GLOBAL = "__mirrorLandingLog";

/** Which renderer installed the reader — so a late `dispose()` cannot unhook its successor (see `handPoseProbe`). */
const LANDING_LOG_OWNER = "__mirrorLandingLogOwner";

/**
 * How long past the end of a tween window a row waits for the producer to re-emit before it closes anyway.
 *
 * A landing the producer never confirms is still a landing — the card is sitting somewhere and the player can see
 * it — so the row closes and says so (`closedBy: "timeout"`) rather than leaking. Generous, because the settle
 * re-emit is one producer walk behind the window's end and a busy host walks at ~11 Hz.
 */
export const LANDING_SETTLE_TIMEOUT_MS = 1500;

/** Closed rows kept for reading. A hand gesture opens ~5; this is ~40 gestures of hindsight at a bounded cost. */
export const LANDING_LOG_CAPACITY = 200;

/** Below this a component of the drift is noise from the two paths' float order, not a mis-prediction. */
export const LANDING_EPS_PX = 0.01;

/**
 * …and the same threshold for the BASIS terms (`m[0..3]`), which are unitless and so cannot share the px one.
 *
 * A card is ~300 design px wide, so 0.001 of scale is a third of a pixel at its edge — under what anyone can see,
 * and two orders of magnitude above the float noise of composing an affine two different ways.
 */
export const LANDING_EPS_BASIS = 0.001;

/**
 * How far the card may move on the settle before it counts as a JUMP.
 *
 * Coarser than {@link LANDING_EPS_PX} on purpose: this compares two DIFFERENT FRAMES rather than two derivations
 * of one number, so an easing curve's last step, a rounded producer pose and a raise ramp's final millisecond all
 * live under it. Half a design pixel is well below anything a player can see, and three orders of magnitude below
 * the 8-24 px the wide-screen defect produced.
 */
export const LANDING_JUMP_EPS_PX = 0.5;

/** How close a mid-window streamed pose must be to the endpoint to count as the producer CONFIRMING it. */
export const LANDING_CONFIRM_EPS_PX = 1;

/** What one backend hands in when it arms a transform tween on a hand holder. */
export interface LandingArm {
  id: string;
  name: string;
  /** `performance.now()` at the arm. */
  atMs: number;
  /**
   * The RAW endpoint, lifted to a GLOBAL 6-tuple and NOTHING else — no wide-screen shift, no cosmetic lift. This is
   * the producer's own word about where the card goes, so it means the same thing on both stages and can be
   * compared against the game's settled pose directly.
   */
  endpointGame: Affine;
  /**
   * WHERE THIS BACKEND WILL DRAW IT — `endpointGame` put through the drawing path's own placement arithmetic (the
   * wide-screen field claim at the endpoint's own X, principally). NOT re-derived here: see the header.
   *
   * The cosmetic readable-hand lift is deliberately NOT in it. The lift is a separate channel that keeps ramping
   * after the arm, so folding it in would mix a prediction error with a legitimate later decision; it is reported
   * beside the drift instead (`raiseDyAtArm` / `raiseDyAtSettle`).
   */
  endpointDrawn: Affine;
  /** The horizontal shift `endpointDrawn` carries over `endpointGame`, as the backend computed it. */
  spreadDxApplied: number;
  /** `spreadLayout.SpreadOut.fieldMode` for this node — which formula produced that shift. -1 = not reported. */
  fieldMode: number;
  /** The tween's own length. The row cannot settle before it is over. */
  durationMs: number;
  /** The parent the endpoint was lifted through — a `"local"` endpoint means nothing under any other one. */
  parentId: string | null;
  /**
   * THE PRODUCER'S WORD AT THE ARM — the node's streamed `transform` ARRAY, by identity, not by value.
   *
   * This is the "before" half of the reconcile step, and identity is what makes it work with no per-delta hook in
   * either backend: `mergeNode` takes `transform` straight off the upsert, so the array is a fresh one exactly when
   * a delta carried a pose for this node and the same one on every frame in between. A row settles when that
   * identity changes to a non-null pose after the window — i.e. when the game has spoken again.
   */
  streamedAtArm: unknown;
}

/** How a row stopped being open. */
export type LandingClose = "settle" | "superseded" | "timeout" | "gone";

/** One closed arm→settle pair: what the client decided, and what it turned out to be. */
export interface LandingRow {
  /** Monotonic, per log. `supersededBy` points at one of these. */
  seq: number;
  id: string;
  name: string;
  armAt: number;
  settleAt: number;
  durationMs: number;
  closedBy: LandingClose;
  endpointGame: Affine;
  endpointDrawn: Affine;
  /** The drawn pose read off the frame at close, with the cosmetic lift TAKEN BACK OUT so it matches `endpointDrawn`. */
  settledDrawn: Affine;
  /** …and the same read before that subtraction — what was actually on screen. */
  settledDrawnRaw: Affine;
  /** WHERE THE GAME HAD IT at the settle, override-blind. Null when the walk composed none. */
  settledGame: Affine | null;
  /**
   * HOW FAR THE GAME ITSELF MOVED THE CARD away from the endpoint it promised, between the arm and the settle.
   *
   * Non-zero means the producer changed its mind — it re-laid the hand out, or the card left it — and the row is
   * then NOT evidence about this client's arithmetic: aiming at an endpoint the game later abandoned is not a
   * mis-prediction. Null when there was no streamed pose to compare against.
   */
  gameMovedPx: number | null;
  /** THE VERDICT: how far the predicted landing was from the settled one, in design px. */
  dx: number;
  dy: number;
  distPx: number;
  /**
   * …AND THE OTHER FOUR NUMBERS. `dx`/`dy` compare origins, which is all a translation tween can get wrong — but a
   * hint can carry a scale or a rotation too, and a client that predicted the wrong BASIS lands its origin
   * perfectly and draws the card at the wrong size. That scored `distPx: 0` until this field existed. The largest
   * absolute difference across `m[0..3]`, unitless; see {@link LANDING_EPS_BASIS}.
   */
  basisDelta: number;
  /**
   * SNAPSHOT B — where the client had drawn the card on the LAST FRAME BEFORE the producer's word landed, with the
   * cosmetic lift taken back out. Null when the row closed on its first tick (nothing was sampled before it).
   *
   * `distPx` answers "was the arithmetic right"; this answers the player's actual complaint, which is that the card
   * stops somewhere and then MOVES. The two are different numbers and a round has already been lost to conflating
   * them: a backend can predict the endpoint exactly and still draw the whole flight somewhere else.
   */
  preSettleDrawn: Affine | null;
  /** How far the card JUMPED when the delta landed — `preSettleDrawn` → `settledDrawn`. Null with no snapshot B. */
  settleJumpPx: number | null;
  /** The cosmetic lift the holder was drawn with just after the arm, and at the settle. */
  raiseDyAtArm: number;
  raiseDyAtSettle: number;
  /** The lift's own change across the window — a y jump the player sees that is NOT a mis-predicted endpoint. */
  raiseDeltaPx: number;
  /** What the player sees at the settle: the drift with the lift's change folded back in. */
  screenDistPx: number;
  spreadDxApplied: number;
  fieldMode: number;
  /** The `seq` of the arm that replaced this one before it could settle, or null. */
  supersededBy: number | null;
  /** …and how long this row had been running when that happened. */
  supersededAfterMs: number | null;
}

/**
 * The per-frame facts the log cannot read for itself. One object per backend, built once and reused — `tick` is on
 * the frame path and must allocate nothing while no row is open.
 */
export interface LandingProbe {
  /** The DESIGN-space global this node is drawn at this frame, cosmetic lift included. Null when it is not drawn. */
  drawnGlobal(id: string): Affine | null;
  /** The cosmetic readable-hand lift the node is drawn with this frame (negative = raised). */
  raiseDy(id: string): number;
  /** Does an animation channel still own this node's transform? A row cannot settle while one does. */
  channelLive(id: string): boolean;
  /** The node's streamed `transform` array, BY IDENTITY — see {@link LandingArm.streamedAtArm}. */
  streamedTransform(id: string): unknown;
  /**
   * WHERE THE GAME HAS THE NODE at the settle — its streamed composition, blind to every client-side override
   * (the same quantity `HandPoseSample.mGame` reports). Null when the walk has composed none.
   *
   * This is what lets a row tell a MIS-PREDICTION from the game simply changing its mind: an endpoint the producer
   * later moved away from was never a place the client was wrong to aim at.
   */
  streamedGlobal(id: string): Affine | null;
}

/** An arm still in flight. */
interface OpenRow {
  seq: number;
  arm: LandingArm;
  /** Filled by the first tick after the arm — the lift the raise pass computed for the new endpoint. */
  raiseDyAtArm: number | null;
  /**
   * The last streamed pose seen while the window was still open. Kept up to date until the window ends (the arm's
   * own value is only the seed) so a producer that does NOT fully suppress the target mid-tween cannot make the row
   * close on a pose that predates the settle — which would score the client's prediction against itself.
   */
  streamedRef: unknown;
  /**
   * Has the producer already told us the card is AT the endpoint, from inside the window? See the settle rule.
   */
  confirmed: boolean;
  /** The previous tick's drawn pose and lift — snapshot B, kept one frame behind the close. */
  lastDrawn: Affine | null;
  lastRaiseDy: number;
}

/**
 * THE LOG. One per renderer; the backends install their reader on `window` and a harness reads that.
 *
 * Deliberately ungated, like the pose seam: it costs one `Map.size` test per frame while nothing is armed, and a
 * gate is a thing a harness gets run without.
 */
export interface LandingLog {
  /** A transform tween was armed on a tracked node. Supersedes (and closes) any row still open for it. */
  noteArm(arm: LandingArm): void;
  /** A tracked node left the scene — close its row unmeasured rather than leaking it. */
  noteGone(id: string): void;
  /** Close whatever is ready. Call at the end of a completed frame, and before a read. */
  tick(atMs: number, probe: LandingProbe): void;
  /** The closed rows, oldest first. */
  rows(): readonly LandingRow[];
  /** How many arms are still in flight. */
  openCount(): number;
  /** Drop everything (a wire keyframe: every row describes a tree that no longer exists). */
  clear(): void;
}

/**
 * Is this streamed pose the game saying the card is where the hint promised? See the mid-window rule in `tick`.
 *
 * A comparison of VALUES, unlike everything else here, and deliberately coarse: the alternative pose it has to be
 * told apart from is the card's pre-hint slot, and a hand's slots are ~170 design px apart.
 */
function confirmsEndpoint(streamedGlobal: Affine | null, endpointGame: Affine): boolean {
  return (
    streamedGlobal !== null &&
    Math.hypot(streamedGlobal[4] - endpointGame[4], streamedGlobal[5] - endpointGame[5]) <= LANDING_CONFIRM_EPS_PX
  );
}

export function createLandingLog(capacity = LANDING_LOG_CAPACITY): LandingLog {
  const open = new Map<string, OpenRow>();
  const closed: LandingRow[] = [];
  let nextSeq = 1;

  function close(
    row: OpenRow,
    atMs: number,
    closedBy: LandingClose,
    drawnRaw: Affine | null,
    raiseDyAtSettle: number,
    supersededBy: number | null,
    settledGame: Affine | null = null,
    preSettleRaw: Affine | null = null,
    preSettleRaiseDy = 0
  ): void {
    open.delete(row.arm.id);
    const raiseDyAtArm = row.raiseDyAtArm ?? 0;
    // No drawn pose to read (the node is gone, or was never built) — the row is still worth keeping as a record
    // that the arm happened, so it closes at its own predicted pose and scores zero drift. `closedBy` is what tells
    // a reader the difference; nothing should treat a `"gone"` row as evidence of a good landing.
    const raw = drawnRaw ?? row.arm.endpointDrawn;
    const settled: Affine = [raw[0], raw[1], raw[2], raw[3], raw[4], raw[5] - raiseDyAtSettle];
    const dx = settled[4] - row.arm.endpointDrawn[4];
    const dy = settled[5] - row.arm.endpointDrawn[5];
    const raiseDeltaPx = raiseDyAtSettle - raiseDyAtArm;
    // The other four terms of the same comparison — see `LandingRow.basisDelta`.
    let basisDelta = 0;
    for (let i = 0; i < 4; i++) {
      const d = Math.abs(settled[i] - row.arm.endpointDrawn[i]);
      if (d > basisDelta) {
        basisDelta = d;
      }
    }
    // SNAPSHOT B, lift-subtracted like `settled` so the jump is a POSE jump and a still-ramping raise does not
    // masquerade as one (the ramp has its own number).
    const preSettle: Affine | null =
      preSettleRaw === null
        ? null
        : [preSettleRaw[0], preSettleRaw[1], preSettleRaw[2], preSettleRaw[3], preSettleRaw[4], preSettleRaw[5] - preSettleRaiseDy];
    closed.push({
      seq: row.seq,
      id: row.arm.id,
      name: row.arm.name,
      armAt: row.arm.atMs,
      settleAt: atMs,
      durationMs: row.arm.durationMs,
      closedBy,
      endpointGame: row.arm.endpointGame,
      endpointDrawn: row.arm.endpointDrawn,
      settledDrawn: settled,
      settledDrawnRaw: raw,
      settledGame,
      gameMovedPx:
        settledGame === null
          ? null
          : Math.hypot(settledGame[4] - row.arm.endpointGame[4], settledGame[5] - row.arm.endpointGame[5]),
      dx,
      dy,
      distPx: Math.hypot(dx, dy),
      basisDelta,
      preSettleDrawn: preSettle,
      settleJumpPx: preSettle === null ? null : Math.hypot(settled[4] - preSettle[4], settled[5] - preSettle[5]),
      raiseDyAtArm,
      raiseDyAtSettle,
      raiseDeltaPx,
      screenDistPx: Math.hypot(dx, dy + raiseDeltaPx),
      spreadDxApplied: row.arm.spreadDxApplied,
      fieldMode: row.arm.fieldMode,
      supersededBy,
      supersededAfterMs: supersededBy === null ? null : atMs - row.arm.atMs
    });
    if (closed.length > capacity) {
      closed.splice(0, closed.length - capacity);
    }
  }

  return {
    noteArm(arm) {
      const seq = nextSeq++;
      const prev = open.get(arm.id);
      if (prev !== undefined) {
        // THE DOUBLE ARM, AS A NUMBER. A hand gesture arrives as two hint batches ~60-80 ms apart with different
        // endpoints for the same cards; an Expo/Out curve is most of the way through its distance by then. Whether
        // that is a defect or the game changing its mind, a row that eased towards a superseded endpoint is not
        // evidence about the client's arithmetic, and `supersededBy` is how a reader tells the two apart instead
        // of guessing from timestamps.
        close(prev, arm.atMs, "superseded", null, prev.raiseDyAtArm ?? 0, seq);
      }
      open.set(arm.id, {
        seq,
        arm,
        raiseDyAtArm: null,
        streamedRef: arm.streamedAtArm,
        confirmed: false,
        lastDrawn: null,
        lastRaiseDy: 0
      });
    },

    noteGone(id) {
      const row = open.get(id);
      if (row !== undefined) {
        close(row, row.arm.atMs + row.arm.durationMs, "gone", null, row.raiseDyAtArm ?? 0, null);
      }
    },

    tick(atMs, probe) {
      if (open.size === 0) {
        return;
      }
      for (const row of [...open.values()]) {
        const id = row.arm.id;
        if (row.raiseDyAtArm === null) {
          // The lift the raise pass settled on for the NEW endpoint — sampled on the first frame after the arm
          // rather than at the arm itself, where the pass has not run yet and the value is still the old pose's.
          row.raiseDyAtArm = probe.raiseDy(id);
        }
        const channelLive = probe.channelLive(id);
        const windowEnd = row.arm.atMs + row.arm.durationMs;
        if (atMs < windowEnd) {
          // INSIDE THE WINDOW, and a re-emit here is one of two completely different events.
          //
          // Usually it is the producer still streaming a pose from BEFORE the hint (a coalesced delta), and
          // scoring against it would measure where the card started — which is why the rule below refreshes the
          // reference rather than settling on it.
          //
          // But the producer's settle re-emit is keyed to the GAME'S tween finishing, not to this client's replay
          // of it, and `durationMs` is the game's number: the two cross. Measured live, the delta that settled two
          // of three focused cards arrived 40.9 ms before the third card's nominal window end — and that row,
          // having folded the settle into its own reference, then waited for a re-emit that had already happened
          // and TIMED OUT. So a mid-window pose that puts the card AT the endpoint is latched as the confirmation
          // it is; the row still cannot close until the client has stopped drawing (the channel below).
          const streamedNow = probe.streamedTransform(id);
          if (streamedNow !== null && streamedNow !== undefined && streamedNow !== row.streamedRef) {
            if (confirmsEndpoint(probe.streamedGlobal(id), row.arm.endpointGame)) {
              row.confirmed = true;
            } else {
              row.streamedRef = streamedNow;
            }
          }
          if (!row.confirmed || channelLive) {
            row.lastDrawn = probe.drawnGlobal(id);
            row.lastRaiseDy = probe.raiseDy(id);
            continue;
          }
          // Confirmed AND the channel has let go: the motion is over early and the game has spoken. Fall through.
        } else if (channelLive) {
          continue; // over-running its window (a re-arm's tail, a pin catch-up) — not landed yet
        }
        const streamed = probe.streamedTransform(id);
        const reconciled =
          row.confirmed || (streamed !== null && streamed !== undefined && streamed !== row.streamedRef);
        const timedOut = atMs >= windowEnd + LANDING_SETTLE_TIMEOUT_MS;
        if (!reconciled && !timedOut) {
          // Waiting for the producer. THIS is the frame that becomes snapshot B if the next one settles: the card
          // is standing where the client's own motion left it, and the delta has not arrived yet.
          row.lastDrawn = probe.drawnGlobal(id);
          row.lastRaiseDy = probe.raiseDy(id);
          continue;
        }
        close(
          row,
          atMs,
          reconciled ? "settle" : "timeout",
          probe.drawnGlobal(id),
          probe.raiseDy(id),
          null,
          probe.streamedGlobal(id),
          // The PREVIOUS tick's pose: this tick's read already has the delta in it (the log ticks after the walk).
          row.lastDrawn,
          row.lastRaiseDy
        );
      }
    },

    rows: () => closed,
    openCount: () => open.size,
    clear() {
      open.clear();
      closed.length = 0;
    }
  };
}

/**
 * The residual between the shift the backend actually applied to the endpoint and the ORIGIN field evaluated at that
 * endpoint — the one term a hand holder's shift is supposed to be.
 *
 * This is the first line of the decomposition and it needs no settle at all: a non-zero residual says the client
 * decided on a horizontal place the field rule does not produce, which lands as `(endX − startX)·(F − 1)` of drift
 * the moment the producer's word arrives. Null for any node that did not claim the origin field, where the shift is
 * a function of something other than its own X and there is nothing to check it against.
 */
export function endpointFieldResidual(row: LandingRow, spreadFactor: number): number | null {
  if (row.fieldMode !== 1) {
    return null;
  }
  const gx = row.endpointGame[4];
  const clamped = gx < 0 ? 0 : gx > 1920 ? 1920 : gx;
  return row.endpointDrawn[4] - (gx + clamped * (spreadFactor - 1));
}

/** The named causes {@link classifyLanding} can return. */
export type LandingCause =
  | "clean"
  /** The node left the scene before it could land — no verdict. */
  | "gone"
  /** A later arm replaced this endpoint mid-flight; the row says nothing about the client's arithmetic. */
  | "superseded"
  /** The GAME moved the card away from the endpoint it promised. Also not the client's arithmetic. */
  | "game-moved"
  /** The client applied a wide-screen shift to the endpoint that the field rule does not produce. */
  | "endpoint-field"
  /** The client eased to an endpoint the producer never abandoned, and still finished somewhere else. */
  | "endpoint-pose"
  /** The origin landed; the SCALE or ROTATION the client predicted did not. */
  | "endpoint-basis"
  /** Origin and basis both landed — but the card visibly MOVED when the producer's word arrived. */
  | "settle-jump"
  /** The pose landed; the cosmetic readable-hand lift changed under it. */
  | "raise-ramp";

/** The causes that are NOT a verdict about this client — a gate must not score them. See {@link classifyLanding}. */
export const LANDING_UNSCORED: readonly LandingCause[] = ["gone", "superseded", "game-moved"];

/**
 * WHY THIS ROW MISSED — the decomposition table, in code, so a harness and a spec name the same cause.
 *
 * ORDER MATTERS, and the first three are exclusions rather than causes: a row whose card left the hand, whose
 * endpoint a later arm replaced, or whose endpoint THE GAME ITSELF abandoned is not evidence that the client
 * predicted badly. (Whether the client draws the game's new pose correctly is the other instrument's question —
 * `handPoseProbe.landingDrift`, at rest.) Then a wrong FIELD explains a wrong X before "the endpoint was the wrong
 * pose" does: it is the same wrong X with a mechanism attached, and a lever that turns it off.
 */
export function classifyLanding(row: LandingRow, spreadFactor: number): LandingCause {
  if (row.closedBy === "gone") {
    return "gone";
  }
  if (row.supersededBy !== null) {
    return "superseded";
  }
  const residual = endpointFieldResidual(row, spreadFactor);
  if (residual !== null && Math.abs(residual) > LANDING_EPS_PX) {
    return "endpoint-field";
  }
  if (row.gameMovedPx !== null && row.gameMovedPx > LANDING_EPS_PX) {
    return "game-moved";
  }
  if (Math.abs(row.dx) > LANDING_EPS_PX || Math.abs(row.dy) > LANDING_EPS_PX) {
    return "endpoint-pose";
  }
  if (row.basisDelta > LANDING_EPS_BASIS) {
    return "endpoint-basis";
  }
  // A CORRECT PREDICTION IS NOT THE SAME AS A STILL PICTURE. The two poses this row compares are both endpoints —
  // where the client aimed, and where the game turned out to be — and they can agree while the frame the player
  // was looking at one tick earlier was somewhere else entirely (a subtree drawn through a stale wide-screen
  // claim, a flight the client integrated differently). That jump IS the report, so it gets a cause.
  if (row.settleJumpPx !== null && row.settleJumpPx > LANDING_JUMP_EPS_PX) {
    return "settle-jump";
  }
  if (Math.abs(row.raiseDeltaPx) > LANDING_EPS_PX) {
    return "raise-ramp";
  }
  return "clean";
}

/** The rows a gate should judge: everything the classifier does not exclude. */
export function scoredLandings(rows: readonly LandingRow[], spreadFactor: number): LandingRow[] {
  return rows.filter((r) => !LANDING_UNSCORED.includes(classifyLanding(r, spreadFactor)));
}

/** The worst-predicted of `rows` by `distPx`, or null when there is nothing to judge. */
export function worstLanding(rows: readonly LandingRow[]): LandingRow | null {
  return rows.reduce<LandingRow | null>((acc, r) => (acc === null || r.distPx > acc.distPx ? r : acc), null);
}

/** One line per row, for a harness log or a failure message. */
export function formatLandingLog(rows: readonly LandingRow[], spreadFactor = 1): string {
  return rows
    .map((r) => {
      const residual = endpointFieldResidual(r, spreadFactor);
      return [
        `#${r.seq}`,
        r.name,
        `${classifyLanding(r, spreadFactor)}`,
        `want=(${r.endpointDrawn[4].toFixed(1)},${r.endpointDrawn[5].toFixed(1)})`,
        `got=(${r.settledDrawn[4].toFixed(1)},${r.settledDrawn[5].toFixed(1)})`,
        `d=(${r.dx.toFixed(2)},${r.dy.toFixed(2)})`,
        `dist=${r.distPx.toFixed(2)}`,
        r.basisDelta > LANDING_EPS_BASIS ? `basis=${r.basisDelta.toFixed(4)}` : "",
        r.settleJumpPx === null ? "" : `jump=${r.settleJumpPx.toFixed(2)}`,
        `screen=${r.screenDistPx.toFixed(2)}`,
        `raise=${r.raiseDyAtArm.toFixed(0)}→${r.raiseDyAtSettle.toFixed(0)}`,
        `mode=${r.fieldMode}`,
        `dx=${r.spreadDxApplied.toFixed(1)}`,
        r.gameMovedPx === null ? "" : `gameMoved=${r.gameMovedPx.toFixed(2)}`,
        residual === null ? "" : `fieldResidual=${residual.toFixed(2)}`,
        r.supersededBy === null ? `closed=${r.closedBy}` : `superseded-by=#${r.supersededBy}@${(r.supersededAfterMs ?? 0).toFixed(0)}ms`
      ]
        .filter(Boolean)
        .join(" ");
    })
    .join("\n");
}

/** What the window reader returns — the rows plus the factor a caller needs to decompose them. */
export interface LandingLogReport {
  stage: "dom" | "canvas";
  spreadFactor: number;
  openCount: number;
  rows: readonly LandingRow[];
}

/**
 * Install (or, with `read` null, remove) the window seam. Same ownership rule as `installHandPoseProbe`: a disposing
 * renderer that lost the race to its replacement must not unhook the live one.
 */
export function installLandingLogProbe(read: (() => LandingLogReport) | null, owner: object): void {
  if (typeof window === "undefined") {
    return;
  }
  const slot = window as unknown as Record<string, unknown>;
  if (read === null) {
    if (slot[LANDING_LOG_OWNER] === owner) {
      delete slot[LANDING_LOG_GLOBAL];
      delete slot[LANDING_LOG_OWNER];
    }
    return;
  }
  slot[LANDING_LOG_GLOBAL] = read;
  slot[LANDING_LOG_OWNER] = owner;
}
