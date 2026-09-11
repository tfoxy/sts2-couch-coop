using System.Reflection;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Session;
using HarmonyLib;
using MegaCrit.Sts2.Core.Multiplayer;

// How many clients the host's listener is built for, and — the part that actually broke — WHO gets to decide it.
//
// Our StartSteamHost prefix replaces the implementation and returns false. Harmony stops running the prefixes that
// could still affect the original as soon as one does that, and the multiplayer limit mods raise the player cap
// from exactly such a prefix on exactly that method. Registered at the default priority we sorted FIRST (equal
// priority falls back to registration order, and couchcoop loads before the Workshop mods), so their raise never
// ran and the listener was sized for the stock cap while the lobby, created later, admitted more. Priority.Last
// puts us behind them and we consume the argument they produced.
//
// None of that is reachable from an automated host on this box — the fixture and `-fastmp` both host over
// StartENetHost, never StartSteamHost — so the ordering is pinned here instead, against Harmony's OWN comparer
// rather than against a restatement of its rules. The capacity decision is pinned the same way: through the one
// method StartHostAsync can call to obtain a cap.
internal static class HostTransportCapacityTests
{
    // The value a limit mod's prefix writes into maxClients before ours runs (Unlimited's shipped default).
    private const int Raised = 8;

    // What the game asks for, and what the lobby probe reports at host start on the stock game.
    private const int Stock = 4;

    public static void Run()
    {
        OnlyTheStartSteamHostPrefixMovesOffTheDefaultPriority();
        HarmonyOrdersOurReplacingPrefixLast();
        TheArgumentsWeConsumeStillCarryTheNamesHarmonyMatchesOn();
        AnAlreadyRaisedCapSurvivesAndIsStated();
        TheLobbyProbeOnlyEverRaises();
        AStockEnetHostStatesItsCapacityToo();
    }

    // Half of "the fix cannot be silently reverted": the ordering is a named constant, the Patch helper defaults
    // every other target to Harmony's default, and the direction of Harmony's own scale is asserted rather than
    // assumed (Last must be BELOW Normal for "last" to mean last).
    private static void OnlyTheStartSteamHostPrefixMovesOffTheDefaultPriority()
    {
        Assert(CouchCoopHostTransportPatch.StartSteamHostPrefixPriority == Priority.Last,
            "the StartSteamHost prefix registers at Priority.Last");
        Assert(CouchCoopHostTransportPatch.DefaultPatchPriority == Priority.Normal,
            "everything else here registers at Harmony's default priority");
        Assert(Priority.Last < Priority.Normal,
            "Harmony sorts prefixes by DESCENDING priority, so Last must be the lower number — if a Harmony "
            + "upgrade ever flipped that, our prefix would silently go back to running first");

        var helper = typeof(CouchCoopHostTransportPatch)
            .GetMethod("Patch", BindingFlags.NonPublic | BindingFlags.Static);
        Assert(helper is not null, "CouchCoopHostTransportPatch.Patch(...) helper resolves");
        var priorityParameter = helper!.GetParameters().SingleOrDefault(p => p.Name == "prefixPriority");
        Assert(priorityParameter is not null, "the Patch helper takes a prefixPriority");
        Assert(priorityParameter!.ParameterType == typeof(int) && priorityParameter.HasDefaultValue
                && (int)priorityParameter.DefaultValue! == CouchCoopHostTransportPatch.DefaultPatchPriority,
            "a target that does not ASK for an ordering gets Harmony's default — one call site has to justify a "
            + "priority, the rest cannot acquire one by accident");
    }

    // The other half, and the one that proves the behaviour rather than the spelling: build the two Patch records
    // Harmony itself would build for this machine's load order and ask Harmony to order them.
    private static void HarmonyOrdersOurReplacingPrefixLast()
    {
        // couchcoop loads before the Workshop mods, so ours is registered first → the lower index.
        const int OurIndex = 0;
        const int LimitModIndex = 1;
        // Harmony's "unset": a HarmonyMethod whose priority was never assigned.
        const int Unset = -1;

        var limitMod = MakePatch(LimitModIndex, "sts2unlimited.modifier", Unset);
        Assert(limitMod.priority == Priority.Normal,
            "a limit mod that never sets a priority lands on Normal (Harmony normalizes its -1 sentinel)");

        var oursBefore = MakePatch(OurIndex, "com.couchcoop.host-transport", Unset);
        Assert(oursBefore.CompareTo(limitMod) < 0,
            "THE DEFECT: at equal priority Harmony falls back to registration order, which ran our replacing "
            + "prefix first and cut the limit mod's cap raise out entirely");

        var oursAfter = MakePatch(OurIndex, "com.couchcoop.host-transport",
            CouchCoopHostTransportPatch.StartSteamHostPrefixPriority);
        Assert(oursAfter.CompareTo(limitMod) > 0,
            "THE FIX: at Priority.Last we sort after the limit mod's prefix however early we registered");
        Assert(oursAfter.CompareTo(MakePatch(9, "some.other.mod", Unset)) > 0,
            "…and after a mod that registered LATER than us too — priority beats index either way");
    }

    private static HarmonyLib.Patch MakePatch(int index, string owner, int priority)
        => new(
            typeof(HostTransportCapacityTests).GetMethod(nameof(Sink), BindingFlags.NonPublic | BindingFlags.Static)!,
            index,
            owner,
            priority,
            before: null,
            after: null,
            debug: false);

    /// <summary>A stand-in patch body: Harmony's ordering never looks at what a patch does.</summary>
    private static void Sink()
    {
    }

    // Harmony maps a patch's parameters to the original's BY NAME, and throws at patch time when a name does not
    // match — which would take the whole host transport down to stock. The value this round is about arrives
    // through exactly those names, so a game-side rename should fail here rather than in a player's session.
    private static void TheArgumentsWeConsumeStillCarryTheNamesHarmonyMatchesOn()
    {
        var startSteamHost = AccessTools.Method(typeof(NetHostGameService), "StartSteamHost", [typeof(int)]);
        Assert(startSteamHost is not null, "NetHostGameService.StartSteamHost(int) resolves");
        Assert(startSteamHost!.GetParameters() is [{ Name: "maxClients" }],
            "StartSteamHost's client cap is still named maxClients — the argument a limit mod raises and our "
            + "prefix then reads");

        var startEnetHost = AccessTools.Method(
            typeof(NetHostGameService), "StartENetHost", [typeof(ushort), typeof(int)]);
        Assert(startEnetHost is not null, "NetHostGameService.StartENetHost(ushort, int) resolves");
        Assert(startEnetHost!.GetParameters().Any(p => p.Name == "maxClients" && p.ParameterType == typeof(int)),
            "StartENetHost's client cap is still named maxClients — our postfix takes it to state the capacity of "
            + "the one listener we did not build ourselves");

        var prefix = typeof(CouchCoopHostTransportPatch)
            .GetMethod("PrefixStartSteamHost", BindingFlags.NonPublic | BindingFlags.Static);
        Assert(prefix is not null, "PrefixStartSteamHost resolves");
        Assert(prefix!.ReturnType == typeof(bool),
            "the prefix returns bool — replacing the original is precisely why its ordering has to be last");
        Assert(prefix.GetParameters().Any(p => p.Name == "maxClients" && p.ParameterType == typeof(int)),
            "…and it consumes maxClients by that name");

        var postfix = typeof(CouchCoopHostTransportPatch)
            .GetMethod("PostfixStartENetHost", BindingFlags.NonPublic | BindingFlags.Static);
        Assert(postfix is not null, "PostfixStartENetHost resolves");
        Assert(postfix!.GetParameters().Any(p => p.Name == "maxClients" && p.ParameterType == typeof(int)),
            "…and the stock-ENet postfix takes maxClients by that name");
    }

    // The end the player feels: a cap another mod's prefix already raised must reach the transport intact, and the
    // host log must say so. Capacity.Resolve is the ONLY way StartHostAsync can obtain a cap (WithLobbyCapacity is
    // private to that nested type), so what is asserted here is what the transports are built with.
    private static void AnAlreadyRaisedCapSurvivesAndIsStated()
    {
        WithProbe(() => Stock, () =>
        {
            var log = CaptureLog(out var effective, () => CouchCoopHostTransport.Capacity.Resolve(Raised));

            Assert(effective == Raised,
                "a cap raised to 8 before our prefix ran reaches the transport as 8, even though the lobby the "
                + "probe can see at host start still reports the stock 4");
            Assert(CouchCoopHostTransport.EffectiveMaxClients == Raised,
                "…and is recorded as the capacity this hosting session was built for");
            Assert(log.Contains($"host-transport effective maxClients={Raised} (requested={Raised}, source=host-start)"),
                $"…and is stated in the host log (got: {log.Trim()})");
        });
    }

    private static void TheLobbyProbeOnlyEverRaises()
    {
        WithProbe(null, () =>
        {
            Assert(CouchCoopHostTransport.Capacity.Resolve(Stock) == Stock,
                "with no probe wired (a seat, a test) the argument passes through untouched");
        });

        WithProbe(() => 16, () =>
        {
            Assert(CouchCoopHostTransport.Capacity.Resolve(Stock) == 16,
                "a lobby that admits 16 sizes the transport for 16");
        });

        WithProbe(() => 2, () =>
        {
            Assert(CouchCoopHostTransport.Capacity.Resolve(Raised) == Raised,
                "a SMALLER lobby cap never shrinks the request — the raise a limit mod made must survive a lobby "
                + "that has not caught up yet");
        });

        WithProbe(() => Stock, () =>
        {
            Assert(CouchCoopHostTransport.Capacity.Resolve(Stock) == Stock,
                "on the stock game the probe reports what the caller already passed and nothing changes");
        });

        WithProbe(() => throw new InvalidOperationException("no state"), () =>
        {
            var log = CaptureLog(out var effective, () => CouchCoopHostTransport.Capacity.Resolve(Raised));
            Assert(effective == Raised, "an unreadable lobby leaves the request alone rather than guessing");
            Assert(log.Contains($"host-transport effective maxClients={Raised} (requested={Raised}, source=host-start)"),
                $"…and the capacity is STILL stated on that path (got: {log.Trim()})");
        });
    }

    // The only host path reachable without a real Steam session: the game's own StartENetHost, which the lobby
    // fixture and `-fastmp` both take. We postfix it, so the number logged here is the one the game built the
    // listener with after any limit mod's prefix raised it.
    private static void AStockEnetHostStatesItsCapacityToo()
    {
        var enetAvailable = CouchCoopHostTransport.EnetAvailable;
        try
        {
            var log = CaptureLog(() => CouchCoopHostTransport.NoteEnetHostStarted(failed: false, Raised));
            Assert(CouchCoopHostTransport.EffectiveMaxClients == Raised,
                "a stock ENet host records the cap the game built it for");
            Assert(CouchCoopHostTransport.EnetAvailable, "…and is joinable");
            Assert(log.Contains($"host-transport effective maxClients={Raised} (requested={Raised}, source=stock-enet)"),
                $"…and states it with the same token as the host-start path (got: {log.Trim()})");

            CouchCoopHostTransport.NoteEnetHostStarted(failed: true, Raised);
            Assert(CouchCoopHostTransport.EffectiveMaxClients is null,
                "a listener that failed to bind has no capacity to report");
            Assert(!CouchCoopHostTransport.EnetAvailable, "…and nothing may join it");
        }
        finally
        {
            CouchCoopHostTransport.ResetTransportState();
            CouchCoopHostTransport.EnetAvailable = enetAvailable;
        }
    }

    private static void WithProbe(Func<int>? probe, Action body)
    {
        var previous = CouchCoopHostTransport.MaxLobbyPlayersProbe;
        CouchCoopHostTransport.MaxLobbyPlayersProbe = probe;
        try
        {
            body();
        }
        finally
        {
            CouchCoopHostTransport.MaxLobbyPlayersProbe = previous;
            CouchCoopHostTransport.ResetTransportState();
        }
    }

    /// <summary>Runs <paramref name="body"/> with stderr captured, so the host log can be asserted on.</summary>
    private static string CaptureLog(Action body)
    {
        var previous = Console.Error;
        var captured = new StringWriter();
        Console.SetError(captured);
        try
        {
            body();
        }
        finally
        {
            Console.SetError(previous);
        }

        return captured.ToString();
    }

    private static string CaptureLog(out int result, Func<int> body)
    {
        var value = 0;
        var log = CaptureLog(() => value = body());
        result = value;
        return log;
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[HostTransportCapacityTests] FAILED: {label}");
        }
    }
}
