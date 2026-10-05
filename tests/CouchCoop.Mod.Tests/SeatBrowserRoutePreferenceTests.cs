using CouchCoop.Mod.Session;

internal static class SeatBrowserRoutePreferenceTests
{
    public static void Run()
    {
        var directory = Path.Combine(Path.GetTempPath(), "couch-seat-route-test-" + Guid.NewGuid().ToString("N"));
        var previous = Environment.GetEnvironmentVariable(SeatBrowserRoutePreference.PathEnvironmentVariable);
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "route.json");
            Environment.SetEnvironmentVariable(SeatBrowserRoutePreference.PathEnvironmentVariable, path);
            Expect(SeatBrowserRoutePreference.Read() == SeatBrowserRouteMode.Shared, "absent choice defaults to Shared");
            Expect(SeatBrowserRoutePreference.Write(SeatBrowserRouteMode.Direct), "Direct saves");
            Expect(SeatBrowserRoutePreference.Read() == SeatBrowserRouteMode.Direct, "Direct survives a read");
            Expect(SeatBrowserRoutePreference.Write(SeatBrowserRouteMode.Shared), "Shared saves");
            Expect(SeatBrowserRoutePreference.Read() == SeatBrowserRouteMode.Shared, "Shared survives a read");
            Expect(!SeatBrowserRoutePreference.Write((SeatBrowserRouteMode)99), "unknown choice cannot be saved");
            File.WriteAllText(path, "{broken");
            Expect(SeatBrowserRoutePreference.Read() == SeatBrowserRouteMode.Shared, "malformed store defaults to Shared");
            File.WriteAllText(path, "{\"mode\":\"future-mode\"}");
            Expect(SeatBrowserRoutePreference.Read() == SeatBrowserRouteMode.Shared, "unknown future choice defaults to Shared");
            Environment.SetEnvironmentVariable(SeatBrowserRoutePreference.PathEnvironmentVariable, directory);
            Expect(!SeatBrowserRoutePreference.Write(SeatBrowserRouteMode.Direct), "unwritable file path reports failure");
        }
        finally
        {
            Environment.SetEnvironmentVariable(SeatBrowserRoutePreference.PathEnvironmentVariable, previous);
            Directory.Delete(directory, recursive: true);
        }
        Console.WriteLine("SeatBrowserRoutePreferenceTests: ok");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition) throw new InvalidOperationException($"SeatBrowserRoutePreferenceTests failed: {because}");
    }
}
