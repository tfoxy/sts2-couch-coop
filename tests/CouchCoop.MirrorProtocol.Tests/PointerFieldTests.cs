using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// OWNER: WS-Q (widened input). Port of frontend/src/mirror/__tests__/pointerMap.spec.ts `describe("mapPointerToGame")`
// against Input/PointerField.cs. The web DOM fixtures (mkEl + stubbed elementsFromPoint) are re-expressed as
// MirrorState node trees + hand-built SpreadRecords: where the web relied on the stub returning an element regardless
// of position, the native port hit-tests the RENDERED box, so each painter's GAME rect (transform + localRect) is
// placed so its rendered box (game box +Dx / widened to RenderedWidth) contains the design pointer. Records are
// injected directly (no dependency on WS-P's SpreadIndex walk — see the Func<string,SpreadRecord?> lookup). Design
// coords are the web's fraction·designWidth precomputed (a centered 0.5 fraction → 960 at 1920, 1260 at 2520).
internal static class PointerFieldTests
{
    private const double Dw2520 = 2520;
    private static readonly double SqueezeA = 1920.0 / 2520.0; // ≈ 0.7619 — the field squeeze at designWidth 2520

    public static void Run()
    {
        SixteenNineIdentity();
        AnchoredPainterSubtractsTranslation();
        PropPainterExactHitSqueezeAffine();
        OversizedPropPainterUsesSqueeze();
        DemotesFullStageVignette();
        SkipsTransparentOverlay();
        SqueezesWidenedBackdrop();
        DeadSpaceUniformSqueeze();
        ClampsResolvedCoord();
        AncestorHiddenPainterSkipped();
        ClippedAwayPainterSkipped();
        WidenedClipAncestorAnchorsRightZonePainter();
        ViewScaleHaloInverseComposes();
    }

    // #19 input inverse, coordinate level: the InputRouter runs ViewScale.InverseMapPoint on the design pointer BEFORE
    // PointerField. On a 16:9 stage MapPointerToGame is the identity, so a RAW halo point (x=205, beyond the item's
    // true rect …200) maps to a game X outside the item, while the inverse-corrected point maps inside it — the
    // coordinate twin of the TouchTargetScan halo case.
    private static void ViewScaleHaloInverseComposes()
    {
        var state = MirrorState.Create();
        var index = new GlobalTransformIndex();
        var box = new DesignAabb(100, 100, 200, 200); // item true rect; scaled 1.2× about (150,150)
        var stamp = HoverTipScaleMath.ComputeCenterStamp(box, 1.2, 1920, 1080)!.Value;

        var raw = PointerField.MapPointerToGame(state, index, _ => null, 205, 150, 1920);
        Check.That(raw.CoordX > 200, "raw halo point maps outside the item's true rect on 16:9");

        var (ix, iy) = ViewScale.InverseMapPoint(stamp, 205, 150);
        var corrected = PointerField.MapPointerToGame(state, index, _ => null, ix, iy, 1920);
        Check.That(corrected.CoordX >= 100 && corrected.CoordX <= 200, "inverse-corrected halo point maps inside the item's true rect");
    }

    // ---- fixtures ----

    private static MirrorNode Ctrl(
        string id,
        double gx,
        double gy,
        double w,
        double h,
        string? parent = null,
        int clip = 0,
        bool visible = true) =>
        new()
        {
            Id = id,
            ParentId = parent,
            NodeType = "Control",
            Visible = visible,
            ClipChildren = clip,
            Transform = [1, 0, 0, 1, gx, gy],
            LocalRect = new MirrorRect(0, 0, w, h),
        };

    private static SpreadRecord Rec(double dx, bool prop, bool paints, double renderedWidth = 0) =>
        new(dx, renderedWidth, prop, paints);

    // Build state + globals + a record lookup from a DRAW-ORDER (bottom→top) list. The reversed-OrderedIds z-query
    // visits the LAST item (topmost) first — the web stub's first arg.
    private static (MirrorState State, GlobalTransformIndex T, Func<string, SpreadRecord?> Lookup) Build(
        params (MirrorNode Node, SpreadRecord? Rec)[] items)
    {
        var state = MirrorState.Create();
        var records = new Dictionary<string, SpreadRecord>(StringComparer.Ordinal);
        foreach (var (node, rec) in items)
        {
            state.Nodes[node.Id] = node;
            state.OrderedIds.Add(node.Id);
            state.ChangedIds.Add(node.Id);
            if (rec is { } r)
            {
                records[node.Id] = r;
            }
        }

        state.Revision++;
        var t = new GlobalTransformIndex();
        t.Update(state);
        return (state, t, id => records.TryGetValue(id, out var v) ? v : null);
    }

    private static PointerField.PointerMapping Map(
        (MirrorState State, GlobalTransformIndex T, Func<string, SpreadRecord?> Lookup) s,
        double designX,
        double designY,
        double designWidth) =>
        PointerField.MapPointerToGame(s.State, s.T, s.Lookup, designX, designY, designWidth);

    // ---- tests ----

    // 16:9 — design space IS game space; identity affine, zero scene work (even a painting prop node is ignored).
    private static void SixteenNineIdentity()
    {
        var s = Build((Ctrl("w", 100, 100, 200, 100), Rec(300, prop: true, paints: true)));
        var m = Map(s, designX: 960, designY: 540, designWidth: 1920);
        Check.Close(m.CoordX, 960, "16:9 coordX == designX");
        Check.Close(m.CoordY, 540, "16:9 coordY");
        Check.Close(m.Shift, 0, "16:9 shift 0");
        Check.Close(m.DesignX, 960, "16:9 designX");
        Check.Close(m.Affine.A, 1, "16:9 affine.a identity");
        Check.Close(m.Affine.B, 0, "16:9 affine.b identity");
    }

    // An ANCHORED painter subtracts its translation and returns a translation affine {1, -dx}.
    private static void AnchoredPainterSubtractsTranslation()
    {
        // Rendered box = game [900,1100] +300 = [1200,1400] contains designX 1260; game box contains (960, 540).
        var s = Build((Ctrl("w", 900, 490, 200, 100), Rec(300, prop: false, paints: true)));
        var m = Map(s, 1260, 540, Dw2520);
        Check.Close(m.CoordX, 960, "anchored coordX = 1260 - 300");
        Check.Close(m.CoordY, 540, "anchored coordY");
        Check.Close(m.Shift, 300, "anchored shift = dx");
        Check.Close(m.Affine.A, 1, "anchored affine.a = 1");
        Check.Close(m.Affine.B, -300, "anchored affine.b = -dx");
    }

    // A PROP painter resolves the exact hit coord (designX - dx) but returns the whole-world SQUEEZE affine.
    private static void PropPainterExactHitSqueezeAffine()
    {
        var s = Build((Ctrl("c", 1000, 490, 200, 100), Rec(240, prop: true, paints: true)));
        var m = Map(s, 1260, 540, Dw2520);
        Check.Close(m.CoordX, 1020, "prop exact hit = 1260 - 240");
        Check.Close(m.Affine.A, SqueezeA, "prop frozen field is the squeeze", 1e-10);
        Check.Close(m.Affine.B, 0, "prop affine.b 0");
    }

    // An oversized (>60% stage) PROP painter resolves via the squeeze, not its own translation.
    private static void OversizedPropPainterUsesSqueeze()
    {
        // ownWidth 1600 > 0.6·2520 (1512) but < 0.95·2520 (2394); game [0,1600] contains (760,540).
        var s = Build((Ctrl("bg", 0, 0, 1600, 540), Rec(500, prop: true, paints: true)));
        var m = Map(s, 1260, 540, Dw2520);
        Check.Close(m.CoordX, 960, "oversized prop → squeeze 1260·1920/2520"); // translation would give 760
        Check.Close(m.Affine.A, SqueezeA, "oversized prop affine.a squeeze", 1e-10);
        Check.Close(m.Affine.B, 0, "oversized prop affine.b 0");
    }

    // Demotes a painting full-stage vignette so content beneath it decides the map.
    private static void DemotesFullStageVignette()
    {
        // vignette topmost (drawn LAST), width-stretched (RenderedWidth 2520) → a backdrop, skipped.
        var vignette = (Ctrl("v", 0, 0, 1920, 1080), (SpreadRecord?)Rec(0, prop: false, paints: true, renderedWidth: 2520));
        var content = (Ctrl("c", 1000, 490, 200, 100), (SpreadRecord?)Rec(240, prop: false, paints: true));
        var s = Build(content, vignette); // draw order bottom→top: content then vignette
        var m = Map(s, 1260, 540, Dw2520);
        Check.Close(m.CoordX, 1020, "vignette demoted; content +240 wins");
        Check.Close(m.Shift, 240, "content shift 240");
    }

    // Skips a transparent (non-painting) overlay and maps through the painter beneath.
    private static void SkipsTransparentOverlay()
    {
        var overlay = (Ctrl("o", 0, 0, 960, 540), (SpreadRecord?)Rec(0, prop: false, paints: false));
        var painter = (Ctrl("p", 900, 490, 200, 100), (SpreadRecord?)Rec(300, prop: false, paints: true));
        var s = Build(painter, overlay); // overlay topmost
        var m = Map(s, 1260, 540, Dw2520);
        Check.Close(m.CoordX, 960, "transparent overlay skipped; painter +300 → 960");
    }

    // Squeezes a widened backdrop (the only painter) via the uniform field.
    private static void SqueezesWidenedBackdrop()
    {
        // RenderedWidth override (1400) → the backdrop rule skips it after containment; loop exhausts → uniform squeeze.
        var s = Build((Ctrl("bg", 0, 0, 600, 1080), Rec(200, prop: false, paints: true, renderedWidth: 1400)));
        var m = Map(s, 1260, 540, Dw2520);
        Check.Close(m.CoordX, 960, "widened backdrop → uniform squeeze");
        Check.Close(m.Affine.A, SqueezeA, "backdrop squeeze affine.a", 1e-10);
        Check.Close(m.Affine.B, 0, "backdrop squeeze affine.b 0");
    }

    // Falls back to a uniform squeeze in dead space (nothing painting).
    private static void DeadSpaceUniformSqueeze()
    {
        var s = Build((Ctrl("x", 0, 0, 960, 540), Rec(300, prop: false, paints: false)));
        var m = Map(s, 1260, 540, Dw2520);
        Check.Close(m.CoordX, 960, "dead space → uniform squeeze 1260·1920/2520");
        Check.Close(m.Affine.A, SqueezeA, "dead-space squeeze affine.a", 1e-10);
        Check.Close(m.Shift, 300, "dead-space shift = 1260 - 960");
    }

    // Clamps the resolved coordinate to [0, 1920].
    private static void ClampsResolvedCoord()
    {
        // dx 2000 → 1260 - 2000 = -740 → clamped to 0. Rendered box [1200,1400] contains designX 1260.
        var lo = Build((Ctrl("lo", -800, 490, 200, 100), Rec(2000, prop: false, paints: true)));
        Check.Close(Map(lo, 1260, 540, Dw2520).CoordX, 0, "coordX clamped to 0");

        // dx -2000 → 1260 + 2000 = 3260 → clamped to 1920. Rendered box [1200,1400] contains designX 1260.
        var hi = Build((Ctrl("hi", 3200, 490, 200, 100), Rec(-2000, prop: false, paints: true)));
        Check.Close(Map(hi, 1260, 540, Dw2520).CoordX, 1920, "coordX clamped to 1920");
    }

    // NATIVE addition (the z-query replaces elementsFromPoint's display:none semantics): an ancestor-hidden painter is
    // skipped, so the map falls through to the uniform squeeze rather than the painter's anchored coord.
    private static void AncestorHiddenPainterSkipped()
    {
        var hiddenGroup = (Ctrl("group", 0, 0, 1920, 1080, visible: false), (SpreadRecord?)null);
        // Would resolve to 1020 (anchored, dx 240) if visible; the hidden ancestor forces the squeeze fallback (960).
        var child = (Ctrl("child", 1000, 490, 200, 100, parent: "group"), (SpreadRecord?)Rec(240, prop: false, paints: true));
        var s = Build(hiddenGroup, child);
        var m = Map(s, 1260, 540, Dw2520);
        Check.Close(m.CoordX, 960, "ancestor-hidden painter skipped → uniform squeeze (not 1020)");
        Check.Close(m.Affine.A, SqueezeA, "fallback squeeze affine", 1e-10);
    }

    // NATIVE addition: a painter clipped away by a clip-children ancestor whose rendered box does NOT contain the
    // pointer can't anchor — the map falls through past it.
    private static void ClippedAwayPainterSkipped()
    {
        // clip parent box [0,100]×[0,100] does NOT contain the pointer; the child's OWN box [1200,1400] does.
        var clip = (Ctrl("clip", 0, 0, 100, 100, clip: 1), (SpreadRecord?)null);
        var child = (Ctrl("kid", 1200, 490, 200, 100, parent: "clip"), (SpreadRecord?)Rec(0, prop: false, paints: true));
        var s = Build(clip, child);
        var m = Map(s, 1260, 540, Dw2520);
        Check.Close(m.CoordX, 960, "clipped-away painter skipped → uniform squeeze");
        Check.Close(m.Affine.A, SqueezeA, "fallback squeeze affine", 1e-10);
    }

    // #10: an anchored child painter (dx 240 → game 1020) inside a horizontally-stretched clip (streamed width 1000,
    // anchor-widened RenderedWidth 1400). Design pointer 1260: the child's rendered box [1160,1360] contains it, but
    // the clip's STREAMED box [0,1000] does not (1260 > 1000) — only its WIDENED box [0,1400] does. WITH the override
    // the child anchors the map (1020); WITHOUT it the child is clip-rejected and the map falls through to the uniform
    // squeeze (960). This is the primary #10 failure (the rightmost grid column resolves to the wrong game X).
    private static void WidenedClipAncestorAnchorsRightZonePainter()
    {
        MirrorNode Clip() => new()
        {
            Id = "clip",
            ParentId = null,
            NodeType = "ScrollContainer",
            Visible = true,
            ClipChildren = 1,
            Transform = [1, 0, 0, 1, 0, 0],
            LocalRect = new MirrorRect(0, 0, 1000, 1080),
        };

        var widened = Build(
            (Clip(), Rec(0, prop: false, paints: false, renderedWidth: 1400)),
            (Ctrl("c", 920, 490, 200, 100, parent: "clip"), Rec(240, prop: false, paints: true)));
        Check.Close(Map(widened, 1260, 540, Dw2520).CoordX, 1020, "widened clip → child anchors (1260 − 240)");

        var streamed = Build(
            (Clip(), Rec(0, prop: false, paints: false, renderedWidth: 0)),
            (Ctrl("c", 920, 490, 200, 100, parent: "clip"), Rec(240, prop: false, paints: true)));
        Check.Close(Map(streamed, 1260, 540, Dw2520).CoordX, 960, "streamed clip → child clip-rejected → uniform squeeze");
    }
}
