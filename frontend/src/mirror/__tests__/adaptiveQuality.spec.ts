import { describe, expect, it } from "vitest";

import {
  buildRenderScaleLadder,
  createAdaptiveController,
  createRingBuffer,
  ringCapacityFor,
  type AdaptiveChange,
  type AdaptiveConfig,
  type AdaptiveSeed
} from "@/mirror/adaptiveQuality";

// A fake-clock harness: the controller is driven entirely by the rAF timestamp we feed, so a test can script
// a frame rate (and the gate inputs) deterministically with no real timers.
//
// The sampler's rAF loop is activity-gated (see adaptiveQuality.ts's file banner): it only runs while
// `notifyActivity()` has been called recently. In production that's wired from MirrorView's own render rAF, so
// during continuous rendering it fires every simulated frame — `frame`/`runFor` model exactly that (a mirror
// render happens each simulated frame, so the sampler never goes idle mid-scenario, matching the pre-activity-
// gating behavior these existing scenarios were written against). `rawFrame`/`idleFor` are the opposite: they
// step the clock and pump whatever tick is ALREADY scheduled WITHOUT any notifyActivity call, for exercising
// the idle-timeout path itself.
//
// The DUTY CYCLE (R10-PERF4 WS-2) adds a second scheduled thing: after each measurement window the loop parks on
// a `cooldownMs` timer instead of a rAF. That timer is injected into the same fake clock, and every pump fires it
// when it comes due — so a scenario keeps running across parks without any real timers either. `isRunning()` =
// "an animation frame is scheduled"; `isActive()` = "still monitoring" (a frame OR a park).
function harness(opts: {
  seed: AdaptiveSeed;
  config?: Partial<AdaptiveConfig>;
}) {
  let time = 1_000;
  let pending: ((t: number) => void) | null = null;
  let timer: { due: number; cb: () => void } | null = null;
  let quiet = true;
  let visible = true;
  let scene = true;
  const calls = {
    renderScale: [] as number[],
    shaderFps: [] as number[],
    particleFps: [] as number[]
  };
  const changes: AdaptiveChange[] = [];

  const controller = createAdaptiveController({
    seed: opts.seed,
    config: opts.config,
    apply: {
      renderScale: (v) => calls.renderScale.push(v),
      shaderFps: (v) => calls.shaderFps.push(v),
      particleFps: (v) => calls.particleFps.push(v)
    },
    hasScene: () => scene,
    isVisible: () => visible,
    isNetworkQuiet: () => quiet,
    raf: (cb) => {
      pending = cb;
      return 1;
    },
    cancelRaf: () => {
      pending = null;
    },
    setTimer: (cb, ms) => {
      timer = { due: time + ms, cb };
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
    onChange: (c) => changes.push(c)
  });

  const currentRenderScale = (): number =>
    calls.renderScale.length ? calls.renderScale[calls.renderScale.length - 1] : opts.seed.renderScale;

  // Fire a due cooldown timer (waking a parked sampler) and then whatever animation frame is scheduled.
  function pump(): void {
    if (timer && time >= timer.due) {
      const fire = timer.cb;
      timer = null;
      fire();
    }
    const cb = pending;
    if (cb) {
      pending = null;
      cb(time);
    }
  }

  // Advance the clock and fire whatever tick is already scheduled — no activity pulse of its own.
  function rawFrame(dtMs: number): void {
    if (!pending && !timer) {
      throw new Error("no frame scheduled (controller stopped/idle)");
    }
    time += dtMs;
    pump();
  }

  // A simulated render frame: reports activity (as MirrorView's scheduleRender does) THEN fires the tick, so
  // repeated calls keep the sampler armed indefinitely.
  function frame(dtMs: number): void {
    time += dtMs;
    controller.notifyActivity(time);
    rawFrame(0);
  }

  // Pump frames for `durationMs` of simulated time at `fps` (a number, or a function of the live renderScale),
  // reporting activity every frame. Stops early if the controller stops scheduling (exhausted/stopped). Unlike
  // idleFor below, this must NOT gate the loop's first iteration on `pending` — controllers start
  // dormant (pending is null until the first notifyActivity, which frame() itself sends).
  function runFor(durationMs: number, fps: number | ((renderScale: number) => number)): void {
    const end = time + durationMs;
    while (time < end) {
      const f = typeof fps === "function" ? fps(currentRenderScale()) : fps;
      frame(1000 / f);
      if (!pending && !timer) {
        break; // stopped/exhausted — a PARKED sampler (timer set) keeps going, it just isn't sampling
      }
    }
  }

  // Pump frames with NO activity pulses (for idle-timeout tests) — stops early once the controller goes idle
  // (or stops for any other reason).
  function idleFor(durationMs: number, fps = 60): void {
    const end = time + durationMs;
    while (time < end && (pending || timer)) {
      rawFrame(1000 / fps);
    }
  }

  return {
    controller,
    calls,
    changes,
    runFor,
    idleFor,
    notifyActivity: (t?: number) => controller.notifyActivity(t ?? time),
    now: () => time,
    isRunning: () => pending !== null,
    isParked: () => timer !== null,
    // Still monitoring: either sampling this frame or parked between windows (the duty cycle).
    isActive: () => pending !== null || timer !== null,
    setQuiet: (v: boolean) => (quiet = v),
    setVisible: (v: boolean) => (visible = v),
    setScene: (v: boolean) => (scene = v)
  };
}

const LOW_SEED: AdaptiveSeed = { renderScale: 0.5, shaderFps: 30, particleFps: 25 };

describe("buildRenderScaleLadder", () => {
  it("starts at the seed and includes only the rungs below it (descending)", () => {
    expect(buildRenderScaleLadder(0.5)).toEqual([0.5, 0.35, 0.25, 0.18, 0.125, 0.1]);
  });

  it("a min-tier seed (0.125) has only the 0.1 floor below it", () => {
    expect(buildRenderScaleLadder(0.125)).toEqual([0.125, 0.1]);
  });

  it("a high seed (1) spans the whole ladder", () => {
    expect(buildRenderScaleLadder(1)).toEqual([1, 0.75, 0.5, 0.35, 0.25, 0.18, 0.125, 0.1]);
  });
});

describe("createAdaptiveController", () => {
  it("never downgrades a device that holds a smooth frame rate", () => {
    const h = harness({ seed: LOW_SEED });
    h.controller.start();
    h.runFor(15_000, 60);
    expect(h.calls.renderScale).toEqual([]);
    expect(h.calls.shaderFps).toEqual([]);
    expect(h.calls.particleFps).toEqual([]);
    expect(h.isActive()).toBe(true); // still monitoring (not exhausted) — sampling or parked between windows
  });

  it("steps renderScale down once on sustained-slow frames, then stops when the step doesn't help", () => {
    // Constant 20fps regardless of renderScale → the first step can't improve it → confirm-improvement stops.
    const h = harness({ seed: LOW_SEED });
    h.controller.start();
    h.runFor(30_000, 20);
    expect(h.calls.renderScale).toEqual([0.35]); // exactly one rung down
    expect(h.changes.map((c) => c.reason)).toContain("exhausted");
    expect(h.isRunning()).toBe(false); // exhausted → loop stops (no perpetual per-frame cost)
  });

  it("keeps ratcheting renderScale down while each step improves but is still slow, then settles when smooth", () => {
    // fps improves as renderScale drops: 0.5→20, 0.35→30, 0.25→40, 0.18→50 (>= downgradeFps 45 → smooth).
    const fpsFor = (rs: number): number => {
      if (rs >= 0.5) return 20;
      if (rs >= 0.35) return 30;
      if (rs >= 0.25) return 40;
      return 50;
    };
    const h = harness({ seed: LOW_SEED });
    h.controller.start();
    h.runFor(40_000, fpsFor);
    expect(h.calls.renderScale).toEqual([0.35, 0.25, 0.18]); // three rungs, then 50fps is smooth → stop stepping
    expect(h.isActive()).toBe(true);
  });

  it("does not downgrade while the network is busy (settle gate), then downgrades once it goes quiet", () => {
    const h = harness({ seed: LOW_SEED });
    h.controller.start();
    h.setQuiet(false);
    h.runFor(20_000, 20); // slow, but gate is closed → no measurement
    expect(h.calls.renderScale).toEqual([]);
    h.setQuiet(true);
    h.runFor(10_000, 20);
    expect(h.calls.renderScale).toEqual([0.35]); // now it measures and steps
  });

  it("does not downgrade while the tab is hidden", () => {
    const h = harness({ seed: LOW_SEED });
    h.controller.start();
    h.setVisible(false);
    h.runFor(20_000, 20);
    expect(h.calls.renderScale).toEqual([]);
  });

  it("does not downgrade before a scene is present", () => {
    const h = harness({ seed: LOW_SEED });
    h.controller.start();
    h.setScene(false);
    h.runFor(20_000, 20);
    expect(h.calls.renderScale).toEqual([]);
  });

  it("lowers the FPS caps only after the renderScale floor, and never below the 25 floor", () => {
    // Seed already at the renderScale floor (0.1) with higher fps caps, so the ratchet moves to fps.
    // fps improves with each step so confirm-improvement lets it continue: 30→shaderFps step, 35→particleFps step.
    const seed: AdaptiveSeed = { renderScale: 0.1, shaderFps: 30, particleFps: 30 };
    const h = harness({ seed });
    // fps improves a little after each fps-cap step (keyed on steps TAKEN, not per-frame), so each step is
    // judged "helping" but stays < 45 until both caps hit the floor. 28, 36, 44 → exhausted.
    const fpsFor = (): number => 28 + (h.calls.shaderFps.length + h.calls.particleFps.length) * 8;
    h.controller.start();
    h.runFor(40_000, fpsFor);
    expect(h.calls.renderScale).toEqual([]); // no renderScale rung below 0.1
    expect(h.calls.shaderFps).toEqual([25]); // dropped to the floor, once
    expect(h.calls.particleFps).toEqual([25]); // then particles to the floor
    // Never below 25.
    expect(h.calls.shaderFps.every((v) => v >= 25)).toBe(true);
    expect(h.calls.particleFps.every((v) => v >= 25)).toBe(true);
    expect(h.changes.map((c) => c.reason)).toContain("exhausted");
  });
});

describe("createAdaptiveController — activity-gated lifecycle", () => {
  it("is armed but dormant after start() — the rAF loop only begins on the first notifyActivity", () => {
    const h = harness({ seed: LOW_SEED });
    h.controller.start();
    expect(h.isRunning()).toBe(false); // no rAF scheduled yet — zero per-frame cost while nothing is happening
    h.notifyActivity();
    expect(h.isRunning()).toBe(true);
  });

  it("stops the rAF loop after lingerMs with no further activity, and re-arms instantly on the next notifyActivity", () => {
    // cooldownMs 0 isolates the LINGER path: with the duty cycle on, the loop would park (not idle) at the first
    // completed window, and a park is deliberately not broken by notifyActivity (see the duty-cycle tests below).
    const h = harness({ seed: LOW_SEED, config: { lingerMs: 4000, cooldownMs: 0 } });
    h.controller.start();
    h.notifyActivity();
    expect(h.isRunning()).toBe(true);
    h.idleFor(4500, 60); // smooth + no activity pulses at all during this stretch
    expect(h.isRunning()).toBe(false); // went idle on its own — no perpetual per-frame cost on a quiet screen
    h.notifyActivity();
    expect(h.isRunning()).toBe(true); // re-armed instantly
  });

  it("discards a partial window across an idle/re-arm cycle instead of corrupting the next evaluation", () => {
    // lingerMs shorter than windowMs so the idle timeout always cuts a window short before it can complete —
    // exercises the "discard the partial window" path explicitly (never "complete the window early" instead).
    const h = harness({ seed: LOW_SEED, config: { lingerMs: 800 } });
    h.controller.start();
    h.notifyActivity();
    h.idleFor(1500, 20); // slow (20fps) frames — would eventually downgrade if the window were allowed to close
    expect(h.isRunning()).toBe(false); // idled out at ~800ms, well before the 2000ms window would complete
    expect(h.calls.renderScale).toEqual([]); // the partial window was thrown away, not evaluated
    h.notifyActivity(); // re-arm
    expect(h.isRunning()).toBe(true);
    expect(h.calls.renderScale).toEqual([]); // re-arming doesn't retroactively evaluate the discarded window
    // Ladder semantics are unchanged while active: a full, clean window of the same slow rate after re-arming
    // steps down exactly as it would have with no idle interruption at all.
    h.runFor(3_000, 20);
    expect(h.calls.renderScale).toEqual([0.35]);
  });

  it("does NOT idle out while parked mid-cooldown — the park itself is the wakeup, and it re-samples after it", () => {
    // lingerMs comfortably longer than one park, so the only thing that can end the park is the cooldown timer.
    const h = harness({ seed: LOW_SEED, config: { lingerMs: 30_000, cooldownMs: 5000 } });
    h.controller.start();
    h.notifyActivity();
    h.runFor(2_500, 60); // one window completes → park
    expect(h.isRunning()).toBe(false);
    expect(h.isParked()).toBe(true);
    h.runFor(6_000, 60); // the cooldown elapses → the sampler is back on the rAF loop
    expect(h.isActive()).toBe(true);
  });

  it("stop() is still a permanent halt regardless of activity gating", () => {
    const h = harness({ seed: LOW_SEED });
    h.controller.start();
    h.notifyActivity();
    expect(h.isRunning()).toBe(true);
    h.controller.stop();
    expect(h.isRunning()).toBe(false);
    h.notifyActivity(); // must NOT resurrect a stopped controller
    expect(h.isRunning()).toBe(false);
  });
});

// --- R10-PERF4 WS-2: the post-window DUTY CYCLE -----------------------------------------------------------------

describe("createAdaptiveController — sampler duty cycle", () => {
  it("parks after a COMPLETED window instead of sampling every frame until the next one", () => {
    const h = harness({ seed: LOW_SEED, config: { lingerMs: 30_000, cooldownMs: 5000 } });
    h.controller.start();
    h.notifyActivity();
    h.runFor(1_000, 60); // mid-window (windowMs 2000): still sampling every frame
    expect(h.isRunning()).toBe(true);
    expect(h.isParked()).toBe(false);
    h.runFor(1_500, 60); // the window closes → the loop parks
    expect(h.isRunning()).toBe(false);
    expect(h.isParked()).toBe(true);
  });

  it("parks after a DISCARDED window too (the gate was closed — nothing can be measured yet)", () => {
    const h = harness({ seed: LOW_SEED, config: { lingerMs: 30_000, cooldownMs: 5000 } });
    h.setQuiet(false); // network busy → the gate never opens, every tick discards
    h.controller.start();
    h.notifyActivity();
    h.runFor(200, 60); // the very first tick discards and parks
    expect(h.isRunning()).toBe(false);
    expect(h.isParked()).toBe(true);
  });

  it("notifyActivity does NOT break a park (it fires every rendered frame) but still wakes a DORMANT sampler", () => {
    const h = harness({ seed: LOW_SEED, config: { lingerMs: 30_000, cooldownMs: 5000 } });
    h.controller.start();
    h.notifyActivity();
    h.runFor(2_500, 60);
    expect(h.isParked()).toBe(true);
    h.notifyActivity(); // a rendered frame during the cooldown
    expect(h.isRunning()).toBe(false); // still parked — otherwise the duty cycle would never engage while busy
    expect(h.isParked()).toBe(true);
  });

  it("the ladder is unchanged by the duty cycle: sustained-slow frames still step once, then exhaust", () => {
    // The same slow-frame scenario still has the same outcome with the cooldown engaged: the
    // decision logic reads one completed window at a time, so parking between windows can't change its verdicts.
    const h = harness({ seed: LOW_SEED, config: { cooldownMs: 5000 } });
    h.controller.start();
    h.runFor(30_000, 20);
    expect(h.calls.renderScale).toEqual([0.35]);
    expect(h.changes.map((c) => c.reason)).toContain("exhausted");
    expect(h.isActive()).toBe(false); // exhausted → both the loop and any park are torn down
  });

  it("keeps sampling when a low-level test configures no cooldown", () => {
    const h = harness({ seed: LOW_SEED, config: { lingerMs: 30_000, cooldownMs: 0 } });
    h.controller.start();
    h.notifyActivity();
    h.runFor(6_000, 60); // several windows would have completed by now
    expect(h.isParked()).toBe(false);
    expect(h.isRunning()).toBe(true);
  });

});

describe("createRingBuffer", () => {
  it("grows up to capacity, then overwrites the oldest sample instead of growing further", () => {
    const rb = createRingBuffer(4);
    expect(rb.length).toBe(0);
    [1, 2, 3, 4].forEach((v) => rb.push(v));
    expect(rb.length).toBe(4);
    expect([...rb.toArray()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    rb.push(5); // capacity exceeded — must drop the oldest sample (1), not grow to length 5
    expect(rb.length).toBe(4);
    expect([...rb.toArray()].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    rb.push(6);
    expect(rb.length).toBe(4);
    expect([...rb.toArray()].sort((a, b) => a - b)).toEqual([3, 4, 5, 6]);
  });

  it("clear() resets it to empty", () => {
    const rb = createRingBuffer(4);
    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.toArray()).toEqual([]);
  });

  it("a fresh buffer under capacity returns exactly what was pushed", () => {
    const rb = createRingBuffer(8);
    rb.push(10);
    rb.push(20);
    expect(rb.length).toBe(2);
    expect(rb.toArray()).toEqual([10, 20]);
  });
});

describe("ringCapacityFor", () => {
  it("sizes generously for a windowMs run at 120Hz", () => {
    expect(ringCapacityFor(2000)).toBeGreaterThanOrEqual((2000 / 1000) * 120);
  });

  it("has a sane floor for a tiny window", () => {
    expect(ringCapacityFor(10)).toBeGreaterThanOrEqual(32);
  });
});
