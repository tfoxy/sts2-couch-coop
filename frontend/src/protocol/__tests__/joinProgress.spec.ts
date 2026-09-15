import { describe, expect, it } from "vitest";

import { parseBrowserEnvelopeValue, parseJoinProgress } from "@/protocol/browserEnvelope";

// `join-progress` — the host's running commentary on a join it has not answered yet.
//
// The bar for accepting one is high on purpose: the line it renders is a confident sentence about what the host
// is doing RIGHT NOW ("Starting this player's game — step 3 of 6, 23s so far"), so a frame missing any part of
// that must produce no line at all rather than one assembled from defaults. The failure this protects against is
// the one the feature exists to fix, inverted: a viewer being told something reassuring that is not true.

const PROGRESS = {
  type: "join-progress",
  requestId: "join:1",
  stage: "initializing",
  step: 3,
  stepTotal: 6,
  elapsedMs: 23_400
};

describe("parseJoinProgress", () => {
  it("reads a full progress frame", () => {
    expect(parseJoinProgress(PROGRESS)).toEqual({
      requestId: "join:1",
      stage: "initializing",
      step: 3,
      stepTotal: 6,
      elapsedMs: 23_400
    });
  });

  it("accepts every stage token the host can send", () => {
    for (const stage of ["connecting", "choosing", "initializing", "joining", "loading-view", "complete", "failed"]) {
      expect(parseJoinProgress({ ...PROGRESS, stage })?.stage, stage).toBe(stage);
    }
  });

  it("refuses an unknown stage rather than inventing words for it", () => {
    // A future host stage this build has no copy for must fall back to the plain spinner. The allowlist is
    // exact, not a prefix test.
    expect(parseJoinProgress({ ...PROGRESS, stage: "loadingView" })).toBeNull();
    expect(parseJoinProgress({ ...PROGRESS, stage: "loading-view-2" })).toBeNull();
    expect(parseJoinProgress({ ...PROGRESS, stage: 4 })).toBeNull();
  });

  it("refuses a frame with no usable request id", () => {
    // Progress that cannot be matched to the join in flight is worse than no progress: it would animate a screen
    // for an attempt the viewer has already abandoned.
    expect(parseJoinProgress({ ...PROGRESS, requestId: "" })).toBeNull();
    expect(parseJoinProgress({ ...PROGRESS, requestId: undefined })).toBeNull();
    expect(parseJoinProgress({ ...PROGRESS, requestId: 7 })).toBeNull();
  });

  it("refuses missing, non-finite or negative counts instead of coercing them", () => {
    for (const field of ["step", "stepTotal", "elapsedMs"]) {
      expect(parseJoinProgress({ ...PROGRESS, [field]: undefined }), field).toBeNull();
      expect(parseJoinProgress({ ...PROGRESS, [field]: "3" }), field).toBeNull();
      expect(parseJoinProgress({ ...PROGRESS, [field]: Number.NaN }), field).toBeNull();
      expect(parseJoinProgress({ ...PROGRESS, [field]: -1 }), field).toBeNull();
    }
    // A fractional millisecond count is real data, just imprecise — floored, not refused.
    expect(parseJoinProgress({ ...PROGRESS, elapsedMs: 999.9 })?.elapsedMs).toBe(999);
  });

  it("refuses anything that is not a join-progress frame", () => {
    expect(parseJoinProgress({ ...PROGRESS, type: "session" })).toBeNull();
    expect(parseJoinProgress(null)).toBeNull();
    expect(parseJoinProgress("join-progress")).toBeNull();
    expect(parseJoinProgress(undefined)).toBeNull();
  });

  it("stays outside the request/reply envelope union", () => {
    // Deliberate: `BrowserEnvelope` is the surface every client branches on, and this is a one-way notification
    // the mirror client picks off the socket itself. Keeping it out is what leaves an older client's
    // "unknown type → drop" behaviour exactly as it was.
    expect(() => parseBrowserEnvelopeValue(PROGRESS)).toThrow(/Unsupported browser envelope type/);
  });
});
