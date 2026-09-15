import type { MirrorClientStatus } from "@/mirror/mirrorClient";
import type { ReconnectPhase } from "@/mirror/reconnectPolicy";
import type { BrowserJoinProgress, JoinProgressStage } from "@/protocol/browserEnvelope";

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

// ---- the join's SECOND line -----------------------------------------------------------------------------------
//
// "Joining…" above is one word and cannot change for 20-60 seconds, because that is genuinely how long a cold
// seat spawn takes. The measured consequence (2026-09-15): a healthy join and a dead one showed the byte-identical
// screen, so players closed the tab well before either resolved and reported "it hangs". The host has always known
// which step it is on and for how long — `join-progress` carries it, and this turns it into a sentence.
//
// The heading is untouched: the transient word stays exactly what it was, and this sits under it.

/** The message key each host stage renders as. `failed` is absent on purpose — see `mirrorJoinProgressLine`. */
export const MIRROR_JOIN_PROGRESS_KEYS = {
  connecting: "join.progress.connecting",
  choosing: "join.progress.choosing",
  initializing: "join.progress.initializing",
  joining: "join.progress.joining",
  "loading-view": "join.progress.loadingView",
  complete: "join.progress.complete"
} as const satisfies Partial<Record<JoinProgressStage, string>>;

export type MirrorJoinProgressKey =
  | (typeof MIRROR_JOIN_PROGRESS_KEYS)[keyof typeof MIRROR_JOIN_PROGRESS_KEYS]
  | "join.progress.line";

/**
 * The progress line to render under the join heading, or null when there is nothing honest to say.
 *
 * Null for `failed` (and for a null progress): the attempt is over, the terminal reply owns the screen within
 * milliseconds, and a stage word there would be a worse answer than the rejection about to replace it. Everything
 * else renders what is happening, how far along it is, how long it has been going — and that this can legitimately
 * take up to a minute, which is the sentence that stops a player from closing the tab on a join that is working.
 *
 * Elapsed is whatever the host last said, floored to whole seconds. The client deliberately runs no timer of its
 * own: a counter that keeps climbing after the host has gone quiet is exactly the reassuring lie this replaced.
 */
export function mirrorJoinProgressLine(
  progress: BrowserJoinProgress | null,
  translate: (key: MirrorJoinProgressKey, values?: Record<string, string | number>) => string
): string | null {
  if (!progress) {
    return null;
  }
  const stageKey = MIRROR_JOIN_PROGRESS_KEYS[progress.stage as keyof typeof MIRROR_JOIN_PROGRESS_KEYS];
  if (!stageKey) {
    return null;
  }
  return translate("join.progress.line", {
    stage: translate(stageKey),
    step: progress.step,
    total: progress.stepTotal,
    seconds: Math.max(0, Math.floor(progress.elapsedMs / 1000))
  });
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
