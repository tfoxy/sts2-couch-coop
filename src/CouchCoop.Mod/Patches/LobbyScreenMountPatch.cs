using System.Reflection;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Session;
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
/// Failure is degraded, never fatal — but it is NOT cheap, and it used to be silent. There is no working
/// fallback behind this patch: the controller's other discovery path is a one-shot walk at mod init, when no
/// lobby screen exists yet, so a screen this patch misses is a screen nothing ever reports and the lobby loses
/// its QR button for the whole process. Hence <see cref="LobbyScreenMountPlan"/> (a failed target stays pending
/// and is retried on the next <see cref="Apply"/>, which the panel controller makes once more after the
/// runtime is up) and hence the <see cref="CouchCoopLog"/> line: a patch that cannot be installed says so in
/// <c>godot.log</c>, naming the consequence, because the stderr line it used to write alone goes to a file
/// nobody reads.
/// </para>
/// </remarks>
internal static class LobbyScreenMountPatch
{
    private static readonly object _sync = new();
    private static LobbyScreenMountPlan? _plan;
    private static int _attempts;

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

    /// <summary>
    /// Install the mount hook on every screen that does not have it yet.
    /// </summary>
    /// <returns>
    /// Whether both screens are now hooked. Safe and free to call again: an installed target is never patched
    /// twice, and a fully satisfied patch returns immediately.
    /// </returns>
    internal static bool Apply()
    {
        lock (_sync)
        {
            var plan = _plan ??= new LobbyScreenMountPlan(ScreenTypeNames);
            if (plan.IsComplete)
            {
                return true;
            }

            _attempts++;
            var postfix = typeof(LobbyScreenMountPatch)
                .GetMethod(nameof(ReadyPostfix), BindingFlags.NonPublic | BindingFlags.Static);
            if (postfix is null)
            {
                // Our own method, so this cannot be a game-side change and a retry cannot help it.
                ReportIncomplete("the mount postfix is missing from this build", retryExhausted: true);
                return false;
            }

            var harmony = new Harmony("com.couchcoop.lobby-screen-mount");
            var complete = plan.Attempt(typeName => TryPatch(harmony, typeName, postfix));

            Console.Error.WriteLine(
                $"[couchcoop] lobby screen mount patch installed targets={plan.TargetCount - plan.Pending.Count}/{plan.TargetCount}");
            if (!complete)
            {
                // The panel controller makes one more Apply after the runtime is up, so the FIRST incomplete
                // attempt is expected and must not tell the player the button is gone — only a retry that also
                // failed may do that. The log line stands either way.
                ReportIncomplete($"still pending: {string.Join(", ", plan.Pending)}", retryExhausted: _attempts > 1);
            }

            return complete;
        }
    }

    /// <summary>
    /// Say in <c>godot.log</c> what a reader needs to know: that the button is gone and why.
    /// </summary>
    /// <remarks>
    /// The one place in this patch that does NOT write only to stderr. When every Harmony patch in the mod
    /// failed on a live host, <c>godot.log</c> carried six CouchCoop lines and none of them mentioned it; the
    /// diagnosis took a reconstruction from the launcher's captured stderr, which a player does not have.
    /// </remarks>
    /// <param name="retryExhausted">
    /// Whether this is the last word. Only then does the connections panel get its (deduplicated) row: the
    /// button really is gone for the session, which is a thing the player can see and report.
    /// </param>
    private static void ReportIncomplete(string detail, bool retryExhausted)
    {
        var message = $"[couchcoop] lobby screen mount patch INCOMPLETE ({detail}) — the Couch Co-Op QR button "
            + "will not appear in the lobby this session";
        Console.Error.WriteLine(message);
        CouchCoopLog.Error(message);
        if (retryExhausted)
        {
            Connections.CouchCoopPatchHealth.PatchFailed(nameof(LobbyScreenMountPatch), costsCoop: true, message);
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
            // Recorded, but NOT reported to the panel from here: this target stays pending and is retried, and
            // ReportIncomplete below is the one that speaks once the retry has also failed.
            CouchCoopPatchDiagnostics.PatchFailed(
                nameof(LobbyScreenMountPatch),
                $"Harmony patch of {typeName}._Ready failed ({exception.GetType().Name}: {exception.Message}).",
                costsCoop: false);
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
                $"[couchcoop] LobbyScreenMountPatch: {typeName} not found.");
            return null;
        }

        var target = AccessTools.Method(type, ReadyMethodName, []);
        if (target is null)
        {
            Console.Error.WriteLine(
                $"[couchcoop] LobbyScreenMountPatch: {typeName}._Ready not found.");
            return null;
        }

        if (target.DeclaringType != type)
        {
            // REFUSED, not patched. An inherited _Ready is Godot.Node's, and hooking that instruments every
            // node in the game — the exact cost this patch removes, multiplied.
            Console.Error.WriteLine(
                $"[couchcoop] LobbyScreenMountPatch: {typeName} does not declare _Ready "
                + $"(would have patched {target.DeclaringType?.FullName ?? "unknown"}) — refused.");
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
                $"[couchcoop] LobbyScreenMountPatch: mount note failed: {exception.GetType().Name}: {exception.Message}");
        }
    }
}
