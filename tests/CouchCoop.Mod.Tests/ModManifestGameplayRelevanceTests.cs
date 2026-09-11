using System.Text.Json;

// couchcoop.json must keep "affects_gameplay": false.
//
// This is not cosmetic metadata. JoinFlow.Begin compares ModManager.GetGameplayRelevantModNameList() between host
// and joiner and REFUSES the connection when the lists differ (NetError/ConnectionFailureReason.ModMismatch, which
// the error popup renders as "missing on host / missing on local"). With affects_gameplay false the mod is absent
// from both lists, so [] == [] and a VANILLA Steam friend can join a couch-coop host — the entire point of WS-1.
// Flipping this flag to true would lock out every unmodded player, and would do it silently: nothing else in the
// build would fail. Hence a test that reads the shipped manifest itself.
internal static class ModManifestGameplayRelevanceTests
{
    public static void Run()
    {
        var path = ManifestPath();
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var root = document.RootElement;

        Assert(root.TryGetProperty("affects_gameplay", out var affectsGameplay),
            $"{path} declares affects_gameplay");
        Assert(affectsGameplay.ValueKind == JsonValueKind.False,
            "couchcoop.json keeps affects_gameplay=false — otherwise JoinFlow's gameplay-relevant mod-list "
            + "comparison rejects every vanilla Steam friend with ModMismatch, and nothing else in the build would say so");

        // The id is what the mod list is keyed by; a rename would also change the comparison.
        Assert(root.TryGetProperty("id", out var id) && id.GetString() == "couchcoop", "the manifest id is couchcoop");
    }

    private static string ManifestPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "CouchCoop.sln")))
        {
            dir = dir.Parent;
        }

        if (dir is null)
        {
            throw new Exception("[ModManifestGameplayRelevanceTests] could not locate the repo root (CouchCoop.sln).");
        }

        var path = Path.Combine(dir.FullName, "src", "CouchCoop.Mod.Loader", "couchcoop.json");
        if (!File.Exists(path))
        {
            throw new Exception($"[ModManifestGameplayRelevanceTests] mod manifest not found at {path}.");
        }

        return path;
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[ModManifestGameplayRelevanceTests] FAILED: {label}");
        }
    }
}
