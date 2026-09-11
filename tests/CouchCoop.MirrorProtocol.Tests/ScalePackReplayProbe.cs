using System.Diagnostics;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R8 (WS-1) HEADLESS live-data verification of the scale pack — no Godot, no display, no live lock. Each leg is
// env-gated on its own recorded mirror stream and SKIPS SILENTLY when unset (the suite stays green in a plain
// checkout). Modeled on EventOptionsScaleReplayProbe / CardRewardScaleReplayProbe.
//
//   COUCHCOOP_MIRROR_MAP_PROBE_NDJSON      — a capture showing the MAP screen (.sts2/bench/probe-map-visible.ndjson):
//                                            every normal_map_point.tscn root resolves 1.5 (unclamped, centre) and
//                                            NO ancient/boss point does; MapLegend resolves the 1.2 BottomRight GROUP.
//   COUCHCOOP_MIRROR_PILES_PROBE_NDJSON    — a COMBAT capture: draw/discard piles resolve 1.25 with their corner
//                                            pivots, and the resulting stamps keep the pinned corner FIXED and the
//                                            enlarged box on-screen.
//   COUCHCOOP_MIRROR_TREASURE_PROBE_NDJSON — a TREASURE-room capture: every NTreasureRoomRelicHolder resolves the
//                                            1.25 BottomCenter stamp, its scene ROOT file is registered so the native
//                                            presence gate fires, and the co-op vote icons are its DESCENDANTS (so
//                                            they ride the holder's stamp instead of needing a rule of their own).
//
// Every leg also reports the REAL design boxes + stamps it measured, so the numbers in the report come from the
// recording rather than from arithmetic on the spec.
internal static class ScalePackReplayProbe
{
    private const string NormalMapPoint = "res://scenes/ui/normal_map_point.tscn";
    private const string MapScreen = "res://scenes/screens/map/map_screen.tscn";
    private const string DrawPile = "res://scenes/combat/draw_pile.tscn";
    private const string DiscardPile = "res://scenes/combat/discard_pile.tscn";
    private const double W = 1920, H = 1080;

    public static void Run()
    {
        Map();
        Piles();
        Treasure();
    }

    // ---- map: normal points 1.5 + legend 1.2 BottomRight ----------------------------------------------------------
    private static void Map()
    {
        if (Load("COUCHCOOP_MIRROR_MAP_PROBE_NDJSON") is not { } state)
        {
            return;
        }

        Check.That(ViewScale.IsRootFile(NormalMapPoint) && ViewScale.IsRootFile(MapScreen),
            "[map-probe] the map's scene files are view-scale ROOT files (else the whole pass early-outs on the map)");

        var xf = Globals(state);
        int normal = 0, other = 0, legends = 0;
        DesignAabb firstPointBox = default, firstPointScaled = default;
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            var res = ViewScale.ResolveFor(id, state);
            var (file, relPath) = SceneIdentity.Resolve(id, state);

            if (node.SceneFilePath is { } own && own.Contains("map_point", StringComparison.Ordinal))
            {
                if (own == NormalMapPoint)
                {
                    normal++;
                    Check.Close(res.Scale, ViewScale.MapPointScale, "[map-probe] normal map point → 1.5");
                    Check.That(res.NoClamp, "[map-probe] normal map point is UNCLAMPED (the map scrolls)");
                    Check.That(res.Pivot == HoverTipScaleMath.AnchorPivot.Center, "[map-probe] map point grows about its centre");
                    Check.That(!res.IsGroup, "[map-probe] map point is a per-ITEM entry");
                    if (normal == 1 && Box(state, xf, id) is { } b)
                    {
                        firstPointBox = b;
                        firstPointScaled = Scaled(b, res);
                    }
                }
                else
                {
                    other++;
                    Check.That(!res.IsActive, $"[map-probe] {own} stays NEUTRAL (user decision: normal points only)");
                }
            }

            if (file == MapScreen && relPath == "MapLegend")
            {
                legends++;
                Check.Close(res.Scale, ViewScale.MapLegendScale, "[map-probe] MapLegend → 1.2");
                Check.That(res.IsGroup, "[map-probe] MapLegend is a GROUP");
                Check.That(res.Pivot == HoverTipScaleMath.AnchorPivot.BottomRight, "[map-probe] MapLegend pins its bottom-RIGHT corner");
                Check.That(res.NoClamp, "[map-probe] MapLegend is UNCLAMPED");
                if (Box(state, xf, id) is { } lb)
                {
                    var s = Stamp(lb, res);
                    var sc = Scaled(lb, res);
                    Console.Error.WriteLine(
                        $"[map-probe] MapLegend box=({lb.MinX:0.#},{lb.MinY:0.#})-({lb.MaxX:0.#},{lb.MaxY:0.#}) " +
                        $"→ scaled ({sc.MinX:0.#},{sc.MinY:0.#})-({sc.MaxX:0.#},{sc.MaxY:0.#}) clamp=({s.ClampX:0.##},{s.ClampY:0.##})");
                    Check.Close(sc.MaxX, lb.MaxX, "[map-probe] MapLegend's RIGHT edge is unchanged by the stamp", 1e-3);
                    Check.Close(sc.MaxY, lb.MaxY, "[map-probe] MapLegend's BOTTOM edge is unchanged by the stamp", 1e-3);
                    Check.That(sc.MinX < lb.MinX && sc.MinY < lb.MinY, "[map-probe] MapLegend grows LEFT and UP into free space");
                }
            }
        }

        Console.Error.WriteLine(
            $"[map-probe] {state.Nodes.Count} nodes; {normal} normal map point(s) @1.5, {other} ancient/boss point(s) untouched, " +
            $"{legends} legend(s); first point box=({firstPointBox.MinX:0.#},{firstPointBox.MinY:0.#})-({firstPointBox.MaxX:0.#},{firstPointBox.MaxY:0.#}) " +
            $"→ ({firstPointScaled.MinX:0.#},{firstPointScaled.MinY:0.#})-({firstPointScaled.MaxX:0.#},{firstPointScaled.MaxY:0.#})");

        Check.That(normal >= 1, "[map-probe] the recording shows at least one normal map point");
        Check.That(legends == 1, "[map-probe] the recording shows exactly one MapLegend");
        Check.Close(firstPointScaled.MaxX - firstPointScaled.MinX, 1.5 * (firstPointBox.MaxX - firstPointBox.MinX),
            "[map-probe] a scaled map point is exactly 1.5× wider (56 → 84 design px)", 1e-3);
    }

    // ---- combat corner piles: 1.25 with a pinned bottom corner ----------------------------------------------------
    private static void Piles()
    {
        if (Load("COUCHCOOP_MIRROR_PILES_PROBE_NDJSON") is not { } state)
        {
            return;
        }

        Check.That(ViewScale.IsRootFile(DrawPile) && ViewScale.IsRootFile(DiscardPile),
            "[piles-probe] both pile scenes are view-scale ROOT files (else the pass early-outs in combat)");

        var xf = Globals(state);
        int found = 0;
        foreach (var id in state.OrderedIds)
        {
            if (state.Nodes.GetValueOrDefault(id) is not { SceneFilePath: { } f } || (f != DrawPile && f != DiscardPile))
            {
                continue;
            }

            var res = ViewScale.ResolveFor(id, state);
            Check.Close(res.Scale, ViewScale.PileScale, "[piles-probe] pile → 1.25");
            bool left = f == DrawPile;
            Check.That(
                res.Pivot == (left ? HoverTipScaleMath.AnchorPivot.BottomLeft : HoverTipScaleMath.AnchorPivot.BottomRight),
                "[piles-probe] pile pins the bottom corner it sits in");

            if (Box(state, xf, id) is not { } b)
            {
                continue;
            }

            found++;
            var sc = Scaled(b, res);
            Console.Error.WriteLine(
                $"[piles-probe] {(left ? "draw" : "discard")} box=({b.MinX:0.#},{b.MinY:0.#})-({b.MaxX:0.#},{b.MaxY:0.#}) " +
                $"→ ({sc.MinX:0.#},{sc.MinY:0.#})-({sc.MaxX:0.#},{sc.MaxY:0.#})");
            Check.Close(sc.MaxY, b.MaxY, "[piles-probe] the pile's BOTTOM edge never moves", 1e-3);
            Check.Close(left ? sc.MinX : sc.MaxX, left ? b.MinX : b.MaxX,
                "[piles-probe] the pile's OUTER edge never moves (it stays glued to the screen corner)", 1e-3);
            Check.That(sc.MinX >= 0 && sc.MaxX <= W && sc.MinY >= 0 && sc.MaxY <= H,
                "[piles-probe] the enlarged pile stays fully on-screen");
        }

        // Cost note: adding the piles makes the native presence gate TRUE for all of combat, so the per-node resolve
        // now runs every drain in combat. Measure it here so the regression is a number, not a guess.
        for (int i = 0; i < 10; i++)
        {
            foreach (var id in state.OrderedIds)
            {
                _ = ViewScale.ResolveFor(id, state); // warm-up (JIT tier-up), excluded from the timing below
            }
        }

        var sw = Stopwatch.StartNew();
        const int reps = 20;
        int active = 0;
        for (int i = 0; i < reps; i++)
        {
            foreach (var id in state.OrderedIds)
            {
                if (ViewScale.ResolveFor(id, state).IsActive)
                {
                    active++;
                }
            }
        }

        sw.Stop();
        Console.Error.WriteLine(
            $"[piles-probe] {found} pile(s) stamped; whole-tree ViewScale.ResolveFor over {state.OrderedIds.Count} combat nodes " +
            $"= {sw.Elapsed.TotalMilliseconds / reps:0.###} ms/drain ({active / reps} active)");

        // R9 (WS-B): still 2, NOT 3, even though the exhaust pile is now a view-scale entry too. Its root
        // (exhaust_pile.tscn / NExhaustPileButton, box (1830,800)-(1910,880)) is `visible:false` in EVERY recording on
        // this machine — the game only shows the pile once something has actually been exhausted — so no capture can
        // exercise it and this leg deliberately keeps probing the two CORNER piles only. The exhaust entry's geometry
        // is pinned by ViewScaleTests.ExhaustPileMatchesMiddleRightEdgePivot (against that measured box) and was
        // validated live instead; if a future combat capture is recorded WITH a non-empty exhaust pile, add it here.
        Check.That(found == 2, "[piles-probe] the combat recording shows BOTH corner piles");
        PileTapRemap(state, xf);
    }

    // The CORNER-ORIGIN hit target, proved end-to-end on real combat geometry: reconstruct the input-gate registry the
    // native ViewScaler publishes for the two per-item pile stamps, then check the tap path (ViewScaleInput.Remap, the
    // same call InputRouter makes) at points a centre-only check could never discriminate.
    //
    // Why these points: a stamp's PIVOT is a fixed point of the scale, so the pinned corner itself taps correctly even
    // if the inverse were broken (see godot-client/docs/qa-channel.md's dumptap convention). The discriminating probes
    // are the enlarged button's VISUAL centre and the far corner of its enlarged halo — the band that is only tappable
    // BECAUSE of the inverse.
    private static void PileTapRemap(MirrorState state, GlobalTransformIndex xf)
    {
        var spread = new SpreadIndex();
        spread.Update(state, xf, 1); // desktop 16:9

        var applied = new List<ViewScaleInputRegistry.Applied>();
        var stamped = new HashSet<string>(StringComparer.Ordinal);
        var boxes = new Dictionary<string, (DesignAabb Box, HoverTipScaleMath.Stamp Stamp, bool Left)>(StringComparer.Ordinal);
        foreach (var id in state.OrderedIds)
        {
            if (state.Nodes.GetValueOrDefault(id) is not { SceneFilePath: { } f } || (f != DrawPile && f != DiscardPile))
            {
                continue;
            }

            var res = ViewScale.ResolveFor(id, state);
            if (Box(state, xf, id) is not { } b)
            {
                continue;
            }

            var s = Stamp(b, res);
            applied.Add(new ViewScaleInputRegistry.Applied(id, s, b, ViewScaleInputRegistry.ScaledBox(b, s), IsGroup: false));
            stamped.Add(id);
            boxes[id] = (b, s, f == DrawPile);
        }

        var registry = ViewScaleInputRegistry.Build(state, xf, spread, applied, stamped, W);
        Check.That(registry.Count == 2, "[piles-tap] both pile stamps reach the input registry");

        foreach (var (id, (box, s, left)) in boxes)
        {
            var scaled = ViewScaleInputRegistry.ScaledBox(box, s);
            string label = left ? "draw" : "discard";

            // 1. The PINNED corner is the stamp's fixed point → a tap there is identity (that IS the corner origin).
            double px = left ? box.MinX : box.MaxX;
            var (fx, fy) = ViewScaleInput.Remap(px, box.MaxY, registry);
            Check.Close(fx, px, $"[piles-tap] {label}: the pinned corner is a fixed point in X", 0.01);
            Check.Close(fy, box.MaxY, $"[piles-tap] {label}: the pinned corner is a fixed point in Y", 0.01);

            // 2. The enlarged button's VISUAL centre must un-map to the TRUE centre (non-identity, off-pivot).
            double vcx = (scaled.MinX + scaled.MaxX) / 2.0, vcy = (scaled.MinY + scaled.MaxY) / 2.0;
            double tcx = (box.MinX + box.MaxX) / 2.0, tcy = (box.MinY + box.MaxY) / 2.0;
            var (rx, ry) = ViewScaleInput.Remap(vcx, vcy, registry);
            Check.That(Math.Abs(rx - vcx) > 0.5 || Math.Abs(ry - vcy) > 0.5,
                $"[piles-tap] {label}: a tap on the enlarged button's visual centre is REMAPPED (non-identity)");
            Check.Close(rx, tcx, $"[piles-tap] {label}: remapped X lands on the true centre", 0.01);
            Check.Close(ry, tcy, $"[piles-tap] {label}: remapped Y lands on the true centre", 0.01);

            // 3. The far corner of the enlarged HALO — the band that only became tappable because of the stamp — must
            //    un-map INSIDE the true (game) box, i.e. the game still hit-tests the button.
            double hx = left ? scaled.MaxX - 1 : scaled.MinX + 1;
            var (hrx, hry) = ViewScaleInput.Remap(hx, scaled.MinY + 1, registry);
            Check.That(hrx >= box.MinX && hrx <= box.MaxX && hry >= box.MinY && hry <= box.MaxY,
                $"[piles-tap] {label}: a tap in the enlarged halo un-maps INSIDE the true button box");

            // 4. And it actually hit-tests the pile's own subtree through the shared scan.
            var hittable = TouchTargetScan.HittableIdsAt(state, xf, hrx, hry, i => spread.TryGet(i, out var r) ? r : null);
            bool hits = false;
            foreach (var hid in hittable)
            {
                for (var cur = state.Nodes.GetValueOrDefault(hid); cur is not null;
                     cur = cur.ParentId is { } pid ? state.Nodes.GetValueOrDefault(pid) : null)
                {
                    if (cur.Id == id)
                    {
                        hits = true;
                        break;
                    }
                }

                if (hits)
                {
                    break;
                }
            }

            Console.Error.WriteLine(
                $"[piles-tap] {label} {id}: true centre=({tcx:0.#},{tcy:0.#}) visual centre=({vcx:0.#},{vcy:0.#}) " +
                $"→ remap=({rx:0.#},{ry:0.#}); halo=({hx:0.#},{scaled.MinY + 1:0.#}) → ({hrx:0.#},{hry:0.#}) hitsSubtree={hits}");
            Check.That(hits, $"[piles-tap] {label}: the remapped halo tap hit-tests the pile's subtree");
        }

        // A TopBar overlay is a legitimate un-scaled neighbour drawn over combat → a tap on it stays identity.
        foreach (var id in state.OrderedIds)
        {
            if (state.Nodes.GetValueOrDefault(id) is not { SceneFilePath: { } tf, MouseFilter: 0 or 1 } node
                || !tf.EndsWith("top_bar.tscn", StringComparison.Ordinal) || Box(state, xf, id) is not { } tb)
            {
                continue;
            }

            double cx = (tb.MinX + tb.MaxX) / 2.0, cy = (tb.MinY + tb.MaxY) / 2.0;
            var (ox, oy) = ViewScaleInput.Remap(cx, cy, registry);
            Check.Close(ox, cx, "[piles-tap] a TopBar overlay tap stays identity X", 0.01);
            Check.Close(oy, cy, "[piles-tap] a TopBar overlay tap stays identity Y", 0.01);
            break;
        }
    }

    // ---- treasure room: the relic HOLDER leaf rule ----------------------------------------------------------------
    private static void Treasure()
    {
        if (Load("COUCHCOOP_MIRROR_TREASURE_PROBE_NDJSON") is not { } state)
        {
            return;
        }

        var xf = Globals(state);
        int holders = 0, votesUnderHolders = 0;
        bool gateFires = false;
        foreach (var node in state.Nodes.Values)
        {
            if (node.SceneFilePath is { } f && ViewScale.IsRootFile(f))
            {
                gateFires = true;
                break;
            }
        }

        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            if (ViewScale.IsTreasureRoomRelic(id, state))
            {
                holders++;
                var res = ViewScale.ResolveFor(id, state);
                Check.Close(res.Scale, ViewScale.TreasureRelicScale, "[treasure-probe] relic holder → 1.25");
                Check.That(res.Pivot == HoverTipScaleMath.AnchorPivot.BottomCenter, "[treasure-probe] relic grows UP from its bottom");
                Check.That(!res.IsGroup, "[treasure-probe] the relic holder is a per-ITEM stamp (children ride it)");
                if (Box(state, xf, id) is { } b)
                {
                    var sc = Scaled(b, res);
                    Console.Error.WriteLine(
                        $"[treasure-probe] holder {id} box=({b.MinX:0.#},{b.MinY:0.#})-({b.MaxX:0.#},{b.MaxY:0.#}) " +
                        $"→ ({sc.MinX:0.#},{sc.MinY:0.#})-({sc.MaxX:0.#},{sc.MaxY:0.#})");
                    Check.Close(sc.MaxY, b.MaxY, "[treasure-probe] the relic's BOTTOM (its pedestal contact) never moves", 1e-3);
                }

                continue;
            }

            // A co-op vote widget must be a DESCENDANT of a holder (so it rides the stamp) and must never resolve a
            // stamp of its own — its scene is reused by the map points + the ProceedButton.
            if (node.SceneFilePath is { } vf && vf.Contains("multiplayer_vote_container", StringComparison.Ordinal))
            {
                Check.That(!ViewScale.ResolveFor(id, state).IsActive,
                    "[treasure-probe] a vote container never resolves its OWN view-scale stamp");
                for (var cur = node.ParentId is { } pid ? state.Nodes.GetValueOrDefault(pid) : null; cur is not null;
                     cur = cur.ParentId is { } ppid ? state.Nodes.GetValueOrDefault(ppid) : null)
                {
                    if (ViewScale.IsTreasureRoomRelic(cur.Id, state))
                    {
                        votesUnderHolders++;
                        break;
                    }
                }
            }
        }

        Console.Error.WriteLine(
            $"[treasure-probe] {state.Nodes.Count} nodes; {holders} relic holder(s) @{ViewScale.TreasureRelicScale}; " +
            $"{votesUnderHolders} vote container(s) under a holder; presence gate fires = {gateFires}");

        Check.That(holders >= 1, "[treasure-probe] the recording shows at least one treasure-room relic holder");
        Check.That(gateFires,
            "[treasure-probe] at least one ROOT file is present on the treasure screen (else the native pass early-outs and the leaf rule never runs)");
    }

    // ---- helpers ---------------------------------------------------------------------------------------------------

    private static MirrorState? Load(string envVar)
    {
        var path = Environment.GetEnvironmentVariable(envVar);
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return null;
        }

        var state = ReplayProbeSupport.Replay(path).State;
        AssertPrefilterEquivalence(state, envVar);
        return state;
    }

    // R8 cost gate soundness, checked against REAL trees: ResolveFor(id, state) now skips the scene-identity walk for a
    // node that cannot match the table (ViewScale.MightMatchTable). Over every node of the recording, whatever the
    // UNFILTERED table lookup would have produced must still be what the filtered resolve returns.
    private static void AssertPrefilterEquivalence(MirrorState state, string label)
    {
        int checkedNodes = 0, tableHits = 0;
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.ContainsKey(id))
            {
                continue;
            }

            checkedNodes++;
            var (file, relPath) = SceneIdentity.Resolve(id, state);
            var slow = ViewScale.ResolveFor(file, relPath); // the un-filtered table lookup
            if (!slow.IsActive)
            {
                continue;
            }

            tableHits++;
            Check.That(ViewScale.ResolveFor(id, state) == slow,
                $"[{label}] pre-filtered resolve == un-filtered table resolve for node {id} ({file} :: {relPath})");
        }

        Console.Error.WriteLine($"[prefilter] {label}: {checkedNodes} nodes checked, {tableHits} table hit(s), all equivalent");
    }

    private static GlobalTransformIndex Globals(MirrorState state)
    {
        var xf = new GlobalTransformIndex();
        xf.Update(state);
        return xf;
    }

    // The node's design AABB the ViewScaler would measure (its own LocalRect through its global transform). These
    // recordings are 16:9, so there is no spread shift to fold.
    private static DesignAabb? Box(MirrorState state, GlobalTransformIndex xf, string id)
    {
        if (state.Nodes.GetValueOrDefault(id) is not { LocalRect: { } lr } || lr.Width <= 0 || lr.Height <= 0
            || !xf.TryGetGlobal(id, out var g))
        {
            return null;
        }

        double MinOf(double a, double b, double c, double d) => Math.Min(Math.Min(a, b), Math.Min(c, d));
        double MaxOf(double a, double b, double c, double d) => Math.Max(Math.Max(a, b), Math.Max(c, d));
        (double X, double Y) P(double x, double y) => (g[0] * x + g[2] * y + g[4], g[1] * x + g[3] * y + g[5]);
        var c0 = P(lr.X, lr.Y);
        var c1 = P(lr.X + lr.Width, lr.Y);
        var c2 = P(lr.X, lr.Y + lr.Height);
        var c3 = P(lr.X + lr.Width, lr.Y + lr.Height);
        return new DesignAabb(
            MinOf(c0.X, c1.X, c2.X, c3.X), MinOf(c0.Y, c1.Y, c2.Y, c3.Y),
            MaxOf(c0.X, c1.X, c2.X, c3.X), MaxOf(c0.Y, c1.Y, c2.Y, c3.Y));
    }

    private static HoverTipScaleMath.Stamp Stamp(DesignAabb box, ViewScale.Resolved res) =>
        HoverTipScaleMath.ComputeAnchoredStamp(
            box, res.Scale, W, H, res.Pivot, res.TranslateX, res.TranslateY, res.NoClamp)!.Value;

    private static DesignAabb Scaled(DesignAabb box, ViewScale.Resolved res)
    {
        var s = Stamp(box, res);
        (double X, double Y) F(double x, double y) =>
            (s.PivotX + (s.Scale * (x - s.PivotX)) + s.ClampX, s.PivotY + (s.Scale * (y - s.PivotY)) + s.ClampY);
        var lo = F(box.MinX, box.MinY);
        var hi = F(box.MaxX, box.MaxY);
        return new DesignAabb(Math.Min(lo.X, hi.X), Math.Min(lo.Y, hi.Y), Math.Max(lo.X, hi.X), Math.Max(lo.Y, hi.Y));
    }
}
