using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using Spirectl.Sts2.Core.State;

// WS-2: when does the "Couch Co-Op QR Code" button exist?
//
// The controller evaluates this whenever something pushed that the answer may have changed, and installs or
// removes the panel from the result, so this predicate is also the button's teardown path — there is no second
// "hide it now" branch that could fall out of sync. That makes the negative cases the interesting ones: a button
// left behind on a singleplayer lobby is a QR that promises a join nobody can perform.
//
// The gate decides on GateFacts (what CouchCoop's own typed reader hands it). The StateSnapshot builders below stay
// because BrowserAssignmentClassifierTests and CouchCoopPauseMenuGateTests share them, and because they are the
// PARITY ORACLE: `Project` turns a snapshot into the facts the reader would have produced, and `Parity` asserts every
// gate decision equals what the deleted snapshot-based predicates said.
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
        FactsMatrix();
        CheckpointEvaluationKeepsItsThreeStates();
        ProjectionEqualsTheFactsTheReaderProduces();
        ParityWithTheDeletedSnapshotPredicates();

        Console.WriteLine("CouchCoopLobbyHostGateTests: ok");
    }

    private static readonly Uri Listener = new("http://0.0.0.0:13337/");

    private static void HostLobbyWithAListenerShows()
    {
        Expect(CouchCoopLobbyHostGate.ShouldShow(Listener, Project(Lobby("host"))), "a host lobby with a listener shows the button");
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

        Expect(CouchCoopLobbyHostGate.ShouldShow(Listener, Project(loadScreen)), "the load-saved-run lobby shows the button");
    }

    private static void SingleplayerLobbyIsRefused()
    {
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, Project(Lobby("singleplayer"))), "a singleplayer lobby is refused");
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, Project(Lobby("client"))), "a client-side lobby is refused");
    }

    private static void RunInProgressIsRefused()
    {
        // A started run stops accepting new peers, so the QR would hand out a URL that cannot join.
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, Project(RunInProgress())), "a live run is refused");
    }

    private static void UnknownStateIsRefused()
    {
        // No facts (the read failed) or the main menu: we cannot prove we are hosting, so we do not claim to be.
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, null), "unknown state is refused");
        Expect(!CouchCoopLobbyHostGate.ShouldShow(Listener, Project(MainMenu())), "the main menu is refused");
    }

    private static void MissingListenerIsRefused()
    {
        // No browser server means no URL to encode at all — the dialog would have nothing to show.
        Expect(!CouchCoopLobbyHostGate.ShouldShow(null, Project(Lobby("host"))), "no listener means no button");
    }

    // ---- the facts the typed reader hands the gate ---------------------------------------------------------

    private static GateFacts Facts(bool run, string? lobby, string? runType)
        => new(run, lobby, runType);

    // Every situation the reader can report, written as the facts themselves: no snapshot involved. `null` is the
    // reader's "unavailable" (no engine, or the game threw) and is NOT the same answer as "not in a lobby".
    private static void FactsMatrix()
    {
        (GateFacts? Facts, bool Lobby, bool Run, string What)[] cases =
        [
            (Facts(false, null, null), false, false, "the main menu"),
            (Facts(false, "host", null), true, false, "a new-run host lobby"),
            (Facts(false, "client", null), false, false, "a lobby we joined as a client"),
            (Facts(false, "singleplayer", null), false, false, "a singleplayer lobby"),
            // The saved-run screen reports through the same field as the new-run one: its role comes from the
            // assignment hook, so a load-run HOST lobby is a host lobby and a load-run CLIENT lobby is not.
            (Facts(false, "host", null), true, false, "a saved-run host lobby"),
            (Facts(false, "client", null), false, false, "a saved-run client lobby"),
            // A lobby screen the game has not assigned a lobby to yet reads as no lobby, not as a host.
            (Facts(false, null, null), false, false, "a lobby screen with no lobby assigned"),
            (Facts(true, null, "host"), false, true, "a hosted run"),
            (Facts(true, null, "client"), false, false, "a client's run"),
            (Facts(true, null, "singleplayer"), false, false, "a singleplayer run"),
            (Facts(true, null, NetTypeNames.Unknown), false, false, "a run with no net service"),
            // A run that is still showing a lobby-like screen (the embark fade): the run wins, so the lobby button
            // is refused, and the pause-menu row is judged on the run alone.
            (Facts(true, "host", "host"), false, true, "a run whose current screen is still a lobby"),
            (null, false, false, "facts that could not be read"),
        ];

        foreach (var (facts, lobby, run, what) in cases)
        {
            Expect(CouchCoopLobbyHostGate.IsHostLobby(facts) == lobby, $"IsHostLobby for {what}");
            Expect(CouchCoopLobbyHostGate.ShouldShow(Listener, facts) == lobby, $"ShouldShow (listener up) for {what}");
            Expect(!CouchCoopLobbyHostGate.ShouldShow(null, facts), $"no listener refuses {what}");
            Expect(CouchCoopPauseMenuGate.IsHostRun(facts) == run, $"IsHostRun for {what}");
            Expect(!(lobby && run), $"the two gates never both say yes ({what})");
        }
    }

    // The tri-state the support checkpoint records: "could not read" must stay distinct from "not a host lobby".
    private static void CheckpointEvaluationKeepsItsThreeStates()
    {
        Expect(CouchCoopLobbyHostGate.Classify(null) == LobbyCheckpointEvaluation.Unavailable,
            "unreadable facts are Unavailable");
        Expect(CouchCoopLobbyHostGate.Classify(Facts(false, "host", null)) == LobbyCheckpointEvaluation.Host,
            "a host lobby is Host");
        Expect(CouchCoopLobbyHostGate.Classify(Facts(false, null, null)) == LobbyCheckpointEvaluation.NotHost,
            "no lobby is NotHost, not Unavailable");
        Expect(CouchCoopLobbyHostGate.Classify(Facts(false, "client", null)) == LobbyCheckpointEvaluation.NotHost,
            "a client lobby is NotHost");
        Expect(CouchCoopLobbyHostGate.Classify(Facts(true, "host", "host")) == LobbyCheckpointEvaluation.NotHost,
            "a run with a lobby-like screen is NotHost");
    }

    // ---- the parity oracle (TEST ONLY) -----------------------------------------------------------------------
    //
    // DELETE THIS SECTION WITH `Project` WHEN THE LAST WP3 READ PATH LANDS. It exists so the move from the full
    // state snapshot to the typed reader is provably a no-op on every fixture the suite already owns: `Project`
    // reads a snapshot the way the retired predicates did, and the two `Old*` functions are those predicates verbatim.

    /// <summary>What the typed reader would have produced for the game a snapshot describes.</summary>
    internal static GateFacts? Project(StateSnapshot? state)
        => state is null
            ? null
            : new GateFacts(
                RunInProgress: state.Run is not null,
                CurrentLobbyNetType: state.CharacterSelect?.Lobby.NetGameType,
                RunNetType: state.Run?.NetGameType);

    private static bool OldIsHostLobby(StateSnapshot? state)
        => state is { Run: null, CharacterSelect.Lobby.NetGameType: "host" };

    private static bool OldIsHostRun(StateSnapshot? state)
        => state is { Run.NetGameType: "host" };

    /// <summary>Every snapshot shape the suites share, plus the two the gates make interesting.</summary>
    internal static IEnumerable<(StateSnapshot? State, string What)> Fixtures()
    {
        foreach (var type in new[] { "host", "client", "singleplayer", "", "wat" })
        {
            yield return (Lobby(type), $"lobby '{type}'");
        }

        yield return (Lobby("host", saved: new StateCharacterSelectSavedRunSnapshot(
            CurrentActIndex: 0,
            ActFloor: 3,
            Players: [new StateCharacterSelectSavedRunPlayerSnapshot("p:1002", 40, 80, 120)])), "saved-run host lobby");
        yield return (MainMenu(), "main menu");
        foreach (var type in new[] { "host", "client", "singleplayer", "multiplayer", "" })
        {
            yield return (RunInProgress(type), $"run '{type}'");
        }

        // A run whose root scene still reads as a lobby (and carries a lobby): the run must win.
        yield return (RunInProgress("host") with
        {
            RootScene = "screens/character_select_screen",
            CharacterSelect = Lobby("host").CharacterSelect,
        }, "run with a lobby-like root scene");
        yield return (null, "no state");
    }

    private static void ParityWithTheDeletedSnapshotPredicates()
    {
        var count = 0;
        foreach (var (state, what) in Fixtures())
        {
            var facts = Project(state);
            Expect(CouchCoopLobbyHostGate.IsHostLobby(facts) == OldIsHostLobby(state), $"lobby gate parity on {what}");
            Expect(CouchCoopLobbyHostGate.ShouldShow(Listener, facts) == (OldIsHostLobby(state)),
                $"lobby button parity on {what}");
            Expect(CouchCoopPauseMenuGate.IsHostRun(facts) == OldIsHostRun(state), $"pause-menu gate parity on {what}");

            var oldEvaluation = state is null
                ? LobbyCheckpointEvaluation.Unavailable
                : OldIsHostLobby(state) ? LobbyCheckpointEvaluation.Host : LobbyCheckpointEvaluation.NotHost;
            Expect(CouchCoopLobbyHostGate.Classify(facts) == oldEvaluation, $"checkpoint evaluation parity on {what}");
            count++;
        }

        Expect(count == 14, "the parity oracle covered every shared fixture");
    }

    // The projection is only an oracle if it agrees with what the reader really emits. Each snapshot fixture is
    // paired with the facts the typed reader reports for that situation, written out by hand.
    private static void ProjectionEqualsTheFactsTheReaderProduces()
    {
        Expect(Project(MainMenu()) == Facts(false, null, null), "main menu");
        Expect(Project(Lobby("host")) == Facts(false, "host", null), "host lobby");
        Expect(Project(Lobby("client")) == Facts(false, "client", null), "client lobby");
        Expect(Project(Lobby("singleplayer")) == Facts(false, "singleplayer", null), "singleplayer lobby");
        Expect(Project(RunInProgress("host")) == Facts(true, null, "host"), "hosted run");
        Expect(Project(RunInProgress("client")) == Facts(true, null, "client"), "client run");
        Expect(Project(null) is null, "no state is unavailable");
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
