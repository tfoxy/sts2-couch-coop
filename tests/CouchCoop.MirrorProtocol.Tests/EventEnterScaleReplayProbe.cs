using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-SHOP (round 6) HEADLESS live-data verification of the REGULAR-event entry (item 2a) — env-gated on
// COUCHCOOP_MIRROR_EVENTENTER_PROBE_NDJSON (a recorder-running-BEFORE-entering-a-default_event capture, idle, then a
// focus). Skips SILENTLY when unset. Asserts the OptionsContainer under default_event_layout.tscn resolves the event
// OptionsContainer GROUP (1.20, TopCenter) — the stamp the entry trap (a per-drain gate deferring it until the first
// focus) withheld until round-6's settle backstop. The "≤1 frame after the entry tween settles, WITHOUT any focus
// delta" TIMING is a native runtime property of the settle backstop (TweenReplayer transform-finish → one extra
// ViewScaler.Apply pass); this pure replay proves the RESOLVE that pass will apply, and — when the entry tween is in
// the capture — that a transform tween touches the options subtree (the trap's deferring family).
internal static class EventEnterScaleReplayProbe
{
    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_EVENTENTER_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        var (state, hints) = ReplayProbeSupport.Replay(path);

        int optionGroups = 0;
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var n) || !n.Name.EndsWith("OptionsContainer", StringComparison.Ordinal))
            {
                continue;
            }

            var res = ViewScale.ResolveFor(id, state);
            if (!res.IsActive)
            {
                continue; // an OptionsContainer outside a view-scale event layout (not our target)
            }

            optionGroups++;
            Check.Close(res.Scale, ViewScale.EventOptionsScale, "[evententer-probe] OptionsContainer → 1.20 event-options group");
            Check.That(res.IsGroup, "[evententer-probe] OptionsContainer resolves a GROUP");
            Check.That(
                res.Pivot is HoverTipScaleMath.AnchorPivot.TopCenter or HoverTipScaleMath.AnchorPivot.BottomCenter,
                "[evententer-probe] OptionsContainer grows from a fixed edge (Top/Bottom-Center)");
        }

        Console.Error.WriteLine(
            $"[evententer-probe] applied stream; {state.Nodes.Count} nodes; {optionGroups} OptionsContainer group(s); " +
            $"{hints.Count} tween hint(s) in stream");

        Check.That(optionGroups >= 1, "[evententer-probe] at least one event OptionsContainer resolved the group scale");
    }
}
