using System.Text.Json;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R5 (WS-G1) HEADLESS live-data verification of the HoverTip floater fix (H1/H2) — no Godot, no display, no live
// lock. Point COUCHCOOP_MIRROR_TIPPROBE_NDJSON at a recorded mirror stream that contains a combat HoverTip (e.g.
// .sts2/bench/wscrisp-hovertip.ndjson, `{"t":ms,"data":"<raw message>"}` lines), and this replays every scene-delta
// into a MirrorState, runs the REAL GlobalTransformIndex + SpreadIndex at a widened factor (F≠1, phone aspect), and
// prints, per visible NHoverTipSet: its anchor owner, the resolved VISUAL owner (H2), and the tip's spread Dx under
// BOTH the fixed walk and the pre-R5 double-count walk — the exact user symptom (tip Dx ≠ card Dx) becomes a number.
// Skips SILENTLY when the env var is unset/absent so the suite stays green in a plain checkout. Env-gated, no assert.
internal static class TipFloaterReplayProbe
{
    private const double F = 2255.0 / 1920.0; // ~1.1745 — the user's widened phone aspect

    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_TIPPROBE_NDJSON");
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
            // `{"t":ms,"data":"<escaped message>"}` wrapper (record-mirror-stream.mjs) → extract the inner message.
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
                continue; // session / pong / non scene-delta frame
            }

            SceneTreeApplier.ApplySceneDelta(state, delta);
            applied++;
        }

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);

        var fixedIdx = new SpreadIndex();
        fixedIdx.Update(state, transforms, F);

        Console.Error.WriteLine($"[tipprobe] applied {applied} deltas; {state.Nodes.Count} nodes; F={F:0.####}");
        int tips = 0;
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node) || Leaf(node.NodeType) != "NHoverTipSet")
            {
                continue;
            }

            tips++;
            string? ownerId = node.AnchorOwnerId;
            double tipFixed = fixedIdx.TryGet(id, out var tf) ? tf.Dx : 0;

            string visualId = ownerId is not null
                ? TipOwnerResolve.ResolveVisualOwnerId(state, transforms, fixedIdx, ownerId)
                : "-";
            double ownerDx = ownerId is not null && fixedIdx.TryGet(ownerId, out var od) ? od.Dx : 0;
            double visualDx = visualId != "-" && fixedIdx.TryGet(visualId, out var vd) ? vd.Dx : 0;
            string ownerLeaf = ownerId is not null && state.Nodes.TryGetValue(ownerId, out var on) ? Leaf(on.NodeType) : "-";
            string visualLeaf = visualId != "-" && state.Nodes.TryGetValue(visualId, out var vn) ? Leaf(vn.NodeType) : "-";

            Console.Error.WriteLine(
                $"[tipprobe] tip={id} owner={ownerId}({ownerLeaf}) ownerDx={ownerDx:0.#} " +
                $"visualOwner={visualId}({visualLeaf}) visualDx={visualDx:0.#} " +
                $"tipDx={tipFixed:0.#}");
        }

        Console.Error.WriteLine($"[tipprobe] {tips} NHoverTipSet node(s) inspected");
    }

    private static string Leaf(string t)
    {
        int dot = t.LastIndexOf('.');
        return dot >= 0 ? t[(dot + 1)..] : t;
    }
}
