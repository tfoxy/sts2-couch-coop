// =====================================================================================================
// H11 PHASE 2 — WHERE THE CLIENT'S REPLAY WAS GOING, AGAINST WHERE THE CARD CAME TO REST.
// =====================================================================================================
//
// Extracted from `scripts/validate-touch-live.mjs` so it can be unit-tested against recorded traces:
// the harness itself parses argv and drives a browser at module scope, so nothing inside it is reachable
// from a spec. The harness imports `scoreCorrections` from here and is the only production caller.
//
// WHY THIS IS NOT "THE DRAWN POSE ON THE LAST LIVE FRAME" ANY MORE
// ----------------------------------------------------------------
// It used to be. The rule was: take the holder's DRAWN pose on the last frame a client-side channel owned
// it, take its drawn pose a moment later, and call the difference the correction — with the motion's own
// `lastStepPx` as the tolerance, on the reasoning that every producer curve is an ease-OUT so its final
// step is its smallest, and a re-placement bigger than that is something the curve never asked for.
//
// That reasoning needs the sampler to RESOLVE the motion, and on the canvas arm it does not. Measured
// 2026-09-19 on the live harness, three canvas combos: the per-`requestAnimationFrame` trace samples at a
// MEDIAN OF ~310 ms (3.1-3.4 fps — SwiftShader, and the canvas backend computes every animation frame
// itself), against the ~90 ms the old rule's own header assumed. A hand tween is a few hundred ms, so the
// last frame on which a channel is alive is typically the FIRST and only frame of that tween — the middle
// of the ease, or its very start. What the old rule then reported as "unexplained" was simply the travel
// the sampler never saw, and `lastStepPx` could not absorb it because there is no second live sample to
// measure a step from (one offender's `lastStepPx` was literally 0: the arm frame had not moved yet).
//
// The evidence that this was a false report and not a defect is the field the seam already published and
// the trace threw away — `HandPoseSample.endpoint`, the global transform a genuinely live channel is
// HEADED FOR. On all four offenders across two runs, the endpoint at the hand-off frame was EXACTLY where
// the card came to rest once the client's own two terms were applied:
//
//   canvas-mouse-1920  @Control@606011  endpoint 1191    -> drawn 1191    ; rested at 1191
//   canvas-mouse-2400  @Control@608974  endpoint 1040    -> drawn 1300    ; rested at 1300     (F=1.25)
//   canvas-mouse-2400  @Control@608976  endpoint 1191    -> drawn 1488.75 ; rested at 1488.8   (F=1.25)
//   canvas-touch-1920  @Control@611942  endpoint 965,1030-> drawn 965,911 ; rested at 965,911
//
// …while the old rule called those same four landings 57.45, 72.19, 72.12 and 73.20 design px wrong.
//
// So the landing is now the ENDPOINT, put through the same two client-side terms phase 1 uses:
//
//   * the wide-screen squeeze shift, RE-DERIVED at the endpoint's own x for an origin claimer
//     (`fieldMode === 1`, which every hand holder is) exactly as `handPoseProbe.landingDrift` re-derives
//     it — believing the node's reported `spreadDx` would score a wrong shift as a perfect landing, and a
//     wrong shift is a defect this family exists to catch;
//   * the readable-hand lift AS IT IS AT THE SETTLE, because the lift is a separate channel with its own
//     ramp and the pose term is what a landing is about.
//
// This is frame-rate independent — an endpoint is a statement, not a sample — which is why the verdict no
// longer needs `lastStepPx` at all. It is a STRICTER rule, not a looser one: the tolerance is now a flat
// `CORRECTION_PX` instead of "whatever the previous step happened to be" (53.6, 45.0 and 55.0 px on the
// three runs above). The defect this phase exists for — a replay that ends on a superseded endpoint and
// snaps when the pin lifts — is still caught, because a stale endpoint is still an endpoint that is not
// where the card rests. That case is pinned offline in `handLandingScore.spec.ts` at this run's own ~310 ms
// cadence. It is NOT pinned live: the `?tweenReparent=keep` and `?spreadEndpoint=off` levers earlier rounds
// used as negative controls no longer exist in the build (grep-verified 2026-09-19 — both behaviours became
// unconditional), so nothing can currently break a landing on a live page on purpose.
//
// THE SETTLE IS A REST, NOT A DEADLINE. The old rule took whatever frame it found within 400 ms, which at
// ~310 ms per frame is the NEXT frame — itself usually still mid-ease (two of the four offenders above
// "settled" at 1299.0 and 1194.4 on their way to 1300 and 1200). It now walks forward to the first drawn
// pose that has actually stopped moving, and stops at the next live channel or the deadline instead.

/** How far a landing may miss the place the card rests before it is a jump the player sees. */
export const CORRECTION_PX = 2;
/** Two consecutive drawn samples this close together are the card standing still. */
export const STILL_PX = 0.5;
/** How long to keep looking for that rest before giving up on the row. */
export const SETTLE_DEADLINE_MS = 2000;

/** `spreadLayout.fieldDxAtOriginX`, restated: an origin claimer at game-x `x` renders at `x·F`. */
function fieldDxAtOriginX(x, spreadFactor) {
  const clamped = x < 0 ? 0 : x > 1920 ? 1920 : x;
  return clamped * (spreadFactor - 1);
}

/**
 * WHERE THE BACKEND WILL DRAW `endpoint`, in the same space `mDrawn` is reported in.
 *
 * `fieldMode === 1` re-derives the shift from the endpoint's own x (see the header). Any other mode takes
 * its shift from something that is not this node's own x, so there is nothing to re-derive and the node's
 * reported shift is all there is — the same fallback `handPoseProbe.landingDrift` makes.
 */
export function predictedDrawn(landing, settled, spreadFactor) {
  const shift = landing.fm === 1 ? fieldDxAtOriginX(landing.ex, spreadFactor) : landing.sd;
  return { x: landing.ex + shift, y: landing.ey + settled.rd };
}

/** Group a trace's frames into one row list per holder, in time order. */
function byHolder(trace) {
  const rows = new Map();
  for (const frame of trace) {
    for (const h of frame.h) {
      let list = rows.get(h.id);
      if (list === undefined) {
        list = [];
        rows.set(h.id, list);
      }
      list.push({ t: frame.t, f: frame.f, stage: frame.stage, presentEpoch: frame.presentEpoch, ...h });
    }
  }
  return rows;
}

const MATCH_PX = CORRECTION_PX;

function samePoint(a, x, y, tolerance = MATCH_PX) {
  return Array.isArray(a) && Math.hypot(a[4] - x, a[5] - y) <= tolerance;
}

/** The log is tour-scoped by the caller; bind a sampled endpoint to its exact holder/endpoint row. */
function matchingLandingRows(landingRows, sample) {
  return landingRows.filter((row) => row.id === sample.id &&
    (row.name === undefined || row.name === sample.name) &&
    samePoint(row.endpointGame, sample.ex, sample.ey));
}

function successorExplainsRest(oldRows, landingRows, left, right, settled) {
  for (const old of oldRows) {
    if (old.closedBy !== "superseded" || old.supersededBy === null || old.supersededBy === undefined) continue;
    const successor = landingRows.find((row) => row.id === old.id && row.seq === old.supersededBy);
    if (!successor || successor.armAt < left.t || successor.armAt > right.t) continue;
    const endpoint = successor.endpointGame;
    if (!Array.isArray(endpoint) || (right.ex != null && !samePoint(endpoint, right.ex, right.ey))) continue;
    // Reconstruct from the successor's game-space endpoint. Never let a wrong endpointDrawn measurement
    // self-confirm the same wrong place; only the explicitly sampled field contract supplies the x offset.
    const mode = right.fm;
    const factor = settled.f ?? right.f ?? 1;
    const shift = mode === 1 ? fieldDxAtOriginX(endpoint[4], factor) : settled.sd;
    if (Math.hypot(settled.dx - (endpoint[4] + shift),
      settled.dy - (endpoint[5] + settled.rd)) <= MATCH_PX) return true;
  }
  return false;
}

function focusCatchupExplainsRest(oldRows, rows, handoffIndex, restAt, settled, spreadFactor) {
  for (const old of oldRows) {
    if (old.closedBy !== "timeout" || old.supersededBy !== null || !Array.isArray(old.endpointDrawn)) continue;
    const oldGame = old.endpointGame;
    if (!Array.isArray(oldGame)) continue;
    const end = Math.min(restAt, rows.length - 1);
    for (let focus = handoffIndex - 1; focus <= end; focus++) {
      const current = rows[focus], previous = rows[focus - 1];
      if (!current || current.z !== 1 || !Number.isFinite(previous?.z) || previous.z === 1) continue;
      if (current.t < old.armAt || current.t > old.settleAt) continue;
      // The old endpoint must still own a sampled live frame after focus changes the game's streamed pose.
      let held = -1;
      for (let j = focus; j <= end; j++) {
        const row = rows[j];
        if (row.z !== 1 || !row.live || row.t > old.settleAt ||
            Math.hypot(row.gx - oldGame[4], row.gy - oldGame[5]) <= MATCH_PX) continue;
        const expectedX = oldGame[4] + (row.fm === 1 ? fieldDxAtOriginX(oldGame[4], row.f ?? spreadFactor) : row.sd);
        const expectedY = oldGame[5] + row.rd;
        if (Math.hypot(row.dx - expectedX, row.dy - expectedY) <= MATCH_PX) { held = j; break; }
      }
      if (held < 0) continue;
      // Require an actual adopted focus pose: focus z-order, a changed lift, game/drawn agreement, and the
      // timeout row's producer pose must all identify the same destination.
      for (let j = held + 1; j <= end; j++) {
        const row = rows[j];
        if (row.z !== 1 || row.live) continue;
        // The first non-live focus row that publishes a changed pose or lift is the adoption attempt. If
        // that committed sample is wrong, a later correction cannot retroactively make the hand-off clean.
        const oldShift = rows[held].fm === 1
          ? fieldDxAtOriginX(oldGame[4], row.f ?? spreadFactor)
          : rows[held].sd;
        const stillHeld = Math.hypot(row.dx - (oldGame[4] + oldShift),
          row.dy - (oldGame[5] + row.rd)) <= MATCH_PX;
        const adoptionAttempt = Math.abs(row.rd - rows[held].rd) > MATCH_PX || !stillHeld;
        if (!adoptionAttempt) continue;
        const shift = row.fm === 1 ? fieldDxAtOriginX(row.gx, row.f ?? spreadFactor) : row.sd;
        return Math.hypot(row.dx - (row.gx + shift), row.dy - (row.gy + row.rd)) <= MATCH_PX &&
          Math.abs(row.rd - rows[held].rd) > MATCH_PX &&
          samePoint(old.settledGame, row.gx, row.gy) &&
          Math.hypot(settled.dx - row.dx, settled.dy - row.dy) <= STILL_PX;
      }
    }
  }
  return false;
}

/**
 * The first frame at or after `from` on which the holder has STOPPED MOVING — two consecutive drawn poses
 * within {@link STILL_PX} — or null when it never does inside the deadline.
 *
 * Stops at the next live channel: a card the client starts replaying again is no longer resting from THIS
 * landing, and reading past it would score the next motion's endpoint against this one's.
 */
function findRestEvidence(rows, from, landingAtMs) {
  let previous = null;
  for (let j = from; j < rows.length; j++) {
    const row = rows[j];
    if (row.live) return -1;
    if (row.t - landingAtMs > SETTLE_DEADLINE_MS) return -1;
    if (row.stage === "canvas") {
      if (!Number.isSafeInteger(row.presentEpoch) || row.presentEpoch < 0) return -1;
      // A trace tick can run while the canvas is still showing the same committed picture. Such
      // duplicate reads are not two observations of rest; only compare poses from distinct commits.
      if (previous !== null && row.presentEpoch === previous.presentEpoch) continue;
      if (previous !== null && row.presentEpoch < previous.presentEpoch) return -1;
    }
    if (previous !== null && Math.hypot(row.dx - previous.dx, row.dy - previous.dy) <= STILL_PX) {
      return {
        index: j,
        commitPair: row.stage === "canvas" && previous.stage === "canvas"
          ? { firstEpoch: previous.presentEpoch, settledEpoch: row.presentEpoch }
          : null
      };
    }
    previous = row;
  }
  return -1;
}

export function findRest(rows, from, landingAtMs) {
  const result = findRestEvidence(rows, from, landingAtMs);
  return result === -1 ? -1 : result.index;
}

function invalidCanvasFrameIdentities(trace) {
  const errors = [];
  let previousEpoch = null;
  for (let i = 0; i < trace.length; i++) {
    const frame = trace[i];
    if (frame.stage !== "canvas") continue;
    const epoch = frame.presentEpoch;
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      errors.push({ frame: i, t: frame.t, presentEpoch: epoch ?? null, reason: "missing or invalid epoch" });
      continue;
    }
    if (previousEpoch !== null && epoch < previousEpoch) {
      errors.push({ frame: i, t: frame.t, presentEpoch: epoch, previousEpoch, reason: "epoch regressed" });
      continue;
    }
    previousEpoch = epoch;
  }
  return errors;
}

/**
 * Score every hand-off in a trace.
 *
 * Returns the list of corrections worst-residual-first, carrying four counters that are reported rather
 * than dropped silently (each of them means something different from "nothing was measured"):
 *
 *   * `confirmed` — the producer's own pose in the window put the card where the client aimed it, so the
 *     prediction was right and the re-placement is the producer catching up. The seam samples game and
 *     drawn together but the producer's word about a tweened node arrives a delta later, which at this
 *     cadence is a third of a second, so a CORRECT client looks momentarily wrong without this.
 *   * `unpredicted` — a channel was alive but published no endpoint (a card FLIGHT has none: it re-derives
 *     its pose from a closed-form curve and is not a fan card whose resting pose means anything).
 *   * `unsettled` — the holder never stood still inside the deadline, so there is no "where it ended up"
 *     to compare against. A row here is a measurement that did not complete, not a pass.
 *   * `outOfFan` — the game had reparented the holder off the hand container at one end of the hand-off, so
 *     what it was carrying is not a fan landing (see the guard's own note).
 */
export function scoreCorrections(trace, landingRows = []) {
  const holders = byHolder(trace);
  const corrections = [];
  let confirmedLandings = 0;
  let unpredicted = 0;
  let unsettled = 0;
  let outOfFan = 0;
  let superseded = 0;
  let focusCatchups = 0;
  let distinctCanvasRestPairs = 0;
  const canvasRestPairEvidence = [];
  const invalidFrameIdentity = invalidCanvasFrameIdentities(trace);

  for (const [id, rows] of holders) {
    for (let i = 1; i < rows.length; i++) {
      // The hand-off: a channel owned the holder on the previous frame and does not on this one.
      if (!(rows[i - 1].live && !rows[i].live)) continue;
      const landing = rows[i - 1];
      if (landing.ex === null || landing.ex === undefined) {
        unpredicted++;
        continue;
      }
      const rest = findRestEvidence(rows, i, landing.t);
      if (rest === -1) {
        unsettled++;
        continue;
      }
      const restAt = rest.index;
      const settled = rows[restAt];
      if (rest.commitPair !== null) {
        distinctCanvasRestPairs++;
        canvasRestPairEvidence.push({
          id,
          handoffAtMs: landing.t,
          settledAfterMs: Math.round(settled.t - landing.t),
          ...rest.commitPair
        });
      }
      // OUT OF THE FAN AT EITHER END, and therefore not a fan card's landing at all. `HandPoseSample.inFan`
      // states the contract this enforces: the game reparents a holder onto the hand ROOT while its card is
      // dragged or selected, and such a holder "keeps the game's pose exactly: it is neither raised nor
      // predicted". Measured case (report-1789839259490, mouse-2400): a committed card's holder is reparented
      // mid-channel, the game re-poses it from (1975.4, 2039.5) to (1053, 911) over the next 300 ms, and the
      // hand endpoint it was carrying (1040, 871) describes a fan it is no longer in.
      if (!landing.fan || !settled.fan) {
        outOfFan++;
        continue;
      }
      const spreadFactor = settled.f ?? landing.f ?? 1;
      const logged = matchingLandingRows(landingRows, landing).filter((row) =>
        row.armAt <= landing.t && row.settleAt >= landing.t);
      if (successorExplainsRest(logged, landingRows, landing, rows[i], settled)) {
        superseded++;
        continue;
      }
      if (focusCatchupExplainsRest(logged, rows, i, restAt, settled, spreadFactor)) {
        focusCatchups++;
        continue;
      }
      const want = predictedDrawn(landing, settled, spreadFactor);
      const dx = settled.dx - want.x;
      const dy = settled.dy - want.y;
      const residualPx = Math.hypot(dx, dy);

      // THE PRODUCER'S OWN WORD, read the other way round: if a game pose FROM THE HAND-OFF ONWARDS puts the
      // card where the client aimed it, the aim was right and a rest somewhere else is the producer moving the
      // card afterwards, not the client being overruled. The comparison re-derives the field for the same
      // reason `predictedDrawn` does, so a wrong shift can never be "confirmed" by it.
      //
      // FORWARD ONLY, and that is load-bearing. The window used to reach two frames BACK, from when the
      // landing was a drawn sample and the producer's word about a tweened node was known to arrive a delta
      // late. Against an ENDPOINT it is exactly backwards: the endpoint of a superseded channel was the
      // game's pose right up until the producer moved the card, so a backward look confirms every stale
      // endpoint there is — which is the one defect this phase exists to catch.
      const confirmed = rows.slice(i, restAt + 3).some((row) => {
        const f = row.f ?? spreadFactor;
        const shift = landing.fm === 1 ? fieldDxAtOriginX(row.gx, f) : landing.sd;
        return (
          Math.abs(want.x - (row.gx + shift)) <= CORRECTION_PX &&
          Math.abs(want.y - (row.gy + settled.rd)) <= CORRECTION_PX
        );
      });
      if (confirmed) {
        confirmedLandings++;
        continue;
      }

      const r1 = (v) => Math.round(v * 10) / 10;
      const r2 = (v) => Math.round(v * 100) / 100;
      corrections.push({
        id,
        name: landing.name,
        atMs: rows[i].t,
        settledAfterMs: Math.round(settled.t - landing.t),
        residualPx: r2(residualPx),
        d: [r2(dx), r2(dy)],
        overruled: residualPx > CORRECTION_PX,
        /** Where the replay was going, in game space and then in the space the frame is measured in. */
        endpointGame: [r1(landing.ex), r1(landing.ey)],
        aimedAt: [r1(want.x), r1(want.y)],
        restedAt: [r1(settled.dx), r1(settled.dy)],
        /** The drawn pose on the last live frame — no longer the verdict, but it is what a jump LOOKS like. */
        drawnAtHandoff: [r1(landing.dx), r1(landing.dy)],
        sampledJumpPx: r2(Math.hypot(settled.dx - landing.dx, settled.dy - landing.dy)),
        gameAtHandoff: [r1(landing.gx), r1(landing.gy)],
        gameAtRest: [r1(settled.gx), r1(settled.gy)],
        spreadDxLanding: r1(landing.sd),
        spreadDxSettled: r1(settled.sd),
        raiseDyLanding: landing.rd,
        raiseDySettled: settled.rd,
        fieldMode: landing.fm,
        inFan: settled.fan,
        // The frames either side of the hand-off, for this holder alone. A jump you cannot read the run-up
        // to is a jump you cannot attribute: this is what says whether the client eased into its answer or
        // stepped there, and what the game and the channel were saying while it did.
        around: rows.slice(Math.max(0, i - 5), restAt + 3).map((r) => ({
          t: r.t,
          drawn: [r1(r.dx), r1(r.dy)],
          game: [r1(r.gx), r1(r.gy)],
          ep: r.ex === null || r.ex === undefined ? null : [r1(r.ex), r1(r.ey)],
          sd: r1(r.sd),
          rd: r.rd,
          live: r.live,
          fan: r.fan
        }))
      });
    }
  }

  corrections.sort((a, b) => b.residualPx - a.residualPx);
  corrections.confirmed = confirmedLandings;
  corrections.unpredicted = unpredicted;
  corrections.unsettled = unsettled;
  corrections.outOfFan = outOfFan;
  corrections.superseded = superseded;
  corrections.focusCatchups = focusCatchups;
  corrections.distinctCanvasRestPairs = distinctCanvasRestPairs;
  corrections.canvasRestPairEvidence = canvasRestPairEvidence;
  corrections.invalidFrameIdentity = invalidFrameIdentity;
  return corrections;
}
