// `rustCoalescedBuilds`: the frame scheduler's build-request demand source. A fake browser runs rAF callbacks in
// booking order, one display frame per task, and drains posted tasks between frames, so lane order inside a frame
// (the animation tick vs. an input lane booked after it) is exactly what a test arranges.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCanvasFrameScheduler, type CanvasPatchSubmission } from "@/mirror/renderer/canvas/frameScheduler";

function createBrowser() {
  let nextHandle = 1;
  const rafs = new Map<number, FrameRequestCallback>();
  const tasks: Array<() => void> = [];
  return {
    rafs,
    tasks,
    requestAnimationFrame(callback: FrameRequestCallback) {
      const handle = nextHandle++;
      rafs.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle: number) { rafs.delete(handle); },
    /** One display frame: every rAF booked before it, in booking order, as one task. Then the queued tasks. */
    frame(now = 0) {
      const due = [...rafs.entries()].sort(([a], [b]) => a - b);
      rafs.clear();
      for (const [, callback] of due) callback(now);
      this.drainTasks();
    },
    drainTasks() {
      while (tasks.length) tasks.shift()!();
    },
  };
}

/** `rustIdleScheduler` for every harness of the current suite run: the epoch semantics must hold both ways. */
let idleSchedulerArm = false;

function createHarness(options: { enabled?: boolean; rampFrames?: number; rampPatchable?: boolean } = {}) {
  const browser = createBrowser();
  const log: string[] = [];
  let rampFramesLeft = options.rampFrames ?? 0;
  let blocked = false;
  let patchWorks = false;
  let passiveDue = Infinity;
  let idleStale = false;
  /** How a submitted patch settles: at once (`commit`/`refuse`), or later through `settlePending` (`async`). */
  let patchMode: "commit" | "refuse" | "async" = "commit";
  const pending: Array<CanvasPatchSubmission | null> = [];
  let reconcilePending = false;
  let revision = 1;
  let revisionAtFrame = 1;
  const builds: Array<{ source: string; frame: number }> = [];
  let frame = 0;
  // eslint-disable-next-line prefer-const
  let scheduler: ReturnType<typeof createCanvasFrameScheduler>;
  const build = (source: string) => {
    if (blocked) { log.push(`${source}:refused`); return false; }
    scheduler.noteFrameWork("build");
    builds.push({ source, frame });
    log.push(source);
    revisionAtFrame = revision;
    return true;
  };
  scheduler = createCanvasFrameScheduler<{ revision: number }>({
    now: () => frame * 16,
    state: () => ({ revision }),
    disposed: () => false,
    revisionAtFrame: () => revisionAtFrame,
    platform: {
      requestAnimationFrame: (callback) => browser.requestAnimationFrame(callback),
      cancelAnimationFrame: (handle) => browser.cancelAnimationFrame(handle),
      setTimeout: null,
      clearTimeout: null,
      postTask: (callback) => { browser.tasks.push(callback); },
      now: () => frame * 16,
    },
    deadlines: {
      offsetRampDeadline: () => rampFramesLeft > 0 ? 1e9 : Infinity,
      loopDeadline: () => Infinity,
      loopHasPerFrameDemand: () => false,
      trailDeadline: () => Infinity,
      passiveDeadline: () => passiveDue,
      idleStageBypass: () => null,
    },
    animation: {
      advanceOffsetRamps: () => {
        if (rampFramesLeft <= 0) return false;
        rampFramesLeft--;
        return true;
      },
      noteIdleStageMissingPassive: () => log.push("skipped"),
      noteIdleStageAdmission: () => {},
      isIdleSampleStale: () => idleStale,
      commitIdleSample: () => { log.push("idle-committed"); },
      sampleVisual: () => {},
      noteTrailFlightHeads: () => {},
      tickTrails: () => {},
      mergeTrailLatches: () => {},
      advanceVisual: () => {},
      tickSpine: () => {},
      tryPatchAndPaint: () => {
        log.push("patch-attempt");
        if (!patchWorks || blocked) return false;
        const submission = scheduler.noteFrameWork("patch");
        if (patchMode === "async") { pending.push(submission); log.push("patch-async"); return false; }
        if (patchMode === "refuse") { scheduler.settlePatch(submission, false, true); log.push("patch-refused"); return false; }
        builds.push({ source: "patch", frame });
        scheduler.settlePatch(submission, true);
        return true;
      },
      runBuild: (_state, requested) => build(requested ? "tick:requested" : "tick"),
      syncOverlay: () => {},
      paintAction: () => true,
      settleLanding: () => {},
      rebuildAndPaintTexture: () => build("texture"),
    },
    rampPatchable: options.rampPatchable,
    idleScheduler: idleSchedulerArm,
    coalesce: {
      enabled: options.enabled ?? true,
      localBuild: () => { build("local"); },
      buildBlocked: () => blocked,
    },
  });
  scheduler.setReconcilePull({
    pending: () => reconcilePending,
    now: () => { reconcilePending = false; build("reconcile"); },
  });
  return {
    browser, scheduler, log, builds,
    /** Advance one display frame. */
    frame() { frame++; browser.frame(frame * 16); },
    /** A lane that builds when it runs (the view's reconcile, say), booked now. */
    bookBuildLane(source: string) { browser.requestAnimationFrame(() => { build(source); }); },
    /** An input lane (flushHover) booked AFTER whatever is already booked for the coming frame. */
    bookInputLane(run: () => void) { browser.requestAnimationFrame(() => run()); },
    /** A streamed delta arrives: the view books its own reconcile rAF and the scheduler can pull it. */
    wireDelta() {
      revision++;
      reconcilePending = true;
      browser.requestAnimationFrame(() => { if (reconcilePending) { reconcilePending = false; build("reconcile"); } });
    },
    set blocked(value: boolean) { blocked = value; },
    /** The renderer's retained patch succeeds (it counts as the frame's one build-or-patch). */
    set patchWorks(value: boolean) { patchWorks = value; },
    set patchMode(value: "commit" | "refuse" | "async") { patchMode = value; },
    set passiveDue(value: number) { passiveDue = value; },
    set idleStale(value: boolean) { idleStale = value; },
    /** The asynchronous patches settle, in a later task (as the renderer's presentation completion does). */
    settlePending(committed: boolean) { for (const submission of pending.splice(0)) scheduler.settlePatch(submission, committed); },
    set rampFrames(value: number) { rampFramesLeft = value; },
    buildsInFrame(index: number) { return builds.filter((entry) => entry.frame === index).map((entry) => entry.source); },
    get frameIndex() { return frame; },
  };
}

for (const idleArm of [false, true]) describe(`frame scheduler build requests (rustCoalescedBuilds, rustIdleScheduler=${idleArm ? 1 : 0})`, () => {
  beforeEach(() => { idleSchedulerArm = idleArm; });
  afterEach(() => { idleSchedulerArm = false; });

  it("serves an input request, a ramp and a streamed delta with one build when the tick runs first", () => {
    const h = createHarness({ rampFrames: 10 });
    h.scheduler.armAnimation(0);
    h.frame(); // the ramp's first frame: the tick builds and re-books itself for the next frame
    expect(h.buildsInFrame(1)).toEqual(["tick"]);

    // Between frames: a delta arrives and the finger lifts the held card.
    h.wireDelta();
    expect(h.scheduler.requestBuild(true)).toBe("deferred"); // the booked tick paints before the browser does
    h.frame();
    // The tick pulls the reconcile, which is the one build and serves the request.
    expect(h.buildsInFrame(2)).toEqual(["reconcile"]);
    expect(h.scheduler.buildRequested).toBe(false);
  });

  it("lets a late non-urgent request in the same frame wait for the next tick", () => {
    const h = createHarness({ rampFrames: 10 });
    h.scheduler.armAnimation(0);
    h.frame();
    // flushHover booked after the tick's own re-arm runs after it in the next frame: a ramp-only raise change.
    h.bookInputLane(() => { expect(h.scheduler.requestBuild(false)).toBe("deferred"); });
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["tick"]);
    expect(h.scheduler.buildRequested).toBe(true);
    h.frame();
    expect(h.buildsInFrame(3)).toEqual(["tick:requested"]);
    const stats = h.scheduler.coalesceStats()!;
    expect(stats.workPerFrame["2"]).toBe(0);
    expect(stats.maxWorkPerFrame).toBe(1);
  });

  it("builds a late urgent request at once, in the frame it would have built in before", () => {
    const h = createHarness({ rampFrames: 10 });
    h.scheduler.armAnimation(0);
    h.frame();
    h.bookInputLane(() => { expect(h.scheduler.requestBuild(true)).toBe("immediate"); });
    h.frame();
    // The lift presents this frame, as the synchronous build did; it is the only path to a second build.
    expect(h.buildsInFrame(2)).toEqual(["tick", "local"]);
    expect(h.scheduler.coalesceStats()!.urgentExtraBuilds).toBe(1);
  });

  it("builds a request at once when no tick is coming (an idle scene)", () => {
    const h = createHarness();
    h.scheduler.armAnimation(0);
    // An idle scene: nothing books a tick, so a lift from the input lane must build in that lane.
    h.bookInputLane(() => { expect(h.scheduler.requestBuild(false)).toBe("immediate"); });
    h.frame();
    expect(h.buildsInFrame(1)).toEqual(["local"]);
  });

  it("serves a request raised before the tick in the same frame from that tick, with no patch attempt", () => {
    const h = createHarness();
    h.scheduler.requestBuild(false); // an idle scene: builds now and books nothing
    h.frame();
    h.rampFrames = 3;
    h.scheduler.armAnimation(0); // a ramp declared between frames books the coming tick
    h.browser.drainTasks();
    // A pointer event, a task of its own before the frame: the booked tick will run before the browser paints.
    expect(h.scheduler.requestBuild(true)).toBe("deferred");
    h.log.length = 0;
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["tick:requested"]);
    expect(h.log).not.toContain("patch-attempt");
  });

  it("does not build again in a frame whose reconcile already built, and resumes the next frame", () => {
    const h = createHarness();
    h.wireDelta(); // the view's reconcile lane, booked before the animation tick this time
    h.rampFrames = 5;
    h.scheduler.armAnimation(0);
    h.browser.drainTasks();
    h.frame();
    expect(h.buildsInFrame(1)).toEqual(["reconcile"]);
    expect(h.scheduler.coalesceStats()!.tickYields).toBe(1);
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["tick"]);
  });

  it("skips a texture repaint that a full build earlier in the frame drew, but not a later arrival", () => {
    const h = createHarness();
    h.wireDelta(); // a delta's reconcile lane runs first in the frame...
    h.scheduler.scheduleTexturePaint(); // ...then the lane of a texture that became resident before the frame
    h.frame();
    expect(h.buildsInFrame(1)).toEqual(["reconcile"]);
    expect(h.scheduler.coalesceStats()!.textureYields).toBe(1);
    // A texture that becomes resident AFTER the frame's build, before its booked lane runs, is still painted.
    h.wireDelta();
    h.bookInputLane(() => h.scheduler.scheduleTexturePaint());
    h.scheduler.scheduleTexturePaint();
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["reconcile", "texture"]);
    expect(h.scheduler.coalesceStats()!.textureYields).toBe(1);
  });

  it("draws a ramp's final step that landed in a frame which had already built", () => {
    const h = createHarness();
    h.rampFrames = 2;
    // A lane that runs before the tick in frame 1 books a building lane for frame 2 ahead of the tick's re-arm.
    h.bookInputLane(() => h.bookBuildLane("reconcile"));
    h.scheduler.armAnimation(0);
    h.frame();
    expect(h.buildsInFrame(1)).toEqual(["tick"]);
    // Frame 2: that lane builds first, so the tick yields after advancing the ramp to its end, which drops its
    // deadline, the only demand left.
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["reconcile"]);
    expect(h.scheduler.coalesceStats()!.tickYields).toBe(1);
    // The carried step is still drawn on the next frame, and nothing runs after it.
    h.frame();
    expect(h.buildsInFrame(3)).toEqual(["tick"]);
    h.frame();
    expect(h.buildsInFrame(4)).toEqual([]);
    expect(h.browser.rafs.size).toBe(0);
  });

  it("does not yield the tick to a build from an earlier frame whose epoch close has not run", () => {
    const h = createHarness();
    h.frame();
    // A pointer task on an idle stage builds an urgent lift at once...
    expect(h.scheduler.requestBuild(true)).toBe("immediate");
    // ...a ramp starts, and the browser renders the next frame before the posted close runs.
    h.browser.drainTasks = () => {};
    h.rampFrames = 3;
    h.scheduler.armAnimation(0);
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["tick"]);
    expect(h.scheduler.coalesceStats()!.tickYields).toBe(0);
  });

  it("lets a moved ramp and an offset-only request be patched under rustOffsetPatch, and nothing else", () => {
    const h = createHarness({ rampFrames: 3, rampPatchable: true });
    h.patchWorks = true;
    h.scheduler.armAnimation(0);
    h.frame();
    expect(h.buildsInFrame(1)).toEqual(["patch"]);
    // An offset-only request is served by the frame's patch and does not linger.
    expect(h.scheduler.requestBuild(false, true)).toBe("deferred");
    expect(h.scheduler.buildRequired).toBe(false);
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["patch"]);
    expect(h.scheduler.buildRequested).toBe(false);
    // A request that is not offset-only still needs a full build.
    h.scheduler.requestBuild(false);
    expect(h.scheduler.buildRequired).toBe(true);
    h.frame();
    expect(h.buildsInFrame(3)).toEqual(["tick:requested"]);
  });

  it("draws a ramp's last step and a trailing offset again when their asynchronous patch is lost", () => {
    const h = createHarness({ rampFrames: 1, rampPatchable: true });
    h.patchWorks = true;
    h.patchMode = "async";
    h.scheduler.armAnimation(0);
    h.frame(); // the ramp's last step: its deadline is gone once the tick advanced it
    expect(h.log.filter((entry) => entry === "patch-async").length).toBe(1);
    expect(h.browser.rafs.size).toBe(0);
    h.settlePending(false); // superseded: nothing drew the step
    expect(h.scheduler.carryPending).toBe(true);
    expect(h.browser.rafs.size).toBe(1);
    h.patchMode = "commit";
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["patch"]);
    expect(h.scheduler.carryPending).toBe(false);
    // An offset-only request served by a patch that is then refused is open again, and the next frame serves it.
    h.patchMode = "async";
    h.rampFrames = 1;
    h.scheduler.armAnimation(0);
    h.browser.drainTasks(); // the booking task ends: the tick is now ahead of the request, which waits for it
    expect(h.scheduler.requestBuild(false, true)).toBe("deferred");
    h.frame();
    expect(h.scheduler.buildRequested).toBe(false);
    h.settlePending(false);
    expect(h.scheduler.buildRequested).toBe(true);
    expect(h.scheduler.buildRequired).toBe(false);
    h.patchMode = "commit";
    h.frame();
    expect(h.buildsInFrame(4)).toEqual(["patch"]);
    expect(h.scheduler.buildRequested).toBe(false);
    const stats = h.scheduler.coalesceStats()!;
    expect(stats.lostPatches).toBe(2);
    expect(stats.rampPatches).toBe(0); // both ramp patches were lost; the frames that redrew them are no ramp steps
  });

  it("counts a synchronously refused patch neither as its frame's work nor as a ramp patch", () => {
    const h = createHarness({ rampFrames: 2, rampPatchable: true });
    h.patchWorks = true;
    h.patchMode = "refuse";
    h.scheduler.armAnimation(0);
    h.frame();
    expect(h.buildsInFrame(1)).toEqual(["tick"]);
    h.patchMode = "commit";
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["patch"]);
    const stats = h.scheduler.coalesceStats()!;
    expect(stats.rampPatches).toBe(1);
    expect(stats.lostPatches).toBe(1);
    expect(stats.workPerFrame["2"]).toBe(0);
  });

  it("books a frame when a patch is lost in the lane that submitted it", () => {
    const h = createHarness({ rampPatchable: true });
    h.patchWorks = true;
    // A reconcile lane (no tick booked after it) whose patch is superseded at submission: nothing in that task
    // builds, so the loss itself must book the redraw of what the patch would have carried.
    h.bookInputLane(() => {
      const submission = h.scheduler.noteFrameWork("patch");
      h.scheduler.settlePatch(submission, false);
    });
    h.frame();
    expect(h.scheduler.carryPending).toBe(true);
    expect(h.browser.rafs.size).toBe(1);
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["patch"]);
  });

  it("books no frame for a synchronous refusal that its caller's own build follows", () => {
    const h = createHarness({ rampPatchable: true });
    h.bookInputLane(() => {
      const submission = h.scheduler.noteFrameWork("patch");
      h.scheduler.settlePatch(submission, false, true);
      h.scheduler.noteFrameWork("build"); // the caller's build draws everything the patch carried
    });
    h.frame();
    expect(h.scheduler.carryPending).toBe(false);
    expect(h.browser.rafs.size).toBe(0);
  });

  it("skips a ramp patch while a presentation is in flight and lets the settlement re-arm the carried frame", () => {
    const h = createHarness({ rampFrames: 1, rampPatchable: true });
    h.patchWorks = true;
    h.blocked = true;
    h.scheduler.armAnimation(0);
    h.frame();
    expect(h.log).not.toContain("patch-attempt");
    expect(h.scheduler.carryPending).toBe(true);
    // No frame spins while the presentation is in flight.
    expect(h.browser.rafs.size).toBe(0);
    expect(h.scheduler.coalesceStats()!.blockedPatchYields).toBe(1);
    h.blocked = false;
    h.scheduler.armAnimation(0); // the settlement's re-arm
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["patch"]);
  });

  it("keeps forcing a build for a moved ramp without rustOffsetPatch", () => {
    const h = createHarness({ rampFrames: 2 });
    h.patchWorks = true;
    h.scheduler.armAnimation(0);
    h.frame();
    expect(h.buildsInFrame(1)).toEqual(["tick"]);
    expect(h.scheduler.requestBuild(false, true)).toBe("deferred");
    expect(h.scheduler.buildRequired).toBe(true);
  });

  it("keeps a request through an in-flight presentation and serves it once that settles", () => {
    const h = createHarness();
    h.blocked = true;
    expect(h.scheduler.requestBuild(true)).toBe("deferred");
    // Blocked: no frame is booked for it, so nothing retries a build the executor would refuse.
    expect(h.browser.rafs.size).toBe(0);
    h.frame();
    expect(h.builds).toEqual([]);
    // The presentation settles and re-arms, as the renderer's completion does.
    h.blocked = false;
    h.scheduler.armAnimation(0);
    h.frame();
    expect(h.buildsInFrame(2)).toEqual(["tick:requested"]);
    expect(h.scheduler.buildRequested).toBe(false);
    expect(h.scheduler.coalesceStats()!.blockedRequests).toBe(1);
  });

  it("pulls a booked reconcile into an immediate request so one build serves both", () => {
    const h = createHarness();
    h.wireDelta();
    expect(h.scheduler.requestBuild(true)).toBe("immediate");
    expect(h.builds.map((entry) => entry.source)).toEqual(["reconcile"]);
    h.frame();
    expect(h.builds.map((entry) => entry.source)).toEqual(["reconcile"]);
  });

  it("closes a frame epoch after its task, and at the next tick when that close runs late", () => {
    const h = createHarness({ rampFrames: 10 });
    h.scheduler.armAnimation(0);
    const before = h.scheduler.frameTask;
    h.frame();
    expect(h.scheduler.frameTask).toBeGreaterThan(before);
    // The close is delayed past the next frame: the tick still starts a new epoch.
    const tasks = h.browser.tasks;
    h.browser.drainTasks = () => {};
    h.frame();
    h.frame();
    expect(h.scheduler.coalesceStats()!.staleTaskCloses).toBeGreaterThan(0);
    expect(h.scheduler.coalesceStats()!.maxWorkPerFrame).toBe(1);
    tasks.length = 0;
  });

  it("only counts work when the switch is off", () => {
    const h = createHarness({ enabled: false, rampFrames: 2 });
    h.scheduler.armAnimation(0);
    h.frame();
    h.frame();
    const stats = h.scheduler.coalesceStats()!;
    expect(stats.enabled).toBe(false);
    expect(stats.requests).toBe(0);
    expect(stats.workPerFrame["1"]).toBe(2);
  });

  // No authored cadence cap (WP7): an idle-only tick is always booked, so a pinned diagnostic clock would
  // otherwise resample and retry a blocked admission on every one of those bookings forever — an empty rAF
  // booked every vsync is polling-shaped, and this scheduler's contract forbids it. A stale tick must post no
  // epoch close and must NOT re-arm: the chain goes fully quiet until something external (the diagnostic
  // clock mover, in production) calls `armAnimation` again.
  it("a stale idle tick posts no epoch close and does not re-arm, so the chain goes fully quiet", () => {
    const h = createHarness();
    h.passiveDue = 0; // idle-only and due now
    h.idleStale = true;
    h.scheduler.armAnimation(0);
    expect(h.browser.rafs.size).toBe(1); // booked: staleness is checked once the tick runs, not when it's booked
    const closesBefore = h.scheduler.coalesceStats()!.closesPosted;
    h.frame();
    // Neither sampled, patched nor built, and not committed as an accepted idle frame either.
    expect(h.log).toEqual([]);
    expect(h.builds).toEqual([]);
    // No re-arm: the chain is fully quiet, not retrying every display frame.
    expect(h.browser.rafs.size).toBe(0);
    // No close from this tick (only the bring-up booking's, already counted before it ran).
    expect(h.scheduler.coalesceStats()!.closesPosted).toBe(closesBefore);
  });
});
