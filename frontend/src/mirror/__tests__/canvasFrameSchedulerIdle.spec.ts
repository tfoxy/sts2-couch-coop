// `rustIdleScheduler`: one browser task per steady idle frame. A small event loop drives the scheduler: display
// frames at a fixed period run every booked rAF as ONE task (callbacks see the vsync timestamp, and `now` is a little
// later), timers fire as tasks of their own at their due time, and a posted task runs right after the task that
// posted it. The renderer model is the Rust stage's idle path: a 30 Hz authored cadence under the 60 Hz passive gate,
// and every admitted frame presents through a retained patch.
import { describe, expect, it } from "vitest";

import { CANVAS_FRAME_PARK_SLOP_MS, createCanvasFrameScheduler } from "@/mirror/renderer/canvas/frameScheduler";

interface LoopOptions {
  idleScheduler: boolean;
  periodMs?: number;
  /** rAF callback start after the vsync timestamp, per frame index. */
  delay?: (frame: number) => number;
  /** Patch cost on the scheduler clock. */
  work?: (frame: number) => number;
  /** The `idleCadence=display` comparison arm: passive demand is due on every display frame. */
  displayPacedPassive?: boolean;
}

function createIdleLoop(options: LoopOptions) {
  const periodMs = options.periodMs ?? 1000 / 60;
  const delay = options.delay ?? (() => 1);
  const work = options.work ?? (() => 3);
  let now = 0;
  let vsyncIndex = 0;
  let nextHandle = 1;
  const rafs = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { at: number; callback: () => void; external?: boolean }>();
  const posted: Array<() => void> = [];
  const census = { rafTasks: 0, timerTasks: 0, postedTasks: 0, otherTasks: 0, displayFrames: 0 };
  /** Tasks run per display frame index (rAF, timers and posted tasks between this vsync and the next). */
  const tasksPerFrame = new Map<number, number>();
  const noteTask = () => tasksPerFrame.set(vsyncIndex, (tasksPerFrame.get(vsyncIndex) ?? 0) + 1);
  const presented: number[] = [];
  const presentedVsync: number[] = [];
  const builds: Array<{ source: string; vsync: number }> = [];
  let lastIdleAt = 0;
  let notBefore = 0;
  let idleActive = true;
  let revision = 1;
  let revisionAtFrame = 1;
  let reconcilePending = false;
  let onPatch: (() => void) | null = null;

  function drainPosted() {
    while (posted.length) {
      census.postedTasks++;
      noteTask();
      posted.shift()!();
    }
  }
  function runTask(kind: "rafTasks" | "timerTasks" | "otherTasks", body: () => void) {
    census[kind]++;
    noteTask();
    body();
    drainPosted();
  }

  // eslint-disable-next-line prefer-const
  let scheduler: ReturnType<typeof createCanvasFrameScheduler>;
  const build = (source: string) => {
    scheduler.noteFrameWork("build");
    builds.push({ source, vsync: vsyncIndex });
    revisionAtFrame = revision;
    return true;
  };
  scheduler = createCanvasFrameScheduler<{ revision: number }>({
    now: () => now,
    state: () => ({ revision }),
    disposed: () => false,
    revisionAtFrame: () => revisionAtFrame,
    idleAnimFps: () => 30,
    idleScheduler: options.idleScheduler,
    displayPacedPassive: options.displayPacedPassive,
    platform: {
      requestAnimationFrame: (callback) => { const handle = nextHandle++; rafs.set(handle, callback); return handle; },
      cancelAnimationFrame: (handle) => { rafs.delete(handle); },
      setTimeout: (callback, delayMs) => {
        const handle = nextHandle++;
        timers.set(handle, { at: now + delayMs, callback });
        return handle as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle) => { timers.delete(handle as unknown as number); },
      postTask: (callback) => { posted.push(callback); },
      now: () => now,
    },
    deadlines: {
      offsetRampDeadline: () => Infinity,
      loopDeadline: () => Infinity,
      loopHasPerFrameDemand: () => false,
      trailDeadline: () => Infinity,
      // createPixiMirrorRenderer's passive deadline: the authored cadence, never ahead of the 60 Hz stage gate.
      passiveDeadline: (at) => !idleActive ? Infinity
        : options.displayPacedPassive ? at : Math.max(lastIdleAt + 1000 / 30, notBefore),
      idleStageBypass: () => null,
      idleStageNotBefore: () => notBefore,
    },
    animation: {
      advanceOffsetRamps: () => false,
      noteIdleStageMissingPassive: () => {},
      noteIdleStageSkippedEarly: () => {},
      // visualState.noteIdleStageAdmission
      noteIdleStageAdmission: (at, minFrameMs) => {
        const nextPhase = notBefore + minFrameMs;
        notBefore = notBefore > 0 && at < nextPhase ? nextPhase : at + minFrameMs;
      },
      sampleVisual: (at) => { if (idleActive) lastIdleAt = at; },
      noteTrailFlightHeads: () => {},
      tickTrails: () => {},
      mergeTrailLatches: () => {},
      advanceVisual: () => {},
      tickSpine: () => {},
      tryPatchAndPaint: (at) => {
        const submission = scheduler.noteFrameWork("patch");
        onPatch?.();
        onPatch = null;
        now += work(vsyncIndex);
        scheduler.settlePatch(submission, true);
        presented.push(at);
        presentedVsync.push(vsyncIndex);
        builds.push({ source: "patch", vsync: vsyncIndex });
        return true;
      },
      runBuild: (_state, requested) => { presented.push(now); presentedVsync.push(vsyncIndex); return build(requested ? "tick:requested" : "tick"); },
      syncOverlay: () => {},
      paintAction: () => true,
      settleLanding: () => {},
      rebuildAndPaintTexture: () => build("texture"),
    },
    coalesce: { enabled: true, localBuild: () => { build("local"); }, buildBlocked: () => false },
  });
  scheduler.setReconcilePull({
    pending: () => reconcilePending,
    now: () => { reconcilePending = false; build("reconcile"); },
  });

  /** Run every task due up to and including display frame `index`'s rAF task. */
  function runUntilVsync(index: number) {
    while (vsyncIndex < index) {
      const nextVsync = (vsyncIndex + 1) * periodMs;
      const timer = [...timers.entries()].sort(([, a], [, b]) => a.at - b.at)[0];
      if (timer && timer[1].at <= nextVsync) {
        timers.delete(timer[0]);
        now = Math.max(now, timer[1].at);
        runTask(timer[1].external ? "otherTasks" : "timerTasks", timer[1].callback);
        continue;
      }
      vsyncIndex++;
      census.displayFrames++;
      now = Math.max(now, nextVsync + delay(vsyncIndex));
      if (rafs.size === 0) continue;
      const due = [...rafs.entries()].sort(([a], [b]) => a - b);
      rafs.clear();
      runTask("rafTasks", () => { for (const [, callback] of due) callback(nextVsync); });
    }
  }

  return {
    scheduler, census, tasksPerFrame, presented, presentedVsync, builds, posted, timers,
    runUntilVsync,
    get vsync() { return vsyncIndex; },
    get now() { return now; },
    set idleActive(value: boolean) { idleActive = value; },
    /** Run once inside the next patch (a texture turning resident while the tick paints, say). */
    set onPatch(value: () => void) { onPatch = value; },
    /** A lane (flushHover, say) booked now: in the coming frame it runs after anything booked before it. */
    bookLane(run: () => void) { const handle = nextHandle++; rafs.set(handle, () => run()); },
    /** A task between display frames (a pointer event, a socket message) at `at`. */
    taskAt(at: number, body: () => void) {
      const handle = nextHandle++;
      timers.set(handle, { at, callback: body, external: true });
    },
    wireDelta() {
      revision++;
      reconcilePending = true;
      const handle = nextHandle++;
      rafs.set(handle, () => { if (reconcilePending) { reconcilePending = false; build("reconcile"); } });
    },
    /** A task of its own, now (with whatever it posts). */
    task(body: () => void) { runTask("otherTasks", body); },
    resetCensus() {
      for (const key of Object.keys(census) as Array<keyof typeof census>) census[key] = 0;
      tasksPerFrame.clear();
    },
    buildsAt(vsync: number) { return builds.filter((entry) => entry.vsync === vsync).map((entry) => entry.source); },
    /** The most builds plus patches any one display frame presented, counted by the loop itself. */
    maxWorkInAnyFrame() {
      const perFrame = new Map<number, number>();
      for (const entry of builds) perFrame.set(entry.vsync, (perFrame.get(entry.vsync) ?? 0) + 1);
      return Math.max(0, ...perFrame.values());
    },
    periodMs,
  };
}

/** Bring a 30 Hz idle scene up and run it for `vsyncs` display frames. */
function steadyIdle(options: LoopOptions, vsyncs: number) {
  const loop = createIdleLoop(options);
  // The bring-up booking comes from outside a tick and posts its close as before; count from the first frame on.
  loop.task(() => loop.scheduler.armAnimation(loop.now));
  loop.resetCensus();
  loop.runUntilVsync(vsyncs);
  return loop;
}

describe("frame scheduler idle cadence (rustIdleScheduler)", () => {
  it("runs a steady 60 Hz idle frame as one rAF task: no park timer and no posted close", () => {
    const on = steadyIdle({ idleScheduler: true }, 240);
    const off = steadyIdle({ idleScheduler: false }, 240);
    // Off: per presented frame, the rAF, the park timer and a posted close after each of them.
    expect(off.presented.length).toBe(120);
    expect(off.census.timerTasks).toBeGreaterThanOrEqual(119);
    expect(off.census.postedTasks).toBeGreaterThanOrEqual(2 * 119);
    // On: only rAF tasks, never more than one per display frame.
    expect(on.census.timerTasks).toBe(0);
    expect(on.census.postedTasks).toBe(0);
    expect(on.posted).toHaveLength(0);
    expect(Math.max(...on.tasksPerFrame.values())).toBe(1);
    const stats = on.scheduler.idleStats();
    expect(stats.enabled).toBe(true);
    expect(stats.parkTimers).toBe(0);
    expect(stats.folds).toBeGreaterThan(200);
    expect(on.scheduler.coalesceStats()!.closesPosted).toBe(1); // the bring-up booking's, outside any tick
    expect(on.scheduler.coalesceStats()!.idleEpochEnds).toBe(on.presented.length);
    expect(off.scheduler.idleStats().folds).toBe(0);
  });

  it("presents exactly the frames the timer path does: same count, same times, a 30 Hz cadence", () => {
    const on = steadyIdle({ idleScheduler: true }, 600);
    const off = steadyIdle({ idleScheduler: false }, 600);
    expect(on.presented).toEqual(off.presented);
    expect(on.presentedVsync).toEqual(off.presentedVsync);
    // Every other display frame, no drift over 300 frames.
    const gaps = on.presentedVsync.slice(1).map((vsync, i) => vsync - on.presentedVsync[i]);
    expect(new Set(gaps)).toEqual(new Set([2]));
    expect(on.presented.length).toBe(300);
    // Each presented frame is one build or patch: the epoch semantics count it so.
    const coalesce = on.scheduler.coalesceStats()!;
    expect(coalesce.maxWorkPerFrame).toBe(1);
    expect(coalesce.workPerFrame["1"]).toBeGreaterThanOrEqual(299); // the last frame's census is still open
  });

  it("never admits an idle frame before the timer's wake time under jittery callbacks and work", () => {
    const jitter = (seed: number) => (frame: number) => ((frame * 7919 + seed) % 97) / 97;
    const delay = (frame: number) => 0.2 + 3.5 * jitter(13)(frame);
    const work = (frame: number) => 1 + 9 * jitter(29)(frame);
    const on = steadyIdle({ idleScheduler: true, delay, work }, 900);
    const off = steadyIdle({ idleScheduler: false, delay, work }, 900);
    const minGap = (times: number[]) => Math.min(...times.slice(1).map((at, i) => at - times[i]));
    expect(minGap(on.presented)).toBeGreaterThanOrEqual(1000 / 30 - CANVAS_FRAME_PARK_SLOP_MS);
    expect(minGap(off.presented)).toBeGreaterThanOrEqual(1000 / 30 - CANVAS_FRAME_PARK_SLOP_MS);
    // No extra frames: never more than one presented frame per two display frames.
    const vsyncGaps = on.presentedVsync.slice(1).map((vsync, i) => vsync - on.presentedVsync[i]);
    expect(Math.min(...vsyncGaps)).toBeGreaterThanOrEqual(2);
    expect(on.presented.length).toBeLessThanOrEqual(450);
    expect(on.presented.length).toBeGreaterThanOrEqual(off.presented.length);
    expect(on.census.timerTasks).toBe(0);
    expect(on.census.postedTasks).toBe(0);
  });

  it("keeps parking at 120 Hz, where folding would cost three skipped rAFs, and posts no close there either", () => {
    const on = steadyIdle({ idleScheduler: true, periodMs: 1000 / 120 }, 480);
    const off = steadyIdle({ idleScheduler: false, periodMs: 1000 / 120 }, 480);
    expect(on.presentedVsync).toEqual(off.presentedVsync);
    const stats = on.scheduler.idleStats();
    expect(stats.displayFrameMs).toBeCloseTo(1000 / 120, 6);
    // Only the first frames fold, while the display period is still the 60 Hz default estimate.
    expect(stats.folds).toBeLessThanOrEqual(6);
    expect(on.census.timerTasks).toBeGreaterThan(110);
    // One task besides the rAF per presented frame (the park timer); the posted closes are gone.
    expect(on.census.postedTasks).toBe(0);
    expect(on.scheduler.coalesceStats()!.parkEpochEnds).toBeGreaterThan(110);
    expect(off.census.postedTasks).toBeGreaterThan(2 * 110);
  });

  it("presents a first lift raised in a lane after the idle tick in that same frame", () => {
    const loop = steadyIdle({ idleScheduler: true }, 20);
    // The idle tick for frame 22 runs first; a pointer lane booked after its booking runs after it.
    loop.runUntilVsync(21);
    expect(loop.buildsAt(21)).toEqual([]);
    let answer = "";
    loop.bookLane(() => { answer = loop.scheduler.requestBuild(true); });
    loop.runUntilVsync(22);
    expect(loop.buildsAt(22)).toEqual(["patch", "local"]);
    expect(answer).toBe("immediate");
    // The census counts the frame, not the epoch: the lift is the frame's allowed second build.
    loop.runUntilVsync(24);
    const stats = loop.scheduler.coalesceStats()!;
    expect(stats.urgentExtraBuilds).toBe(1);
    expect(stats.workPerFrame["2"]).toBe(1);
  });

  it("lets a non-urgent request in a later task wait for the booked tick: one build or patch per frame", () => {
    const loop = steadyIdle({ idleScheduler: true }, 20);
    // Frame 20 presented an idle patch and booked frame 21's tick. A raise toggle arrives between the frames.
    let answer = "";
    loop.taskAt(loop.now + 5, () => { answer = loop.scheduler.requestBuild(false); });
    loop.runUntilVsync(21);
    expect(answer).toBe("deferred");
    expect(loop.buildsAt(21)).toEqual(["tick:requested"]);
    loop.runUntilVsync(60);
    expect(loop.scheduler.coalesceStats()!.maxWorkPerFrame).toBe(1);
    // The idle cadence resumes on the timerless chain.
    expect(loop.census.timerTasks).toBe(0);
  });

  it("builds an urgent request in a later task at once, as with the posted close", () => {
    const loop = steadyIdle({ idleScheduler: true }, 20);
    let answer = "";
    loop.taskAt(loop.now + 5, () => { answer = loop.scheduler.requestBuild(true); });
    loop.runUntilVsync(21);
    expect(answer).toBe("immediate");
    expect(loop.builds.some((entry) => entry.source === "local")).toBe(true);
  });

  it("keeps the posted close when a texture repaint is still to run in the idle tick's frame", () => {
    const loop = steadyIdle({ idleScheduler: true }, 20);
    loop.runUntilVsync(21);
    loop.scheduler.scheduleTexturePaint(); // booked after the tick's own booking: runs after it in frame 22
    loop.runUntilVsync(22);
    expect(loop.buildsAt(22)).toEqual(["patch", "texture"]);
    expect(loop.scheduler.coalesceStats()!.closesPosted).toBe(2); // bring-up, then this frame's
    // The repaint sees the tick's patch in its frame: the epoch counts both, as with the posted close.
    expect(loop.scheduler.coalesceStats()!.workPerFrame["2"]).toBe(1);
  });

  it("lets a streamed delta's reconcile be pulled by the tick, then resumes the timerless idle chain", () => {
    const loop = steadyIdle({ idleScheduler: true }, 20);
    loop.taskAt(loop.now + 5, () => loop.wireDelta());
    loop.runUntilVsync(30);
    // The reconcile lane was booked after the chain's tick, which pulled it: one build, in the next frame.
    expect(loop.builds.filter((entry) => entry.source === "reconcile")).toHaveLength(1);
    expect(loop.scheduler.coalesceStats()!.maxWorkPerFrame).toBe(1);
    const timersBefore = loop.census.timerTasks;
    loop.runUntilVsync(90);
    expect(loop.census.timerTasks).toBe(timersBefore);
  });

  it("stops the chain when the idle animation ends", () => {
    const loop = steadyIdle({ idleScheduler: true }, 20);
    loop.idleActive = false;
    loop.runUntilVsync(24);
    const tasks = loop.census.rafTasks;
    loop.runUntilVsync(60);
    expect(loop.census.rafTasks).toBe(tasks);
    expect(loop.timers.size).toBe(0);
  });

  for (const display of [
    { name: "60 Hz", periodMs: 1000 / 60, work: 3 },
    { name: "90 Hz, short work (parks)", periodMs: 1000 / 90, work: 3 },
    { name: "90 Hz, phone-length work (folds)", periodMs: 1000 / 90, work: 9 },
    { name: "120 Hz", periodMs: 1000 / 120, work: 3 },
  ]) {
    for (const idleScheduler of [true, false]) {
      it(`keeps one build or patch per display frame with lanes the scheduler does not know of (${display.name}, ${idleScheduler ? "on" : "off"})`, () => {
        const loop = createIdleLoop({ idleScheduler, periodMs: display.periodMs, work: () => display.work });
        loop.task(() => loop.scheduler.armAnimation(loop.now));
        // A pointer task between frames books an offset lane (interactionRuntime's armOffsetFrame), which asks for a
        // non-urgent offset-only build. Across phases it lands before or after the idle tick in its frame.
        for (let vsync = 13; vsync < 400; vsync += 7) {
          const at = vsync * display.periodMs + display.periodMs * (0.3 + 0.1 * (vsync % 7));
          loop.taskAt(at, () => loop.bookLane(() => { loop.scheduler.requestBuild(false, true); }));
        }
        loop.runUntilVsync(420);
        expect(loop.maxWorkInAnyFrame()).toBe(1);
        expect(loop.scheduler.buildRequested).toBe(false);
        expect(loop.builds.filter((entry) => entry.source === "tick:requested" || entry.source === "local").length)
          .toBeGreaterThan(40);
        // Only the requests' own epochs post (about two closes per request); no idle frame does.
        if (idleScheduler) expect(loop.census.postedTasks).toBeLessThan(2 * 57 + 8);
      });
    }
  }

  it("leaves a parked idle tick's epoch for its park wake to end (90 Hz)", () => {
    const loop = steadyIdle({ idleScheduler: true, periodMs: 1000 / 90 }, 360);
    const coalesce = loop.scheduler.coalesceStats()!;
    expect(coalesce.parkedIdleEpochs).toBeGreaterThan(100);
    expect(coalesce.idleEpochEnds).toBeLessThan(4);
    expect(loop.census.postedTasks).toBe(0);
    expect(coalesce.maxWorkPerFrame).toBe(1);
    expect(coalesce.workPerFrame["1"]).toBeGreaterThanOrEqual(loop.presented.length - 1);
  });

  it("posts the close for a plain display booking (idleCadence=display), so a lift between frames waits for it", () => {
    const loop = steadyIdle({ idleScheduler: true, displayPacedPassive: true }, 20);
    let answer = "";
    loop.taskAt(loop.now + 5, () => { answer = loop.scheduler.requestBuild(true); });
    loop.runUntilVsync(30);
    expect(answer).toBe("deferred");
    expect(loop.maxWorkInAnyFrame()).toBe(1);
    expect(loop.scheduler.coalesceStats()!.idleEpochEnds).toBe(0);
  });

  it("ends the epoch of a folded tick that booked a texture repaint for the next frame", () => {
    const loop = steadyIdle({ idleScheduler: true }, 20);
    loop.runUntilVsync(21);
    const before = loop.scheduler.coalesceStats()!;
    // A texture becomes resident while the tick paints: its repaint runs next frame, not after the tick.
    loop.onPatch = () => loop.scheduler.scheduleTexturePaint();
    loop.runUntilVsync(22);
    const after = loop.scheduler.coalesceStats()!;
    expect(loop.buildsAt(22)).toEqual(["patch"]);
    expect(after.closesPosted).toBe(before.closesPosted);
    expect(after.idleEpochEnds).toBe(before.idleEpochEnds + 1);
    loop.runUntilVsync(23);
    expect(loop.buildsAt(23)).toEqual(["texture"]);
  });
});
