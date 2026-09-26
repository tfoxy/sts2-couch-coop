using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Contracts;

// F2: the wire's mirror-screen discriminator — `screen.mirrorMode`, produced by
// BrowserAssignmentClassifier.MirrorModeFor and consumed by BOTH clients to decide whether a join form is shown
// and whether the host's stream may be pulled at all.
//
// Worth its own suite because the classifier is the ONLY place that decision is made: every consumer
// (ComputeMirrorJoinMode / computeMirrorJoinMode, isMultiplayerMirrorMode, MirrorSeatDirectory.Evaluate, the
// native UiRoot) defaults an unnamed kind to "watch, don't offer a form". That makes the arms below the whole
// contract — a wrong arm cannot be caught downstream, it just silently shows a phone the wrong screen.
//
// The negative cases are the load-bearing ones. A singleplayer lobby must NOT show a join form (nobody can join
// it); an UNREADABLE lobby must still show one (that is the screen this mod exists for, so ambiguity has to fail
// towards the join form, not away from it).
internal static class BrowserAssignmentClassifierTests
{
    public static void Run()
    {
        SingleplayerCharacterSelectIsItsOwnKind();
        MultiplayerCharacterSelectIsUnchanged();
        UnreadableLobbiesFailSafeToTheJoinForm();
        TheSavedRunLobbyOutranksTheLobbyType();
        RunsKeepTheirOwnKinds();
        NoStateIsTheMainMenu();
        AnUnreadableRosterIsAnUnsupportedScreen();
        TheSingleplayerLobbyIsStillALobbyScreen();
        EveryProducedKindSurvivesTheWireAllowlist();

        Console.WriteLine("BrowserAssignmentClassifierTests: ok");
    }

    // A singleplayer character select is a lobby nobody can join, so it gets a kind of its own and the clients'
    // title-only default takes over: no name form, and the stream gate opens so the phone mirrors the screen.
    private static void SingleplayerCharacterSelectIsItsOwnKind()
    {
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.Lobby("singleplayer")) == "sp-character-select",
            "a singleplayer lobby is sp-character-select");
    }

    private static void MultiplayerCharacterSelectIsUnchanged()
    {
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.Lobby("host")) == "mp-character-select",
            "a host lobby is still mp-character-select");
    }

    // THE FAIL-SAFE DIRECTION, pinned. The arm asks `== "singleplayer"` rather than `!= "host"` precisely so that
    // a lobby whose type we cannot read keeps the join form: a phone shown a form it cannot use is a nuisance, a
    // phone denied the form on a real co-op lobby is the mod not working. "client" (this machine joined someone
    // else's host) is a genuine multiplayer context and stays on the same branch by the same rule.
    private static void UnreadableLobbiesFailSafeToTheJoinForm()
    {
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.Lobby("")) == "mp-character-select",
            "an unreadable lobby type keeps the join form");
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.Lobby("wat")) == "mp-character-select",
            "so does an unrecognised one");
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.Lobby("client")) == "mp-character-select",
            "a client-side lobby is still a multiplayer context");
    }

    // ORDER PIN: the SavedRun arm sits ABOVE the singleplayer-lobby arm, so a load-saved-game lobby reports
    // mp-load-game whatever its lobby type says. Reversing the two arms would strip the picker off the saved
    // multiplayer game — the one screen a returning player MUST be offered their old seat on.
    private static void TheSavedRunLobbyOutranksTheLobbyType()
    {
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.Lobby("host", ["p:1002"])) == "mp-load-game",
            "a host load-game lobby is mp-load-game");
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.Lobby("singleplayer", ["p:1002"])) == "mp-load-game",
            "a saved run outranks the singleplayer lobby type");
    }

    private static void RunsKeepTheirOwnKinds()
    {
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.RunInProgress("singleplayer")) == "singleplayer-run",
            "a singleplayer run is singleplayer-run");
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.RunInProgress("multiplayer")) == "mp-run",
            "a multiplayer run is mp-run");
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.RunInProgress("")) == "mp-run",
            "an unreadable run type is mp-run — the same fail-safe direction as the lobby");
    }

    private static void NoStateIsTheMainMenu()
    {
        Expect(MirrorMode(null) == "main-menu", "no state at all reads as the main menu");
        Expect(MirrorMode(CouchCoopLobbyHostGateTests.MainMenu()) == "main-menu", "and so does the main menu");
    }

    // "Unavailable" (null: the reader could not read the game) is the retired unreadable-state answer, and never "nobody
    // is here": an unsupported screen with no players, the main-menu mirror mode and the notice that says so.
    private static void AnUnreadableRosterIsAnUnsupportedScreen()
    {
        var state = Classify(null);
        Expect(state.Screen.Kind == "unsupported" && state.Screen.Type is null && state.Screen.Title is null,
            "an unreadable roster is an unsupported screen with no type");
        Expect(state.Screen.MirrorMode == "main-menu", "…in the main-menu mirror mode");
        Expect(state.Players.Count == 0, "…with nobody on it");
        Expect(state.Notices is [{ Code: BrowserAssignmentNoticeCodes.UnsupportedScreen }],
            "…and the unsupported-screen notice");
    }

    // `kind` and `mirrorMode` are independent axes: `kind` says what SHAPE the screen is (the stateful client
    // branches on it), `mirrorMode` says how JOINABLE it is. A singleplayer character select is still a lobby,
    // and nothing outside the mirror's gating may change because of this new kind.
    private static void TheSingleplayerLobbyIsStillALobbyScreen()
    {
        var screen = Classify(CouchCoopLobbyHostGateTests.Lobby("singleplayer")).Screen;
        Expect(screen.Kind == "lobby", "the sp character select is still screen.kind 'lobby'");
        Expect(screen.Type == "screens/character_select_screen", "…with the character-select root scene");
        Expect(screen.Title == "Character Select", "…and the character-select title");
    }

    // The producer and the wire allowlist are two lists in two projects (SessionEnvelope.MirrorScreenKinds, and
    // its TS twin MIRROR_SCREEN_KINDS). A kind missing from the allowlist normalizes to null on arrival, which
    // must preserve every classifier kind through the session projection.
    private static void EveryProducedKindSurvivesTheWireAllowlist()
    {
        foreach (var (roster, label) in new (RosterFacts?, string)[]
        {
            (CouchCoopLobbyHostGateTests.Lobby("singleplayer"), "sp lobby"),
            (CouchCoopLobbyHostGateTests.Lobby("host"), "mp lobby"),
            (CouchCoopLobbyHostGateTests.Lobby("host", ["p:1002"]), "load-game lobby"),
            (CouchCoopLobbyHostGateTests.RunInProgress("singleplayer"), "sp run"),
            (CouchCoopLobbyHostGateTests.RunInProgress("multiplayer"), "mp run"),
            (CouchCoopLobbyHostGateTests.MainMenu(), "main menu"),
            (null, "no state"),
        })
        {
            var produced = MirrorMode(roster);
            var json = "{\"type\":\"session\",\"session\":{\"name\":null,\"status\":\"unassigned\",\"joined\":false,\"playerId\":null,\"connectionCount\":0},\"players\":[],\"screen\":{\"kind\":\"lobby\",\"type\":null,\"title\":null,\"mirrorMode\":\"" + produced + "\"},\"assetCacheToken\":\"cache\",\"hostName\":\"host\",\"scrollAction\":true}";
            var parsed = SessionEnvelope.Parse(System.Text.Encoding.UTF8.GetBytes(json));
            Expect(parsed?.Screen?.MirrorMode == produced,
                $"the wire allowlist accepts the kind the classifier produces ({label} → {produced})");
        }
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private static BrowserAssignmentState Classify(RosterFacts? roster)
        => BrowserAssignmentClassifier.Classify(roster, new BrowserSessionRegistry(), requestedName: null);

    private static string? MirrorMode(RosterFacts? roster) => Classify(roster).Screen.MirrorMode;

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"BrowserAssignmentClassifierTests failed: {because}");
        }
    }
}
