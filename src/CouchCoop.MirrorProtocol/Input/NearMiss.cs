using CouchCoop.MirrorProtocol.SceneModel;

// The legit-hit guard's switch-off leg is exercised by a unit test (env is read once, so the test flips the cached
// flag directly). Same shape as CouchCoop.Mod's InternalsVisibleTo.
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CouchCoop.MirrorProtocol.Tests")]

namespace CouchCoop.MirrorProtocol.Input;

// M2 WS-Q (widened input). Near-literal port of frontend/src/mirror/pointerMap.ts `pushOutOfNearMiss` L159-202
// (+ its `pointInRectGame` L133-141 and `gameXExtent` L144-150 primitives). The HIT-CONSISTENCY pass: the visual
// anchor map's inverse can place a pointer that sits in EMPTY stage space (just left/right of a +dx-shifted button)
// INSIDE that button's GAME rect, so the game would hover/click a control the user is visually NOT over. This pushes
// the resolved game X OUT of any such near-missed interactive rect toward the pointer's side, iterating in the SAME
// locked direction across abutting rects (capped at 4), reverting all-or-nothing if the walk strands inside a chain.
//
// Consumes the frozen <see cref="InteractiveRectScan.InteractiveRect"/> list (game-space global + node box + spread
// shift + anchor-widened rendered width). Y is 1:1 (no vertical widening) — the pointer's design Y === game Y.
// Also hosts the two geometry primitives (game-rect containment / horizontal extent) that <see cref="PointerField"/>
// reuses for its rendered-box z-query, matching the web where both live in pointerMap.ts.
public static class NearMiss
{
    // How many times the pass steps across abutting interactive rects before giving up (pointerMap.ts
    // HIT_CONSISTENCY_ITERATIONS L126) — ~4 covers the worst real HUD/hand cluster.
    private const int HitConsistencyIterations = 4;

    // Game clamp ceiling (the headless viewport the game hit-tests in is 1920 wide; Y is never widened).
    private const double GameWidth = SceneTreeApplier.MirrorDesignWidth;

    // A rect whose GAME-x extent covers at least this fraction of the 1920 stage is a "stage-band" bar (the TopBar
    // bar, a full-band dialog backdrop): it spans the frame and can't speak for a specific widget under the pointer,
    // so it never VOUCHES in the legit-hit guard (see TopOffender). Matches PointerField's backdrop-demote threshold.
    private const double StageBandFraction = 0.95;

    /// <summary>
    /// R19 6a — the SQUEEZE RENDERED-BOX GATE: hold a coordinate the anchor map could not attribute to a specific
    /// painter (the uniform-squeeze fallback, <see cref="PointerField.PointerMapping.Squeezed"/>) to ONE invariant —
    /// it may only resolve into an interactive rect whose RENDERED box contains the raw widened-design pointer —
    /// and eject it from that rect where it doesn't. Twin of the web pointerMap.pushOutOfSqueezeMiss.
    ///
    /// Native's FRESH resolves already satisfy this: <see cref="PointerResolver"/> runs the full
    /// <see cref="PushOutOfNearMiss"/> on every one of them, squeezed or not (native never took the web's squeeze
    /// suppression). Its FROZEN drag replay runs no pass at all, though, which is the reported bug: a drag pressed
    /// in the empty stage band right of the wide-screen map legend replayed the squeeze straight into a legend row's
    /// game rect and held it for the whole gesture.
    ///
    /// Deliberately NOT the full pass: that WALKS (direction locked, up to four abutting rects), so its output
    /// depends on which of several overlapping rects was topmost at a given pixel — the measured bistability. This
    /// asks the invariant ONCE, of the ONE rect the coordinate resolves into (same topmost-first arbitration, same
    /// vouching rules), and ejects from that rect only, by reusing the pusher on a single-rect list.
    /// </summary>
    public static double PushOutOfSqueezeMiss(
        double gameX,
        double gameY,
        double designX,
        IReadOnlyList<InteractiveRectScan.InteractiveRect> rects)
    {
        if (TopOffender(gameX, gameY, designX, rects) is not { } offender)
        {
            return gameX; // resolves into nothing, or into a rect the pointer really is over → untouched.
        }

        return PushOutOfNearMiss(gameX, gameY, designX, new[] { offender });
    }

    /// <summary>
    /// Push the resolved <paramref name="gameX"/> out of any near-missed interactive rect toward the pointer's side.
    /// Direct port of pushOutOfNearMiss: topmost offender first (rects are paint order, topmost LAST), direction
    /// locked from the first offender's RENDERED mid, capped at 4 iterations, all-or-nothing revert on a stranded
    /// walk. <paramref name="designX"/> is the pointer's design-space X (1920-widened space); <paramref name="gameY"/>
    /// is the pointer's game Y (== design Y). Returns the (clamped) game X.
    /// </summary>
    public static double PushOutOfNearMiss(
        double gameX,
        double gameY,
        double designX,
        IReadOnlyList<InteractiveRectScan.InteractiveRect> rects)
    {
        var x = gameX;
        var dir = 0; // -1 = push left, +1 = push right; locked on the first offender so the walk never doubles back.
        for (var iter = 0; iter < HitConsistencyIterations; iter++)
        {
            var offender = TopOffender(x, gameY, designX, rects);
            if (offender is not { } r)
            {
                return ClampGameX(x); // fully clear of offenders — the push succeeded (or never fired).
            }

            var (gLeft, gRight) = GameXExtent(r);
            if (dir == 0)
            {
                var renderedMid = ((gLeft + gRight) / 2) + r.SpreadDx;
                dir = designX < renderedMid ? -1 : 1;
            }

            // Push just OUTSIDE the game rect on the pointer's side (±1px clears the inclusive edge).
            x = dir < 0 ? gLeft - 1 : gRight + 1;
        }

        // ALL-OR-NOTHING: the cap exhausted while still inside an offender (a long chain of game-space-OVERLAPPING
        // rects — a fanned hand's hitboxes overlap continuously). A partial walk would land the coord several
        // entities away from the pointer; the original coord at worst hits the adjacent overlap (game-native
        // ambiguity). Revert.
        return TopOffender(x, gameY, designX, rects) is not null ? ClampGameX(gameX) : ClampGameX(x);
    }

    // The topmost offender at game X <paramref name="x"/>: a rect containing the game point whose RENDERED rect
    // (game rect shifted +spreadDx, and, for a stretched span, widened to renderedWidth) does NOT contain the pointer
    // — i.e. (designX − spreadDx, gameY) is outside that box. A rect the pointer IS visually over is a legit hit.
    //
    // LEGIT-HIT GUARD: z-aware vouching. The scan is topmost-first,
    // so the FIRST rect whose game box contains the coord decides — mirroring the game's own topmost-first hit
    // arbitration. When the pointer IS visually over that topmost rect (a legit hit), it VOUCHES for the coord (the
    // scan stops with NO push) UNLESS it structurally cannot: a width-STRETCHED span (renderedWidth > 0 — a
    // full-canvas blocker that contains every pointer; symmetric with the existing never-OFFEND rule) or a stage-band
    // bar (game-x extent ≥ 0.95·1920 — the TopBar bar, a full-band dialog backdrop). Those keep the scan going so a
    // lower offender is still found (the pre-fix parchment-over-TopBar push is preserved). Only a normal-width widget
    // genuinely under the pointer vouches. The pre-fix bug was skipping a legit hit and then pushing from a LOWER
    // offender the pointer was never over. Switch OFF ⇒ the old unconditional-continue scan, byte-identical to today.
    private static InteractiveRectScan.InteractiveRect? TopOffender(
        double x,
        double gameY,
        double designX,
        IReadOnlyList<InteractiveRectScan.InteractiveRect> rects)
    {
        for (var i = rects.Count - 1; i >= 0; i--)
        {
            var r = rects[i];
            if (!PointInRectGame(r.Global, r.LocalRect, x, gameY))
            {
                continue; // this rect's GAME box doesn't contain the resolved coord → not a candidate.
            }

            // Topmost rect whose GAME box contains the coord. If its RENDERED box does NOT contain the raw pointer,
            // the map mis-placed the coord into it → offender → push.
            var renderedWidth = r.RenderedWidth > 0 ? r.RenderedWidth : r.LocalRect.Width;
            if (!PointInRectGame(r.Global, r.LocalRect, designX - r.SpreadDx, gameY, renderedWidth))
            {
                return r;
            }

            // The pointer IS visually over this rect — a legitimate hit.
            if (r.RenderedWidth > 0)
            {
                continue; // stretched blocker never vouches (symmetric with the never-offend rule).
            }

            var (gLeft, gRight) = GameXExtent(r);
            if (gRight - gLeft >= StageBandFraction * GameWidth)
            {
                continue; // stage-band bar can't vouch for a specific widget; keep the parchment-over-TopBar push.
            }

            return null; // legit hit of a normal-width widget under the pointer → no push.
        }

        return null;
    }

    // ---- geometry primitives (shared with PointerField; ports of pointInRectGame / gameXExtent) ----

    /// <summary>
    /// True when the GAME point (gx, gy) is inside interactive rect <paramref name="global"/>+<paramref name="localRect"/>'s
    /// box — the point mapped into the rect's local [0,width]×[0,height] via the inverse of its placement matrix
    /// (rotation/skew safe). <paramref name="width"/> defaults to the game box width; a RENDERED containment test
    /// passes the anchor-widened rendered width (a full-canvas 0/1 blocker renders 0..designW wide, not 0..1920).
    /// </summary>
    public static bool PointInRectGame(
        IReadOnlyList<double> global,
        MirrorRect localRect,
        double gx,
        double gy,
        double? width = null)
    {
        var w = width ?? localRect.Width;
        var m = Affine.NodeMatrix(global, localRect.X, localRect.Y);
        var inv = Affine.Inverse(m);
        if (inv is null)
        {
            return false;
        }

        var lx = (inv[0] * gx) + (inv[2] * gy) + inv[4];
        var ly = (inv[1] * gx) + (inv[3] * gy) + inv[5];
        return lx >= 0 && lx <= w && ly >= 0 && ly <= localRect.Height;
    }

    // The rect's game-space horizontal extent [min, max] from its four transformed corners (rotation-safe).
    private static (double Left, double Right) GameXExtent(InteractiveRectScan.InteractiveRect r)
    {
        var m = Affine.NodeMatrix(r.Global, r.LocalRect.X, r.LocalRect.Y);
        var w = r.LocalRect.Width;
        var h = r.LocalRect.Height;
        double x0 = m[4];
        double x1 = (m[0] * w) + m[4];
        double x2 = (m[2] * h) + m[4];
        double x3 = (m[0] * w) + (m[2] * h) + m[4];
        var min = Math.Min(Math.Min(x0, x1), Math.Min(x2, x3));
        var max = Math.Max(Math.Max(x0, x1), Math.Max(x2, x3));
        return (min, max);
    }

    private static double ClampGameX(double value) => value < 0 ? 0 : value > GameWidth ? GameWidth : value;
}
