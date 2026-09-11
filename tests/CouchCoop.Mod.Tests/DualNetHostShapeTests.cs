using System.Reflection;
using CouchCoop.Mod.Session;

// Shape guard for the composite Steam+ENet host. DualNetHost is unreachable from a unit test at RUNTIME (it needs
// a live Steam lobby and a bound UDP socket), but its shape is exactly where the dangerous mistakes live, and
// shape is checkable with pure reflection:
//
//  * It MUST derive from SteamHost. SteamPlatformUtilStrategy pattern-matches `NetHost: SteamHost { LobbyId: ... }`
//    to drive the in-lobby Invite button; a composite deriving straight from NetHost silently breaks invites.
//  * Every routed NetHost member MUST be overridden here. A missed override means that message type quietly goes
//    Steam-only — i.e. the couch seats stop receiving it — which no compiler error would catch, because the base
//    implementations are perfectly valid.
//  * NetId and GetRawLobbyIdentifier MUST NOT be overridden: the session's identity and lobby id are the Steam
//    ones, and that is what the seats are told and what rich presence advertises.
internal static class DualNetHostShapeTests
{
    public static void Run()
    {
        DerivesFromSteamHost();
        RoutedMembersAreOverridden();
        SteamIdentityIsInherited();
        SideHandlerDropsOnDisconnectedOnly();
    }

    private static void DerivesFromSteamHost()
    {
        var baseType = typeof(DualNetHost).BaseType;
        Assert(baseType is not null && baseType.Name == "SteamHost",
            $"DualNetHost derives from SteamHost (so the Invite button's `is SteamHost` match still holds); got {baseType?.Name ?? "<null>"}");
        Assert(typeof(DualNetHost).IsSealed, "DualNetHost is sealed (nothing may re-route around it)");
    }

    private static void RoutedMembersAreOverridden()
    {
        // Both transports must be pumped, both memberships reported, and every send/disconnect routed per peer.
        AssertOverridden("Update");
        AssertOverridden("SendMessageToClient");
        AssertOverridden("SendMessageToAll");
        AssertOverridden("DisconnectClient");
        AssertOverridden("StopHost");
        AssertOverridden("SetHostIsClosed");
        AssertPropertyOverridden("IsConnected");
        AssertPropertyOverridden("ConnectedPeerIds");
    }

    private static void SteamIdentityIsInherited()
    {
        AssertNotOverridden("GetRawLobbyIdentifier");
        AssertPropertyNotOverridden("NetId");
    }

    // The inner ENet host's handler must forward peer traffic (that is what makes a couch seat an ordinary peer of
    // the shared lobby) but drop OnDisconnected — ENetHost.StopHost and SteamHost.StopHost BOTH fire it, and the
    // service would otherwise be told the host died twice.
    private static void SideHandlerDropsOnDisconnectedOnly()
    {
        var handler = typeof(DualNetHost).GetNestedType("SideHandler", BindingFlags.NonPublic);
        Assert(handler is not null, "DualNetHost has the SideHandler shim for its ENet side");

        var body = handler!.GetMethod("OnDisconnected", BindingFlags.Public | BindingFlags.Instance);
        Assert(body is not null, "SideHandler implements OnDisconnected");
        Assert(body!.GetMethodBody()?.GetILAsByteArray()?.Length <= 2,
            "SideHandler.OnDisconnected is EMPTY (the composite reports the disconnect exactly once, from the Steam side)");

        foreach (var forwarded in new[] { "OnPeerConnected", "OnPeerDisconnected", "OnPacketReceived" })
        {
            var method = handler.GetMethod(forwarded, BindingFlags.Public | BindingFlags.Instance);
            Assert(method is not null, $"SideHandler implements {forwarded}");
            Assert(method!.GetMethodBody()?.GetILAsByteArray()?.Length > 2,
                $"SideHandler.{forwarded} actually forwards to the service (a couch seat must be an ordinary peer)");
        }
    }

    private static void AssertOverridden(string name)
    {
        var method = typeof(DualNetHost).GetMethod(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        Assert(method is not null, $"DualNetHost overrides {name} (else that traffic silently goes Steam-only)");
    }

    private static void AssertNotOverridden(string name)
    {
        var method = typeof(DualNetHost).GetMethod(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        Assert(method is null, $"DualNetHost does NOT override {name} (the Steam value is the session's truth)");
    }

    private static void AssertPropertyOverridden(string name)
    {
        var property = typeof(DualNetHost).GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        Assert(property is not null, $"DualNetHost overrides {name} (both sides must be represented)");
    }

    private static void AssertPropertyNotOverridden(string name)
    {
        var property = typeof(DualNetHost).GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        Assert(property is null, $"DualNetHost does NOT override {name} (the host's identity is its Steam id)");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[DualNetHostShapeTests] FAILED: {label}");
        }
    }
}
