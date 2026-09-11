import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetStaticBgReportForTest,
  noteStaticBgAttempt,
  noteStaticBgDecode,
  noteStaticBgFailure,
  noteStaticBgLatch,
  staticBgReport
} from "@/mirror/staticBgReport";

// R7 W1 fix (e). `?staticBg` is fail-open by design: a picture that cannot be fetched or decoded latches
// `staticBgFailed`, the suppression is released and the LIVE background subtree renders instead. That is correct
// and deliberately silent — which is the problem. On combat the two states differ by 22 fx surfaces (10 vs 32) and
// 28.5 MB of textures (80.3 vs 108.8), so a session that latched unnoticed produced numbers describing a scene
// nobody chose to measure. Round 6's phone matrix logged ~16 `/bg/` 404s per cell and left no artifact that could
// answer "did it fire".
//
// A REPORTER, NOT A RETRY: `/bg/` is a HOST route and `serve-res-root.mjs` serves `/res/**` only, so on a bench leg
// without the host there is nothing behind the URL and a retry buys latency. The failure is environmental; what
// was missing was the ability to see it.
describe("staticBg fail-open reporter", () => {
  beforeEach(() => {
    __resetStaticBgReportForTest();
  });

  it("starts at a measured zero, unlatched", () => {
    const r = staticBgReport();
    expect(r.attempts).toBe(0);
    expect(r.latches).toBe(0);
    expect(r.latched).toBe(false);
    expect(r.lastUrl).toBeNull();
  });

  it("records a successful decode without latching", () => {
    noteStaticBgAttempt("/bg/combat.png");
    noteStaticBgDecode();
    const r = staticBgReport();
    expect(r.attempts).toBe(1);
    expect(r.decodes).toBe(1);
    expect(r.failures).toBe(0);
    expect(r.latched).toBe(false);
    expect(r.lastUrl).toBe("/bg/combat.png");
    expect(r.lastFailedUrl).toBeNull();
  });

  // THE FIELD THAT NAMES WHAT 404'd. Round 6 could see 404s in a log and could not connect them to a latch.
  it("keeps the failing url, and keeps it after a later success", () => {
    noteStaticBgAttempt("/bg/overgrowth.png");
    noteStaticBgFailure(false);
    noteStaticBgLatch(true);
    noteStaticBgAttempt("/bg/combat.png");
    noteStaticBgDecode();
    noteStaticBgLatch(false);
    const r = staticBgReport();
    // `lastUrl` moved on; `lastFailedUrl` did not — a recovery must not erase the evidence of the failure.
    expect(r.lastUrl).toBe("/bg/combat.png");
    expect(r.lastFailedUrl).toBe("/bg/overgrowth.png");
  });

  // A stalled fetch and a missing file are different defects and need different fixes.
  it("separates watchdog fires from decode failures", () => {
    noteStaticBgAttempt("/bg/a.png");
    noteStaticBgFailure(false);
    noteStaticBgAttempt("/bg/b.png");
    noteStaticBgFailure(true);
    const r = staticBgReport();
    expect(r.failures).toBe(2);
    expect(r.watchdogFires).toBe(1);
  });

  // TRANSITIONS, NOT A LEVEL — the whole point. A background that failed and then recovered reads `latched: false`
  // at settle and is indistinguishable from one that never failed, which is the same blind spot the canvas stage's
  // post-settle `contextLost` had.
  it("counts latch transitions so a recovered failure is still visible", () => {
    noteStaticBgLatch(true);
    noteStaticBgLatch(false);
    const r = staticBgReport();
    expect(r.latched).toBe(false);
    expect(r.latches).toBe(1);
    expect(r.unlatches).toBe(1);
  });

  it("ignores a repeated latch of the same value, matching the component's transition guard", () => {
    noteStaticBgLatch(true);
    noteStaticBgLatch(true);
    noteStaticBgLatch(true);
    expect(staticBgReport().latches).toBe(1);
  });

  it("hands out a copy, so a caller cannot mutate the live counters", () => {
    noteStaticBgAttempt("/bg/a.png");
    const snapshot = staticBgReport();
    snapshot.attempts = 999;
    expect(staticBgReport().attempts).toBe(1);
  });
});
