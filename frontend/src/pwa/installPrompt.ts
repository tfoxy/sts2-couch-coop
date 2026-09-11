import { shallowRef, type ShallowRef } from "vue";

/**
 * Android install affordance.
 *
 * Chrome fires `beforeinstallprompt` when the page is installable and — unless you call
 * `preventDefault()` — decides for itself whether and where to surface anything (these days: usually a
 * near-invisible item buried in the ⋮ menu). Capturing the event and offering our own button is the only
 * way to make "install this" discoverable to a player who has just scanned a QR code on their TV.
 *
 * NOT AN iOS PATH. `beforeinstallprompt` does not exist on iOS in any browser (they are all WebKit), so
 * this can never fire there — but the platform check below is explicit anyway, because iPhone install is
 * a sibling workstream's Add-to-Home-Screen overlay and two overlapping install prompts would be worse
 * than none. If WebKit ever ships the event, this stays quiet until someone reconciles the two.
 *
 * Only meaningful on a secure origin (Chrome requires HTTPS + a manifest + a service worker to consider
 * a page installable), so on the mod's default plain-HTTP LAN URL the event never fires and this is
 * inert. No secure-context branch needed.
 */

/** The bits of `BeforeInstallPromptEvent` we use; it isn't in lib.dom. */
export interface BeforeInstallPromptEventLike {
  preventDefault(): void;
  prompt(): Promise<unknown>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface ListenerTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}

export interface InstallPromptEnv {
  window: ListenerTarget;
  userAgent: string | null | undefined;
  /** `navigator.maxTouchPoints` — the only way to tell an iPad from a Mac since iPadOS 13. */
  maxTouchPoints?: number;
  /** `navigator.standalone` (iOS-only signal, kept for symmetry with the display-mode query). */
  navigatorStandalone?: boolean;
  matchMedia?: (query: string) => MediaQueryListLike;
  /** `localStorage`, for the "they said no, stop asking" backoff. Optional/injectable. */
  storage?: Pick<Storage, "getItem" | "setItem">;
  now?: () => number;
}

export interface InstallPromptController {
  /** Whether to render the Install affordance right now. */
  visible: ShallowRef<boolean>;
  /** Fire the captured prompt. Resolves to the outcome, or "unavailable" when there is nothing to fire. */
  promptInstall: () => Promise<"accepted" | "dismissed" | "unavailable">;
  dispose: () => void;
}

const DISMISS_KEY = "couchcoop.installPrompt.snoozedUntil";
/**
 * How long a declined install suppresses the button. Long enough not to nag across a play session or the
 * next evening's game night, short enough that someone who changes their mind can find it again.
 */
const DISMISS_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * iPhone/iPad, including iPadOS 13+ which reports a desktop "Macintosh" UA and is only distinguishable
 * by having touch points. Deliberately a local copy rather than an import from `join/joinModel.ts`:
 * that file belongs to another workstream, and a two-line UA test is cheaper to duplicate than a
 * cross-workstream coupling is to maintain.
 */
export function isIosPlatform(userAgent: string | null | undefined, maxTouchPoints = 0): boolean {
  if (typeof userAgent !== "string") return false;
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return userAgent.includes("Macintosh") && maxTouchPoints > 1;
}

/**
 * Already running as an installed app?
 *
 * Checks `fullscreen` and `minimal-ui` as well as `standalone`, which matters here specifically: the
 * manifest declares `"display": "fullscreen"` (public/manifest.webmanifest), so an installed Android
 * PWA of THIS app reports `display-mode: fullscreen` and a standalone-only check would keep offering
 * "Install" to someone who already installed it.
 */
export function isRunningInstalled(env: Pick<InstallPromptEnv, "matchMedia" | "navigatorStandalone">): boolean {
  if (env.navigatorStandalone === true) return true;
  const matchMedia = env.matchMedia;
  if (!matchMedia) return false;
  for (const mode of ["standalone", "fullscreen", "minimal-ui"]) {
    try {
      if (matchMedia(`(display-mode: ${mode})`).matches) return true;
    } catch {
      // A UA without display-mode support just isn't installed.
    }
  }
  return false;
}

function readSnoozedUntil(env: InstallPromptEnv): number {
  try {
    const raw = env.storage?.getItem(DISMISS_KEY);
    const parsed = raw === null || raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    // Private mode / disabled storage: treat as "never snoozed".
    return 0;
  }
}

/** Whether the button may be shown at all, ignoring whether Chrome has offered us an event yet. */
export function isInstallOfferAllowed(env: InstallPromptEnv): boolean {
  if (isIosPlatform(env.userAgent, env.maxTouchPoints ?? 0)) return false;
  if (isRunningInstalled(env)) return false;
  const now = env.now ? env.now() : Date.now();
  return readSnoozedUntil(env) <= now;
}

export function createInstallPromptController(env: InstallPromptEnv): InstallPromptController {
  const visible = shallowRef(false);
  let captured: BeforeInstallPromptEventLike | null = null;
  let disposed = false;

  const onBeforeInstallPrompt = (event: unknown): void => {
    if (disposed) return;
    const candidate = event as BeforeInstallPromptEventLike;
    if (typeof candidate?.prompt !== "function") return;
    // Suppress Chrome's own (nearly invisible) affordance and take ownership of the moment.
    candidate.preventDefault?.();
    captured = candidate;
    visible.value = isInstallOfferAllowed(env);
  };

  const onAppInstalled = (): void => {
    captured = null;
    visible.value = false;
  };

  const onDisplayModeChange = (): void => {
    if (isRunningInstalled(env)) {
      captured = null;
      visible.value = false;
    }
  };

  env.window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  env.window.addEventListener("appinstalled", onAppInstalled);

  // Catches the case where the player installs from the browser's own menu while our button is up: the
  // page keeps running and flips into standalone/fullscreen display mode without a reload.
  const displayModeQueries: MediaQueryListLike[] = [];
  if (env.matchMedia) {
    for (const mode of ["standalone", "fullscreen", "minimal-ui"]) {
      try {
        const query = env.matchMedia(`(display-mode: ${mode})`);
        query.addEventListener?.("change", onDisplayModeChange);
        displayModeQueries.push(query);
      } catch {
        // Not all UAs expose display-mode queries; the `appinstalled` event still covers the common path.
      }
    }
  }

  const promptInstall = async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    const event = captured;
    // A BeforeInstallPromptEvent is single-use: drop it before awaiting so a double tap can't call
    // prompt() twice (which throws) and so the button can't linger on a spent event.
    captured = null;
    visible.value = false;
    if (!event) return "unavailable";

    try {
      await event.prompt();
      const choice = await event.userChoice;
      const outcome = choice?.outcome === "accepted" ? "accepted" : "dismissed";
      if (outcome === "dismissed") {
        const now = env.now ? env.now() : Date.now();
        try {
          env.storage?.setItem(DISMISS_KEY, String(now + DISMISS_SNOOZE_MS));
        } catch {
          // Storage unavailable: worst case we offer again next load. Not worth failing over.
        }
      }
      return outcome;
    } catch {
      // prompt() rejects when called without user activation or twice. Stay hidden; Chrome re-fires
      // `beforeinstallprompt` on a later navigation if the page is still installable.
      return "unavailable";
    }
  };

  return {
    visible,
    promptInstall,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      env.window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      env.window.removeEventListener("appinstalled", onAppInstalled);
      for (const query of displayModeQueries) query.removeEventListener?.("change", onDisplayModeChange);
      captured = null;
      visible.value = false;
    }
  };
}

/** Real-browser env for the component. */
export function browserInstallPromptEnv(): InstallPromptEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    window: window as unknown as ListenerTarget,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
    navigatorStandalone: nav.standalone,
    matchMedia: typeof window.matchMedia === "function" ? (query) => window.matchMedia(query) : undefined,
    storage: safeLocalStorage()
  };
}

function safeLocalStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return window.localStorage;
  } catch {
    // Access itself throws under some privacy settings.
    return undefined;
  }
}
