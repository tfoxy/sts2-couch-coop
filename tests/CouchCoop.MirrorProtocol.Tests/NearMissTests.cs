using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// OWNER: WS-Q (widened input). Port of frontend/src/mirror/__tests__/pointerMap.spec.ts `describe("pushOutOfNearMiss")`
// against Input/NearMiss.cs — the hit-consistency pass (4 iterations, renderedWidth-aware blocker rects, direction
// locked from the rendered mid, all-or-nothing revert). The web `iRect(...)` helper maps 1:1 onto the frozen
// InteractiveRectScan.InteractiveRect (game-space global 6-tuple + node box + spread shift + rendered width); no
// MirrorState/transforms are needed — the pass is pure geometry over the rect list.
internal static class NearMissTests
{
    public static void Run()
    {
        PushesOutOfUnhoveredButton();
        IteratesAcrossAdjacentRect();
        NoPushWhenVisuallyOver();
        RevertsWhenCapStrandsChain();
        KeepsCappedWalkThatExits();
        NeverPushesGameOverlapWhileOverMember();
        WidthStretchedBlockerNeverOffends();
        PushesOutOfTooltipOnlyRect_GoldRepro();
        PushesCrossFrameButNeverSameFrame();
        HandlesRotatedRect();

        // Legit-hit guard (r3/nearmiss): a legit hit of a normal-width widget over a stage-band bar / full-band
        // backdrop KEEPS the coord (pre-fix pushed it to the band edge). Stage-band + stretched rects never vouch.
        GearOverWideBarKeepsCoord();
        RestSiteButtonOverBackdropKeepsCoord();
        DeadSpaceBesideShiftedClusterStillPushes();
        StageBandRectNeverVouches();
        StretchedBlockerNeverVouches();
        GoldReproUnchangedWithGuard();

        // R19 6a — the squeeze rendered-box gate (twin of pointerMap.pushOutOfSqueezeMiss).
        SqueezeGateEjectsFromTheMapLegend();
        SqueezeGateLeavesLegitAndUnclaimedPointsAlone();
        SqueezeGateEjectsOneStepNotAWalk();
    }

    private static double Squeeze(double gameX, double gameY, double designX, params InteractiveRectScan.InteractiveRect[] rects) =>
        NearMiss.PushOutOfSqueezeMiss(gameX, gameY, designX, rects);

    // The MEASURED map screen at 2520x1080 (.sts2/artifacts/diag-map-legend-2520.json): an ANCHORED legend row at
    // game x[1582,1862] with spreadDx 300 RENDERS at x[1882,2162]. Right of that nothing paints, so the anchor map
    // falls back to the uniform squeeze — designX·1920/2520 — which lands inside the row's GAME rect for the whole
    // dead band. The gate ejects it; the full-canvas screen roots above it can neither offend nor vouch.
    private static InteractiveRectScan.InteractiveRect LegendRow() => IRect("legendTreasure", 1582, 486, 280, 48, 300);

    private static InteractiveRectScan.InteractiveRect ScreenRoot(string id) => IRect(id, 0, 0, 1920, 1080, 0, 2520);

    private static void SqueezeGateEjectsFromTheMapLegend()
    {
        const double squeezeA = 1920.0 / 2520.0;
        var rects = new[] { ScreenRoot("game"), ScreenRoot("mapScreen"), LegendRow() };
        Check.Close(Squeeze(2220 * squeezeA, 500, 2220, rects), 1863, "designX 2220 ejected past the row (1862 + 1)");
        // The far end of the same dead band lands in the SAME place — single-valued across the whole band, which is
        // what the walking pass could not promise here.
        Check.Close(Squeeze(2440 * squeezeA, 500, 2440, rects), 1863, "designX 2440 ejected to the same edge");
    }

    private static void SqueezeGateLeavesLegitAndUnclaimedPointsAlone()
    {
        var rects = new[] { ScreenRoot("game"), LegendRow() };
        // Pointer inside the row's RENDERED box [1882,2162] → a legitimate hit, whatever resolved it.
        Check.Close(Squeeze(1700, 500, 2000, rects), 1700, "legit hit is untouched");
        // Resolves into nothing (right of the row's game rect).
        Check.Close(Squeeze(1904.76, 500, 2500, rects), 1904.76, "coord outside every claimable rect is untouched");
        // The stretched screen root contains EVERY point but can never be the claim, or the gate would eject the
        // whole stage.
        Check.Close(Squeeze(1691.43, 500, 2220, ScreenRoot("game")), 1691.43, "a width-stretched span is never claimed");
    }

    // The gate ejects from the TOPMOST claiming rect ONLY — one step, no chain walk. The full pass would walk out of
    // both overlapping rects; the walk is what makes adjacent samples bistable, so the gate deliberately stops.
    private static void SqueezeGateEjectsOneStepNotAWalk()
    {
        var lower = IRect("lower", 1500, 400, 400, 200, 300); // game [1500,1900]
        var upper = IRect("upper", 1582, 486, 280, 48, 300); //  game [1582,1862], topmost
        Check.Close(Push(1691.43, 500, 2220, lower, upper), 1901, "the pass walks out of BOTH (1900 + 1)");
        Check.Close(Squeeze(1691.43, 500, 2220, lower, upper), 1863, "the gate ejects the claim only (1862 + 1)");
    }

    // An axis-aligned interactive game rect: game box [tx, tx+w]×[ty, ty+h], rendered shifted +spreadDx (and
    // optionally width-STRETCHED to renderedWidth — a full-canvas 0/1 blocker). Port of the web `iRect`.
    private static InteractiveRectScan.InteractiveRect IRect(
        string id,
        double tx,
        double ty,
        double w,
        double h,
        double spreadDx,
        double renderedWidth = 0) =>
        new(id, [1, 0, 0, 1, tx, ty], new MirrorRect(0, 0, w, h), spreadDx, renderedWidth);

    private static double Push(double gameX, double gameY, double designX, params InteractiveRectScan.InteractiveRect[] rects) =>
        NearMiss.PushOutOfNearMiss(gameX, gameY, designX, rects);

    // Pushes a mapped point OUT of an unhovered button's game rect toward the pointer's side.
    private static void PushesOutOfUnhoveredButton()
    {
        // Button game [1000,1200], rendered (+300) [1300,1500]. Pointer designX 1150 is LEFT of the rendered rect but
        // the resolved game point 1100 landed INSIDE the game rect → push just left of the game rect.
        var button = IRect("b", 1000, 100, 200, 100, 300);
        Check.Close(Push(1100, 150, 1150, button), 999, "pushed to 1000 - 1"); // 1000 − 1
    }

    // Iterates in the same direction across an ADJACENT interactive rect.
    private static void IteratesAcrossAdjacentRect()
    {
        var b1 = IRect("b1", 1000, 100, 200, 100, 400); // game [1000,1200], rendered [1400,1600]
        var b2 = IRect("b2", 800, 100, 200, 100, 400); //  game [800,1000],  rendered [1200,1400]
        Check.Close(Push(1100, 150, 1150, b2, b1), 799, "1000 - 1 → into b2 → 800 - 1"); // b1 topmost (last)
    }

    // Does NOT push when the pointer is visually OVER the rect (a legitimate hit).
    private static void NoPushWhenVisuallyOver()
    {
        // Button game [1000,1200] +100 → rendered [1100,1300]; pointer designX 1200 is inside the rendered rect.
        var button = IRect("b", 1000, 100, 200, 100, 100);
        Check.Close(Push(1100, 150, 1200, button), 1100, "visually over → unchanged");
    }

    // REVERTS to the original coord when the iteration cap strands the walk inside a chain (all-or-nothing).
    private static void RevertsWhenCapStrandsChain()
    {
        var rects = new InteractiveRectScan.InteractiveRect[6];
        for (var k = 0; k < 6; k++)
        {
            rects[k] = IRect($"r{k}", 1000 - (100 * k), 100, 100, 100, 500);
        }

        // Resolved 1050 ∈ r0 [1000,1100]; each push steps 100 left; 4 iterations end at 699 — still inside r4
        // [600,700]. A partial walk would hover a control several entities away → revert to the original coord.
        Check.Close(NearMiss.PushOutOfNearMiss(1050, 150, 1050, rects), 1050, "stranded chain → reverted");
    }

    // Keeps a capped-length walk that fully exits the chain.
    private static void KeepsCappedWalkThatExits()
    {
        var rects = new InteractiveRectScan.InteractiveRect[4];
        for (var k = 0; k < 4; k++)
        {
            rects[k] = IRect($"r{k}", 1000 - (100 * k), 100, 100, 100, 500);
        }

        // Four abutting rects [700..1100]: the 4th push lands at 699, left of r3 [700,800] — fully clear, so it sticks.
        Check.Close(NearMiss.PushOutOfNearMiss(1050, 150, 1050, rects), 699, "capped walk exits → kept");
    }

    // Never pushes a point out of a game-overlapping chain while the pointer is visually over one member.
    private static void NeverPushesGameOverlapWhileOverMember()
    {
        var cards = new InteractiveRectScan.InteractiveRect[5];
        for (var k = 0; k < 5; k++)
        {
            cards[k] = IRect($"card{k}", 478 + (170 * k), 800, 240, 338, 136 + (37 * k));
        }

        // designX 1300 over card3's rendered [1235,1475] (1300−247 = 1053 ∈ its game rect, which also contains the
        // resolved 1120): card3 is a legit hit, no other rect contains 1120 → unchanged.
        Check.Close(NearMiss.PushOutOfNearMiss(1120, 900, 1300, cards), 1120, "over one member of an overlap → unchanged");
    }

    // Never treats a width-STRETCHED full-canvas blocker as an offender (its rendered box spans the stage).
    private static void WidthStretchedBlockerNeverOffends()
    {
        // `Game`/overlay ColorRects: full-canvas (1920-wide) Stop controls, 0/1-anchored so the spread STRETCHES them
        // to the stage width (renderedWidth 2340, dx 0). Judged by their GAME width they'd push every right-side hover
        // off the edge; the renderedWidth override makes them contain any pointer.
        var blocker = IRect("game", 0, 0, 1920, 1080, 0, 2340);
        var deck = IRect("deck", 1744, 0, 80, 80, 420);
        // Pointer designX 2204 visually ON the deck (rendered [2164,2244]); resolved coord 1784 is a legit hit.
        Check.Close(Push(1784, 40, 2204, blocker, deck), 1784, "wide blocker never offends; deck hit kept");
        // The near-miss push still fires for the deck itself when the pointer is NOT over it (gap left of the button).
        Check.Close(Push(1771, 40, 2158, blocker, deck), 1743, "deck near-miss still pushes");
    }

    // Pushes out of an unshifted tooltip-only (Pass) rect the dead-space squeeze mapped into (the Gold repro).
    private static void PushesOutOfTooltipOnlyRect_GoldRepro()
    {
        // Gold counter: hover-only (Pass), pinned left (dx 0), game rect [330,470]. Dead space at designX 552
        // squeeze-resolves to ~453 — INSIDE gold while the pointer is visually right of it → push out right.
        var gold = IRect("gold", 330, 20, 140, 60, 0);
        Check.Close(Push(453, 50, 552, gold), 471, "pushed just right of the game rect"); // 470 + 1
        Check.Close(Push(400, 50, 400, gold), 400, "hovering gold itself → legit hit, no push");
    }

    // Pushes cross-frame mismaps from an exact painter hit but never same-frame ones (map parchment over TopBar).
    private static void PushesCrossFrameButNeverSameFrame()
    {
        var floor = IRect("floor", 792, 0, 89, 83, 0); // game [792,881], rendered identical (pinned left)
        var deck = IRect("deck", 1744, 0, 80, 80, 420); // game [1744,1824], rendered [2164,2244]
        var legend = IRect("legend", 1582, 390, 280, 48, 210); // game [1582,1862], rendered [1792,2072]
        // Pointer 1042 over the parchment tile → exact coord 832 ∈ Floor's game rect, but the pointer isn't over
        // Floor's rendered rect → pushed out right.
        Check.Close(Push(832, 47, 1042, floor, deck, legend), 882, "cross-frame Floor mismap pushed right"); // 881 + 1
        // Pointer 2072: coord 1780 ∈ Deck game rect, pointer not over Deck rendered → pushed out left.
        Check.Close(Push(1780, 40, 2072, floor, deck, legend), 1743, "cross-frame Deck mismap pushed left"); // 1744 − 1
        // Pointer 1900 over a LEGEND row (same dx as the tile painter): coord 1690 ∈ its game rect AND the pointer is
        // over its rendered rect → legit same-frame hit, untouched.
        Check.Close(Push(1690, 410, 1900, floor, deck, legend), 1690, "same-frame Legend hit untouched");
    }

    // ---- legit-hit guard (r3/nearmiss) — the widescreen TopBar/rest-site un-tappable fix ----

    // (a) The TopBar gear over the full-width TopBar bar: the pointer is visually ON the +dx-shifted gear, whose game
    // box also lands on the bar's game band. PRE-FIX: the gear is a legit hit but the scan continued to the bar (a
    // stage-band offender) and pushed the coord to the band edge, so the gear never receives the tap. WITH THE GUARD:
    // the gear (normal-width, pointer over it) vouches → the coord is KEPT. Switch OFF reproduces the pushed edge.
    private static void GearOverWideBarKeepsCoord()
    {
        var bar = IRect("topbar", 0, 0, 1920, 90, 0); // full-band bar, pinned (dx 0), rendered [0,1920]
        var gear = IRect("gear", 1770, 15, 60, 60, 400); // right cluster, game [1770,1830], rendered [2170,2230]
        // designX 2200 is over the gear's rendered box; the anchored map resolved 1800 (= 2200 − 400) ∈ the gear.
        Check.Close(Push(1800, 45, 2200, bar, gear), 1800, "gear over the TopBar bar → coord kept (guard on)");

    }

    // (b) The rest-site upgrade dialog's "View Upgrades" (NRestSiteButton) over the full-band dialog backdrop: the
    // pointer is over the +dx-shifted button whose game box sits on the backdrop band. Guard on → coord KEPT; off →
    // pushed off the button to the backdrop edge (the live "can't tap View Upgrades" defect).
    private static void RestSiteButtonOverBackdropKeepsCoord()
    {
        var backdrop = IRect("backdrop", 0, 400, 1920, 300, 0); // full-band dialog backdrop, pinned, rendered [0,1920]
        var view = IRect("view", 1600, 500, 300, 100, 400); // View Upgrades, game [1600,1900], rendered [2000,2300]
        // designX 2100 over the button's rendered box; anchored map resolved 1700 (= 2100 − 400) ∈ the button.
        Check.Close(Push(1700, 550, 2100, backdrop, view), 1700, "View Upgrades over the backdrop → coord kept");

    }

    // (d) Dead space beside a +dx-shifted cluster with NO rect the pointer is visually over: the guard never fires
    // (no legit hit), so the near-miss still pushes the coord out of the button it mis-landed in. The guard only
    // suppresses a push when there IS a legit hit — it must not disable legitimate dead-space pushes.
    private static void DeadSpaceBesideShiftedClusterStillPushes()
    {
        var mapBtn = IRect("mapbtn", 1690, 15, 60, 60, 400); // game [1690,1750], rendered [2090,2150]
        var gear = IRect("gear", 1770, 15, 60, 60, 400); //     game [1770,1830], rendered [2170,2230]
        // designX 2100 sits in the dead gap left of the gear's rendered box; the coord 1800 landed inside the gear's
        // game box but the pointer is over NEITHER cluster rect → push out left of the gear (to 1769, the gap).
        Check.Close(Push(1800, 45, 2100, mapBtn, gear), 1769, "dead space beside the cluster → still pushes (1770 − 1)");
    }

    // (e) A stage-band rect the pointer IS over never vouches: the map screen's parchment tile (a wide, ≥0.95·1920
    // extent painter shifted +210) covers the TopBar band, so a coord that mis-mapped into a cross-frame Floor icon
    // must STILL be pushed out even though the pointer is legitimately over the parchment. Preserves the pre-fix
    // parchment-over-TopBar behavior (result is identical with the guard on or off).
    private static void StageBandRectNeverVouches()
    {
        var floor = IRect("floor", 792, 0, 89, 83, 0); // cross-frame icon, pinned, rendered [792,881]
        var parchment = IRect("parchment", 40, 0, 1850, 90, 210); // extent 1850 ≥ 1824 → stage-band, rendered [250,2100]
        // Pointer 1042 is over the parchment's rendered box; the exact map coord 832 (= 1042 − 210) landed in Floor.
        Check.Close(Push(832, 47, 1042, floor, parchment), 882, "stage-band parchment never vouches → Floor still pushes (881 + 1)");
    }

    // (f) A width-stretched blocker (renderedWidth > 0) above the target never vouches: a full-canvas `Game` ColorRect
    // painted on top contains every pointer, but it can't suppress the push of a lower near-missed button. Symmetric
    // with the existing never-OFFEND rule for stretched blockers (result identical with the guard on or off).
    private static void StretchedBlockerNeverVouches()
    {
        var button = IRect("btn", 800, 100, 200, 100, 400); // game [800,1000], rendered [1200,1400]
        var blocker = IRect("game", 0, 0, 1920, 1080, 0, 2340); // stretched full-canvas, rendered [0,2340], TOPMOST
        // designX 1150 (left of the button's rendered box) is over the blocker; the coord 900 landed in the button.
        Check.Close(Push(900, 150, 1150, button, blocker), 799, "stretched blocker never vouches → button still pushes (800 − 1)");
    }

    // (c) The Gold repro still pushes with the guard ON (default): the guard changes only the "skip a legit hit then
    // push from a lower offender" behavior; a genuine dead-space near-miss of a tooltip-only rect is untouched.
    private static void GoldReproUnchangedWithGuard()
    {
        var gold = IRect("gold", 330, 20, 140, 60, 0); // game [330,470], pinned tooltip-only rect
        Check.Close(Push(453, 50, 552, gold), 471, "Gold dead-space near-miss still pushes (470 + 1) with guard on");
        Check.Close(Push(400, 50, 400, gold), 400, "hovering Gold itself is a legit hit → no push");
    }

    // Handles a ROTATED (non-axis-aligned) rect via the affine inverse.
    private static void HandlesRotatedRect()
    {
        // A 90°-rotated square: global [0,1,-1,0,1200,100], 100×100 → game x∈[1100,1200], y∈[100,200]. Shift +300.
        var rotated = new InteractiveRectScan.InteractiveRect(
            "rot",
            [0, 1, -1, 0, 1200, 100],
            new MirrorRect(0, 0, 100, 100),
            300,
            0);
        // Pointer designX 1250 (left of rendered [1400,1500]); resolved (1150,150) inside the rotated game box.
        Check.Close(Push(1150, 150, 1250, rotated), 1099, "rotated left edge push (1100 - 1)");
    }
}
