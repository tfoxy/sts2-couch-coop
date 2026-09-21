namespace CouchCoop.Mod.HostUi;

/// <summary>Bounded names used by the lobby support log contract.</summary>
public enum LobbyCheckpointScreenKind
{
    CharacterSelect,
    LoadGame,
}

public enum LobbyCheckpointEvaluation
{
    Host,
    NotHost,
    Unavailable,
}

public enum QrPanelInstallFailureCategory
{
    Lookup,
    Create,
    StreamSkip,
    Attach,
    Initialize,
    Activate,
}

public enum LobbyPatchAttemptPhase
{
    Initial,
    Retry,
}

public enum LobbyPatchRetryState
{
    Pending,
    Exhausted,
}

/// <summary>
/// Why the embedded spirectl runtime refused to be a LIVE STS2 host — i.e. why this process got a placeholder
/// runtime with no state provider instead of the real one.
/// </summary>
/// <remarks>
/// The distinction costs co-op entirely and is otherwise invisible: a placeholder runtime answers every state
/// observation with a fabricated main menu that is byte-identical to a real one, so the lobby is classified
/// <c>not-host</c> forever and no QR button is ever built. These tokens are the only thing that separates
/// "the player is a guest" from "the runtime cannot answer".
/// </remarks>
public enum LiveHostRuntimeReason
{
    /// <summary>The build can host, but this process was not recognised as the game's own process.</summary>
    OutsideGameProcess,

    /// <summary>The payload was compiled without live-host references at all — a lane/packaging fault.</summary>
    NonLiveBuild,

    /// <summary>The runtime was composed from something other than a live host adapter.</summary>
    NotLiveAdapter,

    /// <summary>The capability was absent, or present with no reason attached.</summary>
    Unreported,

    /// <summary>A reason was reported that this build does not recognise. Never the reason text itself.</summary>
    Unknown,
}

/// <summary>
/// Writes the deliberately small, machine-checkable lobby support checkpoint vocabulary.
/// </summary>
/// <remarks>
/// The writer deliberately has injected sinks: its grammar and severity can be proven without a Godot process,
/// while production supplies the normal stderr, INFO and ERROR routes. Do not add exception text, screen names,
/// URLs or other runtime-derived detail here; this stream is safe to include in a support snapshot precisely
/// because every token is bounded below.
/// </remarks>
public sealed class LobbySupportCheckpoints
{
    public const int PatchTargetCount = 2;

    // The three reason strings spirectl's runtime factory can publish on the `live-sts2-host` capability,
    // copied because they are not exported yet: two are private consts in
    // Spirectl.Sts2.Sts2EmbeddableRuntimeFactory and the third is the default argument of
    // Spirectl.Sts2.Embedding.EmbeddableRuntimeOptions.LiveSts2HostUnsupportedReason. Once spirectl publishes
    // them, each initializer below becomes `= <spirectl constant>;` — one line each, nothing else moves,
    // because ClassifyLiveHostReason and its tests only ever see these names.
    //
    // Before flipping, note that THIS FILE is source-linked into tests/CouchCoop.MacOs.Tests, which carries no
    // spirectl (or any) reference on purpose; the flip therefore also needs that project to gain one, or the
    // pin belongs in a spirectl-aware suite instead. Drift is not silent in either direction: an unmatched
    // string classifies as `unknown`, which reads as "spirectl changed its wording", not as a pass-through.
    private const string OutsideGameProcessReason =
        "This live-host build is not running inside an initialized STS2/Godot process.";
    private const string NonLiveBuildReason =
        "This build was compiled without live STS2 host references.";
    private const string NotLiveAdapterReason =
        "This runtime was not created from a live STS2 host adapter.";

    private readonly Action<string> _stderr;
    private readonly Action<string> _info;
    private readonly Action<string> _error;

    public LobbySupportCheckpoints(Action<string> stderr, Action<string> info, Action<string> error)
    {
        _stderr = stderr ?? throw new ArgumentNullException(nameof(stderr));
        _info = info ?? throw new ArgumentNullException(nameof(info));
        _error = error ?? throw new ArgumentNullException(nameof(error));
    }

    /// <summary>The embedded spirectl runtime is the live one; every later checkpoint is worth reading.</summary>
    public void LiveHostRuntimeSupported() => Routine("live-host-runtime result=supported");

    /// <summary>
    /// The embedded spirectl runtime is a placeholder. ERROR, not a warning: nothing downstream of this can
    /// work, and every later <c>host-lobby-evaluated result=not-host</c> is a consequence of it rather than a
    /// finding of its own.
    /// </summary>
    public void LiveHostRuntimeUnsupported(LiveHostRuntimeReason reason)
        => Failure($"live-host-runtime result=unsupported reason={LiveHostReason(reason)}");

    /// <summary>
    /// Map the reason string spirectl publishes on the <c>live-sts2-host</c> capability onto a bounded token.
    /// Pure, total, and deliberately never a pass-through: an unrecognised reason becomes
    /// <see cref="LiveHostRuntimeReason.Unknown"/> so that no runtime-derived text — a path, a type name, an
    /// exception message — can reach a support snapshot through this route.
    /// </summary>
    public static LiveHostRuntimeReason ClassifyLiveHostReason(string? reason)
    {
        var trimmed = reason?.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return LiveHostRuntimeReason.Unreported;
        }

        return trimmed switch
        {
            OutsideGameProcessReason => LiveHostRuntimeReason.OutsideGameProcess,
            NonLiveBuildReason => LiveHostRuntimeReason.NonLiveBuild,
            NotLiveAdapterReason => LiveHostRuntimeReason.NotLiveAdapter,
            _ => LiveHostRuntimeReason.Unknown,
        };
    }

    public void LobbyPatchAttempt(LobbyPatchAttemptPhase phase, int pending)
    {
        if (phase == LobbyPatchAttemptPhase.Initial && pending != PatchTargetCount)
        {
            throw new ArgumentOutOfRangeException(nameof(pending));
        }
        RequirePending(pending);
        Routine($"lobby-patch-attempt phase={PatchPhase(phase)} pending={pending} total={PatchTargetCount}");
    }

    public void LobbyPatchComplete(int targets)
    {
        if (targets != PatchTargetCount)
        {
            throw new ArgumentOutOfRangeException(nameof(targets));
        }
        Routine($"lobby-patch-complete targets={targets} total={PatchTargetCount}");
    }

    public void LobbyPatchIncomplete(int targets, LobbyPatchRetryState retry)
    {
        if (targets is < 0 or >= PatchTargetCount)
        {
            throw new ArgumentOutOfRangeException(nameof(targets));
        }
        var message = $"lobby-patch-incomplete targets={targets} total={PatchTargetCount} retry={Retry(retry)}";
        if (retry == LobbyPatchRetryState.Exhausted)
        {
            Failure(message);
            return;
        }

        Routine(message);
    }

    public void HostBrowserListener(bool available)
    {
        var message = $"host-browser-listener result={(available ? "available" : "unavailable")}";
        if (available)
        {
            Routine(message);
            return;
        }

        Failure(message);
    }

    public void LobbyControllerArmed() => Routine("lobby-controller-armed");

    public void LobbyScreenMounted(LobbyCheckpointScreenKind kind)
        => Routine($"lobby-screen-mounted kind={Kind(kind)}");

    public void HostLobbyEvaluated(LobbyCheckpointScreenKind kind, LobbyCheckpointEvaluation result)
        => Routine($"host-lobby-evaluated kind={Kind(kind)} result={Evaluation(result)}");

    public void QrPanelInstallEnter(LobbyCheckpointScreenKind kind)
        => Routine($"qr-panel-install-enter kind={Kind(kind)}");

    public void QrPanelInstallComplete(LobbyCheckpointScreenKind kind)
        => Routine($"qr-panel-install-complete kind={Kind(kind)}");

    public void QrPanelInstallFailed(LobbyCheckpointScreenKind kind, QrPanelInstallFailureCategory category)
        => Failure($"qr-panel-install-failed kind={Kind(kind)} category={FailureCategory(category)}");

    private void Routine(string message)
    {
        _stderr(message);
        _info(message);
    }

    private void Failure(string message)
    {
        _stderr(message);
        _error(message);
    }

    private static void RequirePending(int pending)
    {
        if (pending is < 0 or > PatchTargetCount)
        {
            throw new ArgumentOutOfRangeException(nameof(pending));
        }
    }

    private static string PatchPhase(LobbyPatchAttemptPhase phase) => phase switch
    {
        LobbyPatchAttemptPhase.Initial => "initial",
        LobbyPatchAttemptPhase.Retry => "retry",
        _ => throw new ArgumentOutOfRangeException(nameof(phase)),
    };

    private static string LiveHostReason(LiveHostRuntimeReason reason) => reason switch
    {
        LiveHostRuntimeReason.OutsideGameProcess => "outside-game-process",
        LiveHostRuntimeReason.NonLiveBuild => "non-live-build",
        LiveHostRuntimeReason.NotLiveAdapter => "not-live-adapter",
        LiveHostRuntimeReason.Unreported => "unreported",
        LiveHostRuntimeReason.Unknown => "unknown",
        _ => throw new ArgumentOutOfRangeException(nameof(reason)),
    };

    private static string Retry(LobbyPatchRetryState retry) => retry switch
    {
        LobbyPatchRetryState.Pending => "pending",
        LobbyPatchRetryState.Exhausted => "exhausted",
        _ => throw new ArgumentOutOfRangeException(nameof(retry)),
    };

    private static string Kind(LobbyCheckpointScreenKind kind) => kind switch
    {
        LobbyCheckpointScreenKind.CharacterSelect => "character-select",
        LobbyCheckpointScreenKind.LoadGame => "load-game",
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    private static string Evaluation(LobbyCheckpointEvaluation result) => result switch
    {
        LobbyCheckpointEvaluation.Host => "host",
        LobbyCheckpointEvaluation.NotHost => "not-host",
        LobbyCheckpointEvaluation.Unavailable => "unavailable",
        _ => throw new ArgumentOutOfRangeException(nameof(result)),
    };

    private static string FailureCategory(QrPanelInstallFailureCategory category) => category switch
    {
        QrPanelInstallFailureCategory.Lookup => "lookup",
        QrPanelInstallFailureCategory.Create => "create",
        QrPanelInstallFailureCategory.StreamSkip => "stream-skip",
        QrPanelInstallFailureCategory.Attach => "attach",
        QrPanelInstallFailureCategory.Initialize => "initialize",
        QrPanelInstallFailureCategory.Activate => "activate",
        _ => throw new ArgumentOutOfRangeException(nameof(category)),
    };
}

/// <summary>
/// Game-free deduplication state for lobby checkpoints. A visibility loss starts a fresh panel-install epoch.
/// </summary>
public sealed class LobbyCheckpointState(LobbySupportCheckpoints checkpoints)
{
    private readonly LobbySupportCheckpoints _checkpoints = checkpoints ?? throw new ArgumentNullException(nameof(checkpoints));
    private readonly HashSet<ScreenKey> _mounted = [];
    private readonly Dictionary<ScreenKey, LobbyCheckpointEvaluation> _visibleEvaluations = [];
    private readonly Dictionary<ScreenKey, PanelInstallState> _panelInstalls = [];
    private bool _controllerArmed;

    public void ControllerArmed()
    {
        if (_controllerArmed)
        {
            return;
        }

        _controllerArmed = true;
        _checkpoints.LobbyControllerArmed();
    }

    public void ScreenMounted(ulong instanceId, LobbyCheckpointScreenKind kind)
    {
        var key = new ScreenKey(instanceId, kind);
        if (_mounted.Add(key))
        {
            _checkpoints.LobbyScreenMounted(kind);
        }
    }

    public void VisibleHostLobbyEvaluated(ulong instanceId, LobbyCheckpointScreenKind kind, LobbyCheckpointEvaluation result)
    {
        var key = new ScreenKey(instanceId, kind);
        if (_visibleEvaluations.TryGetValue(key, out var previous) && previous == result)
        {
            return;
        }

        _visibleEvaluations[key] = result;
        _checkpoints.HostLobbyEvaluated(kind, result);
    }

    /// <summary>Close a visible epoch when a screen hides or leaves the visible lobby stack.</summary>
    public void EndVisibleEpoch(ulong instanceId, LobbyCheckpointScreenKind kind)
    {
        var key = new ScreenKey(instanceId, kind);
        _visibleEvaluations.Remove(key);
        _panelInstalls.Remove(key);
    }

    /// <summary>Forget only the panel epoch while retaining this visible screen's evaluation transition.</summary>
    public void EndPanelInstallEpoch(ulong instanceId, LobbyCheckpointScreenKind kind)
        => _panelInstalls.Remove(new ScreenKey(instanceId, kind));

    /// <summary>
    /// Observe an attempt to install a panel. Returns true when this starts a checkpoint epoch; callers must
    /// always continue their actual install attempt, including after a previously logged failure.
    /// </summary>
    public bool BeginPanelInstall(ulong instanceId, LobbyCheckpointScreenKind kind)
    {
        var key = new ScreenKey(instanceId, kind);
        if (_panelInstalls.TryGetValue(key, out var state) && state != PanelInstallState.Completed)
        {
            return false;
        }

        _panelInstalls[key] = PanelInstallState.Entered;
        _checkpoints.QrPanelInstallEnter(kind);
        return true;
    }

    public void PanelInstallComplete(ulong instanceId, LobbyCheckpointScreenKind kind)
    {
        var key = new ScreenKey(instanceId, kind);
        if (!_panelInstalls.TryGetValue(key, out var state) || state == PanelInstallState.Completed)
        {
            return;
        }

        _panelInstalls[key] = PanelInstallState.Completed;
        _checkpoints.QrPanelInstallComplete(kind);
    }

    public void PanelInstallFailed(ulong instanceId, LobbyCheckpointScreenKind kind, QrPanelInstallFailureCategory category)
    {
        var key = new ScreenKey(instanceId, kind);
        if (!_panelInstalls.TryGetValue(key, out var state) || state != PanelInstallState.Entered)
        {
            return;
        }

        _panelInstalls[key] = PanelInstallState.Failed;
        _checkpoints.QrPanelInstallFailed(kind, category);
    }

    private readonly record struct ScreenKey(ulong InstanceId, LobbyCheckpointScreenKind Kind);

    private enum PanelInstallState
    {
        Entered,
        Completed,
        Failed,
    }
}
