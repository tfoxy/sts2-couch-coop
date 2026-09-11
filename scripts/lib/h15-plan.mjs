/** Pure, fast-testable H15 planning and assertion primitives. The live harness owns page I/O and gesture dispatch. */

export function planH15FifthPlay(from, to, overSlopCssPx = 32) {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const distance = Math.hypot(dx, dy);
  if (distance <= 1) return null;
  const overSlopDistance = Math.min(overSlopCssPx, distance / 2);
  return {
    from,
    to,
    overSlop: {
      cx: from.cx + dx / distance * overSlopDistance,
      cy: from.cy + dy / distance * overSlopDistance,
    },
  };
}

/** H15's dead-space sentinel only constrains raise's vertical inverse; widescreen field mapping may shift X. */
export function h15CoordinateVerdict(inputs, point) {
  const deltas = inputs.map((sample) => ({
    dx: sample.coordX - point.gx,
    dy: sample.coordY - point.gy,
  }));
  return {
    deltas,
    raw: deltas.some(({ dy }) => Math.abs(dy) <= 30),
    corrected: deltas.some(({ dy }) => dy > 70),
  };
}

/** Return H15's first failed strict focused-grab assertion, or null when the deterministic evidence is complete. */
export function h15FocusedGrabFailure({ pointerKind, dead, upperCoordinates, positive, focusedGrab }) {
  if (!dead.raw || dead.corrected) return "the fixed board-empty point was not sent raw while the fourth survivor was raised";
  if (!upperCoordinates.corrected) return "the fourth survivor's raised-only upper band sent no raise-corrected coordinate";
  if (!positive.focused) return "the raised-only fourth-card sample did not focus its own holder by zFocus and poseFocus";
  if (!positive.raiseSettled) return "the focused fourth survivor did not settle its raiseDy at zero while held";
  if (pointerKind === "touch" && !positive.contactHeld) return "the H15 positive touch peek released before its focused dy=0 contact reached the over-slop press";
  if (pointerKind === "touch" && !focusedGrab.startInsideNativeHitbox) return "the retained H15 touch contact was not inside its focused holder's native hitbox";
  if (!focusedGrab.nativePress.focusedAtNativeY) return "the H15 fourth-survivor grab did not send its native press while that holder was focused at dy zero";
  if (!focusedGrab.pressedInput) return "the H15 fourth-survivor grab emitted no coordinate-only pressed:true edge";
  if (pointerKind === "touch" && !focusedGrab.pressedInsideNativeHitbox) return "the H15 coordinate-only pressed:true edge did not resolve inside its focused holder's native hitbox";
  if (pointerKind === "touch" && !focusedGrab.pressedResolvesToTarget) return "the H15 coordinate-only pressed:true edge resolved to a native owner other than its focused holder";
  if (!focusedGrab.leftFan) return "the focused fourth survivor did not leave the fan when H15 grabbed it";
  if (!focusedGrab.restored) return "the H15 fourth-survivor grab did not safely cancel back into a whole fan";
  return null;
}
