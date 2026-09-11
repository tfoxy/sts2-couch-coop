using CouchCoop.MirrorProtocol.SceneModel;
using V = CouchCoop.MirrorProtocol.SceneModel.TextScale.PlacementValign;

namespace CouchCoop.MirrorProtocol.Tests;

// Truth table for TextScale.PlacementLift — the pure vertical-lift math backing TextBuilder.GrowthCenterPlain.
// The round-5 combat-recording ink matrix proved the growth-centering must split a streamed-Center label by whether
// its BUMPED glyph overflows the box (the game fitted the box to the UNbumped size):
//   * LOOSE box (glyph fits, overflow ≤ 0): Godot's Center already lands the glyph on the box centre EXACTLY as the
//     game did → lift 0. The pre-round-5 code lifted by grow/2 anyway, shoving the energy/pile counts ~8px too high.
//   * TIGHT box (glyph overflows, overflow > 0): Godot's Center drifts the overflowing block down → lift = overflow/2
//     re-centres it (the HP bar). Because the game fitted boxHeight ≈ height(originalSize), overflow/2 == grow/2 for a
//     tight box, so HP stays exactly where the shipped build already had it centred.
// A streamed-Top label keeps grow/2 unconditionally (re-seat the top-anchored block); Bottom/Fill are untouched.
internal static class TextPlacementTests
{
    public static void Run()
    {
        CenterLooseBoxNoLift();
        CenterTightBoxLiftsHalfOverflow();
        CenterAddsNudgeOnTop();
        TopAlwaysGrowHalfRegardlessOfOverflow();
        TopAddsNudge();
        BottomAndFillUntouched();
        ScaleOneOrNoGrowthIsZero();
        HpVsCountRegressionGuard();
    }

    // Center + LOOSE box (bumped glyph fits: overflow ≤ 0) → grow term 0. This is the energy/pile-count fix:
    // the old code lifted by grow/2, the overflow rule leaves the label on Godot's own (game-matching) centre.
    private static void CenterLooseBoxNoLift()
    {
        // growAll 20 (a real bump) but overflow −60 (a 186px energy box vs a ~58px glyph) → 0 lift, no nudge.
        Check.Close(TextScale.PlacementLift(V.Center, growAll: 20f, overflow: -60f, nudge: 0f), 0f,
            "Center loose box → 0 (Godot Center already centres — the count fix)");
        // even a large grow does not lift a loose box.
        Check.Close(TextScale.PlacementLift(V.Center, growAll: 40f, overflow: -1f, nudge: 0f), 0f,
            "Center still-fits (overflow just under 0) → 0");
    }

    // Center + TIGHT box (overflow > 0) → half the overflow (re-centre the drift). HP: 44px glyph, 31px box →
    // overflow 13 → lift 6.5.
    private static void CenterTightBoxLiftsHalfOverflow()
    {
        Check.Close(TextScale.PlacementLift(V.Center, growAll: 13f, overflow: 13f, nudge: 0f), 6.5f,
            "Center tight box → overflow/2 (HP re-centring)");
        Check.Close(TextScale.PlacementLift(V.Center, growAll: 30f, overflow: 8f, nudge: 0f), 4f,
            "Center overflow/2 uses the OVERFLOW, not grow (partial overflow = 8 → 4)");
    }

    // The per-entry nudge adds ON TOP of the (overflow) grow term for a Center label.
    private static void CenterAddsNudgeOnTop()
    {
        Check.Close(TextScale.PlacementLift(V.Center, growAll: 13f, overflow: 13f, nudge: 2f), 8.5f,
            "Center tight box + nudge 2 → 6.5 + 2");
        Check.Close(TextScale.PlacementLift(V.Center, growAll: 20f, overflow: -60f, nudge: 3f), 3f,
            "Center loose box + nudge 3 → 0 + 3 (nudge lands even with 0 grow term)");
    }

    // A streamed-Top label ALWAYS lifts by grow/2 (re-seat the top-anchored block), independent of overflow.
    private static void TopAlwaysGrowHalfRegardlessOfOverflow()
    {
        Check.Close(TextScale.PlacementLift(V.Top, growAll: 20f, overflow: -60f, nudge: 0f), 10f,
            "Top loose → grow/2 (unchanged)");
        Check.Close(TextScale.PlacementLift(V.Top, growAll: 20f, overflow: 5f, nudge: 0f), 10f,
            "Top tight → still grow/2 (Top ignores overflow)");
    }

    private static void TopAddsNudge()
    {
        Check.Close(TextScale.PlacementLift(V.Top, growAll: 20f, overflow: -60f, nudge: 3f), 13f,
            "Top grow/2 + nudge");
    }

    // Bottom / Fill are never centered or nudged (GrowthCenterPlain early-returns) → 0 even with a nudge passed.
    private static void BottomAndFillUntouched()
    {
        Check.Close(TextScale.PlacementLift(V.Bottom, growAll: 20f, overflow: 20f, nudge: 5f), 0f, "Bottom → 0");
        Check.Close(TextScale.PlacementLift(V.Fill, growAll: 20f, overflow: 20f, nudge: 5f), 0f, "Fill → 0");
    }

    // No bump (growAll 0) and a fitting box (overflow < 0) → 0 for every valign (scale-1 / capped-to-original).
    private static void ScaleOneOrNoGrowthIsZero()
    {
        Check.Close(TextScale.PlacementLift(V.Center, growAll: 0f, overflow: -30f, nudge: 0f), 0f, "Center no-growth → 0");
        Check.Close(TextScale.PlacementLift(V.Top, growAll: 0f, overflow: -30f, nudge: 0f), 0f, "Top no-growth → 0");
    }

    // The concrete round-5 regression: with the SAME grow, a tight HP box keeps its lift while a loose count box loses
    // it. This is the whole fix in one assertion pair (measured HP overflow ≈ grow, count overflow ≪ 0).
    private static void HpVsCountRegressionGuard()
    {
        const float grow = 10f;
        float hp = TextScale.PlacementLift(V.Center, growAll: grow, overflow: 13f, nudge: 0f);   // tight
        float count = TextScale.PlacementLift(V.Center, growAll: grow, overflow: -50f, nudge: 0f); // loose
        Check.That(hp > 4f, "HP (tight box) still lifts");
        Check.Close(count, 0f, "count (loose box) no longer lifts — the count fix");
    }
}
