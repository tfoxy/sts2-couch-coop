using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Optional recording-replay smoke: point COUCHCOOP_MIRROR_REPLAY_NDJSON at an ndjson stream (e.g.
// .sts2/bench/combat-baseline.ndjson) and every scene-delta line is parsed + applied, asserting no exceptions and a
// strictly monotonic revision. Skips SILENTLY when the env var is unset or the file is absent, so the suite stays
// green in a checkout without a recording (nothing is committed).
internal static class RecordingReplayTests
{
    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_REPLAY_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        var state = MirrorState.Create();
        var applied = 0;
        var previousRevision = state.Revision;
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            var delta = SceneDeltaReader.Parse(line);
            if (delta is null)
            {
                // Non scene-delta frame in the recording (session/state/etc.) — skip it.
                continue;
            }

            SceneTreeApplier.ApplySceneDelta(state, delta);
            Check.Equal(state.Revision, previousRevision + 1, $"revision monotonic at applied delta {applied}");
            previousRevision = state.Revision;
            applied++;
        }

        Check.That(applied > 0, $"replayed at least one scene-delta from {path}");
        Console.Error.WriteLine($"[replay] applied {applied} scene-deltas from {path}; final revision {state.Revision}, {state.Nodes.Count} live nodes");
    }
}
