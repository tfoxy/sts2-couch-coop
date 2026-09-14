import type { PressModality } from "@/inputModality";
import type { InputCapture } from "@/mirror/inputCapture";
import type { RewardFocusSnapshot } from "@/mirror/renderer/contracts";

const EMPTY: RewardFocusSnapshot = { screenId: null, rows: [] };
const FOCUS_SETTLE_MS = 750;

export interface RewardFocusCoordinator {
  afterReconcile(snapshot: RewardFocusSnapshot): void;
  /** A real touch supersedes a still-settling auto-focus when it targets somewhere else. */
  noteTouchTarget(id: string | null): void;
  dispose(): void;
}

/** Coordinates reward-list focus from scene transitions, never from a modality transition by itself. */
export function createRewardFocusCoordinator(options: {
  modality: () => PressModality;
  canControl: () => boolean;
  input: Pick<InputCapture, "focusTarget" | "clearProgrammaticFocus">;
}): RewardFocusCoordinator {
  let previous = EMPTY;
  let pending: { screenId: string; index: number; targetId?: string; gameX?: number; gameY?: number } | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelSettleTimer(): void {
    if (settleTimer === null) return;
    clearTimeout(settleTimer);
    settleTimer = null;
  }

  function clearFlow(): void {
    cancelSettleTimer();
    pending = null;
    options.input.clearProgrammaticFocus();
  }

  function scheduleSettleCheck(): void {
    cancelSettleTimer();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (!pending) return;
      if (!options.canControl() || options.modality() !== "touch") {
        pending = null;
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

    if (matchesLastAttempt) {
      if (target.focused) {
        // Focus is authoritative only after the row has remained under the sent coordinate through the settling
        // window. Before then the list may reflow beneath a stationary game cursor and focus a neighbouring row.
        if (fromSettleTimer) pending = null;
        else if (settleTimer === null) scheduleSettleCheck();
        return;
      }
      // An unchanged reconcile is not a reason to repeat input. The timer provides one bounded retry if the game
      // ignored the hover while the row was entering or being reparented.
      if (!fromSettleTimer) return;
    }

    options.input.focusTarget(target.id, target.gameCenter.x, target.gameCenter.y, true);
    pending = {
      ...pending,
      targetId: target.id,
      gameX: target.gameCenter.x,
      gameY: target.gameCenter.y
    };
    scheduleSettleCheck();
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
    if (!pending?.targetId || id === pending.targetId) return;
    // Do not clear InputCapture's programmatic readiness here: the plan deliberately keeps that narrow arm until
    // pointer mode or rewards-flow exit. This only stops the coordinator from moving focus back after the user's
    // down-hover has expressed a newer target.
    cancelSettleTimer();
    pending = null;
  }

  return {
    afterReconcile,
    noteTouchTarget,
    dispose: clearFlow
  };
}
