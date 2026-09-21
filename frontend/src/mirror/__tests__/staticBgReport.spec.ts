import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetStaticBgReportForTest,
  noteStaticBgAttempt,
  noteStaticBgDecode,
  noteStaticBgFailure,
  noteStaticBgLatch,
  staticBgReport
} from "@/mirror/staticBgReport";

// Static backgrounds fail closed: a picture failure leaves a valid same-target still or a blank stage while the
// live scenery remains held. The reporter records that otherwise silent image outcome without changing settings.
//
// A REPORTER, NOT A RETRY: `/bg/` is a HOST route and `serve-res-root.mjs` serves `/res/**` only, so on a bench leg
// without the host there is nothing behind the URL and a retry buys latency. The failure is environmental; what
// was missing was the ability to see it.
describe("staticBg image reporter", () => {
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
