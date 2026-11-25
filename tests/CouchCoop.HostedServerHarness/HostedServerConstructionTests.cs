using System.Reflection;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

internal static class HostedServerConstructionTests
{
    public static async Task RunAsync()
    {
        var assertions = 0;
        void AssertGameFree()
        {
            AssertGodotNotLoaded();
            assertions++;
        }

        AssertGameFree();
        // Use the default demand reporter, including overlapping server generations and their zero-demand
        // teardown. Construction, preference changes and lifecycle calls must leave engine state uninitialized.
        var report = RootWindowEmbeddingGuard.CreateBrowserDemandReporter();
        await using (var first = NewServer())
        await using (var second = NewServer())
        {
            AssertGameFree();
            await first.StartAsync();
            await second.StartAsync();
            AssertGameFree();
            report(1, 1);
            SetCapturePreferences(true);
            AssertGameFree();

            // Exercise registration's subscription and observer refresh without needing a game or a socket peer.
            InvokeConnectionLifecycle(first, "RegisterConnection");
            AssertGameFree();
            InvokeConnectionLifecycle(first, "UnregisterConnection");
            AssertGameFree();

            SetCapturePreferences(false);
            report(0, long.MaxValue);
            AssertGameFree();
            await first.StopAsync();
            await second.StopAsync();
            AssertGameFree();
            await first.StartAsync();
            await first.StopAsync();
            AssertGameFree();
        }
        AssertGameFree();
        Console.WriteLine($"hosted server construction: 1 test, {assertions} assertions passed");
    }

    private static void SetCapturePreferences(bool enabled)
    {
        CouchCoopStreamDecorFreeze.SetDesired(enabled, enabled);
        CouchCoopStreamDecorFreeze.SetArmed(enabled);
        CouchCoopStreamStaticParticles.SetDesired(enabled);
        CouchCoopStreamStaticParticles.SetArmed(enabled);
        CouchCoopStreamTweenAnnouncer.SetDesired(enabled);
        CouchCoopStreamTweenAnnouncer.SetArmed(enabled);
        CouchCoopStreamSpineStills.SetArmed(enabled);
    }

    private static void InvokeConnectionLifecycle(CouchCoopBrowserServer server, string method)
        => typeof(CouchCoopBrowserServer).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(server, null);

    private static CouchCoopBrowserServer NewServer() => new(
        new StaticSpaFileProvider(AppContext.BaseDirectory), new FakeAssetAdapter(), preferredPort: 0);

    private static void AssertGodotNotLoaded()
    {
        if (AppDomain.CurrentDomain.GetAssemblies().Any(assembly => assembly.GetName().Name == "GodotSharp"))
            throw new InvalidOperationException("Game-free server lifecycle must not load GodotSharp.");
    }
}
