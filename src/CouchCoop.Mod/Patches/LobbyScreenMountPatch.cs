using System.Reflection;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Production adapter for the game-free <see cref="GodotNodeMountHook"/>. It owns only CouchCoop's panel callback
/// and player-facing health/detail reporting; the declaration-only Harmony mechanics live in the reusable hook.
/// </summary>
internal static class LobbyScreenMountPatch
{
    private static readonly object Sync = new();
    private static readonly GodotNodeMountHook Hook = new(
        "com.couchcoop.lobby-screen-mount",
        LobbyScreenMountTargets.Targets,
        CouchCoopQrHostPanelController.NoteLobbyScreenMounted,
        ReportTargetFailure,
        ReportCallbackFailure);
    private static int _attempts;

    /// <summary>The full game type names, retained as the reflection guard's public contract.</summary>
    internal static IReadOnlyList<string> ScreenTypeNames => LobbyScreenMountTargets.TypeNames;
    internal const string ReadyMethodName = LobbyScreenMountTargets.ReadyMethodName;

    /// <summary>Install the mount hook on each target that remains pending.</summary>
    internal static bool Apply()
    {
        lock (Sync)
        {
            if (Hook.IsComplete)
            {
                return true;
            }

            var phase = _attempts == 0 ? LobbyPatchAttemptPhase.Initial : LobbyPatchAttemptPhase.Retry;
            CouchCoopMod.LobbyCheckpoints.LobbyPatchAttempt(phase, Hook.Pending.Count);
            _attempts++;
            var complete = Hook.Apply();
            var installedCount = Hook.TargetCount - Hook.Pending.Count;
            CouchCoopLog.Stderr($"lobby screen mount patch installed targets={installedCount}/{Hook.TargetCount}");
            if (complete)
            {
                CouchCoopMod.LobbyCheckpoints.LobbyPatchComplete(installedCount);
            }
            if (!complete)
            {
                var retryExhausted = _attempts > 1;
                CouchCoopMod.LobbyCheckpoints.LobbyPatchIncomplete(
                    installedCount,
                    retryExhausted ? LobbyPatchRetryState.Exhausted : LobbyPatchRetryState.Pending);
                ReportIncomplete($"still pending: {string.Join(", ", Hook.Pending)}", retryExhausted);
            }

            return complete;
        }
    }

    internal static MethodInfo? ResolveDeclaredReady(string typeName) =>
        GodotNodeMountHook.ResolveDeclaredZeroArgumentMethod(
            new GodotNodeMountTarget(typeName, ReadyMethodName), ReportTargetFailure);

    private static void ReportIncomplete(string detail, bool retryExhausted)
    {
        var message = $"lobby screen mount patch INCOMPLETE ({detail}) — the Couch Co-Op QR button "
            + "will not appear in the lobby this session";
        CouchCoopLog.Stderr(message);
        CouchCoopLog.Error(message);
        if (retryExhausted)
        {
            Connections.CouchCoopPatchHealth.PatchFailed(nameof(LobbyScreenMountPatch), costsCoop: true, message);
        }
    }

    private static void ReportTargetFailure(GodotNodeMountFailure failure)
    {
        var target = failure.Target;
        switch (failure.Kind)
        {
            case GodotNodeMountFailureKind.TypeNotFound:
                CouchCoopLog.Stderr($"LobbyScreenMountPatch: {target.TypeName} not found.");
                break;
            case GodotNodeMountFailureKind.MethodNotFound:
                CouchCoopLog.Stderr($"LobbyScreenMountPatch: {target.TypeName}.{target.MethodName} not found.");
                break;
            case GodotNodeMountFailureKind.MethodNotDeclared:
                CouchCoopLog.Stderr(
                    $"LobbyScreenMountPatch: {target.TypeName} does not declare {target.MethodName} "
                    + $"(would have patched {failure.Detail ?? "unknown"}) — refused.");
                break;
            case GodotNodeMountFailureKind.MethodHasParameters:
                CouchCoopLog.Stderr(
                    $"LobbyScreenMountPatch: {target.TypeName}.{target.MethodName} has parameters — refused.");
                break;
            case GodotNodeMountFailureKind.PatchFailed:
                CouchCoopPatchDiagnostics.PatchFailed(
                    nameof(LobbyScreenMountPatch),
                    $"Harmony patch of {target.TypeName}.{target.MethodName} failed ({failure.Detail ?? "unknown"}).",
                    costsCoop: false);
                break;
        }
    }

    private static void ReportCallbackFailure(Exception exception)
    {
        var detail = $"{exception.GetType().Name}: {exception.Message}";
        CouchCoopLog.Stderr($"LobbyScreenMountPatch: mount note failed: {detail[..Math.Min(detail.Length, 480)]}");
    }
}
