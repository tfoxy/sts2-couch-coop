using System.Reflection;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// The pause menu's half of <see cref="GodotNodeMountHook"/>: tells <see cref="CouchCoopPauseMenuQrEntry"/> when
/// the game has readied an <c>NPauseMenu</c>, so the QR row can be parented into the menu's own button column.
/// </summary>
/// <remarks>
/// <para>
/// Same adapter shape as <see cref="LobbyScreenMountPatch"/> — declaration-only target resolution, a plan that
/// keeps a failed target pending and never re-patches a successful one, and player-facing reporting here rather
/// than in the reusable hook.
/// </para>
/// <para>
/// IT REPORTS <c>costsCoop: false</c>, and that is the one deliberate difference. Losing the lobby mount costs
/// the session its only QR entry point; losing this one costs a convenience that exists for a device that already
/// joined once and dropped out. Raising the fatal host-issue row for it would tell a player co-op cannot run when
/// it demonstrably can.
/// </para>
/// </remarks>
internal static class PauseMenuMountPatch
{
    private static readonly object Sync = new();
    private static readonly GodotNodeMountHook Hook = new(
        "com.couchcoop.pause-menu-mount",
        PauseMenuMountTargets.Targets,
        CouchCoopPauseMenuQrEntry.NotePauseMenuMounted,
        ReportTargetFailure,
        ReportCallbackFailure);
    private static int _attempts;

    /// <summary>The full game type names, retained as the reflection guard's public contract.</summary>
    internal static IReadOnlyList<string> ScreenTypeNames => PauseMenuMountTargets.TypeNames;
    internal const string ReadyMethodName = PauseMenuMountTargets.ReadyMethodName;

    /// <summary>Install the mount hook on each target that remains pending.</summary>
    internal static bool Apply()
    {
        lock (Sync)
        {
            if (Hook.IsComplete)
            {
                return true;
            }

            _attempts++;
            var complete = Hook.Apply();
            var installedCount = Hook.TargetCount - Hook.Pending.Count;
            CouchCoopLog.Stderr($"pause menu mount patch installed targets={installedCount}/{Hook.TargetCount}");
            if (!complete)
            {
                ReportIncomplete($"still pending: {string.Join(", ", Hook.Pending)}", retryExhausted: _attempts > 1);
            }

            return complete;
        }
    }

    internal static MethodInfo? ResolveDeclaredReady(string typeName) =>
        GodotNodeMountHook.ResolveDeclaredZeroArgumentMethod(
            new GodotNodeMountTarget(typeName, ReadyMethodName), ReportTargetFailure);

    private static void ReportIncomplete(string detail, bool retryExhausted)
    {
        var message = $"pause menu mount patch INCOMPLETE ({detail}) — the Couch Co-Op QR button "
            + "will not appear in the pause menu this session";
        CouchCoopLog.Stderr(message);
        CouchCoopLog.Error(message);
        if (retryExhausted)
        {
            Connections.CouchCoopPatchHealth.PatchFailed(nameof(PauseMenuMountPatch), costsCoop: false, message);
        }
    }

    private static void ReportTargetFailure(GodotNodeMountFailure failure)
    {
        var target = failure.Target;
        switch (failure.Kind)
        {
            case GodotNodeMountFailureKind.TypeNotFound:
                CouchCoopLog.Stderr($"PauseMenuMountPatch: {target.TypeName} not found.");
                break;
            case GodotNodeMountFailureKind.MethodNotFound:
                CouchCoopLog.Stderr($"PauseMenuMountPatch: {target.TypeName}.{target.MethodName} not found.");
                break;
            case GodotNodeMountFailureKind.MethodNotDeclared:
                CouchCoopLog.Stderr(
                    $"PauseMenuMountPatch: {target.TypeName} does not declare {target.MethodName} "
                    + $"(would have patched {failure.Detail ?? "unknown"}) — refused.");
                break;
            case GodotNodeMountFailureKind.MethodHasParameters:
                CouchCoopLog.Stderr(
                    $"PauseMenuMountPatch: {target.TypeName}.{target.MethodName} has parameters — refused.");
                break;
            case GodotNodeMountFailureKind.PatchFailed:
                CouchCoopPatchDiagnostics.PatchFailed(
                    nameof(PauseMenuMountPatch),
                    $"Harmony patch of {target.TypeName}.{target.MethodName} failed ({failure.Detail ?? "unknown"}).",
                    costsCoop: false);
                break;
        }
    }

    private static void ReportCallbackFailure(Exception exception)
    {
        var detail = $"{exception.GetType().Name}: {exception.Message}";
        CouchCoopLog.Stderr($"PauseMenuMountPatch: mount note failed: {detail[..Math.Min(detail.Length, 480)]}");
    }
}
