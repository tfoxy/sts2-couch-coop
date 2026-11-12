using CouchCoop.Mod.Server;

internal static class HostedServerConstructionTests
{
    public static async Task RunAsync()
    {
        AssertGodotNotLoaded();
        // Use the default demand reporter, including overlapping server generations and their zero-demand
        // teardown. Constructing a reporter must leave the game-only visual suspender uninitialized.
        await using (var first = NewServer())
        await using (var second = NewServer())
        {
            AssertGodotNotLoaded();
        }
        AssertGodotNotLoaded();
        Console.WriteLine("hosted server construction: 1 test, 3 assertions passed");
    }

    private static CouchCoopBrowserServer NewServer() => new(
        new StaticSpaFileProvider(AppContext.BaseDirectory), new FakeAssetAdapter(), preferredPort: 0);

    private static void AssertGodotNotLoaded()
    {
        if (AppDomain.CurrentDomain.GetAssemblies().Any(assembly => assembly.GetName().Name == "GodotSharp"))
            throw new InvalidOperationException("Game-free server construction must not load GodotSharp.");
    }
}
