// R-WPC: opt-in `performance.mark`/`measure` spans around the socket→parse→apply→notify pipeline
// (mirrorClient.ts's message listener) and the static-background wire scan (StaticBackground.vue's
// `wireFallback`) — named spans a live DevTools or CDP trace capture can show, so a phone-vs-desktop attribution
// pass doesn't have to guess which stage of one WS message dominated a task.
//
// Gated on the EXISTING warmAckTrace harness-presence hook (see mirrorClient.ts's other uses of
// `warmAckTraceEnabled`) rather than a new flag: any bench that installs `__benchWarmAckTrace` already wants
// this client under observation, the gate is a single `typeof` check either way, and reusing it adds no new
// wiring. Zero cost when nothing is watching — the check happens before any `performance.mark` call, not after.
import { warmAckTraceEnabled } from "@/mirror/warmAckTrace";

/** Wrap a synchronous operation in a named mark/measure pair. A no-op wrapper (still calls `fn`) when no bench
 * is observing — callers do not need their own `if (enabled)` guard. */
export function wirePhase<T>(name: string, fn: () => T): T {
  if (!warmAckTraceEnabled()) {
    return fn();
  }
  const startMark = `mirror-wire:${name}:start`;
  const endMark = `mirror-wire:${name}:end`;
  performance.mark(startMark);
  try {
    return fn();
  } finally {
    performance.mark(endMark);
    performance.measure(`mirror-wire:${name}`, startMark, endMark);
  }
}

/** Like {@link wirePhase}, but additionally marks the tail of whatever reactive flush `fn` triggers
 * SYNCHRONOUSLY — e.g. notify() calling MirrorApp's onChange, which bumps a Vue ref and so queues Vue's own
 * flush job via a settled promise before `fn` returns. A microtask queued here lands AFTER that job (same
 * microtask queue, FIFO), so the gap between `fn` returning and this microtask running approximates the Vue
 * template re-render cost — without reaching into Vue's internals. Approximate: a THIRD microtask queued by
 * someone else between the two would be counted too. */
export function wirePhaseFlushTail(name: string, fn: () => void): void {
  if (!warmAckTraceEnabled()) {
    fn();
    return;
  }
  const startMark = `mirror-wire:${name}:start`;
  const syncEndMark = `mirror-wire:${name}:sync-end`;
  performance.mark(startMark);
  fn();
  performance.mark(syncEndMark);
  performance.measure(`mirror-wire:${name}:sync`, startMark, syncEndMark);
  queueMicrotask(() => {
    const flushEndMark = `mirror-wire:${name}:flush-end`;
    performance.mark(flushEndMark);
    performance.measure(`mirror-wire:${name}:flush-tail`, syncEndMark, flushEndMark);
  });
}
