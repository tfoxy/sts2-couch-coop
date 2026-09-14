import { describe, expect, it } from "vitest";

import { parseBrowserEnvelope, parseBrowserEnvelopeValue } from "@/protocol/browserEnvelope";

// PARSE ONCE. The mirror client parses every incoming frame itself (it dispatches on `raw.type` before it knows
// whether the frame is even an envelope), and then used to hand the ORIGINAL STRING to `parseBrowserEnvelope`,
// which parsed it a second time. `parseBrowserEnvelopeValue` is that same parse with the `JSON.parse` lifted out.
//
// The contract this spec pins is EQUIVALENCE, not merely "it works": the two entry points must produce the same
// envelope for the same bytes, and — the part that is easy to lose in a refactor — must FAIL the same way, because
// the client's `catch` around the session parse is what keeps a malformed frame from taking the socket down.

// A session frame with something from every normalizer the session branch runs: roster, notices, screen and the
// static-background descriptor.
const SESSION = {
  type: "session",
  requestId: "join:1",
  viewerId: "viewer-1",
  session: { name: "Nyx", status: "joined", joined: true, playerId: "p:1003", connectionCount: 2 },
  players: [
    {
      playerId: "p:1003",
      name: "Nyx",
      isHost: false,
      isRunPlayer: true,
      connectionCount: 1,
      disconnected: false,
      isLocal: true,
      netId: 1003,
      isMirrorSeat: true,
      seatStatus: "offline",
      seatStatusReason: "a run is already in progress",
      characterId: "ironclad"
    },
    { playerId: "host", name: "host", netId: null, isHost: true, isRunPlayer: false, connectionCount: 1, disconnected: false, isLocal: false, isMirrorSeat: false, seatStatus: "ready", seatStatusReason: null, characterId: null }
  ],
  screen: { kind: "run", type: "CombatScreen", title: "Combat", mirrorMode: "mp-run" },
  notices: [{ code: "unsupported_capability", severity: "warning", capabilityId: "cap-1", supported: false }],
  assignmentNotices: [{ severity: "info", message: "seated" }],
  headlessMirrorPort: 13401,
  directView: false,
  refreshRate: 24,
  freezeParticles: true,
  freezeSpines: false,
  androidApkUrl: "/couchcoop-client.apk",
  hostName: "living-room-pc",
  staticBackground: { scenePath: "res://scenes/bg.tscn", url: "/bg/combat" },
  atlasManifest: {
    directory: "res://images/atlases/",
    pages: ["res://images/atlases/card_atlas_0.png", "res://images/atlases/card_atlas_1.png"]
  },
  scrollAction: true,
  rewardAction: true
};

describe("parseBrowserEnvelopeValue — the string and object entry points agree", () => {
  it.each([
    ["session", SESSION],
    ["server-reload", { type: "server-reload", reason: "headless-host-disconnected" }],
    ["action-result", { type: "action-result", code: "refused", message: "no", notices: [{ code: "x" }] }],
    ["error", { type: "error", code: "boom", message: "broke" }]
  ])("round-trips a %s envelope identically through both paths", (_label, message) => {
    const json = JSON.stringify(message);
    expect(parseBrowserEnvelopeValue(JSON.parse(json))).toEqual(parseBrowserEnvelope(json));
  });

  it("normalizes the session envelope exactly as the string path did", () => {
    const json = JSON.stringify(SESSION);
    const viaValue = parseBrowserEnvelopeValue(JSON.parse(json));
    const viaString = parseBrowserEnvelope(json);

    expect(viaValue.type).toBe("session");
    // Spot-check the normalizers rather than trusting the deep-equal alone: a shared bug in BOTH paths would
    // still compare equal, so the values themselves are asserted once.
    expect(viaValue).toEqual(viaString);
    expect(viaValue).toMatchObject({
      type: "session",
      headlessMirrorPort: 13401,
      directView: false,
      scrollAction: true,
      rewardAction: true
    });
    const session = viaValue as Extract<typeof viaValue, { type: "session" }>;
    expect(session.players?.[0]?.netId).toBe(1003);
    expect(session.players?.[0]?.seatStatus).toBe("offline");
    expect(session.players?.[1]?.netId).toBeNull();
    expect(session.screen?.mirrorMode).toBe("mp-run");
    expect(session.staticBackground?.url).toBe("/bg/combat");
    expect(session.atlasManifest?.directory).toBe("res://images/atlases/");
    expect(session.atlasManifest?.pages).toEqual([
      "res://images/atlases/card_atlas_0.png",
      "res://images/atlases/card_atlas_1.png"
    ]);
  });

  // The atlas manifest tells the idle prefetch which pages this host's build actually ships, so a half-formed one
  // must read as "unknown" (walk the compiled-in list) and never as "this build ships no atlases", which would
  // silently turn the prefetch off. Absent is the older-host case and has to stay clean.
  it("treats a half-formed atlasManifest as absent, and keeps a usable one", () => {
    const manifestOf = (atlasManifest: unknown) => {
      const parsed = parseBrowserEnvelopeValue({ ...SESSION, atlasManifest });
      return (parsed as Extract<typeof parsed, { type: "session" }>).atlasManifest;
    };

    for (const junk of [
      undefined,
      null,
      "res://images/atlases/",
      { pages: ["res://images/atlases/card_atlas_0.png"] },        // no directory
      { directory: "", pages: ["res://images/atlases/x.png"] },     // blank directory
      { directory: "res://images/atlases/" },                        // no pages
      { directory: "res://images/atlases/", pages: [] },             // …or none left
      { directory: "res://images/atlases/", pages: [3, "", null] },  // …or none usable
      { directory: "res://images/atlases/", pages: "card_atlas_0" }  // pages is not a list
    ]) {
      expect(manifestOf(junk)).toBeNull();
    }

    // One junk entry costs that entry, not the manifest: the other real pages are still answers.
    expect(manifestOf({ directory: "res://images/atlases/", pages: ["res://images/atlases/a.png", 7, ""] }))
      .toEqual({ directory: "res://images/atlases/", pages: ["res://images/atlases/a.png"] });
  });

  it("rejects incomplete current semantic support and identity/status fields", () => {
    const missingSupport = { ...SESSION } as Record<string, unknown>;
    delete missingSupport.scrollAction;
    expect(() => parseBrowserEnvelopeValue(missingSupport)).toThrow("scrollAction");

    const missingRewardAction = { ...SESSION } as Record<string, unknown>;
    delete missingRewardAction.rewardAction;
    expect(() => parseBrowserEnvelopeValue(missingRewardAction)).toThrow("rewardAction");

    expect(() => parseBrowserEnvelopeValue({ ...SESSION, scrollAction: "true" }))
      .toThrow("scrollAction");
    expect(() => parseBrowserEnvelopeValue({ ...SESSION, rewardAction: 0 }))
      .toThrow("rewardAction");
    expect(() => parseBrowserEnvelopeValue({ ...SESSION, scrollAction: false }))
      .toThrow("scrollAction");
    expect(() => parseBrowserEnvelopeValue({ ...SESSION, rewardAction: false }))
      .toThrow("rewardAction");
    expect(() => parseBrowserEnvelopeValue({ ...SESSION, hostName: null }))
      .toThrow("hostName");

    const missingSeatStatus = {
      ...SESSION,
      players: [{ ...SESSION.players[0], seatStatus: undefined }]
    };
    expect(() => parseBrowserEnvelopeValue(missingSeatStatus)).toThrow("roster entry");

    const missingNetId = {
      ...SESSION,
      players: [{ ...SESSION.players[0], netId: undefined }]
    };
    expect(() => parseBrowserEnvelopeValue(missingNetId)).toThrow("roster entry");

    const missingSessionName = {
      ...SESSION,
      session: { ...SESSION.session, name: undefined }
    };
    expect(() => parseBrowserEnvelopeValue(missingSessionName)).toThrow("session assignment");
  });

  it("fails the same way on a frame that is not an envelope", () => {
    // An object whose `type` is not one we speak: the same Error, from both paths.
    expect(() => parseBrowserEnvelope('{"type":"scene-delta"}')).toThrow("Unsupported browser envelope type.");
    expect(() => parseBrowserEnvelopeValue({ type: "scene-delta" })).toThrow("Unsupported browser envelope type.");
    // A frame carrying a plausible-looking BODY but an unknown `type` is refused on the type alone — no
    // half-built envelope gets back to the caller, which is what the mirror client's catch is written against.
    expect(() => parseBrowserEnvelopeValue({ type: "telemetry", sequence: 4, players: [] }))
      .toThrow("Unsupported browser envelope type.");
    expect(() => parseBrowserEnvelope("7")).toThrow("Unsupported browser envelope type.");
    expect(() => parseBrowserEnvelopeValue(7)).toThrow("Unsupported browser envelope type.");
    // `null` reads `.type` off nothing — a TypeError on both, which is what the mirror client's catch expects.
    expect(() => parseBrowserEnvelope("null")).toThrow(TypeError);
    expect(() => parseBrowserEnvelopeValue(null)).toThrow(TypeError);
  });

  // `screen.mirrorMode` is gated by MIRROR_SCREEN_KINDS, a hand-kept twin of the producer
  // (BrowserAssignmentClassifier.MirrorModeFor) and of SessionEnvelope.MirrorScreenKinds in C#.
  it("accepts every mirrorMode the host can send, and only those", () => {
    const modeOf = (mirrorMode: string) => {
      const parsed = parseBrowserEnvelopeValue({
        type: "session",
        session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 },
        players: [],
        hostName: "host",
        scrollAction: true,
        rewardAction: true,
        screen: { kind: "lobby", type: null, title: null, mirrorMode }
      });
      return (parsed as Extract<typeof parsed, { type: "session" }>).screen?.mirrorMode;
    };

    for (const kind of [
      "singleplayer-run",
      "mp-run",
      "mp-character-select",
      "sp-character-select",
      "mp-load-game",
      "main-menu",
      "unsupported"
    ]) {
      expect(modeOf(kind)).toBe(kind);
    }

    // Exact match, not a prefix or substring test.
    expect(() => modeOf("bogus")).toThrow("session screen");
    expect(() => modeOf("sp-character-selection")).toThrow("session screen");
    expect(() => modeOf("")).toThrow("session screen");
  });
});
