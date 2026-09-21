import { describe, expect, it } from "vitest";
import { parseBrowserEnvelope } from "@/protocol/browserEnvelope";
import { replaySession } from "../../../../scripts/lib/replay-session.mjs";

describe("replay watch admission", () => {
  it("supplies a session the current browser accepts without a recorded session", () => {
    expect(parseBrowserEnvelope(replaySession([]))).toMatchObject({ type: "session", directView: true });
  });

  it("preserves recorded asset and screen metadata while granting local direct view", () => {
    const recorded = { ...JSON.parse(replaySession([])), directView: false, hostName: "Recorded",
      assetCacheToken: "fixture-build", headlessMirrorPort: 12345, joinRejection: "unavailable" };
    const raw = JSON.stringify(recorded);
    const session = parseBrowserEnvelope(replaySession([{ data: raw }]));
    expect(session).toMatchObject({ type: "session", directView: true, hostName: "Recorded",
      assetCacheToken: "fixture-build", headlessMirrorPort: null, joinRejection: null });
    expect(JSON.stringify(recorded)).toBe(raw);
  });
});
