import type { BrowserPlayerOption } from "@/protocol/browserEnvelope";

// The mirror's DROP → RECONNECT → REJOIN policy, as pure functions so the rules are testable without a socket,
// a component or a timer. `MirrorApp.vue` owns the effects (timers, client construction); this module owns the
// decisions.
//
// WHY IT EXISTS: a viewer's game view is served by a HEADLESS instance on its own port, but that instance is
// disposable — it exits the moment its connection to the host game is permanently gone (the host process died, or
// the run dropped it). Before this, the browser simply sat on the last frame it had received forever. The rule
// now matches the native client (ConnectionCoordinator): fall back to the ORIGINAL host address, reconnect with
// exponential backoff, and re-run the join dance — which means the seat comes back on its own once the host
// reloads the saved run, with no tapping required.

/** First retry delay after a drop (native twin: `_reconnectDelaySec = 1`). */
export const RECONNECT_BASE_DELAY_MS = 1000;

/** Ceiling for the backoff ladder (native twin: `MaxReconnectDelaySec = 10`). */
export const RECONNECT_MAX_DELAY_MS = 10000;

/**
 * The next delay in the ladder: double, capped. Deliberately identical to the native client's 1s → 2s → 4s →
 * 8s → 10s so a phone and the native app behave the same after the same drop. A successful open resets the
 * caller's delay to {@link RECONNECT_BASE_DELAY_MS}.
 */
export function nextReconnectDelayMs(previousMs: number): number {
  const base = Number.isFinite(previousMs) && previousMs > 0 ? previousMs : RECONNECT_BASE_DELAY_MS;
  return Math.min(RECONNECT_MAX_DELAY_MS, base * 2);
}

// NO ESCALATED NOTICE. There used to be one here ("Lost the game connection — the host must reload the saved run"),
// shown once the phase reached `lost`. It is gone, and deliberately not replaced: in practice the great majority of
// escalations were NOT a host that needed touching — a slow headless respawn, a wifi roam, a host frame hitch — and
// the rejoin ladder below healed them on its own seconds later, after the copy had already sent the viewer to
// interrupt a game that was fine. A `lost` phase therefore renders exactly like `reconnecting`: the spinner and
// "Reconnecting…" (see @/mirror/loadingState), which is the only claim we can actually stand behind.
//
// The phase itself is KEPT (below) — it is real, it is what the ladder measures, and a future surface that wants to
// say something honest about it (a subdued "still trying", a diagnostics readout) should read it rather than
// re-derive it. The per-seat `seatStatusReason` strings the SERVER authors for the picker's roster rows are a
// different thing entirely and are untouched: those are authoritative about one named seat.

// ---- drop phase --------------------------------------------------------------------------------------------
//
// The app-level phase a drop puts the viewer in. `mirrorClient.status` stays the 3-valued socket fact
// (connecting/connected/disconnected); THIS is the product state layered on top: "we lost the view and are
// working on it" vs "we lost it and you need to do something".

export type ReconnectPhase =
  /** No drop outstanding — the ordinary picker / joined life. */
  | "steady"
  /** A drop is being retried. Brief, spinner-only, NO scary copy: most drops heal within a step of the ladder. */
  | "reconnecting"
  /** Escalated: the retries are not working, or the host is refusing our seat. Kept as a fact; shows no copy. */
  | "lost";

export interface ReconnectState {
  phase: ReconnectPhase;
  /**
   * CONSECUTIVE reconnect attempts that failed. The original drop is not an attempt (it is the thing being
   * recovered from), so this counts the retries: with the 1s/2s/4s ladder, 3 failures is ~7s of trying.
   */
  failedAttempts: number;
  /**
   * Whether this device had a VIEW (joined seat or direct-view) when the drop chain started. Remembered because
   * the app resets `joined`/`directView` on the very first drop, and because escalating is only meaningful for a
   * viewer who had a seat — a device still sitting on the picker has nothing to "rejoin".
   */
  hadView: boolean;
}

/**
 * How many consecutive FAILED reconnect attempts escalate `reconnecting` to `lost`. 3 lands at ~7s on the
 * 1s→2s→4s ladder: long enough that a blip (game frame hitch, headless restart, wifi roam) has healed silently.
 */
export const RECONNECT_ESCALATE_AFTER_ATTEMPTS = 3;

/** The initial (and post-recovery) phase state. */
export function steadyReconnectState(): ReconnectState {
  return { phase: "steady", failedAttempts: 0, hadView: false };
}

/**
 * The ACTIVE connection went away. The first drop of a chain is always transient — it only starts the ladder;
 * every drop after that is one retry that failed, and rule (a) escalates once enough of them have.
 *
 * `hadView` is sticky across the chain: the app clears `joined`/`directView` on the first drop, so only the
 * first call knows the truth.
 */
export function reconnectStateAfterDrop(prev: ReconnectState, hadView: boolean): ReconnectState {
  if (prev.phase === "steady") {
    return { phase: "reconnecting", failedAttempts: 0, hadView };
  }
  const failedAttempts = prev.failedAttempts + 1;
  const stillHadView = prev.hadView || hadView;
  const escalate =
    prev.phase === "lost" || (stillHadView && failedAttempts >= RECONNECT_ESCALATE_AFTER_ATTEMPTS);
  return { phase: escalate ? "lost" : "reconnecting", failedAttempts, hadView: stillHadView };
}

/**
 * A reconnect SUCCEEDED (we have a live socket and a fresh roster) — rule (b). If the host is up but our seat
 * reads `offline`/`stuck`, retrying is pointless: the host has to reload the saved run before the game will
 * admit us. Escalate straight away rather than pretending an attempt ladder that can never succeed is progress.
 *
 * A steady viewer is untouched: a blocked seat they never held is the picker's own business (the row renders
 * disabled with the server's reason).
 */
export function reconnectStateAfterReconnect(prev: ReconnectState, seatBlocked: boolean): ReconnectState {
  if (prev.phase === "steady" || !seatBlocked || !prev.hadView) {
    return prev;
  }
  return prev.phase === "lost" ? prev : { ...prev, phase: "lost" };
}

/**
 * A view was restored (a headless redirect landed, or the host granted direct-view). This is the ONLY exit from
 * the drop phase, so the ladder (and the attempt counter behind it) starts from scratch on the next blip.
 */
export function reconnectStateAfterViewRestored(): ReconnectState {
  return steadyReconnectState();
}

/** The seat this device was last granted, remembered across a drop so it can be reclaimed without a tap. */
export interface RejoinTarget {
  /** The display name the join was made with (also the fallback match key when there is no playerId). */
  name: string;
  /** The seat's state player id ("p:1003") when the join came from a picker row — the exact match key. */
  playerId?: string;
}

/**
 * The roster row this device may AUTO-REJOIN, or null.
 *
 * Matching is by `playerId` when we have one (a picker tap), because a seat's LABEL is not stable — an unnamed
 * saved seat is rendered as a synthesized "Player 1003" — and the netId is what the host actually resolves. A
 * name-matched fallback covers a `?name=` auto-join, and is restricted to real mirror seats so a stray name
 * collision can never auto-claim the host row.
 *
 * The seat must be `ready`: `stuck`/`offline` rows are refused by the host anyway (it returns the
 * `seat-unavailable` rejection), so retrying them would just spin. Mid-run our seat reads `offline` until the host
 * reloads the saved run — which is exactly when this starts returning the row and the rejoin fires.
 */
export function findAutoRejoinSeat(
  players: BrowserPlayerOption[],
  target: RejoinTarget | null
): BrowserPlayerOption | null {
  const match = findRejoinRow(players, target);
  return match && match.seatStatus === "ready" ? match : null;
}

/**
 * The remembered seat's row on the current roster (whatever its status), or null. Split out of
 * {@link findAutoRejoinSeat} so "our seat is REFUSED" and "our seat is ready" are read off the SAME match rule —
 * they are two answers to one question, and letting them drift would escalate on the wrong row.
 */
function findRejoinRow(
  players: BrowserPlayerOption[],
  target: RejoinTarget | null
): BrowserPlayerOption | null {
  if (!target) {
    return null;
  }
  const match = players.find((player) =>
    target.playerId
      ? player.playerId === target.playerId
      : player.isMirrorSeat && player.name === target.name
  );
  return match && !match.isHost ? match : null;
}

/**
 * Whether the seat this device is trying to reclaim is on the roster but REFUSED (`offline` mid-run / `stuck`
 * lobby zombie) — the "reconnected fine, still can't have your seat back" state that rule (b) escalates on.
 *
 * A seat that is simply ABSENT is deliberately NOT blocked: the host may be on the menu or in a different run,
 * where "the host must reload the saved run" is a guess rather than a diagnosis. That case still escalates
 * through the attempt ladder if the connection itself keeps failing.
 */
export function rejoinSeatIsBlocked(
  players: BrowserPlayerOption[],
  target: RejoinTarget | null
): boolean {
  const match = findRejoinRow(players, target);
  return match !== null && match.seatStatus !== "ready";
}
