using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R6 card block-scale table (a TextScale sibling): the identity-keyed TRANSFORM scale MirrorNodeView.FoldCosmetic
// folds about the node's own rect centre. Covers the two card blocks (description, type-plaque), the suffix match
// across owning scenes (hand / picker / reward), that the type LABEL itself gets no block scale (it inherits its
// parent TypePlaque's), and the neutral cases. Kept in lockstep with mirrorTextScale.css's transform-scale rules.
internal static class BlockScaleTests
{
    public static void Run()
    {
        DescriptionAndTypePlaqueScale();
        SuffixMatchesAcrossOwningScenes();
        TypeLabelItselfIsNeutral();
        NeutralCases();
        ResolvesViaStateWalk();
        FoldMathIsPivotPreserving();
    }

    // Pure verification of the FoldCosmetic block-scale COMPOSITION (mirrors MirrorNodeView.BlockScaleAboutPivot +
    // its `t = local * M` post-multiply, using plain Godot-convention 2×3 affines so it runs Godot-free). The two
    // load-bearing invariants: (1) the pivot c = the rect centre is FIXED by the block scale (so the block grows
    // about its visual centre, not a corner), and (2) a corner scales outward by exactly k about c — THEN the node's
    // own local transform maps the result (so a rotated/translated card still block-scales in its own frame).
    private static void FoldMathIsPivotPreserving()
    {
        // A card DescriptionLabel: local rect 243×136 (from the recordings) → centre c, block scale k=1.24. Give the
        // node a non-trivial local (translate + a small rotation) to prove the post-multiply stays in the node frame.
        double k = 1.24, cx = 121.5, cy = 68.0;
        double[] m = { k, 0, 0, k, cx * (1 - k), cy * (1 - k) }; // BlockScaleAboutPivot()
        double[] local = Rotate(0.3); // basis rotated 0.3 rad
        local[4] = 400; local[5] = 250; // + translation
        double[] folded = Compose(local, m); // local * M (M applied first — the node's OWN-frame block scale)

        // (1) pivot fixed IN THE LOCAL FRAME: folded(c) == local(c).
        var (fx, fy) = Xform(folded, cx, cy);
        var (lx, ly) = Xform(local, cx, cy);
        Check.That(Math.Abs(fx - lx) < 1e-9 && Math.Abs(fy - ly) < 1e-9,
            "block scale fixes the rect-centre pivot (grows about the block centre, in the node's own frame)");

        // (2) a corner is pushed out by k about c (measured in the node's PRE-local space via M alone).
        var (mx, my) = Xform(m, 0.0, 0.0); // corner (0,0) under M
        Check.That(Math.Abs(mx - (cx * (1 - k))) < 1e-9 && Math.Abs(my - (cy * (1 - k))) < 1e-9,
            "corner (0,0) maps to c + k·((0,0)−c) — a uniform scale-up about the centre");
        // Distance from c scales by exactly k.
        double dPre = Math.Sqrt(cx * cx + cy * cy);
        double dPost = Math.Sqrt((mx - cx) * (mx - cx) + (my - cy) * (my - cy));
        Check.That(Math.Abs(dPost - k * dPre) < 1e-9, "the corner's distance from the pivot scales by exactly k");
    }

    // ---- Godot-convention 2×3 affine helpers (xx,xy,yx,yy,ox,oy): X axis (xx,xy), Y axis (yx,yy), origin (ox,oy) ----
    private static (double, double) Xform(double[] t, double px, double py) =>
        (t[0] * px + t[2] * py + t[4], t[1] * px + t[3] * py + t[5]);

    // Godot Transform2D operator*: (A*B).xform(p) == A.xform(B.xform(p)) — B applied first.
    private static double[] Compose(double[] a, double[] b)
    {
        var (bx0, by0) = (b[0], b[1]);
        var (bx1, by1) = (b[2], b[3]);
        var (bo, boy) = Xform(a, b[4], b[5]);
        return new[]
        {
            a[0] * bx0 + a[2] * by0, a[1] * bx0 + a[3] * by0,
            a[0] * bx1 + a[2] * by1, a[1] * bx1 + a[3] * by1,
            bo, boy,
        };
    }

    private static double[] Rotate(double r) =>
        new[] { Math.Cos(r), Math.Sin(r), -Math.Sin(r), Math.Cos(r), 0.0, 0.0 };

    // The two card blocks: the description label (leaf; scales its own text) → 1.24; the type PLAQUE (bg+child unit)
    // → 1.24 (WS-text round-4 (P5-b): bumped from 1.16 — the font itself stays pinned at 1.0, see TextScale.cs's
    // TypeLabel entry, so byte-identical wrap is unaffected). Title/energy/star are NOT in the block table (they
    // keep font-size scaling) → neutral 1.0.
    private static void DescriptionAndTypePlaqueScale()
    {
        Check.Close(BlockScale.ScaleFor("res://scenes/cards/card.tscn", "CardContainer/DescriptionLabel"),
            1.24, "description block scale 1.24");
        Check.Close(BlockScale.ScaleFor("res://scenes/cards/card.tscn", "CardContainer/TypePlaque"),
            1.24, "WS-text round-4: type plaque block scale bumped to 1.24 (bg + child label as a unit)");
        Check.Close(BlockScale.ScaleFor("res://scenes/cards/card.tscn", "CardContainer/TitleLabel"),
            1.0, "title is NOT block-scaled (keeps font-size scaling)");
        Check.Close(BlockScale.ScaleFor("res://scenes/cards/card.tscn", "CardContainer/EnergyIcon/EnergyLabel"),
            1.0, "energy is NOT block-scaled");
    }

    // The card component folds into many owning scenes with no scene-file scope — the internal suffix must fire in
    // hand (player_hand.tscn over a volatile middle), reward (rewards_screen.tscn), and card.tscn alike.
    private static void SuffixMatchesAcrossOwningScenes()
    {
        Check.Close(BlockScale.ScaleFor("res://scenes/combat/player_hand.tscn", "Card/@Control@42/CardContainer/DescriptionLabel"),
            1.24, "description block scale folded into player_hand.tscn at a longer path");
        Check.Close(BlockScale.ScaleFor("res://scenes/screens/rewards_screen.tscn", "Rows/Row/CardContainer/TypePlaque"),
            1.24, "type plaque block scale folded into rewards_screen.tscn");
    }

    // The TypePlaque/TypeLabel child is NOT itself in the table (the suffix ends at TypePlaque): it inherits its
    // parent plaque's scaled transform natively, so double-scaling it would over-enlarge the text.
    private static void TypeLabelItselfIsNeutral()
    {
        Check.Close(BlockScale.ScaleFor("res://scenes/cards/card.tscn", "CardContainer/TypePlaque/TypeLabel"),
            1.0, "the type LABEL itself is neutral (it inherits TypePlaque's block scale)");
    }

    private static void NeutralCases()
    {
        Check.Close(BlockScale.ScaleFor("res://scenes/whatever.tscn", "Some/Unknown/Path"), 1.0, "unknown → 1.0");
        Check.Close(BlockScale.ScaleFor((string?)null, (string?)null), 1.0, "not-in-scene (null relPath) → 1.0");
    }

    // The (id, state) overload resolves the owning scene via the SceneIdentity walk, then matches — same result as
    // the direct (file, relPath) matcher.
    private static void ResolvesViaStateWalk()
    {
        var state = MirrorState.Create();
        state.Nodes["card"] = new MirrorNode { Id = "card", ParentId = null, Name = "Card", SceneFilePath = "res://scenes/cards/card.tscn" };
        state.Nodes["cc"] = new MirrorNode { Id = "cc", ParentId = "card", Name = "CardContainer" };
        state.Nodes["desc"] = new MirrorNode { Id = "desc", ParentId = "cc", Name = "DescriptionLabel" };
        Check.Close(BlockScale.ScaleFor("desc", state), 1.24, "block scale resolved via the scene-identity walk");
    }
}
