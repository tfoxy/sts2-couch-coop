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
 *   it cannot acknowledge a streamed scene revision.
 *
 * This is also the home of schedule/cadence diagnostics. Measuring the rAF
 * handoff and the actual idle-frame period beside the handle state means a
 * caller cannot accidentally omit a newly introduced wakeup from the census.
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
  runBuild(state: TState): boolean;
  syncOverlay(state: TState): void;
  /** An animation full build is synchronous, but never a scene acknowledgement. */
  paintAction(): void;
  /** Landing evidence is scored only after the frame's pixels are on screen. */
  settleLanding(at: number): void;

  /** A texture resource callback rebuilds and paints but never acknowledges a scene delta. */
  rebuildAndPaintTexture(): void;
}

export interface CanvasFrameSchedulerPorts<TState extends CanvasFrameSchedulerState> {
  readonly now: () => number;
  readonly state: () => TState | null;
  readonly disposed: () => boolean;
  readonly revisionAtFrame: () => number;
  readonly deadlines: CanvasFrameSchedulerDeadlinePorts;
  readonly animation: CanvasFrameSchedulerAnimationPorts<TState>;
  readonly idleAnimFps: () => number;
  readonly platform?: CanvasFrameSchedulerPlatform;
}

export interface CanvasFrameScheduler {
  /** Re-evaluate demand and either book one display rAF or park at a future deadline. */
  armAnimation(at: number): void;
  /** Resource arrival repaint: one independent rAF, never an acknowledgement. */
  scheduleTexturePaint(): void;
  /** Offered by MirrorView after construction; absent means the normal animation path. */
  setReconcilePull(pull: ReconcilePull | null): void;
  /** The visual runtime reports idle periods through this scheduler-owned sample ring. */
  noteIdlePeriod(at: number): void;
  /** Cancels both rAF lanes and the timer; late callbacks become inert. */
  dispose(): void;

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
  function bookAnimationFrame(): boolean {
    if (animationRaf !== null || !animationFrameAvailable() || stopped()) return false;
    rafBookedAt = ports.now();
    animationRaf = platform.requestAnimationFrame!(animationFrame);
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
  function animationFrame(): void {
    animationRaf = null;
    const at = ports.now();
    noteRafDelivered(at);
    // Delivery accounting belongs ahead of the disposed/state-null guard: a
    // callback delivered while teardown starts is still a delivered browser
    // frame, and dropping it biases the cadence window toward useful work.
    if (stopped()) return;
    const state = ports.state();
    if (state === null) return;

    // A pending reconcile is a strict superset of an animation frame. Pull it
    // before any animation mutation/build work so it is the sole build, paint
    // and acknowledgement for this display frame.
    if (state.revision !== ports.revisionAtFrame() && reconcilePull !== null && reconcilePull.pending()) {
      pulledReconciles++;
      reconcilePull.now();
      noteSample(frameMsSamples, ports.now() - at, FRAME_SAMPLE_WINDOW);
      return;
    }

    // Ramps write the visual-offset channel before passive admission and
    // before patch/full-build selection. Their own declarations stay outside
    // this runtime; only the display-frame step belongs here.
    const rampMoved = ports.animation.advanceOffsetRamps(at);
    const bypass = rampMoved ? "offset" : ports.deadlines.idleStageBypass(at);
    if (bypass !== null) idleStageBypasses[bypass]++;
    const passiveDue = ports.deadlines.passiveDeadline(at);
    const idleOnlyFrame = bypass === null && Number.isFinite(passiveDue);

    if (bypass === null && !Number.isFinite(passiveDue)) {
      ports.animation.noteIdleStageMissingPassive();
      armAnimation(at);
      return;
    }
    if (
      idleOnlyFrame &&
      at + CANVAS_IDLE_STAGE_EARLY_ADMISSION_MS < ports.deadlines.idleStageNotBefore()
    ) {
      ports.animation.noteIdleStageSkippedEarly();
      armAnimation(at);
      return;
    }

    ports.animation.sampleVisual(at);
    ports.animation.noteTrailFlightHeads(at);
    ports.animation.tickTrails(at);
    ports.animation.mergeTrailLatches();
    ports.animation.advanceVisual(at);
    ports.animation.tickSpine(at);

    if (rampMoved || !ports.animation.tryPatchAndPaint(at)) {
      if (ports.animation.runBuild(state)) {
        ports.animation.syncOverlay(state);
        ports.animation.paintAction();
      }
    }

    ports.animation.settleLanding(at);
    animationFrames++;
    if (idleOnlyFrame) {
      ports.animation.noteIdleStageAdmission(at, CANVAS_IDLE_STAGE_MIN_FRAME_MS);
    }
    noteSample(frameMsSamples, ports.now() - at, FRAME_SAMPLE_WINDOW);
    armAnimation(ports.now());
  }

  /**
   * A texture arrival is one independent, non-acknowledging repaint rAF.
   *
   * A residency callback is not a scene delta. It may occur several times
   * while a paced atlas streams in, so coalescing prevents a resource burst
   * from becoming a burst of browser callbacks. It invokes only the narrow
   * repaint port and has no path to the animation body or reconcile pull.
   */
  function scheduleTexturePaint(): void {
    if (stopped() || textureRaf !== null || !animationFrameAvailable()) return;
    textureRaf = platform.requestAnimationFrame!(() => {
      textureRaf = null;
      if (stopped()) return;
      ports.animation.rebuildAndPaintTexture();
    });
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

  function dispose(): void {
    if (schedulerDisposed) return;
    schedulerDisposed = true;
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
    setReconcilePull(pull) {
      reconcilePull = pull;
    },
    noteIdlePeriod,
    dispose,
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
