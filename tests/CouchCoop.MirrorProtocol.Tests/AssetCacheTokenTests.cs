using CouchCoop.MirrorProtocol.Assets;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-U (M3): the disk asset-cache invalidation token composed on the server and used by the native client to name
// its cache namespace. Deterministic; changes iff any input changes; blank/whitespace inputs normalize to "unknown".
internal static class AssetCacheTokenTests
{
    public static void Run()
    {
        Deterministic();
        ChangesOnAnyInput();
        BlankNormalizesToUnknown();
        FormatIsCcPrefixedShaPrefix();
    }

    private static void Deterministic()
    {
        var a = AssetCacheToken.Compose("1.2.3", "mod-9", "schema-v8");
        var b = AssetCacheToken.Compose("1.2.3", "mod-9", "schema-v8");
        Check.Equal(a, b, "same inputs → same token");
    }

    private static void ChangesOnAnyInput()
    {
        var baseline = AssetCacheToken.Compose("g1", "m1", "a1");
        Check.That(baseline != AssetCacheToken.Compose("g2", "m1", "a1"), "game version changes token");
        Check.That(baseline != AssetCacheToken.Compose("g1", "m2", "a1"), "mod version changes token");
        Check.That(baseline != AssetCacheToken.Compose("g1", "m1", "a2"), "asset schema changes token");
    }

    private static void BlankNormalizesToUnknown()
    {
        var unknown = AssetCacheToken.Compose("unknown", "m", "a");
        Check.Equal(AssetCacheToken.Compose(null, "m", "a"), unknown, "null game → unknown");
        Check.Equal(AssetCacheToken.Compose("", "m", "a"), unknown, "empty game → unknown");
        Check.Equal(AssetCacheToken.Compose("   ", "m", "a"), unknown, "whitespace game → unknown");

        // Stable when gameVersion is unreported but the mod/schema are known (the common headless case).
        Check.Equal(
            AssetCacheToken.Compose(null, "mod-9", "schema-v8"),
            AssetCacheToken.Compose("", "mod-9", "schema-v8"),
            "unreported game version is stable");
    }

    private static void FormatIsCcPrefixedShaPrefix()
    {
        var token = AssetCacheToken.Compose("1.2.3", "mod", "schema");
        Check.That(token.StartsWith("cc-", StringComparison.Ordinal), "token has cc- prefix");
        Check.Equal(token.Length, 3 + 16, "token is cc- + 16 hex chars");
        var hex = token["cc-".Length..];
        Check.That(hex.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')), "suffix is lowercase hex");
    }
}
