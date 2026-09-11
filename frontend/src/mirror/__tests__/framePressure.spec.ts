import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetMirrorFramePressureForTest,
  mirrorFramePressure,
  noteMirrorFrame,
  registerPressureSource
} from "@/mirror/framePressure";

// THE SIGNAL behind gsw's `encode.busy` (see framePressure.ts): "did this pipeline produce a frame in the
// last 250 ms?". Everything here drives the module's injected clock rather than the wall clock, because the
// contract is a pure function of two numbers and that is the only way to pin the edges of the window.
//
// What matters, in order of what would hurt if it broke:
//   1. FAIL OPEN when cold — a viewer that has never rendered must report QUIET, or its fleet never freezes
//      at all (gsw's bound would still drain it, but a slice per 3 s instead of a slice per 120 ms);
//   2. the window OUTLASTS the gap between frames of a burst, so a burst reads as one busy window rather
//      than as N instants with encodable holes between them;
//   3. it closes on its own — no "end of burst" call exists to forget, so quiet is reached by the clock.

describe("mirror frame pressure", () => {
  beforeEach(() => {
    __resetMirrorFramePressureForTest();
  });

  it("reports QUIET before any frame has ever been noted (the cold viewer fails open)", () => {
    expect(mirrorFramePressure(0)).toBe(false);
    expect(mirrorFramePressure(1_000_000)).toBe(false);
  });

  it("is busy from the frame until the window closes, and quiet from its edge on", () => {
    noteMirrorFrame(1000);
    expect(mirrorFramePressure(1000)).toBe(true); // the same instant the frame landed
    expect(mirrorFramePressure(1100)).toBe(true); // a 10 fps phone's NEXT frame is still inside it
    expect(mirrorFramePressure(1249)).toBe(true); // last busy millisecond
    expect(mirrorFramePressure(1250)).toBe(false); // the edge itself is quiet
    expect(mirrorFramePressure(5000)).toBe(false);
  });

  it("re-opens the window on every frame, so a BURST is one continuous busy stretch", () => {
    // Five frames 100 ms apart — the shape of a card-flight burst on a slow device. There is no instant
    // between the first and the last where an encode could slip in.
    for (const at of [1000, 1100, 1200, 1300, 1400]) {
      noteMirrorFrame(at);
      expect(mirrorFramePressure(at + 99)).toBe(true);
    }
    // …and it goes quiet on its own a window after the LAST one, with nothing to call.
    expect(mirrorFramePressure(1649)).toBe(true);
    expect(mirrorFramePressure(1650)).toBe(false);
  });

  it("a frame noted in the past cannot make the present busy", () => {
    noteMirrorFrame(1000);
    expect(mirrorFramePressure(2000)).toBe(false);
    // A late note with a STALE timestamp (a caller passing its own cached `now`) reads as what it is: the
    // pressure is measured from the timestamp, not from the call.
    noteMirrorFrame(1500);
    expect(mirrorFramePressure(2000)).toBe(false);
  });

  it("defaults both clocks to the real one — the production path passes no arguments at all", () => {
    expect(mirrorFramePressure()).toBe(false); // still cold
    noteMirrorFrame();
    expect(mirrorFramePressure()).toBe(true);
  });

});

// THE SECOND TERM — armed-work suppliers (`registerPressureSource`).
//
// The hole this closes is specific and was measured: the recency term is made of frames the mirror PRODUCED, and
// a long readback stops the loop that produces them. The Aug-19 Moto G86 trace has a 285 ms task and a 1,163 ms
// task, plus two recovery gaps of 362 ms and 674 ms with no frames at all — every one of them longer than the
// 250 ms window, so the signal reported QUIET at peak overload and gsw's drain spent another readback into it.
// A supplier reports what is ARMED instead, which a blocked main thread cannot suppress.
describe("mirror frame pressure — armed-work sources", () => {
  beforeEach(() => {
    __resetMirrorFramePressureForTest();
  });

  it("keeps the mirror busy through a frame gap the jank itself created", () => {
    // The exact traced shape: a frame at 1000, then a ~700 ms task during which nothing renders. Recency alone
    // calls 1700 quiet — which is the false idle that let the NEXT readback pile into the same jam.
    noteMirrorFrame(1000);
    expect(mirrorFramePressure(1700), "recency alone reads this gap as idle").toBe(false);

    registerPressureSource(() => true);
    expect(mirrorFramePressure(1700)).toBe(true);
    expect(mirrorFramePressure(1_000_000), "armed work has no expiry — it is state, not recency").toBe(true);
  });

  it("is enough on its own, with no frame EVER noted", () => {
    // A cold viewer whose first walk is already booked: nothing has rendered, so there is no recency to read.
    registerPressureSource(() => true);
    expect(mirrorFramePressure(0)).toBe(true);
  });

  it("unregister restores the pure frame-recency signal", () => {
    const unregister = registerPressureSource(() => true);
    expect(mirrorFramePressure(5000)).toBe(true);
    unregister();
    expect(mirrorFramePressure(5000)).toBe(false);
    noteMirrorFrame(5000);
    expect(mirrorFramePressure(5000), "the other term still works after an unregister").toBe(true);
  });

  it("unregistering twice is harmless, and does not drop a LATER registration", () => {
    // Both real call sites are teardown paths (a renderer dispose, a component unmount) and either can run
    // twice; a second call must not remove someone else's source.
    const unregister = registerPressureSource(() => false);
    unregister();
    unregister();
    registerPressureSource(() => true);
    expect(mirrorFramePressure(5000)).toBe(true);
  });

  it("ORs the sources together — any one of them is pressure", () => {
    let flightsArmed = false;
    let walkBooked = false;
    registerPressureSource(() => flightsArmed);
    registerPressureSource(() => walkBooked);
    expect(mirrorFramePressure(5000)).toBe(false);
    flightsArmed = true;
    expect(mirrorFramePressure(5000)).toBe(true);
    flightsArmed = false;
    walkBooked = true;
    expect(mirrorFramePressure(5000)).toBe(true);
    walkBooked = false;
    expect(mirrorFramePressure(5000), "and it goes quiet again when the last one retires").toBe(false);
  });

  it("only `true` counts — a truthy non-boolean is not pressure", () => {
    // The registry is typed, but the callers are plain closures over live state and gsw's own predicate contract
    // is `=== true`. Matching it here keeps the two layers reading the same way.
    registerPressureSource(() => 1 as unknown as boolean);
    expect(mirrorFramePressure(5000)).toBe(false);
  });

  it("ignores a THROWING source without blinding the terms after it", () => {
    // gsw's own fail-open is coarser than ours: a predicate that throws there drops every term at once. Here a
    // broken supplier must cost only itself — otherwise one bug in one animator silently disables the deferral.
    registerPressureSource(() => {
      throw new Error("supplier bug");
    });
    expect(mirrorFramePressure(5000), "a throw is not evidence of pressure").toBe(false);
    registerPressureSource(() => true);
    expect(mirrorFramePressure(5000), "the source AFTER the thrower is still consulted").toBe(true);
    // …and neither is the recency term blinded by it.
    __resetMirrorFramePressureForTest();
    registerPressureSource(() => {
      throw new Error("supplier bug");
    });
    noteMirrorFrame(1000);
    expect(mirrorFramePressure(1100)).toBe(true);
  });

  it("with no source registered the signal is byte-identical to the recency-only one", () => {
    // The regression guard for every consumer that has not opted in — including this module's own production
    // path before MirrorView mounts. A registered-then-unregistered source must leave nothing behind.
    registerPressureSource(() => true)();
    expect(mirrorFramePressure(0)).toBe(false); // cold
    noteMirrorFrame(1000);
    expect(mirrorFramePressure(1000)).toBe(true);
    expect(mirrorFramePressure(1249)).toBe(true);
    expect(mirrorFramePressure(1250)).toBe(false);
    expect(mirrorFramePressure(5000)).toBe(false);
  });

  it("`__resetMirrorFramePressureForTest` clears the sources, not just the clock", () => {
    // Load-bearing for spec isolation: a renderer left registered by an earlier spec would answer into this one.
    registerPressureSource(() => true);
    __resetMirrorFramePressureForTest();
    expect(mirrorFramePressure(5000)).toBe(false);
  });
});
