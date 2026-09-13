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

        // The SOURCE manifest must carry a real release version. Two scripts stamp a different one into the
        // copy they publish and neither may reach this file: scripts/package-release.sh derives a snapshot
        // version FROM this value (and requires MAJOR.MINOR.PATCH exactly), and scripts/stamp-local-mod.sh
        // writes a deliberately unbeatable 9999.0.0 into a dev deploy so it cannot lose the game's
        // Workshop-vs-local version comparison. A stamp that leaked back into the repo would ship.
        Assert(root.TryGetProperty("version", out var version) && version.ValueKind == JsonValueKind.String,
            "the manifest declares a version");
        var declared = version.GetString() ?? "";
        Assert(System.Text.RegularExpressions.Regex.IsMatch(declared, @"^[0-9]+\.[0-9]+\.[0-9]+$"),
            $"the source manifest version is plain MAJOR.MINOR.PATCH, not a stamped one: '{declared}'");
        Assert(!declared.StartsWith("9999.", StringComparison.Ordinal),
            "the dev deploy stamp (9999.x) never reaches the source manifest — scripts/stamp-local-mod.sh "
            + "writes it into the DEPLOYED copy only");
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
