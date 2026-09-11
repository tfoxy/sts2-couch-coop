import type { MirrorClientStatus } from "@/mirror/mirrorClient";
import type { ReconnectPhase } from "@/mirror/reconnectPolicy";

// The mirror's PRE-GAME lifecycle states, as one pure function so the copy and the precedence live in one place
// instead of being re-derived inside the picker's title expression.
//
// WHY IT EXISTS: every one of these states used to be invisible. The join screen titled itself
// `screenTitle || placeholder`, so a stale screen name ("Run") — remembered from the last session envelope —
// outranked every lifecycle placeholder; the viewer stared at "Run" for the 20-60s a cold headless spawn takes
// with no sign anything was happening, and a drop swapped it for the long "the host must reload the saved run"
// guidance even when the socket came back a second later.
//
// The states are deliberately 1-2 words, matching the native client's status banner (UiRoot.UpdateBanner:
// "Reconnecting…" / "Disconnected"), and each is TRANSIENT: something is in flight and the screen is expected to
// change on its own. Steady states (a picker to tap, a title to read) are NOT in here — they keep the screen
// title and their own steady chrome (the Android APK hint).

export type MirrorLoadingState =
  /** The FIRST connection to the host is still opening. */
  | "connecting"
  /** A drop is being retried (see reconnectPolicy) and we have no socket yet. */
  | "reconnecting"
  /** A join is in flight. May be a COLD headless spawn, which the host awaits inline for 20-60s. */
  | "joining"
  /** Joined / direct-view granted, but the first scene frame hasn't arrived (or rendered) yet. */
  | "loading";

/** The words each transient state puts on the join screen. */
export const MIRROR_LOADING_KEYS: Record<MirrorLoadingState, "loading.connecting" | "loading.reconnecting" | "loading.joining" | "loading.loading"> = {
  connecting: "loading.connecting",
  reconnecting: "loading.reconnecting",
  joining: "loading.joining",
  loading: "loading.loading"
};

export interface MirrorLoadingInputs {
  /** The ACTIVE mirror client's socket status. */
  status: MirrorClientStatus;
  /** The app-level drop phase (reconnectPolicy). */
  reconnectPhase: ReconnectPhase;
  /** The in-flight join target, or null. */
  pendingName: string | null;
  /** This device has been granted a view: `joined` (own headless) or `directView` (host's own stream). */
  hasView: boolean;
  /** The live scene is actually on screen (frames arrived AND the stream gate allows rendering them). */
  sceneShowing: boolean;
}

/**
 * The transient state to show, or null when the screen is STEADY (a picker to tap / a real screen title).
 *
 * Precedence, most specific first:
 *  1. a join in flight — "Joining…" beats "Reconnecting…" because it is the same wait with progress: an
 *     auto-rejoin fired after a drop, so naming the more advanced step is the honest report;
 *  2. a drop with no socket — "Reconnecting…". Once the socket is BACK the phase stops driving the title even
 *     if still escalated: the viewer has a roster to tap again, and the escalated notice (reconnectNotice)
 *     carries the explanation instead;
 *  3. a granted view with no frames yet — "Loading…" (this covers the post-redirect gap, where the new socket
 *     is technically "connecting");
 *  4. the very first connect — "Connecting…".
 */
export function computeMirrorLoadingState(inputs: MirrorLoadingInputs): MirrorLoadingState | null {
  if (inputs.pendingName) {
    return "joining";
  }
  if (inputs.reconnectPhase !== "steady" && inputs.status !== "connected") {
    return "reconnecting";
  }
  if (inputs.hasView && !inputs.sceneShowing) {
    return "loading";
  }
  if (inputs.status === "connecting") {
    return "connecting";
  }
  return null;
}

/** The label for a transient state, or null when steady (the caller falls back to its own steady placeholder). */
export function mirrorLoadingLabel(
  state: MirrorLoadingState | null,
  translate: (key: "loading.connecting" | "loading.reconnecting" | "loading.joining" | "loading.loading") => string = (key) => ({
    "loading.connecting": "Connecting…",
    "loading.reconnecting": "Reconnecting…",
    "loading.joining": "Joining…",
    "loading.loading": "Loading…"
  })[key]
): string | null {
  return state ? translate(MIRROR_LOADING_KEYS[state]) : null;
}
