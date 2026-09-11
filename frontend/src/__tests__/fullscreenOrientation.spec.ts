import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useFullscreen,
  type FullscreenControls,
  type FullscreenSeams,
  type OrientationSeam
} from "@/composables/useFullscreen";

// WS2 — the automatic Android path: enter fullscreen off the seat tap, LOCK LANDSCAPE on every way in, release
// on the way out, and put the page back after an INVOLUNTARY exit without ever fighting a player who left on
// purpose. iPhone Safari has no element Fullscreen API, so the whole path is inert there by construction — the
// `isSupported` gate below is what expresses that.

function setFullscreenEnabled(value: boolean): void {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value });
}

function setFullscreenElement(element: Element | null): void {
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    writable: true,
    value: element
  });
}

function fakeOrientation(over: { lockRejects?: boolean } = {}) {
  const locks: string[] = [];
  let unlocks = 0;
  const seam: OrientationSeam = {
    lock: (orientation: "landscape") => {
      locks.push(orientation);
      return over.lockRejects
        ? Promise.reject(new Error("NotSupportedError"))
        : Promise.resolve(undefined);
    },
    unlock: () => void (unlocks += 1)
  };
  return { seam, locks, unlockCount: () => unlocks };
}

// Every scope here is standing in for a PHONE — the automatic paths are gated on a coarse pointer, which
// jsdom does not report — so the seam defaults on and the desktop case gets its own test at the bottom.
function runInScope(seams: FullscreenSeams = {}): { api: FullscreenControls; stop: () => void } {
  const scope = effectScope();
  const api = scope.run(() => useFullscreen({ coarsePointer: true, ...seams })) as FullscreenControls;
  return { api, stop: () => scope.stop() };
}

/** Pretend the browser entered/left fullscreen, which is what actually drives the policy. */
async function fullscreenChangeTo(element: Element | null): Promise<void> {
  setFullscreenElement(element);
  document.dispatchEvent(new Event("fullscreenchange"));
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
  vi.restoreAllMocks();
});

describe("useFullscreen — landscape lock", () => {
  it("locks landscape whenever the document ENTERS fullscreen, by whatever route", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const orientation = fakeOrientation();
    const { api, stop } = runInScope({ orientation: orientation.seam, search: "" });

    // Route 1: the seat tap (autoEnter → requestFullscreen).
    document.documentElement.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    await api.autoEnter();
    expect(orientation.locks).toEqual(["landscape"]);

    // Route 2: FullscreenButton, or anything else the browser reports as a change — the whole point of hanging
    // the lock off `fullscreenchange` rather than off the seat-commit call site.
    await fullscreenChangeTo(document.documentElement);
    expect(orientation.locks.length).toBeGreaterThanOrEqual(2);
    expect(api.isOrientationLocked.value).toBe(true);
    stop();
  });

  it("releases the lock on exit so the page rotates freely again", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const orientation = fakeOrientation();
    const { api, stop } = runInScope({ orientation: orientation.seam, search: "" });

    await fullscreenChangeTo(document.documentElement);
    expect(api.isOrientationLocked.value).toBe(true);

    await fullscreenChangeTo(null);
    expect(orientation.unlockCount()).toBe(1);
    expect(api.isOrientationLocked.value).toBe(false);
    stop();
  });

  // A rejection is a platform saying "no" (Safari, desktop Firefox), not an error — and WS3's portrait nag is
  // the fallback for exactly that, which is why `isOrientationLocked` must stay FALSE rather than optimistic.
  it("treats a rejected lock as simply unlocked", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const orientation = fakeOrientation({ lockRejects: true });
    const { api, stop } = runInScope({ orientation: orientation.seam, search: "" });

    await fullscreenChangeTo(document.documentElement);
    expect(orientation.locks).toEqual(["landscape"]);
    expect(api.isOrientationLocked.value).toBe(false);
    stop();
  });

  it("is inert where there is no ScreenOrientation at all (iOS Safari)", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const { api, stop } = runInScope({ orientation: null, search: "" });
    await fullscreenChangeTo(document.documentElement);
    expect(api.isOrientationLocked.value).toBe(false);
    stop();
  });

  it("skips the lock under ?orientationLock=off", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const orientation = fakeOrientation();
    const { api, stop } = runInScope({
      orientation: orientation.seam,
      search: "?orientationLock=off"
    });
    await fullscreenChangeTo(document.documentElement);
    expect(orientation.locks).toEqual([]);
    expect(api.isOrientationLocked.value).toBe(false);
    stop();
  });
});

describe("useFullscreen — re-entry after an exit", () => {
  it("re-enters on the next pointerdown after an INVOLUNTARY exit", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    const { stop } = runInScope({ orientation: null, search: "" });

    await fullscreenChangeTo(document.documentElement);
    await fullscreenChangeTo(null); // the system took it away

    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);

    // One shot: a second tap must not keep re-requesting.
    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    stop();
  });

  // The rule that keeps us from fighting the user: leaving via OUR button is a decision, and the very next tap
  // (on the game, on the picker, anywhere) must not undo it.
  it("does NOT re-enter after the player exits deliberately via the toggle", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(document.documentElement);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    document.exitFullscreen = vi.fn().mockResolvedValue(undefined);
    const { api, stop } = runInScope({ orientation: null, search: "" });

    await api.toggle(); // the button: we were fullscreen, so this exits
    await fullscreenChangeTo(null);

    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(requestFullscreen).not.toHaveBeenCalled();
    stop();
  });

  // Escape is the desktop version of the same decision. Without this, pressing Esc and then clicking anything
  // would slam the page straight back into fullscreen.
  it("does NOT re-enter after an Escape-driven exit", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(document.documentElement);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    const { stop } = runInScope({ orientation: null, search: "" });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await fullscreenChangeTo(null);

    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(requestFullscreen).not.toHaveBeenCalled();
    stop();
  });

  it("re-arms again after the player comes back into fullscreen", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(document.documentElement);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    document.exitFullscreen = vi.fn().mockResolvedValue(undefined);
    const { api, stop } = runInScope({ orientation: null, search: "" });

    await api.toggle(); // deliberate exit
    await fullscreenChangeTo(null);
    await fullscreenChangeTo(document.documentElement); // …and back in, by any route
    await fullscreenChangeTo(null); // now an involuntary exit

    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    stop();
  });

  it("arms nothing under ?autoFullscreen=off, and autoEnter() is a no-op there", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    const { api, stop } = runInScope({ orientation: null, search: "?autoFullscreen=off" });

    await api.autoEnter();
    expect(requestFullscreen).not.toHaveBeenCalled();

    await fullscreenChangeTo(document.documentElement);
    await fullscreenChangeTo(null);
    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(requestFullscreen).not.toHaveBeenCalled();

    // The manual button still works — the valve is about the AUTOMATIC paths only.
    await api.enter();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    stop();
  });

  // DESKTOP. The automatic paths are a phone feature: a mouse user has no browser chrome eating their landscape
  // screen and no system gesture dropping fullscreen behind their back, so swallowing the whole screen on a seat
  // pick would just be rude. The explicit button is untouched.
  it("does nothing automatic on a fine pointer — no seat-tap entry, no rearm", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    const { api, stop } = runInScope({ orientation: null, search: "", coarsePointer: false });

    await api.autoEnter();
    expect(requestFullscreen).not.toHaveBeenCalled();

    await fullscreenChangeTo(document.documentElement);
    await fullscreenChangeTo(null);
    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(requestFullscreen).not.toHaveBeenCalled();

    // …and the button still works, which is the whole point of keeping the two paths separate.
    await api.enter();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    stop();
  });

  // Every listener is document-level and shared, so a leak here would outlive the app and keep grabbing taps.
  it("drops its document listeners once the last scope is gone", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;

    const first = runInScope({ orientation: null, search: "" });
    const second = runInScope({ orientation: null, search: "" });
    await fullscreenChangeTo(document.documentElement);
    await fullscreenChangeTo(null);

    // Still one live scope: the rearm is real.
    first.stop();
    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);

    second.stop();
    await fullscreenChangeTo(document.documentElement);
    await fullscreenChangeTo(null);
    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });
});
