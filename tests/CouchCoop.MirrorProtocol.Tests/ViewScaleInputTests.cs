using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R2 (WS-G2) view-scale input-remap GATE truth table for the pure ViewScaleInput.Remap. A design pointer is EXEMPT
// from a stamp's inverse remap (→ identity, it belongs to an un-scaled neighbour) iff a neighbour rect contains it AND
// (the stamp is a GROUP OR the point is outside the item's own OriginalBox). Otherwise a point inside the ScaledBox is
// inverse-mapped; a point outside every ScaledBox is identity.
internal static class ViewScaleInputTests
{
    private const double W = 1920, H = 1080;

    public static void Run()
    {
        // Item stamp: box 100×100 at [100,100], scale 1.5 about centre (150,150) → ScaledBox [75,75,225,225].
        var channel = HoverTipScaleMath.ComputeCenterStamp(new DesignAabb(100, 100, 200, 200), 1.5, W, H)!.Value;
        var original = new DesignAabb(100, 100, 200, 200);
        var scaled = new DesignAabb(75, 75, 225, 225);

        // A neighbour rect sitting in the RIGHT halo band (x 210..260 overlaps ScaledBox to 225).
        var rightHaloNeighbor = new DesignAabb(210, 140, 260, 160);
        // A neighbour rect that also covers an INTERIOR point (110..140) — only matters for a GROUP stamp.
        var interiorNeighbor = new DesignAabb(110, 110, 140, 140);

        EmptyRegistryIsIdentity();
        OutsideAllScaledBoxesIsIdentity(channel, original, scaled);
        ItemFaceAlwaysRemaps(channel, original, scaled, interiorNeighbor);
        ItemHaloWithoutNeighborRemaps(channel, original, scaled);
        ItemHaloOnNeighborIsExempt(channel, original, scaled, rightHaloNeighbor);
        GroupInteriorOnOverlayNeighborIsExempt(channel, original, scaled, interiorNeighbor);
        GroupInteriorWithoutNeighborRemaps(channel, original, scaled);
        NestedItemFaceUsesOwnUnscaledBox(channel, original, scaled);
    }

    private static void EmptyRegistryIsIdentity()
    {
        var (x, y) = ViewScaleInput.Remap(150, 150, Array.Empty<ViewScaleInput.Stamp>());
        Check.Close(x, 150, "empty registry → identity X");
        Check.Close(y, 150, "empty registry → identity Y");
    }

    // A point outside every ScaledBox is untouched (byte-identical to the no-view-scale path).
    private static void OutsideAllScaledBoxesIsIdentity(HoverTipScaleMath.Stamp ch, DesignAabb original, DesignAabb scaled)
    {
        var reg = One(ch, scaled, original, isGroup: false);
        var (x, y) = ViewScaleInput.Remap(500, 500, reg);
        Check.Close(x, 500, "outside ScaledBox → identity X");
        Check.Close(y, 500, "outside ScaledBox → identity Y");
    }

    // A point on the ITEM's own face (inside OriginalBox) always remaps, even when a neighbour also covers it.
    private static void ItemFaceAlwaysRemaps(
        HoverTipScaleMath.Stamp ch, DesignAabb original, DesignAabb scaled, DesignAabb interiorNeighbor)
    {
        var reg = One(ch, scaled, original, isGroup: false, interiorNeighbor);
        var (x, y) = ViewScaleInput.Remap(120, 120, reg);
        // Inverse: q = P + (p−P)/k = 150 + (120−150)/1.5 = 130.
        Check.Close(x, 130, "item face → inverse-remapped X (not identity)");
        Check.Close(y, 130, "item face → inverse-remapped Y");
    }

    // A point in the halo band with NO neighbour there still remaps (nothing to exempt to).
    private static void ItemHaloWithoutNeighborRemaps(HoverTipScaleMath.Stamp ch, DesignAabb original, DesignAabb scaled)
    {
        var reg = One(ch, scaled, original, isGroup: false);
        var (x, _) = ViewScaleInput.Remap(215, 150, reg);
        // 215 is outside OriginalBox (100..200) but inside ScaledBox → remaps: 150 + (215−150)/1.5 ≈ 193.3.
        Check.That(Math.Abs(x - 193.333) < 0.01, "halo without neighbour → remapped (not exempt)");
    }

    // A point in the halo band ON an un-scaled neighbour is EXEMPT → identity (the R2 fix: a tap aimed at the Skip
    // button / banner sitting in a scaled card's halo lands where the game draws it).
    private static void ItemHaloOnNeighborIsExempt(
        HoverTipScaleMath.Stamp ch, DesignAabb original, DesignAabb scaled, DesignAabb neighbor)
    {
        var reg = One(ch, scaled, original, isGroup: false, neighbor);
        var (x, y) = ViewScaleInput.Remap(215, 150, reg);
        Check.Close(x, 215, "halo on neighbour → identity X (exempt)");
        Check.Close(y, 150, "halo on neighbour → identity Y (exempt)");
    }

    // A GROUP stamp exempts an INTERIOR point covered by an OVERLAY neighbour. The neighbour here models an un-scaled
    // overlay drawn ON TOP of the scaled group (a TopBar deck/gold button) — ViewScaleInputRegistry guarantees the
    // registry only ever hands Remap such overlays as group neighbours, NEVER the group's ancestors/backdrops (which
    // would exempt every interior tap → the R5 bug). Given a genuine overlay covering the point, the tap stays identity
    // so the game hit-tests the overlay in place.
    private static void GroupInteriorOnOverlayNeighborIsExempt(
        HoverTipScaleMath.Stamp ch, DesignAabb original, DesignAabb scaled, DesignAabb overlayNeighbor)
    {
        var reg = One(ch, scaled, original, isGroup: true, overlayNeighbor);
        var (x, y) = ViewScaleInput.Remap(120, 120, reg);
        Check.Close(x, 120, "group interior on overlay neighbour → identity X (exempt)");
        Check.Close(y, 120, "group interior on overlay neighbour → identity Y (exempt)");
    }

    // A GROUP interior point with NO neighbour still remaps (a tap on the group's own scaled content).
    private static void GroupInteriorWithoutNeighborRemaps(HoverTipScaleMath.Stamp ch, DesignAabb original, DesignAabb scaled)
    {
        var reg = One(ch, scaled, original, isGroup: true);
        var (x, _) = ViewScaleInput.Remap(120, 120, reg);
        Check.Close(x, 130, "group interior without neighbour → remapped");
    }

    // A nested card's face has already moved through its enclosing group before its own enlargement. The old
    // OriginalBox-only exemption check called this displayed face a halo and gave an overlay the tap; OwnUnscaledBox
    // preserves the item's ownership until its own scale boundary.
    private static void NestedItemFaceUsesOwnUnscaledBox(HoverTipScaleMath.Stamp ch, DesignAabb original, DesignAabb scaled)
    {
        var displayedFace = new DesignAabb(80, 80, 220, 220);
        var overlay = new DesignAabb(85, 100, 105, 120);
        var reg = new[] { new ViewScaleInput.Stamp(ch, scaled, original, IsGroup: false, new[] { overlay }, displayedFace) };
        var (x, y) = ViewScaleInput.Remap(90, 110, reg);
        Check.That(Math.Abs(x - 90) > 0.01 || Math.Abs(y - 110) > 0.01,
            "nested item displayed face remaps even when an overlay covers it");
    }

    private static IReadOnlyList<ViewScaleInput.Stamp> One(
        HoverTipScaleMath.Stamp ch, DesignAabb scaled, DesignAabb original, bool isGroup, params DesignAabb[] neighbors) =>
        new[] { new ViewScaleInput.Stamp(ch, scaled, original, isGroup, neighbors) };
}
