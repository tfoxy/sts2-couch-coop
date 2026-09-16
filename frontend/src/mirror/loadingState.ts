import type { MirrorClientStatus } from "@/mirror/mirrorClient";
import type { ReconnectPhase } from "@/mirror/reconnectPolicy";
import type {
  BrowserJoinProgress,
  BrowserSeatNotice,
  JoinProgressStage,
  SeatNoticeCause
} from "@/protocol/browserEnvelope";

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

// ---- the SEAT NOTICE ------------------------------------------------------------------------------------------
//
// The host's own named verdict about this viewer's seat, in words a player can act on. It is not the join's
// progress line above: that says a healthy wait is still healthy, this says which of several unrelated things has
// gone wrong — and it can arrive long after the join SUCCEEDED, because the failure it exists for is a viewer who
// was redirected to a seat port their device cannot open and left on "Loading…" for ever.
//
// Each cause is one sentence naming what is true and one naming what to try, in the same pair the host's own
// connection panel shows (couchcoop_connection_error_seat_* in the native catalogs). The meaning is deliberately
// the same on both surfaces so a player and whoever is hosting for them are never reading two diagnoses; the
// VOICE is not, because "this player's game" on the panel is "your game" here, and "this computer" is the host's.

/** The `[what is true, what to try]` message keys each announced cause renders as. `none` withdraws — see below. */
export const MIRROR_SEAT_NOTICE_KEYS = {
  "port-conflict": ["seat.notice.portConflict", "seat.notice.portConflictFix"],
  "host-local-block": ["seat.notice.hostBlock", "seat.notice.hostBlockFix"],
  "network-path": ["seat.notice.networkPath", "seat.notice.networkPathFix"]
} as const satisfies Partial<Record<SeatNoticeCause, readonly [string, string]>>;

export type MirrorSeatNoticeKey = (typeof MIRROR_SEAT_NOTICE_KEYS)[keyof typeof MIRROR_SEAT_NOTICE_KEYS][number];

// ---- the same verdict, arriving as a REJECTION -----------------------------------------------------------------
//
// The notice above rides the `seat-notice` channel, which only exists because the join SUCCEEDED and the seat then
// turned out to be unreachable. The identical three causes can also end a join outright — a pinned rejoin onto a
// port another program owns fails in well under a second — and that path answers on the `joinRejection` channel
// instead, where every code used to collapse into "spawn-failed": *"Couldn't start your game view — please try
// again"*. That is an invitation to retry the one thing a retry cannot fix, and the sentence the player needed
// ("Nothing to change on this device — ask whoever is hosting to restart Slay the Spire 2") already existed,
// translated, in all 14 catalogs — reachable only down the other path.
//
// So the host now forwards the verdict's own issue code and this maps it back onto the cause, which renders
// through the seat-notice surface above. Same words, same markup, same catalogs; no new strings, and one
// vocabulary for a player and whoever is hosting for them.

/** The host issue code each seat-notice cause is announced under on the `joinRejection` channel. */
export const MIRROR_REJECTION_SEAT_CAUSES = {
  "seat-port-taken": "port-conflict",
  "seat-port-blocked": "host-local-block",
  "seat-network-path": "network-path"
} as const satisfies Record<string, SeatNoticeCause>;

/**
 * The seat notice a `joinRejection` carries, or null when the code is not one of the three named causes.
 *
 * Null is the signal to fall back to `JOIN_REJECTION_MESSAGES` exactly as before: every other code — including a
 * cause a future host names and this build has no copy for — keeps the behaviour it has today, for the same reason
 * `mirrorSeatNoticeCopy` refuses an unknown cause rather than guessing which of several unrelated fixes to send a
 * player to.
 */
export function seatNoticeForRejection(code: string, detail: string | null): BrowserSeatNotice | null {
  const cause = MIRROR_REJECTION_SEAT_CAUSES[code as keyof typeof MIRROR_REJECTION_SEAT_CAUSES];
  return cause ? { cause, detail } : null;
}

export interface MirrorSeatNoticeCopy {
  /** What is true, localized. */
  summary: string;
  /** What to try about it, localized. */
  action: string;
  /**
   * The host's own English technical line, verbatim, or null. Shown quietly under the two sentences above: it is
   * what a player pastes into a support thread, and it is the same text the host's panel shows and its copyable
   * report quotes — which is what stops the two surfaces from describing one seat two different ways.
   */
  detail: string | null;
}

/**
 * The seat notice to render, or null when there is nothing to show.
 *
 * Null for a null notice and for the `none` cause, which is the host WITHDRAWING one: the condition stopped being
 * true (the device finally got through, a browser attached, the port was freed), and a message that stays up once
 * it has stopped being true is worse than no message. Null for an unrecognised cause too — a build with no copy
 * for a future cause would be guessing at which of several unrelated fixes to send a player to, and silence is
 * the honest answer there.
 */
export function mirrorSeatNoticeCopy(
  notice: BrowserSeatNotice | null,
  translate: (key: MirrorSeatNoticeKey) => string
): MirrorSeatNoticeCopy | null {
  if (!notice) {
    return null;
  }
  const keys = MIRROR_SEAT_NOTICE_KEYS[notice.cause as keyof typeof MIRROR_SEAT_NOTICE_KEYS];
  if (!keys) {
    return null;
  }
  return { summary: translate(keys[0]), action: translate(keys[1]), detail: notice.detail };
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
