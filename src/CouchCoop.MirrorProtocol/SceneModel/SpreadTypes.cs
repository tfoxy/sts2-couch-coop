namespace CouchCoop.MirrorProtocol.SceneModel;

// M2 wide-screen re-layout (WS-O foundation, then FROZEN). The native analog of the web mirror's per-element
// `data-spread-dx / -w / -mode / -paints` attributes (frontend/src/mirror/mirrorRenderer.ts visit() L2337-2356):
// one record per wire node, produced by <see cref="SpreadIndex"/> (WS-P). At spreadFactor 1 (16:9) NO records
// exist (strict no-op), so this whole subsystem is free.
//
//   * <see cref="SpreadRecord.Dx"/>          — the node's ABSOLUTE horizontal shift in 1920 design px (web `data-spread-dx`;
//                                              cumulative, includes every ancestor's). SceneReconciler folds the
//                                              parent-RELATIVE delta of this into each view's transform origin.
//   * <see cref="SpreadRecord.RenderedWidth"/>— the anchor-widened painted box width (web `data-spread-w`'s second value),
//                                              or 0 for no override. Applied as a rect-WIDTH substitute, never a scale.
//   * <see cref="SpreadRecord.Prop"/>         — true when Dx came from the positional squeeze FIELD (a positional claimer /
//                                              pass-through group) rather than the anchor algebra (web `data-spread-mode="prop"`).
//                                              The input side inverts a `Prop` shift via the field, a non-`Prop` via a fixed translation.
//   * <see cref="SpreadRecord.Paints"/>       — true when the node draws VISIBLE OWN CONTENT AND isn't a paint-anchor-excluded
//                                              aura (web `data-paints`; the pointer map keys off painting anchors).
public readonly record struct SpreadRecord(double Dx, double RenderedWidth, bool Prop, bool Paints);

// WS-P2 incremental-ApplySpread stamp: the FINAL per-VIEW output the reconciler's spread pass writes onto a
// MirrorNodeView (SpreadOffset + SpreadWidth), pre-resolved inside the SpreadIndex walk so the reconciler can stamp
// ONLY the views whose stamp changed since last drain (SpreadIndex.DirtyIds) instead of re-deriving every view every
// drain. It reproduces SceneReconciler.ApplySpread's per-view math EXACTLY:
//   (Ox, Oy) = SpreadMath.ParentFrameOffset(parentGlobal, Dx(node) − Dx(parent))   // the parent-relative fold
//   Width    = the node record's RenderedWidth (the anchor-widened box width, 0 = none)
// where `parentGlobal` is the parent's UNSHIFTED true global (the walk's ctx.ParentGlobal, which IS the same global
// ApplySpread reads via the transform index) and `Dx(parent)` is the parent's own record Dx (ctx.ParentRecordDx;
// root = 0). SpreadRecord stays the ground truth; this is a derived view-space cache keyed by wire node id.
public readonly record struct SpreadViewStamp(double Ox, double Oy, double Width);

// Pure spread math (game-free, Exe-testable). The horizontal squeeze field places a game point at absolute game-x
// so it RENDERS at `gameX·spreadFactor` (shift `dx = gameX·(spreadFactor−1)`); the walk (SpreadIndex) resolves each
// node's absolute Dx from that. This helper turns a parent-relative Dx delta into the PARENT-FRAME translation a
// nested view must add to its local transform origin to reproduce the shift.
public static class SpreadMath
{
    // The width a horizontally-stretched CLIP box actually clips to: its anchor-WIDENED rendered width when an
    // override is present (SpreadRecord.RenderedWidth > 0), else the streamed layout width. A ScrollContainer anchored
    // 0..1 renders WIDER than its streamed rect on a >16:9 stage, so a hit/clip-contains test against its streamed
    // width falsely rejects the rightmost content column (issue #10) — the override is that widened width. Extracted
    // so the three call sites (PaintOrderTables.ClipRenderedAabb text-overlay clip proof, PointerField.ClipAncestorsContain
    // wide-input clip test, TouchTargetScan.IsHittable touch clip loop) apply ONE definition. A 0 / negative override
    // ⇒ falls back to the streamed width (byte-identical to no widening).
    public static double EffectiveClipWidth(double streamedWidth, double renderedWidthOverride) =>
        renderedWidthOverride > 0 ? renderedWidthOverride : streamedWidth;

    // The parent-frame (dx, dy) a child view must add to its LOCAL transform origin to shift on-screen by `relDx`
    // world (design) px horizontally, given the parent's composed transform 6-tuple [a,b,c,d,tx,ty].
    //
    // Web equivalence: the web bakes `tx += Dx` per element AND re-bases children against the parent's SPREAD-shifted
    // inverse, so a child's net LOCAL shift is `parentGlobalInv_linear · (Dx(child) − Dx(parent), 0)`. Here
    // `relDx = Dx(child) − Dx(parent)` and only the parent's linear 2×2 matters (a translation doesn't change the
    // basis). For the common unrotated parent (b=c=0) this reduces to `(relDx / a, 0)`.
    //
    // A singular/degenerate parent basis (|det| ~ 0) yields (0, 0) — the caller renders unshifted rather than NaN.
    public static (double Dx, double Dy) ParentFrameOffset(IReadOnlyList<double> parentGlobal, double relDx)
    {
        if (relDx == 0)
        {
            return (0, 0);
        }

        // The CSS 6-tuple encodes x' = a·x + c·y + tx, y' = b·x + d·y + ty, i.e. the linear map L = [[a, c], [b, d]].
        double a = parentGlobal[0], b = parentGlobal[1], c = parentGlobal[2], d = parentGlobal[3];
        double det = (a * d) - (b * c);
        if (!double.IsFinite(det) || Math.Abs(det) < 1e-9)
        {
            return (0, 0);
        }

        // Solve L · (dx, dy) = (relDx, 0). L⁻¹ = (1/det)·[[d, −c], [−b, a]], so with the (relDx, 0) world vector:
        //   dx = d·relDx / det,  dy = −b·relDx / det.
        double dx = (d * relDx) / det;
        double dy = (-b * relDx) / det;
        return (dx, dy);
    }
}
