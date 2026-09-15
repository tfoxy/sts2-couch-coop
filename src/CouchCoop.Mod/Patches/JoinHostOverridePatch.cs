using System.Reflection;
using HarmonyLib;
using MegaCrit.Sts2.Core.Multiplayer.Connection;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Lets any modded client direct-connect to an arbitrary host through <c>COUCHCOOP_JOIN_HOST=ip[:port]</c>.
///
/// <para>The game ships no direct-connect UI outside its debug multiplayer screen, and its auto-join path always
/// aims at the local ENet host. Rather than build a join screen (out of scope) or fork the join flow, this
/// rewrites the address at the ONE place every ENet join is constructed, so a single prefix covers the auto-join
/// path, the debug screen and anything a future screen adds.</para>
///
/// <para>Applied on every modded instance, not just headless seats — that is the user-approved escape hatch. It is
/// inert unless the environment variable is set, so an ordinary player is unaffected. Headless couch seats set it
/// explicitly to <c>127.0.0.1:33771</c> (the value they would have got implicitly), which makes their join target
/// visible in the process environment and redirectable without a rebuild.</para>
/// </summary>
internal static class JoinHostOverridePatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    /// <summary>Env var holding <c>ip</c> or <c>ip:port</c> (bracketed for IPv6, e.g. <c>[::1]:33771</c>).</summary>
    internal const string JoinHostEnvVar = "COUCHCOOP_JOIN_HOST";

    private static string? _host;
    private static ushort? _port;

    /// <summary>
    /// Parses <c>COUCHCOOP_JOIN_HOST</c>. Pure. Accepts <c>host</c>, <c>host:port</c> and <c>[v6]:port</c>; a
    /// missing or unparseable port leaves the caller's own port in place rather than guessing. Returns false for
    /// anything unusable, which means "join exactly as the game intended".
    /// </summary>
    internal static bool TryParseJoinHost(string? raw, out string host, out ushort? port)
    {
        host = string.Empty;
        port = null;

        var trimmed = raw?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return false;

        // Bracketed IPv6: [::1] or [::1]:33771
        if (trimmed[0] == '[')
        {
            var close = trimmed.IndexOf(']');
            if (close <= 1) return false;
            host = trimmed[1..close];
            var rest = trimmed[(close + 1)..];
            if (rest.StartsWith(':') && ushort.TryParse(rest[1..], out var v6Port) && v6Port != 0)
            {
                port = v6Port;
            }

            return host.Length > 0;
        }

        var separator = trimmed.LastIndexOf(':');
        // More than one colon and no brackets means a bare IPv6 literal — no port to split off.
        if (separator > 0 && trimmed.IndexOf(':') == separator)
        {
            host = trimmed[..separator];
            if (ushort.TryParse(trimmed[(separator + 1)..], out var parsedPort) && parsedPort != 0)
            {
                port = parsedPort;
            }
        }
        else
        {
            host = trimmed;
        }

        return host.Length > 0;
    }

    /// <summary>The game member this patch binds to, shared with the reflection guard test.</summary>
    internal static IReadOnlyList<(Type Type, Type[] Args)> ConstructorTargets { get; } =
    [
        (typeof(ENetClientConnectionInitializer), [typeof(ulong), typeof(string), typeof(ushort)]),
    ];

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome

            if (!TryParseJoinHost(Environment.GetEnvironmentVariable(JoinHostEnvVar), out var host, out var port))
            {
                return; // inert: join exactly where the game says
            }

            var target = AccessTools.Constructor(
                typeof(ENetClientConnectionInitializer),
                [typeof(ulong), typeof(string), typeof(ushort)]);
            if (target is null)
            {
                Console.Error.WriteLine(
                    $"[couchcoop] JoinHostOverridePatch: ENetClientConnectionInitializer(ulong, string, ushort) not found — {JoinHostEnvVar} ignored.");
                return;
            }

            _host = host;
            _port = port;

            try
            {
                var prefix = typeof(JoinHostOverridePatch)
                    .GetMethod(nameof(PrefixConstructor), BindingFlags.NonPublic | BindingFlags.Static);
                new Harmony("com.couchcoop.join-host").Patch(target, prefix: new HarmonyMethod(prefix));
                Console.Error.WriteLine($"[couchcoop] join host overridden to {host}:{(port?.ToString() ?? "<game default>")}");
            }
            catch (Exception ex)
            {
                // No panel row: this patch is inert unless a developer set the env var, so its failure is not
                // something a player can act on. It is still recorded, because "which patches installed" is one
                // answer and a partially patched process is the thing worth seeing.
                CouchCoopPatchDiagnostics.PatchFailed(
                    nameof(JoinHostOverridePatch),
                    $"Harmony patch failed ({ex.GetType().Name}: {ex.Message}) — {JoinHostEnvVar} ignored.",
                    costsCoop: false);
            }
        }
    }

    // Harmony prefix on ENetClientConnectionInitializer(ulong netId, string ip, ushort port). Rewriting the
    // arguments (rather than the private fields) keeps this working whatever the ctor body does with them.
    private static bool PrefixConstructor(ref string ip, ref ushort port)
    {
        if (_host is null) return true;
        ip = _host;
        if (_port is ushort overriddenPort)
        {
            port = overriddenPort;
        }

        return true;
    }
}
