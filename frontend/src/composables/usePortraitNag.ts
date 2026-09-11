import { onScopeDispose, shallowRef, watch, type ShallowRef } from "vue";

import { usePortraitViewport, type ViewportMediaQuerySeam } from "@/composables/usePortraitViewport";

// WS3 — PORTRAIT NAG.
//
// The game is landscape. A phone held (or LOCKED) in portrait letterboxes the mirror into a useless strip, and
// the user report for that failure is "the mod is broken" — the player has no way to know the cause is their own
// Rotation Lock. No API exposes rotation-lock state, so we INFER it: still portrait N seconds after the game view
// came up means the player either has not turned the phone or cannot. Both are answered by the same overlay; the
// platform-specific "your rotation lock is on" line is held back a further few seconds so the common case (just
// turn the phone) is not buried under instructions nobody needs.
//
// This never fires when WS2's `screen.orientation.lock("landscape")` was granted — the browser is holding the
// phone landscape for us there, so a nag would be both wrong and unactionable.

/** How long the game view may sit in portrait before we say anything. */
export const PORTRAIT_NAG_DELAY_MS = 2500;

/** …and how long AFTER that before we add the platform-specific rotation-lock line. */
export const PORTRAIT_NAG_HINT_DELAY_MS = 4000;

export const PORTRAIT_NAG_TITLE = "Turn your phone sideways";

export const PORTRAIT_NAG_IOS_HINT =
  "Rotation locked? Swipe down from the top-right and tap the lock icon.";
export const PORTRAIT_NAG_ANDROID_HINT =
  "Auto-rotate is off — turn it on in Quick Settings.";
export const PORTRAIT_NAG_GENERIC_HINT =
  "If the screen won't rotate, check your device's rotation lock.";

// R19 WP-2 — the hints when the overlay ALSO offers "Go fullscreen". Entering fullscreen is what asks for the
// landscape lock (the lock hangs off `fullscreenchange`, not off the caller — see useFullscreen), so on a device
// that has the button the first thing to say is "press this", not "go hunting in Quick Settings". The platform
// rotation-lock advice above is still the honest fallback for the devices with no button (iPhone Safari, an
// installed PWA) and for a player whose lock request the platform refuses.
export const PORTRAIT_NAG_IOS_FULLSCREEN_HINT =
  "Go fullscreen to rotate — or, if the screen still won't turn, swipe down from the top-right and tap the lock icon.";
export const PORTRAIT_NAG_ANDROID_FULLSCREEN_HINT =
  "Go fullscreen to rotate — or turn Auto-rotate back on in Quick Settings.";
export const PORTRAIT_NAG_GENERIC_FULLSCREEN_HINT =
  "Go fullscreen to rotate — or check your device's rotation lock.";

/**
 * The platform line. UA-based and injectable, like the other device hints in joinModel: the two gestures are
 * genuinely different and naming the wrong one is worse than the generic sentence a desktop/unknown UA gets.
 */
export function portraitRotationHint(
  userAgent: string | null | undefined,
  // R19 WP-2: whether the overlay is showing its own "Go fullscreen" button. When it is, the advice leads with
  // the button that is on screen; the rotation-lock gesture stays as the "still stuck?" tail.
  withFullscreen = false
): string {
  if (typeof userAgent !== "string") {
    return withFullscreen ? PORTRAIT_NAG_GENERIC_FULLSCREEN_HINT : PORTRAIT_NAG_GENERIC_HINT;
  }
  if (/iPad|iPhone|iPod/.test(userAgent)) {
    return withFullscreen ? PORTRAIT_NAG_IOS_FULLSCREEN_HINT : PORTRAIT_NAG_IOS_HINT;
  }
  if (/Android/i.test(userAgent)) {
    return withFullscreen ? PORTRAIT_NAG_ANDROID_FULLSCREEN_HINT : PORTRAIT_NAG_ANDROID_HINT;
  }
  return withFullscreen ? PORTRAIT_NAG_GENERIC_FULLSCREEN_HINT : PORTRAIT_NAG_GENERIC_HINT;
}

export interface PortraitNagInput {
  /** The game view is up (a nag over the join picker would be noise — the picker reads fine in portrait). */
  active: boolean;
  /** WS2 got a landscape lock, so portrait is not a state the player can be stuck in. */
  suppressed: boolean;
  /** `matchMedia("(orientation: portrait)").matches`. */
  portrait: boolean;
  /** The player pressed "Got it" — never nag again this session. */
  dismissed: boolean;
  /** Milliseconds the game view has been continuously up AND portrait. */
  elapsedMs: number;
}

export interface PortraitNagState {
  visible: boolean;
  /** Whether the platform-specific rotation-lock line has earned its place yet. */
  showHint: boolean;
}

/**
 * The whole decision, pure. Every input is a fact the composable observes, so the timing rules can be tested
 * without timers, a viewport or a component.
 */
export function portraitNagState(input: PortraitNagInput): PortraitNagState {
  if (!input.active || input.suppressed || input.dismissed || !input.portrait) {
    return { visible: false, showHint: false };
  }
  if (input.elapsedMs < PORTRAIT_NAG_DELAY_MS) {
    return { visible: false, showHint: false };
  }
  return {
    visible: true,
    showHint: input.elapsedMs >= PORTRAIT_NAG_DELAY_MS + PORTRAIT_NAG_HINT_DELAY_MS
  };
}

/**
 * The `MediaQueryList` slice used here — injectable, because jsdom's never changes. Re-exported alias of the
 * shared viewport seam: the nag no longer owns a query of its own (see {@link usePortraitViewport}).
 */
export type MediaQuerySeam = ViewportMediaQuerySeam;

export interface PortraitNagSeams {
  matchMedia?: ((query: string) => MediaQuerySeam) | null;
  userAgent?: string | null;
}

export interface PortraitNag {
  visible: ShallowRef<boolean>;
  showHint: ShallowRef<boolean>;
  /**
   * The UA the platform hint is resolved from. Exposed rather than a pre-baked string because the copy now also
   * depends on whether the OVERLAY is offering its own "Go fullscreen" button — a fact only the component knows
   * (it is the FullscreenButton gate: supported, and not already standalone).
   */
  userAgent: string | null;
  /** "Got it" — the always-available way past the overlay (nothing we show may trap a player). */
  dismiss: () => void;
}

/**
 * Drive {@link portraitNagState} off two timers and the SHARED portrait signal. Two timeouts rather than a
 * polling interval: the nag has exactly two moments, and a phone under load should not be paying for a ticker
 * to discover them.
 *
 * R19 WP-2: the orientation media query moved to `usePortraitViewport`, so the nag and the portrait chrome
 * placement read ONE definition of portrait. Behaviour here is unchanged — the query string is the same set of
 * viewports, the flip still restarts the clock from zero, and the listener is still attached exactly once and
 * dropped on scope dispose (the shared module's refcount owns it now).
 */
export function usePortraitNag(
  active: () => boolean,
  suppressed: () => boolean,
  seams: PortraitNagSeams = {}
): PortraitNag {
  const visible = shallowRef(false);
  const showHint = shallowRef(false);
  let dismissed = false;

  const { isPortrait } = usePortraitViewport(
    seams.matchMedia !== undefined ? { matchMedia: seams.matchMedia } : {}
  );

  const userAgent =
    seams.userAgent !== undefined
      ? seams.userAgent
      : typeof navigator === "undefined"
        ? null
        : navigator.userAgent;

  let nagTimer: ReturnType<typeof setTimeout> | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (nagTimer !== null) clearTimeout(nagTimer);
    if (hintTimer !== null) clearTimeout(hintTimer);
    nagTimer = null;
    hintTimer = null;
  };

  // `elapsedMs` is expressed by WHICH timers have fired, so the pure function is evaluated at the two moments
  // that can change its answer plus every time an input flips.
  const evaluate = (elapsedMs: number): void => {
    const next = portraitNagState({
      active: active(),
      suppressed: suppressed(),
      portrait: isPortrait.value,
      dismissed,
      elapsedMs
    });
    visible.value = next.visible;
    showHint.value = next.showHint;
  };

  const restart = (): void => {
    clearTimers();
    evaluate(0);
    const eligible = active() && !suppressed() && !dismissed && isPortrait.value;
    if (!eligible) return;
    nagTimer = setTimeout(() => {
      nagTimer = null;
      evaluate(PORTRAIT_NAG_DELAY_MS);
      hintTimer = setTimeout(() => {
        hintTimer = null;
        evaluate(PORTRAIT_NAG_DELAY_MS + PORTRAIT_NAG_HINT_DELAY_MS);
      }, PORTRAIT_NAG_HINT_DELAY_MS);
    }, PORTRAIT_NAG_DELAY_MS);
  };

  // The orientation flip is the auto-dismiss: turning the phone is the thing we asked for, so the overlay must
  // be gone before the player has finished the movement. Turning it BACK re-arms the timer from zero. It rides
  // the same watch as the other two inputs now that portrait is a ref rather than a query this module owns —
  // which is also what makes "fullscreen was granted, the lock fired, the phone rotated" dismiss the nag with no
  // extra wiring: the rotation IS the media-query flip.
  watch([active, suppressed, isPortrait], () => restart(), { immediate: true });

  onScopeDispose(() => {
    clearTimers();
  });

  return {
    visible,
    showHint,
    userAgent,
    dismiss(): void {
      dismissed = true;
      restart();
    }
  };
}

// ---- kill switch ----------------------------------------------------------------------------------------------

// `?nagFullscreen=off` restores the pre-R19 overlay BYTE-IDENTICALLY: "Got it" alone, and the plain rotation-lock
// hints. Read once per session and cached, like every other web valve here (see inputCapture.ts).
function readNagFullscreen(): boolean {
  return true;
}

let nagFullscreen = readNagFullscreen();

/** Whether the nag may offer its own "Go fullscreen" button (default ON; `?nagFullscreen=off` disables it). */
export function isNagFullscreenEnabled(): boolean {
  return nagFullscreen;
}

export function __setNagFullscreenForTest(enabled: boolean): void {
  nagFullscreen = enabled;
}
