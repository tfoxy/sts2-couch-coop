using CouchCoop.Mod.HostUi;
using Spirectl.Sts2.Core.State;

// WS-2: when does the "Couch Co-Op QR Code" button exist?
//
// The controller re-evaluates this every scan tick and installs or removes the panel from the result,
// so this predicate is also the button's teardown path — there is no second "hide it now" branch that
// could fall out of sync. That makes the negative cases the interesting ones: a button left behind on
// a singleplayer lobby is a QR that promises a join nobody can perform.
internal static class CouchCoopLobbyHostGateTests
{
    public static void Run()
    {
        HostLobbyWithAListenerShows();
        LoadSavedRunLobbyShows();
        SingleplayerLobbyIsRefused();
        RunInProgressIsRefused();
        UnknownStateIsRefused();
        MissingListenerIsRefused();
        GateMatchesTheHeadlessLaunchWindow();

        Console.WriteLine("CouchCoopLobbyHostGateTests: ok");
    }

    private static readonly Uri Listener = new("http://0.0.0.0:13337/");

    private static void HostLobbyWithAListenerShows()
    {
        Expect(CouchCoopLobbyHostGate.ShouldShow(Listener, Lobby("host")), "a host lobby with a listener shows the button");
    }

    // The multiplayer load-saved-game screen is the same CharacterSelect lobby shape with a SavedRun
    // attached. It is exactly when absent players need to scan back in, so the button must appear there
    // too — and it does, without the gate needing to know that screen exists.
    private static void LoadSavedRunLobbyShows()
    {
        var loadScreen = Lobby("host", saved: new StateCharacterSelectSavedRunSnapshot(
            CurrentActIndex: 0,
            ActFloor: 3,
            Players: [new StateCharacterSelectSavedRunPlayerSnapshot("p:1002", 40, 80, 120)]));

        Expect(CouchCoopLobbyHostGate.ShouldShow(Listener, loadScreen), "the load-saved-run lobby shows the button");
    }

    private static void SingleplayerLobbyIsRefused()
    {
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, Lobby("singleplayer")), "a singleplayer lobby is refused");
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, Lobby("client")), "a client-side lobby is refused");
    }

    private static void RunInProgressIsRefused()
    {
        // A started run stops accepting new peers, so the QR would hand out a URL that cannot join.
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, RunInProgress()), "a live run is refused");
    }

    private static void UnknownStateIsRefused()
    {
        // No state capability (or the main menu): we cannot prove we are hosting, so we do not claim to be.
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, null), "unknown state is refused");
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, MainMenu()), "the main menu is refused");
    }

    private static void MissingListenerIsRefused()
    {
        // No browser server means no URL to encode at all — the dialog would have nothing to show.
        Expect(!CouchCoopLobbyHostGate.ShouldShow(null, Lobby("host")), "no listener means no button");
    }

    // The gate deliberately reuses MayLaunchNewHeadless's predicate: the moments a phone may join are
    // exactly the moments the QR should be reachable. If these ever diverge, the QR either advertises a
    // join that will be refused or hides during one that would succeed.
    private static void GateMatchesTheHeadlessLaunchWindow()
    {
        foreach (var (state, label) in new (StateSnapshot?, string)[]
        {
            (Lobby("host"), "host lobby"),
            (Lobby("singleplayer"), "singleplayer lobby"),
            (Lobby("client"), "client lobby"),
            (RunInProgress(), "run in progress"),
            (MainMenu(), "main menu"),
            (null, "no state"),
        })
        {
            var mayLaunch = state is { Run: null, CharacterSelect.Lobby.NetGameType: "host" };
            Expect(CouchCoopLobbyHostGate.IsHostLobby(state) == mayLaunch,
                $"the gate agrees with the headless-launch window ({label})");
        }
    }

    // ---- builders -------------------------------------------------------------------------------------------
    //
    // `internal` rather than private: BrowserAssignmentClassifierTests classifies exactly the same screens (the
    // QR button and the mirror's screen kind are two readings of ONE lobby shape), and a second copy of these
    // snapshots would let the two suites drift apart on what a "host lobby" even looks like.

    internal static StateSnapshot Lobby(string netGameType, StateCharacterSelectSavedRunSnapshot? saved = null)
        => new(
            StateSnapshot.CurrentSchemaVersion,
            Language: null,
            RootScene: "screens/character_select_screen",
            CharacterSelect: new StateCharacterSelectSnapshot(
                new StateCharacterSelectLobbySnapshot(
                    netGameType,
                    LocalPlayerId: "p:1",
                    HostPlayerId: "p:1",
                    ConnectingPlayerCount: 0,
                    Ascension: 0,
                    MaxAscension: 20,
                    Act1: "random",
                    Seed: null,
                    ModifierIds: [],
                    Players: [],
                    SavedRun: saved),
                CharacterButtons: [],
                View: null),
            Run: null);

    internal static StateSnapshot MainMenu()
        => new(
            StateSnapshot.CurrentSchemaVersion,
            Language: null,
            RootScene: "screens/main_menu",
            CharacterSelect: null,
            Run: null);

    internal static StateSnapshot RunInProgress(string netGameType = "multiplayer")
        => new(
            StateSnapshot.CurrentSchemaVersion,
            Language: null,
            RootScene: "run",
            CharacterSelect: null,
            Run: new StateRunSnapshot(
                "test",
                "test",
                netGameType,
                "standard",
                "seed:test",
                AscensionLevel: 0,
                ActId: "act1",
                CurrentActIndex: 0,
                ActFloor: 0,
                TotalFloor: 0,
                BossEncounterId: null,
                SecondBossEncounterId: null,
                CurrentMapCoord: null,
                CurrentMapPointId: null,
                VisitedMapCoords: [],
                Players: [],
                Map: null,
                CurrentRoom: null,
                Notices: [],
                View: new StateRunViewSnapshot("p:1", null)));

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"CouchCoopLobbyHostGateTests failed: {because}");
        }
    }
}
