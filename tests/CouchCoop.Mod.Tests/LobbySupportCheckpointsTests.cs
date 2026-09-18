using CouchCoop.Mod.HostUi;

namespace CouchCoop.Mod.Tests;

/// <summary>Game-free proof of the bounded support checkpoint grammar and its once-per-epoch state.</summary>
internal static class LobbySupportCheckpointsTests
{
    public static void Run()
    {
        WriterUsesExactGrammarAndSeverity();
        WriterRefusesValuesOutsideTheGrammar();
        StateReportsBothScreenKindsAndDeduplicatesTicks();
        PanelFailuresAreOncePerEpochAndCoverEveryCategory();
        Console.WriteLine("LobbySupportCheckpointsTests: ok");
    }

    private static void WriterUsesExactGrammarAndSeverity()
    {
        var stderr = new List<string>();
        var info = new List<string>();
        var error = new List<string>();
        var checkpoints = new LobbySupportCheckpoints(stderr.Add, info.Add, error.Add);

        checkpoints.LobbyPatchAttempt(LobbyPatchAttemptPhase.Initial, 2);
        checkpoints.LobbyPatchAttempt(LobbyPatchAttemptPhase.Retry, 0);
        checkpoints.LobbyPatchComplete(2);
        checkpoints.LobbyPatchIncomplete(1, LobbyPatchRetryState.Pending);
        checkpoints.LobbyPatchIncomplete(0, LobbyPatchRetryState.Exhausted);
        checkpoints.HostBrowserListener(true);
        checkpoints.HostBrowserListener(false);
        checkpoints.LobbyControllerArmed();
        checkpoints.LobbyScreenMounted(LobbyCheckpointScreenKind.CharacterSelect);
        checkpoints.LobbyScreenMounted(LobbyCheckpointScreenKind.LoadGame);
        checkpoints.HostLobbyEvaluated(LobbyCheckpointScreenKind.CharacterSelect, LobbyCheckpointEvaluation.Host);
        checkpoints.HostLobbyEvaluated(LobbyCheckpointScreenKind.LoadGame, LobbyCheckpointEvaluation.NotHost);
        checkpoints.HostLobbyEvaluated(LobbyCheckpointScreenKind.LoadGame, LobbyCheckpointEvaluation.Unavailable);
        checkpoints.QrPanelInstallEnter(LobbyCheckpointScreenKind.CharacterSelect);
        checkpoints.QrPanelInstallComplete(LobbyCheckpointScreenKind.CharacterSelect);
        checkpoints.QrPanelInstallFailed(LobbyCheckpointScreenKind.LoadGame, QrPanelInstallFailureCategory.Attach);

        var routine = new[]
        {
            "lobby-patch-attempt phase=initial pending=2 total=2",
            "lobby-patch-attempt phase=retry pending=0 total=2",
            "lobby-patch-complete targets=2 total=2",
            "lobby-patch-incomplete targets=1 total=2 retry=pending",
            "host-browser-listener result=available",
            "lobby-controller-armed",
            "lobby-screen-mounted kind=character-select",
            "lobby-screen-mounted kind=load-game",
            "host-lobby-evaluated kind=character-select result=host",
            "host-lobby-evaluated kind=load-game result=not-host",
            "host-lobby-evaluated kind=load-game result=unavailable",
            "qr-panel-install-enter kind=character-select",
            "qr-panel-install-complete kind=character-select",
        };
        var failures = new[]
        {
            "lobby-patch-incomplete targets=0 total=2 retry=exhausted",
            "host-browser-listener result=unavailable",
            "qr-panel-install-failed kind=load-game category=attach",
        };

        Expect(info.SequenceEqual(routine), "routine checkpoints write exactly and in order to INFO");
        Expect(error.SequenceEqual(failures), "terminal checkpoints write exactly and in order to ERROR");
        Expect(stderr.SequenceEqual(new[]
        {
            routine[0], routine[1], routine[2], routine[3], failures[0], routine[4], failures[1], routine[5],
            routine[6], routine[7], routine[8], routine[9], routine[10], routine[11], routine[12], failures[2],
        }), "every checkpoint writes exactly once to stderr in call order");
    }

    private static void StateReportsBothScreenKindsAndDeduplicatesTicks()
    {
        var stderr = new List<string>();
        var info = new List<string>();
        var error = new List<string>();
        var state = new LobbyCheckpointState(new LobbySupportCheckpoints(stderr.Add, info.Add, error.Add));

        state.ControllerArmed();
        state.ControllerArmed();
        state.ScreenMounted(101, LobbyCheckpointScreenKind.CharacterSelect);
        state.ScreenMounted(101, LobbyCheckpointScreenKind.CharacterSelect);
        state.ScreenMounted(202, LobbyCheckpointScreenKind.CharacterSelect);
        state.ScreenMounted(303, LobbyCheckpointScreenKind.LoadGame);
        state.VisibleHostLobbyEvaluated(101, LobbyCheckpointScreenKind.CharacterSelect, LobbyCheckpointEvaluation.Host);
        state.VisibleHostLobbyEvaluated(101, LobbyCheckpointScreenKind.CharacterSelect, LobbyCheckpointEvaluation.Host);
        state.VisibleHostLobbyEvaluated(202, LobbyCheckpointScreenKind.CharacterSelect, LobbyCheckpointEvaluation.Host);
        state.VisibleHostLobbyEvaluated(202, LobbyCheckpointScreenKind.CharacterSelect, LobbyCheckpointEvaluation.NotHost);
        state.VisibleHostLobbyEvaluated(303, LobbyCheckpointScreenKind.LoadGame, LobbyCheckpointEvaluation.Unavailable);
        state.EndVisibleEpoch(101, LobbyCheckpointScreenKind.CharacterSelect);
        state.VisibleHostLobbyEvaluated(101, LobbyCheckpointScreenKind.CharacterSelect, LobbyCheckpointEvaluation.NotHost);

        Expect(error.Count == 0, "arming and host evaluation transitions are routine");
        Expect(info.SequenceEqual(new[]
        {
            "lobby-controller-armed",
            "lobby-screen-mounted kind=character-select",
            "lobby-screen-mounted kind=character-select",
            "lobby-screen-mounted kind=load-game",
            "host-lobby-evaluated kind=character-select result=host",
            "host-lobby-evaluated kind=character-select result=host",
            "host-lobby-evaluated kind=character-select result=not-host",
            "host-lobby-evaluated kind=load-game result=unavailable",
            "host-lobby-evaluated kind=character-select result=not-host",
        }), "two screen instances remain independent while duplicate IDs and repeated ticks are deduplicated");
    }

    private static void WriterRefusesValuesOutsideTheGrammar()
    {
        var checkpoints = new LobbySupportCheckpoints(_ => { }, _ => { }, _ => { });
        ExpectThrows(() => checkpoints.LobbyPatchAttempt(LobbyPatchAttemptPhase.Initial, 1),
            "initial patch attempts always begin with exactly two pending targets");
        ExpectThrows(() => checkpoints.LobbyPatchAttempt(LobbyPatchAttemptPhase.Retry, 3),
            "retry pending count is bounded by the two target contract");
        ExpectThrows(() => checkpoints.LobbyPatchComplete(1), "patch completion always names both targets");
        ExpectThrows(() => checkpoints.LobbyPatchIncomplete(2, LobbyPatchRetryState.Pending),
            "an incomplete patch never claims both targets");
    }

    private static void PanelFailuresAreOncePerEpochAndCoverEveryCategory()
    {
        foreach (var category in Enum.GetValues<QrPanelInstallFailureCategory>())
        {
            var stderr = new List<string>();
            var info = new List<string>();
            var error = new List<string>();
            var state = new LobbyCheckpointState(new LobbySupportCheckpoints(stderr.Add, info.Add, error.Add));

            const ulong instanceId = 77;
            Expect(state.BeginPanelInstall(instanceId, LobbyCheckpointScreenKind.LoadGame), $"{category}: first install enters");
            state.PanelInstallFailed(instanceId, LobbyCheckpointScreenKind.LoadGame, category);
            for (var tick = 0; tick < 200; tick++)
            {
                Expect(!state.BeginPanelInstall(instanceId, LobbyCheckpointScreenKind.LoadGame),
                    $"{category}: identical tick {tick} retries without another checkpoint epoch");
                state.PanelInstallFailed(instanceId, LobbyCheckpointScreenKind.LoadGame, category);
            }
            state.PanelInstallComplete(instanceId, LobbyCheckpointScreenKind.LoadGame);
            state.PanelInstallComplete(instanceId, LobbyCheckpointScreenKind.LoadGame);
            Expect(state.BeginPanelInstall(instanceId, LobbyCheckpointScreenKind.LoadGame),
                $"{category}: a disappeared completed panel starts a fresh install epoch");
            state.PanelInstallComplete(instanceId, LobbyCheckpointScreenKind.LoadGame);

            var token = category switch
            {
                QrPanelInstallFailureCategory.Lookup => "lookup",
                QrPanelInstallFailureCategory.Create => "create",
                QrPanelInstallFailureCategory.StreamSkip => "stream-skip",
                QrPanelInstallFailureCategory.Attach => "attach",
                QrPanelInstallFailureCategory.Initialize => "initialize",
                QrPanelInstallFailureCategory.Activate => "activate",
                _ => throw new ArgumentOutOfRangeException(),
            };
            Expect(info.SequenceEqual(new[]
            {
                "qr-panel-install-enter kind=load-game",
                "qr-panel-install-complete kind=load-game",
                "qr-panel-install-enter kind=load-game",
                "qr-panel-install-complete kind=load-game",
            }), $"{category}: failure retries stay silent and each completed-panel epoch emits once");
            Expect(error.SequenceEqual(new[] { $"qr-panel-install-failed kind=load-game category={token}" }),
                $"{category}: exact failure category is ERROR once per epoch");
            Expect(stderr.SequenceEqual(new[]
            {
                "qr-panel-install-enter kind=load-game",
                $"qr-panel-install-failed kind=load-game category={token}",
                "qr-panel-install-complete kind=load-game",
                "qr-panel-install-enter kind=load-game",
                "qr-panel-install-complete kind=load-game",
            }), $"{category}: stderr preserves event order in the bounded grammar");
        }
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"LobbySupportCheckpointsTests failed: {message}");
    }

    private static void ExpectThrows(Action action, string message)
    {
        try
        {
            action();
        }
        catch (ArgumentOutOfRangeException)
        {
            return;
        }

        throw new InvalidOperationException($"LobbySupportCheckpointsTests failed: {message}");
    }
}
