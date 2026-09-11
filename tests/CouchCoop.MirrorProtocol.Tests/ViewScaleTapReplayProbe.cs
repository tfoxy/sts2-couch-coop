using System.Text.Json;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R5 (WS-A) HEADLESS live-data verification of the view-scale TAP remap over recorded mirror streams — no Godot, no
// display, no live lock. It reconstructs, purely from the retained MirrorState, the SAME input-gate registry the
// native ViewScaler publishes (group stamps + ViewScaleInputRegistry.Build with the neighbour filter), then proves the
// end-to-end tap path: forward-map an OFF-PIVOT element's TRUE centre to the VISUAL point the user actually taps, and
// assert ViewScaleInput.Remap there is NON-identity and resolves back to that element. A centre point ON the pivot axis
// (the middle card / the Skip button's X) is a fixed point and cannot discriminate, so the probe deliberately targets
// the LEFT/RIGHT reward cards and the Skip button's rendered Y.
//
// Env (each skips SILENTLY when unset/absent, so a plain checkout stays green):
//   COUCHCOOP_MIRROR_VIEWSCALE_TAP_PROBE_NDJSON        — card-reward recording (Skip + side cards + TopBar identity + enclosure)
//   COUCHCOOP_MIRROR_VIEWSCALE_TAP_PROBE_SHOP_NDJSON   — shop recording (leftmost + rightmost item)
//   COUCHCOOP_MIRROR_VIEWSCALE_TAP_PROBE_EVENT_NDJSON  — event recording (most-displaced option row)
internal static class ViewScaleTapReplayProbe
{
    private const double W = 1920, H = 1080;

    public static void Run()
    {
        Cardreward(System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_VIEWSCALE_TAP_PROBE_NDJSON"));
        Shop(System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_VIEWSCALE_TAP_PROBE_SHOP_NDJSON"));
        EventScreen(System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_VIEWSCALE_TAP_PROBE_EVENT_NDJSON"));
    }

    // ---- card-reward ----

    private static void Cardreward(string? path)
    {
        if (!Load(path, out var ctx))
        {
            return;
        }

        // The Skip / alternative button (off pivot in Y) and every reward-card hitbox (off pivot in X for the side ones).
        var skip = ctx.FindVisible(leaf: "NCardRewardAlternativeButton");
        var hitboxes = ctx.FindAllVisible(leaf: "NCardHolderHitbox", underLeaf: "NCardRewardSelectionScreen");
        Check.That(skip is not null, "[tap-probe cardreward] found the Skip/alternative button");
        Check.That(hitboxes.Count >= 3, "[tap-probe cardreward] found ≥3 reward-card hitboxes");

        // The Skip button (its X is the pivot, its Y is well below centre → the discriminating axis).
        AssertRemapsToElement(ctx, skip!, "Skip");

        // The left + right cards (the discriminating X axis). Middle card sits on the pivot X (fixed point) → skipped.
        hitboxes.Sort((a, b) => ctx.CenterX(a).CompareTo(ctx.CenterX(b)));
        AssertRemapsToElement(ctx, hitboxes[0], "left card");
        AssertRemapsToElement(ctx, hitboxes[^1], "right card");

        // A TopBar overlay (deck / gold button) is a LEGITIMATE neighbour → a tap on it stays identity.
        var topbar = ctx.FindVisible(sceneSuffix: "top_bar.tscn", interactiveOnly: true);
        if (topbar is not null)
        {
            var (tx, ty) = ctx.Center(topbar);
            var (rx, ry) = ViewScaleInput.Remap(tx, ty, ctx.RegistryOn);
            Check.Close(rx, tx, "[tap-probe cardreward] TopBar overlay tap stays identity X");
            Check.Close(ry, ty, "[tap-probe cardreward] TopBar overlay tap stays identity Y");
        }

        // No surviving neighbour of the reward-screen group encloses the group's pre-scale DesignBox.
        foreach (var s in ctx.RegistryOn)
        {
            if (!s.IsGroup)
            {
                continue;
            }

            foreach (var nb in s.NeighborRects)
            {
                Check.That(!ViewScaleInputRegistry.EnclosesDesignBox(nb, s.OriginalBox),
                    "[tap-probe cardreward] no surviving group neighbour encloses the group box");
            }
        }

        System.Console.Error.WriteLine($"[tap-probe cardreward] OK — {ctx.Groups} group(s), skip + {hitboxes.Count} cards remapped");
    }

    // ---- shop ----

    private static void Shop(string? path)
    {
        if (!Load(path, out var ctx))
        {
            return;
        }

        var items = ctx.FindAllVisible(leaves: ["NMerchantCard", "NMerchantRelic", "NMerchantPotion"], underLeaf: null);
        Check.That(items.Count >= 2, "[tap-probe shop] found ≥2 merchant items");
        items.Sort((a, b) => ctx.CenterX(a).CompareTo(ctx.CenterX(b)));
        AssertRemapsToElement(ctx, items[0], "leftmost item");
        AssertRemapsToElement(ctx, items[^1], "rightmost item");
        string shopNote = ctx.Groups > 0 ? "items remapped through the SlotsContainer group" : "SlotsContainer off-stage (production reject) → identity non-regression";
        System.Console.Error.WriteLine($"[tap-probe shop] OK — {ctx.Groups} group(s), {items.Count} items; {shopNote}");
    }

    // ---- event (regular + ancient) ----

    private static void EventScreen(string? path)
    {
        if (!Load(path, out var ctx))
        {
            return;
        }

        var options = ctx.FindAllVisible(leaf: "NEventOptionButton", underLeaf: null);
        Check.That(options.Count >= 1, "[tap-probe event] found ≥1 event option");
        // The option furthest from the group pivot (the most-displaced row) — the most discriminating tap.
        options.Sort((a, b) => ctx.DisplacementFromGroup(b).CompareTo(ctx.DisplacementFromGroup(a)));
        AssertRemapsToElement(ctx, options[0], "most-displaced option");
        string evNote = ctx.Groups > 0 ? "remapped through the OptionsContainer group" : "no options group (combat/degenerate event) → identity non-regression";
        System.Console.Error.WriteLine($"[tap-probe event] OK — {ctx.Groups} group(s), {options.Count} options; {evNote}");
    }

    // ---- the shared assertion: forward-map the element's TRUE centre to the VISUAL point, then check the remap ----

    private static void AssertRemapsToElement(Ctx ctx, string elementId, string label)
    {
        var (cx, cy) = ctx.Center(elementId);
        if (!ctx.ForwardThroughGroup(elementId, cx, cy, out double vx, out double vy))
        {
            // No view-scale group covers the element (a closed/parked shop rejected by the FullyOutside guard, or a
            // recording with no group). NON-REGRESSION: a tap on the element then stays IDENTITY (no false stamp
            // displaces it), so the game still hit-tests it in place.
            var (ix, iy) = ViewScaleInput.Remap(cx, cy, ctx.RegistryOn);
            Check.Close(ix, cx, $"[tap-probe] {label}: no covering group → identity X (non-regression)");
            Check.Close(iy, cy, $"[tap-probe] {label}: no covering group → identity Y (non-regression)");
            System.Console.Error.WriteLine($"[tap-probe] {label} {elementId}: no covering group → tap stays identity (non-regression)");
            return;
        }

        // The visual point inverse-remaps back onto the element's true centre (non-identity).
        var (onx, ony) = ViewScaleInput.Remap(vx, vy, ctx.RegistryOn);
        bool moved = System.Math.Abs(onx - vx) > 0.5 || System.Math.Abs(ony - vy) > 0.5;
        Check.That(moved, $"[tap-probe] {label}: remaps the visual point (non-identity)");
        Check.That(System.Math.Abs(onx - cx) < 1.0 && System.Math.Abs(ony - cy) < 1.0,
            $"[tap-probe] {label}: lands the visual tap back on the true centre");

        // The remapped point resolves (hit-test) into the element's subtree (the tappable surface is the element or a
        // paint/hitbox descendant of it — a "*Button" wrapper is a pure container, its Image child is what's hit).
        var hittable = TouchTargetScan.HittableIdsAt(ctx.State, ctx.Transforms, onx, ony, ctx.Spread);
        bool hitsSubtree = false;
        foreach (var hid in hittable)
        {
            if (ctx.InSubtree(hid, elementId))
            {
                hitsSubtree = true;
                break;
            }
        }

        System.Console.Error.WriteLine(
            $"[tap-probe] {label} {elementId}: true=({cx:0.#},{cy:0.#}) visual=({vx:0.#},{vy:0.#}) " +
            $"remapON=({onx:0.#},{ony:0.#}) moved={moved} hitsSubtree={hitsSubtree} hittable=[{string.Join(",", hittable)}]");
        Check.That(hitsSubtree, $"[tap-probe] {label}: remapped point hit-tests the element's subtree");

    }

    // ---- replay + registry reconstruction ----

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
            if (line.StartsWith("{\"t\"", System.StringComparison.Ordinal))
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
        spread.Update(state, transforms, 1); // desktop 16:9

        ctx = new Ctx(state, transforms, spread);
        return true;
    }

    // The replay context: the state + reconstructed group stamps + input registry.
    private sealed class Ctx
    {
        public readonly MirrorState State;
        public readonly GlobalTransformIndex Transforms;
        public readonly System.Func<string, SpreadRecord?> Spread;
        private readonly SpreadIndex _spread;
        private readonly List<ViewScaleInputRegistry.Applied> _applied = new();
        private readonly HashSet<string> _stamped = new(System.StringComparer.Ordinal);
        public readonly IReadOnlyList<ViewScaleInput.Stamp> RegistryOn;
        public int Groups { get; }

        public Ctx(MirrorState state, GlobalTransformIndex transforms, SpreadIndex spread)
        {
            State = state;
            Transforms = transforms;
            _spread = spread;
            Spread = id => spread.TryGet(id, out var r) ? r : null;

            foreach (var id in state.OrderedIds)
            {
                if (!state.Nodes.TryGetValue(id, out var node))
                {
                    continue;
                }

                var res = ViewScale.ResolveFor(id, state);
                if (!res.IsActive || !res.IsGroup || !EffectivelyVisible(state, node))
                {
                    continue;
                }

                if (MeasureGroupBox(id) is not { } box)
                {
                    continue;
                }

                // Faithful to ViewScaler.Apply: a group whose PRE-scale box is fully off-stage (the closed/parked shop
                // SlotsContainer at y≈-1000 — WS-shopfix P4) is NEVER stamped, so it produces no input registry entry.
                if (box.FullyOutside(W, H, 0))
                {
                    continue;
                }

                var stamp = HoverTipScaleMath.ComputeAnchoredStamp(
                    box, res.Scale, W, H, res.Pivot, res.TranslateX, res.TranslateY, res.NoClamp);
                if (stamp is not { } s)
                {
                    continue;
                }

                _applied.Add(new ViewScaleInputRegistry.Applied(id, s, box, ViewScaleInputRegistry.ScaledBox(box, s), IsGroup: true));
                _stamped.Add(id);
            }

            // Nested reward cards join the stamped set so their descendants stay excluded (matches production).
            foreach (var id in state.OrderedIds)
            {
                if (ViewScale.IsCardRewardCard(id, state))
                {
                    _stamped.Add(id);
                }
            }

            Groups = _applied.Count;
            RegistryOn = ViewScaleInputRegistry.Build(state, transforms, spread, _applied, _stamped, W);
        }

        public DesignAabb? MeasureGroupBox(string id)
        {
            if (!State.Nodes.TryGetValue(id, out var node) || node.LocalRect is not { } lr
                || lr.Width <= 0 || lr.Height <= 0 || !Transforms.TryGetGlobal(id, out var g))
            {
                return null;
            }

            double dx = _spread.TryGet(id, out var rec) ? rec.Dx : 0;
            double width = rec.RenderedWidth > 0 ? rec.RenderedWidth : lr.Width;
            return CullBounds.OfRect(g, lr.X, lr.Y, width, lr.Height).ShiftX(dx);
        }

        // A node's design-space centre (paint/local box under its global + spread Dx).
        public (double X, double Y) Center(string id)
        {
            var b = BoxOf(id)!.Value;
            return ((b.MinX + b.MaxX) / 2.0, (b.MinY + b.MaxY) / 2.0);
        }

        public double CenterX(string id) => Center(id).X;

        // Forward-map a true design point through the view-scale GROUP whose subtree contains `id`, to the VISUAL point.
        public bool ForwardThroughGroup(string id, double x, double y, out double vx, out double vy)
        {
            foreach (var a in _applied)
            {
                if (DescendsFrom(id, a.Id))
                {
                    var s = a.Stamp;
                    vx = s.PivotX + (s.Scale * (x - s.PivotX)) + s.ClampX;
                    vy = s.PivotY + (s.Scale * (y - s.PivotY)) + s.ClampY;
                    return true;
                }
            }

            vx = x;
            vy = y;
            return false;
        }

        // The distance of a node's centre from its covering group's pivot (the "displacement" magnitude).
        public double DisplacementFromGroup(string id)
        {
            var (cx, cy) = Center(id);
            foreach (var a in _applied)
            {
                if (DescendsFrom(id, a.Id))
                {
                    return System.Math.Abs(cx - a.Stamp.PivotX) + System.Math.Abs(cy - a.Stamp.PivotY);
                }
            }

            return 0;
        }

        public string? FindVisible(string? leaf = null, string? sceneSuffix = null, bool interactiveOnly = false)
        {
            foreach (var id in State.OrderedIds)
            {
                if (Matches(id, leaf, sceneSuffix, interactiveOnly, underLeaf: null))
                {
                    return id;
                }
            }

            return null;
        }

        public List<string> FindAllVisible(
            string? leaf = null, string[]? leaves = null, string? underLeaf = null)
        {
            var output = new List<string>();
            foreach (var id in State.OrderedIds)
            {
                if (leaves is not null)
                {
                    foreach (var l in leaves)
                    {
                        if (Matches(id, l, null, false, underLeaf))
                        {
                            output.Add(id);
                            break;
                        }
                    }
                }
                else if (Matches(id, leaf, null, false, underLeaf))
                {
                    output.Add(id);
                }
            }

            return output;
        }

        private bool Matches(string id, string? leaf, string? sceneSuffix, bool interactiveOnly, string? underLeaf)
        {
            if (!State.Nodes.TryGetValue(id, out var node) || !EffectivelyVisible(State, node))
            {
                return false;
            }

            if (leaf is not null && Leaf(node.NodeType) != leaf)
            {
                return false;
            }

            if (sceneSuffix is not null && (node.SceneFilePath is null || !node.SceneFilePath.EndsWith(sceneSuffix, System.StringComparison.Ordinal)))
            {
                return false;
            }

            if (interactiveOnly && node.MouseFilter is not (0 or 1))
            {
                return false;
            }

            if (interactiveOnly && BoxOf(id) is null)
            {
                return false;
            }

            if (underLeaf is not null && !HasAncestorLeaf(id, underLeaf))
            {
                return false;
            }

            return BoxOf(id) is not null;
        }

        private DesignAabb? BoxOf(string id)
        {
            if (!State.Nodes.TryGetValue(id, out var node) || !Transforms.TryGetGlobal(id, out var g))
            {
                return null;
            }

            var box = node.LocalRect; // MirrorProtocol-side paint box (mirrors CullIndex.LocalPaintBox)
            if (box is not { } lr || lr.Width <= 0 || lr.Height <= 0)
            {
                return null;
            }

            double dx = _spread.TryGet(id, out var rec) ? rec.Dx : 0;
            return CullBounds.OfRect(g, lr.X, lr.Y, lr.Width, lr.Height).ShiftX(dx);
        }

        private bool HasAncestorLeaf(string id, string leaf)
        {
            for (var cur = State.Nodes.GetValueOrDefault(id); cur is not null;
                 cur = cur.ParentId is { } pid ? State.Nodes.GetValueOrDefault(pid) : null)
            {
                if (Leaf(cur.NodeType) == leaf)
                {
                    return true;
                }
            }

            return false;
        }

        // True when `id` is `ancestorId` or descends from it (a tap on a descendant counts as hitting the element).
        public bool InSubtree(string id, string ancestorId) => DescendsFrom(id, ancestorId);

        private bool DescendsFrom(string id, string ancestorId)
        {
            for (var cur = State.Nodes.GetValueOrDefault(id); cur is not null;
                 cur = cur.ParentId is { } pid ? State.Nodes.GetValueOrDefault(pid) : null)
            {
                if (cur.Id == ancestorId)
                {
                    return true;
                }
            }

            return false;
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
