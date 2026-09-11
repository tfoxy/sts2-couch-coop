using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R6 (WS-TIP) HEADLESS live-data verification of the COMPOSED tip owner-follow over recorded mirror streams — no Godot,
// no display, no live lock. It reconstructs, purely from the retained MirrorState, the SAME view-scale stamps the native
// ViewScaler publishes (the 1.10 card-reward GROUP + each per-card 1.15, the reward-LIST 1.2 items), then exercises
// ViewScaleInputRegistry.MapThroughContainingStamps — the exact map HoverTipScaler.MeasureOwner uses to glue a tip to a
// view-scaled owner — and asserts the tip ANCHOR lands on the VISUAL card box.
//
// Env (each skips SILENTLY when unset/absent, so a plain checkout stays green):
//   COUCHCOOP_MIRROR_REWARDTIP_PROBE_NDJSON        — card-reward recording (audit-cardreward-open.ndjson): a SIDE card's
//                                                    tip anchor follows the group displacement 0.10·(c−S) (the fix); a
//                                                    single per-card map would leave it fixed (the bug).
//   COUCHCOOP_MIRROR_REWARDTIP_LIST_PROBE_NDJSON   — post-combat reward LIST (r2smoke-reward-*.ndjson): a reward row's
//                                                    tip anchor lands on the enlarged (×1.2) visual row (single stamp,
//                                                    composed path still works — no group present).
//   COUCHCOOP_MIRROR_REWARDTIP_NONREG_PROBE_NDJSON — a NON view-scale screen (wscrisp-hovertip / r4fix-trash-tip): NO
//                                                    stamp covers any tip owner → the map is a no-op (tips do NOT move).
internal static class RewardTipComposeReplayProbe
{
    private const double W = 1920, H = 1080;

    public static void Run()
    {
        Cardreward(Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_REWARDTIP_PROBE_NDJSON"));
        RewardList(Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_REWARDTIP_LIST_PROBE_NDJSON"));
        NonRegression(Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_REWARDTIP_NONREG_PROBE_NDJSON"));
    }

    // ---- card-reward: the group ∘ card composition ----

    private static void Cardreward(string? path)
    {
        if (!Load(path, out var ctx))
        {
            return;
        }

        Check.That(ctx.GroupCount >= 1, "[rewardtip-probe] found the card-reward GROUP stamp (1.10)");
        var cards = ctx.FindCardRewardCards();
        Check.That(cards.Count >= 3, "[rewardtip-probe] found ≥3 reward cards");
        cards.Sort((a, b) => ctx.CenterX(a).CompareTo(ctx.CenterX(b)));

        double sX = ctx.GroupPivotX;
        int moved = 0;
        foreach (var side in new[] { cards[0], cards[^1] })
        {
            var raw = ctx.MeasureViewScaleBox(side)!.Value;
            double cCx = (raw.MinX + raw.MaxX) / 2.0;
            bool ok = ctx.MapOwner(side, raw, out var mapped);
            Check.That(ok, $"[rewardtip-probe] side card {side} is covered by a containing stamp");
            double mCx = (mapped.MinX + mapped.MaxX) / 2.0;

            // The composed anchor follows the group displacement 0.10·(c−S) (± a small slack for real box measurement).
            Check.That(Math.Abs((mCx - cCx) - 0.10 * (cCx - sX)) < 2.0,
                $"[rewardtip-probe] side card {side}: composed X displacement ≈ 0.10·(c−S)");

            // The composed box is bigger than a group-only map — the per-card 1.15 is folded in too.
            var groupOnly = ViewScaleInputRegistry.ScaledBox(raw, ctx.GroupStamp);
            Check.That((mapped.MaxX - mapped.MinX) > (groupOnly.MaxX - groupOnly.MinX) + 1,
                $"[rewardtip-probe] side card {side}: composed box larger than group-only (per-card folded in)");

            // The pre-R6 single per-card map is centre-fixed (the bug): a genuinely off-centre side card must show a
            // non-trivial follow that the old exact-id map would have missed.
            if (Math.Abs(cCx - sX) > 50)
            {
                Check.That(Math.Abs(mCx - cCx) > 3,
                    $"[rewardtip-probe] side card {side}: anchor genuinely MOVES (old per-card map gave 0)");
                moved++;
            }

            Console.Error.WriteLine(
                $"[rewardtip-probe] card {side}: rawCx={cCx:0.#} S={sX:0.#} mappedCx={mCx:0.#} follow={mCx - cCx:0.#} " +
                $"(expect {0.10 * (cCx - sX):0.#})");
        }

        Check.That(moved >= 1, "[rewardtip-probe] at least one side card is off-pivot and followed the group");
        Console.Error.WriteLine($"[rewardtip-probe] OK — {ctx.GroupCount} group(s), {cards.Count} reward cards, {moved} moved");
    }

    // ---- post-combat reward LIST: single-stamp composition still lands on the enlarged row ----

    private static void RewardList(string? path)
    {
        if (!Load(path, out var ctx))
        {
            return;
        }

        var rows = ctx.FindLeaves("NRewardButton");
        Check.That(rows.Count >= 1, "[rewardtip-probe list] found ≥1 reward row (NRewardButton)");
        int enlarged = 0;
        foreach (var row in rows)
        {
            if (ctx.MeasureViewScaleBox(row) is not { } raw)
            {
                continue;
            }

            if (!ctx.MapOwner(row, raw, out var mapped))
            {
                continue; // off-stage / degenerate row → skip
            }

            // The reward row enlarges ×1.2 about its own centre (a single stamp, no group) → the tip anchor lands on
            // the ×1.2 visual row (width grows; centre stays put unless the on-screen clamp nudges it near an edge).
            Check.That((mapped.MaxX - mapped.MinX) > (raw.MaxX - raw.MinX) + 1,
                $"[rewardtip-probe list] row {row}: tip anchor box is the ENLARGED (×1.2) visual row");
            enlarged++;
        }

        Check.That(enlarged >= 1, "[rewardtip-probe list] at least one reward row mapped to its enlarged visual box");
        Console.Error.WriteLine($"[rewardtip-probe list] OK — {rows.Count} rows, {enlarged} enlarged");
    }

    // ---- non-regression: a tip outside every view-scale screen must NOT move ----

    private static void NonRegression(string? path)
    {
        if (!Load(path, out var ctx))
        {
            return;
        }

        Check.That(ctx.GroupCount == 0 && ctx.AppliedCount == 0,
            "[rewardtip-probe nonreg] no view-scale stamps present on this screen");

        int owners = 0, moved = 0;
        foreach (var id in ctx.State.OrderedIds)
        {
            if (!ctx.State.Nodes.TryGetValue(id, out var node) || Leaf(node.NodeType) != "NHoverTipSet")
            {
                continue;
            }

            string? ownerId = node.AnchorOwnerId;
            if (ownerId is null || ctx.MeasureViewScaleBox(ownerId) is not { } raw)
            {
                continue;
            }

            owners++;
            bool ok = ctx.MapOwner(ownerId, raw, out var mapped);
            Check.That(!ok, $"[rewardtip-probe nonreg] tip owner {ownerId} has NO covering stamp");
            if (Math.Abs((mapped.MinX + mapped.MaxX) / 2.0 - (raw.MinX + raw.MaxX) / 2.0) > 0.001)
            {
                moved++;
            }
        }

        Check.That(moved == 0, "[rewardtip-probe nonreg] no tip owner moved");
        Console.Error.WriteLine($"[rewardtip-probe nonreg] OK — {owners} tip owner(s), 0 moved");
    }

    // ---- replay + stamp reconstruction ----

    private static bool Load(string? path, out Ctx ctx)
    {
        ctx = null!;
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return false;
        }

        var state = MirrorState.Create();
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            string payload = line;
            if (line.StartsWith("{\"t\"", StringComparison.Ordinal))
            {
                using var doc = JsonDocument.Parse(line);
                if (!doc.RootElement.TryGetProperty("data", out var d) || d.GetString() is not { } inner)
                {
                    continue;
                }

                payload = inner;
            }

            var delta = SceneDeltaReader.Parse(payload);
            if (delta is null)
            {
                continue;
            }

            SceneTreeApplier.ApplySceneDelta(state, delta);
        }

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);
        var spread = new SpreadIndex();
        spread.Update(state, transforms, 1);
        ctx = new Ctx(state, transforms, spread);
        return true;
    }

    private sealed class Ctx
    {
        public readonly MirrorState State;
        private readonly GlobalTransformIndex _t;
        private readonly SpreadIndex _sp;
        private readonly List<ViewScaleInputRegistry.Applied> _applied = new();

        public int GroupCount { get; }
        public int AppliedCount => _applied.Count;
        public HoverTipScaleMath.Stamp GroupStamp { get; }
        public double GroupPivotX => GroupStamp.PivotX;

        public Ctx(MirrorState state, GlobalTransformIndex t, SpreadIndex sp)
        {
            State = state;
            _t = t;
            _sp = sp;

            // Reconstruct EVERY applied stamp exactly as ViewScaler.Apply would (group → own box; per-item/per-card →
            // paint box, degenerate NCard → nominal box about the design origin) — group + reward-list + per-card.
            foreach (var id in state.OrderedIds)
            {
                if (!state.Nodes.TryGetValue(id, out var node) || !EffectivelyVisible(state, node))
                {
                    continue;
                }

                var res = ViewScale.ResolveFor(id, state);
                if (!res.IsActive)
                {
                    continue;
                }

                if (MeasureBox(id, res.IsGroup) is not { } box || box.FullyOutside(W, H, 0))
                {
                    continue;
                }

                var stamp = HoverTipScaleMath.ComputeAnchoredStamp(
                    box, res.Scale, W, H, res.Pivot, res.TranslateX, res.TranslateY, res.NoClamp);
                if (stamp is not { } s)
                {
                    continue;
                }

                _applied.Add(new ViewScaleInputRegistry.Applied(id, s, box, ViewScaleInputRegistry.ScaledBox(box, s), res.IsGroup));
                if (res.IsGroup && Leaf(node.NodeType) == "NCardRewardSelectionScreen")
                {
                    GroupCount++;
                    GroupStamp = s;
                }
            }
        }

        public bool MapOwner(string ownerId, DesignAabb raw, out DesignAabb mapped) =>
            ViewScaleInputRegistry.MapThroughContainingStamps(State, _applied, ownerId, raw, out mapped);

        public List<string> FindCardRewardCards()
        {
            var output = new List<string>();
            foreach (var id in State.OrderedIds)
            {
                if (ViewScale.IsCardRewardCard(id, State) && MeasureViewScaleBox(id) is not null)
                {
                    output.Add(id);
                }
            }

            return output;
        }

        public List<string> FindLeaves(string leaf)
        {
            var output = new List<string>();
            foreach (var id in State.OrderedIds)
            {
                if (State.Nodes.TryGetValue(id, out var n) && EffectivelyVisible(State, n) && Leaf(n.NodeType) == leaf)
                {
                    output.Add(id);
                }
            }

            return output;
        }

        public double CenterX(string id)
        {
            var b = MeasureViewScaleBox(id)!.Value;
            return (b.MinX + b.MaxX) / 2.0;
        }

        // The box the tip owner-follow measures: the node's own paint rect (design-folded), or — for a degenerate 0×0
        // NCard whose art lives in descendants — a nominal card box about its design origin (the web-twin nominal box).
        public DesignAabb? MeasureViewScaleBox(string id) => MeasureBox(id, isGroup: false);

        private DesignAabb? MeasureBox(string id, bool isGroup)
        {
            if (!State.Nodes.TryGetValue(id, out var node) || !_t.TryGetGlobal(id, out var g))
            {
                return null;
            }

            double dx = _sp.TryGet(id, out var rec) ? rec.Dx : 0;
            if (node.LocalRect is { } lr && lr.Width > 0 && lr.Height > 0)
            {
                double width = isGroup && rec.RenderedWidth > 0 ? rec.RenderedWidth : lr.Width;
                return CullBounds.OfRect(g, lr.X, lr.Y, width, lr.Height).ShiftX(dx);
            }

            if (isGroup)
            {
                return null; // a group must have a real box
            }

            // Degenerate NCard: nominal 240×338 about the design origin (matches the web nominal box + native union centre).
            double cx = g[4] + dx, cy = g[5];
            return new DesignAabb(cx - 120, cy - 169, cx + 120, cy + 169);
        }
    }

    private static bool EffectivelyVisible(MirrorState state, MirrorNode node)
    {
        for (var cur = node; cur is not null;
             cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var p) ? p : null)
        {
            if (!cur.Visible)
            {
                return false;
            }
        }

        return true;
    }

    private static string Leaf(string nodeType)
    {
        int dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }
}
