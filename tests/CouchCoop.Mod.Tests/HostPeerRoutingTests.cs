using CouchCoop.Mod.Session;

// The composite host's peer→transport decision, and the lobby's free-slot guard. Both are pure and both are the
// kind of rule that only bites in production, so they are pinned here.
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
        FreeSlotGuardCountsConnectingPeers();
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

    // Slots used to be a couch-only resource; on a Steam-hosted session they are SHARED with remote players.
    // The cap comes from the LOBBY, not from us: the stock game allows four players, and the multiplayer limit
    // mods raise it. (It was hardcoded to 4 on the grounds that slotId is serialized in two bits — but those mods
    // rewrite that serialization, so the wire is no longer the limit.)
    private static void FreeSlotGuardCountsConnectingPeers()
    {
        const int Stock = 4;
        Assert(CouchCoopLobbyParticipation.HasFreeLobbySlot(1, 0, Stock), "host alone → a seat may launch");
        Assert(CouchCoopLobbyParticipation.HasFreeLobbySlot(3, 0, Stock), "three players → the fourth slot is free");
        Assert(!CouchCoopLobbyParticipation.HasFreeLobbySlot(4, 0, Stock), "a full lobby refuses a new seat");
        Assert(!CouchCoopLobbyParticipation.HasFreeLobbySlot(5, 0, Stock), "an over-full lobby refuses too (never negative-free)");
        Assert(!CouchCoopLobbyParticipation.HasFreeLobbySlot(3, 1, Stock),
            "a peer still mid-handshake holds the last slot — launching into that gap would spend ~30s to be rejected");
        Assert(CouchCoopLobbyParticipation.HasFreeLobbySlot(2, 1, Stock), "two players + one connecting still leaves a slot");

        // A raised lobby keeps admitting past four — this is the whole point of asking the lobby.
        Assert(CouchCoopLobbyParticipation.HasFreeLobbySlot(4, 0, 16), "a 16-player lobby has room for a fifth");
        Assert(CouchCoopLobbyParticipation.HasFreeLobbySlot(15, 0, 16), "…and for a sixteenth");
        Assert(!CouchCoopLobbyParticipation.HasFreeLobbySlot(16, 0, 16), "but not a seventeenth");
        // An unreadable cap degrades to the stock four rather than to "no seats at all".
        Assert(!CouchCoopLobbyParticipation.HasFreeLobbySlot(4, 0, 0), "an unknown cap falls back to the stock four");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[HostPeerRoutingTests] FAILED: {label}");
        }
    }
}
