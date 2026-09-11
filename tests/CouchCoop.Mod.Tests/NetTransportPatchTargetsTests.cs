using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Session;
using HarmonyLib;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Saves.Runs;

// Regression guard for the networking/hosting patches (WS-1). Every game member the mod binds to in order to host
// normally — the two NetHostGameService entry points, the private _netHost field and the private Platform setter it
// rewrites, the CommandLineHelper overrides that drive a CLI-free headless seat, the client-side HostNetId seam and
// the saved-run host hook — must still resolve against the installed STS2 assemblies. If a game update renames or
// removes one, this fails the build instead of shipping a mod that silently degrades to "cannot host".
//
// Pure metadata reflection (AccessTools), same resolution the patches themselves use: no live game, no Harmony
// install, no native Godot/Steam library is touched.
internal static class NetTransportPatchTargetsTests
{
    public static void Run()
    {
        HostTransportTargetsResolve();
        SavedRunHostIdentityTargetResolves();
        ServiceReflectionSeamsResolve();
        CommandLineOverrideTargetsResolve();
        HostNetIdTargetsResolve();
        HostNetIdIsOnlyOverriddenWhenItDiffers();
        JoinHostTargetResolves();
        JoinHostParsing();
        SeatSpawnGateFailsOpen();
        SavedRunHostIdentityResolutionAndLifetime();
    }

    private static void SavedRunHostIdentityTargetResolves()
    {
        var missing = SavedRunHostIdentityPatch.Targets
            .Where(t => AccessTools.Method(t.Type, t.Name, t.Args) is null)
            .Select(t => $"{t.Type.FullName}.{t.Name}")
            .ToList();
        Assert(missing.Count == 0,
            $"every SavedRunHostIdentityPatch target resolves (missing: {string.Join("; ", missing)})");
    }

    private static void SavedRunHostIdentityResolutionAndLifetime()
    {
        const ulong steamHost = 76561198000000123UL;

        Assert(CouchCoopHostTransport.ResolveSavedRunHostNetId(steamHost, [steamHost, 77UL]) == steamHost,
            "a current Steam identity preserves its saved host id even when the save's transport label is ENet");
        Assert(CouchCoopHostTransport.ResolveSavedRunHostNetId(1UL, [1UL, 77UL]) is null,
            "an ENet-created save keeps ENet's native host id 1");
        Assert(CouchCoopHostTransport.ResolveSavedRunHostNetId(steamHost, [77UL]) is null,
            "a foreign save does not borrow another player's identity");
        Assert(CouchCoopHostTransport.ResolveSavedRunHostNetId(0UL, [steamHost]) is null,
            "an absent local platform identity does not arm a fallback override");
        Assert(SavedRunHostIdentityPatch.ResolveSavedRunHostNetId(steamHost, new SerializableRun
        {
            // Default PlatformType is None, matching a Steam-created save after an offline ENet recovery.
            Players = [new SerializablePlayer { NetId = steamHost }, new SerializablePlayer { NetId = 1002UL }],
        }) == steamHost,
            "a saved ENet transport label does not hide the current Steam host identity");

        CouchCoopHostTransport.ArmSavedRunHostNetId(steamHost);
        Assert(CouchCoopHostTransport.ConsumeSavedRunHostNetId() == steamHost,
            "the saved host identity is consumed by exactly one host start");
        Assert(CouchCoopHostTransport.ConsumeSavedRunHostNetId() is null,
            "a consumed saved identity cannot leak into the next lobby");

        CouchCoopHostTransport.ArmSavedRunHostNetId(steamHost);
        CouchCoopHostTransport.ResetSession();
        Assert(CouchCoopHostTransport.ConsumeSavedRunHostNetId() is null,
            "disconnect/reset clears an unconsumed saved identity");
    }

    // The seat-spawn gate must FAIL OPEN. EnetAvailable is only ever set by our own postfix, so if a game update
    // renamed StartENetHost the gate would otherwise read "no ENet listener" forever and NO couch player could
    // join again — a total feature outage from a bookkeeping miss. Uninstrumented must mean "behave as before".
    private static void SeatSpawnGateFailsOpen()
    {
        var installed = CouchCoopHostTransport.BookkeepingInstalled;
        var available = CouchCoopHostTransport.EnetAvailable;
        try
        {
            CouchCoopHostTransport.BookkeepingInstalled = false;
            CouchCoopHostTransport.EnetAvailable = false;
            Assert(CouchCoopHostTransport.MaySpawnCouchSeat,
                "with the bookkeeping patch NOT installed, a seat may still be launched (pre-WS-1 behavior)");

            CouchCoopHostTransport.BookkeepingInstalled = true;
            Assert(!CouchCoopHostTransport.MaySpawnCouchSeat,
                "with bookkeeping live and no ENet listener, a seat is refused instead of hanging ~60s on connect");

            CouchCoopHostTransport.EnetAvailable = true;
            Assert(CouchCoopHostTransport.MaySpawnCouchSeat, "a live ENet listener admits seats");
        }
        finally
        {
            CouchCoopHostTransport.BookkeepingInstalled = installed;
            CouchCoopHostTransport.EnetAvailable = available;
        }
    }

    private static void JoinHostTargetResolves()
    {
        var missing = JoinHostOverridePatch.ConstructorTargets
            .Where(t => AccessTools.Constructor(t.Type, t.Args) is null)
            .Select(t => t.Type.FullName)
            .ToList();
        Assert(missing.Count == 0,
            $"ENetClientConnectionInitializer(ulong, string, ushort) resolves — the single place every ENet join "
            + $"address is constructed (missing: {string.Join("; ", missing!)})");
    }

    private static void JoinHostParsing()
    {
        Assert(JoinHostOverridePatch.TryParseJoinHost("10.0.0.5:33771", out var host, out var port)
            && host == "10.0.0.5" && port == 33771, "ip:port is split");
        Assert(JoinHostOverridePatch.TryParseJoinHost(" 10.0.0.5 ", out host, out port)
            && host == "10.0.0.5" && port is null,
            "a bare host keeps the caller's own port (we redirect, we don't guess)");
        Assert(JoinHostOverridePatch.TryParseJoinHost("[::1]:33771", out host, out port)
            && host == "::1" && port == 33771, "a bracketed IPv6 literal splits correctly");
        Assert(JoinHostOverridePatch.TryParseJoinHost("fe80::1", out host, out port)
            && host == "fe80::1" && port is null,
            "a bare IPv6 literal is NOT mistaken for host:port (its last colon is part of the address)");
        Assert(JoinHostOverridePatch.TryParseJoinHost("10.0.0.5:0", out host, out port)
            && host == "10.0.0.5" && port is null, "port 0 is not a port");
        Assert(JoinHostOverridePatch.TryParseJoinHost("10.0.0.5:nope", out host, out port)
            && host == "10.0.0.5" && port is null, "an unparseable port leaves the caller's port alone");
        Assert(!JoinHostOverridePatch.TryParseJoinHost(null, out _, out _), "unset → the patch stays inert");
        Assert(!JoinHostOverridePatch.TryParseJoinHost("   ", out _, out _), "blank → the patch stays inert");
    }

    private static void HostNetIdTargetsResolve()
    {
        var missing = HostNetIdPatch.Targets
            .Where(t => AccessTools.Method(t.Type, t.Name, t.Args) is null)
            .Select(t => $"{t.Type.FullName}.{t.Name}")
            .ToList();
        Assert(missing.Count == 0, $"every HostNetIdPatch target resolves (missing: {string.Join("; ", missing)})");
        // The property seam specifically: the real cure is rewriting this getter, and the heartbeat coercion is
        // only its inlining fallback.
        Assert(AccessTools.PropertyGetter(typeof(MegaCrit.Sts2.Core.Multiplayer.Transport.ENet.ENetClient), "HostNetId") is not null,
            "ENetClient.HostNetId getter resolves (the hardcoded 1uL a Steam-hosted seat must not believe)");
        Assert(AccessTools.Field(typeof(MegaCrit.Sts2.Core.Multiplayer.Quality.NetQualityTracker), "_netService") is not null,
            "NetQualityTracker._netService resolves (the coercion reads the client's own HostNetId through it)");
    }

    private static void HostNetIdIsOnlyOverriddenWhenItDiffers()
    {
        Assert(HostNetIdPatch.ResolveHostNetId("76561198000000123") == 76561198000000123UL,
            "a Steam host netId is honored");
        Assert(HostNetIdPatch.ResolveHostNetId(" 76561198000000123 ") == 76561198000000123UL, "…and trimmed");
        Assert(HostNetIdPatch.ResolveHostNetId("1") is null,
            "netId 1 needs no patch — that is exactly what ENetClient already reports");
        Assert(HostNetIdPatch.ResolveHostNetId("0") is null, "a zero id is not a host");
        Assert(HostNetIdPatch.ResolveHostNetId(null) is null, "unset → stock behavior");
        Assert(HostNetIdPatch.ResolveHostNetId("") is null, "blank → stock behavior");
        Assert(HostNetIdPatch.ResolveHostNetId("not-a-number") is null, "garbage → stock behavior, never a throw");
        Assert(HostNetIdPatch.ResolveHostNetId("-1") is null, "a negative value is not a netId");
    }

    private static void CommandLineOverrideTargetsResolve()
    {
        var missing = new List<string>();
        foreach (var (type, name, args) in CommandLineOverridePatch.Targets)
        {
            if (AccessTools.Method(type, name, args) is null)
            {
                missing.Add($"{type.FullName}.{name}({string.Join(", ", args.Select(a => a.Name))})");
            }
        }

        Assert(missing.Count == 0,
            $"every CommandLineOverridePatch target resolves (missing: {string.Join("; ", missing)})");
        // GetValue is a trivial wrapper around TryGetValue and a prime inlining candidate; all three entry points
        // must be patched or a seat can lose its faked clientId depending on what the JIT did.
        Assert(CommandLineOverridePatch.Targets.Any(t => t.Name == "HasArg"), "HasArg is patched");
        Assert(CommandLineOverridePatch.Targets.Any(t => t.Name == "TryGetValue"), "TryGetValue is patched");
        Assert(CommandLineOverridePatch.Targets.Any(t => t.Name == "GetValue"),
            "GetValue is patched too (inlining defence — it just wraps TryGetValue)");
    }

    private static void HostTransportTargetsResolve()
    {
        var missing = new List<string>();
        foreach (var (type, name, args) in CouchCoopHostTransportPatch.Targets)
        {
            if (AccessTools.Method(type, name, args) is null)
            {
                missing.Add($"{type.FullName}.{name}({string.Join(", ", args.Select(a => a.Name))})");
            }
        }

        Assert(missing.Count == 0,
            $"every CouchCoopHostTransportPatch target resolves (missing: {string.Join("; ", missing)})");
        Assert(CouchCoopHostTransportPatch.NetIdGetter is not null,
            "NetHostGameService.NetId getter resolves for saved-run loaded-lobby identity");
    }

    private static void ServiceReflectionSeamsResolve()
    {
        // Replacing the service's host object is the whole mechanism: the service fans a broadcast out per peer
        // through _netHost.SendMessageToClient, so owning that field is what makes composite routing possible.
        Assert(CouchCoopHostTransport.NetHostField is not null, "NetHostGameService._netHost field resolves");
        Assert(CouchCoopHostTransport.NetHostField!.FieldType.Name == "NetHost",
            "NetHostGameService._netHost is typed NetHost (a composite host must be assignable to it)");
        // Platform has a private setter; the host must be able to declare Steam-vs-None itself when it picks the
        // transport, because the game decided that BEFORE calling us.
        Assert(CouchCoopHostTransport.PlatformSetter is not null, "NetHostGameService.Platform setter resolves");
        Assert(CouchCoopHostTransport.SeamsResolve, "both reflection seams resolve (else hosting degrades to stock)");
    }

    internal static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[NetTransportPatchTargetsTests] FAILED: {label}");
        }
    }
}
