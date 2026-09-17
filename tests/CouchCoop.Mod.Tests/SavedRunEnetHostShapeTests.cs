using System.Reflection;
using System.Runtime.CompilerServices;
using CouchCoop.Mod.Session;
using MegaCrit.Sts2.Core.Multiplayer.Transport;
using MegaCrit.Sts2.Core.Multiplayer.Transport.ENet;

// The fallback host still needs ENet's listener, but a Steam-created run's load lobby keys the host seat by its
// saved Steam id. This shape guard protects the one override that reconciles those facts without changing ENet's
// actual wire transport.
internal static class SavedRunEnetHostShapeTests
{
    public static void Run()
    {
        var type = typeof(SavedRunEnetHost);
        Assert(type.IsSealed, "SavedRunEnetHost is sealed (the saved identity cannot be changed by a subclass)");
        Assert(type.BaseType == typeof(ENetHost), "SavedRunEnetHost retains ENetHost's LAN listener implementation");

        var netId = type.GetProperty("NetId", BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        Assert(netId is not null, "SavedRunEnetHost declares its NetId override");
        Assert(netId!.GetMethod is { IsVirtual: true }, "SavedRunEnetHost.NetId remains a virtual override");
        Assert(netId.GetMethod!.GetBaseDefinition() != netId.GetMethod,
            "SavedRunEnetHost.NetId overrides its inherited transport identity rather than adding a shadow property");

        // Do NOT construct one of these here. `new SavedRunEnetHost(...)` runs the base game constructor, and
        // game code reaches GodotSharp entry points that only a running engine fills in — in a test process they
        // are null, so the call lands on address 0 and the process dies (`segfault at 0 ip 0000000000000000`,
        // exit 139). Nothing can catch it: this took the whole runner down, and every suite below it, and was
        // misread as a crash in an unrelated suite thirteen lines above for six days.
        //
        // An uninitialized instance runs no constructor at all, which suits what is under test here: the NetId
        // override, not the base transport. The base declares no finalizer, is not IDisposable and owns no native
        // handle, so an instance that never ran its constructor is inert — nothing is queued for finalization and
        // nothing native is ever touched. The constructor's own argument check is covered below.
        const ulong savedSteamHost = 76561198000000123UL;
        var host = (SavedRunEnetHost)RuntimeHelpers.GetUninitializedObject(typeof(SavedRunEnetHost));
        var savedId = type.GetField("_netId", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert(savedId is not null, "SavedRunEnetHost keeps the saved identity in a field its override can read");
        savedId!.SetValue(host, savedSteamHost);
        Assert(host.NetId == savedSteamHost, "the ENet wire host reports the saved Steam identity");

        // The guard that keeps a preserved id from colliding with ENet's native 1. Reading the constructor's
        // parameter metadata cannot run it, so this asserts the rule is still declared where it belongs rather
        // than that it throws — the throw itself needs a live game, where the constructor is safe to call.
        var ctor = type.GetConstructor(
            BindingFlags.NonPublic | BindingFlags.Instance,
            binder: null,
            [typeof(INetHostHandler), typeof(ulong)],
            modifiers: null);
        Assert(ctor is not null, "SavedRunEnetHost still takes (handler, netId), the pair the fallback host supplies");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[SavedRunEnetHostShapeTests] FAILED: {label}");
        }
    }
}
