// Adaptive mirror render-quality: a downgrade-only controller that MEASURES the real frame rate (with the
// real shaders + particles running) and auto-tunes the GPU-fill knobs until the device holds a smooth rate.
//
// Why this exists: the static `quality.ts` heuristic can only ever GUESS a device's tier from coarse signals
// (it mis-judged a Moto G86 to `low` when it needed `min`/`off`). Empirical phone testing established the
// levers: renderScale = big GPU impact / barely visible (a blurrier glow) → the thing to drive DOWN; shader/
// particle FPS = nearly free on GPU but very visible (choppiness) → keep HIGH (>= a 25 floor). This controller
// replaces the guess with a measurement: after load settles it samples the rAF cadence (a sound GPU-throughput
// proxy — when the GPU can't finish frames in time the browser throttles presentation, so the inter-frame
// spacing IS the effective fps; the phone traces showed rAF sitting at exactly the GPU-bound ~11/17fps), and
// when the median over a rolling window is slow it ratchets renderScale down one rung (then the FPS caps to the
// 25 floor as a last resort). Continuous (not one-shot) so it also catches heavier-later screens (combat VFX)
// and thermal throttling. Downgrade-only: it never raises (no quality flicker).
//
// Robustness against a false downgrade on a genuinely-capped device (a 30Hz panel, or a CPU/network bottleneck
// that renderScale can't fix): a CONFIRM-IMPROVEMENT guard. After a step it remembers the pre-step median; if
// the next measurement didn't improve by a margin, stepping isn't helping → it stops (the device isn't
// GPU-fill-bound). This is what makes it "empirically valid" rather than blindly ratcheting to the floor.
//
// The DOM/timer wiring is injectable (now via the rAF timestamp, raf/cancelRaf, visibility, network-quiet) so
// the decision logic is unit-tested with a fake clock + scripted fps feed (see adaptiveQuality.spec.ts).
//
// ACTIVITY-GATED LIFECYCLE: on a smooth device this sampler never triggers a downgrade, so left to its own
// devices it would run its rAF loop FOREVER — a permanent per-frame cost (alloc + a 2s median sort) even on a
// perfectly idle screen. Instead the loop only runs while "recently active": `notifyActivity()` (wired from
// MirrorView's own render rAF — it fires exactly when the mirror pipeline produces a frame) both arms the loop
// if it was dormant and refreshes the activity clock; once `config.lingerMs` elapses with no further call the
// loop stops itself (and pauses the network probe) until the next `notifyActivity()`. `start()`/`stop()` are the
// outer lifecycle (mount/unmount, or a permanent halt like `exhausted`); in between, the loop itself idles and
// re-arms with zero cost while dormant.
//
// DUTY CYCLE (R10-PERF4 WS-2): being "active" still meant a third always-on rAF loop for as long as the mirror
// kept rendering — on a phone mid-combat that is a per-frame wakeup competing with the reconcile and the gsw
// runtimes, for a controller whose only possible output is a downgrade decided from ONE `windowMs` window. So
// after each window ENDS — evaluated, or discarded because the gate was closed — the loop parks on a
// `config.cooldownMs` timer (network probe torn down with it) and resumes afterwards. `notifyActivity` still
// wakes the DORMANT sampler instantly, but does not break a park (it fires every rendered frame, so it would
// cancel every cooldown).

export interface AdaptiveSeed {
  renderScale: number;
  shaderFps: number;
  particleFps: number;
}

// The live setters the controller drives (wired in MirrorView to the gsw runtime setters).
export interface AdaptiveApply {
  renderScale(scale: number): void;
  shaderFps(fps: number): void;
  particleFps(fps: number): void;
}

export interface AdaptiveChange {
  reason: "downgrade-renderscale" | "downgrade-shaderfps" | "downgrade-particlefps" | "exhausted" | "settled";
  renderScale: number;
  shaderFps: number;
  particleFps: number;
  /** The measured median fps that triggered this change. */
  medianFps: number;
}

export interface AdaptiveConfig {
  /** Rolling sample window (ms) the median is computed over; also the minimum continuously-gated time
   *  before a measurement is taken. */
  windowMs: number;
  /** Cool-down (ms) after a step before the next measurement (resize + thermal settle). */
  settleMs: number;
  /** Network must be quiet (no resource entries) for this long before measuring (so decode jank from
   *  loading new sprites never triggers a false downgrade). */
  quietMs: number;
  /** Median fps at/above which the device is considered smooth (no downgrade). */
  downgradeFps: number;
  /** A step must improve the median by at least this much to count as "helping" (confirm-improvement). */
  improveMarginFps: number;
  /** FPS caps are never lowered below this (the user's "keep >= 25" constraint). */
  fpsFloor: number;
  /** Minimum samples in a window before it's evaluated (guards a too-short window). */
  minSamples: number;
  /** How long (ms) the sampler keeps its rAF loop running after the last `notifyActivity()` call before it
   *  stops (and pauses the network probe) rather than sampling an idle screen forever. Re-arms instantly on
   *  the next `notifyActivity()`. Default 4x `windowMs`. */
  lingerMs: number;
  /** DUTY CYCLE (R10-PERF4 WS-2): how long (ms) the sampler PARKS after each measurement window ends — one that
   *  completed (and was evaluated) or one the gate discarded. 0 keeps rAF sampling for deterministic
   *  low-level tests. See the file banner. */
  cooldownMs: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  windowMs: 2000,
  settleMs: 1500,
  quietMs: 1000,
  downgradeFps: 45,
  improveMarginFps: 3,
  fpsFloor: 25,
  minSamples: 15,
  lingerMs: 8000,
  cooldownMs: 5000,
};

// renderScale rungs (descending). The ladder starts at the seed and includes only rungs below it.
const RENDER_SCALE_RUNGS = [1, 0.75, 0.5, 0.35, 0.25, 0.18, 0.125, 0.1];

export function buildRenderScaleLadder(seed: number): number[] {
  return [seed, ...RENDER_SCALE_RUNGS.filter((rung) => rung < seed - 1e-6)];
}

export interface AdaptiveControllerOptions {
  seed: AdaptiveSeed;
  apply: AdaptiveApply;
  /** True once a scene is on-screen (the mirror has rendered nodes). */
  hasScene: () => boolean;
  /** True once the viewer has PINNED an effect mode in the settings panel. A deliberate panel selection
   *  (Dynamic / ½ / ¼ / Static / Off) is the user's own quality decision, so the auto downgrade-controller must
   *  step aside and never fight it — while pinned, a completed measurement window takes no downgrade step. */
  isPinned?: () => boolean;
  /** Injectable env (defaults to the browser). */
  raf?: (cb: (timestampMs: number) => void) => number;
  cancelRaf?: (handle: number) => void;
  isVisible?: () => boolean;
  /** True when no network/resource activity for `quietMs`. Default uses a PerformanceObserver. */
  isNetworkQuiet?: (nowMs: number) => boolean;
  onChange?: (change: AdaptiveChange) => void;
  config?: Partial<AdaptiveConfig>;
  /** Injectable cooldown timer (the duty cycle's park), defaulting to setTimeout/clearTimeout. */
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface AdaptiveController {
  start(): void;
  stop(): void;
  /** Call whenever the mirror pipeline produces a frame (a render, not just a rAF tick). Arms the sampler's
   *  rAF loop if it was dormant and refreshes the activity clock so it keeps running for `lingerMs`. A no-op
   *  once `stop()`'d or `exhausted`. `nowMs` defaults to `performance.now()` (tests pass their own fake clock). */
  notifyActivity(nowMs?: number): void;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A fixed-capacity ring buffer for the per-tick frame intervals — replaces a growing array so a permanently
// (or just long-running) active sampler never allocates unboundedly. `push` is allocation-free (writes into a
// preallocated Float64Array); `toArray()` (used once per ~windowMs window, for the median) is the only bounded
// copy. Order doesn't matter for a median, so a wrapped buffer's `toArray()` doesn't bother re-ordering it.
export interface RingBuffer {
  push(value: number): void;
  readonly length: number;
  clear(): void;
  toArray(): number[];
}

export function createRingBuffer(capacity: number): RingBuffer {
  const buf = new Float64Array(Math.max(1, capacity));
  let head = 0;
  let count = 0;
  return {
    push(value: number): void {
      buf[head] = value;
      head = (head + 1) % buf.length;
      if (count < buf.length) {
        count += 1;
      }
    },
    get length(): number {
      return count;
    },
    clear(): void {
      head = 0;
      count = 0;
    },
    toArray(): number[] {
      return count === buf.length ? Array.from(buf) : Array.from(buf.slice(0, count));
    },
  };
}

// Capacity sized generously for a windowMs-long run at 120Hz (real devices we've traced top out well below
// that), plus slack — an occasional wrap on a very-high-refresh panel just drops the oldest sample, which is
// harmless (the median is still over a full window's worth of the most recent samples).
export function ringCapacityFor(windowMs: number): number {
  return Math.max(32, Math.ceil((windowMs / 1000) * 120) + 16);
}

// A default network-quiet predicate backed by a PerformanceObserver over "resource" entries (image/fetch
// loads — incl. the mirror's own texture loads). Returns the predicate + pause/resume (so the observer can be
// torn down while the sampler is dormant, per the activity-gated lifecycle above) + a disposer. Starts
// UNCONNECTED — the caller (createAdaptiveController) `resume()`s it only once the sampler is actually armed,
// so a controller that's created but never active never opens an observer at all. Falls back to "always quiet"
// where PerformanceObserver/resource is unavailable (jsdom/tests pass their own stub anyway).
function createNetworkQuietProbe(quietMs: number): {
  isQuiet: (nowMs: number) => boolean;
  pause: () => void;
  resume: () => void;
  dispose: () => void;
} {
  let lastActivity = Number.NEGATIVE_INFINITY;
  let observer: PerformanceObserver | null = null;
  const connect = (): void => {
    if (observer || typeof PerformanceObserver === "undefined" || typeof performance === "undefined") {
      return;
    }
    try {
      observer = new PerformanceObserver((list) => {
        if (list.getEntries().length > 0) {
          lastActivity = performance.now();
        }
      });
      observer.observe({ type: "resource", buffered: false });
    } catch {
      observer = null;
    }
  };
  const disconnect = (): void => {
    observer?.disconnect();
    observer = null;
  };
  return {
    isQuiet: (nowMs: number) => nowMs - lastActivity >= quietMs,
    pause: disconnect,
    resume: connect,
    dispose: disconnect,
  };
}

/**
 * Create the adaptive controller. It does nothing until `start()`; `stop()` tears down the rAF loop and the
 * network probe. Seeded by the resolved quality tier (the heuristic's best guess); only ever lowers from there.
 */
export function createAdaptiveController(options: AdaptiveControllerOptions): AdaptiveController {
  const config: AdaptiveConfig = { ...DEFAULT_ADAPTIVE_CONFIG, ...options.config };
  const raf =
    options.raf ?? ((cb: (t: number) => void) => requestAnimationFrame(cb));
  const cancelRaf = options.cancelRaf ?? ((handle: number) => cancelAnimationFrame(handle));
  const isVisible =
    options.isVisible ??
    (() => typeof document === "undefined" || document.visibilityState === "visible");

  const networkProbe = options.isNetworkQuiet
    ? { isQuiet: options.isNetworkQuiet, pause: () => {}, resume: () => {}, dispose: () => {} }
    : createNetworkQuietProbe(config.quietMs);
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? ((handle: number) => clearTimeout(handle));
  const cooldownMs = Math.max(0, config.cooldownMs);

  const ladder = buildRenderScaleLadder(options.seed.renderScale);
  let rsIndex = 0;
  let shaderFps = options.seed.shaderFps;
  let particleFps = options.seed.particleFps;

  // Sampling/gate state.
  let rafHandle: number | null = null;
  let lastFrameMs: number | null = null;
  const intervals = createRingBuffer(ringCapacityFor(config.windowMs));
  let gatedSince: number | null = null; // start of the current continuously-gated, post-settle window
  let settleUntil = 0; // suppress measurement until this timestamp (cool-down after a step)
  // The median measured just BEFORE the most recent downgrade step, to confirm the step helped. Null when
  // not mid-ratchet (a fresh slowdown, or after a smooth reading).
  let lastStepMedian: number | null = null;
  let exhausted = false; // hit the floor of every lever, or a step stopped helping → stop stepping

  // Activity-gated lifecycle state (see the file banner comment).
  let started = false; // start() called and not yet stop()'d — distinct from the loop actually running
  let lastActivityMs = Number.NEGATIVE_INFINITY;
  // Duty-cycle state: the pending cooldown timer handle (null = not parked).
  let cooldownHandle: number | null = null;

  const emit = (change: AdaptiveChange): void => options.onChange?.(change);

  // Apply one downgrade step. Returns true if a knob was actually lowered. Order: renderScale ladder first
  // (the big GPU lever, least visible), then the FPS caps down to the floor (shaderFps, then particleFps),
  // then nothing left → exhausted.
  const stepDown = (medianFps: number): boolean => {
    if (rsIndex < ladder.length - 1) {
      rsIndex += 1;
      const scale = ladder[rsIndex];
      options.apply.renderScale(scale);
      emit({ reason: "downgrade-renderscale", renderScale: scale, shaderFps, particleFps, medianFps });
      return true;
    }
    if (shaderFps === 0 || shaderFps > config.fpsFloor) {
      // 0 = uncapped (high tier) — capping to the floor is a downgrade too.
      shaderFps = config.fpsFloor;
      options.apply.shaderFps(shaderFps);
      emit({ reason: "downgrade-shaderfps", renderScale: ladder[rsIndex], shaderFps, particleFps, medianFps });
      return true;
    }
    if (particleFps === 0 || particleFps > config.fpsFloor) {
      particleFps = config.fpsFloor;
      options.apply.particleFps(particleFps);
      emit({ reason: "downgrade-particlefps", renderScale: ladder[rsIndex], shaderFps, particleFps, medianFps });
      return true;
    }
    return false;
  };

  // Decide on one completed measurement window.
  const evaluate = (medianFps: number, nowMs: number): void => {
    // The viewer pinned an effect mode in the panel → don't fight their selection with an auto downgrade.
    if (options.isPinned?.()) {
      return;
    }
    if (medianFps >= config.downgradeFps) {
      // Smooth — downgrade-only controller does nothing. Reset the ratchet so a LATER slowdown (combat,
      // thermal) is judged fresh, not against a stale pre-step median.
      lastStepMedian = null;
      return;
    }
    if (exhausted) {
      return;
    }
    // Confirm-improvement: if the previous step didn't move the needle, this device isn't GPU-fill-bound
    // (panel cap / CPU / network) — stepping renderScale won't help, so STOP rather than ratchet to the floor.
    if (lastStepMedian !== null && medianFps <= lastStepMedian + config.improveMarginFps) {
      exhausted = true;
      emit({ reason: "exhausted", renderScale: ladder[rsIndex], shaderFps, particleFps, medianFps });
      return;
    }
    // Slow, and either a fresh slowdown or the last step helped but it's still slow → take another step.
    lastStepMedian = medianFps;
    const stepped = stepDown(medianFps);
    if (!stepped) {
      exhausted = true;
      emit({ reason: "exhausted", renderScale: ladder[rsIndex], shaderFps, particleFps, medianFps });
      return;
    }
    // Cool-down before the next measurement (resize + thermal); start a fresh window after it.
    settleUntil = nowMs + config.settleMs;
    gatedSince = null;
    intervals.clear();
  };

  const tick = (timestampMs: number): void => {
    rafHandle = null;
    if (lastFrameMs !== null) {
      intervals.push(timestampMs - lastFrameMs);
    }
    lastFrameMs = timestampMs;

    const gateOpen =
      timestampMs >= settleUntil &&
      options.hasScene() &&
      isVisible() &&
      networkProbe.isQuiet(timestampMs);

    // Did this tick END a measurement window (evaluated or discarded)? Nothing can be learned from the frames
    // immediately after one, so that is where the duty cycle parks.
    let windowEnded = false;
    if (!gateOpen) {
      // Discard a partial/polluted window (e.g. a resource burst mid-measure) so it never triggers a step.
      gatedSince = null;
      intervals.clear();
      windowEnded = true;
    } else {
      if (gatedSince === null) {
        gatedSince = timestampMs;
        intervals.clear();
      } else if (
        timestampMs - gatedSince >= config.windowMs &&
        intervals.length >= config.minSamples
      ) {
        const medianInterval = median(intervals.toArray());
        const medianFps = medianInterval > 0 ? 1000 / medianInterval : 0;
        evaluate(medianFps, timestampMs);
        // Force a fresh window for the next measurement (evaluate may also have set settleUntil).
        gatedSince = null;
        intervals.clear();
        windowEnded = true;
      }
    }

    schedule(timestampMs, windowEnded);
  };

  // DUTY CYCLE (R10-PERF4 WS-2). A window just ended, so park the rAF loop on a timer instead of sampling every
  // frame until the next one can complete: this sampler can only ever LOWER quality, and a downgrade decision is
  // made from ONE `windowMs` window — sampling the whole `cooldownMs` gap in between buys nothing and costs a rAF
  // (plus a push + four gate calls) on every frame of a busy screen. `lastFrameMs` is reset so the sleep gap is
  // never pushed as an interval, and the resource observer is torn down for the duration exactly as `goIdle` does.
  const park = (): void => {
    networkProbe.pause();
    lastFrameMs = null;
    cooldownHandle = setTimer(() => {
      cooldownHandle = null;
      if (stopped || exhausted) {
        return;
      }
      // Re-arm through a plain rAF: the linger check needs a timestamp, and the first tick's own timestamp is the
      // only clock this controller has — so a park that outlived the linger window ends in `goIdle` one tick later.
      networkProbe.resume();
      rafHandle = raf(tick);
    }, cooldownMs);
  };

  const cancelPark = (): void => {
    if (cooldownHandle !== null) {
      clearTimer(cooldownHandle);
      cooldownHandle = null;
    }
  };

  // Stop the rAF loop because there's been no `notifyActivity()` for `lingerMs` — NOT a permanent stop (unlike
  // `stop()`/exhausted): `notifyActivity()` re-arms it instantly. Discards any partial in-flight window (same
  // policy as the gate-closed case in `tick` above) so evaluate() semantics stay unchanged for windows that DO
  // complete while active; resets `lastFrameMs` too, so the first tick after re-arming doesn't push a bogus
  // multi-second "interval" spanning the dormant gap.
  const goIdle = (): void => {
    if (rafHandle !== null) {
      cancelRaf(rafHandle);
      rafHandle = null;
    }
    cancelPark();
    lastFrameMs = null;
    gatedSince = null;
    intervals.clear();
    networkProbe.pause();
  };

  // Called at the end of every tick (with that tick's timestamp) to decide whether to keep going. `windowEnded`
  // selects the duty-cycle park over another rAF (see `park`).
  const schedule = (nowMs: number, windowEnded = false): void => {
    if (stopped) {
      return;
    }
    // Once exhausted there is nothing left to tune — stop the loop entirely (no per-frame cost forever).
    if (exhausted) {
      stop();
      return;
    }
    if (nowMs - lastActivityMs >= config.lingerMs) {
      goIdle();
      return;
    }
    if (windowEnded && cooldownMs > 0) {
      park();
      return;
    }
    rafHandle = raf(tick);
  };

  let stopped = false;

  const start = (): void => {
    if (stopped || started) {
      return;
    }
    started = true;
    // Armed but dormant — the loop only starts once the first notifyActivity() arrives.
  };

  function stop(): void {
    stopped = true;
    started = false;
    if (rafHandle !== null) {
      cancelRaf(rafHandle);
      rafHandle = null;
    }
    cancelPark();
    networkProbe.dispose();
  }

  const notifyActivity = (nowMs?: number): void => {
    const t = nowMs ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
    lastActivityMs = t;
    if (!started || stopped || exhausted) {
      return;
    }
    // Wakes the DORMANT sampler (the goIdle/linger state) exactly as before. Deliberately NOT a park-breaker: in
    // production this fires from MirrorView's render rAF on every single rendered frame, so cancelling the
    // cooldown here would make the duty cycle unreachable during precisely the busy stretch it exists for. A park
    // is bounded (`cooldownMs`) and ends by itself.
    if (rafHandle === null && cooldownHandle === null) {
      networkProbe.resume();
      rafHandle = raf(tick);
    }
  };

  return { start, stop, notifyActivity };
}
