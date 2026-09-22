// BROWSER GAMEPAD CAPTURE — the mirror's second upstream input source, beside the pointer/touch/keyboard capture
// (inputCapture.ts).
//
// WHAT GOES ON THE WIRE. Device-neutral, EDGE-ONLY tokens: `{kind:"pad", input:<token>, pressed:true|false}` — one
// message when a control goes down, one when it comes up, and NEVER a per-frame repeat while it is held. The host
// turns the token into the game's own abstract controller input and injects it into this viewer's seat, so the seat
// enters the game's NATIVE controller mode (focus ring, button glyphs, the player's own rebinds) and CouchCoop
// re-implements no navigation of its own. That is also why nothing here carries a coordinate: a pad press is not a
// place on the stage, and the game decides what it means.
//
// WHY THIS IS NOT PART OF inputCapture.ts. Different lifecycle (a POLLED device, not DOM events), no coordinate
// resolution, no DOM probes, and none of the gesture state machine's vocabulary. The only thing the two share is
// the send path.
//
// POLLING. The Gamepad API has no input events — a pad is a per-frame snapshot — so this drives an rAF poll and
// edge-detects each frame against the previous one. The loop runs ONLY while there is something to read:
// `gamepadconnected` starts it, a frame with no usable pad (or a hidden page, or the setting off, or dispose)
// stops it. A browser with no pad attached therefore costs exactly two idle listeners.
//
// A STICK DEFLECTION IS SENT AS ITS D-PAD TOKEN, and only that. The game binds `ui_*` navigation to the d-pad
// alone, and its own engine-side strategy already translates a stick deflection into the matching d-pad action —
// so sending both spellings double-steps the focus ring on that path, while sending the stick alone navigates
// nothing on the path where Steam Input owns the frame. The stick directions are still tracked and latched here
// (that is what keeps the hysteresis honest); they are filtered at the wire. See `WIRE_SUPPRESSED`.
//
// SECURE CONTEXT. `navigator.getGamepads` is secure-context only, so on the default plain-HTTP LAN join it is
// absent and this module is inert by construction — no throw, no listeners that can fire, no messages. What tells
// the player about it is the join-screen advisory (`@/join/GamepadAdvisory.vue`); the capture stays silent.

import type { MirrorInputMessage } from "@/mirror/mirrorClient";

/**
 * The device-neutral token vocabulary, exactly as the host's token→action table names it. 19 controls: the four
 * face buttons, the d-pad, both bumpers, both triggers, start/select, the left stick press, and the four left-stick
 * directions.
 */
export type PadToken =
  | "faceSouth"
  | "faceEast"
  | "faceWest"
  | "faceNorth"
  | "leftBumper"
  | "rightBumper"
  | "leftTrigger"
  | "rightTrigger"
  | "select"
  | "start"
  | "stickPress"
  | "dpadUp"
  | "dpadDown"
  | "dpadLeft"
  | "dpadRight"
  | "stickUp"
  | "stickDown"
  | "stickLeft"
  | "stickRight";

/**
 * Emission order for one frame's edges — button index order, then the axis directions. Two frames that produce the
 * same set of changes produce the same message sequence, which is what makes the wire reproducible (and the specs
 * assertable) rather than dependent on Set iteration luck.
 */
export const PAD_TOKENS: readonly PadToken[] = [
  "faceSouth",
  "faceEast",
  "faceWest",
  "faceNorth",
  "leftBumper",
  "rightBumper",
  "leftTrigger",
  "rightTrigger",
  "select",
  "start",
  "stickPress",
  "dpadUp",
  "dpadDown",
  "dpadLeft",
  "dpadRight",
  "stickUp",
  "stickDown",
  "stickLeft",
  "stickRight"
] as const;

// HYSTERESIS, one rule for both analogue families (triggers and stick axes): a control goes DOWN at 0.55 and only
// comes back UP below 0.35. A single threshold makes a stick resting near the edge — or a trigger held at its bite
// point — chatter one message per frame at 60Hz, which is both a wire flood and a game that re-navigates forever.
// The gap is deliberately wide: a deflection that hovers inside it holds whatever it already was.
export const PAD_PRESS_THRESHOLD = 0.55;
export const PAD_RELEASE_THRESHOLD = 0.35;

// A digital button with no analogue value of its own counts as down at half travel (some engines report only
// `value`, some only `pressed`; a few old ones report the button as a bare number).
const DIGITAL_BUTTON_THRESHOLD = 0.5;

/** One entry of `navigator.getGamepads()`'s `buttons`, as every engine we support may shape it. */
export type PadButtonSnapshot = { pressed?: boolean; value?: number } | number | null | undefined;

/**
 * The parts of a `Gamepad` this module reads. Structural on purpose: the real `Gamepad` satisfies it, and a spec
 * can hand over a plain object without faking the whole interface.
 */
export interface PadSnapshot {
  connected?: boolean;
  /** The standard-layout claim. See `padMappingAccepted` for which values are honoured. */
  mapping?: string;
  buttons?: ArrayLike<PadButtonSnapshot> | null;
  axes?: ArrayLike<number> | null;
}

interface ButtonBinding {
  index: number;
  token: PadToken;
  /**
   * Read the button's ANALOGUE travel through the hysteresis gate rather than its digital `pressed` flag. Only the
   * two triggers: a trigger's `pressed` flips at exactly half travel with no gap at all, so trusting it would put
   * the chatter straight back.
   */
  analog?: boolean;
}

// THE STANDARD MAPPING (https://w3c.github.io/gamepad/#remapping). Buttons 11 (right stick press) and 16 (guide)
// are deliberately unmapped: the game has no abstract controller input for either, the guide button is the
// platform's own (on a Deck it never reaches the page anyway), and sending a token the host cannot name only buys
// an `invalid-action-message` per press. The right stick (axes 2/3) is unmapped for the same reason.
const BUTTON_BINDINGS: readonly ButtonBinding[] = [
  { index: 0, token: "faceSouth" },
  { index: 1, token: "faceEast" },
  { index: 2, token: "faceWest" },
  { index: 3, token: "faceNorth" },
  { index: 4, token: "leftBumper" },
  { index: 5, token: "rightBumper" },
  { index: 6, token: "leftTrigger", analog: true },
  { index: 7, token: "rightTrigger", analog: true },
  { index: 8, token: "select" },
  { index: 9, token: "start" },
  { index: 10, token: "stickPress" },
  { index: 12, token: "dpadUp" },
  { index: 13, token: "dpadDown" },
  { index: 14, token: "dpadLeft" },
  { index: 15, token: "dpadRight" }
];

interface AxisBinding {
  axis: number;
  /** Which end of the axis this direction lives at (-1 = negative: left / up). */
  sign: 1 | -1;
  token: PadToken;
  /** The d-pad token this deflection is SENT AS — the stick's own token is tracked but filtered at the wire. */
  dpad: PadToken;
}

/**
 * Tokens that are TRACKED but never reach the wire. The four stick directions: they are latched, held and released
 * exactly like any other control — which is what keeps the hysteresis honest — but a deflection is sent as its
 * D-PAD twin alone.
 *
 * WHY, measured rather than assumed (2026-09-21): the game binds its `ui_*` navigation to the d-pad ONLY, and its
 * own engine-side controller strategy separately translates a stick deflection into the matching d-pad action. So
 * on that path a stick token and a d-pad token together deliver TWO navigation events for one push and the focus
 * ring double-steps; on the path where Steam Input owns the frame that translation never runs and a stick token
 * alone navigates nothing. The d-pad twin is the only spelling that means the same thing under both.
 *
 * `stickPress` is deliberately NOT here — the game binds a distinct action to the stick click, so it goes out.
 */
const WIRE_SUPPRESSED: ReadonlySet<PadToken> = new Set<PadToken>([
  "stickUp",
  "stickDown",
  "stickLeft",
  "stickRight"
]);

const AXIS_BINDINGS: readonly AxisBinding[] = [
  { axis: 0, sign: -1, token: "stickLeft", dpad: "dpadLeft" },
  { axis: 0, sign: 1, token: "stickRight", dpad: "dpadRight" },
  { axis: 1, sign: -1, token: "stickUp", dpad: "dpadUp" },
  { axis: 1, sign: 1, token: "stickDown", dpad: "dpadDown" }
];

/**
 * Which `Gamepad.mapping` values this module trusts its button indices against.
 *
 * `"standard"` is the remapped layout the bindings above describe. An EMPTY/absent mapping is accepted too — it is
 * what a pad whose layout the browser could not identify reports, and on the desktop engines that matters for
 * (Chrome/Firefox on Linux, which is what a Deck runs) an unidentified pad is still overwhelmingly an
 * XInput-shaped one. Anything else — `"xr-standard"`, the WebXR controllers that also show up in
 * `getGamepads()` — is SKIPPED: its indices mean something else entirely, and replaying them would fire random
 * start/select presses into a live run.
 */
export function padMappingAccepted(mapping: string | undefined | null): boolean {
  return mapping === undefined || mapping === null || mapping === "" || mapping === "standard";
}

function isUsablePad(pad: PadSnapshot | null | undefined): pad is PadSnapshot {
  return !!pad && pad.connected !== false && padMappingAccepted(pad.mapping);
}

/** A button's travel in 0..1, from whichever of the three shapes the engine reports. */
function buttonValue(button: PadButtonSnapshot): number {
  if (typeof button === "number") {
    return Number.isFinite(button) ? button : 0;
  }
  if (!button) {
    return 0;
  }
  if (typeof button.value === "number" && Number.isFinite(button.value)) {
    return button.value;
  }
  return button.pressed === true ? 1 : 0;
}

function buttonDown(button: PadButtonSnapshot): boolean {
  if (button && typeof button === "object" && typeof button.pressed === "boolean") {
    return button.pressed;
  }
  return buttonValue(button) >= DIGITAL_BUTTON_THRESHOLD;
}

/** The hysteresis gate: already held ⇒ stay held until below the release floor; otherwise wait for the press bar. */
function latched(magnitude: number, wasHeld: boolean): boolean {
  return wasHeld ? magnitude > PAD_RELEASE_THRESHOLD : magnitude >= PAD_PRESS_THRESHOLD;
}

function axisValue(pad: PadSnapshot, index: number): number {
  const raw = pad.axes?.[index];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/**
 * The set of tokens held THIS frame, folded across every usable pad.
 *
 * Folding (OR across pads) rather than tracking pads separately is deliberate: one viewer drives one seat, so two
 * pads pressing the same button are one press as far as the game is concerned — and a second pad appearing must
 * never re-fire an edge for something already held.
 *
 * `held` is the PREVIOUS frame's set and is read only by the hysteresis gates, which is why the stick's latch asks
 * about its own stick token rather than the d-pad twin: a physical d-pad held at the same time must not widen the
 * deadzone the stick comes back out of.
 */
export function padTokensFrom(
  pads: ArrayLike<PadSnapshot | null | undefined> | null | undefined,
  held: ReadonlySet<PadToken>
): Set<PadToken> {
  const next = new Set<PadToken>();
  const count = pads?.length ?? 0;
  for (let i = 0; i < count; i += 1) {
    const pad = pads?.[i];
    if (!isUsablePad(pad)) {
      continue;
    }
    for (const binding of BUTTON_BINDINGS) {
      const button = pad.buttons?.[binding.index];
      const down = binding.analog
        ? latched(buttonValue(button), held.has(binding.token))
        : buttonDown(button);
      if (down) {
        next.add(binding.token);
      }
    }
    for (const binding of AXIS_BINDINGS) {
      const magnitude = axisValue(pad, binding.axis) * binding.sign;
      if (latched(magnitude, held.has(binding.token))) {
        next.add(binding.token);
        next.add(binding.dpad);
      }
    }
  }
  return next;
}

/** The two window events that tell us a poll is worth starting (and that one pad's tokens need releasing). */
export interface PadEventSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The page-visibility source (the real `document`). */
export interface PadVisibilitySource extends PadEventSource {
  visibilityState?: string;
}

export interface GamepadCaptureOptions {
  /** The mirror's upstream send — the same one the pointer path uses. */
  send: (message: MirrorInputMessage) => void;
  /**
   * The `gamepad` setting, read LIVE (per poll) so flipping it lands on the next frame rather than the next page
   * load. Absent ⇒ always enabled. Turning it off releases anything held and parks the loop; `refresh()` is how the
   * flip back on restarts it without waiting for a reconnect.
   */
  enabled?: () => boolean;
  /**
   * `navigator.getGamepads`, already bound. `null`/absent ⇒ this browser has no Gamepad API (a plain-HTTP origin,
   * an engine that never had one) and the whole capture is inert.
   */
  getGamepads?: (() => ArrayLike<PadSnapshot | null | undefined> | null | undefined) | null;
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  /** Where `gamepadconnected` / `gamepaddisconnected` are heard. Defaults to `window`. */
  events?: PadEventSource | null;
  /** Where `visibilitychange` is heard, and what answers "is the page visible". Defaults to `document`. */
  visibility?: PadVisibilitySource | null;
}

export interface GamepadCapture {
  /**
   * Re-evaluate whether the poll should be running (the setting flipped, or a caller wants a nudge). Cheap and
   * idempotent — a loop already running is left alone.
   */
  refresh(): void;
  /** Stop polling, drop both listeners, and release anything still held so no button can stick on the seat. */
  dispose(): void;
  /** Whether the rAF poll is running right now. Diagnostics + specs only. */
  polling(): boolean;
}

function defaultGetGamepads(): GamepadCaptureOptions["getGamepads"] {
  if (typeof navigator === "undefined") {
    return null;
  }
  const nav = navigator as Navigator & { getGamepads?: () => Array<Gamepad | null> };
  // Bound because Chrome throws an illegal-invocation on a detached `getGamepads`. Absent on every insecure
  // origin, which is the case this null exists for.
  return typeof nav.getGamepads === "function"
    ? () => nav.getGamepads() as unknown as ArrayLike<PadSnapshot | null | undefined>
    : null;
}

/**
 * Create the pad capture. Inert (and harmless) wherever the API, a window or a frame clock is missing, so callers
 * never have to guard the construction.
 */
export function createGamepadCapture(options: GamepadCaptureOptions): GamepadCapture {
  const send = options.send;
  const enabled = options.enabled ?? (() => true);
  const getGamepads = options.getGamepads === undefined ? defaultGetGamepads() : options.getGamepads;
  const raf =
    options.requestAnimationFrame ??
    (typeof requestAnimationFrame === "function" ? (cb: () => void) => requestAnimationFrame(cb) : null);
  const cancelRaf =
    options.cancelAnimationFrame ??
    (typeof cancelAnimationFrame === "function" ? (handle: number) => cancelAnimationFrame(handle) : null);
  const events =
    options.events === undefined ? (typeof window === "undefined" ? null : window) : options.events;
  const visibility =
    options.visibility === undefined ? (typeof document === "undefined" ? null : document) : options.visibility;

  let held = new Set<PadToken>();
  let rafHandle: number | null = null;
  let disposed = false;

  const live = Boolean(getGamepads && raf && cancelRaf);

  function pageVisible(): boolean {
    // An environment with no visibility signal at all (jsdom without the property, an older engine) counts as
    // visible — the page is being played, and refusing to poll there would be a silent dead feature.
    return visibility?.visibilityState === undefined ? true : visibility.visibilityState !== "hidden";
  }

  function shouldRun(): boolean {
    return live && !disposed && enabled() !== false && pageVisible();
  }

  function emit(token: PadToken, pressed: boolean): void {
    if (WIRE_SUPPRESSED.has(token)) {
      return;
    }
    send({ kind: "pad", input: token, pressed });
  }

  /** Release everything currently held, in the canonical order. Idempotent — a cleared set sends nothing. */
  function releaseAll(): void {
    if (held.size === 0) {
      return;
    }
    const previous = held;
    held = new Set<PadToken>();
    for (const token of PAD_TOKENS) {
      if (previous.has(token)) {
        emit(token, false);
      }
    }
  }

  function stop(): void {
    if (rafHandle !== null) {
      cancelRaf?.(rafHandle);
      rafHandle = null;
    }
  }

  /**
   * RELEASES BEFORE PRESSES, always. A stick flicked across the centre in one frame releases `dpadLeft` before it
   * presses `dpadRight`, so the game never sees both directions held — which is the one ordering the UI reacts to
   * differently.
   */
  function emitEdges(next: Set<PadToken>): void {
    for (const token of PAD_TOKENS) {
      if (held.has(token) && !next.has(token)) {
        emit(token, false);
      }
    }
    for (const token of PAD_TOKENS) {
      if (!held.has(token) && next.has(token)) {
        emit(token, true);
      }
    }
    held = next;
  }

  function poll(): void {
    rafHandle = null;
    if (!shouldRun()) {
      // The setting went off, the tab went away, or we were disposed between frames: let go of everything rather
      // than leaving the seat holding a button nobody is pressing any more.
      releaseAll();
      return;
    }
    const pads = getGamepads?.();
    const count = pads?.length ?? 0;
    let usable = false;
    for (let i = 0; i < count && !usable; i += 1) {
      usable = isUsablePad(pads?.[i]);
    }
    if (!usable) {
      // No pad left to read. Release whatever the vanished pad held and park — `gamepadconnected` restarts us.
      releaseAll();
      return;
    }
    emitEdges(padTokensFrom(pads, held));
    rafHandle = raf?.(poll) ?? null;
  }

  function start(): void {
    if (rafHandle !== null || !shouldRun()) {
      return;
    }
    rafHandle = raf?.(poll) ?? null;
  }

  // `gamepadconnected` is also the earliest moment a pad EXISTS as far as the page is concerned: Chrome enumerates
  // nothing until the player presses a button, and that press is what fires this. Disconnect drives one more poll
  // so the departing pad's held tokens are released (and the loop then parks itself).
  const onPadEvent = (): void => start();
  const onVisibility = (): void => {
    if (pageVisible()) {
      start();
    } else {
      stop();
      releaseAll();
    }
  };

  if (live) {
    events?.addEventListener("gamepadconnected", onPadEvent);
    events?.addEventListener("gamepaddisconnected", onPadEvent);
    visibility?.addEventListener("visibilitychange", onVisibility);
    // A pad the page already knows about (a reload with the pad awake, a browser that enumerates without a
    // gesture) would otherwise wait for an event that has already happened.
    start();
  }

  return {
    refresh(): void {
      if (disposed) {
        return;
      }
      if (shouldRun()) {
        start();
      } else {
        stop();
        releaseAll();
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      stop();
      if (live) {
        events?.removeEventListener("gamepadconnected", onPadEvent);
        events?.removeEventListener("gamepaddisconnected", onPadEvent);
        visibility?.removeEventListener("visibilitychange", onVisibility);
      }
      // Symmetry with the poll's own bail: an unmount mid-press must not leave the seat holding it. The send is a
      // no-op on a socket that has already closed.
      releaseAll();
    },
    polling(): boolean {
      return rafHandle !== null;
    }
  };
}
