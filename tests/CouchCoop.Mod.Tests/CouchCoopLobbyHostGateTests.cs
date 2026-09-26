using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;

// The QR gates consume only these three typed facts. Fixtures below state those facts directly.
internal static class CouchCoopLobbyHostGateTests
{
    public static void Run()
    {
        HostLobbyWithAListenerShows();
        LoadSavedRunLobbyShows();
        SingleplayerLobbyIsRefused();
        RunInProgressIsRefused();
        UnknownFactsAreRefused();
        MissingListenerIsRefused();
        FactsMatrix();
        CheckpointEvaluationKeepsItsThreeStates();
        Console.WriteLine("CouchCoopLobbyHostGateTests: ok");
    }

    private static readonly Uri Listener = new("http://0.0.0.0:13337/");
    private static GateFacts Facts(bool run, string? lobby, string? runType) => new(run, lobby, runType);

    private static void HostLobbyWithAListenerShows()
        => Expect(CouchCoopLobbyHostGate.ShouldShow(Listener, Facts(false, "host", null)), "host lobby with listener shows");

    private static void LoadSavedRunLobbyShows()
        => Expect(CouchCoopLobbyHostGate.ShouldShow(Listener, Facts(false, "host", null)), "saved-run host lobby shows through the same typed gate fact");

    private static void SingleplayerLobbyIsRefused()
    {
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, Facts(false, "singleplayer", null)), "singleplayer lobby is refused");
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, Facts(false, "client", null)), "client-side lobby is refused");
    }

    private static void RunInProgressIsRefused()
        => Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, Facts(true, null, "host")), "a live run is refused");

    private static void UnknownFactsAreRefused()
    {
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, null), "unavailable facts are refused");
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, Facts(false, null, null)), "main menu facts are refused");
    }

    private static void MissingListenerIsRefused()
        => Expect(!CouchCoopLobbyHostGate.ShouldShow(null, Facts(false, "host", null)), "no listener means no button");

    private static void FactsMatrix()
    {
        (GateFacts? Facts, bool Lobby, bool Run, string What)[] cases =
        [
            (Facts(false, null, null), false, false, "main menu"),
            (Facts(false, "host", null), true, false, "new-run host lobby"),
            (Facts(false, "client", null), false, false, "client lobby"),
            (Facts(false, "singleplayer", null), false, false, "singleplayer lobby"),
            (Facts(false, "host", null), true, false, "saved-run host lobby"),
            (Facts(false, "client", null), false, false, "saved-run client lobby"),
            (Facts(false, null, null), false, false, "unassigned lobby"),
            (Facts(true, null, "host"), false, true, "hosted run"),
            (Facts(true, null, "client"), false, false, "client run"),
            (Facts(true, null, "singleplayer"), false, false, "singleplayer run"),
            (Facts(true, null, NetTypeNames.Unknown), false, false, "unknown run type"),
            (Facts(true, "host", "host"), false, true, "run under a lobby screen"),
            (null, false, false, "unavailable facts"),
        ];

        foreach (var (facts, lobby, run, what) in cases)
        {
            Expect(CouchCoopLobbyHostGate.IsHostLobby(facts) == lobby, $"IsHostLobby for {what}");
            Expect(CouchCoopLobbyHostGate.ShouldShow(Listener, facts) == lobby, $"ShouldShow for {what}");
            Expect(!CouchCoopLobbyHostGate.ShouldShow(null, facts), $"missing listener refuses {what}");
            Expect(CouchCoopPauseMenuGate.IsHostRun(facts) == run, $"IsHostRun for {what}");
            Expect(!(lobby && run), $"the gates never both accept {what}");
        }
    }

    private static void CheckpointEvaluationKeepsItsThreeStates()
    {
        Expect(CouchCoopLobbyHostGate.Classify(null) == LobbyCheckpointEvaluation.Unavailable, "unavailable stays distinct");
        Expect(CouchCoopLobbyHostGate.Classify(Facts(false, "host", null)) == LobbyCheckpointEvaluation.Host, "host lobby is Host");
        Expect(CouchCoopLobbyHostGate.Classify(Facts(false, null, null)) == LobbyCheckpointEvaluation.NotHost, "no lobby is NotHost");
        Expect(CouchCoopLobbyHostGate.Classify(Facts(false, "client", null)) == LobbyCheckpointEvaluation.NotHost, "client lobby is NotHost");
        Expect(CouchCoopLobbyHostGate.Classify(Facts(true, "host", "host")) == LobbyCheckpointEvaluation.NotHost, "run under lobby screen is NotHost");
    }

    // Typed roster fixtures shared by the classifier tests. No snapshot or projection is involved.
    internal static RosterFacts Lobby(string netGameType, IReadOnlyList<string>? savedRunSeatIds = null)
        => new(
            savedRunSeatIds is null ? RosterRootScenes.CharacterSelect : RosterRootScenes.LoadGame,
            new RosterLobby(netGameType, "p:1", savedRunSeatIds is not null, [], savedRunSeatIds ?? []),
            null);

    internal static RosterFacts MainMenu() => new(RosterRootScenes.MainMenu, null, null);

    internal static RosterFacts RunInProgress(string netGameType = "multiplayer", bool withLobbyScreen = false)
        => new(
            withLobbyScreen ? RosterRootScenes.CharacterSelect : RosterRootScenes.Run,
            withLobbyScreen ? new RosterLobby("host", "p:1", false, [], []) : null,
            new RosterRun(netGameType, "p:1", []));

    private static void Expect(bool condition, string because)
    {
        if (!condition) throw new InvalidOperationException($"CouchCoopLobbyHostGateTests failed: {because}");
    }
}
