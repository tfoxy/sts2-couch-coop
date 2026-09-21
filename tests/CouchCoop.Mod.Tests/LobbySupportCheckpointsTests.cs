using CouchCoop.Mod.HostUi;

namespace CouchCoop.Mod.Tests;

/// <summary>Game-free proof of the bounded support checkpoint grammar and its once-per-epoch state.</summary>
internal static class LobbySupportCheckpointsTests
{
    public static void Run()
    {
        WriterUsesExactGrammarAndSeverity();
        WriterRefusesValuesOutsideTheGrammar();
        LiveHostRuntimeRoutesSupportAndNamesEveryReason();
        LiveHostReasonClassifierIsTotalAndNeverPassesTextThrough();
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

    /// <summary>
    /// A live runtime is routine; a placeholder one is an ERROR, because it costs co-op entirely and silently.
    /// Enumerating the enum is the point: every reason a build can carry must have a token, or the checkpoint
    /// throws instead of inventing one.
    /// </summary>
    private static void LiveHostRuntimeRoutesSupportAndNamesEveryReason()
    {
        var stderr = new List<string>();
        var info = new List<string>();
        var error = new List<string>();
        var checkpoints = new LobbySupportCheckpoints(stderr.Add, info.Add, error.Add);

        checkpoints.LiveHostRuntimeSupported();
        foreach (var reason in Enum.GetValues<LiveHostRuntimeReason>())
        {
            checkpoints.LiveHostRuntimeUnsupported(reason);
        }

        var supported = new[] { "live-host-runtime result=supported" };
        var unsupported = new[]
        {
            "live-host-runtime result=unsupported reason=outside-game-process",
            "live-host-runtime result=unsupported reason=non-live-build",
            "live-host-runtime result=unsupported reason=not-live-adapter",
            "live-host-runtime result=unsupported reason=unreported",
            "live-host-runtime result=unsupported reason=unknown",
        };

        Expect(info.SequenceEqual(supported), "a live host runtime is a routine INFO checkpoint");
        Expect(error.SequenceEqual(unsupported),
            "every stub-runtime reason is an ERROR naming exactly one bounded token, in declaration order");
        Expect(stderr.SequenceEqual(supported.Concat(unsupported)),
            "the live-host pair writes once to stderr in call order");
        Expect(unsupported.Length == Enum.GetValues<LiveHostRuntimeReason>().Length,
            "no reason may be added to the enum without a token and a checkpoint line");
    }

    /// <summary>
    /// The classifier is the only thing standing between a spirectl-owned reason string and a support snapshot,
    /// so its refusal path matters more than its happy path: anything it does not recognise must collapse to a
    /// bounded token rather than travel as text.
    /// </summary>
    private static void LiveHostReasonClassifierIsTotalAndNeverPassesTextThrough()
    {
        Expect(
            LobbySupportCheckpoints.ClassifyLiveHostReason(
                "This live-host build is not running inside an initialized STS2/Godot process.")
                == LiveHostRuntimeReason.OutsideGameProcess,
            "the process gate's reason classifies as outside-game-process");
        Expect(
            LobbySupportCheckpoints.ClassifyLiveHostReason(
                "This build was compiled without live STS2 host references.")
                == LiveHostRuntimeReason.NonLiveBuild,
            "a payload compiled without live-host references classifies as non-live-build");
        Expect(
            LobbySupportCheckpoints.ClassifyLiveHostReason(
                "This runtime was not created from a live STS2 host adapter.")
                == LiveHostRuntimeReason.NotLiveAdapter,
            "the runtime-options default classifies as not-live-adapter");
        Expect(
            LobbySupportCheckpoints.ClassifyLiveHostReason(
                "  This build was compiled without live STS2 host references.  ")
                == LiveHostRuntimeReason.NonLiveBuild,
            "surrounding whitespace does not cost a known reason its token");

        foreach (var absent in new string?[] { null, "", "   ", "\t\n" })
        {
            Expect(LobbySupportCheckpoints.ClassifyLiveHostReason(absent) == LiveHostRuntimeReason.Unreported,
                "a capability with no reason attached classifies as unreported");
        }

        foreach (var unrecognised in new[]
                 {
                     "This live-host build is not running inside an initialized STS2/Godot process",
                     "this build was compiled without live sts2 host references.",
                     "/Users/someone/Library/Application Support/SlayTheSpire2",
                     "System.TypeLoadException: could not load LobbyPlayer",
                     "outside-game-process",
                 })
        {
            Expect(LobbySupportCheckpoints.ClassifyLiveHostReason(unrecognised) == LiveHostRuntimeReason.Unknown,
                $"an unrecognised reason classifies as unknown, never a pass-through: {unrecognised}");
        }

        var error = new List<string>();
        var checkpoints = new LobbySupportCheckpoints(_ => { }, _ => { }, error.Add);
        checkpoints.LiveHostRuntimeUnsupported(
            LobbySupportCheckpoints.ClassifyLiveHostReason("/Users/secret/Library/Application Support"));
        Expect(error.SequenceEqual(new[] { "live-host-runtime result=unsupported reason=unknown" }),
            "no fragment of an unrecognised reason reaches the log line");
    }

    private static void WriterRefusesValuesOutsideTheGrammar()
    {
        var checkpoints = new LobbySupportCheckpoints(_ => { }, _ => { }, _ => { });
        ExpectThrows(() => checkpoints.LiveHostRuntimeUnsupported((LiveHostRuntimeReason)99),
            "a reason outside the bounded enum is refused rather than written");
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
