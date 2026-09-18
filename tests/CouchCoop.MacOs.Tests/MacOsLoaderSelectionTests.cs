using CouchCoop.Mod.Loader;

internal static class MacOsLoaderSelectionTests
{
    public static void Run()
    {
        using var tree = new TempTree("mac app with spaces");
        var app = Path.Combine(tree.Path, "Slay The Spire 2.app");
        var contents = Path.Combine(app, "Contents");
        var mod = Path.Combine(contents, "MacOS", "mods", "couchcoop");
        Directory.CreateDirectory(Path.Combine(contents, "Resources"));
        Directory.CreateDirectory(Path.Combine(mod, "lanes", "0.107.1"));
        Directory.CreateDirectory(Path.Combine(mod, "lanes", "0.111.0"));
        File.WriteAllText(Path.Combine(contents, "Resources", "release_info.json"), "{\"version\":\"v0.111.0\"}");

        var selected = CouchCoopLaneSelection.Select(mod, VersionAt(mod));
        Assert(selected.Refusal is null, "macOS bundle with Resources/release_info.json selects a lane");
        Assert(Path.GetFileName(selected.LaneDirectory) == "0.111.0", "beta bundle selects beta lane");

        File.WriteAllText(Path.Combine(contents, "Resources", "release_info.json"), "{\"version\":\"v0.107.1\"}");
        selected = CouchCoopLaneSelection.Select(mod, VersionAt(mod));
        Assert(Path.GetFileName(selected.LaneDirectory) == "0.107.1", "stable bundle selects stable lane");

        File.Delete(Path.Combine(contents, "Resources", "release_info.json"));
        File.WriteAllText(Path.Combine(contents, "Resources", "Release_Info.json"), "{\"version\":\"v0.111.0\"}");
        selected = CouchCoopLaneSelection.Select(mod, VersionAt(mod));
        Assert(selected.Refusal is not null, "wrong-case release_info name does not select a lane");

        File.Delete(Path.Combine(contents, "Resources", "Release_Info.json"));
        File.WriteAllText(Path.Combine(contents, "Resources", "release_info.json"), "{\"version\":\"v0.111.0\"}");
        Directory.Move(Path.Combine(mod, "lanes"), Path.Combine(mod, "LANES"));
        selected = CouchCoopLaneSelection.Select(mod, VersionAt(mod));
        Assert(selected.Refusal is not null, "wrong-case lanes directory refuses instead of becoming a flat payload");
        Directory.Move(Path.Combine(mod, "LANES"), Path.Combine(mod, "lanes"));

        var stableAssembly = Path.Combine(mod, "lanes", "0.107.1", "CouchCoop.Mod.dll");
        File.WriteAllText(stableAssembly, "fixture");
        Assert(CouchCoopLaneSelection.FindAssembly([Path.GetDirectoryName(stableAssembly)!], "CouchCoop.Mod") == stableAssembly,
            "exact-case lane assembly resolves");
        File.Move(stableAssembly, Path.Combine(Path.GetDirectoryName(stableAssembly)!, "CouchCoop.mod.dll"));
        Assert(CouchCoopLaneSelection.FindAssembly([Path.GetDirectoryName(stableAssembly)!], "CouchCoop.Mod") is null,
            "wrong-case lane assembly does not resolve");
        Assert(CouchCoopLaneSelection.FindAssembly([Path.GetDirectoryName(stableAssembly)!], "CouchCoop.Spirectl") is null,
            "missing lane assembly does not resolve");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static string? VersionAt(string modDirectory) =>
        CouchCoopLaneSelection.ReadInstallVersion(CouchCoopLaneSelection.TryWalkToInstallRoot(modDirectory));

    private sealed class TempTree : IDisposable
    {
        internal TempTree(string name)
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), name + " " + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        internal string Path { get; }
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
