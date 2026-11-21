using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using Godot;
using DecorFreeze = CouchCoop.Mod.Session.CouchCoopHeadlessVisualSuspender.DecorFreeze;

internal static class StreamDecorFreezeTests
{
    public static void Run()
    {
        var checks = 0;
        void Assert(bool value, string message)
        {
            if (!value) throw new InvalidOperationException(message);
            checks++;
        }
        foreach (var armed in new[] { false, true })
        foreach (var desired in new[] { false, true })
            Assert(CouchCoopStreamDecorFreeze.ShouldFreeze(armed, desired) == (armed && desired), "armed × desired");
        foreach (var armed in new[] { false, true })
        foreach (var pages in new bool[][] { [], [true], [false], [true, true], [true, false], [false, true] })
            Assert(CouchCoopBrowserServer.ComputeStreamClientDesired(armed, pages)
                == (armed && pages.Length > 0 && pages.All(value => value)), "unanimous nonempty demand");
        Assert(CouchCoopStreamDecorFreeze.PolicyFor("NEnergyCounter") == DecorFreeze.ProcessOnly, "orb slides stay live");
        Assert(CouchCoopStreamDecorFreeze.PolicyFor("NRestSiteFireVfx") == DecorFreeze.WholeNode, "candle bound tweens stop");
        Assert(CouchCoopStreamDecorFreeze.PolicyFor("NStarCounter") is null, "star count stays live");
        Assert(CouchCoopStreamDecorFreeze.PolicyFor("NIntent") is null, "intent updates stay live");
        Assert(CouchCoopStreamDecorFreeze.PolicyFor("Node2D") is null, "unrelated nodes stay live");
        foreach (var prior in new[] { false, true })
        {
            var saved = new FrozenNodeStates<bool>();
            saved.Remember(1, prior);
            saved.Remember(1, false);
            saved.Restore((id, process) => Assert(id == 1 && process == prior, "first process state survives until thaw"));
            Assert(saved.Count == 0, "thaw releases saved ids");
        }
        foreach (var prior in Enum.GetValues<Node.ProcessModeEnum>())
        {
            var saved = new FrozenNodeStates<Node.ProcessModeEnum>();
            saved.Remember(1, prior);
            saved.Remember(1, Node.ProcessModeEnum.Disabled);
            saved.Restore((id, mode) => Assert(mode == prior, "restore exact prior process mode"));
            Assert(saved.Count == 0, "saved modes clear on disarm");
        }
        Assert(!CouchCoopStreamDecorFreeze.Active, "no native activation means no replay permission");
        Console.WriteLine($"stream decor freeze: {checks} checks passed");
    }
}
