// BROWSER KEYBOARD CAPTURE — the mirror's third upstream input source, beside the pointer/touch capture
// (inputCapture.ts) and the pad poll (gamepadCapture.ts).
//
// WHAT GOES ON THE WIRE. EDGES, exactly like the pad: `{kind:"key", key:<KeyboardEvent.code>, modifiers?, pressed}`
// — one message when a key goes down, one when it comes up, and never a repeat while it is held. The host injects a
// real `InputEventKey` at the seat, and the GAME maps that physical key onto its own abstract input, honouring the
// player's own rebinds — so CouchCoop names no game action and re-implements no shortcut of its own.
//
// WHY EDGES AND NOT THE TAP THIS USED TO SEND. A tap (press+release in one host turn) cannot express a held key,
// and it is not what a keyboard does. The edges also cost nothing extra: the host has always accepted `pressed`
// (BrowserInputRequestEnvelope.Pressed), and the server-side InputCoalescer never merges or drops a discrete
// message, so both edges of a press arrive in order.
//
// BROWSER AUTO-REPEAT IS DROPPED (`event.repeat`), and that is the faithful reading rather than a simplification:
// the game's own key handling ignores echo keys, so a held key does not re-fire its action natively either. What a
// held key DOES do — stay down for anything that reads the key's state — is preserved by the release edge.
//
// NOTHING MAY STICK DOWN. A press latches its code here and only a matching release clears it, so every path that
// can end a gesture without a keyup — the tab going away, the window losing focus, the page being put in the
// back/forward cache, the setting being turned off, an unmount — releases everything still latched. And the release
// itself is UNGATED: once a press has gone out, its release goes out too, whatever the modifiers or the focused
// element have since become. A filter applied to a release is how a key gets stuck down in someone's game.
//
// WHY THIS IS NOT PART OF inputCapture.ts. No coordinate resolution, no DOM probes, none of the gesture state
// machine's vocabulary, and a different lifecycle (window-level events rather than stage-level ones). The only
// thing the three captures share is the send path.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only.

import type { MirrorInputMessage } from "@/mirror/mirrorClient";

/**
 * Keys that would scroll (or tab out of) the page, suppressed when we forward them so the page stays put while the
 * game reads them. Only ever applied to a key we actually sent: a key the filter below refused keeps its browser
 * behaviour, and so does every ctrl/meta chord (see `onKeyDown`), which is what keeps reload and devtools working.
 */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End"
]);

/**
 * Named keys the host can map. The letter / digit / numpad / function families are matched by SHAPE below.
 *
 * This list is a CONSERVATIVE MIRROR of the host's table, not a second authority: spirectl's `Sts2BrowserKeyMap`
 * (../spirectl → bridge-mod/src/Spirectl.Sts2/Live/Sts2BrowserKeyMap.cs) owns the vocabulary and still refuses
 * anything it does not know. The filter exists because a key the host cannot map costs an error envelope per
 * message, and with edges that is two per press — a player resting a hand on a keyboard would otherwise stream
 * failures at the host. A key the host learns and this file has not is simply not forwarded until it is added
 * here: a gap, never a wrong action.
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
 * `<input>` types that take TEXT. Everything else an `<input>` can be — a checkbox, a radio, a range, a colour or
 * file picker, a button — does not consume typing, and must therefore not blind the game.
 *
 * This distinction is the whole of a real bug: the previous guard treated EVERY `<input>` as text entry, the
 * settings panel is a dozen checkboxes, and the stage's pointerdown calls `preventDefault()` (which suppresses the
 * browser's default focus change). So one click on a settings checkbox left it as `document.activeElement` for the
 * rest of the session and silently swallowed every key from then on, while the mouse kept working.
 */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week"
]);

/** Keys that ACTIVATE a focused browser control. Left to the browser when one has focus — see `chromeActivation`. */
const ACTIVATION_CODES: ReadonlySet<string> = new Set(["Space", "Enter", "NumpadEnter"]);

/** Is the focused element taking typed text? Only then does a key belong to the page rather than the game. */
function isTextEntry(element: Element | null): boolean {
  if (!element) {
    return false;
  }
  const tag = element.tagName;
  if (tag === "TEXTAREA") {
    return true;
  }
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type;
    return type === undefined || type === null || type === "" || TEXT_INPUT_TYPES.has(type.toLowerCase());
  }
  return (element as HTMLElement).isContentEditable === true;
}

/**
 * Would this key ACTIVATE the focused browser control? A focused checkbox still toggles on Space, a focused button
 * still fires on Enter — the key belongs to the control the viewer deliberately focused, not to the game. Every
 * other key (a digit, a letter, `E`) goes to the game even with such a control focused, which is what makes the
 * settings panel usable without costing the keyboard.
 */
function chromeActivation(element: Element | null, code: string): boolean {
  if (!element || !ACTIVATION_CODES.has(code)) {
    return false;
  }
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT") {
    return true;
  }
  if (tag === "A" && element.hasAttribute("href")) {
    return true;
  }
  return element.getAttribute("role") === "button" || element.hasAttribute("tabindex");
}

/**
 * The comma-separated modifier list the host parses (`ParseModifiers` in spirectl). Order is fixed so two presses
 * of the same chord serialise identically.
 */
export function modifierString(event: Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): string {
  return [
    event.ctrlKey ? "ctrl" : "",
    event.shiftKey ? "shift" : "",
    event.altKey ? "alt" : "",
    event.metaKey ? "meta" : ""
  ]
    .filter(Boolean)
    .join(",");
}

/** Where `keydown` / `keyup` / `blur` / `pagehide` are heard. The real `window` satisfies it. */
export interface KeyEventSource {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** The page-visibility source (the real `document`), which also answers "who has focus". */
export interface KeyVisibilitySource extends KeyEventSource {
  visibilityState?: string;
  activeElement?: Element | null;
}

export interface KeyboardCaptureOptions {
  /** The mirror's upstream send — the same one the pointer and the pad use. */
  send: (message: MirrorInputMessage) => void;
  /**
   * The `keyboard` setting, read LIVE (per event) so a flip lands on the next keystroke. Absent ⇒ always enabled.
   * Turning it off releases anything held — via `refresh()`, which is also how the flip back on is picked up.
   */
  enabled?: () => boolean;
  /** Where the key + lifecycle events are heard. Defaults to `window`; `null` ⇒ the capture is inert. */
  events?: KeyEventSource | null;
  /** Where `visibilitychange` is heard, and what answers "is the page visible" / "what has focus". */
  visibility?: KeyVisibilitySource | null;
  /**
   * The focused element, for the two guards above. Defaults to the visibility source's `activeElement` (i.e.
   * `document`'s), and is injectable so a spec can drive the guards without a real focus.
   */
  activeElement?: () => Element | null;
}

export interface KeyboardCapture {
  /** Re-read the setting: off releases everything held. Cheap and idempotent. */
  refresh(): void;
  /** Drop every listener and release anything still held, so no key can stick down on the seat. */
  dispose(): void;
  /** The codes currently held, in press order. Diagnostics + specs only. */
  held(): readonly string[];
}

/**
 * Create the keyboard capture. Inert (and harmless) wherever there is no window to listen on, so callers never
 * have to guard the construction.
 */
export function createKeyboardCapture(options: KeyboardCaptureOptions): KeyboardCapture {
  const send = options.send;
  const enabled = options.enabled ?? (() => true);
  const events = options.events === undefined ? (typeof window === "undefined" ? null : window) : options.events;
  const visibility =
    options.visibility === undefined ? (typeof document === "undefined" ? null : document) : options.visibility;
  const activeElement = options.activeElement ?? (() => visibility?.activeElement ?? null);

  // code → the modifier string its PRESS carried. The release replays that string rather than reading the live
  // modifier state: the two messages then describe the same keystroke even if the viewer let go of shift first.
  const held = new Map<string, string>();
  let disposed = false;

  function pageVisible(): boolean {
    // An environment with no visibility signal at all (jsdom without the property, an older engine) counts as
    // visible — the page is being played, and refusing to forward keys there would be a silent dead feature.
    return visibility?.visibilityState === undefined ? true : visibility.visibilityState !== "hidden";
  }

  /** Release everything still held, in press order. Idempotent — an empty latch sends nothing. */
  function releaseAll(): void {
    if (held.size === 0) {
      return;
    }
    const pending = [...held.entries()];
    held.clear();
    for (const [code, modifiers] of pending) {
      send({ kind: "key", key: code, ...(modifiers ? { modifiers } : {}), pressed: false });
    }
  }

  function onKeyDown(event: Event): void {
    const key = event as KeyboardEvent;
    if (disposed || key.repeat || enabled() === false || !pageVisible()) {
      return;
    }
    const code = key.code;
    if (!isForwardableCode(code)) {
      return;
    }
    // ctrl/meta chords are the browser's and the OS's (reload, devtools, tab switching, the app menu). The game
    // binds no such chord, so forwarding one only ever meant doing BOTH — reloading the page and firing the key
    // into a live run.
    if (key.ctrlKey || key.metaKey) {
      return;
    }
    const focused = activeElement();
    if (isTextEntry(focused) || chromeActivation(focused, code)) {
      return;
    }
    // A code already latched has had no keyup (a focus round trip can eat one). Re-sending the press would leave
    // the game with two downs and one up; the existing latch already has the key down.
    if (held.has(code)) {
      return;
    }
    const modifiers = modifierString(key);
    held.set(code, modifiers);
    send({ kind: "key", key: code, ...(modifiers ? { modifiers } : {}), pressed: true });
    if (SCROLL_KEYS.has(code)) {
      event.preventDefault();
    }
  }

  // UNGATED on purpose — see the header. The latch is the only authority on whether a release is owed.
  function onKeyUp(event: Event): void {
    const code = (event as KeyboardEvent).code;
    const modifiers = held.get(code);
    if (modifiers === undefined) {
      return;
    }
    held.delete(code);
    send({ kind: "key", key: code, ...(modifiers ? { modifiers } : {}), pressed: false });
    if (SCROLL_KEYS.has(code)) {
      event.preventDefault();
    }
  }

  // The window losing focus is the classic lost-keyup: the viewer alt-tabs mid-press and the keyup lands somewhere
  // else entirely. Same for the tab being hidden and for the page being frozen into the back/forward cache.
  const onBlur = (): void => releaseAll();
  const onPageHide = (): void => releaseAll();
  const onVisibility = (): void => {
    if (!pageVisible()) {
      releaseAll();
    }
  };

  if (events) {
    events.addEventListener("keydown", onKeyDown);
    events.addEventListener("keyup", onKeyUp);
    events.addEventListener("blur", onBlur);
    events.addEventListener("pagehide", onPageHide);
    visibility?.addEventListener("visibilitychange", onVisibility);
  }

  return {
    refresh(): void {
      if (disposed) {
        return;
      }
      if (enabled() === false) {
        releaseAll();
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (events) {
        events.removeEventListener("keydown", onKeyDown);
        events.removeEventListener("keyup", onKeyUp);
        events.removeEventListener("blur", onBlur);
        events.removeEventListener("pagehide", onPageHide);
        visibility?.removeEventListener("visibilitychange", onVisibility);
      }
      // An unmount mid-press must not leave the seat holding a key. The send is a no-op on a closed socket.
      releaseAll();
    },
    held(): readonly string[] {
      return [...held.keys()];
    }
  };
}
