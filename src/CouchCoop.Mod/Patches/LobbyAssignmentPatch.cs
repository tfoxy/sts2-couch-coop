using System.Reflection;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Session;
using HarmonyLib;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Multiplayer.Messages.Lobby;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Saves;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Tells the QR host panel when the game assigns a lobby to a lobby screen, so the panel learns of the change
/// instead of looking for it.
/// </summary>
/// <remarks>
/// <para>
/// TWO JOBS, ONE POSTFIX SHAPE. On the saved-run screen the postfix RECORDS the role the assignment implies (host or
/// client) and the save the lobby was given (whose player count is that lobby's player cap), because that screen
/// keeps its lobby private and this is the only typed way to know either. On every target it WAKES the evaluation,
/// because an assignment on a screen that is already current is a change the game's screen event would not
/// announce, and the gate facts are read only when something pushes.
/// </para>
/// <para>
/// A POSTFIX DOES NOTHING ELSE. It records, then wakes. It never resolves the current screen and never reads game
/// state: it runs inside the game's own initializer, and touching the game from inside a game callback faults the
/// process without a managed exception. The wake defers the evaluation by one frame, and the evaluation is what
/// reads. A postfix does not run when the original throws, so a rejected initialization records nothing.
/// </para>
/// <para>
/// Declared methods only, the same rule as <see cref="GodotNodeMountHook"/>: a method the type merely inherits would
/// hook every subclass. Applied more than once (at mod init and again from the panel controller's own init) with the
/// mount patch's pending-set plan, so a second attempt patches only what is still missing and a target already
/// installed is never patched twice.
/// </para>
/// </remarks>
internal static class LobbyAssignmentPatch
{
    /// <summary>
    /// The typed binding for each entry of <see cref="LobbyAssignmentTargets.Targets"/>, in the same order:
    /// <c>nameof</c> members and <c>typeof</c> parameter types, so a rename or reshape in a game update is a compile
    /// error rather than a silently missing hook. Signatures are identical on both API lanes.
    /// </summary>
    internal static IReadOnlyList<LobbyAssignmentBinding> Bindings { get; } =
    [
        new(typeof(NCharacterSelectScreen), nameof(NCharacterSelectScreen.InitializeMultiplayerAsHost),
            [typeof(INetGameService), typeof(int)], Role: null, nameof(PostfixWake)),
        new(typeof(NCharacterSelectScreen), nameof(NCharacterSelectScreen.InitializeMultiplayerAsClient),
            [typeof(INetGameService), typeof(ClientLobbyJoinResponseMessage)], Role: null, nameof(PostfixWake)),
        new(typeof(NCharacterSelectScreen), nameof(NCharacterSelectScreen.InitializeSingleplayer),
            [], Role: null, nameof(PostfixWake)),
        new(typeof(NMultiplayerLoadGameScreen), nameof(NMultiplayerLoadGameScreen.InitializeAsHost),
            [typeof(INetGameService), typeof(SerializableRun)], NetTypeNames.Host, nameof(PostfixLoadRunAsHost)),
        new(typeof(NMultiplayerLoadGameScreen), nameof(NMultiplayerLoadGameScreen.InitializeAsClient),
            [typeof(INetGameService), typeof(ClientLoadJoinResponseMessage)], NetTypeNames.Client, nameof(PostfixLoadRunAsClient)),
    ];

    private static readonly object Sync = new();
    private static Harmony? _harmony;
    private static LobbyScreenMountPlan? _plan;
    private static int _attempts;

    /// <summary>One typed target: the declared method, and which postfix (and role) it gets.</summary>
    internal readonly record struct LobbyAssignmentBinding(
        Type Type,
        string MethodName,
        Type[] Parameters,
        string? Role,
        string Postfix)
    {
        internal string Key => $"{Type.FullName}.{MethodName}/{Parameters.Length}";
    }

    /// <summary>Install the hook on each target that remains pending. Safe to call again.</summary>
    internal static bool Apply()
    {
        lock (Sync)
        {
            _plan ??= new LobbyScreenMountPlan(Bindings.Select(binding => binding.Key));
            if (_plan.IsComplete)
            {
                return true;
            }

            _attempts++;
            var byKey = Bindings.ToDictionary(binding => binding.Key, StringComparer.Ordinal);
            var complete = _plan.Attempt(key => TryPatch(byKey[key]));
            var installed = _plan.TargetCount - _plan.Pending.Count;
            CouchCoopLog.Stderr($"lobby assignment patch installed targets={installed}/{_plan.TargetCount}");
            if (!complete && _attempts > 1)
            {
                ReportIncomplete(_plan.Pending, byKey);
            }

            return complete;
        }
    }

    /// <summary>
    /// The method a binding names, resolved among the methods its type DECLARES with exactly its parameter types, or
    /// null. Never an inherited method.
    /// </summary>
    internal static MethodInfo? ResolveDeclared(LobbyAssignmentBinding binding)
        => binding.Type.GetMethod(
            binding.MethodName,
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly,
            binder: null,
            types: binding.Parameters,
            modifiers: null);

    private static bool TryPatch(LobbyAssignmentBinding binding)
    {
        var target = ResolveDeclared(binding);
        if (target is null)
        {
            CouchCoopLog.Stderr($"LobbyAssignmentPatch: {binding.Type.Name}.{binding.MethodName} not declared with the expected signature.");
            return false;
        }

        var postfix = typeof(LobbyAssignmentPatch).GetMethod(
            binding.Postfix, BindingFlags.NonPublic | BindingFlags.Static);
        if (postfix is null)
        {
            CouchCoopLog.Stderr($"LobbyAssignmentPatch: postfix {binding.Postfix} missing.");
            return false;
        }

        try
        {
            (_harmony ??= new Harmony("com.couchcoop.lobby-assignment")).Patch(target, postfix: new HarmonyMethod(postfix));
            return true;
        }
        catch (Exception exception)
        {
            CouchCoopPatchDiagnostics.PatchFailed(
                nameof(LobbyAssignmentPatch),
                $"Harmony patch of {binding.Type.Name}.{binding.MethodName} failed ({exception.GetType().Name}: {exception.Message}).",
                costsCoop: false);
            return false;
        }
    }

    private static void ReportIncomplete(
        IReadOnlyList<string> pending,
        IReadOnlyDictionary<string, LobbyAssignmentBinding> byKey)
    {
        // Losing the saved-run recording costs that lobby its QR button; losing only a wake costs a late update.
        var costsCoop = pending.Any(key => byKey.TryGetValue(key, out var binding) && binding.Role is not null);
        var message = $"lobby assignment patch INCOMPLETE (still pending: {string.Join(", ", pending)})"
            + (costsCoop ? " — the Couch Co-Op QR button will not appear in the saved-run lobby this session" : string.Empty);
        CouchCoopPatchDiagnostics.PatchFailed(nameof(LobbyAssignmentPatch), message, costsCoop);
    }

    // Postfixes. Each one records (or not) and wakes; see the remarks for why nothing else.

    private static void PostfixWake(object __instance) => Note(__instance, role: null);

    // The second argument is taken by position (__1) and by type, so it is the one the game passes to the
    // initializer whatever its parameter is called; TargetsResolve pins that the type matches the target's own.
    private static void PostfixLoadRunAsHost(object __instance, SerializableRun __1)
        => Note(__instance, NetTypeNames.Host, __1);

    private static void PostfixLoadRunAsClient(object __instance, ClientLoadJoinResponseMessage __1)
        => Note(__instance, NetTypeNames.Client, __1);

    private static void Note(object screen, string? role, object? savedRun = null)
    {
        try
        {
            if (role is not null)
            {
                LobbyAssignmentRecord.Record(screen, role);
            }

            // Kept as handed over: counting its players is a read, and a postfix does not read.
            if (savedRun is not null)
            {
                LobbyAssignmentRecord.RecordSavedRun(screen, savedRun);
            }

            CouchCoopQrHostPanelController.NoteLobbyAssigned();
        }
        catch (Exception exception)
        {
            // Never let the mod's bookkeeping throw into the game's own lobby initializer.
            CouchCoopLog.Stderr($"LobbyAssignmentPatch: note failed: {exception.GetType().Name}: {exception.Message}");
        }
    }
}
