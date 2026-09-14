import { describe, expect, it, vi } from "vitest";

import type { PressModality } from "@/inputModality";
import { createRewardFocusCoordinator } from "@/mirror/rewardFocusCoordinator";
import type { RewardFocusSnapshot } from "@/mirror/renderer/contracts";

function snapshot(
  ids: string[],
  options: { screen?: string; focused?: string; covered?: boolean; geometry?: boolean } = {}
): RewardFocusSnapshot {
  return {
    screenId: options.screen ?? "rewards",
    rows: ids.map((id, index) => ({
      id,
      focused: id === options.focused,
      covered: options.covered === true,
      gameCenter: options.geometry === false ? null : { x: 100 + index * 10, y: 200 }
    }))
  };
}

function setup(initialModality: PressModality = "touch", canControl = true) {
  let modality = initialModality;
  const focusTarget = vi.fn();
  const clearProgrammaticFocus = vi.fn();
  const coordinator = createRewardFocusCoordinator({
    modality: () => modality,
    canControl: () => canControl,
    input: { focusTarget, clearProgrammaticFocus }
  });
  return {
    coordinator,
    focusTarget,
    clearProgrammaticFocus,
    setModality: (next: PressModality) => (modality = next),
  };
}

describe("reward focus coordinator", () => {
  it("focuses the first row on touch-mode screen entry, but not in pointer or receive-only mode", () => {
    const touch = setup();
    touch.coordinator.afterReconcile(snapshot(["a", "b"]));
    expect(touch.focusTarget).toHaveBeenCalledWith("a", 100, 200, true);

    const pointer = setup("pointer");
    pointer.coordinator.afterReconcile(snapshot(["a", "b"]));
    expect(pointer.focusTarget).not.toHaveBeenCalled();

    const receiveOnly = setup("touch", false);
    receiveOnly.coordinator.afterReconcile(snapshot(["a", "b"]));
    expect(receiveOnly.focusTarget).not.toHaveBeenCalled();
  });

  it("does not react when unknown becomes touch while an unchanged rewards list is already open", () => {
    const run = setup("unknown");
    run.coordinator.afterReconcile(snapshot(["a", "b", "c"]));
    run.setModality("touch");
    run.coordinator.afterReconcile(snapshot(["a", "b", "c"]));
    expect(run.focusTarget).not.toHaveBeenCalled();

    run.coordinator.afterReconcile(snapshot(["b", "c"]));
    expect(run.focusTarget).toHaveBeenCalledWith("b", 100, 200, true);
  });

  it("keeps the removed index for first/middle removal and clamps a removed last row", () => {
    const first = setup();
    first.coordinator.afterReconcile(snapshot(["a", "b", "c"]));
    first.focusTarget.mockClear();
    first.coordinator.afterReconcile(snapshot(["b", "c"]));
    expect(first.focusTarget).toHaveBeenCalledWith("b", 100, 200, true);

    const middle = setup();
    middle.coordinator.afterReconcile(snapshot(["a", "b", "c"]));
    middle.focusTarget.mockClear();
    middle.coordinator.afterReconcile(snapshot(["a", "c"]));
    expect(middle.focusTarget).toHaveBeenCalledWith("c", 110, 200, true);

    const last = setup();
    last.coordinator.afterReconcile(snapshot(["a", "b", "c"]));
    last.focusTarget.mockClear();
    last.coordinator.afterReconcile(snapshot(["a", "b"]));
    expect(last.focusTarget).toHaveBeenCalledWith("b", 110, 200, true);
  });

  it("prefers a focused row among coalesced removals, otherwise the lowest removed index", () => {
    const focused = setup();
    focused.coordinator.afterReconcile(snapshot(["a", "b", "c", "d"], { focused: "b" }));
    focused.focusTarget.mockClear();
    focused.coordinator.afterReconcile(snapshot(["c", "d"]));
    expect(focused.focusTarget).toHaveBeenCalledWith("d", 110, 200, true);

    const lowest = setup();
    lowest.coordinator.afterReconcile(snapshot(["a", "b", "c", "d"]));
    lowest.focusTarget.mockClear();
    lowest.coordinator.afterReconcile(snapshot(["c", "d"]));
    expect(lowest.focusTarget).toHaveBeenCalledWith("c", 100, 200, true);
  });

  it("defers through cover and missing geometry, retaining removal comparisons while covered", () => {
    const run = setup();
    run.coordinator.afterReconcile(snapshot(["a", "b", "c"], { covered: true }));
    expect(run.focusTarget).not.toHaveBeenCalled();

    run.coordinator.afterReconcile(snapshot(["a", "c"], { covered: true }));
    run.coordinator.afterReconcile(snapshot(["a", "c"], { geometry: false }));
    expect(run.focusTarget).not.toHaveBeenCalled();

    run.coordinator.afterReconcile(snapshot(["a", "c"]));
    expect(run.focusTarget).toHaveBeenCalledWith("c", 110, 200, true);
  });

  it("retargets the intended survivor after post-removal layout settles and waits for authoritative focus", () => {
    const run = setup();
    run.coordinator.afterReconcile(snapshot(["a", "b", "c"], { focused: "a" }));
    run.focusTarget.mockClear();

    const oldPosition = snapshot(["b", "c"]);
    oldPosition.rows[0].gameCenter = { x: 100, y: 300 };
    run.coordinator.afterReconcile(oldPosition);
    expect(run.focusTarget).toHaveBeenLastCalledWith("b", 100, 300, true);

    // An unrelated unchanged reconcile neither creates a new request nor repeats the same hover.
    run.coordinator.afterReconcile(oldPosition);
    expect(run.focusTarget).toHaveBeenCalledTimes(1);

    const settled = snapshot(["b", "c"]);
    settled.rows[0].gameCenter = { x: 100, y: 200 };
    run.coordinator.afterReconcile(settled);
    expect(run.focusTarget).toHaveBeenLastCalledWith("b", 100, 200, true);
    expect(run.focusTarget).toHaveBeenCalledTimes(2);

    run.coordinator.afterReconcile(snapshot(["b", "c"], { focused: "b" }));
    run.coordinator.afterReconcile(snapshot(["b", "c"], { focused: "b" }));
    expect(run.focusTarget).toHaveBeenCalledTimes(2);
  });

  it("keeps entry focus pending through the settling window, then releases it after confirmation", () => {
    vi.useFakeTimers();
    try {
      const run = setup();
      run.coordinator.afterReconcile(snapshot(["a", "b"]));
      run.coordinator.afterReconcile(snapshot(["a", "b"], { focused: "a" }));
      expect(run.focusTarget).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(750);
      run.coordinator.afterReconcile(snapshot(["a", "b"]));
      expect(run.focusTarget).toHaveBeenCalledTimes(1);
      run.coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a real touch on another target supersede a still-settling auto-focus, and drops the readiness", () => {
    vi.useFakeTimers();
    try {
      const run = setup();
      run.coordinator.afterReconcile(snapshot(["a", "b"]));
      expect(run.focusTarget).toHaveBeenCalledOnce();
      run.clearProgrammaticFocus.mockClear();

      run.coordinator.noteTouchTarget("b");
      run.coordinator.afterReconcile(snapshot(["a", "b"], { focused: "b" }));
      vi.advanceTimersByTime(1000);
      expect(run.focusTarget).toHaveBeenCalledOnce();
      // The armed row is no longer what the player is touching, so it must go back to the ordinary two-tap.
      expect(run.clearProgrammaticFocus).toHaveBeenCalled();
      run.coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the readiness for a touch on the armed row itself — that tap is the one-tap claim", () => {
    const run = setup();
    run.coordinator.afterReconcile(snapshot(["a", "b"]));
    expect(run.focusTarget).toHaveBeenCalledWith("a", 100, 200, true);

    run.coordinator.noteTouchTarget("a");
    expect(run.clearProgrammaticFocus).not.toHaveBeenCalled();
  });

  it("releases the readiness once the armed row is authoritatively focused, but never on a bare unfocused frame", () => {
    const run = setup();
    run.coordinator.afterReconcile(snapshot(["a", "b"]));
    expect(run.focusTarget).toHaveBeenCalledWith("a", 100, 200, true);

    // The gap the latch exists for: the hover is out, the host has not answered yet.
    run.coordinator.afterReconcile(snapshot(["a", "b"]));
    expect(run.clearProgrammaticFocus).not.toHaveBeenCalled();

    run.coordinator.afterReconcile(snapshot(["a", "b"], { focused: "a" }));
    expect(run.clearProgrammaticFocus).toHaveBeenCalledOnce();

    // Focus moving away afterwards is the reported bug's shape: no latch may survive to activate on the next tap.
    run.coordinator.afterReconcile(snapshot(["a", "b"]));
    expect(run.clearProgrammaticFocus).toHaveBeenCalledOnce();
  });

  it("releases the readiness on a touch elsewhere even when no flow is pending any more", () => {
    const run = setup();
    run.coordinator.afterReconcile(snapshot(["a", "b"]));
    // A pure reorder drops `pending` while the readiness stays armed — the case the `!pending?.targetId` early
    // return used to walk straight past.
    run.coordinator.afterReconcile(snapshot(["b", "a"]));
    expect(run.clearProgrammaticFocus).not.toHaveBeenCalled();

    run.coordinator.noteTouchTarget("b");
    expect(run.clearProgrammaticFocus).toHaveBeenCalledOnce();
  });

  it("gives up after one bounded settle retry instead of re-hovering forever", () => {
    vi.useFakeTimers();
    try {
      const run = setup();
      run.coordinator.afterReconcile(snapshot(["a", "b"]));
      expect(run.focusTarget).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(750); // the one bounded retry
      expect(run.focusTarget).toHaveBeenCalledTimes(2);
      expect(run.clearProgrammaticFocus).not.toHaveBeenCalled();

      vi.advanceTimersByTime(750); // still unconfirmed → stop, and drop the readiness with the flow
      expect(run.focusTarget).toHaveBeenCalledTimes(2);
      expect(run.clearProgrammaticFocus).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(10_000);
      expect(run.focusTarget).toHaveBeenCalledTimes(2);
      run.coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the readiness when the armed row leaves the list", () => {
    const run = setup();
    run.coordinator.afterReconcile(snapshot(["a", "b"]));
    expect(run.focusTarget).toHaveBeenCalledWith("a", 100, 200, true);
    run.clearProgrammaticFocus.mockClear();

    run.coordinator.afterReconcile(snapshot(["b"]));
    expect(run.clearProgrammaticFocus).toHaveBeenCalledOnce();
    // …and the survivor is armed in its place, so the release is not a regression of the auto-focus job.
    expect(run.focusTarget).toHaveBeenLastCalledWith("b", 100, 200, true);
  });

  it("does nothing for empty lists, unchanged keyframes, or pure reorders and clears on rewards exit", () => {
    const run = setup();
    run.coordinator.afterReconcile(snapshot([]));
    run.coordinator.afterReconcile(snapshot(["a", "b"]));
    run.focusTarget.mockClear();
    run.coordinator.afterReconcile(snapshot(["a", "b"]));
    run.coordinator.afterReconcile(snapshot(["b", "a"]));
    expect(run.focusTarget).not.toHaveBeenCalled();

    run.coordinator.afterReconcile({ screenId: null, rows: [] });
    expect(run.clearProgrammaticFocus).toHaveBeenCalled();
  });
});
