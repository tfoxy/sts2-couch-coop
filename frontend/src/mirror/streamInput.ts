// streamInput.ts — the render-stream INPUT CHANNEL (INP2). Captures pointer input over the stream canvas, maps it
// through INP1's pointer mapping (`cssToPresentation`, then `toGame` for the hit item's inverse override), and
// forwards the SAME coordinate-only `MirrorInputMessage` the old mirror's inputCapture emits upstream. The game
// hit-tests the coordinate natively, so the stream needs no element addressing: the canvas IS the presentation,
// and the only correction is the hit override's inverse (a raised or scaled card drawn away from where the game
// has it).
//
// Unlike the old mirror's inputCapture — which re-mapped through view-scale inverses, raise inverses, spread
// painters, near-miss bands and DOM probes because the node-geometry mirror re-laid the scene out — the stream's
// mapping is one call: `clientToGame`. The gesture state machine here is correspondingly lean, but the wire bytes
// it emits are the same contract:
//   * hover           {kind:"hover", coordX, coordY}                                  (coalesced to one per frame)
//   * press/release   {kind:"click", button, pressed:true|false, coordX, coordY}      (a drag's edges)
//   * full click      {kind:"click", button, coordX, coordY}                          (press+release in one turn)
//   * wheel tick      {kind:"click", button:"wheel-up"|"wheel-down", coordX, coordY}
//
// Mouse/pen press on pointerdown and release on pointerup (a click is that pair). Touch defers the press until the
// finger travels past the touch slop (then it is a drag), and a sub-slop release is a TAP: a single full click, or
// — when `tapToFocus` is on — the two-step play the old mirror's touch path does (first tap hovers/arms the hit
// item, a second tap on the same item commits).
//
// UN-FORCED SINCE INP2's successor: two of the old mirror's touch features now ride this channel, driven by the
// stream-ext modules' controllers (which own the item identity, the lift override and the confirm button):
//   * HELD-CARD LIFT (`raiseHeldCard` + `unfocusOnRelease`): a still hold on a hand card for PEEK_MS is a "peek" —
//     focus + lift, no play on release — and a touch drag lifts the card above the fingertip. On a peek release,
//     `unfocusOnRelease` re-hovers the seat centre so the game drops the focus and the card returns to the hand.
//   * CONFIRM TAP (`confirmTap`): a tap that lands on a confirm-eligible widget only focuses it and shows the
//     button; the button commits (a left click re-sent at the focus coordinate, via `commitConfirm`).
// Self-contained per the mirror decoupling rule: `@/mirror/*` and `@/stream-ext/*` only.

import type { MirrorInputMessage } from "@/mirror/mirrorClient";
import type { ConfirmTapController } from "@/stream-ext/confirmTap";
import type { HeldCardController } from "@/stream-ext/heldCard";

/** The render-stream client surface the channel reads (INP1's `clientToGame`). */
export interface StreamInputClient {
  clientToGame(clientX: number, clientY: number): StreamGamePoint | null;
}

/** A point in the game's input space plus the topmost drawn item there (INP1's `GamePoint`). */
export interface StreamGamePoint {
  readonly point: { readonly x: number; readonly y: number };
  /** The topmost drawn item at the point (a card's child, say); null on bare clear colour. */
  readonly item: number | null;
  readonly drawn: { readonly x: number; readonly y: number };
}

export interface StreamInputOptions {
  /** The element pointer events are captured on (the stream <canvas>). */
  stage: HTMLElement;
  /** The live client (recreated on reconnect); null before it is mounted or after dispose. */
  getClient: () => StreamInputClient | null;
  send: (message: MirrorInputMessage) => void;
  /** TAP TO FOCUS (read live, so a settings flip takes effect mid-session): two-step play on touch. */
  tapToFocus?: () => boolean;
  /** Injectable clock for the tap-arm debounce (specs drive it); defaults to `performance.now`. */
  now?: () => number;
  /** HELD-CARD LIFT: the module's controller (identity climb + lift override). */
  heldCard?: HeldCardController;
  /** HELD-CARD LIFT master switch (read live). */
  raiseHeldCard?: () => boolean;
  /** Peek-release un-focus (read live). */
  unfocusOnRelease?: () => boolean;
  /** CONFIRM TAP: the module's controller (classification + button state). */
  confirmTap?: ConfirmTapController;
  /** CONFIRM TAP switch (read live). */
  confirmTapEnabled?: () => boolean;
}

export interface StreamInput {
  dispose(): void;
  /** CONFIRM TAP: commit the focused widget (a left click at the focus coordinate). No-op with no button up. */
  commitConfirm(): void;
}

/** A re-tap of the armed item within this long is a finger-bounce, swallowed (the old mirror's debounce). */
export const TAP_ARM_DEBOUNCE_MS = 200;
/** Touch travel (CSS px) past which a single-finger gesture is a DRAG, not a tap. */
const TOUCH_SLOP_PX = 8;
/** A lone finger held still on a HAND card this long becomes a peek (the old mirror's PEEK_MS). */
export const PEEK_MS = 100;

type HeldButton = "left" | "right" | "middle";

interface HeldGesture {
  readonly pointerId: number;
  readonly button: HeldButton;
  readonly pointerType: string;
  /** The mapped press point (game px) — sent as the press when a touch crosses the slop. */
  readonly down: { coordX: number; coordY: number };
  /** The raw client position the press started at, for the slop test. */
  readonly startClientX: number;
  readonly startClientY: number;
  dragging: boolean;
  /** The hand card under the finger at press (for the lift), or null. */
  handCard: number | null;
  /** The long-press peek timer (touch only). */
  peekTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the long-press peek has fired (the release is then a peek release, never a tap). */
  peeking: boolean;
}

interface PointWithItem {
  readonly coordX: number;
  readonly coordY: number;
  readonly item: number | null;
}

function buttonName(button: number): HeldButton | null {
  return button === 0 ? "left" : button === 2 ? "right" : button === 1 ? "middle" : null;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function createStreamInput(options: StreamInputOptions): StreamInput {
  const { stage, getClient, send, tapToFocus, heldCard, confirmTap } = options;
  const raiseHeldCard = options.raiseHeldCard ?? (() => true);
  const unfocusOnRelease = options.unfocusOnRelease ?? (() => true);
  const confirmTapEnabled = options.confirmTapEnabled ?? (() => false);
  const clock = options.now ?? nowMs;

  let held: HeldGesture | null = null;
  // TAP TO FOCUS: the item armed by the first tap (and when), so a re-tap commits and a different item re-arms.
  let armedItem: number | null = null;
  let armedAtMs = 0;
  // CONFIRM TAP: the game coordinate the focus hover went to, replayed verbatim by the commit.
  let confirmCoord: { coordX: number; coordY: number } | null = null;
  // Hover coalescing: one hover per animation frame, flushed in the frame callback.
  let pendingHover: { coordX: number; coordY: number } | null = null;
  let hoverFrame: number | null = null;

  /** INP1's mapping: page px → the game-space point and the item drawn there, or null on a letterbox bar. */
  function map(clientX: number, clientY: number): PointWithItem | null {
    const game = getClient()?.clientToGame(clientX, clientY);
    if (game === null || game === undefined) return null;
    return { coordX: game.point.x, coordY: game.point.y, item: game.item };
  }

  function flushHover(): void {
    hoverFrame = null;
    const h = pendingHover;
    pendingHover = null;
    if (h !== null) send({ kind: "hover", coordX: h.coordX, coordY: h.coordY });
  }

  function scheduleHover(coordX: number, coordY: number): void {
    pendingHover = { coordX, coordY };
    if (hoverFrame === null) hoverFrame = requestAnimationFrame(flushHover);
  }

  function fullClick(button: "left" | "right" | "wheel-up" | "wheel-down", point: PointWithItem): void {
    send({ kind: "click", button, coordX: point.coordX, coordY: point.coordY });
  }

  function releasePointer(pointerId: number): void {
    try {
      stage.releasePointerCapture(pointerId);
    } catch {
      // Already released / never captured — ignore.
    }
  }

  function clearArmed(): void {
    armedItem = null;
    armedAtMs = 0;
  }

  function clearPeekTimer(p: HeldGesture): void {
    if (p.peekTimer !== null) {
      clearTimeout(p.peekTimer);
      p.peekTimer = null;
    }
  }

  /** The hand card under the finger, or null. Only asked of a touch (the old mirror's lift is touch-only). */
  function handCardAt(item: number | null): number | null {
    if (item === null || heldCard === undefined) return null;
    return heldCard.handCardFor(item);
  }

  /** Drop the lift and the button, so neither outlives the gesture that raised it. */
  function clearOverlayState(): void {
    heldCard?.setHeld(null, 0, "drag");
    if (confirmCoord !== null) {
      confirmCoord = null;
      confirmTap?.hide();
    }
  }

  function endHeld(reason: "up" | "cancel"): void {
    if (held !== null) clearPeekTimer(held);
    held = null;
    if (hoverFrame !== null && pendingHover !== null) {
      // A queued drag-motion hover is superseded by the release/cancel edge; drop it.
      cancelAnimationFrame(hoverFrame);
      hoverFrame = null;
      pendingHover = null;
    }
    void reason;
  }

  function onPointerMove(event: PointerEvent): void {
    const point = map(event.clientX, event.clientY);
    if (point === null) return;
    if (held !== null && held.pointerId === event.pointerId && held.pointerType !== "touch") {
      // Mouse/pen drag-motion: the press already went out on down; the move stream is hover (the game follows it).
      scheduleHover(point.coordX, point.coordY);
      return;
    }
    if (held !== null && held.pointerId === event.pointerId) {
      // Touch: below the slop it is still a potential tap (nothing sent); past it, become a drag.
      if (!held.dragging) {
        const dx = event.clientX - held.startClientX;
        const dy = event.clientY - held.startClientY;
        if (dx * dx + dy * dy >= TOUCH_SLOP_PX * TOUCH_SLOP_PX) {
          held.dragging = true;
          clearPeekTimer(held); // a drag is not a peek
          send({ kind: "click", button: held.button, pressed: true, coordX: held.down.coordX, coordY: held.down.coordY });
        }
      }
      if (held.dragging) {
        scheduleHover(point.coordX, point.coordY);
        // HELD-CARD LIFT: a dragged hand card follows the finger above the fingertip.
        if (held.handCard !== null) heldCard?.setHeld(held.handCard, point.coordY, "drag");
      }
      return;
    }
    // No button held: a plain hover.
    scheduleHover(point.coordX, point.coordY);
  }

  function onPointerDown(event: PointerEvent): void {
    if (held !== null) return; // a second finger while one is down is a stray
    const button = buttonName(event.button);
    if (button === null) return;
    event.preventDefault();
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort (a synthetic event in a spec); the gesture still replays.
    }
    const point = map(event.clientX, event.clientY);
    if (point === null) return;
    const handCard = event.pointerType === "touch" ? handCardAt(point.item) : null;
    held = {
      pointerId: event.pointerId,
      button,
      pointerType: event.pointerType,
      down: { coordX: point.coordX, coordY: point.coordY },
      startClientX: event.clientX,
      startClientY: event.clientY,
      dragging: false,
      handCard,
      peekTimer: null,
      peeking: false
    };
    if (event.pointerType !== "touch") {
      // The game's hover-first widgets need the cursor at the press point before the press. A real mouse hovers as
      // it travels (its move hover flushed on an earlier frame); a fast move→down in one frame must not skip that,
      // so flush any pending move hover now, before the press edge.
      flushHover();
      send({ kind: "click", button, pressed: true, coordX: point.coordX, coordY: point.coordY });
      return;
    }

    // Long-press "peek": a lone finger held still on a HAND card for PEEK_MS focuses + lifts it, no play on release.
    if (handCard !== null && raiseHeldCard() !== false) {
      const pointerId = event.pointerId;
      held.peekTimer = setTimeout(() => {
        const p = held;
        if (p === null || p.pointerId !== pointerId || p.dragging || p.peeking || p.handCard === null) return;
        p.peeking = true;
        p.peekTimer = null;
        heldCard?.setHeld(p.handCard, p.down.coordY, "peek");
        send({ kind: "hover", coordX: p.down.coordX, coordY: p.down.coordY });
      }, PEEK_MS);
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (held === null || held.pointerId !== event.pointerId) return;
    releasePointer(event.pointerId);
    const gesture = held;
    const point = map(event.clientX, event.clientY);
    endHeld("up");
    if (point === null) {
      clearOverlayState();
      return;
    }

    if (gesture.pointerType !== "touch") {
      // Mouse/pen release: the pair of the press sent on down.
      send({ kind: "click", button: gesture.button, pressed: false, coordX: point.coordX, coordY: point.coordY });
      return;
    }

    if (gesture.dragging) {
      send({ kind: "click", button: gesture.button, pressed: false, coordX: point.coordX, coordY: point.coordY });
      clearOverlayState();
      return;
    }

    if (gesture.peeking) {
      // A long-press peek is lifting: the card was focused + raised but never pressed. Clear the lift, and
      // optionally un-focus by re-hovering the seat centre (a card-free point) so the game drops the focus.
      heldCard?.setHeld(null, point.coordY, "drag");
      clearArmed();
      if (unfocusOnRelease() !== false) {
        const r = stage.getBoundingClientRect();
        const centre = map(r.left + r.width / 2, r.top + r.height / 2);
        if (centre !== null) send({ kind: "hover", coordX: centre.coordX, coordY: centre.coordY });
      }
      return;
    }

    // A single-finger TAP. CONFIRM TAP takes priority on a confirm-eligible widget: the tap only focuses, and the
    // button commits — a bare tap can never spend a reward there.
    if (confirmTapEnabled() === true && confirmTap !== undefined) {
      const hit = confirmTap.classify(point.item ?? -1);
      if (hit !== null) {
        confirmCoord = { coordX: point.coordX, coordY: point.coordY };
        confirmTap.show(hit.id, hit.kind);
        send({ kind: "hover", coordX: point.coordX, coordY: point.coordY });
        clearArmed();
        return;
      }
    }

    // With tap-to-focus on, a tap on a drawn item arms it (hover); a re-tap of the SAME item within the debounce
    // window is swallowed, and a later re-tap commits (a full click). A tap on clear colour commits immediately.
    if (tapToFocus?.() !== true) {
      fullClick("left", point);
      return;
    }
    if (point.item !== null && armedItem === point.item) {
      if (clock() - armedAtMs < TAP_ARM_DEBOUNCE_MS) return; // finger bounce
      clearArmed();
      fullClick("left", point);
      return;
    }
    if (point.item !== null) {
      armedItem = point.item;
      armedAtMs = clock();
      send({ kind: "hover", coordX: point.coordX, coordY: point.coordY });
      return;
    }
    clearArmed();
    fullClick("left", point);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (held === null || held.pointerId !== event.pointerId) return;
    releasePointer(event.pointerId);
    const gesture = held;
    endHeld("cancel");
    clearOverlayState();
    // A cancelled gesture is never a tap; if a press already went out, retract it at the frozen point so the
    // game never keeps a button latched down.
    if (gesture.pointerType !== "touch" || gesture.dragging) {
      const point = map(event.clientX, event.clientY) ?? gesture.down;
      send({ kind: "click", button: gesture.button, pressed: false, coordX: point.coordX, coordY: point.coordY });
    }
  }

  function onContextMenu(event: MouseEvent): void {
    // The browser menu is suppressed; the right-click itself is a full click at the mapped point.
    event.preventDefault();
    const point = map(event.clientX, event.clientY);
    if (point === null) return;
    fullClick("right", point);
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const point = map(event.clientX, event.clientY);
    if (point === null) return;
    fullClick(event.deltaY < 0 ? "wheel-up" : "wheel-down", point);
  }

  function commitConfirm(): void {
    const coord = confirmCoord;
    if (coord === null) return;
    confirmCoord = null;
    confirmTap?.hide();
    send({ kind: "click", button: "left", coordX: coord.coordX, coordY: coord.coordY });
  }

  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerCancel);
  stage.addEventListener("contextmenu", onContextMenu);
  stage.addEventListener("wheel", onWheel, { passive: false });

  return {
    dispose(): void {
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointercancel", onPointerCancel);
      stage.removeEventListener("contextmenu", onContextMenu);
      stage.removeEventListener("wheel", onWheel);
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
      hoverFrame = null;
      pendingHover = null;
      if (held !== null) {
        clearPeekTimer(held);
        releasePointer(held.pointerId);
      }
      held = null;
      clearArmed();
      clearOverlayState();
    },
    commitConfirm
  };
}
