using CouchCoop.MirrorProtocol.Input;

namespace CouchCoop.MirrorProtocol.SceneModel;

// R5 (H2): resolve a HoverTip's VISUAL owner id — the on-screen thing the tip points at — from its streamed
// AnchorOwnerId. STS2 anchors a hand-card tip to the card's NHandCardHolder, a ZERO-SIZE node whose own wide-screen
// claim rides its transform ORIGIN, not the focused card's center. A floater glued to the holder therefore drifts
// from the card at F≠1. This pure resolver maps the anchor owner to the card the user actually sees so both the
// SpreadIndex floater branch (its Dx) and HoverTipScaler.MeasureOwner (its box + growth side) glue to the same
// visual node.
//
// Resolution order (documented contract — a one-frame record lag on the resolved node is acceptable, the walk reads
// last drain's record for a not-yet-walked node exactly like the owner-floater override always has):
//   (i)   owner has a positive-width LocalRect        → the owner IS a real box → itself.
//   (ii)  owner is 0×0 (an NHandCardHolder anchor)     → its FIRST painting descendant with a positive box, in draw
//                                                        order (OrderedIds) — the focused card the holder positions.
//   (iii) no painting descendant (card grabbed out)    → hit-test the owner's ORIGIN point over the interactive rects
//                                                        (topmost painter wins, the HitTestShift pattern).
//   (iv)  nothing resolved                             → the original owner id (caller keeps its missing-record path).
// The owner KIND (growth side) always keeps using the ORIGINAL owner id (a holder is still a "hand card").
public static class TipOwnerResolve
{
    public static string ResolveVisualOwnerId(
        MirrorState state,
        GlobalTransformIndex transforms,
        SpreadIndex spread,
        string ownerId)
    {
        if (!state.Nodes.TryGetValue(ownerId, out var owner))
        {
            return ownerId; // unknown owner — caller handles the missing-record fallback
        }

        // (i) a real positive-width box → the owner is itself the visual anchor.
        if (owner.LocalRect is { Width: > 0 })
        {
            return ownerId;
        }

        // (ii) a 0×0 anchor node → its first painting descendant with a positive box, in draw order.
        foreach (var id in state.OrderedIds)
        {
            if (id == ownerId || !state.Nodes.TryGetValue(id, out var n))
            {
                continue;
            }

            if (n.LocalRect is { Width: > 0 } && Paints(n) && IsDescendantOf(state, id, ownerId))
            {
                return id;
            }
        }

        // (iii) no painting descendant → hit-test the owner's origin point over the interactive rects (topmost last).
        if (transforms.TryGetGlobal(ownerId, out var g))
        {
            double px = g[4], py = g[5];
            string? hit = null;
            foreach (var r in InteractiveRectScan.Collect(state, transforms, spread))
            {
                if (r.Id == ownerId)
                {
                    continue;
                }

                var inv = Affine.Inverse(Affine.NodeMatrix(r.Global, r.LocalRect.X, r.LocalRect.Y));
                if (inv is null)
                {
                    continue;
                }

                double lx = (inv[0] * px) + (inv[2] * py) + inv[4];
                double ly = (inv[1] * px) + (inv[3] * py) + inv[5];
                if (lx >= 0 && lx <= r.LocalRect.Width && ly >= 0 && ly <= r.LocalRect.Height)
                {
                    hit = r.Id; // topmost painter under the owner origin
                }
            }

            if (hit is not null)
            {
                return hit;
            }
        }

        // (iv) nothing resolved → the original owner.
        return ownerId;
    }

    // A node draws visible own content (a texture / rich-or-plain text run / a filled fill_color / a live spine clip /
    // a nine-patch) — the subset of nodePaintsContent a tip's visual card would satisfy. Kept local so the resolver
    // stays a single pure file.
    private static bool Paints(MirrorNode n)
    {
        if (!n.Visible)
        {
            return false;
        }

        if (n.Text is { Text.Length: > 0 })
        {
            return true;
        }

        if (n.SpineSceneResPath is not null && !string.IsNullOrEmpty(n.SpineCurrentAnim))
        {
            return true;
        }

        if (n.NinePatch || n.FillColor is { A: > 0.02 })
        {
            return true;
        }

        return n.TextureUrl is not null && n.ParticleSpec is null;
    }

    // True when `id` is a descendant of `ancestorId` (walking ParentId up; bounded against a cyclic chain).
    private static bool IsDescendantOf(MirrorState state, string id, string ancestorId)
    {
        var cur = state.Nodes.TryGetValue(id, out var node) ? node.ParentId : null;
        int guard = 0;
        while (cur is not null && guard++ < 256)
        {
            if (cur == ancestorId)
            {
                return true;
            }

            cur = state.Nodes.TryGetValue(cur, out var parent) ? parent.ParentId : null;
        }

        return false;
    }
}
