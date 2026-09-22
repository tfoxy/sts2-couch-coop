import { beforeEach, describe, expect, it } from "vitest";

import {
  createKeyboardCapture,
  isForwardableCode,
  modifierString,
  type KeyboardCapture
} from "@/mirror/keyboardCapture";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";

// BROWSER KEYBOARD CAPTURE. What these specs pin, in the order the module's header argues it:
//
//   * only EDGES reach the wire — one message down, one up, nothing while a key is held (auto-repeat is dropped);
//   * the code filter refuses what the host's key map cannot name, so a stray key costs no error round trip;
//   * ctrl/meta chords stay the browser's (reload, devtools) and never reach the game;
//   * a TEXT field swallows keys; a checkbox, a slider or a button does NOT — the regression that made the
//     keyboard dead for a whole session once a settings checkbox had been clicked;
//   * a release is UNGATED: once a press went out, its release goes out whatever has since changed;
//   * every way the page can lose the keyup — blur, hidden tab, pagehide, the setting going off, dispose —
//     releases what is held.
//
// Driven through injected seams (stub event targets, an injected `activeElement`) so nothing depends on jsdom's
// focus behaviour.

// ---- fakes ---------------------------------------------------------------------------------------------------

interface FakeEvents {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  fire(type: string, event?: Partial<KeyboardEvent>): { defaultPrevented: boolean };
  listeners(type: string): number;
  visibilityState?: string;
}

function fakeEvents(): FakeEvents {
  const handlers = new Map<string, Set<(event: Event) => void>>();
  return {
    addEventListener(type, listener) {
      const set = handlers.get(type) ?? new Set<(event: Event) => void>();
      set.add(listener);
      handlers.set(type, set);
    },
    removeEventListener(type, listener) {
      handlers.get(type)?.delete(listener);
    },
    fire(type, event = {}) {
      let defaultPrevented = false;
      const payload = {
        code: "",
        repeat: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ...event,
        preventDefault(): void {
          defaultPrevented = true;
        }
      } as unknown as Event;
      for (const listener of [...(handlers.get(type) ?? [])]) {
        listener(payload);
      }
      return { defaultPrevented };
    },
    listeners(type) {
      return handlers.get(type)?.size ?? 0;
    }
  };
}

/** An element stub for the focus guards — only the members the guards read. */
function element(tagName: string, attrs: Record<string, string> = {}, contentEditable = false): Element {
  return {
    tagName,
    type: attrs.type,
    isContentEditable: contentEditable,
    hasAttribute: (name: string) => name in attrs,
    getAttribute: (name: string) => attrs[name] ?? null
  } as unknown as Element;
}

describe("keyboardCapture", () => {
  let sent: MirrorInputMessage[];
  let events: FakeEvents;
  let visibility: FakeEvents;
  let focused: Element | null;
  let enabled: boolean;
  let capture: KeyboardCapture;

  beforeEach(() => {
    sent = [];
    events = fakeEvents();
    visibility = fakeEvents();
    visibility.visibilityState = "visible";
    focused = null;
    enabled = true;
    capture = createKeyboardCapture({
      send: (message) => sent.push(message),
      enabled: () => enabled,
      events,
      visibility: visibility as unknown as Parameters<typeof createKeyboardCapture>[0]["visibility"],
      activeElement: () => focused
    });
  });

  // ---- edges -----------------------------------------------------------------------------------------------

  it("sends one press edge and one release edge, and nothing while the key is held", () => {
    events.fire("keydown", { code: "KeyE" });
    expect(sent).toEqual([{ kind: "key", key: "KeyE", pressed: true }]);

    events.fire("keydown", { code: "KeyE", repeat: true });
    events.fire("keydown", { code: "KeyE", repeat: true });
    expect(sent).toHaveLength(1);
    expect(capture.held()).toEqual(["KeyE"]);

    events.fire("keyup", { code: "KeyE" });
    expect(sent).toEqual([
      { kind: "key", key: "KeyE", pressed: true },
      { kind: "key", key: "KeyE", pressed: false }
    ]);
    expect(capture.held()).toEqual([]);
  });

  it("carries the modifiers of the press on both edges", () => {
    events.fire("keydown", { code: "Digit1", shiftKey: true, altKey: true });
    // The viewer lets go of shift before the key: the release still describes the keystroke that was sent.
    events.fire("keyup", { code: "Digit1" });
    expect(sent).toEqual([
      { kind: "key", key: "Digit1", modifiers: "shift,alt", pressed: true },
      { kind: "key", key: "Digit1", modifiers: "shift,alt", pressed: false }
    ]);
  });

  it("holds several keys at once and releases each on its own edge", () => {
    events.fire("keydown", { code: "KeyA" });
    events.fire("keydown", { code: "KeyD" });
    expect(capture.held()).toEqual(["KeyA", "KeyD"]);

    events.fire("keyup", { code: "KeyA" });
    expect(capture.held()).toEqual(["KeyD"]);
    expect(sent.at(-1)).toEqual({ kind: "key", key: "KeyA", pressed: false });
  });

  it("ignores a keyup for a key it never sent a press for", () => {
    events.fire("keyup", { code: "KeyE" });
    expect(sent).toHaveLength(0);
  });

  it("does not re-press a key whose keyup was lost", () => {
    events.fire("keydown", { code: "Space" });
    events.fire("keydown", { code: "Space" });
    expect(sent.filter((m) => m.pressed === true)).toHaveLength(1);
  });

  // ---- what reaches the wire at all ------------------------------------------------------------------------

  it("forwards exactly the code families the host can map", () => {
    for (const code of ["KeyE", "Digit0", "Numpad7", "F9", "Escape", "ArrowUp", "Minus", "NumpadEnter"]) {
      expect(isForwardableCode(code)).toBe(true);
    }
    for (const code of ["ShiftLeft", "ControlLeft", "CapsLock", "BracketLeft", "Comma", "F13", "Insert", ""]) {
      expect(isForwardableCode(code)).toBe(false);
    }
  });

  it("sends nothing for a key the host's map has no name for", () => {
    events.fire("keydown", { code: "ShiftLeft" });
    events.fire("keyup", { code: "ShiftLeft" });
    expect(sent).toHaveLength(0);
  });

  it("leaves ctrl / meta chords to the browser", () => {
    const reload = events.fire("keydown", { code: "KeyR", ctrlKey: true });
    const find = events.fire("keydown", { code: "KeyF", metaKey: true });
    expect(sent).toHaveLength(0);
    expect(reload.defaultPrevented).toBe(false);
    expect(find.defaultPrevented).toBe(false);
  });

  it("suppresses the page scroll only for a key it actually forwards", () => {
    expect(events.fire("keydown", { code: "ArrowDown" }).defaultPrevented).toBe(true);
    expect(events.fire("keydown", { code: "KeyE" }).defaultPrevented).toBe(false);
    // A scroll key the browser is meant to keep (a ctrl chord) is not stolen from it.
    expect(events.fire("keydown", { code: "Home", ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("builds the modifier list in the host's order", () => {
    expect(modifierString({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: true })).toBe("ctrl,shift,meta");
    expect(modifierString({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })).toBe("");
  });

  // ---- focus guards ----------------------------------------------------------------------------------------

  it("lets a text field keep its keys", () => {
    focused = element("INPUT", { type: "text" });
    events.fire("keydown", { code: "KeyE" });
    focused = element("TEXTAREA");
    events.fire("keydown", { code: "KeyA" });
    focused = element("DIV", {}, true);
    events.fire("keydown", { code: "KeyD" });
    expect(sent).toHaveLength(0);
  });

  // The regression: the previous guard treated every <input> as text entry, and because the stage's pointerdown
  // calls preventDefault(), a clicked settings checkbox kept focus for the rest of the session — which made the
  // whole keyboard dead while the mouse kept working.
  it("keeps sending game keys while a settings checkbox holds focus", () => {
    focused = element("INPUT", { type: "checkbox" });
    events.fire("keydown", { code: "KeyE" });
    events.fire("keydown", { code: "Digit1" });
    expect(sent.map((m) => m.key)).toEqual(["KeyE", "Digit1"]);
  });

  it("leaves the activation key to a focused browser control", () => {
    focused = element("INPUT", { type: "checkbox" });
    events.fire("keydown", { code: "Space" });
    focused = element("BUTTON");
    events.fire("keydown", { code: "Enter" });
    expect(sent).toHaveLength(0);

    // …but only the activation key. Everything else still drives the game.
    events.fire("keydown", { code: "Escape" });
    expect(sent).toEqual([{ kind: "key", key: "Escape", pressed: true }]);
  });

  it("releases a key even if a text field takes focus mid-press", () => {
    events.fire("keydown", { code: "KeyE" });
    focused = element("INPUT", { type: "text" });
    events.fire("keyup", { code: "KeyE" });
    expect(sent.at(-1)).toEqual({ kind: "key", key: "KeyE", pressed: false });
    expect(capture.held()).toEqual([]);
  });

  it("releases a key even if ctrl goes down mid-press", () => {
    events.fire("keydown", { code: "KeyE" });
    events.fire("keyup", { code: "KeyE", ctrlKey: true });
    expect(sent.at(-1)).toEqual({ kind: "key", key: "KeyE", pressed: false });
  });

  // ---- nothing sticks --------------------------------------------------------------------------------------

  it("releases everything held when the window loses focus", () => {
    events.fire("keydown", { code: "KeyA" });
    events.fire("keydown", { code: "KeyD" });
    sent = [];
    events.fire("blur");
    expect(sent).toEqual([
      { kind: "key", key: "KeyA", pressed: false },
      { kind: "key", key: "KeyD", pressed: false }
    ]);
    expect(capture.held()).toEqual([]);
    // Idempotent: a second blur has nothing left to let go of.
    events.fire("blur");
    expect(sent).toHaveLength(2);
  });

  it("releases everything held when the tab is hidden, and stops sending until it is back", () => {
    events.fire("keydown", { code: "KeyE" });
    sent = [];
    visibility.visibilityState = "hidden";
    visibility.fire("visibilitychange");
    expect(sent).toEqual([{ kind: "key", key: "KeyE", pressed: false }]);

    events.fire("keydown", { code: "KeyE" });
    expect(sent).toHaveLength(1);

    visibility.visibilityState = "visible";
    visibility.fire("visibilitychange");
    events.fire("keydown", { code: "KeyE" });
    expect(sent.at(-1)).toEqual({ kind: "key", key: "KeyE", pressed: true });
  });

  it("releases everything held on pagehide", () => {
    events.fire("keydown", { code: "Space" });
    sent = [];
    events.fire("pagehide");
    expect(sent).toEqual([{ kind: "key", key: "Space", pressed: false }]);
  });

  it("releases everything held when the setting is turned off, and sends nothing while it is off", () => {
    events.fire("keydown", { code: "KeyE" });
    sent = [];
    enabled = false;
    capture.refresh();
    expect(sent).toEqual([{ kind: "key", key: "KeyE", pressed: false }]);

    events.fire("keydown", { code: "KeyE" });
    expect(sent).toHaveLength(1);

    enabled = true;
    capture.refresh();
    events.fire("keydown", { code: "KeyE" });
    expect(sent.at(-1)).toEqual({ kind: "key", key: "KeyE", pressed: true });
  });

  it("releases everything held on dispose, and goes deaf afterwards", () => {
    events.fire("keydown", { code: "KeyE" });
    sent = [];
    capture.dispose();
    expect(sent).toEqual([{ kind: "key", key: "KeyE", pressed: false }]);
    expect(events.listeners("keydown")).toBe(0);
    expect(events.listeners("keyup")).toBe(0);
    expect(events.listeners("blur")).toBe(0);
    expect(events.listeners("pagehide")).toBe(0);
    expect(visibility.listeners("visibilitychange")).toBe(0);

    sent = [];
    capture.dispose();
    expect(sent).toHaveLength(0);
  });

  it("is inert without an event source", () => {
    const messages: MirrorInputMessage[] = [];
    const inert = createKeyboardCapture({ send: (m) => messages.push(m), events: null, visibility: null });
    inert.refresh();
    inert.dispose();
    expect(messages).toHaveLength(0);
    expect(inert.held()).toEqual([]);
  });
});
