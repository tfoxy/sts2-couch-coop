using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Port of frontend/src/mirror/__tests__/wireDefaults.spec.ts: the wire OMITS a value-type field iff it equals the
// client fallback default; the reader must refill exactly those defaults, and never drop a meaningful non-default.
internal static class WireDefaultsTests
{
    public static void Run()
    {
        FillsEveryOmittableFieldWithDefault();
        PreservesMeaningfulNonDefaults();
        FloatCastWireValuesParseTransparently();
    }

    // Build + apply a full keyframe with one node ({id:"n", name:"n", nodeType:"Control", ...over}); return node "n".
    private static MirrorNode Parse(Dictionary<string, object?> over)
    {
        var node = new Dictionary<string, object?> { ["id"] = "n", ["name"] = "n", ["nodeType"] = "Control" };
        foreach (var (k, v) in over)
        {
            node[k] = v;
        }

        var delta = SceneDeltaReader.Parse(TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "scene-delta",
            ["full"] = true,
            ["screenType"] = "run",
            ["upserts"] = new List<object?> { node },
            ["orderedIds"] = new List<object?> { "n" },
        }))!;
        var state = MirrorState.Create();
        SceneTreeApplier.ApplySceneDelta(state, delta);
        return state.Nodes["n"];
    }

    private static void FillsEveryOmittableFieldWithDefault()
    {
        var n = Parse([]); // maximally-slim node: only id/name/nodeType present
        Check.Equal(n.Visible, true, "visible default true");
        Check.Equal(n.Opacity, 1.0, "opacity default 1");
        Check.Equal(n.ScaleX, 1.0, "scaleX default 1");
        Check.Equal(n.ScaleY, 1.0, "scaleY default 1");
        Check.Equal(n.PivotX, 0.0, "pivotX default 0");
        Check.Equal(n.PivotY, 0.0, "pivotY default 0");
        Check.Equal(n.NinePatch, false, "ninePatch default false");
        Check.Equal(n.ShowBehindParent, false, "showBehindParent default false");
        Check.Equal(n.ClipChildren, 0, "clipChildren default 0");
        Check.Equal(n.ClipContents, false, "clipContents default false");
        Check.Equal(n.RichText, false, "richText default false");
        Check.Equal(n.TextureFlipH, false, "textureFlipH default false");
        Check.Equal(n.TextureFlipV, false, "textureFlipV default false");
        Check.Equal(n.ParticleEmitting, false, "particleEmitting default false");
        Check.Equal(n.ParticleRestartEpoch, 0L, "particleRestartEpoch default 0");
        Check.Equal(n.SpineTrackTime, 0.0, "spineTrackTime default 0");
        Check.Equal(n.SpineLooping, true, "spineLooping default true");
        Check.Equal(n.Rotation, 0.0, "rotation refilled 0 (killed end-to-end)");
        Check.Equal(n.ZIndex, null, "zIndex nullable passthrough");
    }

    private static void PreservesMeaningfulNonDefaults()
    {
        var n = Parse(new Dictionary<string, object?>
        {
            ["visible"] = false,
            ["opacity"] = 0,
            ["spineLooping"] = false,
            ["ninePatch"] = true,
            ["scaleX"] = 2,
            ["clipChildren"] = 1,
            ["clipContents"] = true,
        });
        Check.Equal(n.Visible, false, "visible false preserved");
        Check.Equal(n.Opacity, 0.0, "opacity 0 preserved");
        Check.Equal(n.SpineLooping, false, "spineLooping false preserved");
        Check.Equal(n.NinePatch, true, "ninePatch true preserved");
        Check.Equal(n.ScaleX, 2.0, "scaleX 2 preserved");
        Check.Equal(n.ClipChildren, 1, "clipChildren 1 preserved");
        Check.Equal(n.ClipContents, true, "clipContents true preserved");
    }

    private static void FloatCastWireValuesParseTransparently()
    {
        var n = Parse(new Dictionary<string, object?> { ["opacity"] = 0.5, ["scaleX"] = 1.3125, ["pivotX"] = 12.5 });
        Check.Equal(n.Opacity, 0.5, "opacity 0.5");
        Check.Equal(n.ScaleX, 1.3125, "scaleX 1.3125");
        Check.Equal(n.PivotX, 12.5, "pivotX 12.5");
    }
}
