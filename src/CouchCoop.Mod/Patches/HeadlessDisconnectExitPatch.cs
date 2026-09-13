using System.Reflection;
using CouchCoop.Mod.Session;
using CouchCoop.MirrorProtocol.Envelopes;
using HarmonyLib;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer;
using MegaCrit.Sts2.Core.Nodes.CommonUi;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Makes a HEADLESS co-op instance EXIT when its connection to the host game is permanently gone, instead of
/// parking forever behind STS2's network-error / "report a bug" modal.
///
/// <para>THE DEFECT.</para>
/// A headless instance is a real ENet client of the host's game, but it has no human and no retry: the client
/// flow answers a lost host with a network-error dialog (<see cref="NErrorPopup"/>), which on a normal client is
/// something the player dismisses. On a headless there is nobody to dismiss it, so the instance sat at a main
/// menu behind an invisible modal *forever* — burning a CPU core, holding its seat's slot, and streaming that
/// dead menu to whatever browser was attached. The host's own bookkeeping never noticed either, because the
/// process was still very much alive (see <see cref="MirrorSeatDirectory"/>: process liveness is what drives a
/// seat offline).
///
/// <para>THE FIX, IN TWO PATCHES (headless only — installed from <c>CouchCoopMod.Init</c> under
/// <c>IsHeadlessClient</c>, so a real player's game keeps every dialog it has today).</para>
/// <list type="bullet">
///   <item><description>
///   PREFIX on <c>NErrorPopup.Create(NetErrorInfo)</c> → return null, skipping the original. Every caller already
///   null-checks the result (the game itself returns null in other situations), so suppression is a supported
///   shape rather than a hack. Overload care: three static <c>Create</c> siblings exist
///   (<c>NetErrorInfo</c>, <c>LocString/LocString/LocString?/bool</c>, <c>string/string/bool</c>) and only the
///   NETWORK one is patched — resolution is by parameter type, never by name.
///   </description></item>
///   <item><description>
///   POSTFIX on <c>NetClientGameService.OnDisconnectedFromHost(ulong, NetErrorInfo)</c> → start the exit
///   sequence. That method only reports drops we were connected for, so it fires only on a POST-JOIN
///   disconnect — which for a headless is always permanent: it has no reconnect logic of its own, and mid-run
///   the host would refuse it anyway. Exiting hands the seat back cleanly: the host sees the process go, reports
///   the seat offline with the "reload the saved run" guidance, and a fresh instance spawns on the rejoin.
///   </description></item>
/// </list>
///
/// <para>
/// RELATIONSHIP TO <see cref="HeadlessHostWatchdog"/>: that watchdog covers a different (narrower) case — the host
/// PROCESS is gone, which it detects by polling the host pid and answers with SIGKILL. It cannot see a host that is
/// alive but has dropped us: returning to the main menu, abandoning the run, a checksum divergence, an ENet
/// timeout. Those are precisely the cases that left an instance parked behind the modal, and they are what this
/// patch answers. Where both apply (host killed) either may fire first; both end in the process exiting, and the
/// exit sequence is one-shot.
/// </para>
/// <para>
/// Null-guarded like the other patches: a game update that renames either target logs and skips (a reflection test
/// fails the build first) rather than throwing during mod init.
/// </para>
/// </summary>
internal static class HeadlessDisconnectExitPatch
{
    private static readonly object _sync = new();
    private static bool _applied;
    private static HeadlessDisconnectExitSequence? _sequence;

    /// <summary>
    /// The two Harmony targets, as (declaring type, method name, parameter types) — the exact tuples
    /// <see cref="AccessTools.Method(Type, string, Type[], Type[])"/> resolves. Shared with the reflection test so
    /// it asserts precisely what is patched, including the <c>Create</c> overload discrimination.
    /// </summary>
    internal static IReadOnlyList<(Type Type, string Name, Type[] Args)> Targets { get; } =
    [
        (typeof(NErrorPopup), nameof(NErrorPopup.Create), [typeof(NetErrorInfo)]),
        (typeof(NetClientGameService), nameof(NetClientGameService.OnDisconnectedFromHost), [typeof(ulong), typeof(NetErrorInfo)]),
    ];

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome — Init can run more than once

            _sequence ??= CreateSequence();
            var harmony = new Harmony("com.couchcoop.headless-disconnect-exit");

            PatchOne(
                harmony,
                typeof(NErrorPopup),
                nameof(NErrorPopup.Create),
                [typeof(NetErrorInfo)],
                prefix: nameof(PrefixSuppressNetworkErrorPopup));

            PatchOne(
                harmony,
                typeof(NetClientGameService),
                nameof(NetClientGameService.OnDisconnectedFromHost),
                [typeof(ulong), typeof(NetErrorInfo)],
                postfix: nameof(PostfixOnDisconnectedFromHost));
        }
    }

    internal static void RequestExit(string reason)
    {
        CouchCoop.Mod.Connections.ConnectionInputAvailability.Stop();
        var sequence = Volatile.Read(ref _sequence);
        if (sequence is null)
        {
            return;
        }

        _ = Task.Run(() => sequence.StartAsync(string.IsNullOrWhiteSpace(reason) ? "connection-ended" : reason));
    }

    // Production wiring for the sequence: the last gasp goes out over THIS instance's own browser server (the
    // viewers attached to the headless), the clean quit is a deferred SceneTree.Quit(), and the backstop is a
    // SIGKILL. Kept here rather than in the sequence so the sequence stays game-free and testable.
    // The sequence's `reason` is the human/log rendering of NetErrorInfo; what goes on the WIRE is the fixed
    // machine-readable code both clients branch on (the viewer's copy is client-side, and a raw NetError name
    // would be meaningless to a player anyway).
    private static HeadlessDisconnectExitSequence CreateSequence() => new(
        notifyViewers: static async (_, cancellationToken) =>
        {
            await HeadlessConnectionReporter.FlushAsync(cancellationToken).ConfigureAwait(false);
            await CouchCoopMod.CloseBrowserConnectionsAsync(BrowserServerReloadReasons.HeadlessHostDisconnected, cancellationToken).ConfigureAwait(false);
        },
        quit: QuitGameDeferred);

    // Ask Godot to shut down on ITS OWN main loop. CallDeferred (not a direct Quit()) because the disconnect can
    // be reported from the net update path mid-frame and, in the failure case we care about, from a state where
    // the game is already unwinding a run — queuing the quit lets the current frame finish first. Godot's message
    // queue is thread-safe, so this is also correct if a future transport reports the drop off-thread.
    private static void QuitGameDeferred()
    {
        if (Godot.Engine.GetMainLoop() is not Godot.SceneTree tree)
        {
            throw new InvalidOperationException("No SceneTree main loop to quit.");
        }

        tree.CallDeferred(Godot.SceneTree.MethodName.Quit, 0);
    }

    private static void PatchOne(
        Harmony harmony,
        Type type,
        string name,
        Type[] args,
        string? prefix = null,
        string? postfix = null)
    {
        var label = $"{type.Name}.{name}({string.Join(", ", Array.ConvertAll(args, a => a.Name))})";
        var target = AccessTools.Method(type, name, args);
        if (target is null)
        {
            Console.Error.WriteLine(
                $"[couch-coop] HeadlessDisconnectExitPatch: {label} not found — headless clean-exit on disconnect is DISABLED.");
            return;
        }

        try
        {
            harmony.Patch(
                target,
                prefix: prefix is null ? null : new HarmonyMethod(Handler(prefix)),
                postfix: postfix is null ? null : new HarmonyMethod(Handler(postfix)));
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] HeadlessDisconnectExitPatch: Harmony patch of {label} failed ({exception.GetType().Name}: {exception.Message}).");
        }
    }

    private static MethodInfo Handler(string name)
        => typeof(HeadlessDisconnectExitPatch).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static)!;

    // Harmony prefix: skip the original and hand back null — the shape every caller already handles.
    private static bool PrefixSuppressNetworkErrorPopup(ref NErrorPopup? __result)
    {
        __result = null;
        return false;
    }

    // Harmony postfix: the host connection is gone for good. Fire-and-forget so the game's net update path is
    // never blocked by the last-gasp send; the sequence is one-shot, so repeat notifications are free.
    private static void PostfixOnDisconnectedFromHost(NetErrorInfo info)
    {
        RequestExit(Describe(info));
    }

    private static string Describe(NetErrorInfo info)
    {
        try
        {
            return info.ToString();
        }
        catch
        {
            return "unknown";
        }
    }
}
