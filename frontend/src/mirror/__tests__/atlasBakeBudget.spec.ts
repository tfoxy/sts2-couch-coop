// The atlas region-bake DRAIN contract (Aug-11 phone regression).
//
// A bake is asynchronous, so the old `while (queue) { bake(); if (over budget) break; }` drain measured ~0ms per
// job and emptied the whole queue into ONE task — every `convertToBlob` then encoded concurrently and a Mali-G57
// phone blocked its main thread for 3.1s on ~20 regions during map load. These specs pin the two rules that
// replaced it: exactly one bake in flight ON THE INLINE PATH (jsdom has no Worker, so that is what these run), and
// a device whose bakes are pathological loses the mechanism instead of the frame rate.
//
// Aug-14: "pathological" is now MAIN-THREAD time (BAKE_SLOW_MS) with a much higher WALL backstop (BAKE_STALL_MS),
// so the fixture below has to charge the two separately — `syncCostMs` is billed inside `drawImage`, i.e. inside
// the bake's synchronous segment, and `settleOne`'s wall is billed while the encode is outstanding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __atlasBakeTuningForTest,
  __resetAtlasCacheForTest,
  atlasBakeStats,
  atlasRegionBlobUrl
} from "@/mirror/atlasBaker";

// A controllable fake Image (the atlas page) — the bake only starts once its page has "decoded".
let images: FakeImage[] = [];
class FakeImage {
  private handlers: Record<string, Array<() => void>> = {};
  decoding = "";
  crossOrigin = "";
  src = "";
  constructor() {
    images.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    (this.handlers[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    const list = this.handlers[type] ?? [];
    const i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  }
  fireLoad(): void {
    for (const cb of this.handlers.load ?? []) cb();
  }
}

// A fake OffscreenCanvas whose convertToBlob is resolved BY THE TEST, so "in flight" is observable. `drawImage`
// bills `syncCostMs` to the manual clock: that call sits inside the bake's synchronous segment, so it is exactly
// how a device with an expensive readback/draw shows up in `syncMs`.
let pending: Array<(blob: Blob | null) => void> = [];
let convertCalls = 0;
let syncCostMs = 0;
class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number
  ) {}
  getContext(): { drawImage: () => void } {
    return {
      drawImage: () => {
        clockMs += syncCostMs;
      }
    };
  }
  convertToBlob(): Promise<Blob> {
    convertCalls += 1;
    return new Promise((resolve) => {
      pending.push(resolve as (blob: Blob | null) => void);
    });
  }
}

// The clock the baker times bakes with, advanced by hand. Separate from the fake timers (which only drive the
// drain's setTimeout) so a test can say "this bake waited 900ms of WALL" without also spending 900ms of tasks.
let clockMs = 0;

const settleOne = async (elapsedMs = 0): Promise<void> => {
  const resolve = pending.shift();
  expect(resolve).toBeDefined();
  clockMs += elapsedMs; // wall spent with the encode outstanding — not main-thread time
  resolve!({ size: 1 } as unknown as Blob);
  await vi.advanceTimersByTimeAsync(20); // let the continuation + the next drain task run
};

function requestRegion(i: number): void {
  atlasRegionBlobUrl("/atlas.png", { x: i, y: 0, width: 8, height: 8 }, `node-${i}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetAtlasCacheForTest();
  images = [];
  pending = [];
  convertCalls = 0;
  syncCostMs = 0;
  clockMs = 0;
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  vi.stubGlobal("createImageBitmap", undefined);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas as unknown as typeof OffscreenCanvas);
  vi.stubGlobal("performance", { now: () => clockMs } as unknown as Performance);
  vi.stubGlobal("URL", { createObjectURL: (b: Blob) => `blob:${String(b)}`, revokeObjectURL: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetAtlasCacheForTest();
});

describe("atlas bake drain", () => {
  it("bakes ONE region at a time — a decoded page never pours its whole queue into one task", async () => {
    for (let i = 0; i < 5; i++) requestRegion(i);
    images[0].fireLoad(); // the page decodes: all 5 regions become bakeable at once
    await vi.advanceTimersByTimeAsync(1);

    expect(convertCalls).toBe(1); // …and exactly one encode is in flight

    await settleOne();
    expect(convertCalls).toBe(2); // the NEXT one starts only after the previous settled

    await settleOne();
    expect(convertCalls).toBe(3);
    expect(atlasBakeStats.baked).toBe(2);
    expect(pending.length).toBe(1); // never more than one outstanding
  });

  it("sticky-reverts the mechanism after BAKE_SLOW_LIMIT MAIN-THREAD-slow bakes; the rest stay on canvas", async () => {
    const { BAKE_SLOW_MS, BAKE_SLOW_LIMIT } = __atlasBakeTuningForTest;
    expect([BAKE_SLOW_MS, BAKE_SLOW_LIMIT]).toEqual([50, 3]);

    syncCostMs = BAKE_SLOW_MS + 5; // every bake blocks this thread past the threshold
    for (let i = 0; i < 8; i++) requestRegion(i);
    images[0].fireLoad();
    await vi.advanceTimersByTimeAsync(1);

    for (let i = 0; i < BAKE_SLOW_LIMIT; i++) {
      await settleOne();
    }

    expect(atlasBakeStats.slow).toBe(BAKE_SLOW_LIMIT);
    expect(atlasBakeStats.disabled).toBe(true);
    expect(atlasBakeStats.disabledReason).toBe("sync");
    expect(atlasBakeStats.slowestSyncMs).toBeGreaterThanOrEqual(BAKE_SLOW_MS);

    // No further encode is started, however long we wait…
    const started = convertCalls;
    await vi.advanceTimersByTimeAsync(500);
    expect(convertCalls).toBe(started);
    expect(pending.length).toBe(0);

    // …and a region asked for AFTER the revert answers null (the caller keeps painting through its canvas)
    // without queueing anything.
    atlasRegionBlobUrl("/atlas.png", { x: 900, y: 0, width: 8, height: 8 }, "node-late");
    await vi.advanceTimersByTimeAsync(500);
    expect(convertCalls).toBe(started);
  });

  it("STAGE-C intent frames ride the SAME one-at-a-time drain (N frames, one waiter node, serialized encodes)", async () => {
    // The img-path intent glyph bakes each FRAME region through atlasRegionBlobUrl with the glyph node as the
    // waiter — exactly the shape below. The drain contract must hold unchanged: one encode in flight, ever.
    const frames = [0, 1, 2, 3].map((i) => ({ x: i * 48, y: 0, width: 48, height: 51 }));
    for (const region of frames) {
      expect(atlasRegionBlobUrl("/atlas.png", region, "glyph")).toBeNull();
    }
    images[0].fireLoad(); // the page decodes: all 4 frames become bakeable at once
    await vi.advanceTimersByTimeAsync(1);

    expect(convertCalls).toBe(1);
    await settleOne();
    expect(convertCalls).toBe(2);
    await settleOne();
    await settleOne();
    await settleOne();
    expect(convertCalls).toBe(4);
    expect(atlasBakeStats.baked).toBe(4);
    // Every frame ended as its own cached blob (the img path's per-frame src set).
    for (const region of frames) {
      expect(atlasRegionBlobUrl("/atlas.png", region, null)).toMatch(/^blob:/);
    }
  });

  it("a fast bake keeps the mechanism, and a slow one that LANDED is still published", async () => {
    const { BAKE_SLOW_MS } = __atlasBakeTuningForTest;
    syncCostMs = BAKE_SLOW_MS + 5;
    requestRegion(0);
    requestRegion(1);
    images[0].fireLoad();
    await vi.advanceTimersByTimeAsync(1);

    // Bake 0 was ISSUED (and billed its 55ms draw) at fireLoad; clearing the cost now only affects bake 1, which
    // the settle continuation is about to start.
    syncCostMs = 0;
    await settleOne(); // slow, but it produced pixels
    expect(atlasBakeStats.slow).toBe(1);
    expect(atlasBakeStats.disabled).toBe(false);
    expect(atlasRegionBlobUrl("/atlas.png", { x: 0, y: 0, width: 8, height: 8 }, null)).toMatch(/^blob:/);

    await settleOne(1);
    expect(atlasBakeStats.baked).toBe(2);
    expect(atlasBakeStats.slow).toBe(1);
  });

  // R11 (Aug-14) — WHICH TIME IS THE DAMAGE. The phone that motivated this measured 4,502.6ms of bake WALL
  // against 385.3ms of main thread and tripped three times anyway, stranding 41 regions on the canvas path. Wall
  // is a wait (`convertToBlob` encodes as an idle task and a busy page starves it), so it may no longer strike on
  // its own — but a genuine multi-second stall still has to be able to trip the mechanism.
  it("does NOT strike on a bake with huge WALL time but tiny main-thread time", async () => {
    const { BAKE_SLOW_LIMIT } = __atlasBakeTuningForTest;
    syncCostMs = 1; // the main thread is free; the bake is just waiting
    for (let i = 0; i < 8; i++) requestRegion(i);
    images[0].fireLoad();
    await vi.advanceTimersByTimeAsync(1);

    for (let i = 0; i < BAKE_SLOW_LIMIT + 2; i++) {
      await settleOne(900); // 900ms of wall each — the shape of the measured phone session
    }

    expect(atlasBakeStats.slow, "no main-thread strike").toBe(0);
    expect(atlasBakeStats.stalled, "…and 900ms is under the stall backstop too").toBe(0);
    expect(atlasBakeStats.disabled).toBe(false);
    expect(atlasBakeStats.slowestMs).toBeGreaterThanOrEqual(900);
    expect(atlasBakeStats.slowestSyncMs).toBeLessThan(50);
    expect(atlasBakeStats.baked).toBe(BAKE_SLOW_LIMIT + 2);
  });

  // Aug-14 (second revision): this is the INLINE path — jsdom has no Worker — and its wall backstop is unchanged.
  // There is no pool queue and no separate page decode here, so a bake's wall IS its encode's wall and 2,000ms is
  // still a fair reading of "stuck". The worker path's wall is three unrelated things added together and gets its
  // own, encode-only criterion instead (BAKE_WORKER_STALL_MS; see atlasBakeWorkers.spec.ts).
  it("still trips on the WALL backstop when bakes stall past BAKE_STALL_MS", async () => {
    const { BAKE_STALL_MS, BAKE_STALL_LIMIT, BAKE_WORKER_STALL_MS } = __atlasBakeTuningForTest;
    expect([BAKE_STALL_MS, BAKE_STALL_LIMIT]).toEqual([2000, 3]);
    expect(BAKE_WORKER_STALL_MS, "the worker path is judged on ENCODE, at its own threshold").toBe(1000);
    syncCostMs = 1;
    for (let i = 0; i < 8; i++) requestRegion(i);
    images[0].fireLoad();
    await vi.advanceTimersByTimeAsync(1);

    await settleOne(BAKE_STALL_MS + 100);
    await settleOne(BAKE_STALL_MS + 100);
    expect(atlasBakeStats.disabled, "two stalls are under the limit").toBe(false);
    await settleOne(BAKE_STALL_MS + 100);

    expect(atlasBakeStats.stalled).toBe(BAKE_STALL_LIMIT);
    expect(atlasBakeStats.slow, "the main thread was never the problem").toBe(0);
    expect(atlasBakeStats.slowestInlineMs, "…and the inline encode's own wall is what fired").toBeGreaterThanOrEqual(
      BAKE_STALL_MS
    );
    expect(atlasBakeStats.disabled).toBe(true);
    expect(atlasBakeStats.disabledReason).toBe("stall");
    expect([atlasBakeStats.syncTrips, atlasBakeStats.stallTrips]).toEqual([0, 1]);
    expect(atlasBakeStats.trips).toBe(1);
  });
});
