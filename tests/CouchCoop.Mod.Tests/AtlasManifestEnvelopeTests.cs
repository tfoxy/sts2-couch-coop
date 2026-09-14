using System.Reflection;
using System.Text.Json;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

// THE HOST PUBLISHES THE ATLAS PAGES IT ACTUALLY HAS.
//
// The browser's idle prefetch (frontend/src/mirror/imagePrefetch.ts) warms a fixed wish-list of atlas pages during
// connect/join, compiled into the bundle as literal res:// paths. The game's public-beta branch repacked the card
// atlas from three pages into two, so every client asked a host with no `card_atlas_2.png` for it — a 404 that
// costs the HOST a failed main-thread ResourceLoader.Load, is not negatively cached there, and therefore repeats
// for every new client that connects.
//
// CouchCoopAtlasManifest enumerates res://images/atlases/ once at startup and the session envelope carries the
// result, so the client intersects its wish-list with a real answer. What is testable here without an engine is
// the two halves that decide whether the answer is right: how a directory listing becomes page paths, and what
// the envelope does with the result (including doing NOTHING when there isn't one).
internal static class AtlasManifestEnvelopeTests
{
    public static void Run()
    {
        ArmBaselineFastPath();

        ListingBecomesLoadablePagePaths();
        TheBetaRepackPublishesTwoCardPages();
        EnvelopeCarriesThePublishedPages();
        AnUnknownManifestIsOmittedEntirely();

        // Says so out loud, like its neighbours: the suite registered directly after this one can take the whole
        // process down on some machines (exit 139, no message), and a run that died there is otherwise
        // indistinguishable from one that never got here.
        Console.WriteLine("AtlasManifestEnvelopeTests: ok");
    }

    // A directory listing is not a list of resource paths. In an EXPORTED game the source image is not in the PCK
    // at its own path — Godot ships the compiled texture under res://.godot/imported/ and leaves the `.import`
    // sidecar beside the original path, which is what ResourceLoader follows — so the listing spells every page
    // `<name>.png.import`. An unexported/dev tree lists both spellings. Both must yield the ONE loadable path.
    private static void ListingBecomesLoadablePagePaths()
    {
        var pages = CouchCoopAtlasManifest.PagesFromEntries([
            "card_atlas_0.png.import",
            "card_atlas_1.png.import",
            "ui_atlas_0.png",              // dev tree: the source…
            "ui_atlas_0.png.import",       // …and its sidecar. One page, not two.
            "relic_atlas.png.remap",       // the other suffix Godot can leave behind
            "  potion_atlas.png  ",        // trimmed
            "atlas_notes.txt",             // not a page
            "card_atlas.sprites",          // a sprite-document folder name, were one ever to reach here
            "",
            ".",
            ".."
        ]);

        Assert(pages is [
            "res://images/atlases/card_atlas_0.png",
            "res://images/atlases/card_atlas_1.png",
            "res://images/atlases/potion_atlas.png",
            "res://images/atlases/relic_atlas.png",
            "res://images/atlases/ui_atlas_0.png"
        ], "a listing becomes deduped, ordinal-sorted, directory-qualified page paths");

        // Every entry is addressable exactly the way the client spells it, which is the only thing that makes the
        // intersection on the other side a string comparison rather than a guess.
        foreach (var page in pages)
        {
            Assert(page.StartsWith(CouchCoopAtlasManifest.AtlasDirectory, StringComparison.Ordinal),
                $"{page} is qualified with the atlas directory");
            Assert(!page.Contains(".import", StringComparison.OrdinalIgnoreCase)
                && !page.Contains(".remap", StringComparison.OrdinalIgnoreCase),
                $"{page} names a loadable resource, not a sidecar");
        }
    }

    // The bug, as a rule. A build that ships two card pages must publish two, and must NOT publish the third — the
    // page whose absence is the whole 404.
    private static void TheBetaRepackPublishesTwoCardPages()
    {
        var beta = CouchCoopAtlasManifest.PagesFromEntries(
            ["card_atlas_0.png.import", "card_atlas_1.png.import", "ui_atlas_0.png.import"]);
        Assert(!beta.Contains("res://images/atlases/card_atlas_2.png"),
            "a two-page build does not publish card_atlas_2");
        Assert(beta.Contains("res://images/atlases/card_atlas_0.png")
            && beta.Contains("res://images/atlases/card_atlas_1.png"),
            "…and does publish the two it has");

        // The stable build really has three, and the client's wish-list warming that third page is the reason a
        // blanket trim of the frontend array would have been the wrong fix.
        var stable = CouchCoopAtlasManifest.PagesFromEntries(
            ["card_atlas_0.png.import", "card_atlas_1.png.import", "card_atlas_2.png.import"]);
        Assert(stable.Contains("res://images/atlases/card_atlas_2.png"),
            "a three-page build publishes card_atlas_2");
    }

    private static void EnvelopeCarriesThePublishedPages()
    {
        string[] published = ["res://images/atlases/card_atlas_0.png", "res://images/atlases/card_atlas_1.png"];
        CouchCoopAtlasManifest.SetPagesForTest(published);
        try
        {
            var envelope = CreateSessionEnvelope();

            Assert(envelope.AtlasManifest is not null, "session envelope carries an atlasManifest");
            Assert(envelope.AtlasManifest!.Directory == CouchCoopAtlasManifest.AtlasDirectory,
                "the manifest names the directory it covers");
            Assert(envelope.AtlasManifest.Pages.SequenceEqual(published),
                "the manifest carries the enumerated pages verbatim, in order");

            // The wire spelling the client parses: camelCased, nested, and a real JSON array.
            var json = JsonSerializer.SerializeToElement(envelope, BrowserJson.Options);
            Assert(json.TryGetProperty("atlasManifest", out var manifest)
                && manifest.ValueKind == JsonValueKind.Object,
                "the wire field is `atlasManifest`");
            Assert(manifest.GetProperty("directory").GetString() == "res://images/atlases/",
                "…carrying `directory`");
            Assert(manifest.GetProperty("pages").EnumerateArray().Select(p => p.GetString()).SequenceEqual(published),
                "…and `pages` as an array of res:// paths");
        }
        finally
        {
            CouchCoopAtlasManifest.SetPagesForTest(null);
        }
    }

    // A host that never enumerated — no engine, an unreadable directory, an older build — must OMIT the field
    // rather than send an empty list. The client reads absent as "keep your own list" and an empty list as "this
    // build ships no atlases at all", so the difference is the whole prefetch.
    private static void AnUnknownManifestIsOmittedEntirely()
    {
        CouchCoopAtlasManifest.SetPagesForTest(null);
        Assert(CouchCoopAtlasManifest.Pages is null, "an un-warmed manifest reads as unknown, not as empty");
        AssertOmitted(CreateSessionEnvelope(), "an un-warmed host omits atlasManifest");

        // And an enumeration that legitimately found nothing takes the same path — never an empty array.
        CouchCoopAtlasManifest.SetPagesForTest([]);
        try
        {
            AssertOmitted(CreateSessionEnvelope(), "an empty enumeration omits atlasManifest rather than sending []");
        }
        finally
        {
            CouchCoopAtlasManifest.SetPagesForTest(null);
        }
    }

    private static void AssertOmitted(BrowserEnvelope envelope, string label)
    {
        Assert(envelope.AtlasManifest is null, label);
        var json = JsonSerializer.SerializeToElement(envelope, BrowserJson.Options);
        Assert(!json.TryGetProperty("atlasManifest", out _), label + " (and it is absent on the wire)");
    }

    private static BrowserEnvelope CreateSessionEnvelope()
        => new BrowserStateEnvelopeFactory(
                new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"))))
            .CreateSessionEnvelope("Alice", "session", null).GetAwaiter().GetResult();

    // CreateSessionEnvelope reads the host's baseline MaxFps, which on the desktop path hops to the Godot main
    // thread — a NATIVE call that segfaults in this engine-less process. Arm the captured-baseline fast path so
    // the read is a plain field return, exactly as AssetCacheTokenEnvelopeTests does.
    private static void ArmBaselineFastPath()
    {
        var type = typeof(CouchCoopHeadlessVisualSuspender);
        type.GetField("_baselineMaxFps", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, 60);
        type.GetField("_baselineCaptured", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, true);
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"AtlasManifestEnvelopeTests: {label}");
        }
    }
}
