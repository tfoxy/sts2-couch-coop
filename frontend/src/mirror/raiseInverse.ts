// READABLE-HAND MODE, input half — the vertical twin of viewScaleInverse.ts, and for the same reason.
//
// THE BUG it exists to prevent. The mirror's input path is coordinate-only: inputCapture resolves a pointer to a
// GAME (1920x1080) point and sends that, and the game hit-tests whatever is there. `mapPointerToGame` inverts the
// wide-screen re-layout on X, but **Y is a strict 1:1 fraction of the stage** — the whole spread machinery is
// horizontal. So the moment the renderer cosmetically RAISES something (a resting hand card by ~119px, a
// creature's health bar and powers by ~244px), a pointer that lands on it where it is DRAWN resolves to a game
// point that far above the thing it looks like. Hovering a raised hand would focus the wrong card, or nothing.
//
// THE FIX. The renderer publishes one stamp per moved hit surface: the surface's TRUE game-space placement plus
// the `dy` it was moved by. A pointer inside a stamp's RENDERED box (the true box translated by `dy`) is mapped
// back by `-dy`, then slid back inside the viewport if that put it outside (see remapRaiseInverse — the band the
// raise reveals is precisely the band the game keeps off-screen). Everything else is returned untouched, so an
// empty stamp list is provably identity — which is the state whenever the mode is off, the hand is lowered for a
// drag, or the viewer is not in combat.
//
// WHY ORIENTED BOXES, NOT AABBs. The hand is a FAN: an outer card sits at up to 15 degrees. Its axis-aligned
// bounding box, once raised, clips the left edge of the End Turn button — so an AABB test would claim taps on a
// button the card does not actually cover and send them 119px down into nothing. The oriented test (map the point
// through the placement matrix' inverse and compare against the node-local box) rejects them, because it asks the
// question the painter answers: is this point on the card.
//
// SHARED with pointerMap: `pointInPlacedRect` is the same containment predicate the near-miss pass uses, factored
// out so the two can never drift.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only.

import { affineInverse, nodeMatrix, type Affine } from "@/mirror/affine";
import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH } from "@/mirror/sceneTree";

/** A node-local box, in the `{x, y, width, height}` shape the wire uses. */
export interface RaiseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One cosmetically-moved hit surface, as the input gate sees it.
 *
 * `transform` + `localRect` are the surface's TRUE game-space placement (what the game believes); `dy` is the
 * purely visual vertical offset the renderer applied to it (negative = raised). `spreadDx` is the surface's
 * cumulative wide-screen shift, used by the rendered-box guard.
 *
 */
export interface RaiseInputStamp {
  transform: Affine;
  localRect: RaiseRect;
  spreadDx: number;
  dy: number;
  /**
   * The hand holder that owns this hitbox.  Only hand stamps carry it.  A renderer may independently prove that a
   * raw stage pixel was painted by this holder; that proof is deliberately separate from the game hitbox below,
   * whose wide-screen pose can differ from the card's drawn descendants during a fan transition.
   */
  ownerId?: string;
}

/** A renderer-owned fact about the raw stage pixel, never a coordinate sent upstream. */
export interface RaisedHandVisualClaim {
  /** The hand holder whose current painted descendant and hitbox/art-overhang footprint contain the raw pixel. */
  ownerId: string;
}

/** The first half of a raised-point resolve, retained until horizontal canonicalization has completed. */
export interface DeferredRaiseResolution {
  readonly x: number;
  readonly y: number;
  /** The stamp that may settle the canonicalized X, null outside the raised hand. */
  readonly claimed: RaiseInputStamp | null;
  /** True only when the ordinary hitbox/raw guard could not claim this stamp and renderer paint proof selected it. */
  readonly requiresVisualProof: boolean;
}

/**
 * Is the point (px, py) inside the box `localRect` placed by `transform`? Rotation/skew-safe: the point is mapped
 * into the box's own [0,w]x[0,h] frame through the inverse of the placement matrix.
 *
 * `offsetX`/`offsetY` shift the PLACEMENT (not the point), so a caller can test against where a surface renders
 * rather than where it truly is.
 */
export function pointInPlacedRect(
  transform: readonly number[],
  localRect: RaiseRect,
  px: number,
  py: number,
  offsetX = 0,
  offsetY = 0
): boolean {
  const inv = affineInverse(nodeMatrix(transform, localRect));
  if (!inv) {
    return false;
  }
  const x = px - offsetX;
  const y = py - offsetY;
  const lx = inv[0] * x + inv[2] * y + inv[4];
  const ly = inv[1] * x + inv[3] * y + inv[5];
  return lx >= 0 && lx <= localRect.width && ly >= 0 && ly <= localRect.height;
}

/**
 * Which stamp owns a game point, or null when none does. Iterated topmost-first (the renderer pushes in paint
 * order, so topmost is LAST), matching the game's own topmost-first hit arbitration.
 *
 * `raw` is the pointer's WIDENED-DESIGN position (pre-map). When supplied, a stamp may only claim the point if the
 * raw pointer really was inside the stamp's ON-STAGE box — the same false-halo guard viewScaleInverse applies, for
 * the same reason: on a wider-than-16:9 stage `mapPointerToGame` can fall back to a uniform squeeze that drops a
 * painter's own shift, and a squeezed X can land inside a box the pointer was nowhere near. At 16:9 `spreadDx` is
 * 0, so the guard is provably a no-op.
 *
 * Split out of `remapRaiseInverse` so a gesture can FREEZE its claim at the press and replay it on every drag-motion
 * frame instead of re-testing a live list that a focus ramp is moving under it.
 */
export function claimRaiseStamp(
  x: number,
  y: number,
  stamps: readonly RaiseInputStamp[],
  raw?: { x: number; y: number },
): RaiseInputStamp | null {
  for (let i = stamps.length - 1; i >= 0; i--) {
    const s = stamps[i];
    if (!pointInPlacedRect(s.transform, s.localRect, x, y, 0, s.dy)) {
      continue;
    }
    if (raw && !pointInPlacedRect(s.transform, s.localRect, raw.x, raw.y, s.spreadDx, s.dy)) {
      continue; // the pointer was not over this surface ON STAGE — let a lower stamp try
    }
    return s;
  }
  return null;
}

// How far OUTSIDE a drawn hitbox (in the surface's own local px — the holder scale is ~0.8, so ~24 design px) a
// point may fall and still claim the card. This is the art-overhang band: the frame/border/banner the finger
// aims at overhang the oriented hitbox by up to ~14px, and a rotated card's corners fall outside their own box —
// the exact class of tap that used to resolve into empty board. Deliberately far smaller than the always-on glow
// (a 607px box), which must never take a tap.
export const HAND_ANCHOR_MARGIN_LOCAL_PX = 30;

/**
 * Signed penetration of a point against a placed box, in the box's OWN local px: 0 inside, the euclidean
 * local-frame distance to the box when outside, null for a degenerate placement. `offsetX`/`offsetY` shift the
 * placement like pointInPlacedRect's.
 */
function placedDistance(
  transform: readonly number[],
  localRect: RaiseRect,
  px: number,
  py: number,
  offsetX = 0,
  offsetY = 0
): number | null {
  const inv = affineInverse(nodeMatrix(transform, localRect));
  if (!inv) {
    return null;
  }
  const x = px - offsetX;
  const y = py - offsetY;
  const lx = inv[0] * x + inv[2] * y + inv[4];
  const ly = inv[1] * x + inv[3] * y + inv[5];
  const dx = lx < 0 ? -lx : lx > localRect.width ? lx - localRect.width : 0;
  const dy = ly < 0 ? -ly : ly > localRect.height ? ly - localRect.height : 0;
  return dx === 0 && dy === 0 ? 0 : Math.hypot(dx, dy);
}

/**
 * Whether a point is on a placed surface or in its deliberately small art-overhang band.
 *
 * This is expressed in the surface's local pixels so a scaled/rotated hand card gets the
 * same physical footprint in both renderers.  It is intentionally much tighter than a
 * card glow: callers use it as the second half of a painted-owner provenance proof.
 */
export function pointWithinPlacedRectMargin(
  transform: readonly number[],
  localRect: RaiseRect,
  px: number,
  py: number,
  margin = HAND_ANCHOR_MARGIN_LOCAL_PX,
  offsetX = 0,
  offsetY = 0,
): boolean {
  const distance = placedDistance(transform, localRect, px, py, offsetX, offsetY);
  return distance !== null && distance <= margin;
}

/**
 * Apply the vertical raise inverse, but deliberately defer the final local-X arbitration.  Input capture performs
 * wide-screen near-miss canonicalization between this and {@link settleDeferredRaisePoint}; settling before it
 * compares a pre-canonical point against a post-canonical raw guard and loses the fourth card after a 5→4 fan.
 */
export function deferRaisePoint(
  x: number,
  y: number,
  stamps: readonly RaiseInputStamp[],
  raw?: { x: number; y: number },
  visualClaim?: RaisedHandVisualClaim | null,
): DeferredRaiseResolution {
  // First ask the established oriented-hitbox/raw-halo path.  Its claim remains fully self-contained and must
  // continue to settle on memoized hover and the no-freeze drag leg without a renderer probe. Only when it cannot
  // claim may the renderer's exact painted-owner proof nominate its one hand stamp.
  const hitboxClaim = claimRaiseStamp(x, y, stamps, raw);
  const paintedClaim = visualClaim === null || visualClaim === undefined
    ? null
    : [...stamps].reverse().find((stamp) => stamp.ownerId === visualClaim.ownerId) ?? null;
  const claimed = paintedClaim ?? hitboxClaim;
  const requiresVisualProof = claimed !== null && claimed !== hitboxClaim;
  if (claimed === null) {
    return { x, y, claimed: null, requiresVisualProof: false };
  }
  // A focused holder is already at its native Y (`dy === 0`), but a renderer paint proof may still be the
  // only evidence that this widened-stage raw pixel belongs to it. Keep that ownership through the horizontal
  // canonicalizer so settlement can arbitrate back onto THIS holder's native OBB; only its vertical translation
  // is a no-op.
  if (claimed.dy === 0) {
    return { x, y, claimed, requiresVisualProof };
  }
  const gameY = y - claimed.dy;
  const target = gameY > MAX_GAME_Y ? MAX_GAME_Y : gameY < 0 ? 0 : gameY;
  if (target === gameY) {
    return { x, y: gameY, claimed, requiresVisualProof };
  }
  const placed = nodeMatrix(claimed.transform, claimed.localRect);
  const axisY = placed[3];
  if (Math.abs(axisY) < MIN_AXIS_Y) {
    return { x, y: target, claimed, requiresVisualProof };
  }
  const t = (gameY - target) / axisY;
  const slidX = x - t * placed[2];
  return {
    x: slidX < 0 ? 0 : slidX > MIRROR_DESIGN_WIDTH ? MIRROR_DESIGN_WIDTH : slidX,
    y: target,
    claimed,
    requiresVisualProof,
  };
}

/**
 * Finish a deferred raised-hand resolve after the input pipeline has chosen its canonical X.  The renderer proof
 * is required only for a claim that renderer paint proof had to nominate.  Ordinary hitbox/raw-halo claims retain
 * their legacy self-contained settlement; proof-derived claims cannot borrow a neighbour's footprint after the
 * horizontal pass.
 */
export function settleDeferredRaisePoint(
  x: number,
  y: number,
  deferred: DeferredRaiseResolution,
  stamps: readonly RaiseInputStamp[],
  visualClaim?: RaisedHandVisualClaim | null,
): { x: number; y: number } {
  const claimed = deferred.claimed;
  if (
    claimed === null ||
    (deferred.requiresVisualProof && visualClaim?.ownerId !== claimed.ownerId)
  ) {
    return { x, y };
  }
  return settleOntoClaimed(x, y, claimed, stamps);
}

// The last game y a pointer may be sent at. The game's viewport is MIRROR_DESIGN_HEIGHT tall and a coordinate on
// its very last row is a coordinate the hit test can still reject, so the clamp keeps a 2px margin — the same
// margin the game's own focused-card pose keeps on screen.
const MAX_GAME_Y = MIRROR_DESIGN_HEIGHT - 2;
// Below this, the placement's local +Y is so nearly horizontal that sliding along it to reach a target y would run
// away across the screen. No fan card is anywhere near it (the fan tops out at ~15 degrees, |d| ≈ 0.77).
const MIN_AXIS_Y = 0.05;

/**
 * Which stamp the GAME will hit-test a point to: the topmost whose TRUE box contains it (same topmost-last scan as
 * `claimRaiseStamp`, against the un-shifted, un-raised boxes). This is the arbitration the client's coordinate has
 * to survive — see settleOntoClaimed.
 */
function gameArbiter(x: number, y: number, stamps: readonly RaiseInputStamp[]): RaiseInputStamp | null {
  for (let i = stamps.length - 1; i >= 0; i--) {
    if (pointInPlacedRect(stamps[i].transform, stamps[i].localRect, x, y)) {
      return stamps[i];
    }
  }
  return null;
}

// How far apart the candidate points of the search below are, in the claimed surface's OWN local px, and how far
// from its edges they stay. A hand card is 300 local px wide and overlaps its neighbour by ~130 of them, so 8px
// steps find the nearest workable point in a handful of tries and the inset keeps the answer off the seam.
const ARBITRATION_STEP_PX = 8;
const ARBITRATION_INSET_PX = 6;

/**
 * Make sure the coordinate we are about to send still hit-tests to the surface the player is pointing at, and slide
 * it ALONG THAT SURFACE'S LOCAL X until it does.
 *
 * WHY IT CAN FAIL AT ALL. The claim is decided on the DRAWN boxes and the game decides on its own; those two
 * orders are the same picture translated only while every surface moved by the same amount. The wide-screen
 * re-layout breaks that: it spreads the fan, giving each card its own `spreadDx`, so the cards overlap each other
 * by DIFFERENT amounts on screen than they do in the game. Near a seam the pointer is then plainly on card N as
 * drawn while the un-mapped point lands where card N+1 is on top in the game — measured on a 7-card hand at
 * 1920x950: one ~25px column at every boundary focused the neighbour (the reported "hovering the 6th card focuses
 * the 7th"). At 16:9 every `spreadDx` is 0, the two orders are identical, and this never runs.
 *
 * WHY SLIDING IS FREE. Any point on a card hovers that card, so moving within the claimed surface costs nothing —
 * the pointer's height on the card (its local Y) is preserved and only the local X moves, by the least that works.
 * Candidates that would leave the viewport are skipped, and if none arbitrates back the un-slid point is returned.
 */
function settleOntoClaimed(
  x: number,
  y: number,
  claimed: RaiseInputStamp,
  stamps: readonly RaiseInputStamp[]
): { x: number; y: number } {
  if (gameArbiter(x, y, stamps) === claimed) {
    return { x, y };
  }
  const placed = nodeMatrix(claimed.transform, claimed.localRect);
  const inv = affineInverse(placed);
  if (!inv) {
    return { x, y };
  }
  const localY = inv[1] * x + inv[3] * y + inv[5];
  const localX = inv[0] * x + inv[2] * y + inv[4];
  const width = claimed.localRect.width;
  const height = claimed.localRect.height;
  const axisY = placed[3];
  // Nearest-first, alternating sides: the competitor is on one side and which one is not worth deriving — the
  // first candidate that arbitrates back is the closest to where the player actually pointed either way.
  for (let step = ARBITRATION_STEP_PX; step <= width; step += ARBITRATION_STEP_PX) {
    for (const dir of [-1, 1]) {
      const cx = localX + dir * step;
      if (cx < ARBITRATION_INSET_PX || cx > width - ARBITRATION_INSET_PX) {
        continue;
      }
      // A fanned card is tilted, so travelling along its local X also travels in Y — and on the DOWNHILL side that
      // walks a point already clamped to the viewport floor straight back off it. Rather than discard that whole
      // direction (which is the only one that ever clears an overlapping neighbour for the leftmost card), ride the
      // card's own local Y back up by just enough to stay on screen.
      let cy = localY;
      if (Math.abs(axisY) >= MIN_AXIS_Y) {
        const highest = (MAX_GAME_Y - placed[5] - placed[1] * cx) / axisY;
        if (cy > highest) {
          cy = highest;
        }
      }
      if (cy < ARBITRATION_INSET_PX || cy > height - ARBITRATION_INSET_PX) {
        continue;
      }
      const px = placed[0] * cx + placed[2] * cy + placed[4];
      const py = placed[1] * cx + placed[3] * cy + placed[5];
      if (py < 0 || py > MAX_GAME_Y || px < 0 || px > MIRROR_DESIGN_WIDTH) {
        continue;
      }
      if (gameArbiter(px, py, stamps) === claimed) {
        return { x: px, y: py };
      }
    }
  }
  return { x, y };
}

/**
 * Un-map a GAME-space pointer that landed on a cosmetically-moved surface back to the coordinate the game actually
 * has there. Identity when no stamp claims the point (so an empty list is byte-identical to not having the
 * feature).
 *
 * OUT OF BOUNDS. Raising a hand card reveals a band of it that the game keeps BELOW its own viewport floor — that
 * band is the whole point of the mode, and it is the part carrying the rules text. Un-mapping a tap there gives a
 * game y past the floor, which the game hit-tests as nothing: the tap reaches the UI (a second tap still plays the
 * card) but the card never focuses. So a point that lands outside is slid back inside — ALONG THE CARD'S OWN LOCAL
 * -Y AXIS, not straight up. A fanned card is rotated up to ~15 degrees, and a straight-Y clamp walks out of the
 * side of a tilted card and into its neighbour, focusing the wrong one. Sliding along the card's own axis reaches
 * the floor while staying on the same card by construction (it moves from a point inside the box toward the box's
 * top edge, along the box's own axis, by at most ~150 of its 422 local px).
 *
 * In-bounds points — every point on every un-raised surface, and most of a raised one — are untouched.
 */
export function remapRaiseInverse(
  x: number,
  y: number,
  stamps: readonly RaiseInputStamp[],
  raw?: { x: number; y: number }
): { x: number; y: number } {
  if (stamps.length === 0) {
    return { x, y };
  }
  const claimed = claimRaiseStamp(x, y, stamps, raw);
  if (claimed === null || claimed.dy === 0) {
    // An UNMOVED stamp (the focused hand card — see mirrorRenderer.raiseInputStamps) is drawn exactly where the game
    // has it, so its whole job is to be claimed and hand the point straight back: no offset to undo and, being on
    // screen already, nothing to clamp.
    return { x, y };
  }
  const gameY = y - claimed.dy;
  const target = gameY > MAX_GAME_Y ? MAX_GAME_Y : gameY < 0 ? 0 : gameY;
  if (target === gameY) {
    return settleOntoClaimed(x, gameY, claimed, stamps);
  }
  // The placement's second column is its local +Y direction in game space; sliding by `t` along it moves y by
  // `t · axisY`, so this is the exact slide that lands on `target` — and it carries x by the card's rotation.
  const placed = nodeMatrix(claimed.transform, claimed.localRect);
  const axisY = placed[3];
  if (Math.abs(axisY) < MIN_AXIS_Y) {
    return { x, y: target }; // degenerate placement — a plain vertical clamp is the honest fallback
  }
  const t = (gameY - target) / axisY;
  const slidX = x - t * placed[2];
  const clampedX = slidX < 0 ? 0 : slidX > MIRROR_DESIGN_WIDTH ? MIRROR_DESIGN_WIDTH : slidX;
  return settleOntoClaimed(clampedX, target, claimed, stamps);
}
