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

    private readonly Action<string> _stderr;
    private readonly Action<string> _info;
    private readonly Action<string> _error;

    public LobbySupportCheckpoints(Action<string> stderr, Action<string> info, Action<string> error)
    {
        _stderr = stderr ?? throw new ArgumentNullException(nameof(stderr));
        _info = info ?? throw new ArgumentNullException(nameof(info));
        _error = error ?? throw new ArgumentNullException(nameof(error));
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
