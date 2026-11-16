using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;

internal static class CouchPlayDiscoveryDemandTests
{
    public static void Run()
    {
        var demand = new CouchPlayDiscoveryDemand();
        Expect(!demand.ShouldRun(CouchPlayMode.Off), "idle Off");
        Expect(!demand.ShouldRun(CouchPlayMode.EveryScreen), "enabled without an entry stays idle");
        demand.SoloLobbyPresented = true;
        Expect(!demand.ShouldRun(CouchPlayMode.Off), "solo entry while Off stays idle");
        Expect(demand.ShouldRun(CouchPlayMode.SoloScreens), "enable while presented arms discovery");
        demand.SoloLobbyPresented = false;
        Expect(demand.ShouldRun(CouchPlayMode.SoloScreens), "run keeps discovery for reconnects");
        Expect(!demand.ShouldRun(CouchPlayMode.Off), "Off stops solo discovery");
        Expect(!demand.ShouldRun(CouchPlayMode.SoloScreens), "enable away from an entry stays idle");
        demand.SoloPausePresented = true;
        Expect(demand.ShouldRun(CouchPlayMode.EveryScreen), "pause entry can arm discovery");
        demand.MultiplayerHosting = true;
        Expect(demand.ShouldRun(CouchPlayMode.Off), "Off preserves multiplayer hosting");
        demand.MultiplayerHosting = false;
        Expect(!demand.ShouldRun(CouchPlayMode.Off), "end hosting stops discovery");
        Console.WriteLine("CouchPlayDiscoveryDemandTests: 11 checks ok");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition) throw new InvalidOperationException($"CouchPlayDiscoveryDemandTests failed: {because}");
    }
}
