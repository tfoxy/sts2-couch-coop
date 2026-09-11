import { noteMirrorFrame } from "@/mirror/framePressure";
import { mirrorWalkStats } from "@/mirror/renderer/walkStats";

type TickSchedulerCallbacks = {
  now: () => number;
  animationPeriodMs: () => number;
  hasActiveSpine: () => boolean;
  hasActiveIntents: () => boolean;
  hasActiveTweens: () => boolean;
  hasActiveTrails: () => boolean;
  hasActiveFlights: () => boolean;
  tickSpine: (now: number, gated: boolean) => void;
  tickIntent: (now: number, gated: boolean) => void;
  tickTweens: (now: number) => number;
  tickTrails: (now: number) => number;
  tickFlights: (now: number) => number;
};

export type TickScheduler = {
  schedule: () => void;
  noteTweenDeadline: (until: number) => void;
  noteTrailDeadline: (until: number) => void;
  queueDeraster: (el: HTMLElement) => void;
  dispose: () => void;
};

const TICK_SLOP_MS = 1;

/**
 * The DOM mirror's deadline scheduler. Controller-owned animator sets stay behind live callbacks so this leaf
 * neither imports nor snapshots the reconciler. All DOM mutation still happens in rAF callbacks.
 */
export function createTickScheduler(callbacks: TickSchedulerCallbacks): TickScheduler {
  let tickRaf = 0;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimerAt = Infinity;
  let tickParkedAt = -1;
  let spineDueAt = Infinity;
  let intentDueAt = Infinity;
  let tweenDueAt = Infinity;
  let trailDueAt = Infinity;
  let flightDueAt = Infinity;
  const derasterEls: HTMLElement[] = [];
  let derasterRaf = 0;

  function nextGridAfter(t: number, periodMs: number): number {
    return (Math.floor(t / periodMs) + 1) * periodMs;
  }

  function animGridNext(now: number, periodMs: number): number {
    return nextGridAfter(now + TICK_SLOP_MS, periodMs);
  }

  function refreshAnimDeadlines(now: number): void {
    const period = callbacks.animationPeriodMs();
    if (!callbacks.hasActiveSpine()) {
      spineDueAt = Infinity;
    } else if (period <= 0) {
      spineDueAt = now;
    } else if (spineDueAt === Infinity || spineDueAt > animGridNext(now, period)) {
      spineDueAt = animGridNext(now, period);
    }
    if (!callbacks.hasActiveIntents()) {
      intentDueAt = Infinity;
    } else if (period <= 0) {
      intentDueAt = now;
    } else if (intentDueAt === Infinity || intentDueAt > animGridNext(now, period)) {
      intentDueAt = animGridNext(now, period);
    }
    if (!callbacks.hasActiveTweens()) tweenDueAt = Infinity;
    if (!callbacks.hasActiveTrails()) trailDueAt = Infinity;
    flightDueAt = callbacks.hasActiveFlights() ? now : Infinity;
  }

  function noteTweenDeadline(until: number): void {
    if (until < tweenDueAt) tweenDueAt = until;
  }

  function noteTrailDeadline(until: number): void {
    if (until < trailDueAt) trailDueAt = until;
  }

  function schedule(): void {
    const now = callbacks.now();
    if (tickRaf !== 0) return;
    refreshAnimDeadlines(now);
    const due = Math.min(spineDueAt, intentDueAt, tweenDueAt, trailDueAt, flightDueAt);
    if (due === Infinity || typeof requestAnimationFrame !== "function") {
      clearTickTimer();
      return;
    }
    if (due <= now + TICK_SLOP_MS) {
      clearTickTimer();
      requestTickRaf();
      return;
    }
    if (tickTimer !== null && tickTimerAt <= due) return;
    clearTickTimer();
    tickTimerAt = due;
    tickParkedAt = now;
    tickTimer = setTimeout(onTickTimer, Math.max(0, Math.ceil(due - now)));
  }

  function clearTickTimer(): void {
    if (tickTimer !== null) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    tickTimerAt = Infinity;
    tickParkedAt = -1;
  }

  function onTickTimer(): void {
    tickTimer = null;
    tickTimerAt = Infinity;
    if (tickParkedAt >= 0) {
      mirrorWalkStats.tickParkedMs += callbacks.now() - tickParkedAt;
      tickParkedAt = -1;
    }
    requestTickRaf();
  }

  function requestTickRaf(): void {
    if (tickRaf !== 0 || typeof requestAnimationFrame !== "function") return;
    tickRaf = requestAnimationFrame(() => {
      tickRaf = 0;
      runScheduledTick();
    });
  }

  function runScheduledTick(): void {
    mirrorWalkStats.tickWakeups++;
    noteMirrorFrame();
    const now = callbacks.now();
    const period = callbacks.animationPeriodMs();
    if (callbacks.hasActiveSpine() && (period <= 0 || now + TICK_SLOP_MS >= spineDueAt)) {
      callbacks.tickSpine(now, false);
      spineDueAt = period > 0 ? animGridNext(now, period) : now;
    }
    if (callbacks.hasActiveIntents() && (period <= 0 || now + TICK_SLOP_MS >= intentDueAt)) {
      callbacks.tickIntent(now, false);
      intentDueAt = period > 0 ? animGridNext(now, period) : now;
    }
    if (callbacks.hasActiveTweens() && now + TICK_SLOP_MS >= tweenDueAt) tweenDueAt = callbacks.tickTweens(now);
    if (callbacks.hasActiveTrails() && now + TICK_SLOP_MS >= trailDueAt) trailDueAt = callbacks.tickTrails(now);
    if (callbacks.hasActiveFlights() && now + TICK_SLOP_MS >= flightDueAt) flightDueAt = callbacks.tickFlights(now);
    schedule();
  }

  function queueDeraster(el: HTMLElement): void {
    if (typeof requestAnimationFrame !== "function") return;
    el.style.willChange = "transform";
    derasterEls.push(el);
    if (!derasterRaf) {
      derasterRaf = requestAnimationFrame(() => {
        derasterRaf = 0;
        for (const queued of derasterEls) queued.style.willChange = "";
        derasterEls.length = 0;
      });
    }
  }

  function dispose(): void {
    if (typeof cancelAnimationFrame === "function") {
      if (tickRaf) cancelAnimationFrame(tickRaf);
      if (derasterRaf) cancelAnimationFrame(derasterRaf);
    }
    tickRaf = 0;
    derasterRaf = 0;
    clearTickTimer();
    spineDueAt = Infinity;
    intentDueAt = Infinity;
    tweenDueAt = Infinity;
    trailDueAt = Infinity;
    flightDueAt = Infinity;
    for (const queued of derasterEls) queued.style.willChange = "";
    derasterEls.length = 0;
  }

  return { schedule, noteTweenDeadline, noteTrailDeadline, queueDeraster, dispose };
}
