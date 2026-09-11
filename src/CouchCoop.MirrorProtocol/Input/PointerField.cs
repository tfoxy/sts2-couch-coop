using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Input;

// M2 WS-Q (widened input). The native port of frontend/src/mirror/pointerMap.ts `mapPointerToGame` L58-122 — the ONE
// bidirectional VISUAL ANCHOR MAP. On a wider-than-16:9 stage the mirror re-lays-out content horizontally on a single
// squeeze field (renderedX = gameX·designW/1920): a node authored at game-x is drawn at `gameX + spreadDx`, so the
// game coordinate under a pointer is NOT `fraction·designWidth` — it's that value minus the shift of whatever is
// painted there. This inverts that via the topmost visibly-painting node under the pointer.
//
// NATIVE DIVERGENCE from the web: there is no DOM, so `document.elementsFromPoint` is replaced by a reversed-OrderedIds
// z-query over the retained scene — topmost-first, one decision per wire node, skipping nodes that don't paint own
// content (the `data-paints` gate → <see cref="SpreadRecord.Paints"/>) and full-stage backdrops, testing containment
// against each node's RENDERED box (its game box shifted +Dx / widened to RenderedWidth). Events reach this map ALREADY
// in design space (the InputRouter's viewport pre-inverts the letterbox), so the caller passes designX/designY directly
// rather than a client pixel + stage rect. On a 16:9 stage design space IS game space (nothing shifted) and the map
// short-circuits to the pure fraction with ZERO scene work.
//
// The record source is a `Func<string, SpreadRecord?>` so the InputRouter can pass the live <see cref="SpreadIndex"/>
// while unit tests inject hand-built records directly (SpreadIndex is WS-P's; keeping the lookup abstract decouples
// WS-Q's tests from WS-P's walk — see the SpreadIndex overload below).
public static class PointerField
{
    // The headless viewport the game hit-tests in (16:9 base). Design width widens up to MirrorMaxDesignWidth; the
    // game X output is always clamped back into [0, GameWidth].
    private const double GameWidth = SceneTreeApplier.MirrorDesignWidth; // 1920
    private const double GameHeight = 1080; // MIRROR_DESIGN_HEIGHT — Y is never widened (design Y === game Y).

    // The horizontal FIELD affine at a resolved point: `coordX = A·designX + B`. A gesture freezes this and replays
    // it with pure math on drag-motion frames (no scene walk). Prop world content → the squeeze `A = 1920/designW,
    // B = 0`; anchored HUD → the translation `A = 1, B = −dx`; 16:9 → identity `A = 1, B = 0`.
    public readonly record struct FieldAffine(double A, double B);

    // The resolved game coordinate, the field affine used to get there, the SHIFT (`designX − coordX`; the web keeps
    // it for cursor-follower stamping — unused native but carried for parity), the pointer's design-space X (so the
    // input side runs the near-miss pass without re-deriving it), and whether the coordinate came from the UNIFORM
    // SQUEEZE rather than a specific painter's own translation (R19 6a — twin of the web PointerMapping.squeezed;
    // <see cref="PointerResolver"/> freezes it at a press so a held drag's replayed frames can be rendered-box
    // gated. Defaulted so every existing construction stays source-compatible).
    public readonly record struct PointerMapping(
        double CoordX,
        double CoordY,
        double Shift,
        FieldAffine Affine,
        double DesignX,
        bool Squeezed = false);

    /// <summary>
    /// Map an ALREADY-design-space point to GAME design space (1920×1080), inverting the wide-screen re-layout via
    /// the topmost visibly-painting node under the pointer. <paramref name="designWidth"/> is the LIVE widened design
    /// width (== 1920 on 16:9). Convenience overload currying the live <see cref="SpreadIndex"/> as the record source.
    /// </summary>
    public static PointerMapping MapPointerToGame(
        MirrorState state,
        GlobalTransformIndex transforms,
        SpreadIndex spread,
        double designX,
        double designY,
        double designWidth) =>
        MapPointerToGame(
            state,
            transforms,
            id => spread.TryGet(id, out var r) ? r : null,
            designX,
            designY,
            designWidth);

    /// <summary>
    /// Map an ALREADY-design-space point to GAME design space, taking the spread records via an abstract lookup (the
    /// live SpreadIndex in production; hand-built records in tests).
    /// </summary>
    public static PointerMapping MapPointerToGame(
        MirrorState state,
        GlobalTransformIndex transforms,
        Func<string, SpreadRecord?> record,
        double designX,
        double designY,
        double designWidth)
    {
        var coordY = Clamp(designY, 0, GameHeight);

        // 16:9 — design space IS game space; nothing shifted, so the fraction is exact. ZERO scene work.
        if (designWidth <= GameWidth)
        {
            return Mapping(designX, coordY, designX, new FieldAffine(1, 0));
        }

        // The uniform SQUEEZE field: design space maps linearly back to 1920 (renderedX = gameX·designW/1920 inverted).
        var squeezeA = GameWidth / designWidth;

        // Widened stage: walk the z-stack top→down (OrderedIds is paint order = back-to-front, so reversed = topmost
        // first), one decision per wire node. First non-backdrop painter under the pointer decides the map.
        for (var i = state.OrderedIds.Count - 1; i >= 0; i--)
        {
            var id = state.OrderedIds[i];
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            // No visible OWN paint → can't anchor the map (a transparent Stop overlay, a boxless group). This is the
            // native `data-paints` gate: a node with no record, or a record that doesn't paint, is skipped. A node
            // that paints ALWAYS carries a record on a widened stage (its cumulative Dx + Paints flag).
            if (record(id) is not { Paints: true } rec)
            {
                continue;
            }

            // EFFECTIVE visibility (own + every ancestor): an ancestor-hidden painter renders display:none, so the
            // pointer's hit-test never sees it — it must not anchor the map either (the web elementsFromPoint never
            // returns a display:none element). The Paints alpha gate doesn't cover a hidden ANCESTOR.
            if (!EffectivelyVisible(state, node))
            {
                continue;
            }

            // A painter needs a box + a global to be rendered under the pointer at all.
            if (node.Transform is null || node.LocalRect is not { } localRect)
            {
                continue;
            }

            if (!transforms.TryGetGlobal(id, out var global))
            {
                continue;
            }

            var paintWidth = rec.RenderedWidth > 0 ? rec.RenderedWidth : localRect.Width;

            // Containment against the RENDERED box: the box is the game box shifted +Dx (a pure horizontal
            // translation), so testing the design pointer against it == testing (designX − Dx, designY) against the
            // game box — reusing the near-miss primitive with the rendered-width override.
            if (!NearMiss.PointInRectGame(global, localRect, designX - rec.Dx, designY, paintWidth))
            {
                continue;
            }

            // A clipped-away paint renders display-clipped, so the pointer's hit-test never sees it — it must not
            // anchor either (honor every clip-children ancestor's RENDERED box, same +Dx shift semantics).
            if (!ClipAncestorsContain(state, transforms, record, node, designX, designY))
            {
                continue;
            }

            // The rendered horizontal extent in design px (axis-aligned approximation — the |a|·width the browser's
            // boundingClientRect reports). A full-stage BACKDROP — a width-stretched span (RenderedWidth override) or
            // an element as wide as the stage — must NOT impose its (usually squeezed) map on content painted ABOVE
            // it. Skip it and keep walking for a more specific painter; the loop's uniform-squeeze fallback maps it if
            // none is found (a full-span backdrop's rect-pair IS that same squeeze).
            var ownWidth = Math.Abs(global[0]) * paintWidth;
            if (rec.RenderedWidth > 0 || ownWidth >= 0.95 * designWidth)
            {
                continue;
            }

            // First non-backdrop painter decides. `dx` is its cumulative absolute shift (SpreadRecord.Dx).
            var dx = rec.Dx;
            if (rec.Prop)
            {
                // PROPORTIONAL world content (a card, a creature, an arrow segment): the hit itself resolves via the
                // exact local translation (`designX − dx`, correct for a point ON this rigid element), but the FROZEN
                // field is the whole-world squeeze — a drag begun here spreads the world under the finger.
                // EXCEPTION: a prop painter wider than ~60% of the stage (the oversized center-anchored parallax bg)
                // has a rigid span that misregisters the field, and its own hit identity is irrelevant → squeeze too.
                var squeezed = ownWidth > 0.6 * designWidth;
                var coordX = ClampGameX(squeezed ? designX * squeezeA : designX - dx);
                return Mapping(coordX, coordY, designX, new FieldAffine(squeezeA, 0), squeezed);
            }

            // ANCHORED HUD: subtract its fixed translation; a drag begun here replays that same translation.
            var anchoredX = ClampGameX(designX - dx);
            return Mapping(anchoredX, coordY, designX, new FieldAffine(1, -dx));
        }

        // No specific painter (dead letterbox space, or only a widened backdrop was seen) → the uniform squeeze field.
        return Mapping(ClampGameX(designX * squeezeA), coordY, designX, new FieldAffine(squeezeA, 0), squeezed: true);
    }

    // The web `owner.closest("[data-node-id]")` z-query is per-node here, but clip containment must still walk the
    // parent chain: every clip-children ancestor's RENDERED box (game box +its Dx) must contain the pointer.
    private static bool ClipAncestorsContain(
        MirrorState state,
        GlobalTransformIndex transforms,
        Func<string, SpreadRecord?> record,
        MirrorNode node,
        double designX,
        double designY)
    {
        for (var p = Parent(state, node); p is not null; p = Parent(state, p))
        {
            if (p.ClipChildren == 0 || p.LocalRect is not { } pr || pr.Width <= 0 || pr.Height <= 0)
            {
                continue;
            }

            if (!transforms.TryGetGlobal(p.Id, out var pg))
            {
                continue;
            }

            // The clip ancestor's own shift AND its anchor-widened rendered width (issue #10): a horizontally-stretched
            // ScrollContainer clips WIDER than its streamed rect, so a rightmost-column point (designX − pdx past the
            // streamed width) must be tested against the widened width or it is falsely clip-rejected. 0 override ⇒
            // the streamed width (byte-identical to before the fix).
            double pdx = 0, pw = pr.Width;
            if (record(p.Id) is { } prec)
            {
                pdx = prec.Dx;
                pw = SpreadMath.EffectiveClipWidth(pr.Width, prec.RenderedWidth);
            }

            if (!NearMiss.PointInRectGame(pg, pr, designX - pdx, designY, pw))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EffectivelyVisible(MirrorState state, MirrorNode node)
    {
        for (var cur = node; cur is not null; cur = Parent(state, cur))
        {
            if (!cur.Visible)
            {
                return false;
            }
        }

        return true;
    }

    private static MirrorNode? Parent(MirrorState state, MirrorNode node) =>
        node.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;

    private static PointerMapping Mapping(double coordX, double coordY, double designX, FieldAffine affine, bool squeezed = false) =>
        new(coordX, coordY, designX - coordX, affine, designX, squeezed);

    private static double ClampGameX(double value) => value < 0 ? 0 : value > GameWidth ? GameWidth : value;

    private static double Clamp(double value, double lo, double hi) => value < lo ? lo : value > hi ? hi : value;
}
