using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-P2 memoizing scene-identity + text-scale cache. Proves the cache reproduces SceneIdentity.Resolve +
// TextScale.ScaleFor, memoizes until Clear, and recomputes after Clear.
internal static class SceneIdentityCacheTests
{
    public static void Run()
    {
        ResolveMatchesDirectAndMemoizes();
    }

    // A card scene: root (Card, scene file) → CardContainer → DescriptionLabel. The leaf's scene-relative path is
    // "CardContainer/DescriptionLabel" (root name excluded). R6: its FONT scale is 1.0 (the enlargement is a block
    // TRANSFORM scale) while its BlockScale is 1.24; both flow through the cache Entry.
    private static MirrorState Build()
    {
        var state = MirrorState.Create();
        Add(state, "card", null, "Card", sceneFile: "res://scenes/card.tscn");
        Add(state, "cc", "card", "CardContainer");
        Add(state, "lbl", "cc", "DescriptionLabel");
        return state;
    }

    private static void Add(MirrorState state, string id, string? parent, string name, string? sceneFile = null)
    {
        state.Nodes[id] = new MirrorNode { Id = id, ParentId = parent, Name = name, SceneFilePath = sceneFile };
        state.OrderedIds.Add(id);
    }

    private static void ResolveMatchesDirectAndMemoizes()
    {
        var state = Build();
        var cache = new SceneIdentityCache();

        var e = cache.Resolve("lbl", state);
        Check.Equal(e.File, "res://scenes/card.tscn", "cache resolves the owning scene file");
        Check.Equal(e.RelPath, "CardContainer/DescriptionLabel", "cache resolves the scene-relative path (root excluded)");
        Check.Close(e.TextScale, 1.0, "R6: the card description FONT scale is 1.0 (block transform enlarges instead)");
        Check.Close(e.BlockScale, 1.24, "cache resolves the R6 block TRANSFORM scale for the card description label");

        // Identical to resolving directly.
        var (df, dr) = SceneIdentity.Resolve("lbl", state);
        Check.Equal(e.File, df, "cache File == SceneIdentity.Resolve File");
        Check.Equal(e.RelPath, dr, "cache RelPath == SceneIdentity.Resolve RelPath");
        Check.Close(e.TextScale, TextScale.ScaleFor(df, dr), "cache TextScale == TextScale.ScaleFor");
        Check.Close(e.BlockScale, BlockScale.ScaleFor(df, dr), "cache BlockScale == BlockScale.ScaleFor");
        // WS-TXT: the cache Entry also carries the card-description line-spacing metrics (MetricsFor).
        Check.Close(e.LineHeight ?? -1, TextScale.CardDescLineHeight, "cache propagates the card-desc line-height metric");
        Check.Close(e.ParagraphExtra ?? -1, TextScale.CardDescParagraphExtra, "cache propagates the card-desc paragraph-extra metric");
        Check.Equal(cache.Count, 1, "one identity memoized");

        // Memoization: mutate an identity input (rename the middle container). The cache keeps the STALE value until
        // Clear — proving it is memoized (a volatile-only drain must NOT change identity, so this is correct).
        state.Nodes["cc"].Name = "OtherContainer";
        var e2 = cache.Resolve("lbl", state);
        Check.Equal(e2, e, "cache returns the memoized identity even after the tree changed (until invalidated)");
        Check.Equal(SceneIdentity.Resolve("lbl", state).RelPath, "OtherContainer/DescriptionLabel", "the underlying identity actually changed");

        // Clear (what SceneReconciler does on a Static/order/keyframe drain) → recompute fresh.
        cache.Clear();
        Check.Equal(cache.Count, 0, "Clear drops all memoized identities");
        var e3 = cache.Resolve("lbl", state);
        Check.Equal(e3.RelPath, "OtherContainer/DescriptionLabel", "after Clear the cache recomputes fresh");
    }

}
