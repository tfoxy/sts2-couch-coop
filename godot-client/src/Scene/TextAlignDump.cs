using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

// R5 text-ALIGNMENT dump (the `dumpalign` QA verb + the COUCHCOOP_MIRROR_TEXTALIGN_DUMP=1 --shot env twin). Reports,
// per visible text node, the streamed box vs the ACTUAL laid-out glyph advance box (MirrorNodeView.TryGetTextGlyphRect)
// in design space, and their vertical-centre delta `dyCentre` = glyphCentreY − boxCentreY. This is a pure NUMERIC
// placement check (no image analysis) — it runs on-device over `adb forward` and needs no screenshot.
//
// CAVEAT (documented): `dyCentre` is the placement of the glyph's ADVANCE box (font ascent+descent line box), NOT the
// rendered INK, so it carries a small per-glyph natural offset even when perfectly placed — measured ≈+0.5..+1px for
// the loose-box counts and ≈+3.5px for the TIGHT-box HP bar (whose advance box is bigger than its box). It is a
// PROXY: it catches a gross Position / valign error — the round-5 count over-lift reads dyCentre ≈ −8 (shipped) /
// −4 (grow/2 only) vs ≈+0.5 fixed — but it is NOT the pixel-true ink centre. The pixel gate is
// scripts/verify-text-align.sh (ink crops); this is the cheap on-device numeric convenience that pairs with it.
internal static class TextAlignDump
{
    // Build the JSON payload over the reconciler's live views. `filter` (optional) is a case-insensitive substring
    // matched against the node name / type-leaf / scene-file / relPath (same convention as dumptypes/dumpspread).
    public static JsonObject Collect(SceneReconciler reconciler, MirrorStore store, string? filter)
    {
        var state = store.State;
        string? flt = string.IsNullOrWhiteSpace(filter) ? null : filter.ToLowerInvariant();

        var arr = new JsonArray();
        var dys = new List<double>();

        reconciler.ForEachLiveView(view =>
        {
            if (!GodotObject.IsInstanceValid(view) || view.TextEffectiveNode is not { Text: { } text } node)
            {
                return;
            }

            var boxRect = node.LocalRect;
            if (boxRect is not { } b || !view.TryGetTextGlyphRect(out var glyphLocal))
            {
                return;
            }

            string id = view.NodeId;
            if (!state.Nodes.TryGetValue(id, out var sNode) || !EffectivelyVisible(state, sNode))
            {
                return;
            }

            var (file, relPath) = SceneIdentity.Resolve(id, state);
            string leaf = Leaf(node.NodeType);
            if (flt is not null && !Matches(flt, node.Name, leaf, file, relPath))
            {
                return;
            }

            var gt = view.GetGlobalTransform();
            var boxDesign = DesignAabbOf(gt, new Rect2((float)b.X, (float)b.Y, (float)b.Width, (float)b.Height));
            var glyphDesign = DesignAabbOf(gt, glyphLocal);

            double boxCy = (boxDesign.MinY + boxDesign.MaxY) / 2.0;
            double glyphCy = (glyphDesign.MinY + glyphDesign.MaxY) / 2.0;
            double dyCentre = glyphCy - boxCy;
            dys.Add(dyCentre);

            arr.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = node.Name,
                ["type"] = leaf,
                ["scene"] = file,
                ["relPath"] = relPath,
                ["valign"] = text.Valign ?? "-",
                ["halign"] = text.Halign ?? "-",
                ["text"] = text.Text,
                ["box"] = BoxJson(boxDesign),
                ["glyphRect"] = BoxJson(glyphDesign),
                ["dyCentre"] = Math.Round(dyCentre, 2),
            });
        });

        return new JsonObject
        {
            ["count"] = dys.Count,
            ["stats"] = StatsJson(dys),
            ["nodes"] = arr,
        };
    }

    private static bool EffectivelyVisible(MirrorState state, MirrorNode node)
    {
        var cur = node;
        while (cur is not null)
        {
            if (!cur.Visible)
            {
                return false;
            }

            cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;
        }

        return true;
    }

    // The design-space AABB of a view-local Rect2 under a global affine — the four transformed corners' min/max
    // (mirrors TextOverlay.DesignAabbOf so a scaled/rotated label is bounded exactly).
    private static DesignAabb DesignAabbOf(Transform2D gt, Rect2 local)
    {
        Vector2 p = local.Position, s = local.Size;
        Vector2 c0 = gt * p, c1 = gt * (p + new Vector2(s.X, 0)), c2 = gt * (p + new Vector2(0, s.Y)), c3 = gt * (p + s);
        float minX = Mathf.Min(Mathf.Min(c0.X, c1.X), Mathf.Min(c2.X, c3.X));
        float minY = Mathf.Min(Mathf.Min(c0.Y, c1.Y), Mathf.Min(c2.Y, c3.Y));
        float maxX = Mathf.Max(Mathf.Max(c0.X, c1.X), Mathf.Max(c2.X, c3.X));
        float maxY = Mathf.Max(Mathf.Max(c0.Y, c1.Y), Mathf.Max(c2.Y, c3.Y));
        return new DesignAabb(minX, minY, maxX, maxY);
    }

    private static JsonObject BoxJson(DesignAabb b) => new()
    {
        ["minX"] = Math.Round(b.MinX, 1),
        ["minY"] = Math.Round(b.MinY, 1),
        ["maxX"] = Math.Round(b.MaxX, 1),
        ["maxY"] = Math.Round(b.MaxY, 1),
    };

    // Non-vacuity aids for the harness: count, |dy| max, and the population stddev (0 when every node reads the same
    // offset — a degenerate/blank capture).
    private static JsonObject StatsJson(List<double> dys)
    {
        if (dys.Count == 0)
        {
            return new JsonObject { ["n"] = 0, ["maxAbsDy"] = 0.0, ["stdDy"] = 0.0 };
        }

        double mean = 0;
        foreach (var d in dys)
        {
            mean += d;
        }

        mean /= dys.Count;
        double var = 0, maxAbs = 0;
        foreach (var d in dys)
        {
            var += (d - mean) * (d - mean);
            maxAbs = Math.Max(maxAbs, Math.Abs(d));
        }

        return new JsonObject
        {
            ["n"] = dys.Count,
            ["maxAbsDy"] = Math.Round(maxAbs, 2),
            ["stdDy"] = Math.Round(Math.Sqrt(var / dys.Count), 3),
        };
    }

    private static bool Matches(string flt, string name, string leaf, string? file, string? relPath) =>
        name.ToLowerInvariant().Contains(flt)
        || leaf.ToLowerInvariant().Contains(flt)
        || (file is not null && file.ToLowerInvariant().Contains(flt))
        || (relPath is not null && relPath.ToLowerInvariant().Contains(flt));

    private static string Leaf(string t)
    {
        int dot = t.LastIndexOf('.');
        return dot >= 0 ? t[(dot + 1)..] : t;
    }
}
