namespace CouchCoop.MirrorProtocol.SceneModel;

using System;
using System.Collections.Generic;

// SHARED paint-order index + geometry/occlusion predicates, extracted verbatim from TextOverlayPlanner so the Track-C
// CardLayerPlanner reuses the EXACT same paint model rather than forking it (a divergence between "which text is safe
// to promote" and "which card is safe to promote" would be a silent correctness hazard). TextOverlayPlanner delegates
// to this type; the existing TextOverlayPlannerTests prove the extraction introduced no drift.
//
// PAINT-ORDER MODEL (unchanged from TextOverlayPlanner's original doc). TextAttachment.Sync re-asserts the "__text"
// child as the LAST child every Sync, so a node's text paints AFTER its whole subtree. In the pre-order OrderedIds
// flatten a node N's subtree is the contiguous run [index(N), subtreeEnd(N)]; a plain self-paint of N happens at
// index(N); a label L's text happens JUST AFTER subtreeEnd(L). Total-ordered paint keys:
//   self-paint of N  →  (index(N),      0, 0)
//   text-paint of L  →  (subtreeEnd(L), 1, -depth(L))
// Index/depth/subtreeEnd are rebuilt only on Keyframe/OrderChanged.
public sealed class PaintOrderTables
{
    // Halo constants (design px) for a blocker whose pixels jitter this instant. A BOUNDED cosmetic (bob/spin) reaches
    // only BoundedCosmeticSlackPx; any other dynamically-owned painter (transform tween / lift — unbounded) reaches
    // DynamicSlackPx. Shared so both planners inflate occluders identically.
    public const double DynamicSlackPx = 48;
    public const double BoundedCosmeticSlackPx = 20;

    // Godot TextureRect.StretchMode.KEEP_ASPECT_CENTERED — the only mode we letterbox-tighten a blocker for.
    private const int StretchKeepAspectCentered = 5;

    // ---- paint-order index (rebuilt only on Keyframe/OrderChanged) ----------------------------------------------
    private readonly Dictionary<string, int> _index = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _subtreeEnd = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _depth = new(StringComparer.Ordinal);

    // Track-Z: the effective ZIndex of each node (Σ ZIndex down the ancestor chain, ZAsRelative default true) — the
    // Godot 2D paint BAND. Godot paints all canvas items by effZ ascending, ties broken by tree (pre-order); this is
    // the same effZ model StaticBakePlanner.BuildPaintOrder computes. Consumed by the z-aware PaintKey so the text /
    // card planners occlusion-sweep in true paint order instead of pre-order only (a z=-10 combat-scene label is then
    // checked against the z=0 content that actually paints over it, rather than being blanket-rejected as ZOrder).
    private readonly Dictionary<string, int> _effZ = new(StringComparer.Ordinal);

    // Read the pre-order index / subtree-end / depth for a node (0 when absent — matches the old GetValueOrDefault).
    public int IndexOf(string id) => _index.GetValueOrDefault(id);

    public int SubtreeEndOf(string id) => _subtreeEnd.GetValueOrDefault(id);

    public int DepthOf(string id) => _depth.GetValueOrDefault(id);

    // The effective Z (paint band) of a node — 0 when absent / for a z=0 chain, so the z-aware PaintKey is identical
    // to the pre-order key on an all-z=0 scene.
    public int EffZOf(string id) => _effZ.GetValueOrDefault(id);

    // Rebuild the pre-order index/depth/subtreeEnd tables. Call on the first plan and on every Keyframe/OrderChanged
    // drain. Cheap (two linear passes) and only on structural drains. (Body moved verbatim from TextOverlayPlanner,
    // then a STALE-ID SKIP added: a long-lived session's OrderedIds accumulates ids whose node has been removed —
    // measured live: 3390 ordered ids vs 679 live nodes — and the old code wrote index/depth/subtreeEnd entries for
    // every one. A stale id's entries were only ever self-seeded defaults and never queried (every planner read is
    // for a LIVE node id, and the depth/subtreeEnd propagation already skipped stale ids via its Nodes guard), so
    // storing only live ids is read-identical and cuts ~80% of the dictionary writes on such sessions. The ORDINAL i
    // still counts stale ids — paint-key positions are unchanged.)
    public void RebuildIndex(MirrorState state)
    {
        _index.Clear();
        _depth.Clear();
        _subtreeEnd.Clear();
        _effZ.Clear();

        var ordered = state.OrderedIds;
        var nodes = state.Nodes;
        for (int i = 0; i < ordered.Count; i++)
        {
            var id = ordered[i];
            if (nodes.ContainsKey(id))
            {
                _index[id] = i;
            }
        }

        // depth: parents precede children in pre-order, so a forward pass reads the parent's depth first.
        // effZ: same forward pass — effZ(id) = effZ(parent) + (ZIndex ?? 0); a stale/absent parent yields a root
        // (effZ = own ZIndex). Identical to StaticBakePlanner.BuildPaintOrder's effZ pass.
        foreach (var id in ordered)
        {
            if (!nodes.TryGetValue(id, out var node))
            {
                continue; // stale id — nothing ever queries its tables
            }

            _depth[id] = node.ParentId is { } pid && _depth.TryGetValue(pid, out var pd) ? pd + 1 : 0;
            int baseZ = node.ParentId is { } zpid && _effZ.TryGetValue(zpid, out var pz) ? pz : 0;
            _effZ[id] = baseZ + (node.ZIndex ?? 0);
        }

        // subtreeEnd: seed each node with its own index, then bubble each node's value up to its parent in REVERSE
        // pre-order. Every descendant has a higher index than its ancestor and is processed first, so one-level
        // propagation walks the full max up the chain.
        foreach (var id in ordered)
        {
            if (_index.TryGetValue(id, out var i))
            {
                _subtreeEnd[id] = i;
            }
        }

        for (int i = ordered.Count - 1; i >= 0; i--)
        {
            var id = ordered[i];
            if (nodes.TryGetValue(id, out var node) && node.ParentId is { } pid && _subtreeEnd.ContainsKey(pid))
            {
                if (_subtreeEnd[id] > _subtreeEnd[pid])
                {
                    _subtreeEnd[pid] = _subtreeEnd[id];
                }
            }
        }
    }

    // ---- shared geometry / predicate helpers (promoted to internal for CardLayerPlanner reuse) --------------------

    // The node's rendered design-space AABB: OfRect under the global affine, shifted by its cumulative wide-screen
    // spread Dx, inflated by `slack` (+ `wideSlack` at F≠1). null when the box or global is unknown. TextOverlayPlanner
    // passes TextSlackPx / SpreadSlackPx; CardLayerPlanner passes CardSlackPx for a text member, 0 for a plain member.
    internal static DesignAabb? RenderedAabb(
        string id, MirrorNode node, GlobalTransformIndex transforms, Func<string, double> spreadDxOf, bool widened,
        double slack, double wideSlack)
    {
        var rect = node.LocalRect;
        if (rect is null || !transforms.TryGetGlobal(id, out var g))
        {
            return null;
        }

        var aabb = CullBounds.OfRect(g, rect.X, rect.Y, rect.Width, rect.Height);
        double s = slack;
        if (widened)
        {
            aabb = aabb.ShiftX(spreadDxOf(id));
            s += wideSlack;
        }

        return aabb.Inflate(s);
    }

    // A clipping ancestor's true rendered design-space AABB for the clip-containment test — the
    // same math as RenderedAabb with ZERO slack, EXCEPT it substitutes the node's anchor-WIDENED width (the
    // SpreadRecord.RenderedWidth the reconciler applies as a LOCAL-rect-width substitute — see
    // MirrorNodeView.WidthAdjusted) for the streamed LocalRect.Width when the stage is widened and an override exists.
    // WHY: a horizontally-stretched clip (a ScrollContainer anchored 0..1) renders WIDER than its streamed rect, but
    // RenderedAabb only applies the horizontal SHIFT (ShiftX(Dx)) and keeps the un-widened width, so the computed clip
    // rect is too NARROW on the right by the whole widening. A label near the widened right edge (the deck/draw/…
    // dialog's LAST grid column) then fails Contains() against that phantom-narrow rect and is wrongly rejected Clip —
    // only at F≠1 (no widening at F=1) and only for the rightmost column (every other column fits the un-widened width).
    // `spreadWidthOf` null (F=1 / unwired) OR a 0 override ⇒ falls back to LocalRect.Width, i.e. byte-identical to
    // RenderedAabb(…, slack:0, wideSlack:0).
    internal static DesignAabb? ClipRenderedAabb(
        string id, MirrorNode node, GlobalTransformIndex transforms, Func<string, double> spreadDxOf,
        Func<string, double>? spreadWidthOf, bool widened)
    {
        var rect = node.LocalRect;
        if (rect is null || !transforms.TryGetGlobal(id, out var g))
        {
            return null;
        }

        // The anchor-widened rendered width the ScrollContainer actually clips to (shared with PointerField /
        // TouchTargetScan via SpreadMath.EffectiveClipWidth): a 0 override falls back to the streamed width.
        double width = widened && spreadWidthOf is not null
            ? SpreadMath.EffectiveClipWidth(rect.Width, spreadWidthOf(id))
            : rect.Width;

        var aabb = CullBounds.OfRect(g, rect.X, rect.Y, width, rect.Height);
        return widened ? aabb.ShiftX(spreadDxOf(id)) : aabb;
    }

    // A blocker's AABB, inflated by a motion halo when the source node's pixels jitter this instant: a BOUNDED cosmetic
    // (bob/spin) reaches only `boundedSlack`; any other dynamically-owned painter (transform tween / lift — unbounded)
    // reaches `dynamicSlack`. A static painter gets no halo.
    internal static DesignAabb Blocker(
        string id, DesignAabb box, IReadOnlySet<string> dynamicallyExcluded, IReadOnlySet<string> boundedCosmetic,
        double dynamicSlack, double boundedSlack)
    {
        if (boundedCosmetic.Contains(id))
        {
            return box.Inflate(boundedSlack);
        }

        return dynamicallyExcluded.Contains(id) ? box.Inflate(dynamicSlack) : box;
    }

    // A textured/fill/range OCCLUDER's tight DRAWN-ART design box: the layout rect under the global affine, spread-
    // shifted, with NO text-slack halo (only a LABEL's font can overflow its rect; an occluder draws within it). For a
    // KeepAspectCentered textured rect the art is scaled-to-fit its region aspect and centered — a strict sub-rect of
    // the layout rect — so letterbox-tighten to that sub-rect. Every other stretch mode fills the rect / is ambiguous
    // → keep the full rect. Can only ever SHRINK vs the layout rect ⇒ never under-covers real art.
    internal static DesignAabb? BlockerAabb(
        string id, MirrorNode node, GlobalTransformIndex transforms, Func<string, double> spreadDxOf, bool widened)
    {
        var rect = node.LocalRect;
        if (rect is null || !transforms.TryGetGlobal(id, out var g))
        {
            return null;
        }

        double lx = rect.X, ly = rect.Y, lw = rect.Width, lh = rect.Height;

        if (node.TextureUrl is not null
            && node.TextureStretchMode == StretchKeepAspectCentered
            && node.TextureRegion is { Width: > 0, Height: > 0 } reg
            && lw > 0 && lh > 0)
        {
            double scale = Math.Min(lw / reg.Width, lh / reg.Height);
            double dw = reg.Width * scale, dh = reg.Height * scale;
            lx += (lw - dw) / 2.0;
            ly += (lh - dh) / 2.0;
            lw = dw;
            lh = dh;
        }

        var aabb = CullBounds.OfRect(g, lx, ly, lw, lh);
        return widened ? aabb.ShiftX(spreadDxOf(id)) : aabb;
    }

    // Does this node OPAQUELY cover pixels — i.e. can its own paint HIDE something painted under it? A transparent
    // container fill, a faded node, a NON-Mix blend (additive/multiply — they blend, never cover), or an effect-bearing
    // node (shader/particle/spine output alpha is unknowable) is NOT an occluder. Text is NOT counted here.
    internal static bool IsOpaqueBlocker(MirrorNode node)
    {
        if (!node.Visible || OwnAlpha(node) <= 0.02)
        {
            return false;
        }

        if (node.CanvasBlendMode is { } bm && bm != 0)
        {
            return false; // Add / Sub / Mul brighten/darken — they never hide the pixels beneath
        }

        if (IsEffectBearing(node))
        {
            return false;
        }

        if (node.FillColor is { A: > 0.02 })
        {
            return true;
        }

        return node.Range is not null || node.TextureUrl is not null;
    }

    // The node's OWN painted alpha (modulate.a × self_modulate.a). Ancestor fades are handled by the chain checks.
    internal static double OwnAlpha(MirrorNode node)
    {
        double m = node.Modulate is { } mod ? mod.A : node.Opacity;
        double s = node.SelfModulate is { } self ? self.A : 1;
        return m * s;
    }

    // True when `node` (id) actually renders visible pixels through its WHOLE ancestor chain: every ancestor Visible AND
    // the ancestor-composed modulate α (× the node's own self_modulate α) exceeds the paint threshold.
    internal static bool ChainCovers(MirrorState state, MirrorNode node, string id)
    {
        double ownSelf = node.SelfModulate is { } s ? s.A : 1;
        double modProduct = 1;
        string? cur = id;
        int guard = 0;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var n) && guard++ < 4096)
        {
            if (!n.Visible)
            {
                return false;
            }

            modProduct *= n.Modulate is { } m ? m.A : n.Opacity;
            cur = n.ParentId;
        }

        return modProduct * ownSelf > 0.02;
    }

    internal static bool IsEffectBearing(MirrorNode node) =>
        node.ParticleSpec is not null
        || node.SpineSceneResPath is not null
        || node.ShaderId is not null
        || node.IntentFrames is not null
        || node.MaterialRef is not null;

    // The ancestor-composed effective modulate (root→id product of Modulate.rgb, alpha = Modulate.A ?? Opacity). The
    // overlay/card holder carries this because it sits UN-nested under a CanvasLayer.
    public static Rgba EffectiveModulate(MirrorState state, string id)
    {
        double r = 1, g = 1, b = 1, a = 1;
        string? cur = id;
        int guard = 0;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var node) && guard++ < 4096)
        {
            double na = node.Modulate is { } m ? m.A : node.Opacity;
            if (node.Modulate is { } c)
            {
                r *= c.R;
                g *= c.G;
                b *= c.B;
            }

            a *= na;
            cur = node.ParentId;
        }

        return new Rgba(r, g, b, a);
    }

    // WS-CRISP R17 fade-in override: identical to the chain product above, EXCEPT for a node whose id is in
    // `fadeInAlpha` the endpoint alpha there is used in place of the node's streamed Modulate alpha. The producer
    // PINS a tween-owned fade-IN channel's streamed modulate at its pre-tween ≈0 for the whole fade (it withholds the
    // tweened channel's deltas until SettleTween), so the plain product reads ≈0 and the text-overlay eligibility's
    // Invisible check rejects a label under a fading-in ancestor for the tween's entire duration. Feeding the tween's
    // ENDPOINT alpha (TweenReplayer.CollectFadeInEndpoints) lets the eligibility read the alpha the fade animates TO
    // (>0) — so the label promotes at the START of the reveal and the per-frame holder sync tracks the live fade.
    // Only the Modulate alpha is substituted (rgb stays the streamed tint); a null/empty map is byte-identical to the
    // plain overload. Applies to ANY node on the chain (the fade may ride the label itself or an ancestor panel).
    public static Rgba EffectiveModulate(MirrorState state, string id, IReadOnlyDictionary<string, double>? fadeInAlpha)
    {
        if (fadeInAlpha is null || fadeInAlpha.Count == 0)
        {
            return EffectiveModulate(state, id);
        }

        double r = 1, g = 1, b = 1, a = 1;
        string? cur = id;
        int guard = 0;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var node) && guard++ < 4096)
        {
            double na = fadeInAlpha.TryGetValue(cur, out var endpoint)
                ? endpoint
                : node.Modulate is { } m ? m.A : node.Opacity;
            if (node.Modulate is { } c)
            {
                r *= c.R;
                g *= c.G;
                b *= c.B;
            }

            a *= na;
            cur = node.ParentId;
        }

        return new Rgba(r, g, b, a);
    }

    // A total-ordered paint key: (effZ band, primary index, tier [self=0/text=1], sub [-depth for text]). Track-Z made
    // effZ the MOST-significant field so a painter in a higher paint band always sorts after a lower one, ties broken by
    // the old (primary, tier, sub) — reproducing Godot's "sort by effZ, then tree order". Layout in the LOW 63 bits of a
    // signed long (bit 63 kept 0 so CompareTo is a plain unsigned magnitude compare — a value that reached the sign bit
    // would sort NEGATIVE and invert the whole order), MSB→LSB: effZ(19, offset 2^18, bits 44..62) | primary(26, bits
    // 18..43) | tier(2, bits 16..17) | sub(16, offset 2^15, bits 0..15). Callers pass effZ=0 to get a key whose RELATIVE
    // order is byte-identical to the pre-Track-Z pre-order key (the effZ field is then a constant 2^62 prefix), so an
    // all-z=0 scene — and every caller that opts out of z-awareness — is unchanged. All fields clamp defensively (a real
    // scene has effZ≈±10, depth≈12, primary=OrderedIds index ≪ 2^26 — the clamps never bind).
    internal static long PaintKey(int effZ, int primary, int tier, int sub)
    {
        int ez = effZ < -262143 ? -262143 : effZ > 262143 ? 262143 : effZ; // 19-bit signed, offset 2^18
        int p = primary < 0 ? 0 : primary > 0x3FFFFFF ? 0x3FFFFFF : primary; // 26-bit
        int d = sub < -32767 ? -32767 : sub > 32767 ? 32767 : sub;          // -depth, 16-bit signed range
        return ((long)(ez + 262144) << 44)
            | ((long)p << 18)
            | ((long)(tier & 0x3) << 16)
            | (long)(d + 32768);
    }
}
