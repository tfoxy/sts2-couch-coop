// BROWSER KEYBOARD AND GAMEPAD — the mirror's two device-level upstream sources, beside the pointer captures
// (inputCapture.ts for the old renderer, streamInput.ts for the new one). Both renderers create them through
// `createKeyPadInput` below, so a key or a pad behaves the same whichever renderer draws the seat.
//
// THE CAPTURES ARE GODOT-SCENE-WEB'S. `@godot-scene-web/input/keyboard` and `./gamepad` own everything about reading
// the devices: the key latch, the focus and chord guards, auto-repeat, blur / hidden / pagehide release, the rAF pad
// poll with its connect/disconnect lifecycle, the standard-mapping table, neutralize-on-start. They emit gsw-input/1
// records in Godot's vocabulary (`key`, `joypad_button`, `joypad_motion`). This module is the ADAPTER that turns
// those records into the tokens couch's host has always taken on `/ws`:
//
//   * key   → `{kind:"key", key:<KeyboardEvent.code>, modifiers?, pressed}` — EDGES, the release replaying the
//             press (GSW's release record is the press record with `pressed:false`, so the modifiers match);
//   * pads  → `{kind:"pad", input:<token>, pressed}` — EDGES of the 15 device-neutral tokens the host names, the
//             stick and the triggers turned into edges here through GSW's `latched()` hysteresis.
//
// Couch keeps its own `/ws` and its host's token vocabulary, so it implements GSW's `InputSink` itself and uses no
// GSW session (docs/input.md "Consumer recipe: couch" in ../godot-scene-web). The host still turns a key into a
// real `InputEventKey` and a token into the game's own abstract controller input; nothing host-side changed.
//
// NOTHING MAY STICK DOWN. GSW releases on every path that can lose an up-edge (blur, hidden tab, pagehide, the
// setting going off on `refresh()`, dispose, a pad disconnecting), and its releases are never gated. The adapter
// adds no gate of its own on a release either: it forwards what GSW emits.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` plus the GSW input package.

import { JoyAxis, JoyButton, type InputRecord, type InputSink, type ModifierFields } from "@godot-scene-web/input";
import {
  createGamepadCapture,
  latched,
  type GamepadCapture,
  type GamepadCaptureOptions
} from "@godot-scene-web/input/gamepad";
import {
  createKeyboardCapture,
  type FocusedElementLike,
  type KeyboardCapture,
  type KeyboardCaptureOptions
} from "@godot-scene-web/input/keyboard";

import type { MirrorInputMessage } from "@/mirror/mirrorClient";

// ---- keyboard ---------------------------------------------------------------------------------------------------

/**
 * Named keys the host can map. The letter / digit / numpad / function families are matched by SHAPE below.
 *
 * This list is a CONSERVATIVE MIRROR of the host's table, not a second authority: spirectl's `Sts2BrowserKeyMap`
 * (../spirectl → bridge-mod/src/Spirectl.Sts2/Live/Sts2BrowserKeyMap.cs) owns the vocabulary and still refuses
 * anything it does not know. The filter exists because a key the host cannot map costs an error envelope per
 * message, and with edges that is two per press — a player resting a hand on a keyboard would otherwise stream
 * failures at the host. A key the host learns and this file has not is simply not forwarded until it is added
 * here: a gap, never a wrong action. It is GSW's `filter` option, so a filtered press is also never
 * `preventDefault`ed: the key keeps its browser behaviour.
 */
const NAMED_CODES: ReadonlySet<string> = new Set([
  "Enter",
  "NumpadEnter",
  "Escape",
  "Space",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Minus",
  "Equal"
]);

const LETTER_CODE = /^Key[A-Z]$/;
const DIGIT_CODE = /^Digit[0-9]$/;
const NUMPAD_CODE = /^Numpad[0-9]$/;
const FUNCTION_CODE = /^F([1-9]|1[0-2])$/;

/** Whether the host's key map can name this `KeyboardEvent.code`. See NAMED_CODES for what this list is. */
export function isForwardableCode(code: string): boolean {
  return (
    LETTER_CODE.test(code) ||
    DIGIT_CODE.test(code) ||
    NUMPAD_CODE.test(code) ||
    FUNCTION_CODE.test(code) ||
    NAMED_CODES.has(code)
  );
}

/**
 * The comma-separated modifier list the host parses (`ParseModifiers` in spirectl), from a `key` record's flags.
 * Order is fixed so two presses of the same chord serialise identically.
 */
export function modifierString(record: ModifierFields): string {
  return [
    record.ctrl_pressed ? "ctrl" : "",
    record.shift_pressed ? "shift" : "",
    record.alt_pressed ? "alt" : "",
    record.meta_pressed ? "meta" : ""
  ]
    .filter(Boolean)
    .join(",");
}

// ---- gamepad ----------------------------------------------------------------------------------------------------

/**
 * The device-neutral token vocabulary, exactly as the host's token→action table names it (spirectl's
 * `Sts2BrowserPadMap`). 19 controls: the four face buttons, the d-pad, both bumpers, both triggers, start/select,
 * the left stick press, and the four left-stick directions (tracked, never sent — see WIRE_SUPPRESSED).
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
 * Emission order for one frame's edges. Two frames that produce the same set of changes produce the same message
 * sequence, which keeps the wire reproducible and the specs assertable.
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

/**
 * Godot `JoyButton` → token. `RIGHT_STICK` and `GUIDE` are deliberately unmapped: the game has no abstract
 * controller input for either, the guide button is the platform's own, and a token the host cannot name only buys
 * an `invalid-action-message` per press. The right stick (axes 2/3) is unmapped for the same reason.
 */
const BUTTON_TOKENS: ReadonlyMap<number, PadToken> = new Map<number, PadToken>([
  [JoyButton.A, "faceSouth"],
  [JoyButton.B, "faceEast"],
  [JoyButton.X, "faceWest"],
  [JoyButton.Y, "faceNorth"],
  [JoyButton.LEFT_SHOULDER, "leftBumper"],
  [JoyButton.RIGHT_SHOULDER, "rightBumper"],
  [JoyButton.BACK, "select"],
  [JoyButton.START, "start"],
  [JoyButton.LEFT_STICK, "stickPress"],
  [JoyButton.DPAD_UP, "dpadUp"],
  [JoyButton.DPAD_DOWN, "dpadDown"],
  [JoyButton.DPAD_LEFT, "dpadLeft"],
  [JoyButton.DPAD_RIGHT, "dpadRight"]
]);

/**
 * The analogue controls that become edges, through `latched()` (down at 0.55, back up only at or below 0.35): the
 * gap keeps a stick resting near the edge, or a trigger held at its bite point, from chattering a message per frame.
 * Triggers arrive as Godot axes 4/5 in 0..1; a stick axis gives one token per end.
 */
interface AnalogBinding {
  axis: number;
  /** Which end of the axis this token lives at (-1 = negative: left / up; triggers are 1). */
  sign: 1 | -1;
  token: PadToken;
  /** The d-pad token a stick deflection is SENT AS — the stick's own token is tracked but filtered at the wire. */
  dpad?: PadToken;
}

const ANALOG_BINDINGS: readonly AnalogBinding[] = [
  { axis: JoyAxis.LEFT_X, sign: -1, token: "stickLeft", dpad: "dpadLeft" },
  { axis: JoyAxis.LEFT_X, sign: 1, token: "stickRight", dpad: "dpadRight" },
  { axis: JoyAxis.LEFT_Y, sign: -1, token: "stickUp", dpad: "dpadUp" },
  { axis: JoyAxis.LEFT_Y, sign: 1, token: "stickDown", dpad: "dpadDown" },
  { axis: JoyAxis.TRIGGER_LEFT, sign: 1, token: "leftTrigger" },
  { axis: JoyAxis.TRIGGER_RIGHT, sign: 1, token: "rightTrigger" }
];

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

// ---- the sink ---------------------------------------------------------------------------------------------------

/** GSW's `InputSink`, plus what the couch captures need to drive it. */
export interface CouchInputSink extends InputSink {
  /**
   * Run `work` with pad edges held back, then emit them at once — every release before every press, each in
   * PAD_TOKENS order. The gamepad capture's poll runs inside one, so a frame's edges are one ordered batch however
   * GSW ordered its records (it sends button releases, then axis motions, then button presses: a stick flicking up
   * while another axis flicks back would otherwise interleave a press before a release).
   */
  batch(work: () => void): void;
  /** The pad tokens held right now, stick directions included, in PAD_TOKENS order. Diagnostics and specs. */
  padHeld(): PadToken[];
}

/**
 * The adapter: GSW records in, couch `/ws` input messages out. Records of a kind couch's host does not take (a
 * pointer record, an echo, which `echo:false` never produces anyway) are dropped.
 */
export function createCouchInputSink(send: (message: MirrorInputMessage) => void): CouchInputSink {
  /** Tokens held by a digital button (face, bumpers, start/select, stick press, the physical d-pad). */
  const buttons = new Set<PadToken>();
  /** Tokens held by an analogue control past its latch (the four stick directions, the two triggers). */
  const analog = new Set<PadToken>();
  /** What the host has been told (stick directions included, though WIRE_SUPPRESSED keeps them off the wire). */
  let sent = new Set<PadToken>();
  let batchDepth = 0;

  /** buttons ∪ analog ∪ each held stick direction's d-pad twin. A token held twice over is one press. */
  function held(): Set<PadToken> {
    const next = new Set<PadToken>(buttons);
    for (const binding of ANALOG_BINDINGS) {
      if (!analog.has(binding.token)) continue;
      next.add(binding.token);
      if (binding.dpad) next.add(binding.dpad);
    }
    return next;
  }

  function emitPad(token: PadToken, pressed: boolean): void {
    if (WIRE_SUPPRESSED.has(token)) return;
    send({ kind: "pad", input: token, pressed });
  }

  /** RELEASES BEFORE PRESSES: a direction flipping in one frame never shows the game both directions held. */
  function flushPad(): void {
    const next = held();
    for (const token of PAD_TOKENS) {
      if (sent.has(token) && !next.has(token)) emitPad(token, false);
    }
    for (const token of PAD_TOKENS) {
      if (!sent.has(token) && next.has(token)) emitPad(token, true);
    }
    sent = next;
  }

  function onAxis(axis: number, value: number): void {
    for (const binding of ANALOG_BINDINGS) {
      if (binding.axis !== axis) continue;
      // Each direction asks about ITS OWN latch, not its d-pad twin's: a physical d-pad held at the same time must
      // not widen the band the stick comes back out of.
      if (latched(value * binding.sign, analog.has(binding.token))) analog.add(binding.token);
      else analog.delete(binding.token);
    }
  }

  return {
    push(record: InputRecord): void {
      switch (record.event) {
        case "key": {
          if (record.echo === true || !record.code) return;
          const modifiers = modifierString(record);
          send({ kind: "key", key: record.code, ...(modifiers ? { modifiers } : {}), pressed: record.pressed });
          return;
        }
        case "joypad_button": {
          // `pads: "merge"` folds every pad into slot 0 (one viewer drives one seat), so the device is not read.
          const token = BUTTON_TOKENS.get(record.button_index ?? 0);
          if (token === undefined) return;
          if (record.pressed) buttons.add(token);
          else buttons.delete(token);
          break;
        }
        case "joypad_motion":
          onAxis(record.axis ?? 0, record.axis_value ?? 0);
          break;
        default:
          return;
      }
      if (batchDepth === 0) flushPad();
    },
    batch(work: () => void): void {
      batchDepth += 1;
      try {
        work();
      } finally {
        batchDepth -= 1;
        if (batchDepth === 0) flushPad();
      }
    },
    padHeld(): PadToken[] {
      const now = held();
      return PAD_TOKENS.filter((token) => now.has(token));
    }
  };
}

// ---- the captures -----------------------------------------------------------------------------------------------

/** GSW's keyboard options minus what the adapter fixes (where records go, which codes, repeats). */
export type CouchKeyboardOptions = Omit<KeyboardCaptureOptions, "sink" | "filter" | "echo"> & {
  send: (message: MirrorInputMessage) => void;
};

export interface CouchKeyboardCapture extends KeyboardCapture {
  readonly sink: CouchInputSink;
}

/**
 * GSW's keyboard capture on couch's wire. Fixed policy: only codes the host can map (`isForwardableCode`), browser
 * auto-repeat dropped (`echo: false`: the game ignores echo keys, so a held key does not re-fire natively either),
 * ctrl/meta chords left to the browser (GSW's default `chords: "browser"`: reload and devtools keep working, and the
 * game binds no such chord). Inert wherever there is no window, so callers never guard the construction.
 */
export function createCouchKeyboardCapture(options: CouchKeyboardOptions): CouchKeyboardCapture {
  const { send, ...rest } = options;
  const sink = createCouchInputSink(send);
  const capture = createKeyboardCapture({
    ...rest,
    sink,
    filter: (code) => isForwardableCode(code),
    echo: false,
    chords: "browser"
  });
  return Object.assign(capture, { sink });
}

/** GSW's gamepad options minus what the adapter fixes (where records go, pad folding, non-standard pads). */
export type CouchGamepadOptions = Omit<GamepadCaptureOptions, "sink" | "pads" | "nonStandard" | "maxSlots"> & {
  send: (message: MirrorInputMessage) => void;
};

export interface CouchGamepadCapture extends GamepadCapture {
  readonly sink: CouchInputSink;
}

/**
 * GSW's gamepad capture on couch's wire. Fixed policy:
 *   * `pads: "merge"` — every pad folds into one (buttons ORed, the largest-magnitude axis wins): one viewer drives
 *     one seat, and a second pad appearing must never re-fire an edge for something already held. GSW's default is
 *     `"claim"` (per-window Web Locks for several windows on one machine); couch has one window per seat, so it
 *     keeps the fold it has always had.
 *   * `nonStandard: "as-standard"` — a pad whose layout the browser could not identify (empty `mapping`; Chrome and
 *     Firefox on Linux, which is what a Deck runs) is still overwhelmingly XInput-shaped. `xr-standard` is skipped.
 *
 * SECURE CONTEXT. `navigator.getGamepads` is secure-context only, so on the default plain-HTTP LAN join it is absent
 * and the capture is inert by construction — no throw, no listeners, no messages. The join-screen advisory
 * (`@/join/GamepadAdvisory.vue`) is what tells the player; the capture stays silent.
 */
export function createCouchGamepadCapture(options: CouchGamepadOptions): CouchGamepadCapture {
  const { send, ...rest } = options;
  const sink = createCouchInputSink(send);
  const raf =
    options.requestAnimationFrame ??
    (typeof requestAnimationFrame === "function"
      ? (callback: (time: number) => void) => requestAnimationFrame(callback)
      : undefined);
  const capture = createGamepadCapture({
    ...rest,
    sink,
    pads: "merge",
    nonStandard: "as-standard",
    // Each poll is one batch, so one frame's edges go out releases-first in PAD_TOKENS order.
    requestAnimationFrame: raf ? (callback) => raf((time) => sink.batch(() => callback(time))) : undefined
  });
  return {
    ...capture,
    sink,
    refresh(): void {
      sink.batch(() => capture.refresh());
    },
    dispose(): void {
      sink.batch(() => capture.dispose());
    }
  };
}

export interface KeyPadInputOptions {
  /** The mirror's upstream send — the same one the pointer uses. */
  send: (message: MirrorInputMessage) => void;
  /** The `keyboard` setting, read live per keydown; `refresh()` releases what is held when it goes off. */
  keyboard: () => boolean;
  /** The `gamepad` setting, read live per poll; `refresh()` restarts a parked poll when it comes back on. */
  gamepad: () => boolean;
  /** On access resume: ignore pad controls already held in the first sample until each is released. */
  neutralizeHeldOnStart?: boolean;
  /** The element the game is drawn on: focused, it never counts as a text field or an activatable control. */
  stage?: FocusedElementLike | null;
}

export interface KeyPadInput {
  readonly keyboard: CouchKeyboardCapture;
  readonly gamepad: CouchGamepadCapture;
  /** Re-read both settings (a watcher's job): off releases what is held, on restarts the pad poll. */
  refresh(): void;
  /** Drop every listener and release everything still held, so nothing sticks down on the seat. */
  dispose(): void;
}

/** Both captures on one send path, as MirrorView and RenderStreamStage create them. */
export function createKeyPadInput(options: KeyPadInputOptions): KeyPadInput {
  const keyboard = createCouchKeyboardCapture({
    send: options.send,
    enabled: options.keyboard,
    stage: options.stage ?? null
  });
  const gamepad = createCouchGamepadCapture({
    send: options.send,
    enabled: options.gamepad,
    neutralizeHeldOnStart: options.neutralizeHeldOnStart === true
  });
  return {
    keyboard,
    gamepad,
    refresh(): void {
      keyboard.refresh();
      gamepad.refresh();
    },
    dispose(): void {
      keyboard.dispose();
      gamepad.dispose();
    }
  };
}
