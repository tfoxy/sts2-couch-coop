import type { PressModality } from "@/inputModality";
import type { InputCapture } from "@/mirror/inputCapture";
import type { RewardFocusSnapshot } from "@/mirror/renderer/contracts";

const EMPTY: RewardFocusSnapshot = { screenId: null, rows: [] };
const FOCUS_SETTLE_MS = 750;
// How many times the settle timer may RE-SEND an unconfirmed hover for one pending flow. One: the timer exists to
// cover a row that was entering or being reparented when the first hover went out. A row the host never reports
// focused is not going to start, and re-hovering it forever also re-arms the readiness latch forever.
const MAX_SETTLE_RETRIES = 1;

export interface RewardFocusCoordinator {
  afterReconcile(snapshot: RewardFocusSnapshot): void;
  /** A real touch supersedes a still-settling auto-focus when it targets somewhere else. */
  noteTouchTarget(id: string | null): void;
  /**
   * Drops the narrow programmatic readiness this coordinator armed (see `readyId`). The coordinator is its SOLE
   * owner — every other module that wants it gone asks here rather than reaching for
   * `InputCapture.clearProgrammaticFocus`, so the latch can never outlive the focus it stands in for.
   */
  releaseReady(): void;
  dispose(): void;
}

/** Coordinates reward-list focus from scene transitions, never from a modality transition by itself. */
export function createRewardFocusCoordinator(options: {
  modality: () => PressModality;
  canControl: () => boolean;
  input: Pick<InputCapture, "focusTarget" | "clearProgrammaticFocus">;
}): RewardFocusCoordinator {
  let previous = EMPTY;
  let pending: {
    screenId: string;
    index: number;
    targetId?: string;
    gameX?: number;
    gameY?: number;
    retries?: number;
  } | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  // The row whose programmatic readiness is currently armed in InputCapture — the mirror image of its
  // `programmaticFocusedRootId`, which only `focusTarget(…, true)` below ever sets. That latch makes the row
  // "already ready, activate on release" at the next press, so it must live exactly as long as the gap it covers:
  // from the auto-focus hover until authoritative focus arrives (or the row/screen/user says otherwise).
  let readyId: string | null = null;

  function cancelSettleTimer(): void {
    if (settleTimer === null) return;
    clearTimeout(settleTimer);
    settleTimer = null;
  }

  function releaseReady(): void {
    if (readyId === null) return;
    readyId = null;
    options.input.clearProgrammaticFocus();
  }

  function clearFlow(): void {
    cancelSettleTimer();
    pending = null;
    releaseReady();
  }

  function scheduleSettleCheck(): void {
    cancelSettleTimer();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (!pending) return;
      if (!options.canControl() || options.modality() !== "touch") {
        pending = null;
        releaseReady();
        return;
      }
      attemptPending(previous, true);
    }, FOCUS_SETTLE_MS);
  }

  function attemptPending(snapshot: RewardFocusSnapshot, fromSettleTimer = false): void {
    if (pending?.screenId !== snapshot.screenId || snapshot.rows.length === 0) return;
    const index = Math.min(pending.index, snapshot.rows.length - 1);
    const pendingTargetId = pending.targetId;
    // Once the intended row has been resolved, keep following its stable id while layout settles. A later real
    // removal replaces `pending`; a reorder by itself is cancelled by afterReconcile and cannot change the target.
    const target =
      (pendingTargetId && snapshot.rows.find((row) => row.id === pendingTargetId)) || snapshot.rows[index];
    if (target.covered || target.gameCenter === null) return;
    const matchesLastAttempt =
      pending.targetId === target.id &&
      pending.gameX === target.gameCenter.x &&
      pending.gameY === target.gameCenter.y;
    const retries = pending.retries ?? 0;

    if (matchesLastAttempt) {
      if (target.focused) {
        // Focus is authoritative only after the row has remained under the sent coordinate through the settling
        // window. Before then the list may reflow beneath a stationary game cursor and focus a neighbouring row.
        if (fromSettleTimer) pending = null;
        else if (settleTimer === null) scheduleSettleCheck();
        return;
      }
      // An unchanged reconcile is not a reason to repeat input. The timer provides the bounded retry if the game
      // ignored the hover while the row was entering or being reparented.
      if (!fromSettleTimer) return;
    }
    if (fromSettleTimer && retries >= MAX_SETTLE_RETRIES) {
      // Give up rather than re-hover on a loop: this row is not going to be focused by us. Drop the readiness with
      // the flow, so the worst case is the player's ordinary two-tap (focus, then activate) rather than a row that
      // stays falsely armed and takes itself on the next tap.
      cancelSettleTimer();
      pending = null;
      releaseReady();
      return;
    }

    options.input.focusTarget(target.id, target.gameCenter.x, target.gameCenter.y, true);
    readyId = target.id;
    pending = {
      ...pending,
      targetId: target.id,
      gameX: target.gameCenter.x,
      gameY: target.gameCenter.y,
      retries: fromSettleTimer ? retries + 1 : retries
    };
    scheduleSettleCheck();
  }

  /**
   * AUTHORITATIVE FOCUS SUPERSEDES THE LATCH. `readyId` stands in for the streamed `focused` flag across one
   * hover → focus-delta round trip; the moment that flag arrives for the armed row the stream carries the
   * readiness itself, and a latch that stays on outlives its own focus — the row would then activate on a tap
   * that should merely re-focus it, after the player has focused something else.
   *
   * Deliberately NOT released on a bare `focused: false`: that is exactly the gap the latch exists to cover.
   */
  function noteAuthoritativeFocus(snapshot: RewardFocusSnapshot): void {
    if (readyId === null) return;
    const row = snapshot.rows.find((candidate) => candidate.id === readyId);
    if (!row || row.focused) releaseReady();
  }

  function afterReconcile(snapshot: RewardFocusSnapshot): void {
    const previousScreen = previous.screenId;
    const screenChanged = snapshot.screenId !== previousScreen;
    let reorderedWithoutRemoval = false;
    if (screenChanged) clearFlow();

    if (snapshot.screenId === null) {
      previous = snapshot;
      return;
    }

    // Before the pending machinery, which may re-arm the latch for a new row in this same reconcile.
    noteAuthoritativeFocus(snapshot);

    if (options.canControl() && options.modality() === "touch") {
      if (screenChanged) {
        pending = { screenId: snapshot.screenId, index: 0 };
      } else {
        const currentIds = new Set(snapshot.rows.map((row) => row.id));
        const removed = previous.rows
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => !currentIds.has(row.id));
        if (removed.length > 0 && snapshot.rows.length > 0) {
          const chosen = removed.find(({ row }) => row.focused) ?? removed[0];
          pending = { screenId: snapshot.screenId, index: chosen.index };
        } else if (
          previous.rows.length === snapshot.rows.length &&
          previous.rows.some((row, index) => row.id !== snapshot.rows[index]?.id)
        ) {
          reorderedWithoutRemoval = true;
        }
      }
    } else {
      cancelSettleTimer();
      pending = null;
    }

    // Retain every reconcile before attempting the deferred action. A covered/geometry-less frame can still carry
    // a later list removal, whose index comparison must be made against exactly this list.
    previous = snapshot;

    if (reorderedWithoutRemoval) {
      cancelSettleTimer();
      pending = null;
      return;
    }
    attemptPending(snapshot);
  }

  function noteTouchTarget(id: string | null): void {
    // A deliberate touch anywhere but the armed row retires its readiness, whether or not a flow is still pending:
    // the player has expressed a newer target, and the armed row must go back to the ordinary focus-first tap.
    // InputCapture reads the latch for THIS press before calling in, so a tap on the armed row still activates.
    if (id !== readyId) releaseReady();
    if (!pending?.targetId || id === pending.targetId) return;
    // This also stops the coordinator from moving focus back after the user's down-hover has expressed a newer
    // target.
    cancelSettleTimer();
    pending = null;
  }

  return {
    afterReconcile,
    noteTouchTarget,
    releaseReady,
    dispose: clearFlow
  };
}
