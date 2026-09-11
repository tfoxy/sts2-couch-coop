using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Shared NDJSON replay for the env-gated live-data probes (WS-SHOP round 6): parse every scene-delta line into a
// retained MirrorState (via the SAME SceneDeltaReader + SceneTreeApplier the client uses) and collect every tween hint
// seen across the stream. Handles both the record-mirror-stream wrapper ({"t":…,"data":"<raw>"}) and a bare raw line.
// Mirrors the parse loop in CardRewardScaleReplayProbe so the probes agree on how a recording is decoded.
internal static class ReplayProbeSupport
{
    public static (MirrorState State, IReadOnlyList<MirrorTweenHint> Hints) Replay(string path)
    {
        var state = MirrorState.Create();
        var hints = new List<MirrorTweenHint>();

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

            if (delta.Hints.Count > 0)
            {
                hints.AddRange(delta.Hints);
            }

            SceneTreeApplier.ApplySceneDelta(state, delta);
        }

        return (state, hints);
    }
}
