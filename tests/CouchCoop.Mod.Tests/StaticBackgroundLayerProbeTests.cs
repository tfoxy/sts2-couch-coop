using CouchCoop.Mod.Server;

// The static-background tracker's MOUNTED-LAYER probe — the half that decides WHICH layer variant the
// host-rendered image is asked to depict ("match the mounted variant", the product decision behind the
// digest-qualified /bg/ URL).
//
// The defect these pin (found live, Aug-13): the probe read only the bg root's DIRECT children. In the real
// scene those are the declared PLACEHOLDER containers (Layer_00..Layer_NN, Foreground) with NO SceneFilePath —
// the randomly chosen variant is instanced ONE LEVEL BELOW each. So the probe collected zero layers, published a
// digest-less descriptor, and the render silently fell back to deterministic-first-sorted discovery: measured
// live in the underdocks room, the mounted set was 00_a/01_c/02_c/03_c/04_b/fg_a while a first-sorted render
// picks the `_a` variant for every placeholder — four of six layers wrong, and no signal that anything was off.
//
// The traversal is generic over (children, scenePath) accessors ONLY so it can be driven here: this test host has
// Godot loaded but no engine, so building a real Node tree segfaults. The live call site passes the Godot
// accessors to the very same method.
internal static class StaticBackgroundLayerProbeTests
{
    // A stand-in for a live Godot node: what the probe is allowed to know about one.
    private sealed record ProbeNode(string? ScenePath, params ProbeNode[] Children);

    private static readonly Func<ProbeNode, IReadOnlyList<ProbeNode>> Children = node => node.Children;
    private static readonly Func<ProbeNode, string?> ScenePath = node => node.ScenePath;

    private static List<string> Probe(ProbeNode bgRoot, int maxDepth = CouchCoopStaticBackgroundTracker.LayerProbeMaxDepth)
        => CouchCoopStaticBackgroundTracker.CollectMountedLayerPaths(bgRoot, Children, ScenePath, maxDepth);

    public static void Run()
    {
        ReadsTheVariantInstancedUnderEachPlaceholder();
        TakesTheShallowestInstanceSoNestedPropsCannotWin();
        DirectlyInstancedLayersStillWork();
        EmptyPlaceholdersContributeNothing();
        RespectsTheDepthCap();
        Console.WriteLine("StaticBackgroundLayerProbeTests passed");
    }

    // THE REGRESSION: the exact shape measured off the live underdocks room (placeholder container → variant).
    private static void ReadsTheVariantInstancedUnderEachPlaceholder()
    {
        const string Layers = "res://scenes/backgrounds/underdocks/layers/";
        var bgRoot = new ProbeNode(
            "res://scenes/backgrounds/underdocks/underdocks_background.tscn",
            new ProbeNode(null, new ProbeNode($"{Layers}underdocks_bg_00_a.tscn")),
            new ProbeNode(null, new ProbeNode($"{Layers}underdocks_bg_01_c.tscn")),
            new ProbeNode(null, new ProbeNode($"{Layers}underdocks_bg_02_c.tscn")),
            new ProbeNode(null, new ProbeNode($"{Layers}underdocks_bg_03_c.tscn")),
            new ProbeNode(null, new ProbeNode($"{Layers}underdocks_bg_04_b.tscn")),
            new ProbeNode(null, new ProbeNode($"{Layers}underdocks_fg_a.tscn")));

        var layers = Probe(bgRoot);
        Assert(layers.Count == 6, $"expected all 6 mounted layers, got {layers.Count}");
        Assert(layers[1].EndsWith("underdocks_bg_01_c.tscn", StringComparison.Ordinal), $"layer 1 = {layers[1]}");
        Assert(layers[4].EndsWith("underdocks_bg_04_b.tscn", StringComparison.Ordinal), $"layer 4 = {layers[4]}");
        Assert(layers[5].EndsWith("underdocks_fg_a.tscn", StringComparison.Ordinal), $"foreground = {layers[5]}");
        // Paint order is the child order — the render's per-placeholder mapping depends on it.
        Assert(
            layers.SequenceEqual([
                $"{Layers}underdocks_bg_00_a.tscn",
                $"{Layers}underdocks_bg_01_c.tscn",
                $"{Layers}underdocks_bg_02_c.tscn",
                $"{Layers}underdocks_bg_03_c.tscn",
                $"{Layers}underdocks_bg_04_b.tscn",
                $"{Layers}underdocks_fg_a.tscn"
            ]),
            "mounted layer paths must come back in paint order");

        // And the digest must therefore be a real (variant-specific) one, not the digest-less fallback.
        var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(layers);
        Assert(digest is { Length: > 0 }, "a mounted layer set must produce a digest");
        var otherVariant = layers.ToList();
        otherVariant[1] = $"{Layers}underdocks_bg_01_a.tscn";
        Assert(
            CouchCoopStaticBackgroundProvider.ComputeLayersDigest(otherVariant) != digest,
            "a different mounted variant must key a different cache entry");
    }

    // A layer scene instances its own props; those are DEEPER than the layer, so shallowest-wins keeps them out.
    private static void TakesTheShallowestInstanceSoNestedPropsCannotWin()
    {
        var bgRoot = new ProbeNode(
            "res://scenes/backgrounds/underdocks/underdocks_background.tscn",
            new ProbeNode(
                null,
                new ProbeNode(
                    "res://scenes/backgrounds/underdocks/layers/underdocks_bg_00_a.tscn",
                    new ProbeNode("res://scenes/props/barrel.tscn"))));

        var layers = Probe(bgRoot);
        Assert(layers.Count == 1 && layers[0].EndsWith("underdocks_bg_00_a.tscn", StringComparison.Ordinal),
            $"expected the layer scene, got [{string.Join(", ", layers)}]");
    }

    // The pre-fix shape (a variant instanced DIRECTLY as the bg root's child) must keep working — some rooms may
    // declare no placeholder container at all.
    private static void DirectlyInstancedLayersStillWork()
    {
        var bgRoot = new ProbeNode(
            "res://scenes/backgrounds/foo/foo_background.tscn",
            new ProbeNode("res://scenes/backgrounds/foo/layers/foo_bg_00_a.tscn"),
            new ProbeNode("res://scenes/backgrounds/foo/layers/foo_fg_a.tscn"));

        Assert(Probe(bgRoot).Count == 2, "directly instanced layers must still be collected");
    }

    // A placeholder with nothing instanced is LEGAL (the room mounted no variant there) — it contributes nothing
    // rather than failing the probe; the render's selector honors per-placeholder absence.
    private static void EmptyPlaceholdersContributeNothing()
    {
        var bgRoot = new ProbeNode(
            "res://scenes/backgrounds/foo/foo_background.tscn",
            new ProbeNode(null, new ProbeNode("res://scenes/backgrounds/foo/layers/foo_bg_00_a.tscn")),
            new ProbeNode(null),
            new ProbeNode(null, new ProbeNode(null)));

        var layers = Probe(bgRoot);
        Assert(layers.Count == 1, $"only the instanced placeholder counts, got {layers.Count}");
    }

    // The cap bounds the probe on an unexpected scene shape (it must not walk a whole room subtree).
    private static void RespectsTheDepthCap()
    {
        var deep = new ProbeNode(
            "res://scenes/backgrounds/foo/foo_background.tscn",
            new ProbeNode(null, new ProbeNode(null, new ProbeNode(null, new ProbeNode(null,
                new ProbeNode("res://scenes/backgrounds/foo/layers/foo_bg_00_a.tscn"))))));

        Assert(Probe(deep, maxDepth: 1).Count == 0, "a too-deep instance must not be picked up at depth 1");
        Assert(Probe(deep, maxDepth: 4).Count == 1, "the same instance is found when the cap allows it");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"StaticBackgroundLayerProbeTests: {message}");
        }
    }
}
