using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// THIRD leg (C# reader side) of the static-kept field lockstep. tests/fixtures/wire/static-fields.json lists the
// wire static-kept fields; staticFields.spec.ts asserts the client mergeNode keeps them across a volatile-only
// upsert; this suite asserts the SAME on the shared SceneTreeApplier.MergeNode, driven by the SAME fixture list —
// so a drift on any side breaks a test. Port of staticFields.spec.ts.
internal static class StaticFieldsTests
{
    public static void Run()
    {
        CarriesEveryWireStaticFieldForward();
        TakesVolatileFieldsFromTheUpsert();
        CarriesEveryStickyFieldForward();
        FreshStickyValuesReplaceTheRetainedOnes();
    }

    private static Dictionary<string, object?> Color(string html) =>
        new() { ["r"] = 0.1, ["g"] = 0.2, ["b"] = 0.3, ["a"] = 1, ["html"] = html };

    private static Dictionary<string, object?> Xform(double tx, double ty) => new()
    {
        ["xAxis"] = new Dictionary<string, object?> { ["x"] = 1, ["y"] = 0 },
        ["yAxis"] = new Dictionary<string, object?> { ["x"] = 0, ["y"] = 1 },
        ["origin"] = new Dictionary<string, object?> { ["x"] = tx, ["y"] = ty },
    };

    private static Dictionary<string, object?> Box(double w, double h) => new()
    {
        ["position"] = new Dictionary<string, object?> { ["x"] = 0, ["y"] = 0 },
        ["size"] = new Dictionary<string, object?> { ["x"] = w, ["y"] = h },
    };

    private static Dictionary<string, object?> SentinelWire() => new()
    {
        ["id"] = "n",
        ["parentId"] = "parent-1",
        ["name"] = "existing-name",
        ["nodeType"] = "Existing.Type",
        ["showBehindParent"] = true,
        ["clipChildren"] = 2,
        ["clipContents"] = true,
        ["ninePatchMargins"] = new Dictionary<string, object?> { ["left"] = 1, ["top"] = 2, ["right"] = 3, ["bottom"] = 4 },
        ["font"] = new Dictionary<string, object?> { ["resourcePath"] = "res://fonts/f.ttf" },
        ["fontWeight"] = "bold",
        ["fontStyle"] = "italic",
        // Per-role rich-text fonts + their sizes/glyph spacing (producer-static, add/keyframe only).
        ["richBoldFont"] = new Dictionary<string, object?> { ["resourcePath"] = "res://fonts/kreon_bold.ttf" },
        ["richItalicFont"] = new Dictionary<string, object?> { ["resourcePath"] = "res://fonts/kreon_italic.ttf" },
        ["richBoldItalicFont"] = new Dictionary<string, object?> { ["resourcePath"] = "res://fonts/kreon_bold_italic.ttf" },
        ["richBoldFontSizePx"] = 21,
        ["richItalicFontSizePx"] = 22,
        ["richBoldItalicFontSizePx"] = 23,
        ["richBoldFontSpacingPx"] = 1,
        ["richItalicFontSpacingPx"] = 2,
        ["richBoldItalicFontSpacingPx"] = 3,
        ["shadow"] = new Dictionary<string, object?> { ["color"] = Color("#000000ff"), ["offset"] = new Dictionary<string, object?> { ["x"] = 1, ["y"] = 1 } },
        ["richText"] = true,
        ["material"] = new Dictionary<string, object?> { ["resourcePath"] = "res://mat.tres" },
        ["shader"] = new Dictionary<string, object?> { ["resourcePath"] = "res://shader.gdshader" },
        ["textureStretchMode"] = 5,
        ["textureFlipH"] = true,
        ["textureFlipV"] = true,
        ["canvasBlendMode"] = 1,
        ["particleSpec"] = new Dictionary<string, object?> { ["kind"] = "GPUParticles2D", ["amount"] = 8 },
        ["spine"] = new Dictionary<string, object?> { ["sceneResPath"] = "res://spine.tscn", ["nodePath"] = "Node/Path", ["animations"] = new List<object?> { "idle", "attack" } },
        ["sceneFilePath"] = "res://scene.tscn",
        ["mouseFilter"] = 1,
        ["anchorLeft"] = 0.25,
        ["anchorRight"] = 0.75,
        ["anchorOwnerId"] = "owner-1",
        ["containerLayout"] = "hbox-center",
        // sticky (producer re-ships only on change; mergeNode carries them forward) — see the fixture's stickyFields
        ["intentFrames"] = new Dictionary<string, object?>
        {
            ["animationName"] = "attack",
            ["fps"] = 15,
            ["frames"] = new List<object?>
            {
                new Dictionary<string, object?> { ["atlasPath"] = "res://images/intent_atlas.png" },
            },
        },
        ["linePoints"] = new List<object?> { 17, 98, 457, 249 },
        ["lineWidth"] = 4,
        ["lineColor"] = Color("#ff0000ff"),
        // volatile
        ["transform"] = Xform(11, 22),
        ["localRect"] = Box(100, 50),
        ["visible"] = true,
        ["opacity"] = 0.5,
        ["modulate"] = Color("#1a334cff"),
        ["outlineColor"] = Color("#1a334cff"),
        ["outlineSize"] = 3,
    };

    private static Dictionary<string, object?> VolatileWire() => new()
    {
        ["id"] = "n",
        ["parentId"] = "parent-2",
        ["transform"] = Xform(99, 88),
        ["localRect"] = Box(10, 10),
        ["visible"] = false,
        ["opacity"] = 0.9,
        ["modulate"] = Color("#e6ccb3ff"),
        ["outlineColor"] = Color("#e6ccb3ff"),
        ["outlineSize"] = 5,
        ["spineCurrentAnim"] = "attack",
    };

    private static void Apply(MirrorState state, List<object?> upserts, bool full)
    {
        var delta = SceneDeltaReader.Parse(TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "scene-delta",
            ["full"] = full,
            ["screenType"] = "run",
            ["upserts"] = upserts,
            ["orderedIds"] = full ? new List<object?> { "n" } : null,
        }))!;
        SceneTreeApplier.ApplySceneDelta(state, delta);
    }

    // How to read each wire static field's RETAINED value off the merged node (the wire→client renames/splits).
    private static readonly Dictionary<string, Func<MirrorNode, object?>> Checks = new()
    {
        ["name"] = n => n.Name,
        ["nodeType"] = n => n.NodeType,
        ["showBehindParent"] = n => n.ShowBehindParent,
        ["clipChildren"] = n => n.ClipChildren,
        ["clipContents"] = n => n.ClipContents,
        ["ninePatchMargins"] = n => n.NinePatchMargins?.Left,
        ["font"] = n => n.Font?.Family,
        ["fontWeight"] = n => n.Font?.Weight,
        ["fontStyle"] = n => n.Font?.Style,
        ["richBoldFont"] = n => n.RichBoldFont?.Family,
        ["richItalicFont"] = n => n.RichItalicFont?.Family,
        ["richBoldItalicFont"] = n => n.RichBoldItalicFont?.Family,
        ["richBoldFontSizePx"] = n => n.RichBoldFontSizePx,
        ["richItalicFontSizePx"] = n => n.RichItalicFontSizePx,
        ["richBoldItalicFontSizePx"] = n => n.RichBoldItalicFontSizePx,
        ["richBoldFontSpacingPx"] = n => n.RichBoldFontSpacingPx,
        ["richItalicFontSpacingPx"] = n => n.RichItalicFontSpacingPx,
        ["richBoldItalicFontSpacingPx"] = n => n.RichBoldItalicFontSpacingPx,
        ["shadow"] = n => n.Shadow?.OffsetX,
        ["richText"] = n => n.RichText,
        ["material"] = n => n.MaterialRef,
        ["shader"] = n => n.ShaderId,
        ["textureStretchMode"] = n => n.TextureStretchMode,
        ["textureFlipH"] = n => n.TextureFlipH,
        ["textureFlipV"] = n => n.TextureFlipV,
        ["canvasBlendMode"] = n => n.CanvasBlendMode,
        ["particleSpec"] = n => n.ParticleSpec?.Kind,
        ["spine"] = n => n.SpineSceneResPath,
        ["sceneFilePath"] = n => n.SceneFilePath,
        ["mouseFilter"] = n => n.MouseFilter,
        ["anchorLeft"] = n => n.AnchorLeft,
        ["anchorRight"] = n => n.AnchorRight,
        ["anchorOwnerId"] = n => n.AnchorOwnerId,
        ["containerLayout"] = n => n.ContainerLayout,
    };

    private static readonly Dictionary<string, object?> Expected = new()
    {
        ["name"] = "existing-name",
        ["nodeType"] = "Existing.Type",
        ["showBehindParent"] = true,
        ["clipChildren"] = 2,
        ["clipContents"] = true,
        ["ninePatchMargins"] = 1.0,
        ["font"] = "f",
        ["fontWeight"] = "bold",
        ["fontStyle"] = "italic",
        ["richBoldFont"] = "kreon_bold",
        ["richItalicFont"] = "kreon_italic",
        ["richBoldItalicFont"] = "kreon_bold_italic",
        ["richBoldFontSizePx"] = 21.0,
        ["richItalicFontSizePx"] = 22.0,
        ["richBoldItalicFontSizePx"] = 23.0,
        ["richBoldFontSpacingPx"] = 1.0,
        ["richItalicFontSpacingPx"] = 2.0,
        ["richBoldItalicFontSpacingPx"] = 3.0,
        ["shadow"] = 1.0,
        ["richText"] = true,
        ["material"] = "res://mat.tres",
        ["shader"] = "res://shader.gdshader",
        ["textureStretchMode"] = 5,
        ["textureFlipH"] = true,
        ["textureFlipV"] = true,
        ["canvasBlendMode"] = 1,
        ["particleSpec"] = "GPUParticles2D",
        ["spine"] = "res://spine.tscn",
        ["sceneFilePath"] = "res://scene.tscn",
        ["mouseFilter"] = 1,
        ["anchorLeft"] = 0.25,
        ["anchorRight"] = 0.75,
        ["anchorOwnerId"] = "owner-1",
        ["containerLayout"] = "hbox-center",
    };

    private static (string[] WireStatic, string[] Sticky, string[] VolatileOutline) LoadFixture()
    {
        using var doc = JsonDocument.Parse(TestFixtures.ReadWire("static-fields.json"));
        var root = doc.RootElement;
        static string[] Arr(JsonElement el, string name) =>
            el.GetProperty(name).EnumerateArray().Select(e => e.GetString()!).ToArray();
        return (Arr(root, "wireStaticFields"), Arr(root, "stickyFields"), Arr(root, "volatileOutlineFields"));
    }

    private static void CarriesEveryWireStaticFieldForward()
    {
        var (wireStatic, _, _) = LoadFixture();
        var state = MirrorState.Create();
        Apply(state, [SentinelWire()], full: true);
        Apply(state, [VolatileWire()], full: false);
        var merged = state.Nodes["n"];

        foreach (var wireName in wireStatic)
        {
            Check.That(Checks.ContainsKey(wireName), $"fixture field '{wireName}' has a C# check (update StaticFieldsTests in lockstep)");
            Check.That(Expected.ContainsKey(wireName), $"fixture field '{wireName}' has an expected value");
            Check.Equal(Checks[wireName](merged), Expected[wireName], $"mergeNode kept static field '{wireName}'");
        }
    }

    private static void TakesVolatileFieldsFromTheUpsert()
    {
        var (_, _, volatileOutline) = LoadFixture();
        var state = MirrorState.Create();
        Apply(state, [SentinelWire()], full: true);
        Apply(state, [VolatileWire()], full: false);
        var merged = state.Nodes["n"];

        Check.That(volatileOutline.Contains("outlineColor"), "fixture marks outlineColor volatile");
        Check.Equal(merged.Outline?.ColorHtml, "#e6ccb3ff", "outline recolored from the upsert");
        Check.Equal(merged.Outline?.Size, 5.0, "outline size from the upsert");
        Check.Equal(merged.ParentId, "parent-2", "parentId from the upsert");
        Check.That(merged.Transform is not null && merged.Transform[4] == 99, "transform tx from the upsert");
        Check.Equal(merged.Opacity, 0.9, "opacity from the upsert");
        Check.Equal(merged.Visible, false, "visible from the upsert");
        Check.Equal(merged.SpineCurrentAnim, "attack", "spineCurrentAnim from the upsert");
    }

    // How to read each STICKY wire field's retained value off the merged node, and the sentinel it must still hold.
    // Sticky ≠ static: the producer re-ships these only when their own value changed, so BOTH merges use
    // `upsert ?? existing` — which means a volatile-only upsert (carrying none of them) must leave every sentinel
    // intact, exactly as for the static block, but a FRESH value must REPLACE (asserted separately below).
    private static readonly Dictionary<string, (Func<MirrorNode, object?> Read, object? Expected)> StickyChecks = new()
    {
        ["intentFrames"] = (n => n.IntentFrames?.AnimationName, "attack"),
        ["linePoints"] = (n => n.LinePoints is { } p ? string.Join(",", p) : null, "17,98,457,249"),
        ["lineWidth"] = (n => n.LineWidth, 4.0),
        ["lineColor"] = (n => n.LineColor?.Html, "#ff0000ff"),
    };

    private static void CarriesEveryStickyFieldForward()
    {
        var (_, sticky, _) = LoadFixture();
        var state = MirrorState.Create();
        Apply(state, [SentinelWire()], full: true);
        Apply(state, [VolatileWire()], full: false);
        var merged = state.Nodes["n"];

        foreach (var wireName in sticky)
        {
            Check.That(StickyChecks.ContainsKey(wireName),
                $"fixture sticky field '{wireName}' has a C# check (update StaticFieldsTests in lockstep)");
            var (read, expected) = StickyChecks[wireName];
            Check.Equal(read(merged), expected, $"mergeNode carried sticky field '{wireName}' forward");
        }
    }

    // The other half of sticky: a FRESH non-null value on a volatile-only upsert REPLACES the retained one (a
    // static-only carry-forward would freeze a growing stroke / a changed intent forever). The Line2D unit's EMPTY
    // array is the interesting case — it is the producer's "cleared" instruction, not "unchanged", so it must win.
    private static void FreshStickyValuesReplaceTheRetainedOnes()
    {
        var state = MirrorState.Create();
        Apply(state, [SentinelWire()], full: true);
        var grown = VolatileWire();
        grown["linePoints"] = new List<object?> { 17, 98, 457, 249, 390.25, 554.5 };
        grown["lineWidth"] = 12;
        grown["lineColor"] = Color("#0000ffff");
        Apply(state, [grown], full: false);
        var merged = state.Nodes["n"];
        Check.That(merged.LinePoints is { Count: 6 }, "a fresh point array replaces the retained one");
        Check.Equal(merged.LineWidth, 12.0, "a fresh width replaces the retained one");
        Check.Equal(merged.LineColor?.Html, "#0000ffff", "a fresh colour replaces the retained one");

        var cleared = MirrorState.Create();
        Apply(cleared, [SentinelWire()], full: true);
        var empty = VolatileWire();
        empty["linePoints"] = new List<object?>();
        Apply(cleared, [empty], full: false);
        Check.That(cleared.Nodes["n"].LinePoints is { Count: 0 },
            "an EMPTY point array (clear/undo) beats the retained geometry — it is an instruction, not an absence");
    }
}
