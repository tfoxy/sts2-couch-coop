import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  atlasBakeStats,
  atlasRegionBlobUrl,
  onAtlasRegionsReady,
  __atlasBakeTuningForTest,
  __resetAtlasCacheForTest,
  type AtlasRegion
} from "@/mirror/atlasBaker";

// R10-PERF6 WS-P2 — THE BAKE QUEUE'S TWO PRIORITIES.
//
// Shipping the hidden-sprite warm-up means a session goes from ~54 region bakes to ~780,
// and every one of them is SPECULATIVE: nobody is looking at the screen it belongs to. That changes what the
// single one-at-a-time drain has to guarantee, in two ways this file pins:
//
//   1. ORDER — a region a VISIBLE node is waiting on must never queue behind speculation. The drain is strictly
//      one bake per task, so a map that opens while a ~700-deep warm queue is still draining would otherwise put
//      every one of its own regions at the back of it.
//   2. EXPOSURE — a slow SPECULATIVE bake must not trip the session-wide sticky revert. That switch turns the
//      whole div/blob mechanism off for the rest of the session, and its failure mode lands on precisely the
//      screen being warmed: mechanism off ⇒ every sprite mounts a <canvas> ⇒ the measured 1,535-layer map open.
//
// The fixtures fake the whole encode path (Image → OffscreenCanvas → convertToBlob) so a test can choose which
// bake resolves when, and how long each one "took".

const ATLAS = "/atlas.png";
const r = (x: number): AtlasRegion => ({ x, y: 0, width: 8, height: 8 });

let images: FakeImage[] = [];
class FakeImage {
  private loaders: Array<() => void> = [];
  decoding = "";
  crossOrigin = "";
  src = "";
  constructor() {
    images.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    if (type === "load") this.loaders.push(cb);
  }
  removeEventListener(_type: string, cb: () => void): void {
    const i = this.loaders.indexOf(cb);
    if (i >= 0) this.loaders.splice(i, 1);
  }
  fireLoad(): void {
    for (const cb of [...this.loaders]) cb();
  }
}

// Every convertToBlob call parks here until the test resolves it, in the order the drain issued them — which is
// exactly the observable this file asserts on.
let pending: Array<{ resolve: (b: Blob | null) => void }> = [];
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
    return new Promise((resolve) => {
      pending.push({ resolve: (b) => resolve(b as Blob) });
    });
  }
}

// A clock the test advances by hand, so "this bake took 900ms" needs no real time.
let clockMs = 0;
/**
 * Main-thread ms every bake's draw costs, billed inside the bake's synchronous segment. Aug-14: the strike
 * criterion reads THAT, not wall (`settleBake`'s argument), because the phone session that motivated the change
 * spent 91.4% of its bake wall time off the main thread and tripped the switch anyway. A test that wants a bake
 * to strike must set this BEFORE the bake is issued — the drain starts the next one inside the previous settle.
 */
let syncCostMs = 0;

/** Settle the oldest in-flight bake, having taken `tookMs`. Returns after the promise callbacks have run. */
async function settleBake(tookMs: number): Promise<void> {
  const job = pending.shift();
  expect(job, "a bake was in flight").toBeDefined();
  clockMs += tookMs;
  job!.resolve(new Blob([""]));
  await Promise.resolve();
  await Promise.resolve();
}

/** Settle the oldest in-flight bake as a GENUINE failure: the encode produced no blob (a tainted/refused draw). */
async function failBake(tookMs = 1): Promise<void> {
  const job = pending.shift();
  expect(job, "a bake was in flight").toBeDefined();
  clockMs += tookMs;
  job!.resolve(null);
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Advance BOTH clocks by `ms`: the fake timers (which drive the suspension's re-arm) and the stubbed
 * `performance.now` the baker times bakes and ages strikes with. They are separate stubs in this file, so a test
 * that moved only one would prove nothing about the other.
 */
async function advanceClock(ms: number): Promise<void> {
  clockMs += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  __resetAtlasCacheForTest();
  images = [];
  pending = [];
  clockMs = 0;
  syncCostMs = 0;
  vi.useFakeTimers();
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  vi.stubGlobal("createImageBitmap", undefined);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas as unknown as typeof OffscreenCanvas);
  vi.stubGlobal("performance", { now: () => clockMs } as unknown as Performance);
  vi.stubGlobal("URL", {
    createObjectURL: (b: Blob) => `blob:${String(b)}`,
    revokeObjectURL: () => {}
  } as unknown as typeof URL);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetAtlasCacheForTest();
});

/** Ask for `x`'s blob; `nodeId` null = the speculative warm-up, a string = a node waiting on it. */
function request(x: number, nodeId: string | null): void {
  atlasRegionBlobUrl(ATLAS, r(x), nodeId);
}

/** Let the atlas decode and run the drain far enough to issue the next bake. */
async function pump(): Promise<void> {
  await vi.advanceTimersByTimeAsync(32);
}

describe("atlas bake queue priority", () => {
  it("drains an URGENT region before speculative ones queued before it", async () => {
    request(0, null); // warm-up: three regions nobody is looking at
    request(1, null);
    request(2, null);
    request(3, "node-3"); // …and then a visible node asks for its own
    images[0].fireLoad(); // the atlas decodes → everything enqueues
    await pump();

    // The FIRST bake the drain issued must be the urgent one, despite three warm regions arriving first.
    await settleBake(1);
    expect(atlasRegionBlobUrl(ATLAS, r(3), null)).not.toBeNull();
    expect(atlasRegionBlobUrl(ATLAS, r(0), null)).toBeNull();
  });

  it("promotes a region that was queued speculatively and has since gained a waiter", async () => {
    request(0, null);
    request(1, null);
    request(2, null);
    images[0].fireLoad();
    await pump();
    // Region 0's bake is already in flight (one per task), so settle it and let the drain pick the next — by
    // which time a node is waiting on region 2, which was queued LAST.
    request(2, "node-2");
    await settleBake(1);
    await pump();
    await settleBake(1);

    expect(atlasRegionBlobUrl(ATLAS, r(2), null), "the promoted region baked second").not.toBeNull();
    expect(atlasRegionBlobUrl(ATLAS, r(1), null), "the un-promoted one is still waiting").toBeNull();
  });

  it("keeps plain FIFO order when nothing is speculative (today's behaviour, unchanged)", async () => {
    request(0, "a");
    request(1, "b");
    request(2, "c");
    images[0].fireLoad();
    await pump();
    await settleBake(1);
    await pump();
    await settleBake(1);

    expect(atlasRegionBlobUrl(ATLAS, r(0), null)).not.toBeNull();
    expect(atlasRegionBlobUrl(ATLAS, r(1), null)).not.toBeNull();
    expect(atlasRegionBlobUrl(ATLAS, r(2), null), "third in, third out").toBeNull();
  });
});

/** A bake that blocks the main thread far past BAKE_SLOW_MS — i.e. one that earns a strike. */
const BLOCKING_MS = 900;

describe("sticky revert exposure", () => {
  it("slow SPECULATIVE bakes never disable the mechanism", async () => {
    syncCostMs = BLOCKING_MS;
    for (let x = 0; x < 5; x++) request(x, null);
    images[0].fireLoad();
    await pump();

    for (let i = 0; i < 4; i++) {
      await settleBake(1); // pathologically slow, four times over — but nobody is waiting on any of them
      await pump();
    }

    expect(atlasBakeStats.slow).toBe(0);
    expect(atlasBakeStats.disabled).toBe(false);
    expect(atlasBakeStats.baked).toBeGreaterThan(0);
  });

  it("slow URGENT bakes still disable it after the limit (the protection is untouched)", async () => {
    syncCostMs = BLOCKING_MS;
    for (let x = 0; x < 5; x++) request(x, `node-${x}`);
    images[0].fireLoad();
    await pump();

    await settleBake(1);
    await pump();
    await settleBake(1);
    await pump();
    expect(atlasBakeStats.disabled, "two slow bakes are under the limit").toBe(false);
    await settleBake(1);

    expect(atlasBakeStats.slow).toBe(3);
    expect(atlasBakeStats.disabled).toBe(true);
    expect(atlasBakeStats.disabledReason).toBe("sync");
  });
});

// R11 R4-RESIDUALS — THE REVERT HAS TO HEAL.
//
// The revert above used to be a SESSION-DEATH LATCH, and a real phone (moto g86) tripped it on its first screens:
// {"baked":20,"slow":3,"slowestMs":3762,"disabled":true}. What followed was permanent — a 941-canvas / 1,888-layer
// map open, and combat traces holding 2,029ms and 2,705ms main-thread tasks on ~100ms of CPU (blocked on the GPU
// process). Worse than any bake. A live re-arm probe then found that flipping `disabled` back would NOT have
// recovered it: every region the session had asked for was parked in `regionFailed` forever, so 28s and a deck-view
// open that mounted 82 canvases produced 0 bake requests. These specs pin the mechanism that replaced it.
describe("slow-bake backoff decay", () => {
  // Aug-14: a strike is MAIN-THREAD time, so every bake in this block is armed to block past BAKE_SLOW_MS. The
  // arming has to happen before a bake is ISSUED (the draw is billed when the drain starts it), which is why it
  // lives here rather than inside trip().
  beforeEach(() => {
    syncCostMs = BLOCKING_MS;
  });

  /** Trip the backoff with BAKE_SLOW_LIMIT slow urgent bakes; returns with the mechanism suspended. */
  async function trip(): Promise<void> {
    for (let i = 0; i < __atlasBakeTuningForTest.BAKE_SLOW_LIMIT; i++) {
      await settleBake(1);
      await pump();
    }
  }

  it("suspends instead of latching, parking (not failing) the queue it dropped", async () => {
    const { BAKE_SUSPEND_MS } = __atlasBakeTuningForTest;
    for (let x = 0; x < 6; x++) request(x, `node-${x}`);
    images[0].fireLoad();
    await pump();
    await trip();

    expect(atlasBakeStats.disabled, "baking is off RIGHT NOW").toBe(true);
    expect(atlasBakeStats.trips).toBe(1);
    expect(atlasBakeStats.suspendedUntilMs, "…but only until a deadline").toBe(clockMs + BAKE_SUSPEND_MS);
    expect(atlasBakeStats.strikes, "the strike window resets with the trip").toBe(0);
    expect(atlasBakeStats.parked, "the three unbaked regions are parked, not failed").toBe(3);

    // Nothing bakes while the suspension runs.
    await advanceClock(BAKE_SUSPEND_MS - 1000);
    expect(pending.length).toBe(0);
    expect(atlasBakeStats.disabled).toBe(true);
  });

  it("re-arms on its own timer and re-queues the parked regions, waiters intact", async () => {
    const { BAKE_SUSPEND_MS } = __atlasBakeTuningForTest;
    const restyled: string[] = [];
    const unwire = onAtlasRegionsReady((ids) => restyled.push(...ids));
    for (let x = 0; x < 6; x++) request(x, `node-${x}`);
    images[0].fireLoad();
    await pump();
    await trip();
    restyled.length = 0;

    // NOTHING asks for a blob in between: this is the static screen the live probe watched (a map just sitting
    // there re-styles nothing), so only the suspension's own timer can bring the mechanism back.
    await advanceClock(BAKE_SUSPEND_MS);

    expect(atlasBakeStats.rearms).toBe(1);
    expect(atlasBakeStats.requeued, "every parked region went back on the queue").toBe(3);
    expect(atlasBakeStats.parked).toBe(0);
    expect(pending.length, "and the drain is running again").toBe(1);

    await settleBake(1);
    expect(atlasRegionBlobUrl(ATLAS, r(3), null), "the first parked region baked").not.toBeNull();
    expect(restyled, "its waiter was kept, so the landing bake re-styles that node").toContain("node-3");
    unwire();
  });

  it("re-arms opportunistically when a node asks again after the deadline (a throttled timer)", async () => {
    const { BAKE_SUSPEND_MS } = __atlasBakeTuningForTest;
    for (let x = 0; x < 6; x++) request(x, `node-${x}`);
    images[0].fireLoad();
    await pump();
    await trip();

    clockMs += BAKE_SUSPEND_MS; // the deadline passes with the timers frozen (a backgrounded tab)
    request(9, "node-9"); // …and a re-styling node reaches the baker
    expect(atlasBakeStats.disabled).toBe(false);
    expect(atlasBakeStats.rearms).toBe(1);

    await pump();
    expect(pending.length).toBe(1);
  });

  it("does NOT trip on slow bakes spread wider than the decay window (the phone's actual baseline)", async () => {
    const { BAKE_STRIKE_DECAY_MS, BAKE_SLOW_LIMIT } = __atlasBakeTuningForTest;
    for (let x = 0; x < 8; x++) request(x, `node-${x}`);
    images[0].fireLoad();
    await pump();

    // Three slow bakes — the count that killed the phone's session — but scattered across it, which is what a
    // low-end device doing occasional work looks like rather than a device whose encode path is pathological now.
    for (let i = 0; i < BAKE_SLOW_LIMIT + 1; i++) {
      await settleBake(900);
      await advanceClock(BAKE_STRIKE_DECAY_MS + 1000);
    }

    expect(atlasBakeStats.slow, "they were all counted…").toBe(BAKE_SLOW_LIMIT + 1);
    expect(atlasBakeStats.strikes, "…but only the newest is live").toBe(1);
    expect(atlasBakeStats.disabled).toBe(false);
    expect(atlasBakeStats.trips).toBe(0);
  });

  it("escalates the backoff when a re-arm re-trips, so a slow device cannot thrash", async () => {
    const { BAKE_SUSPEND_MS } = __atlasBakeTuningForTest;
    for (let x = 0; x < 6; x++) request(x, `node-${x}`);
    images[0].fireLoad();
    await pump();
    await trip();
    await advanceClock(BAKE_SUSPEND_MS);

    // The re-armed regions are just as slow as the ones before them.
    await trip();

    expect(atlasBakeStats.trips).toBe(2);
    expect(atlasBakeStats.disabled).toBe(true);
    expect(
      atlasBakeStats.suspendedUntilMs - clockMs,
      "the second consecutive trip waits twice as long"
    ).toBe(BAKE_SUSPEND_MS * 2);
  });

  it("keeps GENUINE failures failed across a re-arm (only parked regions come back)", async () => {
    const { BAKE_SUSPEND_MS } = __atlasBakeTuningForTest;
    syncCostMs = 0; // region 0's bake is cheap AND fails: a failure must not double as a strike here
    for (let x = 0; x < 6; x++) request(x, `node-${x}`);
    images[0].fireLoad();
    await pump();

    await failBake(); // region 0's encode produced no blob — that region can never bake
    syncCostMs = BLOCKING_MS; // …and the regions after it are the pathological ones
    await pump();
    await trip(); // regions 1-3 bake slowly and trip the backoff; 4 and 5 park

    expect(atlasBakeStats.failed).toBe(1);
    expect(atlasBakeStats.parked).toBe(2);

    await advanceClock(BAKE_SUSPEND_MS);
    expect(atlasBakeStats.requeued, "the failed region is NOT among the re-queued").toBe(2);

    await settleBake(1);
    await pump();
    await settleBake(1);
    await pump();
    expect(atlasRegionBlobUrl(ATLAS, r(4), null)).not.toBeNull();
    expect(atlasRegionBlobUrl(ATLAS, r(5), null)).not.toBeNull();
    expect(atlasRegionBlobUrl(ATLAS, r(0), "node-0"), "the genuine failure stays failed").toBeNull();
    await pump();
    expect(pending.length, "and asking for it again queues nothing").toBe(0);
  });

});
