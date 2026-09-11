import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canChooseAssignment,
  computeMirrorJoinMode,
  connectionCountLabel,
  hasNameParam,
  isIosSafari,
  isMultiplayerMirrorMode,
  isNonJoinableMirrorMode,
  joinInfoFromSession,
  LAST_PLAYER_NAME_STORAGE_KEY,
  mirrorRosterFor,
  readStoredName,
  readUrlName,
  readUrlNameState,
  rememberJoinedName,
  seatIsClaimable,
  seatIsUnavailable,
  shouldReloadForUrlNameChange,
  shouldShowConnectionCount,
  shouldShowIosInstallHint,
  shouldWatchHostStream,
  trimName,
  urlNameStateFor,
  writeUrlNameParam,
  seatCharacterIconUrl,
  mirrorPickerNameLabel,
  mirrorPickerRosterHeading,
  shouldShowMirrorPickerTitle,
  type JoinStatus,
  type UrlNameState
} from "@/join/joinModel";
import type {
  BrowserPlayerOption,
  BrowserSessionEnvelope,
  MirrorScreenKind
} from "@/protocol/browserEnvelope";

function session(over: Partial<BrowserSessionEnvelope> = {}): BrowserSessionEnvelope {
  return {
    type: "session",
    session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 },
    players: [],
    screen: { kind: "lobby", type: "lobby", title: "Lobby", mirrorMode: "mp-character-select" },
    hostName: "host",
    scrollAction: true,
    rewardAction: true,
    ...over
  };
}

describe("joinInfoFromSession", () => {
  it("lifts roster + screen + assignment out of a session envelope", () => {
    const info = joinInfoFromSession(
      session({
        players: [{ playerId: "Alice", name: "Alice", isHost: false, isRunPlayer: true, connectionCount: 2, disconnected: false, isLocal: true, netId: null, isMirrorSeat: false, seatStatus: "ready", seatStatusReason: null, characterId: null }],
        screen: { kind: "run", type: "combat", title: "Combat", mirrorMode: "mp-run" },
        session: { name: "Alice", status: "joined", joined: true, playerId: "p1", connectionCount: 1 }
      }),
      "connected"
    );
    expect(info.screenKind).toBe("run");
    expect(info.screenTitle).toBe("Combat");
    expect(info.players).toHaveLength(1);
    expect(info.joined).toBe(true);
    expect(info.unaffiliated).toBe(false);
  });

  it("falls back to a null session (mirror before its first session) as title-less + empty roster", () => {
    const info = joinInfoFromSession(null, "connecting");
    expect(info.screenKind).toBeNull();
    expect(info.players).toEqual([]);
    expect(info.joined).toBe(false);
    expect(info.androidApkUrl).toBeNull();
  });

  it("lifts the host-served Android APK url when present, null otherwise", () => {
    expect(joinInfoFromSession(session({ androidApkUrl: "/couchcoop-client.apk" }), "connected").androidApkUrl)
      .toBe("/couchcoop-client.apk");
    expect(joinInfoFromSession(session(), "connected").androidApkUrl).toBeNull();
  });
});

describe("canChooseAssignment", () => {
  it("a connected, unjoined, idle viewer may choose", () => {
    expect(canChooseAssignment(joinInfoFromSession(session(), "connected"), null)).toBe(true);
  });

  it("while connecting (no session) → no", () => {
    expect(canChooseAssignment(joinInfoFromSession(null, "connecting"), null)).toBe(false);
  });

  it("an already-joined session → no", () => {
    const info = joinInfoFromSession(
      session({ session: { name: "Alice", status: "joined", joined: true, playerId: "p1", connectionCount: 1 } }),
      "connected"
    );
    expect(canChooseAssignment(info, null)).toBe(false);
  });

  it("a pending join always collapses the form, even for an explicitly-unaffiliated viewer", () => {
    const info = joinInfoFromSession(
      session({ session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 } }),
      "connected"
    );
    expect(canChooseAssignment(info, "Stale")).toBe(false);
  });
});

describe("computeMirrorJoinMode", () => {
  const connected = (over: Partial<BrowserSessionEnvelope> = {}) =>
    joinInfoFromSession(session(over), "connected");

  it("MP character-select → picker-with-name (picker + name field)", () => {
    const info = connected({ screen: { kind: "lobby", type: "lobby", title: "Lobby", mirrorMode: "mp-character-select" } });
    expect(computeMirrorJoinMode(info, null, "mp-character-select")).toBe("picker-with-name");
  });

  it("MP load-saved-game → picker (no name field)", () => {
    const info = connected({ screen: { kind: "lobby", type: "lobby", title: "Load", mirrorMode: "mp-load-game" } });
    expect(computeMirrorJoinMode(info, null, "mp-load-game")).toBe("picker");
  });

  it("MP run → picker (no name field)", () => {
    const info = connected({ screen: { kind: "run", type: "combat", title: "Combat", mirrorMode: "mp-run" } });
    expect(computeMirrorJoinMode(info, null, "mp-run")).toBe("picker");
  });

  it("singleplayer-run / main-menu / null → title-only (server directView handles direct entry)", () => {
    const sp = connected({ screen: { kind: "run", type: "combat", title: "Combat", mirrorMode: "singleplayer-run" } });
    expect(computeMirrorJoinMode(sp, null, "singleplayer-run")).toBe("title-only");
    const menu = connected({ screen: { kind: "unsupported", type: null, title: null, mirrorMode: "main-menu" } });
    expect(computeMirrorJoinMode(menu, null, "main-menu")).toBe("title-only");
    expect(computeMirrorJoinMode(connected(), null, null)).toBe("title-only");
  });

  // The SP character select is `kind: "lobby"` exactly like the MP one, so `kind` cannot tell them apart — only
  // `mirrorMode` can. It reaches title-only through the SAME fall-through as an unknown kind, which is the
  // design: a branch is added here only for a mode that needs a FORM. C# twin: JoinModelTests.
  it("singleplayer character select → title-only (a lobby nobody can join gets no join form)", () => {
    const sp = connected({
      screen: { kind: "lobby", type: "lobby", title: "Character Select", mirrorMode: "sp-character-select" }
    });
    expect(computeMirrorJoinMode(sp, null, "sp-character-select")).toBe("title-only");
  });

  it("a pending join collapses the picker to title-only (matches canChooseAssignment gating)", () => {
    const info = connected({ screen: { kind: "lobby", type: "lobby", title: "Lobby", mirrorMode: "mp-character-select" } });
    expect(computeMirrorJoinMode(info, "Stale", "mp-character-select")).toBe("title-only");
  });

  it("while connecting → title-only", () => {
    expect(computeMirrorJoinMode(joinInfoFromSession(null, "connecting"), null, "mp-character-select")).toBe("title-only");
  });
});

// WS-B STREAM GATE. The user-facing rule: connecting to a host that has multiplayer active (lobby, saved
// multiplayer game, or multiplayer run) must NOT stream/render the host's game in the background. It streams only
// once the viewer chose to control the host (directView) or a seat (joined), or when the host is off the
// multiplayer screens entirely. C# twin: JoinModel.ShouldWatchHostStream (JoinModelTests).
describe("shouldWatchHostStream", () => {
  const infoFor = (mirrorMode: MirrorScreenKind | null, status: JoinStatus = "connected") =>
    joinInfoFromSession(
      session({ screen: { kind: "lobby", type: "lobby", title: "Lobby", mirrorMode: mirrorMode ?? "unsupported" } }),
      status
    );
  const watch = (
    mirrorMode: MirrorScreenKind | null,
    opts: {
      pending?: string | null;
      status?: JoinStatus;
      joined?: boolean;
      directView?: boolean;
      seatIntent?: boolean;
    } = {}
  ) =>
    shouldWatchHostStream(
      infoFor(mirrorMode, opts.status ?? "connected"),
      opts.pending ?? null,
      mirrorMode,
      opts.joined ?? false,
      opts.directView ?? false,
      opts.seatIntent ?? false
    );

  it("does NOT stream the host while multiplayer is active", () => {
    expect(watch("mp-character-select")).toBe(false);
    expect(watch("mp-load-game")).toBe(false);
    expect(watch("mp-run")).toBe(false);
  });

  it("streams the host when it is not on a multiplayer screen", () => {
    expect(watch("main-menu")).toBe(true);
    expect(watch("singleplayer-run")).toBe(true);
    // The whole point of the sp-character-select kind: a phone MIRRORS the host's singleplayer lobby instead of
    // being shown a join form and a blank screen.
    expect(watch("sp-character-select")).toBe(true);
    expect(watch(null)).toBe(false); // incomplete session data never opens the stream gate
  });

  it("streams once the viewer has chosen a seat (joined) or the host (directView)", () => {
    expect(watch("mp-run", { joined: true })).toBe(true);
    expect(watch("mp-run", { directView: true })).toBe(true);
    expect(watch("mp-character-select", { joined: true })).toBe(true);
  });

  it("never streams on a transient state (join in flight / not connected)", () => {
    expect(watch("main-menu", { pending: "Alice" })).toBe(false);
    expect(watch("main-menu", { status: "connecting" })).toBe(false);
    expect(watch("main-menu", { status: "disconnected" })).toBe(false);
  });

  it("does not stream before the first session (no screen ⇒ unknown ⇒ gated)", () => {
    const noSession = joinInfoFromSession(null, "connected");
    expect(shouldWatchHostStream(noSession, null, null, false, false, false)).toBe(false);
    // ...unless direct-view was already granted (a reconnect keeps watching).
    expect(shouldWatchHostStream(noSession, null, null, false, true, false)).toBe(true);
  });

  // F3 — SEAT INTENT. `?name=Ann` in the page URL means "I am a player waiting for a seat", and a player is not a
  // spectator: until the seat is actually granted this viewer pulls NO scene bytes, not even on the screens a
  // param-less viewer is happily shown. The server never reads `?name=`, so this client-side answer — which is
  // what rides the `watch` wire — IS the enforcement.
  it("a URL that names a seat streams NOTHING, on every screen a viewer without one would watch", () => {
    expect(watch("main-menu", { seatIntent: true })).toBe(false);
    expect(watch("singleplayer-run", { seatIntent: true })).toBe(false);
    expect(watch("sp-character-select", { seatIntent: true })).toBe(false);
    expect(watch("unsupported", { seatIntent: true })).toBe(false);
    // …and the multiplayer screens were already gated; seat intent cannot make them less so.
    expect(watch("mp-character-select", { seatIntent: true })).toBe(false);
    expect(watch("mp-run", { seatIntent: true })).toBe(false);
    // Incomplete session data is gated while a seat is named too.
    expect(watch(null, { seatIntent: true })).toBe(false);
  });

  // The ordering that makes the marker safe to keep set for the whole session: an EXPLICIT GRANT outranks it.
  // The URL still says `?name=Ann` after the host serves that seat (that is what makes a reload land back in it),
  // so a seat-intent arm placed above these two would black out every joined viewer's own game.
  it("an explicit grant outranks seat intent (joined / directView still stream)", () => {
    expect(watch("mp-run", { seatIntent: true, joined: true })).toBe(true);
    expect(watch("singleplayer-run", { seatIntent: true, joined: true })).toBe(true);
    expect(watch("main-menu", { seatIntent: true, directView: true })).toBe(true);
    expect(watch("mp-character-select", { seatIntent: true, directView: true })).toBe(true);
  });

  it("leaves the param-less viewer exactly as it was (seat intent false = the pre-F3 answers)", () => {
    expect(watch("main-menu", { seatIntent: false })).toBe(true);
    expect(watch("singleplayer-run", { seatIntent: false })).toBe(true);
    expect(watch("mp-run", { seatIntent: false })).toBe(false);
  });
});

// F3 — the "no seat here" predicate the `?name=` rules key off. It is not the negation of
// isMultiplayerMirrorMode: null is reserved for the pre-session state.
describe("isNonJoinableMirrorMode", () => {
  it("is true for every screen the host says has no seat to claim", () => {
    expect(isNonJoinableMirrorMode("main-menu")).toBe(true);
    expect(isNonJoinableMirrorMode("sp-character-select")).toBe(true);
    expect(isNonJoinableMirrorMode("singleplayer-run")).toBe(true);
    expect(isNonJoinableMirrorMode("unsupported")).toBe(true);
  });

  it("is false for every multiplayer screen (those are exactly where a seat CAN be claimed)", () => {
    expect(isNonJoinableMirrorMode("mp-character-select")).toBe(false);
    expect(isNonJoinableMirrorMode("mp-load-game")).toBe(false);
    expect(isNonJoinableMirrorMode("mp-run")).toBe(false);
  });

  it("is false for null before a session identifies the screen", () => {
    expect(isNonJoinableMirrorMode(null)).toBe(false);
    expect(isMultiplayerMirrorMode(null)).toBe(false);
  });
});

const rosterPlayer = (over: Partial<BrowserPlayerOption> = {}): BrowserPlayerOption => ({
  playerId: "p",
  name: "P",
  isHost: false,
  isRunPlayer: true,
  connectionCount: 1,
  disconnected: false,
  isLocal: false,
  netId: null,
  isMirrorSeat: false,
  seatStatus: "ready",
  seatStatusReason: null,
  characterId: null,
  ...over
});

describe("mirrorRosterFor", () => {
  it("keeps host + mirror seats and drops genuine remote players", () => {
    const roster = mirrorRosterFor([
      rosterPlayer({ playerId: "p:1", name: "Hosty", isHost: true, netId: 1 }),
      rosterPlayer({ playerId: "p:1002", name: "Alice", netId: 1002, isMirrorSeat: true }),
      rosterPlayer({ playerId: "p:1000", name: "Remote", netId: 1000 })
    ]);
    expect(roster.map((p) => p.name)).toEqual(["Hosty", "Alice"]);
  });

  // THE REJOIN REGRESSION. A device that dropped out (or that just reloaded a saved game) has no local player at
  // all, so the old host+local filter offered it nothing but "Watch host". The mirror filter keys on the SEAT, so
  // the row survives and can be reclaimed.
  it("keeps a seat nobody is on, so a returning device can reclaim it", () => {
    const roster = mirrorRosterFor([
      rosterPlayer({ playerId: "p:1", name: "Hosty", isHost: true, netId: 1 }),
      rosterPlayer({
        playerId: "p:1003",
        name: "Player 1003",
        netId: 1003,
        isMirrorSeat: true,
        isLocal: false,
        disconnected: true,
        connectionCount: 0
      })
    ]);
    expect(roster.map((p) => p.name)).toEqual(["Hosty", "Player 1003"]);
  });

  // isLocal is irrelevant to the mirror filter in BOTH directions: a local non-seat row is still dropped.
  it("ignores isLocal", () => {
    const roster = mirrorRosterFor([
      rosterPlayer({ playerId: "local-but-not-a-seat", name: "Synthetic", isLocal: true }),
      rosterPlayer({ playerId: "p:1004", name: "Cara", netId: 1004, isMirrorSeat: true, isLocal: false })
    ]);
    expect(roster.map((p) => p.name)).toEqual(["Cara"]);
  });

});

// The per-row emphasis + secondary line, shared by both web pickers and (as C# twins in JoinModel.cs) the native
// JoinPanel. C# twin tests: JoinModelTests.RosterRowEmphasis / ConnectionCountIsShownOnlyForTwoOrMore.
describe("roster row presentation", () => {
  it("highlights a ready seat nobody is on, and nothing else", () => {
    expect(seatIsClaimable(rosterPlayer({ connectionCount: 0 }))).toBe(true);
    expect(seatIsClaimable(rosterPlayer({ connectionCount: 1 }))).toBe(false);
    // The host machine already drives that player, so its row is never the one to claim.
    expect(seatIsClaimable(rosterPlayer({ isHost: true, connectionCount: 0 }))).toBe(false);
    expect(seatIsClaimable(rosterPlayer({ connectionCount: 0, seatStatus: "offline" }))).toBe(false);
  });

  it("disables a non-ready seat, but never the host row", () => {
    expect(seatIsUnavailable(rosterPlayer())).toBe(false);
    expect(seatIsUnavailable(rosterPlayer({ seatStatus: "stuck" }))).toBe(true);
    expect(seatIsUnavailable(rosterPlayer({ seatStatus: "offline" }))).toBe(true);
    // A seat status on the host is meaningless and must not disable the one row that always works.
    expect(seatIsUnavailable(rosterPlayer({ isHost: true, seatStatus: "offline" }))).toBe(false);
  });

  // "0 controllers" read as a fault on a perfectly joinable row (the claimable highlight already says nobody is
  // there) and "1 controller" is simply the normal state — neither may be rendered anywhere.
  it("says the controller count only from 2 up", () => {
    expect(shouldShowConnectionCount(0)).toBe(false);
    expect(shouldShowConnectionCount(1)).toBe(false);
    expect(shouldShowConnectionCount(2)).toBe(true);
    expect(shouldShowConnectionCount(7)).toBe(true);
    expect(connectionCountLabel(2)).toBe("2 controllers");
    expect(connectionCountLabel(1)).toBe("1 controller");
  });
});

describe("name memory + ?name=", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("trimName trims and nulls blanks", () => {
    expect(trimName("  Bob  ")).toBe("Bob");
    expect(trimName("   ")).toBeNull();
    expect(trimName(null)).toBeNull();
  });

  it("readUrlName reads the ?name= page param", () => {
    expect(readUrlName({ href: "http://localhost/?name=%20Cara%20" })).toBe("Cara");
    expect(readUrlName({ href: "http://localhost/" })).toBeNull();
  });

  it("readStoredName returns the saved name (trimmed)", () => {
    sessionStorage.setItem(LAST_PLAYER_NAME_STORAGE_KEY, "  Dora  ");
    expect(readStoredName(sessionStorage)).toBe("Dora");
  });

  // PUSH, not replace: joining is a navigation the player must be able to reverse. A replaced entry left the
  // Back button pointing at whatever page the browser was on before the join screen, so there was no way back
  // to the picker short of hand-editing the address bar.
  it("rememberJoinedName persists the name and PUSHES ?name= into the URL", () => {
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    rememberJoinedName("  Eve  ", {
      storage: sessionStorage,
      history,
      location: { href: "http://localhost/" }
    });
    expect(sessionStorage.getItem(LAST_PLAYER_NAME_STORAGE_KEY)).toBe("Eve");
    expect(history.pushState).toHaveBeenCalledOnce();
    expect(String(history.pushState.mock.calls[0][2])).toContain("name=Eve");
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  // The guard that keeps the history stack honest: the auto-join path re-stamps the name it just READ out of
  // the URL, and a push there would bury the picker one extra Back press deep on every single reload.
  it("rememberJoinedName does not push when the URL already names this seat", () => {
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    rememberJoinedName("Eve", {
      storage: sessionStorage,
      history,
      location: { href: "http://localhost/?name=Eve" }
    });
    // …nor for a padded param that already IS this seat.
    rememberJoinedName("Eve", {
      storage: sessionStorage,
      history,
      location: { href: "http://localhost/?name=%20Eve%20" }
    });
    expect(history.pushState).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LAST_PLAYER_NAME_STORAGE_KEY)).toBe("Eve"); // storage still refreshed
  });
});

// The three-state param — absent / empty / value — is what lets a reload land the viewer back where they were.
// `readUrlName` deliberately cannot see the middle one (it trims to null), so every "which state is this?"
// decision goes through the helpers below.
describe("?name= param states", () => {
  it("hasNameParam is the absent-vs-empty distinction readUrlName cannot make", () => {
    expect(hasNameParam({ href: "http://localhost/" })).toBe(false);
    expect(hasNameParam({ href: "http://localhost/" })).toBe(false);
    expect(hasNameParam({ href: "http://localhost/?name=" })).toBe(true);
    expect(hasNameParam({ href: "http://localhost/?name=%20%20" })).toBe(true);
    expect(hasNameParam({ href: "http://localhost/?name=Ann" })).toBe(true);
    expect(hasNameParam({ href: "not a url" })).toBe(false);

    // …and the seat reader still collapses BOTH no-value forms to null, so an empty param never auto-joins.
    expect(readUrlName({ href: "http://localhost/?name=" })).toBeNull();
    expect(readUrlName({ href: "http://localhost/?name=%20%20" })).toBeNull();
  });

  it("readUrlNameState maps the three forms to absent / host / seat", () => {
    expect(readUrlNameState({ href: "http://localhost/" })).toEqual({ kind: "absent", name: null });
    expect(readUrlNameState({ href: "http://localhost/?name=" })).toEqual({ kind: "host", name: null });
    expect(readUrlNameState({ href: "http://localhost/?name=%20" })).toEqual({ kind: "host", name: null });
    expect(readUrlNameState({ href: "http://localhost/?name=%20Ann%20" })).toEqual({
      kind: "seat",
      name: "Ann"
    });
    expect(urlNameStateFor(null)).toEqual({ kind: "absent", name: null });
    expect(urlNameStateFor("")).toEqual({ kind: "host", name: null });
    expect(urlNameStateFor("Ann")).toEqual({ kind: "seat", name: "Ann" });
  });

  it("writeUrlNameParam pushes / replaces / clears, and no-ops when nothing changes", () => {
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    const at = (href: string) => ({ history, location: { href } });

    // The host marker is written as a PRESENT but EMPTY value — invisible to the server, visible to the next load.
    expect(writeUrlNameParam("", "push", at("http://localhost/"))).toBe(true);
    expect(String(history.pushState.mock.calls[0][2])).toBe("http://localhost/?name=");

    // Clearing a stale marker is a REPLACE: nobody navigated to the correction, so it must not cost a Back press.
    expect(writeUrlNameParam(null, "replace", at("http://localhost/?name="))).toBe(true);
    expect(String(history.replaceState.mock.calls[0][2])).toBe("http://localhost/");

    history.pushState.mockClear();
    history.replaceState.mockClear();
    // Equality guard, in all three forms.
    expect(writeUrlNameParam("", "push", at("http://localhost/?name="))).toBe(false);
    expect(writeUrlNameParam("Ann", "push", at("http://localhost/?name=Ann"))).toBe(false);
    expect(writeUrlNameParam(null, "replace", at("http://localhost/"))).toBe(false);
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();

    // A DIFFERENT seat is a real change (host marker → seat, and seat → seat).
    expect(writeUrlNameParam("Bob", "push", at("http://localhost/?name=Ann"))).toBe(true);
    expect(writeUrlNameParam("Ann", "push", at("http://localhost/?name="))).toBe(true);
    expect(history.pushState).toHaveBeenCalledTimes(2);
  });
});

// The Back/Forward decision matrix. `expected` is what the app believes it stamped; `actual` is the URL after
// the user navigated. Any difference is a state the current page cannot represent → full reload.
describe("shouldReloadForUrlNameChange", () => {
  const absent: UrlNameState = { kind: "absent", name: null };
  const host: UrlNameState = { kind: "host", name: null };
  const seat = (name: string): UrlNameState => ({ kind: "seat", name });

  it("reloads exactly when the effective join state differs", () => {
    // No-ops (the reload-loop guard): identical states never reload, whatever the kind.
    expect(shouldReloadForUrlNameChange(absent, absent)).toBe(false);
    expect(shouldReloadForUrlNameChange(host, host)).toBe(false);
    expect(shouldReloadForUrlNameChange(seat("Ann"), seat("Ann"))).toBe(false);

    // Back off a joined seat / a host view → the picker.
    expect(shouldReloadForUrlNameChange(seat("Ann"), absent)).toBe(true);
    expect(shouldReloadForUrlNameChange(host, absent)).toBe(true);
    // Forward back in from the picker.
    expect(shouldReloadForUrlNameChange(absent, seat("Ann"))).toBe(true);
    expect(shouldReloadForUrlNameChange(absent, host)).toBe(true);
    // Between two different join states.
    expect(shouldReloadForUrlNameChange(seat("Ann"), seat("Bob"))).toBe(true);
    expect(shouldReloadForUrlNameChange(seat("Ann"), host)).toBe(true);
    expect(shouldReloadForUrlNameChange(host, seat("Ann"))).toBe(true);
  });
});

// The predicate that decides whether a granted direct view is worth a URL marker. Deliberately independent of
// computeMirrorJoinMode's transient gates — those report title-only mid-join, which says nothing about the
// host's screen.
describe("isMultiplayerMirrorMode", () => {
  it("is true for the lobby, the saved-game lobby and an mp run only", () => {
    expect(isMultiplayerMirrorMode("mp-character-select")).toBe(true);
    expect(isMultiplayerMirrorMode("mp-load-game")).toBe(true);
    expect(isMultiplayerMirrorMode("mp-run")).toBe(true);
    expect(isMultiplayerMirrorMode("singleplayer-run")).toBe(false);
    // A character select whose lobby is SINGLEPLAYER is not a multiplayer context, however much it looks like
    // one: there is no seat behind it to mark a return path to.
    expect(isMultiplayerMirrorMode("sp-character-select")).toBe(false);
    expect(isMultiplayerMirrorMode("main-menu")).toBe(false);
    expect(isMultiplayerMirrorMode("unsupported")).toBe(false);
    expect(isMultiplayerMirrorMode(null)).toBe(false);
  });
});

describe("iOS Add-to-Home-Screen install hint", () => {
  const IPHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const IPAD_UA =
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
  const DESKTOP_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  it("isIosSafari matches iPhone/iPad/iPod and nothing else", () => {
    expect(isIosSafari(IPHONE_UA)).toBe(true);
    expect(isIosSafari(IPAD_UA)).toBe(true);
    expect(isIosSafari(ANDROID_UA)).toBe(false);
    expect(isIosSafari(DESKTOP_UA)).toBe(false);
    expect(isIosSafari(null)).toBe(false);
    expect(isIosSafari(undefined)).toBe(false);
  });

  it("shows the tip on iOS Safari that is not yet running standalone", () => {
    expect(shouldShowIosInstallHint({ userAgent: IPHONE_UA })).toBe(true);
    expect(
      shouldShowIosInstallHint({
        userAgent: IPHONE_UA,
        navigatorStandalone: false,
        displayModeStandalone: false
      })
    ).toBe(true);
  });

  it("hides the tip once launched from the home screen (either standalone signal)", () => {
    expect(shouldShowIosInstallHint({ userAgent: IPHONE_UA, navigatorStandalone: true })).toBe(false);
    expect(shouldShowIosInstallHint({ userAgent: IPHONE_UA, displayModeStandalone: true })).toBe(false);
  });

  it("never shows the tip on Android or desktop", () => {
    expect(shouldShowIosInstallHint({ userAgent: ANDROID_UA })).toBe(false);
    expect(shouldShowIosInstallHint({ userAgent: DESKTOP_UA })).toBe(false);
    expect(shouldShowIosInstallHint({ userAgent: null })).toBe(false);
  });
});

// The Android APK hint is gone (the native client is paused), and with it `isAndroid`/`androidInstallUrl`. The
// ENVELOPE field stays — the host still serves the route for side-loading a dev build — so `joinInfoFromSession`
// keeps lifting `androidApkUrl` (covered above); nothing in either view renders it.

// R19 WP-2c — the multiplayer lobby picker's copy.
//
// The screen used to open with a "Mirror" kicker and the game's own screen name as an <h1>, above a name field
// called "Add a player" and an unlabelled list of rows: three headings, none of which said which control did
// what. On a landscape phone with the keyboard up, the two decorative lines are also exactly what pushes the
// form off screen.
describe("mirror picker copy", () => {

  it("drops the kicker + screen title on a steady picker", () => {
    expect(
      shouldShowMirrorPickerTitle({ mode: "picker-with-name", transient: false, screenTitle: "Character Select" })
    ).toBe(false);
    expect(
      shouldShowMirrorPickerTitle({ mode: "picker", transient: false, screenTitle: "Run" })
    ).toBe(false);
  });

  it("KEEPS a transient lifecycle heading — it is the only feedback a waiting player gets", () => {
    // Joining…/Reconnecting…/Loading… also carry the spinner, so suppressing them would leave a screen that
    // looks idle while the host is still working. joinFailure.spec.ts gates on these too.
    expect(
      shouldShowMirrorPickerTitle({ mode: "picker-with-name", transient: true, screenTitle: "Character Select" })
    ).toBe(true);
  });

  it("keeps the heading when there is no screen title to replace it", () => {
    // The fallback is a real status line ("Waiting for the game…", "Disconnected") — feedback, not decoration.
    expect(shouldShowMirrorPickerTitle({ mode: "picker", transient: false, screenTitle: null })).toBe(true);
  });

  it("keeps the heading on the title-only screen, where it IS the screen", () => {
    expect(
      shouldShowMirrorPickerTitle({ mode: "title-only", transient: false, screenTitle: "Run" })
    ).toBe(true);
  });

  it("names each control, and reads as one choice with two branches", () => {
    expect(mirrorPickerNameLabel()).toBe("Join as new player");
    // "Or …" only where a name field sits above the rows; the bare form where the rows are the only way in.
    expect(mirrorPickerRosterHeading("picker-with-name")).toBe("Or join as any of the following players");
    expect(mirrorPickerRosterHeading("picker")).toBe("Join as any of the following players");
    expect(mirrorPickerRosterHeading("title-only")).toBeNull();
  });

});

// R19 WP-2d — the character icon beside each roster row. This is what makes seats tellable apart in the
// multiplayer SAVE lobby, where every row is otherwise just a name.
describe("seatCharacterIconUrl", () => {

  it("routes through the existing model-asset route, which already rasterises model:// keys", () => {
    // No new host route was needed for this feature; that is the point of going through modelAssetRoute.
    expect(seatCharacterIconUrl({ characterId: "ironclad" })).toBe("/models/characters/ironclad/icon");
  });

  it("yields nothing when the seat has no character", () => {
    // A row with no icon is correct; a row with a BROKEN image is worse than the plain name it replaced.
    expect(seatCharacterIconUrl({ characterId: null })).toBeNull();
    expect(seatCharacterIconUrl({ characterId: "" })).toBeNull();
    expect(seatCharacterIconUrl({ characterId: "   " })).toBeNull();
  });

});
