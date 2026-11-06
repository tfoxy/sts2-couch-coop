// streamInput.ts — the render-stream POINTER channel (INP2, rebuilt on godot-scene-web's capture in C2). Mouse, pen,
// touch and wheel over the stream canvas reach the seat as the SAME coordinate-only `MirrorInputMessage`s the old
// mirror's inputCapture emits, so nothing host-side changed:
//   * hover           {kind:"hover", coordX, coordY}                                  (one per animation frame)
//   * press/release   {kind:"click", button, pressed:true|false, coordX, coordY}      (edges: a mouse button, a drag)
//   * full click      {kind:"click", button, coordX, coordY}                          (a tap, a confirm commit)
//   * wheel tick      {kind:"click", button:"wheel-up"|"wheel-down", coordX, coordY}
//
// THE CAPTURE IS GODOT-SCENE-WEB'S: `@godot-scene-web/input/pointer` in `mode: "mouse"` owns reading the pointer —
// button edges from the `buttons` diff (chords included), the one-mouse state, hover-first presses, the touch slop,
// tap / drag / two-finger wheel, and every release guarantee (a press that went out is released on pointerup off the
// picture at the last mapped point, on pointercancel, lost capture, blur, a hidden tab, pagehide and dispose). Its
// `map` is INP1's `clientToGame(..)?.point`, so a raised or scaled card's tap still reaches its game centre (the hit
// item's override inverse) and a letterbox bar maps to nothing. This module is couch's ADAPTER around it:
//
//   * THE SINK turns GSW's records into couch messages: `mouse_motion` → hover; a `mouse_button` LEFT/RIGHT/MIDDLE
//     edge → a press/release; a press+release pair GSW makes for a tap (or for couch's own `click()`) → ONE full
//     click; a wheel step → one `wheel-up`/`wheel-down` (its factor is dropped: one tick per wheel event, as before);
//     horizontal wheel and X1/X2 have no couch token and are dropped.
//   * THE STAGE GSW listens on is a thin proxy over the canvas that (a) coalesces pointermoves to the newest per
//     pointer per animation frame, so INP1's `clientToGame` (a hit test) runs once per frame, not per event — every
//     other pointer event first delivers the pending moves, and GSW's own motion frame is drained inside the same
//     frame; and (b) repairs `buttons` on script-made events (a pointerdown always holds its own button, a pointerup
//     never does, an untrusted move that reports no buttons keeps the held ones), which a trusted event already
//     satisfies.
//   * COUCH'S STS2 GESTURES are GSW `intercept` hooks (docs/input.md "Mouse mode" recipes in ../godot-scene-web):
//       - TAP TO FOCUS (`tapToFocus`, live): a tap on a drawn item not yet armed only hovers it (swallowed); a re-tap
//         of the armed item past TAP_ARM_DEBOUNCE_MS commits (a sooner one is a finger bounce, swallowed); a tap on
//         clear colour commits at once.
//       - HELD-CARD LIFT (`raiseHeldCard` + `unfocusOnRelease`, live): a still hold on a hand card for PEEK_MS is a
//         "peek" (the long-press is swallowed, so the finger stays a potential tap or drag): focus + lift, never a
//         play. The tap that ends a peek is swallowed and, with `unfocusOnRelease`, re-hovers the seat centre so the
//         game drops the focus. A touch drag on a hand card lifts it above the fingertip.
//       - CONFIRM TAP (`confirmTap`): a tap on a confirm-eligible widget only focuses it and raises the button;
//         `commitConfirm` clicks through GSW's `click()` at the focus point. Any later press on the canvas (a finger
//         down, or a mouse press: mouse presses make no gestures, so the sink sees them) dismisses it.
//     Releases (`drag-end`) and `touch-end` are observe-only (GSW decision D6): no hook can keep a press held.
//   * RIGHT CLICK: the mouse's right button is an edge pair like any other. A `contextmenu` that no pointer made
//     (the keyboard's menu key) stays what it was before: one full right click at the mapped point.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*`, `@/stream-ext/*` and the GSW input package.

import { MouseButton, type InputRecord, type InputSink, type InputVec2 } from "@godot-scene-web/input";
import {
  createPointerCapture,
  type PointerCapture,
  type PointerEventLike,
  type PointerEventTargetLike,
  type PointerGesture,
  type PointerGestureDecision,
  type PointerStageLike
} from "@godot-scene-web/input/pointer";

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
/** CSS px either finger travels before a two-finger drift scrolls (GSW's default scroll slop). */
export const TWO_FINGER_SCROLL_PX = 16;
/**
 * Vertical two-finger centroid travel (presentation px, which are the seat's host px) per wheel tick — the old
 * mirror's WHEEL_STEP_DESIGN. Deliberately chunky: clicks are never coalesced, so a per-pixel tick would flood the wire.
 */
export const TWO_FINGER_WHEEL_STEP_PX = 56;

type CouchButton = NonNullable<MirrorInputMessage["button"]>;

/** GSW button index → couch's token; X1/X2 and horizontal wheel have none. */
function couchButton(button: number): CouchButton | null {
  switch (button) {
    case MouseButton.LEFT:
      return "left";
    case MouseButton.RIGHT:
      return "right";
    case MouseButton.MIDDLE:
      return "middle";
    case MouseButton.WHEEL_UP:
      return "wheel-up";
    case MouseButton.WHEEL_DOWN:
      return "wheel-down";
    default:
      return null;
  }
}

/** DOM `button` 0..5 → its `buttons` bit (left, middle, right, back, forward, pen eraser). */
const DOM_BUTTON_BIT: readonly number[] = [1, 4, 2, 8, 16, 32];

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

type Listener = (event: { type: string }) => void;

/** The touch gesture couch is tracking (from GSW's `touch-down` to its `touch-end`). */
interface TouchState {
  /** The hand card under the finger at touch-down (for the lift and the peek), or null. */
  readonly handCard: number | null;
  /** The game Y the finger landed at (where a peek that ends off the picture clears the lift). */
  readonly downY: number;
  /** The long-press peek has focused + lifted the card (its release is then never a tap). */
  peeking: boolean;
}

export function createStreamInput(options: StreamInputOptions): StreamInput {
  const { stage, getClient, send, tapToFocus, heldCard, confirmTap } = options;
  const raiseHeldCard = options.raiseHeldCard ?? (() => true);
  const unfocusOnRelease = options.unfocusOnRelease ?? (() => true);
  const confirmTapEnabled = options.confirmTapEnabled ?? (() => false);
  const clock = options.now ?? nowMs;

  // TAP TO FOCUS: the item armed by the first tap (and when), so a re-tap commits and a different item re-arms.
  let armedItem: number | null = null;
  let armedAtMs = 0;
  // CONFIRM TAP: the game coordinate the focus hover went to, replayed by the commit.
  let confirmCoord: InputVec2 | null = null;
  let touch: TouchState | null = null;
  let disposed = false;

  // ── mapping ──────────────────────────────────────────────────────────────────────────────────────────────────
  // One `clientToGame` answer is remembered for the rest of the turn (an event, a frame, a commit), so a gesture
  // hook asking for the item under a point GSW just mapped costs no second hit test.
  let memo: { client: StreamInputClient | null; x: number; y: number; game: StreamGamePoint | null } | null = null;

  function lookup(clientX: number, clientY: number): StreamGamePoint | null {
    const client = getClient();
    if (memo !== null && memo.client === client && memo.x === clientX && memo.y === clientY) return memo.game;
    const game = client?.clientToGame(clientX, clientY) ?? null;
    memo = { client, x: clientX, y: clientY, game };
    return game;
  }

  function itemAt(clientX: number, clientY: number): number | null {
    return lookup(clientX, clientY)?.item ?? null;
  }

  // ── the sink: GSW records → couch messages ──────────────────────────────────────────────────────────────────
  // Inside a click scope (GSW's default tap records, couch's own `click()` calls) a press and the release that
  // follows it are ONE full click; everywhere else a press and a release are separate edges.
  let clickScope = 0;
  let scopedPress: { button: CouchButton; at: InputVec2 } | null = null;

  function coord(position: InputVec2): { coordX: number; coordY: number } {
    return { coordX: position[0], coordY: position[1] };
  }

  const sink: InputSink = {
    push(record: InputRecord): void {
      if (record.event === "mouse_motion") {
        send({ kind: "hover", ...coord(record.position) });
        return;
      }
      if (record.event !== "mouse_button") return;
      const button = record.button_index;
      const name = couchButton(button);
      if (button >= MouseButton.WHEEL_UP && button <= MouseButton.WHEEL_RIGHT) {
        // A wheel step is a press+release pair; couch's tick is one message, on the press.
        if (record.pressed && name !== null) send({ kind: "click", button: name, ...coord(record.position) });
        return;
      }
      if (record.pressed) {
        if (clickScope > 0) {
          flushScopedPress();
          if (name !== null) scopedPress = { button: name, at: record.position };
          return;
        }
        // Any real press on the picture dismisses a confirm button an earlier tap raised.
        dismissConfirm();
        if (name !== null) send({ kind: "click", button: name, pressed: true, ...coord(record.position) });
        return;
      }
      if (name === null) return;
      if (scopedPress !== null && scopedPress.button === name) {
        scopedPress = null;
        send({ kind: "click", button: name, ...coord(record.position) });
        return;
      }
      send({ kind: "click", button: name, pressed: false, ...coord(record.position) });
    }
  };

  /** A scoped press whose release never came: it did go out, so it goes out as the edge it is. */
  function flushScopedPress(): void {
    const press = scopedPress;
    scopedPress = null;
    if (press !== null) send({ kind: "click", button: press.button, pressed: true, ...coord(press.at) });
  }

  function inClickScope(work: () => void): void {
    clickScope += 1;
    try {
      work();
    } finally {
      clickScope -= 1;
      if (clickScope === 0) flushScopedPress();
    }
  }

  // ── the stage proxy: move coalescing + `buttons` repair ─────────────────────────────────────────────────────

  /** Each pointer's `buttons` as last delivered (mouse/pen), for the untrusted-move repair and the chord test. */
  const deliveredButtons = new Map<number, number>();
  /** Touch pointers down on the stage (a contextmenu while one is down is the browser's long-press menu). */
  const touchesDown = new Set<number>();
  /** The newest undelivered pointermove per pointer, and the listener it is for. */
  const pendingMoves = new Map<number, { event: PointerEventLike; listener: Listener }>();
  /** GSW's own frame callbacks (its motion coalescing), drained inside couch's frame. */
  const gswFrames = new Map<number, (time: number) => void>();
  let gswFrameHandle = 0;
  let frameHandle: number | null = null;
  let inFrame = false;

  function requestFrame(): void {
    if (frameHandle !== null || inFrame || disposed) return;
    frameHandle = requestAnimationFrame(runFrame);
  }

  function runFrame(time: number): void {
    frameHandle = null;
    inFrame = true;
    try {
      deliverPendingMoves();
      while (gswFrames.size > 0) {
        const callbacks = [...gswFrames.values()];
        gswFrames.clear();
        for (const callback of callbacks) callback(time);
      }
    } finally {
      inFrame = false;
      memo = null;
    }
  }

  function deliverPendingMoves(): void {
    if (pendingMoves.size === 0) return;
    const moves = [...pendingMoves.values()];
    pendingMoves.clear();
    for (const { event, listener } of moves) listener(event);
  }

  /** Run one turn of input: pending moves first (so order holds), then `work`; the mapping memo ends with it. */
  function turn(work: () => void): void {
    try {
      deliverPendingMoves();
      work();
    } finally {
      memo = null;
    }
  }

  function repairedButtons(event: PointerEvent): number {
    let buttons = typeof event.buttons === "number" ? event.buttons : 0;
    if (event.pointerType === "touch") return buttons;
    const bit = DOM_BUTTON_BIT[event.button] ?? 0;
    if (event.type === "pointerdown") buttons |= bit;
    else if (event.type === "pointerup") buttons &= ~bit;
    else if (event.type === "pointermove" && !event.isTrusted && buttons === 0) {
      buttons = deliveredButtons.get(event.pointerId) ?? 0;
    }
    return buttons;
  }

  function view(event: PointerEvent): PointerEventLike {
    const buttons = repairedButtons(event);
    return {
      type: event.type,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: event.button,
      buttons,
      clientX: event.clientX,
      clientY: event.clientY,
      detail: event.detail,
      movementX: event.movementX,
      movementY: event.movementY,
      pressure: event.pressure,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      preventDefault: () => event.preventDefault()
    };
  }

  function noteDelivered(event: PointerEventLike): void {
    if (event.pointerType === "touch") {
      if (event.type === "pointerdown") touchesDown.add(event.pointerId);
      else if (event.type !== "pointermove") touchesDown.delete(event.pointerId);
      return;
    }
    if (event.buttons === 0 || event.type === "pointercancel") deliveredButtons.delete(event.pointerId);
    else deliveredButtons.set(event.pointerId, event.buttons);
  }

  function wrap(type: string, listener: Listener): Listener {
    if (type === "pointermove") {
      return (raw) => {
        if (disposed) return;
        const event = view(raw as PointerEvent);
        const chord =
          event.pointerType !== "touch" && event.buttons !== (deliveredButtons.get(event.pointerId) ?? 0);
        if (chord) {
          // A button edge riding a move (a chord): deliver it now, after whatever was pending.
          pendingMoves.delete(event.pointerId);
          turn(() => {
            noteDelivered(event);
            listener(event);
          });
          return;
        }
        pendingMoves.set(event.pointerId, {
          event,
          listener: (e) => {
            noteDelivered(e as PointerEventLike);
            listener(e);
          }
        });
        requestFrame();
      };
    }
    if (type.startsWith("pointer") || type === "lostpointercapture") {
      return (raw) => {
        if (disposed) return;
        const event = view(raw as PointerEvent);
        turn(() => {
          noteDelivered(event);
          listener(event);
        });
      };
    }
    return (raw) => {
      if (disposed) return;
      turn(() => listener(raw));
    };
  }

  const stageWrapped = new Map<string, Map<Listener, Listener>>();
  const stageProxy: PointerStageLike = {
    addEventListener(type, listener, opts) {
      const wrapped = wrap(type, listener);
      let byType = stageWrapped.get(type);
      if (byType === undefined) stageWrapped.set(type, (byType = new Map()));
      byType.set(listener, wrapped);
      stage.addEventListener(type, wrapped as EventListener, opts);
    },
    removeEventListener(type, listener) {
      const wrapped = stageWrapped.get(type)?.get(listener);
      if (wrapped === undefined) return;
      stageWrapped.get(type)?.delete(listener);
      stage.removeEventListener(type, wrapped as EventListener);
    },
    setPointerCapture: (pointerId) => stage.setPointerCapture(pointerId),
    focus: (focusOptions) => stage.focus(focusOptions),
    getAttribute: (name) => stage.getAttribute(name),
    setAttribute: (name, value) => stage.setAttribute(name, value),
    removeAttribute: (name) => stage.removeAttribute(name),
    style: stage.style
  };

  // The window copy GSW keeps (a pointerup or cancel the stage missed, blur, pagehide) delivers pending moves first.
  const windowWrapped = new Map<string, Map<Listener, Listener>>();
  const windowProxy: PointerEventTargetLike | null =
    typeof window === "undefined"
      ? null
      : {
          addEventListener(type, listener) {
            const wrapped: Listener = (raw) => {
              if (disposed) return;
              turn(() => listener(raw));
            };
            let byType = windowWrapped.get(type);
            if (byType === undefined) windowWrapped.set(type, (byType = new Map()));
            byType.set(listener, wrapped);
            window.addEventListener(type, wrapped as EventListener);
          },
          removeEventListener(type, listener) {
            const wrapped = windowWrapped.get(type)?.get(listener);
            if (wrapped === undefined) return;
            windowWrapped.get(type)?.delete(listener);
            window.removeEventListener(type, wrapped as EventListener);
          }
        };

  // ── gestures ─────────────────────────────────────────────────────────────────────────────────────────────────

  function clearArmed(): void {
    armedItem = null;
    armedAtMs = 0;
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

  function hover(position: InputVec2, clientX: number, clientY: number): void {
    capture.hover(position, [clientX, clientY]);
  }

  /** A peek is lifting: clear the lift (never a play), and optionally hover the seat centre to drop the focus. */
  function endPeek(state: TouchState, gameY: number): void {
    state.peeking = false;
    heldCard?.setHeld(null, gameY, "drag");
    clearArmed();
    if (unfocusOnRelease() === false) return;
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const centre = lookup(cx, cy);
    if (centre !== null) hover([centre.point.x, centre.point.y], cx, cy);
  }

  function interceptTap(gesture: PointerGesture, at: InputVec2): PointerGestureDecision {
    const state = touch;
    if (state?.peeking === true) {
      endPeek(state, at[1]);
      return "swallow";
    }
    const item = itemAt(gesture.clientX, gesture.clientY);
    // CONFIRM TAP first: on a confirm-eligible widget the tap only focuses, and the button commits — a bare tap can
    // never spend a reward there.
    if (confirmTapEnabled() === true && confirmTap !== undefined) {
      const hit = confirmTap.classify(item ?? -1);
      if (hit !== null) {
        confirmCoord = [at[0], at[1]];
        confirmTap.show(hit.id, hit.kind);
        hover(at, gesture.clientX, gesture.clientY);
        clearArmed();
        return "swallow";
      }
    }
    if (tapToFocus?.() !== true) return "send";
    if (item !== null && armedItem === item) {
      if (clock() - armedAtMs < TAP_ARM_DEBOUNCE_MS) return "swallow"; // finger bounce
      clearArmed();
      return "send";
    }
    if (item !== null) {
      armedItem = item;
      armedAtMs = clock();
      hover(at, gesture.clientX, gesture.clientY);
      return "swallow";
    }
    clearArmed();
    return "send";
  }

  function intercept(gesture: PointerGesture): PointerGestureDecision {
    const at = gesture.position;
    if (at === null) return "send";
    switch (gesture.kind) {
      case "touch-down": {
        // A new finger on the picture dismisses a confirm button an earlier tap raised (a tap on the same widget
        // raises it again). The button itself is outside the canvas, so its own presses never get here.
        dismissConfirm();
        const item = itemAt(gesture.clientX, gesture.clientY);
        const handCard = item !== null && heldCard !== undefined ? heldCard.handCardFor(item) : null;
        touch = { handCard, downY: at[1], peeking: false };
        return "send";
      }
      case "long-press": {
        // Never GSW's default long-press right click. On a hand card (lift on) it is the peek; the finger stays a
        // potential tap or drag either way.
        const state = touch;
        if (state !== null && state.handCard !== null && !state.peeking && raiseHeldCard() !== false) {
          state.peeking = true;
          heldCard?.setHeld(state.handCard, at[1], "peek");
          hover(at, gesture.clientX, gesture.clientY);
        }
        return "swallow";
      }
      case "tap": {
        const decision = interceptTap(gesture, at);
        // GSW's default tap records (motion, LEFT press + release) are couch's hover + ONE full click.
        if (decision === "send") clickScope += 1;
        return decision;
      }
      case "drag-start":
        // A peek that travels is a drag from here on: its release is the drag's, never a peek release.
        if (touch !== null) touch.peeking = false;
        dismissConfirm();
        return "send";
      case "drag-move": {
        // HELD-CARD LIFT: a dragged hand card follows the finger above the fingertip.
        const state = touch;
        if (state !== null && state.handCard !== null && raiseHeldCard() !== false) {
          heldCard?.setHeld(state.handCard, at[1], "drag");
        }
        return "send";
      }
      default:
        return "send";
    }
  }

  function onGesture(gesture: PointerGesture, decision: PointerGestureDecision): void {
    switch (gesture.kind) {
      case "tap":
        if (decision === "send") {
          clickScope -= 1;
          if (clickScope === 0) flushScopedPress();
        }
        return;
      case "scroll-start": {
        // A second finger turned the gesture into a scroll: a peek it interrupted drops its lift.
        const state = touch;
        if (state?.peeking === true) {
          state.peeking = false;
          heldCard?.setHeld(null, state.downY, "drag");
        }
        clearArmed();
        return;
      }
      case "drag-end":
        clearOverlayState();
        return;
      case "touch-end": {
        const state = touch;
        touch = null;
        if (gesture.canceled === true) {
          clearOverlayState();
          return;
        }
        // A peek lifted off the picture (no tap came): clear it all the same.
        if (state?.peeking === true) {
          endPeek(state, gesture.position?.[1] ?? state.downY);
          return;
        }
        // A tap lifted off the picture: nothing was pressed, so nothing is owed — just drop any overlay.
        if (gesture.position === null) clearOverlayState();
        return;
      }
      default:
        return;
    }
  }

  // ── the capture ──────────────────────────────────────────────────────────────────────────────────────────────

  const capture: PointerCapture = createPointerCapture({
    stage: stageProxy,
    mode: "mouse",
    map: (clientX, clientY) => lookup(clientX, clientY)?.point ?? null,
    sink,
    gestures: {
      touchSlop: TOUCH_SLOP_PX,
      longPressMs: heldCard !== undefined ? PEEK_MS : 0,
      scrollSlop: TWO_FINGER_SCROLL_PX,
      wheelStep: TWO_FINGER_WHEEL_STEP_PX,
      intercept,
      onGesture
    },
    events: windowProxy,
    now: clock,
    requestAnimationFrame: (callback) => {
      gswFrameHandle += 1;
      gswFrames.set(gswFrameHandle, callback);
      requestFrame();
      return gswFrameHandle;
    },
    cancelAnimationFrame: (handle) => {
      gswFrames.delete(handle);
    }
  });

  // RIGHT CLICK from a `contextmenu` no pointer made (the keyboard's menu key). A mouse right button already went
  // out as its edges (its contextmenu reports button 2), and a touch long-press menu is not a click.
  function onContextMenu(event: MouseEvent): void {
    if (disposed) return;
    event.preventDefault();
    const pointerType = (event as Partial<PointerEvent>).pointerType;
    if (event.button === 2 || pointerType === "touch" || pointerType === "pen" || touchesDown.size > 0) return;
    turn(() => {
      const game = lookup(event.clientX, event.clientY);
      if (game === null) return;
      const at: InputVec2 = [game.point.x, game.point.y];
      inClickScope(() => capture.click(MouseButton.RIGHT, at, [event.clientX, event.clientY]));
    });
  }
  stage.addEventListener("contextmenu", onContextMenu);

  function commitConfirm(): void {
    const at = confirmCoord;
    if (at === null || disposed) return;
    confirmCoord = null;
    confirmTap?.hide();
    turn(() => inClickScope(() => capture.click(MouseButton.LEFT, at)));
  }

  return {
    dispose(): void {
      if (disposed) return;
      // GSW releases whatever is held (at the last point, `canceled`) before it lets go of the listeners: the seat
      // outlives this channel and would otherwise keep the button down.
      pendingMoves.clear();
      capture.dispose();
      disposed = true;
      stage.removeEventListener("contextmenu", onContextMenu);
      if (frameHandle !== null) cancelAnimationFrame(frameHandle);
      frameHandle = null;
      gswFrames.clear();
      memo = null;
      touch = null;
      clearArmed();
      clearOverlayState();
    },
    commitConfirm
  };
}
