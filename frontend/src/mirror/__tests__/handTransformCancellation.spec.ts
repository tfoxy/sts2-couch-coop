import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyKeyframe, createMirrorState, holderId, holderSpec, installHandStage,
  positionHint, update, type HandStage } from "./handStageHarness";

const id = holderId(2);
const cancel = (x = 958) => ({ targetId: id, property: "position", durationMs: 0,
  cancelTransform: [1, 0, 0, 1, x, 1030] });

describe.each(["dom", "canvas"] as const)("%s explicit transform cancellation", (backend) => {
  let rig: HandStage;
  beforeEach(() => { rig = installHandStage(); });
  afterEach(() => { rig.teardown(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function setup() {
    const arm = rig.makeArm(backend, 1.25, false);
    const state = createMirrorState();
    applyKeyframe(state, 5);
    arm.renderer.reconcile(state);
    rig.pump();
    return { arm, state };
  }

  it("adopts the authoritative global pose immediately and keeps descendants aligned without another delta", () => {
    const { arm, state } = setup();
    update(state, [], [positionHint(id, [1, 0, 0, 1, -155, -50], 600)]);
    arm.renderer.reconcile(state);
    rig.pump(80);
    update(state, [], [cancel()]);
    arm.renderer.reconcile(state);
    rig.pump();
    const pose = arm.poses().holders.find((h) => h.id === id)!;
    expect(pose.channelLive).toBe(false);
    expect(pose.mGame[4]).toBeCloseTo(958);
    expect(pose.mDrawn[4]).toBeCloseTo(1197.5);
    const rect = arm.renderer.interactiveRects().find((r) => r.id === `${id}-hitbox`)!;
    expect(rect.transform[4] + rect.spreadDx).toBeCloseTo(1047.5);
    rig.pump(1000);
    expect(arm.poses().holders.find((h) => h.id === id)!.mDrawn[4]).toBeCloseTo(1197.5);
    const row = arm.landings().rows.find((r) => r.id === id && r.closedBy === "cancelled")!;
    expect(row).toBeDefined();
    expect(row.cancellationPose?.[4]).toBe(958);
    expect(row.cancellationDriftPx).toBeCloseTo(0);
  });

  it("fences a queued primed arm before its animation frame", () => {
    const { arm, state } = setup();
    update(state, [], [positionHint(id, [1, 0, 0, 1, -155, -50], 600, [1, 0, 0, 1, -100, -50])]);
    arm.renderer.reconcile(state);
    update(state, [], [cancel()]);
    arm.renderer.reconcile(state);
    rig.pump(1000);
    const pose = arm.poses().holders.find((h) => h.id === id)!;
    expect(pose.channelLive).toBe(false);
    expect(pose.mDrawn[4]).toBeCloseTo(1197.5);
  });

  it("keeps wire order when an old prime, cancellation, and replacement share a frame", () => {
    const { arm, state } = setup();
    update(state, [], [
      positionHint(id, [1, 0, 0, 1, -155, -50], 600, [1, 0, 0, 1, -100, -50]),
      cancel(), positionHint(id, [1, 0, 0, 1, 40, -50], 400),
    ]);
    arm.renderer.reconcile(state);
    rig.pump(50);
    expect(arm.poses().holders.find((h) => h.id === id)!.channelLive).toBe(true);
    rig.pump(500);
    expect(arm.poses().holders.find((h) => h.id === id)!.mDrawn[4]).toBeCloseTo(1250);
  });

  it("uses a newer transform in the cancellation's own capture", () => {
    const { arm, state } = setup();
    update(state, [], [positionHint(id, [1, 0, 0, 1, -155, -50], 600)]);
    arm.renderer.reconcile(state);
    rig.pump(50);
    update(state, [holderSpec(2, "container", [1, 0, 0, 1, 100, -50])], [cancel()]);
    arm.renderer.reconcile(state);
    rig.pump();
    expect(arm.poses().holders.find((h) => h.id === id)!.mDrawn[4]).toBeCloseTo(1325);
  });

  it("localizes a cancellation against a changed parent instead of multiplying its global pose twice", () => {
    const { arm, state } = setup();
    update(state, [], [positionHint(id, [1, 0, 0, 1, -155, -50], 600)]);
    arm.renderer.reconcile(state);
    rig.pump(50);
    update(state, [holderSpec(2, "hand", null)], [cancel()],
      ["root", "hand", "container", ...state.orderedIds.filter((x) => !["root", "hand", "container"].includes(x) && !x.startsWith(id)),
        ...state.orderedIds.filter((x) => x.startsWith(id))]);
    arm.renderer.reconcile(state);
    rig.pump();
    const pose = arm.poses().holders.find((h) => h.id === id)!;
    expect(pose.mGame[4]).toBeCloseTo(958);
    expect(pose.mGame[5]).toBeCloseTo(1030);
    expect(pose.channelLive).toBe(false);
  });

  it("adopts a newer coalesced stream pose instead of replaying the cancellation's older pose", () => {
    const { arm, state } = setup();
    update(state, [], [positionHint(id, [1, 0, 0, 1, -155, -50], 600)]);
    arm.renderer.reconcile(state);
    rig.pump(50);
    update(state, [], [cancel()]);
    update(state, [holderSpec(2, "container", [1, 0, 0, 1, 100, -50])]);
    arm.renderer.reconcile(state);
    rig.pump();
    expect(arm.poses().holders.find((h) => h.id === id)!.mDrawn[4]).toBeCloseTo(1325);
  });
});
