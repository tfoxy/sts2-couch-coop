import { beforeEach, describe, expect, it } from "vitest";

import { JoyAxis, JoyButton } from "@godot-scene-web/input";
import type { GamepadSnapshot } from "@godot-scene-web/input/gamepad";

import {
  createCouchGamepadCapture,
  createCouchInputSink,
  PAD_TOKENS,
  type CouchGamepadCapture,
  type PadToken
} from "@/mirror/keyPadInput";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";

// BROWSER GAMEPAD — godot-scene-web's gamepad capture behind couch's adapter (keyPadInput.ts). GSW owns the poll,
// the standard mapping and neutralize-on-start, and tests them itself; these specs pin couch's half of the contract,
// end to end through the real GSW capture:
//
//   * only EDGES reach the wire — one message down, one up, nothing while a control is held;
//   * the standard mapping lands on the host's token table, and the two unmapped buttons stay unmapped;
//   * analogue travel (triggers, stick axes) crosses a threshold WITH HYSTERESIS (`latched`), so a control resting
//     on it cannot chatter a message per frame;
//   * a stick deflection is held as its stick token AND its d-pad twin, and only the twin reaches the wire;
//   * the poll only exists while there is something to read, and lets go of everything on the way out.
//
// Everything is driven through injected seams (a fake `getGamepads`, a fake frame clock, stub event targets), so
// nothing here depends on jsdom growing a Gamepad API.

type PadSnapshot = GamepadSnapshot;

// ---- fakes ---------------------------------------------------------------------------------------------------

/** A button as the browsers shape it: `pressed` flips at half travel, `value` carries the analogue position. */
function button(travel: number | boolean): { pressed: boolean; value: number } {
  const value = typeof travel === "boolean" ? (travel ? 1 : 0) : travel;
  return { pressed: value >= 0.5, value };
}

/** 17 standard buttons, with the named indices at the given travel and everything else at rest. */
function buttons(down: Record<number, number | boolean> = {}): Array<{ pressed: boolean; value: number }> {
  return Array.from({ length: 17 }, (_unused, index) => button(down[index] ?? 0));
}

function pad(overrides: Partial<PadSnapshot> = {}): PadSnapshot {
  return { connected: true, mapping: "standard", buttons: buttons(), axes: [0, 0, 0, 0], ...overrides };
}

interface FakeEvents {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  fire(type: string): void;
  listeners(type: string): number;
}

type Listener = (event: { type: string }) => void;

function fakeEvents(): FakeEvents {
  const handlers = new Map<string, Set<Listener>>();
  return {
    addEventListener(type, listener) {
      const set = handlers.get(type) ?? new Set<Listener>();
      set.add(listener);
      handlers.set(type, set);
    },
    removeEventListener(type, listener) {
      handlers.get(type)?.delete(listener);
    },
    fire(type) {
      for (const listener of [...(handlers.get(type) ?? [])]) listener({ type });
    },
    listeners(type) {
      return handlers.get(type)?.size ?? 0;
    }
  };
}

interface Harness {
  capture: CouchGamepadCapture;
  sent: MirrorInputMessage[];
  /** What the fake `navigator.getGamepads()` answers. Mutate between frames. */
  pads: Array<PadSnapshot | null>;
  enabled: boolean;
  visibilityState: string;
  events: FakeEvents;
  visibility: FakeEvents;
  /** Run every rAF callback queued so far (one poll turn). */
  frame(): void;
  frames(count: number): void;
  /** The tokens+edges sent since the last `take()`, as `"faceSouth:down"` strings. */
  take(): string[];
  pendingFrames(): number;
}

function harness(options: { pads?: Array<PadSnapshot | null>; api?: boolean; neutralizeHeldOnStart?: boolean } = {}): Harness {
  const sent: MirrorInputMessage[] = [];
  let queue: Array<{ handle: number; callback: (time: number) => void }> = [];
  let nextHandle = 1;
  let now = 0;
  const events = fakeEvents();
  const visibility = fakeEvents();
  const state = {
    pads: options.pads ?? [],
    enabled: true,
    visibilityState: "visible"
  };
  const capture = createCouchGamepadCapture({
    send: (message) => sent.push(message),
    enabled: () => state.enabled,
    neutralizeHeldOnStart: options.neutralizeHeldOnStart,
    getGamepads: options.api === false ? null : () => state.pads,
    requestAnimationFrame: (callback) => {
      const handle = nextHandle++;
      queue.push({ handle, callback });
      return handle;
    },
    cancelAnimationFrame: (handle) => {
      queue = queue.filter((entry) => entry.handle !== handle);
    },
    events,
    visibility: {
      addEventListener: visibility.addEventListener,
      removeEventListener: visibility.removeEventListener,
      get visibilityState() {
        return state.visibilityState;
      }
    } as unknown as FakeEvents & { visibilityState: string }
  });
  return {
    capture,
    sent,
    events,
    visibility,
    get pads() {
      return state.pads;
    },
    set pads(value: Array<PadSnapshot | null>) {
      state.pads = value;
    },
    get enabled() {
      return state.enabled;
    },
    set enabled(value: boolean) {
      state.enabled = value;
    },
    get visibilityState() {
      return state.visibilityState;
    },
    set visibilityState(value: string) {
      state.visibilityState = value;
    },
    frame() {
      const turn = queue;
      queue = [];
      now += 1000 / 60;
      for (const entry of turn) entry.callback(now);
    },
    frames(count) {
      for (let i = 0; i < count; i += 1) this.frame();
    },
    take() {
      const out = sent.splice(0, sent.length);
      return out.map((message) => `${String(message.input)}:${message.pressed ? "down" : "up"}`);
    },
    pendingFrames() {
      return queue.length;
    }
  };
}

// ---- the token table ------------------------------------------------------------------------------------------

/** The tokens one frame of `pads` holds, read from a fresh capture's sink (stick directions included). */
function heldBy(pads: PadSnapshot[]): PadToken[] {
  const rig = harness({ pads: [pad()] });
  rig.frame();
  rig.pads = pads;
  rig.frame();
  const held = rig.capture.sink.padHeld();
  rig.capture.dispose();
  return held;
}

describe("the pad token table", () => {
  it("maps every standard button index to the token the host names", () => {
    const cases: Array<[number, PadToken]> = [
      [0, "faceSouth"],
      [1, "faceEast"],
      [2, "faceWest"],
      [3, "faceNorth"],
      [4, "leftBumper"],
      [5, "rightBumper"],
      [6, "leftTrigger"],
      [7, "rightTrigger"],
      [8, "select"],
      [9, "start"],
      [10, "stickPress"],
      [12, "dpadUp"],
      [13, "dpadDown"],
      [14, "dpadLeft"],
      [15, "dpadRight"]
    ];
    for (const [index, token] of cases) {
      expect(heldBy([pad({ buttons: buttons({ [index]: true }) })]), `button ${index}`).toEqual([token]);
    }
  });

  it("ignores the right stick press (11), the guide button (16) and the right stick axes", () => {
    expect(heldBy([pad({ buttons: buttons({ 11: true, 16: true }) })])).toEqual([]);
    expect(heldBy([pad({ axes: [0, 0, -1, 1] })])).toEqual([]);
  });

  it("holds BOTH the stick token and its d-pad twin for one deflection", () => {
    expect(heldBy([pad({ axes: [-1, 0] })]).sort()).toEqual(["dpadLeft", "stickLeft"]);
    expect(heldBy([pad({ axes: [0, 1] })]).sort()).toEqual(["dpadDown", "stickDown"]);
  });

  it("holds a stick between the two thresholds at whatever it already was (hysteresis)", () => {
    const out: MirrorInputMessage[] = [];
    const sink = createCouchInputSink((m) => out.push(m));
    const motion = (value: number) => sink.push({ event: "joypad_motion", axis: JoyAxis.LEFT_X, axis_value: value });
    // 0.45 deflection: not enough to PRESS from rest, not little enough to RELEASE once held.
    motion(-0.45);
    expect(sink.padHeld()).toEqual([]);
    motion(-0.8);
    motion(-0.45);
    expect(sink.padHeld()).toEqual(["dpadLeft", "stickLeft"]);
    motion(-0.3);
    expect(sink.padHeld()).toEqual([]);
  });

  it("gates a trigger on its ANALOGUE travel, not on the half-travel `pressed` flag", () => {
    // `pressed` is already true at 0.5 (see `button`), but the press bar is 0.55 — a trigger resting at its bite
    // point must not chatter.
    expect(heldBy([pad({ buttons: buttons({ 6: 0.5 }) })])).toEqual([]);
    expect(heldBy([pad({ buttons: buttons({ 6: 0.6 }) })])).toEqual(["leftTrigger"]);
    const out: MirrorInputMessage[] = [];
    const sink = createCouchInputSink((m) => out.push(m));
    const trigger = (value: number) =>
      sink.push({ event: "joypad_motion", axis: JoyAxis.TRIGGER_LEFT, axis_value: value });
    trigger(0.6);
    trigger(0.4);
    expect(sink.padHeld()).toEqual(["leftTrigger"]);
    trigger(0.3);
    expect(sink.padHeld()).toEqual([]);
  });

  it("reads a button reported as a bare number, or as `pressed` with no value", () => {
    expect(heldBy([pad({ buttons: [1] })])).toEqual(["faceSouth"]);
    expect(heldBy([pad({ buttons: [{ pressed: true }] })])).toEqual(["faceSouth"]);
    expect(heldBy([pad({ buttons: [0] })])).toEqual([]);
  });

  it("skips a disconnected pad, a null entry, and any mapping whose indices mean something else", () => {
    expect(heldBy([null as unknown as PadSnapshot])).toEqual([]);
    expect(heldBy([pad({ connected: false, buttons: buttons({ 0: true }) })])).toEqual([]);
    expect(heldBy([pad({ mapping: "xr-standard", buttons: buttons({ 0: true }) })])).toEqual([]);
    // An unidentified pad (empty mapping) is still read — that is what a Linux browser reports for pads it does
    // not recognise, which is exactly the Deck case (`nonStandard: "as-standard"`).
    expect(heldBy([pad({ mapping: "", buttons: buttons({ 0: true }) })])).toEqual(["faceSouth"]);
  });

  it("folds two pads into one logical pad (one viewer, one seat)", () => {
    const held = heldBy([pad({ buttons: buttons({ 0: true }) }), pad({ buttons: buttons({ 0: true, 9: true }) })]);
    expect(held.sort()).toEqual(["faceSouth", "start"]);
  });

  it("does not re-fire a held button when a second pad pressing it appears", () => {
    const rig = harness({ pads: [pad({ buttons: buttons({ 0: true }) })] });
    rig.frame();
    expect(rig.take()).toEqual(["faceSouth:down"]);
    rig.pads = [pad({ buttons: buttons({ 0: true }) }), pad({ buttons: buttons({ 0: true }) })];
    rig.frames(2);
    expect(rig.take()).toEqual([]);
    rig.capture.dispose();
  });

  it("turns GSW joypad records into couch tokens and ignores what the host cannot name", () => {
    const out: MirrorInputMessage[] = [];
    const sink = createCouchInputSink((m) => out.push(m));
    sink.push({ event: "joypad_button", button_index: JoyButton.A, pressed: true });
    sink.push({ event: "joypad_button", button_index: JoyButton.GUIDE, pressed: true });
    sink.push({ event: "joypad_button", button_index: JoyButton.RIGHT_STICK, pressed: true });
    sink.push({ event: "joypad_motion", axis: JoyAxis.RIGHT_X, axis_value: 1 });
    sink.push({ event: "joypad_button", button_index: JoyButton.A, pressed: false });
    expect(out).toEqual([
      { kind: "pad", input: "faceSouth", pressed: true },
      { kind: "pad", input: "faceSouth", pressed: false }
    ]);
  });
});

// ---- the live capture ----------------------------------------------------------------------------------------

describe("couch gamepad capture (GSW gamepad → couch pad tokens)", () => {
  let rig: Harness;

  beforeEach(() => {
    rig = harness({ pads: [pad()] });
  });

  it("sends one press edge, nothing while held, and one release edge", () => {
    rig.frame();
    expect(rig.take()).toEqual([]);
    rig.pads = [pad({ buttons: buttons({ 0: true }) })];
    rig.frame();
    expect(rig.sent).toEqual([{ kind: "pad", input: "faceSouth", pressed: true }]);
    rig.take();
    rig.frames(4);
    expect(rig.take()).toEqual([]);
    rig.pads = [pad()];
    rig.frame();
    expect(rig.sent).toEqual([{ kind: "pad", input: "faceSouth", pressed: false }]);
  });

  it("carries no coordinate, button or key — a pad token is not a place on the stage", () => {
    rig.pads = [pad({ buttons: buttons({ 9: true }) })];
    rig.frame();
    expect(rig.sent).toEqual([{ kind: "pad", input: "start", pressed: true }]);
    expect(Object.keys(rig.sent[0]).sort()).toEqual(["input", "kind", "pressed"]);
  });

  it("releases before it presses when a direction flips inside one frame", () => {
    rig.pads = [pad({ buttons: buttons({ 14: true }) })];
    rig.frame();
    expect(rig.take()).toEqual(["dpadLeft:down"]);
    rig.pads = [pad({ buttons: buttons({ 15: true }) })];
    rig.frame();
    expect(rig.take()).toEqual(["dpadLeft:up", "dpadRight:down"]);
  });

  it("emits a stick deflection as its d-pad token alone, once each way", () => {
    rig.pads = [pad({ axes: [0, -0.8] })];
    rig.frame();
    // The stick token is tracked but filtered at the wire (WIRE_SUPPRESSED): the game navigates on the d-pad,
    // and sending both spellings would step the focus ring twice for one push.
    expect(rig.take()).toEqual(["dpadUp:down"]);
    rig.frames(3);
    expect(rig.take()).toEqual([]);
    rig.pads = [pad({ axes: [0, -0.4] })];
    rig.frame();
    expect(rig.take()).toEqual([]); // inside the hysteresis band: still held, still silent
    rig.pads = [pad({ axes: [0, 0] })];
    rig.frame();
    expect(rig.take()).toEqual(["dpadUp:up"]);
  });

  it("never puts a stick direction on the wire, in any combination", () => {
    rig.pads = [pad({ axes: [-0.9, -0.9] })];
    rig.frame();
    expect(rig.take()).toEqual(["dpadUp:down", "dpadLeft:down"]);
    rig.pads = [pad({ axes: [0.9, 0.9] })];
    rig.frame();
    expect(rig.take()).toEqual(["dpadUp:up", "dpadLeft:up", "dpadDown:down", "dpadRight:down"]);
  });

  it("does not double-fire when the d-pad button and the stick claim the same direction", () => {
    rig.pads = [pad({ buttons: buttons({ 12: true }), axes: [0, -0.9] })];
    rig.frame();
    expect(rig.take()).toEqual(["dpadUp:down"]);
    // Let the stick go: the physical d-pad still holds the SAME token, so nothing lifts on the wire at all.
    rig.pads = [pad({ buttons: buttons({ 12: true }), axes: [0, 0] })];
    rig.frame();
    expect(rig.take()).toEqual([]);
    // Only releasing the button itself releases the direction.
    rig.pads = [pad({ axes: [0, 0] })];
    rig.frame();
    expect(rig.take()).toEqual(["dpadUp:up"]);
  });

  it("threshold-crosses a trigger with hysteresis on the wire", () => {
    rig.pads = [pad({ buttons: buttons({ 7: 0.5 }) })];
    rig.frame();
    expect(rig.take()).toEqual([]);
    rig.pads = [pad({ buttons: buttons({ 7: 0.9 }) })];
    rig.frame();
    expect(rig.take()).toEqual(["rightTrigger:down"]);
    rig.pads = [pad({ buttons: buttons({ 7: 0.4 }) })];
    rig.frames(3);
    expect(rig.take()).toEqual([]);
    rig.pads = [pad({ buttons: buttons({ 7: 0.1 }) })];
    rig.frame();
    expect(rig.take()).toEqual(["rightTrigger:up"]);
  });

  it("parks with no pad attached and starts on `gamepadconnected`", () => {
    const idle = harness({ pads: [] });
    idle.frame();
    expect(idle.pendingFrames()).toBe(0);
    expect(idle.capture.polling()).toBe(false);
    idle.pads = [pad({ buttons: buttons({ 0: true }) })];
    idle.events.fire("gamepadconnected");
    expect(idle.capture.polling()).toBe(true);
    idle.frame();
    expect(idle.take()).toEqual(["faceSouth:down"]);
  });

  it("releases what a vanished pad was holding, then parks", () => {
    rig.pads = [pad({ buttons: buttons({ 0: true }) })];
    rig.frame();
    expect(rig.take()).toEqual(["faceSouth:down"]);
    rig.pads = [];
    rig.events.fire("gamepaddisconnected");
    rig.frame();
    expect(rig.take()).toEqual(["faceSouth:up"]);
    expect(rig.capture.polling()).toBe(false);
  });

  it("stops polling on dispose, drops its listeners, and lets go of anything held", () => {
    rig.pads = [pad({ buttons: buttons({ 3: true }) })];
    rig.frame();
    expect(rig.take()).toEqual(["faceNorth:down"]);
    rig.capture.dispose();
    expect(rig.take()).toEqual(["faceNorth:up"]);
    expect(rig.capture.polling()).toBe(false);
    expect(rig.pendingFrames()).toBe(0);
    expect(rig.events.listeners("gamepadconnected")).toBe(0);
    expect(rig.events.listeners("gamepaddisconnected")).toBe(0);
    expect(rig.visibility.listeners("visibilitychange")).toBe(0);
    // Nothing can restart it: a fired event, a frame, a refresh are all inert after dispose.
    rig.events.fire("gamepadconnected");
    rig.capture.refresh();
    rig.frames(3);
    expect(rig.take()).toEqual([]);
    expect(() => rig.capture.dispose()).not.toThrow();
  });

  it("sends nothing while the setting is off, and releases a held control when it goes off", () => {
    rig.pads = [pad({ buttons: buttons({ 0: true }) })];
    rig.frame();
    expect(rig.take()).toEqual(["faceSouth:down"]);
    rig.enabled = false;
    rig.frame();
    expect(rig.take()).toEqual(["faceSouth:up"]);
    expect(rig.capture.polling()).toBe(false);
    rig.pads = [pad({ buttons: buttons({ 0: true, 1: true }) })];
    rig.capture.refresh();
    rig.frames(3);
    expect(rig.take()).toEqual([]);
    // …and flipping it back on lands on the next frame, without waiting for a reconnect.
    rig.enabled = true;
    rig.capture.refresh();
    rig.frame();
    expect(rig.take()).toEqual(["faceSouth:down", "faceEast:down"]);
  });

  it("stops (and lets go) while the page is hidden, and resumes when it comes back", () => {
    rig.pads = [pad({ buttons: buttons({ 4: true }) })];
    rig.frame();
    expect(rig.take()).toEqual(["leftBumper:down"]);
    rig.visibilityState = "hidden";
    rig.visibility.fire("visibilitychange");
    expect(rig.take()).toEqual(["leftBumper:up"]);
    expect(rig.capture.polling()).toBe(false);
    rig.frames(2);
    expect(rig.take()).toEqual([]);
    rig.visibilityState = "visible";
    rig.visibility.fire("visibilitychange");
    rig.frame();
    expect(rig.take()).toEqual(["leftBumper:down"]);
  });

  it("is completely inert where the Gamepad API does not exist (every plain-HTTP join)", () => {
    const insecure = harness({ api: false, pads: [pad({ buttons: buttons({ 0: true }) })] });
    expect(insecure.capture.polling()).toBe(false);
    expect(insecure.pendingFrames()).toBe(0);
    expect(insecure.events.listeners("gamepadconnected")).toBe(0);
    expect(insecure.visibility.listeners("visibilitychange")).toBe(0);
    expect(() => {
      insecure.events.fire("gamepadconnected");
      insecure.capture.refresh();
      insecure.frames(3);
      insecure.capture.dispose();
    }).not.toThrow();
    expect(insecure.take()).toEqual([]);
  });

  it("keeps one message per token per edge with everything reachable pressed at once", () => {
    // Every control a single pad can hold simultaneously: all 15 mapped buttons, with the stick pushed up-left so
    // its two directions land on d-pad tokens the buttons already hold. The four stick directions never reach the
    // wire (WIRE_SUPPRESSED), so what is expected is the 15 button tokens.
    const everything = PAD_TOKENS.filter(
      (token) => !["stickUp", "stickDown", "stickLeft", "stickRight"].includes(token)
    );
    rig.pads = [
      pad({
        buttons: buttons({
          0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: 1, 7: 1,
          8: true, 9: true, 10: true, 12: true, 13: true, 14: true, 15: true
        }),
        axes: [-1, -1]
      })
    ];
    rig.frame();
    expect(rig.take()).toEqual(everything.map((token) => `${token}:down`));
    rig.frames(3);
    expect(rig.take()).toEqual([]);
    rig.pads = [pad()];
    rig.frame();
    expect(rig.take()).toEqual(everything.map((token) => `${token}:up`));
  });
});


describe("capture after host access resumes", () => {
  it("neutralizes held buttons and axes independently until released, preserving hysteresis", () => {
    const h = harness({ neutralizeHeldOnStart: true,
      pads: [pad({ buttons: buttons({ 0: true }), axes: [0.8, 0] })] });
    h.frame();
    h.pads = [pad({ buttons: buttons({ 0: true }), axes: [0.45, 0] })];
    h.frames(3);
    expect(h.take()).toEqual([]);
    h.pads = [pad({ axes: [0.45, 0] })];
    h.frame();
    expect(h.take()).toEqual([]);
    h.pads = [pad({ buttons: buttons({ 0: true }), axes: [0.45, 0] })];
    h.frame();
    expect(h.take()).toEqual(["faceSouth:down"]);
    h.pads = [pad({ buttons: buttons({ 0: true }), axes: [0, 0] })];
    h.frame();
    expect(h.take()).toEqual([]);
    h.pads = [pad({ buttons: buttons({ 0: true }), axes: [0.8, 0] })];
    h.frame();
    expect(h.take()).toEqual(["dpadRight:down"]);
    h.capture.dispose();
    expect(h.take()).toEqual(["faceSouth:up", "dpadRight:up"]);
  });

  it("requires analogue controls initially inside the hysteresis band to reach neutral", () => {
    const h = harness({ neutralizeHeldOnStart: true,
      pads: [pad({ buttons: buttons({ 6: 0.45 }), axes: [0.45, 0] })] });
    h.frame();
    h.pads = [pad({ buttons: buttons({ 6: 0.8 }), axes: [0.8, 0] })];
    h.frame();
    expect(h.take()).toEqual([]);
    h.pads = [pad()];
    h.frame();
    h.pads = [pad({ buttons: buttons({ 6: 0.8 }), axes: [0.8, 0] })];
    h.frame();
    expect(h.take()).toEqual(["leftTrigger:down", "dpadRight:down"]);
    h.capture.dispose();
  });

  it("waits for the first usable pad when the browser initially exposes none", () => {
    const h = harness({ neutralizeHeldOnStart: true, pads: [null] });
    h.frame();
    expect(h.capture.polling()).toBe(false);
    h.pads = [pad({ buttons: buttons({ 0: true }), axes: [-0.8, 0] })];
    h.events.fire("gamepadconnected");
    h.frames(2);
    expect(h.take()).toEqual([]);
    h.pads = [pad()];
    h.frame();
    h.pads = [pad({ buttons: buttons({ 0: true }), axes: [-0.8, 0] })];
    h.frame();
    expect(h.take()).toEqual(["faceSouth:down", "dpadLeft:down"]);
    h.capture.dispose();
  });

  it("disposes suppressed holds without emitting orphan release edges", () => {
    const h = harness({ neutralizeHeldOnStart: true,
      pads: [pad({ buttons: buttons({ 0: true }), axes: [0.8, 0] })] });
    h.frame();
    h.capture.dispose();
    expect(h.take()).toEqual([]);
  });

  it("keeps immediate held-control admission for an ordinary initial mount", () => {
    const h = harness({ pads: [pad({ buttons: buttons({ 0: true }), axes: [0.8, 0] })] });
    h.frame();
    expect(h.take()).toEqual(["faceSouth:down", "dpadRight:down"]);
    h.capture.dispose();
  });
});
