using System;
using System.Collections.Generic;
using System.Reflection;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-P2 per-node change classification (NodeChangeDiffer) + the LOAD-BEARING completeness guard. The differ decides
// which changed views can take the reconciler's light (transform/tint-only) apply; the guard reflects over
// MirrorNode's public properties so a future wire field cannot silently become light-eligible.
internal static class NodeChangeDifferTests
{
    public static void Run()
    {
        EveryPropertyIsClassified();
        NewNodeIsFullAndHeavy();
        StaticBearingUpsertIsFull();
        TransformOnlyIsLightEligible();
        TintChannelsAreLightEligible();
        DrawTextEffectsAreHeavy();
        RegionSwapClassification();
        LineStrokeChangesAreHeavyDraw();
        SpineTrackTimeIsDeliberatelyIgnored();
        TransformPlusTintStaysLight();
        TransformPlusDrawIsHeavy();
        RemovalFlagsRemoved();
        FlagsAccumulateAcrossDeltasInADrain();
        KeyframeIdenticalIsNone();
        KeyframeStaticChangeIsHeavy();
        KeyframeTransformTintStaysLight();
        KeyframeParticleAndSpineChangesAreHeavy();
    }

    // ---- Track-A keyframe diff (ClassifyKeyframe) ----

    // Two content-identical nodes (a Reload re-send of an unchanged node) → None → the reconciler skips Apply entirely.
    private static void KeyframeIdenticalIsNone()
    {
        var prior = Rich("kf");
        var current = prior.Clone(); // byte-identical content, distinct instance (keyframe re-parse)
        Check.Equal(NodeChangeDiffer.ClassifyKeyframe(prior, current), NodeChangeFlags.None, "identical keyframe node → None (skip)");
    }

    // A keyframe CAN carry a genuine static change (a real scene change on Reload). ClassifyKeyframe value-compares the
    // static block (unlike Classify, which is short-circuited by a set Name) → heavy, never light-eligible.
    private static void KeyframeStaticChangeIsHeavy()
    {
        foreach (var (label, mutate) in new (string, Action<MirrorNode>)[]
        {
            ("nodeType", n => n.NodeType = "Control"),
            ("parentId", n => n.ParentId = "other"),
            ("mouseFilter", n => n.MouseFilter = 2),
            ("anchorLeft", n => n.AnchorLeft = 0.5),
            ("shaderId", n => n.ShaderId = "res://s.gdshader"),
        })
        {
            var prior = Rich("kf");
            var current = prior.Clone();
            mutate(current);
            var flags = NodeChangeDiffer.ClassifyKeyframe(prior, current);
            Check.That(flags != NodeChangeFlags.None, $"keyframe {label} change is detected");
            Check.That(!NodeChangeDiffer.IsLightEligible(flags), $"keyframe {label} change is heavy (full apply)");
        }
    }

    // A keyframe whose only diffs are transform + tint → light-eligible (same as the volatile-merge path).
    private static void KeyframeTransformTintStaysLight()
    {
        var prior = Rich("kf");
        var current = prior.Clone();
        current.Transform = [1, 0, 0, 1, 77, 88];
        current.Opacity = 0.3;
        current.Visible = false;
        var flags = NodeChangeDiffer.ClassifyKeyframe(prior, current);
        Check.Equal(flags, NodeChangeFlags.Transform | NodeChangeFlags.Tint, "keyframe transform+tint → Transform|Tint");
        Check.That(NodeChangeDiffer.IsLightEligible(flags), "keyframe transform+tint stays light-eligible");
    }

    // Effect-block keyframe changes (spine anim set / particle spec) are caught and heavy.
    private static void KeyframeParticleAndSpineChangesAreHeavy()
    {
        var prior = Rich("kf");
        var spineCurrent = prior.Clone();
        spineCurrent.SpineAnimations = ["idle", "attack"]; // prior had ["idle"]
        var spineFlags = NodeChangeDiffer.ClassifyKeyframe(prior, spineCurrent);
        Check.That((spineFlags & NodeChangeFlags.Effects) != 0, "keyframe spine-anim-set change → Effects");
        Check.That(!NodeChangeDiffer.IsLightEligible(spineFlags), "keyframe spine change is heavy");

        // Identical spine-anim set (fresh list instance) must NOT flag — SeqEqual value-compares.
        var spineSame = prior.Clone();
        spineSame.SpineAnimations = ["idle"];
        Check.Equal(NodeChangeDiffer.ClassifyKeyframe(prior, spineSame), NodeChangeFlags.None, "identical spine-anim set → None");
    }

    // LOAD-BEARING: every public MirrorNode property is classified in the differ table (and every classified name is a
    // real property — no typos/stale entries). Adding a wire field without classifying it fails HERE, forcing the
    // author to decide its category rather than let it default to "no change → light-eligible".
    private static void EveryPropertyIsClassified()
    {
        var props = typeof(MirrorNode).GetProperties(BindingFlags.Public | BindingFlags.Instance);
        Check.That(props.Length > 0, "reflection found MirrorNode public properties");

        var real = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in props)
        {
            real.Add(p.Name);
            Check.That(
                NodeChangeDiffer.ClassifiedNames.Contains(p.Name),
                $"MirrorNode.{p.Name} is classified in the differ (a new wire field must be classified, never silently light-eligible)");
        }

        foreach (var name in NodeChangeDiffer.ClassifiedNames)
        {
            Check.That(real.Contains(name), $"classified name '{name}' is a real MirrorNode property (no typo/stale entry)");
        }

        Check.Equal(NodeChangeDiffer.ClassifiedNames.Count, props.Length, "each property classified exactly once");
    }

    // ---- behavior ----

    private static void NewNodeIsFullAndHeavy()
    {
        var state = MirrorState.Create();
        var flags = ApplyAndFlag(state, Base("new"), full: true);
        Check.That((flags & NodeChangeFlags.New) != 0, "a brand-new node carries New");
        Check.That((flags & NodeChangeDiffer.StructuralAll) == NodeChangeDiffer.StructuralAll, "a new node carries every structural bit");
        Check.That(!NodeChangeDiffer.IsLightEligible(flags), "a new node is NOT light-eligible (fresh view must full-apply)");
    }

    private static void StaticBearingUpsertIsFull()
    {
        var b = Base("s");
        var state = Seed(b);
        // A static-bearing upsert (Name set) re-declares the whole static block → full change.
        var flags = ApplyAndFlag(state, Static(b, n => n.NodeType = "TextureRect"));
        Check.Equal(flags, NodeChangeDiffer.StructuralAll, "static-bearing upsert → StructuralAll");
        Check.That(!NodeChangeDiffer.IsLightEligible(flags), "static-bearing upsert is NOT light-eligible");
    }

    private static void TransformOnlyIsLightEligible()
    {
        var b = Base("tf");
        var state = Seed(b);
        var flags = ApplyAndFlag(state, Vol(b, n => n.Transform = [1, 0, 0, 1, 99, 20]));
        Check.Equal(flags, NodeChangeFlags.Transform, "transform-only volatile upsert → Transform");
        Check.That(NodeChangeDiffer.IsLightEligible(flags), "transform-only is light-eligible");

        // The redundant rotation/scale/pivot fields group under Transform too (still light).
        var flags2 = ApplyAndFlag(Seed(b), Vol(b, n => n.Rotation = 1.5));
        Check.Equal(flags2, NodeChangeFlags.Transform, "rotation-only → Transform");
        Check.That(NodeChangeDiffer.IsLightEligible(flags2), "rotation-only is light-eligible");
    }

    private static void TintChannelsAreLightEligible()
    {
        var b = Base("ti");
        foreach (var (label, mutate) in new (string, Action<MirrorNode>)[]
        {
            ("visible", n => n.Visible = false),
            ("opacity", n => n.Opacity = 0.4),
            ("modulate", n => n.Modulate = new MirrorColor(0.5, 0.5, 0.5, 0.5, "#80808080")),
            ("selfModulate", n => n.SelfModulate = new MirrorColor(0.2, 0.2, 0.2, 1, "#333333ff")),
            ("zIndex", n => n.ZIndex = 7),
        })
        {
            var flags = ApplyAndFlag(Seed(b), Vol(b, mutate));
            Check.Equal(flags, NodeChangeFlags.Tint, $"{label}-only → Tint");
            Check.That(NodeChangeDiffer.IsLightEligible(flags), $"{label}-only is light-eligible");
        }
    }

    private static void DrawTextEffectsAreHeavy()
    {
        var b = Base("h");
        var draw = ApplyAndFlag(Seed(b), Vol(b, n => n.TextureUrl = "res://img.png"));
        Check.Equal(draw, NodeChangeFlags.Draw, "texture change → Draw");
        Check.That(!NodeChangeDiffer.IsLightEligible(draw), "Draw is heavy");

        var text = ApplyAndFlag(Seed(b), Vol(b, n => n.Text = new MirrorText("hi", null, null, null, null, null, 0)));
        Check.Equal(text, NodeChangeFlags.Text, "text change → Text");
        Check.That(!NodeChangeDiffer.IsLightEligible(text), "Text is heavy");

        var fx = ApplyAndFlag(Seed(b), Vol(b, n => n.ParticleEmitting = true));
        Check.Equal(fx, NodeChangeFlags.Effects, "particle-emitting change → Effects");
        Check.That(!NodeChangeDiffer.IsLightEligible(fx), "Effects is heavy");
    }

    // R11 TextureRegion split. The single old TextureRegion→Draw rule became two: a null↔non-null transition stays
    // Draw (a real crop appear/disappear), a same-size region↔region swap becomes the light-eligible Region flag (a
    // flip-book frame — the Tezcatara flames), and a SIZE-changing swap trips both Region and (via LocalRect) Draw so
    // it stays heavy.
    private static void RegionSwapClassification()
    {
            // A Sprite2D playing an atlas flip-book: a base node carrying a crop region.
            MirrorNode Flame() => new()
            {
                Id = "flame",
                Name = "Flame",
                NodeType = "Sprite2D",
                Transform = [1, 0, 0, 1, 10, 20],
                LocalRect = new MirrorRect(0, 0, 64, 128),
                Visible = true,
                Opacity = 1,
                TextureUrl = "res://atlas.png",
                TextureRegion = new MirrorRect(0, 0, 64, 128),
            };

            // region↔region SAME-SIZE swap → Region (light-eligible), never Draw.
            var swap = ApplyAndFlag(Seed(Flame()), Vol(Flame(), n => n.TextureRegion = new MirrorRect(64, 0, 64, 128)));
            Check.Equal(swap, NodeChangeFlags.Region, "same-size region swap → Region");
            Check.That(NodeChangeDiffer.IsLightEligible(swap), "a same-size region swap is light-eligible");

            // null → non-null (a crop first appears) → Draw (heavy — the drawer must re-resolve).
            var appear = ApplyAndFlag(Seed(Base("ap")), Vol(Base("ap"), n => n.TextureRegion = new MirrorRect(0, 0, 64, 128)));
            Check.Equal(appear, NodeChangeFlags.Draw, "null→region transition → Draw");
            Check.That(!NodeChangeDiffer.IsLightEligible(appear), "a region-appearance transition is heavy");

            // non-null → null → Draw.
            var disappear = ApplyAndFlag(Seed(Flame()), Vol(Flame(), n => n.TextureRegion = null));
            Check.Equal(disappear, NodeChangeFlags.Draw, "region→null transition → Draw");

            // SIZE-changing swap → Region (regions differ) | Draw (LocalRect derives from region size) → heavy.
            var resize = ApplyAndFlag(Seed(Flame()), Vol(Flame(), n =>
            {
                n.TextureRegion = new MirrorRect(0, 0, 80, 128);
                n.LocalRect = new MirrorRect(0, 0, 80, 128);
            }));
            Check.Equal(resize, NodeChangeFlags.Region | NodeChangeFlags.Draw, "size-changing swap → Region|Draw");
            Check.That(!NodeChangeDiffer.IsLightEligible(resize), "a size-changing region swap is heavy (Draw bit)");

            // Region composes with Transform (a moving flame) and stays light-eligible.
            var move = ApplyAndFlag(Seed(Flame()), Vol(Flame(), n =>
            {
                n.TextureRegion = new MirrorRect(64, 0, 64, 128);
                n.Transform = [1, 0, 0, 1, 99, 20];
            }));
            Check.Equal(move, NodeChangeFlags.Region | NodeChangeFlags.Transform, "region swap + move → Region|Transform");
            Check.That(NodeChangeDiffer.IsLightEligible(move), "region + transform stays light-eligible");

    }

    // LINE2D STROKE geometry (map quill annotations). All three fields are DRAW — never light-eligible: the polyline
    // lives behind the FULL Apply (the web reconciler repaints it in updateSubLayers, the native view re-pushes
    // Points/Width/DefaultColor onto its `__line` child), and ApplyLight rewrites only transform/tint, so a
    // light-eligible classification would silently freeze a stroke mid-drag.
    //
    // LinePoints uses REFERENCE equality, which is correct precisely because the merge is sticky: an unchanged
    // stroke's merged node holds the SAME list instance the retained node did (`upsert ?? existing`), while any
    // re-shipped stroke arrives as a freshly parsed list. The two ends of that are both asserted.
    private static void LineStrokeChangesAreHeavyDraw()
    {
        MirrorNode Stroke() => new()
        {
            Id = "stroke",
            Name = "map_line_draw",
            NodeType = "Godot.Line2D",
            Transform = [2, 0, 0, 2, 1160.5, 618],
            Visible = true,
            Opacity = 1,
            LinePoints = [17, 98, 457, 249],
            LineWidth = 4,
            LineColor = new MirrorColor(1, 0, 0, 1, "#ff0000ff"),
        };

        // A GROWN stroke (a fresh array reference) → Draw, heavy.
        var grown = ApplyAndFlag(Seed(Stroke()), Vol(Stroke(), n => n.LinePoints = [17, 98, 457, 249, 390.25, 554.5]));
        Check.Equal(grown, NodeChangeFlags.Draw, "a fresh point array → Draw");
        Check.That(!NodeChangeDiffer.IsLightEligible(grown), "a stroke append is heavy (must reach the full Apply)");

        // A CLEARED stroke (empty array — the undo/clear instruction) is still a change, not an absence.
        var cleared = ApplyAndFlag(Seed(Stroke()), Vol(Stroke(), n => n.LinePoints = []));
        Check.Equal(cleared, NodeChangeFlags.Draw, "an emptied point array (clear/undo) → Draw");

        // Width / colour alone are Draw too.
        var rewidth = ApplyAndFlag(Seed(Stroke()), Vol(Stroke(), n => n.LineWidth = 12));
        Check.Equal(rewidth, NodeChangeFlags.Draw, "a width change → Draw");
        var recolor = ApplyAndFlag(Seed(Stroke()), Vol(Stroke(), n => n.LineColor = new MirrorColor(0, 0, 1, 1, "#0000ffff")));
        Check.Equal(recolor, NodeChangeFlags.Draw, "a colour change → Draw");

        // THE STICKY HALF: a plain volatile upsert carrying NO line fields must classify as no line change at all —
        // the merge hands the retained list straight through, so the reference test sees no diff. A stroke that only
        // MOVED therefore stays light-eligible (its geometry did not change), which is the whole point of the
        // reference comparison over a deep value compare.
        var moved = ApplyAndFlag(Seed(Stroke()), Vol(Stroke(), n =>
        {
            n.LinePoints = null;
            n.LineWidth = null;
            n.LineColor = null;
            n.Transform = [2, 0, 0, 2, 1200, 618];
        }));
        Check.Equal(moved, NodeChangeFlags.Transform, "a sticky no-op (null line fields) + a move → Transform only");
        Check.That(NodeChangeDiffer.IsLightEligible(moved), "an unchanged stroke that merely moved stays light-eligible");
    }

    // SpineTrackTime is deliberately EXCLUDED (SpineLayer free-runs and ignores track echoes) → a bare track-time
    // delta produces NO flag and stays light-eligible.
    private static void SpineTrackTimeIsDeliberatelyIgnored()
    {
        var b = Base("sk");
        var flags = ApplyAndFlag(Seed(b), Vol(b, n => n.SpineTrackTime = 3.14));
        Check.Equal(flags, NodeChangeFlags.None, "spine track-time-only change → None (ignored)");
        Check.That(NodeChangeDiffer.IsLightEligible(flags), "track-time-only stays light-eligible");
    }

    private static void TransformPlusTintStaysLight()
    {
        var b = Base("tt");
        var flags = ApplyAndFlag(Seed(b), Vol(b, n =>
        {
            n.Transform = [1, 0, 0, 1, 55, 66];
            n.Opacity = 0.7;
        }));
        Check.Equal(flags, NodeChangeFlags.Transform | NodeChangeFlags.Tint, "transform + tint → Transform|Tint");
        Check.That(NodeChangeDiffer.IsLightEligible(flags), "transform+tint stays light-eligible");
    }

    private static void TransformPlusDrawIsHeavy()
    {
        var b = Base("td");
        var flags = ApplyAndFlag(Seed(b), Vol(b, n =>
        {
            n.Transform = [1, 0, 0, 1, 55, 66];
            n.TextureUrl = "res://x.png";
        }));
        Check.Equal(flags, NodeChangeFlags.Transform | NodeChangeFlags.Draw, "transform + texture → Transform|Draw");
        Check.That(!NodeChangeDiffer.IsLightEligible(flags), "any Draw bit makes it heavy");
    }

    private static void RemovalFlagsRemoved()
    {
        var b = Base("rm");
        var state = Seed(b);
        SceneTreeApplier.ApplySceneDelta(state, new MirrorDelta { RemovedIds = ["rm"] });
        var flags = state.ChangeFlags.TryGetValue("rm", out var f) ? f : NodeChangeFlags.None;
        Check.That((flags & NodeChangeFlags.Removed) != 0, "a removal carries Removed");
    }

    // Flags OR-merge across a drain's deltas (a move then a recolor before the store clears).
    private static void FlagsAccumulateAcrossDeltasInADrain()
    {
        var b = Base("acc");
        var state = Seed(b);
        ApplyAndFlag(state, Vol(b, n => n.Transform = [1, 0, 0, 1, 33, 44])); // delta 1: transform
        var cur = state.Nodes["acc"];
        var flags = ApplyAndFlag(state, Vol(cur, n => n.Opacity = 0.3)); // delta 2: tint (no clear between)
        Check.Equal(flags, NodeChangeFlags.Transform | NodeChangeFlags.Tint, "two deltas OR to Transform|Tint");
    }

    // ---- helpers ----

    private static MirrorNode Base(string id) => new()
    {
        Id = id,
        Name = "Node",
        NodeType = "Control",
        Transform = [1, 0, 0, 1, 10, 20],
        LocalRect = new MirrorRect(0, 0, 100, 50),
        Visible = true,
        Opacity = 1,
    };

    // A node with fields set across every category (static / volatile / effects) so a Clone-then-compare exercises the
    // whole ClassifyKeyframe table — an identical clone must classify as None (no field spuriously flags).
    private static MirrorNode Rich(string id) => new()
    {
        Id = id,
        Name = "Node",
        NodeType = "TextureRect",
        ParentId = "root",
        Transform = [1, 0, 0, 1, 10, 20],
        LocalRect = new MirrorRect(0, 0, 100, 50),
        Visible = true,
        Opacity = 1,
        MouseFilter = 0,
        AnchorLeft = 0,
        AnchorRight = 1,
        TextureUrl = "res://img.png",
        Modulate = new MirrorColor(1, 1, 1, 1, "#ffffffff"),
        Text = new MirrorText("hi", null, null, null, null, null, 0),
        Font = new MirrorFont("F", "res://f.ttf", null, null),
        SpineAnimations = ["idle"],
    };

    // Seed a fresh state with `baseNode` (as a keyframe add), then clear the change accumulators — so the next
    // ApplyAndFlag reflects ONLY that delta's classification.
    private static MirrorState Seed(MirrorNode baseNode)
    {
        var state = MirrorState.Create();
        SceneTreeApplier.ApplySceneDelta(state, new MirrorDelta { Full = true, Upserts = [baseNode], OrderedIds = [baseNode.Id] });
        state.ChangedIds.Clear();
        state.ChangeFlags.Clear();
        return state;
    }

    // A VOLATILE-only upsert (empty Name) cloned from `from` with a single field mutated → merges onto the retained
    // static styling, so only the mutated volatile field(s) diff.
    private static MirrorNode Vol(MirrorNode from, Action<MirrorNode> mutate)
    {
        var v = from.Clone();
        v.Name = "";
        mutate(v);
        return v;
    }

    // A STATIC-bearing upsert (Name kept) cloned from `from` with a static field mutated.
    private static MirrorNode Static(MirrorNode from, Action<MirrorNode> mutate)
    {
        var v = from.Clone();
        mutate(v);
        return v;
    }

    private static NodeChangeFlags ApplyAndFlag(MirrorState state, MirrorNode upsert, bool full = false)
    {
        SceneTreeApplier.ApplySceneDelta(state, new MirrorDelta { Full = full, Upserts = [upsert], OrderedIds = full ? [upsert.Id] : null });
        return state.ChangeFlags.TryGetValue(upsert.Id, out var f) ? f : NodeChangeFlags.None;
    }
}
