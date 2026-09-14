using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.MirrorProtocol.Join;

namespace CouchCoop.MirrorProtocol.Tests;

// Port of the pure-decision cases from frontend/src/join/__tests__/joinModel.spec.ts (joinInfoFromSession,
// canChooseAssignment, computeMirrorJoinMode, trimName). The browser-only storage/URL cases (readUrlName /
// readStoredName / rememberJoinedName) and the stateful computeJoinMode aren't ported — they don't live in the lib.
internal static class JoinModelTests
{
    public static void Run()
    {
        LiftsRosterScreenAssignmentOutOfSession();
        NullSessionIsTitlelessEmptyRoster();
        ScreenTitleFallsBackToType();
        ComputeMirrorJoinModeAllModes();
        CanChooseAssignmentGating();
        TrimNameTrimsAndNullsBlanks();
        MirrorRosterForKeepsHostAndSeats();
        SessionEnvelopeParsesIsLocal();
        SessionEnvelopeParsesMirrorSeatFields();
        SeatStatusVocabulary();
        ShouldWatchHostStreamGate();
        RosterRowEmphasis();
        ConnectionCountIsShownOnlyForTwoOrMore();
    }

    // The picker's per-row emphasis, shared by all three pickers (both web templates + the native JoinPanel). The
    // rule the user reported into existence: the HOST row is never special-cased into a highlight or a disabled
    // state, a READY seat nobody holds is THE row to claim, and a non-ready seat is genuinely un-joinable.
    private static void RosterRowEmphasis()
    {
        SessionPlayerOption Row(bool isHost = false, int connections = 0, string status = MirrorSeatStatuses.Ready) =>
            new("p:1003", "Player 1003", IsHost: isHost, IsRunPlayer: true, ConnectionCount: connections,
                Disconnected: connections == 0, IsLocal: false, NetId: 1003, IsMirrorSeat: !isHost, SeatStatus: status);

        Check.Equal(JoinModel.SeatIsClaimable(Row()), true, "a ready seat with no controller is the row to claim");
        Check.Equal(JoinModel.SeatIsClaimable(Row(connections: 1)), false, "a held seat is plain, not highlighted");
        Check.Equal(JoinModel.SeatIsClaimable(Row(isHost: true)), false, "the host row is never highlighted, even at 0 controllers");
        Check.Equal(
            JoinModel.SeatIsClaimable(Row(status: MirrorSeatStatuses.Offline)),
            false,
            "an un-joinable seat is never highlighted, whatever its controller count");

        Check.Equal(JoinModel.SeatIsUnavailable(Row()), false, "a ready seat is tappable");
        Check.Equal(JoinModel.SeatIsUnavailable(Row(status: MirrorSeatStatuses.Stuck)), true, "a lobby zombie is disabled");
        Check.Equal(JoinModel.SeatIsUnavailable(Row(status: MirrorSeatStatuses.Offline)), true, "a mid-run offline seat is disabled");
        Check.Equal(
            JoinModel.SeatIsUnavailable(Row(isHost: true, status: MirrorSeatStatuses.Offline)),
            false,
            "a seat status on the HOST row is meaningless and must never disable the one row that always works");
    }

    // The controller count is words ONLY at 2+. "0 controllers" read as a fault on a perfectly joinable row (the
    // claimable highlight already carries "nobody is here") and "1 controller" is just the normal state, so neither
    // may ever be rendered — in the native picker or either web picker.
    private static void ConnectionCountIsShownOnlyForTwoOrMore()
    {
        Check.Equal(JoinModel.ShouldShowConnectionCount(0), false, "0 controllers is never shown");
        Check.Equal(JoinModel.ShouldShowConnectionCount(1), false, "1 controller is never shown");
        Check.Equal(JoinModel.ShouldShowConnectionCount(2), true, "2+ controllers is the unusual case worth saying");
        Check.Equal(JoinModel.ShouldShowConnectionCount(7), true, "…and so is any higher count");

        Check.Equal(JoinModel.ConnectionCountLabel(2), "2 controllers", "plural copy");
        Check.Equal(JoinModel.ConnectionCountLabel(1), "1 controller", "singular copy stays correct (unreachable via the gate)");
    }

    // WS-B STREAM GATE. The user-facing rule this encodes: connecting to a host that has multiplayer active (lobby,
    // saved multiplayer game, or multiplayer run) must NOT stream/render the host's game in the background — that
    // only happens once the viewer has chosen to control the host (directView) or a seat (joined), or when the host
    // is off the multiplayer screens entirely. Both clients feed this the same inputs, so the wire and the screen
    // agree by construction.
    private static void ShouldWatchHostStreamGate()
    {
        JoinInfo Info(string? mirrorMode, string status = "connected", bool joined = false) =>
            JoinModel.JoinInfoFromSession(
                Session(
                    session: new SessionAssignment(joined ? "Alice" : null, joined ? "assigned" : "unassigned", joined, null, 0),
                    screen: new SessionScreen("lobby", "lobby", "Lobby", mirrorMode)),
                status);

        bool Watch(
            string? mirrorMode,
            string? pending = null,
            string status = "connected",
            bool joined = false,
            bool directView = false,
            bool seatIntent = false) =>
            JoinModel.ShouldWatchHostStream(Info(mirrorMode, status), pending, mirrorMode, joined, directView, seatIntent);

        // The three MULTIPLAYER screens: the picker is up, so the host's game must NOT be streamed.
        Check.Equal(Watch("mp-character-select"), false, "mp lobby: the host game is not streamed behind the picker");
        Check.Equal(Watch("mp-load-game"), false, "mp saved game: the host game is not streamed behind the picker");
        Check.Equal(Watch("mp-run"), false, "mp run: the host game is not streamed behind the picker");

        // NOT a multiplayer screen: the mirror falls through to the host's own stream, exactly as before.
        Check.Equal(Watch("main-menu"), true, "main menu is not a multiplayer screen → stream the host");
        Check.Equal(Watch("singleplayer-run"), true, "a singleplayer run cannot be joined → stream the host");
        Check.Equal(
            Watch("sp-character-select"),
            true,
            "a singleplayer character select cannot be joined either → mirror it instead of gating it");
        Check.Equal(Watch(null), false, "an unknown screen does not grant a host stream");

        // Explicit grants win over any screen — this is "the client has chosen to control the host specifically".
        Check.Equal(Watch("mp-run", joined: true), true, "a JOINED viewer streams its own headless instance");
        Check.Equal(Watch("mp-run", directView: true), true, "a DIRECT-VIEW viewer streams the host it chose to control");
        Check.Equal(Watch("mp-character-select", joined: true), true, "joined overrides the mp lobby picker");

        // Transient states are not permission to stream, even though they collapse the mode to TitleOnly.
        Check.Equal(Watch("main-menu", pending: "Alice"), false, "a join in flight does not stream (the placeholder owns the screen)");
        Check.Equal(Watch("main-menu", status: "connecting"), false, "a connecting socket does not stream");
        Check.Equal(Watch("main-menu", status: "disconnected"), false, "a disconnected socket does not stream");
        Check.Equal(Watch("mp-run", pending: "Alice", joined: true), true, "an already-joined viewer keeps streaming through a later request");

        // BEFORE the first session there is no screen to judge, and "unknown" must read as "do not stream" — else
        // the gate opens for the few ms between the socket opening and the first session, which is long enough for
        // the host to build and ship a multi-MB keyframe of a game we are about to hide again.
        Check.Equal(
            JoinModel.ShouldWatchHostStream(JoinModel.JoinInfoFromSession(null, "connected"), null, null, false, false, false),
            false,
            "a connected socket that has not yet received a session does NOT stream");
        Check.Equal(
            JoinModel.ShouldWatchHostStream(JoinModel.JoinInfoFromSession(null, "connected"), null, null, false, true, false),
            true,
            "...unless direct-view was already granted (a reconnect keeps watching)");

        Check.Equal(JoinModel.ShouldWatchHostStream(Info("mp-character-select") with { Joined = true },
            null, "mp-character-select", false, false, false), false,
            "a roster assignment is not a multiplayer view grant");

        // F3 — SEAT INTENT (`seatIntent`). The WEB client's `?name=Ann` URL: "I am a player waiting for a seat".
        // Such a viewer is not a spectator — until the seat is granted it pulls NO scene bytes, on any screen a
        // param-less viewer would happily watch. The server never sees `?name=`, so this client-side answer is the
        // enforcement point; it is what rides the `watch` wire. The NATIVE client has no page URL and always
        // passes false, which is why every case above still reads exactly as it did.
        Check.Equal(Watch("main-menu", seatIntent: true), false, "a named seat waits on the main menu instead of mirroring it");
        Check.Equal(Watch("singleplayer-run", seatIntent: true), false, "…and on the host's singleplayer run");
        Check.Equal(Watch("sp-character-select", seatIntent: true), false, "…and on the host's singleplayer character select");
        Check.Equal(Watch("unsupported", seatIntent: true), false, "…and on a screen the host could not classify");
        Check.Equal(Watch("mp-run", seatIntent: true), false, "a multiplayer screen was already gated; seat intent cannot open it");

        // ORDER: an explicit grant OUTRANKS the marker. The URL still names the seat after the host serves it (that
        // is what makes a reload land back in it), so a seat-intent arm above these two would black out the game of
        // every viewer that successfully joined.
        Check.Equal(Watch("mp-run", joined: true, seatIntent: true), true, "a served seat streams, marker or no marker");
        Check.Equal(
            Watch("singleplayer-run", joined: true, seatIntent: true),
            true,
            "…on any screen: the grant is about THIS viewer's own instance, not the host's screen");
        Check.Equal(
            Watch("main-menu", directView: true, seatIntent: true),
            true,
            "a direct-view grant (the host handed over its own stream) outranks the marker as well");
    }

    // The closed seat-status set both clients render off. `offline` (mid-run: no game-connected instance, and the
    // game refuses to admit one) is a SEPARATE non-ready value from `stuck` (a lobby zombie awaiting its reap):
    // they carry different copy and only the zombie is auto-reaped, but both must render as a disabled row.
    private static void SeatStatusVocabulary()
    {
        Check.Equal(MirrorSeatStatuses.Normalize("ready"), MirrorSeatStatuses.Ready, "ready parses");
        Check.Equal(MirrorSeatStatuses.Normalize("stuck"), MirrorSeatStatuses.Stuck, "stuck parses");
        Check.Equal(MirrorSeatStatuses.Normalize("offline"), MirrorSeatStatuses.Offline, "offline parses");
        Check.Equal(MirrorSeatStatuses.Normalize(null), MirrorSeatStatuses.Offline, "an absent status is unavailable");
        Check.Equal(MirrorSeatStatuses.Normalize("wat"), MirrorSeatStatuses.Offline, "an unknown status is unavailable");

        Check.Equal(MirrorSeatStatuses.IsJoinable(MirrorSeatStatuses.Ready), true, "ready rows are tappable");
        Check.Equal(MirrorSeatStatuses.IsJoinable(MirrorSeatStatuses.Stuck), false, "stuck rows are truly disabled");
        Check.Equal(MirrorSeatStatuses.IsJoinable(MirrorSeatStatuses.Offline), false, "offline rows are truly disabled");
        Check.Equal(MirrorSeatStatuses.IsJoinable(null), false, "an unstamped row is unavailable");
    }

    // Mirror: default session() from the spec — a connected, unjoined lobby.
    private static SessionEnvelope Session(
        SessionAssignment? session = null,
        IReadOnlyList<SessionPlayerOption>? players = null,
        SessionScreen? screen = null)
    {
        return new SessionEnvelope(
            Session: session ?? new SessionAssignment(null, "unassigned", false, null, 0),
            Players: players ?? [],
            Screen: screen ?? new SessionScreen("lobby", "lobby", "Lobby", null),
            HeadlessMirrorPort: null,
            DirectView: false,
            JoinRejection: null,
            RefreshRate: null,
            AssetCacheToken: "cache",
            HostName: "host",
            ScrollAction: true);
    }

    private static void LiftsRosterScreenAssignmentOutOfSession()
    {
        var info = JoinModel.JoinInfoFromSession(
            Session(
                players: [new SessionPlayerOption("Alice", "Alice", false, true, 2, false)],
                screen: new SessionScreen("run", "combat", "Combat", null),
                session: new SessionAssignment("Alice", "joined", true, "p1", 1)),
            "connected");
        Check.Equal(info.ScreenKind, "run", "screenKind");
        Check.Equal(info.ScreenTitle, "Combat", "screenTitle");
        Check.Equal(info.Players.Count, 1, "players length");
        Check.Equal(info.Joined, true, "joined");
        Check.Equal(info.Unaffiliated, false, "unaffiliated (joined=true)");
    }

    private static void NullSessionIsTitlelessEmptyRoster()
    {
        var info = JoinModel.JoinInfoFromSession(null, "connecting");
        Check.Equal(info.ScreenKind, null, "screenKind null for null session");
        Check.Equal(info.ScreenTitle, null, "screenTitle null for null session");
        Check.Equal(info.Players.Count, 0, "players empty for null session");
        Check.Equal(info.Joined, false, "joined false for null session");
        Check.Equal(info.Unaffiliated, false, "unaffiliated false for null session (=== false is false when absent)");
    }

    private static void ScreenTitleFallsBackToType()
    {
        // screen.title present → title wins.
        var withTitle = JoinModel.JoinInfoFromSession(
            Session(screen: new SessionScreen("run", "combat", "Combat", null)), "connected");
        Check.Equal(withTitle.ScreenTitle, "Combat", "title present wins");

        // screen.title absent → falls back to screen.type.
        var noTitle = JoinModel.JoinInfoFromSession(
            Session(screen: new SessionScreen("run", "combat", null, null)), "connected");
        Check.Equal(noTitle.ScreenTitle, "combat", "title absent → type");

        // Both absent → null.
        var neither = JoinModel.JoinInfoFromSession(
            Session(screen: new SessionScreen("unsupported", null, null, null)), "connected");
        Check.Equal(neither.ScreenTitle, null, "title+type absent → null");

        // Explicitly unaffiliated session (joined=false) → unaffiliated true.
        var unaff = JoinModel.JoinInfoFromSession(
            Session(session: new SessionAssignment(null, "unassigned", false, null, 0)), "connected");
        Check.Equal(unaff.Unaffiliated, true, "joined=false → unaffiliated true");
        Check.Equal(unaff.Joined, false, "joined=false → joined false");
    }

    private static void ComputeMirrorJoinModeAllModes()
    {
        JoinInfo Connected(SessionScreen screen) => JoinModel.JoinInfoFromSession(Session(screen: screen), "connected");

        // MP character-select → picker-with-name.
        Check.Equal(
            JoinModel.ComputeMirrorJoinMode(
                Connected(new SessionScreen("lobby", "lobby", "Lobby", "mp-character-select")), null, "mp-character-select"),
            MirrorJoinMode.PickerWithName, "mp-character-select → PickerWithName");

        // MP load-saved-game → picker.
        Check.Equal(
            JoinModel.ComputeMirrorJoinMode(
                Connected(new SessionScreen("lobby", "lobby", "Load", "mp-load-game")), null, "mp-load-game"),
            MirrorJoinMode.Picker, "mp-load-game → Picker");

        // MP run → picker.
        Check.Equal(
            JoinModel.ComputeMirrorJoinMode(
                Connected(new SessionScreen("run", "combat", "Combat", "mp-run")), null, "mp-run"),
            MirrorJoinMode.Picker, "mp-run → Picker");

        // singleplayer-run / main-menu / null → title-only (server directView handles direct entry).
        Check.Equal(
            JoinModel.ComputeMirrorJoinMode(
                Connected(new SessionScreen("run", "combat", "Combat", "singleplayer-run")), null, "singleplayer-run"),
            MirrorJoinMode.TitleOnly, "singleplayer-run → TitleOnly");
        // …and so does the SINGLEPLAYER character select, which is `kind: "lobby"` like the multiplayer one but
        // has no seat to claim. It reaches TitleOnly through the same fall-through as an unknown kind, and that
        // is the point: only a kind that needs a FORM gets a branch.
        Check.Equal(
            JoinModel.ComputeMirrorJoinMode(
                Connected(new SessionScreen("lobby", "lobby", "Character Select", "sp-character-select")),
                null,
                "sp-character-select"),
            MirrorJoinMode.TitleOnly, "sp-character-select → TitleOnly (no join form on a lobby nobody can join)");
        Check.Equal(
            JoinModel.ComputeMirrorJoinMode(
                Connected(new SessionScreen("unsupported", null, null, "main-menu")), null, "main-menu"),
            MirrorJoinMode.TitleOnly, "main-menu → TitleOnly");
        Check.Equal(
            JoinModel.ComputeMirrorJoinMode(Connected(new SessionScreen("lobby", "lobby", "Lobby", null)), null, null),
            MirrorJoinMode.TitleOnly, "null mirrorMode → TitleOnly");

        // A pending join collapses the picker to title-only (matches canChooseAssignment gating).
        Check.Equal(
            JoinModel.ComputeMirrorJoinMode(
                Connected(new SessionScreen("lobby", "lobby", "Lobby", "mp-character-select")), "Stale", "mp-character-select"),
            MirrorJoinMode.TitleOnly, "pending join collapses to TitleOnly");

        // While connecting (no session) → title-only.
        Check.Equal(
            JoinModel.ComputeMirrorJoinMode(JoinModel.JoinInfoFromSession(null, "connecting"), null, "mp-character-select"),
            MirrorJoinMode.TitleOnly, "connecting → TitleOnly");
    }

    private static void CanChooseAssignmentGating()
    {
        var lobby = JoinModel.JoinInfoFromSession(Session(), "connected");
        Check.Equal(JoinModel.CanChooseAssignment(lobby, null), true, "connected unjoined lobby → may choose");
        // Empty pending string is falsy in JS → still choosable.
        Check.Equal(JoinModel.CanChooseAssignment(lobby, ""), true, "empty pending is falsy → may choose");
        Check.Equal(JoinModel.CanChooseAssignment(lobby, "Alice"), false, "pending join blocks choosing");

        // Connecting / disconnected block choosing.
        Check.Equal(JoinModel.CanChooseAssignment(JoinModel.JoinInfoFromSession(null, "connecting"), null), false, "connecting → cannot choose");
        Check.Equal(JoinModel.CanChooseAssignment(JoinModel.JoinInfoFromSession(Session(), "disconnected"), null), false, "disconnected → cannot choose");

        // Already joined → cannot choose.
        var joined = JoinModel.JoinInfoFromSession(
            Session(session: new SessionAssignment("Alice", "joined", true, "p1", 1)), "connected");
        Check.Equal(JoinModel.CanChooseAssignment(joined, null), false, "already joined → cannot choose");

        // A pending join collapses even an explicitly-unaffiliated viewer.
        var unaffiliated = JoinModel.JoinInfoFromSession(
            Session(session: new SessionAssignment(null, "unassigned", false, null, 0)), "connected");
        Check.Equal(JoinModel.CanChooseAssignment(unaffiliated, "Stale"), false, "pending join collapses unaffiliated too");
    }

    private static void TrimNameTrimsAndNullsBlanks()
    {
        Check.Equal(JoinModel.TrimName("  Bob  "), "Bob", "trims surrounding whitespace");
        Check.Equal(JoinModel.TrimName("   "), null, "all-whitespace → null");
        Check.Equal(JoinModel.TrimName(null), null, "null → null");
        Check.Equal(JoinModel.TrimName(""), null, "empty → null");
    }

    // MirrorRosterFor keeps host + every MIRROR SEAT and drops genuine remote players, IGNORING isLocal in both
    // directions (parity with the web mirrorRosterFor).
    private static void MirrorRosterForKeepsHostAndSeats()
    {
        IReadOnlyList<SessionPlayerOption> players =
        [
            new SessionPlayerOption("p:1", "Hosty", IsHost: true, IsRunPlayer: true, ConnectionCount: 1, Disconnected: false, IsLocal: false, NetId: 1),
            // A seat NOBODY is on: not local, no controllers, disconnected — the rejoin case, and it must survive.
            new SessionPlayerOption("p:1003", "Player 1003", IsHost: false, IsRunPlayer: true, ConnectionCount: 0, Disconnected: true, IsLocal: false, NetId: 1003, IsMirrorSeat: true),
            // A genuine remote player, even a LOCAL one: the host cannot instance a mirror for it, so it is dropped.
            new SessionPlayerOption("p:1000", "Remote", IsHost: false, IsRunPlayer: true, ConnectionCount: 1, Disconnected: false, IsLocal: true, NetId: 1000),
        ];

        var roster = JoinModel.MirrorRosterFor(players);
        Check.Equal(roster.Count, 2, "host + seat kept, genuine remote dropped");
        Check.Equal(roster[0].Name, "Hosty", "host kept first");
        Check.Equal(roster[1].Name, "Player 1003", "an unheld seat is still offered (the rejoin row)");

    }

    // Current session rows carry explicit seat identity and status rather than relying on client defaults.
    private static void SessionEnvelopeParsesMirrorSeatFields()
    {
        const string json =
            "{\"type\":\"session\",\"session\":{\"name\":null,\"status\":\"unassigned\",\"joined\":false,\"playerId\":null,\"connectionCount\":0},\"assetCacheToken\":\"cache\",\"hostName\":\"host\",\"scrollAction\":true,\"screen\":{\"kind\":\"unsupported\",\"type\":null,\"title\":null,\"mirrorMode\":\"unsupported\"},\"players\":[" +
            "{\"playerId\":\"p:1002\",\"name\":\"Alice\",\"netId\":1002,\"isHost\":false,\"isRunPlayer\":true,\"connectionCount\":0,\"disconnected\":true,\"isLocal\":false,\"isMirrorSeat\":true,\"seatStatus\":\"stuck\",\"seatStatusReason\":\"Cannot rejoin\",\"characterId\":null}," +
            "{\"playerId\":\"p:1004\",\"name\":\"Cara\",\"netId\":null,\"isHost\":false,\"isRunPlayer\":true,\"connectionCount\":0,\"disconnected\":false,\"isLocal\":false,\"isMirrorSeat\":false,\"seatStatus\":\"ready\",\"seatStatusReason\":null,\"characterId\":null}," +
            "{\"playerId\":\"Synthetic\",\"name\":\"Synthetic\",\"netId\":null,\"isHost\":false,\"isRunPlayer\":false,\"connectionCount\":0,\"disconnected\":false,\"isLocal\":false,\"isMirrorSeat\":false,\"seatStatus\":\"ready\",\"seatStatusReason\":null,\"characterId\":null}," +
            "{\"playerId\":\"p:1\",\"name\":\"Hosty\",\"netId\":null,\"isHost\":true,\"isRunPlayer\":true,\"connectionCount\":1,\"disconnected\":false,\"isLocal\":false,\"isMirrorSeat\":false,\"seatStatus\":\"ready\",\"seatStatusReason\":null,\"characterId\":null}," +
            "{\"playerId\":\"p:1003\",\"name\":\"Bea\",\"netId\":1003,\"isHost\":false,\"isRunPlayer\":true,\"connectionCount\":0,\"disconnected\":true,\"isLocal\":false,\"isMirrorSeat\":true,\"seatStatus\":\"offline\",\"seatStatusReason\":\"Disconnected — the host must reload the saved run to let this seat rejoin\",\"characterId\":null}]}";

        var env = SessionEnvelope.Parse(json);
        Check.Equal(env is not null, true, "session envelope parsed");
        var players = env!.Players;
        Check.Equal(players[0].NetId, 1002UL, "explicit netId parses");
        Check.Equal(players[0].IsMirrorSeat, true, "isMirrorSeat:true → true");
        Check.Equal(players[0].SeatStatus, MirrorSeatStatuses.Stuck, "seatStatus:stuck → stuck");
        Check.Equal(players[0].SeatStatusReason, "Cannot rejoin", "the reason rides along");
        Check.Equal(players[1].NetId, (ulong?)null, "explicit null netId remains null");
        Check.Equal(players[1].IsMirrorSeat, false, "explicit isMirrorSeat:false parses");
        Check.Equal(players[1].SeatStatus, MirrorSeatStatuses.Ready, "explicit seatStatus:ready parses");
        Check.Equal(players[2].NetId, (ulong?)null, "a non-p:N id has no netId");
        Check.Equal(players[3].SeatStatus, MirrorSeatStatuses.Ready, "host row carries ready status");
        Check.Equal(players[4].SeatStatus, MirrorSeatStatuses.Offline, "seatStatus:offline → offline (the mid-run row)");
        Check.Equal(
            players[4].SeatStatusReason,
            "Disconnected — the host must reload the saved run to let this seat rejoin",
            "the offline reason rides along for the disabled row");
    }

    // Current rows require isLocal alongside the other identity fields.
    private static void SessionEnvelopeParsesIsLocal()
    {
        const string json =
            "{\"type\":\"session\",\"session\":{\"name\":null,\"status\":\"unassigned\",\"joined\":false,\"playerId\":null,\"connectionCount\":0},\"assetCacheToken\":\"cache\",\"hostName\":\"host\",\"scrollAction\":true,\"screen\":{\"kind\":\"unsupported\",\"type\":null,\"title\":null,\"mirrorMode\":\"unsupported\"},\"players\":[" +
            "{\"playerId\":\"host\",\"name\":\"Hosty\",\"netId\":null,\"isHost\":true,\"isRunPlayer\":false,\"connectionCount\":0,\"disconnected\":false,\"isLocal\":false,\"isMirrorSeat\":false,\"seatStatus\":\"ready\",\"seatStatusReason\":null,\"characterId\":null}," +
            "{\"playerId\":\"me\",\"name\":\"Alice\",\"netId\":null,\"isHost\":false,\"isRunPlayer\":true,\"connectionCount\":1,\"disconnected\":false,\"isLocal\":true,\"isMirrorSeat\":true,\"seatStatus\":\"ready\",\"seatStatusReason\":null,\"characterId\":null}," +
            "{\"playerId\":\"them\",\"name\":\"Bob\",\"netId\":null,\"isHost\":false,\"isRunPlayer\":true,\"connectionCount\":0,\"disconnected\":false,\"isLocal\":false,\"isMirrorSeat\":false,\"seatStatus\":\"ready\",\"seatStatusReason\":null,\"characterId\":null}]}";

        var env = SessionEnvelope.Parse(json);
        Check.Equal(env is not null, true, "session envelope parsed");
        var players = env!.Players;
        Check.Equal(players.Count, 3, "three players parsed");
        Check.Equal(players[0].IsLocal, false, "isLocal:false → false");
        Check.Equal(players[1].IsLocal, true, "isLocal:true → true");
        Check.Equal(players[2].IsLocal, false, "explicit isLocal:false → false");
    }
}
