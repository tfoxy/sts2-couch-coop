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
function createHarness(cpuIncremental = true, displayPacedPassive = false) {
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
  let texturePainted = true;
  const log: string[] = [];
  const sampleTimes: number[] = [];
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
    cpuIncremental,
    idleAnimFps: () => idleAnimFps,
    displayPacedPassive,
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
      sampleVisual: (at) => { log.push("sample"); sampleTimes.push(at); },
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
      paintAction: () => { log.push("paint"); return true; },
      settleLanding: () => log.push("landing"),
      rebuildAndPaintTexture: () => { log.push("texture"); return texturePainted; },
    },
  };

  const scheduler = createCanvasFrameScheduler(ports);
  return {
    scheduler,
    log,
    sampleTimes,
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
    set texturePainted(value: boolean) { texturePainted = value; },
    flushRafs(): void {
      const due = [...rafs.values()];
      rafs.clear();
      for (const callback of due) callback(now);
    },
    fireRaf(handle: number): void {
      const callback = rafs.get(handle);
      if (!callback) throw new Error(`rAF ${handle} is not pending`);
      rafs.delete(handle);
      callback(now);
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
  it("builds changed animation frames when CPU incrementality is disabled", () => {
    const h = createHarness(false);
    h.loopDue = h.now;
    h.loopPerFrame = true;
    h.bypass = "tween";
    h.patchPainted = true;
    h.scheduler.armAnimation(h.now);
    h.log.length = 0;
    h.flushRafs();
    expect(h.log).not.toContain("patch");
    expect(h.log).toContain("build");
    expect(h.log).toContain("paint");
  });

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

  it("samples finite passive demand on every 90 Hz display frame and parks when it ends", () => {
    const h = createHarness(true, true);
    h.passiveDue = h.now + 1000; // a source-only deadline; no local idle loop or tween demand
    h.idleNotBefore = h.now + 1000; // the authored 60 Hz phase must not reject these frames
    h.patchPainted = true;
    h.scheduler.armAnimation(h.now);
    for (let frame = 1; frame <= 90; frame++) {
      h.now = 100 + frame * (1000 / 90);
      h.flushRafs();
    }
    expect(h.scheduler.animFrames).toBe(90);
    expect(h.sampleTimes).toHaveLength(90);
    expect(h.sampleTimes[0]).toBeCloseTo(100 + 1000 / 90, 8);
    expect(h.sampleTimes.at(-1)).toBeCloseTo(1100, 8);
    expect(h.log.filter((entry) => entry === "sample")).toHaveLength(90);
    expect(h.log).not.toContain("skippedEarly");
    expect(h.log).not.toContain("admitPassive");
    expect(h.timers.size).toBe(0);
    expect(h.rafs.size).toBe(1);

    h.passiveDue = Infinity;
    h.now += 1000 / 90;
    h.flushRafs();
    expect(h.rafs.size).toBe(0);
    expect(h.timers.size).toBe(0);
    expect(h.log.filter((entry) => entry === "sample")).toHaveLength(90);
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

  it("samples a due loop settle even when no passive animation deadline exists", () => {
    const h = createHarness();
    h.loopDue = h.now;
    h.passiveDue = Infinity;
    h.bypass = "settle";
    h.scheduler.armAnimation(h.now);
    h.log.length = 0;

    h.flushRafs();

    expect(h.log).toContain("sample");
    expect(h.log).toContain("build");
    expect(h.log).not.toContain("missingPassive");
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

  it("pulls a pending reconcile before texture repaint and skips the repaint when it drew the resource", () => {
    const h = createHarness();
    let pending = true;
    h.scheduler.setReconcilePull({
      pending: () => pending,
      now: () => {
        h.log.push("pull");
        pending = false;
        h.scheduler.noteTexturePresented(h.scheduler.textureDemandGeneration);
      },
    });
    h.scheduler.scheduleTexturePaint();
    h.scheduler.scheduleTexturePaint();
    h.flushRafs();
    expect(h.log).toEqual(["pull"]);
    expect(h.scheduler.pulledReconciles).toBe(1);
    expect(h.scheduler.textureDemandGeneration).toBe(2);
  });

  it("skips texture repaint when the booked scene reconcile ran first", () => {
    const h = createHarness();
    h.scheduler.scheduleTexturePaint();
    const textureHandle = [...h.rafs.keys()][0];
    h.log.push("reconcile");
    h.scheduler.noteTexturePresented(h.scheduler.textureDemandGeneration);
    h.fireRaf(textureHandle);
    expect(h.log).toEqual(["reconcile"]);
  });

  it("skips texture repaint after an animation full build drew the resource", () => {
    const h = createHarness();
    h.loopDue = h.now;
    h.loopPerFrame = true;
    h.bypass = "tween";
    h.scheduler.armAnimation(h.now);
    const animationHandle = [...h.rafs.keys()][0];
    h.scheduler.scheduleTexturePaint();
    const textureHandle = [...h.rafs.keys()][1];
    h.fireRaf(animationHandle);
    h.fireRaf(textureHandle);
    expect(h.log).toContain("build");
    expect(h.log).toContain("paint");
    expect(h.log).not.toContain("texture");
  });

  it("retains newer texture demand arriving during a reconcile and repaints it", () => {
    const h = createHarness();
    h.scheduler.setReconcilePull({
      pending: () => true,
      now: () => {
        const buildingGeneration = h.scheduler.textureDemandGeneration;
        h.log.push("pull");
        h.scheduler.scheduleTexturePaint();
        h.scheduler.noteTexturePresented(buildingGeneration);
      },
    });
    h.scheduler.scheduleTexturePaint();
    h.flushRafs();
    expect(h.log).toEqual(["pull", "texture"]);
    expect(h.scheduler.textureDemandGeneration).toBe(2);
    expect(h.rafs.size).toBe(1); // the arrival during the pull booked the next callback
    h.flushRafs();
    expect(h.log).toEqual(["pull", "texture"]);
  });

  it("keeps demand after a failed or skipped presentation until a later successful one", () => {
    const h = createHarness();
    h.texturePainted = false;
    h.scheduler.scheduleTexturePaint();
    h.flushRafs();
    expect(h.log).toEqual(["texture"]);
    expect(h.rafs.size).toBe(0); // no static-scene retry spin
    h.texturePainted = true;
    h.scheduler.scheduleTexturePaint();
    h.flushRafs();
    expect(h.log).toEqual(["texture", "texture"]);
    h.scheduler.scheduleTexturePaint();
    h.scheduler.noteTexturePresented(h.scheduler.textureDemandGeneration);
    h.flushRafs();
    expect(h.log).toEqual(["texture", "texture"]);
  });

  it("does not count a successful reconcile that left the requested texture out", () => {
    const h = createHarness();
    h.scheduler.setReconcilePull({ pending: () => true, now: () => h.log.push("pull") });
    h.scheduler.scheduleTexturePaint();
    h.flushRafs();
    expect(h.log).toEqual(["pull", "texture"]);
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
