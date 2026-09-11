/**
 * Screen Wake Lock.
 *
 * We call `navigator.wakeLock` nowhere today, which is why a phone dims and sleeps mid-combat while the
 * player is watching a co-op turn they aren't driving — there is no touch input to keep the display
 * timer alive, and the mirror is a pure spectator surface for most of a run.
 *
 * Scope decision: acquire whenever the document is VISIBLE, not "when the game view is mounted". The
 * join picker is momentary and holding the lock through it is harmless, whereas plumbing view state in
 * here would couple this to MirrorApp (the shell and the client are deliberately independent) for no
 * user-visible gain.
 *
 * Availability gate, not a secure-context gate: `navigator.wakeLock` is simply undefined on an insecure
 * origin, so the plain-HTTP LAN URL takes the no-op path with no extra branch. Everything is structural
 * and injected so the whole state machine is testable without a browser.
 */

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}

export interface WakeLockApiLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

interface ListenerTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface WakeLockEnv {
  /** `navigator.wakeLock`, or undefined where unsupported (every insecure origin, Safari < 16.4, …). */
  wakeLock: WakeLockApiLike | undefined;
  /** `document` — visibility plus the visibilitychange/gesture listeners. */
  document: ListenerTarget & { readonly visibilityState: string };
  /** `window` — for `pagehide`. Optional so a test can leave it out. */
  window?: ListenerTarget;
}

declare global {
  interface Window {
    /**
     * QA seam, set by main.ts. Declared here rather than in the shared `env.d.ts` so this workstream
     * stays contained to its own directory.
     */
    __couchCoopWakeLock?: ScreenWakeLockHandle;
  }
}

export interface ScreenWakeLockHandle {
  /** False when the API is missing; the handle is then entirely inert. */
  readonly isSupported: boolean;
  /** Whether a live sentinel is currently held (test/diagnostic seam). */
  isHeld(): boolean;
  /** Best-effort acquire; safe to call repeatedly. */
  acquire(): Promise<void>;
  /** Release and stop listening. Idempotent. */
  dispose(): void;
}

const INERT: ScreenWakeLockHandle = {
  isSupported: false,
  isHeld: () => false,
  acquire: async () => {},
  dispose: () => {}
};

export function installScreenWakeLock(env: WakeLockEnv): ScreenWakeLockHandle {
  const api = env.wakeLock;
  if (!api) return INERT;

  let sentinel: WakeLockSentinelLike | null = null;
  let pending: Promise<void> | null = null;
  let disposed = false;
  let gestureArmed = false;

  const onSentinelRelease = (): void => {
    // Fired by the UA whenever it drops the lock — page hidden, tab backgrounded, battery saver. Clear
    // our reference so the next acquire() attempt isn't short-circuited by a dead sentinel.
    sentinel = null;
  };

  const detachSentinel = (): void => {
    sentinel?.removeEventListener("release", onSentinelRelease);
  };

  const acquire = async (): Promise<void> => {
    if (disposed) return;
    if (sentinel && !sentinel.released) return;
    // A request from a hidden document rejects with NotAllowedError by spec; don't spend the round trip.
    if (env.document.visibilityState !== "visible") return;
    if (pending) return pending;

    pending = (async () => {
      try {
        const next = await api.request("screen");
        if (disposed) {
          await next.release().catch(() => {});
          return;
        }
        sentinel = next;
        next.addEventListener("release", onSentinelRelease);
      } catch {
        // NotAllowedError is the common one: low battery, or a UA that wants a user gesture first.
        // Arm a ONE-SHOT retry on the next interaction rather than retrying on a timer — a poll would
        // burn wakeups on exactly the device we're trying to be gentle with, and the player is about to
        // tap something anyway.
        armGestureRetry();
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

  const onGesture = (): void => {
    gestureArmed = false;
    env.document.removeEventListener("pointerdown", onGesture);
    env.document.removeEventListener("keydown", onGesture);
    void acquire();
  };

  function armGestureRetry(): void {
    if (disposed || gestureArmed) return;
    gestureArmed = true;
    env.document.addEventListener("pointerdown", onGesture);
    env.document.addEventListener("keydown", onGesture);
  }

  const onVisibilityChange = (): void => {
    if (env.document.visibilityState === "visible") {
      void acquire();
      return;
    }
    // Hiding auto-releases the lock; drop the stale reference so returning re-acquires cleanly.
    detachSentinel();
    sentinel = null;
  };

  const releaseNow = (): void => {
    detachSentinel();
    const held = sentinel;
    sentinel = null;
    void held?.release().catch(() => {});
  };

  const onPageHide = (): void => {
    releaseNow();
  };

  env.document.addEventListener("visibilitychange", onVisibilityChange);
  // `pagehide` rather than `beforeunload`: beforeunload is ignored/penalised on mobile and disqualifies
  // the page from the back/forward cache, which would make every navigation back into the app a cold
  // start. The UA releases the lock on unload anyway — this is just tidiness for bfcache restores.
  env.window?.addEventListener("pagehide", onPageHide);

  void acquire();

  return {
    isSupported: true,
    isHeld: () => Boolean(sentinel && !sentinel.released),
    acquire,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      env.document.removeEventListener("visibilitychange", onVisibilityChange);
      env.window?.removeEventListener("pagehide", onPageHide);
      if (gestureArmed) {
        gestureArmed = false;
        env.document.removeEventListener("pointerdown", onGesture);
        env.document.removeEventListener("keydown", onGesture);
      }
      releaseNow();
    }
  };
}

/** Wire the real browser. Fire-and-forget from main.ts; unsupported environments get the inert handle. */
export function installScreenWakeLockFromGlobals(): ScreenWakeLockHandle {
  if (typeof document === "undefined") return INERT;
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { wakeLock?: WakeLockApiLike });
  return installScreenWakeLock({
    wakeLock: nav?.wakeLock,
    document,
    window: typeof window === "undefined" ? undefined : window
  });
}
