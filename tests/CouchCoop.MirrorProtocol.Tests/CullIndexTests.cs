using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for the fill-reduction cull math (CullBounds AABB + CullIndex decisions). Covers: corner-AABB under
// rotation / non-uniform scale, the margin-inflated FullyOutside test, unknown-bounds refusal, self-paint offscreen
// cull + effect/clip exemptions, subtree-union culling and its blockers, exact zero-alpha + shader block, the widened
// design-rect (spread factor), tween-uncertain refusal, and incremental re-evaluation of a moved parent's descendants.
internal static class CullIndexTests
{
    public static void Run()
    {
        OfRectIdentityAndTranslate();
        OfRectNonUniformScale();
        OfRectRotationExpandsAabb();
        FullyOutsideEdgesAndMargin();
        UnknownBoundsNeverCulled();
        SelfPaintOffscreenCull();
        SelfPaintWithOnscreenDescendant();
        EffectBearingExemptFromSelfCull();
        ClipNodeExemptFromSelfCull();
        SubtreeOffscreenUnion();
        SubtreeKeptWhenAnyChildOnscreen();
        SubtreeBlockedByUnknownBoundsDescendant();
        SubtreeBlockedByEffectDescendant();
        ZeroAlphaSubtreeCull();
        ZeroAlphaBlockedByShaderInSubtree();
        ZeroAlphaIsExactNotEpsilon();
        WidenedDesignRectUnCulls();
        BoundsUncertainRefusesCull();
        IncrementalMovedParentReEvaluatesDescendants();
        RemovedNodeDropsDecisionCount();
        DanglingParentAncestorWalk();
    }

    private const double Width = 1920;
    private const double Margin = 128;

    // ---- CullBounds AABB math -----------------------------------------------------------------------------------

    private static void OfRectIdentityAndTranslate()
    {
        var id = CullBounds.OfRect([1, 0, 0, 1, 0, 0], 10, 20, 30, 40);
        Check.Close(id.MinX, 10, "identity minX");
        Check.Close(id.MinY, 20, "identity minY");
        Check.Close(id.MaxX, 40, "identity maxX");
        Check.Close(id.MaxY, 60, "identity maxY");

        var t = CullBounds.OfRect([1, 0, 0, 1, 100, 200], 10, 20, 30, 40);
        Check.Close(t.MinX, 110, "translate minX");
        Check.Close(t.MaxY, 260, "translate maxY");
    }

    private static void OfRectNonUniformScale()
    {
        // scale x2 / y3 about origin, box (10,10,5,5) → x∈[20,30], y∈[30,45].
        var s = CullBounds.OfRect([2, 0, 0, 3, 0, 0], 10, 10, 5, 5);
        Check.Close(s.MinX, 20, "scale minX");
        Check.Close(s.MaxX, 30, "scale maxX");
        Check.Close(s.MinY, 30, "scale minY");
        Check.Close(s.MaxY, 45, "scale maxY");
    }

    private static void OfRectRotationExpandsAabb()
    {
        // 90° rotation [a,b,c,d]=[0,1,-1,0]: X'=-y, Y'=x. Box (0,0,10,20) → X'∈[-20,0], Y'∈[0,10].
        var r = CullBounds.OfRect([0, 1, -1, 0, 0, 0], 0, 0, 10, 20);
        Check.Close(r.MinX, -20, "rot minX");
        Check.Close(r.MaxX, 0, "rot maxX");
        Check.Close(r.MinY, 0, "rot minY");
        Check.Close(r.MaxY, 10, "rot maxY");
    }

    private static void FullyOutsideEdgesAndMargin()
    {
        // A 10×10 box. Right edge: inside until minX passes width+margin.
        Check.That(new DesignAabb(2000, 500, 2010, 510).FullyOutside(Width, CullIndex.DesignHeight, Margin) == false,
            "x=2000 still inside (1920+128=2048)");
        Check.That(new DesignAabb(2060, 500, 2070, 510).FullyOutside(Width, CullIndex.DesignHeight, Margin),
            "x=2060 fully right of 2048 → outside");
        // Left / top / bottom edges.
        Check.That(new DesignAabb(-200, 500, -140, 510).FullyOutside(Width, CullIndex.DesignHeight, Margin),
            "maxX=-140 < -128 → outside left");
        Check.That(new DesignAabb(-140, 500, -100, 510).FullyOutside(Width, CullIndex.DesignHeight, Margin) == false,
            "maxX=-100 within left margin → inside");
        Check.That(new DesignAabb(500, 1220, 510, 1230).FullyOutside(Width, CullIndex.DesignHeight, Margin),
            "minY=1220 > 1080+128=1208 → outside bottom");
        Check.That(new DesignAabb(500, -500, 510, -140).FullyOutside(Width, CullIndex.DesignHeight, Margin),
            "maxY=-140 < -128 → outside top");
        // Straddling the edge is NOT outside.
        Check.That(new DesignAabb(1900, 500, 2100, 510).FullyOutside(Width, CullIndex.DesignHeight, Margin) == false,
            "straddling right edge → inside");
    }

    // ---- CullIndex decisions ------------------------------------------------------------------------------------

    private static void UnknownBoundsNeverCulled()
    {
        var h = new Harness();
        // No LocalRect but paints a texture, placed far off-screen → unknown extent → NEVER culled, and BLOCKS a
        // hypothetical parent cull (paintsUnknown).
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        h.Add(Tex(Node("blob", "root", [1, 0, 0, 1, 9000, 9000])));
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("blob"), CullIndex.Decision.None, "unknown-bounds node never culled");
        Check.Equal(h.Decision("root"), CullIndex.Decision.None, "root not subtree-culled (unknown-bounds child blocks)");
    }

    private static void SelfPaintOffscreenCull()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        h.Add(Rect(Node("on", "root", [1, 0, 0, 1, 100, 100]), 0, 0, 50, 50));
        // A childless off-screen leaf: its whole (1-node) subtree is off-screen → the cheaper Visible=false SUBTREE
        // cull, not self-paint (self-paint is reserved for a node that must keep a live descendant).
        h.Add(Rect(Node("off", "root", [1, 0, 0, 1, 9000, 100]), 0, 0, 50, 50));
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("on"), CullIndex.Decision.None, "on-screen leaf not culled");
        Check.Equal(h.Decision("off"), CullIndex.Decision.SubtreeOffscreen, "off-screen childless leaf → subtree cull");
    }

    // The genuine self-paint case: a node whose OWN box is off-screen but which has an ON-screen descendant (a large
    // negative child offset lands it back in view). The subtree union intersects the screen (so no subtree cull), yet
    // the node's own paint must still be suppressed while the child stays live.
    private static void SelfPaintWithOnscreenDescendant()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        h.Add(Rect(Node("p", "root", [1, 0, 0, 1, 9000, 100]), 0, 0, 50, 50)); // own box x∈[9000,9050] off-screen
        // child local shift −8950 → global x = 9000−8950 = 50 → box x∈[50,100] on-screen.
        h.Add(Rect(Node("c", "p", [1, 0, 0, 1, -8950, 0]), 0, 0, 50, 50));
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("p"), CullIndex.Decision.SelfPaint, "own box off-screen but on-screen child → self-paint cull");
        Check.Equal(h.Decision("c"), CullIndex.Decision.None, "on-screen descendant kept live");
    }

    private static void EffectBearingExemptFromSelfCull()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        var shaderNode = Rect(Node("fx", "root", [1, 0, 0, 1, 9000, 100]), 0, 0, 50, 50);
        shaderNode.ShaderId = "res://shaders/x.gdshader"; // effect-bearing → exempt from self-cull
        h.Add(shaderNode);
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("fx"), CullIndex.Decision.None, "off-screen effect node exempt from self-cull");
    }

    private static void ClipNodeExemptFromSelfCull()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        var clip = Rect(Node("clip", "root", [1, 0, 0, 1, 9000, 100]), 0, 0, 50, 50);
        clip.ClipChildren = 1; // clip-only stencil — suppressing its OWN paint would un-clip the subtree
        h.Add(clip);
        // An on-screen child keeps the subtree union in view (so no whole-subtree cull) — isolating that the clip's
        // own off-screen box is NOT self-cull-suppressed (without the exemption it would be SelfPaint).
        h.Add(Rect(Node("kid", "clip", [1, 0, 0, 1, -8950, 0]), 0, 0, 50, 50));
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("clip"), CullIndex.Decision.None, "clip node exempt from self-cull (keeps its stencil)");
    }

    private static void SubtreeOffscreenUnion()
    {
        var h = new Harness();
        // A pass-through group (no box) whose two painted children are BOTH off-screen (same far region).
        h.Add(Node("grp", null, [1, 0, 0, 1, 9000, 100]));
        h.Add(Rect(Node("a", "grp", [1, 0, 0, 1, 0, 0]), 0, 0, 50, 50));
        h.Add(Rect(Node("b", "grp", [1, 0, 0, 1, 60, 0]), 0, 0, 50, 50));
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("grp"), CullIndex.Decision.SubtreeOffscreen, "group with all-offscreen children → subtree cull");
    }

    private static void SubtreeKeptWhenAnyChildOnscreen()
    {
        var h = new Harness();
        h.Add(Node("grp", null, [1, 0, 0, 1, 0, 0]));
        h.Add(Rect(Node("a", "grp", [1, 0, 0, 1, 9000, 0]), 0, 0, 50, 50)); // off-screen
        h.Add(Rect(Node("b", "grp", [1, 0, 0, 1, 100, 100]), 0, 0, 50, 50)); // on-screen
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("grp"), CullIndex.Decision.None, "group kept — one child on-screen (union intersects)");
        Check.Equal(h.Decision("a"), CullIndex.Decision.SubtreeOffscreen, "the off-screen childless child still culls");
    }

    private static void SubtreeBlockedByUnknownBoundsDescendant()
    {
        var h = new Harness();
        h.Add(Node("grp", null, [1, 0, 0, 1, 9000, 100]));
        h.Add(Rect(Node("a", "grp", [1, 0, 0, 1, 0, 0]), 0, 0, 50, 50)); // known, off-screen
        h.Add(Tex(Node("u", "grp", [1, 0, 0, 1, 60, 0]))); // paints, NO box → unknown → blocks
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("grp"), CullIndex.Decision.None, "unknown-bounds descendant blocks subtree cull");
        Check.Equal(h.Decision("a"), CullIndex.Decision.SubtreeOffscreen, "the bounded off-screen childless child still culls");
        Check.Equal(h.Decision("u"), CullIndex.Decision.None, "the unknown-bounds descendant never culls");
    }

    private static void SubtreeBlockedByEffectDescendant()
    {
        var h = new Harness();
        h.Add(Node("grp", null, [1, 0, 0, 1, 9000, 100]));
        h.Add(Rect(Node("a", "grp", [1, 0, 0, 1, 0, 0]), 0, 0, 50, 50));
        var fx = Rect(Node("p", "grp", [1, 0, 0, 1, 60, 0]), 0, 0, 50, 50);
        fx.ShaderId = "res://shaders/x.gdshader"; // effect → overflows its rect → blocks subtree cull
        h.Add(fx);
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("grp"), CullIndex.Decision.None, "effect descendant blocks subtree cull");
    }

    private static void ZeroAlphaSubtreeCull()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        var faded = Rect(Node("fade", "root", [1, 0, 0, 1, 100, 100]), 0, 0, 50, 50);
        faded.Modulate = new MirrorColor(1, 1, 1, 0, "#ffffff00"); // ON-screen but fully transparent
        h.Add(faded);
        h.Add(Rect(Node("child", "fade", [1, 0, 0, 1, 0, 0]), 0, 0, 50, 50));
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("fade"), CullIndex.Decision.SubtreeZeroAlpha, "alpha-0 subtree → zero-alpha cull");
    }

    private static void ZeroAlphaBlockedByShaderInSubtree()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        var faded = Rect(Node("fade", "root", [1, 0, 0, 1, 100, 100]), 0, 0, 50, 50);
        faded.Modulate = new MirrorColor(1, 1, 1, 0, "#ffffff00");
        h.Add(faded);
        var sh = Rect(Node("shchild", "fade", [1, 0, 0, 1, 0, 0]), 0, 0, 50, 50);
        sh.ShaderId = "res://shaders/x.gdshader"; // a custom shader may ignore modulate → do NOT hide the subtree
        h.Add(sh);
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("fade"), CullIndex.Decision.None, "shader in subtree blocks zero-alpha cull");
    }

    private static void ZeroAlphaIsExactNotEpsilon()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        var almost = Rect(Node("almost", "root", [1, 0, 0, 1, 100, 100]), 0, 0, 50, 50);
        almost.Modulate = new MirrorColor(1, 1, 1, 0.001, "#ffffff00"); // mid-fade, not exactly 0
        h.Add(almost);
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("almost"), CullIndex.Decision.None, "alpha 0.001 (mid-fade) is NOT zero-alpha culled");
    }

    private static void WidenedDesignRectUnCulls()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        h.Add(Rect(Node("edge", "root", [1, 0, 0, 1, 2100, 100]), 0, 0, 50, 50)); // x∈[2100,2150]
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("edge"), CullIndex.Decision.SubtreeOffscreen, "x=2100 off-screen at 1920 → culled");

        // Widen the design rect to 2520 (wide window): 2150 < 2520+128 → now on-screen → un-culled. No node changed;
        // the width change alone must force a full re-evaluation.
        h.DesignWidth = 2520;
        h.Run();
        Check.Equal(h.Decision("edge"), CullIndex.Decision.None, "widened design rect un-culls the edge node");
    }

    private static void BoundsUncertainRefusesCull()
    {
        var h = new Harness();
        h.Add(Node("grp", null, [1, 0, 0, 1, 9000, 100]));
        h.Add(Rect(Node("tw", "grp", [1, 0, 0, 1, 0, 0]), 0, 0, 50, 50)); // off-screen but transform-tween-owned
        h.MarkAll();
        h.Run(boundsUncertain: new HashSet<string> { "tw" });
        Check.Equal(h.Decision("tw"), CullIndex.Decision.None, "tween-uncertain node not self-culled (streamed pinned)");
        Check.Equal(h.Decision("grp"), CullIndex.Decision.None, "tween-uncertain descendant blocks ancestor subtree cull");
    }

    private static void IncrementalMovedParentReEvaluatesDescendants()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        h.Add(Rect(Node("mid", "root", [1, 0, 0, 1, 100, 100]), 0, 0, 20, 20)); // group-ish with a box
        h.Add(Rect(Node("leaf", "mid", [1, 0, 0, 1, 0, 0]), 0, 0, 20, 20));
        h.MarkAll();
        h.Run();
        Check.Equal(h.Decision("leaf"), CullIndex.Decision.None, "leaf on-screen initially");

        // Move ONLY the parent 'mid' far off-screen (mark just 'mid'); the transform index dirties 'leaf' as a moved
        // descendant, and the cull index must re-derive 'leaf' too (it now rides off-screen with its parent).
        h.State.Nodes["mid"] = Rect(Node("mid", "root", [1, 0, 0, 1, 9000, 100]), 0, 0, 20, 20);
        h.Mark("mid");
        h.Run();
        // The whole mid→leaf branch is now off-screen; the incremental pass must re-derive 'leaf' (a moved descendant
        // it was NOT directly asked to change) as culled, and 'mid' (with an all-offscreen subtree) as a subtree cull.
        Check.Equal(h.Decision("leaf"), CullIndex.Decision.SubtreeOffscreen, "descendant re-evaluated off-screen after parent moved");
        Check.Equal(h.Decision("mid"), CullIndex.Decision.SubtreeOffscreen, "moved parent's whole subtree culls");
    }

    private static void RemovedNodeDropsDecisionCount()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        h.Add(Rect(Node("keep", "root", [1, 0, 0, 1, 100, 100]), 0, 0, 50, 50)); // on-screen → root stays visible
        h.Add(Rect(Node("off", "root", [1, 0, 0, 1, 9000, 100]), 0, 0, 50, 50));
        h.MarkAll();
        h.Run();
        Check.Equal(h.Cull.CulledSubtree, 1L, "one off-screen node counted");

        // Remove the culled node; its decision counter must drop.
        h.State.Nodes.Remove("off");
        h.State.OrderedIds.Remove("off");
        h.Mark("off"); // the removed id rides ChangedIds
        h.Run();
        Check.Equal(h.Cull.CulledSubtree, 0L, "removed node's cull count released");
    }

    // Regression (live-combat KeyNotFoundException): a mid-drain state can hold a child whose ParentId was removed in
    // the SAME drain. The ancestor walk must not admit the dangling parent id into the affected set — doing so made
    // the self-recompute throw and abort the whole cull update for that drain.
    private static void DanglingParentAncestorWalk()
    {
        var h = new Harness();
        h.Add(Node("root", null, [1, 0, 0, 1, 0, 0]));
        h.Add(Rect(Node("mid", "root", [1, 0, 0, 1, 100, 100]), 0, 0, 50, 50));
        h.Add(Rect(Node("leaf", "mid", [1, 0, 0, 1, 10, 10]), 0, 0, 20, 20));
        h.MarkAll();
        h.Run();

        // Same-drain removal of "mid" while "leaf" (still pointing at it) rides ChangedIds → dangling ancestor.
        h.State.Nodes.Remove("mid");
        h.State.OrderedIds.Remove("mid");
        h.Mark("mid", "leaf");
        h.Run(); // pre-fix: KeyNotFoundException out of the ancestor-closed self-recompute
        Check.Equal(h.Decision("leaf"), CullIndex.Decision.None, "leaf survives a dangling-parent drain uncrashed");
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private static MirrorNode Node(string id, string? parent, double[] transform) =>
        new() { Id = id, ParentId = parent, Transform = transform };

    private static MirrorNode Rect(MirrorNode n, double x, double y, double w, double h)
    {
        n.LocalRect = new MirrorRect(x, y, w, h);
        n.FillColor = new MirrorColor(1, 1, 1, 1, "#ffffffff"); // paints something
        return n;
    }

    private static MirrorNode Tex(MirrorNode n)
    {
        n.TextureUrl = "http://x/y.png"; // paints, but no box → unknown extent
        return n;
    }

    private sealed class Harness
    {
        public readonly MirrorState State = MirrorState.Create();
        public readonly GlobalTransformIndex Transforms = new();
        public readonly CullIndex Cull = new();
        public double DesignWidth = Width;

        public Harness()
        {
        }

        public void Add(MirrorNode node)
        {
            State.Nodes[node.Id] = node;
            if (!State.OrderedIds.Contains(node.Id))
            {
                State.OrderedIds.Add(node.Id);
            }
        }

        public void MarkAll()
        {
            State.ChangedIds.Clear();
            foreach (var id in State.Nodes.Keys)
            {
                State.ChangedIds.Add(id);
            }

            State.Revision++;
        }

        public void Mark(params string[] ids)
        {
            State.ChangedIds.Clear();
            foreach (var id in ids)
            {
                State.ChangedIds.Add(id);
            }

            State.Revision++;
        }

        public void Run(IReadOnlySet<string>? boundsUncertain = null)
        {
            bool structural = false; // tests drive incremental transform changes; adds/removes mark explicitly
            Transforms.Update(State);
            Cull.Update(State, Transforms, DesignWidth, Margin, boundsUncertain, structural);
            State.ChangedIds.Clear();
        }

        public CullIndex.Decision Decision(string id) =>
            Cull.TryGetDecision(id, out var d) ? d : CullIndex.Decision.None;
    }
}
