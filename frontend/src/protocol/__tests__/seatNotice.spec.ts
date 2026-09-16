import { describe, expect, it } from "vitest";

import { parseBrowserEnvelopeValue, parseSeatNotice } from "@/protocol/browserEnvelope";

// `seat-notice` — the host's own named verdict about why this viewer's seat is not serving them.
//
// The message it renders tells a player which of several UNRELATED things to go and fix: a program on the host's
// computer, the host's firewall, or their own Wi-Fi. So the bar for accepting a frame is the cause being one this
// build actually has words for. Anything else falls back to silence — the screen this had before the envelope
// existed — rather than to a guess about whose fault it is.

const NOTICE = {
  type: "seat-notice",
  cause: "network-path",
  detail: "This player's game is running and answering on the host, but the device never reached it."
};

describe("parseSeatNotice", () => {
  it("reads a full notice", () => {
    expect(parseSeatNotice(NOTICE)).toEqual({ cause: "network-path", detail: NOTICE.detail });
  });

  it("accepts every cause token the host can send", () => {
    for (const cause of ["none", "port-conflict", "host-local-block", "network-path"]) {
      expect(parseSeatNotice({ ...NOTICE, cause })?.cause, cause).toBe(cause);
    }
  });

  it("refuses an unknown cause rather than inventing a fix for it", () => {
    // A future host cause this build has no copy for must produce no message at all: the alternative is sending a
    // player to their router settings for something that happened on somebody else's computer. Exact allowlist,
    // not a prefix test.
    expect(parseSeatNotice({ ...NOTICE, cause: "networkPath" })).toBeNull();
    expect(parseSeatNotice({ ...NOTICE, cause: "network-path-2" })).toBeNull();
    expect(parseSeatNotice({ ...NOTICE, cause: "still-starting" })).toBeNull();
    expect(parseSeatNotice({ ...NOTICE, cause: 3 })).toBeNull();
    expect(parseSeatNotice({ ...NOTICE, cause: undefined })).toBeNull();
  });

  it("reads a withdrawal, which carries no detail", () => {
    // The host takes a notice back with the same envelope and the `none` cause, so a client has one parse path
    // and an older client drops both frames identically.
    expect(parseSeatNotice({ type: "seat-notice", cause: "none" })).toEqual({ cause: "none", detail: null });
  });

  it("keeps the cause when the technical detail is missing or unusable", () => {
    // The detail is what a player QUOTES; the cause is what they ACT on. Losing the grey line is a far smaller
    // loss than losing the message it explains, so a bad detail is dropped rather than refusing the frame.
    expect(parseSeatNotice({ type: "seat-notice", cause: "port-conflict" }))
      .toEqual({ cause: "port-conflict", detail: null });
    expect(parseSeatNotice({ ...NOTICE, detail: "" })).toEqual({ cause: "network-path", detail: null });
    expect(parseSeatNotice({ ...NOTICE, detail: 42 })).toEqual({ cause: "network-path", detail: null });
  });

  it("refuses anything that is not a seat-notice frame", () => {
    expect(parseSeatNotice({ ...NOTICE, type: "session" })).toBeNull();
    expect(parseSeatNotice(null)).toBeNull();
    expect(parseSeatNotice("seat-notice")).toBeNull();
    expect(parseSeatNotice(undefined)).toBeNull();
  });

  it("stays outside the request/reply envelope union", () => {
    // Deliberate, exactly as `join-progress` is: `BrowserEnvelope` is the surface every client branches on, and
    // this is a one-way notification the mirror client picks off the socket itself. Keeping it out leaves an
    // older client's "unknown type → drop" behaviour exactly as it was.
    expect(() => parseBrowserEnvelopeValue(NOTICE)).toThrow(/Unsupported browser envelope type/);
  });
});
