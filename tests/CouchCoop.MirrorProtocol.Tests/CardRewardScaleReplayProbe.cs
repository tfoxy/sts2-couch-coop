using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R4-round4 (WS-reward) HEADLESS live-data verification of the card-reward NESTING — no Godot, no display, no live
// lock. Point COUCHCOOP_MIRROR_CARDREWARD_PROBE_NDJSON at a recorded mirror stream on the card-reward SELECTION screen
// (e.g. .sts2/bench/audit-cardreward-open.ndjson), and this replays every scene-delta into a MirrorState, then resolves
// ViewScale.ResolveFor(id, state) for every node and CHECKS that:
//   * the screen ROOT (NCardRewardSelectionScreen, "") resolves the 1.10 container GROUP, Center, UNCLAMPED (NoClamp);
//   * every reward NCard (ancestry through the screen) resolves the per-card 1.15, NOT a group, Center, NoClamp;
//   * the reward cards are exactly the NCards whose ancestry reaches the screen (deck-dialog cards elsewhere stay out).
// Proves the ancestry restore + NoClamp group compose over REAL streamed node paths. Env-gated → skips SILENTLY when
// the var is unset (suite stays green in a plain checkout); when set, the Check.* assertions surface any resolve drift.
internal static class CardRewardScaleReplayProbe
{
    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_CARDREWARD_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        var state = MirrorState.Create();
        int applied = 0;
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
            applied++;
        }

        int groups = 0, cards = 0, nonRewardNCards = 0;
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            string leaf = Leaf(node.NodeType);
            var res = ViewScale.ResolveFor(id, state);

            if (leaf == "NCardRewardSelectionScreen")
            {
                groups++;
                Check.Close(res.Scale, ViewScale.CardRewardGroupScale, "[cardreward-probe] screen root → 1.10 group");
                Check.That(res.IsGroup, "[cardreward-probe] screen root resolves a GROUP");
                Check.That(res.NoClamp, "[cardreward-probe] screen root group is NoClamp");
                Check.That(res.Pivot == HoverTipScaleMath.AnchorPivot.Center, "[cardreward-probe] screen root group is Center");
                continue;
            }

            if (leaf != "NCard")
            {
                continue;
            }

            if (ViewScale.IsCardRewardCard(id, state))
            {
                cards++;
                Check.Close(res.Scale, ViewScale.CardRewardScale, "[cardreward-probe] reward NCard → 1.15 per-card");
                Check.That(!res.IsGroup, "[cardreward-probe] reward NCard is NOT a group");
                Check.That(res.NoClamp, "[cardreward-probe] reward NCard is NoClamp");
                Check.That(res.Pivot == HoverTipScaleMath.AnchorPivot.Center, "[cardreward-probe] reward NCard is Center");
            }
            else
            {
                nonRewardNCards++;
                Check.Close(res.Scale, 1.0, "[cardreward-probe] a non-reward NCard stays neutral");
            }
        }

        Console.Error.WriteLine(
            $"[cardreward-probe] applied {applied} deltas; {state.Nodes.Count} nodes; " +
            $"{groups} reward screen root(s) @1.10 NoClamp, {cards} reward NCard(s) @1.15, {nonRewardNCards} non-reward NCard(s)");

        Check.That(groups >= 1, "[cardreward-probe] at least one card-reward screen root resolved a group");
        Check.That(cards >= 3, "[cardreward-probe] at least the 3 reward cards resolved the per-card 1.15");
        Check.That(cards % 3 == 0, "[cardreward-probe] reward cards come in rows of 3 (one per seat's screen)");
    }

    private static string Leaf(string nodeType)
    {
        int dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }
}
