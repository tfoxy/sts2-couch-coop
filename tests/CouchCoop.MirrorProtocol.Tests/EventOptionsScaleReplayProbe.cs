using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R6 (WS-SMALL) HEADLESS live-data verification of the combat-event options coverage — no Godot, no display, no live
// lock. Point COUCHCOOP_MIRROR_EVENT_PROBE_NDJSON at a recorded mirror stream that visits a COMBAT event screen
// (e.g. .sts2/bench/audit-event.ndjson), and this replays every scene-delta into a MirrorState, then resolves
// ViewScale.ResolveFor(id, state) for every node and CHECKS that:
//   * combat_event_layout.tscn is a view-scale ROOT file (else AnyViewScaleScenePresent would early-out the whole pass);
//   * the combat layout's OptionsContainer (any node whose scene root is combat_event_layout.tscn and whose relPath
//     ends in "OptionsContainer") resolves the 1.2 EventOptions GROUP about its TOP (grows down), i.e. it gets a stamp.
// Env-gated → skips SILENTLY when the var is unset (suite stays green in a plain checkout); when set, the Check.*
// assertions surface any resolve drift. Modeled on CardRewardScaleReplayProbe.
internal static class EventOptionsScaleReplayProbe
{
    private const string CombatEventLayout = "res://scenes/events/combat_event_layout.tscn";

    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_EVENT_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        // The presence gate that must be true for the pass to run at all on a combat-event screen.
        Check.That(ViewScale.IsRootFile(CombatEventLayout),
            "[event-probe] combat_event_layout is a view-scale ROOT file (else the whole pass early-outs)");

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

        int optionsContainers = 0, stamped = 0;
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            var (file, relPath) = SceneIdentity.Resolve(id, state);
            if (file != CombatEventLayout || relPath is null || !relPath.EndsWith("OptionsContainer", StringComparison.Ordinal))
            {
                continue;
            }

            optionsContainers++;
            var res = ViewScale.ResolveFor(id, state);
            Check.That(res.IsActive, "[event-probe] combat-event OptionsContainer resolves an ACTIVE view-scale stamp");
            Check.Close(res.Scale, ViewScale.EventOptionsScale, "[event-probe] combat-event OptionsContainer → 1.2");
            Check.That(res.IsGroup, "[event-probe] combat-event OptionsContainer is a GROUP");
            Check.That(res.Pivot == HoverTipScaleMath.AnchorPivot.TopCenter,
                "[event-probe] combat-event OptionsContainer grows DOWN from its top");
            if (res.IsActive)
            {
                stamped++;
            }
        }

        Console.Error.WriteLine(
            $"[event-probe] applied {applied} deltas; {state.Nodes.Count} nodes; " +
            $"{optionsContainers} combat-event OptionsContainer(s), {stamped} stamped @ {ViewScale.EventOptionsScale}");

        Check.That(optionsContainers >= 1,
            "[event-probe] the recording visits a combat_event_layout screen with an OptionsContainer");
        Check.That(stamped == optionsContainers,
            "[event-probe] every combat-event OptionsContainer got a stamp (none left neutral)");
    }
}
