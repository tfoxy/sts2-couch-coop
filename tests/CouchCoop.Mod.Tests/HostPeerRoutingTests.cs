using CouchCoop.Mod.Session;
using MegaCrit.Sts2.Core.Multiplayer.Transport;

// The composite host's peer→transport decision. It is pure and is the kind of rule that only bites in production,
// so it is pinned here.
//
// The routing rule is deliberately asymmetric: membership of the STEAM side decides, and everything else — every
// couch seat and every id we have never heard of — goes to ENet. That is not a stylistic choice.
// SteamHost.SendMessageToClient THROWS on an unknown peer; ENetHost.SendMessageToClient only logs. A stale id
// (a seat killed mid-broadcast, a peer racing its own disconnect) must therefore land on the tolerant side, or the
// throw propagates out of the game's own per-peer broadcast loop and takes the remaining sends with it.
internal static class HostPeerRoutingTests
{
    private const ulong SteamPeerA = 76561198000000123UL;
    private const ulong SteamPeerB = 76561198000000456UL;

    public static void Run()
    {
        SteamMembersRouteToSteam();
        CouchSeatsRouteToEnet();
        UnknownPeersRouteToEnetNeverSteam();
        AnEmptySteamSideSendsEverythingToEnet();
        CrossTransportChannelsNormalizeForEnet();
    }

    private static void SteamMembersRouteToSteam()
    {
        var steamPeers = new[] { SteamPeerA, SteamPeerB };
        Assert(DualHostRouting.RouteFor(SteamPeerA, steamPeers) == DualHostSide.Steam, "a connected Steam peer routes to Steam");
        Assert(DualHostRouting.RouteFor(SteamPeerB, steamPeers) == DualHostSide.Steam, "…for every member, not just the first");
    }

    private static void CouchSeatsRouteToEnet()
    {
        var steamPeers = new[] { SteamPeerA };
        foreach (var seat in new ulong[] { 1002, 1003, 1004 })
        {
            Assert(DualHostRouting.RouteFor(seat, steamPeers) == DualHostSide.Enet, $"couch seat {seat} routes to ENet");
        }
    }

    private static void UnknownPeersRouteToEnetNeverSteam()
    {
        var steamPeers = new[] { SteamPeerA };
        // A Steam-SHAPED id that is not a current member is the dangerous case: routing it "by magnitude" would
        // send it to SteamHost, which throws on an unknown peer.
        Assert(DualHostRouting.RouteFor(SteamPeerB, steamPeers) == DualHostSide.Enet,
            "a Steam-shaped id that is NOT a current Steam peer routes to ENet (Steam would throw)");
        Assert(DualHostRouting.RouteFor(0UL, steamPeers) == DualHostSide.Enet, "a zero id routes to ENet");
        Assert(DualHostRouting.RouteFor(1UL, steamPeers) == DualHostSide.Enet, "the ENet host id routes to ENet");
        Assert(DualHostRouting.RouteFor(ulong.MaxValue, steamPeers) == DualHostSide.Enet, "a garbage id routes to ENet");
    }

    private static void AnEmptySteamSideSendsEverythingToEnet()
    {
        Assert(DualHostRouting.RouteFor(SteamPeerA, []) == DualHostSide.Enet,
            "with no Steam peers connected, even a known Steam id routes to ENet (nothing to send it through)");
    }

    private static void CrossTransportChannelsNormalizeForEnet()
    {
        foreach (var sourceChannel in new[] { -1, 0, 1, 17 })
        {
            Assert(DualHostRouting.EnetChannelFor(NetTransferMode.Reliable, sourceChannel) == 0,
                $"reliable Steam channel {sourceChannel} maps to ENet's reliable channel");
            Assert(DualHostRouting.EnetChannelFor(NetTransferMode.Unreliable, sourceChannel) == 1,
                $"unreliable Steam channel {sourceChannel} maps to ENet's unreliable channel");
        }
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[HostPeerRoutingTests] FAILED: {label}");
        }
    }
}
