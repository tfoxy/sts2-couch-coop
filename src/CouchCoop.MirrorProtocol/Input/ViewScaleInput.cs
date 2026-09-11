using System.Collections.Generic;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Input;

// R2 (WS-G2) view-scale input REMAP GATE — the pure, Godot-free, Exe-testable core of ViewScaler.InverseRemap.
//
// Round-1 #19 displaced taps: EVERY point inside a scaled item's enlarged "halo" AABB was inverse-mapped toward the
// item's centre, including taps aimed at a NON-scaled neighbour (the Skip button, the banner, an adjacent reward row)
// whose screen area happens to fall inside that halo. R2's gate keeps the remap ONLY for a point that genuinely
// belongs to the scaled item, and leaves a point that belongs to an un-scaled neighbour untouched (identity), so it
// lands where the game draws it.
//
// Gate = PRECOMPUTED NEIGHBOUR-RECT EXCLUSION (exact hit-testing is near-vacuous for a solid item stamp, which paints
// over its whole box). ViewScaleInputRegistry.Build collects, per applied stamp, the interactive rects that overlap
// the stamp's enlarged box, sit outside every stamped subtree, AND survive the four exclusion rules — i.e. the
// un-scaled OVERLAYS drawn ON TOP of the scaled item (a TopBar deck/gold/settings button over a scaled card-reward
// group) plus, for an item stamp, a displaced sibling in the halo band. A neighbour is NEVER an ancestor / full-
// viewport backdrop / anything painted under the item — those enclose the whole stamp, so exempting against them would
// swallow every interior tap (the R5 bug the registry rules fix). A point in the ScaledBox is EXEMPT (→ identity,
// belongs to a neighbour) iff some neighbour rect contains it AND (the stamp is a GROUP — its scaled interior children
// are their own hit surfaces, so an overlay covering an interior point owns that tap — OR the point is OUTSIDE the
// item's own OriginalBox, i.e. in the halo band, not on the item itself). Otherwise the point is on the item →
// inverse-remap. Children of the stamp are NEVER neighbours (they ride the stamp's own inverse).
//
public static class ViewScaleInput
{
    // One applied view-scale stamp as the input gate sees it: the centre-pivot scale CHANNEL (for the inverse map),
    // the enlarged design box the pointer is tested against, the item's PRE-scale design box, whether the stamp is a
    // GROUP (a whole-screen container whose interior children are their own tap surfaces), and the neighbour rects the
    // halo overlaps (spread-folded design boxes of interactive Controls outside every stamped subtree).
    public readonly record struct Stamp(
        HoverTipScaleMath.Stamp Channel,
        DesignAabb ScaledBox,
        DesignAabb OriginalBox,
        bool IsGroup,
        IReadOnlyList<DesignAabb> NeighborRects,
        // A nested item's true face after enclosing stamps but before its OWN stamp. A non-null value prevents an
        // overlay covering that already-group-scaled face from being mistaken for an item-halo neighbour.
        DesignAabb? OwnUnscaledBox = null);

    // Un-map a DESIGN-space pointer landed on an enlarged view-scale item back to its TRUE coordinate. Iterates the
    // registry topmost-first (paint order, topmost last); the first stamp whose ScaledBox contains the point wins:
    // EXEMPT → identity (the point belongs to an un-scaled neighbour), else the exact centre-pivot inverse. Identity
    // when no stamp contains the point (byte-identical to the no-view-scale path).
    public static (double X, double Y) Remap(double x, double y, IReadOnlyList<Stamp> registry)
    {
        for (int i = registry.Count - 1; i >= 0; i--)
        {
            var s = registry[i];
            if (!Contains(s.ScaledBox, x, y))
            {
                continue;
            }

            if (IsExempt(s, x, y))
            {
                return (x, y); // on an un-scaled neighbour sitting in this halo → the game hit-tests it in place
            }

            return ViewScale.InverseMapPoint(s.Channel, x, y);
        }

        return (x, y);
    }

    // A point is exempt from a stamp's inverse remap iff a NEIGHBOUR rect (an un-scaled overlay above the stamp — never
    // an ancestor/backdrop; see ViewScaleInputRegistry) contains it AND the point is not on the item itself: for a
    // GROUP stamp every interior point is a candidate (an overlay covering an interior point owns that tap; the group's
    // own scaled children are never neighbours here), for an ITEM stamp only a point OUTSIDE the item's OriginalBox (in
    // the halo band) qualifies — a point on the item's own face always remaps.
    private static bool IsExempt(Stamp s, double x, double y)
    {
        if (!s.IsGroup && Contains(s.OwnUnscaledBox ?? s.OriginalBox, x, y))
        {
            return false; // on the item's own un-enlarged face → always remap
        }

        foreach (var nb in s.NeighborRects)
        {
            if (Contains(nb, x, y))
            {
                return true;
            }
        }

        return false;
    }

    private static bool Contains(DesignAabb b, double x, double y) =>
        x >= b.MinX && x <= b.MaxX && y >= b.MinY && y <= b.MaxY;
}
