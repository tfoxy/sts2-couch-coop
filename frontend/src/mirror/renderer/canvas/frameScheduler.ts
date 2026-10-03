/**
 * Canvas animation / deadline scheduler.
 *
 * A canvas renderer has two kinds of repaint that must never share an
 * acknowledgement path:
 *
 * - animation work is display-aligned and may be parked until its next useful
 *   deadline; and
 * - a texture becoming resident gets one independent, coalesced repaint.
 *
 * The composer owns scene state, offsets and actual
 * rendering. This runtime owns the scheduling state and the ordering of an
 * animation callback, so those concerns cannot quietly grow another rAF in a
 * resource callback.
 *
 * The scheduler has deliberately narrow authority:
 *
 * - a pending animation rAF is always earlier than a newly computed timer
 *   deadline, and is therefore never cancelled or replaced;
 * - a timer represents one true future deadline and, when it wakes, chains to
 *   exactly one display-aligned animation rAF; and
 * - resource residency uses its own coalesced rAF. It may repaint a scene, but
 *   it can pull a pending scene reconcile, which owns any scene acknowledgement.
 *
 * This is also the home of schedule/cadence diagnostics. Measuring the rAF
 * handoff and the actual idle-frame period beside the handle state means a
 * caller cannot accidentally omit a newly introduced wakeup from the census.
 *
 * ONE BUILD PER FRAME (`rustCoalescedBuilds`, opt-in through `ports.coalesce`).
 * A client-only change (held-card lift, hand-raise toggle, stretch, chrome) used
 * to build synchronously wherever it was raised, so a frame could build in the
 * input lane, in the animation tick and again in the wire reconcile. With
 * coalescing such a change is a *build request*, a demand source of its own:
 *
 * - a tick still booked ahead of this frame's paint serves it (no latency: the
 *   browser runs that tick before it paints);
 * - otherwise, if this frame already built or patched and the change is not
 *   urgent, the next tick serves it (a ramp sample the tick redraws anyway);
 * - otherwise it builds now, exactly where the synchronous build used to run.
 *   An urgent change (a lift the player must see) therefore never presents later
 *   than before; it is the only case that can add a second build to a frame.
 *
 * The tick obeys the same budget: when a wire reconcile (or a request) already
 * built or patched in this rendered frame, after the frame began, the tick
 * samples and settles but does not build again. Whatever it advanced (a ramp
 * step, a tween sample) is carried: the next frame is booked and built or
 * patched even if no other demand is left. Only an outstanding urgent request
 * overrides the yield. The texture lane likewise skips its repaint when this
 * frame already ran a full build that started after the texture arrived.
 *
 * rAF lanes run in booking order, so "this frame" cannot be read from lane
 * order. It is a task epoch instead: all rAF callbacks of a display frame run in
 * one task, and a one-shot posted task (never a timer loop) closes the epoch
 * after any task that built, patched or raised a request. A close that runs
 * late can only make a request build now, never later: the tick starts a new
 * epoch itself when the open one holds only work from before this frame began
 * (the rAF timestamp), so it never yields to a build from an earlier frame.
 *
 * A request survives an in-flight asynchronous presentation (`buildBlocked`):
 * it is not attempted while blocked and is served once the presentation settles
 * and re-arms the scheduler. Without `ports.coalesce` none of this exists.
 *
 * ONE TASK PER IDLE FRAME (`rustIdleScheduler`, opt-in through `ports.idleScheduler`).
 * A steady idle cadence (an intent bob at 30 Hz, nothing requested) used to cost
 * a park timer, the rAF, and a posted epoch close after each of them. With the
 * switch on:
 *
 * - a passive deadline at most two display frames away is not parked: the tick
 *   books the next display rAF itself and a booked-by-fold tick skips until the
 *   deadline the timer would have woken for (`due - CANVAS_FRAME_PARK_SLOP_MS`),
 *   so the admitted frames are the same and no timer is armed. The display frame
 *   is the shortest recent rAF-to-rAF gap of the chain; a farther deadline (a
 *   long settle, a 120 Hz display, a 90 Hz one when the frame's work is short)
 *   still parks as before;
 * - an idle-only tick whose epoch held no other work and no request posts no
 *   close. A lane of the scheduler's own still to run in this frame (the view's
 *   reconcile, a texture repaint booked before the frame), a build in the tick,
 *   or anything it left open keeps the posted close. Otherwise:
 *   - a folded tick ends its epoch itself when it returns. Its booking stays in
 *     the closed epoch, so a non-urgent request in a later task waits for that
 *     tick (the next display frame, which is a skip frame the request admits: the
 *     same paint an at-once build reaches). An urgent request does not wait (it
 *     may be a lane after the tick in this frame), so a first lift still presents
 *     at once; it never shares a paint with the tick's next patch, because the
 *     chain's next frame is a skip frame;
 *   - a parked tick (a 90/120 Hz display) leaves its epoch open, so any lane after
 *     it in this frame, known to the scheduler or not, still sees its work; the
 *     park wake, a task of its own after that frame, ends it;
 *   - a plain booking (the display-paced arm, a late frame) posts as before;
 * - a park wake ends its own booking's epoch on the spot (its timer task runs
 *   nothing else) instead of posting a close.
 *
 * The per-frame census (`workPerFrame`, `maxWorkPerFrame`, `urgentExtraBuilds`)
 * follows the epochs, except that a folded tick's early end keeps it open until
 * the next display frame's callback, a park wake or a posted close. It can only
 * over-count against the switch-off arm (a task between frames joins the frame
 * before it), never under-count. The fold compares rAF timestamps with
 * `ports.now()`; under a replay's deterministic clock a slowed replay over-counts
 * skipped ticks.
 *
 * Off, every path above is exactly the previous one.
 */

import type { ReconcilePull } from "@/mirror/renderer/contracts";

/** A timer wake this close is cheaper and safer as the next display rAF. */
export const CANVAS_FRAME_PARK_SLOP_MS = 4;
/** The only passive cadence which stays an rAF chain instead of timer parking. */
export const CANVAS_IDLE_STAGE_MAX_FPS = 60;
export const CANVAS_IDLE_STAGE_MIN_FRAME_MS = 1000 / CANVAS_IDLE_STAGE_MAX_FPS;
export const CANVAS_IDLE_STAGE_EARLY_ADMISSION_MS = CANVAS_IDLE_STAGE_MIN_FRAME_MS / 2 - 0.01;

const DELIVERY_SAMPLE_WINDOW = 24;
const IDLE_PERIOD_MAX_SAMPLE_MS = 5000;
const FRAME_SAMPLE_WINDOW = 120;

/** A canvas state only needs a revision for reconcile-pull admission. */
export interface CanvasFrameSchedulerState {
  readonly revision: number;
}

/** A source which may intentionally bypass the passive display gate. */
export type CanvasIdleStageBypass = "offset" | "tween" | "settle" | "trail";

/** Browser operations are injected so the state machine is directly testable. */
export interface CanvasFrameSchedulerPlatform {
  /** One-shot "after the current task" callback for the coalescing frame epoch. Defaults to a MessageChannel. */
  readonly postTask?: ((callback: () => void) => void) | null;
  /** The clock rAF timestamps are on (`performance.now()` in a browser). */
  readonly now?: () => number;
  readonly requestAnimationFrame: ((callback: FrameRequestCallback) => number) | null;
  readonly cancelAnimationFrame: ((handle: number) => void) | null;
  readonly setTimeout: ((callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>) | null;
  readonly clearTimeout: ((handle: ReturnType<typeof setTimeout>) => void) | null;
  /** Browser globals can be removed by a test or embedded host after construction. */
  readonly animationFrameAvailable?: () => boolean;
  readonly timerAvailable?: () => boolean;
}

/** Deadline sources are intentionally lazy: the scheduler asks only when needed. */
export interface CanvasFrameSchedulerDeadlinePorts {
  /** A live ramp needs every display frame; its reported deadline is its end. */
  offsetRampDeadline(): number;
  /** Mixed loop semantics: a per-frame source and a future settle can coexist. */
  loopDeadline(at: number): number;
  loopHasPerFrameDemand(at: number): boolean;
  /** A trail may outlive its flight and therefore has a real future expiry. */
  trailDeadline(at: number): number;
  /** Idle, spine, paced FX and stage effects under the passive display ceiling. */
  passiveDeadline(at: number): number;
  /** Called only after a ramp did not move this callback. */
  idleStageBypass(at: number): CanvasIdleStageBypass | null;
  readonly idleStageNotBefore: () => number;
}

/** The animation body remains imperative, but its order belongs to this runtime. */
export interface CanvasFrameSchedulerAnimationPorts<TState extends CanvasFrameSchedulerState> {
  /** Write the current cosmetic-ramp sample before a build can observe it. */
  advanceOffsetRamps(at: number): boolean;
  noteIdleStageMissingPassive(): void;
  noteIdleStageSkippedEarly(): void;
  noteIdleStageAdmission(at: number, minimumFrameMs: number): void;

  /** Sample/tick/advance order is a rendering contract, not a caller choice. */
  sampleVisual(at: number): void;
  noteTrailFlightHeads(at: number): void;
  tickTrails(at: number): void;
  mergeTrailLatches(): void;
  advanceVisual(at: number): void;
  tickSpine(at: number): void;

  /** A successful numeric patch presents through its own established port. */
  tryPatchAndPaint(at: number): boolean;
  /** `requested`: this build serves a coalesced build request (see `requestBuild`). */
  runBuild(state: TState, requested?: boolean): boolean;
  syncOverlay(state: TState): void;
  /** An animation full build is synchronous, but never a scene acknowledgement. */
  /** True when the full build reached the display; legacy backends may not report it. */
  paintAction(): boolean | void;
  /** Landing evidence is scored only after the frame's pixels are on screen. */
  settleLanding(at: number): void;

  /** A texture resource callback rebuilds and paints but never acknowledges a scene delta. */
  /** True only when the requested resource was included in a drawn frame. */
  rebuildAndPaintTexture(): boolean | void;
}

/** `rustCoalescedBuilds`: the build-request demand source and its per-frame accounting. */
export interface CanvasFrameSchedulerCoalescePorts {
  /** False keeps every decision as it was; only the per-frame work accounting runs (a bench's switch-off arm). */
  readonly enabled: boolean;
  /** Build and present the current state now: what a synchronous client-only repaint used to do. */
  localBuild(): void;
  /** True while a build cannot start (an asynchronous presentation in flight); its settlement re-arms. */
  buildBlocked(): boolean;
}

/** Work per display frame: per task epoch, kept open across an idle tick's own epoch end. Builds plus patches. */
export interface CanvasFrameCoalesceStats {
  readonly enabled: boolean;
  readonly requests: number;
  readonly urgentRequests: number;
  readonly immediate: number;
  readonly deferred: number;
  /** Urgent requests that built in a frame which had already built or patched. */
  readonly urgentExtraBuilds: number;
  readonly servedByTick: number;
  readonly blockedRequests: number;
  /** Ticks that found their epoch still open (the posted close ran late). */
  readonly staleTaskCloses: number;
  /** Ticks that sampled but did not build because their frame had already built or patched. */
  readonly tickYields: number;
  /** Texture repaints a full build earlier in the same frame had already drawn. */
  readonly textureYields: number;
  /** Ticks whose moved offset ramp alone forced a full build (no `rampPatchable`). */
  readonly rampForcedBuilds: number;
  /** Ticks with a moved offset ramp whose retained patch committed (counted at commit, not at submission). */
  readonly rampPatches: number;
  /** Submitted patches that never presented (refused, superseded or failed); their frame work was undone. */
  readonly lostPatches: number;
  /** Ticks that skipped a patch because an asynchronous presentation was in flight (`rampPatchable`). */
  readonly blockedPatchYields: number;
  readonly frameTask: number;
  readonly framesWithWork: number;
  readonly workPerFrame: Readonly<Record<"1" | "2" | "3+", number>>;
  readonly buildsPerFrame: Readonly<Record<"1" | "2" | "3+", number>>;
  readonly maxWorkPerFrame: number;
  /** Epoch closes posted as tasks (each one is a task of its own). */
  readonly closesPosted: number;
  /** Idle-only ticks that ended their epoch themselves instead of posting a close (`rustIdleScheduler`). */
  readonly idleEpochEnds: number;
  /** Park wakes that ended their own booking's epoch instead of posting a close (`rustIdleScheduler`). */
  readonly parkEpochEnds: number;
  /** Idle-only ticks that parked and left their epoch for the park wake to end (`rustIdleScheduler`). */
  readonly parkedIdleEpochs: number;
}

/** Scheduler task census, both arms: what each idle frame cost in browser callbacks. */
export interface CanvasIdleSchedulerStats {
  readonly enabled: boolean;
  /** Animation-lane rAF callbacks delivered, skipped ticks included. */
  readonly rafCallbacks: number;
  /** Animation rAF callbacks that skipped (not due, or no passive demand). */
  readonly skippedTicks: number;
  readonly parkTimers: number;
  readonly parkWakeups: number;
  /** Bookings that replaced a park timer with the display rAF chain. */
  readonly folds: number;
  /** Folded-chain ticks that skipped because the passive deadline was not yet within the park slop. */
  readonly foldSkips: number;
  /** Shortest recent rAF-to-rAF gap of the chain, the fold's display-frame estimate. */
  readonly displayFrameMs: number;
}

/** What one patch submission took from the scheduler, given back by `settlePatch` if it never presents. */
export interface CanvasPatchSubmission {
  readonly task: number;
  /** Submitted by a tick whose offset ramp moved. */
  readonly ramp: boolean;
  /** It served (and cleared) an open offset-only request, urgent or not. */
  readonly servedRequest: boolean;
  readonly urgent: boolean;
}

export interface CanvasFrameSchedulerPorts<TState extends CanvasFrameSchedulerState> {
  readonly now: () => number;
  readonly state: () => TState | null;
  readonly disposed: () => boolean;
  readonly revisionAtFrame: () => number;
  /** Changed animation frames may reuse their drawn CPU command list. */
  readonly cpuIncremental?: boolean;
  readonly deadlines: CanvasFrameSchedulerDeadlinePorts;
  readonly animation: CanvasFrameSchedulerAnimationPorts<TState>;
  readonly idleAnimFps: () => number;
  /** Comparison-only passive animation pacing. Finite demand uses one display rAF. */
  readonly displayPacedPassive?: boolean;
  readonly platform?: CanvasFrameSchedulerPlatform;
  /** Optional observer; it cannot change admission or scheduling. */
  readonly onFrameLifecycle?: (event: "offered" | "admitted" | "skipped" | "sample-start" | "sample-end", revision: number) => void;
  /** Build-request coalescing; absent means no request path and no accounting at all. */
  readonly coalesce?: CanvasFrameSchedulerCoalescePorts;
  /**
   * `rustOffsetPatch`: a moved cosmetic-offset ramp (and an offset-only build request) may be presented by a
   * retained patch instead of forcing a full build. Absent: a moved ramp always builds.
   */
  readonly rampPatchable?: boolean;
  /** `rustIdleScheduler`: one browser task per steady idle frame (see the module notes). Absent: off. */
  readonly idleScheduler?: boolean;
}

export interface CanvasFrameScheduler {
  /** Re-evaluate demand and either book one display rAF or park at a future deadline. */
  armAnimation(at: number): void;
  /** Resource arrival repaint: one independent rAF, never an acknowledgement. */
  scheduleTexturePaint(): void;
  /** Capture demand before a synchronous build; a newer arrival must survive it. */
  readonly textureDemandGeneration: number;
  /** Report a successful full build and draw that consumed the captured demand. */
  noteTexturePresented(generation: number): void;
  /** Offered by MirrorView after construction; absent means the normal animation path. */
  setReconcilePull(pull: ReconcilePull | null): void;
  /** The visual runtime reports idle periods through this scheduler-owned sample ring. */
  noteIdlePeriod(at: number): void;
  /** Cancels both rAF lanes and the timer; late callbacks become inert. */
  dispose(): void;
  /**
   * Ask for one full build of the current state (`ports.coalesce` enabled). `urgent` marks a change the player
   * must see this frame. Returns whether it built now or was left to a tick (or to a settling presentation).
   */
  requestBuild(urgent: boolean, offsetOnly?: boolean): "immediate" | "deferred";
  /**
   * Every full build the renderer starts (it serves any request) and every patch it submits. A patch returns its
   * submission, which the renderer hands back to `settlePatch` once it knows whether the patch presented.
   */
  noteFrameWork(kind: "build"): void;
  noteFrameWork(kind: "patch"): CanvasPatchSubmission | null;
  /**
   * A submitted patch committed, or never will (refused, superseded, failed). A lost patch gives back what its
   * submission took: its frame's work slot, an offset-only request it served and the frame a tick carried
   * (`rampPatchable`), so a ramp's last step or a trailing offset is drawn by a later frame instead of lost.
   * `buildFollows`: the caller builds the current state right after this (a synchronous refusal), which draws all
   * of it, so no frame is booked.
   */
  settlePatch(submission: CanvasPatchSubmission | null, committed: boolean, buildFollows?: boolean): void;
  /** A build request is outstanding. */
  readonly buildRequested: boolean;
  /** A yielding (or blocked) tick advanced visual state no build or patch has drawn yet. */
  readonly carryPending: boolean;
  /**
   * An outstanding request needs a full build: a patch must not stand in for it. False for a request that only
   * moved cosmetic offsets while the offset patch (`rampPatchable`) can carry them.
   */
  readonly buildRequired: boolean;
  /** The outstanding request is not urgent and this frame already built or patched: the next tick serves it. */
  readonly buildRequestMayWait: boolean;
  /** The current task epoch; equal on every build of one frame. */
  readonly frameTask: number;
  coalesceStats(): CanvasFrameCoalesceStats | null;
  idleStats(): CanvasIdleSchedulerStats;

  readonly animFrames: number;
  readonly armedRafs: number;
  readonly armedParks: number;
  readonly parkWakeups: number;
  readonly pulledReconciles: number;
  readonly frameMsSamples: readonly number[];
  readonly rafDeliverySamples: readonly number[];
  readonly idlePeriodSamples: readonly number[];
  readonly idleStageBypasses: Readonly<Record<CanvasIdleStageBypass, number>>;
}

function browserPlatform(): CanvasFrameSchedulerPlatform {
  return {
    // Keep the global call receiver. Some browser implementations expose
    // WebIDL methods whose bare invocation is not portable.
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
    animationFrameAvailable: () => typeof requestAnimationFrame === "function",
    timerAvailable: () => typeof setTimeout === "function",
    now: () => performance.now(),
  };
}

/**
 * A lazily created "after this task" poster. A user-blocking `scheduler.postTask` is preferred: a busy page runs
 * it ahead of ordinary tasks, so the epoch closes before the next frame more often. A MessageChannel message is an
 * ordinary task with no timer clamp; without either, a zero-delay timer is the same boundary, just possibly later.
 */
function createTaskPoster(platform: CanvasFrameSchedulerPlatform): { post(callback: () => void): void; dispose(): void } {
  let channel: MessageChannel | null = null;
  const queue: Array<() => void> = [];
  return {
    post(callback) {
      if (platform.postTask) { platform.postTask(callback); return; }
      const taskScheduler = (globalThis as { scheduler?: { postTask?: (task: () => void, options: { priority: string }) => Promise<unknown> } }).scheduler;
      if (typeof taskScheduler?.postTask === "function") {
        void taskScheduler.postTask(callback, { priority: "user-blocking" }).catch(() => {});
        return;
      }
      if (channel === null && typeof MessageChannel === "function") {
        channel = new MessageChannel();
        channel.port1.onmessage = () => { queue.shift()?.(); };
      }
      if (channel !== null) { queue.push(callback); channel.port2.postMessage(null); return; }
      if (platform.setTimeout !== null) platform.setTimeout(callback, 0);
      else queueMicrotask(callback);
    },
    dispose() {
      queue.length = 0;
      if (channel === null) return;
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
      channel = null;
    },
  };
}

/** Keep a bounded sample without allocating an intermediate frame record. */
function noteSample(samples: number[], value: number, limit: number): void {
  if (samples.length >= limit) samples.shift();
  samples.push(value);
}

/**
 * Own the two canvas repaint lanes and the animation deadline state machine.
 *
 * The timer/rAF invariant is deliberately enforced here rather than trusted
 * from callers: a future deadline parks; a near or per-frame demand owns one
 * animation rAF; a timer wake chains into exactly one such rAF. Texture work
 * is a separately coalesced repaint lane and is intentionally not part of the
 * animation timer/rAF pair.
 */
export function createCanvasFrameScheduler<TState extends CanvasFrameSchedulerState>(
  ports: CanvasFrameSchedulerPorts<TState>,
): CanvasFrameScheduler {
  const platform = ports.platform ?? browserPlatform();
  const frameMsSamples: number[] = [];
  const rafDeliverySamples: number[] = [];
  const idlePeriodSamples: number[] = [];
  const idleStageBypasses: Record<CanvasIdleStageBypass, number> = {
    offset: 0,
    tween: 0,
    settle: 0,
    trail: 0,
  };

  let animationRaf: number | null = null;
  let textureRaf: number | null = null;
  let textureDemandGeneration = 0;
  let texturePresentedGeneration = 0;
  let parkTimer: ReturnType<typeof setTimeout> | null = null;
  let parkDue = Number.POSITIVE_INFINITY;
  let rafBookedAt = 0;
  let idlePeriodPreviousAt = 0;
  let animationFrames = 0;
  let armedRafs = 0;
  let armedParks = 0;
  let parkWakeups = 0;
  let pulledReconciles = 0;
  let reconcilePull: ReconcilePull | null = null;
  let schedulerDisposed = false;

  // Build-request coalescing (see the module notes). `coalesce` present means accounting; `.enabled`, decisions.
  const coalesce = ports.coalesce ?? null;
  const taskPoster = coalesce === null ? null : createTaskPoster(platform);
  let buildRequested = false;
  let requestUrgent = false;
  /** An open request includes a change only a full build can draw. */
  let requestNeedsBuild = false;
  let frameTask = 0;
  let taskClosePosted = false;
  let tickTask = -1;
  let rafBookedTask = -1;
  let taskBuilds = 0;
  let taskPatches = 0;
  /** Platform-clock time of the open epoch's latest build or patch, for the tick's frame-begin check. */
  let taskWorkAt = Number.NEGATIVE_INFINITY;
  /** A yielding tick advanced visual state that no build has drawn yet: the next frame must build or patch. */
  let carryFrame = false;
  let bookingFromSkippedTick = false;
  const platformNow = platform.now ?? (() => performance.now());
  /** Texture demand already resident when this task's latest full build started. */
  let textureGenerationAtTaskBuild = 0;
  const coalesceCounts = {
    requests: 0, urgentRequests: 0, immediate: 0, deferred: 0, urgentExtraBuilds: 0, servedByTick: 0,
    blockedRequests: 0, staleTaskCloses: 0, tickYields: 0, textureYields: 0, rampForcedBuilds: 0, rampPatches: 0, framesWithWork: 0, maxWorkPerFrame: 0,
    lostPatches: 0, blockedPatchYields: 0,
  };
  /** Set by the tick around its patch attempt: a submission made inside it is a ramp step. */
  let patchRampContext = false;
  const workPerFrame = { "1": 0, "2": 0, "3+": 0 };
  const buildsPerFrame = { "1": 0, "2": 0, "3+": 0 };
  const bucket = (count: number): "1" | "2" | "3+" => count === 1 ? "1" : count === 2 ? "2" : "3+";

  // rustIdleScheduler (see the module notes). Off, none of these change a decision; the census counts both arms.
  const idleScheduler = ports.idleScheduler === true;
  /** Stamps are withheld (an idle-only tick, or a park wake into an empty epoch, may end its epoch itself). */
  let stampQuiet = false;
  /** A stamp was withheld while quiet: the epoch holds something a close must end. */
  let stampWithheld = false;
  /** The pending tick was booked by an idle tick that then ended its own epoch: it is not known to run before the
   *  current paint, so an urgent request does not wait for it. */
  let eagerClosedBooking = false;
  /** The pending tick replaced a park timer: it skips until the passive deadline the timer would have woken for. */
  let foldBooking = false;
  let inAnimationFrame = false;
  let rafBookedInsideTick = false;
  let previousTickFrameTime = Number.NaN;
  const displayGaps: number[] = [];
  let displayFrameMs = CANVAS_IDLE_STAGE_MIN_FRAME_MS;
  const idleCounts = { rafCallbacks: 0, skippedTicks: 0, folds: 0, foldSkips: 0 };
  let closesPosted = 0;
  let idleEpochEnds = 0;
  let parkEpochEnds = 0;
  let parkedIdleEpochs = 0;
  /** Per-frame census of builds and patches; equal to the epoch counters unless an idle tick deferred it. */
  let censusBuilds = 0;
  let censusPatches = 0;
  let censusDeferred = false;
  /** The pending texture rAF was booked inside the tick, so it runs in the next display frame, not this one. */
  let textureBookedInTick = false;

  /** Something happened in the current task: make sure the epoch closes after it. */
  function stampTask(): void {
    if (taskPoster === null || taskClosePosted || schedulerDisposed) return;
    if (stampQuiet) { stampWithheld = true; return; }
    taskClosePosted = true;
    closesPosted++;
    taskPoster.post(closeTask);
  }

  /** A build or a request inside a quiet stretch: the epoch closes the usual way, after its task. */
  function endQuiet(): void {
    if (!stampQuiet) return;
    stampQuiet = false;
    if (stampWithheld) { stampWithheld = false; stampTask(); }
  }

  function closeTask(): void {
    taskClosePosted = false;
    endTask();
  }

  /**
   * `deferCensus`: an idle tick ending its own epoch (rustIdleScheduler) keeps the per-frame census open, so a lane
   * after it in the same frame is still counted with it; the next animation callback (a new display frame), a park
   * wake or a posted close closes the census. Off, the census closes with every epoch, exactly as before.
   */
  function endTask(deferCensus = false): void {
    if (deferCensus) censusDeferred = true;
    else flushCensus();
    taskBuilds = 0;
    taskPatches = 0;
    taskWorkAt = Number.NEGATIVE_INFINITY;
    frameTask++;
  }

  function flushCensus(): void {
    const work = censusBuilds + censusPatches;
    if (work > 0) {
      coalesceCounts.framesWithWork++;
      workPerFrame[bucket(work)]++;
      if (censusBuilds > 0) buildsPerFrame[bucket(censusBuilds)]++;
      if (work > coalesceCounts.maxWorkPerFrame) coalesceCounts.maxWorkPerFrame = work;
    }
    censusBuilds = 0;
    censusPatches = 0;
    censusDeferred = false;
  }

  function buildBlocked(): boolean {
    return coalesce?.buildBlocked() ?? false;
  }

  /** A request is live demand only while a build could start; a settling presentation re-arms otherwise. */
  function buildDemand(): boolean {
    return buildRequested && !buildBlocked();
  }

  function stopped(): boolean {
    return schedulerDisposed || ports.disposed();
  }

  function animationFrameAvailable(): boolean {
    return platform.requestAnimationFrame !== null && (platform.animationFrameAvailable?.() ?? true);
  }

  function timerAvailable(): boolean {
    return platform.setTimeout !== null && (platform.timerAvailable?.() ?? true);
  }

  /** Drop a pending park only. A pending animation rAF is never cancelled/re-armed. */
  function cancelPark(): void {
    if (parkTimer !== null && platform.clearTimeout !== null) platform.clearTimeout(parkTimer);
    parkTimer = null;
    parkDue = Number.POSITIVE_INFINITY;
  }

  /** Every animation rAF goes through this one booking point for delivery accounting. */
  function bookAnimationFrame(fold = false): boolean {
    if (animationRaf !== null || !animationFrameAvailable() || stopped()) return false;
    rafBookedAt = ports.now();
    animationRaf = platform.requestAnimationFrame!(animationFrame);
    foldBooking = fold;
    eagerClosedBooking = false;
    rafBookedInsideTick = inAnimationFrame;
    if (coalesce !== null) {
      rafBookedTask = frameTask;
      // A tick that skipped re-books without a close: an idle chain posts nothing. A request in a later task that
      // still sees this epoch takes the booking for its own task and builds now, which is the safe direction.
      if (!bookingFromSkippedTick) stampTask();
    }
    return true;
  }

  function noteRafDelivered(at: number): void {
    if (rafBookedAt === 0) return;
    const delivered = at - rafBookedAt;
    rafBookedAt = 0;
    if (!(delivered >= 0) || !Number.isFinite(delivered)) return;
    noteSample(rafDeliverySamples, delivered, DELIVERY_SAMPLE_WINDOW);
  }

  /** The parked timer may only ever hand one display-aligned frame to the renderer. */
  function onPark(): void {
    parkTimer = null;
    parkDue = Number.POSITIVE_INFINITY;
    if (stopped() || animationRaf !== null || !animationFrameAvailable()) return;
    parkWakeups++;
    // rustIdleScheduler: this timer task runs nothing else and comes after the frame of the tick that parked it. It
    // ends that tick's epoch (left open, see the tick), then ends its own booking's epoch here rather than in a posted
    // task, so a request in a later task waits for the booked tick, as it would after the close.
    if (idleScheduler && coalesce !== null && !taskClosePosted && !buildRequested) {
      if (taskBuilds + taskPatches > 0) endTask();
      stampQuiet = true;
      let booked = false;
      try { booked = bookAnimationFrame(); } finally { stampQuiet = false; stampWithheld = false; }
      if (booked) { endTask(); parkEpochEnds++; }
      return;
    }
    bookAnimationFrame();
  }

  /**
   * Re-evaluate the five animation sources lazily.
   *
   * Offset ramps deliberately short-circuit before any other deadline read:
   * their deadline is an end time, not a next-frame time. Loop per-frame and
   * A passive 60 Hz gate is
   * the one passive case that retains a display rAF chain.
   *
   * A finite loop deadline alone does not imply per-frame work: it can be the
   * final settle point for a channel that is otherwise quiet. `loopHasPerFrameDemand`
   * is the separate mixed-semantics discriminator which keeps that case
   * parkable while keeping an active transform/flight smooth. The passive
   * fold combines authored idle cadence, spine, FX and stage effects.
   */
  function armAnimation(at: number): void {
    if (stopped() || animationRaf !== null || !animationFrameAvailable()) return;

    if (Number.isFinite(ports.deadlines.offsetRampDeadline())) {
      cancelPark();
      armedRafs++;
      bookAnimationFrame();
      return;
    }

    // A build request is per-frame demand of its own: a request-only frame must
    // not be parked or skipped as "no demand".
    // rustOffsetPatch: a carried frame waits out an in-flight presentation, whose settlement re-arms it (a tick
    // now could neither patch nor build).
    if (buildDemand() || (carryFrame && !(ports.rampPatchable === true && buildBlocked()))) {
      cancelPark();
      armedRafs++;
      bookAnimationFrame();
      return;
    }

    const loopFrameDemand = ports.deadlines.loopHasPerFrameDemand(at);
    if (loopFrameDemand) {
      cancelPark();
      armedRafs++;
      bookAnimationFrame();
      return;
    }

    const loopDue = ports.deadlines.loopDeadline(at);
    const trailDue = ports.deadlines.trailDeadline(at);
    const passiveDue = ports.deadlines.passiveDeadline(at);
    const due = Math.min(loopDue, trailDue, passiveDue);

    if (!Number.isFinite(due)) {
      cancelPark();
      return;
    }
    if (ports.displayPacedPassive) {
      cancelPark();
      armedRafs++;
      bookAnimationFrame();
      return;
    }

    // Keep the expensive fast-passive predicate late. It may itself query
    // action sources, none of which matter when an unconditional arm won.
    // In particular, never turn a fresh per-frame loop into extra deadline
    // reads just to prove that it was already a per-frame loop.
    const immediateDemand =
      due <= at + CANVAS_FRAME_PARK_SLOP_MS ||
      !timerAvailable();
    if (immediateDemand) {
      cancelPark();
      armedRafs++;
      bookAnimationFrame();
      return;
    }

    // At 60 Hz, retain one display rAF instead of parking a passive deadline.
    // Evaluate the bypass only after all unconditional cases above; it may
    // need to ask the loop/trail/Fx sources again.
    const idleStageNotBefore = ports.deadlines.idleStageNotBefore();
    const fastPassiveDisplayArm =
      ports.idleAnimFps() >= CANVAS_IDLE_STAGE_MAX_FPS &&
      passiveDue === idleStageNotBefore &&
      idleStageNotBefore > at + CANVAS_FRAME_PARK_SLOP_MS &&
      ports.deadlines.idleStageBypass(at) === null;
    if (fastPassiveDisplayArm) {
      cancelPark();
      armedRafs++;
      bookAnimationFrame();
      return;
    }

    // rustIdleScheduler: a passive deadline at most two display frames out is reached by the display rAF chain
    // instead of a timer whose wake only books that same rAF. The booked tick skips until the timer's wake time.
    if (idleScheduler && passiveDue === due && due - CANVAS_FRAME_PARK_SLOP_MS - at <= 2 * displayFrameMs) {
      cancelPark();
      armedRafs++;
      idleCounts.folds++;
      bookAnimationFrame(true);
      return;
    }

    // A true future passive/settle deadline parks. Never re-arm later: the
    // earlier pending wake is already sufficient. Pre-empt only for earlier.
    // Subtracting the slop provides time to reach the browser's next display
    // callback without treating a near deadline as a timer round-trip.
    if (parkTimer !== null) {
      if (due >= parkDue) return;
      cancelPark();
    }
    parkDue = due;
    armedParks++;
    parkTimer = platform.setTimeout!(onPark, Math.max(0, Math.ceil(due - CANVAS_FRAME_PARK_SLOP_MS - at)));
  }

  function armFromSkippedTick(at: number): void {
    bookingFromSkippedTick = true;
    try { armAnimation(at); } finally { bookingFromSkippedTick = false; }
  }

  /**
   * Run the established canvas animation sequence. No branch here
   * acknowledges a wire delta; the only path which can do so is a pulled
   * reconcile, and it returns before this callback builds or paints anything.
   *
   * The pull sits before ramp sampling and passive admission intentionally. A
   * stale streamed revision has a pending reconciliation which is a strict
   * superset of this animation path; doing local animation work first would
   * build a list the reconcile immediately replaces. `pull.now()` is allowed
   * to perform the one build, paint and acknowledgement for this display
   * frame, so this callback must return immediately afterwards.
   */
  function animationFrame(frameTime?: number): void {
    animationRaf = null;
    idleCounts.rafCallbacks++;
    const folded = foldBooking;
    foldBooking = false;
    eagerClosedBooking = false;
    const timed = typeof frameTime === "number" && Number.isFinite(frameTime);
    // The chain's display frame: a tick booked inside the previous tick's callback lands on the next display frame
    // unless one was dropped, so the shortest recent gap is the display period.
    if (idleScheduler && rafBookedInsideTick && timed && Number.isFinite(previousTickFrameTime)) {
      const gap = frameTime - previousTickFrameTime;
      if (gap > 3 && gap < 50) {
        noteSample(displayGaps, gap, 8);
        displayFrameMs = Math.min(...displayGaps);
      }
    }
    rafBookedInsideTick = false;
    previousTickFrameTime = timed ? frameTime : Number.NaN;
    // A new display frame: an idle tick's deferred census (see `endTask`) is complete.
    if (censusDeferred) flushCensus();
    inAnimationFrame = true;
    try { animationTick(frameTime, folded); } finally { inAnimationFrame = false; }
  }

  function animationTick(frameTime: number | undefined, folded: boolean): void {
    if (coalesce !== null) {
      // The frame boundary is here when the open epoch cannot belong to this
      // frame: a second tick in it (one tick per frame), or work that started
      // before this frame began. Either way its posted close has not run yet.
      const work = taskBuilds + taskPatches;
      const begunEarlier = work > 0 && typeof frameTime === "number" && Number.isFinite(frameTime) && taskWorkAt < frameTime;
      if (tickTask === frameTask || begunEarlier) {
        if (work > 0) coalesceCounts.staleTaskCloses++;
        endTask();
      }
      tickTask = frameTask;
    }
    const at = ports.now();
    noteRafDelivered(at);
    // Delivery accounting belongs ahead of the disposed/state-null guard: a
    // callback delivered while teardown starts is still a delivered browser
    // frame, and dropping it biases the cadence window toward useful work.
    if (stopped()) return;
    const state = ports.state();
    if (state === null) return;
    ports.onFrameLifecycle?.("offered", state.revision);

    // A pending reconcile is a strict superset of an animation frame. Pull it
    // before any animation mutation/build work so it is the sole build, paint
    // and acknowledgement for this display frame.
    if (state.revision !== ports.revisionAtFrame() && reconcilePull !== null && reconcilePull.pending()) {
      pulledReconciles++;
      reconcilePull.now();
      noteSample(frameMsSamples, ports.now() - at, FRAME_SAMPLE_WINDOW);
      return;
    }
    // Consumed only by a tick that gets this far; a full build anywhere clears it.
    const carried = carryFrame;
    carryFrame = false;

    // Ramps write the visual-offset channel before passive admission and
    // before patch/full-build selection. Their own declarations stay outside
    // this runtime; only the display-frame step belongs here.
    const rampMoved = ports.animation.advanceOffsetRamps(at);
    const bypass = rampMoved ? "offset" : ports.deadlines.idleStageBypass(at);
    if (bypass !== null) idleStageBypasses[bypass]++;
    const passiveDue = ports.deadlines.passiveDeadline(at);
    // A build request admits the frame on its own; it is never an idle frame.
    const requested = coalesce?.enabled === true && buildDemand();
    const idleOnlyFrame = !requested && !carried && bypass === null && Number.isFinite(passiveDue);

    if (!requested && !carried && bypass === null && !Number.isFinite(passiveDue)) {
      idleCounts.skippedTicks++;
      ports.onFrameLifecycle?.("skipped", state.revision);
      ports.animation.noteIdleStageMissingPassive();
      armFromSkippedTick(at);
      return;
    }
    if (
      idleOnlyFrame && !ports.displayPacedPassive &&
      at + CANVAS_IDLE_STAGE_EARLY_ADMISSION_MS < ports.deadlines.idleStageNotBefore()
    ) {
      idleCounts.skippedTicks++;
      ports.onFrameLifecycle?.("skipped", state.revision);
      ports.animation.noteIdleStageSkippedEarly();
      armFromSkippedTick(at);
      return;
    }
    // rustIdleScheduler: a tick booked in place of a park timer runs no earlier than that timer would have woken.
    if (folded && idleOnlyFrame && at < passiveDue - CANVAS_FRAME_PARK_SLOP_MS) {
      idleCounts.skippedTicks++;
      idleCounts.foldSkips++;
      ports.onFrameLifecycle?.("skipped", state.revision);
      armFromSkippedTick(at);
      return;
    }

    // rustIdleScheduler: an idle-only tick alone in its epoch withholds its close (its patch and its re-booking).
    const quietTick = idleScheduler && coalesce !== null && idleOnlyFrame && !taskClosePosted &&
      taskBuilds + taskPatches === 0 && !buildRequested;
    if (quietTick) { stampQuiet = true; stampWithheld = false; }
    try {
      admittedTick(state, at, rampMoved, requested, idleOnlyFrame);
    } finally {
      if (quietTick && stampQuiet) {
        stampQuiet = false;
        if (stampWithheld) {
          stampWithheld = false;
          // A lane of the scheduler's own still to run in this frame (the view's reconcile, a texture repaint
          // booked before the frame) must see this tick's work, as must anything the tick left open: those keep the
          // posted close. A texture rAF booked inside this tick runs next frame.
          const sameFrameLane = (textureRaf !== null && !textureBookedInTick) || reconcilePull?.pending() === true;
          const folded = animationRaf !== null && rafBookedTask === frameTask && foldBooking;
          if (sameFrameLane || carryFrame || buildRequested || taskBuilds > 0) stampTask();
          else if (folded) {
            // The chain's next frame is a skip frame (the cadence is two or more display frames), so a request
            // that builds before it never shares a paint with this tick's next patch. A lane after this tick in
            // this frame still counts with it in the census.
            endTask(true);
            idleEpochEnds++;
            eagerClosedBooking = true;
          } else if (parkTimer !== null && animationRaf === null) {
            // Parked (a 90/120 Hz display): the epoch stays open, so any lane after this tick in this frame (one
            // the scheduler does not know of) still sees its work; the park wake, a task of its own, ends it.
            parkedIdleEpochs++;
          } else stampTask();
        }
      }
    }
  }

  function admittedTick(state: TState, at: number, rampMoved: boolean, requested: boolean, idleOnlyFrame: boolean): void {
    ports.onFrameLifecycle?.("admitted", state.revision);

    ports.onFrameLifecycle?.("sample-start", state.revision);
    ports.animation.sampleVisual(at);
    ports.animation.noteTrailFlightHeads(at);
    ports.animation.tickTrails(at);
    ports.animation.mergeTrailLatches();
    ports.animation.advanceVisual(at);
    ports.animation.tickSpine(at);
    ports.onFrameLifecycle?.("sample-end", state.revision);

    // One build or patch per frame: a frame that already built or patched (a
    // reconcile that ran first, from this frame's own sample) is not built
    // again; any remaining demand re-arms below. An urgent request still builds.
    const frameWorked = coalesce?.enabled === true && taskBuilds + taskPatches > 0;
    if (frameWorked && !(requested && requestUrgent)) {
      coalesceCounts.tickYields++;
      // What this tick advanced (a ramp's last step deletes the ramp and with it
      // the deadline) has not been drawn: carry it to the next frame.
      carryFrame = true;
      // The frame-lifecycle row closes here: this tick submits nothing.
      ports.onFrameLifecycle?.("skipped", state.revision);
    } else {
      // A request that needs a full build cannot be stood in for by a patch of
      // the sampled visuals, and nor can a moved ramp unless the offset patch is on.
      const fullOnly = (requested && requestNeedsBuild) || (rampMoved && ports.rampPatchable !== true) ||
        ports.cpuIncremental === false;
      if (requested) coalesceCounts.servedByTick++;
      if (rampMoved && ports.rampPatchable !== true && !(requested && requestNeedsBuild) && ports.cpuIncremental !== false)
        coalesceCounts.rampForcedBuilds++;
      if (!fullOnly && ports.rampPatchable === true && buildBlocked()) {
        // rustOffsetPatch: an asynchronous presentation is in flight, so a patch would be superseded and a build
        // deferred. Carry the frame; the presentation's settlement re-arms it.
        coalesceCounts.blockedPatchYields++;
        carryFrame = true;
        ports.onFrameLifecycle?.("skipped", state.revision);
      } else {
        // A ramp patch is counted when it commits (`settlePatch`): an asynchronous patch answers false here.
        patchRampContext = rampMoved;
        let patched: boolean;
        try { patched = !fullOnly && ports.animation.tryPatchAndPaint(at); } finally { patchRampContext = false; }
        if (!patched) {
          const textureGenerationAtBuild = textureDemandGeneration;
          if (requested ? ports.animation.runBuild(state, true) : ports.animation.runBuild(state)) {
            ports.animation.syncOverlay(state);
            if (ports.animation.paintAction() === true) noteTexturePresented(textureGenerationAtBuild);
          }
        }
      }
    }

    ports.animation.settleLanding(at);
    animationFrames++;
    if (idleOnlyFrame && !ports.displayPacedPassive) {
      ports.animation.noteIdleStageAdmission(at, CANVAS_IDLE_STAGE_MIN_FRAME_MS);
    }
    noteSample(frameMsSamples, ports.now() - at, FRAME_SAMPLE_WINDOW);
    armAnimation(ports.now());
  }

  /**
   * A texture arrival is one independent repaint rAF.
   *
   * A residency callback is not a scene delta. It may occur several times
   * while a paced atlas streams in, so coalescing prevents a resource burst
   * from becoming a burst of browser callbacks. A pending scene reconcile is
   * pulled first, since it can consume the same resource demand and own the
   * wire acknowledgement. A local fallback repaint never acknowledges it.
   */
  function scheduleTexturePaint(): void {
    if (stopped()) return;
    textureDemandGeneration++;
    if (textureRaf !== null || !animationFrameAvailable()) return;
    textureBookedInTick = inAnimationFrame;
    textureRaf = platform.requestAnimationFrame!(() => {
      textureRaf = null;
      if (stopped()) return;
      if (texturePresentedGeneration >= textureDemandGeneration) return;
      if (reconcilePull?.pending()) {
        pulledReconciles++;
        reconcilePull.now();
        if (stopped() || texturePresentedGeneration >= textureDemandGeneration) return;
      }
      // Only when that build started after every arrival this repaint is for: a
      // texture resident later in the frame still gets its own repaint.
      if (coalesce?.enabled === true && taskBuilds > 0 && textureGenerationAtTaskBuild >= textureDemandGeneration) {
        coalesceCounts.textureYields++;
        noteTexturePresented(textureGenerationAtTaskBuild);
        return;
      }
      const generation = textureDemandGeneration;
      if (ports.animation.rebuildAndPaintTexture() === true) noteTexturePresented(generation);
    });
  }

  function noteTexturePresented(generation: number): void {
    texturePresentedGeneration = Math.max(texturePresentedGeneration, generation);
  }

  function noteIdlePeriod(at: number): void {
    const previous = idlePeriodPreviousAt;
    idlePeriodPreviousAt = at;
    if (previous <= 0) return;
    const period = at - previous;
    // A screen transition, backgrounded tab or invisible loop is a gap, not
    // a cadence sample. Keep the broad established cutoff.
    if (!(period > 0) || period > IDLE_PERIOD_MAX_SAMPLE_MS) return;
    noteSample(idlePeriodSamples, period, DELIVERY_SAMPLE_WINDOW);
  }

  /**
   * Serve a build request as the module notes describe. Deferral needs a display
   * frame to come; without one the request builds now.
   */
  function requestBuild(urgent: boolean, offsetOnly = false): "immediate" | "deferred" {
    if (coalesce === null || !coalesce.enabled) {
      coalesce?.localBuild();
      return "immediate";
    }
    coalesceCounts.requests++;
    if (urgent) coalesceCounts.urgentRequests++;
    buildRequested = true;
    if (urgent) requestUrgent = true;
    if (!offsetOnly || ports.rampPatchable !== true) requestNeedsBuild = true;
    endQuiet();
    stampTask();
    if (stopped()) return "deferred";
    if (buildBlocked()) {
      // The settling presentation re-arms; a build attempted now would only be refused.
      coalesceCounts.blockedRequests++;
      coalesceCounts.deferred++;
      return "deferred";
    }
    // rustIdleScheduler: a tick booked by an idle tick that ended its own epoch may be NEXT frame's (this request
    // can be a lane after that tick, in its frame), so an urgent request builds now rather than wait for it.
    const tickAhead = animationRaf !== null && rafBookedTask !== frameTask && !(urgent && eagerClosedBooking);
    const workDone = taskBuilds + taskPatches > 0;
    if (animationFrameAvailable() && (tickAhead || (workDone && !urgent))) {
      coalesceCounts.deferred++;
      armAnimation(ports.now());
      return "deferred";
    }
    coalesceCounts.immediate++;
    // A booked scene reconcile is a strict superset of this build: run it now so
    // it is the one build and its acknowledgement moves earlier, never later.
    const state = ports.state();
    if (state !== null && state.revision !== ports.revisionAtFrame() && reconcilePull?.pending()) {
      pulledReconciles++;
      reconcilePull.now();
    }
    if (buildDemand() && !stopped()) coalesce.localBuild();
    return "immediate";
  }

  function noteFrameWork(kind: "build"): void;
  function noteFrameWork(kind: "patch"): CanvasPatchSubmission | null;
  function noteFrameWork(kind: "build" | "patch"): CanvasPatchSubmission | null {
    if (coalesce === null) return null;
    // rustIdleScheduler: a build in a quiet stretch keeps its posted close; a patch is withheld with the rest.
    if (kind === "build") endQuiet();
    stampTask();
    taskWorkAt = platformNow();
    if (kind === "build") {
      // The one case a frame may build twice: an urgent request served after the frame already built or patched.
      if (buildRequested && requestUrgent && censusBuilds + censusPatches > 0) coalesceCounts.urgentExtraBuilds++;
      // A full build of the current state draws whatever a yielding tick carried.
      carryFrame = false;
      taskBuilds++;
      censusBuilds++;
      textureGenerationAtTaskBuild = textureDemandGeneration;
      buildRequested = false;
      requestUrgent = false;
      requestNeedsBuild = false;
    } else {
      taskPatches++;
      censusPatches++;
      const submission = { task: frameTask, ramp: patchRampContext, servedRequest: false, urgent: requestUrgent };
      // rustOffsetPatch: a patch is planned from the current offsets and samples, so it serves an offset-only
      // request and draws whatever a yielding tick carried. `settlePatch` gives both back if it never presents.
      if (ports.rampPatchable === true) {
        carryFrame = false;
        if (buildRequested && !requestNeedsBuild) {
          submission.servedRequest = true;
          buildRequested = false; requestUrgent = false;
        }
      }
      return submission;
    }
    return null;
  }

  function settlePatch(submission: CanvasPatchSubmission | null, committed: boolean, buildFollows = false): void {
    if (submission === null || coalesce === null) return;
    if (committed) {
      if (submission.ramp) coalesceCounts.rampPatches++;
      return;
    }
    coalesceCounts.lostPatches++;
    // Still the frame that submitted it (a synchronous refusal): the slot is free for the build that follows.
    if (submission.task === frameTask && taskPatches > 0) { taskPatches--; if (censusPatches > 0) censusPatches--; }
    if (ports.rampPatchable !== true || stopped()) return;
    if (submission.servedRequest && !buildRequested) { buildRequested = true; requestUrgent = submission.urgent; }
    carryFrame = true;
    // Book the frame that redraws it, unless the caller's own build does (that build clears the carry). While a
    // presentation is in flight a carry alone books nothing and its settlement re-arms; a live offset ramp still
    // books its frame, whose tick then carries again (`blockedPatchYields`) instead of patching.
    if (!buildFollows) armAnimation(ports.now());
  }

  function coalesceStats(): CanvasFrameCoalesceStats | null {
    if (coalesce === null) return null;
    return {
      enabled: coalesce.enabled,
      ...coalesceCounts,
      frameTask,
      workPerFrame: { ...workPerFrame },
      buildsPerFrame: { ...buildsPerFrame },
      closesPosted,
      idleEpochEnds,
      parkEpochEnds,
      parkedIdleEpochs,
    };
  }

  function idleStats(): CanvasIdleSchedulerStats {
    return {
      enabled: idleScheduler,
      ...idleCounts,
      parkTimers: armedParks,
      parkWakeups,
      displayFrameMs,
    };
  }

  function dispose(): void {
    if (schedulerDisposed) return;
    schedulerDisposed = true;
    taskPoster?.dispose();
    if (animationRaf !== null && platform.cancelAnimationFrame !== null) {
      platform.cancelAnimationFrame(animationRaf);
    }
    if (textureRaf !== null && platform.cancelAnimationFrame !== null) {
      platform.cancelAnimationFrame(textureRaf);
    }
    animationRaf = null;
    textureRaf = null;
    cancelPark();
    reconcilePull = null;
  }

  return {
    armAnimation,
    scheduleTexturePaint,
    get textureDemandGeneration() { return textureDemandGeneration; },
    noteTexturePresented,
    setReconcilePull(pull) {
      reconcilePull = pull;
    },
    noteIdlePeriod,
    dispose,
    requestBuild,
    noteFrameWork,
    settlePatch,
    get buildRequested() { return buildRequested; },
    get carryPending() { return carryFrame; },
    get buildRequired() { return buildRequested && requestNeedsBuild; },
    get buildRequestMayWait() {
      return buildRequested && !requestUrgent && coalesce?.enabled === true && taskBuilds + taskPatches > 0;
    },
    get frameTask() { return frameTask; },
    coalesceStats,
    idleStats,
    get animFrames() { return animationFrames; },
    get armedRafs() { return armedRafs; },
    get armedParks() { return armedParks; },
    get parkWakeups() { return parkWakeups; },
    get pulledReconciles() { return pulledReconciles; },
    get frameMsSamples() { return frameMsSamples; },
    get rafDeliverySamples() { return rafDeliverySamples; },
    get idlePeriodSamples() { return idlePeriodSamples; },
    get idleStageBypasses() { return idleStageBypasses; },
  };
}
