using System.Reflection;
using CouchCoop.Mod.Session;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
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

        const ulong savedSteamHost = 76561198000000123UL;
        Assert(new SavedRunEnetHost(new StubHandler(), savedSteamHost).NetId == savedSteamHost,
            "the ENet wire host reports the saved Steam identity");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[SavedRunEnetHostShapeTests] FAILED: {label}");
        }
    }

    private sealed class StubHandler : INetHostHandler
    {
        public void OnPacketReceived(ulong senderId, byte[] packetBytes, NetTransferMode mode, int channel) { }
        public void OnPeerConnected(ulong peerId) { }
        public void OnPeerDisconnected(ulong peerId, NetErrorInfo info) { }
        public void OnDisconnected(NetErrorInfo info) { }
    }
}
