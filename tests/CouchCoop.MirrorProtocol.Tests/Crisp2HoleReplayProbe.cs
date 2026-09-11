using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-crisp2 verification probe (env-gated; skips SILENTLY when COUCHCOOP_CRISP2_PROBE_NDJSON is unset/absent).
// Replays a deck-dialog mirror recording into the final MirrorState and reproduces, on the REAL wire geometry, what
// the LIVE client's MeasureBlockerArt/TryGetBlockerArtRect would feed the planners for the `BorderGradient` scroll-edge
// fade scrim: the decode-time alpha used-rect (0,0,2,256) + transparent HOLE (0,13,2,230) of the actual 2×256
// GradientTexture2D (verified by decoding the cached PNG — a clean exact-0 middle band), stretch-mapped (mode 0) into
// the node's layout rect and transformed by its real global.
//
// It then prints the card + text planner verdicts WITHOUT the art/hole maps (the pre-crisp2 state: the full 1920×1002
// box occludes everything) versus WITH them (crisp2: cards/labels inside the see-through middle promote), under the
// current production policy. This is the deterministic offline stand-in for the live
// before/after when a real game session isn't available.
internal static class Crisp2HoleReplayProbe
{
    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_CRISP2_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        int maxFrames = int.TryParse(Environment.GetEnvironmentVariable("COUCHCOOP_CRISP2_PROBE_MAXFRAMES"), out var mf)
            ? mf : int.MaxValue;
        var state = MirrorState.Create();
        int applied = 0;
        foreach (var line in File.ReadLines(path))
        {
            if (applied >= maxFrames)
            {
                break;
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            string deltaJson;
            try
            {
                using var doc = JsonDocument.Parse(line);
                if (!doc.RootElement.TryGetProperty("data", out var d) || d.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                deltaJson = d.GetString()!;
            }
            catch
            {
                continue;
            }

            var delta = SceneDeltaReader.Parse(deltaJson);
            if (delta is null)
            {
                continue;
            }

            SceneTreeApplier.ApplySceneDelta(state, delta);
            applied++;
        }

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);
        Console.Error.WriteLine($"[crisp2-probe] file={Path.GetFileName(path)} frames={applied} nodes={state.Nodes.Count}");

        // Locate every BorderGradient scrim (a textured occluder) and synthesize its design-space art box + hole the
        // way the live client would. The texture is 2×256; hole rows 13..242 (the exact-0 middle, from the cached PNG).
        var art = new Dictionary<string, DesignAabb>(StringComparer.Ordinal);
        var holes = new Dictionary<string, DesignAabb>(StringComparer.Ordinal);
        foreach (var n in state.Nodes.Values.Where(n => n.Name == "BorderGradient" && n.TextureUrl is not null))
        {
            var rect = n.LocalRect;
            if (rect is null || !transforms.TryGetGlobal(n.Id, out var g))
            {
                continue;
            }

            const double texW = 2, texH = 256, holeY = 13, holeH = 230;
            double sy = rect.Height / texH;
            // stretch mode 0 (scale): art fills the rect; the hole maps to the middle band.
            var artLocal = CullBounds.OfRect(g, rect.X, rect.Y, rect.Width, rect.Height);
            var holeLocal = CullBounds.OfRect(g, rect.X, rect.Y + (holeY * sy), rect.Width, holeH * sy);
            art[n.Id] = artLocal;
            holes[n.Id] = holeLocal;
            Console.Error.WriteLine($"[crisp2-probe] BorderGradient id={n.Id} rect=[{rect.X:0},{rect.Y:0} {rect.Width:0}x{rect.Height:0}] " +
                                    $"texW={texW} → designHole=[{holeLocal.MinX:0},{holeLocal.MinY:0} {holeLocal.MaxX:0},{holeLocal.MaxY:0}]");
        }

        if (art.Count == 0)
        {
            Console.Error.WriteLine("[crisp2-probe] no BorderGradient scrim found — nothing to prove");
            return;
        }

        var empty = new HashSet<string>(StringComparer.Ordinal);
        double DxOf(string _) => 0.0;

        // ---- CARD planner: before (no maps) vs after (art+hole) ----------------------------------------------------
        var cardPlanner = new CardLayerPlanner();
        cardPlanner.RebuildIndex(state);
        var beforeTrace = new List<string>();
        cardPlanner.Debug = beforeTrace.Add;
        var before = cardPlanner.Plan(state, transforms, 1.0, DxOf, empty, empty, empty, empty);
        cardPlanner.Debug = null;
        int cardsBefore = before.Clusters.Count, evaluated = cardPlanner.LastEvaluated;
        int beforeByGradient = beforeTrace.Count(l => l.StartsWith("card-occluded") && l.Contains("byName='BorderGradient'"));
        Console.Error.WriteLine($"[crisp2-probe] BEFORE: {beforeByGradient}/{evaluated} grid cards occluded specifically by BorderGradient");
        var trace = new List<string>();
        cardPlanner.Debug = trace.Add;
        var after = cardPlanner.Plan(state, transforms, 1.0, DxOf, empty, empty, empty, empty, spreadWidthOf: null,
            blockerArtExtents: art, blockerArtHoles: holes);
        cardPlanner.Debug = null;
        int cardsAfter = after.Clusters.Count;
        int afterByGradient = trace.Count(l => l.StartsWith("card-occluded") && l.Contains("byName='BorderGradient'"));
        Console.Error.WriteLine($"[crisp2-probe] CARD planner: evaluated={evaluated} promoted BEFORE={cardsBefore} AFTER={cardsAfter} " +
                                $"| cards occluded by BorderGradient: BEFORE all, AFTER={afterByGradient} (hist after: {Hist(cardPlanner.LastRejectHistogram)})");
        foreach (var t in trace.Where(l => l.StartsWith("card-occluded")).Take(12))
        {
            Console.Error.WriteLine($"[crisp2-probe]   {t}");
        }

        // ---- TEXT planner: before vs after (BlockerArtHoles fed the way the controller feeds them) -----------------
        var promotedRoots = new HashSet<string>(after.Clusters.Select(c => c.RootId), StringComparer.Ordinal);
        var knownRoots = new HashSet<string>(cardPlanner.LastCandidateRoots, StringComparer.Ordinal);
        var promotedMembers = new HashSet<string>(StringComparer.Ordinal);
        foreach (var c in after.Clusters)
        {
            foreach (var m in c.MemberIds)
            {
                promotedMembers.Add(m);
            }
        }

        // ---- clean-grid leg: this recording is a continuous-HOVER session (an enlarged hover-preview card + its loose
        // Title/Description/Outline always cascades over the grid), so no frame shows a clean resting grid. Reproduce
        // one by keeping ONLY the 10 grid card subtrees + the gradient + their ancestors (the dialog frame) and
        // dropping everything else (the hover preview), then re-plan WITH the hole: with the gradient scrim holed and
        // no hover cascade, the grid cards promote — the deck-grid symptom the user reports, resolved.
        var keep = new HashSet<string>(StringComparer.Ordinal);
        foreach (var root in cardPlanner.LastCandidateRoots)
        {
            CollectSubtree(state, root, keep);
            for (var a = state.Nodes.TryGetValue(root, out var rn) ? rn.ParentId : null;
                 a is not null && state.Nodes.TryGetValue(a, out var an); a = an.ParentId)
            {
                keep.Add(a);
            }
        }

        foreach (var id in art.Keys)
        {
            keep.Add(id);
        }

        var clean = MirrorState.Create();
        foreach (var id in state.OrderedIds)
        {
            if (keep.Contains(id) && state.Nodes.TryGetValue(id, out var kn))
            {
                clean.Nodes[id] = kn;
                clean.OrderedIds.Add(id);
            }
        }

        var cleanTransforms = new GlobalTransformIndex();
        cleanTransforms.Update(clean);
        var cleanPlanner = new CardLayerPlanner();
        cleanPlanner.RebuildIndex(clean);
        var cleanBefore = cleanPlanner.Plan(clean, cleanTransforms, 1.0, DxOf, empty, empty, empty, empty);
        int cleanBeforeN = cleanBefore.Clusters.Count;
        var cleanAfter = cleanPlanner.Plan(clean, cleanTransforms, 1.0, DxOf, empty, empty, empty, empty, spreadWidthOf: null,
            blockerArtExtents: art, blockerArtHoles: holes);
        Console.Error.WriteLine($"[crisp2-probe] CLEAN grid (hover preview removed): evaluated={cleanPlanner.LastEvaluated} " +
                                $"promoted BEFORE(no-hole)={cleanBeforeN} AFTER(hole)={cleanAfter.Clusters.Count} " +
                                $"(hist after: {Hist(cleanPlanner.LastRejectHistogram)})");

        var textPlanner = new TextOverlayPlanner();
        textPlanner.RebuildIndex(state);
        var optionsBefore = new TextOverlayOptions { CardPromotedRoots = promotedRoots, CardKnownRoots = knownRoots };
        var textBefore = textPlanner.Plan(state, transforms, 1.0, DxOf, promotedMembers, empty, empty, null,
            excludeCardSubtrees: true, options: optionsBefore, spreadWidthOf: null, fadeInAlpha: null);
        int textBeforeN = textBefore.Items.Count;
        var optionsAfter = new TextOverlayOptions
        {
            CardPromotedRoots = promotedRoots,
            CardKnownRoots = knownRoots,
            BlockerArtExtents = art,
            BlockerArtHoles = holes,
        };
        var textAfter = textPlanner.Plan(state, transforms, 1.0, DxOf, promotedMembers, empty, empty, null,
            excludeCardSubtrees: true, options: optionsAfter, spreadWidthOf: null, fadeInAlpha: null);
        int textAfterN = textAfter.Items.Count;
        Console.Error.WriteLine($"[crisp2-probe] TEXT planner: evaluated={textPlanner.LastEvaluated} promoted BEFORE={textBeforeN} AFTER={textAfterN} " +
                                $"(hist after: {Hist(textPlanner.LastRejectHistogram)})");
    }

    private static void CollectSubtree(MirrorState state, string root, HashSet<string> into)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        var children = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var (id, n) in state.Nodes)
        {
            if (n.ParentId is { } p)
            {
                (children.TryGetValue(p, out var l) ? l : children[p] = new List<string>()).Add(id);
            }
        }

        while (stack.Count > 0)
        {
            var id = stack.Pop();
            if (!into.Add(id))
            {
                continue;
            }

            if (children.TryGetValue(id, out var kids))
            {
                foreach (var k in kids)
                {
                    stack.Push(k);
                }
            }
        }
    }

    private static string Hist<T>(IReadOnlyDictionary<T, int> hist) where T : notnull =>
        string.Join(" ", hist.OrderBy(kv => kv.Key.ToString(), StringComparer.Ordinal).Select(kv => $"{kv.Key}={kv.Value}"));
}
