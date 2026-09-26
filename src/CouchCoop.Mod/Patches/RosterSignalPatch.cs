using System.Reflection;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Runtime;
using HarmonyLib;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Multiplayer.Game.Lobby;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Entities.Multiplayer;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Tells the roster observer when the game changes who is in a lobby or a run, so the observer is told instead of
/// looking.
/// </summary>
/// <remarks>
/// <para>
/// A POSTFIX DOES NOTHING BUT RECORD AND WAKE. It runs inside the game's own lobby callback, and touching the game from
/// inside a game callback faults the process without a managed exception, so it never resolves the current screen and
/// never reads the roster. It records what the hook was handed (the lobby object, or the net service), then wakes the
/// listeners, which defer the read by one frame. A postfix does not run when the original throws.
/// </para>
/// <para>
/// Declared methods only, the same rule as <see cref="LobbyAssignmentPatch"/>: a method the type merely inherits would
/// hook every subclass. Applied more than once (at mod init and again once the runtime is composed) with the mount
/// patch's pending-set plan, so a second attempt patches only what is still missing.
/// </para>
/// <para>
/// A missed WAKE costs a late update on the join picker. A missed <c>LoadRunLobby</c> constructor hook costs more: it is the
/// only typed way to reach that lobby, so the saved-run lobby's seats cannot be read at all and the join picker offers
/// nobody on that screen. That one is reported as costing co-op; the others are not.
/// </para>
/// </remarks>
internal static class RosterSignalPatch
{
    /// <summary>
    /// The typed binding for each entry of <see cref="RosterSignalTargets.Targets"/>, in the same order: <c>typeof</c>
    /// parameter types and <c>nameof</c> members, so a rename or reshape in a game update is a compile error rather than a
    /// silently missing hook. The lobby listener callbacks differ by lane in their parameter type (a lobby-player record
    /// on v0.111.0, a bare net id on v0.107.1 for the saved-run screen), so those are split.
    /// </summary>
    internal static IReadOnlyList<RosterSignalBinding> Bindings { get; } =
    [
#if STS2_API_V111
        new(typeof(NCharacterSelectScreen), nameof(NCharacterSelectScreen.PlayerConnected),
            [typeof(StartRunLobbyPlayer)], nameof(PostfixWake)),
        new(typeof(NCharacterSelectScreen), nameof(NCharacterSelectScreen.RemotePlayerDisconnected),
            [typeof(StartRunLobbyPlayer)], nameof(PostfixWake)),
        new(typeof(NMultiplayerLoadGameScreen), nameof(NMultiplayerLoadGameScreen.PlayerConnected),
            [typeof(LoadRunLobbyPlayer)], nameof(PostfixWake)),
#else
        new(typeof(NCharacterSelectScreen), nameof(NCharacterSelectScreen.PlayerConnected),
            [typeof(LobbyPlayer)], nameof(PostfixWake)),
        new(typeof(NCharacterSelectScreen), nameof(NCharacterSelectScreen.RemotePlayerDisconnected),
            [typeof(LobbyPlayer)], nameof(PostfixWake)),
        new(typeof(NMultiplayerLoadGameScreen), nameof(NMultiplayerLoadGameScreen.PlayerConnected),
            [typeof(ulong)], nameof(PostfixWake)),
#endif
        new(typeof(NMultiplayerLoadGameScreen), nameof(NMultiplayerLoadGameScreen.RemotePlayerDisconnected),
            [typeof(ulong)], nameof(PostfixWake)),
        new(typeof(StartRunLobby), RosterSignalTargets.Constructor,
            [typeof(GameMode), typeof(INetGameService), typeof(IStartRunLobbyListener), typeof(int)],
            nameof(PostfixStartRunLobbyCreated)),
        new(typeof(LoadRunLobby), RosterSignalTargets.Constructor,
            [typeof(INetGameService), typeof(ILoadRunLobbyListener), typeof(SerializableRun)],
            nameof(PostfixLoadRunLobbyCreated), CostsCoop: true),
        new(typeof(RunManager), nameof(RunManager.CleanUp), [typeof(bool)], nameof(PostfixWake)),
    ];

    private static readonly object Sync = new();
    private static Harmony? _harmony;
    private static LobbyScreenMountPlan? _plan;
    private static int _attempts;

    /// <summary>One typed target: the declared method (or constructor), and which postfix it gets.</summary>
    internal readonly record struct RosterSignalBinding(
        Type Type,
        string MethodName,
        Type[] Parameters,
        string Postfix,
        bool CostsCoop = false)
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
            CouchCoopLog.Stderr($"roster signal patch installed targets={installed}/{_plan.TargetCount}");
            if (!complete && _attempts > 1)
            {
                var costsCoop = _plan.Pending.Any(key => byKey.TryGetValue(key, out var binding) && binding.CostsCoop);
                CouchCoopPatchDiagnostics.PatchFailed(
                    nameof(RosterSignalPatch),
                    $"roster signal patch INCOMPLETE (still pending: {string.Join(", ", _plan.Pending)}) — the join picker "
                    + (costsCoop
                        ? "cannot list the saved-run lobby's seats this session"
                        : "may show a stale roster until the next screen change"),
                    costsCoop);
            }

            return complete;
        }
    }

    /// <summary>
    /// The method or constructor a binding names, resolved among the members its type DECLARES with exactly its
    /// parameter types, or null. Never an inherited method.
    /// </summary>
    internal static MethodBase? ResolveDeclared(RosterSignalBinding binding)
    {
        const BindingFlags Flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        return string.Equals(binding.MethodName, RosterSignalTargets.Constructor, StringComparison.Ordinal)
            ? binding.Type.GetConstructor(Flags, binder: null, types: binding.Parameters, modifiers: null)
            : binding.Type.GetMethod(binding.MethodName, Flags, binder: null, types: binding.Parameters, modifiers: null);
    }

    private static bool TryPatch(RosterSignalBinding binding)
    {
        var target = ResolveDeclared(binding);
        if (target is null)
        {
            CouchCoopLog.Stderr($"RosterSignalPatch: {binding.Type.Name}.{binding.MethodName} not declared with the expected signature.");
            return false;
        }

        var postfix = typeof(RosterSignalPatch).GetMethod(binding.Postfix, BindingFlags.NonPublic | BindingFlags.Static);
        if (postfix is null)
        {
            CouchCoopLog.Stderr($"RosterSignalPatch: postfix {binding.Postfix} missing.");
            return false;
        }

        try
        {
            (_harmony ??= new Harmony("com.couchcoop.roster-signals")).Patch(target, postfix: new HarmonyMethod(postfix));
            return true;
        }
        catch (Exception exception)
        {
            CouchCoopPatchDiagnostics.PatchFailed(
                nameof(RosterSignalPatch),
                $"Harmony patch of {binding.Type.Name}.{binding.MethodName} failed ({exception.GetType().Name}: {exception.Message}).",
                binding.CostsCoop);
            return false;
        }
    }

    // Postfixes. Each one records (or not) and wakes; see the remarks for why nothing else.

    private static void PostfixWake() => Note(record: null);

    private static void PostfixStartRunLobbyCreated(StartRunLobby __instance)
        => Note(() => RosterHostService.Note(__instance.NetService));

    private static void PostfixLoadRunLobbyCreated(LoadRunLobby __instance)
        => Note(() =>
        {
            // The screen is the lobby's listener, and is what the roster read has in hand when that screen is current.
            if (__instance.LobbyListener is { } screen)
            {
                LobbyAssignmentRecord.RecordLobby(screen, __instance);
            }

            RosterHostService.Note(__instance.NetService);
        });

    private static void Note(Action? record)
    {
        try
        {
            record?.Invoke();
            CouchCoopRosterSignals.Raise();
        }
        catch (Exception exception)
        {
            // Never let the mod's bookkeeping throw into the game's own lobby callback.
            CouchCoopLog.Stderr($"RosterSignalPatch: note failed: {exception.GetType().Name}: {exception.Message}");
        }
    }
}
