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
// item, a second tap on the same item commits). Every press edge is preceded by a hover at its point, on touch as
// on mouse, because the game's hover-first widgets (character select, say) ignore a press the cursor never reached.
//
// A press that went out is ALWAYS released: a release over a letterbox bar or off the canvas (pointer capture still
// delivers it) goes out at the last point that mapped, and `dispose()` releases a press still held. Moves are
// mapped once per frame (in the hover flush), not per event.
//
// TWO FINGERS (the old mirror's two-finger scroll): a second finger landing while the first is still a potential
// tap turns the gesture into a two-finger drag, whose vertical centroid drift becomes chunky wheel ticks (natural
// scroll) at the latch centroid. It never presses, so there is nothing to retract.
//
// UN-FORCED SINCE INP2's successor: two of the old mirror's touch features now ride this channel, driven by the
// stream-ext modules' controllers (which own the item identity, the lift override and the confirm button):
//   * HELD-CARD LIFT (`raiseHeldCard` + `unfocusOnRelease`): a still hold on a hand card for PEEK_MS is a "peek" —
//     focus + lift, no play on release — and a touch drag lifts the card above the fingertip. On a peek release,
//     `unfocusOnRelease` re-hovers the seat centre so the game drops the focus and the card returns to the hand.
//   * CONFIRM TAP (`confirmTap`): a tap that lands on a confirm-eligible widget only focuses it and shows the
//     button; the button commits (a left click re-sent at the focus coordinate, via `commitConfirm`). Any later
//     press on the canvas dismisses the button.
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
/** Two-finger travel (presentation px) past which the gesture is a scroll (the old mirror's TWO_FINGER_CANCEL). */
export const TWO_FINGER_SCROLL_PX = 24;
/**
 * Vertical two-finger centroid travel (presentation px) per wheel tick — the old mirror's WHEEL_STEP_DESIGN.
 * Deliberately chunky: clicks are never coalesced, so a per-pixel tick would flood the wire.
 */
export const TWO_FINGER_WHEEL_STEP_PX = 56;
/** Every seat presents W×1080; a non-canvas stage (a spec's div) is measured against the same height. */
const PRESENTATION_HEIGHT = 1080;

type HeldButton = "left" | "right" | "middle";

interface GameCoord {
  readonly coordX: number;
  readonly coordY: number;
}

interface HeldGesture {
  readonly pointerId: number;
  readonly button: HeldButton;
  readonly pointerType: string;
  /** The mapped press point (game px) — sent as the press when a touch crosses the slop. */
  readonly down: GameCoord;
  /** The raw client position the press started at, for the slop test and the two-finger latch. */
  readonly startClientX: number;
  readonly startClientY: number;
  /** The last client position seen for this pointer. */
  lastClientX: number;
  lastClientY: number;
  /** The last game point this pointer's motion mapped to — where a release that maps nowhere goes out. */
  lastMapped: GameCoord | null;
  dragging: boolean;
  /** The hand card under the finger at press (for the lift), or null. */
  handCard: number | null;
  /** The long-press peek timer (touch only). */
  peekTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the long-press peek has fired (the release is then a peek release, never a tap). */
  peeking: boolean;
}

interface TwoFingerPointer {
  readonly startX: number;
  readonly startY: number;
  lastY: number;
}

interface TwoFingerGesture {
  readonly pointers: Map<number, TwoFingerPointer>;
  /** Where the wheel ticks go: the latch centroid, mapped once. */
  readonly at: GameCoord;
  /** Presentation px per client px (vertical), measured once at the latch. */
  readonly scale: number;
  /** The client centroid Y at the previous sample. */
  prevCentroidY: number;
  /** Unspent vertical drift (presentation px) since the last tick. */
  accumY: number;
  /** Either finger has travelled past TWO_FINGER_SCROLL_PX: the drift now scrolls. */
  moved: boolean;
  /** A finger has lifted: the remaining one is inert until it lifts too. */
  lifted: boolean;
}

interface PointWithItem extends GameCoord {
  readonly item: number | null;
}

interface PendingHover {
  readonly clientX: number;
  readonly clientY: number;
  /** The pointer whose motion queued it (its held gesture records the mapped point). */
  readonly pointerId: number;
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
  let twoFinger: TwoFingerGesture | null = null;
  // TAP TO FOCUS: the item armed by the first tap (and when), so a re-tap commits and a different item re-arms.
  let armedItem: number | null = null;
  let armedAtMs = 0;
  // CONFIRM TAP: the game coordinate the focus hover went to, replayed verbatim by the commit.
  let confirmCoord: GameCoord | null = null;
  // Hover coalescing: the newest RAW move, mapped and sent once per animation frame in the frame callback.
  let pendingHover: PendingHover | null = null;
  let hoverFrame: number | null = null;

  /** INP1's mapping: page px → the game-space point and the item drawn there, or null on a letterbox bar. */
  function map(clientX: number, clientY: number): PointWithItem | null {
    const game = getClient()?.clientToGame(clientX, clientY);
    if (game === null || game === undefined) return null;
    return { coordX: game.point.x, coordY: game.point.y, item: game.item };
  }

  function hover(at: GameCoord): void {
    send({ kind: "hover", coordX: at.coordX, coordY: at.coordY });
  }

  function release(button: HeldButton, at: GameCoord): void {
    send({ kind: "click", button, pressed: false, coordX: at.coordX, coordY: at.coordY });
  }

  function flushHover(): void {
    hoverFrame = null;
    const h = pendingHover;
    pendingHover = null;
    if (h === null) return;
    const point = map(h.clientX, h.clientY);
    if (point === null) return; // off the picture: no hover, but the gesture keeps tracking
    const g = held;
    if (g !== null && g.pointerId === h.pointerId) {
      g.lastMapped = { coordX: point.coordX, coordY: point.coordY };
      // HELD-CARD LIFT: a dragged hand card follows the finger above the fingertip.
      if (g.pointerType === "touch" && g.dragging && g.handCard !== null && raiseHeldCard() !== false) {
        heldCard?.setHeld(g.handCard, point.coordY, "drag");
      }
    }
    hover(point);
  }

  function scheduleHover(clientX: number, clientY: number, pointerId: number): void {
    pendingHover = { clientX, clientY, pointerId };
    if (hoverFrame === null) hoverFrame = requestAnimationFrame(flushHover);
  }

  function dropPendingHover(): void {
    if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
    hoverFrame = null;
    pendingHover = null;
  }

  function fullClick(button: "left" | "right" | "wheel-up" | "wheel-down", point: GameCoord): void {
    send({ kind: "click", button, coordX: point.coordX, coordY: point.coordY });
  }

  /** A touch tap's click: the cursor goes to the point first, as a mouse's would have travelled there. */
  function tapClick(point: GameCoord): void {
    hover(point);
    fullClick("left", point);
  }

  function capturePointer(pointerId: number): void {
    try {
      stage.setPointerCapture(pointerId);
    } catch {
      // Capture is best-effort (a synthetic event in a spec); the gesture still replays.
    }
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

  function dismissConfirm(): void {
    if (confirmCoord !== null) {
      confirmCoord = null;
      confirmTap?.hide();
    }
  }

  /** Drop the lift and the button, so neither outlives the gesture that raised it. */
  function clearOverlayState(): void {
    heldCard?.setHeld(null, 0, "drag");
    dismissConfirm();
  }

  function endHeld(): void {
    if (held !== null) clearPeekTimer(held);
    held = null;
    // A queued drag-motion hover is superseded by the release/cancel edge; drop it.
    if (pendingHover !== null) dropPendingHover();
  }

  /** Whether a press for this gesture already went out (so the game holds a button that must be released). */
  function pressed(g: HeldGesture): boolean {
    return g.pointerType !== "touch" || g.dragging;
  }

  /** Where a release goes when its own point maps nowhere: the last point that mapped, else the press point. */
  function lastPoint(g: HeldGesture): GameCoord {
    return g.lastMapped ?? g.down;
  }

  // ── two fingers ──────────────────────────────────────────────────────────────────────────────────────────────

  function centroidY(g: TwoFingerGesture): number {
    let sum = 0;
    for (const p of g.pointers.values()) sum += p.lastY;
    return sum / g.pointers.size;
  }

  /** A second finger joined a still first finger: the gesture is a two-finger drag from here on. */
  function beginTwoFinger(first: HeldGesture, event: PointerEvent): void {
    clearPeekTimer(first);
    if (first.peeking) heldCard?.setHeld(null, first.down.coordY, "drag");
    clearArmed();
    held = null;
    dropPendingHover();
    const cx = (first.startClientX + event.clientX) / 2;
    const cy = (first.startClientY + event.clientY) / 2;
    const latch = map(cx, cy);
    const rect = stage.getBoundingClientRect();
    const height = stage instanceof HTMLCanvasElement && stage.height > 0 ? stage.height : PRESENTATION_HEIGHT;
    twoFinger = {
      pointers: new Map([
        [first.pointerId, { startX: first.startClientX, startY: first.startClientY, lastY: first.lastClientY }],
        [event.pointerId, { startX: event.clientX, startY: event.clientY, lastY: event.clientY }]
      ]),
      at: latch === null ? first.down : { coordX: latch.coordX, coordY: latch.coordY },
      scale: rect.height > 0 ? height / rect.height : 1,
      prevCentroidY: 0,
      accumY: 0,
      moved: false,
      lifted: false
    };
    twoFinger.prevCentroidY = centroidY(twoFinger);
    capturePointer(event.pointerId);
  }

  function twoFingerMove(g: TwoFingerGesture, event: PointerEvent): void {
    const p = g.pointers.get(event.pointerId);
    if (p === undefined || g.lifted) return;
    p.lastY = event.clientY;
    if (!g.moved) {
      const dx = (event.clientX - p.startX) * g.scale;
      const dy = (event.clientY - p.startY) * g.scale;
      if (dx * dx + dy * dy < TWO_FINGER_SCROLL_PX * TWO_FINGER_SCROLL_PX) return;
      g.moved = true;
    }
    // NATURAL touch scroll: fingers DOWN (drift > 0) ⇒ wheel-up; fingers UP ⇒ wheel-down. One tick per step of
    // unspent drift (several in one move when a fast drag covers several steps), the remainder carried.
    const cy = centroidY(g);
    g.accumY += (cy - g.prevCentroidY) * g.scale;
    g.prevCentroidY = cy;
    while (Math.abs(g.accumY) >= TWO_FINGER_WHEEL_STEP_PX) {
      const up = g.accumY > 0;
      g.accumY -= (up ? 1 : -1) * TWO_FINGER_WHEEL_STEP_PX;
      fullClick(up ? "wheel-up" : "wheel-down", g.at);
    }
  }

  /** A two-finger pointer lifted or was cancelled; the gesture ends when both have. */
  function twoFingerEnd(g: TwoFingerGesture, pointerId: number): void {
    releasePointer(pointerId);
    g.pointers.delete(pointerId);
    g.lifted = true;
    if (g.pointers.size === 0) twoFinger = null;
  }

  // ── pointer events ───────────────────────────────────────────────────────────────────────────────────────────

  function onPointerMove(event: PointerEvent): void {
    const g2 = twoFinger;
    if (g2 !== null) {
      if (g2.pointers.has(event.pointerId)) twoFingerMove(g2, event);
      return;
    }
    const g = held;
    if (g !== null) {
      if (g.pointerId !== event.pointerId) return; // a stray finger never moves the cursor
      g.lastClientX = event.clientX;
      g.lastClientY = event.clientY;
      if (g.pointerType === "touch" && !g.dragging) {
        // Touch: below the slop it is still a potential tap (nothing sent); past it, become a drag. Measured on the
        // raw client travel, so a finger sliding off the picture still becomes (and stays) a drag.
        const dx = event.clientX - g.startClientX;
        const dy = event.clientY - g.startClientY;
        if (dx * dx + dy * dy < TOUCH_SLOP_PX * TOUCH_SLOP_PX) return;
        g.dragging = true;
        clearPeekTimer(g); // a drag is not a peek
        dismissConfirm();
        hover(g.down);
        send({ kind: "click", button: g.button, pressed: true, coordX: g.down.coordX, coordY: g.down.coordY });
      }
      // Drag motion (mouse/pen after its press, touch past the slop): the move stream is hover (the game follows it).
      scheduleHover(event.clientX, event.clientY, event.pointerId);
      return;
    }
    // No button held: a plain hover. A touch pointer only moves while down, so one with no gesture is a stray.
    if (event.pointerType === "touch") return;
    scheduleHover(event.clientX, event.clientY, event.pointerId);
  }

  function onPointerDown(event: PointerEvent): void {
    if (twoFinger !== null) return; // a third finger is a stray
    const first = held;
    if (first !== null) {
      // A second finger while the first is still a potential tap starts a two-finger scroll; otherwise a stray.
      if (
        first.pointerType === "touch" &&
        event.pointerType === "touch" &&
        first.pointerId !== event.pointerId &&
        !first.dragging
      ) {
        event.preventDefault();
        dismissConfirm();
        beginTwoFinger(first, event);
      }
      return;
    }
    const button = buttonName(event.button);
    if (button === null) return;
    event.preventDefault();
    capturePointer(event.pointerId);
    const point = map(event.clientX, event.clientY);
    if (point === null) return;
    // Any new press on the picture dismisses a confirm button raised by an earlier tap (a tap on the same widget
    // raises it again on release). The button itself is outside the canvas, so its own presses never get here.
    dismissConfirm();
    const handCard = event.pointerType === "touch" ? handCardAt(point.item) : null;
    const down = { coordX: point.coordX, coordY: point.coordY };
    held = {
      pointerId: event.pointerId,
      button,
      pointerType: event.pointerType,
      down,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      lastMapped: down,
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
        hover(p.down);
      }, PEEK_MS);
    }
  }

  function onPointerUp(event: PointerEvent): void {
    const g2 = twoFinger;
    if (g2 !== null) {
      if (g2.pointers.has(event.pointerId)) twoFingerEnd(g2, event.pointerId);
      return;
    }
    if (held === null || held.pointerId !== event.pointerId) return;
    releasePointer(event.pointerId);
    const gesture = held;
    const point = map(event.clientX, event.clientY);
    endHeld();

    if (pressed(gesture)) {
      // Mouse/pen release, or a touch drag's: the pair of the press already sent. Released where it lifted, or —
      // off the picture (pointer capture still delivers it) — at the last point that mapped, so the game never
      // keeps the button latched.
      release(gesture.button, point ?? lastPoint(gesture));
      if (gesture.pointerType === "touch") clearOverlayState();
      return;
    }

    if (gesture.peeking) {
      // A long-press peek is lifting: the card was focused + raised but never pressed. Clear the lift, and
      // optionally un-focus by re-hovering the seat centre (a card-free point) so the game drops the focus.
      heldCard?.setHeld(null, (point ?? lastPoint(gesture)).coordY, "drag");
      clearArmed();
      if (unfocusOnRelease() !== false) {
        const r = stage.getBoundingClientRect();
        const centre = map(r.left + r.width / 2, r.top + r.height / 2);
        if (centre !== null) hover(centre);
      }
      return;
    }

    if (point === null) {
      // A sub-slop tap lifted off the picture: nothing was pressed, so nothing is owed.
      clearOverlayState();
      return;
    }

    // A single-finger TAP. CONFIRM TAP takes priority on a confirm-eligible widget: the tap only focuses, and the
    // button commits — a bare tap can never spend a reward there.
    if (confirmTapEnabled() === true && confirmTap !== undefined) {
      const hit = confirmTap.classify(point.item ?? -1);
      if (hit !== null) {
        confirmCoord = { coordX: point.coordX, coordY: point.coordY };
        confirmTap.show(hit.id, hit.kind);
        hover(point);
        clearArmed();
        return;
      }
    }

    // With tap-to-focus on, a tap on a drawn item arms it (hover); a re-tap of the SAME item within the debounce
    // window is swallowed, and a later re-tap commits (a full click). A tap on clear colour commits immediately.
    if (tapToFocus?.() !== true) {
      tapClick(point);
      return;
    }
    if (point.item !== null && armedItem === point.item) {
      if (clock() - armedAtMs < TAP_ARM_DEBOUNCE_MS) return; // finger bounce
      clearArmed();
      tapClick(point);
      return;
    }
    if (point.item !== null) {
      armedItem = point.item;
      armedAtMs = clock();
      hover(point);
      return;
    }
    clearArmed();
    tapClick(point);
  }

  function onPointerCancel(event: PointerEvent): void {
    const g2 = twoFinger;
    if (g2 !== null) {
      if (g2.pointers.has(event.pointerId)) twoFingerEnd(g2, event.pointerId);
      return;
    }
    if (held === null || held.pointerId !== event.pointerId) return;
    releasePointer(event.pointerId);
    const gesture = held;
    endHeld();
    clearOverlayState();
    // A cancelled gesture is never a tap; if a press already went out, retract it at the frozen point so the
    // game never keeps a button latched down.
    if (pressed(gesture)) release(gesture.button, map(event.clientX, event.clientY) ?? lastPoint(gesture));
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
      dropPendingHover();
      const gesture = held;
      held = null;
      if (gesture !== null) {
        clearPeekTimer(gesture);
        releasePointer(gesture.pointerId);
        // A press in flight when the channel goes (a settings remount, a hidden-tab dispose, unmount) is released
        // where it last was: the seat outlives this channel and would otherwise keep the button held.
        if (pressed(gesture)) release(gesture.button, lastPoint(gesture));
      }
      if (twoFinger !== null) {
        for (const id of twoFinger.pointers.keys()) releasePointer(id);
        twoFinger = null;
      }
      clearArmed();
      clearOverlayState();
    },
    commitConfirm
  };
}
