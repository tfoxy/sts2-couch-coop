using System.Reflection;
using CouchCoop.Mod.HostUi;
using Godot;
using HarmonyLib;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Tells <see cref="CouchCoopQrHostPanelController"/> when a lobby screen appears, so it does not have to go
/// looking.
/// </summary>
/// <remarks>
/// <para>
/// WHY. The controller's comment used to say the mod "has no supported seam into the game's screen stack",
/// and it polled for one: a recursive walk of the WHOLE scene tree, four times a second, forever, on the game
/// main thread — in combat, on the map, on the main menu, connected or not. That is the single largest thing
/// the mod did while nobody was using it. There IS a seam: both lobby screens are ordinary C# game types that
/// declare their own <c>_Ready</c>, which is the mount signal the walk was reconstructing.
/// </para>
/// <para>
/// <b>_Ready, and ONLY _Ready.</b> The obvious targets are <c>_EnterTree</c>/<c>_ExitTree</c>, and they are a
/// trap: neither screen DECLARES them, so <see cref="AccessTools"/> would walk up and hand back
/// <c>Godot.Node</c>'s — and patching that hooks EVERY node in the game, which is a far worse version of the
/// cost this patch exists to remove. <see cref="ResolveDeclaredReady"/> is the guard: a target whose
/// <see cref="MemberInfo.DeclaringType"/> is not the screen type itself is refused, so the day a game update
/// stops declaring <c>_Ready</c> this patch turns itself off instead of instrumenting the entire tree.
/// </para>
/// <para>
/// There is no unmount patch and there must not be one. Godot runs <c>_Ready</c> once per node, so a screen
/// that is hidden or detached and later shown again would never announce itself a second time; the registry
/// therefore drops an entry only when the node is actually FREED, which it detects by id. See
/// <see cref="LobbyScreenRegistry"/>.
/// </para>
/// <para>
/// Failure is always silent-and-degraded, never fatal: a missing type or a refused seam logs one line and
/// leaves the controller on its one-shot startup scan, which still finds a lobby that was already mounted.
/// </para>
/// </remarks>
internal static class LobbyScreenMountPatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    /// <summary>
    /// The game members this patch binds to, shared with the reflection guard test — the same contract
    /// <c>CommandLineOverridePatch.Targets</c> publishes, so a game-side rename fails our build rather than
    /// silently costing the lobby its panels.
    /// <para>
    /// Matched by FULL name here (the controller additionally accepts the short name when scanning) because
    /// this is a patch target: binding a Harmony hook to whatever type happens to share a short name is not a
    /// risk worth taking.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<string> ScreenTypeNames { get; } =
    [
        "MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen",
        "MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NMultiplayerLoadGameScreen",
    ];

    /// <summary>The one lifecycle method both screens declare, and the only one safe to patch.</summary>
    internal const string ReadyMethodName = "_Ready";

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome

            var harmony = new Harmony("com.couchcoop.lobby-screen-mount");
            var postfix = typeof(LobbyScreenMountPatch)
                .GetMethod(nameof(ReadyPostfix), BindingFlags.NonPublic | BindingFlags.Static);
            if (postfix is null)
            {
                Console.Error.WriteLine(
                    "[couch-coop] LobbyScreenMountPatch: postfix not found — lobby panels fall back to the startup scan.");
                return;
            }

            var patched = 0;
            foreach (var typeName in ScreenTypeNames)
            {
                if (TryPatch(harmony, typeName, postfix))
                {
                    patched++;
                }
            }

            Console.Error.WriteLine($"[couch-coop] lobby screen mount patch installed targets={patched}/{ScreenTypeNames.Count}");
        }
    }

    private static bool TryPatch(Harmony harmony, string typeName, MethodInfo postfix)
    {
        var target = ResolveDeclaredReady(typeName);
        if (target is null)
        {
            return false;
        }

        try
        {
            harmony.Patch(target, postfix: new HarmonyMethod(postfix));
            return true;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] LobbyScreenMountPatch: Harmony patch of {typeName}._Ready failed "
                + $"({exception.GetType().Name}: {exception.Message}).");
            return false;
        }
    }

    /// <summary>
    /// <c>_Ready</c> as DECLARED BY <paramref name="typeName"/>, or <see langword="null"/> when the type is
    /// missing or merely inherits the method.
    /// </summary>
    /// <remarks>
    /// The <see cref="MemberInfo.DeclaringType"/> equality check is the whole point — see the class remarks.
    /// It is written as an explicit comparison rather than a <c>DeclaredOnly</c> lookup so the refusal can say
    /// WHICH type it would have patched, which is the line that makes this diagnosable from a user's log.
    /// </remarks>
    internal static MethodInfo? ResolveDeclaredReady(string typeName)
    {
        var type = AccessTools.TypeByName(typeName);
        if (type is null)
        {
            Console.Error.WriteLine(
                $"[couch-coop] LobbyScreenMountPatch: {typeName} not found — lobby panels fall back to the startup scan.");
            return null;
        }

        var target = AccessTools.Method(type, ReadyMethodName, []);
        if (target is null)
        {
            Console.Error.WriteLine(
                $"[couch-coop] LobbyScreenMountPatch: {typeName}._Ready not found — lobby panels fall back to the startup scan.");
            return null;
        }

        if (target.DeclaringType != type)
        {
            // REFUSED, not patched. An inherited _Ready is Godot.Node's, and hooking that instruments every
            // node in the game — the exact cost this patch removes, multiplied.
            Console.Error.WriteLine(
                $"[couch-coop] LobbyScreenMountPatch: {typeName} does not declare _Ready "
                + $"(would have patched {target.DeclaringType?.FullName ?? "unknown"}) — refused, "
                + "lobby panels fall back to the startup scan.");
            return null;
        }

        return target;
    }

    // Harmony postfix on <lobby screen>._Ready(). Runs on the game main thread, once per screen node.
    private static void ReadyPostfix(Node __instance)
    {
        try
        {
            CouchCoopQrHostPanelController.NoteLobbyScreenMounted(__instance);
        }
        catch (Exception exception)
        {
            // A throw here would propagate into the game's own screen construction. The panels are a
            // convenience; the lobby is not.
            Console.Error.WriteLine(
                $"[couch-coop] LobbyScreenMountPatch: mount note failed: {exception.GetType().Name}: {exception.Message}");
        }
    }
}
