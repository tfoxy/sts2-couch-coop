using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-CRISP diagnosis probe (follows the TextOverlayPlanProbe pattern). Point COUCHCOOP_CRISP_PROBE_NDJSON at a mirror
// recording; it replays every scene-delta into the final MirrorState (or up to _MAXFRAMES to snapshot a transient
// state like a visible hover tip), then runs both real planners under the current card and text policy;
// excludeCards varies with card-layer ownership.
// fed back — exactly the controller wiring) and prints, per flagged TARGET label:
//   * its ancestor chain (name/type/z/clip/visible per hop — the first-fail evidence),
//   * its planner verdict under the current production policy and under excludeCards=false (what CardOwned hides),
//   * every gated planner trace line (`eval …` / `occluded …` / `card-occluded …`) that names it.
// Target specs come from COUCHCOOP_CRISP_PROBE_TARGETS (comma-separated, "Name" or "Ancestor/Name" where Ancestor
// matches a chain node's Name OR leaf NodeType), defaulting to the WS-CRISP batch: TopBar floor number + deck count,
// hover-tip Title/Description, and card TitleLabel/TypeLabel/DescriptionLabel inside NCard subtrees.
// COUCHCOOP_CRISP_PROBE_SCAN=1 additionally prints frame indices where a target's chain-visibility flips, so a
// transient state's _MAXFRAMES can be picked. Skips SILENTLY when the env var is unset / the file is absent.
internal static class CrispTargetsProbe
{
    private static readonly string[] DefaultTargets =
    {
        "FloorNumLabel", "DeckCardCount", "HoverTip/Title", "HoverTip/Description",
        "NCard/TitleLabel", "NCard/TypeLabel", "NCard/DescriptionLabel",
    };

    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_CRISP_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        int maxFrames = int.TryParse(Environment.GetEnvironmentVariable("COUCHCOOP_CRISP_PROBE_MAXFRAMES"), out var mf)
            ? mf : int.MaxValue;
        bool scan = Environment.GetEnvironmentVariable("COUCHCOOP_CRISP_PROBE_SCAN") == "1";
        var targetsEnv = Environment.GetEnvironmentVariable("COUCHCOOP_CRISP_PROBE_TARGETS");
        var specs = (string.IsNullOrWhiteSpace(targetsEnv)
                ? DefaultTargets
                : targetsEnv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Select(ParseSpec).ToArray();

        var state = MirrorState.Create();
        var visibleNow = new Dictionary<string, bool>(StringComparer.Ordinal); // scan bookkeeping (per spec key)
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
                if (!doc.RootElement.TryGetProperty("data", out var dataEl) || dataEl.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                deltaJson = dataEl.GetString()!;
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

            if (scan)
            {
                foreach (var spec in specs)
                {
                    bool vis = state.Nodes.Values.Any(n =>
                        Matches(state, n, spec) && n.Text is { Text.Length: > 0 } && ChainVisible(state, n.Id));
                    string key = SpecKey(spec);
                    if (!visibleNow.TryGetValue(key, out var was) || was != vis)
                    {
                        visibleNow[key] = vis;
                        Console.Error.WriteLine($"[crisp-probe] scan frame={applied} target='{key}' visible={vis}");
                    }
                }
            }
        }

        if (applied == 0)
        {
            Console.Error.WriteLine($"[crisp-probe] {Path.GetFileName(path)}: no deltas applied");
            return;
        }

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);
        var empty = new HashSet<string>(StringComparer.Ordinal);
        double DxOf(string _) => 0.0;

        Console.Error.WriteLine($"[crisp-probe] file={Path.GetFileName(path)} frames={applied} nodes={state.Nodes.Count} " +
                                $"orderedIds={state.OrderedIds.Count}");

        // ---- card planner, current policy ----
        var cardPlanner = new CardLayerPlanner();
        cardPlanner.RebuildIndex(state);
        var cardTrace = new List<string>();
        cardPlanner.Debug = cardTrace.Add;
        var cardPlan = cardPlanner.Plan(state, transforms, 1.0, DxOf, empty, empty, empty, empty);
        cardPlanner.Debug = null;
        Console.Error.WriteLine($"[crisp-probe] cardLayer: promoted={cardPlan.Clusters.Count} " +
                                $"evaluated={cardPlanner.LastEvaluated} histogram[{Hist(cardPlanner.LastRejectHistogram)}]");

        // The controller feeds the card plan's promoted member ids into the text planner's excluded set
        // (SceneReconciler.CollectCardPromoted) — reproduce that wiring.
        var promotedMembers = new HashSet<string>(StringComparer.Ordinal);
        foreach (var cluster in cardPlan.Clusters)
        {
            foreach (var mid in cluster.MemberIds)
            {
                promotedMembers.Add(mid);
            }
        }

        // ---- text planner: production leg plus the excludeCards=false diagnostic ---------------------------------
        var textPlanner = new TextOverlayPlanner();
        textPlanner.RebuildIndex(state);
        var textTrace = new List<string>();
        textPlanner.Debug = textTrace.Add;
        var defaultOptions = new TextOverlayOptions();
        var prod = textPlanner.Plan(state, transforms, 1.0, DxOf, promotedMembers, empty, empty, null,
            excludeCardSubtrees: true, options: defaultOptions, spreadWidthOf: null, fadeInAlpha: null);
        textPlanner.Debug = null;
        var prodHist = Hist(textPlanner.LastRejectHistogram);
        var noExclTrace = new List<string>();
        textPlanner.Debug = noExclTrace.Add;
        var noExcl = textPlanner.Plan(state, transforms, 1.0, DxOf, promotedMembers, empty, empty, null,
            excludeCardSubtrees: false, options: defaultOptions, spreadWidthOf: null, fadeInAlpha: null);
        textPlanner.Debug = null;
        var noExclHist = Hist(textPlanner.LastRejectHistogram);

        // Current options leg: the production policy PLUS the current options built the way the controller builds them (card
        // plan's promoted roots + the planner's evaluated roots). No BlockerArtExtents / measured extents here (both
        // are client-side measurements a headless replay cannot produce), so the (a)/(e) measured-graze flips only
        // show on the live replay — this leg proves CardOwned, clip containment, and ancestor-shader handling.
        var promotedRoots = new HashSet<string>(cardPlan.Clusters.Select(c => c.RootId), StringComparer.Ordinal);
        var knownRoots = new HashSet<string>(cardPlanner.LastCandidateRoots, StringComparer.Ordinal);
        var options = new TextOverlayOptions { CardPromotedRoots = promotedRoots, CardKnownRoots = knownRoots };
        var currentTrace = new List<string>();
        textPlanner.Debug = currentTrace.Add;
        var current = textPlanner.Plan(state, transforms, 1.0, DxOf, promotedMembers, empty, empty, null,
            excludeCardSubtrees: true, options: options, spreadWidthOf: null, fadeInAlpha: null);
        textPlanner.Debug = null;

        Console.Error.WriteLine($"[crisp-probe] textOverlay prod (excludeCards=true):  promoted={prod.Items.Count} " +
                                $"evaluated={textPlanner.LastEvaluated} histogram[{prodHist}]");
        Console.Error.WriteLine($"[crisp-probe] textOverlay what-if (excludeCards=false): promoted={noExcl.Items.Count} " +
                                $"histogram[{noExclHist}]");
        Console.Error.WriteLine($"[crisp-probe] textOverlay current card/clip/shader policy:  promoted={current.Items.Count} " +
                                $"histogram[{Hist(textPlanner.LastRejectHistogram)}]");

        var prodIds = new HashSet<string>(prod.Items.Select(i => i.Id), StringComparer.Ordinal);
        var noExclIds = new HashSet<string>(noExcl.Items.Select(i => i.Id), StringComparer.Ordinal);
        var currentIds = new HashSet<string>(current.Items.Select(i => i.Id), StringComparer.Ordinal);

        // ---- per-target verdicts -----------------------------------------------------------------------------------
        foreach (var spec in specs)
        {
            var hits = state.Nodes.Values
                .Where(n => Matches(state, n, spec) && n.Text is { Text.Length: > 0 })
                .OrderBy(n => n.Id, StringComparer.Ordinal)
                .ToList();
            if (hits.Count == 0)
            {
                Console.Error.WriteLine($"[crisp-probe] TARGET '{SpecKey(spec)}': no text-bearing node in this frame");
                continue;
            }

            const int cap = 12;
            foreach (var n in hits.Take(cap))
            {
                Console.Error.WriteLine(
                    $"[crisp-probe] TARGET '{SpecKey(spec)}' id={n.Id} text='{Trunc(n.Text!.Text, 40)}' " +
                    $"prod={(prodIds.Contains(n.Id) ? "PROMOTED" : "mushy")} " +
                    $"noCardExcl={(noExclIds.Contains(n.Id) ? "PROMOTED" : "mushy")} " +
                    $"current={(currentIds.Contains(n.Id) ? "PROMOTED" : "mushy")} " +
                    $"cardMember={promotedMembers.Contains(n.Id)}");
                Console.Error.WriteLine($"[crisp-probe]   chain: {Chain(state, n.Id)}");
                foreach (var t in textTrace.Where(l => l.Contains("id=" + n.Id)))
                {
                    Console.Error.WriteLine($"[crisp-probe]   prod-trace:   {t}");
                }

                foreach (var t in noExclTrace.Where(l => l.Contains("id=" + n.Id)))
                {
                    Console.Error.WriteLine($"[crisp-probe]   noexcl-trace: {t}");
                }

                foreach (var t in currentTrace.Where(l => l.Contains("id=" + n.Id)))
                {
                    Console.Error.WriteLine($"[crisp-probe]   current-trace:     {t}");
                }

                // Card-planner verdicts for every NCard ancestor of this label (the CardOwned narrowing evidence:
                // did the card layer PROMOTE the owning card, or decline it — and why).
                foreach (var rootId in NCardAncestors(state, n.Id))
                {
                    foreach (var t in cardTrace.Where(l => l.Contains("root=" + rootId)))
                    {
                        Console.Error.WriteLine($"[crisp-probe]   card-trace:   {t}");
                    }
                }
            }

            if (hits.Count > cap)
            {
                Console.Error.WriteLine($"[crisp-probe]   … {hits.Count - cap} more '{SpecKey(spec)}' nodes elided");
            }
        }
    }

    // ---- spec / matching helpers -----------------------------------------------------------------------------------

    private readonly record struct Spec(string? Ancestor, string Name);

    private static Spec ParseSpec(string s)
    {
        int slash = s.IndexOf('/');
        return slash < 0 ? new Spec(null, s) : new Spec(s[..slash], s[(slash + 1)..]);
    }

    private static string SpecKey(Spec spec) => spec.Ancestor is null ? spec.Name : $"{spec.Ancestor}/{spec.Name}";

    private static bool Matches(MirrorState state, MirrorNode node, Spec spec)
    {
        if (!string.Equals(node.Name, spec.Name, StringComparison.Ordinal))
        {
            return false;
        }

        if (spec.Ancestor is null)
        {
            return true;
        }

        string? cur = node.ParentId;
        int guard = 0;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var a) && guard++ < 4096)
        {
            if (string.Equals(a.Name, spec.Ancestor, StringComparison.Ordinal)
                || string.Equals(TypeLeaf(a.NodeType), spec.Ancestor, StringComparison.Ordinal))
            {
                return true;
            }

            cur = a.ParentId;
        }

        return false;
    }

    private static IEnumerable<string> NCardAncestors(MirrorState state, string id)
    {
        string? cur = id;
        int guard = 0;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var n) && guard++ < 4096)
        {
            if (TypeLeaf(n.NodeType) == "NCard")
            {
                yield return cur;
            }

            cur = n.ParentId;
        }
    }

    private static bool ChainVisible(MirrorState state, string id)
    {
        string? cur = id;
        int guard = 0;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var n) && guard++ < 4096)
        {
            if (!n.Visible)
            {
                return false;
            }

            cur = n.ParentId;
        }

        return true;
    }

    private static string Chain(MirrorState state, string id)
    {
        var parts = new List<string>();
        string? cur = id;
        int guard = 0;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var n) && guard++ < 32)
        {
            string extras = string.Concat(
                n.ZIndex is { } z && z != 0 ? $" z={z}" : "",
                n.ClipChildren != 0 ? " CLIP" : "",
                !n.Visible ? " HIDDEN" : "",
                n.ShowBehindParent ? " BEHIND" : "",
                n.ParticleSpec is not null ? " PARTICLE" : "",
                n.SpineSceneResPath is not null ? " SPINE" : "",
                n.ShaderId is not null ? " SHADER" : "",
                n.IntentFrames is not null ? " INTENT" : "",
                n.MaterialRef is not null ? " MATERIAL" : "",
                n.CanvasBlendMode is { } bm && bm != 0 ? $" BLEND={bm}" : "");
            parts.Add($"{n.Name}({TypeLeaf(n.NodeType)}{extras})");
            cur = n.ParentId;
        }

        return string.Join(" ← ", parts);
    }

    private static string TypeLeaf(string nodeType)
    {
        int dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }

    private static string Hist<T>(IReadOnlyDictionary<T, int> hist) where T : notnull =>
        string.Join(" ", hist.OrderBy(kv => kv.Key.ToString(), StringComparer.Ordinal)
            .Select(kv => $"{kv.Key}={kv.Value}"));

    private static string Trunc(string s, int max) => s.Length <= max ? s : s[..max] + "…";
}
