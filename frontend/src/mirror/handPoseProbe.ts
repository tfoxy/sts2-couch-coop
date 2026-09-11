// WHERE THE HAND IS ACTUALLY DRAWN — one question, asked the same way of both backends.
//
// WHY THIS EXISTS. The mirror predicts the hand's motion client-side: the producer ships a tween hint (an endpoint
// plus a curve) and the client replays it rather than waiting for the poses to arrive one delta at a time. When the
// replay ends somewhere other than where the game has the card, the card SNAPS the moment the pin lifts — and that
// snap is the whole of the "cards don't land where they should" report.
//
// Measuring it needs the DRAWN pose, and until now only one stage could be asked:
//
//   * the live touch harness (`scripts/validate-touch-live.mjs`) reads `[data-node-id]` geometry, so it is
//     DOM-only by construction and says so in its header;
//   * `scripts/replay-repro.mjs` records "`?stage=canvas` draws no per-node DOM, so the pose samples are empty
//     there";
//   * the `?handParity` gauge compares CSS matrix STRINGS off elements.
//
// So the canvas stage shipped its hand prediction with no instrument pointed at it, and a round could land a fix,
// pass its own unit tests over a synthetic node, and be wrong about the live scene. This module is the missing
// seam: ONE sample shape, ONE verdict function, answered by whichever backend is drawing.
//
// WHAT IS SHARED AND WHAT IS NOT. The two backends genuinely differ in how a pose gets onto the screen — the DOM
// composes nested elements and lets the compositor interpolate a CSS transition, the canvas walks a flat draw list
// it recomputes every frame — so PRODUCING `mDrawn` is per-backend and always will be. Everything else here is
// shared on purpose: the sample, the report, the drift arithmetic and the window install, so a number read on one
// stage means exactly what the same number means on the other.

import type { Affine } from "@/mirror/affine";
import { fieldDxAtOriginX } from "@/mirror/spreadLayout";

/** One hand holder, as both backends must be able to describe it. All matrices are DESIGN-space (1920-space) globals. */
export interface HandPoseSample {
  id: string;
  /** The node's name (`NHandCardHolder-CARD_STRIKE_…`), for reading a report without a node map to hand. */
  name: string;
  /**
   * Is this holder still one of the FAN's cards — a child of the hand CONTAINER? The game reparents a holder onto
   * the hand ROOT while its card is dragged or selected, and such a holder keeps the game's pose exactly: it is
   * neither raised nor predicted, so a landing check must not score it as a fan card.
   */
  inFan: boolean;
  /**
   * WHERE THE GAME HAS IT — the streamed composition, blind to every client-side override. This is the pose a tap
   * is answered in, and (once the producer's suppression window closes) the truth a landing is scored against.
   */
  mGame: Affine;
  /**
   * WHERE THE CLIENT DRAWS IT THIS FRAME — the tween sample or endpoint, the wide-screen spread shift, the
   * readable-hand lift, all included. On the DOM stage this is composed from what was actually written to the
   * elements; on the canvas stage it is the matrix the draw list was built with. Both are measurements of the
   * drawn frame rather than re-derivations of what the drawn frame ought to be, which is what lets the two arms
   * disagree when one of them is wrong.
   */
  mDrawn: Affine;
  /** The horizontal wide-screen shift this node claimed (0 at 16:9, and 0 whenever the stretch is off). */
  spreadDx: number;
  /** Which field formula produced it — see `spreadLayout.SpreadOut.fieldMode`. -1 = the backend did not report one. */
  fieldMode: number;
  /** The readable-hand lift this holder is drawn at (negative = raised), 0 when the mode is not moving it. */
  raiseDy: number;
  /**
   * The producer's stacking order for this holder. A focused hand holder is promoted to 1, so this is the
   * renderer-neutral counterpart to the DOM stage's former `element.style.zIndex` focus read.
   */
  zIndex: number;
  /**
   * This holder's HIT SURFACE — the `Hitbox` child, whose 300x422 box is the footprint a pointer can land on and
   * the id `interactiveRects()` publishes the card's drawn rect under.
   *
   * It is here so that a harness can join the two seams (this one and the rect list) WITHOUT walking the DOM for
   * an ancestor, which is the one thing that made the live touch harness DOM-only: `rect → closest
   * [data-node-type$=NHandCardHolder]` has no answer on a stage that emits no per-node elements.
   */
  hitboxId: string | null;
  /** …and the `NCard` under it, for the same reason (the harness reports the card a gesture reached by name). */
  cardId: string | null;
  /**
   * The direct `NCard` child's stable content identity. Hand-holder shells are pooled and may have generated
   * `@Control` names, so fixture checks must identify the card through this child rather than the holder name.
   */
  cardContentKey: string | null;
  /** The GLOBAL transform a genuinely-live transform channel is headed for, or null when nothing owns the node. */
  endpoint: Affine | null;
  /** True while an animation (a tween channel or a card flight) owns this node's transform. */
  channelLive: boolean;
}

/** One frame's answer, from one stage. */
export interface HandPoseReport {
  stage: "dom" | "canvas";
  /** `performance.now()` at the read. */
  atMs: number;
  /** `stageWidth / 1920` — 1 with the wide-screen stretch off, up to 1.3125 at the 2520 cap. */
  spreadFactor: number;
  /** Is a combat hand on screen at all? An empty `holders` with `handPresent: false` is "no hand", not "no answer". */
  handPresent: boolean;
  holders: HandPoseSample[];
}

/** The window name both backends install. A harness reads THIS and never touches a renderer. */
export const HAND_POSE_PROBE_GLOBAL = "__mirrorHandPoses";

/**
 * THE LANDING VERDICT, in one place.
 *
 * A holder is landed correctly when the pose the client draws it at is the pose the GAME has it at, put on the
 * wide-screen squeeze field — and the field term is RE-DERIVED here rather than read off the sample. That is the
 * difference between a measurement and a tautology: the reported defect IS a wrong horizontal shift, so a verdict
 * that subtracted the node's own `spreadDx` back out would score every wrong shift as a perfect landing.
 *
 * `spreadFactor` is what makes the re-derivation possible, and it only works for a node that claims the ORIGIN
 * field (`fieldMode === 1`) — which is what a hand holder is: a zero-size positioner under a pass-through
 * container, so its rendered x is exactly `gameX · F`. For any other mode the shift is a function of something
 * that is not this node's own x (a rigid ride, the anchor algebra, an owner's shift), there is nothing to
 * re-derive from the sample alone, and the reported shift is taken at its word — so a caller that cares should
 * assert the mode as well, and the fixtures do.
 *
 * The lift is SUBTRACTED OUT rather than compared: it is a deliberate cosmetic offset that the input side inverts
 * exactly, so a raised card is not mis-landed. It is asserted separately, across the two stages.
 *
 * Returns the drift in DESIGN px, x and y apart (they fail for different reasons: x is the spread and the fan's
 * horizontal re-layout, y is the focus pose and the lift), plus the euclidean distance a report reads.
 */
export function landingDrift(
  sample: HandPoseSample,
  spreadFactor = 1
): { dx: number; dy: number; distPx: number } {
  const shift = sample.fieldMode === 1 ? fieldDxAtOriginX(sample.mGame[4], spreadFactor) : sample.spreadDx;
  const dx = sample.mDrawn[4] - (sample.mGame[4] + shift);
  const dy = sample.mDrawn[5] - (sample.mGame[5] + sample.raiseDy);
  return { dx, dy, distPx: Math.hypot(dx, dy) };
}

/**
 * The same question ACROSS the two stages: how far apart are the two backends' drawn poses for one holder?
 *
 * A cross-stage comparison is strictly weaker than {@link landingDrift} (two arms can agree and both be wrong,
 * which is exactly what "share one implementation" is meant to make impossible), so it is the SECOND assertion a
 * spec makes and never the only one.
 */
export function crossStageDrift(a: HandPoseSample, b: HandPoseSample): { dx: number; dy: number; distPx: number } {
  const dx = a.mDrawn[4] - b.mDrawn[4];
  const dy = a.mDrawn[5] - b.mDrawn[5];
  return { dx, dy, distPx: Math.hypot(dx, dy) };
}

/** Sort a report's holders by drawn x, so two arms' rows line up regardless of node id or walk order. */
export function byDrawnX(holders: readonly HandPoseSample[]): HandPoseSample[] {
  return [...holders].sort((a, b) => a.mDrawn[4] - b.mDrawn[4]);
}

/** A one-line row per holder, for a harness log or a failure message. */
export function formatHandPoseReport(report: HandPoseReport): string {
  const rows = byDrawnX(report.holders).map((h) => {
    const d = landingDrift(h, report.spreadFactor);
    return [
      `${h.name}`,
      `game=(${h.mGame[4].toFixed(1)},${h.mGame[5].toFixed(1)})`,
      `drawn=(${h.mDrawn[4].toFixed(1)},${h.mDrawn[5].toFixed(1)})`,
      `spreadDx=${h.spreadDx.toFixed(1)}`,
      `mode=${h.fieldMode}`,
      `raiseDy=${h.raiseDy}`,
      h.channelLive ? "LIVE" : "settled",
      h.inFan ? "" : "OUT-OF-FAN",
      `drift=(${d.dx.toFixed(2)},${d.dy.toFixed(2)})`
    ]
      .filter(Boolean)
      .join(" ");
  });
  return `[${report.stage}] F=${report.spreadFactor.toFixed(4)} t=${report.atMs.toFixed(0)}\n  ${rows.join("\n  ")}`;
}

/**
 * Install (or, with `read` null, remove) the window seam.
 *
 * Ungated, unlike the paint-dump family: this reports the same geometry `interactiveRects()` already publishes to
 * the input side, it costs nothing until it is called, and a harness that has to ask for a debug flag to see the
 * hand is a harness that will be run with the flag missing. Idempotent, and it never overwrites another
 * renderer's installed reader with `null` — a disposing renderer that lost the race would otherwise unhook the
 * live one (MirrorView constructs the replacement BEFORE disposing the old backend on a stage-backend flip).
 */
export function installHandPoseProbe(read: (() => HandPoseReport) | null, owner: object): void {
  if (typeof window === "undefined") {
    return;
  }
  const slot = window as unknown as Record<string, unknown>;
  if (read === null) {
    if (slot[HAND_POSE_PROBE_OWNER] === owner) {
      delete slot[HAND_POSE_PROBE_GLOBAL];
      delete slot[HAND_POSE_PROBE_OWNER];
    }
    return;
  }
  slot[HAND_POSE_PROBE_GLOBAL] = read;
  slot[HAND_POSE_PROBE_OWNER] = owner;
}

/** Which renderer installed the reader — so a late `dispose()` cannot unhook its successor. Not for callers. */
const HAND_POSE_PROBE_OWNER = "__mirrorHandPosesOwner";
