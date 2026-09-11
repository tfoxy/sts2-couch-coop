import { onScopeDispose, shallowRef, type ShallowRef } from "vue";

/** The slice of `screen.orientation` this module uses. Injectable so the policy is testable without a device. */
export interface OrientationSeam {
  lock?: (orientation: "landscape") => Promise<void>;
  unlock?: () => void;
}

export interface FullscreenSeams {
  /** Defaults to `screen.orientation`. `null` means "this platform has none" (Safari). */
  orientation?: OrientationSeam | null;
  /** Kill-switch source; defaults to the page URL's query string. */
  search?: string;
  /** Defaults to `matchMedia("(pointer: coarse)")` — see {@link isTouchDevice}. */
  coarsePointer?: boolean;
}

export interface FullscreenControls {
  /** Whether the document is currently in fullscreen (tracks `fullscreenchange`). */
  isFullscreen: ShallowRef<boolean>;
  /** Whether the Fullscreen API is available and allowed in this document. */
  isSupported: boolean;
  /**
   * Whether a landscape orientation lock is actually HELD right now. This is WS3's suppression signal: a
   * portrait nag would be nonsense on a device the browser has already pinned to landscape for us.
   */
  isOrientationLocked: ShallowRef<boolean>;
  enter: () => Promise<void>;
  /**
   * The AUTOMATIC entry path — the seat tap. Identical to {@link enter} except that it only fires on a TOUCH
   * device (see `isTouchDevice`) and obeys `?autoFullscreen=off`, so a player (or a QA run) can keep the page
   * in the tab without losing the button.
   */
  autoEnter: () => Promise<void>;
  exit: () => Promise<void>;
  /**
   * The user-facing toggle (FullscreenButton). Exiting through THIS is what marks the exit deliberate, which
   * disarms the re-entry rearm below — anything else and we would drag the player back into fullscreen on
   * their very next tap.
   */
  toggle: () => Promise<void>;
}

// ---- shared, document-global state --------------------------------------------------------------------------
//
// Fullscreen is a property of the DOCUMENT, and so are the two policies below — but `useFullscreen()` is called
// from several components at once (FullscreenButton mounts more than once: the mirror's in-stage top bar and
// its pre-join picker; MirrorApp calls it again for the
// seat-tap entry). Per-instance state was therefore not an option: the button instance would record "the player
// left on purpose" while every OTHER instance's `fullscreenchange` handler, knowing nothing about it, armed the
// re-entry and hauled them back in on the next tap. That is the exact "fighting the user" failure the plan calls
// out, so the flags, the listeners and the refs live here, once, with a scope refcount deciding when the DOM
// listeners come and go.

const isFullscreen = shallowRef(false);
const isOrientationLocked = shallowRef(false);

/** The player left fullscreen ON PURPOSE (our button, or Escape). Cleared every time we enter again. */
let userExited = false;
/** How many live effect scopes hold this composable; the DOM listeners exist only while it is > 0. */
let scopeCount = 0;
/** Last injected seams (real callers pass none; specs pass a fake orientation). Reset when the count hits 0. */
let seams: FullscreenSeams = {};
let pendingReentry: ((event: Event) => void) | null = null;

function resolveDocument(): Document | undefined {
  return globalThis.document as Document | undefined;
}

function resolveOrientation(): OrientationSeam | null {
  if (seams.orientation !== undefined) return seams.orientation;
  const orientation = (globalThis.screen as (Screen & { orientation?: OrientationSeam }) | undefined)
    ?.orientation;
  return orientation ?? null;
}

/**
 * Whether the AUTOMATIC paths (the seat-tap entry and the re-entry rearm) apply at all.
 *
 * They are a PHONE feature: a phone has browser chrome eating a third of a landscape screen and system gestures
 * that drop fullscreen behind the player's back. A desktop has neither — and there, silently swallowing the
 * whole screen because somebody picked a seat is exactly the kind of thing users file bugs about. Desktop keeps
 * the explicit FullscreenButton, which is unaffected by this and by every kill-switch here.
 *
 * `(pointer: coarse)` rather than a UA sniff because the question really is "is the primary input a finger".
 */
function isTouchDevice(): boolean {
  if (seams.coarsePointer !== undefined) return seams.coarsePointer;
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches
    );
  } catch {
    return false;
  }
}

function valveOff(name: string): boolean {
  try {
    const raw = seams.search ?? (typeof window === "undefined" ? "" : window.location.search);
    return new URLSearchParams(raw).get(name) === "off";
  } catch {
    return false;
  }
}

/**
 * Ask for landscape. `screen.orientation.lock()` is only permitted WHILE fullscreen (which is why this is
 * driven off `fullscreenchange` rather than off the seat tap), and only Chromium-family Android implements it —
 * where it also overrides the OS rotation lock, which is the entire reason it is worth asking for. A rejection
 * is a platform answering "no", not an error: iPhone Safari has no Fullscreen API to begin with, so this whole
 * path is inert there and WS3's portrait nag is the fallback.
 */
async function applyOrientationLock(): Promise<void> {
  if (valveOff("orientationLock")) return;
  const orientation = resolveOrientation();
  if (!orientation || typeof orientation.lock !== "function") return;
  try {
    await orientation.lock("landscape");
    isOrientationLocked.value = true;
  } catch {
    isOrientationLocked.value = false;
  }
}

/** Release the lock so the page rotates freely again the moment we are out of fullscreen. */
function releaseOrientationLock(): void {
  isOrientationLocked.value = false;
  const orientation = resolveOrientation();
  try {
    orientation?.unlock?.();
  } catch {
    // Not locked / not implemented — nothing to undo.
  }
}

async function requestFullscreen(): Promise<void> {
  const doc = resolveDocument();
  if (!doc) return;
  try {
    await doc.documentElement.requestFullscreen();
  } catch {
    // requestFullscreen rejects without a user gesture or when blocked by policy —
    // leave `isFullscreen` as the change listener last reported.
  }
  // Also lock here, not only from `fullscreenchange`: if the document was ALREADY fullscreen no change event
  // fires, and a caller that just asked for fullscreen still wants landscape. `lock()` is idempotent.
  await applyOrientationLock();
}

function disarmReentry(doc: Document): void {
  if (!pendingReentry) return;
  doc.removeEventListener("pointerdown", pendingReentry, true);
  pendingReentry = null;
}

/**
 * INVOLUNTARY exit (the Android system swipe-down, a notification, an orientation change that dropped it): put
 * the page back on the next tap, since that tap is the user activation `requestFullscreen()` demands and the
 * player has no other way to notice the browser chrome crept back. One shot, capture phase so it fires even
 * when the tap lands on a node that stops propagation, and never armed after a DELIBERATE exit.
 */
function armReentry(doc: Document): void {
  if (pendingReentry || valveOff("autoFullscreen") || !isTouchDevice()) return;
  const handler = (): void => {
    disarmReentry(doc);
    void requestFullscreen();
  };
  pendingReentry = handler;
  doc.addEventListener("pointerdown", handler, { capture: true, once: true });
}

function onFullscreenChange(): void {
  const doc = resolveDocument();
  if (!doc) return;
  const now = Boolean(doc.fullscreenElement);
  isFullscreen.value = now;
  if (now) {
    // A fresh entry clears the "they left on purpose" memory: whatever they meant last time, they are in now.
    userExited = false;
    disarmReentry(doc);
    void applyOrientationLock();
    return;
  }
  releaseOrientationLock();
  if (!userExited) {
    armReentry(doc);
  }
}

/**
 * Escape counts as DELIBERATE. Without this the desktop story is absurd: press Esc to leave fullscreen, click
 * anything, and the page slams back into it. Tracked as a flag rather than a timestamp because the flag is
 * cleared on every entry, so a stray Esc while windowed cannot leak into a later involuntary exit.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    userExited = true;
  }
}

// Browser-only fullscreen state + controls. Adapted from the common `useFullscreen`
// pattern, but without @vueuse/core — the frontend keeps its dependency set minimal
// (no @vueuse/core, so no `useEventListener`). The listeners are wired by hand and torn
// down via `onScopeDispose`, mirroring the dispose discipline in browserCursor.ts. Must
// be called from a component setup / effect scope so they are cleaned up with their owner.
export function useFullscreen(injected: FullscreenSeams = {}): FullscreenControls {
  const doc = resolveDocument();
  // `fullscreenEnabled` is false (not just absent) when policy forbids fullscreen
  // (e.g. a sandboxed iframe, and iPhone Safari, which has no element Fullscreen API at
  // all), so gate on its truthiness — the caller hides the control when unsupported.
  const isSupported = Boolean(doc && "fullscreenEnabled" in doc && doc.fullscreenEnabled);
  seams = injected;
  // Re-seed from the live state so we're correct if fullscreen was already active (and so a shared ref left
  // over from a previous scope can never report a stale answer).
  isFullscreen.value = Boolean(doc?.fullscreenElement);

  const enter = async (): Promise<void> => {
    if (!isSupported || !doc) return;
    await requestFullscreen();
  };

  const autoEnter = async (): Promise<void> => {
    if (valveOff("autoFullscreen") || !isTouchDevice()) return;
    await enter();
  };

  const exit = async (): Promise<void> => {
    if (!isSupported || !doc) return;
    try {
      await doc.exitFullscreen();
    } catch {
      // exitFullscreen rejects when we're not actually in fullscreen; ignore.
    }
  };

  const toggle = async (): Promise<void> => {
    if (isFullscreen.value) {
      // Mark BEFORE the await: `exitFullscreen()` resolves after `fullscreenchange` has already run, so a flag
      // set afterwards would arrive too late to stop the rearm.
      userExited = true;
      if (doc) disarmReentry(doc);
      await exit();
    } else {
      await enter();
    }
  };

  if (doc) {
    scopeCount += 1;
    if (scopeCount === 1) {
      doc.addEventListener("fullscreenchange", onFullscreenChange);
      doc.addEventListener("keydown", onKeyDown, true);
    }
    onScopeDispose(() => {
      scopeCount -= 1;
      if (scopeCount > 0) return;
      doc.removeEventListener("fullscreenchange", onFullscreenChange);
      doc.removeEventListener("keydown", onKeyDown, true);
      disarmReentry(doc);
      seams = {};
      userExited = false;
    });
  }

  return { isFullscreen, isSupported, isOrientationLocked, enter, autoEnter, exit, toggle };
}
