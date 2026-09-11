// FRAME PRESSURE — "is the mirror mid-burst right now?", for the one consumer that has to ask: gsw's
// static-surface encode pacing (`shaderResources.ts`).
//
// WHY THIS EXISTS. Freezing an effect surface to an `<img>` costs one `canvas.toBlob`, and on a phone that
// call is a GPU→CPU READBACK, not a codec run: the Aug-18 Moto G86 trace measured 52.8 ms of `toBlob` plus
// 17.1 ms of `createObjectURL` inside a SINGLE `TimerFire`, against ~2.8 ms of actual encoder CPU. gsw's
// pacing (slice 4 / 120 ms) bounds how many of those run per window and `deferHead: true` keeps them off the
// caller's stack, but neither can move the block out of the window it lands in — and a ~30 ms park dropped
// between two draws of a card-flight burst is a dropped frame no matter how few encodes it was. gsw grew
// `encode.busy` for exactly this; this module is the mirror's answer to it.
//
// THE SIGNAL, TWO TERMS. `noteMirrorFrame()` is called from the mirror's own frame producers — MirrorView's
// render rAF and the renderer's animator tick — so the RECENCY term means "this pipeline produced a frame very
// recently", which is the same thing as "an encode now would land between two of my draws". Nothing subscribes,
// nothing is allocated: two numbers and a subtraction, called from paths that already run per frame.
//   The second term is `registerPressureSource` — an ARMED-work predicate, added Aug-19 because recency alone
// has a hole a jam can drive through. See that function's doc: the short version is that a long readback
// suppresses the very frames the recency term is made of, so the recovery gap after one reads as idle.
//
// THE WINDOW (250 ms). It has to outlast the GAP between frames of a burst, not the burst: the whole point is
// that a burst of draws reads as one continuous busy window rather than as N isolated instants with encodable
// gaps between them. A phone dropping to 10 fps still puts its frames 100 ms apart, so 250 ms rides that out
// with margin, while a screen that genuinely stopped animating reports quiet a quarter second later — a
// quarter second of latency on a freeze whose gate already waits a full second (`quietMs: 1000`). It is
// deliberately NOT tuned per device: the failure mode of "too long" is bounded on gsw's side by
// `busyMaxDeferMs` (a surface still freezes within one bound however busy this reports), and the failure mode
// of "too short" is the status quo ante.
//
// A LEAF ON PURPOSE. It imports nothing from `@/mirror` — the feed sites (MirrorView.vue, mirrorRenderer.ts)
// and the reader (shaderResources.ts) all import IT, and any of them importing another would be a cycle. That is
// also why the armed-work term is a REGISTRY rather than a direct read: this module must not learn what an
// `activeFlights` is, so the owner of that state hands in a closure instead.
//

/** How long after a produced frame the mirror still counts as busy. See the module doc. */
const BUSY_IDLE_MS = 250;

/** `now()` of the last frame the mirror produced. `-Infinity` until one is noted, which is the FAIL-OPEN
 *  start: a viewer that has never rendered reports quiet, so a cold fleet freezes on schedule. */
let lastFrameAt = Number.NEGATIVE_INFINITY;

/** A "the mirror still has work in flight" predicate (see `registerPressureSource`). */
export type MirrorPressureSource = () => boolean;

/** The registered armed-work suppliers. Empty in production until MirrorView mounts, and empty again after it
 *  unmounts — so the signal degrades to pure frame recency rather than to a stale `true`. */
const sources = new Set<MirrorPressureSource>();

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** The mirror just produced a frame. Called from the render rAF and the animator tick — both hot paths, so
 *  this is deliberately one assignment. `now` is injectable for tests. */
export function noteMirrorFrame(now: number = defaultNow()): void {
  lastFrameAt = now;
}

/** Register an armed-work supplier and get its unregister.
 *
 *  WHY THIS EXISTS. The recency term above is measured from frames the mirror PRODUCED, and a long main-thread
 *  block suppresses exactly those. The Aug-19 Moto G86 trace is the proof: a 285 ms and a 1,163 ms task, 97% of
 *  their self-time inside native `toBlob`, stop the tick loop for their whole duration — so 250 ms after the
 *  block began this module reports QUIET while the thread is still jammed, and gsw's drain spends another
 *  readback into the hole. The trace's two recovery gaps (362 ms and 674 ms of no frames at all) are exactly that
 *  reading, taken at peak overload. The jam manufactures its own idle signal.
 *
 *  A supplier answers a different question: what is ARMED, not what has RUN. A missing frame then reads as a
 *  STARVED loop rather than as a finished animation, which is the only version of this signal a block cannot
 *  fake. Suppliers OR with the recency term and with each other.
 *
 *  COST: called once per gsw drain pass (i.e. per encode under `encode.perTask: 1`), never per frame — so a
 *  supplier may read live state directly, but must stay O(1)-ish. The two shipped ones are `Set.size` reads and
 *  a number compare.
 *
 *  A supplier that never goes false would latch the signal ON and leave gsw draining only at its
 *  `busyMaxDeferMs` bound — see mirrorRenderer's registration comment for why the shipped one is deliberately
 *  narrow. */
export function registerPressureSource(fn: MirrorPressureSource): () => void {
  sources.add(fn);
  return () => {
    sources.delete(fn);
  };
}

/** Is the mirror mid-burst? Handed to gsw as `encode.busy`, so it is called once per encode drain pass. */
export function mirrorFramePressure(now: number = defaultNow()): boolean {
  if (now - lastFrameAt < BUSY_IDLE_MS) {
    return true;
  }
  for (const source of sources) {
    // A throwing supplier is a bug in the supplier, not evidence of pressure — and it must not be able to blind
    // the terms after it. (gsw's own fail-open is coarser: a predicate that throws there drops ALL of them.)
    try {
      if (source() === true) {
        return true;
      }
    } catch {
      /* ignore — see above */
    }
  }
  return false;
}

/** TEST-ONLY: forget the last frame AND every registered supplier, so a spec starts from the cold
 *  (never-rendered, nothing-armed) state. Dropping the suppliers matters as much as the timestamp: a renderer
 *  left registered by an earlier spec would report its own state into this one. */
export function __resetMirrorFramePressureForTest(): void {
  lastFrameAt = Number.NEGATIVE_INFINITY;
  sources.clear();
}
