import { describe, expect, it } from "vitest";

import {
  createCanvasFrameScheduler,
  type CanvasFrameSchedulerPlatform,
  type CanvasFrameSchedulerPorts,
  type CanvasIdleStageBypass,
} from "@/mirror/renderer/canvas/frameScheduler";

interface TestState {
  revision: number;
}

interface ScheduledTimer {
  readonly callback: () => void;
  readonly delay: number;
}

/** A direct scheduler harness: no DOM, renderer, texture cache or Vue lifecycle. */
function createHarness() {
  let now = 100;
  let nextHandle = 1;
  let state: TestState | null = { revision: 1 };
  let disposed = false;
  let revisionAtFrame = 1;
  let offsetRampDue = Infinity;
  let loopDue = Infinity;
  let loopPerFrame = false;
  let trailDue = Infinity;
  let passiveDue = Infinity;
  let idleAnimFps = 30;
  let idleNotBefore = 0;
  let bypass: CanvasIdleStageBypass | null = null;
  let patchPainted = false;
  let buildAccepted = true;
  const log: string[] = [];
  const rafs = new Map<number, FrameRequestCallback>();
  const issuedRafs = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, ScheduledTimer>();
  const issuedTimers = new Map<number, ScheduledTimer>();
  const cancelledRafs: number[] = [];
  const clearedTimers: number[] = [];

  const platform: CanvasFrameSchedulerPlatform = {
    requestAnimationFrame(callback) {
      const handle = nextHandle++;
      rafs.set(handle, callback);
      issuedRafs.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) {
      cancelledRafs.push(handle);
      rafs.delete(handle);
    },
    setTimeout(callback, delay) {
      const handle = nextHandle++;
      const timer = { callback, delay };
      timers.set(handle, timer);
      issuedTimers.set(handle, timer);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle) {
      const numberHandle = handle as unknown as number;
      clearedTimers.push(numberHandle);
      timers.delete(numberHandle);
    },
  };

  const ports: CanvasFrameSchedulerPorts<TestState> = {
    now: () => now,
    state: () => state,
    disposed: () => disposed,
    revisionAtFrame: () => revisionAtFrame,
    idleAnimFps: () => idleAnimFps,
    platform,
    deadlines: {
      offsetRampDeadline: () => offsetRampDue,
      loopDeadline: () => loopDue,
      loopHasPerFrameDemand: () => loopPerFrame,
      trailDeadline: () => trailDue,
      passiveDeadline: () => {
        log.push("passive");
        return passiveDue;
      },
      idleStageBypass: () => {
        log.push("bypass");
        return bypass;
      },
      idleStageNotBefore: () => idleNotBefore,
    },
    animation: {
      advanceOffsetRamps: () => {
        log.push("ramp");
        return false;
      },
      noteIdleStageMissingPassive: () => log.push("missingPassive"),
      noteIdleStageSkippedEarly: () => log.push("skippedEarly"),
      noteIdleStageAdmission: () => log.push("admitPassive"),
      sampleVisual: () => log.push("sample"),
      noteTrailFlightHeads: () => log.push("trailHeads"),
      tickTrails: () => log.push("tickTrails"),
      mergeTrailLatches: () => log.push("mergeTrails"),
      advanceVisual: () => log.push("advance"),
      tickSpine: () => log.push("spine"),
      tryPatchAndPaint: () => {
        log.push("patch");
        return patchPainted;
      },
      runBuild: () => {
        log.push("build");
        return buildAccepted;
      },
      syncOverlay: () => log.push("sync"),
      paintAction: () => log.push("paint"),
      settleLanding: () => log.push("landing"),
      rebuildAndPaintTexture: () => log.push("texture"),
    },
  };

  const scheduler = createCanvasFrameScheduler(ports);
  return {
    scheduler,
    log,
    rafs,
    issuedRafs,
    timers,
    issuedTimers,
    cancelledRafs,
    clearedTimers,
    set now(value: number) { now = value; },
    get now() { return now; },
    set state(value: TestState | null) { state = value; },
    set disposed(value: boolean) { disposed = value; },
    set revisionAtFrame(value: number) { revisionAtFrame = value; },
    set offsetRampDue(value: number) { offsetRampDue = value; },
    set loopDue(value: number) { loopDue = value; },
    set loopPerFrame(value: boolean) { loopPerFrame = value; },
    set trailDue(value: number) { trailDue = value; },
    set passiveDue(value: number) { passiveDue = value; },
    set idleAnimFps(value: number) { idleAnimFps = value; },
    set idleNotBefore(value: number) { idleNotBefore = value; },
    set bypass(value: CanvasIdleStageBypass | null) { bypass = value; },
    set patchPainted(value: boolean) { patchPainted = value; },
    set buildAccepted(value: boolean) { buildAccepted = value; },
    flushRafs(): void {
      const due = [...rafs.values()];
      rafs.clear();
      for (const callback of due) callback(now);
    },
    fireTimer(handle: number): void {
      const timer = timers.get(handle);
      if (!timer) throw new Error(`timer ${handle} is not pending`);
      timers.delete(handle);
      timer.callback();
    },
  };
}

describe("canvas frame scheduler", () => {
  it("parks only true future deadlines, never re-arms later, and pre-empts for an earlier one", () => {
    const h = createHarness();
    h.passiveDue = 180;
    h.scheduler.armAnimation(h.now);

    const [firstHandle] = [...h.timers.keys()];
    expect(h.timers.get(firstHandle)?.delay).toBe(76); // 180 - 4 - 100
    expect(h.scheduler.armedParks).toBe(1);
    expect(h.rafs.size).toBe(0);

    h.now = 101;
    h.passiveDue = 260;
    h.scheduler.armAnimation(h.now);
    expect(h.timers.size).toBe(1);
    expect(h.clearedTimers).toEqual([]);
    expect(h.scheduler.armedParks).toBe(1);

    h.now = 102;
    h.passiveDue = 140;
    h.scheduler.armAnimation(h.now);
    const [earlierHandle] = [...h.timers.keys()];
    expect(earlierHandle).not.toBe(firstHandle);
    expect(h.clearedTimers).toEqual([firstHandle]);
    expect(h.timers.get(earlierHandle)?.delay).toBe(34); // 140 - 4 - 102
    expect(h.scheduler.armedParks).toBe(2);

    h.fireTimer(earlierHandle);
    expect(h.scheduler.parkWakeups).toBe(1);
    expect(h.rafs.size).toBe(1);
    expect(h.timers.size).toBe(0);

    // A pending animation frame is never cancelled or replaced by a later park.
    h.passiveDue = 500;
    h.scheduler.armAnimation(h.now);
    expect(h.rafs.size).toBe(1);
    expect(h.timers.size).toBe(0);
    expect(h.cancelledRafs).toEqual([]);
  });

  it("uses a display rAF rather than a timer within the four-millisecond slop", () => {
    const h = createHarness();
    h.passiveDue = h.now + 4;
    h.scheduler.armAnimation(h.now);

    expect(h.rafs.size).toBe(1);
    expect(h.timers.size).toBe(0);
    expect(h.scheduler.armedRafs).toBe(1);
  });

  it("keeps the 60 Hz passive display gate as an rAF chain and asks bypass late", () => {
    const passive = createHarness();
    passive.idleAnimFps = 60;
    passive.passiveDue = 180;
    passive.idleNotBefore = 180;
    passive.scheduler.armAnimation(passive.now);

    expect(passive.rafs.size).toBe(1);
    expect(passive.timers.size).toBe(0);

    const immediate = createHarness();
    immediate.idleAnimFps = 60;
    immediate.loopDue = immediate.now;
    immediate.loopPerFrame = true;
    immediate.passiveDue = 180;
    immediate.idleNotBefore = 180;
    immediate.scheduler.armAnimation(immediate.now);

    // The loop's unconditional display demand wins before the fast-passive
    // predicate can re-read loop/trail/Fx state through `idleStageBypass`.
    expect(immediate.log).toEqual([]);
  });

  it("owns the full action-frame ordering without allocating a second build path", () => {
    const h = createHarness();
    h.loopDue = h.now;
    h.loopPerFrame = true;
    h.bypass = "tween";
    h.scheduler.armAnimation(h.now);
    h.log.length = 0; // deadline reads are not part of the delivered-frame assertion

    h.flushRafs();

    expect(h.log).toEqual([
      "ramp", "bypass", "passive", "sample", "trailHeads", "tickTrails", "mergeTrails",
      "advance", "spine", "patch", "build", "sync", "paint", "landing",
    ]);
    expect(h.scheduler.animFrames).toBe(1);
  });

  it("pulls a stale pending reconcile and returns before animation build or paint", () => {
    const h = createHarness();
    h.state = { revision: 2 };
    h.revisionAtFrame = 1;
    h.loopDue = h.now;
    h.loopPerFrame = true;
    let pending = true;
    h.scheduler.setReconcilePull({
      pending: () => pending,
      now: () => {
        h.log.push("pull");
        pending = false;
      },
    });
    h.scheduler.armAnimation(h.now);
    h.log.length = 0;

    h.flushRafs();

    expect(h.log).toEqual(["pull"]);
    expect(h.scheduler.pulledReconciles).toBe(1);
    expect(h.scheduler.animFrames).toBe(0);
  });

  it("coalesces texture resource repaints into one independent non-action callback", () => {
    const h = createHarness();
    h.scheduler.scheduleTexturePaint();
    h.scheduler.scheduleTexturePaint();

    expect(h.rafs.size).toBe(1);
    h.flushRafs();

    // The texture callback cannot reach runBuild/paintAction/ack: it has one
    // narrow resource repaint port instead.
    expect(h.log).toEqual(["texture"]);
    expect(h.scheduler.animFrames).toBe(0);
  });

  it("cancels animation, texture, and parked-timer callbacks on dispose and makes late delivery inert", () => {
    const active = createHarness();
    active.loopDue = active.now;
    active.loopPerFrame = true;
    active.scheduler.armAnimation(active.now);
    active.scheduler.scheduleTexturePaint();
    const activeCallbacks = [...active.issuedRafs.values()];
    active.log.length = 0;

    active.scheduler.dispose();
    expect(active.cancelledRafs).toHaveLength(2);
    expect(active.rafs.size).toBe(0);
    active.now = 120;
    for (const callback of activeCallbacks) callback(active.now);
    expect(active.log).toEqual([]);
    // Cancellation is the normal browser path; this direct late delivery
    // proves accounting remains unbiased if a callback was already dequeued.
    expect(active.scheduler.rafDeliverySamples).toEqual([20]);

    const parked = createHarness();
    parked.passiveDue = 200;
    parked.scheduler.armAnimation(parked.now);
    const [timerHandle] = [...parked.issuedTimers.keys()];
    const timer = parked.issuedTimers.get(timerHandle)!;
    parked.log.length = 0;

    parked.scheduler.dispose();
    expect(parked.clearedTimers).toEqual([timerHandle]);
    timer.callback();
    expect(parked.rafs.size).toBe(0);
    expect(parked.log).toEqual([]);
  });
});
