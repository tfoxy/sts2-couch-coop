using System.Reflection;
using HarmonyLib;
using MegaCrit.Sts2.Core.Helpers;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Feeds the game a small, ENV-GATED table of fake command-line args through <c>CommandLineHelper</c>.
///
/// <para><b>Why this replaced <c>FastmpPatch</c>.</b> The old patch answered <c>HasArg("fastmp") == true</c> for
/// EVERY instance, including the host — and that flag also decides whether the session runs on Steam or on ENet,
/// so the host was permanently forced onto ENet and a real Steam session (remote friends) was impossible, which
/// is the whole reason WS-1 exists. The override table is now EMPTY on the host: it hosts normally, exactly as an
/// unmodded game does.</para>
///
/// <para><b>What it does now.</b> A headless couch seat (<c>COUCHCOOP_HEADLESS_CLIENT=1</c>) is launched with NO
/// game CLI args at all — just <c>--headless</c>. It gets its join instructions from the environment instead, and
/// this patch translates them back into the args the game's own join path expects:
/// <list type="bullet">
///   <item><c>fastmp</c> → <c>"join"</c>: the main menu then runs the shipped auto-join to the local ENet host
///     (127.0.0.1:33771), and the session resolves to ENet rather than Steam — a seat has no Steam account of
///     its own.</item>
///   <item><c>clientId</c> → <c>COUCHCOOP_CLIENT_ID</c>: the seat's netId, used for the ENet handshake and as the
///     seat's local player id. Omitted when unset, so the game's own default (1000) still applies.</item>
/// </list>
/// Passing these as REAL args is what we are getting away from: argv is unreliable in the embedded host (see the
/// long-standing <c>OS.GetCmdlineArgs</c> gotcha) and, more importantly, a launcher-visible <c>-fastmp</c> is
/// indistinguishable from the user having asked for the local-multiplayer test path.</para>
///
/// <para><b>Three prefixes, on purpose.</b> <c>GetValue</c> is a thin wrapper around <c>TryGetValue</c> and is a
/// prime inlining candidate; patching all three of <c>HasArg</c>, <c>TryGetValue</c> and <c>GetValue</c> means
/// the override survives whichever one the JIT decides to keep. They agree by construction — all three read the
/// same table.</para>
///
/// <para><see cref="Apply"/> is called unconditionally (the patch must be installed before the game first touches
/// <c>PlatformUtil</c>), but the table is built from the environment: on a host it is empty and all three prefixes
/// fall straight through to the real command line.</para>
/// </summary>
internal static class CommandLineOverridePatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    /// <summary>Env var that marks this process as a headless couch seat (set by <c>HeadlessClientManager</c>).</summary>
    internal const string HeadlessClientEnvVar = "COUCHCOOP_HEADLESS_CLIENT";

    /// <summary>Env var carrying the seat's netId; becomes the fake <c>clientId</c> arg.</summary>
    internal const string ClientIdEnvVar = "COUCHCOOP_CLIENT_ID";

    /// <summary>The live override table. Empty on a host — every lookup then falls through to the real argv.</summary>
    private static IReadOnlyDictionary<string, string?> _overrides =
        new Dictionary<string, string?>(StringComparer.Ordinal);

    /// <summary>The game members this patch binds to, shared with the reflection guard test.</summary>
    internal static IReadOnlyList<(Type Type, string Name, Type[] Args)> Targets { get; } =
    [
        (typeof(CommandLineHelper), "HasArg", [typeof(string)]),
        (typeof(CommandLineHelper), "TryGetValue", [typeof(string), typeof(string).MakeByRefType()]),
        (typeof(CommandLineHelper), "GetValue", [typeof(string)]),
    ];

    /// <summary>
    /// Builds the override table. Pure — no environment access, no Godot — so the decision logic is unit-testable.
    /// A non-headless process gets an EMPTY table (the host must see its real command line, unmodified).
    /// </summary>
    /// <param name="isHeadlessClient">True when <c>COUCHCOOP_HEADLESS_CLIENT=1</c>.</param>
    /// <param name="clientId">Raw <c>COUCHCOOP_CLIENT_ID</c> value; blank/absent omits the <c>clientId</c> entry.</param>
    internal static IReadOnlyDictionary<string, string?> BuildOverrides(bool isHeadlessClient, string? clientId)
    {
        var table = new Dictionary<string, string?>(StringComparer.Ordinal);
        if (!isHeadlessClient)
        {
            return table;
        }

        // "join" is the value the main menu switches on to run its shipped auto-join path.
        table["fastmp"] = "join";

        var trimmed = clientId?.Trim();
        if (!string.IsNullOrEmpty(trimmed))
        {
            table["clientId"] = trimmed;
        }

        return table;
    }

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome

            _overrides = BuildOverrides(
                Environment.GetEnvironmentVariable(HeadlessClientEnvVar) == "1",
                Environment.GetEnvironmentVariable(ClientIdEnvVar));

            var harmony = new Harmony("com.couchcoop.commandline-override");
            Patch(harmony, "HasArg", [typeof(string)], nameof(PrefixHasArg));
            Patch(harmony, "TryGetValue", [typeof(string), typeof(string).MakeByRefType()], nameof(PrefixTryGetValue));
            Patch(harmony, "GetValue", [typeof(string)], nameof(PrefixGetValue));
        }
    }

    // Harmony prefix on CommandLineHelper.HasArg(string key): an overridden key is always "present".
    private static bool PrefixHasArg(string key, ref bool __result)
    {
        if (!_overrides.ContainsKey(key)) return true;
        __result = true;
        return false;
    }

    // Harmony prefix on CommandLineHelper.TryGetValue(string key, out string? value). Harmony represents the
    // original's `out` parameter as `ref` in the prefix; assigning it writes the caller's out variable.
    private static bool PrefixTryGetValue(string key, ref string? value, ref bool __result)
    {
        if (!_overrides.TryGetValue(key, out var overridden)) return true;
        value = overridden;
        __result = true;
        return false;
    }

    // Harmony prefix on CommandLineHelper.GetValue(string key). Redundant with TryGetValue by construction —
    // installed because GetValue is a trivial wrapper the JIT may inline, which would bypass the other prefix.
    private static bool PrefixGetValue(string key, ref string? __result)
    {
        if (!_overrides.TryGetValue(key, out var overridden)) return true;
        __result = overridden;
        return false;
    }

    private static void Patch(Harmony harmony, string name, Type[] args, string prefix)
    {
        var label = $"CommandLineHelper.{name}({string.Join(", ", Array.ConvertAll(args, a => a.Name))})";
        var target = AccessTools.Method(typeof(CommandLineHelper), name, args);
        if (target is null)
        {
            Console.Error.WriteLine($"[couchcoop] CommandLineOverridePatch: {label} not found — headless seat args not overridden.");
            return;
        }

        try
        {
            var method = typeof(CommandLineOverridePatch).GetMethod(prefix, BindingFlags.NonPublic | BindingFlags.Static);
            harmony.Patch(target, prefix: new HarmonyMethod(method));
        }
        catch (Exception ex)
        {
            // A seat re-materializes its own `fastmp=join` + `clientId` through this patch, so losing it means
            // no player can join — the panel is told once, deduplicated with every other essential patch.
            CouchCoopPatchDiagnostics.PatchFailed(
                nameof(CommandLineOverridePatch),
                $"Harmony patch of {label} failed ({ex.GetType().Name}: {ex.Message}).",
                costsCoop: true);
        }
    }
}
